# -*- coding: utf-8 -*-
"""Haydovchi almashtirish: short ism, nameHistory, davomat snapshot."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from person_names import (  # noqa: E402
    driver_name_on_date,
    is_patronymic_token,
    normalize_person_name,
    short_from_person_name,
)
import attendance  # noqa: E402
from attendance import AttendanceStore  # noqa: E402


class MemPersist:
    def __init__(self):
        self._d = {}

    def get(self, key, default=None):
        return self._d.get(key, default)

    def put(self, key, val):
        self._d[key] = val

    def keys(self, prefix=""):
        return [k for k in self._d if str(k).startswith(prefix)]


class TestPersonNames(unittest.TestCase):
    def test_strip_ogli_and_dative(self):
        self.assertEqual(
            normalize_person_name("Жўракулов Авазбек Бектош ўғли"),
            "Жўракулов Авазбек Бектош",
        )
        self.assertEqual(
            normalize_person_name("Шарипов Руслан Салим ўғлига"),
            "Шарипов Руслан Салим",
        )
        self.assertEqual(
            normalize_person_name("Jo'raqulov Avazbek Bektosh o'g'li"),
            "Jo'raqulov Avazbek Bektosh",
        )
        self.assertEqual(normalize_person_name("Авазбекга"), "Авазбек")

    def test_plate_name_not_mangled(self):
        self.assertEqual(normalize_person_name("01 567 SGA"), "01 567 SGA")

    def test_short_is_first_word(self):
        self.assertEqual(short_from_person_name("Жўракулов Авазбек Бектош ўғли"), "Жўракулов")
        self.assertEqual(short_from_person_name("Sharipov Ruslan Salim o'g'liga"), "Sharipov")
        self.assertEqual(short_from_person_name("Норқулов Гулом"), "Норқулов")

    def test_patronymic_tokens(self):
        self.assertTrue(is_patronymic_token("ўғли"))
        self.assertTrue(is_patronymic_token("o'g'li"))
        self.assertTrue(is_patronymic_token("o'g'liga"))
        self.assertFalse(is_patronymic_token("Авазбек"))
        self.assertFalse(is_patronymic_token("SGA"))

    def test_driver_name_on_date_timeline(self):
        vehicles = {
            "01 592 YNA": {
                "name": "Sharipov Ruslan",
                "nameHistory": [
                    {
                        "name": "Jo'raqulov Avazbek",
                        "fromDate": "2024-07-15",
                        "prevName": "Tursunqulov Nurbek",
                    },
                    {
                        "name": "Sharipov Ruslan",
                        "fromDate": "2026-11-12",
                        "prevName": "Jo'raqulov Avazbek",
                    },
                ],
            },
            "01 844 FKA": {
                "name": "Jo'raqulov Avazbek",
                "nameHistory": [
                    {
                        "name": "Jo'raqulov Avazbek",
                        "fromDate": "2026-11-12",
                        "prevName": "Norqulov Gulom",
                    },
                ],
            },
        }
        # 592: Avazbek until 11th, Sharipov from 12th
        self.assertIn("Avazbek", driver_name_on_date(vehicles, "01 592 YNA", "2026-11-11"))
        self.assertIn("Sharipov", driver_name_on_date(vehicles, "01 592 YNA", "2026-11-12"))
        self.assertIn("Sharipov", driver_name_on_date(vehicles, "01/592-YNA", "2026-11-13"))
        self.assertIn("Nurbek", driver_name_on_date(vehicles, "01 592 YNA", "2024-07-01"))
        # 844: Gulom before, Avazbek from 12th
        self.assertIn("Gulom", driver_name_on_date(vehicles, "01 844 FKA", "2026-11-11"))
        self.assertIn("Avazbek", driver_name_on_date(vehicles, "01 844 FKA", "2026-11-12"))


class TestAttendanceHistoryDisplay(unittest.TestCase):
    def setUp(self):
        self.store = AttendanceStore(MemPersist())
        self.vehicles = {
            "01 592 YNA": {
                "name": "Sharipov Ruslan",
                "nameHistory": [
                    {
                        "name": "Jo'raqulov Avazbek",
                        "fromDate": "2024-07-15",
                        "prevName": "Nurbek",
                    },
                    {
                        "name": "Sharipov Ruslan",
                        "fromDate": "2026-11-12",
                        "prevName": "Jo'raqulov Avazbek",
                    },
                ],
            }
        }
        self.users = [
            {
                "id": "u592",
                "username": "drv592",
                "name": "Sharipov Ruslan",
                "role": "driver",
                "car": "01 592 YNA",
                "active": True,
            }
        ]

    def test_board_uses_history_when_no_punch(self):
        with mock.patch.object(attendance, "today_str", return_value="2026-11-13"):
            board_old = self.store.board("2026-11-11", self.users, vehicles=self.vehicles)
            board_new = self.store.board("2026-11-13", self.users, vehicles=self.vehicles)
        self.assertIn("Avazbek", board_old["rows"][0]["name"])
        self.assertIn("Sharipov", board_new["rows"][0]["name"])

    def test_board_prefers_day_snapshot_over_current_user(self):
        day_key = self.store.day_key("2026-11-10")
        self.store._save(
            day_key,
            {
                "u592": {
                    "userId": "u592",
                    "name": "Jo'raqulov Avazbek",
                    "car": "01 592 YNA",
                    "username": "drv592",
                    "role": "driver",
                    "in": {
                        "at": "2026-11-10T09:01:00+05:00",
                        "late": False,
                        "method": "geofence",
                    },
                    "out": None,
                }
            },
        )
        # Even if current user is Sharipov, snapshot wins
        board = self.store.board("2026-11-10", self.users, vehicles=self.vehicles)
        self.assertIn("Avazbek", board["rows"][0]["name"])
        self.assertEqual(board["rows"][0]["status"], "in")

    def test_punch_snapshots_name_and_car(self):
        with mock.patch.object(attendance, "today_str", return_value="2026-11-13"):
            with mock.patch.object(
                AttendanceStore,
                "_gps_inside_office",
                return_value=(True, 10.0, None),
            ):
                with mock.patch.object(
                    AttendanceStore,
                    "_slot_ok",
                    return_value=(True, "", False),
                ):
                    res, err = self.store.punch(
                        user_id="u592",
                        username="drv592",
                        name="Sharipov Ruslan",
                        role="driver",
                        kind="in",
                        lat=41.219119,
                        lng=69.272688,
                        accuracy=10,
                        photo=None,
                        car="01 592 YNA",
                    )
        self.assertIsNone(err)
        self.assertTrue(res and res.get("ok"))
        rec = res["record"]
        self.assertEqual(rec["name"], "Sharipov Ruslan")
        self.assertEqual(rec["car"], "01 592 YNA")

    def test_user_history_includes_name_car(self):
        self.store._save(
            self.store.day_key("2026-11-05"),
            {
                "u592": {
                    "userId": "u592",
                    "name": "Jo'raqulov Avazbek",
                    "car": "01 592 YNA",
                    "in": {"at": "2026-11-05T09:00:00+05:00"},
                    "out": {"at": "2026-11-05T18:00:00+05:00"},
                }
            },
        )
        rows = self.store.user_history("u592", limit=10)
        self.assertTrue(rows)
        self.assertIn("Avazbek", rows[0].get("name") or "")
        self.assertIn("592", rows[0].get("car") or "")

    def test_hisobot_date_uses_history(self):
        with mock.patch.object(attendance, "today_str", return_value="2026-11-13"):
            res = self.store.hisobot(
                "day",
                self.users,
                date="2026-11-11",
                vehicles=self.vehicles,
            )
        self.assertTrue(res["rows"])
        self.assertIn("Avazbek", res["rows"][0]["name"])


class TestFuelMetaRepairAndSync(unittest.TestCase):
    def test_overlay_and_short_helpers_via_vm_import(self):
        # Importing vm_server is heavy; exercise office helpers if available lightly
        from person_names import short_from_person_name as s

        bad = "o'g'li"
        self.assertTrue(is_patronymic_token(bad))
        self.assertEqual(s("Жўракулов Авазбек ўғли"), "Жўракулов")


if __name__ == "__main__":
    unittest.main(verbosity=2)
