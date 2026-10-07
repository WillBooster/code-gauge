import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getErrorMessage, mapConcurrently } from '@willbooster/shared-lib';
import { loadConfig, resolveOptions, type CliOptions, type ResolvedOptions } from './cliConfig.js';
import { keepPaths, loadExclusion, loadRepositoryExclusion } from './exclusion.js';
import {
  isIgnored,
  listChangedFiles,
  listLineHunks,
  listRepositoryFiles,
  resolveMergeBase,
  resolveRepoRoot,
  type ChangedFile,
  type LineHunk,
} from './git.js';
import {
  addCrossFileDuplication,
  configSearchDirectory,
  formatPath,
  getLanguage,
  isWithinDirectory,
  resolveTarget,
  scanListedFiles,
  scanTarget,
  writeStderr,
  writeStdout,
  type ScanResult,
} from './scan.js';
import {
  checkThresholds,
  type BlockLocation,
  type CheckedFile,
  type CheckedDuplication,
  type CheckResult,
  type Violation,
} from './thresholdCheck.js';
import { metricNameOf, resolveLimits, thresholds, type LimitsByLevel } from './thresholds.js';

/** Raw options of the `check` subcommand; every field is undefined unless the flag was passed. */
export interface CheckCliOptions extends CliOptions {
  base?: string;
}

/** The measured files a check covers and the duplication they take part in. */
export interface CheckScope {
  files: CheckedFile[];
  duplication: CheckedDuplication;
  /** Measurement failures of files the check covers. */
  errors: string[];
  warnings: string[];
  /** The directory the files' paths are relative to. */
  root: string;
  mergeBase?: string;
}

/** Caps how many partner locations a duplicated block lists so the report stays scannable. */
const maxListedPartners = 3;

/**
 * Reports every exceeded threshold of the target or, with `base`, of what the working tree changed
 * under it since the merge-base with that ref. Exit codes: 0 no error-level violations, 1 error-level
 * violations, 2 files the check covers could not be measured.
 */
export async function runCheckCommand(
  target: string,
  cliOptions: CheckCliOptions,
  cliLimits: LimitsByLevel
): Promise<void> {
  try {
    const resolvedTarget = resolveTarget(target);
    const config = await loadConfig(cliOptions.config, await configSearchDirectory(resolvedTarget));
    const options = resolveOptions(cliOptions, config);
    const scope = await scanCheckScope(resolvedTarget, cliOptions.base, options);
    const result = checkThresholds(scope.files, scope.duplication, resolveLimits(cliLimits, config.config.thresholds));
    await endFileViolationsAtLastLine(result.violations, scope.root);

    if (options.json) {
      printJsonReport(cliOptions, scope, result);
    } else {
      printTextReport(cliOptions, scope, result);
    }
    if (scope.errors.length > 0) {
      process.exitCode = 2;
    } else if (hasErrors(result.violations)) {
      process.exitCode = 1;
    }
  } catch (error) {
    writeStderr(`Error: ${getErrorMessage(error)}\n`);
    process.exitCode = 2;
  }
}

function hasErrors(violations: readonly Violation[]): boolean {
  return violations.some(({ level }) => level === 'error');
}

/**
 * A file's measured line count includes the empty line after a final line terminator, which is
 * not a line of the file, so file-level violations end at the last line that exists.
 */
async function endFileViolationsAtLastLine(violations: readonly Violation[], root: string): Promise<void> {
  for (const violation of violations.filter(({ kind }) => kind === 'file')) {
    const content = await readFile(path.join(root, violation.file), 'utf8');
    if (/[\n\r]$/u.test(content)) {
      violation.endLine = Math.max(violation.endLine - 1, 1);
    }
  }
}

/**
 * Inside a git repository, the scope is the repository's git-visible files under the target, and
 * duplication is detected against all of them; `base` only narrows the scope to what changed.
 * Outside a repository, where there is no change to narrow to, the target directory is walked.
 */
export async function scanCheckScope(
  resolvedTarget: string,
  base: string | undefined,
  options: ResolvedOptions
): Promise<CheckScope> {
  const canonicalTarget = await realpath(resolvedTarget);
  const targetStat = await stat(canonicalTarget);
  const targetFile = targetStat.isFile() ? canonicalTarget : undefined;
  if (targetFile && !getLanguage(targetFile, options, true)) {
    throw new Error(`${path.basename(targetFile)}: unsupported file type`);
  }
  let repoRoot;
  try {
    repoRoot = await realpath(await resolveRepoRoot(targetFile ? path.dirname(canonicalTarget) : canonicalTarget));
  } catch (error) {
    if (base !== undefined) {
      throw error;
    }
    return await scanDirectoryWalk(canonicalTarget, options);
  }
  return await scanRepository({ repoRoot, canonicalTarget, targetFile }, base, options);
}

async function scanDirectoryWalk(canonicalTarget: string, options: ResolvedOptions): Promise<CheckScope> {
  const searchDirectory = await configSearchDirectory(canonicalTarget);
  const scan = await scanTarget(canonicalTarget, {
    ...options,
    loadExclusion: (absolutePaths) => loadExclusion(searchDirectory, options.exclude, absolutePaths),
  });
  return {
    files: scan.files.map(({ file, metrics }) => ({ file: formatPath(file, scan.displayRoot), metrics })),
    duplication: measureDuplication(scan, options),
    errors: scan.errors,
    warnings: scan.warnings,
    root: scan.displayRoot,
  };
}

interface RepositoryTarget {
  repoRoot: string;
  canonicalTarget: string;
  /** Set when the target is a file, which is measured even when git ignores it or it is excluded. */
  targetFile?: string;
}

/**
 * Measures every git-visible file (tracked or untracked non-ignored) of the repository, so that
 * code copied from outside the target is detected as duplication, and keeps the files under the
 * target: all of them or, with `base`, the changed ones with their line hunks.
 */
async function scanRepository(
  { repoRoot, canonicalTarget, targetFile }: RepositoryTarget,
  base: string | undefined,
  options: ResolvedOptions
): Promise<CheckScope> {
  // Only git-visible files are measured, so a directory git ignores would pass as a check of no
  // files. A directory git lists but whose sources it ignores is not told apart from a repository
  // or package whose only sources are ignored build output, which must pass.
  if (targetFile === undefined && canonicalTarget !== repoRoot && (await isIgnored(repoRoot, canonicalTarget))) {
    throw new Error(
      `${formatPath(canonicalTarget, repoRoot)}: git ignores this directory, so no file in it is checked; target a file to check it regardless`
    );
  }
  const repositoryFiles = await listRepositoryFiles(repoRoot);
  const explicitFiles = new Set(targetFile === undefined ? [] : [targetFile]);
  const unlistedTarget =
    targetFile !== undefined && !repositoryFiles.has(formatPath(targetFile, repoRoot))
      ? formatPath(targetFile, repoRoot)
      : undefined;
  if (unlistedTarget !== undefined) {
    repositoryFiles.add(unlistedTarget);
  }
  const exclusion = keepPaths(await loadRepositoryExclusion(repoRoot, repositoryFiles, options.exclude), explicitFiles);
  // Scan errors start with the file or directory they concern.
  const targetPath = formatPath(canonicalTarget, repoRoot);
  const scan = await scanListedFiles(
    repoRoot,
    repositoryFiles,
    { ...options, loadExclusion: () => Promise.resolve(exclusion) },
    explicitFiles,
    targetFile === undefined && canonicalTarget !== repoRoot ? targetPath : ''
  );
  const duplication = measureDuplication(scan, options);
  const isInTarget = (relativePath: string): boolean =>
    isWithinDirectory(path.join(repoRoot, relativePath), canonicalTarget);
  const measuredFiles = scan.files.map(({ file, metrics }) => ({ file: formatPath(file, repoRoot), metrics }));
  let files = measuredFiles.filter(({ file }) => isInTarget(file));
  let isCovered = (error: string): boolean =>
    canonicalTarget === repoRoot || error.startsWith(`${targetPath}/`) || error.startsWith(`${targetPath}:`);
  let mergeBase;
  if (base !== undefined) {
    mergeBase = await resolveMergeBase(repoRoot, base);
    const changedFiles = await listChangedFiles(repoRoot, mergeBase);
    // A targeted file git does not list has no diff; all of it counts as added.
    if (unlistedTarget !== undefined) {
      changedFiles.push({ status: 'added', headPath: unlistedTarget });
    }
    const changesInTarget = changedFiles.filter(({ status, headPath }) => status !== 'deleted' && isInTarget(headPath));
    files = await attachHunks(measuredFiles, changesInTarget, repoRoot, mergeBase);
    isCovered = (error) => changesInTarget.some(({ headPath }) => error.startsWith(`${headPath}:`));
  }
  return {
    files,
    duplication,
    ...partitionErrors(scan, isCovered),
    root: repoRoot,
    mergeBase,
  };
}

/** Only a failure on a file the check covers leaves it incomplete; the others are warnings. */
function partitionErrors(
  scan: ScanResult,
  isCovered: (error: string) => boolean
): Pick<CheckScope, 'errors' | 'warnings'> {
  return {
    errors: scan.errors.filter((error) => isCovered(error)),
    warnings: [...scan.warnings, ...scan.errors.filter((error) => !isCovered(error))],
  };
}

/** The measured changed files with their line hunks against the merge-base. */
async function attachHunks(
  measuredFiles: readonly CheckedFile[],
  changedFiles: readonly ChangedFile[],
  repoRoot: string,
  mergeBase: string
): Promise<CheckedFile[]> {
  const measuredByPath = new Map(measuredFiles.map((measured) => [measured.file, measured]));
  const files = await mapConcurrently(changedFiles, os.availableParallelism() * 2, async (changed) => {
    const measured = measuredByPath.get(changed.headPath);
    // A changed file the scan left out (unsupported, excluded, or failed) has nothing to check.
    if (measured === undefined) {
      return [];
    }
    const { metrics } = measured;
    const wholeFile: LineHunk = { headStart: 1, headCount: metrics.lines.total };
    const hunks =
      changed.basePath === undefined
        ? [wholeFile]
        : await listLineHunks(repoRoot, mergeBase, changed.basePath, changed.headPath);
    if (metrics.language === 'python' && hunks.some(({ headCount }) => headCount === 0)) {
      anchorDeletionsToCode(hunks, await readFile(path.join(repoRoot, changed.headPath), 'utf8'));
    }
    return [{ ...measured, hunks }];
  });
  return files.flat();
}

/**
 * Moves each pure deletion up to the last code line before it. A Python function ends at its last
 * statement, so the blank and comment-only lines left above a deleted tail lie outside the span the
 * deletion shortened; anchored to that statement, the deletion counts as touching the function.
 */
function anchorDeletionsToCode(hunks: LineHunk[], content: string): void {
  const lines = content.split(/\r\n|\n|\r/u);
  for (const hunk of hunks) {
    if (hunk.headCount > 0) continue;
    while (hunk.headStart > 0 && /^\s*(?:#.*)?$/u.test(lines[hunk.headStart - 1] ?? '')) {
      hunk.headStart -= 1;
    }
  }
}

/** A run-wide failure (a missing target or native addon) leaves nothing to check. */
function measureDuplication(scan: ScanResult, options: ResolvedOptions): CheckedDuplication {
  if (scan.fatalError) {
    throw new Error(scan.fatalError);
  }
  addCrossFileDuplication(scan, options);
  return {
    crossFile: scan.crossFileDuplication,
    minSimilarityPercent: options.duplication.minSimilarityPercent,
  };
}

function printTextReport(cliOptions: CheckCliOptions, scope: CheckScope, result: CheckResult): void {
  const { violations } = result;
  const checked = `${scope.files.length} ${cliOptions.base === undefined ? '' : 'changed '}files, ${result.checkedFunctionCount} functions checked${describeBase(cliOptions, scope)}`;
  if (scope.errors.length > 0) {
    // Unmeasured files were not checked, so "no violations" would be vacuous; never claim a pass.
    writeStdout(
      `Check could not complete: ${scope.errors.length} measurement failures (details on stderr); ${describeCounts(violations)} in the measured files (${checked}).\n`
    );
  } else if (violations.length === 0) {
    writeStdout(`No threshold violations: ${checked}.\n`);
  } else {
    writeStdout(`Threshold violations: ${describeCounts(violations)} (${checked}).\n`);
  }
  for (const violation of violations) {
    writeStdout(`${formatViolation(violation)}\n`);
  }

  const violatedMetrics = new Set(violations.flatMap(({ exceeded }) => exceeded.map(({ metric }) => metric)));
  const violatedThresholds = thresholds.filter((threshold) => violatedMetrics.has(metricNameOf(threshold)));
  if (violatedThresholds.length > 0) {
    writeStdout('\nHow to fix:\n');
    for (const { label, hint } of violatedThresholds) {
      writeStdout(`- ${label}: ${hint}\n`);
    }
  }

  for (const warning of scope.warnings) {
    writeStderr(`Warning: ${warning}\n`);
  }
  for (const error of scope.errors) {
    writeStderr(`Error: ${error}\n`);
  }
}

function describeBase(cliOptions: CheckCliOptions, scope: CheckScope): string {
  return scope.mergeBase === undefined ? '' : `; base ${cliOptions.base}, merge-base ${scope.mergeBase.slice(0, 12)}`;
}

function describeCounts(violations: readonly Violation[]): string {
  const counts = countViolations(violations);
  return `${counts.errorViolationCount} errors, ${counts.warningViolationCount} warnings (${counts.functionViolationCount} functions, ${counts.fileViolationCount} files, ${counts.duplicationViolationCount} duplicated blocks)`;
}

function countViolations(violations: readonly Violation[]): {
  violationCount: number;
  errorViolationCount: number;
  warningViolationCount: number;
  functionViolationCount: number;
  fileViolationCount: number;
  duplicationViolationCount: number;
} {
  const count = (kind: Violation['kind']): number => violations.filter((violation) => violation.kind === kind).length;
  const errorViolationCount = violations.filter(({ level }) => level === 'error').length;
  return {
    violationCount: violations.length,
    errorViolationCount,
    warningViolationCount: violations.length - errorViolationCount,
    functionViolationCount: count('function'),
    fileViolationCount: count('file'),
    duplicationViolationCount: count('duplication'),
  };
}

/** One violation as a single line: its level, the location, then every limit it exceeds. */
function formatViolation(violation: Violation): string {
  const labelByMetric = new Map(thresholds.map((threshold) => [metricNameOf(threshold), threshold.label]));
  const exceeded = violation.exceeded
    .map(({ metric, value, level, limit }) => {
      // Halstead values are fractional; rounding up keeps a violating value above the printed maximum.
      const roundedValue = Math.ceil(value * 10) / 10;
      const levelPrefix = level === violation.level ? '' : `${level} `;
      // A duplicated block violates from its limit on, so the largest allowed code-line count is
      // the last whole number below it; a limit of 0 allows none.
      const maxAllowed = violation.kind === 'duplication' ? Math.max(Math.ceil(limit) - 1, 0) : limit;
      const blocks = metric === 'functionCognitiveComplexity' ? describeLargestBlocks(violation) : '';
      return `${labelByMetric.get(metric)} ${roundedValue} (${levelPrefix}max ${maxAllowed}${blocks})`;
    })
    .join(', ');
  return `${violation.level}: ${describeViolation(violation, exceeded)}`;
}

function describeLargestBlocks({ largestBlocks = [] }: Violation): string {
  const blocks = largestBlocks.map(
    ({ startLine, endLine, name, cognitiveComplexity }) =>
      `L${startLine}${endLine === startLine ? '' : `-${endLine}`}${name ? ` ${toOneLine(name)}` : ''} ${cognitiveComplexity}`
  );
  return blocks.length > 0 ? `; largest parts ${blocks.join(', ')}` : '';
}

function describeViolation(violation: Violation, exceeded: string): string {
  switch (violation.kind) {
    case 'file': {
      return `${violation.file}: ${exceeded}`;
    }
    case 'function': {
      return `${formatLocation(violation)} ${toOneLine(violation.name ?? '')}: ${exceeded}`;
    }
    case 'duplication': {
      const partners = (violation.partners ?? []).map((partner) => formatLocation(partner));
      const listed = [...partners.slice(0, maxListedPartners), ...(partners.length > maxListedPartners ? ['...'] : [])];
      return `${formatLocation(violation)}: ${exceeded}${listed.length > 0 ? `, also at ${listed.join(', ')}` : ''}`;
    }
  }
}

/** A computed name can span lines in the source; the report keeps one line per function. */
function toOneLine(name: string): string {
  return name.replaceAll(/\s*[\n\r]\s*/gu, ' ');
}

function formatLocation({ file, startLine, endLine }: BlockLocation): string {
  return `${file}:${startLine}-${endLine}`;
}

function printJsonReport(cliOptions: CheckCliOptions, scope: CheckScope, result: CheckResult): void {
  writeStdout(
    JSON.stringify(
      {
        passed: !hasErrors(result.violations) && scope.errors.length === 0,
        base: cliOptions.base,
        mergeBase: scope.mergeBase,
        summary: {
          ...countViolations(result.violations),
          checkedFileCount: scope.files.length,
          checkedFunctionCount: result.checkedFunctionCount,
        },
        violations: result.violations,
        errors: scope.errors,
        warnings: scope.warnings,
      },
      undefined,
      2
    ) + '\n'
  );
}
