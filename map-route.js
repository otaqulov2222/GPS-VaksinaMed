'use strict';
/** Marshrut chizig'i — OSRM (yo'l bo'yicha). Xato bo'lsa to'g'ri chiziq qoladi. */

const VM_ROUTE_CACHE = new Map();
const VM_ROUTE_MAX_WAYPOINTS = 25;

function vmRouteCacheKey(latlngs) {
    return latlngs.map(p => Number(p[0]).toFixed(5) + ',' + Number(p[1]).toFixed(5)).join('|');
}

async function vmFetchRoadRoute(latlngs, opts) {
    const o = opts || {};
    const timeoutMs = o.timeoutMs || 12000;
    const pts = Array.isArray(latlngs) ? latlngs.filter(p => p && p.length >= 2 && p[0] && p[1]) : [];
    if (pts.length < 2) return pts;

    let waypoints = pts.slice(0, VM_ROUTE_MAX_WAYPOINTS);
    const key = vmRouteCacheKey(waypoints);
    if (VM_ROUTE_CACHE.has(key)) return VM_ROUTE_CACHE.get(key).slice();

    const coords = waypoints.map(p =>
        Number(p[1]).toFixed(6) + ',' + Number(p[0]).toFixed(6)
    ).join(';');
    const url = 'https://router.project-osrm.org/route/v1/driving/' + coords
        + '?overview=full&geometries=geojson&steps=false';

    try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
        const r = await fetch(url, { signal: ctrl ? ctrl.signal : undefined, mode: 'cors' });
        if (timer) clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        if (!data || data.code !== 'Ok' || !data.routes || !data.routes[0]) throw new Error('route empty');
        const geom = data.routes[0].geometry;
        if (!geom || !Array.isArray(geom.coordinates) || !geom.coordinates.length) throw new Error('geom empty');
        const out = geom.coordinates.map(c => [c[1], c[0]]);
        VM_ROUTE_CACHE.set(key, out);
        return out.slice();
    } catch (e) {
        console.warn('vmFetchRoadRoute:', e && e.message ? e.message : e);
        return waypoints.slice();
    }
}

window.vmFetchRoadRoute = vmFetchRoadRoute;
