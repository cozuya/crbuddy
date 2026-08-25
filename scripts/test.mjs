import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = new URL('../dist-test/test/', import.meta.url);
const files = (await readdir(directory))
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map((file) => fileURLToPath(new URL(file, directory)));

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
