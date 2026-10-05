import type { CrossFileDuplicateBlockGroup, CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import type { LineHunk } from './git.js';
import {
  duplicationThreshold,
  fileThresholds,
  functionThresholds,
  metricNameOf,
  type Limits,
  type Threshold,
} from './thresholds.js';
import type { CodeMetrics } from './types.js';

/** A measured file to check, under the path cross-file duplication knows it by. */
export interface CheckedFile {
  file: string;
  metrics: CodeMetrics;
  /** The change to the file; when set, only what the change touches is checked. */
  hunks?: readonly LineHunk[];
}

export interface ExceededLimit {
  metric: string;
  value: number;
  /** The value is allowed up to this limit; a duplicated block is allowed below it. */
  limit: number;
}

export interface BlockLocation {
  file: string;
  startLine: number;
  endLine: number;
}

export interface Violation extends BlockLocation {
  kind: 'function' | 'file' | 'duplication';
  /** The function's name, for kind `function`. */
  name?: string;
  exceeded: ExceededLimit[];
  /** The other copies of the block, for kind `duplication`. */
  partners?: BlockLocation[];
}

export interface CheckResult {
  violations: Violation[];
  checkedFunctionCount: number;
}

const violationKinds: readonly Violation['kind'][] = ['file', 'function', 'duplication'];

/** Every limit the files exceed, ordered by path, then line. */
export function checkThresholds(
  files: readonly CheckedFile[],
  crossFileDuplication: CrossFileDuplicationMetrics | undefined,
  limitsOf: (language: string) => Limits
): CheckResult {
  const crossFileGroupsByFile = indexGroupsByFile(crossFileDuplication, new Set(files.map(({ file }) => file)));
  const violations: Violation[] = [];
  let checkedFunctionCount = 0;
  for (const { file, metrics, hunks } of files) {
    const limits = limitsOf(metrics.language);
    const fileExceeded = collectExceeded(fileThresholds, metrics, limits);
    if (fileExceeded.length > 0) {
      violations.push({ kind: 'file', file, startLine: 1, endLine: metrics.lines.total, exceeded: fileExceeded });
    }
    for (const fn of metrics.functions) {
      if (hunks && !hunks.some((hunk) => touchesSpan(hunk, fn.startLine, fn.endLine))) {
        continue;
      }
      checkedFunctionCount += 1;
      const exceeded = collectExceeded(functionThresholds, fn, limits);
      if (exceeded.length > 0) {
        violations.push({
          kind: 'function',
          file,
          startLine: fn.startLine,
          endLine: fn.endLine,
          name: fn.name ?? '<anonymous>',
          exceeded,
        });
      }
    }
    violations.push(
      ...collectDuplicationViolations(
        file,
        metrics,
        crossFileGroupsByFile.get(file) ?? [],
        hunks,
        limits[duplicationThreshold.key] as number
      )
    );
  }
  return {
    violations: violations.toSorted(
      (left, right) =>
        compareStrings(left.file, right.file) ||
        left.startLine - right.startLine ||
        left.endLine - right.endLine ||
        violationKinds.indexOf(left.kind) - violationKinds.indexOf(right.kind)
    ),
    checkedFunctionCount,
  };
}

function collectExceeded<Subject>(
  thresholds: readonly Threshold<Subject>[],
  subject: Subject,
  limits: Limits
): ExceededLimit[] {
  return thresholds.flatMap((threshold) => {
    const value = threshold.measure(subject);
    const limit = limits[threshold.key] as number;
    return value > limit ? [{ metric: metricNameOf(threshold), value, limit }] : [];
  });
}

/**
 * Whether the hunk changes the head lines [startLine, endLine]. A hunk without head lines (a pure
 * deletion) sits between its headStart line and the next one.
 */
function touchesSpan(hunk: LineHunk, startLine: number, endLine: number): boolean {
  return hunk.headCount === 0
    ? hunk.headStart >= startLine && hunk.headStart < endLine
    : hunk.headStart <= endLine && hunk.headStart + hunk.headCount > startLine;
}

/** The cross-file groups with an occurrence in each of the given files. */
function indexGroupsByFile(
  crossFileDuplication: CrossFileDuplicationMetrics | undefined,
  files: ReadonlySet<string>
): Map<string, CrossFileDuplicateBlockGroup[]> {
  const groupsByFile = new Map<string, CrossFileDuplicateBlockGroup[]>();
  for (const group of crossFileDuplication?.groups ?? []) {
    for (const file of group.files) {
      if (files.has(file)) {
        const groups = groupsByFile.get(file) ?? [];
        groups.push(group);
        groupsByFile.set(file, groups);
      }
    }
  }
  return groupsByFile;
}

/**
 * One violation per distinct line range of the file's clone occurrences, within-file and
 * cross-file, spanning at least `minLines`; with `hunks`, only those overlapping added lines.
 */
function collectDuplicationViolations(
  file: string,
  metrics: CodeMetrics,
  crossFileGroups: readonly CrossFileDuplicateBlockGroup[],
  hunks: readonly LineHunk[] | undefined,
  minLines: number
): Violation[] {
  const groups: BlockLocation[][] = [
    ...metrics.duplication.duplicateBlockGroups.map((group) => group.map((occurrence) => ({ ...occurrence, file }))),
    ...crossFileGroups.map((group) => group.occurrences),
  ];
  const partnersByRange = new Map<string, { violation: Violation; partners: Map<string, BlockLocation> }>();
  const isReported = (block: BlockLocation): boolean =>
    block.file === file &&
    duplicationThreshold.measure(block) >= minLines &&
    (!hunks || hunks.some((hunk) => hunk.headCount > 0 && touchesSpan(hunk, block.startLine, block.endLine)));
  for (const group of groups) {
    for (const block of group.filter((occurrence) => isReported(occurrence))) {
      const range = `${block.startLine}-${block.endLine}`;
      const entry = partnersByRange.get(range) ?? {
        violation: {
          kind: 'duplication',
          file,
          startLine: block.startLine,
          endLine: block.endLine,
          exceeded: [
            { metric: metricNameOf(duplicationThreshold), value: duplicationThreshold.measure(block), limit: minLines },
          ],
        },
        partners: new Map(),
      };
      partnersByRange.set(range, entry);
      for (const { file: partnerFile, startLine, endLine } of group) {
        if (partnerFile !== file || startLine !== block.startLine || endLine !== block.endLine) {
          entry.partners.set(`${partnerFile}\0${startLine}-${endLine}`, { file: partnerFile, startLine, endLine });
        }
      }
    }
  }
  return [...partnersByRange.values()].map(({ violation, partners }) => ({
    ...violation,
    partners: [...partners.values()].toSorted(
      (left, right) => compareStrings(left.file, right.file) || left.startLine - right.startLine
    ),
  }));
}

/** Code-unit order, so reports do not depend on the locale. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
