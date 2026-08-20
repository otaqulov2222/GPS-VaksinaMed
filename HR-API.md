# VaksinaMed — HR API (faqat o'qish)

HR platformasiga shu hujjatni bering. Asosiy VHK / yoqilg‘i / login o‘zgarmaydi.

## Yoqish

1. Render (yoki server) Environment ga qo‘ying:
   - `VM_HR_API_KEY` = uzun maxfiy kalit (masalan 32+ belgi)
2. Serviceni restart / redeploy qiling.
3. Kalit bo‘lmasa API `503` qaytaradi (xavfsiz o‘chirilgan).

## Manzil

Production misol:
`https://gps-vaksinamed.onrender.com`

## Autentifikatsiya

Har so‘rovda header:

```
X-API-Key: SIZNING_KALITINGIZ
```

yoki:

```
Authorization: Bearer SIZNING_KALITINGIZ
```

## Endpointlar

### 1) Holat
`GET /api/hr/health`

### 2) Park (kunlik qisqa)
`GET /api/hr/fleet?date=2026-08-20`

`date` ixtiyoriy — bo‘lmasa bugun (Toshkent).

Javobda har haydovchi uchun: `car`, `name`, `km`, `score`, `grade`, `ownVisited`/`totalOwn`, `problemStops`, `taskCount`, `status` (`ok` | `diqqat` | `muammo` | `malumot_yoq`).

### 3) Bitta haydovchi
`GET /api/hr/driver?car=01%20887%20UKA&date=2026-08-20`

Qo‘shimcha: vazifalar, o‘tkazib yuborilgan dorixonalar, to‘xtashlar (joy/vaqt/holat).  
Yoqilg‘i narxi, GPS parol, login — **yo‘q**.

### 4) Vazifalar
`GET /api/hr/tasks?date=2026-08-20`  
Ixtiyoriy: `&car=01%20887%20UKA`

## Misol (curl)

```bash
curl -s -H "X-API-Key: SIZNING_KALITINGIZ" ^
  "https://gps-vaksinamed.onrender.com/api/hr/fleet?date=2026-08-20"
```

## Muhim

- Faqat **GET** (yozish/o‘chirish yo‘q)
- Cookie login kerak emas
- Kalitni ommaga chiqarmang; faqat HR serveriga bering
