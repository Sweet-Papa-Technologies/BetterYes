/**
 * FOREMAN service worker — makes the dashboard installable and keeps the app shell available.
 * Cache-first for same-origin static assets; always network for /api and /ws (live data).
 * Web Push handlers are added in M4.
 */
const CACHE = 'foreman-shell-v1';
const SHELL = ['./', './index.html', './manifest.json'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  // Never cache the API or websocket upgrades — always go to the network.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;
  // Same-origin static assets: cache-first, fall back to network and cache it.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request)
            .then((res) => {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(event.request, copy));
              return res;
            })
            .catch(() => caches.match('./index.html')),
      ),
    );
  }
});
