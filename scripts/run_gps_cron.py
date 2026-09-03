#!/usr/bin/env python3
"""GitHub Actions: GPS sync (Vercel 25s limitisiz)."""
from __future__ import annotations

import os
import sys
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
os.environ.setdefault("VM_PRODUCTION", "1")


def main():
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

        d = gps_sync.today_tashkent()
        print("Sync bugun:", d)
        result = gps_sync.sync_today(
            office, directory, d, saved_by="github-cron", time_budget_sec=None, parallel=True
        )
        print("Natija:", result)

        yday = gps_sync.yesterday_tashkent()
        rec = office.get_report(yday)
        cars = rec.get("cars") if isinstance(rec, dict) else None
        if not cars:
            print("Sync kecha:", yday)
            y = gps_sync.sync_today(
                office, directory, yday, saved_by="github-cron-yday", parallel=True
            )
            print("Kecha:", y)

        if not result or not result.get("ok"):
            print("ERROR:", (result or {}).get("error") or "sync failed")
            return 1
        print("OK — sync tugadi")
        return 0
    except Exception as e:
        print("EXCEPTION:", e)
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
