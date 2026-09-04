import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { codexAdapter } from '../src/adapters/vendors.js';
import { runInit, type Detection } from '../src/commands/init.js';
import type { Choice } from '../src/util/prompt.js';
import type { MessageKind, WizardUI } from '../src/util/wizard-prompt.js';

const detection: Detection = {
  adapter: codexAdapter,
  present: true,
  version: '0.149.0',
  models: [
    {
      id: 'gpt-6-astra',
      label: 'GPT-6 Astra',
      hint: 'discovered from Codex',
      efforts: ['low', 'high', 'max'],
    },
  ],
  modelSource: 'discovered',
};

test('init writes discovered models and their model-specific effort choices', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-discovered-model-'));
  t.after(() => rm(repo, { recursive: true, force: true }));

  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    { ui: new DefaultingUI(), detect: async () => [detection] },
  );

  assert.equal(code, 0);

  const config = JSON.parse(
    await readFile(path.join(repo, '.crbuddy', 'config.json'), 'utf8'),
  ) as {
    panel: Array<{ model: string; effort?: string }>;
    merge: { model: string; effort?: string };
  };

  assert.deepEqual(config.panel.map(({ model, effort }) => ({ model, effort })), [
    { model: 'gpt-6-astra', effort: 'high' },
  ]);
  assert.deepEqual(
    { model: config.merge.model, effort: config.merge.effort },
    { model: 'gpt-6-astra', effort: 'high' },
  );
});

class DefaultingUI implements WizardUI {
  readonly interactive = false;

  intro(): void {}
  outro(): void {}
  cancel(): void {}
  note(): void {}
  message(_message: string, _kind?: MessageKind): void {}

  spinner<T>(
    _message: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    return task(new AbortController().signal);
  }

  async select<T>(
    _question: string,
    choices: Array<Choice<T>>,
    initialIndex = 0,
  ): Promise<T> {
    const choice = choices[initialIndex] ?? choices.find((candidate) => !candidate.disabled);
    if (!choice || choice.disabled) throw new Error('No selectable default');
    return choice.value;
  }

  async confirm(_question: string, defaultYes: boolean): Promise<boolean> {
    return defaultYes;
  }

  async text(_question: string, fallback = ''): Promise<string> {
    if (fallback === '') throw new Error('Unexpected required text prompt');
    return fallback;
  }

  async multiline(): Promise<string> {
    throw new Error('Unexpected multiline prompt');
  }
}
