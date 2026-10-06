# How the default thresholds were calibrated

The default limits of `code-gauge check` were set in October 2026 from the repositories of the
[WillBooster](https://github.com/WillBooster) organization: from the distribution of every
thresholded metric, and from ratings of sampled functions and duplicated blocks. This document
records the corpus, the measurements, and the reasoning behind each limit.

## Corpus

- All 150 repositories of the organization that are not forks, archived ones included, at the head
  of their default branch on 2026-10-06. Two archived data repositories were too large to fetch and
  were left out.
- `scripts/calibrateThresholds.ts` measured what `code-gauge check` checks in them: 153,095
  functions.
- Two kinds of code were then left out, because the limits are meant for code a team maintains:
  copies of third-party projects kept in an organization repository (80,721 functions, e.g.
  inference engines, parser generators and their grammars, bundled libraries) and course material
  (27,927 functions of exercise and sample code).
- What remains is the calibration corpus: 44,447 functions, 6,455 files, and 7,580 duplicated
  blocks in 103 repositories, 35 of them public. Its repositories are private for 87% of the
  functions, so the full table below cannot be reproduced outside the organization; the
  [public part](#public-part-of-the-corpus) can.

| Language   | Functions | Repositories |
| ---------- | --------: | -----------: |
| TypeScript |    26,726 |           77 |
| TSX        |     6,857 |           29 |
| Kotlin     |     3,765 |            7 |
| Python     |     2,845 |           16 |
| Rust       |     1,449 |            6 |
| Ruby       |     1,159 |            4 |
| Java       |     1,046 |            6 |
| JavaScript |       562 |           39 |
| C and C++  |        38 |            5 |

## Distributions

Nearest-rank quantiles over the calibration corpus, as `scripts/calibrateThresholds.ts` prints
them. A language is listed when the corpus holds at least 1,000 of its functions.

#### cognitive complexity (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        | 44447 |   0 |   2 |   6 |  11 |  16 |  20 |  31 |    45 | 355 |
| typescript | 26726 |   0 |   2 |   6 |  12 |  17 |  22 |  33 |    47 | 355 |
| tsx        |  6857 |   0 |   2 |   5 |  11 |  16 |  21 |  33 |    51 | 338 |
| kotlin     |  3765 |   0 |   1 |   3 |   6 |   8 |  10 |  14 |    19 |  49 |
| python     |  2845 |   1 |   3 |   9 |  14 |  19 |  23 |  29 |    40 | 199 |
| rust       |  1449 |   0 |   2 |   6 |  12 |  17 |  23 |  37 |    48 | 129 |
| ruby       |  1159 |   0 |   1 |   3 |   5 |   6 |   8 |  12 |    16 |  30 |
| java       |  1046 |   0 |   1 |   3 |   6 |   8 |  11 |  20 |    27 | 134 |

#### cyclomatic complexity (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        | 44447 |   1 |   3 |   5 |   7 |  10 |  12 |  17 |    22 | 144 |
| typescript | 26726 |   1 |   3 |   5 |   8 |  11 |  13 |  18 |    24 | 144 |
| tsx        |  6857 |   1 |   2 |   4 |   6 |   9 |  11 |  15 |    21 |  54 |
| kotlin     |  3765 |   1 |   2 |   3 |   5 |   6 |   7 |   8 |    13 |  42 |
| python     |  2845 |   2 |   4 |   7 |  10 |  12 |  14 |  18 |    24 |  63 |
| rust       |  1449 |   1 |   3 |   5 |   8 |  11 |  14 |  21 |    30 |  44 |
| ruby       |  1159 |   1 |   2 |   3 |   4 |   4 |   5 |   7 |     8 |  12 |
| java       |  1046 |   1 |   2 |   4 |   5 |   6 |   9 |  12 |    17 |  52 |

#### NCSS (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        | 44447 |   3 |   7 |  14 |  21 |  28 |  34 |  47 |    65 | 484 |
| typescript | 26726 |   2 |   6 |  13 |  21 |  28 |  34 |  48 |    66 | 414 |
| tsx        |  6857 |   2 |   5 |  11 |  18 |  25 |  32 |  47 |    70 | 484 |
| kotlin     |  3765 |   2 |   6 |  13 |  19 |  24 |  30 |  36 |    48 | 131 |
| python     |  2845 |   5 |  11 |  22 |  30 |  38 |  44 |  55 |    71 | 382 |
| rust       |  1449 |   2 |   8 |  18 |  26 |  34 |  41 |  59 |    79 | 173 |
| ruby       |  1159 |   3 |   7 |  12 |  17 |  24 |  27 |  38 |    40 | 188 |
| java       |  1046 |   5 |   8 |  12 |  17 |  20 |  24 |  27 |    38 | 111 |

#### nesting depth (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        | 44447 |   0 |   1 |   2 |   2 |   3 |   3 |   3 |     4 |  11 |
| typescript | 26726 |   0 |   1 |   2 |   2 |   3 |   3 |   3 |     4 |  11 |
| tsx        |  6857 |   0 |   1 |   1 |   2 |   2 |   2 |   3 |     3 |   8 |
| kotlin     |  3765 |   0 |   0 |   1 |   1 |   1 |   2 |   2 |     2 |   3 |
| python     |  2845 |   1 |   1 |   2 |   3 |   3 |   3 |   4 |     4 |   6 |
| rust       |  1449 |   0 |   1 |   2 |   3 |   3 |   3 |   4 |     5 |   7 |
| ruby       |  1159 |   0 |   0 |   1 |   1 |   1 |   2 |   2 |     2 |   3 |
| java       |  1046 |   0 |   1 |   2 |   2 |   3 |   3 |   3 |     4 |   5 |

#### parameters (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        | 44447 |   1 |   1 |   2 |   3 |   4 |   4 |   5 |     6 |  41 |
| typescript | 26726 |   1 |   2 |   2 |   3 |   4 |   4 |   5 |     6 |  14 |
| tsx        |  6857 |   1 |   1 |   1 |   2 |   2 |   2 |   2 |     3 |   5 |
| kotlin     |  3765 |   0 |   1 |   2 |   2 |   3 |   4 |   5 |     6 |  18 |
| python     |  2845 |   2 |   3 |   4 |   6 |   7 |   8 |  10 |    14 |  41 |
| rust       |  1449 |   1 |   2 |   3 |   3 |   4 |   4 |   5 |     7 |   9 |
| ruby       |  1159 |   1 |   1 |   2 |   3 |   3 |   3 |   4 |     5 |   8 |
| java       |  1046 |   1 |   1 |   1 |   2 |   3 |   3 |   3 |     4 |   5 |

#### Halstead volume (function)

| Language   | Count |   p50 |   p75 |   p90 |    p95 |    p97 |    p98 |    p99 |  p99.5 |     Max |
| ---------- | ----: | ----: | ----: | ----: | -----: | -----: | -----: | -----: | -----: | ------: |
| all        | 44447 |  74.0 | 237.7 | 614.3 | 1075.1 | 1534.0 | 1975.2 | 3026.1 | 4357.0 | 35330.1 |
| typescript | 26726 |  74.2 | 237.7 | 591.0 |  992.7 | 1363.1 | 1737.6 | 2472.4 | 3593.3 | 34736.5 |
| tsx        |  6857 |  66.6 | 272.0 | 968.7 | 1923.0 | 3045.5 | 3771.1 | 5576.9 | 8818.5 | 35330.1 |
| kotlin     |  3765 |  38.0 | 140.6 | 396.3 |  596.1 |  795.0 | 1010.9 | 1474.9 | 2033.1 |  6123.6 |
| python     |  2845 | 169.6 | 412.5 | 927.9 | 1500.4 | 1955.7 | 2370.3 | 3045.9 | 3758.2 | 23213.7 |
| rust       |  1449 |  75.3 | 272.0 | 704.3 | 1181.0 | 1479.3 | 2082.6 | 3023.0 | 3853.0 |  9977.0 |
| ruby       |  1159 |    48 | 155.6 | 379.6 |  577.7 |  741.2 |  905.9 | 1416.4 | 2093.1 |  6963.2 |
| java       |  1046 |  83.8 | 122.6 | 198.8 |  304.2 |  428.1 |  587.6 |  794.2 |  977.8 |  1690.4 |

#### Halstead difficulty (function)

| Language   | Count | p50 | p75 |  p90 |  p95 |  p97 |  p98 |  p99 | p99.5 |  Max |
| ---------- | ----: | --: | --: | ---: | ---: | ---: | ---: | ---: | ----: | ---: |
| all        | 44447 |   3 | 6.1 | 10.9 | 14.7 |   18 | 20.8 | 25.8 |  31.1 | 73.7 |
| typescript | 26726 | 3.2 | 6.7 | 11.7 | 15.7 | 19.0 | 21.8 | 27.1 |  32.9 | 73.7 |
| tsx        |  6857 |   3 |   6 | 10.5 | 14.5 | 18.3 | 20.7 | 25.9 |  30.5 | 63.8 |
| kotlin     |  3765 | 1.5 | 3.2 |  5.8 |  8.0 |  9.8 |   11 | 14.1 |  17.2 | 31.5 |
| python     |  2845 | 4.1 | 7.1 | 11.5 | 14.6 | 17.3 | 19.7 | 22.9 |  26.0 | 54.9 |
| rust       |  1449 | 3.3 |   8 | 13.9 | 18.9 | 22.2 | 26.8 | 33.6 |  41.8 | 67.1 |
| ruby       |  1159 | 1.7 |   3 |    5 |  7.0 |  8.7 | 11.1 | 13.6 |  16.8 | 24.2 |
| java       |  1046 | 2.2 | 3.7 |  5.5 |  6.9 |    8 |  9.3 | 13.9 |  15.1 | 24.1 |

#### Halstead effort (function)

| Language   | Count |   p50 |    p75 |    p90 |     p95 |     p97 |     p98 |      p99 |    p99.5 |       Max |
| ---------- | ----: | ----: | -----: | -----: | ------: | ------: | ------: | -------: | -------: | --------: |
| all        | 44447 | 214.9 | 1412.9 | 6249.2 | 14574.2 | 24739.9 | 36737.9 |  66592.0 | 118095.9 | 2254618.7 |
| typescript | 26726 |   230 | 1564.6 | 6511.4 | 14485.2 | 24519.8 | 34843.2 |  59407.6 | 108420.4 | 1394084.5 |
| tsx        |  6857 | 207.6 | 1584.7 | 9391.5 | 25128.5 | 50318.2 | 74880.1 | 131517.7 | 244356.9 | 2254618.7 |
| kotlin     |  3765 |  57.1 |  446.8 | 2023.0 |  4234.9 |  6954.7 | 10306.8 |  17782.1 |  24374.8 |  187032.2 |
| python     |  2845 | 723.9 | 2739.5 | 9811.7 | 18926.0 | 32060.3 | 40718.4 |  65931.6 |  80207.8 | 1275314.9 |
| rust       |  1449 | 250.6 | 2262.0 | 9157.4 |   21280 | 31926.1 | 49353.1 |  94190.8 | 150684.6 |  502966.7 |
| ruby       |  1159 |  80.0 |  444.1 | 1638.9 |  3459.8 |  5304.4 |  7441.3 |  18676.1 |  26266.1 |   84820.9 |
| java       |  1046 | 198.2 |  476.9 | 1076.3 |  1730.8 |  3043.1 |  5211.3 |   7356.7 |  18218.7 |   36151.1 |

#### DepDegree (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        | 44447 |   2 |   7 |  17 |  27 |  37 |  47 |  68 |    99 | 727 |
| typescript | 26726 |   2 |   7 |  17 |  28 |  37 |  47 |  66 |    95 | 727 |
| tsx        |  6857 |   1 |   5 |  12 |  22 |  32 |  43 |  66 |    92 | 676 |
| kotlin     |  3765 |   1 |   3 |  10 |  16 |  22 |  26 |  37 |    47 | 171 |
| python     |  2845 |   7 |  16 |  34 |  51 |  68 |  84 | 107 |   124 | 640 |
| rust       |  1449 |   2 |   8 |  20 |  33 |  42 |  57 |  78 |   101 | 252 |
| ruby       |  1159 |   2 |   6 |  14 |  21 |  26 |  34 |  54 |    66 | 158 |
| java       |  1046 |   3 |   5 |   8 |  13 |  17 |  20 |  28 |    35 |  59 |

#### file NCSS (file)

| Language   | Count | p50 | p75 | p90 | p95 |  p97 |  p98 |  p99 | p99.5 |  Max |
| ---------- | ----: | --: | --: | --: | --: | ---: | ---: | ---: | ----: | ---: |
| all        |  6455 |  18 |  44 | 101 | 163 |  208 |  266 |  377 |   536 | 1978 |
| typescript |  3529 |  20 |  52 | 115 | 179 |  225 |  281 |  400 |   595 | 1978 |
| tsx        |  1183 |  18 |  32 |  59 |  86 |  118 |  144 |  188 |   288 |  640 |
| kotlin     |   226 |  42 |  84 | 158 | 285 |  343 |  414 |  561 |   615 | 1447 |
| python     |   416 |  37 |  94 | 176 | 252 |  335 |  476 |  585 |   842 | 1260 |
| rust       |    60 |  55 | 179 | 332 | 607 | 1042 | 1042 | 1314 |  1314 | 1314 |
| ruby       |   232 |   7 |  23 |  62 | 100 |  120 |  143 |  188 |   206 |  309 |
| java       |   626 |  11 |  15 |  23 |  28 |   34 |   44 |  102 |   146 |  194 |

#### duplicated lines (duplicated block)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        |  7576 |   9 |  14 |  19 |  26 |  29 |  34 |  43 |    55 | 276 |
| typescript |  3644 |   8 |  12 |  17 |  21 |  26 |  30 |  39 |    47 | 276 |
| tsx        |  1828 |   9 |  13 |  20 |  25 |  28 |  31 |  42 |    51 |  67 |
| kotlin     |   169 |  10 |  14 |  18 |  25 |  29 |  36 |  39 |    46 |  46 |
| python     |   704 |   9 |  15 |  25 |  32 |  42 |  49 |  55 |    68 | 115 |
| rust       |   222 |   7 |  10 |  13 |  16 |  21 |  22 |  26 |    30 |  30 |
| ruby       |    97 |   9 |  12 |  19 |  25 |  28 |  86 |  86 |    86 |  86 |
| java       |   822 |  15 |  19 |  28 |  31 |  35 |  39 |  44 |    57 |  62 |

The distributions barely move between subsets: the 99th percentile of cognitive complexity is 31
for active and 30 for archived repositories, and 29 for private and 38 for public ones (the public
repositories are mostly tools). Across the 41 repositories with at least 200 functions, the median
95th, 98th, and 99th percentiles of cognitive complexity are 10, 21, and 32 (interquartile ranges
8–13, 14–25, and 20–37), and those of function NCSS are 21, 32, and 46.

## Ratings

A quantile says how rare a value is, not whether the code is a problem, so the limits were placed
with ratings. 225 functions were drawn at random from 15 strata of metric values (15 each, at most
two per repository and stratum; TypeScript, TSX, Python, Kotlin, and Rust), and 60 clone groups
from five strata of block length (12 each). LLM reviewers that saw the code but neither the metric
values nor the strata rated each function A (should be refactored: a natural restructuring makes it
clearly easier to read), B (borderline), or C (fine as is: a split would be mechanical), and each
pair of duplicated blocks A (should be shared), B (borderline), or C (not worth sharing). Each item
was rated once, so a stratum's share carries the uncertainty of 12 to 15 ratings.

| Stratum                                               | Rated |   A | A or B |
| ----------------------------------------------------- | ----: | --: | -----: |
| cognitive complexity 5–10, no other high value        |    15 |  0% |    33% |
| cognitive complexity 11–15                            |    15 | 13% |    47% |
| cognitive complexity 16–20                            |    15 | 33% |    87% |
| cognitive complexity 21–30                            |    15 | 67% |    93% |
| cognitive complexity 31–40                            |    15 | 87% |   100% |
| cognitive complexity 41–60                            |    15 | 93% |   100% |
| NCSS 31–50, cognitive complexity ≤ 15                 |    15 | 40% |    73% |
| NCSS > 50, cognitive complexity ≤ 15                  |    15 | 67% |    93% |
| NCSS > 50, cognitive complexity 16–30                 |    15 | 80% |   100% |
| nesting depth ≥ 4, cognitive complexity ≤ 20          |    15 | 13% |    60% |
| parameters ≥ 6, cognitive complexity ≤ 15             |    15 | 20% |    80% |
| cyclomatic complexity ≥ 13, cognitive complexity ≤ 15 |    15 | 13% |    53% |
| Halstead volume > 2000, cognitive complexity ≤ 15     |    15 | 27% |    80% |
| Halstead difficulty > 20, cognitive complexity ≤ 15   |    15 |  7% |    53% |
| DepDegree > 50, cognitive complexity ≤ 15             |    15 | 47% |    93% |
| duplicated block of 6–9 lines                         |    12 |  8% |    50% |
| duplicated block of 10–14 lines                       |    12 | 17% |    58% |
| duplicated block of 15–19 lines                       |    12 | 25% |    58% |
| duplicated block of 20–29 lines                       |    12 | 25% |    83% |
| duplicated block of 30 lines or more                  |    12 | 33% |    67% |

Regrouping all 225 rated functions by the limits chosen below: of the 89 under every warning limit,
11% were rated A and 55% A or B; of the 92 that only exceed a warning limit, 47% A and 87% A or B;
of the 44 that exceed an error limit, 86% A and 98% A or B.

## Limits

A warning marks code worth simplifying when it is touched, so its limit sits where most rated
functions were A or B. An error marks code to fix, so its limit sits where nearly all were A.

| Threshold                        | Warning | Error | Functions, files, or blocks above it |
| -------------------------------- | ------: | ----: | ------------------------------------ |
| `maxFunctionCognitiveComplexity` |      15 |    30 | 3.07% and 1.01% of functions         |
| `maxFunctionNcss`                |      30 |    60 | 2.53% and 0.58% of functions         |
| `maxFunctionParameterCount`      |       6 |   off | 0.41% of functions                   |
| `maxFileNcss`                    |     400 |  1000 | 0.88% and 0.11% of files             |
| `minDuplicateLines`              |      15 |   off | 22% of duplicated blocks             |

- **Cognitive complexity, 15 and 30.** The share of A rises steadily with the value and the
  conventional limit of 15 is where B takes over from C. Above 30, 27 of 30 functions were A;
  between 21 and 30, two thirds were.
- **Function NCSS, 30 and 60.** Length matters on its own: functions over 50 statements were mostly
  A even with a cognitive complexity of 15 or less. Among functions with a cognitive complexity of
  30 or less, 39% of those with 31–40 statements were A, 75% of those with 51–60, and 79% above 60.
  The former limits of 60 and 100 flagged 0.58% and 0.17% of functions, far fewer than the
  cognitive-complexity limits did.
- **Parameters, 6, no error.** Of the rated functions with seven or more parameters that exceed no
  other limit, 6 of 12 were A and 10 of 12 A or B; of those with exactly six, one of seven was A.
  No count separated A from B well enough for an error.
- **File NCSS, 400 and 1000.** Files were not rated, so only the tail is flagged: the 99th and
  99.9th percentiles are 377 and 1042.
- **Duplicated lines, 15, no error.** Length separates duplicated blocks poorly: a third of the
  blocks of 30 lines or more should be shared, a quarter of those of 15–29 lines, a sixth of those
  of 10–14 lines. No length reaches the share of A an error needs, and from 10 lines on the corpus
  holds 3,653 blocks, more than every function violation together.
- **Nesting depth, off.** All 90 functions deeper than 4 also exceed the cognitive-complexity
  warning limit, which already charges nesting, and the rated functions of depth 4 or more were A no
  more often than others of their cognitive complexity.
- **Cyclomatic complexity and Halstead difficulty, off.** Functions they flag alone were rated like
  unflagged ones (13% and 7% A).
- **Halstead volume, Halstead effort, and DepDegree, off.** Their strata were rated higher, but
  mostly because their functions are long or take many parameters: of the 786 functions with a
  DepDegree above 50, the limits above leave 65 unflagged, and one of the nine rated among those
  was A. Of the 871 functions with a Halstead volume above 2000, they leave 197 unflagged, 26% of
  the rated ones A.

With these limits, `check` reports 453 errors and 2,652 warnings in the calibration corpus, and 44
of its 103 repositories have no error.

## Languages

The limits are the same for every language. Under them the languages differ:

| Language   | Cognitive > 15 | Cognitive > 30 | NCSS > 30 | NCSS > 60 | Parameters > 6 |
| ---------- | -------------: | -------------: | --------: | --------: | -------------: |
| TypeScript |          3.42% |          1.17% |     2.54% |     0.61% |          0.27% |
| TSX        |          3.14% |          1.17% |     2.22% |     0.61% |          0.00% |
| Kotlin     |          0.77% |          0.16% |     1.81% |     0.29% |          0.35% |
| Python     |          4.32% |          0.88% |     4.92% |     0.74% |          3.06% |
| Rust       |          3.52% |          1.31% |     3.52% |     0.90% |          0.62% |
| Ruby       |          0.52% |          0.00% |     1.55% |     0.35% |          0.09% |
| Java       |          1.34% |          0.38% |     0.67% |     0.19% |          0.00% |

Python functions exceed the parameter limit several times as often as the others, partly because the
count includes `self`. No per-language default was set from this: outside TypeScript and TSX, one
to four repositories hold most of a language's functions, so a difference between languages cannot
be told from a difference between those repositories. `thresholds.<level>.languages` overrides a
limit per language.

## Public part of the corpus

The 35 public repositories of the calibration corpus, at the commits measured. Checking each out at
its commit and running

```sh
bun scripts/calibrateThresholds.ts <directory of each repository>...
```

prints, among the other tables:

#### cognitive complexity (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        |  5851 |   1 |   3 |   8 |  13 |  19 |  25 |  38 |    54 | 183 |
| typescript |  4471 |   1 |   3 |   8 |  15 |  21 |  27 |  40 |    59 | 183 |
| rust       |  1159 |   0 |   2 |   6 |  11 |  15 |  19 |  29 |    47 | 129 |

#### NCSS (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        |  5851 |   2 |   8 |  16 |  24 |  32 |  40 |  62 |    78 | 337 |
| typescript |  4471 |   3 |   8 |  16 |  24 |  33 |  42 |  64 |    79 | 337 |
| rust       |  1159 |   2 |   6 |  16 |  24 |  30 |  36 |  51 |    78 | 173 |

#### parameters (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        |  5851 |   1 |   2 |   2 |   3 |   4 |   4 |   5 |     5 |   9 |
| typescript |  4471 |   1 |   2 |   2 |   3 |   4 |   4 |   5 |     5 |   9 |
| rust       |  1159 |   1 |   2 |   3 |   3 |   4 |   5 |   6 |     7 |   9 |

#### file NCSS (file)

| Language   | Count | p50 | p75 | p90 | p95 | p97 |  p98 |  p99 | p99.5 |  Max |
| ---------- | ----: | --: | --: | --: | --: | --: | ---: | ---: | ----: | ---: |
| all        |   759 |  21 |  59 | 135 | 215 | 281 |  333 |  412 |   607 | 1042 |
| typescript |   610 |  22 |  62 | 134 | 209 | 280 |  310 |  376 |   413 |  695 |
| rust       |    49 |  55 | 157 | 332 | 607 | 964 | 1042 | 1042 |  1042 | 1042 |

#### duplicated lines (duplicated block)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | --: |
| all        |   586 |   7 |  10 |  14 |  16 |  21 |  26 |  38 |    57 |  57 |
| typescript |   478 |   7 |  10 |  14 |  18 |  24 |  28 |  44 |    57 |  57 |
| rust       |    93 |   6 |   8 |  10 |  13 |  13 |  16 |  16 |    16 |  16 |

| Repository                                                                                            | Commit                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| [agent-runtime-kit](https://github.com/WillBooster/agent-runtime-kit)                                 | `c0c7d5c8d48cd476da78a9ca4184cd44eeefd154` |
| [agent-sandbox-app-hosting](https://github.com/WillBooster/agent-sandbox-app-hosting)                 | `e140ddab644f7011b90f2970dd82aed2af216e1b` |
| [agent-sandbox-backlog](https://github.com/WillBooster/agent-sandbox-backlog)                         | `4257bd7f495f1f25ebc2162d1e5918f487fb6a8a` |
| [agent-sandbox-sample-account-book](https://github.com/WillBooster/agent-sandbox-sample-account-book) | `b162599ef0163cd61ad18d6334f005f2a5056406` |
| [agent-sandbox-workflow](https://github.com/WillBooster/agent-sandbox-workflow)                       | `3b6f2dcc4d1fbc7d1e60eca579220e96d5fa1974` |
| [ai-growbench-reference-agent](https://github.com/WillBooster/ai-growbench-reference-agent)           | `1d8c38d9b2e269c59019386962a0e7b0707984ef` |
| [app-builder-ai](https://github.com/WillBooster/app-builder-ai)                                       | `928dc1088fd42a0c5e85637ebcb615655ed29410` |
| [at-decorators](https://github.com/WillBooster/at-decorators)                                         | `e33c47380cedd557fe77994d09717fccc1d5e2a8` |
| [better-auth-email-otp-reliable](https://github.com/WillBooster/better-auth-email-otp-reliable)       | `1d4deece95424cb9b553378d14962fb67632e7fa` |
| [build-ts](https://github.com/WillBooster/build-ts)                                                   | `378640811d328756852dfb8f230761c61af1384a` |
| [calc-ai-contrib](https://github.com/WillBooster/calc-ai-contrib)                                     | `272bfe18b65165601590b7832189b6133a21de8b` |
| [code-gauge](https://github.com/WillBooster/code-gauge)                                               | `02406d58597adcb9f5150334aef4e0a125174a77` |
| [commitkv](https://github.com/WillBooster/commitkv)                                                   | `36732db7cffc8c94a9271f9aa83fa3241224b7aa` |
| [development-guide](https://github.com/WillBooster/development-guide)                                 | `03798829370fa0caa2ee39211d95caea3fd6beab` |
| [docker-utils](https://github.com/WillBooster/docker-utils)                                           | `cb7c1ce992a39460f06f1c79af3300c8a80e7d47` |
| [exercode-problem-utils](https://github.com/WillBooster/exercode-problem-utils)                       | `2640fcaab736a204eb765dc6a87bbf893f90f9bd` |
| [exercode-viewer](https://github.com/WillBooster/exercode-viewer)                                     | `0c837f2d4bce9489a131137d53ef22105805e0d7` |
| [firebase-private-key-to-env](https://github.com/WillBooster/firebase-private-key-to-env)             | `f5d24f945cdd6ea497a18f27c0228855cd4cd831` |
| [gen-i18n-ts](https://github.com/WillBooster/gen-i18n-ts)                                             | `bde0e355cc3e217e8df0c23cb7b9cf0d58ed417d` |
| [gen-pr](https://github.com/WillBooster/gen-pr)                                                       | `b29b32654f5cf30309677fd2c13ed616de0033e7` |
| [minimal-promise-pool](https://github.com/WillBooster/minimal-promise-pool)                           | `253e8ca69b40ef5b77743ba6d95439cedb7f74e9` |
| [one-way-git-sync](https://github.com/WillBooster/one-way-git-sync)                                   | `8725da504727e38f47fc2167cadf6c7a83a8109f` |
| [plantuml-visualizer](https://github.com/WillBooster/plantuml-visualizer)                             | `2f5559e10bddab5009ece942e33f647d90aa22c8` |
| [reusable-workflows](https://github.com/WillBooster/reusable-workflows)                               | `8d1b0f2b89b3c957859c4fef7a4d33ac5e0296af` |
| [scratch-assets](https://github.com/WillBooster/scratch-assets)                                       | `3dd9870598562c2fa1232c53453e6e76abd16f55` |
| [shared](https://github.com/WillBooster/shared)                                                       | `2b36f68e8b3ddd164df37522aa45ac6e27a7238b` |
| [slidev-check](https://github.com/WillBooster/slidev-check)                                           | `ccd72e809f74948c33dc3cc2de4023cd7a6f9d37` |
| [test-fixtures-for-wbfy](https://github.com/WillBooster/test-fixtures-for-wbfy)                       | `bcede371a3b60b811c97acef1824ec16ed007a67` |
| [tokzip](https://github.com/WillBooster/tokzip)                                                       | `dc324c4b3d388f015f27cbf069ab6ed021ecdc49` |
| [tokzip-corpus](https://github.com/WillBooster/tokzip-corpus)                                         | `bf20d2b03a39442eb04b952152384925369c2a94` |
| [ultra-uni](https://github.com/WillBooster/ultra-uni)                                                 | `c8be4626310b51f6a4d8d7a6d019667ef5dde6c6` |
| [vinext-progress](https://github.com/WillBooster/vinext-progress)                                     | `ddd1a46d6ec136cff8323af82b2049787a49ef70` |
| [wbfy](https://github.com/WillBooster/wbfy)                                                           | `2bd17655600c1af002440e7412cd5f559d9f13e2` |
| [willbooster-configs](https://github.com/WillBooster/willbooster-configs)                             | `c450b76c7d546f89565ac3f3d2723ab3b17855e7` |
| [yarn-plugin-auto-install](https://github.com/WillBooster/yarn-plugin-auto-install)                   | `dc5709805fc32b5a9d5941ee3773f2ada55b7884` |
