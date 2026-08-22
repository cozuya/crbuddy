import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareVersions, isVersionAtLeast } from '../src/adapters/version.js';

test('version comparison handles dotted CLI versions numerically', () => {
  assert.equal(compareVersions('2.1.223', '2.1.223'), 0);
  assert.equal(compareVersions('2.1.239', '2.1.223'), 1);
  assert.equal(compareVersions('0.129.9', '0.130.0'), -1);
});

test('version comparison tolerates surrounding CLI text', () => {
  assert.equal(isVersionAtLeast('claude-code 2.1.239', '2.1.223'), true);
  assert.equal(isVersionAtLeast('codex-cli 0.129.0', '0.130.0'), false);
});
