use std::collections::HashSet;
use tree_sitter::Node;

use crate::util::{all_children, find_children_by_field_name};

const COMMENT_NODE_TYPES: &[&str] = &["comment", "line_comment", "block_comment"];

/// Nodes never counted positionally inside NCSS containers: metadata and empty statements.
const POSITIONAL_EXCLUSION_TYPES: &[&str] =
    &["attribute_item", "inner_attribute_item", "empty_statement"];

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
    if !node.is_named()
        || COMMENT_NODE_TYPES.contains(&node.kind())
        || is_for_header_initializer(node)
    {
        return 0;
    }

    let mut contribution = 0;
    let positional = node
        .parent()
        .is_some_and(|parent| containers.contains(parent.kind()))
        && !containers.contains(node.kind())
        && !POSITIONAL_EXCLUSION_TYPES.contains(&node.kind());
    if (counts_through_node_type(node, countable) || positional)
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

/// A declaration in a `for` header (`for (int i = 0; ...)`) is part of the loop statement, which
/// already counts; PMD does not count it separately.
fn is_for_header_initializer(node: Node<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    if parent.kind() != "for_statement" && parent.kind() != "for_clause" {
        return false;
    }
    ["init", "initializer"].iter().any(|field_name| {
        find_children_by_field_name(parent, field_name)
            .iter()
            .any(|child| child.id() == node.id())
    })
}

fn count_bare_alternatives(node: Node<'_>) -> u64 {
    find_children_by_field_name(node, "alternative")
        .iter()
        .filter(|child| !ELSE_CLAUSE_NODE_TYPES.contains(&child.kind()))
        .count() as u64
}
