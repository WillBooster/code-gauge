export { measureCrossFileDuplication } from './crossFileDuplication.js';
export type {
  CrossFileDuplicateBlockGroup,
  CrossFileDuplicateOccurrence,
  CrossFileDuplicationMetrics,
  CrossFileDuplicationSourceFile,
} from './crossFileDuplication.js';
export type { CrossFileDuplicateCandidate, CrossFileDuplicationFileData } from './duplication.js';
export { defaultLanguages, detectLanguage, supportedLanguages } from './languages.js';
export {
  TreeMeasurer,
  collectCrossFileDuplicationFileData,
  collectDuplicationCandidates,
  collectFunctionTokenSequences,
  defaultMeasurer,
  measureCode,
} from './metrics.js';
export type {
  CodeMetrics,
  CognitiveBlock,
  DuplicationMetrics,
  DuplicationOptions,
  FunctionMetrics,
  HalsteadMetrics,
  LanguageDefinition,
  LanguageName,
  LineMetrics,
  MeasureOptions,
  SupportedLanguage,
} from './types.js';
