import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { runView } from '../src/commands/view.js';
import { projectConfigPath } from '../src/config/load.js';
import {
  CONFIG_VERSION,
  Config,
  DEFAULTS,
  DEFAULT_OUTPUT,
} from '../src/config/schema.js';
import type { WizardUI } from '../src/util/wizard-prompt.js';

function config(model: string, scopeTarget: 'uncommitted' | { base: string }): Config {
  return {
    configVersion: CONFIG_VERSION,
    output: { ...DEFAULT_OUTPUT, destination: 'terminal' },
    target: scopeTarget,
    refuseIfOutputExists: DEFAULTS.refuseIfOutputExists,
    timeoutMs: DEFAULTS.timeoutMs,
    mergeTimeoutMs: DEFAULTS.mergeTimeoutMs,
    maxConcurrent: DEFAULTS.maxConcurrent,
    maxDiffBytes: DEFAULTS.maxDiffBytes,
    merge: { enabled: false, vendor: '', model: '' },
    panel: [
      {
        id: `codex-${model}`,
        vendor: 'codex',
        model,
        effort: 'high',
      },
    ],
  };
}

function recordingUi(): { ui: WizardUI; notes: Array<{ title?: string; message: string }> } {
  const notes: Array<{ title?: string; message: string }> = [];
  const unused = async (): Promise<never> => {
    throw new Error('view must not prompt');
  };

  const ui = {
    interactive: false,
    intro() {},
    outro() {},
    cancel() {},
    note(message: string, title?: string) {
      notes.push({ message, ...(title ? { title } : {}) });
    },
    message() {},
    spinner: unused,
    select: unused,
    confirm: unused,
    text: unused,
    multiline: unused,
  } as unknown as WizardUI;

  return { ui, notes };
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

test('view prefers the repository config and shows global notifications', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-view-local-'));

  try {
    const repoRoot = path.join(root, 'repo');
    const globalFile = path.join(root, 'global.json');
    const settingsFile = path.join(root, 'settings.json');
    await mkdir(repoRoot, { recursive: true });
    await writeJson(globalFile, config('gpt-6-astra', 'uncommitted'));
    await writeJson(
      projectConfigPath(repoRoot),
      config('gpt-5.6-sol', { base: 'main' }),
    );
    await writeJson(settingsFile, {
      notifications: {
        provider: 'ntfy',
        endpoint: 'https://ntfy.sh/crbuddy-view-test',
      },
    });

    const { ui, notes } = recordingUi();
    assert.equal(
      await runView(
        { repoRoot },
        { ui, globalConfigFile: globalFile, settingsFile },
      ),
      0,
    );

    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.title, 'Configuration');
    assert.match(notes[0]?.message ?? '', /Config: This repository/);
    assert.match(notes[0]?.message ?? '', /GPT-5\.6 Sol · high/);
    assert.doesNotMatch(notes[0]?.message ?? '', /GPT-6 Astra/);
    assert.match(notes[0]?.message ?? '', /Target: Current branch vs main/);
    assert.match(notes[0]?.message ?? '', /Output: Terminal/);
    assert.match(notes[0]?.message ?? '', /Notifications \(global\): ntfy/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('view falls back to the global config', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-view-global-'));

  try {
    const repoRoot = path.join(root, 'repo');
    const globalFile = path.join(root, 'global.json');
    const settingsFile = path.join(root, 'missing-settings.json');
    await mkdir(repoRoot, { recursive: true });
    await writeJson(globalFile, config('gpt-6-astra', 'uncommitted'));

    const { ui, notes } = recordingUi();
    assert.equal(
      await runView(
        { repoRoot },
        { ui, globalConfigFile: globalFile, settingsFile },
      ),
      0,
    );

    assert.match(notes[0]?.message ?? '', /Config: Global/);
    assert.match(notes[0]?.message ?? '', /GPT-6 Astra · high/);
    assert.match(notes[0]?.message ?? '', /Target: Uncommitted changes/);
    assert.match(notes[0]?.message ?? '', /Notifications \(global\): Off/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('view reports when no review config exists', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-view-none-'));

  try {
    const { ui, notes } = recordingUi();
    assert.equal(
      await runView(
        { repoRoot: null },
        {
          ui,
          globalConfigFile: path.join(root, 'missing-config.json'),
          settingsFile: path.join(root, 'missing-settings.json'),
        },
      ),
      0,
    );

    assert.equal(
      notes[0]?.message,
      'Config: None\n\nNo repository or global config found.\nNotifications (global): Off',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
