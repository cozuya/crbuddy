import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  TerminalInputDecoder,
  type MultilineInputEvent,
} from '../src/util/multiline-prompt.js';

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

test('legacy Enter submits while Ctrl+J adds a newline', () => {
  assert.deepEqual(decode('\r'), [{ type: 'submit' }]);
  assert.deepEqual(decode('\n'), [{ type: 'newline' }]);
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
