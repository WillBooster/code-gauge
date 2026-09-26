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

/// Allocates with an exact layout: `Vec::with_capacity` may over-allocate, so rebuilding a `Vec`
/// from the pointer and `len` would not be sound.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    if len == 0 {
        return std::ptr::NonNull::dangling().as_ptr();
    }
    let pointer = unsafe { std::alloc::alloc(byte_layout(len)) };
    if pointer.is_null() {
        std::alloc::handle_alloc_error(byte_layout(len));
    }
    pointer
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
    // Both buffers are taken before `?` so that neither leaks when the other is invalid.
    let code = take_string(code_ptr, code_len);
    let language = take_string(language_ptr, language_len);
    store_result((|| {
        crate::measure_code(
            &code?,
            &language?,
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
    let code = take_string(code_ptr, code_len);
    let language = take_string(language_ptr, language_len);
    store_result((|| {
        crate::collect_cross_file_data(&code?, &language?, to_option(min_tokens))
    })())
}

#[no_mangle]
pub unsafe extern "C" fn collect_function_token_sequences(
    code_ptr: *mut u8,
    code_len: usize,
    language_ptr: *mut u8,
    language_len: usize,
) -> u32 {
    let code = take_string(code_ptr, code_len);
    let language = take_string(language_ptr, language_len);
    store_result((|| {
        crate::collect_function_token_sequences(&code?, &language?)
    })())
}

/// Takes ownership of a buffer returned by `alloc(len)` and filled by the host.
unsafe fn take_string(ptr: *mut u8, len: usize) -> Result<String, String> {
    if len == 0 {
        return Ok(String::new());
    }
    let text = std::str::from_utf8(std::slice::from_raw_parts(ptr, len))
        .map(str::to_owned)
        .map_err(|error| error.to_string());
    std::alloc::dealloc(ptr, byte_layout(len));
    text
}

fn byte_layout(len: usize) -> std::alloc::Layout {
    std::alloc::Layout::array::<u8>(len).expect("buffer size overflows isize")
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
