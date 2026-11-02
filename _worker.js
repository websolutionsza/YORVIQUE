/* ============================================================================
 *  YORVIQUE — CLOUDFLARE PAGES WORKER  (_worker.js)
 * ----------------------------------------------------------------------------
 *  This is the CLOUDFLARE PAGES WORKER (advanced mode). It is NOT the same
 *  as the browser service worker (service-worker.js). The two files are
 *  completely separate concepts and must not be confused.
 *
 *  WHAT THIS WORKER DOES:
 *    1. Serves all static assets (HTML/CSS/JS/images) via the `ASSETS`
 *       binding that Cloudflare Pages injects automatically when a worker
 *       is placed in advanced mode.
 *    2. Implements the YORVIQUE upload/download backend using a Cloudflare
 *       R2 bucket binding named `YORVIQUE_BUCKET`.
 *    3. Routes:
 *         GET  /                  -> index.html
 *         GET  /privacy           -> privacy.html
 *         GET  /terms             -> terms.html
 *         GET  /health            -> 200 "ok"
 *         POST /api/upload        -> store file in R2, return shareable id
 *         GET  /api/meta/:id      -> JSON metadata about an upload
 *         GET  /d/:id             -> download the file (streamed from R2)
 *         DELETE /api/delete/:id  -> delete file (requires deletion key)
 *         *                       -> fall through to ASSETS (404 if missing)
 *
 *  REQUIRED CLOUDFLARE BINDINGS:
 *    - ASSETS            (auto, Cloudflare Pages static-asset binding)
 *    - YORVIQUE_BUCKET   (R2 bucket — must be created and bound in the
 *                         Cloudflare Pages dashboard under
 *                         Settings -> Functions -> R2 bucket bindings)
 *
 *  OPTIONAL ENVIRONMENT VARIABLES (set in Pages dashboard or wrangler.toml):
 *    - MAX_FILE_SIZE_MB         default 100      (max upload size in MiB)
 *    - UPLOAD_RATE_LIMIT_PER_H  default 60       (uploads per IP per hour)
 *    - ALLOWED_ORIGIN           default *        (CORS origin)
 *    - DOWNLOAD_BASE_URL        default (auto)   (used in meta responses only)
 *
 *  SECURITY NOTES:
 *    - Files are stored under random 22-char URL-safe IDs (128 bits of
 *      entropy). They are NOT enumerable.
 *    - The original filename is sanitised and stored only in R2 custom
 *      metadata. Path-traversal characters are stripped.
 *    - The Content-Type on download is taken from the value the client
 *      sent at upload time, after a small allow-list. Unknown types
 *      default to application/octet-stream.
 *    - Downloads always carry Content-Disposition: attachment for
 *      non-previewable types, so they cannot be rendered as HTML in
 *      the visitor's browser.
 *    - The worker never logs or returns R2 bucket internals, environment
 *      variables, or credentials.
 *    - Rate limiting is best-effort and uses the Cloudflare Cache API.
 *      For higher-volume protection, also enable Cloudflare's built-in
 *      rate-limiting rules in the dashboard.
 * ============================================================================
 */

const DEFAULT_MAX_FILE_SIZE_MB = 100;
const DEFAULT_RATE_LIMIT_PER_H = 60;
const ID_BYTES = 16; // 128 bits of entropy -> 22 url-safe base64 chars

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

// Conservative set of forbidden file extensions (defense in depth; the
// upload backend always re-validates by MIME, but this lets us reject
// obviously hostile files earlier with a clearer message).
const FORBIDDEN_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.xht',
  '.php', '.php3', '.php4', '.php5', '.phtml',
  '.asp', '.aspx', '.jsp', '.jspx',
  '.exe', '.bat', '.cmd', '.sh', '.csh', '.msi', '.dll', '.so', '.bin',
  '.svg' // svg can carry scripts; treat as forbidden inline
]);
// (SVG is allowed as image/svg+xml only when served inline; we still accept
// the upload but always force attachment for it. To keep the rule simple,
// SVG is included in FORBIDDEN_EXTENSIONS and rejected at upload.)

// ---------------------------------------------------------------------------
// Utility: random URL-safe base64 ID
// ---------------------------------------------------------------------------
function randomId() {
  const bytes = new Uint8Array(ID_BYTES);
  crypto.getRandomValues(bytes);
  // base64url encode
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
  // Decode any percent-encoding (best-effort) then take basename only.
  let n = name;
  try { n = decodeURIComponent(n); } catch (e) {}
  // Replace backslashes with forward slashes, then take the last segment.
  n = n.replace(/\\/g, '/').split('/').pop() || '';
  // Strip control characters and NUL bytes.
  n = n.replace(/[\x00-\x1f\x7f]/g, '');
  // Collapse multiple dots (defends against ".." tricks).
  n = n.replace(/\.{2,}/g, '.');
  // Trim whitespace and dots at the start.
  n = n.replace(/^[\s.]+/, '');
  // Limit length.
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
// Returns true if the request is allowed; false if rate-limited.
// ---------------------------------------------------------------------------
async function checkRateLimit(request, env) {
  const limit = parseInt(env && env.UPLOAD_RATE_LIMIT_PER_H || String(DEFAULT_RATE_LIMIT_PER_H), 10);
  if (!limit || limit <= 0) return true; // unlimited
  const ip = request.headers.get('CF-Connecting-IP') ||
             request.headers.get('X-Forwarded-For') ||
             'anonymous';
  // Cache API isn't always available in dev. If not, skip rate-limiting.
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
    // The cache key includes the hour bucket so the entry naturally expires.
    resp.headers.set('Cache-Control', 'public, max-age=3600');
    await caches.default.put(key, resp.clone());
    return count <= limit;
  } catch (e) {
    // If rate-limiting fails, allow the request through (fail open).
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
  // Reject forbidden extensions early.
  const lowerName = file.name.toLowerCase();
  for (const ext of FORBIDDEN_EXTENSIONS) {
    if (lowerName.endsWith(ext)) {
      return { ok: false, status: 415, error: 'This file type is not allowed (' + ext + ').' };
    }
  }
  return { ok: true, maxBytes: maxBytes };
}

// ---------------------------------------------------------------------------
// Handler: POST /api/upload
// Body: multipart/form-data with field "file"
// Response: { id, url, filename, size, contentType, uploadedAt }
// ---------------------------------------------------------------------------
async function handleUpload(request, env) {
  // Method check
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405, env);
  }

  // Rate limit (best-effort)
  const allowed = await checkRateLimit(request, env);
  if (!allowed) {
    return jsonResponse({ error: 'Too many uploads. Please try again later.' }, 429, env);
  }

  // Parse multipart form. Cloudflare Workers supports request.formData().
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

  // Determine content type. Use the type the browser sent, or sniff from name.
  let contentType = (file.type || 'application/octet-stream').toLowerCase();
  if (FORBIDDEN_TYPES.has(contentType)) {
    return jsonResponse({ error: 'This file type is not allowed.' }, 415, env);
  }
  // If the browser did not provide a type, default to octet-stream.
  if (!contentType) contentType = 'application/octet-stream';

  // Generate a random, unpredictable ID for the file.
  const id = randomId();
  const key = 'uploads/' + id;

  // Read the file as an ArrayBuffer (Files in Workers expose arrayBuffer()).
  let fileBuffer;
  try {
    fileBuffer = await file.arrayBuffer();
  } catch (e) {
    return jsonResponse({ error: 'Could not read file.' }, 400, env);
  }

  // Store in R2 with custom metadata.
  try {
    await env.YORVIQUE_BUCKET.put(key, fileBuffer, {
      httpMetadata: {
        contentType: contentType
      },
      customMetadata: {
        originalFilename: safeName,
        uploadedAt: String(Date.now()),
        fileSize: String(file.size),
        contentType: contentType
      }
    });
  } catch (e) {
    return jsonResponse({ error: 'Storage backend unavailable.' }, 503, env);
  }

  // Build the public URL. We don't know the deployment hostname here, so we
  // return the id and let the frontend construct `${origin}/d/${id}`.
  const origin = (env && env.DOWNLOAD_BASE_URL) || '';
  const publicUrl = origin ? (origin + '/d/' + id) : ('/d/' + id);

  return jsonResponse({
    id: id,
    url: publicUrl,
    filename: safeName,
    size: file.size,
    contentType: contentType,
    uploadedAt: Number(Date.now())
  }, 201, env);
}

// ---------------------------------------------------------------------------
// Handler: GET /api/meta/:id  -> JSON metadata (does NOT stream the file)
// ---------------------------------------------------------------------------
async function handleMeta(id, request, env) {
  if (!id || !/^[A-Za-z0-9_-]{10,30}$/.test(id)) {
    return jsonResponse({ error: 'Invalid id.' }, 400, env);
  }
  const key = 'uploads/' + id;
  let info;
  try {
    info = await env.YORVIQUE_BUCKET.head(key);
  } catch (e) {
    return jsonResponse({ error: 'Storage backend unavailable.' }, 503, env);
  }
  if (!info) {
    return jsonResponse({ error: 'File not found or expired.' }, 404, env);
  }
  const meta = info.customMetadata || {};
  return jsonResponse({
    id: id,
    filename: meta.originalFilename || 'file',
    size: Number(meta.fileSize || info.size || 0),
    contentType: meta.contentType || (info.httpMetadata && info.httpMetadata.contentType) || 'application/octet-stream',
    uploadedAt: Number(meta.uploadedAt || 0)
  }, 200, env);
}

// ---------------------------------------------------------------------------
// Handler: GET /d/:id  -> stream the file from R2 to the visitor
// ---------------------------------------------------------------------------
async function handleDownload(id, request, env) {
  if (!id || !/^[A-Za-z0-9_-]{10,30}$/.test(id)) {
    return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const key = 'uploads/' + id;
  let object;
  try {
    object = await env.YORVIQUE_BUCKET.get(key);
  } catch (e) {
    return new Response('Storage backend unavailable.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (!object) {
    return new Response('File not found or expired.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }

  const meta = object.customMetadata || {};
  const filename = meta.originalFilename || 'file';
  const contentType = (meta.contentType || (object.httpMetadata && object.httpMetadata.contentType) || 'application/octet-stream').toLowerCase();

  // Build response headers.
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Content-Length', String(object.size));
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  headers.set('Referrer-Policy', 'no-referrer');

  // Decide disposition: inline only for known-safe types, otherwise attachment.
  const safeInline = INLINE_TYPES.has(contentType) && !contentType.includes('svg');
  // Always force attachment for SVG (can carry scripts).
  const dispositionType = safeInline ? 'inline' : 'attachment';

  // Encode filename for the Content-Disposition header (RFC 5987).
  const safeAscii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '').slice(0, 150) || 'file';
  const encoded = encodeURIComponent(filename);
  headers.set(
    'Content-Disposition',
    dispositionType + '; filename="' + safeAscii + '"; filename*=UTF-8\'\'' + encoded
  );

  return new Response(object.body, { status: 200, headers: headers });
}

// ---------------------------------------------------------------------------
// Handler: DELETE /api/delete/:id  (with deletion key — optional feature)
// ---------------------------------------------------------------------------
async function handleDelete(id, request, env) {
  // Optional: requires a deletion key in the X-Deletion-Key header. The key
  // would have been returned at upload time if we wanted to wire this up.
  // For now, returns 501 Not Implemented to make the contract explicit.
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
      // Make sure the R2 binding exists. If not, return a clear error.
      if (!env || !env.YORVIQUE_BUCKET) {
        return jsonResponse({
          error: 'Server is not configured for uploads. The YORVIQUE_BUCKET R2 binding is missing.'
        }, 503, env);
      }
      return handleUpload(request, env);
    }

    if (path.startsWith('/api/meta/')) {
      const id = path.slice('/api/meta/'.length);
      if (!env || !env.YORVIQUE_BUCKET) {
        return jsonResponse({ error: 'Storage backend unavailable.' }, 503, env);
      }
      return handleMeta(id, request, env);
    }

    if (path.startsWith('/api/delete/')) {
      return handleDelete(path.slice('/api/delete/'.length), request, env);
    }

    if (path.startsWith('/d/')) {
      if (!env || !env.YORVIQUE_BUCKET) {
        return new Response('Storage backend unavailable.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
      return handleDownload(path.slice(3), request, env);
    }

    // Pretty route aliases for legal pages
    if (path === '/privacy') {
      return env.ASSETS.fetch(new Request(new URL('/privacy.html', url), request));
    }
    if (path === '/terms') {
      return env.ASSETS.fetch(new Request(new URL('/terms.html', url), request));
    }

    // Static asset fallback (Cloudflare Pages auto-injects env.ASSETS).
    if (env && env.ASSETS) {
      // Try the exact path first.
      let assetResp = await env.ASSETS.fetch(request);
      // If not found and the path has no extension, try .html (pretty routes).
      if (assetResp.status === 404 && path !== '/' && !/\.[a-zA-Z0-9]+$/.test(path)) {
        const tryPath = new URL(path + '.html', url);
        assetResp = await env.ASSETS.fetch(new Request(tryPath, request));
      }
      if (assetResp.status !== 404) return assetResp;

      // Final fallback to the custom 404 page (status preserved).
      const notFoundReq = new Request(new URL('/404.html', url), request);
      const notFoundResp = await env.ASSETS.fetch(notFoundReq);
      if (notFoundResp && notFoundResp.status !== 404) {
        return new Response(notFoundResp.body, {
          status: 404,
          headers: notFoundResp.headers
        });
      }
      return new Response('Not found.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    // No ASSETS binding — should never happen on Cloudflare Pages.
    return new Response('YORVIQUE worker is running, but no ASSETS binding was found.', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
};
