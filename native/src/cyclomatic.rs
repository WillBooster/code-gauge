use tree_sitter::Node;

use crate::util::{named_children, node_text, Source};

/// Cyclomatic paths a Java node adds to its function, following PMD 7.26.0's CycloVisitor with
/// its default options: branches and loops add 1 plus the boolean paths of their condition,
/// `throw`/`catch`/enhanced `for` add 1, and a switch adds the boolean paths of its tested
/// expression plus the expression alternatives of each non-default label. `&&`/`||` outside these
/// conditions (initializers, returns, arguments) and pattern labels and guards add nothing.
pub fn pmd_cyclomatic_increment(node: Node<'_>, code: &Source<'_>) -> u64 {
    match node.kind() {
        "if_statement" | "while_statement" | "do_statement" | "for_statement"
        | "ternary_expression" => {
            1 + node
                .child_by_field_name("condition")
                .map_or(0, |condition| {
                    boolean_expression_complexity(condition, code)
                })
        }
        "enhanced_for_statement" | "catch_clause" | "throw_statement" => 1,
        "switch_expression" => node
            .child_by_field_name("condition")
            .map_or(0, |condition| {
                boolean_expression_complexity(condition, code)
            }),
        "switch_block_statement_group" | "switch_rule" => named_children(node)
            .into_iter()
            .filter(|child| child.kind() == "switch_label")
            .flat_map(named_children)
            .filter(|child| {
                child.kind() != "guard"
                    && child.kind() != "pattern"
                    && !crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind())
            })
            .count() as u64,
        _ => 0,
    }
}

/// PMD's booleanExpressionComplexity: a conditional expression costs 2 plus its parts; any other
/// expression costs its `&&`/`||` operators. PMD has no parenthesis nodes, so they are unwrapped.
fn boolean_expression_complexity(expression: Node<'_>, code: &Source<'_>) -> u64 {
    let mut expression = expression;
    while expression.kind() == "parenthesized_expression" {
        let Some(inner) = named_children(expression)
            .into_iter()
            .find(|child| !crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind()))
        else {
            return 0;
        };
        expression = inner;
    }
    if expression.kind() == "ternary_expression" {
        return 2 + ["condition", "consequence", "alternative"]
            .iter()
            .filter_map(|field| expression.child_by_field_name(field))
            .map(|part| boolean_expression_complexity(part, code))
            .sum::<u64>();
    }
    count_conditional_operators(expression, code)
}

/// `&&`/`||` binaries in the subtree, not descending into lambdas or class bodies, which PMD treats
/// as find boundaries.
fn count_conditional_operators(node: Node<'_>, code: &Source<'_>) -> u64 {
    if node.kind() == "lambda_expression" || node.kind() == "class_body" {
        return 0;
    }
    let own = u64::from(
        node.kind() == "binary_expression"
            && node
                .child_by_field_name("operator")
                .is_some_and(|operator| matches!(node_text(operator, code), "&&" | "||")),
    );
    own + named_children(node)
        .into_iter()
        .map(|child| count_conditional_operators(child, code))
        .sum::<u64>()
}
