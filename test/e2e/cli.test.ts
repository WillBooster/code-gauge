import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// These tests exercise the built CLI (dist/cli.js) as a real subprocess so the whole pipeline is
// covered: file/directory scanning, ignore rules, risk findings, thresholds, exit codes, JSON, and
// duplicate-symbol reporting. The CLI is rebuilt in beforeAll so it always reflects the current
// source, and every fixture is generated in an isolated temp directory to keep the run hermetic.

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

// The `evaluate` function has cyclomatic complexity 11 and cognitive complexity 18 (verified against
// lizard 1.23.0), which makes it a reliable risk-finding trigger under lowered thresholds.
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
  // directory can no longer change thresholds and break these assertions.
  writeFileSync(path.join(projectDir, 'code-gauge.config.json'), '{}\n');
  writeFileSync(path.join(projectDir, 'src', 'risky.ts'), riskyFile);
  // Two files declaring `helper` exercise cross-file duplicate-symbol detection.
  writeFileSync(
    path.join(projectDir, 'src', 'a.ts'),
    'export function helper(x: number): number { return x + 1; }\nexport const A = 1;\n'
  );
  writeFileSync(
    path.join(projectDir, 'src', 'b.ts'),
    'export function helper(x: number): number { return x - 1; }\nexport const B = 2;\n'
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
    expect(stdout).toContain('max cyclomatic 11');
    expect(stdout).toContain('No high-risk findings found.');
    expect(stdout).not.toContain('ignored');
  });

  it('reports cross-file duplicate symbols', () => {
    const { stdout } = runCli([projectDir]);

    expect(stdout).toContain('Duplicate symbols (top 1):');
    // The CLI prints `path.relative()` output, which uses `\` on Windows and `/` elsewhere.
    expect(stdout).toMatch(/helper: src[\\/]a\.ts:1, src[\\/]b\.ts:1/);
  });

  it('includes test files with --include-tests', () => {
    const { stdout } = runCli([projectDir, '--include-tests']);

    expect(stdout).toMatch(/^Measured 4 files under /m);
  });

  it('lists the largest files with --largest-files', () => {
    const { stdout } = runCli([projectDir, '--largest-files', '2']);

    expect(stdout).toContain('Largest files by code LOC (top 2):');
    expect(stdout).toMatch(/src[\\/]risky\.ts \(code LOC \d+\)/);
  });
});

describe('cli: risk findings and thresholds', () => {
  it('reports the risky function under lowered thresholds', () => {
    const { stdout } = runCli([
      path.join(projectDir, 'src', 'risky.ts'),
      '--cyclomatic-threshold',
      '5',
      '--cognitive-threshold',
      '5',
    ]);

    expect(stdout).toContain('High-risk findings (top 1):');
    expect(stdout).toMatch(
      /risky\.ts:1-\d+ function evaluate \(cognitive complexity 18 >= 5, cyclomatic complexity 11 >= 5; cyclomatic 11, cognitive 18\)/
    );
  });

  it('exits with code 1 when --fail-on-risk finds a risk', () => {
    const { status } = runCli([
      path.join(projectDir, 'src', 'risky.ts'),
      '--cyclomatic-threshold',
      '5',
      '--fail-on-risk',
    ]);

    expect(status).toBe(1);
  });

  it('exits with code 0 when --fail-on-risk finds no risk', () => {
    const { status } = runCli([path.join(projectDir, 'src', 'a.ts'), '--fail-on-risk']);

    expect(status).toBe(0);
  });

  it('rejects non-positive threshold arguments', () => {
    const { status, stderr } = runCli([projectDir, '--cyclomatic-threshold', '0']);

    expect(status).not.toBe(0);
    expect(stderr).toContain('Expected a positive integer.');
  });
});

describe('cli: JSON output', () => {
  it('emits a structured JSON report', () => {
    const { stdout } = runCli([path.join(projectDir, 'src', 'risky.ts'), '--json', '--cyclomatic-threshold', '5']);
    const report = JSON.parse(stdout);

    expect(report.summary.fileCount).toBe(1);
    expect(report.summary.functionCount).toBe(1);
    expect(report.summary.maxCyclomaticComplexity).toBe(11);
    expect(report.thresholds.cyclomatic).toBe(5);
    expect(report.totalRisks).toBe(1);
    expect(report.risks[0]).toMatchObject({ kind: 'function', name: 'evaluate', language: 'typescript' });
    expect(report.risks[0].triggers).toEqual(
      expect.arrayContaining([expect.objectContaining({ metric: 'cyclomatic complexity', value: 11, threshold: 5 })])
    );
    expect(report.errors).toEqual([]);
  });

  it('honors --max-findings and marks truncation', () => {
    const { stdout } = runCli([projectDir, '--json', '--cyclomatic-threshold', '1', '--max-findings', '1']);
    const report = JSON.parse(stdout);

    expect(report.risks.length).toBe(1);
    expect(report.totalRisks).toBeGreaterThan(1);
    expect(report.truncated).toBe(true);
  });
});

describe('cli: configuration', () => {
  it('auto-detects code-gauge.config.json next to the target', () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-config-'));
    try {
      writeFileSync(path.join(configDir, 'risky.ts'), riskyFile);
      writeFileSync(
        path.join(configDir, 'code-gauge.config.json'),
        JSON.stringify({ thresholds: { cyclomatic: 5, cognitive: 5 } })
      );

      const { stdout } = runCli([path.join(configDir, 'risky.ts')]);

      expect(stdout).toContain('High-risk findings');
      expect(stdout).toContain('function evaluate');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('lets a CLI flag override a --config value', () => {
    const configFile = path.join(projectDir, 'alt.config.json');
    writeFileSync(configFile, JSON.stringify({ thresholds: { cyclomatic: 99 } }));

    const { stdout } = runCli([
      path.join(projectDir, 'src', 'risky.ts'),
      '--config',
      configFile,
      '--cyclomatic-threshold',
      '5',
    ]);

    expect(stdout).toMatch(/cyclomatic >= 5/);
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

const cloneFile = (functionName: string, itemName: string): string => `export function ${functionName}(items) {
  let total = 0;
  let count = 0;
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

  it('reports cross-file duplicate blocks in the text report', () => {
    const { stdout } = runCli([cloneDir]);

    expect(stdout).toContain('Cross-file duplicate blocks (top 1):');
    expect(stdout).toMatch(/\d+ tokens: src[\\/]orders\.ts:1-12, src[\\/]refunds\.ts:1-12/);
  });

  it('flags participating files once the threshold is met', () => {
    const { stdout } = runCli([cloneDir, '--cross-file-duplicate-block-threshold', '1']);

    expect(stdout).toMatch(
      /src[\\/]orders\.ts file \(cross-file duplicated blocks 1 >= 1 \[1-12 ~ src[\\/]refunds\.ts:1-12\]/
    );
  });

  it('exposes cross-file duplication in the JSON report', () => {
    const { stdout } = runCli([cloneDir, '--json']);
    const report = JSON.parse(stdout);

    expect(report.crossFileDuplication.duplicateBlockCount).toBe(1);
    expect(report.crossFileDuplication.groups).toHaveLength(1);
    expect(report.crossFileDuplication.groups[0].occurrences).toHaveLength(2);
  });

  it('honors --duplication-min-tokens for cross-file detection', () => {
    const { stdout } = runCli([cloneDir, '--duplication-min-tokens', '500']);

    expect(stdout).not.toContain('Cross-file duplicate blocks');
  });

  it('rejects a negative --duplication-max-gap-tokens but accepts 0', () => {
    expect(runCli([cloneDir, '--duplication-max-gap-tokens', '-1']).status).not.toBe(0);
    expect(runCli([cloneDir, '--duplication-max-gap-tokens', '0']).status).toBe(0);
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

      expect(stdout).not.toContain('Cross-file duplicate blocks');
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
