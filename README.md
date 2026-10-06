# code-gauge

[![npm version](https://img.shields.io/npm/v/code-gauge.svg)](https://www.npmjs.com/package/code-gauge)
[![license](https://img.shields.io/npm/l/code-gauge.svg)](https://www.npmjs.com/package/code-gauge)
[![Test](https://github.com/WillBooster/code-gauge/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/code-gauge/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/code-gauge/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/code-gauge/actions/workflows/test-rust.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.23.1-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

A command-line tool that ranks the files of a project by refactoring priority and checks code
against metric thresholds, built for AI-agent workflows: an agent asked to "refactor this
repository" runs `code-gauge` and starts from the top of the list, `code-gauge check` lists every
function, file, and duplicated block over a threshold, and a PR pipeline runs
`code-gauge check --base main` to make the agent fix the violations in the code its change touches.
Measurement uses tree-sitter, and the output is deliberately small — only the metrics that tell an
agent _what to change_ are measured and reported, so nothing in the output anchors an agent toward
out-of-scope "improvements". A [programmatic API](#programmatic-api) is also available.

## Getting started

```sh
# Run without installing
npx code-gauge path/to/project

# Or install globally
npm install -g code-gauge
code-gauge path/to/project
```

The CLI scans JavaScript, JSX, TypeScript, TSX, Python, Go, Rust, Java, Kotlin, C#, Ruby, C, and
C++ files. By default it skips generated, vendor, test, and tool directories as well as
[generated and excluded files](#excluded-files), and prints the top 10 refactoring candidates:

```
Measured 123 files under /path/to/project (code LOC 45678, NCSS 23456, functions 1789)

Refactoring candidates (top 10 of 123):
1. src/metrics.ts (score 2.87): worst function measure (L120-310) cognitive 42, NCSS 220, nesting 6; duplicated lines 180 (20%, shared with src/other.ts); file NCSS 1240
...
```

## Ranking model

Every file gets a score that is the sum of its repository-relative percentile ranks (each in `[0, 1)`)
over three dimensions:

- **Worst-function cognitive complexity** — the SonarSource cognitive-complexity model, the
  measure of understanding effort with the strongest empirical support among structural metrics.
- **Duplicated lines** — distinct lines covered by within-file duplicate blocks or cross-file
  duplicate occurrences (Type-1/2 clones, gapped and near-miss Type-3 clones).
- **File NCSS** — non-commenting source statements, a comment- and formatting-independent size
  measure calibrated against PMD's `NcssCount`.

Ranking is relative to the scanned project and ignores the
[thresholds](#threshold-check-code-gauge-check): the top of the list is worth refactoring first
regardless of where any cutoff would sit. Each reported file carries
the concrete evidence (worst function with location, duplication with partner files, file size) so
an agent can act on it directly.

## Options

The ranking command (`code-gauge [target]`, or spelled out, `code-gauge rank [target]`) accepts:

| Option                                     | Description                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| `--config <path>`                          | Use this config file instead of the auto-detected `code-gauge.config.json`.     |
| `--top <n>`                                | Number of top-ranked files to report (default: 10).                             |
| `--include-tests`                          | Include test files and test directories.                                        |
| `--json`                                   | Print machine-readable JSON.                                                    |
| `--fail-on-error`                          | Exit with code 1 when any file or directory cannot be scanned.                  |
| `--duplication-min-tokens <n>`             | Minimum normalized token count for a duplicate region (default 40).             |
| `--duplication-max-gap-tokens <n>`         | Maximum token gap merged into one gapped clone group; 0 disables (default 30).  |
| `--duplication-min-similarity-percent <n>` | Minimum similarity percent for near-miss clones; 100 = exact only (default 70). |

## Threshold check (`code-gauge check`)

```sh
code-gauge check                     # every violation in the current directory
code-gauge check --base main         # only violations in what the working tree changed since main
code-gauge check --base main src/api # the same, for the changed files under src/api
```

`code-gauge check [target]` reports every violation of the thresholds below, as a warning or as an
error, in the files under
the target. Inside a git repository it measures the repository's git-visible files (tracked, or
untracked and not ignored), so a block copied from a file outside the target is reported with that
file as its partner, and a copy that exists only in a git-ignored file is not duplication. The
built-in skipped directory names (`vendor`, `fixtures`, test directories, ...) apply below the
target, as in the ranking command, so `code-gauge check vendor` checks what is in `vendor`. A
git-ignored file is checked only when it is the target itself, and a directory git ignores (itself or
through a parent directory) is an error as the target (exit code 2). A directory git does not
ignore passes as a check of zero files when it holds no git-visible source file, for example when
its only sources are ignored build output. Outside a git repository it walks the target directory
like the ranking command. The thresholds:

| Config key                        | Violation                                         | Warning | Error |
| --------------------------------- | ------------------------------------------------- | ------- | ----- |
| `maxFunctionCognitiveComplexity`  | a function's cognitive complexity is above it     | 15      | 30    |
| `maxFunctionCyclomaticComplexity` | a function's cyclomatic complexity is above it    | off     | off   |
| `maxFunctionNcss`                 | a function's NCSS is above it                     | 60      | 100   |
| `maxFunctionNestingDepth`         | a function's nesting depth is above it            | 4       | 5     |
| `maxFunctionParameterCount`       | a function's parameter count is above it          | 7       | off   |
| `maxFunctionHalsteadVolume`       | a function's Halstead volume is above it          | off     | off   |
| `maxFunctionHalsteadDifficulty`   | a function's Halstead difficulty is above it      | off     | off   |
| `maxFunctionHalsteadEffort`       | a function's Halstead effort is above it          | off     | off   |
| `maxFunctionDepDegree`            | a function's DepDegree is above it                | off     | off   |
| `maxFileNcss`                     | a file's NCSS is above it                         | 500     | 1000  |
| `minDuplicateLines`               | a duplicated block spans at least this many lines | 10      | 20    |

Every threshold has a limit per level, and a value is reported at the most severe level whose limit
it violates. The warning limits mark code worth simplifying when it is touched; the error limits
mark code to fix, and only errors fail the check (exit code 1).

The warning limits follow common conventions. The error limits and the thresholds that are off
were set from the 2139 functions of [WillBooster/shared](https://github.com/WillBooster/shared)
(TypeScript, October 2026): a cognitive complexity above 15 flags 5% of them and one above 30 flags
1.5%, and the functions sampled above 30 each had a part that reads better extracted, while those
between 15 and 30 were mixed. Cyclomatic complexity, the Halstead metrics, and DepDegree are off
because, at limits of 10, 2000, 20, 30000, and 50, all but 24 of the 107 functions they flagged
there also exceeded the cognitive-complexity limit.

Cognitive complexity, NCSS, Halstead volume, and DepDegree of a function cover the functions nested
in it, so a limit of these that a function and a function nested in it both violate is reported
for the outer function only. The other limits measure a function's own body (or, for Halstead
difficulty and effort, a ratio that can be higher for the nested function alone) and are reported
for each function.

A duplicated block is one occurrence of a within-file or cross-file clone, found with the
[duplication detection settings](#duplication-detection-settings); its span runs from its first to
its last line. Occurrences of at least the warning or the error `minDuplicateLines` that overlap in a
file are reported as one block covering all of them, at the level its whole span reaches.

Each limit is set in the `warning` or `error` part of the
[`thresholds` config section](#configuration), where `null` disables it and `languages` overrides
limits for the files of one language, or with the command-line option named after the level and
the config key (`--warning-max-function-ncss 80`, `--error-min-duplicate-lines off`), where `off`
disables it. The command line wins over the whole config file, per-language overrides included.

With `--base <ref>`, the check covers only what the working tree changed since the merge-base of
`<ref>` and `HEAD` (committed, staged, unstaged, and untracked changes; nothing is checked out):

- a function, when a diff hunk touches its span; deleting lines inside the span counts, and so does
  deleting lines after the last line of a Python function (blank and comment-only lines aside), which may have been its
  tail;
- a file-level threshold, when the change adds or deletes lines of the file (a rename or a mode
  change alone does not count);
- a duplicated block, when it overlaps lines the change added.

`--base` only filters the report: the files measured and the duplication found are those of the
check without it, so code pasted from an unchanged file is reported where it was pasted. A
violation the change did not introduce is reported too once the change touches its function, file,
or duplicated block. `--base` requires a git repository.

When nothing violates a threshold, `check` prints a single line. Otherwise it prints a header with
the counts, one line per violation with the errors first, each level ordered by path and line, and
one remediation hint per violated metric:

```
Threshold violations: 1 errors, 2 warnings (1 functions, 0 files, 2 duplicated blocks) (4 files, 5 functions checked).
error: src/legacy.ts:1-21 decide: cognitive complexity 34 (max 30), nesting depth 5 (max 4)
warning: src/report.ts:1-12: duplicated lines 12 (max 9), also at src/summary.ts:1-12
warning: src/summary.ts:1-12: duplicated lines 12 (max 9), also at src/report.ts:1-12

How to fix:
- cognitive complexity: flatten nested branching with early returns and extract nested blocks into named functions.
- nesting depth: replace nested conditions with guard clauses or move inner blocks into functions.
- duplicated lines: extract the repeated code into one shared function or module and call it from every location.
```

A violation's level is that of its most severe limit. A function gets one line listing every
threshold it exceeds, each with the largest value its violated limit allows; a file-level violation
prints the path without a line span, and a duplicated block lists up to three of its other copies.
Paths are relative to the repository root, or to the target directory outside a git repository.

| Exit code | Meaning                                                                                                                          |
| --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0         | No errors; warnings do not fail the check.                                                                                       |
| 1         | Errors.                                                                                                                          |
| 2         | The check is incomplete: a file it covers could not be measured, or the arguments, config file, target, or base ref are invalid. |

A file that cannot be measured causes exit code 2 only when the check covers it: a file under the
target or, with `--base`, a changed file under the target. Other unmeasured files of the
repository are warnings on stderr.

`check` accepts `--config`, `--include-tests`, `--json`, and the `--duplication-*` options of the
ranking command.

### JSON report

`code-gauge check --json` prints:

```json
{
  "passed": false,
  "base": "main",
  "mergeBase": "9f624517156db3290e189b9fd0b8ed38de39a04c",
  "summary": {
    "violationCount": 2,
    "errorViolationCount": 1,
    "warningViolationCount": 1,
    "functionViolationCount": 1,
    "fileViolationCount": 0,
    "duplicationViolationCount": 1,
    "checkedFileCount": 2,
    "checkedFunctionCount": 2
  },
  "violations": [
    {
      "kind": "function",
      "level": "error",
      "file": "src/legacy.ts",
      "startLine": 1,
      "endLine": 21,
      "exceeded": [
        { "metric": "functionCognitiveComplexity", "value": 34, "level": "error", "limit": 30 },
        { "metric": "functionNestingDepth", "value": 5, "level": "warning", "limit": 4 }
      ],
      "name": "decide"
    },
    {
      "kind": "duplication",
      "level": "warning",
      "file": "src/pasted.ts",
      "startLine": 1,
      "endLine": 12,
      "exceeded": [{ "metric": "duplicateLines", "value": 12, "level": "warning", "limit": 10 }],
      "partners": [{ "file": "src/report.ts", "startLine": 1, "endLine": 12 }]
    }
  ],
  "errors": [],
  "warnings": []
}
```

- `passed`: `true` when no violation is an error and every covered file was measured (exit code 0).
- `base`, `mergeBase`: the `--base` ref and the commit compared against; absent without `--base`.
- `summary`: the violation counts in total, per level, and per kind, and the number of files and
  functions checked: those under the target or, with `--base`, the changed files under it and the
  functions the change touches.
- `violations`: the errors first, each level ordered by `file`, then `startLine`. Each has
  - `kind`: `function`, `file`, or `duplication`;
  - `level`: `error` when any of its `exceeded` limits is an error, otherwise `warning`;
  - `file`, `startLine`, `endLine`: the 1-based line span of the function or duplicated block; for
    kind `file`, the first and last line of the file;
  - `name`: only for kind `function`; `<anonymous>` for a function without a name;
  - `exceeded`: every violated threshold with its `metric` (the config key without its `max` or
    `min` prefix, e.g. `functionNcss` for `maxFunctionNcss`), the measured `value`, the most severe
    `level` whose limit the value violates, and that `limit`. A value violates when it is above the
    limit; `duplicateLines` violates from the limit on;
  - `partners`: only for kind `duplication`; every other copy of the block, ordered by `file`, then
    `startLine`.
- `errors`: the files the check covers that could not be measured (exit code 2); unrelated to the
  `error` level of a violation.
- `warnings`: files measured without cross-file duplication data, and unmeasured files of the
  repository the check does not cover.

## Configuration

`code-gauge` looks for `code-gauge.config.json` by walking up from the target directory (override
with `--config`). The following config reproduces every built-in default:

```json
{
  "duplication": {
    "minTokens": 40,
    "maxGapTokens": 30,
    "minSimilarityPercent": 70
  },
  "rank": { "top": 10 },
  "thresholds": {
    "warning": {
      "maxFunctionCognitiveComplexity": 15,
      "maxFunctionCyclomaticComplexity": null,
      "maxFunctionNcss": 60,
      "maxFunctionNestingDepth": 4,
      "maxFunctionParameterCount": 7,
      "maxFunctionHalsteadVolume": null,
      "maxFunctionHalsteadDifficulty": null,
      "maxFunctionHalsteadEffort": null,
      "maxFunctionDepDegree": null,
      "maxFileNcss": 500,
      "minDuplicateLines": 10,
      "languages": {}
    },
    "error": {
      "maxFunctionCognitiveComplexity": 30,
      "maxFunctionCyclomaticComplexity": null,
      "maxFunctionNcss": 100,
      "maxFunctionNestingDepth": 5,
      "maxFunctionParameterCount": null,
      "maxFunctionHalsteadVolume": null,
      "maxFunctionHalsteadDifficulty": null,
      "maxFunctionHalsteadEffort": null,
      "maxFunctionDepDegree": null,
      "maxFileNcss": 1000,
      "minDuplicateLines": 20,
      "languages": {}
    }
  },
  "exclude": [],
  "includeTests": false,
  "failOnError": false
}
```

The command line wins over the config file, which wins over the defaults. Unknown settings are
rejected so stale configuration fails loudly. `rank.top` and `failOnError` apply to the ranking
command only.

`languages` in a level of `thresholds` maps a language name (`javascript`, `jsx`, `typescript`,
`tsx`, `python`, `go`, `rust`, `java`, `ruby`, `c`, `cpp`, `csharp`, `kotlin`) to the limits that
differ for its files; a limit it leaves out keeps the value set outside `languages`:

```json
{
  "thresholds": {
    "warning": {
      "maxFunctionNcss": 60,
      "maxFunctionParameterCount": 5,
      "languages": {
        "tsx": { "maxFunctionNcss": 100 },
        "python": { "maxFunctionParameterCount": null }
      }
    }
  }
}
```

### Excluded files

Every command skips, besides the built-in directories and file names:

- files matching an `exclude` glob pattern (e.g. `"exclude": ["src/legacy/**", "**/*.pb.ts"]`),
  relative to the config file's directory and matched with Node's `path.posix.matchesGlob` (forward slashes on every platform);
- files git attributes mark `linguist-generated` or `linguist-vendored` (the attributes GitHub
  uses to collapse generated diffs, e.g. `src/api/** linguist-generated` in `.gitattributes`);
- files with a generated-code marker in their first 5 lines: an `@generated` tag or a line
  mentioning "generated" followed by "do not edit" / "do not modify" (e.g. Go's
  `// Code generated by <tool>. DO NOT EDIT.`). Mark a hand-written file `-linguist-generated` to
  keep it measured despite such a line.

Inside a git repository, `code-gauge check` additionally skips the files git ignores (see
[Threshold check](#threshold-check-code-gauge-check)).

A file passed as the explicit target is always measured.

### Duplication detection settings

The `duplication` section tunes how clones are detected:

- `minTokens` (default 40): minimum normalized token count for a region to count as a duplicate.
  Raise it to report only substantial copies; lower it to catch small ones.
- `maxGapTokens` (default 30): copies edited in one spot split into two exact matches around the
  edit; adjacent matches separated by at most this many tokens are merged back into a single gapped
  (Type-3) clone group. `0` disables merging. Applies to within-file detection and to cross-file
  matching alike.
- `minSimilarityPercent` (default 70): blocks the exact pipeline misses are additionally compared by
  similarity (n-gram filtration, then token-level longest-common-subsequence verification, following
  NIL and NiCad), so a near-miss (Type-3) clone with scattered small edits is still reported when
  both blocks are at least this similar and share more than half of their content-bearing tokens
  (names and literal values, weighted by rarity so ubiquitous names count less, after ECScan). Two
  refinements apply the same threshold: blocks whose top-level statements were reordered are also
  compared in a canonical statement order, and a copy embedded in added code (on one side or both)
  is matched on its cores, provided the two blocks are within 3 times each other's length (a
  threshold below 34% widens this to whatever the threshold allows): the chain of n-grams unique to
  both blocks (only those continuing a diagonal run) is split at gaps of more than 30 tokens, each
  segment must pass the same threshold on its own, and the verified cores, not the whole blocks,
  are reported. `100` disables near-miss detection. Applies to within-file detection and to cross-file matching alike; across files,
  n-grams shared by more than 1000 blocks (syntax boilerplate) are left out of the filtration index
  so boilerplate cannot make candidate counting quadratic in the block count.

## Metrics

`measureCode` reports, per file:

- Physical LOC, code lines, comment-only lines, and blank lines
- Per-function cognitive complexity (following the SonarSource specification, except its recursion
  increment, which is not counted; cross-validated against PMD's Java rules), plus the file-level
  total and maximum
- Per-function and per-file NCSS (non-commenting source statements), calibrated against PMD's
  `NcssCount` rule for Java and generalized to every supported language; unlike PMD, package and
  import declarations count, and statement-shaped content is counted uniformly in expression
  positions too
- Per-function and file-level nesting depth
- Per-function cyclomatic complexity (McCabe, own body only), counted as NIST SP 500-235 defines it:
  every decision and short-circuit operator adds one, one per case-labelled statement, plus the
  file total over McCabe's components (every function, every initializer block, decisions outside
  functions, and the module body of a file that runs top-level code)
- Per-function parameter counts and locations (name, node type, line span)
- Within-file duplication: copy-pasted blocks matched on normalized tokens (identifiers anonymized
  consistently, literals by kind, and literal-dense data tables excluded unless their values also
  match; dependency declarations such as imports, package clauses, `#include`s, re-exports, and
  `require`s carry no tokens, since every module must spell out its own), with adjacent matches around a small edit merged into gapped (Type-3) clone groups and
  near-miss (Type-3) clones matched by token-LCS similarity (tolerating reordered statements and
  copies embedded in added code), plus duplicated line count and ratio
- Cross-file duplication (via `measureCrossFileDuplication`): copy-pasted blocks shared between
  files, matched with the same normalization (exact, gapped, and near-miss clones) and reported as
  groups with their file locations
- Halstead base counts, vocabulary, length, volume, difficulty (half the distinct operators times
  the total operands per distinct operand; 0 without operands), and effort (difficulty times
  volume), per function and per file
- Per-function DepDegree (Beyer & Fararooy 2010), approximated as the number of variable reads
  with a preceding same-name definition (declaration, assignment, or parameter) in the function —
  a file-local single-assignment approximation

Metrics that the validation literature shows to be weakly grounded or that invite misdirected
"improvements" (call-graph fan-in/fan-out, coupling and cohesion counts, maintainability index,
and similar) are intentionally not measured; see
[issue #44](https://github.com/WillBooster/code-gauge/issues/44) for the rationale and references.

## Supported languages

Built-in parsers cover JavaScript, JSX, TypeScript, TSX, Python, Go, Rust, Java, Kotlin, C#, Ruby,
C, and C++. The language set is fixed by design: every metric is calibrated per grammar, and
supporting arbitrary grammars would mean shipping incomplete metrics for them.

## Native (Rust) engine

Parsing and every metric pass run in a Rust addon (tree-sitter); the thin TypeScript layer handles
the CLI, cross-file matching, and the Halstead float derivations. Releases include prebuilt addons
for Linux x64/arm64 (glibc and musl), macOS x64/arm64, and Windows x64, and a release that
includes them runs no install script. On other platforms, build the addon from the bundled sources inside the installed
package, which requires a [Rust toolchain](https://rustup.rs) (the runtime error message points
here too):

```sh
node node_modules/code-gauge/scripts/buildNative.mjs
```

In this repository, build it with `bun run build-native` and benchmark with `bun run benchmark`
(requires `bun run build` first).

## Programmatic API

```ts
import { measureCode } from 'code-gauge';

const metrics = measureCode(
  `
function score(value) {
  if (value < 0 || value == null) {
    return 0;
  }
  return value > 10 ? 10 : value;
}
`,
  { language: 'javascript' }
);

console.log(metrics.maxCognitiveComplexity);
```

`detectLanguage(filePath)` maps a file extension to a supported language (or `undefined`) with the
same table as the CLI, so `measureCode` can be fed arbitrary source files. Unlike the CLI scan, it
does not skip generated files (e.g. `.d.ts`, `.min.js`) or test files.

### Cloudflare Workers

Workers cannot load native addons, so the package's `workerd` export runs the same API on a
WebAssembly build of the Rust engine (about 2.3 MB gzipped). Wrangler resolves that export
automatically, and no `nodejs_compat` flag is needed:

```ts
import { measureCode } from 'code-gauge';

export default {
  async fetch(request: Request): Promise<Response> {
    const code = await request.text();
    return Response.json(measureCode(code, { language: 'typescript' }));
  },
};
```

Only the programmatic API is available; the CLI needs a file system and `git`. The Workers
runtime's stack limits nesting to a few thousand syntax-tree levels (the native addon allows
5,000); deeper sources fail with an error instead of being measured.

In this repository, build the WebAssembly module with `bun run build-wasm`. It downloads a
[wasi-sdk](https://github.com/WebAssembly/wasi-sdk) release for the grammars' C sources unless
`WASI_SDK_PATH` points to an installation of the same release.
