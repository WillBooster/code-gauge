import { describe, expect, it } from 'vitest';
import {
  TreeMeasurer,
  collectCrossFileDuplicationFileData,
  collectFunctionTokenSequences,
  defaultLanguages,
  measureCode,
  supportedLanguages,
  type FunctionMetrics,
} from '../../src/index.js';

// Rule-by-rule matrices over small snippets, one per metric: each case names the rule it pins
// (SonarSource cognitive complexity, nesting depth, parameter binding, DepDegree def-use pairs,
// Halstead operator/operand classification, line classification) so a regression reports the
// rule and language that broke instead of a changed aggregate.

function functionsOf(language: string, code: string): FunctionMetrics[] {
  return measureCode(code, { language }).functions;
}

function cognitiveOf(language: string, code: string): number[] {
  return functionsOf(language, code).map((fn) => fn.cognitiveComplexity);
}

describe('cognitive complexity: nesting increments across function boundaries', () => {
  it('charges decisions inside a nested callback one level deeper for the enclosing function', () => {
    // Sonar: a nested function adds a nesting level; the callback itself starts at nesting 0.
    expect(cognitiveOf('javascript', 'function f(xs){ xs.forEach(x => { if (x) y(); }); }')).toEqual([2, 1]);
    expect(cognitiveOf('javascript', 'function f(xs){ xs.forEach(x => { if (x) { if (y) {} } }); }')).toEqual([5, 3]);
    // Same rule for Kotlin trailing lambdas and Ruby blocks.
    expect(cognitiveOf('kotlin', 'fun f(xs: List<Int>) { xs.forEach { if (it > 0) return@forEach } }')).toEqual([2, 1]);
    expect(cognitiveOf('ruby', 'def f(a)\n  loop do\n    break if a\n  end\nend\n')).toEqual([2, 1]);
  });

  it('charges a class body nested in a function once, not once per method it holds', () => {
    // PMD charges the local/anonymous class body: the method inside skips the function bonus.
    expect(cognitiveOf('javascript', 'function f(){ return class { m(){ if (a) {} } }; }')).toEqual([2, 1]);
    expect(
      cognitiveOf('java', 'class A { void f() { Runnable r = new Runnable() { public void run() { if (a) b(); } }; } }')
    ).toEqual([2, 1]);
  });

  it('hoists flat increments of nested functions unchanged', () => {
    // A boolean sequence inside the lambda is flat (+1) for both the lambda and its parent.
    expect(
      cognitiveOf('cpp', 'int f(int a, int b) { auto g = [&](int c) { return a && b && c; }; return g(1); }')
    ).toEqual([1, 1]);
  });
});

describe('cognitive complexity: language-specific decision constructs', () => {
  it('does not charge nullish coalescing, optional chaining, elvis, or safe calls', () => {
    expect(cognitiveOf('javascript', 'function f(a,b){ return a?.b ?? b; }')).toEqual([0]);
    expect(cognitiveOf('kotlin', 'fun f(a: String?): Int { return a?.length ?: 0 }')).toEqual([0]);
    expect(cognitiveOf('csharp', 'class A { int F(int? a, int b) { return a ?? b; } }')).toEqual([0]);
  });

  it('charges labeled jumps and goto one flat point per language', () => {
    // for +1, nested for +2, if +3, labeled continue/break +1.
    const labeled = 7;
    expect(
      cognitiveOf(
        'javascript',
        'function f(a){ outer: for (const x of a) { for (const y of a) { if (x === y) break outer; } } }'
      )
    ).toEqual([labeled]);
    expect(
      cognitiveOf(
        'java',
        'class A { void f(int[] xs) { outer: for (int x : xs) { for (int y : xs) { if (x == y) continue outer; } } } }'
      )
    ).toEqual([labeled]);
    expect(
      cognitiveOf('rust', "fn f(a: i32) { 'outer: for x in 0..a { for y in 0..a { if x == y { continue 'outer; } } } }")
    ).toEqual([labeled]);
    expect(
      cognitiveOf(
        'go',
        'package p\nfunc f(a int) {\nouter:\n\tfor i := 0; i < a; i++ {\n\t\tfor j := 0; j < a; j++ {\n\t\t\tif i == j {\n\t\t\t\tbreak outer\n\t\t\t}\n\t\t}\n\t}\n}\n'
      )
    ).toEqual([labeled]);
    // if +1, goto +1; an unlabeled break/continue costs nothing.
    expect(cognitiveOf('c', 'int f(int a) { if (a) goto done; a = 1; done: return a; }')).toEqual([2]);
    expect(cognitiveOf('csharp', 'class A { int F(int a) { if (a > 0) goto done; done: return a; } }')).toEqual([2]);
    expect(cognitiveOf('javascript', 'function f(a){ for (const x of a) { if (x) break; } }')).toEqual([3]);
  });

  it('charges switch-like constructs once, guards once, and default arms never', () => {
    expect(
      cognitiveOf(
        'python',
        'def f(x):\n    match x:\n        case 1:\n            return 1\n        case y if y > 2:\n            return 2\n        case _:\n            return 3\n'
      )
    ).toEqual([2]);
    expect(cognitiveOf('rust', 'fn f(a: i32) -> i32 { match a { 0 => 1, x if x > 5 => 2, _ => 3 } }')).toEqual([2]);
    expect(
      cognitiveOf(
        'ruby',
        'def f(a)\n  case a\n  in Integer => n if n > 1\n    1\n  in [x, *]\n    2\n  in y\n    3\n  end\nend\n'
      )
    ).toEqual([2]);
    expect(
      cognitiveOf('ruby', 'def f(a)\n  case a\n  when 1 then 1\n  when 2, 3 then 2\n  else 3\n  end\nend\n')
    ).toEqual([1]);
    expect(
      cognitiveOf('csharp', 'class A { int F(object o) => o switch { int n when n > 0 => 1, string => 2, _ => 3 }; }')
    ).toEqual([2]);
    expect(cognitiveOf('kotlin', 'fun f(a: Int): Int { return when { a > 0 -> 1; a < 0 -> 2; else -> 3 } }')).toEqual([
      1,
    ]);
    expect(
      cognitiveOf(
        'go',
        'package p\nfunc f(v interface{}) int {\n\tswitch x := v.(type) {\n\tcase int:\n\t\treturn x\n\tdefault:\n\t\treturn 0\n\t}\n}\n'
      )
    ).toEqual([1]);
    expect(
      cognitiveOf(
        'go',
        'package p\nfunc f(ch chan int) int {\n\tselect {\n\tcase v := <-ch:\n\t\treturn v\n\tdefault:\n\t\treturn 0\n\t}\n}\n'
      )
    ).toEqual([1]);
  });

  it('charges each catch/except/rescue clause but not try, finally, or exception filters', () => {
    expect(
      cognitiveOf(
        'python',
        'def f(x):\n    try:\n        g()\n    except ValueError:\n        pass\n    except (TypeError, KeyError) as e:\n        raise\n    finally:\n        h()\n'
      )
    ).toEqual([2]);
    expect(
      cognitiveOf(
        'kotlin',
        'fun f(a: Int): Int { return try { g(a) } catch (e: IllegalStateException) { 1 } catch (e: Exception) { 2 } finally { h() } }'
      )
    ).toEqual([2]);
    expect(
      cognitiveOf(
        'csharp',
        'class A { int F(object o) { try { return 1; } catch (Exception e) when (e.Message != null) { return 2; } } }'
      )
    ).toEqual([1]);
    expect(
      cognitiveOf(
        'java',
        'class A { int f(Object o) { try (var r = open()) { return 1; } catch (IOException | RuntimeException e) { return 2; } } }'
      )
    ).toEqual([1]);
    expect(
      cognitiveOf(
        'cpp',
        'int f() { try { g(); } catch (const E& e) { return 1; } catch (...) { return 2; } return 0; }'
      )
    ).toEqual([2]);
  });

  it('charges every loop form once, plus nested-loop surcharges', () => {
    // for-in +1, while +2, do-while +3.
    expect(
      cognitiveOf('javascript', 'function f(a){ for (const k in a) { while (a) { do { } while (b); } } }')
    ).toEqual([6]);
    expect(
      cognitiveOf('rust', 'fn f(mut a: Vec<i32>) { while let Some(x) = a.pop() { if x > 0 { break; } } }')
    ).toEqual([3]);
    expect(cognitiveOf('rust', 'fn f(a: i32) -> i32 { loop { if a > 0 { break a; } } }')).toEqual([3]);
    expect(
      cognitiveOf(
        'ruby',
        'def f(a)\n  until a\n    a = 1\n  end\n  while a do a = 2 end\n  for x in [1] do a = 3 end\nend\n'
      )
    ).toEqual([3]);
    expect(
      cognitiveOf(
        'csharp',
        'class A { int F(int a) { do { a--; } while (a > 0); foreach (var x in xs) { } return a; } }'
      )
    ).toEqual([2]);
    expect(cognitiveOf('kotlin', 'fun f(a: Int): Int { do { g() } while (a > 0); return a }')).toEqual([1]);
    expect(cognitiveOf('cpp', 'int f(const std::vector<int>& xs) { for (int x : xs) { } return 0; }')).toEqual([1]);
  });

  it('charges Ruby statement modifiers and rescue modifiers as decisions', () => {
    // if-modifier, unless-modifier, until, rescue-modifier, ternary: one each.
    expect(
      cognitiveOf(
        'ruby',
        'def f(a)\n  g if a\n  h unless a\n  until a\n    a = 1\n  end\n  x rescue y\n  a ? 1 : 2\nend\n'
      )
    ).toEqual([5]);
    expect(cognitiveOf('ruby', 'def f(a)\n  unless a\n    1\n  else\n    2\n  end\nend\n')).toEqual([2]);
  });

  it('charges Python loop else clauses, conditional expressions, and boolean sequences', () => {
    expect(
      cognitiveOf(
        'python',
        'def f(xs):\n    while xs:\n        break\n    else:\n        pass\n    for x in xs:\n        continue\n    else:\n        pass\n'
      )
    ).toEqual([4]);
    expect(cognitiveOf('python', 'def f(a):\n    return 1 if a else 2\n')).toEqual([1]);
    // A comprehension filter is an expression, not a statement-level decision; a `case` guard is.
    expect(cognitiveOf('python', 'def f(xs):\n    return [x for x in xs if x]\n')).toEqual([0]);
    expect(cognitiveOf('python', 'def f(xs):\n    match xs:\n        case [x] if x:\n            return x\n')).toEqual([
      2,
    ]);
    expect(cognitiveOf('python', 'def f(a, b, c):\n    return a and b or c\n')).toEqual([2]);
    expect(cognitiveOf('python', 'def f(a, b, c):\n    return not a and not b and not c\n')).toEqual([1]);
  });

  it('keeps one sequence across mixed C++ alternative operator spellings, ignoring non-boolean uses', () => {
    // `and` and `&&` are the same operator; `or` starts a second sequence.
    expect(
      cognitiveOf('cpp', 'bool f(bool a, bool b, bool c) { if (a and b && c) return true; return a or b; }')
    ).toEqual([3]);
    // Rvalue references and an overloaded `operator&&` are not boolean operators.
    expect(cognitiveOf('cpp', 'void f(int&& x) { int a = x; }')).toEqual([0]);
    expect(cognitiveOf('cpp', 'struct S { bool operator&&(const S&) const { return true; } };')).toEqual([0]);
    // Rust's empty closure parameter list `||` is not a boolean operator either.
    expect(cognitiveOf('rust', 'fn f() -> i32 { let g = || 5; g() }')).toEqual([0, 0]);
  });

  it('charges JSX logical-and rendering and ternaries as boolean sequences and decisions', () => {
    expect(cognitiveOf('jsx', 'function C({a}){ return <p>{a && <b/>}</p>; }')).toEqual([1]);
    expect(cognitiveOf('tsx', 'function C({a}: {a: number}){ return <p>{a > 0 ? <b/> : null}</p>; }')).toEqual([1]);
  });

  it('charges Rust and Kotlin if-else expressions like statements (else adds one flat point)', () => {
    expect(cognitiveOf('rust', 'fn f(a: Option<i32>) -> i32 { if let Some(x) = a { x } else { 0 } }')).toEqual([2]);
    expect(cognitiveOf('rust', 'fn f(a: i32) -> i32 { if a > 0 { 1 } else if a < 0 { 2 } else { 3 } }')).toEqual([3]);
    expect(cognitiveOf('kotlin', 'fun f(n: Int): Int = if (n <= 1) n else f(n - 1)')).toEqual([2]);
  });
});

describe('nesting depth', () => {
  const nestingOf = (language: string, code: string): number[] =>
    functionsOf(language, code).map((fn) => fn.nestingDepth);

  it('counts one level per nesting construct, with switch cases nesting under the switch', () => {
    // if (1) -> case (2) -> if (3).
    expect(nestingOf('javascript', 'function f(a,b){ if (a) { switch (b) { case 1: if (c) {} } } }')).toEqual([3]);
    expect(
      nestingOf(
        'java',
        'class A { void f(int a) { if (a > 0) { switch (a) { case 1: if (b) {} break; default: c(); } } } }'
      )
    ).toEqual([3]);
    // A ternary nests its branches too: if (1) -> ternary (2).
    expect(nestingOf('c', 'int f(int a) { return a > 0 ? (a > 5 ? 2 : 1) : 0; }')).toEqual([2]);
  });

  it('does not deepen else-if chains', () => {
    expect(nestingOf('javascript', 'function f(a,b,c){ if (a) {} else if (b) {} else if (c) {} }')).toEqual([1]);
    expect(
      nestingOf(
        'python',
        'def f(a):\n    if a:\n        pass\n    elif a > 1:\n        pass\n    else:\n        pass\n'
      )
    ).toEqual([1]);
    expect(nestingOf('ruby', 'def f(a)\n  if a\n    1\n  elsif a > 1\n    2\n  else\n    3\n  end\nend\n')).toEqual([
      1,
    ]);
  });

  it('describes the own body only: nested function content belongs to the nested function', () => {
    const metrics = measureCode('function f(xs){ xs.forEach(x => { if (x) { if (y) {} } }); }', {
      language: 'javascript',
    });
    expect(metrics.functions.map((fn) => fn.nestingDepth)).toEqual([0, 2]);
    // The file-level depth counts every node once, top-level code included.
    expect(metrics.nestingDepth).toBe(2);
    expect(measureCode('for (const x of xs) { if (x) { y(); } }', { language: 'javascript' })).toMatchObject({
      functions: [],
      nestingDepth: 2,
    });
  });
});

describe('parameter counts', () => {
  const parametersOf = (language: string, code: string): [string | undefined, number][] =>
    functionsOf(language, code).map((fn) => [fn.name, fn.parameterCount]);

  it('counts JavaScript/TypeScript defaults, rest, destructuring, bare arrows, and parameter properties', () => {
    expect(
      parametersOf(
        'javascript',
        'function f(a, b = 1, ...rest) {}\nconst g = ({x, y}, [z]) => x;\nconst h = x => x;\nclass K { m(a, b) {} static s() {} get v() { return 1; } set v(w) {} }'
      )
    ).toEqual([
      ['f', 3],
      ['g', 2],
      ['h', 1],
      ['m', 2],
      ['s', 0],
      ['v', 0],
      ['v', 1],
    ]);
    expect(
      parametersOf(
        'typescript',
        'function f(a?: number, b: string = "x", ...rest: number[]): void {}\nclass K { constructor(private a: number, readonly b?: string) {} }'
      )
    ).toEqual([
      ['f', 3],
      ['constructor', 2],
    ]);
  });

  it('counts Python self, star parameters, and keyword-only parameters but not `/` and `*` markers', () => {
    expect(
      parametersOf(
        'python',
        'def f(a, /, b, *, c=1, **kw): pass\ndef g(*args, **kwargs): pass\nclass K:\n    def m(self, a): pass\n    @staticmethod\n    def s(): pass\nlam = lambda x, y=2: x'
      )
    ).toEqual([
      ['f', 4],
      ['g', 2],
      ['m', 2],
      ['s', 0],
      ['lam', 2],
    ]);
  });

  it('counts each Go name of a grouped declaration and variadics, not receivers or results', () => {
    expect(
      parametersOf(
        'go',
        'package p\nfunc f(a, b int, c string, d ...int) {}\nfunc (r *R) m(x int) {}\nfunc g() (int, error) { return 0, nil }\nvar h = func(a int) int { return a }'
      )
    ).toEqual([
      ['f', 4],
      ['m', 1],
      ['g', 0],
      ['h', 1],
    ]);
  });

  it('excludes Rust self parameters and counts closure parameters', () => {
    expect(
      parametersOf(
        'rust',
        'fn f(a: i32, b: &str) {}\nimpl S { fn m(&self, x: i32) {} fn n(self) {} fn s() {} }\nfn g() { let c = |a: i32, b: i32| a + b; let d = || 1; }'
      )
    ).toEqual([
      ['f', 2],
      ['m', 1],
      ['n', 0],
      ['s', 0],
      ['g', 0],
      ['c', 2],
      ['d', 0],
    ]);
  });

  it('excludes Java explicit receivers and counts varargs and lambda forms', () => {
    expect(
      parametersOf(
        'java',
        'class A { A(int x) {} void f(int a, String... rest) {} void g(A this, int b) {} Runnable r = () -> {}; java.util.function.Function<Integer,Integer> h = x -> x; java.util.function.BiFunction<Integer,Integer,Integer> k = (a, b) -> a + b; }'
      )
    ).toEqual([
      ['A', 1],
      ['f', 2],
      ['g', 1],
      ['r', 0],
      ['h', 1],
      ['k', 2],
    ]);
  });

  it('counts Ruby optional, splat, keyword, and forwarded parameters but not block parameters or block-locals', () => {
    expect(
      parametersOf(
        'ruby',
        'def f(a, b = 1, *rest, key:, opt: 2, **kw, &blk); end\ndef self.s(x); end\nl = ->(a, b) { a }\nm = lambda { |x| x }\n[1].each { |v; memo| v }\n[1].each do |a, (b, c)| a end\ndef g(...) = h(...)'
      )
    ).toEqual([
      ['f', 6],
      ['s', 1],
      ['l', 2],
      ['m', 1],
      [undefined, 1],
      [undefined, 2],
      ['g', 1],
    ]);
  });

  it('treats C `(void)` as empty and counts function-pointer, array, and variadic parameters', () => {
    expect(
      parametersOf(
        'c',
        'int f(void) { return 0; }\nint g(int a, char *b, int (*cb)(int), int arr[]) { return 0; }\nint h(int a, ...) { return 0; }\nint k() { return 0; }'
      )
    ).toEqual([
      ['f', 0],
      ['g', 4],
      ['h', 2],
      ['k', 0],
    ]);
  });

  it('counts C++ unnamed, defaulted, reference, and lambda parameters and names special members', () => {
    expect(
      parametersOf(
        'cpp',
        'int f(int a, const std::string& b, int&& c) { return 0; }\nvoid g(int, double = 1.0) {}\nauto l = [](int x, int y) { return x + y; };\nstruct S { S(int a) : a_(a) {} ~S() {} S& operator=(const S& o) { return *this; } operator int() const { return 1; } int a_; };\nint S2::method(int q) { return q; }\ntemplate <typename T> T id(T v) { return v; }'
      )
    ).toEqual([
      ['f', 3],
      ['g', 2],
      ['l', 2],
      ['S', 1],
      ['~S', 0],
      ['operator=', 1],
      ['operator int', 0],
      ['method', 1],
      ['id', 1],
    ]);
  });

  it('counts C# params arrays, ref/out/in modifiers, and delegate forms', () => {
    expect(
      parametersOf(
        'csharp',
        'class A { A(int x) {} void F(int a, string b = "x", params int[] rest) {} void G(ref int a, out int b, in int c) { b = 0; } Func<int,int,int> h = (a, b) => a + b; Action<int> k = delegate (int z) { }; }'
      )
    ).toEqual([
      ['A', 1],
      ['F', 3],
      ['G', 3],
      ['h', 2],
      ['k', 1],
    ]);
  });

  it('counts Kotlin defaults and varargs, lambda and anonymous-function parameters, and extension receivers as none', () => {
    expect(
      parametersOf(
        'kotlin',
        'fun f(a: Int, b: String = "x", vararg rest: Int) {}\nclass K(val a: Int, b: String) {\n  constructor(a: Int) : this(a, "") {}\n  fun m(x: Int) = x\n}\nval l = { a: Int, b: Int -> a + b }\nval n = fun(a: Int): Int = a\nfun String.ext(times: Int) = repeat(times)'
      )
    ).toEqual([
      ['f', 3],
      ['K', 1],
      ['m', 1],
      ['l', 2],
      ['n', 1],
      ['ext', 1],
    ]);
  });
});

describe('function names from binding sites', () => {
  it('names object-literal properties and assignment targets, leaving computed keys and subscripts anonymous', () => {
    expect(
      functionsOf(
        'javascript',
        'const o = { run: () => 1, "quoted": function () {}, [k]: () => 2 };\nobj.run = () => 3;\nplain = () => 4;\na.b.c = function () {};\no["s"] = () => 5;'
      ).map((fn) => fn.name)
    ).toEqual(['run', 'quoted', undefined, 'run', 'plain', 'c', undefined]);
    // A numeric key names its value; Python and Ruby spell the same key as integer/float nodes.
    expect(functionsOf('javascript', 'const o = { 1: () => 1, 2.5: function () {} };').map((fn) => fn.name)).toEqual([
      '1',
      '2.5',
    ]);
    expect(functionsOf('ruby', 'h = { 1 => -> { 1 } }\n').map((fn) => fn.name)).toEqual(['1']);
    expect(functionsOf('python', 'd = {1: lambda: 1}\n').map((fn) => fn.name)).toEqual(['1']);
    // A class field is named like an object-literal key: computed stays anonymous, quoted is read
    // without its quotes, and a private name is kept as written.
    expect(
      functionsOf('javascript', 'class A { [key] = () => 1; "s" = () => 2; #p = () => 3; plain = () => 4; }').map(
        (fn) => fn.name
      )
    ).toEqual([undefined, 's', '#p', 'plain']);
    expect(
      functionsOf('typescript', 'class A { [key] = (() => 1) as Fn; plain = (() => 2) as Fn; }').map((fn) => fn.name)
    ).toEqual([undefined, 'plain']);
    // A string key keeps its escapes as written; an empty key names nothing.
    expect(
      functionsOf('javascript', String.raw`const o = { 'user\'s': () => {}, 'a\nb': () => {}, '': () => {} };`).map(
        (fn) => fn.name
      )
    ).toEqual([String.raw`user\'s`, String.raw`a\nb`, undefined]);
    expect(
      functionsOf('csharp', 'class A { void F() { this.Run = () => 1; run = x => x; } }').map((fn) => fn.name)
    ).toEqual(['F', 'Run', 'run']);
    expect(
      functionsOf('java', 'class A { void f() { this.run = () -> 1; run = () -> 2; } }').map((fn) => fn.name)
    ).toEqual(['f', 'run', 'run']);
  });

  it('names Go, Kotlin, Ruby, Python, Rust, and C++ functions bound to variables, members, fields, and qualified names', () => {
    expect(
      functionsOf('go', 'package p\nfunc f() { run = func() {}; a, _ = func() {}, func() {}; m.run = func() {} }').map(
        (fn) => fn.name
      )
    ).toEqual(['f', 'run', 'a', undefined, 'run']);
    expect(
      functionsOf('kotlin', 'fun f() { run = { 1 }; obj.run = { 2 }; arr[0] = { 3 }; obj.arr[0] = { 4 } }').map(
        (fn) => fn.name
      )
    ).toEqual(['f', 'run', 'run', undefined, undefined]);
    expect(
      functionsOf('ruby', 'self.run = -> { 1 }\nobj.run = lambda { 1 }\n@handler = -> { 2 }\n').map((fn) => fn.name)
    ).toEqual(['run', 'run', '@handler']);
    // A parallel assignment binds each value to the target at the same position.
    expect(
      functionsOf('ruby', 'run, stop = -> { 1 }, lambda { 2 }\nkeep, obj.drop = -> { 3 }, -> { 4 }\n').map(
        (fn) => fn.name
      )
    ).toEqual(['run', 'stop', 'keep', undefined]);
    expect(
      functionsOf('python', 'run, stop = (lambda: 1), lambda: 2\nkeep, d["k"] = lambda: 3, lambda: 4\n').map(
        (fn) => fn.name
      )
    ).toEqual(['run', 'stop', 'keep', undefined]);
    // A splat expands at run time, so positions after it bind nothing knowable here.
    expect(functionsOf('ruby', 'a, b = *xs, -> { 1 }\nc, *d = -> { 2 }, -> { 3 }\n').map((fn) => fn.name)).toEqual([
      undefined,
      'c',
      undefined,
    ]);
    expect(functionsOf('python', 'a, b = *xs, lambda: 1\nc, *d = lambda: 2, lambda: 3\n').map((fn) => fn.name)).toEqual(
      [undefined, 'c', undefined]
    );
    expect(
      functionsOf('ruby', 'h = { run: -> { 1 }, :sym => -> { 2 }, "str" => lambda { 3 }, "k#{x}" => -> { 4 } }\n').map(
        (fn) => fn.name
      )
    ).toEqual(['run', 'sym', 'str', undefined]);
    expect(
      functionsOf(
        'ruby',
        'h = { :"quoted" => -> { 1 }, :"q#{x}" => -> { 2 }, %q(pct) => -> { 3 }, "" => -> { 4 } }\n'
      ).map((fn) => fn.name)
    ).toEqual(['quoted', undefined, 'pct', undefined]);
    // Grouping parentheses are transparent, but `(a; b)` binds its last statement to nothing.
    expect(
      functionsOf('ruby', 'h = { run: (lambda { 1 }) }\nrun = (lambda { 2 })\nx = (-> { 3 })\ny = (a; -> { 4 })\n').map(
        (fn) => fn.name
      )
    ).toEqual(['run', 'run', 'x', undefined]);
    expect(functionsOf('cpp', 'void f() { N::run = []() {}; }').map((fn) => fn.name)).toEqual(['f', 'run']);
    // A C++ variable initialized directly binds the lambda as an assignment would.
    expect(
      functionsOf('cpp', 'void f() { std::function<void()> run([]{}); std::function<void()> go{[]{}}; }').map(
        (fn) => fn.name
      )
    ).toEqual(['f', 'run', 'go']);
    // A compound assignment does not bind its target to the function (C# event subscription).
    expect(
      functionsOf('csharp', 'class A { void F() { Changed += () => 1; Handler = () => 2; } }').map((fn) => fn.name)
    ).toEqual(['F', undefined, 'Handler']);
    expect(functionsOf('kotlin', 'fun f() { run += { 1 } }').map((fn) => fn.name)).toEqual(['f', undefined]);
    // A Go keyed composite-literal element names its value; an unkeyed one has no key to use.
    expect(
      functionsOf(
        'go',
        'package p\ntype S struct { run func() }\nfunc f() { _ = S{run: func() {}}; _ = map[string]func(){"go": func() {}}; _ = []func(){func() {}} }'
      ).map((fn) => fn.name)
    ).toEqual(['f', 'run', 'go', undefined]);
    expect(functionsOf('go', 'package p\nfunc f() { run += func() {}; ok = func() {} }').map((fn) => fn.name)).toEqual([
      'f',
      undefined,
      'ok',
    ]);
    expect(functionsOf('rust', 'fn f() { let s = S { cb: |x| x }; s.cb = |y| y; }').map((fn) => fn.name)).toEqual([
      'f',
      'cb',
      'cb',
    ]);
    expect(
      functionsOf('python', 'def f():\n    obj.run = lambda: 1\n    self.a.b = lambda: 2\n    run = lambda: 3\n').map(
        (fn) => fn.name
      )
    ).toEqual(['f', 'run', 'b', 'run']);
    // Delimiters and prefixes never leak into the name; an f-string key is not stable.
    expect(
      functionsOf(
        'python',
        'd = { """t""": lambda: 1, r"raw": lambda: 2, f"x{y}": lambda: 3, "a\\nb": lambda: 4 }\n'
      ).map((fn) => fn.name)
    ).toEqual(['t', 'raw', undefined, String.raw`a\nb`]);
    // Adjacent Python literals form one key; an interpolated part makes it unstable.
    expect(functionsOf('python', 'd = {"run" "ner": lambda: 1, "a" f"{x}": lambda: 2}\n').map((fn) => fn.name)).toEqual(
      ['runner', undefined]
    );
  });

  it('looks through grouping parentheses and TypeScript type wrappers to the binding site', () => {
    expect(
      functionsOf(
        'typescript',
        'const o = { run: (() => 1), typed: (() => 2) as () => number, sat: (() => 3) satisfies Fn };\nobj.run = (() => 4)!;\nconst v = (() => 5) as Fn;'
      ).map((fn) => fn.name)
    ).toEqual(['run', 'typed', 'sat', 'run', 'v']);
    // Angle-bracket assertions wrap the value after the type; a Rust cast wraps it directly.
    expect(
      functionsOf(
        'typescript',
        'const o = { run: <() => number>(() => 1) };\nobj.handle = <Fn>(() => 2);\nconst v = <Fn>(() => 3);'
      ).map((fn) => fn.name)
    ).toEqual(['run', 'handle', 'v']);
    expect(functionsOf('rust', 'fn f() { let cb = (|x| x) as fn(i32) -> i32; }').map((fn) => fn.name)).toEqual([
      'f',
      'cb',
    ]);
    // A comment inside the wrapper is a named child, but not the wrapped value.
    expect(
      functionsOf(
        'javascript',
        'const run = (/* why */ () => 1);\nconst o = { go: (/* why */ function () {}) };\nobj.cb = (/* why */ () => 2);'
      ).map((fn) => fn.name)
    ).toEqual(['run', 'go', 'cb']);
    expect(functionsOf('ruby', 'run = (# why\nlambda { 1 })\n').map((fn) => fn.name)).toEqual(['run']);
    // A cast to a functional interface leaves the same function value bound to the same name.
    expect(
      functionsOf('java', 'class A { void m() { Runnable r = (Runnable) () -> 1; } }').map((fn) => fn.name)
    ).toEqual(['m', 'r']);
    expect(
      functionsOf('csharp', 'class A { void M() { System.Action a = (System.Action)(() => 1); } }').map((fn) => fn.name)
    ).toEqual(['M', 'a']);
    // An immediately invoked lambda is a receiver, not a bound value, so it takes no name.
    expect(functionsOf('java', 'class A { void m() { ((Runnable) () -> 1).run(); } }').map((fn) => fn.name)).toEqual([
      'm',
      undefined,
    ]);
    expect(
      functionsOf('csharp', 'class A { void M() { ((System.Action)(() => 1)).Invoke(); } }').map((fn) => fn.name)
    ).toEqual(['M', undefined]);
    expect(
      functionsOf('go', 'package p\nfunc f() { run = (func() {}); x := (func() {}) }').map((fn) => fn.name)
    ).toEqual(['f', 'run', 'x']);
  });
});

describe('DepDegree across languages', () => {
  const depDegreeOf = (language: string, code: string): number[] =>
    functionsOf(language, code).map((fn) => fn.depDegree);

  it('pairs reads inside nested closures with outer definitions, but not outer reads with inner definitions', () => {
    // xs, sum (compound read), x, sum = 4 for f; the callback alone pairs only x.
    expect(
      depDegreeOf('javascript', 'function f(xs) { let sum = 0; xs.forEach((x) => { sum += x; }); return sum; }')
    ).toEqual([4, 1]);
    // `inner` is defined in the arrow's scope: the outer `return inner` has no visible definition.
    expect(
      depDegreeOf('javascript', 'function f() { const g = () => { const inner = 1; return inner; }; return inner; }')
    ).toEqual([1, 1]);
  });

  it('treats a bare declaration plus later assignment as a definition and loop headers as reads', () => {
    expect(depDegreeOf('javascript', 'function f(a) { let x; x = a; return x; }')).toEqual([2]);
    // i < a (2), i++ (1), a += i (2), return a (1).
    expect(depDegreeOf('javascript', 'function f(a) { for (let i = 0; i < a; i++) { a += i; } return a; }')).toEqual([
      6,
    ]);
  });

  it('recognizes Java local, enhanced-for, catch, and lambda bindings', () => {
    expect(
      depDegreeOf(
        'java',
        'class A { int f(int[] xs) { int sum = 0; for (int x : xs) { sum += x; } try { g(); } catch (Exception e) { return e.hashCode(); } java.util.function.Function<Integer,Integer> h = y -> y + sum; return sum; } }'
      )
    ).toEqual([7, 1]);
  });

  it('recognizes C declarators and for-loop counters', () => {
    // i < n (2), i++ (1), total += p[i] (3), return total (1).
    expect(
      depDegreeOf(
        'c',
        'int f(int n, int *p) { int total = 0; for (int i = 0; i < n; i++) { total += p[i]; } return total; }'
      )
    ).toEqual([7]);
  });

  it('recognizes C++ pointer, reference, array, and function-pointer declarators as definitions', () => {
    // q (init), *q, xs, r (compound), x, *p, r, a, fp.
    expect(
      depDegreeOf(
        'cpp',
        'int f(int* q, std::vector<int> xs) { int* p = q; int& r = *q; for (const auto& x : xs) { r += x; } int a[2] = {1, 2}; int (*fp)(int) = g; return *p + r + a[0] + fp(1); }'
      )
    ).toEqual([9]);
    // A member pointer declares its name as a type_identifier inside a pointer_type_declarator;
    // a qualified constant in a parameter default is a read, so the body's read pairs with nothing.
    expect(depDegreeOf('cpp', 'struct C {}; int f(int C::* q) { int C::* p = q; return p == q; }')).toEqual([3]);
    expect(depDegreeOf('cpp', 'struct C {}; int f(int C::* q) { int C::* arr[1] = {q}; return arr[0] == q; }')).toEqual(
      [3]
    );
    expect(depDegreeOf('cpp', 'namespace N { struct C {}; } int f(int N::C::* q) { return q != nullptr; }')).toEqual([
      1,
    ]);
    // The size of a member-pointer array parameter is a read, not the parameter's definition.
    expect(depDegreeOf('cpp', 'struct C {}; int f(int C::* a[n]) { return n; }')).toEqual([0]);
    expect(
      depDegreeOf(
        'cpp',
        'namespace N { namespace M { const int C = 5; } } int f(int x = N::M::C) { return N::M::C + x; }'
      )
    ).toEqual([1]);
  });

  it('recognizes C# pattern, out-variable, and foreach bindings', () => {
    // o, n, parsed (compound), x, xs, parsed.
    expect(
      depDegreeOf(
        'csharp',
        'class A { int F(object o, int[] xs) { if (o is int n) return n; int.TryParse("1", out var parsed); foreach (var x in xs) parsed += x; return parsed; } }'
      )
    ).toEqual([6]);
  });

  it('recognizes Kotlin loop and catch bindings', () => {
    expect(
      depDegreeOf(
        'kotlin',
        'fun f(xs: List<Int>): Int { var total = 0; for (x in xs) { total += x }; try { g() } catch (e: Exception) { return e.hashCode() }; return total }'
      )
    ).toEqual([5]);
  });

  it('recognizes Ruby block parameters and multi-target Python/Go assignments', () => {
    expect(depDegreeOf('ruby', 'def f(xs)\n  total = 0\n  xs.each { |x| total += x }\n  total\nend\n')).toEqual([4, 1]);
    expect(depDegreeOf('python', 'def f(xs):\n    a, b = 1, 2\n    return a + b + xs\n')).toEqual([3]);
    expect(
      depDegreeOf('go', 'package p\nfunc f(xs []int) int {\n\ta, b := 1, 2\n\treturn a + b + len(xs)\n}\n')
    ).toEqual([3]);
  });
});

/** [distinct operators, distinct operands, total operators, total operands]. */
function countsOf(language: string, code: string): [number, number, number, number] {
  const { distinctOperators, distinctOperands, totalOperators, totalOperands } = measureCode(code, {
    language,
  }).halstead;
  return [distinctOperators, distinctOperands, totalOperators, totalOperands];
}

describe('Halstead operator and operand classification', () => {
  it('counts symbolic and keyword operators, and identifiers/literals as operands', () => {
    expect(countsOf('javascript', 'a = b + 1;')).toEqual([2, 3, 2, 3]);
    // =, ?., ??, typeof, new, return, await; operands x, a, b, c, x, K, p.
    expect(countsOf('javascript', 'const x = a?.b ?? c; typeof x; new K(); return; await p;')).toEqual([7, 6, 7, 7]);
  });

  it('does not count a TypeScript optional marker as the ternary operator', () => {
    // return, ! (non-null assertion); operands f, x, number, number, x.
    expect(countsOf('typescript', 'function f(x?: number): number { return x!; }')).toEqual([2, 3, 2, 5]);
  });

  it('counts the Python matrix operator but not decorator marks, and the Rust try operator', () => {
    expect(countsOf('python', '@dec\ndef f(a, b):\n    return a @ b\n')).toEqual([2, 4, 2, 6]);
    // ->, <, >, =, ?; operands f, Option, i32, x, g, Some, x.
    expect(countsOf('rust', 'fn f() -> Option<i32> { let x = g()?; Some(x) }')).toEqual([5, 6, 5, 7]);
  });

  it('counts string content as operands and ignores comments entirely', () => {
    // Two equal string fragments are one distinct operand; the template literal contributes its
    // fragment and interpolated identifier.
    expect(countsOf('javascript', 'x = "a" + "a" + `t${y}`;')).toEqual([2, 4, 3, 5]);
    expect(countsOf('javascript', '// only a comment\n/* and another */')).toEqual([0, 0, 0, 0]);
  });
});

/** [total, code, comment, blank]. */
function linesOf(code: string, language = 'javascript'): [number, number, number, number] {
  const { total, code: codeLines, comment, blank } = measureCode(code, { language }).lines;
  return [total, codeLines, comment, blank];
}

describe('line classification', () => {
  it('splits on LF, CRLF, and bare CR, counting the line after a trailing newline as blank', () => {
    expect(linesOf('\n')).toEqual([2, 0, 0, 2]);
    expect(linesOf('a\n')).toEqual([2, 1, 0, 1]);
    expect(linesOf('a')).toEqual([1, 1, 0, 0]);
    expect(linesOf('\r\n\r\n')).toEqual([3, 0, 0, 3]);
    expect(linesOf('a\rb\rc')).toEqual([3, 3, 0, 0]);
  });

  it('classifies Unicode whitespace as blank and lines covered by several comments as comment', () => {
    // `/* a */ /* b */` is comment-only through the union of two spans; `x // c` is code;
    // ideographic space (U+3000) and BOM (U+FEFF) lines are blank.
    expect(linesOf('/* a */ /* b */\nx // c\n  \n\u3000\n\uFEFF\n')).toEqual([6, 1, 1, 4]);
  });

  it('classifies multi-line comments and code sharing a line with a comment', () => {
    expect(linesOf('/*\n  multi\n*/\nlet y = 1; /* t */')).toEqual([4, 1, 3, 0]);
    expect(linesOf('x = 1 /* c\n */ ; y')).toEqual([2, 2, 0, 0]);
    // A blank line inside a template literal is still blank.
    expect(linesOf('const x = `a\n\nb`;\n')).toEqual([4, 2, 0, 2]);
  });

  it('treats Python docstrings as code and shebang lines as comments', () => {
    expect(linesOf('def f():\n    """doc\n    string"""\n    return 1\n#!x\n', 'python')).toEqual([6, 4, 1, 1]);
    expect(linesOf('#!/usr/bin/env ruby\n# c\nx = 1\n', 'ruby')).toEqual([4, 1, 2, 1]);
  });
});

describe('robustness and option normalization', () => {
  it('measures ill-formed UTF-16 input (lone surrogates) without throwing', () => {
    const metrics = measureCode('const s = "\uD800";', { language: 'javascript' });
    expect(metrics.lines).toEqual({ total: 1, code: 1, comment: 0, blank: 0 });
    expect(metrics.ncssCount).toBe(1);
  });

  it('refuses pathologically deep syntax trees with a clear error instead of crashing', () => {
    const deep = `const x = ${'('.repeat(6000)}1${')'.repeat(6000)};`;
    expect(() => measureCode(deep, { language: 'javascript' })).toThrow('tree depth exceeds');
  });

  it('still measures files with syntax errors and reports the recovered functions', () => {
    const metrics = measureCode(
      'export function broken(value: number): number {\n  if (value > 0 {\n    return 1;\n  }\n  return value;\n}\nconst dangling = {',
      {
        language: 'typescript',
        includeSyntaxTree: true,
      }
    );
    expect(metrics.syntaxTree).toContain('(ERROR');
    expect(metrics.functions.map((fn) => fn.name)).toEqual(['broken']);
    expect(metrics.lines.total).toBe(7);
  });

  it('treats NaN duplication settings as absent and truncates/clamps out-of-range ones', () => {
    const pair = 'function a(x) { return x + 1; }\nfunction b(y) { return y + 1; }\n';
    const groups = (minTokens: number): number =>
      measureCode(pair, { language: 'javascript', duplication: { minTokens } }).duplication.duplicateBlockGroupCount;
    // The matched region is 7 normalized tokens: below the default 40; 7.5 truncates to 7 (still
    // detected) whereas rounding up to 8 would suppress it.
    expect(groups(Number.NaN)).toBe(0);
    expect(groups(2 ** 40)).toBe(0);
    expect(groups(8)).toBe(0);
    expect(groups(7)).toBe(1);
    expect(groups(7.5)).toBe(1);
  });
});

describe('language registry', () => {
  it('resolves every declared alias to its language and enumerates each language once', () => {
    const measurer = new TreeMeasurer();
    expect(measurer.getSupportedLanguages()).toEqual(supportedLanguages);
    for (const { name, aliases } of defaultLanguages) {
      for (const alias of aliases ?? []) {
        expect(measureCode('', { language: alias }).language, alias).toBe(name);
      }
    }
    // Aliases the CLI's extension map relies on are declared.
    expect(defaultLanguages.flatMap((language) => language.aliases ?? [])).toEqual(
      expect.arrayContaining(['mjs', 'cjs', 'c++', 'cxx', 'c#', 'kts'])
    );
  });
});

describe('function token sequences', () => {
  it('normalizes identifiers by first occurrence and literals by kind, keeping operators verbatim', () => {
    const [a, b, c, d] = collectFunctionTokenSequences(
      'function a(x) { return x + 1; }\nfunction b(y) { return y + 2; }\nfunction c(y) { return y - 2; }\nfunction d(y) { return y + "s"; }',
      { language: 'javascript' }
    );
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a).not.toEqual(d);
    expect(a?.length).toBe(12);
  });

  it('is index-parallel to the functions array, nested functions included', () => {
    const code = 'function outer(xs) { const inner = (x) => x * 2; return xs.map(inner); }\n';
    const sequences = collectFunctionTokenSequences(code, { language: 'javascript' });
    const functions = functionsOf('javascript', code);
    expect(functions.map((fn) => fn.name)).toEqual(['outer', 'inner']);
    expect(sequences).toHaveLength(2);
    expect((sequences[0]?.length ?? 0) > (sequences[1]?.length ?? 0)).toBe(true);
  });
});

describe('cross-file duplication file data', () => {
  it('reports code line numbers, the token stream, and statement containers', () => {
    const data = collectCrossFileDuplicationFileData('// c\nfunction a(x) {\n\n  return x + 1;\n}\n', {
      language: 'javascript',
    });
    expect([...(data.codeLineNumbers ?? [])]).toEqual([2, 4, 5]);
    // Literals are normalized to a kind tag; identifiers keep their text (anonymized by the
    // fingerprint, not the stream).
    expect(data.tokens.map((token) => token.text)).toEqual([
      'function',
      'a',
      '(',
      'x',
      ')',
      '{',
      'return',
      'x',
      '+',
      '#num',
      ';',
      '}',
    ]);
    // The program and the function body are statement containers; the short body is below
    // the default minimum, so nothing is catalogued.
    expect(data.containerStatements).toHaveLength(2);
    expect(data.candidates).toEqual([]);
  });
});
