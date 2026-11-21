import { execFile, spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Large enough for whole-file blobs; execFile's 1 MiB default truncates real sources. */
const maxOutputBytes = 512 * 1024 * 1024;

/** The head side of one region of a line diff: lines [headStart, headStart + headCount); a pure deletion has headCount 0. */
export interface LineHunk {
  headStart: number;
  headCount: number;
  /** The base lines the hunk deletes or replaces, from line `baseStart` of the base file on. */
  deletedLines?: readonly string[];
  baseStart?: number;
  /** Whether a deleted line is a `code-gauge-allow` directive; set by the check. */
  deletesDirective?: boolean;
}

/** One entry of the working tree's diff against the merge-base commit. */
export interface ChangedFile {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Path at the merge-base, absent for added files; differs from headPath only for renames. */
  basePath?: string;
  /** Path in the working tree; for deleted files, the (now missing) base path. */
  headPath: string;
}

export async function resolveRepoRoot(directory: string): Promise<string> {
  const output = await runGit(directory, ['rev-parse', '--show-toplevel']);
  return output.trim();
}

/** Whether git ignores the path or a directory above it (`git check-ignore` exits 1 otherwise). */
export async function isIgnored(repoRoot: string, path: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['check-ignore', '--quiet', '--', path], { cwd: repoRoot });
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

export async function resolveMergeBase(repoRoot: string, baseRef: string): Promise<string> {
  const output = await runGit(repoRoot, ['merge-base', baseRef, 'HEAD']);
  return output.trim();
}

/**
 * Files whose working-tree content differs from the merge-base commit (staged or not), with
 * rename detection, plus untracked (non-ignored) files as additions.
 */
export async function listChangedFiles(repoRoot: string, mergeBase: string): Promise<ChangedFile[]> {
  const [diffOutput, untrackedOutput] = await Promise.all([
    runGit(repoRoot, ['diff', '--name-status', '--find-renames', '-z', mergeBase]),
    runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);

  const files = parseNameStatusEntries(diffOutput);
  for (const path of untrackedOutput.split('\0')) {
    if (path !== '') {
      files.push({ status: 'added', headPath: path });
    }
  }
  return files;
}

/** Parses `git diff --name-status -z` output: `<status>\0<path>\0`, with two paths for R/C. */
function parseNameStatusEntries(output: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const parts = output.split('\0');
  let index = 0;
  while (index < parts.length - 1) {
    const kind = (parts[index] as string).charAt(0);
    const pathCount = kind === 'R' || kind === 'C' ? 2 : 1;
    const changed = toChangedFile(kind, parts.slice(index + 1, index + 1 + pathCount));
    if (changed) {
      files.push(changed);
    }
    index += 1 + pathCount;
  }
  return files;
}

/** Undefined for unmerged (U) and unknown statuses, which have nothing to check. */
function toChangedFile(kind: string, paths: (string | undefined)[]): ChangedFile | undefined {
  const [first, second] = paths;
  if (first === undefined) {
    return undefined;
  }
  switch (kind) {
    case 'R': {
      return second === undefined ? undefined : { status: 'renamed', basePath: first, headPath: second };
    }
    // A copy is an addition: every line of the new path is new.
    case 'C': {
      return second === undefined ? undefined : { status: 'added', headPath: second };
    }
    case 'A': {
      return { status: 'added', headPath: first };
    }
    case 'D': {
      return { status: 'deleted', basePath: first, headPath: first };
    }
    case 'M':
    case 'T': {
      return { status: 'modified', basePath: first, headPath: first };
    }
    default: {
      return undefined;
    }
  }
}

/**
 * Repository-relative paths git considers part of the project AND that exist in the working tree:
 * tracked files (minus worktree deletions) plus untracked non-ignored ones. `check` scans
 * exactly these, so local ignored artifacts (build output, generated copies) are neither measured
 * nor allowed to skew duplication detection.
 */
export async function listRepositoryFiles(
  repoRoot: string
): Promise<{ files: Set<string>; warnings: string[]; sparse: boolean }> {
  const [{ stdout: listed, stderr }, deleted, sparseCheckout] = await Promise.all([
    // -t tags each path; `S` marks a skip-worktree path, which a sparse checkout leaves off disk.
    runGitWithStderr(repoRoot, ['ls-files', '-t', '--cached', '--others', '--exclude-standard', '-z']),
    runGit(repoRoot, ['ls-files', '--deleted', '-z']),
    // Whatever the working tree holds, a sparse checkout may leave part of the project out.
    isSparseCheckout(repoRoot),
  ]);
  const entries = listed.split('\0').filter((entry) => entry !== '');
  const files = new Set(entries.map((entry) => entry.slice(2)));
  // Git lists as deleted a path it cannot reach, and a skip-worktree path may still be on disk (a
  // file marked to ignore local edits): only a path that does not exist leaves the working tree,
  // so an inaccessible one stays to be reported as unmeasured.
  const skipWorktree = new Set(entries.filter((entry) => entry.startsWith('S ')).map((entry) => entry.slice(2)));
  const candidates = [...deleted.split('\0').filter((entry) => entry !== ''), ...skipWorktree];
  for (const relativePath of await listAbsentPaths(repoRoot, candidates)) {
    files.delete(relativePath);
  }
  // Git tracks no path through a symbolic link, yet a tracked path below a directory replaced by
  // one still resolves through it, and `--deleted` does not list it.
  for (const directory of await listSymbolicLinkDirectories(repoRoot, files)) {
    for (const file of files) {
      if (file.startsWith(`${directory}/`)) {
        files.delete(file);
      }
    }
  }
  // Git skips what it cannot list (an untracked directory it cannot open) with a warning: those
  // files are not git-visible, so the check passes the warning on instead of measuring them.
  // Verbatim as one block: a pathname git names in it may hold line breaks.
  const warnings = stderr === '' ? [] : [stderr.replace(/\n$/u, '')];
  return { files, warnings, sparse: sparseCheckout };
}

/**
 * The line hunks turning the merge-base blob at `basePath` into the working-tree file at
 * `headPath` (equal unless renamed), as `git diff` computes them for review.
 */
export async function listLineHunks(
  repoRoot: string,
  mergeBase: string,
  basePath: string,
  headPath: string
): Promise<LineHunk[]> {
  // Literal pathspecs: a name like `app/[slug]/page.tsx` must not glob-match other files.
  const paths = (basePath === headPath ? [headPath] : [basePath, headPath]).map((file) => `:(literal)${file}`);
  const output = await runGit(repoRoot, [
    // The algorithm and indent heuristic decide which lines count as added, so user config must
    // not change them; `-c` values an older git does not know are ignored rather than rejected.
    '-c',
    'diff.algorithm=myers',
    '-c',
    'diff.indentHeuristic=true',
    'diff',
    '--unified=0',
    // diff.interHunkContext would otherwise merge nearby hunks, and the unchanged lines between
    // them would count as added.
    '--inter-hunk-context=0',
    // A file git would show as binary (a `-diff` attribute, a NUL byte) must still yield hunks.
    '--text',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames',
    mergeBase,
    '--',
    ...paths,
  ]);
  const headers = [...output.matchAll(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,(\d+))? @@.*$/gmu)];
  return headers.map((match, index) => {
    const [header, baseStart, headStart, headCount] = match;
    const body = output.slice(match.index + header.length, headers[index + 1]?.index ?? output.length);
    return {
      headStart: Number(headStart),
      headCount: headCount === undefined ? 1 : Number(headCount),
      baseStart: Number(baseStart),
      deletedLines: body
        .split('\n')
        .filter((line) => line.startsWith('-'))
        // A CRLF file's lines keep their carriage return after splitting the diff on line feeds.
        .map((line) => line.slice(1).replace(/\r$/u, '')),
    };
  });
}

/** The content of a file at a commit. */
export async function readFileAt(repoRoot: string, commit: string, file: string): Promise<string> {
  return await runGit(repoRoot, ['show', `${commit}:${file}`]);
}

/** A file's `linguist-generated` / `linguist-vendored` attributes; undefined when unspecified. */
export interface LinguistAttributes {
  generated?: boolean;
  vendored?: boolean;
}

/**
 * The linguist attributes of repository-relative paths, from the working tree's `.gitattributes`.
 * Paths with neither attribute specified are omitted.
 */
export async function readLinguistAttributes(
  repoRoot: string,
  paths: Iterable<string>
): Promise<Map<string, LinguistAttributes>> {
  const input = [...paths].join('\0');
  if (input === '') {
    return new Map();
  }
  const output = await runGitWithInput(
    repoRoot,
    ['check-attr', '--stdin', '-z', 'linguist-generated', 'linguist-vendored'],
    input
  );
  const attributesByPath = new Map<string, LinguistAttributes>();
  const fields = output.split('\0');
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const [file, attribute, value] = fields.slice(index, index + 3) as [string, string, string];
    const enabled = toAttributeFlag(value);
    if (enabled === undefined) {
      continue;
    }
    const attributes = attributesByPath.get(file) ?? {};
    if (attribute === 'linguist-generated') {
      attributes.generated = enabled;
    } else {
      attributes.vendored = enabled;
    }
    attributesByPath.set(file, attributes);
  }
  return attributesByPath;
}

/** Linguist reads `attr`/`attr=true` as set and `-attr`/`attr=false` as explicitly unset. */
function toAttributeFlag(value: string): boolean | undefined {
  if (value === 'set' || value === 'true') {
    return true;
  }
  if (value === 'unset' || value === 'false') {
    return false;
  }
  return undefined;
}

async function runGitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    // git exiting before it reads all input (e.g. on a usage error) makes the write fail with
    // EPIPE; its exit code and stderr, reported on close, already describe the failure.
    child.stdin.on('error', () => {});
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
        return;
      }
      const message = Buffer.concat(stderr).toString('utf8').trim();
      reject(new Error(`git ${describeCommand(args)} failed${message ? `: ${message}` : ''}`));
    });
    child.stdin.end(input);
  });
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await runGitWithStderr(cwd, args);
  return stdout;
}

async function runGitWithStderr(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync('git', args, { cwd, maxBuffer: maxOutputBytes, encoding: 'utf8' });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${describeCommand(args)} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

/** The subcommand and its first argument, skipping leading `-c key=value` overrides. */
function describeCommand(args: readonly string[]): string {
  let start = 0;
  while (args[start] === '-c') {
    start += 2;
  }
  return args.slice(start, start + 2).join(' ');
}

/** A path that cannot be inspected is not absent: it stays to be reported as unmeasured. */
/** Whether sparse checkout is enabled; `--type` and `--default` would need Git 2.18. */
async function isSparseCheckout(repoRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--bool', '--get', 'core.sparseCheckout'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return stdout.trim() === 'true';
  } catch (error) {
    // Exit status 1: the key is not set.
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

/**
 * The paths that do not exist, probing a path below a directory already found missing no further
 * and each directory at most once, so the paths a sparse checkout or a deletion leaves out cost one
 * probe per missing directory, not per file.
 */
async function listAbsentPaths(repoRoot: string, relativePaths: readonly string[]): Promise<string[]> {
  const absentDirectories = new Set<string>();
  const presentDirectories = new Set<string>();
  const isBelowAbsent = (relativePath: string): boolean => {
    for (
      let directory = path.posix.dirname(relativePath);
      directory !== '.';
      directory = path.posix.dirname(directory)
    ) {
      if (absentDirectories.has(directory)) {
        return true;
      }
    }
    return false;
  };
  const absent: string[] = [];
  for (const relativePath of relativePaths) {
    if (!isBelowAbsent(relativePath) && !(await isAbsent(path.join(repoRoot, relativePath)))) {
      continue;
    }
    absent.push(relativePath);
    // Record the highest missing ancestor so the paths below it need no probe, and the present
    // directories so the paths beside it probe their parent once.
    let directory = path.posix.dirname(relativePath);
    while (
      directory !== '.' &&
      !presentDirectories.has(directory) &&
      !absentDirectories.has(directory) &&
      !isBelowAbsent(directory)
    ) {
      if (!(await isAbsent(path.join(repoRoot, directory)))) {
        presentDirectories.add(directory);
        break;
      }
      absentDirectories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  return absent;
}

async function isAbsent(file: string): Promise<boolean> {
  return await lstat(file).then(
    () => false,
    (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
  );
}

/** The directories holding listed files that are symbolic links in the working tree, each inspected once. */
async function listSymbolicLinkDirectories(repoRoot: string, files: ReadonlySet<string>): Promise<string[]> {
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.split('/');
    for (let count = 1; count < segments.length; count++) {
      directories.add(segments.slice(0, count).join('/'));
    }
  }
  const links = await Promise.all(
    [...directories].map(async (directory) => {
      const stats = await lstat(path.join(repoRoot, directory)).catch(() => {});
      return stats?.isSymbolicLink() ? [directory] : [];
    })
  );
  return links.flat();
}
