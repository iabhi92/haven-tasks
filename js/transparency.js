// Fetches transparency-log.json and re-verifies its hash chain entirely client-side, in this
// browser, rather than just displaying numbers and asking you to trust them -- same "provable,
// not just claimed" standard as the rest of this site (see docs/ARCHITECTURE.md "Verifiable
// frontend"). The chain-building logic here is intentionally identical to
// scripts/verify-transparency-log.mjs's Node version -- two independent implementations of the
// same check, not one script trusting the other.

async function sha384(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-384", bytes);
  return "sha384-" + btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function shortHash(h) {
  return h ? h.slice(0, 18) + "…" : "(none)";
}

async function verifyChain(entries) {
  let prevHash = null;
  const results = [];
  for (const entry of entries) {
    const { entryHash, ...rest } = entry;
    const recomputed = await sha384(JSON.stringify(rest));
    const hashOk = recomputed === entryHash;
    const linkOk = rest.prevEntryHash === prevHash;
    results.push({ entry, ok: hashOk && linkOk, hashOk, linkOk });
    prevHash = entryHash;
  }
  return results;
}

function renderRow(result) {
  const { entry, ok } = result;
  const commitUrl = `https://github.com/iabhi92/haven-tasks/commit/${entry.gitCommit}`;
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>${entry.sequence}</td>
    <td>${new Date(entry.timestamp).toLocaleString()}</td>
    <td><a href="${commitUrl}" target="_blank" rel="noopener">${entry.gitCommit.slice(0, 12)}</a></td>
    <td><code>${shortHash(entry.manifestHash)}</code></td>
    <td>${ok ? "✓ verified" : "✗ BROKEN"}</td>
  `;
  if (!ok) tr.style.color = "var(--danger, #dc4c4c)";
  return tr;
}

async function init() {
  const summary = document.getElementById("transparencySummary");
  const tbody = document.getElementById("transparencyTableBody");
  try {
    const res = await fetch("/transparency-log.json");
    if (!res.ok) throw new Error("bad response");
    const { entries } = await res.json();
    if (!entries || entries.length === 0) {
      summary.textContent = "No entries yet.";
      return;
    }
    const results = await verifyChain(entries);
    const allOk = results.every((r) => r.ok);
    const firstBreak = results.find((r) => !r.ok);
    summary.textContent = allOk
      ? `✓ All ${entries.length} entr${entries.length === 1 ? "y" : "ies"} verified in this browser, right now — the chain is intact.`
      : `✗ Chain verification failed at entry #${firstBreak.entry.sequence} — this log is not trustworthy as published.`;
    summary.style.color = allOk ? "var(--lp-mint-deep, #96ba00)" : "var(--danger, #dc4c4c)";
    for (const result of results.reverse()) tbody.appendChild(renderRow(result));
  } catch (err) {
    summary.textContent = "Couldn't load or verify the transparency log right now. Try again shortly.";
  }
}

init();
