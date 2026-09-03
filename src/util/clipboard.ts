import spawn from 'cross-spawn';

/**
 * Copying is a convenience, never a correctness requirement: the report has
 * already been printed by the time this runs, so a failure here costs the
 * user a scroll-and-select, not the review. Every path resolves rather than
 * rejects, and the caller reports which one happened.
 */
export interface ClipboardResult {
  ok: boolean;
  /** Why it failed, for the terminal. Absent on success. */
  reason?: string;
}

export interface ClipboardCandidate {
  command: string;
  args: string[];
  encoding: BufferEncoding;
}

/**
 * A clipboard helper that never exits would hang `crbuddy go` after the
 * report is already on screen. X11 selection ownership is the realistic
 * case: whoever holds the selection has to stay running to serve it.
 */
const TIMEOUT_MS = 5_000;

/** WSL reports Linux to Node even though Windows executables remain invokable. */
export function isWsl(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

/**
 * `clip.exe` decodes redirected stdin as UTF-16LE reliably. Feeding UTF-8 can
 * silently mojibake non-ASCII report text, both on native Windows and through
 * WSL interop.
 */
export function encodeForClipboard(
  text: string,
  encoding: BufferEncoding = 'utf8',
): Buffer {
  return Buffer.from(text, encoding);
}

/**
 * Ordered by likelihood, not preference. WSL gets the host clipboard first,
 * then ordinary Linux clipboard tools as fallbacks for graphical sessions.
 */
export function clipboardCandidates(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ClipboardCandidate[] {
  if (platform === 'win32') {
    return [{ command: 'clip.exe', args: [], encoding: 'utf16le' }];
  }

  if (platform === 'darwin') {
    return [{ command: 'pbcopy', args: [], encoding: 'utf8' }];
  }

  return [
    ...(isWsl(platform, env)
      ? [{ command: 'clip.exe', args: [], encoding: 'utf16le' as const }]
      : []),
    { command: 'wl-copy', args: [], encoding: 'utf8' },
    { command: 'xclip', args: ['-selection', 'clipboard'], encoding: 'utf8' },
    { command: 'xsel', args: ['--clipboard', '--input'], encoding: 'utf8' },
  ];
}

export async function copyToClipboard(text: string): Promise<ClipboardResult> {
  const tried: string[] = [];
  let firstReason: string | undefined;

  for (const candidate of clipboardCandidates()) {
    tried.push(candidate.command);

    const result = await attempt(candidate, text);

    if (result.ok) return result;

    // Every candidate gets a turn even after a real failure, not just after
    // ENOENT. On Linux the list is genuinely alternative tools: `wl-copy`
    // can be installed and still fail on an X11 session, and giving up
    // there would keep `xclip` from ever running. The same rule lets WSL
    // fall back if Windows interop has been disabled for that distro/session.
    firstReason ??= result.reason;
  }

  return {
    ok: false,
    reason:
      firstReason ?? `no clipboard tool found (tried ${tried.join(', ')})`,
  };
}

/** Resolves `{ok:false}` with no reason when the tool is simply absent. */
function attempt(
  candidate: ClipboardCandidate,
  text: string,
): Promise<ClipboardResult> {
  return new Promise((resolve) => {
    let child;

    try {
      child = spawn(candidate.command, candidate.args, {
        stdio: ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      resolve({ ok: false });
      return;
    }

    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, reason: `${candidate.command} did not exit` });
    }, TIMEOUT_MS);

    // Never hold the process open on this timer alone: the report is
    // printed and the run is otherwise finished.
    timer.unref?.();

    function finish(result: ClipboardResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish(
        error.code === 'ENOENT'
          ? { ok: false }
          : { ok: false, reason: error.message },
      );
    });

    child.on('close', (code) => {
      finish(
        code === 0
          ? { ok: true }
          : { ok: false, reason: `${candidate.command} exited ${code}` },
      );
    });

    // An EPIPE here is the child having died already; `close` carries the
    // real outcome, so the write error is swallowed rather than thrown.
    child.stdin?.on('error', () => {});
    child.stdin?.end(encodeForClipboard(text, candidate.encoding));
  });
}
