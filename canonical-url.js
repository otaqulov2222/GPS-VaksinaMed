/** Toza URL + PWA (home screen) meta / service worker. */
(function () {
  // ── PWA head (sync — «Uyg‘onga qo‘shish» dan oldin DOM da bo‘lsin) ──
  try {
    var head = document.head || document.getElementsByTagName('head')[0];
    if (head && !document.getElementById('vm-pwa-meta')) {
      var box = document.createElement('div');
      box.id = 'vm-pwa-meta';
      box.style.display = 'none';
      // meta/link larni to‘g‘ridan head ga
      function addMeta(name, content) {
        if (document.querySelector('meta[name="' + name + '"]')) return;
        var m = document.createElement('meta');
        m.setAttribute('name', name);
        m.setAttribute('content', content);
        head.appendChild(m);
      }
      function addLink(rel, href, sizes, typ) {
        var sel = 'link[rel="' + rel + '"]' + (href ? '[href="' + href + '"]' : '');
        if (document.querySelector(sel)) return;
        var l = document.createElement('link');
        l.setAttribute('rel', rel);
        l.setAttribute('href', href);
        if (sizes) l.setAttribute('sizes', sizes);
        if (typ) l.setAttribute('type', typ);
        head.appendChild(l);
      }
      addMeta('theme-color', '#0b1f3a');
      addMeta('apple-mobile-web-app-capable', 'yes');
      addMeta('mobile-web-app-capable', 'yes');
      addMeta('apple-mobile-web-app-status-bar-style', 'black-translucent');
      addMeta('apple-mobile-web-app-title', 'VaksinaGPS');
      addMeta('application-name', 'VaksinaGPS');
      addLink('manifest', '/site.webmanifest');
      addLink('apple-touch-icon', '/logo/apple-touch-icon.png', '180x180');
      addLink('icon', '/logo/icon-192.png', '192x192', 'image/png');
      addLink('icon', '/logo/favicon-32.png', '32x32', 'image/png');
      void box;
    }
  } catch (e) { /* ignore */ }

  // ── .html → toza path ──
  var path = (location.pathname || '').replace(/\\/g, '/');
  var m = path.match(/^\/([^/?#]+)\.html$/i);
  if (m) {
    var map = {
      index: '/',
      live: '/live',
      fuel: '/fuel',
      attendance: '/attendance',
      admin: '/admin',
      driver: '/driver',
      profile: '/profile',
      login: '/login',
      offline: '/offline.html',
    };
    var dest = map[m[1].toLowerCase()];
    if (dest != null) {
      location.replace(dest + location.search + location.hash);
      return;
    }
  }

  // ── Service worker (faqat https yoki localhost) ──
  try {
    var okProto = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (okProto && 'serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { /* ignore */ });
      });
    }
  } catch (e2) { /* ignore */ }
})();
