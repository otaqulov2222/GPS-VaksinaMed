#!/usr/bin/env python3
"""
Dorixonalarni Neon office:pharmacies ga biriktiradi.
- Faqat seed dagi mashinalar yangilanadi
- Boshqa mashinalar dorixonalari saqlanadi
- Nom mos kelsa lat/lng saqlanadi (geozona yo'qolmaydi)
"""
from __future__ import annotations

import json
import os
import re
import secrets
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
os.environ.setdefault("VM_PRODUCTION", "1")

SEED_PATH = os.path.join(ROOT, "scripts", "pharmacies_seed.json")


def norm_name(s: str) -> str:
    s = str(s or "").strip().lower()
    s = s.replace("ё", "е").replace("ў", "у").replace("қ", "к").replace("ғ", "г").replace("ҳ", "х")
    s = re.sub(r"[\s\-_,.]+", "", s)
    return s


def compact_plate(p: str) -> str:
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

    existing = office.pharmacies() or []
    seed_cars = {compact_plate(c) for c in seed.keys()}

    # Seed dagi mashinalardan tashqari — o'zgarmaydi
    kept = [p for p in existing if compact_plate(p.get("car")) not in seed_cars]

    added = 0
    reused = 0
    for car, info in seed.items():
        names = info.get("pharmacies") or []
        # Shu mashina uchun eski yozuvlar (koordinata saqlash uchun)
        old_for_car = [p for p in existing if compact_plate(p.get("car")) == compact_plate(car)]
        by_norm = {norm_name(p.get("name")): p for p in old_for_car if p.get("name")}

        for i, name in enumerate(names):
            name = str(name).strip()
            if not name:
                continue
            nkey = norm_name(name)
            prev = by_norm.get(nkey)
            if prev and (prev.get("lat") is not None or prev.get("lng") is not None):
                rec = {
                    "id": prev.get("id") or ("ph_" + secrets.token_hex(4)),
                    "car": car,
                    "name": name,
                    "lat": prev.get("lat"),
                    "lng": prev.get("lng"),
                    "radiusM": prev.get("radiusM") or 120,
                    "aliases": prev.get("aliases") or [],
                }
                reused += 1
            else:
                rec = {
                    "id": (prev or {}).get("id") or ("ph_" + secrets.token_hex(4)),
                    "car": car,
                    "name": name,
                    "lat": None,
                    "lng": None,
                    "radiusM": 120,
                    "aliases": [],
                }
                added += 1
            kept.append(rec)
            print("OK", car, "→", name, ("[geo]" if rec.get("lat") is not None else "[nom]"))

    office.save_pharmacies(kept)
    print(
        "Tayyor: jami=%d | yangi/yangilangan=%d | geo saqlangan=%d | seed mashina=%d"
        % (len(kept), added, reused, len(seed))
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
