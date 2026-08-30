import type { Readable, Writable } from 'node:stream';

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
  /** Secret input is masked in an interactive TTY and never echoed by crbuddy. */
  secret?(question: string): Promise<string>;
}

export interface WizardUIOptions {
  input?: Readable & { isTTY?: boolean };
  output?: Writable & { isTTY?: boolean };
  /** Test seam; production callers should let the streams decide. */
  interactive?: boolean;
  loadClack?: () => Promise<typeof import('@clack/prompts')>;
}

export async function createWizardUI(
  options: WizardUIOptions = {},
): Promise<WizardUI> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const interactive =
    options.interactive ?? Boolean(input.isTTY && output.isTTY);

  if (!interactive) return new LineWizardUI();

  const clack = await (options.loadClack ?? (() => import('@clack/prompts')))();
  return new ClackWizardUI(clack, input, output);
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

  secret(question: string): Promise<string> {
    return lineText(question);
  }
}

type Clack = typeof import('@clack/prompts');

class ClackWizardUI implements WizardUI {
  readonly interactive = true;

  constructor(
    private readonly clack: Clack,
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  intro(message: string): void {
    this.clack.intro(message, { output: this.output });
  }

  outro(message: string): void {
    this.clack.outro(message, { output: this.output });
  }

  cancel(message: string): void {
    this.clack.cancel(message, { output: this.output });
  }

  note(message: string, title = ''): void {
    this.clack.note(message, title, { output: this.output });
  }

  message(message: string, kind: MessageKind = 'info'): void {
    this.clack.log[kind](message, { output: this.output });
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

    spin.start(message);

    try {
      const result = await task(controller.signal);

      if (controller.signal.aborted || spin.isCancelled) {
        throw new PromptAborted();
      }

      spin.stop(doneMessage);
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
      message: question,
      options: choices as never[],
      initialValue: choices[initialIndex]?.value,
      input: this.input,
      output: this.output,
    })) as T | symbol;

    return this.valueOrAbort(result);
  }

  async confirm(question: string, defaultYes: boolean): Promise<boolean> {
    const result = await this.clack.confirm({
      message: question,
      initialValue: defaultYes,
      input: this.input,
      output: this.output,
    });

    return this.valueOrAbort(result);
  }

  async text(question: string, fallback = ''): Promise<string> {
    const result = await this.clack.text({
      message: question,
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
    return value === '' && fallback !== '' ? fallback : value;
  }

  async secret(question: string): Promise<string> {
    const result = await this.clack.password({
      message: question,
      mask: '*',
      validate(value) {
        return (value ?? '').trim() === '' ? 'A value is required.' : undefined;
      },
      input: this.input,
      output: this.output,
    });

    return this.valueOrAbort(result ?? '').trim();
  }

  private valueOrAbort<T>(value: T | symbol): T {
    if (this.clack.isCancel(value)) throw new PromptAborted();
    return value as T;
  }
}
