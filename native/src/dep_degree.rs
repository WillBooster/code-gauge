use rustc_hash::{FxHashMap, FxHashSet};
use tree_sitter::Node;

use crate::complexity::is_function_boundary;
use crate::tree_index::{KindSet, NodeExt};
use crate::util::{node_text, Source};

/// Leaf node types treated as variable references by the def-use approximation.
const VARIABLE_NODE_TYPES: &[&str] = &[
    "identifier",
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

/// Kotlin marks no binding fields: an identifier directly under one of these declares a binding
/// (`val x`, `for (x in xs)`, lambda parameters, and the `catch (e: T)` exception name).
const KOTLIN_DEFINITION_PARENT_TYPES: &[&str] = &["variable_declaration", "catch_block"];

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

/// One leaf of the def-use walk: its field in the parent and its function scope.
struct DepDegreeLeaf<'t> {
    node: Node<'t>,
    field_name: Option<&'t str>,
    /// Preorder number of the innermost function scope holding the leaf (see LeafWalk).
    scope: usize,
}

/// The non-comment leaves of a subtree in walk order, with the function scopes they lie in.
struct LeafWalk<'t> {
    leaves: Vec<DepDegreeLeaf<'t>>,
    /// The last scope nested in each scope, by preorder number; scope 0 is the walked subtree's
    /// own, and scope `outer` encloses scope `inner` exactly when
    /// `outer <= inner && inner <= last_nested_scopes[outer]`.
    last_nested_scopes: Vec<usize>,
    /// The leaf range and body scope of each function, by node id, whose subtree the walk entered.
    function_spans: FxHashMap<usize, (std::ops::Range<usize>, usize)>,
}

/// What a variable leaf does in the def-use walk, which depends only on the leaf and the leaf
/// after it.
#[derive(Clone, Copy)]
struct VariableUse<'a> {
    name: &'a str,
    next_operator: Option<AssignmentOperator>,
    /// Whether the leaf is a definition even when no assignment operator follows it.
    is_binding: bool,
}

#[derive(Clone, Copy, PartialEq)]
enum AssignmentOperator {
    Pure,
    Compound,
}

/// Approximate def-use pairs of the subtree of each function in `functions`, by node id: one walk
/// of the file gathers every function's leaves, since a function's leaves and the scopes they lie
/// in are the same wherever the walk starts.
pub fn measure_dep_degrees(
    root: Node<'_>,
    functions: &[Node<'_>],
    code: &Source<'_>,
    function_nodes: &KindSet,
) -> FxHashMap<usize, u64> {
    let walk = LeafWalk::new(
        root,
        function_nodes,
        &functions.iter().map(Node::id).collect(),
    );
    let mut variable_uses = vec![None; walk.leaves.len()];
    functions
        .iter()
        .map(|&function_node| {
            let pairs = match walk.function_spans.get(&function_node.id()) {
                Some((leaf_range, body_scope)) => count_pairs(
                    &walk,
                    leaf_range.clone(),
                    *body_scope,
                    function_node,
                    code,
                    &mut variable_uses,
                ),
                // The walk does not enter a function that is a token itself or lies in a comment.
                None => measure_dep_degree(function_node, code, function_nodes),
            };
            (function_node.id(), pairs)
        })
        .collect()
}

/// Approximate def-use pairs of the function's subtree.
fn measure_dep_degree(function_node: Node<'_>, code: &Source<'_>, function_nodes: &KindSet) -> u64 {
    let walk = LeafWalk::new(function_node, function_nodes, &FxHashSet::default());
    let mut variable_uses = vec![None; walk.leaves.len()];
    count_pairs(
        &walk,
        0..walk.leaves.len(),
        0,
        function_node,
        code,
        &mut variable_uses,
    )
}

/// The def-use pairs among the leaves in `leaf_range` of the function whose own body is
/// `body_scope`; `variable_uses` caches what each leaf of the walk does, as `Some(None)` for a
/// leaf that is no variable.
fn count_pairs<'a>(
    walk: &LeafWalk<'_>,
    leaf_range: std::ops::Range<usize>,
    body_scope: usize,
    function_node: Node<'_>,
    code: &Source<'a>,
    variable_uses: &mut [Option<Option<VariableUse<'a>>>],
) -> u64 {
    let is_visible = |definition_scopes: Option<&Vec<usize>>, scope: usize| {
        definition_scopes.is_some_and(|scopes| {
            scopes
                .iter()
                .any(|&outer| outer <= scope && scope <= walk.last_nested_scopes[outer])
        })
    };
    let mut definition_scopes_by_name: FxHashMap<&str, Vec<usize>> = FxHashMap::default();
    for name in implicit_accessor_definitions(function_node, code) {
        add_definition(&mut definition_scopes_by_name, name, body_scope);
    }
    let leaf_end = leaf_range.end;
    let mut pairs = 0u64;
    for index in leaf_range {
        let leaf = &walk.leaves[index];
        let Some(variable_use) =
            *variable_uses[index].get_or_insert_with(|| variable_use(&walk.leaves, index, code))
        else {
            continue;
        };
        let name = variable_use.name;
        // The function's last leaf has no next leaf within the function.
        let next_operator = variable_use.next_operator.filter(|_| index + 1 != leaf_end);
        if next_operator == Some(AssignmentOperator::Compound) {
            if is_visible(definition_scopes_by_name.get(name), leaf.scope) {
                pairs += 1;
            }
            add_definition(&mut definition_scopes_by_name, name, leaf.scope);
            continue;
        }
        if next_operator == Some(AssignmentOperator::Pure) || variable_use.is_binding {
            add_definition(&mut definition_scopes_by_name, name, leaf.scope);
            continue;
        }
        if is_visible(definition_scopes_by_name.get(name), leaf.scope) {
            pairs += 1;
        }
    }
    pairs
}

fn variable_use<'a>(
    leaves: &[DepDegreeLeaf<'_>],
    index: usize,
    code: &Source<'a>,
) -> Option<VariableUse<'a>> {
    let leaf = &leaves[index];
    if !is_variable_leaf(leaf) {
        return None;
    }
    let next_text = leaves.get(index + 1).map(|next| node_text(next.node, code));
    Some(VariableUse {
        name: node_text(leaf.node, code),
        next_operator: next_text.and_then(|next| {
            if COMPOUND_ASSIGNMENT_OPERATORS.contains(&next) {
                Some(AssignmentOperator::Compound)
            } else if PURE_ASSIGNMENT_OPERATORS.contains(&next) {
                Some(AssignmentOperator::Pure)
            } else {
                None
            }
        }),
        is_binding: is_structural_definition(leaf) || is_parameter_definition(leaf),
    })
}

/// Kotlin spells type names as identifiers: in a `user_type`, or as a type parameter's fieldless
/// name (C# puts its type parameter in a `name` field).
fn is_variable_leaf(leaf: &DepDegreeLeaf<'_>) -> bool {
    let node = leaf.node;
    VARIABLE_NODE_TYPES.contains(&node.kind_name())
        && !node.parent_node().is_some_and(|parent| {
            parent.kind_name() == "user_type"
                || (parent.kind_name() == "type_parameter" && leaf.field_name.is_none())
        })
}

/// Whether the identifier is the name a C++ member pointer declares (`int C::* p`, also
/// `int C::* arr[1]`): its `pointer_declarator`, possibly around further declarator wrappers, is
/// the `name` of the `qualified_identifier` spelling the class.
fn is_member_pointer_name(node: Node<'_>) -> bool {
    let mut current = node;
    while let Some(parent) = current.parent_node() {
        // The kind is tested before the field is looked up: this runs for every variable read,
        // and scanning the children of a high-arity parent (a list of arguments) each time would
        // cost the square of its length.
        if parent.kind_name() == "qualified_identifier" {
            return current.kind_name() == "pointer_declarator"
                && field_name_in_parent(current, parent) == Some("name");
        }
        // The climb follows the declared-name position only, exactly like unwrap_declarator_wrappers.
        if !DECLARATOR_WRAPPER_TYPES.contains(&parent.kind_name())
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
    if function_node.kind_name() != "accessor_declaration" {
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
    let owner = function_node
        .parent_node()
        .and_then(|list| list.parent_node());
    if let Some(parameters) = owner
        .filter(|owner| owner.kind_name() == "indexer_declaration")
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

impl<'t> LeafWalk<'t> {
    /// Walks the subtree of `root`, recording the span of each function in `function_ids` it
    /// enters.
    fn new(
        root: Node<'t>,
        function_nodes: &KindSet,
        function_ids: &FxHashSet<usize>,
    ) -> LeafWalk<'t> {
        let mut walk = LeafWalk {
            leaves: Vec::new(),
            last_nested_scopes: vec![0],
            function_spans: FxHashMap::default(),
        };
        walk.visit(root, None, 0, function_nodes, function_ids, true);
        // The walked subtree's own scope encloses every scope opened inside it.
        walk.last_nested_scopes[0] = walk.last_nested_scopes.len() - 1;
        walk
    }

    fn visit(
        &mut self,
        node: Node<'t>,
        field_name: Option<&'t str>,
        scope: usize,
        function_nodes: &KindSet,
        function_ids: &FxHashSet<usize>,
        is_walked_root: bool,
    ) {
        if matches!(
            node.kind_name(),
            "comment" | "line_comment" | "block_comment"
        ) {
            return;
        }
        if crate::util::is_token(node) {
            self.leaves.push(DepDegreeLeaf {
                node,
                field_name,
                scope,
            });
            return;
        }
        let opens_scope = !is_walked_root && is_function_boundary(node, function_nodes);
        let child_scope = if opens_scope {
            self.last_nested_scopes.push(0);
            self.last_nested_scopes.len() - 1
        } else {
            scope
        };
        let first_leaf = self.leaves.len();
        for (child, child_field_name) in crate::util::children_with_field_names(node) {
            self.visit(
                child,
                child_field_name,
                child_scope,
                function_nodes,
                function_ids,
                false,
            );
        }
        if opens_scope {
            self.last_nested_scopes[child_scope] = self.last_nested_scopes.len() - 1;
        }
        // Every measured function is a function boundary; one the walk does not record is
        // measured on its own.
        if (opens_scope || is_walked_root) && function_ids.contains(&node.id()) {
            self.function_spans
                .insert(node.id(), (first_leaf..self.leaves.len(), child_scope));
        }
    }
}

fn add_definition<'a>(
    definition_scopes_by_name: &mut FxHashMap<&'a str, Vec<usize>>,
    name: &'a str,
    scope: usize,
) {
    let scopes = definition_scopes_by_name.entry(name).or_default();
    if !scopes.contains(&scope) {
        scopes.push(scope);
    }
}

fn is_structural_definition(leaf: &DepDegreeLeaf<'_>) -> bool {
    let Some(parent) = leaf.node.parent_node() else {
        return false;
    };
    // C#'s `variable_declaration` holds its type in the `type` field; Kotlin's bound name has none.
    if leaf.node.kind_name() == "identifier"
        && leaf.field_name.is_none()
        && KOTLIN_DEFINITION_PARENT_TYPES.contains(&parent.kind_name())
    {
        return true;
    }
    if leaf.node.kind_name() == "identifier"
        && CSHARP_QUERY_BINDING_PARENT_TYPES.contains(&parent.kind_name())
        && crate::util::named_children(parent)
            .into_iter()
            .find(|child| child.kind_name() == "identifier")
            .is_some_and(|first| first.id() == leaf.node.id())
    {
        return true;
    }
    let (declared, declared_field) = unwrap_declarator_wrappers(leaf);
    if declared
        .parent_node()
        .is_some_and(|holder| is_definition_field(holder, declared_field))
    {
        return true;
    }
    if !DEFINITION_LIST_NODE_TYPES.contains(&parent.kind_name()) {
        return false;
    }
    let Some(holder) = parent.parent_node() else {
        return false;
    };
    DEFINITION_LIST_HOLDER_TYPES.contains(&holder.kind_name())
        && field_name_in_parent(parent, holder) == Some("left")
}

fn is_definition_field(holder: Node<'_>, field_name: Option<&str>) -> bool {
    DEFINITION_FIELD_BY_PARENT_TYPE
        .iter()
        .any(|(parent_type, definition_field)| {
            *parent_type == holder.kind_name() && field_name == Some(definition_field)
        })
}

/// Climbs from the identifier through the C/C++ declarator wrappers it is the declared name of
/// (`reference_declarator` and `parenthesized_declarator` expose no field, so their name is the
/// fieldless child; a member pointer's `pointer_declarator` is the `name` of a
/// `qualified_identifier`; an `array_declarator` size or a nested parameter has another field and
/// stops the climb) to the outermost wrapper and its field in the declaration.
fn unwrap_declarator_wrappers<'t>(leaf: &DepDegreeLeaf<'t>) -> (Node<'t>, Option<&'t str>) {
    let mut current = leaf.node;
    let mut field_name = leaf.field_name;
    while let Some(parent) = current
        .parent_node()
        .filter(|parent| DECLARATOR_WRAPPER_TYPES.contains(&parent.kind_name()))
    {
        let declared_field = if parent.kind_name() == "qualified_identifier" {
            "name"
        } else {
            "declarator"
        };
        if field_name.is_some_and(|name| name != declared_field) {
            break;
        }
        field_name = parent
            .parent_node()
            .and_then(|grandparent| field_name_in_parent(parent, grandparent));
        current = parent;
    }
    (current, field_name)
}

/// Whether an identifier defines a parameter: an ancestor reached through declarator wrappers
/// (C/C++ function-pointer or array parameters) is a parameter-ish node, or the identifier
/// directly occupies a parameter field; type annotations and default values bind nothing.
fn is_parameter_definition(leaf: &DepDegreeLeaf<'_>) -> bool {
    let mut current = leaf.node;
    let mut depth = 0usize;
    // Only the member pointer's own declared name may climb past its qualified name; a size or
    // other expression inside the same declarator (`int C::* a[n]`) is a read.
    let declares_member_pointer = is_member_pointer_name(leaf.node);
    let mut in_member_pointer = false;
    loop {
        let Some(parent) = current.parent_node() else {
            return false;
        };
        // Kotlin has no `type`/`value` fields to veto default values: a function parameter's default
        // sits in the parameter list (`fun f(b: Int = a)`), a class parameter's inside the parameter
        // node (`class A(val y: Int = a)`), so only such a node's first identifier child binds.
        if parent.kind_name() == "function_value_parameters" {
            return false;
        }
        if is_kotlin_parameter(parent) {
            return depth == 0
                && crate::util::named_children(parent)
                    .into_iter()
                    .find(|child| child.kind_name() == "identifier")
                    .is_some_and(|first| first.id() == leaf.node.id());
        }
        let parent_is_parameterish = parent.kind_name().contains("parameter");
        // Beyond the grandparent, only declarator wrappers keep climbing, plus the
        // `qualified_identifier` nodes that spell a member-pointer parameter's class (`int C::* q`,
        // `int N::C::* q`) — entered from the pointer declarator and continued through the `name`
        // side, so a qualified constant in a default value or array size (`int x = N::M::C`) stays
        // a read. Checking this before the field lookup also keeps reads inside high-arity nodes
        // O(1).
        let continues_member_pointer = declares_member_pointer
            && parent.kind_name() == "qualified_identifier"
            && (current.kind_name() == "pointer_declarator" || in_member_pointer)
            && field_name_in_parent(current, parent) == Some("name");
        in_member_pointer = continues_member_pointer;
        if depth >= 1
            && !parent_is_parameterish
            && !parent.kind_name().contains("declarator")
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

/// A Kotlin class parameter, or a setter's parameter list (`set(value)`; Ruby's `setter` is a method
/// name, never under a property).
fn is_kotlin_parameter(node: Node<'_>) -> bool {
    node.kind_name() == "class_parameter"
        || (node.kind_name() == "setter"
            && node
                .parent_node()
                .is_some_and(|property| property.kind_name() == "property_declaration"))
}

/// Only called with small-arity parents (declarator wrappers, definition-list holders).
fn field_name_in_parent<'t>(node: Node<'_>, parent: Node<'t>) -> Option<&'t str> {
    for index in 0..parent.child_count() {
        if let Some(child) = parent.child(index) {
            if child.id() == node.id() {
                return parent.field_name_for_child(index);
            }
        }
    }
    None
}
