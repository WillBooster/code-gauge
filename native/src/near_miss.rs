use rustc_hash::{FxHashMap, FxHashSet};

/// N-gram size for the candidate index and local-match anchors (NIL's default); shared with
/// crossFileNearMiss.ts.
const NGRAM_SIZE: usize = 5;
/// Filtration threshold: shared distinct n-grams over the smaller set; shared with
/// crossFileNearMiss.ts.
pub(crate) const FILTRATION_PERCENT: usize = 10;
/// Pairs whose longer block exceeds this multiple of the shorter are compared only when whole-block
/// similarity still allows their ratio (below a minSimilarityPercent of 34). The candidate scan stops
/// at this floor while walking length-ordered postings, so pairs of very different lengths are
/// neither counted nor verified. Shared with crossFileNearMiss.ts.
pub(crate) const MAX_LENGTH_RATIO: usize = 3;
/// Exclusive bound on the information-weighted share of content-bearing tokens (names and literal
/// values); shared with crossFileNearMiss.ts.
const MIN_CONTENT_SIMILARITY_PERCENT: u64 = 50;
/// Caps content weights so only names and values spread over more than a quarter of the blocks
/// are discounted: a family of copies shares its content across several blocks, and uncapped
/// rarity weighting would let each copy's few unique edits outweigh everything the family shares.
/// Shared with crossFileNearMiss.ts.
const MAX_CONTENT_WEIGHT: u64 = 3;
/// Anchors must cover at least this percent of the shorter core: sparser chains are coincidental
/// runs of common n-grams in merely similar-looking code, and the cheap bound spares their content
/// and LCS checks. Not the similarity threshold itself, since n-grams repeated within a block
/// (repetitive statements) never anchor. Shared with crossFileNearMiss.ts.
const MIN_ANCHOR_COVERAGE_PERCENT: usize = 50;
/// Anchors farther apart than this (in either block) split a local match into separate chains;
/// shared with crossFileNearMiss.ts.
const MAX_ANCHOR_GAP_TOKENS: usize = 30;
/// Statement-order-insensitive comparison needs this many top-level statements per block.
const MIN_REORDER_STATEMENT_COUNT: usize = 2;
/// Every identifier in the identifier-blind sequences n-grams are hashed over.
const BLIND_IDENTIFIER: i32 = -1;

/// A near-miss block: a token range of one file's symbol stream, where symbols >= 0 are interned
/// non-identifier tokens (literal values folded in) and identifiers are -(file-level id + 1).
pub(crate) struct Block {
    pub start: usize,
    symbols: Vec<i32>,
    is_content: Vec<bool>,
    /// Identifiers anonymized by first occurrence within the block.
    sequence: Vec<i32>,
    pub ngrams: FxHashSet<i32>,
    /// The n-grams occurring exactly once in the block with their offsets, sorted by hash so two
    /// blocks' local-match anchors intersect by merging.
    unique_ngrams: Vec<(i32, usize)>,
    /// Content-bearing symbols (names and literal values) with their counts, sorted by symbol;
    /// Matcher::new turns the counts into information-weighted counts.
    content: Vec<(i32, u64)>,
    content_total: u64,
    /// The sequence with its top-level statements in canonical order, when it has enough of them
    /// for statement-order-insensitive comparison.
    canonical_sequence: Option<Vec<i32>>,
}

impl Block {
    pub fn new(
        symbols: &[i32],
        is_content: &[bool],
        start: usize,
        end: usize,
        statements: Vec<(usize, usize)>,
    ) -> Block {
        let symbols = symbols[start..end].to_vec();
        let is_content = is_content[start..end].to_vec();
        // Identifier-blind, so a block copied into different surroundings (renumbering its
        // identifiers) or with reordered statements still shares its n-grams.
        let ngram_hashes: Vec<i32> = symbols
            .windows(NGRAM_SIZE)
            .map(|window| {
                window.iter().fold(5381i32, |hash, &symbol| {
                    hash.wrapping_mul(31).wrapping_add(if symbol < 0 {
                        BLIND_IDENTIFIER
                    } else {
                        symbol
                    })
                })
            })
            .collect();
        let mut occurrence_counts: FxHashMap<i32, usize> = FxHashMap::default();
        for &hash in &ngram_hashes {
            *occurrence_counts.entry(hash).or_insert(0) += 1;
        }
        let mut unique_ngrams: Vec<(i32, usize)> = ngram_hashes
            .iter()
            .enumerate()
            .filter(|(_, hash)| occurrence_counts[hash] == 1)
            .map(|(offset, &hash)| (hash, offset))
            .collect();
        unique_ngrams.sort_unstable();
        let canonical_sequence = (statements.len() >= MIN_REORDER_STATEMENT_COUNT).then(|| {
            canonical_sequence(
                &symbols,
                statements.iter().map(|&(statement_start, statement_end)| {
                    (statement_start - start, statement_end - start)
                }),
            )
        });
        Block {
            start,
            sequence: anonymize(&symbols),
            ngrams: occurrence_counts.into_keys().collect(),
            unique_ngrams,
            content: count_content(&symbols, &is_content),
            content_total: 0,
            canonical_sequence,
            symbols,
            is_content,
        }
    }

    pub fn len(&self) -> usize {
        self.symbols.len()
    }
}

/// A verified core in each block of a pair, as absolute token ranges.
pub(crate) type CorePair = ((usize, usize), (usize, usize));

/// How a verified pair matched: whole blocks, or every anchored core pair (one per gap-split
/// chain segment) where the blocks share a copy embedded in different code.
pub(crate) enum PairMatch {
    Whole,
    Local(Vec<CorePair>),
}

/// Verifies near-miss block pairs: token-level LCS against the larger side (NiCad's per-fragment
/// similarity), backed by an information-weighted content gate, with a statement-order-insensitive
/// fallback and a local match over the anchored cores of two blocks.
pub(crate) struct Matcher {
    min_tokens: usize,
    min_similarity_percent: usize,
    /// Integer self-information per content symbol, 1 + floor(log2((N + 1) / df)) over N blocks,
    /// capped at MAX_CONTENT_WEIGHT.
    /// Rare names and values (the logic a copy preserves) outweigh ubiquitous ones, following
    /// the information-theoretic weighting of ECScan's essence-clone detection (2025).
    weights: FxHashMap<i32, u64>,
}

impl Matcher {
    /// Weights every block's content counts, which verification requires.
    pub fn new(blocks: &mut [Block], min_tokens: usize, min_similarity_percent: usize) -> Matcher {
        let mut document_frequencies: FxHashMap<i32, usize> = FxHashMap::default();
        for block in blocks.iter() {
            for &(symbol, _) in &block.content {
                *document_frequencies.entry(symbol).or_insert(0) += 1;
            }
        }
        let block_count = blocks.len();
        let self_information = |document_frequency: usize| {
            (((block_count + 1) / document_frequency).ilog2() as u64 + 1).min(MAX_CONTENT_WEIGHT)
        };
        let matcher = Matcher {
            min_tokens,
            min_similarity_percent,
            weights: document_frequencies
                .into_iter()
                .map(|(symbol, frequency)| (symbol, self_information(frequency)))
                .collect(),
        };
        for block in blocks.iter_mut() {
            block.content_total = matcher.weigh(&mut block.content);
        }
        matcher
    }

    /// Multiplies each count by its symbol's weight, returning the weighted total.
    fn weigh(&self, content: &mut [(i32, u64)]) -> u64 {
        for (symbol, count) in content.iter_mut() {
            // Span content comes from blocks, so every symbol has a weight.
            *count *= self.weights[symbol];
        }
        content.iter().map(|&(_, count)| count).sum()
    }

    pub fn verify(&self, left: &Block, right: &Block) -> Option<PairMatch> {
        let required = self.min_similarity_percent * left.len().max(right.len());
        if left.len().min(right.len()) * 100 >= required
            && shares_content(
                &left.content,
                left.content_total,
                &right.content,
                right.content_total,
            )
            && (lcs_length(&left.sequence, &right.sequence) * 100 >= required
                || self.matches_reordered(left, right, required))
        {
            return Some(PairMatch::Whole);
        }
        self.match_locally(left, right)
    }

    /// Compares the blocks with their top-level statements (each anonymized on its own) in a
    /// canonical order, so a copy whose independent statements were swapped still matches.
    fn matches_reordered(&self, left: &Block, right: &Block, required: usize) -> bool {
        match (&left.canonical_sequence, &right.canonical_sequence) {
            (Some(left), Some(right)) => lcs_length(left, right) * 100 >= required,
            _ => false,
        }
    }

    /// Matches the cores two blocks share inside different surroundings (a copy wrapped in added
    /// code, or two copies embedded in different code), which whole-block similarity misses
    /// (CCAligner's large-gap and LVMapper's large-variance clones). N-grams unique to each block
    /// anchor the alignment; their longest chain increasing in both blocks (a run filter keeps only
    /// anchors continuing a diagonal, but the chain may shift diagonals at small insertions), split
    /// at gaps, delimits the cores, and every core pair that is a near-miss clone in its own right
    /// is returned.
    fn match_locally(&self, left: &Block, right: &Block) -> Option<PairMatch> {
        let mut anchors: Vec<(usize, usize)> = Vec::new();
        let (mut left_index, mut right_index) = (0, 0);
        while let (Some(&(left_hash, left_offset)), Some(&(right_hash, right_offset))) = (
            left.unique_ngrams.get(left_index),
            right.unique_ngrams.get(right_index),
        ) {
            if left_hash == right_hash {
                anchors.push((left_offset, right_offset));
            }
            left_index += usize::from(left_hash <= right_hash);
            right_index += usize::from(right_hash <= left_hash);
        }
        anchors.sort_unstable();
        // An isolated 5-gram match is often coincidental (n-grams are identifier-blind); a copied
        // core yields runs of consecutive anchors, so only anchors continuing a diagonal run are
        // chained.
        let run_anchors: Vec<(usize, usize)> = (0..anchors.len())
            .filter(|&index| {
                let (left_offset, right_offset) = anchors[index];
                let continues = |neighbor: Option<&(usize, usize)>, step: isize| {
                    neighbor.is_some_and(|&(left, right)| {
                        left as isize == left_offset as isize + step
                            && right as isize == right_offset as isize + step
                    })
                };
                continues(
                    index
                        .checked_sub(1)
                        .and_then(|previous| anchors.get(previous)),
                    -1,
                ) || continues(anchors.get(index + 1), 1)
            })
            .map(|index| anchors[index])
            .collect();
        let chain = longest_increasing_chain(&run_anchors);
        let cores: Vec<CorePair> = chain_segments(&chain)
            .filter_map(|segment| {
                let (first, last) = (segment[0], segment[segment.len() - 1]);
                let (left_start, left_end) = (first.0, last.0 + NGRAM_SIZE);
                let (right_start, right_end) = (first.1, last.1 + NGRAM_SIZE);
                let (left_length, right_length) = (left_end - left_start, right_end - right_start);
                let shorter = left_length.min(right_length);
                let required = self.min_similarity_percent * left_length.max(right_length);
                let verified = shorter >= self.min_tokens
                    && shorter * 100 >= required
                    && anchored_token_count(segment) * 100 >= MIN_ANCHOR_COVERAGE_PERCENT * shorter
                    && self.spans_share_content(
                        left,
                        (left_start, left_end),
                        right,
                        (right_start, right_end),
                    )
                    && lcs_length(
                        &anonymize(&left.symbols[left_start..left_end]),
                        &anonymize(&right.symbols[right_start..right_end]),
                    ) * 100
                        >= required;
                verified.then_some((
                    (left.start + left_start, left.start + left_end),
                    (right.start + right_start, right.start + right_end),
                ))
            })
            .collect();
        (!cores.is_empty()).then_some(PairMatch::Local(cores))
    }

    fn spans_share_content(
        &self,
        left: &Block,
        (left_start, left_end): (usize, usize),
        right: &Block,
        (right_start, right_end): (usize, usize),
    ) -> bool {
        let mut left_content = count_content(
            &left.symbols[left_start..left_end],
            &left.is_content[left_start..left_end],
        );
        let mut right_content = count_content(
            &right.symbols[right_start..right_end],
            &right.is_content[right_start..right_end],
        );
        let left_total = self.weigh(&mut left_content);
        let right_total = self.weigh(&mut right_content);
        shares_content(&left_content, left_total, &right_content, right_total)
    }
}

/// A structural match must be backed by shared content: more than half of the larger side's
/// information-weighted names and literal values. Two sides without content never pass.
fn shares_content(
    left: &[(i32, u64)],
    left_total: u64,
    right: &[(i32, u64)],
    right_total: u64,
) -> bool {
    let mut overlap = 0;
    let (mut left_index, mut right_index) = (0, 0);
    while let (Some(&(left_symbol, left_count)), Some(&(right_symbol, right_count))) =
        (left.get(left_index), right.get(right_index))
    {
        if left_symbol == right_symbol {
            overlap += left_count.min(right_count);
        }
        left_index += usize::from(left_symbol <= right_symbol);
        right_index += usize::from(right_symbol <= left_symbol);
    }
    overlap * 100 > MIN_CONTENT_SIMILARITY_PERCENT * left_total.max(right_total)
}

/// Counts per content-bearing symbol, sorted by symbol.
fn count_content(symbols: &[i32], is_content: &[bool]) -> Vec<(i32, u64)> {
    let mut content: Vec<i32> = symbols
        .iter()
        .zip(is_content)
        .filter(|(_, &content)| content)
        .map(|(&symbol, _)| symbol)
        .collect();
    content.sort_unstable();
    let mut counts: Vec<(i32, u64)> = Vec::new();
    for symbol in content {
        match counts.last_mut() {
            Some((last, count)) if *last == symbol => *count += 1,
            _ => counts.push((symbol, 1)),
        }
    }
    counts
}

/// Left-block tokens the segment's anchors cover (overlapping anchors count once).
fn anchored_token_count(segment: &[(usize, usize)]) -> usize {
    segment
        .windows(2)
        .map(|pair| (pair[1].0 - pair[0].0).min(NGRAM_SIZE))
        .sum::<usize>()
        + NGRAM_SIZE
}

/// Identifiers renumbered by first occurrence within `symbols`, so a range compares the same
/// wherever it sits in its file.
fn anonymize(symbols: &[i32]) -> Vec<i32> {
    let mut index_by_identifier: FxHashMap<i32, i32> = FxHashMap::default();
    symbols
        .iter()
        .map(|&symbol| {
            if symbol >= 0 {
                return symbol;
            }
            let next_index = index_by_identifier.len() as i32;
            -(*index_by_identifier.entry(symbol).or_insert(next_index) + 1)
        })
        .collect()
}

/// The block's units (its top-level statements, as block-relative offsets, and the token runs
/// between them), each anonymized on its own and sorted, concatenated.
fn canonical_sequence(
    symbols: &[i32],
    statements: impl Iterator<Item = (usize, usize)>,
) -> Vec<i32> {
    let mut units: Vec<Vec<i32>> = Vec::new();
    let mut cursor = 0;
    for (start, end) in statements {
        if cursor < start {
            units.push(anonymize(&symbols[cursor..start]));
        }
        units.push(anonymize(&symbols[start..end]));
        cursor = end;
    }
    if cursor < symbols.len() {
        units.push(anonymize(&symbols[cursor..]));
    }
    units.sort_unstable();
    units.concat()
}

/// The longest chain of anchors increasing in both blocks (anchors arrive sorted by left offset),
/// via patience sorting over right offsets.
fn longest_increasing_chain(anchors: &[(usize, usize)]) -> Vec<(usize, usize)> {
    let mut tail_indexes: Vec<usize> = Vec::new();
    let mut predecessors: Vec<Option<usize>> = Vec::with_capacity(anchors.len());
    for (index, &(_, right_offset)) in anchors.iter().enumerate() {
        let position = tail_indexes.partition_point(|&tail| anchors[tail].1 < right_offset);
        predecessors.push(
            position
                .checked_sub(1)
                .map(|previous| tail_indexes[previous]),
        );
        if position == tail_indexes.len() {
            tail_indexes.push(index);
        } else {
            tail_indexes[position] = index;
        }
    }
    let mut chain = Vec::with_capacity(tail_indexes.len());
    let mut cursor = tail_indexes.last().copied();
    while let Some(index) = cursor {
        chain.push(anchors[index]);
        cursor = predecessors[index];
    }
    chain.reverse();
    chain
}

/// The chain's segments, split where consecutive anchors lie more than MAX_ANCHOR_GAP_TOKENS apart
/// in either block.
fn chain_segments(chain: &[(usize, usize)]) -> impl Iterator<Item = &[(usize, usize)]> {
    chain.chunk_by(|anchor, next| {
        next.0.saturating_sub(anchor.0 + NGRAM_SIZE) <= MAX_ANCHOR_GAP_TOKENS
            && next.1.saturating_sub(anchor.1 + NGRAM_SIZE) <= MAX_ANCHOR_GAP_TOKENS
    })
}

/// Longest-common-subsequence LENGTH via the Allison–Dix bit-parallel recurrence. Only the length
/// is needed and LCS length is algorithm-independent, so u64 words are safe even though the
/// TypeScript port in src/duplication.ts uses 32-bit words.
fn lcs_length(a: &[i32], b: &[i32]) -> usize {
    if a.is_empty() || b.is_empty() {
        return 0;
    }
    let word_count = a.len().div_ceil(64);
    let mut position_masks: FxHashMap<i32, Vec<u64>> = FxHashMap::default();
    for (index, &symbol) in a.iter().enumerate() {
        position_masks
            .entry(symbol)
            .or_insert_with(|| vec![0; word_count])[index / 64] |= 1u64 << (index % 64);
    }

    let mut v = vec![0u64; word_count];
    for symbol in b {
        let match_mask = position_masks.get(symbol);
        // `(v << 1) | 1` shifts a carry bit across words; subtraction borrows across words.
        let mut shift_carry = 1u64;
        let mut borrow = 0u64;
        for (word, slot) in v.iter_mut().enumerate() {
            let previous = *slot;
            let x = match_mask.map_or(0, |mask| mask[word]) | previous;
            let shifted = (previous << 1) | shift_carry;
            shift_carry = previous >> 63;
            let (partial, underflow1) = x.overflowing_sub(shifted);
            let (difference, underflow2) = partial.overflowing_sub(borrow);
            borrow = u64::from(underflow1 || underflow2);
            *slot = x & !difference;
        }
    }
    v.iter().map(|word| word.count_ones() as usize).sum()
}
