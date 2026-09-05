use std::collections::HashSet;
use tree_sitter::Node;

use crate::util::{all_children, find_children_by_field_name, named_children, node_text, Source};

/// C++ `function_definition` also covers pure-virtual/`= default`/`= delete` members; those have no
/// `body` and are signatures, not implementations, matching how TypeScript method signatures are
/// excluded. Java `method_declaration` is NOT here: PMD reports abstract/interface methods as
/// methods (NCSS 1), so bodyless Java methods stay in the function list (as do C#'s and Kotlin's).
/// C# auto-property accessors (`{ get; set; }`) and Kotlin visibility-only accessors (`private
/// set`) hold no code, so they need a body too; a C# property or indexer is a function only in its
/// expression-bodied form (`int X => ...`), otherwise its accessors are the functions.
const BODY_REQUIRED_FUNCTION_TYPES: &[&str] = &[
    "function_definition",
    "constructor_declaration",
    "compact_constructor_declaration",
    "function_signature_item",
    "accessor_declaration",
    "getter",
    "setter",
    "property_declaration",
    "indexer_declaration",
];

pub fn is_implemented_function(node: Node<'_>) -> bool {
    if !BODY_REQUIRED_FUNCTION_TYPES.contains(&node.kind())
        || node.child_by_field_name("body").is_some()
    {
        return true;
    }

    if node.kind() == "property_declaration" || node.kind() == "indexer_declaration" {
        return node
            .child_by_field_name("value")
            .is_some_and(|value| value.kind() == "arrow_expression_clause");
    }

    // The Kotlin grammar has no fields; an implemented accessor holds a `function_body` child.
    if node.kind() == "getter" || node.kind() == "setter" {
        return named_children(node)
            .iter()
            .any(|child| child.kind() == "function_body");
    }

    // C++ constructor/destructor function-try-blocks carry their `try_statement` outside the
    // `body` field; they are implementations, unlike `= 0`/`= default`/`= delete` members.
    named_children(node)
        .iter()
        .any(|child| child.kind() == "try_statement")
}

/// Counts declared parameters of a function/method, ignoring punctuation and comments.
pub fn count_parameters(node: Node<'_>, code: &Source<'_>) -> usize {
    // An unparenthesized arrow-function parameter (`x => x + 1`) is a bare `parameter` field.
    if node.child_by_field_name("parameter").is_some() {
        return 1;
    }

    let Some(parameters_node) = find_parameters_node(node) else {
        return 0;
    };

    // A Java bare lambda parameter (`x -> x + 1`) puts a lone identifier in the `parameters` field;
    // a C# one (`x => x + 1`) is an `implicit_parameter` leaf.
    if parameters_node.kind() == "identifier" || parameters_node.kind() == "implicit_parameter" {
        return 1;
    }
    // Kotlin default values (`x: Int = 0`) are siblings of their `parameter`, not children.
    if parameters_node.kind() == "function_value_parameters" {
        return named_children(parameters_node)
            .iter()
            .filter(|child| child.kind() == "parameter")
            .count();
    }
    // A Kotlin setter declares its single parameter directly (`set(value) { ... }`).
    if parameters_node.kind() == "setter" {
        return 1;
    }
    // A C# `params` array is spelled out as `type`/`name` fields of the parameter list itself.
    let csharp_params_array_ids: HashSet<usize> = ["type", "name"]
        .iter()
        .flat_map(|field| find_children_by_field_name(parameters_node, field))
        .map(|child| child.id())
        .collect();

    // Ruby block-locals after `;` (`{ |x; memo| ... }`) occupy `locals` fields and receive no arguments.
    let block_local_ids: HashSet<usize> = find_children_by_field_name(parameters_node, "locals")
        .iter()
        .map(|child| child.id())
        .collect();
    let mut count = 0usize;
    // Rust's `self` and Java's explicit receiver (`void f(X this)`) are not declared parameters,
    // C/C++ `f(void)` declares none, and a Ruby block parameter (`&blk`) binds the block, which
    // call sites pass outside the argument list.
    for child in named_children(parameters_node) {
        if crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind())
            || child.kind() == "attribute_list"
            || csharp_params_array_ids.contains(&child.id())
            || child.kind() == "self_parameter"
            || child.kind() == "receiver_parameter"
            || child.kind() == "block_parameter"
            // Python's PEP 570/3102 markers (`/`, `*`) separate parameter kinds but bind nothing.
            || child.kind() == "positional_separator"
            || child.kind() == "keyword_separator"
            || block_local_ids.contains(&child.id())
            || is_void_parameter(child, code)
        {
            continue;
        }
        // Go declares several names per declaration (`a, b int`); each name is a parameter.
        count += if child.kind() == "parameter_declaration" {
            find_children_by_field_name(child, "name").len().max(1)
        } else {
            1
        };
    }
    // C++ C-style varargs (`int f(int a, ...)`) leave `...` as an anonymous token.
    let anonymous_variadic_count = all_children(parameters_node)
        .iter()
        .filter(|child| !child.is_named() && node_text(**child, code) == "...")
        .count();
    count + anonymous_variadic_count + usize::from(!csharp_params_array_ids.is_empty())
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

    // A C# indexer accessor (`this[int i] { get { ... } }`) takes the indexer's parameters.
    if node.kind() == "accessor_declaration" {
        return node
            .parent()
            .and_then(|list| list.parent())
            .filter(|owner| owner.kind() == "indexer_declaration")
            .and_then(|owner| owner.child_by_field_name("parameters"));
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

    // A Kotlin setter's parameter (`set(value)`) sits directly under the setter node.
    if node.kind() == "setter"
        && named_children(node)
            .iter()
            .any(|child| child.kind() == "parameter_with_optional_type")
    {
        return Some(node);
    }

    named_children(node).into_iter().find(|child| {
        matches!(
            child.kind(),
            "formal_parameters"
                | "parameter_list"
                | "function_value_parameters"
                | "lambda_parameters"
        )
    })
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

/// Expression wrappers whose first named child is the wrapped value, transparent for naming.
const TRANSPARENT_VALUE_WRAPPER_TYPES: &[&str] = &[
    "parenthesized_expression",
    "as_expression",
    "satisfies_expression",
    "non_null_expression",
];

pub fn find_function_name(node: Node<'_>, code: &Source<'_>) -> Option<String> {
    // JS truthiness: empty strings from MISSING nodes act like "no name" at every `if (name)`.
    if let Some(wrapped_name) =
        find_wrapped_component_name(node, code).filter(|name| !name.is_empty())
    {
        return Some(wrapped_name);
    }

    if let Some(member_name) = find_member_function_name(node, code) {
        return Some(member_name);
    }

    if let Some(name_node) = node.child_by_field_name("name") {
        return Some(node_text(name_node, code).to_string());
    }

    // C/C++ definitions name the function inside the (possibly pointer-wrapped) declarator chain.
    if let Some(declarator_name) =
        unwrap_declarator_name(node.child_by_field_name("declarator"), code)
            .filter(|name| !name.is_empty())
    {
        return Some(declarator_name);
    }

    // Grouping parentheses and TypeScript type wrappers (`(() => 1)`, `(() => 2) as Fn`) do not
    // change what a function is bound to, so the binding site is looked up past them.
    let mut bound = node;
    while let Some(wrapper) = bound.parent().filter(|wrapper| {
        TRANSPARENT_VALUE_WRAPPER_TYPES.contains(&wrapper.kind())
            && wrapper
                .named_child(0)
                .is_some_and(|inner| inner.id() == bound.id())
    }) {
        bound = wrapper;
    }
    let parent = bound.parent()?;

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
        return unwrap_declarator_name(parent.child_by_field_name("declarator"), code);
    }

    // A Go func literal bound via `add := func...`, `var add = func...`, or `add = func...` takes
    // the identifier (or selector field) at the same list position.
    if node.kind() == "func_literal" && parent.kind() == "expression_list" {
        return find_go_func_literal_name(node, parent, code);
    }

    // Ruby lambdas assigned to a name take that name.
    if node.kind() == "lambda" && parent.kind() == "assignment" {
        return find_ruby_assignment_name(parent, code);
    }

    // A Kotlin lambda or anonymous function initializing a property (`val f = { ... }`, also through
    // a label or annotation prefix) takes the property name; one assigned to a variable or member
    // (`run = { ... }`, `obj.run = { ... }`) takes the assigned name.
    if node.kind() == "lambda_literal" || node.kind() == "anonymous_function" {
        let mut holder = parent;
        while holder.kind() == "prefix_expression" {
            holder = holder.parent()?;
        }
        if holder.kind() == "property_declaration" {
            return find_kotlin_property_name(holder, code);
        }
        if holder.kind() == "assignment" {
            return find_kotlin_assignment_name(holder, code);
        }
    }
    if (node.kind() == "block" || node.kind() == "do_block") && is_ruby_lambda_call(parent, code) {
        return match parent.parent() {
            Some(grandparent) if grandparent.kind() == "assignment" => {
                find_ruby_assignment_name(grandparent, code)
            }
            _ => None,
        };
    }

    // An object-literal property (`{ run: () => {} }`) names its value after the key; an assignment
    // (`obj.run = () => {}`, `run = () => {}`, Rust/C++ `self.cb = |x| x`, C++ `N::run = [] {}`,
    // C# `this.Run = () => 1`) after its target.
    if parent.kind() == "pair" {
        return find_pair_key_name(parent, code);
    }
    if parent.kind() == "assignment_expression" {
        return find_assignment_target_name(parent, code);
    }

    // A JavaScript class field (`handle = () => {}`) names its property through the `property`
    // field; TypeScript's `public_field_definition` exposes the same thing as `name`.
    let field_name = if parent.kind() == "field_definition" {
        "property"
    } else {
        "name"
    };
    parent
        .child_by_field_name(field_name)
        .map(|name| node_text(name, code).to_string())
}

/// The key of a `pair` when it is a plain or string-literal property name (the literal's text
/// without its quotes, escapes kept as written); a computed key (`[k]: ...`) or an empty string
/// names nothing.
fn find_pair_key_name(pair: Node<'_>, code: &Source<'_>) -> Option<String> {
    let key = pair.child_by_field_name("key")?;
    match key.kind() {
        "property_identifier" => Some(node_text(key, code).to_string()),
        "string" => {
            let text = node_text(key, code);
            let quote = text
                .chars()
                .next()
                .filter(|first| matches!(first, '"' | '\'' | '`'))?;
            let inner = text
                .strip_prefix(quote)
                .and_then(|rest| rest.strip_suffix(quote))?;
            (!inner.is_empty()).then(|| inner.to_string())
        }
        _ => None,
    }
}

/// The assigned identifier, or the member name of a JS member, Rust/C++ field, C# member, or Java
/// field access (`a.b.run` names `run`) or a C++ qualified name (`N::run`); subscripts (`o["run"]`)
/// name nothing.
fn find_assignment_target_name(assignment: Node<'_>, code: &Source<'_>) -> Option<String> {
    let target = assignment.child_by_field_name("left")?;
    let name = match target.kind() {
        "identifier" => target,
        "member_expression" => target.child_by_field_name("property")?,
        "field_expression" => target.child_by_field_name("field")?,
        "member_access_expression" => target.child_by_field_name("name")?,
        "field_access" => target.child_by_field_name("field")?,
        "qualified_identifier" => return unwrap_declarator_name(Some(target), code),
        _ => return None,
    };
    Some(node_text(name, code).to_string())
}

/// The Kotlin assignment target: the `directly_assignable_expression`'s last identifier, i.e. the
/// variable itself or the member of the trailing navigation suffix (`obj.run` names `run`).
fn find_kotlin_assignment_name(assignment: Node<'_>, code: &Source<'_>) -> Option<String> {
    let target = first_named_child_of_kind(assignment, "directly_assignable_expression")?;
    let holder = named_children(target)
        .into_iter()
        .rfind(|child| child.kind() == "navigation_suffix")
        .unwrap_or(target);
    first_named_child_of_kind(holder, "simple_identifier")
        .map(|name| node_text(name, code).to_string())
}

/// Names of C# and Kotlin members whose grammars carry no usable `name` field: accessors are
/// named after their property (`Count.get`; an expression-bodied property is its own getter),
/// Kotlin functions by their identifier child, Kotlin secondary constructors and C# destructors
/// after their class, and C# operators like C++ ones.
fn find_member_function_name(node: Node<'_>, code: &Source<'_>) -> Option<String> {
    match node.kind() {
        "accessor_declaration" => {
            let keyword = node_text(node.child_by_field_name("name")?, code);
            let owner = node.parent()?.parent()?;
            Some(format!("{}.{keyword}", csharp_property_name(owner, code)?))
        }
        "property_declaration" | "indexer_declaration" => {
            Some(format!("{}.get", csharp_property_name(node, code)?))
        }
        "getter" | "setter" => {
            let keyword = if node.kind() == "getter" {
                "get"
            } else {
                "set"
            };
            Some(format!(
                "{}.{keyword}",
                find_kotlin_accessor_owner_name(node, code)?
            ))
        }
        "function_declaration" if node.child_by_field_name("name").is_none() => {
            first_named_child_of_kind(node, "simple_identifier")
                .map(|name| node_text(name, code).to_string())
        }
        "secondary_constructor" => {
            let mut ancestor = node.parent();
            while let Some(current) = ancestor {
                if current.kind() == "class_declaration" || current.kind() == "object_declaration" {
                    return first_named_child_of_kind(current, "type_identifier")
                        .map(|name| node_text(name, code).to_string());
                }
                ancestor = current.parent();
            }
            None
        }
        "destructor_declaration" => Some(format!(
            "~{}",
            node_text(node.child_by_field_name("name")?, code)
        )),
        "operator_declaration" => Some(format!(
            "operator {}",
            node_text(node.child_by_field_name("operator")?, code)
        )),
        "conversion_operator_declaration" => Some(format!(
            "operator {}",
            node_text(node.child_by_field_name("type")?, code)
        )),
        _ => None,
    }
}

/// A C# property or indexer (`this`) name.
fn csharp_property_name(owner: Node<'_>, code: &Source<'_>) -> Option<String> {
    match owner.kind() {
        "indexer_declaration" => Some("this".to_string()),
        _ => Some(node_text(owner.child_by_field_name("name")?, code).to_string()),
    }
}

/// The property a Kotlin accessor belongs to: its parent when the accessor follows the initializer
/// on the same line, otherwise (accessor on its own line) the grammar emits it as a class-body
/// sibling after the property, any preceding accessor, and any comments between them.
fn find_kotlin_accessor_owner_name(accessor: Node<'_>, code: &Source<'_>) -> Option<String> {
    if let Some(name) = accessor
        .parent()
        .and_then(|parent| find_kotlin_property_name(parent, code))
    {
        return Some(name);
    }
    let mut sibling = accessor.prev_named_sibling();
    while let Some(current) = sibling {
        if current.kind() == "property_declaration" {
            return find_kotlin_property_name(current, code);
        }
        if !matches!(current.kind(), "getter" | "setter")
            && !crate::ncss::COMMENT_NODE_TYPES.contains(&current.kind())
        {
            return None;
        }
        sibling = current.prev_named_sibling();
    }
    None
}

/// The declared name of a Kotlin `property_declaration` (`val name: T`), if it declares one.
fn find_kotlin_property_name(property: Node<'_>, code: &Source<'_>) -> Option<String> {
    if property.kind() != "property_declaration" {
        return None;
    }
    let declaration = first_named_child_of_kind(property, "variable_declaration")?;
    first_named_child_of_kind(declaration, "simple_identifier")
        .map(|name| node_text(name, code).to_string())
}

fn first_named_child_of_kind<'t>(node: Node<'t>, kind: &str) -> Option<Node<'t>> {
    named_children(node)
        .into_iter()
        .find(|child| child.kind() == kind)
}

/// A Ruby assignment target: a local, constant, or instance/class/global variable, or the method of
/// an attribute writer call (`self.run = ...`, `obj.run = ...` names `run`).
fn find_ruby_assignment_name(assignment: Node<'_>, code: &Source<'_>) -> Option<String> {
    let left_node = assignment.child_by_field_name("left")?;
    match left_node.kind() {
        "identifier" | "constant" | "instance_variable" | "class_variable" | "global_variable" => {
            Some(node_text(left_node, code).to_string())
        }
        "call" if left_node.child_by_field_name("receiver").is_some() => left_node
            .child_by_field_name("method")
            .map(|method| node_text(method, code).to_string()),
        _ => None,
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

    if holder.kind() == "short_var_declaration" || holder.kind() == "assignment_statement" {
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

/// Go's blank identifier `_` discards the value and creates no callable binding; a selector target
/// (`m.run = func...`) names its field.
fn as_go_binding_name(target: Option<Node<'_>>, code: &Source<'_>) -> Option<String> {
    match target {
        Some(target) if target.kind() == "identifier" && node_text(target, code) != "_" => {
            Some(node_text(target, code).to_string())
        }
        Some(target) if target.kind() == "selector_expression" => target
            .child_by_field_name("field")
            .map(|field| node_text(field, code).to_string()),
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

/// Unwraps a C/C++ declarator chain to the declared name; see unwrapDeclaratorName in metrics.ts.
fn unwrap_declarator_name(declarator: Option<Node<'_>>, code: &Source<'_>) -> Option<String> {
    let mut current = declarator;
    while let Some(node) = current {
        match node.kind() {
            "identifier" | "field_identifier" | "type_identifier" | "destructor_name"
            | "operator_name" => {
                return Some(node_text(node, code).to_string());
            }
            // A C++ conversion operator (`operator int()`) is its own declarator node.
            "operator_cast" => {
                let type_text = node
                    .child_by_field_name("type")
                    .map(|type_node| node_text(type_node, code))
                    .unwrap_or("");
                return Some(format!("operator {type_text}").trim_end().to_string());
            }
            // Template specializations (`id<int>`) and qualified names both carry a `name` field.
            "template_function" | "qualified_identifier" => {
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
fn next_declarator(node: Node<'_>) -> Option<Node<'_>> {
    if let Some(direct) = node.child_by_field_name("declarator") {
        return Some(direct);
    }
    if node.kind() == "reference_declarator" || node.kind() == "parenthesized_declarator" {
        return node.named_child(0);
    }
    None
}
