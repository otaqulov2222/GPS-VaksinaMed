'use strict';
/**
 * VaksinaMed Yordamchi — premium UI + sahifa tugmalari konteksti.
 */
(function () {
  if (window._vmSupportInit) return;
  window._vmSupportInit = true;

  const path = (location.pathname || '').replace(/\\/g, '/');
  if (path.endsWith('/login.html')) return;

  const STORE_KEY = 'vm_support_chat_v5';
  const MAX_UI_MSGS = 80;
  const MAX_API_HIST = 12;
  const WELCOME =
    "Salom! Men VaksinaMed yordamchisiman.\n\n" +
    "Tugma, bo‘lim yoki skrin haqida so‘rang. Pastdagi tezkor tugmalardan ham foydalanishingiz mumkin.";

  const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
  const ICON_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
  const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';

  let history = [];
  let uiMsgs = [];
  let pendingImage = null;
  let busy = false;

  const PAGE_CHIPS = {
    'fuel.html': [
      'Oylik hisobot nima?',
      'Kunlik kiritish',
      'Kun hisoboti',
      'Asl ma\'lumot',
      'GPS dan km',
      'Zaxira saqlash',
      'Zapravka reestri',
      'Hujjat muddatlari',
      'Haydovchilar jurnali',
      'Rasmiy hisobot'
    ],
    'index.html': [
      'GPS yuklash',
      'Ulanish',
      'Excel saqlash',
      'Sozlamalar',
      'Ruxsat nima?',
      'Xarita',
      'Ball nima?'
    ],
    'admin.html': [
      'Shofyor qo\'shish',
      'Dorixona biriktirish',
      'Geozona',
      'Telegram',
      'Blok',
      'Chiqarish',
      'Kunlik vazifa'
    ],
    'driver.html': [
      'LIVE nima?',
      'Xarita',
      'Yoqilg\'i',
      'Topshiriqlar',
      'Ball'
    ],
    'profile.html': [
      'Parolni almashtirish',
      'Admin panel',
      'Chiqish'
    ]
  };

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function pageName() {
    const p = path.split('/').pop() || '';
    return p || 'index.html';
  }

  function nowTime() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function collectUiLabels() {
    const out = [];
    const seen = {};
    const push = (s) => {
      const t = String(s || '').replace(/\s+/g, ' ').trim();
      if (!t || t.length < 2 || t.length > 48) return;
      const k = t.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1;
      out.push(t);
    };
    document.querySelectorAll('.tab, button.tab, [data-tab], .btn, a.nav-link, .nav-rail button, .nav-rail a').forEach((node) => {
      push(node.getAttribute('title'));
      push(node.getAttribute('aria-label'));
      const full = node.querySelector('.lbl-full');
      push(full ? full.textContent : node.textContent);
    });
    return out.slice(0, 60);
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        open: root.classList.contains('open'),
        history: history.slice(-40),
        uiMsgs: uiMsgs.slice(-MAX_UI_MSGS).map((m) => ({
          kind: m.kind,
          text: m.text,
          hasImg: !!m.hasImg,
          time: m.time || ''
        })),
        savedAt: Date.now()
      }));
    } catch (e) {
      try {
        uiMsgs = uiMsgs.slice(-24);
        history = history.slice(-16);
        localStorage.setItem(STORE_KEY, JSON.stringify({
          open: root.classList.contains('open'),
          history,
          uiMsgs: uiMsgs.map((m) => ({ kind: m.kind, text: m.text, hasImg: !!m.hasImg, time: m.time || '' }))
        }));
      } catch (e2) {}
    }
  }

  function clearStoreSoft() {
    history = [];
    uiMsgs = [];
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
  }

  function formatBotHtml(text) {
    let esc = String(text || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // bullet lines
    if (/^• /m.test(esc) || /^· /m.test(esc)) {
      const lines = esc.split('\n');
      let html = '';
      let inList = false;
      lines.forEach((line) => {
        if (/^[•·]\s/.test(line)) {
          if (!inList) { html += '<ul>'; inList = true; }
          html += '<li>' + line.replace(/^[•·]\s/, '') + '</li>';
        } else {
          if (inList) { html += '</ul>'; inList = false; }
          html += line + '<br>';
        }
      });
      if (inList) html += '</ul>';
      esc = html.replace(/(<br>)+$/g, '');
    } else {
      esc = esc
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/^(\d+)\)\s/gm, '<span class="vm-sup-num">$1)</span> ')
        .replace(/\n/g, '<br>');
    }
    return esc;
  }

  function renderBubble(msg, scroll) {
    const box = root.querySelector('.vm-sup-msgs');
    const row = document.createElement('div');
    row.className = 'vm-sup-row-msg ' + (msg.kind === 'me' ? 'me' : 'bot');
    if (msg.kind === 'bot') {
      const av = document.createElement('div');
      av.className = 'vm-sup-mini-av';
      av.textContent = 'VM';
      row.appendChild(av);
    }
    const col = document.createElement('div');
    const b = document.createElement('div');
    b.className = 'vm-sup-bubble ' + msg.kind;
    if (msg.kind === 'bot') b.innerHTML = formatBotHtml(msg.text);
    else b.textContent = msg.text || '';
    if (msg.imgUrl) {
      const im = document.createElement('img');
      im.className = 'vm-sup-thumb';
      im.src = msg.imgUrl;
      im.alt = 'Skrin';
      b.appendChild(im);
    } else if (msg.hasImg && msg.kind === 'me') {
      const note = document.createElement('div');
      note.className = 'vm-sup-img-note';
      note.textContent = 'Skrin biriktirilgan';
      b.appendChild(note);
    }
    col.appendChild(b);
    if (msg.time) {
      const meta = document.createElement('div');
      meta.className = 'vm-sup-meta';
      meta.textContent = msg.time;
      col.appendChild(meta);
    }
    row.appendChild(col);
    box.appendChild(row);
    if (scroll !== false) box.scrollTop = box.scrollHeight;
  }

  function addBubble(kind, text, imgUrl, persist) {
    const msg = {
      kind,
      text: text || '',
      imgUrl: imgUrl || null,
      hasImg: !!imgUrl,
      time: nowTime()
    };
    if (kind !== 'sys') uiMsgs.push(msg);
    renderBubble(msg, true);
    if (persist !== false && kind !== 'sys') saveStore();
  }

  function renderChips() {
    const wrap = root.querySelector('.vm-sup-chips');
    if (!wrap) return;
    const chips = PAGE_CHIPS[pageName()] || PAGE_CHIPS['index.html'];
    wrap.innerHTML = '';
    chips.forEach((label) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'vm-sup-chip';
      b.textContent = label;
      b.title = label;
      b.addEventListener('click', () => {
        const ta = root.querySelector('.vm-sup-input');
        ta.value = label;
        autoGrow(ta);
        send();
      });
      wrap.appendChild(b);
    });
  }

  function setPreview(dataUrl) {
    pendingImage = dataUrl || null;
    const prev = root.querySelector('.vm-sup-preview');
    const img = root.querySelector('.vm-sup-preview img');
    if (!prev || !img) return;
    if (pendingImage) {
      img.src = pendingImage;
      prev.classList.add('on');
      root.classList.add('open');
    } else {
      img.removeAttribute('src');
      prev.classList.remove('on');
    }
  }

  function compressDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => {
        const max = 1280;
        let w = im.width;
        let h = im.height;
        if (w > max || h > max) {
          const s = Math.min(max / w, max / h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d').drawImage(im, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      im.onerror = () => reject(new Error('Rasm ochilmadi'));
      im.src = dataUrl;
    });
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\/(png|jpe?g|webp)$/i.test(file.type)) {
        reject(new Error('Faqat PNG, JPEG yoki WebP.'));
        return;
      }
      if (file.size > 8 * 1024 * 1024) {
        reject(new Error('Rasm juda katta (max ~8 MB).'));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Rasm o‘qilmadi"));
      reader.onload = () => compressDataUrl(reader.result).then(resolve).catch(reject);
      reader.readAsDataURL(file);
    });
  }

  let _tessLoad = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve();
    if (_tessLoad) return _tessLoad;
    _tessLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('OCR yuklanmadi'));
      document.head.appendChild(s);
    });
    return _tessLoad;
  }

  async function readImageText(dataUrl) {
    try {
      await loadTesseract();
      const res = await window.Tesseract.recognize(dataUrl, 'eng', { logger: function () {} });
      return String((res && res.data && res.data.text) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 400);
    } catch (e) {
      return '';
    }
  }

  async function attachFromFile(file) {
    try {
      setPreview(await compressImage(file));
      root.querySelector('.vm-sup-input').focus();
    } catch (err) {
      addBubble('bot', err.message || 'Rasm xato');
    }
  }

  async function attachFromClipboard(e) {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.type && it.type.indexOf('image') === 0) {
        e.preventDefault();
        const file = it.getAsFile();
        if (file) await attachFromFile(file);
        return true;
      }
    }
    return false;
  }

  function autoGrow(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(120, Math.max(44, ta.scrollHeight)) + 'px';
  }

  async function send() {
    if (busy) return;
    const ta = root.querySelector('.vm-sup-input');
    const text = (ta.value || '').trim();
    const img = pendingImage;
    if (!text && !img) return;

    busy = true;
    root.querySelector('.vm-sup-send').disabled = true;
    root.querySelector('.vm-sup-iconbtn').disabled = true;

    addBubble('me', text || 'Skrin yuborildi', img);
    ta.value = '';
    autoGrow(ta);
    setPreview(null);

    const thinking = document.createElement('div');
    thinking.className = 'vm-sup-row-msg bot';
    thinking.innerHTML =
      '<div class="vm-sup-mini-av">VM</div><div><div class="vm-sup-bubble bot vm-sup-thinking">' +
      '<span class="vm-sup-dots"><i></i><i></i><i></i></span> <span class="vm-sup-think-txt">Javob tayyorlanmoqda…</span></div></div>';
    root.querySelector('.vm-sup-msgs').appendChild(thinking);
    root.querySelector('.vm-sup-msgs').scrollTop = root.querySelector('.vm-sup-msgs').scrollHeight;

    try {
      let imageText = '';
      if (img) {
        const tip = thinking.querySelector('.vm-sup-think-txt');
        if (tip) tip.textContent = 'Skrin o‘qilmoqda…';
        imageText = await readImageText(img);
        if (tip) tip.textContent = 'Javob tayyorlanmoqda…';
      }
      const body = {
        message: text,
        page: pageName(),
        history: history.slice(-MAX_API_HIST),
        ui_labels: collectUiLabels(),
        active_label: (function () {
          const on = document.querySelector('.tab.on, button.tab.on, [data-tab].on');
          if (!on) return '';
          const full = on.querySelector('.lbl-full');
          return String((full ? full.textContent : on.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        })()
      };
      if (img) body.image = img;
      if (imageText) body.image_text = imageText;
      const r = await fetch('/api/support/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      const d = await r.json().catch(() => ({}));
      thinking.remove();
      if (r.status === 401) {
        location.replace('/login.html');
        return;
      }
      if (!r.ok || !d.ok) {
        addBubble('bot', d.error || ('Xato ' + r.status));
      } else {
        addBubble('bot', d.reply || '—');
        if (text) history.push({ role: 'user', content: text });
        else if (img) history.push({ role: 'user', content: '[skrinshot]' });
        history.push({ role: 'assistant', content: String(d.reply || '').slice(0, 2000) });
        if (history.length > 40) history = history.slice(-40);
        saveStore();
      }
    } catch (e) {
      thinking.remove();
      addBubble('bot', "Ulanish xatosi. Qayta urinib ko‘ring.");
    } finally {
      busy = false;
      root.querySelector('.vm-sup-send').disabled = false;
      root.querySelector('.vm-sup-iconbtn').disabled = false;
      root.querySelector('.vm-sup-input').focus();
    }
  }

  function resetChat() {
    if (!confirm('Chat tarixini tozalaysizmi?')) return;
    clearStoreSoft();
    root.querySelector('.vm-sup-msgs').innerHTML = '';
    addBubble('bot', WELCOME);
    saveStore();
  }

  const root = el(`
    <div class="vm-sup-root" id="vm-support-root" aria-live="polite">
      <div class="vm-sup-panel" role="dialog" aria-label="Yordamchi">
        <div class="vm-sup-head">
          <div class="vm-sup-avatar">VM</div>
          <div class="vm-sup-head-txt">
            <h3>Yordamchi</h3>
            <div class="vm-sup-status"><i></i> Onlayn · ichki yordam</div>
          </div>
          <div class="vm-sup-head-actions">
            <button type="button" class="vm-sup-clear" title="Tozalash" aria-label="Tozalash">${ICON_TRASH}</button>
            <button type="button" class="vm-sup-x" title="Yopish" aria-label="Yopish">${ICON_CLOSE}</button>
          </div>
        </div>
        <div class="vm-sup-msgs"></div>
        <div class="vm-sup-chips"></div>
        <div class="vm-sup-foot">
          <div class="vm-sup-preview">
            <img alt="">
            <span>Skrin tayyor</span>
            <button type="button" class="vm-sup-clear-img">Olib tashlash</button>
          </div>
          <div class="vm-sup-row">
            <button type="button" class="vm-sup-iconbtn" title="Skrin" aria-label="Skrin">${ICON_IMG}</button>
            <textarea class="vm-sup-input" rows="1" placeholder="Savol yozing… yoki Ctrl+V"></textarea>
            <button type="button" class="vm-sup-send" title="Yuborish" aria-label="Yuborish">${ICON_SEND}</button>
          </div>
        </div>
      </div>
      <button type="button" class="vm-sup-fab" title="Yordamchi" aria-label="Yordamchi">
        ${ICON_CHAT}<span class="vm-sup-fab-dot"></span>
      </button>
      <input type="file" accept="image/png,image/jpeg,image/webp" hidden class="vm-sup-file">
    </div>
  `);

  document.body.appendChild(root);

  const saved = loadStore();
  if (saved && Array.isArray(saved.uiMsgs) && saved.uiMsgs.length) {
    history = Array.isArray(saved.history) ? saved.history : [];
    uiMsgs = [];
    saved.uiMsgs.forEach((m) => {
      if (!m || !m.kind || m.kind === 'sys') return;
      const msg = { kind: m.kind, text: m.text || '', hasImg: !!m.hasImg, imgUrl: null, time: m.time || '' };
      uiMsgs.push(msg);
      renderBubble(msg, false);
    });
    const box = root.querySelector('.vm-sup-msgs');
    box.scrollTop = box.scrollHeight;
    if (saved.open) root.classList.add('open');
  } else {
    addBubble('bot', WELCOME, null, false);
  }
  renderChips();

  // Status: offline FAQ / AI
  (function refreshStatus() {
    const st = root.querySelector('.vm-sup-status');
    if (!st) return;
    fetch('/api/support/status', { credentials: 'same-origin' })
      .then((r) => r.json())
      .then((d) => {
        if (!d || !d.ok) return;
        st.innerHTML = d.ai
          ? '<i></i> AI · skrin o‘qiydi'
          : '<i></i> Onlayn · ichki yordam';
      })
      .catch(() => {});
  })();

  root.querySelector('.vm-sup-fab').addEventListener('click', () => {
    root.classList.toggle('open');
    saveStore();
    if (root.classList.contains('open')) {
      renderChips();
      root.querySelector('.vm-sup-input').focus();
    }
  });
  root.querySelector('.vm-sup-x').addEventListener('click', () => {
    root.classList.remove('open');
    saveStore();
  });
  root.querySelector('.vm-sup-clear').addEventListener('click', resetChat);
  root.querySelector('.vm-sup-send').addEventListener('click', send);

  const ta = root.querySelector('.vm-sup-input');
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  ta.addEventListener('input', () => autoGrow(ta));
  ta.addEventListener('paste', (e) => { attachFromClipboard(e); });

  document.addEventListener('paste', (e) => {
    if (!root.classList.contains('open')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t !== ta) return;
    attachFromClipboard(e);
  });

  root.querySelector('.vm-sup-iconbtn').addEventListener('click', () => root.querySelector('.vm-sup-file').click());
  root.querySelector('.vm-sup-clear-img').addEventListener('click', () => setPreview(null));
  root.querySelector('.vm-sup-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) await attachFromFile(f);
  });

  const panel = root.querySelector('.vm-sup-panel');
  ['dragenter', 'dragover'].forEach((ev) => {
    panel.addEventListener(ev, (e) => { e.preventDefault(); panel.classList.add('vm-sup-drag'); });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    panel.addEventListener(ev, (e) => { e.preventDefault(); panel.classList.remove('vm-sup-drag'); });
  });
  panel.addEventListener('drop', async (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await attachFromFile(f);
  });
})();
