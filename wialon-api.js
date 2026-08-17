/**
 * VaksinaMed GPS - Wialon / Boomerang GPS (bms1.gpsavto.uz) API Integratsiyasi
 * Ushbu modul to'g'ridan-to'g'ri GPS serveriga ulanadi va kunlik ma'lumotlarni tortib oladi.
 */

class WialonGPSClient {
    constructor() {
        this.defaultHost = 'http://bms1.gpsavto.uz';
        this.sessionId = null;
        this.units = []; // [{ id, name, carNumber }]
        this.isLoggedIn = false;
    }

    /**
     * Sozlamalarni LocalStorage'dan o'qish
     */
    getConfig() {
        try {
            const cfg = localStorage.getItem('vaksinamed_gps_config');
            if (cfg) return JSON.parse(cfg);
        } catch (e) {}
        return {
            host: this.defaultHost,
            user: 'vaksina',
            password: '',
            token: '',
            authType: 'login' // 'login' yoki 'token'
        };
    }

    /**
     * Sozlamalarni saqlash
     */
    saveConfig(config) {
        try {
            localStorage.setItem('vaksinamed_gps_config', JSON.stringify(config));
        } catch (e) {}
    }

    /**
     * Wialon serveriga so'rov yuborish (JSONP / Fetch / Proxy orqali)
     */
    async sendRequest(svc, params, customHost = null) {
        const config = this.getConfig();
        let host = (customHost || config.host || this.defaultHost).replace(/\/+$/, '');
        
        // Agar http:// yoki https:// bo'lmasa qo'shamiz
        if (!host.startsWith('http://') && !host.startsWith('https://')) {
            host = 'http://' + host;
        }

        const sidParam = this.sessionId ? `&sid=${this.sessionId}` : '';
        const paramsStr = encodeURIComponent(JSON.stringify(params));
        const directUrl = `${host}/wialon/ajax.html?svc=${svc}&params=${paramsStr}${sidParam}`;
        const proxyUrl = `/gps-proxy?url=${encodeURIComponent(directUrl)}`;

        // 1. Birinchi navbatda mahalliy proxy orqali fetch qilib ko'ramiz (CORS chetlab o'tish)
        try {
            const resp = await fetch(proxyUrl, { method: 'GET', mode: 'cors' });
            if (resp.ok) {
                const data = await resp.json();
                if (data && data.error) {
                    throw new Error(this.getErrorMessage(data.error));
                }
                return data;
            } else {
                throw new Error("Proxy error");
            }
        } catch (fetchErr) {
            // Agar proxy ishlamasa, JSONP orqali sinab ko'ramiz
            return await this.sendJsonpRequest(host, svc, params);
        }
    }

    /**
     * JSONP usuli bilan so'rov yuborish (brauzer CORS cheklovlarini chetlab o'tish uchun)
     */
    sendJsonpRequest(host, svc, params) {
        return new Promise((resolve, reject) => {
            const callbackName = 'wialon_cb_' + Math.random().toString(36).substring(2, 9);
            const sidParam = this.sessionId ? `&sid=${this.sessionId}` : '';
            const paramsStr = encodeURIComponent(JSON.stringify(params));
            const scriptUrl = `${host}/wialon/ajax.html?svc=${svc}&params=${paramsStr}${sidParam}&callback=${callbackName}`;

            const script = document.createElement('script');
            script.src = scriptUrl;

            const timer = setTimeout(() => {
                cleanup();
                reject(new Error("GPS serveridan javob kelmadi (Vaqt tugadi). URL va ulanishni tekshiring."));
            }, 25000);

            function cleanup() {
                clearTimeout(timer);
                if (script.parentNode) script.parentNode.removeChild(script);
                delete window[callbackName];
            }

            window[callbackName] = (data) => {
                cleanup();
                if (data && data.error) {
                    reject(new Error(this.getErrorMessage(data.error)));
                } else {
                    resolve(data);
                }
            };

            script.onerror = () => {
                cleanup();
                reject(new Error("GPS serveriga ulanib bo'lmadi (" + host + "). Server ishlayotganligini tekshiring."));
            };

            document.body.appendChild(script);
        });
    }

    /**
     * Wialon tizimiga kirish (Login)
     */
    async login(options = {}) {
        const config = Object.assign(this.getConfig(), options);
        let result;

        if (config.token && config.token.trim() !== "") {
            // Token orqali kirish
            result = await this.sendRequest('token/login', { token: config.token.trim() }, config.host);
        } else if (config.user && config.password) {
            // Login va parol orqali kirish
            result = await this.sendRequest('core/login', {
                user: config.user.trim(),
                password: config.password.trim()
            }, config.host);
        } else {
            throw new Error("Iltimos, Login va Parol (yoki API Token) kiriting!");
        }

        if (result && result.eid) {
            this.sessionId = result.eid;
            this.isLoggedIn = true;
            this.saveConfig(config);
            return result;
        } else {
            throw new Error("Wialon tizimiga kirib bo'lmadi. Ma'lumotlarni qayta tekshiring.");
        }
    }

    /**
     * Tizimdan chiqish (Logout)
     */
    async logout() {
        if (this.sessionId) {
            try {
                await this.sendRequest('core/logout', {});
            } catch (e) {}
            this.sessionId = null;
            this.isLoggedIn = false;
        }
    }

    /**
     * Barcha avtomobillarni (Units) ro'yxatini olish
     */
    async getUnits() {
        if (!this.sessionId) {
            await this.login();
        }

        const params = {
            spec: {
                itemsType: "avl_unit",
                propName: "sys_name",
                propValueMask: "*",
                sortType: "sys_name"
            },
            force: 1,
            flags: 1 | 1024 | 4096, // Asosiy xossalar, pozitsiya, sensorlar
            from: 0,
            to: 0
        };

        const resp = await this.sendRequest('core/search_items', params);
        if (resp && resp.items) {
            this.units = resp.items.map(item => {
                return {
                    id: item.id,
                    name: item.nm,
                    carNumber: this.normalizeCarNumber(item.nm),
                    pos: item.pos ? { lat: item.pos.y, lng: item.pos.x, speed: item.pos.s, time: item.pos.t } : null
                };
            });
            return this.units;
        }
        return [];
    }

    /** Toshkent kuni (UTC+5) uchun unix oralig'i */
    dayBoundsTashkent(dateStr) {
        const parts = String(dateStr).split('-').map(n => parseInt(n, 10));
        const y = parts[0], m = parts[1], d = parts[2];
        const timeFrom = Math.floor(Date.UTC(y, m - 1, d, 0, 0, 0) / 1000) - 5 * 3600;
        return { timeFrom, timeTo: timeFrom + 86400 - 1 };
    }

    cellText(c) {
        if (c == null || c === '') return '';
        if (typeof c === 'object') {
            if (c.t != null && String(c.t).trim() !== '') return String(c.t);
            if (c.v != null) return String(c.v);
            return '';
        }
        return String(c);
    }

    cellNum(c) {
        if (c == null || c === '') return NaN;
        if (typeof c === 'number' && Number.isFinite(c)) return c;
        if (typeof c === 'object') {
            if (typeof c.v === 'number' && Number.isFinite(c.v)) return c.v;
            return this.parseLooseNum(c.t != null ? c.t : c.v);
        }
        return this.parseLooseNum(c);
    }

    preferKm(oldVal, newVal) {
        const a = this.roundKm(oldVal);
        const b = this.roundKm(newVal);
        if (!b) return a;
        if (!a) return b;
        const aFrac = Math.abs(a - Math.round(a));
        const bFrac = Math.abs(b - Math.round(b));
        if (bFrac >= 0.01 && aFrac < 0.01) return b;
        if (aFrac >= 0.01 && bFrac < 0.01) return a;
        return b;
    }

    cellCoord(c) {
        if (c && typeof c === 'object' && typeof c.y === 'number') {
            return { lat: c.y, lng: c.x };
        }
        return { lat: 0, lng: 0 };
    }

    emptyChronology() {
        return {
            stats: { probeg: 0, poezdok: 0, stoyanok: 0, maxSpeed: 0, avgSpeed: 0, motoChas: '—', totalStop: '—', gas: 0, benzin: 0 },
            stops: [],
            trips: [],
            points: []
        };
    }

    /**
     * Tanlangan sana uchun avtomobilning harakat va to'xtashlarini (Xronologiya) olish
     */
    async getUnitChronology(unitId, dateStr) {
        if (!this.sessionId) {
            await this.login();
        }

        const { timeFrom, timeTo } = this.dayBoundsTashkent(dateStr);

        try {
            const chrono = await this.execChronologyReport(unitId, timeFrom, timeTo);
            if (chrono && (chrono.stops.length || chrono.stats.probeg)) {
                await this.applyTripMetrics(unitId, timeFrom, timeTo, chrono);
                return chrono;
            }
        } catch (e) {
            console.warn('Hisobot xatosi, xabarlar orqali uriniladi:', e);
        }

        const fromMsgs = await this.buildChronologyFromMessages(unitId, timeFrom, timeTo);
        await this.applyTripMetrics(unitId, timeFrom, timeTo, fromMsgs);
        return fromMsgs;
    }

    async fetchReportRows(tableIndex, rowCount) {
        if (!rowCount || rowCount < 1) return [];
        const all = [];
        const chunk = 200;
        for (let from = 0; from < rowCount; from += chunk) {
            const to = Math.min(rowCount - 1, from + chunk - 1);
            const rows = await this.sendRequest('report/get_result_rows', {
                tableIndex,
                indexFrom: from,
                indexTo: to
            });
            if (Array.isArray(rows)) all.push(...rows);
        }
        return all;
    }

    parseLooseNum(v) {
        const m = String(v || '').replace(/\s/g, '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
        return m ? parseFloat(m[0]) : NaN;
    }

    roundKm(v) {
        const x = Number(v);
        if (!Number.isFinite(x) || x <= 0) return 0;
        return Math.round(x * 100) / 100;
    }

    roundSpd(v) {
        const x = Number(v);
        if (!Number.isFinite(x) || x <= 0) return 0;
        return Math.round(x * 100) / 100;
    }

    roundFuel(v) {
        const x = Number(v);
        if (!Number.isFinite(x) || x <= 0) return 0;
        return Math.round(x * 10000) / 10000;
    }

    tripDistanceKm(tr) {
        const raw = Number(tr && (tr.distance != null ? tr.distance : tr.mileage));
        if (!Number.isFinite(raw) || raw <= 0) return 0;
        return raw;
    }

    haversineKm(a, b) {
        const R = 6371;
        const dLat = (b.y - a.y) * Math.PI / 180;
        const dLng = (b.x - a.x) * Math.PI / 180;
        const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.y * Math.PI / 180) * Math.cos(b.y * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
    }

    bestKm(base, cands) {
        const b = this.roundKm(base);
        const xs = (cands || []).map(v => this.roundKm(v)).filter(v => v > 0 && v < 2000);
        const frac = xs.filter(v => Math.abs(v - Math.round(v)) >= 0.01);
        const pool = frac.length ? frac : xs;
        if (!pool.length) return b;
        if (!b) return pool[0];
        pool.sort((a, c) => Math.abs(a - b) - Math.abs(c - b));
        return pool[0];
    }

    trackKmFromMsgs(msgs) {
        let km = 0, maxSpd = 0, prev = null;
        (msgs || []).forEach(m => {
            const pos = m && m.pos;
            if (!pos || typeof pos.y !== 'number' || typeof pos.x !== 'number') return;
            if ((pos.s || 0) > maxSpd) maxSpd = pos.s;
            if (prev) {
                const d = this.haversineKm(prev, pos);
                if (d >= 0.001 && d < 2) km += d;
            }
            prev = pos;
        });
        return { km: this.roundKm(km), maxSpeed: this.roundSpd(maxSpd) };
    }

    odoKmFromMsgs(msgs) {
        const pick = (m) => {
            const p = (m && m.p) || {};
            for (const k of Object.keys(p)) {
                if (/mileage|odometr|odometer|probeg|пробег/i.test(k)) {
                    const n = Number(p[k]);
                    if (n > 0) return n;
                }
            }
            return 0;
        };
        if (!msgs || msgs.length < 2) return 0;
        const first = pick(msgs[0]);
        const last = pick(msgs[msgs.length - 1]);
        if (!(first && last && last > first)) return 0;
        let d = last - first;
        if (d >= 500) d = d / 1000;
        const km = this.roundKm(d);
        return (km > 0 && km < 2000) ? km : 0;
    }

    async getTripMetrics(unitId, timeFrom, timeTo) {
        const cands = [];
        let maxSpeed = 0, avgSpeed = 0, trips = 0;
        try {
            const tripsResp = await this.sendRequest('unit/get_trips', { itemId: unitId, timeFrom, timeTo });
            const list = Array.isArray(tripsResp) ? tripsResp : (tripsResp && Array.isArray(tripsResp.trips) ? tripsResp.trips : []);
            if (list.length) {
                let rawSum = 0, avgAcc = 0, avgN = 0;
                list.forEach(tr => {
                    rawSum += this.tripDistanceKm(tr);
                    const ms = Number(tr.max_speed || tr.maxSpeed || 0);
                    if (ms > maxSpeed) maxSpeed = ms;
                    const as = Number(tr.avg_speed || tr.avgSpeed || 0);
                    if (as > 0) { avgAcc += as; avgN += 1; }
                });
                const km = this.roundKm(rawSum >= 500 ? rawSum / 1000 : rawSum);
                if (km) cands.push(km);
                trips = list.length;
                if (avgN) avgSpeed = this.roundSpd(avgAcc / avgN);
            }
        } catch (e) {
            console.warn('get_trips:', e);
        }
        try {
            const resp = await this.sendRequest('messages/load_interval', {
                itemId: unitId,
                timeFrom,
                timeTo,
                flags: 1,
                flagsMask: 65281,
                loadCount: 20000
            });
            const msgs = (resp && resp.messages) || [];
            if (msgs.length >= 2) {
                const odo = this.odoKmFromMsgs(msgs);
                const track = this.trackKmFromMsgs(msgs);
                if (odo) cands.push(odo);
                if (track.km) cands.push(track.km);
                if (track.maxSpeed) maxSpeed = Math.max(maxSpeed, track.maxSpeed);
            }
        } catch (e) {
            console.warn('messages mileage:', e);
        }
        const km = this.bestKm(0, cands);
        if (!km) return null;
        return { km, maxSpeed: this.roundSpd(maxSpeed), avgSpeed, trips };
    }

    async applyTripMetrics(unitId, timeFrom, timeTo, chronology) {
        if (!chronology || !chronology.stats) return chronology;
        try {
            const m = await this.getTripMetrics(unitId, timeFrom, timeTo);
            if (!m) return chronology;
            chronology.stats.probeg = this.bestKm(chronology.stats.probeg, [m.km]);
            if (m.maxSpeed) chronology.stats.maxSpeed = this.roundSpd(Math.max(chronology.stats.maxSpeed || 0, m.maxSpeed));
            if (m.avgSpeed) chronology.stats.avgSpeed = m.avgSpeed;
            if (m.trips && !chronology.stats.poezdok) chronology.stats.poezdok = m.trips;
        } catch (e) {
            console.warn('get_trips:', e);
        }
        return chronology;
    }

    parseReportStats(statsPairs, chronology) {
        (statsPairs || []).forEach(pair => {
            if (!Array.isArray(pair) || pair.length < 2) return;
            const k = String(this.cellText(pair[0]) || pair[0] || '').toLowerCase();
            const raw = pair[1];
            const v = this.cellText(raw);
            const num = this.cellNum(raw);
            const blob = k + ' ' + v;
            if ((k.includes('пробег') || k.includes('mileage') || k.includes('masofa')) && !k.includes('время') && num > 0) {
                let km = num;
                if (num > 500 && /m\b|метр/i.test(v)) km = num / 1000;
                chronology.stats.probeg = this.preferKm(chronology.stats.probeg, this.roundKm(km));
            }
            if ((k.includes('средн') || k.includes('avg') || k.includes('average') || k.includes("o'rtacha") || k.includes('ortacha')) && (k.includes('скорост') || k.includes('speed') || k.includes('tezlik'))) {
                if (num > 0) chronology.stats.avgSpeed = this.roundSpd(num);
            }
            if ((k.includes('макс') || k.includes('max')) && (k.includes('скорост') || k.includes('speed') || k.includes('tezlik') || /km\/h|км\/ч/i.test(v))) {
                if (num > 0) chronology.stats.maxSpeed = this.roundSpd(num);
            }
            if (k.includes('поезд') && !k.includes('пробег') && !k.includes('скорост')) {
                if (num > 0) chronology.stats.poezdok = Math.round(num);
            }
            if (k.includes('стоян') || k.includes('parking') || k.includes('stay')) {
                if (k.includes('длитель') || k.includes('duration') || k.includes('время')) {
                    if (v.match(/\d+:\d+/)) chronology.stats.totalStop = v.trim();
                } else if (num > 0) {
                    chronology.stats.stoyanok = Math.round(num);
                }
            }
            if (k.includes('движен') || k.includes('мото') || k.includes('moto')) {
                if (v.match(/\d+:\d+/)) chronology.stats.motoChas = v.trim();
            }
            if ((k.includes('расход') || k.includes('потрач') || k.includes('fuel') || k.includes('топлив') || k.includes('sarf')) && num > 0) {
                if (/м³|m3|куб|газ|метан|cнг|cng/i.test(blob)) chronology.stats.gas = this.roundFuel(num);
                else if (/л\b|литр|бензин|дизел|diesel|petrol/i.test(blob)) chronology.stats.benzin = this.roundFuel(num);
            }
        });
    }

    parseChronologyRow(r) {
        const c = r.c || [];
        const typeRaw = this.cellText(c[1] || c[0]).toLowerCase();
        const isStop = /park|стоян|stop|останов|stay/.test(typeRaw);
        const isTrip = /trip|поезд|движен/.test(typeRaw);
        const startCell = c[2];
        const locCell = c[3];
        const endCell = c[4];
        const loc2 = c[5];
        const start = this.cellCoord(startCell);
        const loc = this.cellCoord(locCell);
        const place = this.cellText(locCell) || this.cellText(loc2) || 'Noma\'lum manzil';
        return {
            isStop,
            isTrip,
            place,
            inTime: this.formatClock(this.cellText(startCell)),
            outTime: this.formatClock(this.cellText(endCell)),
            duration: this.cellText(c[6] || c[5] || ''),
            lat: loc.lat || start.lat || (r.pos ? r.pos.y : 0),
            lng: loc.lng || start.lng || (r.pos ? r.pos.x : 0)
        };
    }

    formatClock(s) {
        if (!s) return '';
        const m = String(s).match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
        return m ? m[1] : String(s).trim();
    }

    /**
     * Wialon Hisoboti orqali Xronologiyani olish
     */
    async execChronologyReport(unitId, timeFrom, timeTo) {
        const reportParams = {
            spec: {
                itemsType: "avl_resource",
                propName: "sys_name",
                propValueMask: "*",
                sortType: "sys_name"
            },
            force: 1,
            flags: 8193,
            from: 0,
            to: 0
        };

        const resResp = await this.sendRequest('core/search_items', reportParams);
        let resourceId = null;
        let templateId = null;

        if (resResp && resResp.items && resResp.items.length > 0) {
            for (const res of resResp.items) {
                if (res.rep) {
                    for (const tid in res.rep) {
                        const repName = (res.rep[tid].n || '').toLowerCase();
                        if (repName.includes('поездк') || repName.includes('хронолог') || repName.includes('xronologiya') || repName.includes('trip')) {
                            resourceId = res.id;
                            templateId = tid;
                            break;
                        }
                    }
                }
                if (resourceId) break;
            }
            if (!resourceId && resResp.items[0].rep) {
                resourceId = resResp.items[0].id;
                templateId = Object.keys(resResp.items[0].rep)[0];
            }
        }

        if (!resourceId || !templateId) {
            throw new Error("Wialon tizimida 'Поездки' hisobot shabloni topilmadi.");
        }

        const execResp = await this.sendRequest('report/exec_report', {
            reportResourceId: resourceId,
            reportTemplateId: parseInt(templateId, 10),
            reportObjectId: unitId,
            reportObjectSecId: 0,
            interval: { flags: 0, from: timeFrom, to: timeTo }
        });

        const chronology = this.emptyChronology();
        const rr = (execResp && execResp.reportResult) || {};
        this.parseReportStats(rr.stats, chronology);

        const tables = rr.tables || [];
        const loaded = [];
        for (let i = 0; i < tables.length; i++) {
            const tbl = tables[i];
            loaded.push({
                tbl,
                tblName: ((tbl.name || '') + ' ' + (tbl.label || '')).toLowerCase(),
                rows: await this.fetchReportRows(i, tbl.rows || 0)
            });
        }

        const applyChrono = (block) => {
            block.rows.forEach(r => {
                const parsed = this.parseChronologyRow(r);
                if (parsed.isStop) {
                    chronology.stops.push({
                        num: chronology.stops.length + 1,
                        type: 'stop',
                        place: parsed.place,
                        inTime: parsed.inTime,
                        outTime: parsed.outTime,
                        duration: parsed.duration,
                        lat: parsed.lat,
                        lng: parsed.lng
                    });
                } else if (parsed.isTrip) {
                    chronology.trips.push(parsed);
                }
            });
        };

        loaded.filter(x => x.tbl.name === 'unit_chronology' || x.tblName.includes('chron') || x.tblName.includes('хронолог'))
            .forEach(applyChrono);

        if (!chronology.stops.length) {
            loaded.filter(x => x.tbl.name === 'unit_stays')
                .forEach(block => {
                    block.rows.forEach(r => {
                        const c = r.c || [];
                        const startCell = c[2];
                        const endCell = c[3];
                        const loc = this.cellCoord(startCell);
                        chronology.stops.push({
                            num: chronology.stops.length + 1,
                            type: 'stop',
                            place: this.cellText(c[5]) || this.cellText(c[1]) || 'Noma\'lum manzil',
                            inTime: this.formatClock(this.cellText(startCell)),
                            outTime: this.formatClock(this.cellText(endCell)),
                            duration: this.cellText(c[4] || c[5] || ''),
                            lat: loc.lat,
                            lng: loc.lng
                        });
                    });
                });
        }

        loaded.forEach(block => {
            const isTripTbl = block.tbl.name === 'unit_trips' || (block.tblName.includes('поезд') && !block.tblName.includes('хронолог') && block.tbl.name !== 'unit_chronology');
            if (!isTripTbl) return;
            if (!chronology.stats.poezdok) {
                const nested = block.rows.reduce((s, r) => s + (r.d || 1), 0);
                chronology.stats.poezdok = nested || block.rows.length;
            }
            const headers = (block.tbl.header || []).map(h => this.cellText(h).toLowerCase());
            let kmIdx = headers.findIndex(h => (h.includes('пробег') || h.includes('mileage') || h.includes('masofa')) && !h.includes('скорост') && !h.includes('speed'));
            if (kmIdx < 0) kmIdx = headers.findIndex(h => /км|km/.test(h) && !h.includes('скорост') && !h.includes('speed') && !h.includes('ч') && !h.includes('h'));
            if (kmIdx < 0) return;
            let sum = 0;
            block.rows.forEach(r => {
                const cell = (r.c || [])[kmIdx];
                const n = this.cellNum(cell);
                const t = this.cellText(cell);
                if (!n || n <= 0) return;
                let km = n;
                if (n > 500 && /m\b|метр/i.test(t)) km = n / 1000;
                if (km > 0 && km < 800) sum += km;
            });
            if (sum > 0) chronology.stats.probeg = this.preferKm(chronology.stats.probeg, this.roundKm(sum));
            const tot = block.tbl.total;
            const totCells = Array.isArray(tot) ? tot : (tot && tot.c) || [];
            if (totCells[kmIdx] != null) {
                const tn = this.cellNum(totCells[kmIdx]);
                if (tn > 0 && tn < 800) chronology.stats.probeg = this.preferKm(chronology.stats.probeg, this.roundKm(tn > 500 ? tn / 1000 : tn));
            }
        });

        if (!chronology.stats.stoyanok) chronology.stats.stoyanok = chronology.stops.length;
        if (!chronology.stats.poezdok) chronology.stats.poezdok = chronology.trips.length;

        try { await this.sendRequest('report/cleanup_result', {}); } catch (e) {}

        return chronology;
    }

    async buildChronologyFromMessages(unitId, timeFrom, timeTo) {
        const chronology = this.emptyChronology();
        const resp = await this.sendRequest('messages/load_interval', {
            itemId: unitId,
            timeFrom,
            timeTo,
            flags: 1,
            flagsMask: 65281,
            loadCount: 20000
        });
        const msgs = (resp && resp.messages) || [];
        if (!msgs.length) return chronology;

        const STOP_SPEED = 3;
        const STOP_MIN = 300;
        let driveSec = 0;
        let mileage = 0;
        let maxSpd = 0;
        let lastMove = null;

        const haversine = (a, b) => {
            const R = 6371;
            const dLat = (b.y - a.y) * Math.PI / 180;
            const dLng = (b.x - a.x) * Math.PI / 180;
            const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.y * Math.PI / 180) * Math.cos(b.y * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
            return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
        };

        let i = 0;
        while (i < msgs.length) {
            const pos = msgs[i].pos;
            if (!pos) { i++; continue; }
            if ((pos.s || 0) > maxSpd) maxSpd = pos.s || 0;
            if ((pos.s || 0) > STOP_SPEED) {
                if (lastMove) {
                    mileage += haversine(lastMove, pos);
                    driveSec += Math.max(0, (msgs[i].t || 0) - (lastMove.t || 0));
                }
                lastMove = { y: pos.y, x: pos.x, t: msgs[i].t };
                i++;
                continue;
            }
            let j = i;
            while (j < msgs.length && msgs[j].pos && (msgs[j].pos.s || 0) <= STOP_SPEED) j++;
            const t0 = msgs[i].t || 0;
            const t1 = (msgs[Math.max(i, j - 1)].t || t0);
            if (t1 - t0 >= STOP_MIN) {
                chronology.stops.push({
                    num: chronology.stops.length + 1,
                    type: 'stop',
                    place: `${pos.y.toFixed(5)}, ${pos.x.toFixed(5)}`,
                    inTime: this.formatTime(t0),
                    outTime: this.formatTime(t1),
                    duration: this.formatDuration(t1 - t0),
                    lat: pos.y,
                    lng: pos.x
                });
            }
            lastMove = null;
            i = Math.max(j, i + 1);
        }

        chronology.stats.probeg = this.roundKm(mileage);
        chronology.stats.maxSpeed = this.roundSpd(maxSpd);
        chronology.stats.stoyanok = chronology.stops.length;
        chronology.stats.motoChas = this.formatDuration(driveSec);
        chronology.stats.poezdok = Math.max(0, chronology.stops.length - 1);
        return chronology;
    }

    /**
     * Avtomobil raqamini standart formatga keltirish (masalan: "01 269 KMA")
     */
    normalizeCarNumber(name) {
        if (!name) return "";
        const m = name.match(/(\d{2})[\s_-]?(\d{3})[\s_-]?([A-Za-z]{2,3})/);
        if (m) {
            return `${m[1]} ${m[2]} ${m[3].toUpperCase()}`;
        }
        return name.trim();
    }

    formatTime(timestampSec) {
        if (!timestampSec) return "00:00";
        const d = new Date(timestampSec * 1000);
        const h = String(d.getHours()).padStart(2, '0');
        const m = String(d.getMinutes()).padStart(2, '0');
        return `${h}:${m}`;
    }

    formatDuration(seconds) {
        if (!seconds || seconds <= 0) return "0:00:00";
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.round(seconds % 60);
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }

    getErrorMessage(code) {
        const errors = {
            1: "Wialon: Noma'lum xatolik",
            2: "Wialon: Noto'g'ri so'rov parametrlari",
            3: "Wialon: Server bilan aloqa uzildi",
            4: "Wialon: Noto'g'ri so'rov (Invalid input)",
            5: "Wialon: Sessiya yaroqsiz yoki muddati tugagan",
            6: "Wialon: Ushbu amalni bajarish uchun ruxsat yo'q",
            7: "Wialon: Noto'g'ri parametrlar yoki Parol o'rniga Token talab qilinadi",
            8: "Wialon: Login, parol yoki API token noto'g'ri"
        };
        return errors[code] || `Wialon xatolik kodi: #${code}`;
    }
}

// Global Wialon obyekti
window.wialonGPS = new WialonGPSClient();
