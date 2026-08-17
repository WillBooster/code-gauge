#!/usr/bin/env node
// Release-time pipeline for the prebuilt napi platform packages (#52), driven by
// @semantic-release/exec: `prepare` waits for the released commit's "Build Native" workflow run,
// downloads its artifacts, wraps each in a `code-gauge-<platform>` package, and injects them into
// the main package's optionalDependencies at the released version (only in the packed tarball —
// the committed package.json stays version-less, like the 0.0.0-semantically-released version
// field); `publish` publishes the platform packages before @semantic-release/npm publishes the
// main package. Platform packages are published with NPM_TOKEN (npm trusted publishing cannot
// create a package, so first publishes need a token); once every platform package exists on the
// registry, a tokenless run proceeds and relies on per-package trusted publishers. Until either
// holds, the pipeline skips with a warning instead of failing the main release, and skipping also
// leaves optionalDependencies uninjected so the main package never references unpublished
// versions — installs then keep today's source-build fallback.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFilePath = path.join(packageRoot, '.tmp', 'native-release.json');
const registryUrl = 'https://registry.npmjs.org/';

// The platform-package suffixes follow the napi-rs naming convention the runtime loader and
// scripts/installNative.mjs already probe; `library` names match build-native.yml's artifacts.
const platformTargets = [
  {
    triple: 'x86_64-unknown-linux-gnu',
    suffix: 'linux-x64-gnu',
    os: 'linux',
    cpu: 'x64',
    libc: 'glibc',
    library: 'libcode_gauge_native.so',
  },
  {
    triple: 'aarch64-unknown-linux-gnu',
    suffix: 'linux-arm64-gnu',
    os: 'linux',
    cpu: 'arm64',
    libc: 'glibc',
    library: 'libcode_gauge_native.so',
  },
  {
    triple: 'x86_64-unknown-linux-musl',
    suffix: 'linux-x64-musl',
    os: 'linux',
    cpu: 'x64',
    libc: 'musl',
    library: 'libcode_gauge_native.so',
  },
  {
    triple: 'aarch64-unknown-linux-musl',
    suffix: 'linux-arm64-musl',
    os: 'linux',
    cpu: 'arm64',
    libc: 'musl',
    library: 'libcode_gauge_native.so',
  },
  {
    triple: 'x86_64-apple-darwin',
    suffix: 'darwin-x64',
    os: 'darwin',
    cpu: 'x64',
    library: 'libcode_gauge_native.dylib',
  },
  {
    triple: 'aarch64-apple-darwin',
    suffix: 'darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
    library: 'libcode_gauge_native.dylib',
  },
  {
    triple: 'x86_64-pc-windows-msvc',
    suffix: 'win32-x64-msvc',
    os: 'win32',
    cpu: 'x64',
    library: 'code_gauge_native.dll',
  },
];

const [mode, version] = process.argv.slice(2);
if (mode === 'prepare' && version) {
  await prepare(version);
} else if (mode === 'publish') {
  await publish();
} else {
  console.error('Usage: prepareNativePackages.mjs prepare <version> | publish');
  process.exit(1);
}

async function prepare(newVersion) {
  if (!process.env.NPM_TOKEN && !(await allPlatformPackagesExist())) {
    console.warn(
      'Skipping the platform packages: NPM_TOKEN is not set and not every code-gauge-* platform ' +
        'package exists on registry.npmjs.org yet. Complete the bootstrap steps in ' +
        'https://github.com/WillBooster/code-gauge/issues/52 to enable prebuilt publishes.'
    );
    writeState({ publish: false });
    return;
  }

  const artifactsDirPath = path.join(packageRoot, '.tmp', 'native-artifacts');
  const packagesDirPath = path.join(packageRoot, '.tmp', 'npm-native');
  rmSync(artifactsDirPath, { recursive: true, force: true });
  rmSync(packagesDirPath, { recursive: true, force: true });
  mkdirSync(artifactsDirPath, { recursive: true });

  const runId = await waitForBuildNativeRun();
  execFileSync('gh', ['run', 'download', String(runId), '--dir', artifactsDirPath], { stdio: 'inherit' });

  const mainPackageJson = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const packageDirPaths = [];
  for (const target of platformTargets) {
    const libraryPath = path.join(artifactsDirPath, `code-gauge-${target.triple}`, target.library);
    if (!existsSync(libraryPath) || statSync(libraryPath).size === 0) {
      throw new Error(`Missing or empty artifact for ${target.triple}: ${libraryPath}`);
    }
    const packageDirPath = path.join(packagesDirPath, `code-gauge-${target.suffix}`);
    mkdirSync(packageDirPath, { recursive: true });
    copyFileSync(libraryPath, path.join(packageDirPath, 'code-gauge.node'));
    writeFileSync(
      path.join(packageDirPath, 'package.json'),
      `${JSON.stringify(createPlatformPackageJson(target, newVersion, mainPackageJson), undefined, 2)}\n`
    );
    writeFileSync(
      path.join(packageDirPath, 'README.md'),
      `# code-gauge-${target.suffix}\n\nPrebuilt \`${target.triple}\` native addon for ` +
        `[code-gauge](https://www.npmjs.com/package/code-gauge). Install \`code-gauge\` instead of ` +
        `this package; installers pick it up automatically via optionalDependencies.\n`
    );
    packageDirPaths.push(packageDirPath);
  }

  mainPackageJson.optionalDependencies = Object.fromEntries(
    platformTargets.map((target) => [`code-gauge-${target.suffix}`, newVersion])
  );
  writeFileSync(path.join(packageRoot, 'package.json'), `${JSON.stringify(mainPackageJson, undefined, 2)}\n`);

  writeState({ publish: true, version: newVersion, packageDirPaths });
}

async function publish() {
  const state = JSON.parse(readFileSync(stateFilePath, 'utf8'));
  if (!state.publish) {
    console.warn('Skipping the platform-package publish (see the prepare step warning).');
    return;
  }
  // The token goes through npm's env-var expansion instead of being written to disk. Without a
  // token the userconfig is still written (empty-expanding) but npm's trusted-publishing OIDC
  // exchange takes precedence on registry.npmjs.org, matching the bootstrap-then-OIDC plan.
  const userconfigPath = path.join(packageRoot, '.tmp', 'npm-native', '.npmrc');
  // oxlint-disable-next-line no-template-curly-in-string -- npm expands the reference at run time.
  writeFileSync(userconfigPath, '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n');
  for (const packageDirPath of state.packageDirPaths) {
    const packageName = path.basename(packageDirPath);
    // A re-run of a partially failed release must not fail on the packages it already published.
    if (await packageVersionExists(packageName, state.version)) {
      console.warn(`Skipping ${packageName}@${state.version}: already published.`);
      continue;
    }
    const publishArgs = ['publish', '--userconfig', userconfigPath];
    try {
      execFileSync('npm', publishArgs, {
        cwd: packageDirPath,
        stdio: 'inherit',
        env: { ...process.env, NPM_TOKEN: process.env.NPM_TOKEN ?? '' },
      });
    } catch {
      // One retry covers transient registry failures; a reproducible failure must abort the
      // release before the main package references unpublished platform packages.
      execFileSync('npm', publishArgs, {
        cwd: packageDirPath,
        stdio: 'inherit',
        env: { ...process.env, NPM_TOKEN: process.env.NPM_TOKEN ?? '' },
      });
    }
  }
}

async function waitForBuildNativeRun() {
  // Build Native starts from the same push that triggered the release, so poll until its run for
  // this commit completes. Re-releases of old commits can outlive the 90-day artifact retention;
  // the download then fails loudly and the release must be re-run from a fresh build.
  const deadline = Date.now() + 45 * 60 * 1000;
  for (;;) {
    const runsJson = execFileSync(
      'gh',
      [
        'run',
        'list',
        '--workflow',
        'build-native.yml',
        '--commit',
        requireEnv('GITHUB_SHA'),
        '--json',
        'databaseId,status,conclusion',
      ],
      { encoding: 'utf8' }
    );
    const runs = JSON.parse(runsJson);
    const completed = runs.find((run) => run.status === 'completed');
    if (completed?.conclusion === 'success') return completed.databaseId;
    if (completed) {
      throw new Error(
        `Build Native run ${completed.databaseId} for ${process.env.GITHUB_SHA} concluded: ${completed.conclusion}`
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for a successful Build Native run for ${process.env.GITHUB_SHA}`);
    }
    console.info(
      `Waiting for the Build Native run for ${process.env.GITHUB_SHA} (${runs.length} run(s) in progress)...`
    );
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

function createPlatformPackageJson(target, newVersion, mainPackageJson) {
  return {
    name: `code-gauge-${target.suffix}`,
    version: newVersion,
    description: `Prebuilt ${target.triple} native addon for code-gauge`,
    repository: mainPackageJson.repository,
    license: mainPackageJson.license,
    author: mainPackageJson.author,
    main: 'code-gauge.node',
    files: ['code-gauge.node'],
    os: [target.os],
    cpu: [target.cpu],
    ...(target.libc ? { libc: [target.libc] } : {}),
    publishConfig: { access: 'public', registry: registryUrl },
  };
}

async function allPlatformPackagesExist() {
  const results = await Promise.all(
    platformTargets.map(async (target) => {
      const response = await fetch(`${registryUrl}code-gauge-${target.suffix}`, { method: 'HEAD' });
      return response.ok;
    })
  );
  return results.every(Boolean);
}

async function packageVersionExists(packageName, packageVersion) {
  const response = await fetch(`${registryUrl}${packageName}/${encodeURIComponent(packageVersion)}`);
  return response.ok;
}

function writeState(state) {
  mkdirSync(path.dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, `${JSON.stringify(state)}\n`);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
