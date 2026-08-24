import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  captureCheckoutSnapshot,
  findRepoRoot,
  parseNameStatusZ,
  resolveTarget,
  untrackedFiles,
} from '../src/git/target.js';

const created: string[] = [];

after(async () => {
  for (const dir of created) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'crbuddy-test-'));
  created.push(dir);

  const run = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: 'pipe' });

  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  run(['config', 'commit.gpgsign', 'false']);

  return dir;
}

function commit(dir: string, message: string): void {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: dir,
    stdio: 'pipe',
  });
}

function snapshotFile(dir: string, snapshot: string, file: string): Buffer {
  execFileSync('git', ['cat-file', '-e', `${snapshot}:${file}`], {
    cwd: dir,
    stdio: 'pipe',
  });

  return execFileSync('git', ['cat-file', 'blob', `${snapshot}:${file}`], {
    cwd: dir,
    stdio: 'pipe',
  });
}

test('finds the worktree root from a subdirectory', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'hello\n');
  commit(dir, 'init');

  await mkdir(path.join(dir, 'nested', 'deep'), { recursive: true });

  const root = await findRepoRoot(path.join(dir, 'nested', 'deep'));

  // macOS /var -> /private/var symlinking makes a raw string compare flaky.
  assert.equal(path.basename(root), path.basename(dir));
});

test('uncommitted target captures staged new paths in a linked worktree', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'tracked.txt'), 'base\n');
  commit(dir, 'init');

  const linkedParent = await mkdtemp(
    path.join(tmpdir(), 'crbuddy-linked-test-'),
  );
  created.unshift(linkedParent);
  const linked = path.join(linkedParent, 'worktree');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'linked-test', linked], {
    cwd: dir,
    stdio: 'pipe',
  });

  await writeFile(path.join(linked, 'tracked.txt'), 'linked modification\n');
  await writeFile(path.join(linked, 'linked-new.txt'), 'linked staged bytes\n');
  execFileSync('git', ['add', '--', 'linked-new.txt'], { cwd: linked });

  const target = await resolveTarget(linked, 'uncommitted');

  assert.deepEqual(
    target.files.map((file) => file.path).sort(),
    ['linked-new.txt', 'tracked.txt'],
  );
  assert.deepEqual(
    snapshotFile(linked, target.snapshot, 'linked-new.txt'),
    Buffer.from('linked staged bytes\n'),
  );
});

test('uncommitted target includes tracked modifications', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');

  await writeFile(path.join(dir, 'a.txt'), 'two\n');

  const target = await resolveTarget(dir, 'uncommitted');

  assert.equal(target.kind, 'uncommitted');
  assert.equal(target.files.length, 1);
  assert.equal(target.files[0]?.path, 'a.txt');
  assert.match(target.diff, /-one/);
  assert.match(target.diff, /\+two/);
});

test('uncommitted target includes a staged new file with tracked modifications', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'tracked.txt'), 'before\n');
  commit(dir, 'init');

  await writeFile(path.join(dir, 'tracked.txt'), 'after\n');
  await writeFile(path.join(dir, 'staged-new.txt'), 'staged worktree bytes\n');
  execFileSync('git', ['add', '--', 'staged-new.txt'], { cwd: dir });

  const target = await resolveTarget(dir, 'uncommitted');
  const paths = target.files.map((file) => file.path);

  assert.ok(paths.includes('tracked.txt'));
  assert.ok(paths.includes('staged-new.txt'));
  assert.match(target.diff, /\+staged worktree bytes/);
  assert.equal(target.bytes, Buffer.byteLength(target.diff, 'utf8'));
  assert.equal(
    target.digest,
    createHash('sha256').update(target.diff).digest('hex').slice(0, 16),
  );
  assert.deepEqual(
    snapshotFile(dir, target.snapshot, 'staged-new.txt'),
    Buffer.from('staged worktree bytes\n'),
  );
});

test('uncommitted target includes a staged rename destination', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'old-name.txt'), 'rename destination bytes\n');
  commit(dir, 'init');

  execFileSync('git', ['mv', 'old-name.txt', 'new-name.txt'], { cwd: dir });

  const target = await resolveTarget(dir, 'uncommitted');

  assert.ok(target.files.some((file) => file.path.includes('new-name.txt')));
  assert.deepEqual(
    snapshotFile(dir, target.snapshot, 'new-name.txt'),
    Buffer.from('rename destination bytes\n'),
  );
});

test('uncommitted target includes intent-to-add worktree content', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'tracked.txt'), 'base\n');
  commit(dir, 'init');

  await writeFile(path.join(dir, 'intent.txt'), 'intent worktree bytes\n');
  execFileSync('git', ['add', '--intent-to-add', '--', 'intent.txt'], {
    cwd: dir,
  });

  const target = await resolveTarget(dir, 'uncommitted');

  assert.ok(target.files.some((file) => file.path === 'intent.txt'));
  assert.deepEqual(
    snapshotFile(dir, target.snapshot, 'intent.txt'),
    Buffer.from('intent worktree bytes\n'),
  );
});

test('uncommitted target includes UNTRACKED files', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');

  await writeFile(path.join(dir, 'brand-new.txt'), 'fresh\n');

  const target = await resolveTarget(dir, 'uncommitted');

  const paths = target.files.map((file) => file.path);

  assert.ok(
    paths.includes('brand-new.txt'),
    `expected brand-new.txt in ${JSON.stringify(paths)} - plain git diff would miss it`,
  );
  assert.match(target.diff, /\+fresh/);
});

test('uncommitted target excludes ignored files', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, '.gitignore'), 'ignored.txt\n');
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');

  await writeFile(path.join(dir, 'ignored.txt'), 'noise\n');
  await writeFile(path.join(dir, 'a.txt'), 'two\n');

  const target = await resolveTarget(dir, 'uncommitted');
  const paths = target.files.map((file) => file.path);

  assert.ok(!paths.includes('ignored.txt'));
});

test('exclusions keep crbuddy output out of its own next review', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');

  await writeFile(path.join(dir, 'CODE-REVIEW-HANDOFF.md'), '# previous review\n');
  await writeFile(path.join(dir, 'a.txt'), 'two\n');

  const target = await resolveTarget(dir, 'uncommitted', {
    exclude: ['CODE-REVIEW-HANDOFF.md', 'CODE-REVIEW-HANDOFF.raw.md'],
  });

  const paths = target.files.map((file) => file.path);

  assert.ok(!paths.includes('CODE-REVIEW-HANDOFF.md'));
  assert.ok(paths.includes('a.txt'));
});

test('the snapshot leaves the user index and worktree status byte-identical', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');

  await writeFile(path.join(dir, 'a.txt'), 'two\n');
  await writeFile(path.join(dir, 'staged.txt'), 'staged\n');
  execFileSync('git', ['add', '--', 'staged.txt'], { cwd: dir });
  await writeFile(path.join(dir, 'untracked.txt'), 'x\n');

  const before = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
    cwd: dir,
  });
  const indexPath = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-path', 'index'],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  ).trim();
  const indexBefore = await readFile(indexPath);

  await resolveTarget(dir, 'uncommitted');

  const indexAfter = await readFile(indexPath);
  const after = execFileSync('git', ['status', '--porcelain=v1', '-z'], {
    cwd: dir,
  });

  assert.deepEqual(indexAfter, indexBefore, 'snapshot must not alter the user index');
  assert.deepEqual(after, before, 'snapshot must not alter worktree status');
});

test('the snapshot is a real commit object', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');
  await writeFile(path.join(dir, 'a.txt'), 'two\n');

  const target = await resolveTarget(dir, 'uncommitted');

  const type = execFileSync('git', ['cat-file', '-t', target.snapshot], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();

  assert.equal(type, 'commit');
  assert.match(target.range, /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/);
});

test('works in a repository with no commits yet', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'first.txt'), 'hello\n');

  const target = await resolveTarget(dir, 'uncommitted');

  assert.equal(target.files.length, 1);
  assert.equal(target.files[0]?.path, 'first.txt');
});

test('uncommitted target includes a staged new file without HEAD', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'staged-first.txt'), 'first staged bytes\n');
  execFileSync('git', ['add', '--', 'staged-first.txt'], { cwd: dir });

  const target = await resolveTarget(dir, 'uncommitted');

  assert.equal(target.files.length, 1);
  assert.equal(target.files[0]?.path, 'staged-first.txt');
  assert.deepEqual(
    snapshotFile(dir, target.snapshot, 'staged-first.txt'),
    Buffer.from('first staged bytes\n'),
  );
});

test('branch target resolves merge-base and reports refs', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');

  execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: dir });
  await writeFile(path.join(dir, 'b.txt'), 'feature work\n');
  commit(dir, 'feature');

  const target = await resolveTarget(dir, { base: 'main' });

  assert.equal(target.kind, 'branch');
  assert.equal(target.requestedBase, 'main');
  assert.ok(target.mergeBase);
  assert.deepEqual(
    target.files.map((file) => file.path),
    ['b.txt'],
  );
});

test('whole-checkout provenance captures dirty worktree bytes for a branch target', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'committed\n');
  commit(dir, 'init');

  const branchTarget = await resolveTarget(dir, { base: 'main' });
  await writeFile(path.join(dir, 'a.txt'), 'dirty checkout bytes\n');

  const reviewedSnapshot = await captureCheckoutSnapshot(dir);

  assert.equal(branchTarget.files.length, 0);
  assert.deepEqual(
    snapshotFile(dir, branchTarget.snapshot, 'a.txt'),
    Buffer.from('committed\n'),
  );
  assert.deepEqual(
    snapshotFile(dir, reviewedSnapshot, 'a.txt'),
    Buffer.from('dirty checkout bytes\n'),
  );
});

test('an unresolvable base ref fails clearly', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');

  await assert.rejects(
    () => resolveTarget(dir, { base: 'no-such-branch' }),
    /Cannot resolve base ref/,
  );
});

test('unresolved merge conflicts refuse rather than normalize', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'base\n');
  commit(dir, 'init');

  execFileSync('git', ['checkout', '-q', '-b', 'other'], { cwd: dir });
  await writeFile(path.join(dir, 'a.txt'), 'other\n');
  commit(dir, 'other');

  execFileSync('git', ['checkout', '-q', 'main'], { cwd: dir });
  await writeFile(path.join(dir, 'a.txt'), 'main\n');
  commit(dir, 'main');

  try {
    execFileSync('git', ['merge', 'other'], { cwd: dir, stdio: 'pipe' });
  } catch {
    // Expected: the merge conflicts.
  }

  await assert.rejects(() => resolveTarget(dir, 'uncommitted'), /merge conflicts/);
});

test('untracked listing survives odd filenames', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');

  await writeFile(path.join(dir, 'has space.txt'), 'x\n');
  await writeFile(path.join(dir, "quote'name.txt"), 'y\n');

  const files = await untrackedFiles(dir);

  assert.ok(files.includes('has space.txt'));
  assert.ok(files.includes("quote'name.txt"));
});

test('digest changes when the diff changes', async () => {
  const dir = await makeRepo();
  await writeFile(path.join(dir, 'a.txt'), 'one\n');
  commit(dir, 'init');

  await writeFile(path.join(dir, 'a.txt'), 'two\n');
  const first = await resolveTarget(dir, 'uncommitted');

  await writeFile(path.join(dir, 'a.txt'), 'three\n');
  const second = await resolveTarget(dir, 'uncommitted');

  assert.notEqual(first.digest, second.digest);
});

test('parses rename entries from --name-status -z', () => {
  const input = 'M\0src/a.ts\0R100\0old.ts\0new.ts\0A\0added.ts\0';
  const files = parseNameStatusZ(input);

  assert.deepEqual(files, [
    { status: 'M', path: 'src/a.ts' },
    { status: 'R100', path: 'old.ts -> new.ts' },
    { status: 'A', path: 'added.ts' },
  ]);
});
