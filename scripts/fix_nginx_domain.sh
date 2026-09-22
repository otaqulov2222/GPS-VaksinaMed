#!/usr/bin/env bash
# vaksinamedgps.uz ni mavjud nginx server_name ga qo'shadi (404 tuzatish)
set -euo pipefail

DOMAIN="${1:-vaksinamedgps.uz}"
WWW="www.${DOMAIN}"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-enabled/vaksina}"
OLD="vaksinagps.duckdns.org"

if [[ ! -f "$NGINX_SITE" ]]; then
  echo "XATO: $NGINX_SITE topilmadi"
  ls -la /etc/nginx/sites-enabled/ || true
  exit 1
fi

python3 - "$NGINX_SITE" "$OLD" "$DOMAIN" "$WWW" <<'PY'
import sys
path, old, domain, www = sys.argv[1:5]
text = open(path, encoding="utf-8", errors="replace").read()
if domain in text:
    print("already ok:", domain)
else:
    if old not in text:
        print("XATO: server_name ichida", old, "yo'q")
        print("--- fayl (server_name qatorlari) ---")
        for i, line in enumerate(text.splitlines(), 1):
            if "server_name" in line:
                print(f"{i}: {line}")
        sys.exit(1)
    new = f"{old} {domain} {www}"
    open(path, "w", encoding="utf-8").write(text.replace(old, new))
    print("updated:", new)
PY

nginx -t
systemctl reload nginx
systemctl restart vaksina 2>/dev/null || true
echo "Tekshiring: https://${DOMAIN}"
