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
    const url = new URL(request.url, 'http://localhost');
    const file = path.join(root, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));

    if (!file.startsWith(root)) {
      response.writeHead(403).end();
      return;
    }

    try {
      const { size } = statSync(file);
      response.writeHead(200, {
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'content-length': size,
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startServer(Number(process.env.PORT ?? 4173));
  console.log(`Preview: http://localhost:${server.address().port}/  (space to pause, click for sound)`);
}
