import type Parser from 'tree-sitter';
import type { LanguageDefinition } from './types.js';

const commentNodeTypes = new Set(['comment', 'line_comment', 'block_comment']);

// Nodes never counted positionally inside NCSS containers: metadata and empty statements.
const positionalExclusionTypes = new Set(['attribute_item', 'inner_attribute_item', 'empty_statement']);

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
export function countNcss(node: Parser.SyntaxNode, language: LanguageDefinition): number {
  const countable = new Set(language.ncssNodeTypes);
  const containers = new Set(language.ncssContainerNodeTypes);
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
  const countable = new Set(language.ncssNodeTypes);
  const containers = new Set(language.ncssContainerNodeTypes);
  const selfContribution = ncssContribution(node, countable, containers);
  return countNcss(node, language) + (selfContribution > 0 ? 0 : 1);
}

function ncssContribution(node: Parser.SyntaxNode, countable: Set<string>, containers: Set<string>): number {
  if (!node.isNamed || commentNodeTypes.has(node.type) || isForHeaderInitializer(node)) {
    return 0;
  }

  let contribution = 0;
  const positional =
    containers.has(node.parent?.type ?? '') && !containers.has(node.type) && !positionalExclusionTypes.has(node.type);
  if ((countsThroughNodeType(node, countable) || positional) && !isDeclarationWrapper(node, countable)) {
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
  return true;
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

/**
 * A declaration in a `for` header (`for (int i = 0; ...)`) is part of the loop statement, which
 * already counts; PMD does not count it separately.
 */
function isForHeaderInitializer(node: Parser.SyntaxNode): boolean {
  const parent = node.parent;
  if (!parent || (parent.type !== 'for_statement' && parent.type !== 'for_clause')) {
    return false;
  }
  for (let index = 0; index < parent.childCount; index += 1) {
    if (parent.child(index)?.id === node.id) {
      const fieldName = parent.fieldNameForChild(index);
      return fieldName === 'init' || fieldName === 'initializer';
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
