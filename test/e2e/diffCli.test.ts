import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  runGit(['clean', '-fdxq'], repoDir);
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
    expect(result.stdout).toMatch(/src\/copy\.ts:1-\d+: duplicated lines increased 0 -> /u);
    expect(result.stdout).toContain('Deduplicate against src/report.ts');
    // Only the new copy is flagged: report.ts itself did not change.
    expect(result.stdout).not.toMatch(/src\/report\.ts:1-\d+: duplicated lines/u);
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

  it('ignores unsupported artifacts like broken symlinks instead of failing the gate', () => {
    symlinkSync('/nonexistent-code-gauge-target', path.join(repoDir, 'src', 'broken.link'));
    writeFileSync(path.join(repoDir, 'src', 'calc.ts'), baseCalc + 'export const extra = 1;\n');
    const result = runCli(['diff', '--base', 'main'], repoDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Regression gate passed/u);
  });

  it('fails with exit 2 (and no pass claim) when a changed file cannot be measured', () => {
    // An unreadable file is reported as modified by git, so its measurement failure must fail the
    // gate closed instead of printing a vacuous pass.
    const lockedPath = path.join(repoDir, 'src', 'report.ts');
    chmodSync(lockedPath, 0o000);
    let result: CliResult;
    try {
      result = runCli(['diff', '--base', 'main'], repoDir);
    } finally {
      chmodSync(lockedPath, 0o644);
    }
    expect(result.status).toBe(2);
    expect(result.stdout).toMatch(/^Regression gate could not complete/u);
    expect(result.stdout).not.toContain('passed');
    expect(result.stderr).toContain('report.ts');
  });

  it('excludes git-ignored artifacts from the duplication universes', () => {
    // The ignored twin exists in neither the base commit nor CI; if it entered the universes it
    // would surface as a partner and could mask duplication deltas of tracked files.
    writeFileSync(path.join(repoDir, '.gitignore'), 'src/generated.ts\n');
    writeFileSync(path.join(repoDir, 'src', 'generated.ts'), reportSource.replaceAll('reportTotal', 'generatedTotal'));
    writeFileSync(path.join(repoDir, 'src', 'copy.ts'), reportSource.replaceAll('reportTotal', 'copiedTotal'));
    const result = runCli(['diff', '--base', 'main'], repoDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Deduplicate against src/report.ts');
    expect(result.stdout).not.toContain('generated.ts');
  });

  it('gates code renamed from an excluded directory as new code', () => {
    // test/ is excluded from scans, so the moved content was never measurable: it must meet the
    // new-code thresholds instead of ratcheting against an out-of-scope base blob.
    mkdirSync(path.join(repoDir, 'test'), { recursive: true });
    writeFileSync(path.join(repoDir, 'test', 'decide.ts'), complexNewFile);
    runGit(['add', '-A'], repoDir);
    runGit(['commit', '-q', '-m', 'add test helper'], repoDir);
    runGit(['mv', 'test/decide.ts', 'src/decide.ts'], repoDir);
    const result = runCli(['diff', '--base', 'HEAD'], repoDir);
    // Discards the staged move and drops the helper commit, restoring the shared base state.
    runGit(['reset', '-q', '--hard', 'HEAD~1'], repoDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('new function decide: cognitive complexity 24 exceeds the new-code limit 15');
  });

  it('prints per-function values with --full', () => {
    writeFileSync(path.join(repoDir, 'src', 'calc.ts'), worsenedCalc);
    const result = runCli(['diff', '--base', 'main', '--full'], repoDir);
    expect(result.stdout).toContain('Checked functions (base -> head):');
    expect(result.stdout).toMatch(
      /src\/calc\.ts:1-\d+ total: cognitive 1 -> 12, NCSS 5 -> 15, nesting 1 -> 3, DepDegree \d+ -> \d+, volume [\d.]+ -> [\d.]+/u
    );
  });

  it('accepts zero as a new-function threshold', () => {
    writeFileSync(
      path.join(repoDir, 'code-gauge.config.json'),
      JSON.stringify({ gate: { newFunction: { maxNestingDepth: 0 } } })
    );
    writeFileSync(
      path.join(repoDir, 'src', 'nested.ts'),
      'export function pick(a: number): number {\n  if (a > 0) {\n    return 1;\n  }\n  return 0;\n}\n'
    );
    const result = runCli(['diff', '--base', 'main'], repoDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('max nesting depth 1 exceeds the new-code limit 0');
  });

  it('fails with exit 2 on a nonexistent target instead of passing vacuously', () => {
    writeFileSync(path.join(repoDir, 'src', 'calc.ts'), worsenedCalc);
    const result = runCli(['diff', '--base', 'main', 'src-typo'], repoDir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('does not exist and matches no changed file');
    expect(result.stdout).not.toContain('passed');
  });

  it('matches a function moved from outside the gated target', () => {
    // decide (cognitive 24) moves from src/legacy.ts into src/api/: a target-scoped run must still
    // see the base counterpart, or the metric-neutral move would hit the new-code thresholds.
    writeFileSync(path.join(repoDir, 'src', 'legacy.ts'), complexNewFile);
    runGit(['add', '-A'], repoDir);
    runGit(['commit', '-q', '-m', 'add legacy'], repoDir);
    mkdirSync(path.join(repoDir, 'src', 'api'), { recursive: true });
    writeFileSync(path.join(repoDir, 'src', 'legacy.ts'), 'export const gone = 1;\n');
    writeFileSync(path.join(repoDir, 'src', 'api', 'moved.ts'), complexNewFile);
    const result = runCli(['diff', '--base', 'HEAD', 'src/api'], repoDir);
    runGit(['reset', '-q', '--hard', 'HEAD~1'], repoDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Regression gate passed: 1 changed files, 1 functions checked/u);
  });

  it('allows one added nesting level within the default tolerance', () => {
    writeFileSync(
      path.join(repoDir, 'src', 'calc.ts'),
      baseCalc.replace('    sum += item;', '    if (item > 0) {\n      sum += item;\n    }')
    );
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
