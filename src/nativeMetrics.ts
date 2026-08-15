import { createRequire } from 'node:module';
import type { CrossFileDuplicateCandidate, Token, TokenRange } from './duplication.js';
import type { CodeMetrics, DuplicationOptions, FunctionMetrics } from './types.js';

/**
 * Halstead counts measured natively; the derived float metrics (volume, effort, ...) are
 * computed in TypeScript because they involve transcendental functions (log2) whose last-bit
 * results can differ between V8 and Rust's libm, and results must not depend on the Rust side's
 * libm build.
 */
export interface NativeHalsteadCounts {
  distinctOperators: number;
  distinctOperands: number;
  totalOperators: number;
  totalOperands: number;
}

export interface NativeFunctionMetricsPayload extends Omit<FunctionMetrics, 'halstead'> {
  halsteadCounts: NativeHalsteadCounts;
}

export interface NativeMetricsPayload extends Omit<CodeMetrics, 'halstead' | 'functions' | 'syntaxTree'> {
  functions: NativeFunctionMetricsPayload[];
  halsteadCounts: NativeHalsteadCounts;
  syntaxTree?: string;
}

/** One file's cross-file clone-detection contribution as serialized by the native addon. */
export interface NativeCrossFileDataPayload {
  candidates: CrossFileDuplicateCandidate[];
  tokens: Token[];
  containerStatements: TokenRange[][];
  /** 1-based lines that are neither blank nor comment-only, sorted ascending. */
  codeLineNumbers: number[];
}

interface NativeBinding {
  measureCodeNative(
    code: string,
    language: string,
    includeSyntaxTree: boolean,
    minTokens?: number,
    maxGapTokens?: number,
    minSimilarityPercent?: number
  ): string;
  collectCrossFileDataNative(code: string, language: string, minTokens?: number): string;
  collectFunctionTokenSequencesNative(code: string, language: string): string;
  payloadVersion?(): number;
}

/**
 * Must equal `payload_version` in native/src/lib.rs. A previously built addon survives a
 * `git pull` untouched, so without this handshake it would silently return payloads missing
 * newer fields instead of failing with a clear rebuild message.
 */
const expectedPayloadVersion = 4;

/** Measures one file via the native addon, returning the raw payload for assembly in metrics.ts. */
export function measureCodeNative(
  code: string,
  language: string,
  includeSyntaxTree: boolean,
  duplication?: DuplicationOptions
): NativeMetricsPayload {
  return JSON.parse(
    loadBinding().measureCodeNative(
      toWellFormed(code),
      language,
      includeSyntaxTree,
      clampToU32(duplication?.minTokens),
      clampToU32(duplication?.maxGapTokens),
      clampToU32(duplication?.minSimilarityPercent)
    )
  ) as NativeMetricsPayload;
}

/** Collects one file's cross-file clone-detection contribution via the native addon. */
export function collectCrossFileDataNative(
  code: string,
  language: string,
  minTokens?: number
): NativeCrossFileDataPayload {
  return JSON.parse(
    loadBinding().collectCrossFileDataNative(toWellFormed(code), language, clampToU32(minTokens))
  ) as NativeCrossFileDataPayload;
}

/** Collects normalized token hash sequences of every function via the native addon. */
export function collectFunctionTokenSequencesNative(code: string, language: string): Int32Array[] {
  const sequences = JSON.parse(
    loadBinding().collectFunctionTokenSequencesNative(toWellFormed(code), language)
  ) as number[][];
  return sequences.map((sequence) => Int32Array.from(sequence));
}

/**
 * Lone surrogates cannot cross the N-API boundary losslessly, so ill-formed strings (invalid
 * UTF-16 occasionally present in real-world files) are measured with U+FFFD replacements — the
 * same code units V8's own UTF-8 conversion would substitute.
 */
function toWellFormed(code: string): string {
  return code.isWellFormed() ? code : code.toWellFormed();
}

/**
 * The duplication settings cross the boundary as u32, whose JavaScript conversion wraps modulo
 * 2^32 (2 ** 32 would become 0 and match everything). The public API accepts any safe integer, so
 * out-of-range values clamp to [0, u32::MAX] — no source can hold 2^32 tokens, so a clamped
 * threshold behaves identically to the requested one. NaN (e.g. `Number(unsetEnvVariable)`)
 * survives clamping arithmetic and would also convert to 0, so it is treated as an absent setting
 * instead.
 */
function clampToU32(value: number | undefined): number | undefined {
  return value === undefined || Number.isNaN(value)
    ? undefined
    : Math.min(Math.max(Math.trunc(value), 0), 0xFF_FF_FF_FF);
}

/**
 * Raised when no usable native addon can be loaded. Every measurement fails identically until the
 * addon is built, so callers measuring many files (the CLI scan) treat it as fatal for the whole
 * run instead of recording one "skipped" entry per file.
 */
export class NativeAddonError extends Error {}

let cachedBinding: NativeBinding | undefined;
let cachedFailure: NativeAddonError | undefined;

function loadBinding(): NativeBinding {
  if (cachedBinding) {
    return cachedBinding;
  }
  // The failure is memoized too: resolution (including platformTriplet's diagnostic-report call
  // on Linux) would otherwise repeat for every measured file of an already-failing run.
  if (cachedFailure) {
    throw cachedFailure;
  }
  // Resolved relative to this file, so both src/ (tests) and dist/ (build) find the addon.
  const requireNative = createRequire(import.meta.url);
  const specifiers = [
    // A prebuilt platform package, when published for this platform.
    `code-gauge-${platformTriplet()}`,
    // A locally built addon (`bun run build-native`).
    '../native/code-gauge.node',
  ];
  const failures: string[] = [];
  for (const specifier of specifiers) {
    let binding: NativeBinding;
    try {
      binding = requireNative(specifier) as NativeBinding;
    } catch (error) {
      failures.push(`  ${specifier}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      continue;
    }
    const version = binding.payloadVersion?.();
    if (version !== expectedPayloadVersion) {
      failures.push(
        `  ${specifier}: payload version ${version ?? 'unknown'} does not match the expected ` +
          `${expectedPayloadVersion}; rebuild the addon with \`bun run build-native\``
      );
      continue;
    }
    cachedBinding = binding;
    return binding;
  }
  cachedFailure = new NativeAddonError(
    `The code-gauge native addon is not available for ${platformTriplet()}. Build it with ` +
      '`node scripts/buildNative.mjs` in the code-gauge package directory (requires a Rust ' +
      'toolchain); when installing with npm, also allow install scripts for code-gauge so its ' +
      `postinstall build can run.\n${failures.join('\n')}`
  );
  throw cachedFailure;
}

/**
 * The platform-package suffix in the napi-rs naming convention: Linux targets are qualified by
 * libc ABI (`linux-x64-gnu` / `linux-x64-musl`) because a glibc-linked addon cannot load on
 * Alpine/musl; other platforms have a single ABI. Must match scripts/installNative.mjs and the
 * build-native workflow's target list.
 */
function platformTriplet(): string {
  const base = `${process.platform}-${process.arch}`;
  if (process.platform !== 'linux') {
    return base;
  }
  // Musl builds of Node report no glibc runtime version; see napi-rs's isMusl detection.
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return report?.header?.glibcVersionRuntime ? `${base}-gnu` : `${base}-musl`;
}
