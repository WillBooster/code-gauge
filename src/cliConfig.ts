import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { getErrorMessage, isRecord } from '@willbooster/shared-lib';
import { defaultDuplicationOptions } from './duplication.js';
import type { ExcludePatterns } from './exclusion.js';
import { supportedLanguages } from './languages.js';
import {
  levels,
  thresholds,
  type Level,
  type LevelThresholdsConfig,
  type Limits,
  type ThresholdsConfig,
} from './thresholds.js';
import type { DuplicationOptions } from './types.js';

export const configFileName = 'code-gauge.config.json';
export const defaultTopFileCount = 10;

/** Shape of the JSON configuration file. All fields are optional and fall back to the built-in defaults. */
export interface CodeGaugeConfig {
  /** Duplication detection settings applied to every measured file. */
  duplication?: DuplicationOptions;
  /** Refactoring-candidate ranking settings. */
  rank?: { top?: number };
  /** Limits of `code-gauge check`. */
  thresholds?: ThresholdsConfig;
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

function validateConfig(value: unknown, configFile: string): CodeGaugeConfig {
  if (!isRecord(value)) {
    throw new Error(`Config file "${configFile}" must contain a JSON object.`);
  }

  const knownKeys = new Set(['duplication', 'rank', 'thresholds', 'exclude', 'includeTests', 'failOnError']);
  for (const key of Object.keys(value)) {
    if (!knownKeys.has(key)) {
      throw new Error(`Config file "${configFile}": unknown setting "${key}" (expected ${[...knownKeys].join(', ')}).`);
    }
  }
  const config: CodeGaugeConfig = {};

  if (value.duplication !== undefined) {
    config.duplication = validateDuplicationObject(value.duplication, configFile);
  }

  if (value.rank !== undefined) {
    config.rank = validateRankObject(value.rank, configFile);
  }

  if (value.thresholds !== undefined) {
    config.thresholds = validateThresholdsObject(value.thresholds, configFile);
  }

  if (value.exclude !== undefined) {
    config.exclude = validateExcludePatterns(value.exclude, configFile);
  }

  for (const key of ['includeTests', 'failOnError'] as const) {
    if (value[key] !== undefined) {
      config[key] = requireBoolean(value[key], key, configFile);
    }
  }

  return config;
}

function validateExcludePatterns(value: unknown, configFile: string): string[] {
  if (!Array.isArray(value) || !value.every((pattern) => typeof pattern === 'string' && pattern !== '')) {
    throw new TypeError(`Config file "${configFile}": "exclude" must be an array of non-empty glob patterns.`);
  }
  return value as string[];
}

function validateRankObject(value: unknown, configFile: string): { top?: number } {
  if (!isRecord(value)) {
    throw new Error(`Config file "${configFile}": "rank" must be an object.`);
  }
  const rank: { top?: number } = {};
  for (const [key, setting] of Object.entries(value)) {
    if (key !== 'top') {
      throw new Error(`Config file "${configFile}": unknown setting "${key}" in "rank" (expected top).`);
    }
    rank.top = requirePositiveInteger(setting, 'rank.top', configFile);
  }
  return rank;
}

function validateThresholdsObject(value: unknown, configFile: string): ThresholdsConfig {
  return Object.fromEntries(
    Object.entries(requireRecord(value, 'thresholds', configFile)).map(([level, levelThresholds]) => {
      if (!levels.includes(level as Level)) {
        throw new Error(
          `Config file "${configFile}": unknown setting "${level}" in "thresholds" (expected ${levels.join(', ')}).`
        );
      }
      return [level, validateLevelThresholds(levelThresholds, `thresholds.${level}`, configFile)];
    })
  );
}

function validateLevelThresholds(value: unknown, settingName: string, configFile: string): LevelThresholdsConfig {
  const { languages, ...limits } = requireRecord(value, settingName, configFile);
  const languagesName = `${settingName}.languages`;
  return {
    limits: validateLimits(limits, settingName, ['languages'], configFile),
    languages: Object.fromEntries(
      Object.entries(languages === undefined ? {} : requireRecord(languages, languagesName, configFile)).map(
        ([language, overrides]) => {
          if (!supportedLanguages.includes(language)) {
            throw new Error(
              `Config file "${configFile}": unknown language "${language}" in "${languagesName}" (expected ${supportedLanguages.join(', ')}).`
            );
          }
          const languageName = `${languagesName}.${language}`;
          return [
            language,
            validateLimits(requireRecord(overrides, languageName, configFile), languageName, [], configFile),
          ];
        }
      )
    ),
  };
}

/** Limits as written in the config file, where `null` disables one. */
function validateLimits(
  value: Record<string, unknown>,
  settingName: string,
  otherKeys: string[],
  configFile: string
): Limits {
  const knownKeys = thresholds.map(({ key }) => key);
  return Object.fromEntries(
    Object.entries(value).map(([key, limit]) => {
      if (!knownKeys.includes(key)) {
        throw new Error(
          `Config file "${configFile}": unknown setting "${key}" in "${settingName}" (expected ${[...knownKeys, ...otherKeys].join(', ')}).`
        );
      }
      if (limit !== null && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 0)) {
        throw new Error(`Config file "${configFile}": "${settingName}.${key}" must be a non-negative number or null.`);
      }
      return [key, limit ?? Infinity];
    })
  );
}

function requireRecord(value: unknown, settingName: string, configFile: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Config file "${configFile}": "${settingName}" must be an object.`);
  }
  return value;
}

function validateDuplicationObject(value: unknown, configFile: string): DuplicationOptions {
  if (!isRecord(value)) {
    throw new Error(`Config file "${configFile}": "duplication" must be an object.`);
  }
  const duplication: DuplicationOptions = {};
  for (const [key, setting] of Object.entries(value)) {
    if (key === 'minTokens') {
      duplication.minTokens = requirePositiveInteger(setting, 'duplication.minTokens', configFile);
    } else if (key === 'maxGapTokens') {
      // 0 is meaningful: it disables gapped-clone merging.
      duplication.maxGapTokens = requireNonNegativeInteger(setting, 'duplication.maxGapTokens', configFile);
    } else if (key === 'minSimilarityPercent') {
      const parsed = requirePositiveInteger(setting, 'duplication.minSimilarityPercent', configFile);
      if (parsed > 100) {
        throw new Error(`Config file "${configFile}": "duplication.minSimilarityPercent" must be between 1 and 100.`);
      }
      duplication.minSimilarityPercent = parsed;
    } else {
      throw new Error(
        `Config file "${configFile}": unknown setting "${key}" in "duplication" (expected minTokens, maxGapTokens, or minSimilarityPercent).`
      );
    }
  }
  return duplication;
}

function requireNonNegativeInteger(value: unknown, key: string, configFile: string): number {
  return requireNumber(value, key, configFile, Number.isSafeInteger, 'a non-negative integer');
}

function requirePositiveInteger(value: unknown, key: string, configFile: string): number {
  const parsed = requireNumber(value, key, configFile, Number.isSafeInteger, 'a positive integer');
  if (parsed < 1) {
    throw new Error(`Config file "${configFile}": "${key}" must be a positive integer.`);
  }
  return parsed;
}

/** Shared core of the numeric validators: the right kind of number, and never negative. */
function requireNumber(
  value: unknown,
  key: string,
  configFile: string,
  isValidKind: (value: unknown) => boolean,
  description: string
): number {
  if (typeof value !== 'number' || !isValidKind(value) || value < 0) {
    throw new Error(`Config file "${configFile}": "${key}" must be ${description}.`);
  }
  return value;
}

function requireBoolean(value: unknown, key: string, configFile: string): boolean {
  if (typeof value !== 'boolean') {
    throw new TypeError(`Config file "${configFile}": "${key}" must be a boolean.`);
  }
  return value;
}
