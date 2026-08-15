import { selectMaximalGroups } from './duplicateSelection.js';
import {
  buildLiteralCountPrefix,
  collectSegmentLines,
  collectSequenceWindowCandidates,
  countRedundantFragments,
  mergeAdjacentGroups,
  resolveDuplicationOptions,
  type CountedOccurrence,
  type CrossFileDuplicateCandidate,
  type CrossFileDuplicationFileData,
  type SequenceWindowContext,
} from './duplication.js';
import type { DuplicationOptions } from './types.js';

export interface CrossFileDuplicationSourceFile extends Partial<CrossFileDuplicationFileData> {
  file: string;
  candidates: CrossFileDuplicateCandidate[];
}

export interface CrossFileDuplicateOccurrence {
  endLine: number;
  file: string;
  startLine: number;
}

export interface CrossFileDuplicateBlockGroup {
  files: string[];
  occurrences: CrossFileDuplicateOccurrence[];
  /** Matched token count of one occurrence (all occurrences share it; gaps are not counted). */
  tokenCount: number;
}

export interface CrossFileDuplicationMetrics {
  /** Number of redundant copies across all groups, counted per matched fragment like within-file. */
  duplicateBlockCount: number;
  /** Groups the file participates in, keyed by the file name passed in. */
  duplicateBlockGroupCountByFile: Record<string, number>;
  /**
   * Per file, the 1-based code lines covered by matched tokens of its cross-file occurrences,
   * sorted ascending. Exact like within-file duplicateLineNumbers: the unmatched gap of a merged
   * clone and comment/blank lines inside an occurrence's bounding range are excluded (blank rows
   * inside multi-row tokens only when the file supplied codeLineNumbers). A file that supplied
   * only candidates (no `tokens`) has no entry — without its token stream the matched lines are
   * unknowable, and an approximate bounding range would break this field's exactness.
   */
  duplicateLineNumbersByFile: Record<string, number[]>;
  groups: CrossFileDuplicateBlockGroup[];
}

interface SelectableCandidate extends CrossFileDuplicateCandidate {
  regionBucket: number;
  file: string;
}

/** A cross-file occurrence: a within-file occurrence in the project-wide token index space. */
interface CrossFileOccurrence extends CountedOccurrence {
  file: string;
}

/**
 * Detects code regions duplicated across files. Per-file candidates (whole block subtrees and full
 * container runs, fingerprinted with the same normalization as within-file duplication) are joined
 * by a project-level window index over per-statement fingerprint sequences (CPD-style), so a
 * copy-pasted partial statement run embedded in different surrounding code is matched even though
 * no single file can know it repeats elsewhere. Candidates are grouped by fingerprint, and only
 * maximal, non-overlapping regions whose group spans at least two files are counted. Groups that
 * shrink to a single file during selection are shed — a within-file repeat is already reported by
 * that file's own duplication metrics. Groups separated by a small token gap within each file then
 * merge into gapped (Type-3) clone groups under `maxGapTokens`, exactly like within-file merging.
 */
export function measureCrossFileDuplication(
  files: CrossFileDuplicationSourceFile[],
  options?: DuplicationOptions
): CrossFileDuplicationMetrics {
  const { minTokens, maxGapTokens } = resolveDuplicationOptions(options);
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
  return summarize(mergeGapAdjacentGroups([...counted.values()], tokenOffsets, maxGapTokens), files, tokenOffsets);
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
  return mergeAdjacentGroups(occurrenceGroups, maxGapTokens);
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
    for (const occurrence of group) {
      collectOccurrenceLines(occurrence, fileDataByName, lineNumbersByFile);
    }
    const occurrences = group
      .map(({ file, startLine, endLine }) => ({ file, startLine, endLine }))
      .toSorted((left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine);
    const files = [...new Set(occurrences.map(({ file }) => file))];
    for (const file of files) {
      groupCountByFile.set(file, (groupCountByFile.get(file) ?? 0) + 1);
    }
    reported.push({ files, occurrences, tokenCount: group[0]?.tokenCount ?? 0 });
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
 * Adds the code lines an occurrence's matched tokens cover to its file's line set, mapping the
 * project-wide token segments back into the file's own token stream. A file that supplied only
 * candidates (no token stream) is skipped rather than approximated from the bounding line range,
 * which would include gap and comment/blank lines and break the field's exactness contract.
 */
function collectOccurrenceLines(
  occurrence: CrossFileOccurrence,
  fileDataByName: Map<
    string,
    { tokens?: CrossFileDuplicationSourceFile['tokens']; codeLineNumbers?: Set<number>; offset: number }
  >,
  lineNumbersByFile: Map<string, Set<number>>
): void {
  const fileData = fileDataByName.get(occurrence.file);
  if (!fileData?.tokens) {
    return;
  }
  let lines = lineNumbersByFile.get(occurrence.file);
  if (!lines) {
    lines = new Set();
    lineNumbersByFile.set(occurrence.file, lines);
  }
  for (const segment of occurrence.segments) {
    collectSegmentLines(
      {
        startTokenIndex: segment.startTokenIndex - fileData.offset,
        endTokenIndex: segment.endTokenIndex - fileData.offset,
      },
      fileData.tokens,
      fileData.codeLineNumbers,
      lines
    );
  }
}
