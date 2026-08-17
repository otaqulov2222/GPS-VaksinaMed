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

function vmStopKey(dateVal, car, st) {
    const t = String((st && st.inTime) || '');
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
        (window.DRIVERS || []).forEach(d => {
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
        try {
            const d = await vmApi('/api/office/bootstrap');
            STATE.pharmacies = Array.isArray(d.pharmacies) ? d.pharmacies : [];
            STATE.reviews = d.reviews && typeof d.reviews === 'object' ? d.reviews : {};
            this.reportDates = d.reportDates || [];
            this.telegram = d.telegram || this.telegram;
            if (!STATE.pharmacies.length) {
                STATE.pharmacies = this.seedFromDrivers();
            }
        } catch (e) {
            console.warn('office bootstrap:', e);
            if (!STATE.pharmacies || !STATE.pharmacies.length) {
                STATE.pharmacies = this.seedFromDrivers();
            }
            if (!STATE.reviews) STATE.reviews = {};
        }
        if (typeof buildPharmIndex === 'function') buildPharmIndex();
        if (STATE.currentDate) await this.loadReportIfNeeded(STATE.currentDate);
    },

    async loadReportIfNeeded(dateVal) {
        if (!dateVal) return;
        const hasLocal = STATE.data[dateVal] && Object.keys(STATE.data[dateVal]).length;
        if (hasLocal) {
            if (typeof recomputeDay === 'function') recomputeDay(dateVal);
            this.renderFleetBoard();
            return;
        }
        try {
            const d = await vmApi('/api/office/report?date=' + encodeURIComponent(dateVal));
            if (d.reviews) {
                STATE.reviews[dateVal] = d.reviews;
            }
            if (d.report && d.report.cars && typeof d.report.cars === 'object') {
                STATE.data[dateVal] = d.report.cars;
                if (!STATE.history.includes(dateVal)) STATE.history.push(dateVal);
                if (typeof recomputeDay === 'function') recomputeDay(dateVal);
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

    async saveReport(dateVal) {
        if (!dateVal || !STATE.data[dateVal]) return;
        try {
            await vmApi('/api/office/report', {
                method: 'POST',
                body: JSON.stringify({ date: dateVal, cars: STATE.data[dateVal] })
            });
        } catch (e) {
            console.warn('office save:', e);
        }
    },

    reviewOf(dateVal, car, st) {
        const key = vmStopKey(dateVal, car, st);
        const bag = STATE.reviews[dateVal] || {};
        return bag[key] || null;
    },

    isProblem(dateVal, car, st) {
        const rev = this.reviewOf(dateVal, car, st);
        if (rev && rev.status === 'allowed') return false;
        if (rev && rev.status === 'violation') return true;
        return !!(st && st.isProblem);
    },

    async setReview(dateVal, car, st, status) {
        const key = vmStopKey(dateVal, car, st);
        try {
            const d = await vmApi('/api/office/reviews', {
                method: 'POST',
                body: JSON.stringify({ date: dateVal, key, status: status || '' })
            });
            STATE.reviews[dateVal] = d.reviews || {};
        } catch (e) {
            showToast('Belgilash saqlanmadi: ' + e.message, 'error');
            return;
        }
        if (typeof recomputeCar === 'function') recomputeCar(dateVal, car);
        if (typeof saveAll === 'function') saveAll();
        if (typeof refreshUI === 'function') refreshUI();
        this.renderFleetBoard();
        this.saveReport(dateVal);
    },

    ownNames(car) {
        const fromState = (STATE.pharmacies || []).filter(p => p.car === car).map(p => p.name).filter(Boolean);
        if (fromState.length) return fromState;
        const drv = (window.DRIVERS || []).find(d => d.car === car);
        if (!drv || !drv.pharmacies) return [];
        return String(drv.pharmacies).split(',').map(s => s.trim()).filter(Boolean);
    },

    matchGeo(currentCar, lat, lng) {
        const y = Number(lat), x = Number(lng);
        if (!y || !x) return null;
        let best = null, bestD = 1e12;
        (STATE.pharmacies || []).forEach(ph => {
            if (ph.lat == null || ph.lng == null) return;
            const d = vmHaversineM(y, x, Number(ph.lat), Number(ph.lng));
            const r = Number(ph.radiusM) || 120;
            if (d <= r && d < bestD) {
                bestD = d;
                best = ph;
            } else if (d <= r && d === bestD && ph.car === currentCar) {
                best = ph;
            }
        });
        if (!best) return null;
        const owners = (STATE.pharmacies || [])
            .filter(p => p.name === best.name || (p.lat === best.lat && p.lng === best.lng))
            .map(p => {
                const drv = (window.DRIVERS || []).find(d => d.car === p.car);
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
        list.forEach(p => {
            const circle = L.circle([p.lat, p.lng], {
                radius: p.radiusM || 120,
                color: '#1a5c3a',
                weight: 1,
                fillColor: '#1a5c3a',
                fillOpacity: 0.08,
                interactive: false
            }).addTo(map);
            const mark = L.circleMarker([p.lat, p.lng], {
                radius: 4,
                color: '#1a5c3a',
                fillColor: '#1a5c3a',
                fillOpacity: 0.9,
                weight: 1
            }).addTo(map);
            mark.bindTooltip(p.name, { permanent: false, direction: 'top' });
            this.geoLayers.push(circle, mark);
        });
    },

    fleetRows(dateVal) {
        const day = (dateVal && STATE.data[dateVal]) ? STATE.data[dateVal] : {};
        return (window.DRIVERS || []).map(drv => {
            const rec = day[drv.car];
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
        }).sort((a, b) => {
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
        if (!loaded) {
            el.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:22px;color:#8b939e;">GPS yuklangandan so'ng barcha mashina shu yerda chiqadi.</td></tr>`;
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
        el.querySelectorAll('tr[data-car]').forEach(tr => {
            tr.addEventListener('click', () => {
                if (typeof selectDriver === 'function') selectDriver(tr.getAttribute('data-car'));
            });
        });
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
