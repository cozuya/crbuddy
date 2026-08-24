import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';

import { Config } from '../src/config/schema.js';
import { ConfigError, LoadedConfig } from '../src/config/load.js';
import {
  canConfirm,
  confirm,
  EXIT_TOTAL_FAILURE,
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

function config(
  merged: string,
  raw: string,
  refuseIfOutputExists = false,
): Config {
  return {
    configVersion: 1,
    output: { destination: 'file', merged, raw },
    target: 'uncommitted',
    refuseIfOutputExists,
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

test('a contending run cannot clear the active run scratch directory', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'crbuddy-go-lock-'));
  created.push(repoRoot);

  const workDir = path.join(repoRoot, '.crbuddy');
  const stateDir = repoStateDir(repoRoot);
  const sentinel = path.join(stateDir, 'scratch', 'active.stdout');
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
      (error: unknown) =>
        error instanceof PreflightError &&
        error.message.includes('confirm this run') &&
        !error.message.includes('interactively once'),
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

test('terminal mode rejects merged and raw paths that resolve to one file', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'crbuddy-go-same-output-'));
  created.push(repoRoot);

  const value = config('review.md', path.join(repoRoot, 'review.md'));
  value.output.destination = 'terminal';

  await assert.rejects(
    runGo({
      repoRoot,
      loaded: loaded(repoRoot, value, 'global'),
      version: 'test',
      force: false,
      wholeCheckout: false,
      strict: false,
    }),
    (error: unknown) =>
      error instanceof ConfigError && error.message.includes('same file'),
  );
});

test('recovered output is checked by refuseIfOutputExists before preflight', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'crbuddy-go-recovered-'));
  created.push(repoRoot);

  const workDir = path.join(repoRoot, '.crbuddy');
  const report = path.join(repoRoot, 'review.raw.md');
  await mkdir(workDir, { recursive: true });
  await writeFile(report, 'previous report', 'utf8');
  await stashExistingOutputs(repoRoot, workDir, ['review.raw.md'], 'old-run');

  const originalInputTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const originalErrorTty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: false });

  try {
    const code = await runGo({
      repoRoot,
      loaded: loaded(
        repoRoot,
        config('review.md', 'review.raw.md', true),
        'global',
      ),
      version: 'test',
      force: false,
      wholeCheckout: false,
      strict: false,
    });

    assert.equal(code, EXIT_TOTAL_FAILURE);
  } finally {
    restoreProperty(process.stdin, 'isTTY', originalInputTty);
    restoreProperty(process.stderr, 'isTTY', originalErrorTty);
  }

  assert.equal(await readFile(report, 'utf8'), 'previous report');
});

test('confirmation requires a TTY prompt stream and writes the prompt there', async () => {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  const promptOutput = new PassThrough() as PassThrough & { isTTY?: boolean };
  const redirectedOutput = new PassThrough() as PassThrough & { isTTY?: boolean };
  input.isTTY = true;
  promptOutput.isTTY = true;
  redirectedOutput.isTTY = false;

  let promptText = '';
  let redirectedText = '';
  promptOutput.setEncoding('utf8');
  redirectedOutput.setEncoding('utf8');
  promptOutput.on('data', (chunk: string) => { promptText += chunk; });
  redirectedOutput.on('data', (chunk: string) => { redirectedText += chunk; });

  assert.equal(canConfirm(input, promptOutput), true);
  assert.equal(canConfirm(input, redirectedOutput), false);

  const answer = confirm('Continue?', input, promptOutput);
  input.end('yes\n');

  assert.equal(await answer, true);
  assert.match(promptText, /Continue\? \[y\/N\]/);
  assert.equal(redirectedText, '');
});

test('panel scratch is removed after a preflight failure', async () => {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'crbuddy-go-merge-cleanup-'));
  created.push(repoRoot);

  const stateDir = repoStateDir(repoRoot);
  created.push(stateDir);

  await assert.rejects(
    runGo({
      repoRoot,
      loaded: loaded(repoRoot, config('review.md', 'review.raw.md'), 'global'),
      version: 'test',
      force: false,
      wholeCheckout: false,
      strict: false,
    }),
  );

  assert.ok(!existsSync(path.join(stateDir, 'scratch')));
});

test('repository state identity follows the filesystem case behavior', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'crbuddy-state-case-'));
  created.push(parent);

  const upper = path.join(parent, 'Repo');
  const lower = path.join(parent, 'repo');
  await mkdir(upper);

  let distinct = true;

  try {
    await mkdir(lower);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    distinct = false;
  }

  assert.equal(
    repoStateDir(upper) !== repoStateDir(lower),
    distinct,
  );
});

function restoreProperty(
  target: object,
  key: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(target, key, descriptor);
  } else {
    delete (target as Record<string, unknown>)[key];
  }
}
