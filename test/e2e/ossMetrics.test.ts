import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  measureCode,
  supportedLanguages,
  type CodeMetrics,
  type CohesionMetrics,
  type DuplicationMetrics,
  type FunctionMetrics,
  type HalsteadMetrics,
} from '../../src/index.js';
import { fixturesDir, loadFixtureCorpus } from './fixtureCorpus.js';
import { ossExpectations, type OracleMetric } from './ossExpectations.js';

// Measures every supported metric on real-world files from famous OSS projects (pinned to release
// tags) and checks them against expectations verified with major existing tools — PMD, lizard,
// gocognit, complexipy, eslint-plugin-sonarjs, cloc, and tokei. See ossExpectations.ts for the
// oracle description and test/fixtures/oss/README.md for file provenance.

const metricField: Record<
  OracleMetric,
  keyof Pick<FunctionMetrics, 'cyclomaticComplexity' | 'cognitiveComplexity' | 'ncss'>
> = {
  cyclomatic: 'cyclomaticComplexity',
  cognitive: 'cognitiveComplexity',
  ncss: 'ncss',
};

const round = (value: number): number => Math.round(value * 10_000) / 10_000;

/**
 * `language` and `bytes` are asserted separately from their spec (the requested language and the
 * input's byte length); `functions` is covered per entry by the oracle assertions; `syntaxTree`
 * is opt-in output, asserted by the parse test. Every other CodeMetrics field must appear in
 * roundFloats' result — the return type makes forgetting a newly added metric a compile error,
 * including fields added to the hand-enumerated cohesion/duplication/halstead groups.
 */
type AggregateKey = Exclude<keyof CodeMetrics, 'language' | 'bytes' | 'functions' | 'syntaxTree'>;
type RoundedAggregates = Omit<Record<AggregateKey, unknown>, 'cohesion' | 'duplication' | 'halstead'> & {
  cohesion: Record<keyof CohesionMetrics, number>;
  duplication: Record<keyof DuplicationMetrics, unknown>;
  halstead: Record<keyof HalsteadMetrics, number>;
};

function roundFloats(metrics: CodeMetrics): RoundedAggregates {
  return {
    lines: metrics.lines,
    functionCount: metrics.functionCount,
    classCount: metrics.classCount,
    cyclomaticComplexity: metrics.cyclomaticComplexity,
    maxCyclomaticComplexity: metrics.maxCyclomaticComplexity,
    cognitiveComplexity: metrics.cognitiveComplexity,
    maxCognitiveComplexity: metrics.maxCognitiveComplexity,
    nestingDepth: metrics.nestingDepth,
    ncssCount: metrics.ncssCount,
    callGraph: metrics.callGraph,
    coupling: metrics.coupling,
    module: metrics.module,
    cohesion: {
      averageFunctionIdentifierOverlap: round(metrics.cohesion.averageFunctionIdentifierOverlap),
      sharedIdentifierCount: metrics.cohesion.sharedIdentifierCount,
      uniqueIdentifierCount: metrics.cohesion.uniqueIdentifierCount,
    },
    syntaxFeatures: metrics.syntaxFeatures,
    typeComplexity: metrics.typeComplexity,
    duplication: {
      duplicateBlockCount: metrics.duplication.duplicateBlockCount,
      duplicateBlockGroupCount: metrics.duplication.duplicateBlockGroupCount,
      duplicateBlockGroups: metrics.duplication.duplicateBlockGroups,
      duplicateLineCount: metrics.duplication.duplicateLineCount,
      duplicationRatio: round(metrics.duplication.duplicationRatio),
      maxDuplicateBlockSize: metrics.duplication.maxDuplicateBlockSize,
    },
    halstead: {
      distinctOperators: metrics.halstead.distinctOperators,
      distinctOperands: metrics.halstead.distinctOperands,
      totalOperators: metrics.halstead.totalOperators,
      totalOperands: metrics.halstead.totalOperands,
      vocabulary: metrics.halstead.vocabulary,
      length: metrics.halstead.length,
      volume: round(metrics.halstead.volume),
      difficulty: round(metrics.halstead.difficulty),
      effort: round(metrics.halstead.effort),
      time: round(metrics.halstead.time),
      bugs: round(metrics.halstead.bugs),
    },
    maintainabilityIndex: round(metrics.maintainabilityIndex),
  };
}

/**
 * Functions are keyed by start AND end line: start lines alone are not unique (e.g. two callbacks
 * in `p.catch(() => {}).then(() => ...)` share one line). Looking up a span that still maps to
 * more than one function would silently check the wrong one, so lookupFunction fails loudly then.
 */
function keyFunctionsBySpan(metrics: CodeMetrics): Map<string, FunctionMetrics[]> {
  const bySpan = new Map<string, FunctionMetrics[]>();
  for (const fn of metrics.functions) {
    const key = `${fn.startLine}:${fn.endLine}`;
    bySpan.set(key, [...(bySpan.get(key) ?? []), fn]);
  }
  return bySpan;
}

function lookupFunction(
  bySpan: Map<string, FunctionMetrics[]>,
  name: string,
  startLine: number,
  endLine: number
): FunctionMetrics {
  const [fn, ...rest] = bySpan.get(`${startLine}:${endLine}`) ?? [];
  expect(fn, `${name}@${startLine}-${endLine} not found`).toBeDefined();
  expect(rest, `${name}@${startLine}-${endLine} is ambiguous`).toHaveLength(0);
  if (!fn) {
    throw new Error('unreachable');
  }
  return fn;
}

describe('real-world OSS corpus: all supported metrics for all supported languages', () => {
  for (const expectation of ossExpectations) {
    describe(expectation.file, () => {
      // Measured in beforeAll so file reading and parsing run in the test phase, not during test
      // discovery, and each fixture is parsed once (the syntax tree rides along for the parse test).
      let code: string;
      let metrics: CodeMetrics;
      beforeAll(() => {
        code = readFileSync(path.join(fixturesDir, 'oss', expectation.file), 'utf8');
        metrics = measureCode(code, { language: expectation.language, includeSyntaxTree: true });
      });

      it('parses without syntax errors', () => {
        expect(metrics.syntaxTree).not.toContain('(ERROR');
        expect(metrics.syntaxTree).not.toContain('(MISSING');
      });

      it('matches the verified aggregate metrics', () => {
        expect(metrics.language).toBe(expectation.language);
        expect(metrics.bytes).toBe(Buffer.byteLength(code));
        expect(roundFloats(metrics)).toEqual(expectation.aggregates);
      });

      it('matches every tool-verified per-function value', () => {
        const bySpan = keyFunctionsBySpan(metrics);
        for (const [name, startLine, endLine, metric, tool, value] of expectation.oracleFunctions) {
          const fn = lookupFunction(bySpan, name, startLine, endLine);
          expect(fn[metricField[metric]], `${metric} of ${name}@${startLine} (verified with ${tool})`).toBe(value);
        }
      });

      it('stays on the documented side of every known tool divergence', () => {
        const bySpan = keyFunctionsBySpan(metrics);
        for (const [
          name,
          startLine,
          endLine,
          metric,
          tool,
          toolValue,
          codeGaugeValue,
        ] of expectation.knownDivergences) {
          const fn = lookupFunction(bySpan, name, startLine, endLine);
          const actual = fn[metricField[metric]];
          expect(actual, `${metric} of ${name}@${startLine} (documented divergence from ${tool})`).toBe(codeGaugeValue);
          // If this fails, code-gauge now agrees with the tool: move the entry to oracleFunctions.
          expect(actual, `${metric} of ${name}@${startLine} unexpectedly matches ${tool}`).not.toBe(toolValue);
        }
      });
    });
  }

  it('covers every supported language', () => {
    const covered = new Set(ossExpectations.map((expectation) => expectation.language));
    expect([...covered].toSorted()).toEqual([...supportedLanguages].toSorted());
  });

  it('has an expectation for every fixture file in the corpus', () => {
    // The corpus loader is the single source of truth for what counts as a measurable fixture
    // (extension map, recursive walk), so whatever nativeParity measures must be expected here.
    const measurableFiles = loadFixtureCorpus({ includeOss: true })
      .filter((entry) => entry.name.startsWith('oss/'))
      .map((entry) => entry.name.slice('oss/'.length))
      .toSorted();
    expect(measurableFiles).toEqual(ossExpectations.map((expectation) => expectation.file).toSorted());
  });
});
