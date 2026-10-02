# -*- coding: utf-8 -*-
"""Yuk chiqishi nazorati: belgilangan mashinalar ofis/sklad hududidan muddatgacha chiqishi kerak."""

from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timedelta

DEFAULT_RULE = {
    "enabled": True,
    "deadline": "09:30",
    "since": "2026-10-01",
    "plates": ["255", "043", "302", "205", "309", "269", "592", "382", "949"],
}

# Hudud ichidagi qisqa harakat (ofis ↔ sklad, darvoza oldida to'xtash) bitta blok hisoblanadi.
BRIDGE_GAP_SEC = 15 * 60
BRIDGE_OUTSIDE_SEC = 3 * 60
# Tungi qatnovlar ertalabki yuk chiqishi emas.
MORNING_FROM_SEC = 5 * 3600
# Shundan keyin chiqsa — yuk umuman olib chiqilmagan (ish kuni oxiri).
NO_TRIP_SEC = 17 * 3600
MOVED_KM = 3.0

COUNTED_LATE = ("late", "waiting", "no_trip")

STATUS_LABEL = {
    "ok": "O'z vaqtida chiqdi",
    "late": "Yuk chiqishi kechikdi",
    "waiting": "Yuk hali chiqmagan",
    "no_trip": "Kun bo'yi hududda",
    "pending": "Kutilmoqda",
    "not_arrived": "Ofisga kelmagan",
    "no_office": "Ofisga kirmagan",
    "idle": "Ishlamagan",
    "nodata": "GPS ma'lumot yo'q",
    "off": "Dam kuni",
}


FULL_PLATE_RE = re.compile(r"^\d{2}\s*\d{3}\s*[A-Z]{2,3}$")


def plate_number(plate) -> str:
    digits = re.sub(r"\D", "", str(plate or ""))
    return digits[2:] if len(digits) > 3 else digits


def clean_rule(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    rule = dict(DEFAULT_RULE)
    if "enabled" in raw:
        rule["enabled"] = bool(raw.get("enabled"))
    dl = str(raw.get("deadline") or "").strip()
    if re.match(r"^([01]\d|2[0-3]):[0-5]\d$", dl):
        rule["deadline"] = dl
    since = str(raw.get("since") or "").strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", since):
        rule["since"] = since
    plates = raw.get("plates")
    if isinstance(plates, str):
        plates = re.split(r"[,;\n]+", plates)
    if isinstance(plates, list):
        nums = []
        for piece in plates:
            piece = str(piece or "").strip().upper()
            tokens = [piece] if FULL_PLATE_RE.match(piece) else piece.split()
            for p in tokens:
                n = plate_number(p) if len(re.sub(r"\D", "", p)) > 3 else re.sub(r"\D", "", p)
                if n and n not in nums:
                    nums.append(n)
        rule["plates"] = nums[:60]
    return rule


def is_tracked(plate, rule) -> bool:
    return bool(rule.get("enabled")) and plate_number(plate) in (rule.get("plates") or [])


def _sec(hms) -> int | None:
    m = re.match(r"^(\d{1,2}):(\d{2})(?::(\d{2}))?$", str(hms or "").strip())
    if not m:
        return None
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3) or 0)


def _hhmm(sec) -> str:
    sec = max(0, int(sec))
    return f"{sec // 3600:02d}:{(sec % 3600) // 60:02d}"


def office_blocks(stops) -> list[dict]:
    """Ketma-ket ofis/sklad to'xtashlari → hududda turish bloklari."""
    blocks: list[dict] = []
    outside = 0
    for idx, s in enumerate(stops or []):
        if not isinstance(s, dict):
            continue
        a, b = _sec(s.get("inTime")), _sec(s.get("outTime"))
        if a is None or b is None:
            continue
        if not s.get("isOffice"):
            outside += max(0, b - a)
            continue
        last = blocks[-1] if blocks else None
        if last and a - last["end"] <= BRIDGE_GAP_SEC and outside <= BRIDGE_OUTSIDE_SEC:
            last["end"] = max(last["end"], b)
            last["lastIdx"] = idx
        else:
            blocks.append({"start": a, "end": b, "firstIdx": idx, "lastIdx": idx})
        outside = 0
    n = len(stops or [])
    for blk in blocks:
        blk["isLast"] = blk["lastIdx"] == n - 1
    return blocks


def evaluate(rec, date: str, rule: dict, now: datetime | None = None) -> dict:
    """Bitta mashina, bitta kun → yuk chiqishi holati."""
    deadline = _sec(rule.get("deadline")) or _sec(DEFAULT_RULE["deadline"])
    out = {"deadline": _hhmm(deadline), "status": "nodata", "departAt": None, "arriveAt": None, "lateMin": 0}
    try:
        day = datetime.strptime(date, "%Y-%m-%d")
    except (TypeError, ValueError):
        return out
    today = now.strftime("%Y-%m-%d") if now else ""
    is_today = date == today
    now_sec = now.hour * 3600 + now.minute * 60 + now.second if now and is_today else None
    if date > today and today:
        out["status"] = "pending"
        return out
    if day.weekday() == 6:
        out["status"] = "off"
        return out

    rec = rec if isinstance(rec, dict) else {}
    stops = rec.get("stops") if isinstance(rec.get("stops"), list) else []
    km = float(((rec.get("stats") or {}).get("probeg")) or 0)
    blocks = [b for b in office_blocks(stops) if b["end"] >= MORNING_FROM_SEC or (is_today and b["isLast"])]
    morning = blocks[0] if blocks else None

    if not morning:
        if is_today and now_sec is not None and now_sec <= deadline:
            out["status"] = "pending"
        elif is_today and now_sec is not None:
            out["status"] = "not_arrived"
            out["lateMin"] = (now_sec - deadline) // 60
        elif not stops and km < MOVED_KM:
            out["status"] = "nodata"
        else:
            out["status"] = "no_office" if km >= MOVED_KM else "idle"
        return out

    if morning["start"] < MORNING_FROM_SEC:
        out["overnight"] = True
    else:
        out["arriveAt"] = _hhmm(morning["start"])
    ongoing = is_today and morning["isLast"]
    if ongoing:
        cur = max(now_sec or 0, morning["end"])
        if cur // 60 * 60 <= deadline:
            out["status"] = "pending"
        elif cur >= NO_TRIP_SEC:
            out["status"] = "no_trip"
        else:
            out["status"] = "waiting"
            out["lateMin"] = (cur - deadline) // 60
        return out

    end = morning["end"]
    if km < MOVED_KM:
        out["status"] = "idle"
        return out
    out["departAt"] = _hhmm(end)
    if end // 60 * 60 <= deadline:
        out["status"] = "ok"
    elif end >= NO_TRIP_SEC:
        out["status"] = "no_trip"
    else:
        out["status"] = "late"
        out["lateMin"] = (end - deadline) // 60
    return out


def summarize(days: list[dict]) -> dict:
    late = [d for d in days if d.get("status") in COUNTED_LATE and not d.get("excused")]
    return {
        "late": len(late),
        "noTrip": sum(1 for d in late if d.get("status") == "no_trip"),
        "lateMin": sum(int(d.get("lateMin") or 0) for d in late),
        "ok": sum(1 for d in days if d.get("status") == "ok"),
        "excused": sum(1 for d in days if d.get("excused") and d.get("status") in COUNTED_LATE),
        "noOffice": sum(1 for d in days if d.get("status") in ("no_office", "not_arrived") and not d.get("excused")),
        "lateDates": [d.get("date") for d in late],
    }


RULE_KEY = "office:deprule"
NOTES_PREFIX = "office:depnotes:"
DAY_ALL = "*"
TODAY_CACHE_SEC = 60
# Hisobotni GitHub cron boshqa jarayondan yozishi mumkin — o'tgan kunlar ham eskiradi.
PAST_CACHE_SEC = 600
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
MONTH_RE = re.compile(r"^\d{4}-\d{2}$")


def _compact(plate) -> str:
    return re.sub(r"\s+", "", str(plate or "").upper())


def month_dates(month: str) -> list[str]:
    try:
        d = datetime.strptime(month + "-01", "%Y-%m-%d")
    except (TypeError, ValueError):
        return []
    out = []
    while d.strftime("%Y-%m") == month:
        out.append(d.strftime("%Y-%m-%d"))
        d += timedelta(days=1)
    return out


class DepartureService:
    """GPS hisobotlari + admin izohlari → yuk chiqishi holati.

    excuse_fn(date, plate) -> str | None: davomat bo'yicha avtomatik uzr (kelmagan, ta'til).
    """

    def __init__(self, persist, get_report, tz, excuse_fn=None):
        self.persist = persist
        self.get_report = get_report
        self.tz = tz
        self.excuse_fn = excuse_fn
        self.lock = threading.Lock()
        self._cache: dict[str, tuple[float, dict]] = {}

    def now(self) -> datetime:
        return datetime.now(self.tz).replace(tzinfo=None)

    def rule(self) -> dict:
        raw = self.persist.get(RULE_KEY)
        rule = clean_rule(raw)
        if isinstance(raw, dict):
            for k in ("updatedBy", "updatedAt"):
                if raw.get(k):
                    rule[k] = str(raw[k])[:60]
        return rule

    def save_rule(self, raw, by: str = "") -> dict:
        rule = clean_rule(raw)
        rule["updatedBy"] = str(by or "")[:60]
        rule["updatedAt"] = self.now().strftime("%Y-%m-%dT%H:%M:%S")
        self.persist.put(RULE_KEY, rule)
        self.invalidate()
        return rule

    def invalidate(self, date: str | None = None) -> None:
        with self.lock:
            if date:
                self._cache.pop(date, None)
            else:
                self._cache.clear()

    def notes_month(self, month: str) -> dict:
        data = self.persist.get(NOTES_PREFIX + month) if MONTH_RE.match(str(month or "")) else None
        return data if isinstance(data, dict) else {}

    def set_note(self, date: str, plate: str, note: str, excused: bool, by: str = "") -> tuple[dict | None, str | None]:
        if not DATE_RE.match(str(date or "")):
            return None, "Sana noto'g'ri"
        key = DAY_ALL if str(plate or "").strip() == DAY_ALL else _compact(plate)
        if not key:
            return None, "Mashina ko'rsatilmagan"
        note = re.sub(r"\s+", " ", str(note or "")).strip()[:300]
        month = date[:7]
        with self.lock:
            data = self.notes_month(month)
            day = data.get(date) if isinstance(data.get(date), dict) else {}
            if not note and not excused:
                day.pop(key, None)
                entry = None
            else:
                entry = {
                    "note": note,
                    "excused": bool(excused),
                    "by": str(by or "")[:60],
                    "at": self.now().strftime("%Y-%m-%dT%H:%M:%S"),
                }
                day[key] = entry
            if day:
                data[date] = day
            else:
                data.pop(date, None)
            self.persist.put(NOTES_PREFIX + month, data)
        return entry or {"note": "", "excused": False}, None

    def _eval_day(self, date: str, rule: dict) -> dict:
        """Faqat GPS qismi (kesh). {compactPlate: {...}}."""
        now = self.now()
        today = now.strftime("%Y-%m-%d")
        stamp = time.time()
        with self.lock:
            hit = self._cache.get(date)
            ttl = TODAY_CACHE_SEC if date == today else PAST_CACHE_SEC
            if hit and stamp - hit[0] < ttl and hit[1].get("_rule") == rule:
                return hit[1]["cars"]
        rep = self.get_report(date) if date <= today else None
        cars = (rep or {}).get("cars") if isinstance(rep, dict) else None
        cars = cars if isinstance(cars, dict) else {}
        out = {}
        for plate, rec in cars.items():
            if not is_tracked(plate, rule):
                continue
            res = evaluate(rec, date, rule, now)
            res["plate"] = plate
            res["syncedAt"] = (rec or {}).get("syncedAt") if isinstance(rec, dict) else None
            out[_compact(plate)] = res
        with self.lock:
            self._cache[date] = (stamp, {"_rule": rule, "cars": out})
        return out

    def _decorate(self, res: dict, date: str, notes_day: dict) -> dict:
        res = dict(res)
        res["date"] = date
        res["num"] = plate_number(res.get("plate"))
        res["label"] = STATUS_LABEL.get(res.get("status"), "")
        res["counted"] = res.get("status") in COUNTED_LATE
        entry = notes_day.get(_compact(res.get("plate"))) or notes_day.get(DAY_ALL)
        res["note"] = ""
        res["excused"] = False
        if isinstance(entry, dict):
            res["note"] = str(entry.get("note") or "")
            res["excused"] = bool(entry.get("excused"))
            res["noteBy"] = entry.get("by") or ""
            res["noteAt"] = entry.get("at") or ""
            res["noteAll"] = _compact(res.get("plate")) not in notes_day
        if res["counted"] and not res["excused"] and self.excuse_fn:
            try:
                reason = self.excuse_fn(date, res.get("plate"))
            except Exception:
                reason = None
            if reason:
                res["excused"] = True
                res["autoExcuse"] = str(reason)
        if res["excused"]:
            res["counted"] = False
        return res

    def day(self, date: str) -> dict:
        rule = self.rule()
        notes = self.notes_month(date[:7]).get(date) or {}
        cars = {}
        if rule.get("enabled") and date >= rule.get("since", ""):
            for key, res in self._eval_day(date, rule).items():
                cars[key] = self._decorate(res, date, notes)
        return {"date": date, "rule": rule, "cars": cars, "labels": STATUS_LABEL}

    def month(self, month: str, plate: str | None = None) -> dict:
        """{plates: {compact: {plate, num, days:[...], summary}}} — faqat bugungacha."""
        rule = self.rule()
        today = self.now().strftime("%Y-%m-%d")
        notes = self.notes_month(month)
        want = _compact(plate) if plate else ""
        want_num = plate_number(plate) if plate else ""
        plates: dict[str, dict] = {}
        since = rule.get("since", "")
        dates = [d for d in month_dates(month) if since <= d <= today]
        if not rule.get("enabled") or not dates:
            return {"month": month, "rule": rule, "plates": {}, "labels": STATUS_LABEL}
        per_date = {d: self._eval_day(d, rule) for d in dates}
        names = {}
        for res_map in per_date.values():
            for key, res in res_map.items():
                names.setdefault(key, res.get("plate") or key)
        if want and want not in names and want_num and want_num in rule.get("plates", []):
            names[want] = plate
        for key, label in names.items():
            if want and key != want and plate_number(label) != want_num:
                continue
            days = []
            for d in dates:
                res = per_date[d].get(key)
                if res is None:
                    res = evaluate(None, d, rule, self.now())
                    res["plate"] = label
                days.append(self._decorate(res, d, notes.get(d) or {}))
            plates[key] = {"plate": label, "num": plate_number(label), "days": days, "summary": summarize(days)}
        return {"month": month, "rule": rule, "plates": plates, "labels": STATUS_LABEL}
