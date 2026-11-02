import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const pageRoutes = new Map([
  ['/', 'index.html'],
  ['/privacy', 'privacy.html'],
  ['/terms', 'terms.html']
]);
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded.replace(/^\/+/, '');
  const candidate = path.normalize(path.join(root, relative));
  return candidate.startsWith(root) ? candidate : null;
}

async function sendFile(response, filename, status = 200) {
  const extension = path.extname(filename).toLowerCase();
  try {
    const body = await readFile(filename);
    response.writeHead(status, {
      'Content-Type': mimeTypes[extension] || 'application/octet-stream',
      'Cache-Control': extension === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    response.end(body);
  } catch {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('WebDrop Pro is temporarily unavailable.');
  }
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
    return;
  }

  if (pathname === '/favicon.ico') {
    await sendFile(response, path.join(root, 'favicon.svg'));
    return;
  }

  if (pathname === '/manus-routes.json') {
    await sendFile(response, path.join(root, 'public', 'manus-routes.json'));
    return;
  }

  const mappedPage = pageRoutes.get(pathname);
  if (mappedPage) {
    await sendFile(response, path.join(root, mappedPage));
    return;
  }

  const filename = safePath(pathname);
  if (filename) {
    try {
      const details = await stat(filename);
      if (details.isFile()) {
        await sendFile(response, filename);
        return;
      }
    } catch {
      // Fall through to the branded 404 page.
    }
  }

  await sendFile(response, path.join(root, '404.html'), 404);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`WebDrop Pro listening on http://0.0.0.0:${port}`);
});
