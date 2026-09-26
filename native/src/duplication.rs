use indexmap::IndexMap;
use rustc_hash::{FxHashMap, FxHashSet};
use std::borrow::Cow;
use std::sync::OnceLock;
use tree_sitter::Node;

use crate::near_miss::{Block, Matcher, PairMatch, FILTRATION_PERCENT, MAX_LENGTH_RATIO};
use crate::tree_index::NodeExt;
use crate::types::{
    CrossFileCandidate, CrossFileToken, CrossFileTokenRange, DuplicateBlockOccurrence,
    DuplicationMetrics,
};
use crate::util::{all_children, is_identifier_leaf, named_children, node_text, to_int32, Source};

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
    "statements",
    "control_structure_body",
    "function_body",
    "jump_expression",
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
    "statements",
    "enum_class_body",
    "control_structure_body",
    "function_body",
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

/// Whole-subtree duplicate candidates: DUPLICATE_BLOCK_TYPES plus Kotlin's `try_expression`,
/// distinguished by its clause children from Rust's `try_expression` (the `?` operator).
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
    STATEMENT_CONTAINER_TYPES.contains(&node.kind_name())
}

/// Identifier leaves anonymized by occurrence order so consistently renamed copies still match.
const ANONYMIZED_IDENTIFIER_TYPES: &[&str] = &[
    "identifier",
    "simple_identifier",
    "interpolated_identifier",
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
    ("hex_literal", "#num"),
    ("bin_literal", "#num"),
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
    ("character_escape_seq", "#char"),
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

const COMMENT_TYPES: &[&str] = &[
    "comment",
    "line_comment",
    "block_comment",
    "multiline_comment",
];

/// Children of a string node that carry only literal content; anything else is interpolation.
const STRING_FRAGMENT_TYPES: &[&str] = &[
    "string_fragment",
    "multiline_string_fragment",
    "string_content",
    "string_literal_content",
    "character_literal_content",
    "character_escape_seq",
    "raw_string_content",
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
    "character_escape_seq",
    "raw_string_content",
    "escape_sequence",
    "heredoc_content",
];

const MIN_SEQUENCE_STATEMENT_COUNT: usize = 2;
const MAX_SEQUENCE_STATEMENT_COUNT: usize = 100;
const MAX_SELECTION_RERUN_COUNT: usize = 20;

/// Detection settings, defaulting to defaultDuplicationOptions in src/duplication.ts.
#[derive(Clone, Copy)]
pub struct DuplicationSettings {
    /// Minimum normalized token count for a region to be considered for duplication.
    pub min_tokens: usize,
    /// Maximum normalized-token gap between adjacent duplicate groups merged into one gapped clone.
    pub max_gap_tokens: usize,
    /// Minimum LCS similarity percent for near-miss (Type-3) clone blocks; 100 disables near-miss.
    pub min_similarity_percent: usize,
}

impl Default for DuplicationSettings {
    fn default() -> Self {
        DuplicationSettings {
            min_tokens: 40,
            max_gap_tokens: 30,
            min_similarity_percent: 70,
        }
    }
}
/// See isLiteralDense in duplication.ts: >= 20% literal values marks a region as data-like.
fn is_literal_dense(literal_count: usize, token_count: usize) -> bool {
    literal_count * 5 >= token_count
}

fn literal_kind_by_type() -> &'static FxHashMap<&'static str, &'static str> {
    static MAP: OnceLock<FxHashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| LITERAL_KIND_BY_TYPE.iter().copied().collect())
}

fn semantic_name_field_by_parent_type() -> &'static FxHashMap<&'static str, &'static str> {
    static MAP: OnceLock<FxHashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| SEMANTIC_NAME_FIELD_BY_PARENT_TYPE.iter().copied().collect())
}

fn pascal_case_regex() -> &'static regex::Regex {
    static REGEX: OnceLock<regex::Regex> = OnceLock::new();
    REGEX.get_or_init(|| regex::Regex::new(r"^\p{Lu}").unwrap())
}

struct Token<'a> {
    is_id: bool,
    text: Cow<'a, str>,
    /// Two independent hashes of `text` (djb2 and FNV-1a); see the Token doc in duplication.ts.
    text_hash: i32,
    text_hash2: i32,
    /// Hash pair of a value-carrying literal's value, folded into data-like region fingerprints.
    literal_hash: Option<i32>,
    literal_hash2: Option<i32>,
    /// True for verbatim-kept NAMES (named grammar leaves); see the Token doc in duplication.ts.
    is_name: bool,
    start_row: usize,
    end_row: usize,
}

struct TokenRange {
    start_token_index: usize,
    end_token_index: usize,
    start_index: usize,
    end_index: usize,
    start_line: usize,
    end_line: usize,
}

#[derive(Clone)]
struct DuplicateCandidate {
    fingerprint: std::rc::Rc<str>,
    token_count: usize,
    start_token_index: usize,
    end_token_index: usize,
    start_index: usize,
    end_index: usize,
    start_line: usize,
    end_line: usize,
}

/// A file's normalized token stream with the block and statement structure clone detection
/// matches over, built once per parse and shared by within-file and cross-file detection.
pub struct TokenizedSource<'a> {
    tokens: Vec<Token<'a>>,
    block_ranges: Vec<TokenRange>,
    container_statement_ranges: Vec<Vec<TokenRange>>,
    literal_count_prefix: Vec<usize>,
}

pub fn tokenize<'a>(root: Node<'_>, code: &Source<'a>) -> TokenizedSource<'a> {
    let mut tokens: Vec<Token<'a>> = Vec::new();
    let mut block_ranges: Vec<TokenRange> = Vec::new();
    let mut container_statement_ranges: Vec<Vec<TokenRange>> = Vec::new();
    collect_tokens(
        root,
        code,
        &mut tokens,
        &mut block_ranges,
        &mut container_statement_ranges,
    );
    let literal_count_prefix = build_literal_count_prefix(&tokens);
    TokenizedSource {
        tokens,
        block_ranges,
        container_statement_ranges,
        literal_count_prefix,
    }
}

/// Detects copy-pasted regions within a file. Fingerprints replicate the JavaScript int32 hash
/// arithmetic of fingerprintKey in duplication.ts, so its candidates group with the window
/// candidates cross-file matching fingerprints in TypeScript.
pub fn measure_duplication(
    source: &TokenizedSource<'_>,
    code_line_numbers: &FxHashSet<usize>,
    settings: &DuplicationSettings,
) -> DuplicationMetrics {
    let tokens = &source.tokens;
    let literal_count_prefix = &source.literal_count_prefix;
    let mut candidates = collect_block_candidates(
        tokens,
        literal_count_prefix,
        &source.block_ranges,
        settings.min_tokens,
    );
    candidates.extend(collect_sequence_candidates(
        tokens,
        literal_count_prefix,
        &source.container_statement_ranges,
        settings.min_tokens,
    ));
    let counted = select_maximal_duplicates(candidates);
    let mut groups = merge_adjacent_groups(to_counted_groups(&counted), settings.max_gap_tokens);
    let near_miss = collect_near_miss_groups(source, settings, &mut groups);
    // Near-miss clustering can merge exact groups away, leaving empty entries behind.
    groups.retain(|group| !group.is_empty());
    groups.extend(near_miss);
    summarize_duplicates(&groups, code_line_numbers, tokens)
}

/// Collects one file's contribution to cross-file clone detection: catalogued candidates (whole
/// block subtrees plus each statement container's full run), the normalized token stream and
/// statement structure, and the blocks near-miss comparison considers. Source indexes are emitted
/// in UTF-16 code units (the tree is parsed from UTF-16, so node byte offsets are halved) to match
/// JavaScript string indexes.
pub fn collect_cross_file_file_data(
    source: &TokenizedSource<'_>,
    min_tokens: usize,
) -> (
    Vec<CrossFileCandidate>,
    Vec<CrossFileToken>,
    Vec<Vec<CrossFileTokenRange>>,
    Vec<CrossFileTokenRange>,
) {
    let tokens = &source.tokens;
    let literal_count_prefix = &source.literal_count_prefix;
    let mut candidates = collect_block_candidates(
        tokens,
        literal_count_prefix,
        &source.block_ranges,
        min_tokens,
    );
    // Single-statement containers are catalogued too: a file whose only top-level statement is not
    // a block type (a lone exported table) must still be matchable when wholly copied.
    for statements in &source.container_statement_ranges {
        let (Some(first), Some(last)) = (statements.first(), statements.last()) else {
            continue;
        };
        let token_count = last.end_token_index - first.start_token_index;
        if token_count < min_tokens {
            continue;
        }
        let fingerprint = format!(
            "s:{}",
            fingerprint_key(
                tokens,
                literal_count_prefix,
                first.start_token_index,
                last.end_token_index
            )
        );
        candidates.push(to_candidate(
            fingerprint,
            first.start_token_index,
            last.end_token_index,
            first,
            last,
        ));
    }

    let candidate_payloads = dedupe_by_region(candidates)
        .into_iter()
        .map(|candidate| CrossFileCandidate {
            fingerprint: candidate.fingerprint.to_string(),
            token_count: candidate.token_count,
            start_token_index: candidate.start_token_index,
            end_token_index: candidate.end_token_index,
            start_index: candidate.start_index / 2,
            end_index: candidate.end_index / 2,
            start_line: candidate.start_line,
            end_line: candidate.end_line,
        })
        .collect();
    let token_payloads = tokens
        .iter()
        .map(|token| CrossFileToken {
            kind: if token.is_id { "id" } else { "text" },
            text: token.text.to_string(),
            text_hash: token.text_hash,
            text_hash2: token.text_hash2,
            literal_hash: token.literal_hash,
            literal_hash2: token.literal_hash2,
            is_name: token.is_name,
            start_row: token.start_row,
            end_row: token.end_row,
        })
        .collect();
    let container_statement_payloads = source
        .container_statement_ranges
        .iter()
        .map(|statements| statements.iter().map(to_token_range_payload).collect())
        .collect();
    let near_miss_block_payloads = select_near_miss_blocks(source, min_tokens)
        .into_iter()
        .map(to_token_range_payload)
        .collect();
    (
        candidate_payloads,
        token_payloads,
        container_statement_payloads,
        near_miss_block_payloads,
    )
}

fn to_token_range_payload(range: &TokenRange) -> CrossFileTokenRange {
    CrossFileTokenRange {
        start_token_index: range.start_token_index,
        end_token_index: range.end_token_index,
        start_index: range.start_index / 2,
        end_index: range.end_index / 2,
        start_line: range.start_line,
        end_line: range.end_line,
    }
}

fn collect_tokens<'a>(
    root: Node<'_>,
    code: &Source<'a>,
    tokens: &mut Vec<Token<'a>>,
    block_ranges: &mut Vec<TokenRange>,
    container_statement_ranges: &mut Vec<Vec<TokenRange>>,
) {
    fn visit<'a>(
        node: Node<'_>,
        code: &Source<'a>,
        tokens: &mut Vec<Token<'a>>,
        block_ranges: &mut Vec<TokenRange>,
        container_statement_ranges: &mut Vec<Vec<TokenRange>>,
    ) -> TokenRange {
        let start_token_index = tokens.len();
        let atomic_kind = if is_identifier_leaf(node) {
            None
        } else {
            atomic_literal_kind(node)
        };
        if is_identifier_leaf(node) {
            append_leaf_token(node, code, tokens);
        } else if let Some(atomic_kind) = atomic_kind {
            // Interpolation-free strings collapse to their kind tag so copies differing only in
            // quote style or content still match.
            tokens.push(make_text_token(
                Cow::Borrowed(atomic_kind),
                Some(literal_value_text(node, atomic_kind, code)),
                false,
                node.start_position().row,
                node.end_position().row,
            ));
        } else if !COMMENT_TYPES.contains(&node.kind_name()) {
            let mut statement_ranges: Vec<TokenRange> = Vec::new();
            let is_container = is_statement_container(node);
            for child in all_children(node) {
                let child_range = visit(
                    child,
                    code,
                    tokens,
                    block_ranges,
                    container_statement_ranges,
                );
                if is_container && child.is_named() && !COMMENT_TYPES.contains(&child.kind_name()) {
                    statement_ranges.push(child_range);
                }
            }
            // Single-statement containers are recorded too: window enumeration needs two
            // statements and yields nothing for them, but cross-file matching catalogues each
            // container's full run.
            if is_container && !statement_ranges.is_empty() {
                container_statement_ranges.push(statement_ranges);
            }
        }

        let range = TokenRange {
            start_token_index,
            end_token_index: tokens.len(),
            start_index: node.start_byte(),
            end_index: node.end_byte(),
            start_line: node.start_position().row + 1,
            end_line: node.end_position().row + 1,
        };
        if is_duplicate_block(node) {
            block_ranges.push(TokenRange { ..range });
        }
        range
    }

    visit(root, code, tokens, block_ranges, container_statement_ranges);
}

/// The kind tag of a string-like node with no interpolation, or None to descend normally.
fn atomic_literal_kind(node: Node<'_>) -> Option<&'static str> {
    let kind = if node.is_named() {
        literal_kind_by_type().get(node.kind_name()).copied()
    } else {
        None
    };
    let kind = kind?;
    if named_children(node)
        .iter()
        .all(|child| STRING_FRAGMENT_TYPES.contains(&child.kind_name()))
    {
        Some(kind)
    } else {
        None
    }
}

fn append_leaf_token<'a>(node: Node<'_>, code: &Source<'a>, tokens: &mut Vec<Token<'a>>) {
    if COMMENT_TYPES.contains(&node.kind_name()) {
        return;
    }

    let start_row = node.start_position().row;
    let end_row = node.end_position().row;
    if node.is_named() && SHORTHAND_PROPERTY_TYPES.contains(&node.kind_name()) {
        let text = node_text(node, code);
        tokens.push(make_text_token(
            Cow::Borrowed(text),
            None,
            true,
            start_row,
            end_row,
        ));
        tokens.push(make_text_token(
            Cow::Borrowed(":"),
            None,
            false,
            start_row,
            end_row,
        ));
        tokens.push(Token {
            is_id: true,
            text: Cow::Borrowed(text),
            text_hash: 0,
            text_hash2: 0,
            literal_hash: None,
            literal_hash2: None,
            is_name: false,
            start_row,
            end_row,
        });
        return;
    }

    // A Kotlin bound callable-reference receiver (`xs::size`) renames like a variable unless it is
    // PascalCase, the discriminator used for static receivers everywhere else.
    let is_variable_receiver = crate::util::is_kotlin_callable_receiver(node)
        && !pascal_case_regex().is_match(node_text(node, code));
    if node.is_named()
        && (is_variable_receiver
            || (ANONYMIZED_IDENTIFIER_TYPES.contains(&node.kind_name())
                && !is_semantic_name_leaf(node, code)))
    {
        tokens.push(Token {
            is_id: true,
            text: Cow::Borrowed(node_text(node, code)),
            text_hash: 0,
            text_hash2: 0,
            literal_hash: None,
            literal_hash2: None,
            is_name: false,
            start_row,
            end_row,
        });
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
            Cow::Borrowed(kind),
            Some(literal_value_text(node, kind, code)),
            false,
            start_row,
            end_row,
        ),
        None => make_text_token(
            Cow::Borrowed(node_text(node, code)),
            None,
            node.is_named(),
            start_row,
            end_row,
        ),
    });
}

fn make_text_token<'a>(
    text: Cow<'a, str>,
    literal_value_text: Option<Cow<'a, str>>,
    is_name: bool,
    start_row: usize,
    end_row: usize,
) -> Token<'a> {
    let text_hash = hash_text(&text);
    let text_hash2 = hash_text2(&text);
    let (literal_hash, literal_hash2) = match literal_value_text {
        Some(value) if VALUE_CARRYING_LITERAL_KINDS.contains(&text.as_ref()) => {
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

/// literal_count_prefix[i] = value-carrying literal tokens in tokens[0..i), for O(1) density checks.
fn build_literal_count_prefix(tokens: &[Token<'_>]) -> Vec<usize> {
    let mut prefix = vec![0usize; tokens.len() + 1];
    for (index, token) in tokens.iter().enumerate() {
        prefix[index + 1] = prefix[index] + usize::from(token.literal_hash.is_some());
    }
    prefix
}

fn is_semantic_name_leaf(node: Node<'_>, code: &Source<'_>) -> bool {
    let Some(parent) = node.parent_node() else {
        return false;
    };

    // Java method references (`Foo::bar`) and Kotlin callable references (`::bar`) name their
    // identifiers without grammar fields.
    if parent.kind_name() == "method_reference" || parent.kind_name() == "callable_reference" {
        return true;
    }

    // C# type positions (see CSHARP_TYPE_PARENT_TYPES, plus any parent's `type` field, e.g.
    // `new Foo()`) and attribute names (`[Obsolete]`, an `attribute` inside an `attribute_list`, or
    // `[assembly: Foo]` inside a `global_attribute`; C/C++ attributes hang off other parents and
    // Python's `attribute` has no `name` field).
    if node.kind_name() == "identifier" {
        let occupies = |field: &str| {
            parent
                .child_by_field_name(field)
                .is_some_and(|field_node| field_node.id() == node.id())
        };
        let is_csharp_attribute = parent.kind_name() == "attribute"
            && parent.parent_node().is_some_and(|list| {
                matches!(list.kind_name(), "attribute_list" | "global_attribute")
            });
        if CSHARP_TYPE_PARENT_TYPES.contains(&parent.kind_name())
            || (occupies("type")
                && !NON_CSHARP_TYPE_FIELD_PARENT_TYPES.contains(&parent.kind_name()))
            || (is_csharp_attribute && occupies("name"))
        {
            return true;
        }
    }

    // Kotlin (no grammar fields): a callee (`foo(...)`), a member name (`a.foo`), an infix function
    // (`a shl b`), and a named argument (`foo(name = x)`) are API names.
    if node.kind_name() == "simple_identifier" {
        if parent.kind_name() == "navigation_suffix" {
            return true;
        }
        let is_first_named = parent
            .named_child(0)
            .is_some_and(|first| first.id() == node.id());
        if parent.kind_name() == "call_expression" && is_first_named {
            return true;
        }
        if parent.kind_name() == "infix_expression"
            && parent
                .named_child(1)
                .is_some_and(|operator| operator.id() == node.id())
        {
            return true;
        }
        if parent.kind_name() == "value_argument"
            && is_first_named
            && node
                .next_sibling()
                .is_some_and(|next| !next.is_named() && next.kind_name() == "=")
        {
            return true;
        }
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

    // Java/C# static receivers (`Alpha.run(...)`, `Console.WriteLine(...)`) name the invoked type;
    // PascalCase is the discriminator because the tokenizer has no symbol table.
    let is_static_receiver = match parent.kind_name() {
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
    if is_static_receiver && pascal_case_regex().is_match(node_text(node, code)) {
        return true;
    }

    // Qualified/generic callees are semantic in call position only.
    if (parent.kind_name() == "scoped_identifier" || parent.kind_name() == "qualified_identifier")
        && (parent
            .child_by_field_name("name")
            .is_some_and(|name| name.id() == node.id())
            || parent
                .child_by_field_name("path")
                .is_some_and(|path| path.id() == node.id()))
    {
        let mut outer = parent;
        while let Some(outer_parent) = outer.parent_node() {
            if matches!(
                outer_parent.kind_name(),
                "scoped_identifier"
                    | "qualified_identifier"
                    | "generic_function"
                    | "template_function"
            ) {
                outer = outer_parent;
            } else {
                break;
            }
        }
        if outer.parent_node().is_some_and(|call| {
            call.kind_name() == "call_expression"
                && call
                    .child_by_field_name("function")
                    .is_some_and(|function| function.id() == outer.id())
        }) {
            return true;
        }
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

fn collect_block_candidates(
    tokens: &[Token<'_>],
    literal_count_prefix: &[usize],
    block_ranges: &[TokenRange],
    min_tokens: usize,
) -> Vec<DuplicateCandidate> {
    let mut candidates = Vec::new();
    for range in block_ranges {
        let token_count = range.end_token_index - range.start_token_index;
        if token_count < min_tokens {
            continue;
        }
        let fingerprint = format!(
            "b:{}",
            fingerprint_key(
                tokens,
                literal_count_prefix,
                range.start_token_index,
                range.end_token_index
            )
        );
        candidates.push(to_candidate(
            fingerprint,
            range.start_token_index,
            range.end_token_index,
            range,
            range,
        ));
    }
    candidates
}

struct WindowOccurrences {
    count: usize,
    /// usize::MAX once occurrences span more than one container (the TS port uses -1).
    container_index: usize,
    min_start: usize,
    max_start: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct SequenceWindow {
    container_index: usize,
    start: usize,
    length: usize,
}

struct ContainerWindows {
    /// window_keys_by_start[start][length] is the rolling-hash key, None below the size thresholds.
    window_keys_by_start: Vec<Vec<Option<i64>>>,
    /// Per-statement fingerprint hashes, for the distinct-shape requirement on windows.
    statement_hashes: Vec<i32>,
}

/// Enumerates runs of consecutive sibling statements; see collectSequenceWindowCandidates in
/// duplication.ts for the maximality and sub-window rules replicated here.
fn collect_sequence_candidates(
    tokens: &[Token<'_>],
    literal_count_prefix: &[usize],
    containers: &[Vec<TokenRange>],
    min_tokens: usize,
) -> Vec<DuplicateCandidate> {
    let mut candidates = Vec::new();
    let mut occurrences_by_window_key: FxHashMap<i64, WindowOccurrences> = FxHashMap::default();
    let container_windows: Vec<ContainerWindows> = containers
        .iter()
        .map(|statements| enumerate_container_windows(tokens, statements, min_tokens))
        .collect();
    for (container_index, windows) in container_windows.iter().enumerate() {
        for (start, row) in windows.window_keys_by_start.iter().enumerate() {
            for window_key in row.iter().flatten() {
                match occurrences_by_window_key.get_mut(window_key) {
                    Some(occurrences) => {
                        occurrences.count += 1;
                        if occurrences.container_index != container_index {
                            occurrences.container_index = usize::MAX;
                        }
                        occurrences.min_start = occurrences.min_start.min(start);
                        occurrences.max_start = occurrences.max_start.max(start);
                    }
                    None => {
                        occurrences_by_window_key.insert(
                            *window_key,
                            WindowOccurrences {
                                count: 1,
                                container_index,
                                min_start: start,
                                max_start: start,
                            },
                        );
                    }
                }
            }
        }
    }

    // A window only "repeats" when two of its occurrences can coexist without overlapping.
    let repeats = |window_key: Option<i64>, length: usize| -> bool {
        let Some(window_key) = window_key else {
            return false;
        };
        occurrences_by_window_key
            .get(&window_key)
            .is_some_and(|occurrences| {
                occurrences.count >= 2
                    && (occurrences.container_index == usize::MAX
                        || occurrences.max_start - occurrences.min_start >= length)
            })
    };

    // A window whose statements all share one normalized shape is a homogeneous preamble, not a
    // copy-paste: two distinct per-statement shapes are required.
    let has_distinct_statements = |window: SequenceWindow| -> bool {
        let hashes = container_windows
            .get(window.container_index)
            .map(|windows| windows.statement_hashes.as_slice())
            .unwrap_or(&[]);
        let first_hash = hashes.get(window.start);
        for index in window.start + 1..window.start + window.length {
            if hashes.get(index) != first_hash {
                return true;
            }
        }
        false
    };

    let window_key_at =
        |container_index: usize, start: Option<usize>, length: usize| -> Option<i64> {
            let start = start?;
            container_windows
                .get(container_index)?
                .window_keys_by_start
                .get(start)?
                .get(length)
                .copied()
                .flatten()
        };

    let mut maximal_windows: Vec<SequenceWindow> = Vec::new();
    for (container_index, windows) in container_windows.iter().enumerate() {
        for (start, row) in windows.window_keys_by_start.iter().enumerate() {
            for (length, window_key) in row.iter().enumerate() {
                if !repeats(*window_key, length)
                    || !has_distinct_statements(SequenceWindow {
                        container_index,
                        start,
                        length,
                    })
                {
                    continue;
                }
                // Dominated windows are skipped: the one-statement extension also repeats.
                let extended_right = window_key_at(container_index, Some(start), length + 1);
                let extended_left =
                    window_key_at(container_index, start.checked_sub(1), length + 1);
                if repeats(extended_right, length + 1) || repeats(extended_left, length + 1) {
                    continue;
                }
                maximal_windows.push(SequenceWindow {
                    container_index,
                    start,
                    length,
                });
            }
        }
    }

    // Every emitted window exposes its repeating, unvisited sub-windows; lengths strictly
    // decrease, so the worklist terminates.
    let mut visited: FxHashSet<SequenceWindow> = maximal_windows.iter().copied().collect();
    let mut frontier = maximal_windows;
    while !frontier.is_empty() {
        let mut emitted: Vec<SequenceWindow> = Vec::new();
        for window in &frontier {
            let statements = containers.get(window.container_index);
            let first = statements.and_then(|statements| statements.get(window.start));
            let last =
                statements.and_then(|statements| statements.get(window.start + window.length - 1));
            let (Some(first), Some(last)) = (first, last) else {
                continue;
            };
            let fingerprint = format!(
                "s:{}",
                fingerprint_key(
                    tokens,
                    literal_count_prefix,
                    first.start_token_index,
                    last.end_token_index
                )
            );
            candidates.push(to_candidate(
                fingerprint,
                first.start_token_index,
                last.end_token_index,
                first,
                last,
            ));
            emitted.push(*window);
        }
        frontier = Vec::new();
        for window in emitted {
            for start in [window.start, window.start + 1] {
                let sub_window = SequenceWindow {
                    container_index: window.container_index,
                    start,
                    length: window.length - 1,
                };
                let sub_window_key =
                    window_key_at(window.container_index, Some(start), sub_window.length);
                if visited.contains(&sub_window)
                    || !repeats(sub_window_key, sub_window.length)
                    || !has_distinct_statements(sub_window)
                {
                    continue;
                }
                visited.insert(sub_window);
                frontier.push(sub_window);
            }
        }
    }
    candidates
}

fn enumerate_container_windows(
    tokens: &[Token<'_>],
    statements: &[TokenRange],
    min_tokens: usize,
) -> ContainerWindows {
    let statement_hashes: Vec<i32> = statements
        .iter()
        .map(|statement| {
            fingerprint_hash(
                tokens,
                statement.start_token_index,
                statement.end_token_index,
            )
        })
        .collect();
    let mut window_keys_by_start: Vec<Vec<Option<i64>>> = Vec::new();
    for start in 0..statements.len() {
        let mut row: Vec<Option<i64>> = Vec::new();
        let mut hash: i64 = 5381;
        let mut token_count: usize = 0;
        let max_end = statements.len().min(start + MAX_SEQUENCE_STATEMENT_COUNT);
        for end in start..max_end {
            let statement = &statements[end];
            let statement_hash = statement_hashes[end];
            hash = combine_hashes(hash, statement_hash as i64);
            token_count += statement.end_token_index - statement.start_token_index;
            let statement_count = end - start + 1;
            let key =
                if statement_count >= MIN_SEQUENCE_STATEMENT_COUNT && token_count >= min_tokens {
                    Some(combine_hashes(hash, statement_count as i64))
                } else {
                    None
                };
            if row.len() <= statement_count {
                row.resize(statement_count + 1, None);
            }
            row[statement_count] = key;
        }
        window_keys_by_start.push(row);
    }
    ContainerWindows {
        window_keys_by_start,
        statement_hashes,
    }
}

fn to_candidate(
    fingerprint: String,
    start_token_index: usize,
    end_token_index: usize,
    first: &TokenRange,
    last: &TokenRange,
) -> DuplicateCandidate {
    DuplicateCandidate {
        fingerprint: fingerprint.into(),
        token_count: end_token_index - start_token_index,
        start_token_index,
        end_token_index,
        start_index: first.start_index,
        end_index: last.end_index,
        start_line: first.start_line,
        end_line: last.end_line,
    }
}

/// Content key of a token range; see fingerprintKey in duplication.ts for the format and rationale.
fn fingerprint_key(
    tokens: &[Token<'_>],
    literal_count_prefix: &[usize],
    start_token_index: usize,
    end_token_index: usize,
) -> String {
    let clamped_end = end_token_index.min(tokens.len());
    let literal_count = literal_count_prefix.get(clamped_end).copied().unwrap_or(0)
        - literal_count_prefix
            .get(start_token_index)
            .copied()
            .unwrap_or(0);
    let literal_dense = is_literal_dense(literal_count, end_token_index - start_token_index);
    let (primary, secondary) =
        fingerprint_hash_pair(tokens, start_token_index, end_token_index, literal_dense);
    format!(
        "{primary}:{secondary}:{}",
        end_token_index - start_token_index
    )
}

/// A single 32-bit summary of a range for the coarse rolling-hash phase. Deliberately
/// density-agnostic; see fingerprintHash in duplication.ts for the rationale.
fn fingerprint_hash(tokens: &[Token<'_>], start_token_index: usize, end_token_index: usize) -> i32 {
    let (primary, secondary) =
        fingerprint_hash_pair(tokens, start_token_index, end_token_index, false);
    primary ^ secondary.wrapping_mul(31)
}

/// Two independent 32-bit hashes over the normalized token sequence, replicating the JavaScript
/// int32 arithmetic of fingerprintHashPair in duplication.ts exactly.
fn fingerprint_hash_pair(
    tokens: &[Token<'_>],
    start_token_index: usize,
    end_token_index: usize,
    fold_literal_values: bool,
) -> (i32, i32) {
    let clamped_end = end_token_index.min(tokens.len());
    let mut index_by_identifier: FxHashMap<&str, usize> = FxHashMap::default();
    let mut index_hashes: Vec<(i32, i32)> = Vec::new();
    let mut primary: i32 = 5381;
    let mut secondary: i32 = 52_711;
    for token in &tokens[start_token_index..clamped_end] {
        // Each accumulator consumes its own independent per-token hash; see fingerprintHashPair
        // in duplication.ts.
        let (part, part2) = if token.is_id {
            let next_index = index_by_identifier.len();
            let identifier_index = *index_by_identifier
                .entry(token.text.as_ref())
                .or_insert(next_index);
            if identifier_index == index_hashes.len() {
                let name = format!("${identifier_index}");
                index_hashes.push((hash_text(&name), hash_text2(&name)));
            }
            index_hashes[identifier_index]
        } else {
            (token.text_hash, token.text_hash2)
        };
        primary = primary.wrapping_mul(31).wrapping_add(part);
        secondary = secondary.wrapping_mul(37) ^ part2;
        if fold_literal_values {
            if let (Some(literal_hash), Some(literal_hash2)) =
                (token.literal_hash, token.literal_hash2)
            {
                primary = primary.wrapping_mul(31).wrapping_add(literal_hash);
                secondary = secondary.wrapping_mul(37) ^ literal_hash2;
            }
        }
    }
    (primary, secondary)
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
fn hash_text2(text: &str) -> i32 {
    let mut hash: i32 = -2_128_831_035; // 2166136261 as int32 (the FNV-1a offset basis)
    for unit in text.encode_utf16() {
        hash = (hash ^ (unit as i32)).wrapping_mul(16_777_619);
    }
    hash
}

/// `Math.imul(hash, 31) + value`: the sum is NOT wrapped to int32 in JS, so it stays i64 here.
fn combine_hashes(hash: i64, value: i64) -> i64 {
    (to_int32(hash).wrapping_mul(31)) as i64 + value
}

/// Keeps only maximal, non-overlapping duplicates; see selectMaximalGroups in duplicateSelection.ts.
fn select_maximal_duplicates(
    candidates: Vec<DuplicateCandidate>,
) -> IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>> {
    let mut by_fingerprint: IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>> = IndexMap::new();
    for candidate in candidates {
        by_fingerprint
            .entry(candidate.fingerprint.clone())
            .or_default()
            .push(candidate);
    }

    let groups: Vec<Vec<DuplicateCandidate>> = by_fingerprint
        .into_values()
        .map(dedupe_by_region)
        .filter(|group| group.len() >= 2)
        .collect();
    // Greedy order ranks by total coverage (region size × copies).
    let group_size_by_fingerprint: FxHashMap<std::rc::Rc<str>, usize> = groups
        .iter()
        .map(|group| {
            (
                group
                    .first()
                    .map(|first| first.fingerprint.clone())
                    .unwrap_or_else(|| std::rc::Rc::from("")),
                group.len(),
            )
        })
        .collect();
    let coverage = |candidate: &DuplicateCandidate| -> usize {
        candidate.token_count
            * group_size_by_fingerprint
                .get(&candidate.fingerprint)
                .copied()
                .unwrap_or(1)
    };
    let mut duplicates: Vec<DuplicateCandidate> = groups.into_iter().flatten().collect();
    duplicates.sort_by_key(|candidate| std::cmp::Reverse(coverage(candidate)));

    // Greedy selection can keep a candidate whose group ends up below two survivors; the largest
    // failed group is removed and the selection reruns, one group at a time.
    let mut rerun = 0;
    loop {
        let mut kept_regions: Vec<(usize, usize)> = Vec::new();
        let mut counted: IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>> = IndexMap::new();
        for candidate in &duplicates {
            if kept_regions
                .iter()
                .any(|region| region.0 < candidate.end_index && candidate.start_index < region.1)
            {
                continue;
            }
            kept_regions.push((candidate.start_index, candidate.end_index));
            counted
                .entry(candidate.fingerprint.clone())
                .or_default()
                .push(candidate.clone());
        }

        let mut failed_fingerprint: Option<std::rc::Rc<str>> = None;
        let mut failed_token_count: i64 = -1;
        for (fingerprint, group) in &counted {
            let token_count = group
                .first()
                .map(|first| first.token_count as i64)
                .unwrap_or(0);
            if group.len() < 2 && token_count > failed_token_count {
                failed_fingerprint = Some(fingerprint.clone());
                failed_token_count = token_count;
            }
        }
        // No failed fingerprint means every counted group kept at least two survivors.
        let Some(failed_fingerprint) = failed_fingerprint else {
            return counted;
        };
        if rerun >= MAX_SELECTION_RERUN_COUNT {
            counted.retain(|_, group| group.len() >= 2);
            return counted;
        }

        duplicates.retain(|candidate| candidate.fingerprint != failed_fingerprint);
        rerun += 1;
    }
}

/// Drops candidates covering the same source region (a block and the statement run spanning it).
fn dedupe_by_region(group: Vec<DuplicateCandidate>) -> Vec<DuplicateCandidate> {
    let mut by_region: IndexMap<(usize, usize), DuplicateCandidate> = IndexMap::new();
    for candidate in group {
        let key = (candidate.start_index, candidate.end_index);
        match by_region.get(&key) {
            Some(existing) if candidate.token_count <= existing.token_count => {}
            _ => {
                by_region.insert(key, candidate);
            }
        }
    }
    by_region.into_values().collect()
}

/// A contiguous run of matched tokens; gapped (merged) duplicates carry several per occurrence.
#[derive(Clone)]
struct CountedOccurrence {
    segments: Vec<(usize, usize)>,
    /// Set on a retained group's occurrences that a partial gapped merge also paired into a
    /// merged group: their spans are counted there, so block counting must not count them again.
    shared_with_merged_group: bool,
    /// Sum of segment token counts (the gap tokens are not matched content).
    token_count: usize,
    start_token_index: usize,
    end_token_index: usize,
    start_line: usize,
    end_line: usize,
}

fn to_counted_groups(
    counted: &IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>>,
) -> Vec<Vec<CountedOccurrence>> {
    let mut groups: Vec<Vec<CountedOccurrence>> = Vec::new();
    for group in counted.values() {
        let mut occurrences: Vec<CountedOccurrence> = group
            .iter()
            .map(|candidate| CountedOccurrence {
                shared_with_merged_group: false,
                segments: vec![(candidate.start_token_index, candidate.end_token_index)],
                token_count: candidate.token_count,
                start_token_index: candidate.start_token_index,
                end_token_index: candidate.end_token_index,
                start_line: candidate.start_line,
                end_line: candidate.end_line,
            })
            .collect();
        occurrences
            .sort_by_key(|occurrence| (occurrence.start_token_index, occurrence.end_token_index));
        groups.push(occurrences);
    }
    groups
}

/// Merges duplicate groups separated by a small token gap into one gapped (Type-3) clone group;
/// see mergeAdjacentGroups in duplication.ts for the pairing, partial-merge (unequal
/// cardinalities: the fully-paired group is subsumed, the other is retained with all its
/// occurrences), and fixpoint/termination rules replicated here.
fn merge_adjacent_groups(
    mut groups: Vec<Vec<CountedOccurrence>>,
    max_gap_tokens: usize,
) -> Vec<Vec<CountedOccurrence>> {
    if max_gap_tokens == 0 || groups.len() < 2 {
        return groups;
    }
    groups.sort_by_key(|group| group_sort_key(group));
    let mut restart = true;
    while restart {
        restart = false;
        let partners_by_group = collect_gap_adjacent_partners(&groups, max_gap_tokens);
        'outer: for (left_index, partners) in partners_by_group.iter().enumerate() {
            for &right_index in partners {
                let forward =
                    merge_groups(&groups[left_index], &groups[right_index], max_gap_tokens);
                let swapped = forward.is_none();
                let result = forward.or_else(|| {
                    merge_groups(&groups[right_index], &groups[left_index], max_gap_tokens)
                });
                let Some(result) = result else {
                    continue;
                };
                let (left_consumed, right_consumed) = if swapped {
                    (result.second_consumed, result.first_consumed)
                } else {
                    (result.first_consumed, result.second_consumed)
                };
                // A partial merge retains the not-fully-consumed group with ALL its occurrences,
                // so its paired occurrences now also live inside the merged group's occurrences:
                // mark them so duplicate_block_count counts each token span once.
                if left_consumed && right_consumed {
                    groups[left_index] = result.merged;
                    groups.remove(right_index);
                } else if right_consumed {
                    groups[right_index] = result.merged;
                    for &occurrence_index in &result.paired_retained_indexes {
                        groups[left_index][occurrence_index].shared_with_merged_group = true;
                    }
                } else {
                    groups[left_index] = result.merged;
                    for &occurrence_index in &result.paired_retained_indexes {
                        groups[right_index][occurrence_index].shared_with_merged_group = true;
                    }
                }
                groups.sort_by_key(|group| group_sort_key(group));
                restart = true;
                break 'outer;
            }
        }
    }
    groups
}

/// Per group index, the ascending indexes of later groups that merge_groups can pair with it;
/// see collectGapAdjacentPartners in duplication.ts.
fn collect_gap_adjacent_partners(
    groups: &[Vec<CountedOccurrence>],
    max_gap_tokens: usize,
) -> Vec<Vec<usize>> {
    let mut starts: Vec<(usize, usize)> = groups
        .iter()
        .enumerate()
        .flat_map(|(group_index, group)| {
            group
                .iter()
                .map(move |occurrence| (occurrence.start_token_index, group_index))
        })
        .collect();
    starts.sort_unstable();
    let mut partners: Vec<std::collections::BTreeSet<usize>> =
        vec![std::collections::BTreeSet::new(); groups.len()];
    for (group_index, group) in groups.iter().enumerate() {
        for occurrence in group {
            let first = starts.partition_point(|&(start, _)| start < occurrence.end_token_index);
            for &(start, other) in &starts[first..] {
                if start > occurrence.end_token_index + max_gap_tokens {
                    break;
                }
                if other != group_index {
                    partners[other.min(group_index)].insert(other.max(group_index));
                }
            }
        }
    }
    partners
        .into_iter()
        .map(|set| set.into_iter().collect())
        .collect()
}

fn group_sort_key(group: &[CountedOccurrence]) -> (usize, usize) {
    group
        .first()
        .map(|first| (first.start_token_index, first.end_token_index))
        .unwrap_or((0, 0))
}

struct MergeResult {
    merged: Vec<CountedOccurrence>,
    /// Whether every occurrence of the respective input group was paired into the merge.
    first_consumed: bool,
    second_consumed: bool,
    /// Indexes (into the retained, not fully consumed group) of the occurrences that were paired.
    paired_retained_indexes: Vec<usize>,
}

/// Pairs `second` occurrences with gap-preceding `first` occurrences, greedily in source order;
/// a faithful port of mergeGroups in duplication.ts (at least two pairs, at least one group fully
/// consumed, merged spans never overlap).
fn merge_groups(
    first: &[CountedOccurrence],
    second: &[CountedOccurrence],
    max_gap_tokens: usize,
) -> Option<MergeResult> {
    // Occurrences a previous partial merge already paired into a merged group must not pair
    // again: their spans already live inside that merged group, so re-pairing them would assemble
    // a second, competing merged group instead of letting the existing merged group extend (and
    // would count the same span twice). Consumption is still judged against the FULL group, so a
    // group holding shared occurrences is never subsumed away.
    let leadings: Vec<usize> = (0..first.len())
        .filter(|&index| !first[index].shared_with_merged_group)
        .collect();
    let trailings: Vec<usize> = (0..second.len())
        .filter(|&index| !second[index].shared_with_merged_group)
        .collect();
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut leading_position = 0usize;
    let mut previous_trailing_end: Option<usize> = None;
    for &trailing_index in &trailings {
        let trailing = &second[trailing_index];
        // Leadings ending too far before this trailing can never pair a later (even farther) one.
        while leading_position < leadings.len()
            && first[leadings[leading_position]].end_token_index + max_gap_tokens
                < trailing.start_token_index
        {
            leading_position += 1;
        }
        if let Some(&leading_index) = leadings.get(leading_position) {
            let leading = &first[leading_index];
            if leading.end_token_index <= trailing.start_token_index
                && previous_trailing_end.is_none_or(|end| leading.start_token_index >= end)
            {
                pairs.push((leading_index, trailing_index));
                previous_trailing_end = Some(trailing.end_token_index);
                leading_position += 1;
            }
        }
    }
    let first_consumed = pairs.len() == first.len();
    let second_consumed = pairs.len() == second.len();
    if pairs.len() < 2 || (!first_consumed && !second_consumed) {
        return None;
    }
    let paired_retained_indexes: Vec<usize> = if first_consumed == second_consumed {
        Vec::new()
    } else if first_consumed {
        pairs.iter().map(|&(_, trailing)| trailing).collect()
    } else {
        pairs.iter().map(|&(leading, _)| leading).collect()
    };
    let merged = pairs
        .iter()
        .map(|&(leading_index, trailing_index)| {
            let leading = &first[leading_index];
            let trailing = &second[trailing_index];
            CountedOccurrence {
                // A merged occurrence is a fresh span combination; it inherits no shared marks.
                shared_with_merged_group: false,
                segments: [leading.segments.clone(), trailing.segments.clone()].concat(),
                token_count: leading.token_count + trailing.token_count,
                start_token_index: leading.start_token_index,
                end_token_index: trailing.end_token_index,
                start_line: leading.start_line,
                end_line: trailing.end_line,
            }
        })
        .collect();
    Some(MergeResult {
        merged,
        first_consumed,
        second_consumed,
        paired_retained_indexes,
    })
}

/// A verified near-miss pair as (block, core, block, core); a `None` core is a whole-block match.
type MatchEdge = (usize, Option<(usize, usize)>, usize, Option<(usize, usize)>);

/// Detects near-miss (Type-3) clone groups among block candidates the exact pipeline left
/// unreported: NIL-style n-gram filtration, then pair verification (near_miss::Matcher), then
/// transitive clustering of verified pairs (crossFileNearMiss.ts applies the same model across
/// files). A block that matched only locally is reported as its matched cores (overlapping cores
/// merged), each clustered with its own partners, so code no verified pair matched never counts
/// as duplicated.
fn collect_near_miss_groups(
    source: &TokenizedSource<'_>,
    settings: &DuplicationSettings,
    reported_groups: &mut [Vec<CountedOccurrence>],
) -> Vec<Vec<CountedOccurrence>> {
    if settings.min_similarity_percent >= 100 {
        return Vec::new();
    }
    let tokens = &source.tokens;
    let comparable = select_near_miss_blocks(source, settings.min_tokens);
    if comparable.len() < 2 {
        return Vec::new();
    }

    // Reported-group indices whose occurrences overlap a token range: near-miss nodes covering
    // such content anchor comparisons but are never re-reported.
    let touched_groups_in = |start: usize, end: usize| -> Vec<usize> {
        reported_groups
            .iter()
            .enumerate()
            .filter(|(_, group)| {
                group.iter().any(|occurrence| {
                    occurrence.start_token_index < end && start < occurrence.end_token_index
                })
            })
            .map(|(group_index, _)| group_index)
            .collect()
    };

    let (symbols, is_content) = to_symbol_stream(tokens);
    let statements = top_level_statement_finder(&source.container_statement_ranges);
    let mut blocks: Vec<Block> = comparable
        .iter()
        .map(|range| {
            Block::new(
                &symbols,
                &is_content,
                range.start_token_index,
                range.end_token_index,
                statements(range.start_token_index, range.end_token_index),
            )
        })
        .collect();
    let matcher = Matcher::new(
        &mut blocks,
        settings.min_tokens,
        settings.min_similarity_percent,
    );

    let block_touched: Vec<bool> = comparable
        .iter()
        .map(|range| !touched_groups_in(range.start_token_index, range.end_token_index).is_empty())
        .collect();
    let mut edges: Vec<MatchEdge> = Vec::new();
    for_each_candidate_pair(
        &blocks,
        settings.min_similarity_percent,
        |left_index, right_index| match matcher.verify(&blocks[left_index], &blocks[right_index]) {
            None => {}
            // A whole match between two blocks that both overlap reported content could never join
            // a group, and recording it would collapse the blocks' core nodes.
            Some(PairMatch::Whole)
                if !(block_touched[left_index] && block_touched[right_index]) =>
            {
                edges.push((left_index, None, right_index, None))
            }
            Some(PairMatch::Whole) => {}
            Some(PairMatch::Local(cores)) => {
                for (left_core, right_core) in cores {
                    edges.push((left_index, Some(left_core), right_index, Some(right_core)));
                }
            }
        },
    );

    // Clustering runs over (block, core) nodes: a block with a recorded whole match is one
    // node, and otherwise each union of its overlapping local cores is its own node, so disjoint
    // cores matched with different partners fall into separate groups.
    let mut matched_whole = vec![false; comparable.len()];
    let mut local_cores: Vec<Vec<(usize, usize)>> = vec![Vec::new(); comparable.len()];
    for &(left_index, left_core, right_index, right_core) in &edges {
        for (index, core) in [(left_index, left_core), (right_index, right_core)] {
            match core {
                Some(core) => local_cores[index].push(core),
                None => matched_whole[index] = true,
            }
        }
    }
    let mut node_blocks: Vec<usize> = Vec::new();
    let mut node_spans: Vec<Option<(usize, usize)>> = Vec::new();
    let mut first_node_by_block: Vec<usize> = Vec::with_capacity(comparable.len());
    for index in 0..comparable.len() {
        first_node_by_block.push(node_blocks.len());
        let cores = if matched_whole[index] {
            Vec::new()
        } else {
            merge_overlapping_cores(&local_cores[index])
        };
        if cores.is_empty() {
            node_blocks.push(index);
            node_spans.push(None);
        }
        for core in cores {
            node_blocks.push(index);
            node_spans.push(Some(core));
        }
    }
    let node_of = |index: usize, core: Option<(usize, usize)>| {
        let first = first_node_by_block[index];
        match core {
            Some(core) if !matched_whole[index] => (first..node_blocks.len())
                .take_while(|&node| node_blocks[node] == index)
                .find(|&node| {
                    node_spans[node].is_some_and(|span| span.0 <= core.0 && core.1 <= span.1)
                })
                .expect("every local core lies in one of its block's merged cores"),
            _ => first,
        }
    };

    let mut parent: Vec<usize> = (0..node_blocks.len()).collect();
    fn find(parent: &mut [usize], mut index: usize) -> usize {
        let mut root = index;
        while parent[root] != root {
            root = parent[root];
        }
        while parent[index] != root {
            let next = parent[index];
            parent[index] = root;
            index = next;
        }
        root
    }
    // Coverage is judged per node: a core is covered only when a reported occurrence overlaps
    // the core itself, not merely elsewhere in its block.
    let node_range = |node: usize| {
        node_spans[node].unwrap_or((
            comparable[node_blocks[node]].start_token_index,
            comparable[node_blocks[node]].end_token_index,
        ))
    };
    let touched_groups_by_node: Vec<Vec<usize>> = (0..node_blocks.len())
        .map(|node| {
            let (start, end) = node_range(node);
            touched_groups_in(start, end)
        })
        .collect();
    for &(left_index, left_core, right_index, right_core) in &edges {
        let (left_node, right_node) = (
            node_of(left_index, left_core),
            node_of(right_index, right_core),
        );
        // Two already-reported nodes have nothing new to contribute to each other.
        if !touched_groups_by_node[left_node].is_empty()
            && !touched_groups_by_node[right_node].is_empty()
        {
            continue;
        }
        let left_root = find(&mut parent, left_node);
        let right_root = find(&mut parent, right_node);
        parent[left_root.max(right_root)] = left_root.min(right_root);
    }

    let mut members_by_root: IndexMap<usize, Vec<usize>> = IndexMap::new();
    for node in 0..node_blocks.len() {
        let root = find(&mut parent, node);
        members_by_root.entry(root).or_default().push(node);
    }
    // A group's nodes from one block become ONE occurrence whose segments are its cores, so the
    // fragment-weighted count charges the block as one copy (as for gapped clones), not once per
    // core.
    let to_occurrences = |nodes: &[usize]| -> Vec<CountedOccurrence> {
        let mut spans_by_block: IndexMap<usize, Vec<Option<(usize, usize)>>> = IndexMap::new();
        for &node in nodes {
            spans_by_block
                .entry(node_blocks[node])
                .or_default()
                .push(node_spans[node]);
        }
        spans_by_block
            .into_iter()
            .map(|(block, spans)| {
                let range = comparable[block];
                let mut segments: Vec<(usize, usize)> = spans
                    .iter()
                    .map(|span| span.unwrap_or((range.start_token_index, range.end_token_index)))
                    .collect();
                segments.sort_unstable();
                let whole = spans.iter().any(Option::is_none);
                let (start, end) = (segments[0].0, segments[segments.len() - 1].1);
                CountedOccurrence {
                    shared_with_merged_group: false,
                    token_count: segments.iter().map(|segment| segment.1 - segment.0).sum(),
                    segments,
                    start_token_index: start,
                    end_token_index: end,
                    start_line: if whole {
                        range.start_line
                    } else {
                        tokens[start].start_row + 1
                    },
                    end_line: if whole {
                        range.end_line
                    } else {
                        tokens[end - 1].end_row + 1
                    },
                }
            })
            .collect()
    };
    let touched_groups_of = |node: usize| &touched_groups_by_node[node];
    let mut groups: Vec<Vec<CountedOccurrence>> = Vec::new();
    for members in members_by_root.values() {
        if members.len() < 2 {
            continue;
        }
        let uncovered: Vec<usize> = members
            .iter()
            .copied()
            .filter(|&index| touched_groups_of(index).is_empty())
            .collect();
        let covered: Vec<usize> = members
            .iter()
            .copied()
            .filter(|&index| !touched_groups_of(index).is_empty())
            .collect();
        if covered.is_empty() {
            let occurrences = to_occurrences(members);
            if occurrences.len() >= 2 {
                groups.push(occurrences);
            }
            continue;
        }
        if uncovered.is_empty() {
            continue;
        }
        // An anchored cluster extends a reported group only when every occurrence of that group
        // overlaps one of the cluster's member nodes: an occurrence disjoint from all members
        // reports content the cluster does not share.
        let overlaps_member = |occurrence: &CountedOccurrence| {
            members.iter().any(|&index| {
                let (start, end) = node_range(index);
                occurrence.start_token_index < end && start < occurrence.end_token_index
            })
        };
        // Ascending by construction: BTreeSet iteration is sorted and filter preserves order.
        let fully_clustered: Vec<usize> = covered
            .iter()
            .flat_map(|&index| touched_groups_of(index).iter().copied())
            .collect::<std::collections::BTreeSet<usize>>()
            .into_iter()
            .filter(|&group_index| {
                let group = &reported_groups[group_index];
                !group.is_empty() && group.iter().all(&overlaps_member)
            })
            .collect();
        if let Some((&target_index, source_indexes)) = fully_clustered.split_first() {
            // Rebuild the component as ONE group with one coalesced occurrence per member block:
            // the fragments every node of a block overlaps are collected together, since a block's
            // cores are parts of one copy.
            let mut consumed: FxHashSet<(usize, usize)> = FxHashSet::default();
            let mut merged: Vec<CountedOccurrence> = Vec::new();
            let mut unanchored_nodes: Vec<usize> = Vec::new();
            let mut nodes_by_block: IndexMap<usize, Vec<usize>> = IndexMap::new();
            for &member_index in members {
                nodes_by_block
                    .entry(node_blocks[member_index])
                    .or_default()
                    .push(member_index);
            }
            for block_nodes in nodes_by_block.values() {
                // Occurrences of ONE group are distinct copies; only fragments from DIFFERENT
                // groups belong to the same copy. Consecutive position-order slices keep the
                // coalesced spans disjoint.
                let mut fragments: Vec<(CountedOccurrence, usize)> = Vec::new();
                let mut plain_nodes: Vec<usize> = Vec::new();
                for &node in block_nodes {
                    let (range_start, range_end) = node_range(node);
                    let fragment_count = fragments.len();
                    for &group_index in &fully_clustered {
                        for (occurrence_index, occurrence) in
                            reported_groups[group_index].iter().enumerate()
                        {
                            if !consumed.contains(&(group_index, occurrence_index))
                                && occurrence.start_token_index < range_end
                                && range_start < occurrence.end_token_index
                            {
                                consumed.insert((group_index, occurrence_index));
                                fragments.push((occurrence.clone(), group_index));
                            }
                        }
                    }
                    if fragments.len() == fragment_count && touched_groups_of(node).is_empty() {
                        plain_nodes.push(node);
                    }
                }
                if fragments.is_empty() {
                    unanchored_nodes.extend(plain_nodes);
                } else {
                    // An untouched core of a block that also holds fragments is part of the same
                    // copy; a group index no reported group uses keeps it in that copy.
                    for occurrence in to_occurrences(&plain_nodes) {
                        fragments.push((occurrence, usize::MAX));
                    }
                }
                fragments.sort_by_key(|(occurrence, _)| {
                    (occurrence.start_token_index, occurrence.end_token_index)
                });
                let mut copy_parts: Vec<CountedOccurrence> = Vec::new();
                let mut copy_groups: FxHashSet<usize> = FxHashSet::default();
                for (occurrence, group_index) in fragments {
                    if copy_groups.contains(&group_index) {
                        merged.push(coalesce_occurrences(std::mem::take(&mut copy_parts)));
                        copy_groups.clear();
                    }
                    copy_parts.push(occurrence);
                    copy_groups.insert(group_index);
                }
                if !copy_parts.is_empty() {
                    merged.push(coalesce_occurrences(copy_parts));
                }
            }
            merged.extend(to_occurrences(&unanchored_nodes));
            merged.sort_by_key(|occurrence| {
                (occurrence.start_token_index, occurrence.end_token_index)
            });
            // The rebuild consumed every fully-clustered group, so shared-span marks from earlier
            // partial merges no longer point at a separate merged group.
            for occurrence in &mut merged {
                occurrence.shared_with_merged_group = false;
            }
            reported_groups[target_index] = merged;
            for &source_index in source_indexes {
                reported_groups[source_index].clear();
            }
        } else {
            let occurrences = to_occurrences(&uncovered);
            if occurrences.len() >= 2 {
                groups.push(occurrences);
            }
        }
    }
    groups.sort_by_key(|group| group_sort_key(group));
    groups
}

/// The mutually disjoint blocks near-miss comparison considers: at least `min_tokens` long, not
/// literal-dense (data tables are compared by value, not shape), and selected by
/// select_comparable_blocks.
fn select_near_miss_blocks<'s>(
    source: &'s TokenizedSource<'_>,
    min_tokens: usize,
) -> Vec<&'s TokenRange> {
    let literal_count_prefix = &source.literal_count_prefix;
    let mut eligible: Vec<&TokenRange> = source
        .block_ranges
        .iter()
        .filter(|range| {
            let token_count = range.end_token_index - range.start_token_index;
            let literal_count = literal_count_prefix[range.end_token_index]
                - literal_count_prefix[range.start_token_index];
            token_count >= min_tokens && !is_literal_dense(literal_count, token_count)
        })
        .collect();
    eligible.sort_by_key(|range| {
        (
            range.start_token_index,
            std::cmp::Reverse(range.end_token_index),
        )
    });
    select_comparable_blocks(&eligible)
}

/// Keeps the block ranges the near-miss phase compares: wrappers whose subtree branches into two
/// or more disjoint eligible sub-blocks are descended through; linear chains keep their top.
fn select_comparable_blocks<'a>(eligible: &[&'a TokenRange]) -> Vec<&'a TokenRange> {
    struct ForestNode<'a> {
        range: &'a TokenRange,
        children: Vec<usize>,
    }
    // Index arena: nodes never move, so ancestor references on the stack stay valid.
    let mut nodes: Vec<ForestNode<'a>> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for &range in eligible {
        while let Some(&top) = stack.last() {
            if nodes[top].range.end_token_index <= range.start_token_index {
                stack.pop();
            } else {
                break;
            }
        }
        if let Some(&top) = stack.last() {
            // Equal spans (two node types covering the same tokens) collapse into the first.
            if nodes[top].range.start_token_index == range.start_token_index
                && nodes[top].range.end_token_index == range.end_token_index
            {
                continue;
            }
        }
        let id = nodes.len();
        nodes.push(ForestNode {
            range,
            children: Vec::new(),
        });
        match stack.last() {
            Some(&top) => nodes[top].children.push(id),
            None => roots.push(id),
        }
        stack.push(id);
    }

    fn branches(nodes: &[ForestNode<'_>], id: usize) -> bool {
        let children = &nodes[id].children;
        children.len() >= 2 || (children.len() == 1 && branches(nodes, children[0]))
    }
    fn visit<'a>(nodes: &[ForestNode<'a>], id: usize, kept: &mut Vec<&'a TokenRange>) {
        if branches(nodes, id) {
            for &child in &nodes[id].children {
                visit(nodes, child, kept);
            }
        } else {
            kept.push(nodes[id].range);
        }
    }
    let mut kept = Vec::new();
    for &root in &roots {
        visit(&nodes, root, &mut kept);
    }
    kept
}

/// One copy's fragments (an exact prefix and suffix split by a large edit) as one occurrence.
fn coalesce_occurrences(occurrences: Vec<CountedOccurrence>) -> CountedOccurrence {
    if occurrences.len() == 1 {
        return occurrences.into_iter().next().expect("non-empty");
    }
    // A partial gapped merge retains the leftover group with ALL its occurrences, so a copy's
    // fragments can arrive both standalone and embedded in a merged occurrence: union overlapping
    // segments so no token span is reported or counted twice.
    let mut sorted: Vec<(usize, usize)> = occurrences
        .iter()
        .flat_map(|occurrence| occurrence.segments.iter().copied())
        .collect();
    sorted.sort_by_key(|segment| *segment);
    let mut segments: Vec<(usize, usize)> = Vec::with_capacity(sorted.len());
    for segment in sorted {
        match segments.last_mut() {
            Some(last) if segment.0 < last.1 => last.1 = last.1.max(segment.1),
            _ => segments.push(segment),
        }
    }
    CountedOccurrence {
        shared_with_merged_group: false,
        token_count: segments.iter().map(|segment| segment.1 - segment.0).sum(),
        start_token_index: occurrences
            .iter()
            .map(|o| o.start_token_index)
            .min()
            .unwrap_or(0),
        end_token_index: occurrences
            .iter()
            .map(|o| o.end_token_index)
            .max()
            .unwrap_or(0),
        start_line: occurrences.iter().map(|o| o.start_line).min().unwrap_or(0),
        end_line: occurrences.iter().map(|o| o.end_line).max().unwrap_or(0),
        segments,
    }
}

/// The unions of overlapping cores, in position order.
fn merge_overlapping_cores(cores: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut sorted = cores.to_vec();
    sorted.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in sorted {
        match merged.last_mut() {
            Some(last) if start < last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// The file's tokens as a near-miss symbol stream: identifiers as -(file-level id + 1), every
/// other token interned from its hash pairs (literal VALUES folded in, unlike the exact
/// fingerprint's kind tags), plus which tokens are content-bearing (names and literal values).
/// Interned per call so a file's symbol ids (and thus its n-gram hashes) never depend on which
/// other files the process measured before it.
fn to_symbol_stream(tokens: &[Token<'_>]) -> (Vec<i32>, Vec<bool>) {
    let mut symbol_by_token_hashes: FxHashMap<(i32, i32, i32, i32), i32> = FxHashMap::default();
    let mut id_by_identifier: FxHashMap<&str, i32> = FxHashMap::default();
    tokens
        .iter()
        .map(|token| {
            if token.is_id {
                let next_id = id_by_identifier.len() as i32;
                let id = *id_by_identifier
                    .entry(token.text.as_ref())
                    .or_insert(next_id);
                return (-(id + 1), false);
            }
            let next_symbol = symbol_by_token_hashes.len() as i32;
            let symbol = *symbol_by_token_hashes
                .entry((
                    token.text_hash,
                    token.text_hash2,
                    token.literal_hash.unwrap_or(0),
                    token.literal_hash2.unwrap_or(0),
                ))
                .or_insert(next_symbol);
            (symbol, token.is_name || token.literal_hash.is_some())
        })
        .unzip()
}

/// Returns a lookup of the outermost container statements inside a token range, excluding a
/// statement spanning the whole range (the block itself).
fn top_level_statement_finder(
    container_statement_ranges: &[Vec<TokenRange>],
) -> impl Fn(usize, usize) -> Vec<(usize, usize)> {
    let mut statements: Vec<(usize, usize)> = container_statement_ranges
        .iter()
        .flatten()
        .map(|range| (range.start_token_index, range.end_token_index))
        .filter(|(start, end)| start < end)
        .collect();
    statements.sort_by_key(|&(start, end)| (start, std::cmp::Reverse(end)));
    move |start, end| {
        let mut top_level: Vec<(usize, usize)> = Vec::new();
        let first = statements.partition_point(|statement| statement.0 < start);
        for &statement in statements[first..]
            .iter()
            .take_while(|statement| statement.0 < end)
        {
            let nested = top_level.last().is_some_and(|last| statement.0 < last.1);
            if statement.1 <= end && statement != (start, end) && !nested {
                top_level.push(statement);
            }
        }
        top_level
    }
}

/// Visits every block pair sharing at least FILTRATION_PERCENT of the smaller block's distinct
/// n-grams, except pairs whose length ratio rules out both whole-block similarity and
/// MAX_LENGTH_RATIO; the same scan as forEachCandidatePair in crossFileNearMiss.ts. Blocks are
/// visited in ascending length, so each posting list is scanned backwards only while its blocks are
/// long enough, and shared counts accumulate in a dense counter instead of a pair map.
fn for_each_candidate_pair(
    blocks: &[Block],
    min_similarity_percent: usize,
    mut visit: impl FnMut(usize, usize),
) {
    let mut order: Vec<usize> = (0..blocks.len()).collect();
    order.sort_by_key(|&index| blocks[index].len());
    let mut postings: FxHashMap<i32, Vec<usize>> = FxHashMap::default();
    let mut shared_counts = vec![0usize; blocks.len()];
    let mut touched: Vec<usize> = Vec::new();
    for right in order {
        let length = blocks[right].len();
        let min_left_length = length
            .div_ceil(MAX_LENGTH_RATIO)
            .min((min_similarity_percent * length).div_ceil(100));
        for &ngram in &blocks[right].ngrams {
            let posting = postings.entry(ngram).or_default();
            for &left in posting.iter().rev() {
                if blocks[left].len() < min_left_length {
                    break;
                }
                if shared_counts[left] == 0 {
                    touched.push(left);
                }
                shared_counts[left] += 1;
            }
            posting.push(right);
        }
        // Ascending so the visit order does not depend on the n-gram set's iteration order.
        touched.sort_unstable();
        for &left in &touched {
            let shared = std::mem::take(&mut shared_counts[left]);
            if shared * 100
                >= FILTRATION_PERCENT * blocks[left].ngrams.len().min(blocks[right].ngrams.len())
            {
                visit(left, right);
            }
        }
        touched.clear();
    }
}

/// Redundant copies one group adds to duplicate_block_count; a faithful port of
/// countRedundantFragments in duplication.ts. Fragment-weighted (merging must not halve
/// duplicate_block_count) with the largest occurrence deducted as the representative; occurrences a
/// partial gapped merge shared into a merged group are skipped — their spans are counted there,
/// and the merged group's representative already stands for the shared content — so no token span
/// contributes to the count twice.
fn count_redundant_fragments(group: &[CountedOccurrence]) -> usize {
    let mut fragment_count = 0;
    let mut max_fragment_count = 0;
    let mut has_shared_occurrence = false;
    for occurrence in group {
        if occurrence.shared_with_merged_group {
            has_shared_occurrence = true;
            continue;
        }
        fragment_count += occurrence.segments.len();
        max_fragment_count = max_fragment_count.max(occurrence.segments.len());
    }
    if has_shared_occurrence {
        fragment_count
    } else {
        fragment_count - max_fragment_count
    }
}

fn summarize_duplicates(
    groups: &[Vec<CountedOccurrence>],
    code_line_numbers: &FxHashSet<usize>,
    tokens: &[Token<'_>],
) -> DuplicationMetrics {
    let mut duplicate_block_count = 0;
    let mut max_duplicate_block_size = 0;
    let mut duplicate_block_groups: Vec<Vec<DuplicateBlockOccurrence>> = Vec::new();
    let mut duplicated_lines: FxHashSet<usize> = FxHashSet::default();
    for group in groups {
        duplicate_block_count += count_redundant_fragments(group);
        for occurrence in group {
            max_duplicate_block_size = max_duplicate_block_size.max(occurrence.token_count);
            // Only CODE lines carrying matched tokens count; the unmatched gap of a merged clone
            // stays out of line coverage.
            for &(segment_start, segment_end) in &occurrence.segments {
                for token in &tokens[segment_start..segment_end.min(tokens.len())] {
                    for row in token.start_row..=token.end_row {
                        if code_line_numbers.contains(&(row + 1)) {
                            duplicated_lines.insert(row + 1);
                        }
                    }
                }
            }
        }
        let mut occurrences: Vec<DuplicateBlockOccurrence> = group
            .iter()
            .map(|occurrence| DuplicateBlockOccurrence {
                start_line: occurrence.start_line,
                end_line: occurrence.end_line,
            })
            .collect();
        occurrences.sort_by_key(|occurrence| occurrence.start_line);
        duplicate_block_groups.push(occurrences);
    }
    duplicate_block_groups
        .sort_by_key(|group| group.first().map(|first| first.start_line).unwrap_or(0));

    let mut duplicate_line_numbers: Vec<usize> = duplicated_lines.iter().copied().collect();
    duplicate_line_numbers.sort_unstable();

    DuplicationMetrics {
        duplicate_block_count,
        duplicate_block_group_count: groups.len(),
        duplicate_block_groups,
        duplicate_line_count: duplicated_lines.len(),
        duplicate_line_numbers,
        duplication_ratio: if code_line_numbers.is_empty() {
            0.0
        } else {
            duplicated_lines.len() as f64 / code_line_numbers.len() as f64
        },
        max_duplicate_block_size,
    }
}
