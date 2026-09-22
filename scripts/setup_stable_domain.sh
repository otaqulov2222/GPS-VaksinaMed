#!/usr/bin/env bash
# VaksinaMed — telefonlar uchun barqaror domen (DuckDNS o‘rniga)
#
# Nima uchun: vaksinagps.duckdns.org ko‘p iOS/Android tarmoqda DNS topilmaydi.
# Yechim: oddiy domen, masalan gps.vaksinahr.uz → A 49.13.152.181
#
# Oldindan (majburiy):
#   1) DNS da A yozuv:
#        gps.vaksinahr.uz  →  49.13.152.181
#      (TTL 300)
#   2) Shu skriptni serverda root bilan ishga tushiring:
#        bash /opt/vaksina/app/scripts/setup_stable_domain.sh gps.vaksinahr.uz
#
# Skript: nginx server_name + Let's Encrypt SSL + .env VM_PUBLIC_BASE_URL

set -euo pipefail

DOMAIN="${1:-gps.vaksinahr.uz}"
APP_DIR="${APP_DIR:-/opt/vaksina/app}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
WEBROOT="${WEBROOT:-/var/www/certbot}"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-available/vaksina}"
EMAIL="${LETSENCRYPT_EMAIL:-admin@${DOMAIN#*.}}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Root kerak: sudo bash $0 $DOMAIN"
  exit 1
fi

echo "==> Domen: https://$DOMAIN"
echo "==> DNS tekshiruv..."
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1; exit}' || true)"
if [[ -z "$RESOLVED" ]]; then
  echo "XATO: $DOMAIN hali DNS da yo'q yoki tarqalmagan."
  echo "Avval A yozuv qo'shing: $DOMAIN → 49.13.152.181"
  exit 1
fi
echo "    DNS → $RESOLVED"

mkdir -p "$WEBROOT"
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx >/dev/null

# Mavjud duckdns conf ni o'qib, yangi domen qo'shamiz (agar fayl bo'lsa)
if [[ -f "$NGINX_SITE" ]]; then
  if ! grep -q "$DOMAIN" "$NGINX_SITE"; then
    # server_name qatoriga domen qo'shish (oddiy holat)
    sed -i -E "s/(server_name[^;]*)(vaksinagps\.duckdns\.org)/\1\2 $DOMAIN/" "$NGINX_SITE" || true
    if ! grep -q "$DOMAIN" "$NGINX_SITE"; then
      echo "Diqqat: $NGINX_SITE ichida server_name topilmadi — qo'lda qo'shing: $DOMAIN"
    fi
  fi
else
  echo "Diqqat: $NGINX_SITE yo'q. Nginx conf ni o'zingiz yaratgan bo'lishi mumkin."
  echo "server_name qatoriga $DOMAIN ni qo'shing, keyin qayta ishga tushiring."
fi

nginx -t
systemctl reload nginx

echo "==> Let's Encrypt sertifikat..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || \
  certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL"

# .env yangilash
if [[ -f "$ENV_FILE" ]]; then
  if grep -q '^VM_PUBLIC_BASE_URL=' "$ENV_FILE"; then
    sed -i -E "s|^VM_PUBLIC_BASE_URL=.*|VM_PUBLIC_BASE_URL=https://$DOMAIN|" "$ENV_FILE"
  else
    echo "VM_PUBLIC_BASE_URL=https://$DOMAIN" >> "$ENV_FILE"
  fi
  echo "    VM_PUBLIC_BASE_URL=https://$DOMAIN"
fi

nginx -t
systemctl reload nginx
systemctl restart vaksina 2>/dev/null || true

echo
echo "Tayyor. Telefonlarda oching: https://$DOMAIN"
echo "HR tomonda ham yangilang:"
echo "  VAKSINAMED_BASE_URL=https://$DOMAIN"
echo "Eski duckdns URL ni bookmarklardan olib tashlang."
