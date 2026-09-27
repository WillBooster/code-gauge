/** One region of a line diff: base lines [baseStart, baseStart + baseCount) became head lines [headStart, headStart + headCount). */
export interface LineHunk {
  baseStart: number;
  baseCount: number;
  headStart: number;
  headCount: number;
}

/** One changed file's line diff and the duplicated lines of each revision (1-based). */
export interface DuplicationChange {
  /** Absent for added files. */
  baseLines?: readonly string[];
  /** Absent for deleted files. */
  headLines?: readonly string[];
  baseDuplicatedLines: ReadonlySet<number>;
  headDuplicatedLines: ReadonlySet<number>;
  /** Line ranges of every head clone occurrence in the file, within-file and cross-file. */
  headOccurrences: readonly { startLine: number; endLine: number }[];
  hunks: readonly LineHunk[];
}

interface HunkState {
  addedLines: number[];
  deletedCount: number;
  /** Deleted duplicated lines already credited to a moved line. */
  consumedCount: number;
}

/**
 * The head lines, per change, that the change newly made duplicated. Only added lines count, so a
 * copy is attributed to where it was pasted, never to the unchanged code it copies. An added line
 * is not new duplication when
 * - every clone occurrence covering it holds it between unchanged lines that were duplicated at
 *   base (an edit inside pre-existing duplication, which near-miss coverage reports even for
 *   tokens the copies do not share),
 * - it reappears from a deleted duplicated line anywhere in the change (the clone was moved), or
 * - it replaces a deleted duplicated line of the same hunk (a clone rewritten in place).
 */
export function findNewlyDuplicatedLines(changes: readonly DuplicationChange[]): number[][] {
  const states = changes.map((change) => {
    const newCloneLines = collectNewCloneLines(change);
    return change.hunks.map((hunk) => collectHunkState(change, hunk, newCloneLines));
  });

  // Moved lines: an added duplicated line consumes a deleted duplicated line of identical content,
  // preferring its own hunk so a same-hunk replacement is not spent on a move elsewhere.
  const deletedByContent = new Map<string, HunkState[]>();
  for (const [changeIndex, change] of changes.entries()) {
    for (const [hunkIndex, hunk] of change.hunks.entries()) {
      const state = states[changeIndex]?.[hunkIndex] as HunkState;
      for (let line = hunk.baseStart; line < hunk.baseStart + hunk.baseCount; line++) {
        if (change.baseDuplicatedLines.has(line)) {
          const key = normalizeLine(change.baseLines?.[line - 1]);
          deletedByContent.set(key, [...(deletedByContent.get(key) ?? []), state]);
        }
      }
    }
  }

  // Every move is settled first: a later change's added line may consume an earlier hunk's
  // deleted line, which then no longer backs a same-hunk replacement.
  const unmovedByState = new Map<HunkState, number[]>();
  for (const [changeIndex, change] of changes.entries()) {
    for (const state of states[changeIndex] ?? []) {
      const unmoved = state.addedLines.filter((line) => {
        const owners = deletedByContent.get(normalizeLine(change.headLines?.[line - 1]));
        if (owners === undefined || owners.length === 0) {
          return true;
        }
        const ownIndex = owners.indexOf(state);
        const [owner] = owners.splice(ownIndex === -1 ? owners.length - 1 : ownIndex, 1) as [HunkState];
        owner.consumedCount += 1;
        return false;
      });
      unmovedByState.set(state, unmoved);
    }
  }

  return states.map((changeStates) =>
    changeStates
      .flatMap((state) =>
        (unmovedByState.get(state) ?? []).slice(Math.max(0, state.deletedCount - state.consumedCount))
      )
      .toSorted((left, right) => left - right)
  );
}

function collectHunkState(change: DuplicationChange, hunk: LineHunk, newCloneLines: ReadonlySet<number>): HunkState {
  const addedLines: number[] = [];
  for (let line = hunk.headStart; line < hunk.headStart + hunk.headCount; line++) {
    if (change.headDuplicatedLines.has(line) && newCloneLines.has(line)) {
      addedLines.push(line);
    }
  }
  let deletedCount = 0;
  for (let line = hunk.baseStart; line < hunk.baseStart + hunk.baseCount; line++) {
    if (change.baseDuplicatedLines.has(line)) {
      deletedCount += 1;
    }
  }
  return { addedLines, deletedCount, consumedCount: 0 };
}

/**
 * Lines of clone occurrences that are not edits inside pre-existing duplication: all lines of an
 * occurrence with no unchanged line that was duplicated at base, and otherwise the lines outside
 * the span between its first and last such line, so code pasted next to an old clone still counts.
 */
function collectNewCloneLines(change: DuplicationChange): Set<number> {
  const baseLineOf = mapUnchangedLines(change);
  const isPreexisting = (line: number): boolean => {
    const baseLine = baseLineOf[line] ?? 0;
    return baseLine > 0 && change.headDuplicatedLines.has(line) && change.baseDuplicatedLines.has(baseLine);
  };
  const lines = new Set<number>();
  for (const { startLine, endLine } of change.headOccurrences) {
    let firstPreexisting = Infinity;
    let lastPreexisting = -Infinity;
    for (let line = startLine; line <= endLine; line++) {
      if (isPreexisting(line)) {
        firstPreexisting = Math.min(firstPreexisting, line);
        lastPreexisting = line;
      }
    }
    for (let line = startLine; line <= endLine; line++) {
      if (line < firstPreexisting || line > lastPreexisting) {
        lines.add(line);
      }
    }
  }
  return lines;
}

/** The base line of each unchanged head line (index = head line), 0 for added lines. */
function mapUnchangedLines(change: DuplicationChange): Int32Array {
  const headLineCount = change.headLines?.length ?? 0;
  const baseLineOf = new Int32Array(headLineCount + 1);
  const hunks = change.hunks.toSorted((left, right) => left.headStart - right.headStart);
  let hunkIndex = 0;
  let shift = 0;
  for (let line = 1; line <= headLineCount; line++) {
    let hunk = hunks[hunkIndex];
    // A hunk without head lines (a pure deletion) sits after its headStart line.
    while (hunk && line >= hunk.headStart + Math.max(hunk.headCount, 1)) {
      shift += hunk.baseCount - hunk.headCount;
      hunkIndex += 1;
      hunk = hunks[hunkIndex];
    }
    const added = hunk !== undefined && hunk.headCount > 0 && line >= hunk.headStart;
    baseLineOf[line] = added ? 0 : line + shift;
  }
  return baseLineOf;
}

/** Moves re-indent code, so lines compare without surrounding whitespace. */
function normalizeLine(line: string | undefined): string {
  return line?.trim() ?? '';
}
