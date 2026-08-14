import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, resolveGateOptions, resolveOptions, type ResolvedOptions } from './cliConfig.js';
import { measureCrossFileDuplication, type CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import type { CrossFileDuplicationFileData } from './duplication.js';
import { listChangedFiles, readFileAtRevision, resolveMergeBase, resolveRepoRoot, type ChangedFile } from './git.js';
import { collectCrossFileDuplicationFileData, collectFunctionTokenSequences, measureCode } from './metrics.js';
import { evaluateRegressionGate, type GateFileInput, type GateResult } from './regressionGate.js';
import {
  collectDuplicatedLineNumbers,
  configSearchDirectory,
  formatError,
  formatPath,
  getLanguage,
  resolveTarget,
  scanTarget,
  writeStderr,
  writeStdout,
  type FileMetrics,
  type ScanResult,
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

/**
 * Runs the regression gate: measures the files changed relative to the merge-base with the base
 * ref, at both revisions (`git cat-file`; no checkout, no persisted baseline), and reports only
 * violations. Exit codes: 0 all gates passed, 1 violations, 2 files could not be measured.
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
  // is caught. Unchanged files are byte-identical at both revisions, so the base universe is the
  // same scan with the changed files' contents swapped for their merge-base blobs.
  const scan = await scanTarget(repoRoot, options);
  if (scan.fatalError) {
    throw new Error(scan.fatalError);
  }
  const errors = [...scan.errors];
  const warnings = [...scan.warnings];
  const canonicalTarget = await canonicalizeTarget(resolvedTarget);
  const prepared = await prepareChangedFiles(
    changedFiles,
    { repoRoot, mergeBase, canonicalTarget, options, scan },
    errors,
    warnings
  );

  const { baseCross, headCross } = measureDuplicationUniverses(prepared, scan, options);
  const inputs = prepared.filter((file) => file.gated).map((file) => toGateInput(file, baseCross, headCross));
  const result = evaluateRegressionGate(inputs, gateOptions);

  if (cliOptions.json) {
    printJsonReport(cliOptions, mergeBase, result, inputs, errors, warnings);
  } else {
    printTextReport(cliOptions, mergeBase, result, inputs, errors, warnings);
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
  scan: ScanResult;
}

async function prepareChangedFiles(
  changedFiles: ChangedFile[],
  context: GateContext,
  errors: string[],
  warnings: string[]
): Promise<PreparedFile[]> {
  const headByPath = new Map(context.scan.files.map((file) => [formatPath(file.file, context.scan.displayRoot), file]));
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
  const language = getLanguage(displayFile, context.options);
  if (!language) {
    return undefined;
  }

  const headFile = changed.status === 'deleted' ? undefined : headByPath.get(changed.headPath);
  if (changed.status !== 'deleted' && !headFile) {
    // Changed but not scanned: ignored directory, or the scan itself failed on it (already an
    // error). Either way there is nothing to gate.
    return undefined;
  }

  const file: PreparedFile = {
    changed,
    displayFile,
    gated: isWithinTarget(path.join(context.repoRoot, displayFile), context.canonicalTarget),
    headFile,
  };

  if (
    changed.basePath !== undefined &&
    !(await measureBaseRevision(file, changed.basePath, language, context, errors))
  ) {
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

/** Measures the merge-base blob into `file`; false (with an error recorded) when that fails. */
async function measureBaseRevision(
  file: PreparedFile,
  basePath: string,
  headLanguage: LanguageName,
  context: GateContext,
  errors: string[]
): Promise<boolean> {
  try {
    const baseContent = await readFileAtRevision(context.repoRoot, context.mergeBase, basePath);
    const language = getLanguage(basePath, context.options) ?? headLanguage;
    const measureOptions = { language, duplication: context.options.duplication };
    file.baseMetrics = measureCode(baseContent, measureOptions);
    file.baseCandidates = collectCrossFileDuplicationFileData(baseContent, measureOptions);
    file.baseFunctionTokens = collectFunctionTokenSequences(baseContent, measureOptions);
    return true;
  } catch (error) {
    errors.push(`${basePath} (at merge-base): ${formatError(error)}`);
    return false;
  }
}

function isWithinTarget(candidate: string, targetDirectory: string): boolean {
  const relative = path.relative(targetDirectory, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function measureDuplicationUniverses(
  prepared: PreparedFile[],
  scan: ScanResult,
  options: ResolvedOptions
): { baseCross?: CrossFileDuplicationMetrics; headCross?: CrossFileDuplicationMetrics } {
  const headSources = scan.files.flatMap(({ file, duplicationCandidates }) =>
    duplicationCandidates ? [{ file: formatPath(file, scan.displayRoot), ...duplicationCandidates }] : []
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
      file.changed.basePath === undefined
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
  inputs: GateFileInput[],
  errors: string[],
  warnings: string[]
): void {
  const shortBase = mergeBase.slice(0, 12);
  if (result.violations.length === 0) {
    writeStdout(
      `Regression gate passed: ${result.checkedFileCount} changed files, ${result.checkedFunctionCount} functions checked (base ${cliOptions.base}, merge-base ${shortBase}).\n`
    );
  } else {
    writeStdout(
      `Regression gate vs ${cliOptions.base} (merge-base ${shortBase}): ${result.violations.length} violations\n`
    );
    for (const [index, violation] of result.violations.entries()) {
      writeStdout(`${index + 1}. ${violation.message}\n`);
    }
  }

  if (cliOptions.full) {
    printFullDetails(inputs);
  }

  for (const warning of warnings) {
    writeStderr(`Warning: ${warning}\n`);
  }
  for (const error of errors) {
    writeStderr(`Error: ${error}\n`);
  }
}

/** Per-file base -> head values of the gated aggregates; kept behind --full for humans. */
function printFullDetails(inputs: GateFileInput[]): void {
  if (inputs.length === 0) {
    return;
  }
  writeStdout('\nChanged files (base -> head):\n');
  for (const input of inputs) {
    const base = input.baseMetrics;
    const head = input.headMetrics;
    const parts = [
      `functions ${base?.functions.length ?? 0} -> ${head?.functions.length ?? 0}`,
      `NCSS ${base?.ncssCount ?? 0} -> ${head?.ncssCount ?? 0}`,
      `max cognitive ${base?.maxCognitiveComplexity ?? 0} -> ${head?.maxCognitiveComplexity ?? 0}`,
      `duplicated lines ${input.baseDuplicatedLineCount} -> ${input.headDuplicatedLineCount}`,
    ];
    writeStdout(`- ${input.file}: ${parts.join(', ')}\n`);
  }
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
    }));
  }
  writeStdout(JSON.stringify(report, undefined, 2) + '\n');
}
