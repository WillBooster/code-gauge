import type { CodeMetrics, FunctionMetrics } from './types.js';

/** The severities of a violation, mildest first. */
export const levels = ['warning', 'error'] as const;
export type Level = (typeof levels)[number];

/**
 * One threshold of `code-gauge check`. Its `key` is the config setting, the per-language override
 * setting, and (kebab-cased after a level prefix) the command-line options, so a new entry here is
 * all a new thresholded metric needs.
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
  /**
   * The value of a function is at least that of each function nested in it, whose code it counts
   * too. Not so for Halstead difficulty and effort: a ratio can be higher for the nested part alone.
   */
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
    defaultLimits: { warning: 30, error: 60 },
    hint: 'move the statements that form one step into a named function; leave a flat list of independent one-line steps as it is.',
    measure: (fn) => fn.ncss,
    includesNestedFunctions: true,
  },
  {
    key: 'maxFunctionNestingDepth',
    label: 'nesting depth',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'replace nested conditions with guard clauses or move inner blocks into functions.',
    measure: (fn) => fn.nestingDepth,
  },
  {
    key: 'maxFunctionParameterCount',
    label: 'parameters',
    defaultLimits: { warning: 6, error: Infinity },
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
  },
  {
    key: 'maxFunctionHalsteadEffort',
    label: 'Halstead effort',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'the function is both large and dense; split it into smaller functions with fewer values each.',
    measure: (fn) => fn.halstead.effort,
  },
  {
    key: 'maxFunctionDepDegree',
    label: 'DepDegree',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'too many values flow between the variables of the function; split it so each part works on fewer variables.',
    measure: (fn) => fn.depDegree,
    includesNestedFunctions: true,
  },
];

export const fileThresholds: readonly Threshold<CodeMetrics>[] = [
  {
    key: 'maxFileNcss',
    label: 'file NCSS',
    defaultLimits: { warning: 400, error: 1000 },
    hint: 'split the file into modules with one responsibility each, for example by moving a class or the helpers that serve only one function into a file of their own.',
    measure: (file) => file.ncssCount,
  },
];

/**
 * A duplicated block violates when it holds at least this many code lines: comment-only and blank
 * lines do not count, so a copy reads the same length whether or not it is commented.
 */
export const duplicationThreshold: Threshold<{ codeLineCount: number }> = {
  key: 'minDuplicateLines',
  label: 'duplicated lines',
  defaultLimits: { warning: 15, error: Infinity },
  hint: 'extract the repeated code into one shared function or module and call it from every location.',
  measure: (block) => block.codeLineCount,
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
