import path from 'node:path';
import type { CodeMetrics, DeclarationMetrics } from './types.js';

export interface ArchitectureSourceFile {
  file: string;
  metrics: CodeMetrics;
}

export interface ArchitectureFileMetrics {
  directLocalDependencyCount: number;
  duplicateSymbolGroupCount: number;
  file: string;
  structuralBreadthScore: number;
  structuralCoordination: StructuralCoordinationMetrics;
  structuralFeatureGroups: string[];
  transitiveLocalDependencyCount: number;
}

export interface ArchitectureMetrics {
  duplicateSymbolGroups: DuplicateSymbolGroup[];
  files: ArchitectureFileMetrics[];
  maxDirectLocalDependencyCount: number;
  maxDuplicateSymbolGroupCount: number;
  maxStructuralBreadthScore: number;
  maxStructuralCoordinationScore: number;
  maxTransitiveLocalDependencyCount: number;
}

export interface DuplicateSymbolGroup {
  declarations: DuplicateSymbolDeclaration[];
  files: string[];
  name: string;
}

export interface DuplicateSymbolDeclaration {
  file: string;
  line: number;
}

export interface StructuralCoordinationMetrics {
  asyncBoundaryCount: number;
  branchingScore: number;
  exceptionHandlingCount: number;
  moduleInteractionScore: number;
  score: number;
  stateMutationScore: number;
}

interface SourceFile {
  file: string;
  metrics: CodeMetrics;
  relativeFile: string;
}

const duplicateSymbolNameLengthThreshold = 5;

export function measureArchitecture(
  files: readonly ArchitectureSourceFile[],
  displayRoot: string
): ArchitectureMetrics {
  const sourceFiles = files.map((file) => ({
    ...file,
    relativeFile: path.relative(displayRoot, file.file) || path.basename(file.file),
  }));
  const dependencyGraph = measureDependencyGraph(sourceFiles);
  const duplicateSymbolGroups = measureDuplicateSymbolGroups(sourceFiles);
  const duplicateGroupCountByFile = measureDuplicateGroupCountByFile(duplicateSymbolGroups);
  const metrics = sourceFiles.map((sourceFile) => {
    const directDependencies = dependencyGraph.dependenciesByFile.get(sourceFile.relativeFile) ?? new Set<string>();
    const nonRelativeLocalImportCount =
      dependencyGraph.nonRelativeLocalImportCountByFile.get(sourceFile.relativeFile) ?? 0;
    const structuralCoordination = measureStructuralCoordination(sourceFile.metrics);
    const structuralFeatureGroups = measureStructuralFeatureGroups(
      sourceFile.metrics,
      directDependencies.size,
      nonRelativeLocalImportCount
    );
    return {
      file: sourceFile.relativeFile,
      directLocalDependencyCount: directDependencies.size,
      duplicateSymbolGroupCount: duplicateGroupCountByFile.get(sourceFile.relativeFile) ?? 0,
      structuralBreadthScore: structuralFeatureGroups.length,
      structuralCoordination,
      structuralFeatureGroups,
      transitiveLocalDependencyCount: measureTransitiveDependencyCount(
        sourceFile.relativeFile,
        dependencyGraph.dependenciesByFile
      ),
    };
  });

  return {
    duplicateSymbolGroups,
    files: metrics,
    maxDirectLocalDependencyCount: maxFileMetric(metrics, 'directLocalDependencyCount'),
    maxDuplicateSymbolGroupCount: maxFileMetric(metrics, 'duplicateSymbolGroupCount'),
    maxStructuralBreadthScore: maxFileMetric(metrics, 'structuralBreadthScore'),
    maxStructuralCoordinationScore: Math.max(0, ...metrics.map((file) => file.structuralCoordination.score)),
    maxTransitiveLocalDependencyCount: maxFileMetric(metrics, 'transitiveLocalDependencyCount'),
  };
}

interface DependencyGraph {
  dependenciesByFile: Map<string, Set<string>>;
  /** Import sources without a relative prefix (Java dotted paths) that still resolved locally. */
  nonRelativeLocalImportCountByFile: Map<string, number>;
}

function measureDependencyGraph(files: SourceFile[]): DependencyGraph {
  const fileSet = new Set(files.map((file) => file.relativeFile));
  const javaFileIndex = buildJavaFileIndex(fileSet);
  const dependenciesByFile = new Map<string, Set<string>>();
  const nonRelativeLocalImportCountByFile = new Map<string, number>();
  for (const file of files) {
    const dependencies = new Set<string>();
    let nonRelativeLocalImportCount = 0;
    for (const source of file.metrics.module.importSources) {
      const resolved = resolveLocalImport(file.relativeFile, source, fileSet, javaFileIndex);
      if (resolved) {
        dependencies.add(resolved);
        // Only Java needs the external-count correction: its dotted imports classify as external
        // in coupling metrics. Rust crate::/self::/super:: sources already classify as relative,
        // so counting them would double-subtract from externalImportCount.
        if (file.relativeFile.endsWith('.java') && !source.startsWith('.')) {
          nonRelativeLocalImportCount += 1;
        }
      }
    }
    dependenciesByFile.set(file.relativeFile, dependencies);
    nonRelativeLocalImportCountByFile.set(file.relativeFile, nonRelativeLocalImportCount);
  }
  return { dependenciesByFile, nonRelativeLocalImportCountByFile };
}

function resolveLocalImport(
  fromFile: string,
  source: string,
  fileSet: Set<string>,
  javaFileIndex: Map<string, string[]>
): string | undefined {
  if (!source.startsWith('.')) {
    if (fromFile.endsWith('.rs') && /^(?:crate|self|super)(?:::|$)/u.test(source)) {
      return resolveRustLocalImport(fromFile, source, fileSet);
    }
    // Java imports are dotted class paths without a leading dot; other absolute sources are external.
    return fromFile.endsWith('.java') ? resolveJavaImport(source, javaFileIndex) : undefined;
  }
  const bases = localImportBases(fromFile, source);
  const fromExtension = path.extname(fromFile);

  // The JS-family ESM remap follows TypeScript's substitution table, which tries the TypeScript
  // source BEFORE the named JS file: `./foo.js` names `foo.ts` even when `foo.js` also exists,
  // and `./foo.mjs` may only name `foo.mts` (never an unrelated `foo.ts`), vice versa for `.cjs`.
  // Non-JS importers never remap, so `#include "config.inc"` cannot rebind to same-stem files.
  if (jsExtensions.has(fromExtension)) {
    for (const base of bases) {
      const substitutions = jsImportExtensionSubstitutions.get(path.extname(base));
      if (!substitutions) {
        continue;
      }
      const stem = base.slice(0, -path.extname(base).length);
      for (const substitution of substitutions) {
        if (fileSet.has(`${stem}${substitution}`)) {
          return `${stem}${substitution}`;
        }
      }
    }
  }

  // An explicit-path source (`#include "b.hpp"`, `require_relative "./b.rb"`, `./foo.js` with no
  // TypeScript counterpart) resolves exactly before extension probing, so a sibling `b.ts` cannot
  // shadow the named file.
  for (const base of bases) {
    if (fileSet.has(base)) {
      return base;
    }
  }

  const { extensions, indexFiles } = importProbes(fromFile);

  // Extension probing keeps each base's full name, so `./user.service` prefers `user.service.ts`.
  for (const stem of bases) {
    for (const extension of extensions) {
      if (fileSet.has(`${stem}${extension}`)) {
        return `${stem}${extension}`;
      }
    }
    for (const indexFile of indexFiles) {
      const candidate = path.join(stem, indexFile);
      if (fileSet.has(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

const jsExtensions = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const cExtensions = new Set(['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.hxx']);

/**
 * TypeScript's ESM extension substitutions: a JS runtime extension in an import may name the
 * TypeScript source that compiles to it. `.ts`-family extensions are intentionally absent (they
 * resolve exactly), and `.mjs`/`.cjs` never remap to plain `.ts`.
 */
const jsImportExtensionSubstitutions = new Map<string, string[]>([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
]);

/** Extension-less sources probe only extensions the importing language can actually load. */
function importProbes(fromFile: string): { extensions: string[]; indexFiles: string[] } {
  const fromExtension = path.extname(fromFile);
  if (fromExtension === '.rb') {
    return { extensions: ['.rb'], indexFiles: [] };
  }
  if (fromExtension === '.py') {
    return { extensions: ['.py'], indexFiles: ['__init__.py'] };
  }
  if (cExtensions.has(fromExtension)) {
    // The C preprocessor searches for the exact requested filename and never appends extensions,
    // so `#include "config"` must not resolve to a same-stem `config.h`.
    return { extensions: [], indexFiles: [] };
  }
  if (jsExtensions.has(fromExtension)) {
    return {
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
      indexFiles: ['index.ts', 'index.tsx', 'index.js'],
    };
  }
  return {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.h', '.hpp', '.hh', '.hxx', '.c', '.cpp', '.cc', '.cxx'],
    indexFiles: ['index.ts', 'index.tsx', 'index.js', '__init__.py'],
  };
}

/** Rust module owner files whose child modules live as siblings in the same directory. */
const rustOwnerFileNames = new Set(['mod.rs', 'lib.rs', 'main.rs']);

/**
 * Resolves a Rust in-crate module path (`crate::a::b`, `self::x`, `super::x`) to a scanned file by
 * probing `<path>.rs` and `<path>/mod.rs` against the appropriate base directories. `crate::` roots
 * are inferred from ancestor directories containing `lib.rs`/`main.rs`, falling back to every
 * ancestor so single-crate scans without a crate root file still resolve.
 */
function resolveRustLocalImport(fromFile: string, source: string, fileSet: Set<string>): string | undefined {
  const segments = source.split('::');
  const head = segments.shift();
  // Rust allows repeated `super` segments to ascend several modules; each extra one climbs a
  // directory before the remaining path is probed.
  let extraSuperCount = 0;
  while (head === 'super' && segments[0] === 'super') {
    segments.shift();
    extraSuperCount += 1;
  }
  const modulePath = segments.join('/');
  if (!modulePath) {
    return undefined;
  }
  const fromDirectory = normalizeDirectory(path.dirname(fromFile));
  const isOwner = rustOwnerFileNames.has(path.basename(fromFile));
  const stemDirectory = path.join(fromDirectory, path.basename(fromFile, '.rs'));

  let baseDirectories: string[];
  if (head === 'self') {
    // Children of a mod.rs/lib.rs/main.rs module are siblings; children of `a.rs` live in `a/`.
    baseDirectories = isOwner ? [fromDirectory] : [stemDirectory, fromDirectory];
  } else if (head === 'super') {
    baseDirectories = (
      isOwner
        ? [normalizeDirectory(path.dirname(fromDirectory)), fromDirectory]
        : [fromDirectory, normalizeDirectory(path.dirname(fromDirectory))]
    ).map((directory) => ascendDirectory(directory, extraSuperCount));
  } else {
    baseDirectories = rustCrateRootCandidates(fromDirectory, fileSet);
  }

  // The leaf may be an item rather than a module (`use crate::b::helper` keeps `helper`), so the
  // parent module path is probed as a fallback for each base directory.
  const modulePaths = [modulePath, segments.slice(0, -1).join('/')].filter(Boolean);
  for (const base of baseDirectories) {
    for (const candidateModulePath of modulePaths) {
      for (const candidate of [
        path.join(base, `${candidateModulePath}.rs`),
        path.join(base, candidateModulePath, 'mod.rs'),
      ]) {
        if (candidate !== fromFile && fileSet.has(candidate)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}

/** Ancestor directories of `fromDirectory` holding a crate root file, else all ancestors (nearest first). */
function rustCrateRootCandidates(fromDirectory: string, fileSet: Set<string>): string[] {
  const ancestors: string[] = [];
  let current = fromDirectory;
  for (;;) {
    ancestors.push(current);
    if (current === '') {
      break;
    }
    current = normalizeDirectory(path.dirname(current));
  }
  const withRootFile = ancestors.filter(
    (directory) => fileSet.has(path.join(directory, 'lib.rs')) || fileSet.has(path.join(directory, 'main.rs'))
  );
  return withRootFile.length > 0 ? withRootFile : ancestors;
}

function ascendDirectory(directory: string, levels: number): string {
  let current = directory;
  for (let index = 0; index < levels && current !== ''; index += 1) {
    current = normalizeDirectory(path.dirname(current));
  }
  return current;
}

function normalizeDirectory(directory: string): string {
  return directory === '.' ? '' : directory;
}

/** Indexes scanned `.java` files by class name so dotted imports resolve without scanning all files. */
function buildJavaFileIndex(fileSet: Set<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of fileSet) {
    if (!file.endsWith('.java')) {
      continue;
    }
    const className = path.basename(file, '.java');
    const files = index.get(className) ?? [];
    files.push(file);
    index.set(className, files);
  }
  for (const files of index.values()) {
    files.sort();
  }
  return index;
}

/**
 * Resolves a Java dotted import (`com.example.Helper`) to a scanned file whose path ends with the
 * package path, tolerating source-root prefixes (`src/main/java/...`). Static imports fall back to
 * the enclosing class once the member segment fails to match; wildcard imports name a package, not
 * a file, and stay unresolved. Ambiguity across source roots resolves to the lexicographically
 * first path for determinism.
 */
function resolveJavaImport(source: string, javaFileIndex: Map<string, string[]>): string | undefined {
  if (source.endsWith('.*')) {
    return undefined;
  }
  // Trailing segments are dropped one by one so nested types and static members resolve to their
  // enclosing top-level class file (`com.example.Outer.Inner.CONST` -> `Outer.java`).
  const segments = source.split('.');
  for (let end = segments.length; end >= 1; end -= 1) {
    const candidateSegments = segments.slice(0, end);
    const className = candidateSegments.at(-1);
    if (!className) {
      continue;
    }
    const relativePath = `${candidateSegments.join('/')}.java`;
    // Indexed paths use the platform separator (backslashes on Windows), so normalize for matching.
    const match = (javaFileIndex.get(className) ?? []).find((file) => {
      const normalized = file.replaceAll('\\', '/');
      return normalized === relativePath || normalized.endsWith(`/${relativePath}`);
    });
    if (match) {
      return match;
    }
  }
  return undefined;
}

function localImportBases(fromFile: string, source: string): string[] {
  const fromDirectory = path.dirname(fromFile);
  if (isPathRelativeImport(source)) {
    return [path.normalize(path.join(fromDirectory, source))];
  }

  const match = /^(?<dots>\.+)(?<module>.*)$/u.exec(source);
  const dots = match?.groups?.dots;
  const moduleName = match?.groups?.module;
  if (!dots || moduleName === undefined) {
    return [];
  }

  let baseDirectory = fromDirectory;
  for (let index = 1; index < dots.length; index += 1) {
    baseDirectory = path.dirname(baseDirectory);
  }

  const modulePath = moduleName.replaceAll('.', path.sep);
  return [path.normalize(path.join(baseDirectory, modulePath))];
}

function isPathRelativeImport(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../') || source.includes('/');
}

function measureTransitiveDependencyCount(file: string, graph: Map<string, Set<string>>): number {
  // Seed with the starting file so dependency cycles do not count it as its own dependency.
  const visited = new Set<string>([file]);
  const pending = [...(graph.get(file) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return visited.size - 1;
}

function measureDuplicateSymbolGroups(files: SourceFile[]): DuplicateSymbolGroup[] {
  const declarationsBySymbol = new Map<string, DuplicateSymbolDeclaration[]>();
  for (const file of files) {
    for (const declaration of file.metrics.module.declarations) {
      if (!isDuplicateSymbolCandidate(declaration)) {
        continue;
      }
      const declarations = declarationsBySymbol.get(declaration.name) ?? [];
      declarations.push(toDuplicateSymbolDeclaration(file.relativeFile, declaration));
      declarationsBySymbol.set(declaration.name, declarations);
    }
  }
  return [...declarationsBySymbol.entries()]
    .flatMap(([name, declarations]) => {
      const duplicateFiles = [...new Set(declarations.map((declaration) => declaration.file))].toSorted();
      return duplicateFiles.length > 1
        ? [{ declarations: declarations.toSorted(compareDuplicateDeclarations), files: duplicateFiles, name }]
        : [];
    })
    .toSorted((left, right) => right.files.length - left.files.length || left.name.localeCompare(right.name));
}

function isDuplicateSymbolCandidate(declaration: DeclarationMetrics): boolean {
  // The threshold applies to the local name so qualification (`Alpha::Ab`) cannot let short
  // names sneak past it.
  const localName = declaration.name.split('::').at(-1) ?? declaration.name;
  return localName.length >= duplicateSymbolNameLengthThreshold;
}

function toDuplicateSymbolDeclaration(file: string, declaration: DeclarationMetrics): DuplicateSymbolDeclaration {
  return { file, line: declaration.startLine };
}

function compareDuplicateDeclarations(left: DuplicateSymbolDeclaration, right: DuplicateSymbolDeclaration): number {
  return left.file.localeCompare(right.file) || left.line - right.line;
}

function measureDuplicateGroupCountByFile(groups: DuplicateSymbolGroup[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const file of group.files) {
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }
  }
  return counts;
}

function measureStructuralCoordination(metrics: CodeMetrics): StructuralCoordinationMetrics {
  const asyncBoundaryCount = metrics.syntaxFeatures.awaitExpressionCount;
  const exceptionHandlingCount = metrics.syntaxFeatures.tryStatementCount + metrics.syntaxFeatures.throwStatementCount;
  const stateMutationScore = metrics.syntaxFeatures.mutableBindingCount + metrics.syntaxFeatures.assignmentCount;
  const branchingScore =
    metrics.cyclomaticComplexity +
    metrics.syntaxFeatures.loopStatementCount +
    metrics.syntaxFeatures.returnStatementCount;
  const moduleInteractionScore =
    metrics.callGraph.callCount + metrics.callGraph.internalEdgeCount * 2 + metrics.callGraph.maxCallDepth * 3;

  return {
    asyncBoundaryCount,
    branchingScore,
    exceptionHandlingCount,
    moduleInteractionScore,
    score:
      asyncBoundaryCount * 2 +
      exceptionHandlingCount * 3 +
      stateMutationScore +
      branchingScore +
      moduleInteractionScore,
    stateMutationScore,
  };
}

/**
 * Java imports are dotted package paths, so per-file coupling classifies them as external even
 * when they resolve inside the scanned project; the dependency graph corrects both feature tags.
 */
function measureStructuralFeatureGroups(
  metrics: CodeMetrics,
  directLocalDependencyCount: number,
  nonRelativeLocalImportCount: number
): string[] {
  const groups = new Set<string>();
  addGroup(groups, 'class-shapes', metrics.classCount > 0);
  addGroup(groups, 'control-flow', metrics.cognitiveComplexity > 0);
  addGroup(groups, 'external-dependencies', metrics.coupling.externalImportCount - nonRelativeLocalImportCount > 0);
  addGroup(groups, 'functions', metrics.functionCount > 0);
  addGroup(groups, 'local-dependencies', metrics.coupling.relativeImportCount > 0 || directLocalDependencyCount > 0);
  addGroup(groups, 'module-api', metrics.coupling.exportCount > 0 || metrics.module.declarations.length > 0);
  addGroup(
    groups,
    'state-mutation',
    metrics.syntaxFeatures.mutableBindingCount + metrics.syntaxFeatures.assignmentCount > 0
  );
  addGroup(groups, 'type-shapes', hasTypeShapeMetrics(metrics));
  return [...groups].toSorted();
}

function addGroup(groups: Set<string>, group: string, condition: boolean): void {
  if (condition) {
    groups.add(group);
  }
}

function hasTypeShapeMetrics(metrics: CodeMetrics): boolean {
  return (
    metrics.typeComplexity.typeAnnotationCount +
      metrics.typeComplexity.typeAliasCount +
      metrics.typeComplexity.interfaceCount +
      metrics.typeComplexity.genericParameterCount +
      metrics.typeComplexity.unionTypeCount +
      metrics.typeComplexity.intersectionTypeCount +
      metrics.typeComplexity.conditionalTypeCount >
    0
  );
}

function maxFileMetric(metrics: ArchitectureFileMetrics[], key: keyof ArchitectureFileMetrics): number {
  return Math.max(
    0,
    ...metrics.map((metric) => metric[key]).filter((value): value is number => typeof value === 'number')
  );
}
