import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureCode, type CodeMetrics } from '../../src/index.js';
import { fixturesDir } from './fixtureCorpus.js';

/**
 * Expected values measured with PMD 7.26.0 (pmd-java) — the engine WillBooster/code-analyzer uses
 * for its `analyzeCode` metrics — via its CognitiveComplexity / CyclomaticComplexity / NcssCount
 * rules with report level 1. Each entry is [cyclomatic, cognitive, ncss] for one method.
 *
 * Known deliberate divergence: PMD's NCSS does not see statements inside lambdas passed as call
 * arguments (its visitor never descends through those expressions), while it does count the same
 * lambda body when it is a variable initializer. code-gauge counts lambda bodies consistently in
 * both positions, so `lam` below expects 4 where PMD reports 2.
 */
const expectedByFixture: Record<string, Record<string, readonly [number, number, number]>> = {
  'ComplexCode.java': {
    main: [1, 0, 2],
    MainWindow: [1, 0, 8],
    createContentPane: [1, 0, 22],
    MouseListener: [1, 0, 2],
    setPenButton: [1, 0, 2],
    setFillButton: [1, 0, 2],
    mousePressed: [3, 2, 8],
    mouseDragged: [2, 1, 7],
    MyPanel: [1, 0, 8],
    drawLine: [1, 0, 5],
    fill: [13, 11, 18],
    paint: [1, 0, 2],
  },
  'ProbeStatements.java': {
    a: [3, 3, 8],
    b: [2, 1, 8],
    c: [2, 1, 6],
    d: [4, 7, 8],
    e: [1, 0, 3],
    f: [1, 0, 5],
  },
  'ProbeTryForms.java': {
    tc: [2, 1, 4],
    tf: [1, 0, 4],
    tw: [2, 1, 5],
    sync: [1, 0, 3],
    thr: [1, 0, 2],
    init: [1, 0, 5],
    run: [1, 0, 2],
  },
  'ProbeBranches.java': {
    sw: [3, 1, 11],
    tern: [4, 4, 3],
    bools: [9, 6, 5],
    nest: [4, 6, 5],
    lam: [1, 2, 4],
  },
};

function measureFixture(fixture: string): CodeMetrics {
  const code = readFileSync(path.join(fixturesDir, 'pmd', fixture), 'utf8');
  return measureCode(code, { language: 'java' });
}

/**
 * The aggregate WillBooster/code-analyzer reports: PMD sums cognitive complexity, cyclomatic
 * complexity, and NCSS over every method. Summing per-function values reproduces the cyclomatic
 * and NCSS sums (methods and PMD both attribute nested anonymous-class bodies to the enclosing
 * method AND to the nested method); the file-level cognitive complexity reproduces the cognitive
 * sum, because it charges each construct exactly once while per-function values attribute lambda
 * content to the enclosing function as well.
 */
function pmdStyleAggregate(metrics: CodeMetrics): {
  cognitiveComplexity: number;
  cyclomaticComplexity: number;
  ncssCount: number;
} {
  return {
    cognitiveComplexity: metrics.cognitiveComplexity,
    cyclomaticComplexity: metrics.functions.reduce((sum, fn) => sum + fn.cyclomaticComplexity, 0),
    ncssCount: metrics.functions.reduce((sum, fn) => sum + fn.ncss, 0),
  };
}

describe('PMD parity (Java): per-method complexity and NCSS', () => {
  for (const [fixture, expectedFunctions] of Object.entries(expectedByFixture)) {
    it(`matches PMD per-method values for ${fixture}`, () => {
      const metrics = measureFixture(fixture);
      const actual = Object.fromEntries(
        metrics.functions
          .filter((fn) => fn.name !== undefined && fn.name in expectedFunctions)
          .map((fn) => [fn.name, [fn.cyclomaticComplexity, fn.cognitiveComplexity, fn.ncss]])
      );
      expect(actual).toEqual(expectedFunctions);
    });
  }
});

describe('PMD parity (Java): code-analyzer aggregate metrics', () => {
  // The expectations for ComplexCode.java are the golden values of code-analyzer's own E2E test
  // (packages/server/test/e2e/analyzeCode.test.ts): cognitive 14, cyclomatic 27, NCSS 86.
  it('reproduces code-analyzer analyzeCode results for ComplexCode.java', () => {
    expect(pmdStyleAggregate(measureFixture('ComplexCode.java'))).toEqual({
      cognitiveComplexity: 14,
      cyclomaticComplexity: 27,
      ncssCount: 86,
    });
  });

  it('reproduces code-analyzer analyzeCode results for its minimal snippet', () => {
    const code =
      'public class Test {\n  void f(boolean b) {\n    if (b) {\n      System.out.println("x");\n    }\n  }\n}\n';
    expect(pmdStyleAggregate(measureCode(code, { language: 'java' }))).toEqual({
      cognitiveComplexity: 1,
      cyclomaticComplexity: 2,
      ncssCount: 3,
    });
  });

  it('matches PMD method sums for every PMD fixture', () => {
    const expectedAggregates: Record<string, [number, number, number]> = {
      'ComplexCode.java': [14, 27, 86],
      'ProbeStatements.java': [12, 13, 38],
      'ProbeTryForms.java': [2, 9, 25],
      'ProbeBranches.java': [19, 21, 26],
    };
    for (const [fixture, [cognitive, cyclomatic, ncss]] of Object.entries(expectedAggregates)) {
      const metrics = measureFixture(fixture);
      expect(metrics.cognitiveComplexity, `${fixture} cognitive`).toBe(cognitive);
      // Lambdas appear in functions[] with their own cyclomatic complexity and NCSS while PMD only
      // reports methods, so the sum comparison excludes fixtures' lambda entries via name lookup.
      const expectedFunctions = expectedByFixture[fixture] ?? {};
      const methodFunctions = metrics.functions.filter((fn) => fn.name !== undefined && fn.name in expectedFunctions);
      expect(
        methodFunctions.reduce((sum, fn) => sum + fn.cyclomaticComplexity, 0),
        `${fixture} cyclomatic`
      ).toBe(cyclomatic);
      const ncssSum = methodFunctions.reduce((sum, fn) => sum + fn.ncss, 0);
      // ProbeBranches' `lam` diverges from PMD by design (see expectedByFixture doc comment).
      const expected = fixture === 'ProbeBranches.java' ? ncss + 2 : ncss;
      expect(ncssSum, `${fixture} ncss`).toBe(expected);
    }
  });
});
