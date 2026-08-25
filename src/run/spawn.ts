import { ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import crossSpawn from 'cross-spawn';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';
import path from 'node:path';

import { stripAnsi } from '../util/ansi.js';

const isWindows = process.platform === 'win32';

/**
 * Windows installs npm-global CLIs as `.cmd` shims, and since the fix for
 * CVE-2024-27980 Node refuses to spawn `.cmd`/`.bat` without a shell. A
 * plain spawn('codex') therefore fails with ENOENT on Windows even though
 * `codex` works fine in the terminal — while a vendor that ships a native
 * `.exe` (Claude Code) is found. That asymmetry is the bug this fixes.
 *
 * cross-spawn resolves the shim through PATH/PATHEXT and, when the target
 * is a batch file, routes it through cmd.exe with correct escaping. Doing
 * that escaping by hand is precisely what the CVE was about, so it is not
 * hand-rolled here.
 */
const spawn = isWindows ? crossSpawn : nodeSpawn;

export interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: Record<string, string>;
  timeoutMs: number;
  /** Where stdout/stderr are spooled. Large outputs never sit in memory. */
  scratchDir: string;
  id: string;
  /** Optional caller cancellation, used by interactive setup probes. */
  signal?: AbortSignal;
  /** Override the termination grace period in focused process-tree tests. */
  killGraceMs?: number;
}

export interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  wallClockMs: number;
  spawnError?: string;
}

/** Every live child, so a signal handler can tear the whole panel down. */
const live = new Set<ChildProcess>();

export function killAll(signal: NodeJS.Signals = 'SIGTERM'): void {
  for (const child of live) {
    killTree(child, signal);
  }
}

/**
 * Vendor CLIs spawn children of their own (shells, MCP servers, helpers).
 * Killing the direct child orphans the rest, so signal the whole group.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;

  if (isWindows) {
    try {
      nodeSpawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      child.kill(signal);
    }
    return;
  }

  try {
    // Negative pid targets the process group created by `detached: true`.
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export async function runProcess(request: SpawnRequest): Promise<SpawnResult> {
  const started = Date.now();

  const outPath = path.join(request.scratchDir, `${request.id}.stdout`);
  const errPath = path.join(request.scratchDir, `${request.id}.stderr`);

  const outFile = createWriteStream(outPath);
  const errFile = createWriteStream(errPath);

  let child: ChildProcess;

  try {
    child = spawn(request.command, request.args, {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      // Never a shell: instruction text and paths can contain metacharacters.
      shell: false,
      // Own process group so the whole tree can be signalled at once.
      detached: !isWindows,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    outFile.close();
    errFile.close();

    await discard(outPath, errPath);

    return {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      wallClockMs: Date.now() - started,
      spawnError: String(error),
    };
  }

  live.add(child);

  let killTimer: NodeJS.Timeout | undefined;
  let terminating = false;
  const terminate = (): void => {
    if (terminating) return;

    terminating = true;

    killTree(child, 'SIGTERM');

    // Windows killTree already launches `taskkill /T /F`: it is forceful on
    // the whole tree, regardless of the signal name, so scheduling the same
    // PID again only creates a PID-reuse window after the child closes.
    if (isWindows) return;

    killTimer = setTimeout(
      () => {
        killTimer = undefined;
        killTree(child, 'SIGKILL');
      },
      request.killGraceMs ?? 5000,
    );
    killTimer.unref();
  };

  const onAbort = (): void => terminate();
  request.signal?.addEventListener('abort', onAbort, { once: true });
  if (request.signal?.aborted) terminate();

  // Drain both pipes continuously or the child backpressures and stalls.
  child.stdout?.pipe(outFile);
  child.stderr?.pipe(errFile);

  // Create these BEFORE awaiting the child. A stream can close before we
  // get around to listening, and `once()` on an event that already fired
  // never settles — which reads as a hang with no output.
  const outClosed = finished(outFile).catch(() => {});
  const errClosed = finished(errFile).catch(() => {});

  // stdin is written once and closed. A shared or inherited stdin means
  // several children compete for the terminal when one wants an approval.
  if (child.stdin) {
    child.stdin.on('error', () => {});

    if (request.stdin !== undefined) {
      child.stdin.write(request.stdin);
    }

    child.stdin.end();
  }

  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, request.timeoutMs);

  let code: number | null = null;
  let signal: NodeJS.Signals | null = null;

  try {
    const [exitCode, exitSignal] = (await once(child, 'close')) as [
      number | null,
      NodeJS.Signals | null,
    ];

    code = exitCode;
    signal = exitSignal;
  } catch (error) {
    // `events.once` attaches its own 'error' listener, so an ENOENT here is
    // a clean rejection rather than a crash — but the spool files still have
    // to go, or a failed probe litters whatever directory it ran in.
    //
    // Destroy the write streams rather than waiting for a pipe that may
    // never deliver an end event: when spawn itself failed there may be no
    // child stdout to close them, and a preflight probe that hangs is worse
    // than one that reports a missing executable.
    outFile.destroy();
    errFile.destroy();

    await settle([outClosed, errClosed]);
    await discard(outPath, errPath);

    return {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut,
      wallClockMs: Date.now() - started,
      spawnError: String(error),
    };
  } finally {
    clearTimeout(timer);

    if (killTimer) {
      // The direct child closed before its grace period elapsed. Detached
      // helpers may still be alive in the original process group, so sweep
      // them now, while the group identity is fresh, rather than leaving a
      // delayed signal that could land on a recycled process-group ID.
      clearTimeout(killTimer);
      killTimer = undefined;
      killTree(child, 'SIGKILL');
    }

    request.signal?.removeEventListener('abort', onAbort);
    live.delete(child);
  }

  await settle([outClosed, errClosed]);

  const [stdout, stderr] = await Promise.all([
    readText(outPath),
    readText(errPath),
  ]);

  await discard(outPath, errPath);

  return {
    code,
    signal,
    stdout,
    stderr,
    timedOut,
    wallClockMs: Date.now() - started,
  };
}

async function discard(...paths: string[]): Promise<void> {
  await Promise.all(paths.map((file) => unlink(file).catch(() => {})));
}

/** Await stream cleanup, but never let it become the thing that hangs. */
async function settle(waits: Array<Promise<unknown>>): Promise<void> {
  await Promise.race([
    Promise.all(waits),
    new Promise((resolve) => setTimeout(resolve, 2000).unref()),
  ]);
}

/**
 * One CLI emitting an invalid byte must not kill the panel; decode
 * leniently and strip terminal control sequences.
 */
async function readText(file: string): Promise<string> {
  try {
    const buffer = await readFile(file);
    return stripAnsi(buffer.toString('utf8'));
  } catch {
    return '';
  }
}

export interface ProbeResult {
  present: boolean;
  version: string | null;
  /** Why it is not usable, when it is not. */
  error?: string;
  /** Raw first-line output, kept for diagnostics. */
  output?: string;
}

/**
 * Preflight is "can we execute this binary", NOT "is it authenticated".
 * There is no uniform, free auth check across vendors and a wrong one rots
 * per vendor, so an expired login surfaces as a fast lane failure instead.
 *
 * Presence deliberately does not require a zero exit: some CLIs return
 * non-zero from `--version` under odd conditions, and refusing to offer a
 * CLI the user demonstrably has installed is worse than offering one that
 * later fails with a clear reason.
 */
export async function probe(
  command: string,
  args: string[],
  signal?: AbortSignal,
): Promise<ProbeResult> {
  // Own the scratch directory rather than trusting the caller: passing the
  // repo here (as `init` used to) leaves `probe-*.stdout` files behind in a
  // user's working tree whenever cleanup does not run.
  const scratch = await mkdtemp(path.join(tmpdir(), 'crbuddy-probe-'));

  try {
    return await runProbe(command, args, scratch, signal);
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function runProbe(
  command: string,
  args: string[],
  scratch: string,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const result = await runProcess({
    command,
    args,
    cwd: scratch,
    timeoutMs: 20_000,
    scratchDir: scratch,
    id: `probe-${command}-${process.pid}`,
    signal,
  });

  const output = `${result.stdout}\n${result.stderr}`.trim();

  if (result.spawnError) {
    return {
      present: false,
      version: null,
      error: notFoundHint(command, result.spawnError),
    };
  }

  if (result.timedOut) {
    return {
      present: false,
      version: null,
      error: `\`${command} ${args.join(' ')}\` did not return within 20s.`,
    };
  }

  // Executed at all means present. A non-zero exit is recorded, not fatal.
  return {
    present: true,
    version: null,
    output: output.split('\n')[0] ?? '',
    ...(result.code !== 0
      ? { error: `exited ${result.code}: ${output.slice(0, 160)}` }
      : {}),
  };
}

function notFoundHint(command: string, raw: string): string {
  const enoent = /ENOENT/i.test(raw);

  if (!enoent) return raw;

  return isWindows
    ? `\`${command}\` was not found on PATH. If it runs in your terminal, it is ` +
        `probably an npm \`.cmd\` shim. crbuddy resolves those, so check that ` +
        `the same PATH is visible to this shell.`
    : `\`${command}\` was not found on PATH.`;
}
