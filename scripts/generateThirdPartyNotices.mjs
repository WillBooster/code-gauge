#!/usr/bin/env node
// Generates .tmp/THIRD-PARTY-NOTICES.txt for the prebuilt platform packages (#52): the addon
// statically links its Rust dependencies, so the binary distribution must carry their license
// attributions (the source-only npm package did not — consumers' cargo builds fetched the crates
// themselves). Run by build-native.yml, which uploads the file as an artifact the release
// pipeline bundles into every platform package.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1'], {
    cwd: path.join(packageRoot, 'native'),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
);
const workspaceMembers = new Set(metadata.workspace_members);
const crates = metadata.packages
  .filter((crate) => !workspaceMembers.has(crate.id))
  .toSorted((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const lines = [
  'Third-party notices for the code-gauge native addon',
  '',
  'The prebuilt code-gauge native addon statically links the following Rust crates. Each entry',
  'lists the crate, its version, its declared SPDX license expression, and its source repository,',
  'where the full license texts and copyright notices are available.',
  '',
  ...crates.map(
    (crate) =>
      `- ${crate.name} ${crate.version} — ${crate.license ?? 'see repository'}${crate.repository ? ` — ${crate.repository}` : ''}`
  ),
  '',
];
mkdirSync(path.join(packageRoot, '.tmp'), { recursive: true });
writeFileSync(path.join(packageRoot, '.tmp', 'THIRD-PARTY-NOTICES.txt'), lines.join('\n'));
console.info(`Wrote .tmp/THIRD-PARTY-NOTICES.txt (${crates.length} crates).`);
