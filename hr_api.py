# -*- coding: utf-8 -*-
"""
VaksinaMed — HR uchun faqat-o'qish API (izolyatsiya).
Mavjud login / office / fuel oqimlariga yozmaydi.
"""

from __future__ import annotations

import hmac
import os
import time

# server.py dagi yordamchilar import qilinadi (tsiklik emas: faqat funksiya chaqiruvida)


def hr_api_key():
    return (os.environ.get("VM_HR_API_KEY") or "").strip()


def today_tashkent():
    """O'zbekiston UTC+5 sana."""
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() + 5 * 3600))


def check_hr_key(provided):
    """
    returns: (ok: bool, error: str|None, http_code: int)
    """
    expected = hr_api_key()
    if not expected:
        return False, "HR API o'chirilgan — serverda VM_HR_API_KEY qo'ying", 503
    got = (provided or "").strip()
    if not got or not hmac.compare_digest(got, expected):
        return False, "API key noto'g'ri yoki yo'q", 401
    return True, None, 200


def extract_api_key(headers):
    """X-API-Key yoki Authorization: Bearer ..."""
    if not headers:
        return ""
    key = (headers.get("X-API-Key") or headers.get("x-api-key") or "").strip()
    if key:
        return key
    auth = (headers.get("Authorization") or headers.get("authorization") or "").strip()
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return ""


def _as_num(v, default=0.0):
    try:
        x = float(str(v).replace(",", ".").strip() or default)
    except (TypeError, ValueError):
        return float(default)
    if x != x or abs(x) > 1e10:
        return float(default)
    return x


def _status(score, problem_stops):
    try:
        sc = float(score)
    except (TypeError, ValueError):
        sc = 0.0
    try:
        pr = int(problem_stops)
    except (TypeError, ValueError):
        pr = 0
    if pr >= 3 or sc < 5:
        return "muammo"
    if pr >= 1 or sc < 8:
        return "diqqat"
    return "ok"


def _collect_plates(office, date):
    from vm_server import compact_plate  # noqa: WPS433

    plates = []
    seen = set()

    def add(p):
        p = str(p or "").strip()
        if not p:
            return
        c = compact_plate(p)
        if not c or c in seen:
            return
        seen.add(c)
        plates.append(p)

    meta = office.fuel_meta() or {}
    vehicles = meta.get("vehicles") if isinstance(meta, dict) else {}
    if isinstance(vehicles, dict):
        for k in vehicles.keys():
            add(k)

    for p in office.pharmacies() or []:
        if isinstance(p, dict):
            add(p.get("car"))

    rep = office.get_report(date)
    cars = (rep or {}).get("cars") if isinstance(rep, dict) else {}
    if isinstance(cars, dict):
        for k in cars.keys():
            add(k)

    plates.sort(key=lambda x: compact_plate(x))
    return plates


def hr_summary_row(office, date, plate):
    """Bitta mashina uchun HR qisqa qator (fuel/GPS secret yo'q)."""
    day = office.driver_day(date, plate)
    if not day:
        return {
            "date": date,
            "car": plate,
            "name": "",
            "hasGps": False,
            "km": 0,
            "score": None,
            "grade": "—",
            "ownVisited": 0,
            "totalOwn": 0,
            "problemStops": 0,
            "taskCount": 0,
            "status": "malumot_yoq",
        }

    analysis = day.get("analysis") if isinstance(day.get("analysis"), dict) else {}
    stats = day.get("stats") if isinstance(day.get("stats"), dict) else {}
    tasks = day.get("tasks") if isinstance(day.get("tasks"), list) else []
    score = analysis.get("score")
    problems = analysis.get("problemStops")
    return {
        "date": date,
        "car": day.get("car") or plate,
        "name": day.get("name") or "",
        "hasGps": bool(day.get("hasGps")),
        "km": round(_as_num(stats.get("km")), 2),
        "score": None if score is None else round(_as_num(score), 1),
        "grade": str(analysis.get("grade") or "—"),
        "ownVisited": int(_as_num(analysis.get("ownVisited"))),
        "totalOwn": int(_as_num(analysis.get("totalOwn"))),
        "problemStops": int(_as_num(problems)),
        "taskCount": len(tasks),
        "status": _status(score if day.get("hasGps") else 0, problems if day.get("hasGps") else 0)
        if day.get("hasGps")
        else "malumot_yoq",
        "updatedAt": day.get("updatedAt") or "",
    }


def hr_fleet(office, date=None):
    date = (date or today_tashkent()).strip()
    from vm_server import valid_date

    if not valid_date(date):
        return None, "Sana noto'g'ri (YYYY-MM-DD)"
    rows = [hr_summary_row(office, date, p) for p in _collect_plates(office, date)]
    ok_n = sum(1 for r in rows if r.get("status") == "ok")
    warn_n = sum(1 for r in rows if r.get("status") == "diqqat")
    bad_n = sum(1 for r in rows if r.get("status") == "muammo")
    return {
        "date": date,
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "totals": {
            "cars": len(rows),
            "withGps": sum(1 for r in rows if r.get("hasGps")),
            "ok": ok_n,
            "diqqat": warn_n,
            "muammo": bad_n,
        },
        "drivers": rows,
    }, None


def hr_driver(office, plate, date=None):
    date = (date or today_tashkent()).strip()
    from vm_server import valid_date, compact_plate

    if not valid_date(date):
        return None, "Sana noto'g'ri (YYYY-MM-DD)"
    if not compact_plate(plate):
        return None, "Mashina raqami kerak"
    day = office.driver_day(date, plate)
    if not day:
        return None, "Ma'lumot topilmadi"
    analysis = day.get("analysis") if isinstance(day.get("analysis"), dict) else {}
    stats = day.get("stats") if isinstance(day.get("stats"), dict) else {}
    tasks_in = day.get("tasks") if isinstance(day.get("tasks"), list) else []
    stops_in = day.get("stops") if isinstance(day.get("stops"), list) else []

    # To'xtashlar — joy/vaqt/holat (koordinata va ichki kalitlar yo'q)
    stops = []
    for st in stops_in[:60]:
        if not isinstance(st, dict):
            continue
        stops.append(
            {
                "place": str(st.get("place") or "")[:120],
                "inTime": str(st.get("inTime") or "")[:20],
                "outTime": str(st.get("outTime") or "")[:20],
                "matchType": str(st.get("matchType") or "")[:16],
                "isProblem": bool(st.get("isProblem")),
                "reviewStatus": st.get("reviewStatus"),
                "durSec": int(_as_num(st.get("durSec"))),
            }
        )

    tasks = []
    for t in tasks_in[:40]:
        if not isinstance(t, dict):
            continue
        tasks.append(
            {
                "id": t.get("id"),
                "date": t.get("date") or "",
                "text": str(t.get("text") or "")[:400],
                "by": str(t.get("by") or "")[:40],
                "createdAt": t.get("createdAt") or "",
            }
        )

    score = analysis.get("score")
    problems = analysis.get("problemStops")
    return {
        "date": date,
        "car": day.get("car") or plate,
        "name": day.get("name") or "",
        "routes": day.get("routes") or "",
        "hasGps": bool(day.get("hasGps")),
        "status": _status(score if day.get("hasGps") else 0, problems if day.get("hasGps") else 0)
        if day.get("hasGps")
        else "malumot_yoq",
        "km": round(_as_num(stats.get("km")), 2),
        "maxSpeed": round(_as_num(stats.get("maxSpeed")), 1),
        "stopsCount": int(_as_num(stats.get("stops"))),
        "score": None if score is None else round(_as_num(score), 1),
        "grade": str(analysis.get("grade") or "—"),
        "ownVisited": int(_as_num(analysis.get("ownVisited"))),
        "totalOwn": int(_as_num(analysis.get("totalOwn"))),
        "missedList": analysis.get("missedList")
        if isinstance(analysis.get("missedList"), list)
        else [],
        "problemStops": int(_as_num(problems)),
        "pharmacies": day.get("pharmacies") if isinstance(day.get("pharmacies"), list) else [],
        "tasks": tasks,
        "stops": stops,
        "updatedAt": day.get("updatedAt") or "",
    }, None


def hr_tasks(office, date=None, car=None):
    from vm_server import valid_date, compact_plate

    items = office._task_items()
    out = []
    want_car = compact_plate(car) if car else ""
    date = (date or "").strip()
    if date and not valid_date(date):
        return None, "Sana noto'g'ri (YYYY-MM-DD)"

    for it in items:
        if not isinstance(it, dict):
            continue
        if want_car and compact_plate(it.get("car")) != want_car:
            continue
        td = str(it.get("date") or "")
        # date berilsa: shu kun yoki "har kuni" (bo'sh date)
        if date and td and td != date:
            continue
        out.append(
            {
                "id": it.get("id"),
                "car": it.get("car") or "",
                "date": td or "har_kuni",
                "text": str(it.get("text") or "")[:400],
                "by": str(it.get("by") or "")[:40],
                "createdAt": it.get("createdAt") or "",
            }
        )
    out.sort(key=lambda x: str(x.get("createdAt") or ""), reverse=True)
    return {"date": date or None, "count": len(out[:200]), "tasks": out[:200]}, None
