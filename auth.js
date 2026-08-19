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
    if (vmIsDriver(user)) {
        if (!onDriver) location.replace('/driver.html');
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
    }, 25000);
}
