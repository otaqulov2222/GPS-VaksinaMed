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

  inMonth(r, ym) {
    const d = String(r.paidAt || r.createdAt || '').replace(' ', 'T');
    return d.slice(0, 7) === ym;
  },

  stats(list, ym) {
    const month = (list || []).filter(r => this.inMonth(r, ym));
    const sum = (arr) => arr.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    return {
      count: list.length,
      sum: sum(list),
      monthCount: month.length,
      monthSum: sum(month)
    };
  },

  when(r) {
    const raw = String((r && (r.paidAt || r.createdAt)) || '');
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return raw || '—';
    return m[3] + '.' + m[2] + '.' + m[1] + (m[4] ? ('  ' + m[4] + ':' + m[5]) : '');
  },

  ofdKind(r) {
    if (r && r.ofdOk && Number(r.amount) > 0) return 'ok';
    if (r && (r.ofdPending || !r.ofdOk)) return 'wait';
    return 'wait';
  },

  ofdLabel(r) {
    if (this.ofdKind(r) === 'ok') return 'OFD tasdiqlagan';
    if (r && r.manual) return 'Summa kiritilgan';
    return 'OFD kutilmoqda';
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
        this.pingLive(row);
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
    if (!fromPoll) this.kickPending();
  },

  pingLive(row) {
    const d = this.driverOf(row && row.plate);
    const who = (d.shortName || d.fullName || row.plate || 'Mashina').trim();
    this.lastPing = who + ' · yangi chek tushdi';
    const live = document.getElementById('chek-live-text');
    if (live) live.textContent = this.lastPing;
  },

  render() {
    const fleet = document.getElementById('chek-fleet');
    const view = document.getElementById('chek-car-view');
    const totals = document.getElementById('chek-totals');
    const meta = document.getElementById('chek-board-meta');
    if (!fleet || !view) return;
    const rows = this.drivers();
    const ym = this.ymNow();
    const all = this.stats(this.items, ym);
    const sig = [this.openPlate, this.highlightId, rows.length, this.items.map((x) => [x.id, x.ofdOk, x.amount, x.merchant].join(':')).join(',')].join('|');
    if (sig === this._renderSig) return;
    this._renderSig = sig;
    if (meta) {
      meta.textContent = all.count
        ? (all.monthCount + ' chek shu oy · ' + (this.money(all.monthSum) || '0 so‘m'))
        : 'Hisobotga yozilmaydi';
    }
    if (totals) {
      totals.innerHTML = `
        <div class="chek-tot"><b>${rows.length}</b><span>Mashina</span></div>
        <div class="chek-tot"><b>${all.monthCount}</b><span>Chek (oy)</span></div>
        <div class="chek-tot"><b>${this.money(all.monthSum) || '0 so‘m'}</b><span>Jami (oy)</span></div>`;
    }
    const open = this.openPlate;
    if (open) {
      fleet.hidden = true;
      view.hidden = false;
      if (totals) totals.hidden = true;
      this.renderCar(view, open, ym);
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
      const list = this.forPlate(plate);
      const st = this.stats(list, ym);
      const last = list[0];
      const photo = typeof fleetPhotoHtml === 'function' ? fleetPhotoHtml(plate, 'fb-photo') : '';
      const model = typeof fleetModelOf === 'function' ? fleetModelOf(plate) : '';
      const minfo = model && window.FLEET_MODELS ? window.FLEET_MODELS[model] : null;
      const name = d.shortName || d.fullName || '—';
      const lastLine = last
        ? (this.moneyOrWait(last.amount) + ' · ' + this.when(last))
        : 'Hali chek yo‘q';
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
          <small>${st.monthCount ? (st.monthCount + ' chek · shu oy') : 'chek yo‘q'}</small>
        </span>
        <span class="chek-go" aria-hidden="true">›</span>
      </button>`;
    }).join('');
  },

  renderCar(view, plate, ym) {
    const d = this.driverOf(plate);
    const list = this.forPlate(plate);
    const st = this.stats(list, ym);
    const photo = typeof fleetPhotoHtml === 'function' ? fleetPhotoHtml(plate, 'fb-photo') : '';
    const model = typeof fleetModelOf === 'function' ? fleetModelOf(plate) : '';
    const minfo = model && window.FLEET_MODELS ? window.FLEET_MODELS[model] : null;
    const name = d.shortName || d.fullName || '—';
    const rows = list.length
      ? `<ul class="chek-list">${list.map(r => this.miniHtml(r)).join('')}</ul>`
      : '<div class="chek-empty">Bu mashinada hali chek yo‘q. «QR skaner» ni bosing — kamerani chekdagi QR ga tuting, rasm olish shart emas. Qog‘oz chek o‘zi yasaladi.</div>';
    view.innerHTML = `
      <button type="button" class="chek-back" id="chek-back">← Mashinalar</button>
      <div class="chek-car-head">
        <span class="fb-thumb${minfo ? ' cls-' + minfo.cls : ''}">${photo}</span>
        <span class="chek-who">
          <b>${this.esc(name)}</b>
          <em class="font-mono">${this.esc(plate)}</em>
        </span>
      </div>
      <div class="chek-stats">
        <div class="chek-stat"><span>Shu oy cheklar</span><b>${st.monthCount}</b></div>
        <div class="chek-stat"><span>Shu oy summa</span><b>${this.money(st.monthSum) || '0 so‘m'}</b></div>
      </div>
      <button type="button" class="btn btn-gold chek-add-btn" id="chek-add">QR skaner — kamera o‘zi o‘qiydi</button>
      ${rows}`;
  },

  miniHtml(r) {
    const kind = this.ofdKind(r);
    const id = this.esc(r.id);
    const neu = this.highlightId && String(this.highlightId) === String(r.id);
    return `<li class="chek-mini-wrap">
      <button type="button" class="chek-mini${neu ? ' is-new' : ''}" data-id="${id}">
        <div class="chek-mini-h">
          <b>${this.esc(this.moneyOrWait(r.amount))}</b>
          <small>${this.esc(this.when(r))}</small>
        </div>
        <em>${this.esc(r.merchant || r.kkmName || 'Zapravka cheki')}</em>
        <span>Chek № ${this.esc(r.receiptNo || '—')} · ${this.esc(r.terminalId || '')}</span>
        <i class="chek-pill ${kind}">${this.esc(this.ofdLabel(r))}</i>
      </button>
      <div class="chek-mini-acts">
        <button type="button" class="btn btn-outline chek-act chek-act-edit" data-id="${id}">Tahrirlash</button>
        <button type="button" class="btn btn-outline chek-act chek-act-del" data-id="${id}">O‘chirish</button>
      </div>
    </li>`;
  },

  paperHtml(r) {
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
    const saved = this.paperFromScan
      ? `<div class="chek-p-ok">${this.paperDup ? 'Bu chek avval saqlangan' : 'Yangi chek · monitorga tushdi'}</div>`
      : '';
    const amtVal = r.amount != null && r.amount !== '' && Number.isFinite(Number(r.amount))
      ? String(Math.round(Number(r.amount))) : '';
    const manual = r.ofdOk ? '' : `<details class="chek-p-manual">
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

  bind() {
    const board = document.getElementById('chek-board');
    if (!board || board._vmChekBound) return;
    board._vmChekBound = true;
    board.addEventListener('click', (e) => {
      const back = e.target.closest('#chek-back');
      if (back) {
        this.openPlate = '';
        this.render();
        return;
      }
      const add = e.target.closest('#chek-add');
      if (add) {
        this.openScan(this.openPlate);
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
        if (row) this.openPaper(row, false, false);
        return;
      }
      const mini = e.target.closest('.chek-mini');
      if (mini) {
        const id = mini.getAttribute('data-id');
        const row = this.items.find(x => String(x.id) === String(id));
        if (row) this.openPaper(row, false, false);
        return;
      }
      const card = e.target.closest('.chek-card');
      if (card) {
        const plate = card.getAttribute('data-plate');
        if (plate) {
          this.openPlate = plate;
          this.render();
        }
      }
    });
    const close = document.getElementById('chek-scan-close');
    if (close) close.onclick = () => this.closeScan();
    const paste = document.getElementById('chek-scan-paste');
    if (paste) paste.onclick = () => this.submitPaste();
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

  kickPending() {
    if (this._kickBusy) return;
    const now = Date.now();
    if (this._kickAt && now - this._kickAt < 2500) return;
    const need = this.items.filter((x) => {
      if (!x || !x.id || String(x.id).indexOf('tmp') === 0 || x.ofdOk) return false;
      if (this.paperItem && String(this.paperItem.id) === String(x.id)) return true;
      const t = Date.parse(String(x.createdAt || '').replace(' ', 'T'));
      if (!Number.isFinite(t)) return true;
      return (now - t) < 20 * 60 * 1000;
    }).slice(0, 2);
    if (!need.length) return;
    this._kickAt = now;
    this._kickBusy = true;
    (async () => {
      try {
        for (const row of need) {
          try {
            const d = await vmApi('/api/office/cheks/refresh', {
              method: 'POST',
              body: JSON.stringify({ id: row.id }),
              timeoutMs: 28000
            });
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
      const d = await vmApi('/api/office/cheks/refresh', {
        method: 'POST',
        body: JSON.stringify({ id }),
        timeoutMs: 28000
      });
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
  VMCheks.bind();
  VMCheks.load();
  setTimeout(() => { if (!VMCheks.drivers().length) VMCheks.load(); }, 700);
});
