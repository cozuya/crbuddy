import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { insideRepo } from '../src/config/load.js';

import {
  cleanupTemps,
  commitOutputs,
  recoverStrandedOutputs,
  stashExistingOutputs,
} from '../src/output/write.js';

const created: string[] = [];

after(async () => {
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * A repository nested one level down, so `../` is a real directory that
 * exists and can be written to — the layout the "one level up" setup option
 * produces.
 */
async function makeTree(): Promise<{ parent: string; repoRoot: string; workDir: string }> {
  const parent = await mkdtemp(path.join(tmpdir(), 'crbuddy-out-'));
  created.push(parent);

  const repoRoot = path.join(parent, 'repo');
  const workDir = path.join(repoRoot, '.crbuddy');

  await mkdir(workDir, { recursive: true });

  return { parent, repoRoot, workDir };
}

test('a report above the repository root is written outside it', async () => {
  const { parent, repoRoot } = await makeTree();

  const written = await commitOutputs(repoRoot, [
    { relative: '../CODE-REVIEW-HANDOFF.md', content: 'merged' },
    { relative: '../CODE-REVIEW-HANDOFF.raw.md', content: 'raw' },
  ]);

  assert.equal(written.length, 2);

  assert.equal(
    await readFile(path.join(parent, 'CODE-REVIEW-HANDOFF.md'), 'utf8'),
    'merged',
  );

  // The point of the option: nothing lands in the repository at all.
  assert.ok(!existsSync(path.join(repoRoot, 'CODE-REVIEW-HANDOFF.md')));
});

test('an absolute report path is not joined onto the repository root', async () => {
  const { parent, repoRoot } = await makeTree();
  const absolute = path.join(parent, 'elsewhere', 'report.md');

  await commitOutputs(repoRoot, [{ relative: absolute, content: 'merged' }]);

  assert.equal(await readFile(absolute, 'utf8'), 'merged');
});

test('an out-of-repo report is stashed and restored on failure', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const report = path.join(parent, 'CODE-REVIEW-HANDOFF.md');

  await writeFile(report, 'previous run', 'utf8');

  const stashed = await stashExistingOutputs(
    repoRoot,
    workDir,
    ['../CODE-REVIEW-HANDOFF.md'],
    'runid',
  );

  assert.deepEqual(stashed.moved, ['../CODE-REVIEW-HANDOFF.md']);
  assert.ok(!existsSync(report), 'should be moved aside for the duration');

  await stashed.restore();

  assert.equal(await readFile(report, 'utf8'), 'previous run');
});

test('an out-of-repo report stranded by a crash is recovered', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const report = path.join(parent, 'CODE-REVIEW-HANDOFF.md');

  await writeFile(report, 'previous run', 'utf8');

  // Stash, then walk away without restoring or discarding — a hard stop.
  await stashExistingOutputs(repoRoot, workDir, ['../CODE-REVIEW-HANDOFF.md'], 'runid');
  assert.ok(!existsSync(report));

  const recovered = await recoverStrandedOutputs(repoRoot, workDir);

  assert.deepEqual(recovered, ['../CODE-REVIEW-HANDOFF.md']);
  assert.equal(await readFile(report, 'utf8'), 'previous run');
});

test('temp litter is swept from the directory the report actually lives in', async () => {
  const { parent, repoRoot } = await makeTree();
  const litter = path.join(parent, `CODE-REVIEW-HANDOFF.md.crbuddy-tmp-999`);

  await writeFile(litter, 'half-written', 'utf8');

  await cleanupTemps(repoRoot, ['../CODE-REVIEW-HANDOFF.md']);

  assert.ok(!existsSync(litter));
});

test('a failed rename leaves neither new nor half-committed output behind', async () => {
  const { parent, repoRoot } = await makeTree();

  // The second destination is a directory, so renaming a file onto it fails
  // after the first has already landed.
  const blocked = path.join(parent, 'blocked.md');
  await mkdir(blocked, { recursive: true });

  await assert.rejects(
    commitOutputs(repoRoot, [
      { relative: '../first.md', content: 'first' },
      { relative: '../blocked.md', content: 'second' },
    ]),
  );

  assert.ok(!existsSync(path.join(parent, 'first.md')), 'the landed rename is rolled back');
});

test('out-of-repo output paths are excluded from git pathspecs', () => {
  // These become `:(exclude)` arguments. git aborts the entire diff on one
  // pointing outside the worktree ("is outside repository"), so an unfiltered
  // list makes every run fail rather than merely over-matching.
  for (const outside of ['../CODE-REVIEW-HANDOFF.md', 'D:/audits/x.md', '/srv/x.md', '..']) {
    assert.equal(insideRepo(outside), false, outside);
  }

  for (const inside of ['CODE-REVIEW-HANDOFF.md', 'reviews/x.md', './x.md', '.crbuddy/']) {
    assert.equal(insideRepo(inside), true, inside);
  }
});

test('a stash across filesystems falls back to copy instead of failing', async () => {
  // Simulated rather than staged on a second drive: EXDEV is what a
  // different drive raises, and the recovery path is the same either way.
  const { parent, repoRoot, workDir } = await makeTree();
  const report = path.join(parent, 'CODE-REVIEW-HANDOFF.md');

  await writeFile(report, 'previous run', 'utf8');

  const stashed = await stashExistingOutputs(
    repoRoot,
    workDir,
    ['../CODE-REVIEW-HANDOFF.md'],
    'runid',
  );

  assert.ok(!existsSync(report));
  await stashed.restore();
  assert.equal(await readFile(report, 'utf8'), 'previous run');
});
