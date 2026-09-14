#!/bin/bash
# Bir martalik: Hetzner'da avto-deploy o'rnatish.
# Ishlatish (SSH root):
#   bash scripts/install_hetzner_auto_deploy.sh
# yoki bu faylni serverga nusxa qilib ishga tushiring.
set -euo pipefail

APP_DIR=/opt/vaksina/app
SCRIPT=/opt/vaksina/hetzner_auto_pull.sh

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
chmod 755 "$SCRIPT"

cat >/etc/systemd/system/vaksina-auto-deploy.service <<'EOF'
[Unit]
Description=VaksinaMed auto-deploy (git pull + restart)
After=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=/opt/vaksina/app
Environment=DEPLOY_BRANCH=main
ExecStart=/opt/vaksina/hetzner_auto_pull.sh
Nice=10
EOF

cat >/etc/systemd/system/vaksina-auto-deploy.timer <<'EOF'
[Unit]
Description=VaksinaMed auto-deploy timer (har 1 daqiqa)

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=15s
Unit=vaksina-auto-deploy.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now vaksina-auto-deploy.timer
systemctl list-timers vaksina-auto-deploy.timer --no-pager
echo "[OK] Avto-deploy yoqildi. Push qilgach ~1 daqiqada sayt yangilanadi."
