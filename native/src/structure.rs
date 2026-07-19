use indexmap::IndexSet;
use std::collections::HashSet;
use std::sync::OnceLock;
use tree_sitter::Node;

use crate::complexity::LanguageSets;
use crate::functions::{
    collect_nodes, has_storage_class, is_call_node, next_declarator, unwrap_declarator_name,
};
use crate::types::{CouplingMetrics, DeclarationMetrics, ModuleMetrics};
use crate::util::{
    all_children, find_children_by_field_name, named_children, node_text, strip_js_whitespace,
};

/// JavaScript's `\s` for the regex ports below (regex crate `\s` differs on U+FEFF).
const JS_WS: &str = r"[\t\n\x0B\x0C\r \u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";

fn export_import_regex() -> &'static regex::Regex {
    static REGEX: OnceLock<regex::Regex> = OnceLock::new();
    REGEX.get_or_init(|| regex::Regex::new(&format!("^export{JS_WS}+import(?-u:\\b)")).unwrap())
}

fn import_unit_regex() -> &'static regex::Regex {
    static REGEX: OnceLock<regex::Regex> = OnceLock::new();
    REGEX.get_or_init(|| regex::Regex::new(&format!("^import{JS_WS}+[:\"<]")).unwrap())
}

fn import_source_regex() -> &'static regex::Regex {
    static REGEX: OnceLock<regex::Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        regex::Regex::new(&format!(
            "^(?:export{JS_WS}+)?import{JS_WS}+([0-9A-Za-z_.:]+|\"[^\"]+\"|<[^>]+>)"
        ))
        .unwrap()
    })
}

pub fn measure_coupling(root: Node<'_>, sets: &LanguageSets, code: &str) -> CouplingMetrics {
    let mut import_sources: IndexSet<String> = IndexSet::new();
    let mut import_count: u64 = 0;
    let mut export_count: u64 = 0;

    fn visit(
        node: Node<'_>,
        sets: &LanguageSets,
        code: &str,
        import_sources: &mut IndexSet<String>,
        import_count: &mut u64,
        export_count: &mut u64,
    ) {
        // Go nests import_spec inside import_spec_list inside import_declaration; only the leaf
        // spec is one import, or the block would count 2-4x.
        let is_go_import_wrapper = sets.name == "go"
            && (node.kind() == "import_declaration" || node.kind() == "import_spec_list");
        if !is_go_import_wrapper
            && (is_import_node(node)
                || is_rust_mod_declaration(node, sets)
                || is_cpp_module_import(node, sets, code)
                || is_dynamic_import_node(node, code)
                || is_ruby_require_call(node, sets, code))
        {
            *import_count += 1;
        }

        if is_import_source_node(node, sets, code) {
            for source in find_import_sources(node, sets, false, code) {
                import_sources.insert(source);
            }
        }

        if is_export_node(node) {
            *export_count += 1;
        }

        for child in named_children(node) {
            visit(
                child,
                sets,
                code,
                import_sources,
                import_count,
                export_count,
            );
        }
    }

    visit(
        root,
        sets,
        code,
        &mut import_sources,
        &mut import_count,
        &mut export_count,
    );

    let relative_import_count = import_sources
        .iter()
        .filter(|source| is_relative_import_source(source, sets.name))
        .count();

    CouplingMetrics {
        import_count,
        import_source_count: import_sources.len(),
        relative_import_count,
        external_import_count: import_sources.len() - relative_import_count,
        export_count,
    }
}

pub fn measure_module(root: Node<'_>, sets: &LanguageSets, code: &str) -> ModuleMetrics {
    let mut import_sources: IndexSet<String> = IndexSet::new();

    fn visit_imports(
        node: Node<'_>,
        sets: &LanguageSets,
        code: &str,
        import_sources: &mut IndexSet<String>,
    ) {
        if is_import_source_node(node, sets, code) {
            for source in find_import_sources(node, sets, true, code) {
                import_sources.insert(source);
            }
        }

        for child in named_children(node) {
            visit_imports(child, sets, code, import_sources);
        }
    }

    visit_imports(root, sets, code, &mut import_sources);

    ModuleMetrics {
        declarations: collect_module_declarations(root, sets, code),
        import_sources: import_sources.into_iter().collect(),
    }
}

fn collect_module_declarations(
    root: Node<'_>,
    sets: &LanguageSets,
    code: &str,
) -> Vec<DeclarationMetrics> {
    let exported_names = collect_exported_names(root, code);
    let scope = if sets.name == "java" {
        find_java_package_scope(root, code)
    } else {
        String::new()
    };
    named_children(root)
        .into_iter()
        .flat_map(|child| {
            collect_top_level_declarations(child, false, &scope, sets.name == "cpp", code)
        })
        .map(|declaration| {
            if exported_names.contains(&declaration.name) {
                DeclarationMetrics {
                    exported: true,
                    ..declaration
                }
            } else {
                declaration
            }
        })
        .collect()
}

/// Java top-level declarations are qualified by their package so simple names stay distinct.
fn find_java_package_scope(root: Node<'_>, code: &str) -> String {
    let package_node = named_children(root)
        .into_iter()
        .find(|child| child.kind() == "package_declaration");
    let name_node = package_node.and_then(|package| {
        named_children(package)
            .into_iter()
            .find(|child| child.kind() == "scoped_identifier" || child.kind() == "identifier")
    });
    match name_node {
        Some(name_node) => format!("{}::", node_text(name_node, code)),
        None => String::new(),
    }
}

const RUBY_TYPE_NODE_TYPES: &[&str] = &["module", "class", "singleton_class"];

fn collect_top_level_declarations(
    node: Node<'_>,
    exported: bool,
    scope: &str,
    is_cpp: bool,
    code: &str,
) -> Vec<DeclarationMetrics> {
    if is_module_export_node(node) {
        return named_children(node)
            .into_iter()
            .flat_map(|child| collect_top_level_declarations(child, true, scope, is_cpp, code))
            .collect();
    }

    // C++ namespaces qualify their contents; anonymous namespaces give internal linkage and
    // declare no cross-file symbols at all.
    if node.kind() == "namespace_definition" {
        let Some(name_node) = node.child_by_field_name("name") else {
            return Vec::new();
        };
        let name = node_text(name_node, code);
        if name.is_empty() {
            return Vec::new();
        }
        let body_children = node
            .child_by_field_name("body")
            .map(named_children)
            .unwrap_or_default();
        let child_scope = format!("{scope}{name}::");
        return body_children
            .into_iter()
            .flat_map(|child| {
                collect_top_level_declarations(child, exported, &child_scope, is_cpp, code)
            })
            .collect();
    }

    if is_declaration_container(node) {
        return named_children(node)
            .into_iter()
            .flat_map(|child| collect_top_level_declarations(child, exported, scope, is_cpp, code))
            .collect();
    }

    // C/C++ global variables live in `declaration` nodes with one or more declarators.
    if node.kind() == "declaration" {
        return qualify_declarations(
            declarations_from_c_declaration(node, exported, is_cpp, code),
            scope,
            false,
        );
    }

    // C `typedef` declares alias name(s) and possibly a tagged type in one node.
    if node.kind() == "type_definition" {
        return qualify_declarations(
            declarations_from_type_definition(node, exported, code),
            scope,
            false,
        );
    }

    // Ruby modules/classes nest further types in their body, like C++ namespaces.
    if RUBY_TYPE_NODE_TYPES.contains(&node.kind()) {
        return declarations_from_ruby_type(node, exported, scope, code);
    }

    // Ruby constant assignment is the language's only constant syntax.
    if node.kind() == "assignment" || node.kind() == "operator_assignment" {
        return qualify_declarations(
            ruby_constant_declarations(node, exported, code),
            scope,
            true,
        );
    }

    qualify_declarations(declaration_from_node(node, exported, code), scope, false)
}

/// Prefixes declarations with the enclosing scope; `skip_qualified` protects already-qualified
/// Ruby names (`class A::B`) from double prefixes.
fn qualify_declarations(
    declarations: Vec<DeclarationMetrics>,
    scope: &str,
    skip_qualified: bool,
) -> Vec<DeclarationMetrics> {
    if scope.is_empty() {
        return declarations;
    }
    declarations
        .into_iter()
        .map(|declaration| {
            if skip_qualified && declaration.name.contains("::") {
                declaration
            } else {
                DeclarationMetrics {
                    name: format!("{scope}{}", declaration.name),
                    ..declaration
                }
            }
        })
        .collect()
}

/// Emits a Ruby type and its nested types. Methods are intentionally not collected.
fn declarations_from_ruby_type(
    node: Node<'_>,
    exported: bool,
    scope: &str,
    code: &str,
) -> Vec<DeclarationMetrics> {
    let mut declarations =
        qualify_declarations(declaration_from_node(node, exported, code), scope, true);
    let child_scope = match declarations.first() {
        Some(first) => format!("{}::", first.name),
        None => scope.to_string(),
    };
    let body_children = node
        .child_by_field_name("body")
        .map(named_children)
        .unwrap_or_default();
    for child in body_children {
        if RUBY_TYPE_NODE_TYPES.contains(&child.kind()) {
            declarations.extend(declarations_from_ruby_type(
                child,
                exported,
                &child_scope,
                code,
            ));
        } else if child.kind() == "assignment" || child.kind() == "operator_assignment" {
            declarations.extend(qualify_declarations(
                ruby_constant_declarations(child, exported, code),
                &child_scope,
                true,
            ));
        }
    }
    declarations
}

/// Ruby constant assignments: `CONST = ...`, `A::CONST = ...`, `MIN, MAX = ...`, `CONST ||= ...`.
fn ruby_constant_declarations(
    node: Node<'_>,
    exported: bool,
    code: &str,
) -> Vec<DeclarationMetrics> {
    if node.kind() == "operator_assignment"
        && !all_children(node)
            .iter()
            .any(|child| !child.is_named() && node_text(*child, code) == "||=")
    {
        return Vec::new();
    }
    let Some(left) = node.child_by_field_name("left") else {
        return Vec::new();
    };
    let targets = if left.kind() == "left_assignment_list" {
        named_children(left)
    } else {
        vec![left]
    };
    targets
        .into_iter()
        .filter(|target| {
            target.kind() == "constant"
                || (target.kind() == "scope_resolution"
                    && target
                        .child_by_field_name("name")
                        .is_some_and(|name| name.kind() == "constant"))
        })
        .map(|target| DeclarationMetrics {
            exported,
            name: node_text(target, code).to_string(),
            start_line: target.start_position().row + 1,
        })
        .collect()
}

fn declarations_from_type_definition(
    node: Node<'_>,
    exported: bool,
    code: &str,
) -> Vec<DeclarationMetrics> {
    // `typedef struct Foo { ... } Bar;` declares both the tag `Foo` and the alias `Bar`.
    let type_node = node.child_by_field_name("type");
    let mut declarations = match type_node {
        Some(type_node) => declaration_from_node(type_node, exported, code),
        None => Vec::new(),
    };
    // The opaque-type idiom `typedef struct X X;` only forward-declares a tag defined elsewhere.
    let bodyless_tag_name = type_node.and_then(|type_node| {
        if type_node.kind().ends_with("_specifier")
            && type_node.child_by_field_name("body").is_none()
        {
            type_node
                .child_by_field_name("name")
                .map(|name| node_text(name, code).to_string())
        } else {
            None
        }
    });
    let mut seen_names: HashSet<String> = declarations
        .iter()
        .map(|declaration| declaration.name.clone())
        .collect();
    for declarator in find_children_by_field_name(node, "declarator") {
        let name = if declarator.kind() == "type_identifier" {
            Some(node_text(declarator, code).to_string())
        } else {
            unwrap_declarator_name(Some(declarator), false, code)
        };
        if let Some(name) = name {
            if bodyless_tag_name.as_deref() != Some(name.as_str()) && !seen_names.contains(&name) {
                seen_names.insert(name.clone());
                declarations.push(DeclarationMetrics {
                    exported,
                    name,
                    start_line: declarator.start_position().row + 1,
                });
            }
        }
    }
    declarations
}

const C_VARIABLE_DECLARATOR_TYPES: &[&str] = &[
    "init_declarator",
    "pointer_declarator",
    "array_declarator",
    "reference_declarator",
    "identifier",
    "field_identifier",
];

/// A bare `function_declarator` is a prototype, but a parenthesized-name one declares a
/// function-pointer variable; see isCVariableDeclarator in metrics.ts.
pub fn is_c_variable_declarator(node: Node<'_>) -> bool {
    if node.kind() == "pointer_declarator" || node.kind() == "reference_declarator" {
        let mut current = Some(node);
        while current.is_some_and(|current| {
            matches!(
                current.kind(),
                "pointer_declarator" | "reference_declarator" | "array_declarator"
            )
        }) {
            current = current.and_then(next_declarator);
        }
        if current.is_some_and(|current| current.kind() == "function_declarator") {
            return current
                .and_then(|current| current.child_by_field_name("declarator"))
                .is_some_and(|declarator| declarator.kind() == "parenthesized_declarator");
        }
        return true;
    }

    if C_VARIABLE_DECLARATOR_TYPES.contains(&node.kind()) {
        return true;
    }

    node.kind() == "function_declarator"
        && node
            .child_by_field_name("declarator")
            .is_some_and(|declarator| declarator.kind() == "parenthesized_declarator")
}

/// tree-sitter-cpp has no C++20 module support, so `export module foo;` / `import bar;` misparse
/// as `declaration` nodes whose "type" is the keyword.
pub fn is_misparsed_cpp_module_declaration(node: Node<'_>, code: &str) -> bool {
    let Some(type_node) = node.child_by_field_name("type") else {
        return false;
    };
    if type_node.kind() != "type_identifier" {
        return false;
    }
    let text = node_text(type_node, code);
    if text != "import" && text != "export" && text != "module" {
        return false;
    }
    !has_visible_type_alias(node, text, code)
}

/// Whether the file typedefs/aliases `name` as a type, disambiguating module-keyword misparses.
fn has_visible_type_alias(node: Node<'_>, name: &str, code: &str) -> bool {
    let mut root = node;
    while let Some(parent) = root.parent() {
        root = parent;
    }
    let alias_types: HashSet<&'static str> = ["type_definition", "alias_declaration"]
        .into_iter()
        .collect();
    collect_nodes(root, &alias_types)
        .into_iter()
        .any(|definition| {
            let declarator = definition
                .child_by_field_name("declarator")
                .or_else(|| definition.child_by_field_name("name"));
            declarator.is_some_and(|declarator| node_text(declarator, code) == name)
        })
}

/// Extracts each declared variable from a C/C++ `declaration`; prototypes declare no symbol.
fn declarations_from_c_declaration(
    node: Node<'_>,
    exported: bool,
    is_cpp: bool,
    code: &str,
) -> Vec<DeclarationMetrics> {
    if (is_cpp && is_misparsed_cpp_module_declaration(node, code))
        || has_storage_class(node, "static", code)
    {
        return Vec::new();
    }
    // `struct Foo { int x; } value;` defines the tag `Foo` alongside the variable.
    let type_node = node.child_by_field_name("type");
    let mut declarations = match type_node {
        Some(type_node) => declaration_from_node(type_node, exported, code),
        None => Vec::new(),
    };
    let mut seen_names: HashSet<String> = declarations
        .iter()
        .map(|declaration| declaration.name.clone())
        .collect();
    let is_extern = has_storage_class(node, "extern", code);
    for child in named_children(node)
        .into_iter()
        .filter(|child| is_c_variable_declarator(*child))
    {
        // A non-initializing `extern` declarator only re-declares a symbol defined elsewhere.
        if is_extern && child.kind() != "init_declarator" {
            continue;
        }
        // C++ gives namespace-scope const variables internal linkage unless extern/inline/reference.
        if is_cpp
            && !is_extern
            && !has_storage_class(node, "inline", code)
            && !declarator_chain_contains_reference(child)
            && !is_c_mutable_binding(node, child, code)
        {
            continue;
        }
        if let Some(name) = unwrap_declarator_name(Some(child), false, code) {
            if !seen_names.contains(&name) {
                seen_names.insert(name.clone());
                declarations.push(DeclarationMetrics {
                    exported,
                    name,
                    start_line: child.start_position().row + 1,
                });
            }
        }
    }
    declarations
}

fn declarator_chain_contains_reference(declarator: Node<'_>) -> bool {
    let mut current = if declarator.kind() == "init_declarator" {
        Some(
            declarator
                .child_by_field_name("declarator")
                .unwrap_or(declarator),
        )
    } else {
        Some(declarator)
    };
    while let Some(node) = current {
        if node.kind() == "reference_declarator" {
            return true;
        }
        current = next_declarator(node);
    }
    false
}

fn declaration_from_node(node: Node<'_>, exported: bool, code: &str) -> Vec<DeclarationMetrics> {
    // C/C++ `struct Foo;`-style forward declarations reuse the declaration node type; only
    // definitions with a body declare a module-level symbol.
    if !is_top_level_declaration_node(node)
        || (node.kind().ends_with("_specifier") && node.child_by_field_name("body").is_none())
    {
        return Vec::new();
    }

    // C/C++ `static` gives internal linkage: the symbol is file-local.
    if has_storage_class(node, "static", code) {
        return Vec::new();
    }

    // C/C++ enumerators are constants declared in the surrounding scope.
    if node.kind() == "enum_specifier" {
        return declarations_from_enum_specifier(node, exported, code);
    }

    match find_declaration_name(node, code) {
        Some(name) => vec![DeclarationMetrics {
            exported,
            name,
            start_line: node.start_position().row + 1,
        }],
        None => Vec::new(),
    }
}

fn declarations_from_enum_specifier(
    node: Node<'_>,
    exported: bool,
    code: &str,
) -> Vec<DeclarationMetrics> {
    let mut declarations = Vec::new();
    let tag_name = node
        .child_by_field_name("name")
        .map(|name| node_text(name, code).to_string());
    if let Some(tag_name) = &tag_name {
        declarations.push(DeclarationMetrics {
            exported,
            name: tag_name.clone(),
            start_line: node.start_position().row + 1,
        });
    }
    let is_scoped = all_children(node).iter().any(|child| {
        !child.is_named()
            && (node_text(*child, code) == "class" || node_text(*child, code) == "struct")
    });
    let body_children = node
        .child_by_field_name("body")
        .map(named_children)
        .unwrap_or_default();
    for enumerator in body_children {
        if enumerator.kind() != "enumerator" {
            continue;
        }
        if let Some(name_node) = enumerator.child_by_field_name("name") {
            let name = node_text(name_node, code);
            declarations.push(DeclarationMetrics {
                exported,
                name: match (&tag_name, is_scoped) {
                    (Some(tag_name), true) => format!("{tag_name}::{name}"),
                    _ => name.to_string(),
                },
                start_line: enumerator.start_position().row + 1,
            });
        }
    }
    declarations
}

fn find_declaration_name(node: Node<'_>, code: &str) -> Option<String> {
    if node.kind() == "method_declaration" && node.child_by_field_name("receiver").is_some() {
        return find_go_method_declaration_name(node, code);
    }

    let mut name_node = node.child_by_field_name("name");
    // C++ class/struct template specializations name the type via a `template_type` wrapper.
    if name_node.is_some_and(|name| name.kind() == "template_type") {
        name_node = name_node.and_then(|name| name.child_by_field_name("name"));
    }
    // Ruby `class A::B` names the type via `scope_resolution`; keep the qualified `A::B`.
    if let Some(name) = name_node {
        if name.kind() == "scope_resolution" {
            return Some(node_text(name, code).to_string());
        }
        return if is_declaration_name_node(name) {
            Some(node_text(name, code).to_string())
        } else {
            None
        };
    }

    // C/C++ function definitions name the function inside the declarator chain; this must run
    // before the generic fallback, which would otherwise pick up the return type's identifier.
    if let Some(declarator_name) =
        unwrap_declarator_name(node.child_by_field_name("declarator"), true, code)
    {
        return Some(declarator_name);
    }

    named_children(node)
        .into_iter()
        .find(|child| is_declaration_name_node(*child))
        .map(|child| node_text(child, code).to_string())
}

fn is_module_export_node(node: Node<'_>) -> bool {
    node.kind() == "export_statement" || node.kind() == "export_declaration"
}

fn is_declaration_container(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "lexical_declaration"
            | "variable_declaration"
            | "decorated_definition"
            | "type_declaration"
            | "const_declaration"
            | "var_declaration"
            | "var_spec_list"
            | "linkage_specification"
            | "template_declaration"
            | "declaration_list"
            | "preproc_ifdef"
            | "preproc_if"
            | "preproc_else"
            | "preproc_elif"
    )
}

fn is_top_level_declaration_node(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "function_declaration"
            | "function_definition"
            | "function_item"
            | "method_declaration"
            | "class_declaration"
            | "class_definition"
            | "interface_declaration"
            | "type_alias_declaration"
            | "type_declaration"
            | "type_spec"
            | "const_spec"
            | "var_spec"
            | "variable_declarator"
            | "struct_item"
            | "enum_item"
            | "union_item"
            | "trait_item"
            | "type_item"
            | "const_item"
            | "static_item"
            | "mod_item"
            | "enum_declaration"
            | "record_declaration"
            | "annotation_type_declaration"
            | "method"
            | "singleton_method"
            | "class"
            | "module"
            | "alias_declaration"
            | "struct_specifier"
            | "class_specifier"
            | "enum_specifier"
            | "union_specifier"
    )
}

fn is_declaration_name_node(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "identifier" | "type_identifier" | "property_identifier" | "field_identifier" | "constant"
    )
}

fn collect_exported_names(root: Node<'_>, code: &str) -> HashSet<String> {
    let mut exported_names = HashSet::new();

    fn visit(
        node: Node<'_>,
        inside_sourced_export: bool,
        code: &str,
        exported_names: &mut HashSet<String>,
    ) {
        if !inside_sourced_export && is_export_specifier_node(node) {
            if let Some(name) = find_exported_name(node, code) {
                exported_names.insert(name);
            }
        }

        let is_sourced_export = inside_sourced_export
            || (is_module_export_node(node) && node.child_by_field_name("source").is_some());
        for child in named_children(node) {
            visit(child, is_sourced_export, code, exported_names);
        }
    }

    visit(root, false, code, &mut exported_names);
    exported_names
}

fn is_export_specifier_node(node: Node<'_>) -> bool {
    node.kind() == "export_specifier" || node.kind() == "namespace_export"
}

fn find_exported_name(node: Node<'_>, code: &str) -> Option<String> {
    let name_node = node
        .child_by_field_name("name")
        .or_else(|| node.child_by_field_name("alias"))
        .or_else(|| {
            named_children(node)
                .into_iter()
                .find(|child| is_declaration_name_node(*child))
        })?;
    if is_declaration_name_node(name_node) {
        Some(node_text(name_node, code).to_string())
    } else {
        None
    }
}

fn find_go_method_declaration_name(node: Node<'_>, code: &str) -> Option<String> {
    let name_node = node.child_by_field_name("name");
    let receiver_type_node = node
        .child_by_field_name("receiver")
        .and_then(|receiver| named_children(receiver).first().copied())
        .and_then(|first| first.child_by_field_name("type"));
    let name_node = name_node.filter(|name| is_declaration_name_node(*name))?;
    let Some(receiver_type_node) = receiver_type_node else {
        return Some(node_text(name_node, code).to_string());
    };

    Some(format!(
        "{}.{}",
        normalize_go_receiver_type(node_text(receiver_type_node, code)),
        node_text(name_node, code)
    ))
}

fn normalize_go_receiver_type(receiver_type: &str) -> String {
    strip_js_whitespace(receiver_type)
        .trim_start_matches('*')
        .to_string()
}

fn is_import_node(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "import_statement"
            | "import_declaration"
            | "import_from_statement"
            | "import_spec"
            | "import_spec_list"
            | "use_declaration"
            | "extern_crate_declaration"
            | "requires_module_directive"
            | "preproc_include"
    )
}

fn is_import_source_node(node: Node<'_>, sets: &LanguageSets, code: &str) -> bool {
    is_import_node(node)
        || is_rust_mod_declaration(node, sets)
        || is_cpp_module_import(node, sets, code)
        || is_dynamic_import_node(node, code)
        || is_ruby_require_call(node, sets, code)
        || (is_export_node(node) && node.child_by_field_name("source").is_some())
}

/// C++20 imports misparse without grammar module support; see isCppModuleImport in metrics.ts.
fn is_cpp_module_import(node: Node<'_>, sets: &LanguageSets, code: &str) -> bool {
    if sets.name != "cpp" {
        return false;
    }
    if node.kind() == "declaration" {
        let Some(type_node) = node.child_by_field_name("type") else {
            return false;
        };
        if type_node.kind() != "type_identifier" {
            return false;
        }
        let text = node_text(type_node, code);
        if text == "import" {
            return !has_visible_type_alias(node, "import", code);
        }
        return text == "export" && export_import_regex().is_match(node_text(node, code));
    }
    if node.kind() == "labeled_statement" || node.kind() == "expression_statement" {
        return node
            .parent()
            .is_some_and(|parent| parent.kind() == "translation_unit")
            && import_unit_regex().is_match(node_text(node, code));
    }
    false
}

/// A bodyless `mod name;` declares an out-of-line child module loaded from `name.rs`/`name/mod.rs`.
fn is_rust_mod_declaration(node: Node<'_>, sets: &LanguageSets) -> bool {
    sets.name == "rust" && node.kind() == "mod_item" && node.child_by_field_name("body").is_none()
}

fn is_dynamic_import_node(node: Node<'_>, code: &str) -> bool {
    if !is_call_node(node) {
        return false;
    }

    let callee_node = node
        .child_by_field_name("function")
        .or_else(|| node.named_child(0));
    callee_node.is_some_and(|callee| node_text(callee, code) == "import")
}

fn find_import_sources(
    node: Node<'_>,
    sets: &LanguageSets,
    expand_python_submodules: bool,
    code: &str,
) -> Vec<String> {
    if sets.name == "python" {
        let python_sources = find_python_import_sources(node, expand_python_submodules, code);
        if !python_sources.is_empty() {
            return python_sources;
        }
    }

    if sets.name == "rust" {
        return find_rust_import_sources(node, code);
    }

    // JPMS `requires [transitive|static] module.name;` names the depended-on module.
    if sets.name == "java" && node.kind() == "requires_module_directive" {
        return match node.child_by_field_name("module") {
            Some(module_node) => vec![normalize_import_source(node_text(module_node, code))],
            None => Vec::new(),
        };
    }

    if sets.name == "java" && node.kind() == "import_declaration" {
        let Some(imported_path) = node.named_child(0) else {
            return Vec::new();
        };
        // The `.*` suffix is preserved so wildcard (package) imports stay unresolvable to a single
        // file; a static wildcard names one specific type (JLS 7.5.4).
        let is_static = all_children(node)
            .iter()
            .any(|child| child.kind() == "static");
        let is_wildcard = named_children(node)
            .iter()
            .any(|child| child.kind() == "asterisk");
        let source = normalize_import_source(node_text(imported_path, code));
        return vec![if is_wildcard && !is_static {
            format!("{source}.*")
        } else {
            source
        }];
    }

    // The misparsed C++20 module import keeps its source in the node text.
    if is_cpp_module_import(node, sets, code) {
        let source = import_source_regex()
            .captures(node_text(node, code))
            .and_then(|captures| captures.get(1))
            .map(|capture| capture.as_str().to_string());
        let Some(source) = source else {
            return Vec::new();
        };
        return if source.starts_with('"') {
            vec![format!("./{}", unquote(&source))]
        } else {
            vec![source]
        };
    }

    if is_ruby_require_call(node, sets, code) {
        return find_ruby_require_sources(node, code);
    }

    // C/C++ `#include` paths live in the `path` field; quoted includes resolve relative to the
    // including file, unlike `<...>` system includes.
    if node.kind() == "preproc_include" {
        let Some(path_node) = node.child_by_field_name("path") else {
            return Vec::new();
        };
        let source = unquote(node_text(path_node, code));
        let is_local = path_node.kind() == "string_literal"
            && !source.starts_with('.')
            && !source.starts_with('/');
        return vec![if is_local {
            format!("./{source}")
        } else {
            source
        }];
    }

    if is_dynamic_import_node(node, code) {
        return find_dynamic_import_sources(node, code);
    }

    let source_node = node
        .child_by_field_name("source")
        .or_else(|| find_first_string_node(node));
    match source_node {
        Some(source_node) => vec![unquote(node_text(source_node, code))],
        None => Vec::new(),
    }
}

const RUBY_REQUIRE_METHODS: &[&str] = &["require", "require_relative", "load"];

/// Only receiverless Kernel-style calls import; `loader.require(...)` is an ordinary method call.
fn is_ruby_require_call(node: Node<'_>, sets: &LanguageSets, code: &str) -> bool {
    if sets.name != "ruby" || node.kind() != "call" {
        return false;
    }

    let Some(method_node) = node.child_by_field_name("method") else {
        return false;
    };
    if method_node.kind() != "identifier" {
        return false;
    }
    // `autoload :User, './user'` registers a `require`; it may carry a module receiver.
    if node_text(method_node, code) == "autoload" {
        return match node.child_by_field_name("receiver") {
            None => true,
            Some(receiver) => {
                receiver.kind() == "constant" || receiver.kind() == "scope_resolution"
            }
        };
    }
    node.child_by_field_name("receiver").is_none()
        && RUBY_REQUIRE_METHODS.contains(&node_text(method_node, code))
}

/// Resolves `require`/`require_relative`/`load` sources; `require_relative` is always file-relative.
fn find_ruby_require_sources(node: Node<'_>, code: &str) -> Vec<String> {
    let arguments_node = node.child_by_field_name("arguments");
    // `autoload :Name, 'path'` names its source in the second argument.
    let is_autoload = node
        .child_by_field_name("method")
        .is_some_and(|method| node_text(method, code) == "autoload");
    let first_argument =
        arguments_node.and_then(|arguments| arguments.named_child(if is_autoload { 1 } else { 0 }));
    let Some(first_argument) = first_argument else {
        return Vec::new();
    };
    if first_argument.kind() != "string" {
        return Vec::new();
    }

    // Dynamic requires (`require "#{name}"`) name no static source.
    if named_children(first_argument)
        .iter()
        .any(|child| child.kind() == "interpolation")
    {
        return Vec::new();
    }

    // Percent literals keep their delimiters in `text`; the content children are exact.
    let content_nodes: Vec<Node<'_>> = named_children(first_argument)
        .into_iter()
        .filter(|child| child.kind() == "string_content" || child.kind() == "escape_sequence")
        .collect();
    let source = if content_nodes.is_empty() {
        unquote(node_text(first_argument, code))
    } else {
        content_nodes
            .iter()
            .map(|child| {
                if child.kind() == "escape_sequence" {
                    decode_ruby_escape_sequence(node_text(*child, code))
                } else {
                    node_text(*child, code).to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("")
    };
    let is_relative = node
        .child_by_field_name("method")
        .is_some_and(|method| node_text(method, code) == "require_relative");
    if is_relative {
        return vec![if source.starts_with('.') {
            source
        } else {
            format!("./{source}")
        }];
    }
    // Plain `require`/`load` resolve `./`/`../` paths against the process CWD.
    vec![strip_leading_relative_prefixes(&source)]
}

/// Replicates `source.replace(/^(?:\.\.?\/)+/u, '')`.
fn strip_leading_relative_prefixes(source: &str) -> String {
    let mut remainder = source;
    loop {
        if let Some(stripped) = remainder.strip_prefix("./") {
            remainder = stripped;
        } else if let Some(stripped) = remainder.strip_prefix("../") {
            remainder = stripped;
        } else {
            return remainder.to_string();
        }
    }
}

/// Decodes a Ruby escape (`\\` -> `\`, `\/` -> `/`, `\n` -> newline) inside a require path.
fn decode_ruby_escape_sequence(text: &str) -> String {
    let escaped = &text[1..];
    match escaped {
        "n" => "\n".to_string(),
        "t" => "\t".to_string(),
        "r" => "\r".to_string(),
        "s" => " ".to_string(),
        "0" => "\0".to_string(),
        _ => escaped.to_string(),
    }
}

fn find_dynamic_import_sources(node: Node<'_>, code: &str) -> Vec<String> {
    let first_argument = node
        .child_by_field_name("arguments")
        .and_then(|arguments| arguments.named_child(0));
    match first_argument {
        Some(argument) if is_string_node(argument) => vec![unquote(node_text(argument, code))],
        _ => Vec::new(),
    }
}

fn is_relative_import_source(source: &str, language_name: &str) -> bool {
    if source.starts_with('.') || source.starts_with('/') {
        return true;
    }

    // `crate`/`self`/`super` are local only in Rust.
    language_name == "rust" && is_rust_local_import_source(source)
}

/// Rust in-crate imports address the module tree through `crate`, `self`, or `super`.
fn is_rust_local_import_source(source: &str) -> bool {
    for prefix in ["crate", "self", "super"] {
        if let Some(remainder) = source.strip_prefix(prefix) {
            if remainder.is_empty() || remainder.starts_with("::") {
                return true;
            }
        }
    }
    false
}

/// Extracts the module path(s) a Rust `use` declaration reaches into; see findRustImportSources.
fn find_rust_import_sources(node: Node<'_>, code: &str) -> Vec<String> {
    // `mod b;` (no body) pulls the child module's file into the tree, like an import of `self::b`.
    if node.kind() == "mod_item" {
        return match node.child_by_field_name("name") {
            Some(name_node) => vec![format!(
                "self::{}",
                normalize_import_source(node_text(name_node, code))
            )],
            None => Vec::new(),
        };
    }
    // `extern crate serde as s;` names the crate directly; the alias is irrelevant to the source.
    if node.kind() == "extern_crate_declaration" {
        return match node.child_by_field_name("name") {
            Some(name_node) => vec![normalize_import_source(node_text(name_node, code))],
            None => Vec::new(),
        };
    }

    match node.child_by_field_name("argument") {
        Some(argument) => rust_import_sources(argument, "", code),
        None => Vec::new(),
    }
}

/// Resolves the module source(s) of a `use` tree node, given the accumulated module `prefix`.
fn rust_import_sources(node: Node<'_>, prefix: &str, code: &str) -> Vec<String> {
    match node.kind() {
        "use_list" => named_children(node)
            .into_iter()
            .flat_map(|child| rust_import_sources(child, prefix, code))
            .collect(),
        "scoped_use_list" => {
            let list_node = node.child_by_field_name("list");
            let next_prefix = join_module_path(
                prefix,
                &rust_path_text(node.child_by_field_name("path"), code),
            );
            match list_node {
                Some(list_node) => rust_import_sources(list_node, &next_prefix, code),
                None => with_module_prefix(&next_prefix),
            }
        }
        "scoped_identifier" => {
            // In-crate paths keep the leaf: `use crate::b;` names module `b`.
            let full_path =
                join_module_path(prefix, &normalize_import_source(node_text(node, code)));
            if is_rust_local_import_source(&full_path) {
                return with_module_prefix(&full_path);
            }
            // Drop the leaf item: the source is the prefix plus this node's own `path` field.
            with_module_prefix(&join_module_path(
                prefix,
                &rust_path_text(node.child_by_field_name("path"), code),
            ))
        }
        "use_wildcard" => {
            // `use a::b::*;` imports from `a::b`; the wildcard has no `path` field.
            with_module_prefix(&join_module_path(
                prefix,
                &rust_path_text(node.named_child(0), code),
            ))
        }
        "use_as_clause" => match node.child_by_field_name("path") {
            Some(path_node) => rust_import_sources(path_node, prefix, code),
            None => Vec::new(),
        },
        "self" => with_module_prefix(prefix),
        "identifier" | "crate" | "super" => {
            // Inside an in-crate group (`use crate::{a, b};`) each leaf may itself be a module.
            if node.kind() == "identifier" && is_rust_local_import_source(prefix) {
                return with_module_prefix(&join_module_path(
                    prefix,
                    &normalize_import_source(node_text(node, code)),
                ));
            }
            // A bare leaf item: at the top level (`use tokio;`) it is the module; inside a group
            // its module is the prefix.
            if prefix.is_empty() {
                with_module_prefix(&normalize_import_source(node_text(node, code)))
            } else {
                with_module_prefix(prefix)
            }
        }
        _ => Vec::new(),
    }
}

fn rust_path_text(node: Option<Node<'_>>, code: &str) -> String {
    match node {
        Some(node) => normalize_import_source(node_text(node, code)),
        None => String::new(),
    }
}

fn join_module_path(prefix: &str, segment: &str) -> String {
    if segment.is_empty() {
        return prefix.to_string();
    }
    if prefix.is_empty() {
        segment.to_string()
    } else {
        format!("{prefix}::{segment}")
    }
}

fn with_module_prefix(source: &str) -> Vec<String> {
    if source.is_empty() {
        Vec::new()
    } else {
        vec![source.to_string()]
    }
}

fn find_python_import_sources(
    node: Node<'_>,
    expand_python_submodules: bool,
    code: &str,
) -> Vec<String> {
    if node.kind() == "import_from_statement" {
        let Some(module_node) = node.child_by_field_name("module_name") else {
            return Vec::new();
        };

        let module_source = normalize_import_source(node_text(module_node, code));
        let name_nodes = find_children_by_field_name(node, "name");
        if !expand_python_submodules || !module_source.starts_with('.') {
            return vec![module_source];
        }
        if !module_source.is_empty()
            && module_source.chars().all(|character| character == '.')
            && !name_nodes.is_empty()
        {
            return name_nodes
                .iter()
                .flat_map(|name| find_python_import_names(*name, code))
                .map(|name| format!("{module_source}{name}"))
                .collect();
        }
        let submodule_sources: Vec<String> = name_nodes
            .iter()
            .flat_map(|name| find_python_import_names(*name, code))
            .map(|name| format!("{module_source}.{name}"))
            .collect();
        if !submodule_sources.is_empty() {
            let mut sources = vec![module_source];
            sources.extend(submodule_sources);
            return sources;
        }
        return vec![module_source];
    }

    if node.kind() != "import_statement" {
        return Vec::new();
    }

    named_children(node)
        .into_iter()
        .filter_map(|child| find_python_imported_module_name(child, code))
        .collect()
}

fn find_python_import_names(node: Node<'_>, code: &str) -> Vec<String> {
    if node.kind() == "aliased_import" {
        return match node.child_by_field_name("name") {
            Some(name_node) => find_python_import_names(name_node, code),
            None => Vec::new(),
        };
    }

    if node.kind() == "identifier" {
        return vec![node_text(node, code).to_string()];
    }

    if node.kind() == "dotted_name" {
        return vec![normalize_import_source(node_text(node, code))];
    }

    named_children(node)
        .into_iter()
        .flat_map(|child| find_python_import_names(child, code))
        .collect()
}

fn find_python_imported_module_name(node: Node<'_>, code: &str) -> Option<String> {
    if node.kind() == "dotted_name" || node.kind() == "relative_import" {
        return Some(normalize_import_source(node_text(node, code)));
    }

    if let Some(name_node) = node.child_by_field_name("name") {
        return Some(normalize_import_source(node_text(name_node, code)));
    }

    for child in named_children(node) {
        if let Some(source) = find_python_imported_module_name(child, code) {
            return Some(source);
        }
    }

    None
}

fn normalize_import_source(source: &str) -> String {
    strip_js_whitespace(source)
}

fn find_first_string_node(node: Node<'_>) -> Option<Node<'_>> {
    if is_string_node(node) {
        return Some(node);
    }

    for child in named_children(node) {
        if let Some(string_node) = find_first_string_node(child) {
            return Some(string_node);
        }
    }

    None
}

fn is_string_node(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "string" | "string_literal" | "interpreted_string_literal"
    )
}

fn unquote(value: &str) -> String {
    let mut result = value;
    if let Some(first) = result.chars().next() {
        if matches!(first, '\'' | '"' | '`' | '<') {
            result = &result[first.len_utf8()..];
        }
    }
    if let Some(last) = result.chars().next_back() {
        if matches!(last, '\'' | '"' | '`' | '>') {
            result = &result[..result.len() - last.len_utf8()];
        }
    }
    result.to_string()
}

pub fn is_export_node(node: Node<'_>) -> bool {
    // Java's JPMS `exports com.example.api;` directive is module wiring, not a symbol export.
    (node.kind().starts_with("export") && node.kind() != "exports_module_directive")
        || node.kind() == "public_field_definition"
}

/// A base-type `const` freezes a plain binding but not a pointer binding; see isCMutableBinding.
pub fn is_c_mutable_binding(declaration: Node<'_>, declarator: Node<'_>, code: &str) -> bool {
    let mut current = if declarator.kind() == "init_declarator" {
        declarator
            .child_by_field_name("declarator")
            .unwrap_or(declarator)
    } else {
        declarator
    };
    let mut inside_pointer = false;
    while matches!(
        current.kind(),
        "reference_declarator"
            | "pointer_declarator"
            | "array_declarator"
            | "parenthesized_declarator"
            | "function_declarator"
    ) {
        // A C++ reference binding can never be reseated, so it is immutable regardless of qualifiers.
        if current.kind() == "reference_declarator" {
            return false;
        }
        let Some(inner) = next_declarator(current) else {
            break;
        };
        if current.kind() == "pointer_declarator" {
            inside_pointer = true;
            // `const` on the pointer level that owns the name freezes the binding.
            if has_const_qualifier(current, code) && !declarator_chain_contains_pointer(inner) {
                return false;
            }
        }
        current = inner;
    }

    inside_pointer || !has_const_qualifier(declaration, code)
}

fn declarator_chain_contains_pointer(declarator: Node<'_>) -> bool {
    let mut current = Some(declarator);
    while let Some(node) = current {
        if node.kind() == "pointer_declarator" {
            return true;
        }
        current = next_declarator(node);
    }
    false
}

fn has_const_qualifier(node: Node<'_>, code: &str) -> bool {
    named_children(node).iter().any(|child| {
        child.kind() == "type_qualifier"
            && (node_text(*child, code) == "const" || node_text(*child, code) == "constexpr")
    })
}
