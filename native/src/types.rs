use serde::Serialize;

/// Result payload of the native measurer. Mirrors CodeMetrics from src/types.ts, except that
/// Halstead's derived values and the maintainability index are computed on the TypeScript side:
/// they involve transcendental functions (log/log2) whose last-bit results can differ between
/// V8 and Rust's libm, and bit-exact parity with the TypeScript backend is a hard requirement.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeMetrics {
    pub language: String,
    pub bytes: usize,
    pub lines: LineMetrics,
    pub functions: Vec<FunctionMetrics>,
    pub class_count: usize,
    pub function_count: usize,
    pub cyclomatic_complexity: u64,
    pub max_cyclomatic_complexity: u64,
    pub cognitive_complexity: u64,
    pub max_cognitive_complexity: u64,
    pub nesting_depth: u64,
    pub ncss_count: u64,
    pub call_graph: CallGraphMetrics,
    pub coupling: CouplingMetrics,
    pub module: ModuleMetrics,
    pub cohesion: CohesionMetrics,
    pub syntax_features: SyntaxFeatureMetrics,
    pub type_complexity: TypeComplexityMetrics,
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
    pub returns_jsx: bool,
    pub cyclomatic_complexity: u64,
    pub cognitive_complexity: u64,
    pub nesting_depth: u64,
    pub ncss: u64,
    pub call_count: u64,
    pub unique_callee_count: usize,
    pub fan_in: usize,
    pub fan_out: usize,
    pub parameter_count: usize,
    pub recursive: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallGraphMetrics {
    pub call_count: u64,
    pub unique_callee_count: usize,
    pub internal_call_count: usize,
    pub internal_edge_count: usize,
    pub recursive_function_count: usize,
    pub max_fan_in: usize,
    pub max_fan_out: usize,
    pub max_call_depth: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouplingMetrics {
    pub import_count: u64,
    pub import_source_count: usize,
    pub relative_import_count: usize,
    pub external_import_count: usize,
    pub export_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclarationMetrics {
    pub exported: bool,
    pub name: String,
    pub start_line: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleMetrics {
    pub declarations: Vec<DeclarationMetrics>,
    pub import_sources: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CohesionMetrics {
    pub average_function_identifier_overlap: f64,
    pub shared_identifier_count: usize,
    pub unique_identifier_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyntaxFeatureMetrics {
    pub assignment_count: u64,
    pub await_expression_count: u64,
    pub loop_statement_count: u64,
    pub mutable_binding_count: u64,
    pub return_statement_count: u64,
    pub throw_statement_count: u64,
    pub try_statement_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeComplexityMetrics {
    pub type_annotation_count: u64,
    pub type_alias_count: u64,
    pub interface_count: u64,
    pub generic_parameter_count: u64,
    pub union_type_count: u64,
    pub intersection_type_count: u64,
    pub conditional_type_count: u64,
    pub type_assertion_count: u64,
    pub non_null_assertion_count: u64,
    pub satisfies_expression_count: u64,
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
