import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getErrorMessage, mapConcurrently } from '@willbooster/shared-lib';

import { isDirectiveLine, parseAllowDirectives } from './allowDirectives.js';
import { type CliOptions, loadConfig, type ResolvedOptions, resolveOptions } from './cliConfig.js';
import { keepPaths, loadExclusion, loadRepositoryExclusion } from './exclusion.js';
import {
  type ChangedFile,
  isIgnored,
  type LineHunk,
  listChangedFiles,
  listLineHunks,
  listRepositoryFiles,
  readFileAt,
  resolveMergeBase,
  resolveRepoRoot,
} from './git.js';
import { measureCode } from './metrics.js';
import {
  addCrossFileDuplication,
  configSearchDirectory,
  formatPath,
  getLanguage,
  isTestFileBelow,
  isWithinDirectory,
  resolveTarget,
  scanListedFiles,
  type ScanResult,
  scanTarget,
  writeStderr,
  writeStdout,
} from './scan.js';
import { measureRepositoryTestShare, type RepositoryTestShareInput } from './testShare.js';
import {
  type BlockLocation,
  type CheckedDuplication,
  type CheckedFile,
  type CheckResult,
  checkTestShare,
  checkThresholds,
  type CodeViolation,
  compareStrings,
  type LocatedDirectiveProblem,
  type ProjectViolation,
  type Violation,
} from './thresholdCheck.js';
import {
  levels,
  type LimitsByLevel,
  metricNameOf,
  resolveLimits,
  type TestShare,
  testShareThreshold,
  thresholds,
} from './thresholds.js';

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
  /** The test share of the checked directory of a repository; absent when no limit applies to it. */
  testShare?: TestShare;
  /** The checked directory, relative to `root`; `.` for the root itself. */
  checkedDirectory: string;
}

/** The check's result with the violations of the whole project, which come first. */
type ReportedResult = Omit<CheckResult, 'violations'> & { violations: Violation[] };

/** Caps how many partner locations a duplicated block lists so the report stays scannable. */
const maxListedPartners = 3;

/**
 * Reports every exceeded threshold of the target or, with `base`, of what the working tree changed
 * under it since the merge-base with that ref. Exit codes: 0 neither error-level violations nor
 * directive problems, 1 either of them, 2 files the check covers could not be measured.
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
    const limitsOf = resolveLimits(cliLimits, config.config.thresholds);
    const projectLimits = limitsOf('');
    const scope = await scanCheckScope(resolvedTarget, cliOptions.base, options, {
      measuresTestShare: levels.some((level) => Number.isFinite(projectLimits[level][testShareThreshold.key])),
    });
    const files = await attachAllowDirectives(scope.files, scope.root);
    const codeResult = checkThresholds(files, scope.duplication, limitsOf);
    const projectViolation = scope.testShare && checkTestShare(scope.testShare, scope.checkedDirectory, projectLimits);
    const result: ReportedResult = {
      ...codeResult,
      violations: withProjectViolation(codeResult.violations, projectViolation),
    };
    await endFileViolationsAtLastLine(codeResult.violations, scope.root);

    if (options.json) {
      printJsonReport(cliOptions, scope, result);
    } else {
      printTextReport(cliOptions, scope, result);
    }
    if (scope.errors.length > 0) {
      process.exitCode = 2;
    } else if (hasErrors(result)) {
      process.exitCode = 1;
    }
  } catch (error) {
    writeStderr(`Error: ${getErrorMessage(error)}\n`);
    process.exitCode = 2;
  }
}

async function attachAllowDirectives(files: readonly CheckedFile[], root: string): Promise<CheckedFile[]> {
  return await mapConcurrently(files, os.availableParallelism() * 2, async (checked) => ({
    ...checked,
    allowDirectives: parseAllowDirectives(await readFile(path.join(root, checked.file), 'utf8'), checked.metrics),
  }));
}

function hasErrors({ violations, directiveProblems }: ReportedResult): boolean {
  return directiveProblems.length > 0 || violations.some(({ level }) => level === 'error');
}

/**
 * A file's measured line count includes the empty line after a final line terminator, which is
 * not a line of the file, so file-level violations end at the last line that exists.
 */
async function endFileViolationsAtLastLine(violations: readonly CodeViolation[], root: string): Promise<void> {
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
  options: ResolvedOptions,
  { measuresTestShare = false }: { measuresTestShare?: boolean } = {}
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
  return await scanRepository(
    {
      repoRoot,
      canonicalTarget,
      targetFile,
      measuresTestShare: measuresTestShare && !targetFile,
    },
    base,
    options
  );
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
    checkedDirectory: '.',
  };
}

interface RepositoryTarget {
  repoRoot: string;
  canonicalTarget: string;
  /** Set when the target is a file, which is measured even when git ignores it or it is excluded. */
  targetFile?: string;
  /** Whether the share of test code is measured: a limit applies to it and the target is a directory. */
  measuresTestShare: boolean;
}

/**
 * Measures every git-visible file (tracked or untracked non-ignored) of the repository, so that
 * code copied from outside the target is detected as duplication, and keeps the files under the
 * target: all of them or, with `base`, the changed ones with their line hunks.
 */
async function scanRepository(
  { repoRoot, canonicalTarget, targetFile, measuresTestShare }: RepositoryTarget,
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
  const { files: repositoryFiles, warnings: listingWarnings, sparse } = await listRepositoryFiles(repoRoot);
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
  // The directory whose files the scan judges by their path below it; empty for the root or a file.
  const targetDirectory = targetFile === undefined && canonicalTarget !== repoRoot ? targetPath : '';
  const scan = await scanListedFiles(
    repoRoot,
    repositoryFiles,
    { ...options, loadExclusion: () => Promise.resolve(exclusion) },
    explicitFiles,
    targetDirectory
  );
  const duplication = measureDuplication(scan, options);
  scan.warnings.push(...listingWarnings);
  const isInTarget = (relativePath: string): boolean =>
    isWithinDirectory(path.join(repoRoot, relativePath), canonicalTarget);
  const measuredFiles = scan.files.map(({ file, metrics }) => ({ file: formatPath(file, repoRoot), metrics }));
  const isInTargetError = (error: string): boolean =>
    canonicalTarget === repoRoot || concernsTarget(error, targetPath, targetFile !== undefined);
  const change = base === undefined ? undefined : await resolveChange(repoRoot, base, unlistedTarget);
  // A change that touches no test under the target is not blamed for a share it did not raise.
  const sharesProject =
    decideTestShare(measuresTestShare, sparse, scan.warnings) &&
    (change === undefined || touchesTests(change, repositoryFiles, targetDirectory, options));
  const { files, isCovered } =
    change === undefined
      ? { files: measuredFiles.filter(({ file }) => isInTarget(file)), isCovered: isInTargetError }
      : await narrowToChange(change, measuredFiles, repoRoot, isInTarget, sharesProject ? isInTargetError : undefined);
  const scope = {
    files,
    duplication,
    ...partitionErrors(scan, isCovered),
    root: repoRoot,
    mergeBase: change?.mergeBase,
    checkedDirectory: targetDirectory || '.',
  };
  return await addTestShare(
    scope,
    sharesProject
      ? {
          repoRoot,
          repositoryFiles,
          targetPath: targetDirectory,
          exclusion,
          options,
          measuredFiles,
        }
      : undefined,
    scan.errors.some((error) => isInTargetError(error))
  );
}

/** What the working tree changed since a merge-base. */
interface Change {
  mergeBase: string;
  changedFiles: ChangedFile[];
}

/**
 * The changed files under the target with their hunks, and the failures that leave the check
 * incomplete: those of changed files, or `coversAll` when the share counts every file.
 */
async function narrowToChange(
  change: Change,
  measuredFiles: readonly CheckedFile[],
  repoRoot: string,
  isInTarget: (relativePath: string) => boolean,
  coversAll: ((error: string) => boolean) | undefined
): Promise<{ files: CheckedFile[]; isCovered: (error: string) => boolean }> {
  const changesInTarget = change.changedFiles.filter(
    ({ status, headPath }) => status !== 'deleted' && isInTarget(headPath)
  );
  return {
    files: await attachHunks(measuredFiles, changesInTarget, repoRoot, change.mergeBase),
    isCovered: coversAll ?? ((error) => changesInTarget.some(({ headPath }) => error.startsWith(`${headPath}:`))),
  };
}

/** The change since the merge-base with `base`. */
async function resolveChange(repoRoot: string, base: string, unlistedTarget: string | undefined): Promise<Change> {
  const mergeBase = await resolveMergeBase(repoRoot, base);
  const changedFiles = await listChangedFiles(repoRoot, mergeBase);
  // A targeted file git does not list has no diff; all of it counts as added.
  if (unlistedTarget !== undefined) {
    changedFiles.push({ status: 'added', headPath: unlistedTarget });
  }
  return { mergeBase, changedFiles };
}

/**
 * Whether the change leaves a test it touched under the target among the files the check lists
 * (added, modified, renamed to, or untracked), so a change that only deletes or moves tests out is
 * not asked to prune further. The listing, not git's status, tells a removal: git also reports a
 * path it cannot reach as deleted, which the listing keeps for the check to measure.
 */
function touchesTests(
  change: Change,
  repositoryFiles: ReadonlySet<string>,
  targetDirectory: string,
  options: ResolvedOptions
): boolean {
  // Both sides of a rename: git pairs a path it cannot reach, which the listing keeps, with a copy.
  return change.changedFiles.some(({ basePath, headPath }) =>
    [basePath ?? headPath, headPath].some(
      (file) =>
        repositoryFiles.has(file) &&
        (targetDirectory === '' || file.startsWith(`${targetDirectory}/`)) &&
        isTestFileBelow(file, targetDirectory, options)
    )
  );
}

/**
 * Whether an error, which starts with the path it concerns, concerns the target: a targeted file's
 * path ends at a colon, and a file under a targeted directory continues past its slash (a sibling
 * may hold a colon).
 */
function concernsTarget(error: string, targetPath: string, isFile: boolean): boolean {
  return error.startsWith(isFile ? `${targetPath}:` : `${targetPath}/`);
}

/**
 * Whether the share is measured. A sparse checkout leaves part of the project out of the working
 * tree, so neither its share of test code nor what a change adds to it can be: a warning says so.
 */
function decideTestShare(measuresTestShare: boolean, sparse: boolean, warnings: string[]): boolean {
  if (measuresTestShare && sparse) {
    warnings.push('the share of test code is not measured in a sparse checkout, which leaves part of the project out');
  }
  return measuresTestShare && !sparse;
}

/** Adds the test share, when every file under the target was measured, and the test files that could not be, to a scope. */
async function addTestShare(
  scope: CheckScope,
  input: RepositoryTestShareInput | undefined,
  missesProductionCode: boolean
): Promise<CheckScope> {
  if (input === undefined) {
    return scope;
  }
  const { share, errors } = await measureRepositoryTestShare(input);
  // A share of partial totals would name tests to delete that the whole project admits.
  const complete = !missesProductionCode && errors.length === 0;
  return { ...scope, testShare: complete ? share : undefined, errors: [...scope.errors, ...errors] };
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
    if (changed.basePath !== undefined) {
      await markDeletedDirectives(hunks, metrics.language, () =>
        readFileAt(repoRoot, mergeBase, changed.basePath ?? '')
      );
    }
    if (metrics.language === 'python' && hunks.some(({ headCount }) => headCount === 0)) {
      anchorDeletionsToCode(hunks, await readFile(path.join(repoRoot, changed.headPath), 'utf8'));
    }
    return [{ ...measured, hunks }];
  });
  return files.flat();
}

/**
 * Marks the hunks deleting a directive. A deleted line reads like one when it holds the directive
 * syntax, but only a comment-only line of the base file is one, not a line of a multi-line string,
 * so the base file is measured when a deleted line reads like one.
 */
async function markDeletedDirectives(
  hunks: LineHunk[],
  language: string,
  readBase: () => Promise<string>
): Promise<void> {
  const candidates = hunks.filter(({ deletedLines }) => deletedLines?.some((line) => isDirectiveLine(line)));
  if (candidates.length === 0) return;
  const baseCodeLines = new Set(measureCode(await readBase(), { language }).codeLineNumbers);
  for (const hunk of candidates) {
    hunk.deletesDirective = (hunk.deletedLines ?? []).some(
      (line, index) => isDirectiveLine(line) && !baseCodeLines.has((hunk.baseStart ?? 0) + index)
    );
  }
}

/**
 * Moves each pure deletion up to the last code line or directive before it. A Python function ends at its last
 * statement, so the blank and comment-only lines left above a deleted tail lie outside the span the
 * deletion shortened; anchored to that statement, the deletion counts as touching the function.
 */
function anchorDeletionsToCode(hunks: LineHunk[], content: string): void {
  const lines = content.split(/\r\n|\n|\r/u);
  for (const hunk of hunks) {
    if (hunk.headCount > 0) continue;
    while (hunk.headStart > 0 && isPassedByAnchoring(lines[hunk.headStart - 1] ?? '')) {
      hunk.headStart -= 1;
    }
  }
}

// A deletion right below a directive stays there, where it may have attached or detached it.
function isPassedByAnchoring(line: string): boolean {
  return /^\s*(?:#.*)?$/u.test(line) && !isDirectiveLine(line);
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

function printTextReport(cliOptions: CheckCliOptions, scope: CheckScope, result: ReportedResult): void {
  const { violations, directiveProblems } = result;
  const counts = `${describeCounts(violations)}${directiveProblems.length > 0 ? `, ${directiveProblems.length} directive errors` : ''}`;
  const allowed =
    result.allowedLimitCount > 0 ? `, ${result.allowedLimitCount} exceeded limits allowed by directives` : '';
  const checked = `${scope.files.length} ${cliOptions.base === undefined ? '' : 'changed '}files, ${result.checkedFunctionCount} functions checked${allowed}${describeBase(cliOptions, scope)}`;
  if (scope.errors.length > 0) {
    // Unmeasured files were not checked, so "no violations" would be vacuous; never claim a pass.
    writeStdout(
      `Check could not complete: ${scope.errors.length} measurement failures (details on stderr); ${counts} in the measured files (${checked}).\n`
    );
  } else if (violations.length === 0) {
    writeStdout(
      directiveProblems.length === 0
        ? `No threshold violations: ${checked}.\n`
        : `Directive errors: ${directiveProblems.length} (${checked}).\n`
    );
  } else {
    writeStdout(`Threshold violations: ${counts} (${checked}).\n`);
  }
  // Directive problems are errors, so they join the error-level violations, ordered by path and line.
  const errorLines = [
    ...violations
      .filter(({ level }) => level === 'error')
      .map((violation) => ({
        file: violation.file,
        line: firstLineOf(violation),
        text: formatViolation(violation, scope.mergeBase !== undefined),
      })),
    ...directiveProblems.map((problem) => ({ ...problem, text: formatDirectiveProblem(problem) })),
  ].toSorted((left, right) => compareStrings(left.file, right.file) || left.line - right.line);
  const warningLines = violations
    .filter(({ level }) => level === 'warning')
    .map((violation) => formatViolation(violation, scope.mergeBase !== undefined));
  for (const text of [...errorLines.map(({ text }) => text), ...warningLines]) {
    writeStdout(`${text}\n`);
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

/** The project violation leads the violations of its level, which keep the errors first. */
function withProjectViolation(
  violations: readonly CodeViolation[],
  projectViolation: ProjectViolation | undefined
): Violation[] {
  if (projectViolation === undefined) {
    return [...violations];
  }
  const index = projectViolation.level === 'error' ? 0 : violations.findIndex(({ level }) => level !== 'error');
  const at = index === -1 ? violations.length : index;
  return [...violations.slice(0, at), projectViolation, ...violations.slice(at)];
}

/** A violation of the whole project precedes the lines of its directory. */
function firstLineOf(violation: Violation): number {
  return violation.kind === 'project' ? 0 : violation.startLine;
}

function formatDirectiveProblem({ file, line, message }: LocatedDirectiveProblem): string {
  return `error: ${file}:${line}: ${message}`;
}

function describeBase(cliOptions: CheckCliOptions, scope: CheckScope): string {
  return scope.mergeBase === undefined ? '' : `; base ${cliOptions.base}, merge-base ${scope.mergeBase.slice(0, 12)}`;
}

function describeCounts(violations: readonly Violation[]): string {
  const counts = countViolations(violations);
  const project = counts.projectViolationCount > 0 ? `, ${counts.projectViolationCount} project` : '';
  return `${counts.errorViolationCount} errors, ${counts.warningViolationCount} warnings (${counts.functionViolationCount} functions, ${counts.fileViolationCount} files, ${counts.duplicationViolationCount} duplicated blocks${project})`;
}

function countViolations(violations: readonly Violation[]): {
  violationCount: number;
  errorViolationCount: number;
  warningViolationCount: number;
  functionViolationCount: number;
  fileViolationCount: number;
  duplicationViolationCount: number;
  projectViolationCount: number;
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
    projectViolationCount: count('project'),
  };
}

/** One violation as a single line: its level, the location, then every limit it exceeds. */
function formatViolation(violation: Violation, checksChange: boolean): string {
  const exceeded = violation.exceeded
    .map(({ metric, label, value, level, limit }) => {
      // Halstead values are fractional; rounding up keeps a violating value above the printed maximum.
      const roundedValue = Math.ceil(value * 10) / 10;
      const levelPrefix = level === violation.level ? '' : `${level} `;
      // A duplicated block violates from its limit on, so the largest allowed code-line count is
      // the last whole number below it; a limit of 0 allows none.
      const maxAllowed = violation.kind === 'duplication' ? Math.max(Math.ceil(limit) - 1, 0) : limit;
      const blocks =
        metric === 'functionCognitiveComplexity' && violation.kind === 'function'
          ? describeLargestBlocks(violation)
          : '';
      return `${label} ${roundedValue} (${levelPrefix}max ${maxAllowed}${blocks})`;
    })
    .join(', ');
  return `${violation.level}: ${describeViolation(violation, exceeded, checksChange)}`;
}

function describeLargestBlocks({ largestBlocks = [] }: CodeViolation): string {
  const blocks = largestBlocks.map(
    ({ startLine, endLine, name, cognitiveComplexity }) =>
      `L${startLine}${endLine === startLine ? '' : `-${endLine}`}${name ? ` ${toOneLine(name)}` : ''} ${cognitiveComplexity}`
  );
  return blocks.length > 0 ? `; largest parts ${blocks.join(', ')}` : '';
}

function describeViolation(violation: Violation, exceeded: string, checksChange: boolean): string {
  switch (violation.kind) {
    case 'project': {
      const remedy = checksChange
        ? `this change edits tests while test code exceeds ${violation.exceeded[0]?.limit}% of production code: delete or merge tests so the change adds no test code`
        : `delete or merge ${violation.excessTestNcss} test NCSS`;
      return `${violation.file}: ${exceeded}, test NCSS ${violation.testNcss} of production NCSS ${violation.productionNcss}; ${remedy}`;
    }
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

function printJsonReport(cliOptions: CheckCliOptions, scope: CheckScope, result: ReportedResult): void {
  writeStdout(
    JSON.stringify(
      {
        passed: !hasErrors(result) && scope.errors.length === 0,
        base: cliOptions.base,
        mergeBase: scope.mergeBase,
        summary: {
          ...countViolations(result.violations),
          checkedFileCount: scope.files.length,
          checkedFunctionCount: result.checkedFunctionCount,
          allowedLimitCount: result.allowedLimitCount,
        },
        violations: result.violations,
        directiveProblems: result.directiveProblems,
        errors: scope.errors,
        warnings: scope.warnings,
      },
      undefined,
      2
    ) + '\n'
  );
}
