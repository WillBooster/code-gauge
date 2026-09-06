use std::collections::{HashMap, HashSet};
use tree_sitter::Node;

use crate::complexity::is_function_boundary;
use crate::util::{is_identifier_leaf, node_text, Source};

/// Leaf node types treated as variable references by the def-use approximation.
const VARIABLE_NODE_TYPES: &[&str] = &[
    "identifier",
    "simple_identifier",
    "interpolated_identifier",
    "implicit_parameter",
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
    ("for", "pattern"),
    ("foreach_statement", "left"),
    ("catch_declaration", "name"),
    ("declaration_pattern", "name"),
    ("declaration_expression", "name"),
    ("recursive_pattern", "name"),
    ("var_pattern", "name"),
    ("tuple_pattern", "name"),
    ("parenthesized_variable_designation", "name"),
    ("from_clause", "name"),
];

/// Kotlin has no grammar fields: an identifier directly under one of these declares a binding
/// (`val x`, `for (x in xs)`, lambda parameters, and the `catch (e: T)` exception name).
const KOTLIN_DEFINITION_PARENT_TYPES: &[&str] = &["variable_declaration", "catch_block"];

/// Kotlin parameter nodes whose identifier child is the declared name; the parameter LIST nodes
/// (`function_value_parameters`) also hold default-value expressions, which are reads.
const KOTLIN_PARAMETER_TYPES: &[&str] = &[
    "parameter",
    "parameter_with_optional_type",
    "class_parameter",
];

/// C# LINQ clauses that bind a range variable as their first identifier child (no grammar field):
/// `join y in ...`, `into ys`, `let z = ...`, and a query continuation `into g`.
const CSHARP_QUERY_BINDING_PARENT_TYPES: &[&str] = &[
    "join_clause",
    "join_into_clause",
    "let_clause",
    "query_expression",
];

/// C/C++ declarators wrapping the declared name (`int* p = q;`, `int& r = *q;`, `int a[n] = {};`,
/// `int (*fp)(int) = g;`, member pointer `int C::* p = q;`): the definition field is checked on the
/// outermost wrapper.
const DECLARATOR_WRAPPER_TYPES: &[&str] = &[
    "pointer_declarator",
    "reference_declarator",
    "array_declarator",
    "parenthesized_declarator",
    "function_declarator",
    "attributed_declarator",
    "pointer_type_declarator",
    "qualified_identifier",
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

/// One leaf of the def-use walk: its field in the parent and its function-scope chain.
struct DepDegreeLeaf<'t> {
    node: Node<'t>,
    field_name: Option<&'static str>,
    /// Chain of nested-function scope ids below the measured function: "" for its own body,
    /// then "/0", "/0/1", ...
    scope: String,
}

/// Approximate def-use pairs of the function's subtree; mirrors measureDepDegree in metrics.ts.
pub fn measure_dep_degree(
    function_node: Node<'_>,
    code: &Source<'_>,
    function_nodes: &HashSet<&'static str>,
) -> u64 {
    let mut leaves = Vec::new();
    let mut next_scope_id = 0usize;
    collect_dep_degree_leaves(
        function_node,
        None,
        "",
        &mut next_scope_id,
        function_nodes,
        &mut leaves,
        true,
    );
    let mut definition_scopes_by_name: HashMap<&str, Vec<String>> = HashMap::new();
    for name in implicit_accessor_definitions(function_node, code) {
        add_definition(&mut definition_scopes_by_name, name, "");
    }
    let mut pairs = 0u64;
    for index in 0..leaves.len() {
        let leaf = &leaves[index];
        if !is_variable_leaf(leaf.node) {
            continue;
        }
        let name = node_text(leaf.node, code);
        let next_text = leaves.get(index + 1).map(|next| node_text(next.node, code));
        if next_text.is_some_and(|next| COMPOUND_ASSIGNMENT_OPERATORS.contains(&next)) {
            if is_definition_visible(definition_scopes_by_name.get(name), &leaf.scope) {
                pairs += 1;
            }
            add_definition(&mut definition_scopes_by_name, name, &leaf.scope);
            continue;
        }
        if next_text.is_some_and(|next| PURE_ASSIGNMENT_OPERATORS.contains(&next))
            || is_structural_definition(leaf)
            || is_parameter_definition(leaf)
        {
            add_definition(&mut definition_scopes_by_name, name, &leaf.scope);
            continue;
        }
        if is_definition_visible(definition_scopes_by_name.get(name), &leaf.scope) {
            pairs += 1;
        }
    }
    pairs
}

/// A C++ member-pointer variable (`int C::* p`, also `int C::* arr[1]`) is declared as a
/// `type_identifier` under the `pointer_type_declarator` spelling `C::*`, possibly through further
/// declarator wrappers; every other `type_identifier` names a type, not a variable.
fn is_variable_leaf(node: Node<'_>) -> bool {
    VARIABLE_NODE_TYPES.contains(&node.kind())
        || crate::util::is_kotlin_callable_receiver(node)
        || (node.kind() == "type_identifier" && is_member_pointer_name(node))
}

fn is_member_pointer_name(node: Node<'_>) -> bool {
    let mut current = node;
    while let Some(parent) = current.parent() {
        if parent.kind() == "pointer_type_declarator" {
            return true;
        }
        // The climb follows the declared-name position only, exactly like unwrap_declarator_wrappers.
        if !DECLARATOR_WRAPPER_TYPES.contains(&parent.kind())
            || parent.kind() == "qualified_identifier"
            || field_name_in_parent(current, parent).is_some_and(|field| field != "declarator")
        {
            return false;
        }
        current = parent;
    }
    false
}

/// Names a C# accessor body can read without declaring them in its own subtree: the owning
/// indexer's parameters (including a `params` array, which the grammar names directly on the
/// parameter list) and, in a setter, initializer, or event accessor, the implicit `value`.
fn implicit_accessor_definitions<'a>(function_node: Node<'_>, code: &Source<'a>) -> Vec<&'a str> {
    if function_node.kind() != "accessor_declaration" {
        return Vec::new();
    }
    let mut names = Vec::new();
    if function_node
        .child_by_field_name("name")
        .is_some_and(|keyword| {
            matches!(node_text(keyword, code), "set" | "init" | "add" | "remove")
        })
    {
        names.push("value");
    }
    let owner = function_node.parent().and_then(|list| list.parent());
    if let Some(parameters) = owner
        .filter(|owner| owner.kind() == "indexer_declaration")
        .and_then(|owner| owner.child_by_field_name("parameters"))
    {
        let declared = crate::util::named_children(parameters)
            .into_iter()
            .filter_map(|parameter| parameter.child_by_field_name("name"))
            .chain(parameters.child_by_field_name("name"));
        names.extend(declared.map(|name| node_text(name, code)));
    }
    names
}

/// Collects non-comment leaves with their parent field (one cursor pass, so children of
/// high-arity nodes cost O(1)) and function-scope chain; mirrors collectDepDegreeLeaves.
#[allow(clippy::too_many_arguments)]
fn collect_dep_degree_leaves<'t>(
    node: Node<'t>,
    field_name: Option<&'static str>,
    scope: &str,
    next_scope_id: &mut usize,
    function_nodes: &HashSet<&'static str>,
    leaves: &mut Vec<DepDegreeLeaf<'t>>,
    is_measured_root: bool,
) {
    if matches!(
        node.kind(),
        "comment" | "line_comment" | "block_comment" | "multiline_comment"
    ) {
        return;
    }
    if is_identifier_leaf(node) {
        leaves.push(DepDegreeLeaf {
            node,
            field_name,
            scope: scope.to_string(),
        });
        return;
    }
    let child_scope = if !is_measured_root && is_function_boundary(node, function_nodes) {
        let scope = format!("{scope}/{next_scope_id}");
        *next_scope_id += 1;
        scope
    } else {
        scope.to_string()
    };
    let mut cursor = node.walk();
    if cursor.goto_first_child() {
        loop {
            collect_dep_degree_leaves(
                cursor.node(),
                cursor.field_name(),
                &child_scope,
                next_scope_id,
                function_nodes,
                leaves,
                false,
            );
            if !cursor.goto_next_sibling() {
                break;
            }
        }
    }
}

fn add_definition<'a>(
    definition_scopes_by_name: &mut HashMap<&'a str, Vec<String>>,
    name: &'a str,
    scope: &str,
) {
    let scopes = definition_scopes_by_name.entry(name).or_default();
    if !scopes.iter().any(|existing| existing == scope) {
        scopes.push(scope.to_string());
    }
}

/// A definition reaches a read only from the read's own or an enclosing function scope.
fn is_definition_visible(definition_scopes: Option<&Vec<String>>, scope: &str) -> bool {
    definition_scopes.is_some_and(|scopes| {
        scopes.iter().any(|definition_scope| {
            scope == definition_scope
                || (scope.len() > definition_scope.len()
                    && scope.starts_with(definition_scope.as_str())
                    && scope.as_bytes()[definition_scope.len()] == b'/')
        })
    })
}

fn is_structural_definition(leaf: &DepDegreeLeaf<'_>) -> bool {
    let Some(parent) = leaf.node.parent() else {
        return false;
    };
    if leaf.node.kind() == "simple_identifier"
        && KOTLIN_DEFINITION_PARENT_TYPES.contains(&parent.kind())
    {
        return true;
    }
    if leaf.node.kind() == "identifier"
        && CSHARP_QUERY_BINDING_PARENT_TYPES.contains(&parent.kind())
        && crate::util::named_children(parent)
            .into_iter()
            .find(|child| child.kind() == "identifier")
            .is_some_and(|first| first.id() == leaf.node.id())
    {
        return true;
    }
    let (declared, declared_field) = unwrap_declarator_wrappers(leaf);
    if declared
        .parent()
        .is_some_and(|holder| is_definition_field(holder, declared_field))
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

fn is_definition_field(holder: Node<'_>, field_name: Option<&str>) -> bool {
    DEFINITION_FIELD_BY_PARENT_TYPE
        .iter()
        .any(|(parent_type, definition_field)| {
            *parent_type == holder.kind() && field_name == Some(definition_field)
        })
}

/// Climbs from the identifier through the C/C++ declarator wrappers it is the declared name of
/// (`reference_declarator` and `parenthesized_declarator` expose no field, so their name is the
/// fieldless child; a member pointer's `pointer_type_declarator` is the `name` of a
/// `qualified_identifier`; an `array_declarator` size or a nested parameter has another field and
/// stops the climb) to the outermost wrapper and its field in the declaration.
fn unwrap_declarator_wrappers<'t>(leaf: &DepDegreeLeaf<'t>) -> (Node<'t>, Option<&'static str>) {
    let mut current = leaf.node;
    let mut field_name = leaf.field_name;
    while let Some(parent) = current
        .parent()
        .filter(|parent| DECLARATOR_WRAPPER_TYPES.contains(&parent.kind()))
    {
        let declared_field = if parent.kind() == "qualified_identifier" {
            "name"
        } else {
            "declarator"
        };
        if field_name.is_some_and(|name| name != declared_field) {
            break;
        }
        field_name = parent
            .parent()
            .and_then(|grandparent| field_name_in_parent(parent, grandparent));
        current = parent;
    }
    (current, field_name)
}

/// Mirrors isParameterDefinition in metrics.ts: an ancestor reached through declarator wrappers
/// (C/C++ function-pointer or array parameters) is a parameter-ish node, or the identifier
/// directly occupies a parameter field; type annotations and default values bind nothing.
fn is_parameter_definition(leaf: &DepDegreeLeaf<'_>) -> bool {
    // Kotlin has no `type`/`value` fields to veto default values: a function parameter's default
    // sits in the parameter list (`fun f(b: Int = a)`), a class parameter's inside the parameter
    // node (`class A(val y: Int = a)`), so only a parameter node's first identifier child binds.
    if leaf.node.kind() == "simple_identifier" {
        return leaf.node.parent().is_some_and(|parent| {
            KOTLIN_PARAMETER_TYPES.contains(&parent.kind())
                && crate::util::named_children(parent)
                    .into_iter()
                    .find(|child| child.kind() == "simple_identifier")
                    .is_some_and(|first| first.id() == leaf.node.id())
        });
    }
    let mut current = leaf.node;
    let mut depth = 0usize;
    // Only the member pointer's own declared name may climb past its qualified name; a size or
    // other expression inside the same declarator (`int C::* a[n]`) is a read.
    let declares_member_pointer = is_member_pointer_name(leaf.node);
    let mut in_member_pointer = false;
    loop {
        let Some(parent) = current.parent() else {
            return false;
        };
        let parent_is_parameterish = parent.kind().contains("parameter");
        // Beyond the grandparent, only declarator wrappers keep climbing, plus the
        // `qualified_identifier` nodes that spell a member-pointer parameter's class (`int C::* q`,
        // `int N::C::* q`) — entered from the pointer declarator and continued through the `name`
        // side, so a qualified constant in a default value or array size (`int x = N::M::C`) stays
        // a read. Checking this before the field lookup also keeps reads inside high-arity nodes
        // O(1).
        let continues_member_pointer = declares_member_pointer
            && parent.kind() == "qualified_identifier"
            && (current.kind() == "pointer_type_declarator" || in_member_pointer)
            && field_name_in_parent(current, parent) == Some("name");
        in_member_pointer = continues_member_pointer;
        if depth >= 1
            && !parent_is_parameterish
            && !parent.kind().contains("declarator")
            && !continues_member_pointer
        {
            return false;
        }
        let field = if depth == 0 {
            leaf.field_name
        } else {
            field_name_in_parent(current, parent)
        };
        if field.is_some_and(|name| NON_BINDING_PARAMETER_FIELDS.contains(&name)) {
            return false;
        }
        if parent_is_parameterish
            || (depth == 0 && field.is_some_and(|name| name.contains("parameter")))
        {
            return true;
        }
        current = parent;
        depth += 1;
    }
}

/// Only called with small-arity parents (declarator wrappers, definition-list holders).
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
