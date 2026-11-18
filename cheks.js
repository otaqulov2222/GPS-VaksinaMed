'use strict';
/* Zapravka cheklari — sandbox. Yoqilg'i/GPS hisobiga yozilmaydi. */
if (/\/chek\/?$/.test(location.pathname || '')) {
  document.documentElement.classList.add('page-chek');
  const mark = () => document.body && document.body.classList.add('page-chek');
  if (document.body) mark();
  else document.addEventListener('DOMContentLoaded', mark);
}

const VMCheks = {
  items: [],
  openPlate: '',
  selectedId: '',
  periodYm: '',
  periodDay: '',
  scanning: false,
  scanner: null,
  libPromise: null,
  paperItem: null,
  paperFromScan: false,
  paperDup: false,
  highlightId: '',
  deletedIds: null,
  nativeStream: null,
  nativeLoop: null,
  nativeVideo: null,
  seenIds: null,
  pollTimer: null,
  pendingTimer: null,
  lastPing: '',

  money(v) {
    if (v == null || v === '') return '';
    const n = Number(v);
    if (!Number.isFinite(n)) return '';
    return Math.round(n).toLocaleString('uz-UZ').replace(/,/g, ' ') + " so'm";
  },

  moneyOrWait(v) {
    return this.money(v) || 'kutilmoqda';
  },

  som(v, empty) {
    if (v == null || v === '') return empty == null ? 'kutilmoqda' : empty;
    const n = Number(v);
    if (!Number.isFinite(n)) return empty == null ? 'kutilmoqda' : empty;
    const neg = n < 0;
    const abs = Math.abs(n);
    const parts = abs.toFixed(2).split('.');
    const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (neg ? '-' : '') + grouped + '.' + parts[1];
  },

  drivers() {
    let list = [];
    if (typeof fleetDriversLive === 'function') list = fleetDriversLive();
    else if (window.VMOffice && typeof VMOffice.driversList === 'function') list = VMOffice.driversList();
    else list = window.DRIVERS || [];
    return list.map(raw => (typeof resolveDriver === 'function' ? resolveDriver(raw.car, raw) : raw));
  },

  driverOf(plate) {
    const k = this.plateKey(plate);
    return this.drivers().find(d => this.plateKey(d.car) === k) || { car: plate, shortName: '', fullName: '' };
  },

  plateKey(p) {
    if (typeof fleetPlateKey === 'function') return fleetPlateKey(p);
    return String(p || '').replace(/\s+/g, '').toUpperCase();
  },

  forPlate(plate) {
    const k = this.plateKey(plate);
    return this.items.filter(x => this.plateKey(x.plate) === k);
  },

  ymNow() {
    const now = new Date();
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
  },

  currentYm() {
    const ym = String(this.periodYm || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(ym)) return ym;
    this.periodYm = this.ymNow();
    return this.periodYm;
  },

  shiftYm(ym, delta) {
    const m = String(ym || this.currentYm()).match(/^(\d{4})-(\d{2})$/);
    if (!m) return this.ymNow();
    const d = new Date(Number(m[1]), Number(m[2]) - 1 + Number(delta || 0), 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  },

  monthTitle(ym) {
    const months = [
      'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
      'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr'
    ];
    const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return 'Oy';
    const idx = Number(m[2]) - 1;
    return (months[idx] || m[2]) + ' ' + m[1];
  },

  rowDateKey(r) {
    const raw = String((r && (r.paidAt || r.createdAt)) || '');
    const iso = raw.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso.slice(0, 10);
    const m = raw.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (m) return m[3] + '-' + m[2] + '-' + m[1];
    return '';
  },

  inMonth(r, ym) {
    const key = this.rowDateKey(r);
    return !!(key && key.slice(0, 7) === ym);
  },

  inDay(r, day) {
    return this.rowDateKey(r) === String(day || '');
  },

  currentDay() {
    const d = String(this.periodDay || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d.slice(0, 7) === this.currentYm()) return d;
    return '';
  },

  periodLabel(ym, day) {
    if (day) {
      const m = String(day).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) return Number(m[3]) + ' ' + this.monthTitle(m[1] + '-' + m[2]);
    }
    return this.monthTitle(ym);
  },

  filterPeriod(list, ym, day) {
    const y = ym || this.currentYm();
    const d = day == null ? this.currentDay() : day;
    if (d) return (list || []).filter((r) => this.inDay(r, d));
    return (list || []).filter((r) => this.inMonth(r, y));
  },

  forPlatePeriod(plate, ym, day) {
    return this.filterPeriod(this.forPlate(plate), ym, day);
  },

  daysWithData(ym) {
    const set = new Set();
    (this.items || []).forEach((r) => {
      const key = this.rowDateKey(r);
      if (key && key.slice(0, 7) === ym) set.add(key);
    });
    return set;
  },

  todayStr() {
    const n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  },

  setPeriod(ym) {
    const next = String(ym || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(next)) return;
    if (next === this.currentYm() && !this.periodDay) return;
    this.periodYm = next;
    if (this.periodDay && this.periodDay.slice(0, 7) !== next) this.periodDay = '';
    this._renderSig = '';
    try {
      localStorage.setItem('vm_chek_period', next);
      localStorage.setItem('vm_chek_day', this.periodDay || '');
    } catch (e) {}
    this.render();
  },

  setDay(day) {
    const ds = String(day || '');
    if (ds && !/^\d{4}-\d{2}-\d{2}$/.test(ds)) return;
    if (ds) {
      this.periodYm = ds.slice(0, 7);
      this.periodDay = ds;
    } else {
      this.periodDay = '';
    }
    this._renderSig = '';
    try {
      localStorage.setItem('vm_chek_period', this.periodYm);
      localStorage.setItem('vm_chek_day', this.periodDay || '');
    } catch (e) {}
    this.render();
  },

  stats(list, ym, day) {
    const filtered = this.filterPeriod(list, ym, day);
    const sum = (arr) => arr.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    return {
      count: (list || []).length,
      sum: sum(list || []),
      monthCount: filtered.length,
      monthSum: sum(filtered)
    };
  },

  when(r) {
    const raw = String((r && (r.paidAt || r.createdAt)) || '');
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return raw || '—';
    return m[3] + '.' + m[2] + '.' + m[1] + (m[4] ? ('  ' + m[4] + ':' + m[5]) : '');
  },

  ofdKind(r) {
    if (r && Number(r.amount) > 0) return 'ok';
    if (r && (r.ofdPending || !r.ofdOk)) return 'wait';
    return 'wait';
  },

  ofdLabel(r) {
    if (r && r.ofdOk && Number(r.amount) > 0) return 'OFD tasdiqlagan';
    if (r && Number(r.amount) > 0) return r.manual ? 'Summa kiritilgan' : 'OFD tasdiqlagan';
    if (r && r.manual) return 'Summa kiritilgan';
    return 'OFD kutilmoqda';
  },

  ofdStamp(r) {
    const qr = String((r && r.qr) || '');
    const m = qr.match(/[?&]c=(\d{12,14})/i);
    if (m) {
      const c = m[1];
      return c.length === 12 ? c + '00' : c.slice(0, 14);
    }
    const paid = String((r && r.paidAt) || '').replace(/\D/g, '');
    if (paid.length >= 14) return paid.slice(0, 14);
    if (paid.length === 12) return paid + '00';
    return '';
  },

  async ofdHmac(term, payno) {
    const ts = String(Math.floor(Date.now() / 1000));
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode('thisIsPaymentSecretKey123@#'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const buf = await crypto.subtle.sign('HMAC', key, enc.encode(term + ':' + payno + ':' + ts));
    const sig = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return { ts, sig };
  },

  async fetchOfdRaw(row) {
    const term = String((row && row.terminalId) || '');
    const payno = String((row && row.receiptNo) || '');
    const stamp = this.ofdStamp(row);
    const sign = String((row && row.fiscalSign) || '');
    if (!term || !payno || !stamp || !crypto.subtle) return null;
    const { ts, sig } = await this.ofdHmac(term, payno);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch('https://new-ofd.soliq.uz/api/payment', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Timestamp': ts,
          'X-Signature': sig
        },
        body: JSON.stringify({
          terminalId: term,
          paymentNo: payno,
          paymentDate: stamp,
          paymentType: 'CHECK',
          ...(sign ? { fiscalSign: sign } : {})
        }),
        signal: ctrl.signal
      });
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== 'object') return null;
      return data;
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  },

  async postRefresh(row) {
    const body = { id: row && row.id };
    const ofd = await this.fetchOfdRaw(row);
    if (ofd) body.ofd = ofd;
    return vmApi('/api/office/cheks/refresh', {
      method: 'POST',
      body: JSON.stringify(body),
      timeoutMs: ofd ? 12000 : 18000
    });
  },

  normalizeStamp(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    let m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const dd = String(m[1]).padStart(2, '0');
      const mm = String(m[2]).padStart(2, '0');
      const yyyy = m[3];
      const hh = String(m[4] || '0').padStart(2, '0');
      const mi = String(m[5] || '0').padStart(2, '0');
      const ss = String(m[6] || '0').padStart(2, '0');
      return yyyy + mm + dd + hh + mi + ss;
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
      const hh = String(m[4] || '0').padStart(2, '0');
      const mi = String(m[5] || '0').padStart(2, '0');
      const ss = String(m[6] || '0').padStart(2, '0');
      return m[1] + m[2] + m[3] + hh + mi + ss;
    }
    const digits = s.replace(/\D/g, '');
    if (digits.length >= 14) return digits.slice(0, 14);
    if (digits.length === 12) return digits + '00';
    if (digits.length === 8) return digits + '000000';
    return digits.length >= 8 ? digits : '';
  },

  buildOfdUrl(fields) {
    const term = String((fields && fields.terminalId) || '').replace(/\s+/g, '').trim();
    const rno = String((fields && fields.receiptNo) || '').replace(/\s+/g, '').trim();
    const fb = String((fields && fields.fiscalSign) || '').replace(/\s+/g, '').trim();
    let stamp = this.normalizeStamp(fields && fields.when);
    if (!rno) return { ok: false, error: 'Chek № ni yozing' };
    if (!fb) return { ok: false, error: 'FB raqamini yozing' };
    if (!stamp || stamp.length < 8) {
      const now = new Date();
      stamp = String(now.getFullYear())
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');
    }
    if (!term) return { ok: false, error: 'Terminal kerak (yoki avvalgi cheklar bo‘lsin)' };
    const q = new URLSearchParams({ t: term.slice(0, 40), r: rno.slice(0, 40), c: stamp, s: fb.slice(0, 40) });
    return { ok: true, qr: 'https://ofd.soliq.uz/check?' + q.toString() };
  },

  lastTerminalFor(plate) {
    const list = this.forPlate(plate || this.openPlate);
    for (let i = 0; i < list.length; i++) {
      const t = String((list[i] && list[i].terminalId) || '').trim();
      if (t) return t;
    }
    const any = (this.items || []).find((x) => x && x.terminalId);
    return any ? String(any.terminalId) : '';
  },

  parseQr(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    if (s.startsWith('http://')) s = 'https://' + s.slice(7);
    let u;
    try {
      u = new URL(/^https?:\/\//i.test(s) ? s : ('https://' + s.replace(/^\/+/, '')));
    } catch (e) {
      return null;
    }
    const host = String(u.hostname || '').replace(/^www\./i, '').toLowerCase();
    const t = (u.searchParams.get('t') || u.searchParams.get('T') || '').trim();
    const r = (u.searchParams.get('r') || u.searchParams.get('R') || '').trim();
    const c = (u.searchParams.get('c') || u.searchParams.get('C') || '').trim();
    const sig = (u.searchParams.get('s') || u.searchParams.get('S') || '').trim();
    const ofd = /ofd\.soliq|fact\.soliq|new-ofd|my\.soliq/.test(host) || (t && r && c && sig);
    if (!ofd) return null;
    const digits = String(c).replace(/\D/g, '');
    let paidAt = '';
    if (digits.length >= 14) {
      paidAt = digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6, 8)
        + ' ' + digits.slice(8, 10) + ':' + digits.slice(10, 12) + ':' + digits.slice(12, 14);
    } else if (digits.length >= 8) {
      paidAt = digits.slice(0, 4) + '-' + digits.slice(4, 6) + '-' + digits.slice(6, 8);
    }
    return {
      qr: s.slice(0, 500),
      terminalId: t.slice(0, 40),
      receiptNo: r.slice(0, 40),
      fiscalSign: sig.slice(0, 40),
      paidAt,
      plate: this.openPlate,
      merchant: '',
      amount: null,
      items: [],
      ofdOk: false,
      ofdPending: true,
      ofdNote: 'Chek saqlandi. OFD dan o‘qilmoqda…'
    };
  },

  preferRow(old, neu) {
    if (!old) return neu;
    if (!neu) return old;
    const out = Object.assign({}, old, neu);
    const keys = ['amount', 'merchant', 'inn', 'items', 'address', 'cardType', 'payMethod', 'kkmName', 'vatTotal', 'cardTotal', 'cashTotal', 'qr', 'terminalId', 'receiptNo', 'plate'];
    keys.forEach((k) => {
      const nv = neu[k];
      const ov = old[k];
      const empty = nv == null || nv === '' || (Array.isArray(nv) && !nv.length);
      const filled = ov != null && ov !== '' && !(Array.isArray(ov) && !ov.length);
      if (empty && filled) out[k] = ov;
    });
    if (old.ofdOk && !neu.ofdOk) {
      out.ofdOk = true;
      out.ofdPending = false;
      if (old.ofdNote) out.ofdNote = old.ofdNote;
    }
    return out;
  },

  applyItems(next) {
    if (!Array.isArray(next)) return false;
    if (!this.seenIds) this.seenIds = new Set();
    if (!this.deletedIds) this.deletedIds = new Set();
    const byId = new Map();
    (this.items || []).forEach((x) => {
      if (x && x.id && !this.deletedIds.has(String(x.id))) byId.set(String(x.id), x);
    });
    next.forEach((x) => {
      if (!x || !x.id) return;
      const id = String(x.id);
      if (this.deletedIds.has(id)) return;
      byId.set(id, this.preferRow(byId.get(id), x));
      this.seenIds.add(id);
    });
    const merged = Array.from(byId.values()).sort((a, b) => {
      const ta = String(a.paidAt || a.createdAt || '');
      const tb = String(b.paidAt || b.createdAt || '');
      return tb.localeCompare(ta);
    });
    const sig = merged.map((x) => [x.id, x.ofdOk, x.amount, x.merchant].join(':')).join('|');
    const prev = (this.items || []).map((x) => [x.id, x.ofdOk, x.amount, x.merchant].join(':')).join('|');
    this.items = merged;
    if (this.paperItem) {
      const freshPaper = merged.find((x) => String(x.id) === String(this.paperItem.id));
      if (freshPaper && (freshPaper.ofdOk !== this.paperItem.ofdOk || freshPaper.amount !== this.paperItem.amount || freshPaper.merchant !== this.paperItem.merchant)) {
        this.paperItem = freshPaper;
        this.openPaper(freshPaper, this.paperFromScan, this.paperDup);
      }
    }
    return sig !== prev;
  },

  async load(fromPoll) {
    try {
      const d = await vmApi('/api/office/cheks');
      const next = Array.isArray(d.items) ? d.items : [];
      const first = this.seenIds == null;
      if (first) this.seenIds = new Set();
      const fresh = (!first && fromPoll && !this._busy && !this.scanning)
        ? next.filter((x) => x.id && !this.seenIds.has(String(x.id)))
        : [];
      const changed = this.applyItems(next);
      if (fresh.length) {
        const row = this.items.find((x) => String(x.id) === String(fresh[0].id)) || fresh[0];
        this.openPlate = row.plate || this.openPlate;
        if (row.id != null) {
          this.selectedId = String(row.id);
          this.highlightId = row.id;
        }
        this.pingLive(row);
        this._renderSig = '';
        this.render();
        this.flash();
        this.beep();
        this.openPaper(row, true, false);
        return;
      }
      if (fromPoll) this.kickPending();
      if (fromPoll && !changed && !first) return;
    } catch (e) {
      if (!fromPoll) this.items = [];
    }
    this.render();
    if (!fromPoll) this.kickPending(true);
  },

  pingLive(row) {
    const d = this.driverOf(row && row.plate);
    const who = (d.shortName || d.fullName || row.plate || 'Mashina').trim();
    this.lastPing = who + ' · yangi chek tushdi';
    const live = document.getElementById('chek-live-text');
    if (live) live.textContent = this.lastPing;
  },

  renderPeriodBar(ym, day) {
    const host = document.getElementById('chek-period');
    if (!host) return;
    const title = this.monthTitle(ym);
    const label = this.periodLabel(ym, day);
    const today = this.todayStr();
    const withData = this.daysWithData(ym);
    const m = String(ym).match(/^(\d{4})-(\d{2})$/);
    const yNum = m ? Number(m[1]) : new Date().getFullYear();
    const mNum = m ? Number(m[2]) - 1 : new Date().getMonth();
    const firstDow = new Date(yNum, mNum, 1).getDay();
    const offset = firstDow === 0 ? 6 : firstDow - 1;
    const daysIn = new Date(yNum, mNum + 1, 0).getDate();
    let grid = '';
    for (let i = 0; i < offset; i++) grid += '<div class="cal-day cal-day-empty"></div>';
    for (let d = 1; d <= daysIn; d++) {
      const ds = ym + '-' + String(d).padStart(2, '0');
      const fut = ds > today;
      let cls = 'cal-day';
      if (fut) cls += ' cal-day-future';
      else if (ds === today) cls += ' is-today';
      if (withData.has(ds)) cls += ' has-data';
      if (day && ds === day) cls += ' active';
      const tip = withData.has(ds) ? (ds + ' · chek bor') : ds;
      grid += fut
        ? `<div class="${cls}" title="${this.esc(tip)}">${d}</div>`
        : `<button type="button" class="${cls}" data-chek-day="${ds}" title="${this.esc(tip)}">${d}</button>`;
    }
    const dayCount = withData.size;
    const dayStats = day ? this.stats(this.items, ym, day) : null;
    const statusText = day
      ? (dayStats.monthCount ? (dayStats.monthCount + ' chek') : 'Chek yo‘q')
      : (dayCount + ' kun');
    const statusCls = day
      ? (dayStats.monthCount ? 'chip chip-green' : 'chip chip-gray')
      : 'chip chip-blue';
    host.innerHTML = `
      <div class="chek-cal-card">
        <div class="chek-cal-head">
          <h3>Kalendar</h3>
          <span class="${statusCls}" id="chek-cal-count">${this.esc(statusText)}</span>
        </div>
        <div class="cal-nav">
          <button type="button" id="chek-period-prev" title="Oldingi oy">&lt;</button>
          <span id="chek-cal-month-label">${this.esc(title.toUpperCase())}</span>
          <button type="button" id="chek-period-next" title="Keyingi oy">&gt;</button>
        </div>
        <div class="chek-cal-body">
          <div class="cal-week-labels">
            <span>Du</span><span>Se</span><span>Ch</span><span>Pa</span><span>Ju</span><span>Sh</span><span>Ya</span>
          </div>
          <div class="cal-grid" id="chek-cal-grid">${grid}</div>
        </div>
        <div class="cal-selected-box chek-cal-selected">
          <span id="chek-cal-selected-label">${this.esc(day ? label : ('Butun oy · ' + title))}</span>
          <div class="chek-cal-selected-acts">
            <button type="button" class="btn btn-light btn-sm" id="chek-period-now">Bugun</button>
            <button type="button" class="btn btn-outline btn-sm" id="chek-cal-month" ${day ? '' : 'disabled'}>Butun oy</button>
          </div>
        </div>
      </div>`;
    const sub = document.querySelector('#chek-top-title .tb-sub');
    if (sub) sub.textContent = 'Zapravka cheklari · ' + label + ' · hisobotga ta’sir qilmaydi';
  },

  render() {
    const fleet = document.getElementById('chek-fleet');
    const view = document.getElementById('chek-car-view');
    const totals = document.getElementById('chek-totals');
    const meta = document.getElementById('chek-board-meta');
    if (!fleet || !view) return;
    const rows = this.drivers();
    const ym = this.currentYm();
    const day = this.currentDay();
    const label = this.periodLabel(ym, day);
    const all = this.stats(this.items, ym, day);
    const sig = [ym, day, this.openPlate, this.selectedId, this.highlightId, rows.length, this.items.map((x) => [x.id, x.ofdOk, x.amount, x.merchant].join(':')).join(',')].join('|');
    if (sig === this._renderSig) return;
    this._renderSig = sig;
    this.renderPeriodBar(ym, day);
    if (meta) {
      meta.textContent = all.monthCount
        ? (all.monthCount + ' chek · ' + label + ' · ' + (this.money(all.monthSum) || '0 so‘m'))
        : (label + ' · chek yo‘q');
    }
    if (totals) {
      totals.innerHTML = `
        <div class="chek-tot"><b>${rows.length}</b><span>Mashina</span></div>
        <div class="chek-tot"><b>${all.monthCount}</b><span>Chek · ${this.esc(label)}</span></div>
        <div class="chek-tot"><b>${this.money(all.monthSum) || '0 so‘m'}</b><span>Jami · ${this.esc(label)}</span></div>`;
    }
    const open = this.openPlate;
    if (open) {
      fleet.hidden = true;
      view.hidden = false;
      if (totals) totals.hidden = true;
      this.renderCar(view, open, ym, day);
      return;
    }
    fleet.hidden = false;
    view.hidden = true;
    view.innerHTML = '';
    if (totals) totals.hidden = false;
    if (!rows.length) {
      fleet.innerHTML = '<div class="chek-empty">Mashinalar ro‘yxati topilmadi.</div>';
      return;
    }
    fleet.innerHTML = rows.map((d, i) => {
      const plate = d.car || '';
      const list = this.forPlatePeriod(plate, ym, day);
      const st = this.stats(this.forPlate(plate), ym, day);
      const last = list[0];
      const photo = typeof fleetPhotoHtml === 'function' ? fleetPhotoHtml(plate, 'fb-photo') : '';
      const model = typeof fleetModelOf === 'function' ? fleetModelOf(plate) : '';
      const minfo = model && window.FLEET_MODELS ? window.FLEET_MODELS[model] : null;
      const name = d.shortName || d.fullName || '—';
      const lastLine = last
        ? (this.moneyOrWait(last.amount) + ' · ' + this.when(last))
        : ('Hali chek yo‘q · ' + label);
      return `<button type="button" class="chek-card" data-plate="${this.esc(plate)}">
        <span class="chek-n">${i + 1}</span>
        <span class="fb-thumb${minfo ? ' cls-' + minfo.cls : ''}">${photo}</span>
        <span class="chek-who">
          <b>${this.esc(name)}</b>
          <em class="font-mono">${this.esc(plate)}</em>
          <i class="chek-last">${this.esc(lastLine)}</i>
        </span>
        <span class="chek-sum">
          <strong>${this.money(st.monthSum) || '0 so‘m'}</strong>
          <small>${st.monthCount ? (st.monthCount + ' chek') : 'chek yo‘q'}</small>
        </span>
        <span class="chek-go" aria-hidden="true">›</span>
      </button>`;
    }).join('');
  },

  ensureSelected(list) {
    if (!list || !list.length) {
      this.selectedId = '';
      return null;
    }
    const want = String(this.selectedId || this.highlightId || '');
    let row = want ? list.find((x) => String(x.id) === want) : null;
    if (!row) row = list[0];
    this.selectedId = row && row.id != null ? String(row.id) : '';
    return row;
  },

  previewPaneHtml(row) {
    if (!row) {
      return `<div class="chek-preview-empty">
        <div class="chek-preview-empty-ico" aria-hidden="true">№</div>
        <b>Chek tanlang</b>
        <p>Chapdagi ro‘yxatdan chekni bosing — bu yerda fiskal qog‘oz ko‘rinishi ochiladi.</p>
      </div>`;
    }
    return `<div class="chek-paper chek-paper-inline">${this.paperHtml(row, true)}</div>
      <div class="chek-preview-actions">
        <button type="button" class="btn btn-gold chek-act-pdf" data-id="${this.esc(row.id)}">PDF yuklab olish</button>
        <button type="button" class="btn btn-outline chek-act-edit" data-id="${this.esc(row.id)}">Tahrirlash</button>
        <button type="button" class="btn btn-outline chek-act-del" data-id="${this.esc(row.id)}">O‘chirish</button>
      </div>`;
  },

  renderCar(view, plate, ym, day) {
    const d = this.driverOf(plate);
    const dayKey = day == null ? this.currentDay() : day;
    const allList = this.forPlate(plate);
    const list = this.forPlatePeriod(plate, ym, dayKey);
    const st = this.stats(allList, ym, dayKey);
    const selected = this.ensureSelected(list);
    const photo = typeof fleetPhotoHtml === 'function' ? fleetPhotoHtml(plate, 'fb-photo') : '';
    const model = typeof fleetModelOf === 'function' ? fleetModelOf(plate) : '';
    const minfo = model && window.FLEET_MODELS ? window.FLEET_MODELS[model] : null;
    const name = d.shortName || d.fullName || '—';
    const title = this.periodLabel(ym, dayKey);
    const rows = list.length
      ? `<ul class="chek-list">${list.map(r => this.miniHtml(r)).join('')}</ul>`
      : `<div class="chek-empty">${this.esc(title)} uchun chek yo‘q. Boshqa kun/oy tanlang yoki QR / qo‘lda kiritish bilan qo‘shing.</div>`;
    view.innerHTML = `
      <button type="button" class="chek-back" id="chek-back">← Mashinalar</button>
      <div class="chek-car-toolbar">
        <div class="chek-car-head">
          <span class="fb-thumb${minfo ? ' cls-' + minfo.cls : ''}">${photo}</span>
          <span class="chek-who">
            <b>${this.esc(name)}</b>
            <em class="font-mono">${this.esc(plate)}</em>
          </span>
        </div>
        <div class="chek-stats">
          <div class="chek-stat"><span>${this.esc(title)} · cheklar</span><b>${st.monthCount}</b></div>
          <div class="chek-stat"><span>${this.esc(title)} · summa</span><b>${this.money(st.monthSum) || '0 so‘m'}</b></div>
        </div>
        <div class="chek-actions-col">
          <button type="button" class="btn btn-gold chek-add-btn" id="chek-add">QR skaner — kamera o‘zi o‘qiydi</button>
          <button type="button" class="btn btn-outline chek-manual-btn" id="chek-manual-open">Qo‘lda kiritish — Chek № / FB</button>
        </div>
      </div>
      <div class="chek-workspace">
        <div class="chek-col-list">
          <div class="chek-col-h">${this.esc(title)} · cheklar <b>${list.length}</b></div>
          ${rows}
        </div>
        <div class="chek-col-preview">
          <div class="chek-col-h">Chek ko‘rinishi <b>${selected ? (this.money(selected.amount) || 'OFD') : '—'}</b></div>
          <div class="chek-preview-stage" id="chek-preview">${this.previewPaneHtml(selected)}</div>
        </div>
      </div>`;
  },

  miniHtml(r) {
    const kind = this.ofdKind(r);
    const id = this.esc(r.id);
    const neu = this.highlightId && String(this.highlightId) === String(r.id);
    const active = this.selectedId && String(this.selectedId) === String(r.id);
    const mer = r.merchant || r.kkmName || '';
    const amt = this.money(r.amount);
    return `<li class="chek-mini-wrap${neu ? ' is-new' : ''}${active ? ' is-active' : ''}${kind === 'ok' ? ' is-ok' : ' is-wait'}">
      <button type="button" class="chek-mini" data-id="${id}">
        <div class="chek-mini-h">
          <b>${this.esc(amt || 'OFD dan olinmoqda')}</b>
          <small>${this.esc(this.when(r))}</small>
        </div>
        ${mer ? `<em>${this.esc(mer)}</em>` : ''}
        <span>Chek № ${this.esc(r.receiptNo || '—')}${r.terminalId ? ' · ' + this.esc(r.terminalId) : ''}</span>
        <i class="chek-pill ${kind}">${this.esc(this.ofdLabel(r))}</i>
      </button>
      <div class="chek-mini-acts">
        <button type="button" class="chek-act chek-act-pdf" data-id="${id}">PDF</button>
        <button type="button" class="chek-act chek-act-edit" data-id="${id}">Tahrirlash</button>
        <button type="button" class="chek-act chek-act-del" data-id="${id}">O‘chirish</button>
      </div>
    </li>`;
  },

  pdfTxt(s) {
    const t = String(s == null ? '' : s);
    if (typeof uzLatin === 'function') return uzLatin(t);
    return t;
  },

  async ensurePdfDoc() {
    const JsPDF = (window.jspdf && window.jspdf.jsPDF) || window.jsPDF;
    if (!JsPDF) throw new Error('PDF moduli yuklanmadi. Ctrl+F5 qiling.');
    const doc = new JsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
    let font = 'helvetica';
    try {
      if (typeof loadPdfFonts === 'function' && typeof applyPdfFont === 'function') {
        const fonts = await loadPdfFonts();
        applyPdfFont(doc, fonts);
        if (window.VM_PDF_FONT) font = window.VM_PDF_FONT;
      }
    } catch (e) {}
    return { doc, font };
  },

  async downloadPdf(idOrRow) {
    const row = (idOrRow && typeof idOrRow === 'object')
      ? idOrRow
      : this.items.find((x) => String(x.id) === String(idOrRow));
    if (!row) {
      this.toast('Chek topilmadi');
      return;
    }
    try {
      this.toast('PDF tayyorlanmoqda…');
      const { doc, font } = await this.ensurePdfDoc();
      const useNoto = font === 'NotoSans';
      const T = (s) => (useNoto ? String(s == null ? '' : s) : this.pdfTxt(s));
      const setF = (style, size) => {
        doc.setFont(font, style || 'normal');
        if (size) doc.setFontSize(size);
      };
      const line = (yPos) => {
        doc.setDrawColor(180);
        try {
          if (doc.setLineDash) doc.setLineDash([1, 1], 0);
          else if (doc.setLineDashPattern) doc.setLineDashPattern([1, 1], 0);
        } catch (e) {}
        doc.line(18, yPos, 192, yPos);
        try {
          if (doc.setLineDash) doc.setLineDash([]);
          else if (doc.setLineDashPattern) doc.setLineDashPattern([], 0);
        } catch (e) {}
      };
      const d = this.driverOf(row.plate);
      const merchant = row.merchant || row.kkmName || 'Zapravka';
      const amt = this.som(row.amount);
      let y = 18;

      setF('bold', 16);
      doc.setTextColor(26, 79, 160);
      doc.text(T(row.cardType || row.payMethod || 'UZCARD'), 105, y, { align: 'center' });
      y += 8;
      setF('bold', 13);
      doc.setTextColor(20, 30, 45);
      doc.text(T(merchant), 105, y, { align: 'center' });
      y += 6;
      if (row.address) {
        setF('normal', 9);
        doc.setTextColor(90, 100, 115);
        const addr = doc.splitTextToSize(T(row.address), 160);
        doc.text(addr, 105, y, { align: 'center' });
        y += addr.length * 4.2 + 2;
      }
      setF('normal', 10);
      doc.setTextColor(40, 50, 65);
      doc.text(T('Sanasi: ' + this.when(row)), 105, y, { align: 'center' });
      y += 8;
      setF('bold', 11);
      doc.text(T('SOTUV CHEKI'), 105, y, { align: 'center' });
      y += 4;
      line(y);
      y += 8;

      const items = (row.items || []).filter((it) => it && it.name).slice(0, 20);
      if (items.length) {
        items.forEach((it) => {
          const qty = it.qty != null && it.qty !== '' ? Number(it.qty) : NaN;
          const sum = it.sum != null && it.sum !== '' ? Number(it.sum) : NaN;
          const unit = Number.isFinite(qty) && qty !== 0 && Number.isFinite(sum) ? (sum / qty) : NaN;
          setF('bold', 10);
          doc.setTextColor(20, 30, 45);
          const nameLines = doc.splitTextToSize(T(it.name), 170);
          doc.text(nameLines, 20, y);
          y += nameLines.length * 4.5;
          setF('normal', 9);
          doc.setTextColor(70, 80, 95);
          if (Number.isFinite(qty) && Number.isFinite(unit)) {
            doc.text(T(String(qty) + ' x ' + this.som(unit, '') + " so'm"), 20, y);
            doc.text(T('= ' + this.som(sum, '')), 190, y, { align: 'right' });
            y += 5;
          } else if (Number.isFinite(sum)) {
            doc.text(T('= ' + this.som(sum)), 190, y, { align: 'right' });
            y += 5;
          }
          y += 2;
        });
      } else {
        setF('normal', 9);
        doc.setTextColor(120, 120, 120);
        doc.text(T('Mahsulot qatori OFD dan kelmagan'), 105, y, { align: 'center' });
        y += 6;
      }

      if (row.vatTotal != null && Number(row.vatTotal) > 0) {
        setF('normal', 9);
        doc.setTextColor(70, 80, 95);
        doc.text(T('QQS 12.00%'), 20, y);
        doc.text(T('= ' + this.som(row.vatTotal)), 190, y, { align: 'right' });
        y += 6;
      }
      line(y);
      y += 8;
      setF('bold', 12);
      doc.setTextColor(20, 30, 45);
      doc.text(T('JAMI'), 20, y);
      doc.text(T('= ' + amt), 190, y, { align: 'right' });
      y += 7;
      if (row.cardTotal != null && Number(row.cardTotal) > 0) {
        setF('normal', 9);
        doc.text(T('PL.KARTA' + (row.cardType ? (' · ' + row.cardType) : '')), 20, y);
        doc.text(T('= ' + this.som(row.cardTotal)), 190, y, { align: 'right' });
        y += 5;
      } else if (row.cashTotal != null && Number(row.cashTotal) > 0) {
        setF('normal', 9);
        doc.text(T('NAQD'), 20, y);
        doc.text(T('= ' + this.som(row.cashTotal)), 190, y, { align: 'right' });
        y += 5;
      }
      line(y);
      y += 8;

      const meta = [
        ['Mashina', row.plate || '—'],
        ['Haydovchi', d.shortName || d.fullName || '—'],
        ['STIR', row.inn || '—'],
        ['FM', row.kkmName || '—'],
        ['Terminal', row.terminalId || '—'],
        ['Chek №', row.receiptNo || '—'],
        ['FB', row.fiscalSign || '—'],
        ['Holat', this.ofdLabel(row)]
      ];
      setF('normal', 9);
      meta.forEach((pair) => {
        if (!pair[1] || pair[1] === '—') {
          if (pair[0] === 'FM' || pair[0] === 'STIR') return;
        }
        doc.setTextColor(90, 100, 115);
        doc.text(T(pair[0]), 20, y);
        doc.setTextColor(20, 30, 45);
        doc.text(T(String(pair[1])), 190, y, { align: 'right' });
        y += 5.2;
      });

      y += 6;
      setF('normal', 8);
      doc.setTextColor(120, 130, 140);
      doc.text(T('VaksinaMed · Zapravka cheki · hisobotga ta\'sir qilmaydi'), 105, y, { align: 'center' });
      if (row.qr) {
        y += 5;
        const shortQr = String(row.qr).length > 70 ? String(row.qr).slice(0, 67) + '...' : String(row.qr);
        doc.text(T(shortQr), 105, y, { align: 'center' });
      }

      const plateSafe = String(row.plate || 'chek').replace(/\s+/g, '_');
      const noSafe = String(row.receiptNo || row.id || 'ofd').replace(/[^\w.-]+/g, '');
      const name = 'chek-' + plateSafe + '-' + noSafe + '.pdf';
      doc.save(name);
      this.toast('PDF yuklandi');
    } catch (e) {
      this.toast((e && e.message) || 'PDF chiqmadi');
    }
  },

  paperHtml(r, forPreview) {
    const d = this.driverOf(r.plate);
    const merchant = r.merchant || r.kkmName || '';
    const items = (r.items || []).filter(it => it && it.name).slice(0, 16).map(it => {
      const qty = it.qty != null && it.qty !== '' ? Number(it.qty) : NaN;
      const sum = it.sum != null && it.sum !== '' ? Number(it.sum) : NaN;
      const unit = Number.isFinite(qty) && qty !== 0 && Number.isFinite(sum) ? (sum / qty) : NaN;
      const qtyLine = Number.isFinite(qty) && Number.isFinite(unit)
        ? `<div class="chek-p-row"><span>${this.esc(String(qty))} × ${this.esc(this.som(unit, ''))} so'm</span><b>= ${this.esc(this.som(sum, ''))}</b></div>`
        : (Number.isFinite(sum) ? `<div class="chek-p-row"><span></span><b>= ${this.esc(this.som(sum))}</b></div>` : '');
      return `<div class="chek-p-prod"><div class="chek-p-prod-n">${this.esc(it.name)}</div>${qtyLine}</div>`;
    }).join('');
    const vatN = r.vatTotal != null && Number(r.vatTotal) > 0 ? Number(r.vatTotal) : null;
    const cardN = r.cardTotal != null && Number(r.cardTotal) > 0 ? Number(r.cardTotal) : null;
    const cashN = r.cashTotal != null && Number(r.cashTotal) > 0 ? Number(r.cashTotal) : null;
    const payName = r.cardType || r.payMethod || (cardN ? 'PL.KARTA' : (cashN ? 'NAQD' : ''));
    const vat = vatN != null
      ? `<div class="chek-p-row"><span>QQS 12.00%</span><b>= ${this.esc(this.som(vatN))}</b></div>` : '';
    const payLine = (cardN || cashN)
      ? `<div class="chek-p-row"><span>${this.esc(cardN ? ('PL.KARTA so\'m' + (r.cardType ? (' · ' + r.cardType) : '')) : 'NAQD so\'m')}</span><b>= ${this.esc(this.som(cardN || cashN))}</b></div>`
      : (payName ? `<div class="chek-p-row"><span>To‘lov</span><b>${this.esc(payName)}</b></div>` : '');
    const vatJami = vatN != null
      ? `<div class="chek-p-row"><span>QQS qiymati</span><b>= ${this.esc(this.som(vatN))}</b></div>` : '';
    const kind = this.ofdKind(r);
    const warn = kind === 'ok'
      ? ''
      : `<div class="chek-p-warn">${this.esc(r.ofdNote || 'OFD dan to‘liq chek olinmoqda — o‘zi tushadi, qo‘lda yozish shart emas.')}</div>`;
    const saved = (!forPreview && this.paperFromScan)
      ? `<div class="chek-p-ok">${this.paperDup ? 'Bu chek avval saqlangan' : 'Yangi chek · monitorga tushdi'}</div>`
      : '';
    const amtVal = r.amount != null && r.amount !== '' && Number.isFinite(Number(r.amount))
      ? String(Math.round(Number(r.amount))) : '';
    const manual = (forPreview || r.ofdOk) ? '' : `<details class="chek-p-manual">
      <summary>OFD kechiksa — qo‘lda yozish</summary>
      <p>Odatda shart emas. OFD tasdiqlasa stansiya, mahsulot va JAMI o‘zi tushadi.</p>
      <label>Summa (so‘m)</label>
      <input type="number" id="chek-manual-amt" min="1" step="1" inputmode="numeric" placeholder="masalan 72000" value="${this.esc(amtVal)}">
      <label>Stansiya nomi</label>
      <input type="text" id="chek-manual-mer" placeholder="Zapravka nomi" value="${this.esc(r.merchant || '')}">
      <button type="button" class="btn btn-gold chek-scan-alt" id="chek-manual-save">Saqlash</button>
    </details>`;
    const qr = r.qr
      ? `<div class="chek-p-qrbox">
          <img alt="OFD QR" width="168" height="168" src="https://api.qrserver.com/v1/create-qr-code/?size=168x168&amp;margin=2&amp;data=${encodeURIComponent(r.qr)}">
        </div>`
      : '';
    const confirmed = r.ofdOk || (r.amount != null && r.amount !== '');
    return `
      <div class="chek-uz">
        <div class="chek-uz-brand">${this.esc(r.cardType || r.payMethod || 'UZCARD')}</div>
        ${merchant ? `<div class="chek-uz-mer">${this.esc(merchant)}</div>` : ''}
        ${r.address ? `<div class="chek-p-sub">${this.esc(r.address)}</div>` : ''}
        <div class="chek-p-row"><span>Sanasi</span><b>${this.esc(this.when(r))}</b></div>
        <div class="chek-uz-pay">To‘lov qilish</div>
        <div class="chek-uz-sum">${this.esc(this.som(r.amount))} UZS</div>
        <div class="chek-uz-ok">${confirmed ? 'Tasdiqlangan' : 'OFD kutilmoqda'}</div>
      </div>
      ${merchant ? `<div class="chek-p-title">${this.esc(merchant)}</div>` : ''}
      <div class="chek-p-flag">SOTUV CHEKI</div>
      <hr class="chek-p-line">
      ${items || '<div class="chek-p-sub">Mahsulot qatori OFD dan kutilmoqda</div>'}
      ${vat}
      <hr class="chek-p-line">
      <div class="chek-p-total"><span>JAMI</span><b>= ${this.esc(this.som(r.amount))}</b></div>
      ${vatJami}${payLine}
      <hr class="chek-p-line">
      <div class="chek-p-row"><span>Mashina</span><b>${this.esc(r.plate || '')}</b></div>
      <div class="chek-p-row"><span>Haydovchi</span><b>${this.esc(d.shortName || d.fullName || '—')}</b></div>
      <div class="chek-p-row"><span>STIR</span><b>${this.esc(r.inn || '—')}</b></div>
      ${r.kkmName ? `<div class="chek-p-row"><span>FM</span><b>${this.esc(r.kkmName)}</b></div>` : ''}
      <div class="chek-p-row"><span>Terminal</span><b>${this.esc(r.terminalId || '—')}</b></div>
      <div class="chek-p-row"><span>Chek №</span><b>${this.esc(r.receiptNo || '—')}</b></div>
      <div class="chek-p-row"><span>FB</span><b>${this.esc(r.fiscalSign || '—')}</b></div>
      <div class="chek-pill ${kind}" style="margin:12px auto 0;">${this.esc(this.ofdLabel(r))}</div>
      ${qr}
      ${warn}${saved}${manual}`;
  },

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  },

  toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
    else if (typeof toast === 'function') toast(msg);
  },

  setStatus(text, kind) {
    const el = document.getElementById('chek-scan-status');
    if (!el) return;
    if (!text) {
      el.className = 'chek-scan-status';
      el.textContent = '';
      return;
    }
    el.className = 'chek-scan-status on' + (kind ? ' ' + kind : '');
    el.textContent = text;
  },

  setManualStatus(text, kind) {
    const el = document.getElementById('chek-manual-status');
    if (!el) return;
    if (!text) {
      el.className = 'chek-scan-status';
      el.textContent = '';
      return;
    }
    el.className = 'chek-scan-status on' + (kind ? ' ' + kind : '');
    el.textContent = text;
  },

  bind() {
    const board = document.getElementById('chek-board');
    if (!board || board._vmChekBound) return;
    board._vmChekBound = true;
    const periodHost = document.getElementById('chek-period');
    if (periodHost && !periodHost._vmChekBound) {
      periodHost._vmChekBound = true;
      periodHost.addEventListener('click', (e) => {
        if (e.target.closest('#chek-period-prev')) {
          this.setPeriod(this.shiftYm(this.currentYm(), -1));
          return;
        }
        if (e.target.closest('#chek-period-next')) {
          this.setPeriod(this.shiftYm(this.currentYm(), 1));
          return;
        }
        if (e.target.closest('#chek-period-now')) {
          this.setDay(this.todayStr());
          return;
        }
        if (e.target.closest('#chek-cal-month')) {
          this.setDay('');
          return;
        }
        const dayBtn = e.target.closest('[data-chek-day]');
        if (dayBtn) {
          const ds = dayBtn.getAttribute('data-chek-day');
          if (!ds) return;
          if (this.currentDay() === ds) this.setDay('');
          else this.setDay(ds);
        }
      });
    }
    board.addEventListener('click', (e) => {
      const back = e.target.closest('#chek-back');
      if (back) {
        this.openPlate = '';
        this.selectedId = '';
        this.render();
        return;
      }
      const add = e.target.closest('#chek-add');
      if (add) {
        this.openScan(this.openPlate);
        return;
      }
      const manOpen = e.target.closest('#chek-manual-open');
      if (manOpen) {
        this.openManual(this.openPlate);
        return;
      }
      const pdfBtn = e.target.closest('.chek-act-pdf');
      if (pdfBtn) {
        e.preventDefault();
        const id = pdfBtn.getAttribute('data-id');
        if (id) this.downloadPdf(id);
        return;
      }
      const delBtn = e.target.closest('.chek-act-del');
      if (delBtn) {
        e.preventDefault();
        const id = delBtn.getAttribute('data-id');
        if (id) this.remove(id);
        return;
      }
      const editBtn = e.target.closest('.chek-act-edit');
      if (editBtn) {
        e.preventDefault();
        const id = editBtn.getAttribute('data-id');
        const row = this.items.find(x => String(x.id) === String(id));
        if (row) {
          this.selectedId = String(row.id);
          this.openPaper(row, false, false);
        }
        return;
      }
      const mini = e.target.closest('.chek-mini');
      if (mini) {
        const id = mini.getAttribute('data-id');
        const row = this.items.find(x => String(x.id) === String(id));
        if (!row) return;
        this.selectedId = String(row.id);
        this._renderSig = '';
        this.render();
        const preview = document.getElementById('chek-preview');
        if (preview && window.matchMedia && window.matchMedia('(max-width: 980px)').matches) {
          preview.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        return;
      }
      const card = e.target.closest('.chek-card');
      if (card) {
        const plate = card.getAttribute('data-plate');
        if (plate) {
          this.openPlate = plate;
          this.selectedId = '';
          this._renderSig = '';
          this.render();
          this.kickPending(plate);
        }
      }
    });
    const close = document.getElementById('chek-scan-close');
    if (close) close.onclick = () => this.closeScan();
    const paste = document.getElementById('chek-scan-paste');
    if (paste) paste.onclick = () => this.submitPaste();
    const toManual = document.getElementById('chek-scan-to-manual');
    if (toManual) toManual.onclick = async () => {
      const plate = this.openPlate;
      await this.closeScan();
      this.openManual(plate);
    };
    const live = document.getElementById('chek-scan-live');
    if (live) live.onclick = () => this.startCamera();
    const file = document.getElementById('chek-scan-file');
    if (file) file.onchange = (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (f) this.scanFile(f);
      ev.target.value = '';
    };
    const gal = document.getElementById('chek-scan-gallery');
    if (gal) gal.onchange = (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (f) this.scanFile(f);
      ev.target.value = '';
    };
    const mClose = document.getElementById('chek-manual-close');
    const mCancel = document.getElementById('chek-manual-cancel');
    if (mClose) mClose.onclick = () => this.closeManual();
    if (mCancel) mCancel.onclick = () => this.closeManual();
    const mSubmit = document.getElementById('chek-manual-submit');
    if (mSubmit) mSubmit.onclick = () => this.submitManual();
    const mModal = document.getElementById('chek-manual-modal');
    if (mModal && !mModal._vmBgClose) {
      mModal._vmBgClose = true;
      mModal.addEventListener('click', (e) => {
        if (e.target === mModal) this.closeManual();
      });
    }
    ['chek-m-term', 'chek-m-rno', 'chek-m-when', 'chek-m-fb'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el || el._vmEnter) return;
      el._vmEnter = true;
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          this.submitManual();
        }
      });
    });
    const pClose = document.getElementById('chek-paper-close');
    const pDone = document.getElementById('chek-paper-done');
    if (pClose) pClose.onclick = () => this.closePaper();
    if (pDone) pDone.onclick = () => this.closePaper();
    const pAgain = document.getElementById('chek-paper-again');
    if (pAgain) pAgain.onclick = () => {
      const plate = this.openPlate || (this.paperItem && this.paperItem.plate);
      this.closePaper();
      this.openScan(plate);
    };
    const pPdf = document.getElementById('chek-paper-pdf');
    if (pPdf) pPdf.onclick = () => {
      if (this.paperItem) this.downloadPdf(this.paperItem);
      else this.toast('Avval chekni oching');
    };
    const paperModal = document.getElementById('chek-paper-modal');
    if (paperModal && !paperModal._vmBgClose) {
      paperModal._vmBgClose = true;
      paperModal.addEventListener('click', (e) => {
        if (e.target === paperModal) this.closePaper();
      });
    }
    const pDel = document.getElementById('chek-paper-del');
    if (pDel) pDel.onclick = () => {
      const id = this.paperItem && this.paperItem.id;
      if (id) this.remove(id);
    };
    const pRef = document.getElementById('chek-paper-refresh');
    if (pRef) pRef.onclick = () => this.refreshOfd();
    const paper = document.getElementById('chek-paper');
    if (paper && !paper._vmChekBound) {
      paper._vmChekBound = true;
      paper.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'chek-manual-save') this.saveManual();
      });
    }
    this.armAudio();
    this.startPoll();
    this.loadLib().catch(() => {});
  },

  startPoll() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      if (document.hidden) return;
      this.load(true);
    }, 700);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) this.load(true);
    });
  },

  kickPending(forcePlate) {
    if (this._kickBusy) return;
    const now = Date.now();
    const forceAll = forcePlate === true;
    const plate = forceAll ? '' : forcePlate;
    if (!forcePlate && this._kickAt && now - this._kickAt < 2500) return;
    const openKey = this.plateKey(plate || this.openPlate);
    const pending = this.items.filter((x) => x && x.id && String(x.id).indexOf('tmp') !== 0 && !x.ofdOk);
    pending.sort((a, b) => {
      const ap = openKey && this.plateKey(a.plate) === openKey ? 0 : 1;
      const bp = openKey && this.plateKey(b.plate) === openKey ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const ar = Date.parse(String(a.ofdRefreshedAt || '').replace(' ', 'T')) || 0;
      const br = Date.parse(String(b.ofdRefreshedAt || '').replace(' ', 'T')) || 0;
      return ar - br;
    });
    const need = pending.filter((x) => {
      if (forceAll) return true;
      if (this.paperItem && String(this.paperItem.id) === String(x.id)) return true;
      if (plate && this.plateKey(x.plate) === openKey) return true;
      const refreshed = Date.parse(String(x.ofdRefreshedAt || '').replace(' ', 'T'));
      const created = Date.parse(String(x.createdAt || x.paidAt || '').replace(' ', 'T'));
      const age = Number.isFinite(created) ? now - created : 0;
      const gap = age > 86400000 ? 60000 : (age > 3600000 ? 15000 : 5000);
      if (Number.isFinite(refreshed) && now - refreshed < gap) return false;
      return true;
    }).slice(0, 4);
    if (!need.length) return;
    this._kickAt = now;
    this._kickBusy = true;
    (async () => {
      try {
        for (const row of need) {
          try {
            const d = await this.postRefresh(row);
            if (d.item) this.applyItems([d.item].concat(Array.isArray(d.items) ? d.items : []));
            else if (Array.isArray(d.items)) this.applyItems(d.items);
          } catch (e) {}
        }
        this.render();
      } finally {
        this._kickBusy = false;
      }
    })();
  },

  armAudio() {
    const wake = () => {
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!this._ac) this._ac = new AC();
        if (this._ac.state === 'suspended') this._ac.resume();
      } catch (e) {}
    };
    document.addEventListener('click', wake, { passive: true });
    document.addEventListener('touchstart', wake, { passive: true });
  },

  flash() {
    const el = document.getElementById('chek-flash');
    if (!el) return;
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
    setTimeout(() => el.classList.remove('on'), 700);
  },

  beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!this._ac) this._ac = new AC();
      const ctx = this._ac;
      if (ctx.state === 'suspended') ctx.resume();
      const ding = (freq, start, dur, vol) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(freq, start);
        g.gain.setValueAtTime(0.0001, start);
        g.gain.exponentialRampToValueAtTime(vol, start + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(start);
        o.stop(start + dur + 0.02);
      };
      const now = ctx.currentTime;
      ding(1318.5, now, 0.12, 0.22);
      ding(1760, now + 0.13, 0.18, 0.18);
      ding(2093, now + 0.28, 0.16, 0.14);
      if (navigator.vibrate) navigator.vibrate([40, 40, 90]);
    } catch (e) {}
  },

  loadLib() {
    if (window.Html5Qrcode) return Promise.resolve();
    if (this.libPromise) return this.libPromise;
    const urls = [
      'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js'
    ];
    this.libPromise = (async () => {
      let last = null;
      for (const src of urls) {
        try {
          await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('QR modul yuklanmadi'));
            document.head.appendChild(s);
          });
          if (window.Html5Qrcode) return;
        } catch (e) {
          last = e;
        }
      }
      throw last || new Error('QR modul yuklanmadi');
    })();
    return this.libPromise;
  },

  openScan(plate) {
    this.openPlate = plate;
    this.render();
    const modal = document.getElementById('chek-scan-modal');
    const title = document.getElementById('chek-scan-title');
    const q = document.getElementById('chek-qr-text');
    const cam = document.getElementById('chek-scan-cam');
    const d = this.driverOf(plate);
    if (title) title.textContent = ((d.shortName || d.fullName || '') + ' · ' + (plate || '')).trim() + ' — QR';
    if (q) q.value = '';
    if (cam) {
      cam.classList.remove('is-on');
      cam.innerHTML = '<span class="chek-scan-ph">Kamera ochilmoqda…</span>';
    }
    this.setStatus('');
    if (modal) {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
    }
    this.startCamera();
  },

  camBox() {
    const host = document.getElementById('chek-scan-cam');
    if (host) host.classList.add('is-on');
    return host;
  },

  async pickBackCameraId() {
    try {
      if (!window.Html5Qrcode || !Html5Qrcode.getCameras) return null;
      const cams = await Html5Qrcode.getCameras();
      if (!cams || !cams.length) return null;
      const back = cams.find((c) => /back|rear|environment|orqa|world/i.test(c.label || ''));
      return (back || cams[cams.length - 1] || cams[0]).id;
    } catch (e) {
      return null;
    }
  },

  async startCamera() {
    const host = this.camBox();
    if (!host) return;
    this.setStatus('Kamera ochilmoqda — QR ni ramkaga tuting', 'busy');
    try {
      await this.stopCamera();
      if (window.BarcodeDetector && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const ok = await this.startNativeCamera(host);
        if (ok) return;
      }
      await this.loadLib();
      const camId = await this.pickBackCameraId();
      this.scanner = new window.Html5Qrcode('chek-scan-cam');
      const box = { fps: 18, qrbox: { width: 250, height: 250 }, aspectRatio: 1.333, disableFlip: false };
      const source = camId ? camId : { facingMode: { exact: 'environment' } };
      try {
        await this.scanner.start(source, box, (text) => { this.onQr(text); }, () => {});
      } catch (e1) {
        await this.scanner.start({ facingMode: 'environment' }, box, (text) => { this.onQr(text); }, () => {});
      }
      this.scanning = true;
      this.setStatus('QR qidirilmoqda — chekni kameraga tuting');
    } catch (e) {
      host.classList.remove('is-on');
      host.innerHTML = '<span class="chek-scan-ph">Kamera ochilmadi</span>';
      this.setStatus('Kamera ochilmadi. Pastdagi zaxiradan foydalaning yoki kamerani qayta oching.', 'bad');
    }
  },

  async startNativeCamera(host) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      const video = document.createElement('video');
      video.setAttribute('playsinline', 'true');
      video.setAttribute('autoplay', 'true');
      video.muted = true;
      video.srcObject = stream;
      host.innerHTML = '';
      host.appendChild(video);
      await video.play();
      const det = new window.BarcodeDetector({ formats: ['qr_code'] });
      this.nativeStream = stream;
      this.nativeVideo = video;
      this.scanning = true;
      const tick = async () => {
        if (!this.scanning || !this.nativeVideo) return;
        try {
          const codes = await det.detect(this.nativeVideo);
          if (codes && codes[0] && codes[0].rawValue) {
            this.onQr(codes[0].rawValue);
            return;
          }
        } catch (e) {}
        this.nativeLoop = setTimeout(tick, 90);
      };
      tick();
      this.setStatus('QR qidirilmoqda — chekni kameraga tuting');
      return true;
    } catch (e) {
      this.stopNative();
      return false;
    }
  },

  stopNative() {
    if (this.nativeLoop) {
      clearTimeout(this.nativeLoop);
      this.nativeLoop = null;
    }
    if (this.nativeStream) {
      this.nativeStream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
      this.nativeStream = null;
    }
    this.nativeVideo = null;
  },

  async stopCamera() {
    this.scanning = false;
    this.stopNative();
    if (this.scanner) {
      try { await this.scanner.stop(); } catch (e) {}
      try { this.scanner.clear(); } catch (e) {}
      this.scanner = null;
    }
  },

  async scanFile(file) {
    this.setStatus('Rasm o‘qilmoqda…', 'busy');
    try {
      await this.stopCamera();
      await this.loadLib();
      const host = this.camBox();
      if (host) host.innerHTML = '';
      const tmp = new window.Html5Qrcode(host ? 'chek-scan-cam' : 'chek-scan-file-sink');
      const text = await tmp.scanFile(file, true);
      try { tmp.clear(); } catch (e) {}
      await this.onQr(text);
    } catch (e) {
      this.setStatus('QR rasmda topilmadi. Chekdagi QR ni yaqinroq, tekis va yorug‘ qilib oling.', 'bad');
      this.toast('QR rasmda topilmadi');
    }
  },

  submitPaste() {
    const el = document.getElementById('chek-qr-text');
    const t = el && el.value.trim();
    if (!t) { this.toast('QR havolasini yozing'); return; }
    this.onQr(t);
  },

  openManual(plate) {
    this.openPlate = plate || this.openPlate;
    this.render();
    const modal = document.getElementById('chek-manual-modal');
    const title = document.getElementById('chek-manual-title');
    const d = this.driverOf(this.openPlate);
    if (title) {
      title.textContent = ((d.shortName || d.fullName || '') + ' · ' + (this.openPlate || '')).trim() + ' — qo‘lda';
    }
    const term = document.getElementById('chek-m-term');
    const rno = document.getElementById('chek-m-rno');
    const when = document.getElementById('chek-m-when');
    const fb = document.getElementById('chek-m-fb');
    const hintTerm = this.lastTerminalFor(this.openPlate);
    if (term) term.value = hintTerm || '';
    if (rno) rno.value = '';
    if (fb) fb.value = '';
    if (when) when.value = '';
    const extra = document.getElementById('chek-manual-extra');
    if (extra) extra.open = !hintTerm;
    this.setManualStatus(hintTerm
      ? ('Terminal eslab qolindi: ' + hintTerm + ' — faqat Chek № va FB yozing')
      : 'Birinchi marta: Chek № + FB. Topilmasa Terminal ni ochib yozing.');
    if (modal) {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
    }
    setTimeout(() => { if (rno) rno.focus(); }, 50);
  },

  closeManual() {
    const modal = document.getElementById('chek-manual-modal');
    this.setManualStatus('');
    if (modal) {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
    }
  },

  async submitManual() {
    if (this._busy) return;
    const receiptNo = String(((document.getElementById('chek-m-rno') || {}).value) || '').replace(/\s+/g, '').trim();
    const fiscalSign = String(((document.getElementById('chek-m-fb') || {}).value) || '').replace(/\s+/g, '').trim();
    const terminalId = String(((document.getElementById('chek-m-term') || {}).value) || '').replace(/\s+/g, '').trim();
    const when = String(((document.getElementById('chek-m-when') || {}).value) || '').trim();
    if (!receiptNo) {
      this.setManualStatus('Chek № ni yozing', 'bad');
      this.toast('Chek № ni yozing');
      return;
    }
    if (!fiscalSign) {
      this.setManualStatus('FB raqamini yozing', 'bad');
      this.toast('FB raqamini yozing');
      return;
    }
    if (!terminalId && !this.lastTerminalFor(this.openPlate) && !(this.items || []).some((x) => x && x.terminalId)) {
      const extra = document.getElementById('chek-manual-extra');
      if (extra) extra.open = true;
      this.setManualStatus('Birinchi marta Terminal ni ham yozing (keyin eslab qoladi)', 'bad');
      this.toast('Terminal ni yozing');
      const termEl = document.getElementById('chek-m-term');
      if (termEl) termEl.focus();
      return;
    }
    this.setManualStatus('OFD dan to‘liq chek qidirilmoqda…', 'busy');
    this._busy = true;
    this.flash();
    this.beep();
    const draft = {
      id: 'tmp_scan',
      plate: this.openPlate,
      receiptNo,
      fiscalSign,
      terminalId: terminalId || this.lastTerminalFor(this.openPlate),
      paidAt: when || '',
      merchant: '',
      amount: null,
      items: [],
      ofdOk: false,
      ofdPending: true,
      ofdNote: 'OFD dan qidirilmoqda…'
    };
    this.pingLive(draft);
    try {
      this.closeManual();
      this.openPaper(draft, true, false);
      const body = {
        plate: this.openPlate,
        manualLookup: true,
        receiptNo,
        fiscalSign,
        terminalId: terminalId || undefined,
        paidAt: when || undefined
      };
      const d = await vmApi('/api/office/cheks/scan', {
        method: 'POST',
        body: JSON.stringify(body),
        timeoutMs: 90000
      });
      if (d.item) this.applyItems([d.item].concat(Array.isArray(d.items) ? d.items : []));
      else if (Array.isArray(d.items)) this.applyItems(d.items);
      this.render();
      if (d.item) {
        this.selectedId = String(d.item.id);
        this.highlightId = d.item.id;
        this.openPaper(d.item, true, !!d.duplicate);
        if (!d.item.ofdOk) this.refreshOfd(true);
        this.toast(d.item.ofdOk
          ? ('Topildi: ' + (this.money(d.item.amount) || d.item.merchant || 'chek'))
          : (d.duplicate ? 'Bu chek avval saqlangan' : 'Saqlandi — OFD hali to‘ldirilmoqda'));
      } else {
        this.toast(d.error || 'Topilmadi');
      }
    } catch (e) {
      this.toast((e && e.message) || 'OFD qidiruv xato');
      this.setManualStatus((e && e.message) || 'Xato', 'bad');
    } finally {
      this._busy = false;
    }
  },

  async closeScan() {
    await this.stopCamera();
    const modal = document.getElementById('chek-scan-modal');
    const cam = document.getElementById('chek-scan-cam');
    if (cam) {
      cam.classList.remove('is-on');
      cam.innerHTML = '';
    }
    this.setStatus('');
    if (modal) {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
    }
  },

  paperSig(r) {
    if (!r) return '';
    return [r.id, r.ofdOk, r.amount, r.merchant, r.inn, (r.items || []).length, r.ofdNote, this.paperFromScan, this.paperDup].join('|');
  },

  openPaper(row, fromScan, dup) {
    this.paperItem = row;
    this.paperFromScan = !!fromScan;
    this.paperDup = !!dup;
    const box = document.getElementById('chek-paper');
    const modal = document.getElementById('chek-paper-modal');
    const title = document.getElementById('chek-paper-title');
    const again = document.getElementById('chek-paper-again');
    const sig = this.paperSig(row);
    if (box && sig !== this._paperSig) {
      box.innerHTML = this.paperHtml(row);
      this._paperSig = sig;
    }
    if (title) title.textContent = fromScan ? (dup ? 'Chek avval saqlangan' : 'Yangi fiskal chek') : 'Fiskal chek';
    if (again) again.style.display = '';
    if (modal) {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
    }
    this.watchPendingPaper();
  },

  watchPendingPaper() {
    if (!this.paperItem || this.paperItem.ofdOk) {
      if (this.pendingTimer) {
        clearTimeout(this.pendingTimer);
        this.pendingTimer = null;
      }
      this._watchId = '';
      return;
    }
    const id = String(this.paperItem.id || '');
    if (this.pendingTimer && this._watchId === id) return;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this._watchId = id;
    this._ofdTries = 0;
    const tick = () => {
      if (!this.paperItem || this.paperItem.ofdOk || String(this.paperItem.id) !== id) {
        this.pendingTimer = null;
        return;
      }
      this.refreshOfd(true);
      this._ofdTries = (this._ofdTries || 0) + 1;
      const wait = this._ofdTries < 8 ? 2500 : 15000;
      this.pendingTimer = setTimeout(tick, wait);
    };
    this.pendingTimer = setTimeout(tick, this.paperFromScan ? 600 : 2000);
  },

  closePaper() {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    const closed = this.paperItem;
    const modal = document.getElementById('chek-paper-modal');
    if (modal) {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
    }
    this.paperItem = null;
    this.paperFromScan = false;
    this.paperDup = false;
    this._paperSig = '';
    this._watchId = '';
    if (closed && closed.plate) this.openPlate = closed.plate;
    if (closed && closed.id && String(closed.id).indexOf('tmp') !== 0) {
      this.highlightId = closed.id;
      this.selectedId = String(closed.id);
    }
    this.render();
    this.kickPending();
  },

  async onQr(text) {
    if (this._busy) return;
    const raw = String(text || '').trim();
    const draft = this.parseQr(raw);
    if (!draft) {
      this.setStatus('Bu soliq/OFD chek QR emas. Chekdagi pastki QR ni skanerlang.', 'bad');
      this.toast('Bu OFD chek QR emas');
      return;
    }
    this._busy = true;
    this.flash();
    this.beep();
    this.pingLive(draft);
    try {
      await this.closeScan();
      this.openPaper(Object.assign({ id: 'tmp_scan' }, draft), true, false);
      const d = await vmApi('/api/office/cheks/scan', {
        method: 'POST',
        body: JSON.stringify({ plate: this.openPlate, qr: raw }),
        timeoutMs: 12000
      });
      if (d.item) this.applyItems([d.item].concat(Array.isArray(d.items) ? d.items : []));
      else if (Array.isArray(d.items)) this.applyItems(d.items);
      this.render();
      if (d.item) {
        const keep = this.paperItem && (
          String(this.paperItem.id) === 'tmp_scan' ||
          String(this.paperItem.id) === String(d.item.id)
        );
        if (keep) {
          this.openPaper(d.item, true, !!d.duplicate);
          this.refreshOfd(true);
        } else {
          this.highlightId = d.item.id;
          this.render();
          this.kickPending();
        }
      } else {
        this.toast(d.duplicate ? 'Bu chek avval saqlangan' : 'Chek saqlandi');
      }
    } catch (e) {
      this.toast(e.message || 'Chek saqlanmadi');
      if (this.paperItem && String(this.paperItem.id) === 'tmp_scan') {
        this.paperItem.ofdNote = e.message || 'Serverga yozilmadi. Internetni tekshiring.';
        this.openPaper(this.paperItem, true, false);
      }
    } finally {
      this._busy = false;
    }
  },

  async refreshOfd(silent) {
    const id = this.paperItem && this.paperItem.id;
    if (!id || String(id).indexOf('tmp') === 0) return;
    if (!this._refBusyIds) this._refBusyIds = new Set();
    const key = String(id);
    if (this._refBusyIds.has(key)) return;
    this._refBusyIds.add(key);
    if (!silent) this.toast('OFD dan qayta so‘ralmoqda…');
    try {
      const d = await this.postRefresh(this.paperItem);
      if (d.item) this.applyItems([d.item].concat(Array.isArray(d.items) ? d.items : []));
      else if (Array.isArray(d.items)) this.applyItems(d.items);
      if (d.item) {
        const stillOpen = this.paperItem && String(this.paperItem.id) === key;
        if (stillOpen) {
          const was = this.paperItem.ofdOk;
          this.paperItem = d.item;
          this.openPaper(d.item, this.paperFromScan, this.paperDup);
          if (!silent) this.toast(d.item.ofdOk ? 'OFD dan to‘liq chek keldi' : (d.item.ofdNote || 'Hali shakllanmoqda'));
          else if (d.item.ofdOk && !was) {
            this.beep();
            this.toast('OFD dan to‘liq chek keldi');
          }
        } else if (d.item.ofdOk && !this.scanning) {
          this.highlightId = d.item.id;
        }
      }
      this.render();
    } catch (e) {
      if (!silent) this.toast(e.message || 'OFD ochilmadi');
    } finally {
      this._refBusyIds.delete(key);
    }
  },

  async saveManual() {
    const id = this.paperItem && this.paperItem.id;
    const amt = document.getElementById('chek-manual-amt');
    const mer = document.getElementById('chek-manual-mer');
    if (!id || String(id).indexOf('tmp') === 0) {
      this.toast('Avval chek saqlansin');
      return;
    }
    const body = { id, merchant: mer && mer.value };
    if (amt && String(amt.value).trim()) body.amount = amt.value;
    try {
      const d = await vmApi('/api/office/cheks/update', {
        method: 'POST',
        body: JSON.stringify(body)
      });
      if (d.item) this.applyItems([d.item].concat(Array.isArray(d.items) ? d.items : []));
      else if (Array.isArray(d.items)) this.applyItems(d.items);
      if (d.item) {
        this.paperItem = d.item;
        this.openPaper(d.item, this.paperFromScan, this.paperDup);
      }
      this.render();
      this.toast('Chek yangilandi');
    } catch (e) {
      this.toast(e.message || 'Saqlanmadi');
    }
  },

  async remove(id) {
    if (!id || String(id).indexOf('tmp') === 0) return;
    if (!confirm('Shu chek o‘chirilsinmi? (faqat shu bo‘lim, hisobotga tegmaydi)')) return;
    try {
      if (!this.deletedIds) this.deletedIds = new Set();
      this.deletedIds.add(String(id));
      const d = await vmApi('/api/office/cheks/delete', {
        method: 'POST',
        body: JSON.stringify({ id })
      });
      this.items = (this.items || []).filter((x) => String(x.id) !== String(id));
      if (Array.isArray(d.items)) this.applyItems(d.items);
      this.items = (this.items || []).filter((x) => !this.deletedIds.has(String(x.id)));
      this.closePaper();
      if (String(this.selectedId) === String(id)) this.selectedId = '';
      if (String(this.highlightId) === String(id)) this.highlightId = '';
      this._renderSig = '';
      this.render();
      this.toast('Chek o‘chirildi');
    } catch (e) {
      this.toast(e.message || 'O‘chirilmadi');
    }
  }
};

window.VMCheks = VMCheks;
document.addEventListener('DOMContentLoaded', () => {
  if (!document.getElementById('chek-fleet')) return;
  try {
    const saved = String(localStorage.getItem('vm_chek_period') || '').slice(0, 7);
    if (/^\d{4}-\d{2}$/.test(saved)) VMCheks.periodYm = saved;
    const savedDay = String(localStorage.getItem('vm_chek_day') || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(savedDay)) VMCheks.periodDay = savedDay;
  } catch (e) {}
  if (!VMCheks.periodYm) VMCheks.periodYm = VMCheks.ymNow();
  VMCheks.bind();
  VMCheks.load();
  setTimeout(() => { if (!VMCheks.drivers().length) VMCheks.load(); }, 700);
});
