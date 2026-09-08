#!/usr/bin/env python3
"""
Kunlik to'liq GPS odat — GitHub Actions (Vercel 25s limitsiz).

Mantiq (Toshkent vaqti):
1) Bugun to'liq emas → yetishmayotgan mashinalarni to'ldirish
2) Ish vaqti (06–22) va oxirgi sync eskirgan (≥3 daqiqa) → barcha mashinani yangilash
3) Kecha bo'sh/qisman → kechani ham to'ldirish

GitHub schedule har 10 daqiqada ISHONCHSIZ (throttle). Shuning uchun
GPS_CRON_LOOP_MIN>0 bo'lsa bitta job ichida har ~3 daqiqada sync qiladi.
"""
from __future__ import annotations

import os
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
os.environ.setdefault("VM_PRODUCTION", "1")

TZ5 = timezone(timedelta(hours=5))
REFRESH_EVERY_SEC = int(os.environ.get("GPS_REFRESH_EVERY_SEC", str(3 * 60)))
LOOP_MINUTES = int(os.environ.get("GPS_CRON_LOOP_MIN", "0"))
LOOP_SLEEP = int(os.environ.get("GPS_CRON_LOOP_SLEEP", "180"))
# Qo'lda "Run workflow" — bitta sync, tez yashil ✓ (soatlik schedule esa loop)
if (
    os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
    and os.environ.get("GPS_CRON_FORCE_LOOP", "").strip() != "1"
):
    LOOP_MINUTES = 0


def _count_synced(cars):
    if not isinstance(cars, dict):
        return 0
    return sum(1 for r in cars.values() if isinstance(r, dict) and r.get("syncedAt"))


def _newest_synced_at(cars):
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


def _oldest_synced_at(cars):
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


def _should_force_refresh(cars, total_fleet, now_ts, hour):
    if total_fleet <= 0:
        return False
    synced = _count_synced(cars)
    if synced < total_fleet:
        return False
    if hour < 6 or hour > 22:
        return False
    oldest = _oldest_synced_at(cars)
    if not oldest:
        return True
    return (now_ts - oldest) >= REFRESH_EVERY_SEC


def run_once():
    if not (os.environ.get("DATABASE_URL") or "").strip():
        print("ERROR: DATABASE_URL yo'q")
        return 1

    try:
        import vm_server
        import gps_sync

        print("init_app...")
        vm_server.init_app(ROOT)
        vm_server.seed_gps_from_env(vm_server.OFFICE)

        office = vm_server.OFFICE
        directory = vm_server.DIRECTORY
        if office is None:
            print("ERROR: OFFICE init bo'lmadi")
            return 1

        cfg = office.gps_config_public()
        print(
            "GPS config:",
            {
                "configured": cfg.get("configured"),
                "host": cfg.get("host"),
                "user": cfg.get("user"),
                "hasToken": cfg.get("hasToken"),
                "hasPassword": cfg.get("hasPassword"),
            },
        )
        if not cfg.get("configured"):
            print(
                "ERROR: GPS sozlamasi yo'q. Dashboardda GPS ULANISH qiling "
                "YOKI GitHub Secrets ga GPS_TOKEN (yoki GPS_USER+GPS_PASSWORD) qo'ying."
            )
            return 1

        now = datetime.now(TZ5)
        now_ts = int(time.time())
        hour = now.hour
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
        target = max(fleet_n, synced, 1)
        print(
            "Bugun %s | park≈%d | synced=%d | soat=%02d:%02d"
            % (d, fleet_n, synced, hour, now.minute)
        )

        result = None
        # Yangi kun / bo'sh kun — soatdan qat'i nazar BIRINCHI bo'lib to'ldirish
        new_day = fleet_n > 0 and synced == 0
        if new_day:
            print("Rejim: YANGI KUN — birinchi to'liq yuklash")
            result = gps_sync.sync_today(
                office,
                directory,
                d,
                saved_by="github-cron-morning",
                time_budget_sec=None,
                parallel=True,
                force=True,
            )
        elif fleet_n and synced < fleet_n:
            print("Rejim: TO'LDIRISH (yetishmagan mashinalar)")
            result = gps_sync.sync_today(
                office,
                directory,
                d,
                saved_by="github-cron",
                time_budget_sec=None,
                parallel=True,
                force=False,
            )
        elif _should_force_refresh(cars, target, now_ts, hour):
            print("Rejim: YANGILASH (force — km/trek yangilanadi)")
            result = gps_sync.sync_today(
                office,
                directory,
                d,
                saved_by="github-cron",
                time_budget_sec=None,
                parallel=True,
                force=True,
            )
        else:
            print("Rejim: SKIP — bugun to'liq va yangi")
            office.set_gps_status(
                running=False,
                cars=len(cars),
                error="",
                date=d,
                message="Tekshirildi — ma'lumot yangi",
                fetched=synced,
                total=target,
                touch_last_sync=False,
            )
            result = {
                "ok": True,
                "date": d,
                "fetched": synced,
                "total": target,
                "partial": synced < fleet_n if fleet_n else False,
                "skipped": True,
            }

        print("Natija bugun:", result)

        yday = gps_sync.yesterday_tashkent()
        yrec = office.get_report(yday) or {}
        ycars = yrec.get("cars") if isinstance(yrec, dict) else {}
        if not isinstance(ycars, dict):
            ycars = {}
        ysynced = _count_synced(ycars)
        if fleet_n and ysynced < fleet_n:
            print("Sync kecha (to'ldirish):", yday, "%d/%d" % (ysynced, fleet_n))
            y = gps_sync.sync_today(
                office,
                directory,
                yday,
                saved_by="github-cron-yday",
                time_budget_sec=None,
                parallel=True,
                force=False,
            )
            print("Kecha:", y)

        if not result or not result.get("ok"):
            print("ERROR:", (result or {}).get("error") or "sync failed")
            return 1

        fetched = int(result.get("fetched") or 0)
        total = int(result.get("total") or fleet_n or 0)
        print("OK — kunlik odat: %d/%d" % (fetched, total or fetched))
        return 0
    except Exception as e:
        print("EXCEPTION:", e)
        traceback.print_exc()
        return 1


def main():
    if LOOP_MINUTES <= 0:
        return run_once()

    deadline = time.time() + LOOP_MINUTES * 60
    round_n = 0
    last_code = 1
    print(
        "LOOP mode: %d daqiqa, sleep=%ds, refresh≥%ds"
        % (LOOP_MINUTES, LOOP_SLEEP, REFRESH_EVERY_SEC)
    )
    while True:
        round_n += 1
        now = datetime.now(TZ5)
        print("=== LOOP #%d | %s Toshkent ===" % (round_n, now.strftime("%Y-%m-%d %H:%M")))
        # Ertalab yangi kun (05 dan) — loop ishlasin; tunda faqat bitta urinish
        if now.hour < 5 or now.hour > 22:
            print("Ish vaqtidan tashqari — bitta urinish va chiqish")
            return run_once()

        last_code = run_once()
        remain = deadline - time.time()
        if remain < max(30, LOOP_SLEEP // 2):
            print("LOOP tugadi (deadline). rounds=%d last=%d" % (round_n, last_code))
            break
        sleep_for = min(LOOP_SLEEP, max(30, int(remain - 15)))
        print("Keyingi sync uchun kutish: %ds" % sleep_for)
        time.sleep(sleep_for)
    return last_code


if __name__ == "__main__":
    raise SystemExit(main())
