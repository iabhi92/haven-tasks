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
  sync-token activity. A malicious *frontend* host (a different party than the sync server in this
  architecture, but the same class of risk) could also serve **malicious frontend code** (see A5).
  This is the most important honest limitation: E2EE in a web app trusts the code delivery.
  Mitigations: self-hosting, SRI-pinned entry scripts/stylesheets and a published integrity
  manifest for everything else (docs/ARCHITECTURE.md §5d — shipped, not just a Mitigations bullet
  anymore, though it reduces rather than eliminates this trust requirement, see the non-goals
  section below for exactly where the line is).

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

### A3b. Something that silently corrupts or backdates local task data (bug, rogue extension, disk bit rot)
- **Capability:** direct read/write access to this device's IndexedDB, at the same level the app's
  own JavaScript has — a buggy migration, a misbehaving browser extension, or storage-layer
  corruption that rewrites a task record's ciphertext or timestamp without going through the app's
  normal edit path.
- **Defense:** the tamper-evident signed history log (docs/ARCHITECTURE.md §5c). Every real edit
  is hash-chained and signed with a per-device Ed25519 key at the time it happens; the "Verify
  history" panel recomputes the chain and reports the first entry where either the link or the
  signature doesn't check out, rather than trusting the log's own stored order and content is exactly
  what it claims to be.
- **Residual risk, stated plainly:** this defends against tampering that does *not* also
  consistently rewrite `signingKeyLog` (stored in the same keyring record). An attacker with the
  same access level as this device's own JavaScript — i.e. someone who has already achieved what
  A5 (XSS) achieves — could rewrite the log and the trusted key list together and the check would
  pass. This is the same "local compromise defeats local-only defenses" limit every purely local
  integrity mechanism has; it's not a substitute for A5's own defenses, it's a check against a
  narrower class of *non-privileged* corruption. The log also isn't synced anywhere yet, so it
  doesn't currently defend against A1 (a malicious sync server) either — see §5c's stated scope
  limit.

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
  - Links expire after a sender-chosen period (1 hour to 30 days, default 7 days,
    server-clamped), bounding how long a leaked link stays live.
  - Only a fixed field snapshot is shared (`title`, `notes`, `status`, `priority`, `dueDate`,
    `tags`, `subtasks`) — not the task `id`, `project`, or timestamps.
  - **Revocation exists** (capability links, docs/ARCHITECTURE.md §5b) — the sender can delete a
    share immediately via `DELETE /share/<id>`, and optionally cap it to a fixed number of views
    (burn-after-reading) at creation time. This closes most of what used to be an open "no
    revocation" gap; see the residual risk below for what it doesn't close.
- **Residual risk, stated plainly:**
  - **Revocation isn't retroactive.** If a recipient already loaded and read the link before the
    sender revokes it, revocation stops *future* access, not the access that already happened —
    there's no way to un-view something once it's been decrypted client-side. This is inherent to
    any share-a-secret design, not specific to this implementation.
  - **Fragment leakage outside the browser's own transmission behavior.** Browsers don't send
    fragments over the network, but the *full URL including the fragment* can still end up in
    browser history, an OS clipboard manager, a screen-recording, or a chat app that a user pastes
    it into — none of which this design can prevent. This is inherent to putting a secret in a
    URL at all, not specific to this implementation.
  - **The relay learns access patterns.** It sees when and how often a given share id is fetched
    (though never by whom without IP logs it may or may not keep), even though it can't read the
    content.

### A4c. A social recovery share holder (one of k-of-n trusted people)
- **Capability:** holds one piece of a split recovery code (docs/ARCHITECTURE.md §4b).
- **Defense:** Shamir's information-theoretic guarantee — any `k-1` shares (however many people
  collude, short of the threshold) reveal *nothing* about the recovery code, not even a probabilistic
  edge over guessing blind. This isn't "hard to break," it's mathematically nothing to work with,
  the same property the scheme has always had since 1979.
- **Residual risk, stated plainly:**
  - **`k` colluding (or coerced) share holders can fully recover the vault**, same as anyone who
    obtains the plain recovery code today — social recovery doesn't add a new secret, it
    redistributes the existing one. Choosing `k` and who holds shares is entirely the user's trust
    call; the app enforces nothing about who a share goes to.
  - **A share holder is a new place the code can leak from that didn't exist before** — a share
    holder who mishandles or is phished for their share is a real, new attack surface, even though
    that one share alone is useless. Splitting the code among more people increases the number of
    parties who need to *individually* be trustworthy for the scheme to hold, even though it also
    means no single one of them can do damage alone.
  - **No revocation.** Once shares are distributed, there's no way to invalidate a share someone
    already has short of generating an entirely new recovery code (which requires unlocking
    normally first) and redistributing fresh shares — the same limitation A4b's share links have,
    for the same underlying reason: a secret already handed out can't be un-handed-out.

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
2. **Web-delivery trust.** E2EE in a browser trusts that the served code is honest. As of the
   Verifiable frontend feature (docs/ARCHITECTURE.md §5d), entry-point scripts/stylesheets are
   SRI-pinned (browser-enforced) and every served JS/CSS file's hash is published in
   `integrity.json` (independently checkable). This reduces, but by design cannot eliminate, this
   trust requirement — SRI has no effect on ES module `import` statements (a real browser-platform
   gap, not an oversight here, see §5d), and a host that could tamper with the app could in
   principle tamper with `integrity.json` too; the manifest is checkable by a third party who
   fetches it independently, not enforced against a compromised host serving both consistently.
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
- [x] **Burn-after-reading is enforced atomically** — a `maxViews=1` share allows exactly one
      successful view; the second attempt 404s. See
      `server/tests/test_share.py::test_burn_after_reading_expires_after_one_view`.
- [x] **Revocation actually revokes** — `DELETE /share/<id>` makes an immediately-following `GET`
      404, including a link that worked seconds earlier. See
      `server/tests/test_share.py::test_revoke_makes_share_immediately_unavailable`.
- [x] **History tamper detection — content tampering** — directly overwrite one stored history
      entry's `payloadHash` in IndexedDB (bypassing the app entirely). "Verify history" reports the
      exact entry index and correctly attributes it to a signature mismatch, not a chain break.
- [x] **History tamper detection — chain break** — directly delete a middle entry from the
      `historyLog` IndexedDB store. "Verify history" reports the break at the correct position and
      correctly attributes it to the chain link, not a signature.
- [x] **History key rotation preserves old verifiability** — reset the passphrase via recovery
      code (which rolls a fresh signing key by design, docs/ARCHITECTURE.md §5c). Confirmed
      entries signed before the reset still verify afterward, and a new entry signed after the
      reset verifies under the new key — both segments of the chain check out under one "Verify
      history" run.
- [x] **Shamir field arithmetic is actually correct, not just plausible-looking** — found a real
      bug this way: an initial GF(256) table built with generator `2` produced shares that failed
      to reconstruct (caught by `js/crypto.test.mjs`'s round-trip vectors before ever reaching
      manual testing, exactly because "run it for real" was the standard, not "the algorithm looks
      textbook-correct").
- [x] **Social recovery: k-of-n reconstructs, k-1 does not** — split a real recovery code 3-of-5
      through the actual UI, reconstructed successfully from three different 3-subsets of the five
      shares, and confirmed the app never advances past the share-collection screen with only 2.
- [x] **Social recovery: garbage/mismatched shares fail closed** — an invalid share string is
      rejected before being added; a duplicate share is rejected; shares from two different split
      operations (different `k`) are rejected as mismatched before ever attempting reconstruction.
- [x] **SRI is actually enforced, not just present** — deliberately corrupted `app.js`'s
      `integrity` attribute in a throwaway copy and confirmed Chromium blocks the resource
      (`Failed to find a valid digest... The resource has been blocked`) and the app never
      initializes, rather than just checking the attribute's text is non-empty.
- [x] **integrity.json has no drift** — recomputed every listed file's SHA-384 independently and
      confirmed it matches the manifest exactly, catching the case where a file was edited without
      re-running `scripts/generate-integrity.mjs`.

## How to read this document (for a reviewer)

Every design decision in `ARCHITECTURE.md` maps to a defense here, and every limitation is stated
rather than hidden. The goal is not to claim the system is unbreakable — it is to demonstrate a
clear-eyed account of exactly what it protects, against whom, and where the honest edges are.
