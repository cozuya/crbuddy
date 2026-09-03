import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clipboardCandidates,
  encodeForClipboard,
  isWsl,
} from '../src/util/clipboard.js';

test('WSL uses the Windows clipboard before Linux graphical fallbacks', () => {
  const candidates = clipboardCandidates('linux', {
    WSL_DISTRO_NAME: 'Ubuntu',
  });

  assert.deepEqual(candidates.map((candidate) => candidate.command), [
    'clip.exe',
    'wl-copy',
    'xclip',
    'xsel',
  ]);
  assert.equal(candidates[0]?.encoding, 'utf16le');
});

test('ordinary Linux does not assume Windows interop', () => {
  assert.equal(isWsl('linux', {}), false);
  assert.deepEqual(
    clipboardCandidates('linux', {}).map((candidate) => candidate.command),
    ['wl-copy', 'xclip', 'xsel'],
  );
});

test('WSL_INTEROP is sufficient to detect WSL', () => {
  assert.equal(isWsl('linux', { WSL_INTEROP: '/run/WSL/123_interop' }), true);
});

test('native Windows uses clip.exe with UTF-16LE', () => {
  assert.deepEqual(clipboardCandidates('win32', {}), [
    { command: 'clip.exe', args: [], encoding: 'utf16le' },
  ]);
});

test('clip.exe encoding preserves non-ASCII report text', () => {
  const text = 'P2 — C1, C2… café';
  const encoded = encodeForClipboard(text, 'utf16le');

  assert.equal(encoded.toString('utf16le'), text);
});
