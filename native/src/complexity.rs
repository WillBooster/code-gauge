use std::collections::HashSet;
use tree_sitter::Node;

use crate::util::{all_children, node_text};

pub struct ComplexityResult {
    pub cyclomatic_complexity: u64,
    pub cognitive_complexity: u64,
    pub nesting_depth: u64,
}

/// Node-type lookup sets built once per measurement from the language definition.
pub struct LanguageSets {
    pub name: &'static str,
    pub function_nodes: HashSet<&'static str>,
    pub class_nodes: HashSet<&'static str>,
    pub decision_nodes: HashSet<&'static str>,
    pub nesting_nodes: HashSet<&'static str>,
}

impl LanguageSets {
    pub fn new(language: &crate::languages::LanguageDefinition) -> Self {
        LanguageSets {
            name: language.name,
            function_nodes: language.function_node_types.iter().copied().collect(),
            class_nodes: language.class_node_types.iter().copied().collect(),
            decision_nodes: language.decision_node_types.iter().copied().collect(),
            nesting_nodes: language.nesting_node_types.iter().copied().collect(),
        }
    }
}

const BOOLEAN_OPERATORS: &[&str] = &["&&", "||", "and", "or"];
/// Parents under which `&&`/`||`/`and`/`or` tokens are actual boolean operators.
const BOOLEAN_OPERATOR_PARENT_TYPES: &[&str] = &["binary_expression", "binary", "boolean_operator"];

/// A Ruby stabby lambda's body block is part of the lambda, not a separate function.
pub fn is_lambda_body_block(node: Node<'_>) -> bool {
    (node.kind() == "block" || node.kind() == "do_block")
        && node
            .parent()
            .is_some_and(|parent| parent.kind() == "lambda")
}

pub fn is_function_boundary(node: Node<'_>, function_nodes: &HashSet<&'static str>) -> bool {
    function_nodes.contains(node.kind()) && !is_lambda_body_block(node)
}

pub fn measure_complexity(
    node: Node<'_>,
    sets: &LanguageSets,
    nesting: u64,
    stop_at_nested_functions: bool,
    code: &str,
) -> ComplexityResult {
    let mut result = ComplexityResult {
        cyclomatic_complexity: 1,
        cognitive_complexity: 0,
        nesting_depth: nesting,
    };

    fn visit(
        current: Node<'_>,
        current_nesting: u64,
        sets: &LanguageSets,
        stop_at_nested_functions: bool,
        code: &str,
        result: &mut ComplexityResult,
    ) {
        if stop_at_nested_functions && is_function_boundary(current, &sets.function_nodes) {
            return;
        }

        // Anonymous keyword tokens can share a type with named nodes (Ruby's `if` node contains an
        // `if` keyword token), so only named nodes count as decisions.
        let is_decision = current.is_named()
            && sets.decision_nodes.contains(current.kind())
            && !is_default_switch_branch(current);
        let is_nesting = current.is_named()
            && sets.nesting_nodes.contains(current.kind())
            && !is_default_switch_branch(current);
        // `elsif`/`elif`/`else if` continue a flat chain: they add a decision without a nesting
        // surcharge (Sonar cognitive-complexity semantics).
        let is_continuation = is_decision && is_flat_chain_continuation(current);

        if is_decision {
            result.cyclomatic_complexity += 1;
            result.cognitive_complexity += if is_continuation {
                1
            } else {
                1 + current_nesting
            };
        }

        if is_boolean_operator(current, code) {
            result.cyclomatic_complexity += 1;
            result.cognitive_complexity += 1;
        }

        // Pattern guards add one independent execution path without nesting.
        if is_pattern_guard(current) {
            result.cyclomatic_complexity += 1;
            result.cognitive_complexity += 1;
        }

        let child_nesting = if is_nesting && !is_continuation {
            current_nesting + 1
        } else {
            current_nesting
        };
        result.nesting_depth = result.nesting_depth.max(child_nesting);

        for child in all_children(current) {
            visit(
                child,
                child_nesting,
                sets,
                stop_at_nested_functions,
                code,
                result,
            );
        }
    }

    for child in all_children(node) {
        visit(
            child,
            nesting,
            sets,
            stop_at_nested_functions,
            code,
            &mut result,
        );
    }

    result
}

/// Java `guard`, Ruby `if_guard`, Python `if_clause`, and Rust guards inside `match_pattern`.
fn is_pattern_guard(node: Node<'_>) -> bool {
    if !node.is_named() {
        return false;
    }
    let kind = node.kind();
    if kind == "guard" || kind == "if_guard" || kind == "unless_guard" || kind == "if_clause" {
        return true;
    }
    kind == "match_pattern"
        && all_children(node)
            .iter()
            .any(|child| !child.is_named() && child.kind() == "if")
}

/// Ruby `elsif`, Python `elif`, and `else if` (an if node in an else/alternative position).
fn is_flat_chain_continuation(node: Node<'_>) -> bool {
    let kind = node.kind();
    if kind == "elsif" || kind == "elif_clause" {
        return true;
    }
    if kind != "if_statement" && kind != "if_expression" && kind != "if" {
        return false;
    }
    let Some(parent) = node.parent() else {
        return false;
    };
    // JS/C/C++/Rust wrap `else if` in an else clause; Java/Go put it directly in `alternative`.
    parent.kind() == "else_clause"
        || parent
            .child_by_field_name("alternative")
            .is_some_and(|alternative| alternative.id() == node.id())
}

/// Default branches of switch-like constructs add no decision.
fn is_default_switch_branch(node: Node<'_>) -> bool {
    let kind = node.kind();
    if kind == "case_statement" {
        return node.child_by_field_name("value").is_none();
    }

    if kind == "switch_block_statement_group" || kind == "switch_rule" {
        let label = crate::util::named_children(node)
            .into_iter()
            .find(|child| child.kind() == "switch_label");
        return label.is_some_and(|label| label.named_child_count() == 0);
    }

    // Python `case _:` / `case y:` and Rust `_ =>` fallback arms are unconditional like `default`.
    if kind == "case_clause" || kind == "match_arm" {
        let pattern = crate::util::named_children(node)
            .into_iter()
            .find(|child| child.kind() == "case_pattern" || child.kind() == "match_pattern");
        let Some(pattern) = pattern else {
            return false;
        };
        if pattern.child(0).is_some_and(|first| first.kind() == "_")
            && (pattern.child_count() == 1
                || pattern.child(1).is_some_and(|second| second.kind() == "if"))
        {
            return true;
        }
        let sole_child = if pattern.named_child_count() == 1 {
            pattern.named_child(0)
        } else {
            None
        };
        return kind == "case_clause"
            && sole_child.is_some_and(|child| {
                child.kind() == "dotted_name"
                    && child.named_child_count() == 1
                    && child
                        .named_child(0)
                        .is_some_and(|inner| inner.kind() == "identifier")
            });
    }

    // Ruby `in y` binds unconditionally.
    if kind == "in_clause" {
        return node
            .named_child(0)
            .is_some_and(|first| first.kind() == "identifier");
    }

    false
}

/// The parent guard is required because the same tokens appear in non-boolean syntax (C++ `int&&`,
/// `operator&&`, Rust's empty closure parameter list `|| 5`).
fn is_boolean_operator(node: Node<'_>, code: &str) -> bool {
    if node.is_named() || !BOOLEAN_OPERATORS.contains(&node_text(node, code)) {
        return false;
    }

    node.parent()
        .is_some_and(|parent| BOOLEAN_OPERATOR_PARENT_TYPES.contains(&parent.kind()))
}
