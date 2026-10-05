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
import type { CodeMetrics, FunctionMetrics } from './types.js';

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
  for (const checkedFile of files) {
    const { file, metrics, hunks } = checkedFile;
    const limits = limitsOf(metrics.language);
    // A rename or a mode change lists the file as changed without touching any of its lines.
    const fileExceeded = hunks?.length === 0 ? [] : collectExceeded(fileThresholds, metrics, limits);
    if (fileExceeded.length > 0) {
      violations.push({ kind: 'file', file, startLine: 1, endLine: metrics.lines.total, exceeded: fileExceeded });
    }
    const checkedFunctions = listCheckedFunctions(checkedFile);
    checkedFunctionCount += checkedFunctions.length;
    for (const fn of checkedFunctions) {
      const exceeded = collectExceeded(functionThresholds, fn, limits);
      if (exceeded.length > 0) {
        const { startLine, endLine } = fn;
        violations.push({ kind: 'function', file, startLine, endLine, name: fn.name ?? '<anonymous>', exceeded });
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
  return { violations: violations.toSorted(compareViolations), checkedFunctionCount };
}

// The kind is compared before the end line because a file violation's end line is corrected after
// this ordering (to the last line that exists), and the order must not depend on that correction.
function compareViolations(left: Violation, right: Violation): number {
  return (
    compareStrings(left.file, right.file) ||
    left.startLine - right.startLine ||
    violationKinds.indexOf(left.kind) - violationKinds.indexOf(right.kind) ||
    left.endLine - right.endLine
  );
}

/** The file's functions or, for a changed file, those the change touches. */
function listCheckedFunctions({ metrics, hunks }: CheckedFile): FunctionMetrics[] {
  const endsByIndentation = metrics.language === 'python';
  return hunks
    ? metrics.functions.filter((fn) =>
        hunks.some((hunk) => touchesSpan(hunk, fn.startLine, fn.endLine, endsByIndentation))
      )
    : metrics.functions;
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
 * deletion) sits between its headStart line and the next one. Where indentation ends a span, its
 * last line is a statement rather than a closing delimiter, so a deletion right after that line may
 * have removed the span's tail; `endsByIndentation` counts it as touching, since the head alone
 * cannot tell it from a deletion after the span.
 */
function touchesSpan(hunk: LineHunk, startLine: number, endLine: number, endsByIndentation = false): boolean {
  return hunk.headCount === 0
    ? hunk.headStart >= startLine && (hunk.headStart < endLine || (endsByIndentation && hunk.headStart === endLine))
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
 * One violation per duplicated region of the file: its clone occurrences, within-file and
 * cross-file, that span at least `minLines` (with `hunks`, only those overlapping added lines),
 * with overlapping occurrences merged into one region.
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
  const isReported = (block: BlockLocation): boolean =>
    block.file === file &&
    duplicationThreshold.measure(block) >= minLines &&
    (!hunks || hunks.some((hunk) => hunk.headCount > 0 && touchesSpan(hunk, block.startLine, block.endLine)));
  const copiesByBlock = new Map<BlockLocation, BlockLocation[]>();
  for (const group of groups) {
    for (const block of group.filter((occurrence) => isReported(occurrence))) {
      copiesByBlock.set(block, group);
    }
  }
  return mergeOverlapping([...copiesByBlock.keys()]).map(({ merged, sources }) => ({
    kind: 'duplication',
    ...merged,
    exceeded: [
      { metric: metricNameOf(duplicationThreshold), value: duplicationThreshold.measure(merged), limit: minLines },
    ],
    // The region's own occurrences are among the copies of the groups it belongs to.
    partners: mergeOverlapping(sources.flatMap((source) => copiesByBlock.get(source) ?? []))
      .map((partner) => partner.merged)
      .filter((partner) => !overlaps(partner, merged)),
  }));
}

/** The locations with those overlapping in the same file merged, ordered by file, then line. */
function mergeOverlapping(locations: readonly BlockLocation[]): { merged: BlockLocation; sources: BlockLocation[] }[] {
  const regions: { merged: BlockLocation; sources: BlockLocation[] }[] = [];
  const ordered = locations.toSorted(
    (left, right) => compareStrings(left.file, right.file) || left.startLine - right.startLine
  );
  for (const location of ordered) {
    const last = regions.at(-1);
    if (last && overlaps(last.merged, location)) {
      last.merged.endLine = Math.max(last.merged.endLine, location.endLine);
      last.sources.push(location);
    } else {
      const { file, startLine, endLine } = location;
      regions.push({ merged: { file, startLine, endLine }, sources: [location] });
    }
  }
  return regions;
}

function overlaps(left: BlockLocation, right: BlockLocation): boolean {
  return left.file === right.file && left.startLine <= right.endLine && right.startLine <= left.endLine;
}

/** Code-unit order, so reports do not depend on the locale. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
