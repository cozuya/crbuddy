import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeTerminalInline, stripTerminalControls } from '../src/util/ansi.js';

test('unterminated OSC removes only its malformed line and preserves later text', () => {
  const input = 'First line\n\x1b]0;unterminated title\nSecond line\nThird line';
  assert.equal(
    stripTerminalControls(input),
    'First line\n\nSecond line\nThird line',
  );
  assert.equal(
    sanitizeTerminalInline(input),
    'First line Second line Third line',
  );
});
