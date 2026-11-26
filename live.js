'use strict';

const LIVE = {
  map: null,
  markers: {},
  clusters: null,
  spiderLinks: null,
  units: [],
  filter: 'all',
  selected: null,
  follow: false,
  basemap: 'street',
  satLayer: null,
  timer: null,
  pollMs: 5000,
  fetching: false,
  lastPos: {},
  lastCourse: {},
  renderState: {},
  rafId: null,
  layoutTimer: null,
  renderedPos: {},
};

const LIVE_TOP_SRC = {
  isuzu: '/assets/live/top-isuzu.webp?v=1',
  labo: '/assets/live/top-labo.webp?v=1',
  changan: '/assets/live/top-changan.webp?v=1',
  damas: '/assets/live/top-damas.webp?v=1',
  cobalt: '/assets/live/top-cobalt.webp?v=1',
  lacetti: '/assets/live/top-lacetti.webp?v=1',
  onix: '/assets/live/top-onix.webp?v=1',
};

const LIVE_MODEL_LABELS = {
  isuzu: 'Isuzu Furgon',
  labo: 'Daewoo Labo',
  changan: 'Changan Star',
  damas: 'Chevrolet Damas',
  cobalt: 'Chevrolet Cobalt',
  lacetti: 'Chevrolet Lacetti',
  onix: 'Chevrolet Onix',
};

function liveEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function liveNormKind(k) {
  const s = String(k || '').toLowerCase();
  if (s === 'damas' || s === 'labo' || s === 'truck' || s === 'car') return s;
  return 'truck';
}

function liveUnitModel(unit) {
  const plate = (unit && (unit.car || unit.name)) || '';
  if (typeof fleetModelOf === 'function') {
    const m = fleetModelOf(plate);
    if (m && LIVE_TOP_SRC[m]) return m;
  }
  const kind = liveNormKind(unit && unit.kind);
  if (kind === 'car') return 'cobalt';
  if (kind === 'damas') return 'damas';
  if (kind === 'labo') return 'labo';
  return 'isuzu';
}

function liveModelLabel(unit) {
  const m = liveUnitModel(unit);
  if (typeof FLEET_MODELS !== 'undefined' && FLEET_MODELS[m] && FLEET_MODELS[m].t) {
    return FLEET_MODELS[m].t;
  }
  return LIVE_MODEL_LABELS[m] || 'Maxsus avto';
}

function liveTopImgHtml(model) {
  const m = LIVE_TOP_SRC[model] ? model : 'isuzu';
  return (
    '<img class="live-top-img" src="' + LIVE_TOP_SRC[m] + '"' +
    ' alt="" draggable="false">'
  );
}

function liveListPhotoHtml(unit) {
  const m = liveUnitModel(unit);
  if (typeof FLEET_MODELS !== 'undefined' && FLEET_MODELS[m] && FLEET_MODELS[m].src) {
    return (
      '<img class="live-list-photo" src="' + FLEET_MODELS[m].src + '"' +
      ' alt="' + liveEsc(FLEET_MODELS[m].t) + '" draggable="false">'
    );
  }
  return (
    '<img class="live-list-photo" src="' + (LIVE_TOP_SRC[m] || LIVE_TOP_SRC.isuzu) + '"' +
    ' alt="" draggable="false">'
  );
}

function liveEl(id) {
  return document.getElementById(id);
}

function liveUnitKey(u) {
  return String((u && (u.car || u.id || u.name)) || '');
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

function liveCompassLabel(deg) {
  if (!Number.isFinite(deg)) return '—';
  const dirs = ['Sh', 'Sh-Shq', 'Shq', 'J-Shq', 'J', 'J-G‘', 'G‘', 'Sh-G‘'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8;
  return Math.round(((deg % 360) + 360) % 360) + '° · ' + dirs[idx];
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

function liveDistMeters(a, b) {
  if (!a || !b) return 0;
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLng = (b[1] - a[1]) * toRad;
  const lat1 = a[0] * toRad;
  const lat2 = b[0] * toRad;
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function liveForwardProjMeters(a, b, deg) {
  const toRad = Math.PI / 180;
  const meanLat = ((a[0] + b[0]) * 0.5) * toRad;
  const dNorth = (b[0] - a[0]) * 111320;
  const dEast = (b[1] - a[1]) * 111320 * Math.cos(meanLat);
  const rad = (Number(deg) || 0) * toRad;
  return dNorth * Math.cos(rad) + dEast * Math.sin(rad);
}

function liveWrapDelta(fromDeg, toDeg) {
  return ((toDeg - fromDeg) % 360 + 540) % 360 - 180;
}

function liveCourse(unit, key) {
  const apiCourse = Number(unit.pos && unit.pos.course);
  const spd = Number(unit.pos && unit.pos.speed) || 0;
  if (Number.isFinite(apiCourse) && apiCourse >= 0 && (apiCourse > 0 || spd > 2)) {
    return apiCourse;
  }
  const prev = LIVE.lastPos[key];
  const now = unit.pos ? [Number(unit.pos.lat), Number(unit.pos.lng)] : null;
  if (prev && now && liveDistMeters(prev, now) > 18) {
    return liveBearing(prev, now);
  }
  return LIVE.lastCourse[key] != null ? LIVE.lastCourse[key] : 0;
}

function liveOffsetByCourse(lat, lng, courseDeg, distMeters) {
  if (!distMeters || Math.abs(distMeters) < 0.05) return [lat, lng];
  const brng = (Number(courseDeg) || 0) * Math.PI / 180;
  const R = 6371000;
  const lat1 = lat * Math.PI / 180;
  const lng1 = lng * Math.PI / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(distMeters / R) +
    Math.cos(lat1) * Math.sin(distMeters / R) * Math.cos(brng)
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(distMeters / R) * Math.cos(lat1),
    Math.cos(distMeters / R) - Math.sin(lat1) * Math.sin(lat2)
  );
  return [lat2 * 180 / Math.PI, lng2 * 180 / Math.PI];
}

function liveBuildMarkerHtml(unit, angle, isSelected) {
  const st = unit.status || 'offline';
  const model = liveUnitModel(unit);
  const label = livePlateShort(unit.car || unit.name);
  const spd = Math.round(Number(unit.pos && unit.pos.speed) || 0);
  const scale = isSelected ? ' scale(1.06)' : '';
  return (
    '<div class="live-marker ' + st + ' model-' + model + (isSelected ? ' is-selected' : '') + '" data-model="' + model + '">' +
    '<div class="live-unit" style="transform:rotate(' + angle.toFixed(1) + 'deg)' + scale + '">' +
    liveTopImgHtml(model) +
    '</div>' +
    '<div class="live-map-tag">' +
    '<span class="live-map-tag-dot"></span>' +
    '<span class="live-map-plate">' + liveEsc(label) + '</span>' +
    '<span class="live-map-spd"' + (st === 'moving' ? '' : ' hidden') + '>' + spd + ' km/h</span>' +
    '</div>' +
    '</div>'
  );
}

function livePinIcon(unit, angle, isSelected) {
  return L.divIcon({
    className: 'live-pin leaflet-div-icon',
    html: liveBuildMarkerHtml(unit, angle, isSelected),
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

function livePatchMarkerDom(m, unit, angle, isSelected) {
  const root = m && m.getElement && m.getElement();
  if (!root) return false;
  const wrap = root.querySelector('.live-marker');
  if (!wrap) return false;
  const st = unit.status || 'offline';
  const model = liveUnitModel(unit);
  const spd = Math.round(Number(unit.pos && unit.pos.speed) || 0);

  if (wrap.dataset.model !== model) {
    wrap.dataset.model = model;
    const unitBox = wrap.querySelector('.live-unit');
    if (unitBox) unitBox.innerHTML = liveTopImgHtml(model);
  }

  wrap.className = 'live-marker ' + st + ' model-' + model + (isSelected ? ' is-selected' : '');

  const unitEl = wrap.querySelector('.live-unit');
  if (unitEl) {
    unitEl.style.transform = 'rotate(' + angle.toFixed(1) + 'deg)' + (isSelected ? ' scale(1.06)' : '');
  }

  const plateEl = wrap.querySelector('.live-map-plate');
  if (plateEl) plateEl.textContent = livePlateShort(unit.car || unit.name);

  const spdEl = wrap.querySelector('.live-map-spd');
  if (spdEl) {
    spdEl.hidden = st !== 'moving';
    if (st === 'moving') spdEl.textContent = spd + ' km/h';
  }
  return true;
}

function liveClusterIcon(group) {
  const total = group.length;
  const movingN = group.filter((g) => g.unit.status === 'moving').length;
  const cls = movingN > 0 ? 'live-cluster has-move' : 'live-cluster';
  const html =
    '<div class="' + cls + '">' +
    '<span class="live-cluster-n">' + total + '</span>' +
    (movingN > 0 ? '<span class="live-cluster-move" title="Harakatda">' + movingN + '</span>' : '') +
    '</div>';
  return L.divIcon({
    className: 'live-cluster-pin leaflet-div-icon',
    html: html,
    iconSize: [46, 46],
    iconAnchor: [23, 23],
  });
}

function liveSetBasemap(mode) {
  if (!LIVE.map) return;
  const next = mode === 'sat' ? 'sat' : 'street';
  if (LIVE.basemap === next && (LIVE.satLayer || next === 'street')) return;
  LIVE.basemap = next;
  document.querySelectorAll('#live-layer-seg .live-layer-btn').forEach((b) => {
    b.classList.toggle('on', b.getAttribute('data-layer') === next);
  });
  if (next === 'sat') {
    if (!LIVE.satLayer) {
      let satFails = 0;
      let switchedFallback = false;
      const gSat = L.tileLayer(
        'https://mt{s}.google.com/vt/lyrs=y&hl=uz&x={x}&y={y}&z={z}',
        {
          subdomains: '0123',
          attribution: '',
          maxZoom: 20,
          maxNativeZoom: 20,
          minZoom: 3,
          detectRetina: true,
        }
      );
      gSat.on('tileerror', () => {
        satFails += 1;
        if (switchedFallback || satFails < 4) return;
        switchedFallback = true;
        try { if (LIVE.map.hasLayer(gSat)) LIVE.map.removeLayer(gSat); } catch (e) {}
        LIVE.satLayer = L.tileLayer(
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          { attribution: '', maxZoom: 20, maxNativeZoom: 17, minZoom: 3 }
        );
        if (LIVE.basemap === 'sat') LIVE.satLayer.addTo(LIVE.map);
      });
      LIVE.satLayer = gSat;
    }
    if (!LIVE.map.hasLayer(LIVE.satLayer)) LIVE.satLayer.addTo(LIVE.map);
  } else if (LIVE.satLayer && LIVE.map.hasLayer(LIVE.satLayer)) {
    LIVE.map.removeLayer(LIVE.satLayer);
  }
  if (LIVE.geo && typeof LIVE.geo.setTheme === 'function') {
    LIVE.geo.setTheme(next);
  }
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

  LIVE.clusters = L.layerGroup().addTo(LIVE.map);
  LIVE.spiderLinks = L.layerGroup().addTo(LIVE.map);
  if (window.vmGeozones) LIVE.geo = vmGeozones.attach(LIVE.map, { car: LIVE.selected || '', theme: LIVE.basemap });

  LIVE.map.on('zoomend', () => {
    const mapEl = liveEl('live-map');
    if (mapEl) mapEl.classList.toggle('live-zoom-far', LIVE.map.getZoom() <= 11);
    liveScheduleLayout(30);
  });
  const initMapEl = liveEl('live-map');
  if (initMapEl) initMapEl.classList.toggle('live-zoom-far', LIVE.map.getZoom() <= 11);

  setTimeout(() => { try { LIVE.map.invalidateSize(); } catch (e) {} }, 200);
  setTimeout(() => { try { LIVE.map.invalidateSize(); } catch (e) {} }, 600);
  if (!LIVE._resizeBound) {
    LIVE._resizeBound = true;
    window.addEventListener('resize', () => {
      try {
        if (LIVE.map) {
          LIVE.map.invalidateSize();
          liveScheduleLayout(80);
        }
      } catch (e) {}
    });
    window.addEventListener('orientationchange', () => {
      setTimeout(() => {
        try {
          if (LIVE.map) {
            LIVE.map.invalidateSize();
            liveScheduleLayout(120);
          }
        } catch (e) {}
      }, 280);
    });
  }
}

function liveBuildPathLookup(pts) {
  if (!pts || pts.length < 2) return null;
  const cum = [0];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    total += liveDistMeters(pts[i - 1], pts[i]);
    cum.push(total);
  }
  return { pts: pts, cum: cum, total: total };
}

function liveSamplePath(pathInfo, t01) {
  const pts = pathInfo.pts;
  const cum = pathInfo.cum;
  const total = pathInfo.total;
  if (total <= 0.1) {
    const end = pts[pts.length - 1];
    return { pos: [end[0], end[1]], bearing: null };
  }
  const targetD = Math.max(0, Math.min(1, t01)) * total;
  let idx = 0;
  while (idx < cum.length - 2 && cum[idx + 1] < targetD) idx++;
  const segStartD = cum[idx];
  const segLen = cum[idx + 1] - segStartD;
  const frac = segLen > 0.05 ? (targetD - segStartD) / segLen : 1;
  const a = pts[idx];
  const b = pts[idx + 1];
  return {
    pos: [a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac],
    bearing: liveDistMeters(a, b) > 0.5 ? liveBearing(a, b) : null,
  };
}

function liveStartMotionLoop() {
  if (LIVE.rafId) return;
  let lastFollowAt = 0;

  function tick(now) {
    LIVE.rafId = requestAnimationFrame(tick);
    if (!LIVE.map || document.hidden) return;

    Object.keys(LIVE.renderState).forEach((key) => {
      const rs = LIVE.renderState[key];
      const m = LIVE.markers[key];
      if (!rs || !m || !LIVE.map.hasLayer(m)) return;

      if (rs.spiderfied || rs.clustered) {
        rs.curAngle = rs.curAngle + liveWrapDelta(rs.curAngle, rs.targetAngle) * 0.25;
        const unitEl = m.getElement() && m.getElement().querySelector('.live-unit');
        if (unitEl) {
          unitEl.style.transform =
            'rotate(' + rs.curAngle.toFixed(1) + 'deg)' +
            (LIVE.selected === key ? ' scale(1.06)' : '');
        }
        return;
      }

      let baseLat;
      let baseLng;
      const elapsed = now - rs.animFromAt;
      const isAnimating = rs.animDurMs > 0 && elapsed < rs.animDurMs;
      const isCruising = !isAnimating && rs.status === 'moving' && rs.speed >= 5 && (elapsed - rs.animDurMs) < 6200;

      if (isAnimating) {
        const t = Math.max(0, Math.min(1, elapsed / rs.animDurMs));
        // Gentle linear-in / soft-out curve keeps multi-poll travel gliding smoothly without mid-poll freezes
        const e = t < 0.7 ? (t * 1.08) : (0.756 + (1 - Math.pow(1 - (t - 0.7) / 0.3, 1.7)) * 0.244);
        const clampedE = Math.max(0, Math.min(1, e));
        if (rs.pathInfo && rs.pathInfo.total > 1) {
          const samp = liveSamplePath(rs.pathInfo, clampedE);
          baseLat = samp.pos[0];
          baseLng = samp.pos[1];
          const segBearing = liveBearing([rs.animStartLat, rs.animStartLng], [rs.targetLat, rs.targetLng]);
          if (samp.bearing != null && Math.abs(liveWrapDelta(segBearing, samp.bearing)) < 120) {
            rs.motionHeading = samp.bearing;
            rs.targetAngle = rs.curAngle + liveWrapDelta(rs.curAngle, samp.bearing);
          }
        } else {
          baseLat = rs.animStartLat + (rs.targetLat - rs.animStartLat) * clampedE;
          baseLng = rs.animStartLng + (rs.targetLng - rs.animStartLng) * clampedE;
          if (rs.status === 'moving') {
            const segDist = liveDistMeters([rs.animStartLat, rs.animStartLng], [rs.targetLat, rs.targetLng]);
            if (segDist >= 8) {
              const segBearing = liveBearing([rs.animStartLat, rs.animStartLng], [rs.targetLat, rs.targetLng]);
              rs.motionHeading = segBearing;
              rs.targetAngle = rs.curAngle + liveWrapDelta(rs.curAngle, segBearing);
            }
          }
        }
      } else if (isCruising) {
        const driftElapsed = Math.max(0, (elapsed - rs.animDurMs) / 1000);
        const maxSec = 3.6;
        const u = Math.min(1, driftElapsed / maxSec);
        const easedSec = maxSec * (1 - Math.pow(1 - u, 2));
        const rawDist = (rs.speed * (1000 / 3600)) * 0.35 * easedSec;
        const leadM = Math.min(10, rawDist);
        const cruiseHeading = Number.isFinite(rs.motionHeading) ? rs.motionHeading : rs.targetAngle;
        const pt = liveOffsetByCourse(rs.targetLat, rs.targetLng, cruiseHeading, leadM);
        baseLat = pt[0];
        baseLng = pt[1];
      } else {
        baseLat = rs.curLat;
        baseLng = rs.curLng;
      }

      const angleDiff = Math.abs(liveWrapDelta(rs.curAngle, rs.targetAngle));
      const posChanged = Math.abs(rs.curLat - baseLat) > 1e-7 || Math.abs(rs.curLng - baseLng) > 1e-7;
      if (isAnimating || isCruising || posChanged || angleDiff > 0.25) {
        rs.curLat = baseLat;
        rs.curLng = baseLng;
        rs.curAngle = rs.curAngle + liveWrapDelta(rs.curAngle, rs.targetAngle) * 0.24;
        m.setLatLng([baseLat, baseLng]);
        LIVE.renderedPos[key] = [baseLat, baseLng];

        const el = m.getElement();
        const unitEl = el && el.querySelector('.live-unit');
        if (unitEl) {
          unitEl.style.transform =
            'rotate(' + rs.curAngle.toFixed(1) + 'deg)' +
            (LIVE.selected === key ? ' scale(1.06)' : '');
        }
      }
    });

    if (LIVE.follow && LIVE.selected && (now - lastFollowAt > 250)) {
      const selPos = LIVE.renderedPos[LIVE.selected];
      if (selPos) {
        const pxCur = LIVE.map.latLngToContainerPoint(LIVE.map.getCenter());
        const pxTarget = LIVE.map.latLngToContainerPoint(selPos);
        if (pxCur.distanceTo(pxTarget) > 16) {
          LIVE.map.panTo(selPos, { animate: true, duration: 0.35, noMoveStart: true });
        }
      }
      lastFollowAt = now;
    }
  }

  LIVE.rafId = requestAnimationFrame(tick);
}

function liveStopMotionLoop() {
  if (LIVE.rafId) {
    cancelAnimationFrame(LIVE.rafId);
    LIVE.rafId = null;
  }
}

function liveTooltipHtml(unit, spd, course) {
  return (
    '<strong>' + liveEsc(unit.car || unit.name) + '</strong> · ' +
    liveEsc(liveModelLabel(unit)) + '<br>' +
    '<span>' + liveEsc(unit.driver || '—') + ' · ' + liveStatusLabel(unit.status) +
    (unit.pos ? ' · ' + spd + ' km/h' : '') +
    (course ? ' · ' + Math.round(((course % 360) + 360) % 360) + '°' : '') + '</span>'
  );
}

function liveShowUnitMarker(unit, displayLL, opts) {
  const key = liveUnitKey(unit);
  const rs = LIVE.renderState[key];
  const isSelected = LIVE.selected === key;
  const spd = Math.round(Number(unit.pos && unit.pos.speed) || 0);
  const zOff = isSelected ? 2600 : unit.status === 'moving' ? 1400 : 400;
  const angle = rs ? rs.curAngle : (LIVE.lastCourse[key] || 0);
  const tip = liveTooltipHtml(unit, spd, rs ? rs.targetAngle : angle);
  const isSpider = !!(opts && opts.spiderfied);
  const wasSpider = !!(rs && rs.spiderfied);

  if (rs) {
    rs.clustered = false;
    rs.spiderfied = isSpider;
  }

  let m = LIVE.markers[key];
  if (m) {
    const wasOffMap = !LIVE.map.hasLayer(m);
    if (wasOffMap) m.addTo(LIVE.map);
    if (isSpider || wasSpider || wasOffMap) {
      if (rs && !isSpider) {
        rs.curLat = displayLL[0];
        rs.curLng = displayLL[1];
      }
      m.setLatLng(displayLL);
      LIVE.renderedPos[key] = displayLL;
    }
    if (!livePatchMarkerDom(m, unit, angle, isSelected)) {
      m.setIcon(livePinIcon(unit, angle, isSelected));
    }
    m.setZIndexOffset(zOff);
    if (m.getTooltip()) m.setTooltipContent(tip);
    else m.bindTooltip(tip, { direction: 'top', offset: [0, -34], className: 'live-tip' });
  } else {
    const startLL = (rs && !isSpider) ? [rs.curLat, rs.curLng] : displayLL;
    m = L.marker(startLL, { icon: livePinIcon(unit, angle, isSelected), zIndexOffset: zOff })
      .addTo(LIVE.map)
      .bindTooltip(tip, { direction: 'top', offset: [0, -34], className: 'live-tip' });
    m.on('click', () => liveSelect(key, false));
    LIVE.markers[key] = m;
    LIVE.renderedPos[key] = startLL;
  }
}

function liveHideUnitMarker(key) {
  const m = LIVE.markers[key];
  if (m && LIVE.map && LIVE.map.hasLayer(m)) {
    try { LIVE.map.removeLayer(m); } catch (e) {}
  }
  delete LIVE.renderedPos[key];
}

function liveClusterSpreadMeters(group) {
  let maxM = 0;
  const first = group[0].ll;
  for (let i = 1; i < group.length; i++) {
    const d = liveDistMeters(first, group[i].ll);
    if (d > maxM) maxM = d;
  }
  return maxM;
}

function liveSpiderfyPositions(centerLL, count) {
  const centerPt = LIVE.map.latLngToLayerPoint(centerLL);
  const radiusPx = Math.min(92, 46 + Math.max(0, count - 2) * 5);
  const stepAngle = (Math.PI * 2) / count;
  const startAngle = -Math.PI / 2;
  const coords = [];
  for (let i = 0; i < count; i++) {
    const angle = startAngle + i * stepAngle;
    const pt = L.point(
      centerPt.x + radiusPx * Math.cos(angle),
      centerPt.y + radiusPx * Math.sin(angle)
    );
    const ll = LIVE.map.layerPointToLatLng(pt);
    coords.push([ll.lat, ll.lng]);
  }
  return coords;
}

function liveLayoutMarkers(opts) {
  if (!LIVE.map) return;
  const snap = !!(opts && opts.snap);
  const zoom = LIVE.map.getZoom();

  if (LIVE.clusters) LIVE.clusters.clearLayers();
  if (LIVE.spiderLinks) LIVE.spiderLinks.clearLayers();

  const visible = liveFiltered().filter((u) => {
    return u.pos && Number.isFinite(Number(u.pos.lat)) && Number.isFinite(Number(u.pos.lng));
  });
  const visibleKeys = new Set(visible.map(liveUnitKey));

  Object.keys(LIVE.markers).forEach((k) => {
    if (!visibleKeys.has(k)) {
      liveHideUnitMarker(k);
    }
  });

  if (!visible.length) return;

  const thresholdPx = zoom <= 9 ? 58 : zoom <= 12 ? 48 : zoom <= 14 ? 36 : 24;
  const items = visible.map((u) => {
    const key = liveUnitKey(u);
    const rs = LIVE.renderState[key];
    const ll = rs ? [rs.targetLat, rs.targetLng] : [Number(u.pos.lat), Number(u.pos.lng)];
    return {
      unit: u,
      key: key,
      ll: ll,
      pt: LIVE.map.latLngToLayerPoint(ll),
    };
  });

  items.sort((a, b) => {
    if (a.key === LIVE.selected) return -1;
    if (b.key === LIVE.selected) return 1;
    const wa = a.unit.status === 'moving' ? 0 : a.unit.status === 'stopped' ? 1 : 2;
    const wb = b.unit.status === 'moving' ? 0 : b.unit.status === 'stopped' ? 1 : 2;
    return wa - wb;
  });

  const groups = [];
  items.forEach((item) => {
    let matched = null;
    for (let i = 0; i < groups.length; i++) {
      const anchor = groups[i][0];
      if (Math.hypot(item.pt.x - anchor.pt.x, item.pt.y - anchor.pt.y) <= thresholdPx) {
        matched = groups[i];
        break;
      }
    }
    if (matched) matched.push(item);
    else groups.push([item]);
  });

  groups.forEach((group) => {
    if (group.length === 1) {
      const item = group[0];
      liveShowUnitMarker(item.unit, item.ll, { snap: snap, spiderfied: false });
      return;
    }

    let sumLat = 0;
    let sumLng = 0;
    group.forEach((g) => { sumLat += g.ll[0]; sumLng += g.ll[1]; });
    const centerLL = [sumLat / group.length, sumLng / group.length];
    const spreadM = liveClusterSpreadMeters(group);

    const hasSelected = group.some((g) => g.key === LIVE.selected);
    const shouldSpiderfy = (zoom >= 15 && group.length <= 14) || (zoom >= 14 && spreadM < 45 && hasSelected && group.length <= 14);

    if (shouldSpiderfy) {
      const ring = liveSpiderfyPositions(centerLL, group.length);
      group.forEach((item, idx) => {
        const pos = ring[idx];
        // Spider leg — very subtle dotted connector, never a bold straight line
        const leg = L.polyline([item.ll, pos], {
          color: item.key === LIVE.selected ? '#1a5fb4' : '#94a3b8',
          weight: 1,
          dashArray: '2 5',
          opacity: 0.45,
          interactive: false,
        });
        LIVE.spiderLinks.addLayer(leg);
        liveShowUnitMarker(item.unit, pos, { snap: true, spiderfied: true });
      });
      return;
    }

    group.forEach((item) => {
      if (LIVE.renderState[item.key]) LIVE.renderState[item.key].clustered = true;
      liveHideUnitMarker(item.key);
    });

    const preview = group.slice(0, 5).map((g) => {
      return '<div><strong>' + liveEsc(livePlateShort(g.unit.car || g.unit.name)) + '</strong> · ' +
        liveEsc(liveModelLabel(g.unit)) + ' · ' + liveStatusLabel(g.unit.status) +
        (g.unit.status === 'moving' ? ' (' + Math.round(Number(g.unit.pos.speed) || 0) + ' km/h)' : '') +
        '</div>';
    }).join('');
    const extra = group.length > 5 ? '<div style="opacity:.75">+ ' + (group.length - 5) + ' ta boshqa</div>' : '';

    const cm = L.marker(centerLL, {
      icon: liveClusterIcon(group),
      zIndexOffset: 1800,
    }).bindTooltip(preview + extra, {
      direction: 'top',
      offset: [0, -18],
      className: 'live-tip',
    });

    cm.on('click', () => {
      if (spreadM < 45 || zoom >= 15) {
        LIVE.map.setView(centerLL, Math.max(zoom, 16), { animate: true });
      } else {
        LIVE.map.fitBounds(
          L.latLngBounds(group.map((g) => g.ll)),
          { padding: [64, 64], maxZoom: 16 }
        );
      }
    });
    LIVE.clusters.addLayer(cm);
  });
}

function liveScheduleLayout(delayMs) {
  if (LIVE.layoutTimer) clearTimeout(LIVE.layoutTimer);
  LIVE.layoutTimer = setTimeout(() => {
    LIVE.layoutTimer = null;
    liveLayoutMarkers({ snap: true });
  }, delayMs == null ? 40 : delayMs);
}

function liveRequestRoadSegment(key, fromLL, toLL, course, seqId) {
  if (typeof vmApi !== 'function') return;
  vmApi('/api/map/snap-live', {
    method: 'POST',
    body: JSON.stringify({ prev: fromLL, cur: toLL, course: course }),
  }).then((res) => {
    const rs = LIVE.renderState[key];
    if (!rs || rs.snapSeq !== seqId || !res || !res.ok || !Array.isArray(res.path) || res.path.length < 2) return;
    const nowPerf = performance.now();
    const cur = [rs.curLat, rs.curLng];
    const end = res.path[res.path.length - 1];
    const directM = liveDistMeters(cur, end);
    if (directM < 8) return;
    const fwdBearing = liveBearing(cur, end);
    // Keep strictly forward-advancing road curve waypoints — never snap backwards onto behind-car intersection nodes!
    let prevProj = 0;
    const forwardPts = [cur];
    const maxLatOffset = Math.max(38, directM * 0.55);
    const toRad = Math.PI / 180;
    for (let i = 0; i < res.path.length; i++) {
      const p = res.path[i];
      if (directM < 160) {
        const brngP = liveBearing(cur, p);
        const latOff = Math.abs(liveDistMeters(cur, p) * Math.sin((brngP - fwdBearing) * toRad));
        if (latOff > maxLatOffset) return;
      }
      const proj = liveForwardProjMeters(cur, p, fwdBearing);
      if (proj > prevProj + 1.0 && proj <= directM + 18) {
        forwardPts.push(p);
        prevProj = proj;
      }
    }
    if (liveDistMeters(forwardPts[forwardPts.length - 1], end) > 1.5 && liveForwardProjMeters(cur, end, fwdBearing) > 1.0) {
      forwardPts.push(end);
    }
    if (forwardPts.length < 2) return;
    const info = liveBuildPathLookup(forwardPts);
    if (info && info.total > 2 && info.total <= directM * 1.45 + 25) {
      rs.pathInfo = info;
      rs.animStartLat = cur[0];
      rs.animStartLng = cur[1];
      const last = forwardPts[forwardPts.length - 1];
      rs.targetLat = last[0];
      rs.targetLng = last[1];
      rs.animFromAt = nowPerf;
      const elapsedSoFar = nowPerf - (rs.segStartAt || nowPerf);
      rs.animDurMs = Math.max(1200, (rs.segTotalMs || 5200) - elapsedSoFar);
    }
  }).catch(() => {});
}

function liveUpsertUnitState(unit) {
  if (!unit || !unit.pos) return;
  const key = liveUnitKey(unit);
  const ll = [Number(unit.pos.lat), Number(unit.pos.lng)];
  if (!Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return;

  const rawCourse = liveCourse(unit, key);
  const spd = Number(unit.pos.speed) || 0;
  const msgTime = Number(unit.pos.time) || 0;
  const nowPerf = performance.now();

  const rs = LIVE.renderState[key];
  if (!rs) {
    LIVE.renderState[key] = {
      serverLat: ll[0],
      serverLng: ll[1],
      serverTime: msgTime,
      serverCourse: rawCourse,
      curLat: ll[0],
      curLng: ll[1],
      curAngle: rawCourse,
      animStartLat: ll[0],
      animStartLng: ll[1],
      targetLat: ll[0],
      targetLng: ll[1],
      targetAngle: rawCourse,
      animFromAt: nowPerf,
      segStartAt: nowPerf,
      animDurMs: 0,
      segTotalMs: 5200,
      pathInfo: null,
      snapSeq: 0,
      speed: spd,
      status: unit.status || 'offline',
      clustered: false,
      spiderfied: false,
    };
  } else {
    const serverMovedM = liveDistMeters([rs.serverLat, rs.serverLng], ll);
    const hasNewFix = (msgTime && msgTime !== rs.serverTime) || serverMovedM > 1.8;

    rs.speed = spd;
    rs.status = unit.status || 'offline';
    rs.serverCourse = rawCourse;
    if (!Number.isFinite(rs.motionHeading) || rs.status !== 'moving') {
      rs.targetAngle = rs.curAngle + liveWrapDelta(rs.curAngle, rawCourse);
    }

    if (hasNewFix) {
      const fixGapSec = (msgTime && rs.serverTime && msgTime > rs.serverTime)
        ? (msgTime - rs.serverTime)
        : 5;
      rs.serverLat = ll[0];
      rs.serverLng = ll[1];
      rs.serverTime = msgTime;

      const projM = liveForwardProjMeters([rs.curLat, rs.curLng], ll, rawCourse);
      const distFromCur = liveDistMeters([rs.curLat, rs.curLng], ll);
      const turnedAround = Math.abs(liveWrapDelta(rs.curAngle, rawCourse)) > 110 && distFromCur > 45;

      if (projM < -0.5 && distFromCur < 85 && !turnedAround) {
        rs.animStartLat = rs.curLat;
        rs.animStartLng = rs.curLng;
        rs.targetLat = rs.curLat;
        rs.targetLng = rs.curLng;
        rs.pathInfo = null;
        rs.animFromAt = nowPerf;
        rs.segStartAt = nowPerf;
        rs.animDurMs = 0;
      } else {
        const startPt = [rs.curLat, rs.curLng];
        const dispBearing = distFromCur >= 8 ? liveBearing(startPt, ll) : rawCourse;
        const segHeading = (rs.status === 'moving' && distFromCur >= 10)
          ? (Math.abs(liveWrapDelta(rawCourse, dispBearing)) <= 35 ? rawCourse : dispBearing)
          : rawCourse;
        rs.motionHeading = segHeading;
        rs.targetAngle = rs.curAngle + liveWrapDelta(rs.curAngle, segHeading);
        const durMs = Math.max(4600, Math.min(8200, fixGapSec * 1020));
        rs.animStartLat = startPt[0];
        rs.animStartLng = startPt[1];
        rs.targetLat = ll[0];
        rs.targetLng = ll[1];
        rs.pathInfo = null;
        rs.animFromAt = nowPerf;
        rs.segStartAt = nowPerf;
        rs.animDurMs = durMs;
        rs.segTotalMs = durMs;
        rs.snapSeq = (rs.snapSeq || 0) + 1;
        if (rs.status === 'moving' && distFromCur >= 12 && distFromCur <= 900) {
          liveRequestRoadSegment(key, startPt, ll, segHeading, rs.snapSeq);
        }
      }
    } else if (rs.status !== 'moving') {
      if (liveDistMeters([rs.curLat, rs.curLng], ll) > 1.5) {
        rs.animStartLat = rs.curLat;
        rs.animStartLng = rs.curLng;
        rs.targetLat = ll[0];
        rs.targetLng = ll[1];
        rs.pathInfo = null;
        rs.animFromAt = nowPerf;
        rs.segStartAt = nowPerf;
        rs.animDurMs = 900;
      }
    }
  }

  LIVE.lastCourse[key] = rawCourse;
  LIVE.lastPos[key] = ll;
}

function liveFitAll() {
  if (!LIVE.map) return;
  LIVE.follow = false;
  liveUpdateFollowButton();
  const visible = liveFiltered().filter((u) => u.pos && u.pos.lat && u.pos.lng);
  const source = visible.length ? visible : LIVE.units.filter((u) => u.pos && u.pos.lat && u.pos.lng);
  const pts = source.map((u) => [u.pos.lat, u.pos.lng]);
  if (pts.length > 1) {
    try {
      LIVE.map.fitBounds(L.latLngBounds(pts), { padding: [52, 52], maxZoom: 15 });
    } catch (e) {}
  } else if (pts.length === 1) {
    LIVE.map.setView(pts[0], 15);
  }
}

function liveUpdateFollowButton() {
  const btn = liveEl('live-ins-follow');
  if (!btn) return;
  btn.classList.toggle('on', !!LIVE.follow);
  const lbl = btn.querySelector('span');
  if (lbl) lbl.textContent = LIVE.follow ? 'Kuzatilmoqda' : 'Kuzatish';
}

function liveRenderInspector(unit) {
  const box = liveEl('live-inspector');
  if (!box) return;
  if (!unit) {
    box.hidden = true;
    return;
  }
  const key = liveUnitKey(unit);
  const st = unit.status || 'offline';
  const avClass = st === 'moving' ? 'move' : st === 'stopped' ? 'stop' : 'off';
  const spd = unit.pos ? Math.round(Number(unit.pos.speed) || 0) : 0;
  const course = LIVE.lastCourse[key];

  const av = liveEl('live-ins-av');
  if (av) {
    av.className = 'live-avatar ' + avClass;
    av.innerHTML = liveListPhotoHtml(unit) + '<span class="live-avatar-dot"></span>';
  }
  const plateEl = liveEl('live-ins-plate');
  if (plateEl) plateEl.textContent = unit.car || unit.name || '—';

  const badgeEl = liveEl('live-ins-badge');
  if (badgeEl) {
    badgeEl.className = 'live-badge ' + avClass;
    badgeEl.innerHTML = (st === 'moving' ? '<i class="pulse"></i>' : '') + liveStatusLabel(st);
  }
  const drvEl = liveEl('live-ins-drv');
  if (drvEl) drvEl.textContent = unit.driver || '—';

  const spdEl = liveEl('live-ins-spd');
  if (spdEl) {
    spdEl.textContent = unit.pos ? spd + ' km/h' : '—';
    spdEl.className = st === 'moving' ? 'hot' : '';
  }
  const crsEl = liveEl('live-ins-crs');
  if (crsEl) crsEl.textContent = unit.pos ? liveCompassLabel(course) : '—';

  const sigEl = liveEl('live-ins-sig');
  if (sigEl) {
    sigEl.textContent = unit.pos
      ? liveFmtTime(unit.pos.time) + ' · ' + liveFmtAge(unit.ageSec)
      : 'Signal yo‘q';
  }
  const modEl = liveEl('live-ins-model');
  if (modEl) modEl.textContent = liveModelLabel(unit);

  const drvLink = liveEl('live-ins-driver');
  if (drvLink) {
    drvLink.href = '/driver?car=' + encodeURIComponent(unit.car || unit.name || '');
  }

  liveUpdateFollowButton();
  box.hidden = false;
}

function liveSelect(key, pan) {
  if (!key) {
    LIVE.selected = null;
    LIVE.follow = false;
    document.querySelectorAll('.live-row').forEach((r) => r.classList.remove('on'));
    if (LIVE.geo) LIVE.geo.setCar('');
    liveRenderInspector(null);
    liveLayoutMarkers({ snap: true });
    return;
  }

  LIVE.selected = key;
  document.querySelectorAll('.live-row').forEach((row) => {
    row.classList.toggle('on', row.getAttribute('data-key') === key);
  });
  const unit = LIVE.units.find((u) => liveUnitKey(u) === key);
  if (LIVE.geo) LIVE.geo.setCar(unit ? unit.car : '');
  liveRenderInspector(unit || null);

  if (unit && unit.pos && LIVE.map && pan !== false) {
    const ll = LIVE.renderedPos[key] || [Number(unit.pos.lat), Number(unit.pos.lng)];
    LIVE.map.setView(ll, Math.max(LIVE.map.getZoom(), 15), { animate: true });
  }
  liveLayoutMarkers({ snap: true });
}

function liveFiltered() {
  const q = String((liveEl('live-q') && liveEl('live-q').value) || '').trim();
  return LIVE.units.filter((u) => {
    if (LIVE.filter !== 'all' && (u.status || 'offline') !== LIVE.filter) return false;
    if (!q) return true;
    const blob = [u.car, u.name, u.driver, u.short, liveModelLabel(u)].join(' ');
    if (typeof uzSearchMatch === 'function') return uzSearchMatch(blob, q);
    return blob.toLowerCase().indexOf(q.toLowerCase()) >= 0;
  });
}

function liveSyncFilterUI() {
  const stats = liveEl('live-stats');
  if (stats) {
    stats.classList.toggle('has-filter', LIVE.filter !== 'all');
    stats.querySelectorAll('.live-stat').forEach((btn) => {
      const f = btn.getAttribute('data-filter');
      const on = f === LIVE.filter;
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  const q = String((liveEl('live-q') && liveEl('live-q').value) || '').trim();
  const clearBtn = liveEl('live-q-clear');
  if (clearBtn) clearBtn.hidden = !q;
  const resetBtn = liveEl('live-filter-reset');
  if (resetBtn) resetBtn.hidden = LIVE.filter === 'all' && !q;
}

function liveRenderList() {
  const box = liveEl('live-list');
  if (!box) return;
  liveSyncFilterUI();
  const rows = liveFiltered();
  if (!rows.length) {
    box.innerHTML = '<div class="live-empty">Mos mashina topilmadi</div>';
    return;
  }
  box.innerHTML = rows.map((u) => {
    const key = liveUnitKey(u);
    const spd = u.pos ? Math.round(Number(u.pos.speed) || 0) : 0;
    const st = u.status || 'offline';
    const avClass = st === 'moving' ? 'move' : st === 'stopped' ? 'stop' : 'off';
    const badge =
      '<span class="live-badge ' + avClass + '">' +
      (st === 'moving' ? '<i class="pulse"></i>' : '') +
      liveStatusLabel(st) +
      '</span>';
    const spdHtml = u.pos
      ? '<div class="spd' + (st === 'moving' ? ' hot' : '') + '">' + spd + '<small>km/h</small></div>'
      : '<div class="spd off">—</div>';
    return (
      '<div class="live-row' +
      (LIVE.selected === key ? ' on' : '') +
      (st === 'moving' ? ' is-moving' : st === 'offline' ? ' is-offline' : '') +
      '" data-key="' + liveEsc(key) + '">' +
      '<div class="live-avatar ' + avClass + '">' + liveListPhotoHtml(u) + '<span class="live-avatar-dot"></span></div>' +
      '<div class="live-row-main">' +
      '<div class="live-row-top"><span class="live-car">' + liveEsc(u.car || u.name || '—') + '</span>' + badge + '</div>' +
      '<div class="live-drv">' + liveEsc(u.driver || '—') + '</div>' +
      '</div>' +
      '<div class="live-meta">' + spdHtml + '<div class="age">' + liveFmtAge(u.ageSec) + '</div></div>' +
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
  const tot = liveEl('live-n-total');
  if (tot) tot.textContent = String(c.total != null ? c.total : LIVE.units.length) + ' ta';
}

function liveSetClock(msg, isErr) {
  const el = liveEl('live-clock');
  if (!el) return;
  el.classList.toggle('is-err', !!isErr);
  const txt = el.querySelector('.live-clock-txt');
  if (txt) txt.textContent = msg || '—';
  else el.textContent = msg || '—';
}

function liveRemoveUnit(key) {
  if (LIVE.markers[key]) {
    try { LIVE.map.removeLayer(LIVE.markers[key]); } catch (e) {}
    delete LIVE.markers[key];
  }
  delete LIVE.lastPos[key];
  delete LIVE.lastCourse[key];
  delete LIVE.renderState[key];
  delete LIVE.renderedPos[key];
}

async function liveFetch() {
  if (LIVE.fetching) return;
  LIVE.fetching = true;
  const refreshBtn = liveEl('live-refresh');
  if (refreshBtn) refreshBtn.classList.add('is-busy');
  try {
    const d = await vmApi('/api/office/gps/live');
    if (!d || d.ok === false) {
      liveSetClock(d && d.error ? d.error : 'GPS xato', true);
      const box = liveEl('live-list');
      if (box && !LIVE.units.length) {
        box.innerHTML = '<div class="live-empty">' +
          liveEsc(d && d.error ? d.error : 'GPS sozlanmagan yoki ulanmadi') +
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
        const key = liveUnitKey(u);
        keep[key] = true;
        liveUpsertUnitState(u);
      }
    });
    Object.keys(LIVE.markers).forEach((k) => {
      if (!keep[k]) liveRemoveUnit(k);
    });

    if (LIVE.selected) {
      const selUnit = LIVE.units.find((u) => liveUnitKey(u) === LIVE.selected);
      liveRenderInspector(selUnit || null);
    }

    const t = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const moving = (d.counts && d.counts.moving) || 0;
    liveSetClock(
      pad(t.getHours()) + ':' + pad(t.getMinutes()) + ':' + pad(t.getSeconds()) +
      ' · ' + LIVE.units.length + ' avto' +
      (moving ? ' · ' + moving + ' faol' : ''),
      false
    );

    if (!LIVE._fittedOnce && LIVE.units.some((u) => u.pos)) {
      LIVE._fittedOnce = true;
      liveFitAll();
    }
    liveLayoutMarkers({ snap: false });
  } catch (e) {
    liveSetClock(String(e.message || e).slice(0, 80), true);
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

  liveEl('live-refresh')?.addEventListener('click', () => {
    if (typeof vmHealMapTiles === 'function') vmHealMapTiles(LIVE.map);
    liveFetch();
  });
  liveEl('live-fit')?.addEventListener('click', () => liveFitAll());

  liveEl('live-q')?.addEventListener('input', () => {
    liveRenderList();
    liveLayoutMarkers({ snap: true });
  });
  liveEl('live-q-clear')?.addEventListener('click', () => {
    const inp = liveEl('live-q');
    if (inp) {
      inp.value = '';
      inp.focus();
    }
    liveRenderList();
    liveLayoutMarkers({ snap: true });
  });

  liveEl('live-stats')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.live-stat[data-filter]');
    if (!btn) return;
    const f = btn.getAttribute('data-filter');
    LIVE.filter = LIVE.filter === f ? 'all' : f;
    liveRenderList();
    liveLayoutMarkers({ snap: true });
  });

  liveEl('live-filter-reset')?.addEventListener('click', () => {
    LIVE.filter = 'all';
    const inp = liveEl('live-q');
    if (inp) inp.value = '';
    liveRenderList();
    liveLayoutMarkers({ snap: true });
  });

  liveEl('live-layer-seg')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.live-layer-btn[data-layer]');
    if (!btn) return;
    liveSetBasemap(btn.getAttribute('data-layer'));
  });

  liveEl('live-mob-bar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.live-mob-btn[data-mob]');
    if (!btn) return;
    const mode = btn.getAttribute('data-mob');
    const main = liveEl('live-main');
    if (main) main.setAttribute('data-mob-view', mode);
    document.querySelectorAll('#live-mob-bar .live-mob-btn').forEach((b) => {
      b.classList.toggle('on', b === btn);
    });
    if (mode !== 'list' && LIVE.map) {
      setTimeout(() => {
        try {
          LIVE.map.invalidateSize();
          liveScheduleLayout(60);
        } catch (err) {}
      }, 60);
    }
  });

  liveEl('live-ins-close')?.addEventListener('click', () => liveSelect(null, false));
  liveEl('live-ins-follow')?.addEventListener('click', () => {
    LIVE.follow = !LIVE.follow;
    liveUpdateFollowButton();
    if (LIVE.follow && LIVE.selected) {
      const ll = LIVE.renderedPos[LIVE.selected];
      if (ll && LIVE.map) {
        LIVE.map.panTo(ll, { animate: true });
      }
    }
  });
  liveEl('live-ins-center')?.addEventListener('click', () => {
    if (!LIVE.selected) return;
    const unit = LIVE.units.find((u) => liveUnitKey(u) === LIVE.selected);
    if (unit && unit.pos && LIVE.map) {
      const ll = LIVE.renderedPos[LIVE.selected] || [unit.pos.lat, unit.pos.lng];
      LIVE.map.setView(ll, Math.max(LIVE.map.getZoom(), 16), { animate: true });
    }
  });

  await liveFetch();
  liveStartPoll();
  liveStartMotionLoop();
  setTimeout(() => {
    if (typeof vmHealMapTiles === 'function') vmHealMapTiles(LIVE.map);
    else { try { LIVE.map && LIVE.map.invalidateSize(); } catch (e) {} }
  }, 100);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (LIVE.timer) { clearInterval(LIVE.timer); LIVE.timer = null; }
      liveStopMotionLoop();
    } else {
      liveFetch();
      liveStartPoll();
      liveStartMotionLoop();
      setTimeout(() => {
        if (typeof vmHealMapTiles === 'function') vmHealMapTiles(LIVE.map);
        else { try { LIVE.map && LIVE.map.invalidateSize(); } catch (e) {} }
      }, 120);
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', liveBoot);
} else {
  liveBoot();
}
