'use strict';
/* Ofis nazorati: geozona, reyting, ruxsat, server saqlash, Telegram */

function vmEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function vmHaversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toR = Math.PI / 180;
    const dLat = (lat2 - lat1) * toR;
    const dLng = (lng2 - lng1) * toR;
    const a = Math.sin(dLat / 2) ** 2
        + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function plateCompact(p) {
    return String(p || '').replace(/\s+/g, '').toUpperCase();
}

function vmStopKey(dateVal, car, st) {
    const rawT = String((st && st.inTime) || '');
    const t = (typeof normalizeClock === 'function' ? normalizeClock(rawT) : rawT) || rawT;
    const p = String((st && st.place) || '').slice(0, 50);
    const lat = Number((st && st.lat) || 0).toFixed(4);
    const lng = Number((st && st.lng) || 0).toFixed(4);
    return [dateVal, car, t, lat, lng, p].join('|');
}

const VMOffice = {
    telegram: { enabled: false, hasToken: false, chatId: '' },
    reportDates: [],
    geoLayers: [],

    seedFromDrivers() {
        const list = [];
        this.driversList().forEach(d => {
            if (!d.pharmacies) return;
            String(d.pharmacies).split(',').forEach((name, i) => {
                name = name.trim();
                if (!name) return;
                const tag = String(d.car).replace(/\s+/g, '');
                list.push({
                    id: 'ph_' + tag + '_' + String(i + 1).padStart(2, '0'),
                    car: d.car,
                    name,
                    lat: null,
                    lng: null,
                    radiusM: 120,
                    aliases: []
                });
            });
        });
        return list;
    },

    async bootstrap() {
        let d = null;
        try {
            d = await vmApi('/api/office/bootstrap');
            STATE.pharmacies = Array.isArray(d.pharmacies) ? d.pharmacies : [];
            STATE.reviews = d.reviews && typeof d.reviews === 'object' ? d.reviews : {};
            this.reportDates = d.reportDates || [];
            this.telegram = d.telegram || this.telegram;
            if (d.gps && typeof d.gps === 'object') {
                this.gpsStatus = d.gps;
            }
            this.persistInfo = d.persist || null;
            if (d.fuelNorms && typeof d.fuelNorms === 'object' && Object.keys(d.fuelNorms).length) {
                STATE.fuelNorms = Object.assign({}, STATE.fuelNorms || {}, d.fuelNorms);
                if (typeof saveAll === 'function') saveAll();
            }
            if (!STATE.pharmacies.length) {
                STATE.pharmacies = this.seedFromDrivers();
            }
            if (d.persist && d.persist.durable === false && typeof showToast === 'function') {
                showToast('Diqqat: ma\'lumotlar DB emas — faqat lokal fayl. DATABASE_URL tekshiring.', 'warn');
            }
        } catch (e) {
            console.warn('office bootstrap:', e);
            if (!STATE.pharmacies || !STATE.pharmacies.length) {
                STATE.pharmacies = this.seedFromDrivers();
            }
            if (!STATE.reviews) STATE.reviews = {};
        }
        if (d && d.vehicles && typeof applyFleetNameOverrides === 'function') {
            applyFleetNameOverrides(d.vehicles);
        }
        if (typeof buildPharmIndex === 'function') buildPharmIndex();
        if (!this._fleetClickBound) {
            this._fleetClickBound = true;
            const el = document.getElementById('fleet-board-body');
            if (el) {
                el.addEventListener('click', e => {
                    const tr = e.target.closest('tr[data-car]');
                    if (tr && typeof selectDriver === 'function') selectDriver(tr.getAttribute('data-car'));
                });
            }
        }
        if (STATE.currentDate) await this.loadReportIfNeeded(STATE.currentDate);
    },

    async saveReport(dateVal, opts) {
        opts = opts || {};
        if (!dateVal || !STATE.data[dateVal]) return false;
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const res = await vmApi('/api/office/report', {
                    method: 'POST',
                    body: JSON.stringify({ date: dateVal, cars: STATE.data[dateVal] })
                });
                if (res && res.durable === false && !opts.silent && typeof showToast === 'function' && !this._warnedNonDurable) {
                    this._warnedNonDurable = true;
                    showToast('Saqlandi, lekin DB emas (lokal fayl). Prod uchun DATABASE_URL kerak.', 'warn');
                }
                return true;
            } catch (e) {
                lastErr = e;
                await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
            }
        }
        console.warn('office save:', lastErr);
        if (!opts.silent && typeof showToast === 'function') {
            const msg = (lastErr && (lastErr.message || lastErr.error)) || 'xato';
            showToast('Serverga saqlanmadi: ' + msg + '. Qayta saqlang / internetni tekshiring.', 'error');
        }
        return false;
    },

    async saveDashboardSettings(fuelNorms) {
        try {
            const res = await vmApi('/api/office/dashboard-settings', {
                method: 'POST',
                body: JSON.stringify({ fuelNorms: fuelNorms || STATE.fuelNorms || {} })
            });
            if (res && res.fuelNorms) {
                STATE.fuelNorms = Object.assign({}, STATE.fuelNorms || {}, res.fuelNorms);
            }
            return !!(res && res.ok !== false);
        } catch (e) {
            console.warn('dashboard settings:', e);
            if (typeof showToast === 'function') {
                showToast('Normallar serverga yozilmadi: ' + (e.message || e), 'error');
            }
            return false;
        }
    },

    async loadReportIfNeeded(dateVal, force) {
        if (!dateVal) return;
        const hasLocal = STATE.data[dateVal] && Object.keys(STATE.data[dateVal]).length;
        const carsMissingTrack = (cars) => Object.values(cars || {}).some(rec => {
            if (!rec || typeof rec !== 'object') return false;
            // stops bor, trek yo'q — serverdan to'ldirish kerak (har qanday kun)
            const hasStops = Array.isArray(rec.stops) && rec.stops.length > 0;
            const pts = rec.points;
            const hasPts = Array.isArray(pts) && pts.length >= 2;
            return hasStops && !hasPts;
        });
        if (hasLocal && !force) {
            const cars = STATE.data[dateVal];
            const needsRecompute = Object.values(cars).some(rec => {
                const a = rec && rec.analysis;
                return !a || a._source !== 'server';
            });
            if (needsRecompute && typeof recomputeDay === 'function') {
                try { await recomputeDay(dateVal); } catch (e) { console.warn('recomputeDay:', e); }
            }
            // Localda trek bo'lmasa — server hisobotidan points olish (boshqa kunlar uchun)
            if (!carsMissingTrack(cars)) {
                this.renderFleetBoard();
                return;
            }
        }
        if (hasLocal && force) {
            // Localni oldindan o'chirmaymiz — server muvaffaqiyatsiz bo'lsa kun bo'sh qolmasin
        }
        try {
            const d = await vmApi('/api/office/report?date=' + encodeURIComponent(dateVal));
            if (d.reviews) {
                STATE.reviews[dateVal] = d.reviews;
            }
            if (d.report && d.report.cars && typeof d.report.cars === 'object') {
                const incoming = d.report.cars;
                if (hasLocal && !force && carsMissingTrack(STATE.data[dateVal])) {
                    // Faqat yetishmayotgan trekni qo'shamiz — local stops/ballni yo'qotmaymiz
                    Object.keys(incoming).forEach((car) => {
                        const src = incoming[car];
                        const dst = STATE.data[dateVal][car];
                        if (!src) return;
                        if (!dst) {
                            STATE.data[dateVal][car] = src;
                            return;
                        }
                        const srcPts = Array.isArray(src.points) ? src.points : [];
                        const dstPts = Array.isArray(dst.points) ? dst.points : [];
                        if (srcPts.length >= 2 && dstPts.length < 2) {
                            dst.points = srcPts;
                        } else if (srcPts.length > dstPts.length) {
                            dst.points = srcPts;
                        }
                    });
                } else {
                    STATE.data[dateVal] = incoming;
                }
                Object.values(STATE.data[dateVal]).forEach(rec => {
                    if (rec && rec.analysis) rec.analysis._source = 'server';
                });
                if (!STATE.history.includes(dateVal)) STATE.history.push(dateVal);
                // Server analysis saqlangan — JS bilan qayta yozilmaydi
                if (typeof saveAll === 'function') saveAll();
                if (typeof renderCalendar === 'function') renderCalendar();
                if (typeof renderDriverTabs === 'function') renderDriverTabs();
                if (typeof refreshUI === 'function') refreshUI();
            }
        } catch (e) {
            console.warn('office report:', e);
        }
        this.renderFleetBoard();
    },

    reviewOf(dateVal, car, st) {
        const key = vmStopKey(dateVal, car, st);
        const bag = STATE.reviews[dateVal] || {};
        if (bag[key]) return bag[key];
        // Yumshoq moslash: vaqt + joy (HH:MM vs HH:MM:SS farqi bo'lsa ham)
        const want = plateCompact(car);
        const normT = (typeof normalizeClock === 'function')
            ? normalizeClock((st && st.inTime) || '')
            : String((st && st.inTime) || '');
        const tShort = normT ? normT.slice(0, 5) : '';
        const p = String((st && st.place) || '').slice(0, 50);
        for (const k of Object.keys(bag)) {
            const rv = bag[k];
            if (!rv) continue;
            const parts = String(k).split('|');
            if (parts.length < 6) continue;
            const carK = rv.car || parts[1] || '';
            if (plateCompact(carK) !== want) continue;
            const kt = String(parts[2] || '');
            const ktNorm = (typeof normalizeClock === 'function') ? normalizeClock(kt) : kt;
            const timeOk = ktNorm === normT || kt === normT || (tShort && (kt === tShort || ktNorm.slice(0, 5) === tShort));
            if (timeOk && String(parts[5] || '').slice(0, 50) === p) return rv;
        }
        return null;
    },

    isProblem(dateVal, car, st) {
        const rev = this.reviewOf(dateVal, car, st);
        if (rev && rev.status === 'allowed') return false;
        if (rev && rev.status === 'violation') return true;
        return !!(st && st.isProblem);
    },

    async setReview(dateVal, car, st, status, phName, note) {
        const key = vmStopKey(dateVal, car, st);
        const body = {
            date: dateVal,
            key,
            status: status || '',
            car,
            lat: st && st.lat != null ? st.lat : undefined,
            lng: st && st.lng != null ? st.lng : undefined,
        };
        if (phName) body.phName = phName;
        const noteTxt = String(note || '').trim().slice(0, 400);
        if (noteTxt) body.note = noteTxt;
        try {
            const d = await vmApi('/api/office/reviews', {
                method: 'POST',
                body: JSON.stringify(body)
            });
            STATE.reviews[dateVal] = d.reviews || {};
        } catch (e) {
            showToast('Belgilash saqlanmadi: ' + e.message, 'error');
            return;
        }
        // Server reprocess_day qilgan — hisobotni qayta yuklash (yagona ball manbai)
        try {
            await this.loadReportIfNeeded(dateVal, true);
        } catch (e) {
            if (typeof recomputeCar === 'function') {
                try { await recomputeCar(dateVal, car); } catch (e2) {}
            }
        }
        if (typeof saveAll === 'function') saveAll();
        if (typeof refreshUI === 'function') refreshUI();
        this.renderFleetBoard();
        this.saveReport(dateVal);
    },

    recForPlate(day, plate) {
        if (!day || !plate) return null;
        if (day[plate]) return day[plate];
        const compact = plateCompact(plate);
        for (const k of Object.keys(day)) {
            if (plateCompact(k) === compact) return day[k];
        }
        return null;
    },

    ownNames(car) {
        const fromState = (STATE.pharmacies || []).filter(p => p.car === car).map(p => p.name).filter(Boolean);
        const raw = fromState.length
            ? fromState
            : (() => {
                const drv = this.driversList().find(d => d.car === car);
                if (!drv || !drv.pharmacies) return [];
                return String(drv.pharmacies).split(',').map(s => s.trim()).filter(Boolean);
            })();
        const fold = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9а-яўқғҳ]/gi, '');
        const seen = new Set();
        const out = [];
        raw.forEach(n => {
            const k = fold(n);
            if (!k || seen.has(k)) return;
            seen.add(k);
            out.push(n);
        });
        return out;
    },

    matchGeo(currentCar, lat, lng) {
        const y = Number(lat), x = Number(lng);
        if (!y || !x) return null;
        let bestOwn = null, bestOwnD = 1e12;
        let bestAny = null, bestAnyD = 1e12;
        (STATE.pharmacies || []).forEach(ph => {
            if (ph.lat == null || ph.lng == null) return;
            const d = vmHaversineM(y, x, Number(ph.lat), Number(ph.lng));
            const r = Number(ph.radiusM) || 120;
            if (d > r) return;
            if (d < bestAnyD) {
                bestAnyD = d;
                bestAny = ph;
            }
            if (ph.car === currentCar && d < bestOwnD) {
                bestOwnD = d;
                bestOwn = ph;
            }
        });
        const best = bestOwn || bestAny;
        if (!best) return null;
        const owners = (STATE.pharmacies || [])
            .filter(p => p.name === best.name || (p.lat === best.lat && p.lng === best.lng))
            .map(p => {
                const drv = this.driversList().find(d => d.car === p.car);
                return drv ? drv.shortName : p.car;
            });
        const uniq = [...new Set(owners)];
        return {
            type: best.car === currentCar ? 'own' : 'other',
            phName: best.name,
            owners: uniq,
            by: 'geo'
        };
    },

    drawGeofences(map, car) {
        this.geoLayers.forEach(l => {
            try { map.removeLayer(l); } catch (e) {}
        });
        this.geoLayers = [];
        if (!map || typeof L === 'undefined') return;
        const list = (STATE.pharmacies || []).filter(p => p.car === car && p.lat != null && p.lng != null);
        if (!list.length) return;
        const group = L.layerGroup();
        list.forEach(p => {
            group.addLayer(L.circle([p.lat, p.lng], {
                radius: p.radiusM || 120,
                color: '#1a5fb4',
                weight: 1,
                fillColor: '#1a5fb4',
                fillOpacity: 0.08,
                interactive: false
            }));
            const mark = L.circleMarker([p.lat, p.lng], {
                radius: 4,
                color: '#1a5fb4',
                fillColor: '#1a5fb4',
                fillOpacity: 0.9,
                weight: 1,
                interactive: false
            });
            mark.bindTooltip(typeof uzUi === 'function' ? uzUi(p.name) : p.name, { permanent: false, direction: 'top', sticky: true });
            group.addLayer(mark);
        });
        group.addTo(map);
        this.geoLayers.push(group);
    },

    driversList() {
        if (typeof DRIVERS !== 'undefined' && Array.isArray(DRIVERS) && DRIVERS.length) return DRIVERS;
        return window.DRIVERS || [];
    },

    rowOf(drv, rec) {
        if (!rec) {
            return { drv, rec: null, score: null, km: 0, own: 0, total: this.ownNames(drv.car).length, other: 0, problem: 0, speed: 0, work: '—' };
        }
        const a = rec.analysis || {};
        const sc = a.score || {};
        return {
            drv,
            rec,
            score: sc.final,
            km: (rec.stats && rec.stats.probeg) || 0,
            own: a.ownVisited || 0,
            total: a.totalOwn || this.ownNames(drv.car).length,
            other: a.otherDirection || 0,
            problem: a.problemStops || 0,
            speed: (rec.stats && rec.stats.maxSpeed) || 0,
            work: (rec.stats && rec.stats.motoChas) || '—'
        };
    },

    fleetRows(dateVal) {
        const day = (dateVal && STATE.data[dateVal]) ? STATE.data[dateVal] : {};
        const drivers = this.driversList();
        const used = new Set();
        const markUsed = p => { if (p) used.add(plateCompact(p)); };
        const isUsed = p => used.has(plateCompact(p));
        const rows = drivers.map(raw => {
            const drv = typeof resolveDriver === 'function' ? resolveDriver(raw.car, raw) : raw;
            const rec = this.recForPlate(day, drv.car);
            if (rec) {
                markUsed(drv.car);
                Object.keys(day).forEach(k => { if (day[k] === rec) markUsed(k); });
                if (rec.driver) rec.driver = (typeof resolveDriver === 'function') ? resolveDriver(drv.car, rec.driver) : rec.driver;
            }
            return this.rowOf(drv, rec);
        });
        Object.keys(day).forEach(car => {
            if (isUsed(car)) return;
            const rec = day[car];
            const drv = (typeof resolveDriver === 'function')
              ? resolveDriver(car, (rec && rec.driver) || null)
              : ((rec && rec.driver) || { fullName: car, shortName: car, car, routes: '—' });
            markUsed(car);
            rows.push(this.rowOf(drv, rec));
        });
        return rows.sort((a, b) => {
            const as = a.rec ? (a.score == null ? -1 : a.score) : -2;
            const bs = b.rec ? (b.score == null ? -1 : b.score) : -2;
            return bs - as;
        });
    },

    renderFleetBoard() {
        const el = document.getElementById('fleet-board-body');
        const meta = document.getElementById('fleet-board-meta');
        if (!el) return;
        const dateVal = STATE.currentDate;
        const rows = this.fleetRows(dateVal);
        const loaded = rows.filter(r => r.rec).length;
        const avg = rows.filter(r => r.rec && r.score != null);
        const avgN = avg.length ? (avg.reduce((s, r) => s + r.score, 0) / avg.length) : 0;
        const probs = rows.reduce((s, r) => s + (r.problem || 0), 0);
        if (meta) {
            meta.textContent = loaded
                ? `${loaded} mashina · o'rtacha ${avgN.toFixed(1)} ball · ${probs} muammo`
                : 'Bu kunda ma\'lumot yo\'q';
        }
        if (!rows.length) {
            el.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:22px;color:#8aa0b8;">Haydovchilar ro'yxati topilmadi.</td></tr>`;
            return;
        }
        el.innerHTML = rows.map((r, i) => {
            const active = r.drv.car === STATE.currentCar ? ' is-active' : '';
            const empty = !r.rec;
            const scoreTxt = empty ? '—' : (r.score == null ? '—' : Number(r.score).toFixed(1));
            const scoreCls = empty ? '' : (r.score >= 8 ? 'rk-ok' : r.score >= 5 ? 'rk-mid' : 'rk-bad');
            const plan = r.total ? `${r.own}/${r.total}` : '—';
            return `<tr class="rank-row${active}${empty ? ' is-empty' : ''}" data-car="${vmEsc(r.drv.car)}">
                <td class="font-mono text-muted">${i + 1}</td>
                <td><strong>${vmEsc(r.drv.shortName)}</strong></td>
                <td class="font-mono">${vmEsc(r.drv.car)}</td>
                <td class="${scoreCls}">${scoreTxt}</td>
                <td class="font-mono">${empty ? '—' : (typeof fmtKm === 'function' ? fmtKm(r.km) : r.km)}</td>
                <td class="font-mono">${empty ? '—' : plan}</td>
                <td class="font-mono">${empty ? '—' : r.other}</td>
                <td class="font-mono">${empty ? '—' : r.problem}</td>
                <td class="font-mono">${empty ? '—' : (typeof fmtSpd === 'function' ? fmtSpd(r.speed) : (r.speed || '—'))}</td>
            </tr>`;
        }).join('');
    },

    buildDigest(dateVal) {
        const rows = this.fleetRows(dateVal).filter(r => r.rec);
        const d = new Date(dateVal + 'T00:00:00');
        const title = `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
        const lines = [`VAKSINA MED · ${title}`, `Yuklandi: ${rows.length} mashina`, ''];
        const low = rows.filter(r => r.score != null && r.score < 7);
        if (low.length) {
            lines.push('Ball < 7:');
            low.slice(0, 8).forEach(r => {
                lines.push(`• ${r.drv.shortName} ${Number(r.score).toFixed(1)} · muammo ${r.problem} · ${typeof fmtSpd === 'function' ? fmtSpd(r.speed, 'km/soat') : (r.speed + ' km/soat')}`);
            });
            lines.push('');
        }
        const fast = rows.filter(r => r.speed > 90);
        if (fast.length) {
            lines.push('Tezlik > 90:');
            fast.forEach(r => lines.push(`• ${r.drv.shortName} ${typeof fmtSpd === 'function' ? fmtSpd(r.speed, 'km/soat') : (r.speed + ' km/soat')}`));
            lines.push('');
        }
        const messy = [...rows].sort((a, b) => b.problem - a.problem).filter(r => r.problem > 0).slice(0, 6);
        if (messy.length) {
            lines.push('Muammoli to\'xtash:');
            messy.forEach(r => lines.push(`• ${r.drv.shortName} ${r.problem} ta`));
        }
        if (lines.length < 4) lines.push('Kun me\'yorida.');
        return lines.join('\n');
    },

    async sendDigest(dateVal) {
        if (!this.telegram || !this.telegram.ready) return;
        const text = this.buildDigest(dateVal);
        try {
            const d = await vmApi('/api/office/telegram/digest', {
                method: 'POST',
                body: JSON.stringify({ date: dateVal, text })
            });
            if (d && d.skipped) return;
        } catch (e) {
            console.warn('telegram digest:', e);
        }
    }
};

window.VMOffice = VMOffice;
window.vmStopKey = vmStopKey;
window.vmHaversineM = vmHaversineM;
window.vmEsc = vmEsc;
