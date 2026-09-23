import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isNewerThanStamp } from '../src/adapters/effort.js';
import { defaultCompletion } from '../src/adapters/types.js';
import { relativizePaths } from '../src/output/relativize.js';
import { formatElapsed, formatSize } from '../src/util/format.js';

test('a successful review that DISCUSSES rate limiting is not marked failed', () => {
  const check = defaultCompletion({
    code: 0,
    stdout: 'The new endpoint has no rate limiting and returns 401 inconsistently.',
    stderr: '',
    body: 'The new endpoint has no rate limiting and returns 401 inconsistently.',
  });

  assert.equal(check.ok, true, 'content must never be scanned for failure patterns');
});

test('a non-zero exit with a rate limit on stderr is classified', () => {
  const check = defaultCompletion({
    code: 1,
    stdout: '',
    stderr: 'Error: usage limit reached, try again later',
    body: '',
  });

  assert.equal(check.ok, false);
  assert.equal(check.reason, 'rate_limited');
});

test('a zero exit with an empty body is not a review', () => {
  const check = defaultCompletion({ code: 0, stdout: '', stderr: '', body: '   ' });

  assert.equal(check.ok, false);
  assert.equal(check.reason, 'empty');
});

test('version comparison drives only the "lists may be stale" note', () => {
  assert.equal(isNewerThanStamp('2.2.0', '2.1.0'), true);
  assert.equal(isNewerThanStamp('2.1.0', '2.1.0'), false);
  assert.equal(isNewerThanStamp('0.9.9', '0.50.0'), false);
  assert.equal(isNewerThanStamp('0.51.0', '0.50.0'), true);
});

test('sizes are shown in units people reason in', () => {
  assert.equal(formatSize(512), '512 bytes');
  assert.equal(formatSize(193000), '188 KB');
  assert.equal(formatSize(5 * 1024 * 1024), '5.0 MB');
});

test('elapsed time reads naturally at each scale', () => {
  assert.equal(formatElapsed(42_000), '42s');
  assert.equal(formatElapsed(185_000), '3m 05s');
  assert.equal(formatElapsed(4_320_000), '1h 12m');
});

test('absolute repo paths are rewritten to repo-relative', () => {
  const root = 'C:/Users/Chris/ai/crbuddy';

  const text =
    'Problem at [src/run/spawn.ts:178](C:/Users/Chris/ai/crbuddy/src/run/spawn.ts:178) here.';

  const out = relativizePaths(text, root);

  assert.ok(!out.includes('C:/Users/Chris'), `machine layout leaked: ${out}`);
  assert.ok(out.includes('src/run/spawn.ts:178'));
});

test('backslash spellings of the repo root are stripped too', () => {
  const out = relativizePaths(
    'see C:\\Users\\Chris\\ai\\crbuddy\\src\\a.ts:1',
    'C:/Users/Chris/ai/crbuddy',
  );

  assert.ok(!out.includes('Users'), `machine layout leaked: ${out}`);
});

test('paths outside the repo root are left alone', () => {
  const text = 'compare with /usr/lib/node/thing.js:9';
  assert.equal(relativizePaths(text, '/home/someone/repo'), text);
});
