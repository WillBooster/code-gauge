import type { DuplicationOptions } from './types.js';

/**
 * Project-level duplication machinery operating on normalized token streams. Tokenization itself
 * (parsing, identifier anonymization, literal normalization) happens in the Rust addon, which
 * serializes each file's Token stream and statement structure; the helpers here match statement
 * windows across files, merge gap-adjacent groups, and count duplicated lines over that data.
 */

export const defaultDuplicationOptions: Required<DuplicationOptions> = {
  minTokens: 40,
  maxGapTokens: 30,
  minSimilarityPercent: 70,
};

/**
 * Fills defaults for absent settings, applying the same normalization as the native boundary's
 * clampToU32 — NaN (e.g. `Number(unsetEnvVariable)`) counts as absent, and other values truncate
 * and clamp to [0, u32::MAX] — so the TypeScript half of cross-file matching cannot diverge from
 * the natively collected candidates on such input.
 */
export function resolveDuplicationOptions(options?: DuplicationOptions): Required<DuplicationOptions> {
  return {
    minTokens: resolveOption(options?.minTokens, defaultDuplicationOptions.minTokens),
    maxGapTokens: resolveOption(options?.maxGapTokens, defaultDuplicationOptions.maxGapTokens),
    minSimilarityPercent: resolveOption(options?.minSimilarityPercent, defaultDuplicationOptions.minSimilarityPercent),
  };
}

function resolveOption(value: number | undefined, fallback: number): number {
  return value === undefined || Number.isNaN(value)
    ? fallback
    : Math.min(Math.max(Math.trunc(value), 0), 0xFF_FF_FF_FF);
}

/** Minimum consecutive statements for a statement-sequence duplicate candidate. */
const minSequenceStatementCount = 2;
/**
 * Caps the window length so statement-sequence enumeration stays linear in the statement count.
 * Heterogeneous clones longer than the cap are reported as capped windows (a deliberate
 * conservative undercount trading completeness for bounded discovery cost).
 */
const maxSequenceStatementCount = 100;

/**
 * A region whose normalized tokens are at least 20% literal values is data-like (a lookup table, a
 * constant list, a value-mapping switch), not logic: literal values re-enter its fingerprint so
 * tables that merely share their shape stop counting as copy-paste. Compared in integer math
 * (5 * literals >= total) so the TypeScript and native sides cannot disagree on the boundary.
 */
function isLiteralDense(literalCount: number, tokenCount: number): boolean {
  return literalCount * 5 >= tokenCount;
}

export interface Token {
  /** Normalization target: identifiers to anonymize, literal kind tags, or the raw token text. */
  kind: 'id' | 'text';
  text: string;
  /**
   * Two INDEPENDENT hashes of `text` (djb2 and FNV-1a), precomputed so fingerprinting nested
   * regions never re-hashes a token. Feeding the same per-token hash to both fingerprint
   * accumulators would collapse the key to 32 effective bits: one djb2 collision between two
   * token texts would then equate whole regions.
   */
  textHash: number;
  textHash2: number;
  /** Hash pair of a value-carrying literal's value, folded into data-like region fingerprints. */
  literalHash?: number;
  literalHash2?: number;
  /**
   * True for verbatim-kept NAMES (member/callee/type names, named grammar leaves): together with
   * value-carrying literals these are the content-bearing tokens the near-miss content gate
   * counts. Keywords, operators, and punctuation come from unnamed nodes and stay false.
   */
  isName?: boolean;
  /** 0-based source rows the token occupies, so line coverage counts only matched-token lines. */
  startRow: number;
  endRow: number;
}

/** A token span with its source position; plain data so cross-file matching can retain it. */
export interface TokenRange {
  startTokenIndex: number;
  endTokenIndex: number;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

/** A contiguous run of matched tokens; gapped (merged) duplicates carry several per occurrence. */
interface TokenSegment {
  startTokenIndex: number;
  endTokenIndex: number;
}

interface DuplicateCandidate {
  fingerprint: string;
  tokenCount: number;
  startTokenIndex: number;
  endTokenIndex: number;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

export interface CountedOccurrence {
  /** Matched token runs; more than one once gapped groups are merged. */
  segments: TokenSegment[];
  /**
   * Set on occurrences whose span another reported group already counts: a retained group's
   * occurrences that a partial gapped merge also paired into a merged group, and cross-file copies
   * nested inside a larger group's region. Block counting must not count them again.
   */
  spanCountedElsewhere?: boolean;
  /**
   * Set on cross-file copies nested inside a larger group's region (they also set
   * `spanCountedElsewhere`). They never pair in gapped merging, and they do not keep their group's
   * standalone copies from merging, which they are not copies of. They do keep the merged group
   * from taking their group's place, since only the original group reports the nesting.
   */
  nestedInLargerGroup?: boolean;
  /** Sum of segment token counts (the gap tokens are not matched content). */
  tokenCount: number;
  startTokenIndex: number;
  endTokenIndex: number;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

/** A duplicate region found in one file, exported for cross-file matching by fingerprint. */
export interface CrossFileDuplicateCandidate {
  /** Content key: equal fingerprints mean equal normalized token sequences (up to hash collision). */
  fingerprint: string;
  tokenCount: number;
  /** Token positions within the owning file, for cross-file gapped (Type-3) merging. */
  startTokenIndex: number;
  endTokenIndex: number;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

/**
 * One file's contribution to cross-file clone detection: catalogued candidates plus the normalized
 * token stream and statement structure, so the project-level pass can match partial statement runs
 * (windows that a single file cannot know repeat elsewhere) and merge gap-adjacent groups.
 */
export interface CrossFileDuplicationFileData {
  candidates: CrossFileDuplicateCandidate[];
  tokens: Token[];
  containerStatements: TokenRange[][];
  /**
   * 1-based lines that are neither blank nor comment-only, so cross-file line coverage counts only
   * code lines (blank rows inside multi-row tokens such as template literals carry no content).
   * Optional for backward compatibility; without it, every matched-token row counts.
   */
  codeLineNumbers?: Set<number>;
}

/** literalCountPrefix[i] = value-carrying literal tokens in tokens[0..i), for O(1) density checks. */
export function buildLiteralCountPrefix(tokens: Token[]): Int32Array {
  const prefix = new Int32Array(tokens.length + 1);
  for (const [index, token] of tokens.entries()) {
    prefix[index + 1] = (prefix[index] ?? 0) + (token.literalHash === undefined ? 0 : 1);
  }
  return prefix;
}

interface WindowOccurrences {
  count: number;
  /** -1 once occurrences span more than one container. */
  containerIndex: number;
  /** -1 once occurrences span more than one context (file). */
  contextIndex: number;
  minStart: number;
  maxStart: number;
}

interface SequenceWindow {
  containerIndex: number;
  start: number;
  length: number;
}

/** One file's token stream and statement containers, as a window-matching context. */
export interface SequenceWindowContext {
  tokens: Token[];
  literalCountPrefix: Int32Array;
  containers: TokenRange[][];
}

export interface ContextualSequenceCandidate {
  candidate: DuplicateCandidate;
  contextIndex: number;
}

/**
 * Enumerates runs of consecutive sibling statements over one or more contexts (files). Every
 * container statement participates; only the window length is capped, so enumeration stays linear
 * in the statement count. Windows are grouped by a cheap rolling hash of per-statement
 * fingerprints, and only locally maximal repeated windows — those whose one-statement extensions
 * stop repeating — become candidates with an exact (window-consistent) fingerprint. Without the
 * maximality filter a degenerate file of near-identical statements would fingerprint every
 * sub-window of every repeated region. With `requireMultipleContexts` a window only counts as
 * repeated when its occurrences span at least two contexts (CPD-style cross-file matching): a
 * repeat confined to one file is that file's own concern, and emitting it here would flood the
 * project-level selection with unusable single-file groups.
 */
export function collectSequenceWindowCandidates(
  contexts: SequenceWindowContext[],
  minTokens: number,
  requireMultipleContexts: boolean
): ContextualSequenceCandidate[] {
  const candidates: ContextualSequenceCandidate[] = [];
  const contextIndexByContainer: number[] = [];
  const containers: TokenRange[][] = [];
  for (const [contextIndex, context] of contexts.entries()) {
    for (const statements of context.containers) {
      contextIndexByContainer.push(contextIndex);
      containers.push(statements);
    }
  }
  const contextAt = (containerIndex: number): SequenceWindowContext | undefined =>
    contexts[contextIndexByContainer[containerIndex] ?? 0];
  const occurrencesByWindowKey = new Map<number, WindowOccurrences>();
  const containerWindows = containers.map((statements, containerIndex) =>
    enumerateContainerWindows(contextAt(containerIndex)?.tokens ?? [], statements, minTokens)
  );
  for (const [containerIndex, windows] of containerWindows.entries()) {
    const contextIndex = contextIndexByContainer[containerIndex] ?? 0;
    for (const [start, row] of windows.windowKeysByStart.entries()) {
      for (const windowKey of row) {
        if (windowKey === undefined) {
          continue;
        }
        const occurrences = occurrencesByWindowKey.get(windowKey);
        if (occurrences) {
          occurrences.count += 1;
          if (occurrences.containerIndex !== containerIndex) {
            occurrences.containerIndex = -1;
          }
          if (occurrences.contextIndex !== contextIndex) {
            occurrences.contextIndex = -1;
          }
          occurrences.minStart = Math.min(occurrences.minStart, start);
          occurrences.maxStart = Math.max(occurrences.maxStart, start);
        } else {
          occurrencesByWindowKey.set(windowKey, {
            count: 1,
            containerIndex,
            contextIndex,
            minStart: start,
            maxStart: start,
          });
        }
      }
    }
  }

  // A window only "repeats" when two of its occurrences can coexist without overlapping: sliding
  // matches inside a homogeneous run (start spread smaller than the window length) can never both
  // be counted and must neither qualify a window nor dominate its sub-windows. Cross-context
  // matching instead requires occurrences in two contexts, which coexist by construction.
  const repeats = (windowKey: number | undefined, length: number): boolean => {
    if (windowKey === undefined) {
      return false;
    }
    const occurrences = occurrencesByWindowKey.get(windowKey);
    if (occurrences === undefined || occurrences.count < 2) {
      return false;
    }
    if (requireMultipleContexts) {
      return occurrences.contextIndex === -1;
    }
    return occurrences.containerIndex === -1 || occurrences.maxStart - occurrences.minStart >= length;
  };

  // A window whose statements all share one normalized shape (sixteen `let x = 0;` declarations,
  // a constant table) is a homogeneous preamble, not a copy-paste: requiring two distinct
  // per-statement shapes keeps such runs out of duplicate groups and the duplication ratio.
  const hasDistinctStatements = (window: SequenceWindow): boolean => {
    const hashes = containerWindows[window.containerIndex]?.statementHashes ?? [];
    const firstHash = hashes[window.start];
    for (let index = window.start + 1; index < window.start + window.length; index += 1) {
      if (hashes[index] !== firstHash) {
        return true;
      }
    }
    return false;
  };

  const maximalWindows: SequenceWindow[] = [];
  for (const [containerIndex, windows] of containerWindows.entries()) {
    for (const [start, row] of windows.windowKeysByStart.entries()) {
      for (const [length, windowKey] of row.entries()) {
        if (!repeats(windowKey, length) || !hasDistinctStatements({ containerIndex, start, length })) {
          continue;
        }
        // Dominated windows are skipped: the one-statement extension also repeats, so a larger
        // candidate covering this window exists.
        const extendedRight = windows.windowKeysByStart[start]?.[length + 1];
        const extendedLeft = windows.windowKeysByStart[start - 1]?.[length + 1];
        if (repeats(extendedRight, length + 1) || repeats(extendedLeft, length + 1)) {
          continue;
        }
        maximalWindows.push({ containerIndex, start, length });
      }
    }
  }

  // The rolling hash anonymizes identifiers per statement, so a window can look repeated coarsely
  // while its exact (window-consistent) fingerprints differ, and a longer window's match can
  // dominate sub-windows that other copies still need (three copies where only two extend one
  // statement further). Every emitted window therefore exposes its repeating, unvisited
  // sub-windows; `visited` bounds the worklist and lengths strictly decrease, so it terminates.
  const visited = new Set(maximalWindows.map(windowId));
  let frontier = maximalWindows;
  while (frontier.length > 0) {
    const emitted: SequenceWindow[] = [];
    for (const window of frontier) {
      const statements = containers[window.containerIndex];
      const first = statements?.[window.start];
      const last = statements?.[window.start + window.length - 1];
      const context = contextAt(window.containerIndex);
      if (!first || !last || !context) {
        continue;
      }
      const fingerprint = `s:${fingerprintKey(context.tokens, context.literalCountPrefix, first.startTokenIndex, last.endTokenIndex)}`;
      candidates.push({
        candidate: toCandidate(fingerprint, first.startTokenIndex, last.endTokenIndex, first, last),
        contextIndex: contextIndexByContainer[window.containerIndex] ?? 0,
      });
      emitted.push(window);
    }
    frontier = [];
    for (const window of emitted) {
      for (const start of [window.start, window.start + 1]) {
        const subWindow = { containerIndex: window.containerIndex, start, length: window.length - 1 };
        const subWindowKey = containerWindows[window.containerIndex]?.windowKeysByStart[start]?.[subWindow.length];
        if (
          visited.has(windowId(subWindow)) ||
          !repeats(subWindowKey, subWindow.length) ||
          !hasDistinctStatements(subWindow)
        ) {
          continue;
        }
        visited.add(windowId(subWindow));
        frontier.push(subWindow);
      }
    }
  }
  return candidates;
}

function windowId(window: SequenceWindow): string {
  return `${window.containerIndex}:${window.start}:${window.length}`;
}

interface ContainerWindows {
  /** windowKeysByStart[start][length] is the rolling-hash key of the window, or undefined if it is below the size thresholds. */
  windowKeysByStart: (number | undefined)[][];
  /** Per-statement fingerprint hashes, for the distinct-shape requirement on windows. */
  statementHashes: number[];
}

function enumerateContainerWindows(tokens: Token[], statements: TokenRange[], minTokens: number): ContainerWindows {
  const statementHashes = statements.map((statement) =>
    fingerprintHash(tokens, statement.startTokenIndex, statement.endTokenIndex)
  );
  const windowKeysByStart: (number | undefined)[][] = [];
  for (let start = 0; start < statements.length; start += 1) {
    const row: (number | undefined)[] = [];
    let hash = 5381;
    let tokenCount = 0;
    const maxEnd = Math.min(statements.length, start + maxSequenceStatementCount);
    for (let end = start; end < maxEnd; end += 1) {
      const statement = statements[end];
      const statementHash = statementHashes[end];
      if (!statement || statementHash === undefined) {
        break;
      }
      hash = combineHashes(hash, statementHash);
      tokenCount += statement.endTokenIndex - statement.startTokenIndex;
      const statementCount = end - start + 1;
      row[statementCount] =
        statementCount >= minSequenceStatementCount && tokenCount >= minTokens
          ? combineHashes(hash, statementCount)
          : undefined;
    }
    windowKeysByStart.push(row);
  }
  return { windowKeysByStart, statementHashes };
}

/**
 * Longest-common-subsequence LENGTH of two symbol sequences via the Allison–Dix bit-parallel
 * recurrence (O(|a|/32 · |b|) words): per symbol of `b`, `x = match | v` and
 * `v = x & ~(x - ((v << 1) | 1))` over multi-word bit vectors; the set bits of `v` count the LCS.
 */
export function lcsLength(a: Int32Array, b: Int32Array): number {
  const wordCount = (a.length + 31) >>> 5;
  const positionMasks = new Map<number, Uint32Array>();
  for (const [index, symbol] of a.entries()) {
    let mask = positionMasks.get(symbol);
    if (!mask) {
      mask = new Uint32Array(wordCount);
      positionMasks.set(symbol, mask);
    }
    const word = index >>> 5;
    // The Uint32Array store wraps the signed int32 bit pattern to unsigned. The `?? 0` guards in
    // this function are required by noUncheckedIndexedAccess (typed-array reads type as
    // `number | undefined`), not redundancy: every index is in bounds.
    mask[word] = (mask[word] ?? 0) | (1 << (index & 31));
  }

  const v = new Uint32Array(wordCount);
  for (const symbol of b) {
    const matchMask = positionMasks.get(symbol);
    // `(v << 1) | 1` shifts a carry bit across words; subtraction borrows across words.
    let shiftCarry = 1;
    let borrow = 0;
    for (let word = 0; word < wordCount; word += 1) {
      const previous = v[word] ?? 0;
      // oxlint-disable-next-line unicorn/prefer-math-trunc -- `>>> 0` reinterprets the signed int32 bit pattern as unsigned so the borrow subtraction below compares magnitudes; Math.trunc would keep it negative.
      const x = ((matchMask?.[word] ?? 0) | previous) >>> 0;
      // oxlint-disable-next-line unicorn/prefer-math-trunc -- same unsigned reinterpretation as `x`.
      const shifted = ((previous << 1) | shiftCarry) >>> 0;
      shiftCarry = previous >>> 31;
      const difference = x - shifted - borrow;
      borrow = difference < 0 ? 1 : 0;
      // The Uint32Array store wraps the signed int32 bit pattern to unsigned.
      v[word] = x & ~difference;
    }
  }

  let length = 0;
  for (const word of v) {
    length += popCount(word);
  }
  return length;
}

function popCount(value: number): number {
  let count = value - ((value >>> 1) & 0x55_55_55_55);
  count = (count & 0x33_33_33_33) + ((count >>> 2) & 0x33_33_33_33);
  return (Math.imul((count + (count >>> 4)) & 0x0F_0F_0F_0F, 0x01_01_01_01) >>> 24) & 0xFF;
}

function toCandidate(
  fingerprint: string,
  startTokenIndex: number,
  endTokenIndex: number,
  first: TokenRange,
  last: TokenRange
): DuplicateCandidate {
  return {
    fingerprint,
    tokenCount: endTokenIndex - startTokenIndex,
    startTokenIndex,
    endTokenIndex,
    startIndex: first.startIndex,
    endIndex: last.endIndex,
    startLine: first.startLine,
    endLine: last.endLine,
  };
}

/** Caches of hashText/hashText2 over '$0', '$1', ... so anonymized identifiers hash without allocating. */
const anonymizedIndexHashes: number[] = [];
const anonymizedIndexHashes2: number[] = [];

function anonymizedIndexHash(index: number): number {
  let hash = anonymizedIndexHashes[index];
  if (hash === undefined) {
    hash = hashText(`$${index}`);
    anonymizedIndexHashes[index] = hash;
  }
  return hash;
}

function anonymizedIndexHash2(index: number): number {
  let hash = anonymizedIndexHashes2[index];
  if (hash === undefined) {
    hash = hashText2(`$${index}`);
    anonymizedIndexHashes2[index] = hash;
  }
  return hash;
}

/**
 * Content key of a token range: two independent 32-bit hashes over the normalized token sequence
 * (identifiers anonymized consistently by first-occurrence order) plus the token count. Regions
 * with equal keys are treated as equal content; a collision would need both 32-bit hashes and the
 * length to coincide, which is negligible for a metrics report. The format and arithmetic match
 * fingerprint_key in native/src/duplication.rs exactly, so window candidates fingerprinted here
 * group together with the per-file candidates the addon catalogues.
 */
function fingerprintKey(
  tokens: Token[],
  literalCountPrefix: Int32Array,
  startTokenIndex: number,
  endTokenIndex: number
): string {
  const literalCount = (literalCountPrefix[endTokenIndex] ?? 0) - (literalCountPrefix[startTokenIndex] ?? 0);
  const literalDense = isLiteralDense(literalCount, endTokenIndex - startTokenIndex);
  const [primary, secondary] = fingerprintHashPair(tokens, startTokenIndex, endTokenIndex, literalDense);
  return `${primary}:${secondary}:${endTokenIndex - startTokenIndex}`;
}

/**
 * A single 32-bit summary of a range for the coarse rolling-hash phase. Deliberately
 * density-agnostic: density is a property of the final candidate REGION, and folding literal
 * values into per-statement hashes would make a dense statement inside a logic-heavy window
 * (`const weights = [1, 2, 3];`) block the window from ever being enumerated. The coarse phase
 * over-approximates on shape alone; the exact region fingerprint still applies the density rule.
 */
function fingerprintHash(tokens: Token[], startTokenIndex: number, endTokenIndex: number): number {
  const [primary, secondary] = fingerprintHashPair(tokens, startTokenIndex, endTokenIndex, false);
  // XOR already coerces to int32, matching the native side's i32 arithmetic.
  return primary ^ Math.imul(secondary, 31);
}

function fingerprintHashPair(
  tokens: Token[],
  startTokenIndex: number,
  endTokenIndex: number,
  foldLiteralValues: boolean
): [number, number] {
  const indexByIdentifier = new Map<string, number>();
  let primary = 5381;
  let secondary = 52_711;
  for (let index = startTokenIndex; index < endTokenIndex; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    // Each accumulator consumes its own independent per-token hash: sharing one would collapse
    // the key to 32 effective bits (a single djb2 collision would equate whole regions).
    let part: number;
    let part2: number;
    if (token.kind === 'id') {
      let identifierIndex = indexByIdentifier.get(token.text);
      if (identifierIndex === undefined) {
        identifierIndex = indexByIdentifier.size;
        indexByIdentifier.set(token.text, identifierIndex);
      }
      part = anonymizedIndexHash(identifierIndex);
      part2 = anonymizedIndexHash2(identifierIndex);
    } else {
      part = token.textHash;
      part2 = token.textHash2;
    }
    // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps the sum to int32 (Math.trunc does not), which must match the native side's wrapping i32 arithmetic.
    primary = (Math.imul(primary, 31) + part) | 0;
    secondary = Math.imul(secondary, 37) ^ part2;
    if (foldLiteralValues && token.literalHash !== undefined && token.literalHash2 !== undefined) {
      // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps the sum to int32 (Math.trunc does not), which must match the native side's wrapping i32 arithmetic.
      primary = (Math.imul(primary, 31) + token.literalHash) | 0;
      secondary = Math.imul(secondary, 37) ^ token.literalHash2;
    }
  }
  return [primary, secondary];
}

/** djb2-style hash; XOR keeps the value in signed 32-bit range, which is fine for a grouping key. */
function hashText(text: string): number {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- djb2 hashes UTF-16 code units; codePointAt would hash surrogate pairs twice (full code point, then the lone low surrogate).
    hash = Math.imul(hash, 33) ^ text.charCodeAt(index);
  }
  return hash;
}

/** FNV-1a over UTF-16 code units: independent of hashText so the two accumulators never share input. */
function hashText2(text: string): number {
  let hash = -2_128_831_035; // 2166136261 as int32 (the FNV-1a offset basis)
  for (let index = 0; index < text.length; index += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- hashes UTF-16 code units like hashText.
    hash = Math.imul(hash ^ text.charCodeAt(index), 16_777_619);
  }
  return hash;
}

function combineHashes(hash: number, value: number): number {
  return Math.imul(hash, 31) + value;
}

/**
 * Merges duplicate groups separated by a small token gap into one gapped (Type-3) clone group: a
 * copy edited in one spot splits into two exact groups whose occurrences sit side by side in the
 * same order. Occurrences are paired greedily in source order; a merge happens when the pairing
 * fully pairs at least one group with at least two pairs. Equal-cardinality groups whose
 * occurrences all pair merge into one group as before. When cardinalities differ (a fragment also
 * occurs standalone: prefix ×3, suffix ×2), the fully-paired group is subsumed into the merged
 * gapped group while the other group is RETAINED with ALL its occurrences: dropping the leftover
 * would lose duplicated-line coverage, and reporting it alone would make a single-occurrence group
 * (contradicting duplicateBlockGroupCount's "appears more than once" meaning). Line coverage
 * unions ranges, so the overlap between the retained exact group and the merged group is harmless.
 * Merging repeats to a fixpoint so a clone edited in several spots still reassembles; it
 * terminates because every merge marks its paired occurrences as counted elsewhere, and only
 * unmarked occurrences pair, so a given pair of occurrences merges at most once. Gap tokens are not matched
 * content: line coverage and sizes count only the matched segments. Generic so cross-file merging
 * can thread file identity through occurrences.
 */
export function mergeAdjacentGroups<T extends CountedOccurrence>(
  groups: T[][],
  maxGapTokens: number,
  isReportableGroup: (group: T[]) => boolean = () => true
): T[][] {
  if (maxGapTokens <= 0 || groups.length < 2) {
    return groups;
  }
  // Deterministic processing order (mirrored by the native side): by first occurrence position.
  groups.sort(compareGroups);
  for (let restart = true; restart;) {
    restart = false;
    for (let leftIndex = 0; leftIndex < groups.length && !restart; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
        const left = groups[leftIndex];
        const right = groups[rightIndex];
        if (!left || !right) {
          continue;
        }
        const forward = mergeGroups(left, right, maxGapTokens, isReportableGroup);
        const result = forward ?? mergeGroups(right, left, maxGapTokens, isReportableGroup);
        if (!result) {
          continue;
        }
        const leftReplaced = forward ? result.firstReplaced : result.secondReplaced;
        const rightReplaced = forward ? result.secondReplaced : result.firstReplaced;
        if (leftReplaced && rightReplaced) {
          groups[leftIndex] = result.merged;
          groups.splice(rightIndex, 1);
        } else if (rightReplaced) {
          groups[rightIndex] = result.merged;
        } else if (leftReplaced) {
          groups[leftIndex] = result.merged;
        } else {
          // Both groups stay (each is only partly paired, or reports nested copies of its own), so
          // the merged group joins them instead of taking a place.
          groups.push(result.merged);
        }
        // A group that stays keeps ALL its occurrences (line coverage must not shrink, and a
        // reported group must keep >= 2 occurrences), so its paired occurrences now also live
        // inside the merged group's occurrences: mark them so duplicateBlockCount counts each
        // token span once, and so the same pair cannot merge again.
        for (const occurrence of result.pairedRetained) {
          occurrence.spanCountedElsewhere = true;
        }
        groups.sort(compareGroups);
        restart = true;
        break;
      }
    }
  }
  return groups;
}

function compareGroups(left: CountedOccurrence[], right: CountedOccurrence[]): number {
  const leftFirst = left[0];
  const rightFirst = right[0];
  return (
    (leftFirst?.startTokenIndex ?? 0) - (rightFirst?.startTokenIndex ?? 0) ||
    (leftFirst?.endTokenIndex ?? 0) - (rightFirst?.endTokenIndex ?? 0)
  );
}

interface MergeResult<T> {
  merged: T[];
  /**
   * Whether the merged group takes the respective input group's place: its standalone occurrences
   * were all paired and it holds no nested copies that only it can report.
   */
  firstReplaced: boolean;
  secondReplaced: boolean;
  /** The occurrences of groups that stay, which the merged group's spans now also cover. */
  pairedRetained: T[];
}

/**
 * Pairs `second` occurrences with gap-preceding `first` occurrences, greedily in source order:
 * each trailing occurrence takes the earliest unused leading occurrence within the gap, and a
 * pair's leading must start at or after the previous pair's trailing end so merged spans never
 * overlap. A merge needs at least two pairs (a merged group must still mean "appears more than
 * once") and must fully consume at least one group; for equal cardinalities this reduces to the
 * strict all-pairs merge, so pre-partial-merge behavior is unchanged there.
 */
function mergeGroups<T extends CountedOccurrence>(
  first: T[],
  second: T[],
  maxGapTokens: number,
  isReportableGroup: (group: T[]) => boolean
): MergeResult<T> | undefined {
  // Occurrences a previous partial merge already paired into a merged group must not pair again:
  // their spans already live inside that merged group, so re-pairing them would assemble a second,
  // competing merged group instead of letting the existing merged group extend (and would count
  // the same span twice). Consumption is still judged against the FULL group, so a group holding
  // shared occurrences is never subsumed away; nested copies, which the merged span would not
  // cover anyway, are left out of that judgment so they cannot veto a merge of the standalone
  // copies.
  const [leadings, firstLength] = pairableOccurrences(first);
  const [trailings, secondLength] = pairableOccurrences(second);
  const pairs: [T, T][] = [];
  let leadingIndex = 0;
  let previousTrailingEnd = -1;
  for (const trailing of trailings) {
    // Leadings ending too far before this trailing can never pair a later (even farther) one.
    while (leadingIndex < leadings.length) {
      const leading = leadings[leadingIndex];
      if (leading && leading.endTokenIndex + maxGapTokens < trailing.startTokenIndex) {
        leadingIndex += 1;
      } else {
        break;
      }
    }
    const leading = leadings[leadingIndex];
    if (
      leading &&
      leading.endTokenIndex <= trailing.startTokenIndex &&
      leading.startTokenIndex >= previousTrailingEnd
    ) {
      pairs.push([leading, trailing]);
      previousTrailingEnd = trailing.endTokenIndex;
      leadingIndex += 1;
    }
  }
  const firstFullyPaired = pairs.length === firstLength;
  const secondFullyPaired = pairs.length === secondLength;
  if (pairs.length < 2 || (!firstFullyPaired && !secondFullyPaired)) {
    return undefined;
  }
  // A group holding nested copies stays even when all its standalone copies pair: the merged
  // group's content is larger than what those copies matched, so only the original group can
  // report which files share the matched fragment.
  const firstReplaced = firstFullyPaired && !first.some((occurrence) => occurrence.nestedInLargerGroup);
  const secondReplaced = secondFullyPaired && !second.some((occurrence) => occurrence.nestedInLargerGroup);
  const merged = pairs.map(([leading, trailing]) => ({
    ...leading,
    // A merged occurrence is a fresh span combination; it never inherits shared-span marks.
    spanCountedElsewhere: undefined,
    nestedInLargerGroup: undefined,
    segments: [...leading.segments, ...trailing.segments],
    tokenCount: leading.tokenCount + trailing.tokenCount,
    endTokenIndex: trailing.endTokenIndex,
    endIndex: trailing.endIndex,
    endLine: trailing.endLine,
  }));
  // Only occurrences of one file pair (file offsets exceed the gap), so a merged group spans the
  // files its pairs sit in: with nested copies left out of pairing, that can be fewer files than
  // the input groups covered, and a merged group that is no longer reportable must not form.
  if (!isReportableGroup(merged)) {
    return undefined;
  }
  const pairedRetained = [
    ...(firstReplaced ? [] : pairs.map(([leading]) => leading)),
    ...(secondReplaced ? [] : pairs.map(([, trailing]) => trailing)),
  ];
  return { merged, firstReplaced, secondReplaced, pairedRetained };
}

/** One pass over a group: its pairable occurrences and its non-nested occurrence count. */
function pairableOccurrences<T extends CountedOccurrence>(group: T[]): [T[], number] {
  const pairable: T[] = [];
  let length = 0;
  for (const occurrence of group) {
    if (!occurrence.nestedInLargerGroup) {
      length += 1;
    }
    if (!occurrence.spanCountedElsewhere) {
      pairable.push(occurrence);
    }
  }
  return [pairable, length];
}

/**
 * Redundant copies one group adds to duplicateBlockCount. Each redundant occurrence contributes
 * one count per matched fragment, so merging a gapped clone's fragments into one group does not
 * halve duplicateBlockCount: an edited two-fragment pair still counts 2, exactly as its unmerged
 * fragments did. Occurrence shapes can differ within one group (a
 * gap-merged exact pair plus an appended whole-block near-miss copy), so every occurrence's
 * fragments are summed and one representative — the largest — is deducted, keeping the count
 * independent of source order. Occurrences a partial gapped merge also paired into a merged group
 * are skipped: their spans are already counted there, and such a retained group deducts no
 * representative of its own — the merged group's representative already stands for the shared
 * content — so no token span contributes to the count twice.
 */
export function countRedundantFragments(group: CountedOccurrence[]): number {
  let fragmentCount = 0;
  let maxFragmentCount = 0;
  let hasSharedOccurrence = false;
  for (const occurrence of group) {
    if (occurrence.spanCountedElsewhere) {
      hasSharedOccurrence = true;
      continue;
    }
    fragmentCount += occurrence.segments.length;
    maxFragmentCount = Math.max(maxFragmentCount, occurrence.segments.length);
  }
  return hasSharedOccurrence ? fragmentCount : fragmentCount - maxFragmentCount;
}

/** Adds the 1-based code lines the segment's matched tokens cover; shared with cross-file coverage. */
export function collectSegmentLines(
  segment: { startTokenIndex: number; endTokenIndex: number },
  tokens: Token[],
  codeLineNumbers: Set<number> | undefined,
  duplicatedLines: Set<number>
): void {
  for (let index = segment.startTokenIndex; index < segment.endTokenIndex; index += 1) {
    const token = tokens[index];
    for (let row = token?.startRow ?? 0; row <= (token?.endRow ?? -1); row += 1) {
      if (!codeLineNumbers || codeLineNumbers.has(row + 1)) {
        duplicatedLines.add(row + 1);
      }
    }
  }
}
