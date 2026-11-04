use rustc_hash::{FxHashMap, FxHashSet};
use std::sync::OnceLock;
use tree_sitter::Node;

use crate::complexity::{is_lambda_body_block, measure_function_body_metrics, LanguageSets};
use crate::dep_degree::measure_dep_degrees;
use crate::duplication::{
    collect_cross_file_file_data, hash_text, measure_duplication, tokenize, DuplicationSettings,
    TokenizedSource,
};
use crate::functions::{
    collect_nodes, count_parameters, find_function_name, is_implemented_function,
};
use crate::languages::LanguageDefinition;
use crate::tree_index::{KindSet, NodeExt, TreeIndex};
use crate::types::{
    CrossFileFileData, FunctionMetrics, HalsteadCounts, LineMetrics, NativeMetrics,
};
use crate::util::{
    all_children, is_js_whitespace, is_token, named_children, node_text, split_lines, Source,
};

// code-gauge-allow functionNcss 32 -- assembles the file's metrics from every pass in one place
pub fn measure(
    code: &str,
    language: &LanguageDefinition,
    include_syntax_tree: bool,
    include_cross_file_data: bool,
    duplication_settings: &DuplicationSettings,
) -> Result<NativeMetrics, String> {
    let source = Source::new(code);
    let tree = parse_source(&source, language)?;
    let _index = TreeIndex::new(&tree, language)?;
    let root = tree.root_node();
    let code = &source;
    let sets = LanguageSets::of(language);

    // One walk collects both function and initializer-block candidates (Ruby's `block` is both).
    let candidates = collect_nodes(root, |node| {
        sets.function_nodes.contains(node) || INITIALIZER_KINDS.contains(node)
    });
    let initializer_block_count = count_initializer_blocks(&candidates);
    let functions: Vec<Node<'_>> = candidates
        .into_iter()
        .filter(|node| {
            sets.function_nodes.contains(*node)
                && !is_lambda_body_block(*node)
                && is_implemented_function(*node)
        })
        .collect();

    let body_metrics = measure_function_body_metrics(root, sets, code);
    let (halstead_counts, mut halstead_counts_by_function) =
        measure_halstead(root, &functions, code);
    let dep_degrees = measure_dep_degrees(root, &functions, code, &sets.function_nodes);
    let inline_namespaces = crate::container::find_inline_namespaces(root, code);
    let function_metrics: Vec<FunctionMetrics> = functions
        .iter()
        .map(|node| {
            let body_metrics = body_metrics
                .by_function
                .get(&node.id())
                .expect("every collected function node opens a frame in the body-metrics pass");
            let name = find_function_name(*node, code);
            // Without a name of its own, a function has nothing an owner would qualify.
            let container_name = name.as_ref().and_then(|_| {
                crate::container::find_container_name(
                    *node,
                    &sets.function_nodes,
                    code,
                    &inline_namespaces,
                )
            });
            FunctionMetrics {
                name,
                container_name,
                node_type: node.kind_name().to_string(),
                start_line: node.start_position().row + 1,
                // The tree is parsed from UTF-16, so columns are UTF-16 code units x 2 — halving
                // yields the JavaScript string (UTF-16 code unit) column.
                start_column: node.start_position().column / 2,
                end_line: node.end_position().row + 1,
                end_column: node.end_position().column / 2,
                cyclomatic_complexity: body_metrics.cyclomatic_complexity,
                // Sonar's written spec adds +1 cognitive complexity per function in a recursion
                // cycle, but this is intentionally not implemented (issue #22): mainstream
                // implementations (PMD, SonarQube analyzers) omit it.
                cognitive_complexity: body_metrics.cognitive_complexity,
                cognitive_blocks: body_metrics.cognitive_blocks.clone(),
                nesting_depth: body_metrics.nesting_depth,
                ncss: body_metrics.ncss,
                parameter_count: count_parameters(*node, code),
                halstead_counts: halstead_counts_by_function
                    .remove(&node.id())
                    .expect("every function's Halstead counts are measured"),
                dep_degree: dep_degrees[&node.id()],
            }
        })
        .collect();

    let (lines, code_line_numbers) = classify_lines(code, root);
    let tokenized = tokenize(root, code);

    Ok(NativeMetrics {
        language: language.name.to_string(),
        bytes: code.code.len(),
        lines,
        code_line_numbers: {
            let mut sorted: Vec<usize> = code_line_numbers.iter().copied().collect();
            sorted.sort_unstable();
            sorted
        },
        // McCabe's v = e - n + 2p over the file's components: every function, every initializer
        // block, and the module body when the file runs top-level code; decisions outside functions
        // belong to the file.
        cyclomatic_complexity: function_metrics
            .iter()
            .map(|function| function.cyclomatic_complexity)
            .sum::<u64>()
            + body_metrics.top_level_decisions
            + u64::from(language.executes_top_level || has_top_level_statements(root, language))
            + initializer_block_count,
        cognitive_complexity: body_metrics.cognitive_complexity,
        max_cognitive_complexity: function_metrics
            .iter()
            .map(|function| function.cognitive_complexity)
            .max()
            .unwrap_or(0),
        nesting_depth: body_metrics.nesting_depth,
        ncss_count: body_metrics.ncss,
        duplication: measure_duplication(&tokenized, &code_line_numbers, duplication_settings),
        cross_file_data: include_cross_file_data.then(|| {
            to_cross_file_data(
                &tokenized,
                &code_line_numbers,
                duplication_settings.min_tokens,
            )
        }),
        halstead_counts,
        functions: function_metrics,
        syntax_tree: if include_syntax_tree {
            Some(root.to_sexp())
        } else {
            None
        },
    })
}

/// Initializer blocks run code of their own, so each is a component like a function: Java static
/// and instance initializers, Kotlin `init` blocks, and JavaScript/TypeScript class `static`
/// blocks. Their decisions already count as decisions outside functions.
static INITIALIZER_KINDS: KindSet = KindSet::new(&[
    "static_initializer",
    "anonymous_initializer",
    "class_static_block",
    "block",
]);

/// A block of a class that runs when the class or an instance is initialized.
pub fn is_initializer_block(node: Node<'_>) -> bool {
    INITIALIZER_KINDS.contains(node)
        // A bare block is an initializer only as a direct member of a Java class or enum body.
        && (node.kind_name() != "block"
            || node.parent_node().is_some_and(|parent| {
                matches!(parent.kind_name(), "class_body" | "enum_body_declarations")
            }))
}

fn count_initializer_blocks(candidates: &[Node<'_>]) -> u64 {
    candidates
        .iter()
        .filter(|node| is_initializer_block(**node))
        .count() as u64
}

/// A C# top-level statement: a `global_statement`, or a statement inside a top-level `#if` block,
/// which the grammar does not wrap in `global_statement`; preprocessor blocks are transparent.
fn is_csharp_top_level_statement(node: Node<'_>) -> bool {
    if node.kind_name().starts_with("preproc_") {
        return named_children(node)
            .into_iter()
            .any(is_csharp_top_level_statement);
    }
    node.kind_name() == "global_statement"
        || node.kind_name() == "block"
        || node.kind_name().ends_with("_statement")
}

/// Whether a C# or Kotlin file runs top-level code: C# top-level statements, or a Kotlin script's
/// statements beside its declarations.
fn has_top_level_statements(root: Node<'_>, language: &LanguageDefinition) -> bool {
    const KOTLIN_DECLARATIONS: &[&str] = &[
        "package_header",
        "import",
        "class_declaration",
        "object_declaration",
        "function_declaration",
        "property_declaration",
        "type_alias",
        "shebang",
        "file_annotation",
    ];
    let children = named_children(root);
    match language.name {
        "csharp" => children.into_iter().any(is_csharp_top_level_statement),
        // Error recovery leaves residue at the top level, so a file with parse errors is never taken
        // for a script.
        "kotlin" => {
            !root.has_error()
                && children.iter().any(|child| {
                    !KOTLIN_DECLARATIONS.contains(&child.kind_name())
                        && !crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind_name())
                })
        }
        _ => false,
    }
}

/// Collects one file's cross-file clone-detection contribution; see CrossFileFileData.
pub fn collect_cross_file_data(
    code: &str,
    language: &LanguageDefinition,
    min_tokens: usize,
) -> Result<CrossFileFileData, String> {
    let source = Source::new(code);
    let tree = parse_source(&source, language)?;
    let _index = TreeIndex::new(&tree, language)?;
    let root = tree.root_node();
    let (_, code_line_numbers) = classify_lines(&source, root);
    Ok(to_cross_file_data(
        &tokenize(root, &source),
        &code_line_numbers,
        min_tokens,
    ))
}

fn to_cross_file_data(
    tokenized: &TokenizedSource<'_>,
    code_line_numbers: &FxHashSet<usize>,
    min_tokens: usize,
) -> CrossFileFileData {
    let (candidates, tokens, container_statements, near_miss_blocks) =
        collect_cross_file_file_data(tokenized, min_tokens);
    let mut code_line_numbers: Vec<usize> = code_line_numbers.iter().copied().collect();
    code_line_numbers.sort_unstable();
    CrossFileFileData {
        candidates,
        tokens,
        container_statements,
        near_miss_blocks,
        code_line_numbers,
    }
}

/// Name-carrying leaf types anonymized by tokenize_function so consistent renames still match.
const IDENTIFIER_LEAF_NODE_TYPES: &[&str] = &[
    "identifier",
    "implicit_parameter",
    "property_identifier",
    "field_identifier",
    "type_identifier",
    "constant",
    "instance_variable",
    "class_variable",
    "global_variable",
];

/// Normalized token hash sequences of every function, index-parallel to the functions array of
/// measure().
pub fn collect_function_token_sequences(
    code: &str,
    language: &LanguageDefinition,
) -> Result<Vec<Vec<i32>>, String> {
    let source = Source::new(code);
    let tree = parse_source(&source, language)?;
    let _index = TreeIndex::new(&tree, language)?;
    let root = tree.root_node();
    let sets = LanguageSets::of(language);
    Ok(
        collect_nodes(root, |node| sets.function_nodes.contains(node))
            .into_iter()
            .filter(|node| !is_lambda_body_block(*node) && is_implemented_function(*node))
            .map(|node| {
                let mut symbols = Vec::new();
                let mut id_index_by_name: FxHashMap<String, usize> = FxHashMap::default();
                collect_token_symbols(node, &source, &mut symbols, &mut id_index_by_name);
                symbols
            })
            .collect(),
    )
}

fn collect_token_symbols(
    node: Node<'_>,
    code: &Source<'_>,
    symbols: &mut Vec<i32>,
    id_index_by_name: &mut FxHashMap<String, usize>,
) {
    if matches!(
        node.kind_name(),
        "comment" | "line_comment" | "block_comment"
    ) {
        return;
    }
    if is_atomic_operand(node) {
        symbols.push(hash_text(node.kind_name()));
        return;
    }
    if !is_token(node) {
        for child in all_children(node) {
            collect_token_symbols(child, code, symbols, id_index_by_name);
        }
        return;
    }
    if crate::util::is_kotlin_keyword_literal(node, code) {
        symbols.push(hash_text(node_text(node, code)));
        return;
    }
    if IDENTIFIER_LEAF_NODE_TYPES.contains(&node.kind_name()) {
        let next_index = id_index_by_name.len();
        let index = *id_index_by_name
            .entry(node_text(node, code).to_string())
            .or_insert(next_index);
        symbols.push(hash_text(&format!("id{index}")));
        return;
    }
    // Remaining operand leaves are literals, normalized by kind; everything else (keywords,
    // operators, punctuation) is kept verbatim.
    symbols.push(hash_text(if OPERAND_KINDS.contains(node) {
        node.kind_name()
    } else {
        node_text(node, code)
    }));
}

/// Parses the source from UTF-16, matching node-tree-sitter's JavaScript string semantics:
/// tree-sitter's error recovery differs between input encodings for malformed non-ASCII source.
fn parse_source(
    source: &Source<'_>,
    language: &LanguageDefinition,
) -> Result<tree_sitter::Tree, String> {
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&language.grammar())
        .map_err(|error| error.to_string())?;
    parser
        .parse_utf16_le(source.to_utf16(), None)
        .ok_or_else(|| "parse failed".to_string())
}

struct CommentSpan {
    line: usize,
    start_column: usize,
    end_column: usize,
}

/// Line metrics plus the 1-based numbers of lines that are neither blank nor comment-only, shared
/// by the line counts and duplication line coverage so the coverage and its code-line denominator
/// agree.
fn classify_lines(code: &Source<'_>, root: Node<'_>) -> (LineMetrics, FxHashSet<usize>) {
    let source_lines = split_lines(code.code);
    // Spans are bucketed by line so classification stays linear.
    let mut comment_spans_by_line: FxHashMap<usize, Vec<CommentSpan>> = FxHashMap::default();
    for span in collect_comment_spans(root) {
        comment_spans_by_line
            .entry(span.line)
            .or_default()
            .push(span);
    }
    let mut blank = 0;
    let mut comment = 0;
    let mut code_line_numbers = FxHashSet::default();

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
        if matches!(
            node.kind_name(),
            "comment" | "line_comment" | "block_comment"
        ) {
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
    // Kotlin elvis, not-null assertion, negated containment/type checks, safe cast, and labeled
    // jumps (single tokens in the grammar: `break@`, `continue@`, `return@`).
    "?:",
    "!!",
    "!in",
    "!is",
    "as?",
    "break@",
    "continue@",
    "return@",
    // C# `default(T)`/`default`; the same token labels switch sections, which do not count.
    "default",
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

static OPERAND_KINDS: KindSet = KindSet::new(&[
    "identifier",
    "implicit_parameter",
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
    "this_expression",
    "super",
    "super_expression",
    "base",
    // C/C++/Rust/C# built-in types are leaves of their own node type, unlike Go's `type_identifier`.
    "primitive_type",
    "predefined_type",
    "boolean_type",
    "void_type",
    "auto",
    "number",
    "integer",
    "float",
    "integer_literal",
    "float_literal",
    "real_literal",
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
    "verbatim_string_literal",
    "string_fragment",
    "multiline_string_fragment",
    "string_content",
    "string_literal_content",
    "raw_string_content",
    "template_string",
    "char_literal",
    "character",
    "true",
    "false",
    "boolean_literal",
    "null",
    "null_literal",
    "undefined",
    "nil",
    "none",
]);

/// Non-leaf literals counted as one Halstead operand without descending.
/// `character_literal` is a leaf in Java but wraps its content in C# and Kotlin.
static ATOMIC_OPERAND_KINDS: KindSet = KindSet::new(&[
    "interpreted_string_literal",
    "character_literal",
    "regex",
    "user_defined_literal",
    "integral_type",
    "floating_point_type",
    "sized_type_specifier",
    "placeholder_type_specifier",
]);

fn operator_texts() -> &'static FxHashSet<&'static str> {
    static SET: OnceLock<FxHashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| OPERATOR_TEXTS.iter().copied().collect())
}

/// Node kinds spelled like an operator.
static OPERATOR_KINDS: KindSet = KindSet::new(OPERATOR_TEXTS);

/// Halstead operator and operand occurrences by text.
#[derive(Default)]
struct HalsteadTally<'a> {
    operators: FxHashMap<&'a str, u64>,
    operands: FxHashMap<&'a str, u64>,
}

impl<'a> HalsteadTally<'a> {
    fn counts(&self) -> HalsteadCounts {
        HalsteadCounts {
            distinct_operators: self.operators.len(),
            distinct_operands: self.operands.len(),
            total_operators: self.operators.values().sum(),
            total_operands: self.operands.values().sum(),
        }
    }

    fn absorb(&mut self, other: HalsteadTally<'a>) {
        for (text, count) in other.operators {
            *self.operators.entry(text).or_insert(0) += count;
        }
        for (text, count) in other.operands {
            *self.operands.entry(text).or_insert(0) += count;
        }
    }
}

/// Halstead counts of the subtree of `root` and, by node id, of each function in `functions`.
fn measure_halstead<'a>(
    root: Node<'a>,
    functions: &[Node<'a>],
    code: &Source<'a>,
) -> (HalsteadCounts, FxHashMap<usize, HalsteadCounts>) {
    let (counts, mut by_function) =
        count_halstead(root, &functions.iter().map(Node::id).collect(), code);
    for function in functions {
        // The walk counts atomic operands and tokens without descending into them and skips
        // comments, any of which can hold a function (a C++ lambda in a constrained `auto` type).
        by_function
            .entry(function.id())
            .or_insert_with(|| count_halstead(*function, &FxHashSet::default(), code).0);
    }
    (counts, by_function)
}

/// Halstead counts of the subtree of `root` and, by node id, of each function in `function_ids`
/// whose subtree the walk enters: a function's tokens are counted the same wherever the walk
/// starts, so its tally is kept apart while its subtree is walked and then joins the enclosing one.
fn count_halstead<'a>(
    root: Node<'a>,
    function_ids: &FxHashSet<usize>,
    code: &Source<'a>,
) -> (HalsteadCounts, FxHashMap<usize, HalsteadCounts>) {
    struct Walk<'a, 'w> {
        code: &'w Source<'a>,
        function_ids: &'w FxHashSet<usize>,
        /// The tally of the walked subtree, then that of each function being walked.
        tallies: Vec<HalsteadTally<'a>>,
        by_function: FxHashMap<usize, HalsteadCounts>,
    }

    impl<'a> Walk<'a, '_> {
        fn visit(&mut self, node: Node<'a>) {
            let tally = self.tallies.last_mut().expect("the walked subtree's tally");
            if !count_halstead_token(node, self.code, tally) {
                return;
            }
            let is_function = self.function_ids.contains(&node.id());
            if is_function {
                self.tallies.push(HalsteadTally::default());
            }
            for child in all_children(node) {
                self.visit(child);
            }
            if is_function {
                let tally = self.tallies.pop().expect("pushed above");
                self.by_function.insert(node.id(), tally.counts());
                self.tallies
                    .last_mut()
                    .expect("the walked subtree's tally")
                    .absorb(tally);
            }
        }
    }

    let mut walk = Walk {
        code,
        function_ids,
        tallies: vec![HalsteadTally::default()],
        by_function: FxHashMap::default(),
    };
    walk.visit(root);
    (walk.tallies[0].counts(), walk.by_function)
}

/// Counts the node into `tally` if it is a token or an atomic operand, returning whether its
/// children are to be counted instead.
fn count_halstead_token<'a>(
    node: Node<'a>,
    code: &Source<'a>,
    tally: &mut HalsteadTally<'a>,
) -> bool {
    if matches!(
        node.kind_name(),
        "comment" | "line_comment" | "block_comment"
    ) {
        return false;
    }

    if is_atomic_operand(node) {
        *tally.operands.entry(node_text(node, code)).or_insert(0) += 1;
        return false;
    }

    // Operators are counted from leaf tokens only: keyword-named nodes always contain a
    // same-text anonymous keyword leaf, so counting the named node as well would double-count.
    if !is_token(node) {
        return true;
    }
    let text = node_text(node, code);
    // Operands win over text matches so identifiers spelled like word operators stay operands;
    // C# `nameof(x)` is the one keyword operator the grammar parses as a plain callee.
    if is_csharp_nameof_callee(node, text) {
        *tally.operators.entry(text).or_insert(0) += 1;
    } else if OPERAND_KINDS.contains(node) {
        *tally.operands.entry(text).or_insert(0) += 1;
    } else if (operator_texts().contains(text) || OPERATOR_KINDS.contains(node))
        && is_countable_contextual_token(node, text)
    {
        let key = if text.is_empty() {
            node.kind_name()
        } else {
            text
        };
        *tally.operators.entry(key).or_insert(0) += 1;
    }
    false
}

/// A literal counted as one operand without descending: ATOMIC_OPERAND_KINDS, or a Go raw
/// string, which wraps its content like Go's interpreted strings (the Rust and C++
/// `raw_string_literal`s count their content leaves instead).
fn is_atomic_operand(node: Node<'_>) -> bool {
    ATOMIC_OPERAND_KINDS.contains(node)
        || (node.kind_name() == "raw_string_literal" && crate::tree_index::language_name() == "go")
}

/// tree-sitter-c-sharp parses `nameof(x)` as an invocation of an identifier named `nameof`.
fn is_csharp_nameof_callee(node: Node<'_>, text: &str) -> bool {
    text == "nameof"
        && node.kind_name() == "identifier"
        && node.parent_node().is_some_and(|parent| {
            parent.kind_name() == "invocation_expression"
                && parent
                    .child_by_field_name("function")
                    .is_some_and(|callee| callee.id() == node.id())
        })
}

/// Ternary/conditional and Rust try parents make `?` an operator; TS optional markers do not.
const QUESTION_OPERATOR_PARENT_TYPES: &[&str] = &[
    "ternary_expression",
    "conditional_expression",
    "conditional",
    "try_expression",
    // TypeScript conditional types (`T extends U ? X : Y`) select like a ternary.
    "conditional_type",
    // C# null-conditional access (`a?.b`).
    "conditional_access_expression",
];

fn is_countable_contextual_token(node: Node<'_>, text: &str) -> bool {
    if text == "@" {
        // Python matrix multiplication only; decorator/annotation `@` marks are not operators.
        let parent_type = node.parent_node().map(|parent| parent.kind_name());
        return parent_type == Some("binary_operator")
            || parent_type == Some("augmented_assignment");
    }
    if text == "default" {
        return node
            .parent_node()
            .is_some_and(|parent| parent.kind_name() == "default_expression");
    }
    if text != "?" {
        return true;
    }
    node.parent_node()
        .is_some_and(|parent| QUESTION_OPERATOR_PARENT_TYPES.contains(&parent.kind_name()))
}
