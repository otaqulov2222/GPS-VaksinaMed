"""Qo‘lda chek — regressiya: soft-pending, noto‘g‘ri FM, sana formati, tez yo‘l."""
import unittest
from unittest import mock

import cheks


def _ok_ofd(amount=84100, merchant='"UNG PETRO" MCHJ'):
    return {
        "ofdOk": True,
        "ofdPending": False,
        "ofdNote": "",
        "merchant": merchant,
        "inn": "123",
        "amount": amount,
        "items": [{"name": "Metan", "qty": 1, "price": amount, "sum": amount}],
        "address": "Toshkent",
        "cashTotal": 0,
        "cardTotal": amount,
        "payMethod": "Bank kartasi",
        "kkmName": "PAX",
        "cardType": "UZCARD",
        "vatTotal": 1000,
    }


def _pending_ofd():
    return {
        "ofdOk": False,
        "ofdPending": True,
        "ofdNote": "Soliq OFD da chek hali shakllanmoqda",
        "merchant": "",
        "inn": "",
        "amount": None,
        "items": [],
        "address": "",
        "cashTotal": None,
        "cardTotal": None,
        "payMethod": "",
        "kkmName": "",
        "cardType": "",
        "vatTotal": None,
    }


class ManualHardeningTest(unittest.TestCase):
    def test_dash_date_not_garbage_stamp(self):
        self.assertEqual(
            cheks.normalize_human_datetime("11-11-2026 20:04:41"),
            "20261111200441",
        )
        stamps = cheks.expand_stamp_candidates("11-11-2026 20:04:41", max_n=8)
        self.assertTrue(stamps)
        self.assertTrue(all(s.startswith("20261111") for s in stamps[:3]))
        self.assertNotIn("11112026200441", stamps)

    def test_slash_and_dot_dates(self):
        self.assertEqual(cheks.normalize_human_datetime("11/11/2026 20:04"), "20261111200400")
        self.assertEqual(cheks.normalize_human_datetime("11.11.2026 20:04:41"), "20261111200441")

    def test_short_terminal_rejected(self):
        r = cheks.lookup_manual_chek(
            {"receiptNo": "75947", "fiscalSign": "223241506405", "terminalId": "1170389188"},
            known_terminals=[],
        )
        self.assertFalse(r["ok"])
        self.assertTrue(r.get("needFm"))
        self.assertNotIn("pending", r)

    def test_no_terminals_needs_fm(self):
        r = cheks.lookup_manual_chek(
            {"receiptNo": "75947", "fiscalSign": "223241506405"},
            known_terminals=[],
        )
        self.assertFalse(r["ok"])
        self.assertTrue(r.get("needFm"))

    @mock.patch("cheks.fetch_ofd_api")
    def test_wrong_remembered_vg_then_correct_lg(self, fetch):
        """VG soxta pending beradi — LG topilishi kerak, soft-pending yo‘q."""

        def side_effect(parsed, timeout=5, attempts=1):
            term = str((parsed or {}).get("terminalId") or "")
            if term.startswith("VG"):
                return _pending_ofd()
            if term.startswith("LG"):
                return _ok_ofd()
            return _pending_ofd()

        fetch.side_effect = side_effect
        r = cheks.lookup_manual_chek(
            {
                "receiptNo": "75947",
                "fiscalSign": "223241506405",
                "terminalId": "VG544170024111",
                "paidAt": "11-11-2026 20:04:41",
            },
            known_terminals=["VG544170024111", "LG420211628460"],
            timeout=2,
            max_tries=12,
        )
        self.assertTrue(r["ok"])
        self.assertNotIn("pending", r)
        rec = r["rec"]
        self.assertTrue(rec["ofdOk"])
        self.assertFalse(rec.get("ofdPending"))
        self.assertEqual(rec["terminalId"], "LG420211628460")
        self.assertEqual(rec["amount"], 84100)
        self.assertIn("UNG PETRO", rec["merchant"])

    @mock.patch("cheks.fetch_ofd_api")
    def test_never_returns_soft_pending_shell(self, fetch):
        fetch.return_value = _pending_ofd()
        r = cheks.lookup_manual_chek(
            {
                "receiptNo": "75947",
                "fiscalSign": "223241506405",
                "terminalId": "VG544170024111",
            },
            known_terminals=["VG544170024111"],
            timeout=1,
            max_tries=4,
        )
        self.assertFalse(r["ok"])
        self.assertTrue(r.get("needFm"))
        self.assertIsNone(r.get("pending"))
        self.assertNotIn("rec", r)
        # Noto‘g‘ri FM — bitta urinishdan keyin o‘lik, qayta stamp bilan cho‘zilmaydi
        self.assertEqual(r["tries"], 1)
        self.assertIn("VG544170024111", r.get("error") or "")

    @mock.patch("cheks.fetch_ofd_api")
    def test_exact_fm_and_dash_date_fast(self, fetch):
        fetch.return_value = _ok_ofd()
        r = cheks.lookup_manual_chek(
            {
                "receiptNo": "75947",
                "fiscalSign": "223241506405",
                "terminalId": "LG420211628460",
                "paidAt": "11-11-2026 20:04:41",
            },
            known_terminals=[],
            timeout=2,
            max_tries=8,
        )
        self.assertTrue(r["ok"])
        self.assertEqual(r["tries"], 1)
        self.assertEqual(r["rec"]["amount"], 84100)
        # Stamp to‘g‘ri YYYYMMDD…
        args = fetch.call_args[0][0]
        self.assertTrue(str(args.get("stamp") or "").startswith("20261111"))

    @mock.patch("cheks.fetch_ofd_api")
    def test_chek_fb_only_with_known_pool(self, fetch):
        def side_effect(parsed, timeout=5, attempts=1):
            if (parsed or {}).get("terminalId") == "LG420211628460":
                return _ok_ofd()
            return _pending_ofd()

        fetch.side_effect = side_effect
        r = cheks.lookup_manual_chek(
            {"receiptNo": "75947", "fiscalSign": "223241506405"},
            known_terminals=["VG544170024111", "LG420211628460"],
            timeout=2,
            max_tries=16,
        )
        self.assertTrue(r["ok"])
        self.assertEqual(r["rec"]["terminalId"], "LG420211628460")
        self.assertTrue(r["rec"]["ofdOk"])

    def test_hit_rec_always_ofd_ok(self):
        parsed = cheks.build_ofd_url(
            "LG420211628460", "75947", "11.11.2026 20:04:41", "223241506405"
        )
        rec = cheks._manual_hit_rec(parsed, _ok_ofd(), "223241506405")
        self.assertTrue(rec["ofdOk"])
        self.assertFalse(rec["ofdPending"])
        self.assertEqual(rec["qrSource"], "manual")
        self.assertTrue(rec["qr"])

    def test_ofd_link_fields_unique_per_receipt(self):
        a = cheks.build_ofd_url("LG1", "111", "11.11.2026 10:00:00", "111")
        b = cheks.build_ofd_url("LG1", "222", "11.11.2026 10:00:00", "222")
        self.assertNotEqual(a["qr"], b["qr"])
        self.assertIn("r=111", a["qr"])
        self.assertIn("r=222", b["qr"])


@unittest.skipUnless(
    __import__("os").environ.get("CHEKS_LIVE_OFD") == "1",
    "set CHEKS_LIVE_OFD=1 to hit real Soliq OFD",
)
class ManualLiveOfdTest(unittest.TestCase):
    def test_live_ung_petro(self):
        r = cheks.lookup_manual_chek(
            {
                "receiptNo": "75947",
                "fiscalSign": "223241506405",
                "terminalId": "LG420211628460",
                "paidAt": "11-11-2026 20:04:41",
            },
            known_terminals=["VG544170024111"],
            timeout=8,
            max_tries=8,
        )
        self.assertTrue(r["ok"])
        self.assertEqual(r["rec"]["amount"], 84100)
        self.assertIn("UNG PETRO", r["rec"]["merchant"] or "")


if __name__ == "__main__":
    unittest.main()
