import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureCrossFileDuplication, type CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import type { CrossFileDuplicationFileData } from './duplication.js';
import { collectCrossFileDuplicationFileData, measureCode } from './metrics.js';
import { NativeAddonError } from './nativeMetrics.js';
import type { CodeMetrics, DuplicationOptions, LanguageName } from './types.js';

/** The scan settings shared by every command (a structural subset of each command's options). */
export interface ScanOptions {
  duplication: Required<DuplicationOptions>;
  includeTests: boolean;
}

export interface FileMetrics {
  file: string;
  metrics: CodeMetrics;
  /** Cross-file duplicate candidates and token/statement data, collected only for directory scans. */
  duplicationCandidates?: CrossFileDuplicationFileData;
}

export interface ScanResult {
  crossFileDuplication?: CrossFileDuplicationMetrics;
  displayRoot: string;
  errors: string[];
  /** Non-fatal degradations (e.g. cross-file candidates unavailable); the file is still measured. */
  warnings: string[];
  fatalError?: string;
  files: FileMetrics[];
}

const languageByExtension = new Map<string, LanguageName>([
  ['.c', 'c'],
  ['.c++', 'cpp'],
  ['.cc', 'cpp'],
  ['.cjs', 'javascript'],
  ['.cp', 'cpp'],
  ['.cpp', 'cpp'],
  ['.cs', 'csharp'],
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
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
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
  // .NET SDK intermediate output (generated sources such as `*.GlobalUsings.g.cs`).
  'obj',
  'target',
  'test-fixtures',
  'vendor',
  'venv',
]);

const testDirectoryNames = new Set(['__tests__', 'test', 'tests', 'spec']);
const testFilePattern = /(?:^test(?:[_-].*)?|\.(?:spec|test)|[_-](?:test|spec))\.[^.]+$/iu;
// JUnit (Java/Kotlin) and xUnit/NUnit (C#) tests use case-sensitive `Test`/`Tests` class-name
// suffixes; case-insensitive matching would catch production files like `contest.java`.
const suffixTestFilePattern = /(?:Test\.(?:java|kt)|Tests?\.cs)$/u;

export function resolveTarget(target: string): string {
  if (target === '~') {
    return os.homedir();
  }

  if (target.startsWith('~/')) {
    return path.join(os.homedir(), target.slice(2));
  }

  return path.resolve(target);
}

/** Returns the directory from which the config file search should start (the target itself if it is a directory). */
export async function configSearchDirectory(target: string): Promise<string> {
  try {
    const targetStat = await stat(target);
    return targetStat.isDirectory() ? target : path.dirname(target);
  } catch {
    return path.dirname(target);
  }
}

/** Shared state of one scan, threaded through the directory walk instead of positional plumbing. */
interface ScanContext {
  options: ScanOptions;
  files: FileMetrics[];
  errors: string[];
  warnings: string[];
  visitedDirectories: Set<string>;
  visitedFiles: Set<string>;
  /** Scan root: paths are displayed relative to it, and symbolic links may not escape it. */
  rootDirectory: string;
}

export async function scanTarget(target: string, options: ScanOptions): Promise<ScanResult> {
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
    try {
      await measureFile(canonicalTarget, language, 'single-file', context, canonicalTarget);
    } catch (error) {
      return toFatalResult(error, displayRoot, files, errors, warnings);
    }
    return { displayRoot, files, errors, warnings };
  }

  try {
    await scanDirectory(canonicalTarget, makeScanContext(options, files, errors, warnings, canonicalTarget));
  } catch (error) {
    return toFatalResult(error, canonicalTarget, files, errors, warnings);
  }
  return { displayRoot: canonicalTarget, files, errors, warnings };
}

/**
 * Measures an explicit list of repository-relative files (the diff gate's git-visible allowlist)
 * instead of walking the directory tree, so ignored artifact directories are never parsed. Paths
 * outside the scan scope (ignored/test directories, unsupported or test file names) are skipped
 * with the same rules as the walk.
 */
export async function scanListedFiles(
  rootDirectory: string,
  relativePaths: Iterable<string>,
  options: ScanOptions
): Promise<ScanResult> {
  const files: FileMetrics[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const context = makeScanContext(options, files, errors, warnings, rootDirectory);
  for (const relativePath of relativePaths) {
    const language = isScannedPath(relativePath, options) ? getLanguage(relativePath, options) : undefined;
    if (!language) {
      continue;
    }
    const absolutePath = path.join(rootDirectory, relativePath);
    // Symbolic links are not source files: git stores only their target string, so measuring
    // through them would diverge from what any revision of the repository actually contains.
    const stats = await lstat(absolutePath).catch(() => {});
    if (stats?.isSymbolicLink()) {
      continue;
    }
    try {
      await measureFile(absolutePath, language, 'directory', context);
    } catch (error) {
      return toFatalResult(error, rootDirectory, files, errors, warnings);
    }
  }
  return { displayRoot: rootDirectory, files, errors, warnings };
}

/** A run-wide failure (a missing native addon) as a fatal result; anything else keeps throwing. */
function toFatalResult(
  error: unknown,
  displayRoot: string,
  files: FileMetrics[],
  errors: string[],
  warnings: string[]
): ScanResult {
  if (!(error instanceof NativeAddonError)) {
    throw error;
  }
  const fatalError = formatError(error);
  // Errors the walk accumulated before the fatal failure stay reported alongside it.
  return { displayRoot, files, errors: [...errors, fatalError], warnings, fatalError };
}

function makeScanContext(
  options: ScanOptions,
  files: FileMetrics[],
  errors: string[],
  warnings: string[],
  rootDirectory: string
): ScanContext {
  return { options, files, errors, warnings, visitedDirectories: new Set(), visitedFiles: new Set(), rootDirectory };
}

/** Runs a filesystem operation, recording a scan error and returning undefined when it fails. */
async function tryFileSystem<T>(
  operation: () => Promise<T>,
  target: string,
  context: ScanContext
): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    context.errors.push(`${formatPath(target, context.rootDirectory)}: ${formatError(error)}`);
    return undefined;
  }
}

/** Resolves the path (recording errors); undefined when that fails or the result escapes the root. */
async function resolveWithinRoot(target: string, context: ScanContext): Promise<string | undefined> {
  const resolved = await tryFileSystem(() => realpath(target), target, context);
  return resolved !== undefined && isWithinDirectory(resolved, context.rootDirectory) ? resolved : undefined;
}

async function scanDirectory(directory: string, context: ScanContext): Promise<void> {
  const resolvedDirectory = await resolveWithinRoot(directory, context);
  if (resolvedDirectory === undefined || context.visitedDirectories.has(resolvedDirectory)) {
    return;
  }
  context.visitedDirectories.add(resolvedDirectory);

  const entries = await tryFileSystem(() => readdir(directory, { withFileTypes: true }), directory, context);
  if (entries === undefined) {
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
  const resolvedPath = await resolveWithinRoot(entryPath, context);
  if (resolvedPath === undefined) {
    return;
  }

  const entryStat = await tryFileSystem(() => stat(entryPath), entryPath, context);
  if (entryStat === undefined) {
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
    // Candidate collection is an auxiliary pass: if it fails where measureCode succeeded (an
    // addon error specific to this pass), that must not discard the measured metrics.
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
    // A missing native addon fails every file identically: propagate it once as a fatal scan
    // error instead of recording one "skipped" entry per file behind a successful exit code.
    if (error instanceof NativeAddonError) {
      throw error;
    }
    context.errors.push(`${formatPath(file, context.rootDirectory)}: ${formatError(error)}`);
  }
}

/** Runs after the scan so every measured file's candidates participate. */
export function addCrossFileDuplication(result: ScanResult, options: ScanOptions): void {
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

/**
 * Distinct 1-based code lines covered by within-file or cross-file duplicated content. Both
 * sources expose the exact lines carrying matched tokens (never block bounding ranges, which
 * would over-count comment/blank lines and the unmatched gap of a merged clone), so the union is
 * a subset of the file's code lines and a ratio derived over code lines can never exceed 1.
 */
export function collectDuplicatedLineNumbers(
  metrics: CodeMetrics | undefined,
  crossFileDuplication: CrossFileDuplicationMetrics | undefined,
  formattedFile: string
): Set<number> {
  const lines = new Set(metrics?.duplication.duplicateLineNumbers);
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

function shouldSkipDirectory(name: string, options: ScanOptions): boolean {
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

/**
 * Whether a repository-relative path would be scanned: no ignored or excluded-test directory
 * segment and a supported, non-test file name. The diff gate uses this for base-revision
 * eligibility, so code renamed into scan scope gates as new code instead of ratcheting against
 * a blob the scanner would never have measured.
 */
export function isScannedPath(relativePath: string, options: ScanOptions): boolean {
  const segments = relativePath.split('/');
  for (const segment of segments.slice(0, -1)) {
    if (ignoredDirectoryNames.has(segment) || (!options.includeTests && testDirectoryNames.has(segment))) {
      return false;
    }
  }
  return getLanguage(relativePath, options) !== undefined;
}

export function getLanguage(file: string, options: ScanOptions, explicitTarget = false): LanguageName | undefined {
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
    (testFilePattern.test(path.basename(file)) || suffixTestFilePattern.test(path.basename(file)))
  ) {
    return undefined;
  }

  // GCC treats an uppercase `.C` as C++; lowercasing first would misparse it with the C grammar.
  if (path.extname(file) === '.C') {
    return 'cpp';
  }

  return languageByExtension.get(path.extname(lowerFile));
}

export function formatPath(file: string, base: string): string {
  return path.relative(base, file) || path.basename(file);
}

export function writeStdout(message: string): void {
  process.stdout.write(message);
}

export function writeStderr(message: string): void {
  process.stderr.write(message);
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
