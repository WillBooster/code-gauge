import { collectCrossFileNearMissGroups } from './crossFileNearMiss.js';
import { selectMaximalGroups, type SelectableRegion } from './duplicateSelection.js';
import {
  buildLiteralCountPrefix,
  collectMatchedLines,
  collectSequenceWindowCandidates,
  countRedundantFragments,
  mergeAdjacentGroups,
  resolveDuplicationOptions,
  type CountedOccurrence,
  type CrossFileDuplicateCandidate,
  type CrossFileDuplicationFileData,
  type SequenceWindowContext,
  type TokenSegment,
} from './duplication.js';
import type { DuplicationOptions } from './types.js';

export interface CrossFileDuplicationSourceFile extends Partial<CrossFileDuplicationFileData> {
  file: string;
  candidates: CrossFileDuplicateCandidate[];
}

export interface CrossFileDuplicateOccurrence {
  endLine: number;
  file: string;
  /**
   * The code lines carrying the occurrence's matched tokens (see
   * DuplicateBlockOccurrence.lineNumbers). Absent for a file that supplied only candidates (no
   * `tokens`), whose matched lines are unknowable.
   */
  lineNumbers?: number[];
  startLine: number;
  /**
   * The tokens of its matched runs, or of a near-miss block or its matched cores with the edited
   * tokens among them; the group's `tokenCount` is the smallest of its occurrences'.
   */
  tokenCount: number;
}

export interface CrossFileDuplicateBlockGroup {
  files: string[];
  occurrences: CrossFileDuplicateOccurrence[];
  /**
   * Token count of the smallest occurrence. For exact and gapped groups it is the matched token
   * count every occurrence shares (gaps are not counted); for near-miss (Type-3) groups it is the
   * token count of the smallest whole block or set of matched cores, edited tokens included.
   */
  tokenCount: number;
}

export interface CrossFileDuplicationMetrics {
  /** Number of redundant copies across all groups, counted per matched fragment like within-file. */
  duplicateBlockCount: number;
  /** Groups the file participates in, keyed by the file name passed in. */
  duplicateBlockGroupCountByFile: Record<string, number>;
  /**
   * Per file, the 1-based code lines covered by the tokens of its cross-file occurrences, sorted
   * ascending: the matched tokens of exact and gapped occurrences, and the lines of a near-miss
   * block or its matched cores more than half of whose tokens its partners match (like within-file
   * near-miss coverage). The unmatched gap of a merged
   * clone and comment/blank lines inside an occurrence's bounding range are excluded (blank rows
   * inside multi-row tokens only when the file supplied codeLineNumbers). A file that supplied
   * only candidates (no `tokens`) has no entry — without its token stream the covered lines are
   * unknowable, and an approximate bounding range would break this field's exactness.
   */
  duplicateLineNumbersByFile: Record<string, number[]>;
  groups: CrossFileDuplicateBlockGroup[];
}

interface SelectableCandidate extends CrossFileDuplicateCandidate, SelectableRegion {
  regionBucket: number;
  file: string;
}

/** A cross-file occurrence: a within-file occurrence in the project-wide token index space. */
interface CrossFileOccurrence extends CountedOccurrence {
  file: string;
  fileIndex: number;
}

/**
 * Detects code regions duplicated across files. Per-file candidates (whole block subtrees and full
 * container runs, fingerprinted with the same normalization as within-file duplication) are joined
 * by a project-level window index over per-statement fingerprint sequences (CPD-style), so a
 * copy-pasted partial statement run embedded in different surrounding code is matched even though
 * no single file can know it repeats elsewhere. Candidates are grouped by fingerprint, and only
 * maximal, non-overlapping regions whose group spans at least two files are counted. Groups that
 * shrink to a single file during selection are shed — a within-file repeat is already reported by
 * that file's own duplication metrics. A copy nested inside a larger group's region (two files share
 * a whole function, a third file only a block of it) is reported with its group, so the third
 * file's copy still shows what it duplicates. Groups separated by a small token gap within each file then
 * merge into gapped (Type-3) clone groups under `maxGapTokens`, exactly like within-file merging.
 * Finally, blocks of files that supplied `nearMissBlocks` are compared across files for near-miss
 * (Type-3) clones under `minSimilarityPercent` (see crossFileNearMiss.ts).
 */
export function measureCrossFileDuplication(
  files: CrossFileDuplicationSourceFile[],
  options?: DuplicationOptions
): CrossFileDuplicationMetrics {
  const { minTokens, maxGapTokens, minSimilarityPercent } = resolveDuplicationOptions(options);
  const candidates: SelectableCandidate[] = files.flatMap(({ file, candidates }, fileIndex) =>
    candidates.map((candidate) => ({ ...candidate, regionBucket: fileIndex, file }))
  );
  // Pushed one by one: spreading the project-scale window-candidate array as call arguments
  // overflows V8's argument limit (~124k) and crashes on Node, though Bun/JSC tolerates it.
  for (const candidate of collectWindowCandidates(files, minTokens)) {
    candidates.push(candidate);
  }
  const counted = selectMaximalGroups(
    candidates,
    spansMultipleFiles,
    // File index and position break coverage ties deterministically.
    (left, right) => left.regionBucket - right.regionBucket || left.startIndex - right.startIndex
  );
  const tokenOffsets = computeTokenOffsets(files, maxGapTokens);
  const exactGroups = mergeGapAdjacentGroups([...counted.values()], tokenOffsets, maxGapTokens);
  const nearMissGroups = collectNearMissGroups(files, exactGroups, tokenOffsets, minTokens, minSimilarityPercent);
  return summarize(takeOverExactGroups(exactGroups, nearMissGroups, minTokens), files, tokenOffsets);
}

/**
 * Lets a near-miss group take over the exact groups standing for the same copies, as within a
 * file (collect_near_miss_groups in native/src/duplication.rs): every occurrence of such a group
 * overlaps exactly one copy of the near-miss group (one overlapping none reports content the copies
 * do not share, and one reaching into two would make one copy take over lines of the next), exceeds
 * its span by less than `minTokens` (a copy is listed at the size it matched, not at that of a
 * clone larger by a reportable part, which may run into code no copy matched), and no two overlap
 * the same copy (those repeat within the copy, not between the copies).
 * Each copy then becomes one occurrence with the exact fragments it holds, so the copies are
 * listed once.
 */
function takeOverExactGroups(
  exactGroups: CrossFileOccurrence[][],
  nearMissGroups: CrossFileOccurrence[][],
  minTokens: number
): CrossFileOccurrence[][] {
  const exactGroupIndexesByFile = new Map<number, Set<number>>();
  for (const [groupIndex, group] of exactGroups.entries()) {
    for (const { fileIndex } of group) {
      const indexes = exactGroupIndexesByFile.get(fileIndex) ?? new Set();
      indexes.add(groupIndex);
      exactGroupIndexesByFile.set(fileIndex, indexes);
    }
  }
  const taken = new Set<number>();
  const merged = nearMissGroups.map((copies) => {
    const copyOf = (occurrence: CrossFileOccurrence): CrossFileOccurrence | undefined => {
      const overlapped = copies.filter((copy) =>
        copy.segments.some(
          (segment) =>
            occurrence.startTokenIndex < segment.endTokenIndex && segment.startTokenIndex < occurrence.endTokenIndex
        )
      );
      const [copy] = overlapped;
      if (overlapped.length !== 1 || !copy) {
        return undefined;
      }
      const excess =
        Math.max(0, copy.startTokenIndex - occurrence.startTokenIndex) +
        Math.max(0, occurrence.endTokenIndex - copy.endTokenIndex);
      return excess < minTokens ? copy : undefined;
    };
    const fragmentsByCopy = new Map<CrossFileOccurrence, CrossFileOccurrence[]>();
    const candidateIndexes = new Set(
      copies.flatMap((copy) =>
        copy.spanCountedElsewhere ? [...(exactGroupIndexesByFile.get(copy.fileIndex) ?? [])] : []
      )
    );
    for (const groupIndex of [...candidateIndexes].toSorted((left, right) => left - right)) {
      const group = exactGroups[groupIndex] ?? [];
      const owners = group.map(copyOf);
      if (taken.has(groupIndex) || owners.includes(undefined) || new Set(owners).size !== owners.length) {
        continue;
      }
      taken.add(groupIndex);
      for (const [index, owner] of owners.entries()) {
        const fragment = group[index];
        if (owner && fragment) {
          fragmentsByCopy.set(owner, [...(fragmentsByCopy.get(owner) ?? []), fragment]);
        }
      }
    }
    return copies.map((copy): CrossFileOccurrence => {
      const fragments = fragmentsByCopy.get(copy);
      return fragments ? coalesceOccurrences([copy, ...fragments]) : copy;
    });
  });
  return [...exactGroups.filter((_, groupIndex) => !taken.has(groupIndex)), ...merged];
}

/** The parts of one copy as one occurrence: an exact part is matched throughout, a near-miss part where its partners match it. */
function coalesceOccurrences(parts: [CrossFileOccurrence, ...CrossFileOccurrence[]]): CrossFileOccurrence {
  const segments = mergeSegments(parts.flatMap((part) => part.segments));
  return {
    ...parts[0],
    spanCountedElsewhere: undefined,
    nestedInLargerGroup: undefined,
    segments,
    matchedRuns: mergeSegments(parts.flatMap((part) => part.matchedRuns ?? part.segments)),
    tokenCount: segments.reduce((sum, segment) => sum + segment.endTokenIndex - segment.startTokenIndex, 0),
    startTokenIndex: Math.min(...parts.map((part) => part.startTokenIndex)),
    endTokenIndex: Math.max(...parts.map((part) => part.endTokenIndex)),
    startIndex: Math.min(...parts.map((part) => part.startIndex)),
    endIndex: Math.max(...parts.map((part) => part.endIndex)),
    startLine: Math.min(...parts.map((part) => part.startLine)),
    endLine: Math.max(...parts.map((part) => part.endLine)),
  };
}

/** The unions of overlapping segments, in position order. */
function mergeSegments(segments: TokenSegment[]): TokenSegment[] {
  const merged: TokenSegment[] = [];
  for (const segment of segments.toSorted((left, right) => left.startTokenIndex - right.startTokenIndex)) {
    const last = merged.at(-1);
    if (last && segment.startTokenIndex < last.endTokenIndex) {
      last.endTokenIndex = Math.max(last.endTokenIndex, segment.endTokenIndex);
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/** Near-miss groups among the blocks the exact groups leave unreported, in the project token space. */
function collectNearMissGroups(
  files: CrossFileDuplicationSourceFile[],
  exactGroups: CrossFileOccurrence[][],
  tokenOffsets: number[],
  minTokens: number,
  minSimilarityPercent: number
): CrossFileOccurrence[][] {
  const reportedSpansByFile: { startTokenIndex: number; endTokenIndex: number }[][] = files.map(() => []);
  // Segment by segment: the gap of a gapped clone is not reported content.
  for (const { fileIndex, segments } of exactGroups.flat()) {
    const offset = tokenOffsets[fileIndex] ?? 0;
    for (const segment of segments) {
      reportedSpansByFile[fileIndex]?.push(shift(segment, -offset));
    }
  }
  return collectCrossFileNearMissGroups(files, reportedSpansByFile, minTokens, minSimilarityPercent).map((group) =>
    group.map((occurrence) => {
      const offset = tokenOffsets[occurrence.fileIndex] ?? 0;
      return {
        ...occurrence,
        file: files[occurrence.fileIndex]?.file ?? '',
        segments: occurrence.segments.map((segment) => shift(segment, offset)),
        matchedRuns: occurrence.matchedRuns?.map((run) => shift(run, offset)),
        startTokenIndex: occurrence.startTokenIndex + offset,
        endTokenIndex: occurrence.endTokenIndex + offset,
      };
    })
  );
}

function shift({ startTokenIndex, endTokenIndex }: TokenSegment, offset: number): TokenSegment {
  return { startTokenIndex: startTokenIndex + offset, endTokenIndex: endTokenIndex + offset };
}

/** Repeated sub-windows of sibling statements matched across the whole project's files. */
function collectWindowCandidates(files: CrossFileDuplicationSourceFile[], minTokens: number): SelectableCandidate[] {
  const fileIndexByContext: number[] = [];
  const contexts: SequenceWindowContext[] = [];
  for (const [fileIndex, { tokens, containerStatements }] of files.entries()) {
    if (tokens && containerStatements) {
      fileIndexByContext.push(fileIndex);
      contexts.push({ tokens, literalCountPrefix: buildLiteralCountPrefix(tokens), containers: containerStatements });
    }
  }
  if (contexts.length < 2) {
    return [];
  }
  return collectSequenceWindowCandidates(contexts, minTokens, true).flatMap(({ candidate, contextIndex }) => {
    const fileIndex = fileIndexByContext[contextIndex];
    const file = fileIndex === undefined ? undefined : files[fileIndex];
    return fileIndex === undefined || file === undefined
      ? []
      : [{ ...candidate, regionBucket: fileIndex, file: file.file }];
  });
}

/** A merged group is reported only while it still covers more than one file. */
function spansMultipleFilesAfterMerge(group: CrossFileOccurrence[]): boolean {
  return new Set(group.map((occurrence) => occurrence.file)).size >= 2;
}

function spansMultipleFiles(group: SelectableCandidate[]): boolean {
  return group.length >= 2 && new Set(group.map((candidate) => candidate.regionBucket)).size >= 2;
}

/**
 * Per-file token offsets that map every file into one project-wide token index space: each file's
 * tokens are offset by more than `maxGapTokens` past the previous file's, so occurrences in
 * different files are never gap-adjacent and merged pairs always stay within one file.
 */
function computeTokenOffsets(files: CrossFileDuplicationSourceFile[], maxGapTokens: number): number[] {
  const tokenOffsets: number[] = [];
  let offset = 0;
  for (const { tokens, candidates } of files) {
    tokenOffsets.push(offset);
    // Accumulated in a loop: spreading a project-scale candidate array as call arguments would
    // overflow V8's argument limit (~124k) and crash on Node.
    let tokenCount = tokens?.length ?? 0;
    if (!tokens) {
      for (const candidate of candidates) {
        tokenCount = Math.max(tokenCount, candidate.endTokenIndex);
      }
    }
    offset += tokenCount + maxGapTokens + 1;
  }
  return tokenOffsets;
}

/** Reuses the within-file gapped (Type-3) merging in the project-wide token index space. */
function mergeGapAdjacentGroups(
  groups: SelectableCandidate[][],
  tokenOffsets: number[],
  maxGapTokens: number
): CrossFileOccurrence[][] {
  const occurrenceGroups = groups.map((group) =>
    group
      .map((candidate): CrossFileOccurrence => {
        const start = candidate.startTokenIndex + (tokenOffsets[candidate.regionBucket] ?? 0);
        const end = candidate.endTokenIndex + (tokenOffsets[candidate.regionBucket] ?? 0);
        return {
          file: candidate.file,
          fileIndex: candidate.regionBucket,
          spanCountedElsewhere: candidate.nestedInLargerGroup,
          nestedInLargerGroup: candidate.nestedInLargerGroup,
          segments: [{ startTokenIndex: start, endTokenIndex: end }],
          tokenCount: candidate.tokenCount,
          startTokenIndex: start,
          endTokenIndex: end,
          startIndex: candidate.startIndex,
          endIndex: candidate.endIndex,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
        };
      })
      .toSorted((left, right) => left.startTokenIndex - right.startTokenIndex)
  );
  return mergeAdjacentGroups(occurrenceGroups, maxGapTokens, spansMultipleFilesAfterMerge);
}

function summarize(
  groups: CrossFileOccurrence[][],
  files: CrossFileDuplicationSourceFile[],
  tokenOffsets: number[]
): CrossFileDuplicationMetrics {
  const reported: CrossFileDuplicateBlockGroup[] = [];
  // Accumulated in Maps: file names are arbitrary strings, and a plain object would read
  // inherited properties for names like "constructor".
  const groupCountByFile = new Map<string, number>();
  const fileDataByName = new Map(
    files.map((file, index) => [
      file.file,
      { tokens: file.tokens, codeLineNumbers: file.codeLineNumbers, offset: tokenOffsets[index] ?? 0 },
    ])
  );
  const lineNumbersByFile = new Map<string, Set<number>>();
  let duplicateBlockCount = 0;
  for (const group of groups) {
    // Mirrors within-file counting: each redundant occurrence contributes one count per matched
    // fragment, gapped merging consolidates the grouping without halving the count, and spans a
    // partial merge shares between a retained group and the merged group count once.
    duplicateBlockCount += countRedundantFragments(group);
    const occurrences = group
      .map((occurrence) => {
        const { file, startLine, endLine, tokenCount } = occurrence;
        const lineNumbers = collectOccurrenceLines(occurrence, fileDataByName, lineNumbersByFile);
        return { file, startLine, endLine, ...(lineNumbers && { lineNumbers }), tokenCount };
      })
      .toSorted((left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine);
    const files = [...new Set(occurrences.map(({ file }) => file))];
    for (const file of files) {
      groupCountByFile.set(file, (groupCountByFile.get(file) ?? 0) + 1);
    }
    reported.push({ files, occurrences, tokenCount: Math.min(...group.map(({ tokenCount }) => tokenCount)) });
  }
  reported.sort(
    (left, right) =>
      right.tokenCount - left.tokenCount ||
      (left.occurrences[0]?.file ?? '').localeCompare(right.occurrences[0]?.file ?? '') ||
      (left.occurrences[0]?.startLine ?? 0) - (right.occurrences[0]?.startLine ?? 0)
  );
  return {
    duplicateBlockCount,
    duplicateBlockGroupCountByFile: Object.fromEntries(groupCountByFile),
    duplicateLineNumbersByFile: Object.fromEntries(
      [...lineNumbersByFile].map(([file, lines]) => [file, [...lines].toSorted((left, right) => left - right)])
    ),
    groups: reported,
  };
}

/**
 * Adds the code lines an occurrence's matched tokens cover (see collectMatchedLines) to its file's
 * line set, mapping the project-wide token segments back into the file's own token stream, and
 * returns them in order.
 * A file that supplied only candidates (no token stream) is skipped rather than approximated from
 * the bounding line range, which would include gap and comment/blank lines and break the field's
 * exactness contract.
 */
function collectOccurrenceLines(
  occurrence: CrossFileOccurrence,
  fileDataByName: Map<
    string,
    { tokens?: CrossFileDuplicationSourceFile['tokens']; codeLineNumbers?: Set<number>; offset: number }
  >,
  lineNumbersByFile: Map<string, Set<number>>
): number[] | undefined {
  const fileData = fileDataByName.get(occurrence.file);
  if (!fileData?.tokens) {
    return undefined;
  }
  let fileLines = lineNumbersByFile.get(occurrence.file);
  if (!fileLines) {
    fileLines = new Set();
    lineNumbersByFile.set(occurrence.file, fileLines);
  }
  const lines = collectMatchedLines(
    occurrence.segments.map((segment) => shift(segment, -fileData.offset)),
    occurrence.matchedRuns?.map((run) => shift(run, -fileData.offset)),
    fileData.tokens,
    fileData.codeLineNumbers
  );
  for (const line of lines) {
    fileLines.add(line);
  }
  return [...lines].toSorted((left, right) => left - right);
}
