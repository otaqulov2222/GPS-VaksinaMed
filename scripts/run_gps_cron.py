#!/usr/bin/env python3
"""GitHub Actions: GPS sync (Vercel 25s limitisiz)."""
from __future__ import annotations

import os
import sys

# Loyiha ildizi
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
os.environ.setdefault("VM_PRODUCTION", "1")


def main():
    if not (os.environ.get("DATABASE_URL") or "").strip():
        print("DATABASE_URL yo'q — sync o'tkazib yuborildi")
        return 0

    from vm_server import DIRECTORY, OFFICE, init_app
    import gps_sync

    init_app(ROOT)
    d = gps_sync.today_tashkent()
    print("Sync bugun:", d)
    result = gps_sync.sync_today(
        OFFICE, DIRECTORY, d, saved_by="github-cron", time_budget_sec=None, parallel=True
    )
    print("Natija:", result)

    yday = gps_sync.yesterday_tashkent()
    rec = OFFICE.get_report(yday)
    cars = rec.get("cars") if isinstance(rec, dict) else None
    if not cars:
        print("Sync kecha:", yday)
        y = gps_sync.sync_today(
            OFFICE, DIRECTORY, yday, saved_by="github-cron-yday", parallel=True
        )
        print("Kecha:", y)

    if not result or not result.get("ok"):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
