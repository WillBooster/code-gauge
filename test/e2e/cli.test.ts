import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

beforeAll(() => {
  const build = spawnSync('bun', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8', timeout: 100_000 });
  if (build.status !== 0) {
    throw new Error(
      `Failed to build the CLI before running E2E tests:\n${build.error?.message ?? ''}\n${build.stdout}\n${build.stderr}`
    );
  }

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
      expect(report.summary.fileCount).toBe(11);
      expect(report.summary.functionCount).toBeGreaterThan(50);
      expect(report.summary.linesOfCode).toBeGreaterThan(500);
      expect(report.errors).toEqual([]);
    } finally {
      rmSync(polyglotDir, { recursive: true, force: true });
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
