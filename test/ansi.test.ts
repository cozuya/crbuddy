import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sanitizeTerminalInline, stripTerminalControls } from '../src/util/ansi.js';

test('inline sanitizing removes characters that reorder or hide text', () => {
  // U+202E would show "review.md" reversed around the real extension.
  assert.equal(sanitizeTerminalInline('../\u202Edm.weiver\u202C.md'), '../dm.weiver.md');
  assert.equal(
    sanitizeTerminalInline('a\u2066b\u2069c\u200Bd\u200Fe\uFEFFf\u061Cg\u2060h'),
    'abcdefgh',
  );
  // Ordinary non-ASCII text is untouched.
  assert.equal(sanitizeTerminalInline('répertoire/レビュー.md'), 'répertoire/レビュー.md');
});

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
