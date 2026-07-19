#!/usr/bin/env node
// Benchmarks measureCode over a fixed corpus: every test fixture plus this repository's own
// TypeScript sources. Run `yarn build` first; switch backends with CODE_GAUGE_NATIVE=0/1.
// Usage: node scripts/benchmark.mjs [passes]

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isNativeBackendAvailable, measureCode } from '../dist/index.js';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const languageByExtension = new Map([
  ['.c', 'c'],
  ['.cpp', 'cpp'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.py', 'python'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
]);

function collectCorpus() {
  const corpus = [];
  for (const directory of ['test/fixtures', 'src']) {
    const absoluteDirectory = path.join(repoRoot, directory);
    for (const file of readdirSync(absoluteDirectory, { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) {
        continue;
      }
      const language = languageByExtension.get(path.extname(file.name));
      if (!language) {
        continue;
      }
      const filePath = path.join(file.parentPath, file.name);
      corpus.push({
        name: path.relative(repoRoot, filePath),
        language,
        code: readFileSync(filePath, 'utf8'),
      });
    }
  }
  return corpus;
}

function runPass(corpus) {
  const start = performance.now();
  let functionCount = 0;
  for (const entry of corpus) {
    functionCount += measureCode(entry.code, { language: entry.language }).functionCount;
  }
  return { elapsedMs: performance.now() - start, functionCount };
}

const passes = Number(process.argv[2] ?? 20);
if (!Number.isSafeInteger(passes) || passes < 1) {
  console.error('Usage: node scripts/benchmark.mjs [passes]  (passes must be a positive integer)');
  process.exit(1);
}
const corpus = collectCorpus();
const totalBytes = corpus.reduce((sum, entry) => sum + Buffer.byteLength(entry.code), 0);
const totalLines = corpus.reduce((sum, entry) => sum + entry.code.split('\n').length, 0);

console.log(`Backend: ${isNativeBackendAvailable() ? 'native (Rust)' : 'typescript'}`);
console.log(`Corpus: ${corpus.length} files, ${totalLines} lines, ${(totalBytes / 1024).toFixed(1)} KiB`);

// Warmup (JIT, parser initialization).
runPass(corpus);
runPass(corpus);

const timings = [];
let checksum = 0;
for (let pass = 0; pass < passes; pass += 1) {
  const { elapsedMs, functionCount } = runPass(corpus);
  timings.push(elapsedMs);
  checksum = functionCount;
}

timings.sort((left, right) => left - right);
const middle = Math.floor(timings.length / 2);
const median = timings.length % 2 === 0 ? (timings[middle - 1] + timings[middle]) / 2 : timings[middle];
const best = timings[0];
const mean = timings.reduce((sum, value) => sum + value, 0) / timings.length;

console.log(`Passes: ${passes} (functions per pass: ${checksum})`);
console.log(`Median: ${median.toFixed(1)} ms/pass  (best ${best.toFixed(1)}, mean ${mean.toFixed(1)})`);
console.log(`Throughput: ${((totalLines * 1000) / median).toFixed(0)} lines/s`);
