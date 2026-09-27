import { describe, expect, it } from 'vitest';
import { findNewlyDuplicatedLines, type DuplicationChange } from '../../src/index.js';

// Near-miss clones and whole-block rewrites are hard to provoke reliably through the CLI, so the
// attribution rules are exercised on the public API with explicit line sets.

function lines(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

function makeChange(change: Partial<DuplicationChange> & Pick<DuplicationChange, 'hunks'>): DuplicationChange {
  return {
    baseLines: Array.from({ length: 20 }, (_, index) => `base ${index + 1}`),
    headLines: Array.from({ length: 20 }, (_, index) => `head ${index + 1}`),
    baseDuplicatedLines: new Set(),
    headDuplicatedLines: new Set(),
    headOccurrences: [],
    ...change,
  };
}

describe('findNewlyDuplicatedLines', () => {
  it('reports added lines of a clone that did not exist at base', () => {
    const change = makeChange({
      hunks: [{ baseStart: 10, baseCount: 0, headStart: 11, headCount: 5 }],
      headDuplicatedLines: new Set(lines(11, 15)),
      headOccurrences: [{ startLine: 11, endLine: 15 }],
    });
    expect(findNewlyDuplicatedLines([change])).toStrictEqual([lines(11, 15)]);
  });

  it('ignores a line inserted into a clone that existed at base, even when its coverage includes it', () => {
    // Base lines 1-6 were one clone occurrence; head line 4 was inserted and shifts 4-6 to 5-7.
    const change = makeChange({
      hunks: [{ baseStart: 3, baseCount: 0, headStart: 4, headCount: 1 }],
      baseDuplicatedLines: new Set(lines(1, 6)),
      headDuplicatedLines: new Set(lines(1, 7)),
      headOccurrences: [{ startLine: 1, endLine: 7 }],
    });
    expect(findNewlyDuplicatedLines([change])).toStrictEqual([[]]);
  });

  it('credits a clone rewritten in place and a clone moved to another file', () => {
    const rewritten = makeChange({
      hunks: [{ baseStart: 1, baseCount: 3, headStart: 1, headCount: 3 }],
      baseDuplicatedLines: new Set(lines(1, 3)),
      headDuplicatedLines: new Set(lines(1, 3)),
      headOccurrences: [{ startLine: 1, endLine: 3 }],
    });
    const source = makeChange({
      headLines: undefined,
      baseLines: ['  shared();', '  moved();'],
      hunks: [{ baseStart: 1, baseCount: 2, headStart: 0, headCount: 0 }],
      baseDuplicatedLines: new Set([1, 2]),
    });
    const destination = makeChange({
      baseLines: undefined,
      headLines: ['shared();', 'moved();'],
      hunks: [{ baseStart: 0, baseCount: 0, headStart: 1, headCount: 2 }],
      headDuplicatedLines: new Set([1, 2]),
      headOccurrences: [{ startLine: 1, endLine: 2 }],
    });
    expect(findNewlyDuplicatedLines([rewritten, source, destination])).toStrictEqual([[], [], []]);
  });
});
