import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

import {
  formatUpdateNotice,
  startUpdateCheck,
  updateCheckSuppressed,
  type UpdateCheckOptions,
} from '../src/run/update-check.js';
import { isNewerVersion } from '../src/util/semver.js';

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 29, 12);

/** An interactive, non-CI check against a private cache and a counted registry. */
async function harness(t: TestContext, latest: () => Promise<string | null>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'crbuddy-update-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'update-check.json');
  let requests = 0;

  const check = (overrides: Partial<UpdateCheckOptions> = {}) =>
    startUpdateCheck({
      installed: '0.4.2',
      env: {},
      interactive: true,
      cacheFile,
      now: () => NOW,
      fetchLatest: () => {
        requests += 1;
        return latest();
      },
      ...overrides,
    }).notice();

  return {
    cacheFile,
    check,
    requests: () => requests,
    cache: async () => JSON.parse(await readFile(cacheFile, 'utf8')) as unknown,
    seed: (record: unknown) => writeFile(cacheFile, JSON.stringify(record)),
  };
}

test('a newer registry version produces the notice and is cached', async (t) => {
  const h = await harness(t, async () => '0.4.3');

  assert.equal(
    await h.check(),
    'Update available: crbuddy 0.4.2 → 0.4.3\nRun: npm i -g crbuddy@latest',
  );
  assert.equal(h.requests(), 1);
  assert.deepEqual(await h.cache(), { checkedAt: NOW, latest: '0.4.3' });
});

test('the same or an older registry version produces no notice', async (t) => {
  for (const latest of ['0.4.2', '0.4.1', '0.4.2-rc.1', '0.3.9']) {
    const h = await harness(t, async () => latest);
    assert.equal(await h.check(), null, latest);
  }
});

test('a failed registry request is silent and still throttles the next check', async (t) => {
  const h = await harness(t, async () => {
    throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
  });

  assert.equal(await h.check(), null);
  assert.deepEqual(await h.cache(), { checkedAt: NOW, latest: null });

  // Offline: one attempt a day, not one per command.
  assert.equal(await h.check({ now: () => NOW + HOUR }), null);
  assert.equal(h.requests(), 1);
});

test('a registry request that never answers is abandoned at the timeout', async (t) => {
  let aborted = false;
  const h = await harness(t, () => new Promise(() => {}));
  const started = Date.now();

  const notice = await h.check({
    timeoutMs: 50,
    fetchLatest: (signal) => {
      signal.addEventListener('abort', () => { aborted = true; });
      return new Promise(() => {});
    },
  });

  assert.equal(notice, null);
  assert.ok(Date.now() - started < 1_000, 'bounded by the timeout');
  assert.equal(aborted, true, 'the request is cancelled, not left running');
});

test('a check within the last day is reused without a registry request', async (t) => {
  const h = await harness(t, async () => '9.9.9');
  await h.seed({ checkedAt: NOW - 23 * HOUR, latest: '0.5.0' });

  assert.match((await h.check()) ?? '', /0\.4\.2 → 0\.5\.0/);
  assert.equal(h.requests(), 0);

  // Past a day, or dated in the future by a changed clock, it is checked again.
  await h.seed({ checkedAt: NOW - 25 * HOUR, latest: '0.5.0' });
  assert.match((await h.check()) ?? '', /→ 9\.9\.9/);
  await h.seed({ checkedAt: NOW + HOUR, latest: '0.5.0' });
  await h.check();
  assert.equal(h.requests(), 2);
});

test('a stale answer is still used when the fresh request fails', async (t) => {
  const h = await harness(t, async () => null);
  await h.seed({ checkedAt: NOW - 48 * HOUR, latest: '0.5.0' });

  assert.match((await h.check()) ?? '', /→ 0\.5\.0/);
  assert.deepEqual(await h.cache(), { checkedAt: NOW, latest: '0.5.0' });
});

test('registry and cache text that is not a version is never printed or kept', async (t) => {
  const h = await harness(t, async () => '\u001b[31m9.9.9');
  assert.equal(await h.check(), null);
  assert.deepEqual(await h.cache(), { checkedAt: NOW, latest: null });

  const cached = await harness(t, async () => null);
  await cached.seed({ checkedAt: NOW - HOUR, latest: 'latest\u0007' });
  assert.equal(await cached.check(), null);
  assert.equal(cached.requests(), 0);
});

test('CI, non-interactive and opted-out runs neither check nor print', async (t) => {
  const h = await harness(t, async () => '9.9.9');

  assert.equal(await h.check({ interactive: false }), null);
  for (const env of [
    { CI: 'true' },
    { CI: '1' },
    { GITHUB_ACTIONS: 'true' },
    { CONTINUOUS_INTEGRATION: 'yes' },
    { CRBUDDY_NO_UPDATE_CHECK: '1' },
    { NO_UPDATE_NOTIFIER: '1' },
  ]) {
    assert.equal(await h.check({ env }), null, JSON.stringify(env));
  }
  assert.equal(h.requests(), 0);

  // A variable set to false is not an opt-out.
  assert.equal(updateCheckSuppressed({ CI: 'false', NO_UPDATE_NOTIFIER: '0' }, true), false);
});

test('an installed version that is not semver never checks', async (t) => {
  const h = await harness(t, async () => '9.9.9');
  assert.equal(await h.check({ installed: 'unknown' }), null);
  assert.equal(h.requests(), 0);
});

test('versions compare by SemVer precedence, not as strings', () => {
  assert.equal(isNewerVersion('0.4.10', '0.4.9'), true);
  assert.equal(isNewerVersion('0.10.0', '0.9.9'), true);
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true);
  assert.equal(isNewerVersion('0.4.2', '0.4.2'), false);
  assert.equal(isNewerVersion('0.4.1', '0.4.2'), false);
  assert.equal(isNewerVersion('v0.4.3', '0.4.2'), true);
  // Build metadata does not affect precedence.
  assert.equal(isNewerVersion('0.4.2+build.7', '0.4.2'), false);

  // The ordering example from the SemVer 2.0.0 specification.
  const ordered = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ];
  for (let i = 1; i < ordered.length; i += 1) {
    assert.equal(isNewerVersion(ordered[i]!, ordered[i - 1]!), true, `${ordered[i]} > ${ordered[i - 1]}`);
    assert.equal(isNewerVersion(ordered[i - 1]!, ordered[i]!), false, `${ordered[i - 1]} < ${ordered[i]}`);
  }

  for (const invalid of ['latest', '1.0', '01.0.0', '1.0.0-', '', '1.0.0-01']) {
    assert.equal(isNewerVersion(invalid, '0.0.1'), false, invalid);
  }
});

test('the notice is exactly two lines', () => {
  assert.equal(
    formatUpdateNotice('0.4.1', '0.4.2'),
    'Update available: crbuddy 0.4.1 → 0.4.2\nRun: npm i -g crbuddy@latest',
  );
});
