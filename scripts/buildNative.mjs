#!/usr/bin/env node
// Builds the native Rust addon and places it at native/code-gauge.node, where the TypeScript
// loader picks it up. Requires a Rust toolchain; the library falls back to the TypeScript
// implementation when the addon has not been built.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = path.join(repoRoot, 'native');

execFileSync('cargo', ['build', '--release'], { cwd: nativeDir, stdio: 'inherit' });

const libraryNames = ['libcode_gauge_native.dylib', 'libcode_gauge_native.so', 'code_gauge_native.dll'];
const builtLibrary = libraryNames
  .map((name) => path.join(nativeDir, 'target', 'release', name))
  .find((candidate) => existsSync(candidate));
if (!builtLibrary) {
  throw new Error('cargo build succeeded but no native library was found in native/target/release');
}

const output = path.join(nativeDir, 'code-gauge.node');
copyFileSync(builtLibrary, output);
console.log(`Built ${output}`);
