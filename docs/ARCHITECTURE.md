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
  "version": 1
}
```

None of this is secret. It is useless without the passphrase or recovery code.

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

Plaintext task shape (this is the Phase 1 shape already in use — see `js/store.js`):

```json
{
  "id": "<uuid v4, client-generated>",
  "title": "Buy Mum a birthday gift",
  "notes": "",
  "status": "todo",
  "priority": "high",
  "dueDate": "2026-08-20",
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
