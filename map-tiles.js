'use strict';
/** Xarita plitkalari — tez CDN + fallback, kam so'rov (retina o'chiq). */

const VM_TILE_SOURCES = [
    {
        url: 'https://{s}.tile.openstreetmap.de/{z}/{x}/{y}.png',
        subdomains: 'abc'
    },
    {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}'
    },
    {
        url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
        subdomains: 'abc'
    }
];

const VM_TILE_OPTS = {
    attribution: '',
    maxZoom: 19,
    minZoom: 3,
    crossOrigin: true,
    updateWhenIdle: true,
    updateWhenZooming: false,
    keepBuffer: 2,
    detectRetina: false
};

function vmAddMapTiles(map) {
    if (!map || typeof L === 'undefined') return null;
    let idx = 0;
    let active = null;

    function mount(i) {
        const src = VM_TILE_SOURCES[i];
        if (!src) return null;
        const opts = Object.assign({}, VM_TILE_OPTS);
        if (src.subdomains) opts.subdomains = src.subdomains;
        const layer = L.tileLayer(src.url, opts);
        let failed = false;
        layer.on('tileerror', () => {
            if (failed || idx !== i) return;
            failed = true;
            try { map.removeLayer(layer); } catch (e) {}
            idx = i + 1;
            active = mount(idx);
        });
        layer.addTo(map);
        return layer;
    }

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
