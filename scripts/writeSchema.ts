import { writeFile } from 'node:fs/promises';

import { z } from 'zod';

import { configSchema } from '../src/cliConfig.js';

// The published JSON Schema of `code-gauge.config.json`, generated from the schema the CLI validates with.
await writeFile(
  new URL('../schema.json', import.meta.url),
  `${JSON.stringify(z.toJSONSchema(configSchema, { io: 'input' }), undefined, 2)}\n`
);
