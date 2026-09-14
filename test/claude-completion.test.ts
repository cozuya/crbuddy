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

test('Claude accepts a substantive completed review when the marker is omitted', () => {
  const stdout = `I found two problems in the changed code.\n\n` +
    `- src/a.ts:10 — the first path can return stale data.\n` +
    `- src/b.ts:20 — the second path can drop an error.\n\n` +
    `The rest of the diff looked correct to me.`;

  assert.deepEqual(claudeAdapter.checkCompletion(result(stdout)), { ok: true });
  assert.equal(claudeAdapter.finalOutput(result(stdout)), stdout);
});

test('Claude accepts a terse no-findings review without the marker', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('No actionable regressions identified.')),
    { ok: true },
  );
});

test('Claude still rejects ambiguous short status text without the marker', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('Reviewing the remaining files now.')),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude rejects markerless JSON because completion is shared with merge tasks', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result('{"clusters":[]}')),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude rejects final-looking prose when the tail says work is still running', () => {
  for (const stdout of [
    'I found two issues so far; the delegated agents are still running, I will wait for them.',
    'No actionable issues so far. Waiting for the background agents to finish.',
  ]) {
    assert.deepEqual(
      claudeAdapter.checkCompletion(result(stdout)),
      { ok: false, reason: 'incomplete_review' },
    );
  }
});

test('Claude rejects long markerless progress text even when it is substantial', () => {
  const stdout = (
    'I have dispatched four review agents and am continuing the review. ' +
    'They will report back when done. '
  ).repeat(8);

  assert.ok(stdout.length > 500);
  assert.deepEqual(
    claudeAdapter.checkCompletion(result(stdout)),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude rejects the latest ordinary subagent progress wordings', () => {
  for (const stdout of [
    'So far I found 2 issues. The 3 review agents are still running; I’ll be notified when they finish.',
    'No issues in the first file. Waiting for the subagents to finish.',
    'I found one issue so far. Waiting for the subagents to finish.',
    'I found two problems so far; the agents are still running.',
  ]) {
    assert.deepEqual(
      claudeAdapter.checkCompletion(result(stdout)),
      { ok: false, reason: 'incomplete_review' },
    );
  }
});

test('Claude accepts a finished review that quotes progress phrases as examples', () => {
  const stdout =
    'I found one real bug in the completion fallback.\n\n' +
    '- It misses "agents are still running" and "Waiting for the subagents to finish."\n' +
    '- Those quoted examples should not themselves make this final review look live.\n\n' +
    'Nothing else in the diff turned up a concrete bug.';

  assert.deepEqual(claudeAdapter.checkCompletion(result(stdout)), { ok: true });
});

test('Claude rejects wrapped merge-style JSON without the marker', () => {
  const stdout = '## Overall\n```json\n{"clusters":[]}\n```';
  assert.deepEqual(
    claudeAdapter.checkCompletion(result(stdout)),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude does not treat a severity line or finding count alone as completion', () => {
  for (const stdout of [
    '[P1] src/a.ts:10 — possible bug',
    'I found two issues in the first pass.',
    '## Overall\nStill checking the remaining files.',
  ]) {
    assert.deepEqual(
      claudeAdapter.checkCompletion(result(stdout)),
      { ok: false, reason: 'incomplete_review' },
    );
  }
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

test('Claude strips protocol framing from an exact JSON task payload', () => {
  const payload = '{"clusters":[{"findingIds":["f1"]}]}';
  const stdout = `${payload}\n${CLAUDE_COMPLETION_MARKER}\n`;

  assert.deepEqual(claudeAdapter.checkCompletion(result(stdout)), { ok: true });
  assert.equal(claudeAdapter.finalOutput(result(stdout)), payload);
});

test('Claude requires review content before the completion marker', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(result(`${CLAUDE_COMPLETION_MARKER}\n`)),
    { ok: false, reason: 'empty' },
  );
});

test('Claude rejects repeated trailing completion markers as malformed framing', () => {
  assert.deepEqual(
    claudeAdapter.checkCompletion(
      result(`${CLAUDE_COMPLETION_MARKER}\n${CLAUDE_COMPLETION_MARKER}\n`),
    ),
    { ok: false, reason: 'incomplete_review' },
  );

  assert.deepEqual(
    claudeAdapter.checkCompletion(
      result(`Actual review\n${CLAUDE_COMPLETION_MARKER}\n${CLAUDE_COMPLETION_MARKER}\n`),
    ),
    { ok: false, reason: 'incomplete_review' },
  );
});

test('Claude may discuss the completion marker inside a completed review', () => {
  const stdout =
    `The protocol requires \`${CLAUDE_COMPLETION_MARKER}\` at the end.\n` +
    `${CLAUDE_COMPLETION_MARKER}\n`;

  assert.deepEqual(claudeAdapter.checkCompletion(result(stdout)), { ok: true });
  assert.equal(
    claudeAdapter.finalOutput(result(stdout)),
    `The protocol requires \`${CLAUDE_COMPLETION_MARKER}\` at the end.`,
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
  assert.match(invocation.args[flag + 1] ?? '', /protocol framing/);
  assert.match(invocation.args[flag + 1] ?? '', /JSON-only/);
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

test('Claude rejects structured output modes that bypass the text completion contract', () => {
  for (const vendorArgs of [
    ['--output-format', 'json'],
    ['--output-format=stream-json'],
    ['--json-schema', '{"type":"object"}'],
    ['--json-schema={"type":"object"}'],
  ]) {
    assert.throws(
      () =>
        claudeAdapter.build({
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
