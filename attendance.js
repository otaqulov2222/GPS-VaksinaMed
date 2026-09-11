'use strict';
/**
 * VaksinaMed Davomat — Face modal → Keldim/Ketdim + timer + tarix
 */
(function () {
  const app = document.getElementById('att-app');
  if (!app) return;

  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model';
  const FACE_API_SRC = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/dist/face-api.js';

  const MESH_EDGES = [
    [0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,12],[12,13],[13,14],[14,15],[15,16],
    [17,18],[18,19],[19,20],[20,21],[22,23],[23,24],[24,25],[25,26],
    [27,28],[28,29],[29,30],[30,33],[31,32],[32,33],[33,34],[34,35],
    [36,37],[37,38],[38,39],[39,40],[40,41],[41,36],
    [42,43],[43,44],[44,45],[45,46],[46,47],[47,42],
    [48,49],[49,50],[50,51],[51,52],[52,53],[53,54],[54,55],[55,56],[56,57],[57,58],[58,59],[59,48],
    [60,61],[61,62],[62,63],[63,64],[64,65],[65,66],[66,67],[67,60],
    [21,22],[27,21],[27,22],[31,48],[35,54],[0,17],[16,26],[8,57]
  ];

  let STATE = null;
  let busy = false;
  let stream = null;
  let modelsReady = false;
  let modelsLoading = null;
  let scanLoop = null;
  let modalOpen = false;
  let abortScan = null;
  let pendingScan = null; // { descriptor, photo, gps }
  let timerId = null;
  let uiTab = 'bugun';
  let boardDate = '';
  let reportMonth = '';
  let personId = '';
  let personMonth = '';
  let REPORT = null;
  let PERSON = null;
  let geoWatchId = null;
  let clockId = null;
  let attMap = null;
  let attMapCircle = null;
  let attMapUser = null;
  let attMapOffice = null;
  let attMapAcc = null;
  let attMapFitted = false;
  let geoLive = { inside: null, dist: null, accuracy: null, lat: null, lng: null, err: null, status: 'idle' };
  let attMethod = 'face';

  const modal = document.getElementById('fid-modal');
  const video = document.getElementById('att-cam');
  const overlay = document.getElementById('att-overlay');
  const snapCanvas = document.getElementById('att-canvas');
  const fidActions = document.getElementById('fid-actions');
  const btnKeldim = document.getElementById('fid-keldim');
  const btnKetdim = document.getElementById('fid-ketdim');
  const fidRetryWrap = document.getElementById('fid-retry-wrap');
  const btnRetry = document.getElementById('fid-retry');
  const btnCancel = document.getElementById('fid-cancel');
  let pendingKind = null; // 'in' | 'out' | null
  let flowRetry = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function msg(text, kind) {
    const el = document.getElementById('att-msg');
    if (!el) return;
    el.className = 'att-msg on ' + (kind || 'info');
    el.textContent = text;
  }

  function clearMsg() {
    const el = document.getElementById('att-msg');
    if (el) el.className = 'att-msg';
  }

  function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR;
    const dLng = (lng2 - lng1) * toR;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function officeInfo() {
    const o = (STATE && STATE.settings && STATE.settings.office) || {};
    return {
      lat: Number(o.lat) || 41.219119,
      lng: Number(o.lng) || 69.272688,
      radius: Math.max(50, Number(o.radius_m) || 100),
      label: o.label || 'VaksinaMed ofis'
    };
  }

  function userDisplayName() {
    const u = (STATE && STATE.user) || window.VM_USER || {};
    return u.name || u.username || 'Xodim';
  }

  function userRoleLabel() {
    const u = (STATE && STATE.user) || window.VM_USER || {};
    const r = u.role || '';
    if (r === 'admin_pro') return 'Admin Pro';
    if (r === 'admin') return 'Admin';
    if (r === 'driver') return 'Haydovchi';
    return r || 'Xodim';
  }

  function fmtClock(d) {
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function fmtDateLong(iso) {
    try {
      const d = iso ? new Date(iso + 'T12:00:00') : new Date();
      return d.toLocaleDateString('uz-UZ', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    } catch (e) {
      return iso || '';
    }
  }

  function stopClock() {
    if (clockId) { clearInterval(clockId); clockId = null; }
  }

  function startClock() {
    stopClock();
    const tick = () => {
      const el = document.getElementById('av-now-clock');
      if (el) el.textContent = fmtClock(new Date());
      const work = document.getElementById('att-live-timer');
      if (work && STATE && STATE.today && STATE.today.in && !STATE.today.out) {
        work.textContent = fmtDur(dayWorkedSec(STATE.today) || 0);
      }
    };
    tick();
    clockId = setInterval(tick, 1000);
  }

  function stopGeoWatch() {
    if (geoWatchId != null && navigator.geolocation) {
      try { navigator.geolocation.clearWatch(geoWatchId); } catch (e) {}
    }
    geoWatchId = null;
  }

  function applyGeoFix(lat, lng, accuracy) {
    const off = officeInfo();
    const dist = haversineM(lat, lng, off.lat, off.lng);
    const inside = dist <= off.radius;
    geoLive = {
      inside, dist, accuracy: accuracy || null, lat, lng, err: null,
      status: inside ? 'ok' : 'out'
    };
    paintGeoUI();
    updateAttMap(lat, lng);
    paintMapOverlay();
  }

  function applyGeoError(err) {
    geoLive = {
      inside: false, dist: null, accuracy: null, lat: null, lng: null,
      err: err && err.message ? err.message : 'Joylashuv olinmadi',
      status: 'err'
    };
    paintGeoUI();
    styleZoneCircle(null);
    paintMapOverlay();
  }

  function paintGeoUI() {
    const badge = document.getElementById('av-geo-badge');
    const distEl = document.getElementById('av-geo-dist');
    const gate = document.getElementById('av-gate-banner');
    const off = officeInfo();
    const inBtn = document.getElementById('btn-keldim-main');
    const outBtn = document.getElementById('btn-ketdim-main');
    const goBtn = document.getElementById('av-continue');
    const today = (STATE && STATE.today) || {};
    const enrolled = !!(STATE && STATE.enrolled);
    const done = !!(today.in && today.out);
    const canIn = enrolled && !today.in && !done;
    const canOut = enrolled && !!today.in && !today.out;
    const inside = geoLive.inside === true;

    if (badge) {
      badge.className = 'av-geo-badge ' + (geoLive.status === 'ok' ? 'ok' : (geoLive.status === 'out' || geoLive.status === 'err' ? 'bad' : 'load'));
      if (geoLive.status === 'ok') badge.textContent = '✓ Siz ofis hududidasiz';
      else if (geoLive.status === 'out') badge.textContent = '✗ Ofisdan tashqarida';
      else if (geoLive.status === 'err') badge.textContent = 'GPS yoʻq';
      else badge.textContent = 'Joylashuv…';
    }
    if (distEl) {
      if (geoLive.dist != null) {
        distEl.innerHTML = 'Siz ofis markazidan <b>' + Math.round(geoLive.dist) + ' m</b> · Radius <b>' + off.radius + ' m</b>';
      } else {
        distEl.innerHTML = 'Ofis: <b>' + esc(off.label) + '</b> · Radius <b>' + off.radius + ' m</b>';
      }
    }
    if (gate) {
      if (geoLive.status === 'ok') {
        gate.className = 'av-gate-banner on ok';
        gate.textContent = 'Ofis ichidasiz — Face ID orqali Keldi / Ketdi ochiq.';
      } else if (geoLive.status === 'out') {
        gate.className = 'av-gate-banner on';
        gate.textContent = 'Davomat faqat ofis radiusida ishlaydi. Hozir ~' + Math.round(geoLive.dist || 0) + ' m uzoqdasiz.';
      } else if (geoLive.status === 'err') {
        gate.className = 'av-gate-banner on';
        gate.textContent = geoLive.err || 'Joylashuvni yoqing — ofisga kirganingizda tugmalar ochiladi.';
      } else {
        gate.className = 'av-gate-banner on';
        gate.textContent = 'Joylashuv tekshirilmoqda… Ofisga kelganda tugmalar ochiladi.';
      }
    }

    const lockPunch = (btn, allow) => {
      if (!btn) return;
      const shouldEnable = allow && inside;
      btn.disabled = !shouldEnable;
      btn.classList.toggle('is-locked', !inside && allow);
    };
    lockPunch(inBtn, canIn);
    lockPunch(outBtn, canOut);

    if (goBtn) {
      const nextKind = !today.in ? 'in' : (today.in && !today.out ? 'out' : null);
      goBtn.disabled = !enrolled || done || !inside || !nextKind || attMethod !== 'face';
      const lab = goBtn.querySelector('span');
      const sub = goBtn.querySelector('small');
      if (lab) {
        if (!enrolled) lab.textContent = 'Avval Face ID ulang';
        else if (done) lab.textContent = 'Bugun yakunlangan';
        else if (!inside) lab.textContent = 'Ofisga keling';
        else lab.textContent = nextKind === 'out' ? 'Face ID → Ketdi' : 'Face ID → Keldi';
      }
      if (sub) {
        sub.textContent = inside
          ? (nextKind === 'out' ? 'Ketishni yuz bilan tasdiqlash' : 'Kelishni yuz bilan tasdiqlash')
          : (off.label + ' · ' + off.radius + ' m');
      }
      goBtn.setAttribute('data-next', nextKind || '');
    }
  }

  function destroyAttMap() {
    if (attMap) {
      try { attMap.remove(); } catch (e) {}
    }
    attMap = null;
    attMapCircle = null;
    attMapUser = null;
    attMapOffice = null;
    attMapAcc = null;
    attMapFitted = false;
  }

  function pinIcon(label, kind) {
    let cls = 'av-pin av-pin-office';
    if (kind === 'you') cls = 'av-pin av-pin-you';
    if (kind === 'you-out') cls = 'av-pin av-pin-you av-pin-out';
    const safe = String(label || '').replace(/</g, '&lt;');
    return L.divIcon({
      className: 'av-pin-wrap',
      html: '<div class="' + cls + '" title="' + safe + '"><i></i></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9]
    });
  }

  function styleZoneCircle(inside) {
    if (!attMapCircle) return;
    if (inside === true) {
      attMapCircle.setStyle({
        color: '#16a34a',
        fillColor: '#22c55e',
        fillOpacity: 0.22,
        weight: 3,
        dashArray: null
      });
    } else if (inside === false) {
      attMapCircle.setStyle({
        color: '#dc2626',
        fillColor: '#f87171',
        fillOpacity: 0.14,
        weight: 3,
        dashArray: '6 6'
      });
    } else {
      attMapCircle.setStyle({
        color: '#1a5fb4',
        fillColor: '#3b82f6',
        fillOpacity: 0.14,
        weight: 2,
        dashArray: null
      });
    }
  }

  function paintMapOverlay() {
    /* Holat faqat header badge da — xarita ustida takrorlamaymiz */
  }

  function initAttMap() {
    destroyAttMap();
    const el = document.getElementById('av-map');
    if (!el || !window.L) return;
    const off = officeInfo();
    attMap = L.map(el, { zoomControl: true, attributionControl: false }).setView([off.lat, off.lng], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(attMap);
    attMapCircle = L.circle([off.lat, off.lng], {
      radius: off.radius,
      color: '#1a5fb4',
      fillColor: '#3b82f6',
      fillOpacity: 0.16,
      weight: 3
    }).addTo(attMap);
    attMapOffice = L.marker([off.lat, off.lng], {
      icon: pinIcon('Ofis', 'office'),
      zIndexOffset: 200
    }).addTo(attMap).bindPopup('<b>' + off.label + '</b><br>Radius: ' + off.radius + ' m');
    // Popup emas — title tooltip yetarli; marker faqat bitta nuqta
    styleZoneCircle(geoLive.inside);
    setTimeout(() => {
      try { attMap.invalidateSize(); } catch (e) {}
      attachLocateControl();
    }, 80);
    // Radius toʻliq kórinsin
    try {
      attMap.fitBounds(attMapCircle.getBounds().pad(0.12));
    } catch (e) {}
    if (geoLive.lat != null) updateAttMap(geoLive.lat, geoLive.lng);
    paintMapOverlay();
  }

  function updateAttMap(lat, lng) {
    if (!attMap || !window.L) return;
    const inside = geoLive.inside === true;
    const color = inside ? '#16a34a' : '#dc2626';
    const youKind = inside ? 'you' : 'you-out';
    const youLabel = inside ? 'Siz · ichida' : 'Siz · tashqarida';
    styleZoneCircle(geoLive.inside);

    if (!attMapUser) {
      attMapUser = L.marker([lat, lng], {
        icon: pinIcon(youLabel, youKind),
        zIndexOffset: 400
      }).addTo(attMap);
    } else {
      attMapUser.setLatLng([lat, lng]);
      attMapUser.setIcon(pinIcon(youLabel, youKind));
    }

    const acc = Math.max(12, Math.min(80, Number(geoLive.accuracy) || 25));
    if (!attMapAcc) {
      attMapAcc = L.circle([lat, lng], {
        radius: acc,
        color: color,
        fillColor: color,
        fillOpacity: 0.08,
        weight: 1
      }).addTo(attMap);
    } else {
      attMapAcc.setLatLng([lat, lng]);
      attMapAcc.setRadius(acc);
      attMapAcc.setStyle({ color: color, fillColor: color });
    }

    try {
      const off = officeInfo();
      const b = L.latLngBounds([
        [off.lat, off.lng],
        [lat, lng]
      ]);
      if (attMapCircle) b.extend(attMapCircle.getBounds());
      if (!attMapFitted) {
        attMap.fitBounds(b.pad(0.2));
        attMapFitted = true;
      } else {
        attMap.panTo([lat, lng], { animate: true });
      }
    } catch (e) {}
    paintMapOverlay();
  }

  function forceCenterOnMe(lat, lng) {
    if (lat == null || lng == null) return false;
    if (!attMap) {
      try { initAttMap(); } catch (e) { return false; }
    }
    if (!attMap) return false;
    attMapFitted = false;
    updateAttMap(lat, lng);
    try { attMap.invalidateSize(true); } catch (e) {}
    try {
      const targetZoom = Math.max(17, attMap.getZoom() || 16);
      if (typeof attMap.flyTo === 'function') {
        attMap.flyTo([lat, lng], targetZoom, { duration: 0.55, easeLinearity: 0.25 });
      } else {
        attMap.setView([lat, lng], targetZoom, { animate: true });
      }
    } catch (e) {
      try { attMap.setView([lat, lng], 17); } catch (e2) {}
    }
    paintMapOverlay();
    return true;
  }

  function locateMeOnMap(ev) {
    if (ev) {
      try {
        ev.preventDefault();
        ev.stopPropagation();
      } catch (e) {}
    }
    const btn = document.querySelector('.av-locate-ctrl-btn');
    const pulse = () => {
      if (!btn) return;
      btn.classList.add('is-active');
      setTimeout(() => btn.classList.remove('is-active'), 450);
    };
    pulse();

    // 1) Darhol oxirgi ma'lum joyga qaytar (kutmasdan)
    if (geoLive.lat != null && geoLive.lng != null) {
      forceCenterOnMe(geoLive.lat, geoLive.lng);
      msg(
        geoLive.inside ? 'Sizning joyingiz — ofis hududida' : 'Joriy joyingizga qaytildi',
        geoLive.inside ? 'ok' : 'info'
      );
    } else if (btn) {
      btn.classList.add('is-busy');
    }

    // 2) GPS ni yangilab yana markazlashtir
    getGps().then((g) => {
      applyGeoFix(g.lat, g.lng, g.accuracy);
      forceCenterOnMe(g.lat, g.lng);
      msg(
        geoLive.inside ? 'Sizning joyingiz — ofis hududida' : 'Joriy joyingizga qaytildi',
        geoLive.inside ? 'ok' : 'info'
      );
      if (btn) btn.classList.remove('is-busy');
    }).catch((e) => {
      if (geoLive.lat != null) {
        forceCenterOnMe(geoLive.lat, geoLive.lng);
        if (btn) btn.classList.remove('is-busy');
        return;
      }
      applyGeoError(e);
      showGeoHelp(e.message || 'Joylashuv olinmadi');
      msg(e.message || 'Joylashuv olinmadi', 'err');
      if (btn) btn.classList.remove('is-busy');
    });
  }

  function attachLocateControl() {
    if (!attMap || !window.L) return;
    if (attMap._vmLocateCtrl) return;
    const Ctrl = L.Control.extend({
      options: { position: 'bottomright' },
      onAdd: function () {
        const box = L.DomUtil.create('div', 'av-locate-ctrl');
        const b = L.DomUtil.create('button', 'av-locate-ctrl-btn', box);
        b.type = 'button';
        b.title = 'Mening joyim';
        b.setAttribute('aria-label', 'Mening joyim');
        b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.disableScrollPropagation(box);
        L.DomEvent.on(b, 'click', function (e) {
          L.DomEvent.preventDefault(e);
          L.DomEvent.stop(e);
          locateMeOnMap(e);
        });
        return box;
      }
    });
    attMap._vmLocateCtrl = new Ctrl();
    attMap.addControl(attMap._vmLocateCtrl);
  }

  function startGeoWatch() {
    stopGeoWatch();
    geoLive.status = 'load';
    paintGeoUI();
    if (!navigator.geolocation) {
      applyGeoError(new Error('Joylashuv qoʻllab-quvvatlanmaydi'));
      return;
    }
    getGps().then((g) => {
      applyGeoFix(g.lat, g.lng, g.accuracy);
    }).catch((e) => {
      applyGeoError(e);
    });
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => applyGeoFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
      (err) => {
        if (geoLive.lat == null) applyGeoError(err);
      },
      { enableHighAccuracy: true, maximumAge: 8000, timeout: 20000 }
    );
  }

  function hideGeoHelp() {
    const box = document.getElementById('att-geo-box');
    if (box) box.hidden = true;
  }

  function showGeoHelp(detail) {
    const box = document.getElementById('att-geo-box');
    const text = document.getElementById('att-geo-text');
    const steps = document.getElementById('att-geo-steps');
    if (!box) {
      msg(detail || 'Joylashuv kerak', 'err');
      return;
    }
    clearMsg();
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (text) {
      text.textContent = detail || 'Davomat uchun joylashuv ruxsati majburiy. Pastdagi qadamlarni bajaring.';
    }
    if (steps) {
      if (isIOS) {
        steps.innerHTML = [
          'Sozlamalar → <b>Maxfiylik</b> → <b>Joylashuv xizmatlari</b> → yoqilgan',
          'Shu yerda <b>Safari Veb-saytlari</b> → <b>Ilovadan foydalanganda</b>',
          'Saytda manzil chapidagi <b>aA</b> → <b>Veb-sayt sozlamalari</b>',
          '<b>Joylashuv</b> → <b>Ruxsat</b> (Safari «barcha saytlar» yetarli emas)',
          'Keyin <b>Joylashuvni tekshirish</b> ni bosing'
        ].map((x) => '<li>' + x + '</li>').join('');
      } else {
        steps.innerHTML = [
          'Manzil qatoridagi qulf / (!) ni bosing',
          '<b>Joylashuv</b> → <b>Ruxsat</b>',
          'Keyin <b>Joylashuvni tekshirish</b> ni bosing'
        ].map((x) => '<li>' + x + '</li>').join('');
      }
    }
    box.hidden = false;
  }

  async function checkGeoNow() {
    try {
      hideGeoHelp();
      msg('Joylashuv tekshirilmoqda…', 'info');
      const g = await getGps();
      msg('Joylashuv OK (' + Math.round(g.accuracy || 0) + ' m). Endi Keldim bosing.', 'ok');
      hideGeoHelp();
    } catch (e) {
      showGeoHelp(e.message || 'Joylashuv olinmadi');
    }
  }

  function setFidUI({ status, hint, progress, tone }) {
    const st = document.getElementById('fid-status');
    const hi = document.getElementById('fid-hint');
    const seg = document.getElementById('fid-seg');
    if (st) {
      st.textContent = status || '';
      st.className = 'fid-status' + (tone ? ' ' + tone : '');
    }
    if (hi && hint != null) hi.textContent = hint;
    if (seg && progress != null) {
      const pct = Math.max(0, Math.min(100, progress));
      const n = 16;
      const on = Math.round((pct / 100) * n);
      let html = '';
      for (let i = 0; i < n; i++) html += `<i class="${i < on ? 'on' : ''}"></i>`;
      seg.innerHTML = html;
    }
  }

  function hideFidActions() {
    if (fidActions) fidActions.hidden = true;
  }

  function hideRetry() {
    if (fidRetryWrap) fidRetryWrap.hidden = true;
  }

  function showRetry(errText) {
    hideFidActions();
    if (fidRetryWrap) fidRetryWrap.hidden = false;
    if (errText) {
      setFidUI({ status: 'FAILED', hint: errText, progress: 0, tone: 'err' });
    }
  }

  function showFidActions() {
    if (!fidActions || !STATE) return;
    hideRetry();
    const today = STATE.today || {};
    const canIn = !today.in;
    const canOut = !!(today.in && !today.out);
    // Agar foydalanuvchi aniq Keldim/Ketdim tanlagan bo'lsa — faqat shu
    if (pendingKind === 'in') {
      if (btnKeldim) { btnKeldim.disabled = !canIn; btnKeldim.classList.toggle('ghost', !canIn); }
      if (btnKetdim) { btnKetdim.disabled = true; btnKetdim.classList.add('ghost'); }
    } else if (pendingKind === 'out') {
      if (btnKeldim) { btnKeldim.disabled = true; btnKeldim.classList.add('ghost'); }
      if (btnKetdim) { btnKetdim.disabled = !canOut; btnKetdim.classList.toggle('ghost', !canOut); }
    } else {
      if (btnKeldim) {
        btnKeldim.disabled = !canIn;
        btnKeldim.classList.toggle('ghost', !canIn);
      }
      if (btnKetdim) {
        btnKetdim.disabled = !canOut;
        btnKetdim.classList.toggle('ghost', !canOut);
      }
    }
    fidActions.hidden = false;
  }

  function bindTap(el, fn) {
    if (!el || el._vmTapBound) return;
    el._vmTapBound = true;
    let lock = false;
    const run = (ev) => {
      if (lock) return;
      lock = true;
      if (ev && ev.preventDefault) ev.preventDefault();
      Promise.resolve()
        .then(() => fn(ev))
        .catch(() => {})
        .finally(() => { setTimeout(() => { lock = false; }, 450); });
    };
    el.addEventListener('click', run, { passive: false });
  }

  async function api(path, opts) {
    return vmApi(path, opts);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.faceapi) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Face model skripti yuklanmadi (internet kerak)'));
      document.head.appendChild(s);
    });
  }

  async function ensureModels() {
    if (modelsReady) return;
    if (modelsLoading) return modelsLoading;
    modelsLoading = (async () => {
      setFidUI({ status: 'LOADING…', hint: 'Yuz tahlil modeli yuklanmoqda', progress: 8, tone: 'load' });
      await loadScript(FACE_API_SRC);
      if (!window.faceapi) throw new Error('face-api yuklanmadi');
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);
      modelsReady = true;
    })();
    try { await modelsLoading; }
    finally { modelsLoading = null; }
  }

  function getGpsOnce(opts) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(Object.assign(new Error('Joylashuv qo‘llab-quvvatlanmaydi'), { code: 0 }));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }),
        (err) => reject(err),
        opts
      );
    });
  }

  async function readGeoPermission() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return null;
      const st = await navigator.permissions.query({ name: 'geolocation' });
      return st && st.state ? st.state : null;
    } catch (e) {
      return null;
    }
  }

  function gpsHelpText(code, permState) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (code === 1 || permState === 'denied') {
      if (isIOS) {
        // Global Safari «Разрешить» yetarli emas — sayt uchun aA orqali ruxsat kerak
        return 'Bu sayt uchun joylashuv yopiq. Safari «barcha saytlar» ruxsati yetarli emas.';
      }
      return 'Bu sayt uchun joylashuv yopiq. Manzil qatoridagi qulf → Joylashuv → Ruxsat.';
    }
    if (code === 3) {
      return 'Joylashuv vaqti tugadi. GPS yoqing va «Tekshirish» bosing.';
    }
    if (code === 2) {
      return 'Joylashuv topilmadi. Ochig‘roq joyda «Tekshirish» bosing.';
    }
    return 'Joylashuv olinmadi. «Tekshirish» bosing.';
  }

  async function getGps() {
    if (!window.isSecureContext) {
      throw new Error('Joylashuv faqat HTTPS da ishlaydi');
    }
    // Safari ba'zan Permissions API ni "denied" deb yolg'on ko'rsatadi —
    // shuning uchun avval baribir getCurrentPosition chaqiramiz (prompt chiqishi mumkin).
    try {
      return await getGpsOnce({
        enableHighAccuracy: false,
        timeout: 15000,
        maximumAge: 0
      });
    } catch (e1) {
      try {
        return await getGpsOnce({
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 0
        });
      } catch (e2) {
        const code = (e2 && e2.code) || (e1 && e1.code);
        const perm2 = await readGeoPermission();
        throw Object.assign(new Error(gpsHelpText(code, perm2)), { code: code });
      }
    }
  }

  function openModal(title, sub) {
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('open');
    document.body.classList.add('fid-lock');
    modalOpen = true;
    pendingScan = null;
    hideFidActions();
    hideRetry();
    const t = document.getElementById('fid-title');
    const s = document.getElementById('fid-sub');
    if (t) t.textContent = title || 'FACE ID';
    if (s) s.textContent = sub || '';
    setFidUI({ status: 'LOADING…', hint: 'Ruxsatlar va kamera…', progress: 0, tone: 'load' });
    modal.classList.remove('ok', 'err', 'warn', 'scanning');
  }

  function closeModal() {
    if (abortScan) {
      try { abortScan(); } catch (e) {}
      abortScan = null;
    }
    stopCam();
    pendingScan = null;
    pendingKind = null;
    flowRetry = null;
    hideFidActions();
    hideRetry();
    if (!modal) return;
    modal.classList.remove('open', 'ok', 'err', 'warn', 'scanning');
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('fid-lock');
    modalOpen = false;
  }

  async function startCam() {
    stopCam(false);
    if (!video) throw new Error('Kamera UI topilmadi');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Kamera qo‘llab-quvvatlanmaydi (HTTPS kerak)');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'user' },
        width: { ideal: 720 },
        height: { ideal: 960 },
        aspectRatio: { ideal: 0.75 }
      },
      audio: false
    });
    video.srcObject = stream;
    video.hidden = false;
    await video.play().catch(() => {});
    await waitVideoReady(video);
    const vp = document.getElementById('fid-viewport');
    if (vp) vp.classList.add('live');
  }

  function waitVideoReady(v) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (v.videoWidth > 0) { resolve(); return; }
        if (Date.now() - t0 > 8000) { reject(new Error('Kamera ochilmadi')); return; }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  function stopScanLoop() {
    if (scanLoop) { cancelAnimationFrame(scanLoop); scanLoop = null; }
  }

  function stopCam(clearOverlay) {
    stopScanLoop();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) video.srcObject = null;
    const vp = document.getElementById('fid-viewport');
    if (vp) vp.classList.remove('live', 'locked');
    if (clearOverlay !== false && overlay) {
      const ctx = overlay.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  function snapPhoto() {
    if (!video || !snapCanvas || !video.videoWidth) throw new Error('Kamera tayyor emas');
    const w = video.videoWidth;
    const h = video.videoHeight;
    const max = 640;
    const s = Math.min(1, max / Math.max(w, h));
    snapCanvas.width = Math.round(w * s);
    snapCanvas.height = Math.round(h * s);
    snapCanvas.getContext('2d').drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
    return snapCanvas.toDataURL('image/jpeg', 0.82);
  }

  function drawHud(detection, locked, progress) {
    if (!overlay || !video) return;
    const vp = document.getElementById('fid-viewport');
    const w = (vp && vp.clientWidth) || 320;
    const h = (vp && vp.clientHeight) || 400;
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w;
      overlay.height = h;
    }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const sx = w / video.videoWidth;
    const sy = h / video.videoHeight;
    const glow = locked ? '#3dffb5' : '#3ecbff';

    ctx.save();
    ctx.strokeStyle = 'rgba(62,203,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.42, w * 0.26, h * 0.3, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    if (!detection || !detection.landmarks) return;
    const mapped = detection.landmarks.positions.map((p) => ({ x: p.x * sx, y: p.y * sy }));

    ctx.save();
    ctx.strokeStyle = locked ? 'rgba(61,255,181,0.55)' : 'rgba(62,203,255,0.5)';
    ctx.lineWidth = 1;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 6;
    MESH_EDGES.forEach(([a, b]) => {
      if (!mapped[a] || !mapped[b]) return;
      ctx.beginPath();
      ctx.moveTo(mapped[a].x, mapped[a].y);
      ctx.lineTo(mapped[b].x, mapped[b].y);
      ctx.stroke();
    });
    ctx.restore();

    ctx.save();
    ctx.fillStyle = glow;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 10;
    mapped.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, (i % 5 === 0) ? 2.4 : 1.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();

    if (detection.detection) {
      const box = detection.detection.box;
      const x = box.x * sx, y = box.y * sy, bw = box.width * sx, bh = box.height * sy;
      const L = Math.min(bw, bh) * 0.18;
      ctx.strokeStyle = glow;
      ctx.lineWidth = 2.2;
      ctx.shadowColor = glow;
      ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(x, y + L); ctx.lineTo(x, y); ctx.lineTo(x + L, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + bw - L, y); ctx.lineTo(x + bw, y); ctx.lineTo(x + bw, y + L); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + bh - L); ctx.lineTo(x, y + bh); ctx.lineTo(x + L, y + bh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + bw - L, y + bh); ctx.lineTo(x + bw, y + bh); ctx.lineTo(x + bw, y + bh - L); ctx.stroke();
    }

    if (progress != null) {
      const cx = w / 2, cy = h * 0.42, r = Math.min(w, h) * 0.38;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(62,203,255,0.15)';
      ctx.lineWidth = 3;
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = glow;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * progress) / 100);
      ctx.stroke();
    }
  }

  async function detectOnce(v) {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 });
    return faceapi.detectSingleFace(v, opts).withFaceLandmarks().withFaceDescriptor();
  }

  function avgDescriptors(list) {
    if (!list.length) return null;
    const n = list[0].length;
    const out = new Array(n).fill(0);
    list.forEach((d) => { for (let i = 0; i < n; i++) out[i] += d[i]; });
    for (let i = 0; i < n; i++) out[i] /= list.length;
    return out;
  }

  function scanFace({ needSamples, label, timeoutMs }) {
    const samples = [];
    const need = needSamples || 4;
    const deadline = Date.now() + (timeoutMs || 22000);
    let lastOk = 0;
    let cancelled = false;
    abortScan = () => { cancelled = true; };

    return new Promise((resolve, reject) => {
      if (!video) { reject(new Error('Kamera yo‘q')); return; }
      setFidUI({ status: 'SCANNING…', hint: label || 'Yuzni markazga qo‘ying', progress: 0, tone: 'scan' });
      if (modal) modal.classList.add('scanning');

      const tick = async () => {
        try {
          if (cancelled) { stopScanLoop(); reject(new Error('Bekor qilindi')); return; }
          if (Date.now() > deadline) {
            stopScanLoop();
            reject(new Error('Yuz topilmadi. Yorug‘likni yaxshilang va qayta bosing'));
            return;
          }
          const det = await detectOnce(video);
          const ok = !!(det && det.descriptor && det.detection && det.detection.score >= 0.5);
          const pct = (samples.length / need) * 100;
          drawHud(det, ok && samples.length >= need - 1, pct);

          if (ok) {
            const now = Date.now();
            if (now - lastOk > 160) {
              samples.push(Array.from(det.descriptor));
              lastOk = now;
              setFidUI({
                status: 'ANALYZING…',
                hint: `Biometrik nuqtalar · ${samples.length}/${need}`,
                progress: (samples.length / need) * 100,
                tone: 'scan'
              });
            }
          } else {
            setFidUI({
              status: 'SEARCHING…',
              hint: 'Yuzni ramka ichiga qo‘ying',
              progress: (samples.length / need) * 100,
              tone: 'warn'
            });
            if (modal) { modal.classList.add('warn'); modal.classList.remove('ok'); }
          }

          if (samples.length >= need) {
            stopScanLoop();
            const descriptor = avgDescriptors(samples);
            const photo = snapPhoto();
            drawHud(det, true, 100);
            if (modal) {
              modal.classList.remove('warn', 'scanning');
              modal.classList.add('ok');
            }
            const vp = document.getElementById('fid-viewport');
            if (vp) vp.classList.add('locked');
            setFidUI({ status: 'VERIFIED', hint: 'Yuz tasdiqlandi — Keldim yoki Ketdim ni tanlang', progress: 100, tone: 'ok' });
            abortScan = null;
            resolve({ descriptor, photo, samples: samples.length });
            return;
          }

          scanLoop = requestAnimationFrame(() => { setTimeout(tick, 35); });
        } catch (e) {
          stopScanLoop();
          abortScan = null;
          reject(e);
        }
      };
      tick();
    });
  }

  function parseTs(iso) {
    if (!iso) return NaN;
    let s = String(iso).trim();
    if (/^\d{4}-\d{2}-\d{2} /.test(s)) s = s.replace(' ', 'T');
    let t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      return new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6] || 0)
      ).getTime();
    }
    return NaN;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      const ms = parseTs(iso);
      if (Number.isNaN(ms)) return '—';
      const d = new Date(ms);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    } catch (e) { return '—'; }
  }

  function fmtDate(d) {
    if (!d) return '—';
    const p = String(d).split('-');
    if (p.length !== 3) return esc(d);
    return p[2] + '.' + p[1] + '.' + p[0];
  }

  function fmtDur(sec) {
    if (sec == null || sec < 0) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function startLiveTimer() {
    stopTimer();
    const today = (STATE && STATE.today) || {};
    if (!today.in || !today.in.at || today.out) return;
    const t0 = parseTs(today.in.at);
    if (Number.isNaN(t0)) return;
    const tick = () => {
      const el = document.getElementById('att-live-timer');
      if (!el) return;
      const sec = Math.max(0, Math.floor((Date.now() - t0) / 1000));
      el.textContent = fmtDur(sec);
    };
    tick();
    timerId = setInterval(tick, 1000);
  }

  function dayWorkedSec(rec) {
    if (!rec || !rec.in || !rec.in.at) return null;
    const t0 = parseTs(rec.in.at);
    if (Number.isNaN(t0)) return null;
    if (rec.out && rec.out.at) {
      const t1 = parseTs(rec.out.at);
      if (Number.isNaN(t1)) return null;
      return Math.max(0, Math.floor((t1 - t0) / 1000));
    }
    return Math.max(0, Math.floor((Date.now() - t0) / 1000));
  }

  function roleLabel(r) {
    return ({ admin_pro: 'Admin Pro', admin: 'Admin', driver: 'Haydovchi' })[r] || r || '—';
  }

  function monthInputValue(ym) {
    if (ym && /^\d{4}-\d{2}$/.test(ym)) return ym;
    const t = (STATE && STATE.settings && STATE.settings.today) || '';
    if (t.length >= 7) return t.slice(0, 7);
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
  }

  function dayInputValue(d) {
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    return (STATE && STATE.settings && STATE.settings.today) || '';
  }

  function kpiCard(label, value, tone) {
    return `<div class="att-kpi ${tone || ''}"><div class="att-kpi-v">${esc(String(value))}</div><div class="att-kpi-l">${esc(label)}</div></div>`;
  }

  function renderBoardHtml(d) {
    const rows = (d && d.rows) || [];
    const c = (d && d.counts) || {};
    return `
      <div class="att-kpi-row">
        ${kpiCard('Jami', c.total != null ? c.total : rows.length)}
        ${kpiCard('Kelgan', c.present || 0, 'ok')}
        ${kpiCard('Ishda', c.working || 0, 'info')}
        ${kpiCard('Kechikdi', c.late || 0, 'warn')}
        ${kpiCard('Yo‘q', c.absent || 0, 'bad')}
        ${kpiCard('Face', c.enrolled || 0)}
      </div>
      <div class="scroll-x">
      <table class="att-table">
        <thead><tr><th>Ism</th><th>Rol</th><th>Mashina</th><th>Holat</th><th>Keldim</th><th>Ketdim</th><th>Ish</th><th>Face</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><b>${esc(r.name || r.username)}</b><div class="att-sub">@${esc(r.username || '')}</div></td>
              <td>${esc(roleLabel(r.role))}</td>
              <td class="mono">${esc(r.car || '—')}</td>
              <td><span class="att-badge ${esc(r.status)}">${esc(statusLabel(r.status))}</span></td>
              <td class="mono">${r.in ? fmtTime(r.in.at) + (r.in.late ? ' !' : '') : '—'}</td>
              <td class="mono">${r.out ? fmtTime(r.out.at) : '—'}</td>
              <td class="mono">${r.worked_sec != null ? fmtDur(r.worked_sec) : (r.in && !r.out ? '…' : '—')}</td>
              <td>${r.enrolled ? '✓' : '—'}</td>
              <td><button type="button" class="att-link-btn" data-person="${esc(r.userId)}">Oy</button></td>
            </tr>`).join('') || '<tr><td colspan="9">Bo‘sh</td></tr>'}
        </tbody>
      </table></div>`;
  }

  function renderReportHtml(rep) {
    if (!rep) return `<p class="att-hint">Yuklanmoqda…</p>`;
    const s = rep.summary || {};
    const people = rep.people || [];
    const dates = rep.dates || [];
    return `
      <div class="att-kpi-row">
        ${kpiCard('Odam', s.people || 0)}
        ${kpiCard('Face ulangan', s.enrolled || 0, 'ok')}
        ${kpiCard('Kelgan kunlar', s.presentDays || 0, 'info')}
        ${kpiCard('Kechikish', s.lateDays || 0, 'warn')}
        ${kpiCard('Yo‘qlik', s.absentDays || 0, 'bad')}
        ${kpiCard('O‘rt. kelish', s.avgArrival || '—')}
      </div>
      <p class="att-hint" style="margin:0 0 10px">Qatorni bosing — shaxsiy oylik ochiladi. Bugun: kelgan ${(s.today && s.today.present) || 0} / ${(s.today && s.today.total) || 0}.</p>
      <div class="scroll-x">
      <table class="att-table att-table-dense">
        <thead>
          <tr>
            <th>Xodim</th><th>Kun</th><th>Kech</th><th>Yo‘q</th><th>O‘rt. kelish</th><th>Ish soati</th>
            ${dates.map((d) => `<th class="att-day-h" title="${esc(d)}">${esc(d.slice(8))}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${people.map((p) => {
            const byDate = {};
            (p.days || []).forEach((x) => { byDate[x.date] = x; });
            return `<tr class="att-row-click" data-person="${esc(p.userId)}" title="Oylikni ochish">
              <td><b>${esc(p.name || p.username)}</b>
                <div class="att-sub">${esc(roleLabel(p.role))}${p.car ? ' · ' + esc(p.car) : ''}${p.enrolled ? '' : ' · Face yo‘q'}</div>
              </td>
              <td class="mono">${p.presentDays}</td>
              <td class="mono">${p.lateDays}</td>
              <td class="mono">${p.absentDays}</td>
              <td class="mono">${esc(p.avgIn || '—')}</td>
              <td class="mono">${p.worked_sec ? fmtDur(p.worked_sec) : '—'}</td>
              ${dates.map((d) => {
                const x = byDate[d];
                if (!x || x.status === 'absent') return `<td class="att-cell absent" title="${esc(d)}">·</td>`;
                const cls = x.late ? 'late' : (x.status === 'done' ? 'done' : 'in');
                return `<td class="att-cell ${cls}" title="${esc(d)} ${esc(x.inAt || '')}">${esc(x.inAt || '✓')}</td>`;
              }).join('')}
            </tr>`;
          }).join('') || '<tr><td colspan="6">Ma’lumot yo‘q</td></tr>'}
        </tbody>
      </table></div>`;
  }

  function renderPersonHtml(p) {
    if (!p) return `<p class="att-hint">Xodimni tanlang</p>`;
    const u = p.user || {};
    const st = p.stats || {};
    const days = p.days || [];
    return `
      <div class="att-person-head">
        <div>
          <div class="att-person-name">${esc(u.name || u.username || '—')}</div>
          <div class="att-sub">@${esc(u.username || '')} · ${esc(roleLabel(u.role))}${u.car ? ' · ' + esc(u.car) : ''} · Face ${u.enrolled ? 'ulangan' : 'yo‘q'}</div>
        </div>
      </div>
      <div class="att-kpi-row">
        ${kpiCard('Kelgan', st.presentDays || 0, 'ok')}
        ${kpiCard('Kechikish', st.lateDays || 0, 'warn')}
        ${kpiCard('Yo‘qlik', st.absentDays || 0, 'bad')}
        ${kpiCard('O‘rt. kelish', st.avgIn || '—')}
        ${kpiCard('Jami ish', st.worked_sec ? fmtDur(st.worked_sec) : '—')}
      </div>
      <div class="att-cal">
        ${days.map((d) => {
          const cls = d.status || 'absent';
          return `<div class="att-cal-day ${esc(cls)}${d.late ? ' late' : ''}" title="${esc(d.note || '')}">
            <div class="d">${esc(d.date.slice(8))} <span>${esc(d.weekday || '')}</span></div>
            <div class="t">${d.status === 'future' ? '—' : (d.inAt ? esc(d.inAt) + (d.late ? ' !' : '') : 'yo‘q')}</div>
            <div class="o">${d.outAt ? esc(d.outAt) : (d.inAt && d.status !== 'future' ? '…' : '')}</div>
            <div class="w">${d.worked_sec != null ? fmtDur(d.worked_sec) : ''}</div>
          </div>`;
        }).join('')}
      </div>
      <div class="scroll-x" style="margin-top:14px">
      <table class="att-table">
        <thead><tr><th>Sana</th><th>Keldim</th><th>Ketdim</th><th>Ish</th><th>Masofa</th><th>Holat</th></tr></thead>
        <tbody>
          ${days.filter((d) => d.status !== 'future').slice().reverse().map((d) => `
            <tr>
              <td>${fmtDate(d.date)}</td>
              <td class="mono">${d.inAt ? esc(d.inAt) + (d.late ? ' !' : '') : '—'}</td>
              <td class="mono">${d.outAt ? esc(d.outAt) : '—'}</td>
              <td class="mono">${d.worked_sec != null ? fmtDur(d.worked_sec) : '—'}</td>
              <td class="mono">${d.distance_m != null ? Math.round(d.distance_m) + ' m' : '—'}</td>
              <td><span class="att-badge ${esc(d.status)}">${esc(statusLabel(d.status))}</span></td>
            </tr>`).join('') || '<tr><td colspan="6">Yozuv yo‘q</td></tr>'}
        </tbody>
      </table></div>`;
  }

  function render() {
    if (!STATE) return;
    stopTimer();
    stopClock();
    stopGeoWatch();
    destroyAttMap();
    const s = STATE.settings || {};
    const face = STATE.face || {};
    const today = STATE.today || {};
    const inn = today.in;
    const out = today.out;
    const enrolled = !!STATE.enrolled;
    const staff = window.VM_USER && (VM_USER.role === 'admin' || VM_USER.role === 'admin_pro');
    const history = STATE.history || [];
    const working = !!(inn && !out);
    const done = !!(inn && out);
    const off = officeInfo();
    const uname = userDisplayName();
    const firstName = String(uname).split(/\s+/)[0] || uname;
    if (!boardDate) boardDate = dayInputValue('');
    if (!reportMonth) reportMonth = monthInputValue('');
    if (!personMonth) personMonth = monthInputValue('');

    app.innerHTML = `
      <div class="att-tabs" role="tablist">
        <button type="button" class="att-tab ${uiTab === 'bugun' ? 'on' : ''}" data-tab="bugun">Bugun</button>
        ${staff ? `<button type="button" class="att-tab ${uiTab === 'dash' ? 'on' : ''}" data-tab="dash">Dashboard</button>` : ''}
        ${staff ? `<button type="button" class="att-tab ${uiTab === 'hisobot' ? 'on' : ''}" data-tab="hisobot">Hisobot</button>` : ''}
        ${staff ? `<button type="button" class="att-tab ${uiTab === 'shaxs' ? 'on' : ''}" data-tab="shaxs">Xodim</button>` : ''}
        <button type="button" class="att-tab ${uiTab === 'tarix' ? 'on' : ''}" data-tab="tarix">Tarix</button>
        ${staff ? `<button type="button" class="att-tab ${uiTab === 'soz' ? 'on' : ''}" data-tab="soz">Sozlamalar</button>` : ''}
      </div>

      <div class="att-panel" id="panel-bugun" ${uiTab === 'bugun' ? '' : 'hidden'}>
        <div class="av-studio">
          <section class="av-hero">
            <div class="av-hero-top">
              <div>
                <div class="av-greet">Assalomu alaykum, <span>${esc(firstName)}</span></div>
                <div class="av-role">${esc(userRoleLabel())} · ${esc(off.label)}</div>
              </div>
              <div class="av-date-pill">${esc(fmtDateLong(s.today))}</div>
            </div>
            <div class="av-hero-grid">
              <div class="av-glass">
                <div class="k">Joriy vaqt</div>
                <div class="v" id="av-now-clock">--:--:--</div>
                <div class="s">Bugun ham ajoyib kun!</div>
              </div>
              <div class="av-glass ${working ? 'live' : (done ? 'done' : '')}">
                <div class="k">${working ? 'Ishlayapti' : (done ? 'Bugun yakunlandi' : 'Ishlagan vaqt')}</div>
                <div class="v" id="att-live-timer">${fmtDur(dayWorkedSec(today) || 0)}</div>
                <div class="s">${working ? 'Timer jonli' : (done ? 'Keldi + ketdi qayd etildi' : 'Hali boshlanmagan')}</div>
              </div>
            </div>
          </section>

          <div class="av-gate-banner" id="av-gate-banner">Joylashuv tekshirilmoqda…</div>

          ${!enrolled ? `
            <section class="av-method-card">
              <h3>Face ID ulang</h3>
              <p class="sub">Birinchi marta yuzingizni tizimga bogʻlang — keyin har kuni ofisda Keldi/Ketdi ochiladi.</p>
              <button type="button" class="av-continue" id="btn-enroll">Face ID ulash<small>Kamera orqali bir marta</small></button>
            </section>
          ` : `
            <div class="av-punch-row">
              <button type="button" class="av-punch av-punch-in is-locked" id="btn-keldim-main" ${inn || done ? 'disabled' : ''}>
                <span class="ico">→]</span>
                <div class="tag">● Keldi</div>
                <div class="time">${inn ? fmtTime(inn.at) : '—'}</div>
                <div class="plan">Rejada: ${esc(s.in_start || '08:30')}${inn && inn.late ? ' · kechikdi' : ''}</div>
              </button>
              <button type="button" class="av-punch av-punch-out is-locked" id="btn-ketdim-main" ${(!inn || out || done) ? 'disabled' : ''}>
                <span class="ico">[→</span>
                <div class="tag">● Ketdi</div>
                <div class="time">${out ? fmtTime(out.at) : '—'}</div>
                <div class="plan">Rejada: ${esc(s.out_end || '21:00')}</div>
              </button>
            </div>
          `}

          <section class="av-map-card">
            <div class="av-map-h">
              <h3>${esc(off.label)}</h3>
              <span class="av-geo-badge load" id="av-geo-badge">Joylashuv…</span>
            </div>
            <div class="av-map-wrap">
              <div class="av-map" id="av-map"></div>
              <div class="av-map-legend">
                <span><i class="lg-office"></i> Ofis markazi</span>
                <span><i class="lg-zone"></i> Belgilangan radius</span>
                <span><i class="lg-you"></i> Sizning joyingiz</span>
              </div>
            </div>
            <div class="av-map-foot">
              <span id="av-geo-dist">Radius <b>${esc(String(off.radius))}</b> m</span>
              <button type="button" class="att-btn att-btn-face" id="btn-geo-check" style="min-height:36px;padding:0 12px;font-size:12px">Qayta tekshirish</button>
            </div>
          </section>

          ${enrolled ? `
          <section class="av-method-card">
            <h3>Davomat usulini tanlang</h3>
            <p class="sub">Ofis ichida boʻlsangiz — Face ID orqali davom eting</p>
            <div class="av-methods">
              <button type="button" class="av-method ${attMethod === 'face' ? 'on' : ''}" data-method="face" id="av-method-face">
                <span class="check">✓</span>
                <div class="m-ico">▣</div>
                <div class="m-t">Face ID</div>
                <div class="m-s">Rasmga olish orqali tasdiqlash</div>
              </button>
              <button type="button" class="av-method disabled" data-method="qr" disabled title="Tez orada">
                <div class="m-ico">▦</div>
                <div class="m-t">QR Scanner</div>
                <div class="m-s">Tez orada</div>
              </button>
            </div>
            <button type="button" class="av-continue" id="av-continue" disabled>
              <span>Ofisga keling</span>
              <small>${esc(off.label)} · ${esc(String(off.radius))} m</small>
            </button>
            <div style="margin-top:10px;text-align:center">
              <button type="button" class="att-btn att-btn-face" id="btn-reenroll" style="min-height:36px;font-size:12px">Yuzni qayta ulash</button>
            </div>
          </section>
          ` : ''}

          <div class="att-msg" id="att-msg"></div>
          <div class="att-geo-box" id="att-geo-box" hidden>
            <div class="att-geo-title">Joylashuv kerak</div>
            <p class="att-geo-text" id="att-geo-text"></p>
            <ol class="att-geo-steps" id="att-geo-steps"></ol>
            <button type="button" class="att-btn att-btn-in" id="btn-geo-check-2">Joylashuvni tekshirish</button>
          </div>

          ${face.photo ? `
          <section class="att-card">
            <div class="att-card-h">Face ID profil</div>
            <div class="att-card-b">
              <div class="att-enrolled-block" style="margin:0">
                <img class="att-enrolled-thumb" src="${face.photo}" alt="Face">
                <div>
                  <div class="att-enrolled-title">Tasdiqlangan yuz</div>
                  <div class="att-hint" style="margin:4px 0 0">${esc(uname)} · ${esc(face.enrolledAt ? fmtTime(face.enrolledAt) : '')}</div>
                </div>
              </div>
            </div>
          </section>` : ''}

          <section class="av-hist">
            <div class="av-hist-h">Bugungi / soʻnggi yozuvlar</div>
            <div class="av-hist-b">
              ${history.length ? `
                <div class="scroll-x">
                <table class="att-table">
                  <thead><tr><th>Sana</th><th>Keldim</th><th>Ketdim</th><th>Ish vaqti</th><th>Holat</th></tr></thead>
                  <tbody>
                    ${history.slice(0, 8).map((r) => `
                      <tr>
                        <td>${fmtDate(r.date)}</td>
                        <td>${r.in ? fmtTime(r.in.at) + (r.late ? ' !' : '') : '—'}</td>
                        <td>${r.out ? fmtTime(r.out.at) : '—'}</td>
                        <td class="mono">${r.worked_sec != null ? fmtDur(r.worked_sec) : (r.in && !r.out ? '…' : '—')}</td>
                        <td><span class="att-badge ${esc(r.status)}">${esc(statusLabel(r.status))}</span></td>
                      </tr>`).join('')}
                  </tbody>
                </table></div>
              ` : `<p class="att-hint">Hali yozuv yoʻq. Ofisda Face ID bilan belgilang — tarix shu yerda chiqadi.</p>`}
            </div>
          </section>
        </div>
      </div>

      <div class="att-panel" id="panel-tarix" ${uiTab === 'tarix' ? '' : 'hidden'}>
        <section class="att-card">
          <div class="att-card-h">Mening davomatim</div>
          <div class="att-card-b">
            ${history.length ? `
              <div class="scroll-x">
              <table class="att-table">
                <thead><tr><th>Sana</th><th>Keldim</th><th>Ketdim</th><th>Ish vaqti</th><th>Holat</th></tr></thead>
                <tbody>
                  ${history.map((r) => `
                    <tr>
                      <td>${fmtDate(r.date)}</td>
                      <td>${r.in ? fmtTime(r.in.at) + (r.late ? ' !' : '') : '—'}</td>
                      <td>${r.out ? fmtTime(r.out.at) : '—'}</td>
                      <td class="mono">${r.worked_sec != null ? fmtDur(r.worked_sec) : (r.in && !r.out ? '…' : '—')}</td>
                      <td><span class="att-badge ${esc(r.status)}">${esc(statusLabel(r.status))}</span></td>
                    </tr>`).join('')}
                </tbody>
              </table></div>
            ` : `<p class="att-hint">Hali yozuv yo‘q. Birinchi marta Keldim bosing.</p>`}
          </div>
        </section>
      </div>

      ${staff ? `
      <div class="att-panel" id="panel-dash" ${uiTab === 'dash' ? '' : 'hidden'}>
        <section class="att-card">
          <div class="att-card-h">
            <span>Jamoa dashboard</span>
            <div class="att-toolbar">
              <input type="date" id="board-date" value="${esc(dayInputValue(boardDate))}">
              <button type="button" class="att-btn att-btn-face" id="btn-board" style="padding:8px 12px;min-width:0;font-size:12px">Yangilash</button>
            </div>
          </div>
          <div class="att-card-b" id="att-board"><p class="att-hint">Yuklanmoqda…</p></div>
        </section>
      </div>

      <div class="att-panel" id="panel-hisobot" ${uiTab === 'hisobot' ? '' : 'hidden'}>
        <section class="att-card">
          <div class="att-card-h">
            <span>Oylik hisobot</span>
            <div class="att-toolbar">
              <input type="month" id="report-month" value="${esc(monthInputValue(reportMonth))}">
              <button type="button" class="att-btn att-btn-face" id="btn-report" style="padding:8px 12px;min-width:0;font-size:12px">Yangilash</button>
              <button type="button" class="att-btn att-btn-in" id="btn-export-xlsx" style="padding:8px 12px;min-width:0;font-size:12px">Excel</button>
              <button type="button" class="att-btn att-btn-out" id="btn-export-pdf" style="padding:8px 12px;min-width:0;font-size:12px">PDF</button>
            </div>
          </div>
          <div class="att-card-b" id="att-report"><p class="att-hint">Yuklanmoqda…</p></div>
        </section>
      </div>

      <div class="att-panel" id="panel-shaxs" ${uiTab === 'shaxs' ? '' : 'hidden'}>
        <section class="att-card">
          <div class="att-card-h">
            <span>Xodim tahlili</span>
            <div class="att-toolbar">
              <select id="person-select"><option value="">— tanlang —</option></select>
              <input type="month" id="person-month" value="${esc(monthInputValue(personMonth))}">
              <button type="button" class="att-btn att-btn-face" id="btn-person" style="padding:8px 12px;min-width:0;font-size:12px">Ko‘rish</button>
              <button type="button" class="att-btn att-btn-in" id="btn-person-xlsx" style="padding:8px 12px;min-width:0;font-size:12px">Excel</button>
              <button type="button" class="att-btn att-btn-out" id="btn-person-pdf" style="padding:8px 12px;min-width:0;font-size:12px">PDF</button>
            </div>
          </div>
          <div class="att-card-b" id="att-person"><p class="att-hint">Xodimni tanlang — kunlik kelish/ketish va oylik statistika.</p></div>
        </section>
      </div>

      <div class="att-panel" id="panel-soz" ${uiTab === 'soz' ? '' : 'hidden'}>
        <section class="att-card">
          <div class="att-card-h">Sozlamalar</div>
          <div class="att-card-b att-settings" id="att-settings"></div>
        </section>
      </div>
      ` : ''}
    `;

    bindActions(staff);
    if (uiTab === 'bugun') {
      startClock();
      startGeoWatch();
      initAttMap();
      paintGeoUI();
    }
    if (staff && uiTab === 'dash') loadBoard();
    if (staff && uiTab === 'hisobot') loadReport();
    if (staff && uiTab === 'shaxs') loadPersonPanel();
    if (staff && uiTab === 'soz') renderSettings();
    if (working) startLiveTimer();
  }

  function statusLabel(s) {
    return ({ in: 'Ishda', late: 'Kechikdi', done: 'To‘liq', absent: 'Yo‘q', future: '—' })[s] || s;
  }

  function openPerson(uid) {
    if (!uid) return;
    personId = String(uid);
    uiTab = 'shaxs';
    render();
  }

  function bindActions(staff) {
    app.querySelectorAll('.att-tab').forEach((btn) => {
      bindTap(btn, () => {
        uiTab = btn.getAttribute('data-tab') || 'bugun';
        render();
      });
    });

    const enroll = document.getElementById('btn-enroll');
    const re = document.getElementById('btn-reenroll');
    const board = document.getElementById('btn-board');
    const kIn = document.getElementById('btn-keldim-main');
    const kOut = document.getElementById('btn-ketdim-main');
    const boardDateEl = document.getElementById('board-date');
    const reportBtn = document.getElementById('btn-report');
    const reportMonthEl = document.getElementById('report-month');
    const personBtn = document.getElementById('btn-person');
    const personSel = document.getElementById('person-select');
    const personMonthEl = document.getElementById('person-month');

    if (enroll) bindTap(enroll, () => doEnroll());
    if (re) bindTap(re, () => { if (!busy) doEnroll(true); });
    if (board) bindTap(board, () => {
      if (boardDateEl) boardDate = boardDateEl.value || boardDate;
      loadBoard();
    });
    if (boardDateEl) {
      boardDateEl.addEventListener('change', () => {
        boardDate = boardDateEl.value || boardDate;
        loadBoard();
      });
    }
    if (reportBtn) bindTap(reportBtn, () => {
      if (reportMonthEl) reportMonth = reportMonthEl.value || reportMonth;
      loadReport(true);
    });
    const xlsxBtn = document.getElementById('btn-export-xlsx');
    const pdfBtn = document.getElementById('btn-export-pdf');
    if (xlsxBtn) bindTap(xlsxBtn, () => exportReportXlsx());
    if (pdfBtn) bindTap(pdfBtn, () => exportReportPdf());
    const px = document.getElementById('btn-person-xlsx');
    const pp = document.getElementById('btn-person-pdf');
    if (px) bindTap(px, () => exportPersonXlsx());
    if (pp) bindTap(pp, () => exportPersonPdf());
    if (reportMonthEl) {
      reportMonthEl.addEventListener('change', () => {
        reportMonth = reportMonthEl.value || reportMonth;
        loadReport(true);
      });
    }
    if (personBtn) bindTap(personBtn, () => {
      if (personSel) personId = personSel.value || '';
      if (personMonthEl) personMonth = personMonthEl.value || personMonth;
      loadPerson(true);
    });
    if (personSel) {
      personSel.addEventListener('change', () => {
        personId = personSel.value || '';
        loadPerson(true);
      });
    }
    if (personMonthEl) {
      personMonthEl.addEventListener('change', () => {
        personMonth = personMonthEl.value || personMonth;
        if (personId) loadPerson(true);
      });
    }
    if (kIn) bindTap(kIn, () => startAttendanceFlow('in'));
    if (kOut) bindTap(kOut, () => startAttendanceFlow('out'));
    const geoBtn = document.getElementById('btn-geo-check');
    if (geoBtn) bindTap(geoBtn, () => {
      hideGeoHelp();
      startGeoWatch();
    });
    const geoBtn2 = document.getElementById('btn-geo-check-2');
    if (geoBtn2) bindTap(geoBtn2, () => checkGeoNow());

    const cont = document.getElementById('av-continue');
    if (cont) bindTap(cont, () => {
      const kind = cont.getAttribute('data-next') || (!((STATE.today || {}).in) ? 'in' : 'out');
      startAttendanceFlow(kind);
    });
    const methodFace = document.getElementById('av-method-face');
    if (methodFace) bindTap(methodFace, () => {
      attMethod = 'face';
      document.querySelectorAll('.av-method[data-method]').forEach((el) => {
        el.classList.toggle('on', el.getAttribute('data-method') === 'face');
      });
      paintGeoUI();
    });

    app.querySelectorAll('[data-person]').forEach((el) => {
      bindTap(el, () => openPerson(el.getAttribute('data-person')));
    });
  }

  /** Face verify → Keldim/Ketdim tasdiq */
  async function startAttendanceFlow(kind) {
    if (busy) return;
    if (!STATE || !STATE.enrolled) {
      msg('Avval Face ID ulang', 'err');
      return;
    }
    const today = STATE.today || {};
    if (today.in && today.out) {
      msg('Bugun allaqachon yakunlangan', 'info');
      return;
    }
    if (kind === 'in' && today.in) {
      msg('Bugun Keldim allaqachon bor', 'info');
      return;
    }
    if (kind === 'out' && !today.in) {
      msg('Avval Keldim qiling', 'info');
      return;
    }
    if (kind === 'out' && today.out) {
      msg('Bugun Ketdim allaqachon bor', 'info');
      return;
    }
    if (geoLive.inside !== true) {
      msg('Faqat ofis radiusida ochiladi. Xaritada joylashuvingizni tekshiring.', 'err');
      startGeoWatch();
      return;
    }

    pendingKind = kind || null;
    busy = true;
    clearMsg();
    openModal(
      'FACE ID',
      kind === 'out' ? 'Ketdim uchun yuzni tasdiqlang' : 'Keldim uchun yuzni tasdiqlang'
    );
    flowRetry = () => startAttendanceFlow(kind);

    try {
      // iOS: kamera + GPS birga so'ralsa joylashuv "denied" bo'lishi mumkin — avval GPS
      setFidUI({ status: 'JOYLASHUV…', hint: 'Joylashuvga Ruxsat bosing (birinchi qadam)', progress: 8, tone: 'load' });
      const gps = await getGps();

      setFidUI({ status: 'KAMERA…', hint: 'Endi kameraga ruxsat bering', progress: 16, tone: 'load' });
      await startCam();

      setFidUI({ status: 'LOADING…', hint: 'Yuz modeli…', progress: 24, tone: 'load' });
      await ensureModels();

      const scan = await scanFace({
        needSamples: 3,
        label: 'Telefonni odatdagidek ushlang — yuz oval ichida',
        timeoutMs: 25000
      });

      stopScanLoop();
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }

      pendingScan = { descriptor: scan.descriptor, photo: scan.photo, gps };
      showFidActions();
      // Agar kind aniq — darhol yozish (bitta bosish mobil uchun)
      if (kind === 'in' || kind === 'out') {
        await confirmPunch(kind);
      } else {
        busy = false;
      }
    } catch (e) {
      stopCam();
      const text = e.message || 'Xato';
      const isGeo = /joylashuv|geolocation|GPS|location|yopiq/i.test(text) || e.code === 1 || e.code === 2 || e.code === 3;
      if (isGeo) {
        // Modal ichida qora ekran chalkashtiradi — asosiy sahifada yo'riqnoma
        closeModal();
        showGeoHelp(text);
        msg('Avval joylashuvni yoqing, keyin Keldim.', 'err');
        busy = false;
        return;
      }
      if (modal) { modal.classList.add('err'); modal.classList.remove('ok', 'scanning'); }
      setFidUI({ status: 'FAILED', hint: text, progress: 0, tone: 'err' });
      msg(text, 'err');
      showRetry(text);
      busy = false;
    }
  }

  async function confirmPunch(kind) {
    if (!pendingScan) {
      msg('Avval yuzni tasdiqlang', 'err');
      return;
    }
    busy = true;
    hideFidActions();
    hideRetry();
    try {
      setFidUI({
        status: kind === 'in' ? 'KELDIM…' : 'KETDIM…',
        hint: 'Tasdiq kaliti…',
        progress: 92,
        tone: 'ok'
      });
      const chalRes = await api('/api/attendance/challenge', {
        method: 'POST',
        body: JSON.stringify({ purpose: kind })
      });
      const challenge = chalRes && chalRes.challenge;
      if (!challenge) throw new Error('Challenge olinmadi');

      setFidUI({
        status: kind === 'in' ? 'KELDIM…' : 'KETDIM…',
        hint: 'Yozilmoqda…',
        progress: 100,
        tone: 'ok'
      });
      const { descriptor, photo, gps } = pendingScan;
      const r = await api('/api/attendance/punch', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          lat: gps.lat,
          lng: gps.lng,
          accuracy: gps.accuracy,
          photo,
          descriptor,
          credentialId: null,
          challenge
        })
      });
      setFidUI({
        status: 'SUCCESS',
        hint: r.message || (kind === 'in' ? 'Keldim qayd etildi' : 'Ketdim qayd etildi'),
        progress: 100,
        tone: 'ok'
      });
      await new Promise((x) => setTimeout(x, 650));
      closeModal();
      msg(r.message || (kind === 'in' ? 'Keldim — vaqt boshlandi' : 'Ketdim — kun yakunlandi'), 'ok');
      uiTab = 'bugun';
      await reload();
    } catch (e) {
      if (modal) modal.classList.add('err');
      const text = e.message || 'Xato';
      setFidUI({ status: 'DENIED', hint: text, progress: 0, tone: 'err' });
      msg(text, 'err');
      showRetry(text);
    } finally {
      busy = false;
    }
  }

  async function doEnroll(isRe) {
    if (busy) return;
    busy = true;
    clearMsg();
    pendingKind = null;
    openModal('FACE ID', isRe ? 'Yuzni qayta ulash' : 'Birinchi ulash');
    flowRetry = () => doEnroll(isRe);
    try {
      setFidUI({ status: 'RUXSAT…', hint: 'Kameraga ruxsat bering', progress: 8, tone: 'load' });
      await startCam();
      try { await getGps(); } catch (e) { /* enroll uchun GPS shart emas */ }
      setFidUI({ status: 'LOADING…', hint: 'Yuz modeli…', progress: 20, tone: 'load' });
      await ensureModels();
      const scan = await scanFace({
        needSamples: 5,
        label: 'Telefonni odatdagidek ushlang — yuz oval ichida',
        timeoutMs: 28000
      });
      setFidUI({ status: 'SAVING…', hint: 'Face ID saqlanmoqda', progress: 100, tone: 'ok' });
      await api('/api/attendance/enroll', {
        method: 'POST',
        body: JSON.stringify({ photo: scan.photo, descriptor: scan.descriptor, credentialId: null })
      });
      await new Promise((r) => setTimeout(r, 500));
      closeModal();
      msg('Face ID ulandi. Endi Keldim bosing.', 'ok');
      await reload();
    } catch (e) {
      if (modal) modal.classList.add('err');
      stopCam();
      const text = e.message || 'Ulanish xato';
      setFidUI({ status: 'FAILED', hint: text, progress: 0, tone: 'err' });
      msg(text, 'err');
      showRetry(text);
    } finally {
      busy = false;
    }
  }

  function exportReportXlsx() {
    if (typeof XLSX === 'undefined') {
      msg('Excel kutubxonasi yuklanmadi', 'err');
      return;
    }
    if (!REPORT || !REPORT.people) {
      msg('Avval hisobotni yuklang', 'err');
      return;
    }
    const month = REPORT.month || reportMonth;
    const rows = [['Ism', 'Login', 'Rol', 'Mashina', 'Kelgan', 'Kechikish', 'Yo\'qlik', 'O\'rt. kelish', 'Ish (soat)']];
    (REPORT.people || []).forEach((p) => {
      rows.push([
        p.name || '',
        p.username || '',
        roleLabel(p.role),
        p.car || '',
        p.presentDays || 0,
        p.lateDays || 0,
        p.absentDays || 0,
        p.avgIn || '',
        p.worked_sec ? (p.worked_sec / 3600).toFixed(2) : ''
      ]);
    });
    const dayRows = [['Ism', 'Sana', 'Keldim', 'Ketdim', 'Kechikdi', 'Ish (daq)', 'Holat']];
    (REPORT.people || []).forEach((p) => {
      (p.days || []).forEach((d) => {
        dayRows.push([
          p.name || p.username,
          d.date,
          d.inAt || '',
          d.outAt || '',
          d.late ? 'ha' : '',
          d.worked_sec != null ? Math.round(d.worked_sec / 60) : '',
          statusLabel(d.status)
        ]);
      });
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Jamoa');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(dayRows), 'Kunlik');
    XLSX.writeFile(wb, 'davomat-' + month + '.xlsx');
    msg('Excel yuklandi', 'ok');
  }

  function exportReportPdf() {
    const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!JsPDF) {
      msg('PDF kutubxonasi yuklanmadi', 'err');
      return;
    }
    if (!REPORT || !REPORT.people) {
      msg('Avval hisobotni yuklang', 'err');
      return;
    }
    const doc = new JsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const month = REPORT.month || reportMonth;
    doc.setFontSize(14);
    doc.text('Davomat hisobot — ' + month, 40, 36);
    const body = (REPORT.people || []).map((p) => [
      p.name || p.username || '',
      roleLabel(p.role),
      String(p.presentDays || 0),
      String(p.lateDays || 0),
      String(p.absentDays || 0),
      p.avgIn || '—',
      p.worked_sec ? fmtDur(p.worked_sec) : '—'
    ]);
    if (doc.autoTable) {
      doc.autoTable({
        startY: 48,
        head: [['Ism', 'Rol', 'Kun', 'Kech', 'Yo\'q', 'O\'rt.', 'Ish']],
        body,
        styles: { fontSize: 8, cellPadding: 3 },
        headStyles: { fillColor: [11, 31, 58] }
      });
    } else {
      doc.setFontSize(10);
      body.forEach((r, i) => doc.text(r.join(' | '), 40, 56 + i * 14));
    }
    doc.save('davomat-' + month + '.pdf');
    msg('PDF yuklandi', 'ok');
  }

  function exportPersonXlsx() {
    if (typeof XLSX === 'undefined') {
      msg('Excel kutubxonasi yuklanmadi', 'err');
      return;
    }
    if (!PERSON || !PERSON.days) {
      msg('Avval xodimni tanlang', 'err');
      return;
    }
    const u = PERSON.user || {};
    const rows = [['Sana', 'Keldim', 'Ketdim', 'Kechikdi', 'Ish', 'Masofa', 'Holat']];
    (PERSON.days || []).forEach((d) => {
      if (d.status === 'future') return;
      rows.push([
        d.date,
        d.inAt || '',
        d.outAt || '',
        d.late ? 'ha' : '',
        d.worked_sec != null ? fmtDur(d.worked_sec) : '',
        d.distance_m != null ? Math.round(d.distance_m) + ' m' : '',
        statusLabel(d.status)
      ]);
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Oy');
    XLSX.writeFile(wb, 'davomat-' + (u.username || 'user') + '-' + (PERSON.month || '') + '.xlsx');
    msg('Excel yuklandi', 'ok');
  }

  function exportPersonPdf() {
    const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!JsPDF) {
      msg('PDF kutubxonasi yuklanmadi', 'err');
      return;
    }
    if (!PERSON || !PERSON.days) {
      msg('Avval xodimni tanlang', 'err');
      return;
    }
    const u = PERSON.user || {};
    const st = PERSON.stats || {};
    const doc = new JsPDF({ unit: 'pt', format: 'a4' });
    doc.setFontSize(14);
    doc.text((u.name || u.username || 'Xodim') + ' — ' + (PERSON.month || ''), 40, 40);
    doc.setFontSize(10);
    doc.text(
      'Kelgan: ' + (st.presentDays || 0) +
      ' | Kechikish: ' + (st.lateDays || 0) +
      ' | Yo\'qlik: ' + (st.absentDays || 0) +
      ' | O\'rt: ' + (st.avgIn || '—'),
      40,
      58
    );
    const body = (PERSON.days || [])
      .filter((d) => d.status !== 'future')
      .map((d) => [
        d.date,
        d.inAt || '—',
        d.outAt || '—',
        d.late ? '!' : '',
        d.worked_sec != null ? fmtDur(d.worked_sec) : '—',
        statusLabel(d.status)
      ]);
    if (doc.autoTable) {
      doc.autoTable({
        startY: 72,
        head: [['Sana', 'Keldim', 'Ketdim', 'Kech', 'Ish', 'Holat']],
        body,
        styles: { fontSize: 9 },
        headStyles: { fillColor: [26, 95, 180] }
      });
    }
    doc.save('davomat-' + (u.username || 'user') + '-' + (PERSON.month || '') + '.pdf');
    msg('PDF yuklandi', 'ok');
  }

  async function loadBoard() {
    const box = document.getElementById('att-board');
    if (!box) return;
    const date = dayInputValue(boardDate);
    boardDate = date;
    try {
      const d = await api('/api/attendance/board?date=' + encodeURIComponent(date));
      box.innerHTML = renderBoardHtml(d);
      box.querySelectorAll('[data-person]').forEach((el) => {
        bindTap(el, () => openPerson(el.getAttribute('data-person')));
      });
    } catch (e) {
      box.innerHTML = `<p class="att-hint">${esc(e.message || 'Taxta xato')}</p>`;
    }
  }

  async function loadReport(force) {
    const box = document.getElementById('att-report');
    if (!box) return;
    const month = monthInputValue(reportMonth);
    reportMonth = month;
    if (!force && REPORT && REPORT.month === month) {
      box.innerHTML = renderReportHtml(REPORT);
      box.querySelectorAll('[data-person]').forEach((el) => {
        bindTap(el, () => openPerson(el.getAttribute('data-person')));
      });
      return;
    }
    box.innerHTML = `<p class="att-hint">Yuklanmoqda…</p>`;
    try {
      const d = await api('/api/attendance/report?month=' + encodeURIComponent(month));
      REPORT = d;
      box.innerHTML = renderReportHtml(d);
      box.querySelectorAll('[data-person]').forEach((el) => {
        bindTap(el, () => openPerson(el.getAttribute('data-person')));
      });
    } catch (e) {
      box.innerHTML = `<p class="att-hint">${esc(e.message || 'Hisobot xato')}</p>`;
    }
  }

  async function fillPersonSelect() {
    const sel = document.getElementById('person-select');
    if (!sel) return;
    try {
      let people = (REPORT && REPORT.people) || null;
      if (!people) {
        const month = monthInputValue(personMonth || reportMonth);
        const d = await api('/api/attendance/report?month=' + encodeURIComponent(month));
        REPORT = d;
        people = d.people || [];
      }
      const cur = personId || '';
      sel.innerHTML = `<option value="">— tanlang —</option>` + people.map((p) =>
        `<option value="${esc(p.userId)}" ${p.userId === cur ? 'selected' : ''}>${esc(p.name || p.username)}${p.car ? ' · ' + esc(p.car) : ''}</option>`
      ).join('');
      if (cur) sel.value = cur;
    } catch (e) {
      sel.innerHTML = `<option value="">Xato: ${esc(e.message || '')}</option>`;
    }
  }

  async function loadPersonPanel() {
    await fillPersonSelect();
    if (personId) await loadPerson(false);
    else {
      const box = document.getElementById('att-person');
      if (box) box.innerHTML = `<p class="att-hint">Xodimni tanlang — kunlik kelish/ketish va oylik statistika.</p>`;
    }
  }

  async function loadPerson(force) {
    const box = document.getElementById('att-person');
    if (!box) return;
    if (!personId) {
      box.innerHTML = `<p class="att-hint">Xodimni tanlang</p>`;
      return;
    }
    const month = monthInputValue(personMonth);
    personMonth = month;
    if (!force && PERSON && PERSON.month === month && PERSON.user && PERSON.user.userId === personId) {
      box.innerHTML = renderPersonHtml(PERSON);
      return;
    }
    box.innerHTML = `<p class="att-hint">Yuklanmoqda…</p>`;
    try {
      const d = await api(
        '/api/attendance/person?userId=' + encodeURIComponent(personId) +
        '&month=' + encodeURIComponent(month)
      );
      PERSON = d;
      box.innerHTML = renderPersonHtml(d);
    } catch (e) {
      box.innerHTML = `<p class="att-hint">${esc(e.message || 'Xodim hisoboti xato')}</p>`;
    }
  }

  function renderSettings() {
    const box = document.getElementById('att-settings');
    if (!box || !STATE) return;
    api('/api/attendance/settings').then((d) => {
      const s = d.settings || {};
      const o = s.office || {};
      box.innerHTML = `
        <div class="row2">
          <div class="fld"><label>Keldim (ochiladi)</label><input id="s-in-start" value="${esc(s.in_start || '')}"></div>
          <div class="fld"><label>Kechikish dan</label><input id="s-late" value="${esc(s.in_late_after || '')}"></div>
        </div>
        <div class="row2">
          <div class="fld"><label>Ketdim (tavsiya)</label><input id="s-out-start" value="${esc(s.out_start || '')}"></div>
          <div class="fld"><label>Kun yopiladi</label><input id="s-out-end" value="${esc(s.out_end || '')}"></div>
        </div>
        <div class="row2">
          <div class="fld"><label>Ofis lat</label><input id="s-lat" value="${esc(o.lat || '')}"></div>
          <div class="fld"><label>Ofis lng</label><input id="s-lng" value="${esc(o.lng || '')}"></div>
        </div>
        <div class="row2">
          <div class="fld"><label>Radius (m)</label><input id="s-radius" type="number" value="${esc(o.radius_m || 250)}"></div>
          <div class="fld"><label>Ofis nomi</label><input id="s-label" value="${esc(o.label || '')}"></div>
        </div>
        <button type="button" class="att-btn att-btn-in" id="btn-save-set" style="margin-top:8px">Saqlash</button>
        <button type="button" class="att-btn att-btn-face" id="btn-here" style="margin-top:8px">Hozirgi joyimni ofis qil</button>
      `;
      document.getElementById('btn-save-set').onclick = saveSettings;
      document.getElementById('btn-here').onclick = async () => {
        try {
          const g = await getGps();
          document.getElementById('s-lat').value = String(g.lat);
          document.getElementById('s-lng').value = String(g.lng);
          msg('Lat/lng yozildi — Saqlash bosing', 'info');
        } catch (e) { msg(e.message, 'err'); }
      };
    }).catch((e) => {
      box.innerHTML = `<p class="att-hint">${esc(e.message)}</p>`;
    });
  }

  async function saveSettings() {
    try {
      const body = {
        in_start: document.getElementById('s-in-start').value,
        in_late_after: document.getElementById('s-late').value,
        out_start: document.getElementById('s-out-start').value,
        out_end: document.getElementById('s-out-end').value,
        office: {
          lat: document.getElementById('s-lat').value,
          lng: document.getElementById('s-lng').value,
          radius_m: document.getElementById('s-radius').value,
          label: document.getElementById('s-label').value
        }
      };
      await api('/api/attendance/settings', { method: 'POST', body: JSON.stringify(body) });
      msg('Sozlamalar saqlandi', 'ok');
      await reload();
    } catch (e) {
      msg(e.message || 'Saqlash xato', 'err');
    }
  }

  async function reload() {
    STATE = await api('/api/attendance/me');
    window._vmFaceEnrolled = !!STATE.enrolled;
    if (typeof vmEnsureDavomatNav === 'function') vmEnsureDavomatNav();
    render();
  }

  if (btnKeldim) bindTap(btnKeldim, () => confirmPunch('in'));
  if (btnKetdim) bindTap(btnKetdim, () => confirmPunch('out'));
  if (btnRetry) {
    bindTap(btnRetry, () => {
      hideRetry();
      if (typeof flowRetry === 'function') flowRetry();
    });
  }
  if (btnCancel) {
    bindTap(btnCancel, () => {
      if (abortScan) abortScan();
      closeModal();
      busy = false;
    });
  }

  const closeBtn = document.getElementById('fid-close');
  if (closeBtn) {
    bindTap(closeBtn, () => {
      if (abortScan) abortScan();
      closeModal();
      busy = false;
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOpen) {
      if (abortScan) abortScan();
      closeModal();
      busy = false;
    }
  });

  async function probeGeoOnBoot() {
    if (!STATE || !STATE.enrolled) return;
    const perm = await readGeoPermission();
    // Faqat aniq "denied" bo'lsa yo'riqnoma — aks holda har ochilishda prompt chiqmasin
    if (perm === 'denied') {
      showGeoHelp('Joylashuv bloklangan. Pastdagi qadamlarni bajaring, keyin «Joylashuvni tekshirish».');
    }
  }

  async function boot() {
    try {
      const user = await vmMe();
      if (typeof vmApplyChrome === 'function') vmApplyChrome(user);
      else {
        vmApplyRoleNav(user);
        const name = document.getElementById('tb-user-name');
        if (name) name.textContent = user.name || user.username || '—';
      }
      vmGatePage(user);
      await reload();
      ensureModels().catch(() => {});
      // Mobil: joylashuv bloklangan bo'lsa darhol yo'riqnoma + Tekshirish tugmasi
      probeGeoOnBoot();
    } catch (e) {
      app.innerHTML = `<p class="att-loading">${esc(e.message || 'Xato')}</p>`;
    }
  }

  boot();
})();
