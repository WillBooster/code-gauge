import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getErrorMessage, mapConcurrently } from '@willbooster/shared-lib';

import type { Exclusion } from './exclusion.js';
import { diffLineCounts } from './git.js';
import { measureCode } from './metrics.js';
import { getLanguage, isScannedBelow, isTestFileBelow, type ScanOptions } from './scan.js';
import type { TestShare } from './thresholds.js';

/** The test share of the checked project and, for a check of a change, the test lines it adds. */
export interface MeasuredTestShare extends TestShare {
  /** The test lines the change adds net of those it deletes, by git's diff; absent without a base. */
  addedTestLines?: number;
}

export interface RepositoryTestShareInput {
  repoRoot: string;
  repositoryFiles: ReadonlySet<string>;
  /** The checked directory, repository-relative; empty for the repository root. */
  targetPath: string;
  exclusion: Exclusion;
  options: ScanOptions;
  /** The files the check measured, repository-relative; test files among them count as tests. */
  measuredFiles: readonly { file: string; metrics: { ncssCount: number } }[];
  /** Whether a share exceeds an active limit; only then can what a change adds decide a violation. */
  exceedsLimit: (share: TestShare) => boolean;
  base?: { mergeBase: string };
}

/** The share, or the failures to measure test files that leave it unknown. */
export interface TestShareMeasurement {
  share: MeasuredTestShare;
  /** Test files that could not be measured, each starting with its path like the scan's errors. */
  errors: string[];
}

/**
 * Measures the test files of the checked directory, reusing the check's measurement of any it took
 * (with tests included, or in a targeted test directory) and measuring those it skipped, and, for a
 * change, the test lines it adds by git's diff. A file is a test file by its repository-relative
 * path, so targeting a test directory does not turn its files into production code. Only a
 * repository has a share: outside one, there is neither a root to tell tests by nor a change.
 */
export async function measureRepositoryTestShare(input: RepositoryTestShareInput): Promise<TestShareMeasurement> {
  const { repoRoot, targetPath, exclusion, options } = input;
  const isTestIn = (pathExclusion: Exclusion, relativePath: string): boolean =>
    isInTarget(relativePath, targetPath) &&
    isTestFileBelow(relativePath, targetPath, options) &&
    !pathExclusion.isExcludedPath(path.join(repoRoot, relativePath));
  const errors: string[] = [];
  const measuredNcss = new Map(input.measuredFiles.map(({ file, metrics }) => [file, metrics.ncssCount]));
  /** The NCSS of a test source; undefined for a path that is none (not a regular file, or generated). */
  const measureHead = async (relativePath: string): Promise<number | undefined> => {
    // The check measured this file itself and reported it if it could not.
    if (isScannedBelow(relativePath, targetPath, options)) {
      return measuredNcss.get(relativePath);
    }
    try {
      return await measureTestFile(input, relativePath);
    } catch (error) {
      errors.push(`${relativePath}: ${getErrorMessage(error)}`);
      return 0;
    }
  };
  const testNcssByPath = new Map(
    await mapConcurrently(
      [...input.repositoryFiles].filter((relativePath) => isTestIn(exclusion, relativePath)),
      os.availableParallelism() * 2,
      async (relativePath) => [relativePath, await measureHead(relativePath)] as const
    )
  );
  const share = {
    testNcss: sum([...testNcssByPath.values()].map((ncss) => ncss ?? 0)),
    productionNcss: sum(
      input.measuredFiles
        .filter(({ file }) => isInTarget(file, targetPath) && !testNcssByPath.has(file))
        .map(({ metrics }) => metrics.ncssCount)
    ),
  };
  // Within every limit, or with the share unknown for unmeasured files, the change's addition
  // decides nothing.
  if (input.base === undefined || errors.length > 0 || !input.exceedsLimit(share)) {
    return { share, errors: errors.toSorted() };
  }
  try {
    const addedTestLines = await measureAddedTestLines(input, input.base.mergeBase, (file) =>
      testNcssByPath.has(file) ? testNcssByPath.get(file) !== undefined : isTestIn(exclusion, file)
    );
    return { share: { ...share, addedTestLines }, errors: errors.toSorted() };
  } catch (error) {
    // An unknown addition suppresses the share while the report keeps the rest.
    return {
      share,
      errors: [
        ...errors,
        `test changes since ${input.base.mergeBase.slice(0, 12)}: ${getErrorMessage(error)}`,
      ].toSorted(),
    };
  }
}

/**
 * The test lines the change adds net of those it deletes: git's diff against the merge-base for the
 * tracked files, which already accounts for renames, sparse and partial clones, attributes, and
 * binary files, plus the lines of the untracked files git lists, which the diff leaves out. A path
 * the working tree holds counts only as a test source the share counts; a deleted one, by its path.
 */
async function measureAddedTestLines(
  input: RepositoryTestShareInput,
  mergeBase: string,
  countsAsTest: (relativePath: string) => boolean
): Promise<number> {
  const { tracked, untracked } = await diffLineCounts(input.repoRoot, mergeBase, input.targetPath);
  let added = 0;
  for (const { file, added: addedLines, deleted } of tracked) {
    if (countsAsTest(file)) {
      added += addedLines - deleted;
    }
  }
  for (const file of untracked.filter((file) => countsAsTest(file))) {
    added += countLines(await readFile(path.join(input.repoRoot, file), 'utf8'));
  }
  return added;
}

function countLines(code: string): number {
  return code === '' ? 0 : code.split('\n').length - (code.endsWith('\n') ? 1 : 0);
}

/** A path that is not a regular file is no source, as in the scan; a file that cannot be read throws. */
async function measureTestFile(input: RepositoryTestShareInput, relativePath: string): Promise<number | undefined> {
  const absolutePath = path.join(input.repoRoot, relativePath);
  const stats = await lstat(absolutePath);
  if (!stats.isFile()) {
    return undefined;
  }
  return measureTestCode(await readFile(absolutePath, 'utf8'), relativePath, input, input.exclusion);
}

function measureTestCode(
  code: string,
  relativePath: string,
  input: RepositoryTestShareInput,
  exclusion: Exclusion
): number | undefined {
  const language = getLanguage(relativePath, { ...input.options, includeTests: true });
  if (language === undefined || exclusion.isGeneratedCode(path.join(input.repoRoot, relativePath), code)) {
    return undefined;
  }
  return measureCode(code, { language, duplication: input.options.duplication }).ncssCount;
}

function isInTarget(relativePath: string, targetPath: string): boolean {
  return targetPath === '' || relativePath.startsWith(`${targetPath}/`);
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
