import readline from 'node:readline';
import { createInterface } from 'node:readline/promises';

/**
 * Terminal prompts.
 *
 * `select` takes over stdin in raw mode so arrow keys work, and puts it back
 * afterwards. Ctrl-C anywhere raises PromptAborted, which the caller turns
 * into a one-line message rather than an AbortError stack trace.
 */

export class PromptAborted extends Error {
  constructor() {
    super('aborted');
    this.name = 'PromptAborted';
  }
}

export interface Choice<T> {
  label: string;
  value: T;
  /** Shown dimmed and skipped when navigating. */
  disabled?: boolean;
  /** Secondary text shown after the label. */
  hint?: string;
}

const CURSOR_HIDE = '\u001B[?25l';
const CURSOR_SHOW = '\u001B[?25h';
const DIM = '\u001B[2m';

/** Dim text. Pure white is reserved for things the user must act on. */
export function dim(text: string): string {
  return process.stdout.isTTY ? `${DIM}${text}${RESET}` : text;
}
const CYAN = '\u001B[36m';
const RESET = '\u001B[0m';

function supportsInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Non-TTY line source.
 *
 * On a TTY each prompt can safely open and close its own readline. When
 * stdin is a pipe it cannot: closing an interface discards everything
 * already buffered, so the second prompt reads EOF. Piped input is
 * therefore drained once and served from a queue.
 */
let pipedLines: string[] | null = null;

async function readPipedLines(): Promise<string[]> {
  if (pipedLines) return pipedLines;

  const chunks: Buffer[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }

  pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);

  return pipedLines;
}

async function nextPipedLine(): Promise<string | null> {
  const lines = await readPipedLines();
  return lines.length > 0 ? (lines.shift() ?? null) : null;
}

/** Ask on a TTY, or take the next piped line. */
async function ask(question: string): Promise<string> {
  if (!supportsInteractive()) {
    const line = await nextPipedLine();

    if (line === null) throw new PromptAborted();

    process.stdout.write(`${question} ${line}\n`);
    return line.trim();
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return (await rl.question(`${question} `)).trim();
  } catch (error) {
    throw toAbort(error);
  } finally {
    rl.close();
  }
}

/**
 * Arrow-key list. Enter selects; number keys jump; Ctrl-C aborts.
 *
 * `initialIndex` positions the cursor. There is no "default value" shown in
 * brackets — with a highlighted row the bracket hint is redundant and reads
 * as a recommendation, which is not always wanted.
 */
export async function select<T>(
  question: string,
  choices: Array<Choice<T>>,
  initialIndex = 0,
): Promise<T> {
  const selectable = choices
    .map((choice, index) => ({ choice, index }))
    .filter((entry) => !entry.choice.disabled);

  if (selectable.length === 0) {
    throw new Error('select() called with no selectable choices');
  }

  if (!supportsInteractive()) {
    return selectNonInteractive(question, choices, selectable, initialIndex);
  }

  let active =
    selectable.find((entry) => entry.index === initialIndex)?.index ??
    selectable[0]!.index;

  const out = process.stdout;

  out.write(`\n${question}\n`);
  out.write(CURSOR_HIDE);

  const render = (first: boolean): void => {
    if (!first) {
      out.write(`\u001B[${choices.length}A`);
    }

    for (const choice of choices) {
      out.write('\u001B[2K');

      const isActive = choices.indexOf(choice) === active;

      if (choice.disabled) {
        out.write(`  ${DIM}  ${choice.label}${RESET}\n`);
        continue;
      }

      const pointer = isActive ? `${CYAN}>${RESET}` : ' ';
      const label = isActive ? `${CYAN}${choice.label}${RESET}` : choice.label;
      const hint = choice.hint ? ` ${DIM}${choice.hint}${RESET}` : '';

      out.write(`  ${pointer} ${label}${hint}\n`);
    }
  };

  render(true);

  const move = (delta: number): void => {
    const positions = selectable.map((entry) => entry.index);
    const current = positions.indexOf(active);
    const next = (current + delta + positions.length) % positions.length;

    active = positions[next]!;
    render(false);
  };

  return new Promise<T>((resolve, reject) => {
    readline.emitKeypressEvents(process.stdin);
    const wasRaw = process.stdin.isRaw ?? false;
    process.stdin.setRawMode(true);
    process.stdin.resume();

    const cleanup = (): void => {
      process.stdin.removeListener('keypress', onKeypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      out.write(CURSOR_SHOW);
    };

    function onKeypress(
      _str: string,
      key: { name?: string; ctrl?: boolean; sequence?: string },
    ): void {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        reject(new PromptAborted());
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        move(-1);
        return;
      }

      if (key.name === 'down' || key.name === 'j') {
        move(1);
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(choices[active]!.value);
        return;
      }

      const digit = Number.parseInt(key.sequence ?? '', 10);

      if (Number.isFinite(digit) && digit >= 1 && digit <= choices.length) {
        const target = choices[digit - 1];

        if (target && !target.disabled) {
          active = digit - 1;
          render(false);
        }
      }
    }

    process.stdin.on('keypress', onKeypress);
  });
}

async function selectNonInteractive<T>(
  question: string,
  choices: Array<Choice<T>>,
  selectable: Array<{ choice: Choice<T>; index: number }>,
  initialIndex: number,
): Promise<T> {
  console.log(`\n${question}`);

  choices.forEach((choice, index) => {
    console.log(
      choice.disabled
        ? `     ${choice.label}`
        : `  ${index + 1}. ${choice.label}${choice.hint ? ` ${choice.hint}` : ''}`,
    );
  });

  for (;;) {
    const answer = await ask('  >');

    if (answer === '') {
      const fallback =
        selectable.find((entry) => entry.index === initialIndex) ?? selectable[0]!;
      return fallback.choice.value;
    }

    const index = Number.parseInt(answer, 10) - 1;
    const chosen = choices[index];

    if (chosen && !chosen.disabled) return chosen.value;

    console.log('  Pick one of the numbers above.');
  }
}

export async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';

  for (;;) {
    const answer = await ask(`${question} [${hint}]`);

    if (answer === '') return defaultYes;
    if (/^y(es)?$/i.test(answer)) return true;
    if (/^n(o)?$/i.test(answer)) return false;
  }
}

export async function text(question: string, fallback = ''): Promise<string> {
  for (;;) {
    const answer = await ask(`${question}${fallback ? ` [${fallback}]` : ''}`);

    if (answer !== '') return answer;
    if (fallback !== '') return fallback;
  }
}

/** readline throws AbortError on Ctrl-C; that is not a crash. */
export function toAbort(error: unknown): Error {
  const name = (error as { name?: string })?.name;

  if (name === 'AbortError' || error instanceof PromptAborted) {
    return new PromptAborted();
  }

  return error instanceof Error ? error : new Error(String(error));
}
