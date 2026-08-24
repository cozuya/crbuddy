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
const TAB_PROGRESS_INDETERMINATE = '\u001B]9;4;3;0\u0007';
const TAB_PROGRESS_CLEAR = '\u001B]9;4;0;0\u0007';

const FRAMES = [
  '\u280B',
  '\u2819',
  '\u2839',
  '\u2838',
  '\u283C',
  '\u2834',
  '\u2826',
  '\u2827',
  '\u2807',
  '\u280F',
];
const FRAME_MS = 100;

interface ProgressOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(text: string): unknown;
}

export class Progress {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private statusVisible = false;
  private statusOutput: ProgressOutput | null = null;
  private tabProgressVisible = false;
  private startedAt = 0;
  private active = new Set<string>();

  constructor(
    private readonly errorOutput: ProgressOutput = process.stderr,
    private readonly standardOutput: ProgressOutput = process.stdout,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  /** Full brightness. Reserved for state changes worth noticing. */
  line(text: string): void {
    this.withStatusHidden(() => this.errorOutput.write(`${text}\n`));
  }

  /** Context: everything the user does not need to act on. */
  dim(text: string): void {
    this.withStatusHidden(() =>
      this.errorOutput.write(
        this.errorOutput.isTTY ? `${DIM}${text}${RESET}\n` : `${text}\n`,
      ),
    );
  }

  /** Begin the live status line on whichever user-facing stream is a TTY. */
  startPulse(startedAt: number): void {
    this.startedAt = startedAt;

    if (this.timer) return;

    this.statusOutput = this.terminalOutput();
    if (!this.statusOutput) return;

    // VS Code maps OSC 9;4 progress onto the `${progress}` portion of its
    // terminal-tab title. It is invisible in the terminal body and gives a
    // background tab the same busy signal as a foreground Codex session.
    if (
      this.environment.TERM_PROGRAM === 'vscode' &&
      !this.tabProgressVisible
    ) {
      this.statusOutput.write(TAB_PROGRESS_INDETERMINATE);
      this.tabProgressVisible = true;
    }

    this.timer = setInterval(() => this.render(), FRAME_MS);
    this.timer.unref();
    if (this.active.size > 0) this.render();
  }

  /** Stop the in-terminal animation while leaving a background tab marked busy. */
  pausePulse(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.hideStatus();
    this.active.clear();
  }

  /** Stop every progress surface, including VS Code's terminal-tab state. */
  stopPulse(): void {
    this.pausePulse();

    if (this.tabProgressVisible && this.statusOutput) {
      this.statusOutput.write(TAB_PROGRESS_CLEAR);
      this.tabProgressVisible = false;
    }

    this.statusOutput = null;
  }

  /** Track which lanes are still running, for the status line. */
  laneStarted(name: string): void {
    this.active.add(name);
    this.render();
  }

  laneFinished(name: string): void {
    this.active.delete(name);
    this.render();
  }

  /** TTY only — BEL bytes in a CI log are noise. */
  bell(): void {
    this.terminalOutput()?.write('\u0007');
  }

  private withStatusHidden(write: () => void): void {
    this.hideStatus();
    write();
    this.render();
  }

  private hideStatus(): void {
    if (this.statusVisible && this.statusOutput) {
      this.statusOutput.write(CLEAR_LINE);
      this.statusVisible = false;
    }
  }

  private render(): void {
    if (!this.statusOutput || !this.timer) return;

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
    const reported = this.statusOutput.columns ?? 0;
    const width = reported > 30 ? reported : 80;
    const visible =
      text.length > width - 1 ? `${text.slice(0, width - 2)}\u2026` : text;

    this.statusOutput.write(`${CLEAR_LINE}${DIM}${visible}${RESET}`);
    this.statusVisible = true;
  }

  private terminalOutput(): ProgressOutput | null {
    if (this.errorOutput.isTTY) return this.errorOutput;
    if (this.standardOutput.isTTY) return this.standardOutput;
    return null;
  }
}

export const progress = new Progress();
