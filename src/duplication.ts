import type Parser from 'tree-sitter';
import { dedupeByRegion, selectMaximalGroups } from './duplicateSelection.js';
import type { DuplicationMetrics, DuplicationOptions } from './types.js';

/**
 * Block-like nodes considered as whole-subtree duplicate candidates. Detection itself is
 * token-based, so this set only decides which subtrees are compared; Ruby's keyword-like node
 * types (`if`, `case`, ...) are safe here because only named nodes become candidates.
 */
const duplicateBlockTypes = new Set([
  'statement_block',
  'block',
  'compound_statement',
  'body_statement',
  'constructor_body',
  'do_block',
  'if_statement',
  'for_statement',
  'for_in_statement',
  'enhanced_for_statement',
  'for_range_loop',
  'while_statement',
  'do_statement',
  'try_statement',
  'try_with_resources_statement',
  'with_statement',
  'switch_statement',
  'switch_expression',
  'switch_case',
  'switch_block_statement_group',
  'switch_rule',
  'case_clause',
  'case_statement',
  'match_statement',
  'match_arm',
  'except_clause',
  'catch_clause',
  'finally_clause',
  'elif_clause',
  'ensure',
  'expression_statement',
  'return_statement',
  'return_expression',
  'if_expression',
  'for_expression',
  'while_expression',
  'loop_expression',
  'match_expression',
  'jsx_element',
  'jsx_self_closing_element',
  // Ruby
  'if',
  'unless',
  'case',
  'case_match',
  'while',
  'until',
  'for',
  'begin',
  'when',
]);

/** Nodes whose direct named children form statement sequences scanned for copy-pasted runs. */
const statementContainerTypes = new Set([
  'program',
  'source_file',
  'translation_unit',
  'module',
  'statement_block',
  'block',
  'compound_statement',
  'body_statement',
  'constructor_body',
  'class_body',
  'block_body',
  'do_block',
  // Ruby loop bodies are a named `do` node, and `ensure` holds statements directly.
  'do',
  'ensure',
  'then',
  'else',
  // Case-like nodes hold their statements directly, without an inner block.
  'case_statement',
  'switch_block_statement_group',
  'switch_rule',
  'expression_case',
  'type_case',
  'communication_case',
  'default_case',
]);

/**
 * Identifier leaves anonymized by occurrence order so consistently renamed copies still match.
 * Member/type names (`property_identifier`, `field_identifier`, `type_identifier`, ...) are kept
 * verbatim instead: calling a different API is a semantic difference, not a rename.
 */
const anonymizedIdentifierTypes = new Set([
  'identifier',
  'constant',
  'instance_variable',
  'class_variable',
  'global_variable',
]);

/**
 * JS shorthand properties (`{ alpha }`) both emit the property name (semantic output shape) and
 * reference the binding, so they tokenize as the desugared `name: binding` — one verbatim text
 * token plus one anonymized id token — matching how the explicit form is tokenized.
 */
const shorthandPropertyTypes = new Set(['shorthand_property_identifier', 'shorthand_property_identifier_pattern']);

/** Literal leaves normalized to a kind tag so copies differing only in literal values still match. */
const literalKindByType = new Map([
  ['number', '#num'],
  ['number_literal', '#num'],
  ['integer', '#num'],
  ['float', '#num'],
  ['integer_literal', '#num'],
  ['float_literal', '#num'],
  ['int_literal', '#num'],
  ['rune_literal', '#char'],
  ['imaginary_literal', '#num'],
  ['decimal_integer_literal', '#num'],
  ['hex_integer_literal', '#num'],
  ['octal_integer_literal', '#num'],
  ['binary_integer_literal', '#num'],
  ['decimal_floating_point_literal', '#num'],
  ['hex_floating_point_literal', '#num'],
  ['string_fragment', '#str'],
  ['multiline_string_fragment', '#str'],
  ['string_content', '#str'],
  ['raw_string_content', '#str'],
  ['heredoc_content', '#str'],
  // Heredoc marker names (`<<~SQL` vs `<<~QUERY`) have no string-value significance.
  ['heredoc_beginning', '#heredoc'],
  ['heredoc_end', '#heredoc'],
  // Strings are leaves in some grammars (Go/Rust) and fragment containers in others.
  ['string', '#str'],
  ['template_string', '#str'],
  ['string_literal', '#str'],
  ['interpreted_string_literal', '#str'],
  ['raw_string_literal', '#str'],
  ['raw_string', '#str'],
  ['escape_sequence', '#str'],
  ['char_literal', '#char'],
  ['character_literal', '#char'],
  ['character', '#char'],
  ['regex_pattern', '#regex'],
]);

/**
 * Kind tags whose raw source text re-enters the fingerprint in literal-dense (data-like) regions.
 * `#heredoc` is excluded: heredoc marker names are naming choices, not data values.
 */
const valueCarryingLiteralKinds = new Set(['#num', '#str', '#char', '#regex']);

const commentTypes = new Set(['comment', 'line_comment', 'block_comment']);

/** Children of a string node that carry only literal content; anything else is interpolation. */
const stringFragmentTypes = new Set([
  'string_fragment',
  'multiline_string_fragment',
  'string_content',
  'raw_string_content',
  'escape_sequence',
  'heredoc_content',
  // Python string delimiters are named children; they never carry interpolation.
  'string_start',
  'string_end',
]);

/**
 * Where a grammar names callees/members with a plain `identifier` (Java `method_invocation.name`,
 * Ruby `call.method`, Python `attribute.attribute`, plain calls elsewhere), the leaf in that field
 * must stay verbatim like `property_identifier` does: calling a different API is a semantic
 * difference, not a rename.
 */
const semanticNameFieldByParentType = new Map([
  ['call_expression', 'function'],
  ['method_invocation', 'name'],
  ['call', 'method'],
  ['attribute', 'attribute'],
  ['macro_invocation', 'macro'],
  // Java names accessed fields with a plain identifier in the `field` field.
  ['field_access', 'field'],
  // JS/TS `new Foo(...)` names the constructed API in the `constructor` field.
  ['new_expression', 'constructor'],
  // Python `f(timeout=...)` and Java `@Anno(key=...)` name parameters of the callee's API.
  ['keyword_argument', 'name'],
  ['element_value_pair', 'key'],
  // Rust turbofish and C++ template callees (`compute::<u32>(...)`); type arguments stay
  // anonymized via their own node types.
  ['generic_function', 'function'],
  ['template_function', 'name'],
]);

export const defaultDuplicationOptions: Required<DuplicationOptions> = {
  minTokens: 40,
  maxGapTokens: 30,
};

/** Minimum consecutive statements for a statement-sequence duplicate candidate. */
const minSequenceStatementCount = 2;
/**
 * Caps the window length so statement-sequence enumeration stays linear in the statement count.
 * Heterogeneous clones longer than the cap are reported as capped windows (a deliberate
 * conservative undercount trading completeness for bounded discovery cost).
 */
const maxSequenceStatementCount = 100;

/**
 * A region whose normalized tokens are at least 20% literal values is data-like (a lookup table, a
 * constant list, a value-mapping switch), not logic: literal values re-enter its fingerprint so
 * tables that merely share their shape stop counting as copy-paste. Logic-heavy code sits well
 * below the bound (5-10% literals) while object/array tables sit above it (25-50%); punctuation
 * and member names dilute tables, which is why the bound is far below half. Compared in integer
 * math (5 * literals >= total) so the TypeScript and native backends cannot disagree on the
 * boundary.
 */
function isLiteralDense(literalCount: number, tokenCount: number): boolean {
  return literalCount * 5 >= tokenCount;
}

interface Token {
  /** Normalization target: identifiers to anonymize, literal kind tags, or the raw token text. */
  kind: 'id' | 'text';
  text: string;
  /** djb2 hash of `text`, precomputed so fingerprinting nested regions never re-hashes a token. */
  textHash: number;
  /** Raw source text of a value-carrying literal, folded into fingerprints of data-like regions. */
  literalHash?: number;
  /** 0-based source rows the token occupies, so line coverage counts only matched-token lines. */
  startRow: number;
  endRow: number;
}

interface TokenRange {
  startTokenIndex: number;
  endTokenIndex: number;
  node: Parser.SyntaxNode;
}

/** A contiguous run of matched tokens; gapped (merged) duplicates carry several per occurrence. */
interface TokenSegment {
  startTokenIndex: number;
  endTokenIndex: number;
}

interface DuplicateCandidate {
  fingerprint: string;
  tokenCount: number;
  startTokenIndex: number;
  endTokenIndex: number;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

interface CountedOccurrence {
  /** Matched token runs; more than one once gapped groups are merged. */
  segments: TokenSegment[];
  /** Sum of segment token counts (the gap tokens are not matched content). */
  tokenCount: number;
  startTokenIndex: number;
  endTokenIndex: number;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

/** A duplicate region found in one file, exported for cross-file matching by fingerprint. */
export interface CrossFileDuplicateCandidate {
  /** Content key: equal fingerprints mean equal normalized token sequences (up to hash collision). */
  fingerprint: string;
  tokenCount: number;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
}

/**
 * Detects copy-pasted regions within a file. Regions are compared by their normalized token
 * sequence: identifiers are anonymized consistently by first-occurrence order (`a.f(a, b)` matches
 * `x.f(x, y)` but not `x.f(y, z)`), literals are normalized by kind, and member/type names and all
 * keywords/operators are kept verbatim. Literal-dense (data-like) regions additionally require
 * equal literal values. Candidates are whole block-like subtrees plus runs of consecutive sibling
 * statements, so a copy pasted into the middle of a longer block is still found. Only maximal,
 * non-overlapping regions are counted, and adjacent groups separated by a small token gap merge
 * into one gapped (Type-3) clone group.
 */
export function measureDuplication(
  root: Parser.SyntaxNode,
  codeLineNumbers: Set<number>,
  options?: DuplicationOptions
): DuplicationMetrics {
  const minTokens = options?.minTokens ?? defaultDuplicationOptions.minTokens;
  const maxGapTokens = options?.maxGapTokens ?? defaultDuplicationOptions.maxGapTokens;
  const tokens: Token[] = [];
  const blockRanges: TokenRange[] = [];
  const containerStatementRanges: TokenRange[][] = [];
  collectTokens(root, tokens, blockRanges, containerStatementRanges);
  const literalCountPrefix = buildLiteralCountPrefix(tokens);

  const candidates = [
    ...collectBlockCandidates(tokens, literalCountPrefix, blockRanges, minTokens),
    ...collectSequenceCandidates(tokens, literalCountPrefix, containerStatementRanges, minTokens),
  ];
  const counted = selectMaximalGroups(candidates, (group) => group.length >= 2);
  const groups = mergeAdjacentGroups(toCountedGroups(counted), maxGapTokens);
  return summarizeDuplicates(groups, codeLineNumbers, tokens);
}

/**
 * Collects this file's duplicate-candidate fingerprints for cross-file clone detection: whole
 * block-like subtrees plus each statement container's full run (so wholly copied files and class
 * bodies match even when no inner block clears the threshold on its own). Nested and overlapping
 * candidates are all returned; the project-level selection keeps only maximal ones.
 */
export function collectCrossFileDuplicateCandidates(
  root: Parser.SyntaxNode,
  options?: DuplicationOptions
): CrossFileDuplicateCandidate[] {
  const minTokens = options?.minTokens ?? defaultDuplicationOptions.minTokens;
  const tokens: Token[] = [];
  const blockRanges: TokenRange[] = [];
  const containerStatementRanges: TokenRange[][] = [];
  collectTokens(root, tokens, blockRanges, containerStatementRanges);
  const literalCountPrefix = buildLiteralCountPrefix(tokens);

  const candidates = collectBlockCandidates(tokens, literalCountPrefix, blockRanges, minTokens);
  for (const statements of containerStatementRanges) {
    const first = statements[0];
    const last = statements.at(-1);
    if (!first || !last) {
      continue;
    }
    const tokenCount = last.endTokenIndex - first.startTokenIndex;
    if (tokenCount < minTokens) {
      continue;
    }
    candidates.push(
      toCandidate(
        `s:${fingerprintKey(tokens, literalCountPrefix, first.startTokenIndex, last.endTokenIndex)}`,
        first.startTokenIndex,
        last.endTokenIndex,
        first.node,
        last.node
      )
    );
  }
  return dedupeByRegion(candidates).map(({ fingerprint, tokenCount, startIndex, endIndex, startLine, endLine }) => ({
    fingerprint,
    tokenCount,
    startIndex,
    endIndex,
    startLine,
    endLine,
  }));
}

function collectTokens(
  root: Parser.SyntaxNode,
  tokens: Token[],
  blockRanges: TokenRange[],
  containerStatementRanges: TokenRange[][]
): void {
  function visit(node: Parser.SyntaxNode): TokenRange {
    const startTokenIndex = tokens.length;
    const atomicKind = node.childCount === 0 ? undefined : atomicLiteralKind(node);
    if (node.childCount === 0) {
      appendLeafToken(node, tokens);
    } else if (atomicKind !== undefined) {
      // Interpolation-free strings collapse to their kind tag so copies differing only in quote
      // style or content still match; delimiter tokens would otherwise break the equivalence.
      tokens.push(makeTextToken(atomicKind, node.text, node.startPosition.row, node.endPosition.row));
    } else if (!commentTypes.has(node.type)) {
      const statementRanges: TokenRange[] = [];
      const isContainer = node.isNamed && statementContainerTypes.has(node.type);
      for (const child of node.children) {
        const childRange = visit(child);
        if (isContainer && child.isNamed && !commentTypes.has(child.type)) {
          statementRanges.push(childRange);
        }
      }
      // Single-statement containers are recorded too: within-file window enumeration needs two
      // statements and simply yields nothing for them, but cross-file matching must still see a
      // file whose only top-level statement is not a catalogued block type (a lone exported table).
      if (isContainer && statementRanges.length > 0) {
        containerStatementRanges.push(statementRanges);
      }
    }

    const range = { startTokenIndex, endTokenIndex: tokens.length, node };
    if (node.isNamed && duplicateBlockTypes.has(node.type)) {
      blockRanges.push(range);
    }
    return range;
  }

  visit(root);
}

/** The kind tag of a string-like node with no interpolation, or undefined to descend normally. */
function atomicLiteralKind(node: Parser.SyntaxNode): string | undefined {
  const kind = node.isNamed ? literalKindByType.get(node.type) : undefined;
  if (kind === undefined) {
    return undefined;
  }
  return node.namedChildren.every((child) => stringFragmentTypes.has(child.type)) ? kind : undefined;
}

function appendLeafToken(node: Parser.SyntaxNode, tokens: Token[]): void {
  if (commentTypes.has(node.type)) {
    return;
  }

  const startRow = node.startPosition.row;
  const endRow = node.endPosition.row;
  if (node.isNamed && shorthandPropertyTypes.has(node.type)) {
    tokens.push(
      makeTextToken(node.text, undefined, startRow, endRow),
      makeTextToken(':', undefined, startRow, endRow),
      { kind: 'id', text: node.text, textHash: 0, startRow, endRow }
    );
    return;
  }

  if (node.isNamed && anonymizedIdentifierTypes.has(node.type) && !isSemanticNameLeaf(node)) {
    tokens.push({ kind: 'id', text: node.text, textHash: 0, startRow, endRow });
    return;
  }

  // Anything else keeps its text: keywords, operators, punctuation, and semantic names such as
  // `property_identifier`/`type_identifier`, which must distinguish otherwise-identical structures.
  const literalKind = node.isNamed ? literalKindByType.get(node.type) : undefined;
  if (literalKind === undefined) {
    tokens.push(makeTextToken(node.text, undefined, startRow, endRow));
  } else {
    tokens.push(makeTextToken(literalKind, node.text, startRow, endRow));
  }
}

function makeTextToken(text: string, rawLiteralText: string | undefined, startRow: number, endRow: number): Token {
  const token: Token = { kind: 'text', text, textHash: hashText(text), startRow, endRow };
  if (rawLiteralText !== undefined && valueCarryingLiteralKinds.has(text)) {
    token.literalHash = hashText(rawLiteralText);
  }
  return token;
}

/** literalCountPrefix[i] = value-carrying literal tokens in tokens[0..i), for O(1) density checks. */
function buildLiteralCountPrefix(tokens: Token[]): Int32Array {
  const prefix = new Int32Array(tokens.length + 1);
  for (const [index, token] of tokens.entries()) {
    prefix[index + 1] = (prefix[index] ?? 0) + (token.literalHash === undefined ? 0 : 1);
  }
  return prefix;
}

function isSemanticNameLeaf(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }

  // Java method references (`Foo::bar`) name their identifiers without grammar fields; both the
  // type/object and the referenced method are semantic.
  if (parent.type === 'method_reference') {
    return true;
  }

  // `call` names its callee `method` in Ruby but `function` in Python; accept both fields.
  if (parent.type === 'call' && parent.childForFieldName('function')?.id === node.id) {
    return true;
  }

  // A Ruby constant receiving a call (`Alpha.new(...)`) names the invoked API; constants used as
  // plain values stay anonymized so renamed clones referencing constants still match.
  if (node.type === 'constant' && parent.type === 'call' && parent.childForFieldName('receiver')?.id === node.id) {
    return true;
  }

  // Java static receivers (`Alpha.run(...)`) name the invoked type. The tokenizer has no symbol
  // table, so PascalCase — Java's universal type-naming convention — is the discriminator;
  // camelCase instance receivers stay anonymized for rename tolerance.
  if (
    parent.type === 'method_invocation' &&
    parent.childForFieldName('object')?.id === node.id &&
    /^\p{Lu}/u.test(node.text)
  ) {
    return true;
  }

  // Qualified callees (Rust `crate::alpha::make(...)`, C++ `detail::make(...)`) and generic
  // callees (`compute::<u32>(...)`, `compute<int>(...)`) wrap their identifiers arbitrarily deep;
  // every path/name segment is semantic there — but only in call position, so renamed clones that
  // merely reference scoped constants or `use` paths still match.
  if (
    (parent.type === 'scoped_identifier' || parent.type === 'qualified_identifier') &&
    (parent.childForFieldName('name')?.id === node.id || parent.childForFieldName('path')?.id === node.id)
  ) {
    let outer = parent;
    while (
      outer.parent &&
      (outer.parent.type === 'scoped_identifier' ||
        outer.parent.type === 'qualified_identifier' ||
        outer.parent.type === 'generic_function' ||
        outer.parent.type === 'template_function')
    ) {
      outer = outer.parent;
    }
    if (outer.parent?.type === 'call_expression' && outer.parent.childForFieldName('function')?.id === outer.id) {
      return true;
    }
  }

  // Go struct-literal keys (`Config{Timeout: ...}`) have no `key` field in the grammar: the key
  // is the keyed_element's first named child, a literal_element wrapping the identifier.
  if (
    parent.type === 'literal_element' &&
    parent.parent?.type === 'keyed_element' &&
    parent.parent.namedChild(0)?.id === parent.id
  ) {
    return true;
  }

  const field = semanticNameFieldByParentType.get(parent.type);
  return field !== undefined && parent.childForFieldName(field)?.id === node.id;
}

function collectBlockCandidates(
  tokens: Token[],
  literalCountPrefix: Int32Array,
  blockRanges: TokenRange[],
  minTokens: number
): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];
  for (const range of blockRanges) {
    const tokenCount = range.endTokenIndex - range.startTokenIndex;
    if (tokenCount < minTokens) {
      continue;
    }
    candidates.push(
      toCandidate(
        `b:${fingerprintKey(tokens, literalCountPrefix, range.startTokenIndex, range.endTokenIndex)}`,
        range.startTokenIndex,
        range.endTokenIndex,
        range.node,
        range.node
      )
    );
  }
  return candidates;
}

interface WindowOccurrences {
  count: number;
  /** -1 once occurrences span more than one container. */
  containerIndex: number;
  minStart: number;
  maxStart: number;
}

interface SequenceWindow {
  containerIndex: number;
  start: number;
  length: number;
}

/**
 * Enumerates runs of consecutive sibling statements. Every container statement participates; only
 * the window length is capped, so enumeration stays linear in the statement count. Windows are
 * grouped by a cheap rolling hash of per-statement fingerprints, and only locally maximal repeated
 * windows — those whose one-statement extensions stop repeating — become candidates with an exact
 * (window-consistent) fingerprint. Without the maximality filter a degenerate file of
 * near-identical statements would fingerprint every sub-window of every repeated region.
 */
function collectSequenceCandidates(
  tokens: Token[],
  literalCountPrefix: Int32Array,
  containers: TokenRange[][],
  minTokens: number
): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];
  const occurrencesByWindowKey = new Map<number, WindowOccurrences>();
  const containerWindows = containers.map((statements) => enumerateContainerWindows(tokens, statements, minTokens));
  for (const [containerIndex, windows] of containerWindows.entries()) {
    for (const [start, row] of windows.windowKeysByStart.entries()) {
      for (const windowKey of row) {
        if (windowKey === undefined) {
          continue;
        }
        const occurrences = occurrencesByWindowKey.get(windowKey);
        if (occurrences) {
          occurrences.count += 1;
          if (occurrences.containerIndex !== containerIndex) {
            occurrences.containerIndex = -1;
          }
          occurrences.minStart = Math.min(occurrences.minStart, start);
          occurrences.maxStart = Math.max(occurrences.maxStart, start);
        } else {
          occurrencesByWindowKey.set(windowKey, { count: 1, containerIndex, minStart: start, maxStart: start });
        }
      }
    }
  }

  // A window only "repeats" when two of its occurrences can coexist without overlapping: sliding
  // matches inside a homogeneous run (start spread smaller than the window length) can never both
  // be counted and must neither qualify a window nor dominate its sub-windows.
  const repeats = (windowKey: number | undefined, length: number): boolean => {
    if (windowKey === undefined) {
      return false;
    }
    const occurrences = occurrencesByWindowKey.get(windowKey);
    return (
      occurrences !== undefined &&
      occurrences.count >= 2 &&
      (occurrences.containerIndex === -1 || occurrences.maxStart - occurrences.minStart >= length)
    );
  };

  // A window whose statements all share one normalized shape (sixteen `let x = 0;` declarations,
  // a constant table) is a homogeneous preamble, not a copy-paste: requiring two distinct
  // per-statement shapes keeps such runs out of duplicate groups and the duplication ratio.
  const hasDistinctStatements = (window: SequenceWindow): boolean => {
    const hashes = containerWindows[window.containerIndex]?.statementHashes ?? [];
    const firstHash = hashes[window.start];
    for (let index = window.start + 1; index < window.start + window.length; index += 1) {
      if (hashes[index] !== firstHash) {
        return true;
      }
    }
    return false;
  };

  const maximalWindows: SequenceWindow[] = [];
  for (const [containerIndex, windows] of containerWindows.entries()) {
    for (const [start, row] of windows.windowKeysByStart.entries()) {
      for (const [length, windowKey] of row.entries()) {
        if (!repeats(windowKey, length) || !hasDistinctStatements({ containerIndex, start, length })) {
          continue;
        }
        // Dominated windows are skipped: the one-statement extension also repeats, so a larger
        // candidate covering this window exists.
        const extendedRight = windows.windowKeysByStart[start]?.[length + 1];
        const extendedLeft = windows.windowKeysByStart[start - 1]?.[length + 1];
        if (repeats(extendedRight, length + 1) || repeats(extendedLeft, length + 1)) {
          continue;
        }
        maximalWindows.push({ containerIndex, start, length });
      }
    }
  }

  // The rolling hash anonymizes identifiers per statement, so a window can look repeated coarsely
  // while its exact (window-consistent) fingerprints differ, and a longer window's match can
  // dominate sub-windows that other copies still need (three copies where only two extend one
  // statement further). Every emitted window therefore exposes its repeating, unvisited
  // sub-windows; `visited` bounds the worklist and lengths strictly decrease, so it terminates.
  const visited = new Set(maximalWindows.map(windowId));
  let frontier = maximalWindows;
  while (frontier.length > 0) {
    const emitted: SequenceWindow[] = [];
    for (const window of frontier) {
      const statements = containers[window.containerIndex];
      const first = statements?.[window.start];
      const last = statements?.[window.start + window.length - 1];
      if (!first || !last) {
        continue;
      }
      const fingerprint = `s:${fingerprintKey(tokens, literalCountPrefix, first.startTokenIndex, last.endTokenIndex)}`;
      candidates.push(toCandidate(fingerprint, first.startTokenIndex, last.endTokenIndex, first.node, last.node));
      emitted.push(window);
    }
    frontier = [];
    for (const window of emitted) {
      for (const start of [window.start, window.start + 1]) {
        const subWindow = { containerIndex: window.containerIndex, start, length: window.length - 1 };
        const subWindowKey = containerWindows[window.containerIndex]?.windowKeysByStart[start]?.[subWindow.length];
        if (
          visited.has(windowId(subWindow)) ||
          !repeats(subWindowKey, subWindow.length) ||
          !hasDistinctStatements(subWindow)
        ) {
          continue;
        }
        visited.add(windowId(subWindow));
        frontier.push(subWindow);
      }
    }
  }
  return candidates;
}

function windowId(window: SequenceWindow): string {
  return `${window.containerIndex}:${window.start}:${window.length}`;
}

interface ContainerWindows {
  /** windowKeysByStart[start][length] is the rolling-hash key of the window, or undefined if it is below the size thresholds. */
  windowKeysByStart: (number | undefined)[][];
  /** Per-statement fingerprint hashes, for the distinct-shape requirement on windows. */
  statementHashes: number[];
}

function enumerateContainerWindows(tokens: Token[], statements: TokenRange[], minTokens: number): ContainerWindows {
  const statementHashes = statements.map((statement) =>
    fingerprintHash(tokens, statement.startTokenIndex, statement.endTokenIndex)
  );
  const windowKeysByStart: (number | undefined)[][] = [];
  for (let start = 0; start < statements.length; start += 1) {
    const row: (number | undefined)[] = [];
    let hash = 5381;
    let tokenCount = 0;
    const maxEnd = Math.min(statements.length, start + maxSequenceStatementCount);
    for (let end = start; end < maxEnd; end += 1) {
      const statement = statements[end];
      const statementHash = statementHashes[end];
      if (!statement || statementHash === undefined) {
        break;
      }
      hash = combineHashes(hash, statementHash);
      tokenCount += statement.endTokenIndex - statement.startTokenIndex;
      const statementCount = end - start + 1;
      row[statementCount] =
        statementCount >= minSequenceStatementCount && tokenCount >= minTokens
          ? combineHashes(hash, statementCount)
          : undefined;
    }
    windowKeysByStart.push(row);
  }
  return { windowKeysByStart, statementHashes };
}

function toCandidate(
  fingerprint: string,
  startTokenIndex: number,
  endTokenIndex: number,
  firstNode: Parser.SyntaxNode,
  lastNode: Parser.SyntaxNode
): DuplicateCandidate {
  return {
    fingerprint,
    tokenCount: endTokenIndex - startTokenIndex,
    startTokenIndex,
    endTokenIndex,
    startIndex: firstNode.startIndex,
    endIndex: lastNode.endIndex,
    startLine: firstNode.startPosition.row + 1,
    endLine: lastNode.endPosition.row + 1,
  };
}

/** Cache of hashText('$0'), hashText('$1'), ... so anonymized identifiers hash without allocating. */
const anonymizedIndexHashes: number[] = [];

function anonymizedIndexHash(index: number): number {
  let hash = anonymizedIndexHashes[index];
  if (hash === undefined) {
    hash = hashText(`$${index}`);
    anonymizedIndexHashes[index] = hash;
  }
  return hash;
}

/**
 * Content key of a token range: two independent 32-bit hashes over the normalized token sequence
 * (identifiers anonymized consistently by first-occurrence order) plus the token count. Regions
 * with equal keys are treated as equal content; a collision would need both 32-bit hashes and the
 * length to coincide, which is negligible for a metrics report. Hashing per-token instead of
 * serializing the whole range to a string keeps fingerprinting allocation-free for nested regions.
 */
function fingerprintKey(
  tokens: Token[],
  literalCountPrefix: Int32Array,
  startTokenIndex: number,
  endTokenIndex: number
): string {
  const literalCount = (literalCountPrefix[endTokenIndex] ?? 0) - (literalCountPrefix[startTokenIndex] ?? 0);
  const literalDense = isLiteralDense(literalCount, endTokenIndex - startTokenIndex);
  const [primary, secondary] = fingerprintHashPair(tokens, startTokenIndex, endTokenIndex, literalDense);
  return `${primary}:${secondary}:${endTokenIndex - startTokenIndex}`;
}

/**
 * A single 32-bit summary of a range for the coarse rolling-hash phase. Deliberately
 * density-agnostic: density is a property of the final candidate REGION, and folding literal
 * values into per-statement hashes would make a dense statement inside a logic-heavy window
 * (`const weights = [1, 2, 3];`) block the window from ever being enumerated. The coarse phase
 * over-approximates on shape alone; the exact region fingerprint still applies the density rule.
 */
function fingerprintHash(tokens: Token[], startTokenIndex: number, endTokenIndex: number): number {
  const [primary, secondary] = fingerprintHashPair(tokens, startTokenIndex, endTokenIndex, false);
  // XOR already coerces to int32, matching the native backend's i32 arithmetic.
  return primary ^ Math.imul(secondary, 31);
}

function fingerprintHashPair(
  tokens: Token[],
  startTokenIndex: number,
  endTokenIndex: number,
  foldLiteralValues: boolean
): [number, number] {
  const indexByIdentifier = new Map<string, number>();
  let primary = 5381;
  let secondary = 52_711;
  for (let index = startTokenIndex; index < endTokenIndex; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    let part: number;
    if (token.kind === 'id') {
      let identifierIndex = indexByIdentifier.get(token.text);
      if (identifierIndex === undefined) {
        identifierIndex = indexByIdentifier.size;
        indexByIdentifier.set(token.text, identifierIndex);
      }
      part = anonymizedIndexHash(identifierIndex);
    } else {
      part = token.textHash;
    }
    // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps the sum to int32 (Math.trunc does not), which must match the native backend's wrapping i32 arithmetic.
    primary = (Math.imul(primary, 31) + part) | 0;
    secondary = Math.imul(secondary, 37) ^ part;
    if (foldLiteralValues && token.literalHash !== undefined) {
      // oxlint-disable-next-line unicorn/prefer-math-trunc -- `| 0` wraps the sum to int32 (Math.trunc does not), which must match the native backend's wrapping i32 arithmetic.
      primary = (Math.imul(primary, 31) + token.literalHash) | 0;
      secondary = Math.imul(secondary, 37) ^ token.literalHash;
    }
  }
  return [primary, secondary];
}

/** djb2-style hash; XOR keeps the value in signed 32-bit range, which is fine for a grouping key. */
function hashText(text: string): number {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    // oxlint-disable-next-line unicorn/prefer-code-point -- djb2 hashes UTF-16 code units; codePointAt would hash surrogate pairs twice (full code point, then the lone low surrogate).
    hash = Math.imul(hash, 33) ^ text.charCodeAt(index);
  }
  return hash;
}

function combineHashes(hash: number, value: number): number {
  return Math.imul(hash, 31) + value;
}

function toCountedGroups(counted: Map<string, DuplicateCandidate[]>): CountedOccurrence[][] {
  const groups: CountedOccurrence[][] = [];
  for (const group of counted.values()) {
    const occurrences = group.map((candidate) => ({
      segments: [{ startTokenIndex: candidate.startTokenIndex, endTokenIndex: candidate.endTokenIndex }],
      tokenCount: candidate.tokenCount,
      startTokenIndex: candidate.startTokenIndex,
      endTokenIndex: candidate.endTokenIndex,
      startIndex: candidate.startIndex,
      endIndex: candidate.endIndex,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
    }));
    occurrences.sort(
      (left, right) => left.startTokenIndex - right.startTokenIndex || left.endTokenIndex - right.endTokenIndex
    );
    groups.push(occurrences);
  }
  return groups;
}

/**
 * Merges duplicate groups separated by a small token gap into one gapped (Type-3) clone group: a
 * copy edited in one spot splits into two exact groups whose occurrences sit side by side in the
 * same order. Two groups merge when they have the same number of occurrences and, pairing
 * occurrences in source order, every pair is gap-adjacent without crossing into the next pair.
 * Merging repeats to a fixpoint so a clone edited in several spots still reassembles. Gap tokens
 * are not matched content: line coverage and sizes count only the matched segments.
 */
function mergeAdjacentGroups(groups: CountedOccurrence[][], maxGapTokens: number): CountedOccurrence[][] {
  if (maxGapTokens <= 0 || groups.length < 2) {
    return groups;
  }
  // Deterministic processing order (mirrored by the native backend): by first occurrence position.
  groups.sort(compareGroups);
  for (let restart = true; restart;) {
    restart = false;
    for (let leftIndex = 0; leftIndex < groups.length && !restart; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
        const left = groups[leftIndex];
        const right = groups[rightIndex];
        if (!left || !right) {
          continue;
        }
        const merged = mergeGroups(left, right, maxGapTokens) ?? mergeGroups(right, left, maxGapTokens);
        if (merged) {
          groups[leftIndex] = merged;
          groups.splice(rightIndex, 1);
          groups.sort(compareGroups);
          restart = true;
          break;
        }
      }
    }
  }
  return groups;
}

function compareGroups(left: CountedOccurrence[], right: CountedOccurrence[]): number {
  const leftFirst = left[0];
  const rightFirst = right[0];
  return (
    (leftFirst?.startTokenIndex ?? 0) - (rightFirst?.startTokenIndex ?? 0) ||
    (leftFirst?.endTokenIndex ?? 0) - (rightFirst?.endTokenIndex ?? 0)
  );
}

/** The merged group when every `second` occurrence gap-follows its `first` counterpart, else undefined. */
function mergeGroups(
  first: CountedOccurrence[],
  second: CountedOccurrence[],
  maxGapTokens: number
): CountedOccurrence[] | undefined {
  if (first.length !== second.length) {
    return undefined;
  }
  for (const [index, leading] of first.entries()) {
    const trailing = second[index];
    if (!trailing) {
      return undefined;
    }
    const gap = trailing.startTokenIndex - leading.endTokenIndex;
    if (gap < 0 || gap > maxGapTokens) {
      return undefined;
    }
    // The merged span must stay clear of the next pair, or spans would overlap.
    const next = first[index + 1];
    if (next && trailing.endTokenIndex > next.startTokenIndex) {
      return undefined;
    }
  }
  return first.map((leading, index) => {
    const trailing = second[index];
    if (!trailing) {
      return leading;
    }
    return {
      segments: [...leading.segments, ...trailing.segments],
      tokenCount: leading.tokenCount + trailing.tokenCount,
      startTokenIndex: leading.startTokenIndex,
      endTokenIndex: trailing.endTokenIndex,
      startIndex: leading.startIndex,
      endIndex: trailing.endIndex,
      startLine: leading.startLine,
      endLine: trailing.endLine,
    };
  });
}

function summarizeDuplicates(
  groups: CountedOccurrence[][],
  codeLineNumbers: Set<number>,
  tokens: Token[]
): DuplicationMetrics {
  let duplicateBlockCount = 0;
  let maxDuplicateBlockSize = 0;
  const duplicateBlockGroups: { startLine: number; endLine: number }[][] = [];
  const duplicatedLines = new Set<number>();
  for (const group of groups) {
    duplicateBlockCount += group.length - 1;
    for (const occurrence of group) {
      maxDuplicateBlockSize = Math.max(maxDuplicateBlockSize, occurrence.tokenCount);
      // Only CODE lines carrying matched tokens count: comments and blank gaps inside an
      // occurrence's bounding range — the unmatched gap of a merged clone, and blank rows inside a
      // multi-row token (heredocs, template literals) — are not duplicated content and would push
      // the ratio past 1.
      for (const segment of occurrence.segments) {
        for (let index = segment.startTokenIndex; index < segment.endTokenIndex; index += 1) {
          const token = tokens[index];
          for (let row = token?.startRow ?? 0; row <= (token?.endRow ?? -1); row += 1) {
            if (codeLineNumbers.has(row + 1)) {
              duplicatedLines.add(row + 1);
            }
          }
        }
      }
    }
    duplicateBlockGroups.push(
      group
        .map(({ startLine, endLine }) => ({ startLine, endLine }))
        .toSorted((left, right) => left.startLine - right.startLine)
    );
  }
  duplicateBlockGroups.sort((left, right) => (left[0]?.startLine ?? 0) - (right[0]?.startLine ?? 0));

  return {
    duplicateBlockCount,
    duplicateBlockGroupCount: groups.length,
    duplicateBlockGroups,
    duplicateLineCount: duplicatedLines.size,
    duplicationRatio: codeLineNumbers.size === 0 ? 0 : duplicatedLines.size / codeLineNumbers.size,
    maxDuplicateBlockSize,
  };
}
