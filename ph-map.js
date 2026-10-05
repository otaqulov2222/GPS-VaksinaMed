'use strict';
/**
 * Admin → Dorixona biriktirish: xaritada tanlash.
 * - Boomerang geozonalari (yashil aylana) va tizimdagi filiallar; tanlangan mashinaga nisbatan rangli.
 * - Aylanaga bosib: biriktirish / boshqa mashinadan o'tkazish / olib tashlash / belgilash (bulk).
 * - «Yangi filial»: Boomerangda yo'q filialni xaritaga bosib (yoki manzil qidirib) qo'shish.
 * admin.html globallari: PHARMS, GPS_PLACES, PH_SEL, assignPharmacy, savePharms, setPhSelected ...
 */
(function () {
    const TILE_URL = 'https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png';
    const DEFAULT_CENTER = [41.311, 69.279];
    const DEFAULT_ZOOM = 11;
    const OFFICE_RE = /(офис|склад|ofis|sklad)/i;
    const STOP_RADIUS_M = 60;
    const MAX_LABELS = 90;
    const ALL_LABELS_ZOOM = 14;
    const NEAR_EXTRA_M = 80;
    const HOME_KM = 70;
    const CITY_KM = 12;

    let map = null;
    let zoneLayer = null;
    let draftLayer = null;
    let evidenceLayer = null;
    let items = [];
    let byId = new Map();
    let idx = { geo: new Map(), stop: new Map(), geoList: [] };
    const addrCache = new Map();
    let showStops = false;
    let addMode = false;
    let placingId = '';
    let draft = null;
    let lastQuery = null;
    let fittedOnce = false;
    let refreshTimer = 0;
    let queryTimer = 0;
    let geoSeq = 0;

    const $ = (id) => document.getElementById(id);
    const canEdit = () => !(window.VM_USER && window.VM_USER.role === 'viewer');
    const targetCar = () => ($('ph-target-car') || {}).value || '';
    const query = () => String(($('ph-search') || {}).value || '').trim();
    const shortCar = (car) => String(car || '').trim();

    function clampRadius(v, fallback) {
        const r = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
        return Math.max(40, Math.min(500, r || fallback || 120));
    }

    function inputRadius() {
        return clampRadius(($('ph-radius') || {}).value, 120);
    }

    function distM(lat1, lng1, lat2, lng2) {
        const R = 6371000;
        const rad = (d) => (d * Math.PI) / 180;
        const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
            + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    function init() {
        if (map) return true;
        const el = $('phm-map');
        if (!el || typeof L === 'undefined') return false;
        map = L.map(el, { zoomControl: true, attributionControl: false }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
        L.tileLayer(TILE_URL, { subdomains: 'abc', maxZoom: 20, maxNativeZoom: 18 }).addTo(map);
        zoneLayer = L.layerGroup().addTo(map);
        draftLayer = L.layerGroup().addTo(map);
        evidenceLayer = L.layerGroup().addTo(map);
        map.on('click', (e) => {
            if (addMode) startDraft(e.latlng.lat, e.latlng.lng);
        });
        map.on('popupopen', (e) => bindPopup(e.popup.getElement()));
        map.on('popupclose', () => evidenceLayer.clearLayers());
        map.on('moveend', () => schedule());
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(() => map && map.invalidateSize()).observe(el);
        }
        bindUi();
        return true;
    }

    function bindUi() {
        const stops = $('phm-stops');
        if (stops) stops.addEventListener('change', () => { showStops = stops.checked; render(); });
        const fit = $('phm-fit');
        if (fit) fit.addEventListener('click', () => fitCar(true));
        const add = $('phm-add');
        if (add) add.addEventListener('click', () => (addMode ? stopAdd() : startAdd()));
        const radius = $('ph-radius');
        if (radius) radius.addEventListener('input', () => {
            if (!draft || placingId) return;
            const r = inputRadius();
            draft.circle.setRadius(r);
            const f = draftField('radius');
            if (f) f.value = r;
        });
        const nc = $('phm-nocoord');
        if (nc) {
            nc.addEventListener('click', (e) => {
                const show = e.target.closest('[data-show]');
                if (show) {
                    showPharm(show.getAttribute('data-show'));
                    return;
                }
                const b = e.target.closest('[data-place]');
                if (b) placePharm(b.getAttribute('data-place'));
            });
            nc.addEventListener('toggle', (e) => {
                if (e.target.tagName === 'DETAILS') nc.dataset.open = e.target.open ? '1' : '0';
            }, true);
        }
        const find = $('phm-find');
        if (find) find.addEventListener('click', onFindClick);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && addMode) stopAdd();
        });
    }

    /** GPS katalogi + tizimdagi dorixonalar → xarita elementlari */
    function buildItems() {
        const out = [];
        const drawn = new Set();
        const ownersByKey = new Map();
        const q = query();
        idx = { geo: new Map(), stop: new Map(), geoList: [] };
        (PHARMS || []).forEach((p) => {
            const k = phNameKey(p.name);
            if (!k) return;
            if (!ownersByKey.has(k)) ownersByKey.set(k, []);
            ownersByKey.get(k).push(p);
        });
        (GPS_PLACES || []).forEach((pl) => {
            if (pl.lat == null || pl.lng == null) return;
            const k = phNameKey(pl.name);
            if (pl.fromGeofence) {
                idx.geo.set(k, pl);
                idx.geoList.push(pl);
            } else {
                idx.stop.set(k, pl);
            }
        });
        (GPS_PLACES || []).forEach((pl) => {
            if (pl.lat == null || pl.lng == null) return;
            if (!pl.fromGeofence && !showStops && !(q && phNameMatch(pl.name, q))) return;
            const owners = ownersByKey.get(phNameKey(pl.name)) || [];
            // To'xtash nuqtasi o'rtacha koordinata — filialning o'z koordinatasi bo'lsa o'shani chizamiz
            if (!pl.fromGeofence && owners.some((o) => o.lat != null && o.lng != null)) return;
            owners.forEach((o) => drawn.add(o.id));
            out.push({
                id: 'g:' + pl.name,
                name: pl.name,
                lat: Number(pl.lat),
                lng: Number(pl.lng),
                radiusM: pl.fromGeofence ? (Number(pl.radiusM) || 100) : STOP_RADIUS_M,
                src: pl.fromGeofence ? 'gps' : 'stop',
                count: Number(pl.count) || 0,
                topCar: pl.topCar || '',
                owners
            });
        });
        (PHARMS || []).forEach((p) => {
            if (drawn.has(p.id) || p.lat == null || p.lng == null) return;
            const owners = ownersByKey.get(phNameKey(p.name)) || [p];
            owners.forEach((o) => drawn.add(o.id));
            out.push({
                id: 'p:' + p.id,
                pid: p.id,
                name: p.name,
                lat: Number(p.lat),
                lng: Number(p.lng),
                radiusM: Number(p.radiusM) || 120,
                src: 'vm',
                count: 0,
                owners
            });
        });
        return out;
    }

    /** Filial koordinatasi qanchalik ishonchli: exact / manual / approx / none */
    function locInfo(p) {
        if (!p || p.lat == null || p.lng == null) {
            return { k: 'none', t: 'Koordinatasiz', d: 'Xaritada yoʻq — GPS bu filialga kelganini sanamaydi' };
        }
        const key = phNameKey(p.name);
        if (idx.geo.has(key)) return { k: 'exact', t: 'Aniq', d: 'Boomerangda chizilgan geozona' };
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        let near = null;
        idx.geoList.forEach((g) => {
            const m = distM(lat, lng, Number(g.lat), Number(g.lng));
            if (m <= (Number(g.radiusM) || 100) && (!near || m < near.m)) near = { g, m };
        });
        if (near) return { k: 'exact', t: 'Aniq', d: 'Boomerang «' + uiTxt(near.g.name) + '» geozonasi ichida' };
        const stop = idx.stop.get(key);
        if (stop && distM(lat, lng, Number(stop.lat), Number(stop.lng)) <= 40) {
            return { k: 'approx', t: 'Taxminiy', d: 'Koordinata GPS toʻxtashlar oʻrtachasidan (koʻcha nomi) olingan — joyini tekshiring' };
        }
        return { k: 'manual', t: 'Belgilangan', d: 'Xaritada qoʻlda belgilangan (Boomerangda yoʻq)' };
    }

    const isPlainStop = (it) => it.src === 'stop' && !it.owners.length;

    function stateOf(it) {
        const want = phCarKey(targetCar());
        if (want && it.owners.some((o) => phCarKey(o.car) === want)) return 'mine';
        if (it.owners.length) return 'other';
        if (OFFICE_RE.test(it.name)) return 'office';
        return it.src === 'stop' ? 'stop' : 'free';
    }

    // Barcha dorixona filiallari yashil; farq — to'qligi (shu mashina / bo'sh / boshqa mashina)
    const STYLE = {
        mine: { color: '#0f5132', weight: 3, fillColor: '#16a34a', fillOpacity: 0.45 },
        free: { color: '#15803d', weight: 2, fillColor: '#22c55e', fillOpacity: 0.32 },
        other: { color: '#3f8f5a', weight: 2, fillColor: '#86d39c', fillOpacity: 0.3 },
        office: { color: '#1a5fb4', weight: 1.5, fillColor: '#1a5fb4', fillOpacity: 0.16 },
        stop: { color: '#7b8794', weight: 1, fillColor: '#b9c6d6', fillOpacity: 0.4 }
    };
    const DOT_R = { mine: 7, free: 5.5, other: 5.5, office: 5, stop: 3.5 };

    function styleOf(it, st, sel, dim) {
        const s = Object.assign({ opacity: 1 }, STYLE[st]);
        if (it.src === 'vm') s.dashArray = '6 4';
        if (st === 'stop') s.dashArray = '2 5';
        if (sel) Object.assign(s, { color: '#b7791f', weight: 3, fillColor: '#f0c14b', fillOpacity: 0.55 });
        if (dim) Object.assign(s, { opacity: 0.45, fillOpacity: 0.12 });
        return s;
    }

    /** Markaz nuqtasi — uzoq zoomda ham filial ko'rinib tursin */
    function dotStyleOf(st, base, dim) {
        return {
            radius: DOT_R[st] || 5,
            color: '#fff',
            weight: st === 'stop' ? 1 : 1.5,
            fillColor: base.color,
            fillOpacity: dim ? 0.45 : 0.95,
            opacity: dim ? 0.5 : 1,
            bubblingMouseEvents: false
        };
    }

    function matchesQuery(it, q) {
        return !q || phNameMatch(it.name, q) || it.owners.some((o) => phNameMatch(o.name, q));
    }

    function render() {
        refreshTimer = 0;
        if (!init()) return;
        items = buildItems();
        byId = new Map();
        zoneLayer.clearLayers();
        const q = query();
        const zoom = map.getZoom();
        const view = map.getBounds().pad(0.2);
        const matched = [];
        let labels = 0;
        const dots = [];
        // Muhimlari oxirida chiziladi — ustda turadi
        const order = { stop: 0, free: 1, office: 1, other: 2, mine: 3 };
        items.forEach((it) => { it.state = stateOf(it); });
        items.sort((a, b) => (order[a.state] - order[b.state]) || (b.radiusM - a.radiusM));
        items.forEach((it) => {
            const sel = PH_SEL.has(it.name);
            const hit = matchesQuery(it, q);
            if (q && hit) matched.push(it);
            const dim = !!q && !hit;
            const style = styleOf(it, it.state, sel, dim);
            const circle = L.circle([it.lat, it.lng], Object.assign(
                { radius: it.radiusM, bubblingMouseEvents: false },
                style
            ));
            const dot = L.circleMarker([it.lat, it.lng], dotStyleOf(it.state, style, dim));
            const onClick = (e) => {
                L.DomEvent.stopPropagation(e);
                openItem(it);
            };
            circle.on('click', onClick);
            dot.on('click', onClick);
            const strong = it.state === 'mine' || sel || (q && hit);
            const near = zoom >= ALL_LABELS_ZOOM && !(q && !hit) && view.contains([it.lat, it.lng]);
            const permanent = (strong || near) && labels < MAX_LABELS;
            if (permanent) labels++;
            dot.bindTooltip(esc(uiTxt(it.name)) + (isPlainStop(it) ? ' · toʻxtash' : ''), {
                permanent,
                direction: 'top',
                offset: [0, -6],
                opacity: 1,
                className: 'phm-tip phm-tip-' + (sel ? 'sel' : it.state)
            });
            it.circle = circle;
            zoneLayer.addLayer(circle);
            dots.push(dot);
            byId.set(it.id, it);
        });
        dots.forEach((d) => zoneLayer.addLayer(d));
        renderSub();
        renderNoCoord();
        if (!fittedOnce && items.length) {
            fittedOnce = true;
            fitCar(false);
        }
        const querySig = q + '|' + matched.length;
        if (querySig !== lastQuery) {
            lastQuery = querySig;
            clearTimeout(queryTimer);
            queryTimer = setTimeout(() => onQuery(q, matched), 350);
        }
    }

    function schedule() {
        if (refreshTimer) return;
        refreshTimer = setTimeout(render, 60);
    }

    function renderSub() {
        const el = $('phm-sub');
        if (!el) return;
        const geo = items.filter((it) => it.src === 'gps').length;
        const vm = items.filter((it) => it.src === 'vm').length;
        const mine = items.filter((it) => it.state === 'mine').length;
        const car = targetCar();
        el.textContent = '· ' + geo + ' geozona' + (vm ? (' · ' + vm + ' tizimdagi') : '')
            + (car ? (' · ' + carLabel(car) + ': ' + mine + ' ta') : '');
    }

    /** Har bir filial joylashuvi: aniq / belgilangan / taxminiy / koordinatasiz */
    function renderNoCoord() {
        const box = $('phm-nocoord');
        if (!box) return;
        const all = (PHARMS || []).map((p) => ({ p, info: locInfo(p) }));
        if (!all.length) {
            box.hidden = true;
            box.innerHTML = '';
            box.dataset.sig = '';
            return;
        }
        const want = phCarKey(targetCar());
        const cnt = { exact: 0, manual: 0, approx: 0, none: 0 };
        all.forEach((r) => { cnt[r.info.k]++; });
        const rank = { none: 0, approx: 1, manual: 2, exact: 3 };
        const rows = all
            .filter((r) => r.info.k === 'none' || r.info.k === 'approx' || (want && phCarKey(r.p.car) === want))
            .sort((a, b) => {
                const am = want && phCarKey(a.p.car) === want ? 0 : 1;
                const bm = want && phCarKey(b.p.car) === want ? 0 : 1;
                return (am - bm) || (rank[a.info.k] - rank[b.info.k]) || String(a.p.name).localeCompare(String(b.p.name));
            });
        const sig = rows.map((r) => r.p.id + ':' + r.info.k).join('|') + '#' + want + (canEdit() ? '' : '#ro')
            + '#' + cnt.exact + cnt.manual;
        if (box.dataset.sig === sig) return;
        box.dataset.sig = sig;
        box.hidden = false;
        const problems = cnt.none + cnt.approx;
        const carProblems = rows.some((r) => want && phCarKey(r.p.car) === want && (r.info.k === 'none' || r.info.k === 'approx'));
        box.classList.toggle('ok', !problems);
        const html = rows.map(({ p, info }) => {
            const hasCoord = info.k !== 'none';
            const acts = (hasCoord ? `<button class="btn btn-sm" type="button" data-show="${esc(p.id)}">Xaritada</button>` : '')
                + (canEdit() && info.k !== 'exact'
                    ? ` <button class="btn btn-sm phm-edit${hasCoord ? '' : ' btn-gold'}" type="button" data-place="${esc(p.id)}">${hasCoord ? 'Joyini tuzatish' : 'Xaritada joylash'}</button>`
                    : '');
            return `<div class="phm-loc-row">
  <span class="phm-acc phm-acc-${info.k}">${info.t}</span>
  <span class="phm-loc-name"><b>${esc(uiTxt(p.name))}</b> · ${esc(carLabel(p.car))}<small>${esc(info.d)}</small></span>
  <span class="phm-loc-acts">${acts}</span>
</div>`;
        }).join('');
        const open = box.dataset.open ? box.dataset.open === '1' : carProblems;
        box.innerHTML = `<details${open ? ' open' : ''}><summary><b>Filiallar joylashuvi</b> — `
            + `<span class="phm-acc phm-acc-exact">${cnt.exact} aniq</span> `
            + (cnt.manual ? `<span class="phm-acc phm-acc-manual">${cnt.manual} belgilangan</span> ` : '')
            + (cnt.approx ? `<span class="phm-acc phm-acc-approx">${cnt.approx} taxminiy</span> ` : '')
            + (cnt.none ? `<span class="phm-acc phm-acc-none">${cnt.none} koordinatasiz</span>` : '')
            + '</summary>'
            + '<div class="m phm-loc-help">Aniq — Boomerang geozonasi. Belgilangan — xaritada qoʻlda qoʻyilgan. '
            + 'Taxminiy — koʻcha nomidagi GPS toʻxtashdan olingan, haqiqiy dorixona joyi boshqa boʻlishi mumkin. '
            + 'Koordinatasiz — GPS bu filialga kelganini sanamaydi.'
            + (want ? '' : ' Roʻyxatda muammolilar; mashina tanlasangiz — uning barcha filiallari.') + '</div>'
            + `<div class="phm-nc-list">${html || '<span class="muted">Muammoli filial yoʻq.</span>'}</div></details>`;
    }

    function itemForPharm(p) {
        const key = phNameKey(p.name);
        return items.find((it) => it.pid === p.id || (it.src !== 'stop' && phNameKey(it.name) === key))
            || items.find((it) => it.owners.some((o) => o.id === p.id));
    }

    function showPharm(pid) {
        const p = (PHARMS || []).find((x) => x.id === pid);
        if (!p || !init()) return;
        const it = itemForPharm(p);
        const lat = it ? it.lat : Number(p.lat);
        const lng = it ? it.lng : Number(p.lng);
        if (!isFinite(lat) || !isFinite(lng)) return;
        const box = $('phm-box');
        if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
        map.flyTo([lat, lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
        if (it) setTimeout(() => openItem(it), 650);
    }

    function placePharm(pid) {
        const p = (PHARMS || []).find((x) => x.id === pid);
        if (!p) return;
        startAdd({ pid });
        if (p.lat != null && p.lng != null) {
            map.flyTo([Number(p.lat), Number(p.lng)], Math.max(map.getZoom(), 17), { duration: 0.5 });
            startDraft(Number(p.lat), Number(p.lng));
        }
    }

    function fitTo(list, maxZoom) {
        if (!map || !list.length) return;
        if (list.length === 1) {
            map.flyTo([list[0].lat, list[0].lng], Math.min(maxZoom || 16, 16), { duration: 0.6 });
            return;
        }
        const b = L.latLngBounds(list.map((it) => [it.lat, it.lng]));
        map.flyToBounds(b.pad(0.15), { maxZoom: maxZoom || 15, duration: 0.6 });
    }

    function fitCar(animate) {
        if (!init()) return;
        const mine = items.filter((it) => stateOf(it) === 'mine');
        let list = mine.length ? mine : items.filter((it) => it.src === 'gps' && !OFFICE_RE.test(it.name));
        // Viloyatlardagi bir-ikki geozona xaritani butun Markaziy Osiyoga cho'zib yubormasin
        const homeM = (mine.length ? HOME_KM : CITY_KM) * 1000;
        const local = list.filter((it) => distM(it.lat, it.lng, DEFAULT_CENTER[0], DEFAULT_CENTER[1]) <= homeM);
        if (local.length) list = local;
        if (!list.length) {
            map.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
            return;
        }
        if (animate === false) {
            const b = L.latLngBounds(list.map((it) => [it.lat, it.lng]));
            map.fitBounds(b.pad(0.1), { maxZoom: 14 });
        } else {
            fitTo(list, 15);
        }
    }

    /* ── Qidiruv: xaritada topilganlar yoki manzil (OpenStreetMap) ── */

    function onQuery(q, matched) {
        const box = $('phm-find');
        if (!box) return;
        if (!q) {
            box.hidden = true;
            box.innerHTML = '';
            return;
        }
        box.hidden = false;
        const geoBtn = `<button class="btn btn-sm" type="button" data-geo-search>Manzil boʻyicha qidirish</button>`;
        const addBtn = canEdit() ? `<button class="btn btn-sm btn-gold phm-edit" type="button" data-phm-new>＋ Yangi filial sifatida qoʻshish</button>` : '';
        const pharms = matched.filter((it) => !isPlainStop(it));
        const stops = matched.filter(isPlainStop);
        if (pharms.length) {
            box.innerHTML = `<span>«${esc(q)}»: xaritada <b>${pharms.length}</b> ta filial`
                + (stops.length ? ` (+ ${stops.length} ta GPS toʻxtash — dorixona emas)` : '') + `</span>${geoBtn}`;
            fitTo(pharms, 16);
        } else if (stops.length) {
            box.innerHTML = `<span class="phm-find-warn">«${esc(q)}» nomli <b>dorixona yoʻq</b> — Boomerangda ham, tizimda ham. `
                + `Faqat ${stops.length} ta GPS toʻxtash joyi bor: bu <b>koʻcha nomi</b>, dorixona emas. `
                + 'Filial joyini bilsangiz — manzil qidiring yoki «Yangi filial» bilan xaritaga qoʻying.</span>'
                + geoBtn + addBtn;
            fitTo(stops, 16);
        } else {
            box.innerHTML = `<span>«${esc(q)}» Boomerang geozonalarida ham, tizimda ham yoʻq.</span>${geoBtn}${addBtn}`;
        }
    }

    async function geoSearch(q) {
        const box = $('phm-find');
        if (!box || !q) return;
        const seq = ++geoSeq;
        let list = box.querySelector('.phm-geo');
        if (!list) {
            list = document.createElement('div');
            list.className = 'phm-geo';
            box.appendChild(list);
        }
        list.innerHTML = '<span class="muted">Qidirilmoqda…</span>';
        try {
            const d = await vmApi('/api/office/geocode/search?q=' + encodeURIComponent(q));
            if (seq !== geoSeq) return;
            const res = Array.isArray(d.results) ? d.results : [];
            if (!res.length) {
                list.innerHTML = '<span class="muted">Manzil topilmadi — xaritada joyini oʻzingiz bosing.</span>';
                return;
            }
            list.innerHTML = res.map((r, i) =>
                `<button type="button" class="phm-geo-item" data-geo-pick="${i}"><b>${esc(r.name)}</b><small>${esc(r.detail || '')}</small></button>`
            ).join('');
            list._results = res;
        } catch (err) {
            if (seq === geoSeq) list.innerHTML = `<span class="muted">${esc(err.message || 'Xato')}</span>`;
        }
    }

    function onFindClick(e) {
        if (e.target.closest('[data-geo-search]')) {
            geoSearch(query());
            return;
        }
        if (e.target.closest('[data-phm-new]')) {
            startAdd();
            return;
        }
        const pick = e.target.closest('[data-geo-pick]');
        if (pick) {
            const list = pick.closest('.phm-geo');
            const r = list && list._results && list._results[Number(pick.getAttribute('data-geo-pick'))];
            if (!r) return;
            list.innerHTML = `<span class="muted">Tanlandi: <b>${esc(r.name)}</b></span>`
                + ` <button class="btn btn-sm" type="button" data-geo-search>Boshqa natijalar</button>`;
            map.flyTo([r.lat, r.lng], 17, { duration: 0.6 });
            if (canEdit()) {
                startAdd();
                let done = false;
                const go = () => {
                    if (done) return;
                    done = true;
                    startDraft(r.lat, r.lng);
                };
                map.once('moveend', go);
                setTimeout(go, 1200);
            }
        }
    }

    /* ── Mavjud aylana: popup + amallar ── */

    function stopPopupHtml(it) {
        let h = `<div class="phm-pop" data-item="${esc(it.id)}"><b>${esc(uiTxt(it.name))}</b>`
            + '<div class="phm-warn"><b>Bu dorixona emas.</b> GPS toʻxtash joyi — nomi koʻcha/manzildan olingan. '
            + 'Mashina shu atrofda toʻxtagan, xolos.</div>'
            + '<div class="phm-ev" data-ev>Toʻxtashlar yuklanmoqda…</div>'
            + '<div class="m" data-addr></div>';
        if (canEdit()) {
            h += '<div class="acts">'
                + '<button class="btn btn-sm btn-gold" type="button" data-act="create-here">＋ Shu yerda filial yaratish</button>'
                + '</div><div class="m">Filial aynan shu yerda ekaniga ishonchingiz boʻlsa yarating, belgini binoga sudrab qoʻying.</div>';
        }
        return h + '</div>';
    }

    function itemPopupHtml(it) {
        if (isPlainStop(it)) return stopPopupHtml(it);
        const car = targetCar();
        const want = phCarKey(car);
        const src = it.src === 'gps'
            ? 'Boomerang geozonasi'
            : (it.src === 'vm' ? 'Tizimdagi filial (Boomerangda yoʻq)' : 'Faqat GPS toʻxtash nuqtasi');
        const ph = it.pid ? (PHARMS || []).find((p) => p.id === it.pid) : null;
        const info = it.src === 'gps'
            ? { k: 'exact', t: 'Aniq', d: 'Boomerangda chizilgan geozona' }
            : (it.src === 'vm' ? locInfo(ph || it)
                : { k: 'approx', t: 'Taxminiy', d: 'Filialning oʻz koordinatasi yoʻq — GPS toʻxtash nuqtasi koʻrsatilmoqda' });
        let h = `<div class="phm-pop" data-item="${esc(it.id)}"><b>${esc(uiTxt(it.name))}</b>`
            + `<div class="m">${src} · radius ${it.radiusM} m</div>`
            + `<div class="phm-acc-line"><span class="phm-acc phm-acc-${info.k}">${info.t}</span> ${esc(info.d)}</div>`
            + '<div class="m" data-addr></div>';
        if (it.owners.length) {
            h += '<ul>' + it.owners.map((o) =>
                `<li class="${want && phCarKey(o.car) === want ? 'own' : ''}">${esc(carLabel(o.car))}</li>`
            ).join('') + '</ul>';
        } else {
            h += '<div class="m none">Hech bir mashinaga biriktirilmagan</div>';
        }
        if (canEdit()) {
            h += '<div class="acts">';
            if (!car) {
                h += '<div class="m">Avval yuqorida mashinani tanlang</div>';
            } else if (it.state === 'mine') {
                h += `<button class="btn btn-sm phm-danger" type="button" data-act="unassign">${esc(shortCar(car))} dan olib tashlash</button>`;
            } else {
                const label = it.owners.length ? 'Shu mashinaga oʻtkazish' : '＋ Biriktirish';
                h += `<button class="btn btn-sm btn-gold" type="button" data-act="assign">${label} → ${esc(shortCar(car))}</button>`;
            }
            if (it.state !== 'mine') {
                h += `<button class="btn btn-sm" type="button" data-act="sel">${PH_SEL.has(it.name) ? 'Belgidan olish' : 'Belgilash'}</button>`;
            }
            if (it.src !== 'gps' && (it.pid || it.owners.length)) {
                h += `<button class="btn btn-sm" type="button" data-act="move">${it.src === 'vm' ? 'Joyini tuzatish' : 'Joyini belgilash'}</button>`;
            }
            h += '</div>';
        }
        return h + '</div>';
    }

    function openItem(it) {
        if (addMode && !draft) {
            // Yangi filial rejimida mavjud aylana bosilsa — shu yerda allaqachon filial bor
            setHint('Bu yerda allaqachon «' + uiTxt(it.name) + '» bor. Boshqa joyga bosing yoki shu aylanani tanlang.');
        }
        // DOM tugun: popup.update() keyin yuklangan manzil/dalilni o'chirib yubormasin
        const el = document.createElement('div');
        el.innerHTML = itemPopupHtml(it);
        const popup = L.popup({ maxWidth: 320, className: 'phm-popup' })
            .setLatLng([it.lat, it.lng])
            .setContent(el)
            .openOn(map);
        fillAddress(el.querySelector('[data-addr]'), it.lat, it.lng, popup);
        if (isPlainStop(it)) loadEvidence(it, el.querySelector('[data-ev]'), popup);
    }

    function shortAddr(detail) {
        return String(detail || '').split(',').map((s) => s.trim())
            .filter((s) => s && !/^\d{5,6}$/.test(s) && !/(o.?zbekiston|узбекистан)/i.test(s))
            .slice(0, 5).join(', ');
    }

    function reverseAddr(lat, lng) {
        const key = Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5);
        if (!addrCache.has(key)) {
            const pr = vmApi('/api/office/geocode/reverse?lat=' + encodeURIComponent(lat) + '&lng=' + encodeURIComponent(lng))
                .then((r) => shortAddr(r.detail) || String(r.name || ''))
                .catch(() => { addrCache.delete(key); return ''; });
            addrCache.set(key, pr);
        }
        return addrCache.get(key);
    }

    async function fillAddress(el, lat, lng, popup) {
        if (!el) return;
        el.textContent = 'Manzil aniqlanmoqda…';
        const a = await reverseAddr(lat, lng);
        if (!map.hasLayer(popup)) return;
        el.textContent = a ? ('Manzil: ' + a) : '';
        popup.update();
    }

    function fmtDur(sec) {
        const s = Math.max(0, Number(sec) || 0);
        if (s < 60) return s + ' s';
        if (s < 3600) return Math.round(s / 60) + ' min';
        return Math.floor(s / 3600) + ' soat ' + Math.round((s % 3600) / 60) + ' min';
    }

    /** To'xtash joyi dalili: qachon, qaysi mashina, qancha turgan — xaritada nuqtalar */
    async function loadEvidence(it, el, popup) {
        if (!el) return;
        let d;
        try {
            d = await vmApi('/api/office/place-stops?name=' + encodeURIComponent(it.name));
        } catch (err) {
            el.textContent = err.message || 'Toʻxtashlar yuklanmadi';
            return;
        }
        if (!map.hasLayer(popup)) return;
        const stops = Array.isArray(d.stops) ? d.stops : [];
        if (!d.total) {
            el.textContent = 'Soʻnggi 60 kun hisobotlarida toʻxtash topilmadi.';
            popup.update();
            return;
        }
        const avg = d.durSec / d.total;
        const longest = stops.reduce((m, s) => Math.max(m, Number(s.durSec) || 0), 0);
        const cars = Object.entries(d.cars || {}).sort((a, b) => b[1] - a[1])
            .slice(0, 3).map(([c, n]) => esc(carLabel(c)) + (n > 1 ? (' ×' + n) : '')).join(', ');
        const verdict = (d.total >= 3 && avg >= 300)
            ? '<div class="phm-ev-v ok">Mashina bu yerda muntazam va uzoq turgan — filial shu atrofda boʻlishi mumkin.</div>'
            : '<div class="phm-ev-v">Qisqa / kam toʻxtash — dorixona tashrifiga oʻxshamaydi (yoʻl-yoʻlakay toʻxtash).</div>';
        el.innerHTML = `<div><b>${d.total}</b> marta · jami ${fmtDur(d.durSec)} · eng uzogʻi ${fmtDur(longest)}</div>`
            + `<div class="m">Mashinalar: ${cars || '—'}</div>`
            + '<ul class="phm-ev-list">' + stops.slice(0, 5).map((s) =>
                `<li>${esc(String(s.date).slice(5).split('-').reverse().join('.'))} ${esc(String(s.in).slice(0, 5))} · ${fmtDur(s.durSec)} · ${esc(carLabel(s.car))}</li>`
            ).join('') + (d.total > 5 ? `<li class="more">… yana ${d.total - 5} ta</li>` : '') + '</ul>'
            + verdict;
        evidenceLayer.clearLayers();
        stops.forEach((s) => {
            if (s.lat == null || s.lng == null) return;
            L.circleMarker([s.lat, s.lng], {
                radius: 5, color: '#9a3412', weight: 1.5, fillColor: '#f97316', fillOpacity: 0.85, interactive: false
            }).addTo(evidenceLayer);
        });
        popup.update();
    }

    function bindPopup(root) {
        if (!root || root.dataset.phmBound === '1') return;
        root.dataset.phmBound = '1';
        root.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-act]');
            if (!btn) return;
            e.preventDefault();
            const holder = btn.closest('[data-item]');
            if (holder) {
                const it = byId.get(holder.getAttribute('data-item'));
                if (it) runAction(btn.getAttribute('data-act'), it, btn);
                return;
            }
            if (btn.closest('.phm-draft')) runDraftAction(btn.getAttribute('data-act'), btn);
        });
        root.addEventListener('input', (e) => {
            if (!draft || !e.target.closest('.phm-draft')) return;
            const f = e.target.getAttribute('data-f');
            if (f === 'radius') draft.circle.setRadius(clampRadius(e.target.value, draft.circle.getRadius()));
            if (f === 'name') updateDraftNameNote(e.target.value);
        });
    }

    async function runAction(act, it, btn) {
        const car = targetCar();
        try {
            if (act === 'sel') {
                setPhSelected(it.name, !PH_SEL.has(it.name));
                map.closePopup();
                render();
                return;
            }
            if (act === 'create-here') {
                map.closePopup();
                startAdd();
                startDraft(it.lat, it.lng);
                return;
            }
            if (act === 'move') {
                const want = phCarKey(car);
                const owner = (it.pid && PHARMS.find((p) => p.id === it.pid))
                    || it.owners.find((o) => want && phCarKey(o.car) === want) || it.owners[0];
                map.closePopup();
                if (!owner) return;
                startAdd({ pid: owner.id });
                startDraft(it.lat, it.lng);
                return;
            }
            btn.disabled = true;
            if (act === 'assign') {
                if (!car) throw new Error('Avval mashinani tanlang');
                const moved = it.owners.length ? (' (' + it.owners.map((o) => o.car).join(', ') + ' dan)') : '';
                await assignPharmacy(it.name, car, it.lat, it.lng, { radiusM: it.radiusM, noHighlight: true });
                phNotify('"' + uiTxt(it.name) + '" → ' + carLabel(car) + moved);
            } else if (act === 'unassign') {
                if (!confirm('«' + uiTxt(it.name) + '» ni ' + carLabel(car) + ' dan olib tashlaysizmi?')) {
                    btn.disabled = false;
                    return;
                }
                const key = phNameKey(it.name);
                const want = phCarKey(car);
                PHARMS = PHARMS.filter((p) => !(phNameKey(p.name) === key && phCarKey(p.car) === want));
                await savePharms();
                show('msg-ph', '«' + uiTxt(it.name) + '» ' + carLabel(car) + ' dan olib tashlandi.', true);
            }
            map.closePopup();
        } catch (err) {
            btn.disabled = false;
            phNotify(err.message || String(err), false);
        }
    }

    /* ── Yangi filial / koordinatasiz filialni joylash ── */

    function setHint(text) {
        const el = $('phm-hint');
        if (!el) return;
        el.hidden = !text;
        el.textContent = text || '';
    }

    function startAdd(opts) {
        if (!canEdit() || !init()) return;
        const o = opts || {};
        placingId = o.pid || '';
        addMode = true;
        clearDraft();
        map.getContainer().classList.add('phm-adding');
        const btn = $('phm-add');
        if (btn) {
            btn.classList.add('on');
            btn.textContent = 'Bekor qilish';
        }
        const ph = placingId ? PHARMS.find((p) => p.id === placingId) : null;
        setHint(ph
            ? ('«' + uiTxt(ph.name) + '» joyini xaritada bosing')
            : 'Yangi filial joyiga bosing — keyin nom va radiusni kiriting (Esc — bekor)');
        const box = $('phm-box');
        if (box && box.scrollIntoView) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function stopAdd() {
        addMode = false;
        placingId = '';
        clearDraft();
        setHint('');
        if (map) map.getContainer().classList.remove('phm-adding');
        const btn = $('phm-add');
        if (btn) {
            btn.classList.remove('on');
            btn.textContent = '＋ Yangi filial';
        }
    }

    function clearDraft() {
        if (draftLayer) draftLayer.clearLayers();
        draft = null;
    }

    function draftField(name) {
        const el = draft && draft.marker.getPopup() && draft.marker.getPopup().getElement();
        return el ? el.querySelector('[data-f="' + name + '"]') : null;
    }

    function defaultDraftName() {
        if (placingId) {
            const ph = PHARMS.find((p) => p.id === placingId);
            return ph ? ph.name : '';
        }
        const q = query();
        if (q && !items.some((it) => (it.src !== 'stop' || it.owners.length) && matchesQuery(it, q))) return q;
        return '';
    }

    function draftHtml(name, radius) {
        const car = targetCar();
        const placing = !!placingId;
        return `<div class="phm-draft">
  <b>${placing ? 'Filial joyi' : 'Yangi filial'}</b>
  <label>Nomi</label>
  <input data-f="name" value="${esc(name)}" placeholder="Masalan: Boyjigit filiali"${placing ? ' readonly' : ''}>
  <div class="phm-note" data-f-note></div>
  <label>Radius, m</label>
  <input data-f="radius" type="number" min="40" max="500" step="10" value="${radius}">
  <div class="m" data-f-addr>Manzil aniqlanmoqda…</div>
  <div class="m mono" data-f-coord></div>
  <div class="phm-near" data-f-near hidden></div>
  <div class="acts">
    <button class="btn btn-sm btn-gold" type="button" data-act="draft-save">${placing ? 'Joyni saqlash' : ('Biriktirish → ' + esc(car ? shortCar(car) : 'mashina tanlanmagan'))}</button>
    <button class="btn btn-sm" type="button" data-act="draft-cancel">Bekor</button>
  </div>
  <div class="m">Belgini sudrab aniq joyga qoʻying.</div>
</div>`;
    }

    function startDraft(lat, lng) {
        if (!canEdit() || !init()) return;
        const ph = placingId ? PHARMS.find((p) => p.id === placingId) : null;
        const radius = ph ? clampRadius(ph.radiusM, 120) : inputRadius();
        const prevName = draftField('name');
        const name = prevName && prevName.value.trim() ? prevName.value.trim() : defaultDraftName();
        clearDraft();
        const circle = L.circle([lat, lng], {
            radius, color: '#b7791f', weight: 2, dashArray: '6 4',
            fillColor: '#f0c14b', fillOpacity: 0.3, interactive: false
        });
        const marker = L.marker([lat, lng], { draggable: true, autoPan: true });
        draft = { lat, lng, circle, marker };
        marker.on('drag', (ev) => circle.setLatLng(ev.target.getLatLng()));
        marker.on('dragend', (ev) => {
            const ll = ev.target.getLatLng();
            draft.lat = ll.lat;
            draft.lng = ll.lng;
            marker.openPopup();
            updateDraftInfo();
        });
        draftLayer.addLayer(circle);
        draftLayer.addLayer(marker);
        marker.bindPopup(draftHtml(name, radius), {
            maxWidth: 320, minWidth: 250, closeOnClick: false, autoClose: false, className: 'phm-popup'
        });
        marker.openPopup();
        setHint('');
        updateDraftInfo();
        updateDraftNameNote(name);
    }

    function updateDraftNameNote(name) {
        const el = draft && draft.marker.getPopup() && draft.marker.getPopup().getElement();
        const note = el && el.querySelector('[data-f-note]');
        if (!note) return;
        if (placingId || !String(name || '').trim()) {
            note.textContent = '';
            return;
        }
        const owners = phOwnersOf(name);
        note.textContent = owners.length
            ? ('Bu nom allaqachon bor: ' + owners.map((o) => o.car).join(', ') + ' — saqlasangiz shu yozuv yangilanadi.')
            : '';
    }

    async function updateDraftInfo() {
        if (!draft) return;
        const d = draft;
        const el = d.marker.getPopup() && d.marker.getPopup().getElement();
        if (!el) return;
        const coord = el.querySelector('[data-f-coord]');
        if (coord) coord.textContent = d.lat.toFixed(6) + ', ' + d.lng.toFixed(6);
        const nearEl = el.querySelector('[data-f-near]');
        if (nearEl) {
            let best = null;
            items.forEach((it) => {
                if (isPlainStop(it)) return;
                if (placingId && (it.pid === placingId || it.owners.some((o) => o.id === placingId))) return;
                const m = distM(d.lat, d.lng, it.lat, it.lng);
                if (m <= it.radiusM + NEAR_EXTRA_M && (!best || m < best.m)) best = { it, m };
            });
            if (best) {
                nearEl.hidden = false;
                nearEl.innerHTML = `Yaqinda: <b>${esc(uiTxt(best.it.name))}</b> (${Math.round(best.m)} m${best.it.owners.length ? (' · ' + esc(best.it.owners.map((o) => o.car).join(', '))) : ''}) — balki shu filialdir?`
                    + ` <button class="btn btn-sm" type="button" data-act="draft-near" data-near="${esc(best.it.id)}">Shuni ochish</button>`;
            } else {
                nearEl.hidden = true;
                nearEl.innerHTML = '';
            }
        }
        const addr = el.querySelector('[data-f-addr]');
        if (!addr) return;
        addr.textContent = 'Manzil aniqlanmoqda…';
        try {
            const r = await vmApi('/api/office/geocode/reverse?lat=' + encodeURIComponent(d.lat) + '&lng=' + encodeURIComponent(d.lng));
            if (draft !== d) return;
            addr.textContent = 'Manzil: ' + String(r.detail || r.name || '—').slice(0, 140);
            const nameEl = el.querySelector('[data-f="name"]');
            if (nameEl && !nameEl.value.trim() && !placingId) nameEl.placeholder = (r.name || 'Filial nomi') + ' filiali';
        } catch (_e) {
            if (draft === d) addr.textContent = '';
        }
    }

    async function runDraftAction(act, btn) {
        if (act === 'draft-cancel') {
            stopAdd();
            return;
        }
        if (act === 'draft-near') {
            const it = byId.get(btn.getAttribute('data-near'));
            stopAdd();
            if (it) {
                map.flyTo([it.lat, it.lng], Math.max(map.getZoom(), 16), { duration: 0.5 });
                setTimeout(() => openItem(it), 550);
            }
            return;
        }
        if (act !== 'draft-save' || !draft) return;
        const nameEl = draftField('name');
        const radiusEl = draftField('radius');
        const name = String((nameEl && nameEl.value) || '').trim();
        const radius = clampRadius(radiusEl && radiusEl.value, 120);
        const lat = Number(draft.lat.toFixed(6));
        const lng = Number(draft.lng.toFixed(6));
        btn.disabled = true;
        try {
            if (placingId) {
                const ph = PHARMS.find((p) => p.id === placingId);
                if (!ph) throw new Error('Filial topilmadi — sahifani yangilang');
                const key = phNameKey(ph.name);
                PHARMS.forEach((p) => {
                    if (p.id !== ph.id && phNameKey(p.name) !== key) return;
                    p.lat = lat;
                    p.lng = lng;
                    p.radiusM = radius;
                });
                await savePharms();
                phNotify('"' + uiTxt(ph.name) + '" joyi saqlandi · ' + carLabel(ph.car));
            } else {
                const car = targetCar();
                if (!name) throw new Error('Filial nomini yozing');
                if (!car) throw new Error('Avval yuqorida mashinani tanlang');
                await assignPharmacy(name, car, lat, lng, { radiusM: radius, noHighlight: true });
                phNotify('"' + name + '" (yangi filial) → ' + carLabel(car));
            }
            stopAdd();
            render();
        } catch (err) {
            btn.disabled = false;
            phNotify(err.message || String(err), false);
        }
    }

    window.phMap = {
        refresh: schedule,
        fitCar: () => { schedule(); setTimeout(() => fitCar(true), 80); },
        startAdd
    };
})();
