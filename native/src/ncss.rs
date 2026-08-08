use std::collections::HashSet;
use tree_sitter::Node;

use crate::util::{all_children, find_children_by_field_name};

pub const COMMENT_NODE_TYPES: &[&str] = &["comment", "line_comment", "block_comment"];

/// Nodes never counted positionally inside NCSS containers: metadata, empty statements, and Ruby
/// heredoc bodies (tree-sitter emits them as siblings of the statement that opened the heredoc).
const POSITIONAL_EXCLUSION_TYPES: &[&str] = &[
    "attribute_item",
    "inner_attribute_item",
    "empty_statement",
    "heredoc_body",
];

/// TypeScript interface members count like Java interface members, but the same node types appear
/// inside object-type annotations (`let x: { a: number }`), which are part of one declaration, so
/// they only count directly under an interface body.
const INTERFACE_MEMBER_NODE_TYPES: &[&str] = &[
    "property_signature",
    "method_signature",
    "index_signature",
    "construct_signature",
    "call_signature",
];

/// An if-branch wrapped in one of these already counts through ncss_node_types; a bare
/// `alternative` (Java/Go put the else branch directly in the field) needs the extra `else` count.
const ELSE_CLAUSE_NODE_TYPES: &[&str] = &["else_clause", "elif_clause", "else", "elsif"];

const IF_NODE_TYPES: &[&str] = &["if_statement", "if_expression"];

/// C/C++ type specifiers only declare something when they carry a body (`struct S { ... }`);
/// without one they are mere type references inside other declarations.
const BODYLESS_NCSS_SPECIFIER_TYPES: &[&str] = &[
    "struct_specifier",
    "enum_specifier",
    "union_specifier",
    "class_specifier",
];

/// Counts non-commenting source statements (NCSS) in the subtree, PMD-style: one per declaration,
/// statement, and clause (`else`, `case`/`default` label, `catch`, `finally`, try-with-resources
/// resource); `try` itself, braces, blank lines, and comments count 0.
pub fn count_ncss(
    node: Node<'_>,
    countable: &HashSet<&'static str>,
    containers: &HashSet<&'static str>,
) -> u64 {
    fn visit(
        current: Node<'_>,
        countable: &HashSet<&'static str>,
        containers: &HashSet<&'static str>,
        count: &mut u64,
    ) {
        *count += ncss_contribution(current, countable, containers);
        for child in all_children(current) {
            visit(child, countable, containers, count);
        }
    }

    let mut count = 0;
    visit(node, countable, containers, &mut count);
    count
}

/// Per-function NCSS: the function's whole subtree plus 1 for the declaration itself when the
/// function node carries no countable declaration of its own (arrow functions, lambdas, blocks).
pub fn count_function_ncss(
    node: Node<'_>,
    countable: &HashSet<&'static str>,
    containers: &HashSet<&'static str>,
) -> u64 {
    let self_contribution = ncss_contribution(node, countable, containers);
    count_ncss(node, countable, containers) + if self_contribution > 0 { 0 } else { 1 }
}

fn ncss_contribution(
    node: Node<'_>,
    countable: &HashSet<&'static str>,
    containers: &HashSet<&'static str>,
) -> u64 {
    if !node.is_named() || COMMENT_NODE_TYPES.contains(&node.kind()) || is_for_header_node(node) {
        return 0;
    }

    let mut contribution = 0;
    let positional = node
        .parent()
        .is_some_and(|parent| containers.contains(parent.kind()))
        && !containers.contains(node.kind())
        && !POSITIONAL_EXCLUSION_TYPES.contains(&node.kind());
    if (counts_through_node_type(node, countable) || positional || counts_contextually(node))
        && !is_declaration_wrapper(node, countable)
    {
        contribution += 1;
    }

    // A bare else branch (Java/Go `alternative:` without an else-clause wrapper) counts 1 like the
    // `else` keyword does in PMD; an `else if` chain charges the nested if separately on top.
    if IF_NODE_TYPES.contains(&node.kind()) {
        contribution += count_bare_alternatives(node);
    }

    contribution
}

fn counts_through_node_type(node: Node<'_>, countable: &HashSet<&'static str>) -> bool {
    if !countable.contains(node.kind()) {
        return false;
    }
    if BODYLESS_NCSS_SPECIFIER_TYPES.contains(&node.kind()) {
        return node.child_by_field_name("body").is_some();
    }
    true
}

/// `export const x = 1` nests a countable declaration inside `export_statement`; only the inner
/// declaration counts, mirroring how PMD counts one statement per declared entity.
fn is_declaration_wrapper(node: Node<'_>, countable: &HashSet<&'static str>) -> bool {
    if node.kind() != "export_statement" {
        return false;
    }
    node.child_by_field_name("declaration")
        .is_some_and(|declaration| countable.contains(declaration.kind()))
}

const FOR_HEADER_FIELD_NAMES: &[&str] = &["init", "initializer", "condition", "update", "increment"];

/// Statement-shaped nodes in a `for` header (`for (int i = 0; i < n; i++)`) are part of the loop
/// statement, which already counts; PMD does not count them separately. JavaScript parses the
/// condition as an `expression_statement` and Go parses the update as an `inc_statement`, so all
/// header fields must be excluded, not just the initializer.
fn is_for_header_node(node: Node<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    if parent.kind() != "for_statement" && parent.kind() != "for_clause" {
        return false;
    }
    FOR_HEADER_FIELD_NAMES.iter().any(|field_name| {
        find_children_by_field_name(parent, field_name)
            .iter()
            .any(|child| child.id() == node.id())
    })
}

/// Statements only countable by their position: constructs without a dedicated statement node.
fn counts_contextually(node: Node<'_>) -> bool {
    let parent_kind = node.parent().map(|parent| parent.kind());
    // A Java instance initializer is a bare `block` in the class body; PMD counts it like the
    // `static_initializer` declaration it parallels.
    if node.kind() == "block" && parent_kind == Some("class_body") {
        return true;
    }
    // TypeScript interface members (see INTERFACE_MEMBER_NODE_TYPES).
    if INTERFACE_MEMBER_NODE_TYPES.contains(&node.kind()) && parent_kind == Some("interface_body") {
        return true;
    }
    // A braceless Rust match-arm body (`1 => foo()`) has no expression_statement wrapper; count the
    // value expression so braced and unbraced arms measure alike.
    if parent_kind == Some("match_arm") && node.kind() != "block" && is_field_of_parent(node, "value")
    {
        return true;
    }
    // A TypeScript class-body method overload signature declares a member like its interface twin.
    if node.kind() == "method_signature" && parent_kind == Some("class_body") {
        return true;
    }
    // An ambient `declare namespace M { ... }` is a bare `internal_module`; the non-ambient
    // `namespace N { ... }` is wrapped in an `expression_statement`, which already counts.
    if node.kind() == "internal_module" && parent_kind != Some("expression_statement") {
        return true;
    }
    // A Ruby endless method (`def f(x) = expr`) stores its single-statement body directly in the
    // `body` field instead of a positional `body_statement` container.
    (parent_kind == Some("method") || parent_kind == Some("singleton_method"))
        && node.kind() != "body_statement"
        && is_field_of_parent(node, "body")
}

fn is_field_of_parent(node: Node<'_>, field_name: &str) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    find_children_by_field_name(parent, field_name)
        .iter()
        .any(|child| child.id() == node.id())
}

fn count_bare_alternatives(node: Node<'_>) -> u64 {
    // Extras (comments) inherit the preceding sibling's field in find_children_by_field_name, so a
    // comment between an `elif_clause` and `else_clause` must not be miscounted as a bare branch.
    find_children_by_field_name(node, "alternative")
        .iter()
        .filter(|child| !child.is_extra() && !ELSE_CLAUSE_NODE_TYPES.contains(&child.kind()))
        .count() as u64
}
