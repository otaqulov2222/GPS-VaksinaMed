import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cheks


class TestChekFuelExtract(unittest.TestCase):
    def test_gaz_chek_exact(self):
        row = {
            "ofdOk": True,
            "paidAt": "2026-11-26 09:15:00",
            "merchant": "METAN AGZS #4",
            "amount": 96200,
            "items": [{"name": "Siqilgan tabiiy gaz (Metan)", "qty": 18.5, "sum": 96200}],
        }
        res = cheks.extract_fuel_from_chek(row, {"fuelType": "mixed", "gasPrice": 5200})
        self.assertTrue(res["ok"])
        self.assertEqual(res["month"], "2026-11")
        self.assertEqual(res["day"], 26)
        self.assertAlmostEqual(res["gasIn"], 18.5, places=4)
        self.assertEqual(res["gasPrice"], 5200)
        self.assertEqual(res["benzinIn"], 0.0)

    def test_benzin_chek_exact(self):
        row = {
            "ofdOk": True,
            "paidAt": "26.11.2026 14:20:00",
            "merchant": "UNG PETRO",
            "amount": 220000,
            "items": [{"name": "Benzin AI-92", "qty": 20.0, "sum": 220000}],
        }
        res = cheks.extract_fuel_from_chek(row, {"fuelType": "mixed", "benzinPrice": 11000})
        self.assertTrue(res["ok"])
        self.assertEqual(res["month"], "2026-11")
        self.assertEqual(res["day"], 26)
        self.assertAlmostEqual(res["benzinIn"], 20.0, places=4)
        self.assertEqual(res["benzinPrice"], 11000)
        self.assertEqual(res["gasIn"], 0.0)

    def test_pending_chek_ignored(self):
        res = cheks.extract_fuel_from_chek({"ofdOk": False, "amount": 50000})
        self.assertFalse(res["ok"])


if __name__ == "__main__":
    unittest.main()
