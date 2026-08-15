#!/usr/bin/env node
// Loads the built addon and measures a snippet, catching link/ABI failures that a successful
// compile hides; used by the build-native workflow's smoke steps.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const binding = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'code-gauge.node'));
const metrics = JSON.parse(binding.measureCodeNative('function a() { return 1; }', 'javascript', false));
if (metrics.language !== 'javascript' || metrics.functions.length !== 1) {
  throw new Error(`unexpected smoke-test payload: ${JSON.stringify(metrics)}`);
}
console.log(`smoke OK (payload version ${binding.payloadVersion()})`);
