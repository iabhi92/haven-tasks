// PWA offline app-shell cache. Haven's *data* has always worked offline
// (IndexedDB, no build step) — the missing piece for an installed app was
// the *static assets* themselves: without this, reloading while offline
// only works if the browser happened to still have those files in its
// normal HTTP cache, which is incidental, not guaranteed. This makes it
// deliberate. See docs/ARCHITECTURE.md "PWA install".
//
// No build step here either — this list is hand-maintained the same way
// the ?v= cache-bust query strings on these same files already are. Bump
// CACHE_NAME (and this list, if a file's ?v= changes) together with those.
const CACHE_NAME = "haven-shell-v3";
const APP_SHELL = [
  "/app.html",
  "/manifest.json",
  "/favicon.ico",
  "/css/style.css?v=20260807a",
  "/js/app.js?v=20260807a",
  "/js/store.js?v=20260807a",
  "/js/ui.js?v=20260807a",
  "/js/crypto.js?v=20260807a",
  "/js/webauthn.js?v=20260807a",
  "/js/sync.js?v=20260807a",
  "/js/automation.js?v=20260807a",
  "/js/insights.js?v=20260807a",
  "/js/ical.js?v=20260807a",
  "/js/csv.js?v=20260807a",
  "/js/templates.js?v=20260807a",
  "/img/favicon-48.png",
  "/img/favicon-192.png",
  "/img/favicon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for exactly the app-shell list above — everything else (sync
// API calls, share links, docs/*.md, the landing page, cross-origin
// requests) passes straight through untouched. Deliberately narrow: this is
// an app-shell cache, not a general-purpose proxy, and must never intercept
// or cache anything carrying ciphertext meant for a specific request only.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname + url.search;
  if (!APP_SHELL.includes(path)) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
