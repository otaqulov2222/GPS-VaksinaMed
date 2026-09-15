# -*- coding: utf-8 -*-
"""Davomat: Ofis QR + GPS geozona + kirish/chiqish (vaqt)."""

from __future__ import annotations

import hashlib
import hmac
import math
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo("Asia/Tashkent")
except Exception:
    TZ = timezone(timedelta(hours=5))  # Toshkent UTC+5
SETTINGS_KEY = "attendance:settings"
FACE_PREFIX = "attendance:face:"
DAY_PREFIX = "attendance:day:"
CHALLENGE_PREFIX = "attendance:chal:"
QR_TICKET_PREFIX = "attendance:qrticket:"

QR_TICKET_TTL_MIN = 10
QR_PREFIX = "VMATT1"

DEFAULT_SETTINGS = {
    "office": {
        "lat": 41.219119,
        "lng": 69.272688,
        "radius_m": 100,
        "label": "VaksinaMed ofis",
    },
    # Haydovchilar + ofis (Jasur): 09:00–18:00, 15 daqiqa ruxsat
    "in_start": "09:00",
    "in_end": "10:00",
    "in_late_after": "09:15",
    "late_grace_min": 15,
    "out_start": "18:00",
    "out_end": "20:00",
    "require_gps": True,
    "require_face": False,
    "require_qr": True,
    "office_qr_secret": "",
    "office_qr_version": 1,
    "office_qr_updated_at": "",
    "enabled": True,
}

# Rol / shaxs bo‘yicha ish kuni (driver + Jasur)
OFFICE_DAY_SCHEDULE = {
    "in_start": "09:00",
    "in_end": "10:00",
    "in_late_after": "09:15",
    "late_grace_min": 15,
    "out_start": "18:00",
    "out_end": "20:00",
}

_MAX_PHOTO = 900_000  # ~data URL length


def now_tz() -> datetime:
    return datetime.now(TZ)


def today_str() -> str:
    return now_tz().strftime("%Y-%m-%d")


def parse_hhmm(s: str) -> tuple[int, int] | None:
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(s or "").strip())
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        return None
    return h, mi


def minutes_now() -> int:
    n = now_tz()
    return n.hour * 60 + n.minute


def hhmm_to_min(s: str) -> int | None:
    p = parse_hhmm(s)
    if not p:
        return None
    return p[0] * 60 + p[1]


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def clean_photo(data_url: str | None) -> tuple[str | None, str | None]:
    if not data_url:
        return None, None
    s = str(data_url).strip()
    if not s.startswith("data:image/"):
        return None, "Rasm formati noto'g'ri"
    if len(s) > _MAX_PHOTO:
        return None, "Rasm juda katta — yaqinroq / pastroq sifat"
    if "base64," not in s:
        return None, "Rasm o'qilmadi"
    return s, None


def face_distance(a, b) -> float:
    if not a or not b or len(a) != len(b):
        return 99.0
    try:
        s = 0.0
        for i in range(len(a)):
            d = float(a[i]) - float(b[i])
            s += d * d
        return math.sqrt(s)
    except (TypeError, ValueError):
        return 99.0


def clean_descriptor(raw) -> tuple[list | None, str | None]:
    if raw is None:
        return None, "Yuz vektor yo'q"
    if not isinstance(raw, list):
        return None, "Yuz vektor formati noto'g'ri"
    if len(raw) < 64 or len(raw) > 256:
        return None, "Yuz vektor uzunligi noto'g'ri"
    out = []
    try:
        for x in raw:
            out.append(float(x))
    except (TypeError, ValueError):
        return None, "Yuz vektor o'qilmadi"
    return out, None


FACE_MATCH_MAX = 0.58


class AttendanceStore:
    def __init__(self, persist):
        self.persist = persist
        self.lock = threading.Lock()
        self._ensure_settings()

    def _load(self, key, default=None):
        v = self.persist.get(key)
        return default if v is None else v

    def _save(self, key, obj):
        self.persist.put(key, obj)

    def _ensure_settings(self):
        if self.persist.get(SETTINGS_KEY) is None:
            self._save(SETTINGS_KEY, dict(DEFAULT_SETTINGS))
            return
        raw = self._load(SETTINGS_KEY, {})
        if not isinstance(raw, dict):
            return
        changed = False
        cur = dict(raw)
        office = cur.get("office") if isinstance(cur.get("office"), dict) else {}
        try:
            r = float(office.get("radius_m") or 0)
        except (TypeError, ValueError):
            r = 0
        # Eski default 250 m → 100 m
        if r == 250 or r <= 0:
            of = dict(DEFAULT_SETTINGS["office"])
            of.update(office)
            of["radius_m"] = 100
            cur["office"] = of
            changed = True
        # Eski ish kuni 08:30–21:00 → 09:00–18:00 (+15 daqiqa)
        if str(cur.get("in_start") or "") in ("08:30", "8:30") and str(cur.get("out_end") or "") in ("21:00",):
            for k, v in OFFICE_DAY_SCHEDULE.items():
                cur[k] = v
            changed = True
        if "late_grace_min" not in cur:
            cur["late_grace_min"] = 15
            changed = True
        # Face → QR migratsiya
        if cur.get("require_face") is True and "require_qr" not in cur:
            cur["require_face"] = False
            cur["require_qr"] = True
            changed = True
        if "require_qr" not in cur:
            cur["require_qr"] = True
            changed = True
        if not str(cur.get("office_qr_secret") or "").strip():
            cur["office_qr_secret"] = secrets.token_urlsafe(24)
            cur["office_qr_version"] = int(cur.get("office_qr_version") or 1)
            cur["office_qr_updated_at"] = now_tz().isoformat(timespec="seconds")
            changed = True
        if changed:
            # DEFAULT bilan to‘ldirish
            merged = dict(DEFAULT_SETTINGS)
            merged.update({k: v for k, v in cur.items() if k != "office"})
            of = dict(DEFAULT_SETTINGS["office"])
            if isinstance(cur.get("office"), dict):
                of.update(cur["office"])
            merged["office"] = of
            self._save(SETTINGS_KEY, merged)

    def settings(self) -> dict:
        with self.lock:
            raw = self._load(SETTINGS_KEY, {})
            if not isinstance(raw, dict):
                raw = {}
            out = dict(DEFAULT_SETTINGS)
            out.update({k: v for k, v in raw.items() if k != "office"})
            office = dict(DEFAULT_SETTINGS["office"])
            if isinstance(raw.get("office"), dict):
                office.update(raw["office"])
            out["office"] = office
            try:
                out["late_grace_min"] = max(0, min(120, int(out.get("late_grace_min") or 15)))
            except (TypeError, ValueError):
                out["late_grace_min"] = 15
            out["require_face"] = bool(out.get("require_face", False))
            out["require_qr"] = bool(out.get("require_qr", True))
            out["require_gps"] = bool(out.get("require_gps", True))
            secret = str(out.get("office_qr_secret") or "").strip()
            if not secret:
                secret = secrets.token_urlsafe(24)
                out["office_qr_secret"] = secret
                out["office_qr_version"] = int(out.get("office_qr_version") or 1)
                out["office_qr_updated_at"] = now_tz().isoformat(timespec="seconds")
                self._save(SETTINGS_KEY, out)
            else:
                out["office_qr_secret"] = secret
                try:
                    out["office_qr_version"] = max(1, int(out.get("office_qr_version") or 1))
                except (TypeError, ValueError):
                    out["office_qr_version"] = 1
            return out

    def office_qr_payload(self, settings: dict | None = None) -> str:
        s = settings or self.settings()
        ver = int(s.get("office_qr_version") or 1)
        secret = str(s.get("office_qr_secret") or "").strip()
        return f"{QR_PREFIX}.{ver}.{secret}"

    def get_office_qr(self) -> dict:
        s = self.settings()
        office = s.get("office") or {}
        return {
            "payload": self.office_qr_payload(s),
            "version": int(s.get("office_qr_version") or 1),
            "updatedAt": s.get("office_qr_updated_at") or "",
            "label": office.get("label") or "Ofis",
            "radius_m": office.get("radius_m"),
            "require_qr": bool(s.get("require_qr", True)),
        }

    def office_qr_png(self, scale: int = 10) -> bytes:
        """CDN kerak emas — lokal QR PNG (ofis plakat / yuklash)."""
        from qr_pure import make_qr_png

        return make_qr_png(self.office_qr_payload(), scale=max(4, min(int(scale or 10), 20)))

    def rotate_office_qr(self) -> dict:
        with self.lock:
            raw = self._load(SETTINGS_KEY, {})
            if not isinstance(raw, dict):
                raw = {}
            cur = dict(DEFAULT_SETTINGS)
            cur.update({k: v for k, v in raw.items() if k != "office"})
            office = dict(DEFAULT_SETTINGS["office"])
            if isinstance(raw.get("office"), dict):
                office.update(raw["office"])
            cur["office"] = office
            try:
                ver = int(cur.get("office_qr_version") or 1) + 1
            except (TypeError, ValueError):
                ver = 2
            cur["office_qr_version"] = ver
            cur["office_qr_secret"] = secrets.token_urlsafe(24)
            cur["office_qr_updated_at"] = now_tz().isoformat(timespec="seconds")
            cur["require_qr"] = True
            cur["require_face"] = False
            self._save(SETTINGS_KEY, cur)
        return self.get_office_qr()

    def _parse_office_qr(self, raw: str) -> tuple[int | None, str | None]:
        text = str(raw or "").strip()
        if not text:
            return None, None
        # URL yoki ortiqcha matndan payloadni ajratish
        m = re.search(r"(VMATT1\.\d+\.[A-Za-z0-9_\-]+)", text)
        if m:
            text = m.group(1)
        parts = text.split(".")
        if len(parts) != 3 or parts[0] != QR_PREFIX:
            return None, None
        try:
            ver = int(parts[1])
        except ValueError:
            return None, None
        secret = parts[2].strip()
        if len(secret) < 16:
            return None, None
        return ver, secret

    def _gps_inside_office(
        self,
        settings: dict,
        lat: float | None,
        lng: float | None,
        accuracy: float | None,
    ) -> tuple[bool, float | None, str | None]:
        office = settings.get("office") or {}
        if not settings.get("require_gps", True):
            return True, None, None
        try:
            lat_f = float(lat)
            lng_f = float(lng)
        except (TypeError, ValueError):
            return False, None, "Joylashuv ruxsati kerak"
        if not (-90.0 <= lat_f <= 90.0 and -180.0 <= lng_f <= 180.0):
            return False, None, "Joylashuv koordinatasi noto'g'ri"
        try:
            acc_f = float(accuracy) if accuracy is not None else None
        except (TypeError, ValueError):
            acc_f = None
        if acc_f is not None and acc_f > 220:
            return False, None, (
                f"Joylashuv aniq emas ({int(acc_f)} m). "
                "Ochig'roq joyda qayta urinib ko'ring."
            )
        try:
            olat = float(office.get("lat"))
            olng = float(office.get("lng"))
            radius = float(office.get("radius_m") or 100)
        except (TypeError, ValueError):
            return False, None, "Ofis geozonasi sozlanmagan"
        dist = haversine_m(lat_f, lng_f, olat, olng)
        if dist > radius:
            return False, dist, (
                f"Ofis zonasi tashqarisida ({int(dist)} m). "
                f"Radius: {int(radius)} m."
            )
        return True, dist, None

    def qr_ticket_key(self, user_id: str) -> str:
        return QR_TICKET_PREFIX + str(user_id)

    def get_qr_ticket(self, user_id: str) -> dict | None:
        with self.lock:
            data = self._load(self.qr_ticket_key(user_id))
        if not isinstance(data, dict) or not data.get("ticket"):
            return None
        try:
            exp = datetime.fromisoformat(str(data.get("exp")))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=TZ)
            if now_tz() > exp:
                return None
        except Exception:
            return None
        left = 0
        try:
            left = max(0, int((exp - now_tz()).total_seconds()))
        except Exception:
            left = 0
        return {
            "ticket": data.get("ticket"),
            "exp": data.get("exp"),
            "expiresInSec": left,
            "qrVersion": data.get("qrVersion"),
        }

    def verify_office_qr(
        self,
        *,
        user_id: str,
        payload: str,
        lat: float | None,
        lng: float | None,
        accuracy: float | None,
        user: dict | None = None,
    ) -> tuple[dict | None, str | None]:
        settings = self.settings_for_user(user)
        if not settings.get("enabled", True):
            return None, "Davomat hozir o'chirilgan"
        if not settings.get("require_qr", True):
            return None, "Ofis QR hozir o'chirilgan"

        ok_gps, dist, gerr = self._gps_inside_office(settings, lat, lng, accuracy)
        if not ok_gps:
            return None, gerr or "Ofis zonasiga kiring"

        ver, secret = self._parse_office_qr(payload)
        if ver is None or not secret:
            return None, "QR o'qilmadi — ofis QR kodini skanerlang"
        cur_ver = int(settings.get("office_qr_version") or 1)
        cur_secret = str(settings.get("office_qr_secret") or "").strip()
        if ver != cur_ver or not hmac.compare_digest(secret, cur_secret):
            return None, "Bu QR ofisga mos emas yoki eskirgan. Admin yangi QR chop etsin."

        ticket = secrets.token_urlsafe(24)
        exp = now_tz() + timedelta(minutes=QR_TICKET_TTL_MIN)
        rec = {
            "ticket": ticket,
            "userId": str(user_id),
            "exp": exp.isoformat(timespec="seconds"),
            "qrVersion": cur_ver,
            "distance_m": round(dist, 1) if dist is not None else None,
            "createdAt": now_tz().isoformat(timespec="seconds"),
        }
        with self.lock:
            self._save(self.qr_ticket_key(user_id), rec)
        return {
            "ok": True,
            "qrTicket": ticket,
            "expiresInSec": QR_TICKET_TTL_MIN * 60,
            "exp": rec["exp"],
            "distance_m": rec["distance_m"],
            "message": "Ofis QR tasdiqlandi — endi Keldim / Ketdim",
        }, None

    def consume_qr_ticket(self, user_id: str, ticket: str) -> str | None:
        key = self.qr_ticket_key(user_id)
        want = str(ticket or "").strip()
        with self.lock:
            data = self._load(key)
            self._save(key, {})
        if not isinstance(data, dict) or not data.get("ticket"):
            return "Avval ofis QR ni skanerlang"
        if not want or not hmac.compare_digest(str(data.get("ticket")), want):
            return "QR ruxsati mos emas — qayta skanerlang"
        try:
            exp = datetime.fromisoformat(str(data.get("exp")))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=TZ)
            if now_tz() > exp:
                return "QR ruxsati muddati tugagan — qayta skanerlang"
        except Exception:
            return "QR ruxsati xato"
        return None

    @staticmethod
    def _is_office_day_user(user: dict | None) -> bool:
        """Haydovchilar va ofisdagi Jasur (admin) — 09:00–18:00."""
        if not isinstance(user, dict):
            return False
        role = str(user.get("role") or "").strip().lower()
        if role == "driver":
            return True
        blob = f"{user.get('name') or ''} {user.get('username') or ''}".lower()
        if "jasur" in blob:
            return True
        # Oddiy admin (ofis) ham shu grafik
        if role == "admin":
            return True
        return False

    def settings_for_user(self, user: dict | None = None) -> dict:
        """Punch / UI uchun shaxsga mos ish kuni."""
        base = self.settings()
        if self._is_office_day_user(user):
            out = dict(base)
            out.update(OFFICE_DAY_SCHEDULE)
            return out
        return base

    def save_settings(self, patch: dict) -> dict:
        cur = self.settings()
        if not isinstance(patch, dict):
            return cur
        for k in (
            "in_start", "in_end", "in_late_after", "late_grace_min",
            "out_start", "out_end", "require_gps", "require_face", "require_qr", "enabled",
        ):
            if k in patch:
                cur[k] = patch[k]
        cur["require_face"] = bool(cur.get("require_face", False))
        cur["require_qr"] = bool(cur.get("require_qr", True))
        # QR sirri client orqali o'zgarmasligi kerak
        s_full = self.settings()
        cur["office_qr_secret"] = s_full.get("office_qr_secret")
        cur["office_qr_version"] = s_full.get("office_qr_version")
        cur["office_qr_updated_at"] = s_full.get("office_qr_updated_at")
        if isinstance(patch.get("office"), dict):
            office = dict(cur["office"])
            for ok in ("lat", "lng", "radius_m", "label"):
                if ok in patch["office"]:
                    office[ok] = patch["office"][ok]
            try:
                office["lat"] = float(office["lat"])
                office["lng"] = float(office["lng"])
                office["radius_m"] = max(50, min(5000, float(office["radius_m"])))
            except (TypeError, ValueError):
                pass
            office["label"] = str(office.get("label") or "Ofis")[:80]
            cur["office"] = office
        for tkey in ("in_start", "in_end", "in_late_after", "out_start", "out_end"):
            if parse_hhmm(str(cur.get(tkey) or "")) is None:
                cur[tkey] = DEFAULT_SETTINGS[tkey]
        try:
            cur["late_grace_min"] = max(0, min(120, int(cur.get("late_grace_min") or 15)))
        except (TypeError, ValueError):
            cur["late_grace_min"] = 15
        # Grace o‘zgarsa — in_late_after ni moslashtirish (agar classic 09:00+15)
        a = hhmm_to_min(cur.get("in_start"))
        if a is not None and "in_late_after" in patch and parse_hhmm(str(patch.get("in_late_after") or "")) is None:
            grace = int(cur.get("late_grace_min") or 15)
            hm = a + grace
            cur["in_late_after"] = f"{hm // 60:02d}:{hm % 60:02d}"
        with self.lock:
            self._save(SETTINGS_KEY, cur)
        return cur

    def face_key(self, user_id: str) -> str:
        return FACE_PREFIX + str(user_id)

    def get_face(self, user_id: str) -> dict | None:
        with self.lock:
            data = self._load(self.face_key(user_id))
            return data if isinstance(data, dict) else None

    def is_enrolled(self, user_id: str) -> bool:
        # QR rejimida alohida enroll yo'q — har bir foydalanuvchi tayyor
        return True

    def enroll(
        self,
        user_id: str,
        *,
        username: str,
        name: str,
        photo: str | None,
        credential_id: str | None = None,
        descriptor=None,
    ) -> tuple[dict | None, str | None]:
        return None, "Face ID o'chirilgan. Ofis QR skanerlashdan foydalaning."

    def match_face(self, user_id: str, descriptor) -> tuple[bool, float, str | None]:
        return False, 99.0, "Face ID o'chirilgan"

    def issue_challenge(self, user_id: str, purpose: str) -> dict:
        chal = secrets.token_urlsafe(32)
        key = CHALLENGE_PREFIX + str(user_id)
        with self.lock:
            self._save(
                key,
                {
                    "challenge": chal,
                    "purpose": str(purpose or "punch")[:20],
                    "exp": (now_tz() + timedelta(minutes=3)).isoformat(),
                },
            )
        return {"challenge": chal, "rpId": None}

    def consume_challenge(self, user_id: str, challenge: str, purpose: str) -> str | None:
        key = CHALLENGE_PREFIX + str(user_id)
        with self.lock:
            data = self._load(key)
            self._save(key, {})
        if not isinstance(data, dict) or not data.get("challenge"):
            return "Challenge topilmadi — qayta urinib ko'ring"
        if data.get("challenge") != challenge:
            return "Challenge mos emas"
        try:
            exp = datetime.fromisoformat(str(data.get("exp")))
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=TZ)
            if now_tz() > exp:
                return "Challenge muddati tugagan"
        except Exception:
            return "Challenge xato"
        if purpose and data.get("purpose") and data.get("purpose") != purpose:
            return "Challenge maqsadi mos emas"
        return None

    def day_key(self, date: str) -> str:
        return DAY_PREFIX + date

    def day_records(self, date: str) -> dict:
        with self.lock:
            data = self._load(self.day_key(date), {})
            return data if isinstance(data, dict) else {}

    def user_day(self, date: str, user_id: str) -> dict:
        day = self.day_records(date)
        rec = day.get(str(user_id))
        return rec if isinstance(rec, dict) else {}

    def _slot_ok(self, kind: str, settings: dict) -> tuple[bool, str, bool]:
        """return ok, message, is_late

        Keldim: in_start dan kun oxirigacha.
        15 daqiqa ruxsat: in_late_after gacha kechikish YO‘Q (masalan 09:15 gacha OK).
        Ketdim: out_end gacha.
        """
        now_m = minutes_now()
        if kind == "in":
            a = hhmm_to_min(settings.get("in_start"))
            late_after = hhmm_to_min(settings.get("in_late_after"))
            try:
                grace = max(0, min(120, int(settings.get("late_grace_min") or 15)))
            except (TypeError, ValueError):
                grace = 15
            if late_after is None and a is not None:
                late_after = a + grace
            day_end = hhmm_to_min(settings.get("out_end")) or (23 * 60 + 59)
            if a is None:
                return False, "Kirish vaqti sozlanmagan", False
            if now_m < a:
                return False, f"Kirish hali ochilmagan ({settings.get('in_start')} dan)", False
            if now_m > day_end:
                return False, f"Bugungi ish kuni yopildi ({settings.get('out_end')})", False
            # 09:15 gacha ruxsat — faqat undan KEYIN kechikish
            late = bool(late_after is not None and now_m > late_after)
            if late:
                return True, f"Kechikib keldi ({settings.get('in_late_after')} dan keyin)", True
            return True, "O'z vaqtida", False
        if kind == "out":
            b = hhmm_to_min(settings.get("out_end")) or (23 * 60 + 59)
            out_start = hhmm_to_min(settings.get("out_start"))
            if now_m > b:
                return False, f"Chiqish oynasi yopildi ({settings.get('out_end')})", False
            if out_start is not None and now_m < out_start:
                return True, "Erta chiqish", False
            return True, "Chiqish qabul qilindi", False
        return False, "Tur noto'g'ri (in/out)", False

    def punch(
        self,
        *,
        user_id: str,
        username: str,
        name: str,
        role: str,
        kind: str,
        lat: float | None,
        lng: float | None,
        accuracy: float | None,
        photo: str | None,
        credential_id: str | None = None,
        challenge: str | None = None,
        descriptor=None,
        qr_ticket: str | None = None,
    ) -> tuple[dict | None, str | None]:
        settings = self.settings_for_user(
            {"id": user_id, "username": username, "name": name, "role": role}
        )
        if not settings.get("enabled", True):
            return None, "Davomat hozir o'chirilgan"

        kind = str(kind or "").strip().lower()
        if kind not in ("in", "out"):
            return None, "Tur: in yoki out"

        # Avval GPS — ticketni behuda sarflamaslik
        ok_gps, dist_gps, gerr = self._gps_inside_office(settings, lat, lng, accuracy)
        if not ok_gps:
            return None, gerr or "Ofis zonasiga kiring"
        try:
            lat_f = float(lat) if lat is not None else None
            lng_f = float(lng) if lng is not None else None
        except (TypeError, ValueError):
            lat_f = lng_f = None
        if settings.get("require_gps", True):
            try:
                lat_f = float(lat)
                lng_f = float(lng)
            except (TypeError, ValueError):
                return None, "Joylashuv ruxsati kerak"

        face_score = None
        photo_out = None
        method = "office_qr"

        if settings.get("require_qr", True):
            terr = self.consume_qr_ticket(user_id, qr_ticket or "")
            if terr:
                return None, terr
            method = "office_qr"
        elif settings.get("require_face", False):
            ok_m, dist, merr = self.match_face(user_id, descriptor)
            if not ok_m:
                return None, merr or "Yuz tasdiqlanmadi"
            face_score = dist
            photo_c, perr = clean_photo(photo)
            if perr:
                return None, perr
            photo_out = photo_c
            method = "face_match"
            chal_err = self.consume_challenge(user_id, challenge or "", purpose=str(kind))
            if chal_err:
                return None, chal_err
        else:
            if challenge:
                chal_err = self.consume_challenge(user_id, challenge or "", purpose=str(kind))
                if chal_err:
                    return None, chal_err

        slot_ok, slot_msg, is_late = self._slot_ok(kind, settings)
        if not slot_ok:
            return None, slot_msg

        date = today_str()
        ts = now_tz().isoformat(timespec="seconds")
        with self.lock:
            day = self._load(self.day_key(date), {})
            if not isinstance(day, dict):
                day = {}
            urec = day.get(str(user_id))
            if not isinstance(urec, dict):
                urec = {
                    "userId": str(user_id),
                    "username": str(username or "")[:60],
                    "name": str(name or "")[:80],
                    "role": str(role or "")[:20],
                    "in": None,
                    "out": None,
                }
            if kind == "in" and urec.get("in"):
                return None, "Bugun kirish allaqachon qayd etilgan"
            if kind == "out":
                if not urec.get("in"):
                    return None, "Avval kirish (ertalab) dan o'ting"
                if urec.get("out"):
                    return None, "Bugun chiqish allaqachon qayd etilgan"

            entry = {
                "at": ts,
                "lat": lat_f,
                "lng": lng_f,
                "accuracy": float(accuracy) if accuracy is not None else None,
                "distance_m": round(dist_gps, 1) if dist_gps is not None else None,
                "face_score": round(float(face_score), 4) if face_score is not None else None,
                "late": bool(is_late) if kind == "in" else False,
                "method": method,
                "note": slot_msg,
                "photoHash": hashlib.sha256((photo_out or "")[:8000].encode("utf-8", "ignore")).hexdigest()[:16]
                if photo_out
                else None,
            }
            if photo_out and len(photo_out) < 400_000:
                entry["photo"] = photo_out

            urec[kind] = entry
            urec["updatedAt"] = ts
            day[str(user_id)] = urec
            self._save(self.day_key(date), day)

        return {
            "ok": True,
            "date": date,
            "kind": kind,
            "late": bool(is_late) if kind == "in" else False,
            "message": slot_msg,
            "faceMatched": False,
            "faceScore": entry.get("face_score"),
            "qrVerified": method == "office_qr",
            "record": urec,
            "distance_m": entry.get("distance_m"),
        }, None

    def user_history(self, user_id: str, limit: int = 60) -> list:
        """Oxirgi N kunlik shaxsiy davomat (yangi → eski)."""
        limit = max(1, min(180, int(limit or 60)))
        uid = str(user_id)
        rows = []
        try:
            keys = list(self.persist.keys(DAY_PREFIX) or [])
        except Exception:
            keys = []
        dates = []
        for k in keys:
            d = str(k).replace(DAY_PREFIX, "", 1)
            if len(d) == 10 and d[4] == "-" and d[7] == "-":
                dates.append(d)
        dates = sorted(set(dates), reverse=True)[:limit]
        for d in dates:
            day = self.day_records(d)
            rec = day.get(uid) if isinstance(day.get(uid), dict) else None
            if not rec:
                continue
            inn = rec.get("in") if isinstance(rec.get("in"), dict) else None
            out = rec.get("out") if isinstance(rec.get("out"), dict) else None
            worked = None
            if inn and out and inn.get("at") and out.get("at"):
                try:
                    t0 = datetime.fromisoformat(str(inn["at"]))
                    t1 = datetime.fromisoformat(str(out["at"]))
                    if t0.tzinfo is None:
                        t0 = t0.replace(tzinfo=TZ)
                    if t1.tzinfo is None:
                        t1 = t1.replace(tzinfo=TZ)
                    worked = max(0, int((t1 - t0).total_seconds()))
                except Exception:
                    worked = None
            status = "absent"
            if inn and out:
                status = "done"
            elif inn:
                status = "late" if inn.get("late") else "in"
            rows.append(
                {
                    "date": d,
                    "status": status,
                    "in": inn,
                    "out": out,
                    "worked_sec": worked,
                    "late": bool(inn.get("late")) if inn else False,
                }
            )
        return rows

    def board(self, date: str, users: list) -> dict:
        day = self.day_records(date)
        rows = []
        for u in users or []:
            uid = str(u.get("id") or "")
            if not uid:
                continue
            rec = day.get(uid) if isinstance(day.get(uid), dict) else {}
            inn = self._strip_punch(rec.get("in") if isinstance(rec.get("in"), dict) else None)
            out = self._strip_punch(rec.get("out") if isinstance(rec.get("out"), dict) else None)
            row = self._row_from_punches(u, date, inn, out)
            rows.append(row)
        counts = {
            "total": len(rows),
            "present": sum(1 for r in rows if r["status"] in ("in", "late", "done")),
            "late": sum(1 for r in rows if r["status"] == "late" or (r.get("late_in_min") or 0) > 0),
            "done": sum(1 for r in rows if r["status"] == "done"),
            "absent": sum(1 for r in rows if r["status"] == "absent"),
            "working": sum(1 for r in rows if r["status"] in ("in", "late")),
            "enrolled": sum(1 for r in rows if r.get("enrolled")),
            "late_in": sum(1 for r in rows if (r.get("late_in_min") or 0) > 0),
            "early_in": sum(1 for r in rows if (r.get("early_in_min") or 0) > 0),
            "early_out": sum(1 for r in rows if (r.get("early_out_min") or 0) > 0),
            "late_out": sum(1 for r in rows if (r.get("late_out_min") or 0) > 0),
        }
        sched = self._schedule_hhmm()
        return {
            "date": date,
            "rows": rows,
            "counts": counts,
            "schedule": sched,
            "settings": self.public_settings(),
        }

    def _schedule_hhmm(self) -> dict:
        s = self.settings()
        return {
            "in_start": s.get("in_start") or "09:00",
            "out_start": s.get("out_start") or "18:00",
            "in_late_after": s.get("in_late_after") or "09:15",
            "label": f"{s.get('in_start') or '09:00'}–{s.get('out_start') or '18:00'}",
        }

    @staticmethod
    def _min_of_iso(iso_s) -> int | None:
        if not iso_s:
            return None
        try:
            t = datetime.fromisoformat(str(iso_s))
            if t.tzinfo is None:
                t = t.replace(tzinfo=TZ)
            t = t.astimezone(TZ)
            return t.hour * 60 + t.minute
        except Exception:
            return None

    @staticmethod
    def _fmt_min_uz(mins: int | None) -> str:
        if mins is None or mins <= 0:
            return ""
        m = int(mins)
        h, mi = divmod(m, 60)
        if h and mi:
            return f"{h} soat {mi} daq"
        if h:
            return f"{h} soat"
        return f"{mi} daq"

    def _punctuality(self, inn, out, settings: dict | None = None) -> dict:
        s = settings or self.settings()
        in_start = hhmm_to_min(s.get("in_start") or "09:00") or 9 * 60
        out_start = hhmm_to_min(s.get("out_start") or "18:00") or 18 * 60
        late_in = early_in = early_out = late_out = 0
        in_min = self._min_of_iso(inn.get("at") if inn else None)
        out_min = self._min_of_iso(out.get("at") if out else None)
        if in_min is not None:
            if in_min > in_start:
                late_in = in_min - in_start
            elif in_min < in_start:
                early_in = in_start - in_min
        if out_min is not None:
            if out_min < out_start:
                early_out = out_start - out_min
            elif out_min > out_start:
                late_out = out_min - out_start
        return {
            "late_in_min": late_in,
            "early_in_min": early_in,
            "early_out_min": early_out,
            "late_out_min": late_out,
            "late_in_txt": self._fmt_min_uz(late_in),
            "early_in_txt": self._fmt_min_uz(early_in),
            "early_out_txt": self._fmt_min_uz(early_out),
            "late_out_txt": self._fmt_min_uz(late_out),
        }

    @staticmethod
    def _lavozim(u: dict) -> str:
        role = str(u.get("role") or "")
        if role == "driver":
            return "Haydovchi"
        if role == "admin_pro":
            return "Admin Pro"
        if role == "admin":
            return "Admin"
        return role or "Xodim"

    def _row_from_punches(self, u: dict, date: str, inn, out) -> dict:
        uid = str(u.get("id") or "")
        status = "absent"
        if inn and out:
            status = "done"
        elif inn:
            status = "late" if inn.get("late") else "in"
        # Display holat: Kechikdi if late minutes or flag
        pun = self._punctuality(inn, out)
        if status != "absent" and (pun["late_in_min"] > 0 or (inn and inn.get("late"))):
            status = "late"
        elif status == "done" or status == "in":
            status = "done" if out else "in"
        return {
            "userId": uid,
            "username": u.get("username"),
            "name": u.get("name"),
            "role": u.get("role"),
            "lavozim": self._lavozim(u),
            "car": u.get("car") or "",
            "date": date,
            "status": status,
            "in": inn,
            "out": out,
            "inAt": self._hhmm_from_iso(inn.get("at") if inn else None),
            "outAt": self._hhmm_from_iso(out.get("at") if out else None),
            "worked_sec": self._worked_sec(inn, out),
            "enrolled": self.is_enrolled(uid),
            **pun,
        }

    @staticmethod
    def _dates_between(d0: str, d1: str) -> list[str]:
        try:
            a = datetime.strptime(d0, "%Y-%m-%d").replace(tzinfo=TZ)
            b = datetime.strptime(d1, "%Y-%m-%d").replace(tzinfo=TZ)
        except Exception:
            return []
        if b < a:
            a, b = b, a
        # max 93 days
        out = []
        cur = a
        n = 0
        while cur <= b and n < 93:
            out.append(cur.strftime("%Y-%m-%d"))
            cur += timedelta(days=1)
            n += 1
        return out

    def hisobot(self, period: str, users: list, date: str = "", date_from: str = "", date_to: str = "") -> dict:
        """Kunlik / haftalik / oylik / oralik — xodim qatorlari + kech/erta metrikalari."""
        today = today_str()
        period = (period or "day").strip().lower()
        if period in ("kunlik", "daily"):
            period = "day"
        elif period in ("haftalik", "weekly"):
            period = "week"
        elif period in ("oylik", "monthly"):
            period = "month"
        elif period in ("range", "oralik", "custom", "sanadan"):
            period = "range"

        if period == "day":
            d = date if re.match(r"^\d{4}-\d{2}-\d{2}$", str(date or "")) else today
            dates = [d]
        elif period == "week":
            d = date if re.match(r"^\d{4}-\d{2}-\d{2}$", str(date or "")) else today
            try:
                base = datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=TZ)
            except Exception:
                base = now_tz()
            # Dushanba boshlanish
            start = base - timedelta(days=base.weekday())
            dates = [(start + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
            d = dates[0]
        elif period == "month":
            month = (date or today)[:7]
            if not re.match(r"^\d{4}-\d{2}$", month):
                month = today[:7]
            dates = [x for x in self._month_dates(month) if x <= today]
            d = month + "-01"
        else:
            df = date_from if re.match(r"^\d{4}-\d{2}-\d{2}$", str(date_from or "")) else today
            dt = date_to if re.match(r"^\d{4}-\d{2}-\d{2}$", str(date_to or "")) else today
            dates = [x for x in self._dates_between(df, dt) if x <= today]
            d = df

        show_date_col = period != "day"
        rows = []
        day_cache = {dd: self.day_records(dd) for dd in dates}
        for dd in dates:
            day = day_cache.get(dd) or {}
            for u in users or []:
                uid = str(u.get("id") or "")
                if not uid:
                    continue
                urec = day.get(uid) if isinstance(day.get(uid), dict) else {}
                inn = self._strip_punch(urec.get("in") if isinstance(urec.get("in"), dict) else None)
                out = self._strip_punch(urec.get("out") if isinstance(urec.get("out"), dict) else None)
                # Multi-day: faqat kelganlarni ko‘rsatish (bo‘sh qatorlarni kesish) — oylik/hafta uchun
                if show_date_col and not inn and not out:
                    continue
                rows.append(self._row_from_punches(u, dd, inn, out))

        # Kunlik: barcha xodimlar (yo‘qlik ham)
        if not show_date_col:
            rows.sort(key=lambda r: (
                0 if r["status"] != "absent" else 1,
                0 if r["status"] == "late" else 1,
                str(r.get("name") or r.get("username") or "").lower(),
            ))
        else:
            rows.sort(key=lambda r: (r.get("date") or "", str(r.get("name") or "").lower()), reverse=True)

        stats = {
            "late_in": sum(1 for r in rows if (r.get("late_in_min") or 0) > 0),
            "early_in": sum(1 for r in rows if (r.get("early_in_min") or 0) > 0),
            "early_out": sum(1 for r in rows if (r.get("early_out_min") or 0) > 0),
            "late_out": sum(1 for r in rows if (r.get("late_out_min") or 0) > 0),
            "present": sum(1 for r in rows if r["status"] != "absent"),
            "absent": sum(1 for r in rows if r["status"] == "absent"),
            "shown": len(rows),
            "people": len(users or []),
        }
        sched = self._schedule_hhmm()
        return {
            "period": period,
            "date": d,
            "dateFrom": dates[0] if dates else d,
            "dateTo": dates[-1] if dates else d,
            "dates": dates,
            "showDateCol": show_date_col,
            "schedule": sched,
            "rows": rows,
            "stats": stats,
            "settings": self.public_settings(),
        }

    @staticmethod
    def _strip_punch(p: dict | None) -> dict | None:
        if not isinstance(p, dict):
            return None
        out = {k: v for k, v in p.items() if k != "photo"}
        return out

    @staticmethod
    def _worked_sec(inn, out) -> int | None:
        if not inn or not out or not inn.get("at") or not out.get("at"):
            return None
        try:
            t0 = datetime.fromisoformat(str(inn["at"]))
            t1 = datetime.fromisoformat(str(out["at"]))
            if t0.tzinfo is None:
                t0 = t0.replace(tzinfo=TZ)
            if t1.tzinfo is None:
                t1 = t1.replace(tzinfo=TZ)
            return max(0, int((t1 - t0).total_seconds()))
        except Exception:
            return None

    @staticmethod
    def _month_dates(month: str) -> list[str]:
        """month = YYYY-MM → shu oydagi barcha sanalar."""
        m = re.match(r"^(\d{4})-(\d{2})$", str(month or "").strip())
        if not m:
            return []
        y, mo = int(m.group(1)), int(m.group(2))
        if mo < 1 or mo > 12:
            return []
        if mo == 12:
            nxt = datetime(y + 1, 1, 1, tzinfo=TZ)
        else:
            nxt = datetime(y, mo + 1, 1, tzinfo=TZ)
        cur = datetime(y, mo, 1, tzinfo=TZ)
        out = []
        while cur < nxt:
            out.append(cur.strftime("%Y-%m-%d"))
            cur += timedelta(days=1)
        return out

    @staticmethod
    def _hhmm_from_iso(iso_s) -> str | None:
        if not iso_s:
            return None
        try:
            t = datetime.fromisoformat(str(iso_s))
            if t.tzinfo is None:
                t = t.replace(tzinfo=TZ)
            t = t.astimezone(TZ)
            return f"{t.hour:02d}:{t.minute:02d}"
        except Exception:
            return None

    @staticmethod
    def _hhmmss_from_iso(iso_s) -> str | None:
        """To‘liq o‘tish vaqti HH:MM:SS (Toshkent)."""
        if not iso_s:
            return None
        try:
            t = datetime.fromisoformat(str(iso_s))
            if t.tzinfo is None:
                t = t.replace(tzinfo=TZ)
            t = t.astimezone(TZ)
            return f"{t.hour:02d}:{t.minute:02d}:{t.second:02d}"
        except Exception:
            return None

    def month_report(self, month: str, users: list) -> dict:
        """Admin: oy bo'yicha jamoa hisoboti + KPI."""
        dates = self._month_dates(month)
        if not dates:
            today = today_str()
            month = today[:7]
            dates = self._month_dates(month)
        day_cache = {d: self.day_records(d) for d in dates}
        people = []
        sum_late = 0
        sum_present_days = 0
        sum_absent_days = 0
        arrival_mins = []

        for u in users or []:
            uid = str(u.get("id") or "")
            if not uid:
                continue
            days = []
            present = 0
            late_n = 0
            absent = 0
            worked_total = 0
            user_arrivals = []
            for d in dates:
                # Kelajak kunlar — hisobga olmaymiz
                if d > today_str():
                    continue
                rec = day_cache.get(d) or {}
                urec = rec.get(uid) if isinstance(rec.get(uid), dict) else None
                inn = self._strip_punch(
                    urec.get("in") if urec and isinstance(urec.get("in"), dict) else None
                )
                out = self._strip_punch(
                    urec.get("out") if urec and isinstance(urec.get("out"), dict) else None
                )
                status = "absent"
                if inn and out:
                    status = "done"
                elif inn:
                    status = "late" if inn.get("late") else "in"
                if status == "absent":
                    absent += 1
                else:
                    present += 1
                    if inn and inn.get("late"):
                        late_n += 1
                    hhmm = self._hhmm_from_iso(inn.get("at") if inn else None)
                    if hhmm:
                        try:
                            h, mi = map(int, hhmm.split(":"))
                            user_arrivals.append(h * 60 + mi)
                            arrival_mins.append(h * 60 + mi)
                        except ValueError:
                            pass
                ws = self._worked_sec(inn, out)
                if ws is not None:
                    worked_total += ws
                days.append(
                    {
                        "date": d,
                        "status": status,
                        "inAt": self._hhmmss_from_iso(inn.get("at") if inn else None),
                        "outAt": self._hhmmss_from_iso(out.get("at") if out else None),
                        "late": bool(inn.get("late")) if inn else False,
                        "worked_sec": ws,
                        "distance_m": (inn or {}).get("distance_m") if inn else None,
                    }
                )
            avg_in = None
            if user_arrivals:
                avg_m = int(sum(user_arrivals) / len(user_arrivals))
                avg_in = f"{avg_m // 60:02d}:{avg_m % 60:02d}"
            sum_late += late_n
            sum_present_days += present
            sum_absent_days += absent
            people.append(
                {
                    "userId": uid,
                    "username": u.get("username"),
                    "name": u.get("name"),
                    "role": u.get("role"),
                    "car": u.get("car") or "",
                    "enrolled": self.is_enrolled(uid),
                    "presentDays": present,
                    "lateDays": late_n,
                    "absentDays": absent,
                    "avgIn": avg_in,
                    "worked_sec": worked_total,
                    "days": days,
                }
            )

        people.sort(
            key=lambda x: (
                -(x["presentDays"]),
                x["lateDays"],
                str(x.get("name") or "").lower(),
            )
        )
        avg_arrival = None
        if arrival_mins:
            am = int(sum(arrival_mins) / len(arrival_mins))
            avg_arrival = f"{am // 60:02d}:{am % 60:02d}"

        today_board = self.board(today_str(), users)
        return {
            "month": month,
            "dates": [d for d in dates if d <= today_str()],
            "summary": {
                "people": len(people),
                "enrolled": sum(1 for p in people if p.get("enrolled")),
                "presentDays": sum_present_days,
                "lateDays": sum_late,
                "absentDays": sum_absent_days,
                "avgArrival": avg_arrival,
                "today": today_board.get("counts") or {},
            },
            "people": people,
            "todayBoard": today_board,
            "settings": self.public_settings(),
        }

    def person_month(self, user_id: str, month: str, user_meta: dict | None = None) -> dict:
        """Bitta foydalanuvchi — oy kalendari + statistika."""
        dates = self._month_dates(month)
        if not dates:
            month = today_str()[:7]
            dates = self._month_dates(month)
        uid = str(user_id)
        meta = user_meta or {}
        days = []
        present = late_n = absent = 0
        worked_total = 0
        arrivals = []
        for d in dates:
            future = d > today_str()
            rec = self.day_records(d)
            urec = rec.get(uid) if isinstance(rec.get(uid), dict) else None
            inn = self._strip_punch(
                urec.get("in") if urec and isinstance(urec.get("in"), dict) else None
            )
            out = self._strip_punch(
                urec.get("out") if urec and isinstance(urec.get("out"), dict) else None
            )
            if future:
                status = "future"
            elif inn and out:
                status = "done"
                present += 1
            elif inn:
                status = "late" if inn.get("late") else "in"
                present += 1
            else:
                status = "absent"
                absent += 1
            if inn and inn.get("late"):
                late_n += 1
            hhmm = self._hhmm_from_iso(inn.get("at") if inn else None)
            if hhmm and not future:
                try:
                    h, mi = map(int, hhmm.split(":"))
                    arrivals.append(h * 60 + mi)
                except ValueError:
                    pass
            ws = self._worked_sec(inn, out)
            if ws is not None:
                worked_total += ws
            days.append(
                {
                    "date": d,
                    "weekday": datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=TZ).strftime("%a"),
                    "status": status,
                    "inAt": self._hhmmss_from_iso(inn.get("at") if inn else None),
                    "outAt": self._hhmmss_from_iso(out.get("at") if out else None),
                    "late": bool(inn.get("late")) if inn else False,
                    "worked_sec": ws,
                    "distance_m": (inn or {}).get("distance_m") if inn else None,
                    "note": (inn or {}).get("note") if inn else None,
                }
            )
        avg_in = None
        if arrivals:
            am = int(sum(arrivals) / len(arrivals))
            avg_in = f"{am // 60:02d}:{am % 60:02d}"
        return {
            "month": month,
            "user": {
                "userId": uid,
                "username": meta.get("username"),
                "name": meta.get("name"),
                "role": meta.get("role"),
                "car": meta.get("car") or "",
                "enrolled": self.is_enrolled(uid),
            },
            "stats": {
                "presentDays": present,
                "lateDays": late_n,
                "absentDays": absent,
                "avgIn": avg_in,
                "worked_sec": worked_total,
                "workDays": present + absent,
            },
            "days": days,
            "settings": self.public_settings(),
        }

    def public_settings(self, user: dict | None = None) -> dict:
        s = self.settings_for_user(user) if user else self.settings()
        office = s.get("office") or {}
        return {
            "enabled": bool(s.get("enabled", True)),
            "require_gps": bool(s.get("require_gps", True)),
            "require_face": False,
            "require_qr": bool(s.get("require_qr", True)),
            "qrTicketTtlMin": QR_TICKET_TTL_MIN,
            "in_start": s.get("in_start"),
            "in_end": s.get("in_end"),
            "in_late_after": s.get("in_late_after"),
            "late_grace_min": int(s.get("late_grace_min") or 15),
            "out_start": s.get("out_start"),
            "out_end": s.get("out_end"),
            "office": {
                "label": office.get("label"),
                "radius_m": office.get("radius_m"),
                "lat": office.get("lat"),
                "lng": office.get("lng"),
            },
            "serverNow": now_tz().isoformat(timespec="seconds"),
            "today": today_str(),
            "scheduleNote": (
                f"{s.get('in_start')}-{s.get('out_start')} · "
                f"{int(s.get('late_grace_min') or 15)} daqiqa ruxsat "
                f"({s.get('in_late_after')} gacha kechikish yo'q)"
            ),
        }

    def me_payload(self, user_id: str, user: dict) -> dict:
        date = today_str()
        uinfo = {
            "id": user_id,
            "username": user.get("username"),
            "name": user.get("name"),
            "role": user.get("role"),
        }
        today_rec = self.user_day(date, user_id)
        # UI uchun to‘liq soatlar
        if isinstance(today_rec.get("in"), dict) and today_rec["in"].get("at"):
            today_rec = dict(today_rec)
            inn = dict(today_rec["in"])
            inn["atDisplay"] = self._hhmmss_from_iso(inn.get("at"))
            today_rec["in"] = inn
        if isinstance(today_rec.get("out"), dict) and today_rec["out"].get("at"):
            today_rec = dict(today_rec)
            out = dict(today_rec["out"])
            out["atDisplay"] = self._hhmmss_from_iso(out.get("at"))
            today_rec["out"] = out
        ticket = self.get_qr_ticket(user_id)
        return {
            "ok": True,
            "settings": self.public_settings(uinfo),
            "enrolled": True,
            "attendanceReady": True,
            "qrReady": True,
            "qrTicket": ticket,
            "face": None,
            "today": today_rec,
            "history": self.user_history(user_id, 45),
            "user": uinfo,
            "serverNow": now_tz().isoformat(timespec="seconds"),
        }
