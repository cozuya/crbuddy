import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { Progress } from '../src/run/progress.js';

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
  const progress = new Progress(stderr, stdout);

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
  const progress = new Progress(stderr, stdout);

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
  const progress = new Progress(stderr, stdout);

  progress.laneStarted('Claude Code');
  progress.startPulse(Date.now());
  progress.stopPulse();

  assert.match(stderr.value, /\u280B 0s - waiting on Claude Code/);
  assert.equal(stdout.value, '');
});
