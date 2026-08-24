import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import {
  installExitCleanup,
  Progress,
  supportsTerminalProgress,
} from '../src/run/progress.js';

class Capture {
  readonly columns = 80;
  value = '';

  constructor(readonly isTTY: boolean) {}

  write(text: string): boolean {
    this.value += text;
    return true;
  }
}

test('the review pulse animates on interactive stdout when stderr is captured', async () => {
  const stderr = new Capture(false);
  const stdout = new Capture(true);
  const progress = new Progress(stderr, stdout, {});

  progress.line('Starting 1 review at 4:19pm…');
  progress.startPulse(Date.now());
  assert.equal(stdout.value, '');

  progress.laneStarted('Codex CLI (gpt-5.6)');

  try {
    assert.equal(stderr.value, 'Starting 1 review at 4:19pm…\n');
    assert.match(stdout.value, /\u280B 0s - waiting on Codex CLI \(gpt-5\.6\)/);

    await delay(150);

    assert.match(stdout.value, /\u2819 0s - waiting on Codex CLI \(gpt-5\.6\)/);
  } finally {
    progress.stopPulse();
  }
});

test('the review pulse stays off non-interactive output', async () => {
  const stderr = new Capture(false);
  const stdout = new Capture(false);
  const progress = new Progress(stderr, stdout, {});

  progress.line('Starting 1 review at 4:19pm…');
  progress.laneStarted('Codex CLI');
  progress.startPulse(Date.now());

  await delay(120);
  progress.stopPulse();

  assert.equal(stderr.value, 'Starting 1 review at 4:19pm…\n');
  assert.equal(stdout.value, '');
});

test('the review pulse prefers stderr when both streams are interactive', () => {
  const stderr = new Capture(true);
  const stdout = new Capture(true);
  const progress = new Progress(stderr, stdout, {});

  progress.laneStarted('Claude Code');
  progress.startPulse(Date.now());
  progress.stopPulse();

  assert.match(stderr.value, /\u280B 0s - waiting on Claude Code/);
  assert.equal(stdout.value, '');
});

test('supported terminals receive indeterminate progress until the pulse stops', () => {
  const supportedEnvironments: NodeJS.ProcessEnv[] = [
    { TERM_PROGRAM: 'vscode' },
    { WT_SESSION: 'windows-terminal-session' },
    { ConEmuANSI: 'ON' },
    { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6' },
    { TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.2.0' },
  ];

  for (const environment of supportedEnvironments) {
    const stderr = new Capture(false);
    const stdout = new Capture(true);
    const progress = new Progress(stderr, stdout, environment);

    progress.startPulse(Date.now());
    assert.equal(stdout.value, '\u001B]9;4;3;0\u0007');

    progress.laneStarted('Codex CLI');
    progress.pausePulse();
    assert.ok(
      !stdout.value.includes('\u001B]9;4;0;0\u0007'),
      'pausing the inline animation must leave native terminal progress active',
    );
    progress.stopPulse();

    assert.ok(
      stdout.value.endsWith('\u001B]9;4;0;0\u0007'),
      'the native terminal progress state must be cleared on completion',
    );
  }
});

test('progress reporting avoids terminals without known OSC 9;4 support', () => {
  const unsupportedEnvironments: NodeJS.ProcessEnv[] = [
    {},
    { TERM_PROGRAM: 'Apple_Terminal' },
    { TERM_PROGRAM: 'iTerm.app' },
    { TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.5' },
    { TERM_PROGRAM: 'ghostty', TERM_PROGRAM_VERSION: '1.1.3' },
    { TERM: 'xterm-kitty', KITTY_WINDOW_ID: '1' },
    { TERM_PROGRAM: 'WezTerm', TERM_PROGRAM_VERSION: '20240203-110809' },
  ];

  for (const environment of unsupportedEnvironments) {
    assert.equal(supportsTerminalProgress(environment), false);
  }
});

test('VS Code progress sequences stay off redirected output', () => {
  const stderr = new Capture(false);
  const stdout = new Capture(false);
  const progress = new Progress(stderr, stdout, { TERM_PROGRAM: 'vscode' });

  progress.startPulse(Date.now());
  progress.stopPulse();

  assert.equal(stderr.value, '');
  assert.equal(stdout.value, '');
});

test('process exit cleanup clears native terminal progress without a finally', () => {
  const stderr = new Capture(false);
  const stdout = new Capture(true);
  const progress = new Progress(stderr, stdout, { TERM_PROGRAM: 'vscode' });
  let onExit: (() => void) | undefined;

  installExitCleanup(progress, {
    once(event, listener) {
      assert.equal(event, 'exit');
      onExit = listener;
    },
  });

  progress.startPulse(Date.now());
  assert.equal(stdout.value, '\u001B]9;4;3;0\u0007');

  onExit?.();

  assert.ok(stdout.value.endsWith('\u001B]9;4;0;0\u0007'));
});

test('the completion bell uses a TTY and stays out of redirected output', () => {
  const ttyStderr = new Capture(true);
  const ttyStdout = new Capture(true);
  const interactive = new Progress(ttyStderr, ttyStdout, {});

  interactive.bell();

  assert.equal(ttyStderr.value, '\u0007');
  assert.equal(ttyStdout.value, '');

  const stderr = new Capture(false);
  const stdout = new Capture(false);
  const redirected = new Progress(stderr, stdout, {});

  redirected.bell();

  assert.equal(stderr.value, '');
  assert.equal(stdout.value, '');
});
