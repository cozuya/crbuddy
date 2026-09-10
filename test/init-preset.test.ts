import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { codexAdapter } from '../src/adapters/vendors.js';
import { runInit, type Detection } from '../src/commands/init.js';
import { PRIORITIZED_FINDINGS_PRESET_ID } from '../src/review/instructions.js';
import type { Choice } from '../src/util/prompt.js';
import type { MessageKind, WizardUI } from '../src/util/wizard-prompt.js';

const detection: Detection = {
  adapter: codexAdapter,
  present: true,
  version: '0.149.0',
  models: codexAdapter.models,
  modelSource: 'fallback',
};

test('init offers three reviewer instruction modes and persists the built-in preset by id', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-init-preset-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const ui = new PrioritizedUI();

  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    { ui, detect: async () => [detection] },
  );

  assert.equal(code, 0);
  assert.deepEqual(ui.instructionMenu, {
    labels: ['Prioritized findings', 'Custom instructions…', 'Reviewer default'],
    initialIndex: 2,
  });

  const config = JSON.parse(
    await readFile(path.join(repo, '.crbuddy', 'config.json'), 'utf8'),
  );

  assert.equal(config.panel[0].instructionsPreset, PRIORITIZED_FINDINGS_PRESET_ID);
  assert.equal(config.panel[0].instructions, undefined);
});

class PrioritizedUI implements WizardUI {
  readonly interactive = false;
  instructionMenu: { labels: string[]; initialIndex: number } | null = null;

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
    question: string,
    choices: Array<Choice<T>>,
    initialIndex = 0,
  ): Promise<T> {
    if (question === 'Choose instructions for this reviewer') {
      this.instructionMenu = {
        labels: choices.map((choice) => choice.label),
        initialIndex,
      };
      const preset = choices.find((choice) => choice.label === 'Prioritized findings');
      if (!preset || preset.disabled) throw new Error('Missing prioritized-findings choice');
      return preset.value;
    }

    const selected =
      choices[initialIndex] ?? choices.find((choice) => !choice.disabled);
    if (!selected || selected.disabled) throw new Error(`No default for ${question}`);
    return selected.value;
  }

  async confirm(_question: string, defaultYes: boolean): Promise<boolean> {
    return defaultYes;
  }

  async text(_question: string, fallback = ''): Promise<string> {
    if (!fallback) throw new Error('Unexpected required text prompt');
    return fallback;
  }

  async multiline(): Promise<string> {
    throw new Error('Built-in preset must not ask for multiline instructions');
  }
}
