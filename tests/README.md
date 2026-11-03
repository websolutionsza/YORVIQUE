[README.md](https://github.com/user-attachments/files/34306778/README.md)
# YORVIQUE — Tests

YORVIQUE does not ship with a unit-test framework (the project is intentionally
framework-free vanilla HTML/CSS/JS). Instead, this file describes a manual test
checklist that walks through every functional requirement.

A quick automated smoke test for the upload API is included in
`tests/smoke-test.mjs` and can be run with:

```bash
# 1. Start the local dev server in one terminal:
node server.mjs

# 2. In another terminal, run the smoke test:
node tests/smoke-test.mjs
```

The smoke test exercises:

- `GET /health` returns 200 "ok".
- `GET /` returns the YORVIQUE homepage.
- `GET /manifest.json` returns valid JSON with `name: "YORVIQUE"`.
- `GET /service-worker.js` returns the SW source.
- `POST /api/upload` with a small text file returns 201 and a JSON body with
  an `id` field.
- `GET /d/<id>` returns the file contents.
- `GET /api/meta/<id>` returns the file metadata.
- `POST /api/upload` with a file larger than `MAX_FILE_SIZE_MB` returns 413.
- `POST /api/upload` with a forbidden extension (`.html`) returns 415.
- `GET /d/<invalid>` returns 404.
- `GET /api/meta/<invalid>` returns 404.

For the full manual checklist (responsive design, PWA install, offline mode,
Buy Me a Coffee no-op behaviour, footer credit link), see
`documentation/deployment-guide.md` → "Verifying the deployment".
