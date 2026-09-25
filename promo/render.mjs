// Renders the page frame by frame with headless Chromium.
//
//   node render.mjs                 every frame into frames/
//   node render.mjs --stills 1,5.5  PNG stills into stills/, for checking

import { mkdirSync, rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { buildTimeline, FPS, HEIGHT, WIDTH } from './timeline.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const stillsArg = args.includes('--stills') ? args[args.indexOf('--stills') + 1] : null;
const workers = Number(process.env.WORKERS ?? Math.min(8, Math.max(1, availableParallelism() - 2)));

const server = await startServer();
const url = `http://127.0.0.1:${server.address().port}/index.html?capture`;
const browser = await chromium.launch({
  args: ['--font-render-hinting=none', '--disable-lcd-text', '--force-color-profile=srgb'],
});

async function openPage() {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => {
    console.error('page error:', error.message);
    process.exitCode = 1;
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 30_000 });
  return page;
}

async function frame(page, t, file, type) {
  await page.evaluate((time) => window.render(time), t);
  await page.screenshot({ path: file, type, ...(type === 'jpeg' ? { quality: 94 } : {}) });
}

try {
  if (stillsArg) {
    const dir = path.join(root, 'stills');
    mkdirSync(dir, { recursive: true });
    const page = await openPage();
    for (const t of stillsArg.split(',').map(Number)) {
      const file = path.join(dir, `${t.toFixed(2).padStart(6, '0')}.png`);
      await frame(page, t, file, 'png');
      console.log(file);
    }
  } else {
    const dir = path.join(root, 'frames');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const total = Math.ceil(buildTimeline().duration * FPS);
    const pages = await Promise.all(Array.from({ length: workers }, openPage));
    let next = 0;
    let done = 0;
    const started = Date.now();

    await Promise.all(pages.map(async (page) => {
      while (next < total) {
        const index = next++;
        await frame(page, index / FPS, path.join(dir, `${String(index).padStart(5, '0')}.jpg`), 'jpeg');
        done += 1;
        if (done % 240 === 0 || done === total) {
          const rate = done / ((Date.now() - started) / 1000);
          console.log(`frames ${done}/${total}  (${rate.toFixed(1)} fps)`);
        }
      }
    }));
  }
} finally {
  await browser.close();
  server.close();
}
