import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  multilineTerminalHints,
  TerminalInputDecoder,
} from '../src/util/multiline-prompt.js';

test('Kitty shortcut modifiers do not fall back to literal key text', () => {
  const decoder = new TerminalInputDecoder();

  // Kitty encodes modifiers as bitmask + 1: Alt=3, Super=9, Hyper=17, Meta=33.
  assert.deepEqual(decoder.feed('\u001b[98;3u'), []);
  assert.deepEqual(decoder.feed('\u001b[98;9u'), []);
  assert.deepEqual(decoder.feed('\u001b[98;17u'), []);
  assert.deepEqual(decoder.feed('\u001b[98;33u'), []);
});

test('Kitty associated text still wins over shortcut modifiers', () => {
  const decoder = new TerminalInputDecoder();

  assert.deepEqual(decoder.feed('\u001b[99;7;263u'), [
    { type: 'text', text: 'ć' },
  ]);
});

test('shared multiline hints follow the injected terminal capabilities', () => {
  assert.deepEqual(multilineTerminalHints('win32', { KITTY_WINDOW_ID: '1' }), {
    newlineHint: 'Ctrl+J adds a line',
    pasteSafe: false,
  });

  assert.deepEqual(multilineTerminalHints('linux', { KITTY_WINDOW_ID: '1' }), {
    newlineHint: 'Shift+Enter/Ctrl+J adds a line',
    pasteSafe: true,
  });

  assert.deepEqual(multilineTerminalHints('darwin', { TERM_PROGRAM: 'iTerm.app' }), {
    newlineHint: 'Ctrl+J adds a line',
    pasteSafe: true,
  });
});
