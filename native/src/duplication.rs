use indexmap::IndexMap;
use rustc_hash::{FxHashMap, FxHashSet};

use crate::near_miss_groups::{collect_near_miss_groups, select_near_miss_blocks};
pub use crate::tokenize::{hash_text, tokenize, TokenizedSource};
use crate::tokenize::{hash_text2, Token, TokenRange};
use crate::types::{
    CrossFileCandidate, CrossFileToken, CrossFileTokenRange, DuplicateBlockOccurrence,
    DuplicationMetrics,
};
use crate::util::to_int32;

// code-gauge-allow-file fileNcss -- exact candidate enumeration, maximal selection, and gap merging share candidate and occurrence types

const MIN_SEQUENCE_STATEMENT_COUNT: usize = 2;
const MAX_SEQUENCE_STATEMENT_COUNT: usize = 100;
const MAX_SELECTION_RERUN_COUNT: usize = 20;

/// Detection settings, defaulting to defaultDuplicationOptions in src/duplication.ts.
#[derive(Clone, Copy)]
pub struct DuplicationSettings {
    /// Minimum normalized token count for a region to be considered for duplication.
    pub min_tokens: usize,
    /// Maximum normalized-token gap between adjacent duplicate groups merged into one gapped clone.
    pub max_gap_tokens: usize,
    /// Minimum LCS similarity percent for near-miss (Type-3) clone blocks; 100 disables near-miss.
    pub min_similarity_percent: usize,
}

impl Default for DuplicationSettings {
    fn default() -> Self {
        DuplicationSettings {
            min_tokens: 40,
            max_gap_tokens: 30,
            min_similarity_percent: 70,
        }
    }
}

#[derive(Clone)]
struct DuplicateCandidate {
    fingerprint: std::rc::Rc<str>,
    token_count: usize,
    start_token_index: usize,
    end_token_index: usize,
    start_index: usize,
    end_index: usize,
    start_line: usize,
    end_line: usize,
    /// Set by select_maximal_duplicates on a copy lying inside a larger group's region: it is
    /// reported with its group, but its span is already counted by that larger group.
    nested_in_larger_group: bool,
}

/// Detects copy-pasted regions within a file. Fingerprints replicate the JavaScript int32 hash
/// arithmetic of fingerprintKey in duplication.ts, so its candidates group with the window
/// candidates cross-file matching fingerprints in TypeScript.
pub fn measure_duplication(
    source: &TokenizedSource<'_>,
    code_line_numbers: &FxHashSet<usize>,
    settings: &DuplicationSettings,
) -> DuplicationMetrics {
    let tokens = &source.tokens;
    let literal_count_prefix = &source.literal_count_prefix;
    let mut candidates = collect_block_candidates(
        tokens,
        literal_count_prefix,
        &source.structure.block_ranges,
        settings.min_tokens,
    );
    candidates.extend(collect_block_candidates(
        tokens,
        literal_count_prefix,
        &source.structure.split_try_body_ranges,
        settings.min_tokens,
    ));
    candidates.extend(collect_sequence_candidates(
        tokens,
        literal_count_prefix,
        &source.structure.container_statement_ranges,
        settings.min_tokens,
    ));
    let counted = select_maximal_duplicates(candidates);
    let mut groups = merge_adjacent_groups(to_counted_groups(&counted), settings.max_gap_tokens);
    let near_miss = collect_near_miss_groups(source, settings, &mut groups);
    // Near-miss clustering can merge exact groups away, leaving empty entries behind.
    groups.retain(|group| !group.is_empty());
    groups.extend(near_miss);
    summarize_duplicates(&groups, code_line_numbers, tokens)
}

/// Collects one file's contribution to cross-file clone detection: catalogued candidates (whole
/// block subtrees plus each statement container's full run), the normalized token stream and
/// statement structure, and the blocks near-miss comparison considers. Source indexes are emitted
/// in UTF-16 code units (the tree is parsed from UTF-16, so node byte offsets are halved) to match
/// JavaScript string indexes.
pub fn collect_cross_file_file_data(
    source: &TokenizedSource<'_>,
    min_tokens: usize,
) -> (
    Vec<CrossFileCandidate>,
    Vec<CrossFileToken>,
    Vec<Vec<CrossFileTokenRange>>,
    Vec<CrossFileTokenRange>,
) {
    let tokens = &source.tokens;
    let literal_count_prefix = &source.literal_count_prefix;
    let mut candidates = collect_block_candidates(
        tokens,
        literal_count_prefix,
        &source.structure.block_ranges,
        min_tokens,
    );
    // Single-statement containers are catalogued too: a file whose only top-level statement is not
    // a block type (a lone exported table) must still be matchable when wholly copied.
    for statements in &source.structure.container_statement_ranges {
        let (Some(first), Some(last)) = (statements.first(), statements.last()) else {
            continue;
        };
        if last.end_token_index - first.start_token_index >= min_tokens {
            candidates.push(sequence_candidate(
                tokens,
                literal_count_prefix,
                first,
                last,
            ));
        }
    }

    let candidate_payloads = dedupe_by_region(candidates)
        .into_iter()
        .map(|candidate| CrossFileCandidate {
            fingerprint: candidate.fingerprint.to_string(),
            token_count: candidate.token_count,
            start_token_index: candidate.start_token_index,
            end_token_index: candidate.end_token_index,
            start_index: candidate.start_index / 2,
            end_index: candidate.end_index / 2,
            start_line: candidate.start_line,
            end_line: candidate.end_line,
        })
        .collect();
    let token_payloads = tokens
        .iter()
        .map(|token| CrossFileToken {
            kind: if token.is_id { "id" } else { "text" },
            text: token.text.to_string(),
            text_hash: token.text_hash,
            text_hash2: token.text_hash2,
            literal_hash: token.literal_hash,
            literal_hash2: token.literal_hash2,
            is_name: token.is_name,
            start_row: token.start_row,
            end_row: token.end_row,
        })
        .collect();
    let container_statement_payloads = source
        .structure
        .container_statement_ranges
        .iter()
        .map(|statements| statements.iter().map(to_token_range_payload).collect())
        .collect();
    let near_miss_block_payloads = select_near_miss_blocks(source, min_tokens)
        .into_iter()
        .map(to_token_range_payload)
        .collect();
    (
        candidate_payloads,
        token_payloads,
        container_statement_payloads,
        near_miss_block_payloads,
    )
}

fn to_token_range_payload(range: &TokenRange) -> CrossFileTokenRange {
    CrossFileTokenRange {
        start_token_index: range.start_token_index,
        end_token_index: range.end_token_index,
        start_index: range.start_index / 2,
        end_index: range.end_index / 2,
        start_line: range.start_line,
        end_line: range.end_line,
    }
}

fn collect_block_candidates(
    tokens: &[Token<'_>],
    literal_count_prefix: &[usize],
    block_ranges: &[TokenRange],
    min_tokens: usize,
) -> Vec<DuplicateCandidate> {
    let mut candidates = Vec::new();
    for range in block_ranges {
        let token_count = range.end_token_index - range.start_token_index;
        if token_count < min_tokens {
            continue;
        }
        let fingerprint = format!(
            "b:{}",
            fingerprint_key(
                tokens,
                literal_count_prefix,
                range.start_token_index,
                range.end_token_index
            )
        );
        candidates.push(to_candidate(
            fingerprint,
            range.start_token_index,
            range.end_token_index,
            range,
            range,
        ));
    }
    candidates
}

struct WindowOccurrences {
    count: usize,
    /// usize::MAX once occurrences span more than one container (the TS port uses -1).
    container_index: usize,
    min_start: usize,
    max_start: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct SequenceWindow {
    container_index: usize,
    start: usize,
    length: usize,
}

struct ContainerWindows {
    /// window_keys_by_start[start][length] is the rolling-hash key, None below the size thresholds.
    window_keys_by_start: Vec<Vec<Option<i64>>>,
    /// Per-statement fingerprint hashes, for the distinct-shape requirement on windows.
    statement_hashes: Vec<i32>,
}

struct WindowCatalog {
    container_windows: Vec<ContainerWindows>,
    occurrences_by_key: FxHashMap<i64, WindowOccurrences>,
}

/// Enumerates runs of consecutive sibling statements; see collectSequenceWindowCandidates in
/// duplication.ts for the maximality and sub-window rules replicated here.
fn collect_sequence_candidates(
    tokens: &[Token<'_>],
    literal_count_prefix: &[usize],
    containers: &[Vec<TokenRange>],
    min_tokens: usize,
) -> Vec<DuplicateCandidate> {
    let catalog = WindowCatalog::new(tokens, containers, min_tokens);
    let maximal_windows = catalog.maximal_windows();
    // Every emitted window exposes its repeating, unvisited sub-windows; lengths strictly
    // decrease, so the worklist terminates.
    let mut visited: FxHashSet<SequenceWindow> = maximal_windows.iter().copied().collect();
    let mut frontier = maximal_windows;
    let mut candidates = Vec::new();
    while !frontier.is_empty() {
        let emitted = emit_frontier_windows(
            &frontier,
            containers,
            tokens,
            literal_count_prefix,
            &mut candidates,
        );
        frontier = enqueue_subwindows(&emitted, &catalog, &mut visited);
    }
    candidates
}

impl WindowCatalog {
    fn new(tokens: &[Token<'_>], containers: &[Vec<TokenRange>], min_tokens: usize) -> Self {
        let container_windows: Vec<ContainerWindows> = containers
            .iter()
            .map(|statements| enumerate_container_windows(tokens, statements, min_tokens))
            .collect();
        let occurrences_by_key = count_window_occurrences(&container_windows);
        Self {
            container_windows,
            occurrences_by_key,
        }
    }

    fn maximal_windows(&self) -> Vec<SequenceWindow> {
        let mut maximal = Vec::new();
        for (container_index, windows) in self.container_windows.iter().enumerate() {
            for (start, row) in windows.window_keys_by_start.iter().enumerate() {
                for (length, &window_key) in row.iter().enumerate() {
                    let window = SequenceWindow {
                        container_index,
                        start,
                        length,
                    };
                    if self.is_maximal(window, window_key) {
                        maximal.push(window);
                    }
                }
            }
        }
        maximal
    }

    fn is_maximal(&self, window: SequenceWindow, window_key: Option<i64>) -> bool {
        if !self.is_repeating_diverse(window, window_key) {
            return false;
        }
        // Dominated windows are skipped: the one-statement extension also repeats.
        let next_len = window.length + 1;
        let extended_right =
            self.window_key_at(window.container_index, Some(window.start), next_len);
        let extended_left = self.window_key_at(
            window.container_index,
            window.start.checked_sub(1),
            next_len,
        );
        !self.repeats(extended_right, next_len) && !self.repeats(extended_left, next_len)
    }

    fn is_repeating_diverse(&self, window: SequenceWindow, window_key: Option<i64>) -> bool {
        self.repeats(window_key, window.length) && self.has_distinct_statements(window)
    }

    /// A window only "repeats" when two of its occurrences can coexist without overlapping.
    fn repeats(&self, window_key: Option<i64>, length: usize) -> bool {
        let Some(window_key) = window_key else {
            return false;
        };
        self.occurrences_by_key
            .get(&window_key)
            .is_some_and(|occurrences| {
                occurrences.count >= 2
                    && (occurrences.container_index == usize::MAX
                        || occurrences.max_start - occurrences.min_start >= length)
            })
    }

    /// A window whose statements all share one normalized shape is a homogeneous preamble, not a
    /// copy-paste: two distinct per-statement shapes are required.
    fn has_distinct_statements(&self, window: SequenceWindow) -> bool {
        let hashes = self
            .container_windows
            .get(window.container_index)
            .map(|windows| windows.statement_hashes.as_slice())
            .unwrap_or(&[]);
        let first_hash = hashes.get(window.start);
        (window.start + 1..window.start + window.length)
            .any(|index| hashes.get(index) != first_hash)
    }

    fn window_key_at(
        &self,
        container_index: usize,
        start: Option<usize>,
        length: usize,
    ) -> Option<i64> {
        let start = start?;
        self.container_windows
            .get(container_index)?
            .window_keys_by_start
            .get(start)?
            .get(length)
            .copied()
            .flatten()
    }
}

fn enumerate_container_windows(
    tokens: &[Token<'_>],
    statements: &[TokenRange],
    min_tokens: usize,
) -> ContainerWindows {
    let statement_hashes: Vec<i32> = statements
        .iter()
        .map(|statement| {
            fingerprint_hash(
                tokens,
                statement.start_token_index,
                statement.end_token_index,
            )
        })
        .collect();
    let mut window_keys_by_start: Vec<Vec<Option<i64>>> = Vec::new();
    for start in 0..statements.len() {
        let mut row: Vec<Option<i64>> = Vec::new();
        let mut hash: i64 = 5381;
        let mut token_count: usize = 0;
        let max_end = statements.len().min(start + MAX_SEQUENCE_STATEMENT_COUNT);
        for end in start..max_end {
            let statement = &statements[end];
            hash = combine_hashes(hash, statement_hashes[end] as i64);
            token_count += statement.end_token_index - statement.start_token_index;
            let statement_count = end - start + 1;
            let key =
                if statement_count >= MIN_SEQUENCE_STATEMENT_COUNT && token_count >= min_tokens {
                    Some(combine_hashes(hash, statement_count as i64))
                } else {
                    None
                };
            if row.len() <= statement_count {
                row.resize(statement_count + 1, None);
            }
            row[statement_count] = key;
        }
        window_keys_by_start.push(row);
    }
    ContainerWindows {
        window_keys_by_start,
        statement_hashes,
    }
}

fn count_window_occurrences(
    container_windows: &[ContainerWindows],
) -> FxHashMap<i64, WindowOccurrences> {
    let mut occurrences_by_key: FxHashMap<i64, WindowOccurrences> = FxHashMap::default();
    for (container_index, windows) in container_windows.iter().enumerate() {
        for (start, row) in windows.window_keys_by_start.iter().enumerate() {
            for &window_key in row.iter().flatten() {
                record_window_occurrence(
                    &mut occurrences_by_key,
                    window_key,
                    container_index,
                    start,
                );
            }
        }
    }
    occurrences_by_key
}

fn record_window_occurrence(
    occurrences_by_key: &mut FxHashMap<i64, WindowOccurrences>,
    window_key: i64,
    container_index: usize,
    start: usize,
) {
    let Some(occurrences) = occurrences_by_key.get_mut(&window_key) else {
        occurrences_by_key.insert(
            window_key,
            WindowOccurrences {
                count: 1,
                container_index,
                min_start: start,
                max_start: start,
            },
        );
        return;
    };
    occurrences.count += 1;
    if occurrences.container_index != container_index {
        occurrences.container_index = usize::MAX;
    }
    occurrences.min_start = occurrences.min_start.min(start);
    occurrences.max_start = occurrences.max_start.max(start);
}

fn emit_frontier_windows(
    frontier: &[SequenceWindow],
    containers: &[Vec<TokenRange>],
    tokens: &[Token<'_>],
    literal_count_prefix: &[usize],
    candidates: &mut Vec<DuplicateCandidate>,
) -> Vec<SequenceWindow> {
    let mut emitted = Vec::new();
    for window in frontier {
        let statements = containers.get(window.container_index);
        let first = statements.and_then(|statements| statements.get(window.start));
        let last =
            statements.and_then(|statements| statements.get(window.start + window.length - 1));
        if let (Some(first), Some(last)) = (first, last) {
            candidates.push(sequence_candidate(
                tokens,
                literal_count_prefix,
                first,
                last,
            ));
            emitted.push(*window);
        }
    }
    emitted
}

fn enqueue_subwindows(
    emitted: &[SequenceWindow],
    catalog: &WindowCatalog,
    visited: &mut FxHashSet<SequenceWindow>,
) -> Vec<SequenceWindow> {
    let mut frontier = Vec::new();
    for window in emitted {
        for start in [window.start, window.start + 1] {
            let sub_window = SequenceWindow {
                container_index: window.container_index,
                start,
                length: window.length - 1,
            };
            let key = catalog.window_key_at(window.container_index, Some(start), sub_window.length);
            if !visited.contains(&sub_window) && catalog.is_repeating_diverse(sub_window, key) {
                visited.insert(sub_window);
                frontier.push(sub_window);
            }
        }
    }
    frontier
}

fn sequence_candidate(
    tokens: &[Token<'_>],
    literal_count_prefix: &[usize],
    first: &TokenRange,
    last: &TokenRange,
) -> DuplicateCandidate {
    let fingerprint = format!(
        "s:{}",
        fingerprint_key(
            tokens,
            literal_count_prefix,
            first.start_token_index,
            last.end_token_index
        )
    );
    to_candidate(
        fingerprint,
        first.start_token_index,
        last.end_token_index,
        first,
        last,
    )
}

fn to_candidate(
    fingerprint: String,
    start_token_index: usize,
    end_token_index: usize,
    first: &TokenRange,
    last: &TokenRange,
) -> DuplicateCandidate {
    DuplicateCandidate {
        fingerprint: fingerprint.into(),
        token_count: end_token_index - start_token_index,
        start_token_index,
        end_token_index,
        start_index: first.start_index,
        end_index: last.end_index,
        start_line: first.start_line,
        end_line: last.end_line,
        nested_in_larger_group: false,
    }
}

/// Content key of a token range; see fingerprintKey in duplication.ts for the format and rationale.
fn fingerprint_key(
    tokens: &[Token<'_>],
    literal_count_prefix: &[usize],
    start_token_index: usize,
    end_token_index: usize,
) -> String {
    let clamped_end = end_token_index.min(tokens.len());
    let literal_count = literal_count_prefix.get(clamped_end).copied().unwrap_or(0)
        - literal_count_prefix
            .get(start_token_index)
            .copied()
            .unwrap_or(0);
    let literal_dense = is_literal_dense(literal_count, end_token_index - start_token_index);
    let (primary, secondary) =
        fingerprint_hash_pair(tokens, start_token_index, end_token_index, literal_dense);
    format!(
        "{primary}:{secondary}:{}",
        end_token_index - start_token_index
    )
}

/// See isLiteralDense in duplication.ts: >= 20% literal values marks a region as data-like.
pub(crate) fn is_literal_dense(literal_count: usize, token_count: usize) -> bool {
    literal_count * 5 >= token_count
}

/// A single 32-bit summary of a range for the coarse rolling-hash phase. Deliberately
/// density-agnostic; see fingerprintHash in duplication.ts for the rationale.
fn fingerprint_hash(tokens: &[Token<'_>], start_token_index: usize, end_token_index: usize) -> i32 {
    let (primary, secondary) =
        fingerprint_hash_pair(tokens, start_token_index, end_token_index, false);
    primary ^ secondary.wrapping_mul(31)
}

/// Two independent 32-bit hashes over the normalized token sequence, replicating the JavaScript
/// int32 arithmetic of fingerprintHashPair in duplication.ts exactly.
fn fingerprint_hash_pair(
    tokens: &[Token<'_>],
    start_token_index: usize,
    end_token_index: usize,
    fold_literal_values: bool,
) -> (i32, i32) {
    let clamped_end = end_token_index.min(tokens.len());
    let mut index_by_identifier: FxHashMap<&str, usize> = FxHashMap::default();
    let mut index_hashes: Vec<(i32, i32)> = Vec::new();
    let mut primary: i32 = 5381;
    let mut secondary: i32 = 52_711;
    for token in &tokens[start_token_index..clamped_end] {
        // Each accumulator consumes its own independent per-token hash; see fingerprintHashPair
        // in duplication.ts.
        let (part, part2) = if token.is_id {
            let next_index = index_by_identifier.len();
            let identifier_index = *index_by_identifier.entry(token.text).or_insert(next_index);
            if identifier_index == index_hashes.len() {
                let name = format!("${identifier_index}");
                index_hashes.push((hash_text(&name), hash_text2(&name)));
            }
            index_hashes[identifier_index]
        } else {
            (token.text_hash, token.text_hash2)
        };
        primary = primary.wrapping_mul(31).wrapping_add(part);
        secondary = secondary.wrapping_mul(37) ^ part2;
        if fold_literal_values {
            if let (Some(literal_hash), Some(literal_hash2)) =
                (token.literal_hash, token.literal_hash2)
            {
                primary = primary.wrapping_mul(31).wrapping_add(literal_hash);
                secondary = secondary.wrapping_mul(37) ^ literal_hash2;
            }
        }
    }
    (primary, secondary)
}

/// `Math.imul(hash, 31) + value`: the sum is NOT wrapped to int32 in JS, so it stays i64 here.
fn combine_hashes(hash: i64, value: i64) -> i64 {
    (to_int32(hash).wrapping_mul(31)) as i64 + value
}

/// Keeps only maximal, non-overlapping duplicates; a port of selectMaximalGroups in
/// duplicateSelection.ts, which states the ranking, shedding, and nested-copy rules.
fn select_maximal_duplicates(
    candidates: Vec<DuplicateCandidate>,
) -> IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>> {
    let mut duplicates = rank_duplicate_candidates(candidates);
    // Greedy selection can keep a candidate whose group ends up below two survivors; the failed
    // groups are removed and the selection reruns: the largest one at a time, then all at once.
    let mut rerun = 0;
    loop {
        let (mut counted, blockers) = select_greedily(&duplicates);
        // No failed fingerprint means every counted group kept at least two survivors.
        let Some(largest_failed) = largest_failed_fingerprint(&counted, &blockers) else {
            return counted;
        };
        if rerun >= 2 * MAX_SELECTION_RERUN_COUNT {
            drop_failed_groups(&mut counted);
            return counted;
        }
        if rerun < MAX_SELECTION_RERUN_COUNT {
            duplicates.retain(|candidate| candidate.fingerprint != largest_failed);
        } else {
            duplicates.retain(|candidate| {
                counted
                    .get(&candidate.fingerprint)
                    .is_none_or(|group| group.len() >= 2)
            });
        }
        rerun += 1;
    }
}

fn rank_duplicate_candidates(candidates: Vec<DuplicateCandidate>) -> Vec<DuplicateCandidate> {
    let mut by_fingerprint: IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>> = IndexMap::new();
    for candidate in candidates {
        by_fingerprint
            .entry(candidate.fingerprint.clone())
            .or_default()
            .push(candidate);
    }
    let groups: Vec<Vec<DuplicateCandidate>> = by_fingerprint
        .into_values()
        .map(dedupe_by_region)
        .filter(|group| group.len() >= 2)
        .collect();
    // Greedy order ranks by total coverage (region size × copies).
    let group_size_by_fingerprint: FxHashMap<std::rc::Rc<str>, usize> = groups
        .iter()
        .map(|group| {
            (
                group
                    .first()
                    .map(|first| first.fingerprint.clone())
                    .unwrap_or_else(|| std::rc::Rc::from("")),
                group.len(),
            )
        })
        .collect();
    let mut duplicates: Vec<DuplicateCandidate> = groups.into_iter().flatten().collect();
    duplicates.sort_by_key(|candidate| {
        let copies = group_size_by_fingerprint
            .get(&candidate.fingerprint)
            .copied()
            .unwrap_or(1);
        std::cmp::Reverse(candidate.token_count * copies)
    });
    duplicates
}

/// Per fingerprint, the fingerprints of the kept regions that kept a candidate of it from being
/// selected.
type BlockersByFingerprint = FxHashMap<std::rc::Rc<str>, Vec<std::rc::Rc<str>>>;

fn largest_failed_fingerprint(
    counted: &IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>>,
    blockers: &BlockersByFingerprint,
) -> Option<std::rc::Rc<str>> {
    // A failed group that another failed group kept a copy from is not shed before it:
    // shedding the blocking group can rescue it, while shedding it frees nothing the other
    // waits for.
    let blocked_by_failed = |fingerprint: &std::rc::Rc<str>| {
        blockers.get(fingerprint).is_some_and(|blocking| {
            blocking.iter().any(|other| {
                other != fingerprint && counted.get(other).is_some_and(|group| group.len() < 2)
            })
        })
    };
    counted
        .iter()
        .filter(|(_, group)| group.len() < 2)
        // The first of the largest, as in selectMaximalGroups.
        .rev()
        .max_by_key(|(fingerprint, group)| {
            (
                !blocked_by_failed(fingerprint),
                group.first().map_or(0, |first| first.token_count),
            )
        })
        .map(|(fingerprint, _)| fingerprint.clone())
}

#[derive(Default)]
struct GreedySelection<'a> {
    /// Mutually non-overlapping, each with the fingerprint of the candidate occupying it.
    kept_regions: Vec<((usize, usize), std::rc::Rc<str>)>,
    counted: IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>>,
    nested: Vec<DuplicateCandidate>,
    left_over: Vec<&'a DuplicateCandidate>,
    blockers: BlockersByFingerprint,
}

enum RegionOverlap {
    DisjointOrEnclosing(Vec<usize>),
    Nested,
    PartiallyBlocked(Option<std::rc::Rc<str>>),
}

/// One greedy selection in ranking order, in two passes. The first keeps each candidate that
/// overlaps no kept region and lets a candidate a kept region contains join its group as a nested
/// copy. The second lets a candidate left over take the place of the kept copies it encloses,
/// which become nested copies of their groups, unless it partially overlaps a kept region: a
/// larger clone must not displace a clone of the first pass it merely overlaps. A candidate
/// lying inside a kept region in the end is a nested copy whenever its turn came. Groups left
/// without a standalone copy are dropped.
fn select_greedily(
    duplicates: &[DuplicateCandidate],
) -> (
    IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>>,
    BlockersByFingerprint,
) {
    let mut state = GreedySelection::default();
    for encloses in [false, true] {
        let candidates: Vec<&DuplicateCandidate> = if encloses {
            std::mem::take(&mut state.left_over)
        } else {
            duplicates.iter().collect()
        };
        for candidate in candidates {
            state.place(candidate, encloses);
        }
    }
    state.finish()
}

impl<'a> GreedySelection<'a> {
    fn place(&mut self, candidate: &'a DuplicateCandidate, encloses: bool) {
        let span = (candidate.start_index, candidate.end_index);
        match self.classify_overlap(span, encloses) {
            RegionOverlap::Nested => self.nested.push(DuplicateCandidate {
                nested_in_larger_group: true,
                ..candidate.clone()
            }),
            RegionOverlap::PartiallyBlocked(blocker) => {
                self.left_over.push(candidate);
                if let Some(blocker) = blocker {
                    self.blockers
                        .entry(candidate.fingerprint.clone())
                        .or_default()
                        .push(blocker);
                }
            }
            RegionOverlap::DisjointOrEnclosing(enclosed) => {
                self.demote_enclosed(&enclosed);
                self.kept_regions
                    .push((span, candidate.fingerprint.clone()));
                self.counted
                    .entry(candidate.fingerprint.clone())
                    .or_default()
                    .push(candidate.clone());
            }
        }
    }

    fn classify_overlap(&self, (start, end): (usize, usize), encloses: bool) -> RegionOverlap {
        let mut enclosed = Vec::new();
        for (index, &((region_start, region_end), ref blocker)) in
            self.kept_regions.iter().enumerate()
        {
            if region_start >= end || start >= region_end {
                continue;
            }
            if region_start <= start && end <= region_end {
                return RegionOverlap::Nested;
            }
            if encloses && start <= region_start && region_end <= end {
                enclosed.push(index);
            } else {
                return RegionOverlap::PartiallyBlocked(encloses.then(|| blocker.clone()));
            }
        }
        RegionOverlap::DisjointOrEnclosing(enclosed)
    }

    fn demote_enclosed(&mut self, enclosed: &[usize]) {
        // Descending, so that removing one keeps the indexes of the others.
        for &index in enclosed.iter().rev() {
            let (region, fingerprint) = self.kept_regions.remove(index);
            if let Some(inner) = self.counted.get_mut(&fingerprint).and_then(|group| {
                group
                    .iter_mut()
                    .find(|inner| (inner.start_index, inner.end_index) == region)
            }) {
                inner.nested_in_larger_group = true;
            }
        }
    }

    fn finish(
        mut self,
    ) -> (
        IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>>,
        BlockersByFingerprint,
    ) {
        // A candidate still left over overlapped a kept region partially when its turn came. Where
        // an enclosing candidate took that region since, the candidate lies inside a kept region now
        // and is a nested copy like one visited later.
        for candidate in self.left_over {
            let enclosed_now = self.kept_regions.iter().any(|&((start, end), _)| {
                start <= candidate.start_index && candidate.end_index <= end
            });
            if enclosed_now {
                self.nested.push(DuplicateCandidate {
                    nested_in_larger_group: true,
                    ..candidate.clone()
                });
            }
        }
        for candidate in self.nested {
            if let Some(group) = self.counted.get_mut(&candidate.fingerprint) {
                group.push(candidate);
            }
        }
        self.counted.retain(|_, group| {
            group
                .iter()
                .any(|candidate| !candidate.nested_in_larger_group)
        });
        (self.counted, self.blockers)
    }
}

/// Past the rerun caps: drops the groups below two copies without another selection pass, and
/// with them the nested copies left inside no standalone copy, until nothing changes; see
/// dropFailedGroups in duplicateSelection.ts.
fn drop_failed_groups(counted: &mut IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>>) {
    loop {
        let group_count = counted.len();
        counted.retain(|_, group| {
            group.len() >= 2
                && group
                    .iter()
                    .any(|candidate| !candidate.nested_in_larger_group)
        });
        let standalone: Vec<(usize, usize)> = counted
            .values()
            .flatten()
            .filter(|candidate| !candidate.nested_in_larger_group)
            .map(|candidate| (candidate.start_index, candidate.end_index))
            .collect();
        let mut changed = counted.len() != group_count;
        for group in counted.values_mut() {
            let copy_count = group.len();
            group.retain(|candidate| {
                !candidate.nested_in_larger_group
                    || standalone.iter().any(|&(start, end)| {
                        start <= candidate.start_index && candidate.end_index <= end
                    })
            });
            changed |= group.len() != copy_count;
        }
        if !changed {
            return;
        }
    }
}

/// Drops candidates covering the same source region (a block and the statement run spanning it).
fn dedupe_by_region(group: Vec<DuplicateCandidate>) -> Vec<DuplicateCandidate> {
    let mut by_region: IndexMap<(usize, usize), DuplicateCandidate> = IndexMap::new();
    for candidate in group {
        let key = (candidate.start_index, candidate.end_index);
        match by_region.get(&key) {
            Some(existing) if candidate.token_count <= existing.token_count => {}
            _ => {
                by_region.insert(key, candidate);
            }
        }
    }
    by_region.into_values().collect()
}

/// A contiguous run of matched tokens; gapped (merged) duplicates carry several per occurrence.
#[derive(Clone)]
pub(crate) struct CountedOccurrence {
    pub segments: Vec<(usize, usize)>,
    /// Set on an occurrence whose span another group counts, so block counting must not count it
    /// again: a retained group's occurrence that a partial gapped merge also paired into a merged
    /// group, and a near-miss anchor, which overlaps the reported occurrence it was matched through.
    pub shared_with_merged_group: bool,
    /// Set on a copy nested inside a larger group's region (it also sets
    /// `shared_with_merged_group`); see `nestedInLargerGroup` in duplication.ts.
    pub nested_in_larger_group: bool,
    /// The token runs of a near-miss copy that its partners match, within its segments;
    /// `None` for an exact or gapped copy, whose segments are matched throughout.
    pub matched_runs: Option<Vec<(usize, usize)>>,
    /// The exact fragments coalesced into a near-miss copy: each line they reach is duplicated,
    /// whatever else of the copy shares the line.
    pub exact_runs: Vec<(usize, usize)>,
    /// Sum of segment token counts (the gap tokens are not matched content).
    pub token_count: usize,
    pub start_token_index: usize,
    pub end_token_index: usize,
    pub start_line: usize,
    pub end_line: usize,
}

impl CountedOccurrence {
    /// Whether a matched segment overlaps the token range: the gap of a gapped clone is not
    /// matched content.
    pub fn matches_within(&self, (start, end): (usize, usize)) -> bool {
        self.segments
            .iter()
            .any(|&(segment_start, segment_end)| segment_start < end && start < segment_end)
    }
}

fn to_counted_groups(
    counted: &IndexMap<std::rc::Rc<str>, Vec<DuplicateCandidate>>,
) -> Vec<Vec<CountedOccurrence>> {
    let mut groups: Vec<Vec<CountedOccurrence>> = Vec::new();
    for group in counted.values() {
        let mut occurrences: Vec<CountedOccurrence> = group
            .iter()
            .map(|candidate| CountedOccurrence {
                shared_with_merged_group: candidate.nested_in_larger_group,
                nested_in_larger_group: candidate.nested_in_larger_group,
                matched_runs: None,
                exact_runs: Vec::new(),
                segments: vec![(candidate.start_token_index, candidate.end_token_index)],
                token_count: candidate.token_count,
                start_token_index: candidate.start_token_index,
                end_token_index: candidate.end_token_index,
                start_line: candidate.start_line,
                end_line: candidate.end_line,
            })
            .collect();
        occurrences
            .sort_by_key(|occurrence| (occurrence.start_token_index, occurrence.end_token_index));
        groups.push(occurrences);
    }
    groups
}

/// Merges duplicate groups separated by a small token gap into one gapped (Type-3) clone group;
/// see mergeAdjacentGroups in duplication.ts for the pairing, partial-merge (unequal
/// cardinalities: the fully-paired group is subsumed, the other is retained with all its
/// occurrences), nested-copy, and fixpoint/termination rules replicated here.
fn merge_adjacent_groups(
    mut groups: Vec<Vec<CountedOccurrence>>,
    max_gap_tokens: usize,
) -> Vec<Vec<CountedOccurrence>> {
    if max_gap_tokens == 0 || groups.len() < 2 {
        return groups;
    }
    groups.sort_by_key(|group| group_sort_key(group));
    while merge_one_adjacent_pair(&mut groups, max_gap_tokens) {
        groups.sort_by_key(|group| group_sort_key(group));
    }
    groups
}

fn merge_one_adjacent_pair(
    groups: &mut Vec<Vec<CountedOccurrence>>,
    max_gap_tokens: usize,
) -> bool {
    let partners_by_group = collect_gap_adjacent_partners(groups, max_gap_tokens);
    for (left_index, partners) in partners_by_group.iter().enumerate() {
        for &right_index in partners {
            if apply_group_merge(groups, left_index, right_index, max_gap_tokens) {
                return true;
            }
        }
    }
    false
}

fn apply_group_merge(
    groups: &mut Vec<Vec<CountedOccurrence>>,
    left_index: usize,
    right_index: usize,
    max_gap_tokens: usize,
) -> bool {
    let forward = merge_groups(&groups[left_index], &groups[right_index], max_gap_tokens);
    let swapped = forward.is_none();
    let result =
        forward.or_else(|| merge_groups(&groups[right_index], &groups[left_index], max_gap_tokens));
    let Some(result) = result else {
        return false;
    };
    let (left, right) = if swapped {
        (result.second, result.first)
    } else {
        (result.first, result.second)
    };
    // A group that stays keeps ALL its occurrences, so its paired occurrences now also live
    // inside the merged group's occurrences: mark them so duplicate_block_count counts each token
    // span once.
    for (group_index, side) in [(left_index, &left), (right_index, &right)] {
        if !side.replaced {
            for &occurrence_index in &side.paired_indexes {
                groups[group_index][occurrence_index].shared_with_merged_group = true;
            }
        }
    }
    match (left.replaced, right.replaced) {
        (true, true) => {
            groups[left_index] = result.merged;
            groups.remove(right_index);
        }
        (false, true) => groups[right_index] = result.merged,
        (true, false) => groups[left_index] = result.merged,
        (false, false) => groups.push(result.merged),
    }
    true
}

/// Per group index, the ascending indexes of later groups that merge_groups can pair with it;
/// see collectGapAdjacentPartners in duplication.ts.
fn collect_gap_adjacent_partners(
    groups: &[Vec<CountedOccurrence>],
    max_gap_tokens: usize,
) -> Vec<Vec<usize>> {
    let mut starts: Vec<(usize, usize)> = groups
        .iter()
        .enumerate()
        .flat_map(|(group_index, group)| {
            group
                .iter()
                .map(move |occurrence| (occurrence.start_token_index, group_index))
        })
        .collect();
    starts.sort_unstable();
    let mut partners: Vec<std::collections::BTreeSet<usize>> =
        vec![std::collections::BTreeSet::new(); groups.len()];
    for (group_index, group) in groups.iter().enumerate() {
        for occurrence in group {
            let first = starts.partition_point(|&(start, _)| start < occurrence.end_token_index);
            for &(start, other) in &starts[first..] {
                if start > occurrence.end_token_index + max_gap_tokens {
                    break;
                }
                if other != group_index {
                    partners[other.min(group_index)].insert(other.max(group_index));
                }
            }
        }
    }
    partners
        .into_iter()
        .map(|set| set.into_iter().collect())
        .collect()
}

pub(crate) fn group_sort_key(group: &[CountedOccurrence]) -> (usize, usize) {
    group
        .first()
        .map(|first| (first.start_token_index, first.end_token_index))
        .unwrap_or((0, 0))
}

struct MergeResult {
    merged: Vec<CountedOccurrence>,
    first: MergedSide,
    second: MergedSide,
}

struct MergedSide {
    /// Whether the merged group takes the input group's place: its standalone occurrences were
    /// all paired and it holds no nested copies that only it can report.
    replaced: bool,
    /// Indexes into the input group of the occurrences that were paired.
    paired_indexes: Vec<usize>,
}

/// Pairs `second` occurrences with gap-preceding `first` occurrences, greedily in source order;
/// a faithful port of mergeGroups in duplication.ts (at least two pairs, at least one group fully
/// paired, merged spans never overlap).
fn merge_groups(
    first: &[CountedOccurrence],
    second: &[CountedOccurrence],
    max_gap_tokens: usize,
) -> Option<MergeResult> {
    // Occurrences a previous partial merge already paired into a merged group must not pair
    // again: their spans already live inside that merged group, so re-pairing them would assemble
    // a second, competing merged group instead of letting the existing merged group extend (and
    // would count the same span twice). Consumption is still judged against the FULL group, so a
    // group holding shared occurrences is never subsumed away; nested copies, which the merged
    // span would not cover anyway, are left out of that judgment so they cannot veto a merge of
    // the standalone copies.
    let pairable = |group: &[CountedOccurrence]| -> Vec<usize> {
        (0..group.len())
            .filter(|&index| !group[index].shared_with_merged_group)
            .collect()
    };
    let standalone_count = |group: &[CountedOccurrence]| {
        group
            .iter()
            .filter(|occurrence| !occurrence.nested_in_larger_group)
            .count()
    };
    let (leadings, trailings) = (pairable(first), pairable(second));
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    let mut leading_position = 0usize;
    let mut previous_trailing_end: Option<usize> = None;
    for &trailing_index in &trailings {
        let trailing = &second[trailing_index];
        // Leadings ending too far before this trailing can never pair a later (even farther) one.
        while leading_position < leadings.len()
            && first[leadings[leading_position]].end_token_index + max_gap_tokens
                < trailing.start_token_index
        {
            leading_position += 1;
        }
        if let Some(&leading_index) = leadings.get(leading_position) {
            let leading = &first[leading_index];
            if leading.end_token_index <= trailing.start_token_index
                && previous_trailing_end.is_none_or(|end| leading.start_token_index >= end)
            {
                pairs.push((leading_index, trailing_index));
                previous_trailing_end = Some(trailing.end_token_index);
                leading_position += 1;
            }
        }
    }
    let first_fully_paired = pairs.len() == standalone_count(first);
    let second_fully_paired = pairs.len() == standalone_count(second);
    if pairs.len() < 2 || (!first_fully_paired && !second_fully_paired) {
        return None;
    }
    // A group holding nested copies stays even when all its standalone copies pair: the merged
    // group's content is larger than what those copies matched, so only the original group can
    // report the nested copies.
    let holds_no_nested_copy = |group: &[CountedOccurrence]| {
        group
            .iter()
            .all(|occurrence| !occurrence.nested_in_larger_group)
    };
    let merged = pairs
        .iter()
        .map(|&(leading_index, trailing_index)| {
            let leading = &first[leading_index];
            let trailing = &second[trailing_index];
            CountedOccurrence {
                // A merged occurrence is a fresh span combination; it inherits no shared marks.
                shared_with_merged_group: false,
                nested_in_larger_group: false,
                matched_runs: None,
                exact_runs: Vec::new(),
                segments: [leading.segments.clone(), trailing.segments.clone()].concat(),
                token_count: leading.token_count + trailing.token_count,
                start_token_index: leading.start_token_index,
                end_token_index: trailing.end_token_index,
                start_line: leading.start_line,
                end_line: trailing.end_line,
            }
        })
        .collect();
    Some(MergeResult {
        merged,
        first: MergedSide {
            replaced: first_fully_paired && holds_no_nested_copy(first),
            paired_indexes: pairs.iter().map(|&(leading, _)| leading).collect(),
        },
        second: MergedSide {
            replaced: second_fully_paired && holds_no_nested_copy(second),
            paired_indexes: pairs.iter().map(|&(_, trailing)| trailing).collect(),
        },
    })
}

fn summarize_duplicates(
    groups: &[Vec<CountedOccurrence>],
    code_line_numbers: &FxHashSet<usize>,
    tokens: &[Token<'_>],
) -> DuplicationMetrics {
    let mut duplicate_block_count = 0;
    let mut max_duplicate_block_size = 0;
    let mut duplicate_block_groups: Vec<Vec<DuplicateBlockOccurrence>> = Vec::new();
    let mut duplicated_lines: FxHashSet<usize> = FxHashSet::default();
    for group in groups {
        duplicate_block_count += count_redundant_fragments(group);
        let mut occurrences: Vec<DuplicateBlockOccurrence> = group
            .iter()
            .map(|occurrence| {
                max_duplicate_block_size = max_duplicate_block_size.max(occurrence.token_count);
                let lines = collect_matched_lines(occurrence, code_line_numbers, tokens);
                duplicated_lines.extend(&lines);
                let mut line_numbers: Vec<usize> = lines.into_iter().collect();
                line_numbers.sort_unstable();
                DuplicateBlockOccurrence {
                    start_line: occurrence.start_line,
                    end_line: occurrence.end_line,
                    line_numbers,
                    token_count: occurrence.token_count,
                }
            })
            .collect();
        occurrences.sort_by_key(|occurrence| occurrence.start_line);
        duplicate_block_groups.push(occurrences);
    }
    duplicate_block_groups
        .sort_by_key(|group| group.first().map(|first| first.start_line).unwrap_or(0));

    let mut duplicate_line_numbers: Vec<usize> = duplicated_lines.iter().copied().collect();
    duplicate_line_numbers.sort_unstable();

    DuplicationMetrics {
        duplicate_block_count,
        duplicate_block_group_count: groups.len(),
        duplicate_block_groups,
        duplicate_line_count: duplicated_lines.len(),
        duplicate_line_numbers,
        duplication_ratio: if code_line_numbers.is_empty() {
            0.0
        } else {
            duplicated_lines.len() as f64 / code_line_numbers.len() as f64
        },
        max_duplicate_block_size,
    }
}

/// Redundant copies one group adds to duplicate_block_count; a faithful port of
/// countRedundantFragments in duplication.ts. Fragment-weighted (merging must not halve
/// duplicate_block_count) with the largest occurrence deducted as the representative; occurrences a
/// partial gapped merge shared into a merged group are skipped — their spans are counted there,
/// and the merged group's representative already stands for the shared content — so no token span
/// contributes to the count twice.
fn count_redundant_fragments(group: &[CountedOccurrence]) -> usize {
    let mut fragment_count = 0;
    let mut max_fragment_count = 0;
    let mut has_shared_occurrence = false;
    for occurrence in group {
        if occurrence.shared_with_merged_group {
            has_shared_occurrence = true;
            continue;
        }
        fragment_count += occurrence.segments.len();
        max_fragment_count = max_fragment_count.max(occurrence.segments.len());
    }
    if has_shared_occurrence {
        fragment_count
    } else {
        fragment_count - max_fragment_count
    }
}

/// Only CODE lines carrying matched tokens count; the unmatched gap of a merged clone stays out
/// of line coverage. A line of a near-miss copy counts when its partners match more than half of
/// its tokens: a line the copy adds or rewrites is not duplicated, while a longest common
/// subsequence still pairs a stray token of it (a bracket, a separator) with one of the partner.
/// A line an exact fragment of the copy reaches counts in any case.
fn collect_matched_lines(
    occurrence: &CountedOccurrence,
    code_line_numbers: &FxHashSet<usize>,
    tokens: &[Token<'_>],
) -> FxHashSet<usize> {
    let mut token_counts_by_row: FxHashMap<usize, (usize, usize)> = FxHashMap::default();
    let mut runs = occurrence.matched_runs.iter().flatten().peekable();
    for &(segment_start, segment_end) in &occurrence.segments {
        let segment = tokens.iter().enumerate().take(segment_end);
        for (index, token) in segment.skip(segment_start) {
            while runs.next_if(|run| run.1 <= index).is_some() {}
            let matched =
                occurrence.matched_runs.is_none() || runs.peek().is_some_and(|run| run.0 <= index);
            for row in token.start_row..=token.end_row {
                let (matched_count, token_count) = token_counts_by_row.entry(row + 1).or_default();
                *matched_count += usize::from(matched);
                *token_count += 1;
            }
        }
    }
    let exact_rows: FxHashSet<usize> = occurrence
        .exact_runs
        .iter()
        .flat_map(|&(start, end)| &tokens[start..end])
        .flat_map(|token| token.start_row + 1..=token.end_row + 1)
        .collect();
    token_counts_by_row
        .into_iter()
        .filter(|(line, (matched_count, token_count))| {
            code_line_numbers.contains(line)
                && (matched_count * 2 > *token_count || exact_rows.contains(line))
        })
        .map(|(line, _)| line)
        .collect()
}
