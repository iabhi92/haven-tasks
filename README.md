# Haven

Private todos. No account, works offline, and nobody — including us — can read them.

Haven is a local-first task app. It's a genuinely good kanban/list task manager first; end-to-end
encryption is being layered on in phases (see `BUILD_BRIEF.md`). Right now the app is in **Phase
1**: full task management UX, plaintext IndexedDB storage, zero crypto yet.

## Run it locally

No build step. Any static file server works:

```
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed URL.

## Project docs

- [`BUILD_BRIEF.md`](BUILD_BRIEF.md) — product definition and phased build plan. Read this first.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — crypto design, data model, sync protocol.
- [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) — adversaries, defenses, honest limitations.

## Status

Phase 1 complete: board + list views, add/edit/delete, drag-and-drop, status/priority/due date,
search, keyboard quick-add. All data is currently plaintext in IndexedDB — encryption lands in
Phase 2 onward.
