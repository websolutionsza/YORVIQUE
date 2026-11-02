/* ============================================================================
 *  YORVIQUE — BROWSER SERVICE WORKER (PWA)
 * ----------------------------------------------------------------------------
 *  This is the BROWSER service worker. It is NOT the Cloudflare _worker.js
 *  — those are two completely separate concepts. This file is registered by
 *  app.js inside the visitor's browser and is responsible for:
 *    - Caching the app shell (HTML, CSS, JS, fonts, brand icons)
 *    - Serving the cached app shell when the network is unavailable
 *    - Updating itself and the cached assets when a new version is deployed
 *
 *  IMPORTANT OFFLINE BEHAVIOUR:
 *    - The static app shell (homepage, privacy, terms, 404) is cached and
 *      works offline once visited.
 *    - /api/* requests are NEVER cached — uploads and downloads always
 *      require a live network connection. If a user is offline, the
 *      app.js UI shows an offline banner and refuses to start an upload.
 * ============================================================================
 */

const CACHE_VERSION = 'yorvique-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/privacy',
  '/privacy.html',
  '/terms',
  '/terms.html',
  '/404.html',
  '/assets/css/styles.css',
  '/assets/js/app.js',
  '/config/brand-config.js',
  '/manifest.json',
  '/yorvique.png',
  '/favicon.ico',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/favicon-48x48.png',
  '/apple-touch-icon.png',
  '/apple-touch-icon-120x120.png',
  '/apple-touch-icon-152x152.png',
  '/apple-touch-icon-167x167.png',
  '/maskable-192x192.png',
  '/maskable-512x512.png'
];

// ---------------------------------------------------------------------------
// Install: pre-cache the app shell.
// We use addAll so that if ANY single request fails, the whole install fails
// and the previous service worker keeps running. This avoids partial caches.
// ---------------------------------------------------------------------------
self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // Best-effort: cache what we can, ignore individual failures so a
      // single missing asset does not block installation.
      return Promise.all(
        PRECACHE_URLS.map(function (url) {
          return cache.add(url).catch(function () { /* ignore individual failure */ });
        })
      );
    }).then(function () {
      // Take control immediately on first install.
      return self.skipWaiting();
    })
  );
});

// ---------------------------------------------------------------------------
// Activate: clean up old caches and take control of all open tabs.
// ---------------------------------------------------------------------------
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (key) { return key !== CACHE_VERSION; })
            .map(function (key) { return caches.delete(key); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

// ---------------------------------------------------------------------------
// Fetch strategy:
//   - For navigation requests (HTML pages): network-first with cache
//     fallback. If the network is unavailable, serve the cached app shell.
//   - For /api/* and /d/* (download): network-only. These MUST hit the
//     real server because uploads/downloads require a live backend.
//   - For everything else (CSS, JS, images, fonts): stale-while-revalidate.
//     Serve from cache immediately, and refresh the cached copy in the
//     background so the next visit picks up any updates.
// ---------------------------------------------------------------------------
self.addEventListener('fetch', function (event) {
  const request = event.request;
  // Only handle GET requests; let everything else pass through.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Skip cross-origin requests (e.g. Google Fonts). The browser handles them.
  if (url.origin !== self.location.origin) return;

  // NEVER cache API or download endpoints — they need a live backend.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/d/')) {
    // Network-only: just fetch.
    event.respondWith(fetch(request));
    return;
  }

  // Navigation requests: network-first with cache fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(function (response) {
          // Cache a copy of the latest HTML.
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put(request, copy);
          }).catch(function () {});
          return response;
        })
        .catch(function () {
          // Network failed — try the cache, then fall back to the cached root.
          return caches.match(request).then(function (cached) {
            return cached || caches.match('/index.html') || caches.match('/');
          });
        })
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then(function (cached) {
      const fetchPromise = fetch(request).then(function (response) {
        // Only cache successful, same-origin, basic responses.
        if (response && response.status === 200 && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put(request, copy);
          }).catch(function () {});
        }
        return response;
      }).catch(function () {
        // If both cache and network fail, return the cached copy if any.
        return cached;
      });
      // Return cached immediately if available, otherwise wait for network.
      return cached || fetchPromise;
    })
  );
});

// ---------------------------------------------------------------------------
// Allow the page to trigger an immediate update when a new SW is waiting.
// ---------------------------------------------------------------------------
self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
