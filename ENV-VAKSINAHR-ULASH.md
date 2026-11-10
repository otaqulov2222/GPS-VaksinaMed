# vaksinahr.uz ↔ VaksinaMed — ENV (to‘liq, nusxa qilib qo‘ying)

> **Kalit ikkala joyda BIR XIL bo‘lishi shart.**  
> **Production URL:** `https://vaksinamedgps.uz`  
> ❌ Haqiqiy `VM_HR_API_KEY` ni gitga yozmang — faqat server `.env` da saqlang.  
> Kalitni rotate qiling (git tarixida eski kalit bo‘lgan).

---

## A) vaksinahr.uz — `artifacts/api-server/.env`

```env
# ── VaksinaMed Logistika (majburiy) ─────────────────────────
VAKSINAMED_BASE_URL=https://vaksinamedgps.uz
VAKSINAMED_API_KEY=YOUR_VM_HR_API_KEY

# HR login/rol → VaksinaMed username (SSO)
VAKSINAMED_USER_MAP={"admin":"adminpro","asoschi":"adminpro","director":"adminpro","hr_direktor":"adminpro"}

VAKSINAMED_DEFAULT_USERNAME=adminpro
VAKSINAMED_ALLOWED_ROLES=admin,asoschi,director,hr_direktor
```

**Keyin:** API serverni restart / redeploy.

---

## B) VaksinaMed Hetzner — `/opt/vaksina/app/.env`

```bash
nano /opt/vaksina/app/.env
```

Qo‘shing / yangilang (mavjud GPS/DB qatorlarini **o‘chirmang**):

```env
VM_PRODUCTION=1

# Logistika API + SSO (HR dagi VAKSINAMED_API_KEY bilan BIR XIL)
VM_HR_API_KEY=YOUR_VM_HR_API_KEY

VM_PUBLIC_BASE_URL=https://vaksinamedgps.uz
VM_HR_SSO_USERS=adminpro
VM_HR_FRAME_ANCESTORS=https://vaksinahr.uz https://www.vaksinahr.uz
```

Saqlang, keyin:

```bash
systemctl restart vaksina
```

Tekshiruv:

```bash
curl -s -H "X-API-Key: YOUR_VM_HR_API_KEY" \
  https://vaksinamedgps.uz/api/hr/health
```

Kutiladi: `"ok": true`, `logistics` bo‘limi.

---

## C) Qisqa juftlik

| HR (vaksinahr) | VaksinaMed |
|----------------|------------|
| `VAKSINAMED_BASE_URL` | `VM_PUBLIC_BASE_URL` |
| `VAKSINAMED_API_KEY` | `VM_HR_API_KEY` (bir xil maxfiy kalit) |

Yangi kalit yaratish (misol):

```bash
openssl rand -base64 24
```
