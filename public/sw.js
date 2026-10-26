// Sidewalk's service worker: home-screen install, phone notifications, and working offline.
// Pages and files are network-first: when you're online you always get the newest version,
// and the last copy is kept so the app still opens with no signal. Reports made offline are
// saved by the page itself and sent when the connection comes back.
const CACHE = 'sidewalk-shell-v1';
const SHELL = [
  '/', '/style.css', '/app.js', '/responsibility.js', '/manifest.webmanifest', '/icon-192.png',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css', '/vendor/leaflet-heat/leaflet-heat.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Only same-origin GETs for the app itself and the report list are kept. Account, staff, and
// AI requests always go to the network.
const cacheable = (url) => url.origin === self.location.origin && (
  SHELL.includes(url.pathname) || url.pathname.startsWith('/vendor/') || url.pathname === '/api/issues' || /^\/[\w-]+\.(png|svg|webmanifest)$/.test(url.pathname)
);

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const isPage = request.mode === 'navigate' && url.origin === self.location.origin && url.pathname === '/';
  if (!isPage && !cacheable(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(request);
      if (response.ok) cache.put(isPage ? '/' : request, response.clone());
      return response;
    } catch (error) {
      const cached = await cache.match(isPage ? '/' : request, { ignoreSearch: url.pathname !== '/api/issues' });
      if (cached) return cached;
      throw error;
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Sidewalk', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = open.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) { await existing.focus(); return existing.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
