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

/** Caps how often the maximal-region selection reruns after shedding failed duplicate groups. */
const maxSelectionRerunCount = 20;

interface SelectableCandidate extends CrossFileDuplicateCandidate {
  fileIndex: number;
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
  const byFingerprint = new Map<string, SelectableCandidate[]>();
  for (const [fileIndex, { file, candidates }] of files.entries()) {
    for (const candidate of candidates) {
      const group = byFingerprint.get(candidate.fingerprint) ?? [];
      group.push({ ...candidate, fileIndex, file });
      byFingerprint.set(candidate.fingerprint, group);
    }
  }

  const groups = [...byFingerprint.values()].map(dedupeByRegion).filter(spansMultipleFiles);
  const groupSizeByFingerprint = new Map(groups.map((group) => [group[0]?.fingerprint ?? '', group.length]));
  const coverage = (candidate: SelectableCandidate): number =>
    candidate.tokenCount * (groupSizeByFingerprint.get(candidate.fingerprint) ?? 1);
  let duplicates = groups.flat();
  // Coverage-ranked greedy selection; file index and position break ties deterministically.
  duplicates.sort(
    (left, right) =>
      coverage(right) - coverage(left) || left.fileIndex - right.fileIndex || left.startIndex - right.startIndex
  );

  // Like within-file selection, a greedily kept candidate can strand its group below the survivor
  // requirement (two occurrences in two files); the largest failed group is shed and the selection
  // reruns so its regions stop blocking smaller groups.
  for (let rerun = 0; ; rerun += 1) {
    const keptRegionsByFile = new Map<number, { startIndex: number; endIndex: number }[]>();
    const counted = new Map<string, SelectableCandidate[]>();
    for (const candidate of duplicates) {
      const keptRegions = keptRegionsByFile.get(candidate.fileIndex) ?? [];
      if (
        keptRegions.some((region) => region.startIndex < candidate.endIndex && candidate.startIndex < region.endIndex)
      ) {
        continue;
      }
      keptRegions.push(candidate);
      keptRegionsByFile.set(candidate.fileIndex, keptRegions);
      const group = counted.get(candidate.fingerprint) ?? [];
      group.push(candidate);
      counted.set(candidate.fingerprint, group);
    }

    let failedFingerprint: string | undefined;
    let failedTokenCount = -1;
    for (const [fingerprint, group] of counted) {
      const tokenCount = group[0]?.tokenCount ?? 0;
      if (!spansMultipleFiles(group) && tokenCount > failedTokenCount) {
        failedFingerprint = fingerprint;
        failedTokenCount = tokenCount;
      }
    }
    if (failedFingerprint === undefined) {
      return summarize(counted);
    }
    if (rerun >= maxSelectionRerunCount) {
      for (const [fingerprint, group] of counted) {
        if (!spansMultipleFiles(group)) {
          counted.delete(fingerprint);
        }
      }
      return summarize(counted);
    }

    duplicates = duplicates.filter((candidate) => candidate.fingerprint !== failedFingerprint);
  }
}

function spansMultipleFiles(group: SelectableCandidate[]): boolean {
  return group.length >= 2 && new Set(group.map((candidate) => candidate.fileIndex)).size >= 2;
}

/** Drops candidates covering the same source region (a block and the container run spanning it). */
function dedupeByRegion(group: SelectableCandidate[]): SelectableCandidate[] {
  const byRegion = new Map<string, SelectableCandidate>();
  for (const candidate of group) {
    const key = `${candidate.fileIndex}:${candidate.startIndex}:${candidate.endIndex}`;
    const existing = byRegion.get(key);
    if (!existing || candidate.tokenCount > existing.tokenCount) {
      byRegion.set(key, candidate);
    }
  }
  return [...byRegion.values()];
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
