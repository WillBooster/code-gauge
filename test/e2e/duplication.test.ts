import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectDuplicationCandidates,
  measureCode,
  measureCrossFileDuplication,
  type LanguageName,
} from '../../src/index.js';
import { fixturesDir } from './fixtureCorpus.js';

// End-to-end coverage of the duplication detector across every supported language, plus the
// detector's semantic guarantees: rename tolerance, the literal-density (data-table) guard, gapped
// (Type-3) clone merging, detection options, and cross-file clone detection. The per-language
// fixtures double as regression guards for the language-specific node-type catalogs in
// duplication.ts: a grammar update or catalog omission that stops tokenizing a language correctly
// surfaces here as a missed (or spurious) clone.

interface FixtureExpectation {
  file: string;
  language: LanguageName;
  /** Renamed logic clone pairs (and the JSX markup pair for jsx/tsx); data tables excluded. */
  groupCount: number;
}

const fixtureExpectations: FixtureExpectation[] = [
  { file: 'clones.c', language: 'c', groupCount: 1 },
  { file: 'clones.cpp', language: 'cpp', groupCount: 1 },
  { file: 'clones.go', language: 'go', groupCount: 1 },
  { file: 'clones.java', language: 'java', groupCount: 1 },
  { file: 'clones.js', language: 'javascript', groupCount: 1 },
  { file: 'clones.jsx', language: 'jsx', groupCount: 2 },
  { file: 'clones.py', language: 'python', groupCount: 1 },
  { file: 'clones.rb', language: 'ruby', groupCount: 1 },
  { file: 'clones.rs', language: 'rust', groupCount: 1 },
  { file: 'clones.ts', language: 'typescript', groupCount: 1 },
  { file: 'clones.tsx', language: 'tsx', groupCount: 2 },
];

function readDuplicationFixture(file: string): string {
  return readFileSync(path.join(fixturesDir, 'duplication', file), 'utf8');
}

describe('duplication: per-language clone detection', () => {
  for (const { file, language, groupCount } of fixtureExpectations) {
    it(`detects renamed clones and excludes data tables in ${language}`, () => {
      const metrics = measureCode(readDuplicationFixture(file), { language });

      // Each fixture contains consistently renamed copy-paste pairs (detected) and, in most
      // languages, two same-shape data tables with different literal values (not detected).
      expect(metrics.duplication.duplicateBlockGroupCount).toBe(groupCount);
      expect(metrics.duplication.duplicateBlockCount).toBe(groupCount);
      for (const group of metrics.duplication.duplicateBlockGroups) {
        expect(group.length).toBe(2);
      }
      expect(metrics.duplication.maxDuplicateBlockSize).toBeGreaterThanOrEqual(40);
      expect(metrics.duplication.duplicationRatio).toBeGreaterThan(0);
      expect(metrics.duplication.duplicationRatio).toBeLessThanOrEqual(1);
    });
  }
});

const jsClonePair = readFileSync(path.join(fixturesDir, 'duplication', 'clones.js'), 'utf8');

function logicClone(name: string, middleStatement: string): string {
  return `
function ${name}(items) {
  let total = 0;
  let count = 0;
  for (const item of items) {
    if (item.status === 'paid') {
      total = total + item.amount;
      count = count + 1;
    }
  }
  ${middleStatement}
  let big = 0;
  let small = 0;
  for (const item of items) {
    if (item.amount > 100) {
      big = big + 1;
    } else {
      small = small + 1;
    }
  }
  return total + count + big - small;
}
`;
}

describe('duplication: gapped (Type-3) clones', () => {
  const gapped =
    logicClone('alpha', 'console.log("midpoint", total);') + logicClone('beta', 'console.warn("midpoint", total);');

  it('merges the exact halves around a small edit into one clone group', () => {
    const metrics = measureCode(gapped, { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
    expect(metrics.duplication.duplicateBlockCount).toBe(1);
    const group = metrics.duplication.duplicateBlockGroups[0] ?? [];
    // Each merged occurrence spans a whole function body, gap included.
    expect(group.length).toBe(2);
    expect((group[0]?.endLine ?? 0) - (group[0]?.startLine ?? 0)).toBeGreaterThan(15);
  });

  it('reports the halves separately when merging is disabled', () => {
    const metrics = measureCode(gapped, { language: 'javascript', duplication: { maxGapTokens: 0 } });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(2);
  });

  it('does not count the differing gap statement as duplicated lines', () => {
    const merged = measureCode(gapped, { language: 'javascript' });
    const split = measureCode(gapped, { language: 'javascript', duplication: { maxGapTokens: 0 } });

    // Merging reassembles the same matched content; the edited line stays uncounted.
    expect(merged.duplication.duplicateLineCount).toBe(split.duplication.duplicateLineCount);
  });
});

const table = (name: string, offset: number): string => `
function ${name}() {
  return {
    alpha: ${offset + 1}, bravo: ${offset + 2}, charlie: ${offset + 3}, delta: ${offset + 4}, echo: ${offset + 5},
    foxtrot: ${offset + 6}, golf: ${offset + 7}, hotel: ${offset + 8}, india: ${offset + 9}, juliet: ${offset + 10},
    kilo: ${offset + 11}, lima: ${offset + 12}, mike: ${offset + 13}, november: ${offset + 14}, oscar: ${offset + 15},
  };
}
`;

describe('duplication: literal-density guard', () => {
  it('rejects same-shape tables with different values but keeps true table copies', () => {
    const differentValues = measureCode(table('alpha', 0) + table('beta', 20), { language: 'javascript' });
    const identicalValues = measureCode(table('alpha', 0) + table('beta', 0), { language: 'javascript' });

    expect(differentValues.duplication.duplicateBlockGroupCount).toBe(0);
    expect(identicalValues.duplication.duplicateBlockGroupCount).toBe(1);
  });
});

describe('duplication: detection options', () => {
  it('honors a raised minTokens', () => {
    const metrics = measureCode(jsClonePair, { language: 'javascript', duplication: { minTokens: 500 } });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(0);
  });

  it('honors a lowered minTokens', () => {
    const shortPair = 'function a(x) { return x + 1; }\nfunction b(y) { return y + 1; }\n';
    const defaults = measureCode(shortPair, { language: 'javascript' });
    const lowered = measureCode(shortPair, { language: 'javascript', duplication: { minTokens: 5 } });

    expect(defaults.duplication.duplicateBlockGroupCount).toBe(0);
    expect(lowered.duplication.duplicateBlockGroupCount).toBeGreaterThanOrEqual(1);
  });
});

describe('duplication: cross-file clones', () => {
  const fileA = logicClone('alpha', 'console.log("midpoint", total);');
  const fileB = logicClone('renamed', 'console.log("midpoint", total);')
    .replaceAll('item', 'entry')
    .replaceAll('total', 'sum');
  const unrelated = 'export const unrelated = (x) => x * 2;\n';

  it('detects a consistently renamed clone across files', () => {
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', candidates: collectDuplicationCandidates(fileA, { language: 'javascript' }) },
      { file: 'b.js', candidates: collectDuplicationCandidates(fileB, { language: 'javascript' }) },
      { file: 'c.js', candidates: collectDuplicationCandidates(unrelated, { language: 'javascript' }) },
    ]);

    expect(metrics.groups.length).toBe(1);
    expect(metrics.duplicateBlockCount).toBe(1);
    expect(metrics.groups[0]?.files).toEqual(['a.js', 'b.js']);
    expect(metrics.duplicateBlockGroupCountByFile).toEqual({ 'a.js': 1, 'b.js': 1 });
  });

  it('does not match code calling different APIs', () => {
    // Renaming the invoked member (.amount -> .price) is a semantic change, not a rename.
    const differentApi = fileB.replaceAll('.amount', '.price');
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', candidates: collectDuplicationCandidates(fileA, { language: 'javascript' }) },
      { file: 'b.js', candidates: collectDuplicationCandidates(differentApi, { language: 'javascript' }) },
    ]);

    expect(metrics.groups).toEqual([]);
  });

  it('ignores repeats confined to a single file', () => {
    const doubled = fileA + logicClone('beta', 'console.log("midpoint", total);');
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', candidates: collectDuplicationCandidates(doubled, { language: 'javascript' }) },
      { file: 'b.js', candidates: collectDuplicationCandidates(unrelated, { language: 'javascript' }) },
    ]);

    expect(metrics.groups).toEqual([]);
  });

  it('honors the minTokens option when collecting candidates', () => {
    const metrics = measureCrossFileDuplication([
      {
        file: 'a.js',
        candidates: collectDuplicationCandidates(fileA, { language: 'javascript', duplication: { minTokens: 500 } }),
      },
      {
        file: 'b.js',
        candidates: collectDuplicationCandidates(fileB, { language: 'javascript', duplication: { minTokens: 500 } }),
      },
    ]);

    expect(metrics.groups).toEqual([]);
  });

  it('detects a wholly copied file through the container run candidate', () => {
    // Two top-level statements make the file's statement run the matching candidate.
    const wholeFile = 'const limit = 10;\n' + logicClone('gamma', 'console.log("midpoint", total);');
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', candidates: collectDuplicationCandidates(wholeFile, { language: 'javascript' }) },
      { file: 'b.js', candidates: collectDuplicationCandidates(wholeFile, { language: 'javascript' }) },
    ]);

    expect(metrics.groups.length).toBe(1);
    expect(metrics.groups[0]?.occurrences).toEqual([
      { file: 'a.js', startLine: 1, endLine: expect.any(Number) },
      { file: 'b.js', startLine: 1, endLine: expect.any(Number) },
    ]);
  });
});
