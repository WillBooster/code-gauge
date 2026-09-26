// The entry point for Cloudflare Workers (the `workerd` export condition), which cannot load N-API
// addons: the same API runs on the WebAssembly build of the native addon.
import wasmModule from '../native/code-gauge.wasm';
import { setNativeBinding } from './nativeMetrics.js';
import { createWasmBinding } from './wasmBinding.js';

setNativeBinding(createWasmBinding(wasmModule));

export * from './index.js';
