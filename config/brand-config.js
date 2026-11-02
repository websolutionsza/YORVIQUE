(function () {
  'use strict';

  // The supplied GitHub raw URL prefix — kept here so you can swap any asset
  // to the remote URL by changing `local` to `remote` in the asset entry below.
  const REMOTE_BASE =
    'https://raw.githubusercontent.com/websolutionsza/YORVIQUE/refs/heads/main/';

  window.YORVIQUE_CONFIG = {
    brand: {
      name: 'YORVIQUE',
      tagline: 'Share without the hassle.',
      description:
        'Upload a file, generate a shareable link and move on. Simple, convenient and straightforward.',
      microcopy: 'Drop a file. Get a link. Move on.',
      copyrightYear: 2026
    },

    // --------------------------------------------------------------------------
    // BUY ME A COFFEE
    // --------------------------------------------------------------------------
    // Insert your real Buy Me a Coffee URL between the quotes below, e.g.
    //   BUY_ME_A_COFFEE_URL: "https://www.buymeacoffee.com/yourname"
    // Leave it as "" and the button stays visible but inactive.
    // --------------------------------------------------------------------------
    BUY_ME_A_COFFEE_URL: '',

    // --------------------------------------------------------------------------
    // DEVELOPER CREDIT (footer)
    // --------------------------------------------------------------------------
    developer: {
      name: 'WebSolutionsSA',
      url: 'https://websolutionssa.pages.dev/'
    },

    // --------------------------------------------------------------------------
    // BRAND IMAGE ASSETS — all 11 supplied URLs
    // --------------------------------------------------------------------------
    // Each entry has a `local` path (used by default for reliability) and a
    // `remote` URL (the original URL you supplied, kept for reference).
    // To switch any asset to the remote URL, change the `local` value to the
    // `remote` value (or vice-versa).
    // --------------------------------------------------------------------------
    assets: {
      // 11. MAIN WEBSITE LOGO
      logo: {
        local: '/yorvique.png',
        remote: REMOTE_BASE + 'yorvique.png',
        alt: 'YORVIQUE logo',
        width: 32,
        height: 32
      },
      // 07. Favicon — ICO
      faviconIco: {
        local: '/favicon.ico',
        remote: REMOTE_BASE + 'favicon.ico'
      },
      // 08. Favicon — 16 × 16
      favicon16: {
        local: '/favicon-16x16.png',
        remote: REMOTE_BASE + 'favicon-16x16.png',
        size: 16
      },
      // 09. Favicon — 32 × 32
      favicon32: {
        local: '/favicon-32x32.png',
        remote: REMOTE_BASE + 'favicon-32x32.png',
        size: 32
      },
      // 10. Favicon — 48 × 48
      favicon48: {
        local: '/favicon-48x48.png',
        remote: REMOTE_BASE + 'favicon-48x48.png',
        size: 48
      },
      // 01. Apple Touch Icon — standard (180 × 180)
      appleTouchIcon: {
        local: '/apple-touch-icon.png',
        remote: REMOTE_BASE + 'apple-touch-icon.png',
        size: 180
      },
      // 02. Apple Touch Icon — 120 × 120
      appleTouchIcon120: {
        local: '/apple-touch-icon-120x120.png',
        remote: REMOTE_BASE + 'apple-touch-icon-120x120.png',
        size: 120
      },
      // 03. Apple Touch Icon — 152 × 152
      appleTouchIcon152: {
        local: '/apple-touch-icon-152x152.png',
        remote: REMOTE_BASE + 'apple-touch-icon-152x152.png',
        size: 152
      },
      // 04. Apple Touch Icon — 167 × 167
      appleTouchIcon167: {
        local: '/apple-touch-icon-167x167.png',
        remote: REMOTE_BASE + 'apple-touch-icon-167x167.png',
        size: 167
      },
      // 05. PWA Maskable Icon — 512 × 512
      maskable512: {
        local: '/maskable-512x512.png',
        remote: REMOTE_BASE + 'maskable-512x512.png',
        size: 512
      },
      // 06. PWA Maskable Icon — 192 × 192
      maskable192: {
        local: '/maskable-192x192.png',
        remote: REMOTE_BASE + 'maskable-192x192.png',
        size: 192
      }
    },

    // --------------------------------------------------------------------------
    // STORAGE / UPLOAD RUNTIME CONFIG
    // --------------------------------------------------------------------------
    // These are CLIENT-SIDE hints only. The real limits are enforced by the
    // Cloudflare Worker (_worker.js) using environment variables. The values
    // here must match what the worker enforces — otherwise the UI will show
    // a generic error when the server rejects an upload.
    // --------------------------------------------------------------------------
    storage: {
      // Maximum file size, in bytes (default 100 MiB). Mirrors the worker's
      // MAX_FILE_SIZE_MB environment variable. Keep them in sync.
      maxFileSizeBytes: 100 * 1024 * 1024,
      // Endpoint the frontend POSTs uploads to.
      uploadEndpoint: '/api/upload',
      // Endpoint pattern that returns the uploaded file.
      // The frontend constructs the shareable URL as `${origin}/d/${id}`.
      downloadPathPrefix: '/d/'
    }
  };
})();
