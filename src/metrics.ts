import Parser from 'tree-sitter';
import { measureDuplication } from './duplication.js';
import { createLanguageRegistry } from './languages.js';
import { measureWithNativeBackend, type NativeHalsteadCounts, type NativeMetricsPayload } from './nativeMetrics.js';
import type {
  CallGraphMetrics,
  CodeMetrics,
  CohesionMetrics,
  CouplingMetrics,
  DeclarationMetrics,
  FunctionMetrics,
  HalsteadMetrics,
  LanguageDefinition,
  LanguageName,
  MeasureOptions,
  ModuleMetrics,
  SyntaxFeatureMetrics,
  TypeComplexityMetrics,
} from './types.js';

const booleanOperators = new Set(['&&', '||', 'and', 'or']);
const operatorTexts = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '**',
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '<=',
  '>',
  '>=',
  '!',
  '~',
  '&',
  '|',
  '^',
  '++',
  '--',
  '<<',
  '>>',
  '>>>',
  '=>',
  '**=',
  '<<=',
  '>>=',
  '>>>=',
  '&=',
  '|=',
  '^=',
  '&&=',
  '||=',
  '??=',
  '??',
  '?.',
  '?',
  '//',
  '//=',
  '@',
  '@=',
  ':=',
  '<-',
  '<=>',
  '=~',
  '..',
  '...',
  '..=',
  '&&',
  '||',
  '!~',
  '&^',
  '&^=',
  '&.',
  // Member access/qualification are classical Halstead operators (floats and range/spread tokens
  // are distinct leaves, so `.` cannot collide with them). `->` also captures Python/Rust
  // return-type arrows, consistent with the counted `=>`.
  '.',
  '->',
  '::',
  '->*',
  '.*',
  'sizeof',
  'alignof',
  'defined?',
  'as',
  // C++ alternative operator tokens parse as anonymous leaves like their symbolic forms.
  'bitand',
  'bitor',
  'xor',
  'compl',
  'and_eq',
  'or_eq',
  'xor_eq',
  'not_eq',
  'and',
  'or',
  'not',
  'in',
  'is',
  'instanceof',
  'typeof',
  'new',
  'delete',
  'return',
  'throw',
  'raise',
  'yield',
  'await',
  'co_await',
  'co_yield',
  'co_return',
  'break',
  'continue',
]);

const operandNodeTypes = new Set([
  'identifier',
  'property_identifier',
  'field_identifier',
  'type_identifier',
  'constant',
  'instance_variable',
  'class_variable',
  'global_variable',
  'simple_symbol',
  'self',
  'this',
  'super',
  // C/C++/Rust built-in types are leaves of their own node type, unlike Go's `type_identifier`.
  'primitive_type',
  'boolean_type',
  'void_type',
  'auto',
  'number',
  'integer',
  'float',
  'integer_literal',
  'float_literal',
  'int_literal',
  'rune_literal',
  'imaginary_literal',
  'number_literal',
  'decimal_integer_literal',
  'hex_integer_literal',
  'octal_integer_literal',
  'binary_integer_literal',
  'decimal_floating_point_literal',
  'hex_floating_point_literal',
  'string',
  'string_literal',
  // Go raw strings are leaves with no content child, unlike Rust/C++ `raw_string_literal`s.
  'raw_string_literal',
  'string_fragment',
  'multiline_string_fragment',
  'string_content',
  'raw_string_content',
  'template_string',
  'character_literal',
  'char_literal',
  'character',
  'true',
  'false',
  'null',
  'null_literal',
  'undefined',
  'nil',
  'none',
]);

/**
 * Non-leaf literals counted as one Halstead operand without descending: Go interpreted strings
 * have no content leaf at all, and regex literals would otherwise count their `/` delimiters as
 * division operators. Interpolated regex contents are deliberately swallowed by the atom.
 */
// C++ user-defined literals (`42_km`) are atomic too, keeping their suffix in the operand identity,
// and multi-token built-in types (Java `int`, C `unsigned long`) wrap anonymous keyword leaves so
// they count as one operand.
const atomicOperandNodeTypes = new Set([
  'interpreted_string_literal',
  'regex',
  'user_defined_literal',
  'integral_type',
  'floating_point_type',
  'sized_type_specifier',
  'placeholder_type_specifier',
]);

interface ComplexityResult {
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  nestingDepth: number;
}

interface CommentSpan {
  line: number;
  startColumn: number;
  endColumn: number;
}

interface FunctionAnalysis {
  index: number;
  name?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  returnsJsx: boolean;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  nestingDepth: number;
  callCount: number;
  parameterCount: number;
  callees: Set<string>;
  identifiers: Set<string>;
}

interface StructuralMetrics {
  callGraph: CallGraphMetrics;
  cohesion: CohesionMetrics;
  coupling: CouplingMetrics;
  functions: FunctionMetrics[];
  module: ModuleMetrics;
  syntaxFeatures: SyntaxFeatureMetrics;
  typeComplexity: TypeComplexityMetrics;
}

export class TreeMeasurer {
  private readonly registry = createLanguageRegistry();

  registerLanguage(language: LanguageDefinition): void {
    this.registry.set(language.name, language);
    for (const alias of language.aliases ?? []) {
      this.registry.set(alias, language);
    }
  }

  getSupportedLanguages(): LanguageName[] {
    return [...new Set([...this.registry.values()].map((language) => language.name))];
  }

  measure(code: string, options: MeasureOptions): CodeMetrics {
    const language = this.registry.get(options.language);
    if (!language) {
      throw new Error(`Unsupported language: ${options.language}`);
    }

    const nativePayload = measureWithNativeBackend(code, language, options.includeSyntaxTree ?? false);
    if (nativePayload) {
      return assembleNativeMetrics(nativePayload, options.includeSyntaxTree ?? false);
    }

    const parser = new Parser();
    parser.setLanguage(language.parserLanguage);
    const tree = parser.parse(code, undefined, {
      bufferSize: code.length + 1,
    });
    const root = tree.rootNode;
    const functions = collectNodes(root, new Set(language.functionNodeTypes)).filter(
      (node) => !isLambdaBodyBlock(node) && isImplementedFunction(node)
    );
    const structuralMetrics = measureStructuralMetrics(root, functions, language);
    const functionMetrics = structuralMetrics.functions;
    const globalComplexity = measureComplexity(root, language, 0, false);
    const { lines, codeLineNumbers } = classifyLines(code, root);
    const halstead = measureHalstead(root, code);

    return {
      language: language.name,
      bytes: Buffer.byteLength(code),
      lines,
      functions: functionMetrics,
      classCount: countClasses(root, language),
      functionCount: functionMetrics.length,
      cyclomaticComplexity: globalComplexity.cyclomaticComplexity,
      maxCyclomaticComplexity: maxMetric(functionMetrics, 'cyclomaticComplexity'),
      cognitiveComplexity: globalComplexity.cognitiveComplexity,
      maxCognitiveComplexity: maxMetric(functionMetrics, 'cognitiveComplexity'),
      nestingDepth: globalComplexity.nestingDepth,
      callGraph: structuralMetrics.callGraph,
      coupling: structuralMetrics.coupling,
      module: structuralMetrics.module,
      cohesion: structuralMetrics.cohesion,
      syntaxFeatures: structuralMetrics.syntaxFeatures,
      typeComplexity: structuralMetrics.typeComplexity,
      duplication: measureDuplication(root, codeLineNumbers),
      halstead,
      maintainabilityIndex: calculateMaintainabilityIndex(
        halstead.volume,
        globalComplexity.cyclomaticComplexity,
        lines.code
      ),
      syntaxTree: options.includeSyntaxTree ? root.toString() : undefined,
    };
  }
}

export const defaultMeasurer = new TreeMeasurer();

export function measureCode(code: string, options: MeasureOptions): CodeMetrics {
  return defaultMeasurer.measure(code, options);
}

/**
 * Completes a native measurement into CodeMetrics. The object is rebuilt field by field (rather
 * than spread from the parsed JSON) so the result has exactly the shape the TypeScript backend
 * produces, including explicitly-undefined optional keys.
 */
function assembleNativeMetrics(payload: NativeMetricsPayload, includeSyntaxTree: boolean): CodeMetrics {
  const halstead = deriveHalsteadMetrics(payload.halsteadCounts);
  return {
    language: payload.language,
    bytes: payload.bytes,
    lines: payload.lines,
    functions: payload.functions.map((fn) => ({
      name: fn.name,
      startLine: fn.startLine,
      startColumn: fn.startColumn,
      endLine: fn.endLine,
      returnsJsx: fn.returnsJsx,
      cyclomaticComplexity: fn.cyclomaticComplexity,
      cognitiveComplexity: fn.cognitiveComplexity,
      nestingDepth: fn.nestingDepth,
      callCount: fn.callCount,
      uniqueCalleeCount: fn.uniqueCalleeCount,
      fanIn: fn.fanIn,
      fanOut: fn.fanOut,
      parameterCount: fn.parameterCount,
      recursive: fn.recursive,
    })),
    classCount: payload.classCount,
    functionCount: payload.functionCount,
    cyclomaticComplexity: payload.cyclomaticComplexity,
    maxCyclomaticComplexity: payload.maxCyclomaticComplexity,
    cognitiveComplexity: payload.cognitiveComplexity,
    maxCognitiveComplexity: payload.maxCognitiveComplexity,
    nestingDepth: payload.nestingDepth,
    callGraph: payload.callGraph,
    coupling: payload.coupling,
    module: payload.module,
    cohesion: payload.cohesion,
    syntaxFeatures: payload.syntaxFeatures,
    typeComplexity: payload.typeComplexity,
    duplication: payload.duplication,
    halstead,
    maintainabilityIndex: calculateMaintainabilityIndex(
      halstead.volume,
      payload.cyclomaticComplexity,
      payload.lines.code
    ),
    syntaxTree: includeSyntaxTree ? payload.syntaxTree : undefined,
  };
}

function measureStructuralMetrics(
  root: Parser.SyntaxNode,
  functions: Parser.SyntaxNode[],
  language: LanguageDefinition
): StructuralMetrics {
  const constructedTypeNames = collectConstructedTypeNames(root, language);
  const analyses = functions.map((node, index) => analyzeFunction(node, language, index, constructedTypeNames));
  const callGraph = measureCallGraph(analyses);
  const functionsWithGraph = analyses.map((analysis) => ({
    name: analysis.name,
    startLine: analysis.startLine,
    startColumn: analysis.startColumn,
    endLine: analysis.endLine,
    returnsJsx: analysis.returnsJsx,
    cyclomaticComplexity: analysis.cyclomaticComplexity,
    cognitiveComplexity: analysis.cognitiveComplexity,
    nestingDepth: analysis.nestingDepth,
    callCount: analysis.callCount,
    uniqueCalleeCount: analysis.callees.size,
    fanIn: callGraph.fanInByIndex.get(analysis.index) ?? 0,
    fanOut: callGraph.fanOutByIndex.get(analysis.index) ?? 0,
    parameterCount: analysis.parameterCount,
    recursive: callGraph.recursiveIndexes.has(analysis.index),
  }));

  return {
    functions: functionsWithGraph,
    callGraph: callGraph.metrics,
    coupling: measureCoupling(root, language),
    module: measureModule(root, language),
    cohesion: measureCohesion(analyses),
    syntaxFeatures: measureSyntaxFeatures(root, language.name),
    typeComplexity: measureTypeComplexity(root),
  };
}

function analyzeFunction(
  node: Parser.SyntaxNode,
  language: LanguageDefinition,
  index: number,
  constructedTypeNames: Set<string>
): FunctionAnalysis {
  const complexity = measureComplexity(node, language, 0, true);
  const calls = collectCalls(node, language, constructedTypeNames);
  return {
    index,
    name: findFunctionName(node),
    startLine: node.startPosition.row + 1,
    startColumn: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    returnsJsx: returnsJsx(node, language),
    cyclomaticComplexity: complexity.cyclomaticComplexity,
    cognitiveComplexity: complexity.cognitiveComplexity,
    nestingDepth: complexity.nestingDepth,
    callCount: calls.callCount,
    parameterCount: countParameters(node),
    callees: calls.callees,
    identifiers: collectIdentifiers(node),
  };
}

/** Counts declared parameters of a function/method, ignoring punctuation and comments. */
function countParameters(node: Parser.SyntaxNode): number {
  // An unparenthesized arrow-function parameter (`x => x + 1`) is a bare `parameter` field.
  if (node.childForFieldName('parameter')) {
    return 1;
  }

  const parametersNode = findParametersNode(node);
  if (!parametersNode) {
    return 0;
  }

  // A Java bare lambda parameter (`x -> x + 1`) puts a lone identifier in the `parameters` field.
  if (parametersNode.type === 'identifier') {
    return 1;
  }

  // Ruby block-locals after `;` (`{ |x; memo| ... }`) occupy `locals` fields and receive no arguments.
  const blockLocalIds = new Set(findChildrenByFieldName(parametersNode, 'locals').map((child) => child.id));
  // Rust's `self` and Java's explicit receiver (`void f(X this)`) are not declared parameters, and
  // C/C++ `f(void)` declares none.
  const namedCount = sum(
    parametersNode.namedChildren
      .filter(
        (child) =>
          child.type !== 'comment' &&
          child.type !== 'self_parameter' &&
          child.type !== 'receiver_parameter' &&
          // Python's PEP 570/3102 markers (`/`, `*`) separate parameter kinds but bind nothing.
          child.type !== 'positional_separator' &&
          child.type !== 'keyword_separator' &&
          !blockLocalIds.has(child.id) &&
          !isVoidParameter(child)
      )
      // Go declares several names per declaration (`a, b int`); each name is a parameter.
      .map((child) =>
        child.type === 'parameter_declaration' ? Math.max(1, findChildrenByFieldName(child, 'name').length) : 1
      )
  );
  // C++ C-style varargs (`int f(int a, ...)`) leave `...` as an anonymous token, unlike C's named
  // `variadic_parameter`.
  const anonymousVariadicCount = parametersNode.children.filter(
    (child) => !child.isNamed && child.text === '...'
  ).length;
  return namedCount + anonymousVariadicCount;
}

/** C/C++ `int f(void)` has a `parameter_declaration` whose type is a bare `void` with no declarator. */
function isVoidParameter(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'parameter_declaration' &&
    node.childForFieldName('declarator') === null &&
    node.childForFieldName('type')?.text === 'void'
  );
}

function findParametersNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const direct = node.childForFieldName('parameters');
  if (direct) {
    return direct;
  }

  // A Java compact constructor implicitly takes the record's components, declared on the
  // `record_declaration` two levels up (via `class_body`).
  if (node.type === 'compact_constructor_declaration') {
    return node.parent?.parent?.childForFieldName('parameters') ?? undefined;
  }

  // C/C++ parameters hang off the (possibly pointer/reference-wrapped) declarator, not the
  // definition itself.
  let declarator: Parser.SyntaxNode | null | undefined = node.childForFieldName('declarator');
  while (declarator) {
    const parameters = declarator.childForFieldName('parameters');
    if (parameters) {
      return parameters;
    }
    declarator = nextDeclarator(declarator);
  }

  return node.namedChildren.find((child) => child.type === 'formal_parameters' || child.type === 'parameter_list');
}

function measureCallGraph(analyses: FunctionAnalysis[]): {
  fanInByIndex: Map<number, number>;
  fanOutByIndex: Map<number, number>;
  metrics: CallGraphMetrics;
  recursiveIndexes: Set<number>;
} {
  const indexesByName = mapUniqueFunctionIndexesByName(analyses);
  const functionNames = new Set(indexesByName.keys());
  const fanInByIndex = new Map<number, number>();
  const fanOutByIndex = new Map<number, number>();
  const graph = new Map<number, Set<number>>();
  let callCount = 0;
  let internalCallCount = 0;
  const allCallees = new Set<string>();

  for (const analysis of analyses) {
    callCount += analysis.callCount;
    for (const callee of analysis.callees) {
      allCallees.add(callee);
    }

    const internalCalleeNames = new Set([...analysis.callees].filter((callee) => functionNames.has(callee)));
    const internalCalleeIndexes = new Set<number>();
    for (const callee of internalCalleeNames) {
      const calleeIndex = indexesByName.get(callee);
      if (calleeIndex !== undefined) {
        internalCalleeIndexes.add(calleeIndex);
      }
    }

    graph.set(analysis.index, internalCalleeIndexes);
    fanOutByIndex.set(analysis.index, internalCalleeNames.size);
    internalCallCount += internalCalleeNames.size;
    for (const calleeIndex of internalCalleeIndexes) {
      fanInByIndex.set(calleeIndex, (fanInByIndex.get(calleeIndex) ?? 0) + 1);
    }
  }

  const recursiveIndexes = findRecursiveIndexes(graph);

  return {
    fanInByIndex,
    fanOutByIndex,
    recursiveIndexes,
    metrics: {
      callCount,
      uniqueCalleeCount: allCallees.size,
      internalCallCount,
      internalEdgeCount: sum([...graph.values()].map((callees) => callees.size)),
      recursiveFunctionCount: recursiveIndexes.size,
      maxFanIn: maxMapValue(fanInByIndex),
      maxFanOut: maxMapValue(fanOutByIndex),
      maxCallDepth: measureMaxCallDepth(graph),
    },
  };
}

function mapUniqueFunctionIndexesByName(analyses: FunctionAnalysis[]): Map<string, number> {
  const indexesByName = new Map<string, number | undefined>();
  for (const analysis of analyses) {
    if (!analysis.name) {
      continue;
    }

    indexesByName.set(analysis.name, indexesByName.has(analysis.name) ? undefined : analysis.index);
  }
  return new Map([...indexesByName.entries()].filter((entry): entry is [string, number] => entry[1] !== undefined));
}

/**
 * C++ `function_definition` also covers pure-virtual/`= default`/`= delete` members and Java
 * `method_declaration` covers abstract/interface methods; those have no `body` and are signatures,
 * not implementations, matching how TypeScript method signatures are excluded.
 */
const bodyRequiredFunctionTypes = new Set([
  'function_definition',
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  // Rust trait method signatures (`fn required(&self);`) never carry a body.
  'function_signature_item',
]);

function isImplementedFunction(node: Parser.SyntaxNode): boolean {
  if (!bodyRequiredFunctionTypes.has(node.type) || node.childForFieldName('body') !== null) {
    return true;
  }

  // C++ constructor/destructor function-try-blocks carry their `try_statement` outside the
  // `body` field; they are implementations, unlike `= 0`/`= default`/`= delete` members.
  return node.namedChildren.some((child) => child.type === 'try_statement');
}

/**
 * A Ruby stabby lambda (`->(x) { ... }`) wraps its body in a `block`/`do_block`, which is itself a
 * function node type; the wrapper is part of the lambda, not a separate function, so it must not
 * count as one or act as a nested-function boundary.
 */
function isLambdaBodyBlock(node: Parser.SyntaxNode): boolean {
  return (node.type === 'block' || node.type === 'do_block') && node.parent?.type === 'lambda';
}

function isFunctionBoundary(node: Parser.SyntaxNode, functionNodeTypes: Set<string>): boolean {
  return functionNodeTypes.has(node.type) && !isLambdaBodyBlock(node);
}

function measureComplexity(
  node: Parser.SyntaxNode,
  language: LanguageDefinition,
  nesting: number,
  stopAtNestedFunctions: boolean
): ComplexityResult {
  let cyclomaticComplexity = 1;
  let cognitiveComplexity = 0;
  let nestingDepth = nesting;
  const functionNodes = new Set(language.functionNodeTypes);
  const decisionNodes = new Set(language.decisionNodeTypes);
  const nestingNodes = new Set(language.nestingNodeTypes);

  function visit(current: Parser.SyntaxNode, currentNesting: number, insideRoot: boolean): void {
    if (stopAtNestedFunctions && !insideRoot && isFunctionBoundary(current, functionNodes)) {
      return;
    }

    // Anonymous keyword tokens can share a type with named nodes (Ruby's `if` node contains an
    // `if` keyword token), so only named nodes count as decisions.
    const isDecision = current.isNamed && decisionNodes.has(current.type) && !isDefaultSwitchBranch(current);
    const isNesting = current.isNamed && nestingNodes.has(current.type) && !isDefaultSwitchBranch(current);
    // `elsif`/`elif`/`else if` continue a flat chain: they add a decision without a nesting
    // surcharge, and their bodies stay at the chain's nesting level (Sonar cognitive-complexity
    // semantics); genuinely nested conditionals inside those bodies still deepen.
    const isContinuation = isDecision && isFlatChainContinuation(current);

    if (isDecision) {
      cyclomaticComplexity += 1;
      cognitiveComplexity += isContinuation ? 1 : 1 + currentNesting;
    }

    if (isBooleanOperator(current)) {
      cyclomaticComplexity += 1;
      cognitiveComplexity += 1;
    }

    // Pattern guards (Java `when`, Ruby `in y if ...`, Python `case n if ...`, Rust `n if ... =>`)
    // add one independent execution path without nesting.
    if (isPatternGuard(current)) {
      cyclomaticComplexity += 1;
      cognitiveComplexity += 1;
    }

    const childNesting = isNesting && !isContinuation ? currentNesting + 1 : currentNesting;
    nestingDepth = Math.max(nestingDepth, childNesting);

    for (const child of current.children) {
      visit(child, childNesting, false);
    }
  }

  for (const child of node.children) {
    visit(child, nesting, false);
  }

  return { cyclomaticComplexity, cognitiveComplexity, nestingDepth };
}

/** Java `guard`, Ruby `if_guard`, Python `if_clause`, and Rust guards inside `match_pattern`. */
function isPatternGuard(node: Parser.SyntaxNode): boolean {
  if (!node.isNamed) {
    return false;
  }
  if (node.type === 'guard' || node.type === 'if_guard' || node.type === 'unless_guard' || node.type === 'if_clause') {
    return true;
  }
  return node.type === 'match_pattern' && node.children.some((child) => !child.isNamed && child.type === 'if');
}

/** Ruby `elsif`, Python `elif`, and `else if` (an if node in an else/alternative position). */
function isFlatChainContinuation(node: Parser.SyntaxNode): boolean {
  if (node.type === 'elsif' || node.type === 'elif_clause') {
    return true;
  }
  if (node.type !== 'if_statement' && node.type !== 'if_expression' && node.type !== 'if') {
    return false;
  }
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  // JS/C/C++/Rust wrap `else if` in an else clause; Java/Go put it directly in `alternative`.
  return parent.type === 'else_clause' || parent.childForFieldName('alternative')?.id === node.id;
}

/**
 * C/C++ `default:` shares the `case_statement` node type with `case` (only `case` has a `value`
 * field), and Java's default group/rule carries an expressionless `switch_label`; a default branch
 * adds no decision, so these must not count toward complexity or nesting.
 */
function isDefaultSwitchBranch(node: Parser.SyntaxNode): boolean {
  if (node.type === 'case_statement') {
    return node.childForFieldName('value') === null;
  }

  if (node.type === 'switch_block_statement_group' || node.type === 'switch_rule') {
    const label = node.namedChildren.find((child) => child.type === 'switch_label');
    return label !== undefined && label.namedChildCount === 0;
  }

  // Python `case _:` / `case y:` and Rust `_ =>` fallback arms are unconditional like `default`
  // (a bare Python name is always a capture); a guard is charged separately as a flat decision,
  // so the arm itself still adds nothing. Rust bare identifiers are NOT suppressed: they can name
  // constants or unit variants, which the grammar cannot distinguish from captures.
  if (node.type === 'case_clause' || node.type === 'match_arm') {
    const pattern = node.namedChildren.find((child) => child.type === 'case_pattern' || child.type === 'match_pattern');
    if (!pattern) {
      return false;
    }
    if (pattern.child(0)?.type === '_' && (pattern.childCount === 1 || pattern.child(1)?.type === 'if')) {
      return true;
    }
    const soleChild = pattern.namedChildCount === 1 ? pattern.namedChild(0) : undefined;
    return (
      node.type === 'case_clause' &&
      soleChild?.type === 'dotted_name' &&
      soleChild.namedChildCount === 1 &&
      soleChild.namedChild(0)?.type === 'identifier'
    );
  }

  // Ruby `in y` binds unconditionally (bare lowercase names are variable captures; constants and
  // literals are tests).
  if (node.type === 'in_clause') {
    return node.namedChild(0)?.type === 'identifier';
  }

  return false;
}

/** Parents under which `&&`/`||`/`and`/`or` tokens are actual boolean operators. */
const booleanOperatorParentTypes = new Set(['binary_expression', 'binary', 'boolean_operator']);

/**
 * The parent guard is required because the same tokens appear in non-boolean syntax: C++ rvalue
 * references (`int&&`), ref-qualifiers, `operator&&`, and Rust's empty closure parameter list
 * (`|| 5`) must not count as decisions.
 */
function isBooleanOperator(node: Parser.SyntaxNode): boolean {
  if (node.isNamed || !booleanOperators.has(node.text)) {
    return false;
  }

  const parent = node.parent;
  return parent !== null && booleanOperatorParentTypes.has(parent.type);
}

function collectCalls(
  root: Parser.SyntaxNode,
  language: LanguageDefinition,
  constructedTypeNames: Set<string> = new Set()
): { callCount: number; callees: Set<string> } {
  const callees = new Set<string>();
  const functionNodeTypes = new Set(language.functionNodeTypes);
  let callCount = 0;

  function visit(node: Parser.SyntaxNode, insideRoot: boolean): void {
    if (!insideRoot && isFunctionBoundary(node, functionNodeTypes)) {
      return;
    }

    // C++ casts (`int(x)`, `static_cast<int>(x)`) parse as call expressions but invoke nothing.
    if (language.name === 'cpp' && isCppCastExpression(node)) {
      // Not a call: fall through to children only.
    } else if (isCallNode(node)) {
      callCount += 1;
      // C++ `new Widget()` and functional construction `Widget(1)` / `ns::Widget(1)` /
      // `Box<int>(1)` name an overloaded constructor, so — like direct construction — they count
      // as calls without a callee edge. JS `new Foo()` keeps its edge to the function.
      const isCppConstructorCall =
        language.name === 'cpp' &&
        (node.type === 'new_expression' ||
          (node.type === 'call_expression' &&
            constructedTypeNames.has(cppBaseTypeName(node.childForFieldName('function')) ?? '')));
      const callee = isCppConstructorCall ? undefined : findCalleeName(node);
      if (callee) {
        callees.add(callee);
      }
      // Ruby abbreviated assignment on a receiver (`self.foo += 1`, `self.foo ||= x`) invokes the
      // getter (the call node itself) AND the setter, so the setter is one extra call.
      if (
        language.name === 'ruby' &&
        node.type === 'call' &&
        node.parent?.type === 'operator_assignment' &&
        node.parent.childForFieldName('left')?.id === node.id
      ) {
        callCount += 1;
        const setterMethod = node.childForFieldName('method');
        if (setterMethod) {
          callees.add(`${setterMethod.text}=`);
        }
      }
    } else if (isRubyImplicitCall(node, language) || isCppConstruction(node, constructedTypeNames)) {
      // `yield x` invokes the block, not its argument `x`, and constructors are overloaded by
      // definition, so neither adds a callee edge.
      callCount += 1;
    }

    for (const child of node.namedChildren) {
      visit(child, false);
    }
  }

  visit(root, true);
  return { callCount, callees };
}

const cppNamedCasts = new Set(['static_cast', 'dynamic_cast', 'const_cast', 'reinterpret_cast']);

/** C++ casts parse as call expressions (`int(x)`, `static_cast<int>(x)`) but invoke nothing. */
function isCppCastExpression(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'call_expression') {
    return false;
  }
  const callee = node.childForFieldName('function');
  if (callee?.type === 'primitive_type') {
    return true;
  }
  const name = callee?.type === 'template_function' ? callee.childForFieldName('name')?.text : callee?.text;
  return name !== undefined && cppNamedCasts.has(name);
}

/**
 * C++ direct and list construction (`Foo a(1)`, `Foo b{2}`, `Foo{3}`) invoke a constructor without
 * a call node. Only types defined in the measured tree count, so scalar initialization
 * (`int a(1)`) and external types stay excluded.
 */
function isCppConstruction(node: Parser.SyntaxNode, constructedTypeNames: Set<string>): boolean {
  if (constructedTypeNames.size === 0) {
    return false;
  }
  if (node.type === 'compound_literal_expression') {
    return constructedTypeNames.has(cppBaseTypeName(node.childForFieldName('type')) ?? '');
  }
  if (node.type === 'init_declarator') {
    const value = node.childForFieldName('value');
    if (value?.type !== 'argument_list' && value?.type !== 'initializer_list') {
      return false;
    }
    return constructedTypeNames.has(cppBaseTypeName(node.parent?.childForFieldName('type')) ?? '');
  }
  // Default construction (`Widget value;`, `Widget values[2];`): a bare identifier or array
  // declarator of a local class type. `extern` declarations declare without constructing, and
  // pointer chains construct nothing.
  if (
    (node.type === 'identifier' || node.type === 'array_declarator') &&
    node.parent?.type === 'declaration' &&
    findChildrenByFieldName(node.parent, 'declarator').some((declarator) => declarator.id === node.id) &&
    !hasStorageClass(node.parent, 'extern')
  ) {
    let current: Parser.SyntaxNode | null | undefined = node;
    while (current?.type === 'array_declarator') {
      current = current.childForFieldName('declarator');
    }
    return (
      current?.type === 'identifier' &&
      constructedTypeNames.has(cppBaseTypeName(node.parent.childForFieldName('type')) ?? '')
    );
  }
  // Base/delegating constructor initializers (`Widget() : Base(1) {}`). The grammar names both
  // base classes and members as `field_identifier`, so they are told apart by whether the name is
  // a locally defined class — the same base-name trade documented on cppBaseTypeName.
  if (node.type === 'field_initializer') {
    const nameNode = node.namedChild(0);
    const name = nameNode?.type === 'field_identifier' ? nameNode.text : cppBaseTypeName(nameNode);
    return constructedTypeNames.has(name ?? '');
  }
  return false;
}

/**
 * Base name of a possibly qualified/templated C++ type or callee (`ns::Box<int>` -> `Box`).
 * Matching by base name treats a same-named external type as local — a conservative trade
 * accepted over tracking full namespace scopes.
 */
function cppBaseTypeName(node: Parser.SyntaxNode | null | undefined): string | undefined {
  let current: Parser.SyntaxNode | null | undefined = node;
  while (current) {
    if (current.type === 'type_identifier' || current.type === 'identifier') {
      return current.text;
    }
    if (
      current.type === 'qualified_identifier' ||
      current.type === 'scoped_identifier' ||
      current.type === 'template_type' ||
      current.type === 'template_function'
    ) {
      current = current.childForFieldName('name');
      continue;
    }
    return undefined;
  }
  return undefined;
}

const cppClassSpecifierTypes = new Set(['class_specifier', 'struct_specifier', 'union_specifier']);

/** Names of C++ class-like types defined (with a body) in this tree, for construction counting. */
function collectConstructedTypeNames(root: Parser.SyntaxNode, language: LanguageDefinition): Set<string> {
  const names = new Set<string>();
  if (language.name !== 'cpp') {
    return names;
  }
  for (const node of collectNodes(root, cppClassSpecifierTypes)) {
    const name = node.childForFieldName('name')?.text;
    if (name && node.childForFieldName('body')) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Ruby's bare `yield` and `super` invoke without a `call` node (only `super()` parses as `call`,
 * whose `super` child must not double-count), so they add to the call count without a callee edge.
 * Language-gated because Python `yield` and JS/Java `super` children are not extra calls.
 * Bare receiverless zero-argument sends (`helper` alone) are deliberately NOT counted: they parse
 * as plain identifiers, and telling them apart from local-variable reads requires Ruby's
 * lexically-ordered binding analysis — a static-analysis boundary this measurer does not cross.
 */
function isRubyImplicitCall(node: Parser.SyntaxNode, language: LanguageDefinition): boolean {
  if (language.name !== 'ruby') {
    return false;
  }
  return node.type === 'yield' || (node.type === 'super' && node.parent?.type !== 'call');
}

function collectIdentifiers(root: Parser.SyntaxNode): Set<string> {
  const identifiers = new Set<string>();

  function visit(node: Parser.SyntaxNode): void {
    if (
      node.type === 'identifier' ||
      node.type === 'property_identifier' ||
      node.type === 'field_identifier' ||
      node.type === 'constant' ||
      node.type === 'instance_variable' ||
      node.type === 'class_variable' ||
      node.type === 'global_variable'
    ) {
      identifiers.add(node.text);
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return identifiers;
}

/** C/C++ `struct Foo`-style type references reuse the declaration node type, so a body is required. */
function countClasses(root: Parser.SyntaxNode, language: LanguageDefinition): number {
  return collectNodes(root, new Set(language.classNodeTypes)).filter(isCountableClassNode).length;
}

/**
 * C/C++ `struct Foo;` forward declarations define no class, and Java `new Runnable() { ... }` /
 * enum constants define an anonymous class only when they carry a `class_body` (JLS 15.9.5).
 */
function isCountableClassNode(node: Parser.SyntaxNode): boolean {
  if (node.type === 'object_creation_expression' || node.type === 'enum_constant') {
    return node.namedChildren.some((child) => child.type === 'class_body');
  }
  return !node.type.endsWith('_specifier') || node.childForFieldName('body') !== null;
}

function collectNodes(root: Parser.SyntaxNode, nodeTypes: Set<string>): Parser.SyntaxNode[] {
  const nodes: Parser.SyntaxNode[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (nodeTypes.has(node.type)) {
      nodes.push(node);
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return nodes;
}

function returnsJsx(root: Parser.SyntaxNode, language: LanguageDefinition): boolean {
  const functionNodeTypes = new Set(language.functionNodeTypes);

  function visit(node: Parser.SyntaxNode, insideRoot: boolean): boolean {
    if (!insideRoot && functionNodeTypes.has(node.type)) {
      return false;
    }

    if (node.type === 'return_statement') {
      return containsJsxExpression(node, functionNodeTypes) || containsReactCreateElementCall(node, functionNodeTypes);
    }

    if (
      root.type === 'arrow_function' &&
      node === getArrowFunctionBody(root) &&
      node.type !== 'statement_block' &&
      !functionNodeTypes.has(node.type)
    ) {
      return containsJsxExpression(node, functionNodeTypes) || containsReactCreateElementCall(node, functionNodeTypes);
    }

    for (const child of node.namedChildren) {
      if (visit(child, false)) {
        return true;
      }
    }
    return false;
  }

  return visit(root, true);
}

function getArrowFunctionBody(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  return node.childForFieldName('body') ?? node.namedChild(node.namedChildCount - 1) ?? undefined;
}

function containsJsxExpression(root: Parser.SyntaxNode, functionNodeTypes: Set<string>): boolean {
  return containsNode(
    root,
    functionNodeTypes,
    (node) => node.type.startsWith('jsx_') || isJsxMappingCall(node, functionNodeTypes)
  );
}

function containsReactCreateElementCall(root: Parser.SyntaxNode, functionNodeTypes: Set<string>): boolean {
  return containsNode(root, functionNodeTypes, isReactCreateElementCall);
}

function containsNode(
  root: Parser.SyntaxNode,
  functionNodeTypes: Set<string>,
  predicate: (node: Parser.SyntaxNode) => boolean
): boolean {
  function visit(node: Parser.SyntaxNode, insideRoot: boolean): boolean {
    if (!insideRoot && functionNodeTypes.has(node.type)) {
      return false;
    }

    if (predicate(node)) {
      return true;
    }

    for (const child of node.namedChildren) {
      if (visit(child, false)) {
        return true;
      }
    }
    return false;
  }

  return visit(root, true);
}

function isJsxMappingCall(node: Parser.SyntaxNode, functionNodeTypes: Set<string>): boolean {
  if (!isCallNode(node) || !isArrayMappingCallee(node.childForFieldName('function') ?? node.namedChild(0))) {
    return false;
  }

  return node.namedChildren.some((child) => containsReturnedJsxFunction(child, functionNodeTypes));
}

function isArrayMappingCallee(node: Parser.SyntaxNode | null): boolean {
  if (!node) {
    return false;
  }

  const calleeName = findRightmostIdentifier(node);
  return calleeName === 'map' || calleeName === 'flatMap';
}

function containsReturnedJsxFunction(root: Parser.SyntaxNode, functionNodeTypes: Set<string>): boolean {
  if (functionNodeTypes.has(root.type)) {
    return returnsJsxFromFunctionNode(root, functionNodeTypes);
  }

  return root.namedChildren.some((child) => containsReturnedJsxFunction(child, functionNodeTypes));
}

function returnsJsxFromFunctionNode(root: Parser.SyntaxNode, functionNodeTypes: Set<string>): boolean {
  const body = root.type === 'arrow_function' ? getArrowFunctionBody(root) : undefined;
  if (body && body.type !== 'statement_block' && !functionNodeTypes.has(body.type)) {
    return containsJsxExpression(body, functionNodeTypes) || containsReactCreateElementCall(body, functionNodeTypes);
  }

  return containsOwnReturnNode(
    root,
    functionNodeTypes,
    (node) => containsJsxExpression(node, functionNodeTypes) || containsReactCreateElementCall(node, functionNodeTypes)
  );
}

function containsOwnReturnNode(
  root: Parser.SyntaxNode,
  functionNodeTypes: Set<string>,
  predicate: (node: Parser.SyntaxNode) => boolean
): boolean {
  function visit(node: Parser.SyntaxNode, insideRoot: boolean): boolean {
    if (!insideRoot && functionNodeTypes.has(node.type)) {
      return false;
    }

    if (node.type === 'return_statement' && predicate(node)) {
      return true;
    }

    for (const child of node.namedChildren) {
      if (visit(child, false)) {
        return true;
      }
    }
    return false;
  }

  return visit(root, true);
}

function measureModule(root: Parser.SyntaxNode, language: LanguageDefinition): ModuleMetrics {
  const importSources = new Set<string>();

  function visitImports(node: Parser.SyntaxNode): void {
    if (isImportSourceNode(node, language)) {
      for (const source of findImportSources(node, language, { expandPythonSubmodules: true })) {
        importSources.add(source);
      }
    }

    for (const child of node.namedChildren) {
      visitImports(child);
    }
  }

  visitImports(root);

  return {
    declarations: collectModuleDeclarations(root, language),
    importSources: [...importSources],
  };
}

function collectModuleDeclarations(root: Parser.SyntaxNode, language: LanguageDefinition): DeclarationMetrics[] {
  const exportedNames = collectExportedNames(root);
  const scope = language.name === 'java' ? findJavaPackageScope(root) : '';
  return root.namedChildren
    .flatMap((child) => collectTopLevelDeclarations(child, false, scope, language.name === 'cpp'))
    .map((declaration) => (exportedNames.has(declaration.name) ? { ...declaration, exported: true } : declaration));
}

/** Java top-level declarations are qualified by their package so simple names stay distinct. */
function findJavaPackageScope(root: Parser.SyntaxNode): string {
  const packageNode = root.namedChildren.find((child) => child.type === 'package_declaration');
  const nameNode = packageNode?.namedChildren.find(
    (child) => child.type === 'scoped_identifier' || child.type === 'identifier'
  );
  return nameNode ? `${nameNode.text}::` : '';
}

const rubyTypeNodeTypes = new Set(['module', 'class', 'singleton_class']);

function collectTopLevelDeclarations(
  node: Parser.SyntaxNode,
  exported: boolean,
  scope = '',
  isCpp = false
): DeclarationMetrics[] {
  if (isModuleExportNode(node)) {
    return node.namedChildren.flatMap((child) => collectTopLevelDeclarations(child, true, scope, isCpp));
  }

  // C++ namespaces qualify their contents so `Alpha::ServiceThing` and `Beta::ServiceThing` stay
  // distinct in cross-file symbol groups; anonymous namespaces give internal linkage and declare
  // no cross-file symbols at all.
  if (node.type === 'namespace_definition') {
    const name = node.childForFieldName('name')?.text;
    if (!name) {
      return [];
    }
    const bodyNode = node.childForFieldName('body');
    return (bodyNode?.namedChildren ?? []).flatMap((child) =>
      collectTopLevelDeclarations(child, exported, `${scope}${name}::`, isCpp)
    );
  }

  if (isDeclarationContainer(node)) {
    return node.namedChildren.flatMap((child) => collectTopLevelDeclarations(child, exported, scope, isCpp));
  }

  // C/C++ global variables live in `declaration` nodes with one or more declarators.
  if (node.type === 'declaration') {
    return qualifyDeclarations(declarationsFromCDeclaration(node, exported, isCpp), scope);
  }

  // C `typedef` declares alias name(s) and possibly a tagged type in one node.
  if (node.type === 'type_definition') {
    return qualifyDeclarations(declarationsFromTypeDefinition(node, exported), scope);
  }

  // Ruby modules/classes nest further types in their body, like C++ namespaces.
  if (rubyTypeNodeTypes.has(node.type)) {
    return declarationsFromRubyType(node, exported, scope);
  }

  // Ruby constant assignment (`FOO = 1`, `MIN, MAX = 1, 10`, `LIMIT ||= 10`) is the language's
  // only constant syntax; constants are a module's canonical public API. Other grammars never
  // put a `constant` node on an assignment LHS.
  if (node.type === 'assignment' || node.type === 'operator_assignment') {
    return qualifyDeclarations(rubyConstantDeclarations(node, exported), scope, true);
  }

  return qualifyDeclarations(declarationFromNode(node, exported), scope);
}

/**
 * Prefixes declarations with the enclosing scope. Ruby callers pass `skipQualified` because
 * `class A::B` / `A::C = 1` names are already qualified and re-prefixing would double them
 * (`A::A::B`); C++ out-of-line names (`Widget::process`) must still gain their namespace prefix.
 */
function qualifyDeclarations(
  declarations: DeclarationMetrics[],
  scope: string,
  skipQualified = false
): DeclarationMetrics[] {
  if (!scope) {
    return declarations;
  }
  return declarations.map((declaration) =>
    skipQualified && declaration.name.includes('::')
      ? declaration
      : { ...declaration, name: `${scope}${declaration.name}` }
  );
}

/**
 * Emits a Ruby type and its nested types. Methods are intentionally not collected as module
 * declarations: names like `initialize` repeat everywhere and would flood cross-file
 * duplicate-symbol groups.
 */
function declarationsFromRubyType(node: Parser.SyntaxNode, exported: boolean, scope = ''): DeclarationMetrics[] {
  const declarations = qualifyDeclarations(declarationFromNode(node, exported), scope, true);
  // Nested types and constants are qualified by their enclosing module path (`Alpha::LIMIT`) so
  // same-named symbols under different modules stay distinct in cross-file symbol groups.
  const childScope = declarations[0] ? `${declarations[0].name}::` : scope;
  const bodyNode = node.childForFieldName('body');
  for (const child of bodyNode?.namedChildren ?? []) {
    if (rubyTypeNodeTypes.has(child.type)) {
      declarations.push(...declarationsFromRubyType(child, exported, childScope));
    } else if (child.type === 'assignment' || child.type === 'operator_assignment') {
      declarations.push(...qualifyDeclarations(rubyConstantDeclarations(child, exported), childScope, true));
    }
  }
  return declarations;
}

/**
 * Emits declarations for Ruby constant assignments: `CONST = ...`, qualified `A::CONST = ...`,
 * multiple `MIN, MAX = ...`, and `CONST ||= ...` (the only operator assignment that can define an
 * unset constant); other assignments (locals, ivars, `Foo.bar =` setters) declare nothing.
 */
function rubyConstantDeclarations(node: Parser.SyntaxNode, exported: boolean): DeclarationMetrics[] {
  if (node.type === 'operator_assignment' && !node.children.some((child) => !child.isNamed && child.text === '||=')) {
    return [];
  }
  const left = node.childForFieldName('left');
  if (!left) {
    return [];
  }
  const targets = left.type === 'left_assignment_list' ? left.namedChildren : [left];
  return targets
    .filter(
      (target) =>
        target.type === 'constant' ||
        (target.type === 'scope_resolution' && target.childForFieldName('name')?.type === 'constant')
    )
    .map((target) => ({ exported, name: target.text, startLine: target.startPosition.row + 1 }));
}

function declarationsFromTypeDefinition(node: Parser.SyntaxNode, exported: boolean): DeclarationMetrics[] {
  // `typedef struct Foo { ... } Bar;` declares both the tag `Foo` and the alias `Bar`.
  const typeNode = node.childForFieldName('type');
  const declarations = typeNode ? declarationFromNode(typeNode, exported) : [];
  // The opaque-type idiom `typedef struct X X;` only forward-declares a tag defined elsewhere —
  // like a function prototype — so its alias must not collide with the tag's definition.
  const bodylessTagName =
    typeNode?.type.endsWith('_specifier') && !typeNode.childForFieldName('body')
      ? typeNode.childForFieldName('name')?.text
      : undefined;
  const seenNames = new Set(declarations.map((declaration) => declaration.name));
  for (const declarator of findChildrenByFieldName(node, 'declarator')) {
    const name = declarator.type === 'type_identifier' ? declarator.text : unwrapDeclaratorName(declarator);
    if (name && name !== bodylessTagName && !seenNames.has(name)) {
      seenNames.add(name);
      declarations.push({ exported, name, startLine: declarator.startPosition.row + 1 });
    }
  }
  return declarations;
}

const cVariableDeclaratorTypes = new Set([
  'init_declarator',
  'pointer_declarator',
  'array_declarator',
  'reference_declarator',
  'identifier',
  // C/C++ struct/class members
  'field_identifier',
]);

/**
 * A bare `function_declarator` (`int f(int);`) is a prototype, but one whose name is parenthesized
 * (`int (*fp)(int);`) declares a function-pointer variable. Pointer/reference-returning prototypes
 * (`int *f(void);`) wrap the function declarator and are prototypes all the same.
 */
function isCVariableDeclarator(node: Parser.SyntaxNode): boolean {
  if (node.type === 'pointer_declarator' || node.type === 'reference_declarator') {
    let current: Parser.SyntaxNode | null | undefined = node;
    while (
      current &&
      (current.type === 'pointer_declarator' ||
        current.type === 'reference_declarator' ||
        current.type === 'array_declarator')
    ) {
      current = nextDeclarator(current);
    }
    if (current?.type === 'function_declarator') {
      return current.childForFieldName('declarator')?.type === 'parenthesized_declarator';
    }
    return true;
  }

  if (cVariableDeclaratorTypes.has(node.type)) {
    return true;
  }

  return (
    node.type === 'function_declarator' && node.childForFieldName('declarator')?.type === 'parenthesized_declarator'
  );
}

/** `storage_class_specifier` exists only in the C/C++ grammars, so this is language-safe. */
function hasStorageClass(node: Parser.SyntaxNode, keyword: string): boolean {
  return node.children.some((child) => child.type === 'storage_class_specifier' && child.text === keyword);
}

/**
 * tree-sitter-cpp has no C++20 module support, so `export module foo;` / `import bar;` misparse as
 * `declaration` nodes whose "type" is the keyword; they declare nothing and bind nothing. A file
 * that visibly aliases the name as a type (`typedef int module;`) makes such declarations ordinary
 * variables again — `module`/`import` are keywords only within recognized module directives.
 */
function isMisparsedCppModuleDeclaration(node: Parser.SyntaxNode): boolean {
  const typeNode = node.childForFieldName('type');
  if (
    typeNode?.type !== 'type_identifier' ||
    (typeNode.text !== 'import' && typeNode.text !== 'export' && typeNode.text !== 'module')
  ) {
    return false;
  }
  return !hasVisibleTypeAlias(node, typeNode.text);
}

/** Whether the file typedefs/aliases `name` as a type, disambiguating module-keyword misparses. */
function hasVisibleTypeAlias(node: Parser.SyntaxNode, name: string): boolean {
  let root = node;
  while (root.parent) {
    root = root.parent;
  }
  return collectNodes(root, new Set(['type_definition', 'alias_declaration'])).some((definition) => {
    const declarator = definition.childForFieldName('declarator') ?? definition.childForFieldName('name');
    return declarator?.text === name;
  });
}

/**
 * Extracts each declared variable from a C/C++ `declaration`. Prototypes intentionally declare no
 * symbol: emitting them would pair every header prototype with its definition in another file and
 * flood cross-file duplicate-symbol groups.
 */
function declarationsFromCDeclaration(node: Parser.SyntaxNode, exported: boolean, isCpp = false): DeclarationMetrics[] {
  if ((isCpp && isMisparsedCppModuleDeclaration(node)) || hasStorageClass(node, 'static')) {
    return [];
  }
  // `struct Foo { int x; } value;` defines the tag `Foo` alongside the variable; body-less type
  // references (`struct Foo value;`) are rejected by declarationFromNode's body check.
  const typeNode = node.childForFieldName('type');
  const declarations = typeNode ? declarationFromNode(typeNode, exported) : [];
  const seenNames = new Set(declarations.map((declaration) => declaration.name));
  const isExtern = hasStorageClass(node, 'extern');
  for (const child of node.namedChildren.filter(isCVariableDeclarator)) {
    // A non-initializing `extern` declarator only re-declares a symbol defined elsewhere — like a
    // prototype — and must not collide with that definition in symbol groups.
    if (isExtern && child.type !== 'init_declarator') {
      continue;
    }
    // C++ (unlike C) gives namespace-scope const variables internal linkage unless they are
    // extern, inline, or references, so they are file-local rather than cross-file symbols.
    if (
      isCpp &&
      !isExtern &&
      !hasStorageClass(node, 'inline') &&
      !declaratorChainContainsReference(child) &&
      !isCMutableBinding(node, child)
    ) {
      continue;
    }
    const name = unwrapDeclaratorName(child);
    if (name && !seenNames.has(name)) {
      seenNames.add(name);
      declarations.push({ exported, name, startLine: child.startPosition.row + 1 });
    }
  }
  return declarations;
}

function declaratorChainContainsReference(declarator: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null | undefined =
    declarator.type === 'init_declarator' ? (declarator.childForFieldName('declarator') ?? declarator) : declarator;
  while (current) {
    if (current.type === 'reference_declarator') {
      return true;
    }
    current = nextDeclarator(current);
  }
  return false;
}

function declarationFromNode(node: Parser.SyntaxNode, exported: boolean): DeclarationMetrics[] {
  // C/C++ `struct Foo;`-style forward declarations reuse the declaration node type; only
  // definitions with a body declare a module-level symbol.
  if (!isTopLevelDeclarationNode(node) || (node.type.endsWith('_specifier') && !node.childForFieldName('body'))) {
    return [];
  }

  // C/C++ `static` gives internal linkage: the symbol is file-local, not a cross-file module symbol.
  if (hasStorageClass(node, 'static')) {
    return [];
  }

  // C/C++ enumerators are constants declared in the surrounding scope; scoped-enum (`enum class`)
  // members are qualified by the enum name instead.
  if (node.type === 'enum_specifier') {
    return declarationsFromEnumSpecifier(node, exported);
  }

  const name = findDeclarationName(node);
  return name ? [{ exported, name, startLine: node.startPosition.row + 1 }] : [];
}

function declarationsFromEnumSpecifier(node: Parser.SyntaxNode, exported: boolean): DeclarationMetrics[] {
  const declarations: DeclarationMetrics[] = [];
  const tagName = node.childForFieldName('name')?.text;
  if (tagName) {
    declarations.push({ exported, name: tagName, startLine: node.startPosition.row + 1 });
  }
  const isScoped = node.children.some((child) => !child.isNamed && (child.text === 'class' || child.text === 'struct'));
  for (const enumerator of node.childForFieldName('body')?.namedChildren ?? []) {
    if (enumerator.type !== 'enumerator') {
      continue;
    }
    const name = enumerator.childForFieldName('name')?.text;
    if (name) {
      declarations.push({
        exported,
        name: isScoped && tagName ? `${tagName}::${name}` : name,
        startLine: enumerator.startPosition.row + 1,
      });
    }
  }
  return declarations;
}

function findDeclarationName(node: Parser.SyntaxNode): string | undefined {
  if (node.type === 'method_declaration' && node.childForFieldName('receiver')) {
    return findGoMethodDeclarationName(node);
  }

  let nameNode = node.childForFieldName('name');
  // C++ class/struct template specializations name the type via a `template_type` wrapper
  // (`template<> class Box<int>`); the unqualified inner name keeps specializations in the same
  // symbol group as the primary template.
  if (nameNode?.type === 'template_type') {
    nameNode = nameNode.childForFieldName('name');
  }
  // Ruby `class A::B` names the type via `scope_resolution`; keep the qualified `A::B` so same-named
  // types under different namespaces stay distinct in symbol groups.
  if (nameNode?.type === 'scope_resolution') {
    return nameNode.text;
  }
  if (nameNode) {
    return isDeclarationNameNode(nameNode) ? nameNode.text : undefined;
  }

  // C/C++ function definitions name the function inside the declarator chain; this must run before
  // the generic fallback, which would otherwise pick up the return type's `type_identifier`.
  const declaratorName = unwrapDeclaratorName(node.childForFieldName('declarator'), true);
  if (declaratorName) {
    return declaratorName;
  }

  return node.namedChildren.find(isDeclarationNameNode)?.text;
}

function isModuleExportNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'export_statement' || node.type === 'export_declaration';
}

function isDeclarationContainer(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'lexical_declaration' ||
    node.type === 'variable_declaration' ||
    node.type === 'decorated_definition' ||
    node.type === 'type_declaration' ||
    node.type === 'const_declaration' ||
    node.type === 'var_declaration' ||
    node.type === 'var_spec_list' ||
    // C/C++ wrappers around top-level symbols (namespaces are handled separately to thread their
    // scope); declarations in inactive preprocessor arms are still collected, which is the norm
    // for un-preprocessed analysis.
    node.type === 'linkage_specification' ||
    node.type === 'template_declaration' ||
    node.type === 'declaration_list' ||
    node.type === 'preproc_ifdef' ||
    node.type === 'preproc_if' ||
    node.type === 'preproc_else' ||
    node.type === 'preproc_elif'
  );
}

function isTopLevelDeclarationNode(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'function_declaration' ||
    node.type === 'function_definition' ||
    node.type === 'function_item' ||
    node.type === 'method_declaration' ||
    node.type === 'class_declaration' ||
    node.type === 'class_definition' ||
    node.type === 'interface_declaration' ||
    node.type === 'type_alias_declaration' ||
    node.type === 'type_declaration' ||
    node.type === 'type_spec' ||
    node.type === 'const_spec' ||
    node.type === 'var_spec' ||
    node.type === 'variable_declarator' ||
    node.type === 'struct_item' ||
    node.type === 'enum_item' ||
    node.type === 'union_item' ||
    node.type === 'trait_item' ||
    node.type === 'type_item' ||
    node.type === 'const_item' ||
    node.type === 'static_item' ||
    node.type === 'mod_item' ||
    // Java
    node.type === 'enum_declaration' ||
    node.type === 'record_declaration' ||
    node.type === 'annotation_type_declaration' ||
    // Ruby (keyword-like node types exist only in the Ruby grammar as named nodes; in other
    // grammars a top-level `class`/`method` never appears as a direct named child of the root)
    node.type === 'method' ||
    node.type === 'singleton_method' ||
    node.type === 'class' ||
    node.type === 'module' ||
    // C/C++ (body-less forward declarations are filtered in declarationFromNode)
    node.type === 'alias_declaration' ||
    node.type === 'struct_specifier' ||
    node.type === 'class_specifier' ||
    node.type === 'enum_specifier' ||
    node.type === 'union_specifier'
  );
}

function isDeclarationNameNode(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'identifier' ||
    node.type === 'type_identifier' ||
    node.type === 'property_identifier' ||
    node.type === 'field_identifier' ||
    // Ruby classes/modules are named by a `constant`.
    node.type === 'constant'
  );
}

function collectExportedNames(root: Parser.SyntaxNode): Set<string> {
  const exportedNames = new Set<string>();

  function visit(node: Parser.SyntaxNode, insideSourcedExport: boolean): void {
    if (!insideSourcedExport && isExportSpecifierNode(node)) {
      const name = findExportedName(node);
      if (name) {
        exportedNames.add(name);
      }
    }

    const isSourcedExport =
      insideSourcedExport || (isModuleExportNode(node) && node.childForFieldName('source') !== null);
    for (const child of node.namedChildren) {
      visit(child, isSourcedExport);
    }
  }

  visit(root, false);
  return exportedNames;
}

function isExportSpecifierNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'export_specifier' || node.type === 'namespace_export';
}

function findExportedName(node: Parser.SyntaxNode): string | undefined {
  const nameNode =
    node.childForFieldName('name') ?? node.childForFieldName('alias') ?? node.namedChildren.find(isDeclarationNameNode);
  return nameNode && isDeclarationNameNode(nameNode) ? nameNode.text : undefined;
}

function findGoMethodDeclarationName(node: Parser.SyntaxNode): string | undefined {
  const nameNode = node.childForFieldName('name');
  const receiverTypeNode = node.childForFieldName('receiver')?.namedChildren[0]?.childForFieldName('type');
  if (!nameNode || !isDeclarationNameNode(nameNode) || !receiverTypeNode) {
    return nameNode && isDeclarationNameNode(nameNode) ? nameNode.text : undefined;
  }

  return `${normalizeGoReceiverType(receiverTypeNode.text)}.${nameNode.text}`;
}

function normalizeGoReceiverType(receiverType: string): string {
  return receiverType.replaceAll(/\s+/gu, '').replace(/^\*+/u, '');
}

function measureCoupling(root: Parser.SyntaxNode, language: LanguageDefinition): CouplingMetrics {
  const importSources = new Set<string>();
  let importCount = 0;
  let exportCount = 0;

  function visit(node: Parser.SyntaxNode): void {
    // Go nests import_spec inside import_spec_list inside import_declaration; only the leaf spec
    // is one import, or the block would count 2-4x.
    const isGoImportWrapper =
      language.name === 'go' && (node.type === 'import_declaration' || node.type === 'import_spec_list');
    if (
      !isGoImportWrapper &&
      (isImportNode(node) ||
        isRustModDeclaration(node, language) ||
        isCppModuleImport(node, language) ||
        isDynamicImportNode(node) ||
        isRubyRequireCall(node, language))
    ) {
      importCount += 1;
    }

    if (isImportSourceNode(node, language)) {
      for (const source of findImportSources(node, language, { expandPythonSubmodules: false })) {
        importSources.add(source);
      }
    }

    if (isExportNode(node)) {
      exportCount += 1;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);

  const relativeImportCount = [...importSources].filter((source) =>
    isRelativeImportSource(source, language.name)
  ).length;

  return {
    importCount,
    importSourceCount: importSources.size,
    relativeImportCount,
    externalImportCount: importSources.size - relativeImportCount,
    exportCount,
  };
}

function measureSyntaxFeatures(root: Parser.SyntaxNode, languageName: string): SyntaxFeatureMetrics {
  const metrics: SyntaxFeatureMetrics = {
    assignmentCount: 0,
    awaitExpressionCount: 0,
    loopStatementCount: 0,
    mutableBindingCount: 0,
    returnStatementCount: 0,
    throwStatementCount: 0,
    tryStatementCount: 0,
  };

  function visit(node: Parser.SyntaxNode): void {
    if (isAssignmentNode(node)) {
      metrics.assignmentCount += 1;
    }
    if (isAwaitNode(node)) {
      metrics.awaitExpressionCount += 1;
    }
    if (isLoopNode(node)) {
      metrics.loopStatementCount += 1;
    }
    metrics.mutableBindingCount += countMutableBindings(node, languageName);
    if (isReturnNode(node)) {
      metrics.returnStatementCount += 1;
    }
    if (isThrowNode(node)) {
      metrics.throwStatementCount += 1;
    }
    if (isTryNode(node)) {
      metrics.tryStatementCount += 1;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return metrics;
}

function isAssignmentNode(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'assignment_expression' ||
    node.type === 'augmented_assignment_expression' ||
    node.type === 'assignment_statement' ||
    node.type === 'assignment' ||
    node.type === 'augmented_assignment' ||
    node.type === 'operator_assignment' ||
    node.type === 'short_var_declaration' ||
    node.type === 'compound_assignment_expr' ||
    // Python's walrus (`if (n := len(xs)):`) binds like an assignment.
    node.type === 'named_expression' ||
    // Increment/decrement mutate their operand: JS/TS/Java/C/C++ `i++`, Go `i++`/`i--` statements.
    node.type === 'update_expression' ||
    node.type === 'inc_statement' ||
    node.type === 'dec_statement'
  );
}

function isAwaitNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'await_expression' || node.type === 'await' || node.type === 'co_await_expression';
}

function isLoopNode(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'for_statement' ||
    node.type === 'for_in_statement' ||
    node.type === 'enhanced_for_statement' ||
    node.type === 'for_range_loop' ||
    node.type === 'while_statement' ||
    node.type === 'do_statement' ||
    node.type === 'for_expression' ||
    node.type === 'while_expression' ||
    node.type === 'loop_expression' ||
    // Ruby loop nodes are keyword-named; only named nodes reach this check.
    node.type === 'while' ||
    node.type === 'until' ||
    node.type === 'for' ||
    node.type === 'while_modifier' ||
    node.type === 'until_modifier'
  );
}

/**
 * Java and C/C++ declare several bindings per statement, so each mutable declarator counts. The
 * C/C++ branches are language-gated because `field_declaration` is a shared node type: Go and
 * Rust struct fields would otherwise count as mutable bindings.
 */
function countMutableBindings(node: Parser.SyntaxNode, languageName: string): number {
  const isC = languageName === 'c' || languageName === 'cpp';
  if (node.type === 'local_variable_declaration' || (node.type === 'field_declaration' && languageName === 'java')) {
    const javaDeclarators = node.namedChildren.filter((child) => child.type === 'variable_declarator');
    return isJavaMutableDeclaration(node) ? javaDeclarators.length : 0;
  }

  if (isC && (node.type === 'declaration' || node.type === 'field_declaration')) {
    return countCMutableBindings(node, languageName === 'cpp');
  }

  // tree-sitter-cpp parses the in-class `int count = 0;` member as a pure-virtual-like
  // `function_definition` whose declarator is a bare field name; real functions have a
  // `function_declarator` and stay excluded.
  if (isC && node.type === 'function_definition') {
    const declarator = node.childForFieldName('declarator');
    if (declarator?.type === 'field_identifier' || declarator?.type === 'identifier') {
      return countCMutableBindings(node, languageName === 'cpp');
    }
    return 0;
  }

  // Java `for (String x : xs)` binds its loop variable directly on the statement node.
  if (node.type === 'enhanced_for_statement') {
    return isJavaMutableDeclaration(node) ? 1 : 0;
  }

  // Java pattern variables (`o instanceof String s`, `case String s ->`, record-pattern
  // components) are reassignable local variables unless final (JLS 4.12.4). `final` appears as an
  // anonymous keyword leaf on the pattern, not inside a `modifiers` node.
  if (
    languageName === 'java' &&
    (node.type === 'instanceof_expression' || node.type === 'type_pattern' || node.type === 'record_pattern_component')
  ) {
    const bindsName =
      node.type === 'instanceof_expression'
        ? node.childForFieldName('name') !== null
        : node.namedChildren.some((child) => child.type === 'identifier');
    const isFinal = node.children.some((child) => !child.isNamed && child.text === 'final');
    return bindsName && !isFinal ? 1 : 0;
  }

  // C++ `for (int x : xs)` binds directly in the loop's declarator field.
  if (isC && node.type === 'for_range_loop') {
    const declarator = node.childForFieldName('declarator');
    return declarator && isCMutableBinding(node, declarator) ? countCBoundIdentifiers(declarator) : 0;
  }

  return isMutableBindingNode(node) ? 1 : 0;
}

function countCMutableBindings(node: Parser.SyntaxNode, isCpp: boolean): number {
  // The module-syntax misparse only exists in the C++ grammar; in C, `module` is an identifier.
  if (isCpp && isMisparsedCppModuleDeclaration(node)) {
    return 0;
  }
  return sum(
    node.namedChildren
      .filter((child) => isCVariableDeclarator(child) && isCMutableBinding(node, child))
      .map(countCBoundIdentifiers)
  );
}

/** A C++ structured binding (`auto [a, b] = ...`) introduces one binding per bound identifier. */
function countCBoundIdentifiers(declarator: Parser.SyntaxNode): number {
  const inner =
    declarator.type === 'init_declarator' ? (declarator.childForFieldName('declarator') ?? declarator) : declarator;
  if (inner.type === 'structured_binding_declarator') {
    return Math.max(1, inner.namedChildren.filter((child) => child.type === 'identifier').length);
  }
  return 1;
}

function isMutableBindingNode(node: Parser.SyntaxNode): boolean {
  return (
    (node.type === 'lexical_declaration' && node.firstChild?.text === 'let') ||
    (node.type === 'variable_declaration' && node.firstChild?.text === 'var') ||
    node.type === 'var_declaration' ||
    (node.type === 'let_declaration' && hasRustMutableLetBinding(node))
  );
}

/** Java variable/field declarations bind mutably unless marked `final`. */
function isJavaMutableDeclaration(node: Parser.SyntaxNode): boolean {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  return !modifiers?.children.some((child) => child.text === 'final');
}

/**
 * A base-type `const` (`const int x`) freezes a plain binding but not a pointer binding
 * (`const int *p` leaves `p` reassignable), while a pointer-level `const` on the level that
 * directly declares the name (`int * const p`, `int ** const s`) freezes it; `volatile` and
 * `restrict` never do.
 */
function isCMutableBinding(declaration: Parser.SyntaxNode, declarator: Parser.SyntaxNode): boolean {
  let current =
    declarator.type === 'init_declarator' ? (declarator.childForFieldName('declarator') ?? declarator) : declarator;
  let insidePointer = false;
  while (
    current.type === 'reference_declarator' ||
    current.type === 'pointer_declarator' ||
    current.type === 'array_declarator' ||
    current.type === 'parenthesized_declarator' ||
    current.type === 'function_declarator'
  ) {
    // A C++ reference binding can never be reseated, so it is immutable regardless of qualifiers;
    // references can nest under pointers (`int *&rp`), so the whole chain is checked.
    if (current.type === 'reference_declarator') {
      return false;
    }
    const inner = nextDeclarator(current);
    if (!inner) {
      break;
    }
    if (current.type === 'pointer_declarator') {
      insidePointer = true;
      // `const` on the pointer level that owns the name freezes the binding even when array or
      // function wrappers sit between the pointer and the name (`int * const a[3]`).
      if (hasConstQualifier(current) && !declaratorChainContainsPointer(inner)) {
        return false;
      }
    }
    current = inner;
  }

  return insidePointer || !hasConstQualifier(declaration);
}

function declaratorChainContainsPointer(declarator: Parser.SyntaxNode): boolean {
  let current: Parser.SyntaxNode | null | undefined = declarator;
  while (current) {
    if (current.type === 'pointer_declarator') {
      return true;
    }
    current = nextDeclarator(current);
  }
  return false;
}

function hasConstQualifier(node: Parser.SyntaxNode): boolean {
  return node.namedChildren.some(
    (child) => child.type === 'type_qualifier' && (child.text === 'const' || child.text === 'constexpr')
  );
}

/**
 * A Rust `let` binds mutably via a direct `mut` (`let mut x = ...`) or a `mut` inside its
 * destructuring pattern — a `mut_pattern` (`let (mut a, b) = ...`) or a shorthand `field_pattern`
 * (`let Point { mut x } = ...`). Only the pattern is inspected so a borrow in the value such as
 * `let x = &mut y;` is not miscounted, and a `mut` under a `reference_pattern` (`let &mut x = y;`,
 * which binds `x` immutably) is excluded.
 */
function hasRustMutableLetBinding(node: Parser.SyntaxNode): boolean {
  if (node.children.some((child) => child.type === 'mutable_specifier')) {
    return true;
  }

  const pattern = node.childForFieldName('pattern');
  if (!pattern) {
    return false;
  }

  return pattern
    .descendantsOfType('mutable_specifier')
    .some((specifier) => specifier.parent?.type !== 'reference_pattern');
}

function isReturnNode(node: Parser.SyntaxNode): boolean {
  // Ruby's named `return` node is safe here: the visitor walks named children only, so the
  // anonymous `return` keyword leaf is never seen. `co_return` is the only way a C++ coroutine
  // returns; `co_yield` suspends like a generator yield and is not a return.
  return (
    node.type === 'return_statement' ||
    node.type === 'return_expression' ||
    node.type === 'return' ||
    node.type === 'co_return_statement'
  );
}

function isThrowNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'throw_statement' || node.type === 'raise_statement' || isRubyRaiseCall(node);
}

/** Ruby raises via receiverless `raise`/`fail` calls; a receiver call like `object.raise` is not one. */
function isRubyRaiseCall(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'call' || node.childForFieldName('receiver')) {
    return false;
  }

  const methodNode = node.childForFieldName('method');
  return methodNode?.type === 'identifier' && (methodNode.text === 'raise' || methodNode.text === 'fail');
}

function isTryNode(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'try_statement' ||
    node.type === 'try_with_resources_statement' ||
    // Ruby's `risky_call rescue fallback` modifier protects an expression like a one-clause begin.
    node.type === 'rescue_modifier' ||
    isRubyRescueConstruct(node)
  );
}

/**
 * Ruby protects code with `rescue` clauses directly under an explicit `begin` or an implicit
 * method/block `body_statement`; counting the construct (not each clause) matches try-statement
 * counting in other languages.
 */
function isRubyRescueConstruct(node: Parser.SyntaxNode): boolean {
  // `ensure`-only constructs (`begin ... ensure ... end`) handle exceptions like try/finally.
  return (
    (node.type === 'begin' || node.type === 'body_statement') &&
    node.namedChildren.some((child) => child.type === 'rescue' || child.type === 'ensure')
  );
}

/** Caps the pairwise overlap computation so files with thousands of functions stay fast. */
const maxCohesionPairCount = 250_000;

function measureCohesion(analyses: FunctionAnalysis[]): CohesionMetrics {
  // An identifier is shared iff it appears in at least two functions, so a frequency map computes
  // both identifier counts exactly without enumerating function pairs.
  const functionCountByIdentifier = new Map<string, number>();
  for (const analysis of analyses) {
    for (const identifier of analysis.identifiers) {
      functionCountByIdentifier.set(identifier, (functionCountByIdentifier.get(identifier) ?? 0) + 1);
    }
  }
  let sharedIdentifierCount = 0;
  for (const count of functionCountByIdentifier.values()) {
    if (count >= 2) {
      sharedIdentifierCount += 1;
    }
  }

  // The average pairwise Jaccard overlap is quadratic in the function count, so beyond the cap it
  // is estimated from an evenly strided, deterministic sample of pairs. Sampled linear pair
  // indexes are converted to (left, right) by walking triangular rows, so the traversal cost is
  // O(sample + functions) rather than all n(n-1)/2 pairs.
  const functionCount = analyses.length;
  const totalPairCount = (functionCount * (functionCount - 1)) / 2;
  const stride = Math.max(1, Math.ceil(totalPairCount / maxCohesionPairCount));
  let overlapTotal = 0;
  let sampledPairCount = 0;
  let leftIndex = 0;
  let rowStartPairIndex = 0;
  let rowLength = functionCount - 1;
  for (let pairIndex = 0; pairIndex < totalPairCount; pairIndex += stride) {
    while (pairIndex >= rowStartPairIndex + rowLength) {
      rowStartPairIndex += rowLength;
      leftIndex += 1;
      rowLength = functionCount - 1 - leftIndex;
    }
    const rightIndex = leftIndex + 1 + (pairIndex - rowStartPairIndex);

    const left = analyses[leftIndex];
    const right = analyses[rightIndex];
    if (!left || !right) {
      continue;
    }

    const intersectionSize = countIntersection(left.identifiers, right.identifiers);
    const unionSize = left.identifiers.size + right.identifiers.size - intersectionSize;
    overlapTotal += unionSize === 0 ? 0 : intersectionSize / unionSize;
    sampledPairCount += 1;
  }

  return {
    averageFunctionIdentifierOverlap: sampledPairCount === 0 ? 1 : overlapTotal / sampledPairCount,
    sharedIdentifierCount,
    uniqueIdentifierCount: functionCountByIdentifier.size,
  };
}

function measureTypeComplexity(root: Parser.SyntaxNode): TypeComplexityMetrics {
  const metrics: TypeComplexityMetrics = {
    typeAnnotationCount: 0,
    typeAliasCount: 0,
    interfaceCount: 0,
    genericParameterCount: 0,
    unionTypeCount: 0,
    intersectionTypeCount: 0,
    conditionalTypeCount: 0,
    typeAssertionCount: 0,
    nonNullAssertionCount: 0,
    satisfiesExpressionCount: 0,
  };

  function visit(node: Parser.SyntaxNode): void {
    switch (node.type) {
      case 'type_annotation': {
        metrics.typeAnnotationCount += 1;
        break;
      }
      case 'type_alias_declaration': {
        metrics.typeAliasCount += 1;
        break;
      }
      case 'interface_declaration': {
        metrics.interfaceCount += 1;
        break;
      }
      case 'type_parameters':
      case 'type_parameter': {
        metrics.genericParameterCount += node.type === 'type_parameter' ? 1 : 0;
        break;
      }
      case 'union_type': {
        metrics.unionTypeCount += 1;
        break;
      }
      case 'intersection_type': {
        metrics.intersectionTypeCount += 1;
        break;
      }
      case 'conditional_type': {
        metrics.conditionalTypeCount += 1;
        break;
      }
      case 'as_expression':
      case 'type_assertion': {
        metrics.typeAssertionCount += 1;
        break;
      }
      case 'non_null_expression': {
        metrics.nonNullAssertionCount += 1;
        break;
      }
      case 'satisfies_expression': {
        metrics.satisfiesExpressionCount += 1;
        break;
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return metrics;
}

/**
 * 1-based numbers of lines that are neither blank nor comment-only, matching measureLines'
 * classification so duplication line coverage and its code-line denominator agree.
 */
function classifyLines(
  code: string,
  root: Parser.SyntaxNode
): { lines: CodeMetrics['lines']; codeLineNumbers: Set<number> } {
  const sourceLines = code.length === 0 ? [] : code.split(/\r\n|\n|\r/);
  // Spans are bucketed by line so classification stays linear; scanning every span per line made
  // this pass quadratic on comment-heavy files.
  const commentSpansByLine = new Map<number, CommentSpan[]>();
  for (const span of collectCommentSpans(root)) {
    const spans = commentSpansByLine.get(span.line) ?? [];
    spans.push(span);
    commentSpansByLine.set(span.line, spans);
  }
  let blank = 0;
  let comment = 0;
  const codeLineNumbers = new Set<number>();

  for (const [index, line] of sourceLines.entries()) {
    if (line.trim() === '') {
      blank += 1;
      continue;
    }
    if (isCommentOnlyLine(line, commentSpansByLine.get(index) ?? [])) {
      comment += 1;
    } else {
      codeLineNumbers.add(index + 1);
    }
  }

  return {
    lines: {
      total: sourceLines.length,
      code: codeLineNumbers.size,
      comment,
      blank,
    },
    codeLineNumbers,
  };
}

function collectCommentSpans(root: Parser.SyntaxNode): CommentSpan[] {
  const spans: CommentSpan[] = [];

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'comment' || node.type === 'line_comment' || node.type === 'block_comment') {
      for (let row = node.startPosition.row; row <= node.endPosition.row; row += 1) {
        spans.push({
          line: row,
          startColumn: row === node.startPosition.row ? node.startPosition.column : 0,
          endColumn: row === node.endPosition.row ? node.endPosition.column : Number.POSITIVE_INFINITY,
        });
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return spans;
}

function isCommentOnlyLine(line: string, relevantSpans: CommentSpan[]): boolean {
  if (relevantSpans.length === 0) {
    return false;
  }

  // A line may hold several comments (`/* one */ /* two */`), so every non-whitespace column must
  // be covered by the UNION of spans, not by a single span.
  for (let column = 0; column < line.length; column += 1) {
    if (/\s/u.test(line[column] ?? ' ')) {
      continue;
    }
    if (!relevantSpans.some((span) => span.startColumn <= column && column < span.endColumn)) {
      return false;
    }
  }
  return true;
}

function measureHalstead(root: Parser.SyntaxNode, code: string): HalsteadMetrics {
  const operators = new Map<string, number>();
  const operands = new Map<string, number>();

  function visit(node: Parser.SyntaxNode): void {
    if (node.type === 'comment' || node.type === 'line_comment' || node.type === 'block_comment') {
      return;
    }

    if (atomicOperandNodeTypes.has(node.type)) {
      incrementCount(operands, code.slice(node.startIndex, node.endIndex));
      return;
    }

    // Operators are counted from leaf tokens only: keyword-named nodes (Ruby `return`, Python
    // `await`, ...) always contain a same-text anonymous keyword leaf, so counting the named node
    // as well would double-count.
    if (node.childCount === 0) {
      const text = code.slice(node.startIndex, node.endIndex);
      // Operands win over text matches so identifiers spelled like word operators (`cache.delete(...)`,
      // a Go parameter named `in`) stay operands; genuine keyword operators are anonymous leaves whose
      // types are never operand types. A blanket `isNamed` guard would break JS's named `optional_chain`.
      if (operandNodeTypes.has(node.type)) {
        incrementCount(operands, text);
      } else if ((operatorTexts.has(text) || operatorTexts.has(node.type)) && isCountableContextualToken(node, text)) {
        incrementCount(operators, text || node.type);
      }
      return;
    }

    for (const child of node.children) {
      visit(child);
    }
  }

  visit(root);

  return deriveHalsteadMetrics({
    distinctOperators: operators.size,
    distinctOperands: operands.size,
    totalOperators: sum(operators.values()),
    totalOperands: sum(operands.values()),
  });
}

/** Derives the full Halstead metrics from the four base counts (shared with the native backend). */
function deriveHalsteadMetrics(counts: NativeHalsteadCounts): HalsteadMetrics {
  const { distinctOperators, distinctOperands, totalOperators, totalOperands } = counts;
  const vocabulary = distinctOperators + distinctOperands;
  const length = totalOperators + totalOperands;
  const volume = vocabulary === 0 ? 0 : length * Math.log2(vocabulary);
  const difficulty = distinctOperands === 0 ? 0 : (distinctOperators / 2) * (totalOperands / distinctOperands);
  const effort = difficulty * volume;

  return {
    distinctOperators,
    distinctOperands,
    totalOperators,
    totalOperands,
    vocabulary,
    length,
    volume,
    difficulty,
    effort,
    time: effort / 18,
    bugs: volume / 3000,
  };
}

function findFunctionName(node: Parser.SyntaxNode): string | undefined {
  const wrappedName = findWrappedComponentName(node);
  if (wrappedName) {
    return wrappedName;
  }

  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    return nameNode.text;
  }

  // C/C++ definitions name the function inside the (possibly pointer-wrapped) declarator chain.
  const declaratorName = findDeclaratorName(node);
  if (declaratorName) {
    return declaratorName;
  }

  const parent = node.parent;
  if (!parent) {
    return undefined;
  }

  // A Rust closure bound to a simple `let` identifier (`let add = |x| ...;`) takes that identifier
  // as its name, mirroring how JS arrow functions assigned to a variable are named, so calls to the
  // binding resolve as intra-file edges.
  if (node.type === 'closure_expression' && parent.type === 'let_declaration') {
    const patternNode = parent.childForFieldName('pattern');
    return patternNode?.type === 'identifier' ? patternNode.text : undefined;
  }

  // A C++ lambda assigned to a variable (`auto f = [](int x) { ... };`) takes the variable name,
  // like Rust `let` closures above, so calls to the binding resolve as intra-file edges.
  if (node.type === 'lambda_expression' && parent.type === 'init_declarator') {
    return unwrapDeclaratorName(parent.childForFieldName('declarator'));
  }

  // A Go func literal bound via `add := func...` or `var add = func...` takes the identifier at
  // the same list position; unpaired or non-identifier targets stay unnamed.
  if (node.type === 'func_literal' && parent.type === 'expression_list') {
    return findGoFuncLiteralName(node, parent);
  }

  // Ruby lambdas assigned to a name (`choose = ->(x) {...}` / `ADD = lambda { ... }`) take that
  // name; Ruby assignments use the `left` field, and `lambda { }` blocks hang off a `call`.
  if (node.type === 'lambda' && parent.type === 'assignment') {
    return findRubyAssignmentName(parent);
  }
  if ((node.type === 'block' || node.type === 'do_block') && isRubyLambdaCall(parent)) {
    return parent.parent?.type === 'assignment' ? findRubyAssignmentName(parent.parent) : undefined;
  }

  const parentName = parent.childForFieldName('name');
  return parentName?.text;
}

function findDeclaratorName(node: Parser.SyntaxNode): string | undefined {
  return unwrapDeclaratorName(node.childForFieldName('declarator'));
}

/**
 * Unwraps a C/C++ declarator chain to the declared name, handling parenthesized declarators
 * (function pointers), qualified names, destructors, and operator overloads explicitly; a
 * rightmost-identifier fallback would pick up parameter names from nested `function_declarator`s.
 * With `qualified`, out-of-line scopes are kept with `::` (`Foo::process` stays `Foo::process`,
 * matching namespace qualification so both spellings of a symbol group together; unlike Go's
 * `Receiver.Method` declarations) so same-named methods of different types do not collide in
 * cross-file duplicate-symbol groups; call-graph names stay unqualified so callee matching works.
 */
function unwrapDeclaratorName(declarator: Parser.SyntaxNode | null, qualified = false): string | undefined {
  let current: Parser.SyntaxNode | null | undefined = declarator;
  let scopePrefix = '';
  while (current) {
    switch (current.type) {
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
      case 'destructor_name':
      case 'operator_name': {
        return scopePrefix ? `${scopePrefix}::${current.text}` : current.text;
      }
      // A C++ conversion operator (`operator int()`) is its own declarator node whose text spans
      // the parameter list and qualifiers; only `operator <type>` is the name.
      case 'operator_cast': {
        const name = `operator ${current.childForFieldName('type')?.text ?? ''}`.trimEnd();
        return scopePrefix ? `${scopePrefix}::${name}` : name;
      }
      // Template specializations (`id<int>`) and qualified names both carry a `name` field.
      case 'template_function': {
        current = current.childForFieldName('name');
        break;
      }
      case 'qualified_identifier': {
        if (qualified) {
          const scope = current.childForFieldName('scope')?.text.replaceAll(/\s+/gu, '');
          if (scope) {
            scopePrefix = scopePrefix ? `${scopePrefix}::${scope}` : scope;
          }
        }
        current = current.childForFieldName('name');
        break;
      }
      default: {
        current = nextDeclarator(current);
      }
    }
  }
  return undefined;
}

/**
 * Steps into the inner declarator; `reference_declarator` and `parenthesized_declarator` do not
 * expose a `declarator` field in tree-sitter-cpp, so their sole named child is the inner node.
 */
function nextDeclarator(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  const direct = node.childForFieldName('declarator');
  if (direct) {
    return direct;
  }
  if (node.type === 'reference_declarator' || node.type === 'parenthesized_declarator') {
    return node.namedChild(0) ?? undefined;
  }
  return undefined;
}

function findRubyAssignmentName(assignment: Parser.SyntaxNode): string | undefined {
  const leftNode = assignment.childForFieldName('left');
  return leftNode?.type === 'identifier' || leftNode?.type === 'constant' ? leftNode.text : undefined;
}

function isRubyLambdaCall(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'call' || node.childForFieldName('receiver')) {
    return false;
  }
  const methodNode = node.childForFieldName('method');
  return methodNode?.type === 'identifier' && (methodNode.text === 'lambda' || methodNode.text === 'proc');
}

function findGoFuncLiteralName(node: Parser.SyntaxNode, expressionList: Parser.SyntaxNode): string | undefined {
  const holder = expressionList.parent;
  // Comments interleave with expressions in the list but have no matching binding target, so
  // positions are aligned over non-comment children on both sides.
  const values = expressionList.namedChildren.filter((child) => child.type !== 'comment');
  const valueIndex = values.findIndex((child) => child.id === node.id);
  if (!holder || valueIndex === -1) {
    return undefined;
  }

  if (holder.type === 'short_var_declaration') {
    const targets = holder.childForFieldName('left')?.namedChildren.filter((child) => child.type !== 'comment');
    return asGoBindingName(targets?.[valueIndex]);
  }

  if (holder.type === 'var_spec') {
    const target = findChildrenByFieldName(holder, 'name')[valueIndex];
    return asGoBindingName(target);
  }

  return undefined;
}

/** Go's blank identifier `_` discards the value and creates no callable binding. */
function asGoBindingName(target: Parser.SyntaxNode | undefined): string | undefined {
  return target?.type === 'identifier' && target.text !== '_' ? target.text : undefined;
}

function findWrappedComponentName(node: Parser.SyntaxNode): string | undefined {
  let current: Parser.SyntaxNode | undefined = node;
  while (current) {
    const argumentsNode: Parser.SyntaxNode | null = current.parent;
    const callNode: Parser.SyntaxNode | null | undefined = argumentsNode?.parent;
    if (argumentsNode?.type !== 'arguments' || callNode?.type !== 'call_expression') {
      return undefined;
    }

    if (!isReactComponentWrapperCall(callNode)) {
      return undefined;
    }

    const declaratorNode = callNode.parent;
    if (declaratorNode?.type === 'variable_declarator') {
      return declaratorNode.childForFieldName('name')?.text;
    }

    current = callNode;
  }

  return undefined;
}

function isReactComponentWrapperCall(node: Parser.SyntaxNode): boolean {
  const calleeNode = node.childForFieldName('function') ?? node.namedChild(0);
  return (
    calleeNode?.text === 'memo' ||
    calleeNode?.text === 'React.memo' ||
    calleeNode?.text === 'forwardRef' ||
    calleeNode?.text === 'React.forwardRef'
  );
}

function isCallNode(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'call_expression' ||
    node.type === 'call' ||
    node.type === 'method_invocation' ||
    node.type === 'macro_invocation' ||
    // Constructor invocations are calls: JS/C++ `new_expression`, Java `object_creation_expression`
    // and `this(...)`/`super(...)`.
    node.type === 'new_expression' ||
    node.type === 'object_creation_expression' ||
    node.type === 'explicit_constructor_invocation'
  );
}

/** Reconstructs `operator+` / `operator int` from tree-sitter-cpp's ERROR-wrapped misparses. */
function findCppExplicitOperatorName(node: Parser.SyntaxNode): string | undefined {
  // `this->operator+(y)`: the operator_name lands inside an ERROR child of the call itself.
  for (const child of node.children) {
    if (child.type === 'ERROR') {
      const operatorName = child.children.find((grandChild) => grandChild.type === 'operator_name');
      if (operatorName) {
        return operatorName.text;
      }
    }
  }
  // `x.operator int()`: the field_expression holds an ERROR `operator` before the field name.
  const callee = node.childForFieldName('function');
  if (callee?.type === 'field_expression') {
    const errorIndex = callee.children.findIndex((child) => child.type === 'ERROR' && child.text === 'operator');
    const fieldNode = errorIndex === -1 ? undefined : callee.children[errorIndex + 1];
    if (fieldNode?.type === 'field_identifier' || fieldNode?.type === 'primitive_type') {
      return `operator ${fieldNode.text}`;
    }
  }
  return undefined;
}

/** Function-literal node types across supported grammars whose invocation names no callee. */
const anonymousCallableNodeTypes = new Set([
  'arrow_function', // JS/TS
  'function_expression', // JS/TS
  'function', // older JS grammars / Python-style
  'lambda', // Python, Ruby
  'lambda_expression', // C++, Java
  'closure_expression', // Rust
  'func_literal', // Go
  'anonymous_function', // misc grammars
]);

function findCalleeName(node: Parser.SyntaxNode): string | undefined {
  // Java `method_invocation` names its callee `name` and Ruby `call` names it `method`. The
  // `namedChild(0)` fallback covers Rust `macro_invocation` (whose callee is the `macro` field,
  // not `function`), so macros resolve to their name. `findRightmostIdentifier` must be kept rather
  // than reading `calleeNode.text`: member calls like `self.map.get(key)` must resolve to `get`, not
  // the full `self.map.get`, so intra-file call-graph name matching stays correct.
  // Ruby lambdas/procs are invoked via `helper.call(...)`; the receiver is the real callee.
  // `helper[...]` (element_reference) is intentionally NOT treated as a call: it is
  // indistinguishable from ordinary array/hash indexing and would distort call counts.
  if (node.type === 'call') {
    const methodNode = node.childForFieldName('method');
    const receiverNode = node.childForFieldName('receiver');
    if (methodNode?.text === 'call' && receiverNode?.type === 'identifier') {
      return receiverNode.text;
    }
    // A Ruby setter send (`self.foo = x`) invokes the method named `foo=`, matching its definition.
    if (methodNode && node.parent?.type === 'assignment' && node.parent.childForFieldName('left')?.id === node.id) {
      return `${methodNode.text}=`;
    }
    // Explicit operator sends (`self.+(other)`) name the operator method directly.
    if (methodNode?.type === 'operator') {
      return methodNode.text;
    }
  }

  // tree-sitter-cpp misparses explicit operator calls with ERROR wrappers (`this->operator+(y)`,
  // `x.operator int()`); reconstruct the definition-style name instead of dropping the callee or
  // fabricating one from the operand type.
  if (node.type === 'call_expression') {
    const operatorName = findCppExplicitOperatorName(node);
    if (operatorName) {
      return operatorName;
    }
  }

  const calleeNode =
    node.childForFieldName('function') ??
    node.childForFieldName('name') ??
    node.childForFieldName('method') ??
    // Constructor calls name the constructed type (`constructor` in JS, `type` in Java/C++).
    node.childForFieldName('constructor') ??
    node.childForFieldName('type') ??
    node.namedChild(0);
  if (!calleeNode) {
    return undefined;
  }

  // Immediately invoked anonymous callables (`(() => target)()`, `([](){ ... })()`) have no stable
  // callee name; searching their body would fabricate an edge to whatever identifier appears last.
  const unwrappedCallee = unwrapParenthesizedExpression(calleeNode);
  if (anonymousCallableNodeTypes.has(unwrappedCallee.type)) {
    return undefined;
  }

  return findRightmostIdentifier(unwrappedCallee);
}

function unwrapParenthesizedExpression(node: Parser.SyntaxNode): Parser.SyntaxNode {
  let current = node;
  while (current.type === 'parenthesized_expression' && current.namedChildCount === 1) {
    const inner = current.namedChild(0);
    if (!inner) {
      break;
    }
    current = inner;
  }
  return current;
}

/** Ternary/conditional and Rust try parents make `?` an operator; TS optional markers do not. */
const questionOperatorParentTypes = new Set([
  'ternary_expression',
  'conditional_expression',
  'conditional',
  'try_expression',
  // TypeScript conditional types (`T extends U ? X : Y`) select like a ternary.
  'conditional_type',
]);

function isCountableContextualToken(node: Parser.SyntaxNode, text: string): boolean {
  if (text === '@') {
    // Python matrix multiplication only; decorator/annotation `@` marks are not operators.
    const parentType = node.parent?.type;
    return parentType === 'binary_operator' || parentType === 'augmented_assignment';
  }
  if (text !== '?') {
    return true;
  }
  const parentType = node.parent?.type;
  return parentType !== undefined && questionOperatorParentTypes.has(parentType);
}

function findRightmostIdentifier(node: Parser.SyntaxNode): string | undefined {
  // Generic-call wrappers (Rust `helper::<T>()`, C++ `helper<T>()`/`obj.get<T>()`) put type
  // arguments after the callee, so the right-to-left search below would return the type argument;
  // the callee lives in the `function`/`name` field.
  if (node.type === 'generic_function' || node.type === 'template_function' || node.type === 'template_method') {
    const calleeNode = node.childForFieldName('function') ?? node.childForFieldName('name');
    if (calleeNode) {
      return findRightmostIdentifier(calleeNode);
    }
  }

  // Explicit destructor calls (`x.~Foo()`) must keep the atomic `~Foo` to match their definition.
  if (node.type === 'destructor_name') {
    return node.text;
  }

  // Java `new Box<String>()` names the base type first; the right-to-left search below would
  // otherwise return the type argument `String`.
  if (node.type === 'generic_type') {
    const baseNode = node.namedChildren.find(
      (child) => child.type === 'type_identifier' || child.type === 'scoped_type_identifier'
    );
    if (baseNode) {
      return findRightmostIdentifier(baseNode);
    }
  }

  if (
    node.type === 'identifier' ||
    node.type === 'property_identifier' ||
    node.type === 'field_identifier' ||
    node.type === 'type_identifier' ||
    node.type === 'attribute'
  ) {
    return node.text;
  }

  for (let index = node.namedChildCount - 1; index >= 0; index -= 1) {
    const child = node.namedChild(index);
    if (!child) {
      continue;
    }

    const identifier = findRightmostIdentifier(child);
    if (identifier) {
      return identifier;
    }
  }

  return undefined;
}

function isReactCreateElementCall(node: Parser.SyntaxNode): boolean {
  if (!isCallNode(node)) {
    return false;
  }

  const calleeNode = node.childForFieldName('function') ?? node.namedChild(0);
  return calleeNode?.text === 'React.createElement' || calleeNode?.text === 'createElement';
}

function isImportNode(node: Parser.SyntaxNode): boolean {
  return (
    node.type === 'import_statement' ||
    node.type === 'import_declaration' ||
    node.type === 'import_from_statement' ||
    node.type === 'import_spec' ||
    node.type === 'import_spec_list' ||
    node.type === 'use_declaration' ||
    node.type === 'extern_crate_declaration' ||
    // JPMS `requires` directives in module-info.java declare module dependences (JLS 7.7.1).
    node.type === 'requires_module_directive' ||
    node.type === 'preproc_include'
  );
}

function isImportSourceNode(node: Parser.SyntaxNode, language: LanguageDefinition): boolean {
  return (
    isImportNode(node) ||
    isRustModDeclaration(node, language) ||
    isCppModuleImport(node, language) ||
    isDynamicImportNode(node) ||
    isRubyRequireCall(node, language) ||
    (isExportNode(node) && node.childForFieldName('source') !== null)
  );
}

/**
 * C++20 imports misparse without grammar module support: `import name;` as a declaration typed
 * `import`, `export import name;` as one typed `export`, and partition/header-unit forms
 * (`import :part;`, `import "h.h";`, `import <vector>;`) as labeled or expression statements.
 */
function isCppModuleImport(node: Parser.SyntaxNode, language: LanguageDefinition): boolean {
  if (language.name !== 'cpp') {
    return false;
  }
  if (node.type === 'declaration') {
    const typeNode = node.childForFieldName('type');
    if (typeNode?.type !== 'type_identifier') {
      return false;
    }
    if (typeNode.text === 'import') {
      return !hasVisibleTypeAlias(node, 'import');
    }
    return typeNode.text === 'export' && /^export\s+import\b/u.test(node.text);
  }
  if (node.type === 'labeled_statement' || node.type === 'expression_statement') {
    return node.parent?.type === 'translation_unit' && /^import\s+[:"<]/u.test(node.text);
  }
  return false;
}

/** A bodyless `mod name;` declares an out-of-line child module loaded from `name.rs`/`name/mod.rs`. */
function isRustModDeclaration(node: Parser.SyntaxNode, language: LanguageDefinition): boolean {
  return language.name === 'rust' && node.type === 'mod_item' && !node.childForFieldName('body');
}

function isDynamicImportNode(node: Parser.SyntaxNode): boolean {
  if (!isCallNode(node)) {
    return false;
  }

  const calleeNode = node.childForFieldName('function') ?? node.namedChild(0);
  return calleeNode?.text === 'import';
}

function findImportSources(
  node: Parser.SyntaxNode,
  language: LanguageDefinition,
  options: { expandPythonSubmodules: boolean }
): string[] {
  if (language.name === 'python') {
    const pythonSources = findPythonImportSources(node, options);
    if (pythonSources.length > 0) {
      return pythonSources;
    }
  }

  if (language.name === 'rust') {
    return findRustImportSources(node);
  }

  // JPMS `requires [transitive|static] module.name;` names the depended-on module.
  if (language.name === 'java' && node.type === 'requires_module_directive') {
    const moduleNode = node.childForFieldName('module');
    return moduleNode ? [normalizeImportSource(moduleNode.text)] : [];
  }

  if (language.name === 'java' && node.type === 'import_declaration') {
    const importedPath = node.namedChild(0);
    if (!importedPath) {
      return [];
    }
    // The `.*` suffix is preserved so wildcard (package) imports stay unresolvable to a single
    // file. A static wildcard (`import static X.Helper.*`) names one specific type (JLS 7.5.4),
    // so it resolves like a plain import of that type.
    const isStatic = node.children.some((child) => child.type === 'static');
    const isWildcard = node.namedChildren.some((child) => child.type === 'asterisk');
    const source = normalizeImportSource(importedPath.text);
    return [isWildcard && !isStatic ? `${source}.*` : source];
  }

  // The misparsed C++20 module import keeps its source in the node text: a module/partition name,
  // or a header unit, which resolves like a quoted include (file-relative).
  if (isCppModuleImport(node, language)) {
    const match = /^(?:export\s+)?import\s+([\w.:]+|"[^"]+"|<[^>]+>)/u.exec(node.text);
    const source = match?.[1];
    if (!source) {
      return [];
    }
    return source.startsWith('"') ? [`./${unquote(source)}`] : [source];
  }

  if (isRubyRequireCall(node, language)) {
    return findRubyRequireSources(node);
  }

  // C/C++ `#include` paths live in the `path` field as a string literal or `<...>` token. Quoted
  // includes resolve relative to the including file, unlike `<...>` system includes.
  if (node.type === 'preproc_include') {
    const pathNode = node.childForFieldName('path');
    if (!pathNode) {
      return [];
    }
    const source = unquote(pathNode.text);
    const isLocal = pathNode.type === 'string_literal' && !source.startsWith('.') && !source.startsWith('/');
    return [isLocal ? `./${source}` : source];
  }

  if (isDynamicImportNode(node)) {
    return findDynamicImportSources(node);
  }

  const sourceNode = node.childForFieldName('source') ?? findFirstStringNode(node);
  return sourceNode ? [unquote(sourceNode.text)] : [];
}

const rubyRequireMethods = new Set(['require', 'require_relative', 'load']);

/** Only receiverless Kernel-style calls import; `loader.require(...)` is an ordinary method call. */
function isRubyRequireCall(node: Parser.SyntaxNode, language: LanguageDefinition): boolean {
  if (language.name !== 'ruby' || node.type !== 'call') {
    return false;
  }

  const methodNode = node.childForFieldName('method');
  if (methodNode?.type !== 'identifier') {
    return false;
  }
  // `autoload :User, './user'` registers a `require`; it may carry a module receiver
  // (`Object.autoload ...`), unlike the receiverless Kernel-style require forms.
  if (methodNode.text === 'autoload') {
    const receiver = node.childForFieldName('receiver');
    return receiver === null || receiver.type === 'constant' || receiver.type === 'scope_resolution';
  }
  return node.childForFieldName('receiver') === null && rubyRequireMethods.has(methodNode.text);
}

/** Resolves `require`/`require_relative`/`load` sources; `require_relative` is always file-relative. */
function findRubyRequireSources(node: Parser.SyntaxNode): string[] {
  const argumentsNode = node.childForFieldName('arguments');
  // `autoload :Name, 'path'` names its source in the second argument.
  const isAutoload = node.childForFieldName('method')?.text === 'autoload';
  const firstArgument = argumentsNode?.namedChild(isAutoload ? 1 : 0);
  if (!firstArgument || firstArgument.type !== 'string') {
    return [];
  }

  // Dynamic requires (`require "#{name}"`) name no static source.
  if (firstArgument.namedChildren.some((child) => child.type === 'interpolation')) {
    return [];
  }

  // Percent literals (`%q(foo)`) keep their delimiters in `text`; the content children are exact.
  // Escape sequences interleave with content and must be decoded, not dropped.
  const contentNodes = firstArgument.namedChildren.filter(
    (child) => child.type === 'string_content' || child.type === 'escape_sequence'
  );
  const source =
    contentNodes.length > 0
      ? contentNodes
          .map((child) => (child.type === 'escape_sequence' ? decodeRubyEscapeSequence(child.text) : child.text))
          .join('')
      : unquote(firstArgument.text);
  const isRelative = node.childForFieldName('method')?.text === 'require_relative';
  if (isRelative) {
    return [source.startsWith('.') ? source : `./${source}`];
  }
  // Plain `require`/`load` resolve `./`/`../` paths against the process CWD, not the requiring
  // file, so the relative prefix is stripped to keep the source unresolvable as file-relative.
  return [source.replace(/^(?:\.\.?\/)+/u, '')];
}

const rubyEscapeCharacters = new Map([
  ['n', '\n'],
  ['t', '\t'],
  ['r', '\r'],
  ['s', ' '],
  ['0', '\0'],
]);

/** Decodes a Ruby escape (`\\` -> `\`, `\/` -> `/`, `\n` -> newline) inside a require path. */
function decodeRubyEscapeSequence(text: string): string {
  const escaped = text.slice(1);
  return rubyEscapeCharacters.get(escaped) ?? escaped;
}

function findDynamicImportSources(node: Parser.SyntaxNode): string[] {
  const argumentsNode = node.childForFieldName('arguments');
  const firstArgument = argumentsNode?.namedChild(0);
  return firstArgument && isStringNode(firstArgument) ? [unquote(firstArgument.text)] : [];
}

function isRelativeImportSource(source: string, language: LanguageName): boolean {
  if (source.startsWith('.') || source.startsWith('/')) {
    return true;
  }

  // `crate`/`self`/`super` are local only in Rust; other languages may legitimately import a module
  // literally named that, so the in-crate rule must not leak across languages.
  return language === 'rust' && isRustLocalImportSource(source);
}

/** Rust in-crate imports address the module tree through `crate`, `self`, or `super`. */
function isRustLocalImportSource(source: string): boolean {
  return /^(?:crate|self|super)(?:::|$)/u.test(source);
}

/**
 * Extracts the module path(s) a Rust `use` declaration reaches into, dropping the imported leaf item(s).
 * Grouped imports are fully expanded so each imported item resolves to its own module, e.g.
 * `use std::{collections::HashMap, fmt};` yields `std::collections` and `std`, matching the single-item
 * forms `use std::collections::HashMap;` and `use std::fmt;`.
 */
function findRustImportSources(node: Parser.SyntaxNode): string[] {
  // `mod b;` (no body) pulls the child module's file into the tree, like an import of `self::b`.
  if (node.type === 'mod_item') {
    const nameNode = node.childForFieldName('name');
    return nameNode ? [`self::${normalizeImportSource(nameNode.text)}`] : [];
  }
  // `extern crate serde as s;` names the crate directly; the alias is irrelevant to the source.
  if (node.type === 'extern_crate_declaration') {
    const nameNode = node.childForFieldName('name');
    return nameNode ? [normalizeImportSource(nameNode.text)] : [];
  }

  const argument = node.childForFieldName('argument');
  return argument ? rustImportSources(argument, '') : [];
}

/** Resolves the module source(s) of a `use` tree node, given the module `prefix` accumulated from ancestors. */
function rustImportSources(node: Parser.SyntaxNode, prefix: string): string[] {
  switch (node.type) {
    case 'use_list': {
      return node.namedChildren.flatMap((child) => rustImportSources(child, prefix));
    }
    case 'scoped_use_list': {
      const listNode = node.childForFieldName('list');
      const nextPrefix = joinModulePath(prefix, rustPathText(node.childForFieldName('path')));
      return listNode ? rustImportSources(listNode, nextPrefix) : withModulePrefix(nextPrefix);
    }
    case 'scoped_identifier': {
      // In-crate paths keep the leaf: `use crate::b;` names module `b`, and the resolver probes
      // the parent module as a fallback when the leaf turns out to be an item, not a module.
      const fullPath = joinModulePath(prefix, normalizeImportSource(node.text));
      if (isRustLocalImportSource(fullPath)) {
        return withModulePrefix(fullPath);
      }
      // Drop the leaf item: the source is the prefix plus this node's own `path` field.
      return withModulePrefix(joinModulePath(prefix, rustPathText(node.childForFieldName('path'))));
    }
    case 'use_wildcard': {
      // `use a::b::*;` imports from `a::b`; the wildcard has no `path` field, so its whole inner path counts.
      return withModulePrefix(joinModulePath(prefix, rustPathText(node.namedChild(0))));
    }
    case 'use_as_clause': {
      const pathNode = node.childForFieldName('path');
      return pathNode ? rustImportSources(pathNode, prefix) : [];
    }
    case 'self': {
      // `self` in a group (`use std::io::{self, Write};`) refers to the prefix module itself.
      return withModulePrefix(prefix);
    }
    case 'identifier':
    case 'crate':
    case 'super': {
      // Inside an in-crate group (`use crate::{a, b};`) each leaf may itself be a module; keep it
      // and let the resolver fall back to the prefix module.
      if (node.type === 'identifier' && isRustLocalImportSource(prefix)) {
        return withModulePrefix(joinModulePath(prefix, normalizeImportSource(node.text)));
      }
      // A bare leaf item: at the top level (`use tokio;`) it is the module; inside a group its module is the prefix.
      return withModulePrefix(prefix === '' ? normalizeImportSource(node.text) : prefix);
    }
    default: {
      return [];
    }
  }
}

function rustPathText(node: Parser.SyntaxNode | null): string {
  return node ? normalizeImportSource(node.text) : '';
}

function joinModulePath(prefix: string, segment: string): string {
  if (!segment) {
    return prefix;
  }
  return prefix ? `${prefix}::${segment}` : segment;
}

function withModulePrefix(source: string): string[] {
  return source ? [source] : [];
}

function findPythonImportSources(node: Parser.SyntaxNode, options: { expandPythonSubmodules: boolean }): string[] {
  if (node.type === 'import_from_statement') {
    const moduleNode = node.childForFieldName('module_name');
    if (!moduleNode) {
      return [];
    }

    const moduleSource = normalizeImportSource(moduleNode.text);
    const nameNodes = findChildrenByFieldName(node, 'name');
    if (!options.expandPythonSubmodules || !moduleSource.startsWith('.')) {
      return [moduleSource];
    }
    if (/^\.+$/u.test(moduleSource) && nameNodes.length > 0) {
      return nameNodes.flatMap(findPythonImportNames).map((name) => `${moduleSource}${name}`);
    }
    const submoduleSources = nameNodes.flatMap(findPythonImportNames).map((name) => `${moduleSource}.${name}`);
    if (submoduleSources.length > 0) {
      return [moduleSource, ...submoduleSources];
    }
    return [moduleSource];
  }

  if (node.type !== 'import_statement') {
    return [];
  }

  return node.namedChildren
    .map((child) => findPythonImportedModuleName(child))
    .filter((source) => source !== undefined);
}

function findPythonImportNames(node: Parser.SyntaxNode): string[] {
  if (node.type === 'aliased_import') {
    const nameNode = node.childForFieldName('name');
    return nameNode ? findPythonImportNames(nameNode) : [];
  }

  if (node.type === 'identifier') {
    return [node.text];
  }

  if (node.type === 'dotted_name') {
    return [normalizeImportSource(node.text)];
  }

  return node.namedChildren.flatMap(findPythonImportNames);
}

function findChildrenByFieldName(node: Parser.SyntaxNode, fieldName: string): Parser.SyntaxNode[] {
  const children: Parser.SyntaxNode[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child && node.fieldNameForChild(index) === fieldName) {
      children.push(child);
    }
  }
  return children;
}

function findPythonImportedModuleName(node: Parser.SyntaxNode): string | undefined {
  if (node.type === 'dotted_name' || node.type === 'relative_import') {
    return normalizeImportSource(node.text);
  }

  const nameNode = node.childForFieldName('name');
  if (nameNode) {
    return normalizeImportSource(nameNode.text);
  }

  for (const child of node.namedChildren) {
    const source = findPythonImportedModuleName(child);
    if (source) {
      return source;
    }
  }

  return undefined;
}

function normalizeImportSource(source: string): string {
  return source.replaceAll(/\s+/gu, '');
}

function findFirstStringNode(node: Parser.SyntaxNode): Parser.SyntaxNode | undefined {
  if (isStringNode(node)) {
    return node;
  }

  for (const child of node.namedChildren) {
    const stringNode = findFirstStringNode(child);
    if (stringNode) {
      return stringNode;
    }
  }

  return undefined;
}

function isStringNode(node: Parser.SyntaxNode): boolean {
  return node.type === 'string' || node.type === 'string_literal' || node.type === 'interpreted_string_literal';
}

function unquote(value: string): string {
  return value.replaceAll(/^['"`<]|['"`>]$/gu, '');
}

function isExportNode(node: Parser.SyntaxNode): boolean {
  // Java's JPMS `exports com.example.api;` directive is module wiring, not a symbol export.
  return (
    (node.type.startsWith('export') && node.type !== 'exports_module_directive') ||
    node.type === 'public_field_definition'
  );
}

function findRecursiveIndexes(graph: Map<number, Set<number>>): Set<number> {
  const recursiveIndexes = new Set<number>();

  for (const index of graph.keys()) {
    if (canReach(index, index, graph, new Set())) {
      recursiveIndexes.add(index);
    }
  }

  return recursiveIndexes;
}

function canReach(start: number, target: number, graph: Map<number, Set<number>>, visited: Set<number>): boolean {
  const callees = graph.get(start);
  if (!callees) {
    return false;
  }

  for (const callee of callees) {
    if (callee === target) {
      return true;
    }

    if (!visited.has(callee)) {
      visited.add(callee);
      if (canReach(callee, target, graph, visited)) {
        return true;
      }
    }
  }

  return false;
}

function measureMaxCallDepth(graph: Map<number, Set<number>>): number {
  const depthByIndex = new Map<number, number>();
  let maxDepth = 0;
  for (const index of graph.keys()) {
    maxDepth = Math.max(maxDepth, measureCallDepth(index, graph, new Set(), depthByIndex).depth);
  }
  return maxDepth;
}

/**
 * Longest-path DFS with memoization (O(V+E) on acyclic regions); a per-path copy of the on-stack
 * set made this exponential in path count. A depth computed under an on-stack cycle cut is valid
 * only for that path, so tainted results are NOT memoized — other entry points recompute them,
 * keeping values identical to the per-path algorithm while acyclic regions stay memoized.
 */
function measureCallDepth(
  index: number,
  graph: Map<number, Set<number>>,
  pathIndexes: Set<number>,
  depthByIndex: Map<number, number>
): { depth: number; tainted: boolean } {
  const memoized = depthByIndex.get(index);
  if (memoized !== undefined) {
    return { depth: memoized, tainted: false };
  }
  const callees = graph.get(index);
  if (!callees || callees.size === 0) {
    return { depth: 0, tainted: false };
  }
  if (pathIndexes.has(index)) {
    return { depth: 0, tainted: true };
  }

  pathIndexes.add(index);
  let maxDepth = 0;
  let tainted = false;
  for (const callee of callees) {
    const result = measureCallDepth(callee, graph, pathIndexes, depthByIndex);
    maxDepth = Math.max(maxDepth, 1 + result.depth);
    tainted ||= result.tainted;
  }
  pathIndexes.delete(index);
  if (!tainted) {
    depthByIndex.set(index, maxDepth);
  }
  return { depth: maxDepth, tainted };
}

function countIntersection(left: Set<string>, right: Set<string>): number {
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  let count = 0;
  for (const value of smaller) {
    if (larger.has(value)) {
      count += 1;
    }
  }
  return count;
}

function calculateMaintainabilityIndex(volume: number, complexity: number, loc: number): number {
  if (loc === 0) {
    return 100;
  }

  const raw = 171 - 5.2 * Math.log(Math.max(volume, 1)) - 0.23 * complexity - 16.2 * Math.log(loc);
  return Math.max(0, Math.min(100, (raw * 100) / 171));
}

function incrementCount(map: Map<string, number>, value: string): void {
  map.set(value, (map.get(value) ?? 0) + 1);
}

function maxMetric(functions: FunctionMetrics[], key: 'cyclomaticComplexity' | 'cognitiveComplexity'): number {
  return functions.length === 0 ? 0 : Math.max(...functions.map((fn) => fn[key]));
}

function maxMapValue(map: Map<unknown, number>): number {
  let maximum = 0;
  for (const value of map.values()) {
    maximum = Math.max(maximum, value);
  }
  return maximum;
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
