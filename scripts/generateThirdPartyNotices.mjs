#!/usr/bin/env node
// Generates .tmp/THIRD-PARTY-NOTICES.txt for the prebuilt platform packages (#52): the addon
// statically links its Rust dependencies, so the binary distribution must carry their license
// TEXTS and copyright notices (a license identifier plus a repository link would not satisfy
// MIT's notice-inclusion requirement or Apache-2.0 §4). The crates' bundled LICENSE/COPYING/
// NOTICE files are read from a `cargo vendor` tree, which downloads and extracts every resolved
// crate. Run by build-native.yml, which uploads the file as an artifact the release pipeline
// bundles into every platform package.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const nativeDirPath = path.join(packageRoot, 'native');
const vendorDirPath = path.join(packageRoot, '.tmp', 'vendor');

// Upstream copyright notices for the MIT crates whose PUBLISHED sources bundle no license file
// (MIT requires the copyright notice to accompany distributions, and Cargo authors are not a
// substitute). Taken from each repository's LICENSE at the pinned version's tag. Generation
// fails fast on any crate that bundles no license file and has no entry here, so a future
// dependency (or license change) forces an explicit decision instead of a wrong notice.
const upstreamCopyrights = {
  napi: 'Copyright (c) 2020-present LongYinan',
  'napi-build': 'Copyright (c) 2020-present LongYinan',
  'napi-derive': 'Copyright (c) 2020-present LongYinan',
  'napi-derive-backend': 'Copyright (c) 2020-present LongYinan',
  'napi-sys': 'Copyright (c) 2020-present LongYinan',
  'tree-sitter': 'Copyright (c) 2018-2024 Max Brunsfeld',
  'tree-sitter-c': 'Copyright (c) 2014 Max Brunsfeld',
  'tree-sitter-cpp': 'Copyright (c) 2014 Max Brunsfeld',
  'tree-sitter-go': 'Copyright (c) 2014 Max Brunsfeld',
  'tree-sitter-java': 'Copyright (c) 2017 Ayman Nadeem',
  'tree-sitter-javascript': 'Copyright (c) 2014 Max Brunsfeld',
  'tree-sitter-python': 'Copyright (c) 2016 Max Brunsfeld',
  'tree-sitter-ruby': 'Copyright (c) 2016 Rob Rix',
  'tree-sitter-rust': 'Copyright (c) 2017 Maxim Sokolov',
  'tree-sitter-typescript': 'Copyright (c) 2017 Max Brunsfeld',
};

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1'], {
    cwd: nativeDirPath,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
);
const workspaceMembers = new Set(metadata.workspace_members);
// The full resolved graph, deliberately a superset of what the release binary links (it also
// contains build dependencies and other platforms' crates): over-attribution is harmless, while
// a missed crate is a license violation.
const crates = metadata.packages
  .filter((crate) => !workspaceMembers.has(crate.id))
  .toSorted((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

rmSync(vendorDirPath, { recursive: true, force: true });
// --versioned-dirs makes each crate's directory `<name>-<version>`, so the lookup below cannot
// pick up a different version of the same crate. stdout (the suggested cargo config) is discarded.
execFileSync('cargo', ['vendor', '--versioned-dirs', vendorDirPath], {
  cwd: nativeDirPath,
  stdio: ['ignore', 'ignore', 'inherit'],
});

const separator = '='.repeat(100);
const sections = crates.map((crate) => {
  const header =
    `${separator}\n${crate.name} ${crate.version} — ${crate.license ?? 'see the license files below'}` +
    `${crate.repository ? ` — ${crate.repository}` : ''}\n${separator}`;
  const crateDirPath = path.join(vendorDirPath, `${crate.name}-${crate.version}`);
  let licenseFileNames = [];
  try {
    licenseFileNames = readdirSync(crateDirPath)
      .filter((fileName) => /^(licen[cs]e|copying|notice)/i.test(fileName))
      .toSorted();
  } catch {
    // A crate absent from the vendor tree falls through to the no-file fallback below.
  }
  if (licenseFileNames.length === 0) {
    const copyright = upstreamCopyrights[crate.name];
    if (!copyright || crate.license !== 'MIT') {
      throw new Error(
        `${crate.name}@${crate.version} (license: ${crate.license}) bundles no license file and has no ` +
          'checked-in upstream copyright notice; add its notice to upstreamCopyrights (and its license ' +
          'text to the appendix if it is not MIT).'
      );
    }
    return (
      `${header}\nThis crate's published sources bundle no license file; the upstream notice is:\n` +
      `${copyright}\nThe canonical text of the MIT license is reproduced in the appendix at the end of ` +
      'this document.\n'
    );
  }
  const texts = licenseFileNames.map(
    (fileName) => `----- ${fileName} -----\n${readFileSync(path.join(crateDirPath, fileName), 'utf8').trim()}\n`
  );
  return `${header}\n${texts.join('\n')}`;
});

const output =
  'Third-party notices for the code-gauge native addon\n\n' +
  'The prebuilt code-gauge native addon statically links Rust crates from the dependency graph\n' +
  'below (the list is a superset that also covers build-time and other-platform crates). Each\n' +
  "entry reproduces the license and notice files bundled in the crate's published sources.\n\n" +
  `${sections.join('\n')}\n${separator}\nAppendix: canonical MIT license text (for crates whose published sources bundle no license file)\n${separator}\n\n${mitLicenseText()}\n`;
mkdirSync(path.join(packageRoot, '.tmp'), { recursive: true });
writeFileSync(path.join(packageRoot, '.tmp', 'THIRD-PARTY-NOTICES.txt'), output);
rmSync(vendorDirPath, { recursive: true, force: true });
console.info(`Wrote .tmp/THIRD-PARTY-NOTICES.txt (${crates.length} crates).`);

function mitLicenseText() {
  return `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
}
