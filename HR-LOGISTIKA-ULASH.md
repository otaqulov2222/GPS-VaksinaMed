# VaksinaMed Logistika ↔ vaksinahr.uz — to‘liq ulash (HR dasturchisi uchun)

> **Asosiy to‘liq hujjat (Cursor prompt bilan):** [`VAKSINAHR-INTEGRATSIYA-CURSOR-PROMPT.md`](./VAKSINAHR-INTEGRATSIYA-CURSOR-PROMPT.md)  
> Shu qisqa fayl — tezkor reference. Integratsiyani to‘liq qilish uchun asosiy MD ni bering.

**Baza:** VaksinaMed ma’lumotlari **Hetzner VPS** da (`data/kv` JSON; ixtiyoriy lokal Postgres). **Neon yo‘q.**  
HR platformasi bazaga ulanmaydi — faqat API/SSO. HR `.env` da `DATABASE_URL` kerak emas.

**Kim uchun:** vaksinahr.uz dasturchisi  
**Kim beradi:** VaksinaMed (GPS / Machine Control)  
**Maqsad:** HR menyusida **alohida «Logistika»** bo‘limi — ichida VaksinaMed to‘liq ochiladi va ishlaydi (faqat o‘qish emas).

---

## 1. Menyuda qanday ko‘rinishi kerak

`Apteka tarmog‘i` **ichiga emas** — **alohida** top-level bo‘lim:

```
Asosiy
…
Apteka tarmog'i
  ├── Aptekalar tarmog'i
  ├── Bog'lanish
  └── Ehtiyoj
Logistika                 ← YANGI (siz qo‘shasiz)
  ├── Dashboard / VHK
  ├── Boshqaruv
  ├── Live
  ├── Davomat
  └── Panel
Sozlamalar
```

Har bir ichki band bosilganda — VaksinaMed shu bo‘limi **to‘liq ishlaydi** (saqlash, filtrlash, hisobot).

---

## 2. Sizga beriladigan narsalar

| Narsa | Izoh |
|--------|------|
| **Base URL** | Production domen (masalan `https://gps.SIZNING-DOMEN.uz`) — IP emas, HTTPS |
| **API kalit** | `X-API-Key` (faqat **backend**da saqlang) |
| **Shu hujjat** | Menyи + SSO oqimi |

Eski Vercel URL (`*.vercel.app`) — **ishlatilmasin**.

---

## 3. Autentifikatsiya

Har bir **server→server** so‘rovda:

```
X-API-Key: SIZNING_KALITINGIZ
```

yoki `Authorization: Bearer SIZNING_KALITINGIZ`

Brauzer foydalanuvchisi kalitni ko‘rmasligi kerak.

---

## 4. Endpointlar

### 4.1 Holat
`GET {BASE}/api/hr/health`

### 4.2 Logistika menyu (bandlar ro‘yxati)
`GET {BASE}/api/hr/logistics/menu`

Javobda `items[]`: `id`, `title`, `path` (masalan `/`, `/fuel`, `/live`…).

Shu ro‘yxatdan HR sidebar ichki punktlarini yasang.

### 4.3 SSO — kirish tokeni (asosiy)
`POST {BASE}/api/hr/logistics/sso`

**Body (JSON):**
```json
{
  "username": "adminpro",
  "path": "/",
  "embed": true
}
```

| Maydon | Majburiy | Izoh |
|--------|----------|------|
| `username` | * | VaksinaMed logini (ruxsatli 2–3 tadan biri) |
| `hrUser` | | HR email/login → serverdagi map orqali bizning loginga |
| `path` | | `/` \| `/fuel` \| `/live` \| `/attendance` \| `/admin` |
| `embed` | | `true` = iframe ichida (tavsiya) |

**Javob:**
```json
{
  "ok": true,
  "enterUrl": "https://…/api/hr/logistics/enter?ticket=…",
  "expiresInSec": 90,
  "path": "/"
}
```

### 4.4 Enter (brauzer)
`GET {enterUrl}`

Brauzer shu URLga o‘tadi → cookie o‘rnatiladi → kerakli bo‘limga redirect.  
**API key bu yerda kerak emas** (ticket bir martalik, ~90 soniya).

---

## 5. Tavsiya etilgan oqim (HR backend)

1. Foydalanuvchi HR da **Logistika → Dashboard** bosadi.  
2. HR **backend** (faqat ruxsatli rollar: direktor / HR direktor / admin) chaqiradi:

```http
POST /api/hr/logistics/sso
X-API-Key: …
Content-Type: application/json

{"username":"adminpro","path":"/","embed":true}
```

3. Javobdagi `enterUrl` ni:
   - **iframe `src`** ga qo‘ying, yoki  
   - yangi tab / ichki frame ga redirect qiling.  
4. Boshqa bandlar: `path` ni `/fuel`, `/live`, `/attendance`, `/admin` qilib qayta SSO.

**Muhim:** SSO ni brauzerdan to‘g‘ridan API key bilan chaqirmang — faqat HR server orqali.

---

## 6. Kim kira oladi

VaksinaMed tomonda faqat kelishilgan **2–3 login** (`VM_HR_SSO_USERS`).  
Boshqa HR userlari Logistika bandini ko‘rmasligi yoki SSO `403` olishi kerak — buni HR UI da ham filtrlash tavsiya.

---

## 7. iframe eslatma

- VaksinaMed HTTPS bo‘lishi shart (`embed: true` → `SameSite=None; Secure`).  
- HR domeni VaksinaMed da `VM_HR_FRAME_ANCESTORS` ga qo‘yiladi (masalan `https://vaksinahr.uz`).  
- Agar iframe muammo qilsa — vaqtincha `embed:false` + yangi tab.

---

## 8. curl misollar

```bash
curl -s -H "X-API-Key: KALIT" "https://BASE/api/hr/health"
```

```bash
curl -s -H "X-API-Key: KALIT" "https://BASE/api/hr/logistics/menu"
```

```bash
curl -s -X POST -H "X-API-Key: KALIT" -H "Content-Type: application/json" \
  -d "{\"username\":\"adminpro\",\"path\":\"/fuel\",\"embed\":true}" \
  "https://BASE/api/hr/logistics/sso"
```

---

## 9. Eski o‘qish API (ixtiyoriy)

Faqat raqam/jadval kerak bo‘lsa (to‘liq UI emas):

- `GET /api/hr/fleet`
- `GET /api/hr/driver`
- `GET /api/hr/tasks`

Logistika to‘liq ishlatish uchun **asosiy yo‘l — §4–5 (SSO + menyu)**.

---

## 10. Xato kodlari

| Kod | Ma’nosi |
|-----|---------|
| 200 | OK |
| 401 | Kalit yoki ticket noto‘g‘ri |
| 403 | Login ruxsat etilmagan |
| 503 | Serverda kalit / SSO users yoqilmagan |

---

## 11. Checklist (siz)

- [ ] Top-level **Logistika** menyu  
- [ ] Ichida 5 band (VHK, Boshqaruv, Live, Davomat, Panel)  
- [ ] Backend SSO (`username` + `path` + `embed`)  
- [ ] iframe yoki ichki ochilish  
- [ ] Faqat 2–3 ruxsatli rol  
- [ ] API key faqat serverda  

Savol bo‘lsa — VaksinaMed jamoasiga Base URL + test kalit so‘rang.
