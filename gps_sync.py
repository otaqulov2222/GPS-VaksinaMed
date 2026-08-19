"""
Server-side Wialon GPS sync for today's fleet reports.
Runs in background so data updates without an open admin browser tab.
"""

import json
import math
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

TZ5 = timezone(timedelta(hours=5))

COORD_PLACE_RE = re.compile(r"^\s*-?\d+\.\d+\s*,\s*-?\d+\.\d+\s*$")

OFFICE_KEYWORDS = (
    "sklad", "склад", "офис", "omborxona", "ombo", "база", "vaksina", "vaksinamed",
    "завод", "fabrika", "tashkent farma", "korxona", "baza", "bosh ofis",
)
OUTSIDE_MARKERS = (
    "kibray", "кибрай", "parkent", "паркент", "yangiyo", "янгийўл",
    "zangiota", "зангиота", "qibray", "chirchiq", "чирчиқ",
)


def norm_ph(s):
    return re.sub(r"[^a-z0-9а-яўқғҳ]", "", str(s or "").lower().replace("ё", "е"))


def compact_car(s):
    return re.sub(r"\s+", "", str(s or "").upper())


def load_fleet_drivers(base_dir):
    path = os.path.join(base_dir, "fleet-data.js")
    if not os.path.isfile(path):
        return []
    text = open(path, encoding="utf-8").read()
    drivers = []
    for block in re.finditer(r"\{[^{}]+\}", text.split("FLEET_DRIVERS = [", 1)[-1].split("];", 1)[0]):
        b = block.group(0)
        car_m = re.search(r"car:\s*'([^']+)'", b)
        if not car_m:
            continue
        def pick(key):
            m = re.search(rf"{key}:\s*'([^']*)'", b)
            return m.group(1) if m else ""
        drivers.append({
            "car": car_m.group(1),
            "fullName": pick("fullName") or car_m.group(1),
            "shortName": pick("shortName") or car_m.group(1),
            "routes": pick("routes") or "—",
            "pharmacies": pick("pharmacies") or "",
            "color": pick("color") or "#3498db",
        })
    return drivers


def find_driver_by_car(drivers, car_raw):
    compact = compact_car(re.sub(r"[^0-9A-Za-zА-Яа-яЎўҚқҲҳ]", "", str(car_raw or "")))
    if not compact:
        return None
    for d in drivers:
        if compact_car(d["car"]) == compact:
            return d
    hits = [d for d in drivers if compact.startswith(compact_car(d["car"])) or compact_car(d["car"]).startswith(compact)]
    if len(hits) == 1:
        return hits[0]
    m = re.match(r"^(\d{5})", compact)
    if m:
        pref = m.group(1)
        hits = [d for d in drivers if compact_car(d["car"]).startswith(pref)]
        if len(hits) == 1:
            return hits[0]
    return None


def day_bounds_tashkent(date_str):
    y, m, d = map(int, date_str.split("-"))
    start = datetime(y, m, d, 0, 0, 0, tzinfo=TZ5)
    end = datetime(y, m, d, 23, 59, 59, tzinfo=TZ5)
    return int(start.timestamp()), int(end.timestamp())


def today_tashkent():
    return datetime.now(TZ5).strftime("%Y-%m-%d")


def parse_dur_sec(s):
    s = str(s or "").strip()
    if not s:
        return 0
    parts = s.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(float(parts[2]))
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(float(parts[1]))
    except (TypeError, ValueError):
        pass
    return 0


def haversine_m(lat1, lng1, lat2, lng2):
    r = 6371000
    to_r = math.pi / 180
    d_lat = (lat2 - lat1) * to_r
    d_lng = (lng2 - lng1) * to_r
    a = math.sin(d_lat / 2) ** 2 + math.cos(lat1 * to_r) * math.cos(lat2 * to_r) * math.sin(d_lng / 2) ** 2
    return 2 * r * math.asin(min(1, math.sqrt(a)))


class WialonClient:
    def __init__(self, host, token="", user="", password=""):
        self.host = (host or "http://bms1.gpsavto.uz").rstrip("/")
        self.token = token or ""
        self.user = user or ""
        self.password = password or ""
        self.sid = None
        self._tpl = None

    def _call(self, svc, params):
        params_str = urllib.parse.quote(json.dumps(params, separators=(",", ":")))
        sid_q = f"&sid={self.sid}" if self.sid else ""
        url = f"{self.host}/wialon/ajax.html?svc={svc}&params={params_str}{sid_q}"
        req = urllib.request.Request(url, headers={"User-Agent": "VaksinaMed/1.0"})
        with urllib.request.urlopen(req, timeout=45) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        if isinstance(data, dict) and data.get("error"):
            raise RuntimeError(f"Wialon #{data.get('error')}")
        return data

    def login(self):
        if self.token:
            r = self._call("token/login", {"token": self.token})
        else:
            r = self._call("core/login", {"user": self.user, "password": self.password})
        self.sid = r.get("eid")
        if not self.sid:
            raise RuntimeError("Wialon login failed")
        return True

    def get_units(self):
        r = self._call(
            "core/search_items",
            {
                "spec": {
                    "itemsType": "avl_unit",
                    "propName": "sys_name",
                    "propValueMask": "*",
                    "sortType": "sys_name",
                },
                "force": 1,
                "flags": 1,
                "from": 0,
                "to": 0,
            },
        )
        return r.get("items") or []

    def resolve_template(self):
        if self._tpl:
            return self._tpl
        r = self._call(
            "core/search_items",
            {
                "spec": {
                    "itemsType": "avl_resource",
                    "propName": "sys_name",
                    "propValueMask": "*",
                    "sortType": "sys_name",
                },
                "force": 1,
                "flags": 8193,
                "from": 0,
                "to": 0,
            },
        )
        resources = r.get("items") or []
        resource_id = template_id = None
        for res in resources:
            rep = res.get("rep") or {}
            for tid, tdata in rep.items():
                name = str((tdata or {}).get("n") or "").lower()
                if "хронолог" in name or "xronologiya" in name or "поездк" in name:
                    resource_id, template_id = res["id"], tid
                    break
            if resource_id:
                break
        if not resource_id and resources:
            rep = resources[0].get("rep") or {}
            if rep:
                resource_id = resources[0]["id"]
                template_id = next(iter(rep.keys()))
        if not resource_id:
            raise RuntimeError("Wialon report template topilmadi")
        self._tpl = (resource_id, template_id)
        return self._tpl

    @staticmethod
    def cell_text(v):
        if v is None:
            return ""
        if isinstance(v, dict):
            return str(v.get("t") or v.get("v") or "")
        return str(v)

    @staticmethod
    def cell_num(v):
        m = re.search(r"-?\d+(?:\.\d+)?", str(WialonClient.cell_text(v)).replace(",", "."))
        return float(m.group(0)) if m else 0.0

    @staticmethod
    def cell_coord(v):
        if isinstance(v, dict):
            if "y" in v and "x" in v:
                return float(v.get("y") or 0), float(v.get("x") or 0)
            if "lat" in v and "lon" in v:
                return float(v.get("lat") or 0), float(v.get("lon") or 0)
        return 0.0, 0.0

    def fetch_rows(self, table_index, row_count):
        if not row_count:
            return []
        out = []
        chunk = 200
        for start in range(0, row_count, chunk):
            end = min(row_count - 1, start + chunk - 1)
            rows = self._call("report/get_result_rows", {"tableIndex": table_index, "indexFrom": start, "indexTo": end})
            if isinstance(rows, list):
                out.extend(rows)
        return out

    def get_chronology(self, unit_id, date_str):
        resource_id, template_id = self.resolve_template()
        t_from, t_to = day_bounds_tashkent(date_str)
        exec_resp = self._call(
            "report/exec_report",
            {
                "reportResourceId": resource_id,
                "reportTemplateId": template_id,
                "reportTemplate": None,
                "reportObjectId": unit_id,
                "reportObjectSecId": 0,
                "interval": {"from": t_from, "to": t_to, "flags": 0},
            },
        )
        rr = (exec_resp or {}).get("reportResult") or {}
        stats = {"probeg": 0, "maxSpeed": 0, "avgSpeed": 0, "poezdok": 0, "stoyanok": 0, "gas": 0, "benzin": 0, "motoChas": "—", "totalStop": "—"}
        stops = []
        for pair in rr.get("stats") or []:
            if not isinstance(pair, (list, tuple)) or len(pair) < 2:
                continue
            k = self.cell_text(pair[0]).lower()
            num = self.cell_num(pair[1])
            if "пробег" in k or "masofa" in k or "mileage" in k:
                if num > 0:
                    stats["probeg"] = round(num if num < 500 else num / 1000, 2)
            if "макс" in k and ("скорост" in k or "speed" in k or "tezlik" in k) and num > 0:
                stats["maxSpeed"] = round(num, 1)
            if ("средн" in k or "avg" in k) and ("скорост" in k or "speed" in k) and num > 0:
                stats["avgSpeed"] = round(num, 1)
            if "поезд" in k and num > 0:
                stats["poezdok"] = int(num)
            if "стоян" in k and num > 0:
                stats["stoyanok"] = int(num)

        tables = rr.get("tables") or []
        loaded = []
        for i, tbl in enumerate(tables):
            name = (str(tbl.get("name") or "") + " " + str(tbl.get("label") or "")).lower()
            loaded.append({"name": name, "tbl": tbl, "rows": self.fetch_rows(i, int(tbl.get("rows") or 0))})

        def parse_row(r):
            c = r.get("c") or []
            type_raw = self.cell_text(c[1] if len(c) > 1 else c[0]).lower()
            is_stop = bool(re.search(r"park|стоян|stop|останов|stay", type_raw))
            start_cell = c[2] if len(c) > 2 else None
            loc_cell = c[3] if len(c) > 3 else None
            end_cell = c[4] if len(c) > 4 else None
            lat, lng = self.cell_coord(loc_cell or start_cell)
            place = self.cell_text(loc_cell) or self.cell_text(c[5] if len(c) > 5 else "") or "Noma'lum manzil"
            in_t = re.search(r"\d{1,2}:\d{2}", self.cell_text(start_cell))
            out_t = re.search(r"\d{1,2}:\d{2}", self.cell_text(end_cell))
            return {
                "is_stop": is_stop,
                "place": place,
                "inTime": in_t.group(0) if in_t else "",
                "outTime": out_t.group(0) if out_t else "",
                "duration": self.cell_text(c[6] if len(c) > 6 else c[5] if len(c) > 5 else ""),
                "lat": lat,
                "lng": lng,
            }

        for block in loaded:
            if "chron" in block["name"] or "хронолог" in block["name"]:
                for r in block["rows"]:
                    p = parse_row(r)
                    if p["is_stop"]:
                        stops.append(p)

        if not stops:
            for block in loaded:
                if block["tbl"].get("name") == "unit_stays":
                    for r in block["rows"]:
                        c = r.get("c") or []
                        lat, lng = self.cell_coord(c[2] if len(c) > 2 else None)
                        in_t = re.search(r"\d{1,2}:\d{2}", self.cell_text(c[2] if len(c) > 2 else ""))
                        out_t = re.search(r"\d{1,2}:\d{2}", self.cell_text(c[3] if len(c) > 3 else ""))
                        stops.append({
                            "place": self.cell_text(c[5] if len(c) > 5 else c[1] if len(c) > 1 else "") or "Noma'lum manzil",
                            "inTime": in_t.group(0) if in_t else "",
                            "outTime": out_t.group(0) if out_t else "",
                            "duration": self.cell_text(c[4] if len(c) > 4 else ""),
                            "lat": lat,
                            "lng": lng,
                        })

        if not stats["stoyanok"]:
            stats["stoyanok"] = len(stops)
        try:
            self._call("report/cleanup_result", {})
        except Exception:
            pass
        return {"stats": stats, "stops": stops}


def build_pharm_index(drivers, pharmacies):
    index = []
    if pharmacies:
        for ph in pharmacies:
            if not isinstance(ph, dict):
                continue
            name = str(ph.get("name") or "").strip()
            car = str(ph.get("car") or "").strip()
            if not name or not car:
                continue
            drv = next((d for d in drivers if d["car"] == car), None)
            index.append({"norm": norm_ph(name), "name": name, "car": car, "driver": (drv or {}).get("shortName") or car})
        return index
    for drv in drivers:
        for ph in (drv.get("pharmacies") or "").split(","):
            ph = ph.strip()
            if ph:
                index.append({"norm": norm_ph(ph), "name": ph, "car": drv["car"], "driver": drv["shortName"]})
    return index


def match_geo(current_car, lat, lng, pharmacies):
    y, x = float(lat or 0), float(lng or 0)
    if not y or not x:
        return None
    best, best_d = None, 1e12
    for ph in pharmacies or []:
        if not isinstance(ph, dict) or ph.get("lat") is None or ph.get("lng") is None:
            continue
        d = haversine_m(y, x, float(ph["lat"]), float(ph["lng"]))
        r = float(ph.get("radiusM") or 120)
        if d <= r and d < best_d:
            best_d, best = d, ph
        elif d <= r and d == best_d and ph.get("car") == current_car:
            best = ph
    if not best:
        return None
    return {
        "type": "own" if best.get("car") == current_car else "other",
        "phName": best.get("name"),
        "owners": [best.get("car")],
    }


def match_pharmacy(place, current_car, lat, lng, pharm_index, pharmacies):
    geo = match_geo(current_car, lat, lng, pharmacies)
    if geo:
        return geo
    pn = norm_ph(place)
    if len(pn) < 3:
        return {"type": "none", "phName": None, "owners": []}
    best_score, best = 0, None
    owners = []
    for entry in pharm_index:
        en = entry["norm"]
        score = 0
        if pn == en:
            score = 100
        elif pn in en or en in pn:
            score = min(len(pn), len(en)) / max(len(pn), len(en)) * 90
        else:
            ptok = pn.split()
            etok = en.split()
            matches = sum(1 for pt in ptok if pt in etok and len(pt) > 2)
            if ptok or etok:
                score = matches / max(len(ptok), len(etok)) * 70
        if score > 40:
            owners.append(entry)
            if score > best_score:
                best_score, best = score, entry
    if not best:
        return {"type": "none", "phName": None, "owners": []}
    is_own = any(o["car"] == current_car for o in owners)
    return {"type": "own" if is_own else "other", "phName": best["name"], "owners": list({o["driver"] for o in owners})}


def is_office(place):
    p = norm_ph(place)
    return any(k in p for k in OFFICE_KEYWORDS)


def is_outside(place):
    p = norm_ph(place)
    return any(k in p for k in OUTSIDE_MARKERS)


def enrich_stops(raw_stops, car_key, pharm_index, pharmacies):
    out = []
    for i, s in enumerate(raw_stops or []):
        place = str(s.get("place") or "").strip()
        match = match_pharmacy(place, car_key, s.get("lat"), s.get("lng"), pharm_index, pharmacies)
        dur_sec = parse_dur_sec(s.get("duration"))
        stop = {
            "num": i + 1,
            "place": place or "Noma'lum manzil",
            "inTime": s.get("inTime") or "",
            "outTime": s.get("outTime") or "",
            "duration": s.get("duration") or "",
            "durSec": dur_sec,
            "lat": s.get("lat") or 0,
            "lng": s.get("lng") or 0,
            "gas": 0,
            "benzin": 0,
            "matchType": match["type"],
            "phName": match.get("phName"),
            "owners": match.get("owners") or [],
            "isOffice": is_office(place),
            "isOutside": is_outside(place),
            "isProblem": False,
        }
        if not stop["isOffice"] and not stop["isOutside"] and stop["matchType"] == "none" and dur_sec > 600:
            stop["isProblem"] = True
        out.append(stop)
    return out


def own_pharmacy_list(car_key, drivers, pharmacies):
    from_state = [p.get("name") for p in (pharmacies or []) if isinstance(p, dict) and p.get("car") == car_key and p.get("name")]
    if from_state:
        seen, out = set(), []
        for n in from_state:
            k = norm_ph(n)
            if k and k not in seen:
                seen.add(k)
                out.append(n)
        return out
    drv = next((d for d in drivers if d["car"] == car_key), None)
    if not drv or not drv.get("pharmacies"):
        return []
    seen, out = set(), []
    for n in drv["pharmacies"].split(","):
        n = n.strip()
        k = norm_ph(n)
        if k and k not in seen:
            seen.add(k)
            out.append(n)
    return out


def is_coord_place(place):
    return bool(COORD_PLACE_RE.match(str(place or "").strip()))


def find_pharmacy(pharmacies, car, name):
    want_car = compact_car(car)
    want_name = norm_ph(name)
    for ph in pharmacies or []:
        if not isinstance(ph, dict):
            continue
        if compact_car(ph.get("car")) != want_car:
            continue
        if norm_ph(ph.get("name")) == want_name:
            return ph
    return None


def merge_geozone(ph, lat, lng, radius_m=120):
    lat_f, lng_f = float(lat), float(lng)
    if ph.get("lat") is not None and ph.get("lng") is not None:
        ph["lat"] = round((float(ph["lat"]) + lat_f) / 2, 6)
        ph["lng"] = round((float(ph["lng"]) + lng_f) / 2, 6)
    else:
        ph["lat"] = round(lat_f, 6)
        ph["lng"] = round(lng_f, 6)
    if not ph.get("radiusM"):
        ph["radiusM"] = int(radius_m)


def learn_geozone(pharmacies, car, ph_name, lat, lng):
    ph = find_pharmacy(pharmacies, car, ph_name)
    if not ph:
        return False
    try:
        y, x = float(lat or 0), float(lng or 0)
    except (TypeError, ValueError):
        return False
    if not y or not x:
        return False
    merge_geozone(ph, y, x)
    return True


def learn_geozones_from_stops(pharmacies, car, stops):
    learned = 0
    for st in stops or []:
        if not isinstance(st, dict) or st.get("matchType") != "own":
            continue
        ph_name = st.get("phName") or st.get("place")
        if ph_name and learn_geozone(pharmacies, car, ph_name, st.get("lat"), st.get("lng")):
            learned += 1
    return learned


def learn_geozones_from_reviews(pharmacies, reviews):
    learned = 0
    for key, rv in (reviews or {}).items():
        if not isinstance(rv, dict) or rv.get("status") != "allowed":
            continue
        ph_name = rv.get("phName") or ""
        parts = str(key).split("|")
        car = rv.get("car") or (parts[1] if len(parts) > 1 else "")
        if ph_name and car and learn_geozone(pharmacies, car, ph_name, rv.get("lat"), rv.get("lng")):
            learned += 1
    return learned


def stops_as_raw(stops):
    raw = []
    for s in stops or []:
        if not isinstance(s, dict):
            continue
        raw.append(
            {
                "place": s.get("place") or "",
                "inTime": s.get("inTime") or "",
                "outTime": s.get("outTime") or "",
                "duration": s.get("duration") or "",
                "lat": s.get("lat"),
                "lng": s.get("lng"),
            }
        )
    return raw


def _visited_from_reviews(reviews, car_key):
    visited = set()
    want = compact_car(car_key)
    for key, rv in (reviews or {}).items():
        if not isinstance(rv, dict) or rv.get("status") != "allowed":
            continue
        parts = str(key).split("|")
        car_k = rv.get("car") or (parts[1] if len(parts) > 1 else "")
        if compact_car(car_k) != want:
            continue
        ph_name = rv.get("phName") or ""
        n = norm_ph(ph_name)
        if n:
            visited.add(n)
    return visited


def reprocess_car_record(rec, car, drivers, pharmacies, pharm_index, reviews=None):
    if not isinstance(rec, dict):
        return rec
    raw = stops_as_raw(rec.get("stops") or [])
    stops = enrich_stops(raw, car, pharm_index, pharmacies)
    stats = rec.get("stats") if isinstance(rec.get("stats"), dict) else {}
    analysis = analyze_data(stops, car, stats, drivers, pharmacies, reviews=reviews)
    rec["stops"] = stops
    rec["analysis"] = analysis
    return rec


def reprocess_day(office, base_dir, date_str):
    report = office.get_report(date_str)
    if not report:
        return 0
    cars = report.get("cars") if isinstance(report.get("cars"), dict) else {}
    if not cars:
        return 0
    drivers = load_fleet_drivers(base_dir)
    pharmacies = office.pharmacies()
    pharm_index = build_pharm_index(drivers, pharmacies)
    reviews = office.reviews(date_str) or {}
    done = 0
    for car_key, rec in cars.items():
        if not isinstance(rec, dict):
            continue
        car = rec.get("car") or car_key
        reprocess_car_record(rec, car, drivers, pharmacies, pharm_index, reviews=reviews)
        done += 1
    if done:
        office.save_report(date_str, cars, saved_by="reprocess")
    return done


def reprocess_recent(office, base_dir, limit=45):
    total = 0
    for date_str in office.report_dates()[:limit]:
        total += reprocess_day(office, base_dir, date_str)
    return total


def learn_geozones_from_reports(office, base_dir):
    pharmacies = list(office.pharmacies())
    learned = 0
    for date_str in office.report_dates():
        report = office.get_report(date_str)
        cars = (report or {}).get("cars") if isinstance(report, dict) else {}
        if not isinstance(cars, dict):
            continue
        for car_key, rec in cars.items():
            if not isinstance(rec, dict):
                continue
            car = rec.get("car") or car_key
            learned += learn_geozones_from_stops(pharmacies, car, rec.get("stops") or [])
        learned += learn_geozones_from_reviews(pharmacies, office.reviews(date_str) or {})
    if learned:
        office.save_pharmacies(pharmacies)
    return learned


def analyze_data(stops, car_key, stats, drivers, pharmacies, reviews=None):
    own_pharms = own_pharmacy_list(car_key, drivers, pharmacies)
    visited = set()
    for s in stops or []:
        if s.get("matchType") == "own":
            n = norm_ph(s.get("phName") or s.get("place") or "")
            if n:
                visited.add(n)
    visited.update(_visited_from_reviews(reviews, car_key))
    missed = [ph for ph in own_pharms if norm_ph(ph) not in visited]
    own_visited = len(own_pharms) - len(missed) if own_pharms else len(visited)
    other_dir = sum(1 for s in stops or [] if s.get("matchType") == "other")
    problem_stops = sum(1 for s in stops or [] if s.get("isProblem"))
    outside_city = sum(1 for s in stops or [] if s.get("isOutside"))
    score = 10.0
    breakdown = ["Boshlang'ich ball: 10.0"]
    recs = []
    if problem_stops > 0:
        deduct = min(problem_stops * 1.0, 3.0)
        score -= deduct
        breakdown.append(f"-{deduct:.1f}: {problem_stops} ta muammoli to'xtash")
        recs.append(f"{problem_stops} ta ruxsatsiz joyda to'xtash aniqlandi")
    if missed:
        deduct = min(len(missed) * 0.5, 2.0)
        score -= deduct
        breakdown.append(f"-{deduct:.1f}: {len(missed)} ta dorixona o'tkazib yuborilgan")
        recs.append("O'tkazib yuborilgan: " + ", ".join(missed[:3]) + ("..." if len(missed) > 3 else ""))
    if other_dir > 0:
        score -= min(other_dir * 0.3, 1.5)
    max_speed = float((stats or {}).get("maxSpeed") or 0)
    if max_speed > 90:
        score -= 0.5
        breakdown.append(f"-0.5: Tezlik normasi oshirildi ({max_speed} km/s)")
    if not missed and own_pharms:
        score += 0.5
        breakdown.append("+0.5: Barcha dorixonalarga borildi")
    score = max(0, min(10, score))
    grade = "A" if score >= 9 else "B" if score >= 7 else "C" if score >= 5 else "D" if score >= 3 else "F"
    if not recs:
        recs.append("Kun me'yorida o'tdi")
    return {
        "ownVisited": own_visited,
        "otherDirection": other_dir,
        "problemStops": problem_stops,
        "outsideCity": outside_city,
        "totalOwn": len(own_pharms),
        "missedList": missed,
        "ownPharms": own_pharms,
        "score": {"final": round(score, 1), "grade": grade, "breakdown": breakdown, "recommendations": recs},
    }


def sync_today(office, base_dir, date_str=None, saved_by="auto"):
    date_str = date_str or today_tashkent()
    cfg = office.gps_config_internal()
    if not cfg.get("configured"):
        return {"ok": False, "error": "GPS sozlamasi yo'q"}
    host = cfg.get("host") or "http://bms1.gpsavto.uz"
    client = WialonClient(host, token=cfg.get("token") or "", user=cfg.get("user") or "", password=cfg.get("password") or "")
    office.set_gps_status(running=True, error="")
    try:
        client.login()
        units = client.get_units()
        drivers = load_fleet_drivers(base_dir)
        pharmacies = list(office.pharmacies())
        pharm_index = build_pharm_index(drivers, pharmacies)
        unit_rows = []
        done = 0
        for unit in units:
            name = str(unit.get("nm") or unit.get("name") or "")
            drv = find_driver_by_car(drivers, name)
            if not drv:
                continue
            try:
                chrono = client.get_chronology(unit["id"], date_str)
            except Exception:
                continue
            raw_stops = chrono.get("stops") or []
            stats = dict(chrono.get("stats") or {})
            unit_rows.append((drv, raw_stops, stats))

        # 1-pass: geozonalarni o'rganish (matn yoki geo mos kelgan to'xtashlar)
        for drv, raw_stops, _stats in unit_rows:
            stops = enrich_stops(raw_stops, drv["car"], pharm_index, pharmacies)
            learn_geozones_from_stops(pharmacies, drv["car"], stops)
        learn_geozones_from_reviews(pharmacies, office.reviews(date_str) or {})
        if any(isinstance(p, dict) and p.get("lat") is not None for p in pharmacies):
            office.save_pharmacies(pharmacies)
            pharmacies = office.pharmacies()
            pharm_index = build_pharm_index(drivers, pharmacies)

        reviews = office.reviews(date_str) or {}
        cars = {}
        for drv, raw_stops, stats in unit_rows:
            stops = enrich_stops(raw_stops, drv["car"], pharm_index, pharmacies)
            if not stats.get("stoyanok"):
                stats["stoyanok"] = len(stops)
            analysis = analyze_data(stops, drv["car"], stats, drivers, pharmacies, reviews=reviews)
            cars[drv["car"]] = {
                "car": drv["car"],
                "driver": drv,
                "date": date_str,
                "stats": stats,
                "stops": stops,
                "analysis": analysis,
            }
            done += 1
        if done:
            office.save_report(date_str, cars, saved_by=saved_by)
            reprocess_day(office, base_dir, date_str)
        office.set_gps_status(running=False, cars=done, error="")
        return {"ok": True, "date": date_str, "cars": done}
    except Exception as e:
        office.set_gps_status(running=False, error=str(e)[:200])
        return {"ok": False, "error": str(e)}
