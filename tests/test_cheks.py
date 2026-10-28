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


if __name__ == "__main__":
    unittest.main()
