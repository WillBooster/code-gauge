use indexmap::IndexMap;
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use tree_sitter::Node;

use crate::types::{DuplicateBlockOccurrence, DuplicationMetrics};
use crate::util::{all_children, named_children, node_text, to_int32, Source};

/// Block-like nodes considered as whole-subtree duplicate candidates; see duplication.ts.
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
];

/// Identifier leaves anonymized by occurrence order so consistently renamed copies still match.
const ANONYMIZED_IDENTIFIER_TYPES: &[&str] = &[
    "identifier",
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

/// Children of a string node that carry only literal content; anything else is interpolation.
const STRING_FRAGMENT_TYPES: &[&str] = &[
    "string_fragment",
    "multiline_string_fragment",
    "string_content",
    "raw_string_content",
    "escape_sequence",
    "heredoc_content",
    "string_start",
    "string_end",
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
];

/// Kind tags whose raw source text re-enters the fingerprint in literal-dense (data-like) regions.
const VALUE_CARRYING_LITERAL_KINDS: &[&str] = &["#num", "#str", "#char", "#regex"];

/// String children that carry actual content (STRING_FRAGMENT_TYPES minus the delimiter nodes).
const STRING_CONTENT_FRAGMENT_TYPES: &[&str] = &[
    "string_fragment",
    "multiline_string_fragment",
    "string_content",
    "raw_string_content",
    "escape_sequence",
    "heredoc_content",
];

const MIN_DUPLICATE_TOKEN_COUNT: usize = 40;
const MIN_SEQUENCE_STATEMENT_COUNT: usize = 2;
const MAX_SEQUENCE_STATEMENT_COUNT: usize = 100;
const MAX_SELECTION_RERUN_COUNT: usize = 20;
/// Maximum normalized-token gap between adjacent duplicate groups merged into one gapped clone.
const MAX_GAP_TOKEN_COUNT: usize = 30;
/// Minimum LCS similarity percent for near-miss (Type-3) clone blocks; see duplication.ts.
const MIN_SIMILARITY_PERCENT: usize = 70;
/// N-gram size for the near-miss candidate index (NIL's default); see duplication.ts.
const NEAR_MISS_NGRAM_SIZE: usize = 5;
/// Filtration threshold: shared distinct n-grams over the smaller set; see duplication.ts.
const NEAR_MISS_FILTRATION_PERCENT: usize = 10;
/// Exclusive bound on shared content-bearing tokens (names and literal values); see duplication.ts.
const MIN_CONTENT_SIMILARITY_PERCENT: usize = 50;

/// See isLiteralDense in duplication.ts: >= 20% literal values marks a region as data-like.
fn is_literal_dense(literal_count: usize, token_count: usize) -> bool {
    literal_count * 5 >= token_count
}

fn literal_kind_by_type() -> &'static HashMap<&'static str, &'static str> {
    static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| LITERAL_KIND_BY_TYPE.iter().copied().collect())
}

fn semantic_name_field_by_parent_type() -> &'static HashMap<&'static str, &'static str> {
    static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
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

/// Detects copy-pasted regions within a file; a faithful port of measureDuplication in
/// duplication.ts, including its JavaScript int32 hash arithmetic and insertion-order maps.
pub fn measure_duplication(
    root: Node<'_>,
    code_line_numbers: &HashSet<usize>,
    code: &Source<'_>,
) -> DuplicationMetrics {
    let mut tokens: Vec<Token<'_>> = Vec::new();
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
    let mut candidates = collect_block_candidates(&tokens, &literal_count_prefix, &block_ranges);
    candidates.extend(collect_sequence_candidates(
        &tokens,
        &literal_count_prefix,
        &container_statement_ranges,
    ));
    let counted = select_maximal_duplicates(candidates);
    let mut groups = merge_adjacent_groups(to_counted_groups(&counted), MAX_GAP_TOKEN_COUNT);
    let near_miss =
        collect_near_miss_groups(&tokens, &literal_count_prefix, &block_ranges, &mut groups);
    groups.extend(near_miss);
    summarize_duplicates(&groups, code_line_numbers, &tokens)
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
        let atomic_kind = if node.child_count() == 0 {
            None
        } else {
            atomic_literal_kind(node)
        };
        if node.child_count() == 0 {
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
        } else if !COMMENT_TYPES.contains(&node.kind()) {
            let mut statement_ranges: Vec<TokenRange> = Vec::new();
            let is_container = node.is_named() && STATEMENT_CONTAINER_TYPES.contains(&node.kind());
            for child in all_children(node) {
                let child_range = visit(
                    child,
                    code,
                    tokens,
                    block_ranges,
                    container_statement_ranges,
                );
                if is_container && child.is_named() && !COMMENT_TYPES.contains(&child.kind()) {
                    statement_ranges.push(child_range);
                }
            }
            // Single-statement containers are recorded too, mirroring collectTokens in
            // duplication.ts: window enumeration needs two statements and yields nothing for them.
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
        if node.is_named() && DUPLICATE_BLOCK_TYPES.contains(&node.kind()) {
            block_ranges.push(TokenRange { ..range });
        }
        range
    }

    visit(root, code, tokens, block_ranges, container_statement_ranges);
}

/// The kind tag of a string-like node with no interpolation, or None to descend normally.
fn atomic_literal_kind(node: Node<'_>) -> Option<&'static str> {
    let kind = if node.is_named() {
        literal_kind_by_type().get(node.kind()).copied()
    } else {
        None
    };
    let kind = kind?;
    if named_children(node)
        .iter()
        .all(|child| STRING_FRAGMENT_TYPES.contains(&child.kind()))
    {
        Some(kind)
    } else {
        None
    }
}

fn append_leaf_token<'a>(node: Node<'_>, code: &Source<'a>, tokens: &mut Vec<Token<'a>>) {
    if COMMENT_TYPES.contains(&node.kind()) {
        return;
    }

    let start_row = node.start_position().row;
    let end_row = node.end_position().row;
    if node.is_named() && SHORTHAND_PROPERTY_TYPES.contains(&node.kind()) {
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

    if node.is_named()
        && ANONYMIZED_IDENTIFIER_TYPES.contains(&node.kind())
        && !is_semantic_name_leaf(node, code)
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
        literal_kind_by_type().get(node.kind()).copied()
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

/// The value of a literal as folded into literal-dense fingerprints; see literalValueText in
/// duplication.ts for the delimiter-independence rationale mirrored here.
fn literal_value_text<'a>(node: Node<'_>, kind: &str, code: &Source<'a>) -> Cow<'a, str> {
    if kind != "#str" && kind != "#char" {
        return Cow::Borrowed(node_text(node, code));
    }
    // Fragment leaves already carry bare content; a quote appearing there is content.
    if STRING_CONTENT_FRAGMENT_TYPES.contains(&node.kind()) {
        return Cow::Borrowed(node_text(node, code));
    }
    let fragments: Vec<&str> = named_children(node)
        .iter()
        .filter(|child| STRING_CONTENT_FRAGMENT_TYPES.contains(&child.kind()))
        .map(|child| node_text(*child, code))
        .collect();
    if !fragments.is_empty() {
        return Cow::Owned(fragments.concat());
    }
    Cow::Borrowed(strip_matching_quotes(node_text(node, code)))
}

/// Strips one matching pair of surrounding ASCII quotes, matching stripMatchingQuotes in
/// duplication.ts (quote characters are ASCII, so byte indexing is UTF-8 safe).
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
    let Some(parent) = node.parent() else {
        return false;
    };

    // Java method references (`Foo::bar`) name their identifiers without grammar fields.
    if parent.kind() == "method_reference" {
        return true;
    }

    // `call` names its callee `method` in Ruby but `function` in Python; accept both fields.
    if parent.kind() == "call"
        && parent
            .child_by_field_name("function")
            .is_some_and(|function| function.id() == node.id())
    {
        return true;
    }

    // A Ruby constant receiving a call (`Alpha.new(...)`) names the invoked API.
    if node.kind() == "constant"
        && parent.kind() == "call"
        && parent
            .child_by_field_name("receiver")
            .is_some_and(|receiver| receiver.id() == node.id())
    {
        return true;
    }

    // Java static receivers (`Alpha.run(...)`) name the invoked type; PascalCase is the
    // discriminator because the tokenizer has no symbol table.
    if parent.kind() == "method_invocation"
        && parent
            .child_by_field_name("object")
            .is_some_and(|object| object.id() == node.id())
        && pascal_case_regex().is_match(node_text(node, code))
    {
        return true;
    }

    // Qualified/generic callees are semantic in call position only.
    if (parent.kind() == "scoped_identifier" || parent.kind() == "qualified_identifier")
        && (parent
            .child_by_field_name("name")
            .is_some_and(|name| name.id() == node.id())
            || parent
                .child_by_field_name("path")
                .is_some_and(|path| path.id() == node.id()))
    {
        let mut outer = parent;
        while let Some(outer_parent) = outer.parent() {
            if matches!(
                outer_parent.kind(),
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
        if outer.parent().is_some_and(|call| {
            call.kind() == "call_expression"
                && call
                    .child_by_field_name("function")
                    .is_some_and(|function| function.id() == outer.id())
        }) {
            return true;
        }
    }

    // Go struct-literal keys (`Config{Timeout: ...}`) have no `key` field in the grammar.
    if parent.kind() == "literal_element"
        && parent.parent().is_some_and(|grandparent| {
            grandparent.kind() == "keyed_element"
                && grandparent
                    .named_child(0)
                    .is_some_and(|first| first.id() == parent.id())
        })
    {
        return true;
    }

    semantic_name_field_by_parent_type()
        .get(parent.kind())
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
) -> Vec<DuplicateCandidate> {
    let mut candidates = Vec::new();
    for range in block_ranges {
        let token_count = range.end_token_index - range.start_token_index;
        if token_count < MIN_DUPLICATE_TOKEN_COUNT {
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

/// Enumerates runs of consecutive sibling statements; see collectSequenceCandidates in
/// duplication.ts for the maximality and sub-window rules replicated here.
fn collect_sequence_candidates(
    tokens: &[Token<'_>],
    literal_count_prefix: &[usize],
    containers: &[Vec<TokenRange>],
) -> Vec<DuplicateCandidate> {
    let mut candidates = Vec::new();
    let mut occurrences_by_window_key: HashMap<i64, WindowOccurrences> = HashMap::new();
    let container_windows: Vec<ContainerWindows> = containers
        .iter()
        .map(|statements| enumerate_container_windows(tokens, statements))
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
    let mut visited: HashSet<SequenceWindow> = maximal_windows.iter().copied().collect();
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
            let key = if statement_count >= MIN_SEQUENCE_STATEMENT_COUNT
                && token_count >= MIN_DUPLICATE_TOKEN_COUNT
            {
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
    let mut index_by_identifier: HashMap<&str, usize> = HashMap::new();
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
fn hash_text(text: &str) -> i32 {
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

/// Keeps only maximal, non-overlapping duplicates; see selectMaximalDuplicates in duplication.ts.
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
    let group_size_by_fingerprint: HashMap<std::rc::Rc<str>, usize> = groups
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
/// see mergeAdjacentGroups in duplication.ts for the pairing and fixpoint rules replicated here.
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
        'outer: for left_index in 0..groups.len() {
            for right_index in left_index + 1..groups.len() {
                let merged =
                    merge_groups(&groups[left_index], &groups[right_index], max_gap_tokens)
                        .or_else(|| {
                            merge_groups(&groups[right_index], &groups[left_index], max_gap_tokens)
                        });
                if let Some(merged) = merged {
                    groups[left_index] = merged;
                    groups.remove(right_index);
                    groups.sort_by_key(|group| group_sort_key(group));
                    restart = true;
                    break 'outer;
                }
            }
        }
    }
    groups
}

fn group_sort_key(group: &[CountedOccurrence]) -> (usize, usize) {
    group
        .first()
        .map(|first| (first.start_token_index, first.end_token_index))
        .unwrap_or((0, 0))
}

/// The merged group when every `second` occurrence gap-follows its `first` counterpart, else None.
fn merge_groups(
    first: &[CountedOccurrence],
    second: &[CountedOccurrence],
    max_gap_tokens: usize,
) -> Option<Vec<CountedOccurrence>> {
    if first.len() != second.len() {
        return None;
    }
    for (index, leading) in first.iter().enumerate() {
        let trailing = &second[index];
        let gap = trailing
            .start_token_index
            .checked_sub(leading.end_token_index)?;
        if gap > max_gap_tokens {
            return None;
        }
        // The merged span must stay clear of the next pair, or spans would overlap.
        if let Some(next) = first.get(index + 1) {
            if trailing.end_token_index > next.start_token_index {
                return None;
            }
        }
    }
    Some(
        first
            .iter()
            .zip(second)
            .map(|(leading, trailing)| CountedOccurrence {
                segments: [leading.segments.clone(), trailing.segments.clone()].concat(),
                token_count: leading.token_count + trailing.token_count,
                start_token_index: leading.start_token_index,
                end_token_index: trailing.end_token_index,
                start_line: leading.start_line,
                end_line: trailing.end_line,
            })
            .collect(),
    )
}

/// Detects near-miss (Type-3) clone groups among block candidates the exact pipeline left
/// unreported; a faithful port of collectNearMissGroups in duplication.ts (NIL-style n-gram
/// filtration, then token-level LCS with NiCad-style per-fragment similarity, then transitive
/// clustering of verified pairs).
fn collect_near_miss_groups(
    tokens: &[Token<'_>],
    literal_count_prefix: &[usize],
    block_ranges: &[TokenRange],
    reported_groups: &mut [Vec<CountedOccurrence>],
) -> Vec<Vec<CountedOccurrence>> {
    if MIN_SIMILARITY_PERCENT >= 100 {
        return Vec::new();
    }
    let mut eligible: Vec<&TokenRange> = block_ranges
        .iter()
        .filter(|range| {
            let token_count = range.end_token_index - range.start_token_index;
            let literal_count = literal_count_prefix
                .get(range.end_token_index)
                .copied()
                .unwrap_or(0)
                - literal_count_prefix
                    .get(range.start_token_index)
                    .copied()
                    .unwrap_or(0);
            token_count >= MIN_DUPLICATE_TOKEN_COUNT
                && !is_literal_dense(literal_count, token_count)
        })
        .collect();
    eligible.sort_by_key(|range| (range.start_token_index, std::cmp::Reverse(range.end_token_index)));
    let comparable = select_comparable_blocks(&eligible);
    if comparable.len() < 2 {
        return Vec::new();
    }

    // Reported-group indices whose occurrences overlap each comparable block: such blocks anchor
    // near-miss comparisons but are never re-reported.
    let touched_groups_by_block: Vec<Vec<usize>> = comparable
        .iter()
        .map(|range| {
            reported_groups
                .iter()
                .enumerate()
                .filter(|(_, group)| {
                    group.iter().any(|occurrence| {
                        occurrence.start_token_index < range.end_token_index
                            && range.start_token_index < occurrence.end_token_index
                    })
                })
                .map(|(group_index, _)| group_index)
                .collect()
        })
        .collect();

    // Interned per call so a file's symbol ids (and thus its n-gram hashes) match the TypeScript
    // backend's first-encounter assignment order exactly.
    let mut symbol_id_by_token_hashes: HashMap<(i32, i32, i32, i32), i32> = HashMap::new();
    let sequences: Vec<NormalizedBlock> = comparable
        .iter()
        .map(|range| normalize_block_sequence(tokens, range, &mut symbol_id_by_token_hashes))
        .collect();
    let ngram_sets: Vec<HashSet<i32>> = sequences
        .iter()
        .map(|block| collect_ngram_set(&block.sequence))
        .collect();
    let shared_counts = count_shared_ngrams(&ngram_sets);

    let mut parent: Vec<usize> = (0..comparable.len()).collect();
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
    for (&(left_index, right_index), &shared) in &shared_counts {
        let left = &sequences[left_index];
        let right = &sequences[right_index];
        // Two already-reported blocks have nothing new to contribute to each other.
        if !touched_groups_by_block[left_index].is_empty()
            && !touched_groups_by_block[right_index].is_empty()
        {
            continue;
        }
        let min_ngrams = ngram_sets[left_index].len().min(ngram_sets[right_index].len());
        if shared * 100 < NEAR_MISS_FILTRATION_PERCENT * min_ngrams {
            continue;
        }
        // A structural match must be backed by shared content (names and literal values); the
        // bound is exclusive, matching duplication.ts.
        if content_overlap(left, right) * 100
            <= MIN_CONTENT_SIMILARITY_PERCENT * left.content_total.max(right.content_total)
        {
            continue;
        }
        // Per-fragment similarity against the larger block (NiCad semantics).
        if lcs_length(&left.sequence, &right.sequence) * 100
            >= MIN_SIMILARITY_PERCENT * left.sequence.len().max(right.sequence.len())
        {
            let left_root = find(&mut parent, left_index);
            let right_root = find(&mut parent, right_index);
            parent[left_root.max(right_root)] = left_root.min(right_root);
        }
    }

    let mut members_by_root: IndexMap<usize, Vec<usize>> = IndexMap::new();
    for index in 0..comparable.len() {
        let root = find(&mut parent, index);
        members_by_root.entry(root).or_default().push(index);
    }
    let to_occurrence = |range: &TokenRange| CountedOccurrence {
        segments: vec![(range.start_token_index, range.end_token_index)],
        token_count: range.end_token_index - range.start_token_index,
        start_token_index: range.start_token_index,
        end_token_index: range.end_token_index,
        start_line: range.start_line,
        end_line: range.end_line,
    };
    let mut groups: Vec<Vec<CountedOccurrence>> = Vec::new();
    for members in members_by_root.values() {
        if members.len() < 2 {
            continue;
        }
        let uncovered: Vec<usize> = members
            .iter()
            .copied()
            .filter(|&index| touched_groups_by_block[index].is_empty())
            .collect();
        let covered: Vec<usize> = members
            .iter()
            .copied()
            .filter(|&index| !touched_groups_by_block[index].is_empty())
            .collect();
        if covered.is_empty() {
            groups.push(
                members
                    .iter()
                    .map(|&index| to_occurrence(comparable[index]))
                    .collect(),
            );
            continue;
        }
        if uncovered.is_empty() {
            continue;
        }
        // An anchored cluster extends a reported group only when that group lies entirely inside
        // the cluster; see collectNearMissGroups in duplication.ts.
        let overlaps_member = |occurrence: &CountedOccurrence| {
            members.iter().any(|&index| {
                let range = comparable[index];
                occurrence.start_token_index < range.end_token_index
                    && range.start_token_index < occurrence.end_token_index
            })
        };
        let mut fully_clustered: Vec<usize> = covered
            .iter()
            .flat_map(|&index| touched_groups_by_block[index].iter().copied())
            .collect::<std::collections::BTreeSet<usize>>()
            .into_iter()
            .filter(|&group_index| reported_groups[group_index].iter().all(overlaps_member))
            .collect();
        fully_clustered.sort_unstable();
        if let Some(&target_index) = fully_clustered.first() {
            let target = &mut reported_groups[target_index];
            target.extend(uncovered.iter().map(|&index| to_occurrence(comparable[index])));
            target.sort_by_key(|occurrence| (occurrence.start_token_index, occurrence.end_token_index));
        } else if uncovered.len() >= 2 {
            groups.push(
                uncovered
                    .iter()
                    .map(|&index| to_occurrence(comparable[index]))
                    .collect(),
            );
        }
    }
    groups.sort_by_key(|group| group_sort_key(group));
    groups
}

/// Keeps the block ranges the near-miss phase compares; a faithful port of selectComparableBlocks
/// in duplication.ts (wrappers whose subtree branches into two or more disjoint eligible
/// sub-blocks are descended through; linear chains keep their top).
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

struct NormalizedBlock {
    sequence: Vec<i32>,
    /// Occurrences per content-bearing symbol (names and literal values), for the content gate.
    content_count_by_symbol: HashMap<i32, usize>,
    content_total: usize,
}

/// A block's tokens as comparable integers; see normalizeBlockSequence in duplication.ts
/// (literal VALUES are folded into the symbol, unlike the exact fingerprint's kind tags).
fn normalize_block_sequence(
    tokens: &[Token<'_>],
    range: &TokenRange,
    symbol_id_by_token_hashes: &mut HashMap<(i32, i32, i32, i32), i32>,
) -> NormalizedBlock {
    let mut sequence = Vec::with_capacity(range.end_token_index - range.start_token_index);
    let mut index_by_identifier: HashMap<&str, i32> = HashMap::new();
    let mut content_count_by_symbol: HashMap<i32, usize> = HashMap::new();
    let mut content_total = 0usize;
    for token in &tokens[range.start_token_index..range.end_token_index.min(tokens.len())] {
        let value = if token.is_id {
            let next_index = index_by_identifier.len() as i32;
            let identifier_index = *index_by_identifier
                .entry(token.text.as_ref())
                .or_insert(next_index);
            -(identifier_index + 1)
        } else {
            let next_id = symbol_id_by_token_hashes.len() as i32;
            let id = *symbol_id_by_token_hashes
                .entry((
                    token.text_hash,
                    token.text_hash2,
                    token.literal_hash.unwrap_or(0),
                    token.literal_hash2.unwrap_or(0),
                ))
                .or_insert(next_id);
            if token.is_name || token.literal_hash.is_some() {
                *content_count_by_symbol.entry(id).or_insert(0) += 1;
                content_total += 1;
            }
            id
        };
        sequence.push(value);
    }
    NormalizedBlock {
        sequence,
        content_count_by_symbol,
        content_total,
    }
}

/// Multiset overlap of two blocks' content-bearing symbols, for the content gate.
fn content_overlap(left: &NormalizedBlock, right: &NormalizedBlock) -> usize {
    let (smaller, larger) = if left.content_count_by_symbol.len() <= right.content_count_by_symbol.len() {
        (left, right)
    } else {
        (right, left)
    };
    smaller
        .content_count_by_symbol
        .iter()
        .map(|(symbol, count)| {
            (*count).min(
                larger
                    .content_count_by_symbol
                    .get(symbol)
                    .copied()
                    .unwrap_or(0),
            )
        })
        .sum()
}

/// The distinct 5-gram hashes of a normalized block sequence, matching collectNgramSet exactly.
fn collect_ngram_set(sequence: &[i32]) -> HashSet<i32> {
    let mut ngrams = HashSet::new();
    if sequence.len() < NEAR_MISS_NGRAM_SIZE {
        return ngrams;
    }
    for window in sequence.windows(NEAR_MISS_NGRAM_SIZE) {
        let mut hash: i32 = 5381;
        for &value in window {
            hash = hash.wrapping_mul(31).wrapping_add(value);
        }
        ngrams.insert(hash);
    }
    ngrams
}

/// Shared distinct-n-gram counts per block pair (left < right).
fn count_shared_ngrams(ngram_sets: &[HashSet<i32>]) -> HashMap<(usize, usize), usize> {
    let mut blocks_by_ngram: HashMap<i32, Vec<usize>> = HashMap::new();
    for (block_index, ngrams) in ngram_sets.iter().enumerate() {
        for &ngram in ngrams {
            blocks_by_ngram.entry(ngram).or_default().push(block_index);
        }
    }
    let mut shared_counts: HashMap<(usize, usize), usize> = HashMap::new();
    for blocks in blocks_by_ngram.values() {
        for (position, &left_index) in blocks.iter().enumerate() {
            for &right_index in &blocks[position + 1..] {
                let pair = (left_index.min(right_index), left_index.max(right_index));
                *shared_counts.entry(pair).or_insert(0) += 1;
            }
        }
    }
    shared_counts
}

/// Longest-common-subsequence LENGTH via the Allison–Dix bit-parallel recurrence. Only the length
/// is needed and LCS length is algorithm-independent, so u64 words are safe even though the
/// TypeScript backend uses 32-bit words.
fn lcs_length(a: &[i32], b: &[i32]) -> usize {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let word_count = a.len().div_ceil(64);
    let mut position_masks: HashMap<i32, Vec<u64>> = HashMap::new();
    for (index, &symbol) in a.iter().enumerate() {
        position_masks
            .entry(symbol)
            .or_insert_with(|| vec![0; word_count])[index / 64] |= 1u64 << (index % 64);
    }

    let mut v = vec![0u64; word_count];
    for symbol in b {
        let match_mask = position_masks.get(symbol);
        // `(v << 1) | 1` shifts a carry bit across words; subtraction borrows across words.
        let mut shift_carry = 1u64;
        let mut borrow = 0u64;
        for (word, slot) in v.iter_mut().enumerate() {
            let previous = *slot;
            let x = match_mask.map_or(0, |mask| mask[word]) | previous;
            let shifted = (previous << 1) | shift_carry;
            shift_carry = previous >> 63;
            let (partial, underflow1) = x.overflowing_sub(shifted);
            let (difference, underflow2) = partial.overflowing_sub(borrow);
            borrow = u64::from(underflow1 || underflow2);
            *slot = x & !difference;
        }
    }
    v.iter().map(|word| word.count_ones() as usize).sum()
}

fn summarize_duplicates(
    groups: &[Vec<CountedOccurrence>],
    code_line_numbers: &HashSet<usize>,
    tokens: &[Token<'_>],
) -> DuplicationMetrics {
    let mut duplicate_block_count = 0;
    let mut max_duplicate_block_size = 0;
    let mut duplicate_block_groups: Vec<Vec<DuplicateBlockOccurrence>> = Vec::new();
    let mut duplicated_lines: HashSet<usize> = HashSet::new();
    for group in groups {
        // Fragment-weighted like duplication.ts: merging must not halve what thresholds see.
        duplicate_block_count +=
            (group.len() - 1) * group.first().map(|first| first.segments.len()).unwrap_or(1);
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

    DuplicationMetrics {
        duplicate_block_count,
        duplicate_block_group_count: groups.len(),
        duplicate_block_groups,
        duplicate_line_count: duplicated_lines.len(),
        duplication_ratio: if code_line_numbers.is_empty() {
            0.0
        } else {
            duplicated_lines.len() as f64 / code_line_numbers.len() as f64
        },
        max_duplicate_block_size,
    }
}
