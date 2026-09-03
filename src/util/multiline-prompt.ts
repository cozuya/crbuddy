import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

import { PromptAborted } from './prompt.js';

export type MultilineInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (enabled: boolean) => void;
};

export type MultilineInputEvent =
  | { type: 'text'; text: string }
  | { type: 'newline'; count?: number }
  | { type: 'submit' }
  | { type: 'backspace'; count?: number }
  | { type: 'abort' };

type TerminationSignal = 'SIGTERM' | 'SIGHUP';

interface LifecycleEmitter {
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

interface Win32Utf16Unit {
  type: 'utf16';
  unit: number;
  repeatCount: number;
}

type Win32Decoded = MultilineInputEvent | Win32Utf16Unit;

interface TerminalInputDecoderOptions {
  enterSubmits?: boolean;
  ctrlDSubmits?: boolean;
}

interface MultilineTextOptions extends TerminalInputDecoderOptions {
  enhancedModes?: boolean;
  submitHint?: string;
  newlineHint?: string;
  pasteSafe?: boolean;
}

const ESC = '\u001b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

const BRACKETED_PASTE_ON = `${ESC}[?2004h`;
const BRACKETED_PASTE_OFF = `${ESC}[?2004l`;
const KITTY_KEYS_ON = `${ESC}[>24u`;
const KITTY_KEYS_OFF = `${ESC}[<u`;
const WIN32_INPUT_ON = `${ESC}[?9001h`;
const WIN32_INPUT_OFF = `${ESC}[?9001l`;

const CTRL_MASK = 0b100;
const SHIFT_MASK = 0b001;
const WIN32_CTRL_MASK = 0x0004 | 0x0008;
const WIN32_SHIFT_MASK = 0x0010;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function longestMarkerPrefixSuffix(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);

  for (let length = max; length > 0; length -= 1) {
    if (marker.startsWith(value.slice(-length))) return length;
  }

  return 0;
}

function isTextScalar(code: number): boolean {
  if (code < 0x20 || code > 0x10ffff) return false;
  if (code >= 0x7f && code <= 0x9f) return false;
  return code < 0xd800 || code > 0xdfff;
}

function isKittyFallbackTextCodePoint(code: number): boolean {
  if (!isTextScalar(code)) return false;
  return code < 0xe000 || code > 0xf8ff;
}

function sanitizeAssociatedText(codes: number[]): string {
  return codes
    .filter(isTextScalar)
    .map((code) => String.fromCodePoint(code))
    .join('');
}

function consumeCsi(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }

  return text.length;
}

function consumeStringControl(text: string, start: number): number {
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (char === '\u0007' || char === '\u009c') return index + 1;
    if (char === ESC && text[index + 1] === '\\') return index + 2;
  }

  return text.length;
}

/**
 * Pasted text is content, not terminal control input. Remove CSI/OSC/DCS/APC
 * framing before echoing or saving it, then retain only tab/LF among controls.
 */
function sanitizePastedText(text: string): string {
  let clean = '';

  for (let index = 0; index < text.length; ) {
    const char = text[index]!;
    const code = char.charCodeAt(0);

    if (char === ESC) {
      const next = text[index + 1];

      if (next === '[') {
        index = consumeCsi(text, index + 2);
        continue;
      }

      if (next === ']' || next === 'P' || next === '^' || next === '_' || next === 'X') {
        index = consumeStringControl(text, index + 2);
        continue;
      }

      if (next === '\\') {
        index += 2;
        continue;
      }

      index += 1;
      continue;
    }

    if (char === '\u009b') {
      index = consumeCsi(text, index + 1);
      continue;
    }

    if (
      char === '\u009d' ||
      char === '\u0090' ||
      char === '\u0098' ||
      char === '\u009e' ||
      char === '\u009f'
    ) {
      index = consumeStringControl(text, index + 1);
      continue;
    }

    if (char === '\r') {
      clean += '\n';
      if (text[index + 1] === '\n') index += 1;
      index += 1;
      continue;
    }

    if (char === '\n' || char === '\t') {
      clean += char;
      index += 1;
      continue;
    }

    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }

    clean += char;
    index += 1;
  }

  return clean;
}

function withCount<T extends { count?: number }>(
  event: Omit<T, 'count'>,
  count: number,
): T {
  return (count > 1 ? { ...event, count } : event) as T;
}

function newlineEvent(count = 1): Extract<MultilineInputEvent, { type: 'newline' }> {
  return withCount<{ type: 'newline'; count?: number }>({ type: 'newline' }, count);
}

function backspaceEvent(count = 1): Extract<MultilineInputEvent, { type: 'backspace' }> {
  return withCount<{ type: 'backspace'; count?: number }>({ type: 'backspace' }, count);
}

function kittyEvent(
  sequence: string,
  options: Required<TerminalInputDecoderOptions>,
): MultilineInputEvent | null {
  const match = /^\u001b\[([0-9:;]*)u$/.exec(sequence);
  if (!match) return null;

  const fields = match[1]!.split(';');
  const keyCode = Number((fields[0] ?? '').split(':', 1)[0]);
  if (!Number.isInteger(keyCode)) return null;

  const modifierParts = (fields[1] ?? '').split(':');
  const encodedModifiers = Number(modifierParts[0] || '1');
  const eventType = Number(modifierParts[1] || '1');

  // 1 = press, 2 = repeat, 3 = release.
  if (eventType === 3) return null;

  const modifiers = Math.max(0, encodedModifiers - 1);
  const shift = Boolean(modifiers & SHIFT_MASK);
  const ctrl = Boolean(modifiers & CTRL_MASK);

  if (keyCode === 13) {
    if (!options.enterSubmits) return { type: 'newline' };
    return shift ? { type: 'newline' } : { type: 'submit' };
  }

  if (keyCode === 127) return { type: 'backspace' };
  if (keyCode === 9) return { type: 'text', text: '\t' };

  const textCodes = (fields[2] ?? '')
    .split(':')
    .filter((value) => value !== '')
    .map(Number)
    .filter((code) => Number.isInteger(code) && code > 0 && code <= 0x10ffff);
  const associatedText = sanitizeAssociatedText(textCodes);

  // Text-producing events take precedence over Ctrl shortcuts. This preserves
  // AltGr-composed text on layouts where the terminal reports Ctrl+Alt.
  if (associatedText !== '') return { type: 'text', text: associatedText };

  if (options.ctrlDSubmits && ctrl && (keyCode === 100 || keyCode === 68)) {
    return { type: 'submit' };
  }
  if (ctrl && (keyCode === 99 || keyCode === 67)) return { type: 'abort' };
  if (ctrl && (keyCode === 106 || keyCode === 74)) return { type: 'newline' };

  if (!ctrl && isKittyFallbackTextCodePoint(keyCode)) {
    let text = String.fromCodePoint(keyCode);
    if (shift && /^[a-z]$/.test(text)) text = text.toUpperCase();
    return { type: 'text', text };
  }

  return null;
}

function win32Event(
  sequence: string,
  options: Required<TerminalInputDecoderOptions>,
): Win32Decoded | null {
  const match = /^\u001b\[([0-9]*);([0-9]*);([0-9]*);([01]?);([0-9]*);([0-9]*)_$/.exec(
    sequence,
  );
  if (!match) return null;

  const virtualKey = Number(match[1] || '0');
  const unicodeChar = Number(match[3] || '0');
  const keyDown = (match[4] || '0') === '1';
  const controlState = Number(match[5] || '0');
  const repeatCount = Math.max(1, Math.min(1000, Number(match[6] || '1') || 1));

  if (!keyDown) return null;

  const ctrl = Boolean(controlState & WIN32_CTRL_MASK);
  const shift = Boolean(controlState & WIN32_SHIFT_MASK);

  if (virtualKey === 13) {
    if (!options.enterSubmits) return newlineEvent(repeatCount);
    return shift ? newlineEvent(repeatCount) : { type: 'submit' };
  }

  if (virtualKey === 8) return backspaceEvent(repeatCount);
  if (virtualKey === 9) return { type: 'text', text: '\t'.repeat(repeatCount) };

  if (unicodeChar >= 0xd800 && unicodeChar <= 0xdfff) {
    return { type: 'utf16', unit: unicodeChar, repeatCount };
  }

  if (isTextScalar(unicodeChar)) {
    return {
      type: 'text',
      text: String.fromCharCode(unicodeChar).repeat(repeatCount),
    };
  }

  if (options.ctrlDSubmits && ctrl && virtualKey === 68) return { type: 'submit' };
  if (ctrl && virtualKey === 67) return { type: 'abort' };
  if (ctrl && virtualKey === 74) return newlineEvent(repeatCount);

  return null;
}

function removeLastGrapheme(text: string): string {
  let lastIndex = -1;

  for (const segment of GRAPHEMES.segment(text)) {
    lastIndex = segment.index;
  }

  return lastIndex < 0 ? text : text.slice(0, lastIndex);
}

function isPossibleCsiPrefix(text: string): boolean {
  let intermediates = false;

  for (const char of text) {
    const code = char.charCodeAt(0);

    if (!intermediates && code >= 0x30 && code <= 0x3f) continue;
    if (code >= 0x20 && code <= 0x2f) {
      intermediates = true;
      continue;
    }

    return false;
  }

  return true;
}

/** Whether the terminal is known to expose Shift+Enter distinctly. */
export function supportsShiftEnter(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === 'win32') return false;
  if (environment.WT_SESSION) return true;
  if (environment.KITTY_WINDOW_ID) return true;

  const term = environment.TERM?.toLowerCase() ?? '';
  return term.includes('kitty');
}

/** Whether the terminal is known to honor DECSET 2004 bracketed paste. */
export function supportsBracketedPaste(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === 'win32') return false;
  if (environment.WT_SESSION) return true;
  if (environment.KITTY_WINDOW_ID) return true;

  const term = environment.TERM?.toLowerCase() ?? '';
  if (term.includes('kitty')) return true;

  const program = environment.TERM_PROGRAM?.toLowerCase();
  return program === 'vscode' || program === 'iterm.app';
}

/**
 * Stateful terminal byte-stream decoder. Two editing contracts are supported:
 * Enter-submit for terminals with reliable bracketed paste, and explicit-submit
 * (Enter=newline, Ctrl+D=submit) for terminals where paste boundaries are not
 * observable. Kitty/Win32 protocol events obey the same selected contract.
 */
export class TerminalInputDecoder {
  private pending = '';
  private inPaste = false;
  private pasteBuffer = '';
  private suppressLeadingLF = false;
  private pendingWin32HighSurrogate: { unit: number; repeatCount: number } | null = null;
  private readonly options: Required<TerminalInputDecoderOptions>;

  constructor(options: TerminalInputDecoderOptions = {}) {
    this.options = {
      enterSubmits: options.enterSubmits ?? true,
      ctrlDSubmits: options.ctrlDSubmits ?? false,
    };
  }

  private appendWin32Event(
    decoded: Win32Decoded | null,
    events: MultilineInputEvent[],
  ): void {
    if (!decoded) return;

    if (decoded.type !== 'utf16') {
      this.pendingWin32HighSurrogate = null;
      events.push(decoded);
      return;
    }

    const unit = decoded.unit;

    if (unit >= 0xd800 && unit <= 0xdbff) {
      this.pendingWin32HighSurrogate = {
        unit,
        repeatCount: decoded.repeatCount,
      };
      return;
    }

    const high = this.pendingWin32HighSurrogate;
    this.pendingWin32HighSurrogate = null;

    if (!high || unit < 0xdc00 || unit > 0xdfff) return;

    const repeatCount = Math.max(high.repeatCount, decoded.repeatCount);
    events.push({
      type: 'text',
      text: String.fromCharCode(high.unit, unit).repeat(repeatCount),
    });
  }

  feed(chunk: string): MultilineInputEvent[] {
    this.pending += chunk;
    const events: MultilineInputEvent[] = [];

    for (;;) {
      if (this.suppressLeadingLF) {
        if (this.pending === '') break;
        if (this.pending.startsWith('\n')) this.pending = this.pending.slice(1);
        this.suppressLeadingLF = false;
      }

      if (this.pending === '') break;

      if (this.inPaste) {
        const end = this.pending.indexOf(PASTE_END);

        if (end >= 0) {
          this.pasteBuffer += this.pending.slice(0, end);
          const text = sanitizePastedText(this.pasteBuffer);
          if (text !== '') events.push({ type: 'text', text });

          this.pasteBuffer = '';
          this.pending = this.pending.slice(end + PASTE_END.length);
          this.inPaste = false;
          continue;
        }

        const keep = longestMarkerPrefixSuffix(this.pending, PASTE_END);
        this.pasteBuffer += this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
        break;
      }

      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.inPaste = true;
        this.pasteBuffer = '';
        continue;
      }

      if (PASTE_START.startsWith(this.pending)) break;

      const first = this.pending[0]!;

      if (first === '\r') {
        const hasInlineLF = this.pending.startsWith('\r\n');
        const splitCRLF = !hasInlineLF && this.pending.length === 1;
        this.pending = this.pending.slice(hasInlineLF ? 2 : 1);

        if (!this.options.enterSubmits && splitCRLF) {
          // Native Windows/legacy paste may split CRLF across data events. Emit
          // the newline immediately so physical Enter stays responsive, then
          // suppress only an LF at the start of the very next chunk.
          this.suppressLeadingLF = true;
        }

        events.push(this.options.enterSubmits ? { type: 'submit' } : { type: 'newline' });
        continue;
      }

      if (first === '\n') {
        this.pending = this.pending.slice(1);
        events.push({ type: 'newline' });
        continue;
      }

      if (first === '\u0004' && this.options.ctrlDSubmits) {
        this.pending = this.pending.slice(1);
        events.push({ type: 'submit' });
        continue;
      }

      if (first === '\u0003') {
        this.pending = this.pending.slice(1);
        events.push({ type: 'abort' });
        continue;
      }

      if (first === '\u007f' || first === '\b') {
        this.pending = this.pending.slice(1);
        events.push({ type: 'backspace' });
        continue;
      }

      if (first === ESC) {
        if (this.pending.length === 1) break;

        const kitty = /^\u001b\[[0-9:;]+u/.exec(this.pending)?.[0];
        if (kitty) {
          this.pending = this.pending.slice(kitty.length);
          const event = kittyEvent(kitty, this.options);
          if (event) events.push(event);
          continue;
        }

        const win32 = /^\u001b\[[0-9]*;[0-9]*;[0-9]*;[01]?;[0-9]*;[0-9]*_/.exec(
          this.pending,
        )?.[0];
        if (win32) {
          this.pending = this.pending.slice(win32.length);
          this.appendWin32Event(win32Event(win32, this.options), events);
          continue;
        }

        if (this.pending.startsWith(`${ESC}[`)) {
          const csi = /^\u001b\[[0-?]*[ -/]*[@-~]/.exec(this.pending)?.[0];
          if (csi) {
            this.pending = this.pending.slice(csi.length);
            continue;
          }

          const tail = this.pending.slice(2);
          if (isPossibleCsiPrefix(tail)) break;

          // Drop only the malformed introducer so the following CR, Ctrl+C,
          // Unicode character, etc. is still handled normally.
          this.pending = this.pending.slice(2);
          continue;
        }

        if (this.pending.startsWith(`${ESC}O`)) {
          if (this.pending.length < 3) break;
          this.pending = this.pending.slice(3);
          continue;
        }

        // Ignore an unknown/standalone Escape without eating the next byte.
        this.pending = this.pending.slice(1);
        continue;
      }

      if (first === '\t') {
        this.pending = this.pending.slice(1);
        events.push({ type: 'text', text: '\t' });
        continue;
      }

      const code = first.charCodeAt(0);
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        this.pending = this.pending.slice(1);
        continue;
      }

      const nextControl = this.pending.search(/[\u0000-\u001f\u007f-\u009f]/);
      const end = nextControl < 0 ? this.pending.length : nextControl;
      events.push({ type: 'text', text: this.pending.slice(0, end) });
      this.pending = this.pending.slice(end);
    }

    return events;
  }
}

const defaultReraiseSignal = (signal: TerminationSignal): void => {
  process.kill(process.pid, signal);
};

export function multilineText(
  question: string,
  input: MultilineInput,
  output: Writable,
  lifecycle: LifecycleEmitter = process,
  reraiseSignal: (signal: TerminationSignal) => void = defaultReraiseSignal,
  options: MultilineTextOptions = {},
): Promise<string> {
  const rawMode = input.setRawMode?.bind(input);

  if (!rawMode) {
    throw new Error('Multiline input requires a terminal with raw input support.');
  }

  return new Promise<string>((resolve, reject) => {
    const decoder = new TerminalInputDecoder({
      enterSubmits: options.enterSubmits,
      ctrlDSubmits: options.ctrlDSubmits,
    });
    const utf8 = new StringDecoder('utf8');
    const wasRaw = input.isRaw ?? false;
    const enhancedModes = options.enhancedModes ?? true;
    let value = '';
    let settled = false;
    let modesEnabled = false;

    function restoreTerminal(): void {
      if (modesEnabled) {
        try {
          output.write(`${WIN32_INPUT_OFF}${KITTY_KEYS_OFF}${BRACKETED_PASTE_OFF}`);
        } catch {
          // Continue restoring raw mode even if the output stream died.
        }
        modesEnabled = false;
      }

      try {
        rawMode(wasRaw);
      } catch {
        // The input stream may already be closed.
      }
    }

    function onProcessExit(): void {
      restoreTerminal();
    }

    function removeLifecycleListeners(): void {
      lifecycle.removeListener('exit', onProcessExit);
      lifecycle.removeListener('SIGTERM', onSigterm);
      lifecycle.removeListener('SIGHUP', onSighup);
    }

    function cleanup(): boolean {
      if (settled) return false;
      settled = true;

      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
      removeLifecycleListeners();

      restoreTerminal();
      input.pause();
      return true;
    }

    function onTermination(signal: TerminationSignal): void {
      if (!cleanup()) return;

      try {
        reraiseSignal(signal);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      // Normally the re-raised signal terminates the process. If another
      // listener swallows it, reject instead of leaving a settled-looking UI
      // backed by a permanently pending Promise.
      reject(new PromptAborted());
    }

    function onSigterm(): void {
      onTermination('SIGTERM');
    }

    function onSighup(): void {
      onTermination('SIGHUP');
    }

    function finish(): void {
      const trimmed = value.trim();

      if (trimmed === '') {
        value = '';
        output.write('\n  A value is required.\n> ');
        return;
      }

      if (!cleanup()) return;
      output.write('\n');
      resolve(trimmed);
    }

    function abort(): void {
      if (!cleanup()) return;
      output.write('\n');
      reject(new PromptAborted());
    }

    function fail(error: unknown): void {
      if (!cleanup()) return;

      try {
        output.write('\n');
      } catch {
        // Preserve the original input failure.
      }

      reject(error instanceof Error ? error : new Error(String(error)));
    }

    const currentLine = (): string => value.slice(value.lastIndexOf('\n') + 1);

    const showEditSnapshot = (): void => {
      // Append-only feedback avoids cursor-row math on wrapped/wide Unicode.
      output.write(`\n\u001b[2m  edit: \u001b[0m${currentLine()}`);
    };

    const removeOne = (): boolean => {
      if (value === '') return false;

      if (value.endsWith('\n')) {
        value = value.slice(0, -1);
        return true;
      }

      const lineStart = value.lastIndexOf('\n') + 1;
      const line = value.slice(lineStart);
      value = `${value.slice(0, lineStart)}${removeLastGrapheme(line)}`;
      return true;
    };

    const apply = (event: MultilineInputEvent): boolean => {
      switch (event.type) {
        case 'text':
          if (event.text !== '') {
            value += event.text;
            output.write(event.text);
          }
          return false;
        case 'newline': {
          const count = event.count ?? 1;
          value += '\n'.repeat(count);
          output.write('\n'.repeat(count));
          return false;
        }
        case 'backspace': {
          const count = event.count ?? 1;
          let changed = false;

          for (let index = 0; index < count; index += 1) {
            changed = removeOne() || changed;
          }

          if (changed) showEditSnapshot();
          else output.write('\u0007');
          return false;
        }
        case 'submit':
          finish();
          return settled;
        case 'abort':
          abort();
          return true;
      }
    };

    function onData(chunk: Buffer | string): void {
      const text = typeof chunk === 'string' ? chunk : utf8.write(chunk);

      for (const event of decoder.feed(text)) {
        if (apply(event)) return;
      }
    }

    function onEnd(): void {
      abort();
    }

    function onError(error: Error): void {
      fail(error);
    }

    try {
      const submitHint = options.submitHint ?? 'Enter submits';
      const newlineHint =
        options.newlineHint ??
        (supportsShiftEnter()
          ? 'Shift+Enter/Ctrl+J adds a line'
          : 'Ctrl+J adds a line');
      const pasteSafe = options.pasteSafe ?? supportsBracketedPaste();
      const pasteHint = pasteSafe ? ' · paste is multiline-safe' : '';

      output.write(`\n${question}\n`);
      output.write(
        `\u001b[2m  ${submitHint} · ${newlineHint}${pasteHint}\u001b[0m\n> `,
      );

      rawMode(true);

      if (enhancedModes) {
        output.write(`${BRACKETED_PASTE_ON}${KITTY_KEYS_ON}${WIN32_INPUT_ON}`);
        modesEnabled = true;
      }

      lifecycle.once('exit', onProcessExit);
      lifecycle.once('SIGTERM', onSigterm);
      lifecycle.once('SIGHUP', onSighup);

      input.on('data', onData);
      input.once('end', onEnd);
      input.once('close', onEnd);
      input.once('error', onError);
      input.resume();
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * Safe fallback when paste boundaries/modifier protocols are not known.
 * Enter is always content; Ctrl+D is the only submit control.
 */
export function explicitSubmitMultilineText(
  question: string,
  input: MultilineInput,
  output: Writable,
): Promise<string> {
  return multilineText(
    question,
    input,
    output,
    process,
    defaultReraiseSignal,
    {
      enterSubmits: false,
      ctrlDSubmits: true,
      enhancedModes: false,
      submitHint: 'Ctrl+D submits',
      newlineHint: 'Enter adds a line',
      pasteSafe: true,
    },
  );
}

/** Backwards-compatible name for the native-Windows explicit-submit mode. */
export const windowsMultilineText = explicitSubmitMultilineText;
