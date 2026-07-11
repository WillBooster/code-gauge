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
  ['string_content', '#str'],
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

/** Minimum normalized token count for a region to be considered for duplication, to skip trivial repeats. */
const minDuplicateTokenCount = 40;
/** Minimum consecutive statements for a statement-sequence duplicate candidate. */
const minSequenceStatementCount = 2;
/** Caps statement-sequence window enumeration so pathological files stay fast. */
const maxSequenceStatementCount = 100;
const maxContainerStatementCount = 2000;

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

function appendLeafToken(node: Parser.SyntaxNode, tokens: Token[]): void {
  if (commentTypes.has(node.type)) {
    return;
  }

  if (node.isNamed && anonymizedIdentifierTypes.has(node.type)) {
    tokens.push({ kind: 'id', text: node.text });
    return;
  }

  // Anything else keeps its text: keywords, operators, punctuation, and semantic names such as
  // `property_identifier`/`type_identifier`, which must distinguish otherwise-identical structures.
  const literalKind = node.isNamed ? literalKindByType.get(node.type) : undefined;
  tokens.push({ kind: 'text', text: literalKind ?? node.text });
}

function collectBlockCandidates(tokens: Token[], blockRanges: TokenRange[]): DuplicateCandidate[] {
  const candidates: DuplicateCandidate[] = [];
  for (const range of blockRanges) {
    const tokenCount = range.endTokenIndex - range.startTokenIndex;
    if (tokenCount < minDuplicateTokenCount) {
      continue;
    }
    candidates.push(toCandidate(tokens, range.startTokenIndex, range.endTokenIndex, range.node, range.node));
  }
  return candidates;
}

/**
 * Enumerates runs of consecutive sibling statements. Windows are pre-grouped by a cheap rolling
 * hash of per-statement fingerprints; only windows whose hash repeats get the exact (and window-
 * consistent) fingerprint, keeping the enumeration close to linear on typical files.
 */
function collectSequenceCandidates(tokens: Token[], containers: TokenRange[][]): DuplicateCandidate[] {
  const windowsByHash = new Map<string, { statements: TokenRange[]; start: number; end: number }[]>();
  for (const statements of containers) {
    const limited = statements.slice(0, maxContainerStatementCount);
    const statementHashes = limited.map((statement) =>
      hashText(fingerprintTokens(tokens, statement.startTokenIndex, statement.endTokenIndex))
    );
    for (let start = 0; start < limited.length; start += 1) {
      let hash = 5381;
      let tokenCount = 0;
      const maxEnd = Math.min(limited.length, start + maxSequenceStatementCount);
      for (let end = start; end < maxEnd; end += 1) {
        const statement = limited[end];
        const statementHash = statementHashes[end];
        if (!statement || statementHash === undefined) {
          break;
        }
        hash = combineHashes(hash, statementHash);
        tokenCount += statement.endTokenIndex - statement.startTokenIndex;
        const statementCount = end - start + 1;
        if (statementCount < minSequenceStatementCount || tokenCount < minDuplicateTokenCount) {
          continue;
        }
        const key = `${hash}:${statementCount}`;
        const group = windowsByHash.get(key) ?? [];
        group.push({ statements: limited, start, end });
        windowsByHash.set(key, group);
      }
    }
  }

  const candidates: DuplicateCandidate[] = [];
  for (const windows of windowsByHash.values()) {
    if (windows.length < 2) {
      continue;
    }
    for (const window of windows) {
      const first = window.statements[window.start];
      const last = window.statements[window.end];
      if (!first || !last) {
        continue;
      }
      candidates.push(toCandidate(tokens, first.startTokenIndex, last.endTokenIndex, first.node, last.node));
    }
  }
  return candidates;
}

function toCandidate(
  tokens: Token[],
  startTokenIndex: number,
  endTokenIndex: number,
  firstNode: Parser.SyntaxNode,
  lastNode: Parser.SyntaxNode
): DuplicateCandidate {
  return {
    fingerprint: fingerprintTokens(tokens, startTokenIndex, endTokenIndex),
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

  const duplicates = [...byFingerprint.entries()]
    .filter(([, group]) => hasDistinctRegions(group))
    .flatMap(([fingerprint, group]) => dedupeByRegion(group).map((candidate) => ({ fingerprint, candidate })));
  duplicates.sort((left, right) => right.candidate.tokenCount - left.candidate.tokenCount);

  const keptRegions: { startIndex: number; endIndex: number }[] = [];
  const counted = new Map<string, DuplicateCandidate[]>();
  for (const { fingerprint, candidate } of duplicates) {
    if (keptRegions.some((region) => overlaps(region, candidate))) {
      continue;
    }
    keptRegions.push(candidate);
    const group = counted.get(fingerprint) ?? [];
    group.push(candidate);
    counted.set(fingerprint, group);
  }

  for (const [fingerprint, group] of counted) {
    if (group.length < 2) {
      counted.delete(fingerprint);
    }
  }
  return counted;
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
