import { createRequire } from 'node:module';
import { defaultLanguages } from './languages.js';
import type { CodeMetrics, LanguageDefinition } from './types.js';

/**
 * Halstead counts measured natively; the derived float metrics (volume, effort, ...) are
 * computed in TypeScript because V8 and Rust disagree on the last bit of log/log2 results, and
 * the native backend must be bit-identical to the TypeScript one.
 */
export interface NativeHalsteadCounts {
  distinctOperators: number;
  distinctOperands: number;
  totalOperators: number;
  totalOperands: number;
}

export interface NativeMetricsPayload extends Omit<CodeMetrics, 'halstead' | 'syntaxTree'> {
  halsteadCounts: NativeHalsteadCounts;
  syntaxTree?: string;
}

interface NativeBinding {
  measureCodeNative(code: string, language: string, includeSyntaxTree: boolean): string;
}

const defaultLanguageByName = new Map(defaultLanguages.map((language) => [language.name, language]));

let bindingLoadAttempted = false;
let cachedBinding: NativeBinding | undefined;

/**
 * Measures via the Rust addon when it is built and applicable, or returns undefined so the caller
 * falls back to the TypeScript implementation. Custom-registered languages always fall back: the
 * addon only embeds the built-in grammars.
 */
export function measureWithNativeBackend(
  code: string,
  language: LanguageDefinition,
  includeSyntaxTree: boolean
): NativeMetricsPayload | undefined {
  if (!isNativeBackendEnabled() || defaultLanguageByName.get(language.name) !== language) {
    return undefined;
  }

  // Lone surrogates cannot cross the N-API boundary losslessly (they become U+FFFD), so
  // ill-formed strings measure through the TypeScript backend, which sees them as-is.
  if (!code.isWellFormed()) {
    return undefined;
  }

  const binding = loadBinding();
  if (!binding) {
    return undefined;
  }

  try {
    return JSON.parse(binding.measureCodeNative(code, language.name, includeSyntaxTree)) as NativeMetricsPayload;
  } catch (error) {
    // Parity tests set the strict flag: without it, a binding that starts throwing would silently
    // degrade the "native" side of every comparison into a TypeScript-vs-TypeScript check.
    if (process.env.CODE_GAUGE_NATIVE_STRICT === '1') {
      throw error;
    }
    // A native failure (e.g. the tree-depth guard on pathological input) falls back to the
    // TypeScript backend instead of turning measureCode into a throwing API.
    return undefined;
  }
}

/** Whether measureCode currently uses the native backend for built-in languages. */
export function isNativeBackendAvailable(): boolean {
  return isNativeBackendEnabled() && loadBinding() !== undefined;
}

/** Checked per call (not cached) so tests can flip backends within one process. */
function isNativeBackendEnabled(): boolean {
  return process.env.CODE_GAUGE_NATIVE !== '0';
}

function loadBinding(): NativeBinding | undefined {
  if (bindingLoadAttempted) {
    return cachedBinding;
  }
  bindingLoadAttempted = true;

  try {
    // Resolved relative to this file, so both src/ (tests) and dist/ (build) find native/.
    const requireNative = createRequire(import.meta.url);
    cachedBinding = requireNative('../native/code-gauge.node') as NativeBinding;
  } catch {
    // The addon has not been built (or this platform/module format cannot load it).
  }
  return cachedBinding;
}
