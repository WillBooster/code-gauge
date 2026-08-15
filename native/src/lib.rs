#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::duplication::DuplicationSettings;

mod complexity;
mod dep_degree;
mod duplication;
mod functions;
mod languages;
mod measure;
mod ncss;
mod types;
mod util;

/// Version of the native payload schema. The TypeScript wrapper refuses a binding whose version
/// differs from the one it expects, so a stale prebuilt addon fails with a clear rebuild message
/// instead of silently returning an incompatible payload. Bump on every payload-shape change,
/// together with `expectedPayloadVersion` in src/nativeMetrics.ts.
#[napi]
pub fn payload_version() -> u32 {
    4
}

/// Measures code metrics for the given source, returning the NativeMetrics payload as JSON.
/// The TypeScript wrapper derives the remaining float metrics (Halstead volume/effort/...): they
/// involve transcendental functions whose last-bit results can differ between V8 and Rust's libm,
/// and results must not depend on which side computes them.
#[napi]
pub fn measure_code_native(
    code: String,
    language: String,
    include_syntax_tree: Option<bool>,
    min_tokens: Option<u32>,
    max_gap_tokens: Option<u32>,
    min_similarity_percent: Option<u32>,
) -> Result<String> {
    let definition = find_language(&language)?;
    let settings = to_duplication_settings(min_tokens, max_gap_tokens, min_similarity_percent);
    let metrics = measure::measure(
        &code,
        definition,
        include_syntax_tree.unwrap_or(false),
        &settings,
    )
    .map_err(Error::from_reason)?;
    serde_json::to_string(&metrics).map_err(|error| Error::from_reason(error.to_string()))
}

/// Collects one file's cross-file clone-detection contribution (candidates, normalized token
/// stream, statement structure, and code line numbers) as JSON; see CrossFileFileData.
#[napi]
pub fn collect_cross_file_data_native(
    code: String,
    language: String,
    min_tokens: Option<u32>,
) -> Result<String> {
    let definition = find_language(&language)?;
    let min_tokens = min_tokens
        .map(|value| value as usize)
        .unwrap_or(DuplicationSettings::default().min_tokens);
    let data = measure::collect_cross_file_data(&code, definition, min_tokens)
        .map_err(Error::from_reason)?;
    serde_json::to_string(&data).map_err(|error| Error::from_reason(error.to_string()))
}

/// Collects normalized token hash sequences of every function as JSON (number[][]),
/// index-parallel to the functions array of measure_code_native.
#[napi]
pub fn collect_function_token_sequences_native(code: String, language: String) -> Result<String> {
    let definition = find_language(&language)?;
    let sequences =
        measure::collect_function_token_sequences(&code, definition).map_err(Error::from_reason)?;
    serde_json::to_string(&sequences).map_err(|error| Error::from_reason(error.to_string()))
}

fn find_language(language: &str) -> Result<&'static languages::LanguageDefinition> {
    languages::find_language(language)
        .ok_or_else(|| Error::from_reason(format!("Unsupported language: {language}")))
}

fn to_duplication_settings(
    min_tokens: Option<u32>,
    max_gap_tokens: Option<u32>,
    min_similarity_percent: Option<u32>,
) -> DuplicationSettings {
    let defaults = DuplicationSettings::default();
    DuplicationSettings {
        min_tokens: min_tokens
            .map(|value| value as usize)
            .unwrap_or(defaults.min_tokens),
        max_gap_tokens: max_gap_tokens
            .map(|value| value as usize)
            .unwrap_or(defaults.max_gap_tokens),
        min_similarity_percent: min_similarity_percent
            .map(|value| value as usize)
            .unwrap_or(defaults.min_similarity_percent),
    }
}
