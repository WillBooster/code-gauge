# How the default thresholds were calibrated

The default limits of `code-gauge check` were set in October 2026 from the repositories of the
[WillBooster](https://github.com/WillBooster) organization: from the distribution of every
thresholded metric, and from ratings of sampled functions, files, and duplicated blocks. This document
records the corpus, the measurements, and the reasoning behind each limit.

## Corpus

- All 150 repositories of the organization that are not forks, archived ones included, at the head
  of their default branch on 2026-10-06. Two archived repositories hold gigabytes of data files, so
  only their source files were fetched.
- `scripts/calibrateThresholds.ts` measured what `code-gauge check` checks in them: 153,771
  functions.
- Two kinds of code were then left out, because the limits are meant for code a team maintains:
  copies of third-party projects kept in an organization repository (80,721 functions, e.g.
  inference engines, parser generators and their grammars, bundled libraries) and course material
  (27,927 functions of exercise and sample code).
- What remains is the calibration corpus: 45,123 functions and 6,603 files in the 105 repositories that hold source files, 31 of them public. Private repositories
  hold 87% of the functions, so the full tables below cannot be reproduced outside the
  organization; those of the [public part](#public-part-of-the-corpus) can.

| Language   | Functions | Repositories |
| ---------- | --------: | -----------: |
| TypeScript |    26,726 |           77 |
| TSX        |     6,857 |           29 |
| Kotlin     |     3,765 |            7 |
| Python     |     3,521 |           18 |
| Rust       |     1,449 |            6 |
| Ruby       |     1,159 |            4 |
| Java       |     1,046 |            6 |
| JavaScript |       562 |           39 |
| C and C++  |        38 |            5 |

## Distributions

Nearest-rank quantiles over the calibration corpus, as `scripts/calibrateThresholds.ts` prints
them, per language; the tail quantiles of a language with few functions or files are those of a
handful of items. Duplicated blocks have no distribution of their own: `check` merges the clone
occurrences that reach its limit, so the blocks it reports depend on the limit, and the last table
counts them at several limits.

#### cognitive complexity (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | p99.9 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | ----: | --: |
| all        | 45123 |   0 |   2 |   6 |  11 |  16 |  20 |  31 |    45 |    92 | 355 |
| typescript | 26726 |   0 |   2 |   6 |  12 |  17 |  22 |  33 |    47 |   105 | 355 |
| tsx        |  6857 |   0 |   2 |   5 |  11 |  16 |  21 |  33 |    51 |   120 | 338 |
| kotlin     |  3765 |   0 |   1 |   3 |   6 |   8 |  10 |  14 |    19 |    35 |  49 |
| python     |  3521 |   1 |   4 |   9 |  14 |  19 |  23 |  29 |    43 |    71 | 199 |
| rust       |  1449 |   0 |   2 |   6 |  12 |  17 |  23 |  37 |    48 |   106 | 129 |
| ruby       |  1159 |   0 |   1 |   3 |   5 |   6 |   8 |  12 |    16 |    28 |  30 |
| java       |  1046 |   0 |   1 |   3 |   6 |   8 |  11 |  20 |    27 |    92 | 134 |
| javascript |   562 |   0 |   2 |   5 |   9 |  15 |  16 |  20 |    24 |   108 | 108 |
| cpp        |    35 |   0 |   2 |   5 |   7 |   7 |   7 |   7 |     7 |     7 |   7 |
| c          |     3 |   0 |   0 |   0 |   0 |   0 |   0 |   0 |     0 |     0 |   0 |

#### cyclomatic complexity (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | p99.9 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | ----: | --: |
| all        | 45123 |   1 |   3 |   5 |   7 |  10 |  12 |  17 |    22 |    42 | 144 |
| typescript | 26726 |   1 |   3 |   5 |   8 |  11 |  13 |  18 |    24 |    46 | 144 |
| tsx        |  6857 |   1 |   2 |   4 |   6 |   9 |  11 |  15 |    21 |    42 |  54 |
| kotlin     |  3765 |   1 |   2 |   3 |   5 |   6 |   7 |   8 |    13 |    31 |  42 |
| python     |  3521 |   2 |   4 |   7 |  10 |  12 |  14 |  17 |    23 |    37 |  63 |
| rust       |  1449 |   1 |   3 |   5 |   8 |  11 |  14 |  21 |    30 |    43 |  44 |
| ruby       |  1159 |   1 |   2 |   3 |   4 |   4 |   5 |   7 |     8 |    10 |  12 |
| java       |  1046 |   1 |   2 |   4 |   5 |   6 |   9 |  12 |    17 |    44 |  52 |
| javascript |   562 |   1 |   2 |   4 |   6 |   8 |   9 |  11 |    11 |    18 |  18 |
| cpp        |    35 |   1 |   3 |   5 |   5 |   5 |   8 |   8 |     8 |     8 |   8 |
| c          |     3 |   1 |   1 |   1 |   1 |   1 |   1 |   1 |     1 |     1 |   1 |

#### NCSS (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | p99.9 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | ----: | --: |
| all        | 45123 |   3 |   7 |  14 |  21 |  29 |  35 |  48 |    66 |   123 | 484 |
| typescript | 26726 |   2 |   6 |  13 |  21 |  28 |  34 |  48 |    66 |   119 | 414 |
| tsx        |  6857 |   2 |   5 |  11 |  18 |  25 |  32 |  47 |    70 |   149 | 484 |
| kotlin     |  3765 |   2 |   6 |  13 |  19 |  24 |  30 |  36 |    48 |   110 | 131 |
| python     |  3521 |   6 |  13 |  23 |  32 |  39 |  46 |  57 |    78 |   127 | 382 |
| rust       |  1449 |   2 |   8 |  18 |  26 |  34 |  41 |  59 |    79 |   123 | 173 |
| ruby       |  1159 |   3 |   7 |  12 |  17 |  24 |  27 |  38 |    40 |    91 | 188 |
| java       |  1046 |   5 |   8 |  12 |  17 |  20 |  24 |  27 |    38 |    93 | 111 |
| javascript |   562 |   2 |   7 |  13 |  20 |  26 |  28 |  34 |    45 |   203 | 203 |
| cpp        |    35 |   4 |  10 |  19 |  24 |  24 |  24 |  24 |    24 |    24 |  24 |
| c          |     3 |   4 |   6 |   6 |   6 |   6 |   6 |   6 |     6 |     6 |   6 |

#### nesting depth (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | p99.9 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | ----: | --: |
| all        | 45123 |   0 |   1 |   2 |   2 |   3 |   3 |   3 |     4 |     5 |  11 |
| typescript | 26726 |   0 |   1 |   2 |   2 |   3 |   3 |   3 |     4 |     5 |  11 |
| tsx        |  6857 |   0 |   1 |   1 |   2 |   2 |   2 |   3 |     3 |     5 |   8 |
| kotlin     |  3765 |   0 |   0 |   1 |   1 |   1 |   2 |   2 |     2 |     3 |   3 |
| python     |  3521 |   1 |   1 |   2 |   3 |   3 |   4 |   4 |     4 |     5 |   6 |
| rust       |  1449 |   0 |   1 |   2 |   3 |   3 |   3 |   4 |     5 |     7 |   7 |
| ruby       |  1159 |   0 |   0 |   1 |   1 |   1 |   2 |   2 |     2 |     3 |   3 |
| java       |  1046 |   0 |   1 |   2 |   2 |   3 |   3 |   3 |     4 |     4 |   5 |
| javascript |   562 |   0 |   1 |   2 |   2 |   3 |   3 |   3 |     4 |     4 |   4 |
| cpp        |    35 |   0 |   1 |   2 |   2 |   2 |   2 |   2 |     2 |     2 |   2 |
| c          |     3 |   0 |   0 |   0 |   0 |   0 |   0 |   0 |     0 |     0 |   0 |

#### parameters (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | p99.9 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | ----: | --: |
| all        | 45123 |   1 |   1 |   2 |   3 |   4 |   4 |   5 |     6 |    11 |  41 |
| typescript | 26726 |   1 |   2 |   2 |   3 |   4 |   4 |   5 |     6 |     8 |  14 |
| tsx        |  6857 |   1 |   1 |   1 |   2 |   2 |   2 |   2 |     3 |     4 |   5 |
| kotlin     |  3765 |   0 |   1 |   2 |   2 |   3 |   4 |   5 |     6 |    10 |  18 |
| python     |  3521 |   2 |   3 |   4 |   6 |   7 |   8 |  11 |    16 |    23 |  41 |
| rust       |  1449 |   1 |   2 |   3 |   3 |   4 |   4 |   5 |     7 |     8 |   9 |
| ruby       |  1159 |   1 |   1 |   2 |   3 |   3 |   3 |   4 |     5 |     6 |   8 |
| java       |  1046 |   1 |   1 |   1 |   2 |   3 |   3 |   3 |     4 |     4 |   5 |
| javascript |   562 |   1 |   1 |   2 |   2 |   3 |   4 |   5 |     6 |     8 |   8 |
| cpp        |    35 |   1 |   2 |   4 |   4 |   4 |   5 |   5 |     5 |     5 |   5 |
| c          |     3 |   0 |   1 |   1 |   1 |   1 |   1 |   1 |     1 |     1 |   1 |

#### Halstead volume (function)

| Language   | Count |   p50 |   p75 |   p90 |    p95 |    p97 |    p98 |    p99 |  p99.5 |   p99.9 |     Max |
| ---------- | ----: | ----: | ----: | ----: | -----: | -----: | -----: | -----: | -----: | ------: | ------: |
| all        | 45123 |  75.3 | 242.5 | 626.1 | 1085.2 | 1541.2 | 1982.2 | 3025.1 | 4332.1 |  9466.5 | 35330.1 |
| typescript | 26726 |  74.2 | 237.7 | 591.0 |  992.7 | 1363.1 | 1737.6 | 2472.4 | 3593.3 |  7655.2 | 34736.5 |
| tsx        |  6857 |  66.6 | 272.0 | 968.7 | 1923.0 | 3045.5 | 3771.1 | 5576.9 | 8818.5 | 15470.5 | 35330.1 |
| kotlin     |  3765 |  38.0 | 140.6 | 396.3 |  596.1 |  795.0 | 1010.9 | 1474.9 | 2033.1 |  4115.9 |  6123.6 |
| python     |  3521 | 188.0 | 446.2 |   954 | 1500.5 | 1955.0 | 2316.6 | 2998.3 | 3758.2 |  6747.8 | 23213.7 |
| rust       |  1449 |  75.3 | 272.0 | 704.3 | 1181.0 | 1479.3 | 2082.6 | 3023.0 | 3853.0 |  6158.2 |  9977.0 |
| ruby       |  1159 |    48 | 155.6 | 379.6 |  577.7 |  741.2 |  905.9 | 1416.4 | 2093.1 |  3523.5 |  6963.2 |
| java       |  1046 |  83.8 | 122.6 | 198.8 |  304.2 |  428.1 |  587.6 |  794.2 |  977.8 |  1497.9 |  1690.4 |
| javascript |   562 |  48.4 | 186.9 | 406.3 |  647.1 |  904.1 | 1049.4 |   1182 | 2249.0 | 16405.6 | 16405.6 |
| cpp        |    35 |  59.2 | 260.1 | 546.7 |  580.0 |  580.0 |  629.6 |  629.6 |  629.6 |   629.6 |   629.6 |
| c          |     3 |    33 |  53.8 |  53.8 |   53.8 |   53.8 |   53.8 |   53.8 |   53.8 |    53.8 |    53.8 |

#### Halstead difficulty (function)

| Language   | Count | p50 | p75 |  p90 |  p95 |  p97 |  p98 |  p99 | p99.5 | p99.9 |  Max |
| ---------- | ----: | --: | --: | ---: | ---: | ---: | ---: | ---: | ----: | ----: | ---: |
| all        | 45123 |   3 | 6.2 | 10.9 | 14.7 | 17.9 | 20.7 | 25.6 |  31.0 |  44.4 | 73.7 |
| typescript | 26726 | 3.2 | 6.7 | 11.7 | 15.7 | 19.0 | 21.8 | 27.1 |  32.9 |  45.9 | 73.7 |
| tsx        |  6857 |   3 |   6 | 10.5 | 14.5 | 18.3 | 20.7 | 25.9 |  30.5 |  44.1 | 63.8 |
| kotlin     |  3765 | 1.5 | 3.2 |  5.8 |  8.0 |  9.8 |   11 | 14.1 |  17.2 |  28.4 | 31.5 |
| python     |  3521 | 4.3 | 7.2 | 11.4 | 14.4 | 17.1 | 19.0 | 22.6 |  26.0 |  37.4 | 54.9 |
| rust       |  1449 | 3.3 |   8 | 13.9 | 18.9 | 22.2 | 26.8 | 33.6 |  41.8 |  50.4 | 67.1 |
| ruby       |  1159 | 1.7 |   3 |    5 |  7.0 |  8.7 | 11.1 | 13.6 |  16.8 |  24.1 | 24.2 |
| java       |  1046 | 2.2 | 3.7 |  5.5 |  6.9 |    8 |  9.3 | 13.9 |  15.1 |  22.1 | 24.1 |
| javascript |   562 | 2.3 | 4.7 |    8 | 10.8 | 13.7 | 14.7 | 17.7 |  23.4 |  31.1 | 31.1 |
| cpp        |    35 | 3.2 | 7.2 |   10 | 11.4 | 11.4 | 11.4 | 11.4 |  11.4 |  11.4 | 11.4 |
| c          |     3 |   2 | 2.1 |  2.1 |  2.1 |  2.1 |  2.1 |  2.1 |   2.1 |   2.1 |  2.1 |

#### Halstead effort (function)

| Language   | Count |   p50 |    p75 |     p90 |     p95 |     p97 |     p98 |      p99 |    p99.5 |    p99.9 |       Max |
| ---------- | ----: | ----: | -----: | ------: | ------: | ------: | ------: | -------: | -------: | -------: | --------: |
| all        | 45123 | 221.0 | 1457.3 |  6335.6 | 14734.1 | 24712.1 | 36682.9 |  66223.5 | 117025.2 | 357298.0 | 2254618.7 |
| typescript | 26726 |   230 | 1564.6 |  6511.4 | 14485.2 | 24519.8 | 34843.2 |  59407.6 | 108420.4 | 328440.8 | 1394084.5 |
| tsx        |  6857 | 207.6 | 1584.7 |  9391.5 | 25128.5 | 50318.2 | 74880.1 | 131517.7 | 244356.9 | 609534.7 | 2254618.7 |
| kotlin     |  3765 |  57.1 |  446.8 |  2023.0 |  4234.9 |  6954.7 | 10306.8 |  17782.1 |  24374.8 |  92582.3 |  187032.2 |
| python     |  3521 | 833.5 | 3082.6 | 10052.0 | 18791.9 | 29063.6 | 37427.8 |  61949.5 |  81535.2 | 232183.1 | 1275314.9 |
| rust       |  1449 | 250.6 | 2262.0 |  9157.4 |   21280 | 31926.1 | 49353.1 |  94190.8 | 150684.6 | 389800.3 |  502966.7 |
| ruby       |  1159 |  80.0 |  444.1 |  1638.9 |  3459.8 |  5304.4 |  7441.3 |  18676.1 |  26266.1 |  82140.7 |   84820.9 |
| java       |  1046 | 198.2 |  476.9 |  1076.3 |  1730.8 |  3043.1 |  5211.3 |   7356.7 |  18218.7 |  24203.2 |   36151.1 |
| javascript |   562 | 121.9 |  909.8 |  3319.8 |  5742.0 |  9828.9 | 12804.7 |  22050.5 |  39762.4 | 258449.8 |  258449.8 |
| cpp        |    35 | 172.8 | 2276.8 |  5076.6 |  6605.3 |  6605.3 |  6752.9 |   6752.9 |   6752.9 |   6752.9 |    6752.9 |
| c          |     3 |  69.3 |  107.5 |   107.5 |   107.5 |   107.5 |   107.5 |    107.5 |    107.5 |    107.5 |     107.5 |

#### DepDegree (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | p99.9 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | ----: | --: |
| all        | 45123 |   2 |   7 |  17 |  28 |  38 |  48 |  68 |    99 |   183 | 727 |
| typescript | 26726 |   2 |   7 |  17 |  28 |  37 |  47 |  66 |    95 |   192 | 727 |
| tsx        |  6857 |   1 |   5 |  12 |  22 |  32 |  43 |  66 |    92 |   199 | 676 |
| kotlin     |  3765 |   1 |   3 |  10 |  16 |  22 |  26 |  37 |    47 |    97 | 171 |
| python     |  3521 |   7 |  18 |  35 |  51 |  67 |  82 | 106 |   124 |   213 | 640 |
| rust       |  1449 |   2 |   8 |  20 |  33 |  42 |  57 |  78 |   101 |   205 | 252 |
| ruby       |  1159 |   2 |   6 |  14 |  21 |  26 |  34 |  54 |    66 |   128 | 158 |
| java       |  1046 |   3 |   5 |   8 |  13 |  17 |  20 |  28 |    35 |    45 |  59 |
| javascript |   562 |   2 |   6 |  15 |  22 |  28 |  30 |  46 |    60 |   194 | 194 |
| cpp        |    35 |   2 |   8 |  18 |  29 |  29 |  29 |  29 |    29 |    29 |  29 |
| c          |     3 |   1 |   1 |   1 |   1 |   1 |   1 |   1 |     1 |     1 |   1 |

#### file NCSS (file)

| Language   | Count | p50 | p75 | p90 | p95 |  p97 |  p98 |  p99 | p99.5 | p99.9 |  Max |
| ---------- | ----: | --: | --: | --: | --: | ---: | ---: | ---: | ----: | ----: | ---: |
| all        |  6603 |  18 |  45 | 104 | 165 |  210 |  268 |  377 |   536 |  1042 | 1978 |
| typescript |  3529 |  20 |  52 | 115 | 179 |  225 |  281 |  400 |   595 |   886 | 1978 |
| tsx        |  1183 |  18 |  32 |  59 |  86 |  118 |  144 |  188 |   288 |   398 |  640 |
| kotlin     |   226 |  42 |  84 | 158 | 285 |  343 |  414 |  561 |   615 |  1447 | 1447 |
| python     |   568 |  38 |  94 | 177 | 256 |  303 |  423 |  556 |   842 |  1260 | 1260 |
| rust       |    60 |  55 | 179 | 332 | 607 | 1042 | 1042 | 1314 |  1314 |  1314 | 1314 |
| ruby       |   232 |   7 |  23 |  62 | 100 |  120 |  143 |  188 |   206 |   309 |  309 |
| java       |   622 |  11 |  15 |  23 |  28 |   34 |   44 |  102 |   146 |   194 |  194 |
| javascript |   156 |   9 |  19 |  48 |  88 |  139 |  171 |  210 |   520 |   520 |  520 |
| cpp        |    25 |   4 |  25 |  34 |  37 |  126 |  126 |  126 |   126 |   126 |  126 |
| c          |     2 |   6 |  11 |  11 |  11 |   11 |   11 |   11 |    11 |    11 |   11 |

#### duplicated blocks reported from a line count

| Language   | From 5 | From 10 | From 15 | From 20 | From 30 | From 50 |
| ---------- | -----: | ------: | ------: | ------: | ------: | ------: |
| all        |   5805 |    3209 |    1506 |     696 |     223 |      50 |
| typescript |   2704 |    1259 |     483 |     218 |      75 |      17 |
| tsx        |   1416 |     808 |     362 |     189 |      44 |      11 |
| kotlin     |    147 |      86 |      37 |      14 |       5 |       0 |
| python     |    733 |     422 |     237 |     125 |      51 |      12 |
| rust       |    148 |      56 |      17 |       7 |       2 |       0 |
| ruby       |     78 |      40 |      15 |       8 |       2 |       2 |
| java       |    525 |     499 |     340 |     126 |      40 |       8 |
| javascript |     54 |      39 |      15 |       9 |       4 |       0 |
| cpp        |      0 |       0 |       0 |       0 |       0 |       0 |
| c          |      0 |       0 |       0 |       0 |       0 |       0 |

The distributions barely move between subsets: the 99th percentile of cognitive complexity is 31
for active and 30 for archived repositories, and 29 for private and 38 for public ones (the public
repositories are mostly tools). Across the 42 repositories with at least 200 functions, the median
95th, 98th, and 99th percentiles of cognitive complexity are 10, 21, and 32 (interquartile ranges
8–14, 14–25, and 20–37), and those of function NCSS are 21, 34, and 47.

## Ratings

A quantile says how rare a value is, not whether the code is a problem, so the limits were placed
with ratings. Drawn at random, at most two per repository and stratum, from TypeScript, TSX, Python,
Kotlin, and Rust code:

- 225 functions from 15 strata of metric values, 15 each;
- 47 files from five strata of file NCSS, 10 each and all 7 above 1000;
- 60 clone groups from five strata of the length of their longest block in line span, 12 each;
  the block `check` reported for a group was at least that long in line span.

The draw preceded the fetch of one of the two data repositories, so its 675 Python functions could
not be drawn. LLM reviewers that saw the code but neither the metric values nor the strata rated
each item once: a function A (should be refactored: a natural restructuring makes it clearly easier
to read), B (borderline), or C (fine as is: a split would be mechanical); a file A (should be
split: it holds clearly separable responsibilities), B, or C (cohesive); a pair of duplicated blocks
A (should be shared), B, or C (not worth sharing). A stratum's share therefore carries the
uncertainty of 7 to 15 ratings.

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
| file NCSS 151–250                                     |    10 | 10% |    40% |
| file NCSS 251–400                                     |    10 | 30% |    60% |
| file NCSS 401–600                                     |    10 | 40% |    90% |
| file NCSS 601–1000                                    |    10 | 70% |   100% |
| file NCSS above 1000                                  |     7 | 86% |   100% |
| clone group, longest block of 6–9 lines               |    12 |  8% |    50% |
| clone group, longest block of 10–14 lines             |    12 | 17% |    58% |
| clone group, longest block of 15–19 lines             |    12 | 25% |    58% |
| clone group, longest block of 20–29 lines             |    12 | 25% |    83% |
| clone group, longest block of 30 lines or more        |    12 | 33% |    67% |

Regrouping all 225 rated functions by the limits chosen below: of the 89 under every warning limit,
11% were rated A and 55% A or B; of the 92 that only exceed a warning limit, 47% A and 87% A or B;
of the 44 that exceed an error limit, 86% A and 98% A or B.

## Limits

A warning marks code worth simplifying when it is touched, so its limit sits where most rated
functions were A or B. An error marks code to fix, so its limit sits where nearly all were A.

| Threshold                        | Warning | Error | Functions, files, or blocks above it |
| -------------------------------- | ------: | ----: | ------------------------------------ |
| `maxFunctionCognitiveComplexity` |      15 |    30 | 3.09% and 1.01% of functions         |
| `maxFunctionNcss`                |      30 |    60 | 2.62% and 0.59% of functions         |
| `maxFunctionParameterCount`      |       6 |   off | 0.48% of functions                   |
| `maxFileNcss`                    |     400 |  1000 | 0.89% and 0.11% of files             |
| `minDuplicateLines`              |      15 |   off | 978 duplicated blocks                |

- **Cognitive complexity, 15 and 30.** The share of A rises steadily with the value and the
  conventional limit of 15 is where B takes over from C. Above 30, 27 of 30 functions were A;
  between 21 and 30, two thirds were.
- **Function NCSS, 30 and 60.** Length matters on its own: functions over 50 statements were mostly
  A even with a cognitive complexity of 15 or less. Among functions with a cognitive complexity of
  30 or less, 39% of those with 31–40 statements were A, 75% of those with 51–60, and 79% above 60.
  The former limits of 60 and 100 flagged 0.59% and 0.17% of functions, far fewer than the
  cognitive-complexity limits did.
- **Parameters, 6, no error.** Of the rated functions with seven or more parameters that exceed no
  other limit, 6 of 12 were A and 10 of 12 A or B; of those with exactly six, one of seven was A.
  No count separated A from B well enough for an error.
- **File NCSS, 400 and 1000.** Nine of ten rated files between 401 and 600 were A or B, against
  six of ten between 251 and 400, and six of the seven files above 1000 should be split, against
  seven of ten between 601 and 1000. The limits flag 0.89% and 0.11% of files; the 99th and 99.9th
  percentiles are 377 and 1042.
- **Duplicated lines, 15, no error.** In line span here; [in matched lines](#duplicated-blocks-measured-in-matched-lines) the limit is the same. Length separates duplicated blocks poorly: a third of the blocks of 30 lines or more should be shared, a quarter of those of 15–29 lines, a sixth of those
  of 10–14 lines. No length reaches the share of A an error needs, and from 10 lines of span on `check` reported 3,209 blocks in the corpus, nearly twice its 1,698 function violations (2,596 blocks from 10 matched lines).
- **Nesting depth, off.** All 91 functions deeper than 4 also exceed the cognitive-complexity
  warning limit, which already charges nesting, and the rated functions of depth 4 or more were A no
  more often than others of their cognitive complexity.
- **Cyclomatic complexity and Halstead difficulty, off.** Functions they flag alone were rated like
  unflagged ones (13% and 7% A).
- **Halstead volume, Halstead effort, and DepDegree, off.** Their strata were rated higher, but
  mostly because their functions are long or take many parameters. Of the 820 functions with a
  DepDegree above 50, the limits above leave 72 unflagged, and one of the nine rated among those
  was A. Of the 890 functions with a Halstead volume above 2000, they leave 198 unflagged; 5 of the
  19 rated among those were A, against 11% of the functions under every limit, a weak signal for
  which the metric names no change to make. Halstead effort is the product of volume and
  difficulty and was not rated on its own.

With these limits, `check` reports 464 errors and 2,271 warnings in the calibration corpus (2,799 warnings when it counted a duplicated block by its line span), and 45 of its 105 repositories have no error.

## Duplicated blocks measured in matched lines

The tables of duplicated blocks above, and that of the [public part](#public-part-of-the-corpus)
below, count a block by its line span, as `check` did when the limits were set. `check` now counts
the lines of the span matched in another copy. Lines that are blank or comment-only do not count,
so that a commented copy and its bare partner have the same length, and neither do the lines the
copies do not share: those between the matched parts of an edited copy, and those a block
resembling another as a whole adds or rewrites (a line of it counts when its copies match more than
half of its tokens between them). Copies of each other that share a line are blocks of their own. The limit was
re-examined on the same corpus, exported again at its recorded commits (the same 45,123 functions
and 6,603 files):

| Blocks reported from | 5 lines | 10 lines | 15 lines | 20 lines | 30 lines | 50 lines |
| -------------------- | ------: | -------: | -------: | -------: | -------: | -------: |
| line span            |   5,805 |    3,209 |    1,506 |      696 |      223 |       50 |
| matched lines        |   5,643 |    2,596 |      978 |      418 |      110 |       24 |

Regrouped by the matched lines of their longest block as `check` reports it, the 60 rated clone
groups separate no better than by its span:

| Longest block, matched lines | Rated |    A | A or B |
| ---------------------------- | ----: | ---: | -----: |
| up to 9                      |    14 |  14% |    50% |
| 10–14                        |    18 |  22% |    61% |
| 15–19                        |    10 |  20% |    60% |
| 20–29                        |    16 |  19% |    75% |
| 30 or more                   |     2 | 100% |   100% |

The limit stays at 15: of the rated groups reaching it, 71% are A or B in matched lines (20 of 28),
69% in line span (25 of 36), and a lower limit raises that share by a point at most (72% from 13,
67% from 10) while a limit of 10 reports more than two and a half times the blocks. The same limit in matched lines
reports a third fewer blocks; those dropped are the ones that reached 15 lines only through their
comments, their blank lines, and the lines their copies do not share.

## Later grammar versions

The tables above are those of the tree-sitter grammars in use when the limits were set. Measured
again with the grammars updated since, the corpus holds the same 45,123 functions and 6,603 files,
as many of them above every limit, and four quantiles differ: the 75th percentile of Halstead effort
in TSX (1583.3) and of Halstead volume in Kotlin (141.8), the 99.9th percentile and maximum of
Halstead volume in JavaScript (16396.8), and the 98th percentile of file NCSS in Kotlin (413).

## Languages

The limits are the same for every language. Under them the languages differ (C and C++, with 38
functions together, are left out):

| Language   | Cognitive > 15 | Cognitive > 30 | NCSS > 30 | NCSS > 60 | Parameters > 6 |
| ---------- | -------------: | -------------: | --------: | --------: | -------------: |
| TypeScript |          3.42% |          1.17% |     2.54% |     0.61% |          0.27% |
| TSX        |          3.14% |          1.17% |     2.22% |     0.61% |          0.00% |
| Kotlin     |          0.77% |          0.16% |     1.81% |     0.29% |          0.35% |
| Python     |          4.40% |          0.88% |     5.62% |     0.82% |          3.35% |
| Rust       |          3.52% |          1.31% |     3.52% |     0.90% |          0.62% |
| Ruby       |          0.52% |          0.00% |     1.55% |     0.35% |          0.09% |
| Java       |          1.34% |          0.38% |     0.67% |     0.19% |          0.00% |
| JavaScript |          2.31% |          0.18% |     1.42% |     0.36% |          0.18% |

Python functions exceed the parameter limit several times as often as the others, partly because the
count includes `self`. No per-language default was set from this: outside TypeScript and TSX, one
to four repositories hold most of a language's functions, so a difference between languages cannot
be told from a difference between those repositories. `thresholds.<level>.languages` overrides a
limit per language.

## Public part of the corpus

The 31 public repositories of the calibration corpus, at the commits measured. Checking each out at
its commit and running

```sh
bun scripts/calibrateThresholds.ts <directory of each repository>...
```

prints, among the other tables:

#### cognitive complexity (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | p99.9 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | ----: | --: |
| all        |  5851 |   1 |   3 |   8 |  13 |  19 |  25 |  38 |    54 |   108 | 183 |
| typescript |  4471 |   1 |   3 |   8 |  15 |  21 |  27 |  40 |    59 |   108 | 183 |
| rust       |  1159 |   0 |   2 |   6 |  11 |  15 |  19 |  29 |    47 |    92 | 129 |
| javascript |   158 |   0 |   2 |   8 |  13 |  16 |  19 |  28 |   108 |   108 | 108 |
| tsx        |    36 |   0 |   1 |   2 |   3 |   3 |   5 |   5 |     5 |     5 |   5 |
| python     |    24 |   0 |   2 |   6 |   7 |  11 |  11 |  11 |    11 |    11 |  11 |
| java       |     2 |   0 |   0 |   0 |   0 |   0 |   0 |   0 |     0 |     0 |   0 |
| kotlin     |     1 |   0 |   0 |   0 |   0 |   0 |   0 |   0 |     0 |     0 |   0 |

#### NCSS (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | p99.9 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | ----: | --: |
| all        |  5851 |   2 |   8 |  16 |  24 |  32 |  40 |  62 |    78 |   172 | 337 |
| typescript |  4471 |   3 |   8 |  16 |  24 |  33 |  42 |  64 |    79 |   157 | 337 |
| rust       |  1159 |   2 |   6 |  16 |  24 |  30 |  36 |  51 |    78 |   121 | 173 |
| javascript |   158 |   2 |   7 |  18 |  27 |  30 |  32 |  43 |   203 |   203 | 203 |
| tsx        |    36 |   2 |   4 |   6 |   8 |   8 |  25 |  25 |    25 |    25 |  25 |
| python     |    24 |   6 |  13 |  18 |  21 |  34 |  34 |  34 |    34 |    34 |  34 |
| java       |     2 |   6 |   6 |   6 |   6 |   6 |   6 |   6 |     6 |     6 |   6 |
| kotlin     |     1 |   3 |   3 |   3 |   3 |   3 |   3 |   3 |     3 |     3 |   3 |

#### parameters (function)

| Language   | Count | p50 | p75 | p90 | p95 | p97 | p98 | p99 | p99.5 | p99.9 | Max |
| ---------- | ----: | --: | --: | --: | --: | --: | --: | --: | ----: | ----: | --: |
| all        |  5851 |   1 |   2 |   2 |   3 |   4 |   4 |   5 |     5 |     7 |   9 |
| typescript |  4471 |   1 |   2 |   2 |   3 |   4 |   4 |   5 |     5 |     6 |   9 |
| rust       |  1159 |   1 |   2 |   3 |   3 |   4 |   5 |   6 |     7 |     8 |   9 |
| javascript |   158 |   1 |   1 |   2 |   2 |   3 |   3 |   3 |     4 |     4 |   4 |
| tsx        |    36 |   0 |   0 |   1 |   1 |   1 |   1 |   1 |     1 |     1 |   1 |
| python     |    24 |   1 |   2 |   5 |   6 |   7 |   7 |   7 |     7 |     7 |   7 |
| java       |     2 |   1 |   1 |   1 |   1 |   1 |   1 |   1 |     1 |     1 |   1 |
| kotlin     |     1 |   0 |   0 |   0 |   0 |   0 |   0 |   0 |     0 |     0 |   0 |

#### file NCSS (file)

| Language   | Count | p50 | p75 | p90 | p95 | p97 |  p98 |  p99 | p99.5 | p99.9 |  Max |
| ---------- | ----: | --: | --: | --: | --: | --: | ---: | ---: | ----: | ----: | ---: |
| all        |   759 |  21 |  59 | 135 | 215 | 281 |  333 |  412 |   607 |  1042 | 1042 |
| typescript |   610 |  22 |  62 | 134 | 209 | 280 |  310 |  376 |   413 |   695 |  695 |
| rust       |    49 |  55 | 157 | 332 | 607 | 964 | 1042 | 1042 |  1042 |  1042 | 1042 |
| javascript |    56 |   5 |  21 |  50 |  96 | 139 |  139 |  203 |   203 |   203 |  203 |
| tsx        |    18 |   6 |   8 |  13 |  73 |  73 |   73 |   73 |    73 |    73 |   73 |
| python     |    22 |   5 |  23 |  53 |  68 |  71 |   71 |   71 |    71 |    71 |   71 |
| java       |     2 |   8 |   8 |   8 |   8 |   8 |    8 |    8 |     8 |     8 |    8 |
| kotlin     |     2 |   1 |   3 |   3 |   3 |   3 |    3 |    3 |     3 |     3 |    3 |

#### duplicated blocks reported from a line count

| Language   | From 5 | From 10 | From 15 | From 20 | From 30 | From 50 |
| ---------- | -----: | ------: | ------: | ------: | ------: | ------: |
| all        |    428 |     167 |      41 |      19 |       8 |       3 |
| typescript |    360 |     142 |      39 |      19 |       8 |       3 |
| rust       |     54 |      16 |       2 |       0 |       0 |       0 |
| javascript |      8 |       7 |       0 |       0 |       0 |       0 |
| tsx        |      2 |       0 |       0 |       0 |       0 |       0 |
| python     |      2 |       0 |       0 |       0 |       0 |       0 |
| java       |      2 |       2 |       0 |       0 |       0 |       0 |
| kotlin     |      0 |       0 |       0 |       0 |       0 |       0 |

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
| [exercode-problem-utils](https://github.com/WillBooster/exercode-problem-utils)                       | `2640fcaab736a204eb765dc6a87bbf893f90f9bd` |
| [exercode-viewer](https://github.com/WillBooster/exercode-viewer)                                     | `0c837f2d4bce9489a131137d53ef22105805e0d7` |
| [firebase-private-key-to-env](https://github.com/WillBooster/firebase-private-key-to-env)             | `f5d24f945cdd6ea497a18f27c0228855cd4cd831` |
| [gen-i18n-ts](https://github.com/WillBooster/gen-i18n-ts)                                             | `bde0e355cc3e217e8df0c23cb7b9cf0d58ed417d` |
| [gen-pr](https://github.com/WillBooster/gen-pr)                                                       | `b29b32654f5cf30309677fd2c13ed616de0033e7` |
| [minimal-promise-pool](https://github.com/WillBooster/minimal-promise-pool)                           | `253e8ca69b40ef5b77743ba6d95439cedb7f74e9` |
| [one-way-git-sync](https://github.com/WillBooster/one-way-git-sync)                                   | `8725da504727e38f47fc2167cadf6c7a83a8109f` |
| [plantuml-visualizer](https://github.com/WillBooster/plantuml-visualizer)                             | `2f5559e10bddab5009ece942e33f647d90aa22c8` |
| [reusable-workflows](https://github.com/WillBooster/reusable-workflows)                               | `8d1b0f2b89b3c957859c4fef7a4d33ac5e0296af` |
| [shared](https://github.com/WillBooster/shared)                                                       | `2b36f68e8b3ddd164df37522aa45ac6e27a7238b` |
| [slidev-check](https://github.com/WillBooster/slidev-check)                                           | `ccd72e809f74948c33dc3cc2de4023cd7a6f9d37` |
| [tokzip](https://github.com/WillBooster/tokzip)                                                       | `dc324c4b3d388f015f27cbf069ab6ed021ecdc49` |
| [tokzip-corpus](https://github.com/WillBooster/tokzip-corpus)                                         | `bf20d2b03a39442eb04b952152384925369c2a94` |
| [ultra-uni](https://github.com/WillBooster/ultra-uni)                                                 | `c8be4626310b51f6a4d8d7a6d019667ef5dde6c6` |
| [vinext-progress](https://github.com/WillBooster/vinext-progress)                                     | `ddd1a46d6ec136cff8323af82b2049787a49ef70` |
| [wbfy](https://github.com/WillBooster/wbfy)                                                           | `2bd17655600c1af002440e7412cd5f559d9f13e2` |
| [willbooster-configs](https://github.com/WillBooster/willbooster-configs)                             | `c450b76c7d546f89565ac3f3d2723ab3b17855e7` |
| [yarn-plugin-auto-install](https://github.com/WillBooster/yarn-plugin-auto-install)                   | `dc5709805fc32b5a9d5941ee3773f2ada55b7884` |
