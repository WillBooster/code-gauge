use std::cell::{Cell, RefCell};
use std::marker::PhantomData;

use rustc_hash::FxHashMap;
use tree_sitter::{Node, Tree};

use crate::languages::LanguageDefinition;

thread_local! {
    /// Node id -> parent for the tree indexed on this thread. The lifetime is erased to store the
    /// nodes; TreeIndex borrows the tree and clears the map on drop, so no entry outlives it.
    static PARENTS: RefCell<FxHashMap<usize, Node<'static>>> = RefCell::new(FxHashMap::default());
    /// Node kind names of the indexed tree's language, indexed by kind id.
    static KIND_NAMES: Cell<&'static [&'static str]> = const { Cell::new(&[]) };
}

/// Makes NodeExt lookups O(1) while the tree is being measured: tree-sitter's `Node::parent`
/// rescans from the root on every call (linear in the sibling counts along the path), and
/// `Node::kind` measures and UTF-8-validates the C string on every call.
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
        PARENTS.with_borrow_mut(|parents| {
            assert!(
                parents.is_empty(),
                "one tree is indexed per thread at a time"
            );
            let mut cursor = tree.walk();
            let mut stack: Vec<Node<'static>> = Vec::new();
            loop {
                let node = erase_lifetime(cursor.node());
                if let Some(&parent) = stack.last() {
                    parents.insert(node.id(), parent);
                }
                if cursor.goto_first_child() {
                    stack.push(node);
                    if stack.len() > MAX_TREE_DEPTH {
                        return Err(format!("tree depth exceeds {MAX_TREE_DEPTH}"));
                    }
                    continue;
                }
                while !cursor.goto_next_sibling() {
                    if !cursor.goto_parent() {
                        return Ok(());
                    }
                    stack.pop();
                }
            }
        })?;
        Ok(index)
    }
}

impl Drop for TreeIndex<'_> {
    fn drop(&mut self) {
        PARENTS.with_borrow_mut(|parents| parents.clear());
        KIND_NAMES.set(&[]);
    }
}

fn erase_lifetime(node: Node<'_>) -> Node<'static> {
    // SAFETY: Node only borrows its tree; the erased node is stored in PARENTS, which the
    // TreeIndex borrowing that tree empties before the tree can be dropped.
    unsafe { std::mem::transmute::<Node<'_>, Node<'static>>(node) }
}

pub trait NodeExt<'t> {
    /// `Node::parent`, answered from the TreeIndex when one is installed.
    fn parent_node(self) -> Option<Node<'t>>;
    /// `Node::kind`, answered from the TreeIndex when one is installed.
    fn kind_name(self) -> &'static str;
}

impl<'t> NodeExt<'t> for Node<'t> {
    fn parent_node(self) -> Option<Node<'t>> {
        // tree-sitter locates the parent by byte range, which for a zero-width node (a MISSING
        // token, an empty construct) can select a sibling touching the same offset instead of the
        // structural parent; those rare nodes keep tree-sitter's answer so metrics stay unchanged.
        if self.start_byte() == self.end_byte() {
            return self.parent();
        }
        PARENTS
            .with_borrow(|parents| {
                parents.get(&self.id()).map(|parent| {
                    // SAFETY: ids are addresses inside the indexed tree, which outlives the
                    // index, so a hit means `parent` belongs to the tree `self` borrows.
                    unsafe { std::mem::transmute::<Node<'static>, Node<'t>>(*parent) }
                })
            })
            .or_else(|| self.parent())
    }

    fn kind_name(self) -> &'static str {
        KIND_NAMES
            .get()
            .get(usize::from(self.kind_id()))
            .copied()
            .unwrap_or_else(|| self.kind())
    }
}
