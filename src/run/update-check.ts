import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import { HOME_CONFIG_DIR } from '../config/schema.js';
import { isNewerVersion, parseSemver } from '../util/semver.js';

/** The dist-tags document: `{"latest":"x.y.z"}` and nothing else to download. */
const REGISTRY_URL = 'https://registry.npmjs.org/-/package/crbuddy/dist-tags';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1_500;

export interface UpdateCheckOptions {
  /** This package's own version. */
  installed: string;
  env?: NodeJS.ProcessEnv;
  /** Whether a person will see the notice; it goes to stderr. */
  interactive?: boolean;
  /** Test seams. */
  cacheFile?: string;
  now?: () => number;
  timeoutMs?: number;
  fetchLatest?: (signal: AbortSignal) => Promise<string | null>;
}

export interface UpdateCheck {
  /** The notice to print, or null. Never rejects or waits past the timeout. */
  notice(): Promise<string | null>;
}

interface CacheRecord {
  checkedAt: number;
  latest: string | null;
}

export function updateCacheFile(): string {
  return path.join(homedir(), HOME_CONFIG_DIR, 'update-check.json');
}

function enabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== '' && !/^(?:0|false)$/i.test(value.trim());
}

/**
 * CI, a pipe, or an explicit opt-out: nobody to tell, so nothing is fetched.
 * The opt-outs count when set at all, as update-notifier reads its variable.
 */
export function updateCheckSuppressed(env: NodeJS.ProcessEnv, interactive: boolean): boolean {
  return (
    !interactive ||
    ['CRBUDDY_NO_UPDATE_CHECK', 'NO_UPDATE_NOTIFIER'].some((name) => env[name] !== undefined) ||
    ['CI', 'CONTINUOUS_INTEGRATION', 'BUILD_NUMBER', 'RUN_ID', 'GITHUB_ACTIONS'].some(
      (name) => enabled(env[name]),
    )
  );
}

export function formatUpdateNotice(installed: string, latest: string): string {
  return `Update available: crbuddy ${installed} → ${latest}\nRun: npm i -g crbuddy@latest`;
}

/**
 * Started with a command and read when it finishes, so the registry request
 * overlaps the command's own work. Anything that goes wrong means no notice.
 */
export function startUpdateCheck(options: UpdateCheckOptions): UpdateCheck {
  const env = options.env ?? process.env;
  const interactive = options.interactive ?? Boolean(process.stderr.isTTY);

  const none: UpdateCheck = { notice: async () => null };

  try {
    if (updateCheckSuppressed(env, interactive) || parseSemver(options.installed) === null) {
      return none;
    }
  } catch {
    return none;
  }

  const latest = resolveLatest(options).catch(() => null);

  return {
    async notice() {
      const found = await latest;
      return found !== null && isNewerVersion(found, options.installed)
        ? formatUpdateNotice(options.installed, found)
        : null;
    },
  };
}

async function resolveLatest(options: UpdateCheckOptions): Promise<string | null> {
  const file = options.cacheFile ?? updateCacheFile();
  const now = options.now ?? Date.now;
  const cached = await readCache(file);
  const started = now();

  // A time in the future is a changed clock, not a recent check.
  if (cached && cached.checkedAt <= started && started - cached.checkedAt < CHECK_INTERVAL_MS) {
    return cached.latest;
  }

  const fetched = await withTimeout(
    options.fetchLatest ?? fetchLatestFromRegistry,
    options.timeoutMs ?? TIMEOUT_MS,
  );
  // Only a valid version is kept or printed: this text came off the network.
  const latest = (fetched !== null && parseSemver(fetched) ? fetched : null) ?? cached?.latest ?? null;

  // Recorded on failure too, so an offline machine makes one short attempt a
  // day rather than one per command.
  await writeCache(file, { checkedAt: started, latest });
  return latest;
}

async function withTimeout(
  fetchLatest: (signal: AbortSignal) => Promise<string | null>,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      fetchLatest(controller.signal).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readCache(file: string): Promise<CacheRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<CacheRecord> | null;
    const checkedAt = parsed?.checkedAt;
    if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) return null;

    const latest = typeof parsed?.latest === 'string' && parseSemver(parsed.latest)
      ? parsed.latest
      : null;

    return { checkedAt, latest };
  } catch {
    return null;
  }
}

async function writeCache(file: string, record: CacheRecord): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;

  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(record)}\n`, 'utf8');
    await rename(temporary, file);
  } catch {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

/** Terminating the worker also bounds connection setup; aborting fetch does not. */
async function fetchLatestFromRegistry(signal: AbortSignal): Promise<string | null> {
  const worker = new Worker(new URL('./registry-latest.js', import.meta.url), {
    workerData: { url: REGISTRY_URL },
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  let cancel: () => void = () => {};

  try {
    return await new Promise<string | null>((resolve) => {
      cancel = () => resolve(null);
      worker.once('message', (latest: unknown) =>
        resolve(typeof latest === 'string' ? latest : null));
      worker.once('error', cancel);
      worker.once('exit', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    await worker.terminate();
  }
}
