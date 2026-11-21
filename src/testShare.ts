import type { Exclusion } from './exclusion.js';
import { formatPath, isTestFileBelow, scanListedFiles, type ScanOptions } from './scan.js';
import type { TestShare } from './thresholds.js';

export interface RepositoryTestShareInput {
  repoRoot: string;
  repositoryFiles: ReadonlySet<string>;
  /** The checked directory, repository-relative; empty for the repository root. */
  targetPath: string;
  /** Whether a repository-relative path lies in the checked directory, as the check judges it. */
  isInTarget: (relativePath: string) => boolean;
  exclusion: Exclusion;
  options: ScanOptions;
  /** The files the check measured, repository-relative. */
  measuredFiles: readonly { file: string; metrics: { ncssCount: number } }[];
}

interface MeasuredFiles {
  files: readonly { file: string; metrics: { ncssCount: number } }[];
  errors: readonly string[];
}

/** The share, or the failures to measure files that leave it unknown. */
export interface TestShareMeasurement {
  share: TestShare;
  /** Files that could not be measured, each starting with its path like the scan's errors. */
  errors: string[];
}

/**
 * Measures the files of the checked directory as the check does with tests included: its own
 * measurement when it included tests, otherwise the same scan with tests included and metrics
 * only. One scan over all the files chooses one path per real file across tests and production
 * code alike, so the share counts exactly what `--include-tests` measures. A file is a test file
 * by its repository-relative path, so targeting a test directory does not turn its files into
 * production code. Only a repository has a share: outside one, there is neither a root to tell
 * tests by nor a change.
 */
export async function measureRepositoryTestShare(input: RepositoryTestShareInput): Promise<TestShareMeasurement> {
  const { targetPath, options } = input;
  const { files, errors }: MeasuredFiles = options.includeTests
    ? { files: input.measuredFiles, errors: [] }
    : await scanWithTests(input);
  let testNcss = 0;
  let productionNcss = 0;
  for (const { file, metrics } of files) {
    if (!input.isInTarget(file)) {
      continue;
    }
    if (isTestFileBelow(file, targetPath, options)) {
      testNcss += metrics.ncssCount;
    } else {
      productionNcss += metrics.ncssCount;
    }
  }
  return { share: { testNcss, productionNcss }, errors: errors.toSorted() };
}

async function scanWithTests({
  repoRoot,
  repositoryFiles,
  targetPath,
  exclusion,
  options,
}: RepositoryTestShareInput): Promise<MeasuredFiles> {
  const scan = await scanListedFiles(
    repoRoot,
    // The same files the check scans: a file's chosen path may lie outside the target, as it does
    // with tests included.
    repositoryFiles,
    {
      ...options,
      includeTests: true,
      metricsOnly: true,
      // Only NCSS is kept, so no region is long enough to search for clones.
      duplication: { ...options.duplication, minTokens: noCloneSearchTokens },
      loadExclusion: () => Promise.resolve(exclusion),
    },
    new Set(),
    targetPath
  );
  // A failure of the measurement itself (a missing native addon) ends the check, as the check's own scan does.
  if (scan.fatalError) {
    throw new Error(scan.fatalError);
  }
  return {
    files: scan.files.map(({ file, metrics }) => ({ file: formatPath(file, repoRoot), metrics })),
    errors: scan.errors,
  };
}

const noCloneSearchTokens = 1_000_000_000;
