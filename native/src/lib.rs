#![deny(clippy::all)]

use crate::duplication::DuplicationSettings;

mod complexity;
mod dep_degree;
mod duplication;
mod functions;
mod languages;
mod measure;
#[cfg(not(target_family = "wasm"))]
mod napi;
mod ncss;
mod near_miss;
mod types;
mod util;
#[cfg(target_family = "wasm")]
mod wasm;

/// Version of the native payload schema. The TypeScript wrapper refuses a binding whose version
/// differs from the one it expects, so a stale prebuilt addon fails with a clear rebuild message
/// instead of silently returning an incompatible payload. Bump on every payload-shape change,
/// together with `expectedPayloadVersion` in src/nativeMetrics.ts.
/// scripts/installNative.mjs parses the literal from this function's source.
pub fn payload_version() -> u32 {
    7
}

/// Measures code metrics for the given source, returning the NativeMetrics payload as JSON; with
/// `include_cross_file_data`, the payload also carries the file's cross-file clone-detection
/// contribution from the same parse.
/// The TypeScript wrapper derives the remaining float metrics (Halstead volume/effort/...): they
/// involve transcendental functions whose last-bit results can differ between V8 and Rust's libm,
/// and results must not depend on which side computes them.
fn measure_code(
    code: &str,
    language: &str,
    include_syntax_tree: bool,
    min_tokens: Option<u32>,
    max_gap_tokens: Option<u32>,
    min_similarity_percent: Option<u32>,
    include_cross_file_data: bool,
) -> Result<String, String> {
    let definition = find_language(language)?;
    let settings = to_duplication_settings(min_tokens, max_gap_tokens, min_similarity_percent);
    let metrics = measure::measure(
        code,
        definition,
        include_syntax_tree,
        include_cross_file_data,
        &settings,
    )?;
    serde_json::to_string(&metrics).map_err(|error| error.to_string())
}

/// Collects one file's cross-file clone-detection contribution (candidates, normalized token
/// stream, statement structure, and code line numbers) as JSON; see CrossFileFileData.
fn collect_cross_file_data(
    code: &str,
    language: &str,
    min_tokens: Option<u32>,
) -> Result<String, String> {
    let definition = find_language(language)?;
    let min_tokens = min_tokens
        .map(|value| value as usize)
        .unwrap_or(DuplicationSettings::default().min_tokens);
    let data = measure::collect_cross_file_data(code, definition, min_tokens)?;
    serde_json::to_string(&data).map_err(|error| error.to_string())
}

/// Collects normalized token hash sequences of every function as JSON (number[][]),
/// index-parallel to the functions array of measure_code.
fn collect_function_token_sequences(code: &str, language: &str) -> Result<String, String> {
    let definition = find_language(language)?;
    let sequences = measure::collect_function_token_sequences(code, definition)?;
    serde_json::to_string(&sequences).map_err(|error| error.to_string())
}

fn find_language(language: &str) -> Result<&'static languages::LanguageDefinition, String> {
    languages::find_language(language).ok_or_else(|| format!("Unsupported language: {language}"))
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
