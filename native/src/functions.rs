use indexmap::IndexSet;
use std::collections::{HashMap, HashSet};
use tree_sitter::Node;

use crate::complexity::{is_function_boundary, FunctionBodyMetrics, LanguageSets};
use crate::util::{
    all_children, find_children_by_field_name, named_children, node_text, strip_js_whitespace,
    Source,
};

/// How a call site addresses its callee: `None` is a bare call (`f()`), `SelfLike` goes through
/// the caller's own instance (`this.f()`, `self.f()`), `Other` has any other explicit receiver.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CallReceiver {
    None,
    SelfLike,
    Other,
}

pub struct CallSite {
    pub name: String,
    /// None when the syntax carries no argument list (e.g. Rust macro token trees).
    pub argument_count: Option<usize>,
    pub receiver: CallReceiver,
}

pub struct FunctionAnalysis {
    pub index: usize,
    pub name: Option<String>,
    pub node_type: &'static str,
    /// Name of the enclosing class-like scope, used to disambiguate same-named methods.
    pub scope_name: Option<String>,
    /// False for bodyless signatures (Java abstract/interface methods), which resolve no calls.
    pub has_implementation: bool,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub returns_jsx: bool,
    pub cyclomatic_complexity: u64,
    pub cognitive_complexity: u64,
    pub nesting_depth: u64,
    pub ncss: u64,
    pub call_count: u64,
    pub parameter_count: usize,
    pub callees: IndexSet<String>,
    pub call_sites: Vec<CallSite>,
    pub identifiers: HashSet<String>,
}

pub struct CallsResult {
    pub call_count: u64,
    pub callees: IndexSet<String>,
    pub call_sites: Vec<CallSite>,
}

/// C++ `function_definition` also covers pure-virtual/`= default`/`= delete` members; those have no
/// `body` and are signatures, not implementations, matching how TypeScript method signatures are
/// excluded. Java `method_declaration` is NOT here: PMD reports abstract/interface methods as
/// methods (cyclomatic 1, NCSS 1), so bodyless Java methods stay in the function list.
const BODY_REQUIRED_FUNCTION_TYPES: &[&str] = &[
    "function_definition",
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

/// Whether the function carries an implementation. Only Java `method_declaration` can be
/// bodyless here (abstract/interface methods); every other bodyless kind is filtered out of the
/// function list by `is_implemented_function`.
fn has_implementation_body(node: Node<'_>) -> bool {
    node.kind() != "method_declaration" || node.child_by_field_name("body").is_some()
}

pub fn analyze_function(
    node: Node<'_>,
    sets: &LanguageSets,
    index: usize,
    constructed_type_names: &HashSet<String>,
    body_metrics: &FunctionBodyMetrics,
    code: &Source<'_>,
) -> FunctionAnalysis {
    let calls = collect_calls(node, sets, constructed_type_names, code);
    FunctionAnalysis {
        index,
        name: find_function_name(node, code),
        node_type: node.kind(),
        scope_name: find_function_scope_name(node, code),
        has_implementation: has_implementation_body(node),
        start_line: node.start_position().row + 1,
        // The tree is parsed from UTF-16, so columns are UTF-16 code units x 2 — halving yields
        // the code-unit column node-tree-sitter reports.
        start_column: node.start_position().column / 2,
        end_line: node.end_position().row + 1,
        returns_jsx: returns_jsx(node, sets, code),
        cyclomatic_complexity: body_metrics.cyclomatic_complexity,
        cognitive_complexity: body_metrics.cognitive_complexity,
        nesting_depth: body_metrics.nesting_depth,
        ncss: body_metrics.ncss,
        call_count: calls.call_count,
        parameter_count: count_parameters(node, code),
        callees: calls.callees,
        call_sites: calls.call_sites,
        identifiers: collect_identifiers(node, code),
    }
}

/// Class-like nodes that scope their methods; namespaces are not scopes for bare-call resolution.
const SCOPE_NODE_TYPES: &[&str] = &[
    "class_declaration",
    "class_definition",
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
    "object_creation_expression",
    "class",
    "module",
    "singleton_class",
    "struct_item",
    "enum_item",
    "union_item",
    "trait_item",
    "impl_item",
];

/// Qualified name of the class-like scope chain enclosing a function (`Outer::Worker`); see
/// findFunctionScopeName in metrics.ts. Go methods carry their scope on the receiver, and C++
/// out-of-line members (`void Widget::process()`) on the qualified declarator.
fn find_function_scope_name(node: Node<'_>, code: &Source<'_>) -> Option<String> {
    let mut segments: Vec<String> = Vec::new();
    let mut current = node.parent();
    while let Some(ancestor) = current {
        current = ancestor.parent();
        if !SCOPE_NODE_TYPES.contains(&ancestor.kind()) {
            continue;
        }
        // A plain `new Foo(...)` scopes nothing; only an anonymous-class body opens a scope.
        if ancestor.kind() == "object_creation_expression"
            && !named_children(ancestor)
                .iter()
                .any(|child| child.kind() == "class_body")
        {
            continue;
        }
        // Rust `impl` blocks scope by the implementing type rather than a `name` field.
        let name_node = if ancestor.kind() == "impl_item" {
            ancestor.child_by_field_name("type")
        } else {
            ancestor.child_by_field_name("name")
        };
        segments.push(match name_node {
            Some(name_node) => node_text(name_node, code).to_string(),
            None => anonymous_scope_name(ancestor),
        });
    }
    if !segments.is_empty() {
        segments.reverse();
        return Some(segments.join("::"));
    }

    if node.kind() == "method_declaration" {
        let receiver_type_node = node
            .child_by_field_name("receiver")
            .and_then(|receiver| named_children(receiver).first().copied())
            .and_then(|first| first.child_by_field_name("type"));
        if let Some(receiver_type_node) = receiver_type_node {
            return Some(normalize_go_receiver_type(node_text(
                receiver_type_node,
                code,
            )));
        }
    }

    let qualified_name = unwrap_declarator_name(node.child_by_field_name("declarator"), true, code);
    if let Some(qualified_name) = qualified_name {
        if let Some(scope_end) = qualified_name.rfind("::") {
            if scope_end > 0 {
                return Some(qualified_name[..scope_end].to_string());
            }
        }
    }
    None
}

fn normalize_go_receiver_type(receiver_type: &str) -> String {
    strip_js_whitespace(receiver_type)
        .trim_start_matches('*')
        .to_string()
}

/// Unnamed scopes (anonymous classes) get a per-node marker so they never cross-match.
fn anonymous_scope_name(node: Node<'_>) -> String {
    format!("<anonymous:{}>", node.start_position().row)
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

struct CallsCollector<'a, 'code> {
    sets: &'a LanguageSets,
    constructed_type_names: &'a HashSet<String>,
    code: &'a Source<'code>,
    call_count: u64,
    callees: IndexSet<String>,
    call_sites: Vec<CallSite>,
    ruby_bindings_cache: HashMap<usize, HashMap<String, usize>>,
}

impl CallsCollector<'_, '_> {
    fn add_callee(&mut self, name: String, argument_count: Option<usize>, receiver: CallReceiver) {
        self.callees.insert(name.clone());
        self.call_sites.push(CallSite {
            name,
            argument_count,
            receiver,
        });
    }

    fn visit(&mut self, node: Node<'_>, inside_root: bool) {
        if !inside_root && is_function_boundary(node, &self.sets.function_nodes) {
            return;
        }

        // C++ casts (`int(x)`, `static_cast<int>(x)`) parse as call expressions but invoke nothing.
        if self.sets.name == "cpp" && is_cpp_cast_expression(node, self.code) {
            // Not a call: fall through to children only.
        } else if is_call_node(node) {
            self.call_count += 1;
            // C++ `new Widget()` and functional construction name an overloaded constructor, so they
            // count as calls without a callee edge. JS `new Foo()` keeps its edge to the function.
            let is_cpp_constructor_call = self.sets.name == "cpp"
                && (node.kind() == "new_expression"
                    || (node.kind() == "call_expression"
                        && cpp_base_type_name(node.child_by_field_name("function"), self.code)
                            .is_some_and(|name| self.constructed_type_names.contains(&name))));
            let callee = if is_cpp_constructor_call {
                None
            } else {
                find_callee_name(node, self.code)
            };
            // JS truthiness: `if (callee)` also drops the empty string a MISSING node produces.
            if let Some(callee) = callee.filter(|callee| !callee.is_empty()) {
                // A Ruby setter send (`self.foo = x` resolves the callee to `foo=`) passes one argument.
                let is_ruby_setter_send =
                    self.sets.name == "ruby" && node.kind() == "call" && callee.ends_with('=');
                let argument_count = if is_ruby_setter_send {
                    Some(1)
                } else {
                    count_call_arguments(node)
                };
                let receiver = classify_call_receiver(node, self.sets, self.code);
                self.add_callee(callee, argument_count, receiver);
            }
            // Ruby abbreviated assignment on a receiver (`self.foo += 1`) invokes the getter AND the
            // setter, so the setter is one extra call.
            if self.sets.name == "ruby"
                && node.kind() == "call"
                && node.parent().is_some_and(|parent| {
                    parent.kind() == "operator_assignment"
                        && parent
                            .child_by_field_name("left")
                            .is_some_and(|left| left.id() == node.id())
                })
            {
                self.call_count += 1;
                if let Some(setter_method) = node.child_by_field_name("method") {
                    let receiver = classify_call_receiver(node, self.sets, self.code);
                    self.add_callee(
                        format!("{}=", node_text(setter_method, self.code)),
                        Some(1),
                        receiver,
                    );
                }
            }
        } else if is_ruby_implicit_call(node, self.sets)
            || is_cpp_construction(node, self.constructed_type_names, self.code)
        {
            // `yield x` invokes the block, not its argument, and constructors are overloaded by
            // definition, so neither adds a callee edge.
            self.call_count += 1;
        } else if self.sets.name == "ruby"
            && is_ruby_bare_method_send(node, self.code, &mut self.ruby_bindings_cache)
        {
            self.call_count += 1;
            self.add_callee(
                node_text(node, self.code).to_string(),
                Some(0),
                CallReceiver::None,
            );
        }

        for child in named_children(node) {
            self.visit(child, false);
        }
    }
}

pub fn collect_calls(
    root: Node<'_>,
    sets: &LanguageSets,
    constructed_type_names: &HashSet<String>,
    code: &Source<'_>,
) -> CallsResult {
    let mut collector = CallsCollector {
        sets,
        constructed_type_names,
        code,
        call_count: 0,
        callees: IndexSet::new(),
        call_sites: Vec::new(),
        ruby_bindings_cache: HashMap::new(),
    };
    collector.visit(root, true);
    CallsResult {
        call_count: collector.call_count,
        callees: collector.callees,
        call_sites: collector.call_sites,
    }
}

/// Declared arguments at a call site, for arity-based overload resolution. Ruby block arguments
/// (`&blk`) bind the block, not a positional parameter. Syntax without an argument list that can
/// still be a counted call (Rust macros) reports no arity.
fn count_call_arguments(node: Node<'_>) -> Option<usize> {
    let Some(arguments_node) = node.child_by_field_name("arguments") else {
        return if node.kind() == "macro_invocation" {
            None
        } else {
            Some(0)
        };
    };
    Some(
        named_children(arguments_node)
            .iter()
            .filter(|child| child.kind() != "comment" && child.kind() != "block_argument")
            .count(),
    )
}

fn classify_call_receiver(node: Node<'_>, sets: &LanguageSets, code: &Source<'_>) -> CallReceiver {
    if sets.name == "ruby" && node.kind() == "call" {
        let Some(receiver_node) = node.child_by_field_name("receiver") else {
            return CallReceiver::None;
        };
        return if receiver_node.kind() == "self" {
            CallReceiver::SelfLike
        } else {
            CallReceiver::Other
        };
    }

    if node.kind() == "method_invocation" {
        let Some(object_node) = node.child_by_field_name("object") else {
            return CallReceiver::None;
        };
        return if object_node.kind() == "this" {
            CallReceiver::SelfLike
        } else {
            CallReceiver::Other
        };
    }

    if let Some(callee_node) = node.child_by_field_name("function") {
        let unwrapped = unwrap_parenthesized_expression(callee_node);
        if unwrapped.kind() == "identifier" {
            return CallReceiver::None;
        }
        // Rust `Self::helper()` invokes an associated function of the caller's own impl.
        if unwrapped.kind() == "scoped_identifier"
            && unwrapped
                .child_by_field_name("path")
                .is_some_and(|path| node_text(path, code) == "Self")
        {
            return CallReceiver::SelfLike;
        }
        let receiver_node = match unwrapped.kind() {
            "member_expression" => unwrapped.child_by_field_name("object"),
            "field_expression" => unwrapped
                .child_by_field_name("argument")
                .or_else(|| unwrapped.child_by_field_name("value")),
            "attribute" => unwrapped.child_by_field_name("object"),
            _ => None,
        };
        if let Some(receiver_node) = receiver_node {
            return if is_self_like_receiver(receiver_node, code) {
                CallReceiver::SelfLike
            } else {
                CallReceiver::Other
            };
        }
    }
    CallReceiver::Other
}

/// JS `this`, Rust/Ruby `self` nodes, and Python's conventional `self` identifier.
fn is_self_like_receiver(node: Node<'_>, code: &Source<'_>) -> bool {
    node.kind() == "this"
        || node.kind() == "self"
        || (node.kind() == "identifier" && node_text(node, code) == "self")
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

/// A Ruby bare receiverless zero-argument send parses as a plain `identifier`; see
/// isRubyBareMethodSend in metrics.ts (issue #20).
fn is_ruby_bare_method_send(
    node: Node<'_>,
    code: &Source<'_>,
    bindings_cache: &mut HashMap<usize, HashMap<String, usize>>,
) -> bool {
    if node.kind() != "identifier" || !is_ruby_expression_identifier(node) {
        return false;
    }
    !is_ruby_local_variable(node, code, bindings_cache)
}

/// Identifier positions that bind a local or belong to another construct rather than reading a value.
fn is_ruby_expression_identifier(node: Node<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };

    match parent.kind() {
        // The method name of a `call` is part of the already-counted call; a `method` definition's
        // name (and `def obj.meth`'s object) defines rather than reads.
        "call"
            if parent
                .child_by_field_name("method")
                .is_some_and(|method| method.id() == node.id()) =>
        {
            return false;
        }
        // `alias c a` operands are method-name references; neither invokes anything.
        "method" | "singleton_method" | "setter" | "alias" => {
            return false;
        }
        // Binding targets: `x = 1`, `x ||= 1`, `for x in ...`, `rescue => x`, and every parameter form.
        "assignment" | "operator_assignment"
            if parent
                .child_by_field_name("left")
                .is_some_and(|left| left.id() == node.id()) =>
        {
            return false;
        }
        "left_assignment_list"
        | "destructured_left_assignment"
        | "rest_assignment"
        | "exception_variable"
        | "method_parameters"
        | "block_parameters"
        | "lambda_parameters"
        | "destructured_parameter"
        | "splat_parameter"
        | "optional_parameter"
        | "keyword_parameter"
        | "hash_splat_parameter"
        | "block_parameter" => {
            // An optional/keyword parameter's default value is a genuine read.
            return parent
                .child_by_field_name("value")
                .is_some_and(|value| value.id() == node.id());
        }
        "for"
            if parent
                .child_by_field_name("pattern")
                .is_some_and(|pattern| pattern.id() == node.id()) =>
        {
            return false;
        }
        _ => {}
    }

    // Pattern-matching positions bind (`in [head, *tail]`, `v => x`); pinned expressions inside
    // patterns are reads, but skipping them only misses calls (conservative).
    let mut current = Some(node);
    while let Some(current_node) = current {
        if RUBY_PATTERN_NODE_TYPES.contains(&current_node.kind()) {
            return false;
        }
        if current_node.parent().is_some_and(|grandparent| {
            (grandparent.kind() == "in_clause" || grandparent.kind() == "match_pattern")
                && grandparent
                    .child_by_field_name("pattern")
                    .is_some_and(|pattern| pattern.id() == current_node.id())
        }) {
            return false;
        }
        if is_ruby_scope_node(current_node.kind()) {
            break;
        }
        current = current_node.parent();
    }

    // `defined?(helper)` inspects without invoking.
    let mut ancestor = parent;
    while ancestor.kind() == "parenthesized_statements" {
        let Some(next) = ancestor.parent() else {
            break;
        };
        ancestor = next;
    }
    !(ancestor.kind() == "unary"
        && ancestor
            .child(0)
            .is_some_and(|child| child.kind() == "defined?"))
}

const RUBY_PATTERN_NODE_TYPES: &[&str] = &[
    "array_pattern",
    "hash_pattern",
    "find_pattern",
    "keyword_pattern",
    "as_pattern",
    "alternative_pattern",
];

/// Hard boundaries see no outer locals; soft scopes (blocks, lambdas) do.
const RUBY_HARD_SCOPE_NODE_TYPES: &[&str] = &[
    "method",
    "singleton_method",
    "class",
    "module",
    "singleton_class",
    "program",
];
const RUBY_SOFT_SCOPE_NODE_TYPES: &[&str] = &["block", "do_block", "lambda"];

fn is_ruby_scope_node(kind: &str) -> bool {
    RUBY_HARD_SCOPE_NODE_TYPES.contains(&kind) || RUBY_SOFT_SCOPE_NODE_TYPES.contains(&kind)
}

fn is_ruby_local_variable(
    node: Node<'_>,
    code: &Source<'_>,
    bindings_cache: &mut HashMap<usize, HashMap<String, usize>>,
) -> bool {
    let name = node_text(node, code);
    let mut scope = find_enclosing_ruby_scope(node.parent());
    while let Some(scope_node) = scope {
        let bindings = bindings_cache
            .entry(scope_node.id())
            .or_insert_with(|| collect_ruby_scope_bindings(scope_node, code));
        if bindings
            .get(name)
            .is_some_and(|binding_index| *binding_index < node.start_byte())
        {
            return true;
        }
        scope = if RUBY_HARD_SCOPE_NODE_TYPES.contains(&scope_node.kind()) {
            None
        } else {
            find_enclosing_ruby_scope(scope_node.parent())
        };
    }
    false
}

fn find_enclosing_ruby_scope(node: Option<Node<'_>>) -> Option<Node<'_>> {
    let mut current = node;
    while let Some(current_node) = current {
        if is_ruby_scope_node(current_node.kind()) {
            return Some(current_node);
        }
        current = current_node.parent();
    }
    None
}

/// Earliest binding position of each local name a scope binds directly; see
/// collectRubyScopeBindings in metrics.ts. Bindings inside nested scopes never escape them.
fn collect_ruby_scope_bindings(scope: Node<'_>, code: &Source<'_>) -> HashMap<String, usize> {
    let mut bindings: HashMap<String, usize> = HashMap::new();

    collect_ruby_parameter_bindings(scope.child_by_field_name("parameters"), code, &mut bindings);

    // A parameter-less block/lambda implicitly binds the numbered parameters `_1`..`_9` (2.7+) and
    // `it` (3.4+) from its start, so such reads are (potential) parameter reads, not method sends.
    if RUBY_SOFT_SCOPE_NODE_TYPES.contains(&scope.kind())
        && scope.child_by_field_name("parameters").is_none()
    {
        add_ruby_binding(&mut bindings, "it", scope.start_byte());
        for numbered in 1..=9 {
            add_ruby_binding(&mut bindings, &format!("_{numbered}"), scope.start_byte());
        }
    }

    fn visit(node: Node<'_>, code: &Source<'_>, bindings: &mut HashMap<String, usize>) {
        for child in named_children(node) {
            if is_ruby_scope_node(child.kind()) {
                continue;
            }
            collect_ruby_node_bindings(child, code, bindings);
            visit(child, code, bindings);
        }
    }

    visit(scope, code, &mut bindings);
    bindings
}

fn add_ruby_binding(bindings: &mut HashMap<String, usize>, name: &str, index: usize) {
    match bindings.get(name) {
        Some(existing) if *existing <= index => {}
        _ => {
            bindings.insert(name.to_string(), index);
        }
    }
}

fn collect_ruby_node_bindings(
    node: Node<'_>,
    code: &Source<'_>,
    bindings: &mut HashMap<String, usize>,
) {
    match node.kind() {
        "assignment" => {
            add_ruby_assignment_targets(node.child_by_field_name("left"), code, bindings);
        }
        "operator_assignment" => {
            if let Some(left) = node.child_by_field_name("left") {
                if left.kind() == "identifier" {
                    add_ruby_binding(bindings, node_text(left, code), left.start_byte());
                }
            }
        }
        "for" => {
            add_ruby_assignment_targets(node.child_by_field_name("pattern"), code, bindings);
        }
        "exception_variable" => {
            if let Some(variable) = node.named_child(0) {
                if variable.kind() == "identifier" {
                    add_ruby_binding(bindings, node_text(variable, code), variable.start_byte());
                }
            }
        }
        // `case/in` patterns and rightward assignment (`v => x`) bind their captures.
        "in_clause" | "match_pattern" => {
            if let Some(pattern) = node.child_by_field_name("pattern") {
                add_ruby_pattern_bindings(pattern, code, bindings);
            }
        }
        // `/(?<year>...)/ =~ value` binds each named capture as a local, but ONLY when the regexp
        // literal is the LEFT operand (Regexp#=~); `value =~ /(?<year>...)/` binds nothing.
        "binary" => {
            let has_match_operator = all_children(node)
                .iter()
                .any(|child| !child.is_named() && node_text(*child, code) == "=~");
            if has_match_operator {
                if let Some(regex_node) = node
                    .child_by_field_name("left")
                    .filter(|left| left.kind() == "regex")
                {
                    for capture_name in ruby_regex_named_captures(node_text(regex_node, code)) {
                        add_ruby_binding(bindings, &capture_name, node.start_byte());
                    }
                }
            }
        }
        _ => {}
    }
}

/// Names in `(?<name>` groups, mirroring the `\(\?<([A-Za-z_][A-Za-z0-9_]*)>` regex in metrics.ts.
fn ruby_regex_named_captures(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut names = Vec::new();
    let mut index = 0;
    while index + 3 < bytes.len() {
        if &bytes[index..index + 3] == b"(?<" {
            let start = index + 3;
            let mut end = start;
            if end < bytes.len() && (bytes[end].is_ascii_alphabetic() || bytes[end] == b'_') {
                end += 1;
                while end < bytes.len()
                    && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'_')
                {
                    end += 1;
                }
                if end < bytes.len() && bytes[end] == b'>' {
                    names.push(text[start..end].to_string());
                    index = end + 1;
                    continue;
                }
            }
        }
        index += 1;
    }
    names
}

fn add_ruby_assignment_targets(
    target: Option<Node<'_>>,
    code: &Source<'_>,
    bindings: &mut HashMap<String, usize>,
) {
    let Some(target) = target else {
        return;
    };
    if target.kind() == "identifier" {
        add_ruby_binding(bindings, node_text(target, code), target.start_byte());
        return;
    }
    if matches!(
        target.kind(),
        "left_assignment_list" | "destructured_left_assignment" | "rest_assignment"
    ) {
        for child in named_children(target) {
            add_ruby_assignment_targets(Some(child), code, bindings);
        }
    }
}

/// Every identifier in a pattern binds; a valueless `in {name:}` key binds the key's name too.
fn add_ruby_pattern_bindings(
    pattern: Node<'_>,
    code: &Source<'_>,
    bindings: &mut HashMap<String, usize>,
) {
    if pattern.kind() == "identifier" {
        add_ruby_binding(bindings, node_text(pattern, code), pattern.start_byte());
        return;
    }
    if pattern.kind() == "keyword_pattern" && pattern.named_child_count() == 1 {
        if let Some(key) = pattern.child_by_field_name("key") {
            add_ruby_binding(bindings, node_text(key, code), key.start_byte());
        }
    }
    for child in named_children(pattern) {
        add_ruby_pattern_bindings(child, code, bindings);
    }
}

fn collect_ruby_parameter_bindings(
    parameters: Option<Node<'_>>,
    code: &Source<'_>,
    bindings: &mut HashMap<String, usize>,
) {
    let Some(parameters) = parameters else {
        return;
    };
    for child in named_children(parameters) {
        if child.kind() == "identifier" {
            add_ruby_binding(bindings, node_text(child, code), child.start_byte());
        } else if child.kind() == "destructured_parameter" {
            collect_ruby_parameter_bindings(Some(child), code, bindings);
        } else if let Some(name_node) = child.child_by_field_name("name") {
            if name_node.kind() == "identifier" {
                add_ruby_binding(bindings, node_text(name_node, code), name_node.start_byte());
            }
        }
    }
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
