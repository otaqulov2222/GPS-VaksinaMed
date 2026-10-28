"""Zapravka cheklari (sandbox) — yoqilg'i hisobotiga ta'sir qilmaydi."""
from __future__ import annotations

import hashlib
import hmac
import html as htmlmod
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from html.parser import HTMLParser

OFD_HOSTS = ("ofd.soliq.uz", "fact.soliq.uz", "my.soliq.uz", "new-ofd.soliq.uz")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
OFD_API = "https://new-ofd.soliq.uz/api/payment"
# ofd.soliq.uz chek sahifasi o'zi shu kalit bilan imzolaydi (ommaviy web).
OFD_HMAC = "thisIsPaymentSecretKey123@#"


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
        "stamp": ofd_payment_date(c),
        "paidAt": paid,
        "host": host,
    }


def ofd_payment_date(c):
    s = re.sub(r"\D", "", str(c or ""))
    if len(s) >= 14:
        return s[:14]
    if len(s) == 12:
        return s + "00"
    if len(s) == 8:
        return s + "000000"
    return s


def parse_ofd_stamp(c):
    s = ofd_payment_date(c)
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


def _ssl_ctx():
    ctx = ssl._create_unverified_context()
    return ctx


def ofd_sign_headers(terminal_id, payment_no, now=None):
    ts = int(now if now is not None else time.time())
    msg = ("%s:%s:%s" % (terminal_id, payment_no, ts)).encode("utf-8")
    sig = hmac.new(OFD_HMAC.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    return {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": UA,
        "Origin": "https://ofd.soliq.uz",
        "Referer": "https://ofd.soliq.uz/",
        "X-Timestamp": str(ts),
        "X-Signature": sig,
    }


def _http_json(req, timeout=12):
    with urllib.request.urlopen(req, timeout=timeout, context=_ssl_ctx()) as resp:
        raw = resp.read()[:400000]
        ctype = (resp.headers.get("Content-Type") or "").lower()
        return resp.status, ctype, raw.decode("utf-8", "replace")


def parse_ofd_payment(data):
    out = {
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
        "ofdPending": False,
    }
    if not isinstance(data, dict):
        return out
    blob = data.get("data") if isinstance(data.get("data"), dict) else data
    if not isinstance(blob, dict):
        return out
    extra = blob.get("extraInfo") if isinstance(blob.get("extraInfo"), dict) else {}
    out["merchant"] = str(extra.get("companyName") or blob.get("kkmName") or "").strip()[:180]
    out["address"] = str(extra.get("address") or "").strip()[:220]
    out["kkmName"] = str(blob.get("kkmName") or "").strip()[:120]
    raw_card = str(extra.get("cardType") or extra.get("card") or "").strip()
    card_map = {"1": "UZCARD", "2": "HUMO", "3": "VISA", "4": "Mastercard"}
    out["cardType"] = card_map.get(raw_card, raw_card[:40])
    vat = _ofd_som(blob.get("vatTotal"))
    out["vatTotal"] = vat
    tin = str(blob.get("tin") or extra.get("tin") or "").strip()
    if re.fullmatch(r"\d{9}", tin):
        out["inn"] = tin
    cash = _ofd_som(blob.get("cashTotal"))
    card = _ofd_som(blob.get("cardTotal"))
    out["cashTotal"] = cash
    out["cardTotal"] = card
    total = (cash or 0) + (card or 0)
    ptype = extra.get("paymentType")
    pay_map = {1: "Naqd", 2: "Bank kartasi", 3: "QR", 4: "Aralash"}
    try:
        out["payMethod"] = pay_map.get(int(ptype), "")
    except (TypeError, ValueError):
        out["payMethod"] = ""
    if not out["payMethod"]:
        if cash and card:
            out["payMethod"] = "Aralash"
        elif card:
            out["payMethod"] = "Bank kartasi"
        elif cash:
            out["payMethod"] = "Naqd"
    details = blob.get("paymentDetails") or blob.get("items") or []
    if isinstance(details, list):
        for it in details[:40]:
            if not isinstance(it, dict):
                continue
            name = str(it.get("name") or it.get("productName") or it.get("title") or "").strip()
            qty = it.get("amount") if it.get("amount") is not None else it.get("qty")
            sm = _ofd_som(it.get("price") if it.get("price") is not None else it.get("sum"))
            if name:
                out["items"].append({"name": name[:120], "qty": qty, "sum": sm})
    if total > 0:
        out["amount"] = round(total, 2)
    elif out["items"]:
        acc = 0
        ok = False
        for it in out["items"]:
            if it.get("sum") is not None:
                acc += float(it["sum"])
                ok = True
        if ok and acc > 0:
            out["amount"] = round(acc, 2)
    return out


def _ofd_som(val):
    if val is None or val == "":
        return None
    try:
        x = float(val)
    except (TypeError, ValueError):
        return _to_som(val)
    if not x:
        return 0.0
    return round(x, 2)


def _has_amount(amount):
    try:
        return amount not in (None, "") and float(amount) > 0
    except (TypeError, ValueError):
        return False


def public_ofd_note(ofd_ok=False, ofd_pending=False, note="", amount=None):
    """Foydalanuvchiga texnik xato (URLError va h.k.) ko'rsatilmasin."""
    has_amt = _has_amount(amount)
    if ofd_ok and has_amt:
        return ""
    raw = str(note or "").strip()
    low = raw.lower()
    if ofd_pending or "shakllan" in low:
        return "Soliq OFD da chek hali shakllanmoqda (48 soatgacha). Qog‘oz saqlandi."
    if re.search(r"urlerror|sslerror|timeout|timed out|connection|handshake|urlopen|eof|javob bermadi", raw, re.I):
        return "OFD dan to‘liq chek olinmoqda. Bir necha soniyada o‘zi tushadi."
    cleaned = re.sub(r"\s*\([A-Za-z_]*Error\)\s*", " ", raw).strip()
    cleaned = re.sub(r"\bOFD ochilmadi\b", "OFD vaqtincha javob bermadi", cleaned, flags=re.I)
    if cleaned:
        return cleaned[:180]
    if not has_amt:
        return "Chek saqlandi. OFD dan summa hali kelmadi."
    return ""


def public_chek_row(row):
    if not isinstance(row, dict):
        return row
    out = dict(row)
    note = str(out.get("ofdNote") or "")
    if "shakllan" in note.lower() and not out.get("ofdOk"):
        out["ofdPending"] = True
    out["ofdNote"] = public_ofd_note(
        bool(out.get("ofdOk")),
        bool(out.get("ofdPending")),
        note,
        out.get("amount"),
    )
    return out


def fetch_ofd_api(parsed, timeout=16):
    term = str((parsed or {}).get("terminalId") or "")
    payno = str((parsed or {}).get("receiptNo") or "")
    stamp = str((parsed or {}).get("stamp") or "")
    sign = str((parsed or {}).get("fiscalSign") or "")
    empty = {
        "ofdOk": False,
        "ofdNote": "",
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
        "ofdPending": False,
    }
    if not term or not payno or not stamp:
        return empty
    body = json.dumps(
        {
            "terminalId": term,
            "paymentNo": payno,
            "paymentDate": stamp,
            "paymentType": "CHECK",
            **({"fiscalSign": sign} if sign else {}),
        }
    ).encode("utf-8")
    last_note = ""
    attempts = 2
    while attempts:
        attempts -= 1
        req = urllib.request.Request(
            OFD_API,
            data=body,
            method="POST",
            headers=ofd_sign_headers(term, payno),
        )
        try:
            _status, _ctype, text = _http_json(req, timeout=timeout)
            data = json.loads(text) if text.lstrip().startswith("{") else {}
            parsed_pay = parse_ofd_payment(data)
            parsed_pay["ofdOk"] = _has_amount(parsed_pay.get("amount"))
            parsed_pay["ofdPending"] = False
            parsed_pay["ofdNote"] = public_ofd_note(
                parsed_pay["ofdOk"],
                False,
                "" if parsed_pay["ofdOk"] else (data.get("message") or ""),
                parsed_pay.get("amount"),
            )
            return parsed_pay
        except urllib.error.HTTPError as e:
            raw = ""
            try:
                raw = e.read().decode("utf-8", "replace")[:800]
            except Exception:
                raw = ""
            msg = ""
            try:
                msg = str((json.loads(raw) or {}).get("message") or "")
            except Exception:
                msg = raw[:180]
            if e.code in (404, 422) or "shakllan" in (msg or "").lower():
                empty["ofdPending"] = True
                empty["ofdNote"] = public_ofd_note(False, True, msg, None)
                return empty
            last_note = msg or ("OFD javobi " + str(e.code))
            if e.code in (401, 403, 500, 502, 503) and attempts:
                time.sleep(0.35)
                continue
            break
        except Exception:
            last_note = "OFD dan to‘liq chek olinmoqda."
            if attempts:
                time.sleep(0.45)
                continue
            break
    empty["ofdNote"] = public_ofd_note(False, False, last_note, None)
    return empty


def fetch_ofd_details(qr_url, timeout=16, parsed=None):
    url = str(qr_url or "").strip()
    if parsed is None and url:
        parsed = parse_qr_payload(url)
        if not parsed.get("ok"):
            parsed = None
    api = fetch_ofd_api(parsed, timeout=timeout) if parsed else ofd_shell()
    if not parsed:
        api["ofdPending"] = False
        api["ofdNote"] = "Havola yo'q"
        return api
    api["ofdNote"] = public_ofd_note(
        bool(api.get("ofdOk")), bool(api.get("ofdPending")),
        api.get("ofdNote") or "", api.get("amount"),
    )
    return api


def ofd_shell():
    return {
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
        "ofdOk": False,
        "ofdPending": True,
        "ofdNote": "Chek saqlandi. OFD dan o‘qilmoqda…",
    }


def build_chek_record(qr_raw, extra=None, fetch_ofd=True):
    parsed = parse_qr_payload(qr_raw)
    if not parsed.get("ok"):
        return parsed
    ofd = fetch_ofd_details(parsed["qr"], parsed=parsed) if fetch_ofd else ofd_shell()
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
        "address": ofd.get("address") or "",
        "cashTotal": ofd.get("cashTotal"),
        "cardTotal": ofd.get("cardTotal"),
        "payMethod": ofd.get("payMethod") or "",
        "kkmName": ofd.get("kkmName") or "",
        "cardType": ofd.get("cardType") or "",
        "vatTotal": ofd.get("vatTotal"),
        "ofdOk": bool(ofd.get("ofdOk")),
        "ofdPending": bool(ofd.get("ofdPending")),
        "ofdNote": public_ofd_note(
            bool(ofd.get("ofdOk")),
            bool(ofd.get("ofdPending")),
            ofd.get("ofdNote") or "",
            ofd.get("amount"),
        ),
    }
    if isinstance(extra, dict):
        if extra.get("amount") not in (None, ""):
            amt = _to_som(extra.get("amount"))
            if amt and amt > 0:
                rec["amount"] = amt
        if extra.get("merchant"):
            rec["merchant"] = str(extra.get("merchant"))[:180]
    return {"ok": True, "rec": rec}
