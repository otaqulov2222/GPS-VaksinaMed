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

from support_knowledge import FAQ_OFFLINE, KNOWLEDGE, PAGE_BUTTON_GUIDE

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
Vazifa: foydalanuvchiga FAQAT shu tizimni o'rgatish — hatto eng mayda tugma/qadam ham.

QOIDALAR (majburiy):
1) Faqat VaksinaMed: Dashboard, Boshqaruv, Davomat, Live, Admin, Haydovchi kabineti, Profil, GPS, yoqilg'i, QR ofis.
2) Tizimdan tashqari mavzu — qisqa rad eting.
3) Skrinshot: ko'rinadigan tugma/maydonni aniqlang va vazifasini aniq tushuntiring.
4) Parol/token/API kalit so'ramang. Admin panelda foydalanuvchi parollari boshqaruv uchun ko'rinadi.
5) «Qanday…?» savollarga 1) 2) 3) qadamlar bilan, menyu yo'li bilan javob bering (masalan: Profil → Admin panel → Dorixona biriktirish).
6) Mayda savollar ham muhim: bitta tugma, checkbox, jadval ustuni, filter — nima qilishini ayting.
7) Bilim + FAQ dagi nomlarga amal qiling (Excel yuklash ≠ Excel saqlash; Asl ≠ Zaxira; GPS yuklash ≠ GPS dan km).
8) Rol: haydovchi — kabinet/profil/davomat (o'zgartirish yo'q); admin — to'liq.
9) Javob o'zbek lotinida, aniq, professional. Tizim o'zgartirishni va'da qilmang.
10) Bilmasangiz — yaqin bo'limni ayting va qaysi tugma nomini yozishni so'rang.
"""


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
        "yordamchi", "geozona", "reja", "reys", "toxtash", "to'xtash",
        "saqlash", "hisobot", "jornal", "jurnal", "gaz", "benzin", "dizel",
        "norma", "narx", "skrin", "screenshot", "rasmiy", "yillik", "hujjat",
        "zaxira", "asl", "ulanish", "ruxsat", "qoidabuzar", "telegram",
        "shofyor", "sessiya", "kalendar", "marshrut", "pdf", "csv",
        "jamlanma", "reestr", "topshiriq", "vazifa", "chip",
        "biriktir", "radius", "boomerang", "bumarang", "tezlik", "vaqt",
        "davomat", "face", "keldim", "ketdim", "live", "qr", "ofis",
        "sklad", "nuqta", "muammo", "yangilash", "zoom", "legenda",
        "qanday", "qanaqa", "qayer", "qaysi", "nima",
    )
    return any(g in t for g in good)


def looks_offtopic(text: str) -> bool:
    t = _norm(text)
    if not t or len(t) < 2:
        return False
    if _has_system_signal(t):
        return False
    # «qanday» + tizim konteksti yo'q — lekin faqat qanday yozilsa offtopic emas
    if t in ("qanday", "qanaqa", "nima", "yordam", "help"):
        return False
    bad = (
        "vhk", "1c ", "1с", "telegram bot yoz", "kripto", "bitcoin",
        "siyosat", "futbol", "retsept", "dori yoz", "homework", "python dars",
    )
    return any(b in t for b in bad)


def _stem(w: str) -> str:
    """Oddiy o'zbek fe'l/ot ildizi (biriktiradi → biriktir)."""
    s = (w or "").strip()
    if len(s) < 5:
        return s
    for suf in (
        "amanmi", "asizmi", "adi", "aman", "asiz", "ishni", "ishga",
        "moqda", "moq", "ish", "lar", "ning", "dan", "ga", "ni", "da",
    ):
        if s.endswith(suf) and len(s) - len(suf) >= 4:
            return s[: -len(suf)]
    return s


def _part_in_text(part: str, text: str) -> bool:
    """Kalit qismi matnda yoki so'z ildizida (biriktir → biriktiradi)."""
    if not part or not text:
        return False
    if part in text:
        return True
    ps = _stem(part)
    if len(ps) >= 4 and ps in text:
        return True
    if len(part) < 4:
        return False
    for w in re.findall(r"[a-z0-9ʻ']+", text):
        if len(w) < 4:
            continue
        ws = _stem(w)
        if ps and (ws.startswith(ps[:5]) or ps.startswith(ws[:5]) or ws == ps):
            return True
        if w.startswith(part) or part.startswith(w):
            return True
    return False


def _page_key(page: str) -> str:
    pg = _norm(page or "").replace("'", "")
    if "fuel" in pg:
        return "fuel.html"
    if "admin" in pg:
        return "admin.html"
    if "driver" in pg:
        return "driver.html"
    if "profile" in pg:
        return "profile.html"
    if "attendance" in pg or "davomat" in pg:
        return "attendance.html"
    return "index.html"


def _faq_score(item: dict, text: str) -> int:
    """Uzun/aniq kalit ustun. So'zma-so'z va ildiz moslik ham hisoblanadi."""
    if not text:
        return 0
    score = 0
    for k in item.get("keys") or []:
        kn = _norm(k).replace("'", "")
        if not kn or len(kn) < 2:
            continue
        if kn in text:
            score += 4 + min(14, len(kn) // 2)
            continue
        parts = [p for p in kn.split() if len(p) > 2]
        if len(parts) >= 2 and all(_part_in_text(p, text) for p in parts):
            score += 3 + len(parts) * 2
        elif len(parts) == 1 and _part_in_text(parts[0], text) and len(parts[0]) >= 5:
            score += 2
        elif len(parts) >= 2:
            hit = sum(1 for p in parts if _part_in_text(p, text))
            if hit >= 2:
                score += 2 + hit
    return score


def _faq_pack_for_ai(limit: int = 80) -> str:
    """AI ga barcha FAQ ni qisqa paket qilib berish."""
    chunks = []
    for i, item in enumerate(FAQ_OFFLINE):
        if i >= limit:
            break
        ans = (item.get("a") or "").strip()
        if not ans:
            continue
        keys = ", ".join((item.get("keys") or [])[:6])
        chunks.append(f"### {keys}\n{ans}")
    return "\n\n".join(chunks)


def _role_note(role: str) -> str:
    if (role or "").strip() == "driver":
        return "\n\nSiz haydovchisiz: faqat kabinet va profil (o'zgartirish yo'q)."
    return ""


def _known_terms() -> list[str]:
    """FAQ kalitlaridan uzunlik bo'yicha tartiblangan atamalar."""
    terms = set()
    for item in FAQ_OFFLINE:
        for k in item.get("keys") or []:
            kn = _norm(k).replace("'", "")
            if kn and len(kn) >= 4:
                terms.add(kn)
    # Nav / UI qisqa nomlar
    for extra in (
        "profil", "dashboard", "boshqaruv", "kabinet", "panel", "admin",
        "chiqish", "kirish", "menyu", "live", "ulanis", "ulanish",
    ):
        terms.add(extra)
    return sorted(terms, key=len, reverse=True)


def _extract_known_from_text(text: str) -> str:
    """Skrin/OCR matnidan eng uzun mos UI atamasini topish."""
    t = _norm(text or "").replace("'", "")
    if not t:
        return ""
    for term in _known_terms():
        if term in t:
            return term
    return ""


def offline_answer(
    message: str,
    role: str,
    page: str = "",
    has_image: bool = False,
    ui_labels=None,
    active_label: str = "",
    image_text: str = "",
) -> str:
    if looks_offtopic(message):
        return OFFTOPIC_REPLY
    t = _norm(message).replace("'", "")
    page_key = _page_key(page)
    act = _norm(active_label or "").replace("'", "")
    img_t = _norm(image_text or "").replace("'", "")
    labels_t = _norm(" ".join(str(x) for x in (ui_labels or [])[:40])).replace("'", "")
    # Skrin matni + sahifa yorliqlari — qidiruv uchun birlashtiriladi
    ctx = " ".join(x for x in (t, img_t, labels_t) if x).strip()
    from_img = _extract_known_from_text(img_t) if img_t else ""
    from_msg = _extract_known_from_text(t) if t else ""
    from_ctx = _extract_known_from_text(ctx) if ctx else ""
    named = from_img or from_msg or from_ctx

    vague = (not t and has_image) or any(
        x in t
        for x in (
            "tugma", "tugmacha", "tugmachi", "vazifa", "nima qil",
            "bu nima", "ushbu", "nima degani", "nima uchun", "qanday ishlaydi",
            "ichida", "ichi ", " nima bor", "nimalar bor", "bajaradi",
            "haqida", "malumot", "ma'lumot", "skrin", "screenshot", "rasm",
            "tushuntir", "yordam", "qanday", "qanaqa", "qayerdan", "qaysi",
            "o'rgat", "orgat", "ko'rsat", "korsat",
        )
    )
    howto = any(x in t for x in ("qanday", "qanaqa", "qayerdan", "qilib", "qadam"))

    if t in ("salom", "hello", "hi", "assalom", "assalomu alaykum"):
        return (
            "Salom! Men VaksinaMed yordamchisiman.\n"
            "Istalgan savol: tugma, bo'lim yoki «qanday …?» (masalan: dorixonani mashinaga qanday biriktiraman).\n"
            "Skrin yoki tezkor chip ham ishlaydi."
        )

    best = None
    best_score = 0
    best_msg = 0
    for item in FAQ_OFFLINE:
        if not (item.get("a") or "").strip():
            continue
        s_named = _faq_score(item, named) if named else 0
        s_msg = _faq_score(item, t)
        s_img = _faq_score(item, img_t) if img_t else 0
        s_ctx = _faq_score(item, ctx) if ctx and ctx != t else 0
        s_act = 0
        if act and not named and (vague or has_image):
            s_act = _faq_score(item, act)
        # Skrin OCR / kontekst — kuchliroq; how-to savollarga biroz bonus
        score = s_named * 12 + s_msg * 3 + s_img * 8 + s_ctx * 4 + s_act
        if howto and s_msg >= 3:
            score += 4
        if score > best_score:
            best_score = score
            best_msg = max(s_msg, s_img, s_ctx)
            best = item

    # 1) Nom aniq (Profil, Oylik hisobot, kunlik ball…)
    if named and best and best_score >= 5:
        return best["a"] + _role_note(role)

    # 2) Savol yoki skrin matnida kalitlar yetarli
    if best and best_msg >= 4:
        return best["a"] + _role_note(role)

    # 2b) «Qanday …?» — biroz pastroq chegarada ham to'liq FAQ
    if howto and best and best_msg >= 2 and best_score >= 6:
        return best["a"] + _role_note(role)

    # 3) Skrin + noaniq — FAQ zaif bo'lsa ham eng yaxshi javob
    if has_image and best and best_score >= 8:
        return best["a"] + _role_note(role)

    if has_image and vague and not named:
        if best and best_score >= 5:
            return best["a"] + _role_note(role)
        guide = PAGE_BUTTON_GUIDE.get(page_key, "")
        return (
            "Skrinda aniq tugma nomini ajrata olmadim, lekin siz shu sahifadasiz:\n\n"
            + (guide or "Tugma yoki bo'lim nomini yozing (masalan: Kunlik ball, GPS yuklash).")
        )

    # 4) Noaniq savol — sahifa qo'llanmasi
    if vague and not named:
        if best and best_score >= 5:
            return best["a"] + _role_note(role)
        guide = PAGE_BUTTON_GUIDE.get(page_key)
        if guide:
            return guide

    if best and best_score > 0:
        return best["a"] + _role_note(role)

    guide = PAGE_BUTTON_GUIDE.get(page_key)
    if guide:
        return guide

    return (
        "Qaysi tugma yoki bo'lim? Masalan: Kunlik ball, GPS yuklash, Oylik hisobot, Profil."
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
        "max_tokens": 1400,
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
    ui_labels=None,
    active_label: str = "",
    image_text: str = "",
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
    labels = ui_labels if isinstance(ui_labels, list) else []
    labels = [str(x)[:80] for x in labels[:40]]
    active = str(active_label or "").strip()[:60]
    img_txt = str(image_text or "").strip()[:500]

    offline_kw = dict(
        role=role,
        page=page,
        has_image=bool(img),
        ui_labels=labels,
        active_label=active,
        image_text=img_txt,
    )

    if not ai_enabled():
        reply = offline_answer(msg or "", **offline_kw)
        return {"ok": True, "reply": reply, "mode": "offline"}

    # Kuchli FAQ hit — AI dan oldin aniq qadamli javob (dorixona biriktirish va h.k.)
    t_check = _norm(msg).replace("'", "")
    best_item = None
    best_sc = 0
    for item in FAQ_OFFLINE:
        if not (item.get("a") or "").strip():
            continue
        sc = _faq_score(item, t_check)
        if sc > best_sc:
            best_sc = sc
            best_item = item
    if best_item and best_sc >= 8:
        return {
            "ok": True,
            "reply": best_item["a"] + _role_note(role),
            "mode": "faq",
        }

    # AI yo'li — to'liq FAQ paketi bilan
    sys = SYSTEM_RULES + "\n\n# BILIM BAZASI\n" + KNOWLEDGE
    sys += "\n\n# FAQ (batafsil qadamlar)\n" + _faq_pack_for_ai()
    sys += f"\n\nFoydalanuvchi roli: {role}. Joriy sahifa: {page or 'nomalum'}."
    if active:
        sys += f"\nAktiv bo'lim/tugma: {active}."
    if img_txt:
        sys += f"\nSkrindan o'qilgan matn: {img_txt}"
    if labels:
        sys += "\nSahifadagi asosiy yorliqlar: " + ", ".join(labels[:25]) + "."
    sys += (
        "\nJavobda menyu yo'lini yozing (masalan: Profil → Admin panel → Dorixona biriktirish). "
        "Mayda savollarga ham aniq javob bering."
    )
    messages = [{"role": "system", "content": sys}]
    for h in (history or [])[-12:]:
        if not isinstance(h, dict):
            continue
        r = h.get("role")
        c = str(h.get("content") or "").strip()[:1200]
        if r in ("user", "assistant") and c:
            messages.append({"role": r, "content": c})

    user_content: list | str
    if img:
        hint = msg or "Bu skrinshotdagi tugma yoki element nima qiladi? Ichidagilarini ham ayting."
        if img_txt:
            hint += f"\n(Skrin matni: {img_txt})"
        parts = [
            {"type": "text", "text": hint},
            {"type": "image_url", "image_url": {"url": img}},
        ]
        user_content = parts
    else:
        user_content = msg

    messages.append({"role": "user", "content": user_content})
    text, err = _openai_chat(messages)
    if err:
        fb = offline_answer(msg or "", **offline_kw)
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
