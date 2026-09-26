import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codexAdapter } from '../src/adapters/vendors.js';
import { compareVersions, isVersionAtLeast, probedVersion } from '../src/adapters/version.js';
import { probe } from '../src/run/spawn.js';

test('version comparison handles dotted CLI versions numerically', () => {
  assert.equal(compareVersions('2.1.223', '2.1.223'), 0);
  assert.equal(compareVersions('2.1.239', '2.1.223'), 1);
  assert.equal(compareVersions('0.129.9', '0.130.0'), -1);
});

test('a version printed after a banner, on stderr, is still read', async () => {
  // Setup and doctor read only the first line once; go read everything, so
  // they disagreed about whether such a CLI was usable.
  const result = await probe(process.execPath, [
    '-e',
    'console.log("Welcome to the tool"); console.error("codex-cli 0.155.0")',
  ]);

  assert.equal(result.output, 'Welcome to the tool');
  assert.equal(probedVersion(codexAdapter, result), '0.155.0');
  assert.equal(probedVersion(codexAdapter, { present: false, text: 'codex-cli 0.155.0' }), null);
});

test('version comparison tolerates surrounding CLI text', () => {
  assert.equal(isVersionAtLeast('claude-code 2.1.239', '2.1.223'), true);
  assert.equal(isVersionAtLeast('codex-cli 0.129.0', '0.130.0'), false);
});
