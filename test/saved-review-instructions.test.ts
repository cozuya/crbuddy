import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { codexAdapter } from '../src/adapters/vendors.js';
import {
  formatSavedReviewInstructions,
  runInit,
  type Detection,
} from '../src/commands/init.js';
import { runView } from '../src/commands/view.js';
import { projectConfigPath, validate } from '../src/config/load.js';
import {
  CONFIG_VERSION,
  DEFAULTS,
  DEFAULT_OUTPUT,
  type Config,
} from '../src/config/schema.js';
import type { Choice } from '../src/util/prompt.js';
import type { MessageKind, WizardUI } from '../src/util/wizard-prompt.js';

const detection: Detection = {
  adapter: codexAdapter,
  present: true,
  version: codexAdapter.minVersion,
};

function existingConfig(savedReviewInstructions?: string): Config {
  return {
    configVersion: CONFIG_VERSION,
    output: { ...DEFAULT_OUTPUT, destination: 'terminal' },
    target: 'uncommitted',
    ...(savedReviewInstructions ? { savedReviewInstructions } : {}),
    refuseIfOutputExists: DEFAULTS.refuseIfOutputExists,
    timeoutMs: DEFAULTS.timeoutMs,
    maxConcurrent: DEFAULTS.maxConcurrent,
    maxDiffBytes: DEFAULTS.maxDiffBytes,
    panel: [
      {
        id: 'old-reviewer',
        vendor: 'codex',
        model: 'gpt-6-sol',
        effort: 'high',
      },
    ],
  };
}

async function writeConfig(repo: string, config: Config): Promise<string> {
  const file = projectConfigPath(repo);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  return file;
}

class TestUI implements WizardUI {
  readonly interactive: boolean = false;
  readonly notes: Array<{ title?: string; message: string }> = [];
  readonly messages: Array<{ kind?: MessageKind; message: string }> = [];
  readonly confirmations: string[] = [];
  readonly selections: string[] = [];

  intro(): void {}
  outro(): void {}
  cancel(): void {}

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
    question: string,
    choices: Array<Choice<T>>,
    initialIndex = 0,
  ): Promise<T> {
    this.selections.push(question);
    const selected = choices[initialIndex] ?? choices.find((choice) => !choice.disabled);
    if (!selected || selected.disabled) throw new Error(`No selectable choice for ${question}`);
    return selected.value;
  }

  async confirm(question: string, defaultYes: boolean): Promise<boolean> {
    this.confirmations.push(question);
    return defaultYes;
  }

  async text(_question: string, fallback = ''): Promise<string> {
    if (fallback === '') throw new Error('Unexpected required text prompt');
    return fallback;
  }

  async multiline(question: string): Promise<string> {
    throw new Error(`Unexpected multiline prompt: ${question}`);
  }
}

class InteractiveTestUI extends TestUI {
  override readonly interactive = true;
}

class ReplacePanelUI extends InteractiveTestUI {
  override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
    this.confirmations.push(question);
    if (question === 'Keep these reviewers?') return false;
    return defaultYes;
  }
}

function choiceByLabel<T>(choices: Array<Choice<T>>, label: string): T {
  const choice = choices.find((candidate) => candidate.label === label);
  if (!choice || choice.disabled) throw new Error(`Missing choice: ${label}`);
  return choice.value;
}

test('config accepts savedReviewInstructions and rejects an empty saved value', () => {
  const config = validate({
    panel: [{ vendor: 'codex', model: 'gpt-6-sol' }],
    savedReviewInstructions: 'Review for correctness.',
  });

  assert.equal(config.savedReviewInstructions, 'Review for correctness.');
  assert.throws(
    () =>
      validate({
        panel: [{ vendor: 'codex', model: 'gpt-6-sol' }],
        savedReviewInstructions: '   ',
      }),
    /savedReviewInstructions.*non-empty string/,
  );
});

test('saved instruction preview shows one compact line plus approximate remaining scope', () => {
  const instructions = `${'A'.repeat(100)}\n${'B'.repeat(160)}`;
  const preview = formatSavedReviewInstructions(instructions);

  assert.equal(preview, `${'A'.repeat(79)}… (and ~3 more lines)`);
});

test('saved instruction preview does not split Unicode surrogate pairs', () => {
  const preview = formatSavedReviewInstructions(`${'A'.repeat(78)}😀BC`);
  assert.equal(preview, `${'A'.repeat(78)}😀… (and ~1 more line)`);
});

test('saved instruction preview strips terminal control sequences', () => {
  const preview = formatSavedReviewInstructions(
    '\x1b]0;spoofed title\x07\x1b[31mReview carefully\x1b[0m\nSecond line',
  );

  assert.equal(preview, 'Review carefully (and ~1 more line)');
  assert.doesNotMatch(preview, /\x1b|spoofed title/);
});

test('init offers saved custom instructions as a third native-review choice', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-saved-review-use-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const saved = 'Review the changes for correctness and regressions.';
  const configFile = await writeConfig(repo, existingConfig(saved));

  class UseSavedUI extends ReplacePanelUI {
    override async select<T>(
      question: string,
      choices: Array<Choice<T>>,
      initialIndex = 0,
    ): Promise<T> {
      this.selections.push(question);
      if (question === 'Review instructions for Codex CLI') {
        assert.deepEqual(
          choices.map((choice) => choice.label),
          [
            'Use default instructions',
            'Use saved custom instructions',
            'Enter custom instructions',
          ],
        );
        return choiceByLabel(choices, 'Use saved custom instructions');
      }
      return super.select(question, choices, initialIndex);
    }
  }

  const ui = new UseSavedUI();
  assert.equal(
    await runInit(
      { repoRoot: repo, scope: 'project' },
      { ui, detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
    ),
    0,
  );

  const written = JSON.parse(await readFile(configFile, 'utf8')) as Config;
  assert.equal(written.savedReviewInstructions, saved);
  assert.equal(written.panel[0]?.instructions, saved);
  assert.ok(ui.confirmations.includes('Keep these saved review instructions for reuse?'));
});

test('new custom instructions can be saved for reuse and appear in the config summary', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-saved-review-new-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const custom = `Review the supplied branch carefully. ${'x'.repeat(100)}\nCheck recovery paths too.`;

  class SaveNewUI extends InteractiveTestUI {
    override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      this.confirmations.push(question);
      if (question.startsWith('Give this reviewer custom instructions?')) return true;
      if (question === 'Save these review instructions for reuse?') return true;
      return defaultYes;
    }

    override async multiline(question: string): Promise<string> {
      assert.equal(question, 'Review instructions');
      return custom;
    }
  }

  const ui = new SaveNewUI();
  assert.equal(
    await runInit(
      { repoRoot: repo, scope: 'project' },
      { ui, detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
    ),
    0,
  );

  const configFile = projectConfigPath(repo);
  const written = JSON.parse(await readFile(configFile, 'utf8')) as Config;
  assert.equal(written.savedReviewInstructions, custom);
  assert.equal(written.panel[0]?.instructions, custom);
  assert.ok(ui.confirmations.includes('Save these review instructions for reuse?'));

  const summary = ui.notes.find((entry) => entry.title === 'Configuration')?.message ?? '';
  assert.match(summary, /Saved review instructions: Review the supplied branch carefully\./);
  assert.match(summary, /\(and ~\d+ more lines\)/);
});

test('different custom instructions can be used without replacing the saved copy', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-saved-review-decline-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const saved = 'The saved review prompt.';
  const custom = 'A one-off review prompt for this reviewer.';
  const configFile = await writeConfig(repo, existingConfig(saved));

  class DeclineReplaceUI extends ReplacePanelUI {
    override async select<T>(
      question: string,
      choices: Array<Choice<T>>,
      initialIndex = 0,
    ): Promise<T> {
      this.selections.push(question);
      if (question === 'Review instructions for Codex CLI') {
        return choiceByLabel(choices, 'Enter custom instructions');
      }
      return super.select(question, choices, initialIndex);
    }

    override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      this.confirmations.push(question);
      if (question === 'Keep these reviewers?') return false;
      if (question === 'Replace the saved review instructions with these?') return false;
      return defaultYes;
    }

    override async multiline(): Promise<string> {
      return custom;
    }
  }

  const ui = new DeclineReplaceUI();
  assert.equal(
    await runInit(
      { repoRoot: repo, scope: 'project' },
      { ui, detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
    ),
    0,
  );

  const written = JSON.parse(await readFile(configFile, 'utf8')) as Config;
  assert.equal(written.savedReviewInstructions, saved);
  assert.equal(written.panel[0]?.instructions, custom);
  assert.ok(ui.confirmations.includes('Replace the saved review instructions with these?'));
});

test('re-entering the saved instructions does not ask to save them again', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-saved-review-same-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const saved = 'Same instructions.\nSecond line.';
  const configFile = await writeConfig(repo, existingConfig(saved));

  class SameCustomUI extends ReplacePanelUI {
    override async select<T>(
      question: string,
      choices: Array<Choice<T>>,
      initialIndex = 0,
    ): Promise<T> {
      this.selections.push(question);
      if (question === 'Review instructions for Codex CLI') {
        return choiceByLabel(choices, 'Enter custom instructions');
      }
      return super.select(question, choices, initialIndex);
    }

    override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      this.confirmations.push(question);
      if (question === 'Keep these reviewers?') return false;
      assert.notEqual(question, 'Replace the saved review instructions with these?');
      return defaultYes;
    }

    override async multiline(): Promise<string> {
      return saved.replace(/\n/g, '\r\n');
    }
  }

  const ui = new SameCustomUI();
  assert.equal(
    await runInit(
      { repoRoot: repo, scope: 'project' },
      { ui, detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
    ),
    0,
  );

  const written = JSON.parse(await readFile(configFile, 'utf8')) as Config;
  assert.equal(written.savedReviewInstructions, saved);
  assert.equal(written.panel[0]?.instructions, saved.replace(/\n/g, '\r\n'));
  assert.doesNotMatch(ui.confirmations.join('\n'), /Replace the saved review instructions/);
});

test('interactive config can forget saved review instructions without adding a reviewer', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-saved-review-forget-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const configFile = await writeConfig(repo, existingConfig('Sensitive old prompt.'));

  class ForgetSavedUI extends InteractiveTestUI {
    override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      this.confirmations.push(question);
      if (question === 'Keep these saved review instructions for reuse?') return false;
      return defaultYes;
    }
  }

  const ui = new ForgetSavedUI();
  assert.equal(
    await runInit(
      { repoRoot: repo, scope: 'project' },
      { ui, detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
    ),
    0,
  );

  const written = JSON.parse(await readFile(configFile, 'utf8')) as Config;
  assert.equal(written.savedReviewInstructions, undefined);
});

test('piped setup keeps the legacy answer sequence and does not ask to save custom instructions', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-saved-review-piped-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const custom = 'One-off piped review instructions.';

  class PipedCustomUI extends TestUI {
    override async confirm(question: string, defaultYes: boolean): Promise<boolean> {
      this.confirmations.push(question);
      if (question.startsWith('Give this reviewer custom instructions?')) return true;
      if (/saved review instructions|Save these review instructions|Replace the saved review/i.test(question)) {
        throw new Error(`piped setup consumed a new saved-instruction question: ${question}`);
      }
      return defaultYes;
    }

    override async multiline(question: string): Promise<string> {
      assert.equal(question, 'Review instructions');
      return custom;
    }
  }

  const ui = new PipedCustomUI();
  assert.equal(
    await runInit(
      { repoRoot: repo, scope: 'project' },
      { ui, detect: async () => [detection], settingsFile: path.join(repo, 'settings.json') },
    ),
    0,
  );

  const written = JSON.parse(
    await readFile(projectConfigPath(repo), 'utf8'),
  ) as Config;
  assert.equal(written.panel[0]?.instructions, custom);
  assert.equal(written.savedReviewInstructions, undefined);
});

test('crb view includes the saved review preview without dumping the full prompt', async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), 'crbuddy-saved-review-view-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const saved = `${'First line '.repeat(12)}\nSecond line that should not be printed verbatim.`;
  await writeConfig(repo, existingConfig(saved));

  const ui = new TestUI();
  assert.equal(
    await runView(
      { repoRoot: repo },
      { ui, settingsFile: path.join(repo, 'missing-settings.json') },
    ),
    0,
  );

  const summary = ui.notes.find((entry) => entry.title === 'Configuration')?.message ?? '';
  assert.match(summary, /Saved review instructions:/);
  assert.match(summary, /\(and ~\d+ more lines\)/);
  assert.doesNotMatch(summary, /Second line that should not be printed verbatim/);
});
