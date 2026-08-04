# SECURITY.md — Haven

> The self-attack checklist from `docs/THREAT_MODEL.md`, actually run — against a real running
> app in a real browser and a real sync server, not just read from the source. Every item below
> was executed on 2026-08-03 against the code at this commit; scripts are throwaway and not
> checked into the repo, but the exact steps are described so any of this can be re-run.
>
> Note: at the time these checks ran, the app shell was `index.html`. It was later renamed to
> `app.html` (Phase 8, when `index.html` became the marketing page so the custom domain's root
> serves it) — every finding below still applies unchanged to `app.html`, only the filename moved.

## Results

- [x] **XSS via task content** — Injected `<script>alert(1)</script>`, `<img src=x
      onerror=alert(1)>`, `<svg onload=alert(1)>`, and a `javascript:` URL as task titles via both
      the quick-add bar and the Add Task modal. No dialog ever fired. DOM inspection confirmed the
      payloads land as HTML-escaped text (`&lt;img src=x onerror=alert(1)&gt;`) inside a `<h3>`,
      never as live markup — `js/ui.js` renders exclusively via `textContent`, as designed.
- [x] **CSP bypass** — Injected `<script src="https://evil.example.com/payload.js">` and an
      inline `<script>window.__inlineRan = true</script>` into `<head>` at runtime. Both were
      blocked; the console logged real `Content-Security-Policy` violation reports for each. The
      inline script never executed (`window.__inlineRan` stayed `undefined`).
- [x] **IDOR on sync** — Covered by `server/tests/test_sync.py::test_cross_token_isolation` and
      `test_keyring_bootstrap_cross_token_isolation`, re-run clean at commit time. Token B's push
      cannot read or overwrite token A's bucket.
- [x] **IV reuse** — Encrypted the identical task object 20 times in a row with `encryptTask()`.
      All 20 IVs were unique (`crypto.getRandomValues(new Uint8Array(12))` per call, never a
      caller-supplied or derived IV — see `js/crypto.js`).
- [x] **Key-in-memory exposure** — The DEK lives only in a module-scope `let dek` in `js/app.js`,
      as a non-extractable `CryptoKey`. Locking (`#lockBtn`) sets `dek = null`; a fresh
      `localStorage`/`sessionStorage` dump immediately after lock was empty in both. Nothing about
      the DEK is ever written to storage — only its *wrapped* form (via the passphrase- and
      recovery-derived KEKs) persists in IndexedDB's `keyring` store.
- [x] **Plaintext leak to storage** — Added tasks with sensitive titles/notes, then read
      IndexedDB directly (bypassing the app's own code) via `indexedDB.open("haven")`. Stored
      records contain exactly `{id, iv, ciphertext, updatedAt}` — no plaintext field, and the
      payload text never appears anywhere in the raw dump.
- [x] **Plaintext leak to network** — Added a task with an identifying secret title, enabled
      sync against the local server, and captured every request/response body Playwright saw on
      port 5050. The secret string and the passphrase never appeared in any request or response
      body across all 6 exchanges (push, pull, keyring push, keyring pull, and their responses).
- [x] **Tamper detection** — Flipped one byte of a real ciphertext and attempted decryption with
      the correct DEK. `decryptTask()` threw — AES-GCM's authentication tag rejects any
      modification rather than returning corrupted plaintext.
- [x] **Wrong-passphrase behaviour** — A deliberately wrong passphrase produces "Wrong
      passphrase.", clears the input, and leaves the app locked (`#mainWrap` stays hidden). The
      correct passphrase still works immediately afterward — no lockout, no corrupted state.
      Timing note: `deriveKek()` (the 600,000-iteration PBKDF2 step) always runs to completion
      before the cheap AES-GCM unwrap is attempted, on both the correct- and wrong-passphrase
      paths — so failure timing is dominated by the same fixed KDF cost either way, not a fast
      early-exit that would let an attacker distinguish "wrong passphrase" from "wrong KEK" via
      response time.
- [x] **Recovery-code entropy** — `generateRecoveryCode()` draws 32 bytes (256 bits) from
      `crypto.getRandomValues`, never `Math.random`. Same for `generateSyncToken()` (also 32
      bytes / 256 bits). Confirmed by reading `js/crypto.js` and `js/sync.js` directly — no other
      random-value call sites exist in either file.
- [x] **Deletion is real** — Covered by
      `server/tests/test_sync.py::test_deletion_scrubs_ciphertext_not_just_flags_it`, re-run clean.
      `storage.py`'s `upsert_records` sets `iv`/`ciphertext` to `NULL` the moment a record is
      marked deleted — the tombstone row keeps only `id`/`updated_at`/`deleted`.
- [x] **Dependency audit** — Zero `<script src>` or `<link>` tags point outside this origin.
      The only vendored asset is a self-hosted webfont (`vendor/fonts/special-elite/`, sourced per
      `SOURCE.md`, loaded via same-origin `@font-face`). `vendor/hash-wasm/` is an intentionally
      empty placeholder (see `docs/ARCHITECTURE.md`'s directory layout) for a future Argon2id
      migration — nothing is loaded from it today. Because every resource is same-origin, Subresource
      Integrity doesn't apply in the way it would to a CDN dependency — SRI protects against a
      *third-party host* serving tampered content, which isn't the delivery model here. The actual
      trust dependency is "whoever serves this origin serves the real files," which is exactly
      A1/A5 in `docs/THREAT_MODEL.md` (frontend-hosting trust) and isn't something SRI would fix.
- [x] **Clickjacking** — **Found a real gap, not a clean pass.** Framed `index.html` inside an
      attacker-controlled page served over `python -m http.server` (i.e. today's dev setup, with
      no custom response headers). The frame **loaded successfully** — `frame-ancestors 'none'`
      in the `<meta>` CSP tag is silently ignored by browsers when delivered via `<meta>` instead
      of a real HTTP header (this is the same warning visible in every DevTools console session:
      *"The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a
      `<meta>` element."*). **Fix applied this phase:** added `_headers` (repo root), the
      Netlify/Cloudflare Pages header-file convention, carrying the same CSP plus
      `X-Frame-Options: DENY` as real HTTP headers. This closes the gap **once Phase 8 deploys to
      a host that honors `_headers`** (or an equivalent nginx/Apache `add_header` config) — it
      does **not** close it on a bare `python -m http.server` or any static host that ignores
      header files. This is now the load-bearing reason `_headers` exists; the `<meta>` tag alone
      was never sufficient for this specific directive, only for the directives browsers do honor
      via `<meta>` (`script-src`, `object-src`, `base-uri`, `connect-src`).
- [x] **Timing on unlock** — See "Wrong-passphrase behaviour" above; same finding, not a separate
      test.

## Fragment-key share links — added Layer 2, verified 2026-08-04

Same "actually run it" standard as above, against a real Playwright browser and a local Flask
instance of `server/app.py` on port 5050. Full script: `test_share_links.mjs` (scratchpad,
throwaway, same convention as everything else in this file).

- [x] **The relay never sees the key or plaintext** — Created a share for a task with an
      identifying title and notes, then issued a raw `fetch()` (not through the app) to
      `GET /share/<id>`. The response body was exactly `{iv, ciphertext}` — the task title, the
      notes text, and the fragment key itself were all absent from the raw response, confirmed by
      substring search.
- [x] **Fresh-context recipient decrypts via URL alone** — Opened the created link in a brand-new
      Playwright browser context (no cookies, no localStorage, no IndexedDB carried over from the
      sender). The task's title, notes, tag, and subtask all rendered correctly with zero setup —
      no unlock screen, no passphrase prompt.
- [x] **Recipient page persists nothing** — After viewing, `localStorage` and `indexedDB.databases()`
      in the recipient's context were both empty. Closing the tab leaves no trace of the visit.
- [x] **Tamper detection on the fragment key** — Flipped one character of the key in the URL
      fragment. The viewer failed closed with a clear error and never rendered any task content
      (`#shareViewContent` stayed `hidden`) — same AES-GCM auth-tag rejection as ordinary task
      decryption.
- [x] **Unknown/expired share id** — Requested a share id that was never created. Server returned
      404; viewer showed "This link has expired or no longer exists," not a crash or a blank page.
- [x] **Missing fragment key** — Loaded the link with the `#key` portion stripped entirely (as
      would happen if only the query string were copied). Viewer detected the missing key
      client-side and showed a clear error without attempting a request that could 404 confusingly.
- [x] **Server-side entropy/expiry** — `server/tests/test_share.py` covers id uniqueness across
      requests, the 20,000-char size cap per field, and that an artificially time-traveled clock
      (`monkeypatch` on `time.time`) makes a share 404 once past its default 7-day `expiresAt`.

## Capability links (expiry choice, burn-after-reading, revocation) — verified 2026-08-04

- [x] **Burn-after-reading survives a real browser round-trip** — Created a share with
      `maxViews=1` through the actual "Share this task" UI (not just the API directly). Loaded the
      resulting link in one fresh Playwright context — succeeded, task rendered. Loaded the exact
      same link in a second fresh context — failed with a clear "already been viewed" error, never
      served the content twice.
- [x] **Revoke works from the UI, not just the API** — Created a share, confirmed it loads in a
      fresh context, clicked "Revoke link" in the still-open share modal, confirmed the UI shows
      "Revoked" and disables the copy button, then confirmed the same link now 404s for a brand
      new viewer.
- [x] **Custom TTL is honored, not just accepted** — Requested `ttlSeconds: 120`, confirmed the
      share is fetchable at +60s and gone at +121s using a mocked clock (`server/tests/test_share.py`
      — real elapsed-time tests would make the suite slow and flaky, so this uses the same
      `monkeypatch` pattern as the existing expiry test rather than `time.sleep`).
- [x] **Out-of-range values rejected server-side, not just hidden from the UI** — Direct `fetch()`
      to `POST /share` with `ttlSeconds: 999999999` (bypassing the UI's `<select>`, which only ever
      offers valid choices) returns 400. Confirms the client-side dropdown isn't the only thing
      standing between a user and an absurd value — the server re-validates independently.
- [x] **Migration is safe against the already-deployed production schema** — Hand-built a SQLite
      file with the pre-capability-links `shares` table shape (no `max_views`/`views_used`
      columns, matching what's live on Render right now), ran the new `init_db()` against it, and
      confirmed both the migration adds the columns idempotently and a pre-existing row (created
      before this feature existed) is still readable afterward with unlimited-views semantics.

## Tamper-evident signed task history — verified 2026-08-04

Local-only feature (docs/ARCHITECTURE.md §5c) — no server component to test, so all checks below
are against a real Playwright browser and real IndexedDB, not mocks.

- [x] **Real create/update/delete produce a verifiably intact chain** — Created two tasks, edited
      one, deleted the other, through the actual UI (quick-add, edit modal, delete button). "Verify
      history" reported exactly 4 entries, chain intact.
- [x] **Reorder is correctly excluded from the log** — Dragged a task to a new position within a
      column. Confirmed zero new `historyLog` entries were added — a scope decision
      (docs/ARCHITECTURE.md §5c), verified as actually implemented rather than just claimed.
- [x] **Content tampering is detected and correctly attributed** — Directly overwrote one stored
      entry's `payloadHash` via raw IndexedDB access (bypassing the app). "Verify history" flagged
      the exact entry index and attributed it to a signature mismatch specifically, not a generic
      failure.
- [x] **Chain-link tampering is detected and correctly attributed** — Directly deleted a middle
      entry from `historyLog` via raw IndexedDB access. "Verify history" flagged the break at the
      correct position and attributed it to the broken link, distinctly from the signature-mismatch
      case above — confirming the two failure modes are actually distinguished, not just both
      reported as "something's wrong."
- [x] **Key rotation across a passphrase reset preserves old verifiability** — Reset the passphrase
      via recovery code (which cannot recover the old signing key by design, so it rolls a fresh
      one). Confirmed the pre-reset entry still verifies under its original key, a post-reset entry
      verifies under the new key, and both check out together in one "Verify history" run — proving
      `signingKeyLog` actually accumulates rather than overwrites.
- [x] **Pre-existing accounts get a signing key transparently** — Simulated an account created
      before this feature shipped (a keyring with no `wrappedSigningKey`) by unlocking normally;
      confirmed `ensureLocalSigningKeyOnUnlock()` generates and persists one on that unlock without
      any user-visible action required, and history logging works immediately after.

## Social recovery (Shamir secret sharing) — verified 2026-08-04

Caught a real, ship-blocking bug during this pass, not just confirmed things worked — see the
first item below.

- [x] **GF(256) field arithmetic bug found and fixed by the test suite doing its job** — The first
      implementation built its log/exp tables via naive repeated doubling from `1`, which
      implicitly assumes `2` is a primitive root of the field. It isn't: `2`'s multiplicative order
      under reduction polynomial `0x11B` is only 51 (a proper divisor of 255), so the table
      silently cycled after 51 entries instead of covering all 255 nonzero elements, and every
      split/reconstruct round-trip test failed immediately with garbage output. Fixed by using
      generator `3` (`double(x) XOR x`), verified to have the full 255-element cycle by an explicit
      check in the table-building code, not just textbook assertion. This is exactly the failure
      mode "actually run it" exists to catch — the buggy version would have looked identical in a
      code review to someone not independently re-deriving the field's primitive roots.
- [x] **3-of-5 split reconstructs from any qualifying subset** — Split a real recovery code
      through the actual "Set up social recovery" UI (not the crypto functions directly). Used
      three different 3-of-5 subsets of the resulting shares (including one not starting with
      share #1) to reach the reset-passphrase screen each way, then confirmed the new passphrase
      actually unlocks the vault and the original task is still present and readable.
- [x] **Splitting requires the real recovery code, not just any input** — Attempted to split using
      an obviously-wrong recovery code through the UI. Rejected before any shares were generated or
      shown, with a clear error — confirms the split flow re-verifies against
      `wrappedDekRecovery` rather than trusting whatever the user typed.
- [x] **Fewer than k shares never reaches the reset screen** — Added exactly 2 of a required 3
      shares. Confirmed the app stayed on the share-collection screen showing "2 of 3 shares
      added" rather than attempting (and silently failing) reconstruction early.
- [x] **Malformed input is rejected before it can pollute a reconstruction attempt** — A duplicate
      share (already added) and a garbage string (not a valid encoded share at all) are both
      rejected with a clear, specific error and never added to the collected set.

## Verifiable frontend (SRI + integrity manifest) — verified 2026-08-04

The one item below that matters most: this checks the browser actually *enforces* the mechanism,
not merely that the right-looking attribute is present in the HTML.

- [x] **SRI mismatch genuinely blocks the resource** — Made a byte-for-byte copy of the deployed
      app, corrupted `app.html`'s `integrity` attribute for `js/app.js` to a wrong-but-valid-shaped
      hash, served it, and loaded it in a real browser. Console showed Chromium's own enforcement
      message (`Failed to find a valid digest in the 'integrity' attribute... The resource has been
      blocked`), and the app never initialized — `js/app.js` genuinely never ran, confirmed by the
      setup form staying in its un-wired initial state rather than just checking for a console
      error. This is the difference between "the feature looks implemented" and "the feature
      actually stops something."
- [x] **The correct hashes are actually correct** — With the real (uncorrupted) hashes in place,
      `app.html`, `index.html`, and a full setup → add-task flow all ran with zero SRI-related
      console errors and zero failed resource loads — the positive case, run for real alongside the
      negative one above, not assumed from "the negative case worked so the positive case must too."
- [x] **integrity.json has zero drift from actual file content** — Independently recomputed
      SHA-384 for all 10 manifest entries (outside of, and without trusting, the generator script
      itself) and confirmed an exact match — catches the failure mode where a file changes but the
      manifest doesn't get regenerated before commit/deploy.
- [x] **Found and removed real dead code while building this** — `js/reveal.js` was a 4-line Phase
      5 placeholder ("Not implemented yet") never imported by any HTML file; it would have been
      silently included in `integrity.json` as if it were a real served asset. Deleted rather than
      hashed — a manifest with a phantom entry undermines exactly the "these are the real served
      files" claim this feature exists to make.
- [x] **Found a real, transient production issue while deploying this: CDN edge-cache propagation
      lag** — a post-deploy live check (not just "wrangler said success") caught one Cloudflare
      edge PoP briefly serving the newly-deployed `app.html` (new integrity hash) alongside a
      stale-cached `css/style.css` (`cf-cache-status: HIT`, previous version's bytes) — the exact
      mismatch that makes a browser correctly block the stylesheet. Resolved on its own within
      seconds; a follow-up fetch-and-hash-every-file check confirmed full consistency. Documented
      in docs/ARCHITECTURE.md §5d as a real, narrow, CDN-inherent risk with SRI, and as the reason
      "deploy succeeded" and "the live site is actually consistent" are checked separately here,
      not treated as the same thing.

## Server hardening applied this phase

`server/app.py`'s `after_request` hook now sets, on every response (previously only CORS
headers were present):

```
Content-Security-Policy: default-src 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
```

This is a JSON API with no HTML of its own, so `default-src 'none'` is the correct baseline —
defense in depth in case the API is ever hit directly in a browser context (e.g. a user pastes an
API URL into a tab).

## Honest residual gaps (not fixed this phase, stated plainly)

1. **No rate limiting on the sync server.** `/sync/push`, `/sync/pull`, and `/sync/keyring` accept
   unlimited requests per token or IP. Token brute-forcing itself is infeasible (256-bit tokens),
   but nothing stops request-volume abuse (cost/availability impact on whoever hosts the server) —
   out of scope for v1, worth revisiting before any multi-tenant public hosting.
2. **Token/bucket lookups are not constant-time.** `_extract_token` + the SQLite `WHERE token = ?`
   lookup in `storage.py` aren't hardened against timing side-channels. Given the token space
   (256 bits) and that timing differences would be sub-millisecond and drowned out by normal
   network jitter, this isn't considered practically exploitable, but it's not proven safe either
   — noted rather than hidden.
3. **Clickjacking protection is deploy-target-dependent**, per the finding above — it is not a
   property of the code alone.
4. Every honest limitation already listed in `docs/THREAT_MODEL.md`'s "Explicit non-goals" section
   still applies unchanged (PBKDF2 vs Argon2id, metadata visibility, single-user v1, etc.) — this
   document doesn't repeat them, it only adds what Phase 7's self-attack pass specifically found.

## WebAuthn passkey unlock — verified 2026-08-05

Tested against Chromium's CDP virtual authenticator (`WebAuthn.addVirtualAuthenticator` with
`hasLargeBlob: true`, `ctap2Version: "ctap2_1"`) — real WebAuthn ceremonies, ES modules and all,
not mocked API calls. One real design mistake was caught and fixed during this pass, not just
confirmed working — see the second item below.

- [x] **Full unlock works with zero passphrase entry, including the history-signing key path** —
      Registered a passkey through the real "Add a passkey" UI (re-entering the passphrase as the
      flow requires), locked, and unlocked using only the passkey button — no passphrase typed.
      Confirmed the existing task was readable, *and* that adding a new task and running "Verify
      history" afterward showed an intact chain — proving `KEK_hw` correctly unwrapped both
      `wrappedDekHardware` and `wrappedSigningKeyHardware`, not just the DEK half.
- [x] **Found and fixed a real WebAuthn API misuse: `support: "required"` vs `"preferred"`** — The
      first implementation requested `largeBlob.support: "required"` on registration, reasoning
      that the feature is required for this to work at all. Testing against a virtual authenticator
      with `largeBlob` disabled showed the actual behavior: `create()` itself throws, and the
      browser reports it as the exact same generic `NotAllowedError` a cancelled/timed-out ceremony
      produces (deliberate WebAuthn privacy behavior — a site shouldn't be able to fingerprint
      authenticator capabilities from which error it gets). The UI's specific "doesn't support the
      storage this needs" message was unreachable as a result. Fixed by switching to `"preferred"`,
      under which `create()` succeeds regardless and the real answer is read from
      `getClientExtensionResults().largeBlob.supported` — re-tested against the same
      largeBlob-disabled authenticator to confirm the specific message is now actually reachable.
- [x] **Wrong passphrase during registration never reaches the browser's WebAuthn prompt** —
      Entered an incorrect passphrase in "Add a passkey." Rejected with "That's not your current
      passphrase" before `navigator.credentials.create()` is called at all — confirmed by the
      absence of any WebAuthn ceremony (no CDP `WebAuthn.addVirtualAuthenticator` interaction
      logged) and the setup section staying in place rather than advancing.
- [x] **Unsupported authenticator leaves the keyring untouched** — After the `"preferred"` fix
      above, registering against a `largeBlob`-disabled authenticator shows the specific error and
      leaves `webauthnCredentialId`/`wrappedDekHardware` absent from the keyring, confirmed by
      direct IndexedDB inspection, not just by the UI staying on the setup screen.
- [x] **Removing a passkey falls back cleanly** — After registering, then removing via "Remove
      passkey," the lock screen's passkey button disappears and the original passphrase still
      unlocks the vault without any degradation.

## How to re-run this

- Frontend checks: serve the repo root (`python3 -m http.server 8123`), drive it with Playwright
  against `http://127.0.0.1:8123/index.html` using the app's real DOM ids (`#quickAddInput`,
  `#addTaskForm`, `#unlockPassphrase`, etc.) — no test IDs or mocks needed, the checks above all
  used the real UI and the real `js/crypto.js`.
- Backend checks: `cd server && .venv/bin/python -m pytest -q`.
- Framing check specifically needs a *second* origin/page (not just a second tab) attempting to
  `<iframe>` the app — a same-page check doesn't exercise the browser's frame-ancestors enforcement
  path at all.
