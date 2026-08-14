export { measureCrossFileDuplication } from './crossFileDuplication.js';
export type {
  CrossFileDuplicateBlockGroup,
  CrossFileDuplicateOccurrence,
  CrossFileDuplicationMetrics,
  CrossFileDuplicationSourceFile,
} from './crossFileDuplication.js';
export type { CrossFileDuplicateCandidate, CrossFileDuplicationFileData } from './duplication.js';
export { defaultLanguages, supportedLanguages } from './languages.js';
export {
  TreeMeasurer,
  collectCrossFileDuplicationFileData,
  collectDuplicationCandidates,
  collectFunctionTokenSequences,
  defaultMeasurer,
  measureCode,
} from './metrics.js';
export { isNativeBackendAvailable } from './nativeMetrics.js';
export { defaultGateOptions, evaluateRegressionGate } from './regressionGate.js';
export type {
  GateFileInput,
  GateOptions,
  GateResult,
  GateTolerances,
  GateViolation,
  NewFunctionThresholds,
} from './regressionGate.js';
export type {
  CodeMetrics,
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
