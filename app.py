"""Vercel production entrypoint — barcha so'rovlar vm_server orqali."""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

from fastapi import FastAPI, Request
from fastapi.responses import Response

app = FastAPI()


def _client_ip(request: Request) -> str:
    fwd = (request.headers.get("x-forwarded-for") or "").strip()
    if fwd:
        return fwd.split(",")[0].strip()
    return request.headers.get("x-real-ip") or "127.0.0.1"


def _cron_authorized(request: Request) -> bool:
    secret = (os.environ.get("CRON_SECRET") or "").strip()
    auth = (request.headers.get("authorization") or "").strip()
    return bool(secret) and auth == f"Bearer {secret}"


def _github_dispatch_gps_sync() -> dict:
    """
    Og'ir uzun loop — GitHub Actions (ixtiyoriy zaxira).
    GH_PAT bo'lmasa: dispatched=false (Vercel o'zi sync qiladi).
    """
    pat = (os.environ.get("GH_PAT") or os.environ.get("GITHUB_PAT") or "").strip()
    repo = (os.environ.get("GITHUB_REPOSITORY") or os.environ.get("GH_REPO") or "").strip()
    if not repo:
        owner = (os.environ.get("GH_OWNER") or "otaqulov2222").strip()
        name = (os.environ.get("GH_REPO_NAME") or "GPS-VaksinaMed").strip()
        repo = f"{owner}/{name}"
    ref = (os.environ.get("GH_REF") or "main").strip() or "main"
    workflow = (os.environ.get("GH_GPS_WORKFLOW") or "gps-sync.yml").strip() or "gps-sync.yml"

    if not pat:
        return {
            "ok": True,
            "accepted": True,
            "dispatched": False,
            "message": "GH_PAT yo'q — Vercel sync ishlaydi. Ixtiyoriy: GH_PAT (repo+workflow).",
        }

    url = f"https://api.github.com/repos/{repo}/actions/workflows/{workflow}/dispatches"
    body = json.dumps({"ref": ref}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {pat}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "VaksinaMed-GPS-Cron",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            code = getattr(resp, "status", 204) or 204
        return {
            "ok": True,
            "accepted": True,
            "dispatched": True,
            "http": int(code),
            "repo": repo,
            "ref": ref,
            "message": "GitHub Actions GPS sync ishga tushirildi.",
        }
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", "ignore")[:180]
        return {
            "ok": False,
            "accepted": True,
            "dispatched": False,
            "http": int(e.code),
            "error": err or str(e.reason),
            "message": "GitHub dispatch xato — Vercel sync davom etadi.",
        }
    except Exception as e:
        return {
            "ok": False,
            "accepted": True,
            "dispatched": False,
            "error": str(e)[:160],
            "message": "GitHub dispatch ulanmadi — Vercel sync davom etadi.",
        }


def _count_synced(cars) -> int:
    if not isinstance(cars, dict):
        return 0
    return sum(1 for r in cars.values() if isinstance(r, dict) and r.get("syncedAt"))


def _newest_synced_at(cars) -> int:
    best = 0
    if not isinstance(cars, dict):
        return 0
    for r in cars.values():
        if not isinstance(r, dict):
            continue
        try:
            t = int(r.get("syncedAt") or 0)
        except Exception:
            t = 0
        if t > best:
            best = t
    return best


def _oldest_synced_at(cars) -> int:
    """0 = hech bo'lmagan / yetishmagan — darhol yangilash kerak."""
    if not isinstance(cars, dict) or not cars:
        return 0
    oldest = None
    for r in cars.values():
        if not isinstance(r, dict):
            return 0
        try:
            t = int(r.get("syncedAt") or 0)
        except Exception:
            t = 0
        if not t:
            return 0
        if oldest is None or t < oldest:
            oldest = t
    return int(oldest or 0)


def _vercel_gps_sync_backup() -> dict:
    """
    Asosiy ishonch: Vercel cron o'zi ma'lumot tortadi (GitHub schedule kechiksa ham).
    maxDuration=300 — ~90s budget yetarli.
    """
    t0 = time.time()
    try:
        import gps_sync
        import vm_server

        vm_server.init_app()
        office = vm_server.OFFICE
        directory = vm_server.DIRECTORY
        if office is None:
            return {"ok": False, "error": "OFFICE yo'q"}

        cfg = office.gps_config_public()
        if not cfg.get("configured"):
            return {
                "ok": False,
                "error": "GPS sozlamasi yo'q",
                "configured": False,
            }

        d = gps_sync.today_tashkent()
        drivers = gps_sync.overlay_fuel_driver_names(
            office, gps_sync.load_fleet_drivers(directory)
        )
        fleet_n = len(drivers) if drivers else 0
        prev = office.get_report(d) or {}
        cars = prev.get("cars") if isinstance(prev, dict) else {}
        if not isinstance(cars, dict):
            cars = {}
        synced = _count_synced(cars)
        newest = _newest_synced_at(cars)
        oldest = _oldest_synced_at(cars)
        now_ts = int(time.time())
        # Eng ESKI mashina 3 daqiqadan eski bo'lsa — yangilash (bitta yangi bo'lsa yetmaydi)
        stale = (not oldest) or ((now_ts - oldest) >= 180)
        new_day = fleet_n > 0 and synced == 0
        incomplete = fleet_n > 0 and synced < fleet_n

        if not new_day and not incomplete and not stale:
            # Yengil km (og'ir 120s o'rniga) — asosiy to'ldirish GitHub Actions
            km_refresh = gps_sync.refresh_day_trip_km(
                office,
                directory,
                d,
                time_budget_sec=45,
                saved_by="vercel-km",
            )
            km_n = int(km_refresh.get("updated") or 0)
            office.set_gps_status(
                running=False,
                cars=len(cars),
                error="",
                date=d,
                message=(
                    "Km yangilandi (%d)" % km_n
                    if km_n
                    else "Tekshirildi — ma'lumot yangi"
                ),
                fetched=synced,
                total=max(fleet_n, synced, 1),
                # Oxirgi vaqt har tekshiruvda yangilansin (06:48 da qotib qolmasin)
                touch_last_sync=True,
            )
            return {
                "ok": True,
                "skipped": True,
                "date": d,
                "fetched": synced,
                "total": fleet_n or synced,
                "newest": newest,
                "oldest": oldest,
                "kmRefresh": km_refresh,
                "elapsed": round(time.time() - t0, 2),
            }

        force = bool(new_day or stale)
        # Qisqa budget — timeout/504 kamayadi; qisman bo'lsa keyingi cron davom etadi
        result = (
            gps_sync.sync_today(
                office,
                directory,
                d,
                saved_by="vercel-cron",
                time_budget_sec=90,
                parallel=True,
                force=force,
                max_cars=8,
            )
            or {}
        )

        remain = max(15, 140 - int(time.time() - t0))
        km_refresh = gps_sync.refresh_day_trip_km(
            office,
            directory,
            d,
            time_budget_sec=min(50, remain),
            saved_by="vercel-km",
        )

        # Kecha — faqat vaqt qolsa (og'ir double-sync yo'q)
        if result.get("ok") and time.time() - t0 < 110:
            yday = gps_sync.yesterday_tashkent()
            yrec = office.get_report(yday) or {}
            ycars = yrec.get("cars") if isinstance(yrec, dict) else {}
            if not isinstance(ycars, dict):
                ycars = {}
            ysynced = _count_synced(ycars)
            if fleet_n and ysynced < fleet_n:
                gps_sync.sync_today(
                    office,
                    directory,
                    yday,
                    saved_by="vercel-cron-yday",
                    time_budget_sec=max(12, 150 - int(time.time() - t0)),
                    parallel=True,
                    force=False,
                    max_cars=6,
                )

        fetched = int(result.get("fetched") or 0)
        total = int(result.get("total") or fleet_n or 0)
        km_n = int((km_refresh or {}).get("updated") or 0)
        msg = "Yangilandi"
        if result.get("partial"):
            msg = "Qisman — davom"
        if km_n:
            msg = "Km+%d · %s" % (km_n, msg)
        office.set_gps_status(
            running=False,
            cars=len(cars),
            error=str(result.get("error") or "")[:200],
            date=d,
            message=msg,
            fetched=fetched,
            total=max(total, fleet_n, 1),
            touch_last_sync=True,
        )

        return {
            "ok": bool(result.get("ok")),
            "skipped": False,
            "force": force,
            "date": d,
            "fetched": fetched,
            "total": total,
            "partial": bool(result.get("partial")),
            "kmRefresh": km_refresh,
            "error": str(result.get("error") or "")[:160],
            "elapsed": round(time.time() - t0, 2),
        }
    except Exception as e:
        return {
            "ok": False,
            "error": str(e)[:200],
            "elapsed": round(time.time() - t0, 2),
        }


@app.api_route("/", methods=["GET", "POST", "OPTIONS", "HEAD"], include_in_schema=False)
@app.api_route("/{full_path:path}", methods=["GET", "POST", "OPTIONS", "HEAD"], include_in_schema=False)
async def handle(request: Request, full_path: str = ""):
    path = request.url.path or "/"

    # Yengil health — vm_server / Neon OLMASDAN (25s 504 ni to'xtatadi)
    if path == "/api/health" and request.method in ("GET", "HEAD", "OPTIONS"):
        if request.method == "OPTIONS":
            return Response(status_code=204)
        # Import qilmasdan ham build ko'rinsin — domain eski deploydami tekshirish uchun
        try:
            from vm_server import VM_BUILD as _build
        except Exception:
            _build = "m122"
        body = json.dumps(
            {
                "ok": True,
                "ts": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
                "lite": True,
                "build": str(_build),
                "live": True,
            }
        ).encode("utf-8")
        headers = {
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "X-VM-Build": str(_build),
        }
        if request.method == "HEAD":
            return Response(status_code=200, headers=headers, media_type="application/json")
        return Response(
            content=body,
            status_code=200,
            headers=headers,
            media_type="application/json",
        )

    # Live menyu inject — HTML/JS keshidan mustaqil (domain eski bo'lsa ham API yangi bo'lsa ishlaydi)
    if path == "/api/live-nav.js" and request.method in ("GET", "HEAD"):
        js = (
            "(function(){function go(){try{var ns=document.querySelectorAll('.nav-rail .nav-links');"
            "ns.forEach(function(nav){var a=nav.querySelector('a[href=\"/live.html\"],#nav-live');"
            "if(!a){a=document.createElement('a');a.href='/live.html';a.id='nav-live';"
            "a.className='nav-link staff-only';a.textContent='Live';"
            "var f=nav.querySelector('a[href=\"/fuel.html\"]');var d=nav.querySelector('a[href=\"/attendance.html\"],#nav-davomat');"
            "if(f)f.insertAdjacentElement('afterend',a);else if(d)d.insertAdjacentElement('beforebegin',a);else nav.appendChild(a);}"
            "a.href='/live.html';a.textContent='Live';a.removeAttribute('hidden');a.style.display='';a.style.visibility='visible';});"
            "}catch(e){}}go();document.addEventListener('DOMContentLoaded',go);setInterval(go,30000);})();"
        )
        headers = {"Cache-Control": "no-store, no-cache, must-revalidate"}
        if request.method == "HEAD":
            return Response(status_code=200, headers=headers, media_type="application/javascript")
        return Response(content=js.encode("utf-8"), status_code=200, headers=headers, media_type="application/javascript")

    # Cron: 1) GitHub uyg'otish (ixtiyoriy)  2) Vercel o'zi sync (asosiy ishonch)
    if path == "/api/cron/gps-sync" and request.method in ("GET", "POST", "HEAD"):
        if not _cron_authorized(request):
            return Response(
                content=b'{"ok":false,"error":"Unauthorized"}',
                status_code=401,
                media_type="application/json",
            )
        if request.method == "HEAD":
            return Response(status_code=202, media_type="application/json")
        dispatch = _github_dispatch_gps_sync()
        sync = _vercel_gps_sync_backup()
        payload = {
            "ok": bool(sync.get("ok") or dispatch.get("dispatched")),
            "accepted": True,
            "github": dispatch,
            "sync": sync,
            "message": (
                "GPS cron: Vercel sync + GitHub zaxira"
                if dispatch.get("dispatched")
                else "GPS cron: Vercel sync (GitHub PAT ixtiyoriy)"
            ),
        }
        return Response(
            content=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            status_code=202,
            media_type="application/json",
        )

    from vm_server import dispatch_http

    body = await request.body()
    dispatch_path = path
    if request.url.query:
        dispatch_path += "?" + str(request.url.query)
    status, out_headers, out_body = dispatch_http(
        request.method,
        dispatch_path,
        dict(request.headers),
        body,
        _client_ip(request),
    )
    skip = {"transfer-encoding", "connection", "content-length", "content-encoding"}
    headers = {k: v for k, v in out_headers.items() if k.lower() not in skip}
    media_type = headers.pop("Content-Type", None) or headers.pop("content-type", None)
    if request.method == "HEAD":
        return Response(status_code=status, headers=headers, media_type=media_type)
    return Response(
        content=out_body, status_code=status, headers=headers, media_type=media_type
    )
