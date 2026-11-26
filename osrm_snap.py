# -*- coding: utf-8 -*-
"""GPS trekni OSRM orqali yo'lga yopishtirish (server tomonda — CORS/SSL muammosiz)."""
from __future__ import annotations

import json
import math
import threading
import time
import urllib.error
import urllib.request

OSRM_BASE = "https://router.project-osrm.org"
_UA = "VaksinaMed-GPS/1.0 (route-snap)"
_LIVE_LOCK = threading.Lock()
_NEAREST_CACHE: dict[tuple, tuple[float, list[float]]] = {}
_ROUTE_SEG_CACHE: dict[tuple, tuple[float, list[list[float]]]] = {}
_LIVE_CACHE_TTL = 90.0
_LIVE_CACHE_MAX = 2500


def _haversine_m(a, b):
    lat1, lng1 = float(a[0]), float(a[1])
    lat2, lng2 = float(b[0]), float(b[1])
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    x = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(x)))


def _clean(points):
    out = []
    for p in points or []:
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        try:
            lat, lng = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            continue
        if not (37 <= lat <= 46 and 55 <= lng <= 74):
            continue
        if out and abs(out[-1][0] - lat) < 1e-7 and abs(out[-1][1] - lng) < 1e-7:
            continue
        out.append([lat, lng])
    return out


def _path_len(pts):
    return sum(_haversine_m(pts[i - 1], pts[i]) for i in range(1, len(pts)))


def _resample(pts, step_m=70.0):
    if len(pts) < 2:
        return pts
    out = [pts[0]]
    acc = 0.0
    for i in range(1, len(pts)):
        acc += _haversine_m(pts[i - 1], pts[i])
        if acc >= step_m:
            out.append(pts[i])
            acc = 0.0
    if _haversine_m(out[-1], pts[-1]) > 20:
        out.append(pts[-1])
    else:
        out[-1] = pts[-1]
    return out


def _simplify_rdp(pts, tol_m=14.0):
    if len(pts) < 3:
        return pts

    def dist_point_seg(p, a, b):
        if _haversine_m(a, b) < 0.5:
            return _haversine_m(p, a)
        # local meters projection
        def to_xy(q, origin):
            y = _haversine_m(origin, [q[0], origin[1]]) * (1 if q[0] >= origin[0] else -1)
            x = _haversine_m(origin, [origin[0], q[1]]) * (1 if q[1] >= origin[1] else -1)
            return x, y

        ax, ay = 0.0, 0.0
        bx, by = to_xy(b, a)
        px, py = to_xy(p, a)
        denom = bx * bx + by * by
        if denom < 1e-6:
            return _haversine_m(p, a)
        t = max(0.0, min(1.0, (px * bx + py * by) / denom))
        qx, qy = ax + t * bx, ay + t * by
        return math.hypot(px - qx, py - qy)

    def rdp(seq):
        if len(seq) < 3:
            return seq
        a, b = seq[0], seq[-1]
        max_d, idx = 0.0, 0
        for i in range(1, len(seq) - 1):
            d = dist_point_seg(seq[i], a, b)
            if d > max_d:
                max_d, idx = d, i
        if max_d > tol_m:
            left = rdp(seq[: idx + 1])
            right = rdp(seq[idx:])
            return left[:-1] + right
        return [a, b]

    return rdp(pts)


def _osrm_get(url, timeout=18):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": _UA, "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def _route_batch(waypoints, timeout=18, bearings=None):
    """OSRM driving route — faqat yo'l geometriyasi. Muvaffaqiyatsiz → None."""
    if len(waypoints) < 2:
        return None
    pts = waypoints[:25]
    coords = ";".join("%.6f,%.6f" % (p[1], p[0]) for p in pts)
    url = (
        OSRM_BASE
        + "/route/v1/driving/"
        + coords
        + "?overview=full&geometries=geojson&steps=false&continue_straight=true"
    )
    if bearings and len(bearings) == len(pts):
        b_parts = []
        for b in bearings:
            if b is None:
                b_parts.append("")
            else:
                deg, tol = b
                b_parts.append(f"{int(round(deg)) % 360},{int(tol)}")
        if any(b_parts):
            url += "&bearings=" + ";".join(b_parts)
    try:
        data = _osrm_get(url, timeout=timeout)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError):
        return None
    if not data or data.get("code") != "Ok":
        return None
    routes = data.get("routes") or []
    if not routes:
        return None
    geom = (routes[0] or {}).get("geometry") or {}
    coords_ll = geom.get("coordinates") or []
    if len(coords_ll) < 2:
        return None
    return [[c[1], c[0]] for c in coords_ll]


def _append(out, geom):
    if not geom:
        return
    for p in geom:
        if not out or _haversine_m(out[-1], p) > 1.5:
            out.append(p)


def snap_track_to_roads(points, sample_m=65.0, batch_size=16):
    """
    GPS → yo'l bo'ylab polyline.
    Qaytaradi: {ok, points:[[lat,lng],...], snapped:bool, meta:{...}}
    """
    pts = _clean(points)
    if len(pts) < 2:
        return {"ok": False, "error": "Nuqtalar yetarli emas", "points": pts, "snapped": False}

    pts = _simplify_rdp(pts, 12.0)
    samples = _resample(pts, sample_m)
    # juda uzun bo'lsa siyraklashtirish
    while len(samples) > 140 and sample_m < 250:
        sample_m *= 1.25
        samples = _resample(pts, sample_m)
    if len(samples) < 2:
        return {"ok": False, "error": "Namuna yo'q", "points": pts, "snapped": False}

    out = []
    batches_ok = 0
    batches_fail = 0
    i = 0
    n = len(samples)
    while i < n - 1:
        end = min(n, i + batch_size)
        batch = samples[i:end]
        road = _route_batch(batch)
        if not road or len(road) < 2:
            # juft-juft urinish
            road = []
            for j in range(len(batch) - 1):
                pair = _route_batch([batch[j], batch[j + 1]])
                if pair:
                    _append(road, pair)
            if len(road) < 2:
                batches_fail += 1
                i = end - 1 if end < n else end
                continue
        batches_ok += 1
        if not out:
            _append(out, road)
        else:
            start = 0
            last = out[-1]
            for k in range(min(25, len(road))):
                if _haversine_m(last, road[k]) < 35:
                    start = k + 1
            _append(out, road[start:])
        if end >= n:
            break
        i = end - 1

    if len(out) < 8 or batches_ok < 1:
        return {
            "ok": False,
            "error": "OSRM yo'l topilmadi",
            "points": pts,
            "snapped": False,
            "meta": {"batchesOk": batches_ok, "batchesFail": batches_fail},
        }

    # sifat: yo'l uzunligi aslidan juda qisqa/uzun bo'lmasin
    src_len = _path_len(samples) or 1.0
    road_len = _path_len(out) or 1.0
    ratio = road_len / src_len
    if ratio < 0.35 or ratio > 3.5:
        return {
            "ok": False,
            "error": "Yo'l sifati past",
            "points": pts,
            "snapped": False,
            "meta": {"ratio": round(ratio, 2), "batchesOk": batches_ok},
        }

    return {
        "ok": True,
        "points": out,
        "snapped": True,
        "meta": {
            "samples": len(samples),
            "roadPts": len(out),
            "batchesOk": batches_ok,
            "batchesFail": batches_fail,
            "km": round(road_len / 1000.0, 2),
        },
    }


def _trim_cache(cache: dict):
    if len(cache) > _LIVE_CACHE_MAX:
        # Remove oldest third
        for k in list(cache.keys())[: len(cache) // 3]:
            cache.pop(k, None)


def snap_point_to_road(lat, lng, course=None, max_dist_m=42.0, timeout=1.8):
    """Bitta GPS nuqtani yo'nalish bo'yicha eng yaqin yo'l polosasiga yopishtiradi."""
    try:
        flat, flng = float(lat), float(lng)
    except (TypeError, ValueError):
        return [lat, lng]
    if not (37 <= flat <= 46 and 55 <= flng <= 74):
        return [flat, flng]

    crs_val = None
    if course is not None:
        try:
            c = float(course)
            if math.isfinite(c) and c >= 0:
                crs_val = int(round(c)) % 360
        except (TypeError, ValueError):
            crs_val = None

    crs_bucket = (crs_val // 20) if crs_val is not None else -1
    key = (round(flat, 4), round(flng, 4), crs_bucket)
    now = time.monotonic()
    with _LIVE_LOCK:
        hit = _NEAREST_CACHE.get(key)
        if hit and (now - hit[0]) < _LIVE_CACHE_TTL:
            return hit[1]

    def _query(bearing_deg, tol=50):
        url = f"{OSRM_BASE}/nearest/v1/driving/{flng:.6f},{flat:.6f}?number=1"
        if bearing_deg is not None:
            url += f"&bearings={bearing_deg},{int(tol)}"
        try:
            data = _osrm_get(url, timeout=timeout)
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError):
            return None
        wps = (data or {}).get("waypoints") or []
        if not wps or not isinstance(wps[0], dict):
            return None
        loc = wps[0].get("location") or []
        if len(loc) < 2:
            return None
        slng, slat = float(loc[0]), float(loc[1])
        dist = _haversine_m([flat, flng], [slat, slng])
        return [slat, slng], dist

    snapped = [flat, flng]
    res = _query(crs_val, 50)
    if res and res[1] <= max_dist_m:
        snapped = res[0]
    elif crs_val is not None:
        # Faqat 4.5m ichida bo'lsa yo'nalishsiz tekshiramiz (qarama-qarshi polosaga sakramaslik uchun)
        res2 = _query(None)
        if res2 and res2[1] <= min(4.5, max_dist_m):
            snapped = res2[0]

    with _LIVE_LOCK:
        _trim_cache(_NEAREST_CACHE)
        _NEAREST_CACHE[key] = (now, snapped)
    return snapped


def _bearing_deg(a, b):
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlng = math.radians(b[1] - a[1])
    y = math.sin(dlng) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlng)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def _angle_diff(a, b):
    return ((b - a + 540.0) % 360.0) - 180.0


def _lateral_offset_m(pt, a, b):
    """Perpendicular distance in meters from pt to segment line a->b."""
    ab = _haversine_m(a, b)
    if ab < 1.0:
        return _haversine_m(pt, a)
    brng_ab = math.radians(_bearing_deg(a, b))
    brng_ap = math.radians(_bearing_deg(a, pt))
    ap = _haversine_m(a, pt)
    return abs(ap * math.sin(brng_ap - brng_ab))


def snap_live_segment(prev_pt, cur_pt, course=None, timeout=2.2):
    """Live harakatda oldingi nuqtadan yangi nuqtagacha haqiqiy yo'l egriligini qaytaradi."""
    try:
        clat, clng = float(cur_pt[0]), float(cur_pt[1])
    except (TypeError, ValueError, IndexError):
        return {"ok": False, "error": "cur_pt noto'g'ri"}

    has_prev = prev_pt and isinstance(prev_pt, (list, tuple)) and len(prev_pt) >= 2
    if not has_prev:
        snapped_cur = snap_point_to_road(clat, clng, course=course, max_dist_m=32.0, timeout=timeout)
        return {"ok": True, "snapped": snapped_cur, "path": [snapped_cur]}

    try:
        plat, plng = float(prev_pt[0]), float(prev_pt[1])
    except (TypeError, ValueError):
        snapped_cur = snap_point_to_road(clat, clng, course=course, max_dist_m=32.0, timeout=timeout)
        return {"ok": True, "snapped": snapped_cur, "path": [snapped_cur]}

    raw_dist_m = _haversine_m([plat, plng], [clat, clng])
    disp_bearing = _bearing_deg([plat, plng], [clat, clng]) if raw_dist_m >= 12.0 else None
    eff_course = course
    try:
        c_num = float(course) if course is not None else None
    except (TypeError, ValueError):
        c_num = None
    if disp_bearing is not None:
        if c_num is None or not (0.0 <= c_num <= 360.0) or abs(_angle_diff(c_num, disp_bearing)) > 45.0:
            eff_course = disp_bearing
        else:
            eff_course = c_num

    snapped_prev = snap_point_to_road(plat, plng, course=eff_course, max_dist_m=24.0, timeout=timeout)
    snapped_cur = snap_point_to_road(clat, clng, course=eff_course, max_dist_m=32.0, timeout=timeout)
    direct_m = _haversine_m(snapped_prev, snapped_cur)
    if direct_m < 10.0 or direct_m > 900.0:
        return {"ok": True, "snapped": snapped_cur, "path": [snapped_prev, snapped_cur]}

    crs_bucket = (int(round(float(eff_course))) % 360 // 20) if eff_course is not None else -1
    seg_key = (round(snapped_prev[0], 4), round(snapped_prev[1], 4), round(snapped_cur[0], 4), round(snapped_cur[1], 4), crs_bucket)
    now = time.monotonic()
    with _LIVE_LOCK:
        hit = _ROUTE_SEG_CACHE.get(seg_key)
        if hit and (now - hit[0]) < _LIVE_CACHE_TTL:
            return {"ok": True, "snapped": snapped_cur, "path": hit[1]}

    brng_pair = None
    if eff_course is not None:
        try:
            b_deg = int(round(float(eff_course))) % 360
            brng_pair = [(b_deg, 50), (b_deg, 50)]
        except (TypeError, ValueError):
            brng_pair = None

    road = _route_batch([snapped_prev, snapped_cur], timeout=timeout, bearings=brng_pair)
    path = [snapped_prev, snapped_cur]
    if road and len(road) >= 2:
        rlen = _path_len(road)
        max_lat = max(38.0, direct_m * 0.55)
        corridor_ok = True
        if direct_m < 180.0:
            for p in road:
                if _lateral_offset_m(p, snapped_prev, snapped_cur) > max_lat:
                    corridor_ok = False
                    break
        if corridor_ok and rlen <= direct_m * 1.45 + 25.0:
            path = road

    with _LIVE_LOCK:
        _trim_cache(_ROUTE_SEG_CACHE)
        _ROUTE_SEG_CACHE[seg_key] = (now, path)
    return {"ok": True, "snapped": snapped_cur, "path": path}

