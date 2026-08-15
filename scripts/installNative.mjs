#!/usr/bin/env node
// Postinstall hook ensuring the native Rust addon is available: a prebuilt platform package or an
// already-built native/code-gauge.node is kept when it serves the payload version this checkout
// expects (a stale addon surviving a `git pull` must not be kept — the runtime loader would
// reject it), otherwise the addon is built from the bundled sources when a Rust toolchain is
// available. Never fails the install — the whole body is guarded and the process always exits 0
// (npm runs lifecycle scripts through cmd.exe on Windows, where a `|| true` suffix would not
// work) — and the runtime loader raises a descriptive error on first use if no addon could be
// provided.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// No explicit process.exit: nothing here keeps the event loop alive, so the process ends with
// code 0 on its own once the synchronous work returns — and exit() could truncate the warning's
// asynchronous stderr write (stderr is a pipe under npm, which is asynchronous on Windows).
try {
  installNativeAddon();
} catch (error) {
  warnBuildFailure(error);
}

function installNativeAddon() {
  // The authoritative payload version lives in the bundled Rust source; a parse failure yields
  // undefined, which no addon reports, so validation then always falls through to a fresh build.
  const expectedPayloadVersion = /pub fn payload_version\(\) -> u32 \{\s*(\d+)/.exec(
    readFileSync(path.join(packageRoot, 'native', 'src', 'lib.rs'), 'utf8')
  )?.[1];

  if (
    servesExpectedPayload(`code-gauge-${platformTriplet()}`, expectedPayloadVersion) ||
    servesExpectedPayload(path.join(packageRoot, 'native', 'code-gauge.node'), expectedPayloadVersion)
  ) {
    return;
  }

  try {
    execFileSync(process.execPath, [path.join(packageRoot, 'scripts', 'buildNative.mjs')], { stdio: 'inherit' });
    // In an installed package the cargo build tree (hundreds of MB) buys nothing once the addon
    // is copied out; a repository checkout (recognized by its sources) keeps it as the build
    // cache.
    if (!existsSync(path.join(packageRoot, 'src'))) {
      rmSync(path.join(packageRoot, 'native', 'target'), { recursive: true, force: true });
    }
  } catch (error) {
    warnBuildFailure(error);
  }
}

// The platform-package suffix in the napi-rs naming convention: Linux is qualified by libc ABI
// (a glibc-linked addon cannot load on Alpine/musl) and Windows by toolchain ABI. Must match
// platformTriplet in src/nativeMetrics.ts.
function platformTriplet() {
  const base = `${process.platform}-${process.arch}`;
  if (process.platform === 'win32') {
    return `${base}-msvc`;
  }
  if (process.platform !== 'linux') {
    return base;
  }
  return process.report?.getReport()?.header?.glibcVersionRuntime ? `${base}-gnu` : `${base}-musl`;
}

// Probed in a child process: loading the addon here would keep its library mapped for this
// process's lifetime, and overwriting a mapped DLL is refused on Windows — exactly what the
// stale-addon rebuild below must be able to do.
function servesExpectedPayload(specifier, expectedPayloadVersion) {
  try {
    const reported = execFileSync(
      process.execPath,
      ['-p', `String(require(${JSON.stringify(specifier)}).payloadVersion?.())`],
      // stderr is discarded: a missing platform package is the normal case, not a diagnostic.
      { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return expectedPayloadVersion !== undefined && reported === expectedPayloadVersion;
  } catch {
    return false;
  }
}

function warnBuildFailure(error) {
  console.warn(
    `code-gauge: could not build the native addon (${error instanceof Error ? error.message : String(error)}). ` +
      'Install a Rust toolchain and run `node scripts/buildNative.mjs` in the package directory to enable it.'
  );
}
