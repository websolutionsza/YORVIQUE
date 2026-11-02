# YORVIQUE

> **Share without the hassle.**
> Upload a file, generate a shareable link and move on. Simple, convenient and straightforward.

YORVIQUE is a minimalist, premium file-sharing web application. Drop a file, get a shareable link, move on. Built as an installable Progressive Web App (PWA) and designed to deploy on Cloudflare Pages with Cloudflare R2 storage.

---

## Table of contents

1. [What is YORVIQUE?](#what-is-yorvique)
2. [Project structure](#project-structure)
3. [Run locally](#run-locally)
4. [How the upload system works](#how-the-upload-system-works)
5. [Backend services required](#backend-services-required)
6. [Environment variables](#environment-variables)
7. [Deploy to Cloudflare Pages](#deploy-to-cloudflare-pages)
8. [Install the PWA](#install-the-pwa)
9. [Configure the Buy Me a Coffee URL](#configure-the-buy-me-a-coffee-url)
10. [Brand image URLs and where they are configured](#brand-image-urls-and-where-they-are-configured)
11. [Replace the logo and icons](#replace-the-logo-and-icons)
12. [Security notes](#security-notes)
13. [Troubleshooting](#troubleshooting)

---

## What is YORVIQUE?

YORVIQUE is a small, fast file-sharing application. A visitor drags a file onto the upload card (or picks one from their device), the file is uploaded to a Cloudflare R2 bucket, and the visitor receives a real, shareable URL that anyone — on any device — can open to download the file.

The application is:

- **Statically served** by Cloudflare Pages (HTML, CSS, JS, images).
- **Backend-powered** by a Cloudflare Pages Worker (`_worker.js`) that handles `/api/upload`, `/api/meta/:id`, and `/d/:id` against an R2 bucket.
- **Installable** as a Progressive Web App (`manifest.json` + `service-worker.js`).
- **Locally runnable** via `node server.mjs` for development (no Cloudflare account needed).

Brand colors:

| Token        | Hex       | Use                                |
|--------------|-----------|------------------------------------|
| Cream        | `#F5EFE3` | Page background                    |
| Paper        | `#FFFCF5` | Lifted surfaces                    |
| Navy         | `#202638` | Primary text, drop card background |
| Teal         | `#315D64` | Secondary accent                   |
| Lime         | `#C8EF45` | CTA highlight, success states      |

---

## Project structure

```
YORVIQUE/
├── index.html              # Homepage with the working upload UI
├── privacy.html            # Privacy policy
├── terms.html              # Terms of service
├── 404.html                # Not-found page
├── manifest.json           # PWA manifest (installable, maskable icons)
├── service-worker.js       # BROWSER service worker (offline app shell)
├── _worker.js              # CLOUDFLARE PAGES worker (R2 upload/download API)
├── server.mjs              # Local dev server (mirrors the worker API on filesystem)
├── README.md               # This file
├── apple-touch-icon.png
├── apple-touch-icon-120x120.png
├── apple-touch-icon-152x152.png
├── apple-touch-icon-167x167.png
├── maskable-192x192.png
├── maskable-512x512.png
├── favicon.ico
├── favicon-16x16.png
├── favicon-32x32.png
├── favicon-48x48.png
├── yorvique.png            # Main website logo (header + footer)
├── assets/
│   ├── css/
│   │   └── styles.css
│   └── js/
│       └── app.js          # Front-end application (upload, copy link, SW registration)
├── config/
│   └── brand-config.js     # ★ Single source of truth for brand + BMC URL + asset URLs
├── documentation/
│   ├── deployment-guide.md # Step-by-step Cloudflare deployment guide
│   └── wrangler.example.toml # Example Cloudflare config (rename to wrangler.toml)
└── tests/
    └── README.md           # How to run the manual test checklist
```

> **Important:** `_worker.js` (Cloudflare worker) and `service-worker.js` (browser SW) are completely separate. They share a name pattern only.

---

## Run locally

You need Node.js 18+ installed.

```bash
# 1. From the project root:
node server.mjs

# 2. Open http://localhost:3000
```

The local server:

- Serves all static files (HTML, CSS, JS, images, manifest, SW).
- Implements the same upload/download API as the Cloudflare worker, but stores files on the local filesystem under `./uploads/` (created automatically).
- Respects the `PORT` environment variable (default 3000) and `MAX_FILE_SIZE_MB` (default 100).

> The local server is for development only. Use Cloudflare Pages for production.

---

## How the upload system works

1. **Select a file** — drag-and-drop onto the upload card, or click "Choose from device".
2. **Validate** — the front-end checks file size against `STORAGE.maxFileSizeBytes` in `config/brand-config.js` (default 100 MB).
3. **Upload** — the file is POSTed as `multipart/form-data` to `/api/upload` via `XMLHttpRequest` so the UI can show real upload progress events.
4. **Server stores** — the Cloudflare worker generates a 22-character URL-safe random ID (128 bits of entropy), sanitises the original filename, and stores the file in the R2 bucket at `uploads/<id>` with custom metadata (`originalFilename`, `fileSize`, `contentType`, `uploadedAt`).
5. **Server responds** — JSON: `{ id, url, filename, size, contentType, uploadedAt }`.
6. **Client displays** — the front-end builds the shareable URL as `${window.location.origin}/d/${id}` and shows it with a copy button and an "Open" link.
7. **Download** — anyone visiting `/d/<id>` gets the file streamed from R2 with safe `Content-Disposition`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and a strict `Content-Security-Policy`.

The link works for any visitor on any device because the file is stored on the server (R2), not in the browser.

---

## Backend services required

For production you need:

- A **Cloudflare Pages** project (free tier works).
- A **Cloudflare R2** bucket (free tier: 10 GB storage, 10 GB egress per month).
- The R2 bucket **bound to the Pages project** under
  `Settings → Functions → R2 bucket bindings` with the variable name **`YORVIQUE_BUCKET`**.

That's the only required backend. No database, no other storage service.

> For local development, no Cloudflare account is needed — `server.mjs` uses the local filesystem.

---

## Environment variables

Set these in the Cloudflare Pages dashboard under `Settings → Environment variables` (Production and Preview). All are optional — defaults are shown.

| Variable                    | Default | Purpose                                                       |
|-----------------------------|---------|---------------------------------------------------------------|
| `MAX_FILE_SIZE_MB`          | `100`   | Maximum upload size in MiB. Mirror this in `brand-config.js`. |
| `UPLOAD_RATE_LIMIT_PER_H`   | `60`    | Best-effort per-IP upload limit per hour.                     |
| `ALLOWED_ORIGIN`            | `*`     | CORS origin for API responses.                                |
| `DOWNLOAD_BASE_URL`         | (auto)  | Optional absolute origin used in meta JSON `url` field.       |

> Never put R2 access keys or secret tokens in environment variables that the worker reads with `env.SECRET`. Use **R2 bucket bindings** instead — they are scoped, do not expose credentials to the worker code, and are the recommended way to grant a Pages function access to R2.

---

## Deploy to Cloudflare Pages

See [`documentation/deployment-guide.md`](documentation/deployment-guide.md) for the full step-by-step guide. The short version:

1. Push this project to a GitHub repository.
2. In the Cloudflare dashboard, create a new Pages project and connect the repo.
3. Set the build command to (leave empty if your repo contains the final files):
   - Build command: *(none — files are already built)*
   - Build output directory: `/` (root)
4. Add the R2 bucket binding `YORVIQUE_BUCKET` under `Settings → Functions → R2 bucket bindings`.
5. (Optional) Set environment variables from the table above.
6. Deploy.

Cloudflare Pages will detect `_worker.js` at the project root and use it as the Pages Function in advanced mode, with `env.ASSETS` automatically bound to the static assets.

---

## Install the PWA

YORVIQUE is installable on Chrome, Edge, and other Chromium browsers (desktop and Android), and add-to-home-screen on iOS/Safari.

- **Desktop (Chrome/Edge):** click the install icon in the address bar, or `⋮ → Install YORVIQUE`.
- **Android (Chrome):** `⋮ → Install app`.
- **iOS (Safari):** `Share → Add to Home Screen`.

Once installed, YORVIQUE opens in its own window, with its own YORVIQUE icon, name, and splash screen.

### Offline behaviour

- The app shell (homepage, privacy, terms, CSS, JS, brand icons) is cached by the browser service worker. Once you've visited YORVIQUE once, the homepage still loads when you're offline.
- Uploads and downloads are **never** cached. They always require an internet connection. When you're offline, the UI shows an offline banner and refuses to start an upload.
- The service worker updates itself: when you deploy a new version, the next visit installs the new SW in the background, and the page reloads once to pick up the new app shell. No visitor is permanently stuck on an outdated version.

---

## Configure the Buy Me a Coffee URL

Open `config/brand-config.js` and find this line near the top:

```js
BUY_ME_A_COFFEE_URL: '',
```

Paste your real Buy Me a Coffee URL between the quotes, e.g.:

```js
BUY_ME_A_COFFEE_URL: 'https://www.buymeacoffee.com/yourname',
```

While the value is `''` (empty string), the "Buy me a coffee" button stays **visible** in the header and footer, but clicking it does **absolutely nothing** — no navigation, no popup, no error. The moment you put a real URL in, the button becomes a normal external link that opens in a new tab.

The button is rendered with the `data-bmc-button` attribute in `index.html`, `privacy.html`, `terms.html`, and `404.html`. The behaviour is wired up in `assets/js/app.js` → `initBuyMeACoffee()`.

---

## Brand image URLs and where they are configured

All 11 supplied image URLs are catalogued in **`config/brand-config.js`** under `window.YORVIQUE_CONFIG.assets`. Each entry has a `local` path (used by default for reliability) and the original `remote` URL (kept for reference, so you can swap any asset to the remote URL by editing one line).

| #  | Asset                       | Config key            | Local path                         |
|----|-----------------------------|-----------------------|------------------------------------|
| 01 | Apple Touch Icon (standard) | `appleTouchIcon`      | `/apple-touch-icon.png`            |
| 02 | Apple Touch Icon 120×120    | `appleTouchIcon120`   | `/apple-touch-icon-120x120.png`    |
| 03 | Apple Touch Icon 152×152    | `appleTouchIcon152`   | `/apple-touch-icon-152x152.png`    |
| 04 | Apple Touch Icon 167×167    | `appleTouchIcon167`   | `/apple-touch-icon-167x167.png`    |
| 05 | PWA Maskable 512×512        | `maskable512`         | `/maskable-512x512.png`            |
| 06 | PWA Maskable 192×192        | `maskable192`         | `/maskable-192x192.png`            |
| 07 | Favicon ICO                 | `faviconIco`          | `/favicon.ico`                     |
| 08 | Favicon 16×16               | `favicon16`           | `/favicon-16x16.png`               |
| 09 | Favicon 32×32               | `favicon32`           | `/favicon-32x32.png`               |
| 10 | Favicon 48×48               | `favicon48`           | `/favicon-48x48.png`               |
| 11 | **Main website logo**       | `logo`                | `/yorvique.png`                    |

The HTML also references these local paths directly in `<link rel="icon">`, `<link rel="apple-touch-icon">`, `<link rel="manifest">`, and `<img class="brand-logo">` tags so that favicons work even before JavaScript runs.

---

## Replace the logo and icons

To replace the main logo:

1. Drop your new logo file at the project root, e.g. `yorvique.png`.
2. Either overwrite the existing `yorvique.png`, or change `assets.logo.local` in `config/brand-config.js` to your new path.
3. The HTML `<img class="brand-logo" src="/yorvique.png">` already points there.

To replace any icon:

1. Overwrite the corresponding file in the project root (e.g. `maskable-512x512.png`).
2. Or change the `local` path in `config/brand-config.js` and update the matching `<link>` tag in each HTML file.

The PWA manifest (`manifest.json`) declares maskable icons with `"purpose": "maskable"` and other icons with `"purpose": "any"`. If you replace the maskable PNGs, make sure they have safe padding (the icon should occupy roughly the central 80% of the canvas) so they look correct when installed on Android.

---

## Security notes

YORVIQUE implements the following protections:

- **Server-side file validation** — file size, name, extension, and content type are all checked on the server (`_worker.js` and `server.mjs`). Client-side validation is just for UX.
- **Safe filenames** — original filenames are sanitised (path components stripped, control characters removed, double-dots collapsed, length capped) before being stored as R2 custom metadata.
- **Unpredictable IDs** — every upload gets a 128-bit cryptographically random ID. IDs are not enumerable.
- **Upload size limits** — enforced at the worker level (`MAX_FILE_SIZE_MB`, default 100 MiB).
- **Best-effort rate limiting** — per-IP upload limit (`UPLOAD_RATE_LIMIT_PER_H`, default 60/hour) using the Cloudflare Cache API. For higher-volume protection, also enable Cloudflare's dashboard rate-limiting rules.
- **Safe download headers** — every `/d/:id` response sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'none'`, and `Content-Disposition: attachment` for non-previewable types. Known-safe types (images, video, audio, PDF, plain text) are served inline.
- **No path traversal** — IDs are validated against `^[A-Za-z0-9_-]{10,30}$` before any R2 lookup. The local dev server uses a `safePath()` helper that constrains all file reads to the project root.
- **No exposed credentials** — the worker uses R2 bucket **bindings**, not access keys. No `env.SECRET_*` is ever returned to the client. The front-end never sees storage credentials.
- **CORS** — `Access-Control-Allow-Origin` defaults to `*` but can be locked down via `ALLOWED_ORIGIN`.

What you should still configure outside the codebase:

- Enable Cloudflare's dashboard-level **Rate Limiting Rules** for `/api/upload` if you expect significant traffic.
- Enable **Bot Fight Mode** in the Cloudflare dashboard.
- Review your R2 bucket's lifecycle rules. YORVIQUE does not auto-delete files; if you want uploads to expire, set an R2 object lifecycle rule to delete `uploads/*` after N days.

YORVIQUE does not claim to be completely secure. No public-facing file-sharing service is. Treat the included protections as a baseline and add infrastructure-level protections (WAF, rate-limiting rules, R2 lifecycle) as appropriate for your deployment.

---

## Troubleshooting

**Upload returns 503 "Server is not configured for uploads."**
The `YORVIQUE_BUCKET` R2 binding is missing. Add it under `Settings → Functions → R2 bucket bindings` in the Cloudflare Pages dashboard and redeploy.

**Upload returns 413 "File is too large."**
The file exceeds `MAX_FILE_SIZE_MB` (default 100 MiB). Either upload a smaller file or raise the environment variable. If you raise it, also update `STORAGE.maxFileSizeBytes` in `config/brand-config.js` so the UI matches.

**Service worker does not update.**
Browsers cache service workers for up to 24 hours. Hard-reload (`Ctrl+Shift+R`) or wait. The SW calls `self.skipWaiting()` on install and `clients.claim()` on activate, so once the new SW is fetched, it takes over immediately.

**PWA install prompt does not appear.**
The site must be served over HTTPS (Cloudflare Pages does this automatically), the manifest must be reachable, and the service worker must be registered. Check the browser console for errors.

**Favicon shows the old icon.**
Browsers cache favicons aggressively. Hard-reload, or open the favicon URL directly and refresh.

---

© 2026 YORVIQUE. All rights reserved. | developed by [WebSolutionsSA](https://websolutionssa.pages.dev/)
