# code-gauge

[![npm version](https://img.shields.io/npm/v/code-gauge.svg)](https://www.npmjs.com/package/code-gauge)
[![Test](https://github.com/WillBooster/code-gauge/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/code-gauge/actions/workflows/test.yml)
[![Test rust](https://github.com/WillBooster/code-gauge/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/code-gauge/actions/workflows/test-rust.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-20.3.0-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

A command-line tool that ranks the files of a project by refactoring priority and gates changes
against metric regressions, built for AI-agent workflows: an agent asked to "refactor this
repository" runs `code-gauge` and starts from the top of the list, and a PR pipeline runs
`code-gauge diff --base main` to force the agent to self-correct a change that made the code worse.
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
C++ files. By default it skips generated, vendor, test, and tool directories and prints the top 10
refactoring candidates:

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

Ranking is relative to the scanned project, so no absolute thresholds are involved: the top of the
list is worth refactoring first regardless of where any cutoff would sit. Each reported file carries
the concrete evidence (worst function with location, duplication with partner files, file size) so
an agent can act on it directly.

## Options

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

## Regression gate (`code-gauge diff`)

```sh
code-gauge diff --base main          # gate the working tree against the merge-base with main
code-gauge diff --base main src/api  # gate only the changed files under src/api
```

`code-gauge diff --base <ref>` measures every changed file at both revisions (working tree vs. the
merge-base of `<ref>` and `HEAD`, read with `git cat-file` — no checkout, no persisted baseline, so
it works identically in CI and locally) and reports **only violations**. When every gate passes it
prints a single line and exits 0; violations print one line each — metric, base → head values, the
`file:line` span, and a remediation direction — and exit 1 (2 when files cannot be measured).

Functions are matched across revisions by name and arity, then by name alone, and finally by
normalized-token LCS similarity, so renames and moves don't appear as delete+add. The gates:

- **Existing functions — no worsening.** A matched function must not worsen its cognitive
  complexity, NCSS, max nesting depth, DepDegree (approximate def-use pairs, Beyer & Fararooy
  2010), or Halstead volume beyond a small configurable tolerance. No absolute threshold is
  involved: "your change made this function worse" is defensible regardless of metric calibration.
- **New functions — absolute thresholds.** Functions with no base counterpart are the one place
  absolutes are required (SonarQube-style "Clean as You Code"): cognitive complexity ≤ 15, NCSS
  ≤ 60, nesting depth ≤ 4 by default.
- **No new duplication.** A changed file's duplicated lines (within-file plus cross-file against
  the whole project, so copy-paste from unchanged code into new files is caught) must not exceed
  the base revision's count.
- **Anti-gaming backstops.** Splitting a function resets its entity identity and could hide a
  worsening behind the laxer new-code thresholds, so when a removed named function's content
  partially reappears in unmatched new code the file's max cognitive complexity and total NCSS
  ratchet too; purely additive changes and unrelated remove-plus-add changes stay ungated.

`--full` additionally prints the base → head values of every checked function; `--json` prints a
machine-readable report. The duplication flags and `--include-tests` work like the ranking command.
The duplication universes contain only git-visible files (tracked or untracked non-ignored), so
local ignored artifacts cannot skew the counts, and the Halstead volume allowance scales with the
base value (25%, floored at the configured tolerance) so it admits the same ~5-statement edit at
every function size.

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
  "gate": {
    "newFunction": {
      "maxCognitiveComplexity": 15,
      "maxNcss": 60,
      "maxNestingDepth": 4
    },
    "tolerance": {
      "cognitiveComplexity": 2,
      "ncss": 5,
      "nestingDepth": 1,
      "depDegree": 10,
      "halsteadVolume": 150,
      "fileNcss": 20,
      "duplicateLines": 0
    },
    "matchSimilarityPercent": 70
  },
  "includeTests": false,
  "failOnError": false
}
```

The command line wins over the config file, which wins over the defaults. Unknown settings are
rejected so stale configuration fails loudly.

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
  both blocks are at least this similar and share more than half of their content-bearing tokens.
  `100` disables near-miss detection. Applies to within-file detection only.

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
- Per-function parameter counts and locations (name, node type, line span)
- Within-file duplication: copy-pasted blocks matched on normalized tokens (identifiers anonymized
  consistently, literals by kind, and literal-dense data tables excluded unless their values also
  match), with adjacent matches around a small edit merged into gapped (Type-3) clone groups and
  near-miss (Type-3) clones matched by token-LCS similarity, plus duplicated line count and ratio
- Cross-file duplication (via `measureCrossFileDuplication`): copy-pasted blocks shared between
  files, matched with the same normalization and reported as groups with their file locations
- Halstead base counts, vocabulary, length, volume, and effort, per function and per file — the
  strongest correlates of measured cognitive load in the EEG/fMRI validation literature
- Per-function DepDegree (Beyer & Fararooy 2010), approximated as the number of variable reads
  with a preceding same-name definition (declaration, assignment, or parameter) in the function —
  a file-local single-assignment approximation that is stable enough for regression ratcheting

Metrics that the validation literature shows to be weakly grounded or that invite misdirected
"improvements" (cyclomatic complexity, call-graph fan-in/fan-out, coupling and cohesion counts,
maintainability index, and similar) are intentionally not measured; see
[issue #44](https://github.com/WillBooster/code-gauge/issues/44) for the rationale and references.

## Supported languages

Built-in parsers cover JavaScript, JSX, TypeScript, TSX, Python, Go, Rust, Java, Kotlin, C#, Ruby,
C, and C++. The language set is fixed by design: every metric is calibrated per grammar, and
supporting arbitrary grammars would mean shipping incomplete metrics for them.

## Native (Rust) engine

Parsing and every metric pass run in a Rust addon (tree-sitter); the thin TypeScript layer handles
the CLI, cross-file matching, and the Halstead float derivations. Releases include prebuilt addons
for Linux x64/arm64 (glibc and musl), macOS x64/arm64, and Windows x64. On other platforms,
`postinstall` builds the addon from the bundled sources, which requires a
[Rust toolchain](https://rustup.rs).

If a prebuilt addon is unavailable, package managers that block dependency install scripts by
default (recent npm versions, and Bun unless `code-gauge` is listed in `trustedDependencies`) skip
the fallback build. Either approve `code-gauge`'s install script, or build the addon manually
inside the installed package (the runtime error message points here too):

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
