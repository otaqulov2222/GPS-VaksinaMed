'use strict';

const BAD_REASONS = ['Kechikish', 'Marshrut', "To'xtash", 'Muloqot', 'Hujjat', "Yoqilg'i", 'Tezlik', 'Boshqa'];
const GOOD_REASONS = ['Intizom', 'Mijoz', 'Tezkorlik', 'Tozalik', 'Yordam', 'Boshqa'];
const LEVELS = [
  { v: 'past', t: 'Past' },
  { v: 'orta', t: "O'rta" },
  { v: 'yuqori', t: 'Yuqori' }
];

const J = {
  items: [],
  pharmacies: [],
  gps: { days: {}, totals: {} },
  period: 'month',
  filter: 'all',
  q: '',
  from: '',
  to: '',
  kind: 'bad',
  category: 'driver',
  editId: '',
  loaded: false
};

function pad2(n) { return String(n).padStart(2, '0'); }
function nowLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function dtVal(s) {
  if (!s) return '';
  return String(s).replace(' ', 'T').slice(0, 16);
}
function dtShow(s) {
  if (!s) return '—';
  const t = dtVal(s);
  const [d, h] = t.split('T');
  if (!d) return s;
  const p = d.split('-');
  return (p[2] || '') + '.' + (p[1] || '') + '.' + (p[0] || '') + (h ? ' ' + h : '');
}
function plateKey(car) {
  return String(car || '').replace(/\s+/g, '');
}
function gpsForPlate(plate) {
  const totals = (J.gps && J.gps.totals) || {};
  if (totals[plate]) return totals[plate];
  const compact = plateKey(plate);
  const code = (typeof plateCode === 'function') ? plateCode(plate) : '';
  for (const k of Object.keys(totals)) {
    if (plateKey(k) === compact) return totals[k];
    if (code && typeof plateCode === 'function' && plateCode(k) === code) return totals[k];
  }
  return { km: 0, days: 0 };
}

function currentDriver(plate) {
  const info = (typeof vehicleInfo === 'function') ? vehicleInfo(plate) : { name: '' };
  return info.name || '';
}

function periodRange() {
  const ym = STATE.month || nowLocal().slice(0, 7);
  const [y, m] = ym.split('-').map(Number);
  const dim = new Date(y, m, 0).getDate();
  if (J.period === 'all') return { from: '2000-01-01', to: '2099-12-31' };
  if (J.period === 'year') return { from: y + '-01-01', to: y + '-12-31' };
  if (J.period === 'month') return { from: ym + '-01', to: ym + '-' + pad2(dim) };
  if (J.period === 'week') {
    const d = new Date();
    const day = (d.getDay() + 6) % 7;
    const a = new Date(d); a.setDate(d.getDate() - day);
    const b = new Date(a); b.setDate(a.getDate() + 6);
    const fmtD = x => x.getFullYear() + '-' + pad2(x.getMonth() + 1) + '-' + pad2(x.getDate());
    return { from: fmtD(a), to: fmtD(b) };
  }
  if (J.period === 'day') {
    const t = nowLocal().slice(0, 10);
    return { from: t, to: t };
  }
  if (J.period === 'range') return { from: J.from || ym + '-01', to: J.to || ym + '-' + pad2(dim) };
  return { from: ym + '-01', to: ym + '-' + pad2(dim) };
}

function inRange(entry) {
  const r = periodRange();
  const start = dtVal(entry.start).slice(0, 10);
  if (!start) return true;
  return start >= r.from && start <= r.to;
}

function filtered() {
  const q = (J.q || '').toLowerCase();
  return (J.items || []).filter(it => {
    if (!inRange(it)) return false;
    if (J.filter === 'bad' && it.kind !== 'bad') return false;
    if (J.filter === 'good' && it.kind !== 'good') return false;
    if (J.filter === 'driver' && it.category !== 'driver') return false;
    if (J.filter === 'pharmacy' && it.category !== 'pharmacy') return false;
    if (q) {
      const blob = [it.driver, it.car, it.pharmacy, it.reason, it.note, it.level].join(' ').toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')));
}

function uniquePharms() {
  const map = {};
  (J.pharmacies || []).forEach(p => {
    const name = (p && p.name) || '';
    if (!name) return;
    if (!map[name]) map[name] = p;
  });
  return Object.keys(map).sort().map(k => map[k]);
}

async function loadJournal() {
  const d = await vmApi('/api/office/journal?month=' + encodeURIComponent(STATE.month || ''));
  J.items = d.items || [];
  J.pharmacies = d.pharmacies || [];
  J.gps = d.gps || { days: {}, totals: {} };
  J.loaded = true;
}

function formState() {
  return {
    id: J.editId || '',
    kind: J.kind,
    category: J.category,
    car: (document.getElementById('j-car') || {}).value || '',
    driver: (document.getElementById('j-driver') || {}).value || '',
    pharmacy: (document.getElementById('j-pharm') || {}).value || '',
    reason: (document.getElementById('j-reason') || {}).value || '',
    level: (document.getElementById('j-level') || {}).value || 'orta',
    start: (document.getElementById('j-start') || {}).value || '',
    end: (document.getElementById('j-end') || {}).value || '',
    note: (document.getElementById('j-note') || {}).value || '',
    assign: !!(document.getElementById('j-assign') && document.getElementById('j-assign').checked)
  };
}

async function assignDriver(plate, name) {
  if (!plate || !name || typeof ensureVehicleMeta !== 'function') return;
  const rec = ensureVehicleMeta(plate);
  rec.name = name;
  rec.short = name.split(' ')[0] || rec.short;
  rec.hidden = false;
  if (typeof saveMeta === 'function') await saveMeta();
  if (typeof getCar === 'function') {
    const car = getCar(plate);
    const day = Number((nowLocal().slice(8, 10)));
    car.driverChanges = car.driverChanges || [];
    car.driverChanges.push({ day: day || 1, name });
    if (typeof markDirty === 'function') markDirty();
  }
}

async function saveEntry() {
  const f = formState();
  if (f.category === 'driver' && !f.car) { toast('Mashina raqamini tanlang'); return; }
  if (f.category === 'pharmacy' && !f.pharmacy) { toast('Dorixonani tanlang'); return; }
  if (f.category === 'pharmacy' && !f.car) {
    const ph = (J.pharmacies || []).find(p => p.name === f.pharmacy);
    if (ph && ph.car) f.car = ph.car;
  }
  if (f.assign && f.car && f.driver) await assignDriver(f.car, f.driver);
  const d = await vmApi('/api/office/journal', {
    method: 'POST',
    body: JSON.stringify({ entry: f })
  });
  J.items = d.items || J.items;
  J.editId = '';
  toast(f.kind === 'good' ? 'Maktov saqlandi' : 'Kamchilik saqlandi');
  renderJournal();
}

async function deleteEntry(id) {
  if (!confirm("Bu qayd o'chirilsinmi?")) return;
  const d = await vmApi('/api/office/journal', {
    method: 'POST',
    body: JSON.stringify({ deleteId: id })
  });
  J.items = d.items || J.items;
  if (J.editId === id) J.editId = '';
  toast("O'chirildi");
  renderJournal();
}

function fillFormFrom(it) {
  J.editId = it.id;
  J.kind = it.kind === 'good' ? 'good' : 'bad';
  J.category = it.category === 'pharmacy' ? 'pharmacy' : 'driver';
  renderJournal();
  setTimeout(() => {
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
    set('j-car', it.car);
    set('j-driver', it.driver);
    set('j-pharm', it.pharmacy);
    set('j-reason', it.reason);
    set('j-level', it.level || 'orta');
    set('j-start', dtVal(it.start));
    set('j-end', dtVal(it.end));
    set('j-note', it.note);
    onCarChange();
  }, 0);
}

function onCarChange() {
  const plate = (document.getElementById('j-car') || {}).value || '';
  const lab = document.getElementById('j-car-lab');
  const drv = document.getElementById('j-driver');
  const gps = document.getElementById('j-gps');
  if (lab) lab.textContent = plate ? (typeof plateDisp === 'function' ? plateDisp(plate) : plate) : '—';
  if (drv && plate && !J.editId) drv.value = currentDriver(plate);
  if (gps) {
    const g = gpsForPlate(plate);
    gps.textContent = plate ? ('GPS ' + (STATE.month || '') + ': ' + (g.km || 0) + ' km / ' + (g.days || 0) + ' kun') : 'GPS mashina raqami bo\'yicha';
  }
}

function onPharmChange() {
  const name = (document.getElementById('j-pharm') || {}).value || '';
  const ph = (J.pharmacies || []).find(p => p.name === name);
  const carEl = document.getElementById('j-car');
  if (ph && ph.car && carEl) {
    carEl.value = ph.car;
    onCarChange();
  }
}

function countBy(list, keyFn) {
  const map = {};
  list.forEach(it => {
    const k = keyFn(it);
    if (!k) return;
    map[k] = (map[k] || 0) + 1;
  });
  return Object.keys(map).map(k => ({ k, n: map[k] })).sort((a, b) => b.n - a.n);
}

function renderJournal() {
  const panel = document.getElementById('panel-journal');
  if (!panel) return;
  const cars = (typeof fleet === 'function') ? fleet() : [];
  const rows = filtered();
  const all = J.items || [];
  const r = periodRange();
  const badN = rows.filter(x => x.kind === 'bad').length;
  const goodN = rows.filter(x => x.kind === 'good').length;
  const objects = new Set(rows.map(x => x.category === 'pharmacy' ? x.pharmacy : x.car).filter(Boolean)).size;
  const reasons = J.kind === 'good' ? GOOD_REASONS : BAD_REASONS;
  const topBad = countBy(rows.filter(x => x.kind === 'bad'), x => x.car || x.pharmacy);
  const topGood = countBy(rows.filter(x => x.kind === 'good'), x => x.car || x.pharmacy);
  const editing = J.items.find(x => x.id === J.editId);

  panel.innerHTML = `
    <div class="jl">
      <div class="card">
        <div class="card-h"><h3>${J.editId ? 'Qaydni tahrirlash' : 'Yangi qayd'}</h3></div>
        <div class="card-b">
          <div class="hint">Asosiy kalit — <b>mashina raqami</b>. Haydovchi o'zgarsa ham GPS va jurnal shu raqamda qoladi. Hozirgi haydovchini admin shu yerda almashtiradi.</div>
          <div class="tog">
            <button type="button" class="${J.kind==='bad'?'on-bad':''}" data-jk="bad">Kamchilik</button>
            <button type="button" class="${J.kind==='good'?'on-good':''}" data-jk="good">Maktov / yutuq</button>
          </div>
          <div class="tog">
            <button type="button" class="${J.category==='driver'?'on':''}" data-jc="driver">Haydovchi</button>
            <button type="button" class="${J.category==='pharmacy'?'on':''}" data-jc="pharmacy">Dorixona</button>
          </div>
          <div class="fld" style="margin-bottom:8px;">
            <label>Mashina raqami (o'zgarmaydi)</label>
            <select id="j-car">${['<option value="">— tanlang —</option>'].concat(cars.map(c =>
              `<option value="${esc(c.car)}"${editing && editing.car===c.car?' selected':''}>${esc((typeof plateDisp==='function'?plateDisp(c.car):c.car) + ' — ' + (c.name||''))}</option>`
            )).join('')}</select>
            <div class="jl-car" id="j-car-lab" style="margin-top:6px;">${editing && editing.car ? esc(typeof plateDisp==='function'?plateDisp(editing.car):editing.car) : '—'}</div>
            <div class="muted" id="j-gps" style="margin-top:4px;font-size:11px;">GPS mashina raqami bo'yicha</div>
          </div>
          <div class="fld" style="margin-bottom:8px;${J.category==='pharmacy'?'display:none':''}">
            <label>Hozirgi haydovchi (admin o'zgartira oladi)</label>
            <input id="j-driver" value="${esc(editing ? (editing.driver||'') : '')}" placeholder="F.I.Sh.">
            <label style="display:flex;gap:6px;align-items:center;margin-top:6px;text-transform:none;letter-spacing:0;font-size:11px;">
              <input id="j-assign" type="checkbox" checked style="width:16px;height:16px;"> Shu mashinaga haydovchini yangilash
            </label>
          </div>
          <div class="fld" style="margin-bottom:8px;${J.category==='driver'?'display:none':''}">
            <label>Dorixona</label>
            <input id="j-pharm" list="j-pharm-list" value="${esc(editing ? (editing.pharmacy||'') : '')}" placeholder="Nomi">
            <datalist id="j-pharm-list">${uniquePharms().map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>
          </div>
          <div class="fld" style="margin-bottom:8px;">
            <label>${J.kind==='good'?'Maktov turi':'Kamchilik turi'}</label>
            <select id="j-reason">${reasons.map(x => `<option${editing && editing.reason===x?' selected':''}>${esc(x)}</option>`).join('')}</select>
          </div>
          <div class="fld" style="margin-bottom:8px;">
            <label>Darajasi</label>
            <select id="j-level">${LEVELS.map(l => `<option value="${l.v}"${(editing?editing.level:'orta')===l.v?' selected':''}>${l.t}</option>`).join('')}</select>
          </div>
          <div class="fld" style="margin-bottom:8px;">
            <label>Boshlanish</label>
            <div style="display:flex;gap:6px;">
              <input id="j-start" type="datetime-local" value="${esc(editing ? dtVal(editing.start) : nowLocal())}">
              <button type="button" class="btn btn-ink btn-sm" id="j-start-now">Hozir</button>
            </div>
          </div>
          <div class="fld" style="margin-bottom:8px;">
            <label>Tugash (ixtiyoriy)</label>
            <div style="display:flex;gap:6px;">
              <input id="j-end" type="datetime-local" value="${esc(editing ? dtVal(editing.end) : '')}">
              <button type="button" class="btn btn-ink btn-sm" id="j-end-now">Hozir</button>
            </div>
          </div>
          <div class="fld" style="margin-bottom:10px;">
            <label>Izoh</label>
            <textarea id="j-note" placeholder="Tafsilotlar...">${esc(editing ? (editing.note||'') : '')}</textarea>
          </div>
          <button type="button" class="btn ${J.kind==='good'?'btn-ink':'btn-gold'}" style="width:100%;height:40px;${J.kind==='bad'?'background:#9b1c1c;border-color:#9b1c1c;color:#fff':''}" id="j-save">
            ${J.editId ? 'O\'zgarishni saqlash' : (J.kind==='good' ? "Maktov qo'shish" : "Kamchilik qo'shish")}
          </button>
          ${J.editId ? '<button type="button" class="btn btn-ink" style="width:100%;margin-top:6px;" id="j-cancel">Bekor</button>' : ''}
        </div>
      </div>
      <div>
        <div class="card">
          <div class="card-h">
            <div>
              <h3>Haydovchilar jurnali</h3>
              <div class="muted">${esc(r.from)} — ${esc(r.to)}</div>
            </div>
            <div class="row-btns" style="margin:0;">
              <button type="button" class="btn btn-ink btn-sm" id="j-csv">CSV</button>
              <button type="button" class="btn btn-ink btn-sm" onclick="window.print()">PDF</button>
            </div>
          </div>
          <div class="card-b">
            <div class="subtabs" id="j-period">
              ${[['day','Kun'],['week','Hafta'],['month','Oy'],['year','Yil'],['range','Oraliq'],['all','Barchasi']].map(([v,t]) =>
                `<button type="button" class="subtab${J.period===v?' on':''}" data-p="${v}">${t}</button>`
              ).join('')}
            </div>
            <div class="row-btns" style="margin:0 0 10px;" id="j-range-row">
              ${J.period==='range' ? `<input id="j-from" type="date" value="${esc(J.from||r.from)}"><input id="j-to" type="date" value="${esc(J.to||r.to)}">` : ''}
              <input id="j-q" placeholder="Qidirish..." value="${esc(J.q)}" style="height:32px;padding:0 8px;border:1px solid var(--line);min-width:160px;">
            </div>
            <div class="subtabs" id="j-filt">
              ${[['all','Hammasi'],['bad','Faqat kamchilik'],['good','Faqat maktov'],['driver','Haydovchilar'],['pharmacy','Dorixonalar']].map(([v,t]) =>
                `<button type="button" class="subtab${J.filter===v?' on':''}" data-f="${v}">${t}</button>`
              ).join('')}
            </div>
            <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-top:10px;">
              <div class="kpi"><i>Kamchilik (davr)</i><b>${badN}</b></div>
              <div class="kpi"><i>Maktov (davr)</i><b>${goodN}</b></div>
              <div class="kpi"><i>Obyektlar</i><b>${objects}</b></div>
              <div class="kpi"><i>Jami (hammasi)</i><b>${all.length}</b></div>
            </div>
            <div style="overflow:auto;">
              <table class="gtable">
                <thead><tr><th>Turi</th><th>Kim / nima</th><th>Mashina</th><th>GPS km</th><th>Vaqt</th><th>Sabab</th><th>Baho</th><th>Izoh</th><th></th></tr></thead>
                <tbody>${rows.length ? rows.map(it => {
                  const who = it.category === 'pharmacy' ? it.pharmacy : (it.driver || currentDriver(it.car));
                  const nowDrv = currentDriver(it.car);
                  const changed = it.car && it.driver && nowDrv && it.driver !== nowDrv;
                  const g = gpsForPlate(it.car);
                  return `<tr>
                    <td>${it.kind==='good'?'<span class="tag-good">Maktov</span>':'<span class="tag-bad">Kamchilik</span>'}</td>
                    <td>${esc(who)}${changed ? `<div class="muted">qayd: ${esc(it.driver)} · hozir: ${esc(nowDrv)}</div>` : ''}</td>
                    <td>${esc(it.car ? (typeof plateDisp==='function'?plateDisp(it.car):it.car) : '')}</td>
                    <td class="num">${it.car ? (g.km || 0) : ''}</td>
                    <td>${esc(dtShow(it.start))}${it.end ? ' — ' + esc(dtShow(it.end)) : ''}</td>
                    <td>${esc(it.reason)}</td>
                    <td>${esc(it.level)}</td>
                    <td>${esc(it.note)}</td>
                    <td><button type="button" class="btn btn-ink btn-sm j-edit" data-id="${esc(it.id)}">Tahrir</button>
                        <button type="button" class="btn btn-ink btn-sm j-del" data-id="${esc(it.id)}">x</button></td>
                  </tr>`;
                }).join('') : '<tr><td colspan="9" class="muted">Bu davrda qayd yo\'q</td></tr>'}</tbody>
              </table>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-h"><h3>Tahlil</h3></div>
          <div class="card-b">
            <div class="hint">${rows.length ? ('Davrda ' + badN + ' kamchilik, ' + goodN + ' maktov. GPS km mashina raqami bo\'yicha.') : 'Tanlangan davrda ma\'lumot yo\'q.'}</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <b>Kamchilik bo'yicha (kim ko'p)</b>
                ${topBad.slice(0,8).map(x => {
                  const info = (typeof vehicleInfo==='function' && x.k) ? vehicleInfo(x.k) : { name: x.k };
                  const g = gpsForPlate(x.k);
                  return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);">
                    <span>${esc(info.name || x.k)} <span class="muted">${esc(x.k)}</span></span>
                    <span><b>${x.n}</b> <span class="muted">${g.km||0} km</span></span></div>`;
                }).join('') || '<p class="muted">—</p>'}
              </div>
              <div>
                <b>Maktov bo'yicha (kim ko'p)</b>
                ${topGood.slice(0,8).map(x => {
                  const info = (typeof vehicleInfo==='function' && x.k) ? vehicleInfo(x.k) : { name: x.k };
                  return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);">
                    <span>${esc(info.name || x.k)} <span class="muted">${esc(x.k)}</span></span><b>${x.n}</b></div>`;
                }).join('') || '<p class="muted">—</p>'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>`;

  panel.querySelectorAll('[data-jk]').forEach(b => {
    b.onclick = () => { J.kind = b.getAttribute('data-jk'); J.editId = J.editId; renderJournal(); };
  });
  panel.querySelectorAll('[data-jc]').forEach(b => {
    b.onclick = () => { J.category = b.getAttribute('data-jc'); renderJournal(); };
  });
  panel.querySelectorAll('#j-period [data-p]').forEach(b => {
    b.onclick = () => { J.period = b.getAttribute('data-p'); renderJournal(); };
  });
  panel.querySelectorAll('#j-filt [data-f]').forEach(b => {
    b.onclick = () => { J.filter = b.getAttribute('data-f'); renderJournal(); };
  });
  const carSel = document.getElementById('j-car');
  if (carSel) carSel.onchange = onCarChange;
  const ph = document.getElementById('j-pharm');
  if (ph) ph.onchange = onPharmChange;
  const sn = document.getElementById('j-start-now');
  if (sn) sn.onclick = () => { document.getElementById('j-start').value = nowLocal(); };
  const en = document.getElementById('j-end-now');
  if (en) en.onclick = () => { document.getElementById('j-end').value = nowLocal(); };
  const save = document.getElementById('j-save');
  if (save) save.onclick = () => saveEntry().catch(err => toast(err.message));
  const cancel = document.getElementById('j-cancel');
  if (cancel) cancel.onclick = () => { J.editId = ''; renderJournal(); };
  const q = document.getElementById('j-q');
  if (q) q.onchange = () => { J.q = q.value; renderJournal(); };
  const jf = document.getElementById('j-from');
  const jt = document.getElementById('j-to');
  if (jf) jf.onchange = () => { J.from = jf.value; renderJournal(); };
  if (jt) jt.onchange = () => { J.to = jt.value; renderJournal(); };
  panel.querySelectorAll('.j-edit').forEach(b => {
    b.onclick = () => {
      const it = J.items.find(x => x.id === b.getAttribute('data-id'));
      if (it) fillFormFrom(it);
    };
  });
  panel.querySelectorAll('.j-del').forEach(b => {
    b.onclick = () => deleteEntry(b.getAttribute('data-id')).catch(err => toast(err.message));
  });
  const csv = document.getElementById('j-csv');
  if (csv) csv.onclick = exportJournalCsv;
  onCarChange();
}

function exportJournalCsv() {
  const rows = [['Turi','Kategoriya','Haydovchi','Mashina','Dorixona','Sabab','Daraja','Boshlanish','Tugash','Izoh']];
  filtered().forEach(it => {
    rows.push([it.kind, it.category, it.driver, it.car, it.pharmacy, it.reason, it.level, it.start, it.end, it.note]);
  });
  const csv = rows.map(r => r.map(c => '"' + String(c || '').replace(/"/g, '""') + '"').join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'jurnal-' + (STATE.month || 'all') + '.csv';
  a.click();
}

window.VMJournal = {
  async render() {
    try {
      if (!J.loaded || J._month !== STATE.month) {
        await loadJournal();
        J._month = STATE.month;
      }
      renderJournal();
    } catch (e) {
      toast(e.message || 'Jurnal yuklanmadi');
    }
  }
};
