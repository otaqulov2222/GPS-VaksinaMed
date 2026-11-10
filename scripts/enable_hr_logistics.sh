#!/bin/bash
# Hetzner Console da:
#   VM_HR_API_KEY_SET='...' bash /opt/vaksina/app/scripts/enable_hr_logistics.sh
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/vaksina/app}"
ENV_FILE="$APP_DIR/.env"
KEY="${VM_HR_API_KEY_SET:?Set VM_HR_API_KEY_SET to a secret key (do not use git defaults)}"
BASE="${VM_PUBLIC_BASE_URL_SET:-https://vaksinamedgps.uz}"

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
