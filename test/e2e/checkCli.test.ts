import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// These tests exercise `code-gauge check` (built by test/helpers/globalSetup.ts) as a real
// subprocess against a real git repository.

const cliPath = path.join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCheck(args: string[], cwd = repoDir): CliResult {
  const result = spawnSync(process.execPath, [cliPath, 'check', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) {
    throw new Error(`Failed to run the CLI (${args.join(' ')}): ${result.error.message}`);
  }
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function runGit(args: string[]): void {
  const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  }
}

function writeSource(relativePath: string, content: string): void {
  mkdirSync(path.dirname(path.join(repoDir, relativePath)), { recursive: true });
  writeFileSync(path.join(repoDir, relativePath), content);
}

function writeConfig(config: unknown): void {
  writeSource('code-gauge.config.json', JSON.stringify(config));
}

const calc = `export function total(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}
`;

// `decide` (lines 1-21) exceeds the default cognitive-complexity, cyclomatic-complexity, and
// nesting-depth limits; `identity` (lines 23-26) exceeds none.
const legacy = `export function decide(a: number, b: number, c: number, d: number): number {
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
  const fallback = 0;
  return fallback;
}

export function identity(value: number): number {
  const same = value;
  return same;
}
`;

// A 12-line function, long enough for a copy to be a duplicated block under the default limit.
function reportFunction(name: string): string {
  return `export function ${name}(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item * 2 + Math.max(item, 0) - Math.min(item, 1);
  }
  const scaled = sum * 3 + Math.abs(sum) + Math.sign(sum);
  const shifted = scaled + sum - Math.round(scaled / 7);
  const clamped = Math.min(Math.max(shifted, -1000), 1000);
  const rounded = Math.round(clamped * 100) / 100;
  const weighted = rounded * 0.5 + scaled * 0.25 + sum * 0.25;
  return weighted + shifted + scaled + sum;
}
`;
}

// oxlint-disable-next-line unicorn/no-null -- the config file disables a limit with JSON null.
const disabled = null;

// Structurally different from reportFunction, so the two never match each other.
function otherFunction(name: string): string {
  return `export function ${name}(text: string, width: number): string[] {
  const words = text.split(' ').filter((word) => word.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : current + ' ' + word;
    if (candidate.length > width && current !== '') {
      lines.push(current.padEnd(width, ' '));
      current = word;
    } else { current = candidate; }
  }
  return current === '' ? lines : [...lines, current.padEnd(width, ' ')];
}
`;
}

let repoDir: string;

// chmod 000 does not stop root from reading, so the unreadable-file case is skipped there.
const runAsRoot = typeof process.getuid === 'function' && process.getuid() === 0;

beforeAll(() => {
  repoDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-check-'));
  runGit(['init', '-q', '-b', 'main']);
  runGit(['config', 'user.email', 'test@example.com']);
  runGit(['config', 'user.name', 'test']);
  // git init records whether the filesystem keeps the executable bit; the mode-change case needs it.
  runGit(['config', 'core.fileMode', 'true']);
  // A config at the repo root bounds the ancestor config search.
  writeConfig({});
  writeSource('src/calc.ts', calc);
  writeSource('src/legacy.ts', legacy);
  writeSource('src/report.ts', reportFunction('reportTotal'));
  writeSource('src/summary.ts', reportFunction('summarize'));
  runGit(['add', '-A']);
  runGit(['commit', '-q', '-m', 'base']);
});

afterEach(() => {
  // A test that commits on a branch is undone here, so a failed assertion cannot leave it behind.
  runGit(['checkout', '-q', '-f', '-B', 'feature']);
  runGit(['checkout', '-q', '-f', 'main']);
  runGit(['branch', '-q', '-D', 'feature']);
  runGit(['clean', '-fdxq']);
});

afterAll(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe('code-gauge check', () => {
  it('reports every violation of the project, one line each, with one hint per violated metric', () => {
    const result = runCheck([]);
    expect(result.status).toBe(1);
    expect(result.stdout)
      .toBe(`Threshold violations: 3 violations (1 functions, 0 files, 2 duplicated blocks) (4 files, 5 functions checked).
src/legacy.ts:1-21 decide: cognitive complexity 24 (<= 15), cyclomatic complexity 15 (<= 10), nesting depth 5 (<= 4)
src/report.ts:1-12: duplicated lines 12 (< 10), also at src/summary.ts:1-12
src/summary.ts:1-12: duplicated lines 12 (< 10), also at src/report.ts:1-12

How to fix:
- cognitive complexity: flatten nested branching with early returns and extract nested blocks into named functions.
- cyclomatic complexity: the function has too many independent paths; split it by decision or replace condition chains with a lookup table.
- nesting depth: replace nested conditions with guard clauses or move inner blocks into functions.
- duplicated lines: extract the repeated code into one shared function or module and call it from every location.
`);
  });

  it('prints a single line and exits 0 when nothing exceeds a threshold', () => {
    const result = runCheck(['src/calc.ts']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('No threshold violations: 1 files, 1 functions checked.\n');
  });

  it('lists at most three partner locations of a duplicated block', () => {
    writeSource('src/copies/a.ts', reportFunction('copyA'));
    expect(runCheck(['src/copies']).stdout).toContain(
      'src/copies/a.ts:1-12: duplicated lines 12 (< 10), also at src/report.ts:1-12, src/summary.ts:1-12\n'
    );
    writeSource('src/copies/b.ts', reportFunction('copyB'));
    writeSource('src/copies/c.ts', reportFunction('copyC'));
    expect(runCheck(['src/copies']).stdout).toContain(
      'src/copies/a.ts:1-12: duplicated lines 12 (< 10), also at src/copies/b.ts:1-12, src/copies/c.ts:1-12, src/report.ts:1-12, ...\n'
    );
  });

  it('detects duplication against the git-visible files of the whole repository, with or without --base', () => {
    writeSource('.gitignore', 'build/\n');
    writeSource('build/generated.ts', otherFunction('generated'));
    writeSource('src2/fresh.ts', otherFunction('fresh'));
    // The only other copy is git-ignored, so neither mode sees duplication.
    expect(runCheck(['src2']).status).toBe(0);
    expect(runCheck(['--base', 'main', 'src2']).status).toBe(0);

    writeSource('lib/origin.ts', otherFunction('origin'));
    // A copy outside the target is a partner in both modes, under its repository-relative path.
    const line = 'src2/fresh.ts:1-13: duplicated lines 13 (< 10), also at lib/origin.ts:1-13\n';
    expect(runCheck(['src2']).stdout).toContain(line);
    expect(runCheck(['--base', 'main', 'src2']).stdout).toContain(line);
    expect(runCheck(['src2']).stdout).toContain('(1 files, 2 functions checked)');
  });

  it('prints a JSON report with --json', () => {
    const result = runCheck(['--json']);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      passed: false,
      summary: {
        violationCount: 3,
        functionViolationCount: 1,
        fileViolationCount: 0,
        duplicationViolationCount: 2,
        checkedFileCount: 4,
        checkedFunctionCount: 5,
      },
      violations: [
        {
          kind: 'function',
          file: 'src/legacy.ts',
          startLine: 1,
          endLine: 21,
          name: 'decide',
          exceeded: [
            { metric: 'functionCognitiveComplexity', value: 24, limit: 15 },
            { metric: 'functionCyclomaticComplexity', value: 15, limit: 10 },
            { metric: 'functionNestingDepth', value: 5, limit: 4 },
          ],
        },
        {
          kind: 'duplication',
          file: 'src/report.ts',
          startLine: 1,
          endLine: 12,
          exceeded: [{ metric: 'duplicateLines', value: 12, limit: 10 }],
          partners: [{ file: 'src/summary.ts', startLine: 1, endLine: 12 }],
        },
        {
          kind: 'duplication',
          file: 'src/summary.ts',
          startLine: 1,
          endLine: 12,
          exceeded: [{ metric: 'duplicateLines', value: 12, limit: 10 }],
          partners: [{ file: 'src/report.ts', startLine: 1, endLine: 12 }],
        },
      ],
      errors: [],
      warnings: [],
    });
  });

  it('reports a file-level violation with the file as its span', () => {
    const result = runCheck(['--json', '--max-file-ncss', '4', 'src/calc.ts']);
    expect((JSON.parse(result.stdout) as { violations: unknown[] }).violations).toEqual([
      {
        kind: 'file',
        file: 'src/calc.ts',
        startLine: 1,
        endLine: 7,
        exceeded: [{ metric: 'fileNcss', value: 5, limit: 4 }],
      },
    ]);
    expect(runCheck(['--max-file-ncss', '4', 'src/calc.ts']).stdout).toContain('\nsrc/calc.ts: file NCSS 5 (<= 4)\n');
  });
});

describe('code-gauge check: thresholds', () => {
  it('applies the config file over the defaults and the command line over the config file', () => {
    expect(runCheck(['src/calc.ts']).status).toBe(0);
    writeConfig({ thresholds: { maxFunctionNcss: 3 } });
    expect(runCheck(['src/calc.ts']).stdout).toContain('calc.ts:1-7 total: NCSS 5 (<= 3)\n');
    expect(runCheck(['src/calc.ts', '--max-function-ncss', '5']).status).toBe(0);
    expect(runCheck(['src/calc.ts', '--max-function-ncss', '4']).stdout).toContain('NCSS 5 (<= 4)');
  });

  it('disables a threshold with null in the config file or "off" on the command line', () => {
    writeConfig({ thresholds: { maxFunctionCognitiveComplexity: disabled, minDuplicateLines: disabled } });
    const result = runCheck([]);
    expect(result.stdout).toContain('1 violations (1 functions, 0 files, 0 duplicated blocks)');
    expect(result.stdout).toContain(
      'src/legacy.ts:1-21 decide: cyclomatic complexity 15 (<= 10), nesting depth 5 (<= 4)\n'
    );
    expect(
      runCheck(['--max-function-nesting-depth', 'off', '--max-function-cyclomatic-complexity', 'off']).status
    ).toBe(0);
  });

  it('overrides thresholds per language', () => {
    writeSource(
      'src/calc.py',
      'def total(items):\n    result = 0\n    for item in items:\n        result += item\n    return result\n'
    );
    writeConfig({
      thresholds: {
        maxFunctionNcss: 3,
        minDuplicateLines: disabled,
        maxFunctionCognitiveComplexity: disabled,
        maxFunctionNestingDepth: disabled,
        languages: { python: { maxFunctionNcss: disabled }, typescript: { maxFunctionNcss: 4 } },
      },
    });
    const result = runCheck([]);
    expect(result.stdout).toContain('src/calc.ts:1-7 total: NCSS 5 (<= 4)\n');
    expect(result.stdout).not.toContain('calc.py');
    // The command line wins over the per-language overrides too.
    expect(runCheck(['--max-function-ncss', '3']).stdout).toContain('src/calc.py:1-5 total: NCSS 5 (<= 3)\n');
  });

  it.each([
    [
      'an unknown threshold',
      { thresholds: { maxFunctionLines: 1 } },
      'unknown setting "maxFunctionLines" in "thresholds"',
    ],
    ['a removed section', { gate: {} }, 'unknown setting "gate"'],
    [
      'a negative limit',
      { thresholds: { maxFileNcss: -1 } },
      '"thresholds.maxFileNcss" must be a non-negative number or null',
    ],
    [
      'an unknown language',
      { thresholds: { languages: { cobol: {} } } },
      'unknown language "cobol" in "thresholds.languages"',
    ],
    [
      'an unknown per-language setting',
      { thresholds: { languages: { python: { languages: {} } } } },
      'unknown setting "languages" in "thresholds.languages.python"',
    ],
  ])('rejects %s in the config file', (_, config, message) => {
    writeConfig(config);
    const result = runCheck([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it('rejects a threshold option that is neither a number nor "off"', () => {
    const result = runCheck(['--max-function-ncss', 'none']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Expected a non-negative number or "off".');
  });
});

describe('code-gauge check --base', () => {
  it('passes an unchanged working tree despite the violations it already holds', () => {
    const result = runCheck(['--base', 'main']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^No threshold violations: 0 changed files, 0 functions checked; base main, merge-base [0-9a-f]{12}\.\n$/u
    );
  });

  it('reports a violating function only when the change touches its span', () => {
    writeSource('src/legacy.ts', legacy.replace('const same = value;', 'const same = value + 0;'));
    const untouched = runCheck(['--base', 'main']);
    expect(untouched.status).toBe(0);
    expect(untouched.stdout).toContain('1 changed files, 1 functions checked');

    writeSource('src/legacy.ts', legacy.replace('return fallback;', 'return fallback + 0;'));
    const touched = runCheck(['--base', 'main']);
    expect(touched.status).toBe(1);
    expect(touched.stdout).toContain(
      'src/legacy.ts:1-21 decide: cognitive complexity 24 (<= 15), cyclomatic complexity 15 (<= 10), nesting depth 5 (<= 4)\n'
    );
  });

  it('counts a pure deletion inside a function as touching it, but not one right after it', () => {
    writeSource('src/legacy.ts', legacy.replace('  if (d > 1) { return 4; }\n', ''));
    expect(runCheck(['--base', 'main']).stdout).toContain('src/legacy.ts:1-20 decide:');

    writeSource('src/legacy.ts', legacy.replace('}\n\nexport function identity', '}\nexport function identity'));
    expect(runCheck(['--base', 'main']).status).toBe(0);
  });

  it.each([
    ['right after the remaining statements', ''],
    ['after a blank line', '\n'],
    ['after a comment-only line', '# finish\n'],
  ])('counts deleting the last statement of a Python function %s as touching it', (_, gap) => {
    const wide = `def calculate(a, b, c, d, e, f, g, h):\n    print(a)\n${gap}    return a\n`;
    runGit(['checkout', '-q', '-b', 'feature']);
    writeSource('src/wide.py', wide);
    runGit(['add', '-A']);
    runGit(['commit', '-q', '-m', 'wide']);
    writeSource('src/wide.py', wide.replace('    return a\n', ''));
    const result = runCheck(['--base', 'HEAD']);
    expect(result.stdout).toContain('src/wide.py:1-2 calculate: parameters 8 (<= 7)\n');
  });

  it('keeps a function whose name spans lines on one line', () => {
    writeSource(
      'src/holder.ts',
      'export class Holder {\n  [`foo\nbar`](a, b, c, d, e, f, g, h) {\n    return a;\n  }\n}\n'
    );
    expect(runCheck(['src/holder.ts']).stdout).toContain('src/holder.ts:2-5 [`foo bar`]: parameters 8 (<= 7)\n');
  });

  it('reports a file-level violation only for a changed file', () => {
    writeSource('src/calc.ts', `${calc}export const offset = 1;\n`);
    const result = runCheck(['--base', 'main', '--max-file-ncss', '5', '--json']);
    const report = JSON.parse(result.stdout) as { base: string; mergeBase: string; violations: { file: string }[] };
    expect(report.violations.map(({ file }) => file)).toEqual(['src/calc.ts']);
    expect(report.base).toBe('main');
    expect(report.mergeBase).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('reports no file-level violation for a file whose lines did not change', () => {
    chmodSync(path.join(repoDir, 'src', 'calc.ts'), 0o755);
    const result = runCheck(['--base', 'main', '--max-file-ncss', '1']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 changed files, 0 functions checked');
  });

  it('reports the duplicated block a change added, with the unchanged code it copies as its partners', () => {
    writeSource('src/pasted.ts', reportFunction('pasted'));
    const result = runCheck(['--base', 'main']);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('1 violations (0 functions, 0 files, 1 duplicated blocks)');
    expect(result.stdout).toContain(
      'src/pasted.ts:1-12: duplicated lines 12 (< 10), also at src/report.ts:1-12, src/summary.ts:1-12\n'
    );
  });

  it('checks staged changes and commits made since the merge-base', () => {
    runGit(['checkout', '-q', '-b', 'feature']);
    writeSource('src/pasted.ts', reportFunction('pasted'));
    runGit(['add', '-A']);
    expect(runCheck(['--base', 'main']).status).toBe(1);
    runGit(['commit', '-q', '-m', 'paste']);
    expect(runCheck(['--base', 'main']).status).toBe(1);
  });

  it('limits the check to the changed files under the target', () => {
    writeSource('lib/pasted.ts', reportFunction('pasted'));
    expect(runCheck(['--base', 'main', 'src']).status).toBe(0);
    expect(runCheck(['--base', 'main', 'lib']).stdout).toContain('lib/pasted.ts:1-12: duplicated lines 12');
  });
});

describe('code-gauge check outside a git repository', () => {
  let plainDir: string;

  beforeAll(() => {
    plainDir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-check-plain-'));
    writeFileSync(path.join(plainDir, 'code-gauge.config.json'), '{}');
    // b.ts repeats only the statements inside the function that a.ts holds twice, so a.ts has two
    // clone ranges per copy: the whole function and the statements nested in it.
    const statements = reportFunction('first').split('\n').slice(1, 10).join('\n');
    writeFileSync(path.join(plainDir, 'a.ts'), `${reportFunction('first')}\n${reportFunction('second')}`);
    writeFileSync(
      path.join(plainDir, 'b.ts'),
      `export function digest(items: number[], label: string): string {\n  console.log(label);\n${statements}\n  return \`\${label}: \${weighted}\`;\n}\n`
    );
  });

  afterAll(() => {
    rmSync(plainDir, { recursive: true, force: true });
  });

  it('walks the target directory and reports overlapping duplicated ranges of a file as one block', () => {
    const result = runCheck(['--min-duplicate-lines', '5', plainDir], plainDir);
    expect(result.stdout).toContain(`
a.ts:1-12: duplicated lines 12 (< 5), also at a.ts:14-25, b.ts:3-11
a.ts:14-25: duplicated lines 12 (< 5), also at a.ts:1-12, b.ts:3-11
b.ts:3-11: duplicated lines 9 (< 5), also at a.ts:2-10, a.ts:15-23
`);
  });

  it('exits 2 with --base', () => {
    const result = runCheck(['--base', 'main', plainDir], plainDir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not a git repository');
  });
});

describe('code-gauge check: unmeasurable input', () => {
  it.each([[['missing']], [['--base', 'main', 'missing']], [['--base', 'no-such-ref']]])('exits 2 for %j', (args) => {
    const result = runCheck(args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Error: /u);
  });

  it('measures a targeted directory whose name the scan skips elsewhere, with or without --base', () => {
    writeSource('vendor/legacy.ts', legacy);
    expect(runCheck([]).stdout).not.toContain('vendor/legacy.ts');
    const line = 'vendor/legacy.ts:1-21 decide:';
    expect(runCheck(['vendor']).stdout).toContain(line);
    expect(runCheck(['--base', 'main', 'vendor']).stdout).toContain(line);
  });

  it.each(['build', 'build/deep'])(
    'exits 2 for the git-ignored directory %s, while a git-ignored file is checked',
    (target) => {
      writeSource('.gitignore', 'build/\n');
      writeSource('build/deep/legacy.ts', legacy);
      for (const args of [[target], ['--base', 'main', target]]) {
        const result = runCheck(args);
        expect(result.status).toBe(2);
        expect(result.stderr).toContain(`${target}: git ignores this directory`);
      }
      expect(runCheck(['build/deep/legacy.ts']).stdout).toContain('build/deep/legacy.ts:1-21 decide:');
    }
  );

  it('passes a directory whose only sources are git-ignored build output', () => {
    writeSource('.gitignore', 'site/\n');
    writeSource('docs/site/app.ts', legacy);
    writeSource('docs/README.md', '# docs\n');
    const result = runCheck(['docs']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('No threshold violations: 0 files, 0 functions checked.\n');
  });

  it('exits 2 for a targeted file of an unsupported type', () => {
    writeSource('notes.txt', 'plain text\n');
    for (const args of [['notes.txt'], ['--base', 'main', 'notes.txt']]) {
      const result = runCheck(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('Error: notes.txt: unsupported file type\n');
    }
  });

  it.skipIf(runAsRoot)('exits 2 without claiming a pass when a file cannot be read', () => {
    writeSource('src/locked.ts', calc);
    chmodSync(path.join(repoDir, 'src', 'locked.ts'), 0o000);
    for (const args of [[], ['--base', 'main']]) {
      const result = runCheck(args);
      expect(result.status).toBe(2);
      expect(result.stdout).toMatch(/^Check could not complete: 1 measurement failures/u);
      expect(result.stderr).toContain('src/locked.ts');
    }
  });
});
