import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { inDirectory, storedDirectory } from '../src/commands/init.js';
import { assertUsableOutput } from '../src/config/load.js';
import { DEFAULT_OUTPUT } from '../src/config/schema.js';

const repoRoot = path.resolve(path.join('/', 'work', 'projects', 'crbuddy'));

test('the two report filenames keep their defaults wherever they land', () => {
  assert.deepEqual(inDirectory('.'), { ...DEFAULT_OUTPUT });

  assert.deepEqual(inDirectory('..'), {
    destination: 'file',
    merged: `../${DEFAULT_OUTPUT.merged}`,
    raw: `../${DEFAULT_OUTPUT.raw}`,
  });
});

test('a directory answer is anchored to the repository root, not the cwd', () => {
  assert.equal(storedDirectory('reviews', repoRoot), 'reviews');
  assert.equal(storedDirectory('./reviews', repoRoot), 'reviews');
  assert.equal(storedDirectory('../reviews', repoRoot), '../reviews');
});

test('the repository root itself comes back as "."', () => {
  assert.equal(storedDirectory(repoRoot, repoRoot), '.');
  assert.equal(storedDirectory('.', repoRoot), '.');
});

test('a sibling of the repository stays relative, so the config travels', () => {
  // One level up still means the same thing in whichever repository a
  // global config is used from.
  const sibling = path.join(path.dirname(repoRoot), 'reviews');

  assert.equal(storedDirectory(sibling, repoRoot), '../reviews');
});

test('anything further out is pinned absolute rather than stored as ../../..', () => {
  // Two levels up would resolve somewhere different in every repository,
  // which is not a relationship worth preserving.
  const far = path.resolve(path.join('/', 'work', 'reviews'));
  const stored = storedDirectory(far, repoRoot);

  assert.ok(path.isAbsolute(stored), `expected an absolute path, got ${stored}`);
  assert.ok(!stored.includes('..'), stored);
});

test('a leading ~ expands to the home directory', () => {
  const stored = storedDirectory('~/reviews', repoRoot);
  const expected = path.join(homedir(), 'reviews').replace(/\\/g, '/');

  // Either spelling is correct depending on where home sits relative to the
  // repo; what matters is that the tilde is gone and it resolved.
  assert.ok(!stored.startsWith('~'), stored);
  assert.equal(path.resolve(repoRoot, stored).replace(/\\/g, '/'), expected);
});

test('stored paths use forward slashes so a config reads the same everywhere', () => {
  for (const answer of ['../reviews', 'reviews/nested']) {
    assert.ok(!storedDirectory(answer, repoRoot).includes('\\'));
  }
});

test('every location the wizard can produce survives config validation', () => {
  const directories = [
    '.',
    '..',
    storedDirectory('reviews', repoRoot),
    storedDirectory(path.join(path.dirname(repoRoot), 'reviews'), repoRoot),
    storedDirectory(path.resolve(path.join('/', 'work', 'reviews')), repoRoot),
  ];

  for (const directory of directories) {
    assert.doesNotThrow(
      () => assertUsableOutput(inDirectory(directory), 'output'),
      `expected ${directory} to be usable`,
    );
  }
});

test('a directory answer pointing into git state is refused', () => {
  for (const answer of ['.git', '../repo/.git', '.crbuddy']) {
    assert.throws(
      () => assertUsableOutput(inDirectory(storedDirectory(answer, repoRoot)), 'output'),
      /must not write inside/,
      `expected ${answer} to be refused`,
    );
  }
});

test('without a repository root the answer is stored absolute', () => {
  const stored = storedDirectory('reviews', null);

  assert.ok(path.isAbsolute(stored), stored);
});

test('re-running config keeps filenames a user already chose', () => {
  // Accepting the location a config is already using must not rename its
  // files out from under whatever consumes them.
  const existing = {
    destination: 'file' as const,
    merged: 'REVIEW.md',
    raw: 'REVIEW.raw.md',
  };

  assert.deepEqual(inDirectory('.', existing), existing);

  assert.deepEqual(inDirectory('..', existing), {
    destination: 'file',
    merged: '../REVIEW.md',
    raw: '../REVIEW.raw.md',
  });

  // A directory change keeps the names but moves them.
  assert.equal(inDirectory('reviews', existing).merged, 'reviews/REVIEW.md');
});

test('with no existing config the defaults are used', () => {
  assert.equal(inDirectory('.').merged, DEFAULT_OUTPUT.merged);
});

test('two same-named reports in different directories do not collapse', () => {
  // `reports/a/REVIEW.md` + `reports/b/REVIEW.md` are two files. Keeping
  // only the basenames would make them one, and the wizard would write a
  // config that `crbuddy go` refuses to load.
  const existing = {
    destination: 'file' as const,
    merged: 'reports/a/REVIEW.md',
    raw: 'reports/b/REVIEW.md',
  };

  const collapsed = inDirectory('.', existing);

  assert.notEqual(collapsed.merged, collapsed.raw);
  assert.equal(collapsed.merged, 'REVIEW.md');
  assert.equal(collapsed.raw, 'REVIEW.raw.md');

  assert.doesNotThrow(() => assertUsableOutput(collapsed, 'output'));
});
