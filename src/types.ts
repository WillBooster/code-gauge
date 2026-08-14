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
  decisionNodeTypes?: readonly string[];
  nestingNodeTypes?: readonly string[];
  /** Node types that each count as one non-commenting source statement (NCSS). */
  ncssNodeTypes?: readonly string[];
  /**
   * Node types whose direct named children count as statements even without a dedicated statement
   * node type (expression-oriented grammars: Ruby bodies, Rust trailing block expressions).
   */
  ncssContainerNodeTypes?: readonly string[];
}

/** Detection settings for within-file and cross-file duplication. */
export interface DuplicationOptions {
  /** Minimum normalized token count for a region to be considered for duplication (default 40). */
  minTokens?: number;
  /**
   * Maximum normalized-token gap between two adjacent duplicate groups merged into one gapped
   * (Type-3) clone group (default 30). 0 disables merging. Applies to within-file and cross-file
   * detection: two near-identical regions in separate files that differ by one edited statement
   * merge into one cross-file group when each file's fragments are gap-adjacent.
   */
  maxGapTokens?: number;
  /**
   * Minimum similarity percent (1-100) for near-miss (Type-3) clone blocks, measured as the
   * token-level longest common subsequence relative to the larger block (NiCad-style per-fragment
   * similarity). 100 disables near-miss detection and reports exact (Type-1/2) matches plus gapped
   * merges only (default 70). Applies to within-file detection only.
   */
  minSimilarityPercent?: number;
}

export interface MeasureOptions {
  language: LanguageName;
  includeSyntaxTree?: boolean;
  /** Duplication detection settings; non-default values disable the native backend for the call. */
  duplication?: DuplicationOptions;
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
  effort: number;
}

export interface FunctionMetrics {
  name?: string;
  /**
   * The tree-sitter node type of the function (e.g. `method_declaration`, `arrow_function`,
   * `lambda_expression`), letting consumers distinguish declared methods from lambdas — e.g. to
   * sum per-function metrics without double-counting lambda content already attributed to the
   * enclosing function.
   */
  nodeType: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  cognitiveComplexity: number;
  nestingDepth: number;
  /**
   * Non-commenting source statements in the function, PMD-style: the declaration itself, each
   * statement, and each `else`/`case` label/`catch`/`finally` clause count 1; nested function and
   * class bodies are included, so summing over functions counts shared regions more than once.
   */
  ncss: number;
  parameterCount: number;
  /**
   * Halstead metrics of the function's whole subtree. Nested function bodies are included, so
   * summing over functions counts shared regions more than once (like ncss).
   */
  halstead: HalsteadMetrics;
  /**
   * Approximate def-use dependency degree (DepDegree, Beyer & Fararooy 2010): the number of
   * variable reads whose name has a preceding definition (declaration, assignment, or parameter)
   * within the same function. A file-local single-assignment approximation — each read is charged
   * one reaching definition — which is stable enough for regression ratcheting where only the
   * delta matters.
   */
  depDegree: number;
}

/**
 * Within-file structural duplication: copy-pasted regions whose normalized token sequence repeats.
 * Identifiers are anonymized consistently by first-occurrence order and literals by kind, so
 * consistently renamed copies match.
 */
export interface DuplicationMetrics {
  /**
   * Number of redundant (extra) duplicated regions: sum over groups of (groupSize - 1) times the
   * matched fragments per occurrence, so merging a gapped clone's fragments into one group does
   * not halve duplicateBlockCount — an edited two-fragment pair still counts 2, exactly as its
   * unmerged fragments did.
   */
  duplicateBlockCount: number;
  /** Number of distinct normalized token sequences that appear more than once. */
  duplicateBlockGroupCount: number;
  /** 1-based line ranges of every counted copy, grouped by shared normalized token sequence. */
  duplicateBlockGroups: DuplicateBlockOccurrence[][];
  /** Number of distinct lines covered by any counted duplicate occurrence (originals included). */
  duplicateLineCount: number;
  /**
   * The 1-based lines behind duplicateLineCount, sorted ascending: code lines carrying matched
   * tokens. Exposed so consumers combining within-file and cross-file coverage can union exact
   * line sets instead of over-counting from block bounding ranges (which include the unmatched gap
   * of a merged clone and comment/blank lines).
   */
  duplicateLineNumbers: number[];
  /**
   * duplicateLineCount / code lines (0 when the file has no code). Code lines are the denominator
   * because duplicated lines are counted from matched tokens, which only ever land on code lines;
   * dividing by total lines would let comment density deflate the ratio.
   */
  duplicationRatio: number;
  /** Normalized token count of the largest duplicated region, indicating how big the copied region is. */
  maxDuplicateBlockSize: number;
}

export interface DuplicateBlockOccurrence {
  endLine: number;
  startLine: number;
}

export interface CodeMetrics {
  language: LanguageName;
  bytes: number;
  lines: LineMetrics;
  functions: FunctionMetrics[];
  cognitiveComplexity: number;
  maxCognitiveComplexity: number;
  nestingDepth: number;
  /** Non-commenting source statements in the whole file; every statement counts exactly once. */
  ncssCount: number;
  duplication: DuplicationMetrics;
  halstead: HalsteadMetrics;
  syntaxTree?: string;
}
