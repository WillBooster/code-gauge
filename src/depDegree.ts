import type Parser from 'tree-sitter';

/** Leaf node types treated as variable references by the def-use approximation. */
const variableNodeTypes = new Set(['identifier', 'instance_variable', 'class_variable', 'global_variable']);

/** Tokens directly after a variable that write it without reading it (`x = 1`, `x := 1`). */
const pureAssignmentOperators = new Set(['=', ':=']);

/** Tokens directly after a variable that read then write it (`x += 1` depends on x's definition). */
const compoundAssignmentOperators = new Set([
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '**=',
  '//=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
  '@=',
  '&^=',
]);

/**
 * Parent type -> field under which an identifier is a definition target even when a type
 * annotation separates it from the `=` token (`const x: T = ...`, `let x: T = ...`,
 * `x: int = ...`, `var x T = ...`), plus loop bindings that carry no assignment token at all.
 */
const definitionFieldByParentType = new Map([
  ['variable_declarator', 'name'],
  ['let_declaration', 'pattern'],
  ['assignment', 'left'],
  ['var_spec', 'name'],
  ['init_declarator', 'declarator'],
  ['enhanced_for_statement', 'name'],
  ['for_statement', 'left'],
  ['for_in_statement', 'left'],
  ['for_in_clause', 'left'],
  ['for_range_loop', 'declarator'],
  ['for_expression', 'pattern'],
]);

/** Multi-target lists (`a, b = ...`, `a, b := ...`) whose holder's `left` field marks definitions. */
const definitionListNodeTypes = new Set(['expression_list', 'pattern_list', 'tuple_pattern']);
const definitionListHolderTypes = new Set([
  'assignment',
  'assignment_statement',
  'short_var_declaration',
  'for_statement',
  'for_in_clause',
  'range_clause',
]);

/** Parameter-position fields that annotate or initialize rather than bind (`x: T`, `x = default`). */
const nonBindingParameterFields = new Set(['type', 'value']);

/** One leaf of the def-use walk: its field in the parent and its function-scope chain. */
interface DepDegreeLeaf {
  node: Parser.SyntaxNode;
  fieldName: string | undefined;
  /** Chain of nested-function scope ids below the measured function: '' for its own body, then '/0', '/0/1', ... */
  scope: string;
}

/**
 * Approximate def-use pairs of the function's subtree (see FunctionMetrics.depDegree): the number
 * of variable reads with a preceding same-name definition visible at the read. Definitions are
 * recognized token-wise (a variable directly followed by an assignment operator), structurally
 * (declarator/assignment/loop-binding fields, so annotated declarations count), and positionally
 * (parameters). Nested function subtrees are included, but their definitions are scoped: an inner
 * function's parameters and locals cannot reach reads outside it, while inner reads still see
 * outer definitions (closure captures). Reads through destructuring patterns and member accesses
 * are not modeled; the approximation only needs to be stable, since the gate compares deltas.
 */
export function measureDepDegree(
  functionNode: Parser.SyntaxNode,
  isNestedFunctionBoundary: (node: Parser.SyntaxNode) => boolean
): number {
  const leaves: DepDegreeLeaf[] = [];
  collectDepDegreeLeaves(functionNode, undefined, '', { nextScopeId: 0 }, isNestedFunctionBoundary, leaves, true);
  const definitionScopesByName = new Map<string, string[]>();
  let pairs = 0;
  for (const [index, leaf] of leaves.entries()) {
    if (!variableNodeTypes.has(leaf.node.type)) {
      continue;
    }
    const name = leaf.node.text;
    const nextText = leaves[index + 1]?.node.text;
    if (nextText !== undefined && compoundAssignmentOperators.has(nextText)) {
      if (isDefinitionVisible(definitionScopesByName.get(name), leaf.scope)) {
        pairs += 1;
      }
      addDefinition(definitionScopesByName, name, leaf.scope);
      continue;
    }
    if (
      (nextText !== undefined && pureAssignmentOperators.has(nextText)) ||
      isStructuralDefinition(leaf) ||
      isParameterDefinition(leaf)
    ) {
      addDefinition(definitionScopesByName, name, leaf.scope);
      continue;
    }
    if (isDefinitionVisible(definitionScopesByName.get(name), leaf.scope)) {
      pairs += 1;
    }
  }
  return pairs;
}

/**
 * Collects non-comment leaves with their parent field — taken from one cursor pass, so a child of
 * a high-arity node (a long array literal) costs O(1) instead of an O(children) scan — and their
 * function-scope chain (each nested function boundary below the measured function opens a child
 * scope).
 */
function collectDepDegreeLeaves(
  node: Parser.SyntaxNode,
  fieldName: string | undefined,
  scope: string,
  state: { nextScopeId: number },
  isNestedFunctionBoundary: (node: Parser.SyntaxNode) => boolean,
  leaves: DepDegreeLeaf[],
  isMeasuredRoot: boolean
): void {
  if (node.type === 'comment' || node.type === 'line_comment' || node.type === 'block_comment') {
    return;
  }
  if (node.childCount === 0) {
    leaves.push({ node, fieldName, scope });
    return;
  }
  const childScope = !isMeasuredRoot && isNestedFunctionBoundary(node) ? `${scope}/${state.nextScopeId++}` : scope;
  const cursor = node.walk();
  if (cursor.gotoFirstChild()) {
    do {
      collectDepDegreeLeaves(
        cursor.currentNode,
        cursor.currentFieldName ?? undefined,
        childScope,
        state,
        isNestedFunctionBoundary,
        leaves,
        false
      );
    } while (cursor.gotoNextSibling());
  }
}

function addDefinition(definitionScopesByName: Map<string, string[]>, name: string, scope: string): void {
  const scopes = definitionScopesByName.get(name) ?? [];
  if (!scopes.includes(scope)) {
    scopes.push(scope);
    definitionScopesByName.set(name, scopes);
  }
}

/** A definition reaches a read only from the read's own or an enclosing function scope. */
function isDefinitionVisible(definitionScopes: string[] | undefined, scope: string): boolean {
  return (
    definitionScopes !== undefined &&
    definitionScopes.some((definitionScope) => scope === definitionScope || scope.startsWith(`${definitionScope}/`))
  );
}

function isStructuralDefinition(leaf: DepDegreeLeaf): boolean {
  const parent = leaf.node.parent;
  if (!parent) {
    return false;
  }
  const definitionField = definitionFieldByParentType.get(parent.type);
  if (definitionField !== undefined && definitionField === leaf.fieldName) {
    return true;
  }
  if (!definitionListNodeTypes.has(parent.type)) {
    return false;
  }
  const holder = parent.parent;
  return holder !== null && definitionListHolderTypes.has(holder.type) && fieldNameInParent(parent, holder) === 'left';
}

/**
 * Whether the identifier binds a parameter: an ancestor reached through declarator wrappers (C/C++
 * function-pointer or array parameters) is a parameter-ish node, or it directly occupies a
 * parameter field (bare arrow-function/lambda parameters, catch-clause bindings). Type annotations
 * and default values inside parameter nodes bind nothing.
 */
function isParameterDefinition(leaf: DepDegreeLeaf): boolean {
  let current = leaf.node;
  for (let depth = 0; ; depth += 1) {
    const parent = current.parent;
    if (!parent) {
      return false;
    }
    const parentIsParameterish = parent.type.includes('parameter');
    // Beyond the grandparent, only declarator wrappers keep climbing; checking this before the
    // field lookup also keeps reads inside high-arity nodes (long array literals) O(1).
    if (depth >= 1 && !parentIsParameterish && !parent.type.includes('declarator')) {
      return false;
    }
    const field = depth === 0 ? leaf.fieldName : fieldNameInParent(current, parent);
    if (field !== undefined && nonBindingParameterFields.has(field)) {
      return false;
    }
    if (parentIsParameterish || (depth === 0 && (field?.includes('parameter') ?? false))) {
      return true;
    }
    current = parent;
  }
}

/** Only called with small-arity parents (declarator wrappers, definition-list holders). */
function fieldNameInParent(node: Parser.SyntaxNode, parent: Parser.SyntaxNode): string | undefined {
  for (let index = 0; index < parent.childCount; index += 1) {
    if (parent.child(index)?.id === node.id) {
      return parent.fieldNameForChild(index) ?? undefined;
    }
  }
  return undefined;
}
