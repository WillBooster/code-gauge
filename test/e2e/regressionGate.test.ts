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

function makeClassWithFoo(name: string, body: string): string {
  return `class ${name} { foo(x: number): number { ${body} } }\n`;
}

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

function makeSyntheticInput(
  baseMetrics: CodeMetrics,
  headMetrics: CodeMetrics,
  tokens?: { base?: Int32Array[]; head?: Int32Array[] }
): GateFileInput {
  return {
    file: 'src/synthetic.ts',
    baseMetrics,
    headMetrics,
    baseFunctionTokens: tokens?.base,
    headFunctionTokens: tokens?.head,
    baseDuplicatedLineCount: 0,
    headDuplicatedLineCount: 0,
    duplicationPartners: [],
  };
}

function tokenRange(start: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => start + index);
}

// 50% similar to tokenRange(1, 20): below the 70% match threshold (so the functions stay
// unmatched) but above the 30% split-evidence threshold (so the file backstops arm).
const splitFragmentTokens = Int32Array.from([...tokenRange(1, 10), ...tokenRange(101, 10)]);
const originalTokens = Int32Array.from(tokenRange(1, 20));

describe('file-level backstops (synthetic aggregates)', () => {
  it('ratchets the file max cognitive complexity when a removed function reappears split', () => {
    const input = makeSyntheticInput(
      makeMetrics([makeFunction('f', { cognitiveComplexity: 10 })]),
      makeMetrics([makeFunction('g', { cognitiveComplexity: 14 }), makeFunction('h', { cognitiveComplexity: 2 })]),
      { base: [originalTokens], head: [splitFragmentTokens, Int32Array.from(tokenRange(201, 20))] }
    );
    const result = evaluateRegressionGate([input], defaultGateOptions);
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['file-regression', 'file max cognitive complexity'],
    ]);
    expect(result.violations[0]).toMatchObject({ baseValue: 10, headValue: 14, allowedValue: 12 });
  });

  it('ratchets the file NCSS when a removed function reappears split and the file grew', () => {
    const input = makeSyntheticInput(
      makeMetrics([makeFunction('f', { ncss: 30 })]),
      makeMetrics([makeFunction('g', { ncss: 36 }), makeFunction('h', { ncss: 20 })]),
      { base: [originalTokens], head: [splitFragmentTokens, Int32Array.from(tokenRange(201, 20))] }
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

  it('leaves an unrelated delete-plus-add change ungated by the backstops', () => {
    // The removed helper shares nothing with the new function, so no identity was reset: the new
    // code is judged by the new-code thresholds alone (which cognitive 8 passes).
    const input = makeSyntheticInput(
      makeMetrics([
        makeFunction('alpha', { cognitiveComplexity: 1 }),
        makeFunction('beta', { cognitiveComplexity: 1 }),
      ]),
      makeMetrics([
        makeFunction('alpha', { cognitiveComplexity: 1 }),
        makeFunction('fresh', { cognitiveComplexity: 8, ncss: 32 }),
      ]),
      {
        base: [Int32Array.from(tokenRange(1, 8)), Int32Array.from(tokenRange(50, 8))],
        head: [Int32Array.from(tokenRange(1, 8)), Int32Array.from(tokenRange(300, 30))],
      }
    );
    expect(evaluateRegressionGate([input], defaultGateOptions).violations).toStrictEqual([]);
  });

  it('reports the file maximum even when a smaller cognitive violation exists elsewhere in the file', () => {
    // f (10) is split-rewritten into h (14) while unrelated g worsens 1 -> 4: the g violation must
    // not suppress the file-max backstop, whose maximum comes from h.
    const input = makeSyntheticInput(
      makeMetrics([makeFunction('f', { cognitiveComplexity: 10 }), makeFunction('g', { cognitiveComplexity: 1 })]),
      makeMetrics([makeFunction('g', { cognitiveComplexity: 4 }), makeFunction('h', { cognitiveComplexity: 14 })]),
      {
        base: [originalTokens, Int32Array.from(tokenRange(500, 4))],
        head: [Int32Array.from(tokenRange(500, 4)), splitFragmentTokens],
      }
    );
    const result = evaluateRegressionGate([input], defaultGateOptions);
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['function-regression', 'cognitive complexity'],
      ['file-regression', 'file max cognitive complexity'],
    ]);
  });

  it('does not restate a function-level cognitive violation as a file violation', () => {
    // g's content reappears split in h (arming the backstops) while f worsens to the new file
    // maximum: f's function-level violation already reports that maximum, so the file
    // max-cognitive backstop must stay silent instead of restating it.
    const input = makeSyntheticInput(
      makeMetrics([makeFunction('f', { cognitiveComplexity: 10 }), makeFunction('g', { cognitiveComplexity: 3 })]),
      makeMetrics([makeFunction('f', { cognitiveComplexity: 20 }), makeFunction('h', { cognitiveComplexity: 2 })]),
      {
        base: [Int32Array.from(tokenRange(600, 4)), originalTokens],
        head: [Int32Array.from(tokenRange(600, 4)), splitFragmentTokens],
      }
    );
    const result = evaluateRegressionGate([input], defaultGateOptions);
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['function-regression', 'cognitive complexity'],
    ]);
  });

  it('never rewires an exact pairing just to match more functions', () => {
    // Anonymous functions with edges A-A 100, A-B 70, B-A 70 (B-B below threshold): matching both
    // would require breaking the byte-identical A-A pair and ratcheting the untouched A against
    // B's rewrite (a false 1 -> 14 violation). The exact pair is locked; B gates as removed and
    // headB as new code instead.
    const anonymous = (cognitiveComplexity: number): FunctionMetrics =>
      makeFunction('ignored', { name: undefined, cognitiveComplexity });
    const input = makeSyntheticInput(
      makeMetrics([anonymous(1), anonymous(20)]),
      makeMetrics([anonymous(1), anonymous(14)]),
      {
        base: [Int32Array.from(tokenRange(1, 10)), Int32Array.from([1, 2, 3, 4, 5, 6, 8, ...tokenRange(70, 3)])],
        head: [Int32Array.from(tokenRange(1, 10)), Int32Array.from([...tokenRange(1, 7), ...tokenRange(60, 3)])],
      }
    );
    const result = evaluateRegressionGate([input], defaultGateOptions);
    expect(result.violations).toStrictEqual([]);
    expect(result.newFunctionCount).toBe(1);
  });

  it('keeps an exact pairing even when a rewritten sibling prefers the same head', () => {
    // Same-name overloads: run#0 is byte-identical at both revisions while run#1 was rewritten and
    // happens to share more tokens with run#0's head than with its own rewrite. The untouched
    // function must stay paired with its identical counterpart, not be displaced onto the rewrite.
    const anonymousRun = (cognitiveComplexity: number): FunctionMetrics => makeFunction('run', { cognitiveComplexity });
    const input = makeSyntheticInput(
      makeMetrics([anonymousRun(1), anonymousRun(20)]),
      makeMetrics([anonymousRun(1), anonymousRun(20)]),
      {
        base: [Int32Array.from(tokenRange(1, 10)), Int32Array.from([...tokenRange(1, 9), 900])],
        head: [Int32Array.from(tokenRange(1, 10)), Int32Array.from([1, 2, 3, ...tokenRange(500, 7)])],
      }
    );
    expect(evaluateRegressionGate([input], defaultGateOptions).violations).toStrictEqual([]);
  });

  it('falls back to positional pairing for same-name groups without token sequences', () => {
    const namedRun = (cognitiveComplexity: number): FunctionMetrics => makeFunction('run', { cognitiveComplexity });
    const input = makeSyntheticInput(
      makeMetrics([namedRun(1), namedRun(20)]),
      makeMetrics([namedRun(1), namedRun(20)])
    );
    expect(evaluateRegressionGate([input], defaultGateOptions).violations).toStrictEqual([]);
  });

  it('assigns similarity matches with maximum cardinality instead of best-edge greed', () => {
    // Anonymous functions with similarities A-A 90, A-B 70, B-A 70, B-B 60: a greedy walk would
    // take A-A and strand B (a false new-function violation for the cognitive-20 head); the
    // maximum assignment pairs A-B and B-A so every function keeps a counterpart.
    const baseA = Int32Array.from([...tokenRange(1, 5), ...tokenRange(11, 5)]);
    const headA = Int32Array.from([...tokenRange(1, 5), ...tokenRange(11, 4), 50]);
    const headB = Int32Array.from([...tokenRange(1, 5), 11, 12, 60, 61, 62]);
    const baseB = Int32Array.from([...tokenRange(1, 5), 11, 13, 70, 71, 72]);
    const anonymous = (cognitiveComplexity: number): FunctionMetrics =>
      makeFunction('ignored', { name: undefined, cognitiveComplexity });
    const input = makeSyntheticInput(
      makeMetrics([anonymous(20), anonymous(0)]),
      makeMetrics([anonymous(0), anonymous(20)]),
      { base: [baseA, baseB], head: [headA, headB] }
    );
    const result = evaluateRegressionGate([input], defaultGateOptions);
    expect(result.violations).toStrictEqual([]);
    expect(result.newFunctionCount).toBe(0);
  });

  it('matches a function moved to another changed file instead of gating it as new code', () => {
    const moveSource = makeInput(complexNewFunction, '', { file: 'src/a.ts' });
    const moveTarget = makeInput(undefined, complexNewFunction, { file: 'src/b.ts' });
    const result = evaluateRegressionGate([moveSource, moveTarget], defaultGateOptions);
    expect(result.violations).toStrictEqual([]);
    expect(result.newFunctionCount).toBe(0);
  });

  it('pairs same-name methods by similarity, so an inserted method cannot shift the pairing', () => {
    const simpleBody = 'return x + 1;';
    const complexBody = `
    if (x > 0) {
      if (x > 10) {
        for (let i = 0; i < x; i++) {
          if (i % 2 === 0 && i % 3 === 0) { x += i; }
        }
      } else if (x > 5) {
        x -= 1;
      }
    }
    return x > 100 ? 100 : x < -100 ? -100 : x;`;
    const base = makeClassWithFoo('A', simpleBody) + makeClassWithFoo('B', complexBody);
    const head = makeClassWithFoo('Z', 'return x - 1;') + base;
    const result = evaluateRegressionGate([makeInput(base, head)], defaultGateOptions);
    expect(result.violations).toStrictEqual([]);
    expect(result.newFunctionCount).toBe(1);
  });

  it('scales the Halstead volume allowance with the base value', () => {
    const largeVolume = 1000;
    const pass = makeSyntheticInput(
      makeMetrics([makeFunction('f', { halstead: { ...emptyHalstead, volume: largeVolume } })]),
      makeMetrics([makeFunction('f', { halstead: { ...emptyHalstead, volume: largeVolume + 220 } })])
    );
    expect(evaluateRegressionGate([pass], defaultGateOptions).violations).toStrictEqual([]);

    const fail = makeSyntheticInput(
      makeMetrics([makeFunction('f', { halstead: { ...emptyHalstead, volume: largeVolume } })]),
      makeMetrics([makeFunction('f', { halstead: { ...emptyHalstead, volume: largeVolume + 300 } })])
    );
    expect(evaluateRegressionGate([fail], defaultGateOptions).violations).toMatchObject([
      { gate: 'function-regression', metric: 'Halstead volume', allowedValue: largeVolume + 250 },
    ]);
  });
});

// A function of 63 statements: over the default new-function NCSS limit (60) with no branching.
const longNewFunction = `export function fill(): number[] {\n  const values: number[] = [];\n${Array.from(
  { length: 60 },
  (_, index) => `  values.push(${index});`
).join('\n')}\n  return values;\n}\n`;

describe('evaluateRegressionGate: thresholds, options, and reporting', () => {
  it('applies the NCSS limit to new functions', () => {
    const result = evaluateRegressionGate([makeInput(baseCode, baseCode + longNewFunction)], defaultGateOptions);
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['new-function', 'NCSS'],
    ]);
    expect(result.violations[0]).toMatchObject({ functionName: 'fill', headValue: 63, allowedValue: 60 });
    expect(result.violations[0]?.message).toContain('new function fill: NCSS 63 exceeds the new-code limit 60');
  });

  it('gates a renamed-and-edited function as new code only when the match similarity threshold is 100', () => {
    // Renaming alone leaves the normalized tokens identical (100% similar); one edited operator
    // keeps the pair above the default 70% but below an exact match.
    const edited = baseCode.replaceAll('total', 'sumAll').replace('sum += item', 'sum -= item');
    expect(evaluateRegressionGate([makeInput(baseCode, edited)], defaultGateOptions).newFunctionCount).toBe(0);
    const strict = { ...defaultGateOptions, matchSimilarityPercent: 100 };
    const result = evaluateRegressionGate([makeInput(baseCode, edited)], strict);
    expect(result.violations).toStrictEqual([]);
    expect(result.newFunctionCount).toBe(1);
    expect(result.checkedFunctions.map((fn) => [fn.name, fn.base === undefined])).toStrictEqual([['sumAll', true]]);
  });

  it('honors a duplicated-lines tolerance', () => {
    const tolerant = { ...defaultGateOptions, tolerance: { ...defaultGateOptions.tolerance, duplicateLines: 6 } };
    const input = makeInput(baseCode, baseCode, { baseDuplicatedLineCount: 3, headDuplicatedLineCount: 9 });
    expect(evaluateRegressionGate([input], tolerant).violations).toStrictEqual([]);
    expect(evaluateRegressionGate([input], defaultGateOptions).violations).toHaveLength(1);
  });

  it('evaluates nothing for an ungated file while still using it for matching', () => {
    // The worsened function lives in an ungated file: no violation, not counted as checked, but
    // the moved function in the gated file still finds its base counterpart there.
    const ungated = makeInput(worsenedCode + complexNewFunction, worsenedCode, {
      file: 'src/outside.ts',
      gated: false,
    });
    const moved = makeInput(undefined, complexNewFunction, { file: 'src/inside.ts' });
    const result = evaluateRegressionGate([ungated, moved], defaultGateOptions);
    expect(result.violations).toStrictEqual([]);
    expect(result.checkedFileCount).toBe(1);
    expect(result.newFunctionCount).toBe(0);
    expect(result.checkedFunctions.map((fn) => [fn.file, fn.name])).toStrictEqual([['src/inside.ts', 'decide']]);
  });

  it('counts a deleted file as checked with nothing to gate', () => {
    const result = evaluateRegressionGate([makeInput(worsenedCode, undefined)], defaultGateOptions);
    expect(result.checkedFileCount).toBe(1);
    expect(result.checkedFunctionCount).toBe(0);
    expect(result.checkedFunctions).toStrictEqual([]);
  });

  it('orders violations and checked functions by file then line, across files', () => {
    const result = evaluateRegressionGate(
      [
        makeInput(baseCode, baseCode + complexNewFunction, { file: 'src/b.ts' }),
        makeInput(baseCode, worsenedCode, { file: 'src/a.ts' }),
      ],
      defaultGateOptions
    );
    expect(result.violations.map((violation) => `${violation.file}:${violation.startLine}`)).toStrictEqual([
      'src/a.ts:1',
      'src/a.ts:1',
      'src/a.ts:1',
      'src/b.ts:8',
      'src/b.ts:8',
    ]);
    expect(result.checkedFunctions.map((fn) => `${fn.file}:${fn.name}`)).toStrictEqual([
      'src/a.ts:total',
      'src/b.ts:total',
      'src/b.ts:decide',
    ]);
  });

  it('reports the gated values of every checked function', () => {
    const result = evaluateRegressionGate([makeInput(baseCode, guardedCode)], defaultGateOptions);
    const [report] = result.checkedFunctions;
    expect(report).toMatchObject({
      file: 'src/sample.ts',
      name: 'total',
      startLine: 1,
      endLine: 10,
      base: { cognitiveComplexity: 1, ncss: 5, nestingDepth: 1, depDegree: 4 },
      head: { cognitiveComplexity: 2, ncss: 7, nestingDepth: 1, depDegree: 5 },
    });
    expect(report?.head.halsteadVolume ?? 0).toBeGreaterThan(report?.base?.halsteadVolume ?? 0);
  });

  it('names anonymous functions <anonymous> in violations', () => {
    const anonymousComplex = `export default ${complexNewFunction.replace('export function decide', 'function')}`;
    const result = evaluateRegressionGate([makeInput(undefined, anonymousComplex)], defaultGateOptions);
    expect(result.violations[0]?.functionName).toBe('<anonymous>');
    expect(result.violations[0]?.message).toContain('new function <anonymous>: cognitive complexity 24');
  });

  it('does not arm the file backstops when only an anonymous function was removed', () => {
    // Split evidence requires a NAMED removed function: an anonymous one leaves the backstops off.
    const input = makeSyntheticInput(
      makeMetrics([makeFunction('ignored', { name: undefined, cognitiveComplexity: 10 })]),
      makeMetrics([makeFunction('g', { cognitiveComplexity: 14 })]),
      { base: [originalTokens], head: [splitFragmentTokens] }
    );
    expect(evaluateRegressionGate([input], defaultGateOptions).violations).toStrictEqual([]);
  });

  it('does not restate a new-function cognitive violation as the file maximum', () => {
    // f is split into g (14, below the new-code limit) and h (20, above it): h's new-function
    // violation already reports the file maximum, so no file-regression violation is added.
    const input = makeSyntheticInput(
      makeMetrics([makeFunction('f', { cognitiveComplexity: 10 })]),
      makeMetrics([makeFunction('g', { cognitiveComplexity: 14 }), makeFunction('h', { cognitiveComplexity: 20 })]),
      { base: [originalTokens], head: [splitFragmentTokens, Int32Array.from(tokenRange(201, 20))] }
    );
    const result = evaluateRegressionGate([input], defaultGateOptions);
    expect(result.violations.map((violation) => [violation.gate, violation.metric])).toStrictEqual([
      ['new-function', 'cognitive complexity'],
    ]);
  });

  it('skips similarity matching past the comparison budget, gating leftovers as new code', () => {
    // 101 x 100 candidate pairs exceed the 10,000-comparison budget, so the identical anonymous
    // functions are not re-matched; at 100 x 100 they all are.
    const tokens = Int32Array.from(tokenRange(1, 8));
    const anonymous = (): FunctionMetrics => makeFunction('ignored', { name: undefined });
    const gate = (baseCount: number, headCount: number): number =>
      evaluateRegressionGate(
        [
          makeSyntheticInput(
            makeMetrics(Array.from({ length: baseCount }, anonymous)),
            makeMetrics(Array.from({ length: headCount }, anonymous)),
            {
              base: Array.from({ length: baseCount }, () => tokens),
              head: Array.from({ length: headCount }, () => tokens),
            }
          ),
        ],
        defaultGateOptions
      ).newFunctionCount;
    expect(gate(100, 100)).toBe(0);
    expect(gate(101, 100)).toBe(100);
  });
});
