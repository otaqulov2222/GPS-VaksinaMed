# vaksinahr.uz ↔ VaksinaMed — ENV (to‘liq, nusxa qilib qo‘ying)

> **Kalit ikkala joyda BIR XIL bo‘lishi shart.**  
> **Production URL (SSL to‘g‘ri):** `https://vaksinagps.duckdns.org`  
> ❌ `https://49.13.152.181` — ishlatmang (`ERR_TLS_CERT_ALTNAME_INVALID`, cert faqat domen uchun).  
> Hozir Hetzner build: `m138` — SSO (`m139`) hali deploy qilinmagan; `VM_HR_API_KEY` ham yoqilmagan.

---

## A) vaksinahr.uz — `artifacts/api-server/.env`

```env
# ── VaksinaMed Logistika (majburiy) ─────────────────────────
VAKSINAMED_BASE_URL=https://vaksinagps.duckdns.org
VAKSINAMED_API_KEY=VmHr_2026_K9mP2qL7nR4wT8yX3zA

# HR login/rol → VaksinaMed username (SSO)
# Kalitlar: HR dagi username/email; qiymat: VaksinaMed login
VAKSINAMED_USER_MAP={"admin":"adminpro","asoschi":"adminpro","director":"adminpro","hr_direktor":"adminpro"}

# Map ishlamasa fallback
VAKSINAMED_DEFAULT_USERNAME=adminpro

# Ixtiyoriy (agar kod shuni o‘qisa)
VAKSINAMED_ALLOWED_ROLES=admin,asoschi,director,hr_direktor
```

**Keyin:** API serverni restart / redeploy.

---

## B) VaksinaMed Hetzner — `/opt/vaksina/app/.env`

Console da:

```bash
nano /opt/vaksina/app/.env
```

Qo‘shing / yangilang (mavjud GPS/DB qatorlarini **o‘chirmang**):

```env
VM_PRODUCTION=1

# Logistika API + SSO (HR dagi VAKSINAMED_API_KEY bilan BIR XIL)
VM_HR_API_KEY=VmHr_2026_K9mP2qL7nR4wT8yX3zA

# Brauzer/iframe uchun (HR BASE_URL bilan bir xil)
VM_PUBLIC_BASE_URL=https://vaksinagps.duckdns.org

# HR orqali kira oladigan VaksinaMed loginlar (mavjud admin/admin_pro)
VM_HR_SSO_USERS=adminpro

# iframe ruxsati
VM_HR_FRAME_ANCESTORS=https://vaksinahr.uz https://www.vaksinahr.uz

# Ixtiyoriy: HR user → bizning login (server tomonda ham)
# VM_HR_SSO_MAP=admin:adminpro,director:adminpro,hr_direktor:adminpro
```

Saqlang (`Ctrl+O`, Enter, `Ctrl+X`), keyin:

```bash
systemctl restart vaksina
# SSO kodi (m139) hali yo'q bo'lsa — avval git pull / deploy
```

Tekshiruv:

```bash
curl -s -H "X-API-Key: VmHr_2026_K9mP2qL7nR4wT8yX3zA" \
  https://vaksinagps.duckdns.org/api/hr/health
```

Kutiladi: `"ok": true`, `"version": 2`, `logistics` bo‘limi.

---

## C) Qisqa juftlik

| HR (vaksinahr.uz) | VaksinaMed (Hetzner) |
|-------------------|----------------------|
| `VAKSINAMED_BASE_URL` | `VM_PUBLIC_BASE_URL` (bir xil URL) |
| `VAKSINAMED_API_KEY` | `VM_HR_API_KEY` (bir xil kalit) |
| `VAKSINAMED_DEFAULT_USERNAME` / map | `VM_HR_SSO_USERS` da shu login bor |
| — | `VM_HR_FRAME_ANCESTORS=https://vaksinahr.uz` |

---

## D) Domen bo‘lsa (tavsiya)

IP o‘rniga ikkala joyda:

```env
VAKSINAMED_BASE_URL=https://vaksinagps.duckdns.org
VM_PUBLIC_BASE_URL=https://vaksinagps.duckdns.org
```

---

## E) Xavfsizlik

- Kalitni chatga uzoq saqlamang; production da almashtiring.  
- `VAKSINAMED_API_KEY` ni `NEXT_PUBLIC_*` qilmang.  
- `adminpro` VaksinaMed Panel da mavjud va active bo‘lsin.

---

## F) Hozir nima qilish kerak (ketma-ket)

1. Yuqoridagi **A** ni HR `.env` ga qo‘ying → restart  
2. Yuqoridagi **B** ni Hetzner `.env` ga qo‘ying → `systemctl restart vaksina`  
3. SSO uchun lokal `m139` ni Hetzner ga deploy/push (hozir live `m138`)  
4. vaksinahr.uz → Logistika → **Qayta urinish**
