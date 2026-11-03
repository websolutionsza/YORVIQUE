[deployment-guide.md](https://github.com/user-attachments/files/34306718/deployment-guide.md)
# YORVIQUE — Deployment Guide (Cloudflare Pages + Cloudinary + KV)

This guide walks you through deploying YORVIQUE using **completely free services that do NOT require a credit card**:

- **Cloudflare Pages** — hosts the static site and runs the worker (free, no card)
- **Cloudflare KV** — stores a tiny metadata index that maps shareable IDs to Cloudinary files (free, no card)
- **Cloudinary** — stores the actual uploaded files (free 25 GB storage + 25 GB bandwidth/month, no card)

Total cost: **$0**. No card on file anywhere.

---

## Prerequisites

- A Cloudflare account (free).
- A Cloudinary account (free).
- A GitHub repository containing this project (or a way to upload the project directly).

---

## Step 1 — Create a Cloudinary account and grab your credentials

1. Go to https://cloudinary.com/users/register_free and sign up.
2. Once logged in, you'll land on the Cloudinary dashboard. At the top of the page you'll see three values:

   ```
   Cloud name:        dwxyz1234          ← copy this
   API key:           123456789012345    ← copy this
   API secret:        ••••••••••••       ← click "Reveal", then copy this
   ```

3. **Write these three values down** — you'll paste them into Cloudflare in Step 5.
4. You do NOT need to do anything else in Cloudinary. No bucket creation, no upload preset, no configuration. The default settings work perfectly.

> **Security note:** Your API secret is a secret. Never share it with anyone, never commit it to git, never paste it into a chat. You'll only paste it into the Cloudflare Pages environment variables (marked as "Secret" type) in Step 5.

---

## Step 2 — Create the Cloudflare KV namespace

1. Log in to the Cloudflare dashboard → https://dash.cloudflare.com
2. In the left sidebar, click **Workers & Pages**.
3. Click the **KV** sub-tab (or look for "KV namespaces" in the sidebar).
4. Click **Create a namespace**.
5. **Namespace name:** type `YORVIQUE_META` (or any name you like — the name is just a label)
6. Click **Add** (or **Create**).

You should now see your new KV namespace in the list. Note the name — you'll bind it to your Pages project in Step 4.

> **No credit card required** for KV. The free tier gives you 1 GB storage + 100,000 reads/day + 1,000 writes/day, which is plenty for a personal file-sharing tool (1,000 writes/day = 1,000 uploads/day).

---

## Step 3 — Create the Cloudflare Pages project

1. In the Cloudflare dashboard, go to **Workers & Pages**.
2. Click **Create application** → **Pages**.
3. Connect your GitHub repository (or upload the project as a direct upload).
4. Set the project name to `yorvique` (or any name you like).
5. **Build settings:**
   - Framework preset: **None**
   - Build command: *(leave empty — files are already built)*
   - Build output directory: `/` (the project root — just a forward slash)
6. Click **Save and Deploy**.

Cloudflare will deploy the static files and detect `_worker.js` at the project root, automatically using it as the Pages Function in advanced mode with `env.ASSETS` bound to your static assets.

> At this point the site loads, but uploads will return 503 because we haven't added the Cloudinary credentials or KV binding yet. That's expected — continue to Steps 4 and 5.

---

## Step 4 — Bind the KV namespace to the Pages project

1. In the Pages project, go to **Settings** → **Functions** (or **Settings → Bindings**, depending on the dashboard version).
2. Scroll down to **KV namespace bindings**.
3. Click **Add binding**.
4. Configure:
   - **Variable name:** `YORVIQUE_META` ← **MUST MATCH EXACTLY** (uppercase, underscore, no spaces)
   - **KV namespace:** select `YORVIQUE_META` (the namespace you created in Step 2)
5. Click **Save**.
6. Do this for both the **Production** and **Preview** environments (tabs at the top of the Settings page).

> ⚠️ **CRITICAL:** The variable name must be exactly `YORVIQUE_META` — that's what the `_worker.js` code looks for. If you spell it differently (e.g. `YORVIQUE` or `yorvique_meta`), uploads will still return 503.

---

## Step 5 — Set the Cloudinary environment variables

1. In the Pages project, go to **Settings** → **Environment variables**.
2. Add three variables (click **Add variable** for each):

   | Type | Name | Value | Encryption |
   |---|---|---|---|
   | Plain text | `CLOUDINARY_CLOUD_NAME` | (your Cloudinary cloud name, e.g. `dwxyz1234`) | — |
   | Plain text | `CLOUDINARY_API_KEY` | (your Cloudinary API key, e.g. `123456789012345`) | — |
   | **Secret** | `CLOUDINARY_API_SECRET` | (your Cloudinary API secret) | **Encrypted** |

   > For `CLOUDINARY_API_SECRET`, click the **Encrypt** toggle so it's stored as a secret — Cloudflare hides the value from the dashboard after you save it.

3. Do this for both the **Production** and **Preview** environments.
4. Click **Save**.

### (Optional) Additional environment variables

While you're here, you can also add these optional variables:

| Variable | Default | Purpose |
|---|---|---|
| `MAX_FILE_SIZE_MB` | `100` | Max upload size in MiB. Cloudinary's free tier supports up to ~100 MB per file. If you change this, also update `STORAGE.maxFileSizeBytes` in `config/brand-config.js`. |
| `UPLOAD_RATE_LIMIT_PER_H` | `60` | Best-effort per-IP upload limit per hour. |
| `ALLOWED_ORIGIN` | `*` | CORS origin. Set to your exact domain (e.g. `https://yorvique.pages.dev`) to lock down. |

---

## Step 6 — Trigger a new deployment

Bindings and environment variables only take effect on **new deployments**. The current live deployment doesn't know about them yet.

1. In your Pages project, click the **Deployments** tab at the top.
2. Find your most recent deployment (at the top of the list).
3. Click the **`⋯`** (three dots) on the right side of that deployment.
4. Click **Retry deployment**.
5. Wait ~30 seconds for it to finish.

Alternatively, just push any commit to your GitHub repo — that triggers a new deployment automatically.

---

## Step 7 — Test the upload flow

1. Open the deployed site (e.g. `https://yorvique.pages.dev` or your custom domain).
2. Drag a small file (e.g. a PNG or PDF) onto the upload card.
3. Click **Make the link**.
4. Wait for the upload to complete — you should see real upload progress (e.g. "Uploading… 47%").
5. On success, a shareable URL is displayed with a copy button. The URL looks like `https://yorvique.pages.dev/d/AbCdEfGhIjKlMnOpQrSt`.
6. Click **Open** — the file should download (or preview, if it's an image/PDF).
7. Open the link on your phone or send it to a friend — it should still work.

If you still see a 503 error after redeploying, scroll down to the troubleshooting section.

---

## Step 8 — (Optional) Add a custom domain

1. In the Pages project, go to **Custom domains**.
2. Click **Set up a custom domain**.
3. Enter your domain (e.g. `yorvique.example.com`).
4. Cloudflare will guide you through the DNS setup. If your domain is already on Cloudflare, the DNS record is added automatically.

Once the custom domain is active, HTTPS is provisioned automatically and the PWA will be installable from that domain.

---

## Step 9 — (Optional) Lock down CORS

If you're only serving YORVIQUE from a single domain, set `ALLOWED_ORIGIN` to your exact origin:

```
ALLOWED_ORIGIN=https://yorvique.example.com
```

This prevents other websites from making cross-origin upload requests to your worker.

---

## Step 10 — (Optional) Auto-expire old uploads

By default, YORVIQUE keeps uploads **forever**. If you want files to auto-delete after N days to stay within Cloudinary's 25 GB free-tier storage limit (or for privacy), you can set up an expiration rule:

### Option A — Cloudinary's "Auto-delete" feature

1. In Cloudinary, go to **Settings → Upload**.
2. Scroll down to **Auto-deletion**.
3. Enable it and set the number of days (e.g. 30).
4. Save.

After N days, files are automatically deleted from Cloudinary. The KV metadata entry will remain (orphaned), and any subsequent visit to the shareable link will return a clean `404 File not found or expired.` — which is the desired behaviour.

### Option B — Manual cleanup via Cloudinary dashboard

1. In Cloudinary, go to **Media Library**.
2. Filter by files starting with `yorvique_`.
3. Select and delete as needed.

YORVIQUE gracefully handles missing files — the download link returns `404 File not found or expired.` and the UI shows a clean error message.

> If you enable auto-expiration, you may want to mention it in `privacy.html` and `terms.html` so users know.

---

## Step 11 — (Optional) Enable Cloudflare Rate Limiting

The worker has a best-effort per-IP rate limit, but for stronger protection:

1. Go to **Security → WAF → Rate limiting rules**.
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

## Troubleshooting

### "Upload returns 503 'Server is not configured for uploads. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET environment variables.'"

You haven't set the three required Cloudinary environment variables. Go to your Pages project → Settings → Environment variables and add them (Step 5 above). Then trigger a new deployment (Step 6).

### "Upload returns 503 'Server is not configured for uploads. The YORVIQUE_META KV namespace binding is missing.'"

You haven't bound the KV namespace. Go to your Pages project → Settings → Functions → KV namespace bindings and add a binding with variable name `YORVIQUE_META` pointing to your KV namespace (Step 4 above). Then trigger a new deployment (Step 6).

### "Upload returns 502 'Upload failed. The storage backend rejected the file.'"

Cloudinary rejected the upload. Possible causes:

- Your Cloudinary account has hit the free-tier storage limit (25 GB). Delete old files in the Cloudinary Media Library or set up auto-deletion (Step 10).
- The API key or secret are wrong. Re-copy them from the Cloudinary dashboard and update the environment variables in Cloudflare.
- The file is larger than Cloudinary's per-file limit (~100 MB on the free tier).

### "Upload returns 413 'File is too large.'"

The file exceeds `MAX_FILE_SIZE_MB` (default 100 MiB). Either upload a smaller file or raise the environment variable. If you raise it, also update `STORAGE.maxFileSizeBytes` in `config/brand-config.js` so the UI matches.

### "Download returns 404 'File not found or expired.'"

The file was deleted from Cloudinary (e.g. via the Cloudinary dashboard or an auto-expiration rule), or the KV metadata entry was deleted. The KV index and Cloudinary resource are normally in sync, but if you delete one manually, the other becomes orphaned.

### "Bindings/variables don't seem to take effect."

Bindings and environment variables only take effect on **new deployments**. Go to Deployments → ⋯ → Retry deployment. Or push any commit to your GitHub repo.

### "I don't see a 'Bindings' or 'Functions' option in Settings."

Cloudflare occasionally redesigns their dashboard. Look for any of these in the Settings page:

- **Bindings**
- **Functions**
- **Functions & Bindings**
- **KV namespace bindings** (under a "Functions" or "Bindings" section)

### "It says I need to add a payment method for KV."

You should NOT need a payment method for KV. The Cloudflare Workers free tier (which includes KV) does not require a card. If Cloudflare is asking for one, double-check that:

- You're on the **Workers Free** plan (not the Workers Paid plan)
- You're creating a KV namespace, not an R2 bucket (R2 is the one that asks for a card)

### "Where do I see my uploaded files?"

In the **Cloudinary** dashboard (not Cloudflare):

1. Log in to https://cloudinary.com
2. Click **Media Library** in the left sidebar
3. You'll see files with names like `yorvique_AbCdEfGhIjKlMnOpQrSt`. The random part is the shareable ID, so you can match files to shareable URLs.

You can click any file to see its metadata (size, format, upload date) and delete it if needed.

---

## Rolling back

Cloudflare Pages keeps every deployment. To roll back:

1. Go to your Pages project → **Deployments**.
2. Find the deployment you want to roll back to.
3. Click **⋯** → **Rollback to this deployment**.

The rollback is instant.

---

## Quick reference — what goes where

| Thing | Where | How |
|---|---|---|
| Cloudinary cloud name | Cloudflare env var `CLOUDINARY_CLOUD_NAME` | Plain text |
| Cloudinary API key | Cloudflare env var `CLOUDINARY_API_KEY` | Plain text (or Secret for extra safety) |
| Cloudinary API secret | Cloudflare env var `CLOUDINARY_API_SECRET` | **Secret** (encrypted) |
| KV namespace binding | Cloudflare Pages → Settings → Functions → KV namespace bindings | Variable name: `YORVIQUE_META` |
| Buy Me a Coffee URL | `config/brand-config.js` in your repo | `BUY_ME_A_COFFEE_URL: 'https://...'` |
| Brand logo | `yorvique.png` in your repo root | Overwrite the file |
| Max upload size | Cloudflare env var `MAX_FILE_SIZE_MB` AND `config/brand-config.js` `STORAGE.maxFileSizeBytes` | Keep them in sync |

---

© 2026 YORVIQUE. All rights reserved. | developed by [WebSolutionsSA](https://websolutionssa.pages.dev/)
