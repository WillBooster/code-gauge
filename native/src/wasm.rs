//! The WebAssembly binding for runtimes without N-API, such as Cloudflare Workers
//! (src/wasmBinding.ts). Strings cross linear memory as UTF-8: the host copies each input into a
//! buffer from `alloc`, whose ownership passes to the called function, and reads the JSON result
//! (status 0) or error message (status 1) through `result_ptr`/`result_len` before the next call.

use std::cell::RefCell;

thread_local! {
    static RESULT: RefCell<String> = const { RefCell::new(String::new()) };
}

#[no_mangle]
pub extern "C" fn payload_version() -> u32 {
    crate::payload_version()
}

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buffer = std::mem::ManuallyDrop::new(Vec::<u8>::with_capacity(len));
    buffer.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    RESULT.with_borrow(|result| result.as_ptr())
}

#[no_mangle]
pub extern "C" fn result_len() -> usize {
    RESULT.with_borrow(|result| result.len())
}

/// Optional settings arrive as f64 (exact for every u32) with a negative value for "absent", so
/// the host needs no BigInt or presence flags.
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn measure_code(
    code_ptr: *mut u8,
    code_len: usize,
    language_ptr: *mut u8,
    language_len: usize,
    include_syntax_tree: u32,
    min_tokens: f64,
    max_gap_tokens: f64,
    min_similarity_percent: f64,
    include_cross_file_data: u32,
) -> u32 {
    store_result((|| {
        crate::measure_code(
            &take_string(code_ptr, code_len)?,
            &take_string(language_ptr, language_len)?,
            include_syntax_tree != 0,
            to_option(min_tokens),
            to_option(max_gap_tokens),
            to_option(min_similarity_percent),
            include_cross_file_data != 0,
        )
    })())
}

#[no_mangle]
pub unsafe extern "C" fn collect_cross_file_data(
    code_ptr: *mut u8,
    code_len: usize,
    language_ptr: *mut u8,
    language_len: usize,
    min_tokens: f64,
) -> u32 {
    store_result((|| {
        crate::collect_cross_file_data(
            &take_string(code_ptr, code_len)?,
            &take_string(language_ptr, language_len)?,
            to_option(min_tokens),
        )
    })())
}

#[no_mangle]
pub unsafe extern "C" fn collect_function_token_sequences(
    code_ptr: *mut u8,
    code_len: usize,
    language_ptr: *mut u8,
    language_len: usize,
) -> u32 {
    store_result((|| {
        crate::collect_function_token_sequences(
            &take_string(code_ptr, code_len)?,
            &take_string(language_ptr, language_len)?,
        )
    })())
}

/// Takes ownership of a buffer returned by `alloc(len)` and filled by the host.
unsafe fn take_string(ptr: *mut u8, len: usize) -> Result<String, String> {
    String::from_utf8(Vec::from_raw_parts(ptr, len, len)).map_err(|error| error.to_string())
}

fn to_option(value: f64) -> Option<u32> {
    (value >= 0.0).then_some(value as u32)
}

fn store_result(result: Result<String, String>) -> u32 {
    let (status, text) = match result {
        Ok(json) => (0, json),
        Err(message) => (1, message),
    };
    RESULT.set(text);
    status
}
