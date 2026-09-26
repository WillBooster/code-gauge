import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Builds the native addon and the package once before any test file runs. Every measurement
 * crosses into the Rust addon, the CLI E2E suites spawn dist/cli.js, and the Workers suite bundles
 * dist/worker.js; building inside their own beforeAll would race when vitest runs the files in
 * parallel workers.
 */
export default function globalSetup(): void {
  const repoRoot = path.join(import.meta.dirname, '..', '..');
  run(repoRoot, 'bun', ['run', 'build-native'], 600_000);
  run(repoRoot, 'bun', ['run', 'build'], 100_000);
}

export function run(cwd: string, command: string, args: string[], timeout: number): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout });
  if (result.status !== 0) {
    throw new Error(
      `Failed to run \`${command} ${args.join(' ')}\` before running E2E tests:\n${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`
    );
  }
}
