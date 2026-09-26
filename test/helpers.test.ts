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

test('the repo root is stripped only where it is a whole path', () => {
  const root = '/home/u/app';

  assert.equal(
    relativizePaths('see `/home/u/app/src/a.ts:3` and (/home/u/app/b.ts)', root),
    'see `src/a.ts:3` and (b.ts)',
  );

  // Siblings sharing the prefix, and longer paths ending in it, are not it.
  for (const text of [
    'see /home/u/app-server/src/x.ts:1',
    'see /home/u/app.old/x.ts',
    'see /home/u/app2/x.ts',
    'see /mnt/home/u/app/x.ts',
  ]) {
    assert.equal(relativizePaths(text, root), text);
  }
});

test('repo-root case is ignored only on a volume that folds case', () => {
  const text = 'notes in /home/u/APP/notes.md';
  assert.equal(relativizePaths(text, '/home/u/app'), text);
  assert.equal(
    relativizePaths('see c:/users/chris/AI/crbuddy/src/a.ts', 'C:/Users/Chris/ai/crbuddy', {
      foldCase: true,
    }),
    'see src/a.ts',
  );
});

test('a repository at a filesystem root rewrites nothing', () => {
  const text = 'see /etc/hosts, C:\\Windows\\x.dll and C:/tmp/y';
  assert.equal(relativizePaths(text, '/'), text);
  assert.equal(relativizePaths(text, 'C:\\'), text);
  assert.equal(relativizePaths(text, 'C:/'), text);
});
