[deployment-guide.md](https://github.com/user-attachments/files/34287935/deployment-guide.md)
# YORVIQUE — Deployment Guide (Cloudflare Pages + R2)

This guide walks you through deploying YORVIQUE to Cloudflare Pages with an R2 bucket for file storage.

---

## Prerequisites

- A Cloudflare account (free tier works).
- A GitHub repository containing this project (or a way to upload the project directly).
- (Optional) A custom domain configured in Cloudflare.

---

## Step 1 — Create the R2 bucket

1. Log in to the Cloudflare dashboard.
2. Go to **R2 Object Storage** in the left sidebar.
3. Click **Create bucket**.
4. Name it `yorvique-uploads` (or any name you like).
5. Leave the location as automatic (or pick your region).
6. Click **Create**.

You do **not** need to create an R2 API token. The Pages function will access R2 via a bucket **binding**, which is more secure and does not expose credentials to your code.

---

## Step 2 — Create the Cloudflare Pages project

1. In the Cloudflare dashboard, go to **Workers & Pages**.
2. Click **Create application** → **Pages**.
3. Connect your GitHub repository (or upload the project as a direct upload).
4. Set the project name to `yorvique` (or any name you like).
5. **Build settings:**
   - Framework preset: **None**
   - Build command: *(leave empty — files are already built)*
   - Build output directory: `/` (the project root)
6. Click **Save and Deploy**.

Cloudflare will deploy the static files and detect `_worker.js` at the project root, automatically using it as the Pages Function in advanced mode with `env.ASSETS` bound to your static assets.

---

## Step 3 — Bind the R2 bucket to the Pages project

1. In the Pages project, go to **Settings** → **Functions**.
2. Scroll down to **R2 bucket bindings**.
3. Click **Add binding**.
4. Configure:
   - Variable name: **`YORVIQUE_BUCKET`** (must match exactly — the worker reads `env.YORVIQUE_BUCKET`).
   - R2 bucket: select `yorvique-uploads` (the bucket you created in Step 1).
5. Save.
6. Do this for both the **Production** and **Preview** environments, or just Production if you prefer.

> Without this binding, `/api/upload` returns `503 Server is not configured for uploads.`

---

## Step 4 — Set environment variables (optional)

In **Settings** → **Environment variables**, add (all optional — defaults shown):

| Variable                    | Default | Notes                                                  |
|-----------------------------|---------|-------------------------------------------------------|
| `MAX_FILE_SIZE_MB`          | `100`   | Max upload size in MiB. Mirror in `brand-config.js`.  |
| `UPLOAD_RATE_LIMIT_PER_H`   | `60`    | Best-effort per-IP upload limit per hour.             |
| `ALLOWED_ORIGIN`            | `*`     | CORS origin. Set to your domain to lock down.         |
| `DOWNLOAD_BASE_URL`         | (auto)  | Optional absolute origin used in meta JSON `url`.     |

> Never put R2 access keys or secret tokens in environment variables that the worker reads. Use the R2 bucket binding instead — it's scoped, secure, and doesn't expose credentials.

---

## Step 5 — Trigger a deployment

1. Push a commit to your main branch (or click **Retry deployment** in the dashboard).
2. Wait for the build to finish (should be a few seconds — there's no build step).
3. Open the preview URL Cloudflare gives you (e.g. `https://yorvique.pages.dev`).

---

## Step 6 — Test the upload flow

1. Open the deployed site.
2. Drag a small file (e.g. a PNG or PDF) onto the upload card.
3. Click **Make the link**.
4. Wait for the upload to complete.
5. Copy the generated link.
6. Open the link in a new browser tab, or send it to another device.
7. The file should download (or preview, if it's an image/PDF/text).

If the upload returns 503, the R2 binding is missing — re-check Step 3.

---

## Step 7 — (Optional) Add a custom domain

1. In the Pages project, go to **Custom domains**.
2. Click **Set up a custom domain**.
3. Enter your domain (e.g. `yorvique.example.com`).
4. Cloudflare will guide you through the DNS setup. If your domain is already on Cloudflare, the DNS record is added automatically.

Once the custom domain is active, HTTPS is provisioned automatically and the PWA will be installable from that domain.

---

## Step 8 — (Optional) Add R2 lifecycle rules for auto-expiration

By default, YORVIQUE keeps uploads indefinitely. To auto-expire uploads after N days:

1. Go to **R2 Object Storage** → your `yorvique-uploads` bucket.
2. Go to **Settings** → **Object lifecycle rules**.
3. Add a rule: **Prefix** `uploads/`, **Action** Delete, **Days** 30 (or whatever you prefer).
4. Save.

YORVIQUE gracefully handles expired files — the download link returns `404 File not found or expired.` and the UI shows a clean error message.

> If you enable expiration, you may want to mention it in `privacy.html` and `terms.html` so users know.

---

## Step 9 — (Optional) Lock down CORS

If you're only serving YORVIQUE from a single domain, set `ALLOWED_ORIGIN` to your exact origin:

```
ALLOWED_ORIGIN=https://yorvique.example.com
```

This prevents other websites from making cross-origin upload requests to your worker.

---

## Step 10 — (Optional) Enable Cloudflare Rate Limiting

The worker has a best-effort per-IP rate limit, but for stronger protection:

1. Go to **Security** → **WAF** → **Rate limiting rules**.
2. Create a rule:
   - **If** the URI path equals `/api/upload`
   - **And** the request method is `POST`
   - **Then** skip to the next phase, but only allow 10 requests per minute per IP.
3. Save.

---

## Verifying the deployment

Run through this checklist:

- [ ] Visiting `https://<your-domain>/` shows the YORVIQUE homepage.
- [ ] The YORVIQUE logo appears in the header and footer.
- [ ] Dragging a file onto the upload card shows the file name, size, and type.
- [ ] Clicking **Make the link** uploads the file and shows real progress.
- [ ] On success, a shareable URL is displayed with a copy button.
- [ ] Clicking **Open** downloads/previews the file in a new tab.
- [ ] Opening the link on another device also downloads the file.
- [ ] Visiting `/manifest.json` returns valid JSON with `name: "YORVIQUE"`.
- [ ] Visiting `/service-worker.js` returns the SW source.
- [ ] The browser shows an install icon in the address bar (Chrome/Edge desktop) or "Install app" in the menu (Android Chrome).
- [ ] After installing, the app opens in its own window with the YORVIQUE icon.
- [ ] Going offline and reloading the homepage still shows the app shell.
- [ ] The footer shows: "© 2026 YORVIQUE. All rights reserved. | developed by WebSolutionsSA" with WebSolutionsSA linking to https://websolutionssa.pages.dev/ in a new tab.
- [ ] Clicking "Buy me a coffee" does nothing (while the URL in `brand-config.js` is empty).

If all of the above pass, the deployment is complete.

---

## Rolling back

Cloudflare Pages keeps every deployment. To roll back:

1. Go to your Pages project → **Deployments**.
2. Find the deployment you want to roll back to.
3. Click **⋯** → **Rollback to this deployment**.

The rollback is instant.

---

© 2026 YORVIQUE. All rights reserved. | developed by [WebSolutionsSA](https://websolutionssa.pages.dev/)
