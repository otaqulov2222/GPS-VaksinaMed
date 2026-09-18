#!/bin/bash
# Hetzner Console da bir marta:
#   bash /opt/vaksina/app/scripts/enable_hr_logistics.sh
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/vaksina/app}"
ENV_FILE="$APP_DIR/.env"
KEY="${VM_HR_API_KEY_SET:-VmHr_2026_K9mP2qL7nR4wT8yX3zA}"
BASE="${VM_PUBLIC_BASE_URL_SET:-https://vaksinagps.duckdns.org}"

touch "$ENV_FILE"
set_kv() {
  local k="$1" v="$2"
  if grep -q "^${k}=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^${k}=.*|${k}=${v}|" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$k" "$v" >>"$ENV_FILE"
  fi
}

set_kv VM_PRODUCTION 1
set_kv VM_HR_API_KEY "$KEY"
set_kv VM_PUBLIC_BASE_URL "$BASE"
set_kv VM_HR_SSO_USERS "adminpro"
set_kv VM_HR_FRAME_ANCESTORS "https://vaksinahr.uz https://www.vaksinahr.uz"

systemctl restart vaksina
sleep 2
echo "=== health ==="
curl -s -H "X-API-Key: $KEY" "$BASE/api/hr/health" || true
echo
echo "OK: HR Logistika env yoqildi. Restart qilindi."
