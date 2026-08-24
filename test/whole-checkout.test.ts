import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { claudeAdapter, codexAdapter, geminiAdapter } from '../src/adapters/vendors.js';
import { ResolvedTarget } from '../src/git/target.js';
import {
  ReportContext,
  RunRecord,
  renderMerged,
  renderRaw,
} from '../src/output/render.js';
import {
  reportRelativePath,
  shouldReviewWholeCheckout,
} from '../src/commands/go.js';

const supports = () => true;

test('unattended whole-checkout review requires its dedicated opt-in', () => {
  assert.equal(shouldReviewWholeCheckout(true, false, false), false);
  assert.equal(shouldReviewWholeCheckout(true, false, true), true);
  assert.equal(shouldReviewWholeCheckout(true, true, false), true);
  assert.equal(shouldReviewWholeCheckout(false, false, true), false);
});

/**
 * What `resolveTarget` returns when nothing has changed: a real snapshot at
 * the current commit, and no files.
 */
const empty: ResolvedTarget = {
  kind: 'uncommitted',
  snapshot: '4444444444444444444444444444444444444444',
  base: '4444444444444444444444444444444444444444',
  range:
    '4444444444444444444444444444444444444444..4444444444444444444444444444444444444444',
  diff: '',
  digest: 'e3b0c442',
  files: [],
  bytes: 0,
};

const instructions =
  'Review this repository as it currently stands. There is no diff to review.';

const run: RunRecord = {
  id: 'claude-opus',
  vendor: 'claude',
  cli: 'claude',
  cliVersion: '2.0.0',
  modelRequested: 'opus',
  effortRequested: null,
  effortApplied: null,
  wallClockMs: 1000,
  ok: true,
  output: 'A finding.',
};

function context(overrides: Partial<ReportContext> = {}): ReportContext {
  return {
    version: '0.1.0',
    runId: 'abc12345',
    generated: '2026-01-01T00:00:00.000Z',
    target: empty,
    runs: [run],
    mergeState: 'off',
    configSource: '.crbuddy/config.json',
    configScope: 'project',
    warnings: [],
    ...overrides,
  };
}

test('every vendor accepts a whole-checkout run, including one with no native review', () => {
  // Gemini refuses `kind: 'review'` outright, so this is the only mode in
  // which it can take part at all.
  for (const adapter of [claudeAdapter, codexAdapter, geminiAdapter]) {
    const invocation = adapter.build({
      operation: { kind: 'generic', target: null, instructions },
      model: 'a-model',
      repoRoot: '/repo',
      supports,
    });

    assert.equal(invocation.command, adapter.command);
  }
});

test('a whole-checkout run carries no range and no diff subcommand', () => {
  for (const adapter of [claudeAdapter, codexAdapter, geminiAdapter]) {
    const invocation = adapter.build({
      operation: { kind: 'generic', target: null, instructions },
      model: 'a-model',
      repoRoot: '/repo',
      supports,
    });

    const everything = [...invocation.args, invocation.stdin ?? ''].join(' ');

    // An empty diff resolves to `<sha>..<sha>`; prompting a reviewer with
    // that would describe the subject as a range containing nothing.
    assert.ok(!everything.includes('..'), `${adapter.name}: ${everything}`);
    assert.ok(!everything.includes('--uncommitted'), adapter.name);
    assert.ok(!everything.includes('--base'), adapter.name);
    assert.ok(!everything.includes('/code-review'), adapter.name);
  }
});

test('the instructions reach the reviewer intact, without diff framing', () => {
  const invocation = codexAdapter.build({
    operation: { kind: 'generic', target: null, instructions },
    model: 'gpt-5.6-sol',
    repoRoot: '/repo',
    supports,
  });

  const prompt = invocation.stdin ?? invocation.args.join(' ');

  assert.match(prompt, /as it currently stands/);
  assert.ok(!/reviewing the changes in the git range/i.test(prompt), prompt);
});

test('the report says the whole checkout was reviewed, not that nothing changed', () => {
  const report = renderRaw(context({ wholeCheckout: true }));

  assert.match(report, /no diff, so the reviews below cover the whole checkout/);
  assert.match(report, /Reviewed the checkout at `4{40}`/);

  // "0 file(s) changed" would read as a normal run that found nothing.
  assert.ok(!report.includes('0 file(s) changed'), report);
});

test('an ordinary run still reports its range and file count', () => {
  const report = renderRaw(
    context({
      target: { ...empty, files: [{ status: 'M', path: 'src/a.ts' }], bytes: 4 },
    }),
  );

  assert.match(report, /1 file\(s\) changed/);
  assert.ok(!report.includes('whole checkout'), report);
});

test('unconsolidated reports omit verbose provenance frontmatter', () => {
  const deliverable = renderRaw(context());
  const auditTrail = renderRaw(context({ mergeState: 'ok' }));
  const mergeFallback = renderRaw(
    context({ mergeState: 'failed', mergeReason: 'invalid clusters' }),
  );

  assert.ok(deliverable.startsWith('# Code review\n'));
  assert.ok(auditTrail.startsWith('# Code review - unmerged reviews\n'));
  assert.ok(mergeFallback.startsWith('# Code review\n'));

  for (const report of [deliverable, auditTrail, mergeFallback]) {
    assert.ok(!report.startsWith('---\n'), report);
    assert.ok(!report.includes('\ncrbuddy:\n'), report);
    assert.match(report, /<!-- crbuddy:report -->/);
    assert.match(report, /Reviewed `/);
  }
});

test(
  'timeout output is labelled as the final stderr captured before termination',
  () => {
    const failed: RunRecord = {
      ...run,
      ok: false,
      reason: 'timeout',
      output: '',
      diagnostics: 'Usage: codex exec resume [OPTIONS]',
    };

    const report = renderRaw(context({ runs: [failed] }));

    assert.match(report, /This run did not complete: timeout/);
    assert.match(
      report,
      /Last stderr captured before crbuddy terminated the timed-out process:/,
    );
    assert.match(report, /```text\nUsage: codex exec resume \[OPTIONS\]\n```/);
  },
);

test('the consolidated report links to the unmerged file only when one exists', () => {
  const clusters = [{ findingIds: ['claude-opus:1'] }];
  const findings = [
    {
      id: 'claude-opus:1',
      runId: 'claude-opus',
      title: 'A finding',
      text: 'A finding.',
      locations: [],
    },
  ];

  const onDisk = renderMerged(
    context({ mergeState: 'ok', rawPath: 'CODE-REVIEW-HANDOFF.raw.md' }),
    clusters,
    findings,
  );

  assert.match(onDisk, /Unmerged reviews: `CODE-REVIEW-HANDOFF\.raw\.md`/);
  assert.match(onDisk, /^---\ncrbuddy:\n/);
  assert.match(onDisk, /\n  kind: consolidated\n/);
  assert.ok(!onDisk.includes('kind: merged'), onDisk);

  // Terminal mode writes no raw file, so the sentence has to go entirely
  // rather than render as an empty pair of backticks.
  const printed = renderMerged(context({ mergeState: 'ok' }), clusters, findings);

  assert.ok(!printed.includes('Unmerged reviews'), printed);
  assert.ok(!printed.includes('``'), printed);
});

test('the raw-report link resolves from the consolidated report directory', () => {
  const repoRoot = path.resolve('repo');
  const merged = path.resolve('outside', 'deliverable', 'review.md');
  const raw = path.resolve('outside', 'audit', 'review.raw.md');

  assert.equal(
    reportRelativePath(repoRoot, merged, raw),
    '../audit/review.raw.md',
  );
});

test('the raw-report link is omitted when filesystem roots differ', {
  skip: process.platform !== 'win32',
}, () => {
  assert.equal(
    reportRelativePath('C:\\repo', 'D:\\reports\\review.md', 'E:\\audit\\raw.md'),
    null,
  );
});

test('custom instructions still say what the subject is', async () => {
  // With `target: null` there is no range for `genericPrompt` to describe,
  // so framing dropped here leaves the reviewer with a brief and no subject.
  const { wholeCheckoutPrompt } = await import('../src/commands/go.js');

  const prompt = wholeCheckoutPrompt('Focus only on resource leaks.');

  assert.match(prompt, /no diff to review/);
  assert.match(prompt, /the checked-out code itself as the subject/);
  assert.match(prompt, /Focus only on resource leaks\./);
  assert.match(prompt, /Do not modify any files\./);

  // The user's brief is the instruction; the framing is the setting.
  assert.ok(
    prompt.indexOf('subject') < prompt.indexOf('Focus only'),
    prompt,
  );
});

test('with no custom instructions the default brief is used whole', async () => {
  const { wholeCheckoutPrompt } = await import('../src/commands/go.js');
  const prompt = wholeCheckoutPrompt(undefined);

  assert.match(prompt, /no diff to review/);
  assert.match(prompt, /correctness bugs/);
});
