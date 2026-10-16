/*
 * Rep Hub offline support (Mel: reps who are often without internet).
 *
 * The app's own data is already kept on the device after each sign-in, and
 * anything logged offline waits in an outbox until the connection is back.
 * This worker adds the last missing piece: opening the app with no signal.
 *   - the page: network first, falling back to the copy saved last time
 *   - fonts and map libraries: saved copy first, refreshed in the background
 *   - the API: never cached here (the app keeps its own data)
 */
const VERSION = 'rephub-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/.netlify/')) return;   // live data only

  // The app itself: always the newest when online, the saved copy when not
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone();
      caches.open(VERSION).then(c => c.put('/index.html', copy));
      return res;
    }).catch(() => caches.match('/index.html')));
    return;
  }

  // Fonts, map libraries and icons: fast from the saved copy, kept fresh
  const cacheable = url.origin === location.origin || /fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(url.host);
  if (!cacheable) return;
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req);
    const fresh = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
