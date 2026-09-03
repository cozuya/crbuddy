import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import { PromptAborted } from '../src/util/prompt.js';
import { probe, runProcess } from '../src/run/spawn.js';
import { createWizardUI } from '../src/util/wizard-prompt.js';

class TtyInput extends PassThrough {
  isTTY = true;
  isRaw = false;
  readonly rawStates: boolean[] = [];

  setRawMode(enabled: boolean): void {
    this.isRaw = enabled;
    this.rawStates.push(enabled);
  }
}

test('non-TTY wizard creation does not load the Clack adapter', async () => {
  let loads = 0;

  const ui = await createWizardUI({
    interactive: false,
    loadClack: async () => {
      loads += 1;
      throw new Error('Clack must not load for piped input');
    },
  });

  assert.equal(ui.interactive, false);
  assert.equal(loads, 0);
});

test('the TTY adapter maps defaults and disabled choices into Clack without helper footer', async () => {
  let received: Record<string, unknown> | undefined;
  const input = new PassThrough();
  const output = new PassThrough();
  const clack = fakeClack({
    select: async (options: Record<string, unknown>) => {
      received = options;
      return 'second';
    },
  });
  const ui = await createWizardUI({
    interactive: true,
    input,
    output,
    loadClack: async () => clack,
  });

  const value = await ui.select(
    'Pick one',
    [
      { label: 'First', value: 'first', disabled: true },
      { label: 'Second', value: 'second', hint: 'recommended' },
    ],
    1,
  );

  assert.equal(value, 'second');
  assert.equal(received?.initialValue, 'second');
  assert.equal(received?.showInstructions, false);
  assert.deepEqual(received?.options, [
    { label: 'First', value: 'first', disabled: true },
    { label: 'Second', value: 'second', hint: 'recommended' },
  ]);
});

test('the TTY adapter normalizes Clack cancellation to PromptAborted', async () => {
  const cancelled = Symbol('cancelled');
  const ui = await createWizardUI({
    interactive: true,
    input: new PassThrough(),
    output: new PassThrough(),
    loadClack: async () =>
      fakeClack({
        select: async () => cancelled,
        isCancel: (value: unknown) => value === cancelled,
      }),
  });

  await assert.rejects(
    ui.select('Pick one', [{ label: 'One', value: 1 }]),
    PromptAborted,
  );
});

test('TTY text uses the fallback for whitespace-only input', async () => {
  const ui = await createWizardUI({
    interactive: true,
    input: new PassThrough(),
    output: new PassThrough(),
    loadClack: async () =>
      fakeClack({
        text: async () => '   ',
      }),
  });

  assert.equal(await ui.text('Base branch', 'main'), 'main');
});

test('native Windows multiline preserves pasted tabs and CRs until Ctrl+D submits', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const ui = await createWizardUI({
    interactive: true,
    platform: 'win32',
    input,
    output,
    loadClack: async () => fakeClack(),
  });

  const result = ui.multiline('Review instructions');
  input.write('first\r\tsecond\r');
  input.write('\u0004');

  assert.equal(await result, 'first\n\tsecond');
  assert.deepEqual(input.rawStates, [true, false]);
});

test('unknown POSIX terminals also use explicit-submit multiline mode', async () => {
  const input = new TtyInput();
  const output = new PassThrough();
  const ui = await createWizardUI({
    interactive: true,
    platform: 'darwin',
    environment: { TERM_PROGRAM: 'Apple_Terminal' },
    input,
    output,
    loadClack: async () => fakeClack(),
  });

  const result = ui.multiline('Review instructions');
  input.write('first\rsecond\r');
  input.write('\u0004');

  assert.equal(await result, 'first\nsecond');
  assert.deepEqual(input.rawStates, [true, false]);
});

test('cancelling the TTY spinner aborts the active operation', async () => {
  let cancelled = false;
  const ui = await createWizardUI({
    interactive: true,
    input: new PassThrough(),
    output: new PassThrough(),
    loadClack: async () =>
      fakeClack({
        spinner: (options: { onCancel?: () => void }) => ({
          get isCancelled() {
            return cancelled;
          },
          start() {
            cancelled = true;
            options.onCancel?.();
          },
          stop() {},
          cancel() {},
          error() {},
        }),
      }),
  });

  await assert.rejects(
    ui.spinner('Checking', async (signal) => {
      assert.equal(signal.aborted, true);
      return 'unused';
    }),
    PromptAborted,
  );
});

test('an aborted vendor probe terminates its child promptly', async () => {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), 100);

  try {
    await probe(
      process.execPath,
      ['--eval', 'setInterval(() => {}, 1000)'],
      controller.signal,
    );
  } finally {
    clearTimeout(timer);
  }

  assert.ok(Date.now() - started < 5000, 'aborted probe did not exit promptly');
});

test('termination escalation survives the process leader closing', async (t) => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'crbuddy-tree-test-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const marker = path.join(scratch, 'descendant-survived');
  const descendant = `
    const fs = require('node:fs');
    process.on('SIGTERM', () => {});
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(marker)}, 'alive');
      process.exit(0);
    }, 700);
  `;
  const leader = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['--eval', ${JSON.stringify(descendant)}], {
      stdio: 'ignore'
    });
    child.unref();
    setInterval(() => {}, 1000);
  `;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 200);

  try {
    await runProcess({
      command: process.execPath,
      args: ['--eval', leader],
      cwd: scratch,
      timeoutMs: 5000,
      scratchDir: scratch,
      id: 'tree-escalation',
      signal: controller.signal,
      killGraceMs: 100,
    });
  } finally {
    clearTimeout(timer);
  }

  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(existsSync(marker), false, 'SIGTERM-resistant descendant survived');
});

test('piped prompts consume sequential answers from one stdin drain', async () => {
  const promptUrl = pathToFileURL(
    path.resolve('dist-test/src/util/prompt.js'),
  ).href;
  const script = `
    import { confirm, select, text } from ${JSON.stringify(promptUrl)};
    const selected = await select('Choose', [
      { label: 'Disabled', value: 'blocked', disabled: true },
      { label: 'Enabled', value: 'ok' }
    ]);
    const confirmed = await confirm('Continue?', false);
    const entered = await text('Name:');
    console.log('RESULT:' + JSON.stringify({ selected, confirmed, entered }));
  `;

  const result = await runNode(script, '1\n2\ny\nreviewer\n');

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Pick one of the numbers above/);
  assert.match(
    result.stdout,
    /RESULT:{"selected":"ok","confirmed":true,"entered":"reviewer"}/,
  );
});

type FakeOverrides = {
  select?: (options: Record<string, unknown>) => Promise<unknown>;
  text?: (options: Record<string, unknown>) => Promise<unknown>;
  multiline?: (options: Record<string, unknown>) => Promise<unknown>;
  isCancel?: (value: unknown) => boolean;
  spinner?: (options: { onCancel?: () => void }) => unknown;
};

function fakeClack(overrides: FakeOverrides = {}) {
  const noop = () => {};

  return {
    intro: noop,
    outro: noop,
    cancel: noop,
    note: noop,
    log: { info: noop, success: noop, warn: noop, error: noop },
    select: overrides.select ?? (async () => 'value'),
    confirm: async () => true,
    text: overrides.text ?? (async () => 'text'),
    multiline: overrides.multiline ?? (async () => 'multiline'),
    isCancel: overrides.isCancel ?? (() => false),
    spinner:
      overrides.spinner ??
      (() => ({
        isCancelled: false,
        start: noop,
        stop: noop,
        cancel: noop,
        error: noop,
      })),
  } as unknown as typeof import('@clack/prompts');
}

async function runNode(
  script: string,
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}
