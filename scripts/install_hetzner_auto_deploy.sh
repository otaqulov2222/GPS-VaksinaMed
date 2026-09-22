#!/bin/bash
# Bir martalik: Hetzner'da avto-deploy (har push / har 1 daqiqa git pull).
# Console'da OXIRGI marta:
#   cd /opt/vaksina/app && git pull origin main && bash scripts/install_hetzner_auto_deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/vaksina/app}"
SCRIPT=/opt/vaksina/hetzner_auto_pull.sh
REPO_SCRIPT="$APP_DIR/scripts/hetzner_auto_pull.sh"

if [[ ! -d "$APP_DIR/.git" ]]; then
  echo "XATO: $APP_DIR git repo emas"
  exit 1
fi

# Repodagi skriptni /opt/vaksina ga nusxa (yoki ichiga yozamiz)
if [[ -f "$REPO_SCRIPT" ]]; then
  cp -a "$REPO_SCRIPT" "$SCRIPT"
else
  cat >"$SCRIPT" <<'EOF'
#!/bin/bash
set -euo pipefail
APP_DIR="${APP_DIR:-/opt/vaksina/app}"
BRANCH="${DEPLOY_BRANCH:-main}"
LOCK="/tmp/vaksina-auto-deploy.lock"
LOG="/var/log/vaksina-auto-deploy.log"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) skip: already running" >>"$LOG"
  exit 0
fi
cd "$APP_DIR"
if [[ ! -d .git ]]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: not a git repo" >>"$LOG"
  exit 1
fi
git fetch --quiet origin "$BRANCH"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [[ "$LOCAL" == "$REMOTE" ]]; then
  exit 0
fi
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) deploy $LOCAL -> $REMOTE" >>"$LOG"
git pull --ff-only origin "$BRANCH"
systemctl restart vaksina
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) OK restarted @ $(git rev-parse --short HEAD)" >>"$LOG"
EOF
fi
chmod 755 "$SCRIPT"
touch /var/log/vaksina-auto-deploy.log
chmod 644 /var/log/vaksina-auto-deploy.log

# .env da DEPLOY_SCRIPT (agar yo'q bo'lsa)
ENV_FILE="${ENV_FILE:-/opt/vaksina/.env}"
if [[ -f "$ENV_FILE" ]]; then
  if ! grep -q '^DEPLOY_SCRIPT=' "$ENV_FILE"; then
    echo "DEPLOY_SCRIPT=$SCRIPT" >>"$ENV_FILE"
    echo "    DEPLOY_SCRIPT qo'shildi → $ENV_FILE"
  fi
fi

cat >/etc/systemd/system/vaksina-auto-deploy.service <<EOF
[Unit]
Description=VaksinaMed auto-deploy (git pull + restart)
After=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR
Environment=DEPLOY_BRANCH=main
ExecStart=$SCRIPT
Nice=10
EOF

cat >/etc/systemd/system/vaksina-auto-deploy.timer <<'EOF'
[Unit]
Description=VaksinaMed auto-deploy timer (har 1 daqiqa)

[Timer]
OnBootSec=30s
OnUnitActiveSec=1min
AccuracySec=10s
Unit=vaksina-auto-deploy.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now vaksina-auto-deploy.timer
# Darhol bir marta ishga tushirish
systemctl start vaksina-auto-deploy.service || true

echo
systemctl list-timers vaksina-auto-deploy.timer --no-pager || true
echo
echo "[OK] Avto-deploy yoqildi."
echo "  • Push qilgach ~1 daqiqada sayt yangilanadi (timer)"
echo "  • GitHub Actions + CRON_SECRET bo'lsa — darhol /api/cron/deploy"
echo "  • Log: tail -f /var/log/vaksina-auto-deploy.log"
echo
echo "Bundan keyin Console kerak emas."
