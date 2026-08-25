import { chmod, readFile, writeFile } from 'node:fs/promises';

const entry = new URL('../dist/index.js', import.meta.url);
const source = await readFile(entry, 'utf8');

if (!source.startsWith('#!')) {
  await writeFile(entry, `#!/usr/bin/env node\n${source}`);
}

await chmod(entry, 0o755);
