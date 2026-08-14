import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { defaultDuplicationOptions } from './duplication.js';
import {
  defaultGateOptions,
  type GateOptions,
  type GateTolerances,
  type NewFunctionThresholds,
} from './regressionGate.js';
import type { DuplicationOptions } from './types.js';

export const configFileName = 'code-gauge.config.json';
export const defaultTopFileCount = 10;

/** Regression-gate settings for `code-gauge diff`; unset fields use the built-in defaults. */
export interface GateConfig {
  newFunction?: Partial<NewFunctionThresholds>;
  tolerance?: Partial<GateTolerances>;
  matchSimilarityPercent?: number;
}

/** Shape of the JSON configuration file. All fields are optional and fall back to the built-in defaults. */
export interface CodeGaugeConfig {
  /** Duplication detection settings applied to every measured file. */
  duplication?: DuplicationOptions;
  /** Refactoring-candidate ranking settings. */
  rank?: { top?: number };
  /** Regression-gate settings for `code-gauge diff`. */
  gate?: GateConfig;
  includeTests?: boolean;
  failOnError?: boolean;
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
  /** Number of top-ranked files to report. */
  top: number;
  includeTests: boolean;
  failOnError: boolean;
  json: boolean;
}

/** Resolves options with precedence command-line flags > configuration file > built-in defaults. */
export function resolveOptions(cli: CliOptions, config: CodeGaugeConfig): ResolvedOptions {
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
    top: cli.top ?? config.rank?.top ?? defaultTopFileCount,
    includeTests: cli.includeTests ?? config.includeTests ?? false,
    failOnError: cli.failOnError ?? config.failOnError ?? false,
    json: cli.json ?? false,
  };
}

/** Resolves the regression-gate settings with precedence configuration file > built-in defaults. */
export function resolveGateOptions(config: CodeGaugeConfig): GateOptions {
  return {
    newFunction: { ...defaultGateOptions.newFunction, ...config.gate?.newFunction },
    tolerance: { ...defaultGateOptions.tolerance, ...config.gate?.tolerance },
    matchSimilarityPercent: config.gate?.matchSimilarityPercent ?? defaultGateOptions.matchSimilarityPercent,
  };
}

/**
 * Loads the configuration file. An explicit path must exist; otherwise the nearest
 * `code-gauge.config.json` is searched by walking up from the target directory.
 */
export async function loadConfig(explicitPath: string | undefined, targetDirectory: string): Promise<CodeGaugeConfig> {
  const configFile = explicitPath ?? (await findNearestConfig(targetDirectory));
  if (!configFile) {
    return {};
  }

  let content;
  try {
    content = await readFile(configFile, 'utf8');
  } catch (error) {
    if (explicitPath) {
      throw new Error(`Cannot read config file "${configFile}": ${formatError(error)}`);
    }
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON in config file "${configFile}": ${formatError(error)}`);
  }

  return validateConfig(parsed, configFile);
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Config file "${configFile}" must contain a JSON object.`);
  }

  const raw = value as Record<string, unknown>;
  const knownKeys = new Set(['duplication', 'rank', 'gate', 'includeTests', 'failOnError']);
  for (const key of Object.keys(raw)) {
    if (!knownKeys.has(key)) {
      throw new Error(`Config file "${configFile}": unknown setting "${key}" (expected ${[...knownKeys].join(', ')}).`);
    }
  }
  const config: CodeGaugeConfig = {};

  if (raw.duplication !== undefined) {
    config.duplication = validateDuplicationObject(raw.duplication, configFile);
  }

  if (raw.rank !== undefined) {
    config.rank = validateRankObject(raw.rank, configFile);
  }

  if (raw.gate !== undefined) {
    config.gate = validateGateObject(raw.gate, configFile);
  }

  for (const key of ['includeTests', 'failOnError'] as const) {
    if (raw[key] !== undefined) {
      config[key] = requireBoolean(raw[key], key, configFile);
    }
  }

  return config;
}

function validateRankObject(value: unknown, configFile: string): { top?: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Config file "${configFile}": "rank" must be an object.`);
  }
  const rank: { top?: number } = {};
  for (const [key, setting] of Object.entries(value as Record<string, unknown>)) {
    if (key !== 'top') {
      throw new Error(`Config file "${configFile}": unknown setting "${key}" in "rank" (expected top).`);
    }
    rank.top = requirePositiveInteger(setting, 'rank.top', configFile);
  }
  return rank;
}

function validateGateObject(value: unknown, configFile: string): GateConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Config file "${configFile}": "gate" must be an object.`);
  }
  const gate: GateConfig = {};
  for (const [key, setting] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'newFunction') {
      gate.newFunction = validateGateNumberObject(
        setting,
        'gate.newFunction',
        Object.keys(defaultGateOptions.newFunction),
        configFile,
        requirePositiveInteger
      ) as Partial<NewFunctionThresholds>;
    } else if (key === 'tolerance') {
      gate.tolerance = validateGateNumberObject(
        setting,
        'gate.tolerance',
        Object.keys(defaultGateOptions.tolerance),
        configFile,
        requireNonNegativeNumber
      ) as Partial<GateTolerances>;
    } else if (key === 'matchSimilarityPercent') {
      const parsed = requirePositiveInteger(setting, 'gate.matchSimilarityPercent', configFile);
      if (parsed > 100) {
        throw new Error(`Config file "${configFile}": "gate.matchSimilarityPercent" must be between 1 and 100.`);
      }
      gate.matchSimilarityPercent = parsed;
    } else {
      throw new Error(
        `Config file "${configFile}": unknown setting "${key}" in "gate" (expected newFunction, tolerance, or matchSimilarityPercent).`
      );
    }
  }
  return gate;
}

function validateGateNumberObject(
  value: unknown,
  settingName: string,
  knownKeys: string[],
  configFile: string,
  requireNumber: (value: unknown, key: string, configFile: string) => number
): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Config file "${configFile}": "${settingName}" must be an object.`);
  }
  const validated: Record<string, number> = {};
  for (const [key, setting] of Object.entries(value as Record<string, unknown>)) {
    if (!knownKeys.includes(key)) {
      throw new Error(
        `Config file "${configFile}": unknown setting "${key}" in "${settingName}" (expected ${knownKeys.join(', ')}).`
      );
    }
    validated[key] = requireNumber(setting, `${settingName}.${key}`, configFile);
  }
  return validated;
}

function validateDuplicationObject(value: unknown, configFile: string): DuplicationOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Config file "${configFile}": "duplication" must be an object.`);
  }
  const duplication: DuplicationOptions = {};
  for (const [key, setting] of Object.entries(value as Record<string, unknown>)) {
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

/** Tolerances may be fractional (e.g. Halstead volume), so only finiteness and sign are checked. */
function requireNonNegativeNumber(value: unknown, key: string, configFile: string): number {
  return requireNumber(value, key, configFile, Number.isFinite, 'a non-negative number');
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
