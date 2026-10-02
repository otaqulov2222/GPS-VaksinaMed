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

function depPlateNum(p) {
    const d = String(p || '').replace(/\D/g, '');
    return d.length > 3 ? d.slice(2) : d;
}

function depLateTxt(min) {
    const m = Math.max(0, Number(min) || 0);
    if (!m) return '';
    return m >= 60 ? `+${Math.floor(m / 60)} soat ${String(m % 60).padStart(2, '0')} daq` : `+${m} daq`;
}

const DEP_WEEKDAYS = ['Yakshanba', 'Dushanba', 'Seshanba', 'Chorshanba', 'Payshanba', 'Juma', 'Shanba'];

function depDateUz(dateVal) {
    const d = new Date(dateVal + 'T00:00:00');
    if (isNaN(d)) return dateVal || '';
    return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()} · ${DEP_WEEKDAYS[d.getDay()]}`;
}

function depDetailHtml(dep) {
    const tone = dep.excused ? 'excused' : (dep.counted ? 'bad' : (dep.status === 'ok' ? 'ok' : 'neutral'));
    const row = (k, v) => v ? `<div class="dep-kv"><span>${k}</span><b>${vmEsc(v)}</b></div>` : '';
    let html = `<div class="dep-state dep-state-${tone}">${vmEsc(dep.label || dep.status)}${dep.excused ? ' · uzrli' : ''}</div>`;
    html += '<div class="dep-kvs">';
    html += row('Chiqish muddati', dep.deadline);
    html += row('Hududga kelgan', dep.arriveAt || (dep.overnight ? 'tundan beri hududda' : ''));
    html += row('Hududdan chiqqan', dep.departAt || (dep.status === 'waiting' ? 'hali chiqmagan' : ''));
    html += row('Kechikish', depLateTxt(dep.lateMin).replace('+', ''));
    html += '</div>';
    if (dep.autoExcuse) html += `<div class="dep-auto">${vmEsc(dep.autoExcuse)} — avtomatik uzrli</div>`;
    if (dep.note) {
        const by = [dep.noteBy, dep.noteAt ? String(dep.noteAt).replace('T', ' ').slice(0, 16) : ''].filter(Boolean).join(' · ');
        html += `<div class="dep-note"><div>${vmEsc(dep.note)}</div>${by ? `<small>${vmEsc(by)}${dep.noteAll ? ' · barcha mashinalar' : ''}</small>` : ''}</div>`;
    }
    return html;
}

function depMonthHtml(p, curDate) {
    const s = p.summary || {};
    const bad = (p.days || []).filter(d => d.counted || (d.excused && ['late', 'waiting', 'no_trip'].includes(d.status)));
    const chips = bad.map(d => {
        const day = String(d.date).slice(8);
        const cls = d.excused ? 'is-exc' : (d.status === 'no_trip' ? 'is-none' : 'is-late');
        const t = d.status === 'late' ? `${d.departAt}` : (d.status === 'no_trip' ? 'chiqmadi' : 'kutilmoqda');
        return `<span class="dep-chip ${cls}${d.date === curDate ? ' is-cur' : ''}" title="${vmEsc(d.label + (d.note ? ' · ' + d.note : ''))}"><b>${day}</b> ${vmEsc(t)}</span>`;
    }).join('');
    return `<div class="dep-m-sum"><b>Bu oy:</b> ${s.late || 0} marta kech${s.lateMin ? ` · jami ${depLateTxt(s.lateMin).replace('+', '')}` : ''}${s.noTrip ? ` · ${s.noTrip} kun umuman chiqmagan` : ''}${s.excused ? ` · ${s.excused} uzrli` : ''} · ${s.ok || 0} kun o'z vaqtida</div>${chips ? `<div class="dep-chips">${chips}</div>` : ''}`;
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
            if (d.officeGeofence && typeof d.officeGeofence === 'object') {
                STATE.officeGeofence = d.officeGeofence;
            }
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
                    const dep = e.target.closest('[data-dep]');
                    if (dep) {
                        e.stopPropagation();
                        this.openDepModal(dep.getAttribute('data-dep'));
                        return;
                    }
                    const tr = e.target.closest('tr[data-car]');
                    if (tr && typeof selectDriver === 'function') selectDriver(tr.getAttribute('data-car'));
                });
            }
            setInterval(() => {
                const dep = this.depCache[STATE.currentDate];
                if (dep && dep.data && STATE.currentDate === dep.data.today && !document.hidden) {
                    this.ensureDepartures(STATE.currentDate, true);
                }
            }, 60000);
        }
        if (STATE.currentDate) await this.loadReportIfNeeded(STATE.currentDate);
    },

    depCache: {},
    _depLoading: {},

    async ensureDepartures(dateVal, force) {
        if (!dateVal || this._depLoading[dateVal]) return;
        const hit = this.depCache[dateVal];
        const isToday = hit && hit.data && hit.data.today === dateVal;
        const ttl = isToday ? 60000 : 300000;
        if (hit && !force && Date.now() - hit.at < ttl) return;
        this._depLoading[dateVal] = true;
        try {
            const d = await vmApi('/api/departures?date=' + encodeURIComponent(dateVal), { noRedirect: true });
            this.depCache[dateVal] = { at: Date.now(), data: d };
        } catch (e) {
            this.depCache[dateVal] = { at: Date.now(), data: null };
        } finally {
            this._depLoading[dateVal] = false;
        }
        if (STATE.currentDate === dateVal) this.renderFleetBoard();
    },

    depOf(dateVal, car) {
        const hit = this.depCache[dateVal];
        const cars = hit && hit.data && hit.data.cars;
        if (!cars) return null;
        const key = plateCompact(car);
        if (cars[key]) return cars[key];
        const num = depPlateNum(car);
        return Object.values(cars).find(c => c.num === num) || null;
    },

    depBadge(dep) {
        if (!dep) return '';
        const st = dep.status;
        const late = depLateTxt(dep.lateMin);
        const noteIco = dep.note ? '<i class="dep-ico" aria-hidden="true"></i>' : '';
        let cls = '', txt = '';
        if (dep.excused && dep.counted === false && ['late', 'waiting', 'no_trip', 'not_arrived', 'no_office'].includes(st)) {
            cls = 'dep-excused';
            txt = 'Uzrli · ' + (st === 'late' ? 'yuk ' + (dep.departAt || '') : dep.label);
        } else if (st === 'late') {
            cls = 'dep-late'; txt = `Yuk kech ${dep.departAt || ''} ${late}`;
        } else if (st === 'waiting') {
            cls = 'dep-wait'; txt = `Yuk chiqmagan · ${late}`;
        } else if (st === 'no_trip') {
            cls = 'dep-late'; txt = 'Yuk chiqmadi · kun bo\'yi hududda';
        } else if (st === 'not_arrived') {
            cls = 'dep-warn'; txt = 'Ofisga kelmagan';
        } else if (st === 'no_office') {
            cls = 'dep-warn'; txt = 'Ofisga kirmagan';
        } else if (st === 'ok') {
            cls = 'dep-ok'; txt = `Yuk ${dep.departAt || ''}`;
        } else if (st === 'pending') {
            cls = 'dep-pend'; txt = `Yuk ${dep.deadline} gacha`;
        } else {
            return '';
        }
        const tip = `${dep.label}${dep.departAt ? ' · chiqdi ' + dep.departAt : ''} · muddat ${dep.deadline}${dep.note ? ' · Izoh: ' + dep.note : ''}`;
        return `<button type="button" class="dep-badge ${cls}" data-dep="${vmEsc(dep.plate)}" title="${vmEsc(tip)}">${vmEsc(txt.trim())}${noteIco}</button>`;
    },

    depSummaryTxt(dateVal) {
        const hit = this.depCache[dateVal];
        const cars = hit && hit.data && hit.data.cars ? Object.values(hit.data.cars) : [];
        if (!cars.length) return '';
        const late = cars.filter(c => c.counted).length;
        const wait = cars.filter(c => c.counted && c.status === 'waiting').length;
        if (!late) return ' · yuk chiqishi: hammasi o\'z vaqtida';
        return ` · yuk kech: ${late}${wait ? ' (hali chiqmagan: ' + wait + ')' : ''}`;
    },

    depModalEl() {
        let m = document.getElementById('dep-modal');
        if (m) return m;
        m = document.createElement('div');
        m.id = 'dep-modal';
        m.className = 'dep-modal';
        m.hidden = true;
        m.innerHTML = `<div class="dep-modal-card" role="dialog" aria-modal="true" aria-labelledby="dep-m-title">
            <div class="dep-m-head">
              <div><div class="dep-m-kicker">Yuk chiqishi nazorati</div><h3 id="dep-m-title"></h3><div class="dep-m-sub" id="dep-m-sub"></div></div>
              <button type="button" class="dep-m-x" data-dep-close aria-label="Yopish">&times;</button>
            </div>
            <div class="dep-m-body" id="dep-m-body"></div>
            <div class="dep-m-month" id="dep-m-month"></div>
            <form class="dep-m-form" id="dep-m-form">
              <label class="dep-m-lbl" for="dep-m-note">Admin izohi</label>
              <textarea id="dep-m-note" rows="3" maxlength="300" placeholder="Masalan: sklad navbati, mashina ta'mirda, buyurtma kech tayyorlandi..."></textarea>
              <label class="dep-m-chk"><input type="checkbox" id="dep-m-exc"> Uzrli — oylik hisobga kechikish sifatida kirmaydi</label>
              <label class="dep-m-chk"><input type="checkbox" id="dep-m-all"> Shu kun barcha mashinalar uchun (bayram, umumiy sabab)</label>
              <div class="dep-m-actions">
                <button type="button" class="btn" data-dep-close>Bekor</button>
                <button type="submit" class="btn btn-primary" id="dep-m-save">Saqlash</button>
              </div>
            </form>
            <details class="dep-m-rule" id="dep-m-rule">
              <summary>Qoida sozlamalari</summary>
              <div class="dep-m-rule-body">
                <label class="dep-m-chk"><input type="checkbox" id="dep-r-on"> Nazorat yoqilgan</label>
                <label class="dep-m-lbl" for="dep-r-dl">Chiqish muddati</label>
                <input type="time" id="dep-r-dl" class="dep-m-inp">
                <label class="dep-m-lbl" for="dep-r-since">Nazorat boshlanish sanasi</label>
                <input type="date" id="dep-r-since" class="dep-m-inp">
                <label class="dep-m-lbl" for="dep-r-pl">Mashina raqamlari (vergul bilan)</label>
                <input type="text" id="dep-r-pl" class="dep-m-inp" placeholder="255, 043, 302">
                <div class="dep-m-actions"><button type="button" class="btn" id="dep-r-save">Qoidani saqlash</button></div>
              </div>
            </details>
          </div>`;
        document.body.appendChild(m);
        m.addEventListener('click', e => {
            if (e.target === m || e.target.closest('[data-dep-close]')) m.hidden = true;
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && !m.hidden) m.hidden = true; });
        m.querySelector('#dep-m-form').addEventListener('submit', e => { e.preventDefault(); this.saveDepNote(); });
        m.querySelector('#dep-r-save').addEventListener('click', () => this.saveDepRule());
        return m;
    },

    async saveDepRule() {
        const m = this.depModalEl();
        const btn = m.querySelector('#dep-r-save');
        btn.disabled = true;
        try {
            const d = await vmApi('/api/departures/rule', {
                method: 'POST',
                body: JSON.stringify({
                    enabled: m.querySelector('#dep-r-on').checked,
                    deadline: m.querySelector('#dep-r-dl').value,
                    since: m.querySelector('#dep-r-since').value,
                    plates: m.querySelector('#dep-r-pl').value
                })
            });
            this.depCache = {};
            m.hidden = true;
            this.renderFleetBoard();
            if (typeof showToast === 'function') showToast(`Qoida saqlandi: ${d.rule.deadline} · ${d.rule.plates.length} ta mashina`, 'success');
        } catch (e) {
            if (typeof showToast === 'function') showToast('Saqlanmadi: ' + (e.message || e), 'error');
        } finally {
            btn.disabled = false;
        }
    },

    async openDepModal(plate) {
        const dateVal = STATE.currentDate;
        const dep = this.depOf(dateVal, plate);
        if (!dep) return;
        const hit = this.depCache[dateVal].data || {};
        const m = this.depModalEl();
        const drv = typeof resolveDriver === 'function' ? resolveDriver(dep.plate, null) : null;
        this._depEditing = { date: dateVal, plate: dep.plate };
        m.querySelector('#dep-m-title').textContent = dep.plate;
        m.querySelector('#dep-m-sub').textContent = `${drv && drv.fullName && drv.fullName !== dep.plate ? drv.fullName + ' · ' : ''}${depDateUz(dateVal)}`;
        m.querySelector('#dep-m-body').innerHTML = depDetailHtml(dep);
        const form = m.querySelector('#dep-m-form');
        form.hidden = !hit.canEdit;
        m.querySelector('#dep-m-note').value = dep.note || '';
        m.querySelector('#dep-m-exc').checked = !!(dep.excused && !dep.autoExcuse);
        m.querySelector('#dep-m-all').checked = !!dep.noteAll;
        const rule = hit.rule || {};
        m.querySelector('#dep-m-rule').hidden = !hit.canEdit;
        m.querySelector('#dep-r-on').checked = rule.enabled !== false;
        m.querySelector('#dep-r-dl').value = rule.deadline || '09:30';
        m.querySelector('#dep-r-since').value = rule.since || '';
        m.querySelector('#dep-r-pl').value = (rule.plates || []).join(', ');
        const monthEl = m.querySelector('#dep-m-month');
        monthEl.innerHTML = '<div class="dep-m-muted">Oylik tarix yuklanmoqda…</div>';
        m.hidden = false;
        try {
            const d = await vmApi(`/api/departures/month?month=${dateVal.slice(0, 7)}&car=${encodeURIComponent(dep.plate)}`);
            const p = Object.values(d.plates || {})[0];
            monthEl.innerHTML = p ? depMonthHtml(p, dateVal) : '';
        } catch (e) {
            monthEl.innerHTML = '';
        }
    },

    async saveDepNote() {
        const ed = this._depEditing;
        if (!ed) return;
        const m = this.depModalEl();
        const btn = m.querySelector('#dep-m-save');
        const all = m.querySelector('#dep-m-all').checked;
        btn.disabled = true;
        try {
            const d = await vmApi('/api/departures/note', {
                method: 'POST',
                body: JSON.stringify({
                    date: ed.date,
                    car: all ? '*' : ed.plate,
                    note: m.querySelector('#dep-m-note').value,
                    excused: m.querySelector('#dep-m-exc').checked
                })
            });
            if (d && d.day) this.depCache[ed.date] = { at: Date.now(), data: Object.assign({}, this.depCache[ed.date] && this.depCache[ed.date].data, d.day) };
            m.hidden = true;
            this.renderFleetBoard();
            if (typeof showToast === 'function') showToast('Izoh saqlandi', 'success');
        } catch (e) {
            if (typeof showToast === 'function') showToast('Saqlanmadi: ' + (e.message || e), 'error');
        } finally {
            btn.disabled = false;
        }
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
        // Admin biriktirish (office:pharmacies) — yagona manba.
        // Ro'yxat bo'sh mashina uchun fleet-data ga qaytmasin (aks holda 0/12 kabi soxta sonlar chiqadi).
        const list = Array.isArray(STATE.pharmacies) ? STATE.pharmacies : null;
        const compact = plateCompact(car);
        const keyOf = (s) => (typeof pharmacyKey === 'function'
            ? pharmacyKey(s)
            : (typeof uzSearchFold === 'function'
                ? uzSearchFold(s)
                : String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9а-яўқғҳ]/gi, '')));
        const dedupe = (names) => {
            const seen = new Set();
            const out = [];
            (names || []).forEach(n => {
                const k = keyOf(n);
                if (!k || seen.has(k)) return;
                seen.add(k);
                out.push(n);
            });
            return out;
        };
        if (list && list.length) {
            const fromOffice = list
                .filter(p => p && p.name && (p.car === car || plateCompact(p.car) === compact))
                .map(p => p.name);
            return dedupe(fromOffice);
        }
        // Faqat office hali bo'sh bo'lsa — eski fleet ro'yxati (birinchi marta)
        const drv = this.driversList().find(d => d.car === car || plateCompact(d.car) === compact);
        if (!drv || !drv.pharmacies) return [];
        return dedupe(String(drv.pharmacies).split(',').map(s => s.trim()).filter(Boolean));
    },

    async savePharmacies(list) {
        const d = await vmApi('/api/office/pharmacies', {
            method: 'POST',
            body: JSON.stringify({ pharmacies: list || STATE.pharmacies || [] })
        });
        STATE.pharmacies = Array.isArray(d.pharmacies) ? d.pharmacies : (list || STATE.pharmacies || []);
        if (typeof buildPharmIndex === 'function') buildPharmIndex();
        if (typeof renderCarPharmacyRoster === 'function') renderCarPharmacyRoster(STATE.currentCar);
        if (typeof renderKPI === 'function' || typeof refreshUI === 'function') {
            try { if (typeof refreshUI === 'function') refreshUI({ deferMap: true }); } catch (e) {}
        }
        return STATE.pharmacies;
    },

    pharmKey(name) {
        if (typeof pharmacyKey === 'function') return pharmacyKey(name);
        if (typeof uzSearchFold === 'function') return uzSearchFold(name);
        return String(name || '').toLowerCase();
    },

    findPharmByKey(name) {
        const k = this.pharmKey(name);
        if (!k) return null;
        return (STATE.pharmacies || []).find(p => this.pharmKey(p.name) === k) || null;
    },

    /** «Yonma-yon» bog'lanish ikki tomonlama: row.nearby = ids, boshqalarida row.id qo'shiladi/olinadi. */
    applyNearby(list, row, ids) {
        const want = new Set((ids || []).filter(i => i && i !== row.id));
        const car = plateCompact(row.car);
        row.nearby = Array.from(want).slice(0, 12);
        list.forEach(p => {
            if (!p || p === row || !p.id) return;
            const cur = Array.isArray(p.nearby) ? p.nearby.filter(i => i !== row.id) : [];
            if (want.has(p.id) && plateCompact(p.car) === car) cur.push(row.id);
            p.nearby = cur.slice(0, 12);
        });
    },

    async assignToCar(name, car, lat, lng, radiusM, aliases, nearby) {
        name = String(name || '').trim();
        car = String(car || '').trim();
        if (!name || !car) throw new Error('Nom va mashina kerak');
        const k = this.pharmKey(name);
        let list = Array.isArray(STATE.pharmacies) ? STATE.pharmacies.slice() : [];
        const matches = k ? list.filter(p => this.pharmKey(p.name) === k) : [];
        let keep = matches.find(p => p.lat != null && p.lng != null) || matches[0] || null;
        if (matches.length > 1 && keep) {
            list = list.filter(p => this.pharmKey(p.name) !== k || p.id === keep.id);
        }
        if (keep) {
            keep.car = car;
            keep.name = name;
            if (lat != null && lng != null && lat !== '' && lng !== '') {
                keep.lat = Number(lat);
                keep.lng = Number(lng);
            }
            if (radiusM != null) keep.radiusM = Math.max(40, Math.min(500, Number(radiusM) || 120));
            if (Array.isArray(aliases)) keep.aliases = aliases.slice(0, 12);
        } else {
            keep = {
                id: 'ph_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9),
                car,
                name,
                lat: lat == null || lat === '' ? null : Number(lat),
                lng: lng == null || lng === '' ? null : Number(lng),
                radiusM: Math.max(40, Math.min(500, Number(radiusM) || 120)),
                aliases: Array.isArray(aliases) ? aliases.slice(0, 12) : [],
                nearby: []
            };
            list.push(keep);
        }
        if (Array.isArray(nearby)) this.applyNearby(list, keep, nearby);
        return this.savePharmacies(list);
    },

    async removePharm(id) {
        const list = (STATE.pharmacies || []).filter(p => p.id !== id);
        return this.savePharmacies(list);
    },

    async renamePharm(id, newName, aliases, nearby) {
        newName = String(newName || '').trim();
        if (!newName) throw new Error('Nom boʻsh');
        const list = Array.isArray(STATE.pharmacies) ? STATE.pharmacies.slice() : [];
        const rec = list.find(p => p.id === id);
        if (!rec) throw new Error('Topilmadi');
        const k = this.pharmKey(newName);
        const cleaned = list.filter(p => p.id === id || !k || this.pharmKey(p.name) !== k);
        const row = cleaned.find(p => p.id === id);
        row.name = newName;
        if (Array.isArray(aliases)) row.aliases = aliases.slice(0, 12);
        if (Array.isArray(nearby)) this.applyNearby(cleaned, row, nearby);
        return this.savePharmacies(cleaned);
    },

    matchGeo(currentCar, lat, lng, place) {
        const y = Number(lat), x = Number(lng);
        if (!y || !x) return null;
        const want = plateCompact(currentCar);
        const candidates = [];
        (STATE.pharmacies || []).forEach(ph => {
            if (ph.lat == null || ph.lng == null) return;
            const d = vmHaversineM(y, x, Number(ph.lat), Number(ph.lng));
            const r = Number(ph.radiusM) || 120;
            if (d > r) return;
            candidates.push({ d, ph });
        });
        if (!candidates.length) return null;

        const pk = (typeof pharmacyKey === 'function' ? pharmacyKey(place) : null)
            || (typeof normPh === 'function' ? normPh(place) : '');
        const isCoord = (typeof isCoordPlace === 'function')
            ? isCoordPlace(place)
            : /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/.test(String(place || '').trim());
        const isJunk = (typeof isJunkPlace === 'function') ? isJunkPlace(place) : !String(place || '').trim();
        const placeOk = !!(pk && pk.length >= 4) && !isCoord && !isJunk;

        const pack = (ph, type) => {
            const sameName = (a, b) => (typeof uzNameEq === 'function' ? uzNameEq(a, b) : a === b);
            const owners = (STATE.pharmacies || [])
                .filter(p => sameName(p.name, ph.name) || (p.lat === ph.lat && p.lng === ph.lng))
                .map(p => {
                    const drv = this.driversList().find(d => d.car === p.car || plateCompact(d.car) === plateCompact(p.car));
                    return drv ? drv.shortName : p.car;
                });
            return {
                type,
                phName: ph.name,
                owners: [...new Set(owners)],
                by: 'geo'
            };
        };

        // 1) Joy nomi dorixona bilan kelishadi
        if (placeOk && typeof pharmNameScore === 'function') {
            let bestSc = 0, bestPh = null, bestD = 1e12;
            candidates.forEach(({ d, ph }) => {
                const sc = Math.max(0, ...[ph.name].concat(ph.aliases || []).map(n => {
                    const en = (typeof pharmacyKey === 'function' ? pharmacyKey(n) : null) || normPh(n);
                    return pharmNameScore(pk, en);
                }));
                if (sc >= 55 && (sc > bestSc || (sc === bestSc && d < bestD))) {
                    bestSc = sc;
                    bestPh = ph;
                    bestD = d;
                }
            });
            if (bestPh) {
                const isOwn = bestPh.car === currentCar || plateCompact(bestPh.car) === want;
                return pack(bestPh, isOwn ? 'own' : 'other');
            }
        }

        // 2) Eng yaqin o'z dorixonasi
        const ownCands = candidates.filter(({ ph }) =>
            ph.car === currentCar || plateCompact(ph.car) === want);
        if (ownCands.length) {
            ownCands.sort((a, b) => a.d - b.d);
            return pack(ownCands[0].ph, 'own');
        }

        // 3) Boshqa yo'nalish geo — faqat joy nomi yo'q/koordinata
        if (!placeOk) {
            candidates.sort((a, b) => a.d - b.d);
            return pack(candidates[0].ph, 'other');
        }
        return null;
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
        const assigned = this.ownNames(drv.car).length;
        if (!rec) {
            return { drv, rec: null, score: null, km: 0, own: 0, total: assigned, other: 0, problem: 0, speed: 0, work: '—' };
        }
        const a = rec.analysis || {};
        const sc = a.score || {};
        return {
            drv,
            rec,
            score: sc.final,
            km: (rec.stats && rec.stats.probeg) || 0,
            own: a.ownVisited || 0,
            // Hisobotdagi totalOwn eski fleet-data dan bo'lishi mumkin — admin ro'yxati ustun
            total: assigned,
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
            if (typeof fleetIsRetired === 'function' && fleetIsRetired(car)) return;
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
                ? `${loaded} mashina · o'rtacha ${avgN.toFixed(1)} ball · ${probs} muammo${this.depSummaryTxt(dateVal)}`
                : 'Bu kunda ma\'lumot yo\'q';
        }
        this.ensureDepartures(dateVal);
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
            const model = typeof fleetModelOf === 'function' ? fleetModelOf(r.drv.car) : '';
            const minfo = model && window.FLEET_MODELS ? window.FLEET_MODELS[model] : null;
            const photo = typeof fleetPhotoHtml === 'function' ? fleetPhotoHtml(r.drv.car, 'fb-photo') : '';
            return `<tr class="rank-row${active}${empty ? ' is-empty' : ''}" data-car="${vmEsc(r.drv.car)}">
                <td class="font-mono text-muted">${i + 1}</td>
                <td><strong>${vmEsc(r.drv.shortName)}</strong>${this.depBadge(this.depOf(dateVal, r.drv.car))}</td>
                <td class="fb-car-cell"><div class="fb-car">
                    <span class="fb-thumb${minfo ? ' cls-' + minfo.cls : ''}">${photo}</span>
                    <span class="fb-car-txt"><b class="font-mono">${vmEsc(r.drv.car)}</b><em>${vmEsc(minfo ? minfo.t : '—')}</em></span>
                </div></td>
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
