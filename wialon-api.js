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
        this._reportTpl = null;
    }

    /**
     * Sozlamalarni LocalStorage'dan o'qish (parol/token saqlanmaydi)
     */
    getConfig() {
        try {
            const cfg = localStorage.getItem('vaksinamed_gps_config');
            if (cfg) {
                const parsed = JSON.parse(cfg);
                return {
                    host: parsed.host || this.defaultHost,
                    user: parsed.user || '',
                    password: '',
                    token: '',
                    authType: parsed.authType || 'login'
                };
            }
        } catch (e) {}
        return {
            host: this.defaultHost,
            user: '',
            password: '',
            token: '',
            authType: 'login'
        };
    }

    /**
     * Sozlamalarni saqlash — faqat host/user (maxfiy maydonlar emas)
     */
    saveConfig(config) {
        try {
            const safe = {
                host: (config && config.host) || this.defaultHost,
                user: (config && config.user) || '',
                authType: (config && config.authType) || 'login'
            };
            localStorage.setItem('vaksinamed_gps_config', JSON.stringify(safe));
        } catch (e) {}
    }

    /** Eski localStorage dagi token/parolni tozalash */
    scrubStoredSecrets() {
        try {
            const raw = localStorage.getItem('vaksinamed_gps_config');
            if (!raw) return;
            const cfg = JSON.parse(raw);
            if (cfg && (cfg.password || cfg.token)) {
                this.saveConfig(cfg);
            }
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
            // HTTPS sahifadan HTTP GPS ga JSONP brauzerda bloklanadi — chalkash xato bermaslik
            const pageHttps = typeof location !== 'undefined' && location.protocol === 'https:';
            const hostHttp = /^http:\/\//i.test(host);
            if (pageHttps && hostHttp) {
                throw new Error(
                    "GPS proxy orqali ulanib bo'lmadi. Server sync ishlashi kerak (CFG saqlang va qayta yuklang). HTTPS→HTTP to'g'ridan ulanish brauzerda yopilgan."
                );
            }
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
        const token = String(config.token || '').replace(/\s+/g, '').trim();
        const user = String(config.user || '').trim();
        const password = String(config.password || '').trim();
        const host = config.host;
        let lastErr = null;

        const finish = (result) => {
            if (result && result.eid) {
                this.sessionId = result.eid;
                this.isLoggedIn = true;
                // Faqat host/user saqlanadi — parol/token localStorage ga yozilmaydi
                this.saveConfig({ host, user, authType: token ? 'token' : 'login' });
                return result;
            }
            throw new Error("Wialon tizimiga kirib bo'lmadi. Ma'lumotlarni qayta tekshiring.");
        };

        if (user && password) {
            try {
                const result = await this.sendRequest('core/login', { user, password }, host);
                return finish(result);
            } catch (e) {
                lastErr = e;
            }
        }
        if (token) {
            try {
                const result = await this.sendRequest('token/login', { token }, host);
                return finish(result);
            } catch (e) {
                lastErr = e;
            }
        }
        if (lastErr) throw lastErr;
        throw new Error("Iltimos, Login va Parol (yoki API Token) kiriting!");
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
        // Boomerang UI bilan bir xil: 2 xona (81.36)
        return Math.round((x + 1e-12) * 100) / 100;
    }

    kmFromWialon(num, label, valueText) {
        let n = Number(num);
        if (!Number.isFinite(n) || n <= 0) return 0;
        const low = (String(label || '') + ' ' + String(valueText || '')).toLowerCase();
        const isKm = /км|\bkm\b/.test(low);
        const isM = /метр|(^|[^kк])m\b|(^|[^kк])м\b/.test(low);
        if (isM && !isKm) n = n / 1000;
        else if (n >= 10000) n = n / 1000;
        return this.roundKm(n);
    }

    mileagePref(label) {
        const k = String(label || '').toLowerCase();
        if (k.includes('время') || k.includes('duration') || k.includes('скорост') || k.includes('speed')) return -1;
        if (!(k.includes('пробег') || k.includes('mileage') || k.includes('masofa'))) return -1;
        if (k.includes('поездк') || k.includes('in trips') || k.includes('в поезд')) return 3;
        if (k.includes('всег') || k.includes('total') || k.includes('счетчик') || k.includes('counter')) return 1;
        return 2;
    }

    roundSpd(v) {
        const x = Number(v);
        if (!Number.isFinite(x) || x <= 0) return 0;
        return Math.round(x * 100) / 100;
    }

    roundFuel(v) {
        const x = Number(v);
        if (!Number.isFinite(x) || x <= 0) return 0;
        return x;
    }

    tripDistanceMeters(tr) {
        return Number(tr && (tr.distance != null ? tr.distance : tr.mileage)) || 0;
    }

    kmFromTripList(list) {
        if (!list || !list.length) return 0;
        let rawSum = 0;
        list.forEach(tr => {
            const d = this.tripDistanceMeters(tr);
            if (d > 0) rawSum += d;
        });
        if (!rawSum) return 0;
        const asM = rawSum / 1000;
        const asKm = rawSum;
        // Kunlik: 1..800 km — metr yoki km ekanini aniqlash
        if (asM >= 1 && asM <= 800) return this.roundKm(asM);
        if (asKm >= 1 && asKm <= 800) return this.roundKm(asKm);
        return this.roundKm(asM >= 1 ? asM : asKm);
    }

    async resolveReportTemplates() {
        if (this._reportTpls) return this._reportTpls;
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
        let trip = null, chrono = null, anyTpl = null;
        let tripScore = -1;
        if (resResp && resResp.items && resResp.items.length > 0) {
            for (const res of resResp.items) {
                if (!res.rep) continue;
                for (const tid in res.rep) {
                    const repName = (res.rep[tid].n || '').toLowerCase();
                    const pair = { resourceId: res.id, templateId: parseInt(tid, 10) };
                    if (!anyTpl) anyTpl = pair;
                    if (repName.includes('хронолог') || repName.includes('xronologiya') || repName.includes('chronolog')) {
                        if (!chrono) chrono = pair;
                        continue;
                    }
                    let score = -1;
                    if (repName.includes('по поездкам') || repName.includes('отчёт по поезд') || repName.includes('отчет по поезд')) score = 10;
                    else if (repName.includes('поездк') || repName.includes('trip')) score = 5;
                    if (score > tripScore) {
                        tripScore = score;
                        trip = pair;
                    }
                }
            }
        }
        if (!anyTpl) {
            throw new Error("Wialon tizimida hisobot shabloni topilmadi.");
        }
        this._reportTpls = { trip, chrono, any: anyTpl };
        return this._reportTpls;
    }

    async resolveReportTemplate() {
        if (this._reportTpl) return this._reportTpl;
        const t = await this.resolveReportTemplates();
        this._reportTpl = t.chrono || t.trip || t.any;
        return this._reportTpl;
    }

    async officialDayMetrics(unitId, timeFrom, timeTo) {
        try {
            const tripsResp = await this.sendRequest('unit/get_trips', { itemId: unitId, timeFrom, timeTo });
            const list = Array.isArray(tripsResp) ? tripsResp : (tripsResp && Array.isArray(tripsResp.trips) ? tripsResp.trips : []);
            if (!list.length) return null;
            let maxSpeed = 0, avgAcc = 0, avgN = 0;
            list.forEach(tr => {
                const ms = Number(tr.max_speed || tr.maxSpeed || 0);
                if (ms > maxSpeed) maxSpeed = ms;
                const as = Number(tr.avg_speed || tr.avgSpeed || 0);
                if (as > 0) { avgAcc += as; avgN += 1; }
            });
            const km = this.kmFromTripList(list);
            if (!km) return null;
            return {
                km,
                maxSpeed: this.roundSpd(maxSpeed),
                avgSpeed: avgN ? this.roundSpd(avgAcc / avgN) : 0,
                trips: list.length
            };
        } catch (e) {
            return null;
        }
    }

    async reportDayMetrics(unitId, timeFrom, timeTo) {
        const tpls = await this.resolveReportTemplates();
        const tpl = tpls.trip || tpls.chrono || tpls.any;
        const execResp = await this.sendRequest('report/exec_report', {
            reportResourceId: tpl.resourceId,
            reportTemplateId: tpl.templateId,
            reportObjectId: unitId,
            reportObjectSecId: 0,
            interval: { flags: 0, from: timeFrom, to: timeTo }
        });
        const rr = (execResp && execResp.reportResult) || {};
        const bag = this.emptyChronology();
        this.parseReportStats(rr.stats, bag);
        // Boomerang: «Пробег в поездках» — trips jadvali jami
        await this.applyTripTableKmFromReport(rr, bag);
        try { await this.sendRequest('report/cleanup_result', {}); } catch (e) {}
        const s = bag.stats;
        if (!s.probeg && !s.poezdok && !s.maxSpeed) return null;
        return {
            km: this.roundKm(s.probeg),
            maxSpeed: s.maxSpeed || 0,
            avgSpeed: s.avgSpeed || 0,
            trips: s.poezdok || 0,
            stops: s.stoyanok || 0,
            totalStop: s.totalStop || '—',
            motoChas: s.motoChas || '—',
            gas: s.gas || 0,
            benzin: s.benzin || 0
        };
    }

    async applyTripTableKmFromReport(rr, chronology) {
        const tables = (rr && rr.tables) || [];
        let best = 0;
        for (let i = 0; i < tables.length; i++) {
            const tbl = tables[i] || {};
            const name = (String(tbl.name || '') + ' ' + String(tbl.label || '')).toLowerCase();
            const isTripTbl = tbl.name === 'unit_trips' || (name.includes('поезд') && !name.includes('хронолог') && tbl.name !== 'unit_chronology');
            if (!isTripTbl) continue;
            const headers = (tbl.header || []).map(h => this.cellText(h).toLowerCase());
            let kmIdx = headers.findIndex(h => (h.includes('пробег') || h.includes('mileage') || h.includes('masofa')) && !h.includes('скорост') && !h.includes('speed'));
            if (kmIdx < 0) kmIdx = headers.findIndex(h => /км|km/.test(h) && !h.includes('скорост') && !h.includes('speed') && !h.includes('ч') && !h.includes('h'));
            if (kmIdx < 0) continue;
            const tot = tbl.total;
            const totCells = Array.isArray(tot) ? tot : (tot && tot.c) || [];
            let totKm = 0;
            if (totCells[kmIdx] != null) {
                totKm = this.kmFromWialon(this.cellNum(totCells[kmIdx]), headers[kmIdx] || '', this.cellText(totCells[kmIdx]));
            }
            let sum = 0;
            const rows = await this.fetchReportRows(i, Number(tbl.rows || 0));
            rows.forEach(r => {
                const cell = (r.c || [])[kmIdx];
                const n = this.cellNum(cell);
                if (!n || n <= 0) return;
                const km = this.kmFromWialon(n, headers[kmIdx] || '', this.cellText(cell));
                if (km > 0 && km < 2000) sum += km;
            });
            const tripKm = this.roundKm(totKm || sum);
            if (tripKm > best) best = tripKm;
            if (Number(tbl.rows || 0) && !chronology.stats.poezdok) {
                chronology.stats.poezdok = Number(tbl.rows || 0);
            }
        }
        if (best > 0) {
            chronology.stats.probeg = best;
            chronology.stats._kmSrc = 'trips';
        }
    }

    async dayMetrics(unitId, timeFrom, timeTo) {
        // 1) Отчёт по поездкам (Boomerang UI bilan bir xil)
        let fromReport = null;
        try {
            fromReport = await this.reportDayMetrics(unitId, timeFrom, timeTo);
        } catch (e) {
            console.warn('report stats:', e);
        }
        // 2) unit/get_trips — zaxira / to'ldirish
        let fromTrips = null;
        try {
            fromTrips = await this.officialDayMetrics(unitId, timeFrom, timeTo);
        } catch (e) {}

        if (fromReport && (fromReport.km || fromReport.trips || fromReport.maxSpeed)) {
            const km = (fromReport.km && fromReport.km > 0)
                ? fromReport.km
                : (fromTrips && fromTrips.km) || 0;
            return {
                km,
                maxSpeed: fromReport.maxSpeed || (fromTrips && fromTrips.maxSpeed) || 0,
                avgSpeed: fromReport.avgSpeed || (fromTrips && fromTrips.avgSpeed) || 0,
                trips: fromReport.trips || (fromTrips && fromTrips.trips) || 0,
                stops: fromReport.stops || 0,
                totalStop: fromReport.totalStop || '—',
                motoChas: fromReport.motoChas || '—',
                gas: fromReport.gas || 0,
                benzin: fromReport.benzin || 0
            };
        }
        if (fromTrips && (fromTrips.km || fromTrips.trips || fromTrips.maxSpeed)) return fromTrips;
        return null;
    }

    async getTripMetrics(unitId, timeFrom, timeTo) {
        return this.dayMetrics(unitId, timeFrom, timeTo);
    }

    async applyTripMetrics(unitId, timeFrom, timeTo, chronology) {
        if (!chronology || !chronology.stats) return chronology;
        try {
            const m = await this.dayMetrics(unitId, timeFrom, timeTo);
            if (m) {
                if (m.km) chronology.stats.probeg = m.km;
                if (m.maxSpeed) chronology.stats.maxSpeed = this.roundSpd(Math.max(chronology.stats.maxSpeed || 0, m.maxSpeed));
                if (m.avgSpeed) chronology.stats.avgSpeed = m.avgSpeed;
                if (m.trips) chronology.stats.poezdok = m.trips;
                if (m.stops && !chronology.stats.stoyanok) chronology.stats.stoyanok = m.stops;
                if (m.totalStop && m.totalStop !== '—') chronology.stats.totalStop = m.totalStop;
                if (m.motoChas && m.motoChas !== '—') chronology.stats.motoChas = m.motoChas;
                if (m.gas && !chronology.stats.gas) chronology.stats.gas = m.gas;
                if (m.benzin && !chronology.stats.benzin) chronology.stats.benzin = m.benzin;
            }
        } catch (e) {
            console.warn('day metrics:', e);
        }
        return chronology;
    }

    parseReportStats(statsPairs, chronology) {
        let bestPref = -1;
        let bestKm = 0;
        (statsPairs || []).forEach(pair => {
            if (!Array.isArray(pair) || pair.length < 2) return;
            const k = String(this.cellText(pair[0]) || pair[0] || '').toLowerCase();
            const raw = pair[1];
            const v = String(this.cellText(raw) || '').trim();
            const num = this.cellNum(raw);
            const blob = k + ' ' + v;
            const pref = this.mileagePref(k);
            if (pref >= 0 && num > 0) {
                const km = this.kmFromWialon(num, k, v);
                if (km > 0 && (pref > bestPref || (pref === bestPref && km > bestKm))) {
                    bestPref = pref;
                    bestKm = km;
                }
            }
            if ((k.includes('средн') || k.includes('avg') || k.includes('average') || k.includes("o'rtacha") || k.includes('ortacha')) && (k.includes('скорост') || k.includes('speed') || k.includes('tezlik'))) {
                if (num > 0) chronology.stats.avgSpeed = this.roundSpd(num);
            }
            if ((k.includes('макс') || k.includes('max')) && (k.includes('скорост') || k.includes('speed') || k.includes('tezlik') || /km\/h|км\/ч/i.test(v))) {
                if (num > 0) chronology.stats.maxSpeed = this.roundSpd(num);
            }
            if ((k.includes('количество') || k.includes('count') || k.includes('soni')) && (k.includes('поезд') || k.includes('trip')) && num > 0) {
                chronology.stats.poezdok = Math.round(num);
            } else if (k.includes('поезд') && !k.includes('пробег') && !k.includes('скорост') && num > 0 && !chronology.stats.poezdok) {
                chronology.stats.poezdok = Math.round(num);
            }
            if (k.includes('стоян') || k.includes('parking') || k.includes('stay')) {
                if (k.includes('длитель') || k.includes('продолж') || k.includes('duration') || k.includes('время')) {
                    const m = v.match(/\d+:\d+(?::\d+)?/);
                    if (m) chronology.stats.totalStop = m[0];
                } else if (num > 0) {
                    chronology.stats.stoyanok = Math.round(num);
                }
            }
            if ((k.includes('движен') || k.includes('мото') || k.includes('moto') || k.includes('engine')) && !k.includes('стоян')) {
                const m = v.match(/\d+:\d+(?::\d+)?/);
                if (m) chronology.stats.motoChas = m[0];
            }
            if ((k.includes('расход') || k.includes('потрач') || k.includes('fuel') || k.includes('топлив') || k.includes('sarf')) && num > 0) {
                if (/м³|m3|куб|газ|метан|cнг|cng/i.test(blob)) chronology.stats.gas = this.roundFuel(num);
                else if (/л\b|литр|бензин|дизел|diesel|petrol/i.test(blob)) chronology.stats.benzin = this.roundFuel(num);
            }
        });
        if (bestKm > 0) {
            if (!(chronology.stats._kmSrc === 'trips' && bestPref < 3)) {
                chronology.stats.probeg = bestKm;
                if (bestPref >= 3) chronology.stats._kmSrc = 'trip_stats';
            }
        }
    }

    mergeReportStats(base, extra) {
        if (!extra || !extra.stats) return base;
        const out = base || this.emptyChronology();
        const s = out.stats;
        const e = extra.stats;
        if (e.probeg) s.probeg = e.probeg;
        if (e.maxSpeed) s.maxSpeed = e.maxSpeed;
        if (e.avgSpeed) s.avgSpeed = e.avgSpeed;
        if (e.poezdok) s.poezdok = e.poezdok;
        if (e.stoyanok && !s.stoyanok) s.stoyanok = e.stoyanok;
        if (e.totalStop && e.totalStop !== '—') s.totalStop = e.totalStop;
        if (e.motoChas && e.motoChas !== '—') s.motoChas = e.motoChas;
        if (e.gas && !s.gas) s.gas = e.gas;
        if (e.benzin && !s.benzin) s.benzin = e.benzin;
        return out;
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
        const { resourceId, templateId } = await this.resolveReportTemplate();

        const execResp = await this.sendRequest('report/exec_report', {
            reportResourceId: resourceId,
            reportTemplateId: templateId,
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
            loaded.filter(x =>
                x.tbl.name === 'unit_stays' ||
                x.tblName.includes('стоян') ||
                x.tblName.includes('parking') ||
                x.tblName.includes('stay')
            ).forEach(block => {
                const headers = (block.tbl.header || []).map(h => this.cellText(h).toLowerCase());
                const col = (...keys) => {
                    for (let i = 0; i < headers.length; i++) {
                        if (keys.some(k => headers[i].includes(k))) return i;
                    }
                    return -1;
                };
                const iBegin = col('начал', 'begin', 'start', 'kirish', 'from');
                const iEnd = col('окончан', 'конец', 'end', 'finish', 'chiqish', 'to');
                const iDur = col('длитель', 'продолж', 'duration', 'davom');
                const iLoc = col('местополож', 'location', 'адрес', 'address', 'joy');
                block.rows.forEach(r => {
                    const c = r.c || [];
                    const pick = (i, fb) => (i >= 0 && i < c.length ? c[i] : fb);
                    const begin = pick(iBegin, c[0]);
                    const end = pick(iEnd, c[1]);
                    const durC = pick(iDur, c[2]);
                    let loc = pick(iLoc, c[3] || c[2]);
                    let locXY = this.cellCoord(loc);
                    if (!locXY.lat && !locXY.lng) {
                        for (const cell of c) {
                            const xy = this.cellCoord(cell);
                            if (xy.lat || xy.lng) { locXY = xy; loc = cell; break; }
                        }
                    }
                    chronology.stops.push({
                        num: chronology.stops.length + 1,
                        type: 'stop',
                        place: this.cellText(loc) || 'Noma\'lum manzil',
                        inTime: this.formatClock(this.cellText(begin)),
                        outTime: this.formatClock(this.cellText(end)),
                        duration: this.cellText(durC || ''),
                        lat: locXY.lat,
                        lng: locXY.lng
                    });
                });
            });
        }

        let statsKmPref = this.mileagePref(
            ((rr.stats || []).map(p => String(this.cellText(p && p[0]) || '')).find(k => this.mileagePref(k) >= 0)) || ''
        );
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
                const km = this.kmFromWialon(n, headers[kmIdx] || '', t);
                if (km > 0 && km < 2000) sum += km;
            });
            const tot = block.tbl.total;
            const totCells = Array.isArray(tot) ? tot : (tot && tot.c) || [];
            let totKm = 0;
            if (totCells[kmIdx] != null) {
                totKm = this.kmFromWialon(this.cellNum(totCells[kmIdx]), headers[kmIdx] || '', this.cellText(totCells[kmIdx]));
            }
            const tripKm = this.roundKm(totKm || sum);
            // Boomerang: поездки jadvali = «Пробег в поездках»
            if (tripKm > 0) {
                chronology.stats.probeg = tripKm;
                chronology.stats._kmSrc = 'trips';
            }
        });

        if (chronology.stops.length) chronology.stats.stoyanok = chronology.stops.length;
        else if (!chronology.stats.stoyanok) chronology.stats.stoyanok = 0;
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
            loadCount: 6000
        });
        const msgs = (resp && resp.messages) || [];
        if (!msgs.length) return chronology;

        const STOP_SPEED = 3;
        const STOP_MIN = 300;
        let driveSec = 0;
        let mileage = 0;
        let maxSpd = 0;
        let lastMove = null;
        let ticks = 0;

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
            } else {
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
            ticks++;
            if (ticks % 500 === 0) await new Promise(r => setTimeout(r, 0));
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
window.wialonGPS.scrubStoredSecrets();
