# vaksinahr.uz ← VaksinaMed (GPS / Logistika) — TO‘LIQ INTEGRATSIYA

> **Kim uchun:** `vaksinahr.uz` (VAKSINA MED HR) dasturchisi / Cursor agent  
> **Kim beradi:** VaksinaMed Machine Control (Hetzner)  
> **Maqsad:** HR ichida **alohida «Logistika»** bo‘limi orqali VaksinaMed tizimini **to‘liq ochib, kuzatib, ishlatish** (faqat raqam emas).  
> **Versiya API:** 2 (SSO + o‘qish)

---

## 0) CURSOR UCHUN PROMPT (shu blokni nusxa qiling)

```
Siz vaksinahr.uz (VAKSINA MED HR) kod bazasida ishlaysiz.

Vazifa: VaksinaMed GPS/Logistika tizimini TO‘LIQ integratsiya qiling.

Qoidalar:
1) Menyuda ALOHIDA top-level bo‘lim «Logistika» qo‘shing.
   - «Apteka tarmog‘i» ICHIGA QO‘YILMASIN.
   - Apteka tarmog‘i yonida/pastda alohida band bo‘lsin.
2) Logistika ochilganda ichida quyidagi bandlar bo‘lsin:
   - Dashboard / VHK
   - Boshqaruv
   - Live
   - Davomat
   - Panel
3) Har band bosilganda VaksinaMed shu bo‘limi TO‘LIQ ishlashi kerak
   (ko‘rish + saqlash + filtr + hisobot). Faqat o‘qish widget yetarli emas.
4) Kirish: SSO orqali. Foydalanuvchi qayta login qilmasin.
5) API kalit faqat HR BACKEND env da. Brauzerga chiqarmang.
6) Faqat ruxsatli 2–3 rol/login (direktor, HR direktor, HR admin/dasturchi)
   Logistika ni ko‘rsin va ishlatsin. Boshqalar ko‘rmasin.
7) Asosiy usul: POST /api/hr/logistics/sso → enterUrl ni iframe (yoki ichki sahifa) da ochish.
8) Ixtiyoriy: fleet/driver/tasks GET API — dashboard kartochkalar uchun.
9) Eski Vercel URL ishlatilmasin. Faqat berilgan BASE_URL (Hetzner HTTPS).
10) Hech narsa qolib ketmasin: menyu, ruxsat, SSO proxy, iframe, xato holatlari, test.
11) VaksinaMed bazasiga to'g'ridan ulanmang. Ma'lumot Hetzner'da; siz faqat API/SSO.
12) HR o'z DB sida VaksinaMed ni nusxa qilishi shart emas.

Barcha texnik tafsilotlar shu faylda. Amalga oshiring va checklist ni belgilang.
```

---

## 0.1) Baza / ma’lumot qayerda? (MUHIM)

| Tizim | Baza | HR nima qiladi? |
|--------|------|------------------|
| **VaksinaMed** | **Hetzner VPS ichida** | Ulanmaydi |
| Saqlash (hozir) | Lokal **JSON** fayllar: `data/kv/*.json` | — |
| Ixtiyoriy | Shu VPS dagi **PostgreSQL** (`DATABASE_URL=…@127.0.0.1:5432/…`) | — |
| **Neon** | **Ishlatilmaydi** (ko‘chirib bo‘lingan) | — |
| **vaksinahr.uz** | O‘z HR bazasi | Faqat o‘z user/rol/session |

**Xulosa:** HR dasturchisi VaksinaMed `DATABASE_URL` / Postgres / JSON ga **ulashmaydi**.  
Faqat HTTPS API + SSO. Ma’lumot yozish/o‘qish VaksinaMed UI/API orqali.

VaksinaMed server env (ular sozlaydi):

```env
# Ixtiyoriy — lokal Postgres (Neon emas)
# DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/vaksina
# PERSIST_DIR=

VM_PRODUCTION=1
VM_HR_API_KEY=...
VM_PUBLIC_BASE_URL=https://gps-domen.uz
VM_HR_SSO_USERS=adminpro,direktor,hradmin
VM_HR_FRAME_ANCESTORS=https://vaksinahr.uz
```

---

## 1) Natija (acceptance — shu bo‘lsa “tayyor”)

| # | Shart | OK? |
|---|--------|-----|
| A1 | Sidebar da **Logistika** alohida (Apteka ichida emas) | |
| A2 | Logistika kengayadi: VHK, Boshqaruv, Live, Davomat, Panel | |
| A3 | Band bosilsa VaksinaMed UI to‘liq ochiladi va ishlaydi | |
| A4 | Ruxsatli 2–3 user qayta login **siz** kiradi (SSO) | |
| A5 | Boshqa HR userlar Logistika ni ko‘rmaydi | |
| A6 | API key faqat server env | |
| A7 | HTTPS + iframe ishlaydi (yoki fallback: yangi tab) | |
| A8 | Xato holatlari (401/403/503) foydalanuvchiga tushunarli | |

---

## 2) Menyи UX (ANIQ)

```
Asosiy
Mening ishim
Arizalar
Xodimlar
Ishga qabul
Davomat                    ← HR o‘z davomati (o‘zgarmaydi)
Apteka tarmog'i
  ├── Aptekalar tarmog'i
  ├── Bog'lanish
  └── Ehtiyoj
Logistika                  ← YANGI, TOP-LEVEL
  ├── Dashboard / VHK      → path "/"
  ├── Boshqaruv            → path "/fuel"
  ├── Live                 → path "/live"
  ├── Davomat              → path "/attendance"   (VaksinaMed davomati)
  └── Panel                → path "/admin"
Sozlamalar
```

**DIQQAT:** HR dagi «Davomat» va Logistika ichidagi «Davomat» — turli tizimlar. Nomni UI da farqlash mumkin: masalan «GPS Davomat».

---

## 3) Arxitektura

```
[Brauzer: vaksinahr.uz]
        │  (faqat cookie/session HR)
        ▼
[HR Backend]  ──X-API-Key──►  [VaksinaMed BASE]
        │                         │
        │  POST /logistics/sso    │ ticket yaratadi
        │◄──── enterUrl ──────────┤
        ▼
[iframe / sahifa] ──GET enterUrl──► cookie vm_sid + redirect path
        │
        ▼
[VaksinaMed to‘liq UI]  (Hetzner’da ma’lumot saqlanadi)
```

- **Ma’lumot manbai:** VaksinaMed (Hetzner VPS).  
- **HR:** menyu + ruxsat + SSO bridge.  
- **Qayta yozish:** HR VaksinaMed DB sini nusxa qilishi shart emas (to‘liq UI SSO orqali).

---

## 4) Sozlamalar (HR `.env` / secrets)

```env
# VaksinaMed beradi — chatga ochiq yozmang
VAKSINAMED_BASE_URL=https://YOUR-GPS-DOMAIN.uz
VAKSINAMED_API_KEY=********************************

# Kim Logistika ni ko‘radi (HR rollari — o‘zingizning role nomlaringizga moslang)
VAKSINAMED_ALLOWED_ROLES=director,hr_director,admin

# Ixtiyoriy: HR user → VaksinaMed login map
VAKSINAMED_USER_MAP={"firdavs@...":"adminpro","hr.director@...":"direktor"}
```

**HR `.env` da KERAK EMAS:**
- `DATABASE_URL` (VaksinaMed Postgres)
- Neon connection string
- `data/kv` yo‘li
- GPS token / yoqilg‘i sirlar

VaksinaMed tomonda (ular sozlaydi, sizga kerak emas lekin biling):
- `VM_HR_API_KEY` = sizdagi `VAKSINAMED_API_KEY` bilan bir xil  
- `VM_PUBLIC_BASE_URL` = `VAKSINAMED_BASE_URL`  
- `VM_HR_SSO_USERS` = ruxsatli VaksinaMed loginlar  
- `VM_HR_FRAME_ANCESTORS=https://vaksinahr.uz` (+ www bo‘lsa qo‘shing)  
- Ma’lumot: Hetzner `data/kv` va/yoki lokal Postgres (`DATABASE_URL`) — **Neon yo‘q**

---

## 5) Autentifikatsiya

### Server → VaksinaMed (majburiy)

```
X-API-Key: {VAKSINAMED_API_KEY}
```

yoki:

```
Authorization: Bearer {VAKSINAMED_API_KEY}
```

### Brauzer

- API key **yuborilmasin**.  
- SSO dan keyin VaksinaMed o‘zi `vm_sid` cookie qo‘yadi.

### CORS

- VaksinaMed: `Access-Control-Allow-Origin: *`  
- Method: `GET, POST, OPTIONS`  
- Lekin amalda SSO ni **faqat HR backend** chaqirsin.

---

## 6) Endpointlar — TO‘LIQ RO‘YXAT

**Base:** `{VAKSINAMED_BASE_URL}`

| Method | Path | Kim | Maqsad |
|--------|------|-----|--------|
| GET | `/api/hr/health` | Backend | Holat |
| GET | `/api/hr/logistics/menu` | Backend | Menyи bandlari |
| POST | `/api/hr/logistics/sso` | Backend | Ticket + enterUrl |
| GET | `/api/hr/logistics/enter?ticket=` | Brauzer | Cookie + redirect |
| GET | `/api/hr/fleet?date=` | Backend | Park qisqa (ixtiyoriy widget) |
| GET | `/api/hr/driver?car=&date=` | Backend | Bitta haydovchi |
| GET | `/api/hr/tasks?date=&car=` | Backend | Vazifalar |

---

### 6.1 `GET /api/hr/health`

**Headers:** `X-API-Key`

**200 misol:**
```json
{
  "ok": true,
  "service": "VaksinaMed HR API",
  "version": 2,
  "today": "2026-09-18",
  "endpoints": ["GET /api/hr/health", "GET /api/hr/logistics/menu", "POST /api/hr/logistics/sso", "..."],
  "logistics": {
    "menu": "/api/hr/logistics/menu",
    "sso": "POST /api/hr/logistics/sso",
    "placement": "top_level_Logistika"
  }
}
```

| Kod | Sabab |
|-----|--------|
| 401 | Kalit noto‘g‘ri |
| 503 | VaksinaMed da kalit yoqilmagan |

---

### 6.2 `GET /api/hr/logistics/menu`

**Headers:** `X-API-Key`

**200 misol:**
```json
{
  "ok": true,
  "menuId": "logistika",
  "title": "Logistika",
  "placement": "top_level",
  "note": "Alohida bo'lim — Apteka tarmog'i ichida emas",
  "items": [
    {"id": "dashboard", "title": "Dashboard / VHK", "path": "/", "url": "https://…/"},
    {"id": "fuel", "title": "Boshqaruv", "path": "/fuel", "url": "https://…/fuel"},
    {"id": "live", "title": "Live", "path": "/live", "url": "https://…/live"},
    {"id": "attendance", "title": "Davomat", "path": "/attendance", "url": "https://…/attendance"},
    {"id": "panel", "title": "Panel", "path": "/admin", "url": "https://…/admin"}
  ],
  "ssoUsersConfigured": 3,
  "embedSupported": true
}
```

**HR da:** static menyu qilish mumkin (yuqoridagi 5 band). Yoki shu API dan dynamic oling.

---

### 6.3 `POST /api/hr/logistics/sso`  ★ ASOSIY

**Headers:**
```
X-API-Key: …
Content-Type: application/json
```

**Body:**
```json
{
  "username": "adminpro",
  "path": "/",
  "embed": true
}
```

| Maydon | Majburiy | Izoh |
|--------|----------|------|
| `username` yoki `login` | * (yoki hrUser) | VaksinaMed logini (`VM_HR_SSO_USERS` ichida) |
| `hrUser` / `email` | * (yoki username) | HR identifikator; VaksinaMed `VM_HR_SSO_MAP` bilan map qilinadi |
| `path` | yo‘q → `/` | `/` \| `/fuel` \| `/live` \| `/attendance` \| `/admin` \| `/profile` |
| `embed` | yo‘q → false | `true` = iframe (SameSite=None cookie) |

**200:**
```json
{
  "ok": true,
  "ticket": "…",
  "expiresInSec": 90,
  "path": "/",
  "enterUrl": "https://BASE/api/hr/logistics/enter?ticket=…",
  "embed": true,
  "instruction": "Brauzerni enterUrl ga yo'naltiring (yoki iframe src=enterUrl)"
}
```

| Kod | Sabab |
|-----|--------|
| 400 | username/hrUser yo‘q yoki path yaroqsiz |
| 403 | Login ruxsat etilmagan |
| 503 | SSO o‘chirilgan (`VM_HR_SSO_USERS` yo‘q) |

**Muhim:**
- Ticket **~90 soniya**, **bir marta**.  
- Har band bosilganda **yangi SSO** chaqiring (yoki bir marta SSO qilib keyin iframe ichida navigatsiya — tavsiya: har band uchun yangi SSO + path).

---

### 6.4 `GET /api/hr/logistics/enter?ticket=…`

- **API key kerak emas** (ticket o‘zi maxfiy).  
- Brauzer ochadi → `Set-Cookie: vm_sid=…` → `302 Location: {path}`.  
- `embed=true` bo‘lsa cookie: `SameSite=None; Secure`.

---

### 6.5 O‘qish API (ixtiyoriy — HR kartochka/jadval)

To‘liq ishlatish uchun shart emas. Qo‘shimcha dashboard uchun.

#### `GET /api/hr/fleet?date=YYYY-MM-DD`

`date` ixtiyoriy (default: Toshkent bugun).

**Javob:**
```json
{
  "ok": true,
  "date": "2026-09-18",
  "generatedAt": "…",
  "totals": { "cars": 23, "withGps": 20, "ok": 15, "diqqat": 3, "muammo": 2 },
  "drivers": [
    {
      "date": "2026-09-18",
      "car": "01 887 UKA",
      "name": "Komil",
      "hasGps": true,
      "km": 142.5,
      "score": 8.5,
      "grade": "A",
      "ownVisited": 7,
      "totalOwn": 14,
      "problemStops": 0,
      "taskCount": 1,
      "status": "ok",
      "updatedAt": "…"
    }
  ]
}
```

`status`: `ok` | `diqqat` | `muammo` | `malumot_yoq`

#### `GET /api/hr/driver?car=01%20887%20UKA&date=YYYY-MM-DD`

Fleet + `routes`, `maxSpeed`, `stopsCount`, `missedList`, `pharmacies`, `tasks[]`, `stops[]` (max ~60).  
Yoqilg‘i narxi / GPS parol / user login — **kelmaydi**.

#### `GET /api/hr/tasks?date=&car=`

`tasks[]`: `id`, `car`, `date`, `text`, `by`, `createdAt` (max ~200).

---

## 7) HR da amalga oshirish (qadam-baqadam)

### 7.1 Ruxsat (RBAC)

Faqat shu rollar (nomlarni o‘zingiznikiga moslang):
- Direktor  
- HR direktor  
- HR admin / dasturchi  

Boshqa rollarga:
- Logistika menyusi **hidden**  
- `/logistika/*` route → 403 sahifa  

### 7.2 Backend proxy (majburiy)

Masalan: `POST /api/integrations/vaksinamed/sso`

1. Sessiyadan HR user + rolni tekshir  
2. Rol ruxsatli emas → 403  
3. `username` ni map dan top (`VAKSINAMED_USER_MAP`)  
4. VaksinaMed ga:

```http
POST {VAKSINAMED_BASE_URL}/api/hr/logistics/sso
X-API-Key: {VAKSINAMED_API_KEY}
Content-Type: application/json

{"username":"<mapped>","path":"/fuel","embed":true}
```

5. `enterUrl` ni client ga qaytar (kalitni emas)

### 7.3 Frontend sahifa

Route masalan: `/logistika` yoki `/logistika/:section`

| section | path |
|---------|------|
| `vhk` / `dashboard` | `/` |
| `boshqaruv` / `fuel` | `/fuel` |
| `live` | `/live` |
| `davomat` | `/attendance` |
| `panel` | `/admin` |

UI:
1. Band bosiladi  
2. Frontend → HR proxy SSO  
3. `enterUrl` keladi  
4. To‘liq kenglikdagi **iframe**:

```html
<iframe
  title="VaksinaMed Logistika"
  src="{enterUrl}"
  style="width:100%;height:calc(100vh - 64px);border:0;"
  allow="geolocation; microphone; camera; clipboard-read; clipboard-write"
  referrerpolicy="no-referrer-when-downgrade"
></iframe>
```

5. Agar iframe ishlamasa (cookie/CSP): «Yangi oynada ochish» tugmasi → `window.open(enterUrl)`.

### 7.4 Sidebar

- `Apteka tarmog‘i` dan **keyin** (yoki oldin) — lekin **ichida emas**.  
- Expand/collapse xuddi Apteka kabi.  
- Badge ixtiyoriy (masalan fleet `totals.muammo`).

### 7.5 Loading / xato UI

| Holat | UI |
|--------|-----|
| SSO loading | skeleton / spinner |
| 401/503 | «Logistika vaqtincha ulanmagan — admin» |
| 403 | «Sizda ruxsat yo‘q» |
| Ticket expired | avtomatik qayta SSO |

---

## 8) Xavfsizlik (qat’iy)

1. `VAKSINAMED_API_KEY` — faqat server.  
2. Brauzerdan to‘g‘ridan VaksinaMed SSO chaqirilmasin.  
3. Open redirect yo‘q — path faqat whitelist (VaksinaMed o‘zi tekshiradi).  
4. Ticket qayta ishlatilmasin.  
5. Loglarda kalit/ticket to‘liq chiqarilmasin.  
6. Production da faqat HTTPS.  
7. iframe uchun VaksinaMed `VM_HR_FRAME_ANCESTORS` da `https://vaksinahr.uz` bo‘lishi kerak.

---

## 9) Nima KO‘RINADI / KO‘RINMAYDI

### To‘liq UI (SSO) orqali — ko‘rinadi va ishlaydi
- Dashboard / VHK (GPS, ball, xarita, hisobot)  
- Boshqaruv (yoqilg‘i)  
- Live  
- Davomat (VaksinaMed)  
- Panel (admin)  

### O‘qish API orqali — keladi
- Kunlik park, ball, km, vazifalar, to‘xtash qisqasi  

### Hech qachon API orqali kelmaydi
- Parollar, GPS token, yoqilg‘i ichki narx sirlarining exporti (UI da bo‘lsa ham API da yo‘q)  
- Yozish endpointlari (o‘qish API faqat GET)

---

## 10) Test checklist (HR)

- [ ] `GET …/api/hr/health` → 200, `version: 2`  
- [ ] Noto‘g‘ri kalit → 401  
- [ ] `GET …/logistics/menu` → 5 item  
- [ ] SSO `path=/` → enterUrl → iframe da Dashboard  
- [ ] SSO `path=/fuel` → Boshqaruv ishlaydi (saqlash sinab ko‘rilsin)  
- [ ] SSO `path=/live`, `/attendance`, `/admin`  
- [ ] Ruxsatsiz rol → menyu yo‘q  
- [ ] Ticket 2-marta → xato  
- [ ] 90s dan keyin → yangi SSO  
- [ ] Mobil kenglikda iframe scroll OK  

---

## 11) curl (backend test)

```bash
BASE="https://YOUR-GPS-DOMAIN.uz"
KEY="YOUR_KEY"

curl -s -H "X-API-Key: $KEY" "$BASE/api/hr/health"
curl -s -H "X-API-Key: $KEY" "$BASE/api/hr/logistics/menu"

curl -s -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"username":"adminpro","path":"/","embed":true}' \
  "$BASE/api/hr/logistics/sso"
```

---

## 12) VaksinaMed jamoasidan so‘rash (integratsiya oldidan)

| # | So‘raladi |
|---|-----------|
| 1 | Production `BASE_URL` (HTTPS domen) |
| 2 | `API_KEY` |
| 3 | Ruxsatli VaksinaMed loginlar (2–3) |
| 4 | HR email → login map (ixtiyoriy) |
| 5 | `VM_HR_FRAME_ANCESTORS` ga `vaksinahr.uz` qo‘yilganmi |

---

## 13) Do NOT

- `Apteka tarmog‘i` ichiga Logistika tiqmang  
- Eski `*.vercel.app` URL ishlatmang  
- API key ni frontend env (`NEXT_PUBLIC_…`) ga qo‘ymang  
- Faqat fleet GET bilan «to‘liq integratsiya» deb yopmang — **SSO + iframe shart**  
- VaksinaMed kodini HR ichida qayta yozmang (duplicate)

---

## 14) Qisqa xulosa

**To‘liq integratsiya =**  
HR menyu **Logistika** (alohida) + ichki 5 band + **backend SSO** + **iframe/to‘liq UI**.  

O‘qish API (`fleet/driver/tasks`) — bonus dashboard.  

Shu fayl bo‘yicha amalga oshirilsa — direktor `vaksinahr.uz` orqali VaksinaMed ni **to‘liq ishlatadi**.
