'use strict';
/**
 * VaksinaMed Davomat — Face modal → Keldim/Ketdim + timer + tarix
 */
(function () {
  const app = document.getElementById('att-app');
  if (!app) return;

  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/model';
  const FACE_API_SRC = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.14/dist/face-api.js';

  const MESH_EDGES = [
    [0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7],[7,8],[8,9],[9,10],[10,11],[11,12],[12,13],[13,14],[14,15],[15,16],
    [17,18],[18,19],[19,20],[20,21],[22,23],[23,24],[24,25],[25,26],
    [27,28],[28,29],[29,30],[30,33],[31,32],[32,33],[33,34],[34,35],
    [36,37],[37,38],[38,39],[39,40],[40,41],[41,36],
    [42,43],[43,44],[44,45],[45,46],[46,47],[47,42],
    [48,49],[49,50],[50,51],[51,52],[52,53],[53,54],[54,55],[55,56],[56,57],[57,58],[58,59],[59,48],
    [60,61],[61,62],[62,63],[63,64],[64,65],[65,66],[66,67],[67,60],
    [21,22],[27,21],[27,22],[31,48],[35,54],[0,17],[16,26],[8,57]
  ];

  let STATE = null;
  let busy = false;
  let stream = null;
  let modelsReady = false;
  let modelsLoading = null;
  let scanLoop = null;
  let modalOpen = false;
  let abortScan = null;
  let pendingScan = null; // { descriptor, photo, gps }
  let timerId = null;
  let uiTab = 'bugun';

  const modal = document.getElementById('fid-modal');
  const video = document.getElementById('att-cam');
  const overlay = document.getElementById('att-overlay');
  const snapCanvas = document.getElementById('att-canvas');
  const fidActions = document.getElementById('fid-actions');
  const btnKeldim = document.getElementById('fid-keldim');
  const btnKetdim = document.getElementById('fid-ketdim');
  const fidRetryWrap = document.getElementById('fid-retry-wrap');
  const btnRetry = document.getElementById('fid-retry');
  const btnCancel = document.getElementById('fid-cancel');
  let pendingKind = null; // 'in' | 'out' | null
  let flowRetry = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function msg(text, kind) {
    const el = document.getElementById('att-msg');
    if (!el) return;
    el.className = 'att-msg on ' + (kind || 'info');
    el.textContent = text;
  }

  function clearMsg() {
    const el = document.getElementById('att-msg');
    if (el) el.className = 'att-msg';
  }

  function setFidUI({ status, hint, progress, tone }) {
    const st = document.getElementById('fid-status');
    const hi = document.getElementById('fid-hint');
    const seg = document.getElementById('fid-seg');
    if (st) {
      st.textContent = status || '';
      st.className = 'fid-status' + (tone ? ' ' + tone : '');
    }
    if (hi && hint != null) hi.textContent = hint;
    if (seg && progress != null) {
      const pct = Math.max(0, Math.min(100, progress));
      const n = 16;
      const on = Math.round((pct / 100) * n);
      let html = '';
      for (let i = 0; i < n; i++) html += `<i class="${i < on ? 'on' : ''}"></i>`;
      seg.innerHTML = html;
    }
  }

  function hideFidActions() {
    if (fidActions) fidActions.hidden = true;
  }

  function hideRetry() {
    if (fidRetryWrap) fidRetryWrap.hidden = true;
  }

  function showRetry(errText) {
    hideFidActions();
    if (fidRetryWrap) fidRetryWrap.hidden = false;
    if (errText) {
      setFidUI({ status: 'FAILED', hint: errText, progress: 0, tone: 'err' });
    }
  }

  function showFidActions() {
    if (!fidActions || !STATE) return;
    hideRetry();
    const today = STATE.today || {};
    const canIn = !today.in;
    const canOut = !!(today.in && !today.out);
    // Agar foydalanuvchi aniq Keldim/Ketdim tanlagan bo'lsa — faqat shu
    if (pendingKind === 'in') {
      if (btnKeldim) { btnKeldim.disabled = !canIn; btnKeldim.classList.toggle('ghost', !canIn); }
      if (btnKetdim) { btnKetdim.disabled = true; btnKetdim.classList.add('ghost'); }
    } else if (pendingKind === 'out') {
      if (btnKeldim) { btnKeldim.disabled = true; btnKeldim.classList.add('ghost'); }
      if (btnKetdim) { btnKetdim.disabled = !canOut; btnKetdim.classList.toggle('ghost', !canOut); }
    } else {
      if (btnKeldim) {
        btnKeldim.disabled = !canIn;
        btnKeldim.classList.toggle('ghost', !canIn);
      }
      if (btnKetdim) {
        btnKetdim.disabled = !canOut;
        btnKetdim.classList.toggle('ghost', !canOut);
      }
    }
    fidActions.hidden = false;
  }

  function bindTap(el, fn) {
    if (!el || el._vmTapBound) return;
    el._vmTapBound = true;
    let lock = false;
    const run = (ev) => {
      if (lock) return;
      lock = true;
      if (ev && ev.preventDefault) ev.preventDefault();
      Promise.resolve()
        .then(() => fn(ev))
        .catch(() => {})
        .finally(() => { setTimeout(() => { lock = false; }, 450); });
    };
    el.addEventListener('click', run, { passive: false });
  }

  async function api(path, opts) {
    return vmApi(path, opts);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.faceapi) { resolve(); return; }
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Face model skripti yuklanmadi (internet kerak)'));
      document.head.appendChild(s);
    });
  }

  async function ensureModels() {
    if (modelsReady) return;
    if (modelsLoading) return modelsLoading;
    modelsLoading = (async () => {
      setFidUI({ status: 'LOADING…', hint: 'Yuz tahlil modeli yuklanmoqda', progress: 8, tone: 'load' });
      await loadScript(FACE_API_SRC);
      if (!window.faceapi) throw new Error('face-api yuklanmadi');
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
      ]);
      modelsReady = true;
    })();
    try { await modelsLoading; }
    finally { modelsLoading = null; }
  }

  function getGpsOnce(opts) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Joylashuv qo‘llab-quvvatlanmaydi'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy
        }),
        (err) => reject(err),
        opts
      );
    });
  }

  async function getGps() {
    // Telefonda highAccuracy ba'zan timeout/deny beradi — soft fallback
    try {
      return await getGpsOnce({
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 15000
      });
    } catch (e1) {
      try {
        return await getGpsOnce({
          enableHighAccuracy: false,
          timeout: 20000,
          maximumAge: 60000
        });
      } catch (e2) {
        const code = (e2 && e2.code) || (e1 && e1.code);
        if (code === 1) {
          throw new Error('Joylashuv ruxsati berilmadi. Telefon Sozlamalarida brauzer uchun Joylashuvni yoqing, keyin Qayta urinish.');
        }
        if (code === 3) {
          throw new Error('Joylashuv vaqti tugadi. GPS yoqilganini tekshiring va Qayta urinish bosing.');
        }
        throw new Error((e2 && e2.message) || (e1 && e1.message) || 'Joylashuv olinmadi');
      }
    }
  }

  function openModal(title, sub) {
    if (!modal) return;
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.add('open');
    document.body.classList.add('fid-lock');
    modalOpen = true;
    pendingScan = null;
    hideFidActions();
    hideRetry();
    const t = document.getElementById('fid-title');
    const s = document.getElementById('fid-sub');
    if (t) t.textContent = title || 'FACE ID';
    if (s) s.textContent = sub || '';
    setFidUI({ status: 'LOADING…', hint: 'Ruxsatlar va kamera…', progress: 0, tone: 'load' });
    modal.classList.remove('ok', 'err', 'warn', 'scanning');
  }

  function closeModal() {
    if (abortScan) {
      try { abortScan(); } catch (e) {}
      abortScan = null;
    }
    stopCam();
    pendingScan = null;
    pendingKind = null;
    flowRetry = null;
    hideFidActions();
    hideRetry();
    if (!modal) return;
    modal.classList.remove('open', 'ok', 'err', 'warn', 'scanning');
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('fid-lock');
    modalOpen = false;
  }

  async function startCam() {
    stopCam(false);
    if (!video) throw new Error('Kamera UI topilmadi');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Kamera qo‘llab-quvvatlanmaydi (HTTPS kerak)');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } },
      audio: false
    });
    video.srcObject = stream;
    video.hidden = false;
    await video.play().catch(() => {});
    await waitVideoReady(video);
    const vp = document.getElementById('fid-viewport');
    if (vp) vp.classList.add('live');
  }

  function waitVideoReady(v) {
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (v.videoWidth > 0) { resolve(); return; }
        if (Date.now() - t0 > 8000) { reject(new Error('Kamera ochilmadi')); return; }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  function stopScanLoop() {
    if (scanLoop) { cancelAnimationFrame(scanLoop); scanLoop = null; }
  }

  function stopCam(clearOverlay) {
    stopScanLoop();
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) video.srcObject = null;
    const vp = document.getElementById('fid-viewport');
    if (vp) vp.classList.remove('live', 'locked');
    if (clearOverlay !== false && overlay) {
      const ctx = overlay.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
    }
  }

  function snapPhoto() {
    if (!video || !snapCanvas || !video.videoWidth) throw new Error('Kamera tayyor emas');
    const w = video.videoWidth;
    const h = video.videoHeight;
    const max = 640;
    const s = Math.min(1, max / Math.max(w, h));
    snapCanvas.width = Math.round(w * s);
    snapCanvas.height = Math.round(h * s);
    snapCanvas.getContext('2d').drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
    return snapCanvas.toDataURL('image/jpeg', 0.82);
  }

  function drawHud(detection, locked, progress) {
    if (!overlay || !video) return;
    const vp = document.getElementById('fid-viewport');
    const w = (vp && vp.clientWidth) || 320;
    const h = (vp && vp.clientHeight) || 400;
    if (overlay.width !== w || overlay.height !== h) {
      overlay.width = w;
      overlay.height = h;
    }
    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const sx = w / video.videoWidth;
    const sy = h / video.videoHeight;
    const glow = locked ? '#3dffb5' : '#3ecbff';

    ctx.save();
    ctx.strokeStyle = 'rgba(62,203,255,0.28)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.ellipse(w * 0.5, h * 0.42, w * 0.26, h * 0.3, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    if (!detection || !detection.landmarks) return;
    const mapped = detection.landmarks.positions.map((p) => ({ x: p.x * sx, y: p.y * sy }));

    ctx.save();
    ctx.strokeStyle = locked ? 'rgba(61,255,181,0.55)' : 'rgba(62,203,255,0.5)';
    ctx.lineWidth = 1;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 6;
    MESH_EDGES.forEach(([a, b]) => {
      if (!mapped[a] || !mapped[b]) return;
      ctx.beginPath();
      ctx.moveTo(mapped[a].x, mapped[a].y);
      ctx.lineTo(mapped[b].x, mapped[b].y);
      ctx.stroke();
    });
    ctx.restore();

    ctx.save();
    ctx.fillStyle = glow;
    ctx.shadowColor = glow;
    ctx.shadowBlur = 10;
    mapped.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, (i % 5 === 0) ? 2.4 : 1.5, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();

    if (detection.detection) {
      const box = detection.detection.box;
      const x = box.x * sx, y = box.y * sy, bw = box.width * sx, bh = box.height * sy;
      const L = Math.min(bw, bh) * 0.18;
      ctx.strokeStyle = glow;
      ctx.lineWidth = 2.2;
      ctx.shadowColor = glow;
      ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.moveTo(x, y + L); ctx.lineTo(x, y); ctx.lineTo(x + L, y); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + bw - L, y); ctx.lineTo(x + bw, y); ctx.lineTo(x + bw, y + L); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y + bh - L); ctx.lineTo(x, y + bh); ctx.lineTo(x + L, y + bh); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + bw - L, y + bh); ctx.lineTo(x + bw, y + bh); ctx.lineTo(x + bw, y + bh - L); ctx.stroke();
    }

    if (progress != null) {
      const cx = w / 2, cy = h * 0.42, r = Math.min(w, h) * 0.38;
      ctx.beginPath();
      ctx.strokeStyle = 'rgba(62,203,255,0.15)';
      ctx.lineWidth = 3;
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = glow;
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * progress) / 100);
      ctx.stroke();
    }
  }

  async function detectOnce(v) {
    const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.45 });
    return faceapi.detectSingleFace(v, opts).withFaceLandmarks().withFaceDescriptor();
  }

  function avgDescriptors(list) {
    if (!list.length) return null;
    const n = list[0].length;
    const out = new Array(n).fill(0);
    list.forEach((d) => { for (let i = 0; i < n; i++) out[i] += d[i]; });
    for (let i = 0; i < n; i++) out[i] /= list.length;
    return out;
  }

  function scanFace({ needSamples, label, timeoutMs }) {
    const samples = [];
    const need = needSamples || 4;
    const deadline = Date.now() + (timeoutMs || 22000);
    let lastOk = 0;
    let cancelled = false;
    abortScan = () => { cancelled = true; };

    return new Promise((resolve, reject) => {
      if (!video) { reject(new Error('Kamera yo‘q')); return; }
      setFidUI({ status: 'SCANNING…', hint: label || 'Yuzni markazga qo‘ying', progress: 0, tone: 'scan' });
      if (modal) modal.classList.add('scanning');

      const tick = async () => {
        try {
          if (cancelled) { stopScanLoop(); reject(new Error('Bekor qilindi')); return; }
          if (Date.now() > deadline) {
            stopScanLoop();
            reject(new Error('Yuz topilmadi. Yorug‘likni yaxshilang va qayta bosing'));
            return;
          }
          const det = await detectOnce(video);
          const ok = !!(det && det.descriptor && det.detection && det.detection.score >= 0.5);
          const pct = (samples.length / need) * 100;
          drawHud(det, ok && samples.length >= need - 1, pct);

          if (ok) {
            const now = Date.now();
            if (now - lastOk > 160) {
              samples.push(Array.from(det.descriptor));
              lastOk = now;
              setFidUI({
                status: 'ANALYZING…',
                hint: `Biometrik nuqtalar · ${samples.length}/${need}`,
                progress: (samples.length / need) * 100,
                tone: 'scan'
              });
            }
          } else {
            setFidUI({
              status: 'SEARCHING…',
              hint: 'Yuzni ramka ichiga qo‘ying',
              progress: (samples.length / need) * 100,
              tone: 'warn'
            });
            if (modal) { modal.classList.add('warn'); modal.classList.remove('ok'); }
          }

          if (samples.length >= need) {
            stopScanLoop();
            const descriptor = avgDescriptors(samples);
            const photo = snapPhoto();
            drawHud(det, true, 100);
            if (modal) {
              modal.classList.remove('warn', 'scanning');
              modal.classList.add('ok');
            }
            const vp = document.getElementById('fid-viewport');
            if (vp) vp.classList.add('locked');
            setFidUI({ status: 'VERIFIED', hint: 'Yuz tasdiqlandi — Keldim yoki Ketdim ni tanlang', progress: 100, tone: 'ok' });
            abortScan = null;
            resolve({ descriptor, photo, samples: samples.length });
            return;
          }

          scanLoop = requestAnimationFrame(() => { setTimeout(tick, 35); });
        } catch (e) {
          stopScanLoop();
          abortScan = null;
          reject(e);
        }
      };
      tick();
    });
  }

  function parseTs(iso) {
    if (!iso) return NaN;
    let s = String(iso).trim();
    if (/^\d{4}-\d{2}-\d{2} /.test(s)) s = s.replace(' ', 'T');
    let t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (m) {
      return new Date(
        Number(m[1]), Number(m[2]) - 1, Number(m[3]),
        Number(m[4]), Number(m[5]), Number(m[6] || 0)
      ).getTime();
    }
    return NaN;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      const ms = parseTs(iso);
      if (Number.isNaN(ms)) return '—';
      const d = new Date(ms);
      return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    } catch (e) { return '—'; }
  }

  function fmtDate(d) {
    if (!d) return '—';
    const p = String(d).split('-');
    if (p.length !== 3) return esc(d);
    return p[2] + '.' + p[1] + '.' + p[0];
  }

  function fmtDur(sec) {
    if (sec == null || sec < 0) return '—';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function stopTimer() {
    if (timerId) { clearInterval(timerId); timerId = null; }
  }

  function startLiveTimer() {
    stopTimer();
    const today = (STATE && STATE.today) || {};
    if (!today.in || !today.in.at || today.out) return;
    const t0 = parseTs(today.in.at);
    if (Number.isNaN(t0)) return;
    const tick = () => {
      const el = document.getElementById('att-live-timer');
      if (!el) return;
      const sec = Math.max(0, Math.floor((Date.now() - t0) / 1000));
      el.textContent = fmtDur(sec);
    };
    tick();
    timerId = setInterval(tick, 1000);
  }

  function dayWorkedSec(rec) {
    if (!rec || !rec.in || !rec.in.at) return null;
    const t0 = parseTs(rec.in.at);
    if (Number.isNaN(t0)) return null;
    if (rec.out && rec.out.at) {
      const t1 = parseTs(rec.out.at);
      if (Number.isNaN(t1)) return null;
      return Math.max(0, Math.floor((t1 - t0) / 1000));
    }
    return Math.max(0, Math.floor((Date.now() - t0) / 1000));
  }

  function render() {
    if (!STATE) return;
    stopTimer();
    const s = STATE.settings || {};
    const face = STATE.face || {};
    const today = STATE.today || {};
    const inn = today.in;
    const out = today.out;
    const enrolled = !!STATE.enrolled;
    const staff = window.VM_USER && (VM_USER.role === 'admin' || VM_USER.role === 'admin_pro');
    const history = STATE.history || [];
    const working = !!(inn && !out);
    const done = !!(inn && out);

    app.innerHTML = `
      <section class="att-hero">
        <div>
          <h1>Davomat</h1>
          <p>Face ID → <b>Keldim</b> / <b>Ketdim</b>. Ish vaqti avtomatik hisoblanadi. GPS + yuz himoyasi.</p>
          <div class="att-chips">
            <span class="att-chip">${esc(s.today || '')}</span>
            <span class="att-chip">Keldim ${esc(s.in_start)} dan</span>
            <span class="att-chip">Ketdim ${esc(s.out_end)} gacha</span>
            <span class="att-chip">${esc((s.office && s.office.label) || 'Ofis')} · ${esc(String((s.office && s.office.radius_m) || '250'))} m</span>
            <span class="att-chip ${enrolled ? 'ok' : 'bad'}">${enrolled ? 'Face ulangan' : 'Face ulanmagan'}</span>
          </div>
        </div>
      </section>

      <div class="att-tabs" role="tablist">
        <button type="button" class="att-tab ${uiTab === 'bugun' ? 'on' : ''}" data-tab="bugun">Bugun</button>
        <button type="button" class="att-tab ${uiTab === 'tarix' ? 'on' : ''}" data-tab="tarix">Tarix</button>
        ${staff ? `<button type="button" class="att-tab ${uiTab === 'jamoa' ? 'on' : ''}" data-tab="jamoa">Jamoa</button>` : ''}
        ${staff ? `<button type="button" class="att-tab ${uiTab === 'soz' ? 'on' : ''}" data-tab="soz">Sozlamalar</button>` : ''}
      </div>

      <div class="att-panel" id="panel-bugun" ${uiTab === 'bugun' ? '' : 'hidden'}>
        <section class="att-card">
          <div class="att-card-h">Bugungi ish kuni</div>
          <div class="att-card-b">
            <div class="att-status-row">
              <div class="att-stat ${inn ? (inn.late ? 'late' : 'ok') : 'empty'}">
                <div class="lbl">Keldim</div>
                <div class="val">${inn ? fmtTime(inn.at) + (inn.late ? ' · kechikdi' : '') : '—'}</div>
              </div>
              <div class="att-stat ${out ? 'ok' : 'empty'}">
                <div class="lbl">Ketdim</div>
                <div class="val">${out ? fmtTime(out.at) : '—'}</div>
              </div>
            </div>

            <div class="att-timer-box ${working ? 'live' : (done ? 'done' : '')}">
              <div class="att-timer-lbl">${working ? 'Ishlayapti' : (done ? 'Bugun yakunlandi' : 'Vaqt hisobi')}</div>
              <div class="att-timer-val" id="att-live-timer">${fmtDur(dayWorkedSec(today) || 0)}</div>
            </div>

            ${!enrolled ? `
              <p class="att-hint">Avval Face ID ulang — keyin har kuni Keldim / Ketdim.</p>
              <div class="att-actions att-actions-main">
                <button type="button" class="att-btn att-btn-face-cta" id="btn-enroll">Face ID ulash</button>
              </div>
            ` : `
              <div class="att-actions att-actions-main att-actions-stack">
                ${done
                  ? `<button type="button" class="att-btn att-btn-done" disabled>Bugun yakunlandi</button>`
                  : `
                    <button type="button" class="att-btn att-btn-in" id="btn-keldim-main" ${inn ? 'disabled' : ''}>Keldim</button>
                    <button type="button" class="att-btn att-btn-out" id="btn-ketdim-main" ${(!inn || out) ? 'disabled' : ''}>Ketdim</button>
                  `
                }
                <button type="button" class="att-btn att-btn-face" id="btn-reenroll">Yuzni qayta ulash</button>
              </div>
              <p class="att-hint">Keldim/Ketdim → Face ID → tasdiq. Joylashuv ruxsatini bering — aks holda stamp yozilmaydi.</p>
            `}
            <div class="att-msg" id="att-msg"></div>
          </div>
        </section>

        ${face.photo ? `
        <section class="att-card" style="margin-top:14px">
          <div class="att-card-h">Face ID</div>
          <div class="att-card-b">
            <div class="att-enrolled-block" style="margin:0">
              <img class="att-enrolled-thumb" src="${face.photo}" alt="Face">
              <div>
                <div class="att-enrolled-title">Tasdiqlangan yuz</div>
                <div class="att-hint" style="margin:4px 0 0">${esc((STATE.user && STATE.user.name) || '')} · ${esc(face.enrolledAt ? fmtTime(face.enrolledAt) : '')}</div>
              </div>
            </div>
          </div>
        </section>` : ''}
      </div>

      <div class="att-panel" id="panel-tarix" ${uiTab === 'tarix' ? '' : 'hidden'}>
        <section class="att-card">
          <div class="att-card-h">Mening davomatim</div>
          <div class="att-card-b">
            ${history.length ? `
              <div class="scroll-x">
              <table class="att-table">
                <thead><tr><th>Sana</th><th>Keldim</th><th>Ketdim</th><th>Ish vaqti</th><th>Holat</th></tr></thead>
                <tbody>
                  ${history.map((r) => `
                    <tr>
                      <td>${fmtDate(r.date)}</td>
                      <td>${r.in ? fmtTime(r.in.at) + (r.late ? ' !' : '') : '—'}</td>
                      <td>${r.out ? fmtTime(r.out.at) : '—'}</td>
                      <td class="mono">${r.worked_sec != null ? fmtDur(r.worked_sec) : (r.in && !r.out ? '…' : '—')}</td>
                      <td><span class="att-badge ${esc(r.status)}">${esc(statusLabel(r.status))}</span></td>
                    </tr>`).join('')}
                </tbody>
              </table></div>
            ` : `<p class="att-hint">Hali yozuv yo‘q. Birinchi marta Keldim bosing.</p>`}
          </div>
        </section>
      </div>

      ${staff ? `
      <div class="att-panel" id="panel-jamoa" ${uiTab === 'jamoa' ? '' : 'hidden'}>
        <section class="att-card">
          <div class="att-card-h">
            <span>Bugungi jamoa</span>
            <button type="button" class="att-btn att-btn-face" id="btn-board" style="padding:8px 12px;min-width:0;font-size:12px">Yangilash</button>
          </div>
          <div class="att-card-b" id="att-board"><p class="att-hint">Yuklanmoqda…</p></div>
        </section>
      </div>
      <div class="att-panel" id="panel-soz" ${uiTab === 'soz' ? '' : 'hidden'}>
        <section class="att-card">
          <div class="att-card-h">Sozlamalar</div>
          <div class="att-card-b att-settings" id="att-settings"></div>
        </section>
      </div>
      ` : ''}
    `;

    bindActions(staff);
    if (staff && uiTab === 'jamoa') loadBoard();
    if (staff && uiTab === 'soz') renderSettings();
    if (working) startLiveTimer();
  }

  function statusLabel(s) {
    return ({ in: 'Ishda', late: 'Kechikdi', done: 'To‘liq', absent: 'Yo‘q' })[s] || s;
  }

  function bindActions(staff) {
    app.querySelectorAll('.att-tab').forEach((btn) => {
      bindTap(btn, () => {
        uiTab = btn.getAttribute('data-tab') || 'bugun';
        render();
      });
    });

    const enroll = document.getElementById('btn-enroll');
    const re = document.getElementById('btn-reenroll');
    const board = document.getElementById('btn-board');
    const kIn = document.getElementById('btn-keldim-main');
    const kOut = document.getElementById('btn-ketdim-main');

    if (enroll) bindTap(enroll, () => doEnroll());
    if (re) bindTap(re, () => { if (!busy) doEnroll(true); });
    if (board) bindTap(board, () => loadBoard());
    if (kIn) bindTap(kIn, () => startAttendanceFlow('in'));
    if (kOut) bindTap(kOut, () => startAttendanceFlow('out'));
  }

  /** Face verify → Keldim/Ketdim tasdiq */
  async function startAttendanceFlow(kind) {
    if (busy) return;
    if (!STATE || !STATE.enrolled) {
      msg('Avval Face ID ulang', 'err');
      return;
    }
    const today = STATE.today || {};
    if (today.in && today.out) {
      msg('Bugun allaqachon yakunlangan', 'info');
      return;
    }
    if (kind === 'in' && today.in) {
      msg('Bugun Keldim allaqachon bor', 'info');
      return;
    }
    if (kind === 'out' && !today.in) {
      msg('Avval Keldim qiling', 'info');
      return;
    }
    if (kind === 'out' && today.out) {
      msg('Bugun Ketdim allaqachon bor', 'info');
      return;
    }

    pendingKind = kind || null;
    busy = true;
    clearMsg();
    openModal(
      'FACE ID',
      kind === 'out' ? 'Ketdim uchun yuzni tasdiqlang' : 'Keldim uchun yuzni tasdiqlang'
    );
    flowRetry = () => startAttendanceFlow(kind);

    try {
      // Muhim: user gesture ichida kamera + GPS parallel (iOS)
      setFidUI({ status: 'RUXSAT…', hint: 'Kamera va joylashuv so‘ralmoqda — Ruxsat bering', progress: 6, tone: 'load' });
      const gpsPromise = getGps();
      const camPromise = startCam();
      let gps;
      try {
        gps = await gpsPromise;
      } catch (ge) {
        // Kamerani tozalab, aniq xato ko‘rsatamiz — oynani yopmaymiz
        try { await camPromise; } catch (e) {}
        stopCam();
        throw ge;
      }
      try {
        await camPromise;
      } catch (ce) {
        throw ce;
      }

      setFidUI({ status: 'LOADING…', hint: 'Yuz modeli…', progress: 18, tone: 'load' });
      await ensureModels();

      const scan = await scanFace({
        needSamples: 3,
        label: 'Yuzni markazda ushlang',
        timeoutMs: 25000
      });

      stopScanLoop();
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }

      pendingScan = { descriptor: scan.descriptor, photo: scan.photo, gps };
      showFidActions();
      // Agar kind aniq — darhol yozish (bitta bosish mobil uchun)
      if (kind === 'in' || kind === 'out') {
        await confirmPunch(kind);
      } else {
        busy = false;
      }
    } catch (e) {
      if (modal) { modal.classList.add('err'); modal.classList.remove('ok', 'scanning'); }
      stopCam();
      const text = e.message || 'Xato';
      setFidUI({ status: 'FAILED', hint: text, progress: 0, tone: 'err' });
      msg(text, 'err');
      showRetry(text);
      busy = false;
    }
  }

  async function confirmPunch(kind) {
    if (!pendingScan) {
      msg('Avval yuzni tasdiqlang', 'err');
      return;
    }
    busy = true;
    hideFidActions();
    hideRetry();
    try {
      setFidUI({
        status: kind === 'in' ? 'KELDIM…' : 'KETDIM…',
        hint: 'Yozilmoqda…',
        progress: 100,
        tone: 'ok'
      });
      const { descriptor, photo, gps } = pendingScan;
      const r = await api('/api/attendance/punch', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          lat: gps.lat,
          lng: gps.lng,
          accuracy: gps.accuracy,
          photo,
          descriptor,
          credentialId: null,
          challenge: null
        })
      });
      setFidUI({
        status: 'SUCCESS',
        hint: r.message || (kind === 'in' ? 'Keldim qayd etildi' : 'Ketdim qayd etildi'),
        progress: 100,
        tone: 'ok'
      });
      await new Promise((x) => setTimeout(x, 650));
      closeModal();
      msg(r.message || (kind === 'in' ? 'Keldim — vaqt boshlandi' : 'Ketdim — kun yakunlandi'), 'ok');
      uiTab = 'bugun';
      await reload();
    } catch (e) {
      if (modal) modal.classList.add('err');
      const text = e.message || 'Xato';
      setFidUI({ status: 'DENIED', hint: text, progress: 0, tone: 'err' });
      msg(text, 'err');
      showRetry(text);
    } finally {
      busy = false;
    }
  }

  async function doEnroll(isRe) {
    if (busy) return;
    busy = true;
    clearMsg();
    pendingKind = null;
    openModal('FACE ID', isRe ? 'Yuzni qayta ulash' : 'Birinchi ulash');
    flowRetry = () => doEnroll(isRe);
    try {
      setFidUI({ status: 'RUXSAT…', hint: 'Kameraga ruxsat bering', progress: 8, tone: 'load' });
      await startCam();
      try { await getGps(); } catch (e) { /* enroll uchun GPS shart emas */ }
      setFidUI({ status: 'LOADING…', hint: 'Yuz modeli…', progress: 20, tone: 'load' });
      await ensureModels();
      const scan = await scanFace({
        needSamples: 5,
        label: 'Yuzni markazda ushlang — harakatsiz',
        timeoutMs: 28000
      });
      setFidUI({ status: 'SAVING…', hint: 'Face ID saqlanmoqda', progress: 100, tone: 'ok' });
      await api('/api/attendance/enroll', {
        method: 'POST',
        body: JSON.stringify({ photo: scan.photo, descriptor: scan.descriptor, credentialId: null })
      });
      await new Promise((r) => setTimeout(r, 500));
      closeModal();
      msg('Face ID ulandi. Endi Keldim bosing.', 'ok');
      await reload();
    } catch (e) {
      if (modal) modal.classList.add('err');
      stopCam();
      const text = e.message || 'Ulanish xato';
      setFidUI({ status: 'FAILED', hint: text, progress: 0, tone: 'err' });
      msg(text, 'err');
      showRetry(text);
    } finally {
      busy = false;
    }
  }

  async function loadBoard() {
    const box = document.getElementById('att-board');
    if (!box) return;
    try {
      const d = await api('/api/attendance/board');
      const rows = d.rows || [];
      box.innerHTML = `
        <div class="scroll-x">
        <table class="att-table">
          <thead><tr><th>Ism</th><th>Rol</th><th>Holat</th><th>Keldim</th><th>Ketdim</th><th>Face</th></tr></thead>
          <tbody>
            ${rows.map((r) => `
              <tr>
                <td>${esc(r.name || r.username)}</td>
                <td>${esc(r.role)}</td>
                <td><span class="att-badge ${esc(r.status)}">${esc(statusLabel(r.status))}</span></td>
                <td>${r.in ? fmtTime(r.in.at) + (r.in.late ? ' !' : '') : '—'}</td>
                <td>${r.out ? fmtTime(r.out.at) : '—'}</td>
                <td>${r.enrolled ? '✓' : '—'}</td>
              </tr>`).join('') || '<tr><td colspan="6">Bo‘sh</td></tr>'}
          </tbody>
        </table></div>`;
    } catch (e) {
      box.innerHTML = `<p class="att-hint">${esc(e.message || 'Taxta xato')}</p>`;
    }
  }

  function renderSettings() {
    const box = document.getElementById('att-settings');
    if (!box || !STATE) return;
    api('/api/attendance/settings').then((d) => {
      const s = d.settings || {};
      const o = s.office || {};
      box.innerHTML = `
        <div class="row2">
          <div class="fld"><label>Keldim (ochiladi)</label><input id="s-in-start" value="${esc(s.in_start || '')}"></div>
          <div class="fld"><label>Kechikish dan</label><input id="s-late" value="${esc(s.in_late_after || '')}"></div>
        </div>
        <div class="row2">
          <div class="fld"><label>Ketdim (tavsiya)</label><input id="s-out-start" value="${esc(s.out_start || '')}"></div>
          <div class="fld"><label>Kun yopiladi</label><input id="s-out-end" value="${esc(s.out_end || '')}"></div>
        </div>
        <div class="row2">
          <div class="fld"><label>Ofis lat</label><input id="s-lat" value="${esc(o.lat || '')}"></div>
          <div class="fld"><label>Ofis lng</label><input id="s-lng" value="${esc(o.lng || '')}"></div>
        </div>
        <div class="row2">
          <div class="fld"><label>Radius (m)</label><input id="s-radius" type="number" value="${esc(o.radius_m || 250)}"></div>
          <div class="fld"><label>Ofis nomi</label><input id="s-label" value="${esc(o.label || '')}"></div>
        </div>
        <button type="button" class="att-btn att-btn-in" id="btn-save-set" style="margin-top:8px">Saqlash</button>
        <button type="button" class="att-btn att-btn-face" id="btn-here" style="margin-top:8px">Hozirgi joyimni ofis qil</button>
      `;
      document.getElementById('btn-save-set').onclick = saveSettings;
      document.getElementById('btn-here').onclick = async () => {
        try {
          const g = await getGps();
          document.getElementById('s-lat').value = String(g.lat);
          document.getElementById('s-lng').value = String(g.lng);
          msg('Lat/lng yozildi — Saqlash bosing', 'info');
        } catch (e) { msg(e.message, 'err'); }
      };
    }).catch((e) => {
      box.innerHTML = `<p class="att-hint">${esc(e.message)}</p>`;
    });
  }

  async function saveSettings() {
    try {
      const body = {
        in_start: document.getElementById('s-in-start').value,
        in_end: document.getElementById('s-in-start').value,
        in_late_after: document.getElementById('s-late').value,
        out_start: document.getElementById('s-out-start').value,
        out_end: document.getElementById('s-out-end').value,
        office: {
          lat: document.getElementById('s-lat').value,
          lng: document.getElementById('s-lng').value,
          radius_m: document.getElementById('s-radius').value,
          label: document.getElementById('s-label').value
        }
      };
      await api('/api/attendance/settings', { method: 'POST', body: JSON.stringify(body) });
      msg('Sozlamalar saqlandi', 'ok');
      await reload();
    } catch (e) {
      msg(e.message || 'Saqlash xato', 'err');
    }
  }

  async function reload() {
    STATE = await api('/api/attendance/me');
    window._vmFaceEnrolled = !!STATE.enrolled;
    if (typeof vmEnsureDavomatNav === 'function') vmEnsureDavomatNav();
    render();
  }

  if (btnKeldim) bindTap(btnKeldim, () => confirmPunch('in'));
  if (btnKetdim) bindTap(btnKetdim, () => confirmPunch('out'));
  if (btnRetry) {
    bindTap(btnRetry, () => {
      hideRetry();
      if (typeof flowRetry === 'function') flowRetry();
    });
  }
  if (btnCancel) {
    bindTap(btnCancel, () => {
      if (abortScan) abortScan();
      closeModal();
      busy = false;
    });
  }

  const closeBtn = document.getElementById('fid-close');
  if (closeBtn) {
    bindTap(closeBtn, () => {
      if (abortScan) abortScan();
      closeModal();
      busy = false;
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalOpen) {
      if (abortScan) abortScan();
      closeModal();
      busy = false;
    }
  });

  async function boot() {
    try {
      const user = await vmMe();
      if (typeof vmApplyChrome === 'function') vmApplyChrome(user);
      else {
        vmApplyRoleNav(user);
        const name = document.getElementById('tb-user-name');
        if (name) name.textContent = user.name || user.username || '—';
      }
      vmGatePage(user);
      await reload();
      ensureModels().catch(() => {});
    } catch (e) {
      app.innerHTML = `<p class="att-loading">${esc(e.message || 'Xato')}</p>`;
    }
  }

  boot();
})();
