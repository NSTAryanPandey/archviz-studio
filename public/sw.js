// Service worker: makes ArchViz installable and fast to reopen like a native app.
// - Own files (the game page, icons): network first, cached copy if offline
// - Big CDN assets (three.js, 3D models, textures, fonts): cache first → instant second launch
// - Live multiplayer traffic (/socket.io, /api) is never cached
const CACHE = 'archviz-v1';
const SHELL = ['./', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.pathname.startsWith('/socket.io') || url.pathname.startsWith('/api')) return;
  const save = (res) => { if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; };
  if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(save).catch(() => caches.match(req).then((hit) => hit || caches.match('./'))));
  } else if (/jsdelivr\.net|polyhaven\.(org|com)|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.host)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then(save)));
  }
});
