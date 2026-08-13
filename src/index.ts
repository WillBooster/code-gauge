export { measureCrossFileDuplication } from './crossFileDuplication.js';
export type {
  CrossFileDuplicateBlockGroup,
  CrossFileDuplicateOccurrence,
  CrossFileDuplicationMetrics,
  CrossFileDuplicationSourceFile,
} from './crossFileDuplication.js';
export type { CrossFileDuplicateCandidate, CrossFileDuplicationFileData } from './duplication.js';
export { defaultLanguages, supportedLanguages } from './languages.js';
export { TreeMeasurer, collectDuplicationCandidates, defaultMeasurer, measureCode } from './metrics.js';
export { isNativeBackendAvailable } from './nativeMetrics.js';
export type {
  CallGraphMetrics,
  CodeMetrics,
  CohesionMetrics,
  CouplingMetrics,
  DeclarationMetrics,
  DuplicationMetrics,
  DuplicationOptions,
  FunctionMetrics,
  HalsteadMetrics,
  LanguageDefinition,
  LanguageName,
  LineMetrics,
  MeasureOptions,
  ModuleMetrics,
  SupportedLanguage,
  SyntaxFeatureMetrics,
  TypeComplexityMetrics,
} from './types.js';
