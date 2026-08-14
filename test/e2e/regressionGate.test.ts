import { describe, expect, it } from 'vitest';
import {
  collectFunctionTokenSequences,
  defaultGateOptions,
  evaluateRegressionGate,
  measureCode,
  type CodeMetrics,
  type FunctionMetrics,
  type GateFileInput,
} from '../../src/index.js';

// The gate is exercised with real measurements (measureCode + token sequences) so matching,
// ratcheting, and the new-code thresholds are tested against the same values the CLI sees; only
// the file-backstop cases use synthetic metrics, where the aggregate combinations matter and
// authoring real code for each would obscure the boundary being tested.

const baseCode = `export function total(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}
`;

// One added guard: cognitive +1, NCSS +2, DepDegree +1, Halstead volume +31 — inside every tolerance.
const guardedCode = `export function total(items: number[]): number {
  if (items.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}
`;

// Cognitive 1 -> 12, NCSS 5 -> 15, nesting 1 -> 3: three ratchets fire; DepDegree (4 -> 14) and
// volume (44 -> 163) stay inside their tolerances, pinning that tolerances are respected per metric.
const worsenedCode = `export function total(items: number[], mode?: string): number {
  let sum = 0;
  for (const item of items) {
    if (mode === 'abs') {
      if (item < 0) {
        sum -= item;
      } else {
        sum += item;
      }
    } else if (mode === 'even') {
      if (item % 2 === 0) {
        sum += item;
      }
    } else {
      sum += item;
    }
  }
  return sum;
}
`;

// Cognitive complexity 24 and nesting depth 5: over the new-code limits (15 and 4).
const complexNewFunction = `export function decide(a: number, b: number, c: number, d: number): number {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        if (d > 0) {
          if (a > b) {
            return 1;
          }
        }
      }
    }
  }
  if (b > 1) { return 2; }
  if (c > 1) { return 3; }
  if (d > 1) { return 4; }
  if (a > 2 && b > 2) { return 5; }
  if (a > 3 || b > 3) { return 6; }
  if (c > 3 && d > 3) { return 7; }
  return 0;
}
`;

function makeInput(base: string | undefined, head: string | undefined, extras?: Partial<GateFileInput>): GateFileInput {
  const options = { language: 'typescript' } as const;
  return {
    file: 'src/sample.ts',
    baseMetrics: base === undefined ? undefined : measureCode(base, options),
    headMetrics: head === undefined ? undefined : measureCode(head, options),
    baseFunctionTokens: base === undefined ? undefined : collectFunctionTokenSequences(base, options),
    headFunctionTokens: head === undefined ? undefined : collectFunctionTokenSequences(head, options),
    baseDuplicatedLineCount: 0,
    headDuplicatedLineCount: 0,
    duplicationPartners: [],
    ...extras,
  };
}

describe('evaluateRegressionGate', () => {
  it('passes an unchanged file', () => {
    const result = evaluateRegressionGate([makeInput(baseCode, baseCode)], defaultGateOptions);
    expect(result.violations).toStrictEqual([]);
    expect(result.checkedFunctionCount).toBe(1);
    expect(result.newFunctionCount).toBe(0);
  });

  it('allows a worsening within every tolerance', () => {
    const result = evaluateRegressionGate([makeInput(baseCode, guardedCode)], defaultGateOptions);
    expect(result.violations).toStrictEqual([]);
  });

  it('reports each ratchet exceeded beyond its tolerance, and only those', () => {
    const result = evaluateRegressionGate([makeInput(baseCode, worsenedCode)], defaultGateOptions);
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['function-regression', 'cognitive complexity'],
      ['function-regression', 'NCSS'],
      ['function-regression', 'max nesting depth'],
    ]);
    const cognitive = result.violations[0];
    expect(cognitive).toMatchObject({
      functionName: 'total',
      baseValue: 1,
      headValue: 12,
      allowedValue: 3,
      file: 'src/sample.ts',
    });
    expect(cognitive?.message).toContain('src/sample.ts:1-');
  });

  it('re-matches a renamed function by token similarity instead of gating it as new code', () => {
    const renamed = baseCode.replaceAll('total', 'sumAll').replaceAll('items', 'values').replaceAll('item', 'value');
    const result = evaluateRegressionGate([makeInput(baseCode, renamed)], defaultGateOptions);
    expect(result.violations).toStrictEqual([]);
    expect(result.newFunctionCount).toBe(0);
  });

  it('catches a rename-plus-worsening through the file-level backstop', () => {
    // The rewritten body is too dissimilar to re-match, and its cognitive complexity 12 passes the
    // new-code limit — exactly the identity-reset gaming vector the file aggregates ratchet.
    const renamedWorsened = worsenedCode.replaceAll('total', 'sumAll');
    const result = evaluateRegressionGate([makeInput(baseCode, renamedWorsened)], defaultGateOptions);
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['file-regression', 'file max cognitive complexity'],
    ]);
    expect(result.violations[0]).toMatchObject({ baseValue: 1, headValue: 12, allowedValue: 3 });
  });

  it('applies absolute thresholds to new functions', () => {
    const result = evaluateRegressionGate([makeInput(baseCode, baseCode + complexNewFunction)], defaultGateOptions);
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['new-function', 'cognitive complexity'],
      ['new-function', 'max nesting depth'],
    ]);
    expect(result.violations[0]).toMatchObject({ functionName: 'decide', headValue: 24, allowedValue: 15 });
    expect(result.newFunctionCount).toBe(1);
  });

  it('gates every function of an added file as new code', () => {
    const result = evaluateRegressionGate([makeInput(undefined, complexNewFunction)], defaultGateOptions);
    expect(result.violations.map((violation) => violation.gate)).toStrictEqual(['new-function', 'new-function']);
  });

  it('ignores deleted files', () => {
    const result = evaluateRegressionGate([makeInput(worsenedCode, undefined)], defaultGateOptions);
    expect(result.violations).toStrictEqual([]);
  });

  it('reports increased duplicated lines with partner evidence', () => {
    const result = evaluateRegressionGate(
      [
        makeInput(baseCode, baseCode, {
          baseDuplicatedLineCount: 3,
          headDuplicatedLineCount: 9,
          duplicationPartners: ['src/other.ts'],
        }),
      ],
      defaultGateOptions
    );
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['duplication', 'duplicated lines'],
    ]);
    expect(result.violations[0]).toMatchObject({ baseValue: 3, headValue: 9, allowedValue: 3 });
    expect(result.violations[0]?.message).toContain('src/other.ts');
  });

  it('allows duplicated lines up to the base count', () => {
    const result = evaluateRegressionGate(
      [makeInput(baseCode, baseCode, { baseDuplicatedLineCount: 9, headDuplicatedLineCount: 9 })],
      defaultGateOptions
    );
    expect(result.violations).toStrictEqual([]);
  });
});

const emptyHalstead = {
  distinctOperators: 1,
  distinctOperands: 1,
  totalOperators: 1,
  totalOperands: 1,
  vocabulary: 2,
  length: 2,
  volume: 2,
  effort: 1,
};

function makeFunction(name: string, overrides: Partial<FunctionMetrics> = {}): FunctionMetrics {
  return {
    name,
    nodeType: 'function_declaration',
    startLine: 1,
    startColumn: 0,
    endLine: 5,
    cognitiveComplexity: 0,
    nestingDepth: 0,
    ncss: 3,
    parameterCount: 1,
    halstead: emptyHalstead,
    depDegree: 0,
    ...overrides,
  };
}

function makeMetrics(functions: FunctionMetrics[], overrides: Partial<CodeMetrics> = {}): CodeMetrics {
  return {
    language: 'typescript',
    bytes: 100,
    lines: { total: 20, code: 15, comment: 2, blank: 3 },
    functions,
    cognitiveComplexity: 0,
    maxCognitiveComplexity: Math.max(0, ...functions.map((fn) => fn.cognitiveComplexity)),
    nestingDepth: 1,
    ncssCount: functions.reduce((sum, fn) => sum + fn.ncss, 0),
    duplication: {
      duplicateBlockCount: 0,
      duplicateBlockGroupCount: 0,
      duplicateBlockGroups: [],
      duplicateLineCount: 0,
      duplicateLineNumbers: [],
      duplicationRatio: 0,
      maxDuplicateBlockSize: 0,
    },
    halstead: emptyHalstead,
    syntaxTree: undefined,
    ...overrides,
  };
}

function makeSyntheticInput(baseMetrics: CodeMetrics, headMetrics: CodeMetrics): GateFileInput {
  return {
    file: 'src/synthetic.ts',
    baseMetrics,
    headMetrics,
    baseDuplicatedLineCount: 0,
    headDuplicatedLineCount: 0,
    duplicationPartners: [],
  };
}

describe('file-level backstops (synthetic aggregates)', () => {
  it('ratchets the file max cognitive complexity when base functions disappeared', () => {
    const input = makeSyntheticInput(
      makeMetrics([makeFunction('f', { cognitiveComplexity: 10 })]),
      makeMetrics([makeFunction('g', { cognitiveComplexity: 14 }), makeFunction('h', { cognitiveComplexity: 2 })])
    );
    const result = evaluateRegressionGate([input], defaultGateOptions);
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['file-regression', 'file max cognitive complexity'],
    ]);
    expect(result.violations[0]).toMatchObject({ baseValue: 10, headValue: 14, allowedValue: 12 });
  });

  it('ratchets the file NCSS when base functions disappeared and the file grew', () => {
    const input = makeSyntheticInput(
      makeMetrics([makeFunction('f', { ncss: 30 })]),
      makeMetrics([makeFunction('g', { ncss: 36 }), makeFunction('h', { ncss: 20 })])
    );
    const result = evaluateRegressionGate([input], defaultGateOptions);
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['file-regression', 'file NCSS'],
    ]);
    expect(result.violations[0]).toMatchObject({ baseValue: 30, headValue: 56, allowedValue: 50 });
  });

  it('leaves purely additive changes ungated by the backstops', () => {
    const input = makeSyntheticInput(
      makeMetrics([makeFunction('f', { cognitiveComplexity: 3 })]),
      makeMetrics([
        makeFunction('f', { cognitiveComplexity: 3 }),
        makeFunction('g', { cognitiveComplexity: 14, ncss: 40 }),
      ])
    );
    expect(evaluateRegressionGate([input], defaultGateOptions).violations).toStrictEqual([]);
  });

  it('does not restate a function-level cognitive violation as a file violation', () => {
    const result = evaluateRegressionGate([makeInput(baseCode, worsenedCode)], defaultGateOptions);
    expect(result.violations.filter((violation) => violation.gate === 'file-regression')).toStrictEqual([]);
  });
});
