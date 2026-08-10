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

## 4d. Ephemeral tasks (Layer 3)

Self-destructing tasks, via cryptographic erasure rather than a deletion flag a bug or a
malicious sync server could ignore: once the fuse goes off, the content is not just *marked*
gone, it's *actually* unrecoverable — including by us.

- **Per-task key, not the shared DEK.** A self-destructing task is encrypted under a fresh
  256-bit key generated just for it (`generateDek()`), which is itself wrapped under the vault
  DEK (`wrapDek()`, identical mechanism to how the DEK itself is wrapped under `KEK` in §1) and
  stored alongside the ciphertext as `selfDestruct.wrappedTaskKey`/`taskKeyWrapIv`. Every other
  task keeps using the shared DEK directly, same as before this feature existed.
- **Erasure = deleting the wrapped key, not the ciphertext.** "Burning" a task sets
  `wrappedTaskKey`/`taskKeyWrapIv` to `null` and leaves the ciphertext row in place. AES-GCM
  ciphertext without its key is already indistinguishable from random bytes — there's no
  separate "secure wipe" step to get right, because there was never a second copy of the key to
  chase down. Verified with a test vector (`js/crypto.test.mjs`) confirming a task encrypted
  under one key cannot be decrypted under any other. Leaving the ciphertext in place (rather than
  also deleting the row) is deliberate: it lets the board show a "this task self-destructed"
  placeholder in its original column, and gives the history-log entry below a real payload hash
  to point at instead of nothing.
- **Two triggers.** A time-based fuse (`selfDestruct.expiresAt`) checked lazily against the
  in-memory task list every time the board re-renders — which in practice means "on basically
  every user action" — plus a 20-second backstop `setInterval` for a tab left open and idle past
  expiry with no other trigger to catch it. "Burn after reading" (`selfDestruct.maxViews`)
  increments a view counter when the task is opened and erases once the counter is reached — the
  content is still shown in full on the view that burns it, matching "burns after being opened,"
  not "blocks the view that would burn it."
- **A signed history entry, same as any other mutation** (§5c) — `op: "selfDestruct"`, hashing
  the ciphertext exactly like a normal update — so "when did this get erased" is itself part of
  the tamper-evident log, not a side effect that happens outside it.
- **Honest scope limits:**
  - **Local-only — never synced.** A self-destructing task's storage record is filtered out of
    every push to the optional sync server (`syncNow()`, `js/app.js`). Without this, the erasure
    guarantee would have to account for a copy of the wrapped key already sitting on a second
    device or the sync server before the fuse went off — local key-deletion alone can't reach
    those. Simplest honest fix: it never leaves the device that created it.
  - **Not shareable.** Sharing a task (§5b) snapshots its currently-decrypted fields into an
    independent, separately-encrypted copy on the share server, with its own lifetime — that copy
    would not be touched by the original task's fuse going off, quietly breaking "burns and is
    gone." The "Share link…" button is disabled for a self-destructing task rather than shipping
    a share link that could outlive the task it came from.
  - **Not a defense against a forensic disk/memory snapshot taken before the fuse fires.** If an
    attacker captures the device's storage (or a live copy of `dek`/the per-task key in memory)
    *before* erasure, they have what they need regardless of what happens afterward — the same
    limitation every local-first, no-server-side-copy design has. This feature deletes the *only*
    copy that would otherwise remain accessible through the app itself; it isn't a claim about
    forensic recovery from raw storage.
  - **The fuse itself isn't tamper-evident.** Nothing stops a user (or malware with local access)
    from directly editing `expiresAt` in IndexedDB, same as nothing stops direct tampering with
    any other local record — the history log would show the resulting erasure (or lack of one)
    happened, but doesn't prevent the tampering itself. Out of scope for a client-side-only trust
    model; see docs/THREAT_MODEL.md.

## 4e. Duress / decoy vault (Layer 3)

A second passphrase that opens a completely separate, fully-functional vault instead of the real
one — for the specific, narrow case of being made to unlock the app in front of someone. The
honest framing matters here more than for most features, so it comes before the mechanics.

**What this actually provides:** whichever passphrase the lock screen is given, it either opens
the real vault or the decoy — same form, same success animation, same `afterUnlock()` call,
nothing in the app's own behavior tells the two apart. That's real, and it's the whole point: a
plausible, fully-usable vault to hand over instead of the real one.

**What this does not provide — read before relying on it:**
- **Existence isn't hidden from someone with local disk access or knowledge of this source.**
  Haven publishes its source (§5d, "Verifiable frontend" is the whole reason to). Anyone who reads
  `js/store.js`/`js/app.js`, or who gets raw access to the "haven" IndexedDB database, can see a
  `saltDecoy`/`wrappedDekDecoy` field either is or isn't present in the keyring record — which
  tells them a decoy is configured, before they have any passphrase for it. That's a materially
  weaker guarantee than "hidden vault is unprovable" (the phrase this feature was originally
  scoped under in docs/FEATURES.md — corrected there to describe what's actually shipped). True
  existence-deniability under forensic examination would mean every wrapped-DEK slot looking
  identically random whether populated or not, which is a full storage-layer redesign, not a Med
  effort — that's docs/FEATURES.md Layer 5's "Cryptographically deniable encryption," listed
  separately and explicitly as the harder version of this.
- **A timing side-channel on unlock, not fixed.** Deriving a KEK is a 600,000-iteration PBKDF2,
  deliberately slow. A wrong passphrase against a device *with* a decoy configured costs two such
  derivations (try main, fail, try decoy, fail); against a device with none, it costs one. A
  patient adversary timing repeated unlock attempts could infer "a decoy exists" from that gap
  alone, never needing to guess either passphrase. Not fixed here: doing so would mean *every*
  unlock — including the common case of a device with no decoy at all — always burning a second
  dummy PBKDF2 derivation, roughly doubling perceived unlock latency for every user to protect a
  feature only some will configure. Documented instead of silently accepted.
- **No recovery code, no passkey, no sync.** The decoy vault has exactly one way in — its own
  passphrase — and if it's forgotten, the decoy and everything in it is unrecoverable, permanently,
  same floor as losing both the real vault's passphrase and recovery code. It also never syncs
  (see below) and can't be unlocked via a registered passkey; passkey unlock (§4c) always targets
  the main vault only, by design, not by oversight.

**Mechanics:**
- **A third parallel wrap, alongside the passphrase- and recovery-code-wrapped DEKs (§1, §4).**
  `saltDecoy`/`wrappedDekDecoy`/`wrapIvDecoy` in the same keyring record, same
  `deriveKek()`/`wrapDek()`/`unwrapDek()` machinery as every other KEK in this app — nothing
  decoy-specific about the crypto itself, only about which fields it reads/writes.
- **A fully independent signing identity too** (`wrappedSigningKeyDecoy`/`signingPublicKeyDecoy`/
  `signingKeyLogDecoy`), so the decoy vault's own tamper-evident history (§5c) works exactly like
  the real vault's — not a stripped-down version of the feature.
- **Separate IndexedDB databases for tasks/history — `haven` vs `haven-decoy`** (`js/store.js`'s
  `setActiveVault()`), switched the moment either passphrase is accepted. The **keyring itself
  stays in one place** (`haven`, always) since it has to be readable before a passphrase attempt
  reveals which vault (if either) it belongs to — there's no way to know which database to open
  until after the wrap that lives in it has already been tried.
- **The unlock form tries the main wrap first, then the decoy wrap on failure, before reporting
  "Wrong passphrase."** Both failure paths — wrong against an existing decoy, and wrong with no
  decoy configured at all — produce the identical error message and UI state.
- **Never synced.** Sync config (server URL, bearer token) lives in plaintext `localStorage`,
  entirely outside any vault's encryption boundary — it isn't scoped per-vault at all. Syncing
  while the decoy vault is active would push decoy tasks into whatever bucket the *main* vault's
  sync config points at, mixing the two and defeating the separation this feature exists for.
  `syncNow()` refuses outright while the decoy vault is active, rather than trying to give the
  decoy its own sync identity — same "just don't sync it" choice as ephemeral tasks (§4d), for a
  related reason.
- **Setup is deliberately state-blind.** "Set up a decoy vault" (command palette) shows the same
  form whether or not one already exists, and running it again just replaces the existing decoy —
  new passphrase, new DEK, old decoy content unreachable. A setup UI that changed shape once a
  decoy existed (a "manage" view, a status indicator) would itself be a tell to anyone skimming the
  app after a forced unlock, which is exactly the scenario this feature is for.

## 4f. Local automation rules (Layer 3)

"If X, then Y" rules that run entirely on-device against the already-decrypted task list — no
server involved at any point, not even to evaluate a condition.

- **Three triggers, five actions, no chaining.** `trigger.type` is one of `onDone` (status just
  became `"done"`), `onOverdue` (a non-done task's due date is in the past), or
  `onCreateWithTag` (a task was just created already carrying a given tag). `action.type` is one
  of `addTag`/`removeTag`/`setPriority`/`setStatus`/`moveToProject`. `js/automation.js`'s
  `evaluateTask(rules, eventType, task)` is the entire engine — a pure function, no IO, called
  once per event with the event type it's reacting to, checked against `js/automation.test.mjs`'s
  14 vectors. Deliberately **no rule chaining**: a rule's own action is never re-fed into the
  evaluator as a new trigger for another rule within the same call. Two rules that would
  otherwise set each other off forever (an `onOverdue` rule that sets status to done, feeding an
  `onDone` rule that changes something the first rule's condition depends on) simply can't reach
  each other — not detected and blocked, structurally impossible, because each call only ever
  looks at rules matching the one `eventType` it was given.
- **Where each trigger is called from** (`js/app.js`): `onCreateWithTag` — inside `addTask()`,
  against the just-created task, before its first persist (so the "create" history entry already
  reflects the rule's effect, no separate "update" entry immediately after). `onDone` — inside
  `updateTask()` (the edit-form save path) and inside the board's drag-and-drop `drop` handler
  separately, since dragging a card to the Done column never goes through `updateTask()` at all.
  `onOverdue` — the same lazy-sweep-on-render pattern ephemeral tasks use (§4d): a cheap array
  scan on every `render()` call (no IO when nothing matches, the common case) plus a coarse
  interval backstop for an idle tab.
- **Rules are encrypted the same way tasks are** — `js/crypto.js`'s `encryptTask()`/
  `decryptTask()` are reused as-is (they were already generic AES-GCM-encrypt-a-JSON-object
  functions, not task-schema-specific), stored in their own `rules` IndexedDB object store
  (`DB_VERSION` 3→4). A rule's trigger tag or action value is just as much user content as a task
  title — there's no reason for it to sit in cleartext.
- **Local-only, like ephemeral tasks and the decoy vault, and for a related reason** — not
  included in `syncNow()`'s push (rules aren't task records at all, so this is automatic rather
  than a filter to remember), and not something a second device would want inherited silently
  anyway: automation is a per-device preference, not shared task data.
- **The decoy vault gets its own independent rules**, same as its own tasks/history — `rules` is
  part of the same per-database object-store layout `js/store.js`'s `upgrade()` creates for both
  `haven` and `haven-decoy`.
- **Honest scope limit:** five actions and three triggers is a deliberately small, fixed catalog,
  not an extensible rule language — no custom conditions, no combining multiple trigger conditions
  with AND/OR, no scheduling beyond "due date passed." Covers real, common cases (auto-archive on
  completion, auto-escalate priority when overdue, auto-tag on creation) without building a
  general-purpose scripting surface this app doesn't need.

## 4g. On-device insights (Layer 3)

A stats panel — total tasks, completion rate, overdue count, breakdowns by status/priority/
project, top tags, subtask completion rate — computed by `js/insights.js`'s `computeInsights()`,
a pure function over whatever's currently in `js/app.js`'s in-memory `tasks` array. No network
request, no logging, no state kept between page loads: closing the tab and reopening it
recomputes everything fresh from the current board, same as every other view in this app.

- **A snapshot, not a history.** Every stat here answers "what does my board look like right
  now," never "how has it changed over time." That's not a corner cut for time — it's what's
  honestly computable. Tasks carry `createdAt` and `updatedAt`, but no `completedAt`: `updatedAt`
  is bumped on *any* edit, so a task finished on Monday and re-tagged on Friday would misreport as
  "completed Friday" if used to approximate a completion date. Rather than ship a "tasks completed
  this week" chart quietly built on that wrong assumption, this feature stops at what the current
  data actually supports. Adding real time-series stats later needs a dedicated `completedAt`
  field set at the point of completion — a real (small) schema change, not a computation change,
  and not done here.
- **Destructed placeholders (§4d) are excluded from every count.** They have no real content left
  to measure, and counting an empty shell would silently under- or over-state a stat depending on
  what it used to be.
- **Verified with 8 unit tests** against the pure function (`js/insights.test.mjs` — empty-board
  behavior, exclusion of destructed tasks, overdue logic, sort order for tags/projects, combined
  vs. per-task subtask completion rate) plus Playwright coverage of the panel updating live as
  tasks are added/completed.

## 4h. On-device AI assistant (Layer 3)

A real small language model — [HuggingFaceTB/SmolLM2-135M-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct),
int8-quantized ONNX, ~140MB — running entirely in the browser via
[transformers.js](https://github.com/huggingface/transformers.js) on top of onnxruntime-web's WASM
backend. `js/ai.js` is a thin main-thread RPC wrapper (`loadAssistant()`, `generateFocusSummary(tasks)`,
`generateSubtaskSuggestions(task)`, `generateFreeTextReply(prompt, tasks)`) — the actual model load
and generation run in a dedicated Web Worker, `js/ai-worker.js` (see "Runs in a Web Worker, not the
main thread" below). Three actions in the AI assistant panel (`app.html`'s `assistantView`, wired in
`js/app.js`'s `wireAssistantView()`):

- **"What should I focus on today?"** — sends the open (non-done) tasks' titles, due dates,
  priorities, and statuses (not notes — kept out purely to keep the prompt short, not for privacy;
  everything here runs on-device regardless) and asks for a short, specific answer.
- **"Break a task into subtasks"** — asks for 3-6 concrete subtasks for a chosen task. Suggestions
  are shown as a checklist for review; nothing is added to the task until the user picks which
  ones and clicks "Add selected," going through the exact same `persistTask()` path a hand-typed
  subtask would — same encryption, same tamper-evident history entry, same automation-rule
  triggers. The model's output is a *suggestion staged for review*, structurally no different from
  a template's starter tasks (§9) once accepted.
- **"Ask anything"** — a free-text prompt box, grounded in the same open-task summary the focus
  action uses so the model has real context rather than a bare question. Added because the two
  canned buttons above don't cover an open-ended question — direct user request.

**Runs in a Web Worker, not the main thread.** This wasn't the original shape of the feature — the
first version ran `pipeline()` load and generation inline in `js/ai.js`, which froze the entire tab
for the ~25s model load and the ~85s+ generation (reported directly: "ai assisnt is frezzed"). The
fix moves both into `js/ai-worker.js`, with `js/ai.js` reduced to a `postMessage`/`onmessage` RPC
wrapper (a monotonic request-id map of pending promises, since a worker's `message` events aren't
inherently ordered/correlated to a specific call). The main thread stays interactive throughout —
verified with a real Playwright run that clicks the theme toggle repeatedly *during* a live
generation and confirms it flips every time, not just that the promise eventually resolves.

**Real blocker this hit, worth knowing if this file is touched again: Web Workers do not inherit
the document's `<script type="importmap">`.** `transformers.min.js` has two static top-level bare
specifiers (`onnxruntime-web/webgpu`, `onnxruntime-common`) that used to be resolved by an inline
import map in `app.html` (see the git history around "Add on-device AI assistant" for that
version). An import map only applies to the document that declares it — module workers get none of
it. The fix that unblocks *both* the main thread and a worker: `vendor/transformers/transformers.min.js`
is now hand-patched (documented in `vendor/transformers/SOURCE.md`) to import via relative paths
instead of bare specifiers — `from"./ort.webgpu.bundle.min.mjs"` and
`from"./onnxruntime-common/index.js"` — which resolve correctly regardless of which module graph
loads the file, main thread or worker. This made the import map (and its CSP `sha256-` hash)
unnecessary entirely, not just for the worker path — one fix, two problems solved.

**Gotcha hit while wiring the worker up, don't relearn it the hard way:** `new Worker(url)` resolves
a *relative* `url` against the **document's** URL, not the calling module's own URL — the opposite
of how `import` statements resolve. `js/ai.js` uses
`new Worker(new URL("./ai-worker.js?v=...", import.meta.url), { type: "module" })`, which resolves
correctly regardless of caller; a bare relative string would 404 the worker script.

**Nothing here ever leaves the device except the one-time model download.** Once
`HuggingFaceTB/SmolLM2-135M-Instruct`'s files are fetched from Hugging Face's CDN — the only
network request this feature ever makes — the browser's Cache API (`env.useBrowserCache = true`)
keeps them, so every subsequent use, including offline, is a pure local WASM computation. Loading
is opt-in: nothing downloads until the user clicks "Enable AI assistant" in the panel.

**Why WASM, not WebGPU** — the roadmap line for this feature said "via WebGPU." That's not what
shipped, for a concrete, discovered-not-assumed reason: `transformers.min.js` (the vendored
browser build) contains a *static* top-level `import * as X from "onnxruntime-web/webgpu"` —
executed unconditionally at module-load time regardless of which device you actually request at
runtime. Bare specifiers like that are meant to be rewritten by a bundler (Vite, webpack, esbuild)
into a real URL; this project ships zero build step by design (§5d, "Verifiable frontend"), so the
browser can't resolve it natively. A native browser **import map** (`app.html`'s
`<script type="importmap">`, mapping `onnxruntime-web/webgpu` and the further bare specifier it
pulls in, `onnxruntime-common`, to vendored local files) fixes the *load* error — but the feature
still explicitly forces `device: "wasm"` rather than `"auto"`, because getting the module graph to
resolve is a different problem from onnxruntime-web's WebGPU execution provider actually working
well in an unbundled page, which wasn't verified and wasn't the point of this pass. Real GPU
acceleration here is future work, gated on either a bundler or a from-scratch browser-native WebGPU
integration — see `vendor/transformers/SOURCE.md` for the exact bare-specifier-patch mechanics
(no longer an import map — see "Runs in a Web Worker" above).

**This required loosening the site's CSP — two specific, tested-not-assumed additions to
`script-src`**, each hit and fixed while getting the pipeline to actually run under this site's
real policy rather than an unrestricted scratch page: `blob:`, because onnxruntime-web's
worker-loading path dynamically imports a `blob:` URL; and `'wasm-unsafe-eval'`, the CSP Level 3
token that permits `WebAssembly.instantiate()` specifically, without granting the general
`eval()`/`Function()` access the broader `'unsafe-eval'` would. (A third addition, a `sha256-` hash
for an inline import map, was needed for one earlier version of this feature — see "Runs in a Web
Worker, not the main thread" above for why it's gone.) See docs/THREAT_MODEL.md's A5 entry for the
honest security cost of the two that remain.

**Measured, not estimated, performance** (single-threaded CPU WASM — threaded WASM needs
`SharedArrayBuffer`, which needs cross-origin isolation headers this site doesn't set, so it's
pinned off rather than silently failing at runtime): model load took ~25s, and generating a
~150-token reply took ~85.6s in the standalone test this feature's design is based on. That's slow
enough that pretending otherwise would make the feature feel broken, so the UI doesn't try:
a visible progress bar during download, explicit "this can take about a minute" copy before every
generation, and `MAX_NEW_TOKENS = 110` in `js/ai.js` to keep worst-case wait bounded rather than
open-ended.

**What isn't covered:**
- **Safari.** The vendored WASM runtime pair (`ort-wasm-simd-threaded.asyncify.wasm/.mjs`) is the
  one onnxruntime-web loads by default in non-Safari browsers; Safari uses a different pair
  upstream that isn't vendored here. The feature will fail to load on Safari today.
- **Answer quality.** 135M parameters is genuinely small — answers are plain and sometimes generic,
  not the kind of reasoning a larger hosted model would give. That's the deliberate trade-off for
  "small enough to download once and run on a phone-class CPU," not a bug.
- **Test coverage.** Unlike this project's other pure-logic modules, there's no `js/ai.test.mjs` —
  this project has no checked-in Playwright suite at all (see §5d "Verifiable frontend"), only
  one-off scratch verification scripts run by hand each session. Both this section's original
  performance numbers *and* the Web Worker fix above were verified this way: real downloads, real
  model, real generation, no mocking — including a real-time check (repeatedly toggling the theme
  during a live generation and confirming it responds instantly) that the main thread actually
  stays responsive, not just that the promise eventually resolves. That's real evidence the feature
  works, just not re-run automatically on every future change the way a committed test suite would.

## 4i. Notes (Layer 3)

Free-form title+body writing for anything that doesn't fit a task — an appointment's details, a
reference number, a longer thought. A separate entity from tasks, not a task field.

- **Record shape:** `{ id, title, body, tags, createdAt, updatedAt }`, encrypted the same way tasks
  and automation rules are — `js/crypto.js`'s `encryptTask()`/`decryptTask()` reused as-is (already
  a generic AES-GCM-encrypt-a-JSON-object pair, not task-schema-specific), stored in their own
  `notes` IndexedDB object store (`DB_VERSION` 4→5). `js/app.js`'s `loadNotes()`/`addNote()`/
  `updateNote()`/`removeNote()` mirror the automation-rules functions in shape and are the entire
  data layer; `js/ui.js`'s `renderNotesList()` renders them as cards (title, a body preview
  truncated to 160 chars, tag chips reusing the same `tagChips()` helper task cards use, and a
  relative "Updated" date via `Intl.RelativeTimeFormat`, falling back to an absolute date past six
  days) into a dedicated `notesView` reached from its own rail icon, with add/edit through one
  shared `noteModal` (`js/app.js`'s `openNoteModal()`/`wireNoteModal()`). Tags reuse the same
  freeform comma-separated `parseTagsInput()` parser tasks' tag field uses, exposed from `ui.js` via
  `readNoteForm()` (mirroring `readAddForm()`/`readEditForm()`). The note body field has a live
  character counter against its 20,000-char `maxlength`.
- **The decoy vault gets its own independent notes**, same as its own tasks/history/rules — `notes`
  is part of the same per-database object-store layout `js/store.js`'s `upgrade()` creates for both
  `haven` and `haven-decoy`.
- **Honest scope limit:** local-only for now — not included in `syncNow()`'s push, and not wired
  into the fragment-key share-link flow (§5b) that tasks use. Both are natural follow-ups, not done
  here; a note currently lives and dies on the one device that wrote it.

## 4j. Compartmentalised vaults (Layer 2)

Real work/personal vaults with separate keys — distinct from both the lightweight "project" filter
(§ above, a string field within one shared vault) and §4e's decoy vault (a single, hidden,
duress-specific second vault with its own passphrase). A compartment is openly listed, named by
the user, and switchable at will without leaving the app.

- **Reuses §4e's exact mechanism, generalized.** Each compartment gets its own DEK, its own Ed25519
  signing identity, and its own IndexedDB database (`haven-vault-<id>`, via the same
  `openNamedDB()`/`upgrade()` any new database name already goes through) — the same three-part
  isolation the decoy vault already has, just for an arbitrary user-created list instead of one
  hardcoded second vault.
- **Wrapped under the main DEK, not the KEK — a deliberate departure from every other wrapping in
  this app.** Every other wrapped key here (`wrappedDek`, `wrappedDekDecoy`, `wrappedSigningKey`,
  etc.) is wrapped under a KEK derived fresh from a passphrase. The KEK is intentionally *not*
  retained in memory once unlock finishes (see §2) — so wrapping a compartment's DEK under it would
  mean re-deriving a 600,000-iteration PBKDF2 KEK (re-prompting for the passphrase) on every single
  vault switch. Instead, `createCompartmentVault()`/`switchToVault()` (`js/app.js`) wrap each
  compartment's DEK and signing key under **the main vault's own DEK**, cached in memory as
  `mainVaultDek` for the session the same way `dek` itself is. This is the same "wrap one
  already-unlocked key under another" pattern ephemeral tasks (§4d) use for their per-task keys,
  one level up: anyone who can decrypt the main vault can enumerate and enter every compartment
  inside it (they're rooms in the same house, not separate houses like the decoy vault is), but
  switching between them needs no further passphrase entry.
- **Main-vault-only, on purpose.** `mainVaultDek` is only ever populated on a real (non-decoy)
  unlock; the vault switcher is hidden entirely (`syncVaultUI()`) whenever `activeVaultIsDecoy` is
  true. Compartments inside a decoy vault would be a confusing, low-value nesting the roadmap
  doesn't call for — the decoy vault stays a single, simple, plausible second vault.
- **Switching reuses `afterUnlock()`.** A vault switch is not a separate code path from unlocking —
  `switchToVault()` re-points `store.js`'s active database (`setActiveVault()`, already generic
  over any db name string, not just the original main/decoy boolean), swaps `dek`/
  `historySigningKey` to the target vault's own, re-primes the history-chain tip for that vault's
  own log, and calls the exact same `afterUnlock()` initial-unlock uses to reload tasks/notes/
  rules/projects and re-render. "Switch vaults" and "unlock" are the same operation on a different
  target, not two things to keep in sync.
- **Honest scope limit:** compartments don't sync (same local-only limitation as notes, §4i, and
  for the same reason — sync would need its own design for multiple per-compartment blobs, not
  implemented here) and aren't included in the fragment-key share-link flow (§5b). A compartment
  currently lives and dies on the one device that created it, same as a note does.

## 4j-2. Vault security-posture checklist (Layer 2)

A command-palette modal ("Security checklist") that reads real, already-persisted state and
reports it plainly — no score, no fabricated signal for anything the app can't actually verify.

- **Every item reads state that already exists for another reason** — nothing was added just to
  populate this screen, except two small persistence points noted below:
  - *Recovery code saved*: `keyring.recoveryCodeConfirmedAt`, written the moment the setup flow's
    "Continue to Haven" button is clicked (gated on the existing "I've saved this" checkbox) —
    previously that checkbox only unblocked the button and was discarded, this persists the
    timestamp. Vaults created before this shipped simply have no value here, honestly reported as
    "not recorded" rather than assumed false.
  - *Recent backup exported*: a single `localStorage` timestamp (`haven-last-backup-at`) written at
    the end of `exportTasks()`, checked against a 30-day window.
  - *Passkey unlock*, *decoy vault*, *synced to another device* read `keyring.webauthnCredentialId`,
    `keyring.saltDecoy`, and `getSyncConfig()` respectively — all pre-existing fields this feature
    only reads, never writes.
- **Each unmet item's "Set up" button closes this modal and opens the real modal for that
  feature** (`openPasskeyModal`, `openDecoyVaultModal`, `openSyncModal`) rather than duplicating
  any setup UI — this screen is a dashboard over existing flows, not a new one.
- **Deliberately excluded, not an oversight:** passphrase strength (the passphrase itself is never
  retained anywhere after the KEK is derived from it at setup — there is nothing left to grade
  after the fact) and social recovery share distribution (the app generates and displays shares
  once; whether they were actually given to k-of-n trusted people happens entirely outside the
  app's visibility). A checkmark for either would be reporting something the app doesn't actually
  know, which is the specific failure mode this feature exists to avoid — see the "real bytes, not
  a simulated hacker aesthetic" principle in §6.

## 4k. Time-locked tasks (Layer 3)

A task whose content is genuinely undecryptable until real, sequential computation has been
performed — not a UI gate on `Date.now()`. Worth being explicit about *why* it has to work this
way: this app has no trusted server and no trusted third party to appeal to (that's the whole point
of the architecture), so the only honest way to enforce "not yet" against an adversary who already
holds the vault's DEK is to make "not yet" computationally expensive rather than merely checked.

- **A real time-lock puzzle (Rivest-Shamir-Wagner construction), not a clock check.**
  `js/crypto.js`'s `createTimeLockPuzzle()` generates a fresh RSA modulus `n = p·q` via Web
  Crypto's own key generation (reusing its already-audited prime generation instead of hand-rolling
  Miller-Rabin), reads `p`/`q` back out via JWK export to compute `phi = (p-1)(q-1)` locally, then
  uses `phi` — the one shortcut that exists — to jump straight to the puzzle's solution in a single
  `modPow` instead of doing the sequential work. `phi` is used once, synchronously, and never
  returned, stored, or logged. Without it, the *only* way to compute the same value is
  `stepTimeLockPuzzle()`'s dumb loop: repeated modular squaring, one step at a time, `squarings`
  times, with no shortcut — that sequential cost is the entire enforcement mechanism.
- **The per-task key is wrapped under the puzzle's solution, not under the vault DEK.** Same
  per-task-key shape ephemeral tasks (§4d) use — a fresh AES-GCM key encrypts the task content —
  except here it's wrapped (`wrapDek()`) under a key derived (`deriveTimeLockKey()`, SHA-256 of the
  solution's decimal string) from the puzzle's target, computed via the fast path at creation and
  *never persisted*. The stored record holds only the puzzle itself (`n`, `squarings`) plus the
  wrapped key — enough to solve, nothing that shortcuts solving.
- **Honest scope limit — this is a bounded delay, not a calendar date, and the roadmap's original
  wording overclaimed.** A puzzle calibrated for a multi-day wait would require a browser tab
  computing continuously for days, which is impractical to use and was impractical for this
  project to even test. The shipped presets (~10 seconds / ~2 minutes / ~10 minutes) are
  calibrated against a conservative, once-measured squarings-per-second estimate
  (`TIME_LOCK_SQUARINGS_PER_SEC` in `js/ui.js`) — real device speed varies (a known, cited
  limitation of RSW puzzles generally: a faster future device solves sooner), so actual solve time
  trends faster than the label, deliberately never much slower.
- **Chunked and resumable, on purpose — this app has hit a real main-thread-freeze bug before.**
  `continueSolvingTimeLock()` (`js/app.js`) performs squarings in bounded chunks
  (`TIME_LOCK_CHUNK_SIZE`), yielding to the event loop between each so the UI stays responsive —
  the same lesson this project already learned the hard way with the AI assistant (§4h) freezing
  the tab, applied proactively here instead of repeated. Progress (`solveProgress: {current,
  squaringsSolved}`) is persisted to IndexedDB after every chunk: an intermediate squaring result
  is safe to store, since knowing it only lets you continue the sequential work from there, not
  skip ahead — so a reload mid-solve resumes instead of restarting. Verified for real (not
  assumed): interrupted a solve at 14% with a hard page reload, confirmed progress survived at
  14% (not reset to 0%), and confirmed resuming completed successfully.
- **Solved once, not re-proven every open.** Once `squaringsSolved` reaches `squarings`, the task
  converts back into a normal record — its content is re-encrypted under the vault DEK directly
  (`finishTimeLockedTask()`) and the `timeLock` field is dropped. There's nothing left to prove
  once the delay has genuinely elapsed once; requiring the puzzle to be re-solved on every future
  open would be security theater, not an honest additional guarantee.
- **Mutually exclusive with self-destruct in this version.** Combining "erases on open" with "can't
  be opened yet" is a real, untested interaction this pass doesn't take on — the add-task UI
  enforces one or the other, not both.
- **Local-only**, same as notes (§4i) and compartments (§4j): not included in `syncNow()`'s push
  and not wired into the fragment-key share-link flow (§5b).

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
- **Conflict resolution:** field-group CRDT merge (§5a-2) for genuine two-sided conflicts;
  whole-record last-write-wins by `updatedAt` everywhere else (new record, no local counterpart,
  or deletion vs. edit).
- **What the server learns:** record counts, ciphertext sizes, update timestamps, sync frequency,
  the bucket token. Nothing about task contents. The keyring-bootstrap row is exactly as useless
  without the recovery code as a device's own local keyring already is.
- **Deletion:** `deleted: true` tombstones sync; a real delete path also removes the ciphertext
  row server-side (`iv`/`ciphertext` set to `NULL` on the same row, not just a flag toggled) — see
  `server/storage.py`'s `upsert_records`.

## 5-2. Background auto-sync

`syncNow()` itself (§5) was manual-trigger-only from Phase 6 onward — it only ever ran from three
places: enabling sync, joining sync, and a "Sync now" button. Nothing polled in the background,
so a second device's change only appeared after someone noticed and clicked. `startAutoSync()` /
`autoSyncTick()` (`js/app.js`) add a background poll (`AUTO_SYNC_INTERVAL_MS = 4000`) that calls
the exact same `syncNow()`, no separate code path.

- **Started on unlock if sync is already configured, and immediately on enabling/joining sync** —
  stopped on lock and on disabling sync. Same `setInterval`-on-unlock,
  `clearInterval`-on-lock lifecycle `ephemeralSweepInterval` already used, for consistency.
- **Paused while the tab is hidden** (`document.visibilityState`), with an immediate catch-up tick
  on becoming visible again rather than waiting out the rest of the interval — no point polling a
  page nobody's looking at, and no point making someone wait when they come back to it.
- **Silent on failure, deliberately.** A background tick failing (offline, a server hiccup)
  shouldn't interrupt anyone who isn't actively watching a sync status line; the manual button
  still surfaces real errors to someone who is.
- **A real race this surfaced, not a hypothetical one.** `syncNow()` used to advance its pull
  cursor (`SYNC_LAST_KEY`) to wall-clock `now()` after every call, regardless of what was actually
  pulled. The server's pull filter is strictly `updated_at > since` (`server/storage.py`). Under
  manual, human-paced syncing this was rarely reachable; under a 4-second poll it became a fast,
  repeatable failure: if Device A creates a record and Device B's *own* next tick runs before
  Device A has pushed it, B's cursor advances to "now" anyway on that no-op tick — and because
  A's record keeps its original creation timestamp when it's eventually pushed, that timestamp is
  now permanently in B's past. B would never pull that record, on any future tick, because
  `since` only ever moves forward. This is the general form of a bug already caught once before
  in a narrower spot — see `mergeTaskFields()`'s own docstring for the first occurrence, on a
  re-pushed merge's timestamp specifically. **Fix:** the cursor now advances only to the newest
  `updatedAt` actually present among that call's pulled records (`Math.max` over `remoteRecords`,
  never wall-clock time) — a device that pulled nothing leaves its cursor exactly where it was,
  so a not-yet-pushed record from another device can still be found on a later tick, however long
  that takes. Verified with a real two-device Playwright run: a task added on one device with
  neither device ever touching "Sync now" appeared on the other within one poll interval,
  repeatably, after the fix — and reliably failed to appear at all before it.
- **The reveal view (§6) refreshes with it.** `refreshDbDump()` — the "how your data is protected"
  panel's raw-ciphertext dump — now populates automatically on opening that view (previously
  needed a manual click) and refreshes again after every auto-sync tick while that view is open,
  so leaving it open during a live demo shows real, changing ciphertext as a second device's
  edits arrive, not a single static snapshot.

## 5-3. Server-less WebRTC device pairing (Layer 3)

Extends §5's optional relay-based sync into a direct, one-time, peer-to-peer exchange over a
WebRTC data channel — no relay server touches this data at any point, not even as an opaque
ciphertext passthrough the way the optional sync server does. `js/webrtc-pair.js` (connection
setup) + `js/app.js`'s pairing modal wiring and `runPeerSync()` (the actual exchange).

- **Manual signaling, on purpose.** WebRTC still needs some out-of-band exchange of an SDP
  offer/answer to establish a connection at all — that's not a server call here, it's the two
  devices' own owners relaying two short text blobs between the devices themselves, via a QR code
  (native `BarcodeDetector`, no vendored scanning library) or plain copy/paste, always available as
  a fallback. **Non-trickle ICE**: both `createOffer()` and `createAnswer()` wait for
  `icegatheringstatechange` to report `"complete"` before returning the SDP, so the whole offer or
  answer is one self-contained blob exchangeable in a single QR/paste — there's no ongoing
  signaling channel here to trickle candidates over one at a time.
- **STUN only, never TURN.** A public STUN server (`stun.l.google.com`) helps a device learn its
  own public-facing address; it never sees or relays a single byte of the actual connection. TURN
  would relay data through a third party — exactly the "a server touches it" case this feature
  exists to avoid — so it's deliberately not used. If a direct path can't be found (symmetric NAT
  on both sides, restrictive corporate networks), pairing simply fails rather than silently
  falling back to relaying through someone else's server. Reliably works on the same Wi-Fi
  network; not guaranteed across arbitrary networks.
- **Two real bugs a real two-device test caught before this shipped, not hypothetical ones:**
  1. Round-tripping an SDP string through an HTML `<textarea>` (copy out of one device's, paste
     into the other's — exactly what this feature's whole UI does) silently normalizes the
     required `\r\n` line endings down to bare `\n`, which Chromium's SDP parser then rejects
     outright. Confirmed directly: an offer that parsed fine before the round-trip failed after
     it, byte-identical except for line endings.
  2. Trimming that pasted value (a reasonable-looking way to strip accidental whitespace from a
     copy-paste) also strips the *required* trailing line terminator on the SDP's own last line,
     which fails the exact same way. Confirmed the same way: the trimmed string failed, the
     identical string with one `\r\n` appended back succeeded.
     `normalizeSdpLineEndings()` in `js/webrtc-pair.js` fixes both: normalize internal line
     endings, then guarantee exactly one trailing terminator, regardless of what upstream trimming
     already did.
- **A real design mistake caught by the same test, more serious than the SDP bugs.** The first
  version of `runPeerSync()` moved raw *ciphertext* task records between devices, copying the
  relay-sync merge logic verbatim. That logic only works between devices that already share one
  DEK — the relay path's "join" flow explicitly transfers it first, via the recovery code. Two
  devices meeting for the first time through this feature have two completely independent vaults
  with two completely independent DEKs by default; the real test proved it decisively, with the
  receiving device logging genuine AES-GCM `OperationError`s trying to decrypt ciphertext that was
  never encrypted under its own key. **Fix:** exchange *plaintext* task content instead, the same
  trust move the fragment-key share-link feature already makes (§5b) — safe for the same reason:
  nothing about "no server sees this" changes just because the payload is plaintext instead of
  ciphertext, since the whole point is that no server is in the data path at all, and the channel
  itself is DTLS-encrypted end-to-end between exactly these two devices, the same guarantee TLS
  gives a normal HTTPS request. Each side decrypts its own tasks with its own DEK, sends the
  plaintext, and the receiver re-encrypts whatever it gets under *its own* existing DEK via the
  normal `persistTask()` path — no key exchange, no keyring changes, no re-wrapping anything. This
  also removes any need for a shared "since" cursor (§5-2's watermark fix doesn't apply here):
  `mergeTaskFields()` already operates on plaintext task objects, so there's no ciphertext-specific
  bookkeeping to get right.
- **Honest scope limits:**
  - **One-time content push each direction, not a full bidirectional sync.** A deletion on one
    side has no record to send at all — it just doesn't propagate. Self-destructing and
    still-locked time-locked tasks are excluded from what's sent, same reasoning as the relay
    path: their keys are meant to stay local to the device that created them.
  - **Camera scanning depends on browser support for the Shape Detection API's
    `BarcodeDetector`** — present in Chrome/Edge (desktop and Android) but not Safari or Firefox
    as of this writing. The paste fallback is always available regardless and is what every
    automated test here actually exercised end-to-end (a real two-device Playwright run: SDP
    exchange, connection, and decrypted content landing correctly on both sides). The camera
    capture pipeline itself (permission prompt, video stream, cleanup on cancel) was also verified
    for real, with a fake camera device — what's *not* verified by anything in this project's own
    testing is a real camera successfully decoding a real QR code off a real screen, which needs
    an actual device before relying on it live, the same caveat already on record for the
    offline-reload edge case in §"Offline banner".

## 5a-2. Field-group CRDT merge (Layer 2)

Closes a previously-documented honest gap (this doc used to say "CRDT-based merge is later" —
it's landed, at a specific, stated granularity). The server never decrypts, so it can never merge
fields itself; every merge decision below happens client-side, in `syncNow()`.

- **The bug this fixes, concretely:** whole-record last-write-wins means two devices editing
  *different* parts of the same task while offline — one marks it done, the other changes its due
  date — silently loses whichever edit's sync landed second. The loser isn't merged, isn't
  queued, isn't recoverable; it's just gone.
- **A standard LWW-Map CRDT (Shapiro et al.), at field-*group* granularity, not per scalar field.**
  Every task carries `fieldUpdatedAt: {content, status, metadata, subtasks}` alongside its
  existing whole-record `updatedAt`. `content` covers title+notes, `metadata` covers
  priority/dueDate/tags/project/recurrence, `status` covers status+order (board position only
  means anything within a status column). Every mutation site that changes a task — manual edits,
  automation rules, drag-and-drop — bumps only the timestamp for the group(s) it actually
  touched, via `bumpFieldTimestamps()`.
- **A merge keeps each group's most-recently-touched side independently** (`mergeTaskFields()`):
  for each of the four groups, whichever side's `fieldUpdatedAt` for that group is newer wins,
  and the merged record's own `fieldUpdatedAt` records the max of both sides per group so future
  merges stay correct. The merged record's whole-record `updatedAt` is stamped fresh (`now()`),
  deliberately *not* `max(local.updatedAt, remote.updatedAt)` — a real bug caught by testing, not
  a hypothetical: a device that already pushed the newer of the two pre-merge versions has by
  definition already advanced its own sync checkpoint past that value, so a repush stamped with
  that same old max would look like "nothing new" to that device's next pull and never get
  re-fetched, silently failing to converge.
- **Conflict detection needs no stored history or version vector.** A record only gets
  field-merged when the pulling device has a genuinely unpushed local change for it
  (`local.updatedAt > since`, the last successful sync checkpoint) *and* the pulled remote version
  isn't just an echo of what this device pushed a moment ago (`local.updatedAt !== remote.updatedAt`).
  Otherwise it's a clean accept-remote or keep-local, no decrypt needed.
- **The merged result is re-pushed**, not just applied locally — otherwise only the device that
  happened to compute the merge would ever see both changes; every other device needs the same
  merged version pushed back so the whole bucket converges on it.
- **Honest scope limits, stated here and in docs/THREAT_MODEL.md, not glossed over:**
  - **Group granularity, not field granularity.** Title and notes editing on two devices at once
    still resolves as one `content` unit — whichever device's edit is newer wins both, same as
    the old whole-record behavior would have for that pair specifically. A full per-scalar-field
    CRDT (or per-item CRDTs for `tags`/`subtasks` specifically — an OR-Set for tags, a map-by-id
    for subtasks) would be a real refinement, not done here.
  - **Deletion-vs-edit conflicts aren't field-merged.** Tombstone/resurrection semantics for a
    delete racing an edit is a genuinely harder CRDT problem than LWW-Map; `syncNow()` falls back
    to whole-record LWW for any record where `remote.deleted` is true.
  - **Legacy records** (created before this feature shipped, lacking `fieldUpdatedAt` entirely)
    fall back to the exact previous whole-record LWW comparison — `mergeTaskFields()` detects the
    missing field on either side and never guesses at data that isn't there.
- **Verified for real, not assumed:** scripted two independent browser contexts against a real
  local sync server (not mocked) — Device A creates a vault and a sync bucket, Device B joins via
  the recovery code, both devices independently edit *different* groups of the same task before
  either syncs again (B marks it done, A sets a due date), then both sync. Confirmed both ended up
  with *both* changes, not one clobbering the other — and confirmed it converges in both
  directions (A's later sync also picks up B's merged, re-pushed result), which is exactly where
  the stale-timestamp bug above was originally caught.

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

### Selective disclosure share links (extends the above)

"Share the title, not the notes" as a real cryptographic boundary, not a display filter applied
after the fact — the whole point being that a field left unchecked never leaves the device in any
form, ciphertext included, not just "encrypted but the recipient wasn't given the key."

- **One fresh key per shared field, not one key for the whole task.** `createShareLink()`
  (`js/app.js`) loops over the sender's chosen field list (defaults to every field, matching the
  original all-or-nothing behavior for any caller that doesn't specify one) and calls
  `generateDek()`/`encryptTask()` once per field — the exact same primitives §5b already used for
  the whole-task snapshot, just invoked per-field instead of once.
- **No server changes.** The relay's `POST /share` has always treated `iv`/`ciphertext` as opaque
  strings it never parses (§5b) — so the per-field bundle `{fields: {title: {iv, ciphertext},
  ...}}` rides inside the existing `ciphertext` parameter unchanged, and the outer `iv` parameter
  (now unused by decryption, since each field carries its own) is still populated with a real
  random value rather than a fixed placeholder, so a stored share never looks structurally
  different from one made before this feature. This is why "select which fields" needed no
  `server/routes.py` changes at all.
- **Where the keys live:** the URL fragment carries a JSON object, `{field: base64url key}`, one
  entry per shared field — still only in the fragment, still never transmitted to any server, same
  guarantee §5b already relies on. A recipient's browser can only decrypt the fields whose key
  actually appears in their copy of the link.
- **Format detection, not a version flag.** `js/shared.js`'s `parseFragmentKey()` distinguishes
  this format from a pre-existing single-key link by trying to decode the fragment as strict UTF-8
  then parse it as JSON — real AES key bytes essentially never happen to also be valid UTF-8, let
  alone valid JSON, so this reliably tells the two apart without needing to encode a format
  version anywhere. A share created before this feature keeps working for its original expiry: the
  viewer falls back to decrypting the whole snapshot with the single key, exactly as it always did.
  Verified for real: constructed an old-format share directly via the pre-existing primitives
  (bypassing the new field-selection code entirely) and confirmed the viewer still rendered it
  correctly, with none of the new "not shared" notes appearing (correct — that link never had the
  concept of an omitted field).
- **The viewer marks omissions explicitly.** A field with no key in the fragment renders as a
  plain "🔒 \<Field\> not shared" note (or an inline badge for status/priority, which — unlike
  notes/tags/subtasks — always have a real value on every task, so silently vanishing from the
  badge row would read as "no priority" rather than "priority not shared"). `dueDate` is the one
  deliberate exception: a normal task can legitimately have no due date at all, so an omitted due
  date stays silently absent rather than getting its own badge — the same lower-stakes ambiguity a
  task with no due date already has today.
- **Honest scope limit:** still local to this one share action — there's no "default sharing
  profile" or persisted per-recipient preference; every share starts from every field checked and
  the sender re-chooses each time.

### QR codes for share links and the dead-man's switch (extends the above)

A scannable QR code next to every freshly created share link and dead-man's-switch link
(`renderQrCode()`, `js/app.js`) — the same URL that's already in the text field, just also
rendered as a code a phone camera can pick up directly, no typing or copy-paste across devices.

- **Vendored, not CDN-loaded**, same reason as every other `vendor/` library — the site's CSP is
  `script-src 'self'`. `vendor/qrcode/qrcode.mjs` (MIT, `kazuhikoarase/qrcode-generator`,
  unmodified) is a small, dependency-free ES module; see its `SOURCE.md`.
- **Size is computed from the actual payload, not fixed.** A selective-disclosure share link
  (§5b) carries one key per included field in its fragment and can run 500+ characters; a
  dead-man's-switch link carries none and stays short. Real measured difference: 45 modules for a
  short link vs. 97 for a long one — more than double. `renderQrCode()` computes `cellSize` from
  `getModuleCount()` to target a roughly constant ~300px final size regardless of payload length,
  rather than squeezing a long link's much denser code into the same fixed box a short link would
  use, which shipped once and had to be caught: a fixed-size render decoded fine for the short
  dead-man's-switch link but failed a real OpenCV decode of the share-link version, since the
  same box size gave it under half the pixels per module. Re-verified after the fix with a real
  decode (not just a visual check) at realistic (2x/retina) resolution: both link types decode
  back to their exact source URL, byte-for-byte.
- **`createSvgTag()` is called without its `scalable` option**, deliberately — that option
  suppresses the library's own explicit pixel `width`/`height` attributes in favor of pure CSS
  sizing, which left the SVG's rendered size indeterminate in this layout (a computed zero-size,
  invisible element) in real testing. Explicit intrinsic dimensions from the library itself, with
  CSS `max-width: 100%` only as a responsive overflow cap, renders reliably.
- **The rendered output is a plain inline `<svg>`** (`<path>`/`<rect>`/`<title>` elements only, no
  `<script>`), inserted via `innerHTML` — safe under this site's CSP with no additional allowance
  needed, and inherently free of injection risk regardless of the encoded URL's content, since the
  URL only ever influences which QR *modules* are dark/light, never literal text reflected into
  the SVG markup.

### Cryptographic proof of deletion (extends §5b)

A concrete, independently-checkable claim that a revoked share (or cancelled dead-man's switch,
which reuses the same `deleteShare()` call) was actually deleted server-side, not just marked
gone — the same "provable, not just promised" move §5d-2's deploy transparency log already makes
for code, applied here to a user's own data instead. `server/storage.py`'s `deletion_log` table +
`_append_deletion_log_entry()`, `GET /deletion-log`, `scripts/verify-deletion-log.mjs`.

- **Note on scope, stated up front:** the originally-planned design for this was "an exclusion
  proof against the transparency log" — that doesn't actually work, since §5d-2's log tracks code
  *deploys* (integrity-manifest hashes per commit), which has nothing to do with any individual
  user's stored data. This is a separate, purpose-built log for actual data deletion, not a reuse
  of the deploy log.
- **What gets logged, and how it stays privacy-preserving:** on every real share deletion, the
  server appends `{sequence, deletedAt, recordIdHash, ciphertextHash, prevEntryHash, entryHash}`.
  Never the real share id or the ciphertext itself — only `sha256(id)` and `sha256(iv +
  ciphertext)`. This means the log is safe to publish in full (same as the deploy log), and only
  someone who actually held the original id and ciphertext — i.e. the person who created or
  received that exact share — can compute the matching hash and point to "that one is mine." A
  third party reading the log learns nothing about what existed or who deleted it.
- **Hash-chained the same way the deploy log is**: `entry_hash` covers the full entry including
  `prev_entry_hash`, so no entry can be altered, removed, or reordered without breaking every
  `entry_hash` after it. `sequence` is computed explicitly before the row is inserted (not read
  back from `AUTOINCREMENT`) so it can be part of the hash content — same reason the client-side
  deploy-log appender does it this way.
- **A receipt comes back from the deletion itself**, no separate request needed: `DELETE
  /share/<id>`'s response now includes `deletionReceipt`, and the revoke-link / cancel-switch UI
  shows it inline (`formatDeletionReceipt()`, `js/app.js`) rather than only being visible if
  someone thinks to go check a log later.
- **Verification is a real, separate script** (`scripts/verify-deletion-log.mjs`), not just a
  claim the same page that deleted something makes about itself: fetches `GET /deletion-log` from
  any server, recomputes every `entry_hash` from scratch, and — given the original `--iv
  --ciphertext` someone already has locally from having created the share — confirms their
  specific deletion is really in the chain. **A real cross-language hashing bug was caught and
  fixed before this shipped, not assumed correct:** the server computes `entry_hash` over
  `json.dumps(fields, sort_keys=True, separators=(",", ":"))`; a JS verifier using plain
  `JSON.stringify()` on the same object would serialize keys in a different order and get a
  completely different hash for byte-identical data, incorrectly reporting every real entry as
  tampered. Confirmed the fix directly: Python's `sort_keys=True` output and a JS
  `canonicalJson()` that explicitly sorts keys before stringifying were checked to produce
  byte-identical JSON and identical SHA-256 digests before the verifier was trusted.
- **Verified for real, end to end, including the negative case.** A real Playwright run against a
  live local Flask instance: created a share, revoked it through the actual UI, confirmed the
  receipt appeared in the toast, confirmed a follow-up `GET` on the share now 404s, confirmed
  `scripts/verify-deletion-log.mjs` independently found and validated the exact entry using only
  the `iv`/`ciphertext` a real client would have kept — and separately, hand-corrupted one entry
  directly in the SQLite database and confirmed the verifier caught it (`entryHash mismatch`)
  rather than silently passing.
- **Honest scope limits:**
  - **Covers share-link and dead-man's-switch deletion only**, not the optional sync bucket's
    per-task tombstones. Every task delete would be extremely high-volume to log this way, and the
    existing tombstone design doesn't distinguish "deleted because the task was completed and
    cleaned up" from "deleted because the user wants provable erasure" — a real, harder feature,
    not attempted here.
  - **Proves the server's own bookkeeping is internally consistent and that the ciphertext is no
    longer being served** — it does not, and cannot, prove a operator kept no other copy (a
    database backup, a disk snapshot) outside what this application's own code path touches. Same
    class of limitation §5d-2's deploy log already states plainly for code integrity.

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
- **Background integrity watch** (`startHistoryIntegrityWatch()`/`checkHistoryIntegrity()`,
  `js/app.js`) — `verifyHistoryChain()` itself is unchanged; what's new is that it now also runs
  on its own every 5 seconds while unlocked (paused while the tab is hidden, same lifecycle as
  auto-sync, §5-2), driving a small always-visible header badge instead of only ever running when
  someone opens the History panel and clicks "Verify now". Hidden entirely on a fresh vault with
  no history yet; shows "History verified" once there's something to check, and flips to a loud
  "⚠ Tampering detected — \<reason\>" the next time it runs after anything breaks the chain.
  Verified for real: a Playwright run that hand-edited a stored history entry's `signature` field
  directly in IndexedDB — the same action DevTools' own IndexedDB panel would perform — and
  confirmed the badge flipped from verified to tampering-detected within one check interval, with
  no click, no reload, and no code path different from what "Verify now" already ran.
  **Honest cost note:** each check re-verifies every entry in the log from scratch (real Ed25519
  signature checks, not just re-checking the newest one), so this trades a small, currently
  unmeasured amount of continuous CPU for a vault with a very large history against catching
  tampering without anyone needing to go looking for it. Negligible for a normal task list; not
  benchmarked against a multi-year, many-thousand-entry history.
- **Honest v1 scope limit — this is local-only.** The log lives in IndexedDB and is not currently
  synced anywhere. That means it protects against corruption or tampering *of the local store
  itself* (a buggy migration, a rogue browser extension poking at IndexedDB, disk-level bit rot)
  but **not** against an attacker with the same level of access this device's own JavaScript has —
  such an attacker could rewrite the log and `signingKeyLog` consistently with each other, since
  both live in the same tamperable storage. It also does **not** yet defend against a malicious
  sync server silently dropping or reordering entries, which would require syncing the log itself
  (as opaque signed blobs, the same "dumb blob store" pattern as `/sync/push`) and is real,
  scoped, not-yet-built future work — not a claim this version makes.

## 5c-2. Post-quantum hybrid signing (Layer 3)

A second, independent ML-DSA-87 signature alongside every Ed25519 one above — not a replacement,
a hybrid: every history entry and backup that has a `pqSignature` also still has its classical
`signature`, and verification checks both. `vendor/noble-post-quantum/` (vendored, see its
`SOURCE.md`), `js/crypto.js`'s `generatePqSigningKeypair()`/`signBytesPq()`/`verifyBytesPq()`.

- **Why signing, not a KEM — the scope correction that came before any code.** The originally
  brainstormed pitch was "hybrid ML-KEM wrapping share-link keys." That doesn't actually work:
  Haven's confidentiality path (AES-256-GCM content encryption, PBKDF2 passphrase-derived keys,
  Shamir social recovery) has no classical public-key encryption step anywhere to hybridize with a
  KEM in the first place — see A7 in docs/THREAT_MODEL.md, which already correctly identifies
  confidentiality as quantum-safe *today*, with no "harvest now, decrypt later" exposure to begin
  with. Signing genuinely is different: Ed25519 is a real classical algorithm a large enough
  quantum computer could eventually forge new signatures under, and hybrid dual-signing was
  already the threat model's own stated correct mitigation before this shipped — this is that
  fix, not a new idea invented for this feature.
- **ML-DSA-87** (FIPS 204, standardized CRYSTALS-Dilithium), not ML-DSA-44 or -65 — the vendored
  library's highest of NIST's three security categories, chosen to match this app's existing
  AES-256 posture rather than a lower one.
- **Generated and wrapped exactly like the Ed25519 key**, one layer on top: `wrapRawBytes()` /
  `unwrapDek()` (already generic over "some raw bytes," used elsewhere for the WebAuthn-wrapped
  DEK) wrap the ML-DSA secret key under the same passphrase-derived KEK, in new
  `wrappedPqSigningKey`/`pqSigningKeyWrapIv`/`pqSigningPublicKey`/`pqSigningKeyLog` keyring fields
  paralleling `wrappedSigningKey`/`signingKeyWrapIv`/`signingPublicKey`/`signingKeyLog`. A
  recovery-code reset rolls a fresh identity for *both* keys together, appending to both logs, for
  the same "the old key was only ever wrapped under the now-forgotten passphrase" reason the
  classical key already doesn't survive a reset.
- **Additive to the signed content, not a change to it.** `historyEntryContent()` — the exact
  object the classical signature covers — is untouched; `pqSignature` and `pqPublicKey` are plain
  sibling fields signing/verifying the *same* canonical bytes under the second algorithm, added
  only when a PQ identity is active. This was a deliberate safety choice: changing what the
  classical signature covers based on whether a PQ key happens to exist would have put the
  already-shipped Ed25519 path at risk for zero benefit — an entry from before this feature, or
  from an excluded path below, looks exactly as it always did, and a hybrid entry's classical half
  verifies with exactly the same code as it always has.
- **A real bug caught by testing, not shipped on faith:** noble's `ml_dsa87.sign()`/`.verify()`
  require an actual `Uint8Array`, unlike WebCrypto's Ed25519 functions (which accept either an
  `ArrayBuffer` or a typed-array view) — `base64ToBuf()` returns a plain `ArrayBuffer`, so a
  freshly round-tripped public key or signature coming out of storage silently failed verification
  every time, even when genuinely valid. First real end-to-end test caught it immediately: a
  freshly-signed, never-tampered entry reported "Bad PQ signature." Fixed by coercing with `new
  Uint8Array(...)` at the `signBytesPq()`/`verifyBytesPq()` boundary rather than trusting every
  future caller to remember the distinction.
- **Verified for real, including a case the classical check alone can't catch:** a Playwright run
  that hand-tampered *only* the `pqSignature` field of a real entry — leaving its classical
  `signature` completely untouched — confirmed the integrity badge (§5c) still caught it (`Bad PQ
  signature`), proving the hybrid check genuinely requires breaking *both* signatures, not just
  one. Separately verified end-to-end across two devices: exported a hybrid-signed backup from one
  vault, imported it into a completely independent second vault, and confirmed the import
  reported "verified ✓ (classical + post-quantum)" — both signatures, checked with two different
  algorithms, both passing on genuinely valid data.
- **Honest v1 scope limit — covers the main vault's normal passphrase unlock/setup/reset only.**
  Deliberately excluded, each for a real reason rather than an oversight:
  - **Compartmentalised vaults (§4j)** each already have their own fully independent classical
    signing identity; extending that to a parallel PQ identity per compartment was judged not
    worth the added keyring surface for a Layer-2 feature with a much smaller usage footprint than
    the main vault. Entries created in a compartment are signed classically only — handled by the
    same "no `pqSignature` present" case every pre-PQC entry already needs to be a non-error for.
  - **Passkey/WebAuthn unlock (§4c) and hardware-wrapped keys** don't generate or unwrap a PQ
    identity either, explicitly nulled out on that path rather than left stale — the same reason:
    a rarer, opt-in unlock method, not the primary flow.
  - **The decoy vault is *not* excluded** — `ensureLocalSigningKeyOnUnlock()`'s existing
    `isDecoy` field-suffix parameterization already covers both vaults uniformly, so the decoy
    vault gets its own fully independent PQ identity for free, the same "not a second-class
    version of the feature" treatment its classical identity already gets.

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

## 5d-2. Deploy transparency log (Layer 2)

Extends §5d from a single current snapshot (`integrity.json` shows what's live *right now*) into
a history: proof of what's *ever* been live, in a form a visitor doesn't have to trust this site's
own JavaScript to check.

- **A hash-chained, append-only log**, `transparency-log.json` (repo root). Each entry records a
  deploy's git commit and a hash of that deploy's full `integrity.json` manifest, plus the hash of
  the *previous* entry — standard hash-chain construction, the same property a blockchain or an
  append-only Certificate Transparency log relies on: altering any past entry changes its own hash,
  which no longer matches what the next entry recorded, breaking the chain from that point forward
  in a way that's detectable, not just against policy.
- **`scripts/append-transparency-log.mjs`** computes and appends one entry; run as the last step
  before every `wrangler deploy` (see the deploy process in `CLAUDE.md`). **Never backfilled** —
  the log starts truthfully at the commit where it was introduced, not with fabricated entries for
  earlier deploys that predate it; doing otherwise would be exactly the kind of claim this whole
  feature exists to make unnecessary.
- **Verified two independent ways, deliberately not just one:** `transparency.html` re-walks the
  entire chain client-side using the browser's own `crypto.subtle.digest`, and
  `scripts/verify-transparency-log.mjs` does the identical check as a plain Node script — so a
  skeptical visitor isn't stuck trusting this page's own JS to grade its own homework. Confirmed
  both actually catch tampering, not just pass on good input: corrupted a field in a real log entry
  and confirmed both the page (red "✗ BROKEN" row, red summary) and the Node script (non-zero exit)
  caught it, then confirmed restoring the original file made both pass again.
- **Honest scope limit, stated on the page itself, not buried here:** this log is self-hosted —
  committed to the same repository and served from the same host as everything else. It proves the
  deploy history is *internally consistent*, not that it's *impossible* to tamper with: a host
  capable of serving different code to different visitors could in principle also serve a
  consistently-tampered version of this log to itself. Closing that gap for real needs independent
  third parties fetching and archiving entries over time — the same reason real Certificate
  Transparency requires multiple independent log operators, not one self-reporting party. This is
  meaningfully more verifiable than a claim in a privacy policy; it is not an
  information-theoretic guarantee.

## 5e. Verifiable, signed backups (Layer 2)

Extends §5c's identity to the one other place task data leaves the app as plaintext: a JSON
export. Proves a backup file's contents are exactly what was exported, unmodified since — the
same "provable, not just promised" property §5c gives the local history log, applied to a file
that can sit on a USB drive or in an email attachment for years.

- **No new key.** `exportTasks()` (`js/app.js`) signs with the same per-device `historySigningKey`
  §5c already unwraps on unlock — one identity, two uses (history entries and backups), not a
  second keypair to generate, wrap, or explain to the user.
- **Envelope shape:** `{version, exportedAt, tasks, publicKey, signature}` — `signature` is over
  the canonical JSON of everything except itself (`backupEnvelopeContent()` + the same
  `canonicalBytes()` helper §5c's entries use), and `publicKey` travels *inside* the file so the
  file is self-contained: verifying it needs nothing but the file itself, not a lookup against
  this device's current keyring.
- **Verification (`verifyBackupSignature()`) is a tri-state report, not a gate.** Re-importing a
  `.json` file returns one of `verified` / `invalid` / `unsigned`, shown directly in the import
  toast — the import itself always proceeds regardless (the existing last-write-wins merge is
  already safe/non-destructive), the same "report, don't block" posture `verifyHistoryChain()`
  takes on history entries. A failed or missing signature is something to notice, not something
  that silently prevents recovering your own data.
- **Backward compatible on purpose.** Every export made before this feature shipped is a bare JSON
  array with no envelope at all; `importTasksFromJSON()` still accepts that shape (reported as
  `unsigned`, since there was never a signature to check) rather than breaking old backups.
- **Honest scope limit.** This proves *content* integrity since signing time — it does not prove
  *provenance* in the sense of vouching for the signer's identity if the file arrives from an
  unfamiliar source: the public key is embedded in the file itself, so a party who could tamper
  with the file's tasks could in principle also swap in a different keypair's public key and
  re-sign with it, and the file would still verify — just under a key that never touched this
  device's own `signingKeyLog`. Detecting *that* would need out-of-band key trust (e.g. pinning an
  expected key from a previous, trusted export) — a real, harder feature, not implemented here.
  What this does guarantee: a backup re-imported on the *same* device/vault that produced it, or
  compared byte-for-byte against a copy known to be untouched, is provably unaltered.

## 5f. Public dead-man's switch (Layer 2)

Combines §4k's time-lock puzzle with §5b's share-link relay into a disclosure link that needs no
secret key at all — access is gated purely by computational hardness, so anyone holding the link
can watch it unlock live, and no one (including whoever created it) can unlock it early.

- **No fragment key, unlike every other share link.** `createDeadMansSwitch()` (`js/app.js`)
  generates a fresh RSW time-lock puzzle (`createTimeLockPuzzle()`, §4k), derives an AES key from
  its solution (`deriveTimeLockKey()`), and wraps a fresh content DEK with *that* — so the only
  thing gating decryption is the puzzle itself. The pushed bundle
  (`{n, squarings, wrappedContentKey, contentKeyWrapIv, iv, ciphertext}`) is opaque JSON in the
  relay's existing iv/ciphertext fields, the same repurposing §5b's selective-disclosure feature
  already relies on — no server-side change needed. The resulting URL carries only `?server=&id=`,
  deliberately no `#fragment` — there is nothing secret left to put in one.
- **Standalone viewer, no vault needed.** `deadmanswitch.html` / `js/deadmanswitch.js` is a
  self-contained page (same pattern as `shared.html`) that pulls the bundle, solves the puzzle
  client-side in yielding chunks (`stepTimeLockPuzzle()`, identical chunking to the private
  time-locked task solver), then unwraps and decrypts — entirely in the recipient's own browser,
  on their own CPU. Nothing is persisted: closing the tab loses solving progress, unlike a private
  time-locked task's resumable IndexedDB progress, because there is no vault here to store it in.
- **Cancellation reuses revocation, not a new mechanism.** `cancelDeadMansSwitch()` just calls the
  same `deleteShare()` §5b's normal share links use — deleting the relay record before the puzzle
  finishes is the entire "call it off" story. A small `localStorage` list
  (`haven_dead_mans_switches`) tracks the creator's own outstanding switches for the modal's
  bookkeeping UI; it holds only `{id, server, title, createdAt, expiresAt}`, never content or keys.
- **Honest scope limit**, stated directly in the creation modal's copy: the wait requires a
  browser tab actually running the whole time — the creator's, to prove no early solve is
  possible; a visitor's, once it's time to unlock. There is no way to schedule a genuine
  multi-day public disclosure without some tab staying open that long; the three preset durations
  (`~10s demo`, `~2m`, `~10m`) reflect that constraint rather than a real dead-man's-switch use
  case's actual timescale (days to weeks). A production version of this idea at real timescales
  would need a server that resumes solving on the creator's behalf, which reintroduces exactly the
  "does the server know the secret early" trust question this design otherwise avoids — deliberately
  not attempted here.

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

## 9. Ecosystem & polish

Five smaller features, grouped here because none of them touch the key hierarchy — each is either
a pure, IO-free module (tested in isolation the same way `crypto.js` is) or a thin UI layer over
the existing `addTask()`/`persistTask()` pipeline.

**PWA install** (`manifest.json`, `sw.js`) — a cache-first service worker for exactly the app-shell
file list (`app.html` + its CSS/JS + icons), scoped to `app.html` only. Registered unconditionally
at page load, not gated behind unlock, since it's about the *static assets* loading offline — the
task *data* has been fully offline-capable since Phase 1 (IndexedDB). The precache list is
hand-maintained the same way the `?v=` cache-bust query strings already are (no build step); bump
`CACHE_NAME` when the list changes so old caches get cleaned up on the next `activate`.

**Offline banner** (`wireOfflineBanner()`, `js/app.js`) — makes an already-true fact visible rather
than adding new capability: `navigator.onLine`/the `online`/`offline` window events drive a small
banner, nothing about how offline behavior actually works changes. Coming back online also fires
one immediate `autoSyncTick()` (§5-2) rather than waiting out the rest of the poll interval.

**Verified, and one claim deliberately walked back after further testing contradicted it:** a
genuinely offline Playwright run (`context.setOffline(true)`) confirmed the core claim solidly, on
both a local dev server and live production — a task can be created while offline, renders
immediately, and is still there after reconnecting and unlocking again. What did **not** hold up:
an earlier version of this note also claimed "reloads successfully from the service worker cache
while offline," based only on a local-HTTP test where that happened to succeed. Repeating the same
reload against live HTTPS production gave inconsistent results across repeated trials — sometimes
a real cache-served `200`, sometimes `net::ERR_INTERNET_DISCONNECTED`, with identical service-worker
registration/scope/cache-population confirmed in every case. That inconsistency points at
Chromium's CDP-driven offline simulation interacting differently with an HTTP/3 connection
(production advertises `alt-svc: h3`) than a trivial local HTTP/1.1 one, rather than at anything in
this app's own service-worker logic — but that's a plausible explanation, not a confirmed one, and
it isn't something this app's own test tooling can fully settle. **Practical upshot, stated
honestly rather than glossed over:** treat "create/edit tasks while offline" as solid for a live
demo; don't build the demo around also reloading the page mid-airplane-mode until someone has
confirmed that specific sequence with real airplane mode on the actual presenting device, not just
a simulated offline flag.

**Calendar view + iCal export** (`js/ical.js`, month-grid UI in `js/ui.js`'s `renderCalendar()`) —
shows every task with a due date across all projects; exporting produces a standard RFC 5545 `.ics`
file. One-way only: this is an export, not a live CalDAV sync, and says so in the UI copy rather
than implying more than it does.

**CSV import** (`js/csv.js`) — a hand-written RFC-4180-ish parser (quoted fields, embedded commas/
newlines, escaped quotes) plus a header-aliasing layer that maps common column name variants
(`Title`/`Content`/`Task`, `Due`/`Date`/`Deadline`, `Priority`, `Tags`/`Labels`, etc.) onto Haven's
task schema. Unrecognized columns are ignored, not rejected — an export with extra app-specific
columns still imports what Haven does recognize. Every imported row becomes a brand-new task via
the normal `addTask()` path (CSV rows carry no id of their own to merge against, unlike Haven's own
JSON export/import round-trip).

- **A dedicated Todoist path, not just generic aliasing.** Todoist's real CSV export isn't a flat
  task list — one file is a whole project, and `TYPE` marks each row as `task`, `section` (a
  project divider, not a task), or `note` (a comment on the task above it), with `INDENT` marking
  sub-task nesting. Feeding that through the generic aliaser would have silently imported section
  headers and note text as bogus tasks — this was a real, verified gap, not a hypothetical one
  (confirmed by testing before fixing it). `isTodoistExport()`/`parseTodoistCSV()` detect the
  `TYPE`/`CONTENT`/`INDENT` column signature and handle it properly: `section` rows become the
  Haven `project` for tasks that follow, `note` rows fold into the preceding task's own `notes`
  (the only place Haven's model has room for free text below task level), and `INDENT > 1` becomes
  a Haven sub-task. **Honest scope limit:** Haven only supports one flat level of sub-tasks, unlike
  Todoist's arbitrary nesting depth — a third-level Todoist indent still flattens onto the nearest
  *top-level* task's sub-task list rather than attempting a nested tree Haven's data model has no
  room for.
- **Notion needs no dedicated path** — a Notion database export is a standard flat CSV with
  ordinary column names (`Name`, `Status`, `Due Date`, `Priority`, `Tags`), which the existing
  generic aliaser already handles correctly, checkbox/select-style values included (verified with
  a realistic constructed sample, `js/csv.test.mjs`'s tests 17).
- **Multi-project imports get called out, not left silent.** A Todoist export spanning several
  sections creates tasks across several Haven projects, but the board only ever shows one project
  at a time — without a heads-up, tasks landing outside whatever project happened to be open would
  look like the import silently did nothing. The import toast now names which project(s) received
  new tasks when it's not the one currently open.

**Time tracking + Pomodoro** (`js/app.js`, edit-modal UI) — a 25-minute countdown scoped to
whichever task's edit modal is currently open; no background timer survives closing it. Elapsed
time accumulates into a plain `timeSpentSeconds` task field — an ordinary encrypted field, no new
crypto — persisted with `logHistory: false` (same reasoning as drag-and-drop reorders: a tick isn't
a meaningful content-audit event the way a title/status change is).

**Board / project templates** (`js/templates.js`) — five static starter task sets (sprint board,
client onboarding, moving house, weekly review, freelance kickoff). Applying one calls `addTask()`
once per starter task — a template-created task is indistinguishable afterward from a hand-typed
one: same encryption, same history-log entry, same automation-rule triggers on creation.
