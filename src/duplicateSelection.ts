/**
 * Maximal, non-overlapping duplicate-group selection for the cross-file detector (the native
 * within-file detector mirrors its greedy ranking and shedding, but not the nested-copy retention
 * below, which is cross-file only). Candidates are grouped by fingerprint, ranked by total
 * coverage, kept greedily without overlapping a kept region, and groups that fall below the
 * survivor requirement are shed one at a time (largest first) so their regions stop blocking
 * smaller groups. A copy lying entirely inside a larger group's region stays with its group as a
 * nested copy (whichever group the greedy order kept first), so a standalone copy elsewhere is
 * still reported as duplicating it.
 */

export interface SelectableRegion {
  fingerprint: string;
  tokenCount: number;
  startIndex: number;
  endIndex: number;
  /**
   * Regions can only overlap within the same bucket. The within-file detector uses one bucket;
   * the cross-file detector buckets by file index.
   */
  regionBucket?: number;
  /**
   * Set by selectMaximalGroups on a copy nested inside a larger group's region: it is reported with
   * its group, but its span is already counted by that larger group.
   */
  nestedInLargerGroup?: boolean;
}

/** Caps how often the maximal-region selection reruns after shedding failed duplicate groups. */
const maxSelectionRerunCount = 20;

/**
 * @param isSurvivingGroup whether a selected group counts (e.g. at least two occurrences, or
 *   occurrences spanning at least two files); failing groups are shed and re-selected without.
 * @param compareTies optional deterministic tie-break applied after the coverage ranking.
 */
export function selectMaximalGroups<T extends SelectableRegion>(
  candidates: T[],
  isSurvivingGroup: (group: T[]) => boolean,
  compareTies?: (left: T, right: T) => number
): Map<string, T[]> {
  const byFingerprint = new Map<string, T[]>();
  for (const candidate of candidates) {
    const group = byFingerprint.get(candidate.fingerprint) ?? [];
    group.push(candidate);
    byFingerprint.set(candidate.fingerprint, group);
  }

  const groups = [...byFingerprint.values()].map(dedupeByRegion).filter(isSurvivingGroup);
  // Greedy order ranks by total coverage (region size × copies): a 3×3-statement group must beat
  // a 2×4-statement group overlapping two of its copies, or the third copy is silently dropped
  // and the reported duplication shrinks as more copies are added.
  const groupSizeByFingerprint = new Map(groups.map((group) => [group[0]?.fingerprint ?? '', group.length]));
  const coverage = (candidate: T): number =>
    candidate.tokenCount * (groupSizeByFingerprint.get(candidate.fingerprint) ?? 1);
  let duplicates = groups.flat();
  duplicates.sort((left, right) => coverage(right) - coverage(left) || (compareTies ? compareTies(left, right) : 0));

  // Greedy selection can keep a candidate whose group ends up below the survivor requirement;
  // such an uncounted region must not block smaller groups, so the largest failed group is
  // removed and the selection reruns. One group at a time: freeing a failed group's regions can
  // rescue another. The rerun cap bounds degenerate inputs; past it the remaining failed groups
  // are dropped, trading a sliver of recall on such files for bounded runtime.
  for (let rerun = 0; ; rerun += 1) {
    const keptRegionsByBucket = new Map<number, T[]>();
    const counted = new Map<string, T[]>();
    const nestedByFingerprint = new Map<string, T[]>();
    for (const candidate of duplicates) {
      const keptRegions = keptRegionsByBucket.get(candidate.regionBucket ?? 0) ?? [];
      // A plain loop: this runs once per candidate over every kept region of the bucket, so
      // allocating a filtered array per candidate would dominate project-scale runs. Kept regions
      // never overlap each other, so a candidate inside one cannot partially overlap another.
      let containedInKept = false;
      let partiallyOverlaps = false;
      let enclosedKept: T[] | undefined;
      for (const region of keptRegions) {
        if (region.startIndex >= candidate.endIndex || candidate.startIndex >= region.endIndex) {
          continue;
        }
        if (region.startIndex <= candidate.startIndex && candidate.endIndex <= region.endIndex) {
          containedInKept = true;
          break;
        }
        if (candidate.startIndex <= region.startIndex && region.endIndex <= candidate.endIndex) {
          (enclosedKept ??= []).push(region);
        } else {
          partiallyOverlaps = true;
          break;
        }
      }
      if (containedInKept) {
        const nested = nestedByFingerprint.get(candidate.fingerprint) ?? [];
        nested.push({ ...candidate, nestedInLargerGroup: true });
        nestedByFingerprint.set(candidate.fingerprint, nested);
        continue;
      }
      if (partiallyOverlaps) {
        continue;
      }
      // Containment must not depend on greedy order: a candidate enclosing kept copies of smaller
      // groups occupies its region, and those copies become nested copies of their groups.
      const enclosed = enclosedKept;
      for (const inner of enclosed ?? []) {
        const group = counted.get(inner.fingerprint) ?? [];
        const index = group.indexOf(inner);
        if (index !== -1) {
          group[index] = { ...inner, nestedInLargerGroup: true };
        }
      }
      // The enclosed regions give way to the enclosing one, keeping kept regions mutually
      // non-overlapping: a later candidate inside this region must see it, not a region it
      // swallowed (which the candidate could straddle instead).
      const occupied = enclosed ? keptRegions.filter((region) => !enclosed.includes(region)) : keptRegions;
      occupied.push(candidate);
      keptRegionsByBucket.set(candidate.regionBucket ?? 0, occupied);
      const group = counted.get(candidate.fingerprint) ?? [];
      group.push(candidate);
      counted.set(candidate.fingerprint, group);
    }
    // Nested copies join only a group that kept a standalone copy; on their own they would merely
    // restate the larger group.
    for (const [fingerprint, nested] of nestedByFingerprint) {
      counted.get(fingerprint)?.push(...nested);
    }
    for (const [fingerprint, group] of counted) {
      if (group.every((candidate) => candidate.nestedInLargerGroup)) {
        counted.delete(fingerprint);
      }
    }

    let failedFingerprint: string | undefined;
    let failedTokenCount = -1;
    for (const [fingerprint, group] of counted) {
      const tokenCount = group[0]?.tokenCount ?? 0;
      if (!isSurvivingGroup(group) && tokenCount > failedTokenCount) {
        failedFingerprint = fingerprint;
        failedTokenCount = tokenCount;
      }
    }
    // No failed fingerprint means every counted group met the survivor requirement.
    if (failedFingerprint === undefined) {
      return counted;
    }
    if (rerun >= maxSelectionRerunCount) {
      dropFailedGroups(counted, isSurvivingGroup);
      return counted;
    }

    duplicates = duplicates.filter((candidate) => candidate.fingerprint !== failedFingerprint);
  }
}

/**
 * Past the rerun cap, still-failing groups are dropped without another selection pass. A dropped
 * group's regions may have been what nested copies of surviving groups lay inside, and such a copy
 * would then be counted by no group at all, so those copies are dropped too and the shrunk groups
 * are re-checked until nothing changes.
 */
function dropFailedGroups<T extends SelectableRegion>(
  counted: Map<string, T[]>,
  isSurvivingGroup: (group: T[]) => boolean
): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const [fingerprint, group] of counted) {
      if (!isSurvivingGroup(group) || group.every((candidate) => candidate.nestedInLargerGroup)) {
        counted.delete(fingerprint);
        changed = true;
      }
    }
    const standalone = [...counted.values()].flat().filter((candidate) => !candidate.nestedInLargerGroup);
    for (const [fingerprint, group] of counted) {
      const kept = group.filter(
        (candidate) =>
          !candidate.nestedInLargerGroup ||
          standalone.some(
            (region) =>
              (region.regionBucket ?? 0) === (candidate.regionBucket ?? 0) &&
              region.startIndex <= candidate.startIndex &&
              candidate.endIndex <= region.endIndex
          )
      );
      if (kept.length !== group.length) {
        counted.set(fingerprint, kept);
        changed = true;
      }
    }
  }
}

/** Drops candidates covering the same source region (a block and the statement run spanning it). */
export function dedupeByRegion<T extends SelectableRegion>(group: T[]): T[] {
  const byRegion = new Map<string, T>();
  for (const candidate of group) {
    const key = `${candidate.regionBucket ?? 0}:${candidate.startIndex}:${candidate.endIndex}`;
    const existing = byRegion.get(key);
    if (!existing || candidate.tokenCount > existing.tokenCount) {
      byRegion.set(key, candidate);
    }
  }
  return [...byRegion.values()];
}
