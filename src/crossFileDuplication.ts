import { selectMaximalGroups } from './duplicateSelection.js';
import type { CrossFileDuplicateCandidate } from './duplication.js';

export interface CrossFileDuplicationSourceFile {
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
  /** Normalized token count of one occurrence (all occurrences share it). */
  tokenCount: number;
}

export interface CrossFileDuplicationMetrics {
  /** Number of redundant copies across all groups, i.e. sum of (occurrenceCount - 1). */
  duplicateBlockCount: number;
  /** Groups the file participates in, keyed by the file name passed in. */
  duplicateBlockGroupCountByFile: Record<string, number>;
  groups: CrossFileDuplicateBlockGroup[];
}

interface SelectableCandidate extends CrossFileDuplicateCandidate {
  regionBucket: number;
  file: string;
}

/**
 * Detects code regions duplicated across files: per-file candidates (whole block subtrees and
 * full container runs, fingerprinted with the same normalization as within-file duplication) are
 * grouped by fingerprint, and only maximal, non-overlapping regions whose group spans at least two
 * files are counted. Groups that shrink to a single file during selection are shed — a
 * within-file repeat is already reported by that file's own duplication metrics.
 */
export function measureCrossFileDuplication(files: CrossFileDuplicationSourceFile[]): CrossFileDuplicationMetrics {
  const candidates: SelectableCandidate[] = files.flatMap(({ file, candidates }, fileIndex) =>
    candidates.map((candidate) => ({ ...candidate, regionBucket: fileIndex, file }))
  );
  const counted = selectMaximalGroups(
    candidates,
    spansMultipleFiles,
    // File index and position break coverage ties deterministically.
    (left, right) => left.regionBucket - right.regionBucket || left.startIndex - right.startIndex
  );
  return summarize(counted);
}

function spansMultipleFiles(group: SelectableCandidate[]): boolean {
  return group.length >= 2 && new Set(group.map((candidate) => candidate.regionBucket)).size >= 2;
}

function summarize(counted: Map<string, SelectableCandidate[]>): CrossFileDuplicationMetrics {
  const groups: CrossFileDuplicateBlockGroup[] = [];
  const duplicateBlockGroupCountByFile: Record<string, number> = {};
  let duplicateBlockCount = 0;
  for (const group of counted.values()) {
    duplicateBlockCount += group.length - 1;
    const occurrences = group
      .map(({ file, startLine, endLine }) => ({ file, startLine, endLine }))
      .toSorted((left, right) => left.file.localeCompare(right.file) || left.startLine - right.startLine);
    const files = [...new Set(occurrences.map(({ file }) => file))];
    for (const file of files) {
      duplicateBlockGroupCountByFile[file] = (duplicateBlockGroupCountByFile[file] ?? 0) + 1;
    }
    groups.push({ files, occurrences, tokenCount: group[0]?.tokenCount ?? 0 });
  }
  groups.sort(
    (left, right) =>
      right.tokenCount - left.tokenCount ||
      (left.occurrences[0]?.file ?? '').localeCompare(right.occurrences[0]?.file ?? '') ||
      (left.occurrences[0]?.startLine ?? 0) - (right.occurrences[0]?.startLine ?? 0)
  );
  return { duplicateBlockCount, duplicateBlockGroupCountByFile, groups };
}
