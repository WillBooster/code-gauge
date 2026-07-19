use indexmap::IndexSet;
use std::collections::HashSet;
use tree_sitter::Node;

use crate::complexity::{is_function_boundary, measure_complexity, LanguageSets};
use crate::util::{
    all_children, find_children_by_field_name, named_children, node_text, strip_js_whitespace,
    Source,
};

pub struct FunctionAnalysis {
    pub index: usize,
    pub name: Option<String>,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub returns_jsx: bool,
    pub cyclomatic_complexity: u64,
    pub cognitive_complexity: u64,
    pub nesting_depth: u64,
    pub call_count: u64,
    pub parameter_count: usize,
    pub callees: IndexSet<String>,
    pub identifiers: HashSet<String>,
}

pub struct CallsResult {
    pub call_count: u64,
    pub callees: IndexSet<String>,
}

/// C++ `function_definition` also covers pure-virtual/`= default`/`= delete` members and Java
/// `method_declaration` covers abstract/interface methods; those are signatures, not implementations.
const BODY_REQUIRED_FUNCTION_TYPES: &[&str] = &[
    "function_definition",
    "method_declaration",
    "constructor_declaration",
    "compact_constructor_declaration",
    "function_signature_item",
];

pub fn is_implemented_function(node: Node<'_>) -> bool {
    if !BODY_REQUIRED_FUNCTION_TYPES.contains(&node.kind())
        || node.child_by_field_name("body").is_some()
    {
        return true;
    }

    // C++ constructor/destructor function-try-blocks carry their `try_statement` outside the
    // `body` field; they are implementations, unlike `= 0`/`= default`/`= delete` members.
    named_children(node)
        .iter()
        .any(|child| child.kind() == "try_statement")
}

pub fn analyze_function(
    node: Node<'_>,
    sets: &LanguageSets,
    index: usize,
    constructed_type_names: &HashSet<String>,
    code: &Source<'_>,
) -> FunctionAnalysis {
    let complexity = measure_complexity(node, sets, 0, true, code);
    let calls = collect_calls(node, sets, constructed_type_names, code);
    FunctionAnalysis {
        index,
        name: find_function_name(node, code),
        start_line: node.start_position().row + 1,
        // The tree is parsed from UTF-16, so columns are UTF-16 code units x 2 — halving yields
        // the code-unit column node-tree-sitter reports.
        start_column: node.start_position().column / 2,
        end_line: node.end_position().row + 1,
        returns_jsx: returns_jsx(node, sets, code),
        cyclomatic_complexity: complexity.cyclomatic_complexity,
        cognitive_complexity: complexity.cognitive_complexity,
        nesting_depth: complexity.nesting_depth,
        call_count: calls.call_count,
        parameter_count: count_parameters(node, code),
        callees: calls.callees,
        identifiers: collect_identifiers(node, code),
    }
}

/// Counts declared parameters of a function/method, ignoring punctuation and comments.
fn count_parameters(node: Node<'_>, code: &Source<'_>) -> usize {
    // An unparenthesized arrow-function parameter (`x => x + 1`) is a bare `parameter` field.
    if node.child_by_field_name("parameter").is_some() {
        return 1;
    }

    let Some(parameters_node) = find_parameters_node(node) else {
        return 0;
    };

    // A Java bare lambda parameter (`x -> x + 1`) puts a lone identifier in the `parameters` field.
    if parameters_node.kind() == "identifier" {
        return 1;
    }

    // Ruby block-locals after `;` (`{ |x; memo| ... }`) occupy `locals` fields and receive no arguments.
    let block_local_ids: HashSet<usize> = find_children_by_field_name(parameters_node, "locals")
        .iter()
        .map(|child| child.id())
        .collect();
    let named_count: usize = named_children(parameters_node)
        .iter()
        .filter(|child| {
            child.kind() != "comment"
                && child.kind() != "self_parameter"
                && child.kind() != "receiver_parameter"
                && child.kind() != "positional_separator"
                && child.kind() != "keyword_separator"
                && !block_local_ids.contains(&child.id())
                && !is_void_parameter(**child, code)
        })
        // Go declares several names per declaration (`a, b int`); each name is a parameter.
        .map(|child| {
            if child.kind() == "parameter_declaration" {
                find_children_by_field_name(*child, "name").len().max(1)
            } else {
                1
            }
        })
        .sum();
    // C++ C-style varargs (`int f(int a, ...)`) leave `...` as an anonymous token.
    let anonymous_variadic_count = all_children(parameters_node)
        .iter()
        .filter(|child| !child.is_named() && node_text(**child, code) == "...")
        .count();
    named_count + anonymous_variadic_count
}

/// C/C++ `int f(void)` has a `parameter_declaration` whose type is a bare `void` with no declarator.
fn is_void_parameter(node: Node<'_>, code: &Source<'_>) -> bool {
    node.kind() == "parameter_declaration"
        && node.child_by_field_name("declarator").is_none()
        && node
            .child_by_field_name("type")
            .is_some_and(|type_node| node_text(type_node, code) == "void")
}

fn find_parameters_node(node: Node<'_>) -> Option<Node<'_>> {
    if let Some(direct) = node.child_by_field_name("parameters") {
        return Some(direct);
    }

    // A Java compact constructor implicitly takes the record's components, declared on the
    // `record_declaration` two levels up (via `class_body`).
    if node.kind() == "compact_constructor_declaration" {
        return node
            .parent()
            .and_then(|parent| parent.parent())
            .and_then(|grandparent| grandparent.child_by_field_name("parameters"));
    }

    // C/C++ parameters hang off the (possibly pointer/reference-wrapped) declarator.
    let mut declarator = node.child_by_field_name("declarator");
    while let Some(current) = declarator {
        if let Some(parameters) = current.child_by_field_name("parameters") {
            return Some(parameters);
        }
        declarator = next_declarator(current);
    }

    named_children(node)
        .into_iter()
        .find(|child| child.kind() == "formal_parameters" || child.kind() == "parameter_list")
}

pub fn collect_calls(
    root: Node<'_>,
    sets: &LanguageSets,
    constructed_type_names: &HashSet<String>,
    code: &Source<'_>,
) -> CallsResult {
    let mut callees: IndexSet<String> = IndexSet::new();
    let mut call_count: u64 = 0;

    fn visit(
        node: Node<'_>,
        inside_root: bool,
        sets: &LanguageSets,
        constructed_type_names: &HashSet<String>,
        code: &Source<'_>,
        call_count: &mut u64,
        callees: &mut IndexSet<String>,
    ) {
        if !inside_root && is_function_boundary(node, &sets.function_nodes) {
            return;
        }

        // C++ casts (`int(x)`, `static_cast<int>(x)`) parse as call expressions but invoke nothing.
        if sets.name == "cpp" && is_cpp_cast_expression(node, code) {
            // Not a call: fall through to children only.
        } else if is_call_node(node) {
            *call_count += 1;
            // C++ `new Widget()` and functional construction name an overloaded constructor, so they
            // count as calls without a callee edge. JS `new Foo()` keeps its edge to the function.
            let is_cpp_constructor_call = sets.name == "cpp"
                && (node.kind() == "new_expression"
                    || (node.kind() == "call_expression"
                        && cpp_base_type_name(node.child_by_field_name("function"), code)
                            .is_some_and(|name| constructed_type_names.contains(&name))));
            let callee = if is_cpp_constructor_call {
                None
            } else {
                find_callee_name(node, code)
            };
            // JS truthiness: `if (callee)` also drops the empty string a MISSING node produces.
            if let Some(callee) = callee.filter(|callee| !callee.is_empty()) {
                callees.insert(callee);
            }
            // Ruby abbreviated assignment on a receiver (`self.foo += 1`) invokes the getter AND the
            // setter, so the setter is one extra call.
            if sets.name == "ruby"
                && node.kind() == "call"
                && node.parent().is_some_and(|parent| {
                    parent.kind() == "operator_assignment"
                        && parent
                            .child_by_field_name("left")
                            .is_some_and(|left| left.id() == node.id())
                })
            {
                *call_count += 1;
                if let Some(setter_method) = node.child_by_field_name("method") {
                    callees.insert(format!("{}=", node_text(setter_method, code)));
                }
            }
        } else if is_ruby_implicit_call(node, sets)
            || is_cpp_construction(node, constructed_type_names, code)
        {
            // `yield x` invokes the block, not its argument, and constructors are overloaded by
            // definition, so neither adds a callee edge.
            *call_count += 1;
        }

        for child in named_children(node) {
            visit(
                child,
                false,
                sets,
                constructed_type_names,
                code,
                call_count,
                callees,
            );
        }
    }

    visit(
        root,
        true,
        sets,
        constructed_type_names,
        code,
        &mut call_count,
        &mut callees,
    );
    CallsResult {
        call_count,
        callees,
    }
}

const CPP_NAMED_CASTS: &[&str] = &[
    "static_cast",
    "dynamic_cast",
    "const_cast",
    "reinterpret_cast",
];

/// C++ casts parse as call expressions (`int(x)`, `static_cast<int>(x)`) but invoke nothing.
fn is_cpp_cast_expression(node: Node<'_>, code: &Source<'_>) -> bool {
    if node.kind() != "call_expression" {
        return false;
    }
    let callee = node.child_by_field_name("function");
    if callee.is_some_and(|callee| callee.kind() == "primitive_type") {
        return true;
    }
    let name = match callee {
        Some(callee) if callee.kind() == "template_function" => callee
            .child_by_field_name("name")
            .map(|name| node_text(name, code)),
        Some(callee) => Some(node_text(callee, code)),
        None => None,
    };
    name.is_some_and(|name| CPP_NAMED_CASTS.contains(&name))
}

/// C++ direct and list construction (`Foo a(1)`, `Foo b{2}`, `Foo{3}`) invoke a constructor without
/// a call node. Only types defined in the measured tree count.
fn is_cpp_construction(
    node: Node<'_>,
    constructed_type_names: &HashSet<String>,
    code: &Source<'_>,
) -> bool {
    if constructed_type_names.is_empty() {
        return false;
    }
    if node.kind() == "compound_literal_expression" {
        return cpp_base_type_name(node.child_by_field_name("type"), code)
            .is_some_and(|name| constructed_type_names.contains(&name));
    }
    if node.kind() == "init_declarator" {
        let value = node.child_by_field_name("value");
        if !value.is_some_and(|value| {
            value.kind() == "argument_list" || value.kind() == "initializer_list"
        }) {
            return false;
        }
        return cpp_base_type_name(
            node.parent()
                .and_then(|parent| parent.child_by_field_name("type")),
            code,
        )
        .is_some_and(|name| constructed_type_names.contains(&name));
    }
    // Default construction (`Widget value;`, `Widget values[2];`): a bare identifier or array
    // declarator of a local class type.
    if (node.kind() == "identifier" || node.kind() == "array_declarator")
        && node
            .parent()
            .is_some_and(|parent| parent.kind() == "declaration")
        && node.parent().is_some_and(|parent| {
            find_children_by_field_name(parent, "declarator")
                .iter()
                .any(|declarator| declarator.id() == node.id())
                && !has_storage_class(parent, "extern", code)
        })
    {
        let mut current = Some(node);
        while current.is_some_and(|current| current.kind() == "array_declarator") {
            current = current.and_then(|current| current.child_by_field_name("declarator"));
        }
        return current.is_some_and(|current| current.kind() == "identifier")
            && cpp_base_type_name(
                node.parent()
                    .and_then(|parent| parent.child_by_field_name("type")),
                code,
            )
            .is_some_and(|name| constructed_type_names.contains(&name));
    }
    // Base/delegating constructor initializers (`Widget() : Base(1) {}`).
    if node.kind() == "field_initializer" {
        let name_node = node.named_child(0);
        let name = match name_node {
            Some(name_node) if name_node.kind() == "field_identifier" => {
                Some(node_text(name_node, code).to_string())
            }
            _ => cpp_base_type_name(name_node, code),
        };
        return name.is_some_and(|name| constructed_type_names.contains(&name));
    }
    false
}

/// Base name of a possibly qualified/templated C++ type or callee (`ns::Box<int>` -> `Box`).
pub fn cpp_base_type_name(node: Option<Node<'_>>, code: &Source<'_>) -> Option<String> {
    let mut current = node;
    while let Some(node) = current {
        match node.kind() {
            "type_identifier" | "identifier" => return Some(node_text(node, code).to_string()),
            "qualified_identifier"
            | "scoped_identifier"
            | "template_type"
            | "template_function" => {
                current = node.child_by_field_name("name");
            }
            _ => return None,
        }
    }
    None
}

const CPP_CLASS_SPECIFIER_TYPES: &[&str] =
    &["class_specifier", "struct_specifier", "union_specifier"];

/// Names of C++ class-like types defined (with a body) in this tree, for construction counting.
pub fn collect_constructed_type_names(
    root: Node<'_>,
    sets: &LanguageSets,
    code: &Source<'_>,
) -> HashSet<String> {
    let mut names = HashSet::new();
    if sets.name != "cpp" {
        return names;
    }
    let specifier_types: HashSet<&'static str> =
        CPP_CLASS_SPECIFIER_TYPES.iter().copied().collect();
    for node in collect_nodes(root, &specifier_types) {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = node_text(name_node, code);
            if !name.is_empty() && node.child_by_field_name("body").is_some() {
                names.insert(name.to_string());
            }
        }
    }
    names
}

/// `storage_class_specifier` exists only in the C/C++ grammars, so this is language-safe.
pub fn has_storage_class(node: Node<'_>, keyword: &str, code: &Source<'_>) -> bool {
    all_children(node).iter().any(|child| {
        child.kind() == "storage_class_specifier" && node_text(*child, code) == keyword
    })
}

/// Ruby's bare `yield` and `super` invoke without a `call` node (only `super()` parses as `call`).
fn is_ruby_implicit_call(node: Node<'_>, sets: &LanguageSets) -> bool {
    if sets.name != "ruby" {
        return false;
    }
    node.kind() == "yield"
        || (node.kind() == "super" && node.parent().is_none_or(|parent| parent.kind() != "call"))
}

pub fn collect_identifiers(root: Node<'_>, code: &Source<'_>) -> HashSet<String> {
    let mut identifiers = HashSet::new();

    fn visit(node: Node<'_>, code: &Source<'_>, identifiers: &mut HashSet<String>) {
        match node.kind() {
            "identifier"
            | "property_identifier"
            | "field_identifier"
            | "constant"
            | "instance_variable"
            | "class_variable"
            | "global_variable" => {
                identifiers.insert(node_text(node, code).to_string());
            }
            _ => {}
        }

        for child in named_children(node) {
            visit(child, code, identifiers);
        }
    }

    visit(root, code, &mut identifiers);
    identifiers
}

/// C/C++ `struct Foo`-style type references reuse the declaration node type, so a body is required.
pub fn count_classes(root: Node<'_>, sets: &LanguageSets) -> usize {
    collect_nodes(root, &sets.class_nodes)
        .into_iter()
        .filter(|node| is_countable_class_node(*node))
        .count()
}

/// C/C++ `struct Foo;` forward declarations define no class, and Java `new Runnable() { ... }` /
/// enum constants define an anonymous class only when they carry a `class_body` (JLS 15.9.5).
fn is_countable_class_node(node: Node<'_>) -> bool {
    if node.kind() == "object_creation_expression" || node.kind() == "enum_constant" {
        return named_children(node)
            .iter()
            .any(|child| child.kind() == "class_body");
    }
    !node.kind().ends_with("_specifier") || node.child_by_field_name("body").is_some()
}

pub fn collect_nodes<'t>(root: Node<'t>, node_types: &HashSet<&'static str>) -> Vec<Node<'t>> {
    let mut nodes = Vec::new();

    fn visit<'t>(node: Node<'t>, node_types: &HashSet<&'static str>, nodes: &mut Vec<Node<'t>>) {
        if node_types.contains(node.kind()) {
            nodes.push(node);
        }

        for child in named_children(node) {
            visit(child, node_types, nodes);
        }
    }

    visit(root, node_types, &mut nodes);
    nodes
}

pub fn returns_jsx(root: Node<'_>, sets: &LanguageSets, code: &Source<'_>) -> bool {
    fn visit(
        node: Node<'_>,
        inside_root: bool,
        root: Node<'_>,
        sets: &LanguageSets,
        code: &Source<'_>,
    ) -> bool {
        if !inside_root && sets.function_nodes.contains(node.kind()) {
            return false;
        }

        if node.kind() == "return_statement" {
            return contains_jsx_expression(node, sets, code)
                || contains_react_create_element_call(node, sets, code);
        }

        if root.kind() == "arrow_function"
            && get_arrow_function_body(root).is_some_and(|body| body.id() == node.id())
            && node.kind() != "statement_block"
            && !sets.function_nodes.contains(node.kind())
        {
            return contains_jsx_expression(node, sets, code)
                || contains_react_create_element_call(node, sets, code);
        }

        named_children(node)
            .into_iter()
            .any(|child| visit(child, false, root, sets, code))
    }

    visit(root, true, root, sets, code)
}

fn get_arrow_function_body(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("body").or_else(|| {
        node.named_child_count()
            .checked_sub(1)
            .and_then(|last| node.named_child(last))
    })
}

fn contains_jsx_expression(root: Node<'_>, sets: &LanguageSets, code: &Source<'_>) -> bool {
    contains_node(root, sets, &|node| {
        node.kind().starts_with("jsx_") || is_jsx_mapping_call(node, sets, code)
    })
}

fn contains_react_create_element_call(
    root: Node<'_>,
    sets: &LanguageSets,
    code: &Source<'_>,
) -> bool {
    contains_node(root, sets, &|node| is_react_create_element_call(node, code))
}

fn contains_node(
    root: Node<'_>,
    sets: &LanguageSets,
    predicate: &dyn Fn(Node<'_>) -> bool,
) -> bool {
    fn visit(
        node: Node<'_>,
        inside_root: bool,
        sets: &LanguageSets,
        predicate: &dyn Fn(Node<'_>) -> bool,
    ) -> bool {
        if !inside_root && sets.function_nodes.contains(node.kind()) {
            return false;
        }

        if predicate(node) {
            return true;
        }

        named_children(node)
            .into_iter()
            .any(|child| visit(child, false, sets, predicate))
    }

    visit(root, true, sets, predicate)
}

fn is_jsx_mapping_call(node: Node<'_>, sets: &LanguageSets, code: &Source<'_>) -> bool {
    if !is_call_node(node)
        || !is_array_mapping_callee(
            node.child_by_field_name("function")
                .or_else(|| node.named_child(0)),
            code,
        )
    {
        return false;
    }

    named_children(node)
        .into_iter()
        .any(|child| contains_returned_jsx_function(child, sets, code))
}

fn is_array_mapping_callee(node: Option<Node<'_>>, code: &Source<'_>) -> bool {
    let Some(node) = node else {
        return false;
    };

    let callee_name = find_rightmost_identifier(node, code);
    callee_name.as_deref() == Some("map") || callee_name.as_deref() == Some("flatMap")
}

fn contains_returned_jsx_function(root: Node<'_>, sets: &LanguageSets, code: &Source<'_>) -> bool {
    if sets.function_nodes.contains(root.kind()) {
        return returns_jsx_from_function_node(root, sets, code);
    }

    named_children(root)
        .into_iter()
        .any(|child| contains_returned_jsx_function(child, sets, code))
}

fn returns_jsx_from_function_node(root: Node<'_>, sets: &LanguageSets, code: &Source<'_>) -> bool {
    let body = if root.kind() == "arrow_function" {
        get_arrow_function_body(root)
    } else {
        None
    };
    if let Some(body) = body {
        if body.kind() != "statement_block" && !sets.function_nodes.contains(body.kind()) {
            return contains_jsx_expression(body, sets, code)
                || contains_react_create_element_call(body, sets, code);
        }
    }

    contains_own_return_node(root, sets, &|node| {
        contains_jsx_expression(node, sets, code)
            || contains_react_create_element_call(node, sets, code)
    })
}

fn contains_own_return_node(
    root: Node<'_>,
    sets: &LanguageSets,
    predicate: &dyn Fn(Node<'_>) -> bool,
) -> bool {
    fn visit(
        node: Node<'_>,
        inside_root: bool,
        sets: &LanguageSets,
        predicate: &dyn Fn(Node<'_>) -> bool,
    ) -> bool {
        if !inside_root && sets.function_nodes.contains(node.kind()) {
            return false;
        }

        if node.kind() == "return_statement" && predicate(node) {
            return true;
        }

        named_children(node)
            .into_iter()
            .any(|child| visit(child, false, sets, predicate))
    }

    visit(root, true, sets, predicate)
}

pub fn find_function_name(node: Node<'_>, code: &Source<'_>) -> Option<String> {
    // JS truthiness: empty strings from MISSING nodes act like "no name" at every `if (name)`.
    if let Some(wrapped_name) =
        find_wrapped_component_name(node, code).filter(|name| !name.is_empty())
    {
        return Some(wrapped_name);
    }

    if let Some(name_node) = node.child_by_field_name("name") {
        return Some(node_text(name_node, code).to_string());
    }

    // C/C++ definitions name the function inside the (possibly pointer-wrapped) declarator chain.
    if let Some(declarator_name) =
        unwrap_declarator_name(node.child_by_field_name("declarator"), false, code)
            .filter(|name| !name.is_empty())
    {
        return Some(declarator_name);
    }

    let parent = node.parent()?;

    // A Rust closure bound to a simple `let` identifier takes that identifier as its name.
    if node.kind() == "closure_expression" && parent.kind() == "let_declaration" {
        let pattern_node = parent.child_by_field_name("pattern");
        return match pattern_node {
            Some(pattern) if pattern.kind() == "identifier" => {
                Some(node_text(pattern, code).to_string())
            }
            _ => None,
        };
    }

    // A C++ lambda assigned to a variable (`auto f = [](int x) { ... };`) takes the variable name.
    if node.kind() == "lambda_expression" && parent.kind() == "init_declarator" {
        return unwrap_declarator_name(parent.child_by_field_name("declarator"), false, code);
    }

    // A Go func literal bound via `add := func...` or `var add = func...` takes the identifier at
    // the same list position.
    if node.kind() == "func_literal" && parent.kind() == "expression_list" {
        return find_go_func_literal_name(node, parent, code);
    }

    // Ruby lambdas assigned to a name take that name.
    if node.kind() == "lambda" && parent.kind() == "assignment" {
        return find_ruby_assignment_name(parent, code);
    }
    if (node.kind() == "block" || node.kind() == "do_block") && is_ruby_lambda_call(parent, code) {
        return match parent.parent() {
            Some(grandparent) if grandparent.kind() == "assignment" => {
                find_ruby_assignment_name(grandparent, code)
            }
            _ => None,
        };
    }

    parent
        .child_by_field_name("name")
        .map(|name| node_text(name, code).to_string())
}

fn find_ruby_assignment_name(assignment: Node<'_>, code: &Source<'_>) -> Option<String> {
    let left_node = assignment.child_by_field_name("left")?;
    if left_node.kind() == "identifier" || left_node.kind() == "constant" {
        Some(node_text(left_node, code).to_string())
    } else {
        None
    }
}

fn is_ruby_lambda_call(node: Node<'_>, code: &Source<'_>) -> bool {
    if node.kind() != "call" || node.child_by_field_name("receiver").is_some() {
        return false;
    }
    node.child_by_field_name("method").is_some_and(|method| {
        method.kind() == "identifier"
            && (node_text(method, code) == "lambda" || node_text(method, code) == "proc")
    })
}

fn find_go_func_literal_name(
    node: Node<'_>,
    expression_list: Node<'_>,
    code: &Source<'_>,
) -> Option<String> {
    let holder = expression_list.parent()?;
    // Comments interleave with expressions in the list but have no matching binding target.
    let values: Vec<Node<'_>> = named_children(expression_list)
        .into_iter()
        .filter(|child| child.kind() != "comment")
        .collect();
    let value_index = values.iter().position(|child| child.id() == node.id())?;

    if holder.kind() == "short_var_declaration" {
        let targets = holder.child_by_field_name("left").map(|left| {
            named_children(left)
                .into_iter()
                .filter(|child| child.kind() != "comment")
                .collect::<Vec<_>>()
        });
        return as_go_binding_name(
            targets
                .as_ref()
                .and_then(|targets| targets.get(value_index))
                .copied(),
            code,
        );
    }

    if holder.kind() == "var_spec" {
        let target = find_children_by_field_name(holder, "name")
            .get(value_index)
            .copied();
        return as_go_binding_name(target, code);
    }

    None
}

/// Go's blank identifier `_` discards the value and creates no callable binding.
fn as_go_binding_name(target: Option<Node<'_>>, code: &Source<'_>) -> Option<String> {
    match target {
        Some(target) if target.kind() == "identifier" && node_text(target, code) != "_" => {
            Some(node_text(target, code).to_string())
        }
        _ => None,
    }
}

fn find_wrapped_component_name(node: Node<'_>, code: &Source<'_>) -> Option<String> {
    let mut current = node;
    loop {
        let arguments_node = current.parent();
        let call_node = arguments_node.and_then(|arguments| arguments.parent());
        let (Some(arguments_node), Some(call_node)) = (arguments_node, call_node) else {
            return None;
        };
        if arguments_node.kind() != "arguments" || call_node.kind() != "call_expression" {
            return None;
        }

        if !is_react_component_wrapper_call(call_node, code) {
            return None;
        }

        if let Some(declarator_node) = call_node.parent() {
            if declarator_node.kind() == "variable_declarator" {
                return declarator_node
                    .child_by_field_name("name")
                    .map(|name| node_text(name, code).to_string());
            }
        }

        current = call_node;
    }
}

fn is_react_component_wrapper_call(node: Node<'_>, code: &Source<'_>) -> bool {
    let callee_node = node
        .child_by_field_name("function")
        .or_else(|| node.named_child(0));
    callee_node.is_some_and(|callee| {
        let text = node_text(callee, code);
        text == "memo" || text == "React.memo" || text == "forwardRef" || text == "React.forwardRef"
    })
}

pub fn is_call_node(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "call_expression"
            | "call"
            | "method_invocation"
            | "macro_invocation"
            | "new_expression"
            | "object_creation_expression"
            | "explicit_constructor_invocation"
    )
}

/// Reconstructs `operator+` / `operator int` from tree-sitter-cpp's ERROR-wrapped misparses.
fn find_cpp_explicit_operator_name(node: Node<'_>, code: &Source<'_>) -> Option<String> {
    // `this->operator+(y)`: the operator_name lands inside an ERROR child of the call itself.
    for child in all_children(node) {
        if child.kind() == "ERROR" {
            if let Some(operator_name) = all_children(child)
                .into_iter()
                .find(|grand_child| grand_child.kind() == "operator_name")
            {
                return Some(node_text(operator_name, code).to_string());
            }
        }
    }
    // `x.operator int()`: the field_expression holds an ERROR `operator` before the field name.
    let callee = node.child_by_field_name("function");
    if let Some(callee) = callee {
        if callee.kind() == "field_expression" {
            let children = all_children(callee);
            let error_index = children
                .iter()
                .position(|child| child.kind() == "ERROR" && node_text(*child, code) == "operator");
            let field_node = error_index.and_then(|index| children.get(index + 1));
            if let Some(field_node) = field_node {
                if field_node.kind() == "field_identifier" || field_node.kind() == "primitive_type"
                {
                    return Some(format!("operator {}", node_text(*field_node, code)));
                }
            }
        }
    }
    None
}

/// Function-literal node types across supported grammars whose invocation names no callee.
const ANONYMOUS_CALLABLE_NODE_TYPES: &[&str] = &[
    "arrow_function",
    "function_expression",
    "function",
    "lambda",
    "lambda_expression",
    "closure_expression",
    "func_literal",
    "anonymous_function",
];

pub fn find_callee_name(node: Node<'_>, code: &Source<'_>) -> Option<String> {
    // Ruby lambdas/procs are invoked via `helper.call(...)`; the receiver is the real callee.
    if node.kind() == "call" {
        let method_node = node.child_by_field_name("method");
        let receiver_node = node.child_by_field_name("receiver");
        if let (Some(method_node), Some(receiver_node)) = (method_node, receiver_node) {
            if node_text(method_node, code) == "call" && receiver_node.kind() == "identifier" {
                return Some(node_text(receiver_node, code).to_string());
            }
        }
        // A Ruby setter send (`self.foo = x`) invokes the method named `foo=`.
        if let Some(method_node) = method_node {
            if node.parent().is_some_and(|parent| {
                parent.kind() == "assignment"
                    && parent
                        .child_by_field_name("left")
                        .is_some_and(|left| left.id() == node.id())
            }) {
                return Some(format!("{}=", node_text(method_node, code)));
            }
            // Explicit operator sends (`self.+(other)`) name the operator method directly.
            if method_node.kind() == "operator" {
                return Some(node_text(method_node, code).to_string());
            }
        }
    }

    if node.kind() == "call_expression" {
        if let Some(operator_name) = find_cpp_explicit_operator_name(node, code) {
            return Some(operator_name);
        }
    }

    let callee_node = node
        .child_by_field_name("function")
        .or_else(|| node.child_by_field_name("name"))
        .or_else(|| node.child_by_field_name("method"))
        .or_else(|| node.child_by_field_name("constructor"))
        .or_else(|| node.child_by_field_name("type"))
        .or_else(|| node.named_child(0))?;

    // Immediately invoked anonymous callables have no stable callee name.
    let unwrapped_callee = unwrap_parenthesized_expression(callee_node);
    if ANONYMOUS_CALLABLE_NODE_TYPES.contains(&unwrapped_callee.kind()) {
        return None;
    }

    find_rightmost_identifier(unwrapped_callee, code)
}

fn unwrap_parenthesized_expression(node: Node<'_>) -> Node<'_> {
    let mut current = node;
    while current.kind() == "parenthesized_expression" && current.named_child_count() == 1 {
        let Some(inner) = current.named_child(0) else {
            break;
        };
        current = inner;
    }
    current
}

pub fn find_rightmost_identifier(node: Node<'_>, code: &Source<'_>) -> Option<String> {
    // Generic-call wrappers put type arguments after the callee, so the right-to-left search below
    // would return the type argument; the callee lives in the `function`/`name` field.
    if node.kind() == "generic_function"
        || node.kind() == "template_function"
        || node.kind() == "template_method"
    {
        if let Some(callee_node) = node
            .child_by_field_name("function")
            .or_else(|| node.child_by_field_name("name"))
        {
            return find_rightmost_identifier(callee_node, code);
        }
    }

    // Explicit destructor calls (`x.~Foo()`) must keep the atomic `~Foo` to match their definition.
    if node.kind() == "destructor_name" {
        return Some(node_text(node, code).to_string());
    }

    // Java `new Box<String>()` names the base type first.
    if node.kind() == "generic_type" {
        if let Some(base_node) = named_children(node).into_iter().find(|child| {
            child.kind() == "type_identifier" || child.kind() == "scoped_type_identifier"
        }) {
            return find_rightmost_identifier(base_node, code);
        }
    }

    if matches!(
        node.kind(),
        "identifier" | "property_identifier" | "field_identifier" | "type_identifier" | "attribute"
    ) {
        return Some(node_text(node, code).to_string());
    }

    for index in (0..node.named_child_count()).rev() {
        let Some(child) = node.named_child(index) else {
            continue;
        };

        // JS truthiness: an empty identifier (MISSING node) does not stop the search.
        if let Some(identifier) =
            find_rightmost_identifier(child, code).filter(|name| !name.is_empty())
        {
            return Some(identifier);
        }
    }

    None
}

fn is_react_create_element_call(node: Node<'_>, code: &Source<'_>) -> bool {
    if !is_call_node(node) {
        return false;
    }

    let callee_node = node
        .child_by_field_name("function")
        .or_else(|| node.named_child(0));
    callee_node.is_some_and(|callee| {
        let text = node_text(callee, code);
        text == "React.createElement" || text == "createElement"
    })
}

/// Unwraps a C/C++ declarator chain to the declared name; see unwrapDeclaratorName in metrics.ts.
pub fn unwrap_declarator_name(
    declarator: Option<Node<'_>>,
    qualified: bool,
    code: &Source<'_>,
) -> Option<String> {
    let mut current = declarator;
    let mut scope_prefix = String::new();
    while let Some(node) = current {
        match node.kind() {
            "identifier" | "field_identifier" | "type_identifier" | "destructor_name"
            | "operator_name" => {
                let text = node_text(node, code);
                return Some(if scope_prefix.is_empty() {
                    text.to_string()
                } else {
                    format!("{scope_prefix}::{text}")
                });
            }
            // A C++ conversion operator (`operator int()`) is its own declarator node.
            "operator_cast" => {
                let type_text = node
                    .child_by_field_name("type")
                    .map(|type_node| node_text(type_node, code))
                    .unwrap_or("");
                let name = format!("operator {type_text}").trim_end().to_string();
                return Some(if scope_prefix.is_empty() {
                    name
                } else {
                    format!("{scope_prefix}::{name}")
                });
            }
            "template_function" => {
                current = node.child_by_field_name("name");
            }
            "qualified_identifier" => {
                if qualified {
                    if let Some(scope_node) = node.child_by_field_name("scope") {
                        let scope = strip_js_whitespace(node_text(scope_node, code));
                        if !scope.is_empty() {
                            scope_prefix = if scope_prefix.is_empty() {
                                scope
                            } else {
                                format!("{scope_prefix}::{scope}")
                            };
                        }
                    }
                }
                current = node.child_by_field_name("name");
            }
            _ => {
                current = next_declarator(node);
            }
        }
    }
    None
}

/// Steps into the inner declarator; `reference_declarator` and `parenthesized_declarator` do not
/// expose a `declarator` field in tree-sitter-cpp, so their sole named child is the inner node.
pub fn next_declarator(node: Node<'_>) -> Option<Node<'_>> {
    if let Some(direct) = node.child_by_field_name("declarator") {
        return Some(direct);
    }
    if node.kind() == "reference_declarator" || node.kind() == "parenthesized_declarator" {
        return node.named_child(0);
    }
    None
}
