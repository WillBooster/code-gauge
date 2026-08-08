import type Parser from 'tree-sitter';
import type { LanguageDefinition } from './types.js';

export const commentNodeTypes = new Set(['comment', 'line_comment', 'block_comment']);

// Nodes never counted positionally inside NCSS containers: metadata, empty statements, Ruby
// heredoc bodies (tree-sitter emits them as siblings of the statement that opened the heredoc),
// and Ruby statement parentheses (transparent wrappers whose children count instead).
const positionalExclusionTypes = new Set([
  'attribute_item',
  'inner_attribute_item',
  'empty_statement',
  'heredoc_body',
  'parenthesized_statements',
]);

// TypeScript interface members count like Java interface members, but the same node types appear
// inside object-type annotations (`let x: { a: number }`), which are part of one declaration, so
// they only count directly under an interface body.
const interfaceMemberNodeTypes = new Set([
  'property_signature',
  'method_signature',
  'index_signature',
  'construct_signature',
  'call_signature',
]);

// An if-branch wrapped in one of these already counts through ncssNodeTypes; a bare `alternative`
// (Java/Go put the else branch directly in the field) needs the extra `else` count instead.
const elseClauseNodeTypes = new Set(['else_clause', 'elif_clause', 'else', 'elsif']);

const ifNodeTypes = new Set(['if_statement', 'if_expression']);

// C/C++ type specifiers only declare something when they carry a body (`struct S { ... }`);
// without one they are mere type references inside other declarations.
const bodylessNcssSpecifierTypes = new Set([
  'struct_specifier',
  'enum_specifier',
  'union_specifier',
  'class_specifier',
]);

/**
 * Counts non-commenting source statements (NCSS) in the subtree, PMD-style: one per declaration,
 * statement, and clause (`else`, `case`/`default` label, `catch`, `finally`, try-with-resources
 * resource); `try` itself, braces, blank lines, and comments count 0.
 */
interface NcssSets {
  countable: Set<string>;
  containers: Set<string>;
}

// Cached per language: countNcss runs once per function plus once per file, so per-call Set
// construction would add a measurable constant factor on large files.
const ncssSetsCache = new WeakMap<LanguageDefinition, NcssSets>();

function getNcssSets(language: LanguageDefinition): NcssSets {
  let sets = ncssSetsCache.get(language);
  if (!sets) {
    sets = { countable: new Set(language.ncssNodeTypes), containers: new Set(language.ncssContainerNodeTypes) };
    ncssSetsCache.set(language, sets);
  }
  return sets;
}

export function countNcss(node: Parser.SyntaxNode, language: LanguageDefinition): number {
  const { countable, containers } = getNcssSets(language);
  let count = 0;

  function visit(current: Parser.SyntaxNode): void {
    count += ncssContribution(current, countable, containers);
    for (const child of current.children) {
      visit(child);
    }
  }

  visit(node);
  return count;
}

/**
 * Per-function NCSS: the function's whole subtree plus 1 for the declaration itself when the
 * function node carries no countable declaration of its own (arrow functions, lambdas, blocks).
 */
export function countFunctionNcss(node: Parser.SyntaxNode, language: LanguageDefinition): number {
  const { countable, containers } = getNcssSets(language);
  const selfContribution = ncssContribution(node, countable, containers);
  return countNcss(node, language) + (selfContribution > 0 ? 0 : 1);
}

function ncssContribution(node: Parser.SyntaxNode, countable: Set<string>, containers: Set<string>): number {
  if (!node.isNamed || commentNodeTypes.has(node.type) || isForHeaderNode(node)) {
    return 0;
  }

  let contribution = 0;
  const positional =
    isInContainerPosition(node, containers) && !containers.has(node.type) && !positionalExclusionTypes.has(node.type);
  if (
    (countsThroughNodeType(node, countable) || positional || countsContextually(node)) &&
    !isDeclarationWrapper(node, countable)
  ) {
    contribution += 1;
  }

  // A bare else branch (Java/Go `alternative:` without an else-clause wrapper) counts 1 like the
  // `else` keyword does in PMD; an `else if` chain charges the nested if separately on top.
  if (ifNodeTypes.has(node.type)) {
    contribution += findBareAlternatives(node).length;
  }

  return contribution;
}

function countsThroughNodeType(node: Parser.SyntaxNode, countable: Set<string>): boolean {
  if (!countable.has(node.type)) {
    return false;
  }
  if (bodylessNcssSpecifierTypes.has(node.type)) {
    return node.childForFieldName('body') !== null;
  }
  // A try-with-resources `resource` counts only when it declares a variable; `try (r)` reuses an
  // existing one and adds no statement (matching PMD).
  if (node.type === 'resource') {
    return node.childForFieldName('name') !== null;
  }
  return true;
}

/**
 * Direct container children count positionally; Ruby's `(foo; bar)` statement parentheses are
 * transparent, so their children count when the parentheses themselves sit in a container.
 */
function isInContainerPosition(node: Parser.SyntaxNode, containers: Set<string>): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (containers.has(parent.type)) {
    return true;
  }
  return parent.type === 'parenthesized_statements' && containers.has(parent.parent?.type ?? '');
}

/**
 * `export const x = 1` nests a countable declaration inside `export_statement`; only the inner
 * declaration counts, mirroring how PMD counts one statement per declared entity.
 */
function isDeclarationWrapper(node: Parser.SyntaxNode, countable: Set<string>): boolean {
  if (node.type !== 'export_statement') {
    return false;
  }
  const declaration = node.childForFieldName('declaration');
  return declaration !== null && countable.has(declaration.type);
}

const forHeaderFieldNames = new Set(['init', 'initializer', 'condition', 'update', 'increment']);

/**
 * Statement-shaped nodes in a `for` header (`for (int i = 0; i < n; i++)`) are part of the loop
 * statement, which already counts; PMD does not count them separately. JavaScript parses the
 * condition as an `expression_statement` and Go parses the update as an `inc_statement`, so all
 * header fields must be excluded, not just the initializer.
 */
function isForHeaderNode(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  // C++20 range-for initializers nest one level deeper: for_range_loop > init_statement > node.
  if (parent.type === 'init_statement' && parent.parent?.type === 'for_range_loop') {
    return true;
  }
  if (parent.type !== 'for_statement' && parent.type !== 'for_clause' && parent.type !== 'for_range_loop') {
    return false;
  }
  for (let index = 0; index < parent.childCount; index += 1) {
    if (parent.child(index)?.id === node.id) {
      return forHeaderFieldNames.has(parent.fieldNameForChild(index) ?? '');
    }
  }
  return false;
}

/** Statements only countable by their position: constructs without a dedicated statement node. */
function countsContextually(node: Parser.SyntaxNode): boolean {
  const parentType = node.parent?.type;
  // A Java instance initializer is a bare `block` in the class body; PMD counts it like the
  // `static_initializer` declaration it parallels.
  if (node.type === 'block' && parentType === 'class_body') {
    return true;
  }
  // TypeScript interface members (see interfaceMemberNodeTypes).
  if (interfaceMemberNodeTypes.has(node.type) && parentType === 'interface_body') {
    return true;
  }
  // A braceless Rust match-arm body (`1 => foo()`) has no expression_statement wrapper; count the
  // value expression so braced and unbraced arms measure alike.
  if (parentType === 'match_arm' && node.type !== 'block' && isFieldOfParent(node, 'value')) {
    return true;
  }
  // A TypeScript class-body method overload signature declares a member like its interface twin.
  if (node.type === 'method_signature' && parentType === 'class_body') {
    return true;
  }
  // An ambient `declare namespace M { ... }` is a bare `internal_module`; the non-ambient
  // `namespace N { ... }` is wrapped in an `expression_statement`, which already counts.
  if (node.type === 'internal_module' && parentType !== 'expression_statement') {
    return true;
  }
  // A Ruby endless method (`def f(x) = expr`) stores its single-statement body directly in the
  // `body` field instead of a positional `body_statement` container.
  if (
    (parentType === 'method' || parentType === 'singleton_method') &&
    node.type !== 'body_statement' &&
    isFieldOfParent(node, 'body')
  ) {
    return true;
  }
  // C++ `friend class X;` declares on its own; `friend void g() { ... }` merely wraps a counted
  // definition.
  if (node.type === 'friend_declaration') {
    return !node.namedChildren.some((child) => child.type === 'declaration' || child.type === 'function_definition');
  }
  // A Rust item-position macro invocation (`foo! {}` at module level) has no expression_statement
  // wrapper; the semicolon form does and already counts through it.
  if (node.type === 'macro_invocation' && (parentType === 'source_file' || parentType === 'declaration_list')) {
    return true;
  }
  return false;
}

function isFieldOfParent(node: Parser.SyntaxNode, fieldName: string): boolean {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  for (let index = 0; index < parent.childCount; index += 1) {
    if (parent.child(index)?.id === node.id) {
      return parent.fieldNameForChild(index) === fieldName;
    }
  }
  return false;
}

function findBareAlternatives(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const alternatives: Parser.SyntaxNode[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child && node.fieldNameForChild(index) === 'alternative' && !elseClauseNodeTypes.has(child.type)) {
      alternatives.push(child);
    }
  }
  return alternatives;
}
