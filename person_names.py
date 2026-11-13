"""Haydovchi F.I.O. — buyruq qo'shimchalari (-га, o'g'li) ni tozalash."""

import re

_PATRONYMIC_RAW = (
    "ogli",
    "og'li",
    "o'g'li",
    "o`g`li",
    "oʻgʻli",
    "ogliga",
    "og'liga",
    "o'g'liga",
    "oʻgʻliga",
    "угли",
    "углы",
    "ўғли",
    "ўғлига",
    "qizi",
    "qiziga",
    "кизи",
    "қизи",
    "қизига",
    "кызы",
)


def person_token_key(tok):
    t = str(tok or "").strip().lower().replace("ʼ", "'").replace("‘", "'").replace("’", "'")
    t = t.replace("ʻ", "'").replace("`", "'")
    t = re.sub(r"(га|ga|ни|ning|нинг)$", "", t)
    t = t.replace("o'", "o").replace("g'", "g").replace("'", "")
    return t


_PATRONYMIC_KEYS = frozenset(person_token_key(x) for x in _PATRONYMIC_RAW) | frozenset(
    str(x).lower() for x in _PATRONYMIC_RAW
)


def is_patronymic_token(tok):
    raw = str(tok or "").strip().lower()
    if not raw:
        return False
    if raw in _PATRONYMIC_KEYS:
        return True
    k = person_token_key(tok)
    return bool(k) and k in _PATRONYMIC_KEYS


def normalize_person_name(name):
    """Buyruqdagi '-га' va ortiqcha o'g'li/qizi ni tozalash."""
    s = re.sub(r"\s+", " ", str(name or "").strip())
    if not s:
        return ""
    parts = s.split(" ")
    last = parts[-1]
    # Faqat kirill dative '-га' (lotin 'ga' ni olib tashlamaymiz — SGA/калит buziladi).
    # 'ўғлига' / o'g'liga allaqachon patronymic ro'yxatida.
    if re.search(r"га$", last):
        cleaned = re.sub(r"га$", "", last)
        if cleaned:
            parts[-1] = cleaned
    while parts and is_patronymic_token(parts[-1]):
        parts.pop()
    return " ".join(parts).strip() or s


def short_from_person_name(name):
    """Qisqa ism: boshidagi so'z (familiya/ism) — oxiridagi o'g'li emas."""
    norm = normalize_person_name(name)
    parts = [p for p in norm.split() if p and not is_patronymic_token(p)]
    if not parts:
        parts = [p for p in str(name or "").split() if p and not is_patronymic_token(p)]
    if parts:
        return parts[0][:40]
    return str(name or "").strip()[:40]
