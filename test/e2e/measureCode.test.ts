import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureCode, supportedLanguages } from '../../src/index.js';

// Expected complexity values in this file were cross-validated against reference tools during
// authoring: cyclomatic complexity against lizard 1.23.0 (`python3 -m lizard <fixture>`) and, for
// Python, radon 6.0.1 (`python3 -m radon cc`). Every fixture below produces a cyclomatic complexity
// that matches lizard exactly. Halstead and the maintainability index intentionally differ from
// radon (each tool defines its own operator/operand model and MI normalization), so those are
// checked for internal consistency and bounds rather than against a reference number.

const fixturesDir = path.join(import.meta.dirname, '..', 'fixtures');

function readFixture(filename: string): string {
  return readFileSync(path.join(fixturesDir, filename), 'utf8');
}

interface LanguageCase {
  expected: {
    classCount?: number;
    functionCount: number;
    functionNames: string[];
    language: string;
    maxCyclomaticComplexity: number;
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
    expected: {
      language: 'javascript',
      functionCount: 1,
      functionNames: ['score'],
      classCount: 1,
      maxCyclomaticComplexity: 4,
    },
  },
  {
    name: 'JSX',
    language: 'jsx',
    fixture: 'sample.jsx',
    expected: {
      language: 'jsx',
      functionCount: 1,
      functionNames: ['Card'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'TypeScript',
    language: 'typescript',
    fixture: 'sample.ts',
    expected: {
      language: 'typescript',
      functionCount: 1,
      functionNames: ['choose'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'TSX',
    language: 'tsx',
    fixture: 'sample.tsx',
    expected: {
      language: 'tsx',
      functionCount: 1,
      functionNames: ['Card'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'Python',
    language: 'python',
    fixture: 'sample.py',
    expected: {
      language: 'python',
      functionCount: 1,
      functionNames: ['choose'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'Go',
    language: 'go',
    fixture: 'sample.go',
    expected: {
      language: 'go',
      functionCount: 1,
      functionNames: ['choose'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'Rust',
    language: 'rust',
    fixture: 'sample.rs',
    expected: {
      language: 'rust',
      functionCount: 1,
      functionNames: ['choose'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'Java',
    language: 'java',
    fixture: 'sample.java',
    expected: {
      language: 'java',
      functionCount: 1,
      functionNames: ['choose'],
      classCount: 1,
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'Ruby',
    language: 'ruby',
    fixture: 'sample.rb',
    expected: {
      language: 'ruby',
      functionCount: 1,
      functionNames: ['choose'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'C',
    language: 'c',
    fixture: 'sample.c',
    expected: {
      language: 'c',
      functionCount: 1,
      functionNames: ['choose'],
      maxCyclomaticComplexity: 2,
    },
  },
  {
    name: 'C++',
    language: 'cpp',
    fixture: 'sample.cpp',
    expected: {
      language: 'cpp',
      functionCount: 1,
      functionNames: ['choose'],
      classCount: 1,
      maxCyclomaticComplexity: 2,
    },
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
      expect(metrics.functionCount).toBe(testCase.expected.functionCount);
      expect(metrics.functions.map((fn) => fn.name)).toEqual(testCase.expected.functionNames);
      expect(metrics.classCount).toBe(testCase.expected.classCount ?? 0);
      expect(metrics.maxCyclomaticComplexity).toBe(testCase.expected.maxCyclomaticComplexity);
      expect(metrics.cyclomaticComplexity).toBeGreaterThanOrEqual(metrics.maxCyclomaticComplexity);
      expect(metrics.maintainabilityIndex).toBeGreaterThan(0);
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
      cyclomaticComplexity: 4,
      cognitiveComplexity: 3,
    });
    expect(metrics.cyclomaticComplexity).toBe(4);
    expect(metrics.cognitiveComplexity).toBe(3);
    expect(metrics.halstead.length).toBeGreaterThan(0);
    expect(metrics.halstead.volume).toBeGreaterThan(0);
  });

  it('keeps Halstead sub-metrics internally consistent', () => {
    const metrics = measureCode(readFixture('cognitiveNesting.js'), { language: 'javascript' });
    const halstead = metrics.halstead;

    expect(halstead.vocabulary).toBe(halstead.distinctOperators + halstead.distinctOperands);
    expect(halstead.length).toBe(halstead.totalOperators + halstead.totalOperands);
    // difficulty = (n1 / 2) * (N2 / n2); volume = length * log2(vocabulary).
    expect(halstead.difficulty).toBeCloseTo(
      (halstead.distinctOperators / 2) * (halstead.totalOperands / halstead.distinctOperands),
      5
    );
    expect(halstead.volume).toBeCloseTo(halstead.length * Math.log2(halstead.vocabulary), 5);
    expect(halstead.effort).toBeCloseTo(halstead.difficulty * halstead.volume, 5);
  });

  it('keeps the maintainability index within its clamped 0-100 range', () => {
    const simple = measureCode('export const value = 1;', { language: 'typescript' });
    const risky = measureCode(readFixture('cognitiveNesting.js'), { language: 'javascript' });

    expect(simple.maintainabilityIndex).toBeLessThanOrEqual(100);
    expect(risky.maintainabilityIndex).toBeGreaterThan(0);
    expect(risky.maintainabilityIndex).toBeLessThan(simple.maintainabilityIndex);
  });

  it('measures multiple functions and reports the maximum function complexity', () => {
    const code = readFixture('multiple-functions.js');

    const metrics = measureCode(code, { language: 'javascript' });

    expect(metrics.functionCount).toBe(2);
    expect(metrics.functions.map((fn) => fn.name)).toEqual(['simple', 'complex']);
    expect(metrics.functions.map((fn) => fn.cyclomaticComplexity)).toEqual([1, 3]);
    expect(metrics.maxCyclomaticComplexity).toBe(3);
  });
});

describe('measureCode: cognitive complexity and nesting', () => {
  // classify(): for (+1) → if with `&&` (+2 nesting, +1 logical) → nested if (+3) with plain else
  // (+1). Cyclomatic complexity is 5 (base 1 + for + outer if + `&&` + inner if), which matches
  // lizard 1.23.0; cognitive complexity is 8 per the strict SonarSource model (issue #22).
  it('rewards nesting in cognitive complexity beyond cyclomatic complexity', () => {
    const metrics = measureCode(readFixture('cognitiveNesting.js'), { language: 'javascript' });

    const classify = metrics.functions[0];
    expect(classify).toMatchObject({
      name: 'classify',
      cyclomaticComplexity: 5,
      cognitiveComplexity: 8,
      nestingDepth: 3,
      parameterCount: 1,
      recursive: false,
    });
    expect(classify?.cognitiveComplexity).toBeGreaterThan(classify?.cyclomaticComplexity ?? 0);
    expect(metrics.maxCognitiveComplexity).toBe(8);
    expect(metrics.nestingDepth).toBe(3);
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

describe('measureCode: call graph', () => {
  it('tracks recursion, fan-in/fan-out, and call depth across a small call graph', () => {
    const metrics = measureCode(readFixture('callGraph.js'), { language: 'javascript' });

    const byName = new Map(metrics.functions.map((fn) => [fn.name, fn]));
    expect(byName.get('factorial')).toMatchObject({ recursive: true, fanIn: 2, fanOut: 1, callCount: 1 });
    expect(byName.get('build')).toMatchObject({ recursive: false, fanOut: 2, callCount: 3, uniqueCalleeCount: 2 });
    expect(byName.get('combine')).toMatchObject({ fanIn: 1, fanOut: 0 });

    // internalCallCount currently equals internalEdgeCount (unique caller→callee edges); it does not
    // count call occurrences (which would be 4 here). This pins current behavior; see issue #22.
    expect(metrics.callGraph).toMatchObject({
      callCount: 4,
      internalCallCount: 3,
      internalEdgeCount: 3,
      recursiveFunctionCount: 1,
      maxFanIn: 2,
      maxFanOut: 2,
      maxCallDepth: 2,
    });
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

describe('measureCode: coupling and module structure', () => {
  it('separates relative and external imports and lists exported declarations', () => {
    const metrics = measureCode(readFixture('coupling.ts'), { language: 'typescript' });

    expect(metrics.coupling).toEqual({
      importCount: 4,
      importSourceCount: 4,
      relativeImportCount: 2,
      externalImportCount: 2,
      exportCount: 2,
    });
    expect(metrics.module.importSources).toEqual(['node:fs/promises', 'node:path', './helper.js', '../shared.js']);
    expect(metrics.module.declarations).toEqual([
      { exported: true, name: 'root', startLine: 6 },
      { exported: true, name: 'load', startLine: 8 },
    ]);
  });
});

describe('measureCode: type complexity', () => {
  it('counts TypeScript type-system features', () => {
    const metrics = measureCode(readFixture('typeComplexity.ts'), { language: 'typescript' });

    expect(metrics.typeComplexity).toMatchObject({
      typeAliasCount: 2,
      interfaceCount: 1,
      genericParameterCount: 2,
      unionTypeCount: 2,
      typeAssertionCount: 1,
      nonNullAssertionCount: 1,
      satisfiesExpressionCount: 1,
    });
    expect(metrics.typeComplexity.typeAnnotationCount).toBeGreaterThan(0);
  });
});

describe('measureCode: syntax features', () => {
  it('counts loops, awaits, throws, try blocks, and mutable bindings', () => {
    const metrics = measureCode(readFixture('syntaxFeatures.js'), { language: 'javascript' });

    expect(metrics.syntaxFeatures).toEqual({
      assignmentCount: 1,
      awaitExpressionCount: 1,
      loopStatementCount: 1,
      mutableBindingCount: 1,
      returnStatementCount: 1,
      throwStatementCount: 2,
      tryStatementCount: 1,
    });
  });
});

describe('measureCode: JSX detection', () => {
  it('flags functions that return JSX', () => {
    const metrics = measureCode(readFixture('sample.tsx'), { language: 'tsx' });

    expect(metrics.functions[0]).toMatchObject({ name: 'Card', returnsJsx: true });
  });

  it('does not flag plain functions as returning JSX', () => {
    const metrics = measureCode(readFixture('callGraph.js'), { language: 'javascript' });

    expect(metrics.functions.every((fn) => !fn.returnsJsx)).toBe(true);
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
    expect(metrics.functionCount).toBe(0);
    expect(metrics.maxCyclomaticComplexity).toBe(0);
    expect(metrics.maxCognitiveComplexity).toBe(0);
    expect(metrics.halstead.length).toBe(0);
    expect(metrics.maintainabilityIndex).toBe(100);
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
