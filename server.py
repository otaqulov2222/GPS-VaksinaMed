#!/usr/bin/env python3
"""
VaksinaMed GPS Monitor — HTTP server
Auth (Admin Pro / Admin / Haydovchi) + GPS proxy + statik fayllar
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
BLOCKED_EXT = {".py", ".bat", ".md", ".txt", ".env"}
BLOCKED_NAMES = {
    "users.json",
    "server.py",
    "start.bat",
    "office-seed.json",
    ".env",
    ".env.example",
    "requirements.txt",
    "runtime.txt",
    "procfile",
    "render.yaml",
    "gps_sync.py",
    "hr_api.py",
    "hr-api.md",
}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")
YEAR_RE = re.compile(r"^\d{4}$")
STAFF_ROLES = ("admin_pro", "admin")


def is_staff(sess):
    return bool(sess) and sess.get("role") in STAFF_ROLES


def is_driver(sess):
    return bool(sess) and sess.get("role") == "driver"


def compact_plate(plate):
    return re.sub(r"\s+", "", str(plate or "").upper())


def find_by_plate(mapping, plate):
    if not isinstance(mapping, dict):
        return None, None
    if plate in mapping:
        return plate, mapping[plate]
    want = compact_plate(plate)
    if not want:
        return None, None
    for k, v in mapping.items():
        if compact_plate(k) == want:
            return k, v
    return None, None


def home_for(sess):
    if is_driver(sess):
        return "/driver.html"
    return "/"


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
    # Render’da deploydan keyin ham qoladigan disk (volume) bo‘lsa, uni shu yerga ulab qo‘ying.
    # Agar PERSIST_DIR berilmasa, eski holatdagi workspace ichidagi lokal fayl ishlaydi.
    persist_root = (os.environ.get("PERSIST_DIR") or "").strip() or root
    return FilePersist(persist_root)


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
        if self.persist.get("users") is None:
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
            return
        # Eski password_plain maydonlarini bir marta tozalash
        data = self._read()
        if self._strip_plaintext_passwords(data):
            self._write(data)

    @staticmethod
    def _strip_plaintext_passwords(data):
        changed = False
        for u in data.get("users") or []:
            if not isinstance(u, dict):
                continue
            if "password_plain" in u:
                u.pop("password_plain", None)
                changed = True
        return changed

    def _read(self):
        data = self.persist.get("users")
        if not isinstance(data, dict):
            return {"users": [], "audit": []}
        data.setdefault("users", [])
        data.setdefault("audit", [])
        return data

    def _write(self, data):
        self._strip_plaintext_passwords(data)
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
            "car": u.get("car") or "",
            "active": bool(u.get("active", True)),
            "protected": bool(u.get("protected")),
            "created_at": u.get("created_at"),
            "last_login": u.get("last_login"),
            "hasPassword": bool(u.get("password_hash")),
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
                "car": user.get("car") or "",
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
            sess["car"] = user.get("car") or ""
            return sess

    def list_users(self):
        with self.lock:
            data = self._read()
            return [self.public_user(u) for u in data.get("users", [])]

    def can_manage(self, actor_role, target):
        if not target:
            return False
        if target.get("protected") or target.get("role") == "admin_pro":
            return False
        if target.get("role") == "admin":
            return actor_role == "admin_pro"
        if target.get("role") == "driver":
            return actor_role in STAFF_ROLES
        return actor_role == "admin_pro"

    def add_admin(self, actor, name, username, password):
        return self.add_user(actor, name, username, password, role="admin", car="")

    def add_user(self, actor, name, username, password, role="admin", car=""):
        username = (username or "").strip().lower()
        name = (name or "").strip()
        password = password or ""
        role = (role or "admin").strip()
        car = str(car or "").strip()[:24]
        if role not in ("admin", "driver"):
            return None, "Rol noto'g'ri"
        if not username or len(username) < 3:
            return None, "Login kamida 3 belgi bo'lsin"
        if not all(c.isalnum() or c in "._-" for c in username):
            return None, "Login: faqat harf, raqam, . _ -"
        if len(password) < 6:
            return None, "Parol kamida 6 belgi bo'lsin"
        if role == "driver" and not car:
            return None, "Haydovchiga mashina biriktiring"
        if not name:
            name = username
        with self.lock:
            data = self._read()
            if self.find_user(data, username=username):
                return None, "Bu login band"
            if role == "driver":
                want = compact_plate(car)
                for u in data.get("users", []):
                    if u.get("role") == "driver" and compact_plate(u.get("car")) == want:
                        return None, "Bu mashinaga allaqachon login berilgan"
            salt, pw_hash = hash_pw(password)
            user = {
                "id": new_id("u"),
                "username": username,
                "name": name,
                "role": role,
                "car": car if role == "driver" else "",
                "password_salt": salt,
                "password_hash": pw_hash,
                "active": True,
                "protected": False,
                "created_at": iso_now(),
                "last_login": None,
            }
            data["users"].append(user)
            self._audit(data, "user_add", actor, "%s (%s)" % (username, role))
            self._write(data)
            return self.public_user(user), None

    def set_active(self, actor, uid, active, actor_role="admin_pro"):
        with self.lock:
            data = self._read()
            user = self.find_user(data, uid=uid)
            if not user:
                return None, "Foydalanuvchi topilmadi"
            if not self.can_manage(actor_role, user):
                return None, "Ruxsat yo'q"
            user["active"] = bool(active)
            if not active:
                for sid, s in list(self.sessions.items()):
                    if s["user_id"] == uid:
                        self.sessions.pop(sid, None)
                self._save_sessions()
            self._audit(data, "user_toggle", actor, f"{user['username']} active={user['active']}")
            self._write(data)
            return self.public_user(user), None

    def delete_user(self, actor, uid, actor_role="admin_pro"):
        with self.lock:
            data = self._read()
            user = self.find_user(data, uid=uid)
            if not user:
                return None, "Foydalanuvchi topilmadi"
            if not self.can_manage(actor_role, user):
                return None, "Ruxsat yo'q"
            data["users"] = [u for u in data["users"] if u["id"] != uid]
            for sid, s in list(self.sessions.items()):
                if s["user_id"] == uid:
                    self.sessions.pop(sid, None)
            self._save_sessions()
            self._audit(data, "user_del", actor, user["username"])
            self._write(data)
            return True, None

    def reset_password(self, actor, uid, new_password, actor_role="admin_pro"):
        if len(new_password or "") < 6:
            return None, "Parol kamida 6 belgi bo'lsin"
        with self.lock:
            data = self._read()
            user = self.find_user(data, uid=uid)
            if not user:
                return None, "Foydalanuvchi topilmadi"
            if actor_role != "admin_pro" and not self.can_manage(actor_role, user):
                return None, "Ruxsat yo'q"
            salt, pw_hash = hash_pw(new_password)
            user["password_salt"] = salt
            user["password_hash"] = pw_hash
            user.pop("password_plain", None)
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
            user.pop("password_plain", None)
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
                        "car": s.get("car") or "",
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
                entry = {
                    "status": status,
                    "note": str((rec or {}).get("note") or "")[:200],
                    "by": str((rec or {}).get("by") or "")[:40],
                    "at": iso_now(),
                }
                ph_name = str((rec or {}).get("phName") or "")[:80].strip()
                if ph_name:
                    entry["phName"] = ph_name
                car = str((rec or {}).get("car") or "")[:32].strip()
                if car:
                    entry["car"] = car
                lat = (rec or {}).get("lat")
                lng = (rec or {}).get("lng")
                if lat is not None and lng is not None:
                    try:
                        entry["lat"] = float(lat)
                        entry["lng"] = float(lng)
                    except (TypeError, ValueError):
                        pass
                data[key] = entry
            else:
                data.pop(key, None)
            self._save(store_key, data)
            return data, None

    def learn_and_reprocess(self, base_dir, date=None):
        import gps_sync

        learned = gps_sync.learn_geozones_from_reports(self, base_dir)
        if date and valid_date(date):
            days = 1 if gps_sync.reprocess_day(self, base_dir, date) else 0
        else:
            days = gps_sync.reprocess_recent(self, base_dir)
        return {"learned": learned, "days": days}

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

    def pharmacy_place_suggestions(self, limit_days=60):
        """GPS hisobotlaridagi to'xtash joylari: nom + o'rtacha koordinata + eng ko'p kelgan mashina."""
        dates = self.report_dates()[: max(1, min(int(limit_days or 60), 120))]
        bag = {}
        for date in dates:
            rep = self.get_report(date)
            cars = (rep or {}).get("cars") if isinstance(rep, dict) else None
            if not isinstance(cars, dict):
                continue
            for plate, rec in cars.items():
                if not isinstance(rec, dict):
                    continue
                stops = rec.get("stops") if isinstance(rec.get("stops"), list) else []
                for st in stops:
                    if not isinstance(st, dict):
                        continue
                    place = str(st.get("phName") or st.get("place") or "").strip()
                    if not place or len(place) < 3:
                        continue
                    if place.replace(".", "").replace(",", "").replace(" ", "").replace("-", "").isdigit():
                        continue
                    if "," in place and all(
                        part.strip().replace(".", "", 1).replace("-", "", 1).isdigit()
                        for part in place.split(",", 1)
                    ):
                        continue
                    key = place.lower()
                    item = bag.get(key)
                    if not item:
                        item = {
                            "name": place[:80],
                            "count": 0,
                            "cars": {},
                            "lat_sum": 0.0,
                            "lng_sum": 0.0,
                            "coord_n": 0,
                        }
                        bag[key] = item
                    item["count"] += 1
                    car = str(plate or "")[:24]
                    if car:
                        item["cars"][car] = item["cars"].get(car, 0) + 1
                    try:
                        lat = float(st.get("lat") or 0)
                        lng = float(st.get("lng") or 0)
                    except (TypeError, ValueError):
                        lat = lng = 0.0
                    if abs(lat) > 0.1 and abs(lng) > 0.1:
                        item["lat_sum"] += lat
                        item["lng_sum"] += lng
                        item["coord_n"] += 1
        known_map = {}
        for p in self.pharmacies() or []:
            if not isinstance(p, dict) or not p.get("name"):
                continue
            known_map[str(p.get("name") or "").strip().lower()] = str(p.get("car") or "")
        out = []
        for item in bag.values():
            top_car = ""
            if item["cars"]:
                top_car = max(item["cars"].items(), key=lambda x: x[1])[0]
            lat = lng = None
            if item["coord_n"] > 0:
                lat = round(item["lat_sum"] / item["coord_n"], 6)
                lng = round(item["lng_sum"] / item["coord_n"], 6)
            name_key = item["name"].lower()
            out.append(
                {
                    "name": item["name"],
                    "count": item["count"],
                    "topCar": top_car,
                    "lat": lat,
                    "lng": lng,
                    "assigned": name_key in known_map,
                    "assignedCar": known_map.get(name_key) or "",
                }
            )
        out.sort(key=lambda x: (-x["count"], x["name"].lower()))
        return out[:400]

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

    def gps_config_internal(self):
        with self.lock:
            data = self._load("office:gps:config", {})
            if not isinstance(data, dict):
                data = {}
            token = str(data.get("token") or "")
            user = str(data.get("user") or "")
            host = str(data.get("host") or "http://bms1.gpsavto.uz")
            return {
                "configured": bool(
                    host
                    and (
                        bool(token)
                        or (bool(user) and bool(str(data.get("password") or "").strip()))
                    )
                ),
                "host": host,
                "token": token,
                "user": user,
                "password": str(data.get("password") or ""),
            }

    def gps_config_public(self):
        cfg = self.gps_config_internal()
        return {
            "configured": cfg["configured"],
            "host": cfg["host"],
            "user": cfg["user"],
            "hasToken": bool(cfg.get("token")),
            "hasPassword": bool(cfg.get("password")),
        }

    def save_gps_config(self, body, saved_by=""):
        body = body or {}
        host = str(body.get("host") or "http://bms1.gpsavto.uz").strip()[:120]
        token = re.sub(r"\s+", "", str(body.get("token") or "")).strip()[:800]
        user = str(body.get("user") or "").strip()[:80]
        password = str(body.get("password") or "").strip()[:120]
        with self.lock:
            cur = self._load("office:gps:config", {})
            if not isinstance(cur, dict):
                cur = {}
            if not token and cur.get("token"):
                token = str(cur.get("token") or "")
            if not password and cur.get("password"):
                password = str(cur.get("password") or "")
            payload = {
                "host": host,
                "token": token,
                "user": user,
                "password": password,
                "savedAt": iso_now(),
                "savedBy": str(saved_by or "")[:40],
            }
            self._save("office:gps:config", payload)
        return self.gps_config_public()

    def gps_status_public(self):
        with self.lock:
            st = self._load("office:gps:status", {})
            if not isinstance(st, dict):
                st = {}
        cfg = self.gps_config_internal()
        running = bool(st.get("running"))
        started = int(st.get("runningSinceTs") or 0)
        if running and started and (time.time() - started) > 20 * 60:
            running = False
        return {
            "configured": cfg["configured"],
            "lastSync": st.get("lastSync") or "",
            "running": running,
            "cars": int(st.get("cars") or 0),
            "error": str(st.get("error") or "")[:200],
            "autoIntervalSec": int(os.environ.get("GPS_SYNC_INTERVAL", "300")),
            "syncDate": str(st.get("syncDate") or ""),
            "lastDate": str(st.get("lastDate") or ""),
            "message": str(st.get("message") or "")[:180],
            "lastJobId": int(st.get("lastJobId") or 0),
            "currentJobId": int(st.get("currentJobId") or 0),
        }

    def set_gps_status(self, running=False, cars=0, error="", date="", message="", job_id=None):
        with self.lock:
            st = self._load("office:gps:status", {})
            if not isinstance(st, dict):
                st = {}
            st["running"] = bool(running)
            if date:
                st["syncDate"] = str(date)[:12]
            if message != "":
                st["message"] = str(message)[:180]
            if job_id is not None:
                st["currentJobId"] = int(job_id)
            if running:
                st["runningSinceTs"] = int(time.time())
                st["error"] = ""
                if cars:
                    st["cars"] = int(cars)
                self._save("office:gps:status", st)
                return
            if error:
                st["error"] = str(error)[:200]
            else:
                st["error"] = ""
            st["cars"] = int(cars or st.get("cars") or 0)
            st["lastSync"] = iso_now()
            st["lastDate"] = str(date or st.get("syncDate") or "")[:12]
            if job_id is not None:
                st["lastJobId"] = int(job_id)
                st["currentJobId"] = int(job_id)
            self._save("office:gps:status", st)

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
                if i >= 80:
                    break
                p = str(plate).strip()[:24]
                if not p or not isinstance(rec, dict):
                    continue
                ft = str(rec.get("fuelType") or "mixed")[:12]
                if ft not in ("mixed", "gaz", "benzin", "dizel", "dizel_gaz"):
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
        try:
            import gps_sync

            def _reprocess_fuel_meta():
                try:
                    gps_sync.reprocess_recent(
                        self, os.path.dirname(os.path.abspath(self.seed_path)), limit=14
                    )
                except Exception:
                    pass

            threading.Thread(target=_reprocess_fuel_meta, daemon=True).start()
        except Exception:
            pass
        return cur

    def fuel_month(self, month):
        if not month or not MONTH_RE.match(str(month)):
            return None
        data = self._load("fuel:month:" + month, {})
        if not isinstance(data, dict):
            data = {}
        data.setdefault("cars", {})
        data["cars"] = self._dedupe_cars(data.get("cars"))
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

    def _dedupe_cars(self, cars):
        if not isinstance(cars, dict):
            return {}
        out = {}
        for k, v in cars.items():
            if not isinstance(v, dict):
                continue
            canon = self._existing_plate_key(out, str(k).strip()[:24])
            if canon in out:
                old = out[canon]
                old_days = old.get("days") if isinstance(old.get("days"), dict) else {}
                new_days = v.get("days") if isinstance(v.get("days"), dict) else {}
                merged = dict(old_days)
                merged.update(new_days)
                out[canon] = dict(old)
                out[canon].update(v)
                out[canon]["days"] = merged
            else:
                out[canon] = v
        return out

    def save_fuel_month(self, month, body):
        if not month or not MONTH_RE.match(str(month)):
            return None, "Oy noto'g'ri"
        cars_in = (body or {}).get("cars")
        if not isinstance(cars_in, dict):
            return None, "Ma'lumot noto'g'ri"
        cur = self.fuel_month(month) or {}
        cars = dict(cur.get("cars") or {}) if isinstance(cur.get("cars"), dict) else {}
        for i, (car, rec) in enumerate(cars_in.items()):
            if i >= 80:
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
                    "gasKm": as_num(row.get("gasKm")) if row.get("gasKm") not in (None, "") else None,
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
                if days[str(di)]["gasKm"] is None:
                    del days[str(di)]["gasKm"]
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
            if ft not in ("mixed", "gaz", "benzin", "dizel", "dizel_gaz"):
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
        cars = self._dedupe_cars(cars)
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
                    day[str(car)] = float(km)
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
                rec["km"] = rec["km"] + float(km or 0)
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

    def _task_items(self):
        data = self._load("driver:tasks", {})
        items = data.get("items") if isinstance(data, dict) else []
        if not isinstance(items, list):
            items = []
        return items

    def tasks_for(self, car, date=None):
        want = compact_plate(car)
        out = []
        for it in self._task_items():
            if not isinstance(it, dict):
                continue
            if compact_plate(it.get("car")) != want:
                continue
            td = str(it.get("date") or "")
            if date and td and td != date:
                continue
            out.append(it)
        out.sort(key=lambda x: (str(x.get("date") or ""), str(x.get("createdAt") or "")), reverse=True)
        return out[:80]

    def add_task(self, car, date, text, who=""):
        car = str(car or "").strip()[:24]
        text = str(text or "").strip()[:400]
        date = str(date or "").strip()[:10]
        if not car:
            return None, "Mashina majburiy"
        if not text:
            return None, "Topshiriq matni yozing"
        if date and not valid_date(date):
            return None, "Sana noto'g'ri"
        item = {
            "id": new_id("tk"),
            "car": car,
            "date": date,
            "text": text,
            "by": str(who or "")[:40],
            "createdAt": iso_now(),
        }
        items = self._task_items()
        items.append(item)
        if len(items) > 800:
            items = items[-800:]
        self._save("driver:tasks", {"items": items, "savedAt": iso_now()})
        return item, None

    def delete_task(self, tid):
        tid = str(tid or "").strip()[:40]
        if not tid:
            return False, "ID yo'q"
        items = [it for it in self._task_items() if not (isinstance(it, dict) and it.get("id") == tid)]
        self._save("driver:tasks", {"items": items, "savedAt": iso_now()})
        return True, None

    def _fuel_day(self, plate, date):
        if not valid_date(date):
            return None
        month = date[:7]
        day = int(date[8:10])
        data = self.fuel_month(month) or {}
        cars = data.get("cars") if isinstance(data, dict) else {}
        _key, rec = find_by_plate(cars, plate)
        if not isinstance(rec, dict):
            return None
        days = rec.get("days") if isinstance(rec.get("days"), dict) else {}
        gas_r = as_num(rec.get("gasStart"))
        ben_r = as_num(rec.get("benzinStart"))
        odo_prev = as_num(rec.get("odoStart"))
        gas_norm0 = as_num(rec.get("gasNorm"), 12)
        ben_norm0 = as_num(rec.get("benzinNorm"), 4)
        mix0 = as_num(rec.get("mixPct"), 70)
        changes = rec.get("changes") if isinstance(rec.get("changes"), list) else []

        def apply_ch(field, fallback, d):
            val = fallback
            for ch in changes:
                if not isinstance(ch, dict):
                    continue
                try:
                    cd = int(ch.get("day") or 0)
                except (TypeError, ValueError):
                    cd = 0
                if cd <= d and ch.get("field") == field:
                    val = as_num(ch.get("value"), val)
            return val

        last = None
        for d in range(1, day + 1):
            src = days.get(str(d)) if isinstance(days.get(str(d)), dict) else {}
            gas_norm = apply_ch("gasNorm", gas_norm0, d)
            ben_norm = apply_ch("benzinNorm", ben_norm0, d)
            mix = apply_ch("mixPct", mix0, d)
            km = as_num(src.get("km"))
            odo = as_num(src.get("odo"))
            if not km and odo > 0 and odo_prev > 0 and odo >= odo_prev:
                km = odo - odo_prev
            if odo > 0:
                odo_prev = odo
            elif km > 0:
                odo_prev = odo_prev + km
            mode = str(src.get("mode") or "gaz")
            gas_used = ben_used = 0.0
            gas_km = None
            if "gasKm" in src and src.get("gasKm") not in (None, ""):
                try:
                    gas_km = float(src.get("gasKm"))
                except (TypeError, ValueError):
                    gas_km = None
            liq_km = 0.0
            if km > 0:
                if gas_km is not None:
                    gas_km = max(0.0, min(km, gas_km))
                    liq_km = max(0.0, km - gas_km)
                    gas_used = gas_km * gas_norm / 100.0
                    ben_used = liq_km * ben_norm / 100.0
                elif mode == "gaz":
                    gas_km = km
                    liq_km = 0.0
                    gas_used = km * gas_norm / 100.0
                elif mode in ("benzin", "dizel"):
                    gas_km = 0.0
                    liq_km = km
                    ben_used = km * ben_norm / 100.0
                elif mode == "aralash":
                    gas_km = km * mix / 100.0
                    liq_km = km - gas_km
                    gas_used = gas_km * gas_norm / 100.0
                    ben_used = liq_km * ben_norm / 100.0
            gas_in = as_num(src.get("gasIn"))
            ben_in = as_num(src.get("benzinIn"))
            gas_r = gas_r + gas_in - gas_used
            ben_r = ben_r + ben_in - ben_used
            last = {
                "km": km,
                "gasKm": gas_km if gas_km is not None else 0.0,
                "liqKm": liq_km,
                "mode": mode,
                "station": str(src.get("station") or ""),
                "gasIn": gas_in,
                "benzinIn": ben_in,
                "gasUsed": gas_used,
                "benUsed": ben_used,
                "gasR": gas_r,
                "benR": ben_r,
                "fuelType": rec.get("fuelType") or "mixed",
            }
        return last

    def overlay_driver_name(self, drv, plate):
        vehicles = (self.fuel_meta() or {}).get("vehicles") or {}
        if not isinstance(vehicles, dict):
            return drv if isinstance(drv, dict) else {}
        rec = None
        want = compact_plate(plate)
        if plate in vehicles and isinstance(vehicles.get(plate), dict):
            rec = vehicles[plate]
        else:
            for k, v in vehicles.items():
                if compact_plate(k) == want and isinstance(v, dict):
                    rec = v
                    break
        out = dict(drv) if isinstance(drv, dict) else {}
        if not rec or not str(rec.get("name") or "").strip():
            return out
        name = str(rec.get("name") or "").strip()[:80]
        short = str(rec.get("short") or "").strip()[:40]
        if not short:
            parts = name.split()
            short = parts[-1] if parts else name
        out["fullName"] = name
        out["name"] = name
        out["shortName"] = short
        brand = str(rec.get("brand") or "").strip()[:40]
        if brand:
            out["brand"] = brand
        return out

    def _fleet_pharmacy_names(self, plate):
        try:
            import gps_sync

            base = os.path.dirname(os.path.abspath(self.seed_path))
            want = compact_plate(plate)
            for d in gps_sync.load_fleet_drivers(base):
                if compact_plate(d.get("car")) == want:
                    raw = d.get("pharmacies") or ""
                    return [p.strip() for p in raw.split(",") if p.strip()]
        except Exception:
            pass
        return []

    def driver_day(self, date, plate):
        if not valid_date(date) or not compact_plate(plate):
            return None
        report = self.get_report(date)
        cars = (report or {}).get("cars") if isinstance(report, dict) else {}
        key, rec = find_by_plate(cars, plate)
        rec = rec if isinstance(rec, dict) else {}
        stats = rec.get("stats") if isinstance(rec.get("stats"), dict) else {}
        analysis = rec.get("analysis") if isinstance(rec.get("analysis"), dict) else {}
        score = analysis.get("score") if isinstance(analysis.get("score"), dict) else {}
        stops_in = rec.get("stops") if isinstance(rec.get("stops"), list) else []
        stops = []
        # Reviews data is keyed by vmStopKey(date, car, stop).
        bag = self.reviews(date) or {}
        want = compact_plate(plate)
        def _f4(v):
            try:
                x = float(v or 0)
                return f"{x:.4f}"
            except Exception:
                return "0.0000"
        def _norm_plate_for_key(p):
            # Key uses car as-is from UI. We keep `plate` for correctness in review lookup.
            return plate
        # Map review key -> review dict for quick lookup
        # (bag already is this mapping)
        for st in stops_in[:80]:
            if not isinstance(st, dict):
                continue
            place_raw = str(st.get("place") or st.get("phName") or "")[:200]
            place_key = place_raw[:50]
            in_time = str(st.get("inTime") or "")[:20]
            lat_fixed = _f4(st.get("lat"))
            lng_fixed = _f4(st.get("lng"))
            # vmStopKey format: date|car|t|lat(4)|lng(4)|place(<=50)
            rev_key = "|".join([date, _norm_plate_for_key(want), in_time, lat_fixed, lng_fixed, place_key])
            rv = bag.get(rev_key)
            if not isinstance(rv, dict):
                # Fallback: relaxed match by date+car(last compaction)+time+place
                for k2, rv2 in bag.items():
                    if not isinstance(rv2, dict):
                        continue
                    parts2 = str(k2).split("|")
                    if len(parts2) < 6:
                        continue
                    car_k2 = parts2[1] if len(parts2) > 1 else ""
                    if compact_plate(car_k2) != want:
                        continue
                    t2 = parts2[2] if len(parts2) > 2 else ""
                    p2 = parts2[-1] if parts2 else ""
                    if str(t2) == in_time and str(p2) == place_key:
                        rv = rv2
                        break
            reviewStatus = None
            reviewNote = ""
            if isinstance(rv, dict):
                reviewStatus = rv.get("status")
                reviewNote = str(rv.get("note") or "")[:200]

            dur_sec = as_num(st.get("durSec") or st.get("dursec") or 0, 0.0)
            match_type = str(st.get("matchType") or "")
            is_office = bool(st.get("isOffice"))
            is_outside = bool(st.get("isOutside"))
            is_problem = bool(st.get("isProblem"))
            problem_rule = ""
            if not reviewStatus and is_problem:
                if (match_type == "none") and (not is_office) and (not is_outside):
                    problem_rule = "VHK: To‘xtash dorixona/geozonaga mos kelmadi yoki ruxsat berilmagan"
                else:
                    problem_rule = "VHK: Qoidabuzarlik (muammo) aniqlandi"

            stops.append(
                {
                    "place": str(st.get("place") or st.get("phName") or "")[:120],
                    "inTime": str(st.get("inTime") or "")[:20],
                    "outTime": str(st.get("outTime") or "")[:20],
                    "matchType": str(st.get("matchType") or "")[:16],
                    "isProblem": bool(st.get("isProblem")),
                    "isOffice": bool(st.get("isOffice")),
                    "isOutside": bool(st.get("isOutside")),
                    "lat": st.get("lat"),
                    "lng": st.get("lng"),
                    "durSec": float(dur_sec) if dur_sec is not None else 0,
                    "duration": str(st.get("duration") or "")[:40],
                    "reviewStatus": reviewStatus,
                    "reviewNote": reviewNote,
                    "problemRule": problem_rule,
                }
            )
        reviews = []
        for k, rv in bag.items():
            if not isinstance(rv, dict):
                continue
            parts = str(k).split("|")
            car_k = parts[1] if len(parts) > 1 else ""
            if compact_plate(car_k) != want:
                continue
            reviews.append(
                {
                    "place": parts[-1] if parts else "",
                    "time": parts[2] if len(parts) > 2 else "",
                    "status": rv.get("status"),
                    "note": rv.get("note") or "",
                }
            )
        pharms = []
        pharmacy_geo = []
        for p in self.pharmacies():
            if not isinstance(p, dict) or compact_plate(p.get("car")) != want:
                continue
            name = str(p.get("name") or "")[:80]
            if name:
                pharms.append(name)
            lat, lng = p.get("lat"), p.get("lng")
            if lat is not None and lng is not None:
                try:
                    pharmacy_geo.append(
                        {
                            "name": name,
                            "lat": float(lat),
                            "lng": float(lng),
                            "radiusM": int(p.get("radiusM") or 120),
                        }
                    )
                except (TypeError, ValueError):
                    pass
        if not pharms:
            own = analysis.get("ownPharms")
            if isinstance(own, list) and own:
                pharms = [str(x)[:80] for x in own if x]
        if not pharms:
            pharms = self._fleet_pharmacy_names(plate)
        journal = []
        for it in self.journal_items():
            if not isinstance(it, dict):
                continue
            if compact_plate(it.get("car")) != want:
                continue
            start = str(it.get("start") or "")
            if start and not start.startswith(date):
                continue
            journal.append(
                {
                    "kind": it.get("kind"),
                    "reason": it.get("reason") or "",
                    "level": it.get("level") or "",
                    "note": it.get("note") or "",
                    "start": start,
                }
            )
        drv = rec.get("driver") if isinstance(rec.get("driver"), dict) else {}
        drv = self.overlay_driver_name(drv, plate)
        rep = self.get_report(date)
        updated_at = str((rep or {}).get("savedAt") or "")
        return {
            "date": date,
            "car": key or plate,
            "name": drv.get("fullName") or drv.get("name") or "",
            "routes": drv.get("routes") or "",
            "hasGps": bool(rec),
            "updatedAt": updated_at,
            "stats": {
                "km": as_num(stats.get("probeg")),
                "maxSpeed": as_num(stats.get("maxSpeed")),
                "avgSpeed": as_num(stats.get("avgSpeed")),
                "trips": as_num(stats.get("poezdok")),
                "stops": as_num(stats.get("stoyanok")),
                "motoChas": str(stats.get("motoChas") or ""),
            },
            "analysis": {
                "ownVisited": int(as_num(analysis.get("ownVisited"))),
                "totalOwn": int(as_num(analysis.get("totalOwn"))),
                "otherDirection": int(as_num(analysis.get("otherDirection"))),
                "problemStops": int(as_num(analysis.get("problemStops"))),
                "outsideCity": int(as_num(analysis.get("outsideCity"))),
                "ownPharms": analysis.get("ownPharms") if isinstance(analysis.get("ownPharms"), list) else [],
                "missedList": analysis.get("missedList") if isinstance(analysis.get("missedList"), list) else [],
                "score": as_num(score.get("final")),
                "grade": str(score.get("grade") or "—"),
                "breakdown": score.get("breakdown") if isinstance(score.get("breakdown"), list) else [],
            },
            "stops": stops,
            "reviews": reviews,
            "pharmacies": pharms,
            "pharmacyGeo": pharmacy_geo,
            "journal": journal[:30],
            "fuel": self._fuel_day(plate, date),
            "tasks": self.tasks_for(plate, date),
        }

    def driver_month_dates(self, month, plate):
        if not month or not MONTH_RE.match(str(month)):
            return []
        out = []
        for d in self.report_dates():
            if not str(d).startswith(month + "-"):
                continue
            report = self.get_report(d)
            cars = (report or {}).get("cars") if isinstance(report, dict) else {}
            k, _rec = find_by_plate(cars, plate)
            if k:
                out.append(d)
        out.sort()
        return out


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
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def client_ip(self):
        return self.client_address[0] if self.client_address else ""

    def is_https(self):
        proto = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        if proto == "https":
            return True
        return False

    def cookie_attrs(self, max_age=SESSION_TTL):
        parts = ["HttpOnly", "Path=/", "SameSite=Lax", f"Max-Age={int(max_age)}"]
        if self.is_https():
            parts.append("Secure")
        return "; ".join(parts)

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
                f"{COOKIE}={set_cookie}; {self.cookie_attrs()}",
            )
        if clear_cookie:
            self.send_header(
                "Set-Cookie",
                f"{COOKIE}=; {self.cookie_attrs(0)}",
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
        if n > 12 * 1024 * 1024:
            return {}
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

    def require_staff(self):
        sess = self.require_user()
        if not sess:
            return None
        if not is_staff(sess):
            self.send_json({"ok": False, "error": "Faqat admin"}, 403)
            return None
        return sess

    def deny_driver_write(self, sess):
        if is_driver(sess):
            self.send_json({"ok": False, "error": "Haydovchi faqat ko'ra oladi"}, 403)
            return True
        return False

    def send_hr_json(self, obj, code=200):
        """HR API javobi — CORS (boshqa domen HR platformasi uchun)."""
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "X-API-Key, Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()
        self.wfile.write(raw)

    def require_hr_key(self):
        import hr_api

        ok, err, code = hr_api.check_hr_key(hr_api.extract_api_key(self.headers))
        if not ok:
            self.send_hr_json({"ok": False, "error": err}, code)
            return False
        return True

    def handle_hr_api(self, path):
        """Faqat o'qish HR API — session cookie talab qilinmaydi."""
        import hr_api

        if not self.require_hr_key():
            return
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        date = (qs.get("date") or [None])[0]
        car = (qs.get("car") or [None])[0]

        if path in ("/api/hr", "/api/hr/", "/api/hr/health"):
            self.send_hr_json(
                {
                    "ok": True,
                    "service": "VaksinaMed HR API",
                    "version": 1,
                    "today": hr_api.today_tashkent(),
                    "endpoints": [
                        "GET /api/hr/health",
                        "GET /api/hr/fleet?date=YYYY-MM-DD",
                        "GET /api/hr/driver?car=01+887+UKA&date=YYYY-MM-DD",
                        "GET /api/hr/tasks?date=YYYY-MM-DD",
                    ],
                }
            )
            return

        if path == "/api/hr/fleet":
            data, err = hr_api.hr_fleet(OFFICE, date)
            if err:
                self.send_hr_json({"ok": False, "error": err}, 400)
                return
            self.send_hr_json({"ok": True, **data})
            return

        if path == "/api/hr/driver":
            data, err = hr_api.hr_driver(OFFICE, car or "", date)
            if err:
                self.send_hr_json({"ok": False, "error": err}, 400)
                return
            self.send_hr_json({"ok": True, "driver": data})
            return

        if path == "/api/hr/tasks":
            data, err = hr_api.hr_tasks(OFFICE, date, car)
            if err:
                self.send_hr_json({"ok": False, "error": err}, 400)
                return
            self.send_hr_json({"ok": True, **data})
            return

        self.send_hr_json({"ok": False, "error": "Not found"}, 404)

    def is_public(self, path):
        if path in PUBLIC_PATHS:
            return True
        return any(path.startswith(p) for p in PUBLIC_PREFIX)

    def is_blocked(self, path):
        name = os.path.basename(path).lower()
        if name in BLOCKED_NAMES:
            return True
        if name.startswith(".env"):
            return True
        ext = os.path.splitext(path)[1].lower()
        if ext in BLOCKED_EXT:
            return True
        if path.startswith("/data/") or path.startswith("/agent-transcripts"):
            return True
        return False

    def do_OPTIONS(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path or "/"
        self.send_response(200)
        if path.startswith("/api/hr"):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "X-API-Key, Authorization, Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path or "/"

        if path.startswith("/api/"):
            self.handle_api_get(path)
            return

        if path == "/gps-proxy":
            sess = self.current_session()
            if not sess:
                self.send_json({"ok": False, "error": "Kirish talab qilinadi"}, 401)
                return
            if is_driver(sess):
                self.send_json({"ok": False, "error": "Haydovchi GPS yuklay olmaydi"}, 403)
                return
            self.handle_gps_proxy(parsed)
            return

        if self.is_blocked(path):
            self.send_error(403, "Ruxsat yo'q")
            return

        sess = self.current_session()

        if path == "/login.html":
            if sess:
                self.redirect(home_for(sess))
                return
            return super().do_GET()

        if path in ("/", "/index.html", "/fuel.html"):
            if not sess:
                self.redirect("/login.html")
                return
            if is_driver(sess):
                self.redirect("/driver.html")
                return
            if path == "/":
                self.path = "/index.html"
            return super().do_GET()

        if path == "/admin.html":
            if not sess:
                self.redirect("/login.html")
                return
            if not is_staff(sess):
                self.redirect(home_for(sess))
                return
            return super().do_GET()

        if path == "/driver.html":
            if not sess:
                self.redirect("/login.html")
                return
            if not is_driver(sess) and not is_staff(sess):
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
        # HR API — alohida, cookie login talab qilinmaydi
        if path.startswith("/api/hr"):
            self.handle_hr_api(path)
            return

        if path == "/api/health":
            self.send_json({"ok": True, "ts": iso_now()})
            return
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
                        "car": sess.get("car") or "",
                    },
                    "persist": STORE.persist_info(),
                    "vehicles": (OFFICE.fuel_meta() or {}).get("vehicles") or {},
                }
            )
            return
        if path == "/api/users":
            sess = self.require_staff()
            if not sess:
                return
            self.send_json({"ok": True, "users": STORE.list_users()})
            return
        if path == "/api/sessions":
            sess = self.require_staff()
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
            if is_driver(sess):
                self.send_json({"ok": False, "error": "Haydovchi faqat o'z kabinetidan ko'radi"}, 403)
                return
            self.send_json(
                {
                    "ok": True,
                    "pharmacies": OFFICE.pharmacies(),
                    "reviews": OFFICE.all_reviews(),
                    "reportDates": OFFICE.report_dates(),
                    "telegram": OFFICE.public_telegram(),
                    "gps": OFFICE.gps_status_public(),
                    "persist": STORE.persist_info(),
                    "vehicles": (OFFICE.fuel_meta() or {}).get("vehicles") or {},
                }
            )
            return

        if path == "/api/office/pharmacy-places":
            sess = self.require_staff()
            if not sess:
                return
            try:
                days = int((qs.get("days") or ["60"])[0])
            except (TypeError, ValueError):
                days = 60
            self.send_json({"ok": True, "places": OFFICE.pharmacy_place_suggestions(days)})
            return

        if path == "/api/office/gps/status":
            sess = self.require_user()
            if not sess:
                return
            self.send_json({"ok": True, **OFFICE.gps_status_public()})
            return

        if path == "/api/office/gps/config":
            sess = self.require_staff()
            if not sess:
                return
            self.send_json({"ok": True, **OFFICE.gps_config_public()})
            return

        if path == "/api/office/report":
            sess = self.require_user()
            if not sess:
                return
            if is_driver(sess):
                self.send_json({"ok": False, "error": "Haydovchi faqat o'z kabinetidan ko'radi"}, 403)
                return
            if not valid_date(date):
                self.send_json({"ok": False, "error": "Sana noto'g'ri"}, 400)
                return
            report = OFFICE.get_report(date)
            reviews = OFFICE.reviews(date)
            if isinstance(report, dict) and isinstance(report.get("cars"), dict):
                cars = report.get("cars") or {}
                for plate, rec in list(cars.items()):
                    if not isinstance(rec, dict):
                        continue
                    drv = rec.get("driver") if isinstance(rec.get("driver"), dict) else {}
                    rec["driver"] = OFFICE.overlay_driver_name(drv, rec.get("car") or plate)
            self.send_json({"ok": True, "report": report, "reviews": reviews})
            return

        if path == "/api/office/fuel/meta":
            sess = self.require_user()
            if not sess:
                return
            if is_driver(sess):
                self.send_json({"ok": False, "error": "Haydovchi faqat o'z kabinetidan ko'radi"}, 403)
                return
            self.send_json({"ok": True, "meta": OFFICE.fuel_meta()})
            return

        if path == "/api/office/fuel/month":
            sess = self.require_user()
            if not sess:
                return
            if is_driver(sess):
                self.send_json({"ok": False, "error": "Haydovchi faqat o'z kabinetidan ko'radi"}, 403)
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
            if is_driver(sess):
                self.send_json({"ok": False, "error": "Haydovchi faqat o'z kabinetidan ko'radi"}, 403)
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
            if is_driver(sess):
                self.send_json({"ok": False, "error": "Haydovchi faqat o'z kabinetidan ko'radi"}, 403)
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
            if is_driver(sess):
                self.send_json({"ok": False, "error": "Haydovchi faqat o'z kabinetidan ko'radi"}, 403)
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

        if path == "/api/driver/day":
            sess = self.require_user()
            if not sess:
                return
            plate = (qs.get("car") or [None])[0] or ""
            if is_driver(sess):
                plate = sess.get("car") or ""
            elif not is_staff(sess):
                self.send_json({"ok": False, "error": "Ruxsat yo'q"}, 403)
                return
            if not compact_plate(plate):
                self.send_json({"ok": False, "error": "Mashina biriktirilmagan"}, 400)
                return
            if not valid_date(date):
                self.send_json({"ok": False, "error": "Sana noto'g'ri"}, 400)
                return
            self.send_json({"ok": True, "day": OFFICE.driver_day(date, plate)})
            return

        if path == "/api/driver/month":
            sess = self.require_user()
            if not sess:
                return
            plate = (qs.get("car") or [None])[0] or ""
            if is_driver(sess):
                plate = sess.get("car") or ""
            elif not is_staff(sess):
                self.send_json({"ok": False, "error": "Ruxsat yo'q"}, 403)
                return
            if not compact_plate(plate):
                self.send_json({"ok": False, "error": "Mashina biriktirilmagan"}, 400)
                return
            self.send_json({"ok": True, "dates": OFFICE.driver_month_dates(month, plate)})
            return

        if path == "/api/driver/tasks":
            sess = self.require_user()
            if not sess:
                return
            all_flag = (qs.get("all") or [None])[0]
            car_q = (qs.get("car") or [None])[0] or ""
            if is_driver(sess):
                car_q = sess.get("car") or ""
            elif not is_staff(sess):
                self.send_json({"ok": False, "error": "Ruxsat yo'q"}, 403)
                return
            if all_flag and is_staff(sess):
                items = OFFICE._task_items()
                items.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)
                self.send_json({"ok": True, "tasks": items[:200]})
            elif car_q:
                self.send_json({"ok": True, "tasks": OFFICE.tasks_for(car_q)})
            else:
                items = OFFICE._task_items()
                items.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)
                self.send_json({"ok": True, "tasks": items[:200]})
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
                        "car": sess.get("car") or "",
                    },
                    "redirect": home_for(sess),
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
            sess = self.require_user()
            if not sess:
                return
            role = str(body.get("role") or "admin").strip()
            if role == "driver":
                if not is_staff(sess):
                    self.send_json({"ok": False, "error": "Faqat admin"}, 403)
                    return
            elif role == "admin":
                if sess.get("role") != "admin_pro":
                    self.send_json({"ok": False, "error": "Faqat Admin Pro"}, 403)
                    return
            else:
                self.send_json({"ok": False, "error": "Rol noto'g'ri"}, 400)
                return
            user, err = STORE.add_user(
                sess["username"],
                body.get("name"),
                body.get("username"),
                body.get("password"),
                role=role,
                car=body.get("car") or "",
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True, "user": user})
            return

        if path == "/api/users/toggle":
            sess = self.require_staff()
            if not sess:
                return
            user, err = STORE.set_active(
                sess["username"], body.get("id"), bool(body.get("active")), sess.get("role")
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True, "user": user})
            return

        if path == "/api/users/delete":
            sess = self.require_staff()
            if not sess:
                return
            ok, err = STORE.delete_user(sess["username"], body.get("id"), sess.get("role"))
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True})
            return

        if path == "/api/users/reset":
            sess = self.require_staff()
            if not sess:
                return
            ok, err = STORE.reset_password(
                sess["username"], body.get("id"), body.get("password"), sess.get("role")
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True})
            return

        if path == "/api/sessions/kick":
            sess = self.require_staff()
            if not sess:
                return
            ok, err = STORE.kick(sess["username"], body.get("id"))
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True})
            return

        if path == "/api/office/pharmacies":
            sess = self.require_staff()
            if not sess:
                return
            items = OFFICE.save_pharmacies(body.get("pharmacies") or [])
            self.send_json({"ok": True, "pharmacies": items})

            def _reprocess_pharms():
                try:
                    import gps_sync
                    gps_sync.reprocess_recent(OFFICE, DIRECTORY, limit=45)
                except Exception:
                    pass

            threading.Thread(target=_reprocess_pharms, daemon=True).start()
            return

        if path == "/api/office/learn-geozones":
            sess = self.require_staff()
            if not sess:
                return
            date_arg = body.get("date")

            def _learn_bg():
                try:
                    OFFICE.learn_and_reprocess(DIRECTORY, date_arg)
                except Exception:
                    pass

            threading.Thread(target=_learn_bg, daemon=True).start()
            self.send_json({
                "ok": True,
                "queued": True,
                "message": "Geozonlar fon rejimida o‘rganilmoqda va hisobotlar yangilanmoqda"
            })
            return

        if path == "/api/office/reviews":
            sess = self.require_user()
            if not sess:
                return
            if self.deny_driver_write(sess):
                return
            date_val = body.get("date")
            data, err = OFFICE.set_review(
                date_val,
                body.get("key"),
                {
                    "status": body.get("status"),
                    "note": body.get("note"),
                    "phName": body.get("phName"),
                    "car": body.get("car"),
                    "lat": body.get("lat"),
                    "lng": body.get("lng"),
                    "by": sess.get("username"),
                },
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            if body.get("status") == "allowed" and body.get("phName") and body.get("lat") is not None:
                try:
                    import gps_sync
                    pharms = list(OFFICE.pharmacies())
                    if gps_sync.learn_geozone(
                        pharms,
                        body.get("car") or "",
                        body.get("phName"),
                        body.get("lat"),
                        body.get("lng"),
                    ):
                        OFFICE.save_pharmacies(pharms)
                    if valid_date(date_val):
                        gps_sync.reprocess_day(OFFICE, DIRECTORY, date_val)
                except Exception:
                    pass
            self.send_json({"ok": True, "reviews": data})
            return

        if path == "/api/office/report":
            sess = self.require_user()
            if not sess:
                return
            if self.deny_driver_write(sess):
                return
            payload, err = OFFICE.save_report(
                body.get("date"), body.get("cars") or {}, sess.get("username")
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True, "savedAt": payload.get("savedAt")})
            return

        if path == "/api/office/gps/config":
            sess = self.require_staff()
            if not sess:
                return
            pub = OFFICE.save_gps_config(body, sess.get("username"))

            def run_sync():
                enqueue_gps_sync(OFFICE, DIRECTORY, None, sess.get("username") or "user")

            threading.Thread(target=run_sync, daemon=True).start()
            self.send_json({"ok": True, **pub})
            return

        if path == "/api/office/gps/sync":
            sess = self.require_staff()
            if not sess:
                return
            date_val = str(body.get("date") or "").strip()
            if date_val and not valid_date(date_val):
                self.send_json({"ok": False, "error": "Sana noto'g'ri"}, 400)
                return
            job_id = enqueue_gps_sync(
                OFFICE, DIRECTORY, date_val or None, sess.get("username") or "user"
            )
            self.send_json({"ok": True, "queued": True, "jobId": job_id, "date": date_val, **OFFICE.gps_status_public()})
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
            if self.deny_driver_write(sess):
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
            if self.deny_driver_write(sess):
                return
            meta = OFFICE.save_fuel_meta(body)
            self.send_json({"ok": True, "meta": meta})
            return

        if path == "/api/office/fuel/month":
            sess = self.require_user()
            if not sess:
                return
            if self.deny_driver_write(sess):
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
            if self.deny_driver_write(sess):
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

        if path == "/api/driver/tasks":
            sess = self.require_staff()
            if not sess:
                return
            if body.get("deleteId"):
                ok, err = OFFICE.delete_task(body.get("deleteId"))
                if err:
                    self.send_json({"ok": False, "error": err}, 400)
                    return
                self.send_json({"ok": True})
                return
            item, err = OFFICE.add_task(
                body.get("car"), body.get("date"), body.get("text"), sess.get("username")
            )
            if err:
                self.send_json({"ok": False, "error": err}, 400)
                return
            self.send_json({"ok": True, "task": item})
            return

        self.send_json({"ok": False, "error": "Not found"}, 404)

    def handle_gps_proxy(self, parsed):
        params = urllib.parse.parse_qs(parsed.query)
        target_url = params.get("url", [None])[0]
        if not target_url:
            self.send_error(400, "url parametri ko'rsatilmagan")
            return

        parsed_target = urllib.parse.urlparse(target_url)
        if parsed_target.scheme not in ("http", "https"):
            self.send_error(403, "Faqat http/https ruxsat")
            return
        host = (parsed_target.hostname or "").lower()
        # SSRF himoya: faqat Wialon hostlari (lokal/private IP yo'q)
        if host not in ALLOWED_GPS_HOSTS:
            self.send_error(403, f"Ruxsat etilmagan host: {host or parsed_target.netloc}")
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


GPS_SYNC_INTERVAL = int(os.environ.get("GPS_SYNC_INTERVAL", "300"))
_gps_worker_started = False
_gps_sync_lock = threading.Lock()
_GPS_JOB = {"q": [], "active": False, "seq": 0, "lock": threading.Lock()}


def seed_gps_from_env(office):
    token = re.sub(r"\s+", "", os.environ.get("GPS_TOKEN", "")).strip()
    user = os.environ.get("GPS_USER", "").strip()
    password = os.environ.get("GPS_PASSWORD", "").strip()
    host = os.environ.get("GPS_HOST", "http://bms1.gpsavto.uz").strip()
    if not token and not user:
        return
    office.save_gps_config(
        {"host": host or "http://bms1.gpsavto.uz", "token": token, "user": user, "password": password},
        "env",
    )


def enqueue_gps_sync(office, base_dir, date_str=None, saved_by="auto"):
    date_str = str(date_str or "").strip() or None
    with _GPS_JOB["lock"]:
        _GPS_JOB["seq"] += 1
        job_id = _GPS_JOB["seq"]
        _GPS_JOB["q"] = [item for item in _GPS_JOB["q"] if item[0] != date_str]
        _GPS_JOB["q"].append((date_str, str(saved_by or "auto"), job_id))
        need_start = not _GPS_JOB["active"]
        if need_start:
            _GPS_JOB["active"] = True
    if need_start:
        threading.Thread(
            target=_gps_queue_runner,
            args=(office, base_dir),
            daemon=True,
            name="gps-sync-job",
        ).start()
    return job_id


def _gps_queue_runner(office, base_dir):
    try:
        while True:
            with _GPS_JOB["lock"]:
                if not _GPS_JOB["q"]:
                    _GPS_JOB["active"] = False
                    return
                date_str, saved_by, job_id = _GPS_JOB["q"].pop(0)
            try:
                import gps_sync

                d = date_str or gps_sync.today_tashkent()
                office.set_gps_status(
                    running=True, date=d, message="Navbat boshlandi", job_id=job_id
                )
                with _gps_sync_lock:
                    result = gps_sync.sync_today(office, base_dir, d, saved_by=saved_by) or {}
                office.set_gps_status(
                    running=False,
                    cars=int(result.get("cars") or 0),
                    error=str(result.get("error") or "")[:200],
                    date=d,
                    message="Tayyor" if result.get("ok") else "Xato",
                    job_id=job_id,
                )
            except Exception as e:
                print("[gps-sync]", e)
                try:
                    office.set_gps_status(
                        running=False, error=str(e)[:200], date=date_str or "", message="Xato", job_id=job_id
                    )
                except Exception:
                    pass
    except Exception as e:
        print("[gps-sync runner]", e)
        with _GPS_JOB["lock"]:
            _GPS_JOB["active"] = False


def start_gps_worker(office, base_dir):
    global _gps_worker_started
    if _gps_worker_started:
        return
    _gps_worker_started = True

    def auto_tick():
        if not office.gps_config_internal().get("configured"):
            return
        import gps_sync

        enqueue_gps_sync(office, base_dir, gps_sync.today_tashkent(), "auto")
        yday = gps_sync.yesterday_tashkent()
        rec = office.get_report(yday)
        cars = rec.get("cars") if isinstance(rec, dict) else None
        if not cars:
            enqueue_gps_sync(office, base_dir, yday, "auto-kecha")

    threading.Thread(target=auto_tick, daemon=True).start()

    def loop():
        while True:
            time.sleep(max(60, GPS_SYNC_INTERVAL))
            try:
                auto_tick()
            except Exception as e:
                print("[gps-sync loop]", e)

    threading.Thread(target=loop, daemon=True, name="gps-sync").start()


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
    seed_gps_from_env(OFFICE)
    start_gps_worker(OFFICE, args.dir)

    def bootstrap_geozones():
        try:
            OFFICE.learn_and_reprocess(args.dir)
        except Exception as e:
            print("[geozone-bootstrap]", e)

    threading.Thread(target=bootstrap_geozones, daemon=True, name="geozone-bootstrap").start()

    seed_note = ""
    if STORE.seeded:
        seed_note = f"""
  |  Admin Pro login : {SEED_USER:<22} |
  |  Parol: VM_SEED_PASS (.env)             |
  |  Birinchi ish: panelda parolni almashtiring! |"""

    persist_line = "PostgreSQL (qoladi)" if persist.durable else "lokal fayl (Render da yo'qoladi)"
    import hr_api as _hr

    hr_line = "yoqilgan (VM_HR_API_KEY)" if _hr.hr_api_key() else "ochiq emas — VM_HR_API_KEY qo'ying"

    print(f"""
  +==========================================+
  |   VaksinaMed Fleet Control — Server      |
  +==========================================+
  |  Manzil: http://localhost:{args.port:<14}  |
  |  Kirish: login + parol majburiy          |
  |  Saqlash: {persist_line:<29} |
  |  HR API: {hr_line:<30} |{seed_note}
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
