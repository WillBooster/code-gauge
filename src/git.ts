import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Large enough for whole-file blobs; execFile's 1 MiB default truncates real sources. */
const maxOutputBytes = 512 * 1024 * 1024;

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
 * rename detection, plus untracked (non-ignored) files as additions. Copies gate like additions:
 * only the new path is measured against the new-code thresholds.
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

/** Undefined for unmerged (U) and unknown statuses, which have nothing to gate. */
function toChangedFile(kind: string, paths: (string | undefined)[]): ChangedFile | undefined {
  const [first, second] = paths;
  if (first === undefined) {
    return undefined;
  }
  switch (kind) {
    case 'R': {
      return second === undefined ? undefined : { status: 'renamed', basePath: first, headPath: second };
    }
    // A copy gates like an addition: only the new path is measured against the new-code thresholds.
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
 * Repository-relative paths git considers part of the project: tracked files plus untracked
 * non-ignored ones. The diff gate restricts its duplication universes to these so local ignored
 * artifacts (build output, generated copies) cannot skew base/head duplication counts.
 */
export async function listRepositoryFiles(repoRoot: string): Promise<Set<string>> {
  const output = await runGit(repoRoot, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  return new Set(output.split('\0').filter((path) => path !== ''));
}

/** The file's content at the given commit; the path is repository-relative with forward slashes. */
export async function readFileAtRevision(repoRoot: string, revision: string, path: string): Promise<string> {
  return await runGit(repoRoot, ['cat-file', 'blob', `${revision}:${path}`]);
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: maxOutputBytes, encoding: 'utf8' });
    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(`git ${args.slice(0, 2).join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}
