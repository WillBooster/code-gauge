import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// These tests exercise `code-gauge diff` (built by test/helpers/globalSetup.ts) as a real
// subprocess against a real git repository, covering the whole gate pipeline: merge-base
// resolution, both-revision measurement, entity matching, ratchets, new-code thresholds,
// duplication deltas, output contract, and exit codes.

const repoRoot = path.join(import.meta.dirname, '..', '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): CliResult {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
  if (result.error) {
    throw new Error(`Failed to run the CLI (${args.join(' ')}): ${result.error.message}`);
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function runGit(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

const baseCalc = `export function total(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}
`;

const worsenedCalc = `export function total(items: number[], mode?: string): number {
  let sum = 0;
  for (const item of items) {
    if (mode === 'abs') {
      if (item < 0) {
        sum -= item;
      } else {
        sum += item;
      }
    } else if (mode === 'even') {
      if (item % 2 === 0) {
        sum += item;
      }
    } else {
      sum += item;
    }
  }
  return sum;
}
`;

// Long enough (>= 40 normalized tokens) for its copy to register as a cross-file clone.
const reportSource = `export function reportTotal(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item * 2 + Math.max(item, 0) - Math.min(item, 1);
  }
  const scaled = sum * 3 + Math.abs(sum) + Math.sign(sum);
  const shifted = scaled + sum - Math.round(scaled / 7);
  return shifted + scaled + sum;
}
`;

const complexNewFile = `export function decide(a: number, b: number, c: number, d: number): number {
  if (a > 0) {
    if (b > 0) {
      if (c > 0) {
        if (d > 0) {
          if (a > b) {
            return 1;
          }
        }
      }
    }
  }
  if (b > 1) { return 2; }
  if (c > 1) { return 3; }
  if (d > 1) { return 4; }
  if (a > 2 && b > 2) { return 5; }
  if (a > 3 || b > 3) { return 6; }
  if (c > 3 && d > 3) { return 7; }
  return 0;
}
`;

let repoDir: string;

beforeAll(() => {
  repoDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-diff-'));
  runGit(['init', '-q', '-b', 'main'], repoDir);
  runGit(['config', 'user.email', 'test@example.com'], repoDir);
  runGit(['config', 'user.name', 'test'], repoDir);
  mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  // An empty config at the repo root bounds the ancestor config search, like in cli.test.ts.
  writeFileSync(path.join(repoDir, 'code-gauge.config.json'), '{}\n');
  writeFileSync(path.join(repoDir, 'src', 'calc.ts'), baseCalc);
  writeFileSync(path.join(repoDir, 'src', 'report.ts'), reportSource);
  runGit(['add', '-A'], repoDir);
  runGit(['commit', '-q', '-m', 'base'], repoDir);
});

afterEach(() => {
  runGit(['checkout', '-q', '--', '.'], repoDir);
  runGit(['clean', '-fdq'], repoDir);
  writeFileSync(path.join(repoDir, 'code-gauge.config.json'), '{}\n');
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('code-gauge diff --base', () => {
  it('passes a clean working tree with a single line and exit code 0', () => {
    const result = runCli(['diff', '--base', 'main'], repoDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Regression gate passed: 0 changed files, 0 functions checked/u);
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });

  it('reports a worsened function with base -> head values and exits 1', () => {
    writeFileSync(path.join(repoDir, 'src', 'calc.ts'), worsenedCalc);
    const result = runCli(['diff', '--base', 'main'], repoDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('cognitive complexity worsened 1 -> 12 (allowed <= 3)');
    expect(result.stdout).toContain('src/calc.ts');
  });

  it('does not flag an in-place rename of a function', () => {
    writeFileSync(
      path.join(repoDir, 'src', 'calc.ts'),
      baseCalc.replaceAll('total', 'sumAll').replaceAll('items', 'values').replaceAll('item', 'value')
    );
    const result = runCli(['diff', '--base', 'main'], repoDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Regression gate passed: 1 changed files, 1 functions checked/u);
  });

  it('applies the new-code thresholds to functions of an added file', () => {
    writeFileSync(path.join(repoDir, 'src', 'deep.ts'), complexNewFile);
    const result = runCli(['diff', '--base', 'main'], repoDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('new function decide: cognitive complexity 24 exceeds the new-code limit 15');
  });

  it('reports copy-paste from an unchanged file into a new file with partner evidence', () => {
    writeFileSync(path.join(repoDir, 'src', 'copy.ts'), reportSource.replaceAll('reportTotal', 'copiedTotal'));
    const result = runCli(['diff', '--base', 'main'], repoDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('src/copy.ts: duplicated lines increased 0 -> ');
    expect(result.stdout).toContain('Deduplicate against src/report.ts');
    // Only the new copy is flagged: report.ts itself did not change.
    expect(result.stdout).not.toContain('src/report.ts: duplicated lines');
  });

  it('prints machine-readable JSON with --json', () => {
    writeFileSync(path.join(repoDir, 'src', 'calc.ts'), worsenedCalc);
    const result = runCli(['diff', '--base', 'main', '--json', '--full'], repoDir);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout) as {
      passed: boolean;
      violations: { gate: string; metric: string; file: string }[];
      files: { file: string; baseNcss: number; headNcss: number }[];
    };
    expect(report.passed).toBe(false);
    expect(report.violations[0]).toMatchObject({
      gate: 'function-regression',
      metric: 'cognitive complexity',
      file: 'src/calc.ts',
    });
    expect(report.files).toStrictEqual([expect.objectContaining({ file: 'src/calc.ts', baseNcss: 5, headNcss: 15 })]);
  });

  it('honors gate tolerances from the config file', () => {
    writeFileSync(
      path.join(repoDir, 'code-gauge.config.json'),
      JSON.stringify({ gate: { tolerance: { cognitiveComplexity: 20, ncss: 20, nestingDepth: 5 } } })
    );
    writeFileSync(path.join(repoDir, 'src', 'calc.ts'), worsenedCalc);
    const result = runCli(['diff', '--base', 'main'], repoDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Regression gate passed/u);
  });

  it('rejects unknown gate settings loudly', () => {
    writeFileSync(path.join(repoDir, 'code-gauge.config.json'), JSON.stringify({ gate: { maxComplexity: 10 } }));
    const result = runCli(['diff', '--base', 'main'], repoDir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('unknown setting "maxComplexity" in "gate"');
  });

  it('fails with exit code 2 on an unknown base ref', () => {
    const result = runCli(['diff', '--base', 'no-such-ref'], repoDir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Not a valid object name');
  });
});
