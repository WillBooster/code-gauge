use rustc_hash::FxHashSet;
use tree_sitter::Node;

use crate::functions::next_declarator;
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
    "union_specifier",
];
/// Whether the function is declared, as a method or a named function is, rather than written as a
/// value (a lambda, a closure, a function expression).
fn is_function_declaration(node: Node<'_>) -> bool {
    let kind = node.kind_name();
    kind.ends_with("_declaration")
        || kind.ends_with("_definition")
        || matches!(
            kind,
            "function_item"
                | "getter"
                | "local_function_statement"
                | "method"
                | "secondary_constructor"
                | "setter"
                | "singleton_method"
        )
}

const CPP_SCOPE_NODE_TYPES: &[&str] = &[
    "class_specifier",
    "namespace_definition",
    "struct_specifier",
    "union_specifier",
];

/// The names of the C++ namespaces and classes around `node`, outermost first, up to the function
/// enclosing it.
fn enclosing_cpp_scopes<'s>(
    node: Node<'_>,
    function_nodes: &FxHashSet<&'static str>,
    code: &Source<'s>,
    namespaces_only: bool,
) -> Vec<&'s str> {
    let mut scopes = Vec::new();
    let mut current = node.parent_node();
    while let Some(ancestor) = current {
        if crate::complexity::is_function_boundary(ancestor, function_nodes) {
            break;
        }
        let is_namespace = ancestor.kind_name() == "namespace_definition";
        if CPP_SCOPE_NODE_TYPES.contains(&ancestor.kind_name())
            && (is_namespace || !namespaces_only)
            && !is_transparent_namespace(ancestor)
        {
            match ancestor.child_by_field_name("name") {
                // `namespace a::b` names two scopes at once.
                Some(name) => scopes.extend(scope_names(name, code).into_iter().rev()),
                // An unnamed class ends the owner, as its members are reached through no name.
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

/// The name of the declaration whose member a declared function is: the nearest class-like
/// declaration enclosing it, or the owner the function names itself (a Go receiver, a C++ qualified
/// declarator, the object of a Ruby singleton method).
pub fn find_container_name(
    node: Node<'_>,
    function_nodes: &FxHashSet<&'static str>,
    code: &Source<'_>,
    inline_namespaces: &InlineNamespaces<'_>,
) -> Option<String> {
    // A function written as a value belongs to whatever it is passed or assigned to, which the
    // syntax cannot follow reliably; it keeps the name of what it is bound to and has no owner.
    if !is_function_declaration(node) {
        return None;
    }
    if let Some(receiver) = node.child_by_field_name("receiver") {
        return go_receiver_type(receiver, code);
    }
    if let Some(qualified) = find_qualified_declarator(node) {
        return cpp_spelled_owner(node, qualified, function_nodes, code, inline_namespaces);
    }
    // A Ruby `def Other.decide` belongs to the object it names rather than to the class around it.
    explicit_ruby_owner(node.child_by_field_name("object"), code)
        .or_else(|| enclosing_owner(node, function_nodes, code, inline_namespaces))
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
    inline_namespaces: &InlineNamespaces<'_>,
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
    let owner = if is_absolute {
        Vec::new()
    } else {
        enclosing_cpp_scopes(node, function_nodes, code, false)
    };
    spell_cpp_scopes(merge_cpp_scopes(owner, scopes), inline_namespaces)
}

/// The scopes as an owner, without the inline namespaces the file declares: one adds nothing when
/// spelled (`mylib::v2::Thing` is `mylib::Thing`), as it adds nothing around a definition, while a
/// plain namespace of the same name elsewhere stays.
fn spell_cpp_scopes(scopes: Vec<&str>, inline_namespaces: &InlineNamespaces<'_>) -> Option<String> {
    let mut resolved: Vec<&str> = Vec::new();
    for scope in scopes {
        let is_inline = inline_namespaces
            .iter()
            .any(|(path, name)| *name == scope && *path == resolved);
        if !is_inline {
            resolved.push(scope);
        }
    }
    (!resolved.is_empty()).then(|| resolved.join("::"))
}

/// The inline C++ namespaces a file declares, each as the scopes around it and its name.
pub type InlineNamespaces<'s> = Vec<(Vec<&'s str>, &'s str)>;

/// Collected once per file, as every owner in it is checked against them. Namespaces nest only in
/// one another and in the wrappers below, so the search descends through those alone.
pub fn find_inline_namespaces<'s>(root: Node<'_>, code: &Source<'s>) -> InlineNamespaces<'s> {
    let mut found = Vec::new();
    let mut pending = vec![(root, Vec::new())];
    while let Some((scope, path)) = pending.pop() {
        for child in named_children(scope) {
            if holds_namespaces_without_scope(child) {
                pending.push((child, path.clone()));
            }
            if child.kind_name() != "namespace_definition" {
                continue;
            }
            let inner_path = enter_namespace(child, &path, &mut found, code);
            if let Some(body) = child.child_by_field_name("body") {
                pending.push((body, inner_path));
            }
        }
    }
    found
}

/// The enclosing scopes followed by the spelled ones, which take over from the innermost
/// enclosing scope they start with, as name lookup finds that one first: `ns::Rules` spelled
/// inside `namespace ns` is `ns::Rules`.
fn merge_cpp_scopes<'s>(mut enclosing: Vec<&'s str>, spelled: Vec<&'s str>) -> Vec<&'s str> {
    let restart = enclosing
        .iter()
        .rposition(|scope| Some(scope) == spelled.first());
    enclosing.truncate(restart.unwrap_or(enclosing.len()));
    enclosing.extend(spelled);
    enclosing
}

/// Records the inline parts of the namespace's name and returns the path of its members.
fn enter_namespace<'s>(
    namespace: Node<'_>,
    path: &[&'s str],
    found: &mut InlineNamespaces<'s>,
    code: &Source<'s>,
) -> Vec<&'s str> {
    let mut inner_path = path.to_vec();
    let Some(name) = namespace.child_by_field_name("name") else {
        return inner_path;
    };
    for (part, is_inline) in namespace_parts(name, is_transparent_namespace(namespace), code) {
        if is_inline {
            found.push((inner_path.clone(), part));
        } else {
            inner_path.push(part);
        }
    }
    inner_path
}

/// The parts of a namespace's name, each with whether it is inline: the namespace itself when
/// declared `inline namespace v2`, or a part of C++20's `namespace a::inline v2`.
fn namespace_parts<'s>(name: Node<'_>, is_inline: bool, code: &Source<'s>) -> Vec<(&'s str, bool)> {
    if name.kind_name() != "nested_namespace_specifier" {
        return vec![(node_text(name, code), is_inline)];
    }
    let mut parts = Vec::new();
    let mut follows_inline = false;
    for child in crate::util::all_children(name) {
        if child.is_named() && !child.is_extra() {
            parts.extend(namespace_parts(child, follows_inline, code));
        }
        follows_inline = child.kind_name() == "inline";
    }
    parts
}

/// An include guard or `extern "C"` block holds namespaces without being a scope.
fn holds_namespaces_without_scope(node: Node<'_>) -> bool {
    node.kind_name().starts_with("preproc_")
        || matches!(
            node.kind_name(),
            "linkage_specification" | "declaration_list"
        )
}

/// The nearest class-like declaration around the function, unless something between them makes
/// the function no member of it.
fn enclosing_owner(
    node: Node<'_>,
    function_nodes: &FxHashSet<&'static str>,
    code: &Source<'_>,
    inline_namespaces: &InlineNamespaces<'_>,
) -> Option<String> {
    let mut current = node.parent_node();
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
            || ends_membership(ancestor)
        {
            return None;
        }
        if is_named_container(ancestor) {
            return spell_owner(ancestor, is_friend, function_nodes, code, inline_namespaces);
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
    inline_namespaces: &InlineNamespaces<'_>,
) -> Option<String> {
    let name = scope_names(container_name_node(container)?, code);
    if name.iter().any(|part| part.is_empty()) {
        return None;
    }
    if !CPP_SCOPE_NODE_TYPES.contains(&container.kind_name()) {
        return Some(name.join("::"));
    }
    // C++ spells an owner with the namespaces and classes around it (`ns::Rules`), as a definition
    // outside them has to. A friend has namespace scope, whatever classes its declaring class is
    // nested in.
    let mut owner = enclosing_cpp_scopes(container, function_nodes, code, is_friend);
    // Only a class spelled with a qualifier (`class ns::Box<int>`) refers to scopes that exist; a
    // plain name, or the parts of `namespace a::b`, declare new ones even when they repeat an
    // enclosing name.
    let is_qualified_class = name.len() > 1 && container.kind_name() != "namespace_definition";
    if is_qualified_class && !is_friend {
        owner = merge_cpp_scopes(owner, name);
    } else if !is_friend {
        owner.extend(name);
    }
    spell_cpp_scopes(owner, inline_namespaces)
}

/// A function local to an initializer block, or a member of an object literal or of an anonymous
/// class (a class body whose parent declares no type) is no
/// member of the named type around it.
fn ends_membership(ancestor: Node<'_>) -> bool {
    ancestor.kind_name() == "object"
        || crate::measure::is_initializer_block(ancestor)
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
    ancestor.is_named()
        && !is_transparent_namespace(ancestor)
        && CONTAINER_NODE_TYPES.contains(&ancestor.kind_name())
}

/// The members of an unnamed or inline C++ namespace are reached through the namespace around it,
/// which is how a definition outside it spells them.
fn is_transparent_namespace(node: Node<'_>) -> bool {
    node.kind_name() == "namespace_definition"
        && (node.child_by_field_name("name").is_none()
            || node
                .child(0)
                .is_some_and(|first| first.kind_name() == "inline"))
}

/// The identifiers a name consists of: one, or those of a C++ `a::b`, whose separators, spacing,
/// and comments are no part of it.
fn scope_names<'s>(name: Node<'_>, code: &Source<'s>) -> Vec<&'s str> {
    // A specialization `class Box<int>` is named by its template, as `Box<int>::get` is spelled.
    if name.kind_name() == "template_type" {
        if let Some(template) = name.child_by_field_name("name") {
            return scope_names(template, code);
        }
    }
    // `class ns::Box<int>` spells its namespace in front of the name.
    if name.kind_name() == "qualified_identifier" {
        return ["scope", "name"]
            .into_iter()
            .filter_map(|field| name.child_by_field_name(field))
            .flat_map(|part| scope_names(part, code))
            .collect();
    }
    let parts: Vec<Node<'_>> = named_children(name)
        .into_iter()
        .filter(|part| !part.is_extra())
        .collect();
    if name.kind_name() != "nested_namespace_specifier" || parts.is_empty() {
        return vec![node_text(name, code)];
    }
    parts
        .into_iter()
        .flat_map(|part| scope_names(part, code))
        .collect()
}

fn container_name_node(container: Node<'_>) -> Option<Node<'_>> {
    // A Rust `impl` names its type in the `type` field, where `Pass<'a>` in turn wraps the name in
    // a `generic_type`.
    container.child_by_field_name("name").or_else(|| {
        let implemented = container.child_by_field_name("type")?;
        implemented
            .child_by_field_name("type")
            .or(Some(implemented))
    })
}
