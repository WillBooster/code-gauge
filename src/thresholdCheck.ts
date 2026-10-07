import type { CrossFileDuplicateBlockGroup, CrossFileDuplicationMetrics } from './crossFileDuplication.js';
import type { LineHunk } from './git.js';
import {
  duplicationThreshold,
  fileThresholds,
  functionThresholds,
  levels,
  metricNameOf,
  type Level,
  type LimitsByLevel,
  type Threshold,
} from './thresholds.js';
import type { CodeMetrics, CognitiveBlock, FunctionMetrics } from './types.js';

/** A measured file to check, under the path cross-file duplication knows it by. */
export interface CheckedFile {
  file: string;
  metrics: CodeMetrics;
  /**
   * The file's 1-based lines that are neither blank nor comment-only, by which its duplicated
   * blocks are measured; without it, every line of a block counts.
   */
  codeLineNumbers?: ReadonlySet<number>;
  /** The change to the file; when set, only what the change touches is checked. */
  hunks?: readonly LineHunk[];
}

export interface ExceededLimit {
  metric: string;
  value: number;
  /** The most severe level whose limit the value violates. */
  level: Level;
  /** That level's limit: the value is allowed up to it; a duplicated block is allowed below it. */
  limit: number;
}

export interface BlockLocation {
  file: string;
  startLine: number;
  endLine: number;
}

export interface Violation extends BlockLocation {
  kind: 'function' | 'file' | 'duplication';
  /** The most severe level among `exceeded`. */
  level: Level;
  /** The function's name, qualified with the class it is a member of, for kind `function`. */
  name?: string;
  exceeded: ExceededLimit[];
  /**
   * The parts adding the most to the cognitive complexity, largest first, for a function that
   * exceeds a limit of it.
   */
  largestBlocks?: CognitiveBlock[];
  /** The other copies of the block, largest first, for kind `duplication`. */
  partners?: BlockLocation[];
}

export interface CheckResult {
  violations: Violation[];
  checkedFunctionCount: number;
}

const violationKinds: readonly Violation['kind'][] = ['file', 'function', 'duplication'];

const cognitiveComplexityMetric = 'functionCognitiveComplexity';

const nestedInclusiveMetrics = new Set(
  functionThresholds
    .filter(({ includesNestedFunctions }) => includesNestedFunctions)
    .map((threshold) => metricNameOf(threshold))
);

/** Every limit the files exceed, errors first, then ordered by path, then line. */
export function checkThresholds(
  files: readonly CheckedFile[],
  crossFileDuplication: CrossFileDuplicationMetrics | undefined,
  limitsOf: (language: string) => LimitsByLevel
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
      violations.push(toViolation({ file, startLine: 1, endLine: metrics.lines.total }, 'file', fileExceeded));
    }
    const checkedFunctions = listCheckedFunctions(checkedFile);
    checkedFunctionCount += checkedFunctions.length;
    const exceedingFunctions = checkedFunctions
      .map((fn) => ({ fn, exceeded: collectExceeded(functionThresholds, fn, limits) }))
      .filter(({ exceeded }) => exceeded.length > 0);
    for (const { fn, exceeded } of exceedingFunctions) {
      const ownExceeded = exceeded.filter((limit) => !isReportedByEnclosingFunction(limit, fn, exceedingFunctions));
      if (ownExceeded.length > 0) {
        violations.push(toFunctionViolation(file, fn, ownExceeded));
      }
    }
    violations.push(...collectDuplicationViolations(checkedFile, crossFileGroupsByFile.get(file) ?? [], limits));
  }
  return { violations: violations.toSorted(compareViolations), checkedFunctionCount };
}

// The kind is compared before the end line because a file violation's end line is corrected after
// this ordering (to the last line that exists), and the order must not depend on that correction.
function compareViolations(left: Violation, right: Violation): number {
  return (
    levels.indexOf(right.level) - levels.indexOf(left.level) ||
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

/**
 * Whether a function enclosing `fn` exceeds the same limit with a value that covers `fn`, so
 * reporting it for `fn` too would count the same code twice. The enclosing value is at least that
 * of `fn` and both share the file's limits, so its level is never milder.
 */
function isReportedByEnclosingFunction(
  limit: ExceededLimit,
  fn: FunctionMetrics,
  exceedingFunctions: readonly { fn: FunctionMetrics; exceeded: ExceededLimit[] }[]
): boolean {
  if (!nestedInclusiveMetrics.has(limit.metric)) {
    return false;
  }
  return exceedingFunctions.some(
    (outer) => outer.fn !== fn && encloses(outer.fn, fn) && outer.exceeded.some(({ metric }) => metric === limit.metric)
  );
}

function encloses(outer: FunctionMetrics, inner: FunctionMetrics): boolean {
  const startsBefore =
    outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startColumn <= inner.startColumn);
  const endsAfter =
    outer.endLine > inner.endLine || (outer.endLine === inner.endLine && outer.endColumn >= inner.endColumn);
  return startsBefore && endsAfter;
}

function toFunctionViolation(file: string, fn: FunctionMetrics, exceeded: ExceededLimit[]): Violation {
  const { startLine, endLine } = fn;
  const name = fn.name ?? '<anonymous>';
  const exceedsCognitiveComplexity = exceeded.some(({ metric }) => metric === cognitiveComplexityMetric);
  return {
    ...toViolation({ file, startLine, endLine }, 'function', exceeded),
    name: fn.containerName ? `${fn.containerName}.${name}` : name,
    ...(exceedsCognitiveComplexity && fn.cognitiveBlocks.length > 0 && { largestBlocks: fn.cognitiveBlocks }),
  };
}

function toViolation(location: BlockLocation, kind: Violation['kind'], exceeded: ExceededLimit[]): Violation {
  const level = exceeded.some((limit) => limit.level === 'error') ? 'error' : 'warning';
  return { kind, level, ...location, exceeded };
}

function collectExceeded<Subject>(
  thresholds: readonly Threshold<Subject>[],
  subject: Subject,
  limits: LimitsByLevel
): ExceededLimit[] {
  return thresholds.flatMap((threshold) => findExceeded(threshold, subject, limits, (value, limit) => value > limit));
}

/** The most severe violated limit of the threshold, if any. */
function findExceeded<Subject>(
  threshold: Threshold<Subject>,
  subject: Subject,
  limits: LimitsByLevel,
  violates: (value: number, limit: number) => boolean
): ExceededLimit[] {
  const value = threshold.measure(subject);
  const level = levels.findLast((candidate) => violates(value, limits[candidate][threshold.key] as number));
  return level
    ? [{ metric: metricNameOf(threshold), value, level, limit: limits[level][threshold.key] as number }]
    : [];
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
 * cross-file, that span at least the line count of a level (with `hunks`, only those overlapping
 * added lines), with overlapping occurrences merged into one region.
 */
function collectDuplicationViolations(
  { file, metrics, hunks, codeLineNumbers }: CheckedFile,
  crossFileGroups: readonly CrossFileDuplicateBlockGroup[],
  limits: LimitsByLevel
): Violation[] {
  const countCodeLines = (block: BlockLocation): number => {
    if (!codeLineNumbers) return countLines(block);
    let count = 0;
    for (let line = block.startLine; line <= block.endLine; line++) {
      if (codeLineNumbers.has(line)) count += 1;
    }
    return count;
  };
  const findExceededLines = (block: BlockLocation): ExceededLimit[] =>
    findExceeded(
      duplicationThreshold,
      { codeLineCount: countCodeLines(block) },
      limits,
      (value, limit) => value >= limit
    );
  const groups: BlockLocation[][] = [
    ...metrics.duplication.duplicateBlockGroups.map((group) => group.map((occurrence) => ({ ...occurrence, file }))),
    ...crossFileGroups.map((group) => group.occurrences),
  ];
  const isReported = (block: BlockLocation): boolean =>
    block.file === file &&
    findExceededLines(block).length > 0 &&
    (!hunks || hunks.some((hunk) => hunk.headCount > 0 && touchesSpan(hunk, block.startLine, block.endLine)));
  const copiesByBlock = new Map<BlockLocation, BlockLocation[]>();
  for (const group of groups) {
    for (const block of group.filter((occurrence) => isReported(occurrence))) {
      copiesByBlock.set(block, group);
    }
  }
  return mergeOverlapping([...copiesByBlock.keys()]).map(({ merged, sources }) => ({
    ...toViolation(merged, 'duplication', findExceededLines(merged)),
    // The region's own occurrences are among the copies of the groups it belongs to.
    // The region merges every clone that overlaps it, so its copies range from whole copies of it
    // to a few lines matching one fragment; the largest say the most about what to share.
    partners: mergeOverlapping(sources.flatMap((source) => copiesByBlock.get(source) ?? []))
      .map((partner) => partner.merged)
      .filter((partner) => !overlaps(partner, merged))
      .toSorted((left, right) => countLines(right) - countLines(left)),
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

function countLines({ startLine, endLine }: BlockLocation): number {
  return endLine - startLine + 1;
}

function overlaps(left: BlockLocation, right: BlockLocation): boolean {
  return left.file === right.file && left.startLine <= right.endLine && right.startLine <= left.endLine;
}

/** Code-unit order, so reports do not depend on the locale. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
