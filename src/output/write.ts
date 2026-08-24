import { constants as fsConstants, existsSync } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalOutputPath } from '../config/load.js';

/**
 * Output handling (DESIGN.md §6).
 *
 * Everything volatile lives OUTSIDE the repository. Stashing the previous
 * report into `<repo>/.crbuddy/` moved it out of the diff but left it on
 * disk under the tree the reviewers are reading, which is not blindness -
 * and a whole-checkout run, pointed at the tree with no pathspec at all,
 * made that plain.
 *
 * Two problems solved here, and they pull against each other:
 *
 *  1. crbuddy's own output is an uncommitted file, so the next run would
 *     review the previous run's review. Excluding it from the diff is not
 *     enough — agents read the repo freely and can open it, which also
 *     breaks blindness.
 *
 *  2. A failed panel must not destroy the previous review.
 *
 * So prior outputs are MOVED ASIDE for the duration of the run, then either
 * replaced by new output on success or restored on total failure. Nothing is
 * deleted on the assumption that a replacement is coming.
 */

/** Sidecar recording which stashed file came from which path. */
const MANIFEST = 'manifest.json';

/**
 * `rename` cannot cross a filesystem, and an absolute output path is allowed
 * to sit on another drive entirely. Stashing such a report into the
 * repository's holding directory raises EXDEV, which would otherwise mean a
 * configuration crbuddy explicitly supports can never start a second review.
 *
 * Copy-then-delete is not atomic, but this is the recovery path for an
 * already-written artifact, not the commit path: the copy is verified by
 * `rename` succeeding or by the copy completing before the original goes.
 */
export async function moveFile(
  from: string,
  to: string,
  operations: { rename?: typeof rename } = {},
): Promise<void> {
  try {
    await (operations.rename ?? rename)(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;

    if ((await lstat(from)).isSymbolicLink()) {
      const target = await readlink(from);

      // Configured outputs name files, so Windows needs the `file` link
      // type. Preserve the target text verbatim: a relative link will be
      // temporarily dangling in the holding directory, then regain its
      // original meaning when restored to the output path.
      await symlink(target, to, process.platform === 'win32' ? 'file' : undefined);
      await unlink(from);
      return;
    }

    await copyFile(from, to);
    await unlink(from);
  }
}

/**
 * Put a stashed entry back only if its destination is still absent. `rename`
 * replaces an existing file on POSIX, which is wrong after an editor or
 * another process has recreated the report path during a long review.
 */
async function restoreFileNoClobber(from: string, to: string): Promise<void> {
  const source = await lstat(from);

  if (source.isSymbolicLink()) {
    const target = await readlink(from);

    // Creating the link is atomic with respect to destination existence.
    await symlink(target, to, process.platform === 'win32' ? 'file' : undefined);
    await unlink(from).catch(() => {});
    return;
  }

  try {
    // A hard link is an atomic, no-clobber move in two steps on one volume.
    await link(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;

    if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP'].includes(code ?? '')) {
      throw error;
    }

    // Cross-volume and filesystems without hard links still get atomic
    // destination exclusion, even though the copy itself is not a rename.
    await copyFile(from, to, fsConstants.COPYFILE_EXCL);
  }

  // Once the destination exists with the complete bytes, leftover holding
  // debris is recoverable and harmless; never undo the successful restore
  // merely because source cleanup failed.
  await unlink(from).catch(() => {});
}

export interface StashedOutputs {
  /** Paths still sitting in the holding directory, if any move back failed. */
  restore(): Promise<string[]>;
  discard(): Promise<void>;
  /** Paths that existed and were moved out of the way. */
  moved: string[];
}

interface StashOperations {
  moveFile?: (from: string, to: string) => Promise<void>;
  writeManifest?: (file: string, content: string) => Promise<void>;
  /** Canonical destinations approved before any output mutation. */
  allowedPaths?: string[];
}

export async function stashExistingOutputs(
  repoRoot: string,
  stateDir: string,
  relativePaths: string[],
  runId: string,
  operations: StashOperations = {},
): Promise<StashedOutputs> {
  // Per-run, not shared. A hard stop mid-run used to leave files in a
  // common `previous/` directory; the next run would stash nothing, then on
  // total failure delete that directory wholesale — taking the stranded
  // prior report with it.
  const previous = path.join(stateDir, 'previous');
  const holding = path.join(previous, runId);
  await mkdir(previous, { recursive: true });
  await mkdir(holding);
  const allowed = operations.allowedPaths
    ? new Set(operations.allowedPaths.map((entry) => path.resolve(repoRoot, entry)))
    : null;

  const planned: Array<{ from: string; to: string; relative: string }> = [];

  for (const [index, relative] of relativePaths.entries()) {
    const from = canonicalOutputPath(repoRoot, relative);

    if (allowed && !allowed.has(from)) {
      await rm(holding, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Output path changed after preflight: ${relative}`);
    }

    if (!existsSync(from)) continue;

    // Opaque, positional names plus a sidecar manifest. Encoding the path
    // into the filename (separators as `__`) is not reversible: a legitimate
    // output called `review__previous.md` decodes back as `review/previous.md`.
    const to = path.join(holding, `${index}.stashed`);

    planned.push({ from, to, relative });
  }

  const manifest = path.join(holding, MANIFEST);
  const manifestContent = JSON.stringify(
    planned.map((entry) => ({
      stored: path.basename(entry.to),
      relative: entry.relative,
    })),
  );
  const move = operations.moveFile ?? moveFile;
  const writeManifest =
    operations.writeManifest ??
    ((file: string, content: string) => writeFile(file, content, 'utf8'));

  // Recovery metadata lands before the first output moves. If manifest
  // creation fails, every report is still in its original location.
  try {
    await writeManifest(manifest, manifestContent);
  } catch (error) {
    await rm(holding, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  const moved: typeof planned = [];

  try {
    for (const entry of planned) {
      await move(entry.from, entry.to);
      moved.push(entry);
    }
  } catch (error) {
    const stranded: typeof moved = [];

    // A returned handle cannot restore a stash that never finished, so roll
    // back here. If rollback itself fails, the already-written manifest lets
    // the next run recover precisely the entries still in the holding dir.
    for (const entry of [...moved].reverse()) {
      try {
        await mkdir(path.dirname(entry.from), { recursive: true });
        await move(entry.to, entry.from);
      } catch {
        stranded.push(entry);
      }
    }

    if (stranded.length === 0) {
      await rm(holding, { recursive: true, force: true }).catch(() => {});
    }

    throw error;
  }

  // Restore is retryable for entries that genuinely remain stranded, but a
  // successfully restored entry is retired immediately. Calling restore a
  // second time must not report its now-absent holding path as a new failure.
  let pending = [...moved];

  return {
    moved: moved.map((entry) => entry.relative),

    async restore() {
      const stranded: string[] = [];
      const stillPending: typeof pending = [];

      for (const entry of pending) {
        try {
          // A review can run for an hour. If a parent directory was replaced
          // by a symlink during that time, do not restore through its new
          // destination; keep the only copy in the holding directory.
          if (canonicalOutputPath(repoRoot, entry.from) !== entry.from) {
            throw new Error('output path changed while reviewers were running');
          }

          await mkdir(path.dirname(entry.from), { recursive: true });
          await restoreFileNoClobber(entry.to, entry.from);
        } catch {
          stranded.push(entry.to);
          stillPending.push(entry);
        }
      }

      pending = stillPending;

      // The holding directory is deleted only when everything made it back.
      // Since the state directory moved out of the repository, this is a
      // cross-filesystem copy wherever the repo and $HOME differ, and
      // swallowing the failure then deleting the source destroyed the only
      // copy of the previous report while reporting success.
      if (stranded.length > 0) return stranded;

      await rm(holding, { recursive: true, force: true }).catch(() => {});

      return [];
    },

    async discard() {
      pending = [];
      await rm(holding, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Stage on the DESTINATION filesystem, not the OS temp dir: a
 * cross-filesystem rename is not atomic and may not be a rename at all.
 *
 * Two renames are not one transaction, so the raw file lands first and the
 * merged file — written second — names the raw file's runId. A mismatch is
 * therefore detectable rather than silent.
 */
export async function commitOutputs(
  repoRoot: string,
  files: Array<{ relative: string; content: string }>,
  options: { allowedPaths?: string[] } = {},
): Promise<string[]> {
  const staged: Array<{ temp: string; final: string }> = [];
  const allowed = options.allowedPaths
    ? new Set(options.allowedPaths.map((entry) => path.resolve(repoRoot, entry)))
    : null;

  for (const file of files) {
    const final = canonicalOutputPath(repoRoot, file.relative);

    if (allowed && !allowed.has(final)) {
      throw new Error(`Output path changed after preflight: ${file.relative}`);
    }

    const temp = `${final}.crbuddy-tmp-${process.pid}`;

    await mkdir(path.dirname(final), { recursive: true });
    await writeFile(temp, file.content, 'utf8');

    staged.push({ temp, final });
  }

  const written: Array<{ temp: string; final: string }> = [];

  try {
    for (const entry of staged) {
      await rename(entry.temp, entry.final);
      written.push(entry);
    }
  } catch (error) {
    // Roll back the renames that already landed, so the destination returns
    // to its pre-commit state. Otherwise a half-committed pair is left
    // behind and the caller's restore() renames the OLD file over a NEW one
    // — losing the old copy and leaving merged/raw from different runs.
    for (const entry of written.reverse()) {
      await rename(entry.final, entry.temp).catch(() => {});
    }

    for (const entry of staged) {
      await rm(entry.temp, { force: true }).catch(() => {});
    }

    throw error;
  }

  return written.map((entry) => entry.final);
}

/**
 * Recover outputs stranded in a holding directory by a crashed run, and
 * clear the debris. Called before a new run stashes anything of its own.
 */
export async function recoverStrandedOutputs(
  repoRoot: string,
  stateDir: string,
  options: { allowedPaths?: string[] } = {},
): Promise<string[]> {
  const root = path.join(stateDir, 'previous');
  const recovered: string[] = [];
  const allowed = options.allowedPaths
    ? new Set(options.allowedPaths.map((entry) => path.resolve(repoRoot, entry)))
    : null;

  let batches: string[];

  try {
    batches = await readdir(root);
  } catch {
    return recovered;
  }

  for (const batch of batches) {
    const dir = path.join(root, batch);

    try {
      const parsed: unknown = JSON.parse(
        await readFile(path.join(dir, MANIFEST), 'utf8'),
      );

      if (!Array.isArray(parsed)) throw new Error('invalid recovery manifest');

      const manifest = parsed.map((value) => {
        if (typeof value !== 'object' || value === null) {
          throw new Error('invalid recovery entry');
        }

        const { stored, relative } = value as Record<string, unknown>;

        // `stored` is generated as a basename. Refusing separators here keeps
        // an edited manifest from turning the holding directory into an
        // arbitrary source-file selector.
        if (
          typeof stored !== 'string' ||
          stored === '' ||
          stored === '.' ||
          stored === '..' ||
          path.basename(stored) !== stored ||
          typeof relative !== 'string'
        ) {
          throw new Error('invalid recovery entry');
        }

        const destination = canonicalOutputPath(repoRoot, relative);

        // Repository-local state is legacy and can arrive in a clone. Its
        // manifest is therefore untrusted: validate the ENTIRE batch against
        // the currently configured output paths before moving even one file.
        if (allowed && !allowed.has(destination)) {
          throw new Error('recovery destination is not configured');
        }

        return {
          relative,
          destination,
          source: path.join(dir, stored),
        };
      });

      for (const entry of manifest) {
        // Never clobber a file that is already back in place.
        if (existsSync(entry.source) && !existsSync(entry.destination)) {
          await mkdir(path.dirname(entry.destination), { recursive: true });
          await moveFile(entry.source, entry.destination);
          recovered.push(entry.relative);
        }
      }
    } catch {
      // Unreadable, invalid, or disallowed manifest: leave the batch alone
      // rather than guess at filenames. The debris is inert; a wrong guess
      // is not.
      continue;
    }

    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return recovered;
}

/** Sweep temp litter left by a crashed run. */
export async function cleanupTemps(
  repoRoot: string,
  relativePaths: string[],
  options: { allowedPaths?: string[] } = {},
): Promise<void> {
  const allowed = options.allowedPaths
    ? new Set(options.allowedPaths.map((entry) => path.resolve(repoRoot, entry)))
    : null;

  for (const relative of relativePaths) {
    const expected = path.resolve(repoRoot, relative);
    const destination = canonicalOutputPath(repoRoot, relative);

    if (allowed && (!allowed.has(expected) || destination !== expected)) {
      throw new Error(`Output path changed after preflight: ${relative}`);
    }

    const dir = path.dirname(destination);
    const base = path.basename(destination);

    try {
      const entries = await readdir(dir);

      for (const entry of entries) {
        if (entry.startsWith(`${base}.crbuddy-tmp-`)) {
          // Recheck immediately before mutation. Reading a redirected
          // directory is harmless; deleting from it is not.
          if (allowed && canonicalOutputPath(repoRoot, expected) !== expected) {
            throw new Error(`Output path changed after preflight: ${relative}`);
          }

          await rm(path.join(dir, entry), { force: true }).catch(() => {});
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;

      // A destination directory may legitimately not exist on the first run.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }
}
