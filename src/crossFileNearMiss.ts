import { createLcsLengthCounter, type CountedOccurrence, type Token, type TokenRange } from './duplication.js';

/**
 * Cross-file near-miss (Type-3) clone detection, following the within-file detector's model (the
 * native collect_near_miss_groups): candidate block pairs are filtered through an n-gram inverted
 * index (NIL, Nakagawa et al. 2021), then verified by token-level longest common subsequence against
 * the larger block (NiCad's per-fragment similarity). Only pairs of blocks in different files are
 * compared: a same-file pair is the within-file detector's concern.
 */

export interface NearMissSourceFile {
  tokens?: Token[];
  nearMissBlocks?: TokenRange[];
}

/** A block the exact cross-file pipeline did not report, or one it did (an anchor). */
export interface NearMissOccurrence extends CountedOccurrence {
  fileIndex: number;
}

/** N-gram size of the candidate index (NIL's default). */
const ngramSize = 5;
/** Filtration threshold: shared distinct n-grams over the smaller block's (NIL's default). */
const filtrationPercent = 10;
/**
 * A structural match must also share content: more than this percent of the larger block's
 * content-bearing tokens (names and literal values), so blocks of the same shape that call
 * different APIs on different data are not clones.
 */
const minContentSimilarityPercent = 50;
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
  /** Identifiers as -(first-occurrence index + 1); other tokens as interned symbols (>= 0). */
  sequence: Int32Array;
  /** The sequence sorted, for the token-bag upper bound on the LCS. */
  sortedSequence: Int32Array;
  /** Content-bearing symbols (names and literal values) sorted, for the content gate. */
  sortedContent: Int32Array;
  /** Distinct non-stop n-gram hashes. */
  ngrams: Int32Array;
}

/**
 * Clusters verified cross-file near-miss pairs into groups. A block overlapping an occurrence of
 * `reportedSpansByFile` (the exact cross-file groups) is an anchor: it links near-miss copies to
 * the content an exact group already reports, and appears in the near-miss group marked
 * `spanCountedElsewhere` so block counting does not count its span twice. Pairs of two anchors are
 * skipped, and a group needs at least one non-anchor block.
 */
export function collectCrossFileNearMissGroups(
  files: NearMissSourceFile[],
  reportedSpansByFile: { startTokenIndex: number; endTokenIndex: number }[][],
  minSimilarityPercent: number
): NearMissOccurrence[][] {
  if (minSimilarityPercent >= 100) {
    return [];
  }
  const blocks = normalizeBlocks(files);
  const overlapsReportedSpan = reportedSpansByFile.map(createOverlapTest);
  const anchored = blocks.map(({ fileIndex, range }) => overlapsReportedSpan[fileIndex]?.(range) ?? false);
  const parent = blocks.map((_, index) => index);
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
  forEachCandidatePair(blocks, anchored, minSimilarityPercent, (left, right) => {
    if (isNearMissPair(blocks[left], blocks[right], minSimilarityPercent)) {
      const leftRoot = find(left);
      const rightRoot = find(right);
      parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
    }
  });

  const membersByRoot = new Map<number, number[]>();
  for (const index of blocks.keys()) {
    const root = find(index);
    const members = membersByRoot.get(root) ?? [];
    members.push(index);
    membersByRoot.set(root, members);
  }
  const groups: NearMissOccurrence[][] = [];
  for (const members of membersByRoot.values()) {
    // Components form only through cross-file pairs, so two members always span two files.
    if (members.length < 2 || members.every((index) => anchored[index])) {
      continue;
    }
    groups.push(
      members.flatMap((index) => {
        const block = blocks[index];
        return block ? [toOccurrence(block, anchored[index] ?? false)] : [];
      })
    );
  }
  return groups;
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

function toOccurrence({ fileIndex, range }: NormalizedBlock, anchor: boolean): NearMissOccurrence {
  return {
    fileIndex,
    spanCountedElsewhere: anchor || undefined,
    segments: [{ startTokenIndex: range.startTokenIndex, endTokenIndex: range.endTokenIndex }],
    tokenCount: range.endTokenIndex - range.startTokenIndex,
    startTokenIndex: range.startTokenIndex,
    endTokenIndex: range.endTokenIndex,
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    startLine: range.startLine,
    endLine: range.endLine,
  };
}

/**
 * Visits every cross-file block pair sharing at least `filtrationPercent` of the smaller block's
 * non-stop n-grams, except pairs of two anchors and pairs whose length ratio alone rules out the
 * similarity requirement (the LCS cannot exceed the shorter block). Blocks are indexed in ascending
 * length, so each posting list is scanned backwards only while its blocks are long enough; shared
 * counts accumulate in a dense counter, so no pair map is materialized.
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
    const minLeftLength = Math.ceil((minSimilarityPercent * (lengths[right] ?? 0)) / 100);
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
 * Verifies a filtered pair, cheapest bounds first. The LCS cannot exceed the shorter block's
 * length nor the token-bag overlap, so either bound falling below the similarity requirement
 * rejects the pair exactly without running the LCS.
 */
function isNearMissPair(
  left: NormalizedBlock | undefined,
  right: NormalizedBlock | undefined,
  minSimilarityPercent: number
): boolean {
  if (!left || !right) {
    return false;
  }
  const required = minSimilarityPercent * Math.max(left.sequence.length, right.sequence.length);
  if (Math.min(left.sequence.length, right.sequence.length) * 100 < required) {
    return false;
  }
  if (
    sortedOverlap(left.sortedContent, right.sortedContent) * 100 <=
    minContentSimilarityPercent * Math.max(left.sortedContent.length, right.sortedContent.length)
  ) {
    return false;
  }
  if (sortedOverlap(left.sortedSequence, right.sortedSequence) * 100 < required) {
    return false;
  }
  return createLcsLengthCounter(left.sequence)(right.sequence) * 100 >= required;
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
 * Normalizes every block like the within-file detector: identifiers are anonymized by first
 * occurrence within the block, and every other token keeps its text and literal value. Symbols are
 * interned project-wide from the tokens' hash pairs, so equal tokens compare equal across files.
 */
function normalizeBlocks(files: NearMissSourceFile[]): NormalizedBlock[] {
  const symbolByTokenKey = new Map<number, number>();
  const blocks: NormalizedBlock[] = [];
  for (const [fileIndex, { tokens, nearMissBlocks }] of files.entries()) {
    if (!tokens) {
      continue;
    }
    for (const range of nearMissBlocks ?? []) {
      const sequence = new Int32Array(range.endTokenIndex - range.startTokenIndex);
      const content: number[] = [];
      const indexByIdentifier = new Map<string, number>();
      for (let index = range.startTokenIndex; index < range.endTokenIndex; index += 1) {
        const token = tokens[index];
        if (!token) {
          continue;
        }
        if (token.kind === 'id') {
          let identifierIndex = indexByIdentifier.get(token.text);
          if (identifierIndex === undefined) {
            identifierIndex = indexByIdentifier.size;
            indexByIdentifier.set(token.text, identifierIndex);
          }
          sequence[index - range.startTokenIndex] = -(identifierIndex + 1);
          continue;
        }
        const key = tokenKey(token);
        let symbol = symbolByTokenKey.get(key);
        if (symbol === undefined) {
          symbol = symbolByTokenKey.size;
          symbolByTokenKey.set(key, symbol);
        }
        sequence[index - range.startTokenIndex] = symbol;
        if (token.isName || token.literalHash !== undefined) {
          content.push(symbol);
        }
      }
      blocks.push({
        fileIndex,
        range,
        sequence,
        sortedSequence: sequence.toSorted(),
        sortedContent: Int32Array.from(content).toSorted(),
        ngrams: collectNgrams(sequence),
      });
    }
  }
  return blocks;
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

function collectNgrams(sequence: Int32Array): Int32Array {
  const ngrams = new Set<number>();
  for (let start = 0; start + ngramSize <= sequence.length; start += 1) {
    let hash = 5381;
    for (let offset = 0; offset < ngramSize; offset += 1) {
      // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps the sum to int32 like the native n-gram hash.
      hash = (Math.imul(hash, 31) + (sequence[start + offset] ?? 0)) | 0;
    }
    ngrams.add(hash);
  }
  return Int32Array.from(ngrams);
}
