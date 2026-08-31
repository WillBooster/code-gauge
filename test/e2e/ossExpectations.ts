import type { LanguageName } from '../../src/index.js';

/**
 * Expected metrics for the real-world OSS corpus under test/fixtures/oss (famous open-source
 * files pinned to release tags; see test/fixtures/oss/README.md for provenance and licenses).
 *
 * The per-function complexity/NCSS oracle values were produced by major existing tools, NOT by
 * code-gauge itself, so these tests verify code-gauge against independent implementations:
 *
 * - `pmd` — PMD 7.26.0 (CognitiveComplexity / NcssCount rules, report level 1), the engine whose
 *   semantics code-gauge's Java complexity deliberately follows. All 41 Java methods match on
 *   cognitive complexity; NCSS matches on 38.
 * - `gocognit` — gocognit v1.2.0, the standard Go implementation of SonarSource cognitive
 *   complexity. 37 of 38 functions match.
 * - `complexipy` — complexipy 7.0.0, a Rust implementation of SonarSource cognitive complexity
 *   for Python. 23 of 28 functions match.
 * - `sonarjs` — eslint-plugin-sonarjs 0.25.1 (SonarSource's own ESLint port of cognitive
 *   complexity) on ESLint 8.57.0 / @typescript-eslint/parser 7.18.0. 57 functions match across
 *   JavaScript, TypeScript, JSX, and TSX.
 *
 * C, C++, C#, Kotlin, Ruby, and Rust have NO per-function oracle: for C, C++, Ruby, and Rust
 * the only per-function reference tool (lizard) measured cyclomatic complexity, which code-gauge
 * no longer reports. Ruby has no readily runnable open-source implementation of SonarSource
 * cognitive complexity; for C, C++, and Rust the one candidate — Mozilla's rust-code-analysis —
 * implements its own cognitive-complexity variant that has not been reconciled with the
 * SonarSource model here, so its values are not adopted as oracles (yet). The C# (SonarAnalyzer)
 * and Kotlin (detekt) implementations need a .NET SDK or JVM toolchain that the corpus tooling
 * does not include. Their `oracleFunctions` lists are empty, the per-function tests are skipped
 * visibly for them, and only the aggregate expectations (regenerated from code-gauge itself) plus
 * the cloc/tokei line oracle guard those files.
 *
 * Line metrics in `aggregates` were verified against cloc 2.06 for all files, the C# and Kotlin
 * files included (code/comment/blank identical; code-gauge additionally counts the empty line
 * after a trailing final newline as one blank line, so `lines.total` and `lines.blank` are one
 * higher than cloc's). Two files need a different oracle:
 *
 * - Python: cloc classifies docstrings as comments while code-gauge (like tree-sitter) treats
 *   them as expression statements, i.e. code. For requests' sessions.py cloc reports
 *   code=413/comment=267; code-gauge reports code=564/comment=116 — the code+comment sum (680)
 *   is identical, and the 151-line delta is exactly the docstring lines.
 * - Rust: cloc misparses gitignore.rs because glob patterns such as "foo/**" + "/*" inside string
 *   literals look like block-comment openers to it. tokei 13.0 (Rust-aware) confirms code-gauge:
 *   code=562 for both; tokei's comment(165)+doc-comment-blank(29)=194 vs code-gauge's 193+blank
 *   split differs only in how blank lines inside doc comments are classified.
 *
 * `knownDivergences` pins every attributable function where an oracle tool disagrees with
 * code-gauge, so a behavior change on either side of a documented gap fails loudly. The reasons:
 *
 * - pmd/ncss: PMD's NCSS visitor does not descend into expression positions (anonymous classes
 *   returned from methods), while code-gauge counts statement-shaped content uniformly — the same
 *   deliberate divergence documented in pmdParity.test.ts.
 * - gocognit/cognitive: gocognit charges SonarSource's +1 recursion increment (gin's `iterate`);
 *   code-gauge does not charge recursion (issue #22 — intentionally omitted, like PMD and the
 *   SonarQube analyzers).
 * - complexipy/cognitive: complexipy charges comprehensions and their internal `if`/`for` clauses;
 *   code-gauge counts only statement-level decisions (dialect difference among Sonar ports).
 * - sonarjs/cognitive: sonarjs attributes nested-closure content to the innermost enclosing
 *   function only, while code-gauge (like PMD) also attributes it to the enclosing declared
 *   function; a few remaining cases differ on JSX expressions, which sonarjs does not analyze,
 *   and on `??`/optional-chain handling in vscode's uri.ts.
 *
 * Aggregate float values (duplicationRatio, halstead) are rounded to 4 decimals by the same
 * rounding the test applies to measured values before comparison.
 *
 * Regeneration: run the tools above at the pinned versions over test/fixtures/oss, join their
 * per-function rows to code-gauge functions by start/end line, and re-emit this file; expected
 * values only change when the measurer's semantics change, in which case the affected entries
 * must be re-verified against the tools.
 */

export type OracleMetric = 'cognitive' | 'ncss';

/**
 * [functionName, startLine, endLine, metric, tool, expectedValue] — code-gauge must equal
 * expectedValue for the function spanning exactly startLine..endLine.
 */
export type OracleFunctionEntry = readonly [string, number, number, OracleMetric, string, number];

/**
 * [functionName, startLine, endLine, metric, tool, toolValue, codeGaugeValue] — code-gauge must
 * equal codeGaugeValue, which intentionally differs from toolValue (see file doc above). If an
 * implementation change makes code-gauge match the tool, move the entry to oracleFunctions.
 */
export type KnownDivergenceEntry = readonly [string, number, number, OracleMetric, string, number, number];

export interface OssAggregateExpectation {
  lines: { total: number; code: number; comment: number; blank: number };
  cognitiveComplexity: number;
  maxCognitiveComplexity: number;
  nestingDepth: number;
  ncssCount: number;
  duplication: {
    duplicateBlockCount: number;
    duplicateBlockGroupCount: number;
    duplicateBlockGroups: { endLine: number; startLine: number }[][];
    duplicateLineCount: number;
    duplicationRatio: number;
    maxDuplicateBlockSize: number;
  };
  halstead: Record<string, number>;
}

export interface OssFileExpectation {
  file: string;
  language: LanguageName;
  aggregates: OssAggregateExpectation;
  oracleFunctions: readonly OracleFunctionEntry[];
  knownDivergences: readonly KnownDivergenceEntry[];
}

export const ossExpectations: readonly OssFileExpectation[] = [
  {
    file: 'bitcoin-25.0-bech32.cpp',
    language: 'cpp',
    aggregates: {
      lines: {
        total: 570,
        code: 286,
        comment: 219,
        blank: 65,
      },
      cognitiveComplexity: 149,
      maxCognitiveComplexity: 89,
      nestingDepth: 5,
      ncssCount: 240,
      duplication: {
        duplicateBlockCount: 2,
        duplicateBlockGroupCount: 1,
        duplicateBlockGroups: [
          [
            {
              endLine: 500,
              startLine: 498,
            },
            {
              endLine: 506,
              startLine: 504,
            },
            {
              endLine: 521,
              startLine: 519,
            },
          ],
        ],
        duplicateLineCount: 9,
        duplicationRatio: 0.0315,
        maxDuplicateBlockSize: 44,
      },
      halstead: {
        distinctOperators: 28,
        distinctOperands: 185,
        totalOperators: 571,
        totalOperands: 1089,
        vocabulary: 213,
        length: 1660,
        volume: 12_839.618,
        effort: 1_058_123.3274,
      },
    },
    oracleFunctions: [],
    knownDivergences: [],
  },
  {
    file: 'dotnet-runtime-8.0.0-Version.cs',
    language: 'csharp',
    aggregates: {
      lines: {
        total: 431,
        code: 318,
        comment: 36,
        blank: 77,
      },
      cognitiveComplexity: 103,
      maxCognitiveComplexity: 43,
      nestingDepth: 7,
      ncssCount: 211,
      duplication: {
        duplicateBlockCount: 1,
        duplicateBlockGroupCount: 1,
        duplicateBlockGroups: [
          [
            {
              endLine: 41,
              startLine: 31,
            },
            {
              endLine: 53,
              startLine: 44,
            },
          ],
        ],
        duplicateLineCount: 19,
        duplicationRatio: 0.0597,
        maxDuplicateBlockSize: 46,
      },
      halstead: {
        distinctOperators: 29,
        distinctOperands: 142,
        totalOperators: 386,
        totalOperands: 852,
        vocabulary: 171,
        length: 1238,
        volume: 9183.3014,
        effort: 798_947.223,
      },
    },
    oracleFunctions: [],
    knownDivergences: [],
  },
  {
    file: 'express-4.18.2-response.js',
    language: 'javascript',
    aggregates: {
      lines: {
        total: 1170,
        code: 537,
        comment: 475,
        blank: 158,
      },
      cognitiveComplexity: 187,
      maxCognitiveComplexity: 39,
      nestingDepth: 4,
      ncssCount: 428,
      duplication: {
        duplicateBlockCount: 2,
        duplicateBlockGroupCount: 2,
        duplicateBlockGroups: [
          [
            {
              endLine: 271,
              startLine: 251,
            },
            {
              endLine: 314,
              startLine: 294,
            },
          ],
          [
            {
              endLine: 457,
              startLine: 446,
            },
            {
              endLine: 526,
              startLine: 515,
            },
          ],
        ],
        duplicateLineCount: 48,
        duplicationRatio: 0.0894,
        maxDuplicateBlockSize: 114,
      },
      halstead: {
        distinctOperators: 23,
        distinctOperands: 280,
        totalOperators: 673,
        totalOperands: 1321,
        vocabulary: 303,
        length: 1994,
        volume: 16_436.8889,
        effort: 891_789.2788,
      },
    },
    oracleFunctions: [
      ['status', 67, 73, 'cognitive', 'sonarjs', 3],
      ['send', 111, 236, 'cognitive', 'sonarjs', 39],
      ['json', 250, 279, 'cognitive', 'sonarjs', 5],
      ['jsonp', 293, 352, 'cognitive', 'sonarjs', 11],
      ['sendStatus', 369, 376, 'cognitive', 'sonarjs', 1],
      ['(anonymous)', 449, 457, 'cognitive', 'sonarjs', 5],
      ['(anonymous)', 518, 526, 'cognitive', 'sonarjs', 5],
      ['contentType', 619, 625, 'cognitive', 'sonarjs', 1],
      ['(anonymous)', 684, 709, 'cognitive', 'sonarjs', 4],
      ['attachment', 719, 727, 'cognitive', 'sonarjs', 1],
      ['append', 744, 756, 'cognitive', 'sonarjs', 6],
      ['header', 777, 801, 'cognitive', 'sonarjs', 18],
      ['(anonymous)', 854, 887, 'cognitive', 'sonarjs', 8],
      ['location', 906, 916, 'cognitive', 'sonarjs', 2],
      ['redirect', 936, 980, 'cognitive', 'sonarjs', 6],
      ['(anonymous)', 991, 1001, 'cognitive', 'sonarjs', 3],
      ['(anonymous)', 1033, 1036, 'cognitive', 'sonarjs', 1],
      ['onaborted', 1048, 1055, 'cognitive', 'sonarjs', 1],
      ['ondirectory', 1058, 1065, 'cognitive', 'sonarjs', 1],
      ['onerror', 1068, 1072, 'cognitive', 'sonarjs', 1],
      ['onend', 1075, 1079, 'cognitive', 'sonarjs', 1],
      ['(anonymous)', 1092, 1101, 'cognitive', 'sonarjs', 3],
      ['headers', 1118, 1126, 'cognitive', 'sonarjs', 1],
      ['(anonymous)', 1153, 1165, 'cognitive', 'sonarjs', 1],
    ],
    knownDivergences: [
      ['(anonymous)', 90, 96, 'cognitive', 'sonarjs', 1, 2],
      ['sendFile', 419, 458, 'cognitive', 'sonarjs', 5, 14],
      ['(anonymous)', 501, 527, 'cognitive', 'sonarjs', 1, 10],
      ['download', 550, 599, 'cognitive', 'sonarjs', 14, 15],
      ['render', 1016, 1040, 'cognitive', 'sonarjs', 2, 5],
      ['sendfile', 1043, 1131, 'cognitive', 'sonarjs', 1, 26],
      ['onfinish', 1087, 1102, 'cognitive', 'sonarjs', 4, 9],
      ['stringify', 1145, 1169, 'cognitive', 'sonarjs', 4, 7],
    ],
  },
  {
    file: 'gin-1.9.1-gin.go',
    language: 'go',
    aggregates: {
      lines: {
        total: 712,
        code: 487,
        comment: 122,
        blank: 103,
      },
      cognitiveComplexity: 82,
      maxCognitiveComplexity: 30,
      nestingDepth: 3,
      ncssCount: 360,
      duplication: {
        duplicateBlockCount: 2,
        duplicateBlockGroupCount: 2,
        duplicateBlockGroups: [
          [
            {
              startLine: 496,
              endLine: 507,
            },
            {
              startLine: 556,
              endLine: 567,
            },
          ],
          [
            {
              startLine: 512,
              endLine: 530,
            },
            {
              startLine: 535,
              endLine: 552,
            },
          ],
        ],
        duplicateLineCount: 52,
        duplicationRatio: 0.1068,
        maxDuplicateBlockSize: 97,
      },
      halstead: {
        distinctOperators: 23,
        distinctOperands: 333,
        totalOperators: 553,
        totalOperands: 1300,
        vocabulary: 356,
        length: 1853,
        volume: 15_705.534,
        effort: 705_098.3003,
      },
    },
    oracleFunctions: [
      ['Last', 54, 59, 'cognitive', 'gocognit', 1],
      ['New', 183, 213, 'cognitive', 'gocognit', 0],
      ['Default', 216, 221, 'cognitive', 'gocognit', 0],
      ['Handler', 223, 230, 'cognitive', 'gocognit', 1],
      ['allocateContext', 232, 236, 'cognitive', 'gocognit', 0],
      ['Delims', 239, 242, 'cognitive', 'gocognit', 0],
      ['SecureJsonPrefix', 245, 248, 'cognitive', 'gocognit', 0],
      ['LoadHTMLGlob', 252, 264, 'cognitive', 'gocognit', 1],
      ['LoadHTMLFiles', 268, 276, 'cognitive', 'gocognit', 1],
      ['SetHTMLTemplate', 279, 285, 'cognitive', 'gocognit', 1],
      ['SetFuncMap', 288, 290, 'cognitive', 'gocognit', 0],
      ['NoRoute', 293, 296, 'cognitive', 'gocognit', 0],
      ['NoMethod', 299, 302, 'cognitive', 'gocognit', 0],
      ['Use', 307, 312, 'cognitive', 'gocognit', 0],
      ['rebuild404Handlers', 314, 316, 'cognitive', 'gocognit', 0],
      ['rebuild405Handlers', 318, 320, 'cognitive', 'gocognit', 0],
      ['addRoute', 322, 345, 'cognitive', 'gocognit', 3],
      ['Routes', 349, 354, 'cognitive', 'gocognit', 1],
      ['Run', 376, 388, 'cognitive', 'gocognit', 1],
      ['prepareTrustedCIDRs', 390, 417, 'cognitive', 'gocognit', 12],
      ['SetTrustedProxies', 427, 430, 'cognitive', 'gocognit', 0],
      ['isUnsafeTrustedProxies', 433, 435, 'cognitive', 'gocognit', 1],
      ['parseTrustedProxies', 438, 442, 'cognitive', 'gocognit', 0],
      ['isTrustedProxy', 445, 455, 'cognitive', 'gocognit', 4],
      ['validateHeader', 458, 477, 'cognitive', 'gocognit', 7],
      ['parseIP', 481, 491, 'cognitive', 'gocognit', 1],
      ['RunTLS', 496, 507, 'cognitive', 'gocognit', 1],
      ['RunUnix', 512, 530, 'cognitive', 'gocognit', 2],
      ['RunFd', 535, 552, 'cognitive', 'gocognit', 2],
      ['RunListener', 556, 567, 'cognitive', 'gocognit', 1],
      ['ServeHTTP', 570, 579, 'cognitive', 'gocognit', 0],
      ['HandleContext', 584, 590, 'cognitive', 'gocognit', 0],
      ['handleHTTPRequest', 592, 650, 'cognitive', 'gocognit', 30],
      ['serveError', 654, 669, 'cognitive', 'gocognit', 4],
      ['redirectTrailingSlash', 671, 685, 'cognitive', 'gocognit', 3],
      ['redirectFixedPath', 687, 697, 'cognitive', 'gocognit', 1],
      ['redirectRequest', 699, 711, 'cognitive', 'gocognit', 1],
    ],
    knownDivergences: [['iterate', 356, 371, 'cognitive', 'gocognit', 3, 2]],
  },
  {
    file: 'guava-33.0.0-Joiner.java',
    language: 'java',
    aggregates: {
      lines: {
        total: 519,
        code: 256,
        comment: 218,
        blank: 45,
      },
      cognitiveComplexity: 23,
      maxCognitiveComplexity: 10,
      nestingDepth: 2,
      ncssCount: 150,
      duplication: {
        duplicateBlockCount: 2,
        duplicateBlockGroupCount: 2,
        duplicateBlockGroups: [
          [
            {
              endLine: 282,
              startLine: 276,
            },
            {
              endLine: 289,
              startLine: 283,
            },
          ],
          [
            {
              endLine: 395,
              startLine: 392,
            },
            {
              endLine: 401,
              startLine: 398,
            },
          ],
        ],
        duplicateLineCount: 22,
        duplicationRatio: 0.0859,
        maxDuplicateBlockSize: 53,
      },
      halstead: {
        distinctOperators: 15,
        distinctOperands: 95,
        totalOperators: 265,
        totalOperands: 650,
        vocabulary: 110,
        length: 915,
        volume: 6204.9441,
        effort: 318_411.6071,
      },
    },
    oracleFunctions: [
      ['on', 71, 73, 'cognitive', 'pmd', 0],
      ['on', 71, 73, 'ncss', 'pmd', 2],
      ['on', 76, 78, 'cognitive', 'pmd', 0],
      ['on', 76, 78, 'ncss', 'pmd', 2],
      ['Joiner', 82, 84, 'cognitive', 'pmd', 0],
      ['Joiner', 82, 84, 'ncss', 'pmd', 2],
      ['Joiner', 86, 88, 'cognitive', 'pmd', 0],
      ['Joiner', 86, 88, 'ncss', 'pmd', 2],
      ['appendTo', 100, 104, 'cognitive', 'pmd', 0],
      ['appendTo', 100, 104, 'ncss', 'pmd', 2],
      ['appendTo', 112, 124, 'cognitive', 'pmd', 3],
      ['appendTo', 112, 124, 'ncss', 'pmd', 8],
      ['appendTo', 130, 136, 'cognitive', 'pmd', 0],
      ['appendTo', 130, 136, 'ncss', 'pmd', 3],
      ['appendTo', 139, 147, 'cognitive', 'pmd', 0],
      ['appendTo', 139, 147, 'ncss', 'pmd', 2],
      ['appendTo', 154, 158, 'cognitive', 'pmd', 0],
      ['appendTo', 154, 158, 'ncss', 'pmd', 2],
      ['appendTo', 167, 176, 'cognitive', 'pmd', 1],
      ['appendTo', 167, 176, 'ncss', 'pmd', 5],
      ['appendTo', 183, 188, 'cognitive', 'pmd', 0],
      ['appendTo', 183, 188, 'ncss', 'pmd', 3],
      ['appendTo', 195, 202, 'cognitive', 'pmd', 0],
      ['appendTo', 195, 202, 'ncss', 'pmd', 2],
      ['join', 208, 210, 'cognitive', 'pmd', 0],
      ['join', 208, 210, 'ncss', 'pmd', 2],
      ['join', 218, 220, 'cognitive', 'pmd', 0],
      ['join', 218, 220, 'ncss', 'pmd', 2],
      ['join', 226, 230, 'cognitive', 'pmd', 0],
      ['join', 226, 230, 'ncss', 'pmd', 3],
      ['join', 236, 239, 'cognitive', 'pmd', 0],
      ['join', 236, 239, 'ncss', 'pmd', 2],
      ['useForNull', 245, 263, 'cognitive', 'pmd', 2],
      ['toString', 248, 251, 'cognitive', 'pmd', 1],
      ['toString', 248, 251, 'ncss', 'pmd', 2],
      ['useForNull', 253, 256, 'cognitive', 'pmd', 0],
      ['useForNull', 253, 256, 'ncss', 'pmd', 2],
      ['skipNulls', 258, 261, 'cognitive', 'pmd', 0],
      ['skipNulls', 258, 261, 'ncss', 'pmd', 2],
      ['skipNulls', 269, 303, 'cognitive', 'pmd', 10],
      ['appendTo', 271, 291, 'cognitive', 'pmd', 6],
      ['appendTo', 271, 291, 'ncss', 'pmd', 14],
      ['useForNull', 293, 296, 'cognitive', 'pmd', 0],
      ['useForNull', 293, 296, 'ncss', 'pmd', 2],
      ['withKeyValueSeparator', 298, 301, 'cognitive', 'pmd', 0],
      ['withKeyValueSeparator', 298, 301, 'ncss', 'pmd', 2],
      ['withKeyValueSeparator', 311, 313, 'cognitive', 'pmd', 0],
      ['withKeyValueSeparator', 311, 313, 'ncss', 'pmd', 2],
      ['withKeyValueSeparator', 319, 321, 'cognitive', 'pmd', 0],
      ['withKeyValueSeparator', 319, 321, 'ncss', 'pmd', 2],
      ['MapJoiner', 345, 348, 'cognitive', 'pmd', 0],
      ['MapJoiner', 345, 348, 'ncss', 'pmd', 3],
      ['appendTo', 354, 357, 'cognitive', 'pmd', 0],
      ['appendTo', 354, 357, 'ncss', 'pmd', 2],
      ['appendTo', 364, 367, 'cognitive', 'pmd', 0],
      ['appendTo', 364, 367, 'ncss', 'pmd', 2],
      ['appendTo', 375, 379, 'cognitive', 'pmd', 0],
      ['appendTo', 375, 379, 'ncss', 'pmd', 2],
      ['appendTo', 387, 405, 'cognitive', 'pmd', 3],
      ['appendTo', 387, 405, 'ncss', 'pmd', 14],
      ['appendTo', 414, 417, 'cognitive', 'pmd', 0],
      ['appendTo', 414, 417, 'ncss', 'pmd', 2],
      ['appendTo', 426, 434, 'cognitive', 'pmd', 1],
      ['appendTo', 426, 434, 'ncss', 'pmd', 5],
      ['join', 440, 442, 'cognitive', 'pmd', 0],
      ['join', 440, 442, 'ncss', 'pmd', 2],
      ['join', 450, 452, 'cognitive', 'pmd', 0],
      ['join', 450, 452, 'ncss', 'pmd', 2],
      ['join', 460, 462, 'cognitive', 'pmd', 0],
      ['join', 460, 462, 'ncss', 'pmd', 2],
      ['useForNull', 468, 470, 'cognitive', 'pmd', 0],
      ['useForNull', 468, 470, 'ncss', 'pmd', 2],
      ['toString', 473, 493, 'cognitive', 'pmd', 1],
      ['toString', 473, 493, 'ncss', 'pmd', 3],
      ['iterable', 495, 517, 'cognitive', 'pmd', 2],
      ['size', 499, 502, 'cognitive', 'pmd', 0],
      ['size', 499, 502, 'ncss', 'pmd', 2],
      ['get', 504, 515, 'cognitive', 'pmd', 1],
      ['get', 504, 515, 'ncss', 'pmd', 8],
    ],
    knownDivergences: [
      ['useForNull', 245, 263, 'ncss', 'pmd', 3, 9],
      ['skipNulls', 269, 303, 'ncss', 'pmd', 2, 20],
      ['iterable', 495, 517, 'ncss', 'pmd', 3, 13],
    ],
  },
  {
    file: 'mattermost-5.39.0-login_controller.jsx',
    language: 'jsx',
    aggregates: {
      lines: {
        total: 886,
        code: 784,
        comment: 20,
        blank: 82,
      },
      cognitiveComplexity: 111,
      maxCognitiveComplexity: 22,
      nestingDepth: 2,
      ncssCount: 283,
      duplication: {
        duplicateBlockCount: 4,
        duplicateBlockGroupCount: 3,
        duplicateBlockGroups: [
          [
            {
              endLine: 205,
              startLine: 200,
            },
            {
              endLine: 213,
              startLine: 208,
            },
          ],
          [
            {
              endLine: 578,
              startLine: 564,
            },
            {
              endLine: 591,
              startLine: 578,
            },
          ],
          [
            {
              endLine: 700,
              startLine: 681,
            },
            {
              endLine: 721,
              startLine: 702,
            },
            {
              endLine: 742,
              startLine: 723,
            },
          ],
        ],
        duplicateLineCount: 100,
        duplicationRatio: 0.1276,
        maxDuplicateBlockSize: 74,
      },
      halstead: {
        distinctOperators: 27,
        distinctOperands: 395,
        totalOperators: 925,
        totalOperands: 1444,
        vocabulary: 422,
        length: 2369,
        volume: 20_660.284,
        effort: 1_019_624.2427,
      },
    },
    oracleFunctions: [
      ['constructor', 70, 93, 'cognitive', 'sonarjs', 4],
      ['componentDidMount', 95, 130, 'cognitive', 'sonarjs', 7],
      ['componentWillUnmount', 137, 142, 'cognitive', 'sonarjs', 1],
      ['(anonymous)', 144, 155, 'cognitive', 'sonarjs', 2],
      ['(anonymous)', 167, 173, 'cognitive', 'sonarjs', 1],
      ['(anonymous)', 185, 265, 'cognitive', 'sonarjs', 16],
      ['(anonymous)', 325, 344, 'cognitive', 'sonarjs', 5],
      ['(anonymous)', 392, 423, 'cognitive', 'sonarjs', 8],
      ['(anonymous)', 425, 433, 'cognitive', 'sonarjs', 1],
      ['(anonymous)', 440, 535, 'cognitive', 'sonarjs', 7],
      ['(anonymous)', 537, 816, 'cognitive', 'sonarjs', 22],
      ['render', 822, 882, 'cognitive', 'sonarjs', 5],
    ],
    knownDivergences: [
      ['(anonymous)', 157, 183, 'cognitive', 'sonarjs', 4, 7],
      ['(anonymous)', 270, 322, 'cognitive', 'sonarjs', 16, 18],
      ['(anonymous)', 362, 390, 'cognitive', 'sonarjs', 3, 4],
    ],
  },
  {
    file: 'nextjs-14.0.4-image-component.tsx',
    language: 'tsx',
    aggregates: {
      lines: {
        total: 417,
        code: 352,
        comment: 41,
        blank: 24,
      },
      cognitiveComplexity: 82,
      maxCognitiveComplexity: 48,
      nestingDepth: 4,
      ncssCount: 119,
      duplication: {
        duplicateBlockCount: 0,
        duplicateBlockGroupCount: 0,
        duplicateBlockGroups: [],
        duplicateLineCount: 0,
        duplicationRatio: 0,
        maxDuplicateBlockSize: 0,
      },
      halstead: {
        distinctOperators: 25,
        distinctOperands: 197,
        totalOperators: 286,
        totalOperands: 551,
        vocabulary: 222,
        length: 837,
        volume: 6523.9261,
        effort: 228_089.04,
      },
    },
    oracleFunctions: [
      ['getDynamicProps', 163, 178, 'cognitive', 'sonarjs', 3],
      ['(anonymous)', 230, 268, 'cognitive', 'sonarjs', 12],
      ['(anonymous)', 291, 301, 'cognitive', 'sonarjs', 2],
      ['ImagePreload', 307, 353, 'cognitive', 'sonarjs', 3],
      ['(anonymous)', 362, 367, 'cognitive', 'sonarjs', 1],
    ],
    knownDivergences: [
      ['handleLoading', 60, 161, 'cognitive', 'sonarjs', 3, 48],
      ['Image', 356, 415, 'cognitive', 'sonarjs', 1, 2],
    ],
  },
  {
    file: 'okhttp-4.12.0-Cookie.kt',
    language: 'kotlin',
    aggregates: {
      lines: {
        total: 614,
        code: 422,
        comment: 112,
        blank: 80,
      },
      cognitiveComplexity: 97,
      maxCognitiveComplexity: 36,
      nestingDepth: 3,
      ncssCount: 312,
      duplication: {
        duplicateBlockCount: 1,
        duplicateBlockGroupCount: 1,
        duplicateBlockGroups: [
          [
            {
              endLine: 165,
              startLine: 146,
            },
            {
              endLine: 200,
              startLine: 181,
            },
          ],
        ],
        duplicateLineCount: 36,
        duplicationRatio: 0.0853,
        maxDuplicateBlockSize: 105,
      },
      halstead: {
        distinctOperators: 24,
        distinctOperands: 245,
        totalOperators: 561,
        totalOperands: 1139,
        vocabulary: 269,
        length: 1700,
        volume: 13_721.486,
        effort: 765_490.9015,
      },
    },
    oracleFunctions: [],
    knownDivergences: [],
  },
  {
    file: 'rails-7.1.2-methods.rb',
    language: 'ruby',
    aggregates: {
      lines: {
        total: 388,
        code: 127,
        comment: 229,
        blank: 32,
      },
      cognitiveComplexity: 43,
      maxCognitiveComplexity: 10,
      nestingDepth: 2,
      ncssCount: 99,
      duplication: {
        duplicateBlockCount: 0,
        duplicateBlockGroupCount: 0,
        duplicateBlockGroups: [],
        duplicateLineCount: 0,
        duplicationRatio: 0,
        maxDuplicateBlockSize: 0,
      },
      halstead: {
        distinctOperators: 16,
        distinctOperands: 135,
        totalOperators: 163,
        totalOperands: 363,
        vocabulary: 151,
        length: 526,
        volume: 3807.4009,
        effort: 81_901.4237,
      },
    },
    oracleFunctions: [],
    knownDivergences: [],
  },
  {
    file: 'redis-7.2.3-intset.c',
    language: 'c',
    aggregates: {
      lines: {
        total: 561,
        code: 416,
        comment: 76,
        blank: 69,
      },
      cognitiveComplexity: 87,
      maxCognitiveComplexity: 24,
      nestingDepth: 3,
      ncssCount: 380,
      duplication: {
        duplicateBlockCount: 2,
        duplicateBlockGroupCount: 2,
        duplicateBlockGroups: [
          [
            {
              endLine: 481,
              startLine: 458,
            },
            {
              endLine: 527,
              startLine: 504,
            },
          ],
          [
            {
              endLine: 489,
              startLine: 482,
            },
            {
              endLine: 499,
              startLine: 492,
            },
          ],
        ],
        duplicateLineCount: 60,
        duplicationRatio: 0.1442,
        maxDuplicateBlockSize: 180,
      },
      halstead: {
        distinctOperators: 26,
        distinctOperands: 164,
        totalOperators: 464,
        totalOperands: 1211,
        vocabulary: 190,
        length: 1675,
        volume: 12_679.5081,
        effort: 1_217_155.4677,
      },
    },
    oracleFunctions: [],
    knownDivergences: [],
  },
  {
    file: 'requests-2.31.0-sessions.py',
    language: 'python',
    aggregates: {
      lines: {
        total: 834,
        code: 564,
        comment: 116,
        blank: 154,
      },
      cognitiveComplexity: 94,
      maxCognitiveComplexity: 26,
      nestingDepth: 3,
      ncssCount: 294,
      duplication: {
        duplicateBlockCount: 0,
        duplicateBlockGroupCount: 0,
        duplicateBlockGroups: [],
        duplicateLineCount: 0,
        duplicationRatio: 0,
        maxDuplicateBlockSize: 0,
      },
      halstead: {
        distinctOperators: 17,
        distinctOperands: 266,
        totalOperators: 521,
        totalOperands: 1135,
        vocabulary: 283,
        length: 1656,
        volume: 13_487.5541,
        effort: 489_177.3598,
      },
    },
    oracleFunctions: [
      ['merge_hooks', 91, 103, 'cognitive', 'complexipy', 4],
      ['get_redirect_target', 107, 125, 'cognitive', 'complexipy', 1],
      ['should_strip_auth', 127, 157, 'cognitive', 'complexipy', 6],
      ['resolve_redirects', 159, 281, 'cognitive', 'complexipy', 26],
      ['rebuild_auth', 283, 301, 'cognitive', 'complexipy', 4],
      ['rebuild_proxies', 303, 332, 'cognitive', 'complexipy', 4],
      ['rebuild_method', 334, 354, 'cognitive', 'complexipy', 6],
      ['__init__', 391, 451, 'cognitive', 'complexipy', 0],
      ['__enter__', 453, 454, 'cognitive', 'complexipy', 0],
      ['__exit__', 456, 457, 'cognitive', 'complexipy', 0],
      ['prepare_request', 459, 500, 'cognitive', 'complexipy', 4],
      ['get', 593, 602, 'cognitive', 'complexipy', 0],
      ['options', 604, 613, 'cognitive', 'complexipy', 0],
      ['head', 615, 624, 'cognitive', 'complexipy', 0],
      ['post', 626, 637, 'cognitive', 'complexipy', 0],
      ['put', 639, 649, 'cognitive', 'complexipy', 0],
      ['patch', 651, 661, 'cognitive', 'complexipy', 0],
      ['delete', 663, 671, 'cognitive', 'complexipy', 0],
      ['merge_environment_settings', 751, 780, 'cognitive', 'complexipy', 9],
      ['get_adapter', 782, 794, 'cognitive', 'complexipy', 3],
      ['close', 796, 799, 'cognitive', 'complexipy', 1],
      ['__setstate__', 816, 818, 'cognitive', 'complexipy', 1],
      ['session', 821, 833, 'cognitive', 'complexipy', 0],
    ],
    knownDivergences: [
      ['merge_setting', 61, 88, 'cognitive', 'complexipy', 7, 6],
      ['request', 502, 591, 'cognitive', 'complexipy', 1, 3],
      ['send', 673, 749, 'cognitive', 'complexipy', 14, 12],
      ['mount', 801, 810, 'cognitive', 'complexipy', 3, 2],
      ['__getstate__', 812, 814, 'cognitive', 'complexipy', 1, 0],
    ],
  },
  {
    file: 'ripgrep-14.1.0-gitignore.rs',
    language: 'rust',
    aggregates: {
      lines: {
        total: 817,
        code: 562,
        comment: 193,
        blank: 62,
      },
      cognitiveComplexity: 69,
      maxCognitiveComplexity: 18,
      nestingDepth: 3,
      ncssCount: 360,
      duplication: {
        duplicateBlockCount: 1,
        duplicateBlockGroupCount: 1,
        duplicateBlockGroups: [
          [
            {
              startLine: 763,
              endLine: 767,
            },
            {
              startLine: 776,
              endLine: 783,
            },
          ],
        ],
        duplicateLineCount: 13,
        duplicationRatio: 0.0231,
        maxDuplicateBlockSize: 41,
      },
      halstead: {
        distinctOperators: 23,
        distinctOperands: 388,
        totalOperators: 799,
        totalOperands: 1548,
        vocabulary: 411,
        length: 2347,
        volume: 20_378.9883,
        effort: 935_017.3956,
      },
    },
    oracleFunctions: [],
    knownDivergences: [],
  },
  {
    file: 'vscode-1.85.0-uri.ts',
    language: 'typescript',
    aggregates: {
      lines: {
        total: 746,
        code: 469,
        comment: 199,
        blank: 78,
      },
      cognitiveComplexity: 181,
      maxCognitiveComplexity: 32,
      nestingDepth: 4,
      ncssCount: 312,
      duplication: {
        duplicateBlockCount: 0,
        duplicateBlockGroupCount: 0,
        duplicateBlockGroups: [],
        duplicateLineCount: 0,
        duplicationRatio: 0,
        maxDuplicateBlockSize: 0,
      },
      halstead: {
        distinctOperators: 30,
        distinctOperands: 193,
        totalOperators: 706,
        totalOperands: 1233,
        vocabulary: 223,
        length: 1939,
        volume: 15_125.9449,
        effort: 1_449_504.4095,
      },
    },
    oracleFunctions: [
      ['_validateUri', 15, 44, 'cognitive', 'sonarjs', 14],
      ['_schemeFix', 50, 55, 'cognitive', 'sonarjs', 2],
      ['_referenceResolution', 58, 76, 'cognitive', 'sonarjs', 4],
      ['isUri', 100, 115, 'cognitive', 'sonarjs', 3],
      ['constructor', 157, 177, 'cognitive', 'sonarjs', 11],
      ['with', 214, 257, 'cognitive', 'sonarjs', 13],
      ['parse', 267, 280, 'cognitive', 'sonarjs', 6],
      ['file', 303, 328, 'cognitive', 'sonarjs', 7],
      ['joinPath', 356, 367, 'cognitive', 'sonarjs', 4],
      ['fsPath', 452, 457, 'cognitive', 'sonarjs', 1],
      ['toString', 459, 469, 'cognitive', 'sonarjs', 4],
      ['toJSON', 471, 504, 'cognitive', 'sonarjs', 7],
      ['encodeURIComponentMinimal', 596, 612, 'cognitive', 'sonarjs', 12],
      ['_asFormatted', 647, 715, 'cognitive', 'sonarjs', 32],
      ['decodeURIComponentGraceful', 719, 729, 'cognitive', 'sonarjs', 4],
      ['percentDecode', 733, 738, 'cognitive', 'sonarjs', 1],
    ],
    knownDivergences: [
      ['revive', 404, 415, 'cognitive', 'sonarjs', 7, 5],
      ['isUriComponents', 426, 435, 'cognitive', 'sonarjs', 10, 7],
      ['encodeURIComponentFast', 532, 594, 'cognitive', 'sonarjs', 36, 31],
      ['uriToFsPath', 617, 642, 'cognitive', 'sonarjs', 11, 12],
    ],
  },
];
