# -*- coding: utf-8 -*-
"""Boshqaruv (fuel) kunlik qator birlashtirish: yangi qiymat saqlansin, bo'sh paket o'chirmasin."""
import os
import shutil
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import vm_server as vs  # noqa: E402

CAR = "01 269 KMA"
BASE = {"gasNorm": 8, "odoStart": 61129.91}


class FuelMergeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.office = vs.OfficeStore(vs.FilePersist(self.tmp), os.path.join(self.tmp, "none.json"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def save(self, days, car=CAR):
        _, err = self.office.save_fuel_month("2026-10", {"cars": {car: dict(BASE, days=days)}})
        self.assertIsNone(err)

    def day1(self):
        return self.office.fuel_month("2026-10")["cars"][CAR]["days"]["1"]

    def test_gps_km_update_saved(self):
        self.save({"1": {"km": 4.13, "odo": 61134.04, "kmSrc": "gps"}})
        self.save({"1": {"km": 77.69, "odo": 61207.6, "kmSrc": "gps"}})
        self.assertEqual(self.day1()["km"], 77.69)
        self.assertEqual(self.day1()["odo"], 61207.6)

    def test_manual_edit_saved(self):
        self.save({"1": {"km": 4.13, "odo": 61134.04, "kmSrc": "gps"}})
        self.save({"1": {"km": 50, "odo": 61179.91, "kmSrc": "user"}})
        self.assertEqual(self.day1()["km"], 50)
        self.assertEqual(self.day1()["kmSrc"], "user")

    def test_empty_row_does_not_wipe(self):
        self.save({"1": {"km": 77.69, "odo": 61207.6, "gasIn": 20, "mode": "aralash", "kmSrc": "gps"}})
        self.save({"1": {"km": 0, "odo": 0}})
        d = self.day1()
        self.assertEqual((d["km"], d["gasIn"], d["mode"]), (77.69, 20, "aralash"))

    def test_partial_row_updates_km_keeps_fill(self):
        self.save({"1": {"km": 4.13, "odo": 61134.04, "gasIn": 20, "kmSrc": "gps"}})
        self.save({"1": {"km": 77.69, "kmSrc": "gps"}})
        d = self.day1()
        self.assertEqual((d["km"], d["gasIn"]), (77.69, 20))


if __name__ == "__main__":
    unittest.main()
