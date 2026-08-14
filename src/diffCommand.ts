import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolveGateOptions, resolveOptions, type ResolvedOptions } from './cliConfig.js';
import { measureCrossFileDuplication, type CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import type { CrossFileDuplicationFileData } from './duplication.js';
import {
  listChangedFiles,
  listRepositoryFiles,
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
  scanTarget,
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

  const repoRoot = await realpath(await resolveRepoRoot(await configSearchDirectory(resolvedTarget)));
  const mergeBase = await resolveMergeBase(repoRoot, cliOptions.base);
  const changedFiles = await listChangedFiles(repoRoot, mergeBase);

  // The whole repository is scanned at head: it provides the head metrics of changed files and
  // the project-wide duplication universe, so copy-paste from unchanged code into changed files
  // is caught. Only git-visible files (tracked or untracked non-ignored) participate: a local
  // ignored artifact exists in neither the base commit nor CI, so letting it into the universes
  // would skew duplication counts. Unchanged files are byte-identical at both revisions, so the
  // base universe is the same scan with the changed files' contents swapped for their merge-base
  // blobs.
  const scan = await scanTarget(repoRoot, options);
  if (scan.fatalError) {
    throw new Error(scan.fatalError);
  }
  const repositoryFiles = await listRepositoryFiles(repoRoot);
  const scannedFiles: ScannedFile[] = scan.files
    .map((file) => ({ relativePath: formatPath(file.file, scan.displayRoot), file }))
    .filter(({ relativePath }) => repositoryFiles.has(relativePath));

  // Only failures affecting gateable changed files force exit 2: a broken symlink or unreadable
  // directory elsewhere in the repository (or an unsupported changed path) must not turn every
  // diff run red.
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

  const canonicalTarget = await canonicalizeTarget(resolvedTarget);
  const prepared = await prepareChangedFiles(
    changedFiles,
    { repoRoot, mergeBase, canonicalTarget, options, scannedFiles },
    errors,
    warnings
  );

  const { baseCross, headCross } = measureDuplicationUniverses(prepared, scannedFiles, options);
  const inputs = prepared.filter((file) => file.gated).map((file) => toGateInput(file, baseCross, headCross));
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
async function canonicalizeTarget(resolvedTarget: string): Promise<string> {
  try {
    return await realpath(resolvedTarget);
  } catch {
    return resolvedTarget;
  }
}

interface GateContext {
  repoRoot: string;
  mergeBase: string;
  canonicalTarget: string;
  options: ResolvedOptions;
  scannedFiles: ScannedFile[];
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
  const displayFile = changed.status === 'deleted' ? (changed.basePath as string) : changed.headPath;
  if (!isScannedPath(displayFile, context.options)) {
    return undefined;
  }
  const language = getLanguage(displayFile, context.options) as LanguageName;

  const headFile = changed.status === 'deleted' ? undefined : headByPath.get(changed.headPath);
  if (changed.status !== 'deleted' && !headFile) {
    // Changed but not scanned: the scan itself failed on it (already an error) or it fell to an
    // ignore rule the path check cannot see. Either way there is nothing to gate.
    return undefined;
  }

  const file: PreparedFile = {
    changed,
    displayFile,
    gated: isWithinTarget(path.join(context.repoRoot, displayFile), context.canonicalTarget),
    headFile,
  };

  // A base path outside the scan scope (renamed from a test/ignored directory, or an unsupported
  // extension) was never measurable code: its content gates as new code instead of ratcheting
  // against a blob the scanner would not have measured.
  const basePath =
    changed.basePath !== undefined && isScannedPath(changed.basePath, context.options) ? changed.basePath : undefined;
  if (basePath !== undefined && !(await measureBaseRevision(file, basePath, context, errors, warnings))) {
    return undefined;
  }

  if (headFile) {
    try {
      const headContent = await readFile(headFile.file, 'utf8');
      file.headFunctionTokens = collectFunctionTokenSequences(headContent, {
        language,
        duplication: context.options.duplication,
      });
    } catch (error) {
      // Only rename re-matching degrades without token sequences; the head metrics still gate.
      warnings.push(`${displayFile}: function token sequences unavailable: ${formatError(error)}`);
    }
  }

  return file;
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
    report.files = inputs.map((input) => ({
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
