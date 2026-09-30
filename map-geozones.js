'use strict';
/**
 * Boomerang geozonalari xaritada (Dashboard, Live, haydovchi kabineti uchun umumiy).
 * - Yashil doira + nom (Boomerang uslubi); ofis/sklad — ko'k; faqat tizimda bor dorixona — shtrix chegara.
 * - Tanlangan mashina dorixonalari ajralib turadi (to'q yashil, nom yorlig'i).
 * - Nomlar ustma-ust tushmaydi: har zoom / surishda qayta joylashadi, uzoqdan faqat o'z dorixonalari nomi.
 * - «Geozonalar» tugmasi bilan yoqiladi/o'chiriladi (brauzer eslab qoladi).
 */
(function () {
    const API = '/api/office/geozones';
    const STORE_KEY = 'vm_geozones_on';
    const CACHE_MS = 10 * 60 * 1000;
    const LABEL_MIN_ZOOM = 13;
    const MAX_LABELS = 220;
    const ZONE_PANE = 'vmGeoZones';
    const LABEL_PANE = 'vmGeoLabels';

    const CSS = `
.vm-gz-label { background: transparent; border: 0; }
.vm-gz-label span {
  position: absolute; left: 0; top: 0; transform: translate(-50%, -50%);
  white-space: nowrap; pointer-events: none;
  font: 700 11px/1.2 'IBM Plex Sans', system-ui, sans-serif; letter-spacing: .01em;
  color: #0f3d22;
  text-shadow: 0 0 2px #fff, 0 0 2px #fff, 0 0 3px #fff, 0 0 4px #fff;
}
.vm-gz-label.is-office span { color: #123a6b; }
.vm-gz-label.is-own span {
  color: #fff; text-shadow: none;
  background: #1b6b35; padding: 2px 7px; border-radius: 4px;
  box-shadow: 0 1px 4px rgba(11, 31, 58, .3);
}
.vm-gz-toggle {
  display: flex; align-items: center; gap: 6px;
  background: #fff; border: 2px solid rgba(0, 0, 0, .2); border-radius: 4px;
  padding: 4px 8px; cursor: pointer; user-select: none;
  font: 700 11px/1.2 'IBM Plex Sans', system-ui, sans-serif; color: #5c6573;
}
.vm-gz-toggle i {
  width: 11px; height: 11px; border-radius: 50%;
  border: 1.5px solid #8a96a6; background: transparent; flex: 0 0 auto;
}
.vm-gz-toggle.on { color: #1b6b35; }
.vm-gz-toggle.on i { border-color: #1b6b35; background: rgba(63, 174, 95, .55); }
.vm-gz-toggle:hover { background: #f4f8f5; }
.vm-gz-pop b { display: block; font-size: 13px; margin-bottom: 2px; }
.vm-gz-pop .m { opacity: .72; font-size: 11px; }
.vm-gz-pop ul { margin: 6px 0 0; padding: 0; list-style: none; font-size: 12px; }
.vm-gz-pop li::before { content: '● '; color: #3fae5f; }
.vm-gz-pop .own { font-weight: 700; }
.vm-gz-pop .own::after { content: ' · shu mashina'; font-weight: 600; opacity: .72; }
.vm-gz-pop .none { margin-top: 6px; font-size: 12px; opacity: .8; }
`;

    let cache = null;
    let cacheAt = 0;
    let inflight = null;
    let measureCtx = null;

    function injectCss() {
        if (document.getElementById('vm-gz-css')) return;
        const st = document.createElement('style');
        st.id = 'vm-gz-css';
        st.textContent = CSS;
        document.head.appendChild(st);
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function ui(s) {
        return typeof uzUi === 'function' ? uzUi(s) : String(s || '');
    }

    function plate(s) {
        return String(s || '').replace(/\s+/g, '').toUpperCase();
    }

    function load(force) {
        if (!force && cache && Date.now() - cacheAt < CACHE_MS) return Promise.resolve(cache);
        if (inflight) return inflight;
        inflight = fetch(API, { credentials: 'same-origin' })
            .then(r => (r.ok ? r.json() : null))
            .then(d => {
                inflight = null;
                if (d && d.ok && Array.isArray(d.zones)) {
                    cache = d.zones;
                    cacheAt = Date.now();
                }
                return cache || [];
            })
            .catch(() => {
                inflight = null;
                return cache || [];
            });
        return inflight;
    }

    function textWidth(text) {
        if (!measureCtx) {
            measureCtx = document.createElement('canvas').getContext('2d');
            measureCtx.font = "700 11px 'IBM Plex Sans', system-ui, sans-serif";
        }
        return measureCtx.measureText(text).width;
    }

    function isVisiblePref() {
        try { return localStorage.getItem(STORE_KEY) !== '0'; } catch (e) { return true; }
    }

    function savePref(on) {
        try { localStorage.setItem(STORE_KEY, on ? '1' : '0'); } catch (e) {}
    }

    function ensurePanes(map) {
        if (!map.getPane(ZONE_PANE)) {
            const p = map.createPane(ZONE_PANE);
            p.style.zIndex = 350;
        }
        if (!map.getPane(LABEL_PANE)) {
            const p = map.createPane(LABEL_PANE);
            p.style.zIndex = 450;
            p.style.pointerEvents = 'none';
        }
    }

    function popupHtml(z, car) {
        const src = z.src === 'vm' ? 'Tizimdagi dorixona geozonasi' : 'Boomerang geozonasi';
        const owners = Array.isArray(z.owners) ? z.owners : [];
        const want = plate(car);
        let html = `<div class="vm-gz-pop"><b>${esc(ui(z.name))}</b><div class="m">${src} · radius ${Number(z.radiusM) || 0} m</div>`;
        if (z.kind === 'office') {
            html += '<div class="m">Ofis / sklad</div>';
        } else if (owners.length) {
            html += '<ul>' + owners.map(o => {
                const own = want && plate(o.car) === want;
                return `<li class="${own ? 'own' : ''}">${esc(ui(o.name))} — ${esc(o.car)}</li>`;
            }).join('') + '</ul>';
        } else {
            html += '<div class="none">Hech bir mashinaga biriktirilmagan</div>';
        }
        return html + '</div>';
    }

    function zoneStyle(z, own) {
        if (z.kind === 'office') {
            return { color: '#1a5fb4', weight: 1.5, fillColor: '#1a5fb4', fillOpacity: 0.16, opacity: 0.8 };
        }
        if (own) {
            return { color: '#1b6b35', weight: 2.5, fillColor: '#2e9d52', fillOpacity: 0.38, opacity: 1 };
        }
        return {
            color: '#2f8f4e', weight: 1, fillColor: '#3fae5f', fillOpacity: 0.26, opacity: 0.85,
            dashArray: z.src === 'vm' ? '4 4' : null
        };
    }

    /**
     * @param {L.Map} map
     * @param {{car?: string}} [opts]
     * @returns {{setCar: Function, refresh: Function, setVisible: Function, destroy: Function}}
     */
    function attach(map, opts) {
        if (!map || typeof L === 'undefined') return null;
        injectCss();
        ensurePanes(map);
        const o = opts || {};
        let car = o.car || '';
        let visible = isVisiblePref();
        let zones = [];
        let items = [];
        let raf = 0;
        let destroyed = false;
        const zoneLayer = L.layerGroup();
        const labelLayer = L.layerGroup();

        const isOwn = (z) => {
            const want = plate(car);
            return !!want && (z.owners || []).some(ow => plate(ow.car) === want);
        };

        function build() {
            zoneLayer.clearLayers();
            labelLayer.clearLayers();
            items = zones.filter(z => Number.isFinite(Number(z.lat)) && Number.isFinite(Number(z.lng))).map(z => {
                const own = isOwn(z);
                const ll = L.latLng(Number(z.lat), Number(z.lng));
                const circle = L.circle(ll, Object.assign({ radius: Number(z.radiusM) || 100, pane: ZONE_PANE }, zoneStyle(z, own)));
                circle.bindPopup(() => popupHtml(z, car), { maxWidth: 280 });
                zoneLayer.addLayer(circle);
                const linked = own ? (z.linked || []).filter(o => plate(o.car) === plate(car)) : [];
                const text = [ui(z.name)].concat(linked.map(o => ui(o.name))).join(' + ');
                const cls = 'vm-gz-label' + (own ? ' is-own' : '') + (z.kind === 'office' ? ' is-office' : '');
                const label = L.marker(ll, {
                    pane: LABEL_PANE,
                    interactive: false,
                    keyboard: false,
                    icon: L.divIcon({ className: cls, html: `<span>${esc(text)}</span>`, iconSize: [0, 0] })
                });
                const w = textWidth(text) + (own ? 16 : 6);
                return {
                    z, ll, label, own,
                    w, h: own ? 20 : 16,
                    prio: own ? 0 : (z.kind === 'office' ? 1 : 2)
                };
            });
            items.sort((a, b) => a.prio - b.prio || (Number(b.z.radiusM) || 0) - (Number(a.z.radiusM) || 0));
            placeLabels();
        }

        /** Xaritadagi boshqa belgilar (to'xtash pinlari, mashinalar, vaqt yorliqlari) — yorliq ularni yopmasin */
        function markerObstacles() {
            const box = map.getContainer().getBoundingClientRect();
            const out = [];
            [['markerPane', '.leaflet-marker-icon'], ['tooltipPane', '.leaflet-tooltip']].forEach(([name, sel]) => {
                const pane = map.getPane(name);
                if (!pane) return;
                pane.querySelectorAll(sel).forEach(el => {
                    const b = el.getBoundingClientRect();
                    if (!b.width || !b.height) return;
                    out.push({ x1: b.left - box.left, y1: b.top - box.top, x2: b.right - box.left, y2: b.bottom - box.top });
                });
            });
            return out;
        }

        function placeLabels() {
            raf = 0;
            if (destroyed || !visible) return;
            labelLayer.clearLayers();
            const zoom = map.getZoom();
            const size = map.getSize();
            const bounds = map.getBounds().pad(0.1);
            const placed = markerObstacles();
            const hits = (r) => placed.some(q => r.x1 < q.x2 && r.x2 > q.x1 && r.y1 < q.y2 && r.y2 > q.y1);
            let n = 0;
            for (const it of items) {
                if (n >= MAX_LABELS) break;
                if (zoom < LABEL_MIN_ZOOM && !it.own) continue;
                if (!bounds.contains(it.ll)) continue;
                const c = map.latLngToContainerPoint(it.ll);
                const north = map.latLngToContainerPoint([it.ll.lat + (Number(it.z.radiusM) || 100) / 111320, it.ll.lng]);
                const rPx = Math.max(4, c.y - north.y);
                const gap = it.h / 2 + 3;
                // Doira ustida → ostida → markazda
                const spots = [c.y - rPx - gap, c.y + rPx + gap, c.y];
                let chosen = null;
                for (const y of spots) {
                    const r = { x1: c.x - it.w / 2 - 2, y1: y - it.h / 2 - 1, x2: c.x + it.w / 2 + 2, y2: y + it.h / 2 + 1 };
                    if (r.x2 < 0 || r.y2 < 0 || r.x1 > size.x || r.y1 > size.y) continue;
                    if (hits(r)) continue;
                    chosen = { r, y };
                    break;
                }
                if (!chosen) continue;
                placed.push(chosen.r);
                it.label.setLatLng(map.containerPointToLatLng([c.x, chosen.y]));
                labelLayer.addLayer(it.label);
                n++;
            }
        }

        function schedule() {
            if (!raf) raf = requestAnimationFrame(placeLabels);
        }

        function show() {
            if (!map.hasLayer(zoneLayer)) zoneLayer.addTo(map);
            if (!map.hasLayer(labelLayer)) labelLayer.addTo(map);
            schedule();
        }

        function hide() {
            if (map.hasLayer(zoneLayer)) map.removeLayer(zoneLayer);
            if (map.hasLayer(labelLayer)) map.removeLayer(labelLayer);
        }

        let btn = null;
        const Toggle = L.Control.extend({
            options: { position: o.position || 'topleft' },
            onAdd() {
                btn = L.DomUtil.create('div', 'vm-gz-toggle leaflet-bar' + (visible ? ' on' : ''));
                btn.innerHTML = '<i></i><span>Geozonalar</span>';
                btn.title = 'Boomerang geozonalarini koʻrsatish / yashirish';
                L.DomEvent.disableClickPropagation(btn);
                L.DomEvent.on(btn, 'click', () => api.setVisible(!visible));
                return btn;
            }
        });
        const control = new Toggle();
        map.addControl(control);

        const onLayerAdd = (e) => {
            if (e.layer instanceof L.Marker && e.layer.options.pane !== LABEL_PANE) schedule();
        };
        map.on('zoomend moveend resize', schedule);
        map.on('layeradd', onLayerAdd);

        const api = {
            setCar(next) {
                if (plate(next) === plate(car)) return;
                car = next || '';
                build();
            },
            refresh(force) {
                return load(force).then(list => {
                    if (destroyed) return;
                    zones = list || [];
                    build();
                    if (visible) show();
                });
            },
            setVisible(on) {
                visible = !!on;
                savePref(visible);
                if (btn) btn.classList.toggle('on', visible);
                if (visible) show(); else hide();
            },
            get count() { return zones.length; },
            destroy() {
                destroyed = true;
                if (raf) cancelAnimationFrame(raf);
                map.off('zoomend moveend resize', schedule);
                map.off('layeradd', onLayerAdd);
                hide();
                try { map.removeControl(control); } catch (e) {}
            }
        };
        api.refresh(false);
        return api;
    }

    window.vmGeozones = { attach, load };
})();
