import { expectedPayloadVersion, NativeAddonError, type NativeBinding } from './nativeMetrics.js';

/** The C ABI exported by native/src/wasm.rs. */
interface WasmExports {
  memory: WebAssembly.Memory;
  payload_version(): number;
  alloc(length: number): number;
  result_ptr(): number;
  result_len(): number;
  measure_code(
    codePtr: number,
    codeLength: number,
    languagePtr: number,
    languageLength: number,
    includeSyntaxTree: number,
    minTokens: number,
    maxGapTokens: number,
    minSimilarityPercent: number,
    includeCrossFileData: number
  ): number;
  collect_cross_file_data(
    codePtr: number,
    codeLength: number,
    languagePtr: number,
    languageLength: number,
    minTokens: number
  ): number;
  collect_function_token_sequences(
    codePtr: number,
    codeLength: number,
    languagePtr: number,
    languageLength: number
  ): number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Wraps the WebAssembly build of the native addon (native/src/wasm.rs) as a NativeBinding. The
 * module is instantiated synchronously on first use and again after a trap (a panic or stack
 * overflow), because a trap leaves the instance's memory and stack pointer in an undefined state.
 * An instantiation failure (e.g., a payload version mismatch) is memoized like the N-API loader's,
 * since instantiating the same module again would fail again.
 */
export function createWasmBinding(module: WebAssembly.Module): NativeBinding {
  let instance: { exports: WasmExports; stderr: string[] } | undefined;
  let instantiationFailure: unknown;

  const call = (invoke: (exports: WasmExports) => number): string => {
    if (!instance) {
      if (instantiationFailure) {
        throw instantiationFailure;
      }
      try {
        instance = instantiate(module);
      } catch (error) {
        instantiationFailure = error;
        throw error;
      }
    }
    const { exports, stderr } = instance;
    stderr.length = 0;
    let status: number;
    try {
      status = invoke(exports);
    } catch (error) {
      instance = undefined;
      throw new Error(`The code-gauge WebAssembly module crashed: ${stderr.join('').trim() || String(error)}`, {
        cause: error,
      });
    }
    const result = decoder.decode(new Uint8Array(exports.memory.buffer, exports.result_ptr(), exports.result_len()));
    if (status !== 0) {
      throw new Error(result);
    }
    return result;
  };

  return {
    measureCodeNative: (
      code,
      language,
      includeSyntaxTree,
      minTokens,
      maxGapTokens,
      minSimilarityPercent,
      includeCrossFileData
    ) =>
      call((exports) =>
        exports.measure_code(
          ...passString(exports, code),
          ...passString(exports, language),
          Number(includeSyntaxTree),
          toOptionalU32(minTokens),
          toOptionalU32(maxGapTokens),
          toOptionalU32(minSimilarityPercent),
          Number(includeCrossFileData ?? false)
        )
      ),
    collectCrossFileDataNative: (code, language, minTokens) =>
      call((exports) =>
        exports.collect_cross_file_data(
          ...passString(exports, code),
          ...passString(exports, language),
          toOptionalU32(minTokens)
        )
      ),
    collectFunctionTokenSequencesNative: (code, language) =>
      call((exports) =>
        exports.collect_function_token_sequences(...passString(exports, code), ...passString(exports, language))
      ),
  };
}

function instantiate(module: WebAssembly.Module): { exports: WasmExports; stderr: string[] } {
  const stderr: string[] = [];
  let memory: WebAssembly.Memory | undefined;
  const instance = new WebAssembly.Instance(module, {
    wasi_snapshot_preview1: createWasiImports(() => memory as WebAssembly.Memory, stderr),
  });
  const exports = instance.exports as unknown as WasmExports;
  memory = exports.memory;
  const version = exports.payload_version();
  if (version !== expectedPayloadVersion) {
    throw new NativeAddonError(
      `The code-gauge WebAssembly module has payload version ${version}, but ${expectedPayloadVersion} is ` +
        'expected; rebuild it with `bun run build-wasm`'
    );
  }
  return { exports, stderr };
}

/** Copies a string into a buffer whose ownership passes to the called export. */
function passString(exports: WasmExports, text: string): [number, number] {
  // TextEncoder replaces lone surrogates with U+FFFD, like toWellFormed() does for the N-API addon.
  const bytes = encoder.encode(text);
  const pointer = exports.alloc(bytes.length);
  new Uint8Array(exports.memory.buffer, pointer, bytes.length).set(bytes);
  return [pointer, bytes.length];
}

/** native/src/wasm.rs reads a negative value as an absent setting. */
function toOptionalU32(value: number | undefined): number {
  return value ?? -1;
}

const WASI_ERRNO_SUCCESS = 0;
const WASI_ERRNO_BADF = 8;
// crypto.getRandomValues() rejects requests larger than this.
const MAX_RANDOM_BYTES = 65_536;

/**
 * The WASI preview 1 functions the module imports. The metrics code performs no I/O, so file
 * descriptors are unavailable except for writes, whose stderr output (e.g., a panic message) is
 * kept for the error raised when the module traps.
 */
function createWasiImports(
  getMemory: () => WebAssembly.Memory,
  stderr: string[]
): Record<string, (...args: never[]) => number> {
  const view = (): DataView => new DataView(getMemory().buffer);
  const unavailable = (): number => WASI_ERRNO_BADF;
  return {
    environ_get: () => WASI_ERRNO_SUCCESS,
    environ_sizes_get: (countPointer: number, sizePointer: number) => {
      view().setUint32(countPointer, 0, true);
      view().setUint32(sizePointer, 0, true);
      return WASI_ERRNO_SUCCESS;
    },
    clock_time_get: (_clockId: number, _precision: bigint, timePointer: number) => {
      view().setBigUint64(timePointer, BigInt(Date.now()) * 1_000_000n, true);
      return WASI_ERRNO_SUCCESS;
    },
    random_get: (pointer: number, length: number) => {
      for (let offset = 0; offset < length; offset += MAX_RANDOM_BYTES) {
        crypto.getRandomValues(
          new Uint8Array(getMemory().buffer, pointer + offset, Math.min(MAX_RANDOM_BYTES, length - offset))
        );
      }
      return WASI_ERRNO_SUCCESS;
    },
    fd_write: (fd: number, iovsPointer: number, iovsLength: number, writtenPointer: number) => {
      const memoryView = view();
      let written = 0;
      for (let index = 0; index < iovsLength; index++) {
        const pointer = memoryView.getUint32(iovsPointer + index * 8, true);
        const length = memoryView.getUint32(iovsPointer + index * 8 + 4, true);
        if (fd === 2) {
          stderr.push(decoder.decode(new Uint8Array(getMemory().buffer, pointer, length)));
        }
        written += length;
      }
      memoryView.setUint32(writtenPointer, written, true);
      return WASI_ERRNO_SUCCESS;
    },
    fd_close: unavailable,
    fd_fdstat_get: unavailable,
    fd_fdstat_set_flags: unavailable,
    fd_read: unavailable,
    fd_seek: unavailable,
    proc_exit: (code: number) => {
      throw new Error(`The code-gauge WebAssembly module exited with code ${code}`);
    },
  };
}
