#!/usr/bin/env bun
// Prints the distribution of every thresholded metric over the given projects, per language, as the
// Markdown tables docs/threshold-calibration.md quotes. Run `bun run build-native` first.
// Usage: bun scripts/calibrateThresholds.ts [--rows <file>] <project directory>...
// `--rows` also writes one JSON line per measured function, file, and duplicated block.

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { scanCheckScope } from '../src/checkCommand.js';
import { loadConfig, resolveOptions } from '../src/cliConfig.js';
import { configSearchDirectory, resolveTarget } from '../src/scan.js';
import { duplicationThreshold, fileThresholds, functionThresholds, metricNameOf } from '../src/thresholds.js';

interface Row {
  kind: 'function' | 'file' | 'duplication';
  project: string;
  language: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Identifies the clone group of a duplicated block within its project. */
  group?: number;
  values: Record<string, number>;
}

const quantiles = [0.5, 0.75, 0.9, 0.95, 0.97, 0.98, 0.99, 0.995];
/** Languages with fewer measured functions are folded into `all` only: their tails are noise. */
const minFunctionsPerLanguage = 1000;

const { rowsFile, projectDirectories } = parseArguments(process.argv.slice(2));
const rows: Row[] = [];
for (const projectDirectory of projectDirectories) {
  rows.push(...(await measureProject(projectDirectory)));
}
if (rowsFile) {
  writeFileSync(rowsFile, rows.map((row) => `${JSON.stringify(row)}\n`).join(''));
}
printTables(rows);
// The native worker pool keeps the event loop alive.
process.exit(0);

function parseArguments(args: string[]): { rowsFile?: string; projectDirectories: string[] } {
  const rowsIndex = args.indexOf('--rows');
  const rowsFile = rowsIndex === -1 ? undefined : args[rowsIndex + 1];
  const projectDirectories = rowsIndex === -1 ? args : args.toSpliced(rowsIndex, 2);
  if (projectDirectories.length === 0 || (rowsIndex !== -1 && rowsFile === undefined)) {
    console.error('Usage: bun scripts/calibrateThresholds.ts [--rows <file>] <project directory>...');
    process.exit(2);
  }
  return { rowsFile, projectDirectories };
}

/** Measures the files `code-gauge check` checks in the project, with its config and exclusions. */
async function measureProject(projectDirectory: string): Promise<Row[]> {
  const target = resolveTarget(projectDirectory);
  const options = resolveOptions({}, await loadConfig(undefined, await configSearchDirectory(target)));
  const scope = await scanCheckScope(target, undefined, options);
  // A warning names a file measured without cross-file duplication data, so its clones are missing below.
  for (const message of [...scope.errors, ...scope.warnings]) {
    console.error(`${projectDirectory}: ${message}`);
  }

  const project = path.basename(target);
  const languageByFile = new Map<string, string>();
  const projectRows: Row[] = [];
  let groupCount = 0;
  for (const { file, metrics } of scope.files) {
    const { language } = metrics;
    languageByFile.set(file, language);
    const base = { project, language, file };
    projectRows.push({
      ...base,
      kind: 'file',
      startLine: 1,
      endLine: metrics.lines.total,
      values: measureAll(fileThresholds, metrics),
    });
    for (const fn of metrics.functions) {
      projectRows.push({
        ...base,
        kind: 'function',
        startLine: fn.startLine,
        endLine: fn.endLine,
        values: measureAll(functionThresholds, fn),
      });
    }
    for (const group of metrics.duplication.duplicateBlockGroups) {
      groupCount += 1;
      for (const block of group) {
        projectRows.push(toDuplicationRow(base, block, groupCount));
      }
    }
  }
  for (const group of scope.crossFileDuplication?.groups ?? []) {
    groupCount += 1;
    for (const block of group.occurrences) {
      const language = languageByFile.get(block.file);
      // An occurrence in a file outside the target has no row of its own.
      if (language !== undefined) {
        projectRows.push(toDuplicationRow({ project, language, file: block.file }, block, groupCount));
      }
    }
  }
  return projectRows;
}

function measureAll<Subject>(
  thresholds: readonly { key: string; measure: (subject: Subject) => number }[],
  subject: Subject
): Record<string, number> {
  return Object.fromEntries(
    thresholds.map((threshold) => [metricNameOf(threshold as never), threshold.measure(subject)])
  );
}

function toDuplicationRow(
  base: Pick<Row, 'project' | 'language' | 'file'>,
  block: { startLine: number; endLine: number },
  group: number
): Row {
  return {
    ...base,
    kind: 'duplication',
    startLine: block.startLine,
    endLine: block.endLine,
    group,
    values: { [metricNameOf(duplicationThreshold)]: duplicationThreshold.measure(block) },
  };
}

function printTables(allRows: readonly Row[]): void {
  const functionCountByLanguage = new Map<string, number>();
  for (const { kind, language } of allRows) {
    if (kind === 'function') {
      functionCountByLanguage.set(language, (functionCountByLanguage.get(language) ?? 0) + 1);
    }
  }
  const languages = [...functionCountByLanguage]
    .filter(([, count]) => count >= minFunctionsPerLanguage)
    .toSorted(([, left], [, right]) => right - left)
    .map(([language]) => language);
  const projectCount = new Set(allRows.map(({ project }) => project)).size;
  console.info(`Measured ${projectCount} projects.\n`);

  const thresholdsByKind = { function: functionThresholds, file: fileThresholds, duplication: [duplicationThreshold] };
  for (const [kind, thresholds] of Object.entries(thresholdsByKind)) {
    for (const threshold of thresholds) {
      const metric = metricNameOf(threshold as never);
      console.info(`### ${threshold.label} (${kind === 'duplication' ? 'duplicated block' : kind})\n`);
      console.info(`| Language | Count | ${quantiles.map((quantile) => `p${quantile * 100}`).join(' | ')} | Max |`);
      console.info(`| --- | ---: | ${quantiles.map(() => '---:').join(' | ')} | ---: |`);
      for (const language of ['all', ...languages]) {
        const values = allRows
          .filter((row) => row.kind === kind && (language === 'all' || row.language === language))
          .map((row) => row.values[metric] ?? 0)
          .toSorted((left, right) => left - right);
        if (values.length > 0) {
          const cells = [...quantiles.map((quantile) => quantileOf(values, quantile)), values.at(-1) ?? 0];
          console.info(`| ${language} | ${values.length} | ${cells.map((value) => formatValue(value)).join(' | ')} |`);
        }
      }
      console.info('');
    }
  }
}

/** Nearest-rank quantile of ascending values. */
function quantileOf(sortedValues: readonly number[], quantile: number): number {
  return sortedValues[Math.max(Math.ceil(quantile * sortedValues.length) - 1, 0)] ?? 0;
}

function formatValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
