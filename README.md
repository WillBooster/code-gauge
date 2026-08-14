# code-gauge

[![Test rust](https://github.com/WillBooster/code-gauge/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/code-gauge/actions/workflows/test-rust.yml)
[![Test](https://github.com/WillBooster/code-gauge/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/code-gauge/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-18.3.0-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

A command-line tool that ranks the files of a project by refactoring priority, built for AI-agent
workflows: an agent asked to "refactor this repository" runs `code-gauge` and starts from the top of
the list. Measurement uses tree-sitter, and the output is deliberately small — only the metrics that
tell an agent _what to change_ are measured and reported, so nothing in the output anchors an agent
toward out-of-scope "improvements". A [programmatic API](#programmatic-api) is also available.

## Getting started

```sh
# Run without installing
npx code-gauge path/to/project

# Or install globally
npm install -g code-gauge
code-gauge path/to/project
```

The CLI scans JavaScript, JSX, TypeScript, TSX, Python, Go, Rust, Java, Ruby, C, and C++ files. By
default it skips generated, vendor, test, and tool directories and prints the top 10 refactoring
candidates:

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

Custom detection settings are measured by the TypeScript backend; the native backend implements the
defaults only.

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
- Halstead base counts, vocabulary, length, volume, and effort

Metrics that the validation literature shows to be weakly grounded or that invite misdirected
"improvements" (cyclomatic complexity, call-graph fan-in/fan-out, coupling and cohesion counts,
maintainability index, and similar) are intentionally not measured; see
[issue #44](https://github.com/WillBooster/code-gauge/issues/44) for the rationale and references.

## Supported languages

Built-in parsers cover JavaScript, JSX, TypeScript, TSX, Python, Go, Rust, Java, Ruby, C, and C++.
Additional tree-sitter grammars can be registered with `TreeMeasurer.registerLanguage`.

## Native (Rust) backend

Measurement is also implemented as a Rust addon that produces bit-identical metrics roughly 13x
faster than the TypeScript backend (the tree-sitter grammar crates are pinned to the same versions
as the npm grammar packages). With a [Rust toolchain](https://rustup.rs) installed, build it once:

```sh
yarn build-native
```

`measureCode` and the CLI pick up `native/code-gauge.node` automatically and fall back to the
TypeScript implementation when the addon is missing (for example, on npm installs) or when a custom
language has been registered. Set `CODE_GAUGE_NATIVE=0` to force the TypeScript backend, and compare
both with `yarn benchmark` (requires `yarn build` first). `isNativeBackendAvailable()` reports which
backend is in use.

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
