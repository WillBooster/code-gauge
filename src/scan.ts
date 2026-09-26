import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { measureCrossFileDuplication, type CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import type { CrossFileDuplicationFileData } from './duplication.js';
import { detectLanguage } from './languages.js';
import { measureCode, measureCodeWithCrossFileData } from './metrics.js';
import { NativeAddonError } from './nativeMetrics.js';
import type { CodeMetrics, DuplicationOptions, LanguageName, MeasureOptions } from './types.js';

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
const suffixTestFilePattern = /Tests?\.(?:java|kt|cs)$/u;

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
  /**
   * Outcomes in walk order. Files are measured concurrently, so a measurement is recorded as a
   * promise here and applied in this order once the walk ends, keeping results deterministic.
   */
  outcomes: (ScanOutcome | Promise<ScanOutcome>)[];
  /** Measurements in flight, bounded so file contents and payloads do not pile up during the walk. */
  inFlight: Set<Promise<ScanOutcome>>;
  /** Set once a measurement fails fatally; the walk then starts no further work. */
  fatalSeen: boolean;
  visitedDirectories: Set<string>;
  visitedFiles: Set<string>;
  /** Scan root: paths are displayed relative to it, and symbolic links may not escape it. */
  rootDirectory: string;
}

/**
 * A missing native addon fails every file identically, so it ends the scan as one fatal error
 * instead of one "skipped" entry per file behind a successful exit code.
 */
type ScanOutcome = { file: FileMetrics; warning?: string } | { error: string } | { fatal: NativeAddonError };

// Twice the addon's worker count keeps its pool busy while finished payloads are parsed.
const maxMeasurementsInFlight = os.availableParallelism() * 2;

export async function scanTarget(target: string, options: ScanOptions): Promise<ScanResult> {
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
    return { displayRoot: fallbackDisplayRoot, files: [], errors: [fatalError], warnings: [], fatalError };
  }

  if (targetStat.isFile()) {
    const displayRoot = path.dirname(canonicalTarget);
    const language = getLanguage(canonicalTarget, options, true);
    if (!language) {
      const fatalError = `${formatPath(canonicalTarget, displayRoot)}: unsupported file type`;
      return { displayRoot, files: [], errors: [fatalError], warnings: [], fatalError };
    }

    const context = makeScanContext(options, displayRoot);
    await measureFile(canonicalTarget, language, 'single-file', context, canonicalTarget);
    return settleScan(context, displayRoot);
  }

  const context = makeScanContext(options, canonicalTarget);
  await scanDirectory(canonicalTarget, context);
  return settleScan(context, canonicalTarget);
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
  const context = makeScanContext(options, rootDirectory);
  for (const relativePath of relativePaths) {
    if (context.fatalSeen) {
      break;
    }
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
    await measureFile(absolutePath, language, 'directory', context);
  }
  return settleScan(context, rootDirectory);
}

/** Applies the scan's outcomes in walk order once every measurement has settled. */
async function settleScan(context: ScanContext, displayRoot: string): Promise<ScanResult> {
  const files: FileMetrics[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const pending of context.outcomes) {
    const outcome = await pending;
    if ('fatal' in outcome) {
      const fatalError = formatError(outcome.fatal);
      // Errors the walk recorded before the fatal failure stay reported alongside it.
      return { displayRoot, files, errors: [...errors, fatalError], warnings, fatalError };
    }
    if ('error' in outcome) {
      errors.push(outcome.error);
      continue;
    }
    files.push(outcome.file);
    if (outcome.warning !== undefined) {
      warnings.push(outcome.warning);
    }
  }
  return { displayRoot, files, errors, warnings };
}

function makeScanContext(options: ScanOptions, rootDirectory: string): ScanContext {
  return {
    options,
    outcomes: [],
    inFlight: new Set(),
    fatalSeen: false,
    visitedDirectories: new Set(),
    visitedFiles: new Set(),
    rootDirectory,
  };
}

function recordError(context: ScanContext, target: string, error: unknown): void {
  context.outcomes.push({ error: `${formatPath(target, context.rootDirectory)}: ${formatError(error)}` });
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
    recordError(context, target, error);
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
    if (context.fatalSeen) {
      return;
    }
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

/**
 * Resolves and deduplicates the file in walk order, then starts measuring it concurrently; its
 * outcome is recorded in walk order (see ScanContext.outcomes).
 */
async function measureFile(
  file: string,
  language: LanguageName,
  mode: 'single-file' | 'directory',
  context: ScanContext,
  realFile?: string
): Promise<void> {
  if (context.fatalSeen) {
    return;
  }
  let resolvedFile;
  try {
    resolvedFile = realFile ?? (await realpath(file));
  } catch (error) {
    recordError(context, file, error);
    return;
  }
  if (context.visitedFiles.has(resolvedFile)) {
    return;
  }
  context.visitedFiles.add(resolvedFile);

  // Any settled measurement frees its slot (removed by the callback below, which runs before the
  // race resumes), so one slow file never idles the pool.
  while (context.inFlight.size >= maxMeasurementsInFlight) {
    await Promise.race(context.inFlight);
  }
  const outcome = readAndMeasureFile(file, language, mode, context);
  context.inFlight.add(outcome);
  void outcome.then(() => context.inFlight.delete(outcome));
  context.outcomes.push(outcome);
}

async function readAndMeasureFile(
  file: string,
  language: LanguageName,
  mode: 'single-file' | 'directory',
  context: ScanContext
): Promise<ScanOutcome> {
  try {
    const code = await readFile(file, 'utf8');
    const measureOptions = { language, duplication: context.options.duplication };
    // Only directory scans compare files against each other; a single-file target has no peers.
    if (mode === 'single-file') {
      return { file: { file, metrics: measureCode(code, measureOptions) } };
    }
    const { metrics, crossFileData, crossFileError } = await measureWithCrossFileData(code, measureOptions);
    return {
      file: { file, metrics, duplicationCandidates: crossFileData },
      // A warning, not an error: the file's metrics are complete, only its participation in
      // cross-file matching is lost, so it is not "skipped" and must not fail --fail-on-error.
      warning:
        crossFileError === undefined
          ? undefined
          : `${formatPath(file, context.rootDirectory)}: cross-file duplication candidates unavailable: ${crossFileError}`,
    };
  } catch (error) {
    if (error instanceof NativeAddonError) {
      context.fatalSeen = true;
      return { fatal: error };
    }
    return { error: `${formatPath(file, context.rootDirectory)}: ${formatError(error)}` };
  }
}

/**
 * Measures a file together with its cross-file contribution from one parse. The contribution is
 * auxiliary: if collecting it fails where plain measurement succeeds (e.g. a payload too large to
 * cross the addon boundary), the metrics are still returned with the failure message, which
 * callers report as a warning rather than an error.
 */
export async function measureWithCrossFileData(
  code: string,
  measureOptions: MeasureOptions
): Promise<{ metrics: CodeMetrics; crossFileData?: CrossFileDuplicationFileData; crossFileError?: string }> {
  try {
    return await measureCodeWithCrossFileData(code, measureOptions);
  } catch (error) {
    if (error instanceof NativeAddonError) {
      throw error;
    }
    return { metrics: measureCode(code, measureOptions), crossFileError: formatError(error) };
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

  return detectLanguage(file);
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
