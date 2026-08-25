import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Per-repository lock. Two concurrent `crbuddy go` runs otherwise race, and
 * atomic rename does not help — the slower one wins.
 *
 * mkdir is the atomic primitive: it fails if the directory exists.
 */
export class LockError extends Error {}

export interface Lock {
  release(): Promise<void>;
}

export async function acquireLock(workDir: string): Promise<Lock> {
  return acquireLockAt(path.join(workDir, 'lock'), 'in this repository');
}

/**
 * Same primitive, arbitrary location. Used for a lock that must coordinate
 * runs in DIFFERENT repositories - a per-repo lock cannot see those.
 */
export async function acquireLockAt(lockDir: string, scope: string): Promise<Lock> {
  await mkdir(path.dirname(lockDir), { recursive: true });

  try {
    await mkdir(lockDir, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;

    const holder = await readFile(path.join(lockDir, 'pid'), 'utf8').catch(
      () => 'unknown',
    );

    const pid = Number.parseInt(holder.trim(), 10);

    if (Number.isFinite(pid) && !isAlive(pid)) {
      // Stale lock from a crashed run.
      await rm(lockDir, { recursive: true, force: true });
      return acquireLockAt(lockDir, scope);
    }

    throw new LockError(
      `Another crbuddy run is already active ${scope} (pid ${holder.trim()}).\n` +
        `If that is wrong, remove ${lockDir}.`,
    );
  }

  await writeFile(path.join(lockDir, 'pid'), String(process.pid), 'utf8');

  return {
    async release() {
      await rm(lockDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
