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
        if (!source.startsWith('.')) {
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
    // Java imports are dotted class paths without a leading dot; other absolute sources are external.
    return fromFile.endsWith('.java') ? resolveJavaImport(source, javaFileIndex) : undefined;
  }
  const bases = localImportBases(fromFile, source);
  const stems = bases.flatMap((base) => {
    const extension = path.extname(base);
    return extension ? [base.slice(0, -extension.length), base] : [base];
  });
  for (const stem of stems) {
    for (const candidate of [
      `${stem}.ts`,
      `${stem}.tsx`,
      `${stem}.js`,
      `${stem}.jsx`,
      `${stem}.py`,
      `${stem}.rb`,
      `${stem}.h`,
      `${stem}.hpp`,
      `${stem}.hh`,
      `${stem}.hxx`,
      `${stem}.c`,
      `${stem}.cpp`,
      `${stem}.cc`,
      `${stem}.cxx`,
      path.join(stem, 'index.ts'),
      path.join(stem, 'index.tsx'),
      path.join(stem, 'index.js'),
      path.join(stem, '__init__.py'),
    ]) {
      if (fileSet.has(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
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
  const segments = source.split('.');
  for (const candidateSegments of [segments, segments.slice(0, -1)]) {
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
  const visited = new Set<string>();
  const pending = [...(graph.get(file) ?? [])];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    pending.push(...(graph.get(current) ?? []));
  }
  return visited.size;
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
  return declaration.name.length >= duplicateSymbolNameLengthThreshold;
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
