# -*- coding: utf-8 -*-
"""VaksinaMed ichki yordamchi (AI support chat).

Faqat tizim bo'yicha savollar. OPENAI_API_KEY bo'lmasa — offline FAQ.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

# ── Muhit ──────────────────────────────────────────────────
_RATE = {}  # user_id -> [timestamps]
_RATE_LOCK = threading.Lock()
_MAX_PER_MIN = 12
_MAX_MSG = 4000
_MAX_IMAGE_B64 = 2_200_000  # ~1.6 MB raw
_MODEL = os.environ.get("OPENAI_SUPPORT_MODEL", "gpt-4o-mini").strip() or "gpt-4o-mini"
_API_URL = "https://api.openai.com/v1/chat/completions"

OFFTOPIC_REPLY = (
    "Bu savol yoki rasm VaksinaMed GPS / avtopark tizimiga tegishli emas. "
    "Men faqat shu tizimdagi sahifalar, tugmalar, GPS, yoqilg'i, haydovchi kabineti "
    "va admin panel haqida yordam beraman."
)

SYSTEM_RULES = """Siz — VaksinaMed Fleet Control (GPS VaksinaMed) ichki yordamchisiz.
Vazifa: foydalanuvchiga FAQAT shu tizimni tushuntirish.

QOIDALAR (majburiy):
1) Faqat VaksinaMed GPS/avtopark tizimi: Dashboard, Boshqaruv (fuel), Admin panel, Haydovchi kabineti, Profil, GPS, yoqilg'i, dorixona, jurnal.
2) Tizimdan tashqari mavzu (VHK, boshqa dastur, siyosat, umumiy suhbat, kod yozish, boshqa kompaniya) — qisqa rad eting: tizimga tegishli emas.
3) Skrinshot bo'lsa: ko'rinadigan tugma/maydonni aniqlang va shu tizimdagi vazifasini tushuntiring. Aniq bilmasangiz — taxmin ekanini ayting.
4) Parol, token, API kalit, shaxsiy ma'lumot so'ramang va oshkor qilmang.
5) Foydalanuvchi rolini hisobga oling: haydovchi faqat kabinet/profil; admin — Dashboard/Boshqaruv/Panel.
6) Javob o'zbek lotinida, aniq, qadam-baqadam. Keraksiz uzunlikdan qoching.
7) Tizim o'zgartirishni va'da qilmang — faqat mavjud funksiyani tushuntiring.
"""

# To'liq ichki qo'llanma — model kontekstiga beriladi
KNOWLEDGE = """
# VaksinaMed Fleet Control — ichki qo'llanma

## Umumiy
- Kirish: login.html — login + parol. Sessiyasiz sahifalar ochilmaydi.
- Rollar: Admin Pro (to'liq), Admin (dashboard/boshqaruv; panel huquqi bor), Haydovchi (faqat driver.html + profile.html).
- Brend: VaksinaMed Machine Control. Til: o'zbek lotin.

## Dashboard (index.html / bosh sahifa)
Maqsad: GPS kunlik kuzatuv, mashina holati, xarita, ball.
Asosiy elementlar:
- GPS yuklash / Ulanish: tanlangan kun uchun GPS (Boomerang/Wialon) dan ma'lumot tortish.
- Excel yuklash / Excel saqlash: GPS/hisobotni Excel orqali olish yoki saqlash.
- PDF: chop etish / PDF.
- Sozlamalar: lokal sozlamalar, JSON import/export, tozalash (ehtiyot!).
- Kalendar (< >): oy/kun tanlash.
- Jadval: mashinalar, km, reys, to'xtash, ball, muammolar.
- Xarita: yo'nalish, to'xtashlar; Yangilash — xaritani yangilaydi.
- GPS status: ULANGAN N/M — nechta mashina GPS dan kelgan.

## Boshqaruv (fuel.html)
Maqsad: yoqilg'i, spidometr, kunlik kiritish, hisobotlar, hujjatlar.
Chap menyu bo'limlari:
- Bosh sahifa: umumiy ko'rinish.
- Kunlik kiritish: mashina tanlash, norma/narx, kunlik jadval, Saqlash.
- Kun hisoboti / Oylik hisobot / Rasmiy hisobot / Yillik jamlanma: hisobotlar.
- Zapravka reestri: zapravka yozuvlari.
- Gaz akti: gaz hujjati.
- Hujjat muddatlari: muddat ogohlantirishlari.
- Haydovchilar jurnali: jurnal yozuvlari.
- Mashina va narx: park va narx sozlamalari.

Yuqori tugmalar:
- Oy tanlash (masalan Sentabr 2026).
- Excel yuklab olish: joriy ma'lumotni Excel ga.
- Excel to'ldirish: Excel dan oylik/kunlikni import.
- Zaxira saqlash / Zaxiradan tiklash: lokal zaxira.
- Asl ma'lumot: serverdagi asl holatga qaytarish (ehtiyot).

Kunlik kiritish maydonlari:
- Gaz/benzin-dizel normasi (100 km), spidometr oy boshi, oy boshi qoldiqlar, narxlar, aralashda gaz %.
- Yoqilg'i turi: Gaz+benzin, Dizel+gaz, Faqat gaz/benzin/dizel.
- Oldingi oydan qoldiqni yig'ish: oldingi oy oxiridagi qoldiqni olib kelish.
- Barchasini yangilash: hisoblarni yangilash.
- Spidometr bo'yicha kunlarni to'ldirish: spidometr ketma-ketligidan km.
- Norma/narx o'zgarishi: oy ichida norma yoki narx o'zgarganda.
- Haydovchini kun belgilab almashtirish: shofyor almashinuvi.
- GPS dan km: GPS yurgan masofani kunlarga yozish.
- Excel orqali to'ldirish: modal orqali .xlsx import.
- Saqlash: o'zgarishlarni saqlash (haydovchi yozolmaydi).

Kunlik jadval ustunlari: kun, yurgan masofa, gaz km, dizel/benzin km, spidometr, nimada yurdi, zapravka, olingan gaz/benzin, narx, summa, sarf, qoldiq, qo'shimcha.

## Haydovchi kabineti (driver.html)
- Faqat o'z mashinasi. O'zgartirish yo'q — faqat ko'rish.
- LIVE: avtomatik yangilanish (~1 daqiqa UI, GPS ~3 daqiqa).
- KPI: yurilgan km, ball, o'tkazib yuborilgan nuqtalar, qoidabuzarlik.
- Xarita: yo'nalish chizig'i + to'xtashlar (A/B va raqamlar).
- Yoqilg'i: rejim, km (boshqaruv), sarf, olingan, qoldiq (admin kiritganiga bog'liq).
- Sana tanlash: kun bo'yicha ko'rish.
- Mashina select yo'q (biriktirilgan mashina).

## Admin panel (admin.html)
- Admin qo'shish / Shofyor qo'shish.
- Kunlik vazifa (haydovchi kabinetida o'qiladi).
- Foydalanuvchilar: blok, parol, o'chirish.
- Kim tizimda: sessiyalar, chiqarish.
- O'z parolini almashtirish.
- Dorixona biriktirish: GPS joylaridan, radius.
- Geozonalarni o'rganish va qayta hisoblash.
- Telegram ogohlantirish: bot token + chat ID (maxfiy).

## Profil (profile.html)
- Hisob ma'lumotlari, tezkor havolalar, parolni almashtirish.
- Haydovchida faqat Kabinet + Profil menyu.

## Muhim eslatmalar
- GPS km va Boshqaruvdagi km farq qilishi mumkin (qo'lda kiritish / sync vaqti).
- Manfiy yoqilg'i qoldig'i — odatda oy boshi qoldiq yoki zapravka to'liq kiritilmagan.
- Haydovchi Excel/Saqlash/Admin paneldan foydalana olmaydi.
- Chiqish: Profil yoki Chiqish tugmasi.
"""

FAQ_OFFLINE = [
    {
        "keys": ["asl malumot", "asl ma'lumot", "asl ma lumot", "btn-reload"],
        "a": (
            "Asl ma'lumot (Boshqaruv) — serverdagi asl (saqlangan) ma'lumotni qayta yuklaydi. "
            "Siz lokalda o'zgartirgan, lekin Saqlash qilmagan yoki chalkashib ketgan o'zgarishlar yo'qolishi mumkin. "
            "Zaxira saqlash dan farq qiladi: zaxira — fayl nusxa; Asl ma'lumot — tizimdagi asosiy ma'lumotga qaytish. "
            "Ehtiyot: muhim o'zgarishlar bo'lsa avval Zaxira saqlash qiling."
        ),
    },
    {
        "keys": ["zaxira saqlash", "zaxiradan tiklash", "zaxira", "tiklash"],
        "a": (
            "Zaxira saqlash — joriy Boshqaruv ma'lumotidan nusxa oladi.\n"
            "Zaxiradan tiklash — shu nusxani qayta yuklaydi.\n"
            "Asl ma'lumot — serverdagi asl holatga qaytaradi (zaxiradan boshqacha)."
        ),
    },
    {
        "keys": [
            "boshqaruv tugma", "fuel.html", "excel yuklab", "excel toldirish",
            "gps dan km", "oldingi oydan", "barchasini yangilash",
        ],
        "a": (
            "Boshqaruv (yuqori/qator tugmalar):\n\n"
            "• Excel yuklab olish — eksport\n"
            "• Excel to'ldirish — Excel dan import\n"
            "• Zaxira saqlash / Zaxiradan tiklash — lokal nusxa\n"
            "• Asl ma'lumot — serverdagi asl ma'lumotni qayta yuklash (ehtiyot!)\n"
            "• GPS dan km — GPS masofasini kunlarga yozish\n"
            "• Saqlash — o'zgarishlarni saqlash\n"
            "• Oldingi oydan qoldiq / Barchasini yangilash / Spidometr to'ldirish — hisob yordamchilari"
        ),
    },
    {
        "keys": [
            "gps yuklash", "excel yuklash", "excel saqlash", "pdf",
            "sozlamalar", "deklarats", "dashboard tugma",
        ],
        "a": (
            "Dashboard yuqori tugmalari:\n\n"
            "1) GPS yuklash — tanlangan kun uchun GPS dan ma'lumot oladi.\n"
            "2) Excel yuklash — Excel import.\n"
            "3) Excel saqlash — Excel eksport.\n"
            "4) PDF — PDF / chop etish.\n"
            "5) Sozlamalar — tizim sozlamalari."
        ),
    },
    {
        "keys": [
            "tizim", "tzim", "tushuntir", "tushuntr", "umumiy",
            "toliq tizim", "to'liq tizim", "qanaqa tizim", "bu tizim",
        ],
        "a": (
            "VaksinaMed Fleet Control — avtopark GPS + yoqilg'i + haydovchi kabineti.\n\n"
            "1) Dashboard — kunlik GPS, ball, xarita\n"
            "2) Boshqaruv — yoqilg'i/kunlik/hisobot\n"
            "3) Haydovchi kabineti — o'z kuni (faqat ko'rish)\n"
            "4) Admin panel — foydalanuvchi, dorixona\n"
            "5) Profil — hisob/parol"
        ),
    },
    {
        "keys": ["kirish", "login", "parol", "sessiya"],
        "a": "Tizimga login.html orqali login va parol bilan kiriladi. Sessiyasiz Dashboard/Boshqaruv ochilmaydi. Parolni Profilda almashtirasiz.",
    },
    {
        "keys": ["dashboard", "gps sync", "ulanish", "kalendar"],
        "a": "Dashboardda GPS yuklash / Ulanish tanlangan kun uchun GPS dan ma'lumot oladi. Kalendar bilan kun/oy tanlang. Status ULANGAN N/M nechta mashina kelganini ko'rsatadi.",
    },
    {
        "keys": ["excel yuklash", "excel saqlash", "excel yuklab", "excel toldirish", "excel to'ldirish", "to'ldirish"],
        "a": "Dashboard: Excel yuklash - import, Excel saqlash - eksport. Boshqaruvda: Excel yuklab olish - eksport, Excel to'ldirish - import.",
    },
    {
        "keys": ["boshqaruv", "kunlik", "saqlash", "norma", "spidometr", "kunlik kiritish"],
        "a": "Boshqaruv - Kunlik kiritish: mashinani tanlang, norma/narx/qoldiqni to'ldiring, jadvalga kunlik km va zapravkani yozing, Saqlash bosing. GPS dan km GPS masofasini kunlarga yozadi.",
    },
    {
        "keys": ["gps dan km", "gpsdan"],
        "a": "GPS dan km tugmasi tanlangan oy/mashina uchun GPS yurgan masofani kunlik jadvalga yozishga yordam beradi. Keyin tekshirib Saqlash qiling.",
    },
    {
        "keys": ["haydovchi", "kabinet", "live", "xarita"],
        "a": "Haydovchi kabineti faqat o'z kunini ko'rsatadi (LIVE yangilanadi). Xaritada yo'nalish va to'xtashlar bor. Ma'lumotni o'zgartirish mumkin emas - admin Boshqaruvdan kiritadi.",
    },
    {
        "keys": ["admin", "panel", "shofyor", "dorixona", "telegram"],
        "a": "Admin panelda foydalanuvchi/haydovchi yaratish, vazifa, dorixona biriktirish, geozona, Telegram sozlamalari bor. Haydovchi bu panelni ko'rmaydi.",
    },
    {
        "keys": ["profil", "chiqish"],
        "a": "Profil da hisob ma'lumoti va parol almashtirish bor. Chiqish sessiyani yopadi.",
    },
    {
        "keys": ["qoldiq", "manfiy", "sarf"],
        "a": "Manfiy gaz/benzin qoldig'i odatda oy boshi qoldiq yoki zapravka to'liq kiritilmaganidan chiqadi. Kunlik kiritishda qoldiq va olingan yoqilg'ini tekshiring.",
    },
]

PAGE_BUTTON_GUIDE = {
    "fuel.html": (
        "Siz Boshqaruv sahifasidasiz. Asosiy tugmalar:\n\n"
        "• Excel yuklab olish / Excel to'ldirish — eksport va import\n"
        "• Zaxira saqlash / Zaxiradan tiklash — nusxa olish/qaytarish\n"
        "• Asl ma'lumot — serverdagi asl ma'lumotni qayta yuklash (saqlanmagan o'zgarishlar yo'qolishi mumkin)\n"
        "• GPS dan km — GPS masofasini kunlarga yozish\n"
        "• Saqlash — o'zgarishlarni saqlash\n\n"
        "Aniq tugma nomini yozsangiz (masalan: Asl ma'lumot), shu tugmani batafsil tushuntiraman."
    ),
    "index.html": (
        "Siz Dashboarddasiz. Yuqori tugmalar: GPS yuklash, Excel yuklash, Excel saqlash, PDF, Sozlamalar.\n"
        "Aniq tugma nomini yozing — batafsil aytaman."
    ),
    "admin.html": (
        "Admin panel: foydalanuvchi/haydovchi qo'shish, vazifa, dorixona, geozona, Telegram, Chiqish.\n"
        "Qaysi bo'lim kerak?"
    ),
    "driver.html": (
        "Haydovchi kabineti: sana, LIVE, KPI, xarita, yoqilg'i — faqat ko'rish. O'zgartirish yo'q."
    ),
    "profile.html": (
        "Profil: hisob ma'lumoti va parolni almashtirish, Chiqish."
    ),
}


def load_dotenv(path: str | None = None) -> None:
    """Oddiy .env o'qish (paketsiz). Mavjud env ni ustiga yozmaydi."""
    base = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.isfile(base):
        return
    try:
        with open(base, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except OSError:
        pass


def openai_key() -> str:
    return (os.environ.get("OPENAI_API_KEY") or "").strip()


def ai_enabled() -> bool:
    return bool(openai_key())


def _rate_ok(uid: str) -> tuple[bool, str]:
    now = time.time()
    with _RATE_LOCK:
        arr = [t for t in _RATE.get(uid, []) if now - t < 60]
        if len(arr) >= _MAX_PER_MIN:
            return False, "Juda ko'p so'rov. 1 daqiqadan keyin qayta urinib ko'ring."
        arr.append(now)
        _RATE[uid] = arr
    return True, ""


def _norm(s: str) -> str:
    s = (s or "").lower().replace("ʻ", "'").replace("'", "'")
    s = re.sub(r"\s+", " ", s)
    return s


def _has_system_signal(t: str) -> bool:
    """Savol VaksinaMed tizimiga tegishlimi (kalit so'zlar)."""
    good = (
        "gps", "dashboard", "boshqaruv", "haydovchi", "kabinet", "yoqilg",
        "zapravka", "spidometr", "dorixona", "admin", "panel", "excel",
        "xarita", "mashina", "tugma", "profil", "login", "vaksina",
        "tizim", "tzim", "avtopark", "fleet", "ball", "kunlik", "oylik",
        "spidometr", "yordamchi", "geozona", "reja", "reys", "toxtash",
        "to'xtash", "saqlash", "hisobot", "jornal", "jurnal", "gaz",
        "benzin", "dizel", "norma", "narx", "skrin", "screenshot",
    )
    return any(g in t for g in good)


def looks_offtopic(text: str) -> bool:
    t = _norm(text)
    if not t or len(t) < 2:
        return False
    # Tizim haqida so'rov (hatto ichida 'vhk' bo'lsa ham) — ON-TOPIC
    if _has_system_signal(t):
        return False
    # Faqat tashqi mavzu
    bad = (
        "vhk", "1c ", "1с", "telegram bot yoz", "kripto", "bitcoin",
        "siyosat", "futbol", "retsept", "dori yoz", "homework", "python dars",
    )
    return any(b in t for b in bad)


def offline_answer(message: str, role: str, page: str = "", has_image: bool = False) -> str:
    if looks_offtopic(message):
        return OFFTOPIC_REPLY
    t = _norm(message).replace("'", "")
    pg = _norm(page or "").replace("'", "")
    if "fuel" in pg:
        page_key = "fuel.html"
    elif "admin" in pg:
        page_key = "admin.html"
    elif "driver" in pg:
        page_key = "driver.html"
    elif "profile" in pg:
        page_key = "profile.html"
    else:
        page_key = "index.html"

    # Salom / qisqa
    if t in ("salom", "hello", "hi", "assalom", "assalomu alaykum"):
        return "Salom! Qaysi tugma yoki sahifa kerak?"

    # Aniq tugma nomi — uzun kalit ustun
    best = None
    best_score = 0
    for item in FAQ_OFFLINE:
        score = 0
        for k in item["keys"]:
            kn = _norm(k).replace("'", "")
            if kn and kn in t:
                score += 2 + min(8, len(kn) // 3)
        if score > best_score:
            best_score = score
            best = item

    # Umumiy "bu tugma nima" + skrin/sahifa
    vague = any(x in t for x in ("tugma", "tugmacha", "tugmachi", "vazifa", "nima qil", "bu nima"))
    if best_score < 4 and (vague or has_image or not t):
        guide = PAGE_BUTTON_GUIDE.get(page_key)
        if guide:
            return guide

    if best and best_score > 0:
        extra = ""
        if role == "driver":
            extra = "\n\nSiz haydovchisiz: faqat kabinet va profil."
        return best["a"] + extra

    if page_key in PAGE_BUTTON_GUIDE and (vague or has_image):
        return PAGE_BUTTON_GUIDE[page_key]

    return (
        "Qaysi tugma yoki sahifa? Masalan: Asl ma'lumot, GPS dan km, GPS yuklash."
    )


def _parse_image(data_url: str | None) -> tuple[str | None, str | None]:
    if not data_url:
        return None, None
    s = str(data_url).strip()
    if not s.startswith("data:image/"):
        return None, "Rasm formati noto'g'ri (faqat PNG/JPEG/WebP)."
    try:
        header, b64 = s.split(",", 1)
    except ValueError:
        return None, "Rasm o'qilmadi."
    mime = "image/jpeg"
    if "image/png" in header:
        mime = "image/png"
    elif "image/webp" in header:
        mime = "image/webp"
    elif "image/jpeg" in header or "image/jpg" in header:
        mime = "image/jpeg"
    else:
        return None, "Faqat PNG, JPEG yoki WebP."
    b64 = re.sub(r"\s+", "", b64)
    if len(b64) > _MAX_IMAGE_B64:
        return None, "Rasm juda katta. Kichikroq skrin yuboring."
    return f"data:{mime};base64,{b64}", None


def _openai_chat(messages: list, timeout: int = 60) -> tuple[str | None, str | None]:
    key = openai_key()
    if not key:
        return None, "AI sozlanmagan (OPENAI_API_KEY)."
    payload = {
        "model": _MODEL,
        "temperature": 0.2,
        "max_tokens": 900,
        "messages": messages,
    }
    raw = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        _API_URL,
        data=raw,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
            "User-Agent": "VaksinaMed-Support/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            err_body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            err_body = str(e.reason)
        return None, f"AI xato HTTP {e.code}: {err_body}"
    except Exception as e:
        return None, f"AI ulanish xatosi: {str(e)[:160]}"
    try:
        text = data["choices"][0]["message"]["content"]
        return (text or "").strip(), None
    except (KeyError, IndexError, TypeError):
        return None, "AI javobi o'qilmadi."


def answer_support(
    *,
    message: str,
    role: str = "",
    page: str = "",
    image_data_url: str | None = None,
    history: list | None = None,
    user_id: str = "anon",
) -> dict:
    """Asosiy kirish nuqtasi. {"ok", "reply", "mode", "error?"}"""
    msg = (message or "").strip()
    if not msg and not image_data_url:
        return {"ok": False, "error": "Savol yoki skrin yuboring."}
    if len(msg) > _MAX_MSG:
        return {"ok": False, "error": f"Savol juda uzun (max {_MAX_MSG})."}

    ok_rl, rl_err = _rate_ok(str(user_id or "anon"))
    if not ok_rl:
        return {"ok": False, "error": rl_err}

    img, img_err = _parse_image(image_data_url)
    if img_err:
        return {"ok": False, "error": img_err}

    if looks_offtopic(msg) and not img:
        return {"ok": True, "reply": OFFTOPIC_REPLY, "mode": "guard"}

    role = (role or "").strip() or "user"
    page = (page or "").strip()[:120]

    if not ai_enabled():
        reply = offline_answer(msg or "", role, page, has_image=bool(img))
        return {"ok": True, "reply": reply, "mode": "offline"}

    # AI yo'li
    sys = SYSTEM_RULES + "\n\n# BILIM BAZASI\n" + KNOWLEDGE
    sys += f"\n\nFoydalanuvchi roli: {role}. Joriy sahifa: {page or 'nomalum'}."

    messages = [{"role": "system", "content": sys}]
    # Qisqa tarix (faqat matn)
    for h in (history or [])[-12:]:
        if not isinstance(h, dict):
            continue
        r = h.get("role")
        c = str(h.get("content") or "").strip()[:1200]
        if r in ("user", "assistant") and c:
            messages.append({"role": r, "content": c})

    user_content: list | str
    if img:
        parts = []
        parts.append({
            "type": "text",
            "text": msg or "Bu skrinshotdagi tugma yoki element nima qiladi? VaksinaMed tizimi bo'yicha tushuntiring.",
        })
        parts.append({"type": "image_url", "image_url": {"url": img}})
        user_content = parts
    else:
        user_content = msg

    messages.append({"role": "user", "content": user_content})
    text, err = _openai_chat(messages)
    if err:
        # Yumshoq fallback
        fb = offline_answer(msg or "", role, page, has_image=bool(img))
        return {"ok": True, "reply": fb, "mode": "fallback"}
    return {"ok": True, "reply": text, "mode": "ai"}


def status_payload() -> dict:
    return {
        "ok": True,
        "ai": ai_enabled(),
        "model": _MODEL if ai_enabled() else None,
        "vision": ai_enabled(),
        "offlineFaq": True,
    }
