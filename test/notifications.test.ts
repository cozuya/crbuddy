import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';

const endpoint = 'https://ntfy.sh/crbuddy-test-secret-topic';
const enabled = { notifications: { provider: 'ntfy', endpoint } };
const review = '## First defect\nA concrete finding in code.txt:1.\n\n' +
  '## Second defect\nAnother concrete finding in code.txt:2.\n';

interface Post {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: string;
}

interface MenuSnapshot {
  posts: Post[];
  reportPrintedBeforePost: boolean;
  deliverySettled: boolean;
}

/** Exercise the real router, review lifecycle and process spawner in an isolated home. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-notify-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'sample-repo');
  const userDir = path.join(root, 'home');
  const configFile = path.join(repo, '.crbuddy', 'config.json');
  const settingsFile = path.join(userDir, '.crbuddy', 'settings.json');
  const postsFile = path.join(root, 'posts.jsonl');
  const menuFile = path.join(root, 'menu.json');
  const printedFile = path.join(root, 'printed');
  const postStartedFile = path.join(root, 'post-started.json');
  const launchedFile = path.join(root, 'launched');
  const seenFile = path.join(root, 'seen.json');
  const fakeCli = path.join(root, 'reviewer.cjs');
  const preload = path.join(root, 'preload.mjs');
  await mkdir(path.dirname(configFile), { recursive: true });
  await mkdir(path.dirname(settingsFile), { recursive: true });

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '--quiet');
  await writeFile(path.join(repo, 'code.txt'), 'before\n');
  git('add', 'code.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Initial');
  await writeFile(path.join(repo, 'code.txt'), 'after\n');

  const config = {
    configVersion: 1,
    output: { destination: 'file', merged: 'review.md' },
    target: 'uncommitted',
    timeoutMs: 5_000,
    panel: [{ id: 'one', vendor: 'codex', model: 'ok' }],
  };
  const saveConfig = () => writeFile(configFile, JSON.stringify(config));
  await saveConfig();
  await writeFile(settingsFile, JSON.stringify(enabled));

  await writeFile(fakeCli, `
    const fs = require('node:fs');
    const model = process.argv[2];
    fs.writeFileSync(${JSON.stringify(seenFile)}, JSON.stringify(fs.readdirSync('.')));
    fs.writeFileSync(${JSON.stringify(launchedFile)}, model);
    if (process.env.CRB_TEST_COMMIT_FAILURE) fs.mkdirSync('review.md');
    const finish = () => {
      if (model.includes('fail')) {
        console.error('reviewer failed');
        process.exitCode = 7;
      } else {
        console.log(${JSON.stringify(review)});
      }
    };
    if (model.includes('slow')) setTimeout(finish, 500);
    else finish();
  `);

  const vendorsUrl = pathToFileURL(path.resolve('dist-test/src/adapters/vendors.js')).href;
  // The preload runs in both the CLI and its notification worker. Every fetch
  // is mocked unless a transport test explicitly supplies a loopback endpoint.
  await writeFile(preload, `
    import fs from 'node:fs';
    import { isMainThread, Worker } from 'node:worker_threads';
    import { ADAPTERS, codexAdapter } from ${JSON.stringify(vendorsUrl)};
    ADAPTERS.splice(0, ADAPTERS.length, codexAdapter);
    codexAdapter.command = process.execPath;
    codexAdapter.versionArgs = () => ['-e', 'console.log("codex-cli 0.153.4")'];
    codexAdapter.helpArgs = () => ['-e', 'console.log("--sandbox --ephemeral --color -c")'];
    if (process.env.CRB_TEST_PREFLIGHT) codexAdapter.command = 'crbuddy-no-such-cli';
    // Stands in for a Claude review judged incomplete: failed, output kept.
    const originalCheck = codexAdapter.checkCompletion;
    codexAdapter.checkCompletion = function(result, invocation) {
      if (process.env.CRB_TEST_INCOMPLETE && result.stdout.includes('First defect')) {
        return { ok: false, reason: 'incomplete_review', detail: 'Test: 1 background task still listed.', keepOutput: true };
      }
      return originalCheck.call(this, result, invocation);
    };
    const originalBuild = codexAdapter.build;
    codexAdapter.build = function(request) {
      const invocation = originalBuild.call(this, request);
      return {
        ...invocation,
        command: request.model === 'spawn-error' ? 'crbuddy-no-such-cli' : process.execPath,
        args: [${JSON.stringify(fakeCli)}, request.model],
      };
    };
    let deliverySettled = false;
    // Observe worker shutdown without replacing transport or its lifecycle.
    const emit = Worker.prototype.emit;
    Worker.prototype.emit = function(event, ...args) {
      if (event === 'exit') deliverySettled = true;
      return emit.call(this, event, ...args);
    };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      fs.writeFileSync(${JSON.stringify(postStartedFile)}, JSON.stringify({
        reportPrintedBeforePost: fs.existsSync(${JSON.stringify(printedFile)}),
      }));
      fs.appendFileSync(${JSON.stringify(postsFile)}, JSON.stringify({ url, ...options }) + '\\n');
      if (process.env.CRB_TEST_LOOPBACK) {
        const local = new URL(process.env.CRB_TEST_LOOPBACK);
        if (local.hostname !== '127.0.0.1') throw new Error('Test transport must be loopback');
        return realFetch(local, options);
      }
      if (process.env.CRB_TEST_DELIVERY === 'network-error') {
        console.error('Private transport diagnostic ' + url);
        throw new Error('Failed ' + url);
      }
      if (process.env.CRB_TEST_DELIVERY === 'delayed-success') {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (process.env.CRB_TEST_DELIVERY === 'timeout') {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
      return new Response('secret response ' + url, {
        status: process.env.CRB_TEST_DELIVERY === 'http-error' ? 503 : 200,
      });
    };
    if (isMainThread && process.env.CRB_TEST_INTERRUPT) {
      const watcher = fs.watch(${JSON.stringify(root)}, (event, file) => {
        if (file !== 'launched') return;
        const model = fs.readFileSync(${JSON.stringify(launchedFile)}, 'utf8');
        if (model !== process.env.CRB_TEST_INTERRUPT) return;
        watcher.close();
        process.emit('SIGINT');
      });
      watcher.unref();
    }
    if (isMainThread && process.env.CRB_TEST_MENU_ACTION) {
      for (const stream of [process.stdin, process.stdout, process.stderr]) stream.isTTY = true;
      process.stdin.setRawMode = () => process.stdin;
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = function(chunk, ...args) {
        if (process.env.CRB_TEST_RENDER_FAILURE && String(chunk).includes('## First defect')) {
          throw new Error('Test output rendering failed');
        }
        const result = write(chunk, ...args);
        if (String(chunk).includes('## First defect')) fs.writeFileSync(${JSON.stringify(printedFile)}, '');
        if (String(chunk).includes('Report(s) done, pick one:')) {
          const posts = fs.existsSync(${JSON.stringify(postsFile)})
            ? fs.readFileSync(${JSON.stringify(postsFile)}, 'utf8').trim().split('\\n').map(JSON.parse)
            : [];
          fs.writeFileSync(${JSON.stringify(menuFile)}, JSON.stringify({
            posts, deliverySettled,
            ...(fs.existsSync(${JSON.stringify(postStartedFile)})
              ? JSON.parse(fs.readFileSync(${JSON.stringify(postStartedFile)}, 'utf8'))
              : { reportPrintedBeforePost: false }),
          }));
          // Observe the boundary before providing any post-run input.
          setTimeout(() => {
            if (process.env.CRB_TEST_MENU_ACTION === 'cancel') {
              process.stdin.emit('keypress', '\\x03', { name: 'c', ctrl: true });
            } else {
              process.stdin.emit('keypress', '', { name: 'down' });
              process.stdin.emit('keypress', '\\r', { name: 'return' });
            }
          }, 100);
        }
        return result;
      };
    }
  `);

  async function run(
    args = ['go'],
    env: Record<string, string> = {},
    stdin = '',
  ) {
    await rm(postsFile, { force: true });
    await rm(menuFile, { force: true });
    await rm(printedFile, { force: true });
    await rm(postStartedFile, { force: true });
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--import', pathToFileURL(preload).href, path.resolve('dist-test/src/index.js'), ...args,
      ], {
        cwd: repo,
        env: { ...process.env, HOME: userDir, USERPROFILE: userDir, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`CLI test timed out: ${stdout}\n${stderr}`));
      }, 15_000);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.end(stdin);
    });
    const posts: Post[] = existsSync(postsFile)
      ? (await readFile(postsFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
      : [];
    const menu: MenuSnapshot | null = existsSync(menuFile)
      ? JSON.parse(await readFile(menuFile, 'utf8'))
      : null;
    return { ...result, posts, menu };
  }

  return { root, repo, userDir, config, configFile, settingsFile, launchedFile, seenFile, saveConfig, run };
}

test('successful launched go sends exactly one small POST using global preferences', async (t) => {
  const f = await fixture(t);
  // A project-local settings file is deliberately irrelevant.
  await writeFile(path.join(f.repo, '.crbuddy', 'settings.json'), '{}');
  f.config.panel.push({ id: 'two', vendor: 'codex', model: 'ok' });
  await f.saveConfig();
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.posts[0], {
    url: endpoint,
    method: 'POST',
    headers: { Title: 'crbuddy finished', 'Content-Type': 'text/plain; charset=utf-8' },
    body: 'sample-repo: review complete',
    redirect: 'error',
  });
  assert.doesNotMatch(result.stdout + result.stderr, /crbuddy-test-secret-topic/);
  assert.doesNotMatch(await readFile(path.join(f.repo, 'review.md'), 'utf8'), /crbuddy-test-secret-topic/);
});

test('the applied effort is shown in terminal progress and in the report', async (t) => {
  const f = await fixture(t);
  await writeFile(f.configFile, JSON.stringify({
    ...f.config,
    panel: [
      { id: 'one', vendor: 'codex', model: 'ok', effort: 'high' },
      { id: 'two', vendor: 'codex', model: 'ok' },
    ],
  }));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Codex CLI \(ok, high\) \[one\] - started/);
  assert.match(result.stderr, /Codex CLI \(ok\) \[two\] - started/);
  const report = await readFile(path.join(f.repo, 'review.md'), 'utf8');
  assert.match(report, /## one - codex \/ ok, effort high\n/);
  assert.match(report, /## two - codex \/ ok\n/);
});

test('all launched reviewers failing sends one failed notification and preserves exit 1', async (t) => {
  const f = await fixture(t);
  f.config.panel[0]!.model = 'fail';
  await f.saveConfig();
  await writeFile(path.join(f.repo, 'review.md'), 'previous report');
  const result = await f.run();
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0]!.body, 'sample-repo: review failed');
  assert.equal(await readFile(path.join(f.repo, 'review.md'), 'utf8'), 'previous report');
});

test('a thrown output failure after launch still notifies without replacing the error', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['go'], {
    CRB_TEST_COMMIT_FAILURE: '1',
    CRB_TEST_DELIVERY: 'network-error',
  });
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0]!.body, 'sample-repo: review failed');
  assert.match(result.stderr, /directory|EPERM|EISDIR|rename/);
  assert.match(result.stderr, /ntfy notification delivery could not be confirmed/);
  assert.doesNotMatch(result.stderr, /secret-topic/);
});

test('a missing reviewer executable does not suppress another launched reviewer notification', async (t) => {
  const f = await fixture(t);
  f.config.panel.push({ id: 'two', vendor: 'codex', model: 'spawn-error' });
  await f.saveConfig();
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0]!.body, 'sample-repo: review complete (partial)');
});

test('partial reviewers keep default and strict exits', async (t) => {
  const f = await fixture(t);
  f.config.panel.push({ id: 'two', vendor: 'codex', model: 'fail' });
  await f.saveConfig();
  for (const strict of [false, true]) {
    const result = await f.run(strict ? ['go', '--strict'] : ['go']);
    assert.equal(result.code, strict ? 2 : 0, result.stderr);
    assert.equal(result.posts.length, 1);
    assert.equal(result.posts[0]!.body, 'sample-repo: review complete (partial)');
  }
});

test('a config with consolidation keys still reviews and says they are ignored', async (t) => {
  const f = await fixture(t);
  await writeFile(f.configFile, JSON.stringify({
    ...f.config,
    output: { ...f.config.output, raw: 'review.raw.md' },
    mergeTimeoutMs: 5_000,
    merge: { enabled: true, vendor: 'codex', model: 'ok' },
  }));
  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /Ignoring merge, mergeTimeoutMs, output\.raw in /);
  assert.match(result.stderr, /rewrites the file without merge and mergeTimeoutMs\./);
  assert.match(result.stderr, /output\.raw stays: it keeps the old raw report at review\.raw\.md hidden/);
  assert.equal(result.posts.length, 1);
  assert.ok(existsSync(path.join(f.repo, 'review.md')));
  assert.ok(!existsSync(path.join(f.repo, 'review.raw.md')));
});

test('a raw report left by crbuddy before 0.4.0 is hidden, excluded and put back', async (t) => {
  const f = await fixture(t);
  const legacyDefault = path.join(f.repo, 'CODE-REVIEW-HANDOFF.raw.md');
  const legacyConfigured = path.join(f.repo, 'custom.raw.md');

  for (const destination of ['file', 'terminal']) {
    await writeFile(f.configFile, JSON.stringify({
      ...f.config,
      output: { ...f.config.output, destination, raw: 'custom.raw.md' },
    }));
    await writeFile(legacyDefault, 'old default raw findings\n');
    await writeFile(legacyConfigured, 'old configured raw findings\n');

    const result = await f.run();
    assert.equal(result.code, 0, result.stderr);

    const seen: string[] = JSON.parse(await readFile(f.seenFile, 'utf8'));
    assert.ok(seen.includes('code.txt'), destination);
    assert.ok(!seen.includes('CODE-REVIEW-HANDOFF.raw.md'), destination);
    assert.ok(!seen.includes('custom.raw.md'), destination);
    // Out of the diff too: the one real change is all that is under review.
    assert.match(result.stderr, /Reviewing 1 file\(s\)/);
    assert.match(result.stderr, /custom\.raw\.md is a report from crbuddy before 0\.4\.0/);

    assert.equal(await readFile(legacyDefault, 'utf8'), 'old default raw findings\n');
    assert.equal(await readFile(legacyConfigured, 'utf8'), 'old configured raw findings\n');
  }
});

test('a crash stash from before 0.4.0 that holds the raw report is recovered whole', async (t) => {
  const f = await fixture(t);
  const repo = await realpath(f.repo);
  const batch = path.join(repo, '.crbuddy', 'previous', 'old-run');
  await mkdir(batch, { recursive: true });
  await writeFile(path.join(batch, '0.stashed'), 'previous report\n');
  await writeFile(path.join(batch, '1.stashed'), 'previous raw report\n');
  await writeFile(path.join(batch, 'manifest.json'), JSON.stringify([
    { stored: '0.stashed', relative: path.join(repo, 'review.md') },
    { stored: '1.stashed', relative: path.join(repo, 'CODE-REVIEW-HANDOFF.raw.md') },
  ]));

  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stderr,
    /Recovered .*review\.md, .*CODE-REVIEW-HANDOFF\.raw\.md left behind by an interrupted run/,
  );
  assert.ok(!existsSync(batch));

  // This run replaces the recovered report and keeps the raw one hidden.
  assert.match(await readFile(path.join(repo, 'review.md'), 'utf8'), /First defect/);
  assert.equal(
    await readFile(path.join(repo, 'CODE-REVIEW-HANDOFF.raw.md'), 'utf8'),
    'previous raw report\n',
  );
  const seen: string[] = JSON.parse(await readFile(f.seenFile, 'utf8'));
  assert.ok(!seen.includes('CODE-REVIEW-HANDOFF.raw.md'));
});

test('a pre-0.4 crash stash with an outside raw report is recovered only for a global config', async (t) => {
  for (const scope of ['global', 'project'] as const) {
    const f = await fixture(t);
    const repo = await realpath(f.repo);
    const outside = path.join(await realpath(f.root), 'outside.raw.md');
    const config = JSON.stringify({ ...f.config, output: { ...f.config.output, raw: outside } });
    if (scope === 'global') {
      await rm(f.configFile);
      await writeFile(path.join(f.userDir, '.crbuddy', 'config.json'), config);
    } else {
      await writeFile(f.configFile, config);
    }

    const batch = path.join(repo, '.crbuddy', 'previous', 'old-run');
    await mkdir(batch, { recursive: true });
    await writeFile(path.join(batch, '0.stashed'), 'previous report\n');
    await writeFile(path.join(batch, '1.stashed'), 'previous raw report\n');
    await writeFile(path.join(batch, 'manifest.json'), JSON.stringify([
      { stored: '0.stashed', relative: path.join(repo, 'review.md') },
      { stored: '1.stashed', relative: outside },
    ]));

    const result = await f.run();
    assert.equal(result.code, 0, result.stderr);

    if (scope === 'global') {
      assert.match(result.stderr, /Recovered .*review\.md, .*outside\.raw\.md left behind/);
      assert.ok(!existsSync(batch));
      assert.equal(await readFile(outside, 'utf8'), 'previous raw report\n');
    } else {
      // Restoring outside the repository from a cloned repo's config would
      // need consent, so the whole batch is left where it is.
      assert.doesNotMatch(result.stderr, /Recovered/);
      assert.ok(existsSync(path.join(batch, '1.stashed')));
      assert.ok(!existsSync(outside));
    }
  }
});

test('a panel whose only output is a kept incomplete review still writes it', async (t) => {
  const f = await fixture(t);
  const report = path.join(f.repo, 'review.md');
  await writeFile(report, 'previous report\n');

  const result = await f.run(['go'], { CRB_TEST_INCOMPLETE: '1' });

  // Still a total failure, but the finished text is handed over, marked.
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /FAILED: incomplete_review/);
  assert.match(result.stderr, /No review completed; the report holds only output kept/);
  const written = await readFile(report, 'utf8');
  assert.match(written, /failed: incomplete_review - its output is kept below, possibly incomplete/);
  assert.match(written, /## First defect/);
  assert.equal(result.posts.length, 1);
  assert.match(result.posts[0]!.body, /failed/);
});

test('a leftover raw report path cannot carry terminal control sequences', async (t) => {
  const f = await fixture(t);
  const name = 'old\u001b]52;c;cHduZWQ=\u0007raw.md';
  await writeFile(f.configFile, JSON.stringify({
    ...f.config,
    output: { ...f.config.output, raw: name },
  }));
  await writeFile(path.join(f.repo, name), 'old raw findings\n');

  const result = await f.run();
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stderr, /oldraw\.md is a report from crbuddy before 0\.4\.0/);
  assert.ok(!result.stderr.includes('\u001b'), 'no escape character reaches the terminal');
});

test('config paths in the consent list cannot carry terminal control sequences', async (t) => {
  const f = await fixture(t);
  const spoof = path.join(f.root, 'outside\u001b[2K\u001b[1Gharmless', 'review.md');
  await writeFile(f.configFile, JSON.stringify({
    ...f.config,
    output: { ...f.config.output, merged: spoof },
  }));

  const result = await f.run();
  // Unattended, so the outside path is refused - after it has been listed.
  assert.equal(result.code, 1);
  // The sequences are removed whole, so what is listed is plain text.
  assert.match(result.stderr, /outsideharmless\/review\.md/);
  assert.ok(!result.stderr.includes('\u001b'), 'no escape character reaches the terminal');
});

test('missing, disabled and malformed global settings do not prevent a review or send a POST', async (t) => {
  const f = await fixture(t);
  for (const contents of [null, '{}', '{bad secret-topic']) {
    if (contents === null) await rm(f.settingsFile);
    else await writeFile(f.settingsFile, contents);
    // Global-only: local settings cannot opt the user in.
    await writeFile(path.join(f.repo, '.crbuddy', 'settings.json'), JSON.stringify(enabled));
    const result = await f.run();
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(result.posts, []);
    if (contents?.includes('bad')) {
      assert.match(result.stderr, /notification settings.*disabled/);
      assert.doesNotMatch(result.stderr, /secret-topic/);
    }
  }
});

test('preflight, empty-diff refusal, unsafe invocation and spawn failure do not notify', async (t) => {
  const f = await fixture(t);
  const preflight = await f.run(['go'], { CRB_TEST_PREFLIGHT: '1' });
  assert.equal(preflight.code, 1);
  assert.deepEqual(preflight.posts, []);
  await writeFile(path.join(f.repo, 'code.txt'), 'before\n');
  const empty = await f.run();
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /target diff is empty/);
  assert.deepEqual(empty.posts, []);
  await writeFile(path.join(f.repo, 'code.txt'), 'changed\n');
  const unsafe = JSON.parse(JSON.stringify(f.config));
  unsafe.panel[0].vendorArgs = ['--sandbox', 'danger-full-access'];
  await writeFile(f.configFile, JSON.stringify(unsafe));
  const refused = await f.run();
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /unsafe_invocation/);
  assert.deepEqual(refused.posts, []);
  f.config.panel[0]!.model = 'spawn-error';
  await f.saveConfig();
  const spawnError = await f.run();
  assert.equal(spawnError.code, 1);
  assert.deepEqual(spawnError.posts, []);
  assert.equal(existsSync(f.launchedFile), false);
});

test('setup, help, version, diagnostics and argument/config errors never notify', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['--help'], ['--version'], ['doctor'], ['check'], ['unknown'],
    ['go', '--unknown'], ['go', 'one', 'two'], ['init'], ['config'],
  ]) {
    const result = await f.run(args);
    assert.deepEqual(result.posts, [], args.join(' '));
  }
  await writeFile(f.configFile, '{bad config');
  const result = await f.run();
  assert.equal(result.code, 1);
  assert.deepEqual(result.posts, []);
  assert.equal(existsSync(f.launchedFile), false);
});

test('graceful first SIGINT during reviewers suppresses the push', async (t) => {
  const f = await fixture(t);
  f.config.panel[0]!.model = 'slow';
  await f.saveConfig();
  await writeFile(path.join(f.repo, 'review.md'), 'previous report');
  const result = await f.run(['go'], { CRB_TEST_INTERRUPT: 'slow' });
  assert.equal(result.code, 130, result.stderr);
  assert.match(result.stderr, /Interrupted/);
  assert.deepEqual(result.posts, []);
  assert.equal(await readFile(path.join(f.repo, 'review.md'), 'utf8'), 'previous report');
});

test('terminal success and partial outcomes notify after printing and before clipboard input', async (t) => {
  for (const outcome of ['complete', 'reviewer-partial']) {
    const f = await fixture(t);
    f.config.output.destination = 'terminal';
    if (outcome === 'reviewer-partial') {
      f.config.panel.push({ id: 'two', vendor: 'codex', model: 'fail' });
    }
    await f.saveConfig();

    for (const strict of [false, true]) {
      const result = await f.run(strict ? ['go', '--strict'] : ['go'], {
        CRB_TEST_MENU_ACTION: 'exit',
        CRB_TEST_DELIVERY: 'delayed-success',
      });
      assert.equal(result.code, strict && outcome !== 'complete' ? 2 : 0, result.stderr);
      assert.equal(result.posts.length, 1);
      assert.deepEqual(result.menu?.posts, result.posts);
      assert.equal(result.menu?.reportPrintedBeforePost, true);
      assert.equal(result.menu?.deliverySettled, true);
      assert.equal(result.posts[0]!.body, outcome === 'complete'
        ? 'sample-repo: review complete'
        : 'sample-repo: review complete (partial)');
    }
  }
});

test('Ctrl+C at the clipboard menu cannot duplicate the completed review notification', async (t) => {
  const f = await fixture(t);
  f.config.output.destination = 'terminal';
  await f.saveConfig();
  const result = await f.run(['go'], { CRB_TEST_MENU_ACTION: 'cancel' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Report\(s\) done, pick one/);
  assert.equal(result.posts.length, 1);
  assert.deepEqual(result.menu?.posts, result.posts);
  assert.equal(result.menu?.reportPrintedBeforePost, true);
});

test('terminal total failure notifies once without offering clipboard UI', async (t) => {
  const f = await fixture(t);
  f.config.output.destination = 'terminal';
  f.config.panel[0]!.model = 'fail';
  await f.saveConfig();
  const result = await f.run(['go'], { CRB_TEST_MENU_ACTION: 'exit' });
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0]!.body, 'sample-repo: review failed');
  assert.equal(result.menu, null);
});

test('terminal rendering failure produces a failed notification and no clipboard menu', async (t) => {
  const f = await fixture(t);
  f.config.output.destination = 'terminal';
  await f.saveConfig();
  const result = await f.run(['go'], {
    CRB_TEST_MENU_ACTION: 'exit',
    CRB_TEST_RENDER_FAILURE: '1',
  });
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0]!.body, 'sample-repo: review failed');
  assert.match(result.stderr, /Test output rendering failed/);
  assert.equal(result.menu, null);
});

test('disabled notifications still allow the final clipboard menu', async (t) => {
  const f = await fixture(t);
  f.config.output.destination = 'terminal';
  await f.saveConfig();
  await writeFile(f.settingsFile, '{}');
  const result = await f.run(['go'], { CRB_TEST_MENU_ACTION: 'exit' });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.posts, []);
  assert.deepEqual(result.menu?.posts, []);
});

test('notification failures settle before the menu without another attempt on menu exit', async (t) => {
  const f = await fixture(t);
  f.config.output.destination = 'terminal';
  f.config.panel.push({ id: 'two', vendor: 'codex', model: 'fail' });
  await f.saveConfig();
  for (const delivery of ['network-error', 'timeout']) {
    const result = await f.run(['go', '--strict'], {
      CRB_TEST_MENU_ACTION: 'exit',
      CRB_TEST_DELIVERY: delivery,
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.posts.length, 1);
    assert.deepEqual(result.menu?.posts, result.posts);
    assert.equal(result.menu?.reportPrintedBeforePost, true);
    assert.equal(result.menu?.deliverySettled, true);
    assert.equal((result.stderr.match(/ntfy notification delivery could not be confirmed/g) ?? []).length, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-topic|https:\/\/ntfy/);
  }
});

test('delivery errors preserve successful, failed and strict partial exit codes without leaking the topic', async (t) => {
  const f = await fixture(t);
  for (const outcome of ['ok', 'fail', 'partial']) {
    f.config.panel = outcome === 'partial'
      ? [{ id: 'one', vendor: 'codex', model: 'ok' }, { id: 'two', vendor: 'codex', model: 'fail' }]
      : [{ id: 'one', vendor: 'codex', model: outcome }];
    await f.saveConfig();
    for (const delivery of ['network-error', 'http-error']) {
      const result = await f.run(['go', '--strict'], { CRB_TEST_DELIVERY: delivery });
      assert.equal(result.code, outcome === 'ok' ? 0 : outcome === 'fail' ? 1 : 2, result.stderr);
      assert.equal(result.posts.length, 1);
      assert.equal((result.stderr.match(/ntfy notification delivery could not be confirmed/g) ?? []).length, 1);
      assert.doesNotMatch(result.stdout + result.stderr, /secret-topic|https:\/\/ntfy/);
    }
  }
});

test('delivery times out promptly with one attempt, an uncertain-delivery warning and a successful exit', async (t) => {
  const f = await fixture(t);
  const started = Date.now();
  const result = await f.run(['go'], { CRB_TEST_DELIVERY: 'timeout' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.posts.length, 1);
  assert.ok(Date.now() - started < 6_000);
  assert.match(result.stderr, /ntfy notification delivery could not be confirmed/);
  assert.doesNotMatch(result.stderr, /secret-topic/);
});

test('a real stalled TLS connection cannot keep the CLI alive past the notification deadline', async (t) => {
  const f = await fixture(t);
  const sockets = new Set<Socket>();
  let connections = 0;
  // Accept TCP but never complete TLS; this exercises Node's real fetch sockets.
  const server = createServer((socket) => {
    connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  for (const outcome of ['ok', 'fail']) {
    f.config.panel[0]!.model = outcome;
    await f.saveConfig();
    const started = Date.now();
    const result = await f.run(['go'], {
      CRB_TEST_LOOPBACK: `https://127.0.0.1:${address.port}/local-test`,
    });
    assert.ok(Date.now() - started < 6_000, 'TLS setup must not retain a live CLI for ~10 seconds');
    assert.equal(result.code, outcome === 'ok' ? 0 : 1, result.stderr);
    assert.equal(result.posts.length, 1);
    assert.match(result.stderr, /ntfy notification delivery could not be confirmed/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret-topic|https:\/\/ntfy/);
  }
  assert.equal(connections, 2, 'both runs must exercise the real loopback transport');
});

test('piped init appends notification answers, config Enter retains them, and No clears globally', async (t) => {
  const f = await fixture(t);
  await rm(f.configFile);
  await rm(f.settingsFile);
  // Existing review answers: vendor, model, effort, instructions, more,
  // destination, location, target. Notification answers follow.
  const reviewAnswers = ['', '', '', 'n', 'n', '', '', ''];
  const first = await f.run(['init', '--global'], {},
    [...reviewAnswers, 'y', '', 'https://example.invalid/crbuddy-invalid-secret-topic', endpoint, ''].join('\n'));
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.doesNotMatch(first.stdout + first.stderr, /crbuddy-(?:test|invalid)-secret-topic/);
  assert.deepEqual(first.posts, []);
  assert.deepEqual(JSON.parse(await readFile(f.settingsFile, 'utf8')), enabled);
  const globalConfig = path.join(f.userDir, '.crbuddy', 'config.json');
  assert.equal(JSON.parse(await readFile(globalConfig, 'utf8')).panel[0].model, 'gpt-6-sol');
  assert.doesNotMatch(await readFile(globalConfig, 'utf8'), /notifications|ntfy/);

  // Editing retains the panel, adds none, keeps file output, then accepts
  // location and target. Three empty notification answers keep ntfy.
  const editAnswers = ['', 'n', '', '', ''];
  const edit = await f.run(['config', '--global'], {}, [...editAnswers, '', '', '', ''].join('\n'));
  assert.equal(edit.code, 0, edit.stdout + edit.stderr);
  assert.match(edit.stdout, /Notify you.*\[Y\/n\]/);
  assert.match(edit.stdout, /ntfy topic URL \[saved value\]/);
  assert.doesNotMatch(edit.stdout + edit.stderr, /crbuddy-test-secret-topic/);
  assert.deepEqual(JSON.parse(await readFile(f.settingsFile, 'utf8')), enabled);
  assert.deepEqual(edit.posts, []);

  const replacement = 'https://ntfy.sh/crbuddy-replacement-secret-topic';
  const change = await f.run(['config', '--global'], {},
    [...editAnswers, '', '', replacement, ''].join('\n'));
  assert.equal(change.code, 0, change.stdout + change.stderr);
  assert.doesNotMatch(change.stdout + change.stderr, /crbuddy-(?:test|replacement)-secret-topic/);
  assert.equal(JSON.parse(await readFile(f.settingsFile, 'utf8')).notifications.endpoint, replacement);
  assert.deepEqual(change.posts, []);

  // Create a local review config; the same global preference is still edited.
  await f.saveConfig();
  const disable = await f.run(['config', '--project'], {},
    [...editAnswers, 'n', 'n', ''].join('\n')); // .gitignore, then notifications
  assert.equal(disable.code, 0, disable.stdout + disable.stderr);
  assert.doesNotMatch(disable.stdout + disable.stderr, /crbuddy-replacement-secret-topic/);
  assert.deepEqual(JSON.parse(await readFile(f.settingsFile, 'utf8')), {});
  assert.deepEqual(disable.posts, []);
  assert.equal(existsSync(path.join(f.repo, '.crbuddy', 'settings.json')), false);
});

test('piped setup EOF at the new questions cancels without partially saving either config', async (t) => {
  const f = await fixture(t);
  await rm(f.configFile);
  const globalConfig = path.join(f.userDir, '.crbuddy', 'config.json');
  const reviewAnswers = ['', '', '', 'n', 'n', '', '', '1'];
  for (const notifications of [false, true]) {
    if (notifications) await writeFile(f.settingsFile, JSON.stringify(enabled));
    else await rm(f.settingsFile, { force: true });
    for (const ending of notifications ? ['', '\n'] : ['']) {
      const result = await f.run(['init', '--global'], {}, reviewAnswers.join('\n') + ending);
      assert.equal(result.code, 130, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /No config was written/);
      assert.deepEqual(result.posts, []);
      assert.equal(existsSync(globalConfig), false);
      assert.equal(existsSync(f.settingsFile), notifications);
      if (notifications) assert.deepEqual(JSON.parse(await readFile(f.settingsFile, 'utf8')), enabled);
    }
  }
});

test('piped Codex model numbers match the documented choices, with Other last', async (t) => {
  const f = await fixture(t);
  await rm(f.configFile);
  const globalConfig = path.join(f.userDir, '.crbuddy', 'config.json');
  for (const [answers, model] of [
    [['1'], 'gpt-6-astra'],
    [['2'], 'gpt-6-sol'],
    [['3'], 'gpt-6-luna'],
    [['4', 'my-custom-model'], 'my-custom-model'],
  ] as const) {
    await rm(globalConfig, { force: true });
    const result = await f.run(['init', '--global'], {},
      ['', ...answers, '', 'n', 'n', '', '', '', 'n'].join('\n'));
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(await readFile(globalConfig, 'utf8')).panel[0].model, model);
    assert.deepEqual(result.posts, []);
  }
});

