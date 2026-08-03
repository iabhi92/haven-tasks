# BUILD_BRIEF.md — Haven (private tasks)

This is the master brief. Read this first, then `docs/ARCHITECTURE.md` and `docs/THREAT_MODEL.md`.
Build in the phase order below. Do not skip Phase 1 (the app must be good before it is encrypted).

## What we are building

A free, browser-based, local-first task app that is end-to-end encrypted. Anyone can open a URL
and use it in two seconds — no signup, no install, no email. Task data lives encrypted on the
user's own device. Sync across a user's devices is optional, and when enabled the server only
ever stores ciphertext.

One-sentence pitch: **Private todos. No account, works offline, and nobody — including the
developer — can read them.**

## The core principle (do not violate this)

It must be a genuinely good task app first, and encrypted second. Nobody switches to a worse
todo app because it is private. Privacy is the reason to trust it, not the reason to use it. If
the UX is not smooth, the security is irrelevant because no one stays.

## Non-negotiables

- Plaintext task data never leaves the browser's memory unencrypted. Not to disk (IndexedDB
  stores ciphertext only, from Phase 3 on), not to the network (server receives ciphertext only).
- No accounts, no passwords sent to a server. Encryption keys are derived on-device from a user
  passphrase and never transmitted.
- Zero build step for the frontend. Vanilla JS + native browser APIs. Static-deployable to any
  free host.
- XSS is treated as an existential threat, not a bug class. Never use `innerHTML` with task
  content; strict CSP from day one.
- Honest about limits. Key recovery, metadata leakage, and last-write-wins conflicts are
  documented, not hidden.

## Tech stack

- Frontend: Vanilla JavaScript (ES modules), HTML, CSS. No framework, no bundler, no build step.
- Crypto: Web Crypto API (AES-256-GCM) + Argon2id via hash-wasm (vendored locally) for passphrase
  key derivation, with a documented PBKDF2-SHA256 (600k iterations) fallback.
- Local storage: IndexedDB (ciphertext records + wrapped keys + KDF params only, from Phase 3).
- Optional sync server: a dumb encrypted-blob store (Flask).
- Tests: pytest (sync server), Playwright (e2e), crypto unit tests against known vectors.
- Deploy: static frontend to GitHub Pages / Netlify / Cloudflare Pages.

## Phased build plan

- **Phase 0 — Scaffold. ✅ Done.** Static shell, CSS baseline, empty ES-module layout, strict CSP
  meta tag from day one.
- **Phase 1 — The good task app (NO crypto yet). ✅ Done.** Board (kanban, drag-and-drop) and list
  view. Add/edit/delete. Status, priority, due date. Search. Fast keyboard entry. Plaintext
  IndexedDB for now — this phase is purely about UX. Gate: would a stranger happily use this daily?
- **Phase 2 — Crypto core (isolated module). ✅ Done.** `crypto.js` per `docs/ARCHITECTURE.md`,
  pure and unit-tested against all six vectors (`js/crypto.test.mjs`) before any wiring. Ships with
  PBKDF2-SHA256 (the documented fallback), not Argon2id — see `docs/ARCHITECTURE.md`'s
  key-derivation section for why and the migration path. **Not yet wired into the app** — that's
  Phase 3.
- **Phase 3 — Encrypt the storage layer. ✅ Done.** Lock/unlock flow, encrypt-before-store,
  decrypt-on-load, DEK in memory only, explicit Lock action in the rail. Gate verified in an
  automated DevTools-equivalent check (raw IndexedDB dump inspected directly): every task record
  is `{id, iv, ciphertext, updatedAt}` — no title, notes, status, priority, or due date anywhere
  outside the ciphertext. **No recovery code yet** — that's Phase 4, deliberately not pulled
  forward; losing the passphrase right now means the data is unrecoverable, matching the honest
  v1-in-progress state, not a hidden gap.
- **Phase 4 — Recovery + onboarding.** Passphrase + recovery code at first run, DEK wrapped twice.
- **Phase 5 — "You vs The Server" reveal.** Live plaintext/ciphertext split panel + "dump my local
  database" page.
- **Phase 6 — Optional sync (Flask blob store).** Random bearer token, push/pull ciphertext only,
  last-write-wins.
- **Phase 7 — Hardening + self-attack.** Server-enforced CSP, innerHTML audit, vendored deps with
  SRI, `docs/SECURITY.md` self-attack writeup.
- **Phase 8 — Ship.** Static deploy, landing page, optional sync server deployed separately.

## Definition of done (v1)

- A stranger can use it as a daily task app without ever thinking about crypto.
- IndexedDB and the sync server contain only ciphertext — provably, on screen.
- Losing the passphrase is recoverable via recovery code; losing both is honestly unrecoverable.
- Strict CSP, no innerHTML on task content, minimal dependencies, all vendored.
- `THREAT_MODEL.md` and `SECURITY.md` are complete and honest.
- pytest + Playwright + crypto unit tests all green in CI.

## How to drive this with Claude Code

- Work one phase per session. End each in a committed, working state.
- For Phase 2, insist on isolated unit tests passing against the provided vectors before
  integration.
- Treat `docs/ARCHITECTURE.md` as the source of truth for anything crypto.
- After Phase 3 and Phase 6, manually verify the "only ciphertext" gate in DevTools yourself.
