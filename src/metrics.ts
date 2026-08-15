import type { CrossFileDuplicateCandidate, CrossFileDuplicationFileData } from './duplication.js';
import { createLanguageRegistry } from './languages.js';
import {
  collectCrossFileDataNative,
  collectFunctionTokenSequencesNative,
  measureCodeNative,
  type NativeHalsteadCounts,
  type NativeMetricsPayload,
} from './nativeMetrics.js';
import type { CodeMetrics, HalsteadMetrics, LanguageDefinition, LanguageName, MeasureOptions } from './types.js';

/**
 * Measures code metrics for the built-in languages. Parsing and metric passes run in the bundled
 * Rust addon (tree-sitter); this class resolves language aliases, crosses the N-API boundary, and
 * derives the Halstead float metrics from the natively measured counts.
 */
export class TreeMeasurer {
  private readonly registry = createLanguageRegistry();

  getSupportedLanguages(): LanguageName[] {
    return [...new Set([...this.registry.values()].map((language) => language.name))];
  }

  measure(code: string, options: MeasureOptions): CodeMetrics {
    const language = this.resolveLanguage(options.language);
    const includeSyntaxTree = options.includeSyntaxTree ?? false;
    const payload = measureCodeNative(code, language.name, includeSyntaxTree, options.duplication);
    return assembleNativeMetrics(payload, includeSyntaxTree);
  }

  /** Collects one file's duplicate candidates for cross-file clone detection. */
  collectDuplicationCandidates(code: string, options: MeasureOptions): CrossFileDuplicateCandidate[] {
    return this.collectCrossFileDuplicationFileData(code, options).candidates;
  }

  /**
   * Collects one file's duplicate candidates, normalized tokens, and statement structure for
   * cross-file clone detection with measureCrossFileDuplication.
   */
  collectCrossFileDuplicationFileData(code: string, options: MeasureOptions): CrossFileDuplicationFileData {
    const language = this.resolveLanguage(options.language);
    const payload = collectCrossFileDataNative(code, language.name, options.duplication?.minTokens);
    return {
      candidates: payload.candidates,
      tokens: payload.tokens,
      containerStatements: payload.containerStatements,
      // Lets cross-file line coverage count only code lines, like within-file coverage.
      codeLineNumbers: new Set(payload.codeLineNumbers),
    };
  }

  /**
   * Normalized token hash sequences of every function, index-parallel to the functions array of
   * measure(): identifiers are anonymized by first occurrence within the function, literals by
   * kind, and keywords/operators kept verbatim, so the regression gate can re-match renamed or
   * moved functions across two revisions by token-LCS similarity.
   */
  collectFunctionTokenSequences(code: string, options: MeasureOptions): Int32Array[] {
    const language = this.resolveLanguage(options.language);
    return collectFunctionTokenSequencesNative(code, language.name);
  }

  private resolveLanguage(name: LanguageName): LanguageDefinition {
    const language = this.registry.get(name);
    if (!language) {
      throw new Error(`Unsupported language: ${name}`);
    }
    return language;
  }
}

/**
 * Completes a native measurement into CodeMetrics. The object is rebuilt field by field (rather
 * than spread from the parsed JSON) so the result has a stable shape, including
 * explicitly-undefined optional keys.
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
      halstead: deriveHalsteadMetrics(fn.halsteadCounts),
      depDegree: fn.depDegree,
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

export const defaultMeasurer = new TreeMeasurer();

export function measureCode(code: string, options: MeasureOptions): CodeMetrics {
  return defaultMeasurer.measure(code, options);
}

/** Standalone helper mirroring measureCode for the default measurer. */
export function collectDuplicationCandidates(code: string, options: MeasureOptions): CrossFileDuplicateCandidate[] {
  return defaultMeasurer.collectDuplicationCandidates(code, options);
}

/** Standalone helper mirroring measureCode for the default measurer. */
export function collectFunctionTokenSequences(code: string, options: MeasureOptions): Int32Array[] {
  return defaultMeasurer.collectFunctionTokenSequences(code, options);
}

/** Standalone helper mirroring measureCode for the default measurer. */
export function collectCrossFileDuplicationFileData(
  code: string,
  options: MeasureOptions
): CrossFileDuplicationFileData {
  return defaultMeasurer.collectCrossFileDuplicationFileData(code, options);
}
