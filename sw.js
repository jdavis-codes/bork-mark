// Lets the app open with no signal. App files: network first, cached copy as
// fallback. Versioned CDN libraries never change, so those are cache first.
const CACHE = 'borkmark-v2';
const SHELL = [
  './', 'app.js', 'js/add-book.js', 'js/audio/container.js',
  'js/audio/listen.js', 'js/book-files.js', 'js/chapter-names.js', 'js/cite.js',
  'js/figures.js', 'js/info.js', 'js/intro.js', 'js/library.js',
  'js/log.js', 'js/marks.js', 'js/player.js', 'js/queue.js',
  'js/quotes.js', 'js/screens.js', 'js/settings-sheet.js', 'js/sleep.js',
  'js/sounds.js', 'js/sources/epub.js', 'js/sources/index.js', 'js/sources/pdf.js',
  'js/sources/plain-text.js', 'js/speech-worker.js', 'js/speech.js', 'js/state.js',
  'js/storage.js', 'js/store-worker.js', 'js/text/book.js', 'js/text/cleanup.js',
  'js/text/quote.js', 'js/theme.js', 'js/trim.js', 'js/ui/dom.js',
  'js/ui/marquee.js', 'js/ui/sheets.js', 'js/updates.js', 'js/version.js',
  'js/viewer.js', 'manifest.webmanifest',
];

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
      // CDN downloads are large and sometimes drop on a phone: one more go.
      const res = cdn ? await fetch(req).catch(() => fetch(req.url, { mode: 'cors', credentials: 'omit' }))
        : await fetch(url.href, { cache: 'no-cache' });
      // A full disk must not turn a good download into a failed one.
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
