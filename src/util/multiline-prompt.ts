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
  | { type: 'newline' }
  | { type: 'submit' }
  | { type: 'backspace' }
  | { type: 'abort' };

type TerminationSignal = 'SIGTERM' | 'SIGHUP';

interface LifecycleEmitter {
  // Match Node's EventEmitter listener shape so `process` is structurally
  // assignable while tests can still supply a tiny fake lifecycle emitter.
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}

interface Win32Utf16Unit {
  type: 'utf16';
  unit: number;
  repeatCount: number;
}

type Win32Decoded = MultilineInputEvent | Win32Utf16Unit;

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

  // Kitty reserves the BMP Private Use Area for functional keys. Associated
  // text is different: a literal PUA character supplied there remains text.
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

function kittyEvent(sequence: string): MultilineInputEvent | null {
  const match = /^\u001b\[([0-9:;]*)u$/.exec(sequence);
  if (!match) return null;

  const fields = match[1]!.split(';');
  const keyCode = Number((fields[0] ?? '').split(':', 1)[0]);
  if (!Number.isInteger(keyCode)) return null;

  const modifierParts = (fields[1] ?? '').split(':');
  const encodedModifiers = Number(modifierParts[0] || '1');
  const eventType = Number(modifierParts[1] || '1');

  if (eventType === 3) return { type: 'text', text: '' };

  const modifiers = Math.max(0, encodedModifiers - 1);
  const shift = Boolean(modifiers & SHIFT_MASK);
  const ctrl = Boolean(modifiers & CTRL_MASK);

  if (keyCode === 13) return { type: shift ? 'newline' : 'submit' };
  if (keyCode === 127) return { type: 'backspace' };
  if (keyCode === 9) return { type: 'text', text: '\t' };

  const textCodes = (fields[2] ?? '')
    .split(':')
    .filter((value) => value !== '')
    .map(Number)
    .filter((code) => Number.isInteger(code) && code > 0 && code <= 0x10ffff);
  const associatedText = sanitizeAssociatedText(textCodes);

  if (associatedText !== '') return { type: 'text', text: associatedText };

  if (ctrl && (keyCode === 99 || keyCode === 67)) return { type: 'abort' };
  if (ctrl && (keyCode === 106 || keyCode === 74)) return { type: 'newline' };

  if (!ctrl && isKittyFallbackTextCodePoint(keyCode)) {
    let text = String.fromCodePoint(keyCode);
    if (shift && /^[a-z]$/.test(text)) text = text.toUpperCase();
    return { type: 'text', text };
  }

  return { type: 'text', text: '' };
}

function win32Event(sequence: string): Win32Decoded | null {
  const match = /^\u001b\[([0-9]*);([0-9]*);([0-9]*);([01]?);([0-9]*);([0-9]*)_$/.exec(
    sequence,
  );
  if (!match) return null;

  const virtualKey = Number(match[1] || '0');
  const unicodeChar = Number(match[3] || '0');
  const keyDown = (match[4] || '0') === '1';
  const controlState = Number(match[5] || '0');
  const repeatCount = Math.max(1, Math.min(1000, Number(match[6] || '1') || 1));

  if (!keyDown) return { type: 'text', text: '' };

  const ctrl = Boolean(controlState & WIN32_CTRL_MASK);
  const shift = Boolean(controlState & WIN32_SHIFT_MASK);

  if (virtualKey === 13) return { type: shift ? 'newline' : 'submit' };
  if (virtualKey === 8) return { type: 'backspace' };
  if (virtualKey === 9) return { type: 'text', text: '\t' };

  if (unicodeChar >= 0xd800 && unicodeChar <= 0xdfff) {
    return { type: 'utf16', unit: unicodeChar, repeatCount };
  }

  if (isTextScalar(unicodeChar)) {
    return {
      type: 'text',
      text: String.fromCharCode(unicodeChar).repeat(repeatCount),
    };
  }

  if (ctrl && virtualKey === 67) return { type: 'abort' };
  if (ctrl && virtualKey === 74) return { type: 'newline' };

  return { type: 'text', text: '' };
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

/** Whether the active terminal is known to expose Shift+Enter distinctly. */
export function supportsShiftEnter(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  if (platform === 'win32') return false;
  if (environment.WT_SESSION) return true;
  if (environment.KITTY_WINDOW_ID) return true;

  const term = environment.TERM?.toLowerCase() ?? '';
  if (term.includes('kitty')) return true;

  const program = environment.TERM_PROGRAM?.toLowerCase();
  return program === 'vscode';
}

export class TerminalInputDecoder {
  private pending = '';
  private inPaste = false;
  private pasteBuffer = '';
  private pendingWin32HighSurrogate: { unit: number; repeatCount: number } | null = null;

  private appendWin32Event(
    decoded: Win32Decoded | null,
    events: MultilineInputEvent[],
  ): void {
    if (!decoded) return;

    if (decoded.type !== 'utf16') {
      // Win32 input mode may interleave key-up records between the UTF-16
      // high/low-surrogate key-down records. An empty text event is a no-op,
      // not a reason to discard a pending high surrogate.
      if (decoded.type === 'text' && decoded.text === '') return;

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
        this.pending = this.pending.slice(this.pending.startsWith('\r\n') ? 2 : 1);
        events.push({ type: 'submit' });
        continue;
      }

      if (first === '\n') {
        this.pending = this.pending.slice(1);
        events.push({ type: 'newline' });
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
          const event = kittyEvent(kitty);
          if (event) events.push(event);
          continue;
        }

        const win32 = /^\u001b\[[0-9]*;[0-9]*;[0-9]*;[01]?;[0-9]*;[0-9]*_/.exec(
          this.pending,
        )?.[0];
        if (win32) {
          this.pending = this.pending.slice(win32.length);
          this.appendWin32Event(win32Event(win32), events);
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

          // The CSI introducer has been followed by something that cannot be
          // part of a CSI sequence (CR, DEL, Unicode, another ESC, ...). Drop
          // only the introducer so that character is still handled normally.
          this.pending = this.pending.slice(2);
          continue;
        }

        if (this.pending.startsWith(`${ESC}O`)) {
          if (this.pending.length < 3) break;
          this.pending = this.pending.slice(3);
          continue;
        }

        // Unknown/standalone Escape is ignored by itself. Do not consume the
        // following character: it may be another sequence or ordinary text.
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

export function multilineText(
  question: string,
  input: MultilineInput,
  output: Writable,
  lifecycle: LifecycleEmitter = process,
  reraiseSignal: (signal: TerminationSignal) => void = (signal) => {
    process.kill(process.pid, signal);
  },
): Promise<string> {
  const setRawMode = input.setRawMode;

  if (typeof setRawMode !== 'function') {
    throw new Error('Multiline input requires a terminal with raw input support.');
  }

  return new Promise<string>((resolve, reject) => {
    const decoder = new TerminalInputDecoder();
    const utf8 = new StringDecoder('utf8');
    const wasRaw = input.isRaw ?? false;
    let value = '';
    let settled = false;
    let modesEnabled = false;

    const restoreTerminal = (): void => {
      if (modesEnabled) {
        try {
          output.write(`${WIN32_INPUT_OFF}${KITTY_KEYS_OFF}${BRACKETED_PASTE_OFF}`);
        } catch {
          // Continue restoring raw mode even if the output stream died.
        }
        modesEnabled = false;
      }

      try {
        setRawMode.call(input, wasRaw);
      } catch {
        // The input stream may already be closed.
      }
    };

    const onProcessExit = (): void => {
      restoreTerminal();
    };

    const removeLifecycleListeners = (): void => {
      lifecycle.removeListener('exit', onProcessExit);
      lifecycle.removeListener('SIGTERM', onSigterm);
      lifecycle.removeListener('SIGHUP', onSighup);
    };

    const onTermination = (signal: TerminationSignal): void => {
      restoreTerminal();
      input.pause();
      removeLifecycleListeners();
      reraiseSignal(signal);
    };

    const onSigterm = (): void => onTermination('SIGTERM');
    const onSighup = (): void => onTermination('SIGHUP');

    const cleanup = (): boolean => {
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
    };

    const finish = (): void => {
      const trimmed = value.trim();

      if (trimmed === '') {
        value = '';
        output.write('\n  A value is required.\n> ');
        return;
      }

      if (!cleanup()) return;
      output.write('\n');
      resolve(trimmed);
    };

    const abort = (): void => {
      if (!cleanup()) return;
      output.write('\n');
      reject(new PromptAborted());
    };

    const fail = (error: unknown): void => {
      if (!cleanup()) return;

      try {
        output.write('\n');
      } catch {
        // Preserve the original input failure.
      }

      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const currentLine = (): string => value.slice(value.lastIndexOf('\n') + 1);

    const showEditSnapshot = (): void => {
      // Append-only edit feedback cannot corrupt wrapped terminal rows. It is
      // deliberately less clever than cursor arithmetic, which requires exact
      // terminal-cell widths for wide/combining Unicode.
      output.write(`\n\u001b[2m  edit: \u001b[0m${currentLine()}`);
    };

    const apply = (event: MultilineInputEvent): boolean => {
      switch (event.type) {
        case 'text':
          if (event.text !== '') {
            value += event.text;
            output.write(event.text);
          }
          return false;
        case 'newline':
          value += '\n';
          output.write('\n');
          return false;
        case 'backspace': {
          if (value === '') {
            output.write('\u0007');
            return false;
          }

          if (value.endsWith('\n')) {
            value = value.slice(0, -1);
            showEditSnapshot();
            return false;
          }

          const lineStart = value.lastIndexOf('\n') + 1;
          const line = value.slice(lineStart);
          value = `${value.slice(0, lineStart)}${removeLastGrapheme(line)}`;
          showEditSnapshot();
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
      const newlineHint = supportsShiftEnter()
        ? 'Shift+Enter/Ctrl+J adds a line'
        : 'Ctrl+J adds a line';

      output.write(`\n${question}\n`);
      output.write(
        `\u001b[2m  Enter submits · ${newlineHint} · paste is multiline-safe\u001b[0m\n> `,
      );

      setRawMode.call(input, true);
      output.write(`${BRACKETED_PASTE_ON}${KITTY_KEYS_ON}${WIN32_INPUT_ON}`);
      modesEnabled = true;
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
