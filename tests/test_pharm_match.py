# -*- coding: utf-8 -*-
"""Dorixona moslashishi — soxta 'boshqa yo'nalish' regressiyasi."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from gps_sync import (  # noqa: E402
    _pharm_name_score,
    build_pharm_index,
    match_geo,
    match_pharmacy,
    pharmacy_key,
)


CAR_A = "01 269 AAA"
CAR_B = "01 100 BBB"


def _pharms():
    return [
        {
            "name": "Qora-suv Sadaf",
            "car": CAR_A,
            "lat": 41.3200,
            "lng": 69.2500,
            "radiusM": 120,
        },
        {
            "name": "Qorakamish",
            "car": CAR_B,
            "lat": 41.3210,
            "lng": 69.2510,
            "radiusM": 120,
        },
        {
            "name": "Chinobod",
            "car": CAR_B,
            "lat": 41.3500,
            "lng": 69.2800,
            "radiusM": 150,
        },
        {
            "name": "Nazarbek",
            "car": CAR_A,
            "lat": 41.2800,
            "lng": 69.2000,
            "radiusM": 120,
        },
    ]


class PharmNameScoreTests(unittest.TestCase):
    def test_sadaf_geozone_digits(self):
        a = pharmacy_key("QORA-SUV-2 SADAF")
        b = pharmacy_key("Qora-suv Sadaf")
        self.assertGreaterEqual(_pharm_name_score(a, b), 55)

    def test_qorasuv_not_qorakamish(self):
        a = pharmacy_key("Qorasuv")
        b = pharmacy_key("Qorakamish")
        self.assertLess(_pharm_name_score(a, b), 55)

    def test_short_prefix_rejected(self):
        # eski bug: pn[:4] 'qora' → hammasi
        a = pharmacy_key("Qora")
        b = pharmacy_key("Qorakamish")
        self.assertEqual(_pharm_name_score(a, b), 0.0)

    def test_digit_variants_need_long_stem(self):
        # qorasuv2 ≠ qorasuv5 (stem < 10 after digit strip? qorasuv = 7)
        a = pharmacy_key("Qorasuv-2")
        b = pharmacy_key("Qorasuv-5")
        self.assertLess(_pharm_name_score(a, b), 55)


class MatchPharmacyTests(unittest.TestCase):
    def setUp(self):
        self.pharmacies = _pharms()
        self.index = build_pharm_index([], self.pharmacies)

    def test_sadaf_place_is_own_not_other(self):
        m = match_pharmacy(
            "QORA-SUV-2 SADAF",
            CAR_A,
            41.32005,
            69.25005,
            self.index,
            self.pharmacies,
        )
        self.assertEqual(m["type"], "own")
        self.assertIn("Sadaf", m["phName"] or "")

    def test_street_near_other_pharm_not_forced_other(self):
        # Ko'cha nomi Chinobod geofence ichida — geo-other rad etiladi
        m = match_pharmacy(
            "Amir Temur shoh ko'chasi",
            CAR_A,
            41.35005,
            69.28005,
            self.index,
            self.pharmacies,
        )
        self.assertNotEqual(m["type"], "other")

    def test_blank_place_geo_other_allowed(self):
        m = match_pharmacy(
            "",
            CAR_A,
            41.35005,
            69.28005,
            self.index,
            self.pharmacies,
        )
        self.assertEqual(m["type"], "other")
        self.assertEqual(m["phName"], "Chinobod")

    def test_own_roster_overrides_wrong_other_name(self):
        # Joy nomi o'z dorixonasi — hatto boshqa mashina yaqin bo'lsa ham own
        m = match_pharmacy(
            "Nazarbek",
            CAR_A,
            41.35005,  # Chinobod yonida
            69.28005,
            self.index,
            self.pharmacies,
        )
        self.assertEqual(m["type"], "own")
        self.assertEqual(m["phName"], "Nazarbek")

    def test_geo_prefers_name_agreement(self):
        # Qorakamish va Sadaf yaqin; joy Sadaf → Sadaf
        m = match_geo(
            CAR_A,
            41.3205,
            69.2505,
            self.pharmacies,
            place="QORA-SUV-2 SADAF",
        )
        self.assertIsNotNone(m)
        self.assertEqual(m["type"], "own")
        self.assertIn("Sadaf", m["phName"] or "")

    def test_qorakamish_name_not_own_for_car_a(self):
        m = match_pharmacy(
            "Qorakamish",
            CAR_A,
            0,
            0,
            self.index,
            self.pharmacies,
        )
        self.assertEqual(m["type"], "other")
        self.assertEqual(m["phName"], "Qorakamish")


if __name__ == "__main__":
    unittest.main()
