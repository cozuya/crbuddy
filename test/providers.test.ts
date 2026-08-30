import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validate } from '../src/config/load.js';
import {
  claudeProviderEnv,
  resetClaudeProviderRegistry,
  registerClaudeModelProvider,
} from '../src/providers/claude.js';

test('Claude provider is optional and defaults to Anthropic', () => {
  const config = validate({ panel: [{ vendor: 'claude', model: 'opus' }] });
  assert.equal(config.panel[0]?.provider, undefined);
  assert.equal(config.panel[0]?.id, 'claude-opus');
});

test('known Claude providers are accepted and represented in generated ids', () => {
  const config = validate({
    panel: [
      { vendor: 'claude', provider: 'zai', model: 'glm-5.3[1m]', effort: 'medium' },
      { vendor: 'claude', provider: 'deepseek', model: 'deepseek-v4-pro[1m]' },
      { vendor: 'claude', provider: 'kimi', model: 'k3[1m]' },
    ],
  });

  assert.deepEqual(
    config.panel.map((entry) => [entry.provider, entry.id]),
    [
      ['zai', 'claude-zai-glm-5-3-1m'],
      ['deepseek', 'claude-deepseek-deepseek-v4-pro-1m'],
      ['kimi', 'claude-kimi-k3-1m'],
    ],
  );
});

test('provider is rejected on non-Claude adapters and unknown providers are rejected', () => {
  assert.throws(
    () => validate({ panel: [{ vendor: 'codex', provider: 'zai', model: 'gpt-5.6-sol' }] }),
    /provider.*vendor.*claude/i,
  );

  assert.throws(
    () => validate({ panel: [{ vendor: 'claude', provider: 'nope', model: 'x' }] }),
    /Known providers/i,
  );
});

test('Z.ai provider builds an isolated Claude Code environment', () => {
  resetClaudeProviderRegistry();
  registerClaudeModelProvider('glm-5.3[1m]', 'zai');
  const env = claudeProviderEnv('glm-5.3[1m]', { zai: { apiKey: 'z-secret' } });

  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'z-secret');
  assert.equal(env.ANTHROPIC_MODEL, 'glm-5.3[1m]');
  assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash[1m]');
});

test('DeepSeek and Kimi use their Anthropic-compatible Claude Code routes', () => {
  resetClaudeProviderRegistry();
  registerClaudeModelProvider('deepseek-v4-pro[1m]', 'deepseek');
  const deepseek = claudeProviderEnv('deepseek-v4-pro[1m]', {
    deepseek: { apiKey: 'd-secret' },
  });
  assert.equal(deepseek.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(deepseek.ANTHROPIC_AUTH_TOKEN, 'd-secret');
  assert.equal(deepseek.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'deepseek-v4-flash');

  resetClaudeProviderRegistry();
  registerClaudeModelProvider('k3[1m]', 'kimi');
  const kimi = claudeProviderEnv('k3[1m]', { kimi: { apiKey: 'k-secret' } });
  assert.equal(kimi.ANTHROPIC_BASE_URL, 'https://api.kimi.com/coding/');
  assert.equal(kimi.ANTHROPIC_API_KEY, 'k-secret');
  assert.equal(kimi.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1048576');
});
