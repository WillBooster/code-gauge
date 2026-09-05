import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { measureCode, supportedLanguages, type LanguageName } from '../../src/index.js';
import { fixturesDir } from './fixtureCorpus.js';

// Per-language construct catalogs under test/fixtures/constructs: each file exercises the control
// flow, declaration, and member kinds its grammar offers (loops, else-if chains, switch/match
// with guards and defaults, labeled jumps, try/catch/finally, nested lambdas and local classes,
// accessors, operators, constructors, generics, ...). The expected values are derived BY HAND from
// the specifications the metrics follow — the SonarSource cognitive-complexity rules (with the
// nesting increments of nested functions and local class bodies), the PMD NcssCount conventions
// generalized per grammar, and plain parameter/name reading — not copied from the measurer's
// output, so a catalog omission or a grammar upgrade that changes how a construct parses fails
// here with the construct spelled out, unlike the golden snapshots which only detect a change.

/** [name, cognitive complexity, nesting depth, NCSS, parameter count], in source order. */
type FunctionExpectation = readonly [string | undefined, number, number, number, number];

interface ConstructExpectation {
  file: string;
  /** File-level NCSS: every declaration/statement/clause once. */
  ncss: number;
  /** File-level cognitive complexity (top-level code included). */
  cognitiveComplexity: number;
  nestingDepth: number;
  functions: readonly FunctionExpectation[];
}

const expectations: Record<LanguageName, ConstructExpectation> = {
  javascript: {
    file: 'constructs.js',
    // classify: labeled for +1, nested for +2, if +3, `continue outer` +1, if +2 with `&&` +1,
    // else-if +1 with `||` +1, else +1, do-while +1 with `&&` +1, for-in +1, switch +1, ternary
    // nested in a case +2, catch +1 = 20; `??` and `?.` are not boolean operators. The top-level
    // labeled block adds if +1 and `break label` +1 to the file total.
    ncss: 60,
    cognitiveComplexity: 26,
    nestingDepth: 3,
    functions: [
      ['constructor', 0, 0, 2, 1],
      ['size', 0, 0, 2, 0],
      ['size', 0, 0, 2, 1],
      ['drain', 1, 1, 3, 0],
      ['#load', 0, 0, 3, 1],
      ['classify', 20, 3, 30, 3],
      // The ternary inside the nested map callback costs 2 for describe (nested function) and 1
      // for the callback itself.
      ['describe', 2, 0, 3, 1],
      [undefined, 1, 1, 1, 1],
      ['countdown', 1, 1, 4, 1],
    ],
  },
  jsx: {
    file: 'constructs.jsx',
    // render: `&&` in a JSX expression +1, ternary +1. List: the filter callback's `||` +1 and
    // the map callback's ternary +2 (nested function) = 3; callbacks in JSX attributes and default
    // parameters are functions of their own.
    ncss: 14,
    cognitiveComplexity: 6,
    nestingDepth: 1,
    functions: [
      ['toggle', 0, 0, 2, 0],
      [undefined, 0, 0, 1, 1],
      ['render', 2, 1, 3, 0],
      ['List', 3, 0, 3, 1],
      [undefined, 0, 0, 1, 1],
      [undefined, 0, 0, 1, 1],
      [undefined, 1, 0, 1, 1],
      [undefined, 1, 1, 1, 1],
      ['Badge', 1, 1, 1, 1],
      ['App', 0, 0, 2, 0],
    ],
  },
  typescript: {
    file: 'constructs.ts',
    // NCSS: 2 imports, type alias, interface + 3 members, enum, `export namespace` + member,
    // `declare namespace` + member, abstract class + abstract signature + static field +
    // constructor + overload signature + describe (2), Impl + build (5: the object literal's
    // method counts), pick (3), conditional (1), main (5) = 34. Abstract and overload signatures
    // are not functions; parameter properties are parameters.
    ncss: 34,
    cognitiveComplexity: 6,
    nestingDepth: 2,
    functions: [
      ['constructor', 0, 0, 1, 2],
      ['describe', 0, 0, 2, 1],
      ['build', 2, 1, 5, 1],
      [undefined, 0, 0, 1, 0],
      ['run', 0, 0, 1, 0],
      ['pick', 0, 0, 3, 2],
      ['conditional', 1, 1, 1, 1],
      ['main', 3, 2, 5, 1],
    ],
  },
  tsx: {
    file: 'constructs.tsx',
    // Row: the useMemo callback's ternary costs 2 (nested function). Toggle is the named function
    // expression inside forwardRef, taking both props and ref. render: the map callback's ternary
    // costs 2; the render-prop arrow inside it has no decision.
    ncss: 20,
    cognitiveComplexity: 6,
    nestingDepth: 1,
    functions: [
      ['Row', 2, 0, 3, 1],
      [undefined, 1, 1, 1, 0],
      ['Toggle', 1, 1, 4, 2],
      [undefined, 0, 0, 1, 0],
      [undefined, 0, 0, 1, 1],
      ['sorted', 1, 1, 3, 0],
      ['render', 2, 0, 2, 0],
      [undefined, 1, 1, 1, 1],
      [undefined, 0, 0, 1, 1],
    ],
  },
  python: {
    file: 'constructs.py',
    // classify: for +1, if +2 with `and` +1, elif +1 with `or` +1, else +1, for-else +1, while
    // +1, nested if +2, while-else +1, match +1, `case 1 if strict` guard +1 (`case [..]` and
    // `case _` are unconditional), two except clauses +2, ternary +1 = 17. `/` and `*` separators
    // bind nothing (3 parameters); `self` is a parameter.
    ncss: 66,
    cognitiveComplexity: 24,
    nestingDepth: 2,
    functions: [
      ['__init__', 0, 0, 2, 2],
      ['size', 0, 0, 2, 1],
      ['build', 1, 1, 2, 2],
      ['load', 1, 1, 4, 2],
      ['classify', 17, 2, 37, 3],
      // inner's ternary (+2) and the lambda's ternary (+2) are nested-function content of outer.
      ['outer', 4, 0, 7, 1],
      ['inner', 1, 1, 3, 1],
      ['scale', 1, 1, 1, 1],
      ['countdown', 1, 1, 4, 1],
    ],
  },
  go: {
    file: 'constructs.go',
    // Classify: labeled for +1, range for +2, if +3, `continue outer` +1, type switch +2, if
    // nested in a case +3 with `&&` +1, else-if +1 with `||` +1, else +1, expression switch +2,
    // goto +1, select +1 = 20 (`fallthrough`, `go`, and `defer` add nothing). NCSS counts the
    // package clause, each import spec, each var/const spec, struct fields and interface members
    // (the embedded interface included), the if-statement initializer, and every case label.
    ncss: 66,
    cognitiveComplexity: 23,
    nestingDepth: 3,
    functions: [
      ['NewStore', 1, 1, 5, 1],
      ['Read', 1, 1, 5, 1],
      ['String', 0, 0, 2, 0],
      ['Classify', 20, 3, 35, 2],
      [undefined, 0, 0, 2, 0],
      ['Countdown', 1, 1, 4, 1],
      ['scale', 0, 0, 2, 2],
    ],
  },
  rust: {
    file: 'constructs.rs',
    // apply: match +1, arm guard +1, `if let` nested in an arm +2, if +3 with `&&` +1, else +1,
    // else-if +1 with `||` +1, else +1, labeled loop +2, `while let` +3, if +4, `break 'outer`
    // +1 = 22. The trait's bodyless `audit` signature and the `?` operator are not counted.
    ncss: 63,
    cognitiveComplexity: 28,
    nestingDepth: 4,
    functions: [
      ['describe', 0, 0, 2, 0],
      ['new', 0, 0, 2, 1],
      ['apply', 22, 4, 29, 2],
      ['doubled', 0, 0, 1, 1],
      ['fmt', 0, 0, 2, 1],
      // for +1, if-expression nested +2, else +1.
      ['tally', 4, 2, 9, 1],
      ['countdown', 2, 1, 5, 1],
    ],
  },
  java: {
    file: 'constructs.java',
    // receive: labeled for +1, enhanced for +2, if +3, `continue outer` +1, if +2 (synchronized
    // does not nest) with `&&` +1, else-if +1 with `||` +1, else +1, switch inside the else
    // branch +3, do-while +1, catch +1 = 18; try-with-resources and assert add nothing. NCSS
    // follows PMD: initializer blocks, record compact constructors, enum-constant bodies,
    // interface and annotation members, explicit constructor invocations, resources, and switch
    // labels each count; the arrow-case expression bodies count as statements (the documented
    // divergence from PMD).
    ncss: 85,
    cognitiveComplexity: 28,
    nestingDepth: 3,
    functions: [
      ['Shipment', 0, 0, 2, 2],
      ['label', 0, 0, 2, 0],
      ['label', 0, 0, 2, 0],
      ['audit', 0, 0, 1, 1],
      ['twice', 0, 0, 2, 1],
      ['Warehouse', 0, 0, 2, 1],
      ['Warehouse', 1, 1, 5, 2],
      ['receive', 18, 3, 30, 2],
      ['describe', 4, 2, 12, 1],
      // The anonymous class body raises nesting once, so the inner run's if costs 2 here; the
      // lambda's ternary costs 2 as nested-function content.
      ['run', 4, 0, 8, 0],
      ['run', 1, 1, 3, 0],
      ['doubler', 1, 1, 1, 1],
      ['fibonacci', 1, 1, 2, 1],
    ],
  },
  ruby: {
    file: 'constructs.rb',
    // process: the each_with_index block is a nested function (+1 nesting): `next if` +2, if +2
    // with `&&` +1, elsif +1 with `||` +1, `unless` modifier nested in the elsif +3, else +1;
    // then until +1, `break if` +2, while +1, for +1, `next if` +2, `raise ... if` +1, rescue
    // +1, `retry if` nested in the rescue +2, begin/else +1, method-level rescue +1 = 24. The
    // `&block` parameter binds no argument (4 parameters); `in other` is unconditional.
    ncss: 74,
    cognitiveComplexity: 37,
    nestingDepth: 2,
    functions: [
      ['initialize', 1, 1, 4, 4],
      ['build', 0, 0, 2, 1],
      ['total', 0, 0, 2, 0],
      // case/when +1 with a ternary in a when +2, case/in +1, `if` guard +1, `unless` guard +1.
      ['classify', 6, 2, 17, 2],
      ['process', 24, 2, 28, 1],
      [undefined, 8, 2, 8, 2],
      [undefined, 0, 0, 2, 1],
      ['add', 0, 0, 2, 1],
      ['double', 0, 0, 2, 1],
      ['tally', 3, 0, 3, 1],
      [undefined, 2, 1, 2, 1],
      ['report', 3, 1, 4, 1],
    ],
  },
  c: {
    file: 'constructs.c',
    // classify: for +1, nested for +2, if +3, goto +1, if +2 with `&&` +1, else-if +1 with `||`
    // +1, else +1, while +1, do-while +1 with `&&` +1, switch +1, ternary in a case +2 = 19. NCSS
    // counts preprocessor includes and defines, both branches of `#ifdef`, struct/union fields,
    // typedefs, and one per declaration even with several declarators; `f(void)` has no
    // parameters and `...` is one.
    ncss: 67,
    cognitiveComplexity: 23,
    nestingDepth: 3,
    functions: [
      ['square', 0, 0, 2, 1],
      ['classify', 19, 3, 27, 2],
      ['sum_list', 1, 1, 5, 2],
      ['fibonacci', 1, 1, 2, 1],
      ['apply', 0, 0, 2, 3],
      ['main', 2, 1, 11, 0],
    ],
  },
  cpp: {
    file: 'constructs.cpp',
    // classify: for +1, range-for +2, if +3, goto +1, if +2 with `and` +1, else-if +1 with `or`
    // +1, else +1, range-for +1, ternary +2 with `&&` +1, while +1, do-while +1, switch +1,
    // ternary in a case +2 = 22. `= default` / pure-virtual members are not functions; the
    // function-try-block constructor's catch counts; `if constexpr` is an if.
    ncss: 85,
    cognitiveComplexity: 33,
    nestingDepth: 3,
    functions: [
      ['Engine', 0, 0, 1, 1],
      ['base', 0, 0, 2, 0],
      ['Widget', 0, 0, 1, 0],
      ['Widget', 1, 1, 2, 1],
      ['boost', 0, 0, 2, 1],
      ['operator==', 0, 0, 2, 1],
      ['operator int', 0, 0, 2, 0],
      ['size', 0, 0, 2, 0],
      ['classify', 22, 3, 29, 3],
      // for +1, ternary +2, `if constexpr` +1, ternary +1, plus the guard lambda's `&&` +1.
      ['tally', 6, 2, 11, 1],
      ['doubler', 0, 0, 2, 1],
      ['guard', 1, 0, 2, 1],
      ['fibonacci', 1, 1, 2, 1],
      ['report', 3, 1, 9, 0],
    ],
  },
  csharp: {
    file: 'constructs.cs',
    // Receive: for +1, foreach +2, if +3, goto +1, if +2 (lock does not nest) with `&&` +1,
    // else-if +1 with `||` +1, else +1, switch inside the else branch +3, `case 1 when` guard +1,
    // do-while +1 (using/checked do not nest), two catches +2 (the exception filter is not
    // charged) = 20. Auto-property and interface accessors without bodies are not functions;
    // event accessors, expression-bodied members, operators, and the destructor are.
    ncss: 107,
    cognitiveComplexity: 29,
    nestingDepth: 3,
    functions: [
      ['Receive', 0, 0, 1, 2],
      ['Drained.add', 0, 0, 2, 0],
      ['Drained.remove', 0, 0, 2, 0],
      ['Warehouse', 1, 1, 3, 1],
      ['Warehouse', 0, 0, 1, 0],
      ['Count.get', 0, 0, 2, 0],
      ['Count.set', 0, 0, 2, 0],
      ['IsEmpty.get', 0, 0, 2, 0],
      ['this.get', 0, 0, 2, 1],
      ['Receive', 20, 3, 39, 2],
      ['Describe', 4, 2, 8, 1],
      ['Drain', 3, 1, 10, 0],
      ['hook', 0, 0, 2, 0],
      ['doubler', 1, 1, 1, 1],
      ['Local', 0, 0, 2, 1],
      ['Fibonacci', 1, 1, 2, 1],
      ['operator +', 0, 0, 2, 2],
      ['operator int', 0, 0, 2, 1],
      ['~Warehouse', 0, 0, 2, 0],
    ],
  },
  kotlin: {
    file: 'constructs.kt',
    // receive: labeled for +1, for +2, if +3, `continue@outer` +1, if +2 with `&&` +1, else-if
    // +1 with `||` +1, else +1, when inside the else branch +3, do-while +1, two catches +2 = 19.
    // Bodyless interface members, `init` blocks, and a visibility-only `private set` are not
    // functions; property getters/setters, secondary constructors, anonymous functions, and
    // lambdas are. NCSS counts the package and import lines, class/object/companion
    // declarations, enum-constant bodies, `init` blocks, and every when entry and its body.
    ncss: 124,
    cognitiveComplexity: 36,
    nestingDepth: 3,
    functions: [
      ['receive', 0, 0, 1, 2],
      ['describe', 0, 0, 2, 0],
      ['describe', 0, 0, 2, 0],
      ['size.get', 0, 0, 2, 0],
      ['tag.get', 0, 0, 2, 0],
      ['tag.set', 0, 0, 2, 1],
      ['Warehouse', 0, 0, 2, 2],
      ['receive', 19, 3, 34, 2],
      [undefined, 0, 0, 2, 0],
      // when +1, if-else inside an entry +2 and +1, nested subject-less when +2.
      ['describe', 6, 2, 17, 1],
      // The object expression's class body raises nesting once (run's if costs 2), the lambda's
      // if-else costs 3, the anonymous function's `&&` 1, and the final if-else 2.
      ['drain', 8, 1, 24, 0],
      ['run', 1, 1, 4, 0],
      ['doubler', 2, 1, 5, 1],
      ['guard', 1, 0, 2, 1],
      ['local', 0, 0, 2, 1],
      [undefined, 0, 0, 2, 0],
      [undefined, 0, 0, 2, 0],
      ['shout', 0, 0, 2, 1],
      ['fibonacci', 2, 1, 5, 1],
      ['typeName', 0, 0, 2, 0],
    ],
  },
};

describe('construct catalogs: spec-derived metrics per language', () => {
  it('covers every supported language', () => {
    expect(Object.keys(expectations).toSorted()).toEqual([...supportedLanguages].toSorted());
  });

  for (const [language, expectation] of Object.entries(expectations)) {
    describe(language, () => {
      const code = readFileSync(path.join(fixturesDir, 'constructs', expectation.file), 'utf8');
      const metrics = measureCode(code, { language, includeSyntaxTree: true });

      it('parses without syntax errors', () => {
        expect(metrics.syntaxTree).not.toMatch(/\((?:ERROR|MISSING)/u);
      });

      it('measures every function as derived from the metric specifications', () => {
        const actual: FunctionExpectation[] = metrics.functions.map((fn) => [
          fn.name,
          fn.cognitiveComplexity,
          fn.nestingDepth,
          fn.ncss,
          fn.parameterCount,
        ]);
        expect(actual).toEqual(expectation.functions);
      });

      it('measures the file-level aggregates', () => {
        expect(metrics.ncssCount).toBe(expectation.ncss);
        expect(metrics.cognitiveComplexity).toBe(expectation.cognitiveComplexity);
        expect(metrics.nestingDepth).toBe(expectation.nestingDepth);
        expect(metrics.maxCognitiveComplexity).toBe(
          Math.max(...expectation.functions.map(([, cognitive]) => cognitive))
        );
        // Functions are reported in source order with consistent spans.
        for (const [index, fn] of metrics.functions.entries()) {
          expect(fn.endLine).toBeGreaterThanOrEqual(fn.startLine);
          const previous = metrics.functions[index - 1];
          if (previous) {
            expect(fn.startLine).toBeGreaterThanOrEqual(previous.startLine);
          }
        }
      });
    });
  }
});
