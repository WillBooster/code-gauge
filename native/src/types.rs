use serde::Serialize;

/// Result payload of the native measurer. Mirrors CodeMetrics from src/types.ts, except that
/// Halstead's derived values are computed on the TypeScript side: they involve transcendental
/// functions (log/log2) whose last-bit results can differ between V8 and Rust's libm, and results
/// must not vary with the platform's libm build.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMetrics {
    pub language: String,
    pub bytes: usize,
    pub lines: LineMetrics,
    pub functions: Vec<FunctionMetrics>,
    pub cognitive_complexity: u64,
    pub max_cognitive_complexity: u64,
    pub nesting_depth: u64,
    pub ncss_count: u64,
    pub duplication: DuplicationMetrics,
    pub halstead_counts: HalsteadCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub syntax_tree: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineMetrics {
    pub total: usize,
    pub code: usize,
    pub comment: usize,
    pub blank: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionMetrics {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The tree-sitter node type of the function node (e.g. `method_declaration`, `arrow_function`).
    pub node_type: String,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub cognitive_complexity: u64,
    pub nesting_depth: u64,
    pub ncss: u64,
    pub parameter_count: usize,
    /// Base counts of the function's whole subtree; derived floats are computed in TypeScript.
    pub halstead_counts: HalsteadCounts,
    pub dep_degree: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateBlockOccurrence {
    pub end_line: usize,
    pub start_line: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicationMetrics {
    pub duplicate_block_count: usize,
    pub duplicate_block_group_count: usize,
    pub duplicate_block_groups: Vec<Vec<DuplicateBlockOccurrence>>,
    pub duplicate_line_count: usize,
    /// The 1-based lines behind duplicate_line_count, sorted ascending.
    pub duplicate_line_numbers: Vec<usize>,
    pub duplication_ratio: f64,
    pub max_duplicate_block_size: usize,
}

/// One file's contribution to cross-file clone detection. Mirrors CrossFileDuplicationFileData in
/// src/duplication.ts; `code_line_numbers` is revived into a Set on the TypeScript side.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossFileFileData {
    pub candidates: Vec<CrossFileCandidate>,
    pub tokens: Vec<CrossFileToken>,
    pub container_statements: Vec<Vec<CrossFileTokenRange>>,
    /// 1-based lines that are neither blank nor comment-only, sorted ascending.
    pub code_line_numbers: Vec<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossFileCandidate {
    pub fingerprint: String,
    pub token_count: usize,
    pub start_token_index: usize,
    pub end_token_index: usize,
    pub start_index: usize,
    pub end_index: usize,
    pub start_line: usize,
    pub end_line: usize,
}

/// A normalized token as consumed by the TypeScript project-level matcher (the Token interface in
/// src/duplication.ts). Optional fields are omitted rather than null: the TypeScript side
/// distinguishes absent from undefined-valued keys with `!== undefined` checks.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossFileToken {
    pub kind: &'static str,
    pub text: String,
    pub text_hash: i32,
    pub text_hash2: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal_hash: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub literal_hash2: Option<i32>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub is_name: bool,
    pub start_row: usize,
    pub end_row: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossFileTokenRange {
    pub start_token_index: usize,
    pub end_token_index: usize,
    pub start_index: usize,
    pub end_index: usize,
    pub start_line: usize,
    pub end_line: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HalsteadCounts {
    pub distinct_operators: usize,
    pub distinct_operands: usize,
    pub total_operators: u64,
    pub total_operands: u64,
}
