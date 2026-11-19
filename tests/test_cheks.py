import unittest

import cheks


class CheksParseTest(unittest.TestCase):
    def test_ofd_url(self):
        u = "https://ofd.soliq.uz/check?t=UZ210168163541&r=2&c=20251015181303&s=030548219873"
        p = cheks.parse_qr_payload(u)
        self.assertTrue(p["ok"])
        self.assertEqual(p["terminalId"], "UZ210168163541")
        self.assertEqual(p["receiptNo"], "2")
        self.assertEqual(p["paidAt"], "2025-10-15 18:13:03")

    def test_rejects_random(self):
        p = cheks.parse_qr_payload("https://example.com/x")
        self.assertFalse(p["ok"])

    def test_html_jami(self):
        html = "<html><title>OLTIN YOL</title><body><p>JAMI: 72 000</p><p>STIR: 123456789</p></body></html>"
        d = cheks.parse_ofd_html(html)
        self.assertEqual(d["merchant"], "OLTIN YOL")
        self.assertEqual(d["amount"], 72000)
        self.assertEqual(d["inn"], "123456789")

    def test_ofd_sign_headers(self):
        h = cheks.ofd_sign_headers("Y2231006003520", "62194", now=1700000000)
        self.assertEqual(h["X-Timestamp"], "1700000000")
        self.assertEqual(len(h["X-Signature"]), 64)

    def test_parse_payment_json(self):
        data = {
            "success": True,
            "data": {
                "tin": "123456789",
                "cashTotal": 0,
                "cardTotal": 72000,
                "kkmName": "Online KKM",
                "extraInfo": {"companyName": "OLTIN YOL", "address": "Toshkent", "paymentType": 2},
                "paymentDetails": [{"name": "AI-80", "amount": 10, "price": 72000}],
            },
        }
        d = cheks.parse_ofd_payment(data)
        self.assertEqual(d["merchant"], "OLTIN YOL")
        self.assertEqual(d["inn"], "123456789")
        self.assertEqual(d["amount"], 72000)
        self.assertEqual(d["payMethod"], "Bank kartasi")
        self.assertEqual(d["items"][0]["name"], "AI-80")

    def test_card_type_code(self):
        d = cheks.parse_ofd_payment({
            "data": {
                "cashTotal": 0, "cardTotal": 86000, "tin": "305515145",
                "extraInfo": {"companyName": "HUBLOT GAS", "paymentType": 2, "cardType": "1"},
                "paymentDetails": [{"name": "Gaz metan", "amount": 15.088, "price": 86000}],
            }
        })
        self.assertEqual(d["cardType"], "UZCARD")
        self.assertEqual(d["amount"], 86000)

    def test_stamp_pad(self):
        self.assertEqual(cheks.ofd_payment_date("202610131311"), "20261013131100")
        p = cheks.parse_qr_payload("https://ofd.soliq.uz/check?t=YZ1&r=1&c=202610131311&s=123")
        self.assertEqual(p["stamp"], "20261013131100")
        self.assertEqual(p["paidAt"], "2026-10-13 13:11:00")

    def test_human_date_dash(self):
        self.assertEqual(cheks.normalize_human_datetime("11-11-2026 20:04:41"), "20261111200441")
        self.assertEqual(cheks.normalize_human_datetime("11.11.2026 20:04:41"), "20261111200441")
        self.assertTrue(cheks._stamp_plausible("20261111200441"))
        self.assertFalse(cheks._stamp_plausible("11112026200441"))

    def test_public_note_hides_urlerror(self):
        n = cheks.public_ofd_note(False, False, "OFD ochilmadi (URLError)", None)
        self.assertNotIn("URLError", n)
        self.assertIn("OFD", n)

    def test_public_note_pending(self):
        n = cheks.public_ofd_note(False, True, "Chek shakllanmoqda", None)
        self.assertIn("shakllan", n.lower())

    def test_fast_record_skips_ofd(self):
        u = "https://ofd.soliq.uz/check?t=Y2231006003520&r=62194&c=20261022234230&s=051359812533"
        t0 = __import__("time").time()
        built = cheks.build_chek_record(u, fetch_ofd=False)
        dt = __import__("time").time() - t0
        self.assertTrue(built["ok"])
        self.assertEqual(built["rec"]["terminalId"], "Y2231006003520")
        self.assertEqual(built["rec"]["receiptNo"], "62194")
        self.assertLess(dt, 0.2)

    def test_merge_keeps_new_scan(self):
        stale = [{"id": "a", "ofdOk": True, "amount": 85000, "merchant": "EKOGAZ"}]
        latest = [
            {"id": "b", "ofdOk": False, "amount": None, "merchant": ""},
            {"id": "a", "ofdOk": False, "amount": None, "merchant": ""},
        ]
        m = cheks.merge_chek_items(stale, latest)
        ids = [x["id"] for x in m]
        self.assertIn("a", ids)
        self.assertIn("b", ids)
        a = next(x for x in m if x["id"] == "a")
        self.assertTrue(a["ofdOk"])
        self.assertEqual(a["amount"], 85000)
        self.assertEqual(a["merchant"], "EKOGAZ")

    def test_ofd_from_payload(self):
        data = {
            "success": True,
            "data": {
                "tin": "307766465",
                "cashTotal": 0,
                "cardTotal": 85000,
                "vatTotal": 9107.14,
                "kkmName": "Online KKM",
                "extraInfo": {"companyName": "QOYLIQ EKOGAZ", "paymentType": 2, "cardType": "1"},
                "paymentDetails": [{"name": "Gaz metan", "amount": 14.912, "price": 85000}],
            },
        }
        d = cheks.ofd_from_payload(data)
        self.assertTrue(d["ofdOk"])
        self.assertEqual(d["amount"], 85000)
        self.assertEqual(d["merchant"], "QOYLIQ EKOGAZ")
        self.assertEqual(d["cardType"], "UZCARD")
        self.assertEqual(d["items"][0]["name"], "Gaz metan")

    def test_public_row_maps_old_error(self):
        row = cheks.public_chek_row({
            "ofdOk": False,
            "ofdPending": False,
            "ofdNote": "OFD ochilmadi (URLError)",
            "amount": None,
            "terminalId": "Y2231006003520",
        })
        self.assertFalse(row.get("ofdOk"))
        self.assertNotIn("URLError", row["ofdNote"])

    def test_manual_fields_build_ofd(self):
        p = cheks.build_ofd_url(
            "YZ329090111713",
            "149478",
            "27.10.2024 08:57",
            "069988523883",
        )
        self.assertTrue(p["ok"])
        self.assertEqual(p["terminalId"], "YZ329090111713")
        self.assertEqual(p["receiptNo"], "149478")
        self.assertEqual(p["fiscalSign"], "069988523883")
        self.assertEqual(p["stamp"], "20241027085700")
        self.assertEqual(p["paidAt"], "2024-10-27 08:57:00")
        self.assertIn("ofd.soliq.uz/check?", p["qr"])

    def test_resolve_chek_input_fields(self):
        p = cheks.resolve_chek_input({
            "terminalId": "YZ123456789012",
            "receiptNo": "12",
            "paidAt": "2026-11-18 12:30",
            "fiscalSign": "99",
        })
        self.assertTrue(p["ok"])
        self.assertEqual(p["stamp"], "20261118123000")
        built = cheks.build_chek_record({
            "terminalId": "YZ123456789012",
            "receiptNo": "12",
            "paidAt": "18.11.2026 12:30",
            "fiscalSign": "99",
        }, fetch_ofd=False)
        self.assertTrue(built["ok"])
        self.assertEqual(built["rec"]["terminalId"], "YZ123456789012")
        self.assertEqual(built["rec"]["receiptNo"], "12")

    def test_manual_requires_fields(self):
        self.assertFalse(cheks.build_ofd_url("", "1", "27.10.2024 08:57", "99")["ok"])
        self.assertFalse(cheks.build_ofd_url("YZ1", "", "27.10.2024 08:57", "99")["ok"])
        miss = cheks.lookup_manual_chek({"receiptNo": "1"}, known_terminals=["YZ123456789012"])
        self.assertFalse(miss["ok"])
        miss2 = cheks.lookup_manual_chek({"fiscalSign": "99"}, known_terminals=["YZ123456789012"])
        self.assertFalse(miss2["ok"])

    def test_terminal_prefix_expand(self):
        terms = cheks.expand_terminal_candidates("329090111713", known_terms=["Y2231006003520"])
        self.assertNotIn("329090111713", terms)  # faqat 14 belgilik
        self.assertTrue(any(t.startswith("YZ") and t.endswith("329090111713") for t in terms))
        self.assertTrue(any(t.startswith("LG") and t.endswith("329090111713") for t in terms))
        self.assertIn("Y2231006003520", terms)

    def test_ofd_terminal_lg(self):
        self.assertTrue(cheks.is_ofd_terminal("LG420230610919"))
        self.assertFalse(cheks.is_ofd_terminal("1170389188"))
        terms = cheks.expand_terminal_candidates("LG420230610919", known_terms=["VG544170000204"])
        self.assertEqual(terms[0], "LG420230610919")
        self.assertIn("VG544170000204", terms)

    def test_short_terminal_needs_fm(self):
        r = cheks.lookup_manual_chek(
            {"receiptNo": "74226", "fiscalSign": "523840633382", "terminalId": "1170389188"},
            known_terminals=[],
        )
        self.assertFalse(r["ok"])
        self.assertTrue(r.get("needFm"))
        self.assertIn("14", r.get("error") or "")

    def test_stamp_candidates_with_date(self):
        stamps = cheks.expand_stamp_candidates("27.10.2024 08:57", max_n=12)
        self.assertIn("20241027085700", stamps)
        self.assertTrue(any(s.startswith("20241027") for s in stamps))

    def test_lookup_manual_needs_known_terminal(self):
        r = cheks.lookup_manual_chek(
            {"receiptNo": "149478", "fiscalSign": "069988523883"},
            known_terminals=[],
        )
        self.assertFalse(r["ok"])
        self.assertIn("Terminal", r.get("error") or "")


if __name__ == "__main__":
    unittest.main()
