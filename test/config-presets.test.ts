import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, validate } from '../src/config/load.js';
import { CONFIG_VERSION } from '../src/config/schema.js';
import { PRIORITIZED_FINDINGS_PRESET_ID } from '../src/review/instructions.js';

function baseConfig(configVersion = CONFIG_VERSION): Record<string, unknown> {
  return {
    configVersion,
    output: {
      destination: 'file',
      merged: 'CODE-REVIEW-HANDOFF.md',
      raw: 'CODE-REVIEW-HANDOFF.raw.md',
    },
    target: 'uncommitted',
    refuseIfOutputExists: false,
    timeoutMs: 60_000,
    mergeTimeoutMs: 60_000,
    maxConcurrent: 0,
    maxDiffBytes: 2_000_000,
    merge: { enabled: false, vendor: '', model: '' },
    panel: [{ id: 'codex', vendor: 'codex', model: 'gpt-test' }],
  };
}

test('v0.3 config version accepts the versioned prioritized-findings preset', () => {
  const input = baseConfig();
  input.panel = [
    {
      id: 'codex',
      vendor: 'codex',
      model: 'gpt-test',
      instructionsPreset: PRIORITIZED_FINDINGS_PRESET_ID,
    },
  ];

  const config = validate(input);
  assert.equal(config.configVersion, CONFIG_VERSION);
  assert.equal(config.panel[0]?.instructionsPreset, PRIORITIZED_FINDINGS_PRESET_ID);
  assert.equal(config.panel[0]?.instructions, undefined);
});

test('existing v1 configs preserve their previous default-review semantics', () => {
  const config = validate(baseConfig(1));

  assert.equal(config.configVersion, 1);
  assert.equal(config.panel[0]?.instructions, undefined);
  assert.equal(config.panel[0]?.instructionsPreset, undefined);
});

test('preset and custom instructions cannot both control one reviewer', () => {
  const input = baseConfig();
  input.panel = [
    {
      id: 'codex',
      vendor: 'codex',
      model: 'gpt-test',
      instructions: 'Focus on concurrency.',
      instructionsPreset: PRIORITIZED_FINDINGS_PRESET_ID,
    },
  ];

  assert.throws(() => validate(input), ConfigError);
});

test('unknown preset ids fail config validation instead of silently changing review behavior', () => {
  const input = baseConfig();
  input.panel = [
    {
      id: 'codex',
      vendor: 'codex',
      model: 'gpt-test',
      instructionsPreset: 'prioritized-findings-v99',
    },
  ];

  assert.throws(
    () => validate(input),
    (error: unknown) =>
      error instanceof ConfigError && /unknown preset/.test(error.message),
  );
});
