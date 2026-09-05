import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectCrossFileDuplicationFileData,
  measureCode,
  measureCrossFileDuplication,
  type LanguageName,
} from '../../src/index.js';
import { mergeAdjacentGroups, type CountedOccurrence, type Token, type TokenRange } from '../../src/duplication.js';
import { fixturesDir } from './fixtureCorpus.js';

// End-to-end coverage of the duplication detector across every supported language, plus the
// detector's semantic guarantees: rename tolerance, the literal-density (data-table) guard, gapped
// (Type-3) clone merging, near-miss (Type-3) similarity matching, detection options, and
// cross-file clone detection. The per-language
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
  { file: 'clones.cs', language: 'csharp', groupCount: 1 },
  { file: 'clones.go', language: 'go', groupCount: 1 },
  { file: 'clones.java', language: 'java', groupCount: 1 },
  { file: 'clones.js', language: 'javascript', groupCount: 1 },
  { file: 'clones.jsx', language: 'jsx', groupCount: 2 },
  { file: 'clones.kt', language: 'kotlin', groupCount: 1 },
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
    // Each matched fragment still counts: merging consolidates the grouping, not the counting.
    expect(metrics.duplication.duplicateBlockCount).toBe(2);
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

const prefixHalf = `
  let total = 0;
  let count = 0;
  for (const item of items) {
    if (item.status === 'paid') {
      total = total + item.amount;
      count = count + 1;
    }
  }
`;

const suffixHalf = `
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
`;

/** A single-segment occurrence spanning [start, end) for direct mergeAdjacentGroups tests. */
const occurrence = (start: number, end: number): CountedOccurrence => ({
  segments: [{ startTokenIndex: start, endTokenIndex: end }],
  tokenCount: end - start,
  startTokenIndex: start,
  endTokenIndex: end,
  startIndex: start,
  endIndex: end,
  startLine: start,
  endLine: end,
});

describe('duplication: partial gapped-clone merging', () => {
  // The prefix run appears three times (twice followed by a gap and the suffix, once standalone),
  // the suffix run twice: the fragment group cardinalities differ, so only a partial merge can
  // consolidate the two full copies.
  const fullCopy = (name: string, midStatement: string): string =>
    `function ${name}(items) {${prefixHalf}  ${midStatement}\n${suffixHalf}}\n`;
  const prefixOnly = `function shortTail(items) {${prefixHalf}  return total * count;\n}\n`;
  const code =
    fullCopy('alpha', 'console.log("midpoint", total);') +
    fullCopy('beta', 'console.warn("midpoint", total);') +
    prefixOnly;

  it('merges the paired occurrences and retains the exact group with leftovers', () => {
    const metrics = measureCode(code, { language: 'javascript' });

    // One merged gapped group (the two full copies) plus the retained prefix group with ALL
    // three occurrences; the fully-paired suffix group is subsumed.
    expect(metrics.duplication.duplicateBlockGroupCount).toBe(2);
    const groupSizes = metrics.duplication.duplicateBlockGroups
      .map((group) => group.length)
      .toSorted((left, right) => left - right);
    expect(groupSizes).toEqual([2, 3]);
    // Merged: 2 occurrences x 2 fragments - 2. The retained prefix group's two paired occurrences
    // are already counted inside the merged group, so it adds only its standalone leftover (1);
    // the total matches the unmerged count — no token span is counted twice.
    expect(metrics.duplication.duplicateBlockCount).toBe(3);
    const mergedGroup = metrics.duplication.duplicateBlockGroups.find((group) => group.length === 2) ?? [];
    // Each merged occurrence spans a whole function body, gap included.
    expect((mergedGroup[0]?.endLine ?? 0) - (mergedGroup[0]?.startLine ?? 0)).toBeGreaterThan(15);
  });

  it('does not double-count spans where a retained group overlaps the merged group', () => {
    // alpha repeats the prefix run AFTER its suffix, so the prefix group (x3: alpha start, beta,
    // alpha tail) survives a partial merge alongside the merged gapped group (alpha, beta), and
    // the two OVERLAP. delta is a near-miss copy of beta, so the anchored rebuild coalesces both
    // groups' fragments per copy: overlapping fragments must union, not concatenate — naive
    // summing reported a duplicated segment with tokenCount 171 (union: 128), inflating
    // maxDuplicateBlockSize (171 vs 139) and duplicateBlockCount (5 vs 4).
    const longSuffix = `${suffixHalf.replace('  return total + count + big - small;\n', '')}  let more = 0;
  for (const item of items) {
    if (item.flagged) {
      more = more + item.amount;
    }
  }
  return total + count + big - small + more;
`;
    const alpha = `function alpha(items) {${prefixHalf}  console.log("midpoint", total);\n${longSuffix}${prefixHalf}}\n`;
    const beta = `function beta(items) {${prefixHalf}  console.warn("midpoint", total);\n${longSuffix}}\n`;
    const delta = beta
      .replace('function beta', 'function delta')
      .replaceAll('total = total + item.amount', 'total = total - item.amount')
      .replaceAll('small = small + 1', 'small = small - 1');
    const metrics = measureCode(alpha + beta + delta, { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
    expect(metrics.duplication.duplicateBlockGroups[0]?.length).toBe(4);
    // Segment counts per occurrence are [2, 1, 2, 1]: sum minus the largest.
    expect(metrics.duplication.duplicateBlockCount).toBe(4);
    // The largest occurrence is delta's whole near-miss block, not a double-counted alpha span.
    expect(metrics.duplication.maxDuplicateBlockSize).toBe(139);
  });

  // Three adjacent fragment groups where the first also occurs standalone: after A partially
  // merges with B, the retained A occurrences must not pair AGAIN with C (which would build a
  // competing A+C group); instead the merged A+B group extends with C to the A+B+C fixed point.
  it('extends the merged group across a third adjacent group instead of re-pairing retained occurrences', () => {
    const groupA = [occurrence(0, 10), occurrence(50, 60), occurrence(100, 110)];
    const groupB = [occurrence(12, 22), occurrence(62, 72)];
    const groupC = [occurrence(24, 34), occurrence(74, 84)];

    const merged = mergeAdjacentGroups([groupA, groupB, groupC], 20);

    expect(merged).toHaveLength(2);
    const shapes = merged.map((group) =>
      group.map((entry) => `${entry.startTokenIndex}..${entry.endTokenIndex}/${entry.segments.length}`)
    );
    // Retained A keeps all three occurrences; the single merged group holds both full A+B+C runs.
    expect(shapes).toEqual([
      ['0..10/1', '50..60/1', '100..110/1'],
      ['0..34/3', '50..84/3'],
    ]);
    // A's two paired occurrences are marked as shared with the merged group (no double counting).
    expect(merged[0]?.map((entry) => entry.sharedWithMergedGroup === true)).toEqual([true, true, false]);
  });

  it('loses no duplicated-line coverage compared to unmerged reporting', () => {
    const merged = measureCode(code, { language: 'javascript' });
    const split = measureCode(code, { language: 'javascript', duplication: { maxGapTokens: 0 } });

    expect(split.duplication.duplicateBlockGroupCount).toBe(2);
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

const stringTable = (name: string, quote: string): string => `
function ${name}() {
  return {
    alpha: ${quote}one${quote}, bravo: ${quote}two${quote}, charlie: ${quote}three${quote}, delta: ${quote}four${quote}, echo: ${quote}five${quote},
    foxtrot: ${quote}six${quote}, golf: ${quote}seven${quote}, hotel: ${quote}eight${quote}, india: ${quote}nine${quote}, juliet: ${quote}ten${quote},
    kilo: ${quote}eleven${quote}, lima: ${quote}twelve${quote}, mike: ${quote}thirteen${quote}, november: ${quote}fourteen${quote}, oscar: ${quote}fifteen${quote},
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

  it('matches copied tables across quote styles but not across number values', () => {
    // Formatters rewrite quote style on paste, so delimiters are not literal-value differences.
    const mixedQuotes = measureCode(stringTable('alpha', "'") + stringTable('beta', '"'), { language: 'javascript' });
    const differentWords = measureCode(
      stringTable('alpha', "'") + stringTable('beta', "'").replaceAll('one', 'uno').replaceAll('two', 'dos'),
      { language: 'javascript' }
    );

    expect(mixedQuotes.duplication.duplicateBlockGroupCount).toBe(1);
    expect(differentWords.duplication.duplicateBlockGroupCount).toBe(0);
  });

  it('still detects a statement-run clone containing one dense statement with different values', () => {
    // The run itself is logic-heavy (below the density bound), so the small embedded array's
    // values must not break the match: density is a property of the candidate region, and the
    // coarse per-statement prefilter must not fold values the region-level rule would ignore.
    const metrics = measureCode(statementRun('One', '1, 2, 3, 4') + statementRun('Two', '5, 6, 7, 8'), {
      language: 'javascript',
    });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
  });
});

const statementRun = (suffix: string, arrayValues: string): string => `
const first${suffix} = compute(alpha${suffix}, beta${suffix});
const weights${suffix} = [${arrayValues}];
const second${suffix} = combine(first${suffix}, weights${suffix});
if (second${suffix} > first${suffix}) {
  report(second${suffix} - first${suffix});
} else {
  report(first${suffix} - second${suffix});
}
`;

const scatteredEditClone = (name: string, item: string, weightMember: string, operator: string): string => `
function ${name}(entries, factor) {
  let accumulated = 0;
  for (const ${item} of entries) {
    const scaled = ${item}.${weightMember} * ${item}.quantity;
    if (${item}.special) {
      accumulated ${operator} scaled * 0.5;
    } else {
      accumulated += scaled;
    }
  }
  console.log('accumulated', accumulated, factor);
  return accumulated * (1 + factor);
}
`;

const pythonMethodClone = (name: string, weight: string, operator: string): string => `
    def ${name}(self, entries, factor):
        accumulated = 0
        for item in entries:
            scaled = item.${weight} * item.quantity
            if item.special:
                accumulated ${operator} scaled * 0.5
            else:
                accumulated += scaled
        print('accumulated', accumulated, factor)
        return accumulated * (1 + factor)
`;

const callRunClone = (name: string, first: string, second: string, argA: string, argB: string): string => `
function ${name}(${argA}, ${argB}) {
  ${first}(${argA}, ${argB});
  ${second}(${argA}, ${argB});
  validate${name}(${argA}, ${argB});
  finish${name}(${argA}, ${argB});
  log${name}(${argA}, ${argB});
  emit${name}(${argA}, ${argB});
}
`;

const dispatchPredicate = (name: string, values: string[]): string => `
function ${name}(node) {
  return (
    ${values.map((value) => `node.kind === '${value}'`).join(' ||\n    ')}
  );
}
`;

const selfCloneRun = (suffix: string, argument: string): string => `
  const first${suffix} = compute(alpha${suffix}, beta${suffix});
  const second${suffix} = combine(first${suffix}, ${argument});
  if (second${suffix} > first${suffix}) {
    report(second${suffix} - first${suffix});
  } else {
    report(first${suffix} + second${suffix});
  }
  log('done', first${suffix}, second${suffix});
`;

const fragmentedCopy = (name: string, middle: string, plusOp: string, minusOp: string): string => `
function ${name}(items) {
  let total = 0;
  let count = 0;
  for (const item of items) {
    if (item.status === 'paid') {
      total = total ${plusOp} item.amount;
      count = count + 1;
    }
  }
  ${middle}
  let big = 0;
  let small = 0;
  for (const item of items) {
    if (item.amount > 100) {
      big = big + 1;
    } else {
      small = small ${minusOp} 1;
    }
  }
  return total + count + big - small;
}
`;

const fragmentedMiddle = (name: string, level: string, bonus: string): string =>
  `const ${name} = items.filter((item) => item.${level} > 3).map((item) => item.${bonus}).reduce((a, b) => a + b, 0);`;

describe('duplication: near-miss (Type-3) clones', () => {
  // The two copies differ in a member name, an operator, and scattered renames, so no exact
  // fragment reaches minTokens and gap merging never fires: only the similarity pipeline
  // (n-gram filtration + token-LCS verification) can pair them.
  const nearMissPair =
    scatteredEditClone('totalPrice', 'item', 'price', '+=') + scatteredEditClone('totalWeight', 'row', 'weight', '-=');

  it('detects a clone with scattered small edits that the exact pipeline misses', () => {
    const metrics = measureCode(nearMissPair, { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
    expect(metrics.duplication.duplicateBlockCount).toBe(1);
    const group = metrics.duplication.duplicateBlockGroups[0] ?? [];
    expect(group.length).toBe(2);
    // Each occurrence spans its whole function body, edited tokens included.
    expect((group[0]?.endLine ?? 0) - (group[0]?.startLine ?? 0)).toBeGreaterThan(10);
    expect(metrics.duplication.duplicationRatio).toBeLessThanOrEqual(1);
  });

  it('reports exact matches only when minSimilarityPercent is 100', () => {
    const metrics = measureCode(nearMissPair, {
      language: 'javascript',
      duplication: { minSimilarityPercent: 100 },
    });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(0);
  });

  it('clusters three similar copies into one group', () => {
    const tripled = nearMissPair + scatteredEditClone('totalVolume', 'box', 'volume', '+=');
    const metrics = measureCode(tripled, { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
    expect(metrics.duplication.duplicateBlockGroups[0]?.length).toBe(3);
    expect(metrics.duplication.duplicateBlockCount).toBe(2);
  });

  it('does not pair structurally different functions', () => {
    const different = `
function firstShape(entries) {
  const seen = new Map();
  for (const entry of entries) {
    seen.set(entry.key, (seen.get(entry.key) ?? 0) + entry.count);
  }
  return [...seen.values()].filter((value) => value > 10).map((value) => value * 2);
}
function secondShape(limit, step) {
  let cursor = 0;
  const results = [];
  while (cursor < limit) {
    try {
      results.push(fetchChunk(cursor, step));
    } catch (error) {
      console.error('chunk failed', cursor, error);
      break;
    }
    cursor += step;
  }
  return results;
}
`;
    const metrics = measureCode(different, { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(0);
  });

  it('appends an edited third copy to the exact group of its two identical siblings', () => {
    // Copy-paste-then-edit: two identical copies form an exact group; the edited copy must still
    // be found by anchoring on a reported block instead of being suppressed by it.
    const threeCopies =
      scatteredEditClone('alpha', 'item', 'price', '+=') +
      scatteredEditClone('beta', 'item', 'price', '+=') +
      scatteredEditClone('gamma', 'row', 'weight', '-=');
    const metrics = measureCode(threeCopies, { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
    expect(metrics.duplication.duplicateBlockGroups[0]?.length).toBe(3);
    expect(metrics.duplication.duplicateBlockCount).toBe(2);
  });

  it('merges two exact pairs bridged by a fifth similar copy into one group', () => {
    // The bridge copy is similar to both exact pairs, so the whole verified component must
    // become ONE group instead of extending only the first pair.
    const bridged =
      scatteredEditClone('p1', 'item', 'price', '+=') +
      scatteredEditClone('p2', 'item', 'price', '+=') +
      scatteredEditClone('w1', 'row', 'weight', '-=') +
      scatteredEditClone('w2', 'row', 'weight', '-=') +
      scatteredEditClone('v1', 'box', 'volume', '+=');
    const metrics = measureCode(bridged, { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
    expect(metrics.duplication.duplicateBlockGroups[0]?.length).toBe(5);
    expect(metrics.duplication.duplicateBlockCount).toBe(4);
  });

  it('coalesces exact fragments per copy and counts mixed groups order-independently', () => {
    // A and B share an exact prefix AND an exact suffix, split by over-large differing middles
    // (two exact groups, multi-fragment copies); C carries scattered operator edits so only the
    // near-miss phase finds it. The component must become ONE group with ONE occurrence per copy
    // (A's and B's prefix+suffix fragments coalesce), and the fragment-weighted count must be 3
    // in every source order: without the coalescing and sum-minus-max counting, the same family
    // reported five occurrences and a source-order-dependent count.
    const exactA = fragmentedCopy('alpha', fragmentedMiddle('bonusA', 'level', 'bonus'), '+', '+');
    const exactB = fragmentedCopy('beta', fragmentedMiddle('bonusB', 'rank', 'extra'), '+', '+');
    const edited = fragmentedCopy('gamma', fragmentedMiddle('bonusC', 'depth', 'weight'), '-', '-');

    for (const code of [exactA + exactB + edited, edited + exactA + exactB]) {
      const metrics = measureCode(code, { language: 'javascript' });
      expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
      expect(metrics.duplication.duplicateBlockGroups[0]?.length).toBe(3);
      expect(metrics.duplication.duplicateBlockCount).toBe(3);
    }
  });

  it('keeps a block-internal self-clone as separate copies when a near-miss sibling joins', () => {
    // Two occurrences of the SAME exact group are distinct copies (a repeated run inside one
    // function); anchoring a similar sibling must add a third occurrence, not collapse the two
    // internal copies into one span.
    const selfClone = `function alpha(input) {${selfCloneRun('A', 'input')}${selfCloneRun('B', 'input')}}\n`;
    const sibling = `function beta(value) {${selfCloneRun('C', 'value')}${selfCloneRun('D', 'value')}}\n`
      .replaceAll('report(secondC - firstC)', 'report(secondC * firstC)')
      .replaceAll('report(firstD + secondD)', 'report(firstD * secondD)')
      .replaceAll("log('done'", "log('finished'");
    const alone = measureCode(selfClone, { language: 'javascript' });
    const withSibling = measureCode(selfClone + sibling, { language: 'javascript' });

    expect(alone.duplication.duplicateBlockGroups[0]?.length).toBe(2);
    expect(withSibling.duplication.duplicateBlockGroupCount).toBe(1);
    expect(withSibling.duplication.duplicateBlockGroups[0]?.length).toBe(3);
    expect(withSibling.duplication.duplicateBlockCount).toBe(2);
  });

  it('detects clones nested inside a single enclosing wrapper', () => {
    // A describe()/IIFE wrapper is itself an eligible block spanning the whole file; candidate
    // selection must descend through it instead of comparing the lone wrapper to nothing.
    const wrapped = `describe('suite', () => {${nearMissPair}});`;
    const iife = `(function () {${nearMissPair}})();`;

    expect(measureCode(wrapped, { language: 'javascript' }).duplication.duplicateBlockGroupCount).toBe(1);
    expect(measureCode(iife, { language: 'javascript' }).duplication.duplicateBlockGroupCount).toBe(1);
  });

  it('detects clones inside a single Python class body', () => {
    const singleClass = `class Totals:${pythonMethodClone('total_price', 'price', '+=')}${pythonMethodClone('total_weight', 'weight', '-=')}`;

    expect(measureCode(singleClass, { language: 'python' }).duplication.duplicateBlockGroupCount).toBe(1);
  });

  it('does not pair same-skeleton functions calling entirely different APIs', () => {
    // Punctuation and keywords dominate a token-level LCS, so without the content gate these two
    // unrelated call runs would exceed 70% structural similarity.
    const code =
      callRunClone('One', 'parse', 'persist', 'record', 'ctx') +
      callRunClone('Two', 'connect', 'upload', 'asset', 'session');

    expect(measureCode(code, { language: 'javascript' }).duplication.duplicateBlockGroupCount).toBe(0);
  });

  it('does not pair dispatch predicates differing in every literal value', () => {
    // `x.kind === '...' || ...` chains sit below the literal-density bound yet reduce to a
    // content-free skeleton; folding literal values plus the content gate must reject them. The
    // branch counts differ so the exact pipeline (which abstracts literals by design) cannot
    // match either: this pins the near-miss phase's rejection specifically.
    const code =
      dispatchPredicate('isLoop', ['for', 'while', 'do', 'for_in', 'for_of', 'loop', 'repeat', 'until']) +
      dispatchPredicate('isJump', ['break', 'continue', 'return', 'throw', 'goto', 'yield', 'await', 'halt', 'exit']);
    const metrics = measureCode(code, { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(0);
  });

  it('honors a stricter similarity threshold', () => {
    // Consistent renames are anonymized away, so only the member name and the operator differ:
    // the pair sits just below 99% similarity.
    const strict = measureCode(nearMissPair, { language: 'javascript', duplication: { minSimilarityPercent: 99 } });
    const lenient = measureCode(nearMissPair, { language: 'javascript', duplication: { minSimilarityPercent: 70 } });

    expect(strict.duplication.duplicateBlockGroupCount).toBe(0);
    expect(lenient.duplication.duplicateBlockGroupCount).toBe(1);
  });
});

describe('duplication: fingerprint integrity', () => {
  it('does not equate regions whose only difference is a djb2-colliding token', () => {
    // hashText('p1v') === hashText('p70'): with a single shared per-token hash the whole-body
    // fingerprints would collide and the two functions would match exactly (one group even with
    // gap merging disabled). The correct result under maxGapTokens: 0 is the two exact halves
    // around the differing member access, i.e. two groups.
    const caller = (name: string, member: string): string =>
      logicClone(name, `console.log("midpoint", total.${member});`);
    const metrics = measureCode(caller('alpha', 'p1v') + caller('beta', 'p70'), {
      language: 'javascript',
      duplication: { maxGapTokens: 0 },
    });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(2);
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

const embeddedRun = (a: string, b: string): string => `
  const first = compute(${a}, seed);
  const second = combine(first, ${b});
  if (second > first) {
    report(second - first);
  } else {
    report(first + second);
  }
  log('done', first, second);
`;

describe('duplication: cross-file clones', () => {
  const fileA = logicClone('alpha', 'console.log("midpoint", total);');
  const fileB = logicClone('renamed', 'console.log("midpoint", total);')
    .replaceAll('item', 'entry')
    .replaceAll('total', 'sum');
  const unrelated = 'export const unrelated = (x) => x * 2;\n';

  it('detects a consistently renamed clone across files', () => {
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectCrossFileDuplicationFileData(fileA, { language: 'javascript' }) },
      { file: 'b.js', ...collectCrossFileDuplicationFileData(fileB, { language: 'javascript' }) },
      { file: 'c.js', ...collectCrossFileDuplicationFileData(unrelated, { language: 'javascript' }) },
    ]);

    expect(metrics.groups.length).toBe(1);
    expect(metrics.duplicateBlockCount).toBe(1);
    expect(metrics.groups[0]?.files).toEqual(['a.js', 'b.js']);
    expect(metrics.duplicateBlockGroupCountByFile).toEqual({ 'a.js': 1, 'b.js': 1 });
  });

  it('reports exact matched code lines per file and omits candidates-only files', () => {
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectCrossFileDuplicationFileData(fileA, { language: 'javascript' }) },
      { file: 'b.js', candidates: collectCrossFileDuplicationFileData(fileB, { language: 'javascript' }).candidates },
    ]);

    expect(metrics.groups.length).toBe(1);
    const occurrence = metrics.groups[0]?.occurrences.find(({ file }) => file === 'a.js');
    const aLines = metrics.duplicateLineNumbersByFile['a.js'] ?? [];
    // a.js supplied its token stream, so its entry lists exactly the matched code lines: sorted,
    // within the occurrence's bounds, and no larger than the file's code lines.
    expect(aLines.length).toBeGreaterThan(0);
    expect(aLines).toEqual([...aLines].toSorted((left, right) => left - right));
    expect(aLines[0]).toBeGreaterThanOrEqual(occurrence?.startLine ?? 0);
    expect(aLines.at(-1)).toBeLessThanOrEqual(occurrence?.endLine ?? 0);
    // b.js supplied only candidates: its matched lines are unknowable, so it has no entry rather
    // than an approximate bounding range.
    expect(Object.hasOwn(metrics.duplicateLineNumbersByFile, 'b.js')).toBe(false);
  });

  it('does not match code calling different APIs', () => {
    // Renaming the invoked member (.amount -> .price) is a semantic change, not a rename.
    const differentApi = fileB.replaceAll('.amount', '.price');
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectCrossFileDuplicationFileData(fileA, { language: 'javascript' }) },
      { file: 'b.js', ...collectCrossFileDuplicationFileData(differentApi, { language: 'javascript' }) },
    ]);

    expect(metrics.groups).toEqual([]);
  });

  it('ignores repeats confined to a single file', () => {
    const doubled = fileA + logicClone('beta', 'console.log("midpoint", total);');
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectCrossFileDuplicationFileData(doubled, { language: 'javascript' }) },
      { file: 'b.js', ...collectCrossFileDuplicationFileData(unrelated, { language: 'javascript' }) },
    ]);

    expect(metrics.groups).toEqual([]);
  });

  it('honors the minTokens option', () => {
    // The option applies to collection (catalogued candidates) and to the project-level window
    // matching, so it must be passed to both.
    const metrics = measureCrossFileDuplication(
      [
        {
          file: 'a.js',
          ...collectCrossFileDuplicationFileData(fileA, { language: 'javascript', duplication: { minTokens: 500 } }),
        },
        {
          file: 'b.js',
          ...collectCrossFileDuplicationFileData(fileB, { language: 'javascript', duplication: { minTokens: 500 } }),
        },
      ],
      { minTokens: 500 }
    );

    expect(metrics.groups).toEqual([]);
  });

  it('counts groups correctly for files named like Object.prototype members', () => {
    const metrics = measureCrossFileDuplication([
      { file: 'constructor', ...collectCrossFileDuplicationFileData(fileA, { language: 'javascript' }) },
      { file: 'toString', ...collectCrossFileDuplicationFileData(fileA, { language: 'javascript' }) },
    ]);

    expect(metrics.duplicateBlockGroupCountByFile).toEqual({ constructor: 1, toString: 1 });
  });

  it('detects a wholly copied single-statement file', () => {
    // A lone top-level statement that is not a catalogued block type (an exported table) must
    // still produce a full-run candidate.
    const singleStatementFile = `export const lookup = {
  alpha: 'one', bravo: 'two', charlie: 'three', delta: 'four', echo: 'five',
  foxtrot: 'six', golf: 'seven', hotel: 'eight', india: 'nine', juliet: 'ten',
  kilo: 'eleven', lima: 'twelve', mike: 'thirteen', november: 'fourteen', oscar: 'fifteen',
};
`;
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectCrossFileDuplicationFileData(singleStatementFile, { language: 'javascript' }) },
      { file: 'b.js', ...collectCrossFileDuplicationFileData(singleStatementFile, { language: 'javascript' }) },
    ]);

    expect(metrics.groups.length).toBe(1);
    expect(metrics.groups[0]?.files).toEqual(['a.js', 'b.js']);
  });

  it('detects a wholly copied file through the container run candidate', () => {
    // Two top-level statements make the file's statement run the matching candidate.
    const wholeFile = 'const limit = 10;\n' + logicClone('gamma', 'console.log("midpoint", total);');
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectCrossFileDuplicationFileData(wholeFile, { language: 'javascript' }) },
      { file: 'b.js', ...collectCrossFileDuplicationFileData(wholeFile, { language: 'javascript' }) },
    ]);

    expect(metrics.groups.length).toBe(1);
    expect(metrics.groups[0]?.occurrences).toEqual([
      { file: 'a.js', startLine: 1, endLine: expect.any(Number) },
      { file: 'b.js', startLine: 1, endLine: expect.any(Number) },
    ]);
  });

  it('matches a copy-pasted statement run embedded in different surrounding code', () => {
    // The run is neither a catalogued block nor a full container run in either file, so only the
    // project-level window index can see that it repeats.
    const fileA = `function alpha(items) {\n  initialize(items);${embeddedRun('items', 'items')}}\n`;
    const fileB = `function beta(rows) {\n  const prepared = prepare(rows);${embeddedRun('rows', 'prepared')}}\n`;
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectCrossFileDuplicationFileData(fileA, { language: 'javascript' }) },
      { file: 'b.js', ...collectCrossFileDuplicationFileData(fileB, { language: 'javascript' }) },
    ]);

    expect(metrics.groups.length).toBe(1);
    expect(metrics.groups[0]?.files).toEqual(['a.js', 'b.js']);
    // The matched region is the embedded run, not the whole differing function body.
    expect(metrics.groups[0]?.occurrences[0]?.startLine).toBeGreaterThan(2);
  });

  it('merges cross-file fragments split by one edited statement under maxGapTokens', () => {
    // The two functions differ by one middle statement (log vs warn), so the exact prefix and
    // suffix runs match across files and must merge into ONE gapped cross-file group.
    const gappedA = logicClone('alpha', 'console.log("midpoint", total);');
    const gappedB = logicClone('renamed', 'console.warn("midpoint", sum);')
      .replaceAll('item', 'entry')
      .replaceAll('total', 'sum');
    const sources = [
      { file: 'a.js', ...collectCrossFileDuplicationFileData(gappedA, { language: 'javascript' }) },
      { file: 'b.js', ...collectCrossFileDuplicationFileData(gappedB, { language: 'javascript' }) },
    ];
    const merged = measureCrossFileDuplication(sources);
    const split = measureCrossFileDuplication(sources, { maxGapTokens: 0 });

    expect(merged.groups.length).toBe(1);
    expect(merged.groups[0]?.files).toEqual(['a.js', 'b.js']);
    // Each merged occurrence spans the whole function body, gap included.
    const occurrence = merged.groups[0]?.occurrences[0];
    expect((occurrence?.endLine ?? 0) - (occurrence?.startLine ?? 0)).toBeGreaterThan(15);
    // Both matched fragments still count, mirroring within-file gap-merge counting.
    expect(merged.duplicateBlockCount).toBe(2);
    expect(split.groups.length).toBe(2);
  });

  it('handles project-scale window candidate counts', () => {
    // 220 files x 600 shared statement pairs yield ~132k cross-file window candidates, past V8's
    // ~124k call-argument limit: spreading the candidate array (e.g. `push(...)`) crashes with
    // RangeError under Node while Bun/JSC tolerates it, so this guards the accumulation pattern.
    // Tokens are synthesized directly (no parsing) to keep the corpus cheap: each pair is its own
    // two-statement container whose window repeats in every file, so each occurrence is maximal.
    const files = [];
    for (let fileIndex = 0; fileIndex < 220; fileIndex++) {
      const tokens: Token[] = [];
      const containerStatements: TokenRange[][] = [];
      for (let pair = 0; pair < 600; pair++) {
        const statements: TokenRange[] = [];
        for (const part of ['a', 'b']) {
          const start = tokens.length;
          for (let position = 0; position < 3; position++) {
            const text = `s${pair}${part}${position}`;
            let hash = 5381;
            let hash2 = 2_166_136_261;
            for (const character of text) {
              hash = Math.imul(hash, 33) + (character.codePointAt(0) ?? 0);
              hash2 = Math.imul(hash2 ^ (character.codePointAt(0) ?? 0), 16_777_619);
            }
            tokens.push({ kind: 'text', text, textHash: hash, textHash2: hash2, startRow: start, endRow: start });
          }
          statements.push({
            startTokenIndex: start,
            endTokenIndex: tokens.length,
            startIndex: start,
            endIndex: tokens.length,
            startLine: start,
            endLine: tokens.length,
          });
        }
        containerStatements.push(statements);
      }
      files.push({ file: `file${fileIndex}.js`, candidates: [], tokens, containerStatements });
    }

    const metrics = measureCrossFileDuplication(files, { minTokens: 6, maxGapTokens: 0 });

    expect(metrics.groups.length).toBeGreaterThan(0);
  });
});

describe('duplication: invariants over the per-language fixtures', () => {
  for (const { file, language } of fixtureExpectations) {
    it(`derives the ratio from code lines and keeps line numbers inside reported blocks in ${language}`, () => {
      const metrics = measureCode(readDuplicationFixture(file), { language });
      const { duplication, lines } = metrics;

      expect(duplication.duplicationRatio).toBe(duplication.duplicateLineCount / lines.code);
      expect(duplication.duplicateLineNumbers).toHaveLength(duplication.duplicateLineCount);
      expect(duplication.duplicateLineNumbers).toEqual([...duplication.duplicateLineNumbers].toSorted((a, b) => a - b));
      // Every duplicated line lies inside some reported occurrence, and each occurrence covers
      // at least one duplicated line.
      const occurrences = duplication.duplicateBlockGroups.flat();
      for (const line of duplication.duplicateLineNumbers) {
        expect(occurrences.some(({ startLine, endLine }) => startLine <= line && line <= endLine)).toBe(true);
      }
      for (const { startLine, endLine } of occurrences) {
        expect(duplication.duplicateLineNumbers.some((line) => startLine <= line && line <= endLine)).toBe(true);
      }
    });
  }

  it('reports the exact duplicated lines of the renamed pair, excluding the comment and blank lines', () => {
    const metrics = measureCode(readDuplicationFixture('clones.js'), { language: 'javascript' });
    // Lines 2-13 and 15-26 hold the two copies; the leading comment and the tables are not counted.
    expect(metrics.duplication.duplicateLineNumbers).toEqual([
      ...Array.from({ length: 12 }, (_, index) => 2 + index),
      ...Array.from({ length: 12 }, (_, index) => 15 + index),
    ]);
    expect(metrics.duplication.duplicateBlockGroups).toEqual([
      [
        { startLine: 2, endLine: 13 },
        { startLine: 15, endLine: 26 },
      ],
    ]);
  });
});

describe('duplication: cross-file clones in every language', () => {
  // The two renamed copies of each per-language fixture are separated into two files, so the
  // cross-file matcher must find exactly the one clone pair the within-file detector finds; the
  // literal-dense tables (where present) stay excluded.
  for (const { file, language } of fixtureExpectations) {
    it(`matches the renamed copy across files in ${language}`, () => {
      const code = readDuplicationFixture(file);
      const blocks = code.split(/\n(?=\S)/u).filter((block) => block.trim().length > 0);
      const firstClone = blocks.find((block) => /summarize_?orders|OrderCard/iu.test(block));
      const secondClone = blocks.find((block) => /summarize_?refunds|RefundCard/iu.test(block));
      expect(firstClone, `fixture ${file} has no orders clone`).toBeDefined();
      expect(secondClone, `fixture ${file} has no refunds clone`).toBeDefined();
      const wrap = (block: string): string =>
        language === 'python' || language === 'ruby'
          ? `${block}\n`
          : `${code.slice(0, code.indexOf(blocks[0] ?? ''))}${block}\n`;

      const metrics = measureCrossFileDuplication([
        { file: 'a', ...collectCrossFileDuplicationFileData(wrap(firstClone ?? ''), { language }) },
        { file: 'b', ...collectCrossFileDuplicationFileData(wrap(secondClone ?? ''), { language }) },
      ]);

      expect(metrics.groups.map((group) => group.files)).toEqual([['a', 'b']]);
      expect(metrics.duplicateBlockCount).toBe(1);
      expect(Object.keys(metrics.duplicateLineNumbersByFile).toSorted()).toEqual(['a', 'b']);
    });
  }
});

describe('duplication: cross-file grouping and reporting', () => {
  const copy = (name: string): string => logicClone(name, 'console.log("midpoint", total);');

  it('groups three files sharing one clone and orders groups by size', () => {
    // a.js and c.js additionally share a small statement run, separated from the big clone by a
    // statement unique to each file so the two files do not match as a whole; gap merging is off
    // so the separator does not fuse the two groups into one gapped a/c group.
    const smallRun = embeddedRun('items', 'items');
    const metrics = measureCrossFileDuplication(
      [
        {
          file: 'a.js',
          ...collectCrossFileDuplicationFileData(`${copy('alpha')}alpha(1);\n${smallRun}`, { language: 'javascript' }),
        },
        { file: 'b.js', ...collectCrossFileDuplicationFileData(copy('beta'), { language: 'javascript' }) },
        {
          file: 'c.js',
          ...collectCrossFileDuplicationFileData(`${copy('gamma')}gamma(1, 2);\n${smallRun}`, {
            language: 'javascript',
          }),
        },
      ],
      { maxGapTokens: 0 }
    );

    expect(metrics.groups).toHaveLength(2);
    // The larger (three-file) group comes first; the small run pairs only a.js and c.js.
    expect(metrics.groups.map((group) => group.files)).toEqual([
      ['a.js', 'b.js', 'c.js'],
      ['a.js', 'c.js'],
    ]);
    expect(metrics.groups[0]?.tokenCount ?? 0).toBeGreaterThan(metrics.groups[1]?.tokenCount ?? 0);
    expect(metrics.groups[0]?.occurrences.map(({ file }) => file)).toEqual(['a.js', 'b.js', 'c.js']);
    // Two redundant copies of the big clone plus one of the small run.
    expect(metrics.duplicateBlockCount).toBe(3);
    expect(metrics.duplicateBlockGroupCountByFile).toEqual({ 'a.js': 2, 'b.js': 1, 'c.js': 2 });
  });

  it('applies near-miss matching within files only, so a scattered-edit copy across files is not a clone', () => {
    const first = scatteredEditClone('totalPrice', 'item', 'price', '+=');
    const second = scatteredEditClone('totalWeight', 'row', 'weight', '-=');
    expect(measureCode(first + second, { language: 'javascript' }).duplication.duplicateBlockGroupCount).toBe(1);

    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectCrossFileDuplicationFileData(first, { language: 'javascript' }) },
      { file: 'b.js', ...collectCrossFileDuplicationFileData(second, { language: 'javascript' }) },
    ]);
    expect(metrics.groups).toEqual([]);
  });

  it('handles empty files and files without candidates', () => {
    const metrics = measureCrossFileDuplication([
      { file: 'empty.js', ...collectCrossFileDuplicationFileData('', { language: 'javascript' }) },
      { file: 'tiny.js', ...collectCrossFileDuplicationFileData('export const x = 1;\n', { language: 'javascript' }) },
      { file: 'a.js', ...collectCrossFileDuplicationFileData(copy('alpha'), { language: 'javascript' }) },
    ]);
    expect(metrics).toEqual({
      duplicateBlockCount: 0,
      duplicateBlockGroupCountByFile: {},
      duplicateLineNumbersByFile: {},
      groups: [],
    });
  });

  it('excludes comment and blank lines inside a cross-file occurrence from its line numbers', () => {
    const commented = copy('alpha').replace('  let count = 0;', '  // note\n\n  let count = 0;');
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectCrossFileDuplicationFileData(commented, { language: 'javascript' }) },
      { file: 'b.js', ...collectCrossFileDuplicationFileData(copy('beta'), { language: 'javascript' }) },
    ]);
    const occurrence = metrics.groups[0]?.occurrences.find(({ file }) => file === 'a.js');
    const lines = metrics.duplicateLineNumbersByFile['a.js'] ?? [];
    const commentLine = commented.split('\n').findIndex((line) => line.includes('// note')) + 1;
    expect(occurrence?.startLine ?? 0).toBeLessThan(commentLine);
    expect(occurrence?.endLine ?? 0).toBeGreaterThan(commentLine + 1);
    expect(lines).not.toContain(commentLine);
    expect(lines).not.toContain(commentLine + 1);
    // The counted lines are exactly the occurrence span minus the two non-code lines.
    expect(lines).toHaveLength((occurrence?.endLine ?? 0) - (occurrence?.startLine ?? 0) + 1 - 2);
  });
});

const javaMethod = (name: string): string =>
  `  int ${name}(int[] xs) {\n    int total = 0;\n    int count = 0;\n    for (int x : xs) {\n      if (x > 0) {\n        total += x;\n        count += 1;\n      }\n    }\n    return count == 0 ? 0 : total / count;\n  }\n`;

describe('duplication: within-file statement runs and containers', () => {
  it('detects a repeated statement run embedded in two functions with different surroundings', () => {
    const code =
      `function alpha(items) {\n  initialize(items);${embeddedRun('items', 'items')}}\n` +
      `function beta(rows) {\n  const prepared = prepare(rows);\n  const extra = rows.length;${embeddedRun('rows', 'rows')}}\n`;
    const metrics = measureCode(code, { language: 'javascript' });

    expect(metrics.duplication.duplicateBlockGroupCount).toBe(1);
    // The matched region is the embedded run (lines 3-10 and 15-22), not either whole function.
    expect(metrics.duplication.duplicateBlockGroups).toEqual([
      [
        { startLine: 3, endLine: 10 },
        { startLine: 15, endLine: 22 },
      ],
    ]);
    expect(metrics.duplication.duplicateLineNumbers).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18, 19, 20, 21, 22]);
  });

  it('does not report a homogeneous run of identically shaped statements as a clone', () => {
    // Thirty identical statements could be split into two "copies" of fifteen; a window whose
    // statements all share one shape is a preamble, not copy-paste.
    const homogeneous = Array.from({ length: 30 }, () => 'counter += 1;').join('\n');
    expect(measureCode(homogeneous, { language: 'javascript' }).duplication.duplicateBlockGroupCount).toBe(0);
  });

  it('detects clones between methods of one class in class-based languages', () => {
    const java = `class A {\n${javaMethod('alpha')}${javaMethod('beta')}}\n`;
    const csharp = java.replaceAll('for (int x : xs)', 'foreach (int x in xs)');
    expect(measureCode(java, { language: 'java' }).duplication.duplicateBlockGroupCount).toBe(1);
    expect(measureCode(csharp, { language: 'csharp' }).duplication.duplicateBlockGroupCount).toBe(1);
  });
});
