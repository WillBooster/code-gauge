// Cloudflare Workers bundlers (wrangler, @cloudflare/vite-plugin) import .wasm files as compiled modules.
declare module '*.wasm' {
  const module: WebAssembly.Module;
  export default module;
}
