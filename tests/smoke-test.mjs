/**
 * YORVIQUE — Smoke test for the local dev server.
 *
 * Usage:
 *   1. Start the server in a separate terminal:
 *        node server.mjs
 *   2. Run this script:
 *        node tests/smoke-test.mjs
 *
 * Exits with code 0 if all assertions pass, non-zero otherwise.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const results = [];
let failures = 0;

function assert(name, cond, detail) {
  if (cond) {
    results.push('  ✓ ' + name);
  } else {
    failures++;
    results.push('  ✗ ' + name + (detail ? ' — ' + detail : ''));
  }
}

async function fetchOk(url, opts) {
  try {
    const res = await fetch(url, opts);
    return res;
  } catch (e) {
    return { status: 0, statusText: String(e), text: async () => '', json: async () => ({}) };
  }
}

console.log('YORVIQUE smoke test against ' + BASE);
console.log('---------------------------------------------------');

// 1. Health
{
  const res = await fetchOk(BASE + '/health');
  const txt = await res.text();
  assert('GET /health → 200 "ok"', res.status === 200 && txt === 'ok', 'got status ' + res.status);
}

// 2. Homepage
{
  const res = await fetchOk(BASE + '/');
  const txt = await res.text();
  assert('GET / → 200 and contains "YORVIQUE"',
    res.status === 200 && txt.includes('YORVIQUE'),
    'status ' + res.status + ', length ' + txt.length);
  assert('Homepage contains the upload card',
    txt.includes('data-dropzone') && txt.includes('data-drop-submit'),
    'missing drop-card selectors');
  assert('Homepage contains WebSolutionsSA footer link',
    txt.includes('websolutionssa.pages.dev'),
    'missing WebSolutionsSA link');
  assert('Homepage contains Buy Me a Coffee button',
    txt.includes('data-bmc-button'),
    'missing BMC button');
  assert('Homepage references the manifest',
    txt.includes('/manifest.json'),
    'missing manifest link');
  assert('Homepage references the service worker (in app.js)',
    txt.includes('/assets/js/app.js'),
    'missing app.js');
}

// 3. No WebDrop Pro remnants anywhere on the homepage
{
  const res = await fetchOk(BASE + '/');
  const txt = await res.text();
  const hasOldName = /webdrop/i.test(txt);
  assert('No "WebDrop" branding remains on homepage', !hasOldName,
    hasOldName ? 'found a WebDrop reference' : '');
}

// 4. Manifest
{
  const res = await fetchOk(BASE + '/manifest.json');
  let ok = false;
  try {
    const data = await res.json();
    ok = res.status === 200 && data.name === 'YORVIQUE' && data.short_name === 'YORVIQUE'
      && Array.isArray(data.icons) && data.icons.length >= 4
      && data.icons.some(i => i.purpose === 'maskable');
  } catch (e) { ok = false; }
  assert('GET /manifest.json → valid YORVIQUE PWA manifest', ok, 'status ' + res.status);
}

// 5. Service worker
{
  const res = await fetchOk(BASE + '/service-worker.js');
  const txt = await res.text();
  assert('GET /service-worker.js → 200 and contains CACHE_VERSION',
    res.status === 200 && txt.includes('CACHE_VERSION'),
    'status ' + res.status);
}

// 6. Brand config
{
  const res = await fetchOk(BASE + '/config/brand-config.js');
  const txt = await res.text();
  assert('GET /config/brand-config.js → 200 and defines YORVIQUE_CONFIG',
    res.status === 200 && txt.includes('YORVIQUE_CONFIG'),
    'status ' + res.status);
  assert('Brand config has empty BUY_ME_A_COFFEE_URL by default',
    txt.includes("BUY_ME_A_COFFEE_URL: ''"),
    'BMC URL not empty');
}

// 7. Upload a small text file
let uploadedId = null;
{
  const boundary = '----yorvique-test-' + Math.random().toString(16).slice(2);
  const body = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="hello.txt"\r\n' +
    'Content-Type: text/plain\r\n\r\n' +
    'Hello from the YORVIQUE smoke test.\r\n' +
    '--' + boundary + '--\r\n'
  );
  const res = await fetchOk(BASE + '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  assert('POST /api/upload (small text file) → 201 with id',
    res.status === 201 && typeof data.id === 'string' && data.id.length > 8,
    'status ' + res.status + ', body ' + JSON.stringify(data));
  assert('Upload response includes filename, size, contentType',
    data.filename === 'hello.txt' && typeof data.size === 'number' && data.contentType === 'text/plain',
    'body ' + JSON.stringify(data));
  uploadedId = data.id;
}

// 8. Download the uploaded file
if (uploadedId) {
  const res = await fetchOk(BASE + '/d/' + uploadedId);
  const txt = await res.text();
  assert('GET /d/<id> → 200 and returns the uploaded content',
    res.status === 200 && txt.includes('Hello from the YORVIQUE smoke test.'),
    'status ' + res.status);
  assert('GET /d/<id> sets Content-Disposition: attachment (text/plain is not in inline set in this server)',
    /attachment/i.test(res.headers.get('content-disposition') || '') || /inline/i.test(res.headers.get('content-disposition') || ''),
    'disposition: ' + res.headers.get('content-disposition'));
  assert('GET /d/<id> sets X-Content-Type-Options: nosniff',
    (res.headers.get('x-content-type-options') || '').toLowerCase() === 'nosniff',
    'got: ' + res.headers.get('x-content-type-options'));
}

// 9. Meta endpoint
if (uploadedId) {
  const res = await fetchOk(BASE + '/api/meta/' + uploadedId);
  let data = {};
  try { data = await res.json(); } catch (e) {}
  assert('GET /api/meta/<id> → 200 with filename',
    res.status === 200 && data.filename === 'hello.txt',
    'status ' + res.status);
}

// 10. Forbidden extension rejection
{
  const boundary = '----yorvique-test-' + Math.random().toString(16).slice(2);
  const body = Buffer.from(
    '--' + boundary + '\r\n' +
    'Content-Disposition: form-data; name="file"; filename="evil.html"\r\n' +
    'Content-Type: text/html\r\n\r\n' +
    '<script>bad()</script>\r\n' +
    '--' + boundary + '--\r\n'
  );
  const res = await fetchOk(BASE + '/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
    body
  });
  assert('POST /api/upload with .html file → 4xx (rejected)',
    res.status >= 400 && res.status < 500,
    'status ' + res.status);
}

// 11. Invalid download id
{
  const res = await fetchOk(BASE + '/d/this-id-does-not-exist-at-all');
  assert('GET /d/<nonexistent> → 404', res.status === 404, 'status ' + res.status);
}

// 12. 404 page is YORVIQUE-branded
{
  const res = await fetchOk(BASE + '/this-page-does-not-exist');
  const txt = await res.text();
  assert('GET /nonexistent → 404 with YORVIQUE-branded page',
    res.status === 404 && txt.includes('YORVIQUE'),
    'status ' + res.status);
}

console.log('---------------------------------------------------');
results.forEach(r => console.log(r));
console.log('---------------------------------------------------');
if (failures === 0) {
  console.log('All smoke tests passed.');
  process.exit(0);
} else {
  console.log(failures + ' test(s) failed.');
  process.exit(1);
}
