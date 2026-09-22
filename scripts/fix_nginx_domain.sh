#!/usr/bin/env bash
# 1) Eng eski ishlagan backupdan tiklaydi
# 2) Domenni faqat proxy_pass (APP) blockga qo'shadi
# 3) Bo'sh SSL block server_name ni o'chirib, _unused qiladi (block o'chirilmaydi)
set -euo pipefail

DOMAIN="${1:-vaksinamedgps.uz}"
WWW="www.${DOMAIN}"
SITE="${NGINX_SITE:-/etc/nginx/sites-enabled/vaksina}"
OLD="vaksinagps.duckdns.org"

echo "==> Backuplar:"
ls -lt "${SITE}".bak.* 2>/dev/null | head -10 || true

# Eng eski backup (birinchi buzilishdan oldin)
OLDEST="$(ls -1t "${SITE}".bak.* 2>/dev/null | tail -1 || true)"
if [[ -n "$OLDEST" ]]; then
  echo "==> Tiklanmoqda: $OLDEST"
  cp -a "$OLDEST" "$SITE"
else
  echo "Diqqat: .bak topilmadi — joriy fayl tuzatiladi"
fi

python3 - "$SITE" "$DOMAIN" "$WWW" "$OLD" <<'PY'
import re, sys
path, domain, www, old = sys.argv[1:5]
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
if not servers:
    print("XATO: server block yo'q")
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
            new_block = block[:sn.start()] + new_sn + block[sn.end():]
            changes.append("APP: " + " ".join(names2))
    else:
        # Bo'sh block — domenni _unused ga almashtirish (404 bermasligi uchun)
        name_set = {n.rstrip(".") for n in names}
        if domain in name_set or www in name_set:
            new_sn = "server_name _unused_vaksinamedgps;"
            new_block = block[:sn.start()] + new_sn + block[sn.end():]
            changes.append("disabled empty SSL block server_name")

    if new_block != block:
        result = result[:start] + new_block + result[end:]

# Agar APP topilmasa — oddiy replace
if not any(c.startswith("APP:") for c in changes):
    if old in result and domain not in result:
        result = result.replace(old, f"{old} {domain} {www}", 1)
        changes.append("fallback duckdns extend")

if not changes:
    print("O'zgarish yo'q — qatorlar:")
    for i, line in enumerate(open(path, encoding="utf-8", errors="replace"), 1):
        if "server_name" in line or "proxy_pass" in line:
            print(f"{i}: {line.rstrip()}")
    sys.exit(2)

# Brace tekshiruv
if result.count("{") != result.count("}"):
    print("XATO: brace mos emas {", result.count("{"), "} ", result.count("}"))
    sys.exit(3)

open(path, "w", encoding="utf-8").write(result)
for c in changes:
    print(c)
print("OK file written")
PY

nginx -t
systemctl reload nginx
systemctl restart vaksina 2>/dev/null || true
echo "Tekshiring: https://${DOMAIN}"
