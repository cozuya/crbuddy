import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
    import { syncBuiltinESMExports } from 'node:module';
    import { isMainThread } from 'node:worker_threads';
    if (isMainThread && process.env.CRB_TEST_TTY) process.stderr.isTTY = true;
    // Inject stat failures so permission regressions also run as root and on Windows.
    if (isMainThread && process.env.CRB_TEST_UNREADABLE_CONFIG) {
      const original = fs.lstatSync;
      fs.lstatSync = function(file, ...args) {
        if (String(file) === process.env.CRB_TEST_UNREADABLE_CONFIG) {
          const code = process.env.CRB_TEST_CONFIG_STAT_ERROR;
          throw Object.assign(new Error(code + ': permission denied, lstat ' + file), { code });
        }
        return original.call(this, file, ...args);
      };
      syncBuiltinESMExports();
    }
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
    input = '',
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
        child.stdin.end(input);
      },
    );
    const fetched = existsSync(requests)
      ? (await readFile(requests, 'utf8')).trim().split('\n')
      : [];

    return { ...result, fetched, elapsedMs: Date.now() - started };
  }

  return { home, repo, outside, run };
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

const addConfig = {
  configVersion: 1,
  output: { destination: 'terminal', merged: 'saved-report.md' },
  target: { base: 'develop' },
  timeoutMs: 456_000,
  panel: [{ id: 'existing', vendor: 'claude', model: 'opus', effort: 'max' }],
};

async function saveConfig(file: string): Promise<string> {
  const contents = JSON.stringify(addConfig);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
  return contents;
}

async function fakeVendors(home: string): Promise<Record<string, string>> {
  const bin = path.join(home, 'bin');
  await mkdir(bin);
  const script = path.join(bin, 'vendor.cjs');
  await writeFile(script, 'process.stdout.write("99.0.0\\n");\n');
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  for (const vendor of ['claude', 'codex', 'gemini']) {
    const file = path.join(bin, `${vendor}${process.platform === 'win32' ? '.cmd' : ''}`);
    await writeFile(file, process.platform === 'win32'
      ? `@"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`);
    await chmod(file, 0o755);
  }
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
}

test('help documents add, and both installed command names share the entrypoint', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /crbuddy add\s+Append reviewers to an existing saved panel/);
  const manifest = JSON.parse(await readFile(path.resolve('package.json'), 'utf8'));
  assert.equal(manifest.bin.crbuddy, manifest.bin.crb);
});

test('add with no saved configuration exits before any wizard question or vendor detection', async (t) => {
  const f = await fixture(t);
  for (const cwd of [f.repo, f.outside]) {
    const result = await f.run(['add'], { CRB_TEST_TTY: '1', CRB_TEST_REGISTRY: '99.0.0' }, cwd);
    assert.equal(result.code, 1);
    assert.equal(result.stdout,
      'crb add adds reviewers to an existing panel. No saved configuration found. Run `crb init` first.\n');
    assert.equal(result.stderr, '');
    assert.deepEqual(result.fetched, []);
    assert.equal(existsSync(path.join(f.repo, '.crbuddy')), false);
    assert.equal(existsSync(path.join(f.home, '.crbuddy')), false);
  }
});

test('add refuses a missing selected scope in both directions, with prompts or flags', async (t) => {
  for (const savedScope of ['global', 'project']) {
    await t.test(savedScope, async (t) => {
      const f = await fixture(t);
      const existing = path.join(savedScope === 'global' ? f.home : f.repo, '.crbuddy', 'config.json');
      const before = await saveConfig(existing);
      const missingScope = savedScope === 'global' ? 'project' : 'global';
      const answer = missingScope === 'project' ? '2\n' : '1\n';
      for (const flagged of [false, true]) {
        const result = await f.run(['add', ...(flagged ? [`--${missingScope}`] : [])], {}, f.repo, undefined, answer);
        assert.equal(result.code, 1);
        assert.ok(result.stdout.includes(`No ${missingScope === 'project' ? 'local' : 'global'} configuration found. Run \`crb init --${missingScope}\` first.`));
        assert.equal(result.stdout.includes('Where should this config live?'), !flagged);
        assert.doesNotMatch(result.stdout, /Checking vendor CLIs|Start from scratch|Edit the repository config instead/);
        assert.equal(await readFile(existing, 'utf8'), before);
        assert.equal(existsSync(path.join(missingScope === 'global' ? f.home : f.repo, '.crbuddy', 'config.json')), false);
      }
      if (savedScope === 'project') {
        const outside = await f.run(['add'], {}, f.outside);
        assert.equal(outside.code, 1);
        assert.match(outside.stdout, /No saved configuration found/);
      }
    });
  }
});

test('piped add edits only the explicitly selected config and skips unrelated setup', async (t) => {
  for (const scope of ['global', 'project']) {
    await t.test(scope, async (t) => {
      const f = await fixture(t);
      const env = await fakeVendors(f.home);
      const localFile = path.join(f.repo, '.crbuddy', 'config.json');
      const globalFile = path.join(f.home, '.crbuddy', 'config.json');
      const before = await saveConfig(localFile);
      await saveConfig(globalFile);
      const settingsFile = path.join(f.home, '.crbuddy', 'settings.json');
      const gitignore = path.join(f.repo, '.gitignore');
      await writeFile(settingsFile, '{"notifications":{"provider":"ntfy","endpoint":"https://ntfy.sh/test-topic"}}');
      await writeFile(gitignore, '# keep\n');
      const settings = await readFile(settingsFile, 'utf8');
      // Scope, vendor, model, effort, custom instructions, add another.
      const input = [scope === 'global' ? '1' : '2', '', '', '', 'n', 'n'].join('\n') + '\n';
      const result = await f.run(['add'], env, f.repo, undefined, input);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      const selected = scope === 'global' ? globalFile : localFile;
      const other = scope === 'global' ? localFile : globalFile;
      const written = JSON.parse(await readFile(selected, 'utf8'));
      assert.equal(written.panel.length, 2);
      assert.deepEqual(written.panel[0], addConfig.panel[0]);
      assert.equal(written.panel[1].vendor, 'codex');
      assert.equal(written.output.merged, addConfig.output.merged);
      assert.deepEqual(written.target, addConfig.target);
      assert.equal(written.timeoutMs, addConfig.timeoutMs);
      assert.equal(await readFile(other, 'utf8'), before);
      assert.equal(await readFile(settingsFile, 'utf8'), settings);
      assert.equal(await readFile(gitignore, 'utf8'), '# keep\n');
      assert.match(result.stdout, /Configuration\nConfig: (Global|This repository)/);
      assert.ok(result.stdout.includes(`Adding reviewers to the ${scope === 'global' ? 'global' : 'local'} config at ${selected}`));
      assert.doesNotMatch(result.stdout, /Keep these reviewers|Edit the repository config instead|Where should the output|What should be reviewed|gitignore\?|Notify you|Save this config\?/);
    });
  }
});

test('add defers config access errors until the affected scope is selected', async (t) => {
  for (const scope of ['project', 'global']) {
    for (const errorCode of ['EACCES', 'EPERM']) {
      await t.test(`${scope}: ${errorCode}`, async (t) => {
        const f = await fixture(t);
        const blockedFile = path.join(scope === 'project' ? f.repo : f.home, '.crbuddy', 'config.json');
        const usableFile = path.join(scope === 'project' ? f.home : f.repo, '.crbuddy', 'config.json');
        const before = await saveConfig(blockedFile);
        await saveConfig(usableFile);
        const env = {
          ...await fakeVendors(f.home),
          CRB_TEST_UNREADABLE_CONFIG: blockedFile,
          CRB_TEST_CONFIG_STAT_ERROR: errorCode,
        };
        const usableAnswer = scope === 'project' ? '1' : '2';
        const blockedAnswer = scope === 'project' ? '2' : '1';
        const input = [usableAnswer, '', '', '', 'n', 'n'].join('\n') + '\n';
        const saved = await f.run(['add'], env, f.repo, undefined, input);
        assert.equal(saved.code, 0, saved.stdout + saved.stderr);
        assert.match(saved.stdout, /Where should this config live\?/);
        assert.equal(JSON.parse(await readFile(usableFile, 'utf8')).panel.length, 2);
        assert.equal(await readFile(blockedFile, 'utf8'), before);
        const usableAfter = await readFile(usableFile, 'utf8');

        // Both prompted and explicit selection must still report the real error.
        for (const flagged of [false, true]) {
          const refused = await f.run(
            ['add', ...(flagged ? [`--${scope}`] : [])], env, f.repo, undefined, `${blockedAnswer}\n`,
          );
          assert.equal(refused.code, 1, refused.stdout + refused.stderr);
          assert.equal(refused.stdout.includes('Where should this config live?'), !flagged);
          assert.ok(refused.stderr.includes(`Cannot read config at ${blockedFile}`), refused.stderr);
          assert.ok(refused.stderr.includes(errorCode), refused.stderr);
          assert.doesNotMatch(refused.stdout, /Checking vendor CLIs|Start from scratch|No .*configuration found/);
          assert.equal(await readFile(blockedFile, 'utf8'), before);
          assert.equal(await readFile(usableFile, 'utf8'), usableAfter);
        }

        // Even with no healthy config, an inaccessible one is not definitely missing.
        await rm(usableFile);
        const onlyBlocked = await f.run(['add'], env, f.repo, undefined, `${blockedAnswer}\n`);
        assert.equal(onlyBlocked.code, 1);
        assert.match(onlyBlocked.stdout, /Where should this config live\?/);
        assert.ok(onlyBlocked.stderr.includes(errorCode), onlyBlocked.stderr);
        assert.doesNotMatch(onlyBlocked.stdout, /Checking vendor CLIs|Start from scratch|No .*configuration found/);
        assert.equal(await readFile(blockedFile, 'utf8'), before);
        assert.equal(existsSync(usableFile), false);
        assert.equal(existsSync(path.join(f.repo, '.gitignore')), false);
        assert.equal(existsSync(path.join(f.home, '.crbuddy', 'settings.json')), false);
      });
    }
  }
});

test('add outside a repository uses only the global config and preserves EOF cancellation', async (t) => {
  const f = await fixture(t);
  const env = await fakeVendors(f.home);
  const file = path.join(f.home, '.crbuddy', 'config.json');
  const before = await saveConfig(file);
  const aborted = await f.run(['add'], env);
  assert.equal(aborted.code, 130);
  assert.equal(await readFile(file, 'utf8'), before);
  assert.equal(existsSync(path.join(f.home, '.crbuddy', 'settings.json')), false);

  const saved = await f.run(['add'], env, undefined, undefined, '\n\n\nn\nn\n');
  assert.equal(saved.code, 0, saved.stdout + saved.stderr);
  assert.doesNotMatch(saved.stdout, /Where should this config live/);
  assert.match(saved.stdout, /Config: Global/);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).panel.length, 2);
  assert.equal(existsSync(path.join(f.home, '.crbuddy', 'settings.json')), false);
});

test('init and config retain their piped answer sequences', async (t) => {
  const f = await fixture(t);
  const env = await fakeVendors(f.home);
  // Scope, vendor, model, effort, custom instructions, add another,
  // terminal output, target, gitignore, notifications.
  const initial = ['2', '', '', '', 'n', 'n', '2', '', 'n', 'n'].join('\n') + '\n';
  const created = await f.run(['init'], env, f.repo, undefined, initial);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  const file = path.join(f.repo, '.crbuddy', 'config.json');
  const before = await readFile(file, 'utf8');
  // Scope, keep reviewers, add another, output, target, gitignore, notifications.
  const edit = ['2', 'y', 'n', '', '', 'n', 'n'].join('\n') + '\n';
  const edited = await f.run(['config'], env, f.repo, undefined, edit);
  assert.equal(edited.code, 0, edited.stdout + edited.stderr);
  assert.equal(await readFile(file, 'utf8'), before);
});
