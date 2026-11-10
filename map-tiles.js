'use strict';
/**
 * Xarita plitkalari — API kalitsiz, ko‘cha/do‘kon aniq.
 * Carto ishlatilmaydi (API KEY REQUIRED).
 */

const VM_TILE_SOURCES = [
  {
    // OSM France HOT — ko‘cha, binolar, do‘konlar (yuqori zoom)
    url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxZoom: 20,
    maxNativeZoom: 20
  },
  {
    // Esri Street — tiniq yo‘llar, kalit yo‘q
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    subdomains: null,
    maxZoom: 20,
    maxNativeZoom: 19
  },
  {
    url: 'https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxZoom: 20,
    maxNativeZoom: 19
  },
  {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    subdomains: null,
    maxZoom: 20,
    maxNativeZoom: 19
  }
];

const VM_TILE_OPTS = {
  attribution: '',
  maxZoom: 20,
  maxNativeZoom: 18,
  minZoom: 3,
  crossOrigin: true,
  updateWhenIdle: false,
  updateWhenZooming: true,
  keepBuffer: 4,
  detectRetina: true,
  errorTileUrl:
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
};

function vmAddMapTiles(map) {
  if (!map || typeof L === 'undefined') return null;

  const state = {
    idx: 0,
    layer: null,
    failBurst: 0,
    failWindowAt: 0,
    switchedAt: 0
  };
  map._vmTileState = state;

  function mount(i) {
    const src = VM_TILE_SOURCES[i];
    if (!src) return null;
    const opts = Object.assign({}, VM_TILE_OPTS);
    if (src.subdomains) opts.subdomains = src.subdomains;
    if (src.maxZoom != null) opts.maxZoom = src.maxZoom;
    if (src.maxNativeZoom != null) opts.maxNativeZoom = src.maxNativeZoom;
    const layer = L.tileLayer(src.url, opts);
    let switched = false;

    layer.on('tileerror', () => {
      const now = Date.now();
      if (now - state.failWindowAt > 4000) {
        state.failWindowAt = now;
        state.failBurst = 0;
      }
      state.failBurst += 1;
      if (switched || state.idx !== i || state.failBurst < 3) return;
      if (now - state.switchedAt < 2500) return;
      switched = true;
      state.switchedAt = now;
      state.failBurst = 0;
      try {
        map.removeLayer(layer);
      } catch (e) {}
      state.idx = i + 1;
      state.layer = mount(state.idx);
      map._vmTileLayer = state.layer;
    });

    layer.on('load', () => {
      state.failBurst = 0;
    });

    layer.addTo(map);
    return layer;
  }

  try {
    if (map.setMaxZoom) map.setMaxZoom(20);
  } catch (e) {}

  state.layer = mount(0);
  map._vmTileLayer = state.layer;
  return state.layer;
}

function vmHealMapTiles(map) {
  if (!map) return;
  try {
    map.invalidateSize({ pan: false });
  } catch (e) {}
  const layer = map._vmTileLayer;
  if (!layer) return;
  try {
    if (typeof layer.redraw === 'function') layer.redraw();
  } catch (e) {}
}

function vmDefer(fn, ms) {
  const wait = ms == null ? 320 : ms;
  return new Promise((resolve) => {
    const run = () => {
      try {
        resolve(typeof fn === 'function' ? fn() : undefined);
      } catch (e) {
        resolve(undefined);
      }
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: wait + 400 });
    } else {
      setTimeout(run, wait);
    }
  });
}

window.vmAddMapTiles = vmAddMapTiles;
window.vmHealMapTiles = vmHealMapTiles;
window.vmDefer = vmDefer;
