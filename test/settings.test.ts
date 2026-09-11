import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { isNtfyEndpoint, loadGlobalSettings, saveGlobalSettings } from '../src/config/settings.js';

test('ntfy validation parses a hosted HTTPS URL with a topic', () => {
  for (const endpoint of [
    'https://ntfy.sh/a',
    'https://ntfy.sh/Crbuddy-long_random-123',
    `https://ntfy.sh/${'x'.repeat(64)}`,
  ]) assert.equal(isNtfyEndpoint(endpoint), true, endpoint);
});

test('ntfy validation refuses malformed, non-hosted and non-topic URLs', () => {
  for (const endpoint of [
    '', 'not a URL', 'ntfy.sh/topic', '//ntfy.sh/topic',
    'http://ntfy.sh/topic', 'ftp://ntfy.sh/topic',
    'https://example.com/topic', 'https://ntfy.sh.example.com/topic',
    'https://ntfy.sh', 'https://ntfy.sh/', 'https://ntfy.sh//',
    'https://user:password@ntfy.sh/topic', 'https://user@ntfy.sh/topic',
    'https://ntfy.sh:444/topic', 'https://ntfy.sh/topic/extra',
    'https://ntfy.sh/topic?delay=1h', 'https://ntfy.sh/topic#fragment',
    'https://ntfy.sh/%20', 'https://ntfy.sh/%2F', 'https://ntfy.sh/topic with spaces',
    `https://ntfy.sh/${'x'.repeat(65)}`,
  ]) assert.equal(isNtfyEndpoint(endpoint), false, endpoint);
});

test('missing or malformed global settings disable notifications without leaking data', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-settings-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  assert.deepEqual(await loadGlobalSettings(warn, file), {});
  assert.equal(warnings.length, 0);

  for (const contents of [
    'invalid secret-topic', 'null', '[]', '42',
    '{"notifications":null}', '{"notifications":{}}',
    '{"notifications":{"provider":"other","endpoint":"secret-topic"}}',
    '{"notifications":{"provider":"ntfy","endpoint":"https://example.com/secret-topic"}}',
  ]) {
    await writeFile(file, contents);
    assert.deepEqual(await loadGlobalSettings(warn, file), {});
    assert.match(warnings.at(-1)!, /disabled.*crb config/);
    assert.doesNotMatch(warnings.at(-1)!, /secret-topic|example\.com/);
  }
  assert.equal(warnings.length, 8);
});

test('global settings round-trip and disabling removes the saved endpoint', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-settings-save-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, '.crbuddy', 'settings.json');
  const settings = { notifications: { provider: 'ntfy' as const, endpoint: 'https://ntfy.sh/secret-topic' } };
  await saveGlobalSettings(settings, file);
  assert.deepEqual(await loadGlobalSettings(undefined, file), settings);
  await saveGlobalSettings({}, file);
  assert.deepEqual(await loadGlobalSettings(undefined, file), {});
  assert.doesNotMatch(await readFile(file, 'utf8'), /secret-topic|endpoint/);
});

test('saving replaces permissive settings with a private file', {
  skip: process.platform === 'win32' ? 'POSIX file modes do not apply on Windows' : false,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-settings-mode-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  await writeFile(file, '{}');
  await chmod(file, 0o644);
  const settings = { notifications: { provider: 'ntfy' as const, endpoint: 'https://ntfy.sh/secret-topic' } };
  await saveGlobalSettings(settings, file);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await loadGlobalSettings(undefined, file), settings);
  assert.deepEqual(await readdir(root), ['settings.json']);
});

test('a failed settings replacement preserves the destination and cleans the private temporary file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'crbuddy-settings-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  await mkdir(file);
  await writeFile(path.join(file, 'sentinel'), 'keep');
  await assert.rejects(saveGlobalSettings({
    notifications: { provider: 'ntfy', endpoint: 'https://ntfy.sh/secret-topic' },
  }, file), { message: 'Could not save global notification settings to ~/.crbuddy/settings.json.' });
  assert.equal(await readFile(path.join(file, 'sentinel'), 'utf8'), 'keep');
  assert.deepEqual(await readdir(root), ['settings.json']);
});
