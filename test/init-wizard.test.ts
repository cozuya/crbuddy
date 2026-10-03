import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { claudeAdapter, codexAdapter, geminiAdapter } from '../src/adapters/vendors.js';
import {
  effectiveInitScope,
  runInit,
  type Detection,
} from '../src/commands/init.js';
import { readAndValidate } from '../src/config/load.js';
import {
  CONFIG_VERSION,
  DEFAULTS,
  DEFAULT_OUTPUT,
  type Config,
  type PanelEntry,
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
    maxConcurrent: DEFAULTS.maxConcurrent,
    maxDiffBytes: DEFAULTS.maxDiffBytes,
    panel: [
      {
        id: 'codex-gpt-6-1-sol',
        vendor: 'codex',
        model: 'gpt-6.1-sol',
        effort: 'high',
      },
    ],
  });

  const summary = ui.notes.find((entry) => entry.title === 'Configuration');
  assert.match(summary?.message ?? '', /Codex CLI \u00b7 GPT-6\.1 Sol \u00b7 high/);
  assert.doesNotMatch(summary?.message ?? '', /codex-gpt-6-1-sol/);
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
    /approve that path on every interactive run.*refuse it when unattended/s,
  );
});

test('editing an existing config preserves accepted values and drops consolidation keys', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-edit-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const configPath = path.join(repo, '.crbuddy', 'config.json');
  const existing: Config = {
    configVersion: CONFIG_VERSION,
    output: {
      destination: 'terminal',
      merged: 'REVIEW.md',
    },
    target: { base: 'develop' },
    refuseIfOutputExists: true,
    timeoutMs: 123_000,
    maxConcurrent: 2,
    maxDiffBytes: 987_654,
    panel: [
      {
        id: 'careful-review',
        vendor: 'codex',
        model: 'gpt-6-sol', // Keep an existing model even when it is no longer listed.
        effort: 'xhigh',
        instructions: 'Focus on correctness.',
      },
    ],
  };

  // As an earlier version wrote it: the wizard saves it back without the
  // consolidation keys, keeping only the custom output.raw.
  const legacy = {
    ...existing,
    output: { ...existing.output, raw: 'REVIEW.raw.md' },
    mergeTimeoutMs: 45_000,
    merge: { enabled: true, vendor: 'codex', model: 'gpt-6-luna', effort: 'max' },
  };

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    { ui: new DefaultingUI(), detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
  );

  assert.equal(code, 0);
  assert.deepEqual(
    JSON.parse(await readFile(configPath, 'utf8')),
    { ...existing, output: { ...existing.output, raw: 'REVIEW.raw.md' } },
  );
});

test('editing keeps a custom pre-0.4 output.raw until it is removed by hand', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-edit-legacy-raw-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const configPath = path.join(repo, '.crbuddy', 'config.json');
  const report = path.join(repo, 'reviews', 'raw.md');
  const existing: Config = {
    configVersion: CONFIG_VERSION,
    output: { destination: 'terminal', merged: 'REVIEW.md' },
    target: 'uncommitted',
    refuseIfOutputExists: false,
    timeoutMs: DEFAULTS.timeoutMs,
    maxConcurrent: DEFAULTS.maxConcurrent,
    maxDiffBytes: DEFAULTS.maxDiffBytes,
    panel: [{ id: 'codex-gpt-6-luna', vendor: 'codex', model: 'gpt-6-luna', effort: 'xhigh' }],
  };
  const withRaw = { ...existing, output: { ...existing.output, raw: 'reviews/raw.md' } };

  await mkdir(path.dirname(configPath), { recursive: true });
  await mkdir(path.dirname(report), { recursive: true });
  await writeFile(configPath, JSON.stringify(withRaw), 'utf8');
  await writeFile(report, 'old raw report', 'utf8');

  const edit = async () => {
    const ui = new DefaultingUI();
    const code = await runInit(
      { repoRoot: repo, scope: 'project' },
      { ui, detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
    );
    assert.equal(code, 0);
    return ui;
  };

  // `crbuddy go` can only keep hiding that report while the key names it,
  // and whether one is left elsewhere cannot be settled from here.
  for (const reportPresent of [true, false]) {
    if (!reportPresent) await rm(report);
    const ui = await edit();
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), withRaw);
    assert.match(
      ui.messages.map((entry) => entry.message).join('\n'),
      /Kept output\.raw \(reviews\/raw\.md\).*Remove the key yourself/s,
    );
  }

  // The default name needs no key: it is always covered.
  await writeFile(configPath, JSON.stringify({
    ...existing,
    output: { ...existing.output, raw: 'CODE-REVIEW-HANDOFF.raw.md' },
  }), 'utf8');
  await edit();
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
    },
    target: 'uncommitted',
    refuseIfOutputExists: false,
    timeoutMs: DEFAULTS.timeoutMs,
    maxConcurrent: DEFAULTS.maxConcurrent,
    maxDiffBytes: DEFAULTS.maxDiffBytes,
    panel: [
      {
        id: 'codex-gpt-6-1-sol',
        vendor: 'codex',
        model: 'gpt-6.1-sol',
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

test('the Codex model wizard offers Other for arbitrary model IDs', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-model-other-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  class CustomModelUI extends DefaultingUI {
    override async select<T>(question: string, choices: Array<Choice<T>>, initialIndex = 0): Promise<T> {
      if (question === 'Model for Codex CLI') {
        assert.equal(choices[0]?.label, 'GPT-6 Astra');
        assert.equal(choices[initialIndex]?.value, 'gpt-6.1-sol');
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
});

test('accepting every default adds one reviewer per installed CLI, then stops', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-panel-defaults-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const addAnotherDefaults: boolean[] = [];
  class RecordingUI extends DefaultingUI {
    override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      if (question.endsWith('Add another?')) addAnotherDefaults.push(defaultYes);
      return super.confirm(question, defaultYes);
    }
  }
  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    {
      ui: new RecordingUI(),
      detect: async () => [claudeAdapter, codexAdapter].map((adapter) => (
        { adapter, present: true, version: adapter.minVersion }
      )),
      settingsFile: path.join(repo, 'settings.json'),
    },
  );
  assert.equal(code, 0);
  assert.deepEqual(addAnotherDefaults, [true, false]);
  const saved = JSON.parse(await readFile(path.join(repo, '.crbuddy', 'config.json'), 'utf8'));
  assert.deepEqual(
    saved.panel.map((entry: PanelEntry) => [entry.vendor, entry.model]),
    [['claude', claudeAdapter.defaultModel], ['codex', codexAdapter.defaultModel]],
  );
});

test('a CLI too old for crbuddy go is flagged and never added by default', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-panel-outdated-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const addAnotherDefaults: boolean[] = [];
  const reviewerHints: Array<string | undefined> = [];
  class RecordingUI extends DefaultingUI {
    override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      if (question.endsWith('Add another?')) addAnotherDefaults.push(defaultYes);
      return super.confirm(question, defaultYes);
    }
    override async select<T>(
      question: string,
      choices: Array<Choice<T>>,
      initialIndex = 0,
    ): Promise<T> {
      if (question === 'Add a reviewer') reviewerHints.push(...choices.map((choice) => choice.hint));
      return super.select(question, choices, initialIndex);
    }
  }
  const ui = new RecordingUI();
  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    {
      ui,
      detect: async () => [
        { adapter: claudeAdapter, present: true, version: '2.0.0' },
        { adapter: codexAdapter, present: true, version: codexAdapter.minVersion },
      ],
      settingsFile: path.join(repo, 'settings.json'),
    },
  );
  assert.equal(code, 0);
  // Codex is the only usable CLI: it is the first default, and none follows.
  assert.deepEqual(addAnotherDefaults, [false]);
  const saved = JSON.parse(await readFile(path.join(repo, '.crbuddy', 'config.json'), 'utf8'));
  assert.deepEqual(saved.panel.map((entry: PanelEntry) => entry.vendor), ['codex']);
  // Still offered, for someone about to update it.
  assert.deepEqual(reviewerHints, ['too old; update claude before crbuddy go', undefined]);
  const vendors = ui.notes.find((entry) => entry.title === 'Vendor CLIs')?.message ?? '';
  assert.ok(
    vendors.includes(
      `✗ Claude Code  2.0.0 (claude) - too old; crbuddy needs ${claudeAdapter.minVersion} or newer`,
    ),
    vendors,
  );
  assert.ok(vendors.includes(`✓ Codex CLI  ${codexAdapter.minVersion} (codex)`), vendors);
});

test('a CLI whose version cannot be read is flagged and never added by default', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-panel-unreadable-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const reviewerHints: Array<string | undefined> = [];
  class RecordingUI extends DefaultingUI {
    override async select<T>(
      question: string,
      choices: Array<Choice<T>>,
      initialIndex = 0,
    ): Promise<T> {
      if (question === 'Add a reviewer') reviewerHints.push(...choices.map((choice) => choice.hint));
      return super.select(question, choices, initialIndex);
    }
  }
  const ui = new RecordingUI();
  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    {
      ui,
      detect: async () => [
        { adapter: claudeAdapter, present: true, version: null },
        { adapter: codexAdapter, present: true, version: codexAdapter.minVersion },
      ],
      settingsFile: path.join(repo, 'settings.json'),
    },
  );
  assert.equal(code, 0);
  // crbuddy go will not guess at an unreadable version, so it is no default.
  const saved = JSON.parse(await readFile(path.join(repo, '.crbuddy', 'config.json'), 'utf8'));
  assert.deepEqual(saved.panel.map((entry: PanelEntry) => entry.vendor), ['codex']);
  assert.deepEqual(reviewerHints, ['version unreadable; crbuddy go will refuse it', undefined]);
  const vendors = ui.notes.find((entry) => entry.title === 'Vendor CLIs')?.message ?? '';
  assert.ok(
    vendors.includes('\u2717 Claude Code  installed; version unknown (claude) - crbuddy cannot read its version and will not guess'),
    vendors,
  );
});

test('setup shows the gpt-6.1-sol minimum on an older Codex without refusing Codex', async (t) => {
  const setup = async (version: string) => {
    const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-model-minimum-'));
    t.after(() => rm(repo, { recursive: true, force: true }));
    const reviewerHints: Array<string | undefined> = [];
    let modelChoices: Array<Choice<unknown>> = [];
    let modelDefault: unknown;
    class RecordingUI extends DefaultingUI {
      override async select<T>(
        question: string,
        choices: Array<Choice<T>>,
        initialIndex = 0,
      ): Promise<T> {
        if (question === 'Add a reviewer') reviewerHints.push(...choices.map((choice) => choice.hint));
        if (question === 'Model for Codex CLI') {
          modelChoices = choices;
          modelDefault = choices[initialIndex]?.value;
        }
        return super.select(question, choices, initialIndex);
      }
    }
    const ui = new RecordingUI();
    const code = await runInit(
      { repoRoot: repo, scope: 'project' },
      {
        ui,
        detect: async () => [{ adapter: codexAdapter, present: true, version }],
        settingsFile: path.join(repo, 'settings.json'),
      },
    );
    assert.equal(code, 0);
    const saved = JSON.parse(await readFile(path.join(repo, '.crbuddy', 'config.json'), 'utf8'));
    return {
      ui,
      reviewerHints,
      modelChoices,
      modelDefault,
      models: saved.panel.map((entry: PanelEntry) => entry.model),
      vendors: ui.notes.find((entry) => entry.title === 'Vendor CLIs')?.message ?? '',
      warnings: ui.messages.filter((entry) => entry.kind === 'warn').map((entry) => entry.message),
    };
  };

  const old = await setup('0.158.0');
  // Codex stays usable and the default; only the one model is marked.
  assert.deepEqual(old.reviewerHints, [undefined]);
  assert.ok(
    old.vendors.includes(
      '✓ Codex CLI  0.158.0 (codex)\n' +
        "  gpt-6.1-sol needs 0.159.2 or newer (crbuddy's tested baseline); other models run on 0.158.0",
    ),
    old.vendors,
  );
  assert.equal(old.modelDefault, 'gpt-6.1-sol');
  assert.deepEqual(
    old.modelChoices.map((choice) => choice.hint),
    [
      'frontier',
      'workhorse; needs 0.159.2+, found 0.158.0',
      'fast and cheap',
      'any id `codex` accepts, passed through unchecked',
    ],
  );
  assert.deepEqual(old.models, ['gpt-6.1-sol']);
  assert.equal(old.warnings.length, 1);
  assert.match(old.warnings[0]!, /^crbuddy go will refuse this reviewer here:\ngpt-6\.1-sol requires Codex CLI >= 0\.159\.2/);
  assert.match(old.warnings[0]!, /npm install -g @openai\/codex@0\.159\.2/);

  // Reviewers kept from an earlier setup are checked as well.
  const kept = await (async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-model-minimum-kept-'));
    t.after(() => rm(repo, { recursive: true, force: true }));
    const configPath = path.join(repo, '.crbuddy', 'config.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      configVersion: CONFIG_VERSION,
      output: { ...DEFAULT_OUTPUT },
      target: 'uncommitted',
      panel: [
        { id: 'sol61', vendor: 'codex', model: 'gpt-6.1-sol' },
        { id: 'sol6', vendor: 'codex', model: 'gpt-6-sol' },
      ],
    }));
    const ui = new DefaultingUI();
    const code = await runInit(
      { repoRoot: repo, scope: 'project' },
      {
        ui,
        detect: async () => [{ adapter: codexAdapter, present: true, version: '0.158.0' }],
        settingsFile: path.join(repo, 'settings.json'),
      },
    );
    assert.equal(code, 0);
    return ui.messages.filter((entry) => entry.kind === 'warn').map((entry) => entry.message);
  })();
  assert.equal(kept.length, 1, kept.join('\n'));
  assert.match(kept[0]!, /^crbuddy go will refuse this reviewer here:\ngpt-6\.1-sol requires Codex CLI >= 0\.159\.2/);

  const current = await setup('0.159.2');
  assert.ok(current.vendors.includes('✓ Codex CLI  0.159.2 (codex)'), current.vendors);
  assert.doesNotMatch(current.vendors, /needs/);
  assert.equal(current.modelChoices[1]?.hint, 'workhorse');
  assert.deepEqual(current.warnings, []);
});

test('setup stops when every installed CLI is too old for crbuddy go', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-panel-all-outdated-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const ui = new DefaultingUI();
  const code = await runInit(
    { repoRoot: repo, scope: 'project' },
    {
      ui,
      detect: async () => [{ adapter: claudeAdapter, present: true, version: '2.0.0' }],
      settingsFile: path.join(repo, 'settings.json'),
    },
  );
  assert.equal(code, 1);
  assert.match(ui.cancelled.join('\n'), /Every installed vendor CLI is too old for crbuddy, or its version cannot/);
  assert.ok(!existsSync(path.join(repo, '.crbuddy', 'config.json')));
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

async function addFixture(t: import('node:test').TestContext) {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-add-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const configPath = path.join(repo, '.crbuddy', 'config.json');
  const settingsFile = path.join(repo, 'settings.json');
  const gitignore = path.join(repo, '.gitignore');
  const existing: Config = {
    configVersion: CONFIG_VERSION,
    output: { destination: 'terminal', merged: 'reviews/custom.md' },
    target: { base: 'release' },
    savedReviewInstructions: 'Saved criteria.\nKeep these for reuse.',
    refuseIfOutputExists: true,
    timeoutMs: 123_456,
    maxConcurrent: 3,
    maxDiffBytes: 654_321,
    panel: [
      {
        id: 'codex-gpt-6-1-sol', vendor: 'codex', model: 'gpt-6.1-sol',
        effort: 'xhigh', instructions: 'Existing instructions.\nSecond line.',
        vendorArgs: ['--some-flag', 'value with spaces'],
      },
      { id: 'codex-gpt-6-1-sol-2', vendor: 'claude', model: 'old-model', effort: 'custom-effort' },
    ],
  };
  await mkdir(path.dirname(configPath));
  await writeFile(configPath, JSON.stringify(existing));
  await writeFile(settingsFile, JSON.stringify({ notifications: { provider: 'ntfy', endpoint } }));
  await writeFile(gitignore, '# Existing ignores\nnode_modules/\n');
  const before = await Promise.all([configPath, settingsFile, gitignore].map((file) => readFile(file, 'utf8')));
  return {
    repo, configPath, settingsFile, gitignore, existing, before,
    run: (ui: WizardUI, detections: Detection[] = [{ ...detection, version: '0.159.2' }]) => runInit(
      { repoRoot: repo, mode: 'add' },
      { ui, detect: async () => detections, settingsFile },
    ),
  };
}

class AddUI extends DefaultingUI {
  override readonly interactive = true;
  readonly questions: string[] = [];
  added = 0;

  constructor(private readonly additions = 1) { super(); }

  override async select<T>(question: string, choices: Array<Choice<T>>, initialIndex = 0): Promise<T> {
    this.questions.push(question);
    if (question.startsWith('Where should this config live?')) {
      assert.deepEqual(choices.map((choice) => choice.value), ['global', 'project']);
      assert.equal(initialIndex, 1);
    } else {
      assert.match(question, /^(Add a reviewer|Model for |Thinking effort for |Review instructions for )/);
    }
    return super.select(question, choices, initialIndex);
  }

  override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
    this.questions.push(question);
    if (question.endsWith('Add another?')) {
      // The first such question must follow an actual addition, even with a saved panel.
      assert.equal(this.notes.filter((note) => note.title === 'Panel').length, this.added + 2);
      return ++this.added < this.additions;
    }
    assert.equal(question, 'Save this config?');
    assert.equal(defaultYes, true);
    assert.equal(this.notes.at(-1)?.title, 'Configuration');
    return true;
  }
}

test('add preserves the saved panel and settings, appends unique IDs, and shares the full summary', async (t) => {
  const f = await addFixture(t);
  const ui = new AddUI(2);
  assert.equal(await f.run(ui), 0);
  const written = JSON.parse(await readFile(f.configPath, 'utf8')) as Config;
  assert.deepEqual(written, {
    ...f.existing,
    panel: [
      ...f.existing.panel,
      { id: 'codex-gpt-6-1-sol-3', vendor: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
      { id: 'codex-gpt-6-1-sol-4', vendor: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
    ],
  });
  assert.match(ui.questions[0]!, /^Where should this config live/);
  assert.equal(ui.questions[1], 'Add a reviewer');
  assert.equal(ui.questions.at(-1), 'Save this config?');
  assert.equal(ui.notes.find((note) => note.title === 'Current panel')?.message.split('\n').length, 2);
  assert.deepEqual(ui.notes.filter((note) => note.title === 'Panel').map((note) => note.message.split('\n').length), [2, 3, 4]);
  const summary = ui.notes.at(-1)!.message;
  assert.ok(summary.includes(f.configPath));
  assert.match(summary, /Config: This repository/);
  assert.equal(summary.match(/Codex CLI/g)?.length, 3);
  assert.match(summary, /Claude Code.*old-model.*custom-effort/);
  assert.match(summary, /Target: Current branch vs release\nOutput: Terminal\nNotifications \(global\): ntfy/);
  assert.equal(await readFile(f.settingsFile, 'utf8'), f.before[1]);
  assert.equal(await readFile(f.gitignore, 'utf8'), f.before[2]);
});

test('add reuses manual model/effort entry and custom instruction prompts', async (t) => {
  const f = await addFixture(t);
  class CustomUI extends AddUI {
    override async select<T>(question: string, choices: Array<Choice<T>>, initialIndex = 0): Promise<T> {
      if (question.startsWith('Model for ') || question.startsWith('Thinking effort for ')) {
        return choices.find((choice) => choice.label === 'Other…')!.value;
      }
      if (question.startsWith('Review instructions for ')) {
        return choices.find((choice) => choice.value === 'custom')!.value;
      }
      return super.select(question, choices, initialIndex);
    }
    override async text(question: string): Promise<string> {
      assert.ok(['Model id', 'Effort value'].includes(question));
      return question === 'Model id' ? 'future-model' : 'future-effort';
    }
    override async multiline(question: string): Promise<string> {
      assert.equal(question, 'Review instructions');
      return 'New custom criteria.\nAnother line.';
    }
    override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      if (question === 'Replace the saved review instructions with these?') return false;
      return super.confirm(question, defaultYes);
    }
  }
  assert.equal(await f.run(new CustomUI()), 0);
  const written = JSON.parse(await readFile(f.configPath, 'utf8')) as Config;
  assert.deepEqual(written.panel.at(-1), {
    id: 'codex-future-model', vendor: 'codex', model: 'future-model', effort: 'future-effort',
    instructions: 'New custom criteria.\nAnother line.',
  });
  assert.deepEqual({ ...written, panel: f.existing.panel }, f.existing);
});

test('add uses saved instructions for vendors that require explicit instructions', async (t) => {
  const f = await addFixture(t);
  assert.equal(await f.run(new AddUI(), [{ adapter: geminiAdapter, present: true, version: '99.0.0' }]), 0);
  const written = JSON.parse(await readFile(f.configPath, 'utf8')) as Config;
  assert.equal(written.panel.at(-1)?.vendor, 'gemini');
  assert.equal(written.panel.at(-1)?.instructions, f.existing.savedReviewInstructions);
  assert.deepEqual({ ...written, panel: f.existing.panel }, f.existing);
});

test('add decline and cancellation leave config, settings, and gitignore byte-for-byte unchanged', async (t) => {
  for (const stage of ['scope', 'detection', 'reviewer', 'instructions', 'save', 'decline']) {
    await t.test(stage, async (t) => {
      const f = await addFixture(t);
      class CancelUI extends AddUI {
        override async select<T>(question: string, choices: Array<Choice<T>>, initialIndex = 0): Promise<T> {
          if ((stage === 'scope' && question.startsWith('Where should this config live?')) ||
              (stage === 'reviewer' && question === 'Add a reviewer') ||
              (stage === 'instructions' && question.startsWith('Review instructions for '))) {
            throw new PromptAborted();
          }
          return super.select(question, choices, initialIndex);
        }
        override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
          if (question === 'Save this config?') {
            if (stage === 'decline') return false;
            if (stage === 'save') throw new PromptAborted();
          }
          return super.confirm(question, defaultYes);
        }
      }
      const code = await runInit({ repoRoot: f.repo, mode: 'add' }, {
        ui: new CancelUI(), settingsFile: f.settingsFile,
        detect: async () => {
          if (stage === 'detection') throw new PromptAborted();
          return [{ ...detection, version: '0.159.2' }];
        },
      });
      assert.equal(code, stage === 'decline' ? 1 : 130);
      assert.deepEqual(await Promise.all(
        [f.configPath, f.settingsFile, f.gitignore].map((file) => readFile(file, 'utf8')),
      ), f.before);
    });
  }
});

test('add refuses invalid or unreadable configs without offering replacement or detecting vendors', async (t) => {
  for (const kind of ['json', 'schema', 'directory', 'output-directory', 'symlink']) {
    await t.test(kind, { skip: kind === 'symlink' && process.platform === 'win32' }, async (t) => {
      const f = await addFixture(t);
      await rm(f.configPath);
      if (kind === 'directory') await mkdir(f.configPath);
      else if (kind === 'symlink') await symlink(path.join(f.repo, 'missing.json'), f.configPath);
      else if (kind === 'output-directory') {
        await mkdir(path.join(f.repo, 'reports'));
        await writeFile(f.configPath, JSON.stringify({ ...f.existing, output: { destination: 'file', merged: 'reports' } }));
      } else await writeFile(f.configPath, kind === 'json' ? '{invalid' : '{"configVersion":99}');
      const before = kind === 'directory' || kind === 'symlink' ? null : await readFile(f.configPath, 'utf8');
      const ui = new AddUI();
      const code = await runInit({ repoRoot: f.repo, scope: 'project', mode: 'add' }, {
        ui, settingsFile: f.settingsFile, detect: async () => { throw new Error('Unexpected vendor detection'); },
      });
      assert.equal(code, 1);
      assert.deepEqual(ui.questions, []);
      assert.match(ui.messages.map((message) => message.message).join('\n'), /Could not parse it:/);
      if (before !== null) assert.equal(await readFile(f.configPath, 'utf8'), before);
      assert.equal(await readFile(f.settingsFile, 'utf8'), f.before[1]);
      assert.equal(await readFile(f.gitignore, 'utf8'), f.before[2]);
    });
  }
});

test('add follows the existing serializer for legacy consolidation and raw-output keys', async (t) => {
  const f = await addFixture(t);
  await writeFile(f.configPath, JSON.stringify({
    ...f.existing,
    merge: { enabled: true, vendor: 'codex', model: 'gpt-6-luna' },
    mergeTimeoutMs: 10_000,
    output: { ...f.existing.output, raw: 'custom.raw.md' },
  }));
  assert.equal(await f.run(new AddUI()), 0);
  const written = JSON.parse(await readFile(f.configPath, 'utf8'));
  assert.equal(written.output.raw, 'custom.raw.md');
  assert.ok(!('merge' in written));
  assert.ok(!('mergeTimeoutMs' in written));
  assert.deepEqual(written.panel.slice(0, f.existing.panel.length), f.existing.panel);
});
