# -*- coding: utf-8 -*-
"""Yonma-yon dorixonalar va geozona langari regressiyasi."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from gps_sync import (  # noqa: E402
    co_visited_pharmacies,
    haversine_m,
    learn_geozone,
    pharmacy_anchors,
    anchor_pharmacies,
)

CAR = "01 269 KMA"
GOR1 = {"id": "z1", "name": "1-гор", "lat": 41.322613, "lng": 69.218281, "radiusM": 100}
BELTEPA = {"id": "z2", "name": "Белтепа", "lat": 41.339775, "lng": 69.165584, "radiusM": 100}
VG_SAMARQAND = {"id": "z3", "name": "ВОЕННЫЙ ГОРОДОК", "lat": 39.683294, "lng": 66.891935, "radiusM": 100}
ZONES = [GOR1, BELTEPA, VG_SAMARQAND]
T18 = (41.33693, 69.18058)


def ph(pid, name, lat=None, lng=None, nearby=None, car=CAR):
    return {"id": pid, "car": car, "name": name, "lat": lat, "lng": lng, "radiusM": 120,
            "aliases": [], "nearby": list(nearby or [])}


class NearbyTests(unittest.TestCase):
    def test_linked_pharmacy_co_visited(self):
        rows = [ph("a", "1-gor", nearby=["b"]), ph("b", "Gor-2")]
        stop = {"place": "1-гор", "lat": 41.32229, "lng": 69.21863}
        self.assertEqual(co_visited_pharmacies(stop, CAR, rows, ZONES), ["1-gor", "Gor-2"])

    def test_link_is_symmetric(self):
        rows = [ph("a", "1-gor"), ph("b", "Gor-2", nearby=["a"])]
        stop = {"place": "1-гор", "lat": 41.32229, "lng": 69.21863}
        self.assertIn("Gor-2", co_visited_pharmacies(stop, CAR, rows, ZONES))

    def test_link_to_other_car_ignored(self):
        rows = [ph("a", "1-gor", nearby=["b"]), ph("b", "Gor-2", car="01 931 PJA")]
        stop = {"place": "1-гор", "lat": 41.32229, "lng": 69.21863}
        self.assertEqual(co_visited_pharmacies(stop, CAR, rows, ZONES), ["1-gor"])

    def test_without_link_not_co_visited(self):
        rows = [ph("a", "1-gor"), ph("b", "Gor-2")]
        stop = {"place": "1-гор", "lat": 41.32229, "lng": 69.21863}
        self.assertEqual(co_visited_pharmacies(stop, CAR, rows, ZONES), ["1-gor"])


class AnchorTests(unittest.TestCase):
    def dist(self, p, z):
        return haversine_m(p["lat"], p["lng"], z["lat"], z["lng"])

    def test_own_zone_anchor(self):
        rows = [ph("b", "Beltepa", 41.3440, 69.1720)]
        anchor_pharmacies(rows, ZONES)
        self.assertLess(self.dist(rows[0], BELTEPA), 1)

    def test_linked_partner_anchor(self):
        rows = [ph("a", "1-gor", nearby=["g"]), ph("g", "Gor-2", *T18)]
        anchor_pharmacies(rows, ZONES)
        self.assertLess(self.dist(rows[1], GOR1), 1)

    def test_same_name_zone_in_other_city_ignored(self):
        rows = [ph("v", "Военный городок", 41.2838, 69.3688)]
        self.assertEqual(pharmacy_anchors(rows, ZONES), {})

    def test_review_cannot_move_anchored(self):
        rows = [ph("a", "1-gor", nearby=["g"]), ph("g", "Gor-2")]
        learn_geozone(rows, CAR, "Gor-2", T18[0], T18[1], pharmacy_anchors(rows, ZONES))
        self.assertLess(self.dist(rows[1], GOR1), 1)

    def test_far_sample_rejected_without_anchor(self):
        rows = [ph("x", "Some pharmacy", 41.30, 69.25)]
        self.assertFalse(learn_geozone(rows, CAR, "Some pharmacy", T18[0], T18[1], {}))
        self.assertEqual((rows[0]["lat"], rows[0]["lng"]), (41.30, 69.25))

    def test_near_sample_learned(self):
        rows = [ph("x", "Some pharmacy", 41.30, 69.25)]
        self.assertTrue(learn_geozone(rows, CAR, "Some pharmacy", 41.3005, 69.2505, {}))


if __name__ == "__main__":
    unittest.main()
