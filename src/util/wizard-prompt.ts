import type { Writable } from 'node:stream';
import { styleText } from 'node:util';

import {
  explicitSubmitMultilineText,
  multilineTerminalHints,
  multilineText,
  supportsBracketedPaste,
  type MultilineInput,
} from './multiline-prompt.js';
import type { Choice } from './prompt.js';
import {
  PromptAborted,
  confirm as lineConfirm,
  select as lineSelect,
  text as lineText,
} from './prompt.js';

export type MessageKind = 'info' | 'success' | 'warn' | 'error';

/** Presentation boundary for the init wizard. */
export interface WizardUI {
  readonly interactive: boolean;
  intro(message: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  note(message: string, title?: string): void;
  message(message: string, kind?: MessageKind): void;
  spinner<T>(
    message: string,
    task: (signal: AbortSignal) => Promise<T>,
    doneMessage?: string,
  ): Promise<T>;
  select<T>(
    question: string,
    choices: Array<Choice<T>>,
    initialIndex?: number,
  ): Promise<T>;
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  text(question: string, fallback?: string): Promise<string>;
  multiline(question: string): Promise<string>;
}

export interface WizardUIOptions {
  input?: MultilineInput & { isTTY?: boolean };
  output?: Writable & { isTTY?: boolean };
  /** Test seam; production callers should let the streams decide. */
  interactive?: boolean;
  /** Test seams for terminal capability routing. */
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  loadClack?: () => Promise<typeof import('@clack/prompts')>;
}

/**
 * Clack is loaded only for a real interactive session. Piped setup keeps the
 * existing prompt implementation, including its single-drain stdin queue.
 */
export async function createWizardUI(
  options: WizardUIOptions = {},
): Promise<WizardUI> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive =
    options.interactive ?? Boolean(input.isTTY && output.isTTY);

  if (!interactive) return new LineWizardUI();

  const clack = await (options.loadClack ?? (() => import('@clack/prompts')))();
  return new ClackWizardUI(
    clack,
    input,
    output,
    options.platform ?? process.platform,
    options.environment ?? process.env,
  );
}

class LineWizardUI implements WizardUI {
  readonly interactive = false;

  intro(message: string): void {
    console.log('');
    console.log(message);
  }

  outro(message: string): void {
    console.log('');
    console.log(message);
  }

  cancel(message: string): void {
    console.log('');
    console.log(message);
  }

  note(message: string, title?: string): void {
    console.log('');
    if (title) console.log(title);
    console.log(message);
  }

  message(message: string): void {
    console.log(message);
  }

  async spinner<T>(
    message: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    console.log('');
    console.log(message);
    return task(new AbortController().signal);
  }

  select<T>(
    question: string,
    choices: Array<Choice<T>>,
    initialIndex = 0,
  ): Promise<T> {
    return lineSelect(question, choices, initialIndex);
  }

  confirm(question: string, defaultYes: boolean): Promise<boolean> {
    return lineConfirm(question, defaultYes);
  }

  text(question: string, fallback = ''): Promise<string> {
    return lineText(question, fallback);
  }

  // Piped setup intentionally stays one answer per line. Multiline editing is
  // an interactive terminal affordance, not a change to the scripted init
  // answer sequence.
  multiline(question: string): Promise<string> {
    return lineText(question);
  }
}

type Clack = typeof import('@clack/prompts');

class ClackWizardUI implements WizardUI {
  readonly interactive = true;

  constructor(
    private readonly clack: Clack,
    private readonly input: MultilineInput,
    private readonly output: Writable,
    private readonly platform: NodeJS.Platform,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  private bold(message: string): string {
    return styleText('bold', message, { stream: this.output });
  }

  private dim(message: string): string {
    return styleText('dim', message, { stream: this.output });
  }

  private prompt(message: string): string {
    return this.bold(message);
  }

  intro(message: string): void {
    this.clack.intro(this.bold(message), { output: this.output });
  }

  outro(message: string): void {
    this.clack.outro(this.bold(message), { output: this.output });
  }

  cancel(message: string): void {
    // Keep Clack's stock cancellation symbol/color; only hierarchy is themed.
    this.clack.cancel(message, { output: this.output });
  }

  note(message: string, title = ''): void {
    this.clack.note(message, title ? this.bold(title) : '', { output: this.output });
  }

  message(message: string, kind: MessageKind = 'info'): void {
    // Clack already supplies severity symbols/colors. Dim ordinary informational
    // chatter so warnings/errors/successes retain their stock visual weight.
    this.clack.log[kind](kind === 'info' ? this.dim(message) : message, {
      output: this.output,
    });
  }

  async spinner<T>(
    message: string,
    task: (signal: AbortSignal) => Promise<T>,
    doneMessage = message,
  ): Promise<T> {
    const controller = new AbortController();
    const spin = this.clack.spinner({
      output: this.output,
      onCancel: () => controller.abort(),
    });

    spin.start(this.dim(message));

    try {
      const result = await task(controller.signal);

      if (controller.signal.aborted || spin.isCancelled) {
        throw new PromptAborted();
      }

      spin.stop(this.bold(doneMessage));
      return result;
    } catch (error) {
      if (controller.signal.aborted || spin.isCancelled) {
        if (!spin.isCancelled) spin.cancel('Cancelled');
        throw new PromptAborted();
      }

      spin.error('Vendor detection failed');
      throw error;
    }
  }

  async select<T>(
    question: string,
    choices: Array<Choice<T>>,
    initialIndex = 0,
  ): Promise<T> {
    const result = (await this.clack.select({
      message: this.prompt(question),
      options: choices as never[],
      initialValue: choices[initialIndex]?.value,
      showInstructions: false,
      input: this.input,
      output: this.output,
    })) as T | symbol;

    return this.valueOrAbort(result);
  }

  async confirm(question: string, defaultYes: boolean): Promise<boolean> {
    const result = await this.clack.confirm({
      message: this.prompt(question),
      initialValue: defaultYes,
      input: this.input,
      output: this.output,
    });

    return this.valueOrAbort(result);
  }

  async text(question: string, fallback = ''): Promise<string> {
    const result = await this.clack.text({
      message: this.prompt(question),
      ...(fallback ? { placeholder: fallback, defaultValue: fallback } : {}),
      validate(value) {
        return (value ?? '').trim() === '' && fallback === ''
          ? 'A value is required.'
          : undefined;
      },
      input: this.input,
      output: this.output,
    });

    const value = this.valueOrAbort(result ?? '').trim();

    // Clack treats whitespace as a supplied value, while the line prompt
    // trims before deciding whether to use its fallback. Keep both paths
    // semantically identical so a TTY cannot produce an invalid empty id/ref.
    return value === '' && fallback !== '' ? fallback : value;
  }

  multiline(question: string): Promise<string> {
    // Enter-submit is safe only when the terminal is known to honor bracketed
    // paste. Otherwise use an explicit Ctrl+D submit mode where CR/LF and tabs
    // are always content, so a multiline paste cannot answer the next prompt.
    const pasteSafe = supportsBracketedPaste(this.platform, this.environment);

    if (!pasteSafe) {
      return explicitSubmitMultilineText(this.prompt(question), this.input, this.output);
    }

    const hints = multilineTerminalHints(this.platform, this.environment);

    return multilineText(
      this.prompt(question),
      this.input,
      this.output,
      undefined,
      undefined,
      hints,
    );
  }

  private valueOrAbort<T>(value: T | symbol): T {
    if (this.clack.isCancel(value)) throw new PromptAborted();
    return value as T;
  }
}
