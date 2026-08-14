import Parser from 'tree-sitter';
import {
  collectCrossFileDuplicateCandidates,
  defaultDuplicationOptions,
  measureDuplication,
  type CrossFileDuplicateCandidate,
  type CrossFileDuplicationFileData,
} from './duplication.js';
import { createLanguageRegistry } from './languages.js';
import { commentNodeTypes, countNcss, getNcssSets, invalidateNcssSetsCache, ncssContribution } from './ncss.js';
import { measureWithNativeBackend, type NativeHalsteadCounts, type NativeMetricsPayload } from './nativeMetrics.js';
import type {
  CodeMetrics,
  FunctionMetrics,
  HalsteadMetrics,
  LanguageDefinition,
  LanguageName,
  MeasureOptions,
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
  cognitiveComplexity: number;
  nestingDepth: number;
}

interface CommentSpan {
  line: number;
  startColumn: number;
  endColumn: number;
}

export class TreeMeasurer {
  private readonly registry = createLanguageRegistry();

  registerLanguage(language: LanguageDefinition): void {
    // Re-registering may carry mutated node-type arrays; drop derived caches so they rebuild.
    invalidateComplexityNodeSetsCache(language);
    invalidateNcssSetsCache(language);
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

    // The native backend implements only the default duplication settings, so custom settings
    // measure through the TypeScript backend instead of silently ignoring them.
    const nativePayload = usesDefaultDuplicationOptions(options)
      ? measureWithNativeBackend(code, language, options.includeSyntaxTree ?? false)
      : undefined;
    if (nativePayload) {
      return assembleNativeMetrics(nativePayload, options.includeSyntaxTree ?? false);
    }

    const root = parseRoot(code, language);
    const functions = collectNodes(root, new Set(language.functionNodeTypes)).filter(
      (node) => !isLambdaBodyBlock(node) && isImplementedFunction(node)
    );
    const functionMetrics = collectFunctionMetrics(root, functions, language);
    const globalComplexity = measureComplexity(root, language);
    const { lines, codeLineNumbers } = classifyLines(code, root);

    return {
      language: language.name,
      bytes: Buffer.byteLength(code),
      lines,
      functions: functionMetrics,
      cognitiveComplexity: globalComplexity.cognitiveComplexity,
      maxCognitiveComplexity: maxCognitiveComplexity(functionMetrics),
      nestingDepth: globalComplexity.nestingDepth,
      ncssCount: countNcss(root, language),
      duplication: measureDuplication(root, codeLineNumbers, options.duplication),
      halstead: measureHalstead(root, code),
      syntaxTree: options.includeSyntaxTree ? root.toString() : undefined,
    };
  }

  /** Collects one file's duplicate candidates for cross-file clone detection. */
  collectDuplicationCandidates(code: string, options: MeasureOptions): CrossFileDuplicateCandidate[] {
    return this.collectCrossFileDuplicationFileData(code, options).candidates;
  }

  /**
   * Collects one file's duplicate candidates, normalized tokens, and statement structure for
   * cross-file clone detection with measureCrossFileDuplication. Always measured by the
   * TypeScript backend.
   */
  collectCrossFileDuplicationFileData(code: string, options: MeasureOptions): CrossFileDuplicationFileData {
    const language = this.registry.get(options.language);
    if (!language) {
      throw new Error(`Unsupported language: ${options.language}`);
    }
    return collectCrossFileDuplicateCandidates(parseRoot(code, language), options.duplication);
  }
}

function parseRoot(code: string, language: LanguageDefinition): Parser.SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(language.parserLanguage);
  return parser.parse(code, undefined, { bufferSize: code.length + 1 }).rootNode;
}

function usesDefaultDuplicationOptions(options: MeasureOptions): boolean {
  const duplication = options.duplication;
  return (
    (duplication?.minTokens ?? defaultDuplicationOptions.minTokens) === defaultDuplicationOptions.minTokens &&
    (duplication?.maxGapTokens ?? defaultDuplicationOptions.maxGapTokens) === defaultDuplicationOptions.maxGapTokens &&
    (duplication?.minSimilarityPercent ?? defaultDuplicationOptions.minSimilarityPercent) ===
      defaultDuplicationOptions.minSimilarityPercent
  );
}

export const defaultMeasurer = new TreeMeasurer();

export function measureCode(code: string, options: MeasureOptions): CodeMetrics {
  return defaultMeasurer.measure(code, options);
}

/** Standalone helper mirroring measureCode for the default measurer. */
export function collectDuplicationCandidates(code: string, options: MeasureOptions): CrossFileDuplicateCandidate[] {
  return defaultMeasurer.collectDuplicationCandidates(code, options);
}

/** Standalone helper mirroring measureCode for the default measurer. */
export function collectCrossFileDuplicationFileData(
  code: string,
  options: MeasureOptions
): CrossFileDuplicationFileData {
  return defaultMeasurer.collectCrossFileDuplicationFileData(code, options);
}

/**
 * Completes a native measurement into CodeMetrics. The object is rebuilt field by field (rather
 * than spread from the parsed JSON) so the result has exactly the shape the TypeScript backend
 * produces, including explicitly-undefined optional keys.
 */
function assembleNativeMetrics(payload: NativeMetricsPayload, includeSyntaxTree: boolean): CodeMetrics {
  return {
    language: payload.language,
    bytes: payload.bytes,
    lines: payload.lines,
    functions: payload.functions.map((fn) => ({
      name: fn.name,
      nodeType: fn.nodeType,
      startLine: fn.startLine,
      startColumn: fn.startColumn,
      endLine: fn.endLine,
      cognitiveComplexity: fn.cognitiveComplexity,
      nestingDepth: fn.nestingDepth,
      ncss: fn.ncss,
      parameterCount: fn.parameterCount,
    })),
    cognitiveComplexity: payload.cognitiveComplexity,
    maxCognitiveComplexity: payload.maxCognitiveComplexity,
    nestingDepth: payload.nestingDepth,
    ncssCount: payload.ncssCount,
    duplication: payload.duplication,
    halstead: deriveHalsteadMetrics(payload.halsteadCounts),
    syntaxTree: includeSyntaxTree ? payload.syntaxTree : undefined,
  };
}

function collectFunctionMetrics(
  root: Parser.SyntaxNode,
  functions: Parser.SyntaxNode[],
  language: LanguageDefinition
): FunctionMetrics[] {
  const bodyMetricsByNodeId = measureFunctionBodyMetrics(root, language);
  return functions.map((node) => {
    const bodyMetrics = bodyMetricsByNodeId.get(node.id);
    if (!bodyMetrics) {
      throw new Error(`missing body metrics for function node at line ${node.startPosition.row + 1}`);
    }
    return {
      name: findFunctionName(node),
      nodeType: node.type,
      startLine: node.startPosition.row + 1,
      startColumn: node.startPosition.column,
      endLine: node.endPosition.row + 1,
      cognitiveComplexity: bodyMetrics.cognitiveComplexity,
      nestingDepth: bodyMetrics.nestingDepth,
      ncss: bodyMetrics.ncss,
      parameterCount: countParameters(node),
    };
  });
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
  // C/C++ `f(void)` declares none. A Ruby block parameter (`&blk`) binds the block, which call
  // sites pass outside the argument list, so it counts toward no arity.
  let count = 0;
  for (const child of parametersNode.namedChildren) {
    if (
      child.type === 'comment' ||
      child.type === 'self_parameter' ||
      child.type === 'receiver_parameter' ||
      child.type === 'block_parameter' ||
      // Python's PEP 570/3102 markers (`/`, `*`) separate parameter kinds but bind nothing.
      child.type === 'positional_separator' ||
      child.type === 'keyword_separator' ||
      blockLocalIds.has(child.id) ||
      isVoidParameter(child)
    ) {
      continue;
    }
    // Go declares several names per declaration (`a, b int`); each name is a parameter.
    count += child.type === 'parameter_declaration' ? Math.max(1, findChildrenByFieldName(child, 'name').length) : 1;
  }
  // C++ C-style varargs (`int f(int a, ...)`) leave `...` as an anonymous token, unlike C's named
  // `variadic_parameter`.
  const anonymousVariadicCount = parametersNode.children.filter(
    (child) => !child.isNamed && child.text === '...'
  ).length;
  return count + anonymousVariadicCount;
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

/**
 * C++ `function_definition` also covers pure-virtual/`= default`/`= delete` members; those have no
 * `body` and are signatures, not implementations, matching how TypeScript method signatures are
 * excluded. Java `method_declaration` is NOT here: PMD reports abstract/interface methods as
 * methods (NCSS 1), so bodyless Java methods stay in the function list.
 */
const bodyRequiredFunctionTypes = new Set([
  'function_definition',
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

// Sonar cognitive complexity charges a switch/match once as a whole, not per case label. Only
// named nodes are consulted, so anonymous keyword tokens never match.
const switchLikeNodeTypes = new Set([
  'switch_statement',
  'switch_expression',
  'expression_switch_statement',
  'type_switch_statement',
  'select_statement',
  'match_expression',
  'match_statement',
  'case',
  'case_match',
]);

// Per-case decision nodes add no cognitive point because the switch itself carries the cost.
const caseClauseNodeTypes = new Set([
  'case_clause',
  'switch_case',
  'switch_block_statement_group',
  'switch_rule',
  'case_statement',
  'expression_case',
  'type_case',
  'communication_case',
  'match_arm',
  'when',
  'in_clause',
]);

const ifLikeNodeTypes = new Set(['if_statement', 'if_expression', 'if', 'unless']);

interface ComplexityNodeSets {
  functionNodes: Set<string>;
  decisionNodes: Set<string>;
  nestingNodes: Set<string>;
}

// Cached per language: measureComplexity runs once per function plus once per file, so per-call
// Set construction would add a measurable constant factor on large files.
const complexityNodeSetsCache = new WeakMap<LanguageDefinition, ComplexityNodeSets>();

/** Drops the cached sets so a re-registered (possibly mutated) definition rebuilds them. */
function invalidateComplexityNodeSetsCache(language: LanguageDefinition): void {
  complexityNodeSetsCache.delete(language);
}

function getComplexityNodeSets(language: LanguageDefinition): ComplexityNodeSets {
  let sets = complexityNodeSetsCache.get(language);
  if (!sets) {
    sets = {
      functionNodes: new Set(language.functionNodeTypes),
      decisionNodes: new Set(language.decisionNodeTypes),
      nestingNodes: new Set(language.nestingNodeTypes),
    };
    complexityNodeSetsCache.set(language, sets);
  }
  return sets;
}

interface FunctionBodyMetrics {
  cognitiveComplexity: number;
  nestingDepth: number;
  ncss: number;
}

/** Accumulator for one function body during measureFunctionBodyMetrics' post-order pass. */
interface FunctionBodyFrame {
  cognitiveComplexity: number;
  /** Count of `1 + nesting` cognitive increments, for re-basing on hoist into the parent frame. */
  nestingSensitiveCount: number;
  nestingDepth: number;
  ncss: number;
  hasOwnNcssContribution: boolean;
  /** Cognitive nesting (structural nesting + function/class bonuses) carried into this body. */
  entryCognitiveNesting: number;
  /** Structural nesting carried into this body (bonuses excluded), for nesting depth. */
  entryStructuralNesting: number;
}

function createFrame(entryCognitiveNesting: number, entryStructuralNesting: number): FunctionBodyFrame {
  return {
    cognitiveComplexity: 0,
    nestingSensitiveCount: 0,
    nestingDepth: 0,
    ncss: 0,
    hasOwnNcssContribution: false,
    entryCognitiveNesting,
    entryStructuralNesting,
  };
}

/**
 * Per-function complexity and NCSS for every function boundary, in one post-order pass so each
 * node is visited once instead of once per enclosing function (issue #35). A function's metrics
 * are its own-body contributions plus, per directly nested function, that function's
 * already-computed totals: NCSS hoists as-is; cognitive complexity re-bases the nested function's
 * nesting-sensitive increments (each worth `1 + nesting`) by the nesting offset at the embedding
 * site, while flat increments (else branches, boolean-operator sequences, chain continuations,
 * jumps, guards) hoist unchanged; nesting depth describes the own body only, so it does not hoist.
 */
function measureFunctionBodyMetrics(
  root: Parser.SyntaxNode,
  language: LanguageDefinition
): Map<number, FunctionBodyMetrics> {
  const { functionNodes, decisionNodes, nestingNodes } = getComplexityNodeSets(language);
  const { countable, containers } = getNcssSets(language);
  const results = new Map<number, FunctionBodyMetrics>();
  // frames[0] is a sentinel for top-level code; its accumulation is discarded.
  const frames: FunctionBodyFrame[] = [createFrame(0, 0)];

  function visit(
    current: Parser.SyntaxNode,
    currentNesting: number,
    functionNestingBonus: number,
    insideFunction: boolean,
    insideNestedRegion: boolean,
    insideChargedClassBody: boolean
  ): void {
    // A class body nested in a function (anonymous/local classes) raises the cognitive nesting
    // level once for everything inside it — PMD charges the class body, not the methods it holds
    // (verified: an anonymous-class instance initializer's `if` costs 1 + 1 nesting), so methods
    // directly inside a charged class body skip the function-boundary bonus.
    const isChargedClassBody = current.type === 'class_body' && insideFunction;
    if (isChargedClassBody) {
      insideNestedRegion = true;
      functionNestingBonus += 1;
    }
    const opensFrame = isFunctionBoundary(current, functionNodes);
    if (opensFrame) {
      if (insideFunction && !insideChargedClassBody) {
        functionNestingBonus += 1;
      }
      insideFunction = true;
    }
    // The node's own increments target the frame it is embedded in, not the one it opens; a
    // frame-opening or charged-class-body node contributes nothing to that frame's own body
    // (nesting), matching the per-function traversal this pass replaces.
    const frame = frames.at(-1) as FunctionBodyFrame;
    const relativeNesting = currentNesting + functionNestingBonus - frame.entryCognitiveNesting;
    const countsForOwnBody = !insideNestedRegion && !opensFrame;

    // Anonymous keyword tokens can share a type with named nodes (Ruby's `if` node contains an
    // `if` keyword token), so only named nodes count as decisions.
    const isDecision = current.isNamed && decisionNodes.has(current.type) && !isDefaultSwitchBranch(current);
    const isCaseClause = current.isNamed && caseClauseNodeTypes.has(current.type);
    // Ruby's `case ... else` arm is an `else` node; like every other language's default branch it
    // nests its contents inside the switch (it cannot go in the Ruby nesting set because
    // `if`/`begin` else branches would then double-nest under their already-nesting parent).
    const isNesting =
      current.isNamed &&
      (nestingNodes.has(current.type) ||
        (current.type === 'else' && (current.parent?.type === 'case' || current.parent?.type === 'case_match')));
    // `elsif`/`elif`/`else if` continue a flat chain: they add a decision without a nesting
    // surcharge, and their bodies stay at the chain's nesting level (Sonar cognitive-complexity
    // semantics); genuinely nested conditionals inside those bodies still deepen.
    const isContinuation = isDecision && isFlatChainContinuation(current);

    if (isDecision && !isCaseClause) {
      if (isContinuation) {
        frame.cognitiveComplexity += 1;
      } else {
        frame.cognitiveComplexity += 1 + relativeNesting;
        frame.nestingSensitiveCount += 1;
      }
    }
    if (current.isNamed && switchLikeNodeTypes.has(current.type)) {
      frame.cognitiveComplexity += 1 + relativeNesting;
      frame.nestingSensitiveCount += 1;
    }
    // A plain `else` branch adds one flat cognitive point; `else if` chains are charged on the
    // nested if instead.
    frame.cognitiveComplexity += countPlainElseBranches(current);
    // Sonar charges flow-breaking jumps: goto and labeled break/continue add one flat point.
    if (isFlowBreakingJump(current)) {
      frame.cognitiveComplexity += 1;
    }

    // A sequence of identical boolean operators reads as one condition, so only the operator
    // starting a sequence adds a cognitive point (Sonar spec).
    if (isBooleanOperator(current) && startsBooleanOperatorSequence(current)) {
      frame.cognitiveComplexity += 1;
    }

    // Pattern guards (Java `when`, Ruby `in y if ...`, Python `case n if ...`, Rust `n if ... =>`)
    // add one independent execution path without nesting.
    if (isPatternGuard(current)) {
      frame.cognitiveComplexity += 1;
    }

    const childNesting = isNesting && !isContinuation ? currentNesting + 1 : currentNesting;
    if (countsForOwnBody) {
      frame.nestingDepth = Math.max(frame.nestingDepth, childNesting - frame.entryStructuralNesting);
    }

    if (opensFrame) {
      frames.push(createFrame(childNesting + functionNestingBonus, childNesting));
    }
    // The node's NCSS contribution belongs to the innermost frame whose subtree holds it — the
    // frame the node opens, if any (per-function NCSS includes the declaration node itself).
    const ownNcss = ncssContribution(current, countable, containers);
    const ncssFrame = frames.at(-1) as FunctionBodyFrame;
    ncssFrame.ncss += ownNcss;
    if (opensFrame && ownNcss > 0) {
      ncssFrame.hasOwnNcssContribution = true;
    }

    for (const child of current.children) {
      visit(
        child,
        childNesting,
        functionNestingBonus,
        insideFunction,
        opensFrame ? false : insideNestedRegion,
        isChargedClassBody
      );
    }

    if (opensFrame) {
      const closed = frames.pop() as FunctionBodyFrame;
      results.set(current.id, {
        cognitiveComplexity: closed.cognitiveComplexity,
        nestingDepth: closed.nestingDepth,
        // A function node without a countable declaration of its own (arrow functions, lambdas,
        // blocks) still counts 1 for the declaration itself.
        ncss: closed.ncss + (closed.hasOwnNcssContribution ? 0 : 1),
      });
      const parent = frames.at(-1) as FunctionBodyFrame;
      parent.cognitiveComplexity +=
        closed.cognitiveComplexity +
        closed.nestingSensitiveCount * (closed.entryCognitiveNesting - parent.entryCognitiveNesting);
      parent.nestingSensitiveCount += closed.nestingSensitiveCount;
      parent.ncss += closed.ncss;
    }
  }

  visit(root, 0, 0, false, false, false);
  return results;
}

/**
 * File-level complexity over the whole tree. Cognitive complexity charges nested function/lambda
 * content one nesting level deeper per function boundary crossed (Sonar spec); nesting depth
 * counts every node once.
 */
function measureComplexity(node: Parser.SyntaxNode, language: LanguageDefinition): ComplexityResult {
  let cognitiveComplexity = 0;
  let nestingDepth = 0;
  const { functionNodes, decisionNodes, nestingNodes } = getComplexityNodeSets(language);

  function visit(
    current: Parser.SyntaxNode,
    currentNesting: number,
    functionNestingBonus: number,
    insideFunction: boolean,
    insideChargedClassBody: boolean
  ): void {
    // A class body nested in a function (anonymous/local classes) raises the cognitive nesting
    // level once for everything inside it — PMD charges the class body, not the methods it holds,
    // so methods directly inside a charged class body skip the function-boundary bonus.
    const isChargedClassBody = current.type === 'class_body' && insideFunction;
    if (isChargedClassBody) {
      functionNestingBonus += 1;
    }
    if (isFunctionBoundary(current, functionNodes)) {
      if (insideFunction && !insideChargedClassBody) {
        functionNestingBonus += 1;
      }
      insideFunction = true;
    }
    const cognitiveNesting = currentNesting + functionNestingBonus;

    // Anonymous keyword tokens can share a type with named nodes (Ruby's `if` node contains an
    // `if` keyword token), so only named nodes count as decisions.
    const isDecision = current.isNamed && decisionNodes.has(current.type) && !isDefaultSwitchBranch(current);
    const isCaseClause = current.isNamed && caseClauseNodeTypes.has(current.type);
    // Ruby's `case ... else` arm is an `else` node; like every other language's default branch it
    // nests its contents inside the switch (it cannot go in the Ruby nesting set because
    // `if`/`begin` else branches would then double-nest under their already-nesting parent).
    const isNesting =
      current.isNamed &&
      (nestingNodes.has(current.type) ||
        (current.type === 'else' && (current.parent?.type === 'case' || current.parent?.type === 'case_match')));
    // `elsif`/`elif`/`else if` continue a flat chain: they add a decision without a nesting
    // surcharge, and their bodies stay at the chain's nesting level (Sonar cognitive-complexity
    // semantics); genuinely nested conditionals inside those bodies still deepen.
    const isContinuation = isDecision && isFlatChainContinuation(current);

    if (isDecision && !isCaseClause) {
      cognitiveComplexity += isContinuation ? 1 : 1 + cognitiveNesting;
    }
    if (current.isNamed && switchLikeNodeTypes.has(current.type)) {
      cognitiveComplexity += 1 + cognitiveNesting;
    }
    // A plain `else` branch adds one flat cognitive point; `else if` chains are charged on the
    // nested if instead.
    cognitiveComplexity += countPlainElseBranches(current);
    // Sonar charges flow-breaking jumps: goto and labeled break/continue add one flat point.
    if (isFlowBreakingJump(current)) {
      cognitiveComplexity += 1;
    }

    // A sequence of identical boolean operators reads as one condition, so only the operator
    // starting a sequence adds a cognitive point (Sonar spec).
    if (isBooleanOperator(current) && startsBooleanOperatorSequence(current)) {
      cognitiveComplexity += 1;
    }

    // Pattern guards (Java `when`, Ruby `in y if ...`, Python `case n if ...`, Rust `n if ... =>`)
    // add one independent execution path without nesting.
    if (isPatternGuard(current)) {
      cognitiveComplexity += 1;
    }

    const childNesting = isNesting && !isContinuation ? currentNesting + 1 : currentNesting;
    nestingDepth = Math.max(nestingDepth, childNesting);

    for (const child of current.children) {
      visit(child, childNesting, functionNestingBonus, insideFunction, isChargedClassBody);
    }
  }

  for (const child of node.children) {
    visit(child, 0, 0, false, false);
  }

  return { cognitiveComplexity, nestingDepth };
}

/**
 * Plain else branches attached to `current`: an `else_clause`/Ruby `else` whose branch is not an
 * `else if` continuation, or a bare Java/Go `alternative:` statement without a clause wrapper.
 */
function countPlainElseBranches(current: Parser.SyntaxNode): number {
  if (!current.isNamed) {
    return 0;
  }
  if (current.type === 'else') {
    // A Ruby `case ... else` is the default arm of a switch, which already counts as a whole
    // (sonar-ruby models it as a match case, not an else branch); `if`/`unless`/`begin` else
    // branches count one point each.
    return current.parent?.type === 'case' || current.parent?.type === 'case_match' ? 0 : 1;
  }
  if (current.type === 'else_clause') {
    return current.namedChildren.some((child) => ifLikeNodeTypes.has(child.type)) ? 0 : 1;
  }
  if (current.type !== 'if_statement' && current.type !== 'if_expression') {
    return 0;
  }
  let count = 0;
  for (let index = 0; index < current.childCount; index += 1) {
    const child = current.child(index);
    if (
      child &&
      current.fieldNameForChild(index) === 'alternative' &&
      child.type !== 'else_clause' &&
      child.type !== 'elif_clause' &&
      !ifLikeNodeTypes.has(child.type)
    ) {
      count += 1;
    }
  }
  return count;
}

/** goto, and break/continue that jump to a label (their only named child is the label). */
function isFlowBreakingJump(node: Parser.SyntaxNode): boolean {
  if (!node.isNamed) {
    return false;
  }
  if (node.type === 'goto_statement') {
    return true;
  }
  // Rust jumps are expressions; `break value` carries a named expression child, so only an
  // explicit `label` child marks a labeled jump.
  if (node.type === 'break_expression' || node.type === 'continue_expression') {
    return node.namedChildren.some((child) => child.type === 'label' || child.type === 'loop_label');
  }
  // Comments are named children too (`break /* done */;`), so only non-comment children mark a
  // label.
  return (
    (node.type === 'break_statement' || node.type === 'continue_statement') &&
    node.namedChildren.some((child) => !commentNodeTypes.has(child.type))
  );
}

// Wrappers that are transparent when locating the enclosing boolean operation: PMD/Sonar keep a
// sequence continuous across parentheses (`a && (b && c)` costs one point).
const parenthesizedNodeTypes = new Set(['parenthesized_expression', 'parenthesized_statements']);

/**
 * Whether this boolean operator token starts a new sequence, i.e. its binary node is the root of a
 * run of same-operator binaries (possibly through parentheses). Only the root operator counts one
 * cognitive point: `a && b && c` and `a && (b && c)` cost one, `a && b || c` costs two, matching
 * the Sonar specification and PMD 7.26.0.
 */
function startsBooleanOperatorSequence(token: Parser.SyntaxNode): boolean {
  const binary = token.parent;
  if (!binary) {
    return true;
  }
  let ancestor = binary.parent;
  while (ancestor && parenthesizedNodeTypes.has(ancestor.type)) {
    ancestor = ancestor.parent;
  }
  if (!ancestor || ancestor.type !== binary.type) {
    return true;
  }
  return normalizeBooleanOperator(findBooleanOperatorText(ancestor)) !== normalizeBooleanOperator(token.text);
}

/** C++ `and`/`or` are alternative spellings of `&&`/`||`, so mixing them keeps one sequence. */
function normalizeBooleanOperator(text: string | undefined): string | undefined {
  if (text === 'and') {
    return '&&';
  }
  if (text === 'or') {
    return '||';
  }
  return text;
}

function findBooleanOperatorText(binaryNode: Parser.SyntaxNode): string | undefined {
  const operator = binaryNode.childForFieldName('operator');
  if (operator) {
    return operator.text;
  }
  return binaryNode.children.find((child) => !child.isNamed && booleanOperators.has(child.text))?.text;
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
 * adds no decision, though its contents still nest inside the switch like any other arm.
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
    effort,
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
 */
function unwrapDeclaratorName(declarator: Parser.SyntaxNode | null): string | undefined {
  let current: Parser.SyntaxNode | null | undefined = declarator;
  while (current) {
    switch (current.type) {
      case 'identifier':
      case 'field_identifier':
      case 'type_identifier':
      case 'destructor_name':
      case 'operator_name': {
        return current.text;
      }
      // A C++ conversion operator (`operator int()`) is its own declarator node whose text spans
      // the parameter list and qualifiers; only `operator <type>` is the name.
      case 'operator_cast': {
        return `operator ${current.childForFieldName('type')?.text ?? ''}`.trimEnd();
      }
      // Template specializations (`id<int>`) and qualified names both carry a `name` field.
      case 'template_function':
      case 'qualified_identifier': {
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

function incrementCount(map: Map<string, number>, value: string): void {
  map.set(value, (map.get(value) ?? 0) + 1);
}

function maxCognitiveComplexity(functions: FunctionMetrics[]): number {
  return functions.length === 0 ? 0 : Math.max(...functions.map((fn) => fn.cognitiveComplexity));
}

function sum(values: Iterable<number>): number {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}
