'use strict';
/**
 * Xaritada vaqt / tezlik yorliqlari (Dashboard va haydovchi kabineti uchun umumiy).
 * - Bir joyda turgan ketma-ket nuqtalar bitta «Turgan» yorlig'iga yig'iladi (vaqt oralig'i + davomiylik).
 * - Yorliqlar ekranda ustma-ust tushmaydi: har zoom / surishda qayta joylashadi,
 *   yaqinlashtirilganda ko'proq nuqta ochiladi.
 * - Vaqt: Unix soniya → Toshkent (UTC+5), brauzer soat zonasiga bog'liq emas.
 */
(function () {
    const TZ_SEC = 5 * 3600;
    const STAY_SPEED = 3;
    const STAY_RADIUS_M = 35;
    const STAY_MIN_SEC = 90;
    const MAX_LABELS = 160;
    const DOT_MIN_PX = 7;

    const CSS = `
.leaflet-tooltip.vm-tele-tip {
  background: #1a5fb4 !important; border: 0 !important; color: #fff !important;
  padding: 4px 8px !important; border-radius: 6px !important;
  font: 600 11px/1.3 'IBM Plex Sans', system-ui, sans-serif;
  box-shadow: 0 2px 6px rgba(11, 31, 58, 0.28) !important;
  white-space: nowrap; pointer-events: none;
}
.leaflet-tooltip.vm-tele-tip b { display: block; font: 700 11.5px/1.25 'IBM Plex Mono', ui-monospace, monospace; letter-spacing: .01em; }
.leaflet-tooltip.vm-tele-tip span { display: block; font-size: 10.5px; opacity: .92; }
.leaflet-tooltip.vm-tele-tip.is-stay { background: #0b1f3a !important; }
.leaflet-tooltip.vm-tele-tip.is-stay span { color: #ffd166; opacity: 1; }
.leaflet-tooltip.vm-tele-tip.is-edge { background: #123050 !important; }
.leaflet-tooltip-right.vm-tele-tip::before { border-right-color: #1a5fb4 !important; }
.leaflet-tooltip-left.vm-tele-tip::before { border-left-color: #1a5fb4 !important; }
.leaflet-tooltip-top.vm-tele-tip::before { border-top-color: #1a5fb4 !important; }
.leaflet-tooltip-bottom.vm-tele-tip::before { border-bottom-color: #1a5fb4 !important; }
.leaflet-tooltip-right.vm-tele-tip.is-stay::before { border-right-color: #0b1f3a !important; }
.leaflet-tooltip-left.vm-tele-tip.is-stay::before { border-left-color: #0b1f3a !important; }
.leaflet-tooltip-top.vm-tele-tip.is-stay::before { border-top-color: #0b1f3a !important; }
.leaflet-tooltip-bottom.vm-tele-tip.is-stay::before { border-bottom-color: #0b1f3a !important; }
.leaflet-tooltip-right.vm-tele-tip.is-edge::before { border-right-color: #123050 !important; }
.leaflet-tooltip-left.vm-tele-tip.is-edge::before { border-left-color: #123050 !important; }
.leaflet-tooltip-top.vm-tele-tip.is-edge::before { border-top-color: #123050 !important; }
.leaflet-tooltip-bottom.vm-tele-tip.is-edge::before { border-bottom-color: #123050 !important; }
`;

    function injectCss() {
        if (document.getElementById('vm-tele-css')) return;
        const st = document.createElement('style');
        st.id = 'vm-tele-css';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    function pad(n) { return String(n).padStart(2, '0'); }

    function clock(sec) {
        const d = new Date((Number(sec) + TZ_SEC) * 1000);
        return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds());
    }

    function dur(sec) {
        sec = Math.max(0, Math.round(sec));
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        if (h) return h + ' soat ' + m + ' daq';
        if (m) return m + ' daq' + (m < 10 && s ? ' ' + s + ' s' : '');
        return s + ' s';
    }

    function distM(a, b) {
        const r = Math.PI / 180;
        const dLat = (b[0] - a[0]) * r;
        const dLng = (b[1] - a[1]) * r;
        const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2;
        return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(x)));
    }

    /** [lat, lng, t, speed] — vaqt bo'yicha tartiblangan, bir xil vaqtli dublikatlarsiz */
    function normalize(track) {
        const out = [];
        (Array.isArray(track) ? track : []).forEach(p => {
            if (!Array.isArray(p) || p.length < 3) return;
            const lat = Number(p[0]);
            const lng = Number(p[1]);
            let t = Number(p[2]) || 0;
            if (t > 1e12) t = Math.floor(t / 1000);
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || t < 1e8) return;
            out.push([lat, lng, t, Math.max(0, Number(p[3]) || 0)]);
        });
        out.sort((a, b) => a[2] - b[2]);
        return out.filter((p, i) => i === 0 || p[2] !== out[i - 1][2]);
    }

    function segments(pts) {
        const out = [];
        let i = 0;
        while (i < pts.length) {
            const a = pts[i];
            let j = i;
            if (a[3] < STAY_SPEED) {
                while (j + 1 < pts.length && pts[j + 1][3] < STAY_SPEED && distM(a, pts[j + 1]) <= STAY_RADIUS_M) j++;
            }
            if (j > i && pts[j][2] - a[2] >= STAY_MIN_SEC) {
                let lat = 0, lng = 0;
                for (let k = i; k <= j; k++) { lat += pts[k][0]; lng += pts[k][1]; }
                const n = j - i + 1;
                out.push({ lat: lat / n, lng: lng / n, t0: a[2], t1: pts[j][2], speed: 0, stay: true });
                i = j + 1;
            } else {
                out.push({ lat: a[0], lng: a[1], t0: a[2], t1: a[2], speed: a[3], stay: false });
                i += 1;
            }
        }
        if (out.length) {
            out[0].edge = 'start';
            out[out.length - 1].edge = out.length > 1 ? 'end' : 'start';
        }
        return out;
    }

    /** Muhimlik tartibi: uzoq turishlar → boshi/oxiri → qolganlari yo'l bo'ylab tekis taqsimlangan */
    function priorityOrder(segs) {
        const order = [];
        const seen = new Uint8Array(segs.length);
        const push = i => {
            if (i >= 0 && i < segs.length && !seen[i]) { seen[i] = 1; order.push(i); }
        };
        push(0);
        push(segs.length - 1);
        segs.map((s, i) => [i, s.stay ? s.t1 - s.t0 : -1])
            .filter(x => x[1] >= 0)
            .sort((a, b) => b[1] - a[1])
            .forEach(x => push(x[0]));
        let st = 1;
        while (st * 2 < segs.length) st *= 2;
        for (; st >= 1; st = Math.floor(st / 2)) {
            for (let i = 0; i < segs.length; i += st) push(i);
            if (st === 1) break;
        }
        return order;
    }

    function labelHtml(s) {
        const head = s.edge === 'start' ? 'Boshlanish · ' : (s.edge === 'end' ? 'Tugash · ' : '');
        if (s.stay) {
            return '<b>' + clock(s.t0) + ' – ' + clock(s.t1) + '</b><span>' + head + 'Turgan · ' + dur(s.t1 - s.t0) + '</span>';
        }
        return '<b>' + clock(s.t0) + '</b><span>' + head + Math.round(s.speed) + ' km/soat</span>';
    }

    function labelSize(s) {
        const head = s.edge ? 76 : 0;
        if (s.stay) return [Math.max(150, 96 + head), 36];
        return [Math.max(80, 70 + head), 36];
    }

    const CANDS = [
        { dir: 'right', off: [12, 0], box: (x, y, w, h) => [x + 12, y - h / 2] },
        { dir: 'left', off: [-12, 0], box: (x, y, w, h) => [x - 12 - w, y - h / 2] },
        { dir: 'top', off: [0, -10], box: (x, y, w, h) => [x - w / 2, y - 16 - h] },
        { dir: 'bottom', off: [0, 10], box: (x, y, w, h) => [x - w / 2, y + 16] }
    ];

    function hits(box, placed) {
        for (let k = 0; k < placed.length; k++) {
            const b = placed[k];
            if (box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]) return true;
        }
        return false;
    }

    function dotStyle(s) {
        if (s.stay) return { radius: 6, color: '#ffffff', weight: 2, fillColor: '#0b1f3a', fillOpacity: 1, interactive: false };
        return { radius: 4.5, color: '#ffffff', weight: 1.5, fillColor: '#e11d48', fillOpacity: 1, interactive: false };
    }

    /**
     * @param {L.Map} map
     * @param {Array} track  [[lat, lng, unixSec, speedKmh], ...]
     * @returns {{ destroy: Function, count: number, stays: number }}
     */
    function vmTrackTelemetry(map, track) {
        injectCss();
        const segs = segments(normalize(track));
        const order = priorityOrder(segs);
        const layer = L.layerGroup().addTo(map);
        let raf = 0;
        let alive = true;

        function render() {
            raf = 0;
            if (!alive) return;
            layer.clearLayers();
            if (!segs.length) return;
            const size = map.getSize();
            const placed = [];
            const labeled = new Uint8Array(segs.length);
            let n = 0;
            for (let oi = 0; oi < order.length && n < MAX_LABELS; oi++) {
                const i = order[oi];
                const s = segs[i];
                const p = map.latLngToContainerPoint([s.lat, s.lng]);
                if (p.x < 0 || p.y < 0 || p.x > size.x || p.y > size.y) continue;
                const [w, h] = labelSize(s);
                const dot = [p.x - 7, p.y - 7, p.x + 7, p.y + 7];
                let pick = null;
                for (let c = 0; c < CANDS.length; c++) {
                    const [bx, by] = CANDS[c].box(p.x, p.y, w, h);
                    const box = [bx - 3, by - 3, bx + w + 3, by + h + 3];
                    if (box[0] < -24 || box[1] < -24 || box[2] > size.x + 24 || box[3] > size.y + 24) continue;
                    if (hits(box, placed)) continue;
                    pick = { cand: CANDS[c], box };
                    break;
                }
                if (!pick) continue;
                placed.push(pick.box, dot);
                labeled[i] = 1;
                n += 1;
                const cls = 'vm-tele-tip' + (s.stay ? ' is-stay' : (s.edge ? ' is-edge' : ''));
                const m = L.circleMarker([s.lat, s.lng], dotStyle(s));
                m.bindTooltip(labelHtml(s), {
                    permanent: true,
                    direction: pick.cand.dir,
                    offset: pick.cand.off,
                    className: cls,
                    opacity: 1,
                    interactive: false
                });
                layer.addLayer(m);
            }
            const grid = new Set();
            for (let i = 0; i < segs.length; i++) {
                if (labeled[i]) continue;
                const s = segs[i];
                const p = map.latLngToContainerPoint([s.lat, s.lng]);
                if (p.x < -40 || p.y < -40 || p.x > size.x + 40 || p.y > size.y + 40) continue;
                const key = Math.round(p.x / DOT_MIN_PX) + ':' + Math.round(p.y / DOT_MIN_PX);
                if (grid.has(key) && !s.stay) continue;
                grid.add(key);
                const m = L.circleMarker([s.lat, s.lng], Object.assign(dotStyle(s), { interactive: true }));
                m.bindTooltip(labelHtml(s), { direction: 'top', offset: [0, -8], className: 'vm-tele-tip' + (s.stay ? ' is-stay' : ''), opacity: 1 });
                layer.addLayer(m);
            }
        }

        function schedule() {
            if (!alive || raf) return;
            raf = requestAnimationFrame(render);
        }

        map.on('zoomend moveend resize', schedule);
        render();

        return {
            count: segs.length,
            stays: segs.filter(s => s.stay).length,
            refresh: schedule,
            destroy() {
                alive = false;
                if (raf) cancelAnimationFrame(raf);
                map.off('zoomend moveend resize', schedule);
                try { map.removeLayer(layer); } catch (e) {}
            }
        };
    }

    window.vmTrackTelemetry = vmTrackTelemetry;
    window.vmTeleClock = clock;
})();
