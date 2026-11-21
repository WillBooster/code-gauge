import { lstat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getErrorMessage, mapConcurrently } from '@willbooster/shared-lib';

import type { Exclusion } from './exclusion.js';
import { measureCode } from './metrics.js';
import { getLanguage, isScannedBelow, isTestFileBelow, type ScanOptions } from './scan.js';
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
 * Measures the test files of the checked directory, reusing the check's measurement of any it took
 * (with tests included, or in a targeted test directory) and measuring those it skipped. A file is a test file by its repository-relative
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
  const testPaths = [...input.repositoryFiles].filter((relativePath) => isTestIn(exclusion, relativePath));
  const counted = await chooseOnePathPerFile(input.repoRoot, testPaths, measuredNcss);
  const testNcssByPath = new Map(
    await mapConcurrently(
      testPaths,
      os.availableParallelism() * 2,
      async (relativePath) =>
        [relativePath, counted.has(relativePath) ? await measureHead(relativePath) : undefined] as const
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
  return { share, errors: errors.toSorted() };
}

/**
 * One path for each file the paths name, as the scan measures one path per real file: git can list
 * one file under several spellings (Unicode normalization or case on an insensitive file system).
 * A path the scan measured is kept over its aliases; a path that cannot be resolved stands alone.
 */
async function chooseOnePathPerFile(
  repoRoot: string,
  paths: readonly string[],
  measuredNcss: ReadonlyMap<string, number>
): Promise<Set<string>> {
  const identities = await mapConcurrently(paths, os.availableParallelism() * 2, async (relativePath) => {
    const absolutePath = path.join(repoRoot, relativePath);
    return [relativePath, await realpath(absolutePath).catch(() => absolutePath)] as const;
  });
  const chosen = new Map<string, string>();
  for (const [relativePath, identity] of identities) {
    const current = chosen.get(identity);
    if (current === undefined || (!measuredNcss.has(current) && measuredNcss.has(relativePath))) {
      chosen.set(identity, relativePath);
    }
  }
  return new Set(chosen.values());
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

const noCloneSearchTokens = 1_000_000_000;

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
  // Only NCSS is kept, so no region is long enough to search for clones.
  return measureCode(code, { language, duplication: { ...input.options.duplication, minTokens: noCloneSearchTokens } })
    .ncssCount;
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
