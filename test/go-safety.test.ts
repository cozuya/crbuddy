import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { Config } from '../src/config/schema.js';
import { LoadedConfig } from '../src/config/load.js';
import {
  PreflightError,
  repoStateDir,
  runGo,
} from '../src/commands/go.js';
import { acquireLock, LockError } from '../src/util/lock.js';
import { stashExistingOutputs } from '../src/output/write.js';

const created: string[] = [];

after(async () => {
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true });
  }
});

function config(merged: string, raw: string): Config {
  return {
    configVersion: 1,
    output: { destination: 'file', merged, raw },
    target: 'uncommitted',
    refuseIfOutputExists: false,
    timeoutMs: 1_000,
    mergeTimeoutMs: 1_000,
    maxConcurrent: 1,
    maxDiffBytes: 1_000,
    merge: { enabled: false, vendor: '', model: '' },
    panel: [{ id: 'unused', vendor: 'unused', model: 'unused' }],
  };
}

function loaded(
  repoRoot: string,
  value: Config,
  scope: LoadedConfig['scope'],
): LoadedConfig {
  return {
    config: value,
    source: path.join(repoRoot, '.crbuddy', 'config.json'),
    scope,
  };
}

test('a contending run cannot clear the active run merge directory', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'crbuddy-go-lock-'));
  created.push(repoRoot);

  const workDir = path.join(repoRoot, '.crbuddy');
  const stateDir = repoStateDir(repoRoot);
  const sentinel = path.join(stateDir, 'merge', 'active.stdout');
  created.push(stateDir);

  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, 'active run', 'utf8');

  const held = await acquireLock(workDir);

  try {
    await assert.rejects(
      runGo({
        repoRoot,
        loaded: loaded(repoRoot, config('review.md', 'review.raw.md'), 'global'),
        version: 'test',
        force: false,
        wholeCheckout: false,
        strict: false,
      }),
      LockError,
    );

    assert.equal(await readFile(sentinel, 'utf8'), 'active run');
  } finally {
    await held.release();
  }
});

test('external-output refusal happens before temp cleanup and recovery', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'crbuddy-go-external-'));
  created.push(parent);

  const repoRoot = path.join(parent, 'repo');
  const workDir = path.join(repoRoot, '.crbuddy');
  const outside = path.join(parent, 'outside');
  const merged = path.join(outside, 'review.md');
  const raw = path.join(outside, 'review.raw.md');
  const litter = `${merged}.crbuddy-tmp-interrupted`;
  const stored = path.join(workDir, 'previous', 'old-run', '0.stashed');

  await mkdir(outside, { recursive: true });
  await writeFile(litter, 'unfinished report', 'utf8');
  await writeFile(raw, 'previous raw report', 'utf8');
  await stashExistingOutputs(repoRoot, workDir, [raw], 'old-run');

  const originalTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: false,
  });

  try {
    await assert.rejects(
      runGo({
        repoRoot,
        loaded: loaded(repoRoot, config(merged, raw), 'project'),
        version: 'test',
        force: false,
        wholeCheckout: false,
        strict: false,
      }),
      PreflightError,
    );
  } finally {
    if (originalTty) {
      Object.defineProperty(process.stdin, 'isTTY', originalTty);
    } else {
      delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
    }
  }

  assert.equal(await readFile(litter, 'utf8'), 'unfinished report');
  assert.ok(!existsSync(raw), 'stranded output must not be recovered before consent');
  assert.equal(await readFile(stored, 'utf8'), 'previous raw report');
});
