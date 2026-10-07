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

/** Whether the check reports a violation of either level; the exit code only tells errors. */
function hasViolations(args: string[]): boolean {
  const { status, stdout } = runCheck(args);
  expect([0, 1]).toContain(status);
  return stdout.startsWith('Threshold violations');
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

const baseConfig = { thresholds: { warning: { minDuplicateLines: 10, maxFunctionNestingDepth: 4 } } };

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

// `decide` (lines 1-21) exceeds the warning limits of cognitive complexity and, under `baseConfig`,
// nesting depth; `identity` (lines 23-26) exceeds none.
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

// A 12-line function, long enough for a copy to be a duplicated block under `baseConfig`.
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
  // A config at the repo root bounds the ancestor config search; its limits let the small fixtures
  // below violate.
  writeConfig(baseConfig);
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
    expect(result.status).toBe(0);
    expect(result.stdout)
      .toBe(`Threshold violations: 0 errors, 3 warnings (1 functions, 0 files, 2 duplicated blocks) (4 files, 5 functions checked).
warning: src/legacy.ts:1-21 decide: cognitive complexity 24 (max 15; largest parts L4-10 12, L16 2, L17 2), nesting depth 5 (max 4)
warning: src/report.ts:1-12: duplicated lines 12 (max 9), also at src/summary.ts:1-12
warning: src/summary.ts:1-12: duplicated lines 12 (max 9), also at src/report.ts:1-12

How to fix:
- cognitive complexity: flatten nested branching with early returns and extract nested blocks into named functions.
- nesting depth: replace nested conditions with guard clauses or move inner blocks into functions.
- duplicated lines: extract the repeated code into one shared function or module and call it from every location.
`);
  });

  it('exits 1 and lists the errors first when a value exceeds an error limit', () => {
    const result = runCheck(['--error-min-duplicate-lines', '12', '--error-max-function-nesting-depth', '3']);
    expect(result.status).toBe(1);
    expect(result.stdout)
      .toContain(`Threshold violations: 3 errors, 0 warnings (1 functions, 0 files, 2 duplicated blocks) (4 files, 5 functions checked).
error: src/legacy.ts:1-21 decide: cognitive complexity 24 (warning max 15; largest parts L4-10 12, L16 2, L17 2), nesting depth 5 (max 3)
error: src/report.ts:1-12: duplicated lines 12 (max 11), also at src/summary.ts:1-12
error: src/summary.ts:1-12: duplicated lines 12 (max 11), also at src/report.ts:1-12
`);
    expect(runCheck(['--error-min-duplicate-lines', '12']).stdout)
      .toContain(`2 errors, 1 warnings (1 functions, 0 files, 2 duplicated blocks) (4 files, 5 functions checked).
error: src/report.ts:1-12: duplicated lines 12 (max 11), also at src/summary.ts:1-12
error: src/summary.ts:1-12: duplicated lines 12 (max 11), also at src/report.ts:1-12
warning: src/legacy.ts:1-21 decide:`);
  });

  it('reports a limit that a function and a function nested in it both exceed only for the outer one', () => {
    writeSource(
      'src/wrapped.ts',
      legacy.replace(
        /^export function decide\(([^)]*)\): number \{\n([\s\S]*?)\n\}\n/u,
        'export function wrapped($1): number {\n  return [0].map(() => {\n$2\n  })[0]!;\n}\n'
      )
    );
    const { stdout } = runCheck(['src/wrapped.ts']);
    // The callback holds all of the complexity, so the parts named are those inside it.
    expect(stdout).toContain(' wrapped: cognitive complexity 35 (max 30; largest parts L5-11 15, L17 3, L18 3)\n');
    // Nesting depth covers a function's own body only, so the nested function alone exceeds its limit.
    expect(stdout).toMatch(/ <anonymous>: nesting depth 5 \(max 4\)\n/u);
  });

  it('names the nested functions among the parts adding the most cognitive complexity', () => {
    writeSource(
      'src/factory.ts',
      `export function createCounter(limit: number): { step: () => number; reset: () => void } {
  let count = 0;
  const step = (): number => {
    for (let index = 0; index < limit; index++) {
      if (index % 2 === 0) count += 1;
    }
    return count;
  };
  const reset = (): void => {
    if (count > limit) {
      if (limit > 0) count = 0;
    }
  };
  if (limit < 0) count = limit;
  return { step, reset };
}
`
    );
    expect(runCheck(['src/factory.ts', '--warning-max-function-cognitive-complexity', '5']).stdout).toContain(
      ' createCounter: cognitive complexity 11 (max 5; largest parts L3-8 step 5, L9-13 reset 5, L14 1)\n'
    );
    // Two functions on one line are told apart.
    writeSource(
      'src/oneLine.ts',
      'export function pair(a: boolean, b: boolean): void { const first = () => { if (a) pair(b, a); }; const second = () => { if (b) pair(a, b); }; first(); second(); }\n'
    );
    expect(runCheck(['src/oneLine.ts', '--warning-max-function-cognitive-complexity', '3']).stdout).toContain(
      'largest parts L1 first 2, L1 second 2)'
    );
    // Also when a wrapper around one of them is replaced by what it holds.
    writeSource(
      'src/oneLineWrapped.ts',
      'export function wrappedPair(xs: number[], a: boolean, b: boolean): number { for (const it of xs) { const first = () => { if (a) { wrappedPair([it], b, a); } }; } const second = () => { const both = a && b; if (both) { wrappedPair(xs, b, a); } }; return 0; }\n'
    );
    expect(runCheck(['src/oneLineWrapped.ts', '--warning-max-function-cognitive-complexity', '2']).stdout).toContain(
      'largest parts L1 first 3, L1 second 3)'
    );
  });

  it('keeps a named nested function holding most of the complexity as the part to act on', () => {
    writeSource(
      'src/holderFactory.ts',
      `export function createHolder(limit: number): unknown {
  const holder = {
    [\`st
ep\`](value: number): number {
      for (let index = 0; index < limit; index++) {
        if (index % 2 === 0) {
          if (value > index) return index;
        }
      }
      return value;
    },
  };
  return holder;
}
`
    );
    expect(runCheck(['src/holderFactory.ts', '--warning-max-function-cognitive-complexity', '5']).stdout).toContain(
      ' createHolder: cognitive complexity 9 (max 5; largest parts L3-11 [`st ep`] 9)\n'
    );
  });

  it('leaves a member of an anonymous class unqualified', () => {
    writeSource(
      'src/Outer.java',
      'class Outer {\n  Runnable r = new Runnable() {\n    public void run(int a, int b, int c, int d, int e, int f, int g) {}\n  };\n}\n'
    );
    expect(runCheck(['src/Outer.java']).stdout).toContain('src/Outer.java:3-3 run: parameters 7 (max 6)\n');
  });

  it('names a C++ method defined outside its class with the scope it names', () => {
    writeSource(
      'src/rules.cpp',
      'class Rules { public: int decide(int a, int b, int c, int d, int e, int f, int g); };\nint ns::Rules::decide(int a, int b, int c, int d, int e, int f, int g) { return a; }\nint& Rules::ref(int& a, int b, int c, int d, int e, int f, int g) { return a; }\nRules::operator std::string() { if (flag) return {}; return {}; }\nnamespace ns { int inside(int a, int b, int c, int d, int e, int f, int g) { return a; } int Rules::other(int a, int b, int c, int d, int e, int f, int g) { return a; } }\nnamespace ns { int ns::Rules::spelled(int a, int b, int c, int d, int e, int f, int g) { return a; } }\nnamespace ns { namespace { int local(int a, int b, int c, int d, int e, int f, int g) { return a; } } }\n'
    );
    const { stdout } = runCheck(['src/rules.cpp']);
    expect(stdout).toContain('src/rules.cpp:2-2 ns::Rules.decide: parameters 7 (max 6)\n');
    expect(stdout).toContain('src/rules.cpp:3-3 Rules.ref: parameters 7 (max 6)\n');
    expect(stdout).toContain('src/rules.cpp:5-5 ns.inside: parameters 7 (max 6)\n');
    // An unnamed namespace adds nothing to the name.
    expect(stdout).toContain('src/rules.cpp:7-7 ns.local: parameters 7 (max 6)\n');
    // A friend belongs to the namespace around its class, however nested the class,
    // `namespace a::b` names two scopes, and template arguments add nothing.
    writeSource(
      'src/more.cpp',
      'namespace a :: b { struct Outer { class Rules { friend int near(int a, int b, int c, int d, int e, int f, int g) { return a; } }; }; }\ntemplate <typename T> int a::b::Plain<T>::spelled(int a, int b, int c, int d, int e, int f, int g) { return a; }\nnamespace values { auto bound = [](int a, int b, int c, int d, int e, int f, int g) { return a; }; }\nstruct Holder { union Inner { void member(int a, int b, int c, int d, int e, int f, int g) {} }; };\ntemplate <> class ns::Box<int> { void put(int a, int b, int c, int d, int e, int f, int g) {} };\n'
    );
    const more = runCheck(['src/more.cpp']).stdout;
    expect(more).toContain('src/more.cpp:1-1 a::b.near: parameters 7 (max 6)\n');
    expect(more).toContain('src/more.cpp:2-2 a::b::Plain.spelled: parameters 7 (max 6)\n');
    // A lambda is a value: it keeps the name of what it is bound to and takes no owner.
    expect(more).toContain('src/more.cpp:3-3 bound: parameters 7 (max 6)\n');
    expect(more).toContain('src/more.cpp:5-5 ns::Box.put: parameters 7 (max 6)\n');
    // A union is a class like a struct.
    expect(more).toContain('src/more.cpp:4-4 Holder::Inner.member: parameters 7 (max 6)\n');
    // A namespace both enclosing and spelled out is counted once.
    expect(stdout).toContain('src/rules.cpp:6-6 ns::Rules.spelled: parameters 7 (max 6)\n');
    // The same method is named alike whether it is defined inside its namespace or outside.
    expect(stdout).toContain('src/rules.cpp:5-5 ns::Rules.other: parameters 7 (max 6)\n');
    // The `::` of the conversion type belongs to the name, not to the scope.
    expect(runCheck(['src/rules.cpp', '--warning-max-function-cognitive-complexity', '0']).stdout).toContain(
      'src/rules.cpp:4-4 Rules.operator std::string: cognitive complexity 1 (max 0; largest parts L4 1)\n'
    );
  });

  it('names a function written as a value by what it is bound to, without an owner', () => {
    writeSource(
      'src/Values.java',
      'class Values {\n  Seven member = (a, b, c, d, e, f, g) -> a;\n  int method(int a, int b, int c, int d, int e, int f, int g) { return a; }\n}\ninterface Seven { int apply(int a, int b, int c, int d, int e, int f, int g); }\n'
    );
    const { stdout } = runCheck(['src/Values.java']);
    expect(stdout).toContain('src/Values.java:2-2 member: parameters 7 (max 6)\n');
    expect(stdout).toContain('src/Values.java:3-3 Values.method: parameters 7 (max 6)\n');
  });

  it('leaves a method of an object literal in a class unqualified', () => {
    writeSource(
      'src/outer.ts',
      'export class Outer {\n  value = {\n    run(a: number, b: number, c: number, d: number, e: number, f: number, g: number) {\n      return a;\n    },\n  };\n}\n'
    );
    expect(runCheck(['src/outer.ts']).stdout).toContain('src/outer.ts:3-5 run: parameters 7 (max 6)\n');
  });

  it('names a Ruby singleton method with the object it is defined on', () => {
    writeSource(
      'src/rules.rb',
      'class Rules\n  class << Other\n    def decide(a, b, c, d, e, f, g)\n    end\n  end\n\n  def self.build(a, b, c, d, e, f, g)\n  end\n\n  private def hidden(a, b, c, d, e, f, g)\n  end\nend\n'
    );
    const { stdout } = runCheck(['src/rules.rb']);
    expect(stdout).toContain(' Other.decide: parameters 7 (max 6)\n');
    expect(stdout).toContain(' Rules.build: parameters 7 (max 6)\n');
    // A definition passed to `private` is still a member.
    expect(stdout).toContain(' Rules.hidden: parameters 7 (max 6)\n');
  });

  it('names a member of a Kotlin companion with the class it accompanies', () => {
    writeSource(
      'src/Companion.kt',
      'class Companion {\n  companion object {\n    fun build(a: Int, b: Int, c: Int, d: Int, e: Int, f: Int, g: Int): Int { return a }\n  }\n}\n'
    );
    expect(runCheck(['src/Companion.kt']).stdout).toContain(
      'src/Companion.kt:3-3 Companion.build: parameters 7 (max 6)\n'
    );
  });

  it('names a Go method with its receiver type', () => {
    writeSource(
      'src/rules.go',
      'package rules\n\nfunc (r *Rules) Decide(a, b, c, d, e, f, g int) int {\n\treturn a\n}\n'
    );
    expect(runCheck(['src/rules.go']).stdout).toContain('src/rules.go:3-5 Rules.Decide: parameters 7 (max 6)\n');
  });

  it('prints a single line and exits 0 when nothing exceeds a threshold', () => {
    const result = runCheck(['src/calc.ts']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('No threshold violations: 1 files, 1 functions checked.\n');
  });

  it('lists at most three partner locations of a duplicated block', () => {
    writeSource('src/copies/a.ts', reportFunction('copyA'));
    expect(runCheck(['src/copies']).stdout).toContain(
      'src/copies/a.ts:1-12: duplicated lines 12 (max 9), also at src/report.ts:1-12, src/summary.ts:1-12\n'
    );
    // A fractional limit allows the whole line counts below it.
    expect(runCheck(['src/copies', '--warning-min-duplicate-lines', '11.5']).stdout).toContain(
      'duplicated lines 12 (max 11)'
    );
    writeSource('src/copies/b.ts', reportFunction('copyB'));
    writeSource('src/copies/c.ts', reportFunction('copyC'));
    expect(runCheck(['src/copies']).stdout).toContain(
      'src/copies/a.ts:1-12: duplicated lines 12 (max 9), also at src/copies/b.ts:1-12, src/copies/c.ts:1-12, src/report.ts:1-12, ...\n'
    );
  });

  it('measures a duplicated block by its code lines, whatever comments and blank lines it holds', () => {
    const commented = reportFunction('commented').replaceAll(/^ {2}const /gmu, '\n  // A step.\n  const ');
    writeSource('src/commented.ts', commented);
    expect(runCheck(['src/commented.ts']).stdout).toContain(
      'src/commented.ts:1-22: duplicated lines 12 (max 9), also at src/report.ts:1-12'
    );
    expect(runCheck(['src/commented.ts', '--warning-min-duplicate-lines', '13']).stdout).not.toContain('duplicated');
  });

  it('detects duplication against the git-visible files of the whole repository, with or without --base', () => {
    writeSource('.gitignore', 'build/\n');
    writeSource('build/generated.ts', otherFunction('generated'));
    writeSource('src2/fresh.ts', otherFunction('fresh'));
    // The only other copy is git-ignored, so neither mode sees duplication.
    expect(hasViolations(['src2'])).toBe(false);
    expect(hasViolations(['--base', 'main', 'src2'])).toBe(false);

    writeSource('lib/origin.ts', otherFunction('origin'));
    // A copy outside the target is a partner in both modes, under its repository-relative path.
    const line = 'src2/fresh.ts:1-13: duplicated lines 13 (max 9), also at lib/origin.ts:1-13\n';
    expect(runCheck(['src2']).stdout).toContain(line);
    expect(runCheck(['--base', 'main', 'src2']).stdout).toContain(line);
    expect(runCheck(['src2']).stdout).toContain('(1 files, 2 functions checked)');
  });

  it('ranks a copy outside the target by its code lines like one inside', () => {
    // A copy of the statements only, which comments stretch over more lines than a full copy.
    const statements = reportFunction('partial').split('\n').slice(1, 10).join('\n  // A step.\n\n');
    writeSource(
      'src/padded.ts',
      `export function digest(items: number[], label: string): string {\n  console.log(label);\n${statements}\n  return \`\${label}: \${weighted}\`;\n}\n`
    );
    writeSource('src/sub/full.ts', reportFunction('full'));
    expect(runCheck(['src/sub', '--warning-min-duplicate-lines', '5']).stdout).toContain(
      'src/sub/full.ts:1-12: duplicated lines 12 (max 4), also at src/report.ts:1-12, src/summary.ts:1-12, src/padded.ts:3-27\n'
    );
  });

  it('prints a JSON report with --json', () => {
    const result = runCheck(['--json']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      passed: true,
      summary: {
        violationCount: 3,
        errorViolationCount: 0,
        warningViolationCount: 3,
        functionViolationCount: 1,
        fileViolationCount: 0,
        duplicationViolationCount: 2,
        checkedFileCount: 4,
        checkedFunctionCount: 5,
      },
      violations: [
        {
          kind: 'function',
          level: 'warning',
          file: 'src/legacy.ts',
          startLine: 1,
          endLine: 21,
          name: 'decide',
          exceeded: [
            { metric: 'functionCognitiveComplexity', value: 24, level: 'warning', limit: 15 },
            { metric: 'functionNestingDepth', value: 5, level: 'warning', limit: 4 },
          ],
          largestBlocks: [
            { startLine: 4, endLine: 10, cognitiveComplexity: 12 },
            { startLine: 16, endLine: 16, cognitiveComplexity: 2 },
            { startLine: 17, endLine: 17, cognitiveComplexity: 2 },
          ],
        },
        {
          kind: 'duplication',
          level: 'warning',
          file: 'src/report.ts',
          startLine: 1,
          endLine: 12,
          exceeded: [{ metric: 'duplicateLines', value: 12, level: 'warning', limit: 10 }],
          partners: [{ file: 'src/summary.ts', startLine: 1, endLine: 12 }],
        },
        {
          kind: 'duplication',
          level: 'warning',
          file: 'src/summary.ts',
          startLine: 1,
          endLine: 12,
          exceeded: [{ metric: 'duplicateLines', value: 12, level: 'warning', limit: 10 }],
          partners: [{ file: 'src/report.ts', startLine: 1, endLine: 12 }],
        },
      ],
      errors: [],
      warnings: [],
    });
  });

  it('reports a file-level violation with the file as its span', () => {
    const result = runCheck(['--json', '--warning-max-file-ncss', '4', 'src/calc.ts']);
    expect((JSON.parse(result.stdout) as { violations: unknown[] }).violations).toEqual([
      {
        kind: 'file',
        level: 'warning',
        file: 'src/calc.ts',
        startLine: 1,
        endLine: 7,
        exceeded: [{ metric: 'fileNcss', value: 5, level: 'warning', limit: 4 }],
      },
    ]);
    expect(runCheck(['--warning-max-file-ncss', '4', 'src/calc.ts']).stdout).toContain(
      '\nwarning: src/calc.ts: file NCSS 5 (max 4)\n'
    );
  });
});

describe('code-gauge check: thresholds', () => {
  it('applies the config file over the defaults and the command line over the config file', () => {
    expect(hasViolations(['src/calc.ts'])).toBe(false);
    writeConfig({ thresholds: { warning: { maxFunctionNcss: 3 } } });
    expect(runCheck(['src/calc.ts']).stdout).toContain('calc.ts:1-7 total: NCSS 5 (max 3)\n');
    expect(hasViolations(['src/calc.ts', '--warning-max-function-ncss', '5'])).toBe(false);
    expect(runCheck(['src/calc.ts', '--warning-max-function-ncss', '4']).stdout).toContain('NCSS 5 (max 4)');
  });

  it('disables a threshold with null in the config file or "off" on the command line', () => {
    writeConfig({
      thresholds: {
        warning: { maxFunctionNestingDepth: 4, maxFunctionCognitiveComplexity: disabled, minDuplicateLines: disabled },
      },
    });
    const result = runCheck([]);
    expect(result.stdout).toContain('1 warnings (1 functions, 0 files, 0 duplicated blocks)');
    expect(result.stdout).toContain('src/legacy.ts:1-21 decide: nesting depth 5 (max 4)\n');
    expect(hasViolations(['--warning-max-function-nesting-depth', 'off'])).toBe(false);
  });

  it('overrides thresholds per language', () => {
    writeSource(
      'src/calc.py',
      'def total(items):\n    result = 0\n    for item in items:\n        result += item\n    return result\n'
    );
    writeConfig({
      thresholds: {
        warning: {
          maxFunctionNcss: 3,
          minDuplicateLines: disabled,
          maxFunctionCognitiveComplexity: disabled,
          maxFunctionNestingDepth: disabled,
          languages: { python: { maxFunctionNcss: disabled }, typescript: { maxFunctionNcss: 4 } },
        },
      },
    });
    const result = runCheck([]);
    expect(result.stdout).toContain('src/calc.ts:1-7 total: NCSS 5 (max 4)\n');
    expect(result.stdout).not.toContain('calc.py');
    // The command line wins over the per-language overrides too.
    expect(runCheck(['--warning-max-function-ncss', '3']).stdout).toContain('src/calc.py:1-5 total: NCSS 5 (max 3)\n');
  });

  it.each([
    [
      'an unknown level',
      { thresholds: { maxFunctionNcss: 1 } },
      'unknown setting "maxFunctionNcss" in "thresholds" (expected warning, error)',
    ],
    [
      'an unknown threshold',
      { thresholds: { error: { maxFunctionLines: 1 } } },
      'unknown setting "maxFunctionLines" in "thresholds.error"',
    ],
    ['a removed section', { gate: {} }, 'unknown setting "gate"'],
    [
      'a negative limit',
      { thresholds: { warning: { maxFileNcss: -1 } } },
      '"thresholds.warning.maxFileNcss" must be a non-negative number or null',
    ],
    [
      'an unknown language',
      { thresholds: { warning: { languages: { cobol: {} } } } },
      'unknown language "cobol" in "thresholds.warning.languages"',
    ],
    [
      'an unknown per-language setting',
      { thresholds: { warning: { languages: { python: { languages: {} } } } } },
      'unknown setting "languages" in "thresholds.warning.languages.python"',
    ],
  ])('rejects %s in the config file', (_, config, message) => {
    writeConfig(config);
    const result = runCheck([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it('rejects a threshold option that is neither a number nor "off"', () => {
    const result = runCheck(['--warning-max-function-ncss', 'none']);
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
    expect(runCheck(['--base', 'main']).stdout).toMatch(
      /^No threshold violations: 1 changed files, 1 functions checked/u
    );

    writeSource('src/legacy.ts', legacy.replace('return fallback;', 'return fallback + 0;'));
    expect(runCheck(['--base', 'main']).stdout).toContain(
      'src/legacy.ts:1-21 decide: cognitive complexity 24 (max 15; largest parts L4-10 12, L16 2, L17 2), nesting depth 5 (max 4)\n'
    );
  });

  it('counts a pure deletion inside a function as touching it, but not one right after it', () => {
    writeSource('src/legacy.ts', legacy.replace('  if (d > 1) { return 4; }\n', ''));
    expect(runCheck(['--base', 'main']).stdout).toContain('src/legacy.ts:1-20 decide:');

    writeSource('src/legacy.ts', legacy.replace('}\n\nexport function identity', '}\nexport function identity'));
    expect(hasViolations(['--base', 'main'])).toBe(false);
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
    expect(result.stdout).toContain('src/wide.py:1-2 calculate: parameters 8 (max 6)\n');
  });

  it('keeps a function whose name spans lines on one line', () => {
    writeSource(
      'src/holder.ts',
      'export class Holder {\n  [`foo\nbar`](a, b, c, d, e, f, g, h) {\n    return a;\n  }\n}\n'
    );
    expect(runCheck(['src/holder.ts']).stdout).toContain(
      'src/holder.ts:2-5 Holder.[`foo bar`]: parameters 8 (max 6)\n'
    );
  });

  it('reports a file-level violation only for a changed file', () => {
    writeSource('src/calc.ts', `${calc}export const offset = 1;\n`);
    const result = runCheck(['--base', 'main', '--warning-max-file-ncss', '5', '--json']);
    const report = JSON.parse(result.stdout) as { base: string; mergeBase: string; violations: { file: string }[] };
    expect(report.violations.map(({ file }) => file)).toEqual(['src/calc.ts']);
    expect(report.base).toBe('main');
    expect(report.mergeBase).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('reports no file-level violation for a file whose lines did not change', () => {
    chmodSync(path.join(repoDir, 'src', 'calc.ts'), 0o755);
    expect(runCheck(['--base', 'main', '--warning-max-file-ncss', '1']).stdout).toMatch(
      /^No threshold violations: 1 changed files, 0 functions checked/u
    );
  });

  it('reports the duplicated block a change added, with the unchanged code it copies as its partners', () => {
    writeSource('src/pasted.ts', reportFunction('pasted'));
    const result = runCheck(['--base', 'main']);
    expect(result.stdout).toContain('1 warnings (0 functions, 0 files, 1 duplicated blocks)');
    expect(result.stdout).toContain(
      'src/pasted.ts:1-12: duplicated lines 12 (max 9), also at src/report.ts:1-12, src/summary.ts:1-12\n'
    );
  });

  it('checks staged changes and commits made since the merge-base', () => {
    runGit(['checkout', '-q', '-b', 'feature']);
    writeSource('src/pasted.ts', reportFunction('pasted'));
    runGit(['add', '-A']);
    expect(hasViolations(['--base', 'main'])).toBe(true);
    runGit(['commit', '-q', '-m', 'paste']);
    expect(hasViolations(['--base', 'main'])).toBe(true);
  });

  it('limits the check to the changed files under the target', () => {
    writeSource('lib/pasted.ts', reportFunction('pasted'));
    expect(hasViolations(['--base', 'main', 'src'])).toBe(false);
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
    const result = runCheck(['--warning-min-duplicate-lines', '5', plainDir], plainDir);
    expect(result.stdout).toContain(`
warning: a.ts:1-12: duplicated lines 12 (max 4), also at a.ts:14-25, b.ts:3-11
warning: a.ts:14-25: duplicated lines 12 (max 4), also at a.ts:1-12, b.ts:3-11
warning: b.ts:3-11: duplicated lines 9 (max 4), also at a.ts:2-10, a.ts:15-23
`);
  });

  it('measures the duplicated blocks of a targeted file by their code lines too', () => {
    const padded = reportFunction('second').replaceAll(/^ {2}const /gmu, '  // A step.\n  const ');
    writeFileSync(path.join(plainDir, 'padded.ts'), `${reportFunction('first')}\n${padded}`);
    const result = runCheck(['--warning-min-duplicate-lines', '13', 'padded.ts'], plainDir);
    rmSync(path.join(plainDir, 'padded.ts'));
    expect(result.stdout).toBe('No threshold violations: 1 files, 2 functions checked.\n');
  });

  it('lists the copies of a duplicated block with the most code lines first', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'code-gauge-check-copies-'));
    try {
      writeFileSync(path.join(dir, 'code-gauge.config.json'), '{}');
      // A copy of the statements only, which comments stretch over more lines than a full copy.
      const statements = reportFunction('partial').split('\n').slice(1, 10).join('\n  // A step.\n\n');
      writeFileSync(
        path.join(dir, 'a.ts'),
        `export function digest(items: number[], label: string): string {\n  console.log(label);\n${statements}\n  return \`\${label}: \${weighted}\`;\n}\n`
      );
      writeFileSync(path.join(dir, 'm.ts'), reportFunction('middle'));
      writeFileSync(path.join(dir, 'z.ts'), reportFunction('last'));
      expect(runCheck(['--warning-min-duplicate-lines', '5', dir], dir).stdout).toContain(
        'm.ts:1-12: duplicated lines 12 (max 4), also at z.ts:1-12, a.ts:3-27\n'
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
