#!/usr/bin/env python3
"""Hujjat muddatlarini Neon fuel:meta.docs ga yozadi (faqat docs, boshqa maydonlarga tegmaydi)."""
from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
os.environ.setdefault("VM_PRODUCTION", "1")

DOC_KEYS = ("insurance", "tech", "ads", "cylinder")
SEED_PATH = os.path.join(ROOT, "scripts", "docs_seed.json")

FLEET_FIXED = [
    "01 269 KMA",
    "01 949 AKA",
    "01 302 DNA",
    "01 255 HMA",
    "01 205 HMA",
    "01 043 KMA",
    "01 931 PJA",
    "01 083 XJA",
    "01 382 NMA",
    "01 282 BMA",
    "01 870 SEA",
    "01 668 UKA",
    "01 887 UKA",
    "01 449 UKA",
    "01 646 UKA",
    "01 844 FKA",
    "01 699 UKA",
    "01 592 YNA",
    "01 849 SNA",
    "01 309 YNA",
    "01 331 MLA",
    "01 406 GNA",
    "01 567 SGA",
]


def compact(p: str) -> str:
    return re.sub(r"[\s/\-_]+", "", str(p or "")).upper()


def code3(p: str) -> str:
    m = re.search(r"(\d{3})", str(p or ""))
    return m.group(1) if m else ""


def resolve_plate(raw: str, fleet_plates: list) -> str | None:
    want = compact(raw)
    for p in fleet_plates:
        if compact(p) == want:
            return p
    c = code3(raw)
    if not c:
        return None
    hits = [p for p in fleet_plates if code3(p) == c]
    if len(hits) == 1:
        return hits[0]
    return None


def norm_doc(rec: dict) -> dict:
    out = {}
    for k in DOC_KEYS:
        d = rec.get(k) if isinstance(rec.get(k), dict) else {}
        due = str(d.get("due") or "").strip()[:10]
        if due and not re.match(r"^\d{4}-\d{2}-\d{2}$", due):
            due = ""
        try:
            months = int(d.get("months") or 12)
        except (TypeError, ValueError):
            months = 12
        months = max(1, min(60, months))
        out[k] = {"due": due, "months": months}
    return out


def main():
    if not (os.environ.get("DATABASE_URL") or "").strip():
        print("ERROR: DATABASE_URL yo'q")
        return 1

    with open(SEED_PATH, "r", encoding="utf-8") as f:
        seed = json.load(f)
    seed_docs = seed.get("docs") or {}
    if not isinstance(seed_docs, dict) or not seed_docs:
        print("ERROR: docs_seed.json bo'sh")
        return 1

    import vm_server

    print("init_app...")
    vm_server.init_app(ROOT)
    office = vm_server.OFFICE
    if office is None:
        print("ERROR: OFFICE None")
        return 1

    meta = office.fuel_meta()
    fleet_plates = list(FLEET_FIXED)
    for p in (meta.get("vehicles") or {}).keys():
        ps = str(p)
        if ps not in fleet_plates:
            fleet_plates.append(ps)

    cur_docs = meta.get("docs") if isinstance(meta.get("docs"), dict) else {}
    merged = dict(cur_docs)
    ok = 0
    skipped = []

    for raw_plate, rec in seed_docs.items():
        if str(raw_plate).startswith("_"):
            continue
        if not isinstance(rec, dict):
            skipped.append(raw_plate)
            continue
        plate = resolve_plate(raw_plate, fleet_plates)
        if not plate:
            skipped.append(raw_plate)
            continue
        merged[plate] = norm_doc(rec)
        ok += 1
        print("OK", plate)

    if skipped:
        print("SKIP:", skipped)

    # Faqat docs — vehicles/stations/firm o'zgarmaydi
    office.save_fuel_meta({"docs": merged})
    print("Saqlandi: %d ta mashina (jami docs=%d)" % (ok, len(merged)))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
