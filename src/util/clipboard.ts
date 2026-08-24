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

interface Candidate {
  command: string;
  args: string[];
}

/**
 * A clipboard helper that never exits would hang `crbuddy go` after the
 * report is already on screen. X11 selection ownership is the realistic
 * case: whoever holds the selection has to stay running to serve it.
 */
const TIMEOUT_MS = 5_000;

/**
 * `clip.exe` decodes stdin with the console code page, not UTF-8. The
 * consolidated report always contains U+2026 (the "C1, C2…" note), which
 * arrives as `ΓÇª` under CP437 - a silent corruption, since clip still
 * exits 0. UTF-16LE is decoded correctly and needs no BOM; adding one only
 * prepends a stray U+FEFF to the paste.
 */
export function encodeForClipboard(text: string): Buffer {
  return process.platform === 'win32'
    ? Buffer.from(text, 'utf16le')
    : Buffer.from(text, 'utf8');
}

/**
 * Ordered by likelihood, not preference. On Linux there is no single answer:
 * Wayland and X11 ship different tools and neither is guaranteed present, so
 * each is tried until one is actually installed.
 */
function candidates(): Candidate[] {
  if (process.platform === 'win32') {
    return [{ command: 'clip', args: [] }];
  }

  if (process.platform === 'darwin') {
    return [{ command: 'pbcopy', args: [] }];
  }

  return [
    { command: 'wl-copy', args: [] },
    { command: 'xclip', args: ['-selection', 'clipboard'] },
    { command: 'xsel', args: ['--clipboard', '--input'] },
  ];
}

export async function copyToClipboard(text: string): Promise<ClipboardResult> {
  const tried: string[] = [];
  let firstReason: string | undefined;

  for (const candidate of candidates()) {
    tried.push(candidate.command);

    const result = await attempt(candidate, text);

    if (result.ok) return result;

    // Every candidate gets a turn even after a real failure, not just after
    // ENOENT. On Linux the list is genuinely alternative tools: `wl-copy`
    // can be installed and still fail on an X11 session, and giving up
    // there would keep `xclip` from ever running.
    firstReason ??= result.reason;
  }

  return {
    ok: false,
    reason: firstReason ?? `no clipboard tool found (tried ${tried.join(', ')})`,
  };
}

/** Resolves `{ok:false}` with no reason when the tool is simply absent. */
function attempt(candidate: Candidate, text: string): Promise<ClipboardResult> {
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
      finish(error.code === 'ENOENT' ? { ok: false } : { ok: false, reason: error.message });
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
    child.stdin?.end(encodeForClipboard(text));
  });
}
