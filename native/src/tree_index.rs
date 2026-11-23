use std::cell::{Cell, RefCell};
use std::marker::PhantomData;
use std::num::NonZeroU16;
use std::sync::OnceLock;

use rustc_hash::FxHashMap;
use tree_sitter::{Node, Tree};

use crate::languages::{LanguageDefinition, GRAMMAR_COUNT};

const NO_PARENT: u32 = u32::MAX;
const MAX_RETAINED_NODES: usize = 1_048_576;

/// A node of the indexed tree: its parent's slot in CHILD_NODES and where its children lie there.
struct IndexedNode {
    parent: u32,
    first_child: u32,
    child_count: u32,
}

thread_local! {
    /// Node id -> parent and children for the tree indexed on this thread. The lifetime is erased
    /// to store the nodes; TreeIndex borrows the tree and clears the tables on drop, so no entry
    /// outlives it.
    static NODES: RefCell<FxHashMap<usize, IndexedNode>> = RefCell::new(FxHashMap::default());
    /// The root at slot 0, then the children of every indexed node, each node's children contiguous.
    static CHILD_NODES: RefCell<Vec<Node<'static>>> = const { RefCell::new(Vec::new()) };
    /// Parallel to CHILD_NODES: each child's field id, or 0 when unnamed.
    static CHILD_FIELDS: RefCell<Vec<u16>> = const { RefCell::new(Vec::new()) };
    /// Node kind names of the indexed tree's language, indexed by kind id.
    static KIND_NAMES: Cell<&'static [String]> = const { Cell::new(&[]) };
    /// Field names of the indexed tree's language, indexed by field id.
    static FIELD_NAMES: Cell<&'static [String]> = const { Cell::new(&[]) };
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
        FIELD_NAMES.set(language.field_names());
        LANGUAGE_NAME.set(language.name);
        GRAMMAR_INDEX.set(Some(language.grammar_index()));
        let node_count = tree.root_node().descendant_count();
        NODES.with_borrow_mut(|nodes| {
            CHILD_NODES.with_borrow_mut(|child_nodes| {
                CHILD_FIELDS.with_borrow_mut(|child_fields| {
                    assert!(nodes.is_empty(), "one tree is indexed per thread at a time");
                    nodes.reserve(node_count);
                    child_nodes.reserve(node_count);
                    child_fields.reserve(node_count);
                    index_tree(tree, nodes, child_nodes, child_fields)
                })
            })
        })?;
        Ok(index)
    }
}

/// One cursor pass: each node's children are gathered on `pending` while its subtree is walked
/// and moved to `child_nodes`/`child_fields` in one piece when the walk leaves it.
fn index_tree(
    tree: &Tree,
    nodes: &mut FxHashMap<usize, IndexedNode>,
    child_nodes: &mut Vec<Node<'static>>,
    child_fields: &mut Vec<u16>,
) -> Result<(), String> {
    let mut cursor = tree.walk();
    child_nodes.push(erase_lifetime(cursor.node()));
    child_fields.push(0);
    // The entered ancestors, each with the length `pending` had when its first child was reached.
    let mut stack: Vec<(usize, usize)> = Vec::new();
    let mut pending: Vec<(Node<'static>, u16)> = Vec::new();
    loop {
        let node = erase_lifetime(cursor.node());
        nodes.insert(
            node.id(),
            IndexedNode {
                parent: NO_PARENT,
                first_child: 0,
                child_count: 0,
            },
        );
        if !stack.is_empty() {
            pending.push((node, cursor.field_id().map_or(0, NonZeroU16::get)));
        }
        if cursor.goto_first_child() {
            stack.push((node.id(), pending.len()));
            if stack.len() > MAX_TREE_DEPTH {
                return Err(format!("tree depth exceeds {MAX_TREE_DEPTH}"));
            }
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                assign_parents(nodes, child_nodes);
                return Ok(());
            }
            let (closed_id, first_pending) = stack.pop().expect("a child's parent was entered");
            flush_pending_children(
                nodes,
                child_nodes,
                child_fields,
                &mut pending,
                (closed_id, first_pending),
            );
        }
    }
}

fn flush_pending_children(
    nodes: &mut FxHashMap<usize, IndexedNode>,
    child_nodes: &mut Vec<Node<'static>>,
    child_fields: &mut Vec<u16>,
    pending: &mut Vec<(Node<'static>, u16)>,
    (closed_id, first_pending): (usize, usize),
) {
    let entry = nodes
        .get_mut(&closed_id)
        .expect("every entered node is indexed");
    entry.first_child = child_nodes.len() as u32;
    entry.child_count = (pending.len() - first_pending) as u32;
    for (child, field_id) in pending.drain(first_pending..) {
        child_nodes.push(child);
        child_fields.push(field_id);
    }
}

fn assign_parents(nodes: &mut FxHashMap<usize, IndexedNode>, child_nodes: &[Node<'static>]) {
    for (parent_index, parent_node) in child_nodes.iter().enumerate() {
        let entry = &nodes[&parent_node.id()];
        let (first, count) = (entry.first_child as usize, entry.child_count as usize);
        for child_node in &child_nodes[first..first + count] {
            if let Some(child_entry) = nodes.get_mut(&child_node.id()) {
                child_entry.parent = parent_index as u32;
            }
        }
    }
}

fn erase_lifetime(node: Node<'_>) -> Node<'static> {
    // SAFETY: Node only borrows its tree; the erased node is stored in CHILD_NODES, which the
    // TreeIndex borrowing that tree empties before the tree can be dropped. Every lookup checks
    // that the caller's Node<'t> belongs to the indexed tree — by matching its id in NODES or
    // against the root at CHILD_NODES[0] — so any node handed back borrows that same tree.
    unsafe { std::mem::transmute::<Node<'_>, Node<'static>>(node) }
}

impl Drop for TreeIndex<'_> {
    fn drop(&mut self) {
        NODES.with_borrow_mut(|nodes| {
            nodes.clear();
            if nodes.capacity() > MAX_RETAINED_NODES {
                *nodes = FxHashMap::default();
            }
        });
        CHILD_NODES.with_borrow_mut(|children| {
            children.clear();
            if children.capacity() > MAX_RETAINED_NODES {
                *children = Vec::new();
            }
        });
        CHILD_FIELDS.with_borrow_mut(|fields| {
            fields.clear();
            if fields.capacity() > MAX_RETAINED_NODES {
                *fields = Vec::new();
            }
        });
        KIND_NAMES.set(&[]);
        FIELD_NAMES.set(&[]);
        LANGUAGE_NAME.set("");
        GRAMMAR_INDEX.set(None);
    }
}

/// Calls `visit` with the node's children, or returns None when no installed index holds the node.
pub fn with_indexed_children<'t, R>(
    node: Node<'t>,
    visit: impl FnOnce(&[Node<'t>]) -> R,
) -> Option<R> {
    let (first_child, child_count) = NODES.with_borrow(|nodes| {
        nodes
            .get(&node.id())
            .map(|entry| (entry.first_child as usize, entry.child_count as usize))
    })?;
    CHILD_NODES
        .with_borrow(|children| Some(visit(&children[first_child..first_child + child_count])))
}

/// The contiguous slot range of `node`'s children in `CHILD_NODES`, when `node` is indexed.
pub fn indexed_child_slots(node: Node<'_>) -> Option<std::ops::Range<u32>> {
    NODES.with_borrow(|nodes| {
        nodes
            .get(&node.id())
            .map(|entry| entry.first_child..entry.first_child + entry.child_count)
    })
}

/// The node and field name at `slot` of the indexed tree whose root is `root`.
pub fn indexed_slot<'t>(root: Node<'t>, slot: u32) -> (Node<'t>, Option<&'t str>) {
    let index = slot as usize;
    let node = CHILD_NODES.with_borrow(|children| {
        assert!(
            children
                .first()
                .is_some_and(|first| first.id() == root.id()),
            "indexed_slot requires the indexed tree root"
        );
        children[index]
    });
    let field_id = CHILD_FIELDS.with_borrow(|fields| fields[index]);
    let field_name = (field_id != 0)
        .then(|| {
            FIELD_NAMES
                .get()
                .get(usize::from(field_id))
                .map(String::as_str)
        })
        .flatten();
    (node, field_name)
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
            .with_borrow(|nodes| {
                let entry = nodes.get(&self.id())?;
                Some(if entry.parent == NO_PARENT {
                    None
                } else {
                    CHILD_NODES.with_borrow(|children| Some(children[entry.parent as usize]))
                })
            })
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
