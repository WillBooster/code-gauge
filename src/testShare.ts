import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getErrorMessage, mapConcurrently } from '@willbooster/shared-lib';

import type { Exclusion } from './exclusion.js';
import { type ChangedFile, readRegularFilesAt } from './git.js';
import { measureCode } from './metrics.js';
import { getLanguage, isScannedBelow, isTestFileBelow, type ScanOptions } from './scan.js';
import type { TestShare } from './thresholds.js';

/** The test share of the checked project and, for a check of a change, the test NCSS it adds. */
export interface MeasuredTestShare extends TestShare {
  /** The test NCSS the change adds (negative when it removes more); absent without a base. */
  addedTestNcss?: number;
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
  base?: {
    mergeBase: string;
    changedFiles: readonly ChangedFile[];
    /** The exclusion of base paths by the merge-base's attributes, as their content is the merge-base's. */
    loadExclusion: (relativePaths: readonly string[]) => Promise<Exclusion>;
  };
}

/** The share, or the failures to measure test files that leave it unknown. */
export interface TestShareMeasurement {
  share: MeasuredTestShare;
  /** Test files that could not be measured, each starting with its path like the scan's errors. */
  errors: string[];
}

/**
 * Measures the test files of the checked directory, which the check itself does not measure unless
 * it includes tests, and, for a change, the same files at the merge-base where the change touched
 * them, read from git so nothing is checked out. A file is a test file by its repository-relative
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
  const measureHead = async (relativePath: string): Promise<number> => {
    // The check measured this file itself and reported it if it could not.
    if (isScannedBelow(relativePath, targetPath, options)) {
      return measuredNcss.get(relativePath) ?? 0;
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
    testNcss: sum(testNcssByPath.values()),
    productionNcss: sum(
      input.measuredFiles
        .filter(({ file }) => isInTarget(file, targetPath) && !testNcssByPath.has(file))
        .map(({ metrics }) => metrics.ncssCount)
    ),
  };
  if (input.base === undefined) {
    return { share, errors: errors.toSorted() };
  }
  const addedTestNcss = await measureAddedTestNcss(input, input.base, isTestIn, testNcssByPath, errors);
  // Measurements finish in any order; the report keeps one.
  return { share: { ...share, addedTestNcss }, errors: errors.toSorted() };
}

/** The head test NCSS of the changed files minus what they held at the merge-base. */
async function measureAddedTestNcss(
  input: RepositoryTestShareInput,
  { mergeBase, changedFiles, loadExclusion }: NonNullable<RepositoryTestShareInput['base']>,
  isTestIn: (pathExclusion: Exclusion, relativePath: string) => boolean,
  testNcssByPath: ReadonlyMap<string, number>,
  errors: string[]
): Promise<number> {
  const { repoRoot, targetPath, options } = input;
  const basePaths = changedFiles.flatMap(({ basePath }) =>
    basePath !== undefined && isInTarget(basePath, targetPath) && isTestFileBelow(basePath, targetPath, options)
      ? [basePath]
      : []
  );
  const baseExclusion = await loadExclusion(basePaths);
  let baseContents: Map<string, string>;
  try {
    baseContents = await readRegularFilesAt(
      repoRoot,
      mergeBase,
      basePaths.filter((basePath) => isTestIn(baseExclusion, basePath))
    );
  } catch (error) {
    // Unread merge-base tests leave the change's addition unknown; the error suppresses the share.
    errors.push(`test files at ${mergeBase.slice(0, 12)}: ${getErrorMessage(error)}`);
    return 0;
  }

  const changes = changedFiles.map((changed) => {
    const headNcss = changed.status === 'deleted' ? 0 : (testNcssByPath.get(changed.headPath) ?? 0);
    const baseCode = changed.basePath === undefined ? undefined : baseContents.get(changed.basePath);
    if (changed.basePath === undefined || baseCode === undefined) {
      return headNcss;
    }
    try {
      return headNcss - measureTestCode(baseCode, changed.basePath, input, baseExclusion);
    } catch (error) {
      errors.push(`${changed.basePath} at ${mergeBase.slice(0, 12)}: ${getErrorMessage(error)}`);
      return headNcss;
    }
  });
  return sum(changes);
}

/** A path that is not a regular file is no source, as in the scan; a file that cannot be read throws. */
async function measureTestFile(input: RepositoryTestShareInput, relativePath: string): Promise<number> {
  const absolutePath = path.join(input.repoRoot, relativePath);
  const stats = await lstat(absolutePath);
  if (!stats.isFile()) {
    return 0;
  }
  return measureTestCode(await readFile(absolutePath, 'utf8'), relativePath, input, input.exclusion);
}

function measureTestCode(
  code: string,
  relativePath: string,
  input: RepositoryTestShareInput,
  exclusion: Exclusion
): number {
  const language = getLanguage(relativePath, { ...input.options, includeTests: true });
  if (language === undefined || exclusion.isGeneratedCode(path.join(input.repoRoot, relativePath), code)) {
    return 0;
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
