#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import { type CliOptions, configFileName, loadConfig, type ResolvedOptions, resolveOptions } from './cliConfig.js';
import type { CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import { runDiffCommand, type DiffCliOptions } from './diffCommand.js';
import {
  addCrossFileDuplication,
  collectDuplicatedLineNumbers,
  configSearchDirectory,
  formatError,
  formatPath,
  resolveTarget,
  scanTarget,
  writeStderr,
  writeStdout,
  type FileMetrics,
  type ScanResult,
} from './scan.js';
import type { FunctionMetrics } from './types.js';

/** The worst (highest-cognitive-complexity) function of a file, reported as the ranking evidence. */
interface WorstFunction {
  name: string;
  startLine: number;
  endLine: number;
  cognitiveComplexity: number;
  ncss: number;
  nestingDepth: number;
}

/**
 * One ranked refactoring candidate. The score is the sum of the file's repo-relative percentile
 * ranks (each in [0, 1)) over three dimensions: worst-function cognitive complexity, duplicated
 * lines (within-file and cross-file combined), and file NCSS. Ranking is relative to the scanned
 * project, so no absolute threshold is involved.
 */
interface RankedFile {
  file: string;
  score: number;
  worstFunction?: WorstFunction;
  /** Distinct lines covered by within-file duplicate blocks or cross-file duplicate occurrences. */
  duplicatedLineCount: number;
  /** duplicatedLineCount / code lines (0 when the file has no code). */
  duplicatedLineRatio: number;
  /** Other files sharing cross-file duplicate blocks; filled only for the reported top files. */
  crossFilePartners: string[];
  ncss: number;
  codeLines: number;
}

/** Caps how many cross-file partners a ranked file lists so the report stays scannable. */
const maxCrossFilePartners = 3;

// oxlint-disable-next-line unicorn/prefer-top-level-await -- CommonJS build output cannot preserve top-level await.
void main().catch((error: unknown) => {
  writeStderr(`Error: ${formatError(error)}\n`);
  process.exitCode = 1;
});

/** Registers the options shared by the ranking command and the diff gate. */
function addSharedOptions(command: Command): Command {
  return command
    .option('--config <path>', `config file to use instead of the auto-detected ${configFileName}`)
    .option(
      '--duplication-min-tokens <number>',
      'minimum normalized token count for a duplicate region (default 40)',
      parsePositiveInteger
    )
    .option(
      '--duplication-max-gap-tokens <number>',
      'maximum token gap merged into one gapped clone group; 0 disables merging (default 30)',
      parseNonNegativeInteger
    )
    .option(
      '--duplication-min-similarity-percent <number>',
      'minimum similarity percent (1-100) for near-miss (Type-3) clone blocks; 100 reports exact matches only (default 70)',
      parsePercentInteger
    )
    .option('--include-tests', 'include test files and test directories')
    .option('--json', 'print JSON output');
}

async function main(): Promise<void> {
  const program = addSharedOptions(
    new Command()
      .name('code-gauge')
      .description('Rank the files of a project by refactoring priority.')
      .argument('[target]', 'file or directory to measure', '.')
  )
    .option('--top <number>', 'number of top-ranked files to report (default: 10)', parsePositiveInteger)
    .option('--fail-on-error', 'exit with code 1 when files or directories cannot be scanned');

  program.action(async (target: string, cliOptions: CliOptions) => {
    const resolvedTarget = resolveTarget(target);
    const config = await loadConfig(cliOptions.config, await configSearchDirectory(resolvedTarget));
    const options = resolveOptions(cliOptions, config);
    const result = await scanTarget(resolvedTarget, options);
    addCrossFileDuplication(result, options);
    const rankedFiles = rankFiles(result, options.top);

    if (options.json) {
      printJson(result, rankedFiles, options);
    } else {
      printTextReport(resolvedTarget, result, rankedFiles, options);
    }

    if (result.fatalError || (options.failOnError && result.errors.length > 0)) {
      process.exitCode = 1;
    }
  });

  addSharedOptions(
    program
      .command('diff')
      .description(
        'Gate the working tree against a base ref: report only metric regressions in changed files (exit 1 on violations)'
      )
      .argument('[target]', 'directory whose changed files are gated', '.')
      .requiredOption('--base <ref>', 'base git ref; changes are measured against its merge-base with HEAD')
  )
    .option('--full', 'also print the passing gate values of every checked function and file')
    .action(async (target: string, _cliOptions: DiffCliOptions, command: Command) => {
      // Options sharing a name with a root option (--json, --config, ...) land in the root's
      // option store, so the merged view is required to see them.
      await runDiffCommand(target, command.optsWithGlobals() as DiffCliOptions);
    });

  await program.parseAsync();
}

function rankFiles(result: ScanResult, top: number): RankedFile[] {
  const candidates = result.files.map(({ file, metrics }) => {
    const formattedFile = formatPath(file, result.displayRoot);
    const duplicatedLines = collectDuplicatedLineNumbers(metrics, result.crossFileDuplication, formattedFile);
    return {
      file: formattedFile,
      worstFunction: findWorstFunction(metrics.functions),
      duplicatedLineCount: duplicatedLines.size,
      duplicatedLineRatio: metrics.lines.code === 0 ? 0 : duplicatedLines.size / metrics.lines.code,
      crossFilePartners: [] as string[],
      ncss: metrics.ncssCount,
      codeLines: metrics.lines.code,
    };
  });

  const cognitivePercentile = makePercentile(candidates.map((c) => c.worstFunction?.cognitiveComplexity ?? 0));
  const duplicationPercentile = makePercentile(candidates.map((c) => c.duplicatedLineCount));
  const ncssPercentile = makePercentile(candidates.map((c) => c.ncss));

  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      score:
        cognitivePercentile(candidate.worstFunction?.cognitiveComplexity ?? 0) +
        duplicationPercentile(candidate.duplicatedLineCount) +
        ncssPercentile(candidate.ncss),
    }))
    .toSorted(
      (left, right) => right.score - left.score || right.ncss - left.ncss || left.file.localeCompare(right.file)
    );
  // Partner evidence is attached only to the files that will be reported: expanding partners for
  // every scanned file first would retain TH(F^2) strings when one clone group spans F files, and
  // rescanning all groups per file would be O(files x groups) on the post-scan ranking step.
  attachCrossFilePartners(ranked.slice(0, top), result.crossFileDuplication);
  return ranked;
}

/** One pass over the groups fills the reported files' partner lists (other files sharing a group). */
function attachCrossFilePartners(
  reportedFiles: RankedFile[],
  crossFileDuplication: CrossFileDuplicationMetrics | undefined
): void {
  if (!crossFileDuplication) {
    return;
  }
  const partnersByFile = new Map(reportedFiles.map((ranked) => [ranked.file, new Set<string>()]));
  for (const group of crossFileDuplication.groups) {
    for (const file of group.files) {
      const partners = partnersByFile.get(file);
      if (!partners) {
        continue;
      }
      for (const partner of group.files) {
        if (partner !== file) {
          partners.add(partner);
        }
      }
    }
  }
  for (const ranked of reportedFiles) {
    ranked.crossFilePartners = [...(partnersByFile.get(ranked.file) ?? [])].toSorted();
  }
}

/**
 * Percentile rank within the scanned project: the fraction of files with a strictly smaller
 * value, in [0, 1). Relative ranking needs no absolute threshold, which sidesteps the metric
 * calibration problem entirely — the top of the list is worth refactoring first regardless of
 * where any cutoff would sit.
 */
function makePercentile(values: number[]): (value: number) => number {
  const sorted = values.toSorted((left, right) => left - right);
  return (value: number) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((sorted[middle] as number) < value) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return sorted.length === 0 ? 0 : low / sorted.length;
  };
}

/** The highest-cognitive-complexity function; NCSS breaks ties so the larger body is reported. */
function findWorstFunction(functions: FunctionMetrics[]): WorstFunction | undefined {
  let worst: FunctionMetrics | undefined;
  for (const fn of functions) {
    if (
      !worst ||
      fn.cognitiveComplexity > worst.cognitiveComplexity ||
      (fn.cognitiveComplexity === worst.cognitiveComplexity && fn.ncss > worst.ncss)
    ) {
      worst = fn;
    }
  }
  if (!worst) {
    return undefined;
  }
  return {
    name: worst.name ?? '<anonymous>',
    startLine: worst.startLine,
    endLine: worst.endLine,
    cognitiveComplexity: worst.cognitiveComplexity,
    ncss: worst.ncss,
    nestingDepth: worst.nestingDepth,
  };
}

function printJson(result: ScanResult, rankedFiles: RankedFile[], options: ResolvedOptions): void {
  const reportedFiles = rankedFiles.slice(0, options.top);
  writeStdout(
    JSON.stringify(
      {
        summary: summarize(result.files),
        totalRankedFiles: rankedFiles.length,
        truncated: reportedFiles.length < rankedFiles.length,
        files: reportedFiles,
        errors: result.errors,
        warnings: result.warnings,
      },
      undefined,
      2
    ) + '\n'
  );
}

function printTextReport(
  target: string,
  result: ScanResult,
  rankedFiles: RankedFile[],
  options: ResolvedOptions
): void {
  if (result.fatalError) {
    writeStderr(`Error: ${result.fatalError}\n`);
    return;
  }

  const summary = summarize(result.files);
  writeStdout(
    `Measured ${summary.fileCount} files under ${target} (code LOC ${summary.linesOfCode}, NCSS ${summary.ncssCount}, functions ${summary.functionCount})\n`
  );

  if (rankedFiles.length === 0) {
    writeStdout('No measurable files found.\n');
  } else {
    const reportedFiles = rankedFiles.slice(0, options.top);
    const totalSuffix = rankedFiles.length > reportedFiles.length ? ` of ${rankedFiles.length}` : '';
    writeStdout(`\nRefactoring candidates (top ${reportedFiles.length}${totalSuffix}):\n`);
    for (const [index, ranked] of reportedFiles.entries()) {
      writeStdout(`${index + 1}. ${formatRankedFile(ranked)}\n`);
    }
  }

  if (result.warnings.length > 0) {
    writeStderr(`\nDegraded ${result.warnings.length} files (measured, but excluded from cross-file matching):\n`);
    for (const warning of result.warnings.slice(0, 10)) {
      writeStderr(`- ${warning}\n`);
    }
    if (result.warnings.length > 10) {
      writeStderr(`- ... ${result.warnings.length - 10} more\n`);
    }
  }

  if (result.errors.length > 0) {
    writeStderr(`\nSkipped ${result.errors.length} files or directories:\n`);
    for (const error of result.errors.slice(0, 10)) {
      writeStderr(`- ${error}\n`);
    }
    if (result.errors.length > 10) {
      writeStderr(`- ... ${result.errors.length - 10} more\n`);
    }
  }
}

/** One ranked file as a single line: the location, the evidence, and where the duplication points. */
function formatRankedFile(ranked: RankedFile): string {
  const reasons: string[] = [];
  if (ranked.worstFunction) {
    const fn = ranked.worstFunction;
    reasons.push(
      `worst function ${fn.name} (L${fn.startLine}-${fn.endLine}) cognitive ${fn.cognitiveComplexity}, NCSS ${fn.ncss}, nesting ${fn.nestingDepth}`
    );
  }
  if (ranked.duplicatedLineCount > 0) {
    const partnersSuffix =
      ranked.crossFilePartners.length > 0
        ? `, shared with ${ranked.crossFilePartners.slice(0, maxCrossFilePartners).join(', ')}${ranked.crossFilePartners.length > maxCrossFilePartners ? ', ...' : ''}`
        : '';
    reasons.push(
      `duplicated lines ${ranked.duplicatedLineCount} (${Math.round(ranked.duplicatedLineRatio * 100)}%${partnersSuffix})`
    );
  }
  reasons.push(`file NCSS ${ranked.ncss}`);
  return `${ranked.file} (score ${ranked.score.toFixed(2)}): ${reasons.join('; ')}`;
}

function summarize(files: FileMetrics[]): {
  fileCount: number;
  functionCount: number;
  linesOfCode: number;
  maxCognitiveComplexity: number;
  ncssCount: number;
} {
  let functionCount = 0;
  let linesOfCode = 0;
  let maxCognitiveComplexity = 0;
  let ncssCount = 0;

  for (const file of files) {
    functionCount += file.metrics.functions.length;
    linesOfCode += file.metrics.lines.code;
    maxCognitiveComplexity = Math.max(maxCognitiveComplexity, file.metrics.maxCognitiveComplexity);
    ncssCount += file.metrics.ncssCount;
  }

  return { fileCount: files.length, functionCount, linesOfCode, maxCognitiveComplexity, ncssCount };
}

function parsePercentInteger(value: string): number {
  const parsed = parsePositiveInteger(value);
  if (parsed > 100) {
    throw new InvalidArgumentError('Expected an integer between 1 and 100.');
  }
  return parsed;
}

function parseNonNegativeInteger(value: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new InvalidArgumentError('Expected a non-negative integer.');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidArgumentError('Expected a non-negative integer.');
  }
  return parsed;
}

function parsePositiveInteger(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('Expected a positive integer.');
  }
  return parsed;
}
