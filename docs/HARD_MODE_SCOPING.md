# Hard-mode scoping: four Research-tier features, not yet built

FEATURES.md already flags items marked `Research` as "genuinely hard (thesis-scale)... do not
attempt it early." This doc exists because four such items got seriously proposed in a single
session (2026-08-11) alongside a batch of well-scoped, well-understood features that *did* ship
that session — and the honest thing to do with the hard ones was write down what building them
for real would actually require, not attempt shallow, unreviewed versions of all four under time
pressure.

**Why these are a different category from everything else this project has shipped.** Every
cryptographic feature in `docs/ARCHITECTURE.md` reuses well-understood, already-correct primitives
(AES-GCM, PBKDF2, Ed25519, ML-DSA-87, Shamir secret sharing, Merkle trees) in straightforward
compositions, each verified by a real test that would fail if the composition were wrong. The four
features below are different in kind: they're each a *novel protocol design problem*, not a
composition of existing primitives — the kind of thing that gets a design written up, reviewed,
and often formally analyzed (see: the actual published papers behind Signal's X3DH/Double Ratchet,
or the years of Certificate Transparency's own iteration) before it ships to real users protecting
real things. A subtly-wrong version of any of these would *look* like it works in a demo and
*claim* a security property it doesn't actually have — which is a worse outcome than not having
the feature, for a product whose entire pitch is "verify, don't overclaim." That's the bar these
need to clear before landing in ARCHITECTURE.md as something real users can rely on.

Each section below: the real gap, the actual approach, precisely why it's hard, what in the
current codebase it would touch, and a rough size estimate. Not hand-wavy — genuinely sized, so a
future session (or a human reviewer) can pick one up and know what they're actually signing up for.

---

## 1. True multi-person shared vaults

**The gap.** "Sync" today (`docs/ARCHITECTURE.md` §5, §5-2, §5-3) means *one person's* own devices
converging on one DEK, however they get it there (a bearer-token relay, WebRTC, a recovery code).
There is no concept of a second *person* with their own independent identity holding a key to the
same vault. FEATURES.md's Layer 4 already names the destination ("Revocation that works — remove a
collaborator, rotate keys, lock them out of future content") without a design underneath it.

**The approach.** Move from "one DEK, wrapped under however many KEKs" to a real group-key
scheme:
- Each member has their own long-term identity keypair (Haven already has the raw material —
  every vault already derives an Ed25519 signing identity; a group scheme needs an X25519
  *encryption* keypair alongside it, not just signing).
- The vault DEK (or a per-generation "epoch key," see below) gets wrapped individually to each
  current member's public key, not derived from a shared passphrase — adding a member means
  wrapping the current key to their public key; nothing about the existing ciphertext changes.
- **Removing a member must actually revoke future access**, not just stop pushing them updates
  (today's `set_webrtc_answer`/`get_share`-style "no auth beyond knowing a secret" model has no
  concept of this at all). The only way to do that honestly is *key rotation*: generate a new
  epoch key, re-wrap it to every *remaining* member, and re-encrypt (or at minimum, gate all new
  writes under) the new key — the removed member's old key still opens old ciphertext (nothing
  can undo that — they had it once), but can't decrypt anything created after rotation.

**Why it's hard, specifically.** Two things that are each their own research problem:
1. **Efficient re-keying at scale.** Naively, adding/removing a member means re-wrapping one key
   to N-1 remaining members — fine for a handful of people, but the "flagship cluster" framing in
   FEATURES.md implies this should generalize, and real group-messaging systems (MLS — Messaging
   Layer Security, RFC 9420) exist specifically because naive re-wrapping doesn't scale past small
   groups. Adopting MLS properly is itself a multi-week integration, not a rewrite from scratch,
   but it's also the only credible way to not reinvent (and likely get wrong) tree-based group key
   agreement.
2. **Concurrent membership changes.** Two members removing a third person "simultaneously" (offline,
   no server ordering them) need a converging outcome, not two different post-rotation vaults that
   silently diverged. This interacts with the CRDT merge work in #2 below — a group's membership
   state needs its own conflict-free merge, not just its task content.

**What it would touch.** A new keyring shape (`js/store.js`'s `keyring` object store would need a
per-member wrapped-key list, not a single `wrappedDek`), a new identity type (X25519 alongside the
existing Ed25519), a membership-change protocol, and — critically — a decision about whether the
existing sync server (`server/`) becomes a relay for membership/key-rotation messages too, which
reopens exactly the "what metadata does the server see" question every other feature in this
project treats as load-bearing.

**Rough size:** weeks, not days — this is the biggest of the four. A defensible v1 (small, fixed
group size, no MLS, naive re-wrapping) is more tractable than the general case, but "no MLS" means
explicitly disclosing that it doesn't scale, which is itself a real design commitment to make
before writing code, not after.

---

## 2. Real-time collaborative note/task editing (multi-user CRDT)

**The gap.** §5a-2's field-group CRDT merge is genuinely shipped and real, but it's LWW
(last-write-wins) at *field-group* granularity between a *single person's own devices* — "title
changed" beats "title changed earlier," whole field group at a time. Two people typing in the same
note body concurrently (the actual "real-time collaboration" ask) need character-level or
token-level merge — Automerge- or Yjs-style CRDTs — not whole-field LWW, or one person's paragraph
silently overwrites the other's.

**The approach.** A text CRDT (RGA, or a Peritext/Automerge-style rich-text sequence CRDT)
maintains a data structure where every character/operation carries enough position metadata that
two concurrent edit streams merge deterministically, without a central arbiter — the same category
of algorithm Google Docs' internal OT (operational transform) or Notion's own CRDT-backed editor
use, just without a trusted server doing the merging (Haven's server is supposed to stay blind).

**Why it's hard, specifically.**
1. **Encrypting an incrementally-updated document, not a static blob.** Every other encrypted
   thing in this app (`encryptTask`, `encryptBlob`) encrypts a complete snapshot each time it
   changes — simple, but wrong for a live-editing CRDT, where re-encrypting the whole document on
   every keystroke defeats the point of real-time collaboration (either the ciphertext leaks *how
   much* changed per edit if you encrypt only deltas naively, or you're back to whole-document
   re-encryption and it's not actually real-time). Getting this right without leaking edit-size
   metadata to a relay server is a genuinely open engineering problem, not a solved one to just
   copy.
2. **This depends on #1.** A CRDT that merges edits from different *people* needs those people to
   already have a shared key — which is exactly the group-key problem above. Building this without
   multi-person vaults first would mean building it for the *single-user, multi-device* case only,
   which the field-group merge already covers adequately (a person doesn't usually type into the
   same note from two devices at literally the same millisecond).

**What it would touch.** A new document representation for notes (replacing `js/store.js`'s flat
`{id, title, body}` note shape with an operation log or CRDT state), a text-CRDT library decision
(vendor one — Yjs and Automerge both exist as real, audited implementations; rolling a custom one
here would be its own multi-week research project on top of everything else), and a live transport
(WebRTC data channels already exist for pairing — extending that from "one-time exchange" to "a
persistent live channel" is a real, separate lift).

**Rough size:** weeks — and gated on #1 above being solved first for the multi-*person* case to
matter at all.

---

## 3. Forward-secret, ratcheted sync

**The gap.** Sync (`docs/ARCHITECTURE.md` §5) uses one DEK per vault, wrapped once, used for every
push/pull until the passphrase changes. A device that's compromised today can decrypt every record
that vault has ever synced (no forward secrecy) and, if the compromise is silent, everything it
syncs from then on too (no post-compromise security / self-healing) — the entire history is one
blast radius.

**The approach.** A ratchet — the same category of construction Signal's Double Ratchet uses —
derives a fresh symmetric key per sync operation (or per some bounded batch of them) from the
previous key via a one-way KDF chain, discarding old key material as soon as it's used. Two
properties fall out of doing this correctly:
- **Forward secrecy:** compromising the *current* key doesn't recover *past* records, because the
  KDF chain that produced past keys is one-way — you can't run it backwards from a later key.
- **Post-compromise security:** if the ratchet also periodically mixes in fresh randomness (a
  "DH ratchet" step, in Double Ratchet terms) rather than being a pure one-way hash chain, a
  compromised device that keeps syncing eventually "heals" — an attacker who stole a key at time T
  loses the ability to derive keys past the next fresh-randomness mix-in, even without the user
  doing anything explicit like a passphrase change.

**Why it's hard, specifically.** Ratchets are exactly the kind of primitive where "it looks like
it works" and "it actually provides forward secrecy under every real-world message-loss/reordering
scenario" are very different bars. Signal's own Double Ratchet handles out-of-order delivery,
dropped messages, and skipped keys with specific, carefully-reasoned-about mechanisms (`skipped
message keys` caching, chain key vs. message key separation) — a naive "just hash the key forward
each time" implementation breaks the moment two devices sync out of order (which, for Haven's
actual sync model — occasional background pulls, not a live message stream — is the *common* case,
not an edge case). Getting the *interface* between "how often does the ratchet step" and "how does
Haven's actual pull-based, occasionally-offline sync pattern work" wrong would silently produce
something with none of the claimed properties while still "working" in every test that doesn't
specifically probe for it.

**What it would touch.** `server/storage.py`'s `records` table (currently keyed by `token, id`,
with no concept of key generation), the sync protocol itself (`POST /sync/push`/`GET /sync/pull` in
`server/routes.py` would need to communicate which key-generation a record was encrypted under),
and `js/app.js`'s `syncNow()`/`getSyncConfig()` machinery for maintaining ratchet state
client-side, persisted somewhere that survives a reload (today's DEK is derived fresh from a
passphrase every unlock — a ratchet state is *not* re-derivable that way by design, so it needs its
own durable, encrypted-at-rest storage, which is a new kind of secret this app hasn't had before).

**Rough size:** the hardest to get *correctly* right of the four, even though it touches less
surface area than #1 — correctness here is adversarial-analysis-grade, not "does the happy path
work in a test."

---

## 4. Privacy-preserving push notifications (searchable encryption)

**The gap.** Already named in FEATURES.md: "Metadata-aware reminders / web push (ping without the
server knowing what) — High." Today, "3 things due tomorrow" only exists if the app is open in a
tab (or, as of this session, as an app-icon badge count computed client-side — see
`docs/ARCHITECTURE.md` §4m — which has zero server involvement precisely *because* it never needed
one). A real push notification needs *something* server-side to wake up and tell a push service
"notify this user now" — and the sync server is deliberately blind to due dates today, so it has
no way to know *when* "now" is for any given task.

**The approach.** The server would need to learn *just enough* to trigger at the right time,
without learning task content — the textbook case for **searchable symmetric encryption (SSE)** or
a narrower purpose-built scheme: the client computes something like an encrypted "wake me at time
T" token per task (e.g., a keyed value derived from the due date + a per-vault secret, structured
so the server can recognize "a token matching *now*" without being able to invert it back to a
due date for tasks that haven't fired yet, and without correlating two tokens as belonging to the
same task).

**Why it's hard, specifically.** SSE schemes have a long history of looking secure and then having
a published leakage-abuse attack a year later — the *access pattern* itself (which encrypted
tokens get "matched" together, and when) is exactly the kind of side-channel that's easy to get
subtly wrong and hard to notice you got wrong, because the scheme still "works" functionally the
whole time. A narrower, purpose-built scheme (not general SSE, just "due-date bucketing") is more
tractable than adopting a general-purpose searchable encryption library, but "narrower and
purpose-built" is also exactly the kind of thing that needs real cryptographic review before
shipping, not a first-pass implementation trusted on the strength of its own tests passing.

**What it would touch.** A new, minimal server-side component (Render's free tier has no
persistent worker/cron today — see the visitor-count cache and webrtc-relay room-reaping comments
in `server/routes.py` for the existing workarounds for that same constraint — so this would need
either a paid tier with a real scheduled job, or a clever poll-on-request design), a client-side
token-derivation scheme, and a Web Push subscription flow (`manifest.json`/service-worker changes,
`sw.js` already exists and already does real caching work, so push-event handling is a real but
smaller addition on top of it).

**Rough size:** medium engineering lift, but gated on getting the actual cryptographic scheme
right first — the *implementation* isn't the hard part here, the *scheme design* is, and that part
specifically benefits from outside review before it ships.

---

## What this doc is and isn't

This is a design/scoping reference, not a promise or a roadmap commitment beyond what FEATURES.md
already states (`Research` tier, "do not attempt it early"). None of the four features above are
implemented. If one of them gets picked up, update `docs/ARCHITECTURE.md` and `docs/FEATURES.md`
in the same commit as real, tested code — same discipline as everything else in this project — and
this doc should shrink by one section per feature that graduates from "scoped" to "shipped."
