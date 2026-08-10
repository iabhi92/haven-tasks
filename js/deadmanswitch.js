// Standalone viewer for a public dead-man's switch — extends fragment-key share links
// (js/shared.js) and the time-lock puzzle (js/crypto.js, docs/ARCHITECTURE.md "Time-locked
// tasks") into a disclosure anyone can independently verify, not just decrypt.
//
// The key difference from a normal share link: there is no secret key in the URL at all.
// Access here is gated by the puzzle's computational hardness (a real, sequential
// Rivest-Shamir-Wagner time-lock puzzle), not by secrecy of a fragment key — so the link is
// just {server, id}. Anyone holding it can watch the puzzle solve live, in their own browser,
// with their own CPU. That's the actual proof: nobody, including whoever created this,
// shortcut the wait, because there is no shortcut available to hold secretly in the first
// place (the puzzle's factorization is generated and discarded at creation time, same as a
// private time-locked task — see js/crypto.js's createTimeLockPuzzle()).
//
// Nothing here is ever persisted — solving happens in page memory only, same "closes the tab,
// loses the progress" tradeoff a private time-locked task's resumable IndexedDB progress
// deliberately avoids for a page with no vault to store progress in.

import { importDek, decryptTask, unwrapDek, stepTimeLockPuzzle, deriveTimeLockKey, TIME_LOCK_PUZZLE_START } from "./crypto.js?v=20260810b";
import { pullShare } from "./sync.js?v=20260806a";

// Same conservative, once-measured estimate js/ui.js's private time-lock presets use — real
// device speed varies, so the label is deliberately never far slower than reality.
const SQUARINGS_PER_SEC = 150000;
const CHUNK_SIZE = 20000; // same chunking js/app.js's continueSolvingTimeLock() uses, and for
                           // the same reason: never block the tab for more than one chunk.

function showError(message) {
  document.getElementById("dmsLoading").hidden = true;
  document.getElementById("dmsStart").hidden = true;
  const errorEl = document.getElementById("dmsError");
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function formatEta(squarings) {
  const seconds = Math.round(squarings / SQUARINGS_PER_SEC);
  if (seconds < 90) return `about ${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

async function solve(n, squarings, onProgress) {
  let current = TIME_LOCK_PUZZLE_START;
  let solved = 0;
  while (solved < squarings) {
    const stepSize = Math.min(CHUNK_SIZE, squarings - solved);
    current = stepTimeLockPuzzle(n, current, stepSize);
    solved += stepSize;
    onProgress(solved, squarings, current);
    await new Promise((resolve) => setTimeout(resolve, 0)); // yield — same reason as js/app.js's solver
  }
  return current;
}

async function main() {
  const params = new URLSearchParams(location.search);
  const server = params.get("server");
  const id = params.get("id");

  if (!server || !id) {
    showError("This link is incomplete — it's missing the server or id it needs.");
    return;
  }

  let share;
  try {
    share = await pullShare(server, id);
  } catch {
    showError("Couldn't reach the server this link points to. Check your connection and try again.");
    return;
  }

  if (!share) {
    showError("This has expired, was cancelled by whoever created it, or has already been viewed the maximum number of times it allowed.");
    return;
  }

  let bundle;
  try {
    bundle = JSON.parse(share.ciphertext);
    if (!bundle.n || !bundle.squarings || !bundle.wrappedContentKey || !bundle.iv || !bundle.ciphertext) throw new Error("shape");
  } catch {
    showError("This link's data looks corrupted, not a valid dead-man's switch.");
    return;
  }

  document.getElementById("dmsLoading").hidden = true;
  document.getElementById("dmsPuzzleInfo").textContent =
    `This will take ${formatEta(bundle.squarings)} of continuous computation in this tab — ` +
    `real, sequential work, not a countdown timer. There is no way to skip ahead, for you or ` +
    `for whoever created this.`;
  document.getElementById("dmsStart").hidden = false;

  document.getElementById("dmsStartBtn").addEventListener("click", async () => {
    document.getElementById("dmsStart").hidden = true;
    const progressWrap = document.getElementById("dmsProgress");
    const progressFill = document.getElementById("dmsProgressFill");
    const progressLabel = document.getElementById("dmsProgressLabel");
    const liveValue = document.getElementById("dmsLiveValue");
    progressWrap.hidden = false;

    // Not decorative — this is the actual intermediate squaring result each chunk produces,
    // truncated to a readable tail. Real, changing state proving the sequential math is
    // genuinely happening, the same "show real bytes, not a simulated hacker aesthetic"
    // rule the app's own "You vs The Server" reveal follows (docs/ARCHITECTURE.md §6).
    const target = await solve(bundle.n, bundle.squarings, (solved, total, current) => {
      const pct = Math.round((solved / total) * 100);
      progressFill.style.width = `${pct}%`;
      liveValue.textContent = `…${BigInt(current).toString(16).slice(-16)}`;
      progressLabel.textContent = `Solving… ${pct}%`;
    });

    try {
      const timeLockKey = await deriveTimeLockKey(target);
      const rawContentKeyBytes = await unwrapDek(bundle.wrappedContentKey, bundle.contentKeyWrapIv, timeLockKey);
      const contentKey = await importDek(rawContentKeyBytes, false);
      const content = await decryptTask({ iv: bundle.iv, ciphertext: bundle.ciphertext }, contentKey);

      progressWrap.hidden = true;
      const revealed = document.getElementById("dmsRevealed");
      document.getElementById("dmsRevealedTitle").textContent = content.title || "(untitled)";
      document.getElementById("dmsRevealedNotes").textContent = content.notes || "";
      document.getElementById("dmsRevealedWhen").textContent = `Unlocked just now, live, in this browser — ${new Date().toLocaleString()}.`;
      revealed.hidden = false;
    } catch {
      showError("The puzzle solved, but the content couldn't be decrypted — this link may be corrupted.");
    }
  });
}

main();
