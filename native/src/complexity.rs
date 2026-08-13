use std::collections::HashSet;
use tree_sitter::Node;

use crate::util::{all_children, node_text, Source};

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
    pub ncss_nodes: HashSet<&'static str>,
    pub ncss_containers: HashSet<&'static str>,
}

impl LanguageSets {
    pub fn new(language: &crate::languages::LanguageDefinition) -> Self {
        LanguageSets {
            name: language.name,
            function_nodes: language.function_node_types.iter().copied().collect(),
            class_nodes: language.class_node_types.iter().copied().collect(),
            decision_nodes: language.decision_node_types.iter().copied().collect(),
            nesting_nodes: language.nesting_node_types.iter().copied().collect(),
            ncss_nodes: language.ncss_node_types.iter().copied().collect(),
            ncss_containers: language.ncss_container_node_types.iter().copied().collect(),
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

// Sonar cognitive complexity charges a switch/match once as a whole; each case label still adds
// one cyclomatic path. Only named nodes are consulted, so anonymous keyword tokens never match.
const SWITCH_LIKE_NODE_TYPES: &[&str] = &[
    "switch_statement",
    "switch_expression",
    "expression_switch_statement",
    "type_switch_statement",
    "select_statement",
    "match_expression",
    "match_statement",
    "case",
    "case_match",
];

// Per-case decision nodes: cyclomatic-only, because the switch itself carries the cognitive cost.
const CASE_CLAUSE_NODE_TYPES: &[&str] = &[
    "case_clause",
    "switch_case",
    "switch_block_statement_group",
    "switch_rule",
    "case_statement",
    "expression_case",
    "type_case",
    "communication_case",
    "match_arm",
    "when",
    "in_clause",
];

const IF_LIKE_NODE_TYPES: &[&str] = &["if_statement", "if_expression", "if", "unless"];

// Decision nodes that add an execution path but no cognitive point: PMD's cyclomatic complexity
// charges Java `throw` while its cognitive complexity does not.
const CYCLOMATIC_ONLY_NODE_TYPES: &[&str] = &["throw_statement"];

/// Cyclomatic complexity and nesting depth describe the function's own body, so their
/// contributions are gated off inside nested function boundaries; cognitive complexity follows the
/// Sonar spec instead and charges nested function/lambda content to the enclosing function, one
/// nesting level deeper per function boundary crossed.
pub fn measure_complexity(
    node: Node<'_>,
    sets: &LanguageSets,
    nesting: u64,
    stop_at_nested_functions: bool,
    code: &Source<'_>,
) -> ComplexityResult {
    let mut result = ComplexityResult {
        cyclomatic_complexity: 1,
        cognitive_complexity: 0,
        nesting_depth: nesting,
    };

    #[allow(clippy::too_many_arguments)]
    fn visit(
        current: Node<'_>,
        current_nesting: u64,
        mut function_nesting_bonus: u64,
        mut inside_function: bool,
        mut inside_nested_function: bool,
        inside_charged_class_body: bool,
        sets: &LanguageSets,
        stop_at_nested_functions: bool,
        code: &Source<'_>,
        result: &mut ComplexityResult,
    ) {
        // A class body nested in a function (anonymous/local classes) raises the cognitive nesting
        // level once for everything inside it — PMD charges the class body, not the methods it
        // holds, so methods directly inside a charged class body skip the function-boundary bonus.
        let is_charged_class_body = current.kind() == "class_body" && inside_function;
        if is_charged_class_body {
            inside_nested_function = true;
            function_nesting_bonus += 1;
        }
        if is_function_boundary(current, &sets.function_nodes) {
            if inside_function {
                inside_nested_function = true;
                if !inside_charged_class_body {
                    function_nesting_bonus += 1;
                }
            }
            inside_function = true;
        }
        let cognitive_nesting = current_nesting + function_nesting_bonus;
        let counts_for_own_body = !(stop_at_nested_functions && inside_nested_function);

        // Anonymous keyword tokens can share a type with named nodes (Ruby's `if` node contains an
        // `if` keyword token), so only named nodes count as decisions.
        let is_decision = current.is_named()
            && sets.decision_nodes.contains(current.kind())
            && !is_default_switch_branch(current);
        let is_case_clause = current.is_named() && CASE_CLAUSE_NODE_TYPES.contains(&current.kind());
        // Ruby's `case ... else` arm is an `else` node; like every other language's default branch
        // it nests its contents inside the switch (it cannot go in the Ruby nesting set because
        // `if`/`begin` else branches would then double-nest under their already-nesting parent).
        let is_nesting = current.is_named()
            && (sets.nesting_nodes.contains(current.kind())
                || (current.kind() == "else"
                    && current.parent().is_some_and(|parent| {
                        parent.kind() == "case" || parent.kind() == "case_match"
                    })));
        // `elsif`/`elif`/`else if` continue a flat chain: they add a decision without a nesting
        // surcharge (Sonar cognitive-complexity semantics).
        let is_continuation = is_decision && is_flat_chain_continuation(current);

        if is_decision && counts_for_own_body {
            result.cyclomatic_complexity += 1;
        }
        if is_decision && !is_case_clause && !CYCLOMATIC_ONLY_NODE_TYPES.contains(&current.kind()) {
            result.cognitive_complexity += if is_continuation {
                1
            } else {
                1 + cognitive_nesting
            };
        }
        if current.is_named() && SWITCH_LIKE_NODE_TYPES.contains(&current.kind()) {
            result.cognitive_complexity += 1 + cognitive_nesting;
        }
        // A plain `else` branch adds one flat cognitive point; `else if` chains are charged on the
        // nested if instead. Cyclomatic complexity never counts `else` (it adds no execution path).
        result.cognitive_complexity += count_plain_else_branches(current);
        // Sonar charges flow-breaking jumps: goto and labeled break/continue add one flat point.
        if is_flow_breaking_jump(current) {
            result.cognitive_complexity += 1;
        }

        if is_boolean_operator(current, code) {
            if counts_for_own_body {
                result.cyclomatic_complexity += 1;
            }
            // A sequence of identical boolean operators reads as one condition, so only the
            // operator starting a sequence adds a cognitive point (Sonar spec); each operator stays
            // one cyclomatic path.
            if starts_boolean_operator_sequence(current, code) {
                result.cognitive_complexity += 1;
            }
        }

        // Pattern guards add one independent execution path without nesting.
        if is_pattern_guard(current) {
            if counts_for_own_body {
                result.cyclomatic_complexity += 1;
            }
            result.cognitive_complexity += 1;
        }

        let child_nesting = if is_nesting && !is_continuation {
            current_nesting + 1
        } else {
            current_nesting
        };
        if counts_for_own_body {
            result.nesting_depth = result.nesting_depth.max(child_nesting);
        }

        for child in all_children(current) {
            visit(
                child,
                child_nesting,
                function_nesting_bonus,
                inside_function,
                inside_nested_function,
                is_charged_class_body,
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
            0,
            stop_at_nested_functions,
            false,
            false,
            sets,
            stop_at_nested_functions,
            code,
            &mut result,
        );
    }

    result
}

/// Plain else branches attached to `current`: an `else_clause`/Ruby `else` whose branch is not an
/// `else if` continuation, or a bare Java/Go `alternative:` statement without a clause wrapper.
fn count_plain_else_branches(current: Node<'_>) -> u64 {
    if !current.is_named() {
        return 0;
    }
    let kind = current.kind();
    if kind == "else" {
        // A Ruby `case ... else` is the default arm of a switch, which already counts as a whole
        // (sonar-ruby models it as a match case, not an else branch); `if`/`unless`/`begin` else
        // branches count one point each.
        return if current
            .parent()
            .is_some_and(|parent| parent.kind() == "case" || parent.kind() == "case_match")
        {
            0
        } else {
            1
        };
    }
    if kind == "else_clause" {
        let has_if_like_child = crate::util::named_children(current)
            .iter()
            .any(|child| IF_LIKE_NODE_TYPES.contains(&child.kind()));
        return if has_if_like_child { 0 } else { 1 };
    }
    if kind != "if_statement" && kind != "if_expression" {
        return 0;
    }
    // Extras (comments) inherit the preceding sibling's field in find_children_by_field_name, so a
    // comment between an `elif_clause` and `else_clause` must not be miscounted as a bare branch.
    crate::util::find_children_by_field_name(current, "alternative")
        .iter()
        .filter(|child| {
            !child.is_extra()
                && child.kind() != "else_clause"
                && child.kind() != "elif_clause"
                && !IF_LIKE_NODE_TYPES.contains(&child.kind())
        })
        .count() as u64
}

/// goto, and break/continue that jump to a label (their only named child is the label).
fn is_flow_breaking_jump(node: Node<'_>) -> bool {
    if !node.is_named() {
        return false;
    }
    if node.kind() == "goto_statement" {
        return true;
    }
    // Rust jumps are expressions; `break value` carries a named expression child, so only an
    // explicit `label` child marks a labeled jump.
    if node.kind() == "break_expression" || node.kind() == "continue_expression" {
        return crate::util::named_children(node)
            .iter()
            .any(|child| child.kind() == "label" || child.kind() == "loop_label");
    }
    // Comments are named children too (`break /* done */;`), so only non-comment children mark a
    // label.
    (node.kind() == "break_statement" || node.kind() == "continue_statement")
        && crate::util::named_children(node)
            .iter()
            .any(|child| !crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind()))
}

/// Wrappers that are transparent when locating the enclosing boolean operation: PMD/Sonar keep a
/// sequence continuous across parentheses (`a && (b && c)` costs one point).
const PARENTHESIZED_NODE_TYPES: &[&str] = &["parenthesized_expression", "parenthesized_statements"];

/// Whether this boolean operator token starts a new sequence, i.e. its binary node is the root of a
/// run of same-operator binaries (possibly through parentheses). Only the root operator counts one
/// cognitive point: `a && b && c` and `a && (b && c)` cost one, `a && b || c` costs two, matching
/// the Sonar specification and PMD 7.26.0.
fn starts_boolean_operator_sequence(token: Node<'_>, code: &Source<'_>) -> bool {
    let Some(binary) = token.parent() else {
        return true;
    };
    let mut ancestor = binary.parent();
    while let Some(node) = ancestor {
        if !PARENTHESIZED_NODE_TYPES.contains(&node.kind()) {
            break;
        }
        ancestor = node.parent();
    }
    let Some(ancestor) = ancestor else {
        return true;
    };
    if ancestor.kind() != binary.kind() {
        return true;
    }
    find_boolean_operator_text(ancestor, code).map(normalize_boolean_operator)
        != Some(normalize_boolean_operator(node_text(token, code)))
}

/// C++ `and`/`or` are alternative spellings of `&&`/`||`, so mixing them keeps one sequence.
fn normalize_boolean_operator(text: &str) -> &str {
    match text {
        "and" => "&&",
        "or" => "||",
        _ => text,
    }
}

fn find_boolean_operator_text<'a>(binary_node: Node<'_>, code: &Source<'a>) -> Option<&'a str> {
    if let Some(operator) = binary_node.child_by_field_name("operator") {
        return Some(node_text(operator, code));
    }
    all_children(binary_node)
        .into_iter()
        .find(|child| !child.is_named() && BOOLEAN_OPERATORS.contains(&node_text(*child, code)))
        .map(|child| node_text(child, code))
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
fn is_boolean_operator(node: Node<'_>, code: &Source<'_>) -> bool {
    if node.is_named() || !BOOLEAN_OPERATORS.contains(&node_text(node, code)) {
        return false;
    }

    node.parent()
        .is_some_and(|parent| BOOLEAN_OPERATOR_PARENT_TYPES.contains(&parent.kind()))
}
