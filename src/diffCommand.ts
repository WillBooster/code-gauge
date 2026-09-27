import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, resolveGateOptions, resolveOptions, type ResolvedOptions } from './cliConfig.js';
import {
  measureCrossFileDuplication,
  type CrossFileDuplicateOccurrence,
  type CrossFileDuplicationMetrics,
} from './crossFileDuplication.js';
import type { CrossFileDuplicationFileData, Token } from './duplication.js';
import { keepPaths, loadRepositoryExclusion, type Exclusion } from './exclusion.js';
import {
  listChangedFiles,
  listLineHunks,
  listRepositoryFiles,
  listSymlinkPathsAtRevision,
  readFileAtRevision,
  resolveMergeBase,
  resolveRepoRoot,
  type ChangedFile,
} from './git.js';
import { collectFunctionTokenSequences } from './metrics.js';
import {
  findNewlyDuplicatedLines,
  indexPartnersByLine,
  type CloneOccurrence,
  type DuplicationChange,
  type LineHunk,
} from './newDuplication.js';
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
  measureWithCrossFileData,
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
  headContent?: string;
  baseMetrics?: CodeMetrics;
  baseContent?: string;
  /**
   * The line diff from the measured base to the measured head; with one side unmeasured, every
   * line of the other counts as added or deleted.
   */
  hunks?: LineHunk[];
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
  const { canonicalTarget, targetExists } = await canonicalizeTarget(resolvedTarget);
  const targetStat = await stat(canonicalTarget).catch(() => {});
  const targetFile = targetStat?.isFile() ? canonicalTarget : undefined;
  // A targeted file git does not list (an ignored one) is still measured, as an addition.
  const unlistedTarget = targetFile && path.relative(repoRoot, targetFile).split(path.sep).join('/');
  if (unlistedTarget !== undefined && !unlistedTarget.startsWith('../') && !repositoryFiles.has(unlistedTarget)) {
    repositoryFiles.add(unlistedTarget);
    changedFiles.push({ status: 'added', headPath: unlistedTarget });
  }
  const explicitFiles = listExplicitlyTargetedPaths(targetFile, repoRoot, changedFiles);
  // Base blobs are excluded by the attributes of the revision they come from. A changed
  // .gitattributes can re-include files whose bytes did not change, so then every file's base
  // attributes are needed to find them.
  const attributesChanged = changedFiles.some((changed) =>
    [changed.headPath, changed.basePath].some(
      (file) => file !== undefined && path.posix.basename(file) === '.gitattributes'
    )
  );
  const basePaths = changedFiles.flatMap((changed) => (changed.basePath === undefined ? [] : [changed.basePath]));
  const [headAttributesExclusion, baseAttributesExclusion] = await Promise.all([
    loadRepositoryExclusion(repoRoot, repositoryFiles, options.exclude),
    loadRepositoryExclusion(
      repoRoot,
      attributesChanged ? [...new Set([...basePaths, ...repositoryFiles])] : basePaths,
      options.exclude,
      mergeBase
    ),
  ]);
  const headExclusion = keepPaths(headAttributesExclusion, explicitFiles);
  const baseExclusion = keepPaths(baseAttributesExclusion, explicitFiles);
  const scan = await scanListedFiles(
    repoRoot,
    repositoryFiles,
    { ...options, loadExclusion: () => Promise.resolve(headExclusion) },
    explicitFiles
  );
  // A run-wide failure (a missing native addon) invalidates the whole gate: surface it once as
  // the fatal error (exit 2) instead of diagnosing every changed file as unmeasured.
  if (scan.fatalError) {
    throw new Error(scan.fatalError);
  }
  const scannedFiles: ScannedFile[] = scan.files.map((file) => ({
    relativePath: formatPath(file.file, scan.displayRoot),
    file,
  }));
  if (attributesChanged) {
    changedFiles.push(
      ...(await listReincludedFiles(scannedFiles, changedFiles, repoRoot, headExclusion, baseExclusion))
    );
  }

  // A measurement failure on ANY scannable changed file forces exit 2 — deliberately including
  // files outside a scoped target, because cross-file function matching and the base duplication
  // universe for the gated files depend on them. Failures elsewhere (unchanged files) and
  // unsupported changed paths degrade to warnings.
  const changedPaths = new Set(
    changedFiles
      .flatMap((changed) => [changed.headPath, ...(changed.basePath === undefined ? [] : [changed.basePath])])
      .filter((changedPath) => isScannedPath(changedPath, options, explicitFiles.has(path.join(repoRoot, changedPath))))
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

  const prepared = await prepareChangedFiles(
    changedFiles,
    {
      repoRoot,
      mergeBase,
      canonicalTarget,
      options,
      scannedFiles,
      baseSymlinkPaths,
      scanErrors: [...errors],
      headExclusion,
      baseExclusion,
      explicitFiles,
      generatedHeadFiles: new Set(scan.generatedFiles),
    },
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
  const renamedPaths = new Map(
    prepared.flatMap(({ changed }) =>
      changed.status === 'renamed' && changed.basePath !== undefined
        ? [[changed.basePath, changed.headPath] as const]
        : []
    )
  );
  const headPathOf = (basePath: string): string => renamedPaths.get(basePath) ?? basePath;
  const lineSignaturesOf = createLineSignatureIndex(scannedFiles);
  const newlyDuplicatedLines = findNewlyDuplicatedLines(
    prepared.map((file) => toDuplicationChange(file, baseCross, headCross, headPathOf, lineSignaturesOf))
  );
  const inputs = prepared.map((file, index) => toGateInput(file, newlyDuplicatedLines[index] ?? [], headCross));
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

/** Content with a generated-code marker, to ask whether an exclusion honors the marker for a path. */
const markedCode = '/* @generated */';

/**
 * Unchanged files the head scan measured but the merge-base would not have: excluded by its
 * attributes, or generated by content without the `-linguist-generated` override the working tree
 * adds. Their code is newly measured, so it gates as a modification from an unmeasurable base. The
 * head side comes from the scan, which already applied scope, symbolic-link, and exclusion rules.
 */
async function listReincludedFiles(
  scannedFiles: readonly ScannedFile[],
  changedFiles: readonly ChangedFile[],
  repoRoot: string,
  headExclusion: Exclusion,
  baseExclusion: Exclusion
): Promise<ChangedFile[]> {
  const changedPaths = new Set(changedFiles.flatMap((changed) => [changed.headPath, changed.basePath]));
  const reincluded: ChangedFile[] = [];
  for (const { relativePath, file } of scannedFiles) {
    const absolutePath = path.join(repoRoot, relativePath);
    if (changedPaths.has(relativePath)) {
      continue;
    }
    // The same content is generated at one revision only when its override differs, so the
    // content is read just for files the working tree newly marks -linguist-generated.
    const overrideAdded =
      baseExclusion.isGeneratedCode(absolutePath, markedCode) &&
      !headExclusion.isGeneratedCode(absolutePath, markedCode);
    if (
      baseExclusion.isExcludedPath(absolutePath) ||
      (overrideAdded && baseExclusion.isGeneratedCode(absolutePath, await readFile(file.file, 'utf8')))
    ) {
      reincluded.push({ status: 'modified', basePath: relativePath, headPath: relativePath });
    }
  }
  return reincluded;
}

/**
 * An explicitly targeted file is measured even when excluded, like the ranking command's single
 * file target: the file itself, and its base path when it was renamed.
 */
function listExplicitlyTargetedPaths(
  targetFile: string | undefined,
  repoRoot: string,
  changedFiles: ChangedFile[]
): Set<string> {
  if (targetFile === undefined) {
    return new Set();
  }
  const paths = new Set([targetFile]);
  for (const changed of changedFiles) {
    if (changed.basePath !== undefined && path.join(repoRoot, changed.headPath) === targetFile) {
      paths.add(path.join(repoRoot, changed.basePath));
    }
  }
  return paths;
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
  /** Errors the head scan recorded against changed files. */
  scanErrors: readonly string[];
  headExclusion: Exclusion;
  baseExclusion: Exclusion;
  /** The explicitly targeted file (and its renamed base path), measured despite every exclusion. */
  explicitFiles: ReadonlySet<string>;
  /** Absolute paths the head scan skipped as generated code. */
  generatedHeadFiles: ReadonlySet<string>;
}

async function prepareChangedFiles(
  changedFiles: ChangedFile[],
  context: GateContext,
  errors: string[],
  warnings: string[]
): Promise<PreparedFile[]> {
  const headByPath = new Map(context.scannedFiles.map(({ relativePath, file }) => [relativePath, file]));
  // Files are prepared concurrently (git reads and base measurements); each records its diagnostics
  // on its own, and they are appended in changed-file order so the report stays deterministic.
  const results = await mapConcurrently(changedFiles, os.availableParallelism() * 2, async (changed) => {
    const fileErrors: string[] = [];
    const fileWarnings: string[] = [];
    const file = await prepareChangedFile(changed, context, headByPath, fileErrors, fileWarnings);
    return { file, fileErrors, fileWarnings };
  });
  const prepared: PreparedFile[] = [];
  for (const { file, fileErrors, fileWarnings } of results) {
    errors.push(...fileErrors);
    warnings.push(...fileWarnings);
    if (file) {
      prepared.push(file);
    }
  }
  return prepared;
}

/** `Promise.all(items.map(map))` with at most `limit` calls pending at once, results in input order. */
async function mapConcurrently<T, R>(items: readonly T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let nextIndex = 0;
  const work = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, work));
  return results;
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
  const absoluteHeadPath = path.join(context.repoRoot, changed.headPath);
  const headScannable =
    changed.status !== 'deleted' &&
    isScannedPath(changed.headPath, context.options, context.explicitFiles.has(absoluteHeadPath)) &&
    !context.headExclusion.isExcludedPath(absoluteHeadPath) &&
    !context.generatedHeadFiles.has(absoluteHeadPath) &&
    !(await isSymbolicLink(absoluteHeadPath));
  // A base path outside the scan scope (renamed from a test/ignored directory, or an unsupported
  // extension) was never measurable code: its content gates as new code instead of ratcheting
  // against a blob the scanner would not have measured.
  const absoluteBasePath = changed.basePath === undefined ? '' : path.join(context.repoRoot, changed.basePath);
  const baseScannable =
    changed.basePath !== undefined &&
    isScannedPath(changed.basePath, context.options, context.explicitFiles.has(absoluteBasePath)) &&
    !context.baseExclusion.isExcludedPath(absoluteBasePath) &&
    !context.baseSymlinkPaths.has(changed.basePath);
  if (!headScannable && !baseScannable) {
    return undefined;
  }

  const displayFile = changed.status === 'deleted' ? (changed.basePath as string) : changed.headPath;
  const headFile = headScannable ? headByPath.get(changed.headPath) : undefined;
  if (headScannable && !headFile) {
    reportUnmeasuredChangedFile(changed.headPath, context.scanErrors, errors);
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

  if (baseScannable) {
    const outcome = await measureBaseRevision(file, changed.basePath as string, context, errors, warnings);
    // A base that turns out to be generated code gates its head as new code, like any other base
    // outside the scan scope.
    if (outcome === 'failed' || (outcome === 'generated' && !headFile)) {
      return undefined;
    }
  }

  try {
    if (headFile) {
      // The duplication gate needs the head lines, so an unreadable head fails like an unmeasured one.
      file.headContent = await readFile(headFile.file, 'utf8');
      collectHeadFunctionTokens(file, file.headContent, context, warnings);
    }
    file.hunks = await diffMeasuredRevisions(file, context);
  } catch (error) {
    errors.push(`${displayFile}: ${formatError(error)}`);
    return undefined;
  }
  return file;
}

async function diffMeasuredRevisions(file: PreparedFile, context: GateContext): Promise<LineHunk[]> {
  const { changed, baseContent, headContent } = file;
  if (baseContent !== undefined && headContent !== undefined) {
    return await listLineHunks(context.repoRoot, context.mergeBase, changed.basePath as string, changed.headPath);
  }
  return [
    {
      baseStart: 1,
      baseCount: baseContent === undefined ? 0 : splitLines(baseContent).length,
      headStart: 1,
      headCount: headContent === undefined ? 0 : splitLines(headContent).length,
    },
  ];
}

/** Line numbering of the measured metrics (classifyLines splits on every line terminator). */
function splitLines(content: string): string[] {
  return content.split(/\r\n|\n|\r/u);
}

/**
 * The scan covers exactly the git-visible list, so a scannable changed path can only be missing
 * after a measurement failure (already recorded as an error) or a silent exclusion (an alias of
 * an already-visited file, or absence from the git list). Failing loudly keeps the gate from
 * passing with the file unchecked.
 */
function reportUnmeasuredChangedFile(headPath: string, scanErrors: readonly string[], errors: string[]): void {
  if (!scanErrors.some((error) => error.startsWith(`${headPath}:`))) {
    errors.push(`${headPath}: changed file was not measured`);
  }
}

function collectHeadFunctionTokens(
  file: PreparedFile,
  headContent: string,
  context: GateContext,
  warnings: string[]
): void {
  try {
    file.headFunctionTokens = collectFunctionTokenSequences(headContent, {
      language: languageOf(file.changed.headPath, context),
      duplication: context.options.duplication,
    });
  } catch (error) {
    // Only rename re-matching degrades without token sequences; the head metrics still gate.
    warnings.push(`${file.displayFile}: function token sequences unavailable: ${formatError(error)}`);
  }
}

/**
 * Measures the merge-base blob into `file`; 'failed' (with an error recorded) only when the
 * metrics themselves cannot be measured, and 'generated' (nothing measured) for generated code.
 * The auxiliary collections (duplication candidates, token sequences) may fail independently of
 * the metrics, so their failure only degrades duplication data and rename re-matching — the
 * function-level ratchets still run.
 */
async function measureBaseRevision(
  file: PreparedFile,
  basePath: string,
  context: GateContext,
  errors: string[],
  warnings: string[]
): Promise<'measured' | 'generated' | 'failed'> {
  const measureOptions = {
    language: languageOf(basePath, context),
    duplication: context.options.duplication,
  };
  let baseContent;
  try {
    baseContent = await readFileAtRevision(context.repoRoot, context.mergeBase, basePath);
    if (context.baseExclusion.isGeneratedCode(path.join(context.repoRoot, basePath), baseContent)) {
      return 'generated';
    }
    const measured = await measureWithCrossFileData(baseContent, measureOptions);
    file.baseMetrics = measured.metrics;
    file.baseContent = baseContent;
    file.baseCandidates = measured.crossFileData;
    if (measured.crossFileError !== undefined) {
      warnings.push(`${basePath} (at merge-base): duplication candidates unavailable: ${measured.crossFileError}`);
    }
  } catch (error) {
    errors.push(`${basePath} (at merge-base): ${formatError(error)}`);
    return 'failed';
  }
  try {
    file.baseFunctionTokens = collectFunctionTokenSequences(baseContent, measureOptions);
  } catch (error) {
    warnings.push(`${basePath} (at merge-base): function token sequences unavailable: ${formatError(error)}`);
  }
  return 'measured';
}

/** The language of a scannable path; an explicitly targeted file skips the test-file name rules. */
function languageOf(relativePath: string, context: GateContext): LanguageName {
  const explicitTarget = context.explicitFiles.has(path.join(context.repoRoot, relativePath));
  return getLanguage(relativePath, context.options, explicitTarget) as LanguageName;
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

function toDuplicationChange(
  file: PreparedFile,
  baseCross: CrossFileDuplicationMetrics | undefined,
  headCross: CrossFileDuplicationMetrics | undefined,
  headPathOf: (basePath: string) => string,
  lineSignaturesOf: (file: string) => LineSignatures | undefined
): DuplicationChange {
  const headOccurrences = collectOccurrences(file.headFile?.metrics, headCross, file.changed.headPath);
  return {
    baseLines: file.baseContent === undefined ? undefined : splitLines(file.baseContent),
    headLines: file.headContent === undefined ? undefined : splitLines(file.headContent),
    baseDuplicatedLines:
      file.baseMetrics === undefined || file.changed.basePath === undefined
        ? new Set()
        : collectDuplicatedLineNumbers(file.baseMetrics, baseCross, file.changed.basePath),
    headDuplicatedLines:
      file.headFile === undefined
        ? new Set()
        : keepRepeatedLines(
            collectDuplicatedLineNumbers(file.headFile.metrics, headCross, file.changed.headPath),
            file.changed.headPath,
            headOccurrences,
            lineSignaturesOf
          ),
    baseOccurrences: collectOccurrences(file.baseMetrics, baseCross, file.changed.basePath, headPathOf),
    headOccurrences,
    hunks: file.hunks ?? [],
  };
}

/** A file's per-line normalized token signatures and how many lines carry each. */
interface LineSignatures {
  byLine: Map<number, string>;
  lineCounts: Map<string, number>;
}

/** Line signatures of the scanned head files, computed on first use. */
function createLineSignatureIndex(scannedFiles: ScannedFile[]): (file: string) => LineSignatures | undefined {
  const tokensByFile = new Map(
    scannedFiles.map(({ relativePath, file }) => [relativePath, file.duplicationCandidates?.tokens])
  );
  const signaturesByFile = new Map<string, LineSignatures | undefined>();
  return (file) => {
    if (!signaturesByFile.has(file)) {
      const tokens = tokensByFile.get(file);
      signaturesByFile.set(file, tokens && signLines(tokens));
    }
    return signaturesByFile.get(file);
  };
}

/** Each line's tokens with identifiers anonymized, as clone detection compares them. */
function signLines(tokens: readonly Token[]): LineSignatures {
  const byLine = new Map<number, string>();
  for (const token of tokens) {
    const line = token.startRow + 1;
    byLine.set(line, `${byLine.get(line) ?? ''}${token.kind === 'id' ? '\u0001' : token.text}\u0000`);
  }
  const lineCounts = new Map<string, number>();
  for (const signature of byLine.values()) {
    lineCounts.set(signature, (lineCounts.get(signature) ?? 0) + 1);
  }
  return { byLine, lineCounts };
}

/**
 * The duplicated lines whose normalized tokens a partner file of their clones (the file itself,
 * on another line, for `''`) repeats on some line. Near-miss coverage also marks lines the copies
 * do not share, such as a new line inserted into an old near-miss clone, which copied nothing.
 */
function keepRepeatedLines(
  lines: ReadonlySet<number>,
  file: string,
  occurrences: readonly CloneOccurrence[],
  lineSignaturesOf: (file: string) => LineSignatures | undefined
): Set<number> {
  const own = lineSignaturesOf(file);
  if (own === undefined) {
    return new Set(lines);
  }
  const repeats = (signature: string, partner: string): boolean => {
    if (partner === '') {
      return (own.lineCounts.get(signature) ?? 0) > 1;
    }
    const partnerSignatures = lineSignaturesOf(partner);
    return partnerSignatures === undefined || partnerSignatures.lineCounts.has(signature);
  };
  const partnersByLine = indexPartnersByLine(occurrences);
  return new Set(
    [...lines].filter((line) => {
      const signature = own.byLine.get(line);
      return (
        signature === undefined || [...(partnersByLine.get(line) ?? [])].some((partner) => repeats(signature, partner))
      );
    })
  );
}

/**
 * The file's clone occurrences with their partner files (`''` for the file itself), partner paths
 * renamed by `renamePartner` so base partners compare with head ones.
 */
function collectOccurrences(
  metrics: CodeMetrics | undefined,
  cross: CrossFileDuplicationMetrics | undefined,
  file: string | undefined,
  renamePartner: (partner: string) => string = (partner) => partner
): CloneOccurrence[] {
  if (metrics === undefined || file === undefined) {
    return [];
  }
  const withinFile = metrics.duplication.duplicateBlockGroups.flatMap((group) =>
    group.map(({ startLine, endLine }) => ({ startLine, endLine, partners: [''] }))
  );
  const crossFile = (cross?.groups ?? []).flatMap((group) => {
    const own = group.occurrences.filter((occurrence) => occurrence.file === file);
    const partners = [
      ...group.files.filter((partner) => partner !== file).map(renamePartner),
      ...(own.length > 1 ? [''] : []),
    ];
    return own.map(({ startLine, endLine }) => ({ startLine, endLine, partners }));
  });
  return [...withinFile, ...crossFile];
}

function toGateInput(
  file: PreparedFile,
  newlyDuplicatedLines: number[],
  headCross: CrossFileDuplicationMetrics | undefined
): GateFileInput {
  return {
    file: file.displayFile,
    baseMetrics: file.baseMetrics,
    headMetrics: file.headFile?.metrics,
    baseFunctionTokens: file.baseFunctionTokens,
    headFunctionTokens: file.headFunctionTokens,
    newlyDuplicatedLines,
    duplicationPartners: collectPartners(file, newlyDuplicatedLines, headCross),
    gated: file.gated,
  };
}

/** Other files sharing a cross-file clone that covers the given lines. */
function collectPartners(
  file: PreparedFile,
  lines: number[],
  headCross: CrossFileDuplicationMetrics | undefined
): string[] {
  const headPath = file.changed.headPath;
  const covers = (occurrence: CrossFileDuplicateOccurrence): boolean =>
    occurrence.file === headPath && lines.some((line) => line >= occurrence.startLine && line <= occurrence.endLine);
  const partners = new Set<string>();
  for (const group of headCross?.groups ?? []) {
    if (group.occurrences.some(covers)) {
      for (const partner of group.files) {
        if (partner !== headPath) {
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
        newlyDuplicatedLines: input.newlyDuplicatedLines,
        duplicationPartners: input.duplicationPartners,
        functions: result.checkedFunctions.filter((fn) => fn.file === input.file),
      }));
  }
  writeStdout(JSON.stringify(report, undefined, 2) + '\n');
}
