# Haven

Private todos. No account, works offline, and nobody — including us — can read them.

Haven is a local-first task app: a genuinely good kanban/list task manager, with every task
encrypted client-side (AES-256-GCM, key derived from your passphrase via PBKDF2-SHA256 at
600,000 iterations) before it ever touches storage or the network. Optional sync moves only
ciphertext through a small self-hostable server.

See [`landing.html`](landing.html) for the pitch, or just open [`index.html`](index.html) to use
the app directly.

## Run it locally

No build step. Any static file server works:

```
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed URL — `index.html` for the app, `landing.html` for the marketing page.

To also run the optional sync server locally:

```
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

## Project docs

- [`BUILD_BRIEF.md`](BUILD_BRIEF.md) — product definition and phased build plan. Read this first.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — crypto design, data model, sync protocol.
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — adversaries, defenses, honest limitations.
- [`docs/SECURITY.md`](docs/SECURITY.md) — self-attack writeup: what was actually attacked, what
  was found, what's still an open gap.

## Status

All 8 build phases are done: task management UX, the crypto core, recovery-code account
recovery, the live "you vs the server" encryption reveal, optional multi-device sync, hardening
+ self-attack, and this deploy. Read `docs/SECURITY.md` before trusting it with anything
sensitive — it says plainly what is and isn't defended against.

## Deploying

The frontend (`index.html`, `landing.html`, `css/`, `js/`, `vendor/`) is fully static — deploy it
anywhere that serves static files over HTTPS. Use a host that honors the `_headers` file at the
repo root (Netlify, Cloudflare Pages) so the real CSP/clickjacking headers apply — a host that
ignores `_headers` (e.g. GitHub Pages) falls back to the `<meta>` CSP only, which browsers don't
fully enforce for every directive (see `docs/SECURITY.md`'s clickjacking finding).

The sync server (`server/`) is optional and deploys separately — it's a small Flask app backed by
SQLite, statelessly scoped by bearer token per bucket. See [`server/README.md`](server/README.md).
