use indexmap::IndexMap;
use rustc_hash::{FxHashMap, FxHashSet};

use crate::duplication::{
    group_sort_key, is_literal_dense, CountedOccurrence, DuplicationSettings,
};
use crate::near_miss::{
    Alignment, Block, CorePair, Matcher, PairMatch, TokenRuns, FILTRATION_PERCENT, MAX_LENGTH_RATIO,
};
use crate::tokenize::{Token, TokenRange, TokenizedSource};

// code-gauge-allow-file fileNcss -- near-miss candidate filtration, local-core clustering, and anchor coalescing form one pass

/// A verified near-miss pair of blocks; without `cores`, the blocks match as wholes.
struct MatchEdge {
    left: usize,
    right: usize,
    cores: Option<CorePair>,
    /// The token runs the pair matches, on the left and on the right.
    matched_runs: (TokenRuns, TokenRuns),
}

impl MatchEdge {
    /// The (block, core) on each side.
    fn sides(&self) -> [(usize, Option<(usize, usize)>); 2] {
        let (left_core, right_core) = self.cores.unzip();
        [(self.left, left_core), (self.right, right_core)]
    }
}

/// Detects near-miss (Type-3) clone groups among block candidates the exact pipeline left
/// unreported: NIL-style n-gram filtration, then pair verification (near_miss::Matcher), then
/// transitive clustering of verified pairs (crossFileNearMiss.ts applies the same model across
/// files). A block that matched only locally is reported as its matched cores (overlapping cores
/// merged), each clustered with its own partners, so code no verified pair matched never counts
/// as duplicated. A node overlapping a reported occurrence is an anchor: it joins its group at its
/// own size, so the copies of a block are listed at the size they matched it, and is marked as
/// counted elsewhere unless the group takes over the reported occurrences it overlaps. An anchor
/// still counts the lines its partners match outside those occurrences.
pub(crate) fn collect_near_miss_groups(
    source: &TokenizedSource<'_>,
    settings: &DuplicationSettings,
    reported_groups: &mut [Vec<CountedOccurrence>],
) -> Vec<Vec<CountedOccurrence>> {
    if settings.min_similarity_percent >= 100 {
        return Vec::new();
    }
    let comparable = select_near_miss_blocks(source, settings.min_tokens);
    if comparable.len() < 2 {
        return Vec::new();
    }
    let (blocks, matcher, token_keys) = build_blocks_and_matcher(source, &comparable, settings);
    let edges = collect_verified_edges(
        &blocks,
        &comparable,
        &matcher,
        &token_keys,
        reported_groups,
        settings.min_similarity_percent,
    );
    let graph = ClusterGraph::build(&comparable, &edges, source.tokens.len(), reported_groups);
    let mut groups = graph.collect_groups(&source.tokens, settings.min_tokens, reported_groups);
    groups.sort_by_key(|group| group_sort_key(group));
    groups
}

/// The mutually disjoint blocks near-miss comparison considers: at least `min_tokens` long, not
/// literal-dense (data tables are compared by value, not shape), and selected by
/// select_comparable_blocks.
pub(crate) fn select_near_miss_blocks<'s>(
    source: &'s TokenizedSource<'_>,
    min_tokens: usize,
) -> Vec<&'s TokenRange> {
    let literal_count_prefix = &source.literal_count_prefix;
    let mut eligible: Vec<&TokenRange> = source
        .structure
        .block_ranges
        .iter()
        .chain(&source.structure.split_try_body_ranges)
        .filter(|range| {
            let token_count = range.end_token_index - range.start_token_index;
            let literal_count = literal_count_prefix[range.end_token_index]
                - literal_count_prefix[range.start_token_index];
            token_count >= min_tokens && !is_literal_dense(literal_count, token_count)
        })
        .collect();
    eligible.sort_by_key(|range| {
        (
            range.start_token_index,
            std::cmp::Reverse(range.end_token_index),
        )
    });
    select_comparable_blocks(&eligible)
}

struct ForestNode<'a> {
    range: &'a TokenRange,
    children: Vec<usize>,
}

/// Keeps the block ranges the near-miss phase compares: wrappers whose subtree branches into two
/// or more disjoint eligible sub-blocks are descended through; linear chains keep their top.
fn select_comparable_blocks<'a>(eligible: &[&'a TokenRange]) -> Vec<&'a TokenRange> {
    // Index arena: nodes never move, so ancestor references on the stack stay valid.
    let mut nodes: Vec<ForestNode<'a>> = Vec::new();
    let mut roots: Vec<usize> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    for &range in eligible {
        push_forest_range(range, &mut nodes, &mut roots, &mut stack);
    }
    let mut kept = Vec::new();
    for &root in &roots {
        collect_branching_leaves(&nodes, root, &mut kept);
    }
    kept
}

fn push_forest_range<'a>(
    range: &'a TokenRange,
    nodes: &mut Vec<ForestNode<'a>>,
    roots: &mut Vec<usize>,
    stack: &mut Vec<usize>,
) {
    while let Some(&top) = stack.last() {
        if nodes[top].range.end_token_index <= range.start_token_index {
            stack.pop();
        } else {
            break;
        }
    }
    // Equal spans (two node types covering the same tokens) collapse into the first.
    if stack.last().is_some_and(|&top| {
        nodes[top].range.start_token_index == range.start_token_index
            && nodes[top].range.end_token_index == range.end_token_index
    }) {
        return;
    }
    let id = nodes.len();
    nodes.push(ForestNode {
        range,
        children: Vec::new(),
    });
    match stack.last() {
        Some(&top) => nodes[top].children.push(id),
        None => roots.push(id),
    }
    stack.push(id);
}

fn collect_branching_leaves<'a>(
    nodes: &[ForestNode<'a>],
    id: usize,
    kept: &mut Vec<&'a TokenRange>,
) {
    if forest_branches(nodes, id) {
        for &child in &nodes[id].children {
            collect_branching_leaves(nodes, child, kept);
        }
    } else {
        kept.push(nodes[id].range);
    }
}

fn forest_branches(nodes: &[ForestNode<'_>], id: usize) -> bool {
    let children = &nodes[id].children;
    children.len() >= 2 || (children.len() == 1 && forest_branches(nodes, children[0]))
}

fn build_blocks_and_matcher(
    source: &TokenizedSource<'_>,
    comparable: &[&TokenRange],
    settings: &DuplicationSettings,
) -> (Vec<Block>, Matcher, Vec<i64>) {
    let (symbols, is_content, token_keys) = to_symbol_stream(&source.tokens);
    let statements = top_level_statement_finder(&source.structure.container_statement_ranges);
    let mut blocks: Vec<Block> = comparable
        .iter()
        .map(|range| {
            Block::new(
                &symbols,
                &is_content,
                &token_keys,
                range.start_token_index,
                range.end_token_index,
                statements(range.start_token_index, range.end_token_index),
            )
        })
        .collect();
    let matcher = Matcher::new(
        &mut blocks,
        settings.min_tokens,
        settings.min_similarity_percent,
    );
    (blocks, matcher, token_keys)
}

/// The file's tokens as a near-miss symbol stream: identifiers as -(file-level id + 1), every
/// other token interned from its hash pairs (literal VALUES folded in, unlike the exact
/// fingerprint's kind tags), plus which tokens are content-bearing (names and literal values).
/// Interned per call so a file's symbol ids (and thus its n-gram hashes) never depend on which
/// other files the process measured before it. A symbol id still depends on where in the file its
/// token first occurs, so each non-identifier token also gets a key of its content alone.
fn to_symbol_stream(tokens: &[Token<'_>]) -> (Vec<i32>, Vec<bool>, Vec<i64>) {
    let mut symbol_by_token_hashes: FxHashMap<(i32, i32, i32, i32), i32> = FxHashMap::default();
    let mut id_by_identifier: FxHashMap<&str, i32> = FxHashMap::default();
    let mut symbols = Vec::with_capacity(tokens.len());
    let mut is_content = Vec::with_capacity(tokens.len());
    let mut token_keys = Vec::with_capacity(tokens.len());
    for token in tokens {
        if token.is_id {
            let next_id = id_by_identifier.len() as i32;
            let id = *id_by_identifier.entry(token.text).or_insert(next_id);
            symbols.push(-(id + 1));
            is_content.push(false);
            token_keys.push(0);
            continue;
        }
        let hashes = (
            token.text_hash,
            token.text_hash2,
            token.literal_hash.unwrap_or(0),
            token.literal_hash2.unwrap_or(0),
        );
        let next_symbol = symbol_by_token_hashes.len() as i32;
        symbols.push(*symbol_by_token_hashes.entry(hashes).or_insert(next_symbol));
        is_content.push(token.is_name || token.literal_hash.is_some());
        token_keys.push(token_content_key(hashes));
    }
    (symbols, is_content, token_keys)
}

/// A 53-bit key of a token's two text hashes, each mixed with the matching literal value hash; the
/// same key as `tokenKey` in crossFileNearMiss.ts, so that both detectors order content alike.
fn token_content_key((text, text2, literal, literal2): (i32, i32, i32, i32)) -> i64 {
    let primary = (text ^ literal.wrapping_mul(0x9E37_79B1_u32 as i32)) as u32;
    let secondary = (text2 ^ literal2.wrapping_mul(0x85EB_CA6B_u32 as i32)) as u32;
    i64::from(primary) * 0x20_0000 + i64::from(secondary >> 11)
}

/// Returns a lookup of the outermost container statements inside a token range, excluding a
/// statement spanning the whole range (the block itself).
fn top_level_statement_finder(
    container_statement_ranges: &[Vec<TokenRange>],
) -> impl Fn(usize, usize) -> Vec<(usize, usize)> {
    let mut statements: Vec<(usize, usize)> = container_statement_ranges
        .iter()
        .flatten()
        .map(|range| (range.start_token_index, range.end_token_index))
        .filter(|(start, end)| start < end)
        .collect();
    statements.sort_by_key(|&(start, end)| (start, std::cmp::Reverse(end)));
    move |start, end| {
        let mut top_level: Vec<(usize, usize)> = Vec::new();
        let first = statements.partition_point(|statement| statement.0 < start);
        for &statement in statements[first..]
            .iter()
            .take_while(|statement| statement.0 < end)
        {
            let nested = top_level.last().is_some_and(|last| statement.0 < last.1);
            if statement.1 <= end && statement != (start, end) && !nested {
                top_level.push(statement);
            }
        }
        top_level
    }
}

struct EdgeCollector<'a> {
    blocks: &'a [Block],
    comparable: &'a [&'a TokenRange],
    matcher: &'a Matcher,
    token_keys: &'a [i64],
    listed_prefix: Vec<usize>,
    edges: Vec<MatchEdge>,
}

/// The lines of a near-miss copy that are duplicated are those a verified partner matches, which
/// takes the pairing itself. Every pair kept is aligned: verifying it already cost a longest
/// common subsequence of the same sequences, and any choice among a copy's partners would let
/// their number or their order decide what the copy counts.
///
/// A pair matching nothing outside listed content has nothing to add to it and is dropped before
/// clustering, so that it neither collapses the blocks' core nodes nor widens a node beyond what
/// the pairs clustering it matched. Any other pair is kept however much of it is reported: what
/// the exact pipeline reports of a copy depends on where its copies stand, and the lines the copy
/// counts must not.
fn collect_verified_edges(
    blocks: &[Block],
    comparable: &[&TokenRange],
    matcher: &Matcher,
    token_keys: &[i64],
    reported_groups: &[Vec<CountedOccurrence>],
    min_similarity_percent: usize,
) -> Vec<MatchEdge> {
    // Listed content is the reported content without the groups holding nested copies. Such a
    // group lists a part of larger copies with a copy standing elsewhere, which makes no pair
    // redundant: the blocks around its copies may be copies as wholes, which only their pair can
    // list at that size, taking the group over.
    let listed_prefix = reported_prefix_of(
        token_keys.len(),
        reported_groups.iter().filter(|group| {
            group
                .iter()
                .all(|occurrence| !occurrence.nested_in_larger_group)
        }),
    );
    let mut collector = EdgeCollector {
        blocks,
        comparable,
        matcher,
        token_keys,
        listed_prefix,
        edges: Vec::new(),
    };
    for_each_candidate_pair(blocks, min_similarity_percent, |left, right| {
        collector.verify_and_add(left, right);
    });
    collector.edges
}

impl EdgeCollector<'_> {
    fn verify_and_add(&mut self, left: usize, right: usize) {
        match self.matcher.verify(&self.blocks[left], &self.blocks[right]) {
            None => {}
            Some(PairMatch::Whole(alignment)) => self.add_edge(left, right, None, alignment),
            Some(PairMatch::Local(cores)) => {
                for (core_pair, alignment) in cores {
                    self.add_edge(left, right, Some(core_pair), alignment);
                }
            }
        }
    }

    fn add_edge(
        &mut self,
        left: usize,
        right: usize,
        cores: Option<CorePair>,
        alignment: Alignment,
    ) {
        let block_span = |index: usize| {
            (
                self.comparable[index].start_token_index,
                self.comparable[index].end_token_index,
            )
        };
        let (left_span, right_span) = cores.unwrap_or((block_span(left), block_span(right)));
        // Fully listed spans need no alignment to be dropped.
        if self.unreported_count(&[left_span, right_span]) == 0 {
            return;
        }
        let matched_runs = self.matcher.align(
            &self.blocks[left],
            &self.blocks[right],
            cores,
            alignment,
            self.token_keys,
        );
        if self.unreported_count(&matched_runs.0) + self.unreported_count(&matched_runs.1) == 0 {
            return;
        }
        self.edges.push(MatchEdge {
            left,
            right,
            cores,
            matched_runs,
        });
    }

    fn unreported_count(&self, runs: &[(usize, usize)]) -> usize {
        runs.iter()
            .map(|&(start, end)| {
                end - start - (self.listed_prefix[end] - self.listed_prefix[start])
            })
            .sum()
    }
}

fn reported_prefix_of<'a>(
    token_count: usize,
    groups: impl Iterator<Item = &'a Vec<CountedOccurrence>>,
) -> Vec<usize> {
    let mut reported = vec![false; token_count];
    for occurrence in groups.flatten() {
        for &(start, end) in &occurrence.segments {
            reported[start..end].fill(true);
        }
    }
    let mut prefix = vec![0usize; token_count + 1];
    for (index, &flag) in reported.iter().enumerate() {
        prefix[index + 1] = prefix[index] + usize::from(flag);
    }
    prefix
}

/// Visits every block pair sharing at least FILTRATION_PERCENT of the smaller block's distinct
/// n-grams, except pairs whose length ratio rules out both whole-block similarity and
/// MAX_LENGTH_RATIO; the same scan as forEachCandidatePair in crossFileNearMiss.ts. Blocks are
/// visited in ascending length, so each posting list is scanned backwards only while its blocks are
/// long enough, and shared counts accumulate in a dense counter instead of a pair map.
fn for_each_candidate_pair(
    blocks: &[Block],
    min_similarity_percent: usize,
    mut visit: impl FnMut(usize, usize),
) {
    let mut order: Vec<usize> = (0..blocks.len()).collect();
    order.sort_by_key(|&index| blocks[index].len());
    let mut postings: FxHashMap<i32, Vec<usize>> = FxHashMap::default();
    let mut shared_counts = vec![0usize; blocks.len()];
    let mut touched: Vec<usize> = Vec::new();
    for right in order {
        accumulate_posting_matches(
            blocks,
            right,
            min_similarity_percent,
            &mut postings,
            &mut shared_counts,
            &mut touched,
        );
        // Ascending so the visit order does not depend on the n-gram set's iteration order.
        touched.sort_unstable();
        for &left in &touched {
            let shared = std::mem::take(&mut shared_counts[left]);
            if shared * 100
                >= FILTRATION_PERCENT * blocks[left].ngrams.len().min(blocks[right].ngrams.len())
            {
                visit(left, right);
            }
        }
        touched.clear();
    }
}

fn accumulate_posting_matches(
    blocks: &[Block],
    right: usize,
    min_similarity_percent: usize,
    postings: &mut FxHashMap<i32, Vec<usize>>,
    shared_counts: &mut [usize],
    touched: &mut Vec<usize>,
) {
    let length = blocks[right].len();
    let min_left_length = length
        .div_ceil(MAX_LENGTH_RATIO)
        .min((min_similarity_percent * length).div_ceil(100));
    for &ngram in &blocks[right].ngrams {
        let posting = postings.entry(ngram).or_default();
        for &left in posting.iter().rev() {
            if blocks[left].len() < min_left_length {
                break;
            }
            if shared_counts[left] == 0 {
                touched.push(left);
            }
            shared_counts[left] += 1;
        }
        posting.push(right);
    }
}

struct ClusterGraph<'a> {
    comparable: &'a [&'a TokenRange],
    node_blocks: Vec<usize>,
    node_spans: Vec<Option<(usize, usize)>>,
    touched_groups_by_node: Vec<Vec<usize>>,
    matched_runs_by_node: Vec<Vec<(usize, usize)>>,
    members_by_root: IndexMap<usize, Vec<usize>>,
    reported_prefix: Vec<usize>,
}

struct ClusterNodes {
    node_blocks: Vec<usize>,
    node_spans: Vec<Option<(usize, usize)>>,
    first_node_by_block: Vec<usize>,
    matched_whole: Vec<bool>,
}

impl<'a> ClusterGraph<'a> {
    fn build(
        comparable: &'a [&'a TokenRange],
        edges: &[MatchEdge],
        token_count: usize,
        reported_groups: &[Vec<CountedOccurrence>],
    ) -> Self {
        let nodes = build_cluster_nodes(comparable.len(), edges);
        let edge_nodes: Vec<[usize; 2]> = edges
            .iter()
            .map(|edge| {
                edge.sides()
                    .map(|(index, core)| node_of(&nodes, index, core))
            })
            .collect();
        let mut parent: Vec<usize> = (0..nodes.node_blocks.len()).collect();
        for &[left_node, right_node] in &edge_nodes {
            let left_root = find_root(&mut parent, left_node);
            let right_root = find_root(&mut parent, right_node);
            parent[left_root.max(right_root)] = left_root.min(right_root);
        }
        let members_by_root = group_members_by_root(&mut parent);
        let matched_runs_by_node =
            collect_matched_runs(nodes.node_blocks.len(), edges, &edge_nodes);
        // Coverage is judged per node: a core is covered only when a reported occurrence overlaps
        // the core itself, not merely elsewhere in its block.
        let touched_groups_by_node = (0..nodes.node_blocks.len())
            .map(|node| {
                let range = nodes.node_spans[node].unwrap_or((
                    comparable[nodes.node_blocks[node]].start_token_index,
                    comparable[nodes.node_blocks[node]].end_token_index,
                ));
                touched_groups_in(reported_groups, range)
            })
            .collect();
        Self {
            comparable,
            node_blocks: nodes.node_blocks,
            node_spans: nodes.node_spans,
            touched_groups_by_node,
            matched_runs_by_node,
            members_by_root,
            reported_prefix: reported_prefix_of(token_count, reported_groups.iter()),
        }
    }

    fn collect_groups(
        &self,
        tokens: &[Token<'_>],
        min_tokens: usize,
        reported_groups: &mut [Vec<CountedOccurrence>],
    ) -> Vec<Vec<CountedOccurrence>> {
        let mut groups = Vec::new();
        for members in self.members_by_root.values() {
            if let Some(occurrences) =
                self.assemble_member_group(members, tokens, min_tokens, reported_groups)
            {
                groups.push(occurrences);
            }
        }
        groups
    }

    fn assemble_member_group(
        &self,
        members: &[usize],
        tokens: &[Token<'_>],
        min_tokens: usize,
        reported_groups: &mut [Vec<CountedOccurrence>],
    ) -> Option<Vec<CountedOccurrence>> {
        if members.len() < 2 {
            return None;
        }
        let (covered, uncovered): (Vec<usize>, Vec<usize>) = members
            .iter()
            .copied()
            .partition(|&node| !self.touched_groups_by_node[node].is_empty());
        if covered.is_empty() {
            let occurrences = self.to_occurrences(members, tokens);
            return (occurrences.len() >= 2).then_some(occurrences);
        }
        if members.iter().all(|&node| self.is_fully_reported(node)) {
            return None;
        }
        let fully_clustered =
            self.fully_clustered_groups(members, &covered, min_tokens, reported_groups);
        if let Some((&target_index, source_indexes)) = fully_clustered.split_first() {
            let merged =
                self.rebuild_clustered_group(members, &fully_clustered, tokens, reported_groups);
            reported_groups[target_index] = merged;
            for &source_index in source_indexes {
                reported_groups[source_index].clear();
            }
            return None;
        }
        let mut occurrences = self.to_occurrences(&uncovered, tokens);
        occurrences.extend(self.to_anchor_occurrences(&covered, tokens));
        (occurrences.len() >= 2).then(|| {
            occurrences.sort_by_key(|o| (o.start_token_index, o.end_token_index));
            occurrences
        })
    }

    fn is_fully_reported(&self, node: usize) -> bool {
        let (start, end) = self.node_range(node);
        self.reported_prefix[end] - self.reported_prefix[start] == end - start
    }

    /// An anchored cluster extends a reported group only when it stands for the same copies:
    /// every occurrence of the group overlaps the member nodes of exactly one block (one disjoint
    /// from all members reports content the cluster does not share, and one reaching into two
    /// members would make one copy take over lines of the next), exceeds the span of those nodes
    /// by less than `min_tokens` (a copy is listed at the size it matched, not at that of a clone
    /// larger by a reportable part, which may run into code no member matched), and shares that
    /// block with no other occurrence of the group (those repeat within the copy, not between the
    /// copies).
    fn fully_clustered_groups(
        &self,
        members: &[usize],
        covered: &[usize],
        min_tokens: usize,
        reported_groups: &[Vec<CountedOccurrence>],
    ) -> Vec<usize> {
        // Ascending by construction: BTreeSet iteration is sorted and filter preserves order.
        covered
            .iter()
            .flat_map(|&node| self.touched_groups_by_node[node].iter().copied())
            .collect::<std::collections::BTreeSet<usize>>()
            .into_iter()
            .filter(|&group_index| {
                self.stands_for_members(&reported_groups[group_index], members, min_tokens)
            })
            .collect()
    }

    fn stands_for_members(
        &self,
        group: &[CountedOccurrence],
        members: &[usize],
        min_tokens: usize,
    ) -> bool {
        let mut blocks: FxHashSet<usize> = FxHashSet::default();
        !group.is_empty()
            && group.iter().all(|occurrence| {
                self.member_block_of(occurrence, members, min_tokens)
                    .is_some_and(|block| blocks.insert(block))
            })
    }

    fn member_block_of(
        &self,
        occurrence: &CountedOccurrence,
        members: &[usize],
        min_tokens: usize,
    ) -> Option<usize> {
        let mut blocks = members
            .iter()
            .filter(|&&index| occurrence.matches_within(self.node_range(index)))
            .map(|&index| self.node_blocks[index]);
        let block = blocks.next()?;
        let mut spans = members
            .iter()
            .filter(|&&index| self.node_blocks[index] == block)
            .map(|&index| self.node_range(index));
        let first = spans.next()?;
        let span = spans.fold(first, |span, node| (span.0.min(node.0), span.1.max(node.1)));
        let excess = span.0.saturating_sub(occurrence.start_token_index)
            + occurrence.end_token_index.saturating_sub(span.1);
        (blocks.all(|other| other == block) && excess < min_tokens).then_some(block)
    }

    /// Rebuilds the component as ONE group with one coalesced occurrence per member block: the
    /// fragments the nodes of a block overlap are collected together, since a block's cores are
    /// parts of one copy.
    fn rebuild_clustered_group(
        &self,
        members: &[usize],
        fully_clustered: &[usize],
        tokens: &[Token<'_>],
        reported_groups: &[Vec<CountedOccurrence>],
    ) -> Vec<CountedOccurrence> {
        let mut merged: Vec<CountedOccurrence> = Vec::new();
        let mut unanchored_nodes: Vec<usize> = Vec::new();
        let mut anchor_nodes: Vec<usize> = Vec::new();
        let mut nodes_by_block: IndexMap<usize, Vec<usize>> = IndexMap::new();
        for &member_index in members {
            nodes_by_block
                .entry(self.node_blocks[member_index])
                .or_default()
                .push(member_index);
        }
        for block_nodes in nodes_by_block.values() {
            let mut fragments =
                self.overlapping_fragments(block_nodes, fully_clustered, reported_groups);
            if fragments.is_empty() {
                for &node in block_nodes {
                    if self.touched_groups_by_node[node].is_empty() {
                        unanchored_nodes.push(node);
                    } else {
                        anchor_nodes.push(node);
                    }
                }
                continue;
            }
            // The block's nodes are part of the same copy as its fragments: a block matched
            // beyond the fragments it holds is a copy at that size.
            fragments.extend(self.to_occurrences(block_nodes, tokens));
            merged.push(coalesce_occurrences(fragments));
        }
        merged.extend(self.to_occurrences(&unanchored_nodes, tokens));
        mark_enclosed_shared_occurrences(&mut merged, fully_clustered, reported_groups);
        merged.extend(self.to_anchor_occurrences(&anchor_nodes, tokens));
        merged.sort_by_key(|o| (o.start_token_index, o.end_token_index));
        merged
    }

    fn overlapping_fragments(
        &self,
        block_nodes: &[usize],
        fully_clustered: &[usize],
        reported_groups: &[Vec<CountedOccurrence>],
    ) -> Vec<CountedOccurrence> {
        fully_clustered
            .iter()
            .flat_map(|&group_index| &reported_groups[group_index])
            .filter(|occurrence| {
                block_nodes
                    .iter()
                    .any(|&node| occurrence.matches_within(self.node_range(node)))
            })
            .cloned()
            .collect()
    }

    fn to_anchor_occurrences(
        &self,
        nodes: &[usize],
        tokens: &[Token<'_>],
    ) -> Vec<CountedOccurrence> {
        let mut anchors = self.to_occurrences(nodes, tokens);
        for anchor in &mut anchors {
            anchor.shared_with_merged_group = true;
        }
        anchors
    }

    /// A group's nodes from one block become ONE occurrence whose segments are its cores, so the
    /// fragment-weighted count charges the block as one copy (as for gapped clones), not once per
    /// core.
    fn to_occurrences(&self, nodes: &[usize], tokens: &[Token<'_>]) -> Vec<CountedOccurrence> {
        let mut spans_by_block: IndexMap<usize, Vec<Option<(usize, usize)>>> = IndexMap::new();
        for &node in nodes {
            spans_by_block
                .entry(self.node_blocks[node])
                .or_default()
                .push(self.node_spans[node]);
        }
        spans_by_block
            .into_iter()
            .map(|(block, spans)| self.block_occurrence(block, &spans, nodes, tokens))
            .collect()
    }

    fn block_occurrence(
        &self,
        block: usize,
        spans: &[Option<(usize, usize)>],
        nodes: &[usize],
        tokens: &[Token<'_>],
    ) -> CountedOccurrence {
        let range = self.comparable[block];
        let mut segments: Vec<(usize, usize)> = spans
            .iter()
            .map(|span| span.unwrap_or((range.start_token_index, range.end_token_index)))
            .collect();
        segments.sort_unstable();
        let whole = spans.iter().any(Option::is_none);
        let (start, end) = (segments[0].0, segments[segments.len() - 1].1);
        let matched_runs: Vec<(usize, usize)> = nodes
            .iter()
            .filter(|&&node| self.node_blocks[node] == block)
            .flat_map(|&node| self.matched_runs_by_node[node].iter().copied())
            .collect();
        CountedOccurrence {
            shared_with_merged_group: false,
            nested_in_larger_group: false,
            matched_runs: Some(merge_overlapping_cores(&matched_runs)),
            exact_runs: Vec::new(),
            token_count: segments.iter().map(|segment| segment.1 - segment.0).sum(),
            segments,
            start_token_index: start,
            end_token_index: end,
            start_line: if whole {
                range.start_line
            } else {
                tokens[start].start_row + 1
            },
            end_line: if whole {
                range.end_line
            } else {
                tokens[end - 1].end_row + 1
            },
        }
    }

    fn node_range(&self, node: usize) -> (usize, usize) {
        self.node_spans[node].unwrap_or((
            self.comparable[self.node_blocks[node]].start_token_index,
            self.comparable[self.node_blocks[node]].end_token_index,
        ))
    }
}

/// Clustering runs over (block, core) nodes: a block with a recorded whole match is one node, and
/// otherwise each union of its overlapping local cores is its own node, so disjoint cores matched
/// with different partners fall into separate groups.
fn build_cluster_nodes(comparable_len: usize, edges: &[MatchEdge]) -> ClusterNodes {
    let mut matched_whole = vec![false; comparable_len];
    let mut local_cores: Vec<Vec<(usize, usize)>> = vec![Vec::new(); comparable_len];
    for edge in edges {
        for (index, core) in edge.sides() {
            match core {
                Some(core) => local_cores[index].push(core),
                None => matched_whole[index] = true,
            }
        }
    }
    let mut node_blocks = Vec::new();
    let mut node_spans = Vec::new();
    let mut first_node_by_block = Vec::with_capacity(comparable_len);
    for index in 0..comparable_len {
        first_node_by_block.push(node_blocks.len());
        let cores = if matched_whole[index] {
            Vec::new()
        } else {
            merge_overlapping_cores(&local_cores[index])
        };
        if cores.is_empty() {
            node_blocks.push(index);
            node_spans.push(None);
        }
        for core in cores {
            node_blocks.push(index);
            node_spans.push(Some(core));
        }
    }
    ClusterNodes {
        node_blocks,
        node_spans,
        first_node_by_block,
        matched_whole,
    }
}

fn node_of(nodes: &ClusterNodes, index: usize, core: Option<(usize, usize)>) -> usize {
    let first = nodes.first_node_by_block[index];
    match core {
        Some(core) if !nodes.matched_whole[index] => (first..nodes.node_blocks.len())
            .take_while(|&node| nodes.node_blocks[node] == index)
            .find(|&node| {
                nodes.node_spans[node].is_some_and(|span| span.0 <= core.0 && core.1 <= span.1)
            })
            .expect("every local core lies in one of its block's merged cores"),
        _ => first,
    }
}

fn find_root(parent: &mut [usize], mut index: usize) -> usize {
    let mut root = index;
    while parent[root] != root {
        root = parent[root];
    }
    while parent[index] != root {
        let next = parent[index];
        parent[index] = root;
        index = next;
    }
    root
}

fn group_members_by_root(parent: &mut [usize]) -> IndexMap<usize, Vec<usize>> {
    let mut members_by_root: IndexMap<usize, Vec<usize>> = IndexMap::new();
    for node in 0..parent.len() {
        let root = find_root(parent, node);
        members_by_root.entry(root).or_default().push(node);
    }
    members_by_root
}

fn collect_matched_runs(
    node_count: usize,
    edges: &[MatchEdge],
    edge_nodes: &[[usize; 2]],
) -> Vec<Vec<(usize, usize)>> {
    let mut matched_runs_by_node = vec![Vec::new(); node_count];
    for (edge, nodes) in edges.iter().zip(edge_nodes) {
        matched_runs_by_node[nodes[0]].extend(&edge.matched_runs.0);
        matched_runs_by_node[nodes[1]].extend(&edge.matched_runs.1);
    }
    matched_runs_by_node
}

/// Reported-group indices whose occurrences' matched segments overlap `range` (the gap of a gapped
/// clone is not reported content): near-miss nodes covering such content anchor comparisons but
/// are never re-reported.
fn touched_groups_in(
    reported_groups: &[Vec<CountedOccurrence>],
    range: (usize, usize),
) -> Vec<usize> {
    reported_groups
        .iter()
        .enumerate()
        .filter(|(_, group)| group.iter().any(|o| o.matches_within(range)))
        .map(|(group_index, _)| group_index)
        .collect()
}

/// The rebuild consumed every fully-clustered group, so shared-span marks from earlier partial
/// merges no longer point at a separate merged group. A copy counts the fragments it took over
/// itself, unless a group left in place still counts all of it: a larger clone whose matched
/// segments enclose those of the copy, which its fragments were nested in.
fn mark_enclosed_shared_occurrences(
    merged: &mut [CountedOccurrence],
    fully_clustered: &[usize],
    reported_groups: &[Vec<CountedOccurrence>],
) {
    for occurrence in merged {
        occurrence.shared_with_merged_group = reported_groups
            .iter()
            .enumerate()
            .filter(|(group_index, _)| !fully_clustered.contains(group_index))
            .flat_map(|(_, group)| group)
            .any(|counting| encloses_all_segments(counting, &occurrence.segments));
    }
}

fn encloses_all_segments(counting: &CountedOccurrence, segments: &[(usize, usize)]) -> bool {
    !counting.shared_with_merged_group
        && segments.iter().all(|&(start, end)| {
            counting
                .segments
                .iter()
                .any(|&(matched_start, matched_end)| matched_start <= start && end <= matched_end)
        })
}

/// One copy's fragments (an exact prefix and suffix split by a large edit) as one occurrence.
fn coalesce_occurrences(occurrences: Vec<CountedOccurrence>) -> CountedOccurrence {
    if occurrences.len() == 1 {
        return occurrences.into_iter().next().expect("non-empty");
    }
    // A partial gapped merge retains the leftover group with ALL its occurrences, so a copy's
    // fragments can arrive both standalone and embedded in a merged occurrence: union overlapping
    // segments so no token span is reported or counted twice.
    let segments = union_occurrence_segments(&occurrences);
    // An exact fragment is matched throughout, a near-miss part where its partners match it.
    let matched_runs = coalesced_matched_runs(&occurrences);
    let exact_runs: Vec<(usize, usize)> = occurrences
        .iter()
        .flat_map(|occurrence| match occurrence.matched_runs {
            Some(_) => &occurrence.exact_runs,
            None => &occurrence.segments,
        })
        .copied()
        .collect();
    CountedOccurrence {
        shared_with_merged_group: false,
        nested_in_larger_group: false,
        // Without a near-miss part, the segments are matched throughout and say it all.
        exact_runs: if matched_runs.is_some() {
            merge_overlapping_cores(&exact_runs)
        } else {
            Vec::new()
        },
        matched_runs,
        token_count: segments.iter().map(|segment| segment.1 - segment.0).sum(),
        start_token_index: occurrences
            .iter()
            .map(|o| o.start_token_index)
            .min()
            .unwrap_or(0),
        end_token_index: occurrences
            .iter()
            .map(|o| o.end_token_index)
            .max()
            .unwrap_or(0),
        start_line: occurrences.iter().map(|o| o.start_line).min().unwrap_or(0),
        end_line: occurrences.iter().map(|o| o.end_line).max().unwrap_or(0),
        segments,
    }
}

fn union_occurrence_segments(occurrences: &[CountedOccurrence]) -> Vec<(usize, usize)> {
    let mut sorted: Vec<(usize, usize)> = occurrences
        .iter()
        .flat_map(|occurrence| occurrence.segments.iter().copied())
        .collect();
    sorted.sort_by_key(|segment| *segment);
    let mut segments: Vec<(usize, usize)> = Vec::with_capacity(sorted.len());
    for segment in sorted {
        match segments.last_mut() {
            Some(last) if segment.0 < last.1 => last.1 = last.1.max(segment.1),
            _ => segments.push(segment),
        }
    }
    segments
}

fn coalesced_matched_runs(occurrences: &[CountedOccurrence]) -> Option<Vec<(usize, usize)>> {
    occurrences
        .iter()
        .any(|occurrence| occurrence.matched_runs.is_some())
        .then(|| {
            let runs: Vec<(usize, usize)> = occurrences
                .iter()
                .flat_map(|occurrence| {
                    occurrence
                        .matched_runs
                        .as_ref()
                        .unwrap_or(&occurrence.segments)
                        .iter()
                        .copied()
                })
                .collect();
            merge_overlapping_cores(&runs)
        })
}

/// The unions of overlapping cores, in position order.
fn merge_overlapping_cores(cores: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut sorted = cores.to_vec();
    sorted.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in sorted {
        match merged.last_mut() {
            Some(last) if start < last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}
