import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { LanguageName } from '../../src/index.js';

export interface CorpusEntry {
  /** Path relative to the fixtures directory, used as a stable test name. */
  name: string;
  language: LanguageName;
  code: string;
}

const languageByExtension = new Map<string, LanguageName>([
  ['.c', 'c'],
  ['.cpp', 'cpp'],
  ['.go', 'go'],
  ['.java', 'java'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.py', 'python'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
]);

export const fixturesDir = path.join(import.meta.dirname, '..', 'fixtures');

/**
 * Every measurable fixture under test/fixtures (recursively), so golden-snapshot and
 * TS-vs-native parity suites cover the identical corpus. The CRLF fixture is stored with LF
 * (editors and git would silently rewrite it) and converted here.
 */
export function loadFixtureCorpus(): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  for (const file of readdirSync(fixturesDir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) {
      continue;
    }
    const language = languageByExtension.get(path.extname(file.name));
    if (!language) {
      continue;
    }
    const filePath = path.join(file.parentPath, file.name);
    const name = path.relative(fixturesDir, filePath).replaceAll(path.sep, '/');
    let code = readFileSync(filePath, 'utf8');
    if (name.startsWith('edge/crlf.')) {
      code = code.replaceAll('\n', '\r\n');
    }
    entries.push({ name, language, code });
  }
  return entries.toSorted((left, right) => left.name.localeCompare(right.name));
}
