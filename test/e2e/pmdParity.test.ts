import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureCode, type CodeMetrics } from '../../src/index.js';
import { fixturesDir } from './fixtureCorpus.js';

/**
 * Cross-validation of cognitive complexity and NCSS against PMD 7.26.0 (pmd-java), measured via its
 * CognitiveComplexity / NcssCount rules with report level 1. Each entry is [cognitive, ncss] for
 * one method.
 *
 * Known deliberate divergence: PMD also reports abstract and interface methods without a body
 * (NCSS 1 each); code-gauge does not treat a declaration without a body as a function.
 *
 * Known deliberate divergence: PMD's NCSS visitor does not descend into expression positions —
 * statements inside lambdas or anonymous classes passed as call arguments, switch-expression
 * bodies, and expression-bodied arrow cases are invisible to it — while it does count the same
 * constructs in statement/initializer positions. code-gauge counts statement-shaped content
 * uniformly regardless of position, so `lam` below expects 4 where PMD reports 2, and Java files
 * using switch expressions or anonymous classes as arguments measure higher than PMD.
 */
const expectedByFixture: Record<string, Record<string, readonly [number, number]>> = {
  'ComplexCode.java': {
    main: [0, 2],
    MainWindow: [0, 8],
    createContentPane: [0, 22],
    MouseListener: [0, 2],
    setPenButton: [0, 2],
    setFillButton: [0, 2],
    mousePressed: [2, 8],
    mouseDragged: [1, 7],
    MyPanel: [0, 8],
    drawLine: [0, 5],
    fill: [11, 18],
    paint: [0, 2],
  },
  'ProbeStatements.java': {
    a: [3, 8],
    b: [1, 8],
    c: [1, 6],
    d: [7, 8],
    e: [0, 3],
    f: [0, 5],
  },
  'ProbeTryForms.java': {
    tc: [1, 4],
    tf: [0, 4],
    tw: [1, 5],
    sync: [0, 3],
    thr: [0, 2],
    init: [0, 5],
    run: [0, 2],
  },
  'ProbeBranches.java': {
    sw: [1, 11],
    tern: [4, 3],
    bools: [6, 5],
    nest: [6, 5],
    lam: [2, 4],
  },
  'ProbeNestedDecisions.java': {
    parens1: [2, 3],
    parens2: [2, 3],
    parens3: [3, 3],
    initHost: [0, 2],
    nested: [5, 7],
    run: [3, 4],
  },
  'ProbeSignatures.java': {
    twice: [0, 2],
    done: [0, 2],
    thr: [0, 2],
    twoThrows: [1, 4],
    existingResource: [0, 2],
  },
  // This and the next fixture were measured with PMD's Java language version set to 21, which
  // comma-separated case labels and pattern labels need.
  'ProbeBooleanPaths.java': {
    initializer: [2, 3],
    condition: [3, 3],
    ternaryInCondition: [4, 2],
    switchOnTernary: [3, 6],
    guardedPattern: [2, 8],
  },
  'ProbeSwitchAlternatives.java': {
    colonLabels: [1, 7],
    arrowAlternatives: [1, 6],
    colonAlternatives: [1, 6],
  },
};

describe('PMD parity (Java): per-method complexity and NCSS', () => {
  for (const [fixture, expectedFunctions] of Object.entries(expectedByFixture)) {
    it(`matches PMD per-method values for ${fixture}`, () => {
      const metrics = measureFixture(fixture);
      const actual = Object.fromEntries(
        metrics.functions
          .filter((fn) => fn.name !== undefined && Object.hasOwn(expectedFunctions, fn.name))
          .map((fn) => [fn.name, [fn.cognitiveComplexity, fn.ncss]])
      );
      expect(actual).toEqual(expectedFunctions);
    });
  }
});

function measureFixture(fixture: string): CodeMetrics {
  const code = readFileSync(path.join(fixturesDir, 'pmd', fixture), 'utf8');
  return measureCode(code, { language: 'java' });
}
