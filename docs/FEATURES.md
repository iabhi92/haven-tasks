# FEATURES.md — North-Star Feature Spec

The full vision for the product, consolidated. This is what we design toward, built in layers.
This is NOT a v1 checklist. Build Layer 1 first (see `BUILD_BRIEF.md` phases). Layers 2–4 are the
roadmap. Legend — Difficulty: Low / Med / High / Research. Signal = how much it impresses a
security reviewer.

## How to use this doc (Claude Code)

- Build Layer 1 completely before touching anything else. It is a shippable, standalone,
  everyone-can-use product on its own.
- Layers 2–4 are sequenced by dependency and value. Do not start a higher layer until the one
  below is solid.
- The three Signature Features (marked ⭐) are the highest signal-per-effort — prioritise them
  once Layer 1 ships.
- Anything marked Research is genuinely hard (thesis-scale). Design the data model to allow it,
  but do not attempt it early.

## Layer 1 — The shippable core (build this first)

### Core task management (table stakes — makes it a good app)

- [x] Add / edit / delete tasks — Low
- [x] Board (kanban) view with drag-and-drop — Low
- [x] List view — Low
- [x] Status (todo / in-progress / done), priority, due date — Low
- [x] Subtasks / nested checklists — Low
- [x] Tags / labels — Low
- [ ] Sort, filter, and saved smart views (Today / Upcoming / Overdue) — Med
- [x] Search (client-side, decrypt-in-memory) — Med
- [x] Fast keyboard entry (type + Enter) + command palette — Med
- [ ] Recurring tasks with recurrence rules — Med
- [ ] Natural-language quick-add, parsed client-side ("call dentist fri 3pm #health") — Med
- [ ] Bulk actions, undo — Low

### Privacy core (the reason it exists)

- [x] End-to-end encryption throughout (see `ARCHITECTURE.md`) — Med · Signal: high
- [x] No-account instant start — Low · Signal: high
- [x] Full offline operation — Low
- [x] Recovery-code flow (humane, honest) — Med · Signal: high
- [ ] Encrypted export/import + portable backups — Med (export exists; import does not yet)
- [x] Self-hostable sync server (optional, off by default) — Med
- [x] "You vs The Server" live transparency panel — Low · Signal: high
- [x] "How your data is protected" page + raw-ciphertext DB dump — Low · Signal: high

## Layer 2 — The distinctive layer (build after Layer 1 ships)

### Verifiable / provable (strongest, most ownable lane)

- [ ] ⭐ Tamper-evident signed task history — append-only, signed change log; silent
      edits/deletions/backdating become provable — High · Signal: very high
- [ ] ⭐ Verifiable frontend — reproducible build with published hashes so users can confirm the
      served code matches the audited code; closes the biggest honest hole in the threat model —
      High · Signal: very high
- [ ] Verifiable, signed backups (prove an export wasn't tampered with) — Med

### The OMG feature (cheap, flashy, honest)

- [ ] ⭐ Fragment-key share links — share a task via URL with the decryption key in the `#`
      fragment (never sent to the server); recipient decrypts locally, the relaying server sees
      only ciphertext — Med · Signal: very high
- [ ] Capability links — scoped, expiring share links — Med

### Recovery, done distinctively (E2EE's #1 killer — solving it uniquely is a real edge)

- [ ] Social recovery / Shamir secret sharing (split recovery key among k-of-n trusted people) —
      High · Signal: high
- [ ] Hardware key / passkey (WebAuthn) unlock as an alternative to passphrase — High · Signal:
      high

### Trust-minimization

- [ ] Metadata resistance — constant-size padded records, batching — High
- [ ] Peer-to-peer serverless sync (WebRTC), no server to trust — High · Signal: high
- [ ] Compartmentalised vaults (work / personal) with separate keys — Med

## Layer 3 — Private intelligence & crypto-novel (the "wait, a todo app does that?" tier)

### On-device AI (the genuinely current, distinctive one)

- [ ] On-device AI assistant — LLM via WebGPU that prioritises, breaks down, and plans, running
      locally so tasks never touch a cloud model; demo = zero network requests — Research ·
      Signal: very high
- [ ] Local automation / rules engine — Med
- [ ] Private on-device productivity analytics — Med

### Cryptographically novel

- [ ] Duress / decoy vault — a second passphrase opens a plausible decoy set; hidden vault is
      unprovable — Med · Signal: high
- [ ] Time-locked tasks — encrypted to unlock at a future date — High
- [ ] Dead-man's-switch — reveal a task to a designated person after inactivity — High
- [ ] Ephemeral / self-destructing tasks via key erasure — Med
- [ ] Post-quantum hybrid key wrapping (harvest-now-decrypt-later defense) — High · Signal: high
- [ ] Selective disclosure / per-field encryption (share title, not notes) — High
- [ ] Proof-of-completion — prove you finished N tasks without revealing which — Research

## Layer 4 — Collaboration under E2EE (the flagship cluster — hardest, biggest)

- [ ] Real-time multi-user editing with the server blind — Research · Signal: very high
- [ ] ⭐ Revocation that works — remove a collaborator, rotate keys, lock them out of future
      content (the problem everyone dodges) — Research · Signal: very high
- [ ] CRDT-based conflict-free multi-device + multi-user merge (replaces last-write-wins) —
      Research
- [ ] Cryptographic delegation — hand off a task with a scoped, time-limited capability — High
- [ ] Encrypted presence — see who's on a shared board without the server learning identities —
      High
- [ ] Encrypted attachments — client-side encrypted, chunked, synced files — High
- [ ] Metadata-aware reminders / web push (ping without the server knowing what) — High

### Ecosystem & polish (interleave as needed; mostly Layer 2+)

- [ ] PWA install (feels native, offline) — Low
- [ ] Native desktop/mobile wrappers (Tauri) — Med
- [ ] Calendar view + CalDAV / iCal interop — Med
- [ ] Import from other task apps — Med
- [ ] Time-tracking + Pomodoro per task — Low
- [ ] Board / project templates — Low
- [ ] On-device location reminders (geofencing, no phone-home) — High
- [ ] Local voice capture, transcribed on-device — High
- [ ] Plugin / extension API — High
- [ ] Themes, full i18n — Low
- [ ] Accessibility: full screen-reader + keyboard support — Med (do NOT skip)

## Signature features (⭐ — the priority once Layer 1 ships)

These carry the most signal per unit of effort and define what makes the product distinctive:

1. **Verifiable frontend + tamper-evident history** — turns "trust me, it's encrypted" into "here,
   verify it yourself." This is the soul of the product.
2. **Fragment-key share links** — the OMG demo: "I sent this through my own server and I can't
   read it." Best jaw-drop-to-effort ratio.
3. **Revocation done correctly** — the hard problem everyone else fudges. The thing that says
   "this person solved something real." (Layer 4 — the long-term flagship.)

## Honest scope note

This is a multi-year product if fully built. Research-tagged items are each individually
thesis-scale, and funded teams ship them over years. The value of this document is architectural:
designing the data model and threat model to anticipate these — even before building them —
signals architect-level thinking. Build in layers. Ship Layer 1. Pick one signature feature at a
time. A small real thing beats a complete list.

## Status note (added after this doc landed)

Everything checked `[x]` above was already built (Phases 1–8 of `BUILD_BRIEF.md`, plus tags and
subtasks added post-launch) before this document was written — cross-referenced and confirmed
against the running app, not assumed. Two items in this document weren't previously tracked
anywhere and are now the acknowledged remaining Layer 1 gaps: **natural-language quick-add
parsing** and **bulk actions + undo**. "Multiple boards/projects" (requested separately, tracked
in `BUILD_BRIEF.md`'s working backlog) doesn't appear in this document at all — the closest
relative here is "Compartmentalised vaults" (Layer 2, separate *keys* per vault), which is a much
heavier crypto-architecture change. What's being built as "multiple boards" is a lighter,
client-side grouping on top of the existing single-DEK model, not a new vault/key boundary —
worth revisiting as real compartmentalised vaults later if that stronger isolation is ever needed.
