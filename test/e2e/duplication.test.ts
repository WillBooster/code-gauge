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
    // Merged: 2 occurrences x 2 fragments - 2; retained prefix: 3 occurrences - 1.
    expect(metrics.duplication.duplicateBlockCount).toBe(4);
    const mergedGroup = metrics.duplication.duplicateBlockGroups.find((group) => group.length === 2) ?? [];
    // Each merged occurrence spans a whole function body, gap included.
    expect((mergedGroup[0]?.endLine ?? 0) - (mergedGroup[0]?.startLine ?? 0)).toBeGreaterThan(15);
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
      { file: 'a.js', ...collectDuplicationCandidates(fileA, { language: 'javascript' }) },
      { file: 'b.js', ...collectDuplicationCandidates(fileB, { language: 'javascript' }) },
      { file: 'c.js', ...collectDuplicationCandidates(unrelated, { language: 'javascript' }) },
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
      { file: 'a.js', ...collectDuplicationCandidates(fileA, { language: 'javascript' }) },
      { file: 'b.js', ...collectDuplicationCandidates(differentApi, { language: 'javascript' }) },
    ]);

    expect(metrics.groups).toEqual([]);
  });

  it('ignores repeats confined to a single file', () => {
    const doubled = fileA + logicClone('beta', 'console.log("midpoint", total);');
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectDuplicationCandidates(doubled, { language: 'javascript' }) },
      { file: 'b.js', ...collectDuplicationCandidates(unrelated, { language: 'javascript' }) },
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
          ...collectDuplicationCandidates(fileA, { language: 'javascript', duplication: { minTokens: 500 } }),
        },
        {
          file: 'b.js',
          ...collectDuplicationCandidates(fileB, { language: 'javascript', duplication: { minTokens: 500 } }),
        },
      ],
      { minTokens: 500 }
    );

    expect(metrics.groups).toEqual([]);
  });

  it('counts groups correctly for files named like Object.prototype members', () => {
    const metrics = measureCrossFileDuplication([
      { file: 'constructor', ...collectDuplicationCandidates(fileA, { language: 'javascript' }) },
      { file: 'toString', ...collectDuplicationCandidates(fileA, { language: 'javascript' }) },
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
      { file: 'a.js', ...collectDuplicationCandidates(singleStatementFile, { language: 'javascript' }) },
      { file: 'b.js', ...collectDuplicationCandidates(singleStatementFile, { language: 'javascript' }) },
    ]);

    expect(metrics.groups.length).toBe(1);
    expect(metrics.groups[0]?.files).toEqual(['a.js', 'b.js']);
  });

  it('detects a wholly copied file through the container run candidate', () => {
    // Two top-level statements make the file's statement run the matching candidate.
    const wholeFile = 'const limit = 10;\n' + logicClone('gamma', 'console.log("midpoint", total);');
    const metrics = measureCrossFileDuplication([
      { file: 'a.js', ...collectDuplicationCandidates(wholeFile, { language: 'javascript' }) },
      { file: 'b.js', ...collectDuplicationCandidates(wholeFile, { language: 'javascript' }) },
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
      { file: 'a.js', ...collectDuplicationCandidates(fileA, { language: 'javascript' }) },
      { file: 'b.js', ...collectDuplicationCandidates(fileB, { language: 'javascript' }) },
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
      { file: 'a.js', ...collectDuplicationCandidates(gappedA, { language: 'javascript' }) },
      { file: 'b.js', ...collectDuplicationCandidates(gappedB, { language: 'javascript' }) },
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
});
