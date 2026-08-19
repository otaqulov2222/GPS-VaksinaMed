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
    return d.user;
}

async function vmLogout() {
    try { await vmApi('/api/logout', { method: 'POST', body: '{}', noRedirect: true }); }
    catch (e) {}
    location.replace('/login.html');
}

function vmApplyChrome(user) {
    if (!user) return;
    const name = document.getElementById('tb-user-name');
    const role = document.getElementById('tb-user-role');
    const panel = document.getElementById('btn-admin-panel');
    if (name) name.textContent = user.username || '—';
    if (role) {
        role.hidden = false;
        role.textContent = user.role === 'admin_pro' ? 'Admin Pro' : 'Admin';
        role.className = 'tb-role tb-role-' + (user.role === 'admin_pro' ? 'pro' : 'admin');
    }
    if (panel) {
        const isPro = user.role === 'admin_pro';
        panel.style.display = isPro ? 'inline-flex' : 'none';
        panel.textContent = 'Admin';
        panel.setAttribute('href', '/admin.html');
    }
}

function vmStartHeartbeat() {
    setInterval(() => {
        fetch('/api/ping', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
            .then(r => { if (r.status === 401) location.replace('/login.html'); })
            .catch(() => {});
    }, 25000);
}
