# ARCHITECTURE.md — crypto, data model, sync

This is the source of truth for anything security-critical. Do not improvise key handling.
Every primitive below is a standard, reviewed construction composed correctly — we are NOT
inventing crypto.

**Status: Phase 6 complete.** `js/crypto.js` (Phase 2) is wired into `app.js`/`store.js` (Phase 3):
a real lock/unlock flow, encrypt-before-store on every write, decrypt-on-load on unlock, DEK held
only in an in-memory module variable, explicit Lock action. Verified by direct inspection of the
raw IndexedDB contents — every task record is `{id, iv, ciphertext, updatedAt}`, nothing else.

Recovery (Phase 4) is implemented per §4 below: the keyring record now has the full
`{kdf, kdfParams, salt, wrappedDek, wrapIv, saltRecovery, wrappedDekRecovery, wrapIvRecovery,
version}` shape. A recovery code is generated at setup, the DEK is wrapped a second time under it,
and the code is shown once behind a forced confirmation checkbox before the app unlocks. "Forgot
passphrase?" on the unlock screen recovers via the code and sets a new passphrase — verified the
same recovery code keeps working after a reset, matching §2's "recovery wrap is unaffected"
guarantee for ordinary passphrase changes.

**Deliberately not done:** the onboarding-order part of Phase 4 (reaching a first created task
before any crypto concept) — Phase 3's passphrase-first gate was kept as an explicit choice, not
restructured. See `BUILD_BRIEF.md`'s Phase 4 entry.

**§6's reveal is implemented per spec**, but as a third rail view inside `app.js`/`ui.js` rather
than a standalone `js/reveal.js` module — a deliberate deviation from §7's originally-planned
layout below. The reveal logic (a live `encryptTask()` call on keystroke, a real `getAllTasks()`
dump) is small and tightly coupled to the same in-memory `dek`/`tasks` state every other view
already reads, the same way the lock screen's logic lives in `app.js` rather than its own module —
splitting it out would have added an import boundary without a real separation-of-concerns benefit.

**Phase 6 (§5) is implemented, with one protocol extension beyond the original spec below — a real
gap found during implementation, not a planned feature.** §5 as originally written syncs only task
records, which means two devices can move ciphertext between each other but neither ever obtains
the *key* to decrypt the other's copy — nothing in the original design establishes a shared DEK
across devices. Fixed by adding a `/sync/keyring` endpoint (`server/routes.py`) that republishes a
device's *recovery*-wrapped DEK (never the passphrase-wrapped one) per sync token. "Joining" a
bucket now means: fetch that bootstrap material, unwrap it with the recovery code to obtain the
shared DEK, verify the joining device's own current local passphrase is actually correct (by
attempting to unwrap its *existing* local `wrappedDek` — the result is discarded, this is a
correctness check only, never trusted blindly), then re-wrap the shared DEK under that verified
local KEK and adopt the shared `saltRecovery`/`wrappedDekRecovery`/`wrapIvRecovery` locally too.
See `docs/THREAT_MODEL.md` items 7–8 for what this changes about the recovery code's blast radius
and what happens to a joining device's pre-existing local-only tasks.

`connect-src` in the CSP meta tag is now `*` instead of `'self'` — the sync server runs at a
user-typed URL a static CSP can't allowlist in advance. Documented as a real widening of the XSS
blast radius in `docs/THREAT_MODEL.md`'s A5 section, not a silent change.

## 1. Key hierarchy

Three layers. The point of the hierarchy is that changing the passphrase re-wraps one small key
instead of re-encrypting all data.

```
passphrase ──Argon2id──> KEK (Key-Encryption-Key, 256-bit, in memory only)
recovery code ──Argon2id──> KEK_r (recovery KEK, 256-bit, used once)
                              │
                              ├─ wraps ─┐
                              ▼         ▼
                          DEK (Data-Encryption-Key, random 256-bit AES-GCM key)
                              │
                              └─ encrypts every task record
```

- **KEK**: derived from the user passphrase. Never stored, never transmitted. Lives in memory
  only while unlocked; discarded right after it unwraps the DEK.
- **DEK**: a random 256-bit key generated once at setup. This is what actually encrypts tasks.
  Stored only in wrapped (encrypted) form. Held in memory as a non-extractable `CryptoKey` while
  the app is unlocked.
- **KEK_r**: derived from a high-entropy recovery code, used to wrap a second copy of the DEK so
  the user can recover if they forget the passphrase.

### Key derivation — PBKDF2-SHA256 (v1), Argon2id documented as the future upgrade

**v1 ships with the documented fallback, not Argon2id.** `js/crypto.js` derives KEK/KEK_r via
PBKDF2-SHA256 at 600,000 iterations (32-byte output), native to Web Crypto — no WASM library to
vendor, review, keep patched, or trust. This was a deliberate choice, not a shortcut: this
document's own non-negotiable is "do not improvise key handling," and vendoring a third-party
Argon2id/hash-wasm build under time pressure without properly reviewing it would have been exactly
that kind of improvisation. PBKDF2 is weaker than Argon2id against GPU/ASIC brute-force of a weak
passphrase — see `docs/THREAT_MODEL.md` A3 for the honest accounting of that cost.

Original Argon2id parameters, preserved here as the intended upgrade path: memory = 65536 KiB
(64 MB), iterations = 3, parallelism = 1, hashLength = 32, salt = 16 random bytes. Migrating later
means adding `"argon2id"` as a second value of the `kdf` field below and deriving accordingly —
existing PBKDF2 keyrings keep working unchanged.

- Store salt and the KDF parameters alongside the wrapped DEK (they are not secret).

### DEK generation

```js
const dek = await crypto.subtle.generateKey(
  { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]
); // extractable:true so we can wrap it; re-import non-extractable for use if desired
```

### Wrapping the DEK

Wrapping = AES-256-GCM encrypt of the raw DEK bytes under the KEK, with a random 96-bit IV.

- Export DEK raw bytes → encrypt with KEK → store `{ wrappedDek, wrapIv }`.
- Do the same under KEK_r → store `{ wrappedDekRecovery, wrapIvRecovery, saltRecovery }`.

### Stored key material (in IndexedDB, a single keyring record)

```json
{
  "kdf": "pbkdf2-sha256",
  "kdfParams": { "iterations": 600000 },
  "salt": "<base64>",
  "wrappedDek": "<base64 ciphertext>",
  "wrapIv": "<base64>",
  "saltRecovery": "<base64>",
  "wrappedDekRecovery": "<base64>",
  "wrapIvRecovery": "<base64>",
  "signingPublicKey": "<base64, current active key, not secret>",
  "wrappedSigningKey": "<base64 ciphertext>",
  "signingKeyWrapIv": "<base64>",
  "signingKeyLog": [{ "publicKey": "<base64>", "startedAt": 1234567890 }],
  "version": 1
}
```

None of this is secret. It is useless without the passphrase or recovery code.
`signingPublicKey`/`signingKeyLog` are the one exception to "useless without the passphrase" —
they're public keys by definition, harmless to read, needed only to *verify* history entries, not
to decrypt anything. See §5c for `wrappedSigningKey`'s lifecycle (why it's not wrapped under
`KEK_r` like `wrappedDek` is, and why `signingKeyLog` only ever grows).

## 2. Unlock / lock flow

**Unlock:** passphrase + stored salt → Argon2id → KEK → AES-GCM decrypt wrappedDek → raw DEK →
import as non-extractable CryptoKey. Hold in memory. Discard KEK.

**Lock (or refresh / tab close):** drop the DEK CryptoKey reference. Nothing usable remains in
memory. Re-unlock requires the passphrase again.

**Change passphrase:** derive new KEK from new passphrase (new salt) → re-wrap the existing DEK →
overwrite wrappedDek/wrapIv/salt. Task data is untouched. Recovery wrap is unaffected.

## 3. Task encryption

Encrypt per task record (not one big blob). Rationale: enables incremental sync and conflict
resolution. Cost: leaks task count, individual sizes, and update timing — documented in the
threat model.

Plaintext task shape (this is the Phase 1 shape already in use — see `js/store.js`; `tags`,
`subtasks`, `project`, and `recurrence` were added post-launch, same envelope, no separate
encrypted entity. `project` is a plain string, not a foreign key into any other store —
"projects" are purely derived from whatever distinct values exist across tasks, the same pattern
as tags. This is a deliberately lighter mechanism than a real multi-vault/multi-key architecture;
see `docs/FEATURES.md`'s "Compartmentalised vaults" entry for what the heavier version would look
like, and its status note for why the lighter version was chosen here. `recurrence` is one of
`null`/`"daily"`/`"weekly"`/`"monthly"` — marking a recurring task done spawns a fresh task (new
id, status reset to `"todo"`, `dueDate` advanced by the rule) rather than mutating the completed
one, so completed occurrences stay in the completed column instead of disappearing):

```json
{
  "id": "<uuid v4, client-generated>",
  "title": "Buy Mum a birthday gift",
  "project": "Personal",
  "notes": "",
  "status": "todo",
  "priority": "high",
  "dueDate": "2026-08-20",
  "tags": ["family", "shopping"],
  "subtasks": [
    { "id": "<uuid v4>", "title": "Pick a shop", "done": true },
    { "id": "<uuid v4>", "title": "Wrap it", "done": false }
  ],
  "recurrence": null,
  "order": 3,
  "createdAt": 1723800000000,
  "updatedAt": 1723800000000
}
```

Encryption: serialize to JSON → AES-256-GCM encrypt with DEK and a fresh random 96-bit IV per
encryption (never reuse an IV with the same key).

Stored / synced record shape (Phase 3+):

```json
{
  "id": "<uuid>",
  "iv": "<base64, 12 bytes>",
  "ciphertext": "<base64>",
  "updatedAt": 1723800000000,
  "deleted": false
}
```

`id`, `updatedAt`, and `deleted` are cleartext metadata (needed for sync/merge). Everything
meaningful — title, notes, status, priority, due date — is inside the ciphertext.

## 4. Recovery code

- Generate 32 random bytes → encode as a human-friendly grouped string (e.g. base32, chunked
  `XXXX-XXXX-...`).
- Derive KEK_r from it (Argon2id, separate salt) → wrap a second copy of the DEK.
- Show it once at setup. Force the user to confirm they saved it. Explain plainly: "We never see
  this. If you lose both your passphrase and this code, your data cannot be recovered by anyone."
- Recovery flow: user enters recovery code → KEK_r → unwrap wrappedDekRecovery → DEK → prompt to
  set a new passphrase → re-wrap under new KEK.

This is the standard, correct recovery pattern. Do not add a server-side reset — that would break
the entire security model.

## 4b. Social recovery (Layer 2)

Splits the *existing* recovery code from §4 into pieces distributed to trusted people, instead of
inventing a second, parallel recovery secret — a reconstructed set of shares yields the byte-
identical original recovery code string, so it re-enters exactly the flow above with zero new
unlock-path code to audit.

- **Shamir secret sharing over GF(2^8)**, hand-implemented in `js/crypto.js` (`splitSecret`/
  `reconstructSecret`) — the standard textbook construction (Shamir 1979), not a novel scheme.
  Field: the AES/Rijndael field, reduction polynomial `x^8+x^4+x^3+x+1` (`0x11B`), generator `3`.
  **Generator choice matters and was a real, caught bug during development:** `2` is *not* a
  primitive root of this field (its multiplicative order is only 51, a proper divisor of 255), so
  a log/exp table built by naive repeated doubling silently cycles after 51 entries instead of
  covering all 255 nonzero field elements — every share produced from such a table would be
  systematically wrong. `3` (`double(x) XOR x`) is the standard choice (used by Rijndael's own
  reference tables) and is verified, not merely assumed, to have the full order-255 cycle — see
  the comment at `buildGfTables()` and `js/crypto.test.mjs`'s SSS vectors.
- **What gets split:** the recovery code's own 32 raw bytes (`recoveryCodeToBytes()`), the same
  bytes §4's `KEK_r` is derived from — not a separate secret. `k` of `n` shares reconstruct those
  exact 32 bytes; `k-1` reveal nothing (Shamir's information-theoretic guarantee holds regardless
  of which construction generates the shares).
- **No built-in correctness check on reconstruction** — mismatched or wrong shares silently
  reconstruct to garbage bytes rather than erroring, an inherent Shamir property, not a bug in this
  implementation. Correctness is instead verified for free by reusing §4's own recovery flow:
  attempting to unwrap `wrappedDekRecovery` with the reconstructed code's derived `KEK_r` either
  succeeds (AES-GCM auth tag passes → shares were right) or throws (fails closed → shares were
  wrong/insufficient/mismatched), exactly the same fail-closed behavior a mistyped recovery code
  already produces. No new verification mechanism needed.
- **Share encoding:** `[k, index, ...32 share bytes]` (34 bytes) → the same dashed base32 format as
  a recovery code, via `encodeShare()`/`decodeShare()` — visually and mechanically consistent with
  everything else the user is asked to transcribe or paste. Embedding `k` in every share lets the
  reconstruction UI show "2 of 3 needed" without the user separately remembering the threshold.
  Nothing about a single share (or `k-1` of them) reveals anything about the DEK, the passphrase,
  or even how close a guess is — that's what "information-theoretic" means here, not just "hard to
  guess."
- **UI:** splitting happens from a command-palette action ("Set up social recovery") while
  unlocked — it re-verifies the entered code against the real `wrappedDekRecovery` before splitting
  anything, so it can't silently split a typo. Reconstruction happens from the lock screen's
  existing recovery flow via a "Recover using shares" sub-panel — shares are added one at a time,
  and once `k` are collected, reconstruction and verification happen automatically (see above),
  landing on the exact same reset-passphrase screen §4's direct-code-entry path does.
- **What a holder of one share learns:** nothing usable alone. What the app itself learns from a
  *successful* split: the plaintext recovery code, transiently, only in memory during the split
  operation — never written anywhere new; the resulting shares are exactly as sensitive as the
  original code was, just spread across more people.

## 4c. WebAuthn passkey unlock (Layer 2)

A faster alternative to typing the passphrase — Touch ID, Windows Hello, or a hardware security
key — implemented as a **third parallel wrap of the DEK** (and the history-signing key), alongside
the passphrase-wrapped and recovery-code-wrapped copies from §1/§4. The passphrase remains fully
functional and is not weakened or bypassed; this is an additional door, not a replacement one.

- **Mechanism: `largeBlob`, not `prf`.** WebAuthn has two extensions that can hand a website secret
  bytes tied to a credential: `prf` (derives a value deterministically via HMAC) and `largeBlob`
  (stores/retrieves an arbitrary blob directly). This project uses `largeBlob`: a random 256-bit
  secret is generated client-side and *stored* via the credential (not derived from it). Real-world
  authenticator support for the two extensions differs and neither is universal — `largeBlob`
  specifically requires a CTAP2.1 authenticator with resident-key and large-blob support.
- **`KEK_hw`:** the stored secret is imported directly as an AES-256-GCM key
  (`importDek(secretBytes)` — no PBKDF2. Unlike a human passphrase, this secret is already
  full-entropy random, so stretching it would add cost without adding security, the same reasoning
  `generateHardwareSecret()`'s own doc comment gives.) `KEK_hw` wraps a *second* copy of the DEK
  (`wrappedDekHardware`/`wrapIvHardware`) and a second copy of the history-signing private key's
  PKCS8 export (`wrappedSigningKeyHardware`/`signingKeyWrapIvHardware`) — both via the generic
  `wrapRawBytes()`/`unwrapDek()` pair (the latter reused as-is: it's just "AES-GCM-decrypt these
  bytes," indifferent to what the bytes represent).
- **Registration requires the current passphrase**, re-entered in the "Add a passkey" modal —
  not because the live in-memory `dek`/`historySigningKey` couldn't theoretically be used, but
  because both are deliberately imported **non-extractable** during normal operation (`importDek`'s
  default, `unwrapSigningKey`'s hardcoded `false`) precisely so nothing at runtime can ever export
  them. Re-deriving `KEK` from a freshly-entered passphrase and re-unwrapping `wrappedDek`/
  `wrappedSigningKey` from scratch is the only way to get extractable raw bytes to re-wrap — the
  same trade a browser DevTools inspector would face, not a shortcut this code takes for itself.
- **The registration ceremony is two WebAuthn prompts, not one — this is spec behavior, not a
  bug.** `largeBlob.write` is only available during an assertion (`get()`), never during the
  `create()` that registers the credential. So "Add a passkey" does `create()` (register, check
  `largeBlobSupported`) then immediately `get()` (write the secret) — two separate authenticator
  interactions the user will see back-to-back.
- **`support: "preferred"`, not `"required"` — a real, caught issue during development.** WebAuthn
  lets `create()` request `largeBlob.support: "required"`, which sounds like the right choice for
  a feature this depends on — but the browser deliberately reports an authenticator's lack of
  `largeBlob` support as the exact same generic `NotAllowedError` a cancelled or timed-out ceremony
  gets (a WebAuthn privacy property: a site shouldn't be able to fingerprint an authenticator's
  capabilities by which specific error it gets back). With `"required"`, this app could not tell
  "your authenticator doesn't support this" apart from "you cancelled" to show an accurate message.
  Switched to `"preferred"`, under which `create()` succeeds regardless and the real answer is read
  from `getClientExtensionResults().largeBlob.supported` afterward — verified with a virtual
  authenticator that has `largeBlob` disabled, confirming the specific, accurate error path.
- **Unlock:** `readLargeBlob()` performs a `get()` assertion, retrieves the secret, and from there
  proceeds exactly like a normal unlock (derive `KEK_hw`, unwrap, `afterUnlock()`) — no passphrase
  involved anywhere in this path.
- **Residual limitation, stated plainly:** if the passphrase is later changed via the
  recovery-code reset flow (§4, which rolls a fresh signing key by design), a passkey registered
  *before* that reset still holds the *old* wrapped DEK/signing-key copies. Unlocking via passkey
  after such a reset would restore access to the vault correctly (the DEK itself doesn't change on
  a passphrase reset, only its wrapping) but would resume signing history entries under the
  pre-reset signing key rather than the post-reset one — not a correctness bug (the old key is
  still in `signingKeyLog`, so verification still passes) but a minor inconsistency a user who
  both loses their passphrase *and* uses a passkey regularly could hit. Re-registering the passkey
  after any recovery-code reset avoids this; not automated in v1.

## 5. Optional sync protocol

The server is a dumb encrypted-blob store. It never decrypts, never sees keys, never sees
plaintext.

- **Sync token:** client generates 32 random bytes → base64url. Identifies a blob bucket. It is a
  bearer capability, not an identity. Sent as `Authorization: Bearer <token>`.
- **Endpoints:**
  - `POST /sync/push` — body: `{ records: [ {id, iv, ciphertext, updatedAt, deleted}, ... ] }`.
    Upsert into the token's bucket.
  - `GET /sync/pull?since=<timestamp>` — returns records in the bucket with `updatedAt > since`.
  - `POST /sync/keyring` — body: `{ wrappedDekRecovery, wrapIvRecovery, saltRecovery, updatedAt }`.
    **Not in the original spec** — added because nothing above establishes a shared DEK between two
    devices; see the Phase 6 status note at the top of this document for why. Republishes a
    device's own *recovery*-wrapped DEK per token, so a second device can later obtain the same
    key via the recovery code. Never the passphrase-wrapped copy.
  - `GET /sync/keyring` — returns `{ wrappedDekRecovery, wrapIvRecovery, saltRecovery }` for the
    token, or 404 if no device has published bootstrap material for it yet.
- **Conflict resolution:** last-write-wins by `updatedAt` for v1. CRDT-based merge is later.
- **What the server learns:** record counts, ciphertext sizes, update timestamps, sync frequency,
  the bucket token. Nothing about task contents. The keyring-bootstrap row is exactly as useless
  without the recovery code as a device's own local keyring already is.
- **Deletion:** `deleted: true` tombstones sync; a real delete path also removes the ciphertext
  row server-side (`iv`/`ciphertext` set to `NULL` on the same row, not just a flag toggled) — see
  `server/storage.py`'s `upsert_records`.

## 5b. Fragment-key share links (Layer 2)

Lets a task be shared read-only, without an account on either end, in a way even Haven's own
relay server can't read. The trick is which part of the URL carries the key.

- **Fresh key, not the DEK.** Sharing generates a brand-new random AES-256-GCM key
  (`generateDek()` again, not the vault's own DEK) that exists only for this one share — it never
  touches the keyring, and compromising it can't expose anything else in the vault.
- **Payload:** a snapshot of `{title, notes, status, priority, dueDate, tags, subtasks}` — not the
  full task record (no `id`, no `project`, no timestamps), encrypted with `encryptTask()`/the
  fresh key exactly like a normal task record is.
- **Where the key lives:** the resulting link is
  `shared.html?server=<relay>&id=<share-id>#<base64url key>`. The key is placed *only* in the URL
  fragment (after `#`). Per the URL spec, browsers never send the fragment to any server — not the
  relay, not the static host, not even in the `Referer` header of outbound requests from that
  page. `server`/`id` are non-secret routing info and can safely sit in the query string, same as
  how a sync server URL is already treated as non-sensitive local config.
- **Endpoints (deliberately unauthenticated — see `server/routes.py`):**
  - `POST /share` — body: `{iv, ciphertext, ttlSeconds?, maxViews?}`. Server generates the id
    itself (`secrets.token_urlsafe(24)`, so it always has full entropy regardless of client
    behavior). Returns `{id, expiresAt}`. Caps `iv`/`ciphertext` at 20,000 chars each to keep this
    from becoming free anonymous storage.
  - `GET /share/<id>` — returns `{iv, ciphertext}`, or 404 if missing, expired, revoked, or
    already viewed `maxViews` times. **Consumes one view** as a side effect (see below).
  - `DELETE /share/<id>` — revokes a share immediately. No auth beyond the id itself; see
    "Capability links" below for why that's not a weaker check than the GET already has.
  - No bearer token on any of the three: the random id *is* the capability, same entropy class as
    a sync token or recovery code. This is intentional, not an oversight — the whole point is a
    recipient needs nothing but the link.
- **Expiry:** 7 days by default, enforced server-side (`server/storage.py`'s `get_share`); expired
  rows are swept lazily rather than on a schedule.

### Capability links (extends the above)

Three controls the sender can set at share-creation time, addressing the "no revocation" gap
originally called out in docs/THREAT_MODEL.md's A4b:

- **Configurable expiry** — `ttlSeconds` in the `POST /share` body, offered in the UI as 1 hour /
  1 day / 7 days / 30 days. Server clamps to `[60, 2592000]` regardless of what's sent, so a
  tampered client request can't mint a near-permanent or negative-lifetime share.
- **Burn-after-reading (`maxViews`)** — an optional view-count cap, offered in the UI as
  unlimited / 1 / 5 / 20. Enforced by `get_share()` as a single atomic
  `UPDATE ... WHERE views_used < max_views RETURNING ...` — the check-and-increment happens in one
  SQL statement specifically so two near-simultaneous requests against a `maxViews=1` share can't
  both read the row as "unused" and both see the plaintext (a classic TOCTOU bug in the more
  obvious SELECT-then-UPDATE version).
- **Revocation (`DELETE /share/<id>`)** — the sender's copy of the link contains the same `id` a
  recipient's copy does, so the sender is already able to construct any request a recipient could.
  Letting them delete the row early grants no capability beyond what having the link already
  implied; it's symmetric with the GET, not a separate trust tier. The "Share this task" modal
  keeps the created share's `{id, server}` (never the key) specifically so its "Revoke link" button
  can call this without re-deriving anything.
- **Which server relays it:** the share flow reuses the user's configured sync server if they have
  one (`getSyncConfig()`), else falls back to the project's own hosted relay
  (`https://haven-sync.onrender.com`) — sharing a single task shouldn't require setting up sync
  first.
- **The viewer (`shared.html`/`js/shared.js`):** no unlock screen, no IndexedDB, no keyring —
  fetches `{iv, ciphertext}`, imports the fragment key, decrypts, and renders read-only via
  `textContent` only (same never-`innerHTML` discipline as the rest of the app). Nothing about the
  visit is ever persisted locally; closing the tab leaves no trace on that device.
- **What the relay server learns:** ciphertext size, creation/expiry timestamps, the share id, and
  request timing. Never the plaintext task, never the key.

## 5c. Tamper-evident signed task history (Layer 2)

Makes silent edits, deletions, or backdating of local task data provable rather than merely
assumed-honest — every meaningful mutation is signed and hash-chained, so tampering leaves a
detectable gap or mismatch instead of quietly succeeding.

- **A second, separate keypair.** Each device generates its own Ed25519 signing keypair at setup
  (`generateSigningKeypair()` in `js/crypto.js`), wrapped under the same passphrase-derived KEK
  as the DEK but stored in its own `wrappedSigningKey`/`signingKeyWrapIv` keyring fields. This is
  a distinct identity from the DEK on purpose: it only ever signs metadata *about* changes, never
  the changes themselves, so nothing about its exposure would help decrypt a single task.
- **Per-device, not per-vault, and deliberately not wrapped under KEK_r.** A recovery-code-based
  passphrase reset can't recover the old signing key (it was never wrapped under `KEK_r`) — this
  is a v1 scope choice, not an oversight. Reset instead **rolls a fresh signing keypair** and
  *appends* it to `keyring.signingKeyLog` (an array of `{publicKey, startedAt}`, never
  overwritten), so history entries signed before the reset stay independently verifiable under
  their original key — they simply belong to a earlier segment of this device's chain.
- **What gets logged, and what doesn't:** every `create`/`update`/`delete` through `persistTask()`/
  `removeTask()` appends one entry. Pure display changes (drag-drop reordering, via
  `persistReorder()`) are explicitly excluded — `persistTask(task, op, logHistory=false)` — since
  they aren't a meaningful audit event and would otherwise drown out real edits.
- **Entry shape** (`js/app.js`'s `historyEntryContent()`): `{id, taskId, op, payloadHash, prevHash,
  timestamp, publicKey}`, plus a `signature` over the canonical JSON of everything except itself.
  `payloadHash` is `sha256Hex(iv + ciphertext)` — a hash of the *ciphertext*, not the plaintext, so
  the log stays as privacy-preserving as every other stored record; `delete` entries have
  `payloadHash: null` since there's no content left to hash.
- **The hash chain:** `prevHash` references the *previous entry's own hash*, which itself covers
  that entry's signature (`historyEntryHash()`) — like a git commit hash covering its own
  signature, so a resigned-but-otherwise-identical forged entry still breaks the chain. The first
  entry ever appended references the literal string `"GENESIS"`.
- **Storage:** a new IndexedDB store, `historyLog` (`js/store.js`), keyed by an auto-incrementing
  `seq` — deliberately *not* the entry's own `id` (a UUID), because a UUID primary key would sort
  lexicographically and silently break "previous entry" ordering. Only ever `add()`-ed, never
  `put()`-ed — append-only is enforced at the IndexedDB call site, not just by convention.
- **Verification (`verifyHistoryChain()`):** walks every entry in append order, checking two
  independent things per entry — the chain link (`prevHash` matches the real previous entry's
  hash) and the signature (verifies under a key that has ever been listed in this device's own
  `signingKeyLog` — not just the *current* key, so old segments from before a rotation still
  verify). Stops and reports the first break found, since everything after an unverifiable link is
  unverifiable by construction regardless of its own internal consistency.
- **UI:** a dedicated "History" panel (rail button + command-palette entry) with a "Verify now"
  button — plain pass/fail language, no simulated hacker aesthetic, consistent with §6 below.
- **Honest v1 scope limit — this is local-only.** The log lives in IndexedDB and is not currently
  synced anywhere. That means it protects against corruption or tampering *of the local store
  itself* (a buggy migration, a rogue browser extension poking at IndexedDB, disk-level bit rot)
  but **not** against an attacker with the same level of access this device's own JavaScript has —
  such an attacker could rewrite the log and `signingKeyLog` consistently with each other, since
  both live in the same tamperable storage. It also does **not** yet defend against a malicious
  sync server silently dropping or reordering entries, which would require syncing the log itself
  (as opaque signed blobs, the same "dumb blob store" pattern as `/sync/push`) and is real,
  scoped, not-yet-built future work — not a claim this version makes.

## 5d. Verifiable frontend (Layer 2)

Closes the biggest structurally-honest gap in this whole threat model: everything above proves the
*crypto* is sound, but a user still has to trust that the JavaScript actually served to their
browser is the audited code, not something quietly swapped in at the host or in transit. This
doesn't eliminate that trust requirement — no client-side-only mechanism can — but it makes
tampering *detectable* two different ways instead of purely assumed-away.

- **Subresource Integrity (SRI) on every entry-point `<script>`/`<link>` tag**, generated by
  `scripts/generate-integrity.mjs` (plain Node, no dependencies) and checked into the repo as
  literal `integrity="sha384-..."` attributes in `app.html`/`index.html`/`shared.html`. This is
  **browser-enforced, not merely advisory**: if the served bytes of `js/app.js` or `css/style.css`
  don't hash to the value in the tag, the browser refuses to execute/apply them at all — verified
  for real, not assumed, by deliberately corrupting a hash and confirming Chromium blocks the
  resource with `net::ERR_...` and the app never initializes (see docs/SECURITY.md).
- **The real, honestly-stated limit: SRI does not cover ES module `import` statements.** The
  `integrity` attribute is a `<script>`/`<link>` tag feature — it has no effect on the `import
  {...} from "./store.js"` lines *inside* `app.js`. So `js/app.js`'s own bytes are
  browser-enforced, but `js/store.js`, `js/ui.js`, `js/crypto.js`, and `js/sync.js` — everything it
  imports — are not, because no browser API exists for that yet. This isn't a gap in this
  implementation; it's a gap in what SRI as a web platform feature currently covers.
- **`integrity.json`** (repo root) closes the rest of the gap a different way: a manifest of every
  served `.js`/`.css` file's SHA-384, including the ones SRI can't reach. It's not
  browser-enforced — a host that could tamper with the JS could in principle also tamper with this
  file — but it *is* independently checkable: clone the repo at the deployed commit, run
  `node scripts/generate-integrity.mjs` yourself, and `diff` the result against what's live (`curl`
  each file, hash it, compare) or against the manifest published on the live site. This is the
  "reproducible build, published hashes" property from docs/FEATURES.md — verifiable by a
  technical third party, not merely asserted.
- **Maintenance discipline:** the generator must be re-run after editing any `css/*.css` or
  `js/*.js` file, the same "manually bumped, verified before deploy" discipline the `?v=`
  cache-bust query strings already require — except a stale SRI hash doesn't serve stale content
  like a stale `?v=` does, it **breaks the site outright** (the browser blocks the mismatched
  resource), so this matters more, not less.
- **A real, observed operational risk: CDN edge-cache propagation lag right after deploy.**
  Immediately after a live deploy, one edge PoP briefly served the *new* `app.html` (with a
  freshly-regenerated integrity hash) alongside a *stale cached* `css/style.css` (the previous
  version's bytes, `cf-cache-status: HIT`) — precisely the mismatched combination that makes a
  browser correctly block the stylesheet. It resolved within seconds on its own (Cloudflare's
  static-assets deploys invalidate per-file, not instantaneously across every edge PoP
  simultaneously) and a follow-up check confirmed every served file matched `integrity.json`
  again. This is a real, if narrow and transient, window inherent to pairing SRI with any
  multi-PoP CDN — not specific to a mistake in this deploy. Practical mitigation: verify
  `integrity.json`'s hashes against the live site a few seconds after each deploy (fetch every
  file, hash it, compare) before considering a deploy complete, rather than trusting the deploy
  tool's own "success" output alone.

## 6. The "You vs The Server" reveal

Purely a rendering of data the app already has — no new crypto.

- The app holds the plaintext task object in memory right before encrypting it.
- Left panel: the plaintext object. Right panel: the exact `{id, iv, ciphertext, updatedAt,
  deleted}` record that would be pushed to a server. Updates live as the user types.
- "How your data is protected" page: plain-English explanation + a button that reads all
  IndexedDB task records and displays them raw (all ciphertext).

Show real bytes only. No simulated hacker aesthetic.

## 7. Module layout (frontend, no build step)

```
index.html          // marketing/landing page (Phase 8) — serves the custom domain's root for SEO
app.html             // the actual app shell + CSP meta; loads app.js as type="module"
/js
  app.js            // bootstrap, state, event wiring, lock/unlock, reveal panel (done, Phases 3+5)
  crypto.js         // KDF, wrap/unwrap, encrypt/decrypt, recovery — pure, unit-tested (done, Phase 2)
  crypto.test.mjs   // the six vectors in §8 below — run with `node js/crypto.test.mjs`
  store.js          // IndexedDB read/write — task records (ciphertext) + keyring (done, Phase 3)
  ui.js             // rendering (textContent only for task content), board/list, DnD, reveal view
  sync.js           // optional: push/pull against the Flask blob store (Phase 6)
  // no separate reveal.js — folded into app.js/ui.js instead, see the Phase 5 status note above
/vendor
  hash-wasm/        // reserved for the future Argon2id migration — empty for now, v1 uses
                     // PBKDF2-SHA256 natively (no WASM to vendor yet, see key-derivation above)
/css
  style.css
```

## 8. Crypto unit-test vectors (Phase 2 gate)

Before wiring `crypto.js` into anything, prove these in isolation:

1. **Round-trip:** encrypt a known task object with a known DEK and IV → decrypt → deep-equals
   the original.
2. **Wrap/unwrap:** derive KEK from a fixed passphrase + fixed salt → wrap a fixed DEK → unwrap →
   equals original DEK bytes.
3. **Wrong passphrase fails closed:** unwrapping with a wrong-passphrase KEK throws (GCM auth
   failure), never returns garbage that is then used.
4. **IV uniqueness:** encrypting the same plaintext twice yields different ciphertext.
5. **Recovery path:** wrap DEK under KEK_r → unwrap with the recovery code → equals original DEK.
6. **Tamper detection:** flip one byte of a ciphertext → decryption throws (GCM tag mismatch).

Use fixed, hardcoded salts/IVs only in tests. In production, salts and IVs are always freshly
random.
