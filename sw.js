/* VaksinaMed PWA — shell cache (API hech qachon keshlanmaydi). */
/* v3: eski v1/v2 keshlarini TO‘LIQ tozalaydi (eski "API key" xarita versiyasi
   qurilmalarda qotib qolgan edi); JS/CSS endi har doim tarmoqdan. */
const CACHE = 'vm-shell-v3';
const PRECACHE = [
  '/offline.html',
  '/logo/apple-touch-icon.png',
  '/logo/icon-192.png',
  '/logo/icon-512.png',
  '/logo/mark.svg?v=3',
  '/site.webmanifest',
  '/canonical-url.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE).catch(() => undefined)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // HAMMA keshni o‘chirish — eski SW/v1 pinning dan qutqarish
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

function isApi(url) {
  return url.pathname.startsWith('/api/');
}

/* Tarmoq birinchi, xato bo‘lsa kesh — yangilanishlar darhol yetib boradi */
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

  // Navigatsiya: tarmoq birinchi, xato bo‘lsa offline / login kesh
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, true));
    return;
  }

  // JS/CSS (v=li ham, v=siz ham) — har doim tarmoq birinchi.
  // Aks holda eski SW keshi yangi versiyani ko‘rsatmay qotib qoladi.
  if (url.pathname.endsWith('.js') || url.pathname.endsWith('.css')) {
    event.respondWith(networkFirst(req, false));
    return;
  }

  // Statik (rasm/logo): kesh → tarmoq
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.ok && (url.pathname.startsWith('/logo/') || url.pathname.endsWith('.png') || url.pathname.endsWith('.webp') || url.pathname.endsWith('.svg'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
        }
        return res;
      });
    })
  );
});
