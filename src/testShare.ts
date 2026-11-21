import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { mapConcurrently } from '@willbooster/shared-lib';

import type { Exclusion } from './exclusion.js';
import { type ChangedFile, readFileAt } from './git.js';
import { measureCode } from './metrics.js';
import { type FileMetrics, getLanguage, isTestPath, type ScanOptions } from './scan.js';
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
    /** The exclusion of base paths, which may no longer exist and so lack from `exclusion`. */
    loadExclusion: (relativePaths: readonly string[]) => Promise<Exclusion>;
  };
}

/**
 * Measures the test files of the checked directory, which the check itself does not measure unless
 * it includes tests, and, for a change, the same files at the merge-base where the change touched
 * them, read from git so nothing is checked out.
 */
export async function measureRepositoryTestShare(input: RepositoryTestShareInput): Promise<MeasuredTestShare> {
  const { repoRoot, targetPath, exclusion, options } = input;
  const isTestIn = (pathExclusion: Exclusion, relativePath: string): boolean => {
    const scopedPath = scopeToTarget(relativePath, targetPath);
    return (
      scopedPath !== undefined &&
      isTestPath(scopedPath, options) &&
      !pathExclusion.isExcludedPath(path.join(repoRoot, relativePath))
    );
  };
  const isTest = (relativePath: string): boolean => isTestIn(exclusion, relativePath);
  const testNcssByPath = new Map(
    await mapConcurrently(
      [...input.repositoryFiles].filter((relativePath) => isTest(relativePath)),
      os.availableParallelism() * 2,
      async (relativePath) => [relativePath, await measureTestFile(input, exclusion, relativePath)] as const
    )
  );
  const share = {
    testNcss: sum(testNcssByPath.values()),
    productionNcss: sum(
      input.measuredFiles
        .filter(({ file }) => scopeToTarget(file, targetPath) !== undefined && !isTest(file))
        .map(({ metrics }) => metrics.ncssCount)
    ),
  };
  if (input.base === undefined) {
    return share;
  }
  const { mergeBase, changedFiles } = input.base;
  const baseExclusion = await input.base.loadExclusion(
    changedFiles.flatMap(({ basePath }) => (basePath === undefined ? [] : [basePath]))
  );
  const changes = await mapConcurrently(changedFiles, os.availableParallelism() * 2, async (changed) => {
    const headNcss = changed.status === 'deleted' ? 0 : (testNcssByPath.get(changed.headPath) ?? 0);
    const { basePath } = changed;
    const baseNcss =
      basePath !== undefined && isTestIn(baseExclusion, basePath)
        ? measureTestCode(await readFileAt(repoRoot, mergeBase, basePath), basePath, input, baseExclusion)
        : 0;
    return headNcss - baseNcss;
  });
  return { ...share, addedTestNcss: sum(changes) };
}

/** Splits the files a directory walk measured with tests included into tests and the rest. */
export function partitionWalkedTestShare(files: readonly FileMetrics[], root: string, options: ScanOptions): TestShare {
  const testFiles = files.filter(({ file }) =>
    isTestPath(path.relative(root, file).replaceAll(path.sep, '/'), options)
  );
  return {
    testNcss: sum(testFiles.map(({ metrics }) => metrics.ncssCount)),
    productionNcss: sum(files.filter((file) => !testFiles.includes(file)).map(({ metrics }) => metrics.ncssCount)),
  };
}

/** A file that is not a regular file or cannot be read counts as no test code, as the check would not measure it. */
async function measureTestFile(
  input: RepositoryTestShareInput,
  exclusion: Exclusion,
  relativePath: string
): Promise<number> {
  const absolutePath = path.join(input.repoRoot, relativePath);
  const stats = await lstat(absolutePath).catch(() => {});
  if (!stats?.isFile()) {
    return 0;
  }
  const code = await readFile(absolutePath, 'utf8').catch(() => {});
  return code === undefined ? 0 : measureTestCode(code, relativePath, input, exclusion);
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
  try {
    return measureCode(code, { language, duplication: input.options.duplication }).ncssCount;
  } catch {
    // A test file the parser cannot read is not a measured file, as in the check itself.
    return 0;
  }
}

/** The path below the target directory, or undefined outside it. */
function scopeToTarget(relativePath: string, targetPath: string): string | undefined {
  if (targetPath === '') {
    return relativePath;
  }
  return relativePath.startsWith(`${targetPath}/`) ? relativePath.slice(targetPath.length + 1) : undefined;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
