use rustc_hash::FxHashSet;
use tree_sitter::Node;

use crate::functions::{next_declarator, unwrap_transparent_value_wrappers};
use crate::tree_index::NodeExt;
use crate::util::{named_children, node_text, Source};

const CONTAINER_NODE_TYPES: &[&str] = &[
    "abstract_class_declaration",
    "class",
    "class_declaration",
    "class_definition",
    "class_specifier",
    "enum_declaration",
    "impl_item",
    "interface_declaration",
    "internal_module",
    "mod_item",
    "module",
    "namespace_definition",
    "object_declaration",
    "record_declaration",
    "struct_declaration",
    "struct_specifier",
    "trait_item",
];
/// Whether a function below `ancestor` is a value inside an expression rather than what a member
/// is bound to: passed to a call (`field = register(() => { ... })`), held in a collection
/// (`field = [() => { ... }]`), or chosen by an operator. Grammars name such nodes
/// `..._expression`; the listed kinds are those named otherwise.
fn is_enclosing_expression(ancestor: Node<'_>) -> bool {
    const OTHER_EXPRESSION_NODE_TYPES: &[&str] = &[
        "annotated_lambda",
        "argument_list",
        "arguments",
        "array",
        "call",
        "collection_literal",
        "dictionary",
        "hash",
        "initializer_list",
        "list",
        "macro_invocation",
        "method_invocation",
        "set",
        "tuple",
        "value_arguments",
    ];
    let kind = ancestor.kind_name();
    kind.ends_with("_expression") || OTHER_EXPRESSION_NODE_TYPES.contains(&kind)
}

const CPP_SCOPE_NODE_TYPES: &[&str] = &[
    "class_specifier",
    "namespace_definition",
    "struct_specifier",
];

/// The names of the C++ namespaces and classes around `node`, outermost first, up to the function
/// enclosing it.
fn enclosing_cpp_scopes<'s>(
    node: Node<'_>,
    function_nodes: &FxHashSet<&'static str>,
    code: &Source<'s>,
) -> Vec<&'s str> {
    let mut scopes = Vec::new();
    let mut current = node.parent_node();
    while let Some(ancestor) = current {
        if crate::complexity::is_function_boundary(ancestor, function_nodes) {
            break;
        }
        if CPP_SCOPE_NODE_TYPES.contains(&ancestor.kind_name()) {
            match ancestor.child_by_field_name("name") {
                // `namespace a::b` names two scopes at once.
                Some(name) => scopes.extend(node_text(name, code).rsplit("::")),
                // An unnamed namespace adds nothing; an unnamed class ends the owner, as its
                // members are reached through no name.
                None if ancestor.kind_name() == "namespace_definition" => {}
                None => break,
            }
        }
        current = ancestor.parent_node();
    }
    scopes.reverse();
    scopes
}

/// The object a Ruby singleton method or singleton class names, unless it is `self`.
fn explicit_ruby_owner(object: Option<Node<'_>>, code: &Source<'_>) -> Option<String> {
    let text = node_text(object?, code);
    (text != "self").then(|| text.to_string())
}

const CONTAINER_NAME_NODE_TYPES: &[&str] = &[
    "constant",
    "identifier",
    "simple_identifier",
    "type_identifier",
];

/// The name of the declaration whose member the function is: the nearest class-like declaration
/// enclosing it, or the owner the function names itself (a Go receiver, a C++ qualified
/// declarator, the object of a Ruby singleton method).
pub fn find_container_name(
    node: Node<'_>,
    function_nodes: &FxHashSet<&'static str>,
    code: &Source<'_>,
) -> Option<String> {
    if let Some(receiver) = node.child_by_field_name("receiver") {
        return go_receiver_type(receiver, code);
    }
    if let Some(qualified) = find_qualified_declarator(node) {
        return cpp_spelled_owner(node, qualified, function_nodes, code);
    }
    // A Ruby `def Other.decide` belongs to the object it names rather than to the class around it.
    explicit_ruby_owner(node.child_by_field_name("object"), code)
        .or_else(|| enclosing_owner(node, function_nodes, code))
}

/// A Go method is declared outside its type and names it as its receiver, `(r *Rules)` or
/// `(r Rules[T])`.
fn go_receiver_type(receiver: Node<'_>, code: &Source<'_>) -> Option<String> {
    let mut receiver_type = named_children(receiver)
        .into_iter()
        .find_map(|parameter| parameter.child_by_field_name("type"))?;
    while receiver_type.kind_name() != "type_identifier" {
        receiver_type = receiver_type
            .child_by_field_name("type")
            .or_else(|| named_children(receiver_type).into_iter().next())?;
    }
    Some(node_text(receiver_type, code).to_string())
}

/// A C++ method defined outside its class names it in its declarator, `int Rules::decide()`.
fn find_qualified_declarator(node: Node<'_>) -> Option<Node<'_>> {
    let mut declarator = node.child_by_field_name("declarator");
    while let Some(inner) = declarator {
        if inner.kind_name() == "qualified_identifier" {
            return Some(inner);
        }
        declarator = next_declarator(inner);
    }
    None
}

fn cpp_spelled_owner(
    node: Node<'_>,
    qualified: Node<'_>,
    function_nodes: &FxHashSet<&'static str>,
    code: &Source<'_>,
) -> Option<String> {
    // A nested name (`ns::Rules::decide`) nests in its `name` field; the scopes on the way to the
    // innermost name are the owner. The name itself may hold `::` too (`operator std::string`), so
    // the text is not split.
    let mut scopes = Vec::new();
    // `::ns::Rules::decide` starts at the global namespace, whatever encloses it.
    let is_absolute = qualified.child_by_field_name("scope").is_none();
    let mut current = qualified;
    while current.kind_name() == "qualified_identifier" {
        if let Some(scope) = current.child_by_field_name("scope") {
            // `Rules<T>::decide` belongs to the class its definition names `Rules`.
            let named = scope.child_by_field_name("name").unwrap_or(scope);
            scopes.push(node_text(named, code));
        }
        current = current.child_by_field_name("name")?;
    }
    // A definition inside `namespace ns { ... }` belongs to that namespace too, which it may also
    // spell out (`ns::Rules::decide` inside `namespace ns`).
    let mut owner = if is_absolute {
        Vec::new()
    } else {
        enclosing_cpp_scopes(node, function_nodes, code)
    };
    // The spelled scopes take over from the innermost enclosing one they start with, as name
    // lookup finds that one first.
    let restart = owner
        .iter()
        .rposition(|scope| Some(scope) == scopes.first());
    owner.truncate(restart.unwrap_or(owner.len()));
    owner.extend(scopes);
    (!owner.is_empty()).then(|| owner.join("::"))
}

/// The nearest class-like declaration around the function, unless something between them makes
/// the function no member of it.
fn enclosing_owner(
    node: Node<'_>,
    function_nodes: &FxHashSet<&'static str>,
    code: &Source<'_>,
) -> Option<String> {
    // A Ruby `private def decide` passes the definition to a call and still defines a member.
    let is_ruby_definition = matches!(node.kind_name(), "method" | "singleton_method");
    // Wrappers such as parentheses and casts leave the function what the member is bound to.
    let mut current = unwrap_transparent_value_wrappers(node).parent_node();
    // A C++ friend defined in a class belongs to the scopes around that class.
    let mut is_friend = false;
    while let Some(ancestor) = current {
        is_friend |= ancestor.kind_name() == "friend_declaration";
        // A method inside `class << Other` belongs to Other; `class << self` leaves the class
        // around it.
        if ancestor.kind_name() == "singleton_class" {
            if let Some(owner) = explicit_ruby_owner(ancestor.child_by_field_name("value"), code) {
                return Some(owner);
            }
        }
        if crate::complexity::is_function_boundary(ancestor, function_nodes)
            || ends_membership(ancestor, is_ruby_definition)
        {
            return None;
        }
        if is_named_container(ancestor) {
            return spell_owner(ancestor, is_friend, function_nodes, code);
        }
        current = ancestor.parent_node();
    }
    None
}

fn spell_owner(
    container: Node<'_>,
    is_friend: bool,
    function_nodes: &FxHashSet<&'static str>,
    code: &Source<'_>,
) -> Option<String> {
    let name = container_name(container, code)?;
    // C++ spells an owner with the namespaces and classes around it (`ns::Rules`), as a definition
    // outside them has to.
    let mut owner = if CPP_SCOPE_NODE_TYPES.contains(&container.kind_name()) {
        enclosing_cpp_scopes(container, function_nodes, code)
    } else {
        Vec::new()
    };
    if !is_friend {
        owner.extend(name.split("::"));
    }
    (!owner.is_empty()).then(|| owner.join("::"))
}

/// A function local to an initializer block, a value inside an expression, or a member of an
/// object literal or of an anonymous class (a class body whose parent declares no type) is no
/// member of the named type around it.
fn ends_membership(ancestor: Node<'_>, is_ruby_definition: bool) -> bool {
    ancestor.kind_name() == "object"
        || crate::measure::is_initializer_block(ancestor)
        || (!is_ruby_definition && is_enclosing_expression(ancestor))
        || (ancestor.kind_name() == "class_body"
            && ancestor
                .parent_node()
                // A Kotlin companion's members are reached through the class it accompanies.
                .is_none_or(|owner| {
                    owner.kind_name() != "companion_object"
                        && !CONTAINER_NODE_TYPES.contains(&owner.kind_name())
                }))
}

fn is_named_container(ancestor: Node<'_>) -> bool {
    // The members of an unnamed C++ namespace belong to the namespace around it.
    let is_unnamed_namespace = ancestor.kind_name() == "namespace_definition"
        && ancestor.child_by_field_name("name").is_none();
    ancestor.is_named()
        && !is_unnamed_namespace
        && CONTAINER_NODE_TYPES.contains(&ancestor.kind_name())
}

fn container_name<'s>(container: Node<'_>, code: &Source<'s>) -> Option<&'s str> {
    // A Rust `impl` names its type in the `type` field, where `Pass<'a>` in turn wraps the name in
    // a `generic_type`; Kotlin names a class in a child.
    let name_node = container
        .child_by_field_name("name")
        .or_else(|| {
            let implemented = container.child_by_field_name("type")?;
            implemented
                .child_by_field_name("type")
                .or(Some(implemented))
        })
        .or_else(|| {
            named_children(container)
                .into_iter()
                .find(|child| CONTAINER_NAME_NODE_TYPES.contains(&child.kind_name()))
        })?;
    Some(node_text(name_node, code)).filter(|name| !name.is_empty())
}
