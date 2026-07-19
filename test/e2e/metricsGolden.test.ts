import { describe, expect, it } from 'vitest';
import { measureCode } from '../../src/index.js';
import { loadFixtureCorpus } from './fixtureCorpus.js';

// Golden snapshots of the COMPLETE CodeMetrics object for every fixture. These pin the exact
// behavior of the measurer (including float values, ordering of arrays, and duplication groups),
// so any implementation change — in particular the native Rust backend — must reproduce the
// TypeScript implementation bit-for-bit to stay green.

describe('measureCode: golden metrics for the fixture corpus', () => {
  for (const entry of loadFixtureCorpus()) {
    it(`matches the golden metrics for ${entry.name}`, () => {
      const metrics = measureCode(entry.code, { language: entry.language });
      expect(metrics).toMatchSnapshot();
    });
  }
});

describe('measureCode: golden edge cases', () => {
  it('matches the golden metrics for empty input', () => {
    expect(measureCode('', { language: 'typescript' })).toMatchSnapshot();
  });

  it('matches the golden metrics for whitespace-only input', () => {
    expect(measureCode(' \n\t\n  \n', { language: 'javascript' })).toMatchSnapshot();
  });

  it('matches the golden syntax tree output', () => {
    const metrics = measureCode('function run() { return 1; }\n', {
      language: 'javascript',
      includeSyntaxTree: true,
    });
    expect(metrics.syntaxTree).toMatchSnapshot();
  });
});
