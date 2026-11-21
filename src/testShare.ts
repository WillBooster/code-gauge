import path from 'node:path';

import type { Exclusion } from './exclusion.js';
import { isScannedBelow, isTestFileBelow, scanListedFiles, type ScanOptions } from './scan.js';
import type { TestShare } from './thresholds.js';

export interface RepositoryTestShareInput {
  repoRoot: string;
  repositoryFiles: ReadonlySet<string>;
  /** The checked directory, repository-relative; empty for the repository root. */
  targetPath: string;
  exclusion: Exclusion;
  options: ScanOptions;
  /** The files the check measured, repository-relative; test files among them count as tests. */
  measuredFiles: readonly { file: string; metrics: { ncssCount: number } }[];
}

/** The share, or the failures to measure test files that leave it unknown. */
export interface TestShareMeasurement {
  share: TestShare;
  /** Test files that could not be measured, each starting with its path like the scan's errors. */
  errors: string[];
}

/**
 * Measures the test files of the checked directory: those the check took (with tests included, or
 * in a targeted test directory) by its measurement, and those it skipped by the same scan with
 * tests included, so the share counts what `--include-tests` measures, one path per real file,
 * regular non-generated sources only. A file is a test file by its repository-relative path, so
 * targeting a test directory does not turn its files into production code. Only a repository has a
 * share: outside one, there is neither a root to tell tests by nor a change.
 */
export async function measureRepositoryTestShare(input: RepositoryTestShareInput): Promise<TestShareMeasurement> {
  const { repoRoot, targetPath, exclusion, options } = input;
  const testPaths = [...input.repositoryFiles].filter(
    (relativePath) =>
      isInTarget(relativePath, targetPath) &&
      isTestFileBelow(relativePath, targetPath, options) &&
      !exclusion.isExcludedPath(path.join(repoRoot, relativePath))
  );
  const testPathSet = new Set(testPaths);
  const skippedTests = await scanListedFiles(
    repoRoot,
    testPaths.filter((relativePath) => !isScannedBelow(relativePath, targetPath, options)),
    {
      ...options,
      includeTests: true,
      // Only NCSS is kept, so no region is long enough to search for clones.
      duplication: { ...options.duplication, minTokens: noCloneSearchTokens },
      loadExclusion: () => Promise.resolve(exclusion),
    },
    new Set(),
    targetPath
  );
  const measuredTests = input.measuredFiles.filter(({ file }) => testPathSet.has(file));
  const share = {
    testNcss: sum([...measuredTests, ...skippedTests.files].map(({ metrics }) => metrics.ncssCount)),
    productionNcss: sum(
      input.measuredFiles
        .filter(({ file }) => isInTarget(file, targetPath) && !testPathSet.has(file))
        .map(({ metrics }) => metrics.ncssCount)
    ),
  };
  return { share, errors: skippedTests.errors.toSorted() };
}

const noCloneSearchTokens = 1_000_000_000;

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
