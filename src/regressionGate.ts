import { lcsLength } from './duplication.js';
import type { CodeMetrics, FunctionMetrics } from './types.js';

/**
 * Absolute limits applied only to functions with no base counterpart (SonarQube-style "Clean as
 * You Code"): new code is the one place absolute thresholds are required, since there is nothing
 * to ratchet against.
 */
export interface NewFunctionThresholds {
  maxCognitiveComplexity: number;
  maxNcss: number;
  maxNestingDepth: number;
}

/**
 * Allowances added on top of each base value before a ratchet fires, so legitimate refactorings
 * that transiently worsen one number (e.g. an extraction adding a few NCSS lines) don't trap the
 * agent in a loop.
 */
export interface GateTolerances {
  cognitiveComplexity: number;
  ncss: number;
  nestingDepth: number;
  depDegree: number;
  halsteadVolume: number;
  /** File-total NCSS growth allowed when base functions disappeared (the anti-gaming backstop). */
  fileNcss: number;
  /** Duplicated-line growth allowed per changed file. */
  duplicateLines: number;
}

export interface GateOptions {
  newFunction: NewFunctionThresholds;
  tolerance: GateTolerances;
  /**
   * Minimum token-LCS similarity percent for re-matching a renamed/moved function to its base
   * counterpart, so renames don't appear as delete+add and hit the new-code thresholds.
   */
  matchSimilarityPercent: number;
}

export const defaultGateOptions: GateOptions = {
  // 15 is SonarSource's conventional default; 4 is where the measured cognitive-load response to
  // nesting saturates (Peitek et al. 2021); 60 matches PMD's NcssCount method default.
  newFunction: { maxCognitiveComplexity: 15, maxNcss: 60, maxNestingDepth: 4 },
  // The per-metric allowances are calibrated to admit roughly the same edit: ~5 added statements
  // or one added branch (cognitive 2 ~ nesting 1 ~ ncss 5 ~ depDegree 10 ~ Halstead volume 150;
  // the volume allowance additionally scales with the base value, see ratchetMetrics), so one
  // ratchet cannot block an addition the others deliberately allow.
  tolerance: {
    cognitiveComplexity: 2,
    ncss: 5,
    nestingDepth: 1,
    depDegree: 10,
    halsteadVolume: 150,
    fileNcss: 20,
    duplicateLines: 0,
  },
  matchSimilarityPercent: 70,
};

/** One changed file with both revisions measured; the caller resolves git and duplication data. */
export interface GateFileInput {
  /** Display path (repository-relative head path; base path for deleted files). */
  file: string;
  /** Absent for added files. */
  baseMetrics?: CodeMetrics;
  /** Absent for deleted files. */
  headMetrics?: CodeMetrics;
  /** Token sequences index-parallel to baseMetrics.functions, for similarity re-matching. */
  baseFunctionTokens?: Int32Array[];
  headFunctionTokens?: Int32Array[];
  /** Distinct duplicated lines of this file at the base revision (within-file and cross-file). */
  baseDuplicatedLineCount: number;
  headDuplicatedLineCount: number;
  /** Other files sharing cross-file duplicates with this file at head, as remediation evidence. */
  duplicationPartners: string[];
  /**
   * false: the file only feeds function matching and the duplication universes (it lies outside
   * the gated target directory); no violations are evaluated or reported for it. Default true.
   */
  gated?: boolean;
}

export interface GateViolation {
  gate: 'function-regression' | 'new-function' | 'file-regression' | 'duplication';
  metric: string;
  file: string;
  functionName?: string;
  startLine: number;
  endLine: number;
  /** Absent for new-function violations, which have no base value. */
  baseValue?: number;
  headValue: number;
  /** The largest value that would have passed. */
  allowedValue: number;
  /** One-line human/agent-readable statement with the remediation direction. */
  message: string;
}

/** The gated per-function values of one checked (matched or new) function, for `--full` output. */
export interface CheckedFunctionReport {
  /** The head file (a cross-file move is reported where the function now lives). */
  file: string;
  name: string;
  startLine: number;
  endLine: number;
  /** Absent for new functions. */
  base?: GateFunctionValues;
  head: GateFunctionValues;
}

export interface GateFunctionValues {
  cognitiveComplexity: number;
  ncss: number;
  nestingDepth: number;
  depDegree: number;
  halsteadVolume: number;
}

export interface GateResult {
  violations: GateViolation[];
  checkedFileCount: number;
  checkedFunctionCount: number;
  newFunctionCount: number;
  /** Every checked function with its gated values, ordered by file and line. */
  checkedFunctions: CheckedFunctionReport[];
}

interface RatchetMetric {
  metric: string;
  value: (fn: FunctionMetrics) => number;
  /** The growth allowed on top of the base value before the ratchet fires. */
  allowance: (tolerances: GateTolerances, baseValue: number) => number;
  remediation: string;
  format: (value: number) => string;
}

const formatInteger = String;
const formatFloat = (value: number): string => value.toFixed(1);

/**
 * Gate-eligible per-function metrics (monotone, stable, actionable): a matched function must not
 * worsen any of them beyond its tolerance. "Your change made this function worse" is defensible
 * regardless of metric calibration, so no absolute threshold is involved.
 */
const ratchetMetrics: RatchetMetric[] = [
  {
    metric: 'cognitive complexity',
    value: (fn) => fn.cognitiveComplexity,
    allowance: (tolerances) => tolerances.cognitiveComplexity,
    remediation: 'Simplify the added branching or split the function.',
    format: formatInteger,
  },
  {
    metric: 'NCSS',
    value: (fn) => fn.ncss,
    allowance: (tolerances) => tolerances.ncss,
    remediation: 'Extract the added statements into helper functions or remove them.',
    format: formatInteger,
  },
  {
    metric: 'max nesting depth',
    value: (fn) => fn.nestingDepth,
    allowance: (tolerances) => tolerances.nestingDepth,
    remediation: 'Flatten the added nesting with early returns or extracted helpers.',
    format: formatInteger,
  },
  {
    metric: 'DepDegree',
    value: (fn) => fn.depDegree,
    allowance: (tolerances) => tolerances.depDegree,
    remediation: 'Reduce how many earlier definitions the code reads, e.g. by splitting the data flow.',
    format: formatInteger,
  },
  {
    metric: 'Halstead volume',
    value: (fn) => fn.halstead.volume,
    // Volume grows as length * log2(vocabulary), so a flat allowance that admits ~5 statements in
    // a small function admits barely one in a large-vocabulary function; the relative term keeps
    // the ~5-statement calibration at every function size.
    allowance: (tolerances, baseValue) => Math.max(tolerances.halsteadVolume, baseValue * 0.25),
    remediation: 'Shrink the function: fewer distinct names and operations.',
    format: formatFloat,
  },
];

interface NewFunctionMetric {
  metric: string;
  value: (fn: FunctionMetrics) => number;
  limit: (thresholds: NewFunctionThresholds) => number;
  remediation: string;
}

const newFunctionMetrics: NewFunctionMetric[] = [
  {
    metric: 'cognitive complexity',
    value: (fn) => fn.cognitiveComplexity,
    limit: (thresholds) => thresholds.maxCognitiveComplexity,
    remediation: 'Split the new function or simplify its branching.',
  },
  {
    metric: 'NCSS',
    value: (fn) => fn.ncss,
    limit: (thresholds) => thresholds.maxNcss,
    remediation: 'Split the new function into smaller ones.',
  },
  {
    metric: 'max nesting depth',
    value: (fn) => fn.nestingDepth,
    limit: (thresholds) => thresholds.maxNestingDepth,
    remediation: 'Flatten the new function with early returns or extracted helpers.',
  },
];

/**
 * Evaluates the regression gate over changed files measured at both revisions. Violations are the
 * whole output contract: everything that passes stays silent, so a clean change costs the
 * consuming agent almost no tokens.
 */
export function evaluateRegressionGate(files: GateFileInput[], options: GateOptions): GateResult {
  const matching = matchAllFunctions(files, options.matchSimilarityPercent);
  const violations: GateViolation[] = [];
  const checkedFunctions: CheckedFunctionReport[] = [];
  let checkedPairCount = 0;
  let newFunctionCount = 0;

  for (const pair of matching.pairs) {
    const file = files[pair.headFileIndex] as GateFileInput;
    if (file.gated === false) {
      continue;
    }
    checkedPairCount += 1;
    violations.push(...checkRatchets(file.file, pair.base, pair.head, options.tolerance));
    checkedFunctions.push(toFunctionReport(file.file, pair.head, pair.base));
  }

  let gatedFileCount = 0;
  for (const [fileIndex, file] of files.entries()) {
    if (file.gated === false) {
      continue;
    }
    gatedFileCount += 1;
    const headFunctions = file.headMetrics?.functions ?? [];
    const headMatched = matching.headMatched[fileIndex] as boolean[];
    for (const [functionIndex, fn] of headFunctions.entries()) {
      if (headMatched[functionIndex]) {
        continue;
      }
      newFunctionCount += 1;
      violations.push(...checkNewFunction(file.file, fn, options.newFunction));
      checkedFunctions.push(toFunctionReport(file.file, fn));
    }
    violations.push(...checkFileBackstops(file, hasSplitEvidence(file, fileIndex, matching), violations, options));
    violations.push(...checkDuplication(file, options.tolerance));
  }

  violations.sort((left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine);
  checkedFunctions.sort((left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine);
  return {
    violations,
    checkedFileCount: gatedFileCount,
    checkedFunctionCount: checkedPairCount + newFunctionCount,
    newFunctionCount,
    checkedFunctions,
  };
}

/**
 * Similarity below the match threshold but above this marks a removed function's content as
 * reappearing inside unmatched new code — the signature of a split or evasive rewrite.
 */
const splitEvidenceSimilarityPercent = 30;

/**
 * Whether a removed NAMED base function's content partially reappears in an unmatched head
 * function of the same file. This is what arms the file-level backstops: splitting a function to
 * hide a worsening behind the (laxer) new-code thresholds leaves its fragments partially similar
 * to the removed original, while an ordinary "delete a helper, add an unrelated function" change
 * shares nothing and must not have its brand-new code re-judged against the file's old aggregates.
 */
function hasSplitEvidence(file: GateFileInput, fileIndex: number, matching: FunctionMatching): boolean {
  const baseFunctions = file.baseMetrics?.functions ?? [];
  const baseMatchedFlags = matching.baseMatched[fileIndex] as boolean[];
  const headMatchedFlags = matching.headMatched[fileIndex] as boolean[];
  const removedNamed = baseFunctions.flatMap((fn, index) =>
    !baseMatchedFlags[index] && fn.name !== undefined ? [index] : []
  );
  if (removedNamed.length === 0) {
    return false;
  }
  const unmatchedHead = (file.headMetrics?.functions ?? []).flatMap((_, index) =>
    headMatchedFlags[index] ? [] : [index]
  );
  if (removedNamed.length * unmatchedHead.length > maxSimilarityComparisons) {
    return false;
  }
  return removedNamed.some((baseIndex) =>
    unmatchedHead.some(
      (headIndex) =>
        tokenSimilarityPercent(
          file.baseFunctionTokens?.[baseIndex],
          file.headFunctionTokens?.[headIndex],
          splitEvidenceSimilarityPercent
        ) >= splitEvidenceSimilarityPercent
    )
  );
}

function toFunctionReport(file: string, head: FunctionMetrics, base?: FunctionMetrics): CheckedFunctionReport {
  return {
    file,
    name: head.name ?? '<anonymous>',
    startLine: head.startLine,
    endLine: head.endLine,
    base: base ? toFunctionValues(base) : undefined,
    head: toFunctionValues(head),
  };
}

function toFunctionValues(fn: FunctionMetrics): GateFunctionValues {
  return {
    cognitiveComplexity: fn.cognitiveComplexity,
    ncss: fn.ncss,
    nestingDepth: fn.nestingDepth,
    depDegree: fn.depDegree,
    halsteadVolume: fn.halstead.volume,
  };
}

/** One side of a match candidate: a function of one changed file plus its token sequence. */
interface IndexedFunction {
  fileIndex: number;
  functionIndex: number;
  fn: FunctionMetrics;
  tokens: Int32Array | undefined;
}

interface MatchedPair {
  base: FunctionMetrics;
  head: FunctionMetrics;
  headFileIndex: number;
}

interface FunctionMatching {
  pairs: MatchedPair[];
  /** Per file, per function index: whether it found a counterpart (anywhere in the change set). */
  baseMatched: boolean[][];
  headMatched: boolean[][];
}

interface SimilarityCandidate {
  similarity: number;
  basePosition: number;
  headPosition: number;
}

/**
 * Matches head functions to base functions: within each file first by name + arity, then by name
 * alone (signature changes) — resolving ambiguous same-name groups by token similarity instead of
 * list position, so an inserted overload cannot shift the pairing — and finally by
 * normalized-token LCS similarity across ALL changed files (renames and moves between files,
 * reusing the near-miss clone machinery), so refactorings don't appear as delete+add and hit the
 * new-code thresholds.
 */
function matchAllFunctions(files: GateFileInput[], matchSimilarityPercent: number): FunctionMatching {
  const baseMatched = files.map((file) => (file.baseMetrics?.functions ?? []).map(() => false));
  const headMatched = files.map((file) => (file.headMetrics?.functions ?? []).map(() => false));
  const pairs: MatchedPair[] = [];

  for (const fileIndex of files.keys()) {
    const pairByKey = (key: (fn: FunctionMetrics) => string | undefined): void => {
      const baseByKey = groupByKey(collectUnmatched(files, baseMatched, 'base', fileIndex), key);
      const headByKey = groupByKey(collectUnmatched(files, headMatched, 'head', fileIndex), key);
      for (const [groupKey, baseGroup] of baseByKey) {
        pairGroup(baseGroup, headByKey.get(groupKey) ?? [], baseMatched, headMatched, pairs);
      }
    };
    pairByKey((fn) => (fn.name === undefined ? undefined : `${fn.name}\u0000${fn.parameterCount}`));
    pairByKey((fn) => fn.name);
  }

  pairAcrossChangeSet(files, baseMatched, headMatched, pairs, matchSimilarityPercent);
  return { pairs, baseMatched, headMatched };
}

/** Unmatched functions of one file (or of every file when onlyFileIndex is undefined). */
function collectUnmatched(
  files: GateFileInput[],
  matchedByFile: boolean[][],
  side: 'base' | 'head',
  onlyFileIndex?: number
): IndexedFunction[] {
  const unmatched: IndexedFunction[] = [];
  for (const [fileIndex, file] of files.entries()) {
    if (onlyFileIndex !== undefined && fileIndex !== onlyFileIndex) {
      continue;
    }
    const matched = matchedByFile[fileIndex] as boolean[];
    const metrics = side === 'base' ? file.baseMetrics : file.headMetrics;
    const tokens = side === 'base' ? file.baseFunctionTokens : file.headFunctionTokens;
    for (const [functionIndex, fn] of (metrics?.functions ?? []).entries()) {
      if (!matched[functionIndex]) {
        unmatched.push({ fileIndex, functionIndex, fn, tokens: tokens?.[functionIndex] });
      }
    }
  }
  return unmatched;
}

function groupByKey(
  functions: IndexedFunction[],
  key: (fn: FunctionMetrics) => string | undefined
): Map<string, IndexedFunction[]> {
  const groups = new Map<string, IndexedFunction[]>();
  for (const indexed of functions) {
    const groupKey = key(indexed.fn);
    if (groupKey === undefined) {
      continue;
    }
    const group = groups.get(groupKey) ?? [];
    group.push(indexed);
    groups.set(groupKey, group);
  }
  return groups;
}

/** Bounds the quadratic similarity passes; beyond this, leftovers gate as new/removed functions. */
const maxSimilarityComparisons = 10_000;

/**
 * Pairs one key group. An unambiguous 1x1 group matches directly; a larger group (same-name
 * methods of different classes, overload sets) is assigned best-similarity-first so an inserted
 * function cannot shift the pairing of the others. The names already match, so any pairing is
 * acceptable: similarity only ORDERS the assignment (no threshold), and without token sequences
 * (or in an oversized group) the stable tie-break reproduces positional order.
 */
function pairGroup(
  baseGroup: IndexedFunction[],
  headGroup: IndexedFunction[],
  baseMatched: boolean[][],
  headMatched: boolean[][],
  pairs: MatchedPair[]
): void {
  const ambiguous =
    baseGroup.length + headGroup.length > 2 && baseGroup.length * headGroup.length <= maxSimilarityComparisons;
  const candidates: SimilarityCandidate[] = [];
  for (const [basePosition, base] of baseGroup.entries()) {
    for (const [headPosition, head] of headGroup.entries()) {
      candidates.push({
        similarity: ambiguous ? tokenSimilarityPercent(base.tokens, head.tokens, 0) : 0,
        basePosition,
        headPosition,
      });
    }
  }
  takeMaximumMatches(candidates, baseGroup, headGroup, baseMatched, headMatched, pairs);
}

/** Cross-file (and remaining within-file) similarity matching over every unmatched function. */
function pairAcrossChangeSet(
  files: GateFileInput[],
  baseMatched: boolean[][],
  headMatched: boolean[][],
  pairs: MatchedPair[],
  matchSimilarityPercent: number
): void {
  const unmatchedBase = collectUnmatched(files, baseMatched, 'base');
  const unmatchedHead = collectUnmatched(files, headMatched, 'head');
  if (unmatchedBase.length * unmatchedHead.length > maxSimilarityComparisons) {
    return;
  }

  const candidates: SimilarityCandidate[] = [];
  for (const [basePosition, base] of unmatchedBase.entries()) {
    for (const [headPosition, head] of unmatchedHead.entries()) {
      const similarity = tokenSimilarityPercent(base.tokens, head.tokens, matchSimilarityPercent);
      if (similarity >= matchSimilarityPercent) {
        candidates.push({ similarity, basePosition, headPosition });
      }
    }
  }
  takeMaximumMatches(candidates, unmatchedBase, unmatchedHead, baseMatched, headMatched, pairs);
}

/**
 * Assignment over the candidate edges: a greedy best-similarity-first seed, then Kuhn's
 * augmenting paths for the bases the seed left unmatched. The seed keeps every exact/strong pair
 * (and the positional order of all-tied groups) exactly as taken, because augmentation runs only
 * when it increases cardinality — a function whose only counterpart was taken by a slightly
 * better pair is then re-matched by rewiring instead of being falsely gated as new code. This
 * reaches maximum cardinality (augmenting from a maximal matching does) without letting the
 * augmentation displace pairs it never needed to touch.
 */
function takeMaximumMatches(
  candidates: SimilarityCandidate[],
  baseGroup: IndexedFunction[],
  headGroup: IndexedFunction[],
  baseMatched: boolean[][],
  headMatched: boolean[][],
  pairs: MatchedPair[]
): void {
  candidates.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.basePosition - right.basePosition ||
      left.headPosition - right.headPosition
  );
  const adjacency = new Map<number, number[]>();
  const baseOfHead = new Map<number, number>();
  const matchedBases = seedGreedyMatches(candidates, adjacency, baseOfHead);
  for (const basePosition of [...adjacency.keys()].toSorted((left, right) => left - right)) {
    if (!matchedBases.has(basePosition)) {
      tryAugment(basePosition, adjacency, baseOfHead, new Set());
    }
  }

  for (const [headPosition, basePosition] of [...baseOfHead.entries()].toSorted((left, right) => left[0] - right[0])) {
    const base = baseGroup[basePosition] as IndexedFunction;
    const head = headGroup[headPosition] as IndexedFunction;
    (baseMatched[base.fileIndex] as boolean[])[base.functionIndex] = true;
    (headMatched[head.fileIndex] as boolean[])[head.functionIndex] = true;
    pairs.push({ base: base.fn, head: head.fn, headFileIndex: head.fileIndex });
  }
}

/** Fills the adjacency lists and takes each best edge whose endpoints are both still free. */
function seedGreedyMatches(
  candidates: SimilarityCandidate[],
  adjacency: Map<number, number[]>,
  baseOfHead: Map<number, number>
): Set<number> {
  const matchedBases = new Set<number>();
  for (const candidate of candidates) {
    const edges = adjacency.get(candidate.basePosition) ?? [];
    edges.push(candidate.headPosition);
    adjacency.set(candidate.basePosition, edges);
    if (!matchedBases.has(candidate.basePosition) && !baseOfHead.has(candidate.headPosition)) {
      baseOfHead.set(candidate.headPosition, candidate.basePosition);
      matchedBases.add(candidate.basePosition);
    }
  }
  return matchedBases;
}

/** One Kuhn augmentation step: rewires existing matches only when that frees a head for `basePosition`. */
function tryAugment(
  basePosition: number,
  adjacency: Map<number, number[]>,
  baseOfHead: Map<number, number>,
  visitedHeads: Set<number>
): boolean {
  for (const headPosition of adjacency.get(basePosition) ?? []) {
    if (visitedHeads.has(headPosition)) {
      continue;
    }
    visitedHeads.add(headPosition);
    const currentBase = baseOfHead.get(headPosition);
    if (currentBase === undefined || tryAugment(currentBase, adjacency, baseOfHead, visitedHeads)) {
      baseOfHead.set(headPosition, basePosition);
      return true;
    }
  }
  return false;
}

/** Token-LCS similarity of two sequences relative to the longer one, in percent (0 when unusable). */
function tokenSimilarityPercent(
  base: Int32Array | undefined,
  head: Int32Array | undefined,
  minPercent: number
): number {
  if (!base || !head || base.length === 0 || head.length === 0) {
    return 0;
  }
  // The LCS cannot exceed the shorter sequence, so mismatched lengths are pruned for free.
  const maxLength = Math.max(base.length, head.length);
  if (Math.min(base.length, head.length) * 100 < minPercent * maxLength) {
    return 0;
  }
  return (lcsLength(base, head) * 100) / maxLength;
}

function checkRatchets(
  file: string,
  base: FunctionMetrics,
  head: FunctionMetrics,
  tolerances: GateTolerances
): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const ratchet of ratchetMetrics) {
    const baseValue = ratchet.value(base);
    const headValue = ratchet.value(head);
    const allowedValue = baseValue + ratchet.allowance(tolerances, baseValue);
    if (headValue > allowedValue) {
      const name = head.name ?? '<anonymous>';
      violations.push({
        gate: 'function-regression',
        metric: ratchet.metric,
        file,
        functionName: name,
        startLine: head.startLine,
        endLine: head.endLine,
        baseValue,
        headValue,
        allowedValue,
        message:
          `${file}:${head.startLine}-${head.endLine} ${name}: ${ratchet.metric} worsened ` +
          `${ratchet.format(baseValue)} -> ${ratchet.format(headValue)} (allowed <= ${ratchet.format(allowedValue)}). ` +
          ratchet.remediation,
      });
    }
  }
  return violations;
}

function checkNewFunction(file: string, fn: FunctionMetrics, thresholds: NewFunctionThresholds): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const check of newFunctionMetrics) {
    const headValue = check.value(fn);
    const allowedValue = check.limit(thresholds);
    if (headValue > allowedValue) {
      const name = fn.name ?? '<anonymous>';
      violations.push({
        gate: 'new-function',
        metric: check.metric,
        file,
        functionName: name,
        startLine: fn.startLine,
        endLine: fn.endLine,
        headValue,
        allowedValue,
        message:
          `${file}:${fn.startLine}-${fn.endLine} new function ${name}: ${check.metric} ${headValue} ` +
          `exceeds the new-code limit ${allowedValue}. ${check.remediation}`,
      });
    }
  }
  return violations;
}

/**
 * Anti-gaming backstops: splitting a function resets its entity identity and could hide a
 * worsening behind the (laxer) new-code thresholds, so when a removed named function's content
 * reappears in unmatched new code (see hasSplitEvidence) the file-level aggregates ratchet too —
 * the max cognitive complexity per file and the file's total NCSS. Purely additive changes and
 * unrelated remove-plus-add changes stay ungated. The max-cognitive backstop is also skipped when
 * a function-level cognitive violation already reports the file's maximum, since it would only
 * restate it.
 */
function checkFileBackstops(
  file: GateFileInput,
  splitEvidence: boolean,
  reportedViolations: GateViolation[],
  options: GateOptions
): GateViolation[] {
  const { baseMetrics, headMetrics } = file;
  if (!baseMetrics || !headMetrics || !splitEvidence) {
    return [];
  }
  const violations: GateViolation[] = [];
  const tolerances = options.tolerance;

  const maximumAlreadyReported = reportedViolations.some(
    (violation) =>
      violation.file === file.file &&
      violation.metric === 'cognitive complexity' &&
      (violation.gate === 'function-regression' || violation.gate === 'new-function') &&
      violation.headValue === headMetrics.maxCognitiveComplexity
  );
  const allowedMaxCognitive = baseMetrics.maxCognitiveComplexity + tolerances.cognitiveComplexity;
  if (!maximumAlreadyReported && headMetrics.maxCognitiveComplexity > allowedMaxCognitive) {
    const worst = findMostComplexFunction(headMetrics.functions);
    const startLine = worst?.startLine ?? 1;
    const endLine = worst?.endLine ?? headMetrics.lines.total;
    violations.push({
      gate: 'file-regression',
      metric: 'file max cognitive complexity',
      file: file.file,
      functionName: worst?.name ?? undefined,
      startLine,
      endLine,
      baseValue: baseMetrics.maxCognitiveComplexity,
      headValue: headMetrics.maxCognitiveComplexity,
      allowedValue: allowedMaxCognitive,
      message:
        `${file.file}:${startLine}-${endLine}: the file's max cognitive complexity worsened ` +
        `${baseMetrics.maxCognitiveComplexity} -> ${headMetrics.maxCognitiveComplexity} ` +
        `(allowed <= ${allowedMaxCognitive}). Simplify or split the most complex ` +
        `function${worst ? ` (${worst.name ?? '<anonymous>'})` : ''}.`,
    });
  }

  const allowedFileNcss = baseMetrics.ncssCount + tolerances.fileNcss;
  if (headMetrics.ncssCount > allowedFileNcss) {
    violations.push({
      gate: 'file-regression',
      metric: 'file NCSS',
      file: file.file,
      startLine: 1,
      endLine: headMetrics.lines.total,
      baseValue: baseMetrics.ncssCount,
      headValue: headMetrics.ncssCount,
      allowedValue: allowedFileNcss,
      message:
        `${file.file}:1-${headMetrics.lines.total}: functions were removed or split while the file grew from NCSS ` +
        `${baseMetrics.ncssCount} to ${headMetrics.ncssCount} (allowed <= ${allowedFileNcss}). ` +
        `Remove the added statements or move genuinely new code into its own module.`,
    });
  }

  return violations;
}

function findMostComplexFunction(functions: FunctionMetrics[]): FunctionMetrics | undefined {
  let worst: FunctionMetrics | undefined;
  for (const fn of functions) {
    if (!worst || fn.cognitiveComplexity > worst.cognitiveComplexity) {
      worst = fn;
    }
  }
  return worst;
}

/**
 * No new duplication: the distinct duplicated lines of a changed file (within-file plus
 * cross-file against the whole project, so copy-paste from existing code into new files is
 * caught) must not exceed the base revision's count.
 */
function checkDuplication(file: GateFileInput, tolerances: GateTolerances): GateViolation[] {
  const allowedValue = file.baseDuplicatedLineCount + tolerances.duplicateLines;
  if (file.headDuplicatedLineCount <= allowedValue) {
    return [];
  }
  const partners = file.duplicationPartners.slice(0, 3).join(', ');
  const endLine = file.headMetrics?.lines.total ?? 1;
  return [
    {
      gate: 'duplication',
      metric: 'duplicated lines',
      file: file.file,
      startLine: 1,
      endLine,
      baseValue: file.baseDuplicatedLineCount,
      headValue: file.headDuplicatedLineCount,
      allowedValue,
      message:
        `${file.file}:1-${endLine}: duplicated lines increased ${file.baseDuplicatedLineCount} -> ` +
        `${file.headDuplicatedLineCount} (allowed <= ${allowedValue}). Deduplicate` +
        `${partners ? ` against ${partners}` : ' the repeated code'} by extracting a shared helper.`,
    },
  ];
}
