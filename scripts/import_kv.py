#!/usr/bin/env python3
"""
Bir martalik: lokal data/kv/*.json → PostgreSQL (DATABASE_URL).

Ishlatish (loyiha ildizida):
  set DATABASE_URL=postgresql://...
  python scripts/import_kv.py

Mavjud kalitlar o'zgartirilmaydi (skip).
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from vm_server import make_persist  # noqa: E402


def main():
    url = (os.environ.get("DATABASE_URL") or "").strip()
    if not url:
        print("[XATO] DATABASE_URL kerak")
        sys.exit(1)

    persist = make_persist(ROOT)
    if not getattr(persist, "durable", False):
        print("[XATO] PostgreSQL ulanmadi — DATABASE_URL ni tekshiring")
        sys.exit(1)

    kv_dir = os.path.join(ROOT, "data", "kv")
    if not os.path.isdir(kv_dir):
        print("[XATO] data/kv papkasi topilmadi")
        sys.exit(1)

    imported = skipped = 0
    for name in sorted(os.listdir(kv_dir)):
        if not name.endswith(".json"):
            continue
        key = name[:-5].replace("__", ":")
        path = os.path.join(kv_dir, name)
        try:
            with open(path, encoding="utf-8") as f:
                val = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            print(f"[WARN] O'qilmadi {name}: {e}")
            continue
        if persist.get(key) is not None:
            skipped += 1
            continue
        persist.put(key, val)
        imported += 1
        print(f"  + {key}")

    print(f"\n[OK] Import: {imported} ta | Skip (mavjud): {skipped} ta")


if __name__ == "__main__":
    main()
