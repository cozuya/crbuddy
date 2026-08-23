import { formatElapsed } from '../util/format.js';

/**
 * Run narration.
 *
 * Two things are happening here. Discrete events append lines, as before -
 * scrollback is more useful than a spinner when a run misbehaves. On top of
 * that, a TTY gets one live status line pinned to the bottom, because a
 * multi-minute wait with a frozen screen gives no signal that anything is
 * still alive.
 *
 * The live line is a strict addition: on a non-TTY nothing changes, so piped
 * and CI output stays clean and append-only.
 */

const DIM = '\u001B[2m';
const RESET = '\u001B[0m';
const CLEAR_LINE = '\u001B[2K\r';

const FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];
const FRAME_MS = 100;

class Progress {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private statusVisible = false;
  private startedAt = 0;
  private active = new Set<string>();

  private get tty(): boolean {
    return Boolean(process.stderr.isTTY);
  }

  /** Full brightness. Reserved for state changes worth noticing. */
  line(text: string): void {
    this.withStatusHidden(() => process.stderr.write(`${text}\n`));
  }

  /** Context: everything the user does not need to act on. */
  dim(text: string): void {
    this.withStatusHidden(() =>
      process.stderr.write(this.tty ? `${DIM}${text}${RESET}\n` : `${text}\n`),
    );
  }

  /** Begin the live status line. No-op off a TTY. */
  startPulse(startedAt: number): void {
    this.startedAt = startedAt;

    if (!this.tty || this.timer) return;

    this.timer = setInterval(() => this.render(), FRAME_MS);
    this.timer.unref();
  }

  stopPulse(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.hideStatus();
    this.active.clear();
  }

  /** Track which lanes are still running, for the status line. */
  laneStarted(name: string): void {
    this.active.add(name);
  }

  laneFinished(name: string): void {
    this.active.delete(name);
  }

  /** TTY only — BEL bytes in a CI log are noise. */
  bell(): void {
    if (this.tty) process.stderr.write('\u0007');
  }

  private withStatusHidden(write: () => void): void {
    this.hideStatus();
    write();
    this.render();
  }

  private hideStatus(): void {
    if (this.statusVisible) {
      process.stderr.write(CLEAR_LINE);
      this.statusVisible = false;
    }
  }

  private render(): void {
    if (!this.tty || !this.timer) return;

    const spinner = FRAMES[this.frame % FRAMES.length]!;
    this.frame += 1;

    const elapsed = formatElapsed(Date.now() - this.startedAt);

    const waiting =
      this.active.size === 0
        ? 'finishing up'
        : `waiting on ${[...this.active].join(', ')}`;

    const text = `${spinner} ${elapsed} - ${waiting}`;

    // Truncate rather than wrap: a wrapped status line cannot be cleared
    // with a single erase and leaves debris in the scrollback.
    // Some pseudo-terminals report a nonsense width; treat anything
    // implausible as a standard 80 columns rather than truncating to noise.
    const reported = process.stderr.columns ?? 0;
    const width = reported > 30 ? reported : 80;
    const visible = text.length > width - 1 ? `${text.slice(0, width - 2)}\u2026` : text;

    process.stderr.write(`${CLEAR_LINE}${DIM}${visible}${RESET}`);
    this.statusVisible = true;
  }
}

export const progress = new Progress();
