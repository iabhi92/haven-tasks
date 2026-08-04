# THREAT_MODEL.md — Haven

> A working demo says "I can code." This document says "I think like an attacker."
> It is written to be honest about what the system does and does NOT protect against.
>
> Status: Phase 1 (no crypto yet). This document describes the target model for Phase 2+ and is
> the design contract that later phases must satisfy.

## Assets (what we are protecting)

1. **Task contents** — titles, notes, due dates, priorities, status. The primary secret.
2. **Encryption keys** — the DEK, and the passphrase/recovery code that derive the wrapping keys.
3. **Integrity of task data** — a user should not silently get altered data.

## Trust boundaries

- **Trusted:** the user's browser tab while unlocked, and the user's own device.
- **Untrusted:** the network, the sync server, the hosting provider, and anyone with read access
  to the local database or the server database.
- **Key claim:** the operator (developer) is in the *untrusted* set. The design must hold even if
  the operator is malicious or compromised.

## Adversaries and what defends against each

### A1. Malicious or compromised operator / sync server
- **Capability:** full read/write access to the server, sees all stored data and all traffic.
- **Defense:** the server only ever holds ciphertext + non-secret metadata. Keys are derived
  on-device and never transmitted. The operator cannot decrypt tasks.
- **Residual risk:** the server learns metadata — record counts, ciphertext sizes, update timing,
  sync-token activity. A malicious server could also serve **malicious frontend code** (see A5).
  This is the most important honest limitation: E2EE in a web app trusts the code delivery.
  Mitigations: self-hosting, static hosting with integrity, reproducible/pinned frontend builds.

### A2. Network attacker (passive or active)
- **Capability:** intercepts or tampers with traffic.
- **Defense:** TLS in transit; AES-GCM provides confidentiality + integrity at rest, so tampered
  ciphertext fails the GCM auth tag and is rejected rather than silently accepted.
- **Residual risk:** metadata visible to a network observer, similar to A1.

### A3. Attacker with the local database (stolen/shared device, forensic dump)
- **Capability:** reads IndexedDB.
- **Defense:** IndexedDB holds only ciphertext and the wrapped keyring (Phase 3+). Without the
  passphrase or recovery code, it is useless. Key derivation makes offline brute-force of a strong
  passphrase expensive.
- **Residual risk:** a weak user passphrase is brute-forceable offline. We enforce a minimum and
  warn; we cannot force entropy. Plaintext exists in memory while unlocked.
- **KDF choice, stated plainly:** v1 uses PBKDF2-SHA256 at 600,000 iterations, not Argon2id.
  PBKDF2 is meaningfully weaker against an attacker with GPU/ASIC hardware — Argon2id's memory-hard
  design specifically defeats that kind of parallelism, PBKDF2's doesn't. We chose it anyway for
  v1 because the alternative was vendoring a third-party WASM Argon2id implementation without the
  time to properly review it, which is a worse trade than a slower, native, fully-auditable KDF.
  600,000 iterations is still within current OWASP guidance for PBKDF2-SHA256, so this is "weaker
  than the stronger option," not "weak" outright. Documented as a real limitation, not hidden —
  see `docs/ARCHITECTURE.md`'s key-derivation section for the migration path once Argon2id lands.

### A4. Compromised or curious collaborator (future, ongoing shared vault)
- **Status:** still out of scope for v1. This is about *persistent, revocable* multi-user access
  to a vault (Layer 2's "Compartmentalised vaults") — a different, heavier problem than the
  one-shot links in A4b below, since revoking a collaborator means rotating a key others still
  depend on. Named here so it is not forgotten.

### A4b. Anyone who obtains a fragment-key share link
- **Capability:** whoever has the full URL (query string + fragment) can decrypt and view that one
  task, with no login and no rate limiting on the viewer beyond what the relay enforces.
- **Defenses:**
  - The decryption key lives only in the URL fragment, which browsers never transmit to any
    server — the relay stores and serves ciphertext it cannot read (see
    docs/ARCHITECTURE.md §5b). Verified in the self-attack checklist below.
  - The share uses a freshly generated key, not the vault's DEK — obtaining it exposes exactly one
    task snapshot, nothing else in the vault, and nothing about how to derive the DEK.
  - Links expire after 7 days (server-enforced), bounding how long a leaked link stays live.
  - Only a fixed field snapshot is shared (`title`, `notes`, `status`, `priority`, `dueDate`,
    `tags`, `subtasks`) — not the task `id`, `project`, or timestamps.
- **Residual risk, stated plainly:**
  - **No revocation.** Once created, a link works for anyone who has it until it expires — there
    is no "unshare" button. A user who pastes a link somewhere public, or whose browser history is
    exposed, cannot undo that.
  - **Fragment leakage outside the browser's own transmission behavior.** Browsers don't send
    fragments over the network, but the *full URL including the fragment* can still end up in
    browser history, an OS clipboard manager, a screen-recording, or a chat app that a user pastes
    it into — none of which this design can prevent. This is inherent to putting a secret in a
    URL at all, not specific to this implementation.
  - **The relay learns access patterns.** It sees when and how often a given share id is fetched
    (though never by whom without IP logs it may or may not keep), even though it can't read the
    content.

### A5. XSS — the existential threat
- **Capability:** if an attacker can run JavaScript in the app's origin, they can read the DEK and
  plaintext directly from memory before encryption, defeating the entire scheme.
- **Why it dominates:** in a client-side-crypto web app, XSS is not "a vulnerability," it is game
  over.
- **Defenses:**
  - Strict CSP: `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none';
    frame-ancestors 'none'`. No inline scripts, no `eval`, no third-party script origins.
  - **Never** render task content with `innerHTML`. Use `textContent` exclusively for anything
    user-supplied. (Enforced starting Phase 1 — see `js/ui.js`.)
  - No CDN dependencies — vendor everything locally.
  - Minimal dependency count; audit each one.
- **Residual risk:** a supply-chain compromise of a vendored dependency (e.g. `hash-wasm`) or the
  frontend host (A1/A5 overlap).
- **Widened by Phase 6 (optional sync), stated plainly:** `connect-src` is now `*` instead of
  `'self'`, because the sync server runs at a URL the user types in — a static CSP can't allowlist
  a destination it doesn't know in advance. Every other directive (script-src, object-src, etc.)
  stays locked to `'self'`. The real-world cost: before sync existed, a successful XSS payload
  could only ever `fetch()` data back to this app's own origin; now it can exfiltrate to any
  origin. This doesn't change who's protected by default — sync is opt-in, and a user who never
  enables it isn't exposed to this — but it's a genuine widening of the blast radius the moment
  sync is turned on, not a cost-free feature. No mitigation beyond "don't let XSS happen" exists
  for this specific trade-off; noted here so it's an informed choice, not a hidden one.

### A6. Clickjacking / UI redress
- **Defense:** `frame-ancestors 'none'` (CSP) and/or `X-Frame-Options: DENY`.

### A7. Future quantum adversary ("harvest now, decrypt later")
- **Status:** AES-256-GCM is considered quantum-resistant for confidentiality. The asymmetric
  surface is minimal in v1 (no public-key sharing yet). Noted as a design-aware future concern,
  not an active v1 defense.

## Explicit non-goals / honest limitations

1. **Metadata is not hidden.** Record counts, sizes, and timing are visible to the server and
   network. Mitigations (padding, batching) are future work.
2. **Web-delivery trust.** E2EE in a browser trusts that the served code is honest. Self-hosting
   and integrity-pinning reduce, not eliminate, this.
3. **Lose both credentials = data gone.** There is deliberately no server-side reset.
4. **Weak passphrases remain the user's risk.**
5. **Last-write-wins can lose edits** on concurrent multi-device changes until CRDT merge lands.
6. **v1 is single-user for the vault itself.** Persistent, revocable multi-user access
   (Compartmentalised vaults) is out of scope — see A4. One-shot fragment-key share links (A4b)
   exist but are not a substitute: they're single-task, one-way, and have no revocation beyond a
   7-day expiry.
7. **The recovery code becomes a shared secret once sync is joined.** Before sync, it protects one
   device. After a second device joins a sync bucket (docs/ARCHITECTURE.md §5's keyring-bootstrap
   mechanism), the *same* recovery code unwraps the *same* DEK on every joined device — so anyone
   who has it can decrypt the whole synced task list, not just one device's copy. This is inherent
   to how joining works (it's the only secret that lets a second device obtain the same key without
   the server ever seeing it), not a bug, but it does raise the code's blast radius the moment it's
   used for more than one device.
8. **Joining a sync bucket replaces the local DEK — pre-existing local-only tasks become
   inaccessible, not deleted.** If a device already has tasks encrypted under its own independently
   generated DEK before joining someone else's sync bucket, those records are never re-encrypted or
   migrated — they just silently fail to decrypt afterward (the app skips undecryptable records
   rather than crash) and stay invisible in IndexedDB indefinitely. The UI warns about this
   explicitly before a join proceeds, but there's no migration/merge path in v1.

## Self-attack checklist — ✅ run for real in Phase 7, see `docs/SECURITY.md`

- [x] **XSS via task content** — put `<img src=x onerror=alert(1)>` and `<script>` in a task
      title/notes. Confirm inert via `textContent` + CSP.
- [x] **CSP bypass** — try to load an external script; confirm CSP blocks it.
- [x] **IDOR on sync** — can sync token A read or overwrite token B's bucket?
- [x] **IV reuse** — encrypt the same task many times; confirm every IV differs.
- [x] **Key-in-memory exposure** — confirm the DEK is dropped on lock/refresh and never persisted.
- [x] **Plaintext leak to storage** — inspect IndexedDB; confirm zero readable task content.
- [x] **Plaintext leak to network** — inspect every sync request; confirm only ciphertext.
- [x] **Tamper detection** — flip a byte of stored ciphertext; confirm decryption rejects it.
- [x] **Wrong-passphrase behaviour** — confirm it fails closed.
- [x] **Recovery-code entropy** — confirm 256 bits via `crypto.getRandomValues`, not `Math.random`.
- [x] **Deletion is real** — confirm a deleted task's ciphertext is actually removed server-side.
- [x] **Dependency audit** — confirm every dependency is vendored, pinned, integrity-checked.
- [x] **Clickjacking** — confirm the app refuses to be framed. **Found broken on the dev server**
      (meta-only `frame-ancestors` is ignored by browsers) — fixed via a real `_headers` file, but
      only effective once deployed behind a host that honors it. See `docs/SECURITY.md`.
- [x] **Timing on unlock** — note whether unlock failure timing leaks anything meaningful.
- [x] **Share-link key never reaches the relay** — create a share, then fetch its `GET
      /share/<id>` response directly; confirm it contains only `{iv, ciphertext}`, never the
      fragment key or plaintext. See `server/tests/test_share.py`.
- [x] **Share-link tamper detection** — flip a character in the fragment key; confirm the viewer
      fails closed with an error, never partially decrypts or renders content.

## How to read this document (for a reviewer)

Every design decision in `ARCHITECTURE.md` maps to a defense here, and every limitation is stated
rather than hidden. The goal is not to claim the system is unbreakable — it is to demonstrate a
clear-eyed account of exactly what it protects, against whom, and where the honest edges are.
