import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  assertUsableOutput,
  canonicalOutputPath,
  repoRelative,
} from '../src/config/load.js';
import { pathKey as pathKeySync } from '../src/commands/go.js';

import {
  cleanupTemps,
  commitOutputs,
  moveFile,
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

async function linkDirectory(target: string, link: string): Promise<void> {
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
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

test('existing directories and filesystem roots are rejected as output files', async () => {
  const { repoRoot } = await makeTree();
  const reports = path.join(repoRoot, 'reports');
  const sentinel = path.join(reports, 'keep.txt');
  await mkdir(reports);
  await writeFile(sentinel, 'do not delete', 'utf8');

  assert.throws(
    () =>
      assertUsableOutput(
        { merged: 'reports', raw: 'review.raw.md' },
        'output',
        repoRoot,
      ),
    /not a directory/,
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'do not delete');

  assert.throws(
    () =>
      assertUsableOutput(
        { merged: path.parse(repoRoot).root, raw: 'review.raw.md' },
        'output',
        repoRoot,
      ),
    /filesystem root/,
  );
});

test('a symlinked output parent is classified by its real destination', async () => {
  const { parent, repoRoot } = await makeTree();
  const outside = path.join(parent, 'outside');
  const alias = path.join(repoRoot, 'out');
  await mkdir(outside);
  await linkDirectory(outside, alias);

  assert.equal(repoRelative('out/review.md', repoRoot), null);
  assert.equal(
    canonicalOutputPath(repoRoot, 'out/review.md'),
    path.join(outside, 'review.md'),
  );
});

test('a symlink alias cannot hide a reserved output directory', async () => {
  const { parent, repoRoot } = await makeTree();
  const gitState = path.join(parent, '.git');
  await mkdir(gitState);
  await linkDirectory(gitState, path.join(repoRoot, 'apparently-safe'));

  assert.throws(
    () =>
      assertUsableOutput(
        { merged: 'apparently-safe/config', raw: 'review.raw.md' },
        'output',
        repoRoot,
      ),
    /must not write inside/,
  );
});

test('output lock identity follows symlinked parent directories', async () => {
  const { parent } = await makeTree();
  const firstRepo = path.join(parent, 'first-repo');
  const secondRepo = path.join(parent, 'second-repo');
  const shared = path.join(parent, 'shared-output');
  await mkdir(firstRepo);
  await mkdir(secondRepo);
  await mkdir(shared);
  await linkDirectory(shared, path.join(firstRepo, 'out'));
  await linkDirectory(shared, path.join(secondRepo, 'elsewhere'));

  assert.equal(
    pathKeySync(path.join(firstRepo, 'out', 'review.md')),
    pathKeySync(path.join(secondRepo, 'elsewhere', 'review.md')),
  );
});

test('output commit refuses a parent redirected after preflight', async () => {
  const { parent, repoRoot } = await makeTree();
  const outputDir = path.join(repoRoot, 'reports');
  const outside = path.join(parent, 'outside-after-preflight');
  await mkdir(outputDir);
  await mkdir(outside);

  const approved = canonicalOutputPath(repoRoot, 'reports/review.md');

  await rm(outputDir, { recursive: true });
  await linkDirectory(outside, outputDir);

  await assert.rejects(
    commitOutputs(
      repoRoot,
      [{ relative: approved, content: 'new report' }],
      { allowedPaths: [approved] },
    ),
    /changed after preflight/,
  );
  assert.ok(!existsSync(path.join(outside, 'review.md')));
});

test('restore keeps its only copy when a parent is redirected mid-review', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const outputDir = path.join(repoRoot, 'reports');
  const report = path.join(outputDir, 'review.md');
  const outside = path.join(parent, 'outside-before-restore');
  await mkdir(outputDir);
  await mkdir(outside);
  await writeFile(report, 'previous report', 'utf8');

  const approved = canonicalOutputPath(repoRoot, 'reports/review.md');
  const stashed = await stashExistingOutputs(
    repoRoot,
    workDir,
    [approved],
    'symlink-swap',
    { allowedPaths: [approved] },
  );

  await rm(outputDir, { recursive: true });
  await linkDirectory(outside, outputDir);

  const stranded = await stashed.restore();

  assert.equal(stranded.length, 1);
  assert.equal(await readFile(stranded[0]!, 'utf8'), 'previous report');
  assert.ok(!existsSync(path.join(outside, 'review.md')));
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

test('restore never overwrites a report recreated while reviewers run', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const report = path.join(parent, 'CODE-REVIEW-HANDOFF.md');

  await writeFile(report, 'previous run', 'utf8');

  const stashed = await stashExistingOutputs(
    repoRoot,
    workDir,
    ['../CODE-REVIEW-HANDOFF.md'],
    'recreated',
  );

  await writeFile(report, 'new editor content', 'utf8');

  const stranded = await stashed.restore();

  assert.equal(await readFile(report, 'utf8'), 'new editor content');
  assert.equal(stranded.length, 1);
  assert.equal(await readFile(stranded[0]!, 'utf8'), 'previous run');

  await stashed.discard();
});

test('an out-of-repo report stranded by a crash is recovered', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const report = path.join(parent, 'CODE-REVIEW-HANDOFF.md');

  await writeFile(report, 'previous run', 'utf8');

  // Stash, then walk away without restoring or discarding — a hard stop.
  await stashExistingOutputs(repoRoot, workDir, ['../CODE-REVIEW-HANDOFF.md'], 'runid');
  assert.ok(!existsSync(report));

  const recovered = await recoverStrandedOutputs(repoRoot, workDir, {
    allowedPaths: ['../CODE-REVIEW-HANDOFF.md'],
  });

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

test('temp cleanup refuses a parent redirected after preflight', async () => {
  const { parent, repoRoot } = await makeTree();
  const outputDir = path.join(repoRoot, 'reports');
  const outside = path.join(parent, 'outside-before-cleanup');
  const configured = path.join(outputDir, 'review.md');
  await mkdir(outputDir);
  await mkdir(outside);

  const approved = canonicalOutputPath(repoRoot, configured);

  await rm(outputDir, { recursive: true });
  await linkDirectory(outside, outputDir);

  const redirectedLitter = path.join(outside, 'review.md.crbuddy-tmp-999');
  await writeFile(redirectedLitter, 'unrelated file', 'utf8');

  await assert.rejects(
    cleanupTemps(repoRoot, [configured], { allowedPaths: [approved] }),
    /changed after preflight/,
  );
  assert.equal(await readFile(redirectedLitter, 'utf8'), 'unrelated file');
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
  //
  // Built from the real repo root rather than hardcoded, so the assertions
  // mean the same thing on every platform - `D:/x` is only an absolute path
  // on Windows.
  const repoRoot = path.resolve(path.join('/', 'work', 'repo'));
  const outsideRoot = path.resolve(path.join('/', 'work', 'elsewhere'));

  for (const outside of [
    '../CODE-REVIEW-HANDOFF.md',
    '..',
    path.join(outsideRoot, 'x.md'),
  ]) {
    assert.equal(repoRelative(outside, repoRoot), null, outside);
  }

  for (const inside of ['CODE-REVIEW-HANDOFF.md', 'reviews/x.md', './x.md']) {
    assert.ok(repoRelative(inside, repoRoot) !== null, inside);
  }
});

test('a trailing slash survives the repo-relative rewrite', () => {
  // `.crbuddy/` means "everything beneath"; losing the slash turns the
  // pathspec into a single file that does not exist.
  const repoRoot = path.resolve(path.join('/', 'work', 'repo'));

  assert.equal(repoRelative('.crbuddy/', repoRoot), '.crbuddy/');
});

test('an absolute path inside the repo is still excluded, not dropped', () => {
  // Absolute is not the same as outside. Dropping it would leave the last
  // run's report in the snapshot, and the next panel would review it.
  const repoRoot = path.resolve(path.join('/', 'work', 'repo'));
  const absolute = path.join(repoRoot, 'REVIEW.md');

  assert.equal(repoRelative(absolute, repoRoot), 'REVIEW.md');
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

test('the cross-filesystem move fallback preserves a file symlink', async (context) => {
  const { parent } = await makeTree();
  const target = path.join(parent, 'target.md');
  const link = path.join(parent, 'review.md');
  const holding = path.join(parent, 'holding');
  const stored = path.join(holding, 'review.stashed');
  await writeFile(target, 'previous run', 'utf8');
  await mkdir(holding);

  try {
    await symlink('target.md', link, process.platform === 'win32' ? 'file' : undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      context.skip('file symlinks require Windows Developer Mode or elevation');
      return;
    }
    throw error;
  }

  const crossDeviceRename: typeof rename = async () => {
    throw Object.assign(new Error('simulated cross-device move'), { code: 'EXDEV' });
  };

  await moveFile(link, stored, { rename: crossDeviceRename });
  assert.equal((await lstat(stored)).isSymbolicLink(), true);
  assert.equal(await readlink(stored), 'target.md');
  assert.equal(existsSync(link), false);

  await moveFile(stored, link, { rename: crossDeviceRename });
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readlink(link), 'target.md');
  assert.equal(await readFile(link, 'utf8'), 'previous run');
});

test('a restore that cannot put a file back keeps the only copy', async () => {
  // The state directory now lives outside the repo, so this is a
  // cross-filesystem copy wherever $HOME and the repo differ. Swallowing the
  // failure and deleting the holding directory destroyed the previous report
  // while still reporting success.
  const { parent, repoRoot, workDir } = await makeTree();
  const report = path.join(parent, 'CODE-REVIEW-HANDOFF.md');

  await writeFile(report, 'previous run', 'utf8');

  const stashed = await stashExistingOutputs(
    repoRoot,
    workDir,
    ['../CODE-REVIEW-HANDOFF.md'],
    'runid',
  );

  // Block the move back: a directory cannot be replaced by a file rename.
  await mkdir(report, { recursive: true });

  const stranded = await stashed.restore();

  assert.equal(stranded.length, 1, 'the failure is reported, not swallowed');
  assert.ok(existsSync(stranded[0]!), 'the only copy still exists');
});

test('a clean restore still reports nothing stranded', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const report = path.join(parent, 'CODE-REVIEW-HANDOFF.md');

  await writeFile(report, 'previous run', 'utf8');

  const stashed = await stashExistingOutputs(
    repoRoot,
    workDir,
    ['../CODE-REVIEW-HANDOFF.md'],
    'runid',
  );

  assert.deepEqual(await stashed.restore(), []);
  assert.equal(await readFile(report, 'utf8'), 'previous run');
});

test('restoring twice does not invent a stranded holding path', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const report = path.join(parent, 'CODE-REVIEW-HANDOFF.md');

  await writeFile(report, 'previous run', 'utf8');

  const stashed = await stashExistingOutputs(
    repoRoot,
    workDir,
    ['../CODE-REVIEW-HANDOFF.md'],
    'runid',
  );

  assert.deepEqual(await stashed.restore(), []);
  assert.deepEqual(await stashed.restore(), []);
  assert.equal(await readFile(report, 'utf8'), 'previous run');
});

test('a partial stash failure rolls earlier moves back immediately', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const first = path.join(parent, 'first.md');
  const second = path.join(parent, 'second.md');
  const manifest = path.join(workDir, 'previous', 'partial', 'manifest.json');
  await writeFile(first, 'first report', 'utf8');
  await writeFile(second, 'second report', 'utf8');

  let moves = 0;

  await assert.rejects(
    stashExistingOutputs(
      repoRoot,
      workDir,
      ['../first.md', '../second.md'],
      'partial',
      {
        moveFile: async (from, to) => {
          moves += 1;
          assert.ok(existsSync(manifest), 'manifest must precede the first move');
          if (moves === 2) throw new Error('simulated second move failure');
          await rename(from, to);
        },
      },
    ),
    /simulated second move failure/,
  );

  assert.equal(await readFile(first, 'utf8'), 'first report');
  assert.equal(await readFile(second, 'utf8'), 'second report');
  assert.ok(!existsSync(path.dirname(manifest)), 'completed rollback clears the batch');
});

test('a failed stash rollback leaves a manifest the next run can recover', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const first = path.join(parent, 'first.md');
  const second = path.join(parent, 'second.md');
  const holding = path.join(workDir, 'previous', 'recoverable');
  await writeFile(first, 'first report', 'utf8');
  await writeFile(second, 'second report', 'utf8');

  let moves = 0;

  await assert.rejects(
    stashExistingOutputs(
      repoRoot,
      workDir,
      ['../first.md', '../second.md'],
      'recoverable',
      {
        moveFile: async (from, to) => {
          moves += 1;
          if (moves === 2) throw new Error('simulated second move failure');
          if (moves === 3) throw new Error('simulated rollback failure');
          await rename(from, to);
        },
      },
    ),
    /simulated second move failure/,
  );

  assert.ok(existsSync(path.join(holding, 'manifest.json')));
  assert.ok(!existsSync(first));
  assert.equal(await readFile(second, 'utf8'), 'second report');

  assert.deepEqual(
    await recoverStrandedOutputs(repoRoot, workDir, {
      allowedPaths: ['../first.md', '../second.md'],
    }),
    ['../first.md'],
  );
  assert.equal(await readFile(first, 'utf8'), 'first report');
});

test('a repository-local recovery manifest cannot choose another destination', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const holding = path.join(workDir, 'previous', 'untrusted');
  const stored = path.join(holding, '0.stashed');
  const attackerChosen = path.join(parent, 'attacker-chosen.md');

  await mkdir(holding, { recursive: true });
  await writeFile(stored, 'repository payload', 'utf8');
  await writeFile(
    path.join(holding, 'manifest.json'),
    JSON.stringify([{ stored: '0.stashed', relative: attackerChosen }]),
    'utf8',
  );

  const recovered = await recoverStrandedOutputs(repoRoot, workDir, {
    allowedPaths: ['review.md', 'review.raw.md'],
  });

  assert.deepEqual(recovered, []);
  assert.ok(!existsSync(attackerChosen));
  assert.equal(await readFile(stored, 'utf8'), 'repository payload');
  assert.ok(existsSync(holding), 'the rejected batch is left inert for inspection');
});

test('an invalid recovery entry prevents every move in its batch', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const holding = path.join(workDir, 'previous', 'mixed-trust');
  const first = path.join(holding, '0.stashed');
  const second = path.join(holding, '1.stashed');
  const attackerChosen = path.join(parent, 'attacker-chosen.md');

  await mkdir(holding, { recursive: true });
  await writeFile(first, 'allowed payload', 'utf8');
  await writeFile(second, 'untrusted payload', 'utf8');
  await writeFile(
    path.join(holding, 'manifest.json'),
    JSON.stringify([
      { stored: '0.stashed', relative: 'review.md' },
      { stored: '1.stashed', relative: attackerChosen },
    ]),
    'utf8',
  );

  assert.deepEqual(
    await recoverStrandedOutputs(repoRoot, workDir, {
      allowedPaths: ['review.md', 'review.raw.md'],
    }),
    [],
  );
  assert.ok(!existsSync(path.join(repoRoot, 'review.md')));
  assert.ok(!existsSync(attackerChosen));
  assert.equal(await readFile(first, 'utf8'), 'allowed payload');
  assert.equal(await readFile(second, 'utf8'), 'untrusted payload');
});

test('a recovery manifest cannot select a source outside its holding batch', async () => {
  const { repoRoot, workDir } = await makeTree();
  const holding = path.join(workDir, 'previous', 'untrusted-source');
  const outsideSource = path.join(workDir, 'previous', 'payload.stashed');

  await mkdir(holding, { recursive: true });
  await writeFile(outsideSource, 'outside payload', 'utf8');
  await writeFile(
    path.join(holding, 'manifest.json'),
    JSON.stringify([{ stored: '../payload.stashed', relative: 'review.md' }]),
    'utf8',
  );

  assert.deepEqual(
    await recoverStrandedOutputs(repoRoot, workDir, {
      allowedPaths: ['review.md'],
    }),
    [],
  );
  assert.ok(!existsSync(path.join(repoRoot, 'review.md')));
  assert.equal(await readFile(outsideSource, 'utf8'), 'outside payload');
});

test('a recovery manifest cannot use the holding parent as its source', async () => {
  const { repoRoot, workDir } = await makeTree();
  const holding = path.join(workDir, 'previous', 'dot-dot-source');

  await mkdir(holding, { recursive: true });
  await writeFile(
    path.join(holding, 'manifest.json'),
    JSON.stringify([{ stored: '..', relative: 'review.md' }]),
    'utf8',
  );

  assert.deepEqual(
    await recoverStrandedOutputs(repoRoot, workDir, {
      allowedPaths: ['review.md'],
    }),
    [],
  );
  assert.ok(!existsSync(path.join(repoRoot, 'review.md')));
  assert.ok(existsSync(holding));
});

test('a manifest failure occurs before any output is moved', async () => {
  const { parent, repoRoot, workDir } = await makeTree();
  const report = path.join(parent, 'report.md');
  const holding = path.join(workDir, 'previous', 'no-manifest');
  await writeFile(report, 'previous report', 'utf8');

  let moved = false;

  await assert.rejects(
    stashExistingOutputs(
      repoRoot,
      workDir,
      ['../report.md'],
      'no-manifest',
      {
        moveFile: async () => { moved = true; },
        writeManifest: async () => {
          throw new Error('simulated manifest failure');
        },
      },
    ),
    /simulated manifest failure/,
  );

  assert.equal(moved, false);
  assert.equal(await readFile(report, 'utf8'), 'previous report');
  assert.ok(!existsSync(holding));
});

test('output lock identity conservatively folds on Windows and macOS', async () => {
  // Under-coordinating one physical output file can corrupt it. A
  // case-sensitive macOS volume may over-coordinate two case-distinct files,
  // but repository state uses its separately probed canonical identity.
  const { pathKey } = await import('../src/commands/go.js');

  const keys = new Set([pathKey('/w/Review.md'), pathKey('/w/review.md')]);
  const conservativelyFolded =
    process.platform === 'win32' || process.platform === 'darwin';

  assert.equal(keys.size, conservativelyFolded ? 1 : 2);
});

test('separators are normalized so one path has one identity', () => {
  assert.equal(pathKeySync('C:\\w\\x.md'), pathKeySync('C:/w/x.md'));
});
