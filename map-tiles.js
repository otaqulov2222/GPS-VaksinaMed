'use strict';
/**
 * Xarita plitkalari — API kalitsiz ochiq manbalar.
 * Carto (API KEY REQUIRED) va ArcGIS Street ("Map data not yet available") ishlatilmaydi.
 */

const VM_TILE_SOURCES = [
    {
        // OSM France HOT — shaharlarda yuqori zoom yaxshi, kalit yo‘q
        url: 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png',
        subdomains: 'abc',
        maxZoom: 18,
        maxNativeZoom: 18
    },
    {
        url: 'https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png',
        subdomains: 'abc',
        maxZoom: 18,
        maxNativeZoom: 18
    },
    {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        subdomains: 'abc',
        maxZoom: 18,
        maxNativeZoom: 19
    }
];

const VM_TILE_OPTS = {
    attribution: '',
    maxZoom: 18,
    maxNativeZoom: 18,
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
            if (switched || idx !== i || failCount < 6) return;
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
        if (map.setMaxZoom) map.setMaxZoom(18);
    } catch (e) {}

    active = mount(0);
    return active;
}

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
