'use strict';
/**
 * Xarita plitkalari — Carto/OSM (yuqori zoom ishlaydi).
 * ArcGIS Street olib tashlandi: yaqin zoomda "Map data not yet available" berardi.
 */

const VM_TILE_SOURCES = [
    {
        // Carto Voyager — shaharlarda z18–20 yaxshi
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
        subdomains: 'abcd',
        maxZoom: 20,
        maxNativeZoom: 20
    },
    {
        url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
        subdomains: 'abc',
        maxZoom: 20,
        maxNativeZoom: 19
    },
    {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        subdomains: 'abc',
        maxZoom: 19,
        maxNativeZoom: 19
    }
];

const VM_TILE_OPTS = {
    attribution: '',
    maxZoom: 19,
    maxNativeZoom: 19,
    minZoom: 3,
    crossOrigin: true,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 3,
    detectRetina: false
};

function vmAddMapTiles(map) {
    if (!map || typeof L === 'undefined') return null;
    let idx = 0;
    let active = null;
    let failCount = 0;

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
            failCount += 1;
            // Bir nechta xato bo‘lsa keyingi manbaga o‘tish
            if (switched || idx !== i || failCount < 4) return;
            switched = true;
            failCount = 0;
            try { map.removeLayer(layer); } catch (e) {}
            idx = i + 1;
            active = mount(idx);
        });
        layer.on('load', () => { failCount = 0; });
        layer.addTo(map);
        return layer;
    }

    try {
        if (map.setMaxZoom) map.setMaxZoom(19);
    } catch (e) {}

    active = mount(0);
    return active;
}

/** Plitkalar yuklanguncha og'ir ishni kechiktirish */
function vmDefer(fn, ms) {
    const wait = ms == null ? 320 : ms;
    return new Promise(resolve => {
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
window.vmDefer = vmDefer;
