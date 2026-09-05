import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// These tests exercise the built CLI (dist/cli.js) as a real subprocess so the whole pipeline is
// covered: file/directory scanning, ignore rules, ranking, exit codes, and JSON output. The CLI is
// rebuilt in beforeAll so it always reflects the current source, and every fixture is generated in
// an isolated temp directory to keep the run hermetic.

const repoRoot = path.join(import.meta.dirname, '..', '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  // A `timeout` bounds each subprocess: `spawnSync` blocks the event loop, so Vitest's own per-test
  // timeout cannot interrupt a hung CLI. `result.error` (a spawn failure or the timeout itself) is
  // surfaced as a thrown error rather than being silently reported as a normal non-zero exit.
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(`Failed to run the CLI (${args.join(' ')}): ${result.error.message}`);
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// The `evaluate` function has cognitive complexity 18 (SonarSource model), which makes it the
// clear worst function of the generated project, so it must rank first.
const riskyFile = `export function evaluate(kind: string, value: number): number {
  if (kind === 'a') {
    if (value > 0) { return 1; }
    if (value < 0) { return -1; }
    return 0;
  } else if (kind === 'b') {
    for (let i = 0; i < value; i++) {
      if (i % 2 === 0 && i > 4) { return i; }
    }
  } else if (kind === 'c') {
    return value > 10 ? 10 : value < -10 ? -10 : value;
  }
  return value;
}
`;

let projectDir: string;

// The CLI itself is built once for every worker by test/helpers/globalSetup.ts.
beforeAll(() => {
  projectDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-cli-'));
  mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  mkdirSync(path.join(projectDir, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(path.join(projectDir, 'test'), { recursive: true });

  // The CLI searches ancestor directories for code-gauge.config.json and stops at the first hit, so
  // an empty config at the project root bounds the search: an ambient config above the OS temp
  // directory can no longer change settings and break these assertions.
  writeFileSync(path.join(projectDir, 'code-gauge.config.json'), '{}\n');
  writeFileSync(path.join(projectDir, 'src', 'risky.ts'), riskyFile);
  writeFileSync(
    path.join(projectDir, 'src', 'a.ts'),
    'export function helper(x: number): number { return x + 1; }\nexport const A = 1;\n'
  );
  writeFileSync(
    path.join(projectDir, 'src', 'b.ts'),
    'export function other(x: number): number { return x - 1; }\nexport const B = 2;\n'
  );
  // Files under node_modules and test/ must be ignored by default.
  writeFileSync(path.join(projectDir, 'node_modules', 'pkg', 'index.ts'), 'export const ignored = 1;\n');
  writeFileSync(path.join(projectDir, 'test', 'sample.test.ts'), 'export function testOnly() { return 42; }\n');
}, 120_000);

afterAll(() => {
  if (projectDir) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

describe('cli: text report', () => {
  it('summarizes a directory and skips node_modules and test files', () => {
    const { status, stdout } = runCli([projectDir]);

    expect(status).toBe(0);
    // risky.ts, a.ts, b.ts — node_modules/pkg/index.ts and test/sample.test.ts are excluded.
    expect(stdout).toMatch(/^Measured 3 files under /m);
    expect(stdout).toContain('Refactoring candidates (top 3):');
    expect(stdout).not.toContain('ignored');
  });

  it('ranks the file with the worst function first, with its evidence', () => {
    const { stdout } = runCli([projectDir]);

    expect(stdout).toMatch(
      /1\. src[\\/]risky\.ts \(score [\d.]+\): worst function evaluate \(L1-14\) cognitive 18, NCSS \d+, nesting \d+; file NCSS \d+/
    );
  });

  it('includes test files with --include-tests', () => {
    const { stdout } = runCli([projectDir, '--include-tests']);

    expect(stdout).toMatch(/^Measured 4 files under /m);
  });

  it('limits the list with --top', () => {
    const { stdout } = runCli([projectDir, '--top', '1']);

    expect(stdout).toContain('Refactoring candidates (top 1 of 3):');
    expect(stdout).not.toMatch(/^2\./m);
  });

  it('rejects non-positive --top arguments', () => {
    const { status, stderr } = runCli([projectDir, '--top', '0']);

    expect(status).not.toBe(0);
    expect(stderr).toContain('Expected a positive integer.');
  });
});

describe('cli: JSON output', () => {
  it('emits a structured JSON report', () => {
    const { stdout } = runCli([path.join(projectDir, 'src', 'risky.ts'), '--json']);
    const report = JSON.parse(stdout);

    expect(report.summary.fileCount).toBe(1);
    expect(report.summary.functionCount).toBe(1);
    expect(report.summary.maxCognitiveComplexity).toBe(18);
    expect(report.totalRankedFiles).toBe(1);
    expect(report.files[0]).toMatchObject({
      file: 'risky.ts',
      worstFunction: expect.objectContaining({ name: 'evaluate', cognitiveComplexity: 18 }),
    });
    expect(report.errors).toEqual([]);
  });

  it('honors --top and marks truncation', () => {
    const { stdout } = runCli([projectDir, '--json', '--top', '1']);
    const report = JSON.parse(stdout);

    expect(report.files.length).toBe(1);
    expect(report.totalRankedFiles).toBe(3);
    expect(report.truncated).toBe(true);
  });
});

describe('cli: configuration', () => {
  it('reads rank.top from an auto-detected code-gauge.config.json', () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-config-'));
    try {
      writeFileSync(path.join(configDir, 'risky.ts'), riskyFile);
      writeFileSync(path.join(configDir, 'other.ts'), 'export const other = 1;\n');
      writeFileSync(path.join(configDir, 'code-gauge.config.json'), JSON.stringify({ rank: { top: 1 } }));

      const { stdout } = runCli([configDir]);

      expect(stdout).toContain('Refactoring candidates (top 1 of 2):');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('lets a CLI flag override a --config value', () => {
    const configFile = path.join(projectDir, 'alt.config.json');
    writeFileSync(configFile, JSON.stringify({ rank: { top: 1 } }));

    const { stdout } = runCli([projectDir, '--config', configFile, '--top', '2']);

    expect(stdout).toContain('Refactoring candidates (top 2 of 3):');
  });

  it('rejects unknown config settings', () => {
    const configFile = path.join(projectDir, 'bad.config.json');
    writeFileSync(configFile, JSON.stringify({ thresholds: { cognitive: 5 } }));

    const { status, stderr } = runCli([projectDir, '--config', configFile]);

    expect(status).toBe(1);
    expect(stderr).toContain('thresholds');
  });
});

describe('cli: polyglot project scan', () => {
  it('measures every supported language end-to-end and reports a consistent JSON summary', () => {
    // The fixture directory itself is skipped by the scanner (`fixtures` is an ignored directory
    // name), so the corpus is copied into a plain src/ layout inside a temp project.
    const polyglotDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-polyglot-'));
    try {
      writeFileSync(path.join(polyglotDir, 'code-gauge.config.json'), '{}\n');
      mkdirSync(path.join(polyglotDir, 'src'), { recursive: true });
      const richDir = path.join(repoRoot, 'test', 'fixtures', 'rich');
      for (const file of readdirSync(richDir)) {
        copyFileSync(path.join(richDir, file), path.join(polyglotDir, 'src', file));
      }

      const { status, stdout } = runCli([polyglotDir, '--json']);
      const report = JSON.parse(stdout);

      expect(status).toBe(0);
      expect(report.summary.fileCount).toBe(13);
      expect(report.summary.functionCount).toBeGreaterThan(50);
      expect(report.summary.linesOfCode).toBeGreaterThan(500);
      expect(report.errors).toEqual([]);
    } finally {
      rmSync(polyglotDir, { recursive: true, force: true });
    }
  });
});

describe('cli: test-file naming conventions', () => {
  it('skips JUnit- and xUnit-style suffixed test files case-sensitively unless --include-tests', () => {
    const conventionsDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-conventions-'));
    try {
      writeFileSync(path.join(conventionsDir, 'code-gauge.config.json'), '{}\n');
      mkdirSync(path.join(conventionsDir, 'src'), { recursive: true });
      // .NET SDK intermediate output is generated code, skipped like other build directories.
      mkdirSync(path.join(conventionsDir, 'obj', 'Debug', 'net8.0'), { recursive: true });
      writeFileSync(
        path.join(conventionsDir, 'obj', 'Debug', 'net8.0', 'App.GlobalUsings.g.cs'),
        'global using System;\n'
      );
      const production = {
        'Order.cs': 'class Order { int Total() { return 1; } }\n',
        // Lowercase `test` suffixes are production names (`contest`), not test classes.
        'contest.cs': 'class Contest { int Rank() { return 1; } }\n',
        'Order.kt': 'class Order { fun total() = 1 }\n',
        'Order.java': 'class Order { int total() { return 1; } }\n',
      };
      const tests = {
        'OrderTests.cs': 'class OrderTests { void Run() { } }\n',
        'OrderTest.cs': 'class OrderTest { void Run() { } }\n',
        'OrderTests.kt': 'class OrderTests { fun run() { } }\n',
        'OrderTest.kt': 'class OrderTest { fun run() { } }\n',
        'OrderTests.java': 'class OrderTests { void run() { } }\n',
        'OrderTest.java': 'class OrderTest { void run() { } }\n',
      };
      for (const [file, code] of Object.entries({ ...production, ...tests })) {
        writeFileSync(path.join(conventionsDir, 'src', file), code);
      }

      const defaultRun = JSON.parse(runCli([conventionsDir, '--json']).stdout);
      expect(defaultRun.files.map((file: { file: string }) => path.basename(file.file)).toSorted()).toEqual(
        Object.keys(production).toSorted()
      );
      const withTests = JSON.parse(runCli([conventionsDir, '--json', '--include-tests']).stdout);
      expect(withTests.summary.fileCount).toBe(Object.keys(production).length + Object.keys(tests).length);
    } finally {
      rmSync(conventionsDir, { recursive: true, force: true });
    }
  });
});

// The comment and blank line inside the clone are covered by the occurrence's bounding range but
// are not duplicated content, so counting ranges instead of matched lines would report 14 lines
// (117%) instead of 12 (100%).
const cloneFile = (functionName: string, itemName: string): string => `export function ${functionName}(items) {
  let total = 0;
  let count = 0;
  // A comment line inside the cloned region.

  for (const ${itemName} of items) {
    if (${itemName}.status === 'paid') {
      total = total + ${itemName}.amount;
      count = count + 1;
    }
  }
  const average = count === 0 ? 0 : total / count;
  return average + total + count;
}
`;

describe('cli: cross-file duplication', () => {
  let cloneDir: string;

  beforeAll(() => {
    cloneDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-clones-'));
    writeFileSync(path.join(cloneDir, 'code-gauge.config.json'), '{}\n');
    mkdirSync(path.join(cloneDir, 'src'), { recursive: true });
    writeFileSync(path.join(cloneDir, 'src', 'orders.ts'), cloneFile('summarizeOrders', 'order'));
    // A consistently renamed copy in another file.
    writeFileSync(path.join(cloneDir, 'src', 'refunds.ts'), cloneFile('summarizeRefunds', 'refund'));
    writeFileSync(path.join(cloneDir, 'src', 'other.ts'), 'export const other = (x: number) => x * 2;\n');
  });

  afterAll(() => {
    if (cloneDir) {
      rmSync(cloneDir, { recursive: true, force: true });
    }
  });

  it('reports duplicated lines and their cross-file partners in the ranking', () => {
    const { stdout } = runCli([cloneDir]);

    expect(stdout).toMatch(
      /src[\\/]orders\.ts \(score [\d.]+\):.*duplicated lines 12 \(100%, shared with src[\\/]refunds\.ts\)/
    );
  });

  it('exposes per-file duplication details in the JSON report', () => {
    const { stdout } = runCli([cloneDir, '--json']);
    const report = JSON.parse(stdout);

    const orders = report.files.find((file: { file: string }) => file.file.endsWith('orders.ts'));
    expect(orders).toMatchObject({ duplicatedLineCount: 12, duplicatedLineRatio: 1 });
    expect(orders.crossFilePartners).toHaveLength(1);
  });

  it('honors --duplication-min-tokens for cross-file detection', () => {
    const { stdout } = runCli([cloneDir, '--duplication-min-tokens', '500']);

    expect(stdout).not.toContain('duplicated lines');
  });

  it('rejects a negative --duplication-max-gap-tokens but accepts 0', () => {
    expect(runCli([cloneDir, '--duplication-max-gap-tokens', '-1']).status).not.toBe(0);
    expect(runCli([cloneDir, '--duplication-max-gap-tokens', '0']).status).toBe(0);
  });

  it('rejects an out-of-range --duplication-min-similarity-percent but accepts 100', () => {
    expect(runCli([cloneDir, '--duplication-min-similarity-percent', '0']).status).not.toBe(0);
    expect(runCli([cloneDir, '--duplication-min-similarity-percent', '101']).status).not.toBe(0);
    expect(runCli([cloneDir, '--duplication-min-similarity-percent', '100']).status).toBe(0);
  });

  it('honors duplication settings from the config file', () => {
    const configuredDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-clones-config-'));
    try {
      writeFileSync(
        path.join(configuredDir, 'code-gauge.config.json'),
        JSON.stringify({ duplication: { minTokens: 500 } })
      );
      writeFileSync(path.join(configuredDir, 'orders.ts'), cloneFile('summarizeOrders', 'order'));
      writeFileSync(path.join(configuredDir, 'refunds.ts'), cloneFile('summarizeRefunds', 'refund'));

      const { stdout } = runCli([configuredDir]);

      expect(stdout).not.toContain('duplicated lines');
    } finally {
      rmSync(configuredDir, { recursive: true, force: true });
    }
  });
});

describe('cli: error handling', () => {
  it('fails on an unsupported file type', () => {
    const notes = path.join(projectDir, 'notes.txt');
    writeFileSync(notes, 'plain text\n');

    const { status, stderr } = runCli([notes]);

    expect(status).toBe(1);
    expect(stderr).toContain('unsupported file type');
  });

  it('fails on a missing target', () => {
    const { status, stderr } = runCli([path.join(projectDir, 'does-not-exist.ts')]);

    expect(status).toBe(1);
    expect(stderr).toMatch(/does-not-exist\.ts/);
  });
});

/** Writes files into a fresh temp project (with an empty config to bound the config search). */
function makeProject(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `code-gauge-${prefix}-`));
  writeFileSync(path.join(dir, 'code-gauge.config.json'), '{}\n');
  for (const [file, code] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), code);
  }
  return dir;
}

function reportedFiles(dir: string, ...args: string[]): string[] {
  const report = JSON.parse(runCli([dir, '--json', '--top', '100', ...args]).stdout) as { files: { file: string }[] };
  return report.files.map((file) => file.file.replaceAll(path.sep, '/')).toSorted();
}

const trivialSource: Record<string, string> = {
  c: 'int f(void) { return 1; }\n',
  cpp: 'int f() { return 1; }\n',
  cs: 'class A { int F() { return 1; } }\n',
  go: 'package p\nfunc f() int { return 1 }\n',
  java: 'class A { int f() { return 1; } }\n',
  js: 'export function f() { return 1; }\n',
  kt: 'fun f() = 1\n',
  py: 'def f():\n    return 1\n',
  rb: 'def f\n  1\nend\n',
  rs: 'fn f() -> i32 { 1 }\n',
  ts: 'export function f(): number { return 1; }\n',
};

describe('cli: ranking details', () => {
  it('scores files by summed percentile ranks and breaks ties by NCSS then name', () => {
    const { stdout } = runCli([projectDir]);
    // risky.ts beats a.ts and b.ts on worst-function cognitive complexity and NCSS (2/3 each),
    // nobody has duplication: 0.67 + 0 + 0.67. The equal files tie at 0 and sort by name.
    expect(stdout).toMatch(/^1\. src[\\/]risky\.ts \(score 1\.33\)/mu);
    expect(stdout).toMatch(/^2\. src[\\/]a\.ts \(score 0\.00\)/mu);
    expect(stdout).toMatch(/^3\. src[\\/]b\.ts \(score 0\.00\)/mu);
  });

  it('reports a single file relative to its directory', () => {
    const { status, stdout } = runCli([path.join(projectDir, 'src', 'risky.ts')]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/^Measured 1 files under .*risky\.ts \(code LOC 14, NCSS 16, functions 1\)/mu);
    expect(stdout).toContain('1. risky.ts (score 0.00)');
  });

  it('lists every file when --top exceeds the file count', () => {
    const { stdout } = runCli([projectDir, '--top', '50']);
    expect(stdout).toContain('Refactoring candidates (top 3):');
    expect(stdout).not.toContain(' of 3');
  });

  it('reports an empty project without candidates', () => {
    const emptyDir = makeProject('empty', { 'README.md': '# nothing\n' });
    try {
      const { status, stdout } = runCli([emptyDir]);
      expect(status).toBe(0);
      expect(stdout).toMatch(/^Measured 0 files under /mu);
      expect(stdout).toContain('No measurable files found.');
      const report = JSON.parse(runCli([emptyDir, '--json']).stdout);
      expect(report).toMatchObject({
        summary: { fileCount: 0 },
        totalRankedFiles: 0,
        truncated: false,
        files: [],
        warnings: [],
      });
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('measures explicitly targeted test and declaration files despite the default exclusions', () => {
    const dir = makeProject('explicit', {
      'sample.test.ts': 'export function testOnly() { return 42; }\n',
      'types.d.ts': 'export declare function f(): void;\n',
    });
    try {
      expect(reportedFiles(dir)).toEqual([]);
      expect(JSON.parse(runCli([path.join(dir, 'sample.test.ts'), '--json']).stdout).summary.functionCount).toBe(1);
      expect(JSON.parse(runCli([path.join(dir, 'types.d.ts'), '--json']).stdout).summary.fileCount).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('measures files with syntax errors instead of skipping them', () => {
    const dir = makeProject('broken', {
      'broken.ts':
        'export function broken(value: number) {\n  if (value > 0 {\n    return 1;\n  }\n}\nconst dangling = {',
    });
    try {
      const report = JSON.parse(runCli([dir, '--json']).stdout);
      expect(report.errors).toEqual([]);
      expect(report.files[0]).toMatchObject({
        file: 'broken.ts',
        worstFunction: expect.objectContaining({ name: 'broken' }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cli: file discovery', () => {
  it('maps every supported extension, including alternate and uppercase spellings, and skips generated names', () => {
    // Content only the C++ grammar accepts: parsed as C it yields two functions (`n`, `A`), as
    // C++ the single function `f`, so the reported worst function reveals which grammar ran.
    const cppOnly = 'namespace n { class A { public: int f() { return 1; } }; }\n';
    const cppSpellings = [
      'impl.cc',
      'impl.cxx',
      'impl.cpp',
      'impl.c++',
      'impl.cp',
      'impl.tcc',
      'Upper.C',
      'header.h',
      'header.hh',
      'header.hpp',
      'header.hxx',
    ];
    const files: Record<string, string> = {
      ...Object.fromEntries(Object.entries(trivialSource).map(([extension, code]) => [`base.${extension}`, code])),
      ...Object.fromEntries(cppSpellings.map((file) => [file, cppOnly])),
      'react.jsx': 'export const C = () => <p />;\n',
      'react.tsx': 'export const C = (): JSX.Element => <p />;\n',
      'module.mjs': trivialSource.js as string,
      'common.cjs': 'module.exports = 1;\n',
      'module.mts': trivialSource.ts as string,
      'common.cts': trivialSource.ts as string,
      'script.kts': trivialSource.kt as string,
      // Generated or bundled artifacts are skipped by name.
      'types.d.ts': 'export declare function f(): void;\n',
      'types.d.mts': 'export declare function f(): void;\n',
      'bundle.min.js': 'function f(){return 1}\n',
      '.pnp.cjs': 'module.exports = 1;\n',
      'notes.txt': 'plain\n',
      Makefile: 'all:\n',
    };
    const dir = makeProject('extensions', files);
    try {
      const report = JSON.parse(runCli([dir, '--json', '--top', '100']).stdout) as {
        files: { file: string; worstFunction?: { name: string } }[];
      };
      expect(report.files.map((file) => file.file).toSorted()).toEqual(
        Object.keys(files)
          .filter(
            (file) =>
              !['types.d.ts', 'types.d.mts', 'bundle.min.js', '.pnp.cjs', 'notes.txt', 'Makefile'].includes(file)
          )
          .toSorted()
      );
      for (const file of cppSpellings) {
        expect(report.files.find((entry) => entry.file === file)?.worstFunction?.name, file).toBe('f');
      }
      expect(report.files.find((entry) => entry.file === 'base.c')?.worstFunction?.name).toBe('f');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips test files by name pattern and test directories unless --include-tests', () => {
    const production = {
      'src/app.js': trivialSource.js as string,
      'src/contest.js': trivialSource.js as string,
      'src/testing_utils.py': trivialSource.py as string,
      'src/attestation.rb': trivialSource.rb as string,
      'src/latest.go': trivialSource.go as string,
    };
    const tests = {
      'src/app.test.js': trivialSource.js as string,
      'src/app.spec.ts': trivialSource.ts as string,
      'src/app_test.go': trivialSource.go as string,
      'src/app-test.js': trivialSource.js as string,
      'src/test_app.py': trivialSource.py as string,
      'src/test-app.js': trivialSource.js as string,
      'src/test.js': trivialSource.js as string,
      'src/latest_test.rb': trivialSource.rb as string,
      'src/__tests__/deep.js': trivialSource.js as string,
      'tests/deep.py': trivialSource.py as string,
      'spec/deep.rb': trivialSource.rb as string,
      'test/deep.ts': trivialSource.ts as string,
    };
    const dir = makeProject('patterns', { ...production, ...tests });
    try {
      expect(reportedFiles(dir)).toEqual(Object.keys(production).toSorted());
      expect(reportedFiles(dir, '--include-tests')).toEqual(
        [...Object.keys(production), ...Object.keys(tests)].toSorted()
      );
      writeFileSync(path.join(dir, 'code-gauge.config.json'), JSON.stringify({ includeTests: true }));
      expect(reportedFiles(dir)).toHaveLength(Object.keys(production).length + Object.keys(tests).length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips generated, vendored, and tool directories but scans other directories', () => {
    const scanned = {
      'src/a.ts': trivialSource.ts as string,
      'build/b.ts': trivialSource.ts as string,
      'lib/nested/c.ts': trivialSource.ts as string,
      '.hidden/d.ts': trivialSource.ts as string,
    };
    const skipped = {
      'node_modules/pkg/index.js': trivialSource.js as string,
      'dist/e.js': trivialSource.js as string,
      'vendor/f.go': trivialSource.go as string,
      'target/g.rs': trivialSource.rs as string,
      'coverage/h.js': trivialSource.js as string,
      '__pycache__/i.py': trivialSource.py as string,
      '.venv/j.py': trivialSource.py as string,
      'generated/k.ts': trivialSource.ts as string,
      '__generated__/l.ts': trivialSource.ts as string,
      'fixtures/m.ts': trivialSource.ts as string,
      'test-fixtures/n.ts': trivialSource.ts as string,
      '.git/o.ts': trivialSource.ts as string,
      'src/obj/p.cs': trivialSource.cs as string,
      'src/deep/vendor/q.rb': trivialSource.rb as string,
    };
    const dir = makeProject('directories', { ...scanned, ...skipped });
    try {
      expect(reportedFiles(dir)).toEqual(Object.keys(scanned).toSorted());
      // Ignored directories stay ignored even with --include-tests.
      expect(reportedFiles(dir, '--include-tests')).toEqual(Object.keys(scanned).toSorted());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('follows symbolic links inside the root once, ignores links escaping it, and reports broken ones', () => {
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-outside-'));
    const dir = makeProject('symlinks', {
      'src/real.ts': trivialSource.ts as string,
      'src/sub/inner.ts': trivialSource.ts as string,
    });
    try {
      writeFileSync(path.join(outsideDir, 'secret.ts'), trivialSource.ts as string);
      symlinkSync(path.join(dir, 'src', 'real.ts'), path.join(dir, 'src', 'alias.ts'));
      symlinkSync(path.join(dir, 'src', 'sub'), path.join(dir, 'src', 'subLink'));
      // A link back to an ancestor must not recurse forever.
      symlinkSync(dir, path.join(dir, 'src', 'sub', 'loop'));
      symlinkSync(path.join(outsideDir, 'secret.ts'), path.join(dir, 'src', 'escape.ts'));
      symlinkSync(path.join(dir, 'src', 'missing.ts'), path.join(dir, 'src', 'broken.ts'));

      const { status, stdout, stderr } = runCli([dir, '--json']);
      const report = JSON.parse(stdout) as { files: { file: string }[]; errors: string[] };
      expect(status).toBe(0);
      // real.ts is measured once (under whichever of its names is visited first), sub/ once.
      expect(report.files).toHaveLength(2);
      const names = report.files.map((file) => path.basename(file.file));
      expect(names).toContain('inner.ts');
      expect(names.filter((name) => name === 'alias.ts' || name === 'real.ts')).toHaveLength(1);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toContain('broken.ts');
      expect(stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('cli: scan errors and --fail-on-error', () => {
  const runAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(runAsRoot)('reports unreadable files as skipped and exits 1 only with --fail-on-error', () => {
    const dir = makeProject('unreadable', {
      'src/ok.ts': trivialSource.ts as string,
      'src/locked.ts': trivialSource.ts as string,
    });
    const locked = path.join(dir, 'src', 'locked.ts');
    chmodSync(locked, 0o000);
    try {
      const lenient = runCli([dir]);
      expect(lenient.status).toBe(0);
      expect(lenient.stdout).toMatch(/^Measured 1 files under /mu);
      expect(lenient.stderr).toContain('Skipped 1 files or directories:');
      expect(lenient.stderr).toMatch(/locked\.ts: .*(EACCES|permission denied)/iu);

      expect(runCli([dir, '--fail-on-error']).status).toBe(1);
      const json = JSON.parse(runCli([dir, '--json', '--fail-on-error']).stdout);
      expect(json.errors).toHaveLength(1);
      expect(json.summary.fileCount).toBe(1);

      writeFileSync(path.join(dir, 'code-gauge.config.json'), JSON.stringify({ failOnError: true }));
      expect(runCli([dir]).status).toBe(1);
    } finally {
      chmodSync(locked, 0o644);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a missing --config file', () => {
    const { status, stderr } = runCli([projectDir, '--config', path.join(projectDir, 'missing.config.json')]);
    expect(status).toBe(1);
    expect(stderr).toContain('Cannot read config file');
  });
});

describe('cli: configuration discovery and validation', () => {
  it('finds the nearest config above the target, for directories and single files alike', () => {
    const dir = makeProject('walkup', { 'pkg/src/a.ts': riskyFile, 'pkg/src/b.ts': trivialSource.ts as string });
    try {
      writeFileSync(path.join(dir, 'code-gauge.config.json'), JSON.stringify({ rank: { top: 1 } }));
      expect(runCli([path.join(dir, 'pkg', 'src')]).stdout).toContain('Refactoring candidates (top 1 of 2):');
      // A nearer config wins over the ancestor's.
      writeFileSync(path.join(dir, 'pkg', 'code-gauge.config.json'), JSON.stringify({ rank: { top: 2 } }));
      expect(runCli([path.join(dir, 'pkg', 'src')]).stdout).toContain('Refactoring candidates (top 2):');
      // A single-file target searches from its directory: the nearer config's rejected setting
      // fails the run, so discovery demonstrably reached it.
      writeFileSync(path.join(dir, 'pkg', 'code-gauge.config.json'), JSON.stringify({ rank: { top: 0 } }));
      const singleFile = runCli([path.join(dir, 'pkg', 'src', 'a.ts')]);
      expect(singleFile.status).toBe(1);
      expect(singleFile.stderr).toContain('"rank.top" must be a positive integer');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const invalidConfigs: [string, string, string][] = [
    ['invalid JSON', '{ rank: ', 'Invalid JSON in config file'],
    ['a non-object root', '[]', 'must contain a JSON object'],
    ['a non-object section', '{ "rank": 3 }', '"rank" must be an object'],
    ['rank.top of 0', '{ "rank": { "top": 0 } }', '"rank.top" must be a positive integer'],
    ['a string rank.top', '{ "rank": { "top": "3" } }', '"rank.top" must be a positive integer'],
    ['an unknown rank key', '{ "rank": { "limit": 3 } }', 'unknown setting "limit" in "rank"'],
    ['a non-boolean includeTests', '{ "includeTests": "yes" }', '"includeTests" must be a boolean'],
    [
      'duplication.minTokens of 0',
      '{ "duplication": { "minTokens": 0 } }',
      '"duplication.minTokens" must be a positive integer',
    ],
    [
      'a negative duplication.maxGapTokens',
      '{ "duplication": { "maxGapTokens": -1 } }',
      '"duplication.maxGapTokens" must be a non-negative integer',
    ],
    [
      'a fractional duplication.maxGapTokens',
      '{ "duplication": { "maxGapTokens": 1.5 } }',
      '"duplication.maxGapTokens" must be a non-negative integer',
    ],
    [
      'duplication.minSimilarityPercent above 100',
      '{ "duplication": { "minSimilarityPercent": 101 } }',
      '"duplication.minSimilarityPercent" must be between 1 and 100',
    ],
    [
      'an unknown duplication key',
      '{ "duplication": { "threshold": 1 } }',
      'unknown setting "threshold" in "duplication"',
    ],
    [
      'a negative new-function limit',
      '{ "gate": { "newFunction": { "maxNcss": -1 } } }',
      '"gate.newFunction.maxNcss" must be a non-negative integer',
    ],
    [
      'an unknown new-function key',
      '{ "gate": { "newFunction": { "maxDepth": 1 } } }',
      'unknown setting "maxDepth" in "gate.newFunction"',
    ],
    [
      'a string tolerance',
      '{ "gate": { "tolerance": { "ncss": "5" } } }',
      '"gate.tolerance.ncss" must be a non-negative number',
    ],
    [
      'a negative tolerance',
      '{ "gate": { "tolerance": { "halsteadVolume": -1 } } }',
      '"gate.tolerance.halsteadVolume" must be a non-negative number',
    ],
    [
      'gate.matchSimilarityPercent of 0',
      '{ "gate": { "matchSimilarityPercent": 0 } }',
      '"gate.matchSimilarityPercent" must be a positive integer',
    ],
    [
      'gate.matchSimilarityPercent above 100',
      '{ "gate": { "matchSimilarityPercent": 101 } }',
      '"gate.matchSimilarityPercent" must be between 1 and 100',
    ],
  ];
  for (const [label, content, message] of invalidConfigs) {
    it(`rejects ${label}`, () => {
      const configFile = path.join(
        projectDir,
        `invalid-${invalidConfigs.findIndex(([name]) => name === label)}.config.json`
      );
      writeFileSync(configFile, content);
      const { status, stderr } = runCli([projectDir, '--config', configFile]);
      expect(status).toBe(1);
      expect(stderr).toContain(message);
    });
  }

  it('accepts fractional tolerances, zero new-function limits, and every documented default', () => {
    const configFile = path.join(projectDir, 'full.config.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        duplication: { minTokens: 40, maxGapTokens: 30, minSimilarityPercent: 70 },
        rank: { top: 10 },
        gate: {
          newFunction: { maxCognitiveComplexity: 0, maxNcss: 60, maxNestingDepth: 4 },
          tolerance: {
            cognitiveComplexity: 2,
            ncss: 5,
            nestingDepth: 1,
            depDegree: 10,
            halsteadVolume: 12.5,
            fileNcss: 20,
            duplicateLines: 0,
          },
          matchSimilarityPercent: 70,
        },
        includeTests: false,
        failOnError: false,
      })
    );
    expect(runCli([projectDir, '--config', configFile]).status).toBe(0);
  });
});

describe('cli: cross-file partner reporting', () => {
  it('lists at most three partners in the text report and all of them in JSON', () => {
    const dir = makeProject(
      'partners',
      Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e'].map((name) => [`src/${name}.ts`, cloneFile(`summarize${name.toUpperCase()}`, name)])
      )
    );
    try {
      const { stdout } = runCli([dir]);
      expect(stdout).toMatch(
        /src[\\/]a\.ts \(score [\d.]+\):.*shared with src[\\/]b\.ts, src[\\/]c\.ts, src[\\/]d\.ts, \.\.\.\)/u
      );
      const report = JSON.parse(runCli([dir, '--json', '--top', '2']).stdout) as {
        files: { file: string; crossFilePartners: string[] }[];
      };
      expect(report.files).toHaveLength(2);
      for (const file of report.files) {
        expect(file.crossFilePartners).toHaveLength(4);
        expect(file.crossFilePartners).not.toContain(file.file);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
