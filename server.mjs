/**
 * ============================================================================
 *  YORVIQUE — LOCAL DEVELOPMENT SERVER (Node.js)
 * ----------------------------------------------------------------------------
 *  This server is for LOCAL DEVELOPMENT ONLY. It mirrors the same API
 *  contract as the Cloudflare _worker.js so you can run and test the entire
 *  upload-to-download flow on your own machine before deploying.
 *
 *  In production, this file is NOT used — Cloudflare Pages uses _worker.js.
 *
 *  USAGE:
 *      node server.mjs              # serves on http://localhost:3000
 *      PORT=4000 node server.mjs    # serves on http://localhost:4000
 *
 *  Uploaded files are stored under ./uploads/ (created automatically).
 *  Each upload is written as ./uploads/<id>.bin plus a ./uploads/<id>.meta
 *  JSON sidecar that holds the original filename, size, and content type.
 *
 *  NOTE: This is a minimal development server. It is not designed to be
 *  run as a public-facing production server. Use Cloudflare Pages with
 *  _worker.js for production.
 * ============================================================================
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const uploadsDir = path.join(root, 'uploads');

const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '100', 10);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Make sure the uploads directory exists.
await mkdir(uploadsDir, { recursive: true });

const pageRoutes = new Map([
  ['/', 'index.html'],
  ['/privacy', 'privacy.html'],
  ['/privacy.html', 'privacy.html'],
  ['/terms', 'terms.html'],
  ['/terms.html', 'terms.html']
]);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
  'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
  'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/aac', 'audio/flac',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown', 'text/calendar'
]);

const FORBIDDEN_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'application/xml',
  'text/javascript', 'application/javascript', 'application/ecmascript',
  'application/x-sh', 'application/x-csh',
  'application/x-httpd-php', 'application/x-asp', 'application/asx'
]);

const FORBIDDEN_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.xht',
  '.php', '.php3', '.php4', '.php5', '.phtml',
  '.asp', '.aspx', '.jsp', '.jspx',
  '.exe', '.bat', '.cmd', '.sh', '.csh', '.msi', '.dll', '.so', '.bin',
  '.svg'
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const relative = decoded.replace(/^\/+/, '');
  const candidate = path.normalize(path.join(root, relative));
  return candidate.startsWith(root) ? candidate : null;
}

function randomId() {
  return crypto.randomBytes(16).toString('base64url');
}

function sanitiseFilename(name) {
  if (!name) return '';
  let n = name;
  try { n = decodeURIComponent(n); } catch (e) {}
  n = n.replace(/\\/g, '/').split('/').pop() || '';
  n = n.replace(/[\x00-\x1f\x7f]/g, '');
  n = n.replace(/\.{2,}/g, '.');
  n = n.replace(/^[\s.]+/, '');
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}

function jsonResponse(res, data, status, extraHeaders) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status || 200, headers);
  res.end(JSON.stringify(data));
}

async function sendFile(res, filename, status) {
  const ext = path.extname(filename).toLowerCase();
  try {
    const body = await readFile(filename);
    res.writeHead(status || 200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('YORVIQUE local server error.');
  }
}

// ---------------------------------------------------------------------------
// Multipart parser (form-data). Node's http module does not include one, so
// we parse the boundary manually. We only extract the first file field.
// ---------------------------------------------------------------------------
function parseMultipart(contentType, bodyBuffer) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) return { error: 'No boundary.' };
  const boundary = '--' + (match[1] || match[2]);
  const sep = Buffer.from(boundary);
  const parts = [];
  let start = 0;
  while (true) {
    const idx = bodyBuffer.indexOf(sep, start);
    if (idx === -1) break;
    const next = bodyBuffer.indexOf(sep, idx + sep.length);
    if (next === -1) break;
    // Part content lives BETWEEN two boundary markers (excluding the boundary
    // strings themselves). This works whether idx is 0 (first part) or not.
    parts.push(bodyBuffer.slice(idx + sep.length, next));
    start = next;
    // Stop if the next boundary is the closing marker (--boundary--).
    if (bodyBuffer.slice(next, next + sep.length + 2).toString() === boundary + '--') break;
  }
  for (const part of parts) {
    // Each part: \r\n<headers>\r\n\r\n<content>\r\n
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) continue;
    const headerStr = part.slice(0, headerEnd).toString('utf8');
    const content = part.slice(headerEnd + 4, part.length - 2); // strip trailing \r\n
    const cdMatch = /Content-Disposition:\s*form-data;[^\r\n]*/i.exec(headerStr);
    if (!cdMatch) continue;
    const nameMatch = /name="([^"]+)"/.exec(cdMatch[0]);
    const fileMatch = /filename="([^"]*)"/.exec(cdMatch[0]);
    if (!nameMatch) continue;
    const fieldName = nameMatch[1];
    if (fileMatch) {
      const filename = fileMatch[1];
      const ctMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerStr);
      const contentType = ctMatch ? ctMatch[1].trim() : 'application/octet-stream';
      return { field: fieldName, filename: filename, contentType: contentType, content: content };
    }
  }
  return { error: 'No file field.' };
}

// ---------------------------------------------------------------------------
// Upload handler
// ---------------------------------------------------------------------------
async function handleUpload(req, res) {
  if (req.method !== 'POST') {
    return jsonResponse(res, { error: 'Method not allowed.' }, 405);
  }
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return jsonResponse(res, { error: 'Expected multipart/form-data.' }, 400);
  }
  // Read the entire body. (Local dev only — production uses R2 streaming.)
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  // Reject oversized bodies.
  if (body.length > MAX_FILE_SIZE_BYTES + 1024 * 64) { // small overhead tolerance
    return jsonResponse(res, { error: 'File is too large. Maximum is ' + MAX_FILE_SIZE_MB + ' MB.' }, 413);
  }
  const parsed = parseMultipart(contentType, body);
  if (parsed.error) {
    return jsonResponse(res, { error: parsed.error }, 400);
  }
  const file = {
    name: parsed.filename,
    size: parsed.content.length,
    type: parsed.contentType,
    content: parsed.content
  };
  if (!file.name || !file.name.trim()) {
    return jsonResponse(res, { error: 'File has no name.' }, 400);
  }
  if (file.size <= 0) {
    return jsonResponse(res, { error: 'File is empty.' }, 400);
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return jsonResponse(res, { error: 'File is too large. Maximum is ' + MAX_FILE_SIZE_MB + ' MB.' }, 413);
  }
  const lowerName = file.name.toLowerCase();
  for (const ext of FORBIDDEN_EXTENSIONS) {
    if (lowerName.endsWith(ext)) {
      return jsonResponse(res, { error: 'This file type is not allowed (' + ext + ').' }, 415);
    }
  }
  let contentTypeNorm = (file.type || 'application/octet-stream').toLowerCase();
  if (FORBIDDEN_TYPES.has(contentTypeNorm)) {
    return jsonResponse(res, { error: 'This file type is not allowed.' }, 415);
  }
  if (!contentTypeNorm) contentTypeNorm = 'application/octet-stream';
  const safeName = sanitiseFilename(file.name);
  if (!safeName) {
    return jsonResponse(res, { error: 'Invalid filename.' }, 400);
  }
  const id = randomId();
  const binPath = path.join(uploadsDir, id + '.bin');
  const metaPath = path.join(uploadsDir, id + '.meta');
  await writeFile(binPath, file.content);
  const meta = {
    originalFilename: safeName,
    contentType: contentTypeNorm,
    fileSize: String(file.size),
    uploadedAt: String(Date.now())
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
  return jsonResponse(res, {
    id: id,
    url: '/d/' + id,
    filename: safeName,
    size: file.size,
    contentType: contentTypeNorm,
    uploadedAt: Number(meta.uploadedAt)
  }, 201);
}

// ---------------------------------------------------------------------------
// Download handler
// ---------------------------------------------------------------------------
async function handleDownload(id, res) {
  if (!id || !/^[A-Za-z0-9_-]{10,30}$/.test(id)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found.');
    return;
  }
  const binPath = path.join(uploadsDir, id + '.bin');
  const metaPath = path.join(uploadsDir, id + '.meta');
  if (!existsSync(binPath) || !existsSync(metaPath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('File not found or expired.');
    return;
  }
  let meta;
  try {
    meta = JSON.parse(await readFile(metaPath, 'utf8'));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Metadata corrupted.');
    return;
  }
  const stats = await stat(binPath);
  const filename = meta.originalFilename || 'file';
  const ct = (meta.contentType || 'application/octet-stream').toLowerCase();
  const safeInline = INLINE_TYPES.has(ct) && !ct.includes('svg');
  const disposition = safeInline ? 'inline' : 'attachment';
  const safeAscii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '').slice(0, 150) || 'file';
  const encoded = encodeURIComponent(filename);
  res.writeHead(200, {
    'Content-Type': ct,
    'Content-Length': String(stats.size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'Content-Disposition': disposition + '; filename="' + safeAscii + '"; filename*=UTF-8\'\'' + encoded
  });
  createReadStream(binPath).pipe(res);
}

// ---------------------------------------------------------------------------
// Meta handler
// ---------------------------------------------------------------------------
async function handleMeta(id, res) {
  if (!id || !/^[A-Za-z0-9_-]{10,30}$/.test(id)) {
    return jsonResponse(res, { error: 'Invalid id.' }, 400);
  }
  const metaPath = path.join(uploadsDir, id + '.meta');
  const binPath = path.join(uploadsDir, id + '.bin');
  if (!existsSync(metaPath) || !existsSync(binPath)) {
    return jsonResponse(res, { error: 'File not found or expired.' }, 404);
  }
  const meta = JSON.parse(await readFile(metaPath, 'utf8'));
  const stats = await stat(binPath);
  return jsonResponse(res, {
    id: id,
    filename: meta.originalFilename || 'file',
    size: Number(meta.fileSize || stats.size || 0),
    contentType: meta.contentType || 'application/octet-stream',
    uploadedAt: Number(meta.uploadedAt || 0)
  }, 200);
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (pathname === '/api/upload') return handleUpload(req, res);
  if (pathname.startsWith('/api/meta/')) return handleMeta(pathname.slice('/api/meta/'.length), res);
  if (pathname.startsWith('/api/delete/')) {
    return jsonResponse(res, { error: 'Deletion is not enabled.' }, 501);
  }
  if (pathname.startsWith('/d/')) return handleDownload(pathname.slice(3), res);

  // Pretty routes for legal pages
  const mapped = pageRoutes.get(pathname);
  if (mapped) {
    return sendFile(res, path.join(root, mapped));
  }

  // Static file
  const filename = safePath(pathname);
  if (filename) {
    try {
      const stats = await stat(filename);
      if (stats.isFile()) return sendFile(res, filename);
    } catch (e) {
      // fall through to 404
    }
  }

  // 404 page
  return sendFile(res, path.join(root, '404.html'), 404);
});

server.listen(port, '0.0.0.0', () => {
  console.log('YORVIQUE local dev server listening on http://0.0.0.0:' + port);
  console.log('Uploads are stored in: ' + uploadsDir);
  console.log('Max file size: ' + MAX_FILE_SIZE_MB + ' MB');
  console.log('Press Ctrl+C to stop.');
});
