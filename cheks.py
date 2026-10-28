"""Zapravka cheklari (sandbox) — yoqilg'i hisobotiga ta'sir qilmaydi."""
from __future__ import annotations

import html as htmlmod
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from html.parser import HTMLParser

OFD_HOSTS = ("ofd.soliq.uz", "fact.soliq.uz", "my.soliq.uz")
UA = "Mozilla/5.0 (compatible; VaksinaMed-Chek/1.0)"


class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self._skip = 0
        self.parts = []
        self.title = ""
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self._skip += 1
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript") and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._skip:
            return
        t = " ".join((data or "").split())
        if not t:
            return
        if self._in_title and not self.title:
            self.title = t
        self.parts.append(t)


def parse_qr_payload(raw):
    s = str(raw or "").strip()
    if not s:
        return {"ok": False, "error": "QR bo'sh"}
    if s.startswith("http://"):
        s = "https://" + s[7:]
    if not re.match(r"^https://", s, re.I):
        maybe = "https://" + s.lstrip("/")
        if "ofd.soliq.uz" in maybe or "soliq.uz" in maybe:
            s = maybe
    try:
        u = urllib.parse.urlparse(s)
    except Exception:
        return {"ok": False, "error": "QR havola emas"}
    host = (u.netloc or "").lower().replace("www.", "")
    qs = urllib.parse.parse_qs(u.query or "")
    def one(k):
        v = qs.get(k) or qs.get(k.upper()) or []
        return str(v[0]).strip() if v else ""

    t = one("t")
    r = one("r")
    c = one("c")
    sig = one("s")
    ofd_like = any(h in host for h in OFD_HOSTS) or (t and r and c and sig)
    if not ofd_like:
        return {
            "ok": False,
            "error": "Bu soliq/OFD chek QR emas. Chekdagi pastki QR ni skanerlang.",
            "qr": s[:500],
        }
    paid = parse_ofd_stamp(c)
    return {
        "ok": True,
        "qr": s[:500],
        "terminalId": t[:40],
        "receiptNo": r[:40],
        "fiscalSign": sig[:40],
        "stamp": c[:20],
        "paidAt": paid,
        "host": host,
    }


def parse_ofd_stamp(c):
    s = re.sub(r"\D", "", str(c or ""))
    if len(s) >= 14:
        try:
            dt = datetime.strptime(s[:14], "%Y%m%d%H%M%S")
            return dt.strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            return ""
    if len(s) >= 8:
        try:
            dt = datetime.strptime(s[:8], "%Y%m%d")
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            return ""
    return ""


def _to_som(val):
    if val is None or val == "":
        return None
    if isinstance(val, (int, float)):
        x = float(val)
        # 7200000 tiyin → 72000 so'm
        if abs(x) >= 100000 and abs(x) % 100 == 0 and abs(x) < 1e12:
            if abs(x) >= 1e6:
                return round(x / 100.0, 2)
        return round(x, 2)
    s = str(val).replace("\xa0", " ").replace(" ", "").replace(",", ".")
    s = re.sub(r"[^\d.\-]", "", s)
    if not s or s in ".-":
        return None
    try:
        return round(float(s), 2)
    except ValueError:
        return None


def parse_ofd_html(raw_html):
    html = str(raw_html or "")
    out = {"merchant": "", "inn": "", "amount": None, "items": []}
    if not html.strip():
        return out

    mjson = re.search(r'<script[^>]+type=["\']application/json["\'][^>]*>(.*?)</script>', html, re.I | re.S)
    if mjson:
        try:
            data = json.loads(htmlmod.unescape(mjson.group(1)))
            _merge_json_receipt(out, data)
        except Exception:
            pass

    for m in re.finditer(r"window\.__[A-Z_]+__\s*=\s*(\{.*?\});", html, re.S):
        try:
            _merge_json_receipt(out, json.loads(m.group(1)))
        except Exception:
            pass

    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:
        pass
    text = " \n ".join(parser.parts)
    if parser.title and not out["merchant"]:
        t = parser.title
        t = re.sub(r"\s*[|\-–].*$", "", t).strip()
        low = t.lower()
        if t and not re.search(r"ofd|soliq|check|chek|fiscal", low):
            out["merchant"] = t[:180]

    inn = re.search(r"\b(STIR|ИНН|INN)\b\s*[:№]?\s*(\d{9})", text, re.I)
    if inn:
        out["inn"] = inn.group(2)

    if out["amount"] is None:
        for pat in (
            r"(?:JAMI|ЖАМИ|Итого|Total|SUMMA|Сумма)\s*[:\-]?\s*([0-9\s.,]{3,18})",
            r"([0-9][0-9\s]{2,15}(?:[.,]\d{2})?)\s*(?:so['`‘’]?m|сум|UZS)",
        ):
            m = re.search(pat, text, re.I)
            if m:
                amt = _to_som(m.group(1 if m.lastindex else 0))
                if amt and amt > 0:
                    out["amount"] = amt
                    break

    if not out["merchant"]:
        for line in text.split("\n"):
            line = line.strip()
            if 8 <= len(line) <= 80 and re.search(r"[A-Za-zА-Яа-яЎўҚқҒғҲҳ]", line):
                if not re.search(r"QR|soliq|ofd|check|chek", line, re.I):
                    out["merchant"] = line[:180]
                    break
    return out


def _merge_json_receipt(out, data):
    if not isinstance(data, dict):
        return
    blob = data.get("data") if isinstance(data.get("data"), dict) else data
    if not isinstance(blob, dict):
        return
    for k in ("companyName", "company", "merchant", "name", "orgName", "seller"):
        v = blob.get(k)
        if isinstance(v, str) and v.strip() and not out["merchant"]:
            out["merchant"] = v.strip()[:180]
    for k in ("inn", "tin", "stir", "companyInn"):
        v = str(blob.get(k) or "").strip()
        if re.fullmatch(r"\d{9}", v):
            out["inn"] = v
    for k in ("total", "amount", "sum", "jami", "totalSum"):
        if blob.get(k) is not None and out["amount"] is None:
            amt = _to_som(blob.get(k))
            if amt and amt > 0:
                out["amount"] = amt
    items = blob.get("items") or blob.get("products") or []
    if isinstance(items, list):
        for it in items[:40]:
            if not isinstance(it, dict):
                continue
            name = str(it.get("name") or it.get("title") or it.get("spicName") or "").strip()
            sm = _to_som(it.get("sum") or it.get("price") or it.get("total") or it.get("amount"))
            qty = it.get("qty") or it.get("quantity") or it.get("count")
            if name:
                out["items"].append({"name": name[:120], "qty": qty, "sum": sm})


def fetch_ofd_details(qr_url, timeout=10):
    url = str(qr_url or "").strip()
    note = ""
    html = ""
    if not url.startswith("https://"):
        return {"ofdOk": False, "ofdNote": "Havola yo'q", "merchant": "", "inn": "", "amount": None, "items": []}
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html,application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()[:400000]
            ctype = (resp.headers.get("Content-Type") or "").lower()
        text = raw.decode("utf-8", "replace")
        if "json" in ctype or text.lstrip().startswith("{"):
            try:
                parsed = {"merchant": "", "inn": "", "amount": None, "items": []}
                _merge_json_receipt(parsed, json.loads(text))
                parsed["ofdOk"] = parsed.get("amount") is not None and float(parsed.get("amount") or 0) > 0
                parsed["ofdNote"] = "" if parsed["ofdOk"] else "OFD JSON da summa yo'q"
                return parsed
            except Exception:
                html = text
        else:
            html = text
    except urllib.error.HTTPError as e:
        note = "OFD javobi " + str(e.code)
    except Exception as e:
        note = "OFD ochilmadi (" + type(e).__name__ + ")"

    parsed = parse_ofd_html(html) if html else {"merchant": "", "inn": "", "amount": None, "items": []}
    parsed["ofdOk"] = parsed.get("amount") is not None and float(parsed.get("amount") or 0) > 0
    if parsed["ofdOk"]:
        parsed["ofdNote"] = ""
    else:
        parsed["ofdNote"] = note or "Chek saqlandi. OFD dan summa kelmadi — QR va sana yozildi."
    return parsed


def build_chek_record(qr_raw, extra=None):
    parsed = parse_qr_payload(qr_raw)
    if not parsed.get("ok"):
        return parsed
    ofd = fetch_ofd_details(parsed["qr"])
    rec = {
        "qr": parsed["qr"],
        "terminalId": parsed["terminalId"],
        "receiptNo": parsed["receiptNo"],
        "fiscalSign": parsed["fiscalSign"],
        "paidAt": parsed["paidAt"],
        "merchant": ofd.get("merchant") or "",
        "inn": ofd.get("inn") or "",
        "amount": ofd.get("amount"),
        "items": ofd.get("items") or [],
        "ofdOk": bool(ofd.get("ofdOk")),
        "ofdNote": ofd.get("ofdNote") or "",
    }
    if isinstance(extra, dict):
        if extra.get("amount") not in (None, ""):
            amt = _to_som(extra.get("amount"))
            if amt and amt > 0:
                rec["amount"] = amt
        if extra.get("merchant"):
            rec["merchant"] = str(extra.get("merchant"))[:180]
    return {"ok": True, "rec": rec}
