use rustc_hash::{FxHashMap, FxHashSet};
use tree_sitter::Node;

use crate::tree_index::NodeExt;
use crate::util::{all_children, node_text, Source};

/// Node-type lookup sets built once per measurement from the language definition.
pub struct LanguageSets {
    pub function_nodes: FxHashSet<&'static str>,
    pub decision_nodes: FxHashSet<&'static str>,
    pub nesting_nodes: FxHashSet<&'static str>,
    pub ncss_nodes: FxHashSet<&'static str>,
    pub ncss_containers: FxHashSet<&'static str>,
}

impl LanguageSets {
    pub fn new(language: &crate::languages::LanguageDefinition) -> Self {
        LanguageSets {
            function_nodes: language.function_node_types.iter().copied().collect(),
            decision_nodes: language.decision_node_types.iter().copied().collect(),
            nesting_nodes: language.nesting_node_types.iter().copied().collect(),
            ncss_nodes: language.ncss_node_types.iter().copied().collect(),
            ncss_containers: language.ncss_container_node_types.iter().copied().collect(),
        }
    }
}

const BOOLEAN_OPERATORS: &[&str] = &["&&", "||", "and", "or"];
/// Parents under which `&&`/`||`/`and`/`or` tokens are actual boolean operators.
const BOOLEAN_OPERATOR_PARENT_TYPES: &[&str] = &[
    "binary_expression",
    "binary",
    "boolean_operator",
    "conjunction_expression",
    "disjunction_expression",
    // C# pattern combinators (`is > 0 and <= 10`) sequence like `&&`/`||` (SonarC#).
    "and_pattern",
    "or_pattern",
];

/// A Ruby stabby lambda's body block is part of the lambda, not a separate function.
pub fn is_lambda_body_block(node: Node<'_>) -> bool {
    (node.kind_name() == "block" || node.kind_name() == "do_block")
        && node
            .parent_node()
            .is_some_and(|parent| parent.kind_name() == "lambda")
}

/// A function node with a body of its own: bodyless declarations (abstract methods, auto-property
/// accessors, accessor-list properties) open no nesting frame, so members inside them are not
/// charged as nested functions.
pub fn is_function_boundary(node: Node<'_>, function_nodes: &FxHashSet<&'static str>) -> bool {
    function_nodes.contains(node.kind_name())
        && !is_lambda_body_block(node)
        && crate::functions::is_implemented_function(node)
}

// Sonar cognitive complexity charges a switch/match once as a whole, not per case label. Only
// named nodes are consulted, so anonymous keyword tokens never match.
const SWITCH_LIKE_NODE_TYPES: &[&str] = &[
    "switch_statement",
    "switch_expression",
    "expression_switch_statement",
    "type_switch_statement",
    "select_statement",
    "match_expression",
    "match_statement",
    "when_expression",
    "case",
    "case_match",
];

// Per-case decision nodes: cyclomatic-only, because the switch itself carries the cognitive cost.
const CASE_CLAUSE_NODE_TYPES: &[&str] = &[
    "case_clause",
    "switch_case",
    "switch_block_statement_group",
    "switch_rule",
    "case_statement",
    "expression_case",
    "type_case",
    "communication_case",
    "match_arm",
    "switch_section",
    "switch_expression_arm",
    "when_entry",
    "when",
    "in_clause",
];

const IF_LIKE_NODE_TYPES: &[&str] = &["if_statement", "if_expression", "if", "unless"];

pub struct FunctionBodyMetrics {
    pub cyclomatic_complexity: u64,
    pub cognitive_complexity: u64,
    pub nesting_depth: u64,
    pub ncss: u64,
}

/// Accumulator for one function body during measure_function_body_metrics' post-order pass.
struct FunctionBodyFrame {
    cyclomatic_complexity: u64,
    cognitive_complexity: u64,
    /// Count of `1 + nesting` cognitive increments, for re-basing on hoist into the parent frame.
    nesting_sensitive_count: u64,
    nesting_depth: u64,
    ncss: u64,
    has_own_ncss_contribution: bool,
    /// Cognitive nesting (structural nesting + function/class bonuses) carried into this body.
    entry_cognitive_nesting: u64,
    /// Structural nesting carried into this body (bonuses excluded), for nesting depth.
    entry_structural_nesting: u64,
}

impl FunctionBodyFrame {
    fn new(entry_cognitive_nesting: u64, entry_structural_nesting: u64) -> Self {
        FunctionBodyFrame {
            cyclomatic_complexity: 1,
            cognitive_complexity: 0,
            nesting_sensitive_count: 0,
            nesting_depth: 0,
            ncss: 0,
            has_own_ncss_contribution: false,
            entry_cognitive_nesting,
            entry_structural_nesting,
        }
    }
}

struct FunctionBodyPass<'sets, 'code, 'source> {
    sets: &'sets LanguageSets,
    code: &'code Source<'source>,
    frames: Vec<FunctionBodyFrame>,
    results: FxHashMap<usize, FunctionBodyMetrics>,
    /// Cyclomatic decisions inside class bodies nested in functions, which no function owns.
    nested_class_decisions: u64,
    /// Deepest structural nesting anywhere in the file.
    max_nesting: u64,
}

/// Per-function body metrics, plus the file-level totals and the cyclomatic decisions no function
/// body owns.
pub struct BodyMetrics {
    pub by_function: FxHashMap<usize, FunctionBodyMetrics>,
    /// Cyclomatic decisions outside every function body (top-level statements, field initializers,
    /// including those of classes nested in functions).
    pub top_level_decisions: u64,
    /// File-level cognitive complexity: nested function/lambda content is charged one nesting
    /// level deeper per function boundary crossed (Sonar spec).
    pub cognitive_complexity: u64,
    pub nesting_depth: u64,
    pub ncss: u64,
}

/// Per-function complexity and NCSS for every function boundary, in one post-order pass so each
/// node is visited once instead of once per enclosing function (issue #35). A function's metrics
/// are its own-body contributions plus, per directly nested function, that function's
/// already-computed totals: NCSS hoists as-is; cognitive complexity re-bases the nested function's
/// nesting-sensitive increments (each worth `1 + nesting`) by the nesting offset at the embedding
/// site, while flat increments (else branches, boolean-operator sequences, chain continuations,
/// jumps, guards) hoist unchanged; cyclomatic complexity and nesting depth describe the own body
/// only, so nothing hoists.
pub fn measure_function_body_metrics(
    root: Node<'_>,
    sets: &LanguageSets,
    code: &Source<'_>,
) -> BodyMetrics {
    let mut pass = FunctionBodyPass {
        sets,
        code,
        // frames[0] is a sentinel for top-level code, which ends up holding the file's totals.
        frames: vec![FunctionBodyFrame::new(0, 0)],
        results: FxHashMap::default(),
        nested_class_decisions: 0,
        max_nesting: 0,
    };
    pass.visit(root, 0, 0, false, false, false);
    // Every closed frame hoists into its parent, so the sentinel's cognitive increments are re-based
    // to absolute nesting (its entry nesting is 0).
    let file_frame = &pass.frames[0];
    BodyMetrics {
        top_level_decisions: file_frame.cyclomatic_complexity - 1 + pass.nested_class_decisions,
        cognitive_complexity: file_frame.cognitive_complexity,
        nesting_depth: pass.max_nesting,
        ncss: file_frame.ncss,
        by_function: pass.results,
    }
}

impl FunctionBodyPass<'_, '_, '_> {
    fn visit(
        &mut self,
        current: Node<'_>,
        current_nesting: u64,
        mut function_nesting_bonus: u64,
        mut inside_function: bool,
        mut inside_nested_region: bool,
        inside_charged_class_body: bool,
    ) {
        // A class body nested in a function (anonymous/local classes) raises the cognitive nesting
        // level once for everything inside it — PMD charges the class body, not the methods it
        // holds, so methods directly inside a charged class body skip the function-boundary bonus.
        let parent = current.parent_node();
        let is_charged_class_body = current.kind_name() == "class_body" && inside_function;
        if is_charged_class_body {
            inside_nested_region = true;
            function_nesting_bonus += 1;
        }
        let opens_frame = is_function_boundary(current, &self.sets.function_nodes);
        if opens_frame {
            if inside_function && !inside_charged_class_body {
                function_nesting_bonus += 1;
            }
            inside_function = true;
        }
        // The node's own increments target the frame it is embedded in, not the one it opens; a
        // frame-opening or charged-class-body node contributes nothing to that frame's own body
        // (cyclomatic/nesting), matching the per-function traversal this pass replaces.
        let entry_cognitive_nesting = self.top_frame().entry_cognitive_nesting;
        let entry_structural_nesting = self.top_frame().entry_structural_nesting;
        let relative_nesting = current_nesting + function_nesting_bonus - entry_cognitive_nesting;
        let counts_for_own_body = !inside_nested_region && !opens_frame;

        // Anonymous keyword tokens can share a type with named nodes (Ruby's `if` node contains an
        // `if` keyword token), so only named nodes count as decisions.
        let is_decision = current.is_named()
            && self.sets.decision_nodes.contains(current.kind_name())
            && !is_pathless_switch_branch(current, self.code);
        let is_case_clause =
            current.is_named() && CASE_CLAUSE_NODE_TYPES.contains(&current.kind_name());
        // Ruby's `case ... else` arm is an `else` node; like every other language's default branch
        // it nests its contents inside the switch (it cannot go in the Ruby nesting set because
        // `if`/`begin` else branches would then double-nest under their already-nesting parent).
        let is_nesting = current.is_named()
            && (self.sets.nesting_nodes.contains(current.kind_name())
                || (current.kind_name() == "else" && is_case_else_parent(parent)));
        // `elsif`/`elif`/`else if` continue a flat chain: they add a decision without a nesting
        // surcharge (Sonar cognitive-complexity semantics).
        let is_continuation = is_decision && is_flat_chain_continuation(current, parent);
        let is_boolean_operator = is_boolean_operator(current, parent, self.code);
        let is_pattern_guard = is_pattern_guard(current, parent);

        // Each branch, short-circuit operator, and pattern guard adds one path (McCabe; NIST SP
        // 500-235 §4); `else` adds none.
        if is_decision || is_boolean_operator || is_pattern_guard {
            if counts_for_own_body {
                self.top_frame().cyclomatic_complexity += 1;
            } else if !opens_frame {
                self.nested_class_decisions += 1;
            }
        }
        if is_decision && !is_case_clause {
            if is_continuation {
                self.top_frame().cognitive_complexity += 1;
            } else {
                self.top_frame().cognitive_complexity += 1 + relative_nesting;
                self.top_frame().nesting_sensitive_count += 1;
            }
        }
        if current.is_named() && SWITCH_LIKE_NODE_TYPES.contains(&current.kind_name()) {
            self.top_frame().cognitive_complexity += 1 + relative_nesting;
            self.top_frame().nesting_sensitive_count += 1;
        }
        // A plain `else` branch adds one flat cognitive point; `else if` chains are charged on the
        // nested if instead.
        self.top_frame().cognitive_complexity += count_plain_else_branches(current, parent);
        // Sonar charges flow-breaking jumps: goto and labeled break/continue add one flat point.
        if is_flow_breaking_jump(current) {
            self.top_frame().cognitive_complexity += 1;
        }

        // A sequence of identical boolean operators reads as one condition, so only the operator
        // starting a sequence adds a cognitive point (Sonar spec).
        if is_boolean_operator && starts_boolean_operator_sequence(parent, self.code, current) {
            self.top_frame().cognitive_complexity += 1;
        }

        // Pattern guards add one independent execution path without nesting.
        if is_pattern_guard {
            self.top_frame().cognitive_complexity += 1;
        }

        let child_nesting = if is_nesting && !is_continuation {
            current_nesting + 1
        } else {
            current_nesting
        };
        self.max_nesting = self.max_nesting.max(child_nesting);
        if counts_for_own_body {
            let frame = self.top_frame();
            frame.nesting_depth = frame
                .nesting_depth
                .max(child_nesting - entry_structural_nesting);
        }

        if opens_frame {
            self.frames.push(FunctionBodyFrame::new(
                child_nesting + function_nesting_bonus,
                child_nesting,
            ));
        }
        // The node's NCSS contribution belongs to the innermost frame whose subtree holds it — the
        // frame the node opens, if any (per-function NCSS includes the declaration node itself).
        let own_ncss = crate::ncss::ncss_contribution(
            current,
            parent,
            &self.sets.ncss_nodes,
            &self.sets.ncss_containers,
        );
        let ncss_frame = self.top_frame();
        ncss_frame.ncss += own_ncss;
        if opens_frame && own_ncss > 0 {
            ncss_frame.has_own_ncss_contribution = true;
        }

        for child in all_children(current) {
            self.visit(
                child,
                child_nesting,
                function_nesting_bonus,
                inside_function,
                if opens_frame {
                    false
                } else {
                    inside_nested_region
                },
                is_charged_class_body,
            );
        }

        if opens_frame {
            let closed = self.frames.pop().expect("frame opened above");
            self.results.insert(
                current.id(),
                FunctionBodyMetrics {
                    cyclomatic_complexity: closed.cyclomatic_complexity,
                    cognitive_complexity: closed.cognitive_complexity,
                    nesting_depth: closed.nesting_depth,
                    // A function node without a countable declaration of its own (arrow functions,
                    // lambdas, blocks) still counts 1 for the declaration itself.
                    ncss: closed.ncss + u64::from(!closed.has_own_ncss_contribution),
                },
            );
            let parent = self.top_frame();
            parent.cognitive_complexity += closed.cognitive_complexity
                + closed.nesting_sensitive_count
                    * (closed.entry_cognitive_nesting - parent.entry_cognitive_nesting);
            parent.nesting_sensitive_count += closed.nesting_sensitive_count;
            parent.ncss += closed.ncss;
        }
    }

    fn top_frame(&mut self) -> &mut FunctionBodyFrame {
        self.frames
            .last_mut()
            .expect("sentinel frame always present")
    }
}

/// Plain else branches attached to `current`: an `else_clause`/Ruby `else` whose branch is not an
/// `else if` continuation, or a bare Java/Go `alternative:` statement without a clause wrapper.
fn count_plain_else_branches(current: Node<'_>, parent: Option<Node<'_>>) -> u64 {
    if !current.is_named() {
        return 0;
    }
    let kind = current.kind_name();
    if kind == "else" {
        // A Ruby `case ... else` is the default arm of a switch, which already counts as a whole
        // (sonar-ruby models it as a match case, not an else branch); `if`/`unless`/`begin` else
        // branches count one point each.
        return u64::from(!is_case_else_parent(parent));
    }
    if kind == "else_clause" {
        let has_if_like_child = crate::util::named_children(current)
            .iter()
            .any(|child| IF_LIKE_NODE_TYPES.contains(&child.kind_name()));
        return if has_if_like_child { 0 } else { 1 };
    }
    if kind != "if_statement" && kind != "if_expression" {
        return 0;
    }
    // Kotlin's `else` is a bare keyword token followed by the branch body (no clause wrapper and
    // no grammar field); an `else if` continuation is charged on the nested if instead.
    if let Some(else_body) = crate::util::kotlin_else_body(current) {
        return u64::from(!crate::util::is_kotlin_else_if_body(else_body));
    }
    // Extras (comments) inherit the preceding sibling's field in find_children_by_field_name, so a
    // comment between an `elif_clause` and `else_clause` must not be miscounted as a bare branch.
    crate::util::find_children_by_field_name(current, "alternative")
        .iter()
        .filter(|child| {
            !child.is_extra()
                && child.kind_name() != "else_clause"
                && child.kind_name() != "elif_clause"
                && !IF_LIKE_NODE_TYPES.contains(&child.kind_name())
        })
        .count() as u64
}

/// goto, and break/continue that jump to a label (their only named child is the label).
fn is_flow_breaking_jump(node: Node<'_>) -> bool {
    if !node.is_named() {
        return false;
    }
    if node.kind_name() == "goto_statement" {
        return true;
    }
    // Rust jumps are expressions; `break value` carries a named expression child, so only an
    // explicit `label` child marks a labeled jump.
    if node.kind_name() == "break_expression" || node.kind_name() == "continue_expression" {
        return crate::util::named_children(node)
            .iter()
            .any(|child| child.kind_name() == "label" || child.kind_name() == "loop_label");
    }
    // Kotlin folds every jump into `jump_expression`; the grammar tokenizes a labeled break or
    // continue as `break@`/`continue@` followed by the label (`return@label` is a plain return).
    if node.kind_name() == "jump_expression" {
        return node.child(0).is_some_and(|keyword| {
            keyword.kind_name() == "break@" || keyword.kind_name() == "continue@"
        });
    }
    // Comments are named children too (`break /* done */;`), so only non-comment children mark a
    // label.
    (node.kind_name() == "break_statement" || node.kind_name() == "continue_statement")
        && crate::util::named_children(node)
            .iter()
            .any(|child| !crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind_name()))
}

/// Wrappers that are transparent when locating the enclosing boolean operation: PMD/Sonar keep a
/// sequence continuous across parentheses (`a && (b && c)` costs one point).
const PARENTHESIZED_NODE_TYPES: &[&str] = &[
    "parenthesized_expression",
    "parenthesized_statements",
    "parenthesized_pattern",
];

/// Whether this boolean operator token starts a new sequence, i.e. its binary node is the root of a
/// run of same-operator binaries (possibly through parentheses). Only the root operator counts one
/// cognitive point: `a && b && c` and `a && (b && c)` cost one, `a && b || c` costs two, matching
/// the Sonar specification and PMD 7.26.0.
fn starts_boolean_operator_sequence(
    binary: Option<Node<'_>>,
    code: &Source<'_>,
    token: Node<'_>,
) -> bool {
    let Some(binary) = binary else {
        return true;
    };
    let mut ancestor = binary.parent_node();
    while let Some(node) = ancestor {
        if !PARENTHESIZED_NODE_TYPES.contains(&node.kind_name()) {
            break;
        }
        ancestor = node.parent_node();
    }
    let Some(ancestor) = ancestor else {
        return true;
    };
    if ancestor.kind_name() != binary.kind_name() {
        return true;
    }
    find_boolean_operator_text(ancestor, code).map(normalize_boolean_operator)
        != Some(normalize_boolean_operator(node_text(token, code)))
}

/// C++ `and`/`or` are alternative spellings of `&&`/`||`, so mixing them keeps one sequence.
fn normalize_boolean_operator(text: &str) -> &str {
    match text {
        "and" => "&&",
        "or" => "||",
        _ => text,
    }
}

fn find_boolean_operator_text<'a>(binary_node: Node<'_>, code: &Source<'a>) -> Option<&'a str> {
    if let Some(operator) = binary_node.child_by_field_name("operator") {
        return Some(node_text(operator, code));
    }
    all_children(binary_node)
        .into_iter()
        .find(|child| !child.is_named() && BOOLEAN_OPERATORS.contains(&node_text(*child, code)))
        .map(|child| node_text(child, code))
}

/// Java `guard`, C# `when_clause`, Ruby `if_guard`, a Python `case` guard (an `if_clause` under a
/// `case_clause`), and Rust guards inside `match_pattern`. A Python comprehension filter shares
/// the `if_clause` type but is a per-element predicate of one expression, not an extra execution
/// path: Sonar ports differ on it (complexipy charges it), and code-gauge does not, unlike
/// ternaries and conditions, which are charged. A C# exception filter (`catch (E e) when (...)`, a `catch_filter_clause`) is
/// deliberately not charged: the catch itself already counts, and the filter is part of the same
/// handler condition rather than an extra path (SonarC# does not charge it either).
fn is_pattern_guard(node: Node<'_>, parent: Option<Node<'_>>) -> bool {
    if !node.is_named() {
        return false;
    }
    let kind = node.kind_name();
    if kind == "guard" || kind == "when_clause" || kind == "if_guard" || kind == "unless_guard" {
        return true;
    }
    if kind == "if_clause" {
        return parent.is_some_and(|parent| parent.kind_name() == "case_clause");
    }
    kind == "match_pattern"
        && all_children(node)
            .iter()
            .any(|child| !child.is_named() && child.kind_name() == "if")
}

/// Ruby `elsif`, Python `elif`, and `else if` (an if node in an else/alternative position).
fn is_flat_chain_continuation(node: Node<'_>, parent: Option<Node<'_>>) -> bool {
    let kind = node.kind_name();
    if kind == "elsif" || kind == "elif_clause" {
        return true;
    }
    if kind != "if_statement" && kind != "if_expression" && kind != "if" {
        return false;
    }
    let Some(parent) = parent else {
        return false;
    };
    // Kotlin puts a braceless `else if` directly in the else branch's control_structure_body.
    if parent.kind_name() == "control_structure_body" {
        return parent
            .parent_node()
            .and_then(crate::util::kotlin_else_body)
            .is_some_and(|else_body| else_body.id() == parent.id());
    }
    // JS/C/C++/Rust/C# wrap `else if` in an else clause or put it directly in `alternative`.
    parent.kind_name() == "else_clause"
        || parent
            .child_by_field_name("alternative")
            .is_some_and(|alternative| alternative.id() == node.id())
}

/// Switch branches that add no path. NIST SP 500-235 counts one path per case-labelled statement:
/// a label-only case shares the statement of the case below it, and that statement adds a path
/// unless one of its stacked labels is an unguarded default or catch-all (`case 3: default: g();`
/// and `default: case 3: g();` are the default outcome) or all of them are catch-alls. Guards are
/// charged separately, so a guarded catch-all never absorbs a case stacked with it.
fn is_pathless_switch_branch(node: Node<'_>, code: &Source<'_>) -> bool {
    if is_label_only_case(node) {
        return true;
    }
    let mut stacked = vec![node];
    let mut previous = node.prev_named_sibling();
    while let Some(sibling) = previous {
        if !crate::ncss::COMMENT_NODE_TYPES.contains(&sibling.kind_name()) {
            if !is_label_only_case(sibling) {
                break;
            }
            stacked.push(sibling);
        }
        previous = sibling.prev_named_sibling();
    }
    stacked
        .iter()
        .any(|label| is_default_switch_branch(*label, code) && !has_pattern_guard(*label))
        || stacked
            .iter()
            .all(|label| is_default_switch_branch(*label, code))
}

/// A guard directly on the arm (C# `when`, Python `if`, Ruby `if`/`unless`) or inside its label or
/// pattern (Java `when`, Rust `if`).
fn has_pattern_guard(node: Node<'_>) -> bool {
    crate::util::named_children(node).into_iter().any(|child| {
        is_pattern_guard(child, Some(node))
            || crate::util::named_children(child)
                .into_iter()
                .any(|grandchild| is_pattern_guard(grandchild, Some(child)))
    })
}

/// A C/C++/JS/Java/C# case whose labels share the next case's statements; every grammar parses each
/// stacked label as its own case node.
fn is_label_only_case(node: Node<'_>) -> bool {
    let children = non_comment_children(node);
    match node.kind_name() {
        "case_statement" => {
            let value = node.child_by_field_name("value").map(|value| value.id());
            children.iter().all(|child| Some(child.id()) == value)
        }
        "switch_case" | "switch_default" => node.child_by_field_name("body").is_none(),
        "switch_block_statement_group" => children
            .iter()
            .all(|child| child.kind_name() == "switch_label"),
        // A C# label is a pattern (`case 1:` parses as a constant pattern) plus an optional `when`
        // guard; anything else, a `#if` block included, is the section's body.
        "switch_section" => children.iter().all(|child| {
            child.kind_name().ends_with("pattern")
                || child.kind_name() == "discard"
                || child.kind_name() == "when_clause"
        }),
        _ => false,
    }
}

fn is_default_switch_branch(node: Node<'_>, code: &Source<'_>) -> bool {
    let kind = node.kind_name();
    if kind == "switch_default" {
        return true;
    }
    if kind == "case_statement" {
        return node.child_by_field_name("value").is_none();
    }

    // Java `default:` groups and `default ->` rules: a label with no expression or pattern, or a
    // `case null, default` label, whose `default` the grammar parses as an identifier.
    if kind == "switch_block_statement_group" || kind == "switch_rule" {
        return non_comment_children(node)
            .into_iter()
            .filter(|child| child.kind_name() == "switch_label")
            .any(|label| {
                let parts = non_comment_children(label);
                parts.is_empty()
                    || parts.iter().any(|part| {
                        part.kind_name() == "identifier" && node_text(*part, code) == "default"
                    })
            });
    }

    // C# `default:` sections and catch-all (`_`, `var x`) labels and arms, and Kotlin `else ->`
    // entries. A guarded catch-all (`_ when cond =>`) is still a default arm: only its guard
    // branches, which is_pattern_guard charges, like Python's `case _ if cond:` and Rust's
    // `_ if cond =>`.
    if kind == "switch_section" {
        return node
            .child(0)
            .is_some_and(|first| first.kind_name() == "default")
            || crate::util::named_children(node)
                .into_iter()
                .any(is_csharp_catch_all_pattern);
    }
    if kind == "switch_expression_arm" {
        return crate::util::named_children(node)
            .first()
            .is_some_and(|first| is_csharp_catch_all_pattern(*first));
    }
    if kind == "when_entry" {
        return !crate::util::named_children(node)
            .iter()
            .any(|child| child.kind_name() == "when_condition");
    }

    // Python arms with an irrefutable pattern are unconditional like `default`.
    // A bare `case y, z:` or `case y,:` is a sequence pattern: its elements are direct
    // case_pattern children separated by comma tokens of the clause itself.
    if kind == "case_clause" {
        let patterns: Vec<Node<'_>> = crate::util::named_children(node)
            .into_iter()
            .filter(|child| child.kind_name() == "case_pattern")
            .collect();
        return !all_children(node)
            .iter()
            .any(|child| child.kind_name() == ",")
            && matches!(patterns[..], [pattern] if is_python_irrefutable_pattern(pattern));
    }
    // Rust `_ =>` (optionally guarded) fallback arms.
    if kind == "match_arm" {
        return crate::util::named_children(node)
            .into_iter()
            .find(|child| child.kind_name() == "match_pattern")
            .is_some_and(|pattern| {
                // The guard keyword is anonymous, so filter all children, not just named ones.
                let parts: Vec<Node<'_>> = all_children(pattern)
                    .into_iter()
                    .filter(|child| !crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind_name()))
                    .collect();
                matches!(parts[..], [first, ..] if first.kind_name() == "_")
                    && parts.get(1).is_none_or(|second| second.kind_name() == "if")
            });
    }

    // Ruby `in y` binds unconditionally.
    if kind == "in_clause" {
        return node
            .named_child(0)
            .is_some_and(|first| first.kind_name() == "identifier");
    }

    false
}

/// PEP 634's irrefutable patterns: the wildcard `_`, a capture `y`, a group `(p)`, `p as y`, and
/// `p | q` when `p` (or, for `|`, any alternative) is irrefutable. A group parses as a one-element
/// tuple pattern that differs from the real tuple `(p,)` only by the comma token.
fn is_python_irrefutable_pattern(node: Node<'_>) -> bool {
    match node.kind_name() {
        "_" => true,
        "case_pattern" => match non_comment_children(node)[..] {
            [] => all_children(node)
                .iter()
                .any(|child| child.kind_name() == "_"),
            [inner] => is_python_irrefutable_pattern(inner),
            _ => false,
        },
        "dotted_name" => matches!(
            non_comment_children(node)[..],
            [name] if name.kind_name() == "identifier"
        ),
        "tuple_pattern" => {
            !all_children(node)
                .iter()
                .any(|child| child.kind_name() == ",")
                && matches!(
                    non_comment_children(node)[..],
                    [inner] if is_python_irrefutable_pattern(inner)
                )
        }
        "as_pattern" => non_comment_children(node)
            .first()
            .is_some_and(|pattern| is_python_irrefutable_pattern(*pattern)),
        "union_pattern" => all_children(node)
            .into_iter()
            .any(is_python_irrefutable_pattern),
        _ => false,
    }
}

fn non_comment_children<'t>(node: Node<'t>) -> Vec<Node<'t>> {
    crate::util::named_children(node)
        .into_iter()
        .filter(|child| !crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind_name()))
        .collect()
}

/// C# patterns that match every value: the discard `_` and `var x`/`var _`, possibly parenthesized
/// (but not a `var (a, b)` deconstruction, which requires a deconstructible value).
fn is_csharp_catch_all_pattern(node: Node<'_>) -> bool {
    if node.kind_name() == "parenthesized_pattern" {
        return crate::util::named_children(node)
            .into_iter()
            .find(|child| !crate::ncss::COMMENT_NODE_TYPES.contains(&child.kind_name()))
            .is_some_and(is_csharp_catch_all_pattern);
    }
    node.kind_name() == "discard"
        || (node.kind_name() == "declaration_pattern"
            && node
                .child_by_field_name("type")
                .is_some_and(|ty| ty.kind_name() == "implicit_type")
            && !crate::util::named_children(node)
                .iter()
                .any(|child| child.kind_name() == "parenthesized_variable_designation"))
}

/// The parent guard is required because the same tokens appear in non-boolean syntax (C++ `int&&`,
/// `operator&&`, Rust's empty closure parameter list `|| 5`).
fn is_boolean_operator(node: Node<'_>, parent: Option<Node<'_>>, code: &Source<'_>) -> bool {
    if node.is_named() || !BOOLEAN_OPERATORS.contains(&node_text(node, code)) {
        return false;
    }

    parent.is_some_and(|parent| BOOLEAN_OPERATOR_PARENT_TYPES.contains(&parent.kind_name()))
}

/// A Ruby `case ... else` arm (see count_plain_else_branches).
fn is_case_else_parent(parent: Option<Node<'_>>) -> bool {
    parent.is_some_and(|parent| parent.kind_name() == "case" || parent.kind_name() == "case_match")
}
