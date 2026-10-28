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


if __name__ == "__main__":
    unittest.main()
