import { StringDecoder } from 'node:string_decoder';
import type { Readable, Writable } from 'node:stream';

import { PromptAborted } from './prompt.js';
import { stripAnsi } from './ansi.js';

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

interface ExitEmitter {
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
}

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
// through a VT stream. This is useful to Unix-side clients such as WSL; native
// Node on Windows consumes console INPUT_RECORDs before this representation is
// exposed, so native Windows falls back to Ctrl+J for a newline.
const WIN32_INPUT_ON = `${ESC}[?9001h`;
const WIN32_INPUT_OFF = `${ESC}[?9001l`;

const CTRL_MASK = 0b100;
const SHIFT_MASK = 0b001;
const WIN32_CTRL_MASK = 0x0004 | 0x0008;
const WIN32_SHIFT_MASK = 0x0010;
const ERASE_LINE = `${ESC}[2K`;
const CURSOR_UP = `${ESC}[1A`;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function longestMarkerPrefixSuffix(value: string, marker: string): number {
  const max = Math.min(value.length, marker.length - 1);

  for (let length = max; length > 0; length -= 1) {
    if (marker.startsWith(value.slice(-length))) return length;
  }

  return 0;
}

function isFallbackTextCodePoint(code: number): boolean {
  if (code < 0x20 || code > 0x10ffff) return false;
  if (code >= 0x7f && code <= 0x9f) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;

  // Kitty reserves the BMP Private Use Area for functional keys. Literal PUA
  // text is still preserved when it arrives through the associated-text field;
  // it must never be synthesized from the functional key code itself.
  if (code >= 0xe000 && code <= 0xf8ff) return false;

  return true;
}

function sanitizeAssociatedText(codes: number[]): string {
  return codes
    .filter(isFallbackTextCodePoint)
    .map((code) => String.fromCodePoint(code))
    .join('');
}

function sanitizePastedText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, '\n')
    // Keep only the controls that are meaningful instruction text: tab and LF.
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
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

  // Structural editor keys win even if a terminal supplies associated text.
  if (keyCode === 13) return { type: shift ? 'newline' : 'submit' };
  if (keyCode === 127) return { type: 'backspace' };
  if (keyCode === 9) return { type: 'text', text: '\t' };

  const textCodes = (fields[2] ?? '')
    .split(':')
    .filter((value) => value !== '')
    .map(Number)
    .filter((code) => Number.isInteger(code) && code > 0 && code <= 0x10ffff);
  const associatedText = sanitizeAssociatedText(textCodes);

  // Text-producing events take precedence over Ctrl shortcut interpretation.
  // This is required for layouts where AltGr is represented as Ctrl+Alt.
  if (associatedText !== '') return { type: 'text', text: associatedText };

  if (ctrl && (keyCode === 99 || keyCode === 67)) return { type: 'abort' };
  if (ctrl && (keyCode === 106 || keyCode === 74)) return { type: 'newline' };

  // Associated text is requested above, but retain a conservative fallback
  // for terminals that report ordinary printable keys without that field.
  // Kitty functional keys occupy the PUA and are deliberately excluded.
  if (!ctrl && isFallbackTextCodePoint(keyCode)) {
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

  // Structural editor keys are handled before printable text.
  if (virtualKey === 13) return { type: shift ? 'newline' : 'submit' };
  if (virtualKey === 8) return { type: 'backspace' };
  if (virtualKey === 9) return { type: 'text', text: '\t' };

  // A printable Unicode result means this is text input, even when Windows
  // also reports Ctrl+Alt (AltGr). Never turn a composed character into a
  // Ctrl+C/Ctrl+J editor shortcut.
  if (isFallbackTextCodePoint(unicodeChar)) {
    return { type: 'text', text: String.fromCharCode(unicodeChar).repeat(repeatCount) };
  }

  if (ctrl && virtualKey === 67) return { type: 'abort' }; // C
  if (ctrl && virtualKey === 74) return { type: 'newline' }; // J

  return { type: 'text', text: '' };
}

function removeLastGrapheme(text: string): string {
  let lastIndex = -1;

  for (const segment of GRAPHEMES.segment(text)) {
    lastIndex = segment.index;
  }

  return lastIndex < 0 ? text : text.slice(0, lastIndex);
}

/**
 * Stateful byte-stream decoder for the small terminal protocol surface the
 * review-instructions editor needs. Keeping this pure makes chunk-boundary
 * behavior deterministic and unit-testable.
 */
export class TerminalInputDecoder {
  private pending = '';
  private inPaste = false;
  private pasteBuffer = '';

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

        // Keep only a possible partial paste-end marker in `pending`; buffering
        // the paste body until the marker arrives makes CRLF and ANSI parsing
        // independent of arbitrary PTY chunk boundaries.
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

        // Match the exact grammar win32Event accepts. A looser prefix matcher
        // can consume a sequence and then silently discard it when parsing
        // fails.
        const win32 = /^\u001b\[[0-9]+;[0-9]+;[0-9]+;[01];[0-9]+;[0-9]+_/.exec(
          this.pending,
        )?.[0];
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

        // SS3 is the common application-cursor encoding (ESC O A, etc.). Do
        // not leak the printable tail into the saved instructions.
        if (this.pending.startsWith(`${ESC}O`)) {
          if (this.pending.length < 3) break;
          this.pending = this.pending.slice(3);
          continue;
        }

        // Alt/meta keys arrive as ESC plus the ordinary key in legacy mode.
        // Neither byte is instruction text, so consume the pair together.
        this.pending = this.pending.slice(2);
        continue;
      }

      if (first === '\t') {
        this.pending = this.pending.slice(1);
        events.push({ type: 'text', text: '\t' });
        continue;
      }

      const code = first.charCodeAt(0);
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
        // Raw-mode editing keys such as Ctrl+A/Ctrl+D/Ctrl+U are control
        // events, not text. Ignore unsupported ones rather than persisting
        // invisible bytes into config.json.
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

/**
 * Paste-safe multiline editor for long reviewer instructions.
 *
 * Enter submits. Shift+Enter adds a newline where the terminal protocol
 * exposes the modifier; Ctrl+J is always the explicit newline fallback.
 */
export function multilineText(
  question: string,
  input: MultilineInput,
  output: Writable,
  exitEmitter: ExitEmitter = process,
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
          // Terminal restoration must continue even if the output stream died.
        }
        modesEnabled = false;
      }

      try {
        setRawMode.call(input, wasRaw);
      } catch {
        // The input stream may already be closed; there is nothing left to restore.
      }
    };

    const onProcessExit = (): void => {
      // `exit` is synchronous and there is no next prompt to resume. Best effort
      // restoration prevents a normal process.exit() path from stranding modes.
      restoreTerminal();
    };

    const cleanup = (): boolean => {
      if (settled) return false;
      settled = true;

      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      input.removeListener('close', onEnd);
      input.removeListener('error', onError);
      exitEmitter.removeListener('exit', onProcessExit);

      restoreTerminal();
      input.pause();
      return true;
    };

    const finish = (): void => {
      const trimmed = value.trim();
      if (trimmed === '') {
        output.write('\u0007');
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

    const currentLine = (): { lineStart: number; line: string; prefix: string } => {
      const lineStart = value.lastIndexOf('\n') + 1;
      return {
        lineStart,
        line: value.slice(lineStart),
        prefix: lineStart === 0 ? '> ' : '',
      };
    };

    const redrawCurrentLine = (): void => {
      const { line, prefix } = currentLine();
      output.write(`\r${ERASE_LINE}${prefix}${line}`);
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
            // Join the current empty line back onto the preceding one. Move the
            // terminal cursor up and redraw that logical line so editing can
            // continue naturally across a newline boundary.
            value = value.slice(0, -1);
            const { line, prefix } = currentLine();
            output.write(`${CURSOR_UP}\r${ERASE_LINE}${prefix}${line}`);
            return false;
          }

          const { lineStart, line } = currentLine();
          value = `${value.slice(0, lineStart)}${removeLastGrapheme(line)}`;
          redrawCurrentLine();
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
      const newlineHint =
        process.platform === 'win32'
          ? 'Ctrl+J adds a line'
          : 'Shift+Enter/Ctrl+J adds a line';

      output.write(`\n${question}\n`);
      output.write(
        `\u001b[2m  Enter submits · ${newlineHint} · paste is multiline-safe\u001b[0m\n> `,
      );

      setRawMode.call(input, true);
      output.write(`${BRACKETED_PASTE_ON}${KITTY_KEYS_ON}${WIN32_INPUT_ON}`);
      modesEnabled = true;
      exitEmitter.once('exit', onProcessExit);

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
