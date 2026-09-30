import assert from 'node:assert/strict';
import { test } from 'node:test';

import { claudeAdapter, codexAdapter, geminiAdapter } from '../src/adapters/vendors.js';
import {
  compareVersions,
  isVersionAtLeast,
  modelsNeedingNewerCli,
  modelVersionProblem,
  probedVersion,
} from '../src/adapters/version.js';
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

test('gpt-6.1-sol on Codex CLI 0.158.0 is refused with the whole remedy', () => {
  const problem = modelVersionProblem(codexAdapter, 'gpt-6.1-sol', '0.158.0');

  assert.equal(
    problem,
    'gpt-6.1-sol requires Codex CLI >= 0.159.2 in crbuddy (tested compatibility ' +
      'baseline); found 0.158.0.\n' +
      'Upgrade Codex CLI in the environment where crbuddy runs (updating crbuddy ' +
      'does not update it), or select gpt-6-sol.\n' +
      'For npm installations: npm install -g @openai/codex@0.159.2',
  );
});

test('crbuddy policy refuses gpt-6.1-sol below its 0.159.2 baseline', () => {
  // Policy, not observation: only 0.158.0 was seen failing. Nothing below the
  // tested baseline is let through, 0.159.1 included.
  for (const version of ['0.159.1', '0.159.0', '0.158.9', '0.130.0']) {
    assert.match(
      modelVersionProblem(codexAdapter, 'gpt-6.1-sol', version) ?? '',
      new RegExp(`found ${version.replace(/\./g, '\\.')}\\.`),
      version,
    );
  }
});

test('gpt-6.1-sol passes on the 0.159.2 baseline and anything later', () => {
  for (const version of ['0.159.2', '0.159.10', '0.160.0', '1.0.0']) {
    assert.equal(modelVersionProblem(codexAdapter, 'gpt-6.1-sol', version), null, version);
  }
});

test('other Codex models keep the general minimum on an older CLI', () => {
  for (const model of ['gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna']) {
    assert.equal(modelVersionProblem(codexAdapter, model, '0.158.0'), null, model);
  }
});

test('only the exact gpt-6.1-sol ID has a model minimum', () => {
  // No aliases, casing or neighbours are inferred; they pass through unchecked.
  for (const model of [
    'GPT-6.1-SOL',
    ' gpt-6.1-sol',
    'gpt-6.1-sol-mini',
    'gpt-6.2-sol',
    'future-custom-model',
  ]) {
    assert.equal(modelVersionProblem(codexAdapter, model, '0.130.0'), null, model);
  }
});

test('other vendors are unaffected by the Codex model minimum', () => {
  for (const adapter of [claudeAdapter, geminiAdapter]) {
    assert.equal(modelVersionProblem(adapter, 'gpt-6.1-sol', '0.0.1'), null, adapter.name);
    assert.deepEqual(modelsNeedingNewerCli(adapter, '0.0.1'), [], adapter.name);
  }
});

test('an unknown version leaves refusal to the existing preflight', () => {
  // go refuses an unreadable version for every model before any lane runs.
  assert.equal(modelVersionProblem(codexAdapter, 'gpt-6.1-sol', null), null);
  assert.deepEqual(modelsNeedingNewerCli(codexAdapter, null), []);
});

test('setup and doctor list the models a usable CLI is too old for', () => {
  assert.deepEqual(
    modelsNeedingNewerCli(codexAdapter, '0.158.0').map((model) => model.id),
    ['gpt-6.1-sol'],
  );
  assert.deepEqual(modelsNeedingNewerCli(codexAdapter, '0.159.2'), []);
});
