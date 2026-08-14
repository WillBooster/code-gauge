import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Builds the CLI once before any test file runs. The CLI E2E suites spawn dist/cli.js; building
 * inside their own beforeAll would race when vitest runs the files in parallel workers.
 */
export default function globalSetup(): void {
  const repoRoot = path.join(import.meta.dirname, '..', '..');
  const build = spawnSync('bun', ['run', 'build'], { cwd: repoRoot, encoding: 'utf8', timeout: 100_000 });
  if (build.status !== 0) {
    throw new Error(
      `Failed to build the CLI before running E2E tests:\n${build.error?.message ?? ''}\n${build.stdout}\n${build.stderr}`
    );
  }
}
