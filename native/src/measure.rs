use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tree_sitter::Node;

use crate::complexity::{
    is_lambda_body_block, measure_complexity, measure_function_body_metrics, LanguageSets,
};
use crate::dep_degree::measure_dep_degree;
use crate::duplication::measure_duplication;
use crate::functions::{
    collect_nodes, count_parameters, find_function_name, is_implemented_function,
};
use crate::languages::LanguageDefinition;
use crate::types::{FunctionMetrics, HalsteadCounts, LineMetrics, NativeMetrics};
use crate::util::{all_children, is_js_whitespace, named_children, node_text, split_lines, Source};

pub fn measure(
    code: &str,
    language: &LanguageDefinition,
    include_syntax_tree: bool,
) -> Result<NativeMetrics, String> {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&language.grammar())
        .map_err(|error| error.to_string())?;
    let source = Source::new(code);
    // Parsed as UTF-16 to match node-tree-sitter exactly: tree-sitter's error recovery differs
    // between input encodings for malformed non-ASCII source.
    let tree = parser
        .parse_utf16(source.to_utf16(), None)
        .ok_or_else(|| "parse failed".to_string())?;
    let root = tree.root_node();
    // The metric passes recurse per tree level and overflow the native stack (a process-killing
    // SIGSEGV, not a catchable error) around depth ~20k; refusing far below that makes the caller
    // fall back to the TypeScript backend, which raises a catchable RangeError for such input.
    if tree_depth(root) > MAX_TREE_DEPTH {
        return Err(format!("tree depth exceeds {MAX_TREE_DEPTH}"));
    }
    let code = &source;
    let sets = LanguageSets::new(language);

    let functions: Vec<Node<'_>> = collect_nodes(root, &sets.function_nodes)
        .into_iter()
        .filter(|node| !is_lambda_body_block(*node) && is_implemented_function(*node))
        .collect();

    let body_metrics_by_node_id = measure_function_body_metrics(root, &sets, code);
    let function_metrics: Vec<FunctionMetrics> = functions
        .iter()
        .map(|node| {
            let body_metrics = body_metrics_by_node_id
                .get(&node.id())
                .expect("every collected function node opens a frame in the body-metrics pass");
            FunctionMetrics {
                name: find_function_name(*node, code),
                node_type: node.kind().to_string(),
                start_line: node.start_position().row + 1,
                // The tree is parsed from UTF-16, so columns are UTF-16 code units x 2 — halving
                // yields the code-unit column node-tree-sitter reports.
                start_column: node.start_position().column / 2,
                end_line: node.end_position().row + 1,
                // Sonar's written spec adds +1 cognitive complexity per function in a recursion
                // cycle, but this is intentionally not implemented (issue #22): mainstream
                // implementations (PMD, SonarQube analyzers) omit it.
                cognitive_complexity: body_metrics.cognitive_complexity,
                nesting_depth: body_metrics.nesting_depth,
                ncss: body_metrics.ncss,
                parameter_count: count_parameters(*node, code),
                halstead_counts: measure_halstead(*node, code),
                dep_degree: measure_dep_degree(*node, code),
            }
        })
        .collect();

    let global_complexity = measure_complexity(root, &sets, code);
    let (lines, code_line_numbers) = classify_lines(code, root);
    let halstead_counts = measure_halstead(root, code);

    Ok(NativeMetrics {
        language: language.name.to_string(),
        bytes: code.code.len(),
        lines,
        cognitive_complexity: global_complexity.cognitive_complexity,
        max_cognitive_complexity: function_metrics
            .iter()
            .map(|function| function.cognitive_complexity)
            .max()
            .unwrap_or(0),
        nesting_depth: global_complexity.nesting_depth,
        ncss_count: crate::ncss::count_ncss(root, &sets.ncss_nodes, &sets.ncss_containers),
        duplication: measure_duplication(root, &code_line_numbers, code),
        halstead_counts,
        functions: function_metrics,
        syntax_tree: if include_syntax_tree {
            Some(root.to_sexp())
        } else {
            None
        },
    })
}

/// See the depth check in measure(); computed iteratively so the check itself cannot overflow.
const MAX_TREE_DEPTH: usize = 5_000;

fn tree_depth(root: Node<'_>) -> usize {
    let mut cursor = root.walk();
    let mut depth = 0;
    let mut max_depth = 0;
    loop {
        if cursor.goto_first_child() {
            depth += 1;
            max_depth = max_depth.max(depth);
            continue;
        }
        loop {
            if cursor.goto_next_sibling() {
                break;
            }
            if !cursor.goto_parent() {
                return max_depth;
            }
            depth -= 1;
        }
    }
}

struct CommentSpan {
    line: usize,
    start_column: usize,
    end_column: usize,
}

/// 1-based numbers of lines that are neither blank nor comment-only, matching classifyLines in
/// metrics.ts so duplication line coverage and its code-line denominator agree.
fn classify_lines(code: &Source<'_>, root: Node<'_>) -> (LineMetrics, HashSet<usize>) {
    let source_lines = split_lines(code.code);
    // Spans are bucketed by line so classification stays linear.
    let mut comment_spans_by_line: HashMap<usize, Vec<CommentSpan>> = HashMap::new();
    for span in collect_comment_spans(root) {
        comment_spans_by_line
            .entry(span.line)
            .or_default()
            .push(span);
    }
    let mut blank = 0;
    let mut comment = 0;
    let mut code_line_numbers = HashSet::new();

    for (index, line) in source_lines.iter().enumerate() {
        if line.chars().all(is_js_whitespace) {
            blank += 1;
            continue;
        }
        let empty_spans = Vec::new();
        let relevant_spans = comment_spans_by_line.get(&index).unwrap_or(&empty_spans);
        if is_comment_only_line(line, relevant_spans) {
            comment += 1;
        } else {
            code_line_numbers.insert(index + 1);
        }
    }

    (
        LineMetrics {
            total: source_lines.len(),
            code: code_line_numbers.len(),
            comment,
            blank,
        },
        code_line_numbers,
    )
}

fn collect_comment_spans(root: Node<'_>) -> Vec<CommentSpan> {
    let mut spans = Vec::new();

    fn visit(node: Node<'_>, spans: &mut Vec<CommentSpan>) {
        if matches!(node.kind(), "comment" | "line_comment" | "block_comment") {
            for row in node.start_position().row..=node.end_position().row {
                // Node columns are UTF-16 code units x 2 (the tree is parsed from UTF-16);
                // halving matches the code-unit columns the line scan below counts.
                spans.push(CommentSpan {
                    line: row,
                    start_column: if row == node.start_position().row {
                        node.start_position().column / 2
                    } else {
                        0
                    },
                    end_column: if row == node.end_position().row {
                        node.end_position().column / 2
                    } else {
                        usize::MAX
                    },
                });
            }
        }

        for child in named_children(node) {
            visit(child, spans);
        }
    }

    visit(root, &mut spans);
    spans
}

fn is_comment_only_line(line: &str, relevant_spans: &[CommentSpan]) -> bool {
    if relevant_spans.is_empty() {
        return false;
    }

    // A line may hold several comments (`/* one */ /* two */`), so every non-whitespace column must
    // be covered by the UNION of spans, not by a single span. Columns are UTF-16 code units,
    // matching the span columns derived from the UTF-16 parse.
    let mut column = 0;
    for character in line.chars() {
        if !is_js_whitespace(character)
            && !relevant_spans
                .iter()
                .any(|span| span.start_column <= column && column < span.end_column)
        {
            return false;
        }
        column += character.len_utf16();
    }
    true
}

const OPERATOR_TEXTS: &[&str] = &[
    "+",
    "-",
    "*",
    "/",
    "%",
    "**",
    "=",
    "+=",
    "-=",
    "*=",
    "/=",
    "%=",
    "==",
    "!=",
    "===",
    "!==",
    "<",
    "<=",
    ">",
    ">=",
    "!",
    "~",
    "&",
    "|",
    "^",
    "++",
    "--",
    "<<",
    ">>",
    ">>>",
    "=>",
    "**=",
    "<<=",
    ">>=",
    ">>>=",
    "&=",
    "|=",
    "^=",
    "&&=",
    "||=",
    "??=",
    "??",
    "?.",
    "?",
    "//",
    "//=",
    "@",
    "@=",
    ":=",
    "<-",
    "<=>",
    "=~",
    "..",
    "...",
    "..=",
    "&&",
    "||",
    "!~",
    "&^",
    "&^=",
    "&.",
    // Member access/qualification are classical Halstead operators; `->` also captures
    // Python/Rust return-type arrows, consistent with the counted `=>`.
    ".",
    "->",
    "::",
    "->*",
    ".*",
    "sizeof",
    "alignof",
    "defined?",
    "as",
    // C++ alternative operator tokens parse as anonymous leaves like their symbolic forms.
    "bitand",
    "bitor",
    "xor",
    "compl",
    "and_eq",
    "or_eq",
    "xor_eq",
    "not_eq",
    "and",
    "or",
    "not",
    "in",
    "is",
    "instanceof",
    "typeof",
    "new",
    "delete",
    "return",
    "throw",
    "raise",
    "yield",
    "await",
    "co_await",
    "co_yield",
    "co_return",
    "break",
    "continue",
];

const OPERAND_NODE_TYPES: &[&str] = &[
    "identifier",
    "property_identifier",
    "field_identifier",
    "type_identifier",
    "constant",
    "instance_variable",
    "class_variable",
    "global_variable",
    "simple_symbol",
    "self",
    "this",
    "super",
    // C/C++/Rust built-in types are leaves of their own node type, unlike Go's `type_identifier`.
    "primitive_type",
    "boolean_type",
    "void_type",
    "auto",
    "number",
    "integer",
    "float",
    "integer_literal",
    "float_literal",
    "int_literal",
    "rune_literal",
    "imaginary_literal",
    "number_literal",
    "decimal_integer_literal",
    "hex_integer_literal",
    "octal_integer_literal",
    "binary_integer_literal",
    "decimal_floating_point_literal",
    "hex_floating_point_literal",
    "string",
    "string_literal",
    // Go raw strings are leaves with no content child, unlike Rust/C++ `raw_string_literal`s.
    "raw_string_literal",
    "string_fragment",
    "multiline_string_fragment",
    "string_content",
    "raw_string_content",
    "template_string",
    "character_literal",
    "char_literal",
    "character",
    "true",
    "false",
    "null",
    "null_literal",
    "undefined",
    "nil",
    "none",
];

/// Non-leaf literals counted as one Halstead operand without descending; see metrics.ts.
const ATOMIC_OPERAND_NODE_TYPES: &[&str] = &[
    "interpreted_string_literal",
    "regex",
    "user_defined_literal",
    "integral_type",
    "floating_point_type",
    "sized_type_specifier",
    "placeholder_type_specifier",
];

fn operator_texts() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| OPERATOR_TEXTS.iter().copied().collect())
}

fn operand_node_types() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| OPERAND_NODE_TYPES.iter().copied().collect())
}

fn atomic_operand_node_types() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| ATOMIC_OPERAND_NODE_TYPES.iter().copied().collect())
}

fn measure_halstead(root: Node<'_>, code: &Source<'_>) -> HalsteadCounts {
    let mut operators: HashMap<String, u64> = HashMap::new();
    let mut operands: HashMap<String, u64> = HashMap::new();

    fn visit(
        node: Node<'_>,
        code: &Source<'_>,
        operators: &mut HashMap<String, u64>,
        operands: &mut HashMap<String, u64>,
    ) {
        if matches!(node.kind(), "comment" | "line_comment" | "block_comment") {
            return;
        }

        if atomic_operand_node_types().contains(node.kind()) {
            *operands
                .entry(node_text(node, code).to_string())
                .or_insert(0) += 1;
            return;
        }

        // Operators are counted from leaf tokens only: keyword-named nodes always contain a
        // same-text anonymous keyword leaf, so counting the named node as well would double-count.
        if node.child_count() == 0 {
            let text = node_text(node, code);
            // Operands win over text matches so identifiers spelled like word operators stay operands.
            if operand_node_types().contains(node.kind()) {
                *operands.entry(text.to_string()).or_insert(0) += 1;
            } else if (operator_texts().contains(text) || operator_texts().contains(node.kind()))
                && is_countable_contextual_token(node, text)
            {
                let key = if text.is_empty() { node.kind() } else { text };
                *operators.entry(key.to_string()).or_insert(0) += 1;
            }
            return;
        }

        for child in all_children(node) {
            visit(child, code, operators, operands);
        }
    }

    visit(root, code, &mut operators, &mut operands);

    HalsteadCounts {
        distinct_operators: operators.len(),
        distinct_operands: operands.len(),
        total_operators: operators.values().sum(),
        total_operands: operands.values().sum(),
    }
}

/// Ternary/conditional and Rust try parents make `?` an operator; TS optional markers do not.
const QUESTION_OPERATOR_PARENT_TYPES: &[&str] = &[
    "ternary_expression",
    "conditional_expression",
    "conditional",
    "try_expression",
    // TypeScript conditional types (`T extends U ? X : Y`) select like a ternary.
    "conditional_type",
];

fn is_countable_contextual_token(node: Node<'_>, text: &str) -> bool {
    if text == "@" {
        // Python matrix multiplication only; decorator/annotation `@` marks are not operators.
        let parent_type = node.parent().map(|parent| parent.kind());
        return parent_type == Some("binary_operator")
            || parent_type == Some("augmented_assignment");
    }
    if text != "?" {
        return true;
    }
    node.parent()
        .is_some_and(|parent| QUESTION_OPERATOR_PARENT_TYPES.contains(&parent.kind()))
}
