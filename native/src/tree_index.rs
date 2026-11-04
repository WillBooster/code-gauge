use std::cell::{Cell, RefCell};
use std::marker::PhantomData;
use std::sync::OnceLock;

use rustc_hash::FxHashMap;
use tree_sitter::{Node, Tree};

use crate::languages::{LanguageDefinition, GRAMMAR_COUNT};

/// A node of the indexed tree: its parent and where its children lie in CHILDREN.
struct IndexedNode {
    parent: Option<Node<'static>>,
    first_child: u32,
    child_count: u32,
}

thread_local! {
    /// Node id -> parent and children for the tree indexed on this thread. The lifetime is erased
    /// to store the nodes; TreeIndex borrows the tree and clears the tables on drop, so no entry
    /// outlives it.
    static NODES: RefCell<FxHashMap<usize, IndexedNode>> = RefCell::new(FxHashMap::default());
    /// The children of every indexed node with their field names, each node's children contiguous.
    static CHILDREN: RefCell<Vec<(Node<'static>, Option<&'static str>)>> = const { RefCell::new(Vec::new()) };
    /// Node kind names of the indexed tree's language, indexed by kind id.
    static KIND_NAMES: Cell<&'static [String]> = const { Cell::new(&[]) };
    /// Name of the indexed tree's language.
    static LANGUAGE_NAME: Cell<&'static str> = const { Cell::new("") };
    /// LanguageDefinition::grammar_index of the indexed tree's language.
    static GRAMMAR_INDEX: Cell<Option<usize>> = const { Cell::new(None) };
}

/// The language of the tree indexed on this thread, or "" when none is.
pub fn language_name() -> &'static str {
    LANGUAGE_NAME.get()
}

/// Makes NodeExt lookups O(1) while the tree is being measured: tree-sitter's `Node::parent`
/// rescans from the root on every call (linear in the sibling counts along the path), each
/// `Node::children` walk runs a fresh cursor, and `Node::kind` measures and UTF-8-validates the C
/// string on every call.
pub struct TreeIndex<'t> {
    tree: PhantomData<&'t Tree>,
}

/// The metric passes recurse per tree level and would overflow the native stack (a
/// process-killing SIGSEGV, not a catchable error) around depth ~20k, so deeper trees are refused.
const MAX_TREE_DEPTH: usize = 5_000;

impl<'t> TreeIndex<'t> {
    pub fn new(tree: &'t Tree, language: &LanguageDefinition) -> Result<TreeIndex<'t>, String> {
        // Constructed first so that the depth error below also clears the partial index on drop.
        let index = TreeIndex { tree: PhantomData };
        KIND_NAMES.set(language.kind_names());
        LANGUAGE_NAME.set(language.name);
        GRAMMAR_INDEX.set(Some(language.grammar_index()));
        NODES.with_borrow_mut(|nodes| {
            CHILDREN.with_borrow_mut(|children| {
                assert!(nodes.is_empty(), "one tree is indexed per thread at a time");
                index_tree(tree, nodes, children)
            })
        })?;
        Ok(index)
    }
}

/// One cursor pass: each node's children are gathered on `pending` while its subtree is walked
/// and moved to `children` in one piece when the walk leaves it.
fn index_tree(
    tree: &Tree,
    nodes: &mut FxHashMap<usize, IndexedNode>,
    children: &mut Vec<(Node<'static>, Option<&'static str>)>,
) -> Result<(), String> {
    let mut cursor = tree.walk();
    // The entered ancestors, each with the length `pending` had when its first child was reached.
    let mut stack: Vec<(Node<'static>, usize)> = Vec::new();
    let mut pending: Vec<(Node<'static>, Option<&'static str>)> = Vec::new();
    loop {
        let node = erase_lifetime(cursor.node());
        let parent = stack.last().map(|&(parent, _)| parent);
        nodes.insert(
            node.id(),
            IndexedNode {
                parent,
                first_child: 0,
                child_count: 0,
            },
        );
        if parent.is_some() {
            pending.push((node, erase_field_lifetime(cursor.field_name())));
        }
        if cursor.goto_first_child() {
            stack.push((node, pending.len()));
            if stack.len() > MAX_TREE_DEPTH {
                return Err(format!("tree depth exceeds {MAX_TREE_DEPTH}"));
            }
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return Ok(());
            }
            let (closed, first_pending) = stack.pop().expect("a child's parent was entered");
            let entry = nodes
                .get_mut(&closed.id())
                .expect("every entered node is indexed");
            entry.first_child = children.len() as u32;
            entry.child_count = (pending.len() - first_pending) as u32;
            children.extend(pending.drain(first_pending..));
        }
    }
}

impl Drop for TreeIndex<'_> {
    fn drop(&mut self) {
        NODES.with_borrow_mut(|nodes| nodes.clear());
        CHILDREN.with_borrow_mut(|children| children.clear());
        KIND_NAMES.set(&[]);
        LANGUAGE_NAME.set("");
        GRAMMAR_INDEX.set(None);
    }
}

fn erase_lifetime(node: Node<'_>) -> Node<'static> {
    // SAFETY: Node only borrows its tree; the erased node is stored in NODES and CHILDREN, which
    // the TreeIndex borrowing that tree empties before the tree can be dropped. Lookups are keyed
    // by node id, an address inside the indexed tree, so a node handed back for a node of the
    // indexed tree belongs to the tree that node borrows.
    unsafe { std::mem::transmute::<Node<'_>, Node<'static>>(node) }
}

fn erase_field_lifetime(field_name: Option<&str>) -> Option<&'static str> {
    // SAFETY: as in erase_lifetime; field names borrow the tree's language as nodes borrow the tree.
    unsafe { std::mem::transmute::<Option<&str>, Option<&'static str>>(field_name) }
}

/// Calls `visit` with the node's children and their field names (TreeCursor::field_name), or
/// returns None when no installed index holds the node.
pub fn with_indexed_children<'t, R>(
    node: Node<'t>,
    visit: impl FnOnce(&[(Node<'t>, Option<&'t str>)]) -> R,
) -> Option<R> {
    let (first_child, child_count) = NODES.with_borrow(|nodes| {
        nodes
            .get(&node.id())
            .map(|entry| (entry.first_child as usize, entry.child_count as usize))
    })?;
    CHILDREN.with_borrow(|children| {
        let children = &children[first_child..first_child + child_count];
        Some(visit(children))
    })
}

pub trait NodeExt<'t> {
    /// `Node::parent`, answered from the TreeIndex when one is installed.
    fn parent_node(self) -> Option<Node<'t>>;
    /// `Node::kind`, answered from the TreeIndex when one is installed.
    fn kind_name(self) -> &'t str;
}

impl<'t> NodeExt<'t> for Node<'t> {
    fn parent_node(self) -> Option<Node<'t>> {
        // tree-sitter locates the parent by byte range, which for a zero-width node (a MISSING
        // token, an empty construct) can select a sibling touching the same offset instead of the
        // structural parent; those rare nodes keep tree-sitter's answer so metrics stay unchanged.
        if self.start_byte() == self.end_byte() {
            return self.parent();
        }
        NODES
            .with_borrow(|nodes| nodes.get(&self.id()).map(|entry| entry.parent))
            .unwrap_or_else(|| self.parent())
    }

    fn kind_name(self) -> &'t str {
        KIND_NAMES
            .get()
            .get(usize::from(self.kind_id()))
            .map(String::as_str)
            .unwrap_or_else(|| self.kind())
    }
}

/// A set of node kind names that answers for a node by its kind id while a TreeIndex is
/// installed: per grammar, a flag per kind id, built on the set's first use with that grammar.
pub struct KindSet {
    names: &'static [&'static str],
    flags_by_grammar: [OnceLock<Vec<bool>>; GRAMMAR_COUNT],
}

impl KindSet {
    pub const fn new(names: &'static [&'static str]) -> KindSet {
        KindSet {
            names,
            flags_by_grammar: [const { OnceLock::new() }; GRAMMAR_COUNT],
        }
    }

    /// Whether the set holds `node.kind_name()`.
    pub fn contains(&self, node: Node<'_>) -> bool {
        GRAMMAR_INDEX
            .get()
            .and_then(|grammar_index| {
                self.flags_by_grammar[grammar_index]
                    .get_or_init(|| {
                        KIND_NAMES
                            .get()
                            .iter()
                            .map(|name| self.contains_name(name))
                            .collect()
                    })
                    // An id past the grammar's kinds (ERROR's) is looked up by name, as kind_name does.
                    .get(usize::from(node.kind_id()))
                    .copied()
            })
            .unwrap_or_else(|| self.contains_name(node.kind_name()))
    }

    pub fn contains_name(&self, name: &str) -> bool {
        self.names.contains(&name)
    }
}
