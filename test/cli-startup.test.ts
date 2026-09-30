import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * The real CLI, its update check and registry worker. A preload stands in for
 * the registry in every thread, records each request, and can make stderr a
 * terminal, since a check only runs when someone will see the notice. The
 * built CLI runs from a copy beside a package.json saying 0.4.2: dist-test has
 * none, and a version the CLI cannot read is never compared.
 */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-cli-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'not-a-repo');
  const repo = path.join(root, 'repo');
  const requests = path.join(root, 'requests.log');
  const preload = path.join(root, 'preload.mjs');
  await mkdir(home);
  await mkdir(outside);
  await mkdir(repo);
  execFileSync('git', ['init', '--quiet'], { cwd: repo, stdio: 'pipe' });

  const cli = path.join(root, 'cli');
  await cp(path.resolve('dist-test/src'), path.join(cli, 'src'), { recursive: true });
  await writeFile(
    path.join(cli, 'package.json'),
    JSON.stringify({ name: 'crbuddy', version: '0.4.2', type: 'module' }),
  );
  await symlink(
    path.resolve('node_modules'),
    path.join(cli, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  await writeFile(preload, `
    import fs from 'node:fs';
    import { isMainThread } from 'node:worker_threads';
    if (isMainThread && process.env.CRB_TEST_TTY) process.stderr.isTTY = true;
    globalThis.fetch = async (url) => {
      fs.appendFileSync(${JSON.stringify(requests)}, String(url) + '\\n');
      const mode = process.env.CRB_TEST_REGISTRY;
      if (mode === 'error') throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org');
      // Held open like a stalled socket, so only the timeout ends it.
      if (mode === 'hang') return new Promise(() => { setInterval(() => {}, 60_000); });
      // Nothing left to wait on: the worker's event loop simply runs dry.
      if (mode === 'stall') return new Promise(() => {});
      return new Response(JSON.stringify({ latest: mode ?? '0.0.0' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
  `);

  async function run(
    args: string[],
    env: Record<string, string> = {},
    cwd = outside,
    entry = path.join(cli, 'src', 'index.js'),
  ) {
    await rm(requests, { force: true });
    const started = Date.now();
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    // The opt-outs count when merely set, so they are removed, not emptied.
    delete inherited.CRBUDDY_NO_UPDATE_CHECK;
    delete inherited.NO_UPDATE_NOTIFIER;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [
          '--import', pathToFileURL(preload).href,
          entry,
          ...args,
        ], {
          cwd,
          env: {
            ...inherited,
            HOME: home,
            USERPROFILE: home,
            // The suite itself may run in CI; each case sets what it tests.
            CI: '',
            CONTINUOUS_INTEGRATION: '',
            BUILD_NUMBER: '',
            RUN_ID: '',
            GITHUB_ACTIONS: '',
            ...env,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`CLI test timed out: ${stdout}\n${stderr}`));
        }, 20_000);
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
        child.on('error', (error) => { clearTimeout(timer); reject(error); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
        child.stdin.end();
      },
    );
    const fetched = existsSync(requests)
      ? (await readFile(requests, 'utf8')).trim().split('\n')
      : [];

    return { ...result, fetched, elapsedMs: Date.now() - started };
  }

  return { home, repo, run };
}

const NOTICE = /\nUpdate available: crbuddy 0\.4\.2 → 99\.0\.0\nRun: npm i -g crbuddy@latest\n$/;

test('a newer registry version is announced after the command, on stderr', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['view'], { CRB_TEST_TTY: '1', CRB_TEST_REGISTRY: '99.0.0' });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Config: None/);
  assert.doesNotMatch(result.stdout, /Update available/);
  assert.match(result.stderr, NOTICE);
  assert.deepEqual(result.fetched, ['https://registry.npmjs.org/-/package/crbuddy/dist-tags']);

  // The answer is cached: the next command within a day asks nobody.
  const again = await f.run(['view'], { CRB_TEST_TTY: '1', CRB_TEST_REGISTRY: '99.0.0' });
  assert.match(again.stderr, NOTICE);
  assert.deepEqual(again.fetched, []);
});

test('a registry version that is not newer prints nothing', async (t) => {
  const f = await fixture(t);
  for (const latest of ['0.4.2', '0.4.1']) {
    await rm(path.join(f.home, '.crbuddy', 'update-check.json'), { force: true });
    const result = await f.run(['view'], { CRB_TEST_TTY: '1', CRB_TEST_REGISTRY: latest });

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.fetched.length, 1, latest);
    assert.doesNotMatch(result.stderr, /Update available/, latest);
  }
});

test('a failed or hanging registry request leaves the command unaffected', async (t) => {
  const f = await fixture(t);
  const baseline = await f.run(['view']);

  for (const mode of ['error', 'hang', 'stall']) {
    const result = await f.run(['view'], { CRB_TEST_TTY: '1', CRB_TEST_REGISTRY: mode });
    assert.equal(result.code, 0, `${mode}: ${result.stderr}`);
    assert.equal(result.stdout, baseline.stdout, mode);
    assert.equal(result.stderr, baseline.stderr, mode);
    assert.equal(result.fetched.length, 1, mode);
    // Bounded by the 1.5 s request timeout, not by the registry.
    assert.ok(result.elapsedMs < 10_000, `${mode} took ${result.elapsedMs} ms`);
    // The attempt counts toward the daily limit.
    await rm(path.join(f.home, '.crbuddy', 'update-check.json'), { force: true });
  }
});

test('a recent cached check makes no registry request', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.crbuddy'), { recursive: true });
  await writeFile(
    path.join(f.home, '.crbuddy', 'update-check.json'),
    JSON.stringify({ checkedAt: Date.now() - 60_000, latest: '99.0.0' }),
  );

  const result = await f.run(['view'], { CRB_TEST_TTY: '1', CRB_TEST_REGISTRY: 'error' });
  assert.match(result.stderr, NOTICE);
  assert.deepEqual(result.fetched, []);
});

test('CI and non-interactive runs make no request and print no notice', async (t) => {
  const f = await fixture(t);

  const cases: Array<Record<string, string>> = [
    { CRB_TEST_REGISTRY: '99.0.0' },
    { CRB_TEST_TTY: '1', CRB_TEST_REGISTRY: '99.0.0', CI: 'true' },
    { CRB_TEST_TTY: '1', CRB_TEST_REGISTRY: '99.0.0', CRBUDDY_NO_UPDATE_CHECK: '1' },
  ];

  for (const env of cases) {
    const result = await f.run(['view'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Update available/, JSON.stringify(env));
    assert.deepEqual(result.fetched, [], JSON.stringify(env));
  }
});

test('--version prints only the version and never checks', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--version'], { CRB_TEST_TTY: '1', CRB_TEST_REGISTRY: '99.0.0' });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, '0.4.2\n');
  assert.equal(result.stderr, '');
  assert.deepEqual(result.fetched, []);
});

test('go without any config says exactly how to set crbuddy up', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['go'], {}, f.repo);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, "crbuddy isn't configured yet.\n\nRun:\n  crb init\n");
});

test('a config that exists but is broken keeps its specific error', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.repo, '.crbuddy'));
  await writeFile(path.join(f.repo, '.crbuddy', 'config.json'), '{ not json');

  const result = await f.run(['go'], {}, f.repo);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /config\.json is not valid JSON/);
  assert.doesNotMatch(result.stderr, /isn't configured yet/);

  // A broken global config is reported the same way.
  await rm(path.join(f.repo, '.crbuddy'), { recursive: true });
  await mkdir(path.join(f.home, '.crbuddy'), { recursive: true });
  await writeFile(path.join(f.home, '.crbuddy', 'config.json'), '{"configVersion": 99}');
  const global = await f.run(['go'], {}, f.repo);
  assert.equal(global.code, 1);
  assert.doesNotMatch(global.stderr, /isn't configured yet/);
  assert.match(global.stderr, /config declares version 99/);
});

test('a version the CLI cannot read is never compared with the registry', async (t) => {
  const f = await fixture(t);
  // dist-test has no package.json beside it, so the CLI does not know its version.
  const result = await f.run(
    ['view'],
    { CRB_TEST_TTY: '1', CRB_TEST_REGISTRY: '99.0.0' },
    undefined,
    path.resolve('dist-test/src/index.js'),
  );

  assert.equal(result.code, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Update available/);
  assert.deepEqual(result.fetched, []);
});

test('a dangling config symlink is reported as broken, not as unconfigured', {
  skip: process.platform === 'win32' ? 'creating symlinks needs privileges on Windows' : false,
}, async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.crbuddy'), { recursive: true });
  await symlink(
    path.join(f.home, 'moved-dotfiles', 'config.json'),
    path.join(f.home, '.crbuddy', 'config.json'),
  );

  const result = await f.run(['go'], {}, f.repo);
  assert.equal(result.code, 1);
  assert.doesNotMatch(result.stderr, /isn't configured yet/);
  assert.match(result.stderr, /Cannot read config at .*config\.json/);
});
