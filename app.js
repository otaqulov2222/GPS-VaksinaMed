'use strict';
/* =========================================================
   VaksinaMed GPS Monitor — app.js (To'liq versiya)
   ========================================================= */

// Haydovchilar: fleet-data.js (window.DRIVERS)
const DRIVERS = window.DRIVERS || [];

// ── 2. HOLAT VA SAQLASH ─────────────────────────────────────
const STATE = {
    currentCar:  null,
    currentDate: null,
    data:        {},   // { 'YYYY-MM-DD': { 'car_key': processedData } }
    history:     [],   // tarix ['YYYY-MM-DD']
    fuelNorms:   { gas: 14, benzin: 12, diesel: 10 },
    gpsConfig:   null,
    map:         null,
    mapMarkers:  [],
    mapLine:     null,
    pharmacies:  [],
    reviews:     {}
};

const UZ_MONTHS = ['Yanvar','Fevral','Mart','Aprel','May','Iyun','Iyul','Avgust','Sentabr','Oktabr','Noyabr','Dekabr'];
const UZ_MONTHS_SHORT = ['Yan','Fev','Mar','Apr','May','Iyn','Iyl','Avg','Sen','Okt','Noy','Dek'];
let CAL = { y: new Date().getFullYear(), m: new Date().getMonth() };

// ── LocalStorage ─────────────────────────────────────────────
function gpsConfigSafe(cfg) {
    if (!cfg || typeof cfg !== 'object') return null;
    return {
        host: cfg.host || '',
        user: cfg.user || '',
        hasToken: !!(cfg.token || cfg.hasToken),
        hasPassword: !!(cfg.password || cfg.hasPassword),
        serverConfigured: !!(cfg.serverConfigured || cfg.configured || cfg.token || cfg.password || cfg.hasToken || cfg.hasPassword)
    };
}

function saveAll() {
    try {
        localStorage.setItem('vm_gps_v3', JSON.stringify({
            data: STATE.data,
            history: STATE.history,
            fuelNorms: STATE.fuelNorms,
            gpsConfig: gpsConfigSafe(STATE.gpsConfig)
        }));
    } catch(e) {
        // Kvota tugasa eski 30 kunni o'chirish
        if (e.name === 'QuotaExceededError') {
            const keep = [...STATE.history].sort((a,b)=>b.localeCompare(a)).slice(0,30);
            STATE.history = keep;
            const trimmed = {};
            keep.forEach(d => { if (STATE.data[d]) trimmed[d] = STATE.data[d]; });
            STATE.data = trimmed;
            try {
                localStorage.setItem('vm_gps_v3', JSON.stringify({
                    data: trimmed,
                    history: keep,
                    fuelNorms: STATE.fuelNorms,
                    gpsConfig: gpsConfigSafe(STATE.gpsConfig)
                }));
            } catch(_) {}
        }
    }
}

function loadAll() {
    try {
        const s = localStorage.getItem('vm_gps_v3');
        if (!s) return;
        const p = JSON.parse(s);
        STATE.data      = p.data      || {};
        STATE.history   = p.history   || [];
        STATE.fuelNorms = p.fuelNorms || { gas:14, benzin:12, diesel:10 };
        // Eski localStorage dagi GPS parol/token ni o'qib, xotiraga ham saqlamaymiz
        if (p.gpsConfig) {
            STATE.gpsConfig = gpsConfigSafe(p.gpsConfig);
            if (p.gpsConfig.password || p.gpsConfig.token) saveAll();
        }
        if (STATE.history.length) {
            const sorted = [...STATE.history].sort((a,b)=>b.localeCompare(a));
            STATE.currentDate = sorted[0];
            const d = new Date(STATE.currentDate);
            CAL.y = d.getFullYear(); CAL.m = d.getMonth();
        }
    } catch(e) { console.error('loadAll:', e); }
}

// Yordamchi
function dateStr(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function parseTimeStr(s) {
    if (!s) return 0;
    const p = String(s).split(':').map(Number);
    return (p[0]||0)*3600 + (p[1]||0)*60 + (p[2]||0);
}
function secsToHHMM(secs) {
    const h = Math.floor(secs/3600), m = Math.floor((secs%3600)/60);
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}
function roundKm(v) {
    const x = Number(v);
    if (!Number.isFinite(x) || x <= 0) return 0;
    return x;
}
function roundSpd(v) {
    const x = Number(v);
    if (!Number.isFinite(x) || x <= 0) return 0;
    return Math.round(x * 100) / 100;
}
function roundFuel(v) {
    const x = Number(v);
    if (!Number.isFinite(x) || x <= 0) return 0;
    return x;
}
function fmtDec(v, maxDec) {
    const x = Number(v);
    if (!Number.isFinite(x)) return '';
    if (x === 0) return '0';
    let s = x.toFixed(maxDec);
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
}
function fmtKm(v, unit) {
    const x = roundKm(v);
    if (!x) return '—';
    const s = x.toFixed(2);
    return unit ? s + ' ' + unit : s;
}
function fmtSpd(v, unit) {
    const x = roundSpd(v);
    if (!x) return '—';
    const s = x.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return unit ? s + ' ' + unit : s;
}
function fmtFuel(v, unit) {
    const x = roundFuel(v);
    if (!x) return '—';
    const s = fmtDec(x, 4);
    return unit ? s + ' ' + unit : s;
}

// ── 3. DORIXONA TAHLILI ─────────────────────────────────────
const PHARMACY_ALIASES = {
    "корзинка":         ["korzinka","карзинка","karzinka"],
    "гор больница-16":  ["16-гор больница","гкб 16","16-shifoxona","гор-больница"],
    "юнусабад":         ["юнусобод","yunusobod","yunusabad"],
    "алгоритм":         ["algoritm","алgoritm"],
    "мирабад":          ["mirobod","мирабод"],
    "яшнабад":          ["yashnobod","яшнобод"],
    "фарм люкс":        ["farmlux","farm lux","farм люкс"],
    "госпитальний":     ["gospitalny","gospitalь","госпиталь"],
};

function normPh(s) {
    if (!s) return '';
    return s.toLowerCase()
        .replace(/ё/g,'е').replace(/қ/g,'к').replace(/ў/g,'у')
        .replace(/ҳ/g,'х').replace(/ғ/g,'г').replace(/ң/g,'н')
        .replace(/['`'']/g,'').replace(/\s+/g,' ').trim();
}

let PHARM_INDEX = [];
function uniquePhNames(list) {
    const seen = new Set();
    const out = [];
    (list || []).forEach(ph => {
        const k = normPh(ph);
        if (!k || seen.has(k)) return;
        seen.add(k);
        out.push(ph);
    });
    return out;
}

function ownPharmacyList(carKey) {
    if (window.VMOffice && typeof VMOffice.ownNames === 'function') {
        return uniquePhNames(VMOffice.ownNames(carKey));
    }
    const driver = DRIVERS.find(d => d.car === carKey);
    if (!driver || !driver.pharmacies) return [];
    return uniquePhNames(driver.pharmacies.split(',').map(p => p.trim()).filter(Boolean));
}

function buildPharmIndex() {
    PHARM_INDEX = [];
    const pushEntry = (phName, car, shortName) => {
        const n = normPh(phName);
        if (!n) return;
        PHARM_INDEX.push({ norm: n, name: phName, car, driver: shortName });
        Object.entries(PHARMACY_ALIASES).forEach(([canonical, aliases]) => {
            if (n.includes(normPh(canonical)) || aliases.some(a => n.includes(normPh(a)))) {
                aliases.forEach(al => PHARM_INDEX.push({ norm: normPh(al), name: phName, car, driver: shortName }));
            }
        });
    };
    const fromState = STATE.pharmacies || [];
    if (fromState.length) {
        fromState.forEach(ph => {
            const drv = DRIVERS.find(d => d.car === ph.car);
            pushEntry(ph.name, ph.car, drv ? drv.shortName : ph.car);
            (ph.aliases || []).forEach(al => pushEntry(al, ph.car, drv ? drv.shortName : ph.car));
        });
        return;
    }
    DRIVERS.forEach(drv => {
        if (!drv.pharmacies) return;
        drv.pharmacies.split(',').forEach(ph => pushEntry(ph.trim(), drv.car, drv.shortName));
    });
}

function matchPharmacy(place, currentCar, lat, lng) {
    if (window.VMOffice && typeof VMOffice.matchGeo === 'function') {
        const geo = VMOffice.matchGeo(currentCar, lat, lng);
        if (geo) return geo;
    }
    const pn = normPh(place);
    if (!pn || pn.length < 3) return { type: 'none', phName: null, owners: [] };

    let bestScore = 0, bestMatch = null, owners = [];

    PHARM_INDEX.forEach(entry => {
        const en = entry.norm;
        let score = 0;
        if (pn === en) score = 100;
        else if (pn.includes(en) || en.includes(pn)) {
            score = Math.min(pn.length, en.length) / Math.max(pn.length, en.length) * 90;
        } else {
            // Token matching
            const ptok = pn.split(' ');
            const etok = en.split(' ');
            let matches = 0;
            ptok.forEach(pt => { if (etok.some(et => et === pt && pt.length > 2)) matches++; });
            score = matches / Math.max(ptok.length, etok.length) * 70;
        }
        if (score > 40) {
            owners.push({ car: entry.car, driver: entry.driver, phName: entry.name, score });
            if (score > bestScore) { bestScore = score; bestMatch = entry; }
        }
    });

    if (!bestMatch) return { type: 'none', phName: null, owners: [] };

    const uniqueOwners = [...new Map(owners.map(o => [o.car, o])).values()];
    const isOwn = uniqueOwners.some(o => o.car === currentCar);

    return {
        type:    isOwn ? 'own' : 'other',
        phName:  bestMatch.name,
        owners:  uniqueOwners.map(o => o.driver)
    };
}

// Ofis/sklad joylari
const OFFICE_KEYWORDS = ['sklad','склад','офис','omborxona','ombo','база','база','vaksina','vaksinamed',
    'завод','fabrika','tashkent farma','korxona','baza','bosh ofis'];
function isOffice(place) {
    const p = normPh(place);
    return OFFICE_KEYWORDS.some(k => p.includes(k));
}

// Shahar tashqarisi
const OUTSIDE_MARKERS = ['kibray','кибрай','parkent','паркент','yangiyo','янгийўл',
    'zangiota','зангиота','qibray','chirchiq','чирчиқ','bo\'ka','бўка','urtachirchiq'];
function isOutsideCity(place) {
    const p = normPh(place);
    return OUTSIDE_MARKERS.some(k => p.includes(k));
}

// ── 4. EXCEL FAYLNI TAHLIL QILISH ──────────────────────────
function normalizeCarNum(s) {
    if (!s) return '';
    return String(s).replace(/[^0-9A-Za-zА-Яа-яЎўҚқҲҳ]/g,' ').replace(/\s+/g,' ').trim().toUpperCase();
}

function findDriverByCar(carRaw) {
    const compact = normalizeCarNum(carRaw).replace(/\s/g, '');
    if (!compact) return null;
    const exact = DRIVERS.find(d => normalizeCarNum(d.car).replace(/\s/g, '') === compact);
    if (exact) return exact;
    const prefixed = DRIVERS.filter(d => {
        const dn = normalizeCarNum(d.car).replace(/\s/g, '');
        return dn.startsWith(compact) || compact.startsWith(dn);
    });
    if (prefixed.length === 1) return prefixed[0];
    const digits = compact.match(/^(\d{2}\d{3})/);
    if (digits) {
        const hit = DRIVERS.filter(d => normalizeCarNum(d.car).replace(/\s/g, '').startsWith(digits[1]));
        if (hit.length === 1) return hit[0];
    }
    return null;
}

function enrichStops(rawStops, carKey) {
    return (rawStops || []).map((s, i) => {
        const place = String(s.place || '').trim();
        const match = matchPharmacy(place, carKey, s.lat, s.lng);
        const durSec = s.durSec || parseTimeStr(s.duration) || 0;
        const stop = {
            num: i + 1,
            place: place || 'Noma\'lum manzil',
            inTime: s.inTime || '',
            outTime: s.outTime || '',
            duration: s.duration || '',
            durSec,
            lat: s.lat || 0,
            lng: s.lng || 0,
            gas: s.gas || 0,
            benzin: s.benzin || 0,
            matchType: match.type,
            phName: match.phName,
            owners: match.owners,
            isOffice: isOffice(place),
            isOutside: isOutsideCity(place),
            isProblem: false
        };
        if (!stop.isOffice && !stop.isOutside && stop.matchType === 'none' && stop.durSec > 600) {
            stop.isProblem = true;
        }
        return stop;
    });
}

async function handleFileDrop(files) {
    const arr = Array.from(files).filter(f => /\.(xlsx|xls)$/i.test(f.name));
    if (!arr.length) { showToast('⚠️ Faqat .xlsx yoki .xls fayllari qabul qilinadi', 'warn'); return; }
    showToast(`📂 ${arr.length} ta fayl yuklanmoqda...`, 'info');
    let loaded = 0;
    for (const file of arr) {
        try {
            await processXLSX(file);
            loaded++;
        } catch(e) {
            showToast(`❌ ${file.name}: ${e.message}`, 'error');
        }
    }
    if (loaded > 0) {
        saveAll();
        renderCalendar();
        renderDriverTabs();
        refreshUI();
        if (window.VMOffice && STATE.currentDate) {
            VMOffice.renderFleetBoard();
            VMOffice.saveReport(STATE.currentDate);
        }
        showToast(`✅ ${loaded} ta fayl muvaffaqiyatli yuklandi!`, 'success');
    }
}

async function processXLSX(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('Faylni o\'qib bo\'lmadi'));
        reader.onload = (e) => {
            try {
                const wb = XLSX.read(e.target.result, { type: 'binary', cellDates: true });

                // Avval mashina raqamini aniqlaymiz
                let carRaw = '', driver = null;

                // 1. Fayl nomidan
                const fnMatch = file.name.match(/(\d{2}\s*\d{3,4}\s*[A-Z]{2,3})/i);
                if (fnMatch) { carRaw = fnMatch[1]; driver = findDriverByCar(carRaw); }

                // 2. Barcha varaqlardan izlaymiz
                for (const shName of wb.SheetNames) {
                    if (driver) break;
                    const ws  = wb.Sheets[shName];
                    const csv = XLSX.utils.sheet_to_csv(ws);
                    const m   = csv.match(/(\d{2}\s*\d{3,4}\s*[A-Z]{2,3})/i);
                    if (m) { carRaw = m[1]; driver = findDriverByCar(carRaw); }
                }

                if (!driver) {
                    // Agar topilmasa — faylda ko'rsatilgan raqam bilan haydovchi yaratamiz
                    console.warn('Haydovchi topilmadi:', carRaw, file.name);
                }

                // Xronologiya varaqini topamiz
                let chronoSheet = null;
                for (const sn of wb.SheetNames) {
                    if (/хрон|chron|хронол/i.test(sn) || /маршрут/i.test(sn)) {
                        chronoSheet = wb.Sheets[sn]; break;
                    }
                }
                if (!chronoSheet) chronoSheet = wb.Sheets[wb.SheetNames[0]];

                const rows = XLSX.utils.sheet_to_json(chronoSheet, { header:1, defval:'' });

                // Sanani topamiz
                let dateFound = null;
                for (let i = 0; i < Math.min(20, rows.length); i++) {
                    const row = rows[i];
                    for (const cell of row) {
                        if (cell instanceof Date) {
                            dateFound = dateStr(cell); break;
                        }
                        const s = String(cell);
                        const dm = s.match(/(\d{2})[.\-\/](\d{2})[.\-\/](\d{4})/);
                        if (dm) { dateFound = `${dm[3]}-${dm[2]}-${dm[1]}`; break; }
                        const dm2 = s.match(/(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/);
                        if (dm2) { dateFound = `${dm2[1]}-${dm2[2]}-${dm2[3]}`; break; }
                    }
                    if (dateFound) break;
                }
                if (!dateFound) dateFound = STATE.currentDate || dateStr(new Date());

                // To'xtashlarni tahlil qilamiz
                const stops = parseChronoRows(rows, driver ? driver.car : carRaw);

                // Statistikani hisoblaymiz
                const stats = parseStats(rows, stops);

                const processedData = {
                    car:      driver ? driver.car : carRaw,
                    driver:   driver,
                    date:     dateFound,
                    stats:    stats,
                    stops:    stops,
                    analysis: analyzeData(stops, driver ? driver.car : '', stats, dateFound)
                };

                const carKey = processedData.car;
                if (!STATE.data[dateFound]) STATE.data[dateFound] = {};
                STATE.data[dateFound][carKey] = processedData;
                if (!STATE.history.includes(dateFound)) STATE.history.push(dateFound);
                STATE.currentDate = dateFound;
                if (!STATE.currentCar) STATE.currentCar = carKey;

                // CAL ni yangilash
                const d = new Date(dateFound);
                CAL.y = d.getFullYear(); CAL.m = d.getMonth();

                resolve(processedData);
            } catch(err) {
                reject(err);
            }
        };
        reader.readAsBinaryString(file);
    });
}

function parseChronoRows(rows, carKey) {
    const stops = [];
    // Sarlavhani topamiz
    let headerRow = -1;
    for (let i = 0; i < Math.min(30, rows.length); i++) {
        const r = rows[i].map(c => String(c).toLowerCase());
        if (r.some(c => c.includes('место') || c.includes('joy') || c.includes('мест') || c.includes('адрес'))) {
            headerRow = i; break;
        }
    }

    for (let i = (headerRow >= 0 ? headerRow + 1 : 1); i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.every(c => !String(c).trim())) continue;

        const place = String(row[1] || row[2] || row[3] || '').trim();
        if (!place || place.length < 2) continue;

        const inTimeRaw  = String(row[2] || row[3] || row[4] || '').trim();
        const outTimeRaw = String(row[3] || row[4] || row[5] || '').trim();
        const durRaw     = String(row[4] || row[5] || row[6] || '').trim();

        // Koordinatlarni izlaymiz
        let lat = 0, lng = 0;
        row.forEach(cell => {
            const s = String(cell);
            const m = s.match(/(-?\d+\.?\d+)[,;\s]+(-?\d+\.?\d+)/);
            if (m) {
                const a = parseFloat(m[1]), b = parseFloat(m[2]);
                if (a > 38 && a < 46 && b > 55 && b < 75) { lat = a; lng = b; }
            }
        });

        // Yoqilg'i
        let gas = 0, benzin = 0;
        const allText = row.join(' ').toLowerCase();
        const gasM = allText.match(/(\d+(?:[.,]\d+)?)\s*(м3|m3|куб|газ)/i);
        const benM = allText.match(/(\d+(?:[.,]\d+)?)\s*(л|l|литр|бензин)/i);
        if (gasM)  gas    = roundFuel(parseFloat(gasM[1].replace(',','.')));
        if (benM)  benzin = roundFuel(parseFloat(benM[1].replace(',','.')));

        const durSec = parseTimeStr(durRaw) || parseTimeStr(inTimeRaw);
        const match = matchPharmacy(place, carKey, lat, lng);

        stops.push({
            num:         i - headerRow,
            place:       place,
            inTime:      inTimeRaw,
            outTime:     outTimeRaw,
            duration:    durRaw,
            durSec:      durSec,
            lat:         lat,
            lng:         lng,
            gas:         gas,
            benzin:      benzin,
            matchType:   match.type,   // 'own'|'other'|'none'
            phName:      match.phName,
            owners:      match.owners,
            isOffice:    isOffice(place),
            isOutside:   isOutsideCity(place),
            isProblem:   false  // keyinroq belgilanadi
        });
    }

    // Muammoli to'xtashlarni belgilash
    stops.forEach(s => {
        if (!s.isOffice && !s.isOutside && s.matchType === 'none' && s.durSec > 600) {
            s.isProblem = true;
        }
    });

    return stops;
}

function parseStats(rows, stops) {
    const totalGas    = stops.reduce((s, r) => s + (r.gas || 0), 0);
    const totalBenzin = stops.reduce((s, r) => s + (r.benzin || 0), 0);

    let probeg = 0, maxSpeed = 0, avgSpeed = 0, poezdok = 0, stoyanok = 0;
    let motoChasStr = '—', totalStopStr = '—';

    for (let i = 0; i < Math.min(30, rows.length); i++) {
        const row = rows[i];
        row.forEach((cell, ci) => {
            const s = String(cell).toLowerCase();
            const next = String(row[ci+1] || '');
            if (s.includes('пробег') || s.includes('masofa') || (s.includes('км') && !s.includes('км/ч') && !s.includes('km/h'))) {
                const v = parseFloat(String(next).replace(',','.'));
                if (v > 0 && v < 2000) probeg = roundKm(v);
            }
            if ((s.includes('средн') || s.includes('avg') || s.includes("o'rtacha")) && (s.includes('скорост') || s.includes('tezlik') || s.includes('speed') || s.includes('тезлик'))) {
                const v = parseFloat(String(next).replace(',','.'));
                if (v > 0 && v < 300) avgSpeed = roundSpd(v);
            }
            if ((s.includes('макс') || s.includes('max')) && (s.includes('скорост') || s.includes('tezlik') || s.includes('speed') || s.includes('тезлик'))) {
                const v = parseFloat(String(next).replace(',','.'));
                if (v > 0 && v < 300) maxSpeed = roundSpd(v);
            }
            if (s.includes('поезд') || s.includes('trip') || s.includes('рейс')) {
                const v = parseInt(next, 10);
                if (v > 0 && v < 200) poezdok = v;
            }
            if ((s.includes('стоянк') || s.includes('stop')) && !s.includes('общ')) {
                const v = parseInt(next, 10);
                if (v > 0 && v < 200) stoyanok = v;
            }
            if (s.includes('мото') || s.includes('motochas') || s.includes('движ')) {
                if (next.match(/\d+:\d+/)) motoChasStr = next.trim();
            }
        });
    }

    if (!probeg) probeg = 0;
    if (!poezdok) poezdok = stops.filter(s => !s.isOffice).length;
    if (!stoyanok) stoyanok = stops.length;

    return {
        probeg, maxSpeed, avgSpeed, poezdok, stoyanok,
        gas: roundFuel(totalGas), benzin: roundFuel(totalBenzin),
        motoChas: motoChasStr, totalStop: totalStopStr
    };
}

// ── 5. TAHLIL VA BALL HISOBLASH ─────────────────────────────
function stopIsProblem(st, carKey, dateVal) {
    const day = dateVal || STATE.currentDate;
    const car = carKey || STATE.currentCar;
    if (window.VMOffice && typeof VMOffice.isProblem === 'function') {
        return VMOffice.isProblem(day, car, st);
    }
    return !!(st && st.isProblem);
}

function analyzeData(stops, carKey, stats, dateVal) {
    const day = dateVal || STATE.currentDate;
    const ownPharms = uniquePhNames(ownPharmacyList(carKey));
    const problemOf = (s) => stopIsProblem(s, carKey, day);

    const visitedNorms = new Set(
        stops.filter(s => s.matchType === 'own').map(s => normPh(s.phName || s.place || '')).filter(Boolean)
    );
    const bag = (STATE.reviews && STATE.reviews[day]) || {};
    const want = String(carKey || '').replace(/\s+/g, '').toUpperCase();
    Object.keys(bag).forEach(key => {
        const rv = bag[key];
        if (!rv || rv.status !== 'allowed' || !rv.phName) return;
        const parts = key.split('|');
        const carK = rv.car || (parts[1] || '');
        if (String(carK).replace(/\s+/g, '').toUpperCase() !== want) return;
        const n = normPh(rv.phName);
        if (n) visitedNorms.add(n);
    });
    const missedList = ownPharms.filter(ph => !visitedNorms.has(normPh(ph)));
    const ownVisited = ownPharms.length ? (ownPharms.length - missedList.length) : visitedNorms.size;
    const otherDir      = stops.filter(s => s.matchType === 'other').length;
    const problemStops  = stops.filter(s => problemOf(s)).length;
    const outsideCity   = stops.filter(s => s.isOutside).length;

    // Ball hisoblash
    let score = 10.0;
    const breakdown = ['Boshlang\'ich ball: 10.0'];
    const recs = [];

    if (problemStops > 0) {
        const deduct = Math.min(problemStops * 1.0, 3.0);
        score -= deduct;
        breakdown.push(`-${deduct.toFixed(1)}: ${problemStops} ta muammoli to'xtash`);
        recs.push(`${problemStops} ta ruxsatsiz joyda to'xtash aniqlandi`);
    }
    if (missedList.length > 0) {
        const deduct = Math.min(missedList.length * 0.5, 2.0);
        score -= deduct;
        breakdown.push(`-${deduct.toFixed(1)}: ${missedList.length} ta dorixona o'tkazib yuborilgan`);
        recs.push(`O'tkazib yuborilgan: ${missedList.slice(0,3).join(', ')}${missedList.length > 3 ? '...' : ''}`);
    }
    if (otherDir > 0) {
        const deduct = Math.min(otherDir * 0.3, 1.5);
        score -= deduct;
        breakdown.push(`-${deduct.toFixed(1)}: ${otherDir} ta boshqa yo'nalish to'xtashi`);
    }
    if (stats.maxSpeed > 90) {
        score -= 0.5;
        breakdown.push(`-0.5: Tezlik normasi oshirildi (${fmtSpd(stats.maxSpeed, 'km/s')})`);
        recs.push('Tezlikni nazorat qiling');
    }
    if (missedList.length === 0 && ownPharms.length > 0) {
        score += 0.5;
        breakdown.push('+0.5: Barcha dorixonalarga borildi');
    }

    score = Math.max(0, Math.min(10, score));
    const grade = score >= 9 ? 'A' : score >= 7 ? 'B' : score >= 5 ? 'C' : score >= 3 ? 'D' : 'F';
    if (recs.length === 0) recs.push('Kun me\'yorida o\'tdi');

    return {
        ownVisited, otherDirection: otherDir, problemStops,
        outsideCity, totalOwn: ownPharms.length,
        missedList, ownPharms,
        score: { final: parseFloat(score.toFixed(1)), grade, breakdown, recommendations: recs }
    };
}

function recomputeCar(dateVal, car) {
    const rec = STATE.data[dateVal] && STATE.data[dateVal][car];
    if (!rec) return;
    rec.analysis = analyzeData(rec.stops || [], car, rec.stats || {}, dateVal);
}

function recomputeDay(dateVal) {
    const day = STATE.data[dateVal];
    if (!day) return;
    Object.keys(day).forEach(car => recomputeCar(dateVal, car));
}

// ── 6. XARITA ───────────────────────────────────────────────
function mapInvalidate() {
    if (!STATE.map) return;
    setTimeout(() => { try { STATE.map.invalidateSize(); } catch (e) {} }, 80);
    setTimeout(() => { try { STATE.map.invalidateSize(); } catch (e) {} }, 400);
}
let mapResizeTimer = 0;
window.addEventListener('resize', () => {
    clearTimeout(mapResizeTimer);
    mapResizeTimer = setTimeout(mapInvalidate, 200);
});

function setMapLockState(active) {
    const frame = document.getElementById('map-frame');
    if (frame) frame.classList.toggle('is-active', !!active);
}

function lockMapInteraction() {
    if (!STATE.map) return;
    STATE.map.scrollWheelZoom.disable();
    STATE.map.dragging.disable();
    STATE.map.doubleClickZoom.disable();
    STATE.map.boxZoom.disable();
    STATE.mapLocked = true;
    setMapLockState(false);
}

function unlockMapInteraction() {
    if (!STATE.map) return;
    STATE.map.scrollWheelZoom.enable();
    STATE.map.dragging.enable();
    STATE.map.doubleClickZoom.enable();
    STATE.map.boxZoom.enable();
    STATE.mapLocked = false;
    setMapLockState(true);
}

function bindMapLock() {
    const frame = document.getElementById('map-frame');
    if (!frame || STATE._mapLockBound) return;
    STATE._mapLockBound = true;
    frame.addEventListener('click', () => unlockMapInteraction());
    frame.addEventListener('mouseleave', () => lockMapInteraction());
    document.addEventListener('click', (e) => {
        if (!frame.contains(e.target)) lockMapInteraction();
    });
}

function addMapTiles(map) {
    const carto = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
        attribution: '',
        subdomains: 'abcd',
        maxZoom: 19
    });
    carto.on('tileerror', () => {
        if (STATE._mapTileFallback) return;
        STATE._mapTileFallback = true;
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '',
            maxZoom: 19
        }).addTo(map);
    });
    carto.addTo(map);
}

function mapPinIcon(label, color, isEnd) {
    return L.divIcon({
        className: 'vm-pin',
        html: `<span class="vm-pin-dot${isEnd ? ' vm-pin-end' : ''}" style="background:${color}">${label}</span>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -12]
    });
}

function stopColor(st) {
    const dateVal = STATE.currentDate;
    const car = STATE.currentCar;
    const rev = window.VMOffice ? VMOffice.reviewOf(dateVal, car, st) : null;
    if (rev && rev.status === 'allowed') return '#1a5c3a';
    if (rev && rev.status === 'violation') return '#9b1c1c';
    if (st.isOffice) return '#2a303a';
    if (st.isOutside) return '#4a3d73';
    if (stopIsProblem(st, car, dateVal)) return '#9b1c1c';
    if (st.matchType === 'own') return '#1a5c3a';
    if (st.matchType === 'other') return '#1a4a78';
    return '#8b939e';
}

function stopStatusLabel(st) {
    const dateVal = STATE.currentDate;
    const car = STATE.currentCar;
    const rev = window.VMOffice ? VMOffice.reviewOf(dateVal, car, st) : null;
    if (rev && rev.status === 'allowed') return 'Ruxsat';
    if (rev && rev.status === 'violation') return 'Qoidabuzarlik';
    if (st.isOffice) return 'Ofis / sklad';
    if (st.isOutside) return 'Shahardan tashqari';
    if (stopIsProblem(st, car, dateVal)) return 'Muammo';
    if (st.matchType === 'own') return "O'z dorixonasi";
    if (st.matchType === 'other') return "Boshqa yo'nalish";
    return 'To\'xtash';
}

function setMapStats(stops, pts) {
    const n = stops ? stops.length : 0;
    const car = STATE.currentCar;
    const dateVal = STATE.currentDate;
    const prob = stops ? stops.filter(s => stopIsProblem(s, car, dateVal)).length : 0;
    const elS = document.getElementById('map-stat-stops');
    const elP = document.getElementById('map-stat-pts');
    const elM = document.getElementById('map-stat-prob');
    if (elS) elS.textContent = n;
    if (elP) elP.textContent = pts || 0;
    if (elM) elM.textContent = prob;
}

function initMap() {
    const el = document.getElementById('leaflet-map');
    if (!el) return;
    if (typeof L === 'undefined') {
        el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#5c6573;font-size:13px;padding:20px;text-align:center;font-family:inherit;">Xarita moduli yuklanmadi. Internetni tekshiring, keyin Ctrl+F5 bosing.</div>';
        return;
    }
    if (STATE.map) {
        mapInvalidate();
        return;
    }
    STATE.map = L.map(el, {
        zoomControl: true,
        attributionControl: false,
        scrollWheelZoom: false,
        dragging: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false
    }).setView([41.3111, 69.2797], 12);
    addMapTiles(STATE.map);
    bindMapLock();
    lockMapInteraction();
    mapInvalidate();
}

function refreshMap(stops) {
    initMap();
    if (!STATE.map) return;
    STATE.mapMarkers.forEach(m => STATE.map.removeLayer(m));
    STATE.mapMarkers = [];
    if (STATE.mapLine) { STATE.map.removeLayer(STATE.mapLine); STATE.mapLine = null; }
    mapInvalidate();

    const list = Array.isArray(stops) ? stops : [];
    if (!list.length) {
        setMapStats([], 0);
        if (window.VMOffice) VMOffice.drawGeofences(STATE.map, STATE.currentCar);
        return;
    }

    const latlngs = [];
    const withGeo = [];
    list.forEach((st, idx) => {
        if (!st.lat || !st.lng) return;
        withGeo.push({ st, idx });
        latlngs.push([st.lat, st.lng]);
    });
    setMapStats(list, withGeo.length);

    if (latlngs.length > 1) {
        STATE.mapLine = L.polyline(latlngs, {
            color: '#0c1016', weight: 5, opacity: 0.35, lineJoin: 'round'
        }).addTo(STATE.map);
        STATE.mapMarkers.push(L.polyline(latlngs, {
            color: '#c9a227', weight: 2.4, opacity: 0.95, lineJoin: 'round'
        }).addTo(STATE.map));
    }

    const lastI = withGeo.length - 1;
    withGeo.forEach((item, i) => {
        const st = item.st;
        const num = item.idx + 1;
        const color = stopColor(st);
        const isEnd = i === 0 || i === lastI;
        const label = i === 0 ? 'A' : (i === lastI ? 'B' : String(num));
        const marker = L.marker([st.lat, st.lng], {
            icon: mapPinIcon(label, color, isEnd),
            zIndexOffset: isEnd ? 600 : 100
        }).addTo(STATE.map);

        marker.bindPopup(`
            <div style="min-width:180px">
              <div style="font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:#c9a227;font-weight:700;margin-bottom:4px">${stopStatusLabel(st)}</div>
              <b>#${num} — ${st.place || '—'}</b><br>
              Kirish: ${st.inTime || '—'}<br>
              Chiqish: ${st.outTime || '—'}<br>
              Turgani: ${st.duration || '—'}<br>
              ${st.phName ? '<b>Dorixona:</b> ' + st.phName + '<br>' : ''}
            </div>
        `);
        STATE.mapMarkers.push(marker);
    });

    if (latlngs.length > 1) {
        STATE.map.fitBounds(L.latLngBounds(latlngs), { padding: [36, 36], maxZoom: 15 });
    } else if (latlngs.length === 1) {
        STATE.map.setView(latlngs[0], 14);
    }
    if (window.VMOffice) VMOffice.drawGeofences(STATE.map, STATE.currentCar);
}

// ── 7. KALENDAR ─────────────────────────────────────────────
function renderCalendar() {
    const grid    = document.getElementById('cal-grid');
    const lbl     = document.getElementById('cal-month-label');
    const cntEl   = document.getElementById('calendar-count');
    const selInfo = document.getElementById('cal-selected-info');
    const selLbl  = document.getElementById('cal-selected-label');
    const selSt   = document.getElementById('cal-day-status');
    if (!grid) return;

    const todayStr = dateStr(new Date());
    const { y, m } = CAL;
    if (lbl) lbl.textContent = `${UZ_MONTHS[m]} ${y}`;
    if (cntEl) cntEl.textContent = STATE.history.length + ' kun';

    const firstDow = new Date(y, m, 1).getDay(); // 0=Yak
    const offset = firstDow === 0 ? 6 : firstDow - 1;
    const days = new Date(y, m + 1, 0).getDate();

    let html = '';
    for (let i = 0; i < offset; i++) html += '<div class="cal-day cal-day-empty"></div>';
    for (let d = 1; d <= days; d++) {
        const ds = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const fut = ds > todayStr;
        const isToday = ds === todayStr;
        const hasData = STATE.history.includes(ds);
        const active  = ds === STATE.currentDate;

        let cls = 'cal-day';
        if (fut) cls += ' cal-day-future';
        else if (isToday) cls += ' is-today';
        if (hasData) cls += ' has-data';
        if (active)  cls += ' active';

        const fn = fut ? '' : `onclick="selectDate('${ds}')"`;
        html += `<div class="${cls}" ${fn} title="${ds}">${d}</div>`;
    }
    grid.innerHTML = html;

    // Tanlangan kun info
    if (STATE.currentDate && selInfo) {
        selInfo.style.display = 'block';
        const dd = new Date(STATE.currentDate + 'T00:00:00');
        if (selLbl) selLbl.textContent = `${dd.getDate()} ${UZ_MONTHS[dd.getMonth()]} ${dd.getFullYear()}`;
        const hd = STATE.history.includes(STATE.currentDate);
        if (selSt) {
            selSt.textContent = hd ? "Ma'lumot bor" : "Ma'lumot yo'q";
            selSt.className = hd ? 'chip chip-green' : 'chip chip-gray';
        }
    }
}

function selectDate(ds) {
    STATE.currentDate = ds;
    renderCalendar();
    renderDriverTabs();
    refreshUI();
    if (window.VMOffice) {
        VMOffice.loadReportIfNeeded(ds).then(() => refreshDayKm(ds));
    } else {
        refreshDayKm(ds);
    }
}

async function refreshDayKm(dateVal) {
    if (!dateVal || !hasGpsConfig() || !window.wialonGPS) return;
    if (STATE.kmFixBusy) return;
    const day = STATE.data[dateVal];
    if (!day || !Object.keys(day).length) return;
    STATE.kmFixBusy = true;
    try {
        await wialonGPS.login(STATE.gpsConfig);
        const units = await wialonGPS.getUnits();
        const { timeFrom, timeTo } = wialonGPS.dayBoundsTashkent(dateVal);
        let nFix = 0;
        for (const unit of units) {
            const drv = findDriverByCar(unit.name) || findDriverByCar(unit.carNumber);
            if (!drv || !day[drv.car] || !day[drv.car].stats) continue;
            const st = day[drv.car].stats;
            const oldKm = Number(st.probeg) || 0;
            let metrics = null;
            try {
                metrics = await wialonGPS.getTripMetrics(unit.id, timeFrom, timeTo);
            } catch (e) {}
            if (!metrics || !metrics.km) continue;
            st.probeg = metrics.km;
            if (metrics.maxSpeed) st.maxSpeed = Math.max(Number(st.maxSpeed) || 0, metrics.maxSpeed);
            if (metrics.avgSpeed) st.avgSpeed = metrics.avgSpeed;
            if (metrics.trips) st.poezdok = metrics.trips;
            if (Math.abs((st.probeg || 0) - oldKm) >= 0.01) nFix += 1;
        }
        if (nFix) {
            saveAll();
            if (window.VMOffice) VMOffice.saveReport(dateVal);
            if (STATE.currentDate === dateVal) refreshUI();
            showToast('GPS km yangilandi: ' + nFix + ' ta mashina', 'success');
        }
    } catch (e) {
        console.warn('km refresh:', e);
    } finally {
        STATE.kmFixBusy = false;
    }
}

// ── 8. HAYDOVCHI TABLARI ─────────────────────────────────────
function renderDriverTabs() {
    const strip = document.getElementById('drivers-strip');
    if (!strip) return;
    let html = '';
    DRIVERS.forEach(d => {
        const active = d.car === STATE.currentCar ? 'active' : '';
        const hasData = STATE.currentDate && STATE.data[STATE.currentDate] && STATE.data[STATE.currentDate][d.car];
        const dotClr  = hasData ? d.color : '#cbd5e1';
        html += `
        <div class="dtab ${active}" onclick="selectDriver('${d.car}')">
            <span class="dtab-dot" style="background:${dotClr}"></span>
            ${d.shortName}
            <span class="dtab-car">${d.car}</span>
        </div>`;
    });
    strip.innerHTML = html;
}

function selectDriver(carKey) {
    STATE.currentCar = carKey;
    renderDriverTabs();
    refreshUI();
}

// ── 9. ASOSIY UI YANGILASH ──────────────────────────────────
function refreshUI() {
    const driver  = DRIVERS.find(d => d.car === STATE.currentCar);
    const dayData = STATE.currentDate && STATE.data[STATE.currentDate]
                    ? STATE.data[STATE.currentDate][STATE.currentCar]
                    : null;

    // Banner
    renderBanner(driver, dayData);

    if (window.VMOffice) VMOffice.renderFleetBoard();

    if (dayData) {
        renderKPI(dayData);
        renderStats(dayData);
        renderPharmacy(dayData);
        renderStops(dayData.stops);
        renderEval(dayData.analysis.score);
        refreshMap(dayData.stops);
    } else {
        // Bo'sh holat
        renderKPI(null);
        const kpiEl = document.getElementById('kpi-container');
        if (kpiEl) kpiEl.innerHTML = `
        <div class="kpi-grid">
            ${['c-blue','c-green','c-purple','c-red','c-orange','c-teal'].map(c => `
            <div class="kpi-card ${c}">
                <div class="kpi-title">&nbsp;</div>
                <div class="kpi-value">—</div>
                <div class="kpi-unit">—</div>
            </div>`).join('')}
        </div>`;

        const pharmEl = document.getElementById('pharmacy-analysis');
        if (pharmEl) pharmEl.innerHTML = `<div class="empty-state">
            <div class="empty-title">Ma'lumot yuklanmagan</div>
            <div class="empty-desc">Excel yoki GPS orqali kunlik ma'lumotni yuklang.</div></div>`;

        const stbEl = document.getElementById('stops-table-body');
        if (stbEl) stbEl.innerHTML = `<tr><td colspan="7">
            <div class="empty-state">
            <div class="empty-title">To'xtashlar yo'q</div>
            <div class="empty-desc">Ma'lumot yuklangandan so'ng ro'yxat chiqadi.</div></div></td></tr>`;

        const cntEl = document.getElementById('stops-count');
        if (cntEl) cntEl.textContent = '0 ta';

        const finEl = document.getElementById('eval-final-score');
        if (finEl) finEl.textContent = '—';
        const sumEl = document.getElementById('eval-summary');
        if (sumEl) { sumEl.className = 'eval-summary-box ok'; sumEl.textContent = 'Ma\'lumot yuklanmagan.'; }

        refreshMap(null);
    }
    renderSidebarStats();
}

function renderSidebarStats() {
    const card = document.getElementById('sidebar-stats-card');
    const el = document.getElementById('sidebar-stats');
    if (!card || !el) return;
    const dateVal = STATE.currentDate;
    if (!dateVal || !DRIVERS.length) {
        card.style.display = 'none';
        return;
    }
    const day = STATE.data[dateVal] || {};
    const loaded = Object.keys(day).length;
    const totalKm = Object.values(day).reduce((s, r) => s + ((r.stats && r.stats.probeg) || 0), 0);
    card.style.display = '';
    el.innerHTML = `
        <div><b>${loaded}</b> / ${DRIVERS.length} mashina yuklangan</div>
        <div>Jami km: <b>${typeof fmtKm === 'function' ? fmtKm(totalKm, 'km') : totalKm.toFixed(2)}</b></div>
        <div>Sana: ${dateVal}</div>
        <div>Saqlangan kunlar: ${STATE.history.length}</div>`;
}

// ── 9.1. BANNER ─────────────────────────────────────────────
function renderBanner(driver, data) {
    const nameEl  = document.getElementById('db-name');
    const carEl   = document.getElementById('db-car');
    const metaEl  = document.getElementById('db-meta');
    const scoreEl = document.getElementById('db-score-num');
    const avaEl   = document.getElementById('db-avatar');

    const driverName = driver ? driver.fullName : 'Haydovchi tanlanmagan';
    const carNum     = driver ? driver.car : '— — —';
    const routes     = driver ? (driver.routes || '—') : '—';
    const dateFmt    = STATE.currentDate
        ? (() => { const d = new Date(STATE.currentDate+'T00:00:00'); return `${d.getDate()} ${UZ_MONTHS[d.getMonth()]} ${d.getFullYear()}`; })()
        : '—';

    if (nameEl) {
        // Faqat text node yangilaymiz
        const firstText = nameEl.childNodes[0];
        if (firstText && firstText.nodeType === 3) firstText.nodeValue = driverName + ' ';
        else nameEl.insertBefore(document.createTextNode(driverName + ' '), nameEl.firstChild);
    }
    if (carEl)  carEl.textContent  = carNum;
    if (metaEl) metaEl.innerHTML   = `<strong>Yo'nalish:</strong> ${routes} &nbsp;|&nbsp; <strong>Sana:</strong> ${dateFmt}`;
    if (avaEl) {
        const initials = driver ? String(driver.shortName).slice(0, 2).toUpperCase() : '—';
        avaEl.textContent = initials;
        avaEl.style.background = '';
        const banner = document.getElementById('driver-banner');
        if (banner) banner.style.borderLeftColor = driver ? driver.color : '#0c1016';
    }

    if (scoreEl) {
        const box = document.querySelector('.db-score');
        if (data && data.analysis) {
            const s = data.analysis.score.final;
            scoreEl.textContent  = s.toFixed(1);
            scoreEl.style.color  = s >= 8 ? '#7dcea0' : s >= 5 ? '#c9a227' : '#e07070';
            if (box) box.style.background = '#0c1016';
        } else {
            scoreEl.textContent = '—';
            scoreEl.style.color = '#f4f4f2';
            if (box) box.style.background = '#0c1016';
        }
    }
}

// ── 9.2. KPI KARTALAR ───────────────────────────────────────
function renderKPI(data) {
    const el = document.getElementById('kpi-container');
    if (!el || !data) return;
    const s = data.stats, a = data.analysis;
    const fuelTxt = [
        s.gas    > 0 ? fmtFuel(s.gas, 'm³') : '',
        s.benzin > 0 ? fmtFuel(s.benzin, 'L')  : ''
    ].filter(Boolean).join(' + ') || '—';

    el.innerHTML = `
    <div class="kpi-grid">
        <div class="kpi-card c-blue">
            <div class="kpi-title">Yurilgan masofa</div>
            <div class="kpi-value">${fmtKm(s.probeg)}</div>
            <div class="kpi-unit">км</div>
        </div>
        <div class="kpi-card c-green">
            <div class="kpi-title">O'z dorixonalari</div>
            <div class="kpi-value">${a.ownVisited}<span style="font-size:13px;font-weight:500;color:#8b939e">/${a.totalOwn}</span></div>
            <div class="kpi-unit">Tashrif qilingan</div>
        </div>
        <div class="kpi-card c-purple">
            <div class="kpi-title">Boshqa yo'nalish</div>
            <div class="kpi-value">${a.otherDirection}</div>
            <div class="kpi-unit">To'xtash</div>
        </div>
        <div class="kpi-card c-red">
            <div class="kpi-title">Muammoli</div>
            <div class="kpi-value">${a.problemStops}</div>
            <div class="kpi-unit">To'xtash</div>
        </div>
        <div class="kpi-card c-orange">
            <div class="kpi-title">Maks. tezlik</div>
            <div class="kpi-value">${fmtSpd(s.maxSpeed)}</div>
            <div class="kpi-unit">км/soat</div>
        </div>
        <div class="kpi-card c-teal">
            <div class="kpi-title">Yoqilg'i</div>
            <div class="kpi-value" style="font-size:${fuelTxt.length > 10 ? '14' : '20'}px">${fuelTxt}</div>
            <div class="kpi-unit">Gaz + Benzin</div>
        </div>
    </div>`;
}

// ── 9.3. STATISTIKA ─────────────────────────────────────────
function renderStats(data) {
    const s = data.stats, a = data.analysis;
    const fuelTxt = [
        s.gas    > 0 ? fmtFuel(s.gas, 'm³ gaz') : '',
        s.benzin > 0 ? fmtFuel(s.benzin, 'L benzin') : ''
    ].filter(Boolean).join(' + ') || '—';

    const avgSpd = s.avgSpeed
        ? fmtSpd(s.avgSpeed, 'km/s')
        : (s.probeg && s.motoChas && s.motoChas !== '—'
            ? fmtSpd(s.probeg / Math.max(parseTimeStr(s.motoChas)/3600, 0.1), 'km/s')
            : '—');

    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('stat-probeg',   s.probeg ? fmtKm(s.probeg, 'км') : '—');
    set('stat-worktime', s.motoChas !== '—' ? s.motoChas : '—');
    set('stat-avgspeed', avgSpd);
    set('stat-motochas', s.motoChas !== '—' ? s.motoChas : '—');
    set('stat-trips',    s.poezdok ? s.poezdok + ' ta' : '—');
    set('stat-stops',    s.stoyanok ? s.stoyanok + ' ta' : '—');
    set('stat-fuel',     fuelTxt);
    set('stat-stoptime', s.totalStop !== '—' ? s.totalStop : '—');
}

function reviewBtnHtml(idx, rev) {
    const cur = rev && rev.status;
    return `<span class="rev-btns">
        <button type="button" class="rev-btn${cur === 'allowed' ? ' on-ok' : ''}" data-rev="allowed" data-i="${idx}">Ruxsat</button>
        <button type="button" class="rev-btn${cur === 'violation' ? ' on-bad' : ''}" data-rev="violation" data-i="${idx}">Qoidabuzarlik</button>
        ${cur ? `<button type="button" class="rev-btn" data-rev="" data-i="${idx}">Bekor</button>` : ''}
    </span>`;
}

function bindReviewClicks(root) {
    if (!root || root.dataset.revBound === '1') return;
    root.dataset.revBound = '1';
    root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-rev]');
        if (!btn || !window.VMOffice) return;
        const i = Number(btn.getAttribute('data-i'));
        const status = btn.getAttribute('data-rev') || '';
        const rec = STATE.data[STATE.currentDate] && STATE.data[STATE.currentDate][STATE.currentCar];
        const st = rec && rec.stops && rec.stops[i];
        if (!st) return;
        if (status === 'allowed') {
            const names = VMOffice.ownNames(STATE.currentCar);
            let phName = st.phName || '';
            if (!phName && names.length) {
                const opts = names.map((n, idx) => `${idx + 1}. ${n}`).join('\n');
                const pick = window.prompt(
                    'Bu to\'xtash qaysi dorixona?\n(nomer yoki nomini yozing)\n\n' + opts,
                    ''
                );
                if (pick == null) return;
                const num = parseInt(pick, 10);
                if (num >= 1 && num <= names.length) phName = names[num - 1];
                else {
                    const fold = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-z0-9а-яўқғҳ]/gi, '');
                    const hit = names.find(n => fold(n).includes(fold(pick)) || fold(pick).includes(fold(n)));
                    phName = hit || pick.trim();
                }
            }
            if (!phName) {
                showToast('Dorixona tanlanmadi — geozona o\'rganilmaydi', 'warn');
            }
            VMOffice.setReview(STATE.currentDate, STATE.currentCar, st, status, phName);
            return;
        }
        VMOffice.setReview(STATE.currentDate, STATE.currentCar, st, status);
    });
}

// ── 9.4. DORIXONA TAHLILI ───────────────────────────────────
function renderPharmacy(data) {
    const el = document.getElementById('pharmacy-analysis');
    if (!el) return;
    const a = data.analysis;
    const dateVal = data.date || STATE.currentDate;
    const car = data.car || STATE.currentCar;
    const ownStops   = data.stops.filter(s => s.matchType === 'own');
    const otherStops = data.stops.filter(s => s.matchType === 'other');
    const pct = a.totalOwn > 0 ? Math.round((a.ownVisited / a.totalOwn) * 1000) / 10 : null;

    let html = '<div class="analysis-body">';

    html += `<div class="plan-box">
        <div class="plan-k">Reja / fakt</div>
        <div class="plan-v">${a.ownVisited} / ${a.totalOwn}${pct != null ? ' · ' + fmtDec(pct, 1) + '%' : ''}</div>
        <div class="plan-s">${a.totalOwn
            ? (a.missedList && a.missedList.length ? (a.missedList.length + ' ta o\'tkazib yuborilgan') : 'Reja bajarildi')
            : 'Bu haydovchiga dorixona belgilanmagan. Boshqaruvda qo\'shing.'}</div>
    </div>`;

    if (a.missedList && a.missedList.length > 0) {
        html += `<div class="ph-block">
            <div class="ph-h warn">O'tkazib yuborilgan · ${a.missedList.length}</div>
            <div class="ph-list">
            ${a.missedList.map(ph => `<div class="ph-row"><span class="nm">${ph}</span></div>`).join('')}
            </div></div>`;
    } else if (a.ownPharms && a.ownPharms.length > 0) {
        html += `<div class="ph-note ok">Barcha ${a.ownPharms.length} ta belgilangan dorixonaga tashrif qilindi.</div>`;
    }

    if (ownStops.length > 0) {
        html += `<div class="ph-block">
            <div class="ph-h ok">Borilgan · ${ownStops.length}</div>
            <div class="ph-list">
            ${ownStops.map(s => `
            <div class="ph-row">
                <span class="nm">${s.phName || s.place}</span>
                <span class="tm">${s.inTime || ''}</span>
                <span class="tm">${s.duration || ''}</span>
            </div>`).join('')}
            </div></div>`;
    }

    if (otherStops.length > 0) {
        html += `<div class="ph-block">
            <div class="ph-h warn">Boshqa yo'nalish · ${otherStops.length}</div>
            <div class="ph-list">
            ${otherStops.map(s => `
            <div class="ph-row">
                <span class="nm">${s.phName || s.place}</span>
                <span class="tm">Egasi: ${(s.owners || []).join(', ')}</span>
            </div>`).join('')}
            </div></div>`;
    }

    const problemIdx = [];
    const allowedIdx = [];
    data.stops.forEach((s, i) => {
        const rev = window.VMOffice ? VMOffice.reviewOf(dateVal, car, s) : null;
        if (rev && rev.status === 'allowed') allowedIdx.push(i);
        else if (stopIsProblem(s, car, dateVal)) problemIdx.push(i);
    });

    if (problemIdx.length > 0) {
        html += `<div class="ph-block">
            <div class="ph-h bad">Muammoli · ${problemIdx.length}</div>
            <div class="ph-list">
            ${problemIdx.map(i => {
                const s = data.stops[i];
                const rev = window.VMOffice ? VMOffice.reviewOf(dateVal, car, s) : null;
                return `<div class="ph-row ph-rev">
                <span class="nm">${s.place}</span>
                <span class="tm">${s.duration || ''}</span>
                ${reviewBtnHtml(i, rev)}
            </div>`;
            }).join('')}
            </div></div>`;
    }

    if (allowedIdx.length > 0) {
        html += `<div class="ph-block">
            <div class="ph-h ok">Ruxsat etilgan · ${allowedIdx.length}</div>
            <div class="ph-list">
            ${allowedIdx.map(i => {
                const s = data.stops[i];
                const rev = window.VMOffice ? VMOffice.reviewOf(dateVal, car, s) : null;
                return `<div class="ph-row ph-rev">
                <span class="nm">${s.place}</span>
                <span class="tm">${s.duration || ''}</span>
                ${reviewBtnHtml(i, rev)}
            </div>`;
            }).join('')}
            </div></div>`;
    }

    if (!a.missedList?.length && !ownStops.length && !otherStops.length && !problemIdx.length && !allowedIdx.length) {
        html += '<div class="empty-state"><div class="empty-title">To\'xtash topilmadi</div></div>';
    }

    html += '</div>';
    el.innerHTML = html;
    bindReviewClicks(el);
}

// ── 9.5. TO'XTASHLAR JADVALI ────────────────────────────────
function renderStops(stops) {
    const tbody = document.getElementById('stops-table-body');
    const cntEl = document.getElementById('stops-count');
    if (!tbody) return;
    if (cntEl) cntEl.textContent = (stops ? stops.length : 0) + ' ta';
    if (!stops || !stops.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:30px;color:#94a3b8;">To\'xtashlar topilmadi</td></tr>';
        return;
    }

    const dateVal = STATE.currentDate;
    const car = STATE.currentCar;
    let html = '';
    stops.forEach((st, i) => {
        const rev = window.VMOffice ? VMOffice.reviewOf(dateVal, car, st) : null;
        let rowCls = '', badge = '';
        if (rev && rev.status === 'allowed') {
            rowCls = 'row-own';
            badge = '<span class="badge b-own">Ruxsat</span>';
        } else if (rev && rev.status === 'violation') {
            rowCls = 'row-problem';
            badge = '<span class="badge b-problem">Qoidabuzarlik</span>';
        } else if (st.isOffice) {
            rowCls = 'row-office';
            badge = '<span class="badge b-office">Ofis</span>';
        } else if (st.isOutside) {
            rowCls = 'row-outside';
            badge = '<span class="badge b-outside">Shahar tashqarisi</span>';
        } else if (stopIsProblem(st, car, dateVal)) {
            rowCls = 'row-problem';
            badge = '<span class="badge b-problem">Muammo</span>';
        } else if (st.matchType === 'own') {
            rowCls = 'row-own';
            badge = '<span class="badge b-own">Dorixona</span>';
        } else if (st.matchType === 'other') {
            rowCls = 'row-other';
            badge = '<span class="badge b-other-dir">Boshqa</span>';
        } else {
            badge = '<span class="badge">—</span>';
        }

        const canReview = true;
        html += `
        <tr class="${rowCls}">
            <td class="font-mono text-muted">${i+1}</td>
            <td><strong>${st.place}</strong>
                ${st.phName && st.phName !== st.place ? `<br><small class="text-muted">${st.phName}</small>` : ''}
                ${st.gas > 0 ? `<br><small class="text-muted">${fmtFuel(st.gas, 'm³ gaz')}</small>` : ''}
                ${st.benzin > 0 ? `<br><small class="text-muted">${fmtFuel(st.benzin, 'L benzin')}</small>` : ''}
            </td>
            <td class="font-mono">${st.inTime || '—'}</td>
            <td class="font-mono">${st.outTime || '—'}</td>
            <td class="font-mono text-muted">${st.duration || '—'}</td>
            <td>${badge}</td>
            <td>${canReview ? reviewBtnHtml(i, rev) : '—'}</td>
        </tr>`;
    });
    tbody.innerHTML = html;
    bindReviewClicks(tbody);
}

// ── 9.6. BAHOLASH ───────────────────────────────────────────
function renderEval(score) {
    if (!score) return;
    const f = score.final;

    const setEl = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    setEl('eval-final-score', f.toFixed(1));

    // Eval blocks
    const baseEl = document.getElementById('eval-base-score');
    const dedEl  = document.getElementById('eval-deductions');
    const bonEl  = document.getElementById('eval-bonuses');

    if (baseEl) baseEl.innerHTML = `<div class="eval-block-title">Hisoblash</div>
        <ul>${score.breakdown.map(x => `<li>${x}</li>`).join('')}</ul>`;

    const deducts = score.breakdown.filter(x => x.startsWith('-'));
    if (dedEl) dedEl.innerHTML = `<div class="eval-block-title">Jarima</div>
        <ul>${deducts.length ? deducts.map(x => `<li>${x}</li>`).join('') : '<li>Jarima yo\'q</li>'}</ul>`;

    const bonuses = score.breakdown.filter(x => x.startsWith('+'));
    if (bonEl) bonEl.innerHTML = `<div class="eval-block-title">Bonus</div>
        <ul>${bonuses.length ? bonuses.map(x => `<li>${x}</li>`).join('') : '<li>Bonus yo\'q</li>'}</ul>`;

    const scoreBox = document.querySelector('.eval-score-box');
    if (scoreBox) {
        scoreBox.style.background = '#0c1016';
        const numEl = document.getElementById('eval-final-score');
        if (numEl) numEl.style.color = f >= 8 ? '#7dcea0' : f >= 5 ? '#c9a227' : '#e07070';
    }

    const recEl = document.getElementById('eval-recommendations');
    if (recEl) recEl.innerHTML = score.recommendations.map(r => `<li>${r.replace(/[✅🏆⚠️❌]/g,'').trim()}</li>`).join('');

    const sumEl = document.getElementById('eval-summary');
    if (sumEl) {
        const cls = f >= 8 ? 'good' : f >= 5 ? 'ok' : 'bad';
        sumEl.className = 'eval-summary-box ' + cls;
        sumEl.innerHTML = `<strong>Kunlik ball ${f.toFixed(1)} / 10 · ${score.grade}</strong>`;
    }
}

// ── 10. TOAST XABARLARI ─────────────────────────────────────
function showToast(msg, type = 'info') {
    const accents = { info:'#1a4a78', success:'#1a5c3a', warn:'#c9a227', error:'#9b1c1c' };
    const t = document.createElement('div');
    t.className = 'toast-msg';
    t.style.borderLeftColor = accents[type] || accents.info;
    t.textContent = String(msg).replace(/[📂📡✅❌⚠️🔄🖨️⚙️🔌🏆]/g, '').replace(/\s+/g, ' ').trim();
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .25s'; setTimeout(() => t.remove(), 250); }, 4000);
}

function setGpsUi(state) {
    const chip = document.getElementById('gps-status-chip');
    const btn  = document.getElementById('btn-gps-sync-2');
    if (chip) {
        if (state === 'on') {
            chip.textContent = 'Ulangan';
            chip.className = 'chip chip-green';
        } else if (state === 'sync') {
            chip.textContent = 'Yuklanmoqda';
            chip.className = 'chip chip-blue';
        } else {
            chip.textContent = 'Ulanmagan';
            chip.className = 'chip chip-gray';
        }
    }
    if (btn) btn.textContent = state === 'off' ? 'Ulanish' : 'Yangilash';
}

function hasGpsConfig() {
    const c = STATE.gpsConfig;
    if (!c) return false;
    if (c.serverConfigured || c.hasToken || c.hasPassword) return true;
    return !!((c.token && String(c.token).trim()) || (c.password && String(c.password).trim()));
}

const GPS_AUTO_MS = 5 * 60 * 1000;

function stopGpsAutoSync() {
    if (STATE.gpsAutoTimer) clearInterval(STATE.gpsAutoTimer);
    STATE.gpsAutoTimer = null;
}

function gpsModalOpen() {
    const m = document.getElementById('modal-gps');
    return !!(m && m.classList.contains('open'));
}

function startGpsAutoSync() {
    stopGpsAutoSync();
    STATE.gpsAutoTimer = setInterval(() => {
        if (gpsModalOpen()) return;
        if (document.hidden) return;
        pollServerGpsStatus(false);
    }, 90 * 1000);
}

function sleepMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveGpsConfigToServer(cfg) {
    if (!cfg) return;
    try {
        const body = {
            host: cfg.host || '',
            user: cfg.user || ''
        };
        // Bo'sh qoldirilsa serverdagi eski token/parol saqlanadi
        if (cfg.token) body.token = cfg.token;
        if (cfg.password) body.password = cfg.password;
        const pub = await vmApi('/api/office/gps/config', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        STATE.gpsConfig = Object.assign({}, gpsConfigSafe(STATE.gpsConfig), {
            host: pub.host || cfg.host || '',
            user: pub.user || cfg.user || '',
            hasToken: !!pub.hasToken,
            hasPassword: !!pub.hasPassword,
            serverConfigured: !!pub.configured
        });
        // Xotiradagi maxfiy maydonlarni tozalash (faqat shu sessiyada kerak bo'lmaguncha)
        if (STATE.gpsConfig) {
            delete STATE.gpsConfig.password;
            delete STATE.gpsConfig.token;
        }
        saveAll();
        return pub;
    } catch (e) {
        console.warn('gps config server:', e);
    }
}

function updateGpsLastSyncUi(iso, running) {
    const el = document.getElementById('gps-last-sync');
    if (!el) return;
    if (running) {
        el.textContent = 'Hozir yangilanmoqda...';
        return;
    }
    if (iso) {
        const d = new Date(iso);
        el.textContent = 'Oxirgi: ' + d.toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
        return;
    }
    if (STATE.gpsLastSync) {
        el.textContent = 'Oxirgi: ' + new Date(STATE.gpsLastSync).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
        return;
    }
    el.textContent = 'Hali yangilanmagan';
}

async function pollServerGpsStatus(forceToday) {
    try {
        const d = await vmApi('/api/office/gps/status');
        updateGpsLastSyncUi(d.lastSync, d.running);
        if (d.running) setGpsUi('sync');
        else if (hasGpsConfig() || d.configured) setGpsUi('on');
        const today = dateStr(new Date());
        const dateToLoad = d.lastDate || d.syncDate || today;
        const ts = d.lastSync ? new Date(d.lastSync).getTime() : 0;
        const newer = ts > (STATE.serverGpsSyncTs || 0);
        if (!forceToday && !newer) return;
        if (ts) STATE.serverGpsSyncTs = ts;
        if (window.VMOffice) {
            await VMOffice.loadReportIfNeeded(dateToLoad, true);
            const viewDate = STATE.currentDate || today;
            if (viewDate !== dateToLoad) await VMOffice.loadReportIfNeeded(viewDate, false);
            renderCalendar();
            renderDriverTabs();
            refreshUI();
        }
    } catch (e) {
        console.warn('gps status:', e);
    }
}

async function syncFromGPS(dateVal, cfg, opts) {
    opts = opts || {};
    const silent = !!opts.silent;
    const skipDigest = !!opts.skipDigest;
    const force = !!opts.force || !silent;

    if (STATE.gpsSyncBusy && !force) return;

    STATE.gpsSyncGen = (STATE.gpsSyncGen || 0) + 1;
    const myGen = STATE.gpsSyncGen;
    const cancelled = () => STATE.gpsSyncGen !== myGen;
    STATE.gpsSyncBusy = true;

    const btn = document.getElementById('btn-gps-connect');
    if (btn && !silent) {
        btn.disabled = true;
        btn.textContent = 'Yuklanmoqda...';
    }

    const progWrap = document.getElementById('sync-progress');
    const progBar  = document.getElementById('sync-progress-bar');
    const statEl   = document.getElementById('sync-status');
    const detEl    = document.getElementById('sync-details');

    if (!silent && progWrap) progWrap.style.display = 'block';
    if (!silent && detEl) detEl.innerHTML = '';
    if (!silent && statEl) statEl.textContent = 'GPS serveriga ulanilmoqda...';

    const updateProg = (pct, msg, detail) => {
        if (silent) return;
        if (progBar) progBar.style.width = pct + '%';
        if (statEl)  statEl.textContent  = msg;
        if (detEl && detail) {
            const li = document.createElement('li');
            li.textContent = detail;
            detEl.appendChild(li);
            while (detEl.children.length > 40) detEl.removeChild(detEl.firstChild);
        }
    };

    try {
        updateProg(5, 'Server GPS dan yuklanmoqda...');
        setGpsUi('sync');
        let done = 0;
        let viaServer = false;
        try {
            const queued = await vmApi('/api/office/gps/sync', {
                method: 'POST',
                body: JSON.stringify({ date: dateVal })
            });
            const jobId = Number((queued && queued.jobId) || 0);
            if (!jobId) throw new Error((queued && queued.error) || 'Navbatga qo‘yilmadi');
            const t0 = Date.now();
            while (!cancelled() && Date.now() - t0 < 12 * 60 * 1000) {
                const st = await vmApi('/api/office/gps/status');
                updateGpsLastSyncUi(st.lastSync, st.running);
                updateProg(
                    Math.min(90, 8 + Math.round((Date.now() - t0) / 7000)),
                    st.message || 'Yuklanmoqda...',
                    ''
                );
                if (!st.running && Number(st.lastJobId || 0) >= jobId) {
                    if (st.error) throw new Error(st.error);
                    viaServer = true;
                    break;
                }
                await sleepMs(1500);
            }
            if (cancelled()) return;
            if (!viaServer) throw new Error('GPS yuklash vaqti tugadi. Qayta bosing.');
            if (window.VMOffice) await VMOffice.loadReportIfNeeded(dateVal, true);
            done = Object.keys(STATE.data[dateVal] || {}).length;
            updateProg(95, 'Hisobot olindi', done + ' ta mashina');
        } catch (serverErr) {
            if (cancelled()) return;
            if (viaServer) throw serverErr;
            const canBrowser = !!(cfg && (
                (cfg.password && String(cfg.password).trim()) ||
                (cfg.token && String(cfg.token).trim())
            ));
            if (!canBrowser || !window.wialonGPS) throw serverErr;
            updateProg(12, 'Brauzer orqali yuklanmoqda...', serverErr.message || '');
            const loginOk = await wialonGPS.login(cfg);
            if (cancelled()) return;
            if (!loginOk) throw new Error('Login amalga oshmadi. Login/parolni tekshiring.');
            setGpsUi('on');
            updateProg(15, 'Mashinalar ro\'yxati olinmoqda...');
            const units = await wialonGPS.getUnits();
            if (cancelled()) return;
            if (!units.length) throw new Error('GPS da mashinalar topilmadi.');
            for (let ui = 0; ui < units.length; ui++) {
            if (cancelled()) return;
            const unit = units[ui];
            const drv = findDriverByCar(unit.name) || findDriverByCar(unit.carNumber);
            if (!drv) {
                updateProg(0, '', `⏭ ${unit.name}: haydovchi ro'yxatida yo'q`);
                await sleepMs(0);
                continue;
            }
            try {
                updateProg(15 + Math.round((ui / units.length) * 80), `Yuklanmoqda: ${unit.name} (${drv.shortName})`);
                const chrono = await wialonGPS.getUnitChronology(unit.id, dateVal);
                if (cancelled()) return;
                const rawStops = (chrono && chrono.stops) ? chrono.stops : [];
                const stops = enrichStops(rawStops, drv.car);
                const stats = Object.assign({
                    probeg: 0, maxSpeed: 0, avgSpeed: 0, poezdok: 0, stoyanok: stops.length,
                    gas: 0, benzin: 0, motoChas: '—', totalStop: '—'
                }, (chrono && chrono.stats) || {});
                if (!stats.stoyanok) stats.stoyanok = stops.length;
                const analysis = analyzeData(stops, drv.car, stats, dateVal);
                if (!STATE.data[dateVal]) STATE.data[dateVal] = {};
                STATE.data[dateVal][drv.car] = { car: drv.car, driver: drv, date: dateVal, stats, stops, analysis };
                if (!STATE.history.includes(dateVal)) STATE.history.push(dateVal);
                updateProg(0, '', `✅ ${unit.name}: ${stops.length} ta to'xtash, ${fmtKm(stats.probeg, 'km')}`);
                done++;
            } catch(e) {
                if (cancelled()) return;
                console.error("Xato:", e);
                updateProg(0, '', `⚠️ ${unit.name}: ${e.message}`);
            }
            await sleepMs(0);
        }
        }

        if (cancelled()) return;
        STATE.currentDate = dateVal;
        if (!STATE.currentCar && done) {
            const first = Object.keys(STATE.data[dateVal] || {})[0];
            if (first) STATE.currentCar = first;
        }
        const d = new Date(dateVal); CAL.y = d.getFullYear(); CAL.m = d.getMonth();
        saveAll();
        renderCalendar(); renderDriverTabs(); refreshUI();
        if (window.VMOffice) {
            VMOffice.renderFleetBoard();
            await VMOffice.saveReport(dateVal);
            if (cancelled()) return;
            if (!skipDigest) VMOffice.sendDigest(dateVal);
        }

        if (cancelled()) return;

        if (done > 0) {
            STATE.gpsLastSync = Date.now();
            updateGpsLastSyncUi();
            await saveGpsConfigToServer(cfg);
            startGpsAutoSync();
            if (!silent) {
                showToast(`GPS dan ${dateVal} uchun ${done} ta mashina yuklandi`, 'success');
                document.getElementById('modal-gps').classList.remove('open');
            }
        } else if (!silent) {
            showToast('GPS ulandi, lekin saqlanadigan ma\'lumot chiqmadi. Tafsilotni modalda ko\'ring.', 'warn');
            document.getElementById('modal-gps').classList.add('open');
        }

    } catch(e) {
        if (cancelled()) return;
        if (!silent) showToast('GPS xatosi: ' + e.message, 'error');
        if (!silent && statEl) statEl.textContent = 'Xato: ' + e.message;
        setGpsUi(hasGpsConfig() ? 'on' : 'off');
    } finally {
        if (STATE.gpsSyncGen === myGen) {
            STATE.gpsSyncBusy = false;
            if (btn && !silent) {
                btn.disabled = false;
                btn.textContent = 'Shu kunni yuklash';
            }
            if (!silent) setGpsUi(hasGpsConfig() ? 'on' : 'off');
        }
    }
}

function pdfDateLabel(ds) {
    const d = new Date(ds + 'T00:00:00');
    return `${d.getDate()} ${UZ_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function pdfStopStatus(st, carKey, dateVal) {
    const day = dateVal || STATE.currentDate;
    const car = carKey || STATE.currentCar;
    const rev = window.VMOffice ? VMOffice.reviewOf(day, car, st) : null;
    if (rev && rev.status === 'allowed') return 'Ruxsat';
    if (rev && rev.status === 'violation') return 'Qoidabuzarlik';
    if (st.isOffice) return 'Ofis';
    if (st.isOutside) return 'Tashqari';
    if (stopIsProblem(st, car, day)) return 'Muammo';
    if (st.matchType === 'own') return 'Dorixona';
    if (st.matchType === 'other') return 'Boshqa';
    return '—';
}

function collectDayEntries(dayData) {
    const used = new Set();
    const list = [];
    const keyOf = p => (typeof fleetPlateKey === 'function' ? fleetPlateKey(p) : String(p || '').replace(/\s+/g, '').toUpperCase());
    DRIVERS.forEach(drv => {
        let rec = null;
        let hitKey = null;
        if (dayData[drv.car]) {
            rec = dayData[drv.car];
            hitKey = drv.car;
        } else {
            const want = keyOf(drv.car);
            hitKey = Object.keys(dayData).find(k => keyOf(k) === want) || null;
            if (hitKey) rec = dayData[hitKey];
        }
        if (rec) {
            if (rec.driver) rec.driver = (typeof resolveDriver === 'function') ? resolveDriver(drv.car, rec.driver) : rec.driver;
            list.push({ drv: (typeof resolveDriver === 'function') ? resolveDriver(drv.car, drv) : drv, data: rec });
            used.add(keyOf(drv.car));
            if (hitKey) used.add(keyOf(hitKey));
        }
    });
    Object.keys(dayData).forEach(car => {
        if (used.has(keyOf(car))) return;
        const d = dayData[car];
        const drv = (typeof resolveDriver === 'function')
          ? resolveDriver(car, (d && d.driver) || null)
          : ((d && d.driver) || { fullName: car, shortName: car, car, routes: '—' });
        list.push({ drv, data: d });
        used.add(keyOf(car));
    });
    return list;
}

function abToB64(buf) {
    const bytes = new Uint8Array(buf);
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
}

let VM_PDF_FONTS = null;
let VM_PDF_FONT = 'helvetica';

async function fetchFontBuf(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error('font ' + r.status);
    return r.arrayBuffer();
}

async function loadPdfFonts() {
    if (VM_PDF_FONTS) return VM_PDF_FONTS;
    const pairs = [
        ['fonts/NotoSans-Regular.ttf', 'fonts/NotoSans-Bold.ttf'],
        [
            'https://cdn.jsdelivr.net/gh/googlefonts/noto-fonts@main/hinted/ttf/NotoSans/NotoSans-Regular.ttf',
            'https://cdn.jsdelivr.net/gh/googlefonts/noto-fonts@main/hinted/ttf/NotoSans/NotoSans-Bold.ttf'
        ]
    ];
    for (const [regUrl, boldUrl] of pairs) {
        try {
            const [reg, bold] = await Promise.all([fetchFontBuf(regUrl), fetchFontBuf(boldUrl)]);
            VM_PDF_FONTS = { regular: abToB64(reg), bold: abToB64(bold) };
            return VM_PDF_FONTS;
        } catch (e) {
            console.warn('PDF shrift:', e);
        }
    }
    return null;
}

function applyPdfFont(doc, fonts) {
    if (!fonts) {
        VM_PDF_FONT = 'helvetica';
        doc.setFont('helvetica', 'normal');
        return;
    }
    doc.addFileToVFS('NotoSans-Regular.ttf', fonts.regular);
    doc.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal');
    doc.addFileToVFS('NotoSans-Bold.ttf', fonts.bold);
    doc.addFont('NotoSans-Bold.ttf', 'NotoSans', 'bold');
    doc.setFont('NotoSans', 'normal');
    VM_PDF_FONT = 'NotoSans';
}

function pdfF(doc, style) {
    doc.setFont(VM_PDF_FONT, style || 'normal');
}

function pdfAnalysis(d) {
    const a = (d && d.analysis) || {};
    const sc = a.score || {};
    return {
        ownVisited: a.ownVisited || 0,
        totalOwn: a.totalOwn || 0,
        otherDirection: a.otherDirection || 0,
        problemStops: a.problemStops || 0,
        outsideCity: a.outsideCity || 0,
        missedList: Array.isArray(a.missedList) ? a.missedList : [],
        score: {
            final: (sc.final != null && !isNaN(Number(sc.final))) ? Number(sc.final) : 0,
            grade: sc.grade || '—',
            breakdown: Array.isArray(sc.breakdown) ? sc.breakdown : [],
            recommendations: Array.isArray(sc.recommendations) ? sc.recommendations : []
        }
    };
}

function pdfDrawHeader(doc, line2) {
    doc.setFillColor(12, 16, 22);
    doc.rect(0, 0, 210, 26, 'F');
    doc.setFillColor(201, 162, 39);
    doc.rect(0, 26, 210, 1.6, 'F');
    doc.setTextColor(244, 244, 242);
    pdfF(doc, 'bold');
    doc.setFontSize(9);
    doc.text('VAKSINAMED FLEET CONTROL', 12, 10);
    pdfF(doc, 'normal');
    doc.setFontSize(8);
    doc.setTextColor(201, 162, 39);
    doc.text('GPS MONITORING  ·  WIALON', 12, 16);
    if (line2) {
        doc.setTextColor(180, 186, 194);
        doc.setFontSize(8);
        doc.text(String(line2), 198, 16, { align: 'right' });
    }
}

function pdfDrawFooter(doc, dateVal) {
    const n = doc.internal.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
        doc.setPage(i);
        doc.setFillColor(243, 244, 246);
        doc.rect(0, 287, 210, 10, 'F');
        pdfF(doc, 'normal');
        doc.setFontSize(7);
        doc.setTextColor(92, 101, 115);
        doc.text('VaksinaMed  ·  ichki hisobot  ·  ' + dateVal, 12, 293);
        doc.text(i + ' / ' + n, 198, 293, { align: 'right' });
    }
}

function pdfSectionTitle(doc, y, title) {
    pdfF(doc, 'bold');
    doc.setFontSize(8);
    doc.setTextColor(18, 21, 28);
    doc.text(String(title).toUpperCase(), 12, y);
    doc.setDrawColor(201, 162, 39);
    doc.setLineWidth(0.45);
    doc.line(12, y + 1.6, 198, y + 1.6);
    return y + 7;
}

function pdfNeedPage(doc, y, need, dateLabel) {
    if (y + need < 276) return y;
    doc.addPage();
    pdfDrawHeader(doc, dateLabel);
    return 34;
}

function pdfTable(doc, dateLabel, opts) {
    const merged = Object.assign({
        theme: 'plain',
        styles: {
            font: VM_PDF_FONT,
            fontSize: 8,
            textColor: [18, 21, 28],
            cellPadding: 2,
            overflow: 'linebreak',
            lineColor: [220, 224, 230],
            lineWidth: 0.1
        },
        headStyles: {
            fillColor: [12, 16, 22],
            textColor: [244, 244, 242],
            fontStyle: 'bold',
            fontSize: 7.5,
            font: VM_PDF_FONT,
            cellPadding: 2.2
        },
        alternateRowStyles: { fillColor: [247, 248, 250] },
        margin: { left: 12, right: 12, top: 32, bottom: 16 },
        didDrawPage: function () { pdfDrawHeader(doc, dateLabel); }
    }, opts);
    if (typeof doc.autoTable === 'function') {
        doc.autoTable(merged);
        return doc.lastAutoTable.finalY;
    }
    let y = opts.startY || 40;
    const all = [];
    if (opts.head && opts.head[0]) all.push(opts.head[0]);
    (opts.body || []).forEach(r => all.push(r));
    pdfF(doc, 'normal');
    doc.setFontSize(8);
    doc.setTextColor(18, 21, 28);
    all.forEach(r => {
        y = pdfNeedPage(doc, y, 6, dateLabel);
        const line = (r || []).map(c => String(c == null || c === '' ? '—' : c)).join('   ·   ');
        const wrapped = doc.splitTextToSize(line, 186);
        doc.text(wrapped, 12, y);
        y += wrapped.length * 4.2 + 1.5;
    });
    return y;
}

async function syncReportsToServer(dates) {
    const list = dates || STATE.history || Object.keys(STATE.data);
    let ok = 0, fail = 0;
    for (const dateVal of list) {
        const cars = STATE.data[dateVal];
        if (!cars || !Object.keys(cars).length) continue;
        try {
            await vmApi('/api/office/report', {
                method: 'POST',
                body: JSON.stringify({ date: dateVal, cars })
            });
            ok++;
        } catch (e) {
            fail++;
            console.warn('server sync', dateVal, e);
        }
    }
    return { ok, fail };
}

function exportDayExcel() {
    const dateVal = STATE.currentDate;
    const dayData = dateVal && STATE.data[dateVal];
    if (!dayData || !Object.keys(dayData).length) {
        showToast('Avval GPS yoki Excel orqali kun ma\'lumotini yuklang', 'warn');
        return;
    }
    if (typeof XLSX === 'undefined') {
        showToast('Excel kutubxonasi yuklanmadi', 'error');
        return;
    }
    const wb = XLSX.utils.book_new();
    const summary = [['Haydovchi', 'Raqam', 'Km', 'Max tezlik', 'Ball', 'Dorixona', 'Muammo', 'Ish vaqti']];
    const entries = collectDayEntries(dayData);
    entries.forEach(({ drv, data }) => {
        const a = data.analysis || {};
        const sc = a.score || {};
        const st = data.stats || {};
        summary.push([
            drv.shortName || drv.fullName,
            drv.car,
            st.probeg || 0,
            st.maxSpeed || 0,
            sc.final != null ? sc.final : '',
            `${a.ownVisited || 0}/${a.totalOwn || 0}`,
            a.problemStops || 0,
            st.motoChas || ''
        ]);
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Jamlanma');
    entries.forEach(({ drv, data }, idx) => {
        const rows = [['Vaqt', 'Joy', 'Davomiylik', 'Turi', 'Muammo']];
        (data.stops || []).forEach(st => {
            rows.push([
                st.inTime || '',
                st.place || '',
                st.duration || '',
                st.matchType || '',
                stopIsProblem(st, drv.car, dateVal) ? 'ha' : ''
            ]);
        });
        let sheetName = String(drv.car || ('m' + idx)).replace(/\s+/g, '_').slice(0, 31);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName);
    });
    XLSX.writeFile(wb, 'vhk_' + dateVal + '.xlsx');
    showToast('Excel yuklab olindi', 'success');
}

async function downloadPdfReport() {
    const dateVal = STATE.currentDate;
    const dayData = dateVal && STATE.data[dateVal];
    if (!dayData || !Object.keys(dayData).length) {
        showToast('Avval GPS yoki Excel orqali kun ma\'lumotini yuklang', 'warn');
        return;
    }
    const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!JsPDF) {
        showToast('PDF moduli yuklanmadi. Sahifani yangilang (Ctrl+F5).', 'error');
        return;
    }

    const btn = document.getElementById('btn-print');
    if (btn) btn.disabled = true;
    showToast('PDF tayyorlanmoqda...', 'info');

    try {
        const fonts = await loadPdfFonts();
        const entries = collectDayEntries(dayData);
        if (!entries.length) {
            showToast('Bu kunda chiqarish uchun ma\'lumot yo\'q', 'warn');
            return;
        }

        const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
        applyPdfFont(doc, fonts);

        const dateLabel = pdfDateLabel(dateVal);
        const totalKm = roundKm(entries.reduce((s, x) => s + ((x.data.stats && x.data.stats.probeg) || 0), 0));
        const avgScore = entries.length
            ? (entries.reduce((s, x) => s + pdfAnalysis(x.data).score.final, 0) / entries.length)
            : 0;
        const problems = entries.reduce((s, x) => s + pdfAnalysis(x.data).problemStops, 0);
        const ownOk = entries.reduce((s, x) => {
            const a = pdfAnalysis(x.data);
            return s + a.ownVisited;
        }, 0);

        // ── COVER ──────────────────────────────────────────
        pdfDrawHeader(doc, dateLabel);
        pdfF(doc, 'bold');
        doc.setFontSize(20);
        doc.setTextColor(18, 21, 28);
        doc.text('Kunlik GPS hisobot', 12, 42);
        pdfF(doc, 'normal');
        doc.setFontSize(11);
        doc.setTextColor(42, 48, 58);
        doc.text(dateLabel, 12, 50);
        pdfF(doc, 'bold');
        doc.setFontSize(8);
        doc.setTextColor(201, 162, 39);
        doc.text('KETMA-KET  ·  ' + entries.length + ' ta mashina', 198, 50, { align: 'right' });

        const boxes = [
            ['MASHINA', String(entries.length)],
            ['JAMI MASOFA', fmtKm(totalKm, 'km')],
            ["O'RTACHA BALL", avgScore.toFixed(1) + ' / 10'],
            ['MUAMMO', String(problems)]
        ];
        boxes.forEach((b, i) => {
            const x = 12 + i * 48;
            doc.setFillColor(243, 244, 246);
            doc.setDrawColor(183, 190, 200);
            doc.rect(x, 56, 45, 20, 'FD');
            doc.setFillColor(201, 162, 39);
            doc.rect(x, 56, 45, 1.1, 'F');
            pdfF(doc, 'bold');
            doc.setFontSize(6.5);
            doc.setTextColor(92, 101, 115);
            doc.text(b[0], x + 3, 63);
            doc.setFontSize(12);
            doc.setTextColor(18, 21, 28);
            doc.text(b[1], x + 3, 71);
        });

        pdfF(doc, 'normal');
        doc.setFontSize(8);
        doc.setTextColor(92, 101, 115);
        doc.text('Jami o\'z dorixonalariga borish: ' + ownOk + ' ta to\'xtash', 12, 82);

        pdfTable(doc, dateLabel, {
            startY: 86,
            head: [['#', 'Haydovchi', 'Mashina', 'Km', 'Dorixona', 'Muammo', 'Ball', 'Baho']],
            body: entries.map((x, i) => {
                const a = pdfAnalysis(x.data);
                const st = x.data.stats || {};
                return [
                    String(i + 1),
                    x.drv.fullName || x.drv.shortName || '—',
                    x.drv.car || '—',
                    fmtKm(st.probeg),
                    a.ownVisited + '/' + a.totalOwn,
                    String(a.problemStops),
                    a.score.final.toFixed(1),
                    a.score.grade
                ];
            }),
            columnStyles: {
                0: { cellWidth: 10, halign: 'center' },
                3: { halign: 'right' },
                4: { halign: 'center' },
                5: { halign: 'center' },
                6: { halign: 'right', fontStyle: 'bold' },
                7: { halign: 'center' }
            }
        });

        // ── EACH DRIVER ────────────────────────────────────
        entries.forEach((x, idx) => {
            const d = x.data || {};
            const a = pdfAnalysis(d);
            const s = d.stats || {};
            const stops = Array.isArray(d.stops) ? d.stops : [];
            const fuel = [
                s.gas > 0 ? fmtFuel(s.gas, 'm3') : '',
                s.benzin > 0 ? fmtFuel(s.benzin, 'L') : ''
            ].filter(Boolean).join(' + ') || '—';

            doc.addPage();
            pdfDrawHeader(doc, (idx + 1) + ' / ' + entries.length + '   ·   ' + dateLabel);

            doc.setFillColor(12, 16, 22);
            doc.rect(12, 32, 186, 20, 'F');
            doc.setFillColor(201, 162, 39);
            doc.rect(12, 32, 2.2, 20, 'F');
            pdfF(doc, 'bold');
            doc.setFontSize(13);
            doc.setTextColor(244, 244, 242);
            doc.text(String(x.drv.fullName || x.drv.shortName || 'Haydovchi'), 18, 41);
            pdfF(doc, 'normal');
            doc.setFontSize(8);
            doc.setTextColor(201, 162, 39);
            doc.text((x.drv.car || '') + '   ·   ' + (x.drv.routes || '—'), 18, 48);

            pdfF(doc, 'bold');
            doc.setFontSize(18);
            doc.setTextColor(244, 244, 242);
            doc.text(a.score.final.toFixed(1), 190, 42, { align: 'right' });
            pdfF(doc, 'normal');
            doc.setFontSize(6.5);
            doc.setTextColor(201, 162, 39);
            doc.text('BALL / 10  ·  ' + a.score.grade, 190, 48, { align: 'right' });

            const kpis = [
                ['MASOFA', fmtKm(s.probeg, 'km')],
                ['DORIXONA', a.ownVisited + '/' + a.totalOwn],
                ['BOSHQA YONALISH', String(a.otherDirection)],
                ['MUAMMO', String(a.problemStops)],
                ['MAKS. TEZLIK', fmtSpd(s.maxSpeed, 'km/h')],
                ["YOQILG'I", fuel]
            ];
            kpis.forEach((k, i) => {
                const col = i % 3, row = Math.floor(i / 3);
                const x0 = 12 + col * 62, y0 = 56 + row * 16;
                doc.setDrawColor(183, 190, 200);
                doc.setFillColor(255, 255, 255);
                doc.rect(x0, y0, 60, 14, 'FD');
                doc.setFillColor(26, 74, 120);
                doc.rect(x0, y0, 1.6, 14, 'F');
                pdfF(doc, 'bold');
                doc.setFontSize(6);
                doc.setTextColor(92, 101, 115);
                doc.text(k[0], x0 + 4, y0 + 5);
                doc.setFontSize(10);
                doc.setTextColor(18, 21, 28);
                doc.text(String(k[1]), x0 + 4, y0 + 11);
            });

            let y = pdfSectionTitle(doc, 92, '1. Harakat korsatkichlari');
            y = pdfTable(doc, dateLabel, {
                startY: y,
                body: [
                    ['Yurilgan masofa', fmtKm(s.probeg, 'km')],
                    ['Ish vaqti / motochas', s.motoChas || '—'],
                    ["O'rtacha tezlik", s.avgSpeed ? fmtSpd(s.avgSpeed, 'km/h') : (s.probeg && s.motoChas && s.motoChas !== '—' ? fmtSpd(s.probeg / Math.max(parseTimeStr(s.motoChas)/3600, 0.1), 'km/h') : '—')],
                    ['Poezdka soni', String(s.poezdok || 0)],
                    ["To'xtash soni", String(s.stoyanok || stops.length || 0)],
                    ["To'xtab turgan vaqt", s.totalStop || '—'],
                    ['Maksimal tezlik', fmtSpd(s.maxSpeed, 'km/h')],
                    ["Yoqilg'i", fuel]
                ],
                head: [['Kursatkich', 'Qiymat']],
                columnStyles: {
                    0: { cellWidth: 80, textColor: [92, 101, 115] },
                    1: { fontStyle: 'bold' }
                },
                alternateRowStyles: { fillColor: [247, 248, 250] }
            });

            y = pdfNeedPage(doc, y + 8, 20, dateLabel);
            y = pdfSectionTitle(doc, y, "2. Dorixona tahlili");
            const missed = a.missedList.length ? a.missedList : ["Yo'q — barcha o'z dorixonalariga borilgan yoki royxat yo'q"];
            const visited = stops.filter(t => t.matchType === 'own')
                .map(t => (t.phName || t.place || '—') + (t.inTime ? '  (' + t.inTime + (t.duration ? ', ' + t.duration : '') + ')' : ''));
            const probs = stops.filter(t => stopIsProblem(t, x.drv.car, dateVal))
                .map(t => (t.place || '—') + (t.duration ? '  (' + t.duration + ')' : ''));
            const vis = visited.length ? visited : ["Yo'q"];
            const pr = probs.length ? probs : ["Yo'q"];
            const nPh = Math.max(missed.length, vis.length, pr.length, 1);
            const phRows = [];
            for (let i = 0; i < nPh; i++) phRows.push([missed[i] || '', vis[i] || '', pr[i] || '']);
            y = pdfTable(doc, dateLabel, {
                startY: y,
                head: [["O'tkazib yuborilgan", 'Borilgan (vaqt)', 'Muammoli toxtash']],
                body: phRows,
                styles: { font: VM_PDF_FONT, fontSize: 7.5, cellPadding: 1.7, overflow: 'linebreak' }
            });

            if (a.score.breakdown.length) {
                y = pdfNeedPage(doc, y + 8, 20, dateLabel);
                y = pdfSectionTitle(doc, y, '3. Ball hisobi');
                y = pdfTable(doc, dateLabel, {
                    startY: y,
                    head: [['Tafsilot']],
                    body: a.score.breakdown.map(line => [String(line).replace(/[✅🏆⚠️❌]/g, '').trim()]),
                    columnStyles: { 0: { cellWidth: 186 } }
                });
            }

            y = pdfNeedPage(doc, y + 8, 24, dateLabel);
            y = pdfSectionTitle(doc, y, "4. Barcha to'xtashlar — ketma-ket");
            const stopBody = stops.map((t, i) => [
                String(i + 1),
                t.place || '—',
                t.phName && t.phName !== t.place ? t.phName : (t.matchType === 'own' ? (t.phName || '') : ''),
                t.inTime || '—',
                t.outTime || '—',
                t.duration || '—',
                pdfStopStatus(t, x.drv.car, dateVal)
            ]);
            y = pdfTable(doc, dateLabel, {
                startY: y,
                head: [['№', 'Joy / manzil', 'Dorixona', 'Kirish', 'Chiqish', 'Turgani', 'Holat']],
                body: stopBody.length ? stopBody : [['—', "To'xtash yo'q", '', '—', '—', '—', '—']],
                styles: { font: VM_PDF_FONT, fontSize: 7, cellPadding: 1.5, overflow: 'linebreak' },
                columnStyles: {
                    0: { cellWidth: 10, halign: 'center' },
                    1: { cellWidth: 58 },
                    2: { cellWidth: 36 },
                    3: { cellWidth: 20 },
                    4: { cellWidth: 20 },
                    5: { cellWidth: 22 },
                    6: { cellWidth: 20 }
                }
            });

            const recs = (a.score.recommendations || [])
                .map(r => String(r).replace(/[✅🏆⚠️❌]/g, '').trim())
                .filter(Boolean);
            if (recs.length) {
                y = pdfNeedPage(doc, y + 8, 18, dateLabel);
                y = pdfSectionTitle(doc, y, '5. Xulosa va tavsiyalar');
                pdfF(doc, 'normal');
                doc.setFontSize(8.5);
                doc.setTextColor(42, 48, 58);
                recs.forEach((r, i) => {
                    const lines = doc.splitTextToSize((i + 1) + '.  ' + r, 186);
                    y = pdfNeedPage(doc, y, lines.length * 4.5 + 2, dateLabel);
                    doc.text(lines, 12, y);
                    y += lines.length * 4.5 + 1.5;
                });
            }
        });

        pdfDrawFooter(doc, dateVal);
        const fname = 'VaksinaMed_' + dateVal + '.pdf';
        const blob = doc.output('blob');
        if (!blob || blob.size < 800) {
            throw new Error('PDF fayl bo\'sh chiqdi. Ctrl+F5 qilib qayta urinib koring.');
        }
        doc.save(fname);
        showToast('PDF saqlandi: ' + fname + '  (' + entries.length + ' mashina)', 'success');
    } catch (err) {
        console.error(err);
        showToast('PDF xato: ' + (err.message || err), 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
}

// ── 12. BARCHA EVENT HANDLER'LAR ────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const user = await vmMe();
        vmApplyChrome(user);
        vmGatePage(user);
        vmStartHeartbeat();
        document.getElementById('btn-logout')?.addEventListener('click', () => vmLogout());
    } catch (e) {
        return;
    }

    // Dorixona indeksini qurish
    buildPharmIndex();

    // Saqlangan ma'lumotlarni yuklash
    loadAll();

    // Haydovchini tanlash
    if (!STATE.currentCar) STATE.currentCar = DRIVERS[0].car;
    if (!STATE.currentDate) {
        STATE.currentDate = dateStr(new Date());
    }

    if (window.VMOffice) {
        await VMOffice.bootstrap();
        if (typeof listenFleetNameOverrides === 'function') {
            listenFleetNameOverrides(() => {
                if (typeof buildPharmIndex === 'function') buildPharmIndex();
                if (typeof renderDriverTabs === 'function') renderDriverTabs();
                if (window.VMOffice && typeof VMOffice.renderFleetBoard === 'function') VMOffice.renderFleetBoard();
                if (typeof renderFuelNormsTable === 'function') renderFuelNormsTable();
                if (typeof refreshUI === 'function') refreshUI();
            });
        }
        recomputeDay(STATE.currentDate);
    }

    // Xaritani ishga tushirish
    initMap();

    // Kalendarni ko'rsatish
    renderCalendar();
    renderDriverTabs();
    refreshUI();
    setGpsUi(hasGpsConfig() ? 'on' : 'off');
    refreshDayKm(STATE.currentDate);
    
    // ── Avtomatik GPS (server + brauzer, kun davomida) ───────────────
    setTimeout(async () => {
        const todayStr = dateStr(new Date());
        let serverGps = false;
        try {
            const st = await vmApi('/api/office/gps/status');
            serverGps = !!st.configured;
            updateGpsLastSyncUi(st.lastSync, st.running);
            if (serverGps || hasGpsConfig()) setGpsUi('on');
        } catch (e) {}
        await pollServerGpsStatus(true);
        startGpsAutoSync();
        if (!hasGpsConfig() && serverGps) {
            showToast('Server GPS avtomatik yangilayapti — brauzer yopiq bo\'lsa ham ishlaydi', 'info');
        }
    }, 1500);

    // ── Kalendar navigatsiya ───────────────────────────────
    document.getElementById('cal-prev')?.addEventListener('click', () => {
        CAL.m--; if (CAL.m < 0) { CAL.m = 11; CAL.y--; }
        renderCalendar();
    });
    document.getElementById('cal-next')?.addEventListener('click', () => {
        CAL.m++; if (CAL.m > 11) { CAL.m = 0; CAL.y++; }
        renderCalendar();
    });

    // ── Fayl yuklash ──────────────────────────────────────
    const fileInput = document.getElementById('file-input');
    fileInput?.addEventListener('change', e => {
        if (e.target.files.length) handleFileDrop(e.target.files);
        e.target.value = '';
    });

    // ── Excel tugmalari ───────────────────────────────────
    document.getElementById('btn-excel-upload')?.addEventListener('click',   () => fileInput?.click());
    document.getElementById('btn-excel-upload-2')?.addEventListener('click', () => fileInput?.click());
    document.getElementById('btn-excel-export')?.addEventListener('click', () => exportDayExcel());

    // ── GPS modal ─────────────────────────────────────────
    const openGpsModal = async () => {
        const host = document.getElementById('gps-host');
        const user = document.getElementById('gps-user');
        const tok  = document.getElementById('gps-token');
        const dt   = document.getElementById('gps-date');
        const pass = document.getElementById('gps-password');
        let cfg = STATE.gpsConfig || {};

        try {
            const pub = await vmApi('/api/office/gps/config');
            cfg = Object.assign({}, gpsConfigSafe(cfg), {
                host: pub.host || cfg.host || '',
                user: pub.user || cfg.user || '',
                hasToken: !!pub.hasToken,
                hasPassword: !!pub.hasPassword,
                serverConfigured: !!pub.configured
            });
            STATE.gpsConfig = cfg;
            saveAll();
        } catch (e) {}

        if (host) host.value = cfg.host || 'http://bms1.gpsavto.uz';
        if (user) user.value = cfg.user || '';
        // Parol/token hech qachon forma maydoniga to'ldirilmaydi
        if (tok) {
            tok.value = '';
            tok.placeholder = cfg.hasToken ? 'Saqlangan — o‘zgartirmasangiz qoladi' : 'Wialon token';
        }
        if (pass) {
            pass.value = '';
            pass.placeholder = cfg.hasPassword ? 'Saqlangan — o‘zgartirmasangiz qoladi' : '••••••••';
        }
        
        const todayStr = dateStr(new Date());
        if (dt) dt.value = STATE.currentDate || todayStr;

        document.getElementById('sync-progress').style.display = 'none';
        document.getElementById('sync-details').innerHTML = '';
        document.getElementById('sync-status').textContent = '';
        document.getElementById('modal-gps').classList.add('open');
    };
    document.getElementById('btn-gps-sync')?.addEventListener('click',   () => openGpsModal());
    document.getElementById('btn-gps-sync-2')?.addEventListener('click', () => {
        if (hasGpsConfig() && STATE.gpsConfig && STATE.currentDate) {
            showToast('GPS dan aniq km yuklanmoqda...', 'info');
            syncFromGPS(STATE.currentDate, STATE.gpsConfig);
            return;
        }
        openGpsModal();
    });

    const yday = () => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return dateStr(d);
    };
    document.getElementById('gps-date-yesterday')?.addEventListener('click', () => {
        const el = document.getElementById('gps-date');
        if (el) el.value = yday();
    });
    document.getElementById('gps-date-today')?.addEventListener('click', () => {
        const el = document.getElementById('gps-date');
        if (el) el.value = dateStr(new Date());
    });

    // Modal ichida sozlamalarni ochish (majburiy ochish uchun headerdagi ikonka orqali yozsa bo'ladi, biz ulanish tugmasiga e'tibor qaratamiz)

    // GPS ulanish tugmasi
    document.getElementById('btn-gps-connect')?.addEventListener('click', async () => {
        const host  = document.getElementById('gps-host')?.value.trim();
        const user  = document.getElementById('gps-user')?.value.trim();
        const pass  = document.getElementById('gps-password')?.value.trim();
        const token = (document.getElementById('gps-token')?.value || '').replace(/\s+/g, '').trim();
        const date  = document.getElementById('gps-date')?.value;
        const prev = STATE.gpsConfig || {};
        if (!date) { showToast('Sanani kiriting!', 'warn'); return; }
        if (!user && !token && !prev.hasToken && !prev.hasPassword) {
            showToast('Login yoki Token kiriting!', 'warn');
            return;
        }
        if (user && !pass && !token && !prev.hasPassword && !prev.hasToken) {
            showToast('Parol yoki token kiriting!', 'warn');
            return;
        }

        // Maxfiy maydonlar faqat serverga yuboriladi, localStorage ga yozilmaydi
        const forServer = { host, user, password: pass || '', token: token || '' };
        try {
            await saveGpsConfigToServer(forServer);
        } catch (e) {}
        // Brauzer fallback uchun shu sessiyadagi login ma'lumotini beramiz
        await syncFromGPS(date, forServer, { force: true });
    });

    // ── Chop etish / PDF ──────────────────────────────────
    document.getElementById('btn-print')?.addEventListener('click', () => {
        downloadPdfReport();
    });

    // ── Sozlamalar modal ──────────────────────────────────
    document.getElementById('btn-settings')?.addEventListener('click', () => {
        renderFuelNormsTable();
        document.getElementById('modal-settings').classList.add('open');
    });

    // Yoqilg'i normalarini saqlash
    document.getElementById('btn-save-settings')?.addEventListener('click', () => {
        document.querySelectorAll('[data-fuel-car]').forEach(row => {
            const car   = row.dataset.fuelCar;
            const gas   = parseFloat(row.querySelector('.fuel-gas')?.value) || 14;
            const ben   = parseFloat(row.querySelector('.fuel-ben')?.value) || 12;
            if (!STATE.fuelNorms[car]) STATE.fuelNorms[car] = {};
            STATE.fuelNorms[car].gas    = gas;
            STATE.fuelNorms[car].benzin = ben;
        });
        saveAll();
        showToast('✅ Sozlamalar saqlandi!', 'success');
        document.getElementById('modal-settings').classList.remove('open');
    });

    // ── Export JSON ───────────────────────────────────────
    document.getElementById('btn-export-json')?.addEventListener('click', () => {
        const payload = JSON.stringify({
            data: STATE.data,
            history: STATE.history,
            fuelNorms: STATE.fuelNorms,
            gpsConfig: gpsConfigSafe(STATE.gpsConfig)
        }, null, 2);
        const blob = new Blob([payload], { type: 'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url;
        a.download = `vaksinamed_backup_${dateStr(new Date())}.json`;
        a.click(); URL.revokeObjectURL(url);
        showToast('📤 Zaxira fayl yuklab olindi!', 'success');
    });

    // ── Import JSON ───────────────────────────────────────
    const importInput = document.getElementById('import-input');
    document.getElementById('btn-import-json')?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', e => {
        const file = e.target.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = async ev => {
            try {
                const p = JSON.parse(ev.target.result);
                if (p.data || p.driverData) {
                    const d = p.data || p.driverData || {};
                    Object.assign(STATE.data, d);
                    const dates = p.history || Object.keys(d);
                    dates.forEach(dt => {
                        if (!STATE.history.includes(dt)) STATE.history.push(dt);
                    });
                    if (p.fuelNorms) STATE.fuelNorms = p.fuelNorms;
                    if (p.gpsConfig) STATE.gpsConfig = gpsConfigSafe(p.gpsConfig);
                    saveAll();
                    renderCalendar();
                    renderDriverTabs();
                    refreshUI();
                    showToast('Zaxira yuklandi, serverga sinxronlanmoqda...', 'info');
                    const sync = await syncReportsToServer(dates);
                    showToast(`Zaxira: ${dates.length} kun · server ${sync.ok} ta`, sync.fail ? 'warn' : 'success');
                } else { showToast('Fayl formati noto\'g\'ri!', 'error'); }
            } catch(err) { showToast('JSON o\'qib bo\'lmadi: ' + err.message, 'error'); }
        };
        reader.readAsText(file);
        e.target.value = '';
    });

    // ── Ma'lumotlarni o'chirish ───────────────────────────
    document.getElementById('btn-clear-data')?.addEventListener('click', () => {
        if (confirm('⚠️ Barcha saqlangan ma\'lumotlar o\'chiriladi. Davom etasizmi?')) {
            localStorage.removeItem('vm_gps_v3');
            STATE.data = {}; STATE.history = [];
            STATE.currentDate = dateStr(new Date());
            const now = new Date(); CAL.y = now.getFullYear(); CAL.m = now.getMonth();
            renderCalendar(); renderDriverTabs(); refreshUI();
            showToast('🗑️ Barcha ma\'lumotlar tozalandi.', 'warn');
            document.getElementById('modal-settings').classList.remove('open');
        }
    });

    // ── Xaritani yangilash ────────────────────────────────
    document.getElementById('btn-refresh-map')?.addEventListener('click', () => {
        initMap();
        const dd = STATE.currentDate && STATE.data[STATE.currentDate]
            ? STATE.data[STATE.currentDate][STATE.currentCar]
            : null;
        refreshMap(dd && dd.stops ? dd.stops : null);
        if (dd && dd.stops && dd.stops.length) showToast('Xarita yangilandi', 'info');
        else showToast('Xarita ochildi. To\'xtashlar uchun avval GPS yuklang.', 'info');
    });

    // ── Drag & Drop ───────────────────────────────────────
    const overlay = document.getElementById('drop-overlay');
    let dragN = 0;
    document.addEventListener('dragenter', e => { e.preventDefault(); dragN++; if (overlay) overlay.style.display = 'flex'; });
    document.addEventListener('dragleave', e => { dragN--; if (dragN <= 0) { dragN = 0; if (overlay) overlay.style.display = 'none'; }});
    document.addEventListener('dragover',  e => e.preventDefault());
    document.addEventListener('drop', e => {
        e.preventDefault(); dragN = 0;
        if (overlay) overlay.style.display = 'none';
        if (e.dataTransfer.files.length) handleFileDrop(e.dataTransfer.files);
    });

    // ── Modal backdrop yopish ─────────────────────────────
    document.querySelectorAll('.modal-bg').forEach(m => {
        m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); });
    });

    // ── Klaviatura (Escape) ───────────────────────────────
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal-bg.open').forEach(m => m.classList.remove('open'));
        }
    });
});

// ── Yoqilg'i norma jadvali ─────────────────────────────────
function renderFuelNormsTable() {
    const tbody = document.getElementById('fuel-norms-table');
    if (!tbody) return;
    tbody.innerHTML = DRIVERS.map(d => {
        const norm = STATE.fuelNorms[d.car] || STATE.fuelNorms;
        const gas  = typeof norm === 'object' && norm.gas  !== undefined ? (norm[d.car]?.gas  ?? norm.gas)  : 14;
        const ben  = typeof norm === 'object' && norm.benzin !== undefined ? (norm[d.car]?.benzin ?? norm.benzin) : 12;
        return `<tr data-fuel-car="${d.car}">
            <td style="font-size:13px;font-weight:600;">${d.shortName}</td>
            <td style="font-size:12px;color:#64748b;font-family:monospace;">${d.car}</td>
            <td><input class="fuel-gas" type="number" value="${gas}" min="5" max="30" step="0.5"
                style="width:70px;padding:5px 8px;border:1.5px solid #dde3ec;border-radius:7px;font-family:inherit;font-size:13px;"></td>
            <td><input class="fuel-ben" type="number" value="${ben}" min="5" max="30" step="0.5"
                style="width:70px;padding:5px 8px;border:1.5px solid #dde3ec;border-radius:7px;font-family:inherit;font-size:13px;"></td>
        </tr>`;
    }).join('');
}

// Global funksiyalar (HTML onclick uchun)
window.selectDate   = selectDate;
window.selectDriver = selectDriver;
window.calSelectDate = selectDate;
