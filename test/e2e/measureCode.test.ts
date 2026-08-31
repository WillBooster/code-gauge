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
  {
    name: 'C#',
    language: 'csharp',
    fixture: 'sample.cs',
    expected: { language: 'csharp', functionNames: ['choose'], maxCognitiveComplexity: 1 },
  },
  {
    name: 'Kotlin',
    language: 'kotlin',
    fixture: 'sample.kt',
    expected: { language: 'kotlin', functionNames: ['choose'], maxCognitiveComplexity: 1 },
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
    // Pinned values: `complex` holds one `if` and one ternary (1 point each); `simple` has none.
    expect(metrics.functions.map((fn) => fn.cognitiveComplexity)).toEqual([0, 2]);
    expect(metrics.maxCognitiveComplexity).toBe(2);
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
    csharp: 'sample.cs',
    go: 'sample.go',
    java: 'sample.java',
    kotlin: 'sample.kt',
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
    // A `?` tail (Rust's `try_expression`, a node kind Kotlin's try shares) counts the same way.
    const fallible = 'fn load(path: &str) -> Result<i32, Error> {\n    let text = read(path)?;\n    parse(&text)?\n}\n';
    expect(measureCode(fallible, { language: 'rust' }).ncssCount).toBe(3);
    // A labeled block (`label`, a node kind Kotlin's `outer@` shares) counts like a labeled
    // statement: fn 1 + label 1 + let 1 + if 1 + break 1 + trailing 0 1 + trailing block 1.
    const labeled =
      "fn f() -> i32 {\n    'outer: {\n        let x = 1;\n        if x > 0 {\n            break 'outer x;\n        }\n        0\n    }\n}\n";
    expect(measureCode(labeled, { language: 'rust' }).ncssCount).toBe(7);
  });

  it('excludes for-header declarations, matching PMD', () => {
    const code = 'class A {\n  void f(int n) {\n    for (int i = 0; i < n; i++) {\n      use(i);\n    }\n  }\n}\n';
    const metrics = measureCode(code, { language: 'java' });
    // class 1 + method 1 + for 1 + call statement 1; `int i = 0` belongs to the for header.
    expect(metrics.ncssCount).toBe(4);
  });

  it('counts Kotlin bodies positionally, including bare else, when entries, and accessors', () => {
    const code = [
      'class K(val x: Int) {',
      '  val y: Int',
      '    get() = x + 1',
      '  var z = 0',
      '    private set',
      '  fun f(a: Int): String {',
      '    if (a > 1) return "big" else if (a > 0) return "small" else return "none"',
      '  }',
      '  fun g(a: Int) = when (a) {',
      '    0 -> "zero"',
      '    else -> "other"',
      '  }',
      '}',
    ].join('\n');
    const metrics = measureCode(code, { language: 'kotlin' });
    // class 1 + val y 1 + getter 1 + its expression 1 + var z 1 (visibility-only setter 0) +
    // fun f 1 + if 1 + return 1 + else 1 + nested if 1 + return 1 + else 1 + return 1 +
    // fun g 1 + when 1 + two entries 2 + two entry bodies 2 = 19.
    expect(metrics.ncssCount).toBe(19);
    expect(metrics.functions.map((fn) => [fn.name, fn.ncss])).toEqual([
      ['y.get', 2],
      ['f', 8],
      ['g', 6],
    ]);
  });

  it('counts C# members, expression bodies, and switch sections like their Java counterparts', () => {
    const code = [
      'class C',
      '{',
      '    public int X { get; set; }',
      '    public int Y => X * 2;',
      '    int F(int a)',
      '    {',
      '        switch (a)',
      '        {',
      '            case 0: return 0;',
      '            default: return a > 1 ? 1 : -1;',
      '        }',
      '    }',
      '}',
    ].join('\n');
    const metrics = measureCode(code, { language: 'csharp' });
    // class 1 + X 1 + get 1 + set 1 + Y 1 + arrow body 1 + F 1 + switch 1 + case 1 + return 1 +
    // default 1 + return 1 = 12; auto-property accessors are not functions, while the
    // expression-bodied property is its own getter. F: switch (+1) and a ternary nested in its
    // section (+2).
    expect(metrics.ncssCount).toBe(12);
    expect(metrics.functions.map((fn) => [fn.name, fn.ncss, fn.cognitiveComplexity])).toEqual([
      ['Y.get', 2, 0],
      ['F', 6, 3],
    ]);
  });

  it('measures C# expression-bodied members and indexer accessors as functions', () => {
    const code = [
      'class A',
      '{',
      '    private int x;',
      '    public int Sum => x > 0 ? (x > 5 ? 1 : 2) : 3;',
      '    public int this[int i] => i > 0 ? 1 : 2;',
      '    public int Ok { get { if (x > 0) return 1; return 0; } }',
      '}',
      'class B',
      '{',
      '    int n;',
      '    public int this[int i] { get { return n + i; } set { n = i + value; } }',
      '}',
    ].join('\n');
    const metrics = measureCode(code, { language: 'csharp' });
    // Sum: ternary (+1) with a nested ternary (+2); the accessor-list property `Ok` is not a
    // function boundary, so its getter's `if` is charged +1, not as a nested function. Block-bodied
    // indexer accessors read the indexer's parameter (and a setter the implicit `value`) without
    // declaring them in their own subtree.
    expect(metrics.functions.map((fn) => [fn.name, fn.cognitiveComplexity, fn.parameterCount, fn.depDegree])).toEqual([
      ['Sum.get', 3, 0, 0],
      ['this.get', 1, 1, 1],
      ['Ok.get', 1, 0, 0],
      ['this.get', 0, 1, 1],
      ['this.set', 0, 1, 2],
    ]);
  });
});

// The same classify() function — a loop holding an if/else-if/else chain with a boolean sequence,
// followed by a three-way switch — is fixtured in every supported language, so the cross-language
// metrics that follow one specification (cognitive complexity, nesting, parameters) must agree
// exactly, and the language-specific ones are pinned per grammar so a catalog omission surfaces.
describe('measureCode: cross-language parity on the shared classify() fixture', () => {
  const parityDir = path.join(fixturesDir, 'parity');
  // for (+1) + if nested once (+2) + `&&` (+1) + `else if` (+1) + else (+1) + switch (+1) = 7.
  const expectedCognitiveComplexity = 7;
  const expectedNestingDepth = 2;
  // NCSS is 17 where `else if` is an else clause plus a nested if (two statements) and 16 where the
  // grammar has a single elif/elsif clause. DepDegree counts 10 def-use pairs (items, limit, and
  // total/item reads) except in C, which reads `items[i]` through an index variable.
  const expectations: Record<string, { extension: string; ncss: number; depDegree: number }> = {
    c: { extension: 'c', ncss: 17, depDegree: 15 },
    cpp: { extension: 'cpp', ncss: 17, depDegree: 10 },
    csharp: { extension: 'cs', ncss: 17, depDegree: 10 },
    go: { extension: 'go', ncss: 17, depDegree: 10 },
    java: { extension: 'java', ncss: 17, depDegree: 10 },
    javascript: { extension: 'js', ncss: 17, depDegree: 10 },
    jsx: { extension: 'jsx', ncss: 17, depDegree: 10 },
    kotlin: { extension: 'kt', ncss: 17, depDegree: 10 },
    python: { extension: 'py', ncss: 16, depDegree: 10 },
    ruby: { extension: 'rb', ncss: 16, depDegree: 10 },
    rust: { extension: 'rs', ncss: 17, depDegree: 10 },
    typescript: { extension: 'ts', ncss: 17, depDegree: 10 },
    tsx: { extension: 'tsx', ncss: 17, depDegree: 10 },
  };

  it('covers every supported language', () => {
    expect(Object.keys(expectations).toSorted()).toEqual([...supportedLanguages].toSorted());
  });

  for (const [language, { extension, ncss, depDegree }] of Object.entries(expectations)) {
    it(`measures classify() identically in ${language}`, () => {
      const code = readFileSync(path.join(parityDir, `parity.${extension}`), 'utf8');
      const metrics = measureCode(code, { language, includeSyntaxTree: true });

      expect(metrics.syntaxTree).not.toMatch(/\((?:ERROR|MISSING)/u);
      expect(metrics.functions).toHaveLength(1);
      expect(metrics.functions[0]).toMatchObject({
        name: 'classify',
        cognitiveComplexity: expectedCognitiveComplexity,
        nestingDepth: expectedNestingDepth,
        parameterCount: 2,
        ncss,
        depDegree,
      });
      expect(metrics.maxCognitiveComplexity).toBe(expectedCognitiveComplexity);
      expect(metrics.cognitiveComplexity).toBe(expectedCognitiveComplexity);
      expect(metrics.nestingDepth).toBe(expectedNestingDepth);
    });
  }
});

// Clone-pair builders for the fingerprinting tests: a C#/Kotlin function whose receiver is named by
// the caller, and a Kotlin function whose infix operator is named by the caller.
const csharpReceiverClone = (receiver: string): string =>
  `class ${receiver}Sink { void Run(int a) { ${receiver}.WriteLine(a); ${receiver}.WriteLine(a + 1); ${receiver}.WriteLine(a + 2); ${receiver}.WriteLine(a + 3); ${receiver}.WriteLine(a + 4); ${receiver}.WriteLine(a + 5); } }\n`;
const kotlinReceiverClone = (receiver: string): string =>
  `fun ${receiver}Run(a: Int) { ${receiver}.log(a); ${receiver}.log(a + 1); ${receiver}.log(a + 2); ${receiver}.log(a + 3); ${receiver}.log(a + 4); ${receiver}.log(a + 5) }\n`;
const kotlinReferenceClone = (receiver: string): string =>
  `fun ${receiver}Run(a: Int) { use(${receiver}::size, a); use(${receiver}::first, a + 1); use(${receiver}::last, a + 2); use(${receiver}::count, a + 3); use(${receiver}::sum, a + 4); use(${receiver}::max, a + 5) }\n`;
const kotlinInfixClone = (name: string, operator: string): string =>
  `fun ${name}(a: Int, b: Int, c: Int, d: Int): Int { val first = a ${operator} b; val second = c ${operator} d; val third = first ${operator} second; val fourth = a ${operator} d; val fifth = b ${operator} c; val sixth = fourth ${operator} fifth; return third ${operator} sixth ${operator} fifth }\n`;

// A Rust function matching on the caller's enum variant, so a copy differing only in the variant
// name can be compared.
const rustVariantClone = (variant: string): string =>
  `fn ${variant}Sum(items: &[Shape]) -> i32 {\n    let mut total = 0;\n    for item in items {\n        match item {\n            Shape::${variant}(a) => total += a,\n            Shape::${variant}(a) if *a > 1 => total -= a,\n            _ => total += 1,\n        }\n    }\n    total\n}\n`;

// A C# data table of 24 equal string values, spelled with the caller's quoting (`"v"` or `@"v"`).
const csharpStringTable = (name: string, quote: (value: string) => string): string =>
  `class ${name} { static string[] Values() { return new[] { ${Array.from({ length: 24 }, (_, index) => quote(`v${index}`)).join(', ')} }; } }\n`;
const ordinaryString = (value: string): string => `"${value}"`;
const verbatimString = (value: string): string => `@"${value}"`;

// A Kotlin function whose accumulator is named by the caller, so a copy renamed to a soft keyword
// (`value`) can be compared against the `count` original.
const kotlinSumClone = (name: string): string =>
  `fun ${name}Sum(items: List<Int>, limit: Int): Int {\n  var ${name} = 0\n  for (item in items) {\n    if (item > limit) {\n      ${name} = ${name} + item\n    } else {\n      ${name} = ${name} - 1\n    }\n  }\n  return ${name} * 2 + limit\n}\n`;

describe('measureCode: grammar-specific token handling', () => {
  it('classifies Kotlin block comments and C# doc comments as comment lines', () => {
    const kotlin = 'package p\n\n/* one\n   two */\nval x = 1 // trailing\n/** doc */\nfun f() = x\n';
    expect(measureCode(kotlin, { language: 'kotlin' }).lines).toEqual({ total: 8, code: 3, comment: 3, blank: 2 });

    const csharp = '/// <summary>Doc</summary>\nclass A\n{\n    /* block */\n    int x; // trailing\n}\n';
    expect(measureCode(csharp, { language: 'csharp' }).lines).toEqual({ total: 7, code: 4, comment: 2, blank: 1 });
  });

  it('binds parameters and pattern variables per grammar without misreading default values', () => {
    // Kotlin default values are siblings of their parameter: `a` in `b: Int = a` is a read (f: a
    // defined, a read, b defined, a and b read = 3), and a file-level name used as a default
    // (`limit`) must not become a function-scope definition (g equals h).
    const kotlin =
      'fun f(a: Int, b: Int = a): Int { return a + b }\n' +
      'fun g(b: Int = limit): Int { return b + limit }\n' +
      'fun h(b: Int): Int { return b + limit }\n';
    expect(measureCode(kotlin, { language: 'kotlin' }).functions.map((fn) => fn.depDegree)).toEqual([3, 1, 1]);
    // A class parameter nests its default inside the parameter node; that default is a read too.
    const classDefault = 'fun f(): Int {\n  class A(val y: Int = unknown)\n  return unknown\n}\n';
    expect(measureCode(classDefault, { language: 'kotlin' }).functions[0]?.depDegree).toBe(0);

    // A C# bare lambda parameter (`implicit_parameter`) is an identifier like a parenthesized one;
    // LINQ range variables (`join y`, `into ys`, `let z`) and pattern designations (`is { } r`)
    // define like declarations.
    const csharp = [
      'class A',
      '{',
      '    void F(int[] xs, object o)',
      '    {',
      '        System.Func<int, int> g = x => x + x;',
      '        System.Func<int, int> h = (y) => y + y;',
      '        var q = from x in xs join y in xs on x equals y into ys let z = x select z;',
      '        if (o is { } r) return r.GetHashCode();',
      '    }',
      '}',
    ].join('\n');
    const metrics = measureCode(csharp, { language: 'csharp' });
    expect(metrics.functions.map((fn) => [fn.name, fn.depDegree])).toEqual([
      // xs (twice), x (`on x`, `let z = x`), y (`equals y`), z (`select z`), o (`o is`), r
      // (`r.GetHashCode`) = 8 reads with a preceding definition, plus the 4 pairs of the two
      // nested lambdas, whose content is attributed to the enclosing function as well.
      ['F', 12],
      ['g', 2],
      ['h', 2],
    ]);
  });

  it('treats Kotlin soft keywords used as names (value, data) as identifiers', () => {
    // Both parameters are read twice; a keyword token in identifier position must still pair up.
    const code = 'fun f(value: Int, data: Int): Int {\n  return value + value + data + data\n}\n';
    expect(measureCode(code, { language: 'kotlin' }).functions[0]?.depDegree).toBe(4);

    // Renaming `count` to `value` must keep the copies clones: identifiers are anonymized alike.
    const metrics = measureCode(kotlinSumClone('count') + kotlinSumClone('value'), {
      language: 'kotlin',
      duplication: { minTokens: 30 },
    });
    expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
  });

  it('names C# and Kotlin members that carry no usable name field', () => {
    const csharp = [
      'class A',
      '{',
      '    int n;',
      '    public int N { get { return n; } set { n = value; } }',
      '    public int this[int i] => i;',
      '    public int Twice => n * 2;',
      '    ~A() { }',
      '    public static A operator +(A a, A b) => a;',
      '    public static implicit operator int(A a) => 1;',
      '    void F() { System.Func<int, int> g = x => x; int Local() => 1; }',
      '}',
    ].join('\n');
    expect(measureCode(csharp, { language: 'csharp' }).functions.map((fn) => fn.name)).toEqual([
      'N.get',
      'N.set',
      'this.get',
      'Twice.get',
      '~A',
      'operator +',
      'operator int',
      'F',
      'g',
      'Local',
    ]);

    const kotlin = [
      'class A(seed: Int) {',
      '  constructor() : this(0)',
      '  val size: Int',
      '    // computed',
      '    get() = 1',
      '  var name = "a"',
      '    set(value) { field = value }',
      '  val f = { x: Int -> x }',
      '  val labeled = tag@ { x: Int, /* second */ y: Int -> x + y }',
      '  fun g() = listOf(1).map { it * 2 }',
      '}',
    ].join('\n');
    const metrics = measureCode(kotlin, { language: 'kotlin' });
    expect(metrics.functions.map((fn) => fn.name)).toEqual([
      'A',
      'size.get',
      'name.set',
      'f',
      'labeled',
      'g',
      undefined,
    ]);
    // The comment inside the lambda's parameter list is not a parameter.
    expect(metrics.functions.find((fn) => fn.name === 'labeled')?.parameterCount).toBe(2);
  });

  it('keeps static receivers and Kotlin infix functions verbatim when fingerprinting clones', () => {
    const exact = { minSimilarityPercent: 100, maxGapTokens: 0 };
    const groups = (code: string, language: string): number =>
      measureCode(code, { language, duplication: exact }).duplication.duplicateBlockGroupCount;
    // Java's PascalCase static-receiver rule: `Console.WriteLine` and `Logger.WriteLine` differ.
    expect(groups(csharpReceiverClone('Console') + csharpReceiverClone('Logger'), 'csharp')).toBe(0);
    expect(groups(kotlinReceiverClone('Console') + kotlinReceiverClone('Logger'), 'kotlin')).toBe(0);
    // Renamed instance receivers still match, including bound callable-reference receivers.
    expect(groups(kotlinReceiverClone('console') + kotlinReceiverClone('logger'), 'kotlin')).toBe(1);
    expect(groups(kotlinReferenceClone('xs') + kotlinReferenceClone('ys'), 'kotlin')).toBe(1);
    expect(groups(kotlinReferenceClone('xs') + kotlinReferenceClone('Registry'), 'kotlin')).toBe(0);
    // An infix function name (`a and b` vs `a or b`) is an API name, like `a.and(b)`.
    expect(groups(kotlinInfixClone('maskAnd', 'and') + kotlinInfixClone('maskOr', 'or'), 'kotlin')).toBe(0);
    expect(groups(kotlinInfixClone('maskAnd', 'and') + kotlinInfixClone('maskBoth', 'and'), 'kotlin')).toBe(1);
  });

  it('counts C# keyword operators (nameof, default) and Kotlin suffixed literals as Halstead tokens', () => {
    const code = [
      'class A',
      '{',
      '    string F(int o) { return nameof(o); }',
      '    int G() { return sizeof(int); }',
      '    string H() { return default(string); }',
      '    string I() { return default; }',
      '    int J(int a) { switch (a) { default: return 0; } }',
      '}',
    ].join('\n');
    // `default:` labels a switch section and is not an operator.
    expect(
      measureCode(code, { language: 'csharp' }).functions.map((fn) => [fn.name, fn.halstead.totalOperators])
    ).toEqual([
      ['F', 2],
      ['G', 2],
      ['H', 2],
      ['I', 2],
      ['J', 1],
    ]);
    // `1`, `1L`, and `1u` are three distinct operands (plus the function name).
    expect(measureCode('fun f() = 1 + 1L + 1u\n', { language: 'kotlin' }).functions[0]?.halstead.distinctOperands).toBe(
      4
    );
  });

  it('reads Kotlin shorthand interpolations and C# implicit accessor bindings as variables', () => {
    // `$x` is a read of the parameter, like `${x}`.
    expect(measureCode('fun f(x: String) = "$x"\n', { language: 'kotlin' }).functions[0]?.depDegree).toBe(1);
    expect(measureCode('fun f(x: String) = "${x}"\n', { language: 'kotlin' }).functions[0]?.depDegree).toBe(1);
    // A bound callable reference (`xs::isEmpty`) reads its receiver; an unbound one (`List::size`)
    // names a type with no definition to pair with.
    expect(
      measureCode('fun f(xs: List<String>) { consume(xs::isEmpty); consume(List::size) }\n', { language: 'kotlin' })
        .functions[0]?.depDegree
    ).toBe(1);

    const csharp = [
      'class A',
      '{',
      '    event System.Action E { add { Use(value); } remove { Drop(value); } }',
      '    int this[params int[] xs] { get { return xs.Length; } }',
      '    int F() { return base.X + this.X; }',
      '}',
    ].join('\n');
    const metrics = measureCode(csharp, { language: 'csharp' });
    expect(metrics.functions.map((fn) => [fn.name, fn.depDegree])).toEqual([
      ['E.add', 1],
      ['E.remove', 1],
      ['this.get', 1],
      ['F', 0],
    ]);
    // `base` is an operand like `this`: `int`, `F`, `base`, `X`, `this`, `X`.
    expect(metrics.functions[3]?.halstead.totalOperands).toBe(6);
  });

  it('keeps anonymizing Rust enum variants and Java module types despite the C# type-field rule', () => {
    // `Alpha(a)` and `Beta(a)` are `tuple_struct_pattern`s with an identifier in a `type` field,
    // renamed like any identifier (the pre-existing Rust behavior).
    const pair = rustVariantClone('Alpha') + rustVariantClone('Beta');
    expect(measureCode(pair, { language: 'rust' }).duplication.duplicateBlockGroupCount).toBe(1);
  });

  it('matches C# verbatim and ordinary string tables with equal values as clones', () => {
    const ordinaryPair = csharpStringTable('A', ordinaryString) + csharpStringTable('B', ordinaryString);
    const mixedPair = csharpStringTable('A', ordinaryString) + csharpStringTable('B', verbatimString);
    expect(measureCode(ordinaryPair, { language: 'csharp' }).duplication.duplicateBlockGroupCount).toBe(1);
    expect(measureCode(mixedPair, { language: 'csharp' }).duplication.duplicateBlockGroupCount).toBe(1);
  });

  it('charges C# pattern combinators like boolean operator sequences', () => {
    // if (+1) + `and` sequence (+1); `and ... or` is two sequences (+2).
    const code =
      'class A { bool F(object o) { if (o is > 0 and <= 10) return true; return o is < 500 and > 300 or 1; } }';
    expect(measureCode(code, { language: 'csharp' }).functions[0]?.cognitiveComplexity).toBe(4);
  });

  it('follows the SonarSource model for Kotlin when, else-if chains, and labeled jumps', () => {
    // when (+1) + nested if (+2) + else (+1) per entry twice, else-if chain flat (+1 each).
    const when =
      'fun d(v: Any?): String = when (v) {\n  is Int -> {\n    if (v > 1) "big" else "small"\n  }\n  is String -> {\n    if (v.isBlank()) "blank" else "str"\n  }\n  else -> "other"\n}\n';
    expect(measureCode(when, { language: 'kotlin' }).functions[0]?.cognitiveComplexity).toBe(7);

    const chain = 'fun f(a: Int): Int {\n  if (a > 2) return 2 else if (a > 1) return 1 else return 0\n}\n';
    expect(measureCode(chain, { language: 'kotlin' }).functions[0]?.cognitiveComplexity).toBe(3);

    // for (+1) + nested for (+2) + nested if (+3) + break@outer (+1) = 7.
    const labeled =
      'fun f(xs: List<Int>) {\n  outer@ for (x in xs) {\n    for (y in xs) {\n      if (x == y) break@outer\n    }\n  }\n}\n';
    expect(measureCode(labeled, { language: 'kotlin' }).functions[0]?.cognitiveComplexity).toBe(7);
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
      { alias: 'cs', code: 'class A { int Run() { return 1; } }', expectedLanguage: 'csharp' },
      { alias: 'kt', code: 'fun run() = 1', expectedLanguage: 'kotlin' },
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
      'csharp',
      'kotlin',
    ]);
  });
});

describe('per-function Halstead and DepDegree', () => {
  const tsCode = `export function total(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    sum += item;
  }
  return sum;
}
`;

  it('measures the function subtree, matching the file-level Halstead for a single-function file', () => {
    const metrics = measureCode(tsCode, { language: 'typescript' });
    expect(metrics.functions[0]?.halstead).toStrictEqual(metrics.halstead);
    expect(metrics.functions[0]?.halstead.vocabulary).toBe(9);
    expect(metrics.functions[0]?.halstead.length).toBe(14);
  });

  it('counts def-use pairs: parameters and declarations define, later reads pair up', () => {
    // Defs: items (parameter), sum (`let sum = 0`), item (for-of binding).
    // Uses with a preceding def: items, sum (compound assignment reads it), item, sum (return).
    expect(measureCode(tsCode, { language: 'typescript' }).functions[0]?.depDegree).toBe(4);
  });

  it('does not pair reads that precede the definition', () => {
    // `y` is read before `const y = x` defines it: only x (in the initializer), y and x (in the
    // return) have a preceding definition.
    const code = 'function g(x) { y; const y = x; return y + x; }';
    expect(measureCode(code, { language: 'javascript' }).functions[0]?.depDegree).toBe(3);
  });

  it('recognizes annotated definitions and loop bindings across languages', () => {
    // Semantically identical code: defs items/factor (parameters), total_sum, item (loop binding),
    // scaled (annotated assignment); uses items, total_sum (+=), item, factor, total_sum, scaled,
    // total_sum -> 7 pairs in each language.
    const python =
      'def total(items, factor):\n' +
      '    total_sum = 0\n' +
      '    for item in items:\n' +
      '        total_sum += item * factor\n' +
      '    scaled: int = total_sum * 2\n' +
      '    return scaled + total_sum\n';
    expect(measureCode(python, { language: 'python' }).functions[0]?.depDegree).toBe(7);

    const go =
      'package main\n' +
      'func total(items []int, factor int) int {\n' +
      '\tsum := 0\n' +
      '\tfor _, item := range items {\n' +
      '\t\tsum += item * factor\n' +
      '\t}\n' +
      '\tvar scaled int = sum * 2\n' +
      '\treturn scaled + sum\n' +
      '}\n';
    expect(measureCode(go, { language: 'go' }).functions[0]?.depDegree).toBe(7);

    const rust =
      'fn total(items: &[i64], factor: i64) -> i64 {\n' +
      '    let mut sum: i64 = 0;\n' +
      '    for item in items {\n' +
      '        sum += item * factor;\n' +
      '    }\n' +
      '    let scaled = sum * 2;\n' +
      '    scaled + sum\n' +
      '}\n';
    expect(measureCode(rust, { language: 'rust' }).functions[0]?.depDegree).toBe(7);
  });
});
