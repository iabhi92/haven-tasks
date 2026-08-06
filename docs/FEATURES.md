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

## Customer value (why any of this matters to someone who isn't a security reviewer)

Everything below this line is engineering ambition. This section is the other half: what a real
person gets out of it, since that's what decides whether the product gets used at all.

**For the everyday user** — the crypto is invisible to them; what they feel is the benefit, and
that's what should be sold, not the mechanism. No account, start in two seconds. Works on a plane.
Free, no subscription, no ads. Can't sell your data because it can't be read. Real export, no
lock-in — take your data and leave anytime, which most free apps quietly make hard. The everyday
customer doesn't want "AES-GCM," they want a fast, private, no-nonsense place for their tasks that
isn't trying to monetize them.

**For the customer who has an actual reason to care about privacy** — this is the real paying
market: therapists tracking client-related tasks, lawyers under privilege, journalists protecting
sources, doctors, HR handling sensitive cases, founders on confidential deals, activists. For them
the value is concrete: provably confidential task management, so using it doesn't create a
professional or legal exposure the way a normal SaaS to-do app would. The benefit isn't
"encryption," it's "you can use this without breaching a duty of confidentiality."

**Customer-facing features worth building for them specifically** (not reviewer-bait — actual
utility; most already appear above under their own layer, cross-referenced here by customer
benefit rather than technical mechanism):

- Shared team/family boards that stay private — sold as "share a grocery list or a case file
  without a vendor reading it," not as a crypto feature. (Layer 4 collaboration work.)
- Fragment-key share links — "send someone a task or list via a link, no account needed on their
  end." Real convenience, not just a demo. (Layer 2 "OMG feature.")
- Templates — sprint boards, client-onboarding checklists, moving-house lists; not starting from
  blank. (Ecosystem & polish.)
- Calendar/CalDAV sync — fits into a life the customer already has instead of being another silo.
  (Ecosystem & polish.)
- A humane recovery flow — customers are afraid "encrypted" means "I'll lose everything one day."
  Already partly addressed (recovery code, Layer 1); the honest reassurance that removes this fear
  is itself a customer feature, not a crypto one.
- Import from other task apps — the real barrier to switching is the data already living
  elsewhere; killing that barrier is a customer feature. (Layer 1 gap, tracked below.)

**The honest strategic point:** a recruiter reading this doc wants hard crypto; a customer wants
speed, trust, no lock-in, and no reason to be scared of losing their data. The mature move —
right for both — is building the security so it disappears. The customer should feel a fast,
pleasant, private app and never once need to understand a threat model.

**One-sentence throughline**, usable anywhere the product needs a pitch: *"A task app that's fast,
free, and actually yours — no account, works offline, and no company can read, sell, or lose your
data."*

## Layer 1 — The shippable core (build this first)

### Core task management (table stakes — makes it a good app)

- [x] Add / edit / delete tasks — Low
- [x] Board (kanban) view with drag-and-drop — Low
- [x] List view — Low
- [x] Status (todo / in-progress / done), priority, due date — Low
- [x] Subtasks / nested checklists — Low
- [x] Tags / labels — Low
- [x] Sort, filter, and saved smart views (Today / Upcoming / Overdue) — Med
- [x] Search (client-side, decrypt-in-memory) — Med
- [x] Fast keyboard entry (type + Enter) + command palette — Med
- [x] Recurring tasks with recurrence rules — Med
- [x] Natural-language quick-add, parsed client-side ("call dentist fri 3pm #health") — Med
- [x] Bulk actions, undo — Low

### Privacy core (the reason it exists)

- [x] End-to-end encryption throughout (see `ARCHITECTURE.md`) — Med · Signal: high
- [x] No-account instant start — Low · Signal: high
- [x] Full offline operation — Low
- [x] Recovery-code flow (humane, honest) — Med · Signal: high
- [x] Encrypted export/import + portable backups — Med (both now exist; see the comment above
      `exportTasks()` in `js/app.js` — "encrypted" here describes where imported data lands, not
      a separately-encrypted file format, which would be a distinct, unbuilt feature)
- [x] Self-hostable sync server (optional, off by default) — Med
- [x] "You vs The Server" live transparency panel — Low · Signal: high
- [x] "How your data is protected" page + raw-ciphertext DB dump — Low · Signal: high

## Layer 2 — The distinctive layer (build after Layer 1 ships)

### Verifiable / provable (strongest, most ownable lane)

- [x] ⭐ Tamper-evident signed task history — append-only, signed change log; silent
      edits/deletions/backdating become provable — High · Signal: very high. Shipped: per-device
      Ed25519-signed, hash-chained log (`js/store.js`'s `historyLog`), "Verify history" panel in
      the app. **Local-only in v1** — see docs/ARCHITECTURE.md §5c for the honest scope limit
      (doesn't yet defend against a malicious sync server, only local non-privileged tampering).
- [x] ⭐ Verifiable frontend — reproducible build with published hashes so users can confirm the
      served code matches the audited code; closes the biggest honest hole in the threat model —
      High · Signal: very high. Shipped: browser-enforced SRI on every entry `<script>`/`<link>`
      tag (`scripts/generate-integrity.mjs`) plus a published `integrity.json` covering everything
      SRI can't reach (ES module imports — a real browser-platform gap, not skipped). See
      docs/ARCHITECTURE.md §5d for exactly what's browser-enforced vs. independently-checkable.
- [ ] Verifiable, signed backups (prove an export wasn't tampered with) — Med

### The OMG feature (cheap, flashy, honest)

- [x] ⭐ Fragment-key share links — share a task via URL with the decryption key in the `#`
      fragment (never sent to the server); recipient decrypts locally, the relaying server sees
      only ciphertext — Med · Signal: very high. Shipped: `shared.html`/`js/shared.js`,
      `POST /share`/`GET /share/<id>` in `server/routes.py`, see docs/ARCHITECTURE.md §5b.
- [x] Capability links — scoped, expiring share links — Med. Shipped: configurable expiry
      (1h/1d/7d/30d), optional burn-after-reading (view-count limit), and sender-side revocation,
      all as extensions to the fragment-key share links above — see docs/ARCHITECTURE.md §5b.

### Recovery, done distinctively (E2EE's #1 killer — solving it uniquely is a real edge)

- [x] Social recovery / Shamir secret sharing (split recovery key among k-of-n trusted people) —
      High · Signal: high. Shipped: hand-implemented GF(256) SSS (`js/crypto.js`), splits the
      existing recovery code itself so reconstruction re-enters the existing recovery-code unlock
      flow unchanged — see docs/ARCHITECTURE.md §4b.
- [x] Hardware key / passkey (WebAuthn) unlock as an alternative to passphrase — High · Signal:
      high. Shipped: `largeBlob`-based (not `prf` — real authenticator/test-tooling support for
      `largeBlob` was verifiable end-to-end, see docs/ARCHITECTURE.md §4c for why), a third
      parallel wrap of the DEK alongside the passphrase and recovery-code copies. Passphrase
      remains fully functional; this adds a door, doesn't replace one.

### Trust-minimization

- [ ] Metadata resistance — constant-size padded records, batching — High
- [ ] Peer-to-peer serverless sync (WebRTC), no server to trust — High · Signal: high
- [ ] Compartmentalised vaults (work / personal) with separate keys — Med

## Layer 3 — Private intelligence & crypto-novel (the "wait, a todo app does that?" tier)

### On-device AI (the genuinely current, distinctive one)

- [ ] On-device AI assistant — LLM via WebGPU that prioritises, breaks down, and plans, running
      locally so tasks never touch a cloud model; demo = zero network requests — Research ·
      Signal: very high
- [x] Local automation / rules engine — Med. Shipped: three triggers (task
      marked Done, due date passes while not Done, task created with a
      specific tag) × five actions (add/remove tag, set priority, set
      status, move to project), evaluated entirely client-side against the
      already-decrypted task list — no server involved. Rules are encrypted
      and stored the same way tasks are, and (like ephemeral tasks and the
      decoy vault) never sync. Deliberately non-chaining: a rule's own
      effect is never itself fed back in as a trigger for another rule in
      the same pass, closing off the entire "rule A sets off rule B sets
      off rule A" class of bug rather than trying to detect it at runtime.
      See docs/ARCHITECTURE.md "Local automation rules".
- [x] Private on-device productivity analytics — Med. Shipped as a snapshot,
      not a history-over-time view: total tasks, completion rate, overdue
      count, by-status/by-priority/by-project breakdowns, top tags, and
      subtask completion rate, all computed instantly from the task list
      already decrypted in memory (`js/insights.js`, a pure function, no
      IO). **Deliberately doesn't show trends over time** (tasks completed
      per day, streaks) — that would need a `completedAt` field this app
      doesn't track, and approximating it from `updatedAt` (bumped on *any*
      edit, not just completion) would silently misdate a task edited after
      it was finished. Shipping an honest snapshot beat shipping a
      time-series chart quietly built on a wrong assumption. See
      docs/ARCHITECTURE.md "On-device insights".

### Cryptographically novel

- [x] Duress / decoy vault — a second passphrase opens a plausible decoy set — Med · Signal: high.
      Shipped: the decoy vault is a fully independent vault (own DEK, own IndexedDB database, own
      tamper-evident history signing identity) selected by which passphrase the unlock form
      accepts — the app behaves identically either way, no visible "you're in the decoy" state
      anywhere. **Scope correction from this line's original wording:** "hidden vault is
      unprovable" overclaims what a Med-effort implementation actually delivers — someone with
      raw access to the local IndexedDB (or reading this project's own published source) can tell
      a decoy is *configured*, just not what's in it or its passphrase. True existence-unprovable
      deniability under forensic examination is the harder thing Layer 5's "Cryptographically
      deniable encryption" item is for; see docs/ARCHITECTURE.md "Duress / decoy vault" for
      the full honest scope, including a real timing side-channel on unlock that a sufficiently
      careful adversary could exploit.
- [ ] Time-locked tasks — encrypted to unlock at a future date — High
- [ ] Dead-man's-switch — reveal a task to a designated person after inactivity — High
- [x] Ephemeral / self-destructing tasks via key erasure — Med. Shipped: each
      self-destructing task is encrypted under its own per-task key (not the
      shared vault DEK), itself wrapped under the DEK; "burning" deletes just
      that wrapped key, which AES-GCM's own construction makes enough to
      make the ciphertext permanently undecryptable — no separate secure-wipe
      step needed. Two triggers: a time-based fuse (checked lazily whenever
      the board re-renders, plus a 20s backstop interval for an idle tab) and
      "burn after reading" (erases once opened). **Local-only** — excluded
      from sync entirely, so the erasure guarantee never has to account for a
      copy of the wrapped key already sitting on a second device or the sync
      server — see docs/ARCHITECTURE.md "Ephemeral tasks" for the honest
      scope note on what this does and doesn't guarantee.
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

- [x] PWA install (feels native, offline) — Low. Shipped: manifest.json +
      sw.js caching the app shell (HTML/CSS/JS/icons) so a reload works
      fully offline, not just incidentally when the browser's normal HTTP
      cache happens to still have it. Scoped to app.html only — the
      marketing pages don't offer an install prompt.
- [ ] Native desktop/mobile wrappers (Tauri) — Med
- [x] Calendar view + CalDAV / iCal interop — Med. Shipped as a month-grid
      view of every task with a due date, plus one-way .ics export
      (js/ical.js) for importing into Google Calendar/Apple
      Calendar/Outlook. **Not live two-way CalDAV sync** — that's a
      materially bigger scope (a CalDAV server), and "Med" difficulty here
      means the interop file format, not the protocol.
- [x] Import from other task apps — Med. Shipped as CSV import
      (js/csv.js) with alias-based column mapping (Title/Content/Task,
      Due/Date/Deadline, Priority, Tags/Labels, etc.) covering common
      Todoist/TickTick/generic spreadsheet export shapes. **Best-effort
      aliasing, not a maintained per-app integration** — export schemas
      vary and change without notice; unrecognized columns are silently
      ignored rather than rejecting the whole file.
- [x] Time-tracking + Pomodoro per task — Low. Shipped: a 25-minute
      countdown timer scoped to whichever task's edit modal is open,
      accumulating into a running `timeSpentSeconds` total that persists
      and syncs like any other task field. No background timer survives
      closing the modal — closing it (Cancel/Save/Delete/click-outside)
      always saves whatever elapsed first, never discards it.
- [x] Board / project templates — Low. Shipped: 5 starter task sets
      (js/templates.js — sprint board, client onboarding, moving house,
      weekly review, freelance kickoff) applied via the exact same
      addTask() pipeline a hand-typed task goes through, so a
      template-created task is indistinguishable afterward — same
      encryption, same history entry, same automation-rule triggers.
- [ ] On-device location reminders (geofencing, no phone-home) — High
- [ ] Local voice capture, transcribed on-device — High
- [ ] Plugin / extension API — High
- [ ] Themes, full i18n — Low
- [ ] Accessibility: full screen-reader + keyboard support — Med (do NOT skip)

## Layer 5 — Research frontier (design horizon, not a build queue)

Everything here is genuinely thesis-scale. Listed so the data model and threat model can stay
compatible with them, not because any are queued. None of these change the product's position
until Layer 1 is running — that's not a caveat to skim past, it's the actual ordering rule.

### Hiding access patterns (the deep version of metadata resistance)

- [ ] Oblivious sync / ORAM — the server can't tell which task you're reading or writing, only
      that you did something. Padding hides sizes; ORAM hides access patterns. Research
- [ ] Private Information Retrieval (PIR) — fetch a specific blob from the server without the
      server learning which one you fetched. Research
- [ ] Sealed-sender sharing — hide who shared with whom from the server, not just the contents
      (Signal does this for messages); makes the social graph invisible. Research

### Search and compute over ciphertext (where encryption fights hardest)

- [ ] Dynamic searchable encryption with forward privacy (DSSE) — encrypted search that doesn't
      leak information when a new task is added; the naive version leaks on every update, forward
      privacy is the hard fix. Research
- [ ] Multi-party computation for shared analytics — a team sees aggregate stats computed across
      members' encrypted boards without anyone seeing anyone else's tasks. Research
- [ ] Zero-knowledge proofs of task state — prove "all my P0s are done" without revealing what
      they are. zk-SNARKs. Research

### Making sharing actually safe (these plug real holes in the collaboration story)

- [ ] ⭐ Key transparency / auditable key directory — verify a shared-with recipient's real public
      key wasn't swapped by the server (a MITM on the sharing feature). Without this, E2EE sharing
      is only as trustworthy as the key server — the missing piece under Layer 4's "Revocation."
      Reference: CONIKS / Key Transparency. High · Signal: very high
- [ ] Threshold encryption for shared boards — require k-of-n members to approve or decrypt, so no
      single member or the server can act alone. High

### Time and self-healing (the elegant crypto)

- [ ] ⭐ Forward secrecy + post-compromise security via ratcheting — a Double-Ratchet-style scheme
      applied to task history, so a leaked device key doesn't expose past tasks and security
      self-heals going forward. Research · Signal: very high
- [ ] Cryptographically deniable encryption — beyond the duress vault: make it mathematically
      unprovable that a given ciphertext decrypts to anything at all. Research

### Auth that leaks nothing

- [ ] PAKE / OPAQUE for sync auth — authenticate to the optional sync server without it ever
      seeing anything password-derived, so even the login leaks zero. The rigorous version of "no
      account to breach." High

**If forced to pick two:** key transparency (makes a future sharing feature genuinely secure
instead of trust-the-server secure) and forward secrecy via ratcheting (upgrades "encrypted" to
"encrypted and self-healing"). Those are the two a serious cryptographer would zero in on — noted
here so a future pass through this layer isn't starting from zero, not as a commitment to build
either soon.

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
