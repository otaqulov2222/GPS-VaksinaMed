'use strict';
/**
 * VaksinaMed Davomat — Ofis geozona → Keldim/Ketdim (QR ixtiyoriy)
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
  let HISOBOT = null;
  let hisobotPeriod = 'day'; // day | week | month | range
  let hisobotDate = '';
  let hisobotFrom = '';
  let hisobotTo = '';
  let hisobotStatus = 'all';
  let hisobotQ = '';
  let PERSON = null;
  let geoWatchId = null;
  let geoProbeTimer = null;
  let geoProbeSeq = 0;
  let clockId = null;
  let attMap = null;
  let attMapCircle = null;
  let attMapUser = null;
  let attMapAcc = null; // GPS aniqlik doirasi
  let attMapLink = null; // legacy
  let attMapRouteGlow = null;
  let attMapRoute = null;
  let attMapOffice = null;
  let attMapFitted = false;
  let routeTimer = null;
  let routeSeq = 0;
  let routeCacheKey = '';
  let routeCacheLatLngs = null;
  let geoLive = { inside: null, dist: null, accuracy: null, lat: null, lng: null, err: null, status: 'idle', ts: 0 };
  let attMethod = 'qr';
  const GEO_SOFT_MAX = 280;
  const GEO_COARSE_REJECT = 1200; // undan yomon fix — yaxshi fix bor bo'lsa rad etiladi
  const OSRM_ROUTE = 'https://router.project-osrm.org/route/v1/driving/';

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
  let scanPulseId = null;
  let qrLibWarm = false;

  function warmQrLib() {
    if (qrLibWarm || window.Html5Qrcode || window.BarcodeDetector) return;
    qrLibWarm = true;
    loadScriptOnce(HTML5_QR).catch(() => {});
  }

  function stopScanPulse() {
    if (scanPulseId) {
      clearInterval(scanPulseId);
      scanPulseId = null;
    }
  }

  function startScanPulse() {
    stopScanPulse();
    let n = 0;
    const phrases = [
      'QR qidirilmoqda…',
      'Ramkaga tuting…',
      'Yashil burchak ichiga…'
    ];
    scanPulseId = setInterval(() => {
      n = (n + 1) % phrases.length;
      setFidUI({
        status: phrases[n],
        hint: 'QR kodni yashil burchakli ramka ichiga tuting',
        progress: null,
        tone: 'scan'
      });
    }, 900);
  }

  function isIosLike() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent || '')
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  async function pickBackCameraId() {
    try {
      if (!window.Html5Qrcode || !Html5Qrcode.getCameras) return null;
      const cams = await Html5Qrcode.getCameras();
      if (!cams || !cams.length) return null;
      const back = cams.find((c) => /back|rear|environment|orqa|world/i.test(c.label || ''));
      return (back || cams[cams.length - 1] || cams[0]).id;
    } catch (e) {
      return null;
    }
  }

  function nextPunchKind() {
    const today = (STATE && STATE.today) || {};
    if (!today.in) return 'in';
    if (today.in && !today.out) return 'out';
    return null;
  }

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

  function qrRequired() {
    return !!(STATE && STATE.settings && STATE.settings.require_qr);
  }

  function punchGateOk() {
    if (geoLive.inside !== true) return false;
    if (qrRequired()) return !!activeQrTicket();
    return true;
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
    const lat = o.lat != null && o.lat !== '' ? Number(o.lat) : NaN;
    const lng = o.lng != null && o.lng !== '' ? Number(o.lng) : NaN;
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    return {
      hasCoords,
      lat: hasCoords ? lat : null,
      lng: hasCoords ? lng : null,
      radius: Math.max(50, Number(o.radius_m) || 100),
      label: o.label || 'VaksinaMed ofis'
    };
  }

  function canSeeOfficeCoords() {
    const u = (STATE && STATE.user) || window.VM_USER || {};
    if (u.role === 'admin_pro') return true;
    return !!(STATE && STATE.settings && STATE.settings.officeCoordsVisible);
  }

  function userDisplayName() {
    const u = (STATE && STATE.user) || window.VM_USER || {};
    return u.name || u.username || 'Xodim';
  }

  function userRoleLabel() {
    const u = (STATE && STATE.user) || window.VM_USER || {};
    return roleLabel(u.role);
  }

  function roleLabel(r) {
    const role = r || '';
    if (role === 'admin_pro') return 'Admin Pro';
    if (role === 'admin') return 'Admin';
    if (role === 'driver') return 'Haydovchi';
    return role || 'Xodim';
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

  function fmtCoord(v, digits) {
    const n = Number(v);
    if (!Number.isFinite(n)) return '—';
    return n.toFixed(digits == null ? 6 : digits);
  }

  /** Yangi GPS fixni qabul qilish: qo'pol IP/cell yaxshi fixni bosib yubormasin. */
  function shouldAcceptGeoFix(lat, lng, accuracy) {
    if (lat == null || lng == null) return false;
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return false;
    const acc = accuracy != null && Number.isFinite(Number(accuracy)) ? Number(accuracy) : null;
    if (!geoLive || geoLive.lat == null || geoLive.lng == null) return true;
    const oldAcc = geoLive.accuracy != null && Number.isFinite(Number(geoLive.accuracy))
      ? Number(geoLive.accuracy)
      : null;
    const moved = haversineM(lat, lng, geoLive.lat, geoLive.lng);
    // Yaxshi fix bor (≤250 m), yangisi juda qo'pol — rad et
    if (oldAcc != null && oldAcc <= 250 && acc != null && acc >= GEO_COARSE_REJECT) return false;
    // Eski yaxshiroq, yangi yomonroq va deyarli joyida — rad et
    if (oldAcc != null && acc != null && acc > oldAcc * 1.8 && acc > 120 && moved < Math.max(40, oldAcc)) {
      return false;
    }
    // Yaxshiroq aniqlik — qabul
    if (acc != null && (oldAcc == null || acc <= oldAcc)) return true;
    // Harakat sezilarli — qabul (yangi joy)
    if (moved > Math.max(25, (oldAcc || 50) * 0.6)) return true;
    // Aniqlik biroz yomonroq, lekin yaqin — saqlab qolamiz (eski)
    if (oldAcc != null && acc != null && acc > oldAcc) return false;
    return true;
  }

  function computeInside(lat, lng, accuracy) {
    const off = officeInfo();
    if (!off.hasCoords) return { inside: null, dist: null, soft: 0 };
    const dist = haversineM(lat, lng, off.lat, off.lng);
    const acc = accuracy != null && Number.isFinite(Number(accuracy)) ? Number(accuracy) : null;
    const soft = acc != null && acc > 0 ? Math.min(acc, GEO_SOFT_MAX) : 0;
    return { inside: dist <= (off.radius + soft), dist, soft };
  }

  function applyGeoFix(lat, lng, accuracy, opts) {
    opts = opts || {};
    const force = !!opts.force;
    const acc = accuracy != null && Number.isFinite(Number(accuracy)) ? Number(accuracy) : null;
    if (!force && !shouldAcceptGeoFix(lat, lng, acc)) {
      // Faqat UI da "yomon signal" eslatmasin — eng yaxshi fixni saqlaymiz
      return false;
    }
    const off = officeInfo();
    const calc = computeInside(lat, lng, acc);
    if (off.hasCoords) {
      geoLive = {
        inside: calc.inside,
        dist: calc.dist,
        accuracy: acc,
        lat, lng,
        err: null,
        status: calc.inside ? 'ok' : 'out',
        message: null,
        ts: Date.now()
      };
    } else {
      geoLive = {
        inside: geoLive && geoLive.inside === true ? true : null,
        dist: geoLive && geoLive.dist != null ? geoLive.dist : null,
        accuracy: acc,
        lat, lng,
        err: null,
        status: (geoLive && geoLive.inside === true) ? 'ok' : 'load',
        message: null,
        ts: Date.now()
      };
    }
    paintGeoUI();
    updateAttMap(lat, lng);
    paintMapOverlay();
    scheduleGeoProbe(lat, lng, acc);
    return true;
  }

  function scheduleGeoProbe(lat, lng, accuracy) {
    if (geoProbeTimer) clearTimeout(geoProbeTimer);
    geoProbeTimer = setTimeout(() => { runGeoProbe(lat, lng, accuracy); }, 280);
  }

  async function runGeoProbe(lat, lng, accuracy) {
    const seq = ++geoProbeSeq;
    try {
      const r = await api('/api/attendance/geo-check', {
        method: 'POST',
        body: JSON.stringify({ lat, lng, accuracy }),
        noRedirect: true
      });
      if (seq !== geoProbeSeq) return;
      if (geoLive.lat !== lat || geoLive.lng !== lng) return;
      const inside = !!r.inside;
      const dist = r.distance_m != null ? Number(r.distance_m) : null;
      geoLive = {
        inside,
        dist: Number.isFinite(dist) ? dist : null,
        accuracy: accuracy != null ? Number(accuracy) : null,
        lat, lng,
        err: inside ? null : (r.message || null),
        status: inside ? 'ok' : 'out',
        message: r.message || null
      };
      if (r.radius_m != null && STATE && STATE.settings && STATE.settings.office) {
        STATE.settings.office.radius_m = r.radius_m;
      }
      if (r.office_lat != null && r.office_lng != null && STATE && STATE.settings) {
        STATE.settings.office = STATE.settings.office || {};
        const prevLat = STATE.settings.office.lat;
        STATE.settings.office.lat = r.office_lat;
        STATE.settings.office.lng = r.office_lng;
        if (!attMapOffice || prevLat == null) {
          try { initAttMap(); } catch (e) {}
        }
      }
      paintGeoUI();
      updateAttMap(lat, lng);
      paintMapOverlay();
    } catch (e) {
      if (seq !== geoProbeSeq) return;
      // Server xato — klient hisobini saqlab qolamiz
      if (geoLive.inside == null) {
        geoLive = {
          inside: false,
          dist: geoLive.dist,
          accuracy: accuracy != null ? Number(accuracy) : null,
          lat, lng,
          err: (e && e.message) || 'Zona tekshiruvi xato',
          status: 'err',
          message: null
        };
        paintGeoUI();
      }
    }
  }

  function applyGeoError(err) {
    geoLive = {
      inside: false, dist: null, accuracy: null, lat: null, lng: null,
      err: err && err.message ? err.message : 'Joylashuv olinmadi',
      status: 'err',
      message: null
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
    const needQr = qrRequired();
    const ticketOk = !!activeQrTicket();
    const gateOk = punchGateOk();
    const done = !!(today.in && today.out);
    const canIn = !today.in && !done;
    const canOut = !!today.in && !today.out;
    const inside = geoLive.inside === true;
    const accTxt = geoLive.accuracy != null ? Math.round(geoLive.accuracy) : null;

    if (badge) {
      badge.className = 'av-geo-badge ' + (geoLive.status === 'ok' ? 'ok' : (geoLive.status === 'out' || geoLive.status === 'err' ? 'bad' : 'load'));
      if (geoLive.status === 'ok') badge.textContent = '✓ Siz ofis hududidasiz';
      else if (geoLive.status === 'out') badge.textContent = '✗ Ofisdan tashqarida';
      else if (geoLive.status === 'err') badge.textContent = 'GPS yoʻq';
      else badge.textContent = 'Joylashuv…';
    }
    if (distEl) {
      const bits = [];
      if (geoLive.lat != null && geoLive.lng != null) {
        bits.push('Siz: <b class="mono">' + fmtCoord(geoLive.lat) + ', ' + fmtCoord(geoLive.lng) + '</b>');
      }
      if (geoLive.dist != null && Number.isFinite(Number(geoLive.dist))) {
        bits.push('Ofisdan <b>' + Math.round(geoLive.dist) + ' m</b>');
      }
      bits.push('Radius <b>' + off.radius + ' m</b>');
      if (accTxt != null) {
        bits.push('Aniqlik <b>±' + accTxt + ' m</b>' + (accTxt > 500 ? ' <span class="av-geo-weak">(zaif)</span>' : ''));
      }
      distEl.innerHTML = bits.join(' · ') || ('Ofis: <b>' + esc(off.label) + '</b>');
    }
    if (gate) {
      if (geoLive.status === 'ok') {
        gate.className = 'av-gate-banner on ok';
        if (needQr && !ticketOk) {
          gate.textContent = 'Siz ofis zonasidasiz. Devordagi QR ni skanerlang, keyin Keldim.';
        } else {
          gate.textContent = 'Ofis zonasidasiz — Keldim yoki Ketdim tugmasini bosing.';
        }
      } else if (geoLive.status === 'out') {
        gate.className = 'av-gate-banner on';
        if (geoLive.message || geoLive.err) {
          gate.textContent = geoLive.message || geoLive.err;
        } else if (geoLive.dist != null && Number.isFinite(Number(geoLive.dist))) {
          gate.textContent = 'Davomat faqat ofis radiusida. Markazdan ~' +
            Math.round(geoLive.dist) + ' m (radius ' + off.radius + ' m). «Qayta tekshirish» bosing.';
        } else {
          gate.textContent = 'Joylashuv ofis zonasi bilan mos kelmadi. «Qayta tekshirish» bosing.';
        }
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
      const shouldEnable = allow && gateOk;
      btn.disabled = !shouldEnable;
      btn.classList.toggle('is-locked', !gateOk && allow);
    };
    lockPunch(inBtn, canIn);
    lockPunch(outBtn, canOut);

    const pill = document.getElementById('av-qr-pill');
    if (pill) {
      if (!needQr) {
        pill.classList.toggle('on', inside);
        pill.textContent = inside ? 'Zona OK' : 'Zona kutilyapti';
      } else {
        pill.classList.toggle('on', ticketOk);
        pill.textContent = ticketOk ? 'QR faol' : 'QR kutilyapti';
      }
    }
    const hint = document.getElementById('av-qr-ticket-hint');
    if (hint) {
      if (!needQr) {
        hint.textContent = inside
          ? 'Radius ichidasiz — Keldim / Ketdim ochiq.'
          : 'Ofis radiusiga kiring — tugmalar ochiladi.';
      } else {
        hint.textContent = ticketOk
          ? 'QR ruxsati faol (~10 daq). Endi Keldim yoki Ketdim bosing.'
          : 'QR hali skanerlanmagan.';
      }
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
      if (qr) {
        qr.hidden = !needQr;
        setSt(qr, ticketOk ? 'done' : (inside ? 'now' : 'wait'));
      }
      setSt(punch, done ? 'done' : (gateOk ? 'now' : 'wait'));
    }

    if (goBtn) {
      const nextKind = !today.in ? 'in' : (today.in && !today.out ? 'out' : null);
      goBtn.disabled = done || !gateOk || !nextKind;
      goBtn.setAttribute('data-next', nextKind || '');
      goBtn.setAttribute('data-action', needQr ? (ticketOk ? 'choose' : 'scan') : 'punch');
      const lab = goBtn.querySelector('span');
      const sub = goBtn.querySelector('small');
      if (lab) {
        if (done) lab.textContent = 'Bugun yakunlangan';
        else if (!inside) lab.textContent = 'Ofisga keling';
        else if (needQr && !ticketOk) lab.textContent = 'Ofis QR skanerlash';
        else if (nextKind === 'out') lab.textContent = 'Ketdim';
        else lab.textContent = 'Keldim';
      }
      if (sub) {
        sub.textContent = !inside
          ? (off.label + ' · ' + off.radius + ' m')
          : (needQr && !ticketOk
            ? 'Devordagi ofis QR ni skanerlang'
            : 'Tugmani bosing — geozona yetarli');
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
    attMapAcc = null;
    attMapLink = null;
    attMapRouteGlow = null;
    attMapRoute = null;
    attMapOffice = null;
    attMapFitted = false;
    routeCacheKey = '';
    routeCacheLatLngs = null;
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
    /* Holat header + foot da — xarita ustida takrorlamaymiz */
  }

  function popupYouHtml(lat, lng, inside) {
    const acc = geoLive.accuracy != null ? Math.round(geoLive.accuracy) : null;
    const dist = geoLive.dist != null ? Math.round(geoLive.dist) : null;
    return (
      '<div class="av-you-pop">' +
      '<b>' + (inside ? 'Siz — ofis ichida' : 'Siz — ofisdan tashqarida') + '</b><br>' +
      '<span class="mono">' + fmtCoord(lat) + ', ' + fmtCoord(lng) + '</span><br>' +
      (acc != null ? ('Aniqlik: ±' + acc + ' m<br>') : '') +
      (dist != null ? ('Ofisgacha: ' + dist + ' m') : '') +
      '</div>'
    );
  }

  function initAttMap() {
    destroyAttMap();
    const el = document.getElementById('av-map');
    if (!el || !window.L) return;
    const off = officeInfo();
    const startLat = (geoLive.lat != null) ? geoLive.lat : (off.hasCoords ? off.lat : 41.31);
    const startLng = (geoLive.lng != null) ? geoLive.lng : (off.hasCoords ? off.lng : 69.24);
    attMap = L.map(el, { zoomControl: true, attributionControl: false }).setView([startLat, startLng], 17);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20
    }).addTo(attMap);
    if (off.hasCoords) {
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
      }).addTo(attMap).bindPopup(
        '<b>' + off.label + '</b><br>' +
        '<span class="mono">' + fmtCoord(off.lat) + ', ' + fmtCoord(off.lng) + '</span><br>' +
        'Radius: ' + off.radius + ' m'
      );
      styleZoneCircle(geoLive.inside);
    } else {
      attMapCircle = null;
      attMapOffice = null;
    }
    setTimeout(() => {
      try { attMap.invalidateSize(); } catch (e) {}
      attachLocateControl();
    }, 80);
    if (geoLive.lat != null) updateAttMap(geoLive.lat, geoLive.lng);
    else if (off.hasCoords) {
      try { attMap.fitBounds(attMapCircle.getBounds().pad(0.12)); } catch (e) {}
    }
    paintMapOverlay();
  }

  function updateAttMap(lat, lng) {
    if (!attMap || !window.L) return;
    if (lat == null || lng == null) return;
    const inside = geoLive.inside === true;
    const youKind = inside ? 'you' : 'you-out';
    const youLabel = inside ? 'Siz (ichida)' : 'Siz (tashqarida)';
    styleZoneCircle(geoLive.inside);

    if (!attMapUser) {
      attMapUser = L.marker([lat, lng], {
        icon: pinIcon(youLabel, youKind),
        zIndexOffset: 500
      }).addTo(attMap);
      attMapUser.bindPopup(popupYouHtml(lat, lng, inside));
      attMapUser.bindTooltip(youLabel, { direction: 'top', offset: [0, -8], opacity: 0.95, permanent: false });
    } else {
      attMapUser.setLatLng([lat, lng]);
      attMapUser.setIcon(pinIcon(youLabel, youKind));
      try { attMapUser.setTooltipContent(youLabel); } catch (e) {}
      try { attMapUser.setPopupContent(popupYouHtml(lat, lng, inside)); } catch (e) {}
    }

    // GPS aniqlik doirasi — foydalanuvchi qayerda ekanini ko'rsatadi
    const accR = geoLive.accuracy != null && Number.isFinite(Number(geoLive.accuracy))
      ? Math.max(8, Math.min(Number(geoLive.accuracy), 2500))
      : 25;
    if (!attMapAcc) {
      attMapAcc = L.circle([lat, lng], {
        radius: accR,
        color: inside ? '#16a34a' : '#dc2626',
        fillColor: inside ? '#22c55e' : '#f87171',
        fillOpacity: 0.14,
        weight: 1.5,
        dashArray: '4 4',
        interactive: false
      }).addTo(attMap);
    } else {
      attMapAcc.setLatLng([lat, lng]);
      attMapAcc.setRadius(accR);
      attMapAcc.setStyle({
        color: inside ? '#16a34a' : '#dc2626',
        fillColor: inside ? '#22c55e' : '#f87171'
      });
    }

    // Yo'l bo'ylab ko'k marshrut (to'g'ri chiziq emas)
    const off = officeInfo();
    if (off.hasCoords) {
      scheduleRoadRoute(lat, lng, off.lat, off.lng, inside);
    } else {
      clearRoadRoute();
    }

    try {
      if (off.hasCoords) {
        const b = L.latLngBounds([[off.lat, off.lng], [lat, lng]]);
        if (attMapCircle) b.extend(attMapCircle.getBounds());
        if (attMapAcc) b.extend(attMapAcc.getBounds());
        if (attMapRoute) {
          try { b.extend(attMapRoute.getBounds()); } catch (e) {}
        }
        if (!attMapFitted) {
          attMap.fitBounds(b.pad(0.22));
          attMapFitted = true;
        } else {
          if (!attMap.getBounds().contains([lat, lng])) {
            attMap.panTo([lat, lng], { animate: true });
          }
        }
      } else if (!attMapFitted) {
        attMap.setView([lat, lng], 18);
        attMapFitted = true;
      } else {
        attMap.panTo([lat, lng], { animate: true });
      }
    } catch (e) {}
    paintMapOverlay();
  }

  function clearRoadRoute() {
    if (routeTimer) {
      clearTimeout(routeTimer);
      routeTimer = null;
    }
    if (attMapRoute) {
      try { attMap.removeLayer(attMapRoute); } catch (e) {}
      attMapRoute = null;
    }
    if (attMapRouteGlow) {
      try { attMap.removeLayer(attMapRouteGlow); } catch (e) {}
      attMapRouteGlow = null;
    }
    if (attMapLink) {
      try { attMap.removeLayer(attMapLink); } catch (e) {}
      attMapLink = null;
    }
    routeCacheKey = '';
    routeCacheLatLngs = null;
  }

  function routeKey(lat, lng, olat, olng) {
    // ~30 m grid — ortiqcha so'rovlarni kamaytiradi
    const r = (v) => (Math.round(Number(v) * 3000) / 3000).toFixed(4);
    return r(lat) + ',' + r(lng) + '>' + r(olat) + ',' + r(olng);
  }

  function paintRoadRoute(latLngs, inside) {
    if (!attMap || !window.L || !latLngs || latLngs.length < 2) return;
    const mainColor = inside ? '#15803d' : '#2563eb';
    const glowColor = inside ? '#86efac' : '#93c5fd';
    if (!attMapRouteGlow) {
      attMapRouteGlow = L.polyline(latLngs, {
        color: glowColor,
        weight: 12,
        opacity: 0.35,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      }).addTo(attMap);
    } else {
      attMapRouteGlow.setLatLngs(latLngs);
      attMapRouteGlow.setStyle({ color: glowColor });
    }
    if (!attMapRoute) {
      attMapRoute = L.polyline(latLngs, {
        color: mainColor,
        weight: 5,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      }).addTo(attMap);
    } else {
      attMapRoute.setLatLngs(latLngs);
      attMapRoute.setStyle({ color: mainColor });
    }
    // Eski to'g'ri chiziqni olib tashlash
    if (attMapLink) {
      try { attMap.removeLayer(attMapLink); } catch (e) {}
      attMapLink = null;
    }
  }

  function scheduleRoadRoute(lat, lng, olat, olng, inside) {
    if (!attMap || !window.L) return;
    const dist = haversineM(lat, lng, olat, olng);
    // Ofis ichida yoki juda yaqin — marshrut kerak emas
    if (inside || dist < 80) {
      clearRoadRoute();
      return;
    }
    const key = routeKey(lat, lng, olat, olng);
    if (key === routeCacheKey && routeCacheLatLngs && routeCacheLatLngs.length > 1) {
      paintRoadRoute(routeCacheLatLngs, inside);
      return;
    }
    if (routeTimer) clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      fetchRoadRoute(lat, lng, olat, olng, inside, key);
    }, 450);
  }

  async function fetchRoadRoute(lat, lng, olat, olng, inside, key) {
    const seq = ++routeSeq;
    try {
      const url =
        OSRM_ROUTE +
        olng + ',' + olat + ';' + lng + ',' + lat +
        '?overview=full&geometries=geojson&steps=false';
      const res = await fetch(url, { method: 'GET' });
      if (!res.ok) throw new Error('route http');
      const data = await res.json();
      if (seq !== routeSeq) return;
      const coords = data && data.routes && data.routes[0] && data.routes[0].geometry && data.routes[0].geometry.coordinates;
      if (!coords || !coords.length) throw new Error('empty');
      // GeoJSON: [lng, lat] → Leaflet [lat, lng]
      const latLngs = coords.map((c) => [c[1], c[0]]);
      routeCacheKey = key;
      routeCacheLatLngs = latLngs;
      paintRoadRoute(latLngs, inside);
    } catch (e) {
      if (seq !== routeSeq) return;
      // Fallback: yumshoq to'g'ri chiziq (faqat agar marshrut olinmasa)
      paintRoadRoute([[olat, olng], [lat, lng]], inside);
    }
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
    if (btn) {
      btn.classList.add('is-active');
      setTimeout(() => btn.classList.remove('is-active'), 450);
      btn.classList.add('is-busy');
    }

    // 1) Darhol oxirgi ma'lum joy
    if (geoLive.lat != null && geoLive.lng != null) {
      forceCenterOnMe(geoLive.lat, geoLive.lng);
    }

    // 2) Eng aniq GPS
    acquireBestGps(12000).then((g) => {
      applyGeoFix(g.lat, g.lng, g.accuracy, { force: true });
      forceCenterOnMe(g.lat, g.lng);
      if (attMapUser) {
        try { attMapUser.openPopup(); } catch (e) {}
      }
      msg(
        'Siz: ' + fmtCoord(g.lat) + ', ' + fmtCoord(g.lng) +
          (geoLive.inside ? ' — ofis hududida' : ' — ofisdan tashqarida'),
        geoLive.inside ? 'ok' : 'info'
      );
    }).catch((e) => {
      if (geoLive.lat != null) {
        forceCenterOnMe(geoLive.lat, geoLive.lng);
        msg('Oxirgi joy saqlangan. ' + (e.message || ''), 'err');
      } else {
        applyGeoError(e);
        showGeoHelp(e.message || 'Joylashuv olinmadi');
        msg(e.message || 'Joylashuv olinmadi', 'err');
      }
    }).finally(() => {
      if (btn) btn.classList.remove('is-busy');
    });
  }

  function attachLocateControl() {
    if (!attMap || !window.L) return;
    if (attMap._vmLocateCtrl) return;
    const Ctrl = L.Control.extend({
      options: { position: 'bottomleft' },
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
    acquireBestGps(10000).then((g) => {
      applyGeoFix(g.lat, g.lng, g.accuracy, { force: true });
      forceCenterOnMe(g.lat, g.lng);
    }).catch((e) => {
      if (geoLive.lat == null) applyGeoError(e);
    });
    geoWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        applyGeoFix(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      },
      (err) => {
        if (geoLive.lat == null) applyGeoError(err);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 25000 }
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
      msg('Aniq joylashuv olinmoqda…', 'info');
      const g = await acquireBestGps(14000);
      forceCenterOnMe(g.lat, g.lng);
      const acc = Math.round(g.accuracy || 0);
      if (geoLive.inside === true) {
        msg('Siz: ' + fmtCoord(g.lat) + ', ' + fmtCoord(g.lng) + ' · ±' + acc + ' m — ofis zonasida. Keldim ochiq.', 'ok');
      } else if (acc > 500) {
        msg('GPS zaif (±' + acc + ' m). Telefonda GPS yoqing, ochiq joyda qayta tekshiring.', 'err');
      } else {
        msg('Siz: ' + fmtCoord(g.lat) + ', ' + fmtCoord(g.lng) + ' · ofisdan ~' + Math.round(geoLive.dist || 0) + ' m.', 'err');
      }
      hideGeoHelp();
      paintGeoUI();
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
    try {
      const el = btnRetry || fidRetryWrap;
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (e) { /* ignore */ }
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
    if (
      geoLive &&
      geoLive.lat != null &&
      geoLive.lng != null &&
      geoLive.ts &&
      (Date.now() - geoLive.ts) < 8000 &&
      (geoLive.accuracy == null || geoLive.accuracy <= 120)
    ) {
      return {
        lat: geoLive.lat,
        lng: geoLive.lng,
        accuracy: geoLive.accuracy
      };
    }
    return acquireBestGps(14000);
  }

  /** Bir necha soniya GPS yig'ib eng aniq nuqtani tanlaydi. */
  function acquireBestGps(maxWaitMs) {
    maxWaitMs = maxWaitMs || 12000;
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(Object.assign(new Error('Joylashuv qo‘llab-quvvatlanmaydi'), { code: 0 }));
        return;
      }
      const samples = [];
      let settled = false;
      let wid = null;
      const finish = async (err) => {
        if (settled) return;
        settled = true;
        if (wid != null) {
          try { navigator.geolocation.clearWatch(wid); } catch (e) {}
        }
        clearTimeout(timer);
        if (samples.length) {
          samples.sort((a, b) => (a.accuracy || 9e9) - (b.accuracy || 9e9));
          const best = samples[0];
          applyGeoFix(best.lat, best.lng, best.accuracy, { force: true });
          resolve(best);
          return;
        }
        if (geoLive.lat != null && geoLive.lng != null) {
          resolve({ lat: geoLive.lat, lng: geoLive.lng, accuracy: geoLive.accuracy });
          return;
        }
        const code = err && err.code;
        const perm = await readGeoPermission();
        reject(Object.assign(new Error(gpsHelpText(code, perm)), { code: code }));
      };
      const timer = setTimeout(() => finish(null), maxWaitMs);
      wid = navigator.geolocation.watchPosition(
        (pos) => {
          const g = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy
          };
          samples.push(g);
          applyGeoFix(g.lat, g.lng, g.accuracy);
          if (g.accuracy != null && g.accuracy <= 35) finish(null);
          else if (g.accuracy != null && g.accuracy <= 60 && samples.length >= 2) finish(null);
        },
        (err) => {
          if (!samples.length && geoLive.lat == null) finish(err);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: maxWaitMs }
      );
      getGpsOnce({ enableHighAccuracy: true, timeout: Math.min(10000, maxWaitMs), maximumAge: 0 })
        .then((g) => {
          samples.push(g);
          applyGeoFix(g.lat, g.lng, g.accuracy);
        })
        .catch(() => {});
    });
  }

  function openModal(title, sub, opts) {
    if (!modal) return;
    opts = opts || {};
    const kind = opts.kind || nextPunchKind() || 'in';
    const punchTitle = kind === 'out' ? 'Ketdim — QR scanner' : 'Keldim — QR scanner';
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('open');
    modal.classList.add('qr-mode');
    document.body.classList.add('fid-lock');
    modalOpen = true;
    pendingScan = null;
    hideFidActions();
    hideRetry();
    const t = document.getElementById('fid-title');
    const s = document.getElementById('fid-sub');
    if (t) t.textContent = title || (opts.qrMode !== false ? punchTitle : 'FACE ID');
    if (s) {
      s.textContent = sub || (opts.qrMode !== false
        ? 'Ofis QR kodini yashil ramka ichiga tuting'
        : '');
    }
    setFidUI({
      status: 'Kamera ochilmoqda…',
      hint: 'QR kodni yashil burchakli ramka ichiga tuting',
      progress: null,
      tone: 'load'
    });
    modal.classList.remove('ok', 'err', 'warn', 'scanning');
  }

  function closeModal() {
    if (abortScan) {
      try { abortScan(); } catch (e) {}
      abortScan = null;
    }
    stopScanPulse();
    stopQrScanner().catch(() => {});
    stopCam();
    pendingScan = null;
    pendingKind = null;
    flowRetry = null;
    hideFidActions();
    hideRetry();
    const holder = document.getElementById('qr-reader');
    if (holder) {
      holder.hidden = true;
      holder.innerHTML = '';
    }
    if (video) video.style.display = '';
    if (!modal) return;
    modal.classList.remove('open', 'ok', 'err', 'warn', 'scanning');
    // qr-mode class HTML da doimiy — olib tashlanmasin
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
    if (scanLoop != null) {
      try { clearTimeout(scanLoop); } catch (e) {}
      try { cancelAnimationFrame(scanLoop); } catch (e) {}
      scanLoop = null;
    }
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

  function statusLabel(s) {
    return ({
      in: 'Kelgan',
      late: 'Kechikdi',
      done: 'Kelgan',
      absent: 'Kelmagan',
      vacation: "Ta'til",
      no_out: 'Kelgan',
      future: '—'
    })[s] || s;
  }

  function statusBadgeClass(s) {
    if (s === 'late') return 'late';
    if (s === 'absent') return 'absent';
    if (s === 'vacation') return 'vacation';
    if (s === 'in' || s === 'done' || s === 'no_out') return 'done';
    return s || '';
  }

  let hbEditRow = null;

  function parseHbEditPayload(raw) {
    const s = String(raw || '').trim();
    if (!s) throw new Error('empty');
    try {
      return JSON.parse(decodeURIComponent(s));
    } catch (e1) {
      return JSON.parse(s);
    }
  }

  function bindHbTableActions(box) {
    if (!box) return;
    if (box._hbEditDelegated) return;
    box._hbEditDelegated = true;
    box.addEventListener('click', (ev) => {
      const el = ev.target && ev.target.closest ? ev.target.closest('[data-hb-edit]') : null;
      if (!el || !box.contains(el)) return;
      ev.preventDefault();
      try {
        openHbEditModal(parseHbEditPayload(el.getAttribute('data-hb-edit')));
      } catch (e) {
        msg('Tahrir ochilmadi', 'err');
      }
    });
  }

  function refreshHisobotBox(box, data) {
    if (!box) return;
    box.innerHTML = renderHisobotHtml(data);
    bindHbTableActions(box);
  }

  function openHbEditModal(row) {
    if (!row || !row.userId) {
      msg('Tahrir ochilmadi (xodim topilmadi)', 'err');
      return;
    }
    hbEditRow = row;
    const modal = document.getElementById('hb-edit-modal');
    const sub = document.getElementById('hb-edit-sub');
    const inEl = document.getElementById('hb-edit-in');
    const outEl = document.getElementById('hb-edit-out');
    const holatEl = document.getElementById('hb-edit-holat');
    const noteEl = document.getElementById('hb-edit-note');
    if (!modal || !sub || !inEl || !outEl || !holatEl || !noteEl) return;
    sub.textContent = (row.name || row.username || 'Xodim') + ' · ' + (row.date || '');
    inEl.value = row.inAt || '';
    outEl.value = row.outAt || '';
    holatEl.value = row.holatMode || 'auto';
    noteEl.value = row.note || '';
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('hb-modal-open');
    inEl.focus();
  }

  function closeHbEditModal() {
    const modal = document.getElementById('hb-edit-modal');
    if (!modal) return;
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('hb-modal-open');
    hbEditRow = null;
  }

  async function saveHbEditModal() {
    if (!hbEditRow) return;
    const inEl = document.getElementById('hb-edit-in');
    const outEl = document.getElementById('hb-edit-out');
    const holatEl = document.getElementById('hb-edit-holat');
    const noteEl = document.getElementById('hb-edit-note');
    const saveBtn = document.getElementById('hb-edit-save');
    if (!inEl || !outEl || !holatEl || !noteEl) return;
    if (saveBtn) saveBtn.disabled = true;
    try {
      await api('/api/attendance/record', {
        method: 'POST',
        body: JSON.stringify({
          userId: hbEditRow.userId,
          date: hbEditRow.date,
          inTime: inEl.value.trim(),
          outTime: outEl.value.trim(),
          holat: holatEl.value,
          note: noteEl.value.trim()
        })
      });
      closeHbEditModal();
      msg('Davomat saqlandi', 'ok');
      await loadHisobot(true);
    } catch (e) {
      msg(e.message || 'Saqlash xato', 'err');
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  function initHbEditModal() {
    const closeBtn = document.getElementById('hb-edit-close');
    const cancelBtn = document.getElementById('hb-edit-cancel');
    const saveBtn = document.getElementById('hb-edit-save');
    const backdrop = document.getElementById('hb-edit-backdrop');
    if (closeBtn) bindTap(closeBtn, closeHbEditModal);
    if (cancelBtn) bindTap(cancelBtn, closeHbEditModal);
    if (backdrop) bindTap(backdrop, closeHbEditModal);
    if (saveBtn) bindTap(saveBtn, () => saveHbEditModal());
  }

  function shiftDateIso(iso, deltaDays) {
    try {
      const p = String(iso).slice(0, 10).split('-').map(Number);
      const d = new Date(p[0], p[1] - 1, p[2]);
      d.setDate(d.getDate() + deltaDays);
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    } catch (e) {
      return iso;
    }
  }

  function renderHisobotHtml(data) {
    if (!data) return `<p class="att-hint">Yuklanmoqda…</p>`;
    const st = data.stats || {};
    const sched = data.schedule || {};
    const showDate = !!data.showDateCol;
    const q = String(hisobotQ || '').trim().toLowerCase();
    const holat = hisobotStatus || 'all';
    let rows = (data.rows || []).slice();
    if (holat !== 'all') {
      rows = rows.filter((r) => {
        if (holat === 'late') return r.status === 'late' || (r.late_in_min || 0) > 0;
        if (holat === 'present') return r.status !== 'absent';
        if (holat === 'absent') return r.status === 'absent';
        if (holat === 'early_in') return (r.early_in_min || 0) > 0;
        if (holat === 'early_out') return (r.early_out_min || 0) > 0;
        if (holat === 'late_out') return (r.late_out_min || 0) > 0;
        return true;
      });
    }
    if (q) {
      rows = rows.filter((r) => {
        const blob = [r.name, r.username, r.lavozim, r.car, roleLabel(r.role)].join(' ').toLowerCase();
        return blob.indexOf(q) >= 0;
      });
    }
    const periodTitle = ({
      day: 'Kunlik davomat',
      week: 'Haftalik davomat',
      month: 'Oylik davomat',
      range: 'Oraliq davomat'
    })[data.period] || 'Davomat';
    const rangeTxt = data.period === 'day'
      ? (data.date || '')
      : ((data.dateFrom || '') + ' — ' + (data.dateTo || ''));

    return `
      <div class="hb-meta">
        <div>
          <div class="hb-title">${esc(periodTitle)} · ${esc(rangeTxt)}</div>
          <div class="hb-sub">Ko‘rsatilmoqda: ${rows.length} yozuv · jami bazada ${st.people != null ? st.people : '—'}</div>
        </div>
        <div class="hb-stats">
          <span class="hb-stat warn"><b>${st.late_in || 0}</b> Kech keldi</span>
          <span class="hb-stat ok"><b>${st.early_in || 0}</b> Erta keldi</span>
          <span class="hb-stat bad"><b>${st.early_out || 0}</b> Erta ketdi</span>
          <span class="hb-stat info"><b>${st.late_out || 0}</b> Kech ketdi</span>
          <span class="hb-stat"><b>Reja</b> ${esc(sched.label || '09:00–18:00')}</span>
        </div>
      </div>
      <div class="scroll-x">
      <table class="att-table hb-table">
        <thead>
          <tr>
            <th>№</th>
            ${showDate ? '<th>Sana</th>' : ''}
            <th>F.I.Sh.</th>
            <th>Lavozim</th>
            <th>Holat</th>
            <th>Kelish</th>
            <th>Ketish</th>
            <th>Ishlagan</th>
            <th>Kech keldi</th>
            <th>Erta keldi</th>
            <th>Erta ketdi</th>
            <th>Kech ketdi</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => `
            <tr>
              <td class="mono">${i + 1}</td>
              ${showDate ? `<td class="mono">${esc(fmtDate(r.date))}</td>` : ''}
              <td><b>${esc(r.name || r.username || '—')}</b>${r.car ? `<div class="att-sub">${esc(r.car)}</div>` : ''}</td>
              <td>${esc(r.lavozim || roleLabel(r.role))}</td>
              <td><span class="att-badge ${esc(statusBadgeClass(r.status))}">${esc(statusLabel(r.status))}</span></td>
              <td class="mono">${r.inAt ? esc(r.inAt) : '—'}</td>
              <td class="mono">${r.outAt ? esc(r.outAt) : '—'}</td>
              <td class="mono">${r.worked_sec != null ? fmtDur(r.worked_sec) : (r.inAt && !r.outAt ? '…' : '0:00')}</td>
              <td class="mono hb-late">${r.late_in_txt ? esc(r.late_in_txt) : '—'}</td>
              <td class="mono hb-early">${r.early_in_txt ? esc(r.early_in_txt) : '—'}</td>
              <td class="mono hb-early-out">${r.early_out_txt ? esc(r.early_out_txt) : '—'}</td>
              <td class="mono hb-late-out">${r.late_out_txt ? esc(r.late_out_txt) : '—'}</td>
              <td><button type="button" class="att-link-btn hb-edit-btn" data-hb-edit="${encodeURIComponent(JSON.stringify({
                userId: r.userId,
                date: r.date,
                name: r.name || r.username,
                inAt: r.inAt || '',
                outAt: r.outAt || '',
                holatMode: r.holatMode || 'auto',
                note: r.note || ''
              }))}" title="Tahrirlash">✎</button></td>
            </tr>`).join('') || `<tr><td colspan="${showDate ? 13 : 12}">Ma’lumot yo‘q</td></tr>`}
        </tbody>
      </table></div>`;
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
              <td><span class="att-badge ${esc(statusBadgeClass(r.status))}">${esc(statusLabel(r.status))}</span></td>
              <td class="mono">${r.inAt || (r.in ? punchTime(r.in) : '—')}${r.late_in_txt ? ' · ' + esc(r.late_in_txt) : ''}</td>
              <td class="mono">${r.outAt || (r.out ? punchTime(r.out) : '—')}</td>
              <td class="mono">${r.worked_sec != null ? fmtDur(r.worked_sec) : (r.in && !r.out ? '…' : '—')}</td>
              <td><button type="button" class="att-link-btn" data-person="${esc(r.userId)}">Oy</button></td>
            </tr>`).join('') || '<tr><td colspan="8">Bo‘sh</td></tr>'}
        </tbody>
      </table></div>`;
  }

  function renderReportHtml(rep) {
    return renderHisobotHtml(HISOBOT);
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
    if (!hisobotDate) hisobotDate = hisobotPeriod === 'month' ? reportMonth : boardDate;
    if (!hisobotFrom) hisobotFrom = boardDate;
    if (!hisobotTo) hisobotTo = boardDate;

    const ticketOk = !!activeQrTicket();
    const needQr = qrRequired();
    const gateOk = punchGateOk();
    const stepGeo = geoLive.inside === true ? 'done' : (geoLive.status === 'err' || geoLive.status === 'out' ? 'now' : 'wait');
    const stepQr = ticketOk ? 'done' : (geoLive.inside === true ? 'now' : 'wait');
    const stepPunch = done ? 'done' : (gateOk ? 'now' : 'wait');
    const nextAction = done
      ? 'Bugun yakunlandi'
      : (!geoLive.inside
        ? 'Ofis zonasiga boring'
        : (needQr && !ticketOk
          ? 'Ofis QR skanerlang'
          : (!inn ? 'Keldimni bosing' : 'Ketdimni bosing')));
    const dayStatus = done ? 'Yakunlangan' : (working ? 'Ishda' : (inn ? 'Kelgan' : 'Kutilmoqda'));
    const pulse = monthPulseFromHistory(history);

    app.innerHTML = `
      <div class="att-tabs" role="tablist" aria-label="Davomat bo‘limlari">
        <button type="button" class="att-tab ${uiTab === 'bugun' ? 'on' : ''}" data-tab="bugun" title="Bugun">
          <span class="att-tab-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></span>
          <span class="att-tab-lbl">Bugun</span>
          <span class="att-tab-abbr">Bu</span>
        </button>
        ${staff ? `<button type="button" class="att-tab ${uiTab === 'dash' ? 'on' : ''}" data-tab="dash" title="Dashboard">
          <span class="att-tab-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/></svg></span>
          <span class="att-tab-lbl">Dashboard</span>
          <span class="att-tab-abbr">Da</span>
        </button>` : ''}
        ${staff ? `<button type="button" class="att-tab ${uiTab === 'hisobot' ? 'on' : ''}" data-tab="hisobot" title="Hisobot">
          <span class="att-tab-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5M4 19h16"/><path d="M8 15v-4M12 15V8M16 15v-7"/></svg></span>
          <span class="att-tab-lbl">Hisobot</span>
          <span class="att-tab-abbr">Hi</span>
        </button>` : ''}
        ${staff ? `<button type="button" class="att-tab ${uiTab === 'shaxs' ? 'on' : ''}" data-tab="shaxs" title="Xodim">
          <span class="att-tab-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="3.5"/><path d="M5 19c1.8-3.2 4.2-4.8 7-4.8S17.2 15.8 19 19"/></svg></span>
          <span class="att-tab-lbl">Xodim</span>
          <span class="att-tab-abbr">Xo</span>
        </button>` : ''}
        <button type="button" class="att-tab ${uiTab === 'tarix' ? 'on' : ''}" data-tab="tarix" title="Tarix">
          <span class="att-tab-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/></svg></span>
          <span class="att-tab-lbl">Tarix</span>
          <span class="att-tab-abbr">Ta</span>
        </button>
        ${staff ? `<button type="button" class="att-tab ${uiTab === 'soz' ? 'on' : ''}" data-tab="soz" title="Sozlamalar">
          <span class="att-tab-ico" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4l1.4-1.4M17 7l1.4-1.4"/></svg></span>
          <span class="att-tab-lbl">Sozlamalar</span>
          <span class="att-tab-abbr">So</span>
        </button>` : ''}
      </div>

      <div class="att-panel" id="panel-bugun" ${uiTab === 'bugun' ? '' : 'hidden'}>
        <div class="av-studio av-pro">

          <section class="av-stage">
            <div class="av-stage-main">
              <div class="av-stage-mark">VAKSINA · DAVOMAT</div>
              <h2 class="av-stage-title">Kunni <em>aniq</em><br>belgilang</h2>
              <p class="av-stage-lead">Ofis radiusiga kiring — Keldim / Ketdim ochiladi. GPS geozona bilan nazorat.</p>
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
            ${needQr ? `<li class="av-step ${stepQr}" data-step="qr"><span class="n">02</span><div><b>Ofis QR</b><small>Devordagi kod</small></div></li>` : ''}
            <li class="av-step ${stepPunch}" data-step="punch"><span class="n">${needQr ? '03' : '02'}</span><div><b>Stamp</b><small>Keldi / Ketdi</small></div></li>
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
                  <div class="av-map-sub">Faqat yashil doira ichida Keldim / Ketdim ochiladi</div>
                </div>
                <span class="av-geo-badge load" id="av-geo-badge">Joylashuv…</span>
              </div>
              <div class="av-map-wrap">
                <div class="av-map" id="av-map"></div>
                <div class="av-map-legend">
                  <span><i class="lg-office"></i> Ofis</span>
                  <span><i class="lg-zone"></i> ${esc(String(off.radius))} m</span>
                  <span><i class="lg-you"></i> Siz</span>
                  <span><i class="lg-acc"></i> Aniqlik</span>
                  <span><i class="lg-route"></i> Yo‘l</span>
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
                  <span class="av-qr-pill ${gateOk ? 'on' : ''}" id="av-qr-pill">${needQr ? (ticketOk ? 'QR faol' : 'QR kutilyapti') : (geoLive.inside ? 'Zona OK' : 'Zona kutilyapti')}</span>
                </div>
                <p class="av-punch-hint">${needQr ? 'Zona → QR → Keldi/Ketdi.' : 'Ofis radiusiga kiring — Keldim / Ketdim ochiladi. QR kerak emas.'}</p>
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
                  <small>${needQr ? 'Zona ichida QR skanerlash' : 'Radius ichida stamp ochiladi'}</small>
                </button>
                <p class="av-ticket-hint" id="av-qr-ticket-hint">${needQr
                  ? (ticketOk ? 'QR ruxsati faol (~10 daq). Endi Keldim yoki Ketdim.' : 'QR hali skanerlanmagan.')
                  : (geoLive.inside ? 'Radius ichidasiz — Keldim / Ketdim ochiq.' : 'Ofis radiusiga kiring — tugmalar ochiladi.')}</p>
              </section>

              <section class="av-howto">
                <h3>Qanday ishlaydi</h3>
                <ul>
                  <li><b>1.</b> Ofis ${esc(String(off.radius))} m ichiga kiring (telefonda GPS)</li>
                  ${needQr ? '<li><b>2.</b> Devordagi ofis QR ni skanerlang</li><li><b>3.</b> Keldim / Ketdim ni bosing</li>' : '<li><b>2.</b> Keldim / Ketdim tugmasini bosing</li>'}
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
        <section class="att-card hb-card">
          <div class="att-card-h">
            <span>Davomat hisoboti</span>
          </div>
          <div class="att-card-b">
            <div class="hb-period" role="tablist" aria-label="Davr turi">
              <button type="button" class="hb-period-btn ${hisobotPeriod === 'day' ? 'on' : ''}" data-hb-period="day">Kunlik</button>
              <button type="button" class="hb-period-btn ${hisobotPeriod === 'week' ? 'on' : ''}" data-hb-period="week">Haftalik</button>
              <button type="button" class="hb-period-btn ${hisobotPeriod === 'month' ? 'on' : ''}" data-hb-period="month">Oylik</button>
              <button type="button" class="hb-period-btn ${hisobotPeriod === 'range' ? 'on' : ''}" data-hb-period="range">Sanadan–gacha</button>
            </div>
            <div class="hb-filters">
              <label class="hb-fld hb-date-wrap ${hisobotPeriod === 'range' ? 'hidden' : ''}">
                <span>Sana</span>
                <div class="hb-date-nav">
                  <button type="button" class="hb-nav" id="hb-prev" aria-label="Oldingi">‹</button>
                  <input type="${hisobotPeriod === 'month' ? 'month' : 'date'}" id="hb-date" value="${esc(hisobotPeriod === 'month' ? monthInputValue(hisobotDate || reportMonth) : dayInputValue(hisobotDate || boardDate))}">
                  <button type="button" class="hb-nav" id="hb-next" aria-label="Keyingi">›</button>
                </div>
              </label>
              <label class="hb-fld ${hisobotPeriod === 'range' ? '' : 'hidden'}">
                <span>Dan</span>
                <input type="date" id="hb-from" value="${esc(hisobotFrom || dayInputValue(boardDate))}">
              </label>
              <label class="hb-fld ${hisobotPeriod === 'range' ? '' : 'hidden'}">
                <span>Gacha</span>
                <input type="date" id="hb-to" value="${esc(hisobotTo || dayInputValue(boardDate))}">
              </label>
              <label class="hb-fld">
                <span>Holat</span>
                <select id="hb-status">
                  <option value="all" ${hisobotStatus === 'all' ? 'selected' : ''}>Barchasi</option>
                  <option value="present" ${hisobotStatus === 'present' ? 'selected' : ''}>Kelgan</option>
                  <option value="late" ${hisobotStatus === 'late' ? 'selected' : ''}>Kechikdi</option>
                  <option value="absent" ${hisobotStatus === 'absent' ? 'selected' : ''}>Kelmagan</option>
                  <option value="early_in" ${hisobotStatus === 'early_in' ? 'selected' : ''}>Erta keldi</option>
                  <option value="early_out" ${hisobotStatus === 'early_out' ? 'selected' : ''}>Erta ketdi</option>
                  <option value="late_out" ${hisobotStatus === 'late_out' ? 'selected' : ''}>Kech ketdi</option>
                </select>
              </label>
              <label class="hb-fld hb-search">
                <span>Qidiruv</span>
                <input type="search" id="hb-q" placeholder="Ism, lavozim…" value="${esc(hisobotQ)}">
              </label>
              <button type="button" class="att-btn att-btn-face" id="btn-report">Yangilash</button>
              <button type="button" class="att-btn att-btn-in" id="btn-export-xlsx">Excel</button>
              <button type="button" class="att-btn att-btn-out" id="btn-export-pdf">PDF</button>
            </div>
            <div id="att-report"><p class="att-hint">Yuklanmoqda…</p></div>
          </div>
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
    if (staff && uiTab === 'hisobot') loadHisobot();
    if (staff && uiTab === 'shaxs') loadPersonPanel();
    if (staff && uiTab === 'soz') renderSettings();
    if (working) startLiveTimer();
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

    app.querySelectorAll('[data-hb-period]').forEach((btn) => {
      bindTap(btn, () => {
        hisobotPeriod = btn.getAttribute('data-hb-period') || 'day';
        if (hisobotPeriod === 'month' && hisobotDate && hisobotDate.length === 10) {
          hisobotDate = hisobotDate.slice(0, 7);
        }
        if (hisobotPeriod !== 'month' && hisobotDate && hisobotDate.length === 7) {
          hisobotDate = hisobotDate + '-01';
        }
        render();
      });
    });
    const hbDate = document.getElementById('hb-date');
    const hbFrom = document.getElementById('hb-from');
    const hbTo = document.getElementById('hb-to');
    const hbStatus = document.getElementById('hb-status');
    const hbQ = document.getElementById('hb-q');
    const hbPrev = document.getElementById('hb-prev');
    const hbNext = document.getElementById('hb-next');
    if (hbDate) {
      hbDate.addEventListener('change', () => {
        hisobotDate = hbDate.value || hisobotDate;
        if (hisobotPeriod === 'month') reportMonth = hisobotDate;
        else boardDate = hisobotDate;
        loadHisobot(true);
      });
    }
    if (hbFrom) hbFrom.addEventListener('change', () => { hisobotFrom = hbFrom.value || hisobotFrom; loadHisobot(true); });
    if (hbTo) hbTo.addEventListener('change', () => { hisobotTo = hbTo.value || hisobotTo; loadHisobot(true); });
    if (hbStatus) hbStatus.addEventListener('change', () => {
      hisobotStatus = hbStatus.value || 'all';
      const box = document.getElementById('att-report');
      if (box && HISOBOT) refreshHisobotBox(box, HISOBOT);
    });
    if (hbQ) {
      let t = null;
      hbQ.addEventListener('input', () => {
        hisobotQ = hbQ.value || '';
        clearTimeout(t);
        t = setTimeout(() => {
          const box = document.getElementById('att-report');
          if (box && HISOBOT) refreshHisobotBox(box, HISOBOT);
        }, 180);
      });
    }
    if (hbPrev) bindTap(hbPrev, () => {
      if (hisobotPeriod === 'month') {
        const m = (hisobotDate || reportMonth || '').slice(0, 7);
        const [y, mo] = m.split('-').map(Number);
        const d = new Date(y, mo - 2, 1);
        hisobotDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        reportMonth = hisobotDate;
      } else {
        const step = hisobotPeriod === 'week' ? -7 : -1;
        hisobotDate = shiftDateIso(hisobotDate || boardDate, step);
        boardDate = hisobotDate;
      }
      loadHisobot(true);
      if (hbDate) hbDate.value = hisobotPeriod === 'month' ? monthInputValue(hisobotDate) : dayInputValue(hisobotDate);
    });
    if (hbNext) bindTap(hbNext, () => {
      if (hisobotPeriod === 'month') {
        const m = (hisobotDate || reportMonth || '').slice(0, 7);
        const [y, mo] = m.split('-').map(Number);
        const d = new Date(y, mo, 1);
        hisobotDate = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
        reportMonth = hisobotDate;
      } else {
        const step = hisobotPeriod === 'week' ? 7 : 1;
        hisobotDate = shiftDateIso(hisobotDate || boardDate, step);
        boardDate = hisobotDate;
      }
      loadHisobot(true);
      if (hbDate) hbDate.value = hisobotPeriod === 'month' ? monthInputValue(hisobotDate) : dayInputValue(hisobotDate);
    });

    if (reportBtn) bindTap(reportBtn, () => {
      if (hbDate) hisobotDate = hbDate.value || hisobotDate;
      if (hbFrom) hisobotFrom = hbFrom.value || hisobotFrom;
      if (hbTo) hisobotTo = hbTo.value || hisobotTo;
      loadHisobot(true);
    });
    const xlsxBtn = document.getElementById('btn-export-xlsx');
    const pdfBtn = document.getElementById('btn-export-pdf');
    if (xlsxBtn) bindTap(xlsxBtn, () => exportHisobotXlsx());
    if (pdfBtn) bindTap(pdfBtn, () => exportHisobotPdf());
    const px = document.getElementById('btn-person-xlsx');
    const pp = document.getElementById('btn-person-pdf');
    if (px) bindTap(px, () => exportPersonXlsx());
    if (pp) bindTap(pp, () => exportPersonPdf());
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
      const action = cont.getAttribute('data-action') || 'punch';
      const kind = nextPunchKind() || cont.getAttribute('data-next') || 'in';
      if (action === 'punch' || (!qrRequired() && punchGateOk())) {
        confirmPunch(kind);
        return;
      }
      if (action === 'choose' && activeQrTicket()) {
        openModal(
          kind === 'out' ? 'Ketdim' : 'Keldim',
          'Keldim yoki Ketdim tugmasini bosing',
          { qrMode: true, kind }
        );
        pendingKind = null;
        showFidActions();
        return;
      }
      startQrScanFlow();
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
    stopScanLoop();
    stopCam();
  }

  async function startQrScanFlow(forcedKind) {
    if (busy) return;
    busy = true;
    clearMsg();
    warmQrLib();
    const kind = forcedKind || nextPunchKind() || 'in';
    pendingKind = null;
    openModal(
      'Ofis QR scanner',
      'Ofis QR kodini yashil ramka ichiga tuting',
      { qrMode: true }
    );
    flowRetry = () => startQrScanFlow(forcedKind);
    try {
      const gpsPromise = getGps().catch((e) => e);
      setFidUI({
        status: 'QR qidirilmoqda…',
        hint: 'QR kodni yashil burchakli ramka ichiga tuting',
        progress: null,
        tone: 'scan'
      });
      const payload = await scanOfficeQrPayload();
      stopScanPulse();
      setFidUI({ status: 'Tasdiqlanmoqda…', hint: 'Ofis QR va joylashuv', progress: null, tone: 'load' });
      const gpsOrErr = await gpsPromise;
      if (!gpsOrErr || gpsOrErr instanceof Error || gpsOrErr.lat == null) {
        throw new Error((gpsOrErr && gpsOrErr.message) || 'Joylashuv olinmadi — ofis zonasida qayta urining');
      }
      const r = await api('/api/attendance/qr/verify', {
        method: 'POST',
        body: JSON.stringify({
          payload,
          lat: gpsOrErr.lat,
          lng: gpsOrErr.lng,
          accuracy: gpsOrErr.accuracy
        })
      });
      qrTicketLocal = {
        ticket: r.qrTicket,
        exp: r.exp,
        expiresInSec: r.expiresInSec
      };
      if (STATE) STATE.qrTicket = qrTicketLocal;
      await stopQrScanner();
      geoLive.inside = true;
      geoLive.status = 'ok';
      geoLive.lat = gpsOrErr.lat;
      geoLive.lng = gpsOrErr.lng;
      geoLive.accuracy = gpsOrErr.accuracy;
      // Avto-punch yo‘q — foydalanuvchi Keldim/Ketdim ni o‘zi bosadi
      pendingKind = null;
      const tEl = document.getElementById('fid-title');
      const sEl = document.getElementById('fid-sub');
      if (tEl) tEl.textContent = 'Ofis QR tasdiqlandi';
      if (sEl) sEl.textContent = 'Endi Keldim yoki Ketdim ni tanlang';
      setFidUI({
        status: 'Tayyor',
        hint: 'Keldim yoki Ketdim tugmasini bosing',
        progress: null,
        tone: 'ok'
      });
      if (modal) {
        modal.classList.add('ok');
        modal.classList.remove('scanning', 'err');
      }
      paintGeoUI();
      busy = false;
      showFidActions();
      return;
    } catch (e) {
      stopScanPulse();
      await stopQrScanner();
      const text = e.message || 'QR xato';
      if (modal) { modal.classList.add('err'); modal.classList.remove('ok', 'scanning'); }
      setFidUI({ status: 'FAILED', hint: text, progress: null, tone: 'err' });
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
        stopScanPulse();
        if (err) reject(err);
        else resolve(val);
      };
      abortScan = () => done(new Error('Bekor qilindi'));

      const accept = (raw) => {
        const text = String(raw || '').trim();
        if (!text) return;
        if (!/VMATT1\.\d+\./i.test(text)) {
          setFidUI({
            status: 'Noto‘g‘ri QR',
            hint: 'Bu ofis QR emas — to‘g‘ri kodni tuting',
            progress: null,
            tone: 'warn'
          });
          return;
        }
        done(null, text);
      };

      const startHtml5 = async () => {
        await loadScriptOnce(HTML5_QR);
        if (!window.Html5Qrcode) throw new Error('QR skaner yuklanmadi — internetni tekshiring');
        const holder = document.getElementById('qr-reader');
        if (!holder) throw new Error('QR oyna topilmadi');
        holder.hidden = false;
        holder.innerHTML = '';
        if (video) video.style.display = 'none';
        if (modal) modal.classList.add('scanning', 'qr-mode');
        startScanPulse();
        html5Qr = new window.Html5Qrcode('qr-reader', { verbose: false });
        const camId = await pickBackCameraId();
        const formats = (window.Html5QrcodeSupportedFormats)
          ? [window.Html5QrcodeSupportedFormats.QR_CODE]
          : undefined;
        // To‘liq kadr + yuqori fps — qrbox ikkinchi oq ramka va sekinlik berardi
        const config = {
          fps: 30,
          aspectRatio: 1,
          disableFlip: false,
          experimentalFeatures: { useBarCodeDetectorIfSupported: true }
        };
        if (formats) config.formatsToSupport = formats;
        const cameraConfig = camId
          ? { deviceId: { exact: camId } }
          : { facingMode: { ideal: 'environment' } };
        await html5Qr.start(cameraConfig, config, (decoded) => accept(decoded), () => {});
        // Kutubxona oq ramkasini DOM dan ham olib tashlash
        try {
          const shade = document.getElementById('qr-shaded-region');
          if (shade) shade.remove();
          const dash = document.getElementById('qr-reader__dashboard');
          if (dash) dash.remove();
        } catch (eHide) { /* ignore */ }
      };

      try {
        // Native BarcodeDetector — barcha platformada birinchi (tez)
        if (window.BarcodeDetector) {
          try {
            const supported = await window.BarcodeDetector.getSupportedFormats();
            if (!supported || supported.includes('qr_code')) {
              await startCam();
              if (modal) modal.classList.add('scanning', 'qr-mode');
              startScanPulse();
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
                } catch (e) { /* keep */ }
                scanLoop = setTimeout(tick, 24);
              };
              tick();
              return;
            }
          } catch (eNative) {
            stopCam();
          }
        }
        await startHtml5();
      } catch (e) {
        done(e);
      }
    });
  }

  /** Geozona OK (va kerak bo‘lsa QR) → Keldim/Ketdim */
  async function startAttendanceFlow(kind) {
    if (qrRequired() && !activeQrTicket()) {
      await startQrScanFlow();
      return;
    }
    await confirmPunch(kind);
  }

  async function confirmPunch(kind) {
    if (qrRequired()) {
      const ticket = activeQrTicket();
      if (!ticket) {
        msg('Avval ofis QR ni skanerlang', 'err');
        return;
      }
    }
    if (geoLive.inside !== true) {
      msg('Faqat ofis radiusida ochiladi — «Qayta tekshirish» bosing', 'err');
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
      if (!modalOpen) openModal(kind === 'in' ? 'KELDIM' : 'KETDIM', 'Davomat yozilmoqda', { qrMode: !!qrRequired() });
      const gps = await getGps();
      if (geoLive.inside !== true) {
        throw new Error('Hali ofis zonasida emassiz. GPS aniqlanishini kuting yoki ochiq joyda qayta tekshiring.');
      }
      const body = {
        kind,
        lat: gps.lat,
        lng: gps.lng,
        accuracy: gps.accuracy
      };
      if (qrRequired()) {
        const ticket = activeQrTicket();
        if (!ticket) throw new Error('Avval ofis QR ni skanerlang');
        body.qrTicket = ticket.ticket;
      }
      const r = await api('/api/attendance/punch', {
        method: 'POST',
        body: JSON.stringify(body)
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
      if (/QR|skaner|ruxsat/i.test(text) && qrRequired()) {
        qrTicketLocal = null;
        if (STATE) STATE.qrTicket = null;
      }
      showRetry(text);
      flowRetry = () => {
        if (/QR|skaner|ruxsat/i.test(text) && qrRequired()) startQrScanFlow();
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

  async function loadHisobot(force) {
    const box = document.getElementById('att-report');
    if (!box) return;
    const period = hisobotPeriod || 'day';
    let date = hisobotDate || boardDate || dayInputValue('');
    if (period === 'month') {
      date = monthInputValue(date.length === 7 ? date : (date || reportMonth).slice(0, 7));
      hisobotDate = date;
      reportMonth = date;
    } else if (period !== 'range') {
      date = dayInputValue(date);
      hisobotDate = date;
      boardDate = date;
    }
    const from = dayInputValue(hisobotFrom || boardDate);
    const to = dayInputValue(hisobotTo || boardDate);
    hisobotFrom = from;
    hisobotTo = to;

    const cacheKey = [period, date, from, to].join('|');
    if (!force && HISOBOT && HISOBOT._cacheKey === cacheKey) {
      refreshHisobotBox(box, HISOBOT);
      return;
    }
    box.innerHTML = `<p class="att-hint">Yuklanmoqda…</p>`;
    try {
      let url = '/api/attendance/hisobot?period=' + encodeURIComponent(period);
      if (period === 'range') {
        url += '&from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
      } else {
        url += '&date=' + encodeURIComponent(date);
      }
      const d = await api(url);
      d._cacheKey = cacheKey;
      HISOBOT = d;
      refreshHisobotBox(box, d);
    } catch (e) {
      box.innerHTML = `<p class="att-hint">${esc(e.message || 'Hisobot xato')}</p>`;
    }
  }

  async function loadReport(force) {
    return loadHisobot(force);
  }

  function filteredHisobotRows() {
    if (!HISOBOT) return [];
    const q = String(hisobotQ || '').trim().toLowerCase();
    const holat = hisobotStatus || 'all';
    let rows = (HISOBOT.rows || []).slice();
    if (holat !== 'all') {
      rows = rows.filter((r) => {
        if (holat === 'late') return r.status === 'late' || (r.late_in_min || 0) > 0;
        if (holat === 'present') return r.status !== 'absent';
        if (holat === 'absent') return r.status === 'absent';
        if (holat === 'early_in') return (r.early_in_min || 0) > 0;
        if (holat === 'early_out') return (r.early_out_min || 0) > 0;
        if (holat === 'late_out') return (r.late_out_min || 0) > 0;
        return true;
      });
    }
    if (q) {
      rows = rows.filter((r) => {
        const blob = [r.name, r.username, r.lavozim, r.car, roleLabel(r.role)].join(' ').toLowerCase();
        return blob.indexOf(q) >= 0;
      });
    }
    return rows;
  }

  function hisobotExportMeta() {
    const d = HISOBOT || {};
    const st = d.stats || {};
    const sched = d.schedule || {};
    const periodTitle = ({
      day: 'Kunlik davomat',
      week: 'Haftalik davomat',
      month: 'Oylik davomat',
      range: 'Oraliq davomat'
    })[d.period] || 'Davomat hisoboti';
    const rangeTxt = d.period === 'day'
      ? (d.date || '')
      : ((d.dateFrom || '') + ' — ' + (d.dateTo || ''));
    return {
      brand: 'VAKSINA MED · DAVOMAT',
      title: periodTitle,
      range: rangeTxt,
      schedule: sched.label || '09:00–18:00',
      stats: st,
      showDate: !!d.showDateCol,
      generated: (typeof dayInputValue === 'function' ? dayInputValue('') : new Date().toISOString().slice(0, 10))
    };
  }

  function xStyle(partial) {
    return Object.assign({
      font: { name: 'Calibri', sz: 10, color: { rgb: '0F172A' } },
      alignment: { vertical: 'center', horizontal: 'left', wrapText: true },
      border: {
        top: { style: 'thin', color: { rgb: 'E2E8F0' } },
        bottom: { style: 'thin', color: { rgb: 'E2E8F0' } },
        left: { style: 'thin', color: { rgb: 'E2E8F0' } },
        right: { style: 'thin', color: { rgb: 'E2E8F0' } }
      }
    }, partial || {});
  }

  function xCell(v, style) {
    const isNum = typeof v === 'number' && Number.isFinite(v);
    const cell = { v: v == null ? '' : v, t: isNum ? 'n' : 's' };
    if (!isNum) cell.v = String(cell.v);
    if (style) cell.s = style;
    return cell;
  }

  function applyColWidths(ws, widths) {
    ws['!cols'] = widths.map((w) => ({ wch: w }));
  }

  function applyRowHeights(ws, map) {
    ws['!rows'] = ws['!rows'] || [];
    Object.keys(map).forEach((k) => {
      ws['!rows'][Number(k)] = { hpt: map[k] };
    });
  }

  function statusFillRgb(status) {
    const s = String(status || '');
    if (s === 'absent' || s === 'Kelmagan') return 'FEE2E2';
    if (s === 'late' || s === 'Kechikdi') return 'FFEDD5';
    if (s === 'present' || s === 'ok' || s === 'Kelgan' || s === 'Ishda') return 'DCFCE7';
    if (s === 'working') return 'DBEAFE';
    return 'F8FAFC';
  }

  function exportHisobotXlsx() {
    if (typeof XLSX === 'undefined') {
      msg('Excel kutubxonasi yuklanmadi', 'err');
      return;
    }
    if (!HISOBOT) {
      msg('Avval hisobotni yuklang', 'err');
      return;
    }
    const meta = hisobotExportMeta();
    const rowsData = filteredHisobotRows();
    const st = meta.stats || {};
    const colCount = meta.showDate ? 11 : 10;
    const lastCol = colCount - 1;

    const headLabels = ['№'];
    if (meta.showDate) headLabels.push('Sana');
    headLabels.push('F.I.Sh.', 'Lavozim', 'Holat', 'Kelish', 'Ketish', 'Ishlagan', 'Kech keldi', 'Erta keldi', 'Erta ketdi', 'Kech ketdi');

    const brandStyle = xStyle({
      font: { name: 'Calibri', sz: 11, bold: true, color: { rgb: 'FFFFFF' } },
      fill: { patternType: 'solid', fgColor: { rgb: '0B1F3A' } },
      alignment: { horizontal: 'left', vertical: 'center' },
      border: {
        top: { style: 'thin', color: { rgb: '0B1F3A' } },
        bottom: { style: 'thin', color: { rgb: '0B1F3A' } },
        left: { style: 'thin', color: { rgb: '0B1F3A' } },
        right: { style: 'thin', color: { rgb: '0B1F3A' } }
      }
    });
    const titleStyle = xStyle({
      font: { name: 'Calibri', sz: 16, bold: true, color: { rgb: '0B1F3A' } },
      fill: { patternType: 'solid', fgColor: { rgb: 'EFF6FF' } },
      alignment: { horizontal: 'left', vertical: 'center' }
    });
    const subStyle = xStyle({
      font: { name: 'Calibri', sz: 10, color: { rgb: '475569' } },
      fill: { patternType: 'solid', fgColor: { rgb: 'F8FAFC' } }
    });
    const kpiStyle = xStyle({
      font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: '1E3A5F' } },
      fill: { patternType: 'solid', fgColor: { rgb: 'F1F5F9' } },
      alignment: { horizontal: 'center', vertical: 'center' }
    });
    const headStyle = xStyle({
      font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
      fill: { patternType: 'solid', fgColor: { rgb: '1A5FB4' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true }
    });
    const center = { horizontal: 'center', vertical: 'center', wrapText: true };

    const aoa = [];
    // Row 0 — brand
    aoa.push(Array.from({ length: colCount }, (_, i) =>
      xCell(i === 0 ? meta.brand : '', brandStyle)
    ));
    // Row 1 — title
    aoa.push(Array.from({ length: colCount }, (_, i) =>
      xCell(i === 0 ? (meta.title + (meta.range ? '  ·  ' + meta.range : '')) : '', titleStyle)
    ));
    // Row 2 — meta
    aoa.push(Array.from({ length: colCount }, (_, i) =>
      xCell(
        i === 0
          ? ('Yaratilgan: ' + (meta.generated || '') + '  |  Reja: ' + meta.schedule + '  |  Yozuvlar: ' + rowsData.length)
          : '',
        subStyle
      )
    ));
    // Row 3 — KPIs
    const kpiLine = [
      'Kech keldi: ' + (st.late_in || 0),
      'Erta keldi: ' + (st.early_in || 0),
      'Erta ketdi: ' + (st.early_out || 0),
      'Kech ketdi: ' + (st.late_out || 0),
      'Jami: ' + (st.people != null ? st.people : rowsData.length)
    ];
    aoa.push(Array.from({ length: colCount }, (_, i) =>
      xCell(kpiLine[i] || '', kpiStyle)
    ));
    // Row 4 — blank
    aoa.push(Array.from({ length: colCount }, () => xCell('', xStyle({
      fill: { patternType: 'solid', fgColor: { rgb: 'FFFFFF' } },
      border: {
        top: { style: 'thin', color: { rgb: 'FFFFFF' } },
        bottom: { style: 'thin', color: { rgb: 'FFFFFF' } },
        left: { style: 'thin', color: { rgb: 'FFFFFF' } },
        right: { style: 'thin', color: { rgb: 'FFFFFF' } }
      }
    }))));
    // Row 5 — headers
    aoa.push(headLabels.map((h) => xCell(h, headStyle)));

    rowsData.forEach((r, i) => {
      const zebra = i % 2 === 0 ? 'FFFFFF' : 'F8FAFC';
      const statusTxt = statusLabel(r.status);
      const base = xStyle({
        fill: { patternType: 'solid', fgColor: { rgb: zebra } },
        alignment: center
      });
      const nameStyle = xStyle({
        fill: { patternType: 'solid', fgColor: { rgb: zebra } },
        font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: '0F172A' } },
        alignment: { horizontal: 'left', vertical: 'center' }
      });
      const statusStyle = xStyle({
        fill: { patternType: 'solid', fgColor: { rgb: statusFillRgb(r.status) } },
        font: { name: 'Calibri', sz: 10, bold: true, color: { rgb: '0F172A' } },
        alignment: center
      });
      const line = [xCell(i + 1, base)];
      if (meta.showDate) line.push(xCell(r.date || '', base));
      line.push(
        xCell(r.name || r.username || '', nameStyle),
        xCell(r.lavozim || roleLabel(r.role), base),
        xCell(statusTxt, statusStyle),
        xCell(r.inAt || '—', base),
        xCell(r.outAt || '—', base),
        xCell(r.worked_sec != null ? fmtDur(r.worked_sec) : '—', base),
        xCell(r.late_in_txt || '—', base),
        xCell(r.early_in_txt || '—', base),
        xCell(r.early_out_txt || '—', base),
        xCell(r.late_out_txt || '—', base)
      );
      aoa.push(line);
    });

    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: lastCol } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: lastCol } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: lastCol } }
    ];
    const widths = meta.showDate
      ? [5, 12, 22, 14, 12, 10, 10, 10, 11, 11, 11]
      : [5, 22, 14, 12, 10, 10, 10, 11, 11, 11];
    applyColWidths(ws, widths);
    applyRowHeights(ws, { 0: 24, 1: 28, 2: 20, 3: 22, 5: 26 });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Hisobot');
    const fname = 'davomat-hisobot-' + String(meta.range || meta.generated || 'export').replace(/[^\d\-]+/g, '_').slice(0, 32) + '.xlsx';
    XLSX.writeFile(wb, fname);
    msg('Excel yuklandi', 'ok');
  }

  function exportHisobotPdf() {
    const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!JsPDF) {
      msg('PDF kutubxonasi yuklanmadi', 'err');
      return;
    }
    if (!HISOBOT) {
      msg('Avval hisobotni yuklang', 'err');
      return;
    }
    const meta = hisobotExportMeta();
    const st = meta.stats || {};
    const doc = new JsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const margin = 28;

    // Header bar
    doc.setFillColor(11, 31, 58);
    doc.rect(0, 0, pageW, 52, 'F');
    doc.setFillColor(26, 95, 180);
    doc.rect(0, 52, pageW, 3, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(9);
    doc.text(meta.brand, margin, 20);
    doc.setFontSize(15);
    doc.text(meta.title, margin, 40);
    doc.setFontSize(9);
    doc.text(meta.range || '', pageW - margin, 40, { align: 'right' });

    // KPI chips
    let y = 68;
    doc.setFontSize(8);
    const chips = [
      { label: 'Kech keldi', val: st.late_in || 0, rgb: [245, 158, 11] },
      { label: 'Erta keldi', val: st.early_in || 0, rgb: [22, 163, 74] },
      { label: 'Erta ketdi', val: st.early_out || 0, rgb: [220, 38, 38] },
      { label: 'Kech ketdi', val: st.late_out || 0, rgb: [124, 58, 237] },
      { label: 'Reja', val: meta.schedule, rgb: [30, 64, 175] }
    ];
    let x = margin;
    chips.forEach((c) => {
      const txt = c.label + ': ' + c.val;
      const w = doc.getTextWidth(txt) + 16;
      doc.setFillColor(c.rgb[0], c.rgb[1], c.rgb[2]);
      doc.roundedRect(x, y, w, 16, 3, 3, 'F');
      doc.setTextColor(255, 255, 255);
      doc.text(txt, x + 8, y + 11);
      x += w + 8;
    });

    const head = ['№'];
    if (meta.showDate) head.push('Sana');
    head.push('F.I.Sh.', 'Lavozim', 'Holat', 'Kelish', 'Ketish', 'Ish', 'Kech', 'Erta', 'E.ket', 'K.ket');
    const body = filteredHisobotRows().map((r, i) => {
      const line = [String(i + 1)];
      if (meta.showDate) line.push(r.date || '');
      line.push(
        r.name || r.username || '',
        r.lavozim || roleLabel(r.role),
        statusLabel(r.status),
        r.inAt || '—',
        r.outAt || '—',
        r.worked_sec != null ? fmtDur(r.worked_sec) : '—',
        r.late_in_txt || '—',
        r.early_in_txt || '—',
        r.early_out_txt || '—',
        r.late_out_txt || '—'
      );
      return line;
    });

    if (doc.autoTable) {
      doc.autoTable({
        startY: 96,
        head: [head],
        body,
        margin: { left: margin, right: margin },
        styles: {
          fontSize: 8,
          cellPadding: 4,
          lineColor: [226, 232, 240],
          lineWidth: 0.4,
          textColor: [15, 23, 42],
          valign: 'middle'
        },
        headStyles: {
          fillColor: [26, 95, 180],
          textColor: [255, 255, 255],
          fontStyle: 'bold',
          halign: 'center'
        },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        columnStyles: {
          0: { halign: 'center', cellWidth: 28 }
        },
        didParseCell: (data) => {
          if (data.section !== 'body') return;
          const holatIdx = meta.showDate ? 4 : 3;
          if (data.column.index === holatIdx) {
            const v = String(data.cell.raw || '');
            if (/Kelmagan|absent/i.test(v)) {
              data.cell.styles.fillColor = [254, 226, 226];
              data.cell.styles.fontStyle = 'bold';
            } else if (/Kech|late/i.test(v)) {
              data.cell.styles.fillColor = [255, 237, 213];
              data.cell.styles.fontStyle = 'bold';
            } else if (/Kelgan|Ishda|present|ok/i.test(v)) {
              data.cell.styles.fillColor = [220, 252, 231];
            }
          }
        },
        didDrawPage: (data) => {
          doc.setFontSize(8);
          doc.setTextColor(100, 116, 139);
          doc.text(
            'VAKSINA MED · Davomat hisoboti · ' + (meta.generated || ''),
            margin,
            pageH - 14
          );
          doc.text(
            'Sahifa ' + doc.internal.getNumberOfPages(),
            pageW - margin,
            pageH - 14,
            { align: 'right' }
          );
        }
      });
    }
    const fname = 'davomat-hisobot-' + String(meta.range || meta.generated || 'export').replace(/[^\d\-]+/g, '_').slice(0, 32) + '.pdf';
    doc.save(fname);
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
              <h3 class="att-qr-title">Ofis QR</h3>
              <p class="att-qr-lead">Chop etish · PNG · PDF</p>
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
          <div class="fld"><label>Radius (m)</label><input id="s-radius" type="number" value="${esc(o.radius_m || 100)}"></div>
          <div class="fld"></div>
        </div>
        ${canSeeOfficeCoords() ? `
        <div class="row2">
          <div class="fld"><label>Ofis lat</label><input id="s-lat" value="${esc(o.lat || '')}"></div>
          <div class="fld"><label>Ofis lng</label><input id="s-lng" value="${esc(o.lng || '')}"></div>
        </div>
        <p class="att-hint">Koordinata faqat Admin Pro uchun. Oddiy admin ko‘ra olmaydi.</p>
        ` : `
        <p class="att-hint">Ofis koordinatasi yashirilgan (faqat Admin Pro sozlaydi). Geozona serverda tekshiriladi.</p>
        `}
        <button type="button" class="att-btn att-btn-in" id="btn-save-set" style="margin-top:8px">Saqlash</button>
        ${canSeeOfficeCoords() ? `<button type="button" class="att-btn att-btn-face" id="btn-here" style="margin-top:8px">Hozirgi joyimni ofis qil</button>` : ''}
      `;
      document.getElementById('btn-save-set').onclick = saveSettings;
      const btnHere = document.getElementById('btn-here');
      if (btnHere) {
        btnHere.onclick = async () => {
          try {
            const g = await getGps();
            document.getElementById('s-lat').value = String(g.lat);
            document.getElementById('s-lng').value = String(g.lng);
            msg('Lat/lng yozildi — Saqlash bosing', 'info');
          } catch (e) { msg(e.message, 'err'); }
        };
      }
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

  function loadImage(src, opts) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (!opts || opts.cors !== false) img.crossOrigin = 'anonymous';
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

  /** Premium GPS QR: oraliqli nuqtalar + radar finder + markaz pin */
  function drawGpsStyleQr(ctx, modules, size, opts) {
    const n = modules.size;
    const marginMods = 3;
    const total = n + marginMods * 2;
    const cell = size / total;
    const dark = (opts && opts.dark) || '#071525';
    const accent = (opts && opts.accent) || '#0ea5e9';
    const accent2 = (opts && opts.accent2) || '#0369a1';
    const light = (opts && opts.light) || '#f8fbff';

    // Map-like panel
    const panel = ctx.createLinearGradient(0, 0, size, size);
    panel.addColorStop(0, '#f0f7ff');
    panel.addColorStop(0.5, '#ffffff');
    panel.addColorStop(1, '#e8f2fc');
    ctx.fillStyle = panel;
    ctx.fillRect(0, 0, size, size);

    // Soft grid under modules
    ctx.strokeStyle = 'rgba(14,165,233,0.07)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= total; i++) {
      const p = i * cell;
      ctx.beginPath();
      ctx.moveTo(p, 0);
      ctx.lineTo(p, size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, p);
      ctx.lineTo(size, p);
      ctx.stroke();
    }

    function isOn(x, y) {
      if (x < 0 || y < 0 || x >= n || y >= n) return false;
      try {
        return !!modules.get(x, y);
      } catch (e) {
        return !!(modules.data && modules.data[y * n + x]);
      }
    }

    function inFinder(x, y) {
      return (x < 7 && y < 7) || (x >= n - 7 && y < 7) || (x < 7 && y >= n - 7);
    }

    function inCenterLogo(x, y) {
      const c = (n - 1) / 2;
      return Math.abs(x - c) <= 3.2 && Math.abs(y - c) <= 3.2;
    }

    // Data: aniq oraliqli “sputnik” nuqtalari (bir-biriga yopishmasin)
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (!isOn(x, y) || inFinder(x, y) || inCenterLogo(x, y)) continue;
        const cx = (x + marginMods + 0.5) * cell;
        const cy = (y + marginMods + 0.5) * cell;
        const r = cell * 0.30;
        // capsule connect right/down for liquid look
        if (isOn(x + 1, y) && !inFinder(x + 1, y) && !inCenterLogo(x + 1, y)) {
          ctx.fillStyle = dark;
          roundRect(ctx, cx - r, cy - r, cell + r * 2, r * 2, r);
          ctx.fill();
        }
        if (isOn(x, y + 1) && !inFinder(x, y + 1) && !inCenterLogo(x, y + 1)) {
          ctx.fillStyle = dark;
          roundRect(ctx, cx - r, cy - r, r * 2, cell + r * 2, r);
          ctx.fill();
        }
        ctx.fillStyle = dark;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Finder = GPS “locator” eyes
    function drawLocator(ox, oy) {
      const px = (ox + marginMods) * cell;
      const py = (oy + marginMods) * cell;
      const s = cell * 7;
      const cx = px + s / 2;
      const cy = py + s / 2;
      const R = cell * 0.9;

      // Outer dark rounded plate
      ctx.fillStyle = dark;
      roundRect(ctx, px, py, s, s, R);
      ctx.fill();
      // Cyan ring frame
      ctx.strokeStyle = accent;
      ctx.lineWidth = Math.max(2, cell * 0.22);
      roundRect(ctx, px + cell * 0.35, py + cell * 0.35, s - cell * 0.7, s - cell * 0.7, R * 0.75);
      ctx.stroke();
      // Inner white well
      ctx.fillStyle = light;
      roundRect(ctx, px + cell, py + cell, cell * 5, cell * 5, R * 0.55);
      ctx.fill();
      // Radar rings
      ctx.strokeStyle = 'rgba(14,165,233,0.45)';
      ctx.lineWidth = Math.max(1.2, cell * 0.12);
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 1.85, 0, Math.PI * 2);
      ctx.stroke();
      // Core
      const core = ctx.createRadialGradient(cx - cell * 0.2, cy - cell * 0.2, 1, cx, cy, cell * 1.4);
      core.addColorStop(0, '#7dd3fc');
      core.addColorStop(0.55, accent);
      core.addColorStop(1, accent2);
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 1.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(cx, cy, cell * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }

    drawLocator(0, 0);
    drawLocator(n - 7, 0);
    drawLocator(0, n - 7);

    // Center GPS pin (ECC H bilan skanlanadi)
    const cc = (marginMods + (n - 1) / 2 + 0.5) * cell;
    const pinR = cell * 2.5;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cc, cc, pinR + cell * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(14,165,233,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(cc, cc + cell * 2.35);
    ctx.bezierCurveTo(cc + cell * 1.6, cc + cell * 0.6, cc + cell * 1.55, cc - cell * 0.9, cc, cc - cell * 1.55);
    ctx.bezierCurveTo(cc - cell * 1.55, cc - cell * 0.9, cc - cell * 1.6, cc + cell * 0.6, cc, cc + cell * 2.35);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cc, cc - cell * 0.35, cell * 0.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = accent2;
    ctx.beginPath();
    ctx.arc(cc, cc - cell * 0.35, cell * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }

  async function makeQrBitmapFromServer(size, version) {
    const tmp = document.createElement('canvas');
    tmp.width = size;
    tmp.height = size;
    const ctx = tmp.getContext('2d');
    const scale = Math.max(8, Math.min(16, Math.round(size / 40)));
    const url = '/api/attendance/qr/image?scale=' + scale +
      '&v=' + encodeURIComponent(String(version || 1)) +
      '&t=' + Date.now();
    const img = await loadImage(url, { cors: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, 0, 0, size, size);
    return tmp;
  }

  async function makeQrBitmap(payload, size, meta) {
    // 1) Same-origin server PNG — CDN/DNS kerak emas (ofis plakat asosiy yo‘l)
    try {
      return await makeQrBitmapFromServer(size, meta && meta.version);
    } catch (e0) {
      console.warn('Server QR PNG fallback:', e0);
    }

    const tmp = document.createElement('canvas');
    tmp.width = size;
    tmp.height = size;
    const ctx = tmp.getContext('2d');
    let eng = null;
    try {
      eng = await ensureQrLib();
      const lib = eng.lib || window.QRCode || window.qrcode;
      if (lib && typeof lib.create === 'function') {
        const qr = lib.create(payload, { errorCorrectionLevel: 'H' });
        if (!qr || !qr.modules) throw new Error('QR matrix yo‘q');
        drawGpsStyleQr(ctx, qr.modules, size, {});
        return tmp;
      }
      await loadScriptOnce(QR_LIB);
      const lib2 = window.QRCode || window.qrcode;
      if (lib2 && typeof lib2.create === 'function') {
        const qr = lib2.create(payload, { errorCorrectionLevel: 'H' });
        drawGpsStyleQr(ctx, qr.modules, size, {});
        return tmp;
      }
      throw new Error('QR create API yo‘q');
    } catch (e) {
      console.warn('GPS QR draw fallback:', e);
      try {
        if (eng && eng.type === 'toCanvas' && eng.lib && typeof eng.lib.toCanvas === 'function') {
          await eng.lib.toCanvas(tmp, payload, {
            width: size,
            margin: 2,
            errorCorrectionLevel: 'H',
            color: { dark: '#071525', light: '#ffffff' }
          });
          return tmp;
        }
        const ctorEng = eng && eng.Ctor ? eng : await ensureQrLib();
        if (ctorEng && ctorEng.Ctor) return await makeQrViaCtor(ctorEng.Ctor, payload, size);
        if (typeof window.QRCode === 'function') return await makeQrViaCtor(window.QRCode, payload, size);
      } catch (e2) { /* last resort below */ }
      const url = 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size +
        '&margin=8&ecc=H&color=071525&bgcolor=ffffff&data=' + encodeURIComponent(payload);
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
    const H = 780;
    poster.width = W;
    poster.height = H;
    const ctx = poster.getContext('2d');

    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#050d18');
    bg.addColorStop(0.55, '#0a1a30');
    bg.addColorStop(1, '#0c223c');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Subtle radar arcs (atmosphere, not text)
    ctx.strokeStyle = 'rgba(14,165,233,0.12)';
    ctx.lineWidth = 1.5;
    for (let i = 1; i <= 4; i++) {
      ctx.beginPath();
      ctx.arc(W / 2, H * 0.46, 70 + i * 55, 0, Math.PI * 2);
      ctx.stroke();
    }
    const glow = ctx.createRadialGradient(W / 2, H * 0.46, 30, W / 2, H * 0.46, 340);
    glow.addColorStop(0, 'rgba(14,165,233,0.22)');
    glow.addColorStop(1, 'rgba(14,165,233,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const qrSize = 480;
    const qx = (W - qrSize) / 2;
    const qy = 88;

    // Floating glass frame
    ctx.fillStyle = 'rgba(255,255,255,0.04)';
    roundRect(ctx, qx - 40, qy - 40, qrSize + 80, qrSize + 80, 36);
    ctx.fill();
    ctx.strokeStyle = 'rgba(125,211,252,0.28)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, qx - 40, qy - 40, qrSize + 80, qrSize + 80, 36);
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    roundRect(ctx, qx - 18, qy - 18, qrSize + 36, qrSize + 36, 28);
    ctx.fill();

    const qrBmp = await makeQrBitmap(payload, qrSize, qr);
    ctx.drawImage(qrBmp, qx, qy, qrSize, qrSize);

    // Faqat bitta brend satri
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(186,230,253,0.92)';
    ctx.font = '700 15px IBM Plex Sans, Arial, sans-serif';
    ctx.fillText('VaksinaMed GPS Office', W / 2, qy + qrSize + 58);
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
      const office = {
        radius_m: document.getElementById('s-radius').value,
        label: document.getElementById('s-label').value
      };
      const latEl = document.getElementById('s-lat');
      const lngEl = document.getElementById('s-lng');
      if (canSeeOfficeCoords() && latEl && lngEl) {
        office.lat = latEl.value;
        office.lng = lngEl.value;
      }
      const body = {
        in_start: document.getElementById('s-in-start').value,
        late_grace_min: Number(document.getElementById('s-grace').value || 15),
        in_late_after: document.getElementById('s-late').value,
        out_start: document.getElementById('s-out-start').value,
        out_end: document.getElementById('s-out-end').value,
        require_face: false,
        require_qr: false,
        office
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
    initHbEditModal();
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
      warmQrLib();
    } catch (e) {
      app.innerHTML = `<p class="att-loading">${esc(e.message || 'Xato')}</p>`;
    }
  }

  boot();
})();
