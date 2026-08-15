#!/usr/bin/env node
// Postinstall hook ensuring the native Rust addon is available: a prebuilt platform package or an
// already-built native/code-gauge.node is kept as-is, otherwise the addon is built from the
// bundled sources when a Rust toolchain is available. Never fails the install: the runtime loader
// raises a descriptive error on first use if no addon could be provided.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// The platform-package suffix in the napi-rs naming convention: Linux targets are qualified by
// libc ABI because a glibc-linked addon cannot load on Alpine/musl. Must match platformTriplet in
// src/nativeMetrics.ts.
function platformTriplet() {
  const base = `${process.platform}-${process.arch}`;
  if (process.platform !== 'linux') {
    return base;
  }
  return process.report?.getReport()?.header?.glibcVersionRuntime ? `${base}-gnu` : `${base}-musl`;
}

try {
  require.resolve(`code-gauge-${platformTriplet()}`);
  process.exit(0);
} catch {
  // No prebuilt platform package; fall through to a local build.
}

if (existsSync(path.join(packageRoot, 'native', 'code-gauge.node'))) {
  process.exit(0);
}

try {
  execFileSync(process.execPath, [path.join(packageRoot, 'scripts', 'buildNative.mjs')], { stdio: 'inherit' });
} catch (error) {
  console.warn(
    `code-gauge: could not build the native addon (${error instanceof Error ? error.message : String(error)}). ` +
      'Install a Rust toolchain and run `node scripts/buildNative.mjs` in the package directory to enable it.'
  );
}
