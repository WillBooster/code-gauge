import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Large enough for whole-file blobs; execFile's 1 MiB default truncates real sources. */
const maxOutputBytes = 512 * 1024 * 1024;

/** The head side of one region of a line diff: lines [headStart, headStart + headCount); a pure deletion has headCount 0. */
export interface LineHunk {
  headStart: number;
  headCount: number;
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
 * tracked files (minus worktree deletions) plus untracked non-ignored ones. `check --base` scans
 * exactly these, so local ignored artifacts (build output, generated copies) are neither measured
 * nor allowed to skew duplication detection.
 */
export async function listRepositoryFiles(repoRoot: string): Promise<Set<string>> {
  const [listed, deleted] = await Promise.all([
    runGit(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']),
    runGit(repoRoot, ['ls-files', '--deleted', '-z']),
  ]);
  const files = new Set(listed.split('\0').filter((path) => path !== ''));
  for (const path of deleted.split('\0')) {
    files.delete(path);
  }
  return files;
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
  const hunks: LineHunk[] = [];
  for (const match of output.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const [, headStart, headCount] = match;
    hunks.push({
      headStart: Number(headStart),
      headCount: headCount === undefined ? 1 : Number(headCount),
    });
  }
  return hunks;
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
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: maxOutputBytes, encoding: 'utf8' });
    return stdout;
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
