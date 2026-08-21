import assert from 'node:assert/strict';
import { test } from 'node:test';

import { codexAdapter, claudeAdapter, geminiAdapter } from '../src/adapters/vendors.js';
import { UnsafeInvocationError } from '../src/adapters/types.js';
import { ResolvedTarget } from '../src/git/target.js';

const supports = () => true;

const uncommitted: ResolvedTarget = {
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

const branch: ResolvedTarget = {
  kind: 'branch',
  snapshot: '3333333333333333333333333333333333333333',
  base: '1111111111111111111111111111111111111111',
  requestedBase: 'main',
  mergeBase: '1111111111111111111111111111111111111111',
  range:
    '1111111111111111111111111111111111111111..3333333333333333333333333333333333333333',
  diff: 'diff',
  digest: 'cafebabe',
  files: [{ status: 'M', path: 'src/b.ts' }],
  bytes: 4,
};

test('Claude native review invokes /code-review for uncommitted target', () => {
  const invocation = claudeAdapter.build({
    operation: { kind: 'review', target: uncommitted },
    model: 'opus',
    effort: 'high',
    repoRoot: '/repo',
    supports,
  });

  assert.equal(invocation.command, 'claude');
  assert.equal(invocation.stdin, `/code-review high ${uncommitted.range}`);
  assert.equal(invocation.appliedEffort, 'high');
  assert.ok(!invocation.stdin?.includes('Report concrete'));
});

test('Claude branch review invokes native /review alias with pinned range', () => {
  const invocation = claudeAdapter.build({
    operation: { kind: 'review', target: branch },
    model: 'opus',
    effort: 'xhigh',
    repoRoot: '/repo',
    supports,
  });

  assert.equal(invocation.stdin, `/review xhigh ${branch.range}`);
});

test('Codex native review uses exec review --uncommitted', () => {
  const invocation = codexAdapter.build({
    operation: { kind: 'review', target: uncommitted },
    model: 'gpt-5.6-sol',
    effort: 'high',
    repoRoot: '/repo',
    supports,
  });

  assert.equal(invocation.command, 'codex');
  assert.equal(invocation.stdin, undefined);
  assert.ok(invocation.args.includes('review'));
  assert.ok(invocation.args.includes('--uncommitted'));
  assert.ok(!invocation.args.includes('--base'));
});

test('Codex native branch review uses exec review --base requested branch', () => {
  const invocation = codexAdapter.build({
    operation: { kind: 'review', target: branch },
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    repoRoot: '/repo',
    supports,
  });

  const reviewIndex = invocation.args.indexOf('review');
  assert.ok(reviewIndex >= 0);
  assert.deepEqual(invocation.args.slice(reviewIndex), ['review', '--base', 'main']);
  assert.equal(invocation.stdin, undefined);
});

test('custom Codex instructions remain an explicit generic agent run', () => {
  const invocation = codexAdapter.build({
    operation: {
      kind: 'generic',
      target: uncommitted,
      instructions: 'Focus only on resource leaks.',
    },
    model: 'gpt-5.6-sol',
    effort: 'high',
    repoRoot: '/repo',
    supports,
  });

  assert.ok(!invocation.args.includes('review'));
  assert.match(invocation.stdin ?? '', /Focus only on resource leaks/);
  assert.match(invocation.stdin ?? '', new RegExp(uncommitted.snapshot));
});

test('Gemini refuses implicit review rather than faking native review with a prompt', () => {
  assert.throws(
    () =>
      geminiAdapter.build({
        operation: { kind: 'review', target: uncommitted },
        model: 'gemini-2.5-pro',
        repoRoot: '/repo',
        supports,
      }),
    (error: unknown) =>
      error instanceof UnsafeInvocationError &&
      /does not currently expose a supported headless native code-review/.test(error.message),
  );
});
