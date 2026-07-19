use tree_sitter::Node;

use crate::structure::{
    is_c_mutable_binding, is_c_variable_declarator, is_misparsed_cpp_module_declaration,
};
use crate::types::SyntaxFeatureMetrics;
use crate::util::{all_children, named_children, node_text, Source};

pub fn measure_syntax_features(
    root: Node<'_>,
    language_name: &str,
    code: &Source<'_>,
) -> SyntaxFeatureMetrics {
    let mut metrics = SyntaxFeatureMetrics {
        assignment_count: 0,
        await_expression_count: 0,
        loop_statement_count: 0,
        mutable_binding_count: 0,
        return_statement_count: 0,
        throw_statement_count: 0,
        try_statement_count: 0,
    };

    fn visit(
        node: Node<'_>,
        language_name: &str,
        code: &Source<'_>,
        metrics: &mut SyntaxFeatureMetrics,
    ) {
        if is_assignment_node(node) {
            metrics.assignment_count += 1;
        }
        if is_await_node(node) {
            metrics.await_expression_count += 1;
        }
        if is_loop_node(node) {
            metrics.loop_statement_count += 1;
        }
        metrics.mutable_binding_count += count_mutable_bindings(node, language_name, code);
        if is_return_node(node) {
            metrics.return_statement_count += 1;
        }
        if is_throw_node(node, code) {
            metrics.throw_statement_count += 1;
        }
        if is_try_node(node) {
            metrics.try_statement_count += 1;
        }

        for child in named_children(node) {
            visit(child, language_name, code, metrics);
        }
    }

    visit(root, language_name, code, &mut metrics);
    metrics
}

fn is_assignment_node(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "assignment_expression"
            | "augmented_assignment_expression"
            | "assignment_statement"
            | "assignment"
            | "augmented_assignment"
            | "operator_assignment"
            | "short_var_declaration"
            | "compound_assignment_expr"
            // Python's walrus (`if (n := len(xs)):`) binds like an assignment.
            | "named_expression"
            // Increment/decrement mutate their operand.
            | "update_expression"
            | "inc_statement"
            | "dec_statement"
    )
}

fn is_await_node(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "await_expression" | "await" | "co_await_expression"
    )
}

fn is_loop_node(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "for_statement"
            | "for_in_statement"
            | "enhanced_for_statement"
            | "for_range_loop"
            | "while_statement"
            | "do_statement"
            | "for_expression"
            | "while_expression"
            | "loop_expression"
            // Ruby loop nodes are keyword-named; only named nodes reach this check.
            | "while"
            | "until"
            | "for"
            | "while_modifier"
            | "until_modifier"
    )
}

/// Java and C/C++ declare several bindings per statement, so each mutable declarator counts. The
/// C/C++ branches are language-gated because `field_declaration` is a shared node type.
fn count_mutable_bindings(node: Node<'_>, language_name: &str, code: &Source<'_>) -> u64 {
    let is_c = language_name == "c" || language_name == "cpp";
    if node.kind() == "local_variable_declaration"
        || (node.kind() == "field_declaration" && language_name == "java")
    {
        let java_declarators = named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "variable_declarator")
            .count();
        return if is_java_mutable_declaration(node, code) {
            java_declarators as u64
        } else {
            0
        };
    }

    if is_c && (node.kind() == "declaration" || node.kind() == "field_declaration") {
        return count_c_mutable_bindings(node, language_name == "cpp", code);
    }

    // tree-sitter-cpp parses the in-class `int count = 0;` member as a pure-virtual-like
    // `function_definition` whose declarator is a bare field name.
    if is_c && node.kind() == "function_definition" {
        let declarator = node.child_by_field_name("declarator");
        if declarator.is_some_and(|declarator| {
            declarator.kind() == "field_identifier" || declarator.kind() == "identifier"
        }) {
            return count_c_mutable_bindings(node, language_name == "cpp", code);
        }
        return 0;
    }

    // Java `for (String x : xs)` binds its loop variable directly on the statement node.
    if node.kind() == "enhanced_for_statement" {
        return if is_java_mutable_declaration(node, code) {
            1
        } else {
            0
        };
    }

    // Java pattern variables are reassignable local variables unless final (JLS 4.12.4).
    if language_name == "java"
        && matches!(
            node.kind(),
            "instanceof_expression" | "type_pattern" | "record_pattern_component"
        )
    {
        let binds_name = if node.kind() == "instanceof_expression" {
            node.child_by_field_name("name").is_some()
        } else {
            named_children(node)
                .iter()
                .any(|child| child.kind() == "identifier")
        };
        let is_final = all_children(node)
            .iter()
            .any(|child| !child.is_named() && node_text(*child, code) == "final");
        return if binds_name && !is_final { 1 } else { 0 };
    }

    // C++ `for (int x : xs)` binds directly in the loop's declarator field.
    if is_c && node.kind() == "for_range_loop" {
        let declarator = node.child_by_field_name("declarator");
        return match declarator {
            Some(declarator) if is_c_mutable_binding(node, declarator, code) => {
                count_c_bound_identifiers(declarator)
            }
            _ => 0,
        };
    }

    if is_mutable_binding_node(node, code) {
        1
    } else {
        0
    }
}

fn count_c_mutable_bindings(node: Node<'_>, is_cpp: bool, code: &Source<'_>) -> u64 {
    // The module-syntax misparse only exists in the C++ grammar; in C, `module` is an identifier.
    if is_cpp && is_misparsed_cpp_module_declaration(node, code) {
        return 0;
    }
    named_children(node)
        .into_iter()
        .filter(|child| {
            is_c_variable_declarator(*child) && is_c_mutable_binding(node, *child, code)
        })
        .map(count_c_bound_identifiers)
        .sum()
}

/// A C++ structured binding (`auto [a, b] = ...`) introduces one binding per bound identifier.
fn count_c_bound_identifiers(declarator: Node<'_>) -> u64 {
    let inner = if declarator.kind() == "init_declarator" {
        declarator
            .child_by_field_name("declarator")
            .unwrap_or(declarator)
    } else {
        declarator
    };
    if inner.kind() == "structured_binding_declarator" {
        let identifier_count = named_children(inner)
            .into_iter()
            .filter(|child| child.kind() == "identifier")
            .count() as u64;
        return identifier_count.max(1);
    }
    1
}

fn is_mutable_binding_node(node: Node<'_>, code: &Source<'_>) -> bool {
    (node.kind() == "lexical_declaration"
        && node
            .child(0)
            .is_some_and(|first| node_text(first, code) == "let"))
        || (node.kind() == "variable_declaration"
            && node
                .child(0)
                .is_some_and(|first| node_text(first, code) == "var"))
        || node.kind() == "var_declaration"
        || (node.kind() == "let_declaration" && has_rust_mutable_let_binding(node))
}

/// Java variable/field declarations bind mutably unless marked `final`.
fn is_java_mutable_declaration(node: Node<'_>, code: &Source<'_>) -> bool {
    let modifiers = named_children(node)
        .into_iter()
        .find(|child| child.kind() == "modifiers");
    !modifiers.is_some_and(|modifiers| {
        all_children(modifiers)
            .iter()
            .any(|child| node_text(*child, code) == "final")
    })
}

/// A Rust `let` binds mutably via a direct `mut` or a `mut` inside its destructuring pattern,
/// excluding `mut` under a `reference_pattern`; see hasRustMutableLetBinding in metrics.ts.
fn has_rust_mutable_let_binding(node: Node<'_>) -> bool {
    if all_children(node)
        .iter()
        .any(|child| child.kind() == "mutable_specifier")
    {
        return true;
    }

    let Some(pattern) = node.child_by_field_name("pattern") else {
        return false;
    };

    descendants_of_type(pattern, "mutable_specifier")
        .into_iter()
        .any(|specifier| {
            specifier
                .parent()
                .is_none_or(|parent| parent.kind() != "reference_pattern")
        })
}

/// Like node-tree-sitter's descendantsOfType: every descendant (including the node itself) of the kind.
fn descendants_of_type<'t>(node: Node<'t>, kind: &str) -> Vec<Node<'t>> {
    let mut nodes = Vec::new();

    fn visit<'t>(node: Node<'t>, kind: &str, nodes: &mut Vec<Node<'t>>) {
        if node.kind() == kind {
            nodes.push(node);
        }
        for child in all_children(node) {
            visit(child, kind, nodes);
        }
    }

    visit(node, kind, &mut nodes);
    nodes
}

fn is_return_node(node: Node<'_>) -> bool {
    // Ruby's named `return` node is safe here: the visitor walks named children only. `co_return`
    // is the only way a C++ coroutine returns; `co_yield` suspends and is not a return.
    matches!(
        node.kind(),
        "return_statement" | "return_expression" | "return" | "co_return_statement"
    )
}

fn is_throw_node(node: Node<'_>, code: &Source<'_>) -> bool {
    node.kind() == "throw_statement"
        || node.kind() == "raise_statement"
        || is_ruby_raise_call(node, code)
}

/// Ruby raises via receiverless `raise`/`fail` calls; a receiver call like `object.raise` is not one.
fn is_ruby_raise_call(node: Node<'_>, code: &Source<'_>) -> bool {
    if node.kind() != "call" || node.child_by_field_name("receiver").is_some() {
        return false;
    }

    node.child_by_field_name("method").is_some_and(|method| {
        method.kind() == "identifier"
            && (node_text(method, code) == "raise" || node_text(method, code) == "fail")
    })
}

fn is_try_node(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "try_statement" | "try_with_resources_statement" | "rescue_modifier"
    ) || is_ruby_rescue_construct(node)
}

/// Ruby protects code with `rescue` clauses directly under an explicit `begin` or an implicit
/// method/block `body_statement`; `ensure`-only constructs handle exceptions like try/finally.
fn is_ruby_rescue_construct(node: Node<'_>) -> bool {
    (node.kind() == "begin" || node.kind() == "body_statement")
        && named_children(node)
            .iter()
            .any(|child| child.kind() == "rescue" || child.kind() == "ensure")
}
