import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { claudeAdapter, codexAdapter } from '../src/adapters/vendors.js';
import type { Adapter } from '../src/adapters/types.js';
import {
  effectiveInitScope,
  runInit,
  type Detection,
} from '../src/commands/init.js';
import {
  CONFIG_VERSION,
  DEFAULTS,
  DEFAULT_OUTPUT,
  type Config,
} from '../src/config/schema.js';
import { PromptAborted, type Choice } from '../src/util/prompt.js';
import type { MessageKind, WizardUI } from '../src/util/wizard-prompt.js';
import { type GlobalSettings } from '../src/config/settings.js';

const detection: Detection = {
  adapter: codexAdapter,
  present: true,
  version: '0.149.0',
};

test('project scope without a repository normalizes to global', () => {
  assert.equal(effectiveInitScope('project', null), 'global');
  assert.equal(effectiveInitScope('project', 'C:/repo'), 'project');
  assert.equal(effectiveInitScope('global', null), 'global');
});

test('init defaults to the repository config when a repository is available', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-local-default-'));
  t.after(() => rm(repo, { recursive: true, force: true }));

  const code = await runInit(
    { repoRoot: repo },
    { ui: new DefaultingUI(), detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
  );

  assert.equal(code, 0);
  assert.equal(existsSync(path.join(repo, '.crbuddy', 'config.json')), true);
});

test('equivalent wizard answers produce the unchanged config schema', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-init-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const ui = new DefaultingUI();

  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    { ui, detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
  );

  assert.equal(code, 0);
  const written = JSON.parse(
    await readFile(path.join(repo, '.crbuddy', 'config.json'), 'utf8'),
  );
  assert.deepEqual(written, {
    configVersion: CONFIG_VERSION,
    output: { ...DEFAULT_OUTPUT },
    target: 'uncommitted',
    refuseIfOutputExists: DEFAULTS.refuseIfOutputExists,
    timeoutMs: DEFAULTS.timeoutMs,
    mergeTimeoutMs: DEFAULTS.mergeTimeoutMs,
    maxConcurrent: DEFAULTS.maxConcurrent,
    maxDiffBytes: DEFAULTS.maxDiffBytes,
    merge: {
      enabled: true,
      vendor: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high',
    },
    panel: [
      {
        id: 'codex-gpt-5-6-sol',
        vendor: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
    ],
  });

  const summary = ui.notes.find((entry) => entry.title === 'Configuration');
  assert.match(summary?.message ?? '', /Codex CLI \u00b7 GPT-5\.6 Sol \u00b7 high/);
  assert.doesNotMatch(summary?.message ?? '', /codex-gpt-5-6-sol/);
});

test('project config warns that external output needs consent on every run', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-init-external-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const ui = new OneLevelUpUI();

  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    { ui, detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
  );

  assert.equal(code, 0);
  assert.match(
    ui.messages.map((entry) => entry.message).join('\n'),
    /approve those paths on every interactive run.*refuse them when unattended/s,
  );
});

test('editing an existing config preserves accepted values', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-edit-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const configPath = path.join(repo, '.crbuddy', 'config.json');
  const existing: Config = {
    configVersion: CONFIG_VERSION,
    output: {
      destination: 'terminal',
      merged: 'REVIEW.md',
      raw: 'REVIEW.raw.md',
    },
    target: { base: 'develop' },
    refuseIfOutputExists: true,
    timeoutMs: 123_000,
    mergeTimeoutMs: 45_000,
    maxConcurrent: 2,
    maxDiffBytes: 987_654,
    merge: {
      enabled: true,
      vendor: 'codex',
      model: 'gpt-5.6-terra',
      effort: 'max',
    },
    panel: [
      {
        id: 'careful-review',
        vendor: 'codex',
        model: 'gpt-5.6-terra',
        effort: 'xhigh',
        instructions: 'Focus on correctness.',
      },
    ],
  };

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');

  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    { ui: new DefaultingUI(), detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
  );

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), existing);
});

test('editing replaces an output filename that is an existing directory', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-edit-directory-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const configPath = path.join(repo, '.crbuddy', 'config.json');
  const reportDirectory = path.join(repo, 'reports');
  const sentinel = path.join(reportDirectory, 'keep.txt');
  const existing: Config = {
    configVersion: CONFIG_VERSION,
    output: {
      destination: 'terminal',
      merged: 'reports',
      raw: 'REVIEW.raw.md',
    },
    target: 'uncommitted',
    refuseIfOutputExists: false,
    timeoutMs: DEFAULTS.timeoutMs,
    mergeTimeoutMs: DEFAULTS.mergeTimeoutMs,
    maxConcurrent: DEFAULTS.maxConcurrent,
    maxDiffBytes: DEFAULTS.maxDiffBytes,
    merge: { enabled: false, vendor: '', model: '' },
    panel: [
      {
        id: 'codex-gpt-5-6-sol',
        vendor: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'high',
      },
    ],
  };

  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(reportDirectory);
  await writeFile(sentinel, 'keep', 'utf8');
  await writeFile(configPath, `${JSON.stringify(existing, null, 2)}\n`, 'utf8');

  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    { ui: new DefaultingUI(), detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
  );

  assert.equal(code, 0);
  const written = JSON.parse(await readFile(configPath, 'utf8')) as Config;
  assert.deepEqual(written.output, {
    ...DEFAULT_OUTPUT,
    destination: 'terminal',
  });
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
});

test('late cancellation writes neither config nor planned .gitignore changes', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-abort-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const ui = new AbortAtSaveUI();

  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    { ui, detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
  );

  assert.equal(code, 130);
  assert.equal(existsSync(path.join(repo, '.crbuddy', 'config.json')), false);
  assert.equal(existsSync(path.join(repo, '.gitignore')), false);
  assert.match(ui.cancelled.at(-1) ?? '', /No config was written/);
});

test('the Codex model wizard offers Other and retains existing arbitrary model IDs', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-model-other-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  class CustomModelUI extends DefaultingUI {
    override async select<T>(question: string, choices: Array<Choice<T>>, initialIndex = 0): Promise<T> {
      if (question === 'Model for Codex CLI') {
        assert.equal(choices[0]?.label, 'GPT-6 Astra');
        assert.equal(choices[initialIndex]?.value, 'gpt-5.6-sol');
        const other = choices.find((choice) => choice.label === 'Other…');
        assert.ok(other && !other.disabled);
        return other.value;
      }
      return super.select(question, choices, initialIndex);
    }
    override async text(question: string, fallback = ''): Promise<string> {
      return question === 'Model id' ? 'future-custom-model' : super.text(question, fallback);
    }
  }
  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    {
      ui: new CustomModelUI(),
      detect: async () => [detection],
      settingsFile: path.join(repo, 'settings.json'),
    },
  );
  assert.equal(code, 0);
  const config = JSON.parse(await readFile(path.join(repo, '.crbuddy', 'config.json'), 'utf8'));
  assert.equal(config.panel[0].model, 'future-custom-model');
  class KeepCustomModelUI extends DefaultingUI {
    override async select<T>(question: string, choices: Array<Choice<T>>, initialIndex = 0): Promise<T> {
      if (question === 'Model for Codex CLI') {
        assert.equal(choices[initialIndex]?.label, 'Other…');
      }
      return super.select(question, choices, initialIndex);
    }
    override async text(question: string, fallback = ''): Promise<string> {
      if (question === 'Model id') assert.equal(fallback, 'future-custom-model');
      return super.text(question, fallback);
    }
  }
  assert.equal(await runInit(
    { repoRoot: repo, scope: 'project' },
    {
      ui: new KeepCustomModelUI(),
      detect: async () => [detection],
      settingsFile: path.join(repo, 'settings.json'),
    },
  ), 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(repo, '.crbuddy', 'config.json'), 'utf8')), config);
});

test('changing consolidation vendors selects the new vendor defaults without a custom-model prompt', async (t) => {
  for (const [previous, selected] of [[codexAdapter, claudeAdapter], [claudeAdapter, codexAdapter]] as const) {
    for (const previousAvailable of [true, false]) {
      const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-merge-vendor-'));
      t.after(() => rm(repo, { recursive: true, force: true }));
      const configPath = path.join(repo, '.crbuddy', 'config.json');
      const config: Config = {
        ...DEFAULTS,
        output: { ...DEFAULT_OUTPUT },
        merge: { enabled: true, vendor: previous.name, model: previous.defaultModel, effort: 'max' },
        panel: [{ id: 'reviewer', vendor: selected.name, model: selected.defaultModel }],
      };
      await mkdir(path.dirname(configPath));
      await writeFile(configPath, JSON.stringify(config));
      let modelPrompts = 0;
      class ChangeVendorUI extends DefaultingUI {
        override async select<T>(question: string, choices: Array<Choice<T>>, initialIndex = 0): Promise<T> {
          if (question === 'Which CLI should consolidate?') {
            const choice = choices.find((entry) => (entry.value as Adapter).name === selected.name);
            assert.ok(choice);
            return choice.value;
          }
          if (question === `Model for ${selected.label}`) {
            modelPrompts++;
            assert.equal(choices[initialIndex]?.value, selected.defaultModel);
          }
          return super.select(question, choices, initialIndex);
        }
        override async text(question: string, fallback = ''): Promise<string> {
          assert.notEqual(question, 'Model id', 'switching vendors must not add a custom-model answer');
          return super.text(question, fallback);
        }
      }
      const adapters = previousAvailable ? [previous, selected] : [selected];
      const code = await runInit(
        { repoRoot: repo, scope: 'project' },
        {
          ui: new ChangeVendorUI(),
          detect: async () => adapters.map((adapter) => ({ adapter, present: true, version: adapter.minVersion })),
          settingsFile: path.join(repo, 'settings.json'),
        },
      );
      assert.equal(code, 0);
      assert.equal(modelPrompts, 1);
      assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), {
        ...config,
        merge: { enabled: true, vendor: selected.name, model: selected.defaultModel, effort: selected.defaultEffort },
      });
    }
  }
});

test('re-enabling consolidation with an empty model defaults to Sol', async (t) => {
  // Both the wizard's disabled shape and a retained vendor with no model are valid.
  for (const vendor of ['', 'codex']) {
    const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-merge-enable-'));
    t.after(() => rm(repo, { recursive: true, force: true }));
    const configPath = path.join(repo, '.crbuddy', 'config.json');
    const config: Config = {
      ...DEFAULTS,
      output: { ...DEFAULT_OUTPUT },
      merge: { enabled: false, vendor, model: '' },
      panel: [{ id: 'reviewer', vendor: 'codex', model: 'gpt-5.6-sol' }],
    };
    await mkdir(path.dirname(configPath));
    await writeFile(configPath, JSON.stringify(config));
    let modelPrompts = 0;
    class EnableMergeUI extends DefaultingUI {
      override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
        return question.startsWith('When done, run a consolidation pass')
          ? true : super.confirm(question, defaultYes);
      }
      override async select<T>(question: string, choices: Array<Choice<T>>, initialIndex = 0): Promise<T> {
        if (question === 'Model for Codex CLI') {
          modelPrompts++;
          assert.equal(choices[0]?.value, 'gpt-6-astra');
          assert.equal(choices[initialIndex]?.value, 'gpt-5.6-sol');
        }
        return super.select(question, choices, initialIndex);
      }
    }
    assert.equal(await runInit(
      { repoRoot: repo, scope: 'project' },
      { ui: new EnableMergeUI(), detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
    ), 0);
    assert.equal(modelPrompts, 1);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).merge, {
      enabled: true, vendor: 'codex', model: 'gpt-5.6-sol', effort: 'high',
    });
  }
});

class DefaultingUI implements WizardUI {
  readonly interactive: boolean = false;
  readonly notes: Array<{ title?: string; message: string }> = [];
  readonly messages: Array<{ kind?: MessageKind; message: string }> = [];
  readonly cancelled: string[] = [];
  readonly outros: string[] = [];

  intro(): void {}
  outro(message: string): void { this.outros.push(message); }

  cancel(message: string): void {
    this.cancelled.push(message);
  }

  note(message: string, title?: string): void {
    this.notes.push({ message, ...(title ? { title } : {}) });
  }

  message(message: string, kind?: MessageKind): void {
    this.messages.push({ message, ...(kind ? { kind } : {}) });
  }

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
    const selected =
      choices[initialIndex] ?? choices.find((choice) => !choice.disabled);

    if (!selected || selected.disabled) {
      throw new Error('Test UI received no selectable default');
    }

    return selected.value;
  }

  async confirm(_question: string, defaultYes: boolean): Promise<boolean> {
    return defaultYes;
  }

  async text(_question: string, fallback = ''): Promise<string> {
    if (fallback === '') throw new Error('Test UI received required text unexpectedly');
    return fallback;
  }

  async multiline(_question: string): Promise<string> {
    throw new Error('Test UI received required multiline text unexpectedly');
  }
}

const endpoint = 'https://ntfy.sh/crbuddy-a-long-private-topic';

class NotificationUI extends DefaultingUI {
  readonly questions: string[] = [];
  readonly notificationDefaults: boolean[] = [];
  readonly endpointDefaults: string[] = [];
  providerChoices: Array<Choice<unknown>> = [];
  providerDefault: unknown;

  constructor(
    private readonly enabled?: boolean,
    private readonly endpoints: string[] = [],
  ) { super(); }

  override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
    this.questions.push(question);
    if (question.startsWith('Notify you')) {
      this.notificationDefaults.push(defaultYes);
      return this.enabled ?? defaultYes;
    }
    return super.confirm(question, defaultYes);
  }

  override async select<T>(
    question: string,
    choices: Array<Choice<T>>,
    initialIndex = 0,
  ): Promise<T> {
    this.questions.push(question);
    if (question === 'Notification service') {
      this.providerChoices = choices;
      this.providerDefault = choices[initialIndex]?.value;
    }
    return super.select(question, choices, initialIndex);
  }

  override async text(question: string, fallback = ''): Promise<string> {
    this.questions.push(question);
    if (question === 'ntfy topic URL') {
      this.endpointDefaults.push(fallback);
      return this.endpoints.shift() ?? super.text(question, fallback);
    }
    return super.text(question, fallback);
  }
}

async function notificationSetup(
  t: import('node:test').TestContext,
  ui: WizardUI,
  existing?: GlobalSettings,
) {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-notification-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const settingsFile = path.join(root, 'home', '.crbuddy', 'settings.json');
  await mkdir(repo);
  if (existing) {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, JSON.stringify(existing));
  }
  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    { ui, detect: async () => [detection], settingsFile },
  );
  return { code, repo, settingsFile };
}

test('first setup appends notifications defaulting to No and stores no endpoint', async (t) => {
  const ui = new NotificationUI();
  const { code, settingsFile } = await notificationSetup(t, ui);
  assert.equal(code, 0);
  assert.deepEqual(ui.notificationDefaults, [false]);
  assert.match(ui.questions.at(-1)!, /Notify you.*crb go/);
  assert.deepEqual(ui.providerChoices, []);
  assert.deepEqual(ui.endpointDefaults, []);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), {});
});

test('Yes offers ntfy and disabled Other, retries bad URLs and saves globally', async (t) => {
  const ui = new NotificationUI(true, ['not a URL', 'http://ntfy.sh/topic', endpoint]);
  const { code, repo, settingsFile } = await notificationSetup(t, ui);
  assert.equal(code, 0);
  assert.equal(ui.providerDefault, 'ntfy');
  assert.deepEqual(ui.providerChoices.find((choice) => choice.label === 'Other'), {
    label: 'Other', value: 'other', disabled: true, hint: 'coming later',
  });
  assert.equal(ui.endpointDefaults.length, 3);
  assert.equal(ui.messages.filter((entry) => entry.kind === 'error').length, 2);
  assert.match(ui.notes.map((entry) => entry.message).join('\n'), /Subscribe.*same topic.*shared secret/s);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), {
    notifications: { provider: 'ntfy', endpoint },
  });
  const config = await readFile(path.join(repo, '.crbuddy', 'config.json'), 'utf8');
  assert.doesNotMatch(config, /notifications|ntfy|private-topic/);
  assert.equal(existsSync(path.join(repo, '.crbuddy', 'settings.json')), false);
});

test('existing ntfy defaults to Yes, selected ntfy and the saved text default', async (t) => {
  const ui = new NotificationUI();
  const existing: GlobalSettings = { notifications: { provider: 'ntfy', endpoint } };
  const { code, settingsFile } = await notificationSetup(t, ui, existing);
  assert.equal(code, 0);
  assert.deepEqual(ui.notificationDefaults, [true]);
  assert.equal(ui.providerDefault, 'ntfy');
  assert.deepEqual(ui.endpointDefaults, [endpoint]);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), existing);
});

test('No clears an existing endpoint without further notification questions', async (t) => {
  const ui = new NotificationUI(false);
  const { settingsFile } = await notificationSetup(t, ui, {
    notifications: { provider: 'ntfy', endpoint },
  });
  assert.deepEqual(ui.notificationDefaults, [true]);
  assert.deepEqual(ui.providerChoices, []);
  assert.deepEqual(ui.endpointDefaults, []);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), {});
});

test('a settings save failure reports the partial setup and still applies the approved gitignore plan', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-init-settings-failure-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const blocker = path.join(repo, 'blocker');
  await writeFile(blocker, 'keep');
  class SaveFailureUI extends NotificationUI {
    override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      if (question.startsWith('Create a .gitignore')) return true;
      return super.confirm(question, defaultYes);
    }
  }
  const ui = new SaveFailureUI(false);
  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    { ui, detect: async () => [detection], settingsFile: path.join(blocker, 'settings.json') },
  );
  assert.equal(code, 1, 'scripts must be able to detect that the requested preferences were not saved');
  assert.equal(existsSync(path.join(repo, '.crbuddy', 'config.json')), true);
  assert.match(await readFile(path.join(repo, '.gitignore'), 'utf8'), /\.crbuddy/);
  assert.equal(await readFile(blocker, 'utf8'), 'keep');
  assert.match(ui.messages.map((entry) => entry.message).join('\n'), /Review config saved.*preferences could not be saved.*remain unchanged/);
  assert.match(ui.outros.at(-1)!, /Config saved/);
  assert.deepEqual(ui.cancelled, []);
});

test('cancelling after notification edits leaves global settings and review config unchanged', async (t) => {
  class CancelUI extends NotificationUI {
    override readonly interactive = true;
    override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      if (question === 'Save this config?') throw new PromptAborted();
      return super.confirm(question, defaultYes);
    }
  }
  const existing: GlobalSettings = { notifications: { provider: 'ntfy', endpoint } };
  const { code, repo, settingsFile } = await notificationSetup(t, new CancelUI(false), existing);
  assert.equal(code, 130);
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), existing);
  assert.equal(existsSync(path.join(repo, '.crbuddy', 'config.json')), false);
});

class OneLevelUpUI extends DefaultingUI {
  override async select<T>(
    question: string,
    choices: Array<Choice<T>>,
    initialIndex = 0,
  ): Promise<T> {
    if (question === 'Where should the report be written?') {
      const choice = choices.find((candidate) => candidate.value === 'up');
      if (!choice || choice.disabled) throw new Error('Missing one-level-up choice');
      return choice.value;
    }

    return super.select(question, choices, initialIndex);
  }
}

class AbortAtSaveUI extends DefaultingUI {
  override readonly interactive = true;

  override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
    if (question.startsWith('Create a .gitignore')) return true;
    if (question === 'Save this config?') throw new PromptAborted();
    return defaultYes;
  }
}
