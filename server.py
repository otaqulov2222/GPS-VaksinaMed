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
SEED_PASS = os.environ.get("VM_SEED_PASS", "AdminPro@2026")
SESSIONS_KEY = "auth:sessions"

PUBLIC_PATHS = {"/login.html", "/favicon.ico"}
PUBLIC_PREFIX = ("/fonts/", "/logo/")
BLOCKED_EXT = {".py", ".bat", ".md", ".txt"}
BLOCKED_NAMES = {"users.json", "server.py", "start.bat", "office-seed.json"}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
YEAR_RE = re.compile(r"^\d{4}$")


def as_num(v, default=0.0):
    try:
        x = float(str(v).replace(",", ".").strip() or default)
    except (TypeError, ValueError):
        return float(default)
    if x != x or abs(x) > 1e10:
        return float(default)
    return x

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


try:
    import psycopg
except ImportError:
    psycopg = None


def normalize_dsn(url):
    url = (url or "").strip()
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://") :]
    return url


class FilePersist:
    kind = "file"
    durable = False

    def __init__(self, root):
        self.root = os.path.join(root, "data", "kv")
        os.makedirs(self.root, exist_ok=True)
        self.lock = threading.Lock()

    def _path(self, key):
        if not re.match(r"^[A-Za-z0-9:._-]+$", key or ""):
            raise ValueError("Noto'g'ri kalit")
        return os.path.join(self.root, key.replace(":", "__") + ".json")

    def get(self, key, default=None):
        path = self._path(key)
        if not os.path.isfile(path):
            return default
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return default

    def put(self, key, value):
        path = self._path(key)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(value, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def keys(self, prefix=""):
        out = []
        with self.lock:
            for name in os.listdir(self.root):
                if not name.endswith(".json"):
                    continue
                key = name[:-5].replace("__", ":")
                if key.startswith(prefix):
                    out.append(key)
        return out


class PgPersist:
    kind = "postgres"
    durable = True

    def __init__(self, dsn):
        if psycopg is None:
            raise RuntimeError("psycopg o'rnatilmagan. pip install -r requirements.txt")
        self.dsn = normalize_dsn(dsn)
        self.lock = threading.Lock()
        self.conn = None
        self._connect()
        self._init()

    def _connect(self):
        if self.conn is not None:
            try:
                self.conn.close()
            except Exception:
                pass
        self.conn = psycopg.connect(self.dsn, autocommit=True, connect_timeout=15)

    def _init(self):
        with self.conn.cursor() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)"
            )

    def _with_conn(self, fn):
        with self.lock:
            try:
                return fn(self.conn)
            except Exception:
                self._connect()
                self._init()
                return fn(self.conn)

    def get(self, key, default=None):
        def run(conn):
            with conn.cursor() as cur:
                cur.execute("SELECT v FROM kv WHERE k = %s", (key,))
                row = cur.fetchone()
                if not row:
                    return default
                try:
                    return json.loads(row[0])
                except json.JSONDecodeError:
                    return default

        return self._with_conn(run)

    def put(self, key, value):
        raw = json.dumps(value, ensure_ascii=False)

        def run(conn):
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO kv (k, v) VALUES (%s, %s)
                    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v
                    """,
                    (key, raw),
                )

        self._with_conn(run)

    def keys(self, prefix=""):
        like = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"

        def run(conn):
            with conn.cursor() as cur:
                cur.execute("SELECT k FROM kv WHERE k LIKE %s ESCAPE '\\'", (like,))
                return [r[0] for r in cur.fetchall()]

        return self._with_conn(run)


def make_persist(root):
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if url:
        persist = PgPersist(url)
        users_file = os.path.join(root, "data", "users.json")
        if persist.get("users") is None and os.path.isfile(users_file):
            try:
                with open(users_file, "r", encoding="utf-8") as f:
                    persist.put("users", json.load(f))
                print("[OK] users.json bazaga ko'chirildi")
            except (OSError, json.JSONDecodeError):
                pass
        print("[OK] Saqlash: PostgreSQL — adminlar deploydan keyin qoladi")
        return persist
    print("[OK] Saqlash: lokal fayl (Render Free da yo'qoladi, DATABASE_URL qo'ying)")
    return FilePersist(root)


class AuthStore:
    def __init__(self, persist):
        self.persist = persist
        self.lock = threading.Lock()
        self.sessions = {}
        self.seeded = False
        self._load_sessions()
        self._ensure()

    def _load_sessions(self):
        raw = self.persist.get(SESSIONS_KEY, {})
        if not isinstance(raw, dict):
            raw = {}
        t = now_ts()
        cleaned = {}
        for sid, sess in raw.items():
            if not isinstance(sess, dict):
                continue
            if t - int(sess.get("last_seen") or 0) <= SESSION_TTL:
                cleaned[sid] = sess
        self.sessions = cleaned
        if len(cleaned) != len(raw):
            self._save_sessions()

    def _save_sessions(self):
        try:
            self.persist.put(SESSIONS_KEY, self.sessions)
        except Exception as e:
            print("[WARN] Sessiya saqlanmadi:", e)

    def persist_info(self):
        return {"kind": self.persist.kind, "durable": bool(self.persist.durable)}

    def _ensure(self):
        if self.persist.get("users") is not None:
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
        data = self.persist.get("users")
        if not isinstance(data, dict):
            return {"users": [], "audit": []}
        data.setdefault("users", [])
        data.setdefault("audit", [])
        return data

    def _write(self, data):
        self.persist.put("users", data)

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
            self._save_sessions()
            user["last_login"] = iso_now()
            self._audit(data, "login_ok", user["username"], ip)
            self._write(data)
            return sess, None

    def logout(self, sid):
        with self.lock:
            self.sessions.pop(sid, None)
            self._save_sessions()

    def get_session(self, sid):
        if not sid:
            return None
        with self.lock:
            sess = self.sessions.get(sid)
            if not sess:
                return None
            if now_ts() - sess["last_seen"] > SESSION_TTL:
                self.sessions.pop(sid, None)
                self._save_sessions()
                return None
            sess["last_seen"] = now_ts()
            self._save_sessions()
            data = self._read()
            user = self.find_user(data, uid=sess["user_id"])
            if not user or not user.get("active", True):
                self.sessions.pop(sid, None)
                self._save_sessions()
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
                self._save_sessions()
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
            self._save_sessions()
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
            self._save_sessions()
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
            self._save_sessions()
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
    def __init__(self, persist, seed_path):
        self.persist = persist
        self.seed_path = seed_path
        self.lock = threading.Lock()
        self._ensure_pharmacies()
        self._ensure_settings()

    def _load(self, key, default):
        v = self.persist.get(key)
        return default if v is None else v

    def _save(self, key, obj):
        self.persist.put(key, obj)

    def _read_seed(self):
        if not os.path.isfile(self.seed_path):
            return {}
        try:
            with open(self.seed_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return {}

    def _ensure_pharmacies(self):
        if self.persist.get("office:pharmacies") is not None:
            return
        seed = self._read_seed()
        items = seed.get("pharmacies") if isinstance(seed, dict) else []
        cleaned = [c for c in (clean_pharmacy(p) for p in items or []) if c]
        self._save("office:pharmacies", {"pharmacies": cleaned})

    def _ensure_settings(self):
        if self.persist.get("office:settings") is not None:
            return
        self._save(
            "office:settings",
            {"telegram": {"botToken": "", "chatId": "", "enabled": False}},
        )

    def pharmacies(self):
        with self.lock:
            data = self._load("office:pharmacies", {})
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
            self._save("office:pharmacies", {"pharmacies": unique})
        return unique

    def reviews(self, date):
        if not valid_date(date):
            return {}
        with self.lock:
            data = self._load("office:reviews:" + date, {})
            return data if isinstance(data, dict) else {}

    def all_reviews(self):
        out = {}
        with self.lock:
            for key in self.persist.keys("office:reviews:"):
                date = key.split(":")[-1]
                if not valid_date(date):
                    continue
                data = self._load(key, {})
                if isinstance(data, dict) and data:
                    out[date] = data
        return out

    def set_review(self, date, key, rec):
        if not valid_date(date) or not key:
            return None, "Sana yoki kalit noto'g'ri"
        key = str(key)[:180]
        with self.lock:
            store_key = "office:reviews:" + date
            data = self._load(store_key, {})
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
            self._save(store_key, data)
            return data, None

    def report_dates(self):
        dates = []
        with self.lock:
            for key in self.persist.keys("office:report:"):
                date = key.split(":")[-1]
                if valid_date(date):
                    dates.append(date)
        dates.sort(reverse=True)
        return dates

    def get_report(self, date):
        if not valid_date(date):
            return None
        with self.lock:
            data = self._load("office:report:" + date, None)
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
            self._save("office:report:" + date, payload)
        return payload, None

    def settings(self):
        with self.lock:
            data = self._load("office:settings", {})
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
            data = self._load("office:settings", {})
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
            self._save("office:settings", data)
        return self.public_telegram()

    def fuel_meta(self):
        data = self._load("fuel:meta", {})
        if not isinstance(data, dict):
            data = {}
        data.setdefault("vehicles", {})
        data.setdefault("stations", [])
        data.setdefault("docs", {})
        data.setdefault(
            "firm",
            {
                "name": "VAKSINA HEALTHCARE MChJ",
                "director": "",
                "mechanic": "",
            },
        )
        if isinstance(data.get("docs"), list):
            data["docs"] = {}
        return data

    def save_fuel_meta(self, body):
        cur = self.fuel_meta()
        if isinstance(body.get("vehicles"), dict):
            vehicles = {}
            for i, (plate, rec) in enumerate(body["vehicles"].items()):
                if i >= 50:
                    break
                p = str(plate).strip()[:24]
                if not p or not isinstance(rec, dict):
                    continue
                ft = str(rec.get("fuelType") or "mixed")[:12]
                if ft not in ("mixed", "gaz", "benzin", "dizel"):
                    ft = "mixed"
                vehicles[p] = {
                    "name": str(rec.get("name") or "")[:80],
                    "short": str(rec.get("short") or "")[:40],
                    "brand": str(rec.get("brand") or "")[:40],
                    "card": str(rec.get("card") or "")[:40],
                    "fuelType": ft,
                    "gasNorm": as_num(rec.get("gasNorm"), 12),
                    "benzinNorm": as_num(rec.get("benzinNorm"), 4),
                    "gasPrice": as_num(rec.get("gasPrice"), 5200),
                    "benzinPrice": as_num(rec.get("benzinPrice"), 11000),
                    "hidden": bool(rec.get("hidden")),
                }
            cur["vehicles"] = vehicles
        if isinstance(body.get("stations"), list):
            cur["stations"] = [str(s).strip()[:80] for s in body["stations"] if str(s).strip()][:80]
        if isinstance(body.get("firm"), dict):
            cur["firm"] = {
                "name": str(body["firm"].get("name") or "VAKSINA HEALTHCARE MChJ")[:80],
                "director": str(body["firm"].get("director") or "")[:80],
                "mechanic": str(body["firm"].get("mechanic") or "")[:80],
            }
        if isinstance(body.get("docs"), dict):
            docs = {}
            for i, (plate, rec) in enumerate(body["docs"].items()):
                if i >= 50 or not isinstance(rec, dict):
                    continue
                item = {}
                for key in ("insurance", "tech", "ads", "cylinder"):
                    d = rec.get(key) if isinstance(rec.get(key), dict) else {}
                    months = int(as_num(d.get("months"), 12))
                    if months < 1:
                        months = 1
                    if months > 60:
                        months = 60
                    item[key] = {
                        "due": str(d.get("due") or "")[:10],
                        "months": months,
                    }
                docs[str(plate).strip()[:24]] = item
            cur["docs"] = docs
        self._save("fuel:meta", cur)
        return cur

    def fuel_month(self, month):
        if not month or not MONTH_RE.match(str(month)):
            return None
        data = self._load("fuel:month:" + month, {})
        if not isinstance(data, dict):
            data = {}
        data.setdefault("cars", {})
        return data

    def _plate_compact(self, plate):
        return re.sub(r"\s+", "", str(plate or "").upper())

    def _existing_plate_key(self, existing, plate):
        if plate in existing:
            return plate
        compact = self._plate_compact(plate)
        for key in existing:
            if self._plate_compact(key) == compact:
                return key
        return plate

    def save_fuel_month(self, month, body):
        if not month or not MONTH_RE.match(str(month)):
            return None, "Oy noto'g'ri"
        cars_in = (body or {}).get("cars")
        if not isinstance(cars_in, dict):
            return None, "Ma'lumot noto'g'ri"
        cur = self.fuel_month(month) or {}
        cars = dict(cur.get("cars") or {}) if isinstance(cur.get("cars"), dict) else {}
        for i, (car, rec) in enumerate(cars_in.items()):
            if i >= 50:
                break
            plate = str(car).strip()[:24]
            if not plate or not isinstance(rec, dict):
                continue
            days_in = rec.get("days") if isinstance(rec.get("days"), dict) else {}
            days = {}
            for d, row in days_in.items():
                try:
                    di = int(d)
                except (TypeError, ValueError):
                    continue
                if di < 1 or di > 31 or not isinstance(row, dict):
                    continue
                mode = str(row.get("mode") or "gaz")[:12]
                if mode not in ("gaz", "benzin", "aralash", "dizel"):
                    mode = "gaz"
                days[str(di)] = {
                    "km": as_num(row.get("km")),
                    "odo": as_num(row.get("odo")),
                    "mode": mode,
                    "station": str(row.get("station") or "")[:80],
                    "gasIn": as_num(row.get("gasIn")),
                    "gasPrice": as_num(row.get("gasPrice")),
                    "benzinIn": as_num(row.get("benzinIn")),
                    "benzinPrice": as_num(row.get("benzinPrice")),
                    "extra": as_num(row.get("extra")),
                    "extraWhy": str(row.get("extraWhy") or "")[:80],
                    "note": str(row.get("note") or "")[:120],
                    "kmSrc": str(row.get("kmSrc") or "")[:8],
                }
            changes = []
            raw_ch = rec.get("changes") if isinstance(rec.get("changes"), list) else []
            for ch in raw_ch[:40]:
                if not isinstance(ch, dict):
                    continue
                try:
                    day = int(ch.get("day") or 0)
                except (TypeError, ValueError):
                    day = 0
                if day < 1 or day > 31:
                    continue
                changes.append(
                    {
                        "day": day,
                        "field": str(ch.get("field") or "")[:24],
                        "value": as_num(ch.get("value")),
                        "note": str(ch.get("note") or "")[:80],
                    }
                )
            dch = []
            for ch in (rec.get("driverChanges") or [])[:12]:
                if not isinstance(ch, dict):
                    continue
                try:
                    dday = int(ch.get("day") or 0)
                except (TypeError, ValueError):
                    dday = 0
                if dday < 1 or dday > 31:
                    continue
                dch.append({"day": dday, "name": str(ch.get("name") or "")[:80]})
            ft = str(rec.get("fuelType") or "mixed")[:12]
            if ft not in ("mixed", "gaz", "benzin", "dizel"):
                ft = "mixed"
            plate = self._existing_plate_key(cars, plate)
            old = cars.get(plate) if isinstance(cars.get(plate), dict) else {}
            old_days = old.get("days") if isinstance(old.get("days"), dict) else {}
            merged_days = dict(old_days)
            merged_days.update(days)
            old_changes = old.get("changes") if isinstance(old.get("changes"), list) else []
            old_dch = old.get("driverChanges") if isinstance(old.get("driverChanges"), list) else []
            cars[plate] = {
                "gasNorm": as_num(rec.get("gasNorm"), old.get("gasNorm", 12)),
                "benzinNorm": as_num(rec.get("benzinNorm"), old.get("benzinNorm", 4)),
                "odoStart": as_num(rec.get("odoStart"), old.get("odoStart", 0)),
                "gasStart": as_num(rec.get("gasStart"), old.get("gasStart", 0)),
                "benzinStart": as_num(rec.get("benzinStart"), old.get("benzinStart", 0)),
                "gasPrice": as_num(rec.get("gasPrice"), old.get("gasPrice", 5200)),
                "benzinPrice": as_num(rec.get("benzinPrice"), old.get("benzinPrice", 11000)),
                "mixPct": as_num(rec.get("mixPct"), old.get("mixPct", 70)),
                "fuelType": ft,
                "changes": changes or old_changes,
                "driverChanges": dch or old_dch,
                "days": merged_days,
            }
        payload = {"month": month, "savedAt": iso_now(), "cars": cars}
        self._save("fuel:month:" + month, payload)
        return payload, None

    def fuel_year(self, year):
        if not year or not YEAR_RE.match(str(year)):
            return None
        out = {}
        for m in range(1, 13):
            month = "%s-%02d" % (year, m)
            data = self._load("fuel:month:" + month, None)
            if isinstance(data, dict) and data.get("cars"):
                out[month] = data
        return out

    def gps_km_month(self, month):
        if not month or not MONTH_RE.match(str(month)):
            return {}
        out = {}
        for key in self.persist.keys("office:report:"):
            date = key.split(":")[-1]
            if not date.startswith(month + "-"):
                continue
            rep = self.get_report(date)
            cars = (rep or {}).get("cars") if isinstance(rep, dict) else None
            if not isinstance(cars, dict):
                continue
            day = {}
            for car, rec in cars.items():
                stats = (rec or {}).get("stats") if isinstance(rec, dict) else {}
                km = (stats or {}).get("probeg")
                try:
                    km = float(km)
                except (TypeError, ValueError):
                    continue
                if km > 0:
                    day[str(car)] = round(km, 2)
            if day:
                out[date] = day
        return out

    def gps_totals_month(self, month):
        days = self.gps_km_month(month)
        totals = {}
        for _date, cars in days.items():
            if not isinstance(cars, dict):
                continue
            for plate, km in cars.items():
                rec = totals.setdefault(str(plate), {"km": 0, "days": 0})
                rec["km"] = round(rec["km"] + float(km or 0), 2)
                rec["days"] += 1
        return {"days": days, "totals": totals}

    def journal_items(self):
        data = self._load("journal:entries", {})
        items = data.get("items") if isinstance(data, dict) else []
        if not isinstance(items, list):
            items = []
        return items

    def _clean_journal_entry(self, body, user=""):
        if not isinstance(body, dict):
            return None, "Ma'lumot noto'g'ri"
        kind = "good" if str(body.get("kind") or "") == "good" else "bad"
        cat = "pharmacy" if str(body.get("category") or "") == "pharmacy" else "driver"
        start = str(body.get("start") or "")[:19].replace(" ", "T")
        end = str(body.get("end") or "")[:19].replace(" ", "T")
        if start and not re.match(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?", start):
            return None, "Sana noto'g'ri"
        if end and not re.match(r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?", end):
            end = ""
        eid = str(body.get("id") or new_id("jr"))[:40]
        level = str(body.get("level") or "orta")[:12]
        if level not in ("past", "orta", "yuqori"):
            level = "orta"
        return {
            "id": eid,
            "kind": kind,
            "category": cat,
            "car": str(body.get("car") or "")[:24],
            "driver": str(body.get("driver") or "")[:80],
            "pharmacy": str(body.get("pharmacy") or "")[:80],
            "reason": str(body.get("reason") or "")[:60],
            "level": level,
            "start": start,
            "end": end,
            "note": str(body.get("note") or "")[:400],
            "createdBy": str(body.get("createdBy") or user or "")[:40],
            "createdAt": str(body.get("createdAt") or iso_now())[:19],
            "updatedAt": iso_now(),
        }, None

    def upsert_journal(self, body, user=""):
        entry, err = self._clean_journal_entry(body, user)
        if err:
            return None, err
        if entry["category"] == "driver" and not entry["car"]:
            return None, "Mashina raqami majburiy"
        items = self.journal_items()
        found = False
        for i, it in enumerate(items):
            if isinstance(it, dict) and it.get("id") == entry["id"]:
                entry["createdAt"] = it.get("createdAt") or entry["createdAt"]
                entry["createdBy"] = it.get("createdBy") or entry["createdBy"]
                items[i] = entry
                found = True
                break
        if not found:
            items.append(entry)
        if len(items) > 1500:
            items = items[-1500:]
        self._save("journal:entries", {"items": items, "savedAt": iso_now()})
        return entry, None

    def delete_journal(self, eid):
        eid = str(eid or "").strip()[:40]
        if not eid:
            return False, "ID yo'q"
        items = [it for it in self.journal_items() if not (isinstance(it, dict) and it.get("id") == eid)]
        self._save("journal:entries", {"items": items, "savedAt": iso_now()})
        return True, None


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

        if path in ("/", "/index.html", "/fuel.html"):
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
                    "persist": STORE.persist_info(),
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
        month = (qs.get("month") or [None])[0]
        year = (qs.get("year") or [None])[0]

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
                    "persist": STORE.persist_info(),
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

        if path == "/api/office/fuel/meta":
            sess = self.require_user()
            if not sess:
                return
            self.send_json({"ok": True, "meta": OFFICE.fuel_meta()})
            return

        if path == "/api/office/fuel/month":
            sess = self.require_user()
            if not sess:
                return
            data = OFFICE.fuel_month(month)
            if data is None:
                self.send_json({"ok": False, "error": "Oy noto'g'ri"}, 400)
                return
            self.send_json({"ok": True, "month": month, "data": data})
            return

        if path == "/api/office/fuel/gps-km":
            sess = self.require_user()
            if not sess:
                return
            if not month or not MONTH_RE.match(str(month)):
                self.send_json({"ok": False, "error": "Oy noto'g'ri"}, 400)
                return
            self.send_json({"ok": True, "days": OFFICE.gps_km_month(month)})
            return

        if path == "/api/office/fuel/year":
            sess = self.require_user()
            if not sess:
                return
            data = OFFICE.fuel_year(year)
            if data is None:
                self.send_json({"ok": False, "error": "Yil noto'g'ri"}, 400)
                return
            self.send_json({"ok": True, "year": str(year), "months": data})
            return

        if path == "/api/office/journal":
            sess = self.require_user()
            if not sess:
                return
            gps = {}
            if month and MONTH_RE.match(str(month)):
                gps = OFFICE.gps_totals_month(month)
            self.send_json(
                {
                    "ok": True,
                    "items": OFFICE.journal_items(),
                    "pharmacies": OFFICE.pharmacies(),
                    "gps": gps,
                }
            )
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

        if path == "/api/office/fuel/meta":
            sess = self.require_user()
            if not sess:
                return
            meta = OFFICE.save_fuel_meta(body)
            self.send_json({"ok": True, "meta": meta})
            return

        if path == "/api/office/fuel/month":
            sess = self.require_user()
            if not sess:
                return
            payload, err = OFFICE.save_fuel_month(body.get("month"), body)
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True, "savedAt": payload.get("savedAt")})
            return

        if path == "/api/office/journal":
            sess = self.require_user()
            if not sess:
                return
            if body.get("deleteId"):
                ok, err = OFFICE.delete_journal(body.get("deleteId"))
                if err:
                    self.send_json({"ok": False, "error": err}, 400)
                    return
                self.send_json({"ok": True, "items": OFFICE.journal_items()})
                return
            entry, err = OFFICE.upsert_journal(body.get("entry") or body, sess.get("username"))
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True, "entry": entry, "items": OFFICE.journal_items()})
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
    persist = make_persist(args.dir)
    STORE = AuthStore(persist)
    OFFICE = OfficeStore(persist, os.path.join(args.dir, "office-seed.json"))

    seed_note = ""
    if STORE.seeded:
        seed_note = f"""
  |  Admin Pro login : {SEED_USER:<22} |
  |  Parol           : {SEED_PASS:<22} |
  |  Parolni panelda o'zgartiring!     |"""

    persist_line = "PostgreSQL (qoladi)" if persist.durable else "lokal fayl (Render da yo'qoladi)"

    print(f"""
  +==========================================+
  |   VaksinaMed Fleet Control — Server      |
  +==========================================+
  |  Manzil: http://localhost:{args.port:<14}  |
  |  Kirish: login + parol majburiy          |
  |  Saqlash: {persist_line:<29} |{seed_note}
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
