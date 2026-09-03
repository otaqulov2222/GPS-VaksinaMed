#!/usr/bin/env python3
"""
Avgust Excel normalarini Neon ga yozadi:
  1) fuel:meta.vehicles — gasNorm, benzinNorm, fuelType
  2) barcha fuel:month:* ichidagi cars — shu 3 maydon

Kunlik yozuvlar / docs / dorixona / GPS ga tegilmaydi.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
os.environ.setdefault("VM_PRODUCTION", "1")

SEED_PATH = os.path.join(ROOT, "scripts", "norms_seed.json")


def compact(p: str) -> str:
    return re.sub(r"[\s/\-_]+", "", str(p or "")).upper()


def code3(p: str) -> str:
    m = re.search(r"(\d{3})", str(p or ""))
    return m.group(1) if m else ""


def find_key(vehicles: dict, plate: str) -> str | None:
    want = compact(plate)
    for k in vehicles.keys():
        if compact(k) == want:
            return k
    c = code3(plate)
    if not c:
        return None
    hits = [k for k in vehicles.keys() if code3(k) == c]
    return hits[0] if len(hits) == 1 else None


def apply_norm(cur: dict, rec: dict) -> dict:
    out = dict(cur) if isinstance(cur, dict) else {}
    ft = str(rec.get("fuelType") or out.get("fuelType") or "mixed")
    if ft not in ("mixed", "gaz", "benzin", "dizel", "dizel_gaz"):
        ft = "mixed"
    out["fuelType"] = ft
    out["gasNorm"] = float(rec.get("gasNorm") if rec.get("gasNorm") is not None else out.get("gasNorm") or 12)
    out["benzinNorm"] = float(
        rec.get("benzinNorm") if rec.get("benzinNorm") is not None else out.get("benzinNorm") or 4
    )
    return out


def main():
    if not (os.environ.get("DATABASE_URL") or "").strip():
        print("ERROR: DATABASE_URL yo'q")
        return 1

    with open(SEED_PATH, "r", encoding="utf-8") as f:
        seed = json.load(f)

    import vm_server

    print("init_app...")
    vm_server.init_app(ROOT)
    office = vm_server.OFFICE
    if office is None:
        print("ERROR: OFFICE None")
        return 1

    meta = office.fuel_meta()
    vehicles = meta.get("vehicles") if isinstance(meta.get("vehicles"), dict) else {}
    vehicles = dict(vehicles)

    updated = 0
    created = 0
    by_compact = {}
    by_code = {}

    for plate, rec in seed.items():
        if not isinstance(rec, dict):
            continue
        key = find_key(vehicles, plate)
        if key is None:
            key = plate
            vehicles[key] = {
                "name": "",
                "short": "",
                "brand": "",
                "card": "",
                "fuelType": "mixed",
                "gasNorm": 12,
                "benzinNorm": 4,
                "gasPrice": 5200,
                "benzinPrice": 11000,
                "hidden": False,
            }
            created += 1

        vehicles[key] = apply_norm(vehicles[key], rec)
        updated += 1
        by_compact[compact(key)] = rec
        c = code3(key)
        if c:
            by_code[c] = rec
        print(
            "META",
            key,
            "gas=%s" % vehicles[key]["gasNorm"],
            "ben=%s" % vehicles[key]["benzinNorm"],
            "type=%s" % vehicles[key]["fuelType"],
        )

    office.save_fuel_meta({"vehicles": vehicles})
    print("Meta saqlandi: updated=%d created=%d jami=%d" % (updated, created, len(vehicles)))

    # Barcha oylarga ham yozish — UI oy yozuvidan o'qiydi
    month_keys = []
    try:
        month_keys = office.persist.keys("fuel:month:")
    except Exception as e:
        print("WARN month keys:", e)

    # Joriy oy yo'q bo'lsa ham yaratmaslik — faqat mavjudlarni yangilash
    # Lekin 2026-08 / 2026-09 ni aniq tekshirib ko'ramiz
    now = datetime.now(timezone.utc)
    for ym in (
        "%04d-%02d" % (now.year, now.month),
        "%04d-%02d" % (now.year if now.month > 1 else now.year - 1, now.month - 1 if now.month > 1 else 12),
    ):
        k = "fuel:month:" + ym
        if k not in month_keys:
            month_keys.append(k)

    months_patched = 0
    cars_patched = 0
    for mk in sorted(set(month_keys)):
        if not mk.startswith("fuel:month:"):
            continue
        month = mk.split(":", 2)[-1]
        data = office._load(mk, None)
        if not isinstance(data, dict):
            continue
        cars = data.get("cars") if isinstance(data.get("cars"), dict) else {}
        if not cars:
            continue
        changed = False
        for plate, crec in list(cars.items()):
            if not isinstance(crec, dict):
                continue
            rec = by_compact.get(compact(plate))
            if rec is None:
                c = code3(plate)
                rec = by_code.get(c) if c else None
            if rec is None:
                continue
            cars[plate] = apply_norm(crec, rec)
            changed = True
            cars_patched += 1
        if changed:
            data["cars"] = cars
            data["savedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            data["month"] = month
            office._save(mk, data)
            months_patched += 1
            print("MONTH", month, "cars_updated")

    print(
        "Tayyor: months_patched=%d cars_patched=%d" % (months_patched, cars_patched)
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
