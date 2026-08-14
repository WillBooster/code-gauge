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
 * Known deliberate divergence: PMD's NCSS visitor does not descend into expression positions —
 * statements inside lambdas or anonymous classes passed as call arguments, switch-expression
 * bodies, and expression-bodied arrow cases are invisible to it — while it does count the same
 * constructs in statement/initializer positions. code-gauge counts statement-shaped content
 * uniformly regardless of position, so `lam` below expects 4 where PMD reports 2, and Java files
 * using switch expressions or anonymous classes as arguments measure higher than PMD.
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
    thr: [2, 0, 2],
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
  'ProbeNestedDecisions.java': {
    parens1: [4, 2, 3],
    parens2: [4, 2, 3],
    parens3: [5, 3, 3],
    initHost: [1, 0, 2],
    nested: [1, 5, 7],
    run: [3, 3, 4],
  },
  'ProbeSignatures.java': {
    area: [1, 0, 1],
    twice: [1, 0, 2],
    render: [1, 0, 1],
    done: [1, 0, 2],
    thr: [2, 0, 2],
    twoThrows: [4, 1, 4],
    existingResource: [1, 0, 2],
  },
};

function measureFixture(fixture: string): CodeMetrics {
  const code = readFileSync(path.join(fixturesDir, 'pmd', fixture), 'utf8');
  return measureCode(code, { language: 'java' });
}

/**
 * The aggregate WillBooster/code-analyzer reports: PMD sums cognitive complexity, cyclomatic
 * complexity, and NCSS over every method (constructors, abstract/interface methods, and
 * anonymous-class methods included; lambdas and compact record constructors not reported on their
 * own). Summing per-function values over the matching entries reproduces those sums: cognitive
 * complexity and NCSS attribute nested lambda/anonymous-class content to the enclosing method
 * exactly like PMD does, and lambda/compact-constructor entries are skipped via `nodeType` so the
 * sum covers the same method set PMD reports.
 */
function pmdStyleAggregate(metrics: CodeMetrics): {
  cognitiveComplexity: number;
  cyclomaticComplexity: number;
  ncssCount: number;
} {
  const methods = metrics.functions.filter(
    (fn) => fn.nodeType !== 'lambda_expression' && fn.nodeType !== 'compact_constructor_declaration'
  );
  return {
    cognitiveComplexity: methods.reduce((sum, fn) => sum + fn.cognitiveComplexity, 0),
    cyclomaticComplexity: methods.reduce((sum, fn) => sum + fn.cyclomaticComplexity, 0),
    ncssCount: methods.reduce((sum, fn) => sum + fn.ncss, 0),
  };
}

describe('PMD parity (Java): per-method complexity and NCSS', () => {
  for (const [fixture, expectedFunctions] of Object.entries(expectedByFixture)) {
    it(`matches PMD per-method values for ${fixture}`, () => {
      const metrics = measureFixture(fixture);
      const actual = Object.fromEntries(
        metrics.functions
          .filter((fn) => fn.name !== undefined && Object.hasOwn(expectedFunctions, fn.name))
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
      'ProbeTryForms.java': [2, 10, 25],
      // NCSS is PMD's 26 + 2: `lam` diverges from PMD by design (see expectedByFixture doc).
      'ProbeBranches.java': [19, 21, 28],
      'ProbeNestedDecisions.java': [15, 18, 22],
      'ProbeSignatures.java': [1, 11, 14],
    };
    for (const [fixture, [cognitive, cyclomatic, ncss]] of Object.entries(expectedAggregates)) {
      expect(pmdStyleAggregate(measureFixture(fixture)), fixture).toEqual({
        cognitiveComplexity: cognitive,
        cyclomaticComplexity: cyclomatic,
        ncssCount: ncss,
      });
    }
  });
});
