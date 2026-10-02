import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import departure  # noqa: E402
from departure import DepartureService, clean_rule, evaluate, office_blocks, plate_number, summarize  # noqa: E402

RULE = clean_rule({})
TZ = timezone(timedelta(hours=5))
MON = "2026-09-28"
SUN = "2026-09-27"


def stop(a, b, office, place="X"):
    return {"inTime": a, "outTime": b, "isOffice": office, "place": place}


def rec(stops, km=40.0):
    return {"stops": stops, "stats": {"probeg": km}}


class MemPersist:
    def __init__(self):
        self.d = {}

    def get(self, k):
        return self.d.get(k)

    def put(self, k, v):
        self.d[k] = v


class RuleTest(unittest.TestCase):
    def test_plate_number(self):
        self.assertEqual(plate_number("01 302 DNA"), "302")
        self.assertEqual(plate_number("01043KMA"), "043")
        self.assertEqual(plate_number("949"), "949")

    def test_clean_rule(self):
        r = clean_rule({"deadline": "9:30", "plates": "01 255 HMA, 043; 043 949"})
        self.assertEqual(r["deadline"], "09:30")
        self.assertEqual(r["plates"], ["255", "043", "949"])
        self.assertEqual(clean_rule({"deadline": "10:15"})["deadline"], "10:15")
        self.assertTrue(departure.is_tracked("01 382 NMA", RULE))
        self.assertTrue(departure.is_tracked("01 931 PJA", RULE))
        self.assertFalse(departure.is_tracked("01 331 MLA", RULE))


class BlocksTest(unittest.TestCase):
    def test_office_and_warehouse_merge(self):
        stops = [
            stop("00:00:10", "08:18:00", True, "ЯНГИ-СКЛАД"),
            stop("08:27:00", "09:12:00", True, "ОФИС"),
            stop("09:40:00", "10:00:00", False),
        ]
        b = office_blocks(stops)
        self.assertEqual(len(b), 1)
        self.assertEqual(b[0]["end"], 9 * 3600 + 12 * 60)

    def test_real_trip_splits_blocks(self):
        stops = [
            stop("07:00:00", "08:00:00", True),
            stop("08:05:00", "08:30:00", False, "Dorixona"),
            stop("08:40:00", "09:00:00", True),
        ]
        self.assertEqual(len(office_blocks(stops)), 2)


class EvaluateTest(unittest.TestCase):
    def test_ok_and_minute_resolution(self):
        r = evaluate(rec([stop("08:10:00", "09:30:40", True), stop("09:50:00", "10:10:00", False)]), MON, RULE)
        self.assertEqual(r["status"], "ok")
        self.assertEqual(r["departAt"], "09:30")

    def test_late(self):
        r = evaluate(rec([stop("08:10:00", "09:47:10", True), stop("10:00:00", "10:10:00", False)]), MON, RULE)
        self.assertEqual((r["status"], r["departAt"], r["lateMin"]), ("late", "09:47", 17))
        self.assertEqual(r["arriveAt"], "08:10")

    def test_overnight_has_no_arrival(self):
        r = evaluate(rec([stop("00:00:30", "09:05:00", True), stop("09:20:00", "09:40:00", False)]), MON, RULE)
        self.assertEqual(r["status"], "ok")
        self.assertTrue(r.get("overnight"))
        self.assertIsNone(r["arriveAt"])

    def test_whole_day_in_territory_is_no_trip(self):
        r = evaluate(rec([stop("08:27:00", "18:20:00", True), stop("18:40:00", "19:00:00", False)], km=4.0), MON, RULE)
        self.assertEqual(r["status"], "no_trip")
        self.assertEqual(r["lateMin"], 0)

    def test_parked_all_day_is_idle(self):
        r = evaluate(rec([stop("00:00:33", "16:58:33", True)], km=0.0), MON, RULE)
        self.assertEqual(r["status"], "idle")

    def test_sunday_off(self):
        r = evaluate(rec([stop("08:00:00", "12:00:00", True)]), SUN, RULE)
        self.assertEqual(r["status"], "off")

    def test_never_entered_office(self):
        r = evaluate(rec([stop("08:00:00", "09:00:00", False)], km=60), MON, RULE)
        self.assertEqual(r["status"], "no_office")

    def test_today_states(self):
        stops = [stop("07:50:00", "09:10:00", True)]
        before = datetime(2026, 9, 28, 9, 10)
        self.assertEqual(evaluate(rec(stops, km=1), MON, RULE, before)["status"], "pending")
        after = datetime(2026, 9, 28, 9, 55)
        r = evaluate(rec([stop("07:50:00", "09:55:00", True)], km=1), MON, RULE, after)
        self.assertEqual((r["status"], r["lateMin"]), ("waiting", 25))
        r = evaluate(rec([], km=0), MON, RULE, after)
        self.assertEqual(r["status"], "not_arrived")
        early = datetime(2026, 9, 28, 8, 0)
        self.assertEqual(evaluate(rec([], km=0), MON, RULE, early)["status"], "pending")

    def test_summary_skips_excused(self):
        days = [
            {"date": "a", "status": "late", "lateMin": 10},
            {"date": "b", "status": "late", "lateMin": 5, "excused": True},
            {"date": "c", "status": "no_trip", "lateMin": 0},
            {"date": "d", "status": "ok"},
        ]
        s = summarize(days)
        self.assertEqual((s["late"], s["lateMin"], s["noTrip"], s["excused"], s["ok"]), (2, 10, 1, 1, 1))
        self.assertEqual(s["lateDates"], ["a", "c"])


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.reports = {
            MON: {"cars": {
                "01 302 DNA": rec([stop("08:10:00", "09:47:00", True), stop("10:00:00", "10:10:00", False)]),
                "01 255 HMA": rec([stop("08:10:00", "09:05:00", True), stop("09:20:00", "09:40:00", False)]),
                "01 331 MLA": rec([stop("08:10:00", "11:00:00", True), stop("11:20:00", "11:40:00", False)]),
            }},
        }
        self.absent = set()
        mem = MemPersist()
        mem.put(departure.RULE_KEY, {"since": "2026-09-01"})
        self.svc = DepartureService(
            mem, self.reports.get, TZ,
            excuse_fn=lambda d, p: "kelmagan" if (d, departure.plate_number(p)) in self.absent else None,
        )

    def test_day_tracks_only_rule_plates(self):
        cars = self.svc.day(MON)["cars"]
        self.assertEqual(set(cars), {"01302DNA", "01255HMA"})
        self.assertTrue(cars["01302DNA"]["counted"])
        self.assertEqual(cars["01302DNA"]["label"], "Yuk chiqishi kechikdi")

    def test_note_and_excuse(self):
        self.svc.set_note(MON, "01 302 DNA", "Sklad navbati", True, by="Admin")
        d = self.svc.day(MON)["cars"]["01302DNA"]
        self.assertTrue(d["excused"])
        self.assertFalse(d["counted"])
        self.assertEqual(d["note"], "Sklad navbati")
        self.svc.set_note(MON, "01 302 DNA", "", False)
        self.assertTrue(self.svc.day(MON)["cars"]["01302DNA"]["counted"])

    def test_whole_day_excuse(self):
        self.svc.set_note(MON, "*", "Bayram", True)
        d = self.svc.day(MON)["cars"]["01302DNA"]
        self.assertTrue(d["excused"] and d["noteAll"])

    def test_attendance_auto_excuse(self):
        self.absent.add((MON, "302"))
        d = self.svc.day(MON)["cars"]["01302DNA"]
        self.assertEqual(d["autoExcuse"], "kelmagan")
        self.assertFalse(d["counted"])

    def test_month_summary_for_one_car(self):
        m = self.svc.month("2026-09", "01 302 DNA")
        self.assertEqual(list(m["plates"]), ["01302DNA"])
        p = m["plates"]["01302DNA"]
        self.assertEqual(p["summary"]["late"], 1)
        self.assertEqual(p["summary"]["lateDates"], [MON])
        self.assertEqual(len(p["days"]), 30)

    def test_days_before_since_are_ignored(self):
        self.svc.save_rule({"since": "2026-10-01"})
        self.assertEqual(self.svc.day(MON)["cars"], {})
        self.assertEqual(self.svc.month("2026-09", "01 302 DNA")["plates"], {})
        self.assertEqual(clean_rule({})["since"], "2026-10-01")

    def test_rule_change_invalidates(self):
        self.svc.save_rule({"deadline": "10:00", "plates": ["302"], "since": "2026-09-01"}, by="Admin")
        cars = self.svc.day(MON)["cars"]
        self.assertEqual(set(cars), {"01302DNA"})
        self.assertEqual(cars["01302DNA"]["status"], "ok")


if __name__ == "__main__":
    unittest.main()
