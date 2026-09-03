import assert from 'node:assert/strict';
import { test } from 'node:test';

import { geminiCanUsePromptArg } from '../src/adapters/vendors.js';
import {
  supportsBracketedPaste,
  supportsShiftEnter,
  TerminalInputDecoder,
} from '../src/util/multiline-prompt.js';

test('Gemini keeps multiline prompts out of cmd.exe argv on native Windows', () => {
  assert.equal(geminiCanUsePromptArg('single line', 'win32'), true);
  assert.equal(geminiCanUsePromptArg('first\nsecond', 'win32'), false);
  assert.equal(geminiCanUsePromptArg('first\r\nsecond', 'win32'), false);
  assert.equal(geminiCanUsePromptArg('first\nsecond', 'linux'), true);
});

test('Win32 input honors repeat counts for editing and structural keys', () => {
  const decoder = new TerminalInputDecoder();

  assert.deepEqual(decoder.feed('\u001b[8;14;0;1;0;3_'), [
    { type: 'backspace', count: 3 },
  ]);
  assert.deepEqual(decoder.feed('\u001b[13;28;13;1;16;2_'), [
    { type: 'newline', count: 2 },
  ]);
  assert.deepEqual(decoder.feed('\u001b[9;15;9;1;0;3_'), [
    { type: 'text', text: '\t\t\t' },
  ]);
  assert.deepEqual(decoder.feed('\u001b[74;36;0;1;4;2_'), [
    { type: 'newline', count: 2 },
  ]);
});

test('Win32 input accepts documented omitted/defaulted fields', () => {
  const decoder = new TerminalInputDecoder();

  assert.deepEqual(decoder.feed('\u001b[13;;13;1;;_'), [{ type: 'submit' }]);
});

test('paste and Shift+Enter are advertised only for known capable terminals', () => {
  assert.equal(
    supportsBracketedPaste('linux', { TERM_PROGRAM: 'Apple_Terminal' }),
    false,
  );
  assert.equal(supportsShiftEnter('linux', { TERM_PROGRAM: 'Apple_Terminal' }), false);

  // iTerm reliably supports bracketed paste, but app-controlled key reporting
  // (needed to distinguish Shift+Enter) can be disabled per profile.
  assert.equal(
    supportsBracketedPaste('darwin', { TERM_PROGRAM: 'iTerm.app' }),
    true,
  );
  assert.equal(supportsShiftEnter('darwin', { TERM_PROGRAM: 'iTerm.app' }), false);

  assert.equal(supportsBracketedPaste('linux', { TERM_PROGRAM: 'vscode' }), true);
  assert.equal(supportsShiftEnter('linux', { TERM_PROGRAM: 'vscode' }), true);
});
