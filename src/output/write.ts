import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Output handling (DESIGN.md §6).
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

export interface StashedOutputs {
  restore(): Promise<void>;
  discard(): Promise<void>;
  /** Paths that existed and were moved out of the way. */
  moved: string[];
}

export async function stashExistingOutputs(
  repoRoot: string,
  workDir: string,
  relativePaths: string[],
  runId: string,
): Promise<StashedOutputs> {
  // Per-run, not shared. A hard stop mid-run used to leave files in a
  // common `previous/` directory; the next run would stash nothing, then on
  // total failure delete that directory wholesale — taking the stranded
  // prior report with it.
  const holding = path.join(workDir, 'previous', runId);
  await mkdir(holding, { recursive: true });

  const moved: Array<{ from: string; to: string; relative: string }> = [];

  for (const relative of relativePaths) {
    const from = path.join(repoRoot, relative);

    if (!existsSync(from)) continue;

    const to = path.join(holding, relative.replace(/[\\/]/g, '__'));

    await rename(from, to);
    moved.push({ from, to, relative });
  }

  return {
    moved: moved.map((entry) => entry.relative),

    async restore() {
      for (const entry of moved) {
        await mkdir(path.dirname(entry.from), { recursive: true });
        await rename(entry.to, entry.from).catch(() => {});
      }

      await rm(holding, { recursive: true, force: true }).catch(() => {});
    },

    async discard() {
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
): Promise<string[]> {
  const staged: Array<{ temp: string; final: string }> = [];

  for (const file of files) {
    const final = path.join(repoRoot, file.relative);
    const temp = `${final}.crbuddy-tmp-${process.pid}`;

    await mkdir(path.dirname(final), { recursive: true });
    await writeFile(temp, file.content, 'utf8');

    staged.push({ temp, final });
  }

  const written: string[] = [];

  try {
    for (const entry of staged) {
      await rename(entry.temp, entry.final);
      written.push(entry.final);
    }
  } catch (error) {
    for (const entry of staged) {
      await rm(entry.temp, { force: true }).catch(() => {});
    }
    throw error;
  }

  return written;
}

/**
 * Recover outputs stranded in a holding directory by a crashed run, and
 * clear the debris. Called before a new run stashes anything of its own.
 */
export async function recoverStrandedOutputs(
  repoRoot: string,
  workDir: string,
): Promise<string[]> {
  const root = path.join(workDir, 'previous');
  const recovered: string[] = [];

  let batches: string[];

  try {
    const { readdir } = await import('node:fs/promises');
    batches = await readdir(root);
  } catch {
    return recovered;
  }

  for (const batch of batches) {
    const dir = path.join(root, batch);

    try {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(dir);

      for (const stored of files) {
        const relative = stored.replace(/__/g, path.sep);
        const destination = path.join(repoRoot, relative);

        // Never clobber a file that is already back in place.
        if (!existsSync(destination)) {
          await mkdir(path.dirname(destination), { recursive: true });
          await rename(path.join(dir, stored), destination);
          recovered.push(relative);
        }
      }
    } catch {
      // Unreadable batch; the cleanup below still removes it.
    }

    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  return recovered;
}

/** Sweep temp litter left by a crashed run. */
export async function cleanupTemps(repoRoot: string, relativePaths: string[]): Promise<void> {
  for (const relative of relativePaths) {
    const dir = path.dirname(path.join(repoRoot, relative));
    const base = path.basename(relative);

    try {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(dir);

      for (const entry of entries) {
        if (entry.startsWith(`${base}.crbuddy-tmp-`)) {
          await rm(path.join(dir, entry), { force: true }).catch(() => {});
        }
      }
    } catch {
      // Directory may not exist yet.
    }
  }
}
