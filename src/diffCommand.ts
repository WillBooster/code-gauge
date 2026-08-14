import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolveGateOptions, resolveOptions, type ResolvedOptions } from './cliConfig.js';
import { measureCrossFileDuplication, type CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import type { CrossFileDuplicationFileData } from './duplication.js';
import {
  listChangedFiles,
  listRepositoryFiles,
  listSymlinkPathsAtRevision,
  readFileAtRevision,
  resolveMergeBase,
  resolveRepoRoot,
  type ChangedFile,
} from './git.js';
import { collectCrossFileDuplicationFileData, collectFunctionTokenSequences, measureCode } from './metrics.js';
import {
  evaluateRegressionGate,
  type CheckedFunctionReport,
  type GateFileInput,
  type GateFunctionValues,
  type GateResult,
} from './regressionGate.js';
import {
  collectDuplicatedLineNumbers,
  configSearchDirectory,
  formatError,
  formatPath,
  getLanguage,
  isScannedPath,
  resolveTarget,
  scanListedFiles,
  writeStderr,
  writeStdout,
  type FileMetrics,
} from './scan.js';
import type { CodeMetrics, LanguageName } from './types.js';

/** Raw options of the `diff` subcommand; every field but base is undefined unless the flag was passed. */
export interface DiffCliOptions {
  base: string;
  config?: string;
  duplicationMinTokens?: number;
  duplicationMaxGapTokens?: number;
  duplicationMinSimilarityPercent?: number;
  includeTests?: boolean;
  json?: boolean;
  full?: boolean;
}

/** One changed file measured at both revisions, plus its duplication-universe contribution. */
interface PreparedFile {
  changed: ChangedFile;
  /** Repository-relative display path: the head path, or the base path for deleted files. */
  displayFile: string;
  /** Whether the file is gated (under the target directory); others only feed the base universe. */
  gated: boolean;
  headFile?: FileMetrics;
  baseMetrics?: CodeMetrics;
  baseCandidates?: CrossFileDuplicationFileData;
  baseFunctionTokens?: Int32Array[];
  headFunctionTokens?: Int32Array[];
}

/** A scanned file that git considers part of the project, keyed by its repository-relative path. */
interface ScannedFile {
  relativePath: string;
  file: FileMetrics;
}

/**
 * Runs the regression gate: measures the files changed relative to the merge-base with the base
 * ref, at both revisions (`git cat-file`; no checkout, no persisted baseline), and reports only
 * violations. Exit codes: 0 all gates passed, 1 violations, 2 changed files could not be measured.
 */
export async function runDiffCommand(target: string, cliOptions: DiffCliOptions): Promise<void> {
  try {
    await runGate(target, cliOptions);
  } catch (error) {
    writeStderr(`Error: ${formatError(error)}\n`);
    process.exitCode = 2;
  }
}

async function runGate(target: string, cliOptions: DiffCliOptions): Promise<void> {
  const resolvedTarget = resolveTarget(target);
  const config = await loadConfig(cliOptions.config, await configSearchDirectory(resolvedTarget));
  const options = resolveOptions(cliOptions, config);
  const gateOptions = resolveGateOptions(config);

  // The target may be a typo'd path whose ancestors don't exist either; repository discovery must
  // still run so the mistyped target gets its own diagnostic instead of a git spawn failure.
  const repoRoot = await realpath(
    await resolveRepoRoot(await firstExistingDirectory(await configSearchDirectory(resolvedTarget)))
  );
  const mergeBase = await resolveMergeBase(repoRoot, cliOptions.base);
  const changedFiles = await listChangedFiles(repoRoot, mergeBase);

  // Every git-visible file (tracked or untracked non-ignored) is measured at head: that provides
  // the head metrics of changed files and the project-wide duplication universe, so copy-paste
  // from unchanged code into changed files is caught. Scanning the explicit git list (instead of
  // walking the tree) keeps ignored artifact directories from ever being parsed: they exist in
  // neither the base commit nor CI, so they would only cost time and skew duplication counts.
  // Unchanged files are byte-identical at both revisions, so the base universe is the same scan
  // with the changed files' contents swapped for their merge-base blobs.
  const repositoryFiles = await listRepositoryFiles(repoRoot);
  const baseSymlinkPaths = await listSymlinkPathsAtRevision(repoRoot, mergeBase);
  const scan = await scanListedFiles(repoRoot, repositoryFiles, options);
  const scannedFiles: ScannedFile[] = scan.files.map((file) => ({
    relativePath: formatPath(file.file, scan.displayRoot),
    file,
  }));

  // A measurement failure on ANY scannable changed file forces exit 2 — deliberately including
  // files outside a scoped target, because cross-file function matching and the base duplication
  // universe for the gated files depend on them. Failures elsewhere (unchanged files) and
  // unsupported changed paths degrade to warnings.
  const changedPaths = new Set(
    changedFiles
      .flatMap((changed) => [changed.headPath, ...(changed.basePath === undefined ? [] : [changed.basePath])])
      .filter((changedPath) => isScannedPath(changedPath, options))
  );
  const errors: string[] = [];
  const warnings = [...scan.warnings];
  for (const error of scan.errors) {
    if ([...changedPaths].some((changedPath) => error.startsWith(`${changedPath}:`))) {
      errors.push(error);
    } else {
      warnings.push(error);
    }
  }

  const { canonicalTarget, targetExists } = await canonicalizeTarget(resolvedTarget);
  const prepared = await prepareChangedFiles(
    changedFiles,
    { repoRoot, mergeBase, canonicalTarget, options, scannedFiles, baseSymlinkPaths },
    errors,
    warnings
  );
  // A gate must not fail open on a mistyped target: a nonexistent path is only acceptable when it
  // still matches changed files (e.g. a fully deleted directory).
  if (!targetExists && !prepared.some((file) => file.gated)) {
    throw new Error(`target "${target}" does not exist and matches no changed file`);
  }

  // Non-gated files (outside the target, or renamed out of scan scope) still feed function
  // matching and the duplication universes; the evaluator reports nothing for them.
  const { baseCross, headCross } = measureDuplicationUniverses(prepared, scannedFiles, options);
  const inputs = prepared.map((file) => toGateInput(file, baseCross, headCross));
  const result = evaluateRegressionGate(inputs, gateOptions);

  if (cliOptions.json) {
    printJsonReport(cliOptions, mergeBase, result, inputs, errors, warnings);
  } else {
    printTextReport(cliOptions, mergeBase, result, errors, warnings);
  }

  if (errors.length > 0) {
    process.exitCode = 2;
  } else if (result.violations.length > 0) {
    process.exitCode = 1;
  }
}

/** The target may not exist (e.g. only deleted files under it); fall back to the resolved path. */
async function canonicalizeTarget(resolvedTarget: string): Promise<{ canonicalTarget: string; targetExists: boolean }> {
  try {
    return { canonicalTarget: await realpath(resolvedTarget), targetExists: true };
  } catch {
    return { canonicalTarget: resolvedTarget, targetExists: false };
  }
}

interface GateContext {
  repoRoot: string;
  mergeBase: string;
  canonicalTarget: string;
  options: ResolvedOptions;
  scannedFiles: ScannedFile[];
  /** Paths that are symbolic links at the merge-base; like head symlinks, they are not gated. */
  baseSymlinkPaths: Set<string>;
}

async function prepareChangedFiles(
  changedFiles: ChangedFile[],
  context: GateContext,
  errors: string[],
  warnings: string[]
): Promise<PreparedFile[]> {
  const headByPath = new Map(context.scannedFiles.map(({ relativePath, file }) => [relativePath, file]));
  const prepared: PreparedFile[] = [];
  for (const changed of changedFiles) {
    const file = await prepareChangedFile(changed, context, headByPath, errors, warnings);
    if (file) {
      prepared.push(file);
    }
  }
  return prepared;
}

async function prepareChangedFile(
  changed: ChangedFile,
  context: GateContext,
  headByPath: Map<string, FileMetrics>,
  errors: string[],
  warnings: string[]
): Promise<PreparedFile | undefined> {
  // Symbolic links are skipped on both sides, mirroring scanListedFiles: git stores only the
  // target string, so a symlink blob is not measurable source.
  const headScannable =
    changed.status !== 'deleted' &&
    isScannedPath(changed.headPath, context.options) &&
    !(await isSymbolicLink(path.join(context.repoRoot, changed.headPath)));
  // A base path outside the scan scope (renamed from a test/ignored directory, or an unsupported
  // extension) was never measurable code: its content gates as new code instead of ratcheting
  // against a blob the scanner would not have measured.
  const baseScannable =
    changed.basePath !== undefined &&
    isScannedPath(changed.basePath, context.options) &&
    !context.baseSymlinkPaths.has(changed.basePath);
  if (!headScannable && !baseScannable) {
    return undefined;
  }

  const displayFile = changed.status === 'deleted' ? (changed.basePath as string) : changed.headPath;
  const headFile = headScannable ? headByPath.get(changed.headPath) : undefined;
  if (headScannable && !headFile) {
    reportUnmeasuredChangedFile(changed.headPath, errors);
    return undefined;
  }

  const file: PreparedFile = {
    changed,
    displayFile,
    // A file whose head left the scan scope still contributes its base functions to matching and
    // its base blob to the base universe, but nothing about it is gated or reported.
    gated:
      headScannable || changed.status === 'deleted'
        ? isWithinTarget(path.join(context.repoRoot, displayFile), context.canonicalTarget)
        : false,
    headFile,
  };

  if (baseScannable && !(await measureBaseRevision(file, changed.basePath as string, context, errors, warnings))) {
    return undefined;
  }

  if (headFile) {
    await collectHeadFunctionTokens(file, headFile, context, warnings);
  }

  return file;
}

/**
 * The scan covers exactly the git-visible list, so a scannable changed path can only be missing
 * after a measurement failure (already recorded as an error) or a silent exclusion (an alias of
 * an already-visited file, or absence from the git list). Failing loudly keeps the gate from
 * passing with the file unchecked.
 */
function reportUnmeasuredChangedFile(headPath: string, errors: string[]): void {
  if (!errors.some((error) => error.startsWith(`${headPath}:`))) {
    errors.push(`${headPath}: changed file was not measured`);
  }
}

async function collectHeadFunctionTokens(
  file: PreparedFile,
  headFile: FileMetrics,
  context: GateContext,
  warnings: string[]
): Promise<void> {
  try {
    const headContent = await readFile(headFile.file, 'utf8');
    file.headFunctionTokens = collectFunctionTokenSequences(headContent, {
      language: getLanguage(file.changed.headPath, context.options) as LanguageName,
      duplication: context.options.duplication,
    });
  } catch (error) {
    // Only rename re-matching degrades without token sequences; the head metrics still gate.
    warnings.push(`${file.displayFile}: function token sequences unavailable: ${formatError(error)}`);
  }
}

/**
 * Measures the merge-base blob into `file`; false (with an error recorded) only when the metrics
 * themselves cannot be measured. The auxiliary collections (duplication candidates, token
 * sequences) always parse with the JavaScript binding, which can give up where the native backend
 * measured fine, so their failure only degrades duplication data and rename re-matching — the
 * function-level ratchets still run.
 */
async function measureBaseRevision(
  file: PreparedFile,
  basePath: string,
  context: GateContext,
  errors: string[],
  warnings: string[]
): Promise<boolean> {
  const measureOptions = {
    language: getLanguage(basePath, context.options) as LanguageName,
    duplication: context.options.duplication,
  };
  let baseContent;
  try {
    baseContent = await readFileAtRevision(context.repoRoot, context.mergeBase, basePath);
    file.baseMetrics = measureCode(baseContent, measureOptions);
  } catch (error) {
    errors.push(`${basePath} (at merge-base): ${formatError(error)}`);
    return false;
  }
  try {
    file.baseCandidates = collectCrossFileDuplicationFileData(baseContent, measureOptions);
    file.baseFunctionTokens = collectFunctionTokenSequences(baseContent, measureOptions);
  } catch (error) {
    warnings.push(
      `${basePath} (at merge-base): duplication candidates and token sequences unavailable: ${formatError(error)}`
    );
  }
  return true;
}

async function isSymbolicLink(absolutePath: string): Promise<boolean> {
  const stats = await lstat(absolutePath).catch(() => {});
  return stats?.isSymbolicLink() ?? false;
}

/** Walks up to the nearest existing DIRECTORY, so git commands never spawn in a missing or non-directory cwd. */
async function firstExistingDirectory(directory: string): Promise<string> {
  let current = directory;
  while (true) {
    const stats = await stat(current).catch(() => {});
    if (stats?.isDirectory()) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

function isWithinTarget(candidate: string, targetDirectory: string): boolean {
  const relative = path.relative(targetDirectory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function measureDuplicationUniverses(
  prepared: PreparedFile[],
  scannedFiles: ScannedFile[],
  options: ResolvedOptions
): { baseCross?: CrossFileDuplicationMetrics; headCross?: CrossFileDuplicationMetrics } {
  const headSources = scannedFiles.flatMap(({ relativePath, file }) =>
    file.duplicationCandidates ? [{ file: relativePath, ...file.duplicationCandidates }] : []
  );

  const changedHeadPaths = new Set(
    prepared.flatMap((file) => (file.changed.status === 'deleted' ? [] : [file.changed.headPath]))
  );
  const baseSources = headSources.filter((source) => !changedHeadPaths.has(source.file));
  for (const file of prepared) {
    if (file.baseCandidates && file.changed.basePath !== undefined) {
      baseSources.push({ file: file.changed.basePath, ...file.baseCandidates });
    }
  }

  return {
    baseCross: baseSources.length >= 2 ? measureCrossFileDuplication(baseSources, options.duplication) : undefined,
    headCross: headSources.length >= 2 ? measureCrossFileDuplication(headSources, options.duplication) : undefined,
  };
}

function toGateInput(
  file: PreparedFile,
  baseCross: CrossFileDuplicationMetrics | undefined,
  headCross: CrossFileDuplicationMetrics | undefined
): GateFileInput {
  return {
    file: file.displayFile,
    baseMetrics: file.baseMetrics,
    headMetrics: file.headFile?.metrics,
    baseFunctionTokens: file.baseFunctionTokens,
    headFunctionTokens: file.headFunctionTokens,
    baseDuplicatedLineCount:
      file.baseMetrics === undefined || file.changed.basePath === undefined
        ? 0
        : countDuplicatedLines(file.baseMetrics, baseCross, file.changed.basePath),
    headDuplicatedLineCount:
      file.changed.status === 'deleted'
        ? 0
        : countDuplicatedLines(file.headFile?.metrics, headCross, file.changed.headPath),
    duplicationPartners: collectPartners(headCross, file.changed.headPath),
    gated: file.gated,
  };
}

function countDuplicatedLines(
  metrics: CodeMetrics | undefined,
  cross: CrossFileDuplicationMetrics | undefined,
  file: string
): number {
  return collectDuplicatedLineNumbers(metrics, cross, file).size;
}

function collectPartners(cross: CrossFileDuplicationMetrics | undefined, file: string): string[] {
  if (!cross) {
    return [];
  }
  const partners = new Set<string>();
  for (const group of cross.groups) {
    if (group.files.includes(file)) {
      for (const partner of group.files) {
        if (partner !== file) {
          partners.add(partner);
        }
      }
    }
  }
  return [...partners].toSorted();
}

function printTextReport(
  cliOptions: DiffCliOptions,
  mergeBase: string,
  result: GateResult,
  errors: string[],
  warnings: string[]
): void {
  const shortBase = mergeBase.slice(0, 12);
  if (errors.length > 0) {
    // Unmeasured files were not gated, so "0 violations" would be vacuous; never claim a pass.
    writeStdout(
      `Regression gate could not complete: ${errors.length} measurement failures (details on stderr)` +
        `${result.violations.length > 0 ? `; ${result.violations.length} violations in the measured files` : ''} (base ${cliOptions.base}, merge-base ${shortBase}).\n`
    );
    printViolations(result);
  } else if (result.violations.length === 0) {
    writeStdout(
      `Regression gate passed: ${result.checkedFileCount} changed files, ${result.checkedFunctionCount} functions checked (base ${cliOptions.base}, merge-base ${shortBase}).\n`
    );
  } else {
    writeStdout(
      `Regression gate vs ${cliOptions.base} (merge-base ${shortBase}): ${result.violations.length} violations\n`
    );
    printViolations(result);
  }

  if (cliOptions.full) {
    printFullDetails(result);
  }

  for (const warning of warnings) {
    writeStderr(`Warning: ${warning}\n`);
  }
  for (const error of errors) {
    writeStderr(`Error: ${error}\n`);
  }
}

function printViolations(result: GateResult): void {
  for (const [index, violation] of result.violations.entries()) {
    writeStdout(`${index + 1}. ${violation.message}\n`);
  }
}

/** Base -> head values of every checked function; kept behind --full for humans and trending. */
function printFullDetails(result: GateResult): void {
  if (result.checkedFunctions.length === 0) {
    return;
  }
  writeStdout('\nChecked functions (base -> head):\n');
  for (const report of result.checkedFunctions) {
    writeStdout(`- ${formatFunctionReport(report)}\n`);
  }
}

function formatFunctionReport(report: CheckedFunctionReport): string {
  const range = (
    select: (values: GateFunctionValues) => number,
    format: (value: number) => string = String
  ): string => {
    const head = format(select(report.head));
    return report.base ? `${format(select(report.base))} -> ${head}` : head;
  };
  const values = [
    `cognitive ${range((fn) => fn.cognitiveComplexity)}`,
    `NCSS ${range((fn) => fn.ncss)}`,
    `nesting ${range((fn) => fn.nestingDepth)}`,
    `DepDegree ${range((fn) => fn.depDegree)}`,
    `volume ${range(
      (fn) => fn.halsteadVolume,
      (value) => value.toFixed(1)
    )}`,
  ];
  return `${report.file}:${report.startLine}-${report.endLine} ${report.name}${report.base ? '' : ' (new)'}: ${values.join(', ')}`;
}

function printJsonReport(
  cliOptions: DiffCliOptions,
  mergeBase: string,
  result: GateResult,
  inputs: GateFileInput[],
  errors: string[],
  warnings: string[]
): void {
  const report: Record<string, unknown> = {
    base: cliOptions.base,
    mergeBase,
    passed: result.violations.length === 0 && errors.length === 0,
    violations: result.violations,
    checkedFileCount: result.checkedFileCount,
    checkedFunctionCount: result.checkedFunctionCount,
    newFunctionCount: result.newFunctionCount,
    errors,
    warnings,
  };
  if (cliOptions.full) {
    report.files = inputs
      .filter((input) => input.gated !== false)
      .map((input) => ({
        file: input.file,
        baseFunctionCount: input.baseMetrics?.functions.length ?? 0,
        headFunctionCount: input.headMetrics?.functions.length ?? 0,
        baseNcss: input.baseMetrics?.ncssCount ?? 0,
        headNcss: input.headMetrics?.ncssCount ?? 0,
        baseMaxCognitiveComplexity: input.baseMetrics?.maxCognitiveComplexity ?? 0,
        headMaxCognitiveComplexity: input.headMetrics?.maxCognitiveComplexity ?? 0,
        baseDuplicatedLineCount: input.baseDuplicatedLineCount,
        headDuplicatedLineCount: input.headDuplicatedLineCount,
        duplicationPartners: input.duplicationPartners,
        functions: result.checkedFunctions.filter((fn) => fn.file === input.file),
      }));
  }
  writeStdout(JSON.stringify(report, undefined, 2) + '\n');
}
