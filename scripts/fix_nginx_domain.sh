#!/usr/bin/env bash
# vaksinamedgps.uz ni APP (proxy_pass) block ga ulaydi;
# bo'sh SSL-only blocklarni o'chiradi (404 sababi).
set -euo pipefail

DOMAIN="${1:-vaksinamedgps.uz}"
WWW="www.${DOMAIN}"
NGINX_SITE="${NGINX_SITE:-/etc/nginx/sites-enabled/vaksina}"

if [[ ! -f "$NGINX_SITE" ]]; then
  echo "XATO: $NGINX_SITE topilmadi"
  ls -la /etc/nginx/sites-enabled/ || true
  exit 1
fi

cp -a "$NGINX_SITE" "${NGINX_SITE}.bak.$(date +%s)"

python3 - "$NGINX_SITE" "$DOMAIN" "$WWW" <<'PY'
import re, sys
path, domain, www = sys.argv[1:4]
old = "vaksinagps.duckdns.org"
text = open(path, encoding="utf-8", errors="replace").read()

# Oldingi buzilgan izohlarni tozalash
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
                    out.append((start, j + 1, content[start : j + 1]))
                    i = j + 1
                    break
            j += 1
        else:
            break
    return out

servers = split_servers(text)
if not servers:
    print("XATO: server {} block topilmadi")
    sys.exit(1)

changes = []
result = text
for start, end, block in reversed(servers):
    sn = re.search(r"server_name\s+([^;]+);", block)
    if not sn:
        continue
    names = sn.group(1).split()
    has_proxy = "proxy_pass" in block
    new_block = block

    if has_proxy:
        names2 = list(names)
        for extra in (domain, www):
            if extra not in names2:
                names2.append(extra)
        if names2 != names:
            new_sn = "server_name " + " ".join(names2) + ";"
            new_block = block[: sn.start()] + new_sn + block[sn.end() :]
            changes.append("APP block: " + " ".join(names2))
    else:
        # Bo'sh SSL blockda yangi domen bo'lsa — butun blockni o'chiramiz
        name_set = {n.rstrip(".") for n in names}
        if domain in name_set or www in name_set:
            new_block = ""
            changes.append("removed empty SSL-only block for " + domain)
        else:
            names2 = [n for n in names if n.rstrip(".") not in (domain, www)]
            if names2 != names and names2:
                new_sn = "server_name " + " ".join(names2) + ";"
                new_block = block[: sn.start()] + new_sn + block[sn.end() :]
                changes.append("stripped domain from non-proxy block")

    if new_block != block:
        result = result[:start] + new_block + result[end:]

# Fallback: duckdns qatoriga qo'shish
if not any(c.startswith("APP block") for c in changes):
    if old in result:
        # faqat proxy_pass yaqinidagi server_name ni yangilashga harakat
        if f"{old} {domain}" not in result and domain not in result.split("proxy_pass")[0][-200:]:
            result2 = result.replace(old, f"{old} {domain} {www}", 1)
            if result2 != result:
                result = result2
                changes.append("fallback: duckdns line extended")

if not changes:
    print("Hech narsa o'zgarmadi. server_name / proxy_pass:")
    for i, line in enumerate(text.splitlines(), 1):
        if "server_name" in line or "proxy_pass" in line:
            print(f"{i}: {line.strip()}")
    sys.exit(2)

# Bo'sh qatorlarni biroz tozalash
result = re.sub(r"\n{3,}", "\n\n", result)
open(path, "w", encoding="utf-8").write(result)
for c in changes:
    print(c)
print("OK")
PY

nginx -t
systemctl reload nginx
systemctl restart vaksina 2>/dev/null || true
echo "Tekshiring: https://${DOMAIN}"
