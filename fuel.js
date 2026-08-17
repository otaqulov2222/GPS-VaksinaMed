'use strict';

const UZ_M = ['YANVAR','FEVRAL','MART','APREL','MAY','IYUN','IYUL','AVGUST','SENTABR','OKTABR','NOYABR','DEKABR'];
const MODES = [
  { v: 'gaz', t: 'Gaz' },
  { v: 'benzin', t: 'Benzin' },
  { v: 'aralash', t: 'Aralash' },
  { v: 'dizel', t: 'Dizel' }
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
  { car: '01 331 MLA', name: 'Ахтамов', short: 'Ахтамов', extra: true },
  { car: '01 406 GNA', name: '01 406 GNA', short: '406 GNA', extra: true },
  { car: '01 567 SGA', name: '01 567 SGA', short: '567 SGA', extra: true }
];

const STATE = {
  tab: 'daily',
  month: '',
  car: '',
  meta: { vehicles: {}, stations: [], docs: [] },
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
  const x = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(x) ? x : 0;
}
function fmt(v, d) {
  const x = n(v);
  if (!x && x !== 0) return '';
  const p = d == null ? (Math.abs(x) >= 100 ? 0 : 1) : d;
  return x.toLocaleString('uz-UZ', { maximumFractionDigits: p, minimumFractionDigits: 0 });
}
function money(v) {
  return Math.round(n(v)).toLocaleString('uz-UZ');
}
function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}
function plateCode(car) {
  const m = String(car).match(/(\d{3})/);
  return m ? m[1] : String(car).slice(-3);
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
function todayYmd() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('on');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('on'), 2200);
}

function fleet() {
  const map = {};
  DEFAULT_FLEET.forEach(d => { map[d.car] = Object.assign({}, d); });
  const extra = STATE.meta.vehicles || {};
  Object.keys(extra).forEach(car => {
    const v = extra[car] || {};
    map[car] = Object.assign({}, map[car] || { car, extra: true }, {
      car,
      name: v.name || (map[car] && map[car].name) || car,
      short: v.short || v.name || (map[car] && map[car].short) || car,
      fuelType: v.fuelType || (map[car] && map[car].fuelType) || 'gaz'
    });
  });
  return Object.keys(map).sort().map(k => map[k]);
}

function blankCar(info) {
  const diesel = (info && info.fuelType) === 'dizel';
  return {
    gasNorm: 12,
    benzinNorm: diesel ? 10 : 4,
    odoStart: 0,
    gasStart: 0,
    benzinStart: 0,
    gasPrice: 5200,
    benzinPrice: 11000,
    mixPct: 70,
    fuelType: diesel ? 'dizel' : 'gaz',
    changes: [],
    days: {}
  };
}

function getCar(plate) {
  if (!STATE.cars[plate]) {
    const info = fleet().find(f => f.car === plate);
    STATE.cars[plate] = blankCar(info);
  }
  return STATE.cars[plate];
}

function dayRow(car, d) {
  const src = (car.days && car.days[d]) || (car.days && car.days[String(d)]) || {};
  return {
    km: n(src.km),
    odo: n(src.odo),
    mode: src.mode || (car.fuelType === 'dizel' ? 'dizel' : 'gaz'),
    station: src.station || '',
    gasIn: n(src.gasIn),
    gasPrice: n(src.gasPrice) || n(car.gasPrice),
    benzinIn: n(src.benzinIn),
    benzinPrice: n(src.benzinPrice) || n(car.benzinPrice),
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
  let gasR = n(car.gasStart);
  let benR = n(car.benzinStart);
  const rows = [];
  for (let d = 1; d <= dim; d++) {
    const src = dayRow(car, d);
    const gasPrice = n(src.gasPrice) || applyChanges(car, d, 'gasPrice', n(car.gasPrice));
    const benPrice = n(src.benzinPrice) || applyChanges(car, d, 'benzinPrice', n(car.benzinPrice));
    const gasNorm = applyChanges(car, d, 'gasNorm', n(car.gasNorm));
    const benNorm = applyChanges(car, d, 'benzinNorm', n(car.benzinNorm));
    const mix = applyChanges(car, d, 'mixPct', n(car.mixPct) || 70);
    let km = n(src.km);
    if (!km && src.odo > 0 && odoPrev > 0 && src.odo >= odoPrev) km = src.odo - odoPrev;
    if (src.odo > 0) odoPrev = src.odo;
    else if (km > 0) odoPrev += km;
    let gasUsed = 0, benUsed = 0;
    if (km > 0) {
      if (src.mode === 'gaz') gasUsed = km * gasNorm / 100;
      else if (src.mode === 'benzin' || src.mode === 'dizel') benUsed = km * benNorm / 100;
      else if (src.mode === 'aralash') {
        gasUsed = km * gasNorm / 100 * mix / 100;
        benUsed = km * benNorm / 100 * (100 - mix) / 100;
      }
    }
    gasR = gasR + src.gasIn - gasUsed;
    benR = benR + src.benzinIn - benUsed;
    rows.push({
      d, km, odo: src.odo, mode: src.mode, station: src.station,
      gasIn: src.gasIn, gasPrice, gasSum: src.gasIn * gasPrice,
      benzinIn: src.benzinIn, benzinPrice: benPrice, benzinSum: src.benzinIn * benPrice,
      gasUsed, benUsed, gasR, benR,
      extra: src.extra, extraWhy: src.extraWhy, note: src.note
    });
  }
  return rows;
}

function totals(rows) {
  const t = { km: 0, gasIn: 0, benzinIn: 0, gasUsed: 0, benUsed: 0, gasSum: 0, benzinSum: 0, extra: 0 };
  rows.forEach(r => {
    t.km += r.km; t.gasIn += r.gasIn; t.benzinIn += r.benzinIn;
    t.gasUsed += r.gasUsed; t.benUsed += r.benUsed;
    t.gasSum += r.gasSum; t.benzinSum += r.benzinSum; t.extra += r.extra;
  });
  t.cost = t.gasSum + t.benzinSum + t.extra;
  if (rows.length) {
    t.gasR = rows[rows.length - 1].gasR;
    t.benR = rows[rows.length - 1].benR;
    t.odo = rows.reduce((m, r) => r.odo > m ? r.odo : m, 0);
  }
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
  STATE.saveTimer = setTimeout(saveMonth, 900);
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
  STATE.meta = meta.meta || { vehicles: {}, stations: [], docs: [] };
  STATE.cars = (month.data && month.data.cars) || {};
  STATE.gpsKm = gps.days || {};
  if (!STATE.car) STATE.car = fleet()[0].car;
  setMonthLabel();
  renderAll();
}

async function changeMonth(ym) {
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
  setMonthLabel();
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
    const touched = n(c.odoStart) || n(c.gasStart) || n(c.benzinStart) || (c.changes && c.changes.length) || hasDays;
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
  STATE.meta = d.meta || STATE.meta;
}

function readParamsIntoCar() {
  const car = getCar(STATE.car);
  document.querySelectorAll('[data-p]').forEach(el => {
    car[el.getAttribute('data-p')] = n(el.value);
  });
}

function writeParams() {
  const car = getCar(STATE.car);
  ['gasNorm','benzinNorm','odoStart','gasStart','benzinStart','gasPrice','benzinPrice','mixPct'].forEach(k => {
    const el = document.getElementById('p-' + k);
    if (el) el.value = car[k] ?? '';
  });
  const info = fleet().find(f => f.car === STATE.car) || { car: STATE.car, name: STATE.car };
  document.getElementById('car-title').textContent = info.car + ' — ' + (info.name || info.short || '');
  const ch = car.changes || [];
  document.getElementById('changes-box').innerHTML = ch.length
    ? 'O\'zgarishlar: ' + ch.map(c => esc(c.day + '-kun ' + c.field + '=' + c.value + (c.note ? ' (' + c.note + ')' : ''))).join(' · ')
    : '';
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

function renderDailyTable() {
  const car = getCar(STATE.car);
  const rows = calcCar(car);
  stationDatalist();
  const body = document.getElementById('daily-body');
  body.innerHTML = rows.map(r => {
    const src = dayRow(car, r.d);
    const gNeg = r.gasR < -0.05 ? ' neg' : '';
    const bNeg = r.benR < -0.05 ? ' neg' : '';
    return `<tr>
      <td class="day">${r.d}</td>
      <td><input data-d="${r.d}" data-f="km" type="number" step="1" value="${src.km || ''}"></td>
      <td><input data-d="${r.d}" data-f="odo" type="number" step="1" value="${src.odo || ''}"></td>
      <td>${modeSelect(r.d, src.mode)}</td>
      <td>${stationSelect(r.d, src.station)}</td>
      <td><input data-d="${r.d}" data-f="gasIn" type="number" step="0.1" value="${src.gasIn || ''}"></td>
      <td><input data-d="${r.d}" data-f="gasPrice" type="number" step="1" value="${r.gasPrice || ''}"></td>
      <td><span class="out">${r.gasIn ? money(r.gasSum) : ''}</span></td>
      <td><input data-d="${r.d}" data-f="benzinIn" type="number" step="0.1" value="${src.benzinIn || ''}"></td>
      <td><input data-d="${r.d}" data-f="benzinPrice" type="number" step="1" value="${r.benzinPrice || ''}"></td>
      <td><span class="out">${r.benzinIn ? money(r.benzinSum) : ''}</span></td>
      <td><span class="out">${r.km ? r.gasUsed.toFixed(2) : ''}</span></td>
      <td><span class="out">${r.km ? r.benUsed.toFixed(2) : ''}</span></td>
      <td><span class="out${gNeg}">${r.km || r.gasIn ? r.gasR.toFixed(2) : ''}</span></td>
      <td><span class="out${bNeg}">${r.km || r.benzinIn ? r.benR.toFixed(2) : ''}</span></td>
      <td><input data-d="${r.d}" data-f="extra" type="number" step="1" value="${src.extra || ''}"></td>
      <td><input class="w-note" data-d="${r.d}" data-f="extraWhy" value="${esc(src.extraWhy)}"></td>
      <td><input class="w-note" data-d="${r.d}" data-f="note" value="${esc(src.note)}"></td>
    </tr>`;
  }).join('');
}

function paintCalc() {
  const car = getCar(STATE.car);
  const rows = calcCar(car);
  const trs = document.querySelectorAll('#daily-body tr');
  trs.forEach((tr, i) => {
    const r = rows[i];
    if (!r) return;
    const outs = tr.querySelectorAll('.out');
    if (outs[0]) outs[0].textContent = r.gasIn ? money(r.gasSum) : '';
    if (outs[1]) outs[1].textContent = r.benzinIn ? money(r.benzinSum) : '';
    if (outs[2]) outs[2].textContent = r.km ? r.gasUsed.toFixed(2) : '';
    if (outs[3]) outs[3].textContent = r.km ? r.benUsed.toFixed(2) : '';
    if (outs[4]) {
      outs[4].textContent = (r.km || r.gasIn) ? r.gasR.toFixed(2) : '';
      outs[4].classList.toggle('neg', r.gasR < -0.05);
    }
    if (outs[5]) {
      outs[5].textContent = (r.km || r.benzinIn) ? r.benR.toFixed(2) : '';
      outs[5].classList.toggle('neg', r.benR < -0.05);
    }
  });
}

function fleetTotals() {
  const t = { km: 0, gasIn: 0, benzinIn: 0, gasUsed: 0, benUsed: 0, cost: 0, extra: 0, cars: 0 };
  fleet().forEach(f => {
    const rows = calcCar(getCar(f.car));
    const x = totals(rows);
    if (x.km || x.gasIn || x.benzinIn) t.cars += 1;
    t.km += x.km; t.gasIn += x.gasIn; t.benzinIn += x.benzinIn;
    t.gasUsed += x.gasUsed; t.benUsed += x.benUsed; t.cost += x.cost; t.extra += x.extra;
  });
  return t;
}

function dueDocs() {
  const today = todayYmd();
  return (STATE.meta.docs || []).filter(d => d.due && d.due <= addDays(today, 30));
}
function addDays(ymd, nDays) {
  const d = new Date(ymd + 'T00:00:00');
  d.setDate(d.getDate() + nDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function renderDocsBadge() {
  const nDue = dueDocs().length;
  const el = document.getElementById('docs-badge');
  if (!nDue) { el.style.display = 'none'; return; }
  el.style.display = 'inline-flex';
  el.textContent = nDue + ' hujjat muddati';
}

function renderHome() {
  const t = fleetTotals();
  const due = dueDocs();
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
      <div class="kpi"><i>Jami km</i><b>${fmt(t.km, 0)}</b><s>${monthTitle(STATE.month)}</s></div>
      <div class="kpi"><i>Gaz sarfi / olingan</i><b>${fmt(t.gasUsed)} m³</b><s>olingan ${fmt(t.gasIn)} m³</s></div>
      <div class="kpi"><i>Benzin sarfi / olingan</i><b>${fmt(t.benUsed)} l</b><s>olingan ${fmt(t.benzinIn)} l</s></div>
      <div class="kpi"><i>Yoqilg'i xarajati</i><b>${money(t.cost)}</b><s>qo'shimcha ${money(t.extra)}</s></div>
      <div class="kpi"><i>GPS dan bo'sh kunlar</i><b>${missing.length}</b><s>km bor, yoqilg'i yo'q</s></div>
      <div class="kpi"><i>Hujjat muddati</i><b>${due.length}</b><s>30 kun ichida</s></div>
      <div class="kpi"><i>Zapravka</i><b>${(STATE.meta.stations || []).length}</b><s>reestr</s></div>
    </div>
    <div class="card"><div class="card-h"><h3>GPS bor — kunlik km kiritilmagan</h3></div>
      <div class="card-b">${missing.length ? `<table class="gtable"><thead><tr><th>Sana</th><th>Mashina</th><th>GPS km</th></tr></thead><tbody>
        ${missing.slice(0, 80).map(m => `<tr><td>${esc(m.dt)}</td><td>${esc(m.car)} ${esc(m.short)}</td><td class="num">${m.km}</td></tr>`).join('')}
      </tbody></table>` : '<p class="note">Hamma GPS km lar kiritilgan yoki bu oyda GPS hisobot yo\'q.</p>'}
      </div></div>`;
}

function renderDayRep() {
  const dim = daysInMonth(STATE.month);
  const today = new Date().getDate();
  const [y, m] = STATE.month.split('-').map(Number);
  const now = new Date();
  const def = (now.getFullYear() === y && now.getMonth() + 1 === m) ? Math.min(today, dim) : 1;
  const day = n(document.getElementById('dayrep-day') && document.getElementById('dayrep-day').value) || def;
  const rows = fleet().map(f => {
    const r = calcCar(getCar(f.car))[day - 1];
    return Object.assign({ plate: f.car, name: f.short }, r || {});
  });
  document.getElementById('panel-dayrep').innerHTML = `
    <div class="card"><div class="card-h">
      <h3>Kun hisoboti — ${day}.${STATE.month.slice(5)}.${STATE.month.slice(0,4)}</h3>
      <label class="muted">Kun <input id="dayrep-day" type="number" min="1" max="${dim}" value="${day}" style="width:64px;height:28px;margin-left:6px;"></label>
    </div>
    <div class="card-b" style="overflow:auto;">
      <table class="gtable">
        <thead><tr><th>Mashina</th><th>Haydovchi</th><th>Km</th><th>Rejim</th><th>Gaz olindi</th><th>Benzin olindi</th><th>Sarf gaz</th><th>Sarf benzin</th><th>Summa</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${esc(r.plate)}</td><td>${esc(r.name)}</td>
          <td class="num">${r.km ? fmt(r.km,0) : ''}</td><td>${esc(r.mode || '')}</td>
          <td class="num">${r.gasIn ? fmt(r.gasIn) : ''}</td>
          <td class="num">${r.benzinIn ? fmt(r.benzinIn) : ''}</td>
          <td class="num">${r.gasUsed ? r.gasUsed.toFixed(2) : ''}</td>
          <td class="num">${r.benUsed ? r.benUsed.toFixed(2) : ''}</td>
          <td class="num">${(r.gasSum || r.benzinSum || r.extra) ? money((r.gasSum||0)+(r.benzinSum||0)+(r.extra||0)) : ''}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div></div>`;
  document.getElementById('dayrep-day').onchange = () => renderDayRep();
}

function renderMonth() {
  const rows = fleet().map(f => {
    const t = totals(calcCar(getCar(f.car)));
    return Object.assign({ plate: f.car, name: f.name, short: f.short }, t);
  });
  const sum = rows.reduce((a, r) => {
    a.km += r.km || 0; a.gasIn += r.gasIn || 0; a.benzinIn += r.benzinIn || 0;
    a.gasUsed += r.gasUsed || 0; a.benUsed += r.benUsed || 0; a.cost += r.cost || 0;
    return a;
  }, { km: 0, gasIn: 0, benzinIn: 0, gasUsed: 0, benUsed: 0, cost: 0 });
  document.getElementById('panel-month').innerHTML = `
    <div class="card"><div class="card-h"><h3>Oylik hisobot — ${esc(monthTitle(STATE.month))}</h3>
      <button class="btn btn-ink btn-sm no-print" type="button" onclick="window.print()">Chop etish</button></div>
    <div class="card-b" style="overflow:auto;">
      <table class="gtable">
        <thead><tr><th>Mashina</th><th>Haydovchi</th><th>Km</th><th>Gaz olindi</th><th>Gaz sarf</th><th>Gaz qoldiq</th><th>Benzin olindi</th><th>Benzin sarf</th><th>Benzin qoldiq</th><th>Jami so'm</th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${esc(r.plate)}</td><td>${esc(r.short)}</td>
          <td class="num">${fmt(r.km,0)}</td>
          <td class="num">${fmt(r.gasIn)}</td><td class="num">${fmt(r.gasUsed)}</td><td class="num">${fmt(r.gasR)}</td>
          <td class="num">${fmt(r.benzinIn)}</td><td class="num">${fmt(r.benUsed)}</td><td class="num">${fmt(r.benR)}</td>
          <td class="num">${money(r.cost)}</td>
        </tr>`).join('')}
        <tr><td colspan="2"><b>Jami</b></td>
          <td class="num"><b>${fmt(sum.km,0)}</b></td>
          <td class="num"><b>${fmt(sum.gasIn)}</b></td><td class="num"><b>${fmt(sum.gasUsed)}</b></td><td></td>
          <td class="num"><b>${fmt(sum.benzinIn)}</b></td><td class="num"><b>${fmt(sum.benUsed)}</b></td><td></td>
          <td class="num"><b>${money(sum.cost)}</b></td></tr>
        </tbody>
      </table>
    </div></div>`;
}

function renderOfficial() {
  const rows = fleet().map(f => {
    const t = totals(calcCar(getCar(f.car)));
    return Object.assign({ plate: f.car, name: f.name }, t);
  }).filter(r => r.km || r.gasIn || r.benzinIn);
  document.getElementById('panel-official').innerHTML = `
    <div class="card">
      <div class="card-h no-print"><h3>Rasmiy hisobot</h3>
        <button class="btn btn-gold btn-sm" type="button" onclick="window.print()">Chop etish / PDF</button></div>
      <div class="card-b">
        <div style="text-align:center;margin-bottom:16px;">
          <div style="font-size:11px;letter-spacing:.16em;font-weight:700;">VAKSINA MED</div>
          <div style="font-size:18px;font-weight:700;margin-top:4px;">Yoqilg'i sarfi rasmiy hisoboti</div>
          <div class="muted">${esc(monthTitle(STATE.month))}</div>
        </div>
        <table class="gtable">
          <thead><tr><th>№</th><th>Davlat raqami</th><th>Haydovchi</th><th>Yurgan km</th><th>Gaz (m³) olindi / sarf / qoldiq</th><th>Benzin (l) olindi / sarf / qoldiq</th><th>Summa (so'm)</th></tr></thead>
          <tbody>${rows.map((r,i) => `<tr>
            <td>${i+1}</td><td>${esc(r.plate)}</td><td>${esc(r.name)}</td>
            <td class="num">${fmt(r.km,0)}</td>
            <td class="num">${fmt(r.gasIn)} / ${fmt(r.gasUsed)} / ${fmt(r.gasR)}</td>
            <td class="num">${fmt(r.benzinIn)} / ${fmt(r.benUsed)} / ${fmt(r.benR)}</td>
            <td class="num">${money(r.cost)}</td>
          </tr>`).join('')}</tbody>
        </table>
        <p class="note" style="margin-top:18px;">Hisob: sarf = km × norma / 100. Aralashda gaz foizi bo'yicha. Qoldiq = oldingi qoldiq + olingan − sarf.</p>
        <p class="note">Tuzuvchi: _________________ &nbsp;&nbsp; Tasdiqlovchi: _________________</p>
      </div>
    </div>`;
}

function collectFills() {
  const out = [];
  fleet().forEach(f => {
    calcCar(getCar(f.car)).forEach(r => {
      if (r.gasIn > 0 || r.benzinIn > 0) {
        out.push({
          plate: f.car, name: f.short, d: r.d,
          station: r.station, gasIn: r.gasIn, gasSum: r.gasSum,
          benzinIn: r.benzinIn, benzinSum: r.benzinSum
        });
      }
    });
  });
  return out;
}

function renderStations() {
  const fills = collectFills();
  const used = {};
  fills.forEach(f => { if (f.station) used[f.station] = (used[f.station] || 0) + 1; });
  const list = STATE.meta.stations || [];
  document.getElementById('panel-stations').innerHTML = `
    <div class="card"><div class="card-h"><h3>Zapravka reestri</h3></div>
      <div class="card-b">
        <div class="row-btns" style="margin:0 0 12px;">
          <input id="st-new" placeholder="Yangi zapravka nomi" style="height:32px;padding:0 8px;border:1px solid var(--line);min-width:220px;">
          <button class="btn btn-gold btn-sm" type="button" id="st-add">Qo'shish</button>
        </div>
        <table class="gtable"><thead><tr><th>Nomi</th><th>Bu oyda</th><th></th></tr></thead>
        <tbody>${list.map((s,i) => `<tr><td>${esc(s)}</td><td class="num">${used[s] || 0}</td>
          <td><button class="btn btn-ink btn-sm st-del" data-i="${i}" type="button">O'chirish</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">Hali zapravka yo\'q</td></tr>'}
        </tbody></table>
      </div></div>
    <div class="card"><div class="card-h"><h3>Bu oydagi quyishlar</h3></div>
      <div class="card-b" style="overflow:auto;">
        <table class="gtable"><thead><tr><th>Kun</th><th>Mashina</th><th>Zapravka</th><th>Gaz m³</th><th>Gaz so'm</th><th>Benzin l</th><th>Benzin so'm</th></tr></thead>
        <tbody>${fills.map(f => `<tr>
          <td>${f.d}</td><td>${esc(f.plate)}</td><td>${esc(f.station)}</td>
          <td class="num">${f.gasIn ? fmt(f.gasIn) : ''}</td><td class="num">${f.gasIn ? money(f.gasSum) : ''}</td>
          <td class="num">${f.benzinIn ? fmt(f.benzinIn) : ''}</td><td class="num">${f.benzinIn ? money(f.benzinSum) : ''}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="muted">Quyish yo\'q</td></tr>'}</tbody></table>
      </div></div>`;
  document.getElementById('st-add').onclick = async () => {
    const v = (document.getElementById('st-new').value || '').trim();
    if (!v) return;
    STATE.meta.stations = STATE.meta.stations || [];
    if (!STATE.meta.stations.includes(v)) STATE.meta.stations.push(v);
    await saveMeta();
    renderStations();
    if (STATE.tab === 'daily') renderDailyTable();
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
  const fills = collectFills().filter(f => f.gasIn > 0);
  const sum = fills.reduce((a, f) => { a.m3 += f.gasIn; a.sum += f.gasSum; return a; }, { m3: 0, sum: 0 });
  document.getElementById('panel-gasact').innerHTML = `
    <div class="card">
      <div class="card-h no-print"><h3>Gaz akti</h3>
        <button class="btn btn-gold btn-sm" type="button" onclick="window.print()">Chop etish</button></div>
      <div class="card-b">
        <div style="text-align:center;margin-bottom:14px;">
          <div style="font-size:11px;letter-spacing:.16em;font-weight:700;">VAKSINA MED</div>
          <div style="font-size:18px;font-weight:700;margin-top:4px;">Gaz olish akti</div>
          <div class="muted">${esc(monthTitle(STATE.month))}</div>
        </div>
        <table class="gtable">
          <thead><tr><th>№</th><th>Kun</th><th>Mashina</th><th>Zapravka</th><th>Gaz (m³)</th><th>Summa (so'm)</th></tr></thead>
          <tbody>${fills.map((f,i) => `<tr>
            <td>${i+1}</td><td>${f.d}</td><td>${esc(f.plate)} ${esc(f.name)}</td>
            <td>${esc(f.station)}</td><td class="num">${fmt(f.gasIn)}</td><td class="num">${money(f.gasSum)}</td>
          </tr>`).join('')}
          <tr><td colspan="4"><b>Jami</b></td><td class="num"><b>${fmt(sum.m3)}</b></td><td class="num"><b>${money(sum.sum)}</b></td></tr>
          </tbody>
        </table>
        <p class="note" style="margin-top:18px;">Imzo: _________________</p>
      </div>
    </div>`;
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
  const body = fleet().map(f => {
    const cells = months.map(ym => {
      const saved = currentMonth === ym ? STATE.cars : ((STATE.yearMonths[ym] || {}).cars || {});
      const rec = saved[f.car];
      if (!rec) return { km: 0, cost: 0 };
      STATE.month = ym;
      const t = totals(calcCar(rec));
      STATE.month = currentMonth;
      return t;
    });
    return { f, cells, km: cells.reduce((s, c) => s + (c.km || 0), 0), cost: cells.reduce((s, c) => s + (c.cost || 0), 0) };
  });
  document.getElementById('panel-year').innerHTML = `
    <div class="card"><div class="card-h"><h3>Yillik jamlanma — ${esc(year)}</h3></div>
    <div class="card-b" style="overflow:auto;">
      <table class="gtable">
        <thead><tr><th>Mashina</th>${months.map(ym => `<th>${UZ_M[Number(ym.slice(5))-1].slice(0,3)}</th>`).join('')}<th>Km</th><th>So'm</th></tr></thead>
        <tbody>${body.map(r => `<tr>
          <td>${esc(r.f.short)}<div class="muted">${esc(r.f.car)}</div></td>
          ${r.cells.map(c => `<td class="num">${c.km ? fmt(c.km,0) : ''}</td>`).join('')}
          <td class="num"><b>${fmt(r.km,0)}</b></td>
          <td class="num">${money(r.cost)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div></div>`;
}

function renderDocs() {
  const docs = STATE.meta.docs || [];
  const today = todayYmd();
  document.getElementById('panel-docs').innerHTML = `
    <div class="card"><div class="card-h"><h3>Hujjat muddatlari</h3></div>
      <div class="card-b">
        <div class="params" style="margin-bottom:12px;">
          <div class="fld"><label>Nomi</label><input id="doc-title"></div>
          <div class="fld"><label>Muddat</label><input id="doc-due" type="date"></div>
          <div class="fld"><label>Mashina</label><input id="doc-car" placeholder="01 282 BMA"></div>
          <div class="fld"><label>Izoh</label><input id="doc-note"></div>
        </div>
        <button class="btn btn-gold btn-sm" type="button" id="doc-add">Qo'shish</button>
        <div style="overflow:auto;margin-top:12px;">
          <table class="gtable"><thead><tr><th>Hujjat</th><th>Muddat</th><th>Mashina</th><th>Izoh</th><th></th></tr></thead>
          <tbody>${docs.map((d,i) => {
            const late = d.due && d.due < today;
            const soon = d.due && d.due >= today && d.due <= addDays(today, 30);
            const col = late ? ' style="color:#9b1c1c;font-weight:700"' : (soon ? ' style="color:#8a5a12;font-weight:700"' : '');
            return `<tr>
              <td>${esc(d.title)}</td><td${col}>${esc(d.due)}</td><td>${esc(d.car)}</td><td>${esc(d.note)}</td>
              <td><button class="btn btn-ink btn-sm doc-del" data-i="${i}" type="button">O'chirish</button></td>
            </tr>`;
          }).join('') || '<tr><td colspan="5" class="muted">Hujjat yo\'q</td></tr>'}</tbody></table>
        </div>
      </div></div>`;
  document.getElementById('doc-add').onclick = async () => {
    const title = (document.getElementById('doc-title').value || '').trim();
    if (!title) return;
    STATE.meta.docs = STATE.meta.docs || [];
    STATE.meta.docs.push({
      id: 'doc' + Date.now(),
      title,
      due: document.getElementById('doc-due').value || '',
      car: document.getElementById('doc-car').value.trim(),
      note: document.getElementById('doc-note').value.trim()
    });
    await saveMeta();
    renderDocsBadge();
    renderDocs();
  };
  document.querySelectorAll('.doc-del').forEach(btn => {
    btn.onclick = async () => {
      STATE.meta.docs.splice(Number(btn.getAttribute('data-i')), 1);
      await saveMeta();
      renderDocsBadge();
      renderDocs();
    };
  });
}

function renderCars() {
  const list = fleet();
  document.getElementById('panel-cars').innerHTML = `
    <div class="card"><div class="card-h"><h3>Mashina va asosiy narx / norma</h3></div>
      <div class="card-b">
        <p class="note" style="margin-bottom:10px;">GPS parkdagi 20 ta mashina + GPS da qo'shimcha uchragan raqamlar. Yangi mashina qo'shish mumkin. Norma va narx har oyda «Kunlik kiritish»da alohida saqlanadi.</p>
        <div class="row-btns" style="margin:0 0 12px;">
          <input id="nv-car" placeholder="01 000 AAA" style="height:32px;padding:0 8px;border:1px solid var(--line);width:130px;">
          <input id="nv-name" placeholder="Familiya" style="height:32px;padding:0 8px;border:1px solid var(--line);width:180px;">
          <button class="btn btn-gold btn-sm" type="button" id="nv-add">Mashina qo'shish</button>
        </div>
        <div style="overflow:auto;">
          <table class="gtable"><thead><tr><th>Raqam</th><th>Haydovchi</th><th>Tur</th><th>Bu oy km</th><th>Bu oy so'm</th></tr></thead>
          <tbody>${list.map(f => {
            const t = totals(calcCar(getCar(f.car)));
            return `<tr><td>${esc(f.car)}</td><td>${esc(f.name)}</td><td>${esc(f.fuelType || 'gaz')}</td>
              <td class="num">${fmt(t.km,0)}</td><td class="num">${money(t.cost)}</td></tr>`;
          }).join('')}</tbody></table>
        </div>
      </div></div>`;
  document.getElementById('nv-add').onclick = async () => {
    const car = (document.getElementById('nv-car').value || '').trim().toUpperCase();
    const name = (document.getElementById('nv-name').value || '').trim();
    if (!car) return;
    STATE.meta.vehicles = STATE.meta.vehicles || {};
    STATE.meta.vehicles[car] = { name: name || car, short: (name.split(' ')[0] || car), fuelType: 'gaz' };
    await saveMeta();
    renderChips();
    renderCars();
  };
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

function fillFromOdo() {
  const car = getCar(STATE.car);
  const dim = daysInMonth(STATE.month);
  let prev = n(car.odoStart);
  for (let d = 1; d <= dim; d++) {
    const row = ensureDay(car, d);
    const odo = n(row.odo);
    if (odo > 0 && prev > 0 && odo >= prev) row.km = odo - prev;
    if (odo > 0) prev = odo;
  }
  markDirty();
  renderDailyTable();
  toast('Spidometr bo\'yicha km to\'ldirildi');
}

function fillFromGps() {
  const plate = STATE.car;
  let nFill = 0;
  Object.keys(STATE.gpsKm).forEach(dt => {
    if (!dt.startsWith(STATE.month + '-')) return;
    const km = gpsKmLookup(STATE.gpsKm[dt], plate);
    if (!km) return;
    const day = Number(dt.slice(-2));
    const row = ensureDay(getCar(plate), day);
    if (!n(row.km)) { row.km = km; nFill += 1; }
  });
  markDirty();
  renderDailyTable();
  toast(nFill ? (nFill + ' kun GPS dan to\'ldirildi') : 'Bu mashina uchun GPS km topilmadi yoki allaqachon kiritilgan');
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
  car.gasStart = last ? Math.max(0, last.gasR) : n(rec.gasStart);
  car.benzinStart = last ? Math.max(0, last.benR) : n(rec.benzinStart);
  car.odoStart = last && last.odo ? last.odo : n(rec.odoStart);
  if (n(rec.gasNorm)) car.gasNorm = n(rec.gasNorm);
  if (n(rec.benzinNorm)) car.benzinNorm = n(rec.benzinNorm);
  if (n(rec.gasPrice)) car.gasPrice = n(rec.gasPrice);
  if (n(rec.benzinPrice)) car.benzinPrice = n(rec.benzinPrice);
  writeParams();
  markDirty();
  paintCalc();
  toast('Oldingi oy qoldig\'i olindi');
}

function addChange() {
  const field = prompt('Qaysi maydon? gasNorm / benzinNorm / gasPrice / benzinPrice / mixPct', 'gasPrice');
  if (!field) return;
  const day = n(prompt('Qaysi kundan?', '1'));
  const value = n(prompt('Yangi qiymat?'));
  const note = prompt('Izoh (ixtiyoriy)', '') || '';
  const car = getCar(STATE.car);
  car.changes = car.changes || [];
  car.changes.push({ day: day || 1, field, value, note });
  const dim = daysInMonth(STATE.month);
  for (let d = day || 1; d <= dim; d++) {
    const row = ensureDay(car, d);
    if (field === 'gasPrice' || field === 'benzinPrice') row[field] = value;
  }
  if (['gasNorm','benzinNorm','gasPrice','benzinPrice','mixPct'].includes(field) && (day || 1) === 1) {
    car[field] = value;
  }
  writeParams();
  markDirty();
  renderDailyTable();
}

function exportExcel() {
  if (typeof XLSX === 'undefined') { toast('Excel kutubxonasi yuklanmadi'); return; }
  const wb = XLSX.utils.book_new();
  const monthRows = [['Mashina','Haydovchi','Km','Gaz olindi','Gaz sarf','Gaz qoldiq','Benzin olindi','Benzin sarf','Benzin qoldiq','Summa']];
  fleet().forEach(f => {
    const t = totals(calcCar(getCar(f.car)));
    monthRows.push([f.car, f.name, t.km, t.gasIn, t.gasUsed, t.gasR, t.benzinIn, t.benUsed, t.benR, t.cost]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(monthRows), 'Oylik');
  const car = getCar(STATE.car);
  const daily = [['Kun','Km','Spidometr','Rejim','Zapravka','Gaz m3','Gaz summa','Benzin l','Benzin summa','Sarf gaz','Sarf benzin','Gaz qoldiq','Benzin qoldiq','Qoshimcha','Izoh']];
  calcCar(car).forEach(r => {
    daily.push([r.d, r.km, r.odo, r.mode, r.station, r.gasIn, r.gasSum, r.benzinIn, r.benzinSum, r.gasUsed, r.benUsed, r.gasR, r.benR, r.extra, r.note]);
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(daily), 'Kunlik');
  const fills = [['Kun','Mashina','Zapravka','Gaz m3','Gaz sum','Benzin l','Benzin sum']];
  collectFills().forEach(f => fills.push([f.d, f.plate, f.station, f.gasIn, f.gasSum, f.benzinIn, f.benzinSum]));
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
    if (f === 'station' && el.value && !(STATE.meta.stations || []).includes(el.value)) {
      STATE.meta.stations = STATE.meta.stations || [];
      STATE.meta.stations.push(el.value);
      saveMeta();
    }
    paintCalc();
    markDirty();
  });
  document.getElementById('daily-body').addEventListener('change', e => {
    const el = e.target;
    if (el.tagName !== 'SELECT') return;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  document.getElementById('month-input').addEventListener('change', e => changeMonth(e.target.value));
  document.getElementById('btn-save').onclick = saveMonth;
  document.getElementById('btn-fill-odo').onclick = fillFromOdo;
  document.getElementById('btn-gps-km').onclick = fillFromGps;
  document.getElementById('btn-prev-bal').onclick = () => fillPrevBalance().catch(err => toast(err.message));
  document.getElementById('btn-add-change').onclick = addChange;
  document.getElementById('btn-excel').onclick = exportExcel;
  document.getElementById('btn-backup').onclick = downloadBackup;
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
