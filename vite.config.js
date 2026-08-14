import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  esbuild: {
    target: 'node14',
  },
  test: {
    globalSetup: './test/helpers/globalSetup.ts',
  },
}));
