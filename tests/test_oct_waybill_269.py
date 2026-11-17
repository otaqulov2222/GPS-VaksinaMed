# -*- coding: utf-8 -*-
"""Oktabr 2026 Excel — fuel.js waybill parser ЖАМИ (hard) bilan mos."""
from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / "scripts" / "_oct2026.xlsx"
FUEL_JS_TEST = ROOT / "tests" / "fuel_js_waybill_oct.js"
OUT_JSON = ROOT / "tests" / "fuel_js_waybill_oct_out.json"


@unittest.skipUnless(XLSX.is_file(), "scripts/_oct2026.xlsx yo'q")
class OctWaybillFullTest(unittest.TestCase):
    def test_fuel_js_all_sheets_match_jami_hard(self):
        r = subprocess.run(
            ["node", str(FUEL_JS_TEST)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertEqual(r.returncode, 0, r.stderr or r.stdout)
        data = json.loads(OUT_JSON.read_text(encoding="utf-8"))
        self.assertEqual(data.get("bad"), 0, data.get("report"))
        self.assertGreaterEqual(data.get("ok", 0), 20)

    def test_269_jami_exact(self):
        r = subprocess.run(
            ["node", str(FUEL_JS_TEST)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertEqual(r.returncode, 0, r.stderr or r.stdout)
        data = json.loads(OUT_JSON.read_text(encoding="utf-8"))
        row = next((x for x in data.get("report") or [] if str(x.get("sheet")) == "269"), None)
        self.assertIsNotNone(row, "269 varag'i topilmadi")
        self.assertEqual(row.get("status"), "OK", row)
        self.assertAlmostEqual(float(row.get("sumGas") or 0), 240.529, places=3)
        self.assertAlmostEqual(float(row.get("sumKm") or 0), 3168.52, places=2)


if __name__ == "__main__":
    unittest.main()
