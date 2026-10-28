'use strict';
/* Zapravka cheklari — sandbox. Yoqilg'i/GPS hisobiga yozilmaydi. */

const VMCheks = {
  items: [],
  openPlate: '',
  scanning: false,
  scanner: null,
  libPromise: null,

  money(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || !n) return '—';
    return Math.round(n).toLocaleString('uz-UZ').replace(/,/g, ' ') + " so'm";
  },

  drivers() {
    let list = [];
    if (typeof fleetDriversLive === 'function') list = fleetDriversLive();
    else if (window.VMOffice && typeof VMOffice.driversList === 'function') list = VMOffice.driversList();
    else list = window.DRIVERS || [];
    return list.map(raw => (typeof resolveDriver === 'function' ? resolveDriver(raw.car, raw) : raw));
  },

  plateKey(p) {
    if (typeof fleetPlateKey === 'function') return fleetPlateKey(p);
    return String(p || '').replace(/\s+/g, '').toUpperCase();
  },

  forPlate(plate) {
    const k = this.plateKey(plate);
    return this.items.filter(x => this.plateKey(x.plate) === k);
  },

  monthSum(plate) {
    const now = new Date();
    const ym = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    return this.forPlate(plate).reduce((s, r) => {
      const d = String(r.paidAt || r.createdAt || '');
      if (d.replace(' ', 'T').slice(0, 7) !== ym) return s;
      return s + (Number(r.amount) || 0);
    }, 0);
  },

  async load() {
    try {
      const d = await vmApi('/api/office/cheks');
      this.items = Array.isArray(d.items) ? d.items : [];
    } catch (e) {
      this.items = [];
    }
    this.render();
  },

  render() {
    const box = document.getElementById('chek-fleet');
    const meta = document.getElementById('chek-board-meta');
    if (!box) return;
    const rows = this.drivers();
    const total = this.items.length;
    if (meta) meta.textContent = total ? (total + ' chek · sinov arxivi') : 'Sinov bo‘limi · hisobotga ta’sir qilmaydi';
    if (!rows.length) {
      box.innerHTML = '<div class="chek-empty">Mashinalar ro‘yxati topilmadi.</div>';
      return;
    }
    box.innerHTML = rows.map((d, i) => {
      const plate = d.car || '';
      const list = this.forPlate(plate);
      const open = this.plateKey(this.openPlate) === this.plateKey(plate);
      const photo = typeof fleetPhotoHtml === 'function' ? fleetPhotoHtml(plate, 'fb-photo') : '';
      const model = typeof fleetModelOf === 'function' ? fleetModelOf(plate) : '';
      const minfo = model && window.FLEET_MODELS ? window.FLEET_MODELS[model] : null;
      const name = d.shortName || d.fullName || '—';
      const last = list[0];
      return `<article class="chek-card${open ? ' is-open' : ''}" data-plate="${this.esc(plate)}">
        <div class="chek-card-h" role="button" tabindex="0">
          <span class="chek-n">${i + 1}</span>
          <span class="fb-thumb${minfo ? ' cls-' + minfo.cls : ''}">${photo}</span>
          <span class="chek-who">
            <b>${this.esc(name)}</b>
            <em class="font-mono">${this.esc(plate)}</em>
          </span>
          <span class="chek-sum">
            <strong>${list.length ? this.money(this.monthSum(plate)) : '0 so‘m'}</strong>
            <small>${list.length ? (list.length + ' chek') : 'chek yo‘q'}${last && last.paidAt ? ' · ' + this.esc(String(last.paidAt).slice(0, 16)) : ''}</small>
          </span>
          <button type="button" class="btn btn-gold btn-sm chek-scan-btn">Chek skaner</button>
        </div>
        <div class="chek-card-b"${open ? '' : ' hidden'}>
          ${list.length ? `<ul class="chek-list">${list.map(r => this.rowHtml(r)).join('')}</ul>` : '<div class="chek-empty">Hali chek yo‘q. QR ni skanerlang.</div>'}
        </div>
      </article>`;
    }).join('');
  },

  rowHtml(r) {
    const items = (r.items || []).slice(0, 6).map(it => {
      const n = it && it.name ? it.name : '';
      const s = it && it.sum != null ? this.money(it.sum) : '';
      return n ? `<li>${this.esc(n)}${s ? ' · ' + s : ''}</li>` : '';
    }).join('');
    const warn = r.ofdOk ? '' : `<div class="chek-warn">${this.esc(r.ofdNote || 'OFD dan to‘liq summa olinmadi — QR saqlandi')}</div>`;
    return `<li class="chek-item" data-id="${this.esc(r.id)}">
      <div class="chek-item-h">
        <span class="chek-amt">${this.money(r.amount)}</span>
        <span class="chek-when">${this.esc(r.paidAt || r.createdAt || '')}</span>
        <button type="button" class="btn btn-outline btn-sm chek-del" title="O‘chirish">×</button>
      </div>
      <div class="chek-mer">${this.esc(r.merchant || 'Stansiya nomi kutilmoqda')}</div>
      <div class="chek-meta">Terminal ${this.esc(r.terminalId || '—')} · Chek № ${this.esc(r.receiptNo || '—')} · FP ${this.esc(r.fiscalSign || '—')}</div>
      ${items ? `<ul class="chek-goods">${items}</ul>` : ''}
      ${warn}
    </li>`;
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

  bind() {
    const box = document.getElementById('chek-fleet');
    if (!box || box._vmChekBound) return;
    box._vmChekBound = true;
    box.addEventListener('click', (e) => {
      const del = e.target.closest('.chek-del');
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        const id = del.closest('.chek-item') && del.closest('.chek-item').getAttribute('data-id');
        if (id) this.remove(id);
        return;
      }
      const scan = e.target.closest('.chek-scan-btn');
      if (scan) {
        e.preventDefault();
        e.stopPropagation();
        const plate = scan.closest('.chek-card') && scan.closest('.chek-card').getAttribute('data-plate');
        if (plate) this.openScan(plate);
        return;
      }
      const head = e.target.closest('.chek-card-h');
      if (head) {
        const plate = head.closest('.chek-card') && head.closest('.chek-card').getAttribute('data-plate');
        this.openPlate = this.plateKey(this.openPlate) === this.plateKey(plate) ? '' : plate;
        this.render();
      }
    });
    const close = document.getElementById('chek-scan-close');
    if (close) close.onclick = () => this.closeScan();
    const paste = document.getElementById('chek-scan-paste');
    if (paste) paste.onclick = () => this.submitPaste();
    const file = document.getElementById('chek-scan-file');
    if (file) file.onchange = (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (f) this.scanFile(f);
      ev.target.value = '';
    };
  },

  loadLib() {
    if (window.Html5Qrcode) return Promise.resolve();
    if (this.libPromise) return this.libPromise;
    this.libPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html5-qrcode/2.3.8/html5-qrcode.min.js';
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('QR modul yuklanmadi'));
      document.head.appendChild(s);
    });
    return this.libPromise;
  },

  openScan(plate) {
    this.openPlate = plate;
    this.render();
    const modal = document.getElementById('chek-scan-modal');
    const title = document.getElementById('chek-scan-title');
    const q = document.getElementById('chek-qr-text');
    if (title) title.textContent = plate + ' — chek QR';
    if (q) q.value = '';
    if (modal) {
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
    }
    this.startCamera();
  },

  async startCamera() {
    const host = document.getElementById('chek-scan-cam');
    if (!host) return;
    host.innerHTML = '';
    try {
      await this.loadLib();
      await this.stopCamera();
      this.scanner = new window.Html5Qrcode('chek-scan-cam');
      await this.scanner.start(
        { facingMode: 'environment' },
        { fps: 8, qrbox: { width: 220, height: 220 } },
        (text) => { this.onQr(text); },
        () => {}
      );
      this.scanning = true;
    } catch (e) {
      host.innerHTML = '<div class="chek-empty">Kamera ochilmadi. Rasm yuklang yoki QR havolasini yozing.</div>';
    }
  },

  async stopCamera() {
    if (!this.scanner) return;
    try { await this.scanner.stop(); } catch (e) {}
    try { this.scanner.clear(); } catch (e) {}
    this.scanner = null;
    this.scanning = false;
  },

  async scanFile(file) {
    try {
      await this.loadLib();
      const tmp = new window.Html5Qrcode('chek-scan-file-sink');
      const text = await tmp.scanFile(file, true);
      try { tmp.clear(); } catch (e) {}
      await this.onQr(text);
    } catch (e) {
      this.toast(e.message || 'QR rasmda topilmadi');
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
    if (modal) {
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
    }
  },

  async onQr(text) {
    if (this._busy) return;
    this._busy = true;
    try {
      await this.stopCamera();
      const d = await vmApi('/api/office/cheks/scan', {
        method: 'POST',
        body: JSON.stringify({ plate: this.openPlate, qr: String(text || '').trim() }),
        timeoutMs: 28000
      });
      this.items = Array.isArray(d.items) ? d.items : this.items;
      this.toast(d.item && d.item.amount ? ('Chek saqlandi · ' + this.money(d.item.amount)) : 'Chek saqlandi');
      await this.closeScan();
      this.render();
    } catch (e) {
      this.toast(e.message || 'Chek saqlanmadi');
      this.startCamera();
    } finally {
      this._busy = false;
    }
  },

  async remove(id) {
    if (!confirm('Shu chek o‘chirilsinmi? (faqat shu bo‘lim, hisobotga tegmaydi)')) return;
    try {
      const d = await vmApi('/api/office/cheks/delete', {
        method: 'POST',
        body: JSON.stringify({ id })
      });
      this.items = Array.isArray(d.items) ? d.items : this.items;
      this.render();
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
});
