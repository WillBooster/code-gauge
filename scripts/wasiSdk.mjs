// The wasi-sdk release that builds native/code-gauge.wasm, and the wasi-libc commit it links (the
// `wasi-libc:` line of the SDK's VERSION file), whose notices scripts/generateThirdPartyNotices.mjs
// attributes. scripts/buildWasm.mjs fails when a downloaded SDK reports a different commit, so the
// two cannot drift apart silently.
export const wasiSdkVersion = '34.0';
export const wasiLibcCommit = '2e6fb9d8ee0c';
