import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import attendance  # noqa: E402
from attendance import AttendanceStore, tabel_candidates, tabel_code_action  # noqa: E402


class MemPersist:
    def __init__(self):
        self.d = {}

    def get(self, k):
        return self.d.get(k)

    def put(self, k, v):
        self.d[k] = v


USERS = [
    {"id": "u1", "name": "Norqulov G'ulom", "role": "driver", "car": "01 844 FKA"},
    {"id": "u2", "name": "Mirzaev Ortiqboy", "role": "driver", "car": "01 111 AAA"},
    {"id": "u3", "name": "Axtamov (test)", "role": "driver", "car": "01 331 MLA", "aliases": ["Ахтамов"]},
    {"id": "u4", "name": "Boymurod", "role": "driver", "car": "01 282 BMA", "aliases": ["Ахтамов Боймурод"]},
    {"id": "u5", "name": "Turobov Avazbek", "role": "driver", "car": "01 205 HMA"},
    {"id": "u6", "name": "Mustafokulov Muxriddin", "role": "driver"},
    {"id": "adm", "name": "Admin Pro", "username": "adminpro", "role": "admin_pro"},
]


class TabelMatchTest(unittest.TestCase):
    def best(self, name):
        c = tabel_candidates(name, AttendanceStore.roster_users(USERS))
        return c[0]["id"] if c and c[0]["score"] >= attendance.TABEL_MATCH_MIN else None

    def test_cyrillic_to_latin_names(self):
        self.assertEqual(self.best("Норқулов Гулом"), "u1")
        self.assertEqual(self.best("Мирзаев Ортиқбой"), "u2")
        self.assertEqual(self.best("Туробов Аваз"), "u5")
        self.assertEqual(self.best("Мустафақулов Мухриддин"), "u6")

    def test_alias_from_car_beats_test_user(self):
        self.assertEqual(self.best("Ахтамов Боймурод"), "u4")

    def test_unknown_and_hidden(self):
        self.assertIsNone(self.best("Жўрақулов Авазбек"))
        self.assertIsNone(self.best("Admin Pro"))


class TabelCodeTest(unittest.TestCase):
    def test_codes(self):
        self.assertEqual(tabel_code_action("8")["kind"], "present")
        self.assertEqual(tabel_code_action(8)["kind"], "present")
        self.assertEqual(tabel_code_action("0")["holat"], "absent")
        self.assertEqual(tabel_code_action("вод")["note"], "Xizmat safari — Vodiy")
        self.assertEqual(tabel_code_action("води")["note"], "Xizmat safari — Vodiy")
        self.assertEqual(tabel_code_action("САМ")["note"], "Xizmat safari — Samarqand")
        self.assertEqual(tabel_code_action("бух")["note"], "Xizmat safari — Buxoro")
        self.assertEqual(tabel_code_action("дам")["kind"], "dam")
        self.assertEqual(tabel_code_action("ув")["kind"], "fired")
        self.assertEqual(tabel_code_action("увол")["kind"], "fired")
        self.assertEqual(tabel_code_action("кеч")["holat"], "late")
        self.assertIsNone(tabel_code_action(""))
        self.assertIsNone(tabel_code_action("zzz"))


class TabelImportTest(unittest.TestCase):
    def setUp(self):
        self.st = AttendanceStore(MemPersist())
        existing = {"u1": {"userId": "u1", "in": {"at": "2026-09-02T08:55:00+05:00"}, "out": None}}
        self.st._save(self.st.day_key("2026-09-02"), existing)
        self.rows = [
            {"name": "Норқулов Гулом", "days": {"2": "8", "10": "вод", "11": "дам", "30": "8"}},
            {"name": "Махмудов Шерзод", "days": {"24": "ув"}},
        ]

    def run_import(self, apply, mapping=None):
        with mock.patch.object(attendance, "today_str", return_value="2026-09-29"):
            res, err = self.st.tabel_import(
                editor={"username": "adminpro"}, month="2026-09", rows=self.rows,
                users=USERS, mapping=mapping, apply=apply,
            )
        self.assertIsNone(err)
        return res

    def test_preview_does_not_write(self):
        res = self.run_import(False)
        r0 = res["rows"][0]
        self.assertEqual(r0["userId"], "u1")
        self.assertEqual((r0["fill"], r0["exists"], r0["future"]), (2, 1, 1))
        self.assertEqual(res["rows"][1]["userId"], "")
        self.assertEqual(self.st.day_records("2026-09-10"), {})

    def test_apply_fills_only_empty_days(self):
        self.run_import(True)
        d2 = self.st.day_records("2026-09-02")["u1"]
        self.assertEqual(d2["in"]["at"], "2026-09-02T08:55:00+05:00")
        self.assertNotIn("source", d2)

        d10 = self.st.day_records("2026-09-10")["u1"]
        self.assertEqual(d10["source"], "tabel")
        self.assertTrue(d10["in"]["at"].startswith("2026-09-10T09:00"))
        self.assertTrue(d10["out"]["at"].startswith("2026-09-10T18:00"))
        self.assertFalse(d10["in"]["late"])
        self.assertIn("Vodiy", d10["manualNote"])
        row = self.st._row_from_punches({"id": "u1"}, "2026-09-10", d10["in"], d10["out"], d10)
        self.assertEqual(row["status"], "done")

        d11 = self.st.day_records("2026-09-11")["u1"]
        self.assertEqual(d11["statusOverride"], "absent")
        self.assertEqual(self.st.day_records("2026-09-30"), {})

    def test_apply_is_idempotent(self):
        self.run_import(True)
        again = self.run_import(True)
        self.assertEqual(again["rows"][0]["fill"], 0)
        self.assertEqual(again["rows"][0]["exists"], 3)

    def test_manual_mapping(self):
        res = self.run_import(True, mapping={"0": "u1", "1": "u2"})
        self.assertEqual(res["rows"][1]["userId"], "u2")
        self.assertEqual(self.st.day_records("2026-09-24")["u2"]["manualNote"], "Tabel: ув — Ishdan bo'shagan")


if __name__ == "__main__":
    unittest.main()
