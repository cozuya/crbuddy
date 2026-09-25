// A tiny static server for the promo directory. ES modules will not load
// from file:// URLs, so both the renderer and the preview go through this.

import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

export function startServer(port = 0) {
  const server = createServer((request, response) => {
    let pathname;

    try {
      pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    } catch {
      response.writeHead(400).end();
      return;
    }

    const file = path.join(root, pathname === '/' ? 'index.html' : pathname);
    const relative = path.relative(root, file);

    // Segment-wise, so a sibling such as `promo-old` is outside too.
    if (relative.split(path.sep)[0] === '..' || path.isAbsolute(relative)) {
      response.writeHead(403).end();
      return;
    }

    let stats;

    try {
      stats = statSync(file);
    } catch {
      stats = null;
    }

    if (!stats?.isFile()) {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, {
      'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      'content-length': stats.size,
      'cache-control': 'no-store',
    });
    createReadStream(file).on('error', () => response.destroy()).pipe(response);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer(Number(process.env.PORT ?? 4173));
  console.log(`Preview: http://localhost:${server.address().port}/  (space to pause, click for sound)`);
}
