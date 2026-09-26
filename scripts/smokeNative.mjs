#!/usr/bin/env node
// Loads the built addon and measures a snippet, catching link/ABI failures that a successful
// compile hides; used by the build-native workflow's smoke steps.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const binding = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'native', 'code-gauge.node'));
const snippet = 'function a() { return 1; }';
const payload = binding.measureCodeNative(snippet, 'javascript', false);
const metrics = JSON.parse(payload);
if (metrics.language !== 'javascript' || metrics.functions.length !== 1) {
  throw new Error(`unexpected smoke-test payload: ${JSON.stringify(metrics)}`);
}
// The async binding measures on the addon's own worker threads, whose creation and hand-off back
// to the JavaScript thread are platform-specific.
const asyncPayload = await binding.measureCodeNativeAsync(snippet, 'javascript', false);
if (asyncPayload !== payload) {
  throw new Error(`async smoke-test payload differs: ${asyncPayload}`);
}
console.log(`smoke OK (payload version ${binding.payloadVersion()})`);
