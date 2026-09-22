#!/usr/bin/env bash
# vaksinamedgps.uz uchun TO'G'RI SSL + proxy (duckdns cert bilan chalkashmasin)
set -euo pipefail

DOMAIN="${1:-vaksinamedgps.uz}"
WWW="www.${DOMAIN}"
SITE="/etc/nginx/sites-enabled/vaksina"
OLD="vaksinagps.duckdns.org"
CERT="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
KEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
BAK_DIR="/root/nginx-bak"

mkdir -p "$BAK_DIR"
cp -a "$SITE" "$BAK_DIR/vaksina.before-ssl.$(date +%s)"

# .bak ni sites-enabled dan chiqarish
shopt -s nullglob
for f in /etc/nginx/sites-enabled/*.bak* /etc/nginx/sites-enabled/*~; do
  mv -f "$f" "$BAK_DIR/" || true
done
shopt -u nullglob

if [[ ! -f "$CERT" || ! -f "$KEY" ]]; then
  echo "==> Sertifikat yo'q — Let's Encrypt..."
  certbot certonly --nginx -d "$DOMAIN" -d "$WWW" --non-interactive --agree-tos \
    -m "admin@${DOMAIN}" --expand || \
  certbot certonly --nginx -d "$DOMAIN" --non-interactive --agree-tos \
    -m "admin@${DOMAIN}"
fi

if [[ ! -f "$CERT" ]]; then
  echo "XATO: $CERT hali yo'q"
  exit 1
fi

echo "==> Nginx: alohida SSL block + proxy"
python3 - "$SITE" "$DOMAIN" "$WWW" "$OLD" "$CERT" "$KEY" <<'PY'
import re, sys
path, domain, www, old, cert, key = sys.argv[1:7]
text = open(path, encoding="utf-8", errors="replace").read()
text = text.replace("# --- disabled empty ssl block ---", "")

def split_servers(content):
    out = []
    i = 0
    while True:
        m = re.search(r"server\s*\{", content[i:])
        if not m:
            break
        start = i + m.start()
        j = i + m.end() - 1
        depth = 0
        while j < len(content):
            if content[j] == "{":
                depth += 1
            elif content[j] == "}":
                depth -= 1
                if depth == 0:
                    out.append((start, j + 1, content[start:j+1]))
                    i = j + 1
                    break
            j += 1
        else:
            break
    return out

servers = split_servers(text)
proxy_block = None
for start, end, block in servers:
    if "proxy_pass" in block and old in block:
        proxy_block = block
        break
if proxy_block is None:
    for start, end, block in servers:
        if "proxy_pass" in block:
            proxy_block = block
            break
if proxy_block is None:
    print("XATO: proxy_pass block topilmadi")
    sys.exit(1)

# proxy_pass va location qismlarini olish — butun blockdan listen/ssl/server_name ni almashtiramiz
# Yangi block: 443 ssl + domain cert + proxy qismi duckdns dan

# Duckdns APP blockdan yangi domenni olib tashlash
result = text
for start, end, block in reversed(split_servers(result)):
    sn = re.search(r"server_name\s+([^;]+);", block)
    if not sn:
        continue
    names = sn.group(1).split()
    has_proxy = "proxy_pass" in block
    if has_proxy:
        names2 = [n for n in names if n.rstrip(".") not in (domain, www)]
        if not names2:
            names2 = [old] if old else ["_"]
        if names2 != names:
            new_sn = "server_name " + " ".join(names2) + ";"
            new_block = block[:sn.start()] + new_sn + block[sn.end():]
            result = result[:start] + new_block + result[end:]
            print("APP duckdns cleaned:", " ".join(names2))
    else:
        # Eski bo'sh/yangi domen blocklarini o'chirish (keyin yangisini yozamiz)
        name_set = {n.rstrip(".") for n in names}
        if domain in name_set or www in name_set or "_unused_vaksinamedgps" in name_set:
            result = result[:start] + result[end:]
            print("removed old SSL-only/unused block")

# Proxy ichidagi location va boshqa direktivlarni nusxalash (listen/server_name/ssl dan tashqari)
# Oddiyroq: duckdns proxy blockni template qilib, headerlarni almashtiramiz
src = proxy_block
# Yangi block yasash
body_lines = []
skip_prefixes = ("listen ", "server_name", "ssl_certificate", "ssl_certificate_key",
                 "ssl_trusted_certificate", "include /etc/letsencrypt/", "ssl_dhparam")
# ichki qatorlar
inner = src[src.find("{")+1:src.rfind("}")]
for line in inner.splitlines():
    s = line.strip()
    if not s:
        body_lines.append(line)
        continue
    if any(s.startswith(p) for p in skip_prefixes):
        continue
    if s.startswith("#") and "managed by Certbot" in s:
        continue
    body_lines.append(line)

body = "\n".join(body_lines).strip("\n")
new_server = f"""
server {{
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name {domain} {www};

    ssl_certificate {cert};
    ssl_certificate_key {key};
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

{body}
}}
"""

# HTTP -> HTTPS redirect for new domain (agar yo'q bo'lsa)
if f"server_name {domain}" not in result or "listen 80" not in result:
    pass

# HTTP redirect block qo'shish
http_redirect = f"""
server {{
    listen 80;
    listen [::]:80;
    server_name {domain} {www};
    return 301 https://$host$request_uri;
}}
"""

# Yangi SSL blockni oxiriga
if f"ssl_certificate {cert}" not in result:
    result = result.rstrip() + "\n" + new_server + "\n"
    print("added SSL+proxy block for", domain)
else:
    print("cert path already in file — check manually")

# Domain uchun alohida :80 redirect (dublikat bo'lmasin)
need_http = True
for start, end, block in split_servers(result):
    if "listen 80" in block or "listen [::]:80" in block:
        sn = re.search(r"server_name\s+([^;]+);", block)
        if sn and domain in sn.group(1).split():
            need_http = False
            break
if need_http:
    result = result.rstrip() + "\n" + http_redirect + "\n"
    print("added HTTP->HTTPS redirect")

if result.count("{") != result.count("}"):
    print("XATO brace", result.count("{"), result.count("}"))
    sys.exit(3)

open(path, "w", encoding="utf-8").write(result)
print("OK")
PY

nginx -t
systemctl reload nginx
echo "TAYYOR: https://${DOMAIN}"
