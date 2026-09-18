# -*- coding: utf-8 -*-
"""
VaksinaMed ↔ vaksinahr.uz — Logistika SSO / menyu (izolyatsiya).

Mavjud login, fuel, GPS oqimlariga yozmaydi.
Faqat: ruxsatli 2–3 login uchun bir martalik ticket → sessiya.
Yoqilmasa (kalit/users yo'q) — endpointlar 503/401, asosiy tizim o'zgarmaydi.
"""

from __future__ import annotations

import os
import secrets
import threading
import time
import urllib.parse

# ticket_id -> {username, path, embed, exp, used}
_TICKETS = {}
_TICKETS_LOCK = threading.Lock()
_TICKET_TTL_SEC = 90

# Faqat shu yo'llarga redirect (open-redirect himoya)
ALLOWED_PATHS = {
    "/",
    "/fuel",
    "/live",
    "/attendance",
    "/admin",
    "/profile",
    "/index.html",
    "/fuel.html",
    "/live.html",
    "/attendance.html",
    "/admin.html",
    "/profile.html",
}

# HR menyu ↔ bizning yo'llar (Logistika ichidagi bandlar)
MENU_ITEMS = [
    {"id": "dashboard", "title": "Dashboard / VHK", "path": "/"},
    {"id": "fuel", "title": "Boshqaruv", "path": "/fuel"},
    {"id": "live", "title": "Live", "path": "/live"},
    {"id": "attendance", "title": "Davomat", "path": "/attendance"},
    {"id": "panel", "title": "Panel", "path": "/admin"},
]


def public_base_url():
    return (os.environ.get("VM_PUBLIC_BASE_URL") or "").strip().rstrip("/")


def frame_ancestors():
    """Masalan: https://vaksinahr.uz https://www.vaksinahr.uz"""
    return (os.environ.get("VM_HR_FRAME_ANCESTORS") or "").strip()


def sso_usernames():
    """
    VM_HR_SSO_USERS=adminpro,direktor,hradmin
    Faqat shu VaksinaMed loginlar HR orqali kira oladi.
    """
    raw = (os.environ.get("VM_HR_SSO_USERS") or "").strip()
    if not raw:
        return []
    out = []
    seen = set()
    for part in raw.split(","):
        u = part.strip().lower()
        if not u or u in seen:
            continue
        seen.add(u)
        out.append(u)
    return out


def normalize_path(path):
    p = (path or "/").strip() or "/"
    if not p.startswith("/"):
        p = "/" + p
    # query/fragment tashlash
    p = p.split("?", 1)[0].split("#", 1)[0]
    if p in ALLOWED_PATHS:
        return p
    # .html → canonical
    canon = {
        "/index.html": "/",
        "/fuel.html": "/fuel",
        "/live.html": "/live",
        "/attendance.html": "/attendance",
        "/admin.html": "/admin",
        "/profile.html": "/profile",
    }
    if p in canon:
        return canon[p]
    return None


def menu_payload():
    base = public_base_url()
    items = []
    for it in MENU_ITEMS:
        path = it["path"]
        entry = {
            "id": it["id"],
            "title": it["title"],
            "path": path,
            "hint": "SSO: POST /api/hr/logistics/sso → enterUrl oching",
        }
        if base:
            entry["url"] = base + path
        items.append(entry)
    return {
        "menuId": "logistika",
        "title": "Logistika",
        "placement": "top_level",
        "note": "Alohida bo'lim — Apteka tarmog'i ichida emas",
        "items": items,
        "ssoUsersConfigured": len(sso_usernames()),
        "embedSupported": bool(frame_ancestors()),
    }


def resolve_username(body):
    """
    HR yuboradi: username (bizning login) yoki hrUser → map.
    VM_HR_SSO_MAP=email@hr.uz:adminpro,boshqa:direktor
    """
    if not isinstance(body, dict):
        body = {}
    direct = str(body.get("username") or body.get("login") or "").strip()
    if direct:
        return direct

    hr_user = str(body.get("hrUser") or body.get("hr_user") or body.get("email") or "").strip()
    if not hr_user:
        return ""
    raw_map = (os.environ.get("VM_HR_SSO_MAP") or "").strip()
    if not raw_map:
        # map bo'lmasa: hrUser ni to'g'ridan bizning username deb sinab ko'ramiz
        return hr_user
    needle = hr_user.lower()
    for part in raw_map.split(","):
        part = part.strip()
        if ":" not in part:
            continue
        left, right = part.split(":", 1)
        if left.strip().lower() == needle:
            return right.strip()
    return ""


def create_ticket(username, path="/", embed=False):
    path_ok = normalize_path(path)
    if not path_ok:
        return None, "path ruxsat etilmagan"
    allowed = sso_usernames()
    if not allowed:
        return None, "SSO o'chirilgan — serverda VM_HR_SSO_USERS qo'ying"
    if username.strip().lower() not in allowed:
        return None, "Bu login HR Logistika uchun ruxsat etilmagan"
    tid = secrets.token_urlsafe(24)
    with _TICKETS_LOCK:
        _purge_locked()
        _TICKETS[tid] = {
            "username": username.strip(),
            "path": path_ok,
            "embed": bool(embed),
            "exp": time.time() + _TICKET_TTL_SEC,
            "used": False,
        }
    return tid, None


def consume_ticket(tid):
    tid = (tid or "").strip()
    if not tid:
        return None, "ticket yo'q"
    with _TICKETS_LOCK:
        _purge_locked()
        row = _TICKETS.get(tid)
        if not row:
            return None, "ticket noto'g'ri yoki muddati o'tgan"
        if row.get("used"):
            return None, "ticket allaqachon ishlatilgan"
        if time.time() > float(row.get("exp") or 0):
            _TICKETS.pop(tid, None)
            return None, "ticket muddati o'tgan"
        row["used"] = True
        _TICKETS.pop(tid, None)
        return dict(row), None


def _purge_locked():
    now = time.time()
    dead = [k for k, v in _TICKETS.items() if now > float(v.get("exp") or 0) or v.get("used")]
    for k in dead:
        _TICKETS.pop(k, None)


def enter_url(ticket_id):
    base = public_base_url()
    q = urllib.parse.urlencode({"ticket": ticket_id})
    path = f"/api/hr/logistics/enter?{q}"
    if base:
        return base + path
    return path
