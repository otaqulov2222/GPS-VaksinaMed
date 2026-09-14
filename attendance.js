'use strict';
/**
 * VaksinaMed Davomat — Ofis QR + geozona → Keldim/Ketdim
 */
(function () {
  const app = document.getElementById('att-app');
  if (!app) return;

  const QR_LIB = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js';
  const QR_LIB_FALLBACK = 'https://unpkg.com/qrcode@1.5.1/build/qrcode.min.js';
  const QR_LIB_JS = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  const HTML5_QR = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';
  let officeQrMeta = null;


  let STATE = null;
  let busy = false;
  let stream = null;
  let scanLoop = null;
  let modalOpen = false;
  let abortScan = null;
  let pendingScan = null;
  let qrTicketLocal = null; // { ticket, exp, expiresInSec }
  let html5Qr = null;
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
  let attMapFitted = false;
  let geoLive = { inside: null, dist: null, accuracy: null, lat: null, lng: null, err: null, status: 'idle' };
  let attMethod = 'qr';

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
  let pendingKind = null;
  let flowRetry = null;

  function activeQrTicket() {
    const t = qrTicketLocal || (STATE && STATE.qrTicket) || null;
    if (!t || !t.ticket) return null;
    if (t.expiresInSec != null && Number(t.expiresInSec) <= 0) return null;
    if (t.exp) {
      try {
        if (Date.now() > new Date(t.exp).getTime()) return null;
      } catch (e) { /* ignore */ }
    }
    return t;
  }

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
    // DD.MM.YYYY — locale (M09 / Fri) emas, raqamli sana
    if (iso && /^\d{4}-\d{2}-\d{2}/.test(String(iso))) {
      const p = String(iso).slice(0, 10).split('-');
      return p[2] + '.' + p[1] + '.' + p[0];
    }
    try {
      const d = iso ? new Date(iso) : new Date();
      if (Number.isNaN(d.getTime())) return iso || '';
      const pad = (n) => String(n).padStart(2, '0');
      return pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear();
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
      const work2 = document.getElementById('att-dayline-work');
      const dur = fmtDur(dayWorkedSec(STATE && STATE.today) || 0);
      if (work && STATE && STATE.today && STATE.today.in && !STATE.today.out) {
        work.textContent = dur;
      }
      if (work2 && STATE && STATE.today && STATE.today.in && !STATE.today.out) {
        work2.textContent = dur;
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
    const ticketOk = !!activeQrTicket();
    const done = !!(today.in && today.out);
    const canIn = !today.in && !done;
    const canOut = !!today.in && !today.out;
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
        if (ticketOk) {
          gate.className = 'av-gate-banner on ok';
          gate.textContent = 'Ofis QR tasdiqlandi — endi Keldim / Ketdim bosing.';
        } else {
          gate.className = 'av-gate-banner';
          gate.textContent = '';
        }
      } else if (geoLive.status === 'out') {
        gate.className = 'av-gate-banner on';
        gate.textContent = 'Davomat faqat ofis radiusida. Hozir ~' + Math.round(geoLive.dist || 0) + ' m uzoqdasiz — ofis zonasiga kiring.';
      } else if (geoLive.status === 'err') {
        gate.className = 'av-gate-banner on';
        gate.textContent = geoLive.err || 'Joylashuvni yoqing — ofisga kirganingizda tugmalar ochiladi.';
      } else {
        gate.className = 'av-gate-banner on';
        gate.textContent = 'Joylashuv tekshirilmoqda…';
      }
    }

    const lockPunch = (btn, allow) => {
      if (!btn) return;
      const shouldEnable = allow && inside && ticketOk;
      btn.disabled = !shouldEnable;
      btn.classList.toggle('is-locked', !(inside && ticketOk) && allow);
    };
    lockPunch(inBtn, canIn);
    lockPunch(outBtn, canOut);

    const pill = document.getElementById('av-qr-pill');
    if (pill) {
      pill.classList.toggle('on', ticketOk);
      pill.textContent = ticketOk ? 'QR faol' : 'QR kutilyapti';
    }
    const hint = document.getElementById('av-qr-ticket-hint');
    if (hint) {
      hint.textContent = ticketOk
        ? 'QR ruxsati faol (~10 daq). Endi Keldim yoki Ketdim bosing.'
        : 'QR hali skanerlanmagan.';
    }
    const steps = document.getElementById('av-steps');
    if (steps) {
      const geo = steps.querySelector('[data-step="geo"]');
      const qr = steps.querySelector('[data-step="qr"]');
      const punch = steps.querySelector('[data-step="punch"]');
      const setSt = (el, st) => {
        if (!el) return;
        el.classList.remove('wait', 'now', 'done');
        el.classList.add(st);
      };
      setSt(geo, inside ? 'done' : (geoLive.status === 'err' || geoLive.status === 'out' ? 'now' : 'wait'));
      setSt(qr, ticketOk ? 'done' : (inside ? 'now' : 'wait'));
      setSt(punch, done ? 'done' : (ticketOk ? 'now' : 'wait'));
    }

    if (goBtn) {
      const nextKind = !today.in ? 'in' : (today.in && !today.out ? 'out' : null);
      goBtn.disabled = done || !inside || !nextKind;
      goBtn.setAttribute('data-next', nextKind || '');
      goBtn.setAttribute('data-action', ticketOk ? 'punch' : 'scan');
      const lab = goBtn.querySelector('span');
      const sub = goBtn.querySelector('small');
      if (lab) {
        if (done) lab.textContent = 'Bugun yakunlangan';
        else if (!inside) lab.textContent = 'Ofisga keling';
        else if (!ticketOk) lab.textContent = 'Ofis QR skanerlash';
        else lab.textContent = nextKind === 'out' ? 'Ketdimni tasdiqlash' : 'Keldimni tasdiqlash';
      }
      if (sub) {
        sub.textContent = !inside
          ? (off.label + ' · ' + off.radius + ' m')
          : (!ticketOk
            ? 'Devordagi ofis QR ni skanerlang'
            : (nextKind === 'out' ? 'QR tasdiqlandi — Ketdim' : 'QR tasdiqlandi — Keldim'));
      }
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
        color: '#15803d',
        fillColor: '#22c55e',
        fillOpacity: 0.14,
        weight: 2.5,
        dashArray: null
      });
    } else if (inside === false) {
      attMapCircle.setStyle({
        color: '#dc2626',
        fillColor: '#f87171',
        fillOpacity: 0.1,
        weight: 2.5,
        dashArray: '7 6'
      });
    } else {
      attMapCircle.setStyle({
        color: '#1a5fb4',
        fillColor: '#3b82f6',
        fillOpacity: 0.12,
        weight: 2.5,
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
      fillOpacity: 0.12,
      weight: 2.5,
      interactive: false
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
    const youKind = inside ? 'you' : 'you-out';
    const youLabel = inside ? 'Siz (ichida)' : 'Siz (tashqarida)';
    styleZoneCircle(geoLive.inside);

    if (!attMapUser) {
      attMapUser = L.marker([lat, lng], {
        icon: pinIcon(youLabel, youKind),
        zIndexOffset: 400
      }).addTo(attMap).bindTooltip(youLabel, { direction: 'top', offset: [0, -8], opacity: 0.95 });
    } else {
      attMapUser.setLatLng([lat, lng]);
      attMapUser.setIcon(pinIcon(youLabel, youKind));
      try { attMapUser.setTooltipContent(youLabel); } catch (e) {}
    }

    try {
      const off = officeInfo();
      const b = L.latLngBounds([
        [off.lat, off.lng],
        [lat, lng]
      ]);
      if (attMapCircle) b.extend(attMapCircle.getBounds());
      if (!attMapFitted) {
        attMap.fitBounds(b.pad(0.18));
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
    return loadScriptOnce(src);
  }

  async function ensureModels() {
    return;
  }

  const MODEL_URL = '';
  const FACE_API_SRC = '';
  let modelsReady = true;
  let modelsLoading = null;

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
    stopQrScanner().catch(() => {});
    stopCam();
    pendingScan = null;
    pendingKind = null;
    flowRetry = null;
    hideFidActions();
    hideRetry();
    const holder = document.getElementById('qr-reader');
    if (holder) holder.remove();
    if (video) video.style.display = '';
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
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    video.style.display = '';
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
    // Server Toshkent ISO: to‘liq HH:MM:SS (browsер TZ chalkashmasin)
    const m = String(iso).match(/(?:T|\s)(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) return m[1] + ':' + m[2] + ':' + (m[3] || '00');
    try {
      const ms = parseTs(iso);
      if (Number.isNaN(ms)) return '—';
      const d = new Date(ms);
      const p = (n) => String(n).padStart(2, '0');
      return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    } catch (e) { return '—'; }
  }

  function punchTime(p) {
    if (!p) return '—';
    if (p.atDisplay) return p.atDisplay;
    return fmtTime(p.at);
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
      const el2 = document.getElementById('att-dayline-work');
      if (!el && !el2) return;
      const sec = Math.max(0, Math.floor((Date.now() - t0) / 1000));
      const txt = fmtDur(sec);
      if (el) el.textContent = txt;
      if (el2) el2.textContent = txt;
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

  function weekStripHtml(history, todayIso) {
    const days = [];
    const base = todayIso && /^\d{4}-\d{2}-\d{2}/.test(String(todayIso))
      ? String(todayIso).slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const [yy, mm, dd] = base.split('-').map(Number);
    const anchor = new Date(yy, mm - 1, dd);
    const map = {};
    (history || []).forEach((r) => {
      if (r && r.date) map[r.date] = r;
    });
    for (let i = 6; i >= 0; i--) {
      const d = new Date(anchor);
      d.setDate(anchor.getDate() - i);
      const iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      const rec = map[iso];
      let tone = 'empty';
      if (rec) {
        if (rec.status === 'done' || (rec.in && rec.out)) tone = 'done';
        else if (rec.late || (rec.in && rec.in.late)) tone = 'late';
        else if (rec.in) tone = 'in';
        else if (rec.status === 'absent') tone = 'absent';
      }
      const isToday = iso === base;
      days.push(
        `<div class="av-week-day ${tone}${isToday ? ' today' : ''}" title="${esc(fmtDate(iso))}">` +
        `<span class="wd">${['Ya','Du','Se','Ch','Pa','Ju','Sh'][d.getDay()]}</span>` +
        `<span class="dn">${d.getDate()}</span>` +
        `<i></i></div>`
      );
    }
    return days.join('');
  }

  function monthPulseFromHistory(history) {
    let present = 0;
    let late = 0;
    let full = 0;
    (history || []).forEach((r) => {
      if (!r) return;
      if (r.in) present += 1;
      if (r.late || (r.in && r.in.late)) late += 1;
      if (r.in && r.out) full += 1;
    });
    return { present, late, full, days: (history || []).length };
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
        ${kpiCard('QR', c.enrolled || 0)}
      </div>
      <div class="scroll-x">
      <table class="att-table">
        <thead><tr><th>Ism</th><th>Rol</th><th>Mashina</th><th>Holat</th><th>Keldim</th><th>Ketdim</th><th>Ish</th><th></th></tr></thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td><b>${esc(r.name || r.username)}</b><div class="att-sub">@${esc(r.username || '')}</div></td>
              <td>${esc(roleLabel(r.role))}</td>
              <td class="mono">${esc(r.car || '—')}</td>
              <td><span class="att-badge ${esc(r.status)}">${esc(statusLabel(r.status))}</span></td>
              <td class="mono">${r.in ? punchTime(r.in) + (r.in.late ? ' · kech' : '') : '—'}</td>
              <td class="mono">${r.out ? punchTime(r.out) : '—'}</td>
              <td class="mono">${r.worked_sec != null ? fmtDur(r.worked_sec) : (r.in && !r.out ? '…' : '—')}</td>
              <td><button type="button" class="att-link-btn" data-person="${esc(r.userId)}">Oy</button></td>
            </tr>`).join('') || '<tr><td colspan="8">Bo‘sh</td></tr>'}
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
        ${kpiCard('QR tayyor', s.enrolled || 0, 'ok')}
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
                <div class="att-sub">${esc(roleLabel(p.role))}${p.car ? ' · ' + esc(p.car) : ''}</div>
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
          <div class="att-sub">@${esc(u.username || '')} · ${esc(roleLabel(u.role))}${u.car ? ' · ' + esc(u.car) : ''}</div>
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

    const ticketOk = !!activeQrTicket();
    const stepGeo = geoLive.inside === true ? 'done' : (geoLive.status === 'err' || geoLive.status === 'out' ? 'now' : 'wait');
    const stepQr = ticketOk ? 'done' : (geoLive.inside === true ? 'now' : 'wait');
    const stepPunch = done ? 'done' : (ticketOk ? 'now' : 'wait');
    const dayStatus = done ? 'Yakunlangan' : (working ? 'Ishda' : (inn ? 'Kelgan' : 'Kutilmoqda'));
    const pulse = monthPulseFromHistory(history);
    const nextAction = done ? 'Bugun yakunlandi' : (!geoLive.inside ? 'Ofis zonasiga boring' : (!ticketOk ? 'Ofis QR skanerlang' : (!inn ? 'Keldimni bosing' : 'Ketdimni bosing')));

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
        <div class="av-studio av-pro">

          <section class="av-stage">
            <div class="av-stage-main">
              <div class="av-stage-mark">VAKSINA · DAVOMAT</div>
              <h2 class="av-stage-title">Kunni <em>aniq</em><br>belgilang</h2>
              <p class="av-stage-lead">Ofis zonasi + QR skan + Keldi/Ketdi. Brauzer orqali professional nazorat.</p>
              <div class="av-stage-who">
                <div class="who-name">${esc(uname)}</div>
                <div class="who-meta">${esc(userRoleLabel())} · ${esc(off.label)}</div>
              </div>
              <div class="av-stage-pills">
                <span class="av-status-chip ${done ? 'ok' : (working ? 'live' : 'idle')}">${esc(dayStatus)}</span>
                <span class="av-date-pill">${esc(fmtDateLong(s.today))}</span>
              </div>
            </div>
            <div class="av-stage-clock">
              <div class="ring ${working ? 'live' : ''}" aria-hidden="true"></div>
              <div class="clock-box">
                <div class="k">Hozir</div>
                <div class="v" id="av-now-clock">--:--:--</div>
                <div class="s">${esc(s.in_start || '09:00')}–${esc(s.out_start || '18:00')}</div>
              </div>
              <div class="work-box ${working ? 'live' : (done ? 'done' : '')}">
                <div class="k">${working ? 'Ishlayapti' : (done ? 'Yopildi' : 'Ish vaqti')}</div>
                <div class="v" id="att-live-timer">${fmtDur(dayWorkedSec(today) || 0)}</div>
                <div class="s">${esc(nextAction)}</div>
              </div>
            </div>
          </section>

          <section class="av-pulse-row">
            <div class="av-pulse-card">
              <div class="k">Oxirgi 45 kun</div>
              <div class="v">${pulse.present}</div>
              <div class="s">Kelgan kunlar</div>
            </div>
            <div class="av-pulse-card warn">
              <div class="k">Kechikish</div>
              <div class="v">${pulse.late}</div>
              <div class="s">Belgilangan</div>
            </div>
            <div class="av-pulse-card ok">
              <div class="k">To‘liq kun</div>
              <div class="v">${pulse.full}</div>
              <div class="s">Keldi + Ketdi</div>
            </div>
            <div class="av-pulse-card navy">
              <div class="k">Keyingi qadam</div>
              <div class="v-sm">${esc(nextAction)}</div>
              <div class="s">Tizim yo‘riqnomasi</div>
            </div>
          </section>

          <section class="av-week-card">
            <div class="av-week-h">
              <div>
                <h3>Haftalik ritm</h3>
                <p>Oxirgi 7 kun — yashil to‘liq, sariq kechikish, ko‘k ishda</p>
              </div>
            </div>
            <div class="av-week-strip">${weekStripHtml(history, s.today)}</div>
          </section>

          <ol class="av-steps" id="av-steps" aria-label="Davomat qadamlari">
            <li class="av-step ${stepGeo}" data-step="geo"><span class="n">01</span><div><b>Geozona</b><small>${esc(String(off.radius))} m ichida</small></div></li>
            <li class="av-step ${stepQr}" data-step="qr"><span class="n">02</span><div><b>Ofis QR</b><small>Devordagi kod</small></div></li>
            <li class="av-step ${stepPunch}" data-step="punch"><span class="n">03</span><div><b>Stamp</b><small>Keldi / Ketdi</small></div></li>
          </ol>

          <div class="av-journey">
            <div class="av-journey-track">
              <div class="node ${inn ? 'on' : 'wait'}">
                <span class="dot"></span>
                <div class="lab">Keldi</div>
                <div class="val mono">${inn ? punchTime(inn) : '—'}</div>
                <div class="meta">${inn ? (inn.late ? 'Kechikdi' : 'O‘z vaqtida') : 'Reja ' + esc(s.in_start || '09:00')}</div>
              </div>
              <div class="rail ${working || done ? 'on' : ''}"></div>
              <div class="node focus">
                <span class="dot"></span>
                <div class="lab">Ish</div>
                <div class="val mono" id="att-dayline-work">${fmtDur(dayWorkedSec(today) || 0)}</div>
                <div class="meta">${done ? 'Kun yopiq' : (working ? 'Davom etmoqda' : 'Boshlanmagan')}</div>
              </div>
              <div class="rail ${done ? 'on' : ''}"></div>
              <div class="node ${out ? 'on' : 'wait'}">
                <span class="dot"></span>
                <div class="lab">Ketdi</div>
                <div class="val mono">${out ? punchTime(out) : '—'}</div>
                <div class="meta">${out ? 'Qayd etildi' : 'Reja ' + esc(s.out_start || '18:00')}</div>
              </div>
            </div>
          </div>

          <div class="av-gate-banner" id="av-gate-banner">Joylashuv tekshirilmoqda…</div>

          <div class="av-workbench av-workbench-pro">
            <section class="av-map-card">
              <div class="av-map-h">
                <div>
                  <div class="av-map-kicker">Live geofence</div>
                  <h3>${esc(off.label)}</h3>
                  <div class="av-map-sub">Faqat yashil doira ichida skan va stamp ochiladi</div>
                </div>
                <span class="av-geo-badge load" id="av-geo-badge">Joylashuv…</span>
              </div>
              <div class="av-map-wrap">
                <div class="av-map" id="av-map"></div>
                <div class="av-map-legend">
                  <span><i class="lg-office"></i> Ofis</span>
                  <span><i class="lg-zone"></i> ${esc(String(off.radius))} m</span>
                  <span><i class="lg-you"></i> Siz</span>
                </div>
              </div>
              <div class="av-map-foot">
                <span id="av-geo-dist">Radius <b>${esc(String(off.radius))}</b> m</span>
                <button type="button" class="att-btn att-btn-face" id="btn-geo-check">Qayta tekshirish</button>
              </div>
            </section>

            <div class="av-side">
              <section class="av-punch-card av-punch-card-pro">
                <div class="av-punch-card-h">
                  <span>Stamp paneli</span>
                  <span class="av-qr-pill ${ticketOk ? 'on' : ''}" id="av-qr-pill">${ticketOk ? 'QR faol' : 'QR kutilyapti'}</span>
                </div>
                <p class="av-punch-hint">Zona → QR → Keldi/Ketdi. Har bir Ketdi uchun qayta skan talab qilinadi.</p>
                <div class="av-punch-row">
                  <button type="button" class="av-punch av-punch-in is-locked" id="btn-keldim-main" ${inn || done ? 'disabled' : ''}>
                    <span class="ico">IN</span>
                    <div class="tag">Keldi</div>
                    <div class="time">${inn ? punchTime(inn) : '—'}</div>
                    <div class="plan">Rejada ${esc(s.in_start || '09:00')}${inn && inn.late ? ' · kechikdi' : (inn ? ' · o‘z vaqtida' : '')}</div>
                  </button>
                  <button type="button" class="av-punch av-punch-out is-locked" id="btn-ketdim-main" ${(!inn || out || done) ? 'disabled' : ''}>
                    <span class="ico">OUT</span>
                    <div class="tag">Ketdi</div>
                    <div class="time">${out ? punchTime(out) : '—'}</div>
                    <div class="plan">Rejada ${esc(s.out_start || '18:00')}</div>
                  </button>
                </div>
                <button type="button" class="av-continue" id="av-continue" disabled>
                  <span>Ofisga keling</span>
                  <small>Zona ichida QR skanerlash</small>
                </button>
                <p class="av-ticket-hint" id="av-qr-ticket-hint">${ticketOk ? 'QR ruxsati faol (~10 daq). Endi Keldim yoki Ketdim.' : 'QR hali skanerlanmagan.'}</p>
              </section>

              <section class="av-howto">
                <h3>Qanday ishlaydi</h3>
                <ul>
                  <li><b>1.</b> Ofis ${esc(String(off.radius))} m ichiga kiring</li>
                  <li><b>2.</b> Devordagi ofis QR ni skanerlang</li>
                  <li><b>3.</b> Keldim / Ketdim ni bosing</li>
                </ul>
                <div class="av-howto-note">${esc(s.scheduleNote || '')}</div>
              </section>
            </div>
          </div>

          <div class="att-msg" id="att-msg"></div>
          <div class="att-geo-box" id="att-geo-box" hidden>
            <div class="att-geo-title">Joylashuv kerak</div>
            <p class="att-geo-text" id="att-geo-text"></p>
            <ol class="att-geo-steps" id="att-geo-steps"></ol>
            <button type="button" class="att-btn att-btn-in" id="btn-geo-check-2">Joylashuvni tekshirish</button>
          </div>

          <section class="av-hist av-hist-pro">
            <div class="av-hist-h">
              <div>
                <h3>Soʻnggi yozuvlar</h3>
                <p class="av-hist-sub">Shaxsiy stamp jurnal</p>
              </div>
            </div>
            <div class="av-hist-b">
              ${history.length ? `
                <div class="scroll-x">
                <table class="att-table">
                  <thead><tr><th>Sana</th><th>Keldim</th><th>Ketdim</th><th>Ish vaqti</th><th>Holat</th></tr></thead>
                  <tbody>
                    ${history.slice(0, 10).map((r) => `
                      <tr>
                        <td>${fmtDate(r.date)}</td>
                        <td class="mono">${r.in ? punchTime(r.in) + (r.late || (r.in && r.in.late) ? ' · kech' : '') : '—'}</td>
                        <td class="mono">${r.out ? punchTime(r.out) : '—'}</td>
                        <td class="mono">${r.worked_sec != null ? fmtDur(r.worked_sec) : (r.in && !r.out ? '…' : '—')}</td>
                        <td><span class="att-badge ${esc(r.status)}">${esc(statusLabel(r.status))}</span></td>
                      </tr>`).join('')}
                  </tbody>
                </table></div>
              ` : `<div class="av-empty">Hali yozuv yoʻq. Ofisda QR skanerlab birinchi stampni qoʻying.</div>`}
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
                      <td class="mono">${r.in ? punchTime(r.in) + (r.late || (r.in && r.in.late) ? ' · kech' : '') : '—'}</td>
                      <td class="mono">${r.out ? punchTime(r.out) : '—'}</td>
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

    if (enroll) enroll.remove();
    if (re) re.remove();
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
    if (kIn) bindTap(kIn, () => confirmPunch('in'));
    if (kOut) bindTap(kOut, () => confirmPunch('out'));
    const geoBtn = document.getElementById('btn-geo-check');
    if (geoBtn) bindTap(geoBtn, () => {
      hideGeoHelp();
      startGeoWatch();
    });
    const geoBtn2 = document.getElementById('btn-geo-check-2');
    if (geoBtn2) bindTap(geoBtn2, () => checkGeoNow());

    const cont = document.getElementById('av-continue');
    if (cont) bindTap(cont, () => {
      const action = cont.getAttribute('data-action') || 'scan';
      const kind = cont.getAttribute('data-next') || (!((STATE.today || {}).in) ? 'in' : 'out');
      if (action === 'punch' && activeQrTicket()) confirmPunch(kind);
      else startQrScanFlow();
    });

    app.querySelectorAll('[data-person]').forEach((el) => {
      bindTap(el, () => openPerson(el.getAttribute('data-person')));
    });
  }

  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      const prev = document.querySelector('script[data-src="' + src + '"]');
      if (prev && prev.getAttribute('data-ready') === '1') {
        resolve();
        return;
      }
      if (prev) {
        prev.addEventListener('load', () => resolve());
        prev.addEventListener('error', () => reject(new Error('Skript yuklanmadi')));
        return;
      }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-src', src);
      s.onload = () => { s.setAttribute('data-ready', '1'); resolve(); };
      s.onerror = () => reject(new Error('Skript yuklanmadi: ' + src));
      document.head.appendChild(s);
    });
  }

  async function stopQrScanner() {
    abortScan = null;
    if (html5Qr) {
      try { await html5Qr.stop(); } catch (e) { /* ignore */ }
      try { await html5Qr.clear(); } catch (e) { /* ignore */ }
      html5Qr = null;
    }
    if (scanLoop) {
      cancelAnimationFrame(scanLoop);
      scanLoop = null;
    }
    stopCam();
  }

  async function startQrScanFlow() {
    if (busy) return;
    if (geoLive.inside !== true) {
      msg('Faqat ofis radiusida QR skanerlash mumkin', 'err');
      startGeoWatch();
      return;
    }
    busy = true;
    clearMsg();
    openModal('OFIS QR', 'Devordagi ofis QR kodini ramkaga tuting');
    flowRetry = () => startQrScanFlow();
    try {
      setFidUI({ status: 'JOYLASHUV…', hint: 'Joylashuv tekshirilmoqda', progress: 10, tone: 'load' });
      const gps = await getGps();
      setFidUI({ status: 'KAMERA…', hint: 'Kameraga ruxsat bering', progress: 25, tone: 'load' });
      const payload = await scanOfficeQrPayload();
      setFidUI({ status: 'TEKSHIRUV…', hint: 'Ofis QR tasdiqlanmoqda', progress: 80, tone: 'load' });
      const r = await api('/api/attendance/qr/verify', {
        method: 'POST',
        body: JSON.stringify({
          payload,
          lat: gps.lat,
          lng: gps.lng,
          accuracy: gps.accuracy
        })
      });
      qrTicketLocal = {
        ticket: r.qrTicket,
        exp: r.exp,
        expiresInSec: r.expiresInSec
      };
      if (STATE) STATE.qrTicket = qrTicketLocal;
      await stopQrScanner();
      setFidUI({
        status: 'SUCCESS',
        hint: r.message || 'Ofis QR tasdiqlandi — endi Keldim / Ketdim',
        progress: 100,
        tone: 'ok'
      });
      await new Promise((x) => setTimeout(x, 700));
      closeModal();
      msg(r.message || 'QR tasdiqlandi', 'ok');
      paintGeoUI();
    } catch (e) {
      await stopQrScanner();
      const text = e.message || 'QR xato';
      if (modal) { modal.classList.add('err'); modal.classList.remove('ok', 'scanning'); }
      setFidUI({ status: 'FAILED', hint: text, progress: 0, tone: 'err' });
      msg(text, 'err');
      showRetry(text);
    } finally {
      busy = false;
    }
  }

  function scanOfficeQrPayload() {
    return new Promise(async (resolve, reject) => {
      let settled = false;
      const done = (err, val) => {
        if (settled) return;
        settled = true;
        abortScan = null;
        if (err) reject(err);
        else resolve(val);
      };
      abortScan = () => done(new Error('Bekor qilindi'));

      const accept = (raw) => {
        const text = String(raw || '').trim();
        if (!text) return;
        if (!/VMATT1\.\d+\./.test(text)) {
          setFidUI({ status: 'QR…', hint: 'Bu ofis QR emas — to‘g‘ri kodni tuting', progress: 40, tone: 'warn' });
          return;
        }
        done(null, text);
      };

      try {
        if (window.BarcodeDetector) {
          await startCam();
          if (modal) modal.classList.add('scanning');
          setFidUI({ status: 'SCANNING…', hint: 'Ofis QR ni ramkaga tuting', progress: 40, tone: 'scan' });
          const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
          const tick = async () => {
            if (settled) return;
            try {
              if (video && video.readyState >= 2) {
                const codes = await detector.detect(video);
                if (codes && codes[0] && codes[0].rawValue) {
                  accept(codes[0].rawValue);
                  return;
                }
              }
            } catch (e) { /* keep scanning */ }
            scanLoop = requestAnimationFrame(() => { setTimeout(tick, 120); });
          };
          tick();
          return;
        }

        await loadScriptOnce(HTML5_QR);
        if (!window.Html5Qrcode) throw new Error('QR skaner yuklanmadi');
        const vp = document.getElementById('fid-viewport');
        let holder = document.getElementById('qr-reader');
        if (!holder && vp) {
          holder = document.createElement('div');
          holder.id = 'qr-reader';
          holder.style.cssText = 'position:absolute;inset:0;z-index:5;overflow:hidden';
          vp.appendChild(holder);
        }
        if (video) video.style.display = 'none';
        if (modal) modal.classList.add('scanning');
        setFidUI({ status: 'SCANNING…', hint: 'Ofis QR ni ramkaga tuting', progress: 40, tone: 'scan' });
        html5Qr = new window.Html5Qrcode('qr-reader');
        await html5Qr.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 240, height: 240 } },
          (decoded) => accept(decoded),
          () => {}
        );
      } catch (e) {
        done(e);
      }
    });
  }

  /** QR ticket bor → Keldim/Ketdim */
  async function startAttendanceFlow(kind) {
    if (!activeQrTicket()) {
      await startQrScanFlow();
      return;
    }
    await confirmPunch(kind);
  }

  async function confirmPunch(kind) {
    const ticket = activeQrTicket();
    if (!ticket) {
      msg('Avval ofis QR ni skanerlang', 'err');
      return;
    }
    if (geoLive.inside !== true) {
      msg('Faqat ofis radiusida ochiladi', 'err');
      return;
    }
    busy = true;
    clearMsg();
    hideFidActions();
    hideRetry();
    try {
      setFidUI({
        status: kind === 'in' ? 'KELDIM…' : 'KETDIM…',
        hint: 'Yozilmoqda…',
        progress: 90,
        tone: 'ok'
      });
      if (!modalOpen) openModal(kind === 'in' ? 'KELDIM' : 'KETDIM', 'Davomat yozilmoqda');
      const gps = await getGps();
      const r = await api('/api/attendance/punch', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          lat: gps.lat,
          lng: gps.lng,
          accuracy: gps.accuracy,
          qrTicket: ticket.ticket
        })
      });
      qrTicketLocal = null;
      if (STATE) STATE.qrTicket = null;
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
      if (/QR|skaner|ruxsat/i.test(text)) {
        qrTicketLocal = null;
        if (STATE) STATE.qrTicket = null;
      }
      showRetry(text);
      flowRetry = () => {
        if (/QR|skaner|ruxsat/i.test(text)) startQrScanFlow();
        else confirmPunch(kind);
      };
    } finally {
      busy = false;
    }
  }

  async function doEnroll() {
    msg('Face ID o‘chirilgan. Ofis QR dan foydalaning.', 'info');
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
    box.innerHTML = `<p class="att-hint">Ofis QR yuklanmoqda…</p>`;
    Promise.all([
      api('/api/attendance/settings'),
      api('/api/attendance/qr')
    ]).then(async ([d, qr]) => {
      const s = d.settings || {};
      const o = s.office || {};
      officeQrMeta = qr;
      box.innerHTML = `
        <div class="att-qr-poster-wrap" id="att-qr-print">
          <div class="att-qr-poster-head">
            <div>
              <div class="att-qr-kicker">Davomat</div>
              <h3 class="att-qr-title">VaksinaMed GPS Office</h3>
              <p class="att-qr-lead">Ofis QR plakati — chop eting yoki PNG/PDF yuklab oling.</p>
            </div>
            <div class="att-qr-ver">v${esc(String(qr.version || 1))}</div>
          </div>
          <div class="att-qr-stage">
            <canvas id="office-qr-poster" width="720" height="960" aria-label="Ofis QR plakat"></canvas>
            <div class="att-qr-loading" id="office-qr-loading">QR chizilmoqda…</div>
          </div>
          <div class="att-qr-actions">
            <button type="button" class="att-btn att-btn-in" id="btn-qr-print">Chop etish</button>
            <button type="button" class="att-btn att-btn-face" id="btn-qr-png">PNG yuklash</button>
            <button type="button" class="att-btn att-btn-out" id="btn-qr-pdf">PDF yuklash</button>
            <button type="button" class="att-btn" id="btn-qr-rotate" style="background:#0b1f3a;color:#fff;border-color:#0b1f3a">QR yangilash</button>
          </div>
          <p class="att-hint" id="office-qr-status">v${esc(String(qr.version || 1))} · ${esc(qr.label || o.label || 'Ofis')}</p>
        </div>
        <hr style="margin:22px 0;border:none;border-top:1px solid #d7e2ef">
        <p class="att-hint" style="margin:0 0 12px">Haydovchilar va ofis: <b>09:00–18:00</b>, kechikish ruxsati <b>15 daqiqa</b>.</p>
        <div class="row2">
          <div class="fld"><label>Ish boshlanishi</label><input id="s-in-start" value="${esc(s.in_start || '09:00')}" placeholder="09:00"></div>
          <div class="fld"><label>Ruxsat (daqiqa)</label><input id="s-grace" type="number" min="0" max="120" value="${esc(s.late_grace_min != null ? s.late_grace_min : 15)}"></div>
        </div>
        <div class="row2">
          <div class="fld"><label>Kechikish dan (soat)</label><input id="s-late" value="${esc(s.in_late_after || '09:15')}" placeholder="09:15"></div>
          <div class="fld"><label>Ish tugashi (rejada)</label><input id="s-out-start" value="${esc(s.out_start || '18:00')}" placeholder="18:00"></div>
        </div>
        <div class="row2">
          <div class="fld"><label>Kun yopiladi (oxirgi punch)</label><input id="s-out-end" value="${esc(s.out_end || '20:00')}" placeholder="20:00"></div>
          <div class="fld"><label>Ofis nomi</label><input id="s-label" value="${esc(o.label || '')}"></div>
        </div>
        <div class="row2">
          <div class="fld"><label>Ofis lat</label><input id="s-lat" value="${esc(o.lat || '')}"></div>
          <div class="fld"><label>Ofis lng</label><input id="s-lng" value="${esc(o.lng || '')}"></div>
        </div>
        <div class="row2">
          <div class="fld"><label>Radius (m)</label><input id="s-radius" type="number" value="${esc(o.radius_m || 100)}"></div>
          <div class="fld"></div>
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
      try {
        await renderOfficeQrPoster(qr);
        const st = document.getElementById('office-qr-status');
        if (st) st.textContent = 'Tayyor · v' + (qr.version || 1) + ' · ' + (qr.label || o.label || 'Ofis');
      } catch (e) {
        const st = document.getElementById('office-qr-status');
        if (st) st.textContent = 'QR xato: ' + (e.message || 'chizilmadi');
        msg(e.message || 'QR chizilmadi', 'err');
      }
      const loadEl = document.getElementById('office-qr-loading');
      if (loadEl) loadEl.hidden = true;

      const printBtn = document.getElementById('btn-qr-print');
      const pngBtn = document.getElementById('btn-qr-png');
      const pdfBtn = document.getElementById('btn-qr-pdf');
      const rotBtn = document.getElementById('btn-qr-rotate');
      if (printBtn) printBtn.onclick = () => printOfficeQrPoster();
      if (pngBtn) pngBtn.onclick = () => downloadOfficeQrPng(qr);
      if (pdfBtn) pdfBtn.onclick = () => downloadOfficeQrPdf(qr);
      if (rotBtn) rotBtn.onclick = async () => {
        if (!confirm('Eski chop etilgan QR ishlamaydi. Yangilaysizmi?')) return;
        try {
          const nr = await api('/api/attendance/qr/rotate', {
            method: 'POST',
            body: JSON.stringify({ confirm: 'yangilash' })
          });
          msg('Yangi ofis QR yaratildi — qayta chop eting', 'ok');
          renderSettings();
        } catch (e) { msg(e.message || 'Yangilash xato', 'err'); }
      };
    }).catch((e) => {
      box.innerHTML = `<p class="att-hint">${esc(e.message)}</p>`;
    });
  }

  async function ensureQrLib() {
    if (window.QRCode && typeof window.QRCode.create === 'function') {
      return { type: 'create', lib: window.QRCode };
    }
    if (window.QRCode && typeof window.QRCode.toCanvas === 'function') {
      return { type: 'toCanvas', lib: window.QRCode };
    }
    try {
      await loadScriptOnce(QR_LIB);
    } catch (e1) {
      try {
        await loadScriptOnce(QR_LIB_FALLBACK);
      } catch (e2) {
        /* next */
      }
    }
    const lib = window.QRCode || window.qrcode;
    if (lib && typeof lib.create === 'function') return { type: 'create', lib: lib };
    if (lib && typeof lib.toCanvas === 'function') return { type: 'toCanvas', lib: lib };

    if (typeof window.QRCode === 'function' && window.QRCode.CorrectLevel) {
      return { type: 'ctor', Ctor: window.QRCode };
    }
    await loadScriptOnce(QR_LIB_JS);
    if (typeof window.QRCode === 'function') return { type: 'ctor', Ctor: window.QRCode };
    throw new Error('QR kutubxonasi yuklanmadi');
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('QR rasm yuklanmadi'));
      img.src = src;
    });
  }

  function makeQrViaCtor(Ctor, payload, size) {
    return new Promise((resolve, reject) => {
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-9999px;top:0;width:' + size + 'px;height:' + size + 'px';
      document.body.appendChild(holder);
      try {
        // eslint-disable-next-line no-new
        new Ctor(holder, {
          text: payload,
          width: size,
          height: size,
          colorDark: '#0b1f3a',
          colorLight: '#ffffff',
          correctLevel: (Ctor.CorrectLevel && Ctor.CorrectLevel.H) || 2
        });
      } catch (e) {
        holder.remove();
        reject(e);
        return;
      }
      const finish = () => {
        try {
          const srcCanvas = holder.querySelector('canvas');
          const srcImg = holder.querySelector('img');
          const tmp = document.createElement('canvas');
          tmp.width = size;
          tmp.height = size;
          const ctx = tmp.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, size, size);
          if (srcCanvas) ctx.drawImage(srcCanvas, 0, 0, size, size);
          else if (srcImg && srcImg.src) ctx.drawImage(srcImg, 0, 0, size, size);
          else throw new Error('QR DOM element topilmadi');
          holder.remove();
          resolve(tmp);
        } catch (e) {
          holder.remove();
          reject(e);
        }
      };
      setTimeout(finish, 80);
    });
  }

  /** GPS uslubidagi yumaloq modulli QR — kvadrat pixel emas */
  function drawGpsStyleQr(ctx, modules, size, opts) {
    const n = modules.size;
    const marginMods = 2;
    const total = n + marginMods * 2;
    const cell = size / total;
    const dark = (opts && opts.dark) || '#0b1f3a';
    const accent = (opts && opts.accent) || '#1a8cff';
    const light = (opts && opts.light) || '#ffffff';

    ctx.fillStyle = light;
    ctx.fillRect(0, 0, size, size);

    function isOn(x, y) {
      if (x < 0 || y < 0 || x >= n || y >= n) return false;
      return modules.get(x, y);
    }

    function inFinder(x, y) {
      const inTL = x < 7 && y < 7;
      const inTR = x >= n - 7 && y < 7;
      const inBL = x < 7 && y >= n - 7;
      return inTL || inTR || inBL;
    }

    // Data modules — GPS nuqtalari (doira)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!isOn(x, y) || inFinder(x, y)) continue;
        const cx = (x + marginMods + 0.5) * cell;
        const cy = (y + marginMods + 0.5) * cell;
        const r = cell * 0.40;
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Finder — yumaloq burchakli joylashuv belgilari (standart 7×7 struktura)
    function drawLocator(ox, oy) {
      const px = (ox + marginMods) * cell;
      const py = (oy + marginMods) * cell;
      const s = cell * 7;
      const cx = px + s / 2;
      const cy = py + s / 2;

      ctx.fillStyle = dark;
      roundRect(ctx, px, py, s, s, cell * 0.95);
      ctx.fill();
      ctx.fillStyle = light;
      roundRect(ctx, px + cell, py + cell, cell * 5, cell * 5, cell * 0.7);
      ctx.fill();
      // Ichki “radar” ko‘zi
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 1.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = dark;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }

    drawLocator(0, 0);
    drawLocator(n - 7, 0);
    drawLocator(0, n - 7);
  }

  async function makeQrBitmap(payload, size) {
    const tmp = document.createElement('canvas');
    tmp.width = size;
    tmp.height = size;
    const ctx = tmp.getContext('2d');
    try {
      const eng = await ensureQrLib();
      if (eng.type === 'create' || (eng.lib && typeof eng.lib.create === 'function')) {
        const lib = eng.lib || eng;
        const qr = lib.create(payload, { errorCorrectionLevel: 'H' });
        drawGpsStyleQr(ctx, qr.modules, size, {
          dark: '#0b1f3a',
          accent: '#1a8cff',
          light: '#ffffff'
        });
        return tmp;
      }
      if (eng.type === 'toCanvas') {
        // create yo‘q bo‘lsa — oddiy, lekin yumaloq emas
        await eng.lib.toCanvas(tmp, payload, {
          width: size,
          margin: 2,
          errorCorrectionLevel: 'H',
          color: { dark: '#0b1f3a', light: '#ffffff' }
        });
        return tmp;
      }
      return await makeQrViaCtor(eng.Ctor, payload, size);
    } catch (e) {
      const url = 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size +
        '&margin=8&ecc=H&color=0b1f3a&bgcolor=ffffff&data=' + encodeURIComponent(payload);
      const img = await loadImage(url);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      return tmp;
    }
  }

  async function renderOfficeQrPoster(qr) {
    const poster = document.getElementById('office-qr-poster');
    if (!poster) throw new Error('Poster canvas topilmadi');
    const payload = (qr && qr.payload) || '';
    if (!payload) throw new Error('QR payload yo‘q — serverdan olinmadi');
    officeQrMeta = qr;

    const W = 720;
    const H = 820;
    poster.width = W;
    poster.height = H;
    const ctx = poster.getContext('2d');

    // Map / night GPS atmosphere
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#06101c');
    bg.addColorStop(0.5, '#0a1c33');
    bg.addColorStop(1, '#0d2744');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Faint grid (GPS map vibe)
    ctx.strokeStyle = 'rgba(125,211,252,0.06)';
    ctx.lineWidth = 1;
    for (let x = 40; x < W; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 40; y < H; y += 40) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Soft radar glow behind QR
    const glow = ctx.createRadialGradient(W / 2, H * 0.52, 40, W / 2, H * 0.52, 320);
    glow.addColorStop(0, 'rgba(26,140,255,0.28)');
    glow.addColorStop(0.55, 'rgba(26,140,255,0.08)');
    glow.addColorStop(1, 'rgba(26,140,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // Title only
    ctx.textAlign = 'center';
    ctx.fillStyle = '#7dd3fc';
    ctx.font = '700 13px IBM Plex Mono, monospace';
    ctx.fillText('VAKSINAMED', W / 2, 64);
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 36px IBM Plex Sans, Arial, sans-serif';
    ctx.fillText('GPS Office', W / 2, 108);

    const ver = 'v' + String((qr && qr.version) || 1);
    ctx.fillStyle = 'rgba(125,211,252,0.18)';
    roundRect(ctx, W / 2 - 28, 124, 56, 26, 13);
    ctx.fill();
    ctx.fillStyle = '#ccebff';
    ctx.font = '700 12px IBM Plex Mono, monospace';
    ctx.fillText(ver, W / 2, 142);

    // Glass card around QR + ketma-ketlik
    const qrSize = 400;
    const qx = (W - qrSize) / 2;
    const qy = 178;
    const cardPad = 36;
    const cardBottomExtra = 56;
    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    roundRect(ctx, qx - cardPad, qy - cardPad, qrSize + cardPad * 2, qrSize + cardPad * 2 + cardBottomExtra, 32);
    ctx.fill();

    ctx.strokeStyle = 'rgba(26,140,255,0.35)';
    ctx.lineWidth = 2;
    roundRect(ctx, qx - 28, qy - 28, qrSize + 56, qrSize + 56 + cardBottomExtra, 26);
    ctx.stroke();

    const qrBmp = await makeQrBitmap(payload, qrSize);
    ctx.drawImage(qrBmp, qx, qy, qrSize, qrSize);

    // Ketma-ketlik — QR ostida (kartochka ichida)
    ctx.fillStyle = '#1a5fb4';
    ctx.font = '700 13px IBM Plex Mono, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('1  ZONA   →   2  SKAN   →   3  KELDI / KETDI', W / 2, qy + qrSize + 38);

    ctx.fillStyle = 'rgba(200,230,255,0.9)';
    ctx.font = '600 13px IBM Plex Mono, monospace';
    ctx.fillText('VaksinaMed GPS Office', W / 2, qy + qrSize + cardPad + cardBottomExtra + 36);
    ctx.textAlign = 'left';

    return poster;
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function getOfficePosterCanvas() {
    return document.getElementById('office-qr-poster');
  }

  function printOfficeQrPoster() {
    const canvas = getOfficePosterCanvas();
    if (!canvas || !canvas.width) {
      msg('Avval QR chizilsin', 'err');
      return;
    }
    const w = window.open('', '_blank', 'width=520,height=720');
    if (!w) {
      msg('Popup bloklangan — brauzer ruxsat bering', 'err');
      return;
    }
    w.document.write(
      '<html><head><title>VaksinaMed Ofis QR</title><style>' +
      'body{margin:0;background:#111;display:flex;justify-content:center;align-items:center;min-height:100vh}' +
      'img{max-width:100%;height:auto;box-shadow:0 12px 40px rgba(0,0,0,.4)}' +
      '@media print{body{background:#fff}img{box-shadow:none;width:100%}}' +
      '</style></head><body>' +
      '<img src="' + canvas.toDataURL('image/png') + '" alt="Ofis QR"/>' +
      '<script>window.onload=function(){setTimeout(function(){window.print()},250)}<\/script>' +
      '</body></html>'
    );
    w.document.close();
  }

  function downloadOfficeQrPng(qr) {
    const canvas = getOfficePosterCanvas();
    if (!canvas || !canvas.width) {
      msg('QR hali chizilmadi — sahifani yangilang', 'err');
      return;
    }
    try {
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'vaksina-ofis-qr-v' + ((qr && qr.version) || (officeQrMeta && officeQrMeta.version) || 1) + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      msg('PNG yuklandi', 'ok');
    } catch (e) {
      msg(e.message || 'PNG xato', 'err');
    }
  }

  function downloadOfficeQrPdf(qr) {
    const canvas = getOfficePosterCanvas();
    if (!canvas || !canvas.width) {
      msg('QR hali chizilmadi — sahifani yangilang', 'err');
      return;
    }
    const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!JsPDF) {
      msg('PDF kutubxonasi yuklanmadi', 'err');
      return;
    }
    try {
      const doc = new JsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const pageW = doc.internal.pageSize.getWidth();
      const pageH = doc.internal.pageSize.getHeight();
      const margin = 28;
      const maxW = pageW - margin * 2;
      const maxH = pageH - margin * 2;
      const ratio = Math.min(maxW / canvas.width, maxH / canvas.height);
      const w = canvas.width * ratio;
      const h = canvas.height * ratio;
      const x = (pageW - w) / 2;
      const y = (pageH - h) / 2;
      doc.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', x, y, w, h);
      doc.save('vaksina-ofis-qr-v' + ((qr && qr.version) || 1) + '.pdf');
      msg('PDF yuklandi', 'ok');
    } catch (e) {
      msg(e.message || 'PDF xato', 'err');
    }
  }

  // Eski oddiy canvas API o‘rniga poster
  async function paintOfficeQrCanvas() {
    if (officeQrMeta) return renderOfficeQrPoster(officeQrMeta);
  }

  function printOfficeQr() {
    printOfficeQrPoster();
  }

  async function saveSettings() {
    try {
      const body = {
        in_start: document.getElementById('s-in-start').value,
        late_grace_min: Number(document.getElementById('s-grace').value || 15),
        in_late_after: document.getElementById('s-late').value,
        out_start: document.getElementById('s-out-start').value,
        out_end: document.getElementById('s-out-end').value,
        require_face: false,
        require_qr: true,
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
    if (STATE && STATE.qrTicket) qrTicketLocal = STATE.qrTicket;
    window._vmFaceEnrolled = true;
    window._vmAttendanceReady = true;
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
    const perm = await readGeoPermission();
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
      probeGeoOnBoot();
    } catch (e) {
      app.innerHTML = `<p class="att-loading">${esc(e.message || 'Xato')}</p>`;
    }
  }

  boot();
})();
