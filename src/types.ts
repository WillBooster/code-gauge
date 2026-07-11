export type SupportedLanguage =
  | 'c'
  | 'cpp'
  | 'go'
  | 'java'
  | 'javascript'
  | 'jsx'
  | 'python'
  | 'ruby'
  | 'rust'
  | 'typescript'
  | 'tsx';

export type LanguageName = SupportedLanguage | (string & {});
export type ParserLanguage = unknown;

export interface LanguageDefinition {
  name: LanguageName;
  parserLanguage: ParserLanguage;
  aliases?: readonly string[];
  functionNodeTypes?: readonly string[];
  classNodeTypes?: readonly string[];
  decisionNodeTypes?: readonly string[];
  nestingNodeTypes?: readonly string[];
}

export interface MeasureOptions {
  language: LanguageName;
  includeSyntaxTree?: boolean;
}

export interface LineMetrics {
  total: number;
  code: number;
  comment: number;
  blank: number;
}

export interface HalsteadMetrics {
  distinctOperators: number;
  distinctOperands: number;
  totalOperators: number;
  totalOperands: number;
  vocabulary: number;
  length: number;
  volume: number;
  difficulty: number;
  effort: number;
  time: number;
  bugs: number;
}

export interface FunctionMetrics {
  name?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  returnsJsx: boolean;
  cyclomaticComplexity: number;
  cognitiveComplexity: number;
  nestingDepth: number;
  callCount: number;
  uniqueCalleeCount: number;
  fanIn: number;
  fanOut: number;
  parameterCount: number;
  recursive: boolean;
}

export interface CallGraphMetrics {
  callCount: number;
  uniqueCalleeCount: number;
  internalCallCount: number;
  internalEdgeCount: number;
  recursiveFunctionCount: number;
  maxFanIn: number;
  maxFanOut: number;
  maxCallDepth: number;
}

export interface CouplingMetrics {
  importCount: number;
  importSourceCount: number;
  relativeImportCount: number;
  externalImportCount: number;
  exportCount: number;
}

export interface DeclarationMetrics {
  exported: boolean;
  name: string;
  startLine: number;
}

export interface ModuleMetrics {
  declarations: DeclarationMetrics[];
  importSources: string[];
}

export interface CohesionMetrics {
  averageFunctionIdentifierOverlap: number;
  sharedIdentifierCount: number;
  uniqueIdentifierCount: number;
}

export interface SyntaxFeatureMetrics {
  assignmentCount: number;
  awaitExpressionCount: number;
  loopStatementCount: number;
  mutableBindingCount: number;
  returnStatementCount: number;
  throwStatementCount: number;
  tryStatementCount: number;
}

/**
 * Within-file structural duplication: copy-pasted regions whose normalized token sequence repeats.
 * Identifiers are anonymized consistently by first-occurrence order and literals by kind, so
 * consistently renamed copies match. Distinct from cross-file duplicate symbol names.
 */
export interface DuplicationMetrics {
  /** Number of redundant (extra) copies of duplicated regions, i.e. sum of (groupSize - 1). */
  duplicateBlockCount: number;
  /** Number of distinct normalized token sequences that appear more than once. */
  duplicateBlockGroupCount: number;
  /** 1-based line ranges of every counted copy, grouped by shared normalized token sequence. */
  duplicateBlockGroups: DuplicateBlockOccurrence[][];
  /** Number of distinct lines covered by any counted duplicate occurrence (originals included). */
  duplicateLineCount: number;
  /** duplicateLineCount / total lines (0 when the file is empty). */
  duplicationRatio: number;
  /** Normalized token count of the largest duplicated region, indicating how big the copied region is. */
  maxDuplicateBlockSize: number;
}

export interface DuplicateBlockOccurrence {
  endLine: number;
  startLine: number;
}

export interface TypeComplexityMetrics {
  typeAnnotationCount: number;
  typeAliasCount: number;
  interfaceCount: number;
  genericParameterCount: number;
  unionTypeCount: number;
  intersectionTypeCount: number;
  conditionalTypeCount: number;
  typeAssertionCount: number;
  nonNullAssertionCount: number;
  satisfiesExpressionCount: number;
}

export interface CodeMetrics {
  language: LanguageName;
  bytes: number;
  lines: LineMetrics;
  functions: FunctionMetrics[];
  classCount: number;
  functionCount: number;
  cyclomaticComplexity: number;
  maxCyclomaticComplexity: number;
  cognitiveComplexity: number;
  maxCognitiveComplexity: number;
  nestingDepth: number;
  callGraph: CallGraphMetrics;
  coupling: CouplingMetrics;
  module: ModuleMetrics;
  cohesion: CohesionMetrics;
  syntaxFeatures: SyntaxFeatureMetrics;
  typeComplexity: TypeComplexityMetrics;
  duplication: DuplicationMetrics;
  halstead: HalsteadMetrics;
  maintainabilityIndex: number;
  syntaxTree?: string;
}
