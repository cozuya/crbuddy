import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CLAUDE_COMPLETION_MARKER,
  claudeAdapter,
} from '../src/adapters/vendors.js';
import { UnsafeInvocationError } from '../src/adapters/types.js';
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

const result = (stdout: string, code = 0, stderr = '') => ({
  code,
  stdout,
  stderr,
});

test('Claude rejects the observed background-agent progress response', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(
      result('Waiting for the background agents to finish.\n'),
    ),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude accepts a terse completed review when the completion marker is present', () => {
  const stdout =
    `No actionable regressions identified.\n${CLAUDE_COMPLETION_MARKER}\n`;

  assert.deepEqual(claudeAdapter.checkCompletion(result(stdout)), { ok: true });
  assert.equal(
    claudeAdapter.finalOutput(result(stdout)),
    'No actionable regressions identified.',
  );
});

test('Claude requires review content before the completion marker', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result(`${CLAUDE_COMPLETION_MARKER}\n`)),
    { ok: false, reason: 'empty' },
  );
});

test('Claude preserves nonzero exit classification even if a marker is present', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(
      result(`Partial review\n${CLAUDE_COMPLETION_MARKER}\n`, 2),
    ),
    { ok: false, reason: 'exit_2' },
  );
});

test('Claude invocation appends the completion protocol to the system prompt', () => {
  const invocation = claudeAdapter.build({
    operation: { kind: 'review', target },
    model: 'opus',
    effort: 'high',
    repoRoot: '/repo',
    supports: () => true,
  });

  const flag = invocation.args.indexOf('--append-system-prompt');
  assert.ok(flag >= 0);
  assert.match(invocation.args[flag + 1] ?? '', /background agents/);
  assert.match(invocation.args[flag + 1] ?? '', /crbuddy:review-complete/);
  assert.equal(invocation.args.at(-1), `/code-review high ${target.range}`);
});

test('Claude fails closed when the completion-protocol flag is unavailable', () => {
  assert.throws(
    () =>
      claudeAdapter.build({
        operation: { kind: 'review', target },
        model: 'opus',
        effort: 'high',
        repoRoot: '/repo',
        supports: (flag) => flag !== '--append-system-prompt',
      }),
    (error: unknown) =>
      error instanceof UnsafeInvocationError &&
      /completion protocol/.test(error.message),
  );
});
