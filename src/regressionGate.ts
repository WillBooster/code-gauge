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
  // (ncss 5 ~ depDegree 10 ~ Halstead volume 150), so one ratchet cannot block an addition the
  // others deliberately allow.
  tolerance: {
    cognitiveComplexity: 2,
    ncss: 5,
    nestingDepth: 0,
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

export interface GateResult {
  violations: GateViolation[];
  checkedFileCount: number;
  checkedFunctionCount: number;
  newFunctionCount: number;
}

interface RatchetMetric {
  metric: string;
  value: (fn: FunctionMetrics) => number;
  tolerance: (tolerances: GateTolerances) => number;
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
    tolerance: (tolerances) => tolerances.cognitiveComplexity,
    remediation: 'Simplify the added branching or split the function.',
    format: formatInteger,
  },
  {
    metric: 'NCSS',
    value: (fn) => fn.ncss,
    tolerance: (tolerances) => tolerances.ncss,
    remediation: 'Extract the added statements into helper functions or remove them.',
    format: formatInteger,
  },
  {
    metric: 'max nesting depth',
    value: (fn) => fn.nestingDepth,
    tolerance: (tolerances) => tolerances.nestingDepth,
    remediation: 'Flatten the added nesting with early returns or extracted helpers.',
    format: formatInteger,
  },
  {
    metric: 'DepDegree',
    value: (fn) => fn.depDegree,
    tolerance: (tolerances) => tolerances.depDegree,
    remediation: 'Reduce how many earlier definitions the code reads, e.g. by splitting the data flow.',
    format: formatInteger,
  },
  {
    metric: 'Halstead volume',
    value: (fn) => fn.halstead.volume,
    tolerance: (tolerances) => tolerances.halsteadVolume,
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
  const violations: GateViolation[] = [];
  let checkedFunctionCount = 0;
  let newFunctionCount = 0;

  for (const file of files) {
    const matching = matchFunctions(file, options.matchSimilarityPercent);
    checkedFunctionCount += matching.pairs.length + matching.newFunctions.length;
    newFunctionCount += matching.newFunctions.length;

    for (const pair of matching.pairs) {
      violations.push(...checkRatchets(file.file, pair.base, pair.head, options.tolerance));
    }
    for (const fn of matching.newFunctions) {
      violations.push(...checkNewFunction(file.file, fn, options.newFunction));
    }
    violations.push(...checkFileBackstops(file, matching.removedFunctionCount, violations, options));
    violations.push(...checkDuplication(file, options.tolerance));
  }

  violations.sort((left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine);
  return { violations, checkedFileCount: files.length, checkedFunctionCount, newFunctionCount };
}

interface FunctionMatching {
  pairs: { base: FunctionMetrics; head: FunctionMetrics }[];
  newFunctions: FunctionMetrics[];
  removedFunctionCount: number;
}

/**
 * Matches head functions to base functions: first by name + arity, then by name alone (signature
 * changes), and finally by normalized-token LCS similarity (renames/moves, reusing the near-miss
 * clone machinery), so refactorings don't appear as delete+add and hit the new-code thresholds.
 */
function matchFunctions(file: GateFileInput, matchSimilarityPercent: number): FunctionMatching {
  const baseFunctions = file.baseMetrics?.functions ?? [];
  const headFunctions = file.headMetrics?.functions ?? [];
  const baseMatched = baseFunctions.map(() => false);
  const headMatched = headFunctions.map(() => false);
  const pairs: FunctionMatching['pairs'] = [];

  const pairByKey = (key: (fn: FunctionMetrics) => string | undefined): void => {
    const baseByKey = groupIndexesByKey(baseFunctions, baseMatched, key);
    const headByKey = groupIndexesByKey(headFunctions, headMatched, key);
    for (const [groupKey, baseIndexes] of baseByKey) {
      const headIndexes = headByKey.get(groupKey) ?? [];
      for (let position = 0; position < Math.min(baseIndexes.length, headIndexes.length); position += 1) {
        const baseIndex = baseIndexes[position] as number;
        const headIndex = headIndexes[position] as number;
        baseMatched[baseIndex] = true;
        headMatched[headIndex] = true;
        pairs.push({
          base: baseFunctions[baseIndex] as FunctionMetrics,
          head: headFunctions[headIndex] as FunctionMetrics,
        });
      }
    }
  };

  pairByKey((fn) => (fn.name === undefined ? undefined : `${fn.name} ${fn.parameterCount}`));
  pairByKey((fn) => fn.name);
  pairBySimilarity(file, baseFunctions, headFunctions, baseMatched, headMatched, pairs, matchSimilarityPercent);

  return {
    pairs,
    newFunctions: headFunctions.filter((_, index) => !headMatched[index]),
    removedFunctionCount: baseMatched.filter((matched) => !matched).length,
  };
}

function groupIndexesByKey(
  functions: FunctionMetrics[],
  matched: boolean[],
  key: (fn: FunctionMetrics) => string | undefined
): Map<string, number[]> {
  const indexesByKey = new Map<string, number[]>();
  for (const [index, fn] of functions.entries()) {
    if (matched[index]) {
      continue;
    }
    const groupKey = key(fn);
    if (groupKey === undefined) {
      continue;
    }
    const indexes = indexesByKey.get(groupKey) ?? [];
    indexes.push(index);
    indexesByKey.set(groupKey, indexes);
  }
  return indexesByKey;
}

/** Bounds the quadratic similarity pass; beyond this, leftovers gate as new/removed functions. */
const maxSimilarityComparisons = 10_000;

function pairBySimilarity(
  file: GateFileInput,
  baseFunctions: FunctionMetrics[],
  headFunctions: FunctionMetrics[],
  baseMatched: boolean[],
  headMatched: boolean[],
  pairs: FunctionMatching['pairs'],
  matchSimilarityPercent: number
): void {
  const baseTokens = file.baseFunctionTokens;
  const headTokens = file.headFunctionTokens;
  if (!baseTokens || !headTokens) {
    return;
  }
  const unmatchedBase = baseFunctions.flatMap((_, index) => (baseMatched[index] ? [] : [index]));
  const unmatchedHead = headFunctions.flatMap((_, index) => (headMatched[index] ? [] : [index]));
  if (unmatchedBase.length * unmatchedHead.length > maxSimilarityComparisons) {
    return;
  }

  const candidates = unmatchedBase.flatMap((baseIndex) =>
    unmatchedHead.flatMap((headIndex) => {
      const similarity = tokenSimilarityPercent(baseTokens[baseIndex], headTokens[headIndex], matchSimilarityPercent);
      return similarity >= matchSimilarityPercent ? [{ similarity, baseIndex, headIndex }] : [];
    })
  );

  candidates.sort(
    (left, right) =>
      right.similarity - left.similarity || left.baseIndex - right.baseIndex || left.headIndex - right.headIndex
  );
  for (const candidate of candidates) {
    if (baseMatched[candidate.baseIndex] || headMatched[candidate.headIndex]) {
      continue;
    }
    baseMatched[candidate.baseIndex] = true;
    headMatched[candidate.headIndex] = true;
    pairs.push({
      base: baseFunctions[candidate.baseIndex] as FunctionMetrics,
      head: headFunctions[candidate.headIndex] as FunctionMetrics,
    });
  }
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
    const allowedValue = baseValue + ratchet.tolerance(tolerances);
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
 * worsening behind the (laxer) new-code thresholds, so when base functions disappeared (i.e. some
 * entity identity was reset) the file-level aggregates ratchet too — the max cognitive complexity
 * per file and the file's total NCSS. Purely additive changes keep every base function matched
 * and stay ungated, so adding a legitimately complex new function does not trip the file gate.
 * The max-cognitive backstop is also skipped when a function-level cognitive violation was
 * already reported in this file, since it would only restate it.
 */
function checkFileBackstops(
  file: GateFileInput,
  removedFunctionCount: number,
  reportedViolations: GateViolation[],
  options: GateOptions
): GateViolation[] {
  const { baseMetrics, headMetrics } = file;
  if (!baseMetrics || !headMetrics || removedFunctionCount === 0) {
    return [];
  }
  const violations: GateViolation[] = [];
  const tolerances = options.tolerance;

  const cognitiveAlreadyReported = reportedViolations.some(
    (violation) =>
      violation.file === file.file &&
      violation.metric === 'cognitive complexity' &&
      (violation.gate === 'function-regression' || violation.gate === 'new-function')
  );
  const allowedMaxCognitive = baseMetrics.maxCognitiveComplexity + tolerances.cognitiveComplexity;
  if (!cognitiveAlreadyReported && headMetrics.maxCognitiveComplexity > allowedMaxCognitive) {
    const worst = findMostComplexFunction(headMetrics.functions);
    violations.push({
      gate: 'file-regression',
      metric: 'file max cognitive complexity',
      file: file.file,
      functionName: worst?.name ?? undefined,
      startLine: worst?.startLine ?? 1,
      endLine: worst?.endLine ?? headMetrics.lines.total,
      baseValue: baseMetrics.maxCognitiveComplexity,
      headValue: headMetrics.maxCognitiveComplexity,
      allowedValue: allowedMaxCognitive,
      message:
        `${file.file}: the file's max cognitive complexity worsened ${baseMetrics.maxCognitiveComplexity} -> ` +
        `${headMetrics.maxCognitiveComplexity} (allowed <= ${allowedMaxCognitive}). Simplify or split the most ` +
        `complex function${worst ? ` (${worst.name ?? '<anonymous>'} at L${worst.startLine}-${worst.endLine})` : ''}.`,
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
        `${file.file}: functions were removed or split while the file grew from NCSS ` +
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
  return [
    {
      gate: 'duplication',
      metric: 'duplicated lines',
      file: file.file,
      startLine: 1,
      endLine: file.headMetrics?.lines.total ?? 1,
      baseValue: file.baseDuplicatedLineCount,
      headValue: file.headDuplicatedLineCount,
      allowedValue,
      message:
        `${file.file}: duplicated lines increased ${file.baseDuplicatedLineCount} -> ` +
        `${file.headDuplicatedLineCount} (allowed <= ${allowedValue}). Deduplicate` +
        `${partners ? ` against ${partners}` : ' the repeated code'} by extracting a shared helper.`,
    },
  ];
}
