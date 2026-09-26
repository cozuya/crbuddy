// Removes build output before a build. tsc never deletes what it no longer
// emits, so files compiled from deleted sources lingered: they were tested
// (dist-test) and would have been packed and published (dist).
import { rm } from 'node:fs/promises';

for (const dir of process.argv.slice(2)) {
  await rm(new URL(`../${dir}/`, import.meta.url), { recursive: true, force: true });
}
