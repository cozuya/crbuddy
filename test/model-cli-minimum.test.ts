import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';

/**
 * The real CLI and spawner, with no adapter overrides: `codex` is whatever
 * PATH resolves, as it is when npx puts a newer Codex first on PATH. Each fake
 * logs the invocations it serves, prefixed by its own version.
 */
const posixOnly = {
  skip: process.platform === 'win32' ? 'fake CLIs here are POSIX shell scripts' : false,
};

const panel = [
  { id: 'sol61-native', vendor: 'codex', model: 'gpt-6.1-sol' },
  {
    id: 'sol61-custom',
    vendor: 'codex',
    model: 'gpt-6.1-sol',
    instructions: 'Review for correctness.',
  },
  { id: 'sol6', vendor: 'codex', model: 'gpt-6-sol' },
];

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-model-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const home = path.join(root, 'home');
  const log = path.join(root, 'codex.log');
  const report = path.join(repo, 'review.md');
  await mkdir(path.join(repo, '.crbuddy'), { recursive: true });
  await mkdir(home);

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '--quiet');
  await writeFile(path.join(repo, 'code.txt'), 'before\n');
  git('add', 'code.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Initial');
  await writeFile(path.join(repo, 'code.txt'), 'after\n');

  // git alone, through a wrapper, besides the fakes: a real codex, even one
  // installed beside git, can never be the one found.
  const realGit = (process.env.PATH ?? '')
    .split(path.delimiter)
    .map((dir) => path.join(dir, 'git'))
    .find((file) => file !== 'git' && existsSync(file));
  assert.ok(realGit, 'git must be on PATH');
  const gitDir = path.join(root, 'git-only');
  await mkdir(gitDir);
  await writeFile(path.join(gitDir, 'git'), `#!/bin/sh\nexec ${JSON.stringify(realGit)} "$@"\n`);
  await chmod(path.join(gitDir, 'git'), 0o755);

  async function codex(version: string): Promise<string> {
    const dir = path.join(root, `codex-${version}`);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'codex');
    await writeFile(file, [
      '#!/bin/sh',
      `if [ "$1" = --version ]; then echo "codex-cli ${version}"; exit 0; fi`,
      'if [ "$1" = exec ] && [ "$2" = --help ]; then',
      '  echo "  -s, --sandbox <MODE>  --ephemeral  --skip-git-repo-check  --color <C>  -c <k=v>"',
      '  exit 0',
      'fi',
      `printf '%s\\n' "${version} $*" >> ${JSON.stringify(log)}`,
      'echo "## Finding from $3"',
      '',
    ].join('\n'));
    await chmod(file, 0o755);
    return dir;
  }

  async function run(pathDirs: string[], args = ['go'], config: object[] = panel) {
    await writeFile(path.join(repo, '.crbuddy', 'config.json'), JSON.stringify({
      configVersion: 1,
      output: { destination: 'file', merged: 'review.md' },
      target: 'uncommitted',
      timeoutMs: 10_000,
      panel: config,
    }));
    await rm(log, { force: true });
    await rm(report, { force: true });

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [path.resolve('dist-test/src/index.js'), ...args], {
          cwd: repo,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            PATH: [...pathDirs, gitDir].join(path.delimiter),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`CLI test timed out: ${stdout}\n${stderr}`));
        }, 30_000);
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        child.stdin.end();
      },
    );

    const calls = existsSync(log) ? (await readFile(log, 'utf8')).trim().split('\n') : [];
    const written = existsSync(report) ? await readFile(report, 'utf8') : null;
    return { ...result, calls, report: written };
  }

  return { codex, run };
}

test('the Codex first on PATH decides whether gpt-6.1-sol lanes run', posixOnly, async (t) => {
  const f = await fixture(t);
  const old = await f.codex('0.158.0');
  const baseline = await f.codex('0.159.2');

  // An older Codex first on PATH: both gpt-6.1-sol lanes, native and custom,
  // are refused before launch; gpt-6-sol still runs, so the run is partial.
  const refused = await f.run([old, baseline]);
  assert.equal(refused.code, 0, refused.stderr);
  assert.equal(refused.stderr.match(/FAILED: cli_too_old_for_model/g)?.length, 2, refused.stderr);
  assert.match(
    refused.stderr,
    /gpt-6\.1-sol requires Codex CLI >= 0\.159\.2 in crbuddy \(tested compatibility baseline\); found 0\.158\.0\./,
  );
  assert.match(refused.stderr, /Upgrade Codex CLI in the environment where crbuddy runs .*or select gpt-6-sol\./);
  assert.match(refused.stderr, /For npm installations: npm install -g @openai\/codex@0\.159\.2/);
  assert.deepEqual(
    refused.calls.map((call) => call.split(' ').slice(0, 4).join(' ')),
    ['0.158.0 exec --model gpt-6-sol'],
  );
  assert.match(refused.report ?? '', /`sol61-native` \(codex\) failed: cli_too_old_for_model/);
  assert.match(refused.report ?? '', /`sol61-custom` \(codex\) failed: cli_too_old_for_model/);
  assert.match(refused.report ?? '', /found 0\.158\.0\./);
  assert.match(refused.report ?? '', /## Finding from gpt-6-sol/);

  // The same machine with the baseline Codex put first, as npx does: every
  // lane runs on it, and the older copy later on PATH is never used.
  const allowed = await f.run([baseline, old]);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /cli_too_old_for_model/);
  assert.equal(allowed.calls.length, 3, allowed.calls.join('\n'));
  assert.ok(allowed.calls.every((call) => call.startsWith('0.159.2 exec --model ')), allowed.calls.join('\n'));
  const sol61 = allowed.calls.filter((call) => call.includes(' --model gpt-6.1-sol '));
  assert.equal(sol61.length, 2);
  assert.equal(sol61.filter((call) => / review --uncommitted$/.test(call)).length, 1, 'native review');
  assert.equal(sol61.filter((call) => !/ review /.test(call)).length, 1, 'custom instructions');
});

test('gpt-6.1-sol lanes are refused below the baseline and run above it', posixOnly, async (t) => {
  const f = await fixture(t);

  // 0.159.1 is refused by crbuddy policy; it was never observed failing.
  const below = await f.run([await f.codex('0.159.1')]);
  assert.equal(below.stderr.match(/FAILED: cli_too_old_for_model/g)?.length, 2, below.stderr);
  assert.match(below.stderr, /found 0\.159\.1\./);
  assert.ok(below.calls.every((call) => !call.includes('gpt-6.1-sol')), below.calls.join('\n'));

  const later = await f.run([await f.codex('0.160.0')]);
  assert.equal(later.code, 0, later.stderr);
  assert.doesNotMatch(later.stderr, /cli_too_old_for_model/);
  assert.equal(later.calls.length, 3, later.calls.join('\n'));
});

test('a panel of only gpt-6.1-sol on an older Codex fails with the remedy on screen', posixOnly, async (t) => {
  const f = await fixture(t);
  const result = await f.run([await f.codex('0.158.0')], ['go'], [panel[0]!]);

  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  assert.equal(result.report, null);
  assert.match(result.stderr, /Every review failed\. Previous output left in place\./);
  // No report is written, so the terminal carries every line of the remedy.
  assert.match(result.stderr, /found 0\.158\.0\.\n\s+Upgrade Codex CLI .*\n\s+For npm installations: npm install -g @openai\/codex@0\.159\.2/);
});

test('a missing or unreadable Codex version still stops the whole run', posixOnly, async (t) => {
  const f = await fixture(t);

  const unreadable = await f.run([await f.codex('dev-build')]);
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.stderr, /Could not determine Codex CLI version/);
  assert.doesNotMatch(unreadable.stderr, /cli_too_old_for_model/);
  assert.deepEqual(unreadable.calls, []);

  const missing = await f.run([]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Vendor CLI "codex" \(Codex CLI\) is not available/);
  assert.deepEqual(missing.calls, []);
});

test('doctor notes the gpt-6.1-sol minimum without calling Codex unusable', posixOnly, async (t) => {
  const f = await fixture(t);

  const old = await f.run([await f.codex('0.158.0')], ['doctor']);
  assert.match(old.stdout, /OK {3}Codex CLI - `codex`/);
  assert.match(
    old.stdout,
    /note: {5}gpt-6\.1-sol needs 0\.159\.2 or newer \(crbuddy's tested baseline\); other models run on 0\.158\.0\. Upgrade Codex CLI where crbuddy runs, or select gpt-6-sol/,
  );
  assert.equal(old.code, 0, old.stdout);
  // Read-only: doctor asks for version and help, never a model.
  assert.deepEqual(old.calls, []);

  const current = await f.run([await f.codex('0.159.2')], ['doctor']);
  assert.match(current.stdout, /OK {3}Codex CLI - `codex`/);
  assert.doesNotMatch(current.stdout, /gpt-6\.1-sol needs/);
});
