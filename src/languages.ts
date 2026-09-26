import type { LanguageDefinition, LanguageName, SupportedLanguage } from './types.js';

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
  { name: 'csharp', aliases: ['cs', 'c#'] },
  { name: 'kotlin', aliases: ['kt', 'kts'] },
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

const languageByExtension = new Map<string, SupportedLanguage>([
  ['.c', 'c'],
  ['.c++', 'cpp'],
  ['.cc', 'cpp'],
  ['.cjs', 'javascript'],
  ['.cp', 'cpp'],
  ['.cpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.tcc', 'cpp'],
  ['.cts', 'typescript'],
  ['.cxx', 'cpp'],
  ['.go', 'go'],
  // Headers may be C or C++; the C++ grammar parses both.
  ['.h', 'cpp'],
  ['.hh', 'cpp'],
  ['.hpp', 'cpp'],
  ['.hxx', 'cpp'],
  ['.java', 'java'],
  ['.js', 'javascript'],
  ['.jsx', 'jsx'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.mjs', 'javascript'],
  ['.mts', 'typescript'],
  ['.py', 'python'],
  ['.rb', 'ruby'],
  ['.rs', 'rust'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
]);

/** Detects the language of a source file from its extension, or `undefined` when unsupported. */
export function detectLanguage(filePath: string): SupportedLanguage | undefined {
  const extension = extname(filePath);
  // GCC treats an uppercase `.C` as C++; lowercasing first would misparse it with the C grammar.
  if (extension === '.C') {
    return 'cpp';
  }
  return languageByExtension.get(extension.toLowerCase());
}

/**
 * path.extname() without node:path, which runtimes such as Cloudflare Workers lack. Like Node.js,
 * backslashes separate paths only on Windows; elsewhere they are ordinary file-name characters.
 */
function extname(filePath: string): string {
  const separatorIndex = Math.max(
    filePath.lastIndexOf('/'),
    globalThis.process?.platform === 'win32' ? filePath.lastIndexOf('\\') : -1
  );
  const baseName = filePath.slice(separatorIndex + 1);
  const dotIndex = baseName.lastIndexOf('.');
  return dotIndex > 0 ? baseName.slice(dotIndex) : '';
}
