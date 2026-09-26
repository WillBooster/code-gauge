#!/usr/bin/env node
// Builds the WebAssembly variant of the native addon for runtimes without N-API (Cloudflare
// Workers) and places it at native/code-gauge.wasm, where src/worker.ts imports it. The grammars'
// C sources need a WASI C toolchain: WASI_SDK_PATH if set, otherwise a wasi-sdk release
// downloaded into native/target. Requires a Rust toolchain.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wasiLibcCommit, wasiSdkVersion } from './wasiSdk.mjs';

const target = 'wasm32-wasip1';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDir = path.join(repoRoot, 'native');
const wasiSdkPath = process.env.WASI_SDK_PATH || downloadWasiSdk();
const executableSuffix = process.platform === 'win32' ? '.exe' : '';

execFileSync('rustup', ['target', 'add', target], { cwd: nativeDir, stdio: 'inherit' });
execFileSync('cargo', ['build', '--release', '--locked', '--target', target], {
  cwd: nativeDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    CC_wasm32_wasip1: path.join(wasiSdkPath, 'bin', `clang${executableSuffix}`),
    AR_wasm32_wasip1: path.join(wasiSdkPath, 'bin', `llvm-ar${executableSuffix}`),
  },
});

const output = path.join(nativeDir, 'code-gauge.wasm');
copyFileSync(path.join(nativeDir, 'target', target, 'release', 'code_gauge_native.wasm'), output);
console.log(`Built ${output}`);

function downloadWasiSdk() {
  const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  const os = { darwin: 'macos', linux: 'linux', win32: 'windows' }[process.platform];
  if (!arch || !os) {
    throw new Error(`No wasi-sdk release for ${process.platform}-${process.arch}; set WASI_SDK_PATH`);
  }
  const name = `wasi-sdk-${wasiSdkVersion}-${arch}-${os}`;
  const downloadDir = path.join(nativeDir, 'target');
  const sdkPath = path.join(downloadDir, name);
  if (!existsSync(sdkPath)) {
    mkdirSync(downloadDir, { recursive: true });
    const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${wasiSdkVersion.split('.')[0]}/${name}.tar.gz`;
    console.log(`Downloading ${url}`);
    execFileSync('curl', ['-fsSL', '-o', `${sdkPath}.tar.gz`, url], { stdio: 'inherit' });
    execFileSync('tar', ['-xzf', `${sdkPath}.tar.gz`, '-C', downloadDir], { stdio: 'inherit' });
  }
  const linkedCommit = /^wasi-libc: (\S+)$/m.exec(readFileSync(path.join(sdkPath, 'VERSION'), 'utf8'))?.[1];
  if (linkedCommit !== wasiLibcCommit) {
    throw new Error(
      `wasi-sdk ${wasiSdkVersion} links wasi-libc ${linkedCommit}, but scripts/wasiSdk.mjs names ${wasiLibcCommit}`
    );
  }
  return sdkPath;
}
