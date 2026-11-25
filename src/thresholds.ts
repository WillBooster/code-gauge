import { matchesGlobs } from './exclusion.js';
import type { CodeMetrics, FunctionMetrics } from './types.js';

/** The severities of a violation, mildest first. */
export const levels = ['warning', 'error'] as const;
export type Level = (typeof levels)[number];

/**
 * One threshold of `code-gauge check`. Its `metric` names the rule in the config, the command line,
 * the report, and allow directives, so a new entry here is all a new thresholded metric needs.
 */
export interface Threshold<Subject = never> {
  metric: string;
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

/** Limits by metric; `Infinity` disables a limit. */
export type Limits = Readonly<Record<string, number>>;
export type LimitsByLevel = Readonly<Record<Level, Limits>>;

export const functionThresholds: readonly Threshold<FunctionMetrics>[] = [
  {
    metric: 'functionCognitiveComplexity',
    label: 'cognitive complexity',
    defaultLimits: { warning: 15, error: 30 },
    hint: 'flatten nested branching with early returns and extract nested blocks into named functions.',
    measure: (fn) => fn.cognitiveComplexity,
    includesNestedFunctions: true,
  },
  {
    metric: 'functionCyclomaticComplexity',
    label: 'cyclomatic complexity',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'the function has too many independent paths; split it by decision or replace condition chains with a lookup table.',
    measure: (fn) => fn.cyclomaticComplexity,
  },
  {
    metric: 'functionNcss',
    label: 'NCSS',
    defaultLimits: { warning: 30, error: 60 },
    hint: 'move each group of statements that forms one step into a named function.',
    measure: (fn) => fn.ncss,
    includesNestedFunctions: true,
  },
  {
    metric: 'functionNestingDepth',
    label: 'nesting depth',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'replace nested conditions with guard clauses or move inner blocks into functions.',
    measure: (fn) => fn.nestingDepth,
  },
  {
    metric: 'functionParameterCount',
    label: 'parameters',
    defaultLimits: { warning: 6, error: Infinity },
    hint: 'group related parameters into one object or split the function.',
    measure: (fn) => fn.parameterCount,
  },
  {
    metric: 'functionHalsteadVolume',
    label: 'Halstead volume',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'the function holds too many operators and operands; move cohesive parts into helper functions.',
    measure: (fn) => fn.halstead.volume,
    includesNestedFunctions: true,
  },
  {
    metric: 'functionHalsteadDifficulty',
    label: 'Halstead difficulty',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'the function reuses the same operands many times; split it so each part handles fewer values.',
    measure: (fn) => fn.halstead.difficulty,
  },
  {
    metric: 'functionHalsteadEffort',
    label: 'Halstead effort',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'the function is both large and dense; split it into smaller functions with fewer values each.',
    measure: (fn) => fn.halstead.effort,
  },
  {
    metric: 'functionDepDegree',
    label: 'DepDegree',
    defaultLimits: { warning: Infinity, error: Infinity },
    hint: 'too many values flow between the variables of the function; split it so each part works on fewer variables.',
    measure: (fn) => fn.depDegree,
    includesNestedFunctions: true,
  },
];

export const fileThresholds: readonly Threshold<CodeMetrics>[] = [
  {
    metric: 'fileNcss',
    label: 'file NCSS',
    defaultLimits: { warning: 400, error: 1000 },
    hint: 'split the file into modules with one responsibility each, for example by moving a class or the helpers that serve only one function into a file of their own.',
    measure: (file) => file.ncssCount,
  },
];

/**
 * A duplicated block violates when it holds at least this many duplicated lines, its code lines
 * matched in another copy: comment-only and blank lines do not count, so a copy reads the same
 * length whether or not it is commented, and neither do the lines the copies do not share, those
 * between the matched parts of an edited copy and those a near-miss copy adds or rewrites.
 */
export const duplicationThreshold: Threshold<{ duplicatedLineCount: number }> = {
  metric: 'duplicateLines',
  label: 'duplicated lines',
  defaultLimits: { warning: 15, error: Infinity },
  hint: 'extract the repeated code into one shared function or module and call it from every location.',
  measure: (block) => block.duplicatedLineCount,
};

/** The NCSS of the checked project's test files and of its other files. */
export interface TestShare {
  testNcss: number;
  productionNcss: number;
}

/**
 * Test code in proportion to the production code it checks; exceeding the limit calls for reviewing
 * tests against the project's test rule. The limit applies to the whole checked project, so no
 * override for file patterns can change it.
 */
export const testShareThreshold: Threshold<TestShare> = {
  metric: 'testNcssPercent',
  label: 'test NCSS percent',
  defaultLimits: { warning: 30, error: Infinity },
  hint: "review the tests against the project's test rule and delete or merge those it does not justify; a share still above the limit after that needs no further change.",
  measure: ({ testNcss, productionNcss }) => (testNcss * 100) / productionNcss,
};

export const thresholds: readonly Threshold[] = [
  ...functionThresholds,
  ...fileThresholds,
  duplicationThreshold,
  testShareThreshold,
];

/** A parsed rule of the config or the command line: a limit per reported level, `Infinity` for `"off"`. */
export type RuleLimits = Readonly<Partial<Record<Level, number>>>;
export type Rules = Readonly<Record<string, RuleLimits>>;

/** Rules that apply to the files matching any of the glob patterns, relative to `root`. */
export interface RuleOverride {
  files: readonly string[];
  rules: Rules;
}

export interface RulesConfig {
  rules: Rules;
  overrides: readonly RuleOverride[];
  /** The directory the override patterns are relative to. */
  root: string;
}

/**
 * The limits of each level applying to a file, each level taken from the last layer that sets it:
 * built-in defaults, the config's rules, the overrides matching the file in order, then the command
 * line. A layer changes only the levels it sets, as a later ESLint config entry does. Without a
 * file, the limits of the whole project, which overrides never touch.
 */
export function resolveLimits(cliRules: Rules, config: RulesConfig): (file?: string) => LimitsByLevel {
  return (file) => {
    const matchingOverrides =
      file === undefined ? [] : config.overrides.filter(({ files }) => matchesGlobs(config.root, file, files));
    const layers = [config.rules, ...matchingOverrides.map(({ rules }) => rules), cliRules];
    const resolveLevel = (level: Level): Limits =>
      Object.fromEntries(
        thresholds.map(({ metric, defaultLimits }) => [
          metric,
          layers.findLast((rules) => ruleOf(rules, metric)?.[level] !== undefined)?.[metric]?.[level] ??
            defaultLimits[level],
        ])
      );
    return { warning: resolveLevel('warning'), error: resolveLevel('error') };
  };
}

function ruleOf(rules: Rules, metric: string): RuleLimits | undefined {
  // Object.hasOwn: a metric named like an Object.prototype member must not read an inherited value.
  return Object.hasOwn(rules, metric) ? rules[metric] : undefined;
}
