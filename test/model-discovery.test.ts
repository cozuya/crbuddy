import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseCodexModelCatalog,
  parseGeminiAcpModels,
  withModelDiscovery,
} from '../src/adapters/model-discovery.js';
import { claudeAdapter, codexAdapter, geminiAdapter } from '../src/adapters/vendors.js';

test('Codex catalog discovery accepts current ModelInfo fields and model-specific efforts', () => {
  const models = parseCodexModelCatalog(
    JSON.stringify({
      models: [
        {
          slug: 'gpt-6-astra',
          display_name: 'GPT-6 Astra',
          description: 'Frontier model',
          visibility: 'list',
          supported_reasoning_levels: [
            { effort: 'low', description: '' },
            { effort: 'high', description: '' },
            { effort: 'max', description: '' },
          ],
        },
        {
          slug: 'internal-hidden',
          display_name: 'Hidden',
          visibility: 'hide',
          supported_reasoning_levels: [],
        },
      ],
    }),
  );

  assert.deepEqual(models, [
    {
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      hint: 'Frontier model',
      efforts: ['low', 'high', 'max'],
    },
  ]);
});

test('Codex catalog discovery tolerates ModelPreset-style field names', () => {
  const models = parseCodexModelCatalog(
    JSON.stringify({
      models: [
        {
          id: 'preset-id',
          model: 'future-model',
          displayName: 'Future Model',
          showInPicker: true,
          supported_reasoning_efforts: ['medium', { effort: 'xhigh' }],
        },
      ],
    }),
  );

  assert.deepEqual(models, [
    {
      id: 'future-model',
      label: 'Future Model',
      efforts: ['medium', 'xhigh'],
    },
  ]);
});

test('Gemini ACP discovery reads the session model catalog', () => {
  const stdout = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 'session-1',
        models: {
          currentModelId: 'auto',
          availableModels: [
            { modelId: 'auto', name: 'Auto', description: 'Let Gemini choose' },
            { modelId: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
          ],
        },
      },
    }),
  ].join('\n');

  assert.deepEqual(parseGeminiAcpModels(stdout), [
    { id: 'auto', label: 'Auto', hint: 'Let Gemini choose' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  ]);
});

test('Gemini ACP discovery surfaces session setup errors for fallback reporting', () => {
  assert.throws(
    () =>
      parseGeminiAcpModels(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          error: { code: -32000, message: 'Authentication required.' },
        }),
      ),
    /Authentication required/,
  );
});

test('discovery capabilities attach only where a vendor exposes a usable surface', () => {
  assert.equal(withModelDiscovery(codexAdapter).discoverModels instanceof Function, true);
  assert.equal(withModelDiscovery(geminiAdapter).discoverModels instanceof Function, true);
  assert.equal(withModelDiscovery(claudeAdapter).discoverModels, undefined);
});
