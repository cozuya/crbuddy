import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claudeAdapter, codexAdapter, geminiAdapter } from '../src/adapters/vendors.js';
import { displayNames } from '../src/commands/go.js';
import type { Adapter } from '../src/adapters/types.js';
import type { PanelEntry } from '../src/config/schema.js';

const adapters = new Map<string, Adapter>([
  ['claude', claudeAdapter],
  ['codex', codexAdapter],
  ['gemini', geminiAdapter],
]);

test('reviewer status labels include configured vendor-native effort', () => {
  const panel: PanelEntry[] = [
    { id: 'claude-opus', vendor: 'claude', model: 'opus', effort: 'xhigh' },
    { id: 'codex-sol', vendor: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    { id: 'gemini-flash', vendor: 'gemini', model: 'gemini-2.5-flash' },
  ];

  const names = displayNames(panel, adapters);

  assert.equal(names.get('claude-opus'), 'Claude Code (opus xhigh)');
  assert.equal(names.get('codex-sol'), 'Codex CLI (gpt-5.6-sol high)');
  assert.equal(names.get('gemini-flash'), 'Gemini CLI (gemini-2.5-flash)');
});

test('duplicate lane disambiguation treats different effort levels as different labels', () => {
  const panel: PanelEntry[] = [
    { id: 'one', vendor: 'claude', model: 'opus', effort: 'high' },
    { id: 'two', vendor: 'claude', model: 'opus', effort: 'xhigh' },
    { id: 'three', vendor: 'claude', model: 'opus', effort: 'high' },
  ];

  const names = displayNames(panel, adapters);

  assert.equal(names.get('one'), 'Claude Code (opus high) [one]');
  assert.equal(names.get('two'), 'Claude Code (opus xhigh)');
  assert.equal(names.get('three'), 'Claude Code (opus high) [three]');
});
