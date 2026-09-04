'use strict';
/**
 * VaksinaMed ichki yordamchi — matn + skrin (fayl / Ctrl+V / drag-drop).
 * Suhbat localStorage da saqlanadi (sahifa almashtirsangiz ham qoladi).
 */
(function () {
  if (window._vmSupportInit) return;
  window._vmSupportInit = true;

  const path = (location.pathname || '').replace(/\\/g, '/');
  if (path.endsWith('/login.html')) return;

  const STORE_KEY = 'vm_support_chat_v4';
  const MAX_UI_MSGS = 80;
  const MAX_API_HIST = 12;
  const WELCOME = "Salom! Men VaksinaMed ichki yordamchisiman.";

  const ICON_CHAT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>';
  const ICON_IMG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';

  let history = [];
  let uiMsgs = [];
  let pendingImage = null;
  let busy = false;
  let aiOn = false;

  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function pageName() {
    const p = path.split('/').pop() || '';
    return p || 'index.html';
  }

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function saveStore() {
    try {
      const payload = {
        open: root.classList.contains('open'),
        history: history.slice(-40),
        // Rasm base64 ni saqlamaymiz (quota) — matn qoladi
        uiMsgs: uiMsgs.slice(-MAX_UI_MSGS).map((m) => ({
          kind: m.kind,
          text: m.text,
          hasImg: !!m.hasImg,
        })),
        aiOn: aiOn,
        savedAt: Date.now(),
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch (e) {
      // quota — eng eski xabarlarni qisqartiramiz
      try {
        uiMsgs = uiMsgs.slice(-30);
        history = history.slice(-20);
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({
            open: root.classList.contains('open'),
            history: history,
            uiMsgs: uiMsgs.map((m) => ({ kind: m.kind, text: m.text, hasImg: !!m.hasImg })),
            aiOn: aiOn,
          })
        );
      } catch (e2) {}
    }
  }

  function clearStoreSoft() {
    history = [];
    uiMsgs = [];
    try {
      localStorage.removeItem(STORE_KEY);
    } catch (e) {}
  }

  function formatBotHtml(text) {
    const esc = String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return esc
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^(\d+)\)\s/gm, '<span class="vm-sup-num">$1)</span> ')
      .replace(/\n/g, '<br>');
  }

  function renderBubble(msg, scroll) {
    const box = root.querySelector('.vm-sup-msgs');
    const b = document.createElement('div');
    b.className = 'vm-sup-bubble ' + msg.kind;
    if (msg.kind === 'bot') {
      b.innerHTML = formatBotHtml(msg.text);
    } else {
      b.textContent = msg.text || '';
    }
    if (msg.imgUrl) {
      const im = document.createElement('img');
      im.className = 'vm-sup-thumb';
      im.src = msg.imgUrl;
      im.alt = 'Skrin';
      b.appendChild(im);
    } else if (msg.hasImg && msg.kind === 'me') {
      const note = document.createElement('div');
      note.className = 'vm-sup-img-note';
      note.textContent = '📎 Skrin (sessiyada saqlangan)';
      b.appendChild(note);
    }
    box.appendChild(b);
    if (scroll !== false) box.scrollTop = box.scrollHeight;
  }

  function addBubble(kind, text, imgUrl, persist) {
    const msg = {
      kind: kind,
      text: text || '',
      imgUrl: imgUrl || null,
      hasImg: !!imgUrl,
    };
    if (kind !== 'sys') uiMsgs.push(msg);
    renderBubble(msg, true);
    if (persist !== false && kind !== 'sys') saveStore();
  }

  function setBadge() {
    const badge = root.querySelector('.vm-sup-badge');
    if (!badge) return;
    if (aiOn) {
      badge.textContent = 'AI';
      badge.classList.remove('off');
    } else {
      badge.textContent = 'FAQ';
      badge.classList.add('off');
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch('/api/support/status', { credentials: 'same-origin' });
      const d = await r.json();
      aiOn = !!(d && d.ai);
    } catch (e) {
      aiOn = false;
    }
    setBadge();
    saveStore();
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

  function compressDataUrl(dataUrl, mimeHint) {
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
        const ctx = c.getContext('2d');
        ctx.drawImage(im, 0, 0, w, h);
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
      reader.onload = () => {
        compressDataUrl(reader.result, file.type).then(resolve).catch(reject);
      };
      reader.readAsDataURL(file);
    });
  }

  async function attachFromFile(file) {
    try {
      const dataUrl = await compressImage(file);
      setPreview(dataUrl);
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
    ta.style.height = Math.min(120, Math.max(42, ta.scrollHeight)) + 'px';
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

    addBubble('me', text || (img ? 'Skrin yuborildi' : ''), img);
    ta.value = '';
    autoGrow(ta);
    setPreview(null);

    const thinking = document.createElement('div');
    thinking.className = 'vm-sup-bubble bot vm-sup-thinking';
    thinking.innerHTML = '<span class="vm-sup-dots"><i></i><i></i><i></i></span> Javob tayyorlanmoqda…';
    root.querySelector('.vm-sup-msgs').appendChild(thinking);
    root.querySelector('.vm-sup-msgs').scrollTop = root.querySelector('.vm-sup-msgs').scrollHeight;

    try {
      const body = {
        message: text,
        page: pageName(),
        history: history.slice(-MAX_API_HIST),
      };
      if (img) body.image = img;
      const r = await fetch('/api/support/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
        if (d.mode === 'ai') {
          aiOn = true;
          setBadge();
        }
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
    if (!confirm("Chat tarixini tozalaysizmi?")) return;
    clearStoreSoft();
    const box = root.querySelector('.vm-sup-msgs');
    box.innerHTML = '';
    addBubble('bot', WELCOME);
    saveStore();
  }

  const root = el(`
    <div class="vm-sup-root" id="vm-support-root" aria-live="polite">
      <div class="vm-sup-panel" role="dialog" aria-label="Yordamchi">
        <div class="vm-sup-head">
          <div class="vm-sup-head-txt">
            <h3>Yordamchi</h3>
          </div>
          <span class="vm-sup-badge off" hidden>…</span>
          <button type="button" class="vm-sup-clear" title="Chatni tozalash" aria-label="Tozalash">🗑</button>
          <button type="button" class="vm-sup-x" title="Yopish" aria-label="Yopish">×</button>
        </div>
        <div class="vm-sup-msgs"></div>
        <div class="vm-sup-foot">
          <div class="vm-sup-preview">
            <img alt="">
            <span>Skrin</span>
            <button type="button" class="vm-sup-clear-img">Olib tashlash</button>
          </div>
          <div class="vm-sup-row">
            <button type="button" class="vm-sup-iconbtn" title="Fayldan skrin" aria-label="Skrin">${ICON_IMG}</button>
            <textarea class="vm-sup-input" rows="1" placeholder="Savol yozing…"></textarea>
            <button type="button" class="vm-sup-send" title="Yuborish" aria-label="Yuborish">${ICON_SEND}</button>
          </div>
        </div>
      </div>
      <button type="button" class="vm-sup-fab" title="Yordamchi" aria-label="Yordamchi ochish">${ICON_CHAT}</button>
      <input type="file" accept="image/png,image/jpeg,image/webp" hidden class="vm-sup-file">
    </div>
  `);

  document.body.appendChild(root);

  // Restore
  const saved = loadStore();
  if (saved && Array.isArray(saved.uiMsgs) && saved.uiMsgs.length) {
    history = Array.isArray(saved.history) ? saved.history : [];
    aiOn = !!saved.aiOn;
    uiMsgs = [];
    saved.uiMsgs.forEach((m) => {
      if (!m || !m.kind || m.kind === 'sys') return;
      const msg = { kind: m.kind, text: m.text || '', hasImg: !!m.hasImg, imgUrl: null };
      uiMsgs.push(msg);
      renderBubble(msg, false);
    });
    const box = root.querySelector('.vm-sup-msgs');
    box.scrollTop = box.scrollHeight;
    if (saved.open) root.classList.add('open');
  } else {
    addBubble('bot', WELCOME, null, false);
  }
  setBadge();

  root.querySelector('.vm-sup-fab').addEventListener('click', () => {
    root.classList.toggle('open');
    saveStore();
    if (root.classList.contains('open')) {
      root.querySelector('.vm-sup-input').focus();
      loadStatus();
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
  ta.addEventListener('paste', (e) => {
    attachFromClipboard(e);
  });

  // Panel ochiq bo‘lsa butun hujjatda Ctrl+V skrin
  document.addEventListener('paste', (e) => {
    if (!root.classList.contains('open')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t !== ta) return;
    attachFromClipboard(e);
  });

  root.querySelector('.vm-sup-iconbtn').addEventListener('click', () => {
    root.querySelector('.vm-sup-file').click();
  });
  root.querySelector('.vm-sup-clear-img').addEventListener('click', () => setPreview(null));
  root.querySelector('.vm-sup-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) await attachFromFile(f);
  });

  // Drag & drop
  const panel = root.querySelector('.vm-sup-panel');
  ['dragenter', 'dragover'].forEach((ev) => {
    panel.addEventListener(ev, (e) => {
      e.preventDefault();
      panel.classList.add('vm-sup-drag');
    });
  });
  ['dragleave', 'drop'].forEach((ev) => {
    panel.addEventListener(ev, (e) => {
      e.preventDefault();
      panel.classList.remove('vm-sup-drag');
    });
  });
  panel.addEventListener('drop', async (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) await attachFromFile(f);
  });

  loadStatus();
})();
