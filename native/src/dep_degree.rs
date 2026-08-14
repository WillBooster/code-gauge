use std::collections::HashSet;
use tree_sitter::Node;

use crate::util::{node_text, Source};

/// Leaf node types treated as variable references by the def-use approximation.
const VARIABLE_NODE_TYPES: &[&str] = &[
    "identifier",
    "instance_variable",
    "class_variable",
    "global_variable",
];

/// Tokens directly after a variable that write it without reading it (`x = 1`, `x := 1`).
const PURE_ASSIGNMENT_OPERATORS: &[&str] = &["=", ":="];

/// Tokens directly after a variable that read then write it (`x += 1` depends on x's definition).
const COMPOUND_ASSIGNMENT_OPERATORS: &[&str] = &[
    "+=", "-=", "*=", "/=", "%=", "**=", "//=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=",
    "||=", "??=", "@=", "&^=",
];

/// Parent type -> field under which an identifier is a definition target even when a type
/// annotation separates it from the `=` token, plus loop bindings with no assignment token at all.
/// Mirrors definitionFieldByParentType in metrics.ts.
const DEFINITION_FIELD_BY_PARENT_TYPE: &[(&str, &str)] = &[
    ("variable_declarator", "name"),
    ("let_declaration", "pattern"),
    ("assignment", "left"),
    ("var_spec", "name"),
    ("init_declarator", "declarator"),
    ("enhanced_for_statement", "name"),
    ("for_statement", "left"),
    ("for_in_statement", "left"),
    ("for_in_clause", "left"),
    ("for_range_loop", "declarator"),
    ("for_expression", "pattern"),
];

/// Multi-target lists (`a, b = ...`, `a, b := ...`) whose holder's `left` field marks definitions.
const DEFINITION_LIST_NODE_TYPES: &[&str] = &["expression_list", "pattern_list", "tuple_pattern"];
const DEFINITION_LIST_HOLDER_TYPES: &[&str] = &[
    "assignment",
    "assignment_statement",
    "short_var_declaration",
    "for_statement",
    "for_in_clause",
    "range_clause",
];

/// Parameter-position fields that annotate or initialize rather than bind (`x: T`, `x = default`).
const NON_BINDING_PARAMETER_FIELDS: &[&str] = &["type", "value"];

/// Approximate def-use pairs of the function's subtree; mirrors measureDepDegree in metrics.ts.
pub fn measure_dep_degree(function_node: Node<'_>, code: &Source<'_>) -> u64 {
    let mut leaves = Vec::new();
    collect_non_comment_leaves(function_node, &mut leaves);
    let mut defined: HashSet<&str> = HashSet::new();
    let mut pairs = 0u64;
    for index in 0..leaves.len() {
        let leaf = leaves[index];
        if !VARIABLE_NODE_TYPES.contains(&leaf.kind()) {
            continue;
        }
        let name = node_text(leaf, code);
        let next_text = leaves.get(index + 1).map(|next| node_text(*next, code));
        if next_text.is_some_and(|next| COMPOUND_ASSIGNMENT_OPERATORS.contains(&next)) {
            if defined.contains(name) {
                pairs += 1;
            }
            defined.insert(name);
            continue;
        }
        if next_text.is_some_and(|next| PURE_ASSIGNMENT_OPERATORS.contains(&next))
            || is_structural_definition(leaf)
            || is_parameter_definition(leaf)
        {
            defined.insert(name);
            continue;
        }
        if defined.contains(name) {
            pairs += 1;
        }
    }
    pairs
}

fn collect_non_comment_leaves<'t>(node: Node<'t>, leaves: &mut Vec<Node<'t>>) {
    if matches!(node.kind(), "comment" | "line_comment" | "block_comment") {
        return;
    }
    if node.child_count() == 0 {
        leaves.push(node);
        return;
    }
    for child in crate::util::all_children(node) {
        collect_non_comment_leaves(child, leaves);
    }
}

fn is_structural_definition(node: Node<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    let field = field_name_in_parent(node, parent);
    if DEFINITION_FIELD_BY_PARENT_TYPE
        .iter()
        .any(|(parent_type, definition_field)| {
            *parent_type == parent.kind() && field == Some(definition_field)
        })
    {
        return true;
    }
    if !DEFINITION_LIST_NODE_TYPES.contains(&parent.kind()) {
        return false;
    }
    let Some(holder) = parent.parent() else {
        return false;
    };
    DEFINITION_LIST_HOLDER_TYPES.contains(&holder.kind())
        && field_name_in_parent(parent, holder) == Some("left")
}

/// Mirrors isParameterDefinition in metrics.ts: the identifier binds a parameter when its parent
/// (or grandparent, for wrapped declarators) is a parameter-ish node, or it directly occupies a
/// parameter field; type annotations and default values inside parameter nodes bind nothing.
fn is_parameter_definition(node: Node<'_>) -> bool {
    let mut current = node;
    for depth in 0..2 {
        let Some(parent) = current.parent() else {
            return false;
        };
        let field = field_name_in_parent(current, parent);
        if field.is_some_and(|name| NON_BINDING_PARAMETER_FIELDS.contains(&name)) {
            return false;
        }
        if parent.kind().contains("parameter")
            || (depth == 0 && field.is_some_and(|name| name.contains("parameter")))
        {
            return true;
        }
        current = parent;
    }
    false
}

fn field_name_in_parent(node: Node<'_>, parent: Node<'_>) -> Option<&'static str> {
    for index in 0..parent.child_count() {
        if let Some(child) = parent.child(index) {
            if child.id() == node.id() {
                return parent.field_name_for_child(index as u32);
            }
        }
    }
    None
}
