#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

mod complexity;
mod duplication;
mod functions;
mod languages;
mod measure;
mod ncss;
mod types;
mod util;

/// Version of the NativeMetrics payload schema. The TypeScript wrapper refuses a binding whose
/// version differs from the one it expects, so a stale prebuilt addon falls back to the
/// TypeScript backend instead of silently returning an incompatible payload. Bump on every
/// payload-shape change, together with `expectedPayloadVersion` in src/nativeMetrics.ts.
#[napi]
pub fn payload_version() -> u32 {
    2
}

/// Measures code metrics for the given source, returning the NativeMetrics payload as JSON.
/// The TypeScript wrapper derives the remaining float metrics (Halstead volume/effort/...) so
/// results are bit-identical to the TypeScript backend.
#[napi]
pub fn measure_code_native(
    code: String,
    language: String,
    include_syntax_tree: Option<bool>,
) -> Result<String> {
    let definition = languages::find_language(&language)
        .ok_or_else(|| Error::from_reason(format!("Unsupported language: {language}")))?;
    let metrics = measure::measure(&code, definition, include_syntax_tree.unwrap_or(false))
        .map_err(Error::from_reason)?;
    serde_json::to_string(&metrics).map_err(|error| Error::from_reason(error.to_string()))
}

/// Parses the code and returns the S-expression of the syntax tree, for cross-backend parity checks.
#[napi]
pub fn parse_sexp(code: String, language: String) -> Result<String> {
    let definition = languages::find_language(&language)
        .ok_or_else(|| Error::from_reason(format!("Unsupported language: {language}")))?;
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&definition.grammar())
        .map_err(|error| Error::from_reason(error.to_string()))?;
    // UTF-16, like measure(): node-tree-sitter parses JavaScript strings as UTF-16 and tree-sitter
    // error recovery differs between encodings for malformed non-ASCII source.
    let utf16: Vec<u16> = code.encode_utf16().collect();
    let tree = parser
        .parse_utf16(&utf16, None)
        .ok_or_else(|| Error::from_reason("parse failed".to_string()))?;
    Ok(tree.root_node().to_sexp())
}
