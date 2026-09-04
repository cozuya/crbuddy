import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import { runProcess } from '../src/run/spawn.js';

async function scratch(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'crbuddy-timeout-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('stdout/stderr activity resets the inactivity timeout', async (t) => {
  const dir = await scratch(t);
  const script = `
    let count = 0;
    const timer = setInterval(() => {
      process.stderr.write('.');
      count += 1;
      if (count === 12) {
        clearInterval(timer);
        process.exit(0);
      }
    }, 100);
  `;

  const result = await runProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: dir,
    timeoutMs: 800,
    hardTimeoutMs: 5000,
    scratchDir: dir,
    id: 'active',
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.code, 0);
  assert.ok(result.stderr.length >= 12);
  assert.ok(result.wallClockMs > 800, 'the run should outlive one idle-timeout window');
});

test('a quiet process is terminated after the inactivity timeout', async (t) => {
  const dir = await scratch(t);

  const result = await runProcess({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: dir,
    timeoutMs: 500,
    hardTimeoutMs: 3000,
    scratchDir: dir,
    id: 'idle',
  });

  assert.equal(result.timedOut, true);
  assert.ok(result.wallClockMs < 2500);
});

test('the hard ceiling still terminates a continuously chatty process', async (t) => {
  const dir = await scratch(t);
  const script = `
    setInterval(() => process.stderr.write('.'), 100);
  `;

  const result = await runProcess({
    command: process.execPath,
    args: ['-e', script],
    cwd: dir,
    timeoutMs: 800,
    hardTimeoutMs: 1200,
    scratchDir: dir,
    id: 'hard-cap',
  });

  assert.equal(result.timedOut, true);
  assert.ok(result.stderr.length > 0);
  assert.ok(result.wallClockMs >= 900);
  assert.ok(result.wallClockMs < 3000);
});
