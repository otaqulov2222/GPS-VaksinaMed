#!/bin/bash
# Bir qator: bash scripts/fix_hr_key.sh
# VM_HR_API_KEY ni o'zi yaratadi, .env ga yozadi, vaksina ni restart qiladi.
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/vaksina/app}"
ENV_FILE="$APP_DIR/.env"
BASE="${VM_PUBLIC_BASE_URL:-https://vaksinamedgps.uz}"

cd "$APP_DIR"
KEY="$(openssl rand -hex 24)"

touch "$ENV_FILE"
if grep -q '^VM_HR_API_KEY=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^VM_HR_API_KEY=.*|VM_HR_API_KEY=${KEY}|" "$ENV_FILE"
else
  printf '\nVM_HR_API_KEY=%s\n' "$KEY" >>"$ENV_FILE"
fi

# SSO / URL defaultlari (bor bo'lsa tegilmaydi)
grep -q '^VM_PRODUCTION=' "$ENV_FILE" 2>/dev/null || echo 'VM_PRODUCTION=1' >>"$ENV_FILE"
grep -q '^VM_PUBLIC_BASE_URL=' "$ENV_FILE" 2>/dev/null || echo "VM_PUBLIC_BASE_URL=${BASE}" >>"$ENV_FILE"
grep -q '^VM_HR_SSO_USERS=' "$ENV_FILE" 2>/dev/null || echo 'VM_HR_SSO_USERS=adminpro' >>"$ENV_FILE"
grep -q '^VM_HR_FRAME_ANCESTORS=' "$ENV_FILE" 2>/dev/null || echo 'VM_HR_FRAME_ANCESTORS=https://vaksinahr.uz https://www.vaksinahr.uz' >>"$ENV_FILE"

systemctl restart vaksina
sleep 2

echo "=============================="
echo "KALIT (HR ga ham shu kerak):"
echo "$KEY"
echo "=============================="
echo "health:"
curl -s -H "X-API-Key: $KEY" "$BASE/api/hr/health" || true
echo
echo "HR .env ga qo'ying: VAKSINAMED_API_KEY=$KEY"
echo "VAKSINAMED_BASE_URL=$BASE"
