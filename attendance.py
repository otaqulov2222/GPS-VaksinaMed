# -*- coding: utf-8 -*-
"""Davomat: Face ulash + kirish/chiqish (GPS + vaqt + biometriya)."""

from __future__ import annotations

import hashlib
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

DEFAULT_SETTINGS = {
    "office": {
        "lat": 41.219119,
        "lng": 69.272688,
        "radius_m": 250,
        "label": "VaksinaMed ofis",
    },
    "in_start": "08:30",
    "in_end": "10:30",
    "in_late_after": "09:15",
    "out_start": "17:00",
    "out_end": "21:00",
    "require_gps": True,
    "require_face": True,
    "enabled": True,
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
            return out

    def save_settings(self, patch: dict) -> dict:
        cur = self.settings()
        if not isinstance(patch, dict):
            return cur
        for k in (
            "in_start", "in_end", "in_late_after",
            "out_start", "out_end", "require_gps", "require_face", "enabled",
        ):
            if k in patch:
                cur[k] = patch[k]
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
        f = self.get_face(user_id)
        return bool(f and f.get("descriptor"))

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
        photo_c, err = clean_photo(photo)
        if err:
            return None, err
        desc, derr = clean_descriptor(descriptor)
        if derr:
            return None, derr
        if not desc:
            return None, "Yuz aniqlanmadi. Kameraga to'g'ri qarang va qayta urinib ko'ring."
        cid = str(credential_id or "").strip()[:200]
        rec = {
            "userId": str(user_id),
            "username": str(username or "")[:60],
            "name": str(name or "")[:80],
            "photo": photo_c,
            "descriptor": desc,
            "credentialId": cid or None,
            "enrolledAt": now_tz().isoformat(timespec="seconds"),
            "updatedAt": now_tz().isoformat(timespec="seconds"),
        }
        with self.lock:
            self._save(self.face_key(user_id), rec)
        return {
            "enrolled": True,
            "hasPhoto": bool(photo_c),
            "hasDescriptor": True,
            "hasWebAuthn": bool(cid),
            "enrolledAt": rec["enrolledAt"],
        }, None

    def match_face(self, user_id: str, descriptor) -> tuple[bool, float, str | None]:
        face = self.get_face(user_id)
        if not face or not face.get("descriptor"):
            return False, 99.0, "Avval Face ulash qiling"
        desc, err = clean_descriptor(descriptor)
        if err or not desc:
            return False, 99.0, err or "Yuz o'qilmadi"
        stored = face.get("descriptor")
        if len(desc) != len(stored):
            return False, 99.0, "Yuz modeli mos emas — Face ni qayta ulang"
        dist = face_distance(stored, desc)
        if dist <= FACE_MATCH_MAX:
            return True, dist, None
        return False, dist, "Yuz mos kelmadi. O'zingizni skanerlang yoki yorug'likni yaxshilang."

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

        Keldim: in_start dan kun oxirigacha (tavsiya oynasi in_end).
        Ketdim: kirishdan keyin, out_end gacha (erta chiqish ham mumkin).
        """
        now_m = minutes_now()
        if kind == "in":
            a = hhmm_to_min(settings.get("in_start"))
            late_after = hhmm_to_min(settings.get("in_late_after"))
            # Tavsiya tugashi — faqat kechikish matni uchun; bloklamaydi
            day_end = hhmm_to_min(settings.get("out_end")) or (23 * 60 + 59)
            if a is None:
                return False, "Kirish vaqti sozlanmagan", False
            if now_m < a:
                return False, f"Kirish hali ochilmagan ({settings.get('in_start')} dan)", False
            if now_m > day_end:
                return False, f"Bugungi ish kuni yopildi ({settings.get('out_end')})", False
            late = bool(late_after is not None and now_m > late_after)
            return True, ("Kechikib keldi" if late else "O'z vaqtida"), late
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
    ) -> tuple[dict | None, str | None]:
        settings = self.settings()
        if not settings.get("enabled", True):
            return None, "Davomat hozir o'chirilgan"

        kind = str(kind or "").strip().lower()
        if kind not in ("in", "out"):
            return None, "Tur: in yoki out"

        face_score = None
        if settings.get("require_face", True):
            ok_m, dist, merr = self.match_face(user_id, descriptor)
            if not ok_m:
                return None, merr or "Yuz tasdiqlanmadi"
            face_score = dist
            photo_c, perr = clean_photo(photo)
            if perr:
                return None, perr
            photo = photo_c
        else:
            photo_c, perr = clean_photo(photo)
            if perr:
                return None, perr
            photo = photo_c

        # GPS
        dist_gps = None
        office = settings.get("office") or {}
        if settings.get("require_gps", True):
            try:
                lat_f = float(lat)
                lng_f = float(lng)
            except (TypeError, ValueError):
                return None, "Joylashuv ruxsati kerak"
            try:
                olat = float(office.get("lat"))
                olng = float(office.get("lng"))
                radius = float(office.get("radius_m") or 250)
            except (TypeError, ValueError):
                return None, "Ofis geozonasi sozlanmagan"
            dist_gps = haversine_m(lat_f, lng_f, olat, olng)
            if dist_gps > radius:
                return None, (
                    f"Ofis zonasi tashqarisida ({int(dist_gps)} m). "
                    f"Radius: {int(radius)} m."
                )
        else:
            try:
                lat_f = float(lat) if lat is not None else None
                lng_f = float(lng) if lng is not None else None
            except (TypeError, ValueError):
                lat_f = lng_f = None

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
                "method": "face_match",
                "note": slot_msg,
                "photoHash": hashlib.sha256((photo or "")[:8000].encode("utf-8", "ignore")).hexdigest()[:16]
                if photo
                else None,
            }
            if photo and len(photo) < 400_000:
                entry["photo"] = photo

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
            "faceMatched": True,
            "faceScore": entry.get("face_score"),
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
            inn = rec.get("in") if isinstance(rec.get("in"), dict) else None
            out = rec.get("out") if isinstance(rec.get("out"), dict) else None
            status = "absent"
            if inn and out:
                status = "done"
            elif inn:
                status = "late" if inn.get("late") else "in"
            rows.append(
                {
                    "userId": uid,
                    "username": u.get("username"),
                    "name": u.get("name"),
                    "role": u.get("role"),
                    "car": u.get("car") or "",
                    "status": status,
                    "in": inn,
                    "out": out,
                    "enrolled": self.is_enrolled(uid),
                }
            )
        return {"date": date, "rows": rows, "settings": self.public_settings()}

    def public_settings(self) -> dict:
        s = self.settings()
        office = s.get("office") or {}
        return {
            "enabled": bool(s.get("enabled", True)),
            "require_gps": bool(s.get("require_gps", True)),
            "require_face": bool(s.get("require_face", True)),
            "in_start": s.get("in_start"),
            "in_end": s.get("in_end"),
            "in_late_after": s.get("in_late_after"),
            "out_start": s.get("out_start"),
            "out_end": s.get("out_end"),
            "office": {
                "label": office.get("label"),
                "radius_m": office.get("radius_m"),
                # lat/lng admin sozlaydi; clientga kerak geozona tekshiruvi uchun
                "lat": office.get("lat"),
                "lng": office.get("lng"),
            },
            "serverNow": now_tz().isoformat(timespec="seconds"),
            "today": today_str(),
        }

    def me_payload(self, user_id: str, user: dict) -> dict:
        face = self.get_face(user_id)
        date = today_str()
        photo = None
        if face and isinstance(face.get("photo"), str) and face["photo"].startswith("data:image/"):
            # O'z profilining tasdiqlangan selfisi (UI preview)
            photo = face["photo"] if len(face["photo"]) <= _MAX_PHOTO else None
        return {
            "ok": True,
            "settings": self.public_settings(),
            "enrolled": self.is_enrolled(user_id),
            "face": {
                "hasPhoto": bool(photo or (face and face.get("photo"))),
                "hasDescriptor": bool(face and face.get("descriptor")),
                "hasWebAuthn": bool(face and face.get("credentialId")),
                "credentialId": (face or {}).get("credentialId"),
                "enrolledAt": (face or {}).get("enrolledAt"),
                "photo": photo,
            }
            if face
            else None,
            "today": self.user_day(date, user_id),
            "history": self.user_history(user_id, 45),
            "user": {
                "id": user_id,
                "username": user.get("username"),
                "name": user.get("name"),
                "role": user.get("role"),
            },
        }
