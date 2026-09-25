import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  CLAUDE_COMPLETION_MARKER,
  claudeAdapter,
  claudeHookDisablingEnvironmentVariable,
  claudeHookDisablingSettingsFile,
  claudeHooksDisabledReason,
} from '../src/adapters/vendors.js';
import { UnsafeInvocationError, type Invocation } from '../src/adapters/types.js';
import { ResolvedTarget } from '../src/git/target.js';

const target: ResolvedTarget = {
  kind: 'uncommitted',
  snapshot: '2222222222222222222222222222222222222222',
  base: '1111111111111111111111111111111111111111',
  range:
    '1111111111111111111111111111111111111111..2222222222222222222222222222222222222222',
  diff: 'diff',
  digest: 'deadbeef',
  files: [{ status: 'M', path: 'src/a.ts' }],
  bytes: 4,
};

const result = (stdout: string, code = 0, stderr = '') => ({ code, stdout, stderr });


test('Claude hook-disabling environment values match Claude boolean semantics', () => {
  for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) {
    assert.equal(
      claudeHookDisablingEnvironmentVariable({ CLAUDE_CODE_SIMPLE: value }),
      'CLAUDE_CODE_SIMPLE',
    );
  }

  for (const value of ['', ' ', '0', 'false', 'no', 'off', '2', 'anything']) {
    assert.equal(
      claudeHookDisablingEnvironmentVariable({ CLAUDE_CODE_SIMPLE: value }),
      null,
    );
  }

  assert.equal(
    claudeHookDisablingEnvironmentVariable({ CLAUDE_CODE_SAFE_MODE: 'yes' }),
    'CLAUDE_CODE_SAFE_MODE',
  );
});

function settingsFixture(t: import('node:test').TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), 'crbuddy-claude-settings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'repo');
  const userDir = path.join(root, 'user-claude');
  mkdirSync(path.join(repoRoot, '.claude'), { recursive: true });
  mkdirSync(userDir, { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: userDir };
  const write = (file: string, value: unknown) =>
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return {
    repoRoot,
    env,
    user: path.join(userDir, 'settings.json'),
    project: path.join(repoRoot, '.claude', 'settings.json'),
    local: path.join(repoRoot, '.claude', 'settings.local.json'),
    write,
  };
}

test('the most specific Claude settings file that sets disableAllHooks decides', (t) => {
  const f = settingsFixture(t);
  assert.equal(claudeHookDisablingSettingsFile(f.repoRoot, f.env), null);

  f.write(f.user, { disableAllHooks: true });
  assert.equal(claudeHookDisablingSettingsFile(f.repoRoot, f.env), f.user);
  // Outside a repository only the user file applies.
  assert.equal(claudeHookDisablingSettingsFile(null, f.env), f.user);

  f.write(f.project, { disableAllHooks: false });
  assert.equal(claudeHookDisablingSettingsFile(f.repoRoot, f.env), null);

  f.write(f.local, { disableAllHooks: true });
  assert.equal(claudeHookDisablingSettingsFile(f.repoRoot, f.env), f.local);

  // A file that does not set the key, or cannot be read, defers to the next.
  f.write(f.local, { hooks: {} });
  assert.equal(claudeHookDisablingSettingsFile(f.repoRoot, f.env), null);
  f.write(f.project, '{not json');
  assert.equal(claudeHookDisablingSettingsFile(f.repoRoot, f.env), f.user);
});

test('doctor names whatever disables Claude hooks, environment first', (t) => {
  const f = settingsFixture(t);
  assert.equal(claudeHooksDisabledReason(f.repoRoot, f.env), null);

  f.write(f.project, { disableAllHooks: true });
  assert.equal(
    claudeHooksDisabledReason(f.repoRoot, f.env),
    '.claude/settings.json sets "disableAllHooks": true',
  );
  assert.equal(
    claudeHooksDisabledReason(f.repoRoot, { ...f.env, CLAUDE_CODE_SIMPLE: '1' }),
    'CLAUDE_CODE_SIMPLE disables Claude hooks',
  );
});

test('Claude refuses to launch when repository settings disable all hooks', (t) => {
  const f = settingsFixture(t);
  f.write(f.local, { disableAllHooks: true });
  const request = {
    operation: { kind: 'review' as const, target },
    model: 'opus',
    effort: 'high' as const,
    repoRoot: f.repoRoot,
    completionEvidencePath: path.join(f.repoRoot, 'completion.json'),
    supports: () => true,
  };

  assert.throws(
    () => claudeAdapter.build(request),
    (error: unknown) =>
      error instanceof UnsafeInvocationError &&
      error.message.startsWith('.claude/settings.local.json sets "disableAllHooks": true') &&
      error.message.includes('will not override it') &&
      !error.message.includes(f.repoRoot),
  );

  f.write(f.local, { disableAllHooks: false });
  assert.doesNotThrow(() => claudeAdapter.build(request));
});

function invocationWithEvidence(
  t: import('node:test').TestContext,
  evidence: { registryAvailable: boolean; backgroundTasks: number | null; sessionCrons: number | null },
): Invocation {
  const dir = mkdtempSync(path.join(tmpdir(), 'crbuddy-claude-completion-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const completionEvidencePath = path.join(dir, 'completion.json');
  writeFileSync(completionEvidencePath, JSON.stringify(evidence));
  return {
    command: 'claude',
    args: [],
    appliedEffort: 'high',
    completionEvidencePath,
  };
}

function completeEvidence(t: import('node:test').TestContext): Invocation {
  return invocationWithEvidence(t, {
    registryAvailable: true,
    backgroundTasks: 0,
    sessionCrons: 0,
  });
}

test('Claude accepts any nonempty final review when Stop-hook evidence proves no work is pending', (t) => {
  for (const stdout of [
    'I found three issues in the changed code.',
    'No actionable regressions identified.',
    'The subagents are still running — quoted here only as part of the final review discussion.',
    '{"clusters":[]}',
  ]) {
    assert.deepEqual(
      claudeAdapter.checkCompletion(result(stdout), completeEvidence(t)),
      { ok: true },
    );
  }
});

test('Claude rejects output when authoritative Stop evidence says background work remains', (t) => {
  const invocation = invocationWithEvidence(t, {
    registryAvailable: true,
    backgroundTasks: 2,
    sessionCrons: 0,
  });
  assert.deepEqual(
    claudeAdapter.checkCompletion(
      result('No issues found. I will report back once agents finish.'),
      invocation,
    ),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude reports when the task registry was unavailable', (t) => {
  const invocation = invocationWithEvidence(t, {
    registryAvailable: false,
    backgroundTasks: null,
    sessionCrons: null,
  });
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('Finished review.'), invocation),
    { ok: false, reason: 'completion_registry_unavailable' },
  );
});

test('Claude rejects output when completion evidence is missing', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('Finished review.'), {
      command: 'claude', args: [], appliedEffort: 'high',
      completionEvidencePath: '/definitely/missing/crbuddy-completion.json',
    }),
    { ok: false, reason: 'completion_evidence_missing' },
  );
});

test('Claude rejects scheduled wakeups as unfinished session work', (t) => {
  const invocation = invocationWithEvidence(t, {
    registryAvailable: true,
    backgroundTasks: 0,
    sessionCrons: 1,
  });
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('Finished review.'), invocation),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude still rejects empty output even with complete lifecycle evidence', (t) => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('   '), completeEvidence(t)),
    { ok: false, reason: 'empty' },
  );
});

test('legacy completion marker is stripped but is not itself review content', (t) => {
  const invocation = completeEvidence(t);
  const stdout = `Actual review\n${CLAUDE_COMPLETION_MARKER}\n`;
  assert.deepEqual(claudeAdapter.checkCompletion(result(stdout), invocation), { ok: true });
  assert.equal(claudeAdapter.finalOutput(result(stdout)), 'Actual review');

  assert.deepEqual(
    claudeAdapter.checkCompletion(result(`${CLAUDE_COMPLETION_MARKER}\n`), invocation),
    { ok: false, reason: 'empty' },
  );
});

test('Claude preserves nonzero exit classification even with complete evidence', (t) => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('Partial review', 2), completeEvidence(t)),
    { ok: false, reason: 'exit_2' },
  );
});

test('Claude invocation installs a Stop hook lifecycle guard instead of prompting for a marker', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crbuddy-claude-build-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const completionEvidencePath = path.join(dir, 'completion.json');
  const invocation = claudeAdapter.build({
    operation: { kind: 'review', target },
    model: 'opus',
    effort: 'high',
    repoRoot: '/repo',
    completionEvidencePath,
    supports: () => true,
  });

  assert.equal(invocation.completionEvidencePath, completionEvidencePath);
  assert.equal(invocation.args.includes('--append-system-prompt'), false);
  const settingsIndex = invocation.args.indexOf('--settings');
  assert.ok(settingsIndex >= 0);
  const settings = JSON.parse(invocation.args[settingsIndex + 1] ?? '{}');
  const hook = settings.hooks?.Stop?.[0]?.hooks?.[0];
  assert.equal(hook?.type, 'command');
  assert.equal(hook?.command, process.execPath);
  assert.match(hook?.args?.[1] ?? '', /background_tasks/);
  assert.equal(hook?.args?.[2], completionEvidencePath);
  assert.equal(invocation.args.at(-1), `/code-review high ${target.range}`);
});

test('Claude Stop hook records pending work without blocking or emitting output', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'crbuddy-claude-hook-run-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const completionEvidencePath = path.join(dir, 'completion.json');
  const invocation = claudeAdapter.build({
    operation: { kind: 'review', target },
    model: 'opus',
    effort: 'high',
    repoRoot: '/repo',
    completionEvidencePath,
    supports: () => true,
  });
  const settingsIndex = invocation.args.indexOf('--settings');
  const settings = JSON.parse(invocation.args[settingsIndex + 1] ?? '{}');
  const hook = settings.hooks?.Stop?.[0]?.hooks?.[0];

  // Never forced on: that would re-enable every hook the user disabled.
  assert.ok(!('disableAllHooks' in settings));
  const run = spawnSync(
    hook.command,
    hook.args,
    {
      input: JSON.stringify({
        hook_event_name: 'Stop',
        stop_hook_active: false,
        background_tasks: [{ id: 'task-1' }],
        session_crons: [],
      }),
      encoding: 'utf8',
    },
  );

  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.deepEqual(JSON.parse(readFileSync(completionEvidencePath, 'utf8')), {
    registryAvailable: true,
    backgroundTasks: 1,
    sessionCrons: 0,
  });
});

test('Claude fails before launch when --settings cannot install the completion hook', () => {
  assert.throws(
    () => claudeAdapter.build({
      operation: { kind: 'review', target },
      model: 'opus',
      effort: 'high',
      repoRoot: '/repo',
      completionEvidencePath: '/tmp/crbuddy-completion.json',
      supports: (flag) => flag !== '--settings',
    }),
    (error: unknown) =>
      error instanceof UnsafeInvocationError &&
      /Stop-hook completion guard/.test(error.message),
  );
});

test('Claude rejects vendor modes that disable hooks before launch', () => {
  for (const vendorArgs of [['--bare'], ['--safe-mode']]) {
    assert.throws(
      () => claudeAdapter.build({
        operation: { kind: 'review', target },
        model: 'opus',
        effort: 'high',
        vendorArgs,
        repoRoot: '/repo',
        completionEvidencePath: '/tmp/crbuddy-completion.json',
        supports: () => true,
      }),
      UnsafeInvocationError,
    );
  }
});

test('Claude rejects structured output modes because crbuddy captures plain-text payloads', () => {
  for (const vendorArgs of [
    ['--output-format', 'json'],
    ['--output-format=stream-json'],
    ['--json-schema', '{"type":"object"}'],
    ['--json-schema={"type":"object"}'],
  ]) {
    assert.throws(
      () => claudeAdapter.build({
        operation: { kind: 'review', target },
        model: 'opus',
        effort: 'high',
        vendorArgs,
        repoRoot: '/repo',
        supports: () => true,
      }),
      UnsafeInvocationError,
    );
  }
});
