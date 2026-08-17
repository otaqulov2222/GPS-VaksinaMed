'use strict';

const UZ_M = ['YANVAR','FEVRAL','MART','APREL','MAY','IYUN','IYUL','AVGUST','SENTABR','OKTABR','NOYABR','DEKABR'];
const UZ_M_LOW = ['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentabr','oktabr','noyabr','dekabr'];
const MODES = [
  { v: 'gaz', t: 'Gaz' },
  { v: 'benzin', t: 'Benzin' },
  { v: 'aralash', t: 'Aralash' },
  { v: 'dizel', t: 'Dizel' }
];
const DOC_KEYS = [
  { k: 'insurance', t: 'Sug\'urta' },
  { k: 'tech', t: 'Texnik ko\'rik' },
  { k: 'ads', t: 'Reklama' },
  { k: 'cylinder', t: 'Gaz ballon sinovi' }
];

const DEFAULT_FLEET = [
  { car: '01 269 KMA', name: 'Хўжамов Хасан', short: 'Хасан' },
  { car: '01 949 AKA', name: 'Ибрагимов Дилшод', short: 'Дилшод' },
  { car: '01 302 DNA', name: 'Абдумаликов Йигитали', short: 'Йигитали' },
  { car: '01 255 HMA', name: 'Мустафақулов Мухриддин', short: 'Мухриддин' },
  { car: '01 205 HMA', name: 'Туробов Аваз', short: 'Аваз' },
  { car: '01 043 KMA', name: 'Саидов Жавохир', short: 'Жавохир' },
  { car: '01 931 PJA', name: 'Нуралиев Тимур', short: 'Тимур' },
  { car: '01 083 XJA', name: 'Қозоқов Зухриддин', short: 'Зухриддин' },
  { car: '01 382 NMA', name: 'Наханбоев Умид', short: 'Умид' },
  { car: '01 282 BMA', name: 'Ахтамов Боймурод', short: 'Боймурод' },
  { car: '01 870 SEA', name: 'Хомидов Сардор', short: 'Сардор Х.' },
  { car: '01 668 UKA', name: 'Маматқулов Жасур', short: 'Жасур' },
  { car: '01 887 UKA', name: 'Ахмадов Комил', short: 'Комил' },
  { car: '01 449 UKA', name: 'Абдурахмонов Санжарбек', short: 'Санжарбек' },
  { car: '01 646 UKA', name: 'Абдусаломов Хасан', short: 'Хасан А.' },
  { car: '01 844 FKA', name: 'Норқулов Гулом', short: 'Гулом', fuelType: 'dizel' },
  { car: '01 699 UKA', name: 'Турдиев Сардор', short: 'Сардор Т.' },
  { car: '01 592 YNA', name: 'Турсунқулов Нурбек', short: 'Нурбек' },
  { car: '01 849 SNA', name: 'Абдурахимов Козим', short: 'Козим' },
  { car: '01 309 YNA', name: 'Абдусатторов Акмал', short: 'Акмал' },
  { car: '01 331 MLA', name: 'Ахтамов', short: 'Ахтамов' },
  { car: '01 406 GNA', name: '01 406 GNA', short: '406 GNA' },
  { car: '01 567 SGA', name: '01 567 SGA', short: '567 SGA' }
];

const STATE = {
  tab: 'daily',
  month: '',
  car: '',
  dayRep: 1,
  stationFilter: 'all',
  meta: { vehicles: {}, stations: [], docs: {}, firm: {} },
  cars: {},
  gpsKm: {},
  yearMonths: {},
  saveTimer: null,
  dirty: false
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function n(v) {
  const x = Number(String(v ?? '').replace(',', '.').replace(/\s/g, ''));
  return Number.isFinite(x) ? x : 0;
}
function r4(v) {
  return Math.round(n(v) * 10000) / 10000;
}
function r2(v) {
  return Math.round(n(v) * 100) / 100;
}
function vin(v) {
  const x = n(v);
  return x ? String(v) : '';
}
function fmt(v, d) {
  const x = n(v);
  const p = d == null ? (Math.abs(x) >= 100 ? 0 : 2) : d;
  return x.toLocaleString('uz-UZ', { maximumFractionDigits: p, minimumFractionDigits: 0 });
}
function money(v) {
  return Math.round(n(v)).toLocaleString('uz-UZ');
}
function daysInMonth(ym) {
  const [y, m] = String(ym).split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function plateCode(car) {
  const m = String(car).match(/(\d{3})/);
  return m ? m[1] : String(car).slice(-3);
}
function plateDisp(car) {
  return String(car).replace(/^(\d{2})\s+/, '$1/');
}
function gpsKmLookup(dateMap, plate) {
  if (!dateMap) return 0;
  if (n(dateMap[plate]) > 0) return n(dateMap[plate]);
  const compact = String(plate).replace(/\s+/g, '');
  const code = plateCode(plate);
  for (const k of Object.keys(dateMap)) {
    if (n(dateMap[k]) <= 0) continue;
    if (k.replace(/\s+/g, '') === compact) return n(dateMap[k]);
    if (code && plateCode(k) === code) return n(dateMap[k]);
  }
  return 0;
}
function monthTitle(ym) {
  if (!ym) return '—';
  const [y, m] = ym.split('-').map(Number);
  return (UZ_M[m - 1] || '') + ' ' + y;
}
function monthLow(ym) {
  const m = Number(String(ym).slice(5, 7));
  return UZ_M_LOW[m - 1] || ym;
}
function todayYmd() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function addDays(ymd, nDays) {
  const d = new Date(ymd + 'T00:00:00');
  d.setDate(d.getDate() + nDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function daysLeft(due) {
  if (!due) return null;
  const a = new Date(todayYmd() + 'T00:00:00');
  const b = new Date(due + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 2400);
}

function normalizeMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  if (Array.isArray(m.docs)) m.docs = {};
  m.vehicles = m.vehicles || {};
  m.stations = m.stations || [];
  m.docs = m.docs || {};
  m.firm = Object.assign({ name: 'VAKSINA HEALTHCARE MChJ', director: '', mechanic: '' }, m.firm || {});
  return m;
}

function vehicleInfo(plate) {
  const base = DEFAULT_FLEET.find(d => d.car === plate) || { car: plate, name: plate, short: plate };
  const extra = (STATE.meta.vehicles || {})[plate] || {};
  const diesel = (extra.fuelType || base.fuelType) === 'dizel';
  return {
    car: plate,
    name: extra.name || base.name,
    short: extra.short || extra.name || base.short,
    brand: extra.brand || base.brand || '',
    card: extra.card || '',
    fuelType: extra.fuelType || base.fuelType || 'mixed',
    gasNorm: extra.gasNorm != null && extra.gasNorm !== '' ? n(extra.gasNorm) : 12,
    benzinNorm: extra.benzinNorm != null && extra.benzinNorm !== '' ? n(extra.benzinNorm) : (diesel ? 10 : 4),
    gasPrice: extra.gasPrice != null && extra.gasPrice !== '' ? n(extra.gasPrice) : 5200,
    benzinPrice: extra.benzinPrice != null && extra.benzinPrice !== '' ? n(extra.benzinPrice) : 11000,
    hidden: !!extra.hidden
  };
}

function ensureVehicleMeta(plate) {
  STATE.meta.vehicles = STATE.meta.vehicles || {};
  if (!STATE.meta.vehicles[plate]) {
    const info = vehicleInfo(plate);
    STATE.meta.vehicles[plate] = {
      name: info.name, short: info.short, brand: info.brand, card: info.card,
      fuelType: info.fuelType, gasNorm: info.gasNorm, benzinNorm: info.benzinNorm,
      gasPrice: info.gasPrice, benzinPrice: info.benzinPrice, hidden: false
    };
  }
  return STATE.meta.vehicles[plate];
}

function fleet() {
  const plates = [];
  const seen = {};
  DEFAULT_FLEET.forEach(d => { if (!seen[d.car]) { seen[d.car] = 1; plates.push(d.car); } });
  Object.keys(STATE.meta.vehicles || {}).forEach(p => { if (!seen[p]) { seen[p] = 1; plates.push(p); } });
  return plates.map(vehicleInfo).filter(v => !v.hidden);
}

function blankCar(info) {
  const v = info || {};
  const diesel = v.fuelType === 'dizel';
  return {
    gasNorm: v.gasNorm != null ? n(v.gasNorm) : 12,
    benzinNorm: v.benzinNorm != null ? n(v.benzinNorm) : (diesel ? 10 : 4),
    odoStart: 0,
    gasStart: 0,
    benzinStart: 0,
    gasPrice: v.gasPrice != null ? n(v.gasPrice) : 5200,
    benzinPrice: v.benzinPrice != null ? n(v.benzinPrice) : 11000,
    mixPct: 70,
    fuelType: v.fuelType || 'mixed',
    changes: [],
    driverChanges: [],
    days: {}
  };
}

function getCar(plate) {
  if (!STATE.cars[plate]) STATE.cars[plate] = blankCar(vehicleInfo(plate));
  if (!STATE.cars[plate].days) STATE.cars[plate].days = {};
  if (!STATE.cars[plate].changes) STATE.cars[plate].changes = [];
  if (!STATE.cars[plate].driverChanges) STATE.cars[plate].driverChanges = [];
  return STATE.cars[plate];
}

function driverOnDay(info, car, day) {
  let name = info.name;
  (car.driverChanges || []).forEach(ch => {
    if (n(ch.day) <= day && ch.name) name = ch.name;
  });
  return name;
}

function dayRow(car, d) {
  const src = (car.days && (car.days[d] || car.days[String(d)])) || {};
  const defMode = car.fuelType === 'dizel' ? 'dizel' : (car.fuelType === 'benzin' ? 'benzin' : 'gaz');
  return {
    km: n(src.km),
    odo: n(src.odo),
    mode: src.mode || defMode,
    station: src.station || '',
    gasIn: n(src.gasIn),
    gasPrice: n(src.gasPrice),
    benzinIn: n(src.benzinIn),
    benzinPrice: n(src.benzinPrice),
    extra: n(src.extra),
    extraWhy: src.extraWhy || '',
    note: src.note || ''
  };
}

function applyChanges(car, d, field, fallback) {
  let val = fallback;
  (car.changes || []).forEach(ch => {
    if (n(ch.day) <= d && ch.field === field) val = n(ch.value);
  });
  return val;
}

function calcCar(car) {
  const dim = daysInMonth(STATE.month);
  let odoPrev = n(car.odoStart);
  let gasR = r4(car.gasStart);
  let benR = r4(car.benzinStart);
  const rows = [];
  for (let d = 1; d <= dim; d++) {
    const src = dayRow(car, d);
    const gasPrice = src.gasPrice || applyChanges(car, d, 'gasPrice', n(car.gasPrice));
    const benPrice = src.benzinPrice || applyChanges(car, d, 'benzinPrice', n(car.benzinPrice));
    const gasNorm = applyChanges(car, d, 'gasNorm', n(car.gasNorm));
    const benNorm = applyChanges(car, d, 'benzinNorm', n(car.benzinNorm));
    const mix = applyChanges(car, d, 'mixPct', n(car.mixPct) || 70);
    let km = n(src.km);
    if (!km && src.odo > 0 && odoPrev > 0 && src.odo + 0.0001 >= odoPrev) {
      km = r4(src.odo - odoPrev);
    }
    if (src.odo > 0) odoPrev = src.odo;
    else if (km > 0) odoPrev = r4(odoPrev + km);
    let gasUsed = 0, benUsed = 0;
    if (km > 0) {
      if (src.mode === 'gaz') gasUsed = r4(km * gasNorm / 100);
      else if (src.mode === 'benzin' || src.mode === 'dizel') benUsed = r4(km * benNorm / 100);
      else if (src.mode === 'aralash') {
        gasUsed = r4(km * gasNorm / 100 * mix / 100);
        benUsed = r4(km * benNorm / 100 * (100 - mix) / 100);
      }
    }
    gasR = r4(gasR + src.gasIn - gasUsed);
    benR = r4(benR + src.benzinIn - benUsed);
    rows.push({
      d, km, odo: src.odo, mode: src.mode, station: src.station,
      gasIn: src.gasIn, gasPrice, gasSum: r2(src.gasIn * gasPrice),
      benzinIn: src.benzinIn, benzinPrice: benPrice, benzinSum: r2(src.benzinIn * benPrice),
      gasUsed, benUsed, gasR, benR, gasNorm, benNorm,
      extra: src.extra, extraWhy: src.extraWhy, note: src.note
    });
  }
  return rows;
}

function totals(rows) {
  const t = { km: 0, gasIn: 0, benzinIn: 0, gasUsed: 0, benUsed: 0, gasSum: 0, benzinSum: 0, extra: 0, gasR: 0, benR: 0, odo: 0 };
  rows.forEach(r => {
    t.km += r.km; t.gasIn += r.gasIn; t.benzinIn += r.benzinIn;
    t.gasUsed += r.gasUsed; t.benUsed += r.benUsed;
    t.gasSum += r.gasSum; t.benzinSum += r.benzinSum; t.extra += r.extra;
    if (r.odo > t.odo) t.odo = r.odo;
  });
  t.km = r4(t.km); t.gasIn = r4(t.gasIn); t.benzinIn = r4(t.benzinIn);
  t.gasUsed = r4(t.gasUsed); t.benUsed = r4(t.benUsed);
  t.cost = r2(t.gasSum + t.benzinSum + t.extra);
  if (rows.length) { t.gasR = rows[rows.length - 1].gasR; t.benR = rows[rows.length - 1].benR; }
  return t;
}

function carHasWarn(plate) {
  const car = STATE.cars[plate];
  if (!car) return false;
  const rows = calcCar(car);
  const empty = rows.every(r => !r.km && !r.gasIn && !r.benzinIn);
  const gpsDays = Object.keys(STATE.gpsKm).filter(dt => gpsKmLookup(STATE.gpsKm[dt], plate) > 0);
  if (gpsDays.length && empty) return true;
  if (rows.some(r => r.gasR < -0.05 || r.benR < -0.05)) return true;
  return false;
}

function markDirty() {
  STATE.dirty = true;
  const st = document.getElementById('save-st');
  if (st) st.textContent = 'Saqlanmagan...';
  clearTimeout(STATE.saveTimer);
  STATE.saveTimer = setTimeout(saveMonth, 800);
}

async function loadAll() {
  const now = new Date();
  STATE.month = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  const mi = document.getElementById('month-input');
  if (mi) mi.value = STATE.month;
  const [meta, month, gps] = await Promise.all([
    vmApi('/api/office/fuel/meta'),
    vmApi('/api/office/fuel/month?month=' + encodeURIComponent(STATE.month)),
    vmApi('/api/office/fuel/gps-km?month=' + encodeURIComponent(STATE.month)).catch(() => ({ days: {} }))
  ]);
  STATE.meta = normalizeMeta(meta.meta);
  STATE.cars = (month.data && month.data.cars) || {};
  STATE.gpsKm = gps.days || {};
  STATE.dayRep = Math.min(now.getDate(), daysInMonth(STATE.month));
  if (!STATE.car) STATE.car = fleet()[0].car;
  setMonthLabel();
  await autoChainMonth();
  renderAll();
}

async function changeMonth(ym) {
  if (!ym) return;
  if (STATE.dirty) await saveMonth();
  STATE.month = ym;
  document.getElementById('month-input').value = ym;
  const [month, gps] = await Promise.all([
    vmApi('/api/office/fuel/month?month=' + encodeURIComponent(ym)),
    vmApi('/api/office/fuel/gps-km?month=' + encodeURIComponent(ym)).catch(() => ({ days: {} }))
  ]);
  STATE.cars = (month.data && month.data.cars) || {};
  STATE.gpsKm = gps.days || {};
  STATE.dirty = false;
  STATE.dayRep = 1;
  setMonthLabel();
  await autoChainMonth();
  renderAll();
}

function setMonthLabel() {
  document.getElementById('month-label').textContent = monthTitle(STATE.month);
}

function carsToSave() {
  const out = {};
  Object.keys(STATE.cars).forEach(k => {
    const c = STATE.cars[k];
    const hasDays = c.days && Object.keys(c.days).some(d => {
      const r = c.days[d] || {};
      return n(r.km) || n(r.odo) || n(r.gasIn) || n(r.benzinIn) || n(r.extra) || r.note || r.station;
    });
    const touched = n(c.odoStart) || n(c.gasStart) || n(c.benzinStart) || (c.changes && c.changes.length) || (c.driverChanges && c.driverChanges.length) || hasDays;
    if (touched) out[k] = c;
  });
  if (STATE.car) out[STATE.car] = getCar(STATE.car);
  return out;
}

async function saveMonth() {
  try {
    const d = await vmApi('/api/office/fuel/month', {
      method: 'POST',
      body: JSON.stringify({ month: STATE.month, cars: carsToSave() })
    });
    STATE.dirty = false;
    STATE.yearMonths = {};
    const st = document.getElementById('save-st');
    if (st) st.textContent = 'Saqlandi ' + (d.savedAt || '');
  } catch (e) {
    const st = document.getElementById('save-st');
    if (st) st.textContent = e.message || 'Saqlanmadi';
    toast(e.message || 'Saqlanmadi');
  }
}

async function saveMeta() {
  const d = await vmApi('/api/office/fuel/meta', {
    method: 'POST',
    body: JSON.stringify(STATE.meta)
  });
  STATE.meta = normalizeMeta(d.meta || STATE.meta);
}

function readParamsIntoCar() {
  const car = getCar(STATE.car);
  document.querySelectorAll('[data-p]').forEach(el => {
    const k = el.getAttribute('data-p');
    car[k] = k === 'fuelType' ? el.value : n(el.value);
  });
}

function writeParams() {
  const car = getCar(STATE.car);
  ['gasNorm','benzinNorm','odoStart','gasStart','benzinStart','gasPrice','benzinPrice','mixPct'].forEach(k => {
    const el = document.getElementById('p-' + k);
    if (el) el.value = car[k] ?? '';
  });
  const ft = document.getElementById('p-fuelType');
  if (ft) ft.value = car.fuelType || 'mixed';
  const info = vehicleInfo(STATE.car);
  document.getElementById('car-title').textContent = plateDisp(info.car) + ' — ' + (info.name || info.short || '');
  const bits = [];
  (car.changes || []).forEach(c => bits.push(c.day + '-kun ' + c.field + '=' + c.value));
  (car.driverChanges || []).forEach(c => bits.push(c.day + '-kundan haydovchi: ' + c.name));
  document.getElementById('changes-box').innerHTML = bits.length ? ('Zanjir o\'zgarishlari: ' + bits.map(esc).join(' · ')) : '';
}

function renderChips() {
  const box = document.getElementById('chips');
  box.innerHTML = fleet().map(f => {
    const on = f.car === STATE.car ? ' on' : '';
    const warn = carHasWarn(f.car) ? ' warn' : '';
    return `<div class="chip-car${on}${warn}" data-car="${esc(f.car)}"><b>${esc(plateCode(f.car))}</b><i>${esc(f.short || f.name)}</i></div>`;
  }).join('');
}

function modeSelect(d, mode) {
  return `<select data-d="${d}" data-f="mode">${MODES.map(m =>
    `<option value="${m.v}"${m.v === mode ? ' selected' : ''}>${m.t}</option>`
  ).join('')}</select>`;
}

function stationSelect(d, val) {
  return `<input list="station-list" data-d="${d}" data-f="station" value="${esc(val)}">`;
}

function stationDatalist() {
  const el = document.getElementById('station-list');
  if (!el) return;
  el.innerHTML = (STATE.meta.stations || []).map(s => `<option value="${esc(s)}">`).join('');
}

function remainClass(v) {
  if (v < -0.0001) return 'neg';
  if (v > 0.0001) return 'pos';
  return '';
}

function renderDailyTable() {
  const car = getCar(STATE.car);
  const rows = calcCar(car);
  stationDatalist();
  const body = document.getElementById('daily-body');
  body.innerHTML = rows.map(r => {
    const src = dayRow(car, r.d);
    return `<tr>
      <td class="day">${r.d}</td>
      <td><input data-d="${r.d}" data-f="km" type="number" step="0.01" value="${vin(src.km)}"></td>
      <td><input data-d="${r.d}" data-f="odo" type="number" step="0.1" value="${vin(src.odo)}"></td>
      <td>${modeSelect(r.d, src.mode)}</td>
      <td>${stationSelect(r.d, src.station)}</td>
      <td><input data-d="${r.d}" data-f="gasIn" type="number" step="0.0001" value="${vin(src.gasIn)}"></td>
      <td><input data-d="${r.d}" data-f="gasPrice" type="number" step="1" value="${vin(r.gasPrice)}"></td>
      <td><span class="out">${r.gasIn ? money(r.gasSum) : ''}</span></td>
      <td><input data-d="${r.d}" data-f="benzinIn" type="number" step="0.0001" value="${vin(src.benzinIn)}"></td>
      <td><input data-d="${r.d}" data-f="benzinPrice" type="number" step="1" value="${vin(r.benzinPrice)}"></td>
      <td><span class="out">${r.benzinIn ? money(r.benzinSum) : ''}</span></td>
      <td><span class="out">${r.km ? r.gasUsed.toFixed(4) : ''}</span></td>
      <td><span class="out">${r.km ? r.benUsed.toFixed(4) : ''}</span></td>
      <td><span class="out ${remainClass(r.gasR)}">${(r.km || r.gasIn) ? r.gasR.toFixed(4) : ''}</span></td>
      <td><span class="out ${remainClass(r.benR)}">${(r.km || r.benzinIn) ? r.benR.toFixed(4) : ''}</span></td>
      <td><input data-d="${r.d}" data-f="extra" type="number" step="1" value="${vin(src.extra)}"></td>
      <td><input class="w-note" data-d="${r.d}" data-f="extraWhy" value="${esc(src.extraWhy)}"></td>
      <td><input class="w-note" data-d="${r.d}" data-f="note" value="${esc(src.note)}"></td>
    </tr>`;
  }).join('');
}

function paintCalc() {
  const rows = calcCar(getCar(STATE.car));
  document.querySelectorAll('#daily-body tr').forEach((tr, i) => {
    const r = rows[i];
    if (!r) return;
    const outs = tr.querySelectorAll('.out');
    if (outs[0]) outs[0].textContent = r.gasIn ? money(r.gasSum) : '';
    if (outs[1]) outs[1].textContent = r.benzinIn ? money(r.benzinSum) : '';
    if (outs[2]) outs[2].textContent = r.km ? r.gasUsed.toFixed(4) : '';
    if (outs[3]) outs[3].textContent = r.km ? r.benUsed.toFixed(4) : '';
    if (outs[4]) {
      outs[4].textContent = (r.km || r.gasIn) ? r.gasR.toFixed(4) : '';
      outs[4].className = 'out ' + remainClass(r.gasR);
    }
    if (outs[5]) {
      outs[5].textContent = (r.km || r.benzinIn) ? r.benR.toFixed(4) : '';
      outs[5].className = 'out ' + remainClass(r.benR);
    }
  });
}

function fleetTotals() {
  const t = { km: 0, gasIn: 0, benzinIn: 0, gasUsed: 0, benUsed: 0, cost: 0, extra: 0, cars: 0 };
  fleet().forEach(f => {
    const x = totals(calcCar(getCar(f.car)));
    if (x.km || x.gasIn || x.benzinIn) t.cars += 1;
    t.km += x.km; t.gasIn += x.gasIn; t.benzinIn += x.benzinIn;
    t.gasUsed += x.gasUsed; t.benUsed += x.benUsed; t.cost += x.cost; t.extra += x.extra;
  });
  return t;
}

function collectDocAlerts() {
  const out = [];
  fleet().forEach(f => {
    const rec = (STATE.meta.docs || {})[f.car] || {};
    DOC_KEYS.forEach(dk => {
      const due = rec[dk.k] && rec[dk.k].due;
      const left = daysLeft(due);
      if (left == null) return;
      if (left <= 45) out.push({ car: f.car, name: f.short, title: dk.t, due, left });
    });
  });
  out.sort((a, b) => a.left - b.left);
  return out;
}

function renderDocsBadge() {
  const alerts = collectDocAlerts();
  const hot = alerts.filter(d => d.left <= 15);
  const count = hot.length || alerts.filter(d => d.left <= 45).length;
  const el = document.getElementById('docs-badge');
  if (!el) return;
  if (!count) { el.style.display = 'none'; return; }
  el.style.display = 'inline-flex';
  el.textContent = count + ' hujjat muddati!';
}

function renderHome() {
  const t = fleetTotals();
  const alerts = collectDocAlerts();
  const missing = [];
  fleet().forEach(f => {
    Object.keys(STATE.gpsKm).forEach(dt => {
      const km = gpsKmLookup(STATE.gpsKm[dt], f.car);
      if (!km) return;
      const day = Number(dt.slice(-2));
      const row = dayRow(getCar(f.car), day);
      if (!row.km) missing.push({ car: f.car, short: f.short, dt, km });
    });
  });
  document.getElementById('panel-home').innerHTML = `
    <div class="kpis">
      <div class="kpi"><i>Mashina kiritilgan</i><b>${t.cars}</b><s>${fleet().length} ta park</s></div>
      <div class="kpi"><i>Jami km</i><b>${fmt(t.km, 2)}</b><s>${esc(monthTitle(STATE.month))}</s></div>
      <div class="kpi"><i>Gaz sarfi / olingan</i><b>${fmt(t.gasUsed, 2)} m³</b><s>olingan ${fmt(t.gasIn, 2)} m³</s></div>
      <div class="kpi"><i>Benzin sarfi / olingan</i><b>${fmt(t.benUsed, 2)} l</b><s>olingan ${fmt(t.benzinIn, 2)} l</s></div>
      <div class="kpi"><i>Yoqilg'i xarajati</i><b>${money(t.cost)}</b><s>qo'shimcha ${money(t.extra)}</s></div>
      <div class="kpi"><i>GPS km tushmagan</i><b>${missing.length}</b><s>hisobot bor, kunlik yo'q</s></div>
      <div class="kpi"><i>Hujjat muddati</i><b>${alerts.length}</b><s>45 kun ichida</s></div>
      <div class="kpi"><i>Zapravka</i><b>${(STATE.meta.stations || []).length}</b><s>reestr</s></div>
    </div>
    <div class="card"><div class="card-h"><h3>GPS bor — kunlik km tushmagan</h3></div>
      <div class="card-b">${missing.length ? `<table class="gtable"><thead><tr><th>Sana</th><th>Mashina</th><th>GPS km</th></tr></thead><tbody>
        ${missing.slice(0, 80).map(m => `<tr><td>${esc(m.dt)}</td><td>${esc(plateDisp(m.car))} ${esc(m.short)}</td><td class="num">${m.km}</td></tr>`).join('')}
      </tbody></table>` : '<p class="note">Oy ochilganda GPS km avtomatik tushadi. Sariq katakni tahrirlash mumkin. Zapravka qo\'lda.</p>'}
      </div></div>`;
}

function jamiRow(cells, label) {
  return `<tr><td colspan="${cells.span || 1}"><b>${label || 'JAMI'}</b></td>${cells.html}</tr>`;
}

function renderDayRep() {
  const dim = daysInMonth(STATE.month);
  STATE.dayRep = Math.min(Math.max(1, n(STATE.dayRep) || 1), dim);
  const day = STATE.dayRep;
  const rows = fleet().map((f, i) => {
    const car = getCar(f.car);
    const r = calcCar(car)[day - 1] || {};
    return Object.assign({ n: i + 1, plate: f.car, name: driverOnDay(f, car, day) }, r);
  });
  const sum = totals(rows);
  const [y, m] = STATE.month.split('-');
  document.getElementById('panel-dayrep').innerHTML = `
    <div class="card"><div class="card-h">
      <h3>Kun hisoboti — ${day}-${monthLow(STATE.month)} ${y}</h3>
      <button class="btn btn-ink btn-sm no-print" type="button" onclick="window.print()">PDF chiqarish</button>
    </div>
    <div class="card-b">
      <div class="day-pills no-print">${Array.from({length: dim}, (_, i) => i + 1).map(d =>
        `<button type="button" class="day-pill${d === day ? ' on' : ''}" data-day="${d}">${d}</button>`
      ).join('')}</div>
      <div style="overflow:auto;margin-top:10px;">
      <table class="gtable">
        <thead><tr><th>№</th><th>Mashina</th><th>Haydovchi</th><th>Yurdi (km)</th><th>Nimada</th><th>Zapravka</th><th>Gaz (m³)</th><th>Gaz summa</th><th>Benzin (l)</th><th>Benzin summa</th><th>Sarf gaz</th><th>Sarf benzin</th><th>Qo'shimcha</th><th>Izoh</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${r.n}</td><td>${esc(plateDisp(r.plate))}</td><td>${esc(r.name)}</td>
          <td class="num">${r.km ? fmt(r.km, 2) : ''}</td><td>${esc(r.mode || '')}</td><td>${esc(r.station || '')}</td>
          <td class="num">${r.gasIn ? fmt(r.gasIn, 4) : ''}</td><td class="num">${r.gasIn ? money(r.gasSum) : ''}</td>
          <td class="num">${r.benzinIn ? fmt(r.benzinIn, 4) : ''}</td><td class="num">${r.benzinIn ? money(r.benzinSum) : ''}</td>
          <td class="num">${r.gasUsed ? r.gasUsed.toFixed(4) : ''}</td>
          <td class="num">${r.benUsed ? r.benUsed.toFixed(4) : ''}</td>
          <td class="num">${r.extra ? money(r.extra) : ''}</td><td>${esc(r.note || r.extraWhy || '')}</td>
        </tr>`).join('')}
        <tr><td colspan="3"><b>JAMI</b></td>
          <td class="num"><b>${fmt(sum.km, 2)}</b></td><td></td><td></td>
          <td class="num"><b>${fmt(sum.gasIn, 2)}</b></td><td class="num"><b>${money(sum.gasSum)}</b></td>
          <td class="num"><b>${fmt(sum.benzinIn, 2)}</b></td><td class="num"><b>${money(sum.benzinSum)}</b></td>
          <td class="num"><b>${fmt(sum.gasUsed, 2)}</b></td><td class="num"><b>${fmt(sum.benUsed, 2)}</b></td>
          <td class="num"><b>${money(sum.extra)}</b></td><td></td></tr>
        </tbody>
      </table>
      </div>
    </div></div>`;
  document.querySelectorAll('.day-pill').forEach(btn => {
    btn.onclick = () => { STATE.dayRep = n(btn.getAttribute('data-day')); renderDayRep(); };
  });
}

function renderMonth() {
  const rows = fleet().map((f, i) => {
    const t = totals(calcCar(getCar(f.car)));
    return Object.assign({ n: i + 1, plate: f.car, name: f.name, short: f.short }, t);
  });
  const sum = rows.reduce((a, r) => {
    a.km += r.km || 0; a.gasIn += r.gasIn || 0; a.benzinIn += r.benzinIn || 0;
    a.gasSum += r.gasSum || 0; a.benzinSum += r.benzinSum || 0; a.extra += r.extra || 0; a.cost += r.cost || 0;
    return a;
  }, { km: 0, gasIn: 0, benzinIn: 0, gasSum: 0, benzinSum: 0, extra: 0, cost: 0 });
  document.getElementById('panel-month').innerHTML = `
    <div class="card"><div class="card-h"><h3>Oylik jamlanma — ${esc(monthLow(STATE.month))} ${STATE.month.slice(0,4)}</h3>
      <button class="btn btn-ink btn-sm no-print" type="button" onclick="window.print()">PDF chiqarish</button></div>
    <div class="card-b" style="overflow:auto;">
      <table class="gtable">
        <thead><tr><th>№</th><th>Mashina</th><th>Haydovchi</th><th>Probeg (km)</th><th>Olingan gaz (m³)</th><th>Gaz summa</th><th>Olingan benzin (l)</th><th>Benzin summa</th><th>Qo'shimcha</th><th>Umumiy xarajat</th><th>Gaz qoldiq</th><th>Benzin qoldiq</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${r.n}</td><td>${esc(plateDisp(r.plate))}</td><td>${esc(r.name)}</td>
          <td class="num">${fmt(r.km, 2)}</td>
          <td class="num">${fmt(r.gasIn, 4)}</td><td class="num">${money(r.gasSum)}</td>
          <td class="num">${fmt(r.benzinIn, 4)}</td><td class="num">${money(r.benzinSum)}</td>
          <td class="num">${money(r.extra)}</td><td class="num">${money(r.cost)}</td>
          <td class="num ${remainClass(r.gasR)}">${fmt(r.gasR, 4)}</td>
          <td class="num ${remainClass(r.benR)}">${fmt(r.benR, 4)}</td>
        </tr>`).join('')}
        <tr><td colspan="3"><b>JAMI</b></td>
          <td class="num"><b>${fmt(sum.km, 2)}</b></td>
          <td class="num"><b>${fmt(sum.gasIn, 2)}</b></td><td class="num"><b>${money(sum.gasSum)}</b></td>
          <td class="num"><b>${fmt(sum.benzinIn, 2)}</b></td><td class="num"><b>${money(sum.benzinSum)}</b></td>
          <td class="num"><b>${money(sum.extra)}</b></td><td class="num"><b>${money(sum.cost)}</b></td>
          <td></td><td></td></tr>
        </tbody>
      </table>
    </div></div>`;
}

function renderOfficial() {
  const firm = STATE.meta.firm || {};
  const list = fleet().map(f => {
    const car = getCar(f.car);
    const t = totals(calcCar(car));
    return { f, car, t };
  }).filter(x => x.t.km || x.t.gasIn || x.t.benzinIn || x.t.gasUsed || x.t.benUsed);
  const [y, mo] = STATE.month.split('-');
  const titleM = monthLow(STATE.month);
  document.getElementById('panel-official').innerHTML = `
    <div class="card">
      <div class="card-h no-print"><h3>Rasmiy oylik hisobot — ${esc(titleM)} ${y}</h3>
        <div class="row-btns" style="margin:0">
          <button class="btn btn-gold btn-sm" type="button" onclick="window.print()">Chop etish / PDF</button>
          <button class="btn btn-ink btn-sm" type="button" id="off-xlsx">Shablon Excel</button>
        </div>
      </div>
      <div class="card-b">
        <div class="params no-print" style="margin-bottom:12px;">
          <div class="fld"><label>Firma nomi</label><input id="firm-name" value="${esc(firm.name || '')}"></div>
          <div class="fld"><label>Direktor F.I.O.</label><input id="firm-director" value="${esc(firm.director || '')}" placeholder="masalan Karimov A.A."></div>
          <div class="fld"><label>Mexanik F.I.O.</label><input id="firm-mechanic" value="${esc(firm.mechanic || '')}" placeholder="masalan Rahimov B."></div>
        </div>
        <div style="text-align:right;margin-bottom:10px;">
          <div style="font-size:11px;letter-spacing:.12em;font-weight:700;">УТВЕРЖДАЮ</div>
          <div>Bosh direktor ${esc(firm.director || '_______________')}</div>
          <div class="muted">${esc(firm.name || 'VAKSINA HEALTHCARE MChJ')}</div>
        </div>
        <div style="text-align:center;margin:8px 0 12px;font-weight:700;">
          ОТЧЕТ об израсходовании топлива автотранспортными средствами<br>
          ${esc(firm.name || 'VAKSINA HEALTHCARE MChJ')} за ${esc(titleM)} ${y} г.
        </div>
        <div style="overflow:auto;">
        <table class="gtable">
          <thead><tr>
            <th>№</th><th>Marka</th><th>Gos №</th><th>F.I.O. voditelya</th><th>Yoqilg'i</th>
            <th>Norma (100 km)</th><th>Qoldiq (oy boshi)</th><th>Olingan</th><th>Qiymati (so'm)</th>
            <th>Probeg (km)</th><th>Sarflangan</th><th>Qoldiq (oy oxiri)</th><th>Pul sarfi (so'm)</th>
          </tr></thead>
          <tbody>${list.map((x, i) => {
            const gNeg = x.t.gasR < -0.0001 ? 'neg' : '';
            const bNeg = x.t.benR < -0.0001 ? 'neg' : '';
            return `<tr class="row-gaz">
              <td rowspan="2">${i + 1}</td>
              <td rowspan="2">${esc(x.f.brand || '—')}</td>
              <td rowspan="2">${esc(plateDisp(x.f.car))}</td>
              <td rowspan="2">${esc(x.f.name)}</td>
              <td>GAZ (m³)</td>
              <td class="num">${fmt(x.car.gasNorm, 2)}</td>
              <td class="num">${fmt(x.car.gasStart, 4)}</td>
              <td class="num">${fmt(x.t.gasIn, 4)}</td>
              <td class="num">${money(x.t.gasSum)}</td>
              <td class="num" rowspan="2">${fmt(x.t.km, 2)}</td>
              <td class="num">${fmt(x.t.gasUsed, 4)}</td>
              <td class="num ${gNeg}">${fmt(x.t.gasR, 4)}</td>
              <td class="num" rowspan="2">${money(x.t.cost)}</td>
            </tr>
            <tr class="row-ben">
              <td>BENZIN (l)</td>
              <td class="num">${fmt(x.car.benzinNorm, 2)}</td>
              <td class="num">${fmt(x.car.benzinStart, 4)}</td>
              <td class="num">${fmt(x.t.benzinIn, 4)}</td>
              <td class="num">${money(x.t.benzinSum)}</td>
              <td class="num">${fmt(x.t.benUsed, 4)}</td>
              <td class="num ${bNeg}">${fmt(x.t.benR, 4)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>
        </div>
        <p class="note" style="margin-top:16px;">Mexanik: ${esc(firm.mechanic || '_______________')} &nbsp;&nbsp; Hisobchi: _______________</p>
      </div>
    </div>`;
  const saveFirm = async () => {
    STATE.meta.firm = {
      name: document.getElementById('firm-name').value.trim() || 'VAKSINA HEALTHCARE MChJ',
      director: document.getElementById('firm-director').value.trim(),
      mechanic: document.getElementById('firm-mechanic').value.trim()
    };
    await saveMeta();
  };
  ['firm-name','firm-director','firm-mechanic'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => saveFirm().catch(err => toast(err.message)));
  });
  const xbtn = document.getElementById('off-xlsx');
  if (xbtn) xbtn.onclick = exportExcel;
}

function collectFills() {
  const out = [];
  fleet().forEach(f => {
    calcCar(getCar(f.car)).forEach(r => {
      if (r.gasIn > 0) out.push({ plate: f.car, name: f.name, short: f.short, d: r.d, station: r.station, type: 'Gaz', qty: r.gasIn, price: r.gasPrice, sum: r.gasSum, kind: 'gaz' });
      if (r.benzinIn > 0) out.push({ plate: f.car, name: f.name, short: f.short, d: r.d, station: r.station, type: getCar(f.car).fuelType === 'dizel' ? 'Dizel' : 'Benzin', qty: r.benzinIn, price: r.benzinPrice, sum: r.benzinSum, kind: 'benzin' });
    });
  });
  return out;
}

function renderStations() {
  const all = collectFills();
  const filt = STATE.stationFilter;
  const fills = all.filter(f => filt === 'all' || (filt === 'gaz' && f.kind === 'gaz') || (filt === 'benzin' && f.kind === 'benzin'));
  const groups = {};
  fills.forEach(f => {
    if (!groups[f.plate]) groups[f.plate] = { plate: f.plate, name: f.name, rows: [], gas: 0, ben: 0, sum: 0 };
    groups[f.plate].rows.push(f);
    if (f.kind === 'gaz') groups[f.plate].gas += f.qty; else groups[f.plate].ben += f.qty;
    groups[f.plate].sum += f.sum;
  });
  const list = STATE.meta.stations || [];
  document.getElementById('panel-stations').innerHTML = `
    <div class="card"><div class="card-h"><h3>Zapravka reestri — ${esc(monthLow(STATE.month))} ${STATE.month.slice(0,4)}</h3>
      <button class="btn btn-ink btn-sm no-print" type="button" onclick="window.print()">PDF chiqarish</button></div>
      <div class="card-b">
        <div class="hint">Bu reestr kunlik kiritishdan avtomatik yig'iladi. Admin zapravka nomini kunlik jadvalda yoki pastda qo'lda o'zgartiradi.</div>
        <div class="row-btns no-print" style="margin:0 0 10px;">
          <input id="st-new" placeholder="Yangi zapravka nomi" style="height:32px;padding:0 8px;border:1px solid var(--line);min-width:220px;">
          <button class="btn btn-gold btn-sm" type="button" id="st-add">Qo'shish</button>
        </div>
        <div class="subtabs no-print">
          <button type="button" class="subtab${filt==='all'?' on':''}" data-f="all">Hammasi</button>
          <button type="button" class="subtab${filt==='gaz'?' on':''}" data-f="gaz">Faqat gaz</button>
          <button type="button" class="subtab${filt==='benzin'?' on':''}" data-f="benzin">Faqat benzin/dizel</button>
        </div>
        ${Object.keys(groups).map(p => {
          const g = groups[p];
          return `<div style="margin-bottom:14px;">
            <div style="font-weight:700;margin:6px 0;">${esc(plateDisp(g.plate))} — ${esc(g.name)}</div>
            <table class="gtable"><thead><tr><th>Kun</th><th>Zapravka</th><th>Tur</th><th>Miqdor</th><th>Narx</th><th>Summa</th></tr></thead>
            <tbody>${g.rows.map(r => `<tr>
              <td>${r.d}</td><td>${esc(r.station)}</td><td>${esc(r.type)}</td>
              <td class="num">${fmt(r.qty, 4)}</td><td class="num">${money(r.price)}</td><td class="num">${money(r.sum)}</td>
            </tr>`).join('')}
            <tr><td colspan="3"><b>Jami</b></td>
              <td class="num"><b>${g.gas ? fmt(g.gas, 3) + ' m³' : ''} ${g.ben ? fmt(g.ben, 3) + ' l' : ''}</b></td>
              <td></td><td class="num"><b>${money(g.sum)}</b></td></tr>
            </tbody></table>
          </div>`;
        }).join('') || '<p class="note">Bu oyda quyish yo\'q.</p>'}
        <h3 style="margin:16px 0 8px;font-size:12px;letter-spacing:.1em;text-transform:uppercase;">Zapravka nomlari</h3>
        <table class="gtable"><thead><tr><th>Nomi</th><th></th></tr></thead>
        <tbody>${list.map((s,i) => `<tr><td>${esc(s)}</td>
          <td><button class="btn btn-ink btn-sm st-del" data-i="${i}" type="button">O'chirish</button></td></tr>`).join('') || '<tr><td colspan="2" class="muted">Hali yo\'q</td></tr>'}
        </tbody></table>
      </div></div>`;
  document.querySelectorAll('.subtab').forEach(b => {
    b.onclick = () => { STATE.stationFilter = b.getAttribute('data-f'); renderStations(); };
  });
  const add = document.getElementById('st-add');
  if (add) add.onclick = async () => {
    const v = (document.getElementById('st-new').value || '').trim();
    if (!v) return;
    STATE.meta.stations = STATE.meta.stations || [];
    if (!STATE.meta.stations.includes(v)) STATE.meta.stations.push(v);
    await saveMeta();
    renderStations();
    stationDatalist();
  };
  document.querySelectorAll('.st-del').forEach(btn => {
    btn.onclick = async () => {
      STATE.meta.stations.splice(Number(btn.getAttribute('data-i')), 1);
      await saveMeta();
      renderStations();
    };
  });
}

function renderGasAct() {
  const [y, mo] = STATE.month.split('-').map(Number);
  const next = new Date(y, mo, 1);
  const nextStr = String(next.getDate()).padStart(2,'0') + '.' + String(next.getMonth()+1).padStart(2,'0') + '.' + next.getFullYear();
  const startStr = '01.' + String(mo).padStart(2,'0') + '.' + y;
  const lastDay = daysInMonth(STATE.month);
  const rows = fleet().map((f, i) => {
    const car = getCar(f.car);
    const t = totals(calcCar(car));
    return { n: i + 1, f, car, t };
  });
  const sum = rows.reduce((a, r) => {
    a.start += n(r.car.gasStart); a.in += r.t.gasIn; a.km += r.t.km; a.used += r.t.gasUsed; a.end += r.t.gasR;
    return a;
  }, { start: 0, in: 0, km: 0, used: 0, end: 0 });
  document.getElementById('panel-gasact').innerHTML = `
    <div class="card">
      <div class="card-h no-print"><h3>Gaz dalolatnomasi — ${esc(monthLow(STATE.month))} ${y}</h3>
        <button class="btn btn-gold btn-sm" type="button" onclick="window.print()">PDF chiqarish</button></div>
      <div class="card-b">
        <div style="text-align:center;font-weight:700;margin-bottom:12px;">GAZ DALOLATNOMASI</div>
        <div style="overflow:auto;">
        <table class="gtable">
          <thead><tr>
            <th>№</th><th>Mas'ul haydovchi F.I.Sh.</th><th>Avtomobil markasi</th><th>Davlat raqami</th>
            <th>${esc(startStr)} qoldiq (m³)</th><th>To'ldirilgan (m³)</th><th>Meyyor (100km, m³)</th>
            <th>Bosib o'tgan (km)</th><th>Meyyor bo'yicha sarf (m³)</th><th>${esc(nextStr)} qoldiq (m³)</th>
          </tr></thead>
          <tbody>${rows.map(r => `<tr>
            <td>${r.n}</td><td>${esc(r.f.name)}</td><td>${esc(r.f.brand || '—')}</td><td>${esc(plateDisp(r.f.car))}</td>
            <td class="num">${fmt(r.car.gasStart, 4)}</td>
            <td class="num">${fmt(r.t.gasIn, 4)}</td>
            <td class="num">${fmt(r.car.gasNorm, 2)}</td>
            <td class="num">${fmt(r.t.km, 2)}</td>
            <td class="num">${fmt(r.t.gasUsed, 4)}</td>
            <td class="num ${remainClass(r.t.gasR)}">${fmt(r.t.gasR, 4)}</td>
          </tr>`).join('')}
          <tr><td colspan="4"><b>JAMI</b></td>
            <td class="num"><b>${fmt(sum.start, 3)}</b></td>
            <td class="num"><b>${fmt(sum.in, 3)}</b></td><td></td>
            <td class="num"><b>${fmt(sum.km, 2)}</b></td>
            <td class="num"><b>${fmt(sum.used, 3)}</b></td>
            <td class="num"><b>${fmt(sum.end, 3)}</b></td></tr>
          </tbody>
        </table>
        </div>
        <p class="note" style="margin-top:14px;">${lastDay}.${String(mo).padStart(2,'0')}.${y} holatiga jami ${fmt(sum.used, 3)} m³ gaz sarflandi. ${nextStr} qoldiq: ${fmt(sum.end, 3)} m³.</p>
        <p class="note">Imzo: _________________</p>
      </div>
    </div>`;
}

function monthTotalsFor(ym, carsMap) {
  const hold = STATE.month;
  STATE.month = ym;
  const t = { km: 0, gasIn: 0, benzinIn: 0, gasSum: 0, benzinSum: 0, extra: 0, cost: 0 };
  Object.keys(carsMap || {}).forEach(plate => {
    const x = totals(calcCar(carsMap[plate]));
    t.km += x.km; t.gasIn += x.gasIn; t.benzinIn += x.benzinIn;
    t.gasSum += x.gasSum; t.benzinSum += x.benzinSum; t.extra += x.extra; t.cost += x.cost;
  });
  STATE.month = hold;
  return t;
}

async function renderYear() {
  const year = STATE.month.slice(0, 4);
  if (!STATE.yearMonths._year || STATE.yearMonths._year !== year) {
    const d = await vmApi('/api/office/fuel/year?year=' + year);
    STATE.yearMonths = Object.assign({ _year: year }, d.months || {});
  }
  const months = [];
  for (let m = 1; m <= 12; m++) months.push(year + '-' + String(m).padStart(2, '0'));
  const currentMonth = STATE.month;
  const perMonth = months.map(ym => {
    const cars = currentMonth === ym ? STATE.cars : ((STATE.yearMonths[ym] || {}).cars || {});
    return Object.assign({ ym }, monthTotalsFor(ym, cars));
  });
  const ysum = perMonth.reduce((a, r) => {
    a.km += r.km; a.gasIn += r.gasIn; a.benzinIn += r.benzinIn; a.gasSum += r.gasSum; a.benzinSum += r.benzinSum; a.cost += r.cost;
    return a;
  }, { km: 0, gasIn: 0, benzinIn: 0, gasSum: 0, benzinSum: 0, cost: 0 });
  document.getElementById('panel-year').innerHTML = `
    <div class="kpis">
      <div class="kpi"><i>Yillik gaz</i><b>${fmt(ysum.gasIn, 1)} m³</b><s>xarajat ${money(ysum.gasSum)}</s></div>
      <div class="kpi"><i>Yillik benzin</i><b>${fmt(ysum.benzinIn, 1)} l</b><s>xarajat ${money(ysum.benzinSum)}</s></div>
      <div class="kpi"><i>Umumiy xarajat</i><b>${money(ysum.cost)}</b><s>${esc(year)} yil</s></div>
      <div class="kpi"><i>Yillik km</i><b>${fmt(ysum.km, 2)}</b><s>probeg</s></div>
    </div>
    <div class="card"><div class="card-h"><h3>${esc(year)} yil — oyma-oy jamlanma</h3>
      <button class="btn btn-ink btn-sm no-print" type="button" onclick="window.print()">PDF chiqarish</button></div>
    <div class="card-b" style="overflow:auto;">
      <table class="gtable">
        <thead><tr><th>Oy</th><th>Probeg (km)</th><th>Gaz (m³)</th><th>Gaz summa</th><th>Benzin (l)</th><th>Benzin summa</th><th>Jami (so'm)</th></tr></thead>
        <tbody>${perMonth.map(r => `<tr>
          <td>${esc(UZ_M[Number(r.ym.slice(5))-1])}</td>
          <td class="num">${r.km ? fmt(r.km, 2) : ''}</td>
          <td class="num">${r.gasIn ? fmt(r.gasIn, 2) : ''}</td>
          <td class="num">${r.gasSum ? money(r.gasSum) : ''}</td>
          <td class="num">${r.benzinIn ? fmt(r.benzinIn, 2) : ''}</td>
          <td class="num">${r.benzinSum ? money(r.benzinSum) : ''}</td>
          <td class="num">${r.cost ? money(r.cost) : ''}</td>
        </tr>`).join('')}
        <tr><td><b>JAMI</b></td>
          <td class="num"><b>${fmt(ysum.km, 2)}</b></td>
          <td class="num"><b>${fmt(ysum.gasIn, 2)}</b></td>
          <td class="num"><b>${money(ysum.gasSum)}</b></td>
          <td class="num"><b>${fmt(ysum.benzinIn, 2)}</b></td>
          <td class="num"><b>${money(ysum.benzinSum)}</b></td>
          <td class="num"><b>${money(ysum.cost)}</b></td></tr>
        </tbody>
      </table>
    </div></div>`;
}

function docCell(car, key, rec) {
  const d = rec[key] || { due: '', months: 12 };
  const left = daysLeft(d.due);
  let cls = '', lab = 'kiritilmagan';
  if (left != null) {
    lab = left < 0 ? ('muddati o\'tgan ' + Math.abs(left) + ' kun') : (left + ' kun');
    if (left < 0) cls = 'st-dead';
    else if (left < 15) cls = 'st-hot';
    else if (left < 45) cls = 'st-mid';
    else cls = 'st-ok';
  }
  return `<td>
    <input type="date" data-doc="${esc(car)}" data-k="${key}" data-f="due" value="${esc(d.due || '')}">
    <div style="display:flex;gap:4px;align-items:center;margin-top:4px;">
      <input type="number" min="1" max="60" data-doc="${esc(car)}" data-k="${key}" data-f="months" value="${d.months || 12}" style="width:56px;height:26px;">
      <span class="muted">oy</span>
      <button type="button" class="btn btn-ink btn-sm doc-renew" data-doc="${esc(car)}" data-k="${key}">Yangilash</button>
    </div>
    <div class="badge ${cls}" style="margin-top:4px;height:auto;padding:3px 6px;">${esc(lab)}</div>
  </td>`;
}

function renderDocs() {
  const today = todayYmd();
  const alerts = collectDocAlerts();
  document.getElementById('panel-docs').innerHTML = `
    <div class="card"><div class="card-h"><h3>Hujjat muddatlari hisoboti — ${esc(today.split('-').reverse().join('.'))}</h3></div>
      <div class="card-b">
        <div class="hint">Muddat va davr (oy) ni qo'lda kiriting. <b>Yangilash</b> tugmasi muddatni shu davrga siljitadi. Yashil &gt;45 kun, sariq &lt;45, qizil &lt;15, to'q qizil — muddati o'tgan.</div>
        ${alerts.length ? `<div class="alert-box">${alerts.slice(0, 12).map(a =>
          `<div><b>${esc(plateDisp(a.car))}</b> ${esc(a.name)} — ${esc(a.title)} → ${a.left < 0 ? 'muddati o\'tgan' : (a.left + ' kun qoldi')}</div>`
        ).join('')}</div>` : ''}
        <div style="overflow:auto;">
          <table class="gtable">
            <thead><tr><th>№</th><th>Mashina</th><th>Haydovchi</th>${DOC_KEYS.map(d => `<th>${esc(d.t)}</th>`).join('')}</tr></thead>
            <tbody>${fleet().map((f, i) => {
              const rec = (STATE.meta.docs || {})[f.car] || {};
              return `<tr><td>${i + 1}</td><td>${esc(plateDisp(f.car))}</td><td>${esc(f.name)}</td>${DOC_KEYS.map(d => docCell(f.car, d.k, rec)).join('')}</tr>`;
            }).join('')}</tbody>
          </table>
        </div>
      </div></div>`;
  document.getElementById('panel-docs').querySelectorAll('input').forEach(el => {
    el.addEventListener('change', async () => {
      const plate = el.getAttribute('data-doc');
      const k = el.getAttribute('data-k');
      const f = el.getAttribute('data-f');
      if (!plate) return;
      STATE.meta.docs = STATE.meta.docs || {};
      if (!STATE.meta.docs[plate]) STATE.meta.docs[plate] = {};
      if (!STATE.meta.docs[plate][k]) STATE.meta.docs[plate][k] = { due: '', months: 12 };
      STATE.meta.docs[plate][k][f] = f === 'months' ? n(el.value) : el.value;
      await saveMeta();
      renderDocsBadge();
      renderDocs();
    });
  });
  document.querySelectorAll('.doc-renew').forEach(btn => {
    btn.onclick = async () => {
      const plate = btn.getAttribute('data-doc');
      const k = btn.getAttribute('data-k');
      STATE.meta.docs = STATE.meta.docs || {};
      if (!STATE.meta.docs[plate]) STATE.meta.docs[plate] = {};
      const rec = STATE.meta.docs[plate][k] || { due: todayYmd(), months: 12 };
      const months = n(rec.months) || 12;
      const base = rec.due && daysLeft(rec.due) != null ? rec.due : todayYmd();
      const d = new Date(base + 'T00:00:00');
      d.setMonth(d.getMonth() + months);
      rec.due = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      rec.months = months;
      STATE.meta.docs[plate][k] = rec;
      await saveMeta();
      renderDocsBadge();
      renderDocs();
    };
  });
}

function renderCars() {
  const list = fleet();
  document.getElementById('panel-cars').innerHTML = `
    <div class="card"><div class="card-h"><h3>Mashina va narx — qo'lda tahrirlash</h3></div>
      <div class="card-b">
        <div class="hint">Butun oy uchun haydovchi/marka/norma/narx shu yerda o'zgaradi. Oy o'rtasida haydovchi almashtirish uchun kunlik kiritishdagi <b>Haydovchini kun belgilab almashtirish</b> tugmasini bosing — zanjir buzilmaydi.</div>
        <div class="row-btns" style="margin:0 0 12px;">
          <input id="nv-car" placeholder="01 000 AAA" style="height:32px;padding:0 8px;border:1px solid var(--line);width:130px;">
          <input id="nv-name" placeholder="Haydovchi F.I.O." style="height:32px;padding:0 8px;border:1px solid var(--line);width:200px;">
          <input id="nv-brand" placeholder="Marka" style="height:32px;padding:0 8px;border:1px solid var(--line);width:140px;">
          <button class="btn btn-gold btn-sm" type="button" id="nv-add">Mashina qo'shish</button>
        </div>
        <div style="overflow:auto;">
          <table class="gtable">
            <thead><tr><th>№</th><th>Raqam</th><th>Marka</th><th>Haydovchi</th><th>Karta</th><th>Yoqilg'i</th><th>Gaz norma</th><th>Benzin/DT norma</th><th>Gaz narxi</th><th>Benzin/DT narxi</th><th></th></tr></thead>
            <tbody>${list.map((f, i) => `<tr data-plate="${esc(f.car)}">
              <td>${i + 1}</td>
              <td>${esc(plateDisp(f.car))}</td>
              <td><input data-v="brand" value="${esc(f.brand)}"></td>
              <td><input data-v="name" value="${esc(f.name)}"></td>
              <td><input data-v="card" value="${esc(f.card)}"></td>
              <td><select data-v="fuelType">
                <option value="mixed"${f.fuelType==='mixed'?' selected':''}>Gaz+benzin</option>
                <option value="gaz"${f.fuelType==='gaz'?' selected':''}>Gaz</option>
                <option value="benzin"${f.fuelType==='benzin'?' selected':''}>Benzin</option>
                <option value="dizel"${f.fuelType==='dizel'?' selected':''}>Dizel</option>
              </select></td>
              <td><input data-v="gasNorm" type="number" step="0.1" value="${vin(f.gasNorm)}"></td>
              <td><input data-v="benzinNorm" type="number" step="0.1" value="${vin(f.benzinNorm)}"></td>
              <td><input data-v="gasPrice" type="number" step="1" value="${vin(f.gasPrice)}"></td>
              <td><input data-v="benzinPrice" type="number" step="1" value="${vin(f.benzinPrice)}"></td>
              <td><button type="button" class="btn btn-ink btn-sm car-hide">O'chirish</button></td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </div></div>`;
  document.getElementById('nv-add').onclick = async () => {
    const car = (document.getElementById('nv-car').value || '').trim().toUpperCase();
    const name = (document.getElementById('nv-name').value || '').trim();
    const brand = (document.getElementById('nv-brand').value || '').trim();
    if (!car) return;
    const rec = ensureVehicleMeta(car);
    rec.name = name || car;
    rec.short = (name.split(' ')[0] || car);
    rec.brand = brand;
    rec.hidden = false;
    await saveMeta();
    renderChips();
    renderCars();
  };
  document.querySelectorAll('#panel-cars tr[data-plate]').forEach(tr => {
    const plate = tr.getAttribute('data-plate');
    tr.querySelectorAll('[data-v]').forEach(el => {
      el.addEventListener('change', async () => {
        const rec = ensureVehicleMeta(plate);
        const k = el.getAttribute('data-v');
        rec[k] = (k === 'name' || k === 'brand' || k === 'card' || k === 'fuelType') ? el.value : n(el.value);
        if (k === 'name') rec.short = (el.value.split(' ')[0] || rec.short);
        const monthCar = getCar(plate);
        if (k === 'gasNorm' || k === 'benzinNorm' || k === 'gasPrice' || k === 'benzinPrice' || k === 'fuelType') {
          monthCar[k] = rec[k];
          markDirty();
        }
        await saveMeta();
        if (plate === STATE.car) writeParams();
        renderChips();
      });
    });
    const hide = tr.querySelector('.car-hide');
    if (hide) hide.onclick = async () => {
      if (!confirm(plate + ' ni ro\'yxatdan yashirish?')) return;
      ensureVehicleMeta(plate).hidden = true;
      await saveMeta();
      if (STATE.car === plate) STATE.car = fleet()[0] && fleet()[0].car;
      renderAll();
    };
  });
}

function renderAll() {
  renderDocsBadge();
  renderChips();
  writeParams();
  renderDailyTable();
  if (STATE.tab === 'home') renderHome();
  if (STATE.tab === 'dayrep') renderDayRep();
  if (STATE.tab === 'month') renderMonth();
  if (STATE.tab === 'official') renderOfficial();
  if (STATE.tab === 'stations') renderStations();
  if (STATE.tab === 'gasact') renderGasAct();
  if (STATE.tab === 'year') renderYear();
  if (STATE.tab === 'docs') renderDocs();
  if (STATE.tab === 'journal' && window.VMJournal) window.VMJournal.render();
  if (STATE.tab === 'cars') renderCars();
}

function setTab(tab) {
  STATE.tab = tab;
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.getAttribute('data-tab') === tab));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('on'));
  const panel = document.getElementById('panel-' + tab);
  if (panel) panel.classList.add('on');
  renderAll();
}

function ensureDay(car, d) {
  if (!car.days) car.days = {};
  const k = String(d);
  if (!car.days[k]) car.days[k] = {};
  return car.days[k];
}

function kmLocked(row) {
  const src = row.kmSrc || (n(row.km) ? 'user' : '');
  return src === 'user' || src === 'odo';
}

function fillGpsPlate(plate, refreshGps) {
  let nFill = 0;
  Object.keys(STATE.gpsKm || {}).forEach(dt => {
    if (!dt.startsWith(STATE.month + '-')) return;
    const km = gpsKmLookup(STATE.gpsKm[dt], plate);
    if (!km) return;
    const day = Number(dt.slice(-2));
    const row = ensureDay(getCar(plate), day);
    if (kmLocked(row)) return;
    if (n(row.km) && !(refreshGps && row.kmSrc === 'gps')) return;
    row.km = km;
    row.kmSrc = 'gps';
    nFill += 1;
  });
  return nFill;
}

function applyPrevBalanceSilent(plate, prevRec, prevYm) {
  if (!prevRec) return false;
  const car = getCar(plate);
  if (n(car.odoStart) || n(car.gasStart) || n(car.benzinStart)) return false;
  const hold = STATE.month;
  STATE.month = prevYm;
  const rows = calcCar(prevRec);
  STATE.month = hold;
  const last = rows[rows.length - 1];
  if (!last) return false;
  car.gasStart = last.gasR;
  car.benzinStart = last.benR;
  let lastOdo = n(prevRec.odoStart);
  rows.forEach(r => { if (r.odo > 0) lastOdo = r.odo; });
  if (lastOdo) car.odoStart = lastOdo;
  if (n(prevRec.gasNorm)) car.gasNorm = n(prevRec.gasNorm);
  if (n(prevRec.benzinNorm)) car.benzinNorm = n(prevRec.benzinNorm);
  if (n(prevRec.gasPrice)) car.gasPrice = n(prevRec.gasPrice);
  if (n(prevRec.benzinPrice)) car.benzinPrice = n(prevRec.benzinPrice);
  return true;
}

async function autoChainMonth() {
  const [y, m] = STATE.month.split('-').map(Number);
  if (!y || !m) return;
  const prev = new Date(y, m - 2, 1);
  const prevYm = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');
  let prevCars = {};
  try {
    const d = await vmApi('/api/office/fuel/month?month=' + encodeURIComponent(prevYm));
    prevCars = (d.data && d.data.cars) || {};
  } catch (e) {}
  let gpsN = 0, balN = 0;
  fleet().forEach(f => {
    if (applyPrevBalanceSilent(f.car, prevCars[f.car], prevYm)) balN += 1;
    gpsN += fillGpsPlate(f.car, false);
  });
  const st = document.getElementById('save-st');
  const gpsDays = Object.keys(STATE.gpsKm || {}).filter(dt => dt.startsWith(STATE.month + '-')).length;
  if (gpsN || balN) {
    await saveMonth();
    if (st) st.textContent = 'Avto: GPS ' + gpsN + ' kun' + (balN ? ', qoldiq ' + balN + ' mashina' : '');
  } else if (st && !gpsDays) {
    st.textContent = 'GPS hisobot yo\'q — VHK da kun ochilsa km o\'zi tushadi';
  }
}

function fillFromOdo() {
  const car = getCar(STATE.car);
  const dim = daysInMonth(STATE.month);
  let prev = n(car.odoStart);
  for (let d = 1; d <= dim; d++) {
    const row = ensureDay(car, d);
    const odo = n(row.odo);
    if (odo > 0 && prev > 0 && odo + 0.0001 >= prev) {
      row.km = r4(odo - prev);
      row.kmSrc = 'odo';
    }
    if (odo > 0) prev = odo;
  }
  markDirty();
  renderDailyTable();
  toast('Spidometr bo\'yicha km to\'ldirildi');
}

function fillFromGps() {
  const nFill = fillGpsPlate(STATE.car, true);
  markDirty();
  renderDailyTable();
  toast(nFill ? (nFill + ' kun GPS dan yangilandi') : 'GPS km topilmadi yoki siz yozgan km saqlanadi');
}

async function fillPrevBalance() {
  const [y, m] = STATE.month.split('-').map(Number);
  const prev = new Date(y, m - 2, 1);
  const ym = prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');
  const d = await vmApi('/api/office/fuel/month?month=' + encodeURIComponent(ym));
  const rec = ((d.data || {}).cars || {})[STATE.car];
  if (!rec) { toast('Oldingi oyda bu mashina yo\'q'); return; }
  const hold = STATE.month;
  STATE.month = ym;
  const rows = calcCar(rec);
  STATE.month = hold;
  const last = rows[rows.length - 1];
  const car = getCar(STATE.car);
  car.gasStart = last ? last.gasR : n(rec.gasStart);
  car.benzinStart = last ? last.benR : n(rec.benzinStart);
  let lastOdo = n(rec.odoStart);
  rows.forEach(r => { if (r.odo > 0) lastOdo = r.odo; });
  car.odoStart = lastOdo;
  if (n(rec.gasNorm)) car.gasNorm = n(rec.gasNorm);
  if (n(rec.benzinNorm)) car.benzinNorm = n(rec.benzinNorm);
  if (n(rec.gasPrice)) car.gasPrice = n(rec.gasPrice);
  if (n(rec.benzinPrice)) car.benzinPrice = n(rec.benzinPrice);
  writeParams();
  markDirty();
  paintCalc();
  toast('Oldingi oy qoldig\'i olindi (manfiy bo\'lsa ham)');
}

function addChange() {
  const field = prompt('Qaysi maydon? gasNorm / benzinNorm / gasPrice / benzinPrice / mixPct', 'gasPrice');
  if (!field) return;
  const day = n(prompt('Qaysi kundan?', '1')) || 1;
  const value = n(prompt('Yangi qiymat?'));
  const note = prompt('Izoh (ixtiyoriy)', '') || '';
  const car = getCar(STATE.car);
  car.changes = car.changes || [];
  car.changes.push({ day, field, value, note });
  const dim = daysInMonth(STATE.month);
  for (let d = day; d <= dim; d++) {
    const row = ensureDay(car, d);
    if (field === 'gasPrice' || field === 'benzinPrice') row[field] = value;
  }
  if (['gasNorm','benzinNorm','gasPrice','benzinPrice','mixPct'].includes(field) && day === 1) car[field] = value;
  writeParams();
  markDirty();
  renderDailyTable();
}

function addDriverChange() {
  const day = n(prompt('Qaysi kundan yangi haydovchi?', '15')) || 1;
  const name = (prompt('Yangi haydovchi F.I.O.', '') || '').trim();
  if (!name) return;
  const car = getCar(STATE.car);
  car.driverChanges = car.driverChanges || [];
  car.driverChanges.push({ day, name });
  writeParams();
  markDirty();
  toast(day + '-kundan haydovchi: ' + name);
}

function exportExcel() {
  if (typeof XLSX === 'undefined') { toast('Excel kutubxonasi yuklanmadi'); return; }
  const wb = XLSX.utils.book_new();
  const monthRows = [['№','Mashina','Haydovchi','Km','Gaz m3','Gaz summa','Benzin l','Benzin summa','Qoshimcha','Jami','Gaz qoldiq','Benzin qoldiq']];
  fleet().forEach((f, i) => {
    const t = totals(calcCar(getCar(f.car)));
    monthRows.push([i + 1, f.car, f.name, t.km, t.gasIn, t.gasSum, t.benzinIn, t.benzinSum, t.extra, t.cost, t.gasR, t.benR]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(monthRows), 'Oylik');
  const daily = [['Kun','Km','Spidometr','Rejim','Zapravka','Gaz m3','Gaz summa','Benzin l','Benzin summa','Sarf gaz','Sarf benzin','Gaz qoldiq','Benzin qoldiq','Qoshimcha','Izoh']];
  calcCar(getCar(STATE.car)).forEach(r => {
    daily.push([r.d, r.km, r.odo, r.mode, r.station, r.gasIn, r.gasSum, r.benzinIn, r.benzinSum, r.gasUsed, r.benUsed, r.gasR, r.benR, r.extra, r.note]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(daily), 'Kunlik');
  const fills = [['Kun','Mashina','Zapravka','Tur','Miqdor','Narx','Summa']];
  collectFills().forEach(f => fills.push([f.d, f.plate, f.station, f.type, f.qty, f.price, f.sum]));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(fills), 'Zapravka');
  XLSX.writeFile(wb, 'yoqilgi-' + STATE.month + '.xlsx');
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify({ month: STATE.month, meta: STATE.meta, cars: STATE.cars }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'yoqilgi-zaxira-' + STATE.month + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Zaxira yuklab olindi');
}

async function restoreBackup(file) {
  const text = await file.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { toast('JSON o\'qilmadi'); return; }
  if (data.meta) {
    STATE.meta = normalizeMeta(data.meta);
    await saveMeta();
  }
  const month = data.month || STATE.month;
  const cars = data.cars || (data.data && data.data.cars);
  if (cars) {
    STATE.month = month;
    document.getElementById('month-input').value = month;
    STATE.cars = cars;
    await saveMonth();
  }
  setMonthLabel();
  renderAll();
  toast('Zaxiradan tiklandi');
}

async function reloadOriginal() {
  if (STATE.dirty && !confirm('Saqlanmagan o\'zgarishlar yo\'qoladi. Davom etasizmi?')) return;
  const [meta, month] = await Promise.all([
    vmApi('/api/office/fuel/meta'),
    vmApi('/api/office/fuel/month?month=' + encodeURIComponent(STATE.month))
  ]);
  STATE.meta = normalizeMeta(meta.meta);
  STATE.cars = (month.data && month.data.cars) || {};
  STATE.dirty = false;
  renderAll();
  toast('Serverdagi asl ma\'lumot yuklandi');
}

function bind() {
  document.getElementById('tabs').addEventListener('click', e => {
    const t = e.target.closest('.tab');
    if (t) setTab(t.getAttribute('data-tab'));
  });
  document.getElementById('chips').addEventListener('click', e => {
    const c = e.target.closest('.chip-car');
    if (!c) return;
    readParamsIntoCar();
    STATE.car = c.getAttribute('data-car');
    writeParams();
    renderChips();
    renderDailyTable();
  });
  document.querySelectorAll('[data-p]').forEach(el => {
    el.addEventListener('input', () => { readParamsIntoCar(); paintCalc(); markDirty(); });
  });
  document.getElementById('daily-body').addEventListener('input', e => {
    const el = e.target;
    const d = el.getAttribute('data-d');
    const f = el.getAttribute('data-f');
    if (!d || !f) return;
    const row = ensureDay(getCar(STATE.car), d);
    row[f] = (f === 'mode' || f === 'station' || f === 'extraWhy' || f === 'note') ? el.value : n(el.value);
    if (f === 'km' || f === 'odo') row.kmSrc = 'user';
    if (f === 'station' && el.value) {
      STATE.meta.stations = STATE.meta.stations || [];
      if (!STATE.meta.stations.includes(el.value)) {
        STATE.meta.stations.push(el.value);
        saveMeta();
        stationDatalist();
      }
    }
    paintCalc();
    markDirty();
  });
  document.getElementById('daily-body').addEventListener('change', e => {
    if (e.target.tagName === 'SELECT') e.target.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.getElementById('month-input').addEventListener('change', e => changeMonth(e.target.value));
  document.getElementById('btn-save').onclick = saveMonth;
  document.getElementById('btn-recalc').onclick = () => { paintCalc(); renderChips(); saveMonth(); toast('Zanjir yangilandi'); };
  document.getElementById('btn-fill-odo').onclick = fillFromOdo;
  document.getElementById('btn-gps-km').onclick = fillFromGps;
  document.getElementById('btn-prev-bal').onclick = () => fillPrevBalance().catch(err => toast(err.message));
  document.getElementById('btn-add-change').onclick = addChange;
  document.getElementById('btn-drv-change').onclick = addDriverChange;
  document.getElementById('btn-excel').onclick = exportExcel;
  document.getElementById('btn-backup').onclick = downloadBackup;
  document.getElementById('btn-restore').onclick = () => document.getElementById('restore-file').click();
  document.getElementById('restore-file').onchange = e => {
    const f = e.target.files && e.target.files[0];
    if (f) restoreBackup(f).catch(err => toast(err.message));
    e.target.value = '';
  };
  document.getElementById('btn-reload').onclick = () => reloadOriginal().catch(err => toast(err.message));
  document.getElementById('docs-badge').onclick = () => setTab('docs');
  document.getElementById('btn-logout').onclick = () => vmLogout();
  window.addEventListener('beforeunload', e => {
    if (STATE.dirty) { e.preventDefault(); e.returnValue = ''; }
  });
}

(async function init() {
  const user = await vmMe();
  vmApplyChrome(user);
  vmStartHeartbeat();
  bind();
  await loadAll();
})().catch(err => {
  toast(err.message || 'Yuklanmadi');
});
