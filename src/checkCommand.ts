import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getErrorMessage, mapConcurrently } from '@willbooster/shared-lib';
import { loadConfig, resolveOptions, type CliOptions, type ResolvedOptions } from './cliConfig.js';
import type { CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import { keepPaths, loadExclusion, loadRepositoryExclusion } from './exclusion.js';
import {
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
  type CheckResult,
  type Violation,
} from './thresholdCheck.js';
import { metricNameOf, resolveLimits, thresholds, type Limits } from './thresholds.js';

/** Raw options of the `check` subcommand; every field is undefined unless the flag was passed. */
export interface CheckCliOptions extends CliOptions {
  base?: string;
}

/** The measured files a check covers and the duplication they take part in. */
interface CheckScope {
  files: CheckedFile[];
  crossFileDuplication?: CrossFileDuplicationMetrics;
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
 * since the merge-base with that ref. Exit codes: 0 no violations, 1 violations, 2 files the check
 * covers could not be measured.
 */
export async function runCheckCommand(target: string, cliOptions: CheckCliOptions, cliLimits: Limits): Promise<void> {
  try {
    const resolvedTarget = resolveTarget(target);
    const config = await loadConfig(cliOptions.config, await configSearchDirectory(resolvedTarget));
    const options = resolveOptions(cliOptions, config);
    const scope =
      cliOptions.base === undefined
        ? await scanWholeTarget(resolvedTarget, options)
        : await scanChange(resolvedTarget, cliOptions.base, options);
    const result = checkThresholds(
      scope.files,
      scope.crossFileDuplication,
      resolveLimits(cliLimits, config.config.thresholds)
    );
    await endFileViolationsAtLastLine(result.violations, scope.root);

    if (options.json) {
      printJsonReport(cliOptions, scope, result);
    } else {
      printTextReport(cliOptions, scope, result);
    }
    if (scope.errors.length > 0) {
      process.exitCode = 2;
    } else if (result.violations.length > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    writeStderr(`Error: ${getErrorMessage(error)}\n`);
    process.exitCode = 2;
  }
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

async function scanWholeTarget(resolvedTarget: string, options: ResolvedOptions): Promise<CheckScope> {
  const searchDirectory = await configSearchDirectory(resolvedTarget);
  const scan = await scanTarget(resolvedTarget, {
    ...options,
    loadExclusion: (absolutePaths) => loadExclusion(searchDirectory, options.exclude, absolutePaths),
  });
  const crossFileDuplication = measureDuplication(scan, options);
  return {
    files: scan.files.map(({ file, metrics }) => ({ file: formatPath(file, scan.displayRoot), metrics })),
    crossFileDuplication,
    errors: scan.errors,
    warnings: scan.warnings,
    root: scan.displayRoot,
  };
}

/**
 * Measures every git-visible file (tracked or untracked non-ignored) of the repository, so that
 * code the change pasted from unchanged files is detected as duplication, and keeps the changed
 * ones under the target with their line hunks against the merge-base.
 */
async function scanChange(resolvedTarget: string, base: string, options: ResolvedOptions): Promise<CheckScope> {
  const canonicalTarget = await realpath(resolvedTarget);
  const targetStat = await stat(canonicalTarget);
  const targetFile = targetStat.isFile() ? canonicalTarget : undefined;
  if (targetFile && !getLanguage(targetFile, options, true)) {
    throw new Error(`${path.basename(targetFile)}: unsupported file type`);
  }
  const repoRoot = await realpath(await resolveRepoRoot(targetFile ? path.dirname(canonicalTarget) : canonicalTarget));
  const mergeBase = await resolveMergeBase(repoRoot, base);
  const [changedFiles, repositoryFiles] = await Promise.all([
    listChangedFiles(repoRoot, mergeBase),
    listRepositoryFiles(repoRoot),
  ]);
  // A targeted file git does not list (an ignored one) is still checked, as an addition.
  const unlistedTarget = targetFile && path.relative(repoRoot, targetFile);
  if (unlistedTarget !== undefined && !repositoryFiles.has(unlistedTarget)) {
    repositoryFiles.add(unlistedTarget);
    changedFiles.push({ status: 'added', headPath: unlistedTarget });
  }

  // An explicitly targeted file is measured even when excluded, like the ranking command's.
  const explicitFiles = new Set(targetFile === undefined ? [] : [targetFile]);
  const exclusion = keepPaths(await loadRepositoryExclusion(repoRoot, repositoryFiles, options.exclude), explicitFiles);
  const scan = await scanListedFiles(
    repoRoot,
    repositoryFiles,
    { ...options, loadExclusion: () => Promise.resolve(exclusion) },
    explicitFiles
  );
  const crossFileDuplication = measureDuplication(scan, options);

  const changesInTarget = changedFiles.filter(
    ({ status, headPath }) => status !== 'deleted' && isWithin(path.join(repoRoot, headPath), canonicalTarget)
  );
  // Only a failure on a changed file under the target leaves the change unchecked.
  const isCovered = (error: string): boolean =>
    changesInTarget.some(({ headPath }) => error.startsWith(`${headPath}:`));
  return {
    files: await attachHunks(scan, changesInTarget, repoRoot, mergeBase),
    crossFileDuplication,
    errors: scan.errors.filter((error) => isCovered(error)),
    warnings: [...scan.warnings, ...scan.errors.filter((error) => !isCovered(error))],
    root: repoRoot,
    mergeBase,
  };
}

/** The measured changed files with their line hunks against the merge-base. */
async function attachHunks(
  scan: ScanResult,
  changedFiles: readonly ChangedFile[],
  repoRoot: string,
  mergeBase: string
): Promise<CheckedFile[]> {
  const metricsByPath = new Map(scan.files.map(({ file, metrics }) => [formatPath(file, repoRoot), metrics]));
  const files = await mapConcurrently(changedFiles, os.availableParallelism() * 2, async (changed) => {
    const metrics = metricsByPath.get(changed.headPath);
    // A changed file the scan left out (unsupported, excluded, or failed) has nothing to check.
    if (metrics === undefined) {
      return [];
    }
    const wholeFile: LineHunk = { baseStart: 0, baseCount: 0, headStart: 1, headCount: metrics.lines.total };
    const hunks =
      changed.basePath === undefined
        ? [wholeFile]
        : await listLineHunks(repoRoot, mergeBase, changed.basePath, changed.headPath);
    return [{ file: changed.headPath, metrics, hunks }];
  });
  return files.flat();
}

/** A run-wide failure (a missing target or native addon) leaves nothing to check. */
function measureDuplication(scan: ScanResult, options: ResolvedOptions): CrossFileDuplicationMetrics | undefined {
  if (scan.fatalError) {
    throw new Error(scan.fatalError);
  }
  addCrossFileDuplication(scan, options);
  return scan.crossFileDuplication;
}

function isWithin(candidate: string, target: string): boolean {
  const relative = path.relative(target, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`));
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
  return `${counts.violationCount} violations (${counts.functionViolationCount} functions, ${counts.fileViolationCount} files, ${counts.duplicationViolationCount} duplicated blocks)`;
}

function countViolations(violations: readonly Violation[]): {
  violationCount: number;
  functionViolationCount: number;
  fileViolationCount: number;
  duplicationViolationCount: number;
} {
  const count = (kind: Violation['kind']): number => violations.filter((violation) => violation.kind === kind).length;
  return {
    violationCount: violations.length,
    functionViolationCount: count('function'),
    fileViolationCount: count('file'),
    duplicationViolationCount: count('duplication'),
  };
}

/** One violation as a single line: the location, then every limit it exceeds. */
function formatViolation(violation: Violation): string {
  const labelByMetric = new Map(thresholds.map((threshold) => [metricNameOf(threshold), threshold.label]));
  const exceeded = violation.exceeded
    .map(
      ({ metric, value, limit }) =>
        // Halstead volume is fractional; one decimal is enough to compare it with its limit.
        `${labelByMetric.get(metric)} ${Math.round(value * 10) / 10} (${violation.kind === 'duplication' ? '<' : '<='} ${limit})`
    )
    .join(', ');
  switch (violation.kind) {
    case 'file': {
      return `${violation.file}: ${exceeded}`;
    }
    case 'function': {
      return `${formatLocation(violation)} ${violation.name}: ${exceeded}`;
    }
    case 'duplication': {
      const partners = (violation.partners ?? []).map((partner) => formatLocation(partner));
      const listed = [...partners.slice(0, maxListedPartners), ...(partners.length > maxListedPartners ? ['...'] : [])];
      return `${formatLocation(violation)}: ${exceeded}${listed.length > 0 ? `, also at ${listed.join(', ')}` : ''}`;
    }
  }
}

function formatLocation({ file, startLine, endLine }: BlockLocation): string {
  return `${file}:${startLine}-${endLine}`;
}

function printJsonReport(cliOptions: CheckCliOptions, scope: CheckScope, result: CheckResult): void {
  writeStdout(
    JSON.stringify(
      {
        passed: result.violations.length === 0 && scope.errors.length === 0,
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
