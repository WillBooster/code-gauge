import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureCode, supportedLanguages } from '../../src/index.js';

// Cognitive complexity follows the SonarSource specification (cross-validated against PMD's Java
// rules during authoring); Halstead metrics are checked for internal consistency because every
// reference tool defines its own operator/operand model.

const fixturesDir = path.join(import.meta.dirname, '..', 'fixtures');

function readFixture(filename: string): string {
  return readFileSync(path.join(fixturesDir, filename), 'utf8');
}

interface LanguageCase {
  expected: {
    functionNames: string[];
    language: string;
    maxCognitiveComplexity: number;
  };
  fixture: string;
  language: string;
  name: string;
}

const languageCases: LanguageCase[] = [
  {
    name: 'JavaScript',
    language: 'javascript',
    fixture: 'sample.js',
    expected: { language: 'javascript', functionNames: ['score'], maxCognitiveComplexity: 3 },
  },
  {
    name: 'JSX',
    language: 'jsx',
    fixture: 'sample.jsx',
    expected: { language: 'jsx', functionNames: ['Card'], maxCognitiveComplexity: 1 },
  },
  {
    name: 'TypeScript',
    language: 'typescript',
    fixture: 'sample.ts',
    expected: { language: 'typescript', functionNames: ['choose'], maxCognitiveComplexity: 1 },
  },
  {
    name: 'TSX',
    language: 'tsx',
    fixture: 'sample.tsx',
    expected: { language: 'tsx', functionNames: ['Card'], maxCognitiveComplexity: 1 },
  },
  {
    name: 'Python',
    language: 'python',
    fixture: 'sample.py',
    expected: { language: 'python', functionNames: ['choose'], maxCognitiveComplexity: 1 },
  },
  {
    name: 'Go',
    language: 'go',
    fixture: 'sample.go',
    expected: { language: 'go', functionNames: ['choose'], maxCognitiveComplexity: 1 },
  },
  {
    name: 'Rust',
    language: 'rust',
    fixture: 'sample.rs',
    expected: { language: 'rust', functionNames: ['choose'], maxCognitiveComplexity: 1 },
  },
  {
    name: 'Java',
    language: 'java',
    fixture: 'sample.java',
    expected: { language: 'java', functionNames: ['choose'], maxCognitiveComplexity: 1 },
  },
  {
    name: 'Ruby',
    language: 'ruby',
    fixture: 'sample.rb',
    expected: { language: 'ruby', functionNames: ['choose'], maxCognitiveComplexity: 1 },
  },
  {
    name: 'C',
    language: 'c',
    fixture: 'sample.c',
    expected: { language: 'c', functionNames: ['choose'], maxCognitiveComplexity: 1 },
  },
  {
    name: 'C++',
    language: 'cpp',
    fixture: 'sample.cpp',
    expected: { language: 'cpp', functionNames: ['choose'], maxCognitiveComplexity: 1 },
  },
];

describe('measureCode: per-language parsing', () => {
  for (const testCase of languageCases) {
    it(`measures ${testCase.name} code from the syntax tree`, () => {
      const code = readFixture(testCase.fixture);
      const metrics = measureCode(code, { language: testCase.language });

      expect(metrics.language).toBe(testCase.expected.language);
      expect(metrics.bytes).toBe(Buffer.byteLength(code));
      expect(metrics.lines.total).toBe(code.split('\n').length);
      expect(metrics.lines.code).toBeGreaterThan(0);
      expect(metrics.functions.map((fn) => fn.name)).toEqual(testCase.expected.functionNames);
      expect(metrics.maxCognitiveComplexity).toBe(testCase.expected.maxCognitiveComplexity);
      expect(metrics.cognitiveComplexity).toBeGreaterThanOrEqual(metrics.maxCognitiveComplexity);
      expect(metrics.ncssCount).toBeGreaterThan(0);
    });
  }
});

describe('measureCode: line, complexity, and Halstead metrics', () => {
  it('measures line counts, complexity, and Halstead metrics together', () => {
    const code = readFixture('sample.js');

    const metrics = measureCode(code, { language: 'javascript' });

    expect(metrics.lines).toEqual({
      total: 10,
      code: 7,
      comment: 1,
      blank: 2,
    });
    expect(metrics.functions[0]).toMatchObject({
      name: 'score',
      startLine: 3,
      endLine: 9,
      cognitiveComplexity: 3,
    });
    expect(metrics.cognitiveComplexity).toBe(3);
    expect(metrics.halstead.length).toBeGreaterThan(0);
    expect(metrics.halstead.volume).toBeGreaterThan(0);
  });

  it('keeps Halstead sub-metrics internally consistent', () => {
    const metrics = measureCode(readFixture('cognitiveNesting.js'), { language: 'javascript' });
    const halstead = metrics.halstead;

    expect(halstead.vocabulary).toBe(halstead.distinctOperators + halstead.distinctOperands);
    expect(halstead.length).toBe(halstead.totalOperators + halstead.totalOperands);
    expect(halstead.volume).toBeCloseTo(halstead.length * Math.log2(halstead.vocabulary), 5);
    // effort = difficulty * volume with difficulty = (n1 / 2) * (N2 / n2).
    expect(halstead.effort).toBeCloseTo(
      (halstead.distinctOperators / 2) * (halstead.totalOperands / halstead.distinctOperands) * halstead.volume,
      5
    );
  });

  it('measures multiple functions and reports the maximum function complexity', () => {
    const code = readFixture('multiple-functions.js');

    const metrics = measureCode(code, { language: 'javascript' });

    expect(metrics.functions.map((fn) => fn.name)).toEqual(['simple', 'complex']);
    expect(metrics.maxCognitiveComplexity).toBe(Math.max(...metrics.functions.map((fn) => fn.cognitiveComplexity)));
  });
});

// Issue #22 items 1-4: the SonarSource cognitive-complexity model, verified per rule.
function cognitiveOf(code: string, language = 'javascript'): number | undefined {
  return measureCode(code, { language }).functions[0]?.cognitiveComplexity;
}

describe('measureCode: cognitive complexity and nesting', () => {
  // classify(): for (+1) → if with `&&` (+2 nesting, +1 logical) → nested if (+3) with plain else
  // (+1) = 8 per the strict SonarSource model (issue #22).
  it('charges a nesting surcharge on nested decisions', () => {
    const metrics = measureCode(readFixture('cognitiveNesting.js'), { language: 'javascript' });

    const classify = metrics.functions[0];
    expect(classify).toMatchObject({
      name: 'classify',
      cognitiveComplexity: 8,
      nestingDepth: 3,
      parameterCount: 1,
    });
    expect(metrics.maxCognitiveComplexity).toBe(8);
    expect(metrics.nestingDepth).toBe(3);
  });

  it('counts a run of identical boolean operators once and each operator change once more', () => {
    expect(cognitiveOf('function f(a,b){ if (a && b) return 1; }')).toBe(2);
    expect(cognitiveOf('function f(a,b,c){ if (a && b && c) return 1; }')).toBe(2);
    expect(cognitiveOf('function f(a,b,c){ if (a && (b && c)) return 1; }')).toBe(2);
    expect(cognitiveOf('function f(a,b,c){ if (a && b || c) return 1; }')).toBe(3);
    expect(cognitiveOf('function f(a,b,c,d){ if (a && b || c && d) return 1; }')).toBe(4);
  });

  it('adds one flat point for a plain else, without a nesting surcharge', () => {
    expect(cognitiveOf('function f(a){ if (a) { return 1; } else { return 2; } }')).toBe(2);
    expect(cognitiveOf('function f(a,b){ if (a) { return 1; } else if (b) { return 2; } else { return 3; } }')).toBe(3);
    // The else is flat even when the if is nested (if +1, inner if +2, else +1, not +3).
    expect(cognitiveOf('function f(a,b){ if (a) { if (b) { return 1; } else { return 2; } } }')).toBe(4);
    expect(cognitiveOf('def f(a):\n    if a:\n        return 1\n    else:\n        return 2\n', 'python')).toBe(2);
    expect(cognitiveOf('def f(a)\n  if a\n    1\n  else\n    2\n  end\nend\n', 'ruby')).toBe(2);
  });

  // Sonar's written spec adds +1 per function in a recursion cycle, but code-gauge intentionally
  // omits it (issue #22): mainstream implementations (PMD, SonarQube analyzers) do not charge
  // recursion. This pins the decided behavior.
  it('does not add cognitive complexity for direct or mutual recursion', () => {
    expect(cognitiveOf('function f(n){ if (n <= 1) return 1; return n * f(n - 1); }')).toBe(1);
    const mutual = measureCode(
      'function even(n){ return n === 0 || odd(n - 1); }\nfunction odd(n){ return n !== 0 && even(n - 1); }\n',
      {
        language: 'javascript',
      }
    );
    expect(mutual.functions.map((fn) => fn.cognitiveComplexity)).toEqual([1, 1]);
    expect(mutual.maxCognitiveComplexity).toBe(1);
  });
});

describe('measureCode: NCSS (non-commenting source statements)', () => {
  // The same 4-statement `choose` function (declaration + if + two returns) is fixtured in every
  // supported language, so PMD-style NCSS must agree across grammars.
  const sampleFixtures: Record<string, string> = {
    c: 'sample.c',
    cpp: 'sample.cpp',
    go: 'sample.go',
    java: 'sample.java',
    python: 'sample.py',
    ruby: 'sample.rb',
    rust: 'sample.rs',
    typescript: 'sample.ts',
  };
  for (const [language, fixture] of Object.entries(sampleFixtures)) {
    it(`counts the shared choose() fixture as 4 statements in ${language}`, () => {
      const metrics = measureCode(readFixture(fixture), { language });
      const choose = metrics.functions.find((fn) => fn.name === 'choose');
      expect(choose?.ncss).toBe(4);
    });
  }

  it('does not double-count exported declarations in TypeScript', () => {
    const metrics = measureCode('export const a = 1;\nexport function f() {\n  return a;\n}\n', {
      language: 'typescript',
    });
    // export const (1) + function declaration (1) + return (1); the export wrappers add nothing.
    expect(metrics.ncssCount).toBe(3);
    // Contextually counted (internal_module) and ambient-wrapped declarations behave the same.
    expect(measureCode('export namespace N {}', { language: 'typescript' }).ncssCount).toBe(1);
    expect(measureCode('export declare function f(): void;', { language: 'typescript' }).ncssCount).toBe(1);
  });

  it('counts Go type members only inside named type declarations', () => {
    const named = measureCode('package p\ntype T struct {\n\ta int\n\tb string\n}\n', { language: 'go' });
    // package (1) + type (1) + two fields.
    expect(named.ncssCount).toBe(4);
    const anonymous = measureCode(
      'package p\nfunc f() {\n\tvar x struct {\n\t\ta int\n\t\tb string\n\t}\n\t_ = x\n}\n',
      {
        language: 'go',
      }
    );
    // package (1) + func (1) + var (1) + assignment (1); inline anonymous members are part of the var.
    expect(anonymous.ncssCount).toBe(4);
  });

  it('counts else, case labels, catch, and finally but not try, braces, or comments', () => {
    const code = [
      'function f(x) {',
      '  // comment only',
      '  try {',
      '    switch (x) {',
      '      case 1:',
      '        x += 1;',
      '        break;',
      '      default:',
      '        x -= 1;',
      '    }',
      '  } catch (error) {',
      '    x = 0;',
      '  } finally {',
      '    x += 2;',
      '  }',
      '  if (x > 0) {',
      '    x -= 3;',
      '  } else {',
      '    x = 4;',
      '  }',
      '  return x;',
      '}',
    ].join('\n');
    const metrics = measureCode(code, { language: 'javascript' });
    // function 1 + switch 1 + case 1 + stmt 1 + break 1 + default 1 + stmt 1 + catch 1 + stmt 1 +
    // finally 1 + stmt 1 + if 1 + stmt 1 + else 1 + stmt 1 + return 1 = 16 (try adds 0).
    expect(metrics.ncssCount).toBe(16);
    expect(metrics.functions[0]?.ncss).toBe(16);
  });

  it('counts Ruby bodies positionally, including rescue and ensure clauses', () => {
    const code = [
      'def load(path)',
      '  data = read(path)',
      '  parse(data)',
      'rescue IOError => error',
      '  log(error)',
      'ensure',
      '  cleanup',
      'end',
    ].join('\n');
    const metrics = measureCode(code, { language: 'ruby' });
    // def 1 + assignment 1 + call 1 + rescue 1 + call 1 + ensure 1 + call 1 = 7.
    expect(metrics.ncssCount).toBe(7);
  });

  it('counts Rust trailing block expressions as statements', () => {
    const code = 'fn add(left: i32, right: i32) -> i32 {\n    let sum = left + right;\n    sum\n}\n';
    const metrics = measureCode(code, { language: 'rust' });
    // fn 1 + let 1 + trailing expression 1.
    expect(metrics.ncssCount).toBe(3);
  });

  it('excludes for-header declarations, matching PMD', () => {
    const code = 'class A {\n  void f(int n) {\n    for (int i = 0; i < n; i++) {\n      use(i);\n    }\n  }\n}\n';
    const metrics = measureCode(code, { language: 'java' });
    // class 1 + method 1 + for 1 + call statement 1; `int i = 0` belongs to the for header.
    expect(metrics.ncssCount).toBe(4);
  });
});

describe('measureCode: within-file duplication', () => {
  // summarizeOrders and summarizeRefunds are structurally identical with consistently renamed
  // identifiers (orders/refunds, order/refund). The detector anonymizes identifiers by first
  // occurrence, so the copies match despite the renames.
  it('detects consistently renamed copy-paste blocks', () => {
    const metrics = measureCode(readFixture('duplicateBlocks.js'), { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
    expect(metrics.duplication.duplicateBlockCount).toBe(1);
    expect(metrics.duplication.duplicateBlockGroups).toEqual([
      [
        { startLine: 1, endLine: 12 },
        { startLine: 14, endLine: 25 },
      ],
    ]);
    expect(metrics.duplication.duplicationRatio).toBe(1);
    expect(metrics.duplication.maxDuplicateBlockSize).toBeGreaterThanOrEqual(40);
  });

  it('reports no duplication for a file without repeated regions', () => {
    const metrics = measureCode(readFixture('callGraph.js'), { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockCount).toBe(0);
    expect(metrics.duplication.duplicateBlockGroups).toEqual([]);
    expect(metrics.duplication.duplicationRatio).toBe(0);
  });
});

describe('measureCode: function naming', () => {
  it('names functions bound to variables and wrapped React components', () => {
    const metrics = measureCode(
      'const plain = (x) => x + 1;\nconst Wrapped = memo(() => {\n  return render();\n});\n',
      { language: 'javascript' }
    );
    expect(metrics.functions.map((fn) => fn.name)).toEqual(['plain', 'Wrapped']);
  });
});

describe('measureCode: options and edge cases', () => {
  it('supports built-in language aliases', () => {
    const cases = [
      { alias: 'js', code: 'function run() { return 1; }', expectedLanguage: 'javascript' },
      { alias: 'ts', code: 'export function run(): number { return 1; }', expectedLanguage: 'typescript' },
      { alias: 'py', code: 'def run():\n    return 1', expectedLanguage: 'python' },
      { alias: 'rs', code: 'fn run() -> i32 { 1 }', expectedLanguage: 'rust' },
      { alias: 'rb', code: 'def run\n  1\nend', expectedLanguage: 'ruby' },
    ];

    for (const { alias, code, expectedLanguage } of cases) {
      expect(measureCode(code, { language: alias }).language).toBe(expectedLanguage);
    }
  });

  it('includes the syntax tree only when requested', () => {
    const code = 'function run() { return 1; }';

    expect(measureCode(code, { language: 'javascript' }).syntaxTree).toBeUndefined();
    expect(measureCode(code, { language: 'javascript', includeSyntaxTree: true }).syntaxTree).toContain(
      'function_declaration'
    );
  });

  it('returns zero source metrics for empty code', () => {
    const metrics = measureCode('', { language: 'javascript' });

    expect(metrics.lines).toEqual({
      total: 0,
      code: 0,
      comment: 0,
      blank: 0,
    });
    expect(metrics.functions).toEqual([]);
    expect(metrics.maxCognitiveComplexity).toBe(0);
    expect(metrics.halstead.length).toBe(0);
  });

  it('throws for unsupported languages', () => {
    expect(() => measureCode('main = putStrLn "hello"', { language: 'haskell' })).toThrow(
      'Unsupported language: haskell'
    );
  });

  it('lists built-in languages', () => {
    expect(supportedLanguages).toEqual([
      'javascript',
      'jsx',
      'typescript',
      'tsx',
      'python',
      'go',
      'rust',
      'java',
      'ruby',
      'c',
      'cpp',
    ]);
  });
});
