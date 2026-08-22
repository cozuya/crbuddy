import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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

/** Sidecar recording which stashed file came from which path. */
const MANIFEST = 'manifest.json';

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

  for (const [index, relative] of relativePaths.entries()) {
    const from = path.join(repoRoot, relative);

    if (!existsSync(from)) continue;

    // Opaque, positional names plus a sidecar manifest. Encoding the path
    // into the filename (separators as `__`) is not reversible: a legitimate
    // output called `review__previous.md` decodes back as `review/previous.md`.
    const to = path.join(holding, `${index}.stashed`);

    await rename(from, to);
    moved.push({ from, to, relative });
  }

  await writeFile(
    path.join(holding, MANIFEST),
    JSON.stringify(moved.map((entry) => ({ stored: path.basename(entry.to), relative: entry.relative }))),
    'utf8',
  );

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
  workDir: string,
): Promise<string[]> {
  const root = path.join(workDir, 'previous');
  const recovered: string[] = [];

  let batches: string[];

  try {
    batches = await readdir(root);
  } catch {
    return recovered;
  }

  for (const batch of batches) {
    const dir = path.join(root, batch);

    try {
      const manifest = JSON.parse(
        await readFile(path.join(dir, MANIFEST), 'utf8'),
      ) as Array<{ stored: string; relative: string }>;

      for (const entry of manifest) {
        const destination = path.join(repoRoot, entry.relative);
        const source = path.join(dir, entry.stored);

        // Never clobber a file that is already back in place.
        if (existsSync(source) && !existsSync(destination)) {
          await mkdir(path.dirname(destination), { recursive: true });
          await rename(source, destination);
          recovered.push(entry.relative);
        }
      }
    } catch {
      // No readable manifest: leave the batch alone rather than guess at
      // filenames. The debris is inert; a wrong guess is not.
      continue;
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
