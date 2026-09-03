import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { codexAdapter } from '../src/adapters/vendors.js';
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
    { ui: new DefaultingUI(), detect: async () => [detection] },
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
    { ui, detect: async () => [detection] },
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
    { ui, detect: async () => [detection] },
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
    { ui: new DefaultingUI(), detect: async () => [detection] },
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
    { ui: new DefaultingUI(), detect: async () => [detection] },
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
    { ui, detect: async () => [detection] },
  );

  assert.equal(code, 130);
  assert.equal(existsSync(path.join(repo, '.crbuddy', 'config.json')), false);
  assert.equal(existsSync(path.join(repo, '.gitignore')), false);
  assert.match(ui.cancelled.at(-1) ?? '', /No config was written/);
});

class DefaultingUI implements WizardUI {
  readonly interactive: boolean = false;
  readonly notes: Array<{ title?: string; message: string }> = [];
  readonly messages: Array<{ kind?: MessageKind; message: string }> = [];
  readonly cancelled: string[] = [];

  intro(): void {}
  outro(): void {}

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
