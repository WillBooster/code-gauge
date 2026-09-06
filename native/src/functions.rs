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

/// The value a transparent wrapper wraps, if this node is one. Grouping parentheses and type-only
/// wrappers do not change what a value is bound to, so naming looks through them. TypeScript's
/// angle-bracket assertion puts the type first (`<Fn>(f)`), so its value is its last child, as does
/// a C-style cast (`(Runnable) () -> 1`), which names it through a field; Ruby's
/// `parenthesized_statements` wraps a lone value only when it holds exactly one statement.
fn wrapped_transparent_value(wrapper: Node<'_>) -> Option<Node<'_>> {
    // A C-style cast (Java, C#, C/C++) names its type first, so its value comes from the field.
    if wrapper.kind() == "cast_expression" {
        return wrapper.child_by_field_name("value");
    }
    if !matches!(
        wrapper.kind(),
        "type_assertion"
            | "parenthesized_statements"
            | "parenthesized_expression"
            | "as_expression"
            | "satisfies_expression"
            | "non_null_expression"
            | "type_cast_expression"
    ) {
        // Checked before the children are read: this runs for the parent of every function node,
        // and a high-arity parent (a list of callbacks) would otherwise cost O(children) each time.
        return None;
    }
    // Comments are named children too (`(/* why */ () => 1)`), so they are skipped throughout.
    let children = named_children(wrapper);
    let mut values = children
        .into_iter()
        .filter(|child| !crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind()));
    match wrapper.kind() {
        "type_assertion" => values.next_back(),
        "parenthesized_statements" => {
            let value = values.next()?;
            values.next().is_none().then_some(value)
        }
        _ => values.next(),
    }
}

/// Climbs from a value through the transparent wrappers around it (`(() => 1)`, `(() => 2) as Fn`,
/// `<Fn>(() => 3)`, Rust `(|x| x) as fn(i32) -> i32`) to the outermost one, whose binding site
/// names the value.
fn unwrap_transparent_value_wrappers(node: Node<'_>) -> Node<'_> {
    let mut bound = node;
    while let Some(wrapper) = bound.parent().filter(|wrapper| {
        wrapped_transparent_value(*wrapper).is_some_and(|value| value.id() == bound.id())
    }) {
        bound = wrapper;
    }
    bound
}

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

    let bound = unwrap_transparent_value_wrappers(node);
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

    // A C++ lambda assigned to a variable (`auto f = [](int x) { ... };`) takes the variable name,
    // as does one that direct-initializes a deduced variable (`auto f{[] {}}`), whose type is the
    // closure itself. With a written type (`std::thread worker([] {})`) the lambda is a constructor
    // argument, and the constructor stores whatever it likes, so it names nothing.
    if node.kind() == "lambda_expression" {
        let declaration = match parent.kind() {
            "init_declarator" => Some(parent),
            "argument_list" | "initializer_list" if binding_children(parent).len() == 1 => parent
                .parent()
                .filter(|holder| holder.kind() == "init_declarator")
                .filter(|holder| declares_deduced_type(*holder)),
            _ => None,
        };
        if let Some(declaration) = declaration {
            return unwrap_declarator_name(declaration.child_by_field_name("declarator"), code);
        }
    }

    // A Go func literal bound via `add := func...`, `var add = func...`, or `add = func...` takes
    // the identifier (or selector field) at the same list position.
    if node.kind() == "func_literal" && parent.kind() == "expression_list" {
        return find_go_func_literal_name(bound, parent, code);
    }

    // Ruby and Python lambdas assigned to a name take that name.
    if node.kind() == "lambda" && parent.kind() == "assignment" {
        return find_ruby_assignment_name(parent, code);
    }
    if node.kind() == "lambda" && is_value_group(parent) {
        return find_parallel_assignment_name(bound, code);
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
    // A `lambda { }` / `proc { }` block is measured, but the call around it is what gets bound.
    if (node.kind() == "block" || node.kind() == "do_block") && is_ruby_lambda_call(parent, code) {
        let call = unwrap_transparent_value_wrappers(parent);
        return match call.parent() {
            Some(holder) if holder.kind() == "assignment" => {
                find_ruby_assignment_name(holder, code)
            }
            Some(holder) if holder.kind() == "pair" => find_pair_key_name(holder, code),
            Some(holder) if is_value_group(holder) => find_parallel_assignment_name(call, code),
            _ => None,
        };
    }

    // An object-literal or Ruby hash property (`{ run: () => {} }`, `{ run: -> {} }`) names its value
    // after the key; an assignment
    // (`obj.run = () => {}`, `run = () => {}`, Rust/C++ `self.cb = |x| x`, C++ `N::run = [] {}`,
    // C# `this.Run = () => 1`) after its target.
    if parent.kind() == "pair" {
        return find_pair_key_name(parent, code);
    }
    // A Go keyed composite-literal element (`S{run: func() {}}`) names its value after the key.
    if parent.kind() == "literal_element" {
        return find_go_keyed_element_name(parent, code);
    }
    // A Rust struct-literal field (`S { cb: || 1 }`) names its closure after the field.
    if parent.kind() == "field_initializer" {
        return parent
            .child_by_field_name("field")
            .map(|field| node_text(field, code).to_string());
    }
    // A C++20 designated initializer (`S s{.run = []{}}`) likewise names its value after the field;
    // an array designator (`{[0] = ...}`) names nothing, like a subscript assignment target.
    if parent.kind() == "initializer_pair" {
        return find_children_by_field_name(parent, "designator")
            .last()
            .filter(|designator| designator.kind() == "field_designator")
            .and_then(|designator| designator.named_child(0))
            .map(|field| node_text(field, code).to_string());
    }
    if parent.kind() == "assignment_expression" {
        return find_assignment_target_name(parent, code);
    }

    // A JavaScript class field (`handle = () => {}`) names its property through the `property`
    // field; TypeScript's `public_field_definition` exposes the same thing as `name`. A computed
    // key is as unstable here as in an object literal, and a string key is read the same way.
    let field_name = if parent.kind() == "field_definition" {
        "property"
    } else {
        "name"
    };
    let name = parent.child_by_field_name(field_name)?;
    // Checked only once a name exists, so a high-arity parent without one still costs O(1): the
    // parent names the function only when the function is its value. A receiver borrows nothing
    // (`((Runnable) () -> 1).run()` is not named `run`).
    if !is_value_of_parent(bound, parent) {
        return None;
    }
    match name.kind() {
        "computed_property_name" => None,
        "string" => find_string_literal_content(name, code),
        _ => Some(node_text(name, code).to_string()),
    }
}

/// The key of a `pair` when it is a plain, Ruby symbol, or string-literal property name; a
/// computed key (`[k]: ...`), an interpolated string or symbol, or an empty string names nothing.
fn find_pair_key_name(pair: Node<'_>, code: &Source<'_>) -> Option<String> {
    let key = pair.child_by_field_name("key")?;
    match key.kind() {
        // A numeric key (`{ 1: () => {} }`) is as stable a property name as an identifier, signed
        // (`{ -1: ... }`) or not; any other expression is computed and names nothing.
        "property_identifier" | "hash_key_symbol" => Some(node_text(key, code).to_string()),
        "number" | "integer" | "float" => Some(node_text(key, code).to_string()),
        "unary_operator" | "unary" if is_signed_number(key, code) => {
            Some(node_text(key, code).to_string())
        }
        "simple_symbol" => node_text(key, code)
            .strip_prefix(':')
            .map(|name| name.to_string()),
        "string" | "delimited_symbol" => find_string_literal_content(key, code),
        // Python's adjacent literals (`{"run" "ner": ...}`) are one compile-time key.
        "concatenated_string" => {
            let mut name = String::new();
            for part in binding_children(key) {
                if named_children(part)
                    .iter()
                    .any(|child| child.kind() == "interpolation")
                {
                    return None;
                }
                name.push_str(&find_string_literal_content(part, code).unwrap_or_default());
            }
            (!name.is_empty()).then_some(name)
        }
        _ => None,
    }
}

/// The type a constraint stands for: an approximation (`~map[string]F`), an interface holding one
/// type (`interface{ ~map[string]F }`), or a wrapper around one names that type; a union of several
/// names none of them in particular.
fn core_constraint_type(constraint: Node<'_>) -> Node<'_> {
    let mut current = constraint;
    while matches!(
        current.kind(),
        "type_constraint" | "negated_type" | "type_elem" | "interface_type"
    ) {
        match named_children(current).as_slice() {
            [only] => current = *only,
            _ => break,
        }
    }
    current
}

/// A number with a leading sign (`-1`), whose text is as stable a key as the number itself.
fn is_signed_number(key: Node<'_>, code: &Source<'_>) -> bool {
    let signed = all_children(key)
        .into_iter()
        .find(|child| !child.is_named())
        .is_some_and(|sign| matches!(node_text(sign, code), "-" | "+"));
    signed
        && named_children(key).first().is_some_and(|operand| {
            matches!(
                operand.kind(),
                "number"
                    | "integer"
                    | "float"
                    | "int_literal"
                    | "float_literal"
                    | "rune_literal"
                    | "imaginary_literal"
            )
        })
}

/// A Go keyed composite-literal element: the key is the first `literal_element` of the pair, the
/// value the last. An unkeyed element sits under a `literal_value` instead and names nothing.
fn find_go_keyed_element_name(value_element: Node<'_>, code: &Source<'_>) -> Option<String> {
    let keyed = value_element
        .parent()
        .filter(|parent| parent.kind() == "keyed_element")?;
    let elements = named_children(keyed);
    if elements.len() < 2 || elements.last()?.id() != value_element.id() {
        return None;
    }
    let key = named_children(*elements.first()?).into_iter().next()?;
    match key.kind() {
        "identifier" | "field_identifier" if !has_value_keys(keyed, code) => {
            Some(node_text(key, code).to_string())
        }
        "interpreted_string_literal" | "raw_string_literal" => {
            find_string_literal_content(key, code)
        }
        // A literal key is as stable a name here as in any other language's mapping, signed or not;
        // a rune carries quotes, which are read off like a string's.
        "rune_literal" => find_string_literal_content(key, code),
        "int_literal" | "float_literal" | "imaginary_literal" => {
            Some(node_text(key, code).to_string())
        }
        "unary_expression" if is_signed_number(key, code) => Some(node_text(key, code).to_string()),
        _ => None,
    }
}

/// Whether the element belongs to a Go literal whose keys are evaluated values (a map, slice, or
/// array) rather than the field names of a struct: `map[string]F{key: ...}` stores under whatever
/// `key` holds, so it names nothing, exactly like a computed property key.
fn has_value_keys(keyed: Node<'_>, code: &Source<'_>) -> bool {
    keyed
        .parent()
        .and_then(|body| key_type_of_literal_body(body, code))
        .is_some_and(|declared| is_value_keyed_type(declared, code))
}

/// Whether values written under this type are keyed by evaluated values rather than field names: a
/// map, slice or array, a name standing for one, or a constraint that admits only such types (a
/// union counts when every one of its terms does).
fn is_value_keyed_type(declared: Node<'_>, code: &Source<'_>) -> bool {
    let resolved = resolve_named_type(declared, code);
    match resolved.kind() {
        "map_type" | "slice_type" | "array_type" | "implicit_length_array_type" => true,
        "type_constraint" | "interface_type" | "type_elem" | "negated_type" => {
            let terms = binding_children(resolved);
            !terms.is_empty() && terms.iter().all(|term| is_value_keyed_type(*term, code))
        }
        _ => false,
    }
}

/// A literal's type may be a name declared in the same file (`type M map[string]F`), so the name is
/// resolved to the type it stands for. A name declared elsewhere stays unresolved and keeps the
/// struct reading, which is what a named literal type usually is.
fn resolve_named_type<'t>(declared: Node<'t>, code: &Source<'t>) -> Node<'t> {
    let mut current = declared;
    // A name may stand for another name (`type Alias M`) or be instantiated (`M[func()]`); the walk
    // follows the chain as far as it goes and stops on a node it has already seen, which is what a
    // declaration naming itself produces.
    let mut visited = Vec::new();
    while !visited.contains(&current.id()) {
        visited.push(current.id());
        let next = if current.kind() == "generic_type" {
            current.child_by_field_name("type")
        } else {
            lookup_declared_type(current, code)
        };
        match next {
            Some(next) => current = next,
            None => break,
        }
    }
    current
}

/// The type a name declared at the file's top level stands for.
fn lookup_declared_type<'t>(declared: Node<'t>, code: &Source<'t>) -> Option<Node<'t>> {
    if declared.kind() != "type_identifier" {
        return None;
    }
    let name = node_text(declared, code);
    // Go allows a type declaration in any block, so each enclosing scope is searched from the
    // innermost outwards, the way the language resolves the name; only its own declarations are
    // read at each level, which keeps the lookup shallow.
    let mut scope = Some(declared);
    while let Some(current) = scope {
        // A type parameter shadows any outer declaration of the same name, so its constraint is
        // what the literal is written against.
        if let Some(constraint) = named_children(current)
            .into_iter()
            .filter(|child| child.kind() == "type_parameter_list")
            .flat_map(|list| declared_type_parameters(list))
            .find(|(parameter_name, _)| node_text(*parameter_name, code) == name)
            .and_then(|(_, constraint)| constraint)
        {
            return Some(core_constraint_type(constraint));
        }
        // A method's receiver carries the parameters of the type it is declared on
        // (`func (r R[T]) ...`), so the name resolves through that type's declaration.
        if current.kind() == "method_declaration" {
            if let Some(constraint) = receiver_parameter_constraint(current, name, code) {
                return Some(core_constraint_type(constraint));
            }
        }
        if let Some(found) = find_type_spec(current, name, code) {
            return found.child_by_field_name("type");
        }
        scope = current.parent();
    }
    None
}

/// The declaration of a type named in this scope's own `type` declarations.
fn find_type_spec<'t>(scope: Node<'t>, name: &str, code: &Source<'t>) -> Option<Node<'t>> {
    named_children(scope)
        .into_iter()
        .filter(|child| child.kind() == "type_declaration")
        .flat_map(named_children)
        .filter(|spec| spec.kind() == "type_spec" || spec.kind() == "type_alias")
        .find(|spec| {
            spec.child_by_field_name("name")
                .is_some_and(|declared_name| node_text(declared_name, code) == name)
        })
}

/// The constraint a receiver type argument stands for: the parameter at the same position of the
/// receiver's own type declaration (`type R[T ~map[string]F]` reached through `func (r R[T])`).
fn receiver_parameter_constraint<'t>(
    method: Node<'t>,
    name: &str,
    code: &Source<'t>,
) -> Option<Node<'t>> {
    let receiver = method.child_by_field_name("receiver")?;
    let instantiation = named_children(receiver)
        .into_iter()
        .filter_map(|parameter| parameter.child_by_field_name("type"))
        // A pointer receiver (`func (r *R[T])`) wraps the instantiation, which is otherwise direct.
        .map(|declared| match declared.kind() {
            "pointer_type" => named_children(declared)
                .into_iter()
                .next()
                .unwrap_or(declared),
            _ => declared,
        })
        .find(|declared| declared.kind() == "generic_type")?;
    let arguments = binding_children(instantiation.child_by_field_name("type_arguments")?);
    let position = arguments.iter().position(|argument| {
        let argument = named_children(*argument)
            .into_iter()
            .next()
            .unwrap_or(*argument);
        node_text(argument, code) == name
    })?;
    let declaration = find_type_spec(
        method.parent()?,
        node_text(instantiation.child_by_field_name("type")?, code),
        code,
    )?;
    declared_type_parameters(declaration.child_by_field_name("type_parameters")?)
        .get(position)?
        .1
}

/// The parameters a type-parameter list declares, in order; one declaration can name several that
/// share its constraint (`[A, B ~map[string]F]`), so each name is its own parameter.
fn declared_type_parameters<'t>(list: Node<'t>) -> Vec<(Node<'t>, Option<Node<'t>>)> {
    binding_children(list)
        .into_iter()
        .filter(|declaration| declaration.kind() == "type_parameter_declaration")
        .flat_map(|declaration| {
            let constraint = declaration.child_by_field_name("type");
            find_children_by_field_name(declaration, "name")
                .into_iter()
                .map(|name| (name, constraint))
                .collect::<Vec<_>>()
        })
        .collect()
}

/// The type governing a literal body's keys: the type its own literal declares, or, when a nested
/// literal elides it, the element type of the literal holding it (`map[string]map[string]F{"a":
/// {k: f}}` nests a map, `[]S{{run: f}}` a struct). A literal nested in a struct field keeps the
/// struct reading, since the field's type is not written at the literal.
fn key_type_of_literal_body<'t>(body: Node<'t>, code: &Source<'t>) -> Option<Node<'t>> {
    let parent = body.parent()?;
    if parent.kind() == "composite_literal" {
        return parent.child_by_field_name("type");
    }
    if parent.kind() != "literal_element" {
        return None;
    }
    let mut container = parent.parent()?;
    if container.kind() == "keyed_element" {
        container = container.parent()?;
    }
    if container.kind() != "literal_value" {
        return None;
    }
    // The container's own type may be a name, which the element type is read through.
    let holder = resolve_named_type(key_type_of_literal_body(container, code)?, code);
    match holder.kind() {
        "map_type" => holder.child_by_field_name("value"),
        "slice_type" | "array_type" | "implicit_length_array_type" => {
            holder.child_by_field_name("element")
        }
        _ => None,
    }
}

/// The literal's content as written (escapes kept), read from the grammar's content children so
/// delimiters and prefixes (`"""k"""`, `r"k"`, `%q(k)`, `:"k"`) never leak into it. JavaScript
/// splits the content into `string_fragment` and `escape_sequence` siblings; Ruby and Python emit
/// `string_content` (Python nests escapes inside it). Interpolation makes the key unstable.
fn find_string_literal_content(literal: Node<'_>, code: &Source<'_>) -> Option<String> {
    let children = named_children(literal);
    if children.iter().any(|child| child.kind() == "interpolation") {
        return None;
    }
    // Go exposes no content node at all: it names only the escapes, so the concatenation is
    // trusted only when the literal really spells its content out.
    let mut content = String::new();
    let mut has_content_node = false;
    for child in &children {
        match child.kind() {
            "string_content" | "string_fragment" => {
                has_content_node = true;
                content.push_str(node_text(*child, code));
            }
            "escape_sequence" => content.push_str(node_text(*child, code)),
            _ => {}
        }
    }
    if has_content_node && !content.is_empty() {
        return Some(content);
    }
    // A grammar that exposes no content child (Go's string literals) keeps its delimiters in the
    // text; an empty literal is left without a name.
    let text = node_text(literal, code);
    let quote = text
        .chars()
        .next()
        .filter(|first| matches!(first, '"' | '\'' | '`'))?;
    let delimiter_length = text.chars().take_while(|char| *char == quote).count();
    if text.len() < 2 * delimiter_length {
        return None;
    }
    let (delimiter, rest) = text.split_at(delimiter_length);
    let inner = rest.strip_suffix(delimiter)?;
    (!inner.is_empty()).then(|| inner.to_string())
}

/// A compound assignment (`x += f`) does not bind the function to its target, so only a plain `=`
/// names it. Grammars with an `operator` field (C/C++, C#, Java) expose it directly; Go and Kotlin
/// have none, so the operator is the assignment's own anonymous token child.
fn is_plain_assignment(assignment: Node<'_>, code: &Source<'_>) -> bool {
    match assignment.child_by_field_name("operator") {
        Some(operator) => node_text(operator, code) == "=",
        None => all_children(assignment)
            .iter()
            .any(|child| !child.is_named() && node_text(*child, code) == "="),
    }
}

/// The assigned identifier, or the member name of a JS member, Rust/C++ field, C# member, or Java
/// field access (`a.b.run` names `run`) or a C++ qualified name (`N::run`); subscripts (`o["run"]`)
/// name nothing.
fn find_assignment_target_name(assignment: Node<'_>, code: &Source<'_>) -> Option<String> {
    if !is_plain_assignment(assignment, code) {
        return None;
    }
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

/// The Kotlin assignment target: the variable itself or the member of a trailing navigation suffix
/// (`obj.run` names `run`); a trailing indexing suffix (`arr[0] = { }`) names nothing, like
/// subscripts in the other languages.
fn find_kotlin_assignment_name(assignment: Node<'_>, code: &Source<'_>) -> Option<String> {
    if !is_plain_assignment(assignment, code) {
        return None;
    }
    let target = first_named_child_of_kind(assignment, "directly_assignable_expression")?;
    let children = named_children(target);
    let holder = match children.last()? {
        last if last.kind() == "navigation_suffix" => *last,
        last if last.kind() == "simple_identifier" && children.len() == 1 => target,
        _ => return None,
    };
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

/// Whether the node occupies its parent's value position: the `value` field, or no field at all
/// (a C# `variable_declarator` holds its initializer without one).
fn is_value_of_parent(node: Node<'_>, parent: Node<'_>) -> bool {
    for index in 0..parent.child_count() {
        if parent
            .child(index)
            .is_some_and(|child| child.id() == node.id())
        {
            return matches!(
                parent.field_name_for_child(index as u32),
                None | Some("value")
            );
        }
    }
    false
}

/// A value group of a Python or Ruby parallel assignment: the value list itself, or a tuple, list,
/// or array literal that destructuring takes apart (`a, (b, c) = x, (f, y)`, `a, b = [f, g]`). A set
/// or a mapping is unordered, so it groups nothing positionally.
fn is_value_group(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "expression_list" | "right_assignment_list" | "tuple" | "list" | "array"
    )
}

/// The matching target groups, which a nested value group is aligned against level by level.
fn is_target_group(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "pattern_list"
            | "left_assignment_list"
            | "tuple_pattern"
            | "list_pattern"
            | "destructured_left_assignment"
    )
}

/// A parallel assignment binds each value to the target at the same position, at every level of
/// destructuring. The position this value takes in each group it sits in is collected on the way up
/// to the assignment, then replayed on the target side.
fn find_parallel_assignment_name(value: Node<'_>, code: &Source<'_>) -> Option<String> {
    let mut positions = Vec::new();
    let mut current = value;
    let assignment = loop {
        let parent = current.parent()?;
        if is_value_group(parent) {
            positions.push((parent, current));
            current = parent;
            continue;
        }
        if parent.kind() == "assignment"
            && parent.child_by_field_name("right")?.id() == current.id()
        {
            break parent;
        }
        return None;
    };
    let mut target = assignment.child_by_field_name("left")?;
    for (values, child) in positions.iter().rev() {
        // Ruby spells a fully parenthesized target list as a `left_assignment_list` holding one
        // destructured group (`(a, b) = f, g`), which aligns against that inner one. A Python
        // singleton tuple is a real destructuring level instead, so it is left alone.
        while target.kind() == "left_assignment_list" {
            match binding_children(target).as_slice() {
                [only] if only.kind() == "destructured_left_assignment" => target = *only,
                _ => break,
            }
        }
        if !is_target_group(target) {
            return None;
        }
        target = aligned_target(*values, *child, target)?;
    }
    find_assignment_target_text(target, code)
}

/// The target a value takes within one group. Comments are named children of both sides but bind
/// nothing, so they are skipped. Values before every splat align from the left, and values after
/// every splat align from the right against the targets that follow the starred one; a value with a
/// splat on both sides, or one the star swallows, binds nothing knowable here.
fn aligned_target<'t>(values: Node<'_>, value: Node<'_>, targets: Node<'t>) -> Option<Node<'t>> {
    let value_list = binding_children(values);
    let index = value_list
        .iter()
        .position(|child| child.id() == value.id())?;
    let splat_before = value_list[..index].iter().any(is_splat);
    let splat_after = value_list[index + 1..].iter().any(is_splat);
    let trailing = value_list.len() - 1 - index;
    let unpacks = matches!(
        targets.kind(),
        "pattern_list" | "tuple_pattern" | "list_pattern"
    );
    let targets = binding_children(targets);
    let splats: Vec<usize> = targets
        .iter()
        .enumerate()
        .filter(|(_, target)| is_splat(target))
        .map(|(index, _)| index)
        .collect();
    // Python unpacking binds nothing unless the counts can fit, since it raises instead; Ruby fills
    // the extra targets with nil, so its names hold either way. A splat among the values hides how
    // many they are, but never fewer than the values written beside it.
    let value_splat = value_list.iter().any(is_splat);
    let written_values = value_list.iter().filter(|value| !is_splat(value)).count();
    let counts_fit = !unpacks
        || match (splats.is_empty(), value_splat) {
            (true, false) => value_list.len() == targets.len(),
            (true, true) => written_values <= targets.len(),
            (false, false) => value_list.len() + 1 >= targets.len(),
            (false, true) => true,
        };
    if !counts_fit {
        return None;
    }
    match splats.as_slice() {
        [] if !splat_before => targets.get(index).copied(),
        // Python unpacking takes exactly as many values as it has targets, so a value with no splat
        // after it sits at a fixed distance from the end however the earlier splat expands.
        [] if unpacks && !splat_after => targets.get(targets.len() - 1 - trailing).copied(),
        &[splat] if !splat_before && index < splat => targets.get(index).copied(),
        &[splat] if !splat_after && trailing < targets.len() - splat - 1 => {
            // Aligning from the right needs the values to reach the trailing targets, which the
            // values written beside any splat can already guarantee. Otherwise only Python assures
            // it, by failing the assignment, while Ruby fills the trailing targets from the left
            // when it underflows.
            let reaches_trailing_targets = written_values + 1 >= targets.len()
                || value_list.iter().any(|child| child.kind() == "list_splat");
            if reaches_trailing_targets {
                targets.get(targets.len() - 1 - trailing).copied()
            } else if !splat_before && targets[splat].kind() == "rest_assignment" {
                // Ruby empties the star and fills the trailing targets from the left when the
                // values run out, so each one binds the next target (`a, *r, c, d = x, f` binds
                // `f` to `c`); Python fails such an assignment instead.
                targets.get(index + 1).copied()
            } else {
                None
            }
        }
        _ => None,
    }
}

/// A splat on either side of a parallel assignment (`*xs`, `*rest`).
fn is_splat(node: &Node<'_>) -> bool {
    matches!(
        node.kind(),
        "splat_argument" | "rest_assignment" | "list_splat" | "list_splat_pattern"
    )
}

fn binding_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    named_children(node)
        .into_iter()
        .filter(|child| !crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind()))
        .collect()
}

/// The name a Ruby or Python assignment target binds: a local, constant, or Ruby instance, class or
/// global variable; the method of a Ruby attribute writer (`self.run = ...`); or a Python attribute
/// (`obj.run = ...`). A subscript or a splat has no stable name and binds none.
fn find_assignment_target_text(target: Node<'_>, code: &Source<'_>) -> Option<String> {
    match target.kind() {
        "identifier" | "constant" | "instance_variable" | "class_variable" | "global_variable" => {
            Some(node_text(target, code).to_string())
        }
        "call" if target.child_by_field_name("receiver").is_some() => target
            .child_by_field_name("method")
            .map(|method| node_text(method, code).to_string()),
        "attribute" => target
            .child_by_field_name("attribute")
            .map(|attribute| node_text(attribute, code).to_string()),
        _ => None,
    }
}

/// The name a Ruby or Python single assignment binds. Ruby also allows a target list with one
/// value: a value that is not an array goes to the first target that is not the star, descending
/// into a nested group (`a, b = -> { 1 }` and `*a, b = -> { 1 }` both bind the lambda to a name).
fn find_ruby_assignment_name(assignment: Node<'_>, code: &Source<'_>) -> Option<String> {
    let left = assignment.child_by_field_name("left")?;
    let mut target = left;
    if matches!(
        left.kind(),
        "left_assignment_list" | "destructured_left_assignment"
    ) {
        while is_target_group(target) {
            target = binding_children(target)
                .into_iter()
                .find(|child| !is_splat(child))?;
        }
    }
    find_assignment_target_text(target, code)
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

    if holder.kind() == "assignment_statement" && !is_plain_assignment(holder, code) {
        return None;
    }
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

/// Whether the declaration around this declarator deduces its type (`auto`), which makes the
/// variable the closure itself rather than something constructed from it.
fn declares_deduced_type(declarator: Node<'_>) -> bool {
    declarator
        .parent()
        .and_then(|declaration| declaration.child_by_field_name("type"))
        .is_some_and(|declared| declared.kind() == "placeholder_type_specifier")
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
