#!/usr/bin/env python3
"""
VaksinaMed GPS Monitor — HTTP server
Auth (Admin Pro / Admin) + GPS proxy + statik fayllar
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import socketserver
import sys
import threading
import time
import argparse
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8080"))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
COOKIE = "vm_sid"
SESSION_TTL = 12 * 3600
SEED_USER = "adminpro"
SEED_PASS = "AdminPro@2026"

PUBLIC_PATHS = {"/login.html", "/favicon.ico"}
PUBLIC_PREFIX = ("/fonts/", "/logo/")
BLOCKED_EXT = {".py", ".bat", ".md", ".txt"}
BLOCKED_NAMES = {"users.json", "server.py", "start.bat", "office-seed.json"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

ALLOWED_GPS_HOSTS = [
    "bms1.gpsavto.uz",
    "hosting.wialon.com",
    "hst-api.wialon.com",
]


def now_ts():
    return int(time.time())


def iso_now():
    return time.strftime("%Y-%m-%d %H:%M:%S")


def hash_pw(password, salt=None):
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 150000
    )
    return salt, dk.hex()


def verify_pw(password, salt, hexhash):
    if not password or not salt or not hexhash:
        return False
    _, h = hash_pw(password, salt)
    return hmac.compare_digest(h, hexhash)


def new_id(prefix):
    return prefix + "_" + secrets.token_hex(6)


class AuthStore:
    def __init__(self, root):
        self.root = root
        self.path = os.path.join(root, "data", "users.json")
        self.lock = threading.Lock()
        self.sessions = {}
        self.seeded = False
        self._ensure()

    def _ensure(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        if os.path.exists(self.path):
            return
        salt, pw_hash = hash_pw(SEED_PASS)
        data = {
            "users": [
                {
                    "id": "u_adminpro",
                    "username": SEED_USER,
                    "name": "Admin Pro",
                    "role": "admin_pro",
                    "password_salt": salt,
                    "password_hash": pw_hash,
                    "active": True,
                    "protected": True,
                    "created_at": iso_now(),
                    "last_login": None,
                }
            ],
            "audit": [
                {
                    "t": iso_now(),
                    "act": "seed",
                    "who": "system",
                    "detail": "Admin Pro yaratildi",
                }
            ],
        }
        self._write(data)
        self.seeded = True

    def _read(self):
        with open(self.path, "r", encoding="utf-8") as f:
            return json.load(f)

    def _write(self, data):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.path)

    def _audit(self, data, act, who, detail=""):
        data.setdefault("audit", [])
        data["audit"].append(
            {"t": iso_now(), "act": act, "who": who, "detail": detail}
        )
        data["audit"] = data["audit"][-400:]

    def public_user(self, u):
        if not u:
            return None
        return {
            "id": u["id"],
            "username": u["username"],
            "name": u.get("name") or u["username"],
            "role": u.get("role") or "admin",
            "active": bool(u.get("active", True)),
            "protected": bool(u.get("protected")),
            "created_at": u.get("created_at"),
            "last_login": u.get("last_login"),
        }

    def find_user(self, data, username=None, uid=None):
        for u in data.get("users", []):
            if uid and u.get("id") == uid:
                return u
            if username and u.get("username", "").lower() == username.lower():
                return u
        return None

    def login(self, username, password, ip, ua):
        with self.lock:
            data = self._read()
            user = self.find_user(data, username=username.strip() if username else "")
            if not user or not user.get("active", True):
                self._audit(data, "login_fail", username or "?", "login topilmadi yoki o'chirilgan")
                self._write(data)
                return None, "Login yoki parol noto'g'ri"
            if not verify_pw(password or "", user.get("password_salt"), user.get("password_hash")):
                self._audit(data, "login_fail", username, "parol xato")
                self._write(data)
                return None, "Login yoki parol noto'g'ri"
            sid = secrets.token_urlsafe(32)
            sess = {
                "id": sid,
                "user_id": user["id"],
                "username": user["username"],
                "name": user.get("name") or user["username"],
                "role": user.get("role") or "admin",
                "ip": ip,
                "ua": (ua or "")[:180],
                "created": now_ts(),
                "last_seen": now_ts(),
            }
            self.sessions[sid] = sess
            user["last_login"] = iso_now()
            self._audit(data, "login_ok", user["username"], ip)
            self._write(data)
            return sess, None

    def logout(self, sid):
        with self.lock:
            self.sessions.pop(sid, None)

    def get_session(self, sid):
        if not sid:
            return None
        with self.lock:
            sess = self.sessions.get(sid)
            if not sess:
                return None
            if now_ts() - sess["last_seen"] > SESSION_TTL:
                self.sessions.pop(sid, None)
                return None
            sess["last_seen"] = now_ts()
            data = self._read()
            user = self.find_user(data, uid=sess["user_id"])
            if not user or not user.get("active", True):
                self.sessions.pop(sid, None)
                return None
            sess["role"] = user.get("role") or "admin"
            sess["name"] = user.get("name") or user["username"]
            return sess

    def list_users(self):
        with self.lock:
            data = self._read()
            return [self.public_user(u) for u in data.get("users", [])]

    def add_admin(self, actor, name, username, password):
        username = (username or "").strip().lower()
        name = (name or "").strip()
        password = password or ""
        if not username or len(username) < 3:
            return None, "Login kamida 3 belgi bo'lsin"
        if not all(c.isalnum() or c in "._-" for c in username):
            return None, "Login: faqat harf, raqam, . _ -"
        if len(password) < 6:
            return None, "Parol kamida 6 belgi bo'lsin"
        if not name:
            name = username
        with self.lock:
            data = self._read()
            if self.find_user(data, username=username):
                return None, "Bu login band"
            salt, pw_hash = hash_pw(password)
            user = {
                "id": new_id("u"),
                "username": username,
                "name": name,
                "role": "admin",
                "password_salt": salt,
                "password_hash": pw_hash,
                "active": True,
                "protected": False,
                "created_at": iso_now(),
                "last_login": None,
            }
            data["users"].append(user)
            self._audit(data, "user_add", actor, username)
            self._write(data)
            return self.public_user(user), None

    def set_active(self, actor, uid, active):
        with self.lock:
            data = self._read()
            user = self.find_user(data, uid=uid)
            if not user:
                return None, "Foydalanuvchi topilmadi"
            if user.get("protected") and not active:
                return None, "Admin Pro ni o'chirib bo'lmaydi"
            user["active"] = bool(active)
            if not active:
                for sid, s in list(self.sessions.items()):
                    if s["user_id"] == uid:
                        self.sessions.pop(sid, None)
            self._audit(data, "user_toggle", actor, f"{user['username']} active={user['active']}")
            self._write(data)
            return self.public_user(user), None

    def delete_user(self, actor, uid):
        with self.lock:
            data = self._read()
            user = self.find_user(data, uid=uid)
            if not user:
                return None, "Foydalanuvchi topilmadi"
            if user.get("protected") or user.get("role") == "admin_pro":
                return None, "Admin Pro ni o'chirib bo'lmaydi"
            data["users"] = [u for u in data["users"] if u["id"] != uid]
            for sid, s in list(self.sessions.items()):
                if s["user_id"] == uid:
                    self.sessions.pop(sid, None)
            self._audit(data, "user_del", actor, user["username"])
            self._write(data)
            return True, None

    def reset_password(self, actor, uid, new_password):
        if len(new_password or "") < 6:
            return None, "Parol kamida 6 belgi bo'lsin"
        with self.lock:
            data = self._read()
            user = self.find_user(data, uid=uid)
            if not user:
                return None, "Foydalanuvchi topilmadi"
            salt, pw_hash = hash_pw(new_password)
            user["password_salt"] = salt
            user["password_hash"] = pw_hash
            for sid, s in list(self.sessions.items()):
                if s["user_id"] == uid:
                    self.sessions.pop(sid, None)
            self._audit(data, "pw_reset", actor, user["username"])
            self._write(data)
            return True, None

    def change_own_password(self, uid, old_pw, new_pw):
        if len(new_pw or "") < 6:
            return None, "Yangi parol kamida 6 belgi bo'lsin"
        with self.lock:
            data = self._read()
            user = self.find_user(data, uid=uid)
            if not user:
                return None, "Foydalanuvchi topilmadi"
            if not verify_pw(old_pw or "", user.get("password_salt"), user.get("password_hash")):
                return None, "Eski parol noto'g'ri"
            salt, pw_hash = hash_pw(new_pw)
            user["password_salt"] = salt
            user["password_hash"] = pw_hash
            self._audit(data, "pw_self", user["username"], "")
            self._write(data)
            return True, None

    def list_sessions(self):
        with self.lock:
            out = []
            t = now_ts()
            for s in self.sessions.values():
                age = t - s["last_seen"]
                out.append(
                    {
                        "id": s["id"],
                        "username": s["username"],
                        "name": s["name"],
                        "role": s["role"],
                        "ip": s.get("ip") or "",
                        "ua": s.get("ua") or "",
                        "created": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(s["created"])),
                        "last_seen": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(s["last_seen"])),
                        "online": age < 90,
                    }
                )
            out.sort(key=lambda x: (not x["online"], x["username"]))
            return out

    def kick(self, actor, sid):
        with self.lock:
            s = self.sessions.pop(sid, None)
            if not s:
                return None, "Sessiya topilmadi"
            data = self._read()
            self._audit(data, "kick", actor, s.get("username"))
            self._write(data)
            return True, None

    def audit(self, limit=80):
        with self.lock:
            data = self._read()
            rows = list(reversed(data.get("audit", [])))
            return rows[:limit]


def valid_date(s):
    return bool(s and DATE_RE.match(str(s)))


def to_float(v):
    if v is None or v == "":
        return None
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n != n:
        return None
    return n


def clean_pharmacy(p):
    if not isinstance(p, dict):
        return None
    name = str(p.get("name") or "").strip()[:80]
    car = str(p.get("car") or "").strip()[:24]
    if not name or not car:
        return None
    rid = str(p.get("id") or "").strip()[:40] or ("ph_" + secrets.token_hex(4))
    radius = p.get("radiusM")
    try:
        radius = int(radius) if radius not in (None, "") else 120
    except (TypeError, ValueError):
        radius = 120
    radius = max(40, min(radius, 500))
    aliases = p.get("aliases") if isinstance(p.get("aliases"), list) else []
    aliases = [str(a).strip()[:60] for a in aliases if str(a).strip()][:12]
    return {
        "id": rid,
        "car": car,
        "name": name,
        "lat": to_float(p.get("lat")),
        "lng": to_float(p.get("lng")),
        "radiusM": radius,
        "aliases": aliases,
    }


def telegram_send(token, chat_id, text):
    token = (token or "").strip()
    chat_id = str(chat_id or "").strip()
    text = (text or "").strip()
    if not token or not chat_id or not text:
        return False, "Token yoki chat ID yo'q"
    url = "https://api.telegram.org/bot%s/sendMessage" % token
    body = json.dumps(
        {
            "chat_id": chat_id,
            "text": text[:4000],
            "disable_web_page_preview": True,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
            if data.get("ok"):
                return True, None
            return False, str(data.get("description") or "Telegram xato")
    except Exception as e:
        return False, str(e)


class OfficeStore:
    def __init__(self, root):
        self.root = os.path.join(root, "data", "office")
        self.seed_path = os.path.join(root, "office-seed.json")
        self.lock = threading.Lock()
        os.makedirs(os.path.join(self.root, "reports"), exist_ok=True)
        os.makedirs(os.path.join(self.root, "reviews"), exist_ok=True)
        self._ensure_pharmacies()
        self._ensure_settings()

    def _read_json(self, path, default):
        if not os.path.isfile(path):
            return default
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return default

    def _write_json(self, path, obj):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def _ensure_pharmacies(self):
        path = os.path.join(self.root, "pharmacies.json")
        if os.path.isfile(path):
            return
        seed = self._read_json(self.seed_path, {})
        items = seed.get("pharmacies") if isinstance(seed, dict) else []
        cleaned = [c for c in (clean_pharmacy(p) for p in items or []) if c]
        self._write_json(path, {"pharmacies": cleaned})

    def _ensure_settings(self):
        path = os.path.join(self.root, "settings.json")
        if os.path.isfile(path):
            return
        self._write_json(
            path,
            {"telegram": {"botToken": "", "chatId": "", "enabled": False}},
        )

    def pharmacies(self):
        with self.lock:
            data = self._read_json(os.path.join(self.root, "pharmacies.json"), {})
            items = data.get("pharmacies") if isinstance(data, dict) else []
            return items if isinstance(items, list) else []

    def save_pharmacies(self, items):
        cleaned = [c for c in (clean_pharmacy(p) for p in items or []) if c]
        seen = set()
        unique = []
        for p in cleaned:
            if p["id"] in seen:
                p["id"] = "ph_" + secrets.token_hex(4)
            seen.add(p["id"])
            unique.append(p)
        with self.lock:
            self._write_json(os.path.join(self.root, "pharmacies.json"), {"pharmacies": unique})
        return unique

    def reviews(self, date):
        if not valid_date(date):
            return {}
        with self.lock:
            data = self._read_json(os.path.join(self.root, "reviews", date + ".json"), {})
            return data if isinstance(data, dict) else {}

    def all_reviews(self):
        out = {}
        folder = os.path.join(self.root, "reviews")
        with self.lock:
            if not os.path.isdir(folder):
                return out
            for name in os.listdir(folder):
                if not name.endswith(".json"):
                    continue
                date = name[:-5]
                if not valid_date(date):
                    continue
                data = self._read_json(os.path.join(folder, name), {})
                if isinstance(data, dict) and data:
                    out[date] = data
        return out

    def set_review(self, date, key, rec):
        if not valid_date(date) or not key:
            return None, "Sana yoki kalit noto'g'ri"
        key = str(key)[:180]
        with self.lock:
            path = os.path.join(self.root, "reviews", date + ".json")
            data = self._read_json(path, {})
            if not isinstance(data, dict):
                data = {}
            status = (rec or {}).get("status")
            if status in ("allowed", "violation"):
                data[key] = {
                    "status": status,
                    "note": str((rec or {}).get("note") or "")[:200],
                    "by": str((rec or {}).get("by") or "")[:40],
                    "at": iso_now(),
                }
            else:
                data.pop(key, None)
            self._write_json(path, data)
            return data, None

    def report_dates(self):
        folder = os.path.join(self.root, "reports")
        dates = []
        with self.lock:
            if not os.path.isdir(folder):
                return dates
            for name in os.listdir(folder):
                if name.endswith(".json") and valid_date(name[:-5]):
                    dates.append(name[:-5])
        dates.sort(reverse=True)
        return dates

    def get_report(self, date):
        if not valid_date(date):
            return None
        with self.lock:
            data = self._read_json(os.path.join(self.root, "reports", date + ".json"), None)
            return data if isinstance(data, dict) else None

    def save_report(self, date, cars, saved_by=""):
        if not valid_date(date):
            return None, "Sana noto'g'ri"
        if not isinstance(cars, dict):
            return None, "Ma'lumot noto'g'ri"
        payload = {
            "date": date,
            "savedAt": iso_now(),
            "savedBy": str(saved_by or "")[:40],
            "cars": cars,
        }
        with self.lock:
            self._write_json(os.path.join(self.root, "reports", date + ".json"), payload)
        return payload, None

    def settings(self):
        with self.lock:
            data = self._read_json(os.path.join(self.root, "settings.json"), {})
            tg = data.get("telegram") if isinstance(data, dict) else {}
            if not isinstance(tg, dict):
                tg = {}
            return {
                "telegram": {
                    "botToken": str(tg.get("botToken") or ""),
                    "chatId": str(tg.get("chatId") or ""),
                    "enabled": bool(tg.get("enabled")),
                }
            }

    def public_telegram(self):
        tg = self.settings()["telegram"]
        return {
            "enabled": bool(tg.get("enabled")),
            "ready": bool(tg.get("enabled") and tg.get("botToken") and tg.get("chatId")),
            "hasToken": bool(tg.get("botToken")),
            "chatId": tg.get("chatId") or "",
        }

    def save_telegram(self, body):
        body = body or {}
        with self.lock:
            path = os.path.join(self.root, "settings.json")
            data = self._read_json(path, {})
            if not isinstance(data, dict):
                data = {}
            tg = data.get("telegram") if isinstance(data.get("telegram"), dict) else {}
            if "chatId" in body:
                tg["chatId"] = str(body.get("chatId") or "").strip()[:64]
            if "enabled" in body:
                tg["enabled"] = bool(body.get("enabled"))
            token = body.get("botToken")
            if token is not None and str(token).strip() != "":
                tg["botToken"] = str(token).strip()[:200]
            data["telegram"] = tg
            self._write_json(path, data)
        return self.public_telegram()


STORE = None
OFFICE = None


class VaksinamedHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def log_message(self, format, *args):
        if args and ("GET" in str(args[0]) or "POST" in str(args[0])):
            status = args[1] if len(args) > 1 else "?"
            path = args[0].split(" ")[1] if " " in str(args[0]) else str(args[0])
            if not path.endswith((".css", ".js", ".ico", ".png", ".jpg", ".ttf")):
                print(f"  [{status}] {path}")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def client_ip(self):
        return self.client_address[0] if self.client_address else ""

    def read_sid(self):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith(COOKIE + "="):
                return part.split("=", 1)[1].strip()
        return None

    def current_session(self):
        return STORE.get_session(self.read_sid())

    def send_json(self, obj, code=200, set_cookie=None, clear_cookie=False):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        if set_cookie:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE}={set_cookie}; HttpOnly; Path=/; SameSite=Lax; Max-Age={SESSION_TTL}",
            )
        if clear_cookie:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0",
            )
        self.end_headers()
        self.wfile.write(raw)

    def redirect(self, loc):
        self.send_response(302)
        self.send_header("Location", loc)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def read_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        raw = self.rfile.read(n) if n else b"{}"
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError:
            return {}

    def require_user(self):
        sess = self.current_session()
        if not sess:
            self.send_json({"ok": False, "error": "Kirish talab qilinadi"}, 401)
            return None
        return sess

    def require_pro(self):
        sess = self.require_user()
        if not sess:
            return None
        if sess.get("role") != "admin_pro":
            self.send_json({"ok": False, "error": "Faqat Admin Pro"}, 403)
            return None
        return sess

    def is_public(self, path):
        if path in PUBLIC_PATHS:
            return True
        return any(path.startswith(p) for p in PUBLIC_PREFIX)

    def is_blocked(self, path):
        name = os.path.basename(path).lower()
        if name in BLOCKED_NAMES:
            return True
        ext = os.path.splitext(path)[1].lower()
        if ext in BLOCKED_EXT:
            return True
        if path.startswith("/data/") or path.startswith("/agent-transcripts"):
            return True
        return False

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path or "/"

        if path.startswith("/api/"):
            self.handle_api_get(path)
            return

        if path == "/gps-proxy":
            if not self.current_session():
                self.send_json({"ok": False, "error": "Kirish talab qilinadi"}, 401)
                return
            self.handle_gps_proxy(parsed)
            return

        if self.is_blocked(path):
            self.send_error(403, "Ruxsat yo'q")
            return

        sess = self.current_session()

        if path == "/login.html":
            if sess:
                self.redirect("/")
                return
            return super().do_GET()

        if path in ("/", "/index.html"):
            if not sess:
                self.redirect("/login.html")
                return
            if path == "/":
                self.path = "/index.html"
            return super().do_GET()

        if path == "/admin.html":
            if not sess:
                self.redirect("/login.html")
                return
            if sess.get("role") != "admin_pro":
                self.redirect("/")
                return
            return super().do_GET()

        if self.is_public(path):
            return super().do_GET()

        if not sess:
            if path.endswith((".html", "/")):
                self.redirect("/login.html")
            else:
                self.send_json({"ok": False, "error": "Kirish talab qilinadi"}, 401)
            return

        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path or "/"
        if path.startswith("/api/"):
            self.handle_api_post(path)
            return
        self.send_json({"ok": False, "error": "Not found"}, 404)

    def handle_api_get(self, path):
        if path == "/api/me":
            sess = self.require_user()
            if not sess:
                return
            self.send_json(
                {
                    "ok": True,
                    "user": {
                        "id": sess["user_id"],
                        "username": sess["username"],
                        "name": sess["name"],
                        "role": sess["role"],
                    },
                }
            )
            return
        if path == "/api/users":
            sess = self.require_pro()
            if not sess:
                return
            self.send_json({"ok": True, "users": STORE.list_users()})
            return
        if path == "/api/sessions":
            sess = self.require_pro()
            if not sess:
                return
            self.send_json({"ok": True, "sessions": STORE.list_sessions(), "me": sess["id"]})
            return
        if path == "/api/audit":
            sess = self.require_pro()
            if not sess:
                return
            self.send_json({"ok": True, "audit": STORE.audit()})
            return

        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        date = (qs.get("date") or [None])[0]

        if path == "/api/office/bootstrap":
            sess = self.require_user()
            if not sess:
                return
            self.send_json(
                {
                    "ok": True,
                    "pharmacies": OFFICE.pharmacies(),
                    "reviews": OFFICE.all_reviews(),
                    "reportDates": OFFICE.report_dates(),
                    "telegram": OFFICE.public_telegram(),
                }
            )
            return

        if path == "/api/office/report":
            sess = self.require_user()
            if not sess:
                return
            if not valid_date(date):
                self.send_json({"ok": False, "error": "Sana noto'g'ri"}, 400)
                return
            report = OFFICE.get_report(date)
            reviews = OFFICE.reviews(date)
            self.send_json({"ok": True, "report": report, "reviews": reviews})
            return

        self.send_json({"ok": False, "error": "Not found"}, 404)

    def handle_api_post(self, path):
        body = self.read_json()

        if path == "/api/login":
            sess, err = STORE.login(
                body.get("username"),
                body.get("password"),
                self.client_ip(),
                self.headers.get("User-Agent"),
            )
            if err:
                self.send_json({"ok": False, "error": err}, 401)
                return
            self.send_json(
                {
                    "ok": True,
                    "user": {
                        "id": sess["user_id"],
                        "username": sess["username"],
                        "name": sess["name"],
                        "role": sess["role"],
                    },
                    "redirect": "/",
                },
                set_cookie=sess["id"],
            )
            return

        if path == "/api/logout":
            STORE.logout(self.read_sid())
            self.send_json({"ok": True}, clear_cookie=True)
            return

        if path == "/api/ping":
            sess = self.require_user()
            if not sess:
                return
            self.send_json({"ok": True})
            return

        if path == "/api/password":
            sess = self.require_user()
            if not sess:
                return
            ok, err = STORE.change_own_password(
                sess["user_id"], body.get("old_password"), body.get("new_password")
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True})
            return

        if path == "/api/users/create":
            sess = self.require_pro()
            if not sess:
                return
            user, err = STORE.add_admin(
                sess["username"],
                body.get("name"),
                body.get("username"),
                body.get("password"),
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True, "user": user})
            return

        if path == "/api/users/toggle":
            sess = self.require_pro()
            if not sess:
                return
            user, err = STORE.set_active(
                sess["username"], body.get("id"), bool(body.get("active"))
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True, "user": user})
            return

        if path == "/api/users/delete":
            sess = self.require_pro()
            if not sess:
                return
            ok, err = STORE.delete_user(sess["username"], body.get("id"))
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True})
            return

        if path == "/api/users/reset":
            sess = self.require_pro()
            if not sess:
                return
            ok, err = STORE.reset_password(
                sess["username"], body.get("id"), body.get("password")
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True})
            return

        if path == "/api/sessions/kick":
            sess = self.require_pro()
            if not sess:
                return
            ok, err = STORE.kick(sess["username"], body.get("id"))
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True})
            return

        if path == "/api/office/pharmacies":
            sess = self.require_pro()
            if not sess:
                return
            items = OFFICE.save_pharmacies(body.get("pharmacies") or [])
            self.send_json({"ok": True, "pharmacies": items})
            return

        if path == "/api/office/reviews":
            sess = self.require_user()
            if not sess:
                return
            data, err = OFFICE.set_review(
                body.get("date"),
                body.get("key"),
                {
                    "status": body.get("status"),
                    "note": body.get("note"),
                    "by": sess.get("username"),
                },
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True, "reviews": data})
            return

        if path == "/api/office/report":
            sess = self.require_user()
            if not sess:
                return
            payload, err = OFFICE.save_report(
                body.get("date"), body.get("cars") or {}, sess.get("username")
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True, "savedAt": payload.get("savedAt")})
            return

        if path == "/api/office/telegram":
            sess = self.require_pro()
            if not sess:
                return
            pub = OFFICE.save_telegram(body)
            self.send_json({"ok": True, "telegram": pub})
            return

        if path == "/api/office/telegram/test":
            sess = self.require_pro()
            if not sess:
                return
            tg = OFFICE.settings()["telegram"]
            ok, err = telegram_send(
                tg.get("botToken"),
                tg.get("chatId"),
                "VAKSINA MED — Telegram ulanishi ishlayapti.",
            )
            if not ok:
                self.send_json({"ok": False, "error": err or "Yuborilmadi"}, 400)
                return
            self.send_json({"ok": True})
            return

        if path == "/api/office/telegram/digest":
            sess = self.require_user()
            if not sess:
                return
            tg = OFFICE.settings()["telegram"]
            if not (tg.get("enabled") and tg.get("botToken") and tg.get("chatId")):
                self.send_json({"ok": True, "skipped": True})
                return
            text = str(body.get("text") or "").strip()
            if not text:
                self.send_json({"ok": False, "error": "Matn yo'q"}, 400)
                return
            ok, err = telegram_send(tg.get("botToken"), tg.get("chatId"), text)
            if not ok:
                self.send_json({"ok": False, "error": err or "Yuborilmadi"}, 400)
                return
            self.send_json({"ok": True})
            return

        self.send_json({"ok": False, "error": "Not found"}, 404)

    def handle_gps_proxy(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        target_url = params.get("url", [None])[0]
        if not target_url:
            self.send_error(400, "url parametri ko'rsatilmagan")
            return

        parsed_target = urllib.parse.urlparse(target_url)
        host = parsed_target.netloc
        if host not in ALLOWED_GPS_HOSTS:
            if not (
                host.startswith("192.168.")
                or host.startswith("10.")
                or host == "localhost"
                or host.startswith("127.")
            ):
                self.send_error(403, f"Ruxsat etilmagan host: {host}")
                return

        try:
            req = urllib.request.Request(
                target_url,
                headers={
                    "User-Agent": "VaksinamedGPSMonitor/1.0",
                    "Accept": "application/json, text/plain, */*",
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read()
                content_type = resp.headers.get("Content-Type", "application/json")
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
        except urllib.error.HTTPError as e:
            error_msg = json.dumps(
                {
                    "error": e.code,
                    "message": f"GPS serveridan HTTP {e.code} xatosi: {e.reason}",
                }
            ).encode("utf-8")
            self.send_response(e.code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(error_msg)))
            self.end_headers()
            self.wfile.write(error_msg)
        except urllib.error.URLError as e:
            error_msg = json.dumps(
                {
                    "error": 503,
                    "message": f"GPS serveriga ulanib bo'lmadi: {str(e.reason)}",
                }
            ).encode("utf-8")
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(error_msg)))
            self.end_headers()
            self.wfile.write(error_msg)
        except Exception as e:
            error_msg = json.dumps(
                {"error": 500, "message": f"Server xatosi: {str(e)}"}
            ).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(error_msg)))
            self.end_headers()
            self.wfile.write(error_msg)


def main():
    global STORE, OFFICE
    parser = argparse.ArgumentParser(description="VaksinaMed GPS Monitor Server")
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--dir", type=str, default=DIRECTORY)
    args = parser.parse_args()
    if os.environ.get("PORT"):
        args.port = int(os.environ["PORT"])

    os.chdir(args.dir)
    STORE = AuthStore(args.dir)
    OFFICE = OfficeStore(args.dir)

    seed_note = ""
    if STORE.seeded:
        seed_note = f"""
  |  Admin Pro login : {SEED_USER:<22} |
  |  Parol           : {SEED_PASS:<22} |
  |  Parolni panelda o'zgartiring!     |"""

    print(f"""
  +==========================================+
  |   VaksinaMed Fleet Control — Server      |
  +==========================================+
  |  Manzil: http://localhost:{args.port:<14}  |
  |  Kirish: login + parol majburiy          |{seed_note}
  +==========================================+
  Toxtatish: Ctrl+C
""")

    class ReuseServer(ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True

    with ReuseServer(("", args.port), VaksinamedHandler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n\n  [OK] Server to'xtatildi.")
            sys.exit(0)


if __name__ == "__main__":
    main()
