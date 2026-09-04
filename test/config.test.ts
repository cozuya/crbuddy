import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  assertUsableOutput,
  ConfigError,
  stripJsonComments,
  validate,
} from '../src/config/load.js';
import { CONFIG_VERSION } from '../src/config/schema.js';

const minimal = {
  panel: [{ vendor: 'claude', model: 'opus' }],
};

test('accepts a minimal config and fills defaults', () => {
  const config = validate(minimal);

  assert.equal(config.configVersion, CONFIG_VERSION);
  assert.equal(config.target, 'uncommitted');
  assert.equal(config.refuseIfOutputExists, false);
  assert.equal(config.timeoutMs, 60 * 60 * 1000);
  assert.equal(config.mergeTimeoutMs, 60 * 60 * 1000);
  assert.equal(config.output.merged, 'CODE-REVIEW-HANDOFF.md');
  assert.equal(config.merge.enabled, false);
  assert.equal(config.panel.length, 1);
});

test('generates stable ids from vendor and model', () => {
  const config = validate({
    panel: [
      { vendor: 'claude', model: 'opus' },
      { vendor: 'codex', model: 'gpt-5-codex' },
    ],
  });

  assert.deepEqual(
    config.panel.map((entry) => entry.id),
    ['claude-opus', 'codex-gpt-5-codex'],
  );
});

test('disambiguates duplicate generated ids', () => {
  const config = validate({
    panel: [
      { vendor: 'claude', model: 'opus' },
      { vendor: 'claude', model: 'opus' },
    ],
  });

  assert.deepEqual(
    config.panel.map((entry) => entry.id),
    ['claude-opus', 'claude-opus-2'],
  );
});

test('rejects duplicate explicit ids', () => {
  assert.throws(
    () =>
      validate({
        panel: [
          { id: 'a', vendor: 'claude', model: 'opus' },
          { id: 'a', vendor: 'codex', model: 'gpt-5' },
        ],
      }),
    ConfigError,
  );
});

test('unknown top-level keys are fatal', () => {
  assert.throws(() => validate({ ...minimal, panl: [] }), ConfigError);
});

test('unknown entry keys are fatal', () => {
  assert.throws(
    () => validate({ panel: [{ vendor: 'claude', model: 'opus', sampling: 3 }] }),
    /unknown key/i,
  );
});

test('the removed sampling knob is rejected rather than ignored', () => {
  assert.throws(
    () => validate({ panel: [{ vendor: 'claude', model: 'opus', sampling: 2 }] }),
    /sampling/,
  );
});

test('extends is reserved and refuses to load', () => {
  assert.throws(() => validate({ ...minimal, extends: '~/.crbuddy/config.json' }), /reserved/);
});

test('rejects the old positional output tuple with a useful message', () => {
  assert.throws(
    () => validate({ ...minimal, output: ['a.md', 'b.md'] }),
    /merged.*raw|array/i,
  );
});

test('output paths may leave the repository', () => {
  // A report one level up is outside the review universe entirely, rather
  // than relying on the diff exclusion to keep it out.
  const up = validate({
    ...minimal,
    output: { merged: '../CODE-REVIEW-HANDOFF.md', raw: '../CODE-REVIEW-HANDOFF.raw.md' },
  });

  assert.equal(up.output.merged, '../CODE-REVIEW-HANDOFF.md');

  const absolute = validate({
    ...minimal,
    output: { merged: '/srv/reviews/x.md', raw: '/srv/reviews/x.raw.md' },
  });

  assert.equal(absolute.output.merged, '/srv/reviews/x.md');
});

test('output destination defaults to a file and accepts the terminal', () => {
  assert.equal(validate({ ...minimal }).output.destination, 'file');

  assert.equal(
    validate({ ...minimal, output: { destination: 'terminal' } }).output.destination,
    'terminal',
  );
});

test('terminal mode keeps the paths so switching back restores them', () => {
  const config = validate({
    ...minimal,
    output: { destination: 'terminal', merged: '../report.md', raw: '../report.raw.md' },
  });

  assert.equal(config.output.merged, '../report.md');
});

test('an unrecognized output destination is rejected', () => {
  for (const bad of ['stdout', 'FILE', '', true]) {
    assert.throws(
      () => validate({ ...minimal, output: { destination: bad } }),
      /expected "file" or "terminal"/,
      `expected ${JSON.stringify(bad)} to be rejected`,
    );
  }
});

test('bad paths are still caught in terminal mode', () => {
  // Otherwise switching a config back to "file" surfaces a problem that was
  // sitting there unnoticed.
  assert.throws(
    () => validate({ ...minimal, output: { destination: 'terminal', merged: '.git/x.md' } }),
    /must not write inside/,
  );
});

test('merged and raw must differ', () => {
  assert.throws(
    () => validate({ ...minimal, output: { merged: 'x.md', raw: 'x.md' } }),
    /same file/,
  );
});

test('an empty panel is rejected', () => {
  assert.throws(() => validate({ panel: [] }), ConfigError);
});

test('enabled merge requires a vendor and model', () => {
  assert.throws(() => validate({ ...minimal, merge: { enabled: true } }), /required/);

  const ok = validate({
    ...minimal,
    merge: { enabled: true, vendor: 'claude', model: 'opus' },
  });

  assert.equal(ok.merge.effort, 'high');
});

test('a future configVersion is refused rather than guessed at', () => {
  assert.throws(() => validate({ ...minimal, configVersion: 99 }), /Upgrade crbuddy/);
});

test('branch targets accept a base ref', () => {
  const config = validate({ ...minimal, target: { base: 'develop' } });
  assert.deepEqual(config.target, { base: 'develop' });
});

test('any vendor-native effort string is accepted', () => {
  // Effort is passed through verbatim, so a vendor adding a level must not
  // require a crbuddy release to become usable.
  for (const level of ['high', 'xhigh', 'max', 'none', 'something-new-in-2027']) {
    const config = validate({
      panel: [{ vendor: 'codex', model: 'gpt-5.6-sol', effort: level }],
    });

    assert.equal(config.panel[0]?.effort, level);
  }
});

test('an empty effort string is still rejected', () => {
  assert.throws(
    () => validate({ panel: [{ vendor: 'claude', model: 'opus', effort: '  ' }] }),
    /non-empty vendor effort value/,
  );
});

test('effort is optional and stays absent when unspecified', () => {
  const config = validate({ panel: [{ vendor: 'gemini', model: 'gemini-2.5-pro' }] });
  assert.equal(config.panel[0]?.effort, undefined);
});

test('json comments are stripped without eating string content', () => {
  const input = `{
    // a comment
    "a": "http://example.com//not-a-comment",
    /* block */ "b": 1
  }`;

  const parsed = JSON.parse(stripJsonComments(input)) as Record<string, unknown>;

  assert.equal(parsed.a, 'http://example.com//not-a-comment');
  assert.equal(parsed.b, 1);
});

test('output paths cannot point into .git or .crbuddy', () => {
  // These files are moved aside and then overwritten, so pointing them at
  // git's own state would destroy the repository.
  for (const bad of ['.git/config', '.crbuddy/config.json', '.git', 'x/../.git/HEAD']) {
    assert.throws(
      () => validate({ ...minimal, output: { merged: bad, raw: 'ok.md' } }),
      /must not write inside|must name a file/,
      `expected ${bad} to be rejected`,
    );
  }
});

test('output paths that normalize to the same file are rejected', () => {
  assert.throws(
    () => validate({ ...minimal, output: { merged: 'a.md', raw: './x/../a.md' } }),
    /same file/,
  );
});

test('reserved directories are rejected from outside the repo too', () => {
  // Now that a path may start with `..`, a check anchored at the repository
  // root would miss these.
  for (const bad of ['../.git/HEAD', '/srv/repo/.git/config', '../x/.crbuddy/config.json']) {
    assert.throws(
      () => validate({ ...minimal, output: { merged: bad, raw: 'ok.md' } }),
      /must not write inside/,
      `expected ${bad} to be rejected`,
    );
  }
});

test('a reserved ancestor above the repository does not reject its outputs', () => {
  const nestedRepo = path.join(tmpdir(), 'checkout-parent', '.crbuddy', 'repo');

  assert.doesNotThrow(() =>
    assertUsableOutput(
      { merged: 'review.md', raw: 'review.raw.md' },
      'output',
      nestedRepo,
    ),
  );
});

test('an output path that names no file is rejected', () => {
  for (const bad of ['..', '.', '../']) {
    assert.throws(
      () => validate({ ...minimal, output: { merged: bad, raw: 'ok.md' } }),
      /must name a file/,
      `expected ${bad} to be rejected`,
    );
  }
});

test('clipboard payload is encoded for the platform that reads it', async () => {
  // Regression for silent corruption: `clip.exe` decodes stdin with the
  // console code page, so UTF-8 turns the report's U+2026 into mojibake
  // while still exiting 0. Asserted on the encoding, not on the real
  // clipboard, so it means the same thing in CI.
  const { encodeForClipboard } = await import('../src/util/clipboard.js');

  const encoded = encodeForClipboard('C2…');

  if (process.platform === 'win32') {
    assert.deepEqual([...encoded], [0x43, 0x00, 0x32, 0x00, 0x26, 0x20]);
  } else {
    assert.deepEqual([...encoded], [0x43, 0x32, 0xe2, 0x80, 0xa6]);
  }
});
