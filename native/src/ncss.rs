use std::collections::HashSet;
use tree_sitter::Node;

use crate::util::{all_children, find_children_by_field_name};

pub const COMMENT_NODE_TYPES: &[&str] = &[
    "comment",
    "line_comment",
    "block_comment",
    "multiline_comment",
];

/// Nodes never counted positionally inside NCSS containers: metadata, empty statements, Ruby
/// heredoc bodies (tree-sitter emits them as siblings of the statement that opened the heredoc),
/// Ruby statement parentheses (transparent wrappers whose children count instead), Kotlin labels
/// and annotations (siblings of the statement they decorate), and Kotlin enum entries (Java enum
/// constants are not counted either). Kotlin `try` is excluded contextually below: like every other
/// language's try only its clauses and body statements count, but Rust's `?` operator shares the
/// node kind and must keep counting as a tail expression.
const POSITIONAL_EXCLUSION_TYPES: &[&str] = &[
    "attribute_item",
    "inner_attribute_item",
    "empty_statement",
    "heredoc_body",
    "parenthesized_statements",
    "label",
    "annotation",
    "file_annotation",
    "shebang_line",
    "enum_entry",
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

pub fn ncss_contribution(
    node: Node<'_>,
    countable: &HashSet<&'static str>,
    containers: &HashSet<&'static str>,
) -> u64 {
    if !node.is_named() || COMMENT_NODE_TYPES.contains(&node.kind()) || is_for_header_node(node) {
        return 0;
    }
    // A Kotlin accessor without a body (`private set`) only changes visibility and declares
    // nothing of its own; it parses as a sibling of its property and must not count positionally.
    if (node.kind() == "getter" || node.kind() == "setter")
        && !crate::functions::is_implemented_function(node)
    {
        return 0;
    }

    let mut contribution = 0;
    let positional = is_in_container_position(node, containers)
        && !containers.contains(node.kind())
        && !POSITIONAL_EXCLUSION_TYPES.contains(&node.kind())
        && !crate::util::is_kotlin_try_expression(node);
    if (counts_through_node_type(node, countable) || positional || counts_contextually(node))
        && !is_declaration_wrapper(node, countable)
    {
        contribution += 1;
    }

    // A bare else branch (Java/Go `alternative:` without an else-clause wrapper, or Kotlin's bare
    // `else` keyword) counts 1 like the `else` keyword does in PMD; an `else if` chain charges the
    // nested if separately on top.
    if IF_NODE_TYPES.contains(&node.kind()) {
        contribution += count_bare_alternatives(node)
            + u64::from(crate::util::kotlin_else_body(node).is_some());
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
    // A try-with-resources `resource` counts only when it declares a variable; `try (r)` reuses an
    // existing one and adds no statement (matching PMD).
    if node.kind() == "resource" {
        return node.child_by_field_name("name").is_some();
    }
    true
}

/// Direct container children count positionally; Ruby's `(foo; bar)` statement parentheses are
/// transparent, so their children count when the parentheses themselves sit in a container.
fn is_in_container_position(node: Node<'_>, containers: &HashSet<&'static str>) -> bool {
    let mut ancestor = node.parent();
    while let Some(current) = ancestor {
        if current.kind() != "parenthesized_statements" {
            return containers.contains(current.kind());
        }
        ancestor = current.parent();
    }
    false
}

/// `export const x = 1` nests a countable declaration inside `export_statement`; only the inner
/// declaration counts, mirroring how PMD counts one statement per declared entity.
fn is_declaration_wrapper(node: Node<'_>, countable: &HashSet<&'static str>) -> bool {
    if node.kind() != "export_statement" {
        return false;
    }
    node.child_by_field_name("declaration")
        .is_some_and(|declaration| {
            countable.contains(declaration.kind())
                || declaration.kind() == "internal_module"
                || declaration.kind() == "ambient_declaration"
        })
}

const FOR_HEADER_FIELD_NAMES: &[&str] =
    &["init", "initializer", "condition", "update", "increment"];

/// Statement-shaped nodes in a `for` header (`for (int i = 0; i < n; i++)`) are part of the loop
/// statement, which already counts; PMD does not count them separately. JavaScript parses the
/// condition as an `expression_statement` and Go parses the update as an `inc_statement`, so all
/// header fields must be excluded, not just the initializer.
fn is_for_header_node(node: Node<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    // C++20 range-for initializers nest one level deeper: for_range_loop > init_statement > node.
    if parent.kind() == "init_statement"
        && parent
            .parent()
            .is_some_and(|grandparent| grandparent.kind() == "for_range_loop")
    {
        return true;
    }
    if parent.kind() != "for_statement"
        && parent.kind() != "for_clause"
        && parent.kind() != "for_range_loop"
    {
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
    if parent_kind == Some("match_arm")
        && node.kind() != "block"
        && is_field_of_parent(node, "value")
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
    if (parent_kind == Some("method") || parent_kind == Some("singleton_method"))
        && node.kind() != "body_statement"
        && is_field_of_parent(node, "body")
    {
        return true;
    }
    // C++ `friend class X;` declares on its own; `friend void g() { ... }` merely wraps a counted
    // definition.
    if node.kind() == "friend_declaration" {
        return !crate::util::named_children(node)
            .iter()
            .any(|child| child.kind() == "declaration" || child.kind() == "function_definition");
    }
    // A Rust item-position macro invocation (`foo! {}` at module level) has no expression_statement
    // wrapper; the semicolon form does and already counts through it.
    if node.kind() == "macro_invocation"
        && (parent_kind == Some("source_file") || parent_kind == Some("declaration_list"))
    {
        return true;
    }
    // Go struct fields and interface members count like other languages' member declarations, but
    // only inside a named type declaration; inline anonymous types (`var x struct{ ... }`,
    // `func f(h interface{ ... })`) are part of one declaration.
    if node.kind() == "field_declaration" && parent_kind == Some("field_declaration_list") {
        return is_go_declared_type_body(
            node.parent().and_then(|parent| parent.parent()),
            "struct_type",
        );
    }
    if node.kind() == "method_elem" || node.kind() == "method_spec" || node.kind() == "type_elem" {
        return is_go_declared_type_body(node.parent(), "interface_type");
    }
    false
}

fn is_go_declared_type_body(type_node: Option<Node<'_>>, expected_kind: &str) -> bool {
    let Some(type_node) = type_node.filter(|type_node| type_node.kind() == expected_kind) else {
        return false;
    };
    type_node
        .parent()
        .is_some_and(|parent| parent.kind() == "type_spec" || parent.kind() == "type_alias")
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
