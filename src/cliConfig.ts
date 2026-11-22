import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { getErrorMessage } from '@willbooster/shared-lib';
import { z } from 'zod';

import { defaultDuplicationOptions } from './duplication.js';
import type { ExcludePatterns } from './exclusion.js';
import { type RuleOverride, type Rules, testShareThreshold, thresholds } from './thresholds.js';
import type { DuplicationOptions } from './types.js';

export const configFileName = 'code-gauge.config.json';
export const defaultTopFileCount = 10;

/** Shape of the JSON configuration file. All fields are optional and fall back to the built-in defaults. */
export interface CodeGaugeConfig {
  /** Duplication detection settings applied to every measured file. */
  duplication?: DuplicationOptions;
  /** Refactoring-candidate ranking settings. */
  rank?: { top?: number };
  /** Limits of `code-gauge check` by metric. */
  rules?: Rules;
  /** Rules for the files matching glob patterns relative to the config file's directory; later entries win. */
  overrides?: RuleOverride[];
  /** Glob patterns, relative to the config file's directory, of files left out of every command. */
  exclude?: string[];
  includeTests?: boolean;
  failOnError?: boolean;
}

/** A parsed configuration file and the directory its relative settings resolve against. */
export interface LoadedConfig {
  config: CodeGaugeConfig;
  /** The config file's directory; the search start directory when no config file was found. */
  directory: string;
}

/** Raw command-line options; every field is undefined unless the user passed the flag. */
export interface CliOptions {
  config?: string;
  top?: number;
  duplicationMinTokens?: number;
  duplicationMaxGapTokens?: number;
  duplicationMinSimilarityPercent?: number;
  includeTests?: boolean;
  failOnError?: boolean;
  json?: boolean;
}

/** Options after merging command-line flags, the configuration file, and the built-in defaults. */
export interface ResolvedOptions {
  duplication: Required<DuplicationOptions>;
  exclude: ExcludePatterns;
  /** Number of top-ranked files to report. */
  top: number;
  includeTests: boolean;
  failOnError: boolean;
  json: boolean;
}

/** Resolves options with precedence command-line flags > configuration file > built-in defaults. */
export function resolveOptions(cli: CliOptions, { config, directory }: LoadedConfig): ResolvedOptions {
  return {
    duplication: {
      minTokens: cli.duplicationMinTokens ?? config.duplication?.minTokens ?? defaultDuplicationOptions.minTokens,
      maxGapTokens:
        cli.duplicationMaxGapTokens ?? config.duplication?.maxGapTokens ?? defaultDuplicationOptions.maxGapTokens,
      minSimilarityPercent:
        cli.duplicationMinSimilarityPercent ??
        config.duplication?.minSimilarityPercent ??
        defaultDuplicationOptions.minSimilarityPercent,
    },
    exclude: { patterns: config.exclude ?? [], root: directory },
    top: cli.top ?? config.rank?.top ?? defaultTopFileCount,
    includeTests: cli.includeTests ?? config.includeTests ?? false,
    failOnError: cli.failOnError ?? config.failOnError ?? false,
    json: cli.json ?? false,
  };
}

/**
 * Loads the configuration file. An explicit path must exist; otherwise the nearest
 * `code-gauge.config.json` is searched by walking up from the target directory.
 */
export async function loadConfig(explicitPath: string | undefined, targetDirectory: string): Promise<LoadedConfig> {
  const configFile = explicitPath ?? (await findNearestConfig(targetDirectory));
  if (!configFile) {
    return { config: {}, directory: targetDirectory };
  }

  let content;
  try {
    content = await readFile(configFile, 'utf8');
  } catch (error) {
    if (explicitPath) {
      throw new Error(`Cannot read config file "${configFile}": ${getErrorMessage(error)}`);
    }
    return { config: {}, directory: targetDirectory };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in config file "${configFile}": ${getErrorMessage(error)}`);
  }

  return { config: validateConfig(parsed, configFile), directory: path.dirname(path.resolve(configFile)) };
}

async function findNearestConfig(targetDirectory: string): Promise<string | undefined> {
  let currentDirectory = targetDirectory;
  while (true) {
    const configFile = path.join(currentDirectory, configFileName);
    if (await fileExists(configFile)) {
      return configFile;
    }

    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) {
      return undefined;
    }
    currentDirectory = parentDirectory;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    const fileStat = await stat(file);
    return fileStat.isFile();
  } catch {
    return false;
  }
}

/** A limit as written: a non-negative number, or `"off"` to disable it. */
const limitMessage = 'must be a non-negative number or "off"';
const limitSchema = z.union(
  [z.literal('off'), z.number({ error: limitMessage }).nonnegative({ error: limitMessage })],
  {
    error: limitMessage,
  }
);

/** A rule as written: `"off"` for every level, or a limit per level; an omitted level keeps its default. */
const ruleSchema = z.union(
  [z.literal('off'), z.strictObject({ warn: limitSchema.optional(), error: limitSchema.optional() })],
  { error: 'must be "off" or an object whose "warn" and "error" limits are non-negative numbers or "off"' }
);

type WrittenRules = Record<string, z.infer<typeof ruleSchema> | undefined>;

function rulesSchema(metrics: readonly string[]): z.ZodType<WrittenRules> {
  return z.strictObject(Object.fromEntries(metrics.map((metric) => [metric, ruleSchema.optional()])), {
    error: 'must be an object',
  });
}

const fileMetrics = thresholds.filter((threshold) => threshold !== testShareThreshold).map(({ metric }) => metric);

function integerSchema(minimum: number, maximum = Number.MAX_SAFE_INTEGER): z.ZodInt {
  const error =
    maximum < Number.MAX_SAFE_INTEGER
      ? `must be between ${minimum} and ${maximum}`
      : `must be a ${minimum > 0 ? 'positive' : 'non-negative'} integer`;
  return z.int({ error }).min(minimum, { error }).max(maximum, { error });
}

const globsMessage = 'must be an array of non-empty glob patterns';
const globMessage = 'must be a non-empty glob pattern';
const globsSchema = z.array(z.string({ error: globMessage }).min(1, { error: globMessage }), { error: globsMessage });

/** The configuration file's shape; the published JSON Schema is generated from it. */
export const configSchema = z.strictObject(
  {
    $schema: z.string({ error: 'must be a string' }).optional(),
    duplication: z
      .strictObject(
        {
          minTokens: integerSchema(1).optional(),
          // 0 is meaningful: it disables gapped-clone merging.
          maxGapTokens: integerSchema(0).optional(),
          minSimilarityPercent: integerSchema(1, 100).optional(),
        },
        { error: 'must be an object' }
      )
      .optional(),
    rank: z.strictObject({ top: integerSchema(1).optional() }, { error: 'must be an object' }).optional(),
    rules: rulesSchema(thresholds.map(({ metric }) => metric)).optional(),
    // The share of test code is measured for the whole project, so no file pattern can change its limit.
    overrides: z
      .array(
        z.strictObject(
          {
            files: globsSchema.min(1, { error: globsMessage }),
            rules: rulesSchema(fileMetrics),
          },
          { error: 'must be an object with "files" and "rules"' }
        ),
        { error: 'must be an array' }
      )
      .optional(),
    exclude: globsSchema.optional(),
    includeTests: z.boolean({ error: 'must be a boolean' }).optional(),
    failOnError: z.boolean({ error: 'must be a boolean' }).optional(),
  },
  { error: 'must contain a JSON object' }
);

/** Settings of earlier releases, which name the setting that replaced each of them. */
const replacedSettings: Readonly<Record<string, string>> = {
  thresholds: '"rules" (and "overrides" for file patterns)',
};

function validateConfig(value: unknown, configFile: string): CodeGaugeConfig {
  const result = configSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Config file "${configFile}": ${describeIssue(result.error.issues[0] as z.core.$ZodIssue)}`);
  }
  const { rules, overrides, ...rest } = result.data;
  const { $schema: _schema, ...config } = rest;
  return {
    ...config,
    ...(rules && { rules: toRules(rules) }),
    ...(overrides && {
      overrides: overrides.map((override) => ({ files: override.files, rules: toRules(override.rules) })),
    }),
  };
}

function describeIssue(issue: z.core.$ZodIssue): string {
  // An object written for a rule fails the union as a whole; its own issue names the level to edit.
  const nested =
    issue.code === 'invalid_union' ? issue.errors.flat().find((branchIssue) => branchIssue.path.length > 0) : undefined;
  if (nested) {
    return describeIssue({ ...nested, path: [...issue.path, ...nested.path] });
  }
  const location = issue.path.length === 0 ? 'the config' : `"${issue.path.join('.')}"`;
  if (issue.code === 'unrecognized_keys') {
    const [key] = issue.keys;
    const replacement = issue.path.length === 0 && key ? replacedSettings[key] : undefined;
    return replacement
      ? `"${key}" is no longer supported; use ${replacement}.`
      : `unknown setting "${key}" in ${location}.`;
  }
  return issue.path.length === 0 ? `the file ${issue.message}.` : `${location} ${issue.message}.`;
}

/** Rules with `"off"` turned into an `Infinity` limit for every level, and level names as reported. */
function toRules(rules: WrittenRules): Rules {
  return Object.fromEntries(
    Object.entries(rules).flatMap(([metric, rule]) => {
      if (rule === undefined) {
        return [];
      }
      if (rule === 'off') {
        return [[metric, { warning: Infinity, error: Infinity }]];
      }
      return [
        [
          metric,
          {
            ...(rule.warn !== undefined && { warning: toLimit(rule.warn) }),
            ...(rule.error !== undefined && { error: toLimit(rule.error) }),
          },
        ],
      ];
    })
  );
}

function toLimit(limit: 'off' | number): number {
  return limit === 'off' ? Infinity : limit;
}
