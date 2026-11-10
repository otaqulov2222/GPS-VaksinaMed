/* VaksinaMed PWA — shell cache (API hech qachon keshlanmaydi). */
/* v6: activate faqat ESKI keshni o‘chiradi (joriy precache saqlanadi).
   JS/CSS — network-first. */
const CACHE = 'vm-shell-v6';
const PRECACHE = [
  '/offline.html',
  '/logo/apple-touch-icon.png?v=5',
  '/logo/icon-192.png?v=5',
  '/logo/icon-512.png?v=5',
  '/logo/favicon-32.png?v=5',
  '/logo/favicon-pin.svg?v=5',
  '/favicon.ico?v=5',
  '/site.webmanifest?v=5',
  '/canonical-url.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => undefined)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Faqat eski nomlarni o‘chirish — yangi precache ni o‘chirmaslik
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

function networkFirst(req, navFallback) {
  return fetch(req)
    .then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
      }
      return res;
    })
    .catch(async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (navFallback) {
        const off = (await caches.match('/offline.html')) || (await caches.match('/login'));
        if (off) return off;
      }
      return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (isApi(url)) return;

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, true));
    return;
  }

  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(networkFirst(req, false));
    return;
  }

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && (url.pathname.startsWith('/logo/') || url.pathname.endsWith('.png') || url.pathname.endsWith('.webp') || url.pathname.endsWith('.svg') || url.pathname.endsWith('.ico'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      });
    })
  );
});
