/**
 * FOREMAN service worker — makes the dashboard installable, keeps the app shell available,
 * and delivers Web Push notifications (M4).
 * Cache-first for same-origin static assets; always network for /api and /ws (live data).
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

// ── Web Push (M4): escalation / completion notifications ─────────────────────
self.addEventListener('push', (event) => {
  let data = { title: 'FOREMAN', body: '', url: '/' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* plain-text or empty payload */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: 'icons/pwa-192x192.png',
      badge: 'icons/pwa-192x192.png',
      data: { url: data.url ?? '/' },
      vibrate: [80, 40, 80],
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ('focus' in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
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
