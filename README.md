# code-gauge

[![Test rust](https://github.com/WillBooster/code-gauge/actions/workflows/test-rust.yml/badge.svg)](https://github.com/WillBooster/code-gauge/actions/workflows/test-rust.yml)
[![Test](https://github.com/WillBooster/code-gauge/actions/workflows/test.yml/badge.svg)](https://github.com/WillBooster/code-gauge/actions/workflows/test.yml)
[![semantic-release](https://img.shields.io/badge/%20%20%F0%9F%93%A6%F0%9F%9A%80-semantic--release-e10079.svg)](https://github.com/semantic-release/semantic-release)
[![wbfy](https://img.shields.io/badge/wbfy-18.3.0-1e90ff.svg)](https://github.com/WillBooster/shared/tree/main/packages/wbfy)

A command-line tool for measuring code metrics with tree-sitter. It scans a project and reports high-risk files, functions, and React components so you can spot code that is worth refactoring. A [programmatic API](#programmatic-api) is also available.

## Getting started

```sh
# Run without installing
npx code-gauge path/to/project

# Or install globally
npm install -g code-gauge
code-gauge path/to/project
```

The CLI scans JavaScript, JSX, TypeScript, TSX, Python, Go, Rust, Java, Ruby, C, and C++ files. By default it skips generated, vendor, test, and tool directories, prints a summary, and lists the highest-risk findings. TypeScript project metrics and React component classification turn on automatically when a `tsconfig.json` is found.

## Options

| Option                     | Description                                                                 |
| -------------------------- | --------------------------------------------------------------------------- |
| `--config <path>`          | Use this config file instead of the auto-detected `code-gauge.config.json`. |
| `--include-tests`          | Include test files and test directories.                                    |
| `--tsconfig <path>`        | Use this `tsconfig.json` instead of the auto-detected one.                  |
| `--max-findings <n>`       | Maximum number of findings to print (default: 20).                          |
| `--largest-files <n>`      | List the `n` largest files by code LOC (config key: `largestFiles`).        |
| `--json`                   | Print machine-readable JSON.                                                |
| `--fail-on-risk`           | Exit with code 1 when any high-risk finding is reported.                    |
| `--fail-on-error`          | Exit with code 1 when any file or directory cannot be scanned.              |
| `--<metric>-threshold <n>` | Override a risk threshold (see below).                                      |

## Risk thresholds

A finding is reported when a measured value is **greater than or equal to** its threshold. Every threshold can be set on the command line (e.g. `--file-loc-threshold 400`) or in a config file; the command line wins over the config file, which wins over the defaults.

`code-gauge` looks for `code-gauge.config.json` by walking up from the target directory (override with `--config`). The following config reproduces every built-in default:

```json
{
  "thresholds": {
    "fileLoc": 500,
    "functionLoc": 120,
    "componentLoc": 350,
    "cognitive": 25,
    "cyclomatic": 20,
    "call": 50,
    "import": 25,
    "fanOut": 10,
    "parameter": 8,
    "duplicateBlock": 2,
    "duplicationRatioPercent": 30,
    "crossFileDuplicateBlock": 2,
    "transitiveDependency": 25,
    "structuralBreadth": 8,
    "structuralCoordination": 300,
    "stateMutation": 50,
    "duplicateSymbolGroup": 5
  },
  "duplication": {
    "minTokens": 40,
    "maxGapTokens": 30,
    "minSimilarityPercent": 70
  },
  "languageThresholds": {
    "python": { "stateMutation": 90, "structuralCoordination": 350 },
    "ruby": { "stateMutation": 90, "structuralCoordination": 350 },
    "react": { "import": 30 }
  },
  "maxFindings": 20,
  "includeTests": false,
  "failOnRisk": false,
  "failOnError": false
}
```

| Threshold                 | CLI flag                                 | Reports when a …                                       |
| ------------------------- | ---------------------------------------- | ------------------------------------------------------ |
| `fileLoc`                 | `--file-loc-threshold`                   | file's code LOC is large.                              |
| `functionLoc`             | `--function-loc-threshold`               | function's physical LOC span is large.                 |
| `componentLoc`            | `--component-loc-threshold`              | React component's physical LOC span is large.          |
| `cognitive`               | `--cognitive-threshold`                  | function's cognitive complexity is high.               |
| `cyclomatic`              | `--cyclomatic-threshold`                 | function's cyclomatic complexity is high.              |
| `call`                    | `--call-threshold`                       | function makes many calls.                             |
| `import`                  | `--import-threshold`                     | file has many unique import sources.                   |
| `fanOut`                  | `--fan-out-threshold`                    | function calls many other in-file functions.           |
| `parameter`               | `--parameter-threshold`                  | function declares many parameters.                     |
| `duplicateBlock`          | `--duplicate-block-threshold`            | file contains copy-pasted code blocks.                 |
| `duplicationRatioPercent` | `--duplication-ratio-percent-threshold`  | large percentage of a file's code lines is duplicated. |
| `crossFileDuplicateBlock` | `--cross-file-duplicate-block-threshold` | file shares copy-pasted code blocks with other files.  |
| `transitiveDependency`    | `--transitive-dependency-threshold`      | file transitively reaches many local files.            |
| `structuralBreadth`       | `--structural-breadth-threshold`         | file coordinates many structural concerns.             |
| `structuralCoordination`  | `--structural-coordination-threshold`    | file's structural coordination score is high.          |
| `stateMutation`           | `--state-mutation-threshold`             | file mutates state heavily.                            |
| `duplicateSymbolGroup`    | `--duplicate-symbol-group-threshold`     | file shares many duplicated symbols with others.       |

### Per-language thresholds

Some metrics distribute very differently by language or file type, so a single global threshold either
over-flags one language or under-flags another. `languageThresholds` overrides individual thresholds for a
profile without repeating the whole set. Each file resolves its thresholds as **base → its language profile →
the `react` profile** (the last applies when the file contains a React component), so later profiles win.

Valid profile keys are `javascript`, `jsx`, `typescript`, `tsx`, `python`, `go`, `rust`, `java`, `ruby`, `c`,
`cpp`, and `react`. Built-in
overrides raise `stateMutation` and `structuralCoordination` for Python and Ruby (every binding is an
assignment, so these run far higher than in TypeScript) and raise `import` for React files (which pull in
many components).
Anything you specify is merged on top of the built-in overrides, so `{ "python": { "stateMutation": 8 } }`
restores the global value for Python while keeping the other built-in adjustments.

```json
{
  "languageThresholds": {
    "python": { "stateMutation": 120 },
    "react": { "componentLoc": 400, "import": 35 }
  }
}
```

Command-line `--<metric>-threshold` flags set the global base only; use the config file for per-language tuning.

### Duplication detection settings

The `duplication` config section (or the `--duplication-min-tokens`, `--duplication-max-gap-tokens`, and `--duplication-min-similarity-percent` flags) tunes how clones are detected rather than when they are reported:

- `minTokens` (default 40): minimum normalized token count for a region to count as a duplicate. Raise it to report only substantial copies; lower it to catch small ones.
- `maxGapTokens` (default 30): copies edited in one spot split into two exact matches around the edit; adjacent matches separated by at most this many tokens are merged back into a single gapped (Type-3) clone group. `0` disables merging. Applies to within-file detection and to cross-file matching alike: cross-file candidates are joined by a project-level window index over per-statement fingerprint sequences, and gap-adjacent cross-file matches merge into gapped clone groups the same way. Merging changes only the grouping, not the counting: each matched fragment still counts toward `duplicateBlock` (and each token span counts at most once), so an edited two-fragment pair keeps counting 2.
- `minSimilarityPercent` (default 70): blocks the exact pipeline misses are additionally compared by similarity (n-gram filtration, then token-level longest-common-subsequence verification, following NIL and NiCad), so a near-miss (Type-3) clone with scattered small edits is still reported when both blocks are at least this similar and share more than half of their content-bearing tokens (names and literal values). `100` disables near-miss detection and reports exact (Type-1/2) matches plus gapped merges only. Applies to within-file detection only; literal-dense (data-table) blocks never near-miss match. A near-miss occurrence counts all of its code lines (edited lines included) toward `duplicateLineCount`, because the whole fragment is the clone.

Custom detection settings are measured by the TypeScript backend; the native backend implements the defaults only.

## Metrics

- Physical LOC, code lines, comment-only lines, and blank lines
- Function and class counts
- Cyclomatic and cognitive complexity (per function and maximum), following the SonarSource cognitive-complexity specification (except its recursion increment, which is not counted) and cross-validated against PMD's Java rules
- NCSS (non-commenting source statements, per function and per file), calibrated against PMD's `NcssCount` rule for Java and generalized to every supported language; unlike PMD, package and import declarations count (PMD counts them only with `NcssOption.COUNT_IMPORTS`), and statement-shaped content is counted uniformly in expression positions too (PMD's visitor never descends into lambdas or anonymous classes passed as call arguments, switch-expression bodies, or expression-bodied arrow cases)
- Nesting depth
- Intra-file call graph metrics: call counts, fan-in/fan-out, recursion, call depth, and parameter counts
- Within-file duplication: copy-pasted blocks and statement runs matched on normalized tokens (identifiers anonymized consistently, literals by kind, and literal-dense data tables excluded unless their values also match), with adjacent matches around a small edit merged into gapped (Type-3) clone groups, plus duplicated line count and ratio
- Cross-file duplication: copy-pasted blocks shared between files, matched with the same normalization and reported as groups with their file locations
- File coupling (imports/exports) and cohesion (shared function identifiers)
- Architecture metrics: transitive local dependencies, structural coordination and breadth, state mutation, and cross-file duplicate symbols
- TypeScript type-shape metrics: annotations, aliases, interfaces, generics, unions, intersections, assertions, and conditional types
- Halstead metrics and the maintainability index

## Supported languages

Built-in parsers cover JavaScript, JSX, TypeScript, TSX, Python, Go, Rust, Java, Ruby, C, and C++. Additional tree-sitter grammars can be registered with `TreeMeasurer.registerLanguage`.

## Native (Rust) backend

Measurement is also implemented as a Rust addon that produces bit-identical metrics roughly 13x faster than the TypeScript backend (the tree-sitter grammar crates are pinned to the same versions as the npm grammar packages). With a [Rust toolchain](https://rustup.rs) installed, build it once:

```sh
yarn build-native
```

`measureCode` and the CLI pick up `native/code-gauge.node` automatically and fall back to the TypeScript implementation when the addon is missing (for example, on npm installs) or when a custom language has been registered. Set `CODE_GAUGE_NATIVE=0` to force the TypeScript backend, and compare both with `yarn benchmark` (requires `yarn build` first). `isNativeBackendAvailable()` reports which backend is in use.

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

console.log(metrics.cyclomaticComplexity);
```
