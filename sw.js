// Lets the app open with no signal. App files: network first, cached copy as
// fallback. Versioned CDN libraries never change, so those are cache first.
const CACHE = 'borkmark-v1';
const SHELL = ['./', 'app.js', 'align.js', 'align-worker.js', 'store-worker.js', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const cdn = url.hostname === 'cdn.jsdelivr.net';
  if (url.origin !== self.location.origin && !cdn) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (cdn) {
      const hit = await cache.match(req);
      if (hit) return hit;
    }
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
