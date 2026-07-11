import type Parser from 'tree-sitter';
import type { DuplicationMetrics } from './types.js';

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
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
  'constant',
  'instance_variable',
  'class_variable',
  'global_variable',
]);

/** Literal leaves normalized to a kind tag so copies differing only in literal values still match. */
const literalKindByType = new Map([
  ['number', '#num'],
  ['number_literal', '#num'],
  ['integer', '#num'],
  ['float', '#num'],
  ['integer_literal', '#num'],
  ['float_literal', '#num'],
  ['int_literal', '#num'],
  ['rune_literal', '#num'],
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
  // Strings are leaves in some grammars (Go/Rust) and fragment containers in others.
  ['string', '#str'],
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

const commentTypes = new Set(['comment', 'line_comment', 'block_comment']);

/** Children of a string node that carry only literal content; anything else is interpolation. */
const stringFragmentTypes = new Set([
  'string_fragment',
  'multiline_string_fragment',
  'string_content',
  'raw_string_content',
  'escape_sequence',
  'heredoc_content',
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
]);

/** Minimum normalized token count for a region to be considered for duplication, to skip trivial repeats. */
const minDuplicateTokenCount = 40;
/** Minimum consecutive statements for a statement-sequence duplicate candidate. */
const minSequenceStatementCount = 2;
/** Caps the window length so statement-sequence enumeration stays linear in the statement count. */
const maxSequenceStatementCount = 100;
/** Caps how often the maximal-region selection reruns after shedding failed duplicate groups. */
const maxSelectionRerunCount = 20;

interface Token {
  /** Normalization target: identifiers to anonymize, literal kind tags, or the raw token text. */
  kind: 'id' | 'text';
  text: string;
}

interface TokenRange {
  startTokenIndex: number;
  endTokenIndex: number;
  node: Parser.SyntaxNode;
}

interface DuplicateCandidate {
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
 * keywords/operators are kept verbatim. Candidates are whole block-like subtrees plus runs of
 * consecutive sibling statements, so a copy pasted into the middle of a longer block is still
 * found. Only maximal, non-overlapping regions are counted.
 */
export function measureDuplication(root: Parser.SyntaxNode, totalLines: number): DuplicationMetrics {
  const tokens: Token[] = [];
  const blockRanges: TokenRange[] = [];
  const containerStatementRanges: TokenRange[][] = [];
  collectTokens(root, tokens, blockRanges, containerStatementRanges);

  const candidates = [
    ...collectBlockCandidates(tokens, blockRanges),
    ...collectSequenceCandidates(tokens, containerStatementRanges),
  ];
  const counted = selectMaximalDuplicates(candidates);
  return summarizeDuplicates(counted, totalLines);
}

function collectTokens(
  root: Parser.SyntaxNode,
  tokens: Token[],
  blockRanges: TokenRange[],
  containerStatementRanges: TokenRange[][]
): void {
  function visit(node: Parser.SyntaxNode): TokenRange {
    const startTokenIndex = tokens.length;
    if (node.childCount === 0) {
      appendLeafToken(node, tokens);
    } else if (atomicLiteralKind(node) !== undefined) {
      // Interpolation-free strings collapse to their kind tag so copies differing only in quote
      // style or content still match; delimiter tokens would otherwise break the equivalence.
      tokens.push({ kind: 'text', text: atomicLiteralKind(node) ?? '#str' });
    } else if (!commentTypes.has(node.type)) {
      const statementRanges: TokenRange[] = [];
      const isContainer = node.isNamed && statementContainerTypes.has(node.type);
      for (const child of node.children) {
        const childRange = visit(child);
        if (isContainer && child.isNamed && !commentTypes.has(child.type)) {
          statementRanges.push(childRange);
        }
      }
      if (isContainer && statementRanges.length >= minSequenceStatementCount) {
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

  if (node.isNamed && anonymizedIdentifierTypes.has(node.type) && !isSemanticNameLeaf(node)) {
    tokens.push({ kind: 'id', text: node.text });
    return;
  }

  // Anything else keeps its text: keywords, operators, punctuation, and semantic names such as
  // `property_identifier`/`type_identifier`, which must distinguish otherwise-identical structures.
  const literalKind = node.isNamed ? literalKindByType.get(node.type) : undefined;
  tokens.push({ kind: 'text', text: literalKind ?? node.text });
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

  const field = semanticNameFieldByParentType.get(parent.type);
  return field !== undefined && parent.childForFieldName(field)?.id === node.id;
}

function collectBlockCandidates(tokens: Token[], blockRanges: TokenRange[]): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];
  for (const range of blockRanges) {
    const tokenCount = range.endTokenIndex - range.startTokenIndex;
    if (tokenCount < minDuplicateTokenCount) {
      continue;
    }
    candidates.push(
      toCandidate(
        `b:${fingerprintTokens(tokens, range.startTokenIndex, range.endTokenIndex)}`,
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

/**
 * Enumerates runs of consecutive sibling statements. Every container statement participates; only
 * the window length is capped, so enumeration stays linear in the statement count. Windows are
 * grouped by a cheap rolling hash of per-statement fingerprints, and only locally maximal repeated
 * windows — those whose one-statement extensions stop repeating — become candidates with an exact
 * (window-consistent) fingerprint. Without the maximality filter a degenerate file of
 * near-identical statements would fingerprint every sub-window of every repeated region.
 */
function collectSequenceCandidates(tokens: Token[], containers: TokenRange[][]): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];
  const occurrencesByWindowKey = new Map<number, WindowOccurrences>();
  const containerWindows = containers.map((statements) => enumerateContainerWindows(tokens, statements));
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

  for (const [containerIndex, statements] of containers.entries()) {
    const windows = containerWindows[containerIndex];
    if (!windows) {
      continue;
    }
    for (const [start, row] of windows.windowKeysByStart.entries()) {
      for (const [length, windowKey] of row.entries()) {
        if (!repeats(windowKey, length)) {
          continue;
        }
        // Dominated windows are skipped: the one-statement extension also repeats, so a larger
        // candidate covering this window exists.
        const extendedRight = windows.windowKeysByStart[start]?.[length + 1];
        const extendedLeft = windows.windowKeysByStart[start - 1]?.[length + 1];
        if (repeats(extendedRight, length + 1) || repeats(extendedLeft, length + 1)) {
          continue;
        }
        const first = statements[start];
        const last = statements[start + length - 1];
        if (first && last) {
          candidates.push(
            toCandidate(
              `s:${fingerprintTokens(tokens, first.startTokenIndex, last.endTokenIndex)}`,
              first.startTokenIndex,
              last.endTokenIndex,
              first.node,
              last.node
            )
          );
        }
      }
    }
  }
  return candidates;
}

interface ContainerWindows {
  /** windowKeysByStart[start][length] is the rolling-hash key of the window, or undefined if it is below the size thresholds. */
  windowKeysByStart: (number | undefined)[][];
}

function enumerateContainerWindows(tokens: Token[], statements: TokenRange[]): ContainerWindows {
  const statementHashes = statements.map((statement) =>
    hashText(fingerprintTokens(tokens, statement.startTokenIndex, statement.endTokenIndex))
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
        statementCount >= minSequenceStatementCount && tokenCount >= minDuplicateTokenCount
          ? combineHashes(hash, statementCount)
          : undefined;
    }
    windowKeysByStart.push(row);
  }
  return { windowKeysByStart };
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
    startIndex: firstNode.startIndex,
    endIndex: lastNode.endIndex,
    startLine: firstNode.startPosition.row + 1,
    endLine: lastNode.endPosition.row + 1,
  };
}

/** Serializes a token range with identifiers anonymized consistently by first-occurrence order. */
function fingerprintTokens(tokens: Token[], startTokenIndex: number, endTokenIndex: number): string {
  const indexByIdentifier = new Map<string, number>();
  const parts: string[] = [];
  for (let index = startTokenIndex; index < endTokenIndex; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token.kind === 'id') {
      let identifierIndex = indexByIdentifier.get(token.text);
      if (identifierIndex === undefined) {
        identifierIndex = indexByIdentifier.size;
        indexByIdentifier.set(token.text, identifierIndex);
      }
      parts.push(`$${identifierIndex}`);
    } else {
      parts.push(token.text);
    }
  }
  return parts.join(' ');
}

/** djb2-style hash; XOR keeps the value in signed 32-bit range, which is fine for a grouping key. */
function hashText(text: string): number {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash, 33) ^ (text.codePointAt(index) ?? 0);
  }
  return hash;
}

function combineHashes(hash: number, value: number): number {
  return Math.imul(hash, 31) + value;
}

/**
 * Keeps only maximal, non-overlapping duplicates: candidates are grouped by fingerprint, larger
 * regions win over regions overlapping them, and groups reduced below two survivors are dropped.
 */
function selectMaximalDuplicates(candidates: DuplicateCandidate[]): Map<string, DuplicateCandidate[]> {
  const byFingerprint = new Map<string, DuplicateCandidate[]>();
  for (const candidate of candidates) {
    const group = byFingerprint.get(candidate.fingerprint) ?? [];
    group.push(candidate);
    byFingerprint.set(candidate.fingerprint, group);
  }

  let duplicates = [...byFingerprint.values()].filter(hasDistinctRegions).flatMap(dedupeByRegion);
  duplicates.sort((left, right) => right.tokenCount - left.tokenCount);

  // Greedy selection can keep a candidate whose group ends up below two survivors; such an
  // uncounted region must not block smaller groups, so the largest failed group is removed and the
  // selection reruns. One group at a time: freeing a failed group's regions can rescue another.
  // The rerun cap bounds degenerate inputs; past it the remaining failed groups are dropped,
  // trading a sliver of recall on such files for bounded runtime.
  for (let rerun = 0; ; rerun += 1) {
    const keptRegions: { startIndex: number; endIndex: number }[] = [];
    const counted = new Map<string, DuplicateCandidate[]>();
    for (const candidate of duplicates) {
      if (keptRegions.some((region) => overlaps(region, candidate))) {
        continue;
      }
      keptRegions.push(candidate);
      const group = counted.get(candidate.fingerprint) ?? [];
      group.push(candidate);
      counted.set(candidate.fingerprint, group);
    }

    let failedFingerprint: string | undefined;
    let failedTokenCount = -1;
    for (const [fingerprint, group] of counted) {
      const tokenCount = group[0]?.tokenCount ?? 0;
      if (group.length < 2 && tokenCount > failedTokenCount) {
        failedFingerprint = fingerprint;
        failedTokenCount = tokenCount;
      }
    }
    if (failedFingerprint === undefined) {
      for (const [fingerprint, group] of counted) {
        if (group.length < 2) {
          counted.delete(fingerprint);
        }
      }
      return counted;
    }
    if (rerun >= maxSelectionRerunCount) {
      for (const [fingerprint, group] of counted) {
        if (group.length < 2) {
          counted.delete(fingerprint);
        }
      }
      return counted;
    }

    duplicates = duplicates.filter((candidate) => candidate.fingerprint !== failedFingerprint);
  }
}

function hasDistinctRegions(group: DuplicateCandidate[]): boolean {
  return dedupeByRegion(group).length >= 2;
}

/** Drops candidates covering the same source region (a block and the statement run spanning it). */
function dedupeByRegion(group: DuplicateCandidate[]): DuplicateCandidate[] {
  const byRegion = new Map<string, DuplicateCandidate>();
  for (const candidate of group) {
    const key = `${candidate.startIndex}:${candidate.endIndex}`;
    const existing = byRegion.get(key);
    if (!existing || candidate.tokenCount > existing.tokenCount) {
      byRegion.set(key, candidate);
    }
  }
  return [...byRegion.values()];
}

function overlaps(
  left: { startIndex: number; endIndex: number },
  right: { startIndex: number; endIndex: number }
): boolean {
  return left.startIndex < right.endIndex && right.startIndex < left.endIndex;
}

function summarizeDuplicates(counted: Map<string, DuplicateCandidate[]>, totalLines: number): DuplicationMetrics {
  let duplicateBlockCount = 0;
  let maxDuplicateBlockSize = 0;
  const duplicateBlockGroups: { startLine: number; endLine: number }[][] = [];
  const duplicatedLines = new Set<number>();
  for (const group of counted.values()) {
    duplicateBlockCount += group.length - 1;
    for (const candidate of group) {
      maxDuplicateBlockSize = Math.max(maxDuplicateBlockSize, candidate.tokenCount);
      for (let line = candidate.startLine; line <= candidate.endLine; line += 1) {
        duplicatedLines.add(line);
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
    duplicateBlockGroupCount: counted.size,
    duplicateBlockGroups,
    duplicateLineCount: duplicatedLines.size,
    duplicationRatio: totalLines === 0 ? 0 : duplicatedLines.size / totalLines,
    maxDuplicateBlockSize,
  };
}
