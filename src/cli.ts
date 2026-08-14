#!/usr/bin/env node

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { type CliOptions, configFileName, loadConfig, type ResolvedOptions, resolveOptions } from './cliConfig.js';
import { measureCrossFileDuplication, type CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import type { CrossFileDuplicationFileData } from './duplication.js';
import { collectCrossFileDuplicationFileData, measureCode } from './metrics.js';
import type { CodeMetrics, FunctionMetrics, LanguageName } from './types.js';

interface FileMetrics {
  file: string;
  metrics: CodeMetrics;
  /** Cross-file duplicate candidates and token/statement data, collected only for directory scans. */
  duplicationCandidates?: CrossFileDuplicationFileData;
}

interface ScanResult {
  crossFileDuplication?: CrossFileDuplicationMetrics;
  displayRoot: string;
  errors: string[];
  /** Non-fatal degradations (e.g. cross-file candidates unavailable); the file is still measured. */
  warnings: string[];
  fatalError?: string;
  files: FileMetrics[];
}

/** The worst (highest-cognitive-complexity) function of a file, reported as the ranking evidence. */
interface WorstFunction {
  name: string;
  startLine: number;
  endLine: number;
  cognitiveComplexity: number;
  ncss: number;
  nestingDepth: number;
}

/**
 * One ranked refactoring candidate. The score is the sum of the file's repo-relative percentile
 * ranks (each in [0, 1)) over three dimensions: worst-function cognitive complexity, duplicated
 * lines (within-file and cross-file combined), and file NCSS. Ranking is relative to the scanned
 * project, so no absolute threshold is involved.
 */
interface RankedFile {
  file: string;
  score: number;
  worstFunction?: WorstFunction;
  /** Distinct lines covered by within-file duplicate blocks or cross-file duplicate occurrences. */
  duplicatedLineCount: number;
  /** duplicatedLineCount / code lines (0 when the file has no code). */
  duplicatedLineRatio: number;
  /** Other files sharing cross-file duplicate blocks with this file (capped for display). */
  crossFilePartners: string[];
  ncss: number;
  codeLines: number;
}

const languageByExtension = new Map<string, LanguageName>([
  ['.c', 'c'],
  ['.c++', 'cpp'],
  ['.cc', 'cpp'],
  ['.cjs', 'javascript'],
  ['.cp', 'cpp'],
  ['.cpp', 'cpp'],
  ['.tcc', 'cpp'],
  ['.cts', 'typescript'],
  ['.cxx', 'cpp'],
  ['.go', 'go'],
  // Headers may be C or C++; the C++ grammar parses both.
  ['.h', 'cpp'],
  ['.hh', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hxx', 'cpp'],
  ['.java', 'java'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.mjs', 'javascript'],
  ['.mts', 'typescript'],
  ['.py', 'python'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
]);

const ignoredDirectoryNames = new Set([
  '.agents',
  '.claude',
  '.cursor',
  '.git',
  '.next',
  '.playwright-cli',
  '.tox',
  '.tmp',
  '.turbo',
  '.venv',
  '.yarn',
  '__fixtures__',
  '__generated__',
  '__pycache__',
  'coverage',
  'dist',
  'fixtures',
  'generated',
  'node_modules',
  'target',
  'test-fixtures',
  'vendor',
  'venv',
]);

/** Caps how many cross-file partners a ranked file lists so the report stays scannable. */
const maxCrossFilePartners = 3;

const testDirectoryNames = new Set(['__tests__', 'test', 'tests', 'spec']);
const testFilePattern = /(?:^test(?:[_-].*)?|\.(?:spec|test)|[_-](?:test|spec))\.[^.]+$/iu;
// JUnit tests use a case-sensitive `Test.java` suffix; case-insensitive matching would catch
// production files like `contest.java`.
const javaTestFilePattern = /Test\.java$/u;

// oxlint-disable-next-line unicorn/prefer-top-level-await -- CommonJS build output cannot preserve top-level await.
void main().catch((error: unknown) => {
  writeStderr(`Error: ${formatError(error)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const program = new Command()
    .name('code-gauge')
    .description('Rank the files of a project by refactoring priority.')
    .argument('[target]', 'file or directory to measure', '.')
    .option('--config <path>', `config file to use instead of the auto-detected ${configFileName}`)
    .option('--top <number>', 'number of top-ranked files to report (default: 10)', parsePositiveInteger)
    .option(
      '--duplication-min-tokens <number>',
      'minimum normalized token count for a duplicate region (default 40)',
      parsePositiveInteger
    )
    .option(
      '--duplication-max-gap-tokens <number>',
      'maximum token gap merged into one gapped clone group; 0 disables merging (default 30)',
      parseNonNegativeInteger
    )
    .option(
      '--duplication-min-similarity-percent <number>',
      'minimum similarity percent (1-100) for near-miss (Type-3) clone blocks; 100 reports exact matches only (default 70)',
      parsePercentInteger
    )
    .option('--include-tests', 'include test files and test directories')
    .option('--json', 'print JSON output')
    .option('--fail-on-error', 'exit with code 1 when files or directories cannot be scanned');

  program.action(async (target: string, cliOptions: CliOptions) => {
    const resolvedTarget = resolveTarget(target);
    const config = await loadConfig(cliOptions.config, await configSearchDirectory(resolvedTarget));
    const options = resolveOptions(cliOptions, config);
    const result = await scanTarget(resolvedTarget, options);
    addCrossFileDuplication(result, options);
    const rankedFiles = rankFiles(result);

    if (options.json) {
      printJson(result, rankedFiles, options);
    } else {
      printTextReport(resolvedTarget, result, rankedFiles, options);
    }

    if (result.fatalError || (options.failOnError && result.errors.length > 0)) {
      process.exitCode = 1;
    }
  });

  await program.parseAsync();
}

function resolveTarget(target: string): string {
  if (target === '~') {
    return os.homedir();
  }

  if (target.startsWith('~/')) {
    return path.join(os.homedir(), target.slice(2));
  }

  return path.resolve(target);
}

/** Returns the directory from which the config file search should start (the target itself if it is a directory). */
async function configSearchDirectory(target: string): Promise<string> {
  try {
    const targetStat = await stat(target);
    return targetStat.isDirectory() ? target : path.dirname(target);
  } catch {
    return path.dirname(target);
  }
}

/** Shared state of one scan, threaded through the directory walk instead of positional plumbing. */
interface ScanContext {
  options: ResolvedOptions;
  files: FileMetrics[];
  errors: string[];
  warnings: string[];
  visitedDirectories: Set<string>;
  visitedFiles: Set<string>;
  /** Scan root: paths are displayed relative to it, and symbolic links may not escape it. */
  rootDirectory: string;
}

async function scanTarget(target: string, options: ResolvedOptions): Promise<ScanResult> {
  const files: FileMetrics[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let canonicalTarget = target;
  try {
    canonicalTarget = await realpath(target);
  } catch {
    // stat below reports missing targets with the original path.
  }

  const fallbackDisplayRoot = path.dirname(canonicalTarget);
  let targetStat;

  try {
    targetStat = await stat(canonicalTarget);
  } catch (error) {
    const fatalError = `${formatPath(canonicalTarget, fallbackDisplayRoot)}: ${formatError(error)}`;
    return { displayRoot: fallbackDisplayRoot, files, errors: [fatalError], warnings, fatalError };
  }

  if (targetStat.isFile()) {
    const displayRoot = path.dirname(canonicalTarget);
    const language = getLanguage(canonicalTarget, options, true);
    if (!language) {
      const fatalError = `${formatPath(canonicalTarget, displayRoot)}: unsupported file type`;
      return { displayRoot, files, errors: [fatalError], warnings, fatalError };
    }

    const context = makeScanContext(options, files, errors, warnings, displayRoot);
    await measureFile(canonicalTarget, language, 'single-file', context, canonicalTarget);
    return { displayRoot, files, errors, warnings };
  }

  await scanDirectory(canonicalTarget, makeScanContext(options, files, errors, warnings, canonicalTarget));
  return { displayRoot: canonicalTarget, files, errors, warnings };
}

function makeScanContext(
  options: ResolvedOptions,
  files: FileMetrics[],
  errors: string[],
  warnings: string[],
  rootDirectory: string
): ScanContext {
  return { options, files, errors, warnings, visitedDirectories: new Set(), visitedFiles: new Set(), rootDirectory };
}

async function scanDirectory(directory: string, context: ScanContext): Promise<void> {
  let resolvedDirectory;
  try {
    resolvedDirectory = await realpath(directory);
  } catch (error) {
    context.errors.push(`${formatPath(directory, context.rootDirectory)}: ${formatError(error)}`);
    return;
  }

  if (!isWithinDirectory(resolvedDirectory, context.rootDirectory)) {
    return;
  }

  if (context.visitedDirectories.has(resolvedDirectory)) {
    return;
  }
  context.visitedDirectories.add(resolvedDirectory);

  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    context.errors.push(`${formatPath(directory, context.rootDirectory)}: ${formatError(error)}`);
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      await scanSymbolicLink(entry.name, entryPath, context);
      continue;
    }

    if (entry.isDirectory()) {
      if (shouldSkipDirectory(entry.name, context.options)) {
        continue;
      }
      await scanDirectory(entryPath, context);
      continue;
    }

    if (entry.isFile()) {
      await measureScannableFile(entryPath, context);
    }
  }
}

async function scanSymbolicLink(name: string, entryPath: string, context: ScanContext): Promise<void> {
  let resolvedPath;
  try {
    resolvedPath = await realpath(entryPath);
  } catch (error) {
    context.errors.push(`${formatPath(entryPath, context.rootDirectory)}: ${formatError(error)}`);
    return;
  }

  if (!isWithinDirectory(resolvedPath, context.rootDirectory)) {
    return;
  }

  let entryStat;
  try {
    entryStat = await stat(entryPath);
  } catch (error) {
    context.errors.push(`${formatPath(entryPath, context.rootDirectory)}: ${formatError(error)}`);
    return;
  }

  if (entryStat.isDirectory()) {
    if (
      shouldSkipDirectory(name, context.options) ||
      shouldSkipDirectory(path.basename(resolvedPath), context.options)
    ) {
      return;
    }
    await scanDirectory(entryPath, context);
    return;
  }

  if (entryStat.isFile()) {
    await measureScannableFile(entryPath, context, resolvedPath, resolvedPath);
  }
}

async function measureScannableFile(
  file: string,
  context: ScanContext,
  languageFile = file,
  realFile?: string
): Promise<void> {
  const language = getLanguage(languageFile, context.options);
  if (language) {
    await measureFile(file, language, 'directory', context, realFile);
  }
}

async function measureFile(
  file: string,
  language: LanguageName,
  mode: 'single-file' | 'directory',
  context: ScanContext,
  realFile?: string
): Promise<void> {
  try {
    const resolvedFile = realFile ?? (await realpath(file));
    if (context.visitedFiles.has(resolvedFile)) {
      return;
    }
    context.visitedFiles.add(resolvedFile);

    const code = await readFile(file, 'utf8');
    const measureOptions = { language, duplication: context.options.duplication };
    const fileMetrics: FileMetrics = { file, metrics: measureCode(code, measureOptions) };
    // Only directory scans compare files against each other; a single-file target has no peers.
    // Candidate collection failing (it always parses with the JavaScript binding, which can give
    // up where the native backend measured fine) must not discard the measured metrics.
    if (mode === 'directory') {
      try {
        fileMetrics.duplicationCandidates = collectCrossFileDuplicationFileData(code, measureOptions);
      } catch (error) {
        // A warning, not an error: the file's metrics are complete, only its participation in
        // cross-file matching is lost, so it is not "skipped" and must not fail --fail-on-error.
        context.warnings.push(
          `${formatPath(file, context.rootDirectory)}: cross-file duplication candidates unavailable: ${formatError(error)}`
        );
      }
    }
    context.files.push(fileMetrics);
  } catch (error) {
    context.errors.push(`${formatPath(file, context.rootDirectory)}: ${formatError(error)}`);
  }
}

/** Runs after the scan so every measured file's candidates participate. */
function addCrossFileDuplication(result: ScanResult, options: ResolvedOptions): void {
  if (result.fatalError || result.files.length < 2) {
    return;
  }
  const sourceFiles = result.files.flatMap(({ file, duplicationCandidates }) =>
    duplicationCandidates ? [{ file: formatPath(file, result.displayRoot), ...duplicationCandidates }] : []
  );
  if (sourceFiles.length < 2) {
    return;
  }
  result.crossFileDuplication = measureCrossFileDuplication(sourceFiles, options.duplication);
}

function rankFiles(result: ScanResult): RankedFile[] {
  const candidates = result.files.map(({ file, metrics }) => {
    const formattedFile = formatPath(file, result.displayRoot);
    const duplicatedLines = collectDuplicatedLines(metrics, result.crossFileDuplication, formattedFile);
    return {
      file: formattedFile,
      worstFunction: findWorstFunction(metrics.functions),
      duplicatedLineCount: duplicatedLines.size,
      duplicatedLineRatio: metrics.lines.code === 0 ? 0 : duplicatedLines.size / metrics.lines.code,
      crossFilePartners: findCrossFilePartners(result.crossFileDuplication, formattedFile),
      ncss: metrics.ncssCount,
      codeLines: metrics.lines.code,
    };
  });

  const cognitivePercentile = makePercentile(candidates.map((c) => c.worstFunction?.cognitiveComplexity ?? 0));
  const duplicationPercentile = makePercentile(candidates.map((c) => c.duplicatedLineCount));
  const ncssPercentile = makePercentile(candidates.map((c) => c.ncss));

  return candidates
    .map((candidate) => ({
      ...candidate,
      score:
        cognitivePercentile(candidate.worstFunction?.cognitiveComplexity ?? 0) +
        duplicationPercentile(candidate.duplicatedLineCount) +
        ncssPercentile(candidate.ncss),
    }))
    .toSorted(
      (left, right) => right.score - left.score || right.ncss - left.ncss || left.file.localeCompare(right.file)
    );
}

/**
 * Percentile rank within the scanned project: the fraction of files with a strictly smaller
 * value, in [0, 1). Relative ranking needs no absolute threshold, which sidesteps the metric
 * calibration problem entirely — the top of the list is worth refactoring first regardless of
 * where any cutoff would sit.
 */
function makePercentile(values: number[]): (value: number) => number {
  const sorted = values.toSorted((left, right) => left - right);
  return (value: number) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((sorted[middle] as number) < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return sorted.length === 0 ? 0 : low / sorted.length;
  };
}

/** The highest-cognitive-complexity function; NCSS breaks ties so the larger body is reported. */
function findWorstFunction(functions: FunctionMetrics[]): WorstFunction | undefined {
  let worst: FunctionMetrics | undefined;
  for (const fn of functions) {
    if (
      !worst ||
      fn.cognitiveComplexity > worst.cognitiveComplexity ||
      (fn.cognitiveComplexity === worst.cognitiveComplexity && fn.ncss > worst.ncss)
    ) {
      worst = fn;
    }
  }
  if (!worst) {
    return undefined;
  }
  return {
    name: worst.name ?? '<anonymous>',
    startLine: worst.startLine,
    endLine: worst.endLine,
    cognitiveComplexity: worst.cognitiveComplexity,
    ncss: worst.ncss,
    nestingDepth: worst.nestingDepth,
  };
}

/**
 * Distinct 1-based code lines covered by within-file or cross-file duplicated content. Both
 * sources expose the exact lines carrying matched tokens (never block bounding ranges, which
 * would over-count comment/blank lines and the unmatched gap of a merged clone), so the union is
 * a subset of the file's code lines and the derived ratio can never exceed 1.
 */
function collectDuplicatedLines(
  metrics: CodeMetrics,
  crossFileDuplication: CrossFileDuplicationMetrics | undefined,
  formattedFile: string
): Set<number> {
  const lines = new Set(metrics.duplication.duplicateLineNumbers);
  // Object.hasOwn: a file named like an Object.prototype member must not read an inherited value.
  const crossFileLines =
    crossFileDuplication && Object.hasOwn(crossFileDuplication.duplicateLineNumbersByFile, formattedFile)
      ? (crossFileDuplication.duplicateLineNumbersByFile[formattedFile] ?? [])
      : [];
  for (const line of crossFileLines) {
    lines.add(line);
  }
  return lines;
}

function findCrossFilePartners(
  crossFileDuplication: CrossFileDuplicationMetrics | undefined,
  formattedFile: string
): string[] {
  const partners = new Set<string>();
  for (const group of crossFileDuplication?.groups ?? []) {
    if (!group.files.includes(formattedFile)) {
      continue;
    }
    for (const file of group.files) {
      if (file !== formattedFile) {
        partners.add(file);
      }
    }
  }
  return [...partners].toSorted();
}

function printJson(result: ScanResult, rankedFiles: RankedFile[], options: ResolvedOptions): void {
  const reportedFiles = rankedFiles.slice(0, options.top);
  writeStdout(
    JSON.stringify(
      {
        summary: summarize(result.files),
        totalRankedFiles: rankedFiles.length,
        truncated: reportedFiles.length < rankedFiles.length,
        files: reportedFiles,
        errors: result.errors,
        warnings: result.warnings,
      },
      undefined,
      2
    ) + '\n'
  );
}

function printTextReport(
  target: string,
  result: ScanResult,
  rankedFiles: RankedFile[],
  options: ResolvedOptions
): void {
  if (result.fatalError) {
    writeStderr(`Error: ${result.fatalError}\n`);
    return;
  }

  const summary = summarize(result.files);
  writeStdout(
    `Measured ${summary.fileCount} files under ${target} (code LOC ${summary.linesOfCode}, NCSS ${summary.ncssCount}, functions ${summary.functionCount})\n`
  );

  if (rankedFiles.length === 0) {
    writeStdout('No measurable files found.\n');
  } else {
    const reportedFiles = rankedFiles.slice(0, options.top);
    const totalSuffix = rankedFiles.length > reportedFiles.length ? ` of ${rankedFiles.length}` : '';
    writeStdout(`\nRefactoring candidates (top ${reportedFiles.length}${totalSuffix}):\n`);
    for (const [index, ranked] of reportedFiles.entries()) {
      writeStdout(`${index + 1}. ${formatRankedFile(ranked)}\n`);
    }
  }

  if (result.warnings.length > 0) {
    writeStderr(`\nDegraded ${result.warnings.length} files (measured, but excluded from cross-file matching):\n`);
    for (const warning of result.warnings.slice(0, 10)) {
      writeStderr(`- ${warning}\n`);
    }
    if (result.warnings.length > 10) {
      writeStderr(`- ... ${result.warnings.length - 10} more\n`);
    }
  }

  if (result.errors.length > 0) {
    writeStderr(`\nSkipped ${result.errors.length} files or directories:\n`);
    for (const error of result.errors.slice(0, 10)) {
      writeStderr(`- ${error}\n`);
    }
    if (result.errors.length > 10) {
      writeStderr(`- ... ${result.errors.length - 10} more\n`);
    }
  }
}

/** One ranked file as a single line: the location, the evidence, and where the duplication points. */
function formatRankedFile(ranked: RankedFile): string {
  const reasons: string[] = [];
  if (ranked.worstFunction) {
    const fn = ranked.worstFunction;
    reasons.push(
      `worst function ${fn.name} (L${fn.startLine}-${fn.endLine}) cognitive ${fn.cognitiveComplexity}, NCSS ${fn.ncss}, nesting ${fn.nestingDepth}`
    );
  }
  if (ranked.duplicatedLineCount > 0) {
    const partnersSuffix =
      ranked.crossFilePartners.length > 0
        ? `, shared with ${ranked.crossFilePartners.slice(0, maxCrossFilePartners).join(', ')}${ranked.crossFilePartners.length > maxCrossFilePartners ? ', ...' : ''}`
        : '';
    reasons.push(
      `duplicated lines ${ranked.duplicatedLineCount} (${Math.round(ranked.duplicatedLineRatio * 100)}%${partnersSuffix})`
    );
  }
  reasons.push(`file NCSS ${ranked.ncss}`);
  return `${ranked.file} (score ${ranked.score.toFixed(2)}): ${reasons.join('; ')}`;
}

function summarize(files: FileMetrics[]): {
  fileCount: number;
  functionCount: number;
  linesOfCode: number;
  maxCognitiveComplexity: number;
  ncssCount: number;
} {
  let functionCount = 0;
  let linesOfCode = 0;
  let maxCognitiveComplexity = 0;
  let ncssCount = 0;

  for (const file of files) {
    functionCount += file.metrics.functions.length;
    linesOfCode += file.metrics.lines.code;
    maxCognitiveComplexity = Math.max(maxCognitiveComplexity, file.metrics.maxCognitiveComplexity);
    ncssCount += file.metrics.ncssCount;
  }

  return { fileCount: files.length, functionCount, linesOfCode, maxCognitiveComplexity, ncssCount };
}

function shouldSkipDirectory(name: string, options: ResolvedOptions): boolean {
  if (ignoredDirectoryNames.has(name)) {
    return true;
  }

  if (options.includeTests) {
    return false;
  }

  return testDirectoryNames.has(name);
}

function isWithinDirectory(candidate: string, directory: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function getLanguage(file: string, options: ResolvedOptions, explicitTarget = false): LanguageName | undefined {
  const lowerFile = file.toLowerCase();
  if (
    !explicitTarget &&
    (lowerFile.endsWith('.d.ts') ||
      lowerFile.endsWith('.d.mts') ||
      lowerFile.endsWith('.d.cts') ||
      lowerFile.endsWith('.min.js') ||
      lowerFile.endsWith('.pnp.cjs'))
  ) {
    return undefined;
  }

  if (
    !explicitTarget &&
    !options.includeTests &&
    (testFilePattern.test(path.basename(file)) || javaTestFilePattern.test(path.basename(file)))
  ) {
    return undefined;
  }

  // GCC treats an uppercase `.C` as C++; lowercasing first would misparse it with the C grammar.
  if (path.extname(file) === '.C') {
    return 'cpp';
  }

  return languageByExtension.get(path.extname(lowerFile));
}

function parsePercentInteger(value: string): number {
  const parsed = parsePositiveInteger(value);
  if (parsed > 100) {
    throw new InvalidArgumentError('Expected an integer between 1 and 100.');
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError('Expected a non-negative integer.');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Expected a non-negative integer.');
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}

function formatPath(file: string, base: string): string {
  return path.relative(base, file) || path.basename(file);
}

function writeStdout(message: string): void {
  process.stdout.write(message);
}

function writeStderr(message: string): void {
  process.stderr.write(message);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
