#!/usr/bin/env python3
"""
Avgust Excel normalarini Neon fuel:meta.vehicles ga yozadi.
Faqat: gasNorm, benzinNorm, fuelType.
docs / stations / pharmacies / GPS ga tegilmaydi.
"""
from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
os.environ.setdefault("VM_PRODUCTION", "1")

SEED_PATH = os.path.join(ROOT, "scripts", "norms_seed.json")


def compact(p: str) -> str:
    return re.sub(r"[\s/\-_]+", "", str(p or "")).upper()


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
    for plate, rec in seed.items():
        if not isinstance(rec, dict):
            continue
        # mavjud kalitni topish (bo'shliq farqi)
        key = None
        want = compact(plate)
        for k in vehicles.keys():
            if compact(k) == want:
                key = k
                break
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

        cur = vehicles[key] if isinstance(vehicles.get(key), dict) else {}
        ft = str(rec.get("fuelType") or cur.get("fuelType") or "mixed")
        if ft not in ("mixed", "gaz", "benzin", "dizel", "dizel_gaz"):
            ft = "mixed"
        cur["fuelType"] = ft
        cur["gasNorm"] = float(rec.get("gasNorm") or cur.get("gasNorm") or 12)
        cur["benzinNorm"] = float(rec.get("benzinNorm") or cur.get("benzinNorm") or 4)
        vehicles[key] = cur
        updated += 1
        print(
            "OK",
            key,
            "gas=%s" % cur["gasNorm"],
            "ben=%s" % cur["benzinNorm"],
            "type=%s" % cur["fuelType"],
        )

    # Faqat vehicles — docs/stations/firm saqlanadi
    office.save_fuel_meta({"vehicles": vehicles})
    print("Saqlandi: updated=%d created=%d jami_vehicles=%d" % (updated, created, len(vehicles)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
