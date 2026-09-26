import {
  createLcsLengthCounter,
  lcsLength,
  type CountedOccurrence,
  type Token,
  type TokenRange,
} from './duplication.js';

/**
 * Cross-file near-miss (Type-3) clone detection, following the within-file detector's model
 * (native/src/near_miss.rs): candidate block pairs are filtered through an n-gram inverted index
 * (NIL, Nakagawa et al. 2021), then verified by token-level longest common subsequence against the
 * larger block (NiCad's per-fragment similarity), backed by an information-weighted content gate,
 * with a statement-order-insensitive fallback and a local match over the anchored cores of two
 * blocks. Only pairs of blocks in different files are compared: a same-file pair is the
 * within-file detector's concern.
 */

export interface NearMissSourceFile {
  tokens?: Token[];
  containerStatements?: TokenRange[][];
  nearMissBlocks?: TokenRange[];
}

/** A block the exact cross-file pipeline did not report, or one it did (an anchor). */
export interface NearMissOccurrence extends CountedOccurrence {
  fileIndex: number;
}

/** N-gram size of the candidate index and local-match anchors (NIL's default). */
const ngramSize = 5;
/** Filtration threshold: shared distinct n-grams over the smaller block's (NIL's default). */
const filtrationPercent = 10;
/**
 * Pairs whose longer block exceeds this multiple of the shorter are compared only when whole-block
 * similarity still allows their ratio (below a minSimilarityPercent of 34). The candidate scan
 * stops at this floor while walking length-ordered postings, so pairs of very different lengths are
 * neither counted nor verified; `maxNgramBlockFrequency` is what bounds the scan's total cost.
 */
const maxLengthRatio = 3;
/**
 * A structural match must also share content: more than this percent of the larger side's
 * information-weighted content-bearing tokens (names and literal values), so blocks of the same
 * shape that call different APIs on different data are not clones.
 */
const minContentSimilarityPercent = 50;
/**
 * Caps content weights so only names and values spread over more than a quarter of the blocks are
 * discounted: a family of copies shares its content across several blocks, and uncapped rarity
 * weighting would let each copy's few unique edits outweigh everything the family shares.
 */
const maxContentWeight = 3;
/**
 * Anchors must cover at least this percent of the shorter core: sparser chains are coincidental
 * runs of common n-grams in merely similar-looking code, and the cheap bound spares their content
 * and LCS checks. Not the similarity threshold itself, since n-grams repeated within a block
 * (repetitive statements) never anchor.
 */
const minAnchorCoveragePercent = 50;
/** Anchors farther apart than this (in either block) split a local match into separate chains. */
const maxAnchorGapTokens = 30;
/** Statement-order-insensitive comparison needs this many top-level statements per block. */
const minReorderStatementCount = 2;
/**
 * N-grams occurring in more blocks than this are stop n-grams (syntax boilerplate such as a chain
 * of closing braces), left out of the index and of each block's n-gram count. Counting shared
 * n-grams costs the square of an n-gram's block frequency, so without the cap a project's most
 * common n-grams make filtration quadratic in the block count, while they discriminate nothing.
 */
const maxNgramBlockFrequency = 1000;

interface NormalizedBlock {
  fileIndex: number;
  range: TokenRange;
  /** Interned non-identifier symbols (>= 0) and identifiers as -(file-level id + 1). */
  symbols: Int32Array;
  isContent: Uint8Array;
  /** Identifiers anonymized by first occurrence within the block. */
  sequence: Int32Array;
  /** The sequence sorted, for the token-bag upper bound on the LCS. */
  sortedSequence: Int32Array;
  /** Distinct non-stop n-gram hashes. */
  ngrams: Int32Array;
  /**
   * The n-grams occurring exactly once in the block, sorted, with their offsets in the parallel
   * array: two blocks' local-match anchors intersect by merging.
   */
  uniqueNgrams: Int32Array;
  uniqueNgramOffsets: Int32Array;
  contentCounts: Map<number, number>;
  /**
   * The sequence with its top-level statements in canonical order, when it has enough of them for
   * statement-order-insensitive comparison.
   */
  canonicalSequence: Int32Array | undefined;
}

/** How a verified pair matched: whole blocks, or the anchored file-relative token cores. */
type PairMatch = { kind: 'whole' } | { kind: 'local'; left: [number, number]; right: [number, number] };

/**
 * Clusters verified cross-file near-miss pairs into groups. A block overlapping an occurrence of
 * `reportedSpansByFile` (the exact cross-file groups) is an anchor: it links near-miss copies to
 * the content an exact group already reports, and appears in the near-miss group marked
 * `spanCountedElsewhere` so block counting does not count its span twice. Pairs of two anchors are
 * skipped, and a group needs at least one non-anchor block. A block that matched only locally is
 * reported as its matched cores (overlapping cores merged), each clustered with its own partners,
 * so code no verified pair matched never counts as duplicated.
 */
export function collectCrossFileNearMissGroups(
  files: NearMissSourceFile[],
  reportedSpansByFile: { startTokenIndex: number; endTokenIndex: number }[][],
  minTokens: number,
  minSimilarityPercent: number
): NearMissOccurrence[][] {
  if (minSimilarityPercent >= 100) {
    return [];
  }
  const blocks = normalizeBlocks(files);
  const matcher = createMatcher(blocks, minTokens, minSimilarityPercent);
  const overlapsReportedSpan = reportedSpansByFile.map(createOverlapTest);
  const anchored = blocks.map(({ fileIndex, range }) => overlapsReportedSpan[fileIndex]?.(range) ?? false);
  const edges: [number, [number, number] | undefined, number, [number, number] | undefined][] = [];
  forEachCandidatePair(blocks, anchored, minSimilarityPercent, (left, right) => {
    const leftBlock = blocks[left];
    const rightBlock = blocks[right];
    const match = leftBlock && rightBlock && matcher(leftBlock, rightBlock, right);
    if (match) {
      edges.push(match.kind === 'whole' ? [left, undefined, right, undefined] : [left, match.left, right, match.right]);
    }
  });

  // Clustering runs over (block, core) nodes: a block that matched some partner whole is one node,
  // and otherwise each union of its overlapping local cores is its own node, so disjoint cores
  // matched with different partners fall into separate groups.
  const matchedWhole = blocks.map(() => false);
  const localCores = blocks.map((): [number, number][] => []);
  for (const [left, leftCore, right, rightCore] of edges) {
    for (const [index, core] of [
      [left, leftCore],
      [right, rightCore],
    ] as const) {
      if (core) {
        localCores[index]?.push(core);
      } else {
        matchedWhole[index] = true;
      }
    }
  }
  const nodes: { blockIndex: number; core: [number, number] | undefined }[] = [];
  const firstNodeByBlock: number[] = [];
  for (const blockIndex of blocks.keys()) {
    firstNodeByBlock.push(nodes.length);
    const cores = matchedWhole[blockIndex] ? [] : mergeOverlappingCores(localCores[blockIndex] ?? []);
    if (cores.length === 0) {
      nodes.push({ blockIndex, core: undefined });
    }
    for (const core of cores) {
      nodes.push({ blockIndex, core });
    }
  }
  const nodeOf = (blockIndex: number, core: [number, number] | undefined): number => {
    const first = firstNodeByBlock[blockIndex] ?? 0;
    if (!core || matchedWhole[blockIndex]) {
      return first;
    }
    for (let node = first; nodes[node]?.blockIndex === blockIndex; node += 1) {
      const span = nodes[node]?.core;
      if (span && span[0] <= core[0] && core[1] <= span[1]) {
        return node;
      }
    }
    throw new Error("every local core lies in one of its block's merged cores");
  };

  const parent = nodes.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root] ?? root;
    }
    for (let current = index; parent[current] !== root;) {
      const next = parent[current] ?? root;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  for (const [left, leftCore, right, rightCore] of edges) {
    const leftRoot = find(nodeOf(left, leftCore));
    const rightRoot = find(nodeOf(right, rightCore));
    parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  }

  const membersByRoot = new Map<number, number[]>();
  for (const node of nodes.keys()) {
    const root = find(node);
    const members = membersByRoot.get(root) ?? [];
    members.push(node);
    membersByRoot.set(root, members);
  }
  const groups: NearMissOccurrence[][] = [];
  for (const members of membersByRoot.values()) {
    // Components form only through cross-file pairs, so two members always span two files.
    if (members.length < 2 || members.every((node) => anchored[nodes[node]?.blockIndex ?? 0])) {
      continue;
    }
    groups.push(
      members.flatMap((node) => {
        const { blockIndex = 0, core } = nodes[node] ?? {};
        const block = blocks[blockIndex];
        return block ? [toOccurrence(block, files, core, anchored[blockIndex] ?? false)] : [];
      })
    );
  }
  return groups;
}

/** The unions of overlapping cores, in position order. */
function mergeOverlappingCores(cores: [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [start, end] of cores.toSorted((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && start < last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/**
 * Whether a range overlaps any of the spans: among the spans starting before the range ends
 * (binary search over sorted starts), the furthest end reaches past the range's start.
 */
function createOverlapTest(
  spans: { startTokenIndex: number; endTokenIndex: number }[]
): (range: { startTokenIndex: number; endTokenIndex: number }) => boolean {
  const sorted = spans.toSorted((left, right) => left.startTokenIndex - right.startTokenIndex);
  const maxEndPrefix = new Int32Array(sorted.length);
  let maxEnd = -1;
  for (const [index, span] of sorted.entries()) {
    maxEnd = Math.max(maxEnd, span.endTokenIndex);
    maxEndPrefix[index] = maxEnd;
  }
  return (range) => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((sorted[middle]?.startTokenIndex ?? 0) < range.endTokenIndex) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low > 0 && (maxEndPrefix[low - 1] ?? -1) > range.startTokenIndex;
  };
}

/**
 * The block's occurrence, narrowed to `core` when it matched only locally. Source offsets stay the
 * block's: tokens carry none, and near-miss occurrences report lines only.
 */
function toOccurrence(
  { fileIndex, range }: NormalizedBlock,
  files: NearMissSourceFile[],
  core: [number, number] | undefined,
  anchor: boolean
): NearMissOccurrence {
  const [start, end] = core ?? [range.startTokenIndex, range.endTokenIndex];
  const tokens = files[fileIndex]?.tokens;
  return {
    fileIndex,
    spanCountedElsewhere: anchor || undefined,
    segments: [{ startTokenIndex: start, endTokenIndex: end }],
    tokenCount: end - start,
    startTokenIndex: start,
    endTokenIndex: end,
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    startLine: core ? (tokens?.[start]?.startRow ?? 0) + 1 : range.startLine,
    endLine: core ? (tokens?.[end - 1]?.endRow ?? 0) + 1 : range.endLine,
  };
}

/**
 * Visits every cross-file block pair sharing at least `filtrationPercent` of the smaller block's
 * non-stop n-grams, except pairs of two anchors and pairs whose length ratio rules out both
 * whole-block similarity and `maxLengthRatio`. Blocks are
 * indexed in ascending length, so each posting list is scanned backwards only while its blocks
 * are long enough; shared counts accumulate in a dense counter, so no pair map is materialized.
 */
function forEachCandidatePair(
  blocks: NormalizedBlock[],
  anchored: boolean[],
  minSimilarityPercent: number,
  visit: (left: number, right: number) => void
): void {
  const blockFrequency = new Map<number, number>();
  for (const block of blocks) {
    for (const ngram of block.ngrams) {
      blockFrequency.set(ngram, (blockFrequency.get(ngram) ?? 0) + 1);
    }
  }
  for (const block of blocks) {
    block.ngrams = block.ngrams.filter((ngram) => (blockFrequency.get(ngram) ?? 0) <= maxNgramBlockFrequency);
  }

  // Typed copies keep the posting loop, which dominates this phase, free of object dereferences.
  const fileIndexes = Int32Array.from(blocks, (block) => block.fileIndex);
  const anchorFlags = Uint8Array.from(anchored, Number);
  const lengths = Int32Array.from(blocks, (block) => block.sequence.length);
  const ngramCounts = Int32Array.from(blocks, (block) => block.ngrams.length);
  const order = [...blocks.keys()].toSorted((left, right) => (lengths[left] ?? 0) - (lengths[right] ?? 0));
  const postings = new Map<number, number[]>();
  const sharedCounts = new Int32Array(blocks.length);
  const touched: number[] = [];
  for (const right of order) {
    const fileIndex = fileIndexes[right];
    const rightAnchored = anchorFlags[right] === 1;
    const minLeftLength = Math.min(
      Math.ceil((lengths[right] ?? 0) / maxLengthRatio),
      Math.ceil((minSimilarityPercent * (lengths[right] ?? 0)) / 100)
    );
    const ngrams = blocks[right]?.ngrams ?? [];
    for (const ngram of ngrams) {
      const posting = postings.get(ngram);
      if (!posting) {
        postings.set(ngram, [right]);
        continue;
      }
      for (let position = posting.length - 1; position >= 0; position -= 1) {
        const left = posting[position] ?? 0;
        if ((lengths[left] ?? 0) < minLeftLength) {
          break;
        }
        if (fileIndexes[left] === fileIndex || (rightAnchored && anchorFlags[left] === 1)) {
          continue;
        }
        if (sharedCounts[left] === 0) {
          touched.push(left);
        }
        sharedCounts[left] = (sharedCounts[left] ?? 0) + 1;
      }
      posting.push(right);
    }
    for (const left of touched) {
      const shared = sharedCounts[left] ?? 0;
      sharedCounts[left] = 0;
      if (shared * 100 >= filtrationPercent * Math.min(ngramCounts[left] ?? 0, ngrams.length)) {
        visit(left, right);
      }
    }
    touched.length = 0;
  }
}

/**
 * Returns the pair verifier. Content symbols are weighted by integer self-information,
 * 1 + floor(log2((N + 1) / df)) over N blocks capped at `maxContentWeight`, so rare names and
 * values (the logic a copy preserves) outweigh ubiquitous ones, following the
 * information-theoretic weighting of ECScan's essence-clone detection (2025).
 */
function createMatcher(
  blocks: NormalizedBlock[],
  minTokens: number,
  minSimilarityPercent: number
): (left: NormalizedBlock, right: NormalizedBlock, rightIndex: number) => PairMatch | undefined {
  const documentFrequencies = new Map<number, number>();
  for (const block of blocks) {
    for (const symbol of block.contentCounts.keys()) {
      documentFrequencies.set(symbol, (documentFrequencies.get(symbol) ?? 0) + 1);
    }
  }
  const selfInformation = (documentFrequency: number): number =>
    Math.min(31 - Math.clz32(Math.floor((blocks.length + 1) / documentFrequency)) + 1, maxContentWeight);
  const weights = new Map<number, number>();
  for (const [symbol, frequency] of documentFrequencies) {
    weights.set(symbol, selfInformation(frequency));
  }
  const weigh = (counts: Map<number, number>): WeightedContent => {
    const symbols = Int32Array.from(counts.keys()).toSorted();
    // Span content comes from blocks, so every symbol has a weight.
    const weightedCounts = Int32Array.from(symbols, (symbol) => (counts.get(symbol) ?? 0) * (weights.get(symbol) ?? 0));
    let total = 0;
    for (const count of weightedCounts) {
      total += count;
    }
    return { symbols, weightedCounts, total };
  };
  const blockContents = new Map(blocks.map((block) => [block, weigh(block.contentCounts)]));

  // Every candidate pair of one `right` block is visited consecutively, so one LCS counter (its
  // position masks built once) serves them all.
  let counterBlock = -1;
  let counter: ((sequence: Int32Array) => number) | undefined;
  const lcsLengthWithRight = (right: NormalizedBlock, rightIndex: number, sequence: Int32Array): number => {
    if (counterBlock !== rightIndex || !counter) {
      counterBlock = rightIndex;
      counter = createLcsLengthCounter(right.sequence);
    }
    return counter(sequence);
  };

  /**
   * Matches the cores two blocks share inside different surroundings (a copy wrapped in added
   * code, or two copies embedded in different code), which whole-block similarity misses
   * (CCAligner's large-gap and LVMapper's large-variance clones). N-grams unique to each block
   * anchor the alignment; their longest chain increasing in both blocks (a run filter keeps only
   * anchors continuing a diagonal, but the chain may shift diagonals at small insertions), split at
   * gaps, delimits the cores, which must then be near-miss clones of each other.
   */
  const matchLocally = (left: NormalizedBlock, right: NormalizedBlock): PairMatch | undefined => {
    const anchors: [number, number][] = [];
    for (
      let leftIndex = 0, rightIndex = 0;
      leftIndex < left.uniqueNgrams.length && rightIndex < right.uniqueNgrams.length;
    ) {
      const leftHash = left.uniqueNgrams[leftIndex] ?? 0;
      const rightHash = right.uniqueNgrams[rightIndex] ?? 0;
      if (leftHash === rightHash) {
        anchors.push([left.uniqueNgramOffsets[leftIndex] ?? 0, right.uniqueNgramOffsets[rightIndex] ?? 0]);
      }
      if (leftHash <= rightHash) {
        leftIndex += 1;
      }
      if (rightHash <= leftHash) {
        rightIndex += 1;
      }
    }
    anchors.sort((first, second) => first[0] - second[0]);
    // An isolated 5-gram match is often coincidental (n-grams are identifier-blind); a copied core
    // yields runs of consecutive anchors, so only anchors continuing a diagonal run are chained.
    const runAnchors = anchors.filter(([leftOffset, rightOffset], index) => {
      const previous = anchors[index - 1];
      const next = anchors[index + 1];
      return (
        (previous?.[0] === leftOffset - 1 && previous[1] === rightOffset - 1) ||
        (next?.[0] === leftOffset + 1 && next[1] === rightOffset + 1)
      );
    });
    const segment = densestChainSegment(longestIncreasingChain(runAnchors));
    if (!segment) {
      return undefined;
    }
    const [leftStart, rightStart] = segment[0] ?? [0, 0];
    const [leftLast, rightLast] = segment.at(-1) ?? [0, 0];
    const leftEnd = leftLast + ngramSize;
    const rightEnd = rightLast + ngramSize;
    const leftLength = leftEnd - leftStart;
    const rightLength = rightEnd - rightStart;
    const shorter = Math.min(leftLength, rightLength);
    const required = minSimilarityPercent * Math.max(leftLength, rightLength);
    if (
      shorter < minTokens ||
      shorter * 100 < required ||
      anchoredTokenCount(segment) * 100 < minAnchorCoveragePercent * shorter ||
      !sharesContent(
        weigh(countContent(left.symbols, left.isContent, leftStart, leftEnd)),
        weigh(countContent(right.symbols, right.isContent, rightStart, rightEnd))
      ) ||
      lcsLength(
        anonymize(left.symbols.subarray(leftStart, leftEnd)),
        anonymize(right.symbols.subarray(rightStart, rightEnd))
      ) *
        100 <
        required
    ) {
      return undefined;
    }
    const leftOffset = left.range.startTokenIndex;
    const rightOffset = right.range.startTokenIndex;
    return {
      kind: 'local',
      left: [leftOffset + leftStart, leftOffset + leftEnd],
      right: [rightOffset + rightStart, rightOffset + rightEnd],
    };
  };

  /** Cheapest bounds first: the LCS cannot exceed the shorter block's length nor the bag overlap. */
  return (left, right, rightIndex) => {
    const required = minSimilarityPercent * Math.max(left.sequence.length, right.sequence.length);
    if (
      Math.min(left.sequence.length, right.sequence.length) * 100 >= required &&
      sharesContent(blockContents.get(left), blockContents.get(right)) &&
      ((sortedOverlap(left.sortedSequence, right.sortedSequence) * 100 >= required &&
        lcsLengthWithRight(right, rightIndex, left.sequence) * 100 >= required) ||
        matchesReordered(left, right, required))
    ) {
      return { kind: 'whole' };
    }
    return matchLocally(left, right);
  };
}

/** Content-bearing symbols, sorted, with their information-weighted counts. */
interface WeightedContent {
  symbols: Int32Array;
  weightedCounts: Int32Array;
  total: number;
}

/**
 * A structural match must be backed by shared content: more than `minContentSimilarityPercent` of
 * the larger side's information-weighted names and literal values. Two sides without content never
 * pass.
 */
function sharesContent(left: WeightedContent | undefined, right: WeightedContent | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  let overlap = 0;
  for (let leftIndex = 0, rightIndex = 0; leftIndex < left.symbols.length && rightIndex < right.symbols.length;) {
    const leftSymbol = left.symbols[leftIndex] ?? 0;
    const rightSymbol = right.symbols[rightIndex] ?? 0;
    if (leftSymbol === rightSymbol) {
      overlap += Math.min(left.weightedCounts[leftIndex] ?? 0, right.weightedCounts[rightIndex] ?? 0);
    }
    if (leftSymbol <= rightSymbol) {
      leftIndex += 1;
    }
    if (rightSymbol <= leftSymbol) {
      rightIndex += 1;
    }
  }
  return overlap * 100 > minContentSimilarityPercent * Math.max(left.total, right.total);
}

/**
 * Compares the blocks with their top-level statements (each anonymized on its own) in a canonical
 * order, so a copy whose independent statements were swapped still matches.
 */
function matchesReordered(left: NormalizedBlock, right: NormalizedBlock, required: number): boolean {
  return (
    left.canonicalSequence !== undefined &&
    right.canonicalSequence !== undefined &&
    lcsLength(left.canonicalSequence, right.canonicalSequence) * 100 >= required
  );
}

/**
 * The block's units (its top-level statements, given in file token indexes, and the token runs
 * between them), each anonymized on its own and sorted, concatenated; undefined with too few
 * statements.
 */
function canonicalSequenceOf(
  symbols: Int32Array,
  statements: [number, number][],
  blockStart: number
): Int32Array | undefined {
  if (statements.length < minReorderStatementCount) {
    return undefined;
  }
  const units: Int32Array[] = [];
  let cursor = 0;
  for (const [statementStart, statementEnd] of statements) {
    const start = statementStart - blockStart;
    if (cursor < start) {
      units.push(anonymize(symbols.subarray(cursor, start)));
    }
    units.push(anonymize(symbols.subarray(start, statementEnd - blockStart)));
    cursor = statementEnd - blockStart;
  }
  if (cursor < symbols.length) {
    units.push(anonymize(symbols.subarray(cursor)));
  }
  units.sort(compareSequences);
  const canonical = new Int32Array(symbols.length);
  let offset = 0;
  for (const unit of units) {
    canonical.set(unit, offset);
    offset += unit.length;
  }
  return canonical;
}

/** Lexicographic order, matching Rust's Vec<i32> ordering. */
function compareSequences(left: Int32Array, right: Int32Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return left.length - right.length;
}

/**
 * The longest chain of anchors increasing in both blocks (anchors arrive sorted by left offset),
 * via patience sorting over right offsets.
 */
function longestIncreasingChain(anchors: [number, number][]): [number, number][] {
  const tailIndexes: number[] = [];
  const predecessors: number[] = [];
  for (const [index, [, rightOffset]] of anchors.entries()) {
    let low = 0;
    let high = tailIndexes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((anchors[tailIndexes[middle] ?? 0]?.[1] ?? 0) < rightOffset) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    predecessors.push(low > 0 ? (tailIndexes[low - 1] ?? -1) : -1);
    tailIndexes[low] = index;
  }
  const chain: [number, number][] = [];
  for (let cursor = tailIndexes.at(-1) ?? -1; cursor >= 0; cursor = predecessors[cursor] ?? -1) {
    const anchor = anchors[cursor];
    if (anchor) {
      chain.push(anchor);
    }
  }
  return chain.toReversed();
}

/**
 * The chain segment (split where consecutive anchors lie more than `maxAnchorGapTokens` apart in
 * either block) spanning the most left-block tokens; the earliest such segment wins ties.
 */
function densestChainSegment(chain: [number, number][]): [number, number][] | undefined {
  let best: [number, number][] | undefined;
  let segmentStart = 0;
  for (const [index, anchor] of chain.entries()) {
    const next = chain[index + 1];
    const breaksAfter =
      !next ||
      next[0] - (anchor[0] + ngramSize) > maxAnchorGapTokens ||
      next[1] - (anchor[1] + ngramSize) > maxAnchorGapTokens;
    if (!breaksAfter) {
      continue;
    }
    const segment = chain.slice(segmentStart, index + 1);
    if (!best || segmentSpan(segment) > segmentSpan(best)) {
      best = segment;
    }
    segmentStart = index + 1;
  }
  return best;
}

function segmentSpan(segment: [number, number][]): number {
  return (segment.at(-1)?.[0] ?? 0) - (segment[0]?.[0] ?? 0);
}

/** Left-block tokens the segment's anchors cover (overlapping anchors count once). */
function anchoredTokenCount(segment: [number, number][]): number {
  let count = ngramSize;
  for (let index = 1; index < segment.length; index += 1) {
    count += Math.min((segment[index]?.[0] ?? 0) - (segment[index - 1]?.[0] ?? 0), ngramSize);
  }
  return count;
}

/** Multiset intersection size of two ascending arrays. */
function sortedOverlap(left: Int32Array, right: Int32Array): number {
  let overlap = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftValue = left[leftIndex] ?? 0;
    const rightValue = right[rightIndex] ?? 0;
    if (leftValue === rightValue) {
      overlap += 1;
      leftIndex += 1;
      rightIndex += 1;
    } else if (leftValue < rightValue) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return overlap;
}

/**
 * Normalizes every block like the within-file detector. Non-identifier symbols are interned
 * project-wide from the tokens' hash pairs, so equal tokens compare equal across files, while
 * identifiers are interned per file and re-anonymized per compared range.
 */
function normalizeBlocks(files: NearMissSourceFile[]): NormalizedBlock[] {
  const symbolByTokenKey = new Map<number, number>();
  const blocks: NormalizedBlock[] = [];
  for (const [fileIndex, { tokens, containerStatements, nearMissBlocks }] of files.entries()) {
    if (!tokens || !nearMissBlocks?.length) {
      continue;
    }
    const symbols = new Int32Array(tokens.length);
    const isContent = new Uint8Array(tokens.length);
    const idByIdentifier = new Map<string, number>();
    for (const [index, token] of tokens.entries()) {
      if (token.kind === 'id') {
        let id = idByIdentifier.get(token.text);
        if (id === undefined) {
          id = idByIdentifier.size;
          idByIdentifier.set(token.text, id);
        }
        symbols[index] = -(id + 1);
        continue;
      }
      const key = tokenKey(token);
      let symbol = symbolByTokenKey.get(key);
      if (symbol === undefined) {
        symbol = symbolByTokenKey.size;
        symbolByTokenKey.set(key, symbol);
      }
      symbols[index] = symbol;
      isContent[index] = token.isName || token.literalHash !== undefined ? 1 : 0;
    }
    const findStatements = createTopLevelStatementFinder(containerStatements ?? []);
    for (const range of nearMissBlocks) {
      const { startTokenIndex: start, endTokenIndex: end } = range;
      const blockSymbols = symbols.subarray(start, end);
      const blockIsContent = isContent.subarray(start, end);
      const sequence = anonymize(blockSymbols);
      const ngramHashes = collectNgramHashes(blockSymbols);
      const occurrenceCounts = new Map<number, number>();
      for (const hash of ngramHashes) {
        occurrenceCounts.set(hash, (occurrenceCounts.get(hash) ?? 0) + 1);
      }
      const uniqueOffsets = ngramHashes
        .keys()
        .filter((offset) => occurrenceCounts.get(ngramHashes[offset] ?? 0) === 1)
        .toArray()
        .toSorted((first, second) => (ngramHashes[first] ?? 0) - (ngramHashes[second] ?? 0));
      blocks.push({
        fileIndex,
        range,
        symbols: blockSymbols,
        isContent: blockIsContent,
        sequence,
        sortedSequence: sequence.toSorted(),
        ngrams: Int32Array.from(occurrenceCounts.keys()),
        uniqueNgrams: Int32Array.from(uniqueOffsets, (offset) => ngramHashes[offset] ?? 0),
        uniqueNgramOffsets: Int32Array.from(uniqueOffsets),
        contentCounts: countContent(blockSymbols, blockIsContent, 0, blockSymbols.length),
        canonicalSequence: canonicalSequenceOf(blockSymbols, findStatements(start, end), start),
      });
    }
  }
  return blocks;
}

/**
 * Returns a lookup of the outermost container statements inside a token range, excluding a
 * statement spanning the whole range (the block itself).
 */
function createTopLevelStatementFinder(
  containerStatements: TokenRange[][]
): (start: number, end: number) => [number, number][] {
  const statements = containerStatements
    .flat()
    .filter((statement) => statement.startTokenIndex < statement.endTokenIndex)
    .map((statement): [number, number] => [statement.startTokenIndex, statement.endTokenIndex])
    .toSorted((left, right) => left[0] - right[0] || right[1] - left[1]);
  return (start, end) => {
    let low = 0;
    let high = statements.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((statements[middle]?.[0] ?? 0) < start) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    const topLevel: [number, number][] = [];
    for (let index = low; index < statements.length; index += 1) {
      const statement = statements[index];
      if (!statement || statement[0] >= end) {
        break;
      }
      const last = topLevel.at(-1);
      const nested = last !== undefined && statement[0] < last[1];
      if (statement[1] <= end && !(statement[0] === start && statement[1] === end) && !nested) {
        topLevel.push(statement);
      }
    }
    return topLevel;
  };
}

function countContent(symbols: Int32Array, isContent: Uint8Array, start: number, end: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (let offset = start; offset < end; offset += 1) {
    if (isContent[offset] === 1) {
      const symbol = symbols[offset] ?? 0;
      counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
  }
  return counts;
}

/** Identifiers renumbered by first occurrence within `symbols`, so a range compares the same wherever it sits in its file. */
function anonymize(symbols: Int32Array): Int32Array {
  const indexByIdentifier = new Map<number, number>();
  return symbols.map((symbol) => {
    if (symbol >= 0) {
      return symbol;
    }
    let index = indexByIdentifier.get(symbol);
    if (index === undefined) {
      index = indexByIdentifier.size;
      indexByIdentifier.set(symbol, index);
    }
    return -(index + 1);
  });
}

/**
 * A 53-bit key from the token's two independent text hashes, each mixed with the matching literal
 * value hash: exact in a JavaScript number, so interning never merges distinct tokens unless 53
 * hash bits collide.
 */
function tokenKey(token: Token): number {
  const primary = token.textHash ^ Math.imul(token.literalHash ?? 0, 0x9E_37_79_B1);
  const secondary = token.textHash2 ^ Math.imul(token.literalHash2 ?? 0, 0x85_EB_CA_6B);
  return (primary >>> 0) * 0x20_00_00 + (secondary >>> 11);
}

/**
 * N-gram hash per start offset, identifier-blind (every identifier hashes as -1) so a block copied
 * into different surroundings (renumbering its identifiers) or with reordered statements still
 * shares its n-grams.
 */
function collectNgramHashes(symbols: Int32Array): Int32Array {
  const hashes = new Int32Array(Math.max(symbols.length - ngramSize + 1, 0));
  for (let start = 0; start < hashes.length; start += 1) {
    let hash = 5381;
    for (let offset = 0; offset < ngramSize; offset += 1) {
      const symbol = symbols[start + offset] ?? 0;
      // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps the sum to int32 like the native n-gram hash.
      hash = (Math.imul(hash, 31) + (symbol < 0 ? -1 : symbol)) | 0;
    }
    hashes[start] = hash;
  }
  return hashes;
}
