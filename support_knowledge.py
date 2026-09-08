# -*- coding: utf-8 -*-
"""VaksinaMed Yordamchi — to'liq bilim bazasi (FAQ + sahifa qo'llanmalari)."""

KNOWLEDGE = """
# VaksinaMed Fleet Control — to'liq ichki qo'llanma

## Umumiy navigatsiya
- Login (login.html): login + parol → Kirish. Rollar: Admin Pro, Admin, Haydovchi.
- Staff menyu: Dashboard | Boshqaruv | Profil. Admin panelga Profil → Admin panel orqali.
- Haydovchi menyu: Kabinet | Profil.
- Yordamchi (pastdagi chat): tizim tugmalari/bo'limlari haqida savol + skrin.

## Dashboard (index.html)
Maqsad: kunlik GPS kuzatuv, ball, xarita, to'xtashlar.
Yuqori: GPS yuklash, Excel yuklash, Excel saqlash, PDF, Sozlamalar.
Chap: Kalendar (oy < > , kun tanlash); GPS tizimi → Ulanish/Yangilash.
Markaz: haydovchi kartasi; Kunlik ball (katta raqam); marshrut xaritasi; to'xtashlar; Barcha mashinalar jadvali.
To'xtash qatorida: Ruxsat | Qoidabuzarlik | Bekor — baholash.
GPS modal: sana, Kecha/Bugun, server/login/parol/token, Shu kunni yuklash.
Sozlamalar: norma jadvali, JSON saqlash/yuklash, Tozalash, Saqlash.

## Boshqaruv (fuel.html)
Chap bo'limlar:
- Bosh sahifa — oy KPI + GPS bor lekin kunlik km tushmagan jadval
- Kunlik kiritish — asosiy kiritish
- Kun hisoboti — 1 kun, barcha mashinalar (+ kun pillari, PDF)
- Oylik hisobot — oy jami; qator → kunma-kun; PDF jami+kunma-kun
- Rasmiy hisobot — firma maydonlari + PDF + Shablon Excel
- Yillik jamlanma — yil oylari + PDF
- Zapravka reestri — stansiya/zapravka + filter + PDF
- Gaz akti — gaz hujjati + PDF
- Hujjat muddatlari — sug'urta/texnik/reklama/gaz ballon + Yangilash
- Haydovchilar jurnali — kamchilik/maktov, filtr, CSV/Excel/PDF
- Mashina va narx — park, narx, qo'shish/saqlash/o'chirish

Yuqori: Oy tanlov, Excel yuklab olish, Excel to'ldirish, Zaxira saqlash, Zaxiradan tiklash, Asl ma'lumot.
Kunlik asboblar: Oldingi oydan qoldiq, Barchasini yangilash, Spidometr to'ldirish, Norma/narx o'zgarishi, Haydovchini kun belgilab almashtirish, GPS dan km, Excel orqali to'ldirish, Saqlash.

## Haydovchi kabineti (driver.html)
Faqat ko'rish. Sana, LIVE (bugun avto-yangilanish), KPI, xarita, yoqilg'i, topshiriqlar/dorixona, to'xtashlar, jurnal.

## Admin (admin.html)
Admin/Shofyor qo'shish, kunlik vazifa, foydalanuvchilar (blok/parol/o'chirish/ko'rish), sessiyalar (Chiqarish), o'z paroli, dorixona biriktirish, GPS joylarini yangilash, geozona o'rganish, Telegram (pro), audit jurnal, Chiqish.

## Profil
Hisob, tezkor havolalar, parol almashtirish, Chiqish.
"""

# Har bir yozuv: keys (qidiruv) + a (javob). Uzun/aniq kalitlar ballda ustun.
FAQ_OFFLINE = [
    # ── Boshqaruv: hisobotlar ──
    {
        "keys": ["oylik hisobot", "oylik jamlanma", "month report", "pdf jami", "kunma-kun", "kunmakun"],
        "a": (
            "Oylik hisobot (Boshqaruv → chap menyu):\n"
            "• Oy bo'yicha barcha mashinalar jamlanma jadvali (probeg, gaz/benzin km, olingan yoqilg'i, xarajat, qoldiq).\n"
            "• Har mashina — 1 qator (oy jami). Qatorga bossangiz — shu mashinaning kunma-kun jadvali ochiladi (yana bossangiz yopiladi).\n"
            "• PDF (jami + kunma-kun) — avval umumiy jami, keyin har mashina uchun kunma-kun sahifalar.\n\n"
            "Farqi: Kun hisoboti = bitta kun, barcha mashinalar. Oylik = butun oy, mashina bo'yicha."
        ),
    },
    {
        "keys": ["kun hisoboti", "kunlik hisobot", "dayrep", "kun pill"],
        "a": (
            "Kun hisoboti — tanlangan BITTA kun uchun barcha mashinalar.\n"
            "• Yuqoridagi kun raqamlari (1…31) bilan kunni almashtirasiz.\n"
            "• PDF yuklab olish — shu kun hisobotini PDF qiladi.\n"
            "Oylik hisobotdan farqi: oylik — butun oy jamlanmasi."
        ),
    },
    {
        "keys": ["kunlik kiritish", "kunlik jadval", "kunlik kirit"],
        "a": (
            "Kunlik kiritish — asosiy yoqilg'i/km kiritish bo'limi.\n"
            "1) Mashina chipini tanlang\n"
            "2) Norma, spidometr oy boshi, qoldiq, narx, yoqilg'i turini tekshiring\n"
            "3) Jadvalga kunlik km, zapravka, izoh yozing\n"
            "4) Kerak bo'lsa: GPS dan km / Excel to'ldirish / Spidometr to'ldirish\n"
            "5) Saqlash — serverga yoziladi\n"
            "Haydovchi bu yerdan o'zgartira olmaydi."
        ),
    },
    {
        "keys": ["rasmiy hisobot", "rasmiy oylik", "shablon excel", "firma", "direktor", "mexanik"],
        "a": (
            "Rasmiy hisobot — imzo/firma maydonlari bilan rasmiy oylik yoqilg'i hisoboti.\n"
            "• Firma, Direktor, Mexanik maydonlari avtomatik saqlanadi (meta).\n"
            "• PDF yuklab olish — rasmiy PDF.\n"
            "• Shablon Excel — oylik shablon Excel (exportExcel)."
        ),
    },
    {
        "keys": ["yillik jamlanma", "yillik hisobot", "yil jamlanma"],
        "a": "Yillik jamlanma — tanlangan yil bo'yicha oylar kesimida jamlanma KPI va jadval. PDF yuklab olish — yillik PDF.",
    },
    {
        "keys": ["zapravka reestri", "zapravka", "stansiya", "faqat gaz", "faqat benzin"],
        "a": (
            "Zapravka reestri — zapravka/stansiya yozuvlari.\n"
            "• Qo'shish — yangi stansiya\n"
            "• Filter: Hammasi / Faqat gaz / Faqat benzin-dizel\n"
            "• Qatordagi O'chirish — stansiyani olib tashlash\n"
            "• PDF — reestr PDF"
        ),
    },
    {
        "keys": ["gaz akti", "gaz hujjat"],
        "a": "Gaz akti — gaz bo'yicha akt/hujjat jadvali. PDF yuklab olish bilan chiqariladi.",
    },
    {
        "keys": [
            "hujjat muddat", "hujjatlar", "sugurta", "sug'urta", "texnik korik",
            "texnik ko'rik", "reklama", "gaz ballon", "hujjat yangilash",
        ],
        "a": (
            "Hujjat muddatlari — har mashina uchun muddatlar:\n"
            "Sug'urta, Texnik ko'rik, Reklama, Gaz ballon sinovi.\n"
            "• Yuqoridagi «N hujjat muddati» badge shu bo'limga olib boradi.\n"
            "• Yangilash — muddatni oldinga suradi (yangilandi deb belgilash).\n"
            "Muddati yaqinlashganda ogohlantirish chiqadi."
        ),
    },
    {
        "keys": [
            "haydovchilar jurnali", "jurnal", "kamchilik", "maktov", "yutuq",
            "jurnal csv", "jurnal excel", "jurnal pdf",
        ],
        "a": (
            "Haydovchilar jurnali (Boshqaruv):\n"
            "• Tur: Kamchilik yoki Maktov/yutuq; kategoriya: Haydovchi / Dorixona\n"
            "• Hozir — vaqtni hozirgi ga qo'yadi\n"
            "• Qo'shish / O'zgarishni saqlash / Bekor\n"
            "• Filtr: Kun/Hafta/Oy/Yil/Oraliq/Barchasi; Hammasi/Kamchilik/Maktov…\n"
            "• Daraja: Past / O'rta / Yuqori\n"
            "• Tahrir / o'chirish; eksport: CSV, Excel, PDF"
        ),
    },
    {
        "keys": ["mashina va narx", "mashina qoshish", "mashina qo'shish", "narx saqlash"],
        "a": (
            "Mashina va narx — park ro'yxati va narx/meta.\n"
            "• Mashina qo'shish — yangi mashina\n"
            "• O'zgarishlarni saqlash — tahrirlarni saqlash\n"
            "• O'chirish — mashinani yashirish/o'chirish (ehtiyot)"
        ),
    },
    {
        "keys": ["bosh sahifa", "fuel home", "gps bor", "km tushmagan"],
        "a": (
            "Boshqaruv → Bosh sahifa: oy bo'yicha qisqa KPI va "
            "«GPS bor — kunlik km tushmagan» jadvali (GPS sync qilingan, lekin Kunlik kiritishga km yozilmagan kunlar)."
        ),
    },
    # ── Boshqaruv: yuqori / asboblar ──
    {
        "keys": ["asl malumot", "asl ma'lumot", "asl ma lumot", "btn-reload", "asl holat"],
        "a": (
            "Asl ma'lumot — serverdagi asl (saqlangan) ma'lumotni qayta yuklaydi.\n"
            "Saqlanmagan lokal o'zgarishlar yo'qolishi mumkin.\n"
            "Zaxira saqlash ≠ Asl ma'lumot: zaxira — fayl nusxa; Asl — tizim asosiy ma'lumotiga qaytish.\n"
            "Muhim o'zgarish bo'lsa avval Zaxira saqlash qiling."
        ),
    },
    {
        "keys": ["zaxira saqlash", "zaxiradan tiklash", "zaxira", "backup", "tiklash"],
        "a": (
            "Zaxira saqlash — joriy Boshqaruv ma'lumotidan JSON nusxa yuklab oladi.\n"
            "Zaxiradan tiklash — shu JSON ni qayta yuklaydi (joriy holatni almashtiradi).\n"
            "Asl ma'lumot — server asliga qaytaradi (zaxira faylidan mustaqil)."
        ),
    },
    {
        "keys": ["gps dan km", "gpsdan km", "gps dan"],
        "a": (
            "GPS dan km — tanlangan oy/mashina uchun GPS yurgan masofani kunlik jadvalga yozadi "
            "(ochiq/qulflanmagan kunlarga). Keyin raqamlarni tekshirib Saqlash bosing.\n"
            "GPS km va qo'lda kiritilgan km farq qilishi mumkin."
        ),
    },
    {
        "keys": ["excel yuklab olish", "excel yuklab", "export excel fuel"],
        "a": "Excel yuklab olish (Boshqaruv) — joriy oy ma'lumotini ko'p varaqli Excel ga eksport qiladi.",
    },
    {
        "keys": ["excel toldirish", "excel to'ldirish", "excel orqali", "import excel"],
        "a": (
            "Excel to'ldirish / Excel orqali to'ldirish — .xlsx dan oylik/kunlikni import.\n"
            "Oy/yil tanlang → fayl → Yuklash → tasdiqlang. Mavjud ma'lumot almashtirilishi mumkin."
        ),
    },
    {
        "keys": ["oldingi oydan", "qoldiqni yigish", "qoldiqni yig'ish"],
        "a": "Oldingi oydan qoldiqni yig'ish — oldingi oy oxiridagi spidometr/qoldiqni joriy oy boshiga ko'chiradi.",
    },
    {
        "keys": ["barchasini yangilash", "hisobni yangilash"],
        "a": "Barchasini yangilash — norma/narx/km bo'yicha hisoblarni qayta hisoblab jadvalni yangilaydi.",
    },
    {
        "keys": ["spidometr boyicha", "spidometr bo'yicha", "spidometr toldirish", "spidometr to'ldirish"],
        "a": "Spidometr bo'yicha kunlarni to'ldirish — ketma-ket spidometr qiymatlaridan kunlik km ni hisoblab yozadi.",
    },
    {
        "keys": ["norma/narx", "norma narx", "norma ozgarishi", "norma o'zgarishi"],
        "a": "Norma/narx o'zgarishi — oy ichida norma yoki narx o'zgarganda qaysi kundan qaysi maydon o'zgarishini belgilash.",
    },
    {
        "keys": ["haydovchini kun", "haydovchi almashtirish", "shofyor almash"],
        "a": "Haydovchini kun belgilab almashtirish — ma'lum kundan yangi haydovchi nomini yozish (oy ichida almashuv).",
    },
    {
        "keys": ["saqlash", "oy saqlash", "fuel saqlash"],
        "a": "Saqlash (Kunlik kiritish) — joriy oy o'zgarishlarini serverga yozadi. Saqlamasangiz yangilanish/chiqishda yo'qolishi mumkin.",
    },
    {
        "keys": ["oy tanlash", "month input", "oy picker"],
        "a": "Yuqoridagi Oy tanlovchi — qaysi oy ma'lumoti bilan ishlashni belgilaydi. O'zgartirsangiz shu oy yuklanadi.",
    },
    # ── Dashboard ──
    {
        "keys": ["gps yuklash", "shu kunni yuklash", "gps modal"],
        "a": (
            "GPS yuklash — GPS modalini ochadi: sana (Kecha/Bugun), server URL, login, parol/token.\n"
            "Shu kunni yuklash — tanlangan kun uchun Boomerang/Wialon dan ma'lumot tortadi.\n"
            "Token olish — yangi oyna: tashqi Wialon OAuth."
        ),
    },
    {
        "keys": ["ulanis", "ulanish", "yangilash gps", "gps sync", "gps tizimi"],
        "a": (
            "GPS tizimi → Ulanish: birinchi marta GPS ulash (modal).\n"
            "Ulangandan keyin tugma Yangilash bo'lishi mumkin — shu kunni qayta sync.\n"
            "Status: Ulanmagan / ULANGAN N/M — nechta mashina kelgan."
        ),
    },
    {
        "keys": ["excel yuklash", "dashboard excel import"],
        "a": "Excel yuklash (Dashboard) — .xlsx orqali kunlik ma'lumotni import qiladi (GPS yuklashga muqobil/yordam).",
    },
    {
        "keys": ["excel saqlash", "dashboard excel export"],
        "a": "Excel saqlash (Dashboard) — tanlangan kun jamlanma + marshrut/to'xtashlarni Excel ga eksport.",
    },
    {
        "keys": ["pdf", "pdf yuklab", "chop etish"],
        "a": (
            "PDF tugmalari joyiga qarab:\n"
            "• Dashboard PDF — kunlik ko'p mashinali PDF\n"
            "• Kun hisoboti / Rasmiy / Gaz akti / Yillik / Zapravka — shu bo'lim PDF\n"
            "• Oylik — PDF (jami + kunma-kun)"
        ),
    },
    {
        "keys": ["sozlamalar", "json saqlash", "json yuklash", "tozalash lokal"],
        "a": (
            "Sozlamalar (Dashboard):\n"
            "• Yoqilg'i normalari jadvali\n"
            "• JSON saqlash / JSON yuklash — lokal STATE nusxasi\n"
            "• Tozalash — lokal ma'lumotni o'chirish (tasdiq; ehtiyot!)\n"
            "• Saqlash / Yopish"
        ),
    },
    {
        "keys": ["kalendar", "sana tanlash", "kecha", "bugun"],
        "a": "Kalendar — oy < > va kun katakchalari bilan kun tanlash. GPS modalida ham Kecha/Bugun qisqa tugmalari bor.",
    },
    {
        "keys": ["ruxsat", "qoidabuzarlik", "bekor", "toxtash baho", "to'xtash baho"],
        "a": (
            "Dashboard → Barcha to'xtashlar qatorida:\n"
            "• Ruxsat — to'xtashni ruxsatli deb belgilash (ba'zan dorixona/geozona o'rganish so'raladi)\n"
            "• Qoidabuzarlik — qoidabuzar deb belgilash\n"
            "• Bekor — bahoni bekor qilish"
        ),
    },
    {
        "keys": [
            "kunlik ball", "kunlik baholash", "ball", "jarima", "bonus",
            "8.0", "kunlik ball nima", "score", "baholash",
        ],
        "a": (
            "Kunlik ball — tanlangan haydovchi/kun uchun umumiy baho (masalan 8.0).\n"
            "• Yuqorida katta raqam — shu kun balli.\n"
            "• Ball dorixona tashrifi, muammoli to'xtashlar, reja bajarilishi va boshqa KPI dan hisoblanadi.\n"
            "• Chapda haydovchi kartasi (ism, raqam, yo'nalish); pastda Barcha mashinalar jadvali.\n"
            "• To'xtashlarni Ruxsat / Qoidabuzarlik bilan belgilash ballga ta'sir qilishi mumkin.\n"
            "Haydovchi kabinetida ham Ball KPI ko'rinadi (faqat o'qish)."
        ),
    },
    {
        "keys": ["barcha mashinalar", "mashinalar jadvali", "dtab", "haydovchi qator"],
        "a": (
            "Barcha mashinalar — Dashboard pastidagi jadval: haydovchi, raqam, ball, km, reja, muammo, tezlik.\n"
            "Qatorni bossangiz — shu mashina tanlanadi: yuqorida kartochka, xarita va to'xtashlar yangilanadi."
        ),
    },
    {
        "keys": ["marshrut xaritasi", "xarita", "marshrut", "xarita yangilash", "leaflet", "map data", "zoom xarita"],
        "a": (
            "Marshrut xaritasi — tanlangan mashina/kun GPS yo'li va to'xtashlar.\n"
            "• Yangilash — xaritani qayta chizadi.\n"
            "• + / − yoki g'ildirak — zoom. Yaqinlashtirishda ko'cha-ko'cha ko'rinadi.\n"
            "• Legenda: o'z dorixona, boshqa yo'nalish, muammo, ofis, GPS chiziq.\n"
            "Agar fon bo'sh/yozuv chiqsa — sahifani yangilang (Ctrl+F5); tile manbasi OpenStreetMap."
        ),
    },
    {
        "keys": ["dorixona tahlili", "otkazib", "o'tkazib yuborilgan"],
        "a": "Dorixona tahlili — o'z/boshqa/muammoli/ruxsatli nuqtalar. O'tkazib yuborilgan — rejadagi borib bo'lmagan joylar.",
    },
    # ── Haydovchi ──
    {
        "keys": ["haydovchi kabinet", "live", "jonli kabinet", "arxiv kuni"],
        "a": (
            "Haydovchi kabineti — faqat o'z mashinasi, faqat ko'rish.\n"
            "• Bugun: LIVE / Jonli kabinet — avto-yangilanish\n"
            "• Boshqa sana: Arxiv kuni\n"
            "KPI, xarita, yoqilg'i, topshiriqlar, to'xtashlar, jurnal. O'zgartirish yo'q."
        ),
    },
    {
        "keys": ["topshiriq", "biriktirilgan nuqta", "vazifa haydovchi"],
        "a": "Topshiriqlar — admin biriktirgan dorixona/nuqtalar va kunlik vazifalar. Tashrif / o'tkazib yuborilgan belgilar ko'rinadi.",
    },
    # ── Admin ──
    {
        "keys": ["admin qoshish", "admin qo'shish", "hisobni yaratish", "admin pro"],
        "a": "Admin qo'shish → Hisobni yaratish — yangi admin hisobi (odatda Admin Pro ko'radi). Haydovchi bu panelni ko'rmaydi.",
    },
    {
        "keys": ["shofyor qoshish", "shofyor qo'shish", "haydovchini yaratish", "haydovchi qoshish"],
        "a": "Shofyor qo'shish → Haydovchini yaratish — haydovchi login + mashina biriktirish.",
    },
    {
        "keys": ["kunlik vazifa", "topshiriq yozish"],
        "a": "Kunlik vazifa → Topshiriq yozish — tanlangan mashina/sanaga matn vazifa; haydovchi kabinetida o'qiydi.",
    },
    {
        "keys": ["blok", "yoqish", "foydalanuvchi", "parol yaratish", "ochirish foydalanuvchi"],
        "a": (
            "Foydalanuvchilar jadvali:\n"
            "• Yangilash — ro'yxatni qayta yuklash\n"
            "• Ko'rish — haydovchi kabinetiga o'tish\n"
            "• Blok / Yoqish — hisobni o'chirish/yoqish\n"
            "• Parol / Parol yaratish — parol modal\n"
            "• O'chirish — hisobni o'chirish"
        ),
    },
    {
        "keys": ["chiqarish", "kim tizimda", "sessiya"],
        "a": "Kim tizimda — faol sessiyalar. Chiqarish — foydalanuvchini sessiyadan chiqaradi.",
    },
    {
        "keys": ["dorixona biriktirish", "gps joylarini", "geozona", "otkazish", "o'tkazish", "radius"],
        "a": (
            "Dorixona biriktirish:\n"
            "• GPS joylarini yangilash — GPS nom/koordinata\n"
            "• Biriktirish — mashinaga dorixona + radius\n"
            "• Geozonalarni o'rganish va qayta hisoblash — geozona/hisob\n"
            "• O'tkazish / O'chirish — boshqa mashinaga yoki olib tashlash"
        ),
    },
    {
        "keys": ["telegram", "sinab korish", "sinab ko'rish", "bot token"],
        "a": "Telegram (ko'pincha Admin Pro): Yoqilgan, token/chat ID, Saqlash, Sinab ko'rish — test xabar. Tokenni hech kimga bermang.",
    },
    {
        "keys": ["tasodifiy", "parolni yangilash", "parol modal"],
        "a": "Parolni yangilash modal: Tasodifiy — random parol; Saqlash — yangi parol; Yopish — bekor.",
    },
    # ── Umumiy / profil / login ──
    {
        "keys": ["davomat", "face id", "face ulash", "kirish chiqish", "ertalab davomat", "keldim", "ketdim"],
        "a": (
            "Davomat — Face ID + GPS + vaqt.\n"
            "1) Davomat → birinchi marta Face ID ulang\n"
            "2) Har kuni: Keldim (ertalab) / Ketdim (kechqurun)\n"
            "Admin: Dashboard (bugun), Hisobot (oylik), Xodim (bitta odam).\n"
            "Hisobot/Xodimda Excel va PDF yuklab olish mumkin."
        ),
    },
    {
        "keys": ["davomat excel", "davomat pdf", "davomat hisobot", "attendance export", "hisobot excel"],
        "a": (
            "Davomat hisobot export:\n"
            "1) Davomat → Hisobot — oy tanlang → Excel yoki PDF\n"
            "2) Yoki Xodim — odamni tanlang → Excel / PDF\n"
            "Excel: jamoa jamlanma + kunlik varaq. PDF: qisqa jadval."
        ),
    },
    {
        "keys": ["avto sync", "avtomatik gps", "ertalab yuklash", "kunlik odat", "gps ozi", "oxirgi"],
        "a": (
            "GPS kunlik odat — server o'zi yuklaydi (brauzer ochiq bo'lishi shart emas).\n"
            "• Ertalab yangi kun bo'sh bo'lsa — birinchi bo'lib to'ldiriladi\n"
            "• Kun davomida ~3 daqiqada yangilanadi (GitHub Actions)\n"
            "• Zaxira: Vercel cron (15 daqiqa) GitHubni uyg'otadi — CRON_SECRET + GH_PAT kerak\n"
            "Agar 0 mashina: Dashboard → GPS yuklash yoki GitHub Actions → GPS sync → Run workflow."
        ),
    },
    {
        "keys": ["parol hash", "ochiq parol", "password plain", "parol ko'rinmaydi", "noma'lum parol"],
        "a": (
            "Admin va Admin Pro panelda foydalanuvchi login/parollari ko'rinadi (boshqaruv uchun).\n"
            "Kirish tekshiruvi uchun hash ham saqlanadi.\n"
            "Agar «Nomaʼlum*» bo'lsa — avval «Parol» bilan yangilang, keyin jadvalda qoladi."
        ),
    },
    {
        "keys": ["profil", "profile", "profil sahifa", "profil tugma", "parolni saqlash", "parolni almashtirish"],
        "a": (
            "Profil — chap menyuning pastidagi bo'lim (yoki Profil sahifasi).\n\n"
            "Vazifasi: hisobingizni ko'rish va boshqarish.\n\n"
            "Ichida nimalar bor:\n"
            "1) Hisob ma'lumotlari — login, rol (Admin/Haydovchi), biriktirilgan mashina\n"
            "2) Tezkor havolalar:\n"
            "   • Dashboard — GPS kunlik sahifa\n"
            "   • Boshqaruv — yoqilg'i/hisobot\n"
            "   • Admin panel — foydalanuvchi/dorixona (huquq bo'lsa; Admin Pro: Admin Pro yozuvi)\n"
            "   • Haydovchi kabineti — faqat haydovchi uchun\n"
            "3) Parolni almashtirish — yangi parol + Parolni saqlash\n"
            "4) Chiqish — sessiyani yopadi\n\n"
            "Profil Excel yoki hisobot emas — bu shaxsiy hisob sahifasi."
        ),
    },
    {
        "keys": ["chiqish", "logout", "sessiyani yop"],
        "a": "Chiqish — tizimdan chiqadi (sessiya yopiladi). Keyin qayta login kerak. Profil yoki Admin yuqorisida bo'lishi mumkin.",
    },
    {
        "keys": ["kirish", "login", "parol", "login.html"],
        "a": "Kirish: login + parol → Kirish. Sessiyasiz sahifalar ochilmaydi. Parolni Profilda almashtirasiz. Eye — parolni ko'rsatish.",
    },
    {
        "keys": ["menyu", "dashboard", "boshqaruv", "navigatsiya", "nav"],
        "a": (
            "Navigatsiya:\n"
            "• Staff: Dashboard, Boshqaruv, Profil (+ Admin panel Profil ichida)\n"
            "• Haydovchi: Kabinet, Profil\n"
            "Mobil: Menyu (burger) ochadi/yopadi."
        ),
    },
    {
        "keys": ["yordamchi", "chat", "skrin", "screenshot", "tezkor"],
        "a": (
            "Yordamchi — pastdagi chat. Tugma/bo'lim nomini yozing yoki skrin + «bu tugma nima?» "
            "Tezkor chip lar tez savol yuboradi. Ctrl+V bilan skrin qo'yish mumkin. Tozalash — tarixni o'chiradi."
        ),
    },
    {
        "keys": [
            "tizim", "tzim", "tushuntir", "umumiy", "toliq tizim", "to'liq tizim",
            "qanaqa tizim", "bu tizim", "nima qiladi tizim",
        ],
        "a": (
            "VaksinaMed Fleet Control — avtopark GPS + yoqilg'i + haydovchi kabineti.\n\n"
            "1) Dashboard — kunlik GPS, ball, xarita, to'xtash bahosi\n"
            "2) Boshqaruv — kunlik kiritish, hisobotlar, zapravka, hujjat, jurnal\n"
            "3) Haydovchi kabineti — o'z kuni (faqat ko'rish, LIVE)\n"
            "4) Admin — foydalanuvchi, dorixona, vazifa, Telegram\n"
            "5) Profil — hisob/parol\n\n"
            "Aniq tugma nomini yozing yoki tezkor chip tanlang — batafsil aytaman."
        ),
    },
    {
        "keys": ["qoldiq", "manfiy", "sarf", "oy boshi qoldiq"],
        "a": (
            "Manfiy gaz/benzin qoldig'i ko'pincha: oy boshi qoldiq noto'g'ri yoki zapravka to'liq kiritilmagan.\n"
            "Kunlik kiritishda qoldiq, olingan yoqilg'i va normani tekshiring; Oldingi oydan qoldiqni yig'ish yordam beradi."
        ),
    },
    {
        "keys": ["yoqilgi turi", "yoqilg'i turi", "gaz+benzin", "dizel+gaz", "faqat gaz"],
        "a": "Yoqilg'i turi (Kunlik kiritish): Gaz+benzin, Dizel+gaz, Faqat gaz/benzin/dizel — qaysi ustunlar hisoblanishini belgilaydi.",
    },
    {
        "keys": ["norma", "100 km", "gaz norma", "benzin norma"],
        "a": "Norma — 100 km ga litr (gaz/benzin-dizel). Kunlik kiritishda yoki Sozlamalarda (Dashboard) tahrirlanadi; sarf shunga qarab hisoblanadi.",
    },
]

PAGE_BUTTON_GUIDE = {
    "fuel.html": (
        "Siz Boshqaruvdasiz. Chap menyu (har biri alohida so'ralishi mumkin):\n\n"
        "• Bosh sahifa — KPI + GPS km tushmaganlar\n"
        "• Kunlik kiritish — asosiy kiritish + Saqlash / GPS dan km\n"
        "• Kun hisoboti — 1 kun, barcha mashinalar + PDF\n"
        "• Oylik hisobot — oy jami; qator→kunma-kun; PDF jami+kunma-kun\n"
        "• Rasmiy hisobot — firma maydonlari + PDF + Shablon Excel\n"
        "• Yillik jamlanma — yil + PDF\n"
        "• Zapravka reestri / Gaz akti / Hujjat muddatlari\n"
        "• Haydovchilar jurnali / Mashina va narx\n\n"
        "Yuqori: Oy, Excel yuklab olish, Excel to'ldirish, Zaxira, Asl ma'lumot.\n"
        "Aniq nom yozing yoki pastdagi tezkor tugmani bosing."
    ),
    "index.html": (
        "Siz Dashboarddasiz — kunlik GPS nazorat.\n\n"
        "Yuqori: GPS yuklash, Excel yuklash, Excel saqlash, PDF, Sozlamalar.\n"
        "Chap: Kalendar; GPS tizimi → Ulanish / Yangilash.\n"
        "Markaz:\n"
        "• Haydovchi kartasi (ism, raqam, yo'nalish)\n"
        "• Kunlik ball — katta raqam (masalan 8.0)\n"
        "• Marshrut xaritasi + Yangilash, to'xtash/nuqta/muammo\n"
        "• Barcha to'xtashlar — Ruxsat / Qoidabuzarlik / Bekor\n"
        "• Barcha mashinalar jadvali — qatorni tanlang\n\n"
        "Aniqroq: «Kunlik ball», «GPS yuklash», «Xarita» deb yozing yoki tezkor tugmani bosing."
    ),
    "admin.html": (
        "Admin panel:\n"
        "• Admin/Shofyor qo'shish, Kunlik vazifa\n"
        "• Foydalanuvchilar: Blok, Parol, O'chirish, Ko'rish\n"
        "• Kim tizimda → Chiqarish\n"
        "• Dorixona biriktirish, GPS joylar, Geozona\n"
        "• Telegram, o'z paroli, Chiqish\n"
        "Qaysi bo'lim? Nomini yozing."
    ),
    "driver.html": (
        "Haydovchi kabineti (faqat ko'rish):\n"
        "Sana, LIVE, KPI (km/ball/o'tkazib/qoidabuzarlik), xarita, yoqilg'i, topshiriqlar, to'xtashlar, jurnal.\n"
        "Ma'lumotni admin Boshqaruvdan kiritadi."
    ),
    "profile.html": (
        "Profil: hisob, tezkor havolalar (Dashboard/Boshqaruv/Admin/Kabinet), Parolni saqlash, Chiqish."
    ),
}
