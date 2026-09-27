import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { readLinguistAttributes, resolveRepoRoot, type LinguistAttributes } from './git.js';

/**
 * Files left out of measurement beyond the built-in directory and file-name rules: configured
 * glob patterns, files git attributes mark `linguist-generated` or `linguist-vendored`, and files
 * whose header carries a generated-code marker. All paths are absolute.
 */
export interface Exclusion {
  isExcludedPath(absolutePath: string): boolean;
  /** Whether the content is generated code, unless git attributes mark the file `-linguist-generated`. */
  isGeneratedCode(absolutePath: string, code: string): boolean;
}

/** Glob patterns relative to `root` (the directory of the config file that declared them). */
export interface ExcludePatterns {
  patterns: string[];
  root: string;
}

const generatedMarkerLineCount = 5;
// Meta's `@generated` convention (used by tree-sitter, Relay, and Buck) and the wording of Go's
// `// Code generated ... DO NOT EDIT.` convention, which protoc, Prisma, and others share.
const generatedTagPattern = /(?:^|[^\w@])@generated\b/u;
const doNotEditPattern = /\bgenerated\b.*\bdo not (?:edit|modify)\b/iu;

export function createExclusion(
  excludePatterns: ExcludePatterns,
  attributesByPath: ReadonlyMap<string, LinguistAttributes> = new Map()
): Exclusion {
  return {
    isExcludedPath(absolutePath) {
      const attributes = attributesByPath.get(absolutePath);
      if (attributes?.generated === true || attributes?.vendored === true) {
        return true;
      }
      const relativePath = path.relative(excludePatterns.root, absolutePath).split(path.sep).join('/');
      return (
        !relativePath.startsWith('../') &&
        excludePatterns.patterns.some((pattern) => path.posix.matchesGlob(relativePath, pattern))
      );
    },
    isGeneratedCode(absolutePath, code) {
      if (attributesByPath.get(absolutePath)?.generated === false) {
        return false;
      }
      return code
        .split(/\r\n|\n|\r/u, generatedMarkerLineCount)
        .some((line) => generatedTagPattern.test(line) || doNotEditPattern.test(line));
    },
  };
}

/**
 * The exclusion for the given absolute paths found under `directory`, with git attributes from
 * the enclosing repository (which apply to ignored files too); outside any repository only
 * patterns and markers apply.
 */
export async function loadExclusion(
  directory: string,
  excludePatterns: ExcludePatterns,
  absolutePaths: readonly string[]
): Promise<Exclusion> {
  let repoRoot;
  try {
    repoRoot = await realpath(await resolveRepoRoot(directory));
  } catch {
    return createExclusion(await canonicalizeRoot(excludePatterns));
  }
  const relativePaths = absolutePaths
    .map((absolutePath) => path.relative(repoRoot, absolutePath).split(path.sep).join('/'))
    .filter((relativePath) => relativePath !== '..' && !relativePath.startsWith('../'));
  return await loadRepositoryExclusion(repoRoot, relativePaths, excludePatterns);
}

/**
 * The exclusion for repository-relative `paths` of the canonical `repoRoot`, with git attributes
 * from the working tree or, with `source`, from that revision.
 */
export async function loadRepositoryExclusion(
  repoRoot: string,
  paths: Iterable<string>,
  excludePatterns: ExcludePatterns,
  source?: string
): Promise<Exclusion> {
  const attributes = await readLinguistAttributes(repoRoot, paths, source);
  return createExclusion(
    await canonicalizeRoot(excludePatterns),
    new Map([...attributes].map(([relativePath, value]) => [path.join(repoRoot, relativePath), value]))
  );
}

/** Scanned paths are canonical, so a pattern root reached through a symbolic link must be too. */
async function canonicalizeRoot(excludePatterns: ExcludePatterns): Promise<ExcludePatterns> {
  return { ...excludePatterns, root: await realpath(excludePatterns.root).catch(() => excludePatterns.root) };
}
