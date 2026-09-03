import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import {
  multilineText,
  TerminalInputDecoder,
  type MultilineInputEvent,
} from '../src/util/multiline-prompt.js';
import { PromptAborted } from '../src/util/prompt.js';

function decode(...chunks: string[]): MultilineInputEvent[] {
  const decoder = new TerminalInputDecoder();
  return chunks.flatMap((chunk) => decoder.feed(chunk));
}

function textOf(events: MultilineInputEvent[]): string {
  return events
    .filter((event): event is Extract<MultilineInputEvent, { type: 'text' }> =>
      event.type === 'text',
    )
    .map((event) => event.text)
    .join('');
}

class TtyInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  readonly rawStates: boolean[] = [];

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
    this.rawStates.push(enabled);
  }
}

class FakeExitEmitter {
  listener: (() => void) | null = null;

  once(event: 'exit', listener: () => void): void {
    assert.equal(event, 'exit');
    this.listener = listener;
  }

  removeListener(event: 'exit', listener: () => void): void {
    assert.equal(event, 'exit');
    if (this.listener === listener) this.listener = null;
  }
}

function capture(stream: PassThrough): () => string {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    value += chunk;
  });
  return () => value;
}

test('bracketed multiline paste never turns embedded newlines into submit', () => {
  const events = decode(
    '\u001b[20',
    '0~first\nsecond\r\nthird\u001b[20',
    '1~',
  );

  assert.equal(textOf(events), 'first\nsecond\nthird');
  assert.equal(events.some((event) => event.type === 'submit'), false);
  assert.equal(events.some((event) => event.type === 'newline'), false);
});

test('bracketed paste preserves CRLF when the PTY splits between CR and LF', () => {
  const events = decode(
    '\u001b[200~first\r',
    '\nsecond\r',
    '\nthird\u001b[201~',
  );

  assert.equal(textOf(events), 'first\nsecond\nthird');
});

test('pasted OSC, CSI, and control bytes are stripped without losing visible text', () => {
  const events = decode(
    '\u001b[200~' +
      '\u001b]8;;https://example.com\u001b\\click\u001b]8;;\u001b\\' +
      '\u001b[31m red\u001b[0m' +
      '\u0000\u0007' +
      '\u001b]0;title\u0007 visible' +
      '\u001b[201~',
  );

  assert.equal(textOf(events), 'click red visible');
});

test('legacy Enter submits while Ctrl+J adds a newline', () => {
  assert.deepEqual(decode('\r'), [{ type: 'submit' }]);
  assert.deepEqual(decode('\n'), [{ type: 'newline' }]);
});

test('unsupported C0 controls are ignored instead of becoming instruction text', () => {
  const events = decode('a\u0001b\u0004c\u0015d\te');

  assert.equal(textOf(events), 'abcd\te');
  assert.equal(events.some((event) => event.type === 'abort'), false);
});

test('SS3 cursor keys are ignored and standalone Escape does not eat later input', () => {
  assert.equal(textOf(decode('\u001bO', 'Ahello')), 'hello');
  assert.equal(textOf(decode('\u001b', '\u001b[Ahello')), 'hello');
  assert.equal(textOf(decode('\u001b', 'hello')), 'hello');
});

test('kitty input distinguishes Shift+Enter and preserves typed text', () => {
  assert.deepEqual(decode('\u001b[13;2u'), [{ type: 'newline' }]);
  assert.deepEqual(decode('\u001b[13u'), [{ type: 'submit' }]);
  assert.deepEqual(decode('\u001b[106;5u'), [{ type: 'newline' }]);
  assert.deepEqual(decode('\u001b[99;5u'), [{ type: 'abort' }]);
  assert.deepEqual(decode('\u001b[97;1;97u'), [{ type: 'text', text: 'a' }]);
});

test('kitty functional PUA keys are ignored while literal associated PUA text survives', () => {
  assert.equal(textOf(decode('\u001b[57352;1u')), '');
  assert.equal(textOf(decode('\u001b[57441;2u')), '');
  assert.equal(textOf(decode('\u001b[97;1;57344u')), '\ue000');
});

test('kitty associated text wins over Ctrl shortcut interpretation for AltGr', () => {
  assert.deepEqual(decode('\u001b[99;7;263u'), [{ type: 'text', text: 'ć' }]);
});

test('Win32 input mode distinguishes Shift+Enter from Enter', () => {
  assert.deepEqual(decode('\u001b[13;28;13;1;16;1_'), [{ type: 'newline' }]);
  assert.deepEqual(decode('\u001b[13;28;13;1;0;1_'), [{ type: 'submit' }]);
});

test('Win32 printable AltGr text wins over Ctrl shortcuts', () => {
  assert.deepEqual(decode('\u001b[67;46;263;1;9;1_'), [
    { type: 'text', text: 'ć' },
  ]);
});

test('Win32 UTF-16 surrogate records combine into supplementary characters', () => {
  assert.deepEqual(
    decode(
      '\u001b[0;0;55357;1;0;1_',
      '\u001b[0;0;56832;1;0;1_',
    ),
    [{ type: 'text', text: '😀' }],
  );
});

test('Win32 input ignores key-up records and emits BMP Unicode key-down text', () => {
  assert.deepEqual(decode('\u001b[65;30;65;0;16;1_'), [
    { type: 'text', text: '' },
  ]);
  assert.deepEqual(decode('\u001b[65;30;65;1;16;1_'), [
    { type: 'text', text: 'A' },
  ]);
});

test('terminal control sequences may be split across arbitrary stream chunks', () => {
  assert.deepEqual(decode('\u001b[13;28;', '13;1;16;', '1_'), [
    { type: 'newline' },
  ]);
  assert.deepEqual(decode('\u001b[13;', '2u'), [{ type: 'newline' }]);
});

test('backspace deletes one grapheme without cursor-row rewriting', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const written = capture(output);
  const result = multilineText('Review instructions', input, output);

  input.write('A👨‍👩‍👧‍👦');
  input.write('\u007f');
  input.write('\r');

  assert.equal(await result, 'A');
  assert.deepEqual(input.rawStates, [true, false]);
  assert.match(written(), /edit: .*A/);
  assert.equal(written().includes('\u001b[2K'), false);
  assert.equal(written().includes('\u001b[1A'), false);
});

test('backspace can cross a newline without cursor-row rewriting', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const written = capture(output);
  const result = multilineText('Review instructions', input, output);

  input.write('first');
  input.write('\n');
  input.write('\u007f');
  input.write('\r');

  assert.equal(await result, 'first');
  assert.match(written(), /edit: .*first/);
  assert.equal(written().includes('\u001b[1A'), false);
});

test('editing a long wrapped line uses append-only snapshots instead of row arithmetic', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const written = capture(output);
  const result = multilineText('Review instructions', input, output);
  const long = 'x'.repeat(300);

  input.write(long);
  input.write('\u007f');
  input.write('\r');

  assert.equal(await result, 'x'.repeat(299));
  assert.equal(written().includes('\u001b[2K'), false);
  assert.equal(written().includes('\u001b[1A'), false);
});

test('empty submit shows validation and allows retry', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const written = capture(output);
  const result = multilineText('Review instructions', input, output);

  input.write('   ');
  input.write('\r');
  input.write('valid');
  input.write('\r');

  assert.equal(await result, 'valid');
  assert.match(written(), /A value is required\./);
});

test('unexpected stdin EOF restores raw and terminal modes before aborting', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const written = capture(output);
  const result = multilineText('Review instructions', input, output);

  input.end();

  await assert.rejects(result, PromptAborted);
  assert.equal(input.isRaw, false);
  assert.deepEqual(input.rawStates, [true, false]);
  assert.match(written(), /\u001b\[\?9001l/);
  assert.match(written(), /\u001b\[<u/);
  assert.match(written(), /\u001b\[\?2004l/);
});

test('process exit cleanup restores terminal modes synchronously', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const written = capture(output);
  const exits = new FakeExitEmitter();
  const result = multilineText('Review instructions', input, output, exits);

  assert.ok(exits.listener);
  exits.listener?.();

  assert.equal(input.isRaw, false);
  assert.match(written(), /\u001b\[\?9001l/);
  assert.match(written(), /\u001b\[<u/);
  assert.match(written(), /\u001b\[\?2004l/);

  input.end();
  await assert.rejects(result, PromptAborted);
});
