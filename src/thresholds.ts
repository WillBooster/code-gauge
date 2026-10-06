import type { CodeMetrics, FunctionMetrics } from './types.js';

/** The severities of a violation, mildest first. */
export const levels = ['warning', 'error'] as const;
export type Level = (typeof levels)[number];

/**
 * One limit of `code-gauge check`. Its `key` is the config setting, the per-language override
 * setting, and (kebab-cased) the command-line option, so a new entry here is all a new thresholded
 * metric needs.
 */
export interface Threshold<Subject = never> {
  key: string;
  /** How the report names the measured value. */
  label: string;
  /** `Infinity` leaves the level unchecked unless the config or the command line sets a limit. */
  defaultLimits: Readonly<Record<Level, number>>;
  /** What to change in the code when the limit is exceeded. */
  hint: string;
  measure: (subject: Subject) => number;
  /** The value of a function covers the functions nested in it, so theirs repeats a part of it. */
  includesNestedFunctions?: true;
}

/** Limits by threshold key; `Infinity` disables a limit. */
export type Limits = Readonly<Record<string, number>>;
export type LimitsByLevel = Readonly<Record<Level, Limits>>;

export const functionThresholds: readonly Threshold<FunctionMetrics>[] = [
  {
    key: 'maxFunctionCognitiveComplexity',
    label: 'cognitive complexity',
    defaultLimits: { warning: 15, error: 30 },
    hint: 'flatten nested branching with early returns and extract nested blocks into named functions.',
    measure: (fn) => fn.cognitiveComplexity,
    includesNestedFunctions: true,
  },
  {
    key: 'maxFunctionCyclomaticComplexity',
    label: 'cyclomatic complexity',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'the function has too many independent paths; split it by decision or replace condition chains with a lookup table.',
    measure: (fn) => fn.cyclomaticComplexity,
  },
  {
    key: 'maxFunctionNcss',
    label: 'NCSS',
    defaultLimits: { warning: 60, error: 100 },
    hint: 'split the function into smaller functions that each do one step.',
    measure: (fn) => fn.ncss,
    includesNestedFunctions: true,
  },
  {
    key: 'maxFunctionNestingDepth',
    label: 'nesting depth',
    defaultLimits: { warning: 4, error: 5 },
    hint: 'replace nested conditions with guard clauses or move inner blocks into functions.',
    measure: (fn) => fn.nestingDepth,
  },
  {
    key: 'maxFunctionParameterCount',
    label: 'parameters',
    defaultLimits: { warning: 7, error: Infinity },
    hint: 'group related parameters into one object or split the function.',
    measure: (fn) => fn.parameterCount,
  },
  {
    key: 'maxFunctionHalsteadVolume',
    label: 'Halstead volume',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'the function holds too many operators and operands; move cohesive parts into helper functions.',
    measure: (fn) => fn.halstead.volume,
    includesNestedFunctions: true,
  },
  {
    key: 'maxFunctionHalsteadDifficulty',
    label: 'Halstead difficulty',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'the function reuses the same operands many times; split it so each part handles fewer values.',
    measure: (fn) => fn.halstead.difficulty,
    includesNestedFunctions: true,
  },
  {
    key: 'maxFunctionHalsteadEffort',
    label: 'Halstead effort',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'the function is both large and dense; split it into smaller functions with fewer values each.',
    measure: (fn) => fn.halstead.effort,
    includesNestedFunctions: true,
  },
  {
    key: 'maxFunctionDepDegree',
    label: 'DepDegree',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'too many values flow between the variables of the function; split it so each part works on fewer variables.',
    measure: (fn) => fn.depDegree,
  },
];

export const fileThresholds: readonly Threshold<CodeMetrics>[] = [
  {
    key: 'maxFileNcss',
    label: 'file NCSS',
    defaultLimits: { warning: 500, error: 1000 },
    hint: 'split the file into smaller modules with one responsibility each.',
    measure: (file) => file.ncssCount,
  },
];

/** A duplicated block violates when it spans at least this many lines. */
export const duplicationThreshold: Threshold<{ startLine: number; endLine: number }> = {
  key: 'minDuplicateLines',
  label: 'duplicated lines',
  defaultLimits: { warning: 10, error: 20 },
  hint: 'extract the repeated code into one shared function or module and call it from every location.',
  measure: (block) => block.endLine - block.startLine + 1,
};

export const thresholds: readonly Threshold[] = [...functionThresholds, ...fileThresholds, duplicationThreshold];

/** The name a report gives a threshold's measured value: its key without the `max`/`min` prefix. */
export function metricNameOf(threshold: Threshold): string {
  const name = threshold.key.slice(3);
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** One level of the `thresholds` config section; a missing key falls back to the less specific layer. */
export interface LevelThresholdsConfig {
  limits: Limits;
  /** Overrides for the files of one language, keyed by language name. */
  languages: Readonly<Record<string, Limits>>;
}

export type ThresholdsConfig = Readonly<Partial<Record<Level, LevelThresholdsConfig>>>;

/**
 * The limits of each level applying to files of each language, with precedence command-line
 * options > the config's per-language overrides > the config's limits > built-in defaults.
 */
export function resolveLimits(
  cliLimits: LimitsByLevel,
  config: ThresholdsConfig | undefined
): (language: string) => LimitsByLevel {
  const resolveLevel = (level: Level, language: string): Limits => {
    const levelConfig = config?.[level];
    return {
      ...Object.fromEntries(thresholds.map(({ key, defaultLimits }) => [key, defaultLimits[level]])),
      ...levelConfig?.limits,
      // Object.hasOwn: a language named like an Object.prototype member must not read an inherited value.
      ...(levelConfig && Object.hasOwn(levelConfig.languages, language) ? levelConfig.languages[language] : undefined),
      ...cliLimits[level],
    };
  };
  return (language) => ({ warning: resolveLevel('warning', language), error: resolveLevel('error', language) });
}
