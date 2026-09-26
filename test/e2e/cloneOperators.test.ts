import { describe, expect, it } from 'vitest';
import { collectCrossFileDuplicationFileData, measureCode, measureCrossFileDuplication } from '../../src/index.js';

// Recall per edit type: each clone operator (the Type-1/2/3 edit taxonomy of mutation-based
// clone-detector evaluation, as in the clone operators of "Semantic Code Clone Detection: Are We
// There Yet?", 2026) derives a copy of every seed function, and the detector must pair the copy
// with its seed both within one file and across two files. A same-shape function over different
// data must stay unpaired, so recall is never bought with false positives.

interface Seed {
  name: string;
  parameters: string;
  /** One statement per line, each independent of its neighbors except where noted by order. */
  statements: string[];
}

const seeds: Seed[] = [
  {
    name: 'summarizeOrders',
    parameters: 'orders, taxRate',
    statements: [
      'const subtotal = orders.reduce((sum, order) => sum + order.price * order.quantity, 0);',
      'const itemCount = orders.reduce((count, order) => count + order.quantity, 0);',
      "const shippedCount = orders.filter((order) => order.status === 'shipped').length;",
      "const refundedCount = orders.filter((order) => order.status === 'refunded').length;",
      'const tax = Math.round(subtotal * taxRate * 100) / 100;',
      'return { subtotal, tax, total: subtotal + tax, itemCount, shippedCount, refundedCount };',
    ],
  },
  {
    name: 'collectHeaders',
    parameters: 'request, options',
    statements: [
      "const accept = request.headers.get('accept') ?? 'application/json';",
      "const language = request.headers.get('accept-language') ?? options.defaultLanguage;",
      "const agent = request.headers.get('user-agent') ?? 'unknown';",
      "const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();",
      'const timeout = Math.min(options.timeoutMs ?? 5000, options.maxTimeoutMs);',
      'return { accept, language, agent, client: forwarded ?? request.ip, timeout };',
    ],
  },
];

/** Derives the copy, and optionally a rewritten original, from a seed. */
type Operator = (seed: Seed) => string | { original: string; copy: string };

const renderFunction = (name: string, parameters: string, statements: string[]): string =>
  `function ${name}(${parameters}) {\n${statements.map((statement) => `  ${statement}\n`).join('')}}\n`;

const renameIdentifiers = (text: string): string =>
  text
    .replaceAll(/\b(orders|order)\b/g, (word) => (word === 'orders' ? 'purchases' : 'purchase'))
    .replaceAll(/\b(request|options)\b/g, (word) => (word === 'request' ? 'incoming' : 'settings'));

/** Edits every other statement, so no two consecutive statements stay an exact copy. */
const scatterEdits = (statements: string[]): string[] =>
  statements.map((statement, index) =>
    index % 2 === 0 ? statement.replace('const ', 'let ').replace(' ?? ', ' || ') : statement
  );

const wrapperPrologue = [
  "if (logger === undefined || metrics === undefined) throw new TypeError('logger and metrics are required');",
  "const startedAt = performance.now(); logger.info('start', { at: new Date().toISOString() });",
  "metrics.increment('invocations', { source: 'api', region: process.env.REGION ?? 'local' });",
  'const deadline = startedAt + Number(process.env.DEADLINE_MS ?? 250) * 4;',
];

const operators: Record<string, Operator> = {
  'renamed identifiers (Type-2)': (seed) =>
    renameIdentifiers(renderFunction(`${seed.name}Copy`, seed.parameters, seed.statements)),
  'changed literals (Type-2)': (seed) =>
    renderFunction(
      `${seed.name}Copy`,
      seed.parameters,
      seed.statements.map((statement) => statement.replaceAll('100', '1000').replaceAll("'unknown'", "'anonymous'"))
    ),
  'modified statement (Type-3)': (seed) =>
    renderFunction(
      `${seed.name}Copy`,
      seed.parameters,
      seed.statements.map((statement, index) =>
        index === 2 ? statement.replace('const ', 'let ').replace(';', ' || 0;') : statement
      )
    ),
  'inserted statement (Type-3)': (seed) =>
    renderFunction(`${seed.name}Copy`, seed.parameters, [
      ...seed.statements.slice(0, 3),
      "console.debug('checkpoint', Date.now());",
      ...seed.statements.slice(3),
    ]),
  'deleted statement (Type-3)': (seed) =>
    renderFunction(`${seed.name}Copy`, seed.parameters, seed.statements.toSpliced(3, 1)),
  'scattered edits (Type-3)': (seed) =>
    renameIdentifiers(renderFunction(`${seed.name}Copy`, seed.parameters, scatterEdits(seed.statements))),
  'reversed statements (Type-3)': (seed) =>
    renderFunction(`${seed.name}Copy`, seed.parameters, [
      ...seed.statements.slice(0, -1).toReversed(),
      seed.statements.at(-1) ?? '',
    ]),
  'wrapped in added code with scattered edits (Type-3)': (seed) =>
    renderFunction(`${seed.name}Checked`, `${seed.parameters}, logger, metrics`, [
      ...wrapperPrologue,
      ...scatterEdits(seed.statements.slice(0, -1)),
      "if (performance.now() > deadline) logger.warn('slow', { elapsed: performance.now() - startedAt });",
      seed.statements.at(-1) ?? '',
    ]),
  'embedded in different code on both sides with scattered edits (Type-3)': (seed) => ({
    original: renderFunction(`${seed.name}Traced`, `${seed.parameters}, tracer`, [
      "const span = tracer.startSpan('summary', { attributes: { kind: 'internal', version: 3 } });",
      "span.addEvent('begin', { queued: tracer.queueLength(), sampled: tracer.isSampled() });",
      ...seed.statements.slice(0, -1),
      "span.end({ status: 'ok', durationMs: tracer.elapsed(span) });",
      seed.statements.at(-1) ?? '',
    ]),
    copy: renderFunction(`${seed.name}Checked`, `${seed.parameters}, logger, metrics`, [
      ...wrapperPrologue,
      ...scatterEdits(seed.statements.slice(0, -1)),
      "if (performance.now() > deadline) logger.warn('slow', { elapsed: performance.now() - startedAt });",
      seed.statements.at(-1) ?? '',
    ]),
  }),
};

const declareWithLet = (statements: string[]): string[] =>
  statements.map((statement) => statement.replace('const ', 'let '));

/** The 1-based line holding the statement, ignoring its leading `const `/`let ` keyword. */
const lineOf = (code: string, statement: string | undefined): number =>
  code.split('\n').findIndex((line) => statement !== undefined && line.includes(statement.slice(6))) + 1;

/** Same statement shapes as the first seed, but different APIs and data throughout. */
const unrelated = renderFunction('scheduleJobs', 'queue, clock', [
  'const backlog = queue.entries((acc, job) => acc - job.weight / job.priority, 1);',
  'const retries = queue.entries((tally, job) => tally - job.attempts, 1);',
  "const stalled = queue.pending((job) => job.state !== 'running').size;",
  "const expired = queue.pending((job) => job.state !== 'expired').size;",
  'const delay = Math.floor(backlog / clock.tick / 7) * 7;',
  'return { backlog, delay, due: backlog - delay, retries, stalled, expired };',
]);

function linesOf(text: string, offset: number): [number, number] {
  return [offset + 1, offset + text.trimEnd().split('\n').length];
}

function pairsWithinFile(original: string, copy: string): boolean {
  const code = `${original}\n${copy}`;
  const [originalStart, originalEnd] = linesOf(original, 0);
  const [copyStart, copyEnd] = linesOf(copy, original.split('\n').length);
  const { duplicateBlockGroups } = measureCode(code, { language: 'javascript' }).duplication;
  return duplicateBlockGroups.some(
    (group) =>
      group.some((occurrence) => occurrence.startLine <= originalEnd && occurrence.endLine >= originalStart) &&
      group.some((occurrence) => occurrence.startLine <= copyEnd && occurrence.endLine >= copyStart)
  );
}

function pairsAcrossFiles(original: string, copy: string): boolean {
  const { groups } = measureCrossFileDuplication([
    { file: 'a.js', ...collectCrossFileDuplicationFileData(original, { language: 'javascript' }) },
    { file: 'b.js', ...collectCrossFileDuplicationFileData(copy, { language: 'javascript' }) },
  ]);
  return groups.some((group) => group.files.includes('a.js') && group.files.includes('b.js'));
}

describe('clone operators: recall per edit type', () => {
  for (const [operatorName, operator] of Object.entries(operators)) {
    for (const seed of seeds) {
      const derived = operator(seed);
      const { original, copy } =
        typeof derived === 'string'
          ? { original: renderFunction(seed.name, seed.parameters, seed.statements), copy: derived }
          : derived;

      it(`pairs a copy with ${operatorName} of ${seed.name} within one file`, () => {
        expect(pairsWithinFile(original, copy)).toBe(true);
      });

      it(`pairs a copy with ${operatorName} of ${seed.name} across files`, () => {
        expect(pairsAcrossFiles(original, copy)).toBe(true);
      });
    }
  }

  it('groups each embedded copy with its own seed when one function embeds two seeds', () => {
    const [first, second] = seeds;
    if (!first || !second) {
      throw new Error('two seeds are required');
    }
    const combined = renderFunction('combined', `${first.parameters}, ${second.parameters}, logger`, [
      ...scatterEdits(first.statements.slice(0, -1)),
      ...wrapperPrologue.slice(1),
      ...scatterEdits(second.statements.slice(0, -1)),
      'return { subtotal, tax, accept, language, timeout };',
    ]);
    const { groups } = measureCrossFileDuplication(
      Object.entries({
        'combined.js': combined,
        'first.js': renderFunction(first.name, first.parameters, first.statements),
        'second.js': renderFunction(second.name, second.parameters, second.statements),
      }).map(([file, code]) => ({ file, ...collectCrossFileDuplicationFileData(code, { language: 'javascript' }) }))
    );

    expect(groups.map((group) => group.files.toSorted())).toEqual(
      expect.arrayContaining([
        ['combined.js', 'first.js'],
        ['combined.js', 'second.js'],
      ])
    );
    expect(groups.some((group) => group.files.includes('first.js') && group.files.includes('second.js'))).toBe(false);
  });

  it('reports an embedded near-miss copy beside an exact copy in the same function', () => {
    const [first, second] = seeds;
    if (!first || !second) {
      throw new Error('two seeds are required');
    }
    const combined = renderFunction('combined', `${first.parameters}, ${second.parameters}, logger, metrics`, [
      ...first.statements.slice(0, -1),
      ...wrapperPrologue.slice(1),
      ...scatterEdits(second.statements.slice(0, -1)),
      'return { subtotal, tax, accept, language, timeout };',
    ]);
    const originals = [first, second].map((seed) => renderFunction(seed.name, seed.parameters, seed.statements));
    const embeddedLine = lineOf(combined, second.statements[1]);

    const { duplicateLineNumbers } = measureCode([combined, ...originals].join('\n'), {
      language: 'javascript',
    }).duplication;
    expect(duplicateLineNumbers).toContain(embeddedLine);

    const { duplicateLineNumbersByFile } = measureCrossFileDuplication(
      Object.entries({ 'combined.js': combined, 'first.js': originals[0] ?? '', 'second.js': originals[1] ?? '' }).map(
        ([file, code]) => ({ file, ...collectCrossFileDuplicationFileData(code, { language: 'javascript' }) })
      )
    );
    expect(duplicateLineNumbersByFile['combined.js']).toContain(embeddedLine);
  });

  it('reports both regions one pair shares around different middles', () => {
    const [first, second] = seeds;
    if (!first || !second) {
      throw new Error('two seeds are required');
    }
    const sandwich = (name: string, shared: (statements: string[]) => string[], middle: string[]): string =>
      renderFunction(name, `${first.parameters}, ${second.parameters}, logger, metrics, tracer`, [
        ...shared(first.statements.slice(0, -1)),
        ...middle,
        ...shared(second.statements.slice(0, -1)),
        'return { subtotal, tax, accept, language, timeout };',
      ]);
    const traced = sandwich('traced', (statements) => statements, [
      "const span = tracer.startSpan('summary', { attributes: { kind: 'internal', version: 3 } });",
      "span.addEvent('begin', { queued: tracer.queueLength(), sampled: tracer.isSampled() });",
      'const sampler = tracer.sampler || new RatioSampler(tracer.config.ratio);',
      "span.end({ status: 'ok', durationMs: tracer.elapsed(span) });",
      "const baggage = tracer.baggage.getEntries().filter(([key]) => key.startsWith('tenant.'));",
      'for (const [key, value] of baggage) span.setAttribute(key, value.value);',
      "const links = tracer.linksFor(request.headers.get('traceparent')).slice(0, 8);",
      "span.addLinks(links.map((link) => ({ context: link, attributes: { source: 'header' } })));",
    ]);
    const checked = sandwich('checked', declareWithLet, [
      ...wrapperPrologue,
      "const quota = await metrics.quota('summaries', { window: '1m', burst: 20 });",
      "if (quota.remaining <= 0) logger.warn('quota exhausted', { resetAt: quota.resetAt });",
      'const cache = await metrics.cache.lookup(`summary:${orders.length}`, { staleMs: 60000 });',
      "if (cache.hit) logger.debug('cache hit', { key: cache.key, age: Date.now() - cache.storedAt });",
    ]);
    const sharedLines = (code: string): number[] => [
      lineOf(code, first.statements[1]),
      lineOf(code, second.statements[1]),
    ];

    const { duplicateBlockCount, duplicateLineNumbersByFile } = measureCrossFileDuplication(
      Object.entries({ 'traced.js': traced, 'checked.js': checked }).map(([file, code]) => ({
        file,
        ...collectCrossFileDuplicationFileData(code, { language: 'javascript' }),
      }))
    );
    expect(duplicateLineNumbersByFile['checked.js']).toEqual(expect.arrayContaining(sharedLines(checked)));
    // Each shared region is one redundant copy. The two regions form separate groups here, so this
    // pins per-region counting, not how one block's cores within a single group are coalesced.
    expect(duplicateBlockCount).toBe(2);

    const { duplicateBlockCount: withinFileCount, duplicateLineNumbers } = measureCode(`${traced}\n${checked}`, {
      language: 'javascript',
    }).duplication;
    const offset = traced.split('\n').length;
    expect(duplicateLineNumbers).toEqual(expect.arrayContaining(sharedLines(checked).map((line) => line + offset)));
    expect(withinFileCount).toBe(2);
  });

  it('does not pair a same-shape function over different APIs and data', () => {
    const original = renderFunction(seeds[0]?.name ?? '', seeds[0]?.parameters ?? '', seeds[0]?.statements ?? []);

    expect(pairsWithinFile(original, unrelated)).toBe(false);
    expect(pairsAcrossFiles(original, unrelated)).toBe(false);
  });
});
