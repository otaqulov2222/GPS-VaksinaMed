# VaksinaMed ↔ HR / Logistika platformasi — ulash yo‘riqnomasi

**Kim uchun:** HR yoki logistika platformasi dasturchisi / integratsiya jamoasi  
**Kim beradi:** VaksinaMed (GPS) tizimi  
**Maqsad:** VaksinaMed’dan kunlik GPS / haydovchi / vazifa ma’lumotlarini **faqat o‘qish** orqali tortib olish

---

## 1. Qisqa xulosa

| Savol | Javob |
|--------|--------|
| API tayyormi? | Ha — kod va endpointlar ishlaydi |
| Yozish mumkinmi? | **Yo‘q** — faqat GET |
| Login / cookie kerakmi? | **Yo‘q** — faqat API kalit |
| Yoqilg‘i narxi, GPS parol, foydalanuvchi login | **Berilmaydi** |
| Face ID / davomat | Hozircha **shu API’da yo‘q** |

---

## 2. Sizga beriladigan narsalar (VaksinaMed tomonidan)

1. **Base URL (production):**  
   `https://gps-vaksina-med.vercel.app`

2. **API kalit (maxfiy — faqat serveringizda saqlang):**  
   `SIZNING_API_KALITINGIZ`

3. **Header nomi:** `X-API-Key`  
   (yoki `Authorization: Bearer <kalit>`)

4. **Ushbu hujjat** — endpointlar, maydonlar, misollar

> ⚠️ Kalitni Telegram/chat’da ochiq saqlamang uzoq muddatga. Keyinroq kalitni almashtirish mumkin (Vercel env).

---

## 3. Siz nima qilishingiz kerak (ketma-ket)

### Qadam A — ulanishni tekshirish
```http
GET https://gps-vaksina-med.vercel.app/api/hr/health
X-API-Key: SIZNING_API_KALITINGIZ
```

**Kutilgan javob (200):**
```json
{
  "ok": true,
  "service": "VaksinaMed HR API",
  "version": 1,
  "today": "2026-09-07",
  "endpoints": [
    "GET /api/hr/health",
    "GET /api/hr/fleet?date=YYYY-MM-DD",
    "GET /api/hr/driver?car=01+887+UKA&date=YYYY-MM-DD",
    "GET /api/hr/tasks?date=YYYY-MM-DD"
  ]
}
```

| Kod | Ma’nosi |
|-----|---------|
| 200 | Kalit to‘g‘ri, API ochiq |
| 401 | Kalit noto‘g‘ri yoki yo‘q |
| 503 | Serverda kalit hali yoqilmagan (VaksinaMed tomonda) |

### Qadam B — kunlik park (asosiy ro‘yxat)
Har kuni (yoki kerakli sana) barcha mashinalar qisqa holati:

```http
GET https://gps-vaksina-med.vercel.app/api/hr/fleet?date=2026-09-07
X-API-Key: SIZNING_API_KALITINGIZ
```

`date` ixtiyoriy — bo‘lmasa **Toshkent bo‘yicha bugun**.

### Qadam C — bitta haydovchi batafsil
Foydalanuvchi / HR kartochkasi uchun:

```http
GET https://gps-vaksina-med.vercel.app/api/hr/driver?car=01%20887%20UKA&date=2026-09-07
X-API-Key: SIZNING_API_KALITINGIZ
```

`car` — mashina raqami (URL encode: bo‘sh joy = `%20`).

### Qadam D — vazifalar
```http
GET https://gps-vaksina-med.vercel.app/api/hr/tasks?date=2026-09-07
X-API-Key: SIZNING_API_KALITINGIZ
```

Ixtiyoriy filtr: `&car=01%20887%20UKA`

### Qadam E — o‘z tizimingizda saqlash
Tavsiya:
1. Cron: har 15–60 daqiqada `fleet` chaqirish  
2. Kerak bo‘lganda `driver` bilan chuqurlashtirish  
3. `car` + `date` bo‘yicha upsert  
4. Kalitni **faqat backend**da saqlang (brauzerga chiqarmang)

---

## 4. curl misollari (Windows / Linux)

```bash
curl -s -H "X-API-Key: SIZNING_API_KALITINGIZ" ^
  "https://gps-vaksina-med.vercel.app/api/hr/health"
```

```bash
curl -s -H "X-API-Key: SIZNING_API_KALITINGIZ" ^
  "https://gps-vaksina-med.vercel.app/api/hr/fleet?date=2026-09-07"
```

```bash
curl -s -H "X-API-Key: SIZNING_API_KALITINGIZ" ^
  "https://gps-vaksina-med.vercel.app/api/hr/driver?car=01%%20887%%20UKA&date=2026-09-07"
```

```bash
curl -s -H "X-API-Key: SIZNING_API_KALITINGIZ" ^
  "https://gps-vaksina-med.vercel.app/api/hr/tasks?date=2026-09-07"
```

---

## 5. Sizga ko‘rinadigan ma’lumotlar (to‘liq)

### 5.1 `GET /api/hr/fleet` — park

**Yuqori daraja:**
| Maydon | Izoh |
|--------|------|
| `ok` | true |
| `date` | So‘ralgan sana |
| `generatedAt` | Javob vaqti |
| `totals.cars` | Mashinalar soni |
| `totals.withGps` | GPS ma’lumoti borlari |
| `totals.ok` / `diqqat` / `muammo` | Status bo‘yicha sonlar |
| `drivers[]` | Har bir mashina qatori |

**Har bir `drivers[]` elementi:**
| Maydon | Izoh |
|--------|------|
| `date` | Sana |
| `car` | Mashina raqami |
| `name` | Haydovchi ismi |
| `hasGps` | Shu kun GPS bor-yo‘q |
| `km` | Kunlik km |
| `score` | Kunlik ball (0–10 tipida) |
| `grade` | Baholash belgisi |
| `ownVisited` | O‘z dorixonalariga kirgan |
| `totalOwn` | O‘z dorixonalari jami |
| `problemStops` | Muammoli to‘xtashlar soni |
| `taskCount` | Vazifalar soni |
| `status` | `ok` \| `diqqat` \| `muammo` \| `malumot_yoq` |
| `updatedAt` | Yangilangan vaqt |

**Status qoidasi (VaksinaMed ichida):**
- `muammo` — problemStops ≥ 3 yoki score < 5  
- `diqqat` — problemStops ≥ 1 yoki score < 8  
- `ok` — qolganlari  
- `malumot_yoq` — GPS yo‘q / kun yuklanmagan  

---

### 5.2 `GET /api/hr/driver` — bitta haydovchi

Fleet’dagi maydonlar + qo‘shimcha:

| Maydon | Izoh |
|--------|------|
| `routes` | Yo‘nalish matni |
| `maxSpeed` | Max tezlik |
| `stopsCount` | To‘xtashlar soni |
| `missedList[]` | O‘tkazib yuborilgan dorixonalar |
| `pharmacies[]` | Dorixonalar ro‘yxati (mavjud bo‘lsa) |
| `tasks[]` | Shu kun vazifalari |
| `stops[]` | To‘xtashlar (max ~60) |

**`stops[]` ichida:**
| Maydon | Izoh |
|--------|------|
| `place` | Joy nomi |
| `inTime` / `outTime` | Kirish / chiqish vaqti |
| `matchType` | Moslash turi |
| `isProblem` | Muammolimi |
| `reviewStatus` | Ko‘rib chiqish holati |
| `durSec` | Davomiylik (soniya) |

**`tasks[]` ichida:**
| Maydon | Izoh |
|--------|------|
| `id` | ID |
| `date` | Sana |
| `text` | Matn |
| `by` | Kim yozgan |
| `createdAt` | Yaratilgan |

> Koordinatalar, ichki kalitlar, yoqilg‘i narxi, GPS login — **yo‘q**.

---

### 5.3 `GET /api/hr/tasks` — vazifalar

| Maydon | Izoh |
|--------|------|
| `date` | Filtr sanasi (yoki null) |
| `count` | Qaytarilgan son (max 200) |
| `tasks[]` | `id`, `car`, `date` (`har_kuni` bo‘lishi mumkin), `text`, `by`, `createdAt` |

---

## 6. Sizga KO‘RINMAYDIGAN narsalar

- Foydalanuvchi login / parol  
- GPS provayder paroli  
- Yoqilg‘i narxlari va ichki fuel hisoblar  
- Admin panel, session cookie  
- Face ID / davomat stamplari (alohida modul; bu HR API’da yo‘q)  
- Yozish / o‘chirish / yangilash endpointlari  

---

## 7. Integratsiya sxemasi

```
[HR / Logistika platformasi]
        │
        │  HTTPS GET + X-API-Key
        ▼
[VaksinaMed]  https://gps-vaksina-med.vercel.app/api/hr/...
        │
        │  faqat o‘qish
        ▼
[GPS kunlik hisobotlar, haydovchilar, vazifalar]
```

**Ikki tizim bog‘lanishi:**
1. VaksinaMed — ma’lumot manbai (GPS tahlil)  
2. HR platformasi — iste’molchi (o‘z UI / HR jarayoniga joylaydi)  
3. Birlashtirish kaliti: odatda **`car` (mashina raqami) + `date`**

---

## 8. CORS / texnik

- `Access-Control-Allow-Origin: *`  
- Ruxsat etilgan method: **GET**, **OPTIONS**  
- Headerlar: `X-API-Key`, `Authorization`, `Content-Type`  
- Tavsiya: chaqiriqni **server-to-server** qiling  

---

## 9. Tekshiruv checklist (HR jamoa)

- [ ] `/api/hr/health` → 200  
- [ ] `/api/hr/fleet?date=BUGUN` → `drivers` massivi keladi  
- [ ] Bitta `car` bilan `/api/hr/driver` → batafsil  
- [ ] `/api/hr/tasks` → vazifalar  
- [ ] Noto‘g‘ri kalit → 401  
- [ ] Kalit faqat backend env’da  

---

## 10. Aloqa

Muammo bo‘lsa VaksinaMed jamoasiga yuboring:
- qaysi URL  
- HTTP status  
- `date` / `car`  
- javobdagi `error` matni  

**Kalitni qayta so‘ramang chatda ochiq** — almashtirish kerak bo‘lsa alohida kanal orqali.

---

*Hujjat: VaksinaMed HR API v1 · production: gps-vaksina-med.vercel.app*
