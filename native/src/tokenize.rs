use rustc_hash::FxHashMap;
use std::borrow::Cow;
use std::cell::RefCell;
use std::sync::OnceLock;
use tree_sitter::Node;

use crate::tree_index::NodeExt;
use crate::util::{all_children, is_token, named_children, node_text, recycle_vec, Source};

/// Block-like nodes considered as whole-subtree duplicate candidates.
const DUPLICATE_BLOCK_TYPES: &[&str] = &[
    "statement_block",
    "block",
    "compound_statement",
    "body_statement",
    "constructor_body",
    "do_block",
    "if_statement",
    "for_statement",
    "for_in_statement",
    "enhanced_for_statement",
    "for_range_loop",
    "while_statement",
    "do_statement",
    "try_statement",
    "try_with_resources_statement",
    "with_statement",
    "switch_statement",
    "switch_expression",
    "switch_case",
    "switch_block_statement_group",
    "switch_rule",
    "case_clause",
    "case_statement",
    "match_statement",
    "match_arm",
    "except_clause",
    "catch_clause",
    "finally_clause",
    "elif_clause",
    "ensure",
    "expression_statement",
    "return_statement",
    "return_expression",
    "if_expression",
    "for_expression",
    "while_expression",
    "loop_expression",
    "match_expression",
    "foreach_statement",
    "switch_section",
    "switch_expression_arm",
    "using_statement",
    "lock_statement",
    "when_expression",
    "when_entry",
    "do_while_statement",
    "catch_block",
    "finally_block",
    "function_body",
    "jsx_element",
    "jsx_self_closing_element",
    "if",
    "unless",
    "case",
    "case_match",
    "while",
    "until",
    "for",
    "begin",
    "when",
];

/// Nodes whose direct named children form statement sequences scanned for copy-pasted runs.
const STATEMENT_CONTAINER_TYPES: &[&str] = &[
    "program",
    "source_file",
    "translation_unit",
    "module",
    "statement_block",
    "block",
    "compound_statement",
    "body_statement",
    "constructor_body",
    "class_body",
    "block_body",
    "do_block",
    "do",
    "ensure",
    "then",
    "else",
    "case_statement",
    "switch_block_statement_group",
    "switch_rule",
    "expression_case",
    "type_case",
    "communication_case",
    "default_case",
    "compilation_unit",
    "switch_section",
    "extension_body",
    "enum_class_body",
    "function_body",
    "lambda_literal",
];

/// C# type bodies are `declaration_list`s, a name Rust also uses for `mod`/`impl`/`trait` bodies;
/// only the C# ones (under these parents) hold member runs scanned like Java's `class_body`.
const CSHARP_DECLARATION_LIST_PARENT_TYPES: &[&str] = &[
    "class_declaration",
    "struct_declaration",
    "interface_declaration",
    "record_declaration",
    "namespace_declaration",
];

/// Identifier leaves anonymized by occurrence order so consistently renamed copies still match.
const ANONYMIZED_IDENTIFIER_TYPES: &[&str] = &[
    "identifier",
    "implicit_parameter",
    "constant",
    "instance_variable",
    "class_variable",
    "global_variable",
];

const SHORTHAND_PROPERTY_TYPES: &[&str] = &[
    "shorthand_property_identifier",
    "shorthand_property_identifier_pattern",
];

/// Literal leaves normalized to a kind tag so copies differing only in literal values still match.
const LITERAL_KIND_BY_TYPE: &[(&str, &str)] = &[
    ("number", "#num"),
    ("number_literal", "#num"),
    ("integer", "#num"),
    ("float", "#num"),
    ("integer_literal", "#num"),
    ("float_literal", "#num"),
    ("real_literal", "#num"),
    ("int_literal", "#num"),
    ("rune_literal", "#char"),
    ("imaginary_literal", "#num"),
    ("decimal_integer_literal", "#num"),
    ("hex_integer_literal", "#num"),
    ("octal_integer_literal", "#num"),
    ("binary_integer_literal", "#num"),
    ("decimal_floating_point_literal", "#num"),
    ("hex_floating_point_literal", "#num"),
    ("string_fragment", "#str"),
    ("multiline_string_fragment", "#str"),
    ("string_content", "#str"),
    ("string_literal_content", "#str"),
    ("character_literal_content", "#char"),
    ("verbatim_string_literal", "#str"),
    ("interpolated_string_expression", "#str"),
    ("raw_string_content", "#str"),
    ("heredoc_content", "#str"),
    ("heredoc_beginning", "#heredoc"),
    ("heredoc_end", "#heredoc"),
    ("string", "#str"),
    ("template_string", "#str"),
    ("string_literal", "#str"),
    ("interpreted_string_literal", "#str"),
    ("raw_string_literal", "#str"),
    ("raw_string", "#str"),
    ("escape_sequence", "#str"),
    ("char_literal", "#char"),
    ("character_literal", "#char"),
    ("character", "#char"),
    ("regex_pattern", "#regex"),
];

const COMMENT_TYPES: &[&str] = &["comment", "line_comment", "block_comment"];

/// Declaration kinds that only name dependencies (imports, package clauses, includes).
const DEPENDENCY_DECLARATION_TYPES: &[&str] = &[
    "import_statement",
    "import_from_statement",
    "future_import_statement",
    "import_alias",
    "import_declaration",
    "package_clause",
    "package_declaration",
    "package_header",
    "use_declaration",
    "extern_crate_declaration",
    "using_directive",
    "extern_alias_directive",
    "preproc_include",
];

/// Ruby methods that load another file, called without a receiver.
const RUBY_REQUIRE_METHODS: &[&str] = &["require", "require_relative"];

/// Children of a string node that carry only literal content; anything else is interpolation.
const STRING_FRAGMENT_TYPES: &[&str] = &[
    "string_fragment",
    "multiline_string_fragment",
    "string_content",
    "string_literal_content",
    "character_literal_content",
    "raw_string_content",
    "interpreted_string_literal_content",
    "raw_string_literal_content",
    "format_specifier",
    "raw_string_start",
    "raw_string_end",
    "escape_sequence",
    "heredoc_content",
    "string_start",
    "string_end",
    "string_literal_encoding",
    "interpolation_start",
    "interpolation_quote",
];

/// Grammar fields whose plain-`identifier` leaves are semantic API names, kept verbatim.
const SEMANTIC_NAME_FIELD_BY_PARENT_TYPE: &[(&str, &str)] = &[
    ("call_expression", "function"),
    ("method_invocation", "name"),
    ("call", "method"),
    ("attribute", "attribute"),
    ("macro_invocation", "macro"),
    ("field_access", "field"),
    ("new_expression", "constructor"),
    ("keyword_argument", "name"),
    ("element_value_pair", "key"),
    ("generic_function", "function"),
    ("template_function", "name"),
    ("invocation_expression", "function"),
    ("member_access_expression", "name"),
    ("member_binding_expression", "name"),
    ("argument", "name"),
];

/// Rust's `Some(x)` variant patterns and Java's `uses Foo;` also put a plain identifier in a `type`
/// field; they stay anonymized as before C# support. Rust's `generic_type` head is normally a
/// `type_identifier` (kept verbatim like every type name); the entry covers the reserved-word
/// heads the grammar spells as a plain identifier.
const NON_CSHARP_TYPE_FIELD_PARENT_TYPES: &[&str] = &[
    "tuple_struct_pattern",
    "generic_type",
    "uses_module_directive",
];

/// C# spells type names as plain `identifier`s (Java has `type_identifier`); an identifier under
/// one of these parents, or in any other parent's `type` field, names a type and stays verbatim.
const CSHARP_TYPE_PARENT_TYPES: &[&str] = &[
    "generic_name",
    "qualified_name",
    "alias_qualified_name",
    "type_argument_list",
    "base_list",
    "explicit_interface_specifier",
    "using_directive",
];

/// Kind tags whose raw source text re-enters the fingerprint in literal-dense (data-like) regions.
const VALUE_CARRYING_LITERAL_KINDS: &[&str] = &["#num", "#str", "#char", "#regex"];

/// String children that carry actual content (STRING_FRAGMENT_TYPES minus the delimiter nodes).
const STRING_CONTENT_FRAGMENT_TYPES: &[&str] = &[
    "string_fragment",
    "multiline_string_fragment",
    "string_content",
    "string_literal_content",
    "character_literal_content",
    "raw_string_content",
    "interpreted_string_literal_content",
    "raw_string_literal_content",
    "format_specifier",
    "escape_sequence",
    "heredoc_content",
];

const MAX_RETAINED_TOKENS: usize = 1_048_576;

pub(crate) struct Token<'a> {
    pub is_id: bool,
    pub text: &'a str,
    /// Two independent hashes of `text` (djb2 and FNV-1a); see the Token doc in duplication.ts.
    pub text_hash: i32,
    pub text_hash2: i32,
    /// Hash pair of a value-carrying literal's value, folded into data-like region fingerprints.
    pub literal_hash: Option<i32>,
    pub literal_hash2: Option<i32>,
    /// True for verbatim-kept NAMES (named grammar leaves); see the Token doc in duplication.ts.
    pub is_name: bool,
    pub start_row: usize,
    pub end_row: usize,
}

pub(crate) struct TokenRange {
    pub start_token_index: usize,
    pub end_token_index: usize,
    pub start_index: usize,
    pub end_index: usize,
    pub start_line: usize,
    pub end_line: usize,
}

#[derive(Default)]
pub(crate) struct SourceStructure {
    pub block_ranges: Vec<TokenRange>,
    /// The guarded statements of each C++ try block split across two preprocessor conditionals.
    /// Such a block has no node, so within-file matching and near-miss comparison take it from
    /// here. Cross-file candidates leave it out: they are deduplicated by region, and the body's
    /// full statement run, which spans the same tokens, is what a copy in another file carries.
    pub split_try_body_ranges: Vec<TokenRange>,
    pub container_statement_ranges: Vec<Vec<TokenRange>>,
}

/// A file's normalized token stream with the block and statement structure clone detection
/// matches over, built once per parse and shared by within-file and cross-file detection.
pub struct TokenizedSource<'a> {
    pub(crate) tokens: Vec<Token<'a>>,
    pub(crate) structure: SourceStructure,
    pub(crate) literal_count_prefix: Vec<usize>,
}

#[derive(Default)]
struct TokenBuffers {
    tokens: Vec<Token<'static>>,
    block_ranges: Vec<TokenRange>,
    literal_count_prefix: Vec<usize>,
}

thread_local! {
    static TOKEN_BUFFERS: RefCell<TokenBuffers> = RefCell::new(TokenBuffers::default());
}

pub fn tokenize<'a>(root: Node<'_>, code: &Source<'a>) -> TokenizedSource<'a> {
    let (mut tokens, block_ranges, mut literal_count_prefix) =
        TOKEN_BUFFERS.with_borrow_mut(|buffers| {
            (
                take_empty_tokens(&mut buffers.tokens),
                std::mem::take(&mut buffers.block_ranges),
                std::mem::take(&mut buffers.literal_count_prefix),
            )
        });
    tokens.reserve(root.descendant_count() / 2);
    let mut structure = SourceStructure {
        block_ranges,
        split_try_body_ranges: Vec::new(),
        container_statement_ranges: Vec::new(),
    };
    collect_tokens(root, code, &mut tokens, &mut structure);
    build_literal_count_prefix(&tokens, &mut literal_count_prefix);
    TokenizedSource {
        tokens,
        structure,
        literal_count_prefix,
    }
}

impl Drop for TokenizedSource<'_> {
    fn drop(&mut self) {
        TOKEN_BUFFERS.with_borrow_mut(|buffers| {
            recycle_empty_tokens(&mut self.tokens, &mut buffers.tokens);
            recycle_vec(
                &mut self.structure.block_ranges,
                &mut buffers.block_ranges,
                MAX_RETAINED_TOKENS,
            );
            recycle_vec(
                &mut self.literal_count_prefix,
                &mut buffers.literal_count_prefix,
                MAX_RETAINED_TOKENS + 1,
            );
        });
    }
}

fn take_empty_tokens<'a>(retained: &mut Vec<Token<'static>>) -> Vec<Token<'a>> {
    let empty = std::mem::take(retained);
    assert!(empty.is_empty());
    // SAFETY: `empty` holds zero elements, and `Token<'a>` differs from `Token<'static>` only in
    // its lifetime parameter, so their allocation layouts are identical.
    unsafe { std::mem::transmute::<Vec<Token<'static>>, Vec<Token<'a>>>(empty) }
}

fn recycle_empty_tokens(used: &mut Vec<Token<'_>>, retained: &mut Vec<Token<'static>>) {
    let mut empty = std::mem::take(used);
    empty.clear();
    // SAFETY: `empty` was just cleared (`len == 0`), so no borrowed `&'a str` remains in the
    // buffer when its spare capacity is retained for the next call on this thread.
    let mut empty = unsafe { std::mem::transmute::<Vec<Token<'_>>, Vec<Token<'static>>>(empty) };
    recycle_vec(&mut empty, retained, MAX_RETAINED_TOKENS);
}

// code-gauge-allow functionCognitiveComplexity -- one walk emits the tokens, block ranges, and statement runs, which index into one token stream
// code-gauge-allow functionNcss -- same walk; splitting it would thread the three outputs through every helper
fn collect_tokens<'a>(
    root: Node<'_>,
    code: &Source<'a>,
    tokens: &mut Vec<Token<'a>>,
    structure: &mut SourceStructure,
) {
    /// `statement_list_statements` receives the statements of a Go `statement_list`, which wraps
    /// the statements of blocks and case clauses and whose statements belong to the run of the
    /// enclosing container.
    fn visit<'a>(
        node: Node<'_>,
        code: &Source<'a>,
        tokens: &mut Vec<Token<'a>>,
        structure: &mut SourceStructure,
        statement_list_statements: &mut Vec<TokenRange>,
    ) -> TokenRange {
        let start_token_index = tokens.len();
        // The span of the node's tokens, which can be narrower than the node: a Python block
        // starts at its header's colon, and a Rust declaration starts at its doc comment.
        let mut token_span: Option<SourceSpan> = None;
        let is_token = is_token(node);
        let atomic_kind = if is_token {
            None
        } else {
            atomic_literal_kind(node)
        };
        if is_token {
            append_leaf_token(node, code, tokens);
        } else if let Some(atomic_kind) = atomic_kind {
            // Interpolation-free strings collapse to their kind tag so copies differing only in
            // quote style or content still match.
            tokens.push(make_text_token(
                atomic_kind,
                Some(literal_value_text(node, atomic_kind, code)),
                false,
                node.start_position().row,
                node.end_position().row,
            ));
        } else if !is_tokenless(node, code) {
            let mut statement_ranges: Vec<TokenRange> = Vec::new();
            let is_statement_list = node.kind_name() == "statement_list";
            let is_container = is_statement_list || is_statement_container(node);
            for child in all_children(node) {
                let mut child_statements = Vec::new();
                let child_range = visit(child, code, tokens, structure, &mut child_statements);
                token_span = widen_token_span(token_span, &child_range);
                if is_container && is_run_statement(node, child, code) {
                    if child.kind_name() == "statement_list" {
                        statement_ranges.append(&mut child_statements);
                    } else {
                        statement_ranges.push(child_range);
                    }
                }
            }
            if is_statement_list {
                *statement_list_statements = statement_ranges;
            } else if is_container && !statement_ranges.is_empty() {
                record_statement_run(node, statement_ranges, structure);
            }
        }

        let span = token_span.unwrap_or(SourceSpan {
            start_index: node.start_byte(),
            end_index: node.end_byte(),
            start_line: node.start_position().row + 1,
            end_line: node.end_position().row + 1,
        });
        let range = TokenRange {
            start_token_index,
            end_token_index: tokens.len(),
            start_index: span.start_index,
            end_index: span.end_index,
            start_line: span.start_line,
            end_line: span.end_line,
        };
        if is_duplicate_block(node) {
            structure.block_ranges.push(TokenRange { ..range });
        }
        range
    }

    visit(root, code, tokens, structure, &mut Vec::new());
}

/// Whole-subtree duplicate candidates: DUPLICATE_BLOCK_TYPES plus Kotlin's `try_expression`, which
/// shares its name with Rust's `?` operator (see is_kotlin_try_expression).
fn is_duplicate_block(node: Node<'_>) -> bool {
    if !node.is_named() {
        return false;
    }
    if node.kind_name() == "try_expression" {
        return crate::util::is_kotlin_try_expression(node);
    }
    DUPLICATE_BLOCK_TYPES.contains(&node.kind_name())
}

fn is_statement_container(node: Node<'_>) -> bool {
    if !node.is_named() {
        return false;
    }
    if node.kind_name() == "declaration_list" {
        return node.parent_node().is_some_and(|parent| {
            CSHARP_DECLARATION_LIST_PARENT_TYPES.contains(&parent.kind_name())
        });
    }
    STATEMENT_CONTAINER_TYPES.contains(&node.kind_name()) || is_split_try_statement(node)
}

/// Whether `child` is one of the statements in the run of `container`. A Kotlin lambda's
/// parameters sit beside its statements, and the conditionals that open and close a split
/// `try_statement` stay out of its run like the braces and handlers of an ordinary one.
fn is_run_statement(container: Node<'_>, child: Node<'_>, code: &Source<'_>) -> bool {
    child.is_named()
        && !is_tokenless(child, code)
        && child.kind_name() != "lambda_parameters"
        && !(container.kind_name() == "try_statement" && is_split_try_seam(child))
}

/// Records the non-empty statement run of the container `node`. Single-statement runs are
/// recorded too: window enumeration needs two statements and yields nothing for them, but
/// cross-file matching catalogues each container's full run.
fn record_statement_run(
    node: Node<'_>,
    statements: Vec<TokenRange>,
    structure: &mut SourceStructure,
) {
    if is_split_try_statement(node) {
        structure
            .split_try_body_ranges
            .push(spanning_range(&statements));
    }
    structure.container_statement_ranges.push(statements);
}

/// A C++ `try_statement` whose braces sit in two preprocessor conditionals (`#if X` / `try {` /
/// `#endif` ... `#if X` / `} catch (...) { ... }` / `#endif`) has no block: the guarded statements
/// are its own children, between the two conditionals. Every other `try_statement` starts with
/// the `try` keyword.
fn is_split_try_statement(node: Node<'_>) -> bool {
    node.kind_name() == "try_statement"
        && node
            .child(0)
            .is_some_and(|first| first.kind_name().starts_with("preproc_"))
}

/// The range from the first of `statements` through the last; `statements` is not empty.
fn spanning_range(statements: &[TokenRange]) -> TokenRange {
    let (first, last) = (&statements[0], &statements[statements.len() - 1]);
    TokenRange {
        end_token_index: last.end_token_index,
        end_index: last.end_index,
        end_line: last.end_line,
        ..*first
    }
}

fn is_split_try_seam(child: Node<'_>) -> bool {
    child.kind_name().starts_with("preproc_")
        && (0..child.child_count()).any(|index| {
            child
                .child(index)
                .is_some_and(|part| matches!(part.kind_name(), "try" | "catch_clause"))
        })
}

#[derive(Clone, Copy)]
struct SourceSpan {
    start_index: usize,
    end_index: usize,
    start_line: usize,
    end_line: usize,
}

/// `span` extended to the end of `child`'s tokens, or `child`'s token span when `span` is empty;
/// a child without tokens leaves it as it is.
fn widen_token_span(span: Option<SourceSpan>, child: &TokenRange) -> Option<SourceSpan> {
    if child.start_token_index == child.end_token_index {
        return span;
    }
    Some(SourceSpan {
        start_index: span.map_or(child.start_index, |span| span.start_index),
        end_index: child.end_index,
        start_line: span.map_or(child.start_line, |span| span.start_line),
        end_line: child.end_line,
    })
}

/// Comments and dependency declarations contribute no tokens, so no clone consists of them; the
/// tokens around them stay adjacent, so a clone may still extend across one.
fn is_tokenless(node: Node<'_>, code: &Source<'_>) -> bool {
    COMMENT_TYPES.contains(&node.kind_name()) || is_dependency_declaration(node, code)
}

/// Every module must spell out its own dependencies, so a clone made of them has no refactoring
/// that could remove it; they are left out of clone detection entirely.
fn is_dependency_declaration(node: Node<'_>, code: &Source<'_>) -> bool {
    if !node.is_named() {
        return false;
    }
    let kind = node.kind_name();
    if DEPENDENCY_DECLARATION_TYPES.contains(&kind) {
        return true;
    }
    match (crate::tree_index::language_name(), kind) {
        // JavaScript's dynamic `import(...)` is a named `import` node too.
        ("kotlin", "import") => true,
        ("cpp", "using_declaration") => true,
        // `mod name;` loads a file; a `mod name { ... }` with a body is code.
        ("rust", "mod_item") => node.child_by_field_name("body").is_none(),
        // Re-exports (`export { a } from './a'`); other exports wrap declarations.
        ("javascript" | "jsx" | "typescript" | "tsx", "export_statement") => {
            node.child_by_field_name("source").is_some()
        }
        (
            "javascript" | "jsx" | "typescript" | "tsx",
            "lexical_declaration" | "variable_declaration",
        ) => is_require_declaration(node, code),
        // `require('a');` and CommonJS re-exports such as `module.exports = require('a');`.
        ("javascript" | "jsx" | "typescript" | "tsx", "expression_statement") => {
            named_children(node).first().is_some_and(|expression| {
                if expression.kind_name() == "assignment_expression" {
                    expression
                        .child_by_field_name("right")
                        .is_some_and(|right| is_require_value(right, code))
                } else {
                    is_require_value(*expression, code)
                }
            })
        }
        ("ruby", "call") => {
            node.child_by_field_name("receiver").is_none()
                && node
                    .child_by_field_name("method")
                    .is_some_and(|method| RUBY_REQUIRE_METHODS.contains(&node_text(method, code)))
        }
        _ => false,
    }
}

/// `const a = require('a')` (including destructuring and `require('a').b`) in every declarator.
fn is_require_declaration(node: Node<'_>, code: &Source<'_>) -> bool {
    let declarators: Vec<Node<'_>> = named_children(node)
        .into_iter()
        .filter(|child| child.kind_name() == "variable_declarator")
        .collect();
    !declarators.is_empty()
        && declarators.iter().all(|declarator| {
            declarator
                .child_by_field_name("value")
                .is_some_and(|value| is_require_value(value, code))
        })
}

/// `require('a')` or a property read from it (`require('a').b`), but not a call on the module.
fn is_require_value(node: Node<'_>, code: &Source<'_>) -> bool {
    let mut value = node;
    while value.kind_name() == "member_expression" {
        let Some(object) = value.child_by_field_name("object") else {
            return false;
        };
        value = object;
    }
    value.kind_name() == "call_expression"
        && value
            .child_by_field_name("function")
            .is_some_and(|function| {
                function.kind_name() == "identifier" && node_text(function, code) == "require"
            })
}

/// The kind tag of a string-like node with no interpolation, or None to descend normally.
fn atomic_literal_kind(node: Node<'_>) -> Option<&'static str> {
    let kind = if node.is_named() {
        literal_kind_by_type().get(node.kind_name()).copied()
    } else {
        None
    };
    let kind = kind?;
    named_children(node)
        .iter()
        .all(|child| STRING_FRAGMENT_TYPES.contains(&child.kind_name()))
        .then_some(kind)
}

fn append_leaf_token<'a>(node: Node<'_>, code: &Source<'a>, tokens: &mut Vec<Token<'a>>) {
    if COMMENT_TYPES.contains(&node.kind_name()) {
        return;
    }

    let start_row = node.start_position().row;
    let end_row = node.end_position().row;
    if node.is_named() && SHORTHAND_PROPERTY_TYPES.contains(&node.kind_name()) {
        let text = node_text(node, code);
        tokens.push(make_text_token(text, None, true, start_row, end_row));
        tokens.push(make_text_token(":", None, false, start_row, end_row));
        tokens.push(make_id_token(text, start_row, end_row));
        return;
    }

    if crate::util::is_kotlin_keyword_literal(node, code) {
        tokens.push(make_text_token(
            node_text(node, code),
            None,
            false,
            start_row,
            end_row,
        ));
        return;
    }
    if node.is_named()
        && ANONYMIZED_IDENTIFIER_TYPES.contains(&node.kind_name())
        && !is_semantic_name_leaf(node, code)
    {
        tokens.push(make_id_token(node_text(node, code), start_row, end_row));
        return;
    }

    // Anything else keeps its text: keywords, operators, punctuation, and semantic names.
    let literal_kind = if node.is_named() {
        literal_kind_by_type().get(node.kind_name()).copied()
    } else {
        None
    };
    tokens.push(match literal_kind {
        Some(kind) => make_text_token(
            kind,
            Some(literal_value_text(node, kind, code)),
            false,
            start_row,
            end_row,
        ),
        None => make_text_token(
            node_text(node, code),
            None,
            node.is_named(),
            start_row,
            end_row,
        ),
    });
}

fn literal_kind_by_type() -> &'static FxHashMap<&'static str, &'static str> {
    static MAP: OnceLock<FxHashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| LITERAL_KIND_BY_TYPE.iter().copied().collect())
}

fn make_id_token(text: &str, start_row: usize, end_row: usize) -> Token<'_> {
    Token {
        is_id: true,
        text,
        text_hash: 0,
        text_hash2: 0,
        literal_hash: None,
        literal_hash2: None,
        is_name: false,
        start_row,
        end_row,
    }
}

fn make_text_token<'a>(
    text: &'a str,
    literal_value_text: Option<Cow<'a, str>>,
    is_name: bool,
    start_row: usize,
    end_row: usize,
) -> Token<'a> {
    let text_hash = hash_text(text);
    let text_hash2 = hash_text2(text);
    let (literal_hash, literal_hash2) = match literal_value_text {
        Some(value) if VALUE_CARRYING_LITERAL_KINDS.contains(&text) => {
            (Some(hash_text(&value)), Some(hash_text2(&value)))
        }
        _ => (None, None),
    };
    Token {
        is_id: false,
        text,
        text_hash,
        text_hash2,
        literal_hash,
        literal_hash2,
        is_name,
        start_row,
        end_row,
    }
}

/// The value of a literal as folded into literal-dense fingerprints, independent of its delimiter
/// spelling (quote style, C# verbatim prefix) so equal values in differently quoted copies match.
fn literal_value_text<'a>(node: Node<'_>, kind: &str, code: &Source<'a>) -> Cow<'a, str> {
    if kind != "#str" && kind != "#char" {
        return Cow::Borrowed(node_text(node, code));
    }
    // Fragment leaves already carry bare content; a quote appearing there is content.
    if STRING_CONTENT_FRAGMENT_TYPES.contains(&node.kind_name()) {
        return Cow::Borrowed(node_text(node, code));
    }
    let fragments: Vec<&str> = named_children(node)
        .iter()
        .filter(|child| STRING_CONTENT_FRAGMENT_TYPES.contains(&child.kind_name()))
        .map(|child| node_text(*child, code))
        .collect();
    if !fragments.is_empty() {
        return Cow::Owned(fragments.concat());
    }
    // A C# verbatim string (`@"..."`) carries the same value as its ordinary spelling.
    let text = node_text(node, code);
    let text = if node.kind_name() == "verbatim_string_literal" {
        text.strip_prefix('@').unwrap_or(text)
    } else {
        text
    };
    Cow::Borrowed(strip_matching_quotes(text))
}

/// Strips one matching pair of surrounding ASCII quotes (quote characters are ASCII, so byte
/// indexing is UTF-8 safe).
fn strip_matching_quotes(text: &str) -> &str {
    let bytes = text.as_bytes();
    if bytes.len() >= 2 {
        let first = bytes[0];
        if (first == b'"' || first == b'\'' || first == b'`') && bytes[bytes.len() - 1] == first {
            return &text[1..text.len() - 1];
        }
    }
    text
}

fn is_semantic_name_leaf(node: Node<'_>, code: &Source<'_>) -> bool {
    let Some(parent) = node.parent_node() else {
        return false;
    };

    // Java method references (`Foo::bar`) and Kotlin callable references (`::bar`) name their
    // identifiers without grammar fields, and Kotlin spells type names as identifiers.
    if matches!(
        parent.kind_name(),
        "method_reference" | "callable_reference" | "user_type"
    ) {
        return true;
    }
    // A Kotlin type parameter's name has no field (C# puts its own in `name`).
    if parent.kind_name() == "type_parameter" && parent.child_by_field_name("name").is_none() {
        return true;
    }
    if node.kind_name() == "identifier"
        && (is_csharp_semantic_name(node, parent) || is_kotlin_semantic_name(node, parent))
    {
        return true;
    }

    // `call` names its callee `method` in Ruby but `function` in Python; accept both fields.
    if parent.kind_name() == "call"
        && parent
            .child_by_field_name("function")
            .is_some_and(|function| function.id() == node.id())
    {
        return true;
    }

    // A Ruby constant receiving a call (`Alpha.new(...)`) names the invoked API.
    if node.kind_name() == "constant"
        && parent.kind_name() == "call"
        && parent
            .child_by_field_name("receiver")
            .is_some_and(|receiver| receiver.id() == node.id())
    {
        return true;
    }

    if is_static_receiver_name(node, parent, code) || is_scoped_callee_name(node, parent) {
        return true;
    }

    // Go struct-literal keys (`Config{Timeout: ...}`) have no `key` field in the grammar.
    if parent.kind_name() == "literal_element"
        && parent.parent_node().is_some_and(|grandparent| {
            grandparent.kind_name() == "keyed_element"
                && grandparent
                    .named_child(0)
                    .is_some_and(|first| first.id() == parent.id())
        })
    {
        return true;
    }

    semantic_name_field_by_parent_type()
        .get(parent.kind_name())
        .is_some_and(|field| {
            parent
                .child_by_field_name(*field)
                .is_some_and(|child| child.id() == node.id())
        })
}

/// C# type positions (see CSHARP_TYPE_PARENT_TYPES, plus any parent's `type` field, e.g.
/// `new Foo()`) and attribute names (`[Obsolete]`, an `attribute` inside an `attribute_list`, or
/// `[assembly: Foo]` inside a `global_attribute`; C/C++ attributes hang off other parents and
/// Python's `attribute` has no `name` field).
fn is_csharp_semantic_name(node: Node<'_>, parent: Node<'_>) -> bool {
    let occupies = |field: &str| {
        parent
            .child_by_field_name(field)
            .is_some_and(|field_node| field_node.id() == node.id())
    };
    let is_csharp_attribute = parent.kind_name() == "attribute"
        && parent
            .parent_node()
            .is_some_and(|list| matches!(list.kind_name(), "attribute_list" | "global_attribute"));
    CSHARP_TYPE_PARENT_TYPES.contains(&parent.kind_name())
        || (occupies("type") && !NON_CSHARP_TYPE_FIELD_PARENT_TYPES.contains(&parent.kind_name()))
        || (is_csharp_attribute && occupies("name"))
}

/// Kotlin (no callee or member fields): a callee (`foo(...)`, whose call ends in Kotlin's own
/// argument nodes), a member name (`a.foo`), an infix function (`a shl b`), and a named
/// argument (`foo(name = x)`) are API names.
fn is_kotlin_semantic_name(node: Node<'_>, parent: Node<'_>) -> bool {
    let is_first_named = parent
        .named_child(0)
        .is_some_and(|first| first.id() == node.id());
    let last_named = parent.named_child(parent.named_child_count().saturating_sub(1) as u32);
    if parent.kind_name() == "navigation_expression" {
        return last_named.is_some_and(|last| last.id() == node.id()) && !is_first_named;
    }
    if parent.kind_name() == "call_expression" && is_first_named {
        return last_named.is_some_and(|arguments| {
            matches!(
                arguments.kind_name(),
                "value_arguments" | "annotated_lambda"
            )
        });
    }
    if parent.kind_name() == "infix_expression" {
        return parent
            .named_child(1)
            .is_some_and(|operator| operator.id() == node.id());
    }
    parent.kind_name() == "value_argument"
        && is_first_named
        && node
            .next_sibling()
            .is_some_and(|next| !next.is_named() && next.kind_name() == "=")
}

/// Java/C# static receivers (`Alpha.run(...)`, `Console.WriteLine(...)`) name the invoked type;
/// PascalCase is the discriminator because the tokenizer has no symbol table.
fn is_static_receiver_name(node: Node<'_>, parent: Node<'_>, code: &Source<'_>) -> bool {
    let is_receiver = match parent.kind_name() {
        "method_invocation" => parent
            .child_by_field_name("object")
            .is_some_and(|object| object.id() == node.id()),
        "member_access_expression" => parent
            .child_by_field_name("expression")
            .is_some_and(|receiver| receiver.id() == node.id()),
        // Kotlin has no fields: the receiver is the first child of `navigation_expression`.
        "navigation_expression" => parent
            .named_child(0)
            .is_some_and(|first| first.id() == node.id()),
        _ => false,
    };
    is_receiver && pascal_case_regex().is_match(node_text(node, code))
}

fn pascal_case_regex() -> &'static regex::Regex {
    static REGEX: OnceLock<regex::Regex> = OnceLock::new();
    REGEX.get_or_init(|| regex::Regex::new(r"^\p{Lu}").unwrap())
}

/// Qualified/generic callees are semantic in call position only.
fn is_scoped_callee_name(node: Node<'_>, parent: Node<'_>) -> bool {
    let is_scoped = matches!(
        parent.kind_name(),
        "scoped_identifier" | "qualified_identifier"
    ) && ["name", "path"].iter().any(|field| {
        parent
            .child_by_field_name(field)
            .is_some_and(|child| child.id() == node.id())
    });
    if !is_scoped {
        return false;
    }
    let mut outer = parent;
    while let Some(outer_parent) = outer.parent_node() {
        if matches!(
            outer_parent.kind_name(),
            "scoped_identifier" | "qualified_identifier" | "generic_function" | "template_function"
        ) {
            outer = outer_parent;
        } else {
            break;
        }
    }
    outer.parent_node().is_some_and(|call| {
        call.kind_name() == "call_expression"
            && call
                .child_by_field_name("function")
                .is_some_and(|function| function.id() == outer.id())
    })
}

fn semantic_name_field_by_parent_type() -> &'static FxHashMap<&'static str, &'static str> {
    static MAP: OnceLock<FxHashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| SEMANTIC_NAME_FIELD_BY_PARENT_TYPE.iter().copied().collect())
}

/// literal_count_prefix[i] = value-carrying literal tokens in tokens[0..i), for O(1) density checks.
fn build_literal_count_prefix(tokens: &[Token<'_>], prefix: &mut Vec<usize>) {
    prefix.clear();
    prefix.reserve(tokens.len() + 1);
    prefix.push(0);
    let mut count = 0;
    for token in tokens {
        count += usize::from(token.literal_hash.is_some());
        prefix.push(count);
    }
}

/// djb2-style hash over UTF-16 code units, matching hashText in duplication.ts exactly.
pub fn hash_text(text: &str) -> i32 {
    let mut hash: i32 = 5381;
    for unit in text.encode_utf16() {
        hash = hash.wrapping_mul(33) ^ (unit as i32);
    }
    hash
}

/// FNV-1a over UTF-16 code units, matching hashText2 in duplication.ts exactly.
pub(crate) fn hash_text2(text: &str) -> i32 {
    let mut hash: i32 = -2_128_831_035; // 2166136261 as int32 (the FNV-1a offset basis)
    for unit in text.encode_utf16() {
        hash = (hash ^ (unit as i32)).wrapping_mul(16_777_619);
    }
    hash
}
