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
is manual, from a hand-built staging directory:

```bash
STAGE=/private/tmp/haven-deployNN   # bump NN
mkdir -p "$STAGE/public"
cd /Users/abhinavkumar/Desktop/private-tasks
cp .gitignore BUILD_BRIEF.md README.md _headers app.html index.html \
   shared.html compare.html features.html security.html robots.txt \
   sitemap.xml integrity.json manifest.json sw.js favicon.ico "$STAGE/public/"
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

## In-flight / unfinished work — pick up here

### 1. Notes page (not started)

User wants a Notes page: title + body notes, same E2EE encryption/storage
pattern as tasks (reuse `encryptTask`/`decryptTask` primitives, don't
invent a parallel scheme), shareable via the existing fragment-key
share-link mechanism (`shared.html`/`js/shared.js`, `POST /share`).

**Explicit decision already made, don't re-litigate:** typed input only,
**no voice-to-text** — offered to the user and they chose to skip it
entirely, since browser speech-to-text APIs typically send raw audio to a
cloud provider (e.g. Google in Chrome), which conflicts with the "we can't
read what you write" pitch.

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
