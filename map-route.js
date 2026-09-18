'use strict';
/**
 * Marshrut — toza professional:
 * 1) GPS denoise (zigzag/spike)
 * 2) Server OSRM snap (/api/map/snap-route) → FAQAT yo'l
 * 3) Bitta ko'k chiziq (lane/rang yo'q)
 */

function vmCleanPts(latlngs) {
    const out = [];
    (latlngs || []).forEach(p => {
        if (!p || p.length < 2) return;
        const lat = Number(p[0]), lng = Number(p[1]);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) || !lat || !lng) return;
        if (out.length) {
            const prev = out[out.length - 1];
            if (Math.abs(prev[0] - lat) < 1e-7 && Math.abs(prev[1] - lng) < 1e-7) return;
        }
        out.push([lat, lng]);
    });
    return out;
}

function vmRouteMeters(a, b) {
    if (typeof L !== 'undefined' && L.latLng) {
        return L.latLng(a[0], a[1]).distanceTo(L.latLng(b[0], b[1]));
    }
    const R = 6371000;
    const φ1 = a[0] * Math.PI / 180, φ2 = b[0] * Math.PI / 180;
    const dφ = (b[0] - a[0]) * Math.PI / 180;
    const dλ = (b[1] - a[1]) * Math.PI / 180;
    const s = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function vmRouteBearing(a, b) {
    const lat1 = a[0] * Math.PI / 180;
    const lat2 = b[0] * Math.PI / 180;
    const dLng = (b[1] - a[1]) * Math.PI / 180;
    const y = Math.sin(dLng) * Math.cos(lat2);
    const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function vmDenoiseTrack(latlngs, opts) {
    const o = opts || {};
    const minStep = o.minStepM != null ? o.minStepM : 12;
    const clusterR = o.clusterRM != null ? o.clusterRM : 26;
    const spikeFactor = 3.2;
    let pts = vmCleanPts(latlngs);
    if (pts.length < 3) return pts;

    const noSpike = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
        const a = noSpike[noSpike.length - 1];
        const b = pts[i];
        const c = pts[i + 1];
        const ab = vmRouteMeters(a, b);
        const bc = vmRouteMeters(b, c);
        const ac = vmRouteMeters(a, c);
        if (ac > 5 && ab + bc > spikeFactor * ac && ab > 40 && bc > 40) continue;
        noSpike.push(b);
    }
    noSpike.push(pts[pts.length - 1]);
    pts = noSpike;

    const collapsed = [];
    let i = 0;
    while (i < pts.length) {
        let j = i + 1;
        let sumLat = pts[i][0], sumLng = pts[i][1], n = 1;
        while (j < pts.length && vmRouteMeters(pts[i], pts[j]) < clusterR) {
            let localMax = 0;
            for (let k = i; k < j; k++) localMax = Math.max(localMax, vmRouteMeters(pts[k], pts[j]));
            if (localMax > clusterR * 1.15) break;
            sumLat += pts[j][0];
            sumLng += pts[j][1];
            n++;
            j++;
        }
        if (n >= 4) collapsed.push([sumLat / n, sumLng / n]);
        else for (let k = i; k < j; k++) collapsed.push(pts[k]);
        i = Math.max(j, i + 1);
    }
    pts = collapsed.length >= 2 ? collapsed : pts;

    const spaced = [pts[0]];
    for (let k = 1; k < pts.length - 1; k++) {
        if (vmRouteMeters(spaced[spaced.length - 1], pts[k]) >= minStep) spaced.push(pts[k]);
    }
    spaced.push(pts[pts.length - 1]);
    return spaced;
}

function vmSimplifyTrack(latlngs, toleranceM) {
    const pts = vmCleanPts(latlngs);
    if (pts.length < 3) return pts;
    const tol = Math.max(4, Number(toleranceM) || 14);

    function distToSeg(p, a, b) {
        if (vmRouteMeters(a, b) < 0.5) return vmRouteMeters(p, a);
        const bx = vmRouteMeters(a, [a[0], b[1]]) * Math.sign(b[1] - a[1] || 1);
        const by = vmRouteMeters(a, [b[0], a[1]]) * Math.sign(b[0] - a[0] || 1);
        const px = vmRouteMeters(a, [a[0], p[1]]) * Math.sign(p[1] - a[1] || 1);
        const py = vmRouteMeters(a, [p[0], a[1]]) * Math.sign(p[0] - a[0] || 1);
        const cross = Math.abs(bx * py - by * px);
        const len = Math.sqrt(bx * bx + by * by) || 1;
        return cross / len;
    }

    function rdp(list) {
        if (list.length < 3) return list;
        let maxD = 0, idx = 0;
        const a = list[0], b = list[list.length - 1];
        for (let i = 1; i < list.length - 1; i++) {
            const d = distToSeg(list[i], a, b);
            if (d > maxD) { maxD = d; idx = i; }
        }
        if (maxD > tol) {
            const left = rdp(list.slice(0, idx + 1));
            const right = rdp(list.slice(idx));
            return left.slice(0, -1).concat(right);
        }
        return [a, b];
    }
    return rdp(pts);
}

/** To'xtashlar orasi (kam nuqta) — server snap emas, to'g'ridan OSRM ham mumkin. */
async function vmFetchRoadRoute(latlngs, opts) {
    const pts = vmCleanPts(latlngs).slice(0, 25);
    if (pts.length < 2) return pts;
    try {
        const r = await fetch('/api/map/snap-route', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ points: pts })
        });
        const data = await r.json();
        if (data && data.ok && data.points && data.points.length >= 2) return data.points;
    } catch (e) {
        console.warn('vmFetchRoadRoute:', e);
    }
    return pts;
}

/**
 * Asosiy: denoise → server yo'l snap.
 * Muvaffaqiyatli bo'lsa FAQAT yo'l chizig'i (binolar ustidan emas).
 */
async function vmPrepareRouteTrack(latlngs, opts) {
    const o = opts || {};
    let pts = vmCleanPts(latlngs);
    if (pts.length < 2) {
        return { points: pts, lanes: null, snapped: false };
    }

    pts = vmDenoiseTrack(pts, {
        minStepM: o.minStepM != null ? o.minStepM : 12,
        clusterRM: o.clusterRM != null ? o.clusterRM : 26
    });
    pts = vmSimplifyTrack(pts, o.simplifyM != null ? o.simplifyM : 14);

    if (o.snap === false || typeof fetch !== 'function') {
        return { points: pts, lanes: null, snapped: false };
    }

    try {
        const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = ctrl ? setTimeout(() => ctrl.abort(), o.timeoutMs || 90000) : null;
        const r = await fetch('/api/map/snap-route', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ points: pts }),
            signal: ctrl ? ctrl.signal : undefined
        });
        if (timer) clearTimeout(timer);
        const data = await r.json();
        if (data && data.ok && Array.isArray(data.points) && data.points.length >= 8) {
            return { points: data.points, lanes: null, snapped: true, meta: data.meta || null };
        }
        console.warn('snap-route fail:', data && data.error);
    } catch (e) {
        console.warn('vmPrepareRouteTrack snap:', e);
    }

    return { points: pts, lanes: null, snapped: false };
}

window.vmFetchRoadRoute = vmFetchRoadRoute;
window.vmSimplifyTrack = vmSimplifyTrack;
window.vmDenoiseTrack = vmDenoiseTrack;
window.vmPrepareRouteTrack = vmPrepareRouteTrack;
window.vmRouteBearing = vmRouteBearing;
window.vmRouteMeters = vmRouteMeters;
window.vmCleanPts = vmCleanPts;
