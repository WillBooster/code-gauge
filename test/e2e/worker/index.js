import { WorkerEntrypoint } from 'cloudflare:workers';
import { collectCrossFileDuplicationFileData, collectFunctionTokenSequences, measureCode } from 'code-gauge';

export default class CodeGaugeWorker extends WorkerEntrypoint {
  measureCode(code, options) {
    return measureCode(code, options);
  }

  collectCrossFileDuplicationFileData(code, options) {
    return collectCrossFileDuplicationFileData(code, options);
  }

  collectFunctionTokenSequences(code, options) {
    return collectFunctionTokenSequences(code, options);
  }
}
