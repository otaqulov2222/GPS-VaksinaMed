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
    "bo'ka", "бўка", "urtachirchiq",
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


def overlay_fuel_driver_names(office, drivers):
    try:
        vehicles = (office.fuel_meta() or {}).get("vehicles") or {}
    except Exception:
        vehicles = {}
    out = list(drivers or [])
    if not isinstance(vehicles, dict) or not vehicles:
        return out
    seen = {compact_car(d.get("car")) for d in out if isinstance(d, dict)}
    for d in out:
        if not isinstance(d, dict):
            continue
        rec = None
        want = compact_car(d.get("car"))
        for k, v in vehicles.items():
            if compact_car(k) == want and isinstance(v, dict):
                rec = v
                break
        if not rec or not str(rec.get("name") or "").strip():
            continue
        name = str(rec.get("name") or "").strip()
        short = str(rec.get("short") or "").strip()
        if not short:
            parts = name.split()
            short = parts[-1] if parts else name
        d["fullName"] = name
        d["shortName"] = short
        d["name"] = name
    for plate, rec in vehicles.items():
        if not isinstance(rec, dict) or rec.get("hidden"):
            continue
        if not str(rec.get("name") or "").strip():
            continue
        want = compact_car(plate)
        if want in seen:
            continue
        name = str(rec.get("name") or "").strip()
        short = str(rec.get("short") or "").strip()
        if not short:
            parts = name.split()
            short = parts[-1] if parts else name
        out.append({
            "car": str(plate).strip(),
            "fullName": name,
            "shortName": short,
            "routes": "—",
            "pharmacies": "",
            "color": "#7f8c8d",
        })
        seen.add(want)
    return out


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


def yesterday_tashkent():
    return (datetime.now(TZ5) - timedelta(days=1)).strftime("%Y-%m-%d")


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
    def __init__(self, host, token="", user="", password="", timeout=45):
        self.host = (host or "http://bms1.gpsavto.uz").rstrip("/")
        self.token = token or ""
        self.user = user or ""
        self.password = password or ""
        self.sid = None
        self._tpl = None
        self.timeout = int(timeout) or 45

    def _call(self, svc, params):
        params_str = urllib.parse.quote(json.dumps(params, separators=(",", ":")))
        sid_q = f"&sid={self.sid}" if self.sid else ""
        url = f"{self.host}/wialon/ajax.html?svc={svc}&params={params_str}{sid_q}"
        req = urllib.request.Request(url, headers={"User-Agent": "VaksinaMed/1.0"})
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            data = json.loads(resp.read().decode("utf-8", "replace"))
        if isinstance(data, dict) and data.get("error"):
            raise RuntimeError(f"Wialon #{data.get('error')}")
        return data

    def clone_session(self):
        """Parallel worker uchun ALOHIDA sid.
        Bitta sid da report/exec_report poyga qilsa km chalkashadi (23.66 va h.k.).
        """
        c = WialonClient(
            self.host,
            token=self.token,
            user=self.user,
            password=self.password,
            timeout=self.timeout,
        )
        c.login()
        c._tpl = self._tpl
        return c

    def login(self):
        self.token = re.sub(r"\s+", "", str(self.token or "")).strip()
        self.user = str(self.user or "").strip()
        self.password = str(self.password or "").strip()
        last = None
        if self.user and self.password:
            try:
                r = self._call("core/login", {"user": self.user, "password": self.password})
                self.sid = r.get("eid")
                if self.sid:
                    return True
            except Exception as e:
                last = e
        if self.token:
            r = self._call("token/login", {"token": self.token})
            self.sid = r.get("eid")
            if self.sid:
                return True
        if last:
            raise last
        raise RuntimeError("Wialon login failed")

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

    def resolve_templates(self):
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
        trip = chrono = any_tpl = None
        trip_score = -1
        for res in resources:
            rep = res.get("rep") or {}
            for tid, tdata in rep.items():
                name = str((tdata or {}).get("n") or "").lower()
                pair = (res["id"], tid)
                if not any_tpl:
                    any_tpl = pair
                # Eng aniq: «Отчёт по поездкам»
                score = -1
                if "хронолог" in name or "xronologiya" in name or "chronolog" in name:
                    if not chrono:
                        chrono = pair
                    continue
                if "по поездкам" in name or "отчёт по поезд" in name or "отчет по поезд" in name:
                    score = 10
                elif "поездк" in name or "trip" in name:
                    score = 5
                if score > trip_score:
                    trip_score = score
                    trip = pair
        if not any_tpl:
            raise RuntimeError("Wialon report template topilmadi")
        self._tpl = {"trip": trip, "chrono": chrono, "any": any_tpl}
        return self._tpl

    def resolve_template(self):
        t = self.resolve_templates()
        return t.get("chrono") or t.get("trip") or t.get("any")

    @staticmethod
    def km_from_wialon(num, label="", value_text=""):
        """Boomerang qiymatini o'zgartirmasdan km ga o'tkazish (metr bo'lsa /1000)."""
        try:
            n = float(num)
        except (TypeError, ValueError):
            return 0.0
        if n <= 0:
            return 0.0
        blob = ("%s %s" % (label, value_text)).lower()
        is_m = bool(re.search(r"метр|(?<![kк])m\b|(?<![kк])м\b", blob))
        is_km = "км" in blob or "km" in blob
        if is_m and not is_km:
            n = n / 1000.0
        elif n >= 10000:
            n = n / 1000.0
        return round(n + 1e-12, 2)

    @staticmethod
    def mileage_pref(label):
        k = str(label or "").lower()
        if "время" in k or "duration" in k or "скорост" in k or "speed" in k:
            return -1
        if "пробег" not in k and "mileage" not in k and "masofa" not in k:
            return -1
        if "поездк" in k or "in trips" in k or "в поезд" in k:
            return 3
        if "всег" in k or "total" in k or "счетчик" in k or "counter" in k:
            return 1
        return 2

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
        self.apply_report_stats(rr.get("stats") or [], stats)

        tables = rr.get("tables") or []
        loaded = []
        for i, tbl in enumerate(tables):
            name = (str(tbl.get("name") or "") + " " + str(tbl.get("label") or "")).lower()
            loaded.append({"name": name, "tbl": tbl, "rows": self.fetch_rows(i, int(tbl.get("rows") or 0))})

        def parse_chrono_row(r):
            c = r.get("c") or []
            type_raw = self.cell_text(c[1] if len(c) > 1 else c[0]).lower()
            is_stop = bool(re.search(r"park|стоян|stop|останов|stay", type_raw))
            start_cell = c[2] if len(c) > 2 else None
            loc_cell = c[3] if len(c) > 3 else None
            end_cell = c[4] if len(c) > 4 else None
            lat, lng = self.cell_coord(loc_cell or start_cell)
            place = self.cell_text(loc_cell) or self.cell_text(c[5] if len(c) > 5 else "") or "Noma'lum manzil"
            if is_coord_place(place) and (lat or lng):
                place = "%.5f, %.5f" % (lat, lng)
            in_t = re.search(r"\d{1,2}:\d{2}(?::\d{2})?", self.cell_text(start_cell))
            out_t = re.search(r"\d{1,2}:\d{2}(?::\d{2})?", self.cell_text(end_cell))
            dur = self.cell_text(c[6] if len(c) > 6 else c[5] if len(c) > 5 else "")
            return {
                "is_stop": is_stop,
                "place": place,
                "inTime": (in_t.group(0)[:5] if in_t else ""),
                "outTime": (out_t.group(0)[:5] if out_t else ""),
                "duration": dur,
                "lat": lat,
                "lng": lng,
            }

        def parse_stays_block(block):
            headers = [self.cell_text(h).lower() for h in (block["tbl"].get("header") or [])]
            def col(*keys):
                for i, h in enumerate(headers):
                    if any(k in h for k in keys):
                        return i
                return -1
            i_begin = col("начал", "begin", "start", "kirish", "from")
            i_end = col("окончан", "конец", "end", "finish", "chiqish", "to")
            i_dur = col("длитель", "продолж", "duration", "davom")
            i_loc = col("местополож", "location", "адрес", "address", "joy", "манзил")
            out = []
            for r in block["rows"]:
                c = r.get("c") or []
                def cell(i, fallback=None):
                    if i is not None and i >= 0 and i < len(c):
                        return c[i]
                    return fallback
                begin = cell(i_begin, c[0] if c else None)
                end = cell(i_end, c[1] if len(c) > 1 else None)
                dur_c = cell(i_dur, c[2] if len(c) > 2 else None)
                loc = cell(i_loc, c[3] if len(c) > 3 else (c[2] if len(c) > 2 else None))
                lat, lng = self.cell_coord(loc)
                if not lat and not lng:
                    for cell_v in c:
                        y, x = self.cell_coord(cell_v)
                        if y or x:
                            lat, lng = y, x
                            if not self.cell_text(loc):
                                loc = cell_v
                            break
                place = self.cell_text(loc) or "Noma'lum manzil"
                if is_coord_place(place) and (lat or lng):
                    place = "%.5f, %.5f" % (lat, lng)
                in_t = re.search(r"\d{1,2}:\d{2}", self.cell_text(begin))
                out_t = re.search(r"\d{1,2}:\d{2}", self.cell_text(end))
                out.append({
                    "place": place,
                    "inTime": in_t.group(0) if in_t else "",
                    "outTime": out_t.group(0) if out_t else "",
                    "duration": self.cell_text(dur_c),
                    "lat": lat,
                    "lng": lng,
                })
            return out

        for block in loaded:
            if "chron" in block["name"] or "хронолог" in block["name"] or block["tbl"].get("name") == "unit_chronology":
                for r in block["rows"]:
                    p = parse_chrono_row(r)
                    if p["is_stop"]:
                        stops.append({k: v for k, v in p.items() if k != "is_stop"})

        if not stops:
            for block in loaded:
                tname = str(block["tbl"].get("name") or "")
                if tname == "unit_stays" or "стоян" in block["name"] or "parking" in block["name"] or "stay" in block["name"]:
                    stops.extend(parse_stays_block(block))

        # Haqiqiy to'xtashlar soni — Boomerang chronologiyadan
        if stops:
            stats["stoyanok"] = len(stops)
        elif not stats["stoyanok"]:
            stats["stoyanok"] = 0

        # Chronologiyadan FAQAT to'xtashlar.
        # Km/tezlik chron «пробег»dan OLINMAYDI — 23.66 kabi xato qiymat shu yerdan kelgan.
        stats["probeg"] = 0
        stats["maxSpeed"] = 0
        stats["avgSpeed"] = 0
        stats["poezdok"] = 0
        stats.pop("_kmSrc", None)

        try:
            self._call("report/cleanup_result", {})
        except Exception:
            pass

        # 1) unit/get_trips — tez zaxira
        trip_live = self.fetch_unit_trips_stats(unit_id, date_str)
        if trip_live:
            if trip_live.get("probeg"):
                stats["probeg"] = float(trip_live["probeg"])
                stats["_kmSrc"] = "get_trips"
            if trip_live.get("maxSpeed"):
                stats["maxSpeed"] = float(trip_live["maxSpeed"])
            if trip_live.get("avgSpeed"):
                stats["avgSpeed"] = trip_live["avgSpeed"]
            if trip_live.get("poezdok"):
                stats["poezdok"] = trip_live["poezdok"]

        # 2) Отчёт по поездкам — Boomerang «Пробег в поездках» (asosiy)
        trip_stats = self.fetch_trip_report_stats(unit_id, date_str)
        if not trip_stats:
            trip_stats = self.fetch_trip_report_stats(unit_id, date_str)  # 1 marta qayta
        if trip_stats:
            trip_stats = dict(trip_stats)
            if stops:
                trip_stats.pop("stoyanok", None)
            live_km = float(stats.get("probeg") or 0)
            rep_km = float(trip_stats.get("probeg") or 0)
            src = str(trip_stats.get("_kmSrc") or "")
            trusted = src in ("trips", "trip_stats")
            # Ishonchsiz/past hisobot get_trips ni buzmasin (23.66 chron chalkashligi)
            if rep_km > 0 and live_km > 0 and not trusted and rep_km + 0.5 < live_km:
                trip_stats.pop("probeg", None)
            elif not rep_km and live_km:
                trip_stats.pop("probeg", None)
            stats = self.merge_stats(stats, trip_stats)
            if trip_stats.get("probeg"):
                stats["_kmSrc"] = src or "trip_report"
            # Tezlik — eng yuqori
            if trip_live and trip_live.get("maxSpeed"):
                ms = float(trip_live["maxSpeed"])
                if ms > float(stats.get("maxSpeed") or 0):
                    stats["maxSpeed"] = ms

        self.cleanup_stats(stats)
        return {"stats": stats, "stops": stops}

    @staticmethod
    def cleanup_stats(stats):
        if not isinstance(stats, dict):
            return
        src = stats.pop("_kmSrc", None)
        if src:
            stats["metricsSource"] = src
        for key in ("probeg", "maxSpeed", "avgSpeed"):
            if key in stats:
                try:
                    stats[key] = round(float(stats[key] or 0) + 1e-12, 2)
                except (TypeError, ValueError):
                    pass

    def fetch_unit_trips_stats(self, unit_id, date_str):
        """
        Wialon unit/get_trips → Boomerang «Отчёт по поездкам» asosiy raqamlari.
        distance odatda METR; ba'zi akkauntlarda km bo'lishi mumkin.
        """
        t_from, t_to = day_bounds_tashkent(date_str)
        try:
            raw = self._call(
                "unit/get_trips",
                {"itemId": unit_id, "timeFrom": t_from, "timeTo": t_to},
            )
        except Exception:
            return None
        if isinstance(raw, dict):
            lst = raw.get("trips") or []
        elif isinstance(raw, list):
            lst = raw
        else:
            lst = []
        if not lst:
            return None
        distances = []
        max_speed = 0.0
        avg_acc = 0.0
        avg_n = 0
        for tr in lst:
            if not isinstance(tr, dict):
                continue
            d = tr.get("distance")
            if d is None:
                d = tr.get("mileage")
            try:
                d = float(d)
            except (TypeError, ValueError):
                d = 0.0
            if d > 0:
                distances.append(d)
            try:
                ms = float(tr.get("max_speed") or tr.get("maxSpeed") or 0)
            except (TypeError, ValueError):
                ms = 0.0
            if ms > max_speed:
                max_speed = ms
            try:
                aspd = float(tr.get("avg_speed") or tr.get("avgSpeed") or 0)
            except (TypeError, ValueError):
                aspd = 0.0
            if aspd > 0:
                avg_acc += aspd
                avg_n += 1
        km = 0.0
        if distances:
            raw_sum = sum(distances)
            as_m = raw_sum / 1000.0
            as_km = raw_sum
            # Kunlik Labo/furgon: 1..800 km oralig'i ishonchli
            if 1.0 <= as_m <= 800.0:
                km = as_m
            elif 1.0 <= as_km <= 800.0:
                km = as_km
            else:
                km = as_m if as_m >= 1.0 else as_km
        out = {
            "probeg": round(km + 1e-12, 2) if km > 0 else 0.0,
            "maxSpeed": round(max_speed + 1e-12, 1) if max_speed > 0 else 0.0,
            "avgSpeed": round((avg_acc / avg_n) + 1e-12, 1) if avg_n else 0.0,
            "poezdok": len(lst),
        }
        return out if (out["probeg"] or out["maxSpeed"] or out["poezdok"]) else None

    def fetch_unit_trips_km(self, unit_id, date_str):
        st = self.fetch_unit_trips_stats(unit_id, date_str)
        return float((st or {}).get("probeg") or 0)

    def apply_trip_table_km(self, loaded, stats):
        """unit_trips / поездки jadvali jami — Boomerang «Пробег в поездках»."""
        if not isinstance(stats, dict):
            return
        best = 0.0
        for block in loaded or []:
            tbl = block.get("tbl") or {}
            name = str(block.get("name") or "")
            tname = str(tbl.get("name") or "")
            if tname != "unit_trips" and "поезд" not in name:
                continue
            if "хронолог" in name:
                continue
            headers = [self.cell_text(h).lower() for h in (tbl.get("header") or [])]
            km_idx = -1
            for hi, h in enumerate(headers):
                if ("пробег" in h or "mileage" in h or "masofa" in h or "км" in h or "km" in h) and "скорост" not in h and "speed" not in h:
                    km_idx = hi
                    break
            if km_idx < 0:
                continue
            tot = tbl.get("total")
            tot_cells = tot if isinstance(tot, list) else ((tot or {}).get("c") or [])
            tot_km = 0.0
            if km_idx < len(tot_cells):
                tot_km = self.km_from_wialon(
                    self.cell_num(tot_cells[km_idx]), headers[km_idx], self.cell_text(tot_cells[km_idx])
                )
            row_sum = 0.0
            for r in block.get("rows") or []:
                c = r.get("c") or []
                if km_idx >= len(c):
                    continue
                km = self.km_from_wialon(self.cell_num(c[km_idx]), headers[km_idx], self.cell_text(c[km_idx]))
                if 0 < km < 2000:
                    row_sum += km
            trip_km = tot_km or round(row_sum + 1e-12, 2)
            if trip_km > best:
                best = trip_km
            rows_n = int(tbl.get("rows") or 0)
            if rows_n and not stats.get("poezdok"):
                stats["poezdok"] = rows_n
        if best > 0:
            stats["probeg"] = best
            stats["_kmSrc"] = "trips"

    def apply_report_stats(self, pairs, stats):
        best_pref, best_km = -1, 0.0
        best_max_pref, best_max = -1, 0.0
        for pair in pairs or []:
            if not isinstance(pair, (list, tuple)) or len(pair) < 2:
                continue
            k = self.cell_text(pair[0]).lower()
            val = pair[1]
            num = self.cell_num(val)
            txt = self.cell_text(val).strip()
            pref = self.mileage_pref(k)
            if pref >= 0 and num > 0:
                km = self.km_from_wialon(num, k, txt)
                if km > 0 and (pref > best_pref or (pref == best_pref and km > best_km)):
                    best_pref, best_km = pref, km
            if ("скорост" in k or "speed" in k or "tezlik" in k) and ("макс" in k or "max" in k) and num > 0:
                # «Макс. скорость в поездках» ustuvor
                mpref = 3 if ("поезд" in k or "trip" in k) else 1
                if mpref > best_max_pref or (mpref == best_max_pref and num > best_max):
                    best_max_pref, best_max = mpref, num
            if ("средн" in k or "avg" in k or "average" in k) and ("скорост" in k or "speed" in k or "tezlik" in k) and num > 0:
                stats["avgSpeed"] = round(num, 1)
            if ("количество" in k or "count" in k or "soni" in k) and ("поезд" in k or "trip" in k) and num > 0:
                stats["poezdok"] = int(num)
            elif "поезд" in k and "пробег" not in k and "скорост" not in k and num > 0 and not stats.get("poezdok"):
                stats["poezdok"] = int(num)
            if "стоян" in k or "parking" in k or "stay" in k:
                if ("длитель" in k or "продолж" in k or "duration" in k or "время" in k) and re.search(r"\d+:\d+", txt):
                    stats["totalStop"] = re.search(r"\d+:\d+(?::\d+)?", txt).group(0)
                elif num > 0 and "длитель" not in k and "продолж" not in k and "время" not in k:
                    stats["stoyanok"] = int(num)
            if ("движен" in k or "мото" in k or "moto" in k or "engine" in k) and re.search(r"\d+:\d+", txt):
                if "стоян" not in k:
                    stats["motoChas"] = re.search(r"\d+:\d+(?::\d+)?", txt).group(0)
            blob = k + " " + txt
            if ("расход" in k or "потрач" in k or "fuel" in k or "топлив" in k or "sarf" in k) and num > 0:
                if re.search(r"м³|m3|куб|газ|метан|cнг|cng", blob, re.I):
                    stats["gas"] = num
                elif re.search(r"л\b|литр|бензин|дизел|diesel|petrol", blob, re.I):
                    stats["benzin"] = num
        if best_km > 0:
            if stats.get("_kmSrc") == "trips" and best_pref < 3:
                pass
            else:
                stats["probeg"] = best_km
                if best_pref >= 3:
                    stats["_kmSrc"] = "trip_stats"
        if best_max > 0:
            stats["maxSpeed"] = round(best_max, 1)

    def merge_stats(self, base, extra):
        """Boomerang «Отчёт по поездкам» — barcha asosiy metrikalar ustuvor."""
        if not extra:
            return base
        out = dict(base or {})
        for key in ("probeg", "maxSpeed", "avgSpeed", "poezdok"):
            if extra.get(key):
                out[key] = extra[key]
        if extra.get("probeg") and extra.get("_kmSrc"):
            out["_kmSrc"] = extra["_kmSrc"]
        if extra.get("stoyanok") and not out.get("stoyanok"):
            out["stoyanok"] = extra["stoyanok"]
        for key in ("motoChas", "totalStop"):
            if extra.get(key) and extra[key] not in ("", "—"):
                out[key] = extra[key]
        for key in ("gas", "benzin"):
            if extra.get(key) and not out.get(key):
                out[key] = extra[key]
        return out

    def fetch_trip_report_stats(self, unit_id, date_str):
        tpls = self.resolve_templates()
        trip = tpls.get("trip")
        if not trip:
            return None
        t_from, t_to = day_bounds_tashkent(date_str)
        try:
            exec_resp = self._call(
                "report/exec_report",
                {
                    "reportResourceId": trip[0],
                    "reportTemplateId": trip[1],
                    "reportTemplate": None,
                    "reportObjectId": unit_id,
                    "reportObjectSecId": 0,
                    "interval": {"from": t_from, "to": t_to, "flags": 0},
                },
            )
            rr = (exec_resp or {}).get("reportResult") or {}
            stats = {
                "probeg": 0,
                "maxSpeed": 0,
                "avgSpeed": 0,
                "poezdok": 0,
                "stoyanok": 0,
                "gas": 0,
                "benzin": 0,
                "motoChas": "—",
                "totalStop": "—",
            }
            self.apply_report_stats(rr.get("stats") or [], stats)
            loaded = []
            for i, tbl in enumerate(rr.get("tables") or []):
                name = (str(tbl.get("name") or "") + " " + str(tbl.get("label") or "")).lower()
                rows = []
                if "поезд" in name or tbl.get("name") == "unit_trips":
                    rows = self.fetch_rows(i, int(tbl.get("rows") or 0))
                loaded.append({"name": name, "tbl": tbl, "rows": rows})
            self.apply_trip_table_km(loaded, stats)
            try:
                self._call("report/cleanup_result", {})
            except Exception:
                pass
            return stats if stats.get("probeg") or stats.get("poezdok") or stats.get("maxSpeed") else None
        except Exception:
            return None


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
    best_own, best_own_d = None, 1e12
    best_any, best_any_d = None, 1e12
    for ph in pharmacies or []:
        if not isinstance(ph, dict) or ph.get("lat") is None or ph.get("lng") is None:
            continue
        d = haversine_m(y, x, float(ph["lat"]), float(ph["lng"]))
        r = float(ph.get("radiusM") or 120)
        if d > r:
            continue
        if d < best_any_d:
            best_any_d, best_any = d, ph
        if ph.get("car") == current_car and d < best_own_d:
            best_own_d, best_own = d, ph
    best = best_own or best_any
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


def _f4_coord(v):
    try:
        return "%.4f" % float(v or 0)
    except (TypeError, ValueError):
        return "0.0000"


def _review_for_stop(reviews, car_key, stop):
    """To'xtash uchun review topish (vmStopKey + yumshoq moslash)."""
    if not reviews or not isinstance(reviews, dict) or not isinstance(stop, dict):
        return None
    want = compact_car(car_key)
    in_time = str(stop.get("inTime") or "")[:20]
    place = str(stop.get("place") or stop.get("phName") or "")[:50]
    lat = _f4_coord(stop.get("lat"))
    lng = _f4_coord(stop.get("lng"))
    soft = None
    for key, rv in reviews.items():
        if not isinstance(rv, dict):
            continue
        parts = str(key).split("|")
        car_k = rv.get("car") or (parts[1] if len(parts) > 1 else "")
        if compact_car(car_k) != want:
            continue
        if len(parts) >= 6:
            t2 = parts[2]
            lat2 = parts[3]
            lng2 = parts[4]
            p2 = parts[5] if len(parts) > 5 else parts[-1]
            if t2 == in_time and lat2 == lat and lng2 == lng and str(p2)[:50] == place:
                return rv
            if t2 == in_time and str(p2)[:50] == place:
                soft = rv
        elif not soft:
            soft = rv
    return soft


def stop_counts_as_problem(stop, car_key, reviews=None):
    """JS VMOffice.isProblem bilan bir xil: allowed=yo'q, violation=ha, aks holda isProblem."""
    rv = _review_for_stop(reviews, car_key, stop)
    if rv:
        st = rv.get("status")
        if st == "allowed":
            return False
        if st == "violation":
            return True
    return bool(stop and stop.get("isProblem"))


def apply_review_problem_flags(stops, car_key, reviews=None):
    """Saqlangan to'xtash isProblem bayrog'ini review bilan moslashtirish."""
    for s in stops or []:
        if not isinstance(s, dict):
            continue
        s["isProblem"] = stop_counts_as_problem(s, car_key, reviews)
    return stops


def reprocess_car_record(rec, car, drivers, pharmacies, pharm_index, reviews=None):
    if not isinstance(rec, dict):
        return rec
    raw = stops_as_raw(rec.get("stops") or [])
    stops = enrich_stops(raw, car, pharm_index, pharmacies)
    apply_review_problem_flags(stops, car, reviews)
    stats = rec.get("stats") if isinstance(rec.get("stats"), dict) else {}
    analysis = analyze_data(stops, car, stats, drivers, pharmacies, reviews=reviews)
    drv = find_driver_by_car(drivers, car) or (rec.get("driver") if isinstance(rec.get("driver"), dict) else {})
    if isinstance(drv, dict) and drv:
        rec["driver"] = {
            "car": drv.get("car") or car,
            "fullName": drv.get("fullName") or drv.get("name") or car,
            "shortName": drv.get("shortName") or drv.get("short") or car,
            "routes": drv.get("routes") or "—",
            "pharmacies": drv.get("pharmacies") or "",
            "color": drv.get("color") or "#3498db",
        }
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
    drivers = overlay_fuel_driver_names(office, load_fleet_drivers(base_dir))
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
    problem_stops = sum(1 for s in stops or [] if stop_counts_as_problem(s, car_key, reviews))
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
        deduct = min(other_dir * 0.3, 1.5)
        score -= deduct
        breakdown.append(f"-{deduct:.1f}: {other_dir} ta boshqa yo'nalish")
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


def analyze_client_payload(office, base_dir, date_str, car, stops, stats=None, reenrich=False):
    """
    Brauzerdan kelgan to'xtashlar uchun yagona ball manbai (JS analyzeData o'rniga).
    Qaytaradi: (analysis, stops_out)
    """
    car = str(car or "").strip()
    if not car:
        raise ValueError("Mashina ko'rsatilmagan")
    drivers = overlay_fuel_driver_names(office, load_fleet_drivers(base_dir))
    pharmacies = list(office.pharmacies() or [])
    reviews = office.reviews(date_str) or {} if date_str else {}
    raw_stops = stops if isinstance(stops, list) else []
    if reenrich:
        pharm_index = build_pharm_index(drivers, pharmacies)
        out_stops = enrich_stops(stops_as_raw(raw_stops), car, pharm_index, pharmacies)
    else:
        out_stops = []
        for s in raw_stops:
            if isinstance(s, dict):
                out_stops.append(dict(s))
    apply_review_problem_flags(out_stops, car, reviews)
    analysis = analyze_data(out_stops, car, stats if isinstance(stats, dict) else {}, drivers, pharmacies, reviews=reviews)
    return analysis, out_stops


def analyze_client_batch(office, base_dir, date_str, items, reenrich=False):
    """items: [{car, stops, stats}, ...] -> { car: { analysis, stops } }"""
    out = {}
    for it in items or []:
        if not isinstance(it, dict):
            continue
        car = str(it.get("car") or "").strip()
        if not car:
            continue
        analysis, stops = analyze_client_payload(
            office,
            base_dir,
            date_str,
            car,
            it.get("stops") or [],
            it.get("stats"),
            reenrich=reenrich,
        )
        out[car] = {"analysis": analysis, "stops": stops}
    return out


def sync_today(office, base_dir, date_str=None, saved_by="auto", time_budget_sec=None, parallel=True, force=False):
    """
    GPS sync. time_budget_sec — Vercel/cron: vaqt tugasa qisman saqlab qaytadi.
    force=True — kunni yangidan tortadi; force=False + budget — faqat qolgan mashinalar.
    """
    import time
    from concurrent.futures import ThreadPoolExecutor, as_completed

    date_str = date_str or today_tashkent()
    t0 = time.time()
    budget = float(time_budget_sec) if time_budget_sec else None
    force = bool(force)

    def left():
        if budget is None:
            return 9999.0
        return budget - (time.time() - t0)

    cfg = office.gps_config_internal() if office is not None else None
    if office is None:
        return {"ok": False, "error": "OFFICE None — init_app chaqirilmagan"}
    if not cfg.get("configured"):
        return {"ok": False, "error": "GPS sozlamasi yo'q"}
    host = cfg.get("host") or "http://bms1.gpsavto.uz"
    http_timeout = 18 if budget is not None else 45
    client = WialonClient(
        host,
        token=cfg.get("token") or "",
        user=cfg.get("user") or "",
        password=cfg.get("password") or "",
        timeout=http_timeout,
    )
    office.set_gps_status(running=True, error="", date=date_str, message="GPS ga ulanilmoqda...")
    try:
        client.login()
        try:
            client.resolve_template()
        except Exception:
            pass
        if left() < 3:
            office.set_gps_status(running=False, error="Vaqt tugadi", date=date_str, message="Qayta uriniladi")
            return {"ok": False, "error": "Vaqt tugadi", "partial": True, "date": date_str, "cars": 0}

        office.set_gps_status(running=True, date=date_str, message="Mashinalar ro'yxati olinmoqda...")
        units = client.get_units()
        drivers = overlay_fuel_driver_names(office, load_fleet_drivers(base_dir))
        pharmacies = list(office.pharmacies())
        pharm_index = build_pharm_index(drivers, pharmacies)

        all_jobs = []
        for unit in units:
            name = str(unit.get("nm") or unit.get("name") or "")
            drv = find_driver_by_car(drivers, name)
            if not drv:
                continue
            all_jobs.append((unit, drv))
        total_fleet = len(all_jobs)

        prev = office.get_report(date_str)
        prev_cars = {}
        if isinstance(prev, dict) and isinstance(prev.get("cars"), dict):
            prev_cars = dict(prev.get("cars") or {})

        # To'liq yangilash yoki budgetsiz — eski noto'g'ri qiymatlarni tashlash
        if force or budget is None:
            cars = {}
            jobs = list(all_jobs)
        else:
            cars = dict(prev_cars)
            jobs = [
                (u, d)
                for u, d in all_jobs
                if not (isinstance(cars.get(d["car"]), dict) and cars[d["car"]].get("syncedAt"))
            ]

        if not jobs:
            office.set_gps_status(running=False, cars=len(cars), error="", date=date_str, message="Tayyor")
            return {
                "ok": True,
                "date": date_str,
                "cars": len(cars),
                "fetched": len(cars),
                "total": total_fleet,
                "partial": False,
                "errors": [],
            }

        def fetch_one(unit, drv):
            wc = client.clone_session()
            chrono = wc.get_chronology(unit["id"], date_str)
            raw_stops = chrono.get("stops") or []
            stats = dict(chrono.get("stats") or {})
            return drv, raw_stops, stats, None

        unit_rows = []
        errors = []
        workers = 4 if parallel and len(jobs) > 1 else 1
        office.set_gps_status(
            running=True,
            date=date_str,
            message="Yuklanmoqda (%d/%d)..." % (len(jobs), total_fleet),
        )

        if workers == 1:
            for unit, drv in jobs:
                if left() < 4:
                    break
                try:
                    unit_rows.append(fetch_one(unit, drv))
                except Exception as e:
                    errors.append("%s: %s" % (drv.get("car") or "?", str(e)[:80]))
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futs = {pool.submit(fetch_one, u, d): d for u, d in jobs}
                for fut in as_completed(futs):
                    drv_meta = futs[fut]
                    if left() < 4:
                        for f in futs:
                            f.cancel()
                        break
                    try:
                        unit_rows.append(fut.result())
                    except Exception as e:
                        errors.append("%s: %s" % ((drv_meta or {}).get("car") or "?", str(e)[:80]))

        if left() > 6:
            for row in unit_rows:
                drv, raw_stops = row[0], row[1]
                stops = enrich_stops(raw_stops, drv["car"], pharm_index, pharmacies)
                learn_geozones_from_stops(pharmacies, drv["car"], stops)
            learn_geozones_from_reviews(pharmacies, office.reviews(date_str) or {})
            if any(isinstance(p, dict) and p.get("lat") is not None for p in pharmacies):
                office.save_pharmacies(pharmacies)
                pharmacies = office.pharmacies()
                pharm_index = build_pharm_index(drivers, pharmacies)

        reviews = office.reviews(date_str) or {}
        done = 0
        for row in unit_rows:
            drv, raw_stops, stats = row[0], row[1], row[2]
            stops = enrich_stops(raw_stops, drv["car"], pharm_index, pharmacies)
            apply_review_problem_flags(stops, drv["car"], reviews)
            if not stats.get("stoyanok"):
                stats["stoyanok"] = len(stops)
            WialonClient.cleanup_stats(stats)
            analysis = analyze_data(stops, drv["car"], stats, drivers, pharmacies, reviews=reviews)
            cars[drv["car"]] = {
                "car": drv["car"],
                "driver": drv,
                "date": date_str,
                "stats": stats,
                "stops": stops,
                "analysis": analysis,
                "syncedAt": int(time.time()),
            }
            done += 1

        synced_n = sum(1 for r in cars.values() if isinstance(r, dict) and r.get("syncedAt"))
        partial = synced_n < total_fleet
        if cars:
            office.save_report(date_str, cars, saved_by=saved_by)
        err_txt = ("; ".join(errors[:5]) + ("…" if len(errors) > 5 else "")) if errors else ""
        if partial and not err_txt:
            err_txt = "Qisman: %d/%d mashina" % (synced_n, total_fleet)
        msg = "Qisman — davom etadi" if partial else "Tayyor"
        office.set_gps_status(
            running=False,
            cars=len(cars),
            error=err_txt[:200] if partial else "",
            date=date_str,
            message=msg,
        )
        return {
            "ok": done > 0 or synced_n > 0,
            "date": date_str,
            "cars": len(cars),
            "fetched": synced_n,
            "chunk": done,
            "total": total_fleet,
            "partial": partial,
            "errors": errors[:20],
        }
    except Exception as e:
        office.set_gps_status(running=False, error=str(e)[:200], date=date_str, message="Xato")
        return {"ok": False, "error": str(e)}
