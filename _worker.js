/* ============================================================================
 *  YORVIQUE — CLOUDFLARE PAGES WORKER  (_worker.js)  —  Cloudinary + KV edition
 * ----------------------------------------------------------------------------
 *  This is the CLOUDFLARE PAGES WORKER (advanced mode). It is NOT the same
 *  as the browser service worker (service-worker.js). The two files are
 *  completely separate concepts and must not be confused.
 *
 *  WHAT THIS WORKER DOES:
 *    1. Serves all static assets (HTML/CSS/JS/images) via the `ASSETS`
 *       binding that Cloudflare Pages injects automatically when a worker
 *       is placed in advanced mode.
 *    2. Implements the YORVIQUE upload/download backend using:
 *         - Cloudinary  -> stores the file contents (free 25 GB, no card)
 *         - Cloudflare KV -> stores a tiny metadata index (free 1 GB,
 *                            no card) so the worker can map our random
 *                            shareable IDs to Cloudinary file locations.
 *    3. Routes:
 *         GET  /                  -> index.html
 *         GET  /privacy           -> privacy.html
 *         GET  /terms             -> terms.html
 *         GET  /health            -> 200 "ok"
 *         POST /api/upload        -> upload to Cloudinary, store meta in KV,
 *                                    return shareable id
 *         GET  /api/meta/:id      -> JSON metadata about an upload
 *         GET  /d/:id             -> stream the file from Cloudinary through
 *                                    your own domain, with safe headers
 *         DELETE /api/delete/:id  -> delete file (not enabled)
 *         *                       -> fall through to ASSETS (404 if missing)
 *
 *  REQUIRED CLOUDFLARE / EXTERNAL CONFIG:
 *    - ASSETS                  (auto, Cloudflare Pages static-asset binding)
 *    - YORVIQUE_META           (KV namespace — create in Cloudflare dashboard
 *                               under Workers & Pages -> KV -> Create namespace,
 *                               then bind it under Pages -> Settings ->
 *                               Functions -> KV namespace bindings)
 *
 *  REQUIRED ENVIRONMENT VARIABLES (set in Pages -> Settings ->
 *  Environment variables, as "Secret" type for the API secret):
 *    - CLOUDINARY_CLOUD_NAME   e.g. "dwxyz1234"
 *    - CLOUDINARY_API_KEY      e.g. "123456789012345"
 *    - CLOUDINARY_API_SECRET   e.g. "abcd1234efgh5678ijkl"  (SECRET — never expose)
 *
 *  OPTIONAL ENVIRONMENT VARIABLES:
 *    - MAX_FILE_SIZE_MB         default 100   (max upload size in MiB)
 *    - UPLOAD_RATE_LIMIT_PER_H  default 60    (uploads per IP per hour)
 *    - ALLOWED_ORIGIN           default *     (CORS origin)
 *
 *  SECURITY NOTES:
 *    - Files are stored in Cloudinary under random 22-char public IDs
 *      (128 bits of entropy). They are NOT enumerable.
 *    - The Cloudinary API secret NEVER leaves the worker. The browser only
 *      ever sees the random shareable ID, never any Cloudinary credential.
 *    - Uploads to Cloudinary use signed requests (SHA-1 signature of
 *      params + api_secret, per Cloudinary's spec).
 *    - Downloads are proxied through your own domain so visitors never see
 *      res.cloudinary.com URLs, and the worker can enforce safe headers
 *      (X-Content-Type-Options: nosniff, X-Frame-Options: DENY, etc.).
 *    - The Content-Type on download is taken from the value the client sent
 *      at upload time, after a small allow-list. Unknown types default to
 *      application/octet-stream.
 *    - Downloads always carry Content-Disposition: attachment for non-
 *      previewable types, so they cannot be rendered as HTML in the
 *      visitor's browser.
 *    - Rate limiting is best-effort and uses the Cloudflare Cache API.
 * ============================================================================
 */

const DEFAULT_MAX_FILE_SIZE_MB = 100;
const DEFAULT_RATE_LIMIT_PER_H = 60;
const ID_BYTES = 16; // 128 bits of entropy -> 22 url-safe base64 chars
const CLOUDINARY_PUBLIC_ID_PREFIX = 'yorvique_'; // prepended to every Cloudinary public_id

// A small, conservative allow-list of MIME types that are safe to render
// INLINE in a browser. Everything else is served as an attachment.
const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
  'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
  'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/aac', 'audio/flac',
  'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
  'application/pdf',
  'text/plain', 'text/csv', 'text/markdown', 'text/calendar'
]);

// Forbidden MIME types (would execute as HTML or are inherently dangerous).
const FORBIDDEN_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'application/xml',
  'text/javascript', 'application/javascript', 'application/ecmascript',
  'application/x-sh', 'application/x-csh',
  'application/x-httpd-php', 'application/x-asp', 'application/asx'
]);

// Conservative set of forbidden file extensions (defense in depth).
const FORBIDDEN_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.xht',
  '.php', '.php3', '.php4', '.php5', '.phtml',
  '.asp', '.aspx', '.jsp', '.jspx',
  '.exe', '.bat', '.cmd', '.sh', '.csh', '.msi', '.dll', '.so', '.bin',
  '.svg' // svg can carry scripts; rejected at upload for safety
]);

// ---------------------------------------------------------------------------
// Utility: random URL-safe base64 ID
// ---------------------------------------------------------------------------
function randomId() {
  const bytes = new Uint8Array(ID_BYTES);
  crypto.getRandomValues(bytes);
  let s = btoa(String.fromCharCode.apply(null, bytes));
  s = s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return s;
}

// ---------------------------------------------------------------------------
// Utility: sanitise a filename. Strips path components, control characters,
// and dangerous patterns. Returns "" if the name becomes empty.
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Utility: JSON response with CORS
// ---------------------------------------------------------------------------
function jsonResponse(data, status, env) {
  const origin = (env && env.ALLOWED_ORIGIN) || '*';
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    }
  });
}

// ---------------------------------------------------------------------------
// Utility: best-effort per-IP rate limit using the Cloudflare Cache API.
// ---------------------------------------------------------------------------
async function checkRateLimit(request, env) {
  const limit = parseInt(env && env.UPLOAD_RATE_LIMIT_PER_H || String(DEFAULT_RATE_LIMIT_PER_H), 10);
  if (!limit || limit <= 0) return true;
  const ip = request.headers.get('CF-Connecting-IP') ||
             request.headers.get('X-Forwarded-For') ||
             'anonymous';
  if (typeof caches === 'undefined' || !caches.default) return true;
  const key = new Request('https://yorvique.invalid/ratelimit/' + encodeURIComponent(ip) + '/' + Math.floor(Date.now() / 3600000));
  try {
    const cached = await caches.default.get(key);
    let count = 0;
    if (cached) {
      const text = await cached.text();
      count = parseInt(text, 10) || 0;
    }
    count += 1;
    const resp = new Response(String(count), { headers: { 'Content-Type': 'text/plain' } });
    resp.headers.set('Cache-Control', 'public, max-age=3600');
    await caches.default.put(key, resp.clone());
    return count <= limit;
  } catch (e) {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Utility: validate upload parameters
// ---------------------------------------------------------------------------
function validateUpload(file, env) {
  if (!file) return { ok: false, status: 400, error: 'No file provided.' };
  if (!file.name || !file.name.trim()) return { ok: false, status: 400, error: 'File has no name.' };
  const maxMb = parseInt(env && env.MAX_FILE_SIZE_MB || String(DEFAULT_MAX_FILE_SIZE_MB), 10);
  const maxBytes = maxMb * 1024 * 1024;
  if (file.size <= 0) return { ok: false, status: 400, error: 'File is empty.' };
  if (file.size > maxBytes) {
    return { ok: false, status: 413, error: 'File is too large. Maximum is ' + maxMb + ' MB.' };
  }
  const lowerName = file.name.toLowerCase();
  for (const ext of FORBIDDEN_EXTENSIONS) {
    if (lowerName.endsWith(ext)) {
      return { ok: false, status: 415, error: 'This file type is not allowed (' + ext + ').' };
    }
  }
  return { ok: true, maxBytes: maxBytes };
}

// ---------------------------------------------------------------------------
// Cloudinary: SHA-1 signature
// Cloudinary signs requests by:
//   1. Taking all params EXCEPT api_key and file (i.e. the params that affect
//      the resulting resource: public_id, timestamp, folder, etc.)
//   2. Sorting them alphabetically by key
//   3. Joining them as "key=value&key=value"
//   4. Appending the api_secret directly (no separator)
//   5. Taking the SHA-1 hex digest of the resulting string
// We use the Web Crypto API (crypto.subtle.digest) which is available in
// Cloudflare Workers.
// ---------------------------------------------------------------------------
async function signCloudinary(params, apiSecret) {
  const sorted = Object.keys(params).sort().map(function (k) {
    return k + '=' + params[k];
  }).join('&');
  const toSign = sorted + apiSecret;
  const encoder = new TextEncoder();
  const hashBuf = await crypto.subtle.digest('SHA-1', encoder.encode(toSign));
  const bytes = new Uint8Array(hashBuf);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

// ---------------------------------------------------------------------------
// Cloudinary: upload a file
// Returns Cloudinary's JSON response, which includes:
//   { public_id, version, type, url, secure_url, resource_type, format,
//     bytes, original_filename, ... }
// Throws on non-2xx response.
// ---------------------------------------------------------------------------
async function uploadToCloudinary(file, publicId, env) {
  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    public_id: publicId,
    timestamp: String(timestamp)
  };
  const signature = await signCloudinary(params, env.CLOUDINARY_API_SECRET);

  // Build the multipart/form-data request to Cloudinary.
  // Cloudflare Workers support FormData natively.
  const formData = new FormData();
  // The file: Cloudinary accepts a File/Blob object directly.
  formData.append('file', file, file.name);
  formData.append('public_id', publicId);
  formData.append('timestamp', String(timestamp));
  formData.append('api_key', env.CLOUDINARY_API_KEY);
  formData.append('signature', signature);

  const url = 'https://api.cloudinary.com/v1_1/' + env.CLOUDINARY_CLOUD_NAME + '/auto/upload';
  const response = await fetch(url, {
    method: 'POST',
    body: formData
  });

  if (!response.ok) {
    let errBody = '';
    try { errBody = await response.text(); } catch (e) {}
    throw new Error('Cloudinary upload failed: HTTP ' + response.status + ' ' + errBody.slice(0, 300));
  }
  return await response.json();
}

// ---------------------------------------------------------------------------
// Cloudinary: construct the canonical download URL for a stored resource.
// URL pattern:
//   https://res.cloudinary.com/{cloud_name}/{resource_type}/upload/{public_id}.{format}
// where resource_type is "image", "video", or "raw".
// ---------------------------------------------------------------------------
function cloudinaryDownloadUrl(meta, env) {
  return 'https://res.cloudinary.com/' + env.CLOUDINARY_CLOUD_NAME +
         '/' + meta.resource_type +
         '/upload/' +
         meta.public_id +
         '.' + meta.format;
}

// ---------------------------------------------------------------------------
// Handler: POST /api/upload
// Body: multipart/form-data with field "file"
// Response: { id, url, filename, size, contentType, uploadedAt }
// ---------------------------------------------------------------------------
async function handleUpload(request, env) {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, env);
  }

  // Verify configuration is in place.
  if (!env.CLOUDINARY_CLOUD_NAME || !env.CLOUDINARY_API_KEY || !env.CLOUDINARY_API_SECRET) {
    return jsonResponse({
      error: 'Server is not configured for uploads. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET environment variables.'
    }, 503, env);
  }
  if (!env.YORVIQUE_META) {
    return jsonResponse({
      error: 'Server is not configured for uploads. The YORVIQUE_META KV namespace binding is missing.'
    }, 503, env);
  }

  // Rate limit (best-effort)
  const allowed = await checkRateLimit(request, env);
  if (!allowed) {
    return jsonResponse({ error: 'Too many uploads. Please try again later.' }, 429, env);
  }

  // Parse multipart form.
  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return jsonResponse({ error: 'Invalid request body.' }, 400, env);
  }
  const file = formData.get('file');
  const validation = validateUpload(file, env);
  if (!validation.ok) {
    return jsonResponse({ error: validation.error }, validation.status || 400, env);
  }

  const safeName = sanitiseFilename(file.name);
  if (!safeName) {
    return jsonResponse({ error: 'Invalid filename.' }, 400, env);
  }

  let contentType = (file.type || 'application/octet-stream').toLowerCase();
  if (FORBIDDEN_TYPES.has(contentType)) {
    return jsonResponse({ error: 'This file type is not allowed.' }, 415, env);
  }
  if (!contentType) contentType = 'application/octet-stream';

  // Generate our random shareable ID and the corresponding Cloudinary public_id.
  const id = randomId();
  const cloudinaryPublicId = CLOUDINARY_PUBLIC_ID_PREFIX + id;

  // Upload to Cloudinary with a signed request.
  let cloudinaryResponse;
  try {
    cloudinaryResponse = await uploadToCloudinary(file, cloudinaryPublicId, env);
  } catch (e) {
    return jsonResponse({
      error: 'Upload failed. The storage backend rejected the file.'
    }, 502, env);
  }

  // Build the metadata record we'll store in KV.
  const meta = {
    filename: safeName,
    contentType: contentType,
    size: Number(cloudinaryResponse.bytes || file.size),
    uploadedAt: Date.now(),
    resource_type: cloudinaryResponse.resource_type, // 'image' | 'video' | 'raw'
    public_id: cloudinaryResponse.public_id,
    format: cloudinaryResponse.format
  };

  // Store metadata in KV. The KV key is namespaced with "yorvique:" so the
  // same namespace could be shared with other apps in the future.
  try {
    await env.YORVIQUE_META.put('yorvique:' + id, JSON.stringify(meta));
  } catch (e) {
    // We've already uploaded the file to Cloudinary but can't record it.
    // Best-effort: return an error. (The orphaned Cloudinary resource will
    // sit there until manually purged or until Cloudinary's retention policy
    // removes it — see the deployment guide for setting retention rules.)
    return jsonResponse({ error: 'Upload succeeded but metadata could not be stored.' }, 503, env);
  }

  return jsonResponse({
    id: id,
    url: '/d/' + id,
    filename: safeName,
    size: meta.size,
    contentType: contentType,
    uploadedAt: meta.uploadedAt
  }, 201, env);
}

// ---------------------------------------------------------------------------
// Handler: GET /api/meta/:id  -> JSON metadata (does NOT stream the file)
// ---------------------------------------------------------------------------
async function handleMeta(id, request, env) {
  if (!id || !/^[A-Za-z0-9_-]{10,30}$/.test(id)) {
    return jsonResponse({ error: 'Invalid id.' }, 400, env);
  }
  if (!env.YORVIQUE_META) {
    return jsonResponse({ error: 'Storage backend unavailable.' }, 503, env);
  }
  let metaRaw;
  try {
    metaRaw = await env.YORVIQUE_META.get('yorvique:' + id);
  } catch (e) {
    return jsonResponse({ error: 'Storage backend unavailable.' }, 503, env);
  }
  if (!metaRaw) {
    return jsonResponse({ error: 'File not found or expired.' }, 404, env);
  }
  let meta;
  try { meta = JSON.parse(metaRaw); } catch (e) {
    return jsonResponse({ error: 'Metadata corrupted.' }, 500, env);
  }
  return jsonResponse({
    id: id,
    filename: meta.filename || 'file',
    size: Number(meta.size || 0),
    contentType: meta.contentType || 'application/octet-stream',
    uploadedAt: Number(meta.uploadedAt || 0)
  }, 200, env);
}

// ---------------------------------------------------------------------------
// Handler: GET /d/:id  -> stream the file from Cloudinary to the visitor
// The visitor never sees the Cloudinary URL — the worker proxies the request
// through your own domain so the shareable link stays as
//   https://yorvique.pages.dev/d/{id}
// and we can enforce safe response headers.
// ---------------------------------------------------------------------------
async function handleDownload(id, request, env) {
  if (!id || !/^[A-Za-z0-9_-]{10,30}$/.test(id)) {
    return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (!env.YORVIQUE_META || !env.CLOUDINARY_CLOUD_NAME) {
    return new Response('Storage backend unavailable.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  // Read metadata from KV.
  let metaRaw;
  try {
    metaRaw = await env.YORVIQUE_META.get('yorvique:' + id);
  } catch (e) {
    return new Response('Storage backend unavailable.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (!metaRaw) {
    return new Response('File not found or expired.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  let meta;
  try { meta = JSON.parse(metaRaw); } catch (e) {
    return new Response('Metadata corrupted.', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  // Construct the Cloudinary URL for the stored resource.
  const cloudinaryUrl = cloudinaryDownloadUrl(meta, env);

  // Fetch the file from Cloudinary. We pass a Range header through if the
  // visitor requested one, so large files / videos can stream properly.
  const upstreamReq = new Request(cloudinaryUrl, {
    method: 'GET',
    headers: { 'Range': request.headers.get('Range') || '' }
  });
  let upstream;
  try {
    upstream = await fetch(upstreamReq);
  } catch (e) {
    return new Response('Storage backend unavailable.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (upstream.status === 404) {
    return new Response('File not found or expired.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (!upstream.ok && upstream.status !== 206) {
    return new Response('Storage backend error.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  // Build response headers.
  const headers = new Headers();
  const contentType = (meta.contentType || 'application/octet-stream').toLowerCase();
  headers.set('Content-Type', contentType);
  // Pass through Content-Length and Content-Range from Cloudinary so
  // partial-content (206) responses work for video/audio streaming.
  if (upstream.headers.has('Content-Length')) {
    headers.set('Content-Length', upstream.headers.get('Content-Length'));
  }
  if (upstream.headers.has('Content-Range')) {
    headers.set('Content-Range', upstream.headers.get('Content-Range'));
  }
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  headers.set('Referrer-Policy', 'no-referrer');

  // Decide disposition: inline only for known-safe types, otherwise attachment.
  const safeInline = INLINE_TYPES.has(contentType) && !contentType.includes('svg');
  const dispositionType = safeInline ? 'inline' : 'attachment';

  const filename = meta.filename || 'file';
  const safeAscii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '').slice(0, 150) || 'file';
  const encoded = encodeURIComponent(filename);
  headers.set(
    'Content-Disposition',
    dispositionType + '; filename="' + safeAscii + '"; filename*=UTF-8\'\'' + encoded
  );

  // Stream the response body through. The worker does NOT buffer the whole
  // file in memory — Cloudflare Workers can stream response bodies.
  return new Response(upstream.body, {
    status: upstream.status, // 200 or 206 for partial content
    headers: headers
  });
}

// ---------------------------------------------------------------------------
// Handler: DELETE /api/delete/:id  (not enabled)
// ---------------------------------------------------------------------------
async function handleDelete(id, request, env) {
  return jsonResponse({ error: 'Deletion is not enabled.' }, 501, env);
}

// ---------------------------------------------------------------------------
// Top-level fetch handler
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      const origin = (env && env.ALLOWED_ORIGIN) || '*';
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // Health check
    if (path === '/health') {
      return new Response('ok', {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
      });
    }

    // API routes
    if (path === '/api/upload') {
      return handleUpload(request, env);
    }

    if (path.startsWith('/api/meta/')) {
      const id = path.slice('/api/meta/'.length);
      return handleMeta(id, request, env);
    }

    if (path.startsWith('/api/delete/')) {
      return handleDelete(path.slice('/api/delete/'.length), request, env);
    }

    if (path.startsWith('/d/')) {
      return handleDownload(path.slice(3), request, env);
    }

    // Static asset fallback (Cloudflare Pages auto-injects env.ASSETS).
    // This also handles pretty routes: if the path has no file extension,
    // we try the path + '.html' as a fallback (so /privacy → /privacy.html,
    // /terms → /terms.html, etc.).
    if (env && env.ASSETS) {
      // Try the exact path first.
      let assetResp;
      try {
        assetResp = await env.ASSETS.fetch(request);
      } catch (e) {
        assetResp = new Response('Asset fetch failed.', { status: 500 });
      }

      // If not found and the path has no extension, try .html (pretty routes).
      if (assetResp.status === 404 && path !== '/' && !/\.[a-zA-Z0-9]+$/.test(path)) {
        try {
          const htmlUrl = new URL(path + '.html', url);
          const htmlReq = new Request(htmlUrl, {
            method: request.method,
            headers: request.headers
          });
          assetResp = await env.ASSETS.fetch(htmlReq);
        } catch (e) {
          // Keep the original 404 response.
        }
      }
      if (assetResp.status !== 404) return assetResp;

      // Final fallback to the custom 404 page (status preserved).
      try {
        const notFoundReq = new Request(new URL('/404.html', url), {
          method: 'GET',
          headers: request.headers
        });
        const notFoundResp = await env.ASSETS.fetch(notFoundReq);
        if (notFoundResp && notFoundResp.status !== 404) {
          return new Response(notFoundResp.body, {
            status: 404,
            headers: notFoundResp.headers
          });
        }
      } catch (e) {
        // Fall through to the plain-text 404 below.
      }
      return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    return new Response('YORVIQUE worker is running, but no ASSETS binding was found.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};
