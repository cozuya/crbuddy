import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigError, stripJsonComments, validate } from '../src/config/load.js';

const minimal = {
  panel: [{ vendor: 'claude', model: 'opus' }],
};

test('accepts a minimal config and fills defaults', () => {
  const config = validate(minimal);

  assert.equal(config.configVersion, 1);
  assert.equal(config.target, 'uncommitted');
  assert.equal(config.refuseIfOutputExists, false);
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

test('output paths must stay inside the repository', () => {
  assert.throws(
    () => validate({ ...minimal, output: { merged: '../escape.md', raw: 'b.md' } }),
    /inside the repository/,
  );

  assert.throws(
    () => validate({ ...minimal, output: { merged: '/tmp/x.md', raw: 'b.md' } }),
    /relative/,
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

test('traversal that escapes the repo is rejected however it is spelled', () => {
  for (const bad of ['../out.md', 'a/../../out.md']) {
    assert.throws(
      () => validate({ ...minimal, output: { merged: bad, raw: 'ok.md' } }),
      /inside the repository/,
      `expected ${bad} to be rejected`,
    );
  }
});
