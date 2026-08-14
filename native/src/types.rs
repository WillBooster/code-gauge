use serde::Serialize;

/// Result payload of the native measurer. Mirrors CodeMetrics from src/types.ts, except that
/// Halstead's derived values are computed on the TypeScript side: they involve transcendental
/// functions (log/log2) whose last-bit results can differ between V8 and Rust's libm, and
/// bit-exact parity with the TypeScript backend is a hard requirement.
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
    pub duplication_ratio: f64,
    pub max_duplicate_block_size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HalsteadCounts {
    pub distinct_operators: usize,
    pub distinct_operands: usize,
    pub total_operators: u64,
    pub total_operands: u64,
}
