import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { Target } from '../config/schema.js';

const exec = promisify(execFile);

export class GitError extends Error {}

export interface ChangedFile {
  status: string;
  path: string;
}

export interface ResolvedTarget {
  kind: 'uncommitted' | 'branch';
  /** Commit-ish representing the reviewed state. Always a real object id. */
  snapshot: string;
  /** What snapshot is compared against. Empty tree hash if repo has no HEAD. */
  base: string;
  /** Requested base ref as written, for branch targets. */
  requestedBase?: string;
  mergeBase?: string;
  /** `<base>..<snapshot>` — what adapters are told to review. */
  range: string;
  diff: string;
  digest: string;
  files: ChangedFile[];
  bytes: number;
}

/** git's hash of the empty tree; used when the repo has no commits yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export async function git(
  repoRoot: string,
  args: string[],
  options: { maxBuffer?: number } = {},
): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd: repoRoot,
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      encoding: 'utf8',
    });

    return stdout;
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new GitError(
      `git ${args.join(' ')} failed: ${(err.stderr || err.message || '').trim()}`,
    );
  }
}

/**
 * Resolve the worktree root via git rather than looking for a literal
 * `.git/` directory — linked worktrees and submodules differ.
 */
export async function findRepoRoot(cwd: string): Promise<string> {
  const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree']))
    .trim();

  if (inside !== 'true') {
    throw new GitError('Not inside a git working tree.');
  }

  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

async function hasHead(repoRoot: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

async function isShallow(repoRoot: string): Promise<boolean> {
  const out = (await git(repoRoot, ['rev-parse', '--is-shallow-repository']))
    .trim();
  return out === 'true';
}

async function hasUnmerged(repoRoot: string): Promise<boolean> {
  const out = await git(repoRoot, ['diff', '--name-only', '--diff-filter=U']);
  return out.trim() !== '';
}

/**
 * Untracked, non-ignored files, NUL-delimited so odd filenames survive.
 * Never parse human-readable `git status`.
 */
export async function untrackedFiles(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ]);

  return out.split('\0').filter((entry) => entry !== '');
}

/**
 * Capture the current working state as a real commit without touching the
 * working tree or the user's index.
 *
 * The scratch index is populated directly from the worktree so paths that
 * exist only in the user's index (staged additions, rename destinations, and
 * intent-to-add entries) are still captured with their current worktree
 * content. The scratch index is a temp file; the user's own index is never
 * written.
 */
async function snapshotUncommitted(
  repoRoot: string,
  exclude: string[],
): Promise<{ snapshot: string; base: string }> {
  const head = (await hasHead(repoRoot))
    ? (await git(repoRoot, ['rev-parse', 'HEAD'])).trim()
    : null;

  const base = head ?? EMPTY_TREE;

  // Build a tree from the working tree using a throwaway index.
  //
  // The path must come from git, not from assuming `<root>/.git` is a
  // directory: in a linked worktree `.git` is a FILE pointing elsewhere, and
  // `read-tree` cannot create an index inside it.
  const gitDir = (
    await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-path', 'crbuddy'])
  ).trim();

  const indexFile = `${gitDir}-index-${process.pid}-${Date.now()}`;

  const withIndex = async (args: string[]): Promise<string> => {
    try {
      const { stdout } = await exec('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_INDEX_FILE: indexFile },
      });
      return stdout;
    } catch (error) {
      const err = error as { stderr?: string; message?: string };
      throw new GitError(
        `git ${args.join(' ')} failed: ${(err.stderr || err.message || '').trim()}`,
      );
    }
  };

  try {
    if (head) {
      await withIndex(['read-tree', 'HEAD']);
    } else {
      await withIndex(['read-tree', '--empty']);
    }

    // Classify every worktree path relative to the scratch index. Asking the
    // user's index for untracked paths would hide staged additions because
    // they are already tracked there but absent from this HEAD-based index.
    // `add -A` also captures deletions and continues to honor standard ignore
    // rules for paths that are genuinely untracked.
    await withIndex(['add', '-A', '--', '.']);

    // Drop excluded paths that were tracked.
    for (const file of exclude) {
      try {
        await withIndex([
          'rm',
          '--cached',
          '--ignore-unmatch',
          '-r',
          '-q',
          '--',
          file.endsWith('/') ? file.slice(0, -1) : file,
        ]);
      } catch {
        // Nothing staged under that path; fine.
      }
    }

    const tree = (await withIndex(['write-tree'])).trim();

    const parentArgs = head ? ['-p', head] : [];

    const { stdout: commit } = await exec(
      'git',
      ['commit-tree', tree, ...parentArgs, '-m', 'crbuddy snapshot'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_INDEX_FILE: indexFile,
          GIT_AUTHOR_NAME: 'crbuddy',
          GIT_AUTHOR_EMAIL: 'crbuddy@localhost',
          GIT_COMMITTER_NAME: 'crbuddy',
          GIT_COMMITTER_EMAIL: 'crbuddy@localhost',
        },
      },
    );

    return { snapshot: commit.trim(), base };
  } finally {
    // Node's own removal, not the `rm` executable: Windows has no `rm`, so
    // shelling out leaked a temporary index on every single run there.
    await rm(path.resolve(repoRoot, indexFile), { force: true }).catch(() => {});
  }
}

/**
 * Seal the checkout bytes that a whole-checkout review is about.
 *
 * A branch target normally points at HEAD, but the general-purpose agents
 * used for a whole-checkout fallback read the live worktree. Reusing the
 * uncommitted snapshot builder keeps the report's provenance honest without
 * touching the user's index or worktree.
 */
export async function captureCheckoutSnapshot(
  repoRoot: string,
  options: { exclude?: string[] } = {},
): Promise<string> {
  if (await hasUnmerged(repoRoot)) {
    throw new GitError(
      'The working tree has unresolved merge conflicts. ' +
        'Resolve them before running a review; "review my changes" is ambiguous mid-conflict.',
    );
  }

  return (await snapshotUncommitted(repoRoot, options.exclude ?? [])).snapshot;
}

/** An exclude entry ending in "/" excludes everything beneath it. */
export function isExcluded(file: string, exclude: string[]): boolean {
  return exclude.some((entry) =>
    entry.endsWith('/') ? file.startsWith(entry) : file === entry,
  );
}

export async function resolveTarget(
  repoRoot: string,
  target: Target,
  options: { exclude?: string[] } = {},
): Promise<ResolvedTarget> {
  const exclude = options.exclude ?? [];

  if (await hasUnmerged(repoRoot)) {
    throw new GitError(
      'The working tree has unresolved merge conflicts. ' +
        'Resolve them before running a review; "review my changes" is ambiguous mid-conflict.',
    );
  }

  if (target === 'uncommitted') {
    const { snapshot, base } = await snapshotUncommitted(repoRoot, exclude);
    return finish(repoRoot, 'uncommitted', base, snapshot, exclude, {});
  }

  const requestedBase = target.base;

  if (!(await hasHead(repoRoot))) {
    throw new GitError(
      `Branch target requested but this repository has no commits yet.`,
    );
  }

  let baseOid: string;

  try {
    baseOid = (
      await git(repoRoot, ['rev-parse', '--verify', `${requestedBase}^{commit}`])
    ).trim();
  } catch {
    throw new GitError(`Cannot resolve base ref "${requestedBase}".`);
  }

  const head = (await git(repoRoot, ['rev-parse', 'HEAD'])).trim();

  let mergeBase: string;

  try {
    mergeBase = (await git(repoRoot, ['merge-base', baseOid, head])).trim();
  } catch {
    const shallow = await isShallow(repoRoot);

    throw new GitError(
      shallow
        ? `Required merge-base between "${requestedBase}" and HEAD is unavailable locally ` +
          `(shallow clone). Fetch more history; crbuddy will not fetch for you.`
        : `No merge-base between "${requestedBase}" and HEAD.`,
    );
  }

  return finish(repoRoot, 'branch', mergeBase, head, exclude, {
    requestedBase,
    mergeBase,
  });
}

async function finish(
  repoRoot: string,
  kind: 'uncommitted' | 'branch',
  base: string,
  snapshot: string,
  exclude: string[],
  extra: { requestedBase?: string; mergeBase?: string },
): Promise<ResolvedTarget> {
  const pathspec =
    exclude.length > 0
      ? [
          '--',
          '.',
          ...exclude.map((f) =>
            f.endsWith('/') ? `:(exclude)${f}**` : `:(exclude)${f}`,
          ),
        ]
      : [];

  const nameStatus = await git(repoRoot, [
    'diff',
    '--name-status',
    '-z',
    '--no-color',
    base,
    snapshot,
    ...pathspec,
  ]);

  const files = parseNameStatusZ(nameStatus);

  const diff = await git(repoRoot, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--ignore-submodules=dirty',
    base,
    snapshot,
    ...pathspec,
  ]);

  const digest = createHash('sha256').update(diff).digest('hex').slice(0, 16);

  const resolved: ResolvedTarget = {
    kind,
    snapshot,
    base,
    range: `${base}..${snapshot}`,
    diff,
    digest,
    files,
    bytes: Buffer.byteLength(diff, 'utf8'),
  };

  if (extra.requestedBase) resolved.requestedBase = extra.requestedBase;
  if (extra.mergeBase) resolved.mergeBase = extra.mergeBase;

  return resolved;
}

/**
 * `--name-status -z` emits STATUS\0PATH\0, and for renames/copies
 * STATUS\0OLD\0NEW\0.
 */
export function parseNameStatusZ(input: string): ChangedFile[] {
  const parts = input.split('\0').filter((part) => part !== '');
  const files: ChangedFile[] = [];

  for (let i = 0; i < parts.length; ) {
    const status = parts[i]!;
    i += 1;

    if (/^[RC]/.test(status)) {
      const from = parts[i];
      const to = parts[i + 1];
      i += 2;

      if (to !== undefined) {
        files.push({ status, path: `${from} -> ${to}` });
      }
      continue;
    }

    const file = parts[i];
    i += 1;

    if (file !== undefined) {
      files.push({ status, path: file });
    }
  }

  return files;
}
