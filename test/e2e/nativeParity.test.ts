import { afterAll, describe, expect, it } from 'vitest';
import { isNativeBackendAvailable, measureCode, type CodeMetrics, type MeasureOptions } from '../../src/index.js';
import { loadFixtureCorpus } from './fixtureCorpus.js';

// Verifies that the Rust backend and the TypeScript backend produce STRICTLY equal metrics for
// the whole fixture corpus. The backend is chosen per call via CODE_GAUGE_NATIVE, so both run in
// this process. Skipped when the native addon has not been built (`yarn build-native`).

const nativeAvailable = isNativeBackendAvailable();

function measureWith(backend: 'native' | 'typescript', code: string, options: MeasureOptions): CodeMetrics {
  const previous = process.env.CODE_GAUGE_NATIVE;
  process.env.CODE_GAUGE_NATIVE = backend === 'native' ? '1' : '0';
  // Strict mode rethrows native errors, so a throwing binding fails these comparisons instead of
  // silently degrading them into TypeScript-vs-TypeScript checks via the production fallback.
  process.env.CODE_GAUGE_NATIVE_STRICT = backend === 'native' ? '1' : '0';
  try {
    return measureCode(code, options);
  } finally {
    delete process.env.CODE_GAUGE_NATIVE_STRICT;
    if (previous === undefined) {
      delete process.env.CODE_GAUGE_NATIVE;
    } else {
      process.env.CODE_GAUGE_NATIVE = previous;
    }
  }
}

afterAll(() => {
  delete process.env.CODE_GAUGE_NATIVE;
});

describe.skipIf(!nativeAvailable)('native backend parity with the TypeScript backend', () => {
  for (const entry of loadFixtureCorpus({ includeOss: true })) {
    it(`produces identical metrics for ${entry.name}`, () => {
      const expected = measureWith('typescript', entry.code, { language: entry.language });
      const actual = measureWith('native', entry.code, { language: entry.language });
      expect(actual).toStrictEqual(expected);
    });
  }

  it('produces identical metrics for empty and whitespace-only input', () => {
    for (const code of ['', ' \n\t\n  \n']) {
      expect(measureWith('native', code, { language: 'typescript' })).toStrictEqual(
        measureWith('typescript', code, { language: 'typescript' })
      );
    }
  });

  it('produces an identical syntax tree when requested', () => {
    const code = 'function run() { return 1; }\n';
    const options: MeasureOptions = { language: 'javascript', includeSyntaxTree: true };
    expect(measureWith('native', code, options)).toStrictEqual(measureWith('typescript', code, options));
  });
});

describe('backend selection', () => {
  it('reports whether the native backend is available', () => {
    // CODE_GAUGE_EXPECT_NATIVE=1 (set by the `test/ci` script after `yarn build-native`) turns the
    // silent skip above into a hard failure, so CI cannot pass while the addon fails to build.
    if (process.env.CODE_GAUGE_EXPECT_NATIVE === '1') {
      expect(nativeAvailable).toBe(true);
    }
    expect(typeof nativeAvailable).toBe('boolean');
  });
});
