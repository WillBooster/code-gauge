import type { CodeMetrics, FunctionMetrics } from './types.js';

/**
 * One limit of `code-gauge check`. Its `key` is the config setting, the per-language override
 * setting, and (kebab-cased) the command-line option, so a new entry here is all a new thresholded
 * metric needs.
 */
export interface Threshold<Subject = never> {
  key: string;
  /** How the report names the measured value. */
  label: string;
  defaultLimit: number;
  /** What to change in the code when the limit is exceeded. */
  hint: string;
  measure: (subject: Subject) => number;
}

/** Limits by threshold key; `Infinity` disables a limit. */
export type Limits = Readonly<Record<string, number>>;

export const functionThresholds: readonly Threshold<FunctionMetrics>[] = [
  {
    key: 'maxFunctionCognitiveComplexity',
    label: 'cognitive complexity',
    defaultLimit: 15,
    hint: 'flatten nested branching with early returns and extract nested blocks into named functions.',
    measure: (fn) => fn.cognitiveComplexity,
  },
  {
    key: 'maxFunctionCyclomaticComplexity',
    label: 'cyclomatic complexity',
    defaultLimit: 10,
    hint: 'the function has too many independent paths; split it by decision or replace condition chains with a lookup table.',
    measure: (fn) => fn.cyclomaticComplexity,
  },
  {
    key: 'maxFunctionNcss',
    label: 'NCSS',
    defaultLimit: 60,
    hint: 'split the function into smaller functions that each do one step.',
    measure: (fn) => fn.ncss,
  },
  {
    key: 'maxFunctionNestingDepth',
    label: 'nesting depth',
    defaultLimit: 4,
    hint: 'replace nested conditions with guard clauses or move inner blocks into functions.',
    measure: (fn) => fn.nestingDepth,
  },
  {
    key: 'maxFunctionParameterCount',
    label: 'parameters',
    defaultLimit: 7,
    hint: 'group related parameters into one object or split the function.',
    measure: (fn) => fn.parameterCount,
  },
  {
    key: 'maxFunctionHalsteadVolume',
    label: 'Halstead volume',
    defaultLimit: 2000,
    hint: 'the function holds too many operators and operands; move cohesive parts into helper functions.',
    measure: (fn) => fn.halstead.volume,
  },
  {
    key: 'maxFunctionHalsteadDifficulty',
    label: 'Halstead difficulty',
    defaultLimit: 20,
    hint: 'the function reuses the same operands many times; split it so each part handles fewer values.',
    measure: (fn) => fn.halstead.difficulty,
  },
  {
    key: 'maxFunctionHalsteadEffort',
    label: 'Halstead effort',
    defaultLimit: 30_000,
    hint: 'the function is both large and dense; split it into smaller functions with fewer values each.',
    measure: (fn) => fn.halstead.effort,
  },
  {
    key: 'maxFunctionDepDegree',
    label: 'DepDegree',
    defaultLimit: 50,
    hint: 'too many values flow between the variables of the function; split it so each part works on fewer variables.',
    measure: (fn) => fn.depDegree,
  },
];

export const fileThresholds: readonly Threshold<CodeMetrics>[] = [
  {
    key: 'maxFileNcss',
    label: 'file NCSS',
    defaultLimit: 500,
    hint: 'split the file into smaller modules with one responsibility each.',
    measure: (file) => file.ncssCount,
  },
];

/** A duplicated block violates when it spans at least this many lines. */
export const duplicationThreshold: Threshold<{ startLine: number; endLine: number }> = {
  key: 'minDuplicateLines',
  label: 'duplicated lines',
  defaultLimit: 10,
  hint: 'extract the repeated code into one shared function or module and call it from every location.',
  measure: (block) => block.endLine - block.startLine + 1,
};

export const thresholds: readonly Threshold[] = [...functionThresholds, ...fileThresholds, duplicationThreshold];

/** The name a report gives a threshold's measured value: its key without the `max`/`min` prefix. */
export function metricNameOf(threshold: Threshold): string {
  const name = threshold.key.slice(3);
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** The `thresholds` config section; a missing key falls back to the less specific layer. */
export interface ThresholdsConfig {
  limits: Limits;
  /** Overrides for the files of one language, keyed by language name. */
  languages: Readonly<Record<string, Limits>>;
}

/**
 * The limits applying to files of each language, with precedence command-line options > the
 * config's per-language overrides > the config's limits > built-in defaults.
 */
export function resolveLimits(cliLimits: Limits, config: ThresholdsConfig | undefined): (language: string) => Limits {
  const defaults = Object.fromEntries(thresholds.map(({ key, defaultLimit }) => [key, defaultLimit]));
  const shared = { ...defaults, ...config?.limits };
  return (language) => ({
    ...shared,
    // Object.hasOwn: a language named like an Object.prototype member must not read an inherited value.
    ...(config && Object.hasOwn(config.languages, language) ? config.languages[language] : undefined),
    ...cliLimits,
  });
}
