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
# Parkda tez-tez uchraydigan OFD terminallar — Chek № + FB yetarli bo‘lishi uchun
# (noto‘g‘ri eslab qolingan VG bilan birinchi stansiya ham ishlasin).
FLEET_TERMINAL_SEEDS = (
    "LG420211628460",  # UNG PETRO
    "VG544170024111",
    "VG544170049533",  # DADANUR va boshqa VG
)


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


def _stamp_plausible(stamp):
    s = re.sub(r"\D", "", str(stamp or ""))
    if len(s) < 8:
        return False
    try:
        y = int(s[:4])
        return 2020 <= y <= 2035
    except ValueError:
        return False


def normalize_human_datetime(raw):
    """Qog'oz chekdagi sana/vaqtni OFD stamp (YYYYMMDDHHMMSS) ga aylantiradi."""
    s = str(raw or "").strip()
    if not s:
        return ""
    # ISO YYYY-MM-DD avval (11-11-2026 bilan chalkashmasin)
    m2 = re.match(
        r"^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?",
        s,
    )
    if m2:
        yyyy, mm, dd = int(m2.group(1)), int(m2.group(2)), int(m2.group(3))
        hh = int(m2.group(4) or 0)
        mi = int(m2.group(5) or 0)
        ss = int(m2.group(6) or 0)
        try:
            datetime(yyyy, mm, dd, hh, mi, ss)
        except ValueError:
            return ""
        return "%04d%02d%02d%02d%02d%02d" % (yyyy, mm, dd, hh, mi, ss)
    # Odam formati: 11.11.2026 / 11-11-2026 / 11/11/2026 20:04:41
    m = re.match(
        r"^(\d{1,2})[-./](\d{1,2})[-./](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?",
        s,
    )
    if m:
        dd, mm, yyyy = int(m.group(1)), int(m.group(2)), int(m.group(3))
        hh = int(m.group(4) or 0)
        mi = int(m.group(5) or 0)
        ss = int(m.group(6) or 0)
        try:
            datetime(yyyy, mm, dd, hh, mi, ss)
        except ValueError:
            return ""
        return "%04d%02d%02d%02d%02d%02d" % (yyyy, mm, dd, hh, mi, ss)
    digits = re.sub(r"\D", "", s)
    if len(digits) >= 14:
        stamp = digits[:14]
        return stamp if _stamp_plausible(stamp) else ""
    if len(digits) == 12:
        stamp = digits + "00"
        return stamp if _stamp_plausible(stamp) else ""
    if len(digits) == 8:
        # YYYYMMDD yoki DDMMYYYY
        if _stamp_plausible(digits + "000000"):
            return digits + "000000"
        try:
            dd, mm, yyyy = int(digits[:2]), int(digits[2:4]), int(digits[4:8])
            datetime(yyyy, mm, dd)
            return "%04d%02d%02d000000" % (yyyy, mm, dd)
        except ValueError:
            return ""
    return ""


def _clean_id(raw):
    return re.sub(r"\s+", "", str(raw or "")).strip()


# Soliq OFD terminal/FM odatda 14 belgi: 2 harf + 12 raqam (LG/VG/YZ/UZ…).
OFD_TERM_PREFIXES = (
    "LG", "VG", "YZ", "UZ", "EZ", "EP", "NZ", "AZ", "NG", "PG",
    "Y2", "Y0", "Z0", "FM", "FC", "FS",
)


def is_ofd_terminal(raw):
    t = _clean_id(raw)
    if len(t) != 14:
        return False
    return bool(re.fullmatch(r"[A-Za-z0-9]{14}", t))


def expand_terminal_candidates(raw_term, known_terms=None, limit=24):
    """
    Foydalanuvchi yozgan Terminal/FM + avvalgi 14 belgilik ID larni tartiblaydi.
    Qisqa raqamga odatiy prefikslar qo‘shadi; known ichidan raqam mosligini ustun qo‘yadi.
    """
    out = []
    seen = set()

    def add(t, force=False):
        t = _clean_id(t)
        if not t or t in seen:
            return
        # OFD faqat 14 belgini qabul qiladi — boshqalarini o‘tkazib yubormaymiz
        # (lekin force=True: avval xom kiritishni saqlamaymiz, faqat variantlar).
        if not force and len(t) != 14:
            digits = re.sub(r"\D", "", t)
            letters = re.sub(r"[^A-Za-z]", "", t)
            if len(t) == 12 and digits == t:
                for pref in OFD_TERM_PREFIXES:
                    add(pref + t)
            elif len(digits) == 12 and len(letters) <= 2:
                core = digits[-12:]
                if letters:
                    add((letters.upper() + core)[:14])
                for pref in OFD_TERM_PREFIXES:
                    add(pref + core)
            elif len(t) > 14:
                if len(digits) >= 14 and re.fullmatch(r"[A-Za-z]{2}\d{12}", t[:14], re.I):
                    add(t[:14])
                elif len(digits) >= 12:
                    core = digits[-12:]
                    for pref in OFD_TERM_PREFIXES:
                        add(pref + core)
            return
        if len(t) != 14:
            return
        seen.add(t)
        out.append(t[:40])

    raw = _clean_id(raw_term)
    if is_ofd_terminal(raw):
        add(raw)
    elif raw:
        add(raw)  # prefiks/variatsiyalar chiqadi

    digits = re.sub(r"\D", "", raw) if raw else ""
    matching = []
    other = []
    for t in known_terms or []:
        t = _clean_id(t)
        if not is_ofd_terminal(t):
            continue
        kd = re.sub(r"\D", "", t)
        if digits and len(digits) >= 8 and digits in kd:
            matching.append(t)
        else:
            other.append(t)
    for t in matching + other:
        add(t)
        if len(out) >= limit:
            break
    return out[:limit]


def expand_stamp_candidates(raw_when, max_n=24):
    """Sana bo‘lmasa yaqin vaqtlarni, bo‘lsa ±daqiqalarni sinaydi."""
    from datetime import timedelta

    out = []
    seen = set()

    def add(s):
        s = str(s or "").strip()
        if not s:
            return
        if re.fullmatch(r"\d{8,14}", s):
            stamp = ofd_payment_date(s)
        else:
            stamp = ofd_payment_date(normalize_human_datetime(s))
        if not stamp or not _stamp_plausible(stamp) or stamp in seen:
            return
        seen.add(stamp)
        out.append(stamp)

    now = datetime.now()
    base = normalize_human_datetime(raw_when) if raw_when else ""
    if base:
        add(base)
        try:
            dt = datetime.strptime(base[:14], "%Y%m%d%H%M%S")
            for delta in (0, -1, 1, -2, 2, -3, 3, -5, 5, -10, 10, -15, 15, -30, 30, -45, 45, -60, 60):
                add((dt + timedelta(minutes=delta)).strftime("%Y%m%d%H%M%S"))
                add((dt + timedelta(minutes=delta)).strftime("%Y%m%d%H%M00"))
            add(dt.strftime("%Y%m%d%H0000"))
            add(dt.strftime("%Y%m%d000000"))
        except ValueError:
            pass
    else:
        # Sana yo‘q yoki noto‘g‘ri — oxirgi soatlar/kunlar
        add(now.strftime("%Y%m%d%H%M%S"))
        add(now.strftime("%Y%m%d%H%M00"))
        for delta_m in range(0, 360, 5):
            add((now - timedelta(minutes=delta_m)).strftime("%Y%m%d%H%M00"))
            if len(out) >= max(12, max_n // 2):
                break
        for d in range(0, 5):
            day = now - timedelta(days=d)
            for hh in range(6, 24):
                add(day.strftime("%Y%m%d") + "%02d0000" % hh)
                add(day.strftime("%Y%m%d") + "%02d1500" % hh)
                add(day.strftime("%Y%m%d") + "%02d3000" % hh)
                add(day.strftime("%Y%m%d") + "%02d4500" % hh)
                if len(out) >= max_n:
                    return out[:max_n]
    return out[:max_n]


def build_ofd_url(terminal_id, receipt_no, paid_at_or_stamp, fiscal_sign=""):
    """Qog'ozdagi Terminal / Chek № / Sana / FB dan OFD havola yasaydi."""
    term = _clean_id(terminal_id)
    receipt = _clean_id(receipt_no)
    sign = _clean_id(fiscal_sign)
    stamp = normalize_human_datetime(paid_at_or_stamp) or ofd_payment_date(paid_at_or_stamp)
    if not term:
        return {"ok": False, "error": "Terminal topilmadi"}
    if not receipt:
        return {"ok": False, "error": "Chek № ni yozing"}
    if not stamp or len(re.sub(r"\D", "", stamp)) < 8:
        stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    stamp = ofd_payment_date(stamp)
    q = {"t": term[:40], "r": receipt[:40], "c": stamp}
    if sign:
        q["s"] = sign[:40]
    url = "https://ofd.soliq.uz/check?" + urllib.parse.urlencode(q)
    return parse_qr_payload(url)


def _manual_hit_rec(parsed, ofd, sign):
    return {
        "qr": parsed["qr"],
        "terminalId": parsed["terminalId"],
        "receiptNo": parsed["receiptNo"],
        "fiscalSign": parsed["fiscalSign"] or sign,
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
        "ofdOk": True,
        "ofdPending": False,
        "ofdNote": public_ofd_note(True, False, ofd.get("ofdNote") or "", ofd.get("amount")),
        "manualLookup": True,
        "qrSource": "manual",
    }


def lookup_manual_chek(fields, known_terminals=None, timeout=5, max_tries=36):
    """
    Chek № + FB + FM/Terminal (14 belgi).
    To‘g‘ri FM bo‘lsa — OFD dan to‘liq chekni tez topadi.
    Noto‘g‘ri/eslab qolingan terminal bilan soxta «kutilmoqda» saqlamaydi.
    """
    fields = fields if isinstance(fields, dict) else {}
    receipt = _clean_id(
        fields.get("receiptNo") or fields.get("paymentNo") or fields.get("r") or fields.get("chekNo")
    )
    sign = _clean_id(
        fields.get("fiscalSign") or fields.get("fb") or fields.get("s") or fields.get("fiscal")
    )
    term_in = _clean_id(
        fields.get("terminalId")
        or fields.get("terminal")
        or fields.get("fm")
        or fields.get("FM")
        or fields.get("t")
    )
    when = (
        fields.get("paidAt")
        or fields.get("stamp")
        or fields.get("paymentDate")
        or fields.get("c")
        or fields.get("when")
        or ""
    )
    if not receipt:
        return {"ok": False, "error": "Chek № ni yozing"}
    if not sign:
        return {"ok": False, "error": "FB (fiskal belgi) ni yozing"}

    user_exact = is_ofd_terminal(term_in)
    # Foydalanuvchi qisqa/noto‘g‘ri ID yozgan bo‘lsa — known bilan chalg‘itmaymiz
    if term_in and not user_exact and not expand_terminal_candidates(term_in, [], limit=6):
        return {
            "ok": False,
            "error": "FM/Terminal 14 belgi bo‘lishi kerak (masalan LG420230610919). Qog‘ozdagi Terminal ni yozing — «PAX A-930» emas.",
            "needFm": True,
        }
    # Tartib: foydalanuvchi FM → park seed → known (seed hech qachon kesilmasin)
    seeds = [t for t in FLEET_TERMINAL_SEEDS if is_ofd_terminal(_clean_id(t))]
    pool = []
    seen_pool = set()
    for t in list(seeds) + list(known_terminals or []):
        t = _clean_id(t)
        if not is_ofd_terminal(t) or t in seen_pool:
            continue
        seen_pool.add(t)
        pool.append(t)
    expanded = expand_terminal_candidates(term_in, pool, limit=24)
    ordered = []
    for t in ([term_in] if user_exact else []) + list(seeds) + list(expanded):
        t = _clean_id(t)
        if is_ofd_terminal(t) and t not in ordered:
            ordered.append(t)
    terminals = ordered[:10]
    if not terminals:
        return {
            "ok": False,
            "error": "Terminal yo‘q. Qog‘ozdagi Terminal (14 belgi: LG… / VG… / YZ…) ni yozing — «PAX A-930» KKM modeli, Terminal emas.",
            "needFm": True,
        }

    # Sana chalkashishi mumkin: 1 ta foydalanuvchi sanasi + «hozir» stamp’lar (ustun)
    when_ok = bool(normalize_human_datetime(when)) if when else False
    stamps = []
    seen_s = set()

    def _add_stamps(seq):
        for s in seq:
            if s not in seen_s:
                seen_s.add(s)
                stamps.append(s)

    if when_ok:
        user_stamps = expand_stamp_candidates(when, max_n=3)
        now_stamps = expand_stamp_candidates("", max_n=4)
        if user_stamps:
            _add_stamps(user_stamps[:1])
        _add_stamps(now_stamps)
        _add_stamps(user_stamps[1:])
    else:
        _add_stamps(expand_stamp_candidates("", max_n=5))
    if not stamps:
        _add_stamps(expand_stamp_candidates("", max_n=4))
    stamps = stamps[:7]
    timeout = max(3, min(int(timeout or 4), 4))
    max_tries = 14
    tries = 0

    def try_one(term, stamp):
        nonlocal tries
        if tries >= max_tries:
            return None
        parsed = build_ofd_url(term, receipt, stamp, sign)
        if not parsed.get("ok"):
            return None
        tries += 1
        ofd = fetch_ofd_api(parsed, timeout=timeout, attempts=1)
        if ofd.get("ofdOk") and _has_amount(ofd.get("amount")):
            return _manual_hit_rec(parsed, ofd, sign)
        return None

    # Har terminalga bir necha stamp — chalkash sana to‘g‘ri FM ni o‘ldirmasin.
    # Noto‘g‘ri yozilgan FM (seed emas): 1 stamp bilan tez tashlanadi.
    seed_set = set(seeds)
    for term in terminals:
        if user_exact and term == term_in and term not in seed_set:
            budget = 1
        else:
            budget = min(4, len(stamps))
        for stamp in stamps[:budget]:
            hit = try_one(term, stamp)
            if hit:
                return {"ok": True, "rec": hit, "tries": tries}
            if tries >= max_tries:
                break
        if tries >= max_tries:
            break

    wrong = term_in if user_exact else ""
    hint = (
        ("«" + wrong + "» shu Chek/FB uchun mos emas. ")
        if wrong
        else ""
    )
    return {
        "ok": False,
        "error": (
            hint
            + "OFD topilmadi. FM maydonini bo‘sh qoldirib faqat Chek № + FB yozing. "
            "Yoki shu qog‘ozdagi Terminal (14 belgi). «PAX A-930» — KKM, Terminal emas."
        ),
        "tries": tries,
        "needFm": True,
    }


def resolve_chek_input(raw):
    """QR havola yoki qo'lda kiritilgan maydonlardan OFD parse."""
    if isinstance(raw, dict):
        qr = str(raw.get("qr") or "").strip()
        if qr:
            return parse_qr_payload(qr)
        return build_ofd_url(
            raw.get("terminalId") or raw.get("terminal") or raw.get("t"),
            raw.get("receiptNo") or raw.get("paymentNo") or raw.get("r"),
            raw.get("paidAt")
            or raw.get("stamp")
            or raw.get("paymentDate")
            or raw.get("c")
            or raw.get("when")
            or datetime.now().strftime("%Y%m%d%H%M%S"),
            raw.get("fiscalSign") or raw.get("fb") or raw.get("s") or "",
        )
    return parse_qr_payload(raw)


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


def ofd_from_payload(data):
    """Soliq /api/payment JSON → ichki OFD maydonlari."""
    blob = data if isinstance(data, dict) else {}
    parsed = parse_ofd_payment(blob)
    parsed["ofdOk"] = _has_amount(parsed.get("amount"))
    parsed["ofdPending"] = False
    msg = ""
    if not parsed["ofdOk"]:
        msg = str(blob.get("message") or "")
        inner = blob.get("data") if isinstance(blob.get("data"), dict) else {}
        if not msg and isinstance(inner, dict):
            msg = str(inner.get("message") or "")
    parsed["ofdNote"] = public_ofd_note(
        parsed["ofdOk"], False, msg, parsed.get("amount")
    )
    return parsed


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


def _chek_filled(v):
    if v is None or v == "":
        return False
    if isinstance(v, list) and not v:
        return False
    return True


def prefer_chek_row(old, new):
    """Ikki versiyani birlashtiradi — bo'sh maydon to'liqni o'chirmaydi."""
    if not isinstance(old, dict):
        return dict(new) if isinstance(new, dict) else {}
    if not isinstance(new, dict):
        return dict(old)
    out = dict(old)
    out.update(new)
    rich = (
        "amount", "merchant", "inn", "items", "address", "cardType",
        "payMethod", "kkmName", "vatTotal", "cardTotal", "cashTotal",
        "fiscalSign", "qr", "terminalId", "receiptNo", "plate",
    )
    for k in rich:
        if (not _chek_filled(new.get(k))) and _chek_filled(old.get(k)):
            out[k] = old.get(k)
    if old.get("ofdOk") and not new.get("ofdOk"):
        out["ofdOk"] = True
        out["ofdPending"] = False
        if old.get("ofdNote"):
            out["ofdNote"] = old.get("ofdNote")
    return out


def merge_chek_items(*groups):
    """Cheklarni id bo'yicha qo'shadi — eski snapshot yangi skanni o'chirmaydi."""
    by_id = {}
    for group in groups:
        for row in group or []:
            if not isinstance(row, dict):
                continue
            rid = str(row.get("id") or "")
            if not rid:
                continue
            by_id[rid] = prefer_chek_row(by_id.get(rid), row)
    items = list(by_id.values())
    items.sort(key=lambda r: str(r.get("paidAt") or r.get("createdAt") or ""), reverse=True)
    return items


def fetch_ofd_api(parsed, timeout=8, attempts=2):
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
    left = max(1, int(attempts or 1))
    while left:
        left -= 1
        req = urllib.request.Request(
            OFD_API,
            data=body,
            method="POST",
            headers=ofd_sign_headers(term, payno),
        )
        try:
            _status, _ctype, text = _http_json(req, timeout=timeout)
            data = json.loads(text) if text.lstrip().startswith("{") else {}
            return ofd_from_payload(data)
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
            if e.code in (401, 403, 500, 502, 503) and left:
                time.sleep(0.35)
                continue
            break
        except Exception:
            last_note = "OFD dan to‘liq chek olinmoqda."
            if left:
                time.sleep(0.45)
                continue
            break
    empty["ofdNote"] = public_ofd_note(False, False, last_note, None)
    return empty


def fetch_ofd_details(qr_url, timeout=8, parsed=None, attempts=2):
    url = str(qr_url or "").strip()
    if parsed is None and url:
        parsed = parse_qr_payload(url)
        if not parsed.get("ok"):
            parsed = None
    api = fetch_ofd_api(parsed, timeout=timeout, attempts=attempts) if parsed else ofd_shell()
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
    parsed = resolve_chek_input(qr_raw)
    if not parsed.get("ok"):
        return parsed
    if isinstance(qr_raw, dict) and extra is None:
        extra = qr_raw
    ofd = fetch_ofd_details(parsed["qr"], parsed=parsed) if fetch_ofd else ofd_shell()
    # Skaner matni bo‘lsa — aynan o‘sha OFD havolani saqlaymiz (qayta yasamaymiz)
    raw_qr = ""
    if isinstance(qr_raw, str):
        raw_qr = qr_raw.strip()
    elif isinstance(extra, dict):
        raw_qr = str(extra.get("qr") or "").strip()
    if not raw_qr:
        raw_qr = str(parsed.get("qr") or "")
    rec = {
        "qr": raw_qr[:500] or parsed["qr"],
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
        if extra.get("qrSource"):
            rec["qrSource"] = str(extra.get("qrSource"))[:20]
        elif raw_qr:
            rec["qrSource"] = "scan"
        if extra.get("amount") not in (None, ""):
            amt = _to_som(extra.get("amount"))
            if amt and amt > 0:
                rec["amount"] = amt
        if extra.get("merchant"):
            rec["merchant"] = str(extra.get("merchant"))[:180]
    elif raw_qr:
        rec["qrSource"] = "scan"
    return {"ok": True, "rec": rec}
