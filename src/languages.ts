import type { LanguageDefinition, LanguageName } from './types.js';

/**
 * The built-in languages. Grammars and per-language node-type configuration live in the Rust
 * addon (native/src/languages.rs); this list only names the languages and their aliases so the
 * CLI and API can resolve and enumerate them without crossing the N-API boundary.
 */
export const defaultLanguages: readonly LanguageDefinition[] = [
  { name: 'javascript', aliases: ['js', 'mjs', 'cjs'] },
  { name: 'jsx' },
  { name: 'typescript', aliases: ['ts'] },
  { name: 'tsx' },
  { name: 'python', aliases: ['py'] },
  { name: 'go' },
  { name: 'rust', aliases: ['rs'] },
  { name: 'java' },
  { name: 'ruby', aliases: ['rb'] },
  { name: 'c' },
  { name: 'cpp', aliases: ['c++', 'cxx'] },
];

export function createLanguageRegistry(
  languages: readonly LanguageDefinition[] = defaultLanguages
): Map<LanguageName, LanguageDefinition> {
  const registry = new Map<LanguageName, LanguageDefinition>();

  for (const language of languages) {
    registry.set(language.name, language);
    for (const alias of language.aliases ?? []) {
      registry.set(alias, language);
    }
  }

  return registry;
}

export const supportedLanguages = defaultLanguages.map((language) => language.name);
