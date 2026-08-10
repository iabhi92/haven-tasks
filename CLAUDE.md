# Haven — session handoff notes

Read this first. For deep architecture/feature/threat-model detail, see
`docs/ARCHITECTURE.md`, `docs/FEATURES.md`, `docs/THREAT_MODEL.md`,
`docs/SECURITY.md`, and `BUILD_BRIEF.md` — this file is a continuity doc
for picking up work across sessions, not a spec.

Haven is a free, local-first, end-to-end encrypted task manager, live at
**taskhavens.com** (Cloudflare Workers static assets) with an optional sync
backend on Render.com (`server/`, Flask). Repo: `iabhi92/haven-tasks` on
GitHub.

## Standing instructions (apply every session, not just when reminded)

- **Never** put `Co-Authored-By: Claude` in commits.
- Keep committing to GitHub as work ships — this is a running instruction
  from the user, not a one-off.
- **Never** use inline `style="..."` HTML attributes — the CSP blocks it
  and this has been caught and fixed multiple times.
- Verify every feature with a **real** Playwright/pytest run before calling
  it done. Never just read the code and assume it works — this project's
  whole discipline is "verify, don't assume," and several real bugs this
  session were only caught by actually running things (a stale-cache bug,
  a missing `render()` call, a CSP hash mismatch, a null-element crash on
  pages sharing a script).
- Update `docs/FEATURES.md`/`docs/ARCHITECTURE.md`/`docs/THREAT_MODEL.md`
  **in the same commit** as the code, with honest scope-limitation notes —
  never overclaim what shipped.
- **Cache-busting discipline** (a real bug happened from skipping this):
  after editing `css/style.css`, `js/*.js`, or `css/landing.css`/
  `css/article.css`, you must:
  1. Bump the `?v=YYYYMMDDx` query string on every reference to that file,
     across **every** HTML file that loads it, **and** in `sw.js`'s
     `APP_SHELL` list if present there.
  2. Bump `sw.js`'s `CACHE_NAME` (e.g. `haven-shell-v5` → `v6`).
  3. Run `node scripts/generate-integrity.mjs` to regenerate SRI hashes and
     patch the `integrity="..."` attributes automatically.
  Skipping this served returning visitors a stale-cached, broken page for
  real (see git log ~Aug 7 2026, "Fix stale service-worker cache..." and
  "Serve app.html network-first..." commits) — the service worker's
  cache-first strategy on `/app.html` itself was the deeper root cause,
  now fixed, but the `?v=`/`CACHE_NAME` discipline is still required for
  every future asset change regardless.

## Deploy process

Static site → Cloudflare Workers static assets. There's no CI/CD — deploy
is manual, from a hand-built staging directory. **Run
`node scripts/append-transparency-log.mjs` first** (from the real repo
directory, after `generate-integrity.mjs` and after committing — it reads
the current `integrity.json` and `git rev-parse HEAD`), so the transparency
log's entry for this deploy reflects what's actually about to go live, not
a stale prior state:

```bash
STAGE=/private/tmp/haven-deployNN   # bump NN
mkdir -p "$STAGE/public"
cd /Users/abhinavkumar/Desktop/private-tasks
cp .gitignore BUILD_BRIEF.md README.md _headers app.html index.html \
   shared.html compare.html features.html security.html transparency.html \
   robots.txt sitemap.xml integrity.json transparency-log.json \
   manifest.json sw.js favicon.ico "$STAGE/public/"
cp -R css js docs vendor img "$STAGE/public/"
cat > "$STAGE/wrangler.jsonc" <<'EOF'
{
  "name": "haven-tasks",
  "compatibility_date": "2026-08-03",
  "assets": { "directory": "public" },
  "routes": [
    { "pattern": "taskhavens.com", "custom_domain": true },
    { "pattern": "www.taskhavens.com", "custom_domain": true }
  ]
}
EOF
cd "$STAGE" && npx wrangler deploy
```

Always verify live afterward (curl the changed URLs for 200s, run a real
Playwright check against the live site) — don't consider a deploy done
just because `wrangler deploy` exited 0.

**`git push` sometimes fails with `HTTP 400` / "unexpected disconnect"** on
this network for pushes with larger objects (e.g. vendored binaries). Workaround:
```bash
git -c http.postBuffer=524288000 -c http.version=HTTP/1.1 push origin main
```

## Current state (as of 2026-08-07/08, commit `14ca257`)

- **Marketing site** (`index.html`, `compare.html`, `features.html`,
  `security.html`) fully redesigned in a neo-brutalist style per
  user-supplied mockups: hard black borders, offset drop-shadows, a flat
  bright palette (electric lime / digital lavender / cyber yellow), Space
  Grotesk (headings) / Hanken Grotesk (body) / Space Mono (labels), all
  self-hosted under `vendor/fonts/` (CSP blocks Google Fonts CDN). Design
  system lives in `css/landing.css` (tokens + components, shared by all 4
  pages) and `css/article.css` (content-page-specific: tables, callouts,
  terminal-style code panels, chip grids). `features.html`/`security.html`
  are new pages with real content grounded in what's actually shipped, not
  placeholder copy.
- **The app itself** (`app.html`, `css/style.css`) was *also* redesigned in
  the same visual language, extending across a light+dark theme (both
  `prefers-color-scheme` and the manual `data-theme` toggle — token-level,
  see `css/style.css`'s four theme blocks). Task cards went through two
  iterations: first an elaborate "notebook paper" look (punch-hole CSS
  mask, ruled-line texture, alternating rotation), then **removed
  entirely** per direct user feedback ("mobile view bad, remove notebook
  design") — cards are now plain bordered cards matching the rest of the
  system. Don't reintroduce the paper look without asking first.
- **Scroll-triggered animation** (GSAP, `js/landing.js`) now runs on all 4
  marketing pages, not just `index.html` — `landing.js` was refactored to
  be safely shared (guards around the two things that were index.html-only:
  the live encryption demo input, and the custom-cursor element).
- **On-device AI assistant** shipped (`js/ai.js`, `vendor/transformers/`):
  a real small LLM (HuggingFaceTB/SmolLM2-135M-Instruct, int8 ONNX) running
  via transformers.js/onnxruntime-web WASM, entirely client-side, opt-in.
  Two actions: "what should I focus on today" and "break this task into
  subtasks." Required three CSP additions (`blob:`, `'wasm-unsafe-eval'`,
  one `sha256-` hash for an inline import map) — all documented in
  `docs/THREAT_MODEL.md`'s A5 entry and `vendor/transformers/SOURCE.md`.
  **Known unfixed issue: see below.**

## UI refinement pass (2026-08-08): unlock screen + Inbox board

Used Google Stitch (MCP) to explore refinements to the unlock/passphrase
screen and the Inbox board, against a hand-authored design system fed from
the *actual* shipped `css/style.css` tokens (not any of the earlier,
mismatched Stitch explorations already sitting in the `Task Havens
Redesign` Stitch project — those used a soft-cream/gold/glassmorphism
theme from before the neo-brutalist direction was settled; left alone,
not deleted). Shipped changes, all within the existing scheme (indigo
accent, hard offset shadows, Space Grotesk headings, rounded-not-sharp
corners):

- **`.lock-card` border 1px → 2px** — it was the one primary surface in
  the app that didn't carry the same border weight as buttons/task cards
  (2px) or the icon rail (3px). Pure consistency fix.
- **Password show/hide toggle** on all 5 lock-screen password fields
  (setup ×2, unlock, reset ×2) — inline SVG eye icon matching the app's
  existing line-icon style, no external icon font. `initPasswordToggles()`
  in `js/ui.js`, generic over any `.field-password-toggle` button.
- **Live passphrase strength meter + match indicator** on the setup and
  reset-passphrase forms (not unlock or the decoy-vault modal — those
  aren't "choosing a new passphrase," out of scope for this pass).
  Heuristic-based (`computePassphraseStrength()`), explicitly not a real
  entropy estimate. `initPassphraseFeedback()` in `js/ui.js`.
- **Board footer** (`renderBoardFooter()` in `js/ui.js`, `#boardFooter` in
  `app.html`) — fills the dead whitespace that used to trail below the
  board columns once there are only a few tasks, with a "Weekly momentum"
  progress bar (done-this-week ÷ (done-this-week + still-open)) and up to
  3 "Recently completed" chips. Real data, not decorative filler; hidden
  automatically on non-board/list views and when zero tasks exist
  (wired through `setView()`/`hideAllViewPanels()`).

Verified with a real Playwright run (not just read-and-assume): border
width via computed style, strength label changing weak→strong as typed,
match indicator flipping mismatch→match, toggle actually flipping
`input.type`, and the board footer appearing/hiding correctly and showing
correct counts after actually completing a task through the real edit-modal
save flow (not just DOM inspection) — light and dark themes both checked.

Deliberately **not** touched: `passkeySetupPassphrase`,
`decoyVaultPassphrase`/`Confirm`, `syncJoinPassphrase` — those live in
separate settings modals, not "the login page" the user asked about, and
adding the same strength/match treatment there wasn't requested.

Cache-busting done: `css/style.css` → `?v=20260809c`, `js/app.js` /
`js/ui.js` → `?v=20260807b` (bumped everywhere referenced — all 6 HTML
files plus `sw.js`'s `APP_SHELL`), `sw.js`'s `CACHE_NAME` → `haven-shell-v7`,
`integrity.json` and every `integrity="..."` attribute regenerated via
`node scripts/generate-integrity.mjs`.

## Shipped (2026-08-08): AI assistant Web Worker fix

The "AI assistant freezes the page" bug (previously the #1 in-flight item
here) is fixed and shipped. Summary, in case this area is touched again:

- **Root cause:** `js/ai.js` ran `pipeline()` load + generation
  synchronously on the main thread, freezing the tab for ~25s load /
  ~85s+ generation.
- **Fix:** moved both into a new dedicated Web Worker, `js/ai-worker.js`.
  `js/ai.js` is now a thin `postMessage`/`onmessage` RPC wrapper (a
  request-id → pending-promise map, since worker messages need explicit
  correlation).
- **Real blocker hit:** Workers don't inherit the document's
  `<script type="importmap">`. Fixed by patching
  `vendor/transformers/transformers.min.js`'s two bare specifiers
  (`onnxruntime-web/webgpu`, `onnxruntime-common`) to relative paths
  instead (documented in `vendor/transformers/SOURCE.md`) — this fixed
  *both* the worker and the main thread at once, so the import map and its
  CSP `sha256-` hash were removed entirely, from both `app.html` and
  `_headers`. `script-src` is down to just `blob: 'wasm-unsafe-eval'` now
  (both still required, confirmed by testing — not assumed).
- **Gotcha applied correctly:** used
  `new Worker(new URL("./ai-worker.js?v=...", import.meta.url), {type:"module"})`,
  not a bare relative string — `new Worker(url)` resolves relative to the
  *document's* URL, not the calling module's, unlike `import`.
- **Also added:** a free-text "Ask anything" prompt box in the assistant
  panel (`generateFreeTextReply()` in `js/ai.js`) — the user had asked for
  this and it didn't exist before.
- **Verified for real, not assumed:** a Playwright run that clicked
  "Enable," waited through a real ~33s model download, clicked "Ask," and
  — critically — repeatedly clicked the theme toggle *during* the ~20s
  real generation, confirming it flipped instantly every time (10/10
  checks responsive). Zero console errors, zero CSP violations. This
  project still has no checked-in Playwright suite (see §5d in
  `docs/ARCHITECTURE.md`) — this was a one-off verification script, same
  as every other Playwright check in this project's history.
- **Docs updated in the same commit:** `docs/ARCHITECTURE.md` §4h,
  `docs/THREAT_MODEL.md`'s A5 entry, `vendor/transformers/SOURCE.md`.

## Shipped (2026-08-08): copy pass — removed AI-writing tells

The founder flagged the site's copy as "sounds too AI-generated." Rewrote
prose across `index.html`, `features.html`, `security.html`,
`compare.html`, `app.html`, and `shared.html` to fix the actual,
quantified patterns (counted before touching anything, not guessed):
109 em-dashes across the 4 marketing pages plus 41 in `app.html`,
constant "X, not Y" antithesis constructions, rhetorical-question section
headers ("Already using Todoist...?"), "no X, no Y, no Z" prose triads,
"Bold Hook — Elaboration" list formatting, and "That's the..."
summary-button closing sentences.

**Explicit constraint, followed strictly: no fact changed, only phrasing.**
Every claim, number, and feature description reads exactly as true as it
did before — this is a security/privacy product where "never overclaim
what shipped" applies doubly to marketing copy. Verify against `git diff`
before writing more copy here: it should read as sentence-level rephrasing
only, never new claims or dropped caveats.

**What was deliberately left alone:**
- Short badge/pill/CTA microcopy ("No account · Works offline",
  "No account, no credit card, no tour.") — these are UI trust-badges and
  button subtext, not paragraph prose; the triadic "no X, no Y" pattern is
  a completely normal, human convention there. Only paragraph-rhythm
  triads got rewritten.
- The comparison table's `—` "not applicable" cells (`compare.html`) —
  a legitimate UI symbol, not prose.
- Title-tag `Brand — Description` separators (e.g. `<title>Haven — private
  tasks</title>`) — standard, human SEO convention.
- `<h3>What should I focus on today?</h3>` in the AI assistant panel — a
  literal feature label naming exactly what the button does, not a
  rhetorical flourish.
- HTML comments (developer-facing, never seen by a site visitor).

Used Google Stitch (MCP) for a second opinion on the hero copy direction
first — worth knowing if Stitch is used for copy again: it **ignored the
real copy supplied in the prompt** and hallucinated its own placeholder
text ("Total Sovereignty," "Instant Capture") against a stale, mismatched
design system from earlier exploration, despite an explicit
`designSystem` parameter pointing at the correct one. It's useful for
independently confirming a diagnosis (it converged on the same em-dash/
triad findings), but not reliable for verbatim copy work — don't trust its
output text without diffing it against the real source copy.

Verified with Playwright after: all 6 edited pages load with zero console
errors, screenshots confirm the rewritten hero and security-page copy
render correctly. No cache-busting needed — pure text edits to HTML files
that either aren't in `sw.js`'s precache list (the marketing pages) or are
served network-first (`app.html`, per the existing fix — see the sw.js
comment on why).

## Shipped (2026-08-08): Inbox board redesign, take 2

First pass (border-weight fix + board-footer whitespace fill, earlier in
this doc) shipped but the founder still didn't like the board: "too
plain," weak layout/density, flat colors. Explored a genuinely bolder
Stitch direction for a second pass, but Stitch timed out 4 consecutive
times on this specific screen (it had needed only one retry each for the
two earlier successful generations this session) — stopped retrying
blindly per the tool's own guidance and hand-designed it instead, per the
founder's choice when asked.

Changes, all reusing existing tokens (no new colors introduced):
- **Priority/overdue accent stripe**: `js/ui.js`'s `createTaskCard()` now
  sets `data-priority` on the card element and an `.is-overdue` class
  (computed the same way `dueBadgeInfo()` already does, gated on
  `status !== "done"` so a completed task is never "overdue"). CSS in
  `style.css` turns that into a 5px colored left border
  (`--priority-low/medium/high`, `--danger` for overdue, reset to
  `--border` once done) — scannable without reading the small badge text.
- **Column identity**: `.board-col[data-status="in-progress"]` and
  `="done"` get a colored header underline (reusing `--status-progress`/
  `--status-done`, the same colors the header dot already uses) plus a
  faint background wash (`--accent-soft` / a `color-mix()` success tint)
  behind the cards. "To Do" stays neutral as the default state.
- **Task title**: 600→700 weight, 15px→15.5px, for more contrast against
  the metadata badges.

Explicitly avoided: anything decorative (texture, rotation, the
previously-rejected notebook-paper look) — every change here is
functional signal, not decoration, per the direction the founder actually
gave ("bolder" + "real hierarchy," not "cute").

Verified with Playwright: a realistic board (4 tasks, mixed priority, one
overdue, one in each of the 3 columns after moving status) screenshotted
in both light and dark themes, zero console errors. Screenshots shown to
the founder for approval before shipping — approved as "ship."

## Shipped (2026-08-08): Notes, Inbox/lock-screen polish, landing page fixes

- **Notes** (`js/app.js`'s `loadNotes()`/`addNote()`/`updateNote()`/
  `removeNote()`, `js/ui.js`'s `renderNotesList()`, `js/store.js`'s new
  `notes` object store, `DB_VERSION` 4→5): title+body notes, own rail icon
  and `notesView`, add/edit through one shared `noteModal`. Reuses
  `encryptTask`/`decryptTask` as-is, same as automation rules — see
  `docs/ARCHITECTURE.md` §4i. **Honest scope cut, not in this pass:**
  sync push and the fragment-key share-link flow — a note is local-only
  for now, both are natural follow-ups. Voice-to-text was asked for again
  this session and explicitly declined again (same reasoning as before:
  browser speech-to-text sends raw audio to a cloud provider, conflicting
  with the privacy pitch) — don't re-litigate without a fresh explicit ask.
- **Multi-project switcher discoverability fix**: the `#projectSwitcher`
  `<select>` next to "Inbox" already existed and worked (create/switch
  projects, per-project board filtering) but was styled to look like plain
  static heading text — no visible affordance that it was a control. Added
  a custom chevron + hover state (`.project-switcher-wrap` in
  `css/style.css`) so it reads as a dropdown. Don't rebuild this feature if
  asked for "multiple projects" again — it's there, the ask is almost
  certainly about visibility/polish.
- **Lock screen**: unlock-form subtext reworded (warmer, more complete
  sentence); setup form gained a "Read the security model" link to
  `security.html`. Adapted from Stitch explorations in the "Task Havens
  Redesign" project, content/copy only — the accompanying visual mockups
  (dark theme, pill buttons, a fake terminal boot-log with hex addresses on
  the setup screen) were **not** applied: off-brand for this project's
  established neo-brutalist system and explicit prior "functional signal,
  not decoration" direction (see the Inbox-board-redesign session below).
  A separate Stitch "Bold Structural Inbox" screen was also fetched and
  rejected outright — generic multi-user SaaS Kanban (Create Project,
  assignees, comments) that doesn't match Haven's single-vault, no-account
  model at all.
- **Landing page** (`index.html`): `img/hero-screenshot.png` regenerated
  against the current app — the old one still showed the removed
  notebook-paper card style. The `#privacy` section ("Your task list says
  more about you than you think…") hugged the left edge with the whole
  right side empty on wide viewports; its content is now wrapped in
  `.landing-privacy-inner` (`max-width: 860px; margin: 0 auto;`) so the
  block centers in the section — text itself stays left-aligned for
  readability, only the block's position changed.

## Shipped (2026-08-11): WebRTC quick-code relay, native-camera QR fix, 5 features, Merkle proofs

Three separate pieces of work, all shipped and deployed live this session:

- **Fixed a real bug reported from an actual iPhone**: scanning the WebRTC-pairing QR with iOS's
  *native* Camera app (not Haven's own in-page scanner) triggered iOS's phone-number detector on a
  numeric substring inside the raw SDP text, offering a "Call" action sheet instead of anything
  useful. Fix: every QR this feature shows now encodes a real `https://` URL (any native camera
  app's response to a URL is the familiar, unambiguous "Open in Safari"), gzip-compressed first —
  the URL-wrapped SDP was dense enough that a real OpenCV decode test started failing
  intermittently even at generous sizes; compression brought it back to the exact module count
  already proven reliable elsewhere in this project.
- **Added a "quick code" pairing mode** (now the default): a small relay
  (`server/routes.py`'s `/webrtc-relay` endpoints, `server/storage.py`'s `webrtc_rooms` table)
  hands the SDP offer/answer between two devices under one short, single-use, ~40-bit-entropy code
  — pairing is "enter this code once," not a manual two-step QR/paste round trip. The relay only
  ever sees connection metadata (never task content, which still flows peer-to-peer once
  connected); the original fully-offline flow stays available as an explicit toggle for anyone who
  wants zero server involvement. See `docs/ARCHITECTURE.md` §5-3, `docs/THREAT_MODEL.md` A4b-3.
- **Five independently-scoped features**, all real, all verified with live Playwright runs against
  production, not just locally: an app-icon badge (Badging API, due-today/overdue count only, never
  cleared on lock — see `docs/THREAT_MODEL.md` A3a for the disclosed trade-off), Android
  share-target capture into quick-add, a third on-device AI assistant action ("What did I get done
  this week?" — zero new infra, same model/worker), redacted task certificates (sign one task, not
  the whole vault — same disclosure axis as share links: title, not notes), and local-only
  encrypted file/photo attachments (AES-GCM under the vault DEK, 8MB cap, not yet in
  sync/share/export). See `docs/ARCHITECTURE.md` §4h-2, §4l, §4m, §5e-2.
- **Selective Merkle-inclusion proofs**, added to the task-certificate feature above: a real
  SHA-256 Merkle tree (`js/crypto.js`) over the vault's whole tamper-evident history log, with an
  O(log n) inclusion proof that a specific task's entry is genuinely in the log without revealing
  any sibling task's entry. Independently verifiable with **zero Haven install** via the new
  `scripts/verify-task-certificate.mjs` (a single dependency-free Node file) — verified for real
  against a live-downloaded certificate, plus three separate tamper scenarios (edited title,
  corrupted Merkle leaf, forged signature) each independently confirmed rejected.
- **Explicitly did NOT build, on purpose**: four other "hard mode" ideas from the same brainstorm
  (true multi-person shared vaults, real-time collaborative CRDT note editing, forward-secret
  ratcheted sync, searchable-encryption-based push notifications) — these are novel protocol design
  problems, not compositions of already-correct primitives the way everything else in this project
  is, and a subtly-wrong unsupervised implementation of any of them would be a false security claim
  worse than not having the feature. Real technical scoping (the actual approach, precisely why
  each is hard, what it would touch, rough size) written up instead: `docs/HARD_MODE_SCOPING.md`.
  If the user wants one built, read that doc first — it's a starting point, not a stalling tactic.

Real test-methodology bug caught mid-session, worth remembering: simulating "scan a QR with a
native camera, which opens a fresh tab" by calling `page.goto()` on the *same* Playwright page to a
URL differing only by hash is a **same-document navigation in Chromium — no reload, no fresh
`boot()`** — a weaker test using that approach would have silently passed without ever exercising
the real path. Fix: a genuinely fresh `context.newPage()` (same browser context/storage, fresh JS
execution) is what actually mirrors a native app handing a link to the browser.

## In-flight / unfinished work — pick up here

### 1. Drag-and-drop bug report, unreproduced

User reported dragging a task from To Do to In Progress "works for the
first task only." Scripted Playwright repro (real mouse down/move/up, not
synthetic events) dragging a *non-first* card while siblings still sit
above it in the source column — twice, different scenarios — and both
moved the correct task cleanly. Whatever's wrong wasn't caught this way.
Next step: get the user's actual browser/device (the current impl is HTML5
drag-and-drop, which doesn't work on touch/mobile at all — worth ruling
out first) and exact repro steps before touching `wireDragAndDrop()` in
`js/app.js` or `getDragAfterElement()` in `js/ui.js`.

## Notable gotchas discovered this session (don't rediscover the hard way)

- **Cloudflare Workers static-assets `_redirects`** does not support
  cross-hostname redirects (www→apex) — relative paths only. A www→apex
  redirect needs a Cloudflare dashboard Redirect Rule (manual, outside
  what's automatable from here).
- **macOS port 5000** is squatted by AirPlay Receiver — use a different
  port (e.g. 5050, 8090+) for local test servers.
- **`~/.zshrc` on this machine is owned by `root`**, not the logged-in
  user — `echo ... >> ~/.zshrc` fails with permission denied even though
  the file is world-readable. Don't `sudo chown` it without the user
  explicitly asking; call binaries by their full path instead (e.g.
  `~/.local/bin/claude ...`) as the no-sudo workaround.
- **GitHub secret-scanning push protection can false-positive** on
  vendored third-party libraries — a GitHub Gist ID embedded in
  `transformers.min.js` was flagged as a "Mistral AI API Key." Verify
  false positives for real (check the actual flagged string/context)
  before asking the user to click the unblock-secret link.
- **CSP `sha256-` hashes for inline `<script>` tags**: compute by testing
  in a real browser and reading the *actual* hash the browser reports in
  its console CSP-violation error — don't hand-compute in Python/Node from
  the source text. Byte-level formatting mismatches (trailing newlines,
  etc.) silently produce a wrong hash that looks plausible but doesn't
  match.
- **Service worker updates can't fix themselves retroactively**: a client
  whose SW is already active keeps running *that* SW's old fetch-handler
  logic for at least one more load after a fix ships, before the new SW
  takes over. This is inherent to how SW updates propagate, not a bug in
  the fix — don't be surprised if a service-worker-related bug fix doesn't
  look instant when checking the live site right after deploying it.

## MCP servers

- `stitch` (Google Stitch, HTTP transport, `X-Goog-Api-Key` header) was
  added to the **local** Claude Code project config
  (`/Users/abhinavkumar/.claude.json`, project-scoped) via
  `claude mcp add` on 2026-08-07. The standalone CLI had to be installed
  separately from the VS Code extension
  (`curl -fsSL https://claude.ai/install.sh | bash`, lands at
  `~/.local/bin/claude`) since the extension doesn't expose the `claude`
  binary on `PATH`.
