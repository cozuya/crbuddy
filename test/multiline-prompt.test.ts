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
  assert.equal(events.some((event) => event.type === 'submit'), false);
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

test('SS3 cursor keys and Alt/meta keys do not leak printable tails', () => {
  assert.equal(textOf(decode('\u001bO', 'Ahello')), 'hello');
  assert.equal(textOf(decode('\u001bxhello')), 'hello');
});

test('kitty input distinguishes Shift+Enter and preserves typed text', () => {
  assert.deepEqual(decode('\u001b[13;2u'), [{ type: 'newline' }]);
  assert.deepEqual(decode('\u001b[13u'), [{ type: 'submit' }]);
  assert.deepEqual(decode('\u001b[106;5u'), [{ type: 'newline' }]);
  assert.deepEqual(decode('\u001b[99;5u'), [{ type: 'abort' }]);
  assert.deepEqual(decode('\u001b[97;1;97u'), [{ type: 'text', text: 'a' }]);
});

test('Win32 input mode distinguishes Shift+Enter from Enter', () => {
  assert.deepEqual(decode('\u001b[13;28;13;1;16;1_'), [{ type: 'newline' }]);
  assert.deepEqual(decode('\u001b[13;28;13;1;0;1_'), [{ type: 'submit' }]);
});

test('Win32 input ignores key-up records and emits Unicode key-down text', () => {
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

test('backspace deletes one grapheme and redraws the logical line', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const written = capture(output);
  const result = multilineText('Review instructions', input, output);

  input.write('A👨‍👩‍👧‍👦');
  input.write('\u007f');
  input.write('\r');

  assert.equal(await result, 'A');
  assert.deepEqual(input.rawStates, [true, false]);
  assert.match(written(), /\r\u001b\[2K> A/);
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
