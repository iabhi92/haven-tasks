// Pure module: talks to the sync server over fetch(), never decrypts or inspects
// task content — it only ever moves {id, iv, ciphertext, updatedAt, deleted}
// envelopes, exactly what store.js already persists locally. See
// docs/ARCHITECTURE.md §5.

// 32 random bytes, base64url — a bearer capability, not an identity. Not derived
// from the passphrase; reveals nothing about the user if it leaks on its own.
export function generateSyncToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pushRecords(serverUrl, token, records) {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ records }),
  });
  if (!res.ok) throw new Error(`Sync push failed: ${res.status}`);
  return res.json();
}

export async function pullRecords(serverUrl, token, since) {
  const url = `${serverUrl.replace(/\/$/, "")}/sync/pull?since=${encodeURIComponent(since)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sync pull failed: ${res.status}`);
  const data = await res.json();
  return data.records;
}

// Publishes enough for a second device to obtain the *same* DEK later via the
// recovery code (never the passphrase-derived wrap) — see docs/ARCHITECTURE.md §5.
export async function pushKeyringBootstrap(serverUrl, token, bootstrap) {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/sync/keyring`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(bootstrap),
  });
  if (!res.ok) throw new Error(`Publishing sync keyring failed: ${res.status}`);
  return res.json();
}

// Returns null if no device has published bootstrap material for this token yet.
export async function pullKeyringBootstrap(serverUrl, token) {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/sync/keyring`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetching sync keyring failed: ${res.status}`);
  return res.json();
}

// Deliberately no Authorization header — /share is unauthenticated by design
// (see docs/ARCHITECTURE.md "Fragment-key share links"). The relay only ever
// sees {iv, ciphertext} encrypted under a fresh key that never leaves the
// browser except in the recipient's own URL fragment.
export async function pushShare(serverUrl, iv, ciphertext) {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ iv, ciphertext }),
  });
  if (!res.ok) throw new Error(`Creating share failed: ${res.status}`);
  return res.json();
}

// Returns null if the share is missing or has expired.
export async function pullShare(serverUrl, shareId) {
  const res = await fetch(`${serverUrl.replace(/\/$/, "")}/share/${encodeURIComponent(shareId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetching share failed: ${res.status}`);
  return res.json();
}
