// Sound, frames, then ffmpeg: out/crbuddy-promo.mp4.

import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpeg from 'ffmpeg-static';
import { FPS } from './timeline.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const name = args.includes('--name') ? args[args.indexOf('--name') + 1] : 'crbuddy-promo';
if (!name || name.startsWith('--')) throw new Error('--name needs a file name, e.g. --name crbuddy-promo-2');
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });

run(process.execPath, ['audio.mjs']);
run(process.execPath, ['render.mjs']);

const output = path.join(root, 'out', `${name}.mp4`);
run(ffmpeg, [
  '-y', '-loglevel', 'error', '-stats',
  '-framerate', String(FPS), '-i', 'frames/%05d.jpg',
  '-i', 'out/audio.wav',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k',
  '-shortest', '-movflags', '+faststart',
  output,
]);

if (!args.includes('--keep-frames')) rmSync(path.join(root, 'frames'), { recursive: true, force: true });
console.log(`\n${output}`);
