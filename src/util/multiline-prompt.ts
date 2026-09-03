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

const ESC = '\u001b';
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

const BRACKETED_PASTE_ON = `${ESC}[?2004h`;
const BRACKETED_PASTE_OFF = `${ESC}[?2004l`;

// Kitty's report-all-keys + associated-text flags make Shift+Enter distinct
// without sacrificing ordinary Unicode text input. Unsupported terminals
// ignore the sequence.
const KITTY_KEYS_ON = `${ESC}[>24u`;
const KITTY_KEYS_OFF = `${ESC}[<u`;

// Windows Terminal / ConPTY can report the Win32 key record, including Shift,
// through a VT stream. Unsupported terminals ignore this private mode.
const WIN32_INPUT_ON = `${ESC}[?9001h`;
const WIN32_INPUT_OFF = `${ESC}[?9001l`;

const CTRL_MASK = 0b100;
const SHIFT_MASK = 0b001;
const WIN32_CTRL_MASK = 0x0004 | 0x0008;
const WIN32_SHIFT_MASK = 0x0010;

function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

function longestMarkerPrefixSuffix(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);

  for (let length = max; length > 0; length -= 1) {
    if (marker.startsWith(value.slice(-length))) return length;
  }

  return 0;
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

  // 1 = press, 2 = repeat, 3 = release. Releases must never mutate the value.
  if (eventType === 3) return { type: 'text', text: '' };

  const modifiers = Math.max(0, encodedModifiers - 1);
  const shift = Boolean(modifiers & SHIFT_MASK);
  const ctrl = Boolean(modifiers & CTRL_MASK);

  if (ctrl && (keyCode === 99 || keyCode === 67)) return { type: 'abort' };
  if (ctrl && (keyCode === 106 || keyCode === 74)) return { type: 'newline' };
  if (keyCode === 13) return { type: shift ? 'newline' : 'submit' };
  if (keyCode === 127) return { type: 'backspace' };
  if (keyCode === 9) return { type: 'text', text: '\t' };

  const textCodes = (fields[2] ?? '')
    .split(':')
    .filter((value) => value !== '')
    .map(Number)
    .filter((code) => Number.isInteger(code) && code > 0 && code <= 0x10ffff);

  if (textCodes.length > 0) {
    return { type: 'text', text: String.fromCodePoint(...textCodes) };
  }

  // Associated text is requested above, but retain a conservative fallback
  // for terminals that implement report-all-keys without the text field.
  if (!ctrl && keyCode >= 0x20 && keyCode <= 0x10ffff) {
    let text = String.fromCodePoint(keyCode);
    if (shift && /^[a-z]$/.test(text)) text = text.toUpperCase();
    return { type: 'text', text };
  }

  return { type: 'text', text: '' };
}

function win32Event(sequence: string): MultilineInputEvent | null {
  const match = /^\u001b\[([0-9]+);([0-9]+);([0-9]+);([01]);([0-9]+);([0-9]+)_$/.exec(
    sequence,
  );
  if (!match) return null;

  const virtualKey = Number(match[1]);
  const unicodeChar = Number(match[3]);
  const keyDown = match[4] === '1';
  const controlState = Number(match[5]);
  const repeatCount = Math.max(1, Math.min(1000, Number(match[6]) || 1));

  if (!keyDown) return { type: 'text', text: '' };

  const ctrl = Boolean(controlState & WIN32_CTRL_MASK);
  const shift = Boolean(controlState & WIN32_SHIFT_MASK);

  if (ctrl && virtualKey === 67) return { type: 'abort' }; // C
  if (ctrl && virtualKey === 74) return { type: 'newline' }; // J
  if (virtualKey === 13) return { type: shift ? 'newline' : 'submit' };
  if (virtualKey === 8) return { type: 'backspace' };
  if (virtualKey === 9) return { type: 'text', text: '\t' };

  if (unicodeChar >= 0x20 && unicodeChar <= 0xffff) {
    return { type: 'text', text: String.fromCharCode(unicodeChar).repeat(repeatCount) };
  }

  return { type: 'text', text: '' };
}

/**
 * Stateful byte-stream decoder for the small terminal protocol surface the
 * review-instructions editor needs. Keeping this pure makes chunk-boundary
 * behavior deterministic and unit-testable.
 */
export class TerminalInputDecoder {
  private pending = '';
  private inPaste = false;

  feed(chunk: string): MultilineInputEvent[] {
    this.pending += chunk;
    const events: MultilineInputEvent[] = [];

    for (;;) {
      if (this.pending === '') break;

      if (this.inPaste) {
        const end = this.pending.indexOf(PASTE_END);

        if (end >= 0) {
          if (end > 0) {
            events.push({
              type: 'text',
              text: normalizePastedText(this.pending.slice(0, end)),
            });
          }
          this.pending = this.pending.slice(end + PASTE_END.length);
          this.inPaste = false;
          continue;
        }

        const keep = longestMarkerPrefixSuffix(this.pending, PASTE_END);
        const ready = this.pending.slice(0, this.pending.length - keep);
        if (ready !== '') {
          events.push({ type: 'text', text: normalizePastedText(ready) });
        }
        this.pending = this.pending.slice(this.pending.length - keep);
        break;
      }

      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.inPaste = true;
        continue;
      }

      if (PASTE_START.startsWith(this.pending)) break;

      const first = this.pending[0]!;

      if (first === '\r') {
        this.pending = this.pending.slice(this.pending.startsWith('\r\n') ? 2 : 1);
        events.push({ type: 'submit' });
        continue;
      }

      // In legacy raw terminal input, Ctrl+J is LF while Enter is CR.
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

        const win32 = /^\u001b\[[0-9;]+_/.exec(this.pending)?.[0];
        if (win32) {
          this.pending = this.pending.slice(win32.length);
          const event = win32Event(win32);
          if (event) events.push(event);
          continue;
        }

        if (this.pending.startsWith(`${ESC}[`)) {
          // Ignore unrelated complete CSI sequences (arrows, terminal replies,
          // etc.). If the final byte has not arrived, retain the fragment.
          const csi = /^\u001b\[[0-?]*[ -/]*[@-~]/.exec(this.pending)?.[0];
          if (!csi) break;
          this.pending = this.pending.slice(csi.length);
          continue;
        }

        // Unknown single-escape sequence: discard Escape and keep parsing the
        // following byte as ordinary input.
        this.pending = this.pending.slice(1);
        continue;
      }

      const nextControl = this.pending.search(/[\u001b\r\n\u0003\u007f\b]/);
      const end = nextControl <= 0 ? this.pending.length : nextControl;
      events.push({ type: 'text', text: this.pending.slice(0, end) });
      this.pending = this.pending.slice(end);
    }

    return events;
  }
}

/**
 * Paste-safe multiline editor for long reviewer instructions.
 *
 * Enter submits. Shift+Enter adds a newline when the terminal exposes the
 * modifier through Kitty or Win32 input mode; Ctrl+J is the legacy fallback.
 */
export function multilineText(
  question: string,
  input: MultilineInput,
  output: Writable,
): Promise<string> {
  if (typeof input.setRawMode !== 'function') {
    throw new Error('Multiline input requires a terminal with raw input support.');
  }

  return new Promise<string>((resolve, reject) => {
    const decoder = new TerminalInputDecoder();
    const utf8 = new StringDecoder('utf8');
    const wasRaw = input.isRaw ?? false;
    const wasFlowing = input.readableFlowing;
    let value = '';
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      input.removeListener('data', onData);
      output.write(`${WIN32_INPUT_OFF}${KITTY_KEYS_OFF}${BRACKETED_PASTE_OFF}`);
      input.setRawMode?.(wasRaw);
      if (wasFlowing !== true) input.pause();
    };

    const finish = (): void => {
      const trimmed = value.trim();
      if (trimmed === '') {
        output.write('\u0007');
        return;
      }
      cleanup();
      output.write('\n');
      resolve(trimmed);
    };

    const abort = (): void => {
      cleanup();
      output.write('\n');
      reject(new PromptAborted());
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
          if (value === '' || value.endsWith('\n')) {
            output.write('\u0007');
            return false;
          }
          const codepoints = Array.from(value);
          codepoints.pop();
          value = codepoints.join('');
          output.write('\b \b');
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

    output.write(`\n${question}\n`);
    output.write(
      '\u001b[2m  Enter submits · Shift+Enter/Ctrl+J adds a line · paste is multiline-safe\u001b[0m\n> ',
    );
    output.write(`${BRACKETED_PASTE_ON}${KITTY_KEYS_ON}${WIN32_INPUT_ON}`);

    input.setRawMode?.(true);
    input.resume();
    input.on('data', onData);
  });
}
