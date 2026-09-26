import path from 'node:path';
import { createTestHarness, type TestHarness } from 'wrangler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as codeGauge from '../../src/index.js';
import { run } from '../helpers/globalSetup.js';
import { loadFixtureCorpus } from './fixtureCorpus.js';

// Runs the package's `workerd` export (the WebAssembly build) inside workerd through a Worker that
// imports `code-gauge`, and compares its results with the N-API addon's in Node.js.
type WorkerApi = {
  [Name in 'measureCode' | 'collectCrossFileDuplicationFileData' | 'collectFunctionTokenSequences']: (
    ...args: Parameters<(typeof codeGauge)[Name]>
  ) => Promise<ReturnType<(typeof codeGauge)[Name]>>;
};

let server: TestHarness | undefined;
let worker: WorkerApi;

beforeAll(async () => {
  // Built here rather than in the global setup, so that other tests need no WASI toolchain.
  run(path.join(import.meta.dirname, '..', '..'), 'bun', ['run', 'build-wasm'], 1_200_000);
  server = createTestHarness({
    workers: [{ configPath: path.join(import.meta.dirname, 'worker', 'wrangler.jsonc') }],
  });
  await server.listen();
  worker = (await server.getWorker().getExport()) as unknown as WorkerApi;
}, 1_320_000);

afterAll(async () => {
  await server?.close();
});

describe('Cloudflare Workers', () => {
  it('measures the fixture corpus identically to the N-API addon', async () => {
    for (const { name, code, language } of loadFixtureCorpus({ includeOss: true })) {
      const options = { language, includeSyntaxTree: true };
      expect(await worker.measureCode(code, options), name).toEqual(codeGauge.measureCode(code, options));
      expect(await worker.collectCrossFileDuplicationFileData(code, options), name).toEqual(
        codeGauge.collectCrossFileDuplicationFileData(code, options)
      );
      expect(await worker.collectFunctionTokenSequences(code, options), name).toEqual(
        codeGauge.collectFunctionTokenSequences(code, options)
      );
    }
  }, 300_000);

  it('measures deeply nested code', async () => {
    const code = `function f() { return ${'('.repeat(3000)}1${')'.repeat(3000)}; }`;
    expect(await worker.measureCode(code, { language: 'javascript' })).toEqual(
      codeGauge.measureCode(code, { language: 'javascript' })
    );
  }, 60_000);

  it('reports errors raised by the native code and keeps measuring afterwards', async () => {
    const tooDeep = `const x = ${'('.repeat(6000)}1${')'.repeat(6000)};`;
    await expect(async () => worker.measureCode(tooDeep, { language: 'javascript' })).rejects.toThrow(
      'tree depth exceeds'
    );
    // Beyond the runtime's stack limit, which is below the native depth limit, the module traps.
    const deep = `function f() { return ${'('.repeat(4990)}1${')'.repeat(4990)}; }`;
    await expect(async () => worker.measureCode(deep, { language: 'javascript' })).rejects.toThrow(
      'WebAssembly module crashed'
    );
    const code = 'const s = "\uD800";';
    expect(await worker.measureCode(code, { language: 'javascript' })).toEqual(
      codeGauge.measureCode(code, { language: 'javascript' })
    );
  }, 60_000);
});
