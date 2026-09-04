'use strict';

async function vmApi(path, opts) {
    const opt = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {});
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opt, { headers }));
    let data = {};
    try { data = await r.json(); } catch (e) { data = {}; }
    if (r.status === 401 && !opt.noRedirect) {
        location.replace('/login.html');
        throw new Error('Kirish talab qilinadi');
    }
    if (!r.ok) throw new Error(data.error || ('Xato ' + r.status));
    return data;
}

async function vmMe() {
    const d = await vmApi('/api/me');
    window.VM_USER = d.user;
    if (d.vehicles && typeof applyFleetNameOverrides === 'function') {
        applyFleetNameOverrides(d.vehicles);
    }
    return d.user;
}

async function vmLogout() {
    try { await vmApi('/api/logout', { method: 'POST', body: '{}', noRedirect: true }); }
    catch (e) {}
    location.replace('/login.html');
}

function vmNormLabel(s) {
    return String(s || '').toLowerCase().replace(/[\s._-]+/g, '');
}

function vmSameLabel(a, b) {
    const x = vmNormLabel(a);
    const y = vmNormLabel(b);
    return !!x && x === y;
}

function vmIsStaff(user) {
    return !!user && (user.role === 'admin_pro' || user.role === 'admin');
}

function vmIsDriver(user) {
    return !!user && user.role === 'driver';
}

function vmGatePage(user) {
    const path = (location.pathname || '').replace(/\\/g, '/');
    const onDriver = path.endsWith('/driver.html');
    const onProfile = path.endsWith('/profile.html');
    if (vmIsDriver(user)) {
        if (!onDriver && !onProfile) location.replace('/driver.html');
        return;
    }
    if (onDriver && !vmIsStaff(user)) {
        location.replace('/');
    }
}

function vmApplyChrome(user) {
    if (!user) return;
    const name = document.getElementById('tb-user-name');
    const role = document.getElementById('tb-user-role');
    const panel = document.getElementById('btn-admin-panel');
    if (name) name.textContent = user.username || user.name || '—';
    if (role) {
        const roleLabel = user.role === 'admin_pro' ? 'Admin Pro' : (user.role === 'driver' ? 'Haydovchi' : '');
        const shown = name ? name.textContent : (user.username || '');
        if (roleLabel && !vmSameLabel(shown, roleLabel) && !vmSameLabel(shown, 'admin')) {
            role.hidden = false;
            role.textContent = roleLabel;
            role.className = 'tb-role ' + (user.role === 'admin_pro' ? 'tb-role-pro' : 'tb-role-admin');
        } else {
            role.hidden = true;
            role.textContent = '';
        }
    }
    if (panel) {
        if (vmIsStaff(user)) {
            panel.style.display = 'inline-flex';
            panel.textContent = user.role === 'admin_pro' ? 'Admin Pro' : 'Panel';
        } else {
            panel.style.display = 'none';
        }
        panel.setAttribute('href', '/admin.html');
    }
}

function vmStartHeartbeat() {
    if (window._vmHeartbeat) return;
    window._vmHeartbeat = setInterval(() => {
        fetch('/api/ping', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(r => { if (r.status === 401) location.replace('/login.html'); })
            .catch(() => {});
    }, 60000);
}

/** Mobil menyuni yopish (tab/link bosilganda) */
function vmCloseNav() {
    const cb = document.getElementById('nav-open');
    if (cb) cb.checked = false;
}

/** Link navigatsiyasidan oldin menyuni yopish — iOS touch uchun ishonchli */
function vmBindNavClose() {
    if (window._vmNavCloseBound) return;
    window._vmNavCloseBound = true;
    const closeIfNavLink = (e) => {
        const t = e.target && e.target.closest
            ? e.target.closest('.nav-rail a[href], .nav-rail .tab, .nav-rail button.tab')
            : null;
        if (t) vmCloseNav();
    };
    document.addEventListener('click', closeIfNavLink, true);
    document.addEventListener('touchend', closeIfNavLink, { capture: true, passive: true });
}

/** Parol maydonlariga ko'zcha — yozilayotgan parolni ko'rish */
const VM_PW_EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

function vmTogglePasswordInput(inp, btn) {
    if (!inp) return;
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    if (btn) {
        btn.classList.toggle('on', show);
        btn.title = show ? "Parolni yashirish" : "Parolni ko'rsatish";
        btn.setAttribute('aria-label', btn.title);
    }
}

function vmEnsurePasswordEye(inp) {
    if (!inp || inp.nodeType !== 1) return;
    if (inp.dataset.pwEyeBound === '1') return;
    if (inp.type !== 'password' && inp.type !== 'text') return;
    // Yashirin autofill trap
    if (inp.getAttribute('aria-hidden') === 'true' || inp.tabIndex === -1) {
        const st = window.getComputedStyle(inp);
        if (st.display === 'none' || inp.name === 'prevent_autofill_pass') return;
    }
    if (inp.name === 'prevent_autofill_pass') return;

    inp.dataset.pwEyeBound = '1';

    // Allaqachon data-for bilan bog'langan ko'zcha
    if (inp.id) {
        const existing = document.querySelector('.pw-eye[data-for="' + inp.id + '"]');
        if (existing && !existing.dataset.bound) {
            existing.dataset.bound = '1';
            existing.addEventListener('click', (e) => {
                e.preventDefault();
                vmTogglePasswordInput(inp, existing);
            });
            return;
        }
        if (existing) return;
    }

    let wrap = inp.closest('.pw-wrap');
    if (!wrap) {
        wrap = document.createElement('div');
        wrap.className = 'pw-wrap';
        const parent = inp.parentNode;
        if (!parent) return;
        parent.insertBefore(wrap, inp);
        wrap.appendChild(inp);
    }
    if (wrap.querySelector('.pw-eye')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-eye';
    btn.title = "Parolni ko'rsatish";
    btn.setAttribute('aria-label', "Parolni ko'rsatish");
    btn.innerHTML = VM_PW_EYE_SVG;
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        vmTogglePasswordInput(inp, btn);
    });
    wrap.appendChild(btn);
}

function vmInitPasswordEyes(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll('input[type="password"]').forEach(vmEnsurePasswordEye);
    // Modal ichida keyin ochilishi mumkin
    scope.querySelectorAll('.pw-eye[data-for]').forEach((btn) => {
        if (btn.dataset.bound === '1') return;
        const id = btn.getAttribute('data-for');
        const inp = id ? document.getElementById(id) : null;
        if (!inp) return;
        btn.dataset.bound = '1';
        inp.dataset.pwEyeBound = '1';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            vmTogglePasswordInput(inp, btn);
        });
    });
}

window.vmInitPasswordEyes = vmInitPasswordEyes;
window.vmEnsurePasswordEye = vmEnsurePasswordEye;

/** Gorizontal scroll kerak bo‘ladigan konteynerlar */
var VM_HSCROLL_SEL = [
    '.app-main .topbar .acts',
    '.app-main .topbar .tb-actions',
    '.driver-strip-wrap',
    '.scroll-x',
    '.table-wrap',
    '.subtabs',
    '.day-pills',
    '.chips',
    '.row-btns',
    '.daily-tools',
    '.jl-actions',
    '.card-h .row-btns'
].join(', ');

/** Faqat gorizontal — vertikal gildirakni ham chap-o‘ngga */
var VM_HSCROLL_ALWAYS = [
    '.app-main .topbar .acts',
    '.app-main .topbar .tb-actions',
    '.driver-strip-wrap',
    '.subtabs',
    '.day-pills'
].join(', ');

function vmCanScrollX(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.scrollWidth <= el.clientWidth + 1) return false;
    const st = window.getComputedStyle(el);
    const ox = st.overflowX;
    return ox === 'auto' || ox === 'scroll' || ox === 'overlay';
}

function vmCanScrollY(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.scrollHeight <= el.clientHeight + 1) return false;
    const st = window.getComputedStyle(el);
    const oy = st.overflowY;
    return oy === 'auto' || oy === 'scroll' || oy === 'overlay';
}

/** Sichqoncha gildiragi → gorizontal scroll (bitta element) */
function vmEnableWheelXScroll(el) {
    if (!el || el.dataset.wheelScroll === '1') return;
    el.dataset.wheelScroll = '1';
    el.addEventListener('wheel', (e) => {
        if (!vmCanScrollX(el)) return;
        const dx = e.deltaX;
        const dy = e.deltaY;
        const always = el.matches(VM_HSCROLL_ALWAYS);
        const canY = vmCanScrollY(el);
        let delta;
        if (Math.abs(dx) > Math.abs(dy)) delta = dx;
        else if (!canY || always || e.shiftKey) delta = dy;
        else return;
        if (!delta) return;
        const max = el.scrollWidth - el.clientWidth;
        const next = Math.max(0, Math.min(max, el.scrollLeft + delta));
        if (next !== el.scrollLeft) {
            e.preventDefault();
            el.scrollLeft = next;
        }
    }, { passive: false });
}

function vmBindHScrollWheels(root) {
    const scope = root && root.querySelectorAll ? root : document;
    scope.querySelectorAll(VM_HSCROLL_SEL).forEach(vmEnableWheelXScroll);
}

/** Dinamik jadvallar (scroll-x) uchun ham ishlasin */
function vmInstallHScrollDelegation() {
    if (window._vmHScrollDelegated) return;
    window._vmHScrollDelegated = true;
    document.addEventListener('wheel', (e) => {
        if (e.ctrlKey || e.defaultPrevented) return;
        let el = e.target;
        if (el && el.nodeType !== 1) el = el.parentElement;
        while (el && el !== document.body && el !== document.documentElement) {
            if (el.matches && el.matches(VM_HSCROLL_SEL) && vmCanScrollX(el)) {
                const dx = e.deltaX;
                const dy = e.deltaY;
                const always = el.matches(VM_HSCROLL_ALWAYS);
                const canY = vmCanScrollY(el);
                let delta;
                if (Math.abs(dx) > Math.abs(dy)) delta = dx;
                else if (!canY || always || e.shiftKey) delta = dy;
                else {
                    el = el.parentElement;
                    continue;
                }
                if (!delta) return;
                const max = el.scrollWidth - el.clientWidth;
                const next = Math.max(0, Math.min(max, el.scrollLeft + delta));
                if (next !== el.scrollLeft) {
                    e.preventDefault();
                    el.scrollLeft = next;
                }
                return;
            }
            el = el.parentElement;
        }
    }, { passive: false, capture: true });
}

function vmInitHScroll() {
    vmInstallHScrollDelegation();
    vmBindHScrollWheels(document);
    vmBindNavClose();
    vmInitPasswordEyes(document);
}

document.addEventListener('DOMContentLoaded', vmInitHScroll);
if (document.readyState !== 'loading') vmInitHScroll();

