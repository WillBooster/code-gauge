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

/**
 * The head lines, per change, that the change newly made duplicated. Only added lines count, so a
 * copy is attributed to where it was pasted, never to the unchanged code it copies. An added line
 * is not new duplication when
 * - every clone occurrence covering it holds it between unchanged lines that were duplicated at
 *   base (an edit inside pre-existing duplication, which near-miss coverage reports even for
 *   tokens the copies do not share),
 * - it replaces a deleted duplicated line of the same hunk (a clone rewritten in place), or
 * - it reappears from a deleted duplicated line elsewhere in the change (the clone was moved).
 */
export function findNewlyDuplicatedLines(changes: readonly DuplicationChange[]): number[][] {
  // Same-hunk replacements settle first, identical content pairing up before any other line, so
  // only deleted lines no rewrite needed are left to back moves, whatever the order of changes.
  const unreplaced = changes.map((change) => {
    const newCloneLines = collectNewCloneLines(change);
    return change.hunks.map((hunk) => settleReplacements(change, hunk, newCloneLines));
  });

  const movableByContent = new Map<string, number>();
  for (const { deletedContents } of unreplaced.flat()) {
    for (const content of deletedContents) {
      movableByContent.set(content, (movableByContent.get(content) ?? 0) + 1);
    }
  }

  return changes.map((change, changeIndex) =>
    (unreplaced[changeIndex] ?? [])
      .flatMap(({ addedLines }) => addedLines)
      .filter((line) => {
        const content = normalizeLine(change.headLines?.[line - 1]);
        const movable = movableByContent.get(content) ?? 0;
        if (movable === 0) {
          return true;
        }
        movableByContent.set(content, movable - 1);
        return false;
      })
      .toSorted((left, right) => left - right)
  );
}

/**
 * The hunk's added duplicated lines (of new clones) and deleted duplicated lines left once each
 * deleted line has credited one added line of the hunk, same content first.
 */
function settleReplacements(
  change: DuplicationChange,
  hunk: LineHunk,
  newCloneLines: ReadonlySet<number>
): { addedLines: number[]; deletedContents: string[] } {
  const deletedContents: string[] = [];
  for (let line = hunk.baseStart; line < hunk.baseStart + hunk.baseCount; line++) {
    if (change.baseDuplicatedLines.has(line)) {
      deletedContents.push(normalizeLine(change.baseLines?.[line - 1]));
    }
  }
  const addedLines: number[] = [];
  for (let line = hunk.headStart; line < hunk.headStart + hunk.headCount; line++) {
    if (!change.headDuplicatedLines.has(line) || !newCloneLines.has(line)) {
      continue;
    }
    const sameContentIndex = deletedContents.indexOf(normalizeLine(change.headLines?.[line - 1]));
    if (sameContentIndex === -1) {
      addedLines.push(line);
    } else {
      deletedContents.splice(sameContentIndex, 1);
    }
  }
  const replacedCount = Math.min(addedLines.length, deletedContents.length);
  return { addedLines: addedLines.slice(replacedCount), deletedContents: deletedContents.slice(replacedCount) };
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
