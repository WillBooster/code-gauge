//! The N-API binding loaded by Node.js (src/nativeMetrics.ts).

use napi::bindgen_prelude::*;
use napi_derive::napi;

#[napi]
pub fn payload_version() -> u32 {
    crate::payload_version()
}

#[napi]
pub fn measure_code_native(
    code: String,
    language: String,
    include_syntax_tree: Option<bool>,
    min_tokens: Option<u32>,
    max_gap_tokens: Option<u32>,
    min_similarity_percent: Option<u32>,
    include_cross_file_data: Option<bool>,
) -> Result<String> {
    crate::measure_code(
        &code,
        &language,
        include_syntax_tree.unwrap_or(false),
        min_tokens,
        max_gap_tokens,
        min_similarity_percent,
        include_cross_file_data.unwrap_or(false),
    )
    .map_err(Error::from_reason)
}

/// measure_code_native on the worker pool, resolving with the same JSON payload, so callers can
/// measure several files in parallel.
#[napi(ts_return_type = "Promise<string>")]
#[allow(clippy::too_many_arguments)]
pub fn measure_code_native_async(
    env: &Env,
    code: String,
    language: String,
    include_syntax_tree: Option<bool>,
    min_tokens: Option<u32>,
    max_gap_tokens: Option<u32>,
    min_similarity_percent: Option<u32>,
    include_cross_file_data: Option<bool>,
) -> Result<Object<'_>> {
    let (deferred, promise) = env.create_deferred()?;
    crate::worker_pool::spawn(move || {
        // A panic must reject the promise: otherwise it would stay pending and keep the event
        // loop alive forever.
        let result = std::panic::catch_unwind(|| {
            crate::measure_code(
                &code,
                &language,
                include_syntax_tree.unwrap_or(false),
                min_tokens,
                max_gap_tokens,
                min_similarity_percent,
                include_cross_file_data.unwrap_or(false),
            )
        })
        .unwrap_or_else(|_| Err("measurement panicked".to_string()));
        match result {
            Ok(json) => deferred.resolve(move |_| Ok(json)),
            Err(reason) => deferred.reject(Error::from_reason(reason)),
        }
    });
    Ok(promise)
}

#[napi]
pub fn collect_cross_file_data_native(
    code: String,
    language: String,
    min_tokens: Option<u32>,
) -> Result<String> {
    crate::collect_cross_file_data(&code, &language, min_tokens).map_err(Error::from_reason)
}

#[napi]
pub fn collect_function_token_sequences_native(code: String, language: String) -> Result<String> {
    crate::collect_function_token_sequences(&code, &language).map_err(Error::from_reason)
}
