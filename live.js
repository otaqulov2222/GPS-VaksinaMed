'use strict';

const LIVE = {
  map: null,
  markers: {},
  trails: {},
  trailLayers: {},
  arrowLayers: {},
  units: [],
  selected: null,
  timer: null,
  pollMs: 3000,
  fetching: false,
  lastPos: {},
  lastCourse: {},
  trailMax: 36,
  motion: {},
  motionTimer: null,
};

const LIVE_KIND_SRC = {
  truck: '/assets/live/icon-truck.png?v=3',
  damas: '/assets/live/icon-damas.png?v=3',
  labo: '/assets/live/icon-labo.png?v=3',
};

/* Ikonka faylida old tomon YUQORIGA qaragan (0° = shimol). */
const LIVE_ICON_BASE_DEG = 0;

const LIVE_HEAD_SVG =
  '<svg class="live-head-svg" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M12 3 L19 15 L12 12 L5 15 Z" fill="#22c55e" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/>' +
  '</svg>';
const LIVE_ARROW_SVG = LIVE_HEAD_SVG;

function liveNormKind(k) {
  const s = String(k || '').toLowerCase();
  if (s === 'damas' || s === 'labo' || s === 'truck') return s;
  return 'truck';
}

function liveUnitImg(kind, status) {
  const src = LIVE_KIND_SRC[liveNormKind(kind)] || LIVE_KIND_SRC.truck;
  return (
    '<img class="live-unit-img ' + (status || '') + '" src="' + src + '"' +
    ' alt="" draggable="false">'
  );
}

function liveEl(id) {
  return document.getElementById(id);
}

function liveStatusLabel(st) {
  if (st === 'moving') return 'Harakatda';
  if (st === 'stopped') return 'Turgan';
  return 'Offline';
}

function liveFmtAge(sec) {
  if (sec == null || sec < 0) return '—';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + ' daq';
  return Math.floor(sec / 3600) + ' soat';
}

function liveFmtTime(unix) {
  if (!unix) return '—';
  try {
    const d = new Date(unix * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  } catch (e) {
    return '—';
  }
}

function livePlateShort(car) {
  const s = String(car || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/);
  if (parts.length >= 2) return parts.slice(0, 3).join(' ');
  return s.slice(-6);
}

function liveBearing(from, to) {
  if (!from || !to) return 0;
  const toRad = Math.PI / 180;
  const lat1 = from[0] * toRad;
  const lat2 = to[0] * toRad;
  const dLng = (to[1] - from[1]) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function liveCourse(unit, key) {
  const prev = LIVE.lastPos[key];
  const now = unit.pos ? [Number(unit.pos.lat), Number(unit.pos.lng)] : null;
  if (prev && now && (Math.abs(prev[0] - now[0]) > 2e-6 || Math.abs(prev[1] - now[1]) > 2e-6)) {
    return liveBearing(prev, now);
  }
  const apiCourse = Number(unit.pos && unit.pos.course);
  const spd = Number(unit.pos && unit.pos.speed) || 0;
  if (Number.isFinite(apiCourse) && apiCourse >= 0 && (apiCourse > 0 || spd > 2)) {
    return apiCourse;
  }
  return LIVE.lastCourse[key] || 0;
}

function livePinIcon(unit, course) {
  const st = unit.status || 'offline';
  const kind = liveNormKind(unit.kind);
  const label = livePlateShort(unit.car || unit.name);
  const rot = ((Number(course) || 0) + LIVE_ICON_BASE_DEG + 360) % 360;
  const spd = Math.round(Number(unit.pos && unit.pos.speed) || 0);
  const html =
    '<div class="live-marker ' + st + ' kind-' + kind + '">' +
    '<div class="live-unit" style="transform:rotate(' + rot + 'deg)">' +
    liveUnitImg(kind, st) +
    (st === 'moving' ? '<span class="live-head">' + LIVE_HEAD_SVG + '</span>' : '') +
    '</div>' +
    '<div class="live-plate-txt">' + label + '</div>' +
    (st === 'moving'
      ? '<div class="live-spd-chip">' + spd + ' km/h</div>'
      : '') +
    '</div>';
  return L.divIcon({
    className: 'live-pin leaflet-div-icon',
    html: html,
    iconSize: [78, 96],
    iconAnchor: [39, 44],
  });
}

function liveArrowIcon(course) {
  return L.divIcon({
    className: 'live-arrow-pin leaflet-div-icon',
    html: '<div class="live-dir-arrow" style="transform:rotate(' + (Number(course) || 0) + 'deg)">' + LIVE_ARROW_SVG + '</div>',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function liveInitMap() {
  if (LIVE.map) return;
  const el = liveEl('live-map');
  if (!el || typeof L === 'undefined') return;
  LIVE.map = L.map(el, {
    zoomControl: true,
    attributionControl: false,
  }).setView([41.3111, 69.2797], 12);
  if (typeof vmAddMapTiles === 'function') vmAddMapTiles(LIVE.map);
  else {
    L.tileLayer('https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '',
    }).addTo(LIVE.map);
  }
  setTimeout(() => {
    try { LIVE.map.invalidateSize(); } catch (e) {}
  }, 200);
}


function liveOffsetByCourse(lat, lng, courseDeg, speedKmh, dtSec) {
  const distM = Math.max(0, (Number(speedKmh) || 0) * (1000 / 3600) * Math.max(0, dtSec));
  if (distM < 0.15) return [lat, lng];
  const brng = (Number(courseDeg) || 0) * Math.PI / 180;
  const R = 6371000;
  const lat1 = lat * Math.PI / 180;
  const lng1 = lng * Math.PI / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distM / R) +
    Math.cos(lat1) * Math.sin(distM / R) * Math.cos(brng)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(distM / R) * Math.cos(lat1),
    Math.cos(distM / R) - Math.sin(lat1) * Math.sin(lat2)
  );
  return [lat2 * 180 / Math.PI, lng2 * 180 / Math.PI];
}

function liveMotionTick() {
  if (!LIVE.map || document.hidden) return;
  const now = performance.now();
  Object.keys(LIVE.motion).forEach((key) => {
    const mot = LIVE.motion[key];
    const m = LIVE.markers[key];
    if (!mot || !m || mot.status !== 'moving') return;
    const spd = Number(mot.speed) || 0;
    if (spd < 3) return;
    const dt = Math.min(1.2, (now - (mot.t0 || now)) / 1000);
    mot.t0 = now;
    const cur = m.getLatLng();
    const next = liveOffsetByCourse(cur.lat, cur.lng, mot.course, spd * 0.85, dt);
    try { m.setLatLng(next); } catch (e) {}
  });
}

function liveStartMotion() {
  if (LIVE.motionTimer) return;
  LIVE.motionTimer = setInterval(liveMotionTick, 200);
}

function liveAnimateMarker(marker, toLatLng, ms) {
  const from = marker.getLatLng();
  const to = L.latLng(toLatLng[0], toLatLng[1]);
  if (from.distanceTo(to) < 0.8) {
    marker.setLatLng(to);
    return;
  }
  const dur = Math.max(500, Math.min(ms || 1200, LIVE.pollMs - 200));
  const t0 = performance.now();
  if (marker._liveAnim) cancelAnimationFrame(marker._liveAnim);
  function step(now) {
    const t = Math.min(1, (now - t0) / dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    marker.setLatLng([
      from.lat + (to.lat - from.lat) * e,
      from.lng + (to.lng - from.lng) * e,
    ]);
    if (t < 1) marker._liveAnim = requestAnimationFrame(step);
  }
  marker._liveAnim = requestAnimationFrame(step);
}

function livePushTrail(key, ll, status) {
  if (!LIVE.trails[key]) LIVE.trails[key] = [];
  const arr = LIVE.trails[key];
  const last = arr[arr.length - 1];
  if (!last || Math.abs(last[0] - ll[0]) > 1e-6 || Math.abs(last[1] - ll[1]) > 1e-6) {
    arr.push([ll[0], ll[1]]);
  }
  while (arr.length > LIVE.trailMax) arr.shift();
  if (status !== 'moving' && arr.length > 6) {
    LIVE.trails[key] = arr.slice(-6);
  }
}

function liveClearTrailVisual(key) {
  if (LIVE.trailLayers[key]) {
    try { LIVE.map.removeLayer(LIVE.trailLayers[key]); } catch (e) {}
    delete LIVE.trailLayers[key];
  }
  if (LIVE.arrowLayers[key]) {
    try { LIVE.map.removeLayer(LIVE.arrowLayers[key]); } catch (e) {}
    delete LIVE.arrowLayers[key];
  }
}

function liveDrawTrail(key, status, course) {
  if (!LIVE.map) return;
  liveClearTrailVisual(key);
  const pts = LIVE.trails[key];
  if (!pts || pts.length < 2 || status !== 'moving') return;

  const glow = L.polyline(pts, {
    color: '#7dff9a',
    weight: 7,
    opacity: 0.22,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false,
  });
  const line = L.polyline(pts, {
    color: '#1db954',
    weight: 3,
    opacity: 0.88,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false,
  });
  const group = L.layerGroup([glow, line]).addTo(LIVE.map);
  LIVE.trailLayers[key] = group;

  const arrows = [];
  const step = Math.max(1, Math.floor(pts.length / 5));
  for (let i = step; i < pts.length - 1; i += step) {
    const a = pts[i - 1];
    const b = pts[i];
    const brg = liveBearing(a, b);
    arrows.push(L.marker(b, {
      icon: liveArrowIcon(brg),
      interactive: false,
      keyboard: false,
      zIndexOffset: 200,
    }));
  }
  if (pts.length >= 2) {
    const tip = pts[pts.length - 1];
    arrows.push(L.marker(tip, {
      icon: liveArrowIcon(course),
      interactive: false,
      keyboard: false,
      zIndexOffset: 250,
    }));
  }
  LIVE.arrowLayers[key] = L.layerGroup(arrows).addTo(LIVE.map);
}

function liveUpsertMarker(unit) {
  if (!LIVE.map || !unit || !unit.pos) return;
  const key = String(unit.car || unit.id || unit.name);
  const ll = [Number(unit.pos.lat), Number(unit.pos.lng)];
  if (!ll[0] || !ll[1]) return;
  const course = liveCourse(unit, key);
  LIVE.lastCourse[key] = course;
  const spd = Math.round(Number(unit.pos.speed) || 0);
  const popup =
    '<div style="min-width:180px;font-family:IBM Plex Sans,sans-serif">' +
    '<div style="font:700 13px IBM Plex Mono,monospace;margin-bottom:4px">' + (unit.car || unit.name) + '</div>' +
    '<div style="color:#5a7190;font-size:12px;margin-bottom:8px">' + (unit.driver || '—') + '</div>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">' +
    '<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px;background:' +
    (unit.status === 'moving' ? '#dff3e6;color:#147a32' : unit.status === 'stopped' ? '#e3eef9;color:#1a5fb4' : '#eef2f6;color:#6b7f96') +
    '">' + liveStatusLabel(unit.status) + '</span>' +
    '<span style="font:700 14px IBM Plex Mono,monospace;color:' + (unit.status === 'moving' ? '#147a32' : '#0b1f3a') + '">' + spd + ' km/h</span>' +
    '</div>' +
    '<div style="color:#8aa0b8;font-size:11px">Signal: ' + liveFmtTime(unit.pos.time) +
    ' · ' + liveFmtAge(unit.ageSec) +
    (course ? ' · ' + Math.round(course) + '°' : '') +
    '</div></div>';

  let m = LIVE.markers[key];
  try {
    if (m) {
      liveAnimateMarker(m, ll, unit.status === 'moving' ? Math.min(LIVE.pollMs - 100, 2400) : 450);
      m.setIcon(livePinIcon(unit, course));
      m.setZIndexOffset(unit.status === 'moving' ? 1400 : 400);
      m.setPopupContent(popup);
    } else {
      m = L.marker(ll, {
        icon: livePinIcon(unit, course),
        zIndexOffset: unit.status === 'moving' ? 1400 : 400,
      }).addTo(LIVE.map).bindPopup(popup);
      m.on('click', () => liveSelect(key, false));
      LIVE.markers[key] = m;
    }
  } catch (e) {
    console.warn('live marker', key, e);
  }

  LIVE.lastPos[key] = ll;
  LIVE.motion[key] = {
    status: unit.status,
    speed: Number(unit.pos.speed) || 0,
    course: course,
    t0: performance.now(),
  };
  if (unit.status !== 'moving') delete LIVE.motion[key];

  try {
    livePushTrail(key, ll, unit.status);
    liveDrawTrail(key, unit.status, course);
  } catch (e) {
    console.warn('live trail', key, e);
  }
  liveStartMotion();
}

function liveFitAll() {
  if (!LIVE.map) return;
  const pts = [];
  LIVE.units.forEach((u) => {
    if (u.pos && u.pos.lat && u.pos.lng) pts.push([u.pos.lat, u.pos.lng]);
  });
  if (pts.length > 1) {
    try {
      LIVE.map.fitBounds(L.latLngBounds(pts), { padding: [48, 48], maxZoom: 14 });
    } catch (e) {}
  } else if (pts.length === 1) {
    LIVE.map.setView(pts[0], 14);
  }
}

function liveSelect(key, pan) {
  LIVE.selected = key;
  document.querySelectorAll('.live-row').forEach((row) => {
    row.classList.toggle('on', row.getAttribute('data-key') === key);
  });
  const unit = LIVE.units.find((u) => String(u.car || u.id || u.name) === key);
  if (unit && unit.pos && LIVE.map && pan !== false) {
    LIVE.map.setView([unit.pos.lat, unit.pos.lng], Math.max(LIVE.map.getZoom(), 15));
    const m = LIVE.markers[key];
    if (m) m.openPopup();
  }
}

function liveFiltered() {
  const q = String((liveEl('live-q') && liveEl('live-q').value) || '').trim().toLowerCase();
  if (!q) return LIVE.units.slice();
  return LIVE.units.filter((u) => {
    const blob = [u.car, u.name, u.driver, u.short].join(' ').toLowerCase();
    return blob.indexOf(q) >= 0;
  });
}

function liveRenderList() {
  const box = liveEl('live-list');
  if (!box) return;
  const rows = liveFiltered();
  if (!rows.length) {
    box.innerHTML = '<div class="live-empty">Mashina topilmadi</div>';
    return;
  }
  box.innerHTML = rows.map((u) => {
    const key = String(u.car || u.id || u.name);
    const spd = u.pos ? Math.round(Number(u.pos.speed) || 0) : 0;
    const st = u.status || 'offline';
    const avClass = st === 'moving' ? 'move' : st === 'stopped' ? 'stop' : 'off';
    const badge =
      '<span class="live-badge ' + avClass + '">' +
      (st === 'moving' ? '<i class="pulse"></i>' : '') +
      liveStatusLabel(st) +
      '</span>';
    return (
      '<div class="live-row' +
      (LIVE.selected === key ? ' on' : '') +
      (st === 'moving' ? ' is-moving' : '') +
      '" data-key="' + key.replace(/"/g, '') + '">' +
      '<div class="live-avatar ' + avClass + '">' + liveUnitImg(u.kind || 'truck', st) + '</div>' +
      '<div><div class="live-car">' + (u.car || u.name || '—') + '</div>' +
      '<div class="live-drv"><span>' + (u.driver || '—') + '</span>' + badge + '</div></div>' +
      '<div class="live-meta"><div class="spd' + (st === 'moving' ? ' hot' : '') + '">' +
      (u.pos ? spd + ' km/h' : '—') + '</div>' +
      '<div>' + liveFmtAge(u.ageSec) + '</div></div>' +
      '</div>'
    );
  }).join('');

  box.querySelectorAll('.live-row').forEach((row) => {
    row.addEventListener('click', () => liveSelect(row.getAttribute('data-key'), true));
  });
}

function liveRenderCounts(counts) {
  const c = counts || {};
  const set = (id, v) => { const el = liveEl(id); if (el) el.textContent = String(v != null ? v : 0); };
  set('live-n-move', c.moving);
  set('live-n-stop', c.stopped);
  set('live-n-off', c.offline);
}

function liveSetClock(msg) {
  const el = liveEl('live-clock');
  if (!el) return;
  const txt = el.querySelector('.live-clock-txt');
  if (txt) txt.textContent = msg || '—';
  else el.textContent = msg || '—';
}

function liveRemoveUnit(key) {
  if (LIVE.markers[key]) {
    try { LIVE.map.removeLayer(LIVE.markers[key]); } catch (e) {}
    delete LIVE.markers[key];
  }
  liveClearTrailVisual(key);
  delete LIVE.trails[key];
  delete LIVE.lastPos[key];
  delete LIVE.lastCourse[key];
  delete LIVE.motion[key];
}

async function liveFetch() {
  if (LIVE.fetching) return;
  LIVE.fetching = true;
  const refreshBtn = liveEl('live-refresh');
  if (refreshBtn) refreshBtn.classList.add('is-busy');
  try {
    const d = await vmApi('/api/office/gps/live');
    if (!d || d.ok === false) {
      liveSetClock(d && d.error ? d.error : 'GPS xato');
      const box = liveEl('live-list');
      if (box && !LIVE.units.length) {
        box.innerHTML = '<div class="live-empty">' +
          (d && d.error ? d.error : 'GPS sozlanmagan yoki ulanmadi') +
          '</div>';
      }
      return;
    }
    LIVE.units = Array.isArray(d.units) ? d.units : [];
    liveRenderCounts(d.counts);
    liveRenderList();

    liveInitMap();
    const keep = {};
    LIVE.units.forEach((u) => {
      if (u.pos) {
        const key = String(u.car || u.id || u.name);
        keep[key] = true;
        liveUpsertMarker(u);
      }
    });
    Object.keys(LIVE.markers).forEach((k) => {
      if (!keep[k]) liveRemoveUnit(k);
    });

    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const moving = (d.counts && d.counts.moving) || 0;
    liveSetClock(
      'Yangilandi ' + pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) +
      ' · ' + LIVE.units.length + ' mashina' +
      (moving ? ' · ' + moving + ' harakatda' : '')
    );

    if (!LIVE._fittedOnce && LIVE.units.some((u) => u.pos)) {
      LIVE._fittedOnce = true;
      liveFitAll();
    }
  } catch (e) {
    liveSetClock(String(e.message || e).slice(0, 80));
  } finally {
    LIVE.fetching = false;
    if (refreshBtn) refreshBtn.classList.remove('is-busy');
  }
}

function liveStartPoll() {
  if (LIVE.timer) clearInterval(LIVE.timer);
  LIVE.timer = setInterval(liveFetch, LIVE.pollMs);
}

async function liveBoot() {
  try {
    const user = await vmMe();
    vmGatePage(user);
    if (typeof vmApplyChrome === 'function') vmApplyChrome(user);
    else vmApplyRoleNav(user);
    const nameEl = liveEl('tb-user-name');
    if (nameEl) nameEl.textContent = (user && (user.name || user.username)) || '—';
  } catch (e) {
    return;
  }

  liveInitMap();
  liveEl('live-refresh')?.addEventListener('click', () => liveFetch());
  liveEl('live-fit')?.addEventListener('click', () => liveFitAll());
  liveEl('live-q')?.addEventListener('input', () => liveRenderList());

  await liveFetch();
  liveStartPoll();
  liveStartMotion();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (LIVE.timer) { clearInterval(LIVE.timer); LIVE.timer = null; }
      if (LIVE.motionTimer) { clearInterval(LIVE.motionTimer); LIVE.motionTimer = null; }
    } else {
      liveFetch();
      liveStartPoll();
      liveStartMotion();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', liveBoot);
} else {
  liveBoot();
}
