#!/usr/bin/env node

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { measureArchitecture, type ArchitectureFileMetrics, type ArchitectureMetrics } from './architectureMetrics.js';
import {
  type CliOptions,
  configFileName,
  loadConfig,
  type ResolvedOptions,
  resolveOptions,
  resolveThresholds,
  type Thresholds,
} from './cliConfig.js';
import { measureCrossFileDuplication, type CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import type { CrossFileDuplicationFileData } from './duplication.js';
import { collectDuplicationCandidates, measureCode } from './metrics.js';
import { measureTypeScriptProject, type TypeScriptProjectMetrics } from './typescriptProject.js';
import type { CodeMetrics, FunctionMetrics, LanguageName } from './types.js';

interface FileMetrics {
  file: string;
  metrics: CodeMetrics;
  /** Cross-file duplicate candidates and token/statement data, collected only for directory scans. */
  duplicationCandidates?: CrossFileDuplicationFileData;
}

interface RiskTrigger {
  /** Optional location hint (e.g. duplicated block line ranges) appended to the printed trigger. */
  detail?: string;
  metric: string;
  score: number;
  threshold: number;
  value: number;
}

interface RiskFinding {
  cognitiveComplexity: number;
  cyclomaticComplexity: number;
  endLine?: number;
  file: string;
  kind: 'component' | 'file' | 'function';
  language: LanguageName;
  name?: string;
  score: number;
  startLine?: number;
  triggers: RiskTrigger[];
}

interface ScanResult {
  architecture?: ArchitectureMetrics;
  componentFunctionKeys?: Set<string>;
  crossFileDuplication?: CrossFileDuplicationMetrics;
  displayRoot: string;
  errors: string[];
  /** Non-fatal degradations (e.g. cross-file candidates unavailable); the file is still measured. */
  warnings: string[];
  fatalError?: string;
  files: FileMetrics[];
  namedComponentFunctionKeys?: Set<string>;
  typeScriptProject?: TypeScriptProjectMetrics;
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

/** Caps the `Duplicate symbols` section so large repositories do not flood the report. */
const maxDuplicateSymbolGroupLines = 10;
/** Caps the `Cross-file duplicate blocks` section so large repositories do not flood the report. */
const maxCrossFileDuplicateGroupLines = 10;
/** Caps how many cross-file group locations a single risk finding repeats as detail. */
const maxCrossFileDuplicateDetailGroups = 3;

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
    .description('Measure code metrics and list high-risk findings.')
    .argument('[target]', 'file or directory to measure', '.')
    .option('--config <path>', `config file to use instead of the auto-detected ${configFileName}`)
    .option('--file-loc-threshold <number>', 'minimum file code LOC to report', parsePositiveInteger)
    .option('--function-loc-threshold <number>', 'minimum function physical LOC span to report', parsePositiveInteger)
    .option(
      '--component-loc-threshold <number>',
      'minimum React component physical LOC span to report',
      parsePositiveInteger
    )
    .option('--cognitive-threshold <number>', 'minimum cognitive complexity to report', parsePositiveInteger)
    .option('--cyclomatic-threshold <number>', 'minimum cyclomatic complexity to report', parsePositiveInteger)
    .option('--call-threshold <number>', 'minimum function call count to report', parsePositiveInteger)
    .option('--import-threshold <number>', 'minimum unique import sources per file to report', parsePositiveInteger)
    .option('--fan-out-threshold <number>', 'minimum intra-file fan-out per function to report', parsePositiveInteger)
    .option('--parameter-threshold <number>', 'minimum function parameter count to report', parsePositiveInteger)
    .option(
      '--duplicate-block-threshold <number>',
      'minimum count of duplicated code blocks per file to report',
      parsePositiveInteger
    )
    .option(
      '--duplication-ratio-percent-threshold <number>',
      'minimum percentage (1-100) of duplicated lines per file to report',
      parsePercentInteger
    )
    .option(
      '--cross-file-duplicate-block-threshold <number>',
      'minimum count of cross-file duplicate block groups per file to report',
      parsePositiveInteger
    )
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
    .option(
      '--transitive-dependency-threshold <number>',
      'minimum transitively reachable local files to report',
      parsePositiveInteger
    )
    .option(
      '--structural-breadth-threshold <number>',
      'minimum structural breadth score to report',
      parsePositiveInteger
    )
    .option(
      '--structural-coordination-threshold <number>',
      'minimum structural coordination score to report',
      parsePositiveInteger
    )
    .option('--state-mutation-threshold <number>', 'minimum state mutation score to report', parsePositiveInteger)
    .option(
      '--duplicate-symbol-group-threshold <number>',
      'minimum duplicate symbol group count to report',
      parsePositiveInteger
    )
    .option('--max-findings <number>', 'maximum number of risk findings to print', parsePositiveInteger)
    .option('--largest-files <number>', 'number of largest files by code LOC to list', parsePositiveInteger)
    .option('--include-tests', 'include test files and test directories')
    .option('--tsconfig <path>', 'TypeScript project file to use instead of auto-detected tsconfig.json')
    .option('--json', 'print JSON output')
    .option('--fail-on-error', 'exit with code 1 when files or directories cannot be scanned')
    .option('--fail-on-risk', 'exit with code 1 when high-risk findings are found');

  program.action(async (target: string, cliOptions: CliOptions) => {
    const resolvedTarget = resolveTarget(target);
    const config = await loadConfig(cliOptions.config, await configSearchDirectory(resolvedTarget));
    const options = resolveOptions(cliOptions, config);
    const result = await scanTarget(resolvedTarget, options);
    addCrossFileDuplication(result, options);
    await addArchitectureMetrics(result);
    await addTypeScriptProjectMetrics(result, options, resolvedTarget);
    const risks = findRiskyFunctions(
      result.files,
      result.architecture,
      result.crossFileDuplication,
      result.componentFunctionKeys,
      result.namedComponentFunctionKeys,
      options,
      result.displayRoot
    );

    if (options.json) {
      printJson(result, risks, options);
    } else {
      printTextReport(resolvedTarget, result, risks, options);
    }

    if (
      result.fatalError ||
      (options.failOnError && result.errors.length > 0) ||
      (options.failOnRisk && risks.length > 0)
    ) {
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

async function addTypeScriptProjectMetrics(
  result: ScanResult,
  options: ResolvedOptions,
  resolvedTarget: string
): Promise<void> {
  if (result.fatalError) {
    return;
  }
  if (result.files.length === 0) {
    return;
  }

  const explicitConfigFile = options.tsconfig;
  const isExplicitConfig = explicitConfigFile !== undefined;
  if (!isExplicitConfig && !result.files.some(({ file }) => isTypeScriptProjectCandidateFile(file))) {
    return;
  }

  const configFile = explicitConfigFile ? resolveTarget(explicitConfigFile) : await findNearestTsconfig(resolvedTarget);
  if (!configFile) {
    return;
  }

  try {
    result.typeScriptProject = await measureTypeScriptProject(
      configFile,
      result.files.map(({ file }) => file)
    );
    result.componentFunctionKeys = new Set(
      result.typeScriptProject.reactComponentFunctions.map((component) =>
        functionLocationKey(component.file, component.startLine, component.startColumn)
      )
    );
    result.namedComponentFunctionKeys = new Set(
      result.typeScriptProject.reactComponentFunctions.flatMap((component) =>
        component.name ? [functionNameLocationKey(component.file, component.name, component.startLine)] : []
      )
    );
  } catch (error) {
    if (isExplicitConfig) {
      result.errors.push(`${formatPath(configFile, result.displayRoot)}: ${formatError(error)}`);
    }
  }
}

function isTypeScriptProjectCandidateFile(file: string): boolean {
  return ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'].includes(path.extname(file));
}

async function findNearestTsconfig(target: string): Promise<string | undefined> {
  const targetStat = await stat(target);
  let currentDirectory = targetStat.isDirectory() ? target : path.dirname(target);
  while (true) {
    const configFile = path.join(currentDirectory, 'tsconfig.json');
    if (await fileExists(configFile)) {
      return configFile;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const fileStat = await stat(file);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

async function addArchitectureMetrics(result: ScanResult): Promise<void> {
  if (result.fatalError) {
    return;
  }

  try {
    result.architecture = measureArchitecture(
      result.files.map(({ file, metrics }) => ({ file, metrics })),
      result.displayRoot
    );
  } catch (error) {
    result.errors.push(`architecture metrics: ${formatError(error)}`);
  }
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
        fileMetrics.duplicationCandidates = collectDuplicationCandidates(code, measureOptions);
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

function findRiskyFunctions(
  files: FileMetrics[],
  architecture: ArchitectureMetrics | undefined,
  crossFileDuplication: CrossFileDuplicationMetrics | undefined,
  componentFunctionKeys: Set<string> | undefined,
  namedComponentFunctionKeys: Set<string> | undefined,
  options: ResolvedOptions,
  displayRoot: string
): RiskFinding[] {
  const architectureByFile = new Map(architecture?.files.map((file) => [file.file, file]));
  const findings = files.flatMap(({ file, metrics }) => {
    const isReactFile = metrics.functions.some(
      (fn) => fn.returnsJsx || isReactComponent(file, fn, componentFunctionKeys, namedComponentFunctionKeys)
    );
    const thresholds = resolveThresholds(options, metrics.language, isReactFile);
    return [
      ...findRiskyFileMetrics(
        file,
        metrics,
        architectureByFile.get(formatPath(file, displayRoot)),
        crossFileDuplication,
        thresholds,
        displayRoot
      ),
      ...metrics.functions.flatMap((fn) =>
        findRiskyFunctionMetrics(
          file,
          metrics.language,
          fn,
          thresholds,
          displayRoot,
          componentFunctionKeys,
          namedComponentFunctionKeys
        )
      ),
    ];
  });

  findings.sort(compareRiskFindings);
  return findings;
}

function findRiskyFileMetrics(
  file: string,
  metrics: CodeMetrics,
  architecture: ArchitectureFileMetrics | undefined,
  crossFileDuplication: CrossFileDuplicationMetrics | undefined,
  thresholds: Thresholds,
  displayRoot: string
): RiskFinding[] {
  const triggers: RiskTrigger[] = [];
  const formattedFile = formatPath(file, displayRoot);
  addTrigger(triggers, 'file LOC', metrics.lines.code, thresholds.fileLoc);
  addTrigger(triggers, 'import sources', metrics.coupling.importSourceCount, thresholds.import);
  const duplicateBlockDetail = formatDuplicateBlockGroups(metrics.duplication.duplicateBlockGroups);
  addTrigger(
    triggers,
    'duplicated blocks',
    metrics.duplication.duplicateBlockCount,
    thresholds.duplicateBlock,
    duplicateBlockDetail
  );
  // Maximal-region selection deliberately compresses adjacent clones into few blocks, so severity
  // must track line coverage, not the block count. Flooring compares like the unrounded ratio
  // against the integer threshold (29.5% must not trigger a >= 30 threshold). The block ranges are
  // repeated as detail because this trigger can fire alone, and a percentage without locations is
  // not actionable.
  addTrigger(
    triggers,
    'duplicated lines (%)',
    Math.floor(metrics.duplication.duplicationRatio * 100),
    thresholds.duplicationRatioPercent,
    duplicateBlockDetail
  );
  if (crossFileDuplication) {
    // Object.hasOwn: a file named like an Object.prototype member must not read an inherited value.
    addTrigger(
      triggers,
      'cross-file duplicated blocks',
      Object.hasOwn(crossFileDuplication.duplicateBlockGroupCountByFile, formattedFile)
        ? (crossFileDuplication.duplicateBlockGroupCountByFile[formattedFile] ?? 0)
        : 0,
      thresholds.crossFileDuplicateBlock,
      formatCrossFileDuplicateDetail(crossFileDuplication, formattedFile)
    );
  }
  if (architecture) {
    const hasFileScaleRisk = metrics.lines.code >= 100 || architecture.directLocalDependencyCount >= 8;
    if (hasFileScaleRisk) {
      addTrigger(
        triggers,
        'transitive local dependencies',
        architecture.transitiveLocalDependencyCount,
        thresholds.transitiveDependency
      );
    }
    if (
      triggers.length > 0 ||
      architecture.directLocalDependencyCount >= 8 ||
      architecture.structuralCoordination.score >= thresholds.structuralCoordination
    ) {
      addTrigger(triggers, 'structural breadth', architecture.structuralBreadthScore, thresholds.structuralBreadth);
    }
    addTrigger(
      triggers,
      'structural coordination',
      architecture.structuralCoordination.score,
      thresholds.structuralCoordination
    );
    addTrigger(
      triggers,
      'state mutation',
      architecture.structuralCoordination.stateMutationScore,
      thresholds.stateMutation
    );
    addTrigger(
      triggers,
      'duplicate symbol groups',
      architecture.duplicateSymbolGroupCount,
      thresholds.duplicateSymbolGroup
    );
  }
  if (triggers.length === 0) {
    return [];
  }

  return [
    {
      file: formattedFile,
      language: metrics.language,
      kind: 'file',
      cyclomaticComplexity: metrics.cyclomaticComplexity,
      cognitiveComplexity: metrics.cognitiveComplexity,
      triggers,
      score: maxTriggerScore(triggers),
    },
  ];
}

function findRiskyFunctionMetrics(
  file: string,
  language: LanguageName,
  fn: FunctionMetrics,
  thresholds: Thresholds,
  displayRoot: string,
  componentFunctionKeys?: Set<string>,
  namedComponentFunctionKeys?: Set<string>
): RiskFinding[] {
  const loc = fn.endLine - fn.startLine + 1;
  const isComponent = isReactComponent(file, fn, componentFunctionKeys, namedComponentFunctionKeys);
  const kind = isComponent ? 'component' : 'function';
  const triggers: RiskTrigger[] = [];
  addTrigger(triggers, 'cognitive complexity', fn.cognitiveComplexity, thresholds.cognitive);
  addTrigger(triggers, 'cyclomatic complexity', fn.cyclomaticComplexity, thresholds.cyclomatic);
  addTrigger(triggers, isComponent ? 'component LOC' : 'function LOC', loc, getLocThreshold(isComponent, thresholds));
  addTrigger(triggers, 'function calls', fn.callCount, thresholds.call);
  addTrigger(triggers, 'fan-out', fn.fanOut, thresholds.fanOut);
  addTrigger(triggers, 'parameters', fn.parameterCount, thresholds.parameter);
  if (triggers.length === 0) {
    return [];
  }

  return [
    {
      file: formatPath(file, displayRoot),
      language,
      kind,
      name: fn.name ?? '<anonymous>',
      startLine: fn.startLine,
      endLine: fn.endLine,
      cyclomaticComplexity: fn.cyclomaticComplexity,
      cognitiveComplexity: fn.cognitiveComplexity,
      triggers,
      score: maxTriggerScore(triggers),
    },
  ];
}

function addTrigger(triggers: RiskTrigger[], metric: string, value: number, threshold: number, detail?: string): void {
  if (value < threshold) {
    return;
  }

  triggers.push({ metric, value, threshold, score: value / threshold, detail });
}

/** Formats the cross-file groups a file participates in as `12-34 ~ b.ts:56-78; ...` (capped). */
function formatCrossFileDuplicateDetail(
  crossFileDuplication: CrossFileDuplicationMetrics,
  formattedFile: string
): string | undefined {
  const involved = crossFileDuplication.groups.filter((group) => group.files.includes(formattedFile));
  if (involved.length === 0) {
    return undefined;
  }
  const formatted = involved
    .slice(0, maxCrossFileDuplicateDetailGroups)
    .map((group) =>
      group.occurrences
        .map(({ file, startLine, endLine }) =>
          file === formattedFile ? `${startLine}-${endLine}` : `${file}:${startLine}-${endLine}`
        )
        .join(' ~ ')
    )
    .join('; ');
  const truncatedSuffix = involved.length > maxCrossFileDuplicateDetailGroups ? '; ...' : '';
  return `${formatted}${truncatedSuffix}`;
}

/** Formats duplicated block groups as `12-34 ~ 56-78; 90-99 ~ 100-109` (copies joined by ` ~ `, groups by `; `). */
function formatDuplicateBlockGroups(groups: { endLine: number; startLine: number }[][]): string | undefined {
  if (groups.length === 0) {
    return undefined;
  }

  return groups.map((group) => group.map(({ startLine, endLine }) => `${startLine}-${endLine}`).join(' ~ ')).join('; ');
}

function isReactComponent(
  file: string,
  fn: FunctionMetrics,
  componentFunctionKeys: Set<string> | undefined,
  namedComponentFunctionKeys: Set<string> | undefined
): boolean {
  return (
    componentFunctionKeys?.has(functionLocationKey(file, fn.startLine, fn.startColumn)) ||
    (fn.name ? namedComponentFunctionKeys?.has(functionNameLocationKey(file, fn.name, fn.startLine)) : false) ||
    false
  );
}

function getLocThreshold(isComponent: boolean, thresholds: Thresholds): number {
  return isComponent ? thresholds.componentLoc : thresholds.functionLoc;
}

function functionLocationKey(file: string, startLine: number, startColumn: number): string {
  return `${path.resolve(file)}:${startLine}:${startColumn}`;
}

function functionNameLocationKey(file: string, name: string, startLine: number): string {
  return `${path.resolve(file)}:${name}:${startLine}`;
}

function maxTriggerScore(triggers: RiskTrigger[]): number {
  return Math.max(...triggers.map((trigger) => trigger.score));
}

function compareRiskFindings(left: RiskFinding, right: RiskFinding): number {
  return (
    right.score - left.score ||
    left.file.localeCompare(right.file) ||
    (left.startLine ?? 0) - (right.startLine ?? 0) ||
    (left.endLine ?? 0) - (right.endLine ?? 0) ||
    left.kind.localeCompare(right.kind)
  );
}

function printJson(result: ScanResult, risks: RiskFinding[], options: ResolvedOptions): void {
  const summary = summarize(result.files);
  const reportedRisks = risks.slice(0, options.maxFindings);
  writeStdout(
    JSON.stringify(
      {
        summary,
        thresholds: options.thresholds,
        profileThresholds: options.profileThresholds,
        totalRisks: risks.length,
        truncated: reportedRisks.length < risks.length,
        largestFiles:
          options.largestFiles > 0
            ? findLargestFiles(result.files, options.largestFiles, result.displayRoot)
            : undefined,
        architecture: result.architecture,
        crossFileDuplication: result.crossFileDuplication,
        typeScriptProject: result.typeScriptProject,
        risks: reportedRisks,
        errors: result.errors,
        warnings: result.warnings,
      },
      undefined,
      2
    ) + '\n'
  );
}

function printTextReport(target: string, result: ScanResult, risks: RiskFinding[], options: ResolvedOptions): void {
  if (result.fatalError) {
    writeStderr(`Error: ${result.fatalError}\n`);
    return;
  }

  const { thresholds } = options;
  const summary = summarize(result.files);
  writeStdout(`Measured ${summary.fileCount} files under ${target}\n`);
  writeStdout(
    `LOC ${summary.linesOfCode}, NCSS ${summary.ncssCount}, functions ${summary.functionCount}, max cyclomatic ${summary.maxCyclomaticComplexity}, max cognitive ${summary.maxCognitiveComplexity}\n`
  );
  writeStdout(
    `Calls ${summary.callCount}, internal calls ${summary.internalCallCount}, max call depth ${summary.maxCallDepth}, imports ${summary.importSourceCount}, exports ${summary.exportCount}\n`
  );
  writeStdout(
    `Type annotations ${summary.typeAnnotationCount}, type aliases ${summary.typeAliasCount}, interfaces ${summary.interfaceCount}, avg cohesion ${summary.averageFunctionIdentifierOverlap.toFixed(2)}\n`
  );
  if (result.architecture) {
    writeStdout(`${formatArchitectureMetrics(result.architecture)}\n`);
  }
  if (result.typeScriptProject) {
    writeStdout(`${formatTypeScriptProjectMetrics(result.typeScriptProject)}\n`);
  }
  writeStdout(
    `Risk thresholds: file LOC >= ${thresholds.fileLoc}, function LOC >= ${thresholds.functionLoc}, component LOC >= ${thresholds.componentLoc}, cognitive >= ${thresholds.cognitive}, cyclomatic >= ${thresholds.cyclomatic}, calls >= ${thresholds.call}, imports >= ${thresholds.import}, fan-out >= ${thresholds.fanOut}, parameters >= ${thresholds.parameter}, duplicated blocks >= ${thresholds.duplicateBlock}, duplicated lines (%) >= ${thresholds.duplicationRatioPercent}, cross-file duplicated blocks >= ${thresholds.crossFileDuplicateBlock}\n`
  );
  const profileOverrides = formatProfileOverrides(options.profileThresholds);
  if (profileOverrides) {
    writeStdout(`Per-language overrides: ${profileOverrides}\n`);
  }

  if (risks.length === 0) {
    writeStdout('No high-risk findings found.\n');
  } else {
    const reportedRisks = risks.slice(0, options.maxFindings);
    const totalSuffix = risks.length > reportedRisks.length ? ` of ${risks.length}` : '';
    writeStdout(`\nHigh-risk findings (top ${reportedRisks.length}${totalSuffix}):\n`);
    for (const risk of reportedRisks) {
      writeStdout(`${formatRiskLocation(risk)} ${formatRiskName(risk)} ${formatRiskMetrics(risk)}\n`);
    }
  }

  const crossFileGroups = result.crossFileDuplication?.groups ?? [];
  if (crossFileGroups.length > 0) {
    const reportedGroups = crossFileGroups.slice(0, maxCrossFileDuplicateGroupLines);
    const totalSuffix = crossFileGroups.length > reportedGroups.length ? ` of ${crossFileGroups.length}` : '';
    writeStdout(`\nCross-file duplicate blocks (top ${reportedGroups.length}${totalSuffix}):\n`);
    for (const group of reportedGroups) {
      writeStdout(
        `${group.tokenCount} tokens: ${group.occurrences
          .map(({ file, startLine, endLine }) => `${file}:${startLine}-${endLine}`)
          .join(', ')}\n`
      );
    }
  }

  const duplicateSymbolGroups = result.architecture?.duplicateSymbolGroups ?? [];
  if (duplicateSymbolGroups.length > 0) {
    const reportedGroups = duplicateSymbolGroups
      .toSorted((left, right) => right.files.length - left.files.length || left.name.localeCompare(right.name))
      .slice(0, maxDuplicateSymbolGroupLines);
    const totalSuffix =
      duplicateSymbolGroups.length > reportedGroups.length ? ` of ${duplicateSymbolGroups.length}` : '';
    writeStdout(`\nDuplicate symbols (top ${reportedGroups.length}${totalSuffix}):\n`);
    for (const group of reportedGroups) {
      writeStdout(
        `${group.name}: ${group.declarations.map((declaration) => `${declaration.file}:${declaration.line}`).join(', ')}\n`
      );
    }
  }

  if (options.largestFiles > 0) {
    const largestFiles = findLargestFiles(result.files, options.largestFiles, result.displayRoot);
    writeStdout(`\nLargest files by code LOC (top ${largestFiles.length}):\n`);
    for (const { file, codeLoc } of largestFiles) {
      writeStdout(`${file} (code LOC ${codeLoc})\n`);
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

function findLargestFiles(
  files: FileMetrics[],
  count: number,
  displayRoot: string
): { file: string; codeLoc: number }[] {
  return files
    .map(({ file, metrics }) => ({ file: formatPath(file, displayRoot), codeLoc: metrics.lines.code }))
    .toSorted((left, right) => right.codeLoc - left.codeLoc || left.file.localeCompare(right.file))
    .slice(0, count);
}

function formatProfileOverrides(profileThresholds: ResolvedOptions['profileThresholds']): string {
  return Object.entries(profileThresholds)
    .map(
      ([profile, overrides]) =>
        `${profile} { ${Object.entries(overrides)
          .map(([metric, value]) => `${metric} ${value}`)
          .join(', ')} }`
    )
    .join('; ');
}

function formatRiskLocation(risk: RiskFinding): string {
  return risk.startLine === undefined || risk.endLine === undefined
    ? risk.file
    : `${risk.file}:${risk.startLine}-${risk.endLine}`;
}

function formatRiskName(risk: RiskFinding): string {
  return risk.name ? `${risk.kind} ${risk.name}` : risk.kind;
}

function formatRiskMetrics(risk: RiskFinding): string {
  const triggerText = risk.triggers
    .map(
      (trigger) =>
        `${trigger.metric} ${formatMetricValue(trigger.value)} >= ${formatMetricValue(trigger.threshold)}${trigger.detail ? ` [${trigger.detail}]` : ''}`
    )
    .join(', ');
  return `(${triggerText}; cyclomatic ${risk.cyclomaticComplexity}, cognitive ${risk.cognitiveComplexity})`;
}

function formatMetricValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatArchitectureMetrics(metrics: ArchitectureMetrics): string {
  const maxStateMutationScore = Math.max(
    0,
    ...metrics.files.map((file) => file.structuralCoordination.stateMutationScore)
  );
  return `Architecture max reachable files ${metrics.maxTransitiveLocalDependencyCount}, max structural breadth ${metrics.maxStructuralBreadthScore}, max structural coordination ${metrics.maxStructuralCoordinationScore}, max state mutation ${maxStateMutationScore}, duplicate symbol groups ${metrics.duplicateSymbolGroups.length}`;
}

function formatTypeScriptProjectMetrics(metrics: TypeScriptProjectMetrics): string {
  return `TypeScript project root files ${metrics.rootFileCount}, measured roots ${metrics.measuredRootFileCount}, semantic diagnostics ${metrics.semanticDiagnosticCount}, resolved calls ${metrics.resolvedCallExpressionCount}/${metrics.callExpressionCount} (${(metrics.resolvedCallExpressionRatio * 100).toFixed(1)}%)`;
}

function summarize(files: FileMetrics[]): {
  fileCount: number;
  functionCount: number;
  linesOfCode: number;
  maxCognitiveComplexity: number;
  maxCyclomaticComplexity: number;
  ncssCount: number;
  callCount: number;
  internalCallCount: number;
  maxCallDepth: number;
  importSourceCount: number;
  relativeImportCount: number;
  externalImportCount: number;
  exportCount: number;
  averageFunctionIdentifierOverlap: number;
  typeAnnotationCount: number;
  typeAliasCount: number;
  interfaceCount: number;
  genericParameterCount: number;
} {
  let functionCount = 0;
  let linesOfCode = 0;
  let maxCyclomaticComplexity = 0;
  let maxCognitiveComplexity = 0;
  let ncssCount = 0;
  let callCount = 0;
  let internalCallCount = 0;
  let maxCallDepth = 0;
  let importSourceCount = 0;
  let relativeImportCount = 0;
  let externalImportCount = 0;
  let exportCount = 0;
  let cohesionTotal = 0;
  let typeAnnotationCount = 0;
  let typeAliasCount = 0;
  let interfaceCount = 0;
  let genericParameterCount = 0;

  for (const file of files) {
    functionCount += file.metrics.functionCount;
    linesOfCode += file.metrics.lines.code;
    maxCyclomaticComplexity = Math.max(maxCyclomaticComplexity, file.metrics.maxCyclomaticComplexity);
    maxCognitiveComplexity = Math.max(maxCognitiveComplexity, file.metrics.maxCognitiveComplexity);
    ncssCount += file.metrics.ncssCount;
    callCount += file.metrics.callGraph.callCount;
    internalCallCount += file.metrics.callGraph.internalCallCount;
    maxCallDepth = Math.max(maxCallDepth, file.metrics.callGraph.maxCallDepth);
    importSourceCount += file.metrics.coupling.importSourceCount;
    relativeImportCount += file.metrics.coupling.relativeImportCount;
    externalImportCount += file.metrics.coupling.externalImportCount;
    exportCount += file.metrics.coupling.exportCount;
    cohesionTotal += file.metrics.cohesion.averageFunctionIdentifierOverlap;
    typeAnnotationCount += file.metrics.typeComplexity.typeAnnotationCount;
    typeAliasCount += file.metrics.typeComplexity.typeAliasCount;
    interfaceCount += file.metrics.typeComplexity.interfaceCount;
    genericParameterCount += file.metrics.typeComplexity.genericParameterCount;
  }

  return {
    fileCount: files.length,
    functionCount,
    linesOfCode,
    maxCyclomaticComplexity,
    maxCognitiveComplexity,
    ncssCount,
    callCount,
    internalCallCount,
    maxCallDepth,
    importSourceCount,
    relativeImportCount,
    externalImportCount,
    exportCount,
    averageFunctionIdentifierOverlap: files.length === 0 ? 0 : cohesionTotal / files.length,
    typeAnnotationCount,
    typeAliasCount,
    interfaceCount,
    genericParameterCount,
  };
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
