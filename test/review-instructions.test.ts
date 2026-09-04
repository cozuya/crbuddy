import assert from 'node:assert/strict';
import { test } from 'node:test';

import { geminiAdapter } from '../src/adapters/vendors.js';
import type { ResolvedTarget } from '../src/git/target.js';
import {
  GENERIC_DEFAULT_REVIEW_PRESET_ID,
  PRIORITIZED_FINDINGS_PRESET_ID,
  WHOLE_CHECKOUT_DEFAULT_PRESET_ID,
  buildReviewerOperation,
} from '../src/review/instructions.js';

const target: ResolvedTarget = {
  kind: 'branch',
  snapshot: '3333333333333333333333333333333333333333',
  base: '1111111111111111111111111111111111111111',
  requestedBase: 'main',
  mergeBase: '1111111111111111111111111111111111111111',
  range:
    '1111111111111111111111111111111111111111..3333333333333333333333333333333333333333',
  diff: 'diff',
  digest: 'cafebabe',
  files: [{ status: 'M', path: 'src/a.ts' }],
  bytes: 4,
};

test('prioritized-findings expands to one generic preset for every vendor', () => {
  for (const nativeReview of [true, false]) {
    const selection = buildReviewerOperation({
      entry: { instructionsPreset: PRIORITIZED_FINDINGS_PRESET_ID },
      target,
      nativeReview,
      wholeCheckout: false,
    });

    assert.equal(selection.source, 'preset');
    assert.equal(selection.presetId, PRIORITIZED_FINDINGS_PRESET_ID);
    assert.equal(selection.operation.kind, 'generic');

    if (selection.operation.kind === 'generic') {
      assert.match(selection.operation.instructions, /P0: catastrophic security failure/);
      assert.match(selection.operation.instructions, /strict P0, P1, P2, then P3 order/);
      assert.match(selection.operation.instructions, /Return Markdown, not JSON/);
    }
  }
});

test('native reviewer default remains the vendor-native review operation', () => {
  const selection = buildReviewerOperation({
    entry: {},
    target,
    nativeReview: true,
    wholeCheckout: false,
  });

  assert.deepEqual(selection, {
    operation: { kind: 'review', target },
    source: 'default',
    presetId: null,
  });
});

test('a reviewer without native review gets the maintained generic default', () => {
  const selection = buildReviewerOperation({
    entry: {},
    target,
    nativeReview: false,
    wholeCheckout: false,
  });

  assert.equal(selection.source, 'default');
  assert.equal(selection.presetId, GENERIC_DEFAULT_REVIEW_PRESET_ID);
  assert.equal(selection.operation.kind, 'generic');

  if (selection.operation.kind === 'generic') {
    assert.match(selection.operation.instructions, /concrete, actionable defects/);
    assert.match(selection.operation.instructions, /say plainly if there are no actionable findings/);
  }
});

test('Gemini default resolves to a safe generic invocation instead of native review', () => {
  const selection = buildReviewerOperation({
    entry: {},
    target,
    nativeReview: geminiAdapter.nativeReview,
    wholeCheckout: false,
  });

  const invocation = geminiAdapter.build({
    operation: selection.operation,
    model: 'gemini-2.5-pro',
    repoRoot: '/repo',
    supports: () => true,
  });

  assert.equal(selection.operation.kind, 'generic');
  assert.equal(selection.presetId, GENERIC_DEFAULT_REVIEW_PRESET_ID);
  assert.ok(invocation.args.includes('--approval-mode'));
  assert.ok(invocation.args.includes('plan'));

  const promptCarrier = `${invocation.stdin ?? ''}\n${invocation.args.join('\n')}`;
  assert.match(promptCarrier, /concrete, actionable defects/);
});

test('custom instructions remain generic and are not reclassified as a preset', () => {
  const selection = buildReviewerOperation({
    entry: { instructions: 'Focus on lock ordering.' },
    target,
    nativeReview: true,
    wholeCheckout: false,
  });

  assert.equal(selection.source, 'custom');
  assert.equal(selection.presetId, null);
  assert.deepEqual(selection.operation, {
    kind: 'generic',
    target,
    instructions: 'Focus on lock ordering.',
  });
});

test('one-off command-line instructions override a configured preset', () => {
  const selection = buildReviewerOperation({
    entry: { instructionsPreset: PRIORITIZED_FINDINGS_PRESET_ID },
    target,
    nativeReview: true,
    wholeCheckout: false,
    instructionsOverride: 'Only inspect resource leaks.',
  });

  assert.equal(selection.source, 'override');
  assert.equal(selection.presetId, null);
  assert.deepEqual(selection.operation, {
    kind: 'generic',
    target,
    instructions: 'Only inspect resource leaks.',
  });
});

test('whole-checkout default is explicitly versioned in run provenance', () => {
  const selection = buildReviewerOperation({
    entry: {},
    target,
    nativeReview: true,
    wholeCheckout: true,
  });

  assert.equal(selection.source, 'default');
  assert.equal(selection.presetId, WHOLE_CHECKOUT_DEFAULT_PRESET_ID);
  assert.equal(selection.operation.kind, 'generic');

  if (selection.operation.kind === 'generic') {
    assert.equal(selection.operation.target, null);
    assert.match(selection.operation.instructions, /There is no diff to review/);
  }
});
