import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseGoArguments } from '../src/commands/go-options.js';

test('--force waives only the diff-size limit', () => {
  const parsed = parseGoArguments(['--force']);

  assert.equal(parsed.force, true);
  assert.equal(parsed.wholeCheckout, false);
});

test('--whole-checkout opts in without waiving the diff-size limit', () => {
  const parsed = parseGoArguments(['--whole-checkout']);

  assert.equal(parsed.wholeCheckout, true);
  assert.equal(parsed.force, false);
});

test('go argument parsing preserves strict, instructions, and unknown flags', () => {
  const parsed = parseGoArguments([
    '--strict',
    '--future',
    'focus on cleanup',
  ]);

  assert.equal(parsed.strict, true);
  assert.deepEqual(parsed.positional, ['focus on cleanup']);
  assert.deepEqual(parsed.unknownFlags, ['--future']);
});
