#!/usr/bin/env bash
# Yakuniy tuzatish:
# 1) sites-enabled ichidagi .bak larni OLIB TASHLAYDI (nginx ularni ham o'qiydi!)
# 2) Domenni faqat APP (proxy_pass) blockga qo'shadi
# 3) Bo'sh SSL block server_name ni _unused qiladi
set -euo pipefail

DOMAIN="${1:-vaksinamedgps.uz}"
WWW="www.${DOMAIN}"
SITE="/etc/nginx/sites-enabled/vaksina"
OLD="vaksinagps.duckdns.org"
BAK_DIR="/root/nginx-bak"

echo "==> 1) .bak fayllarni sites-enabled dan chiqarish"
mkdir -p "$BAK_DIR"
# Joriy fayl nusxasi ham shu yerga
if [[ -f "$SITE" ]]; then
  cp -a "$SITE" "$BAK_DIR/vaksina.before-fix.$(date +%s)" || true
fi
shopt -s nullglob
for f in /etc/nginx/sites-enabled/*.bak* /etc/nginx/sites-enabled/*~; do
  echo "    move $(basename "$f")"
  mv -f "$f" "$BAK_DIR/"
done
shopt -u nullglob

echo "==> sites-enabled holat:"
ls -la /etc/nginx/sites-enabled/

# Agar vaksina yo'q yoki buzilgan bo'lsa — eng eski backupdan tikla
need_restore=0
if [[ ! -f "$SITE" ]]; then
  need_restore=1
elif ! nginx -t 2>/dev/null; then
  need_restore=1
fi

if [[ "$need_restore" -eq 1 ]]; then
  echo "==> 2) Buzilgan — backupdan tiklash"
  CAND="$(ls -1t "$BAK_DIR"/vaksina.bak.* "$BAK_DIR"/vaksina.before-fix.* 2>/dev/null | tail -1 || true)"
  # Eng eski .bak odatda eng toza
  OLDEST="$(ls -1 "$BAK_DIR"/vaksina.bak.* 2>/dev/null | head -1 || true)"
  if [[ -n "$OLDEST" ]]; then
    CAND="$OLDEST"
  fi
  if [[ -z "$CAND" ]]; then
    echo "XATO: backup yo'q"
    exit 1
  fi
  echo "    tiklanmoqda: $CAND"
  cp -a "$CAND" "$SITE"
fi

echo "==> 3) Domenni APP blockga ulash"
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
        name_set = {n.rstrip(".") for n in names}
        if domain in name_set or www in name_set:
            new_sn = "server_name _unused_vaksinamedgps;"
            new_block = block[:sn.start()] + new_sn + block[sn.end():]
            changes.append("empty SSL -> _unused")

    if new_block != block:
        result = result[:start] + new_block + result[end:]

if not any(c.startswith("APP:") for c in changes):
    if old in result and domain not in result:
        result = result.replace(old, f"{old} {domain} {www}", 1)
        changes.append("fallback duckdns extend")

if result.count("{") != result.count("}"):
    print("XATO: brace", result.count("{"), result.count("}"))
    sys.exit(3)

open(path, "w", encoding="utf-8").write(result)
for c in changes or ["no structural change (maybe already set)"]:
    print(c)
print("OK")
PY

echo "==> 4) nginx test + reload"
nginx -t
systemctl reload nginx
systemctl restart vaksina 2>/dev/null || true
echo
echo "TAYYOR. Ochish: https://${DOMAIN}"
