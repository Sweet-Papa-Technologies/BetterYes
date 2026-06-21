/**
 * FOREMAN service worker — makes the dashboard installable, keeps the app shell available,
 * and delivers Web Push notifications (M4).
 * Cache-first for same-origin static assets; always network for /api and /ws (live data).
 */
const CACHE = 'foreman-shell-v2';
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
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Never touch the API or websocket upgrades — always live.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws')) return;

  // NETWORK-FIRST. This is a localhost tool — the network (the daemon) is always there, so a
  // fresh build is picked up immediately and we never serve a stale app shell or a stale
  // code-split route chunk. The cache is only an offline fallback.
  //
  // Critically: a failed JS/CSS request is NEVER replaced with index.html. Returning HTML for
  // a script request is what silently breaks Vue Router's lazy route chunks ("routes stop
  // working after a rebuild") — index.html is only an acceptable fallback for a navigation.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches
          .match(req)
          .then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error())),
      ),
  );
});
