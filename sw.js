// Lets the app open with no signal. App files: network first, cached copy as
// fallback. Versioned CDN libraries never change, so those are cache first.
const CACHE = 'borkmark-v2';
const SHELL = ['./', 'app.js', 'align.js', 'cite.js', 'align-worker.js', 'store-worker.js', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('borkmark-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()),
));

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
      // "no-cache" makes the browser check with the server instead of reusing
      // a copy up to ten minutes old, which let a new page run an old script.
      const res = cdn ? await fetch(req) : await fetch(url.href, { cache: 'no-cache' });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
