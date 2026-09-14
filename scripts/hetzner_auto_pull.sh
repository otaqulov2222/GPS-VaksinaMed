#!/bin/bash
# Hetzner: GitHub'dagi yangi commit bo'lsa — pull + restart.
# systemd timer (har 1 daqiqa) yoki /api/cron/deploy chaqiradi.
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
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ERROR: $APP_DIR is not a git repo" >>"$LOG"
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
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) OK restarted vaksina @ $(git rev-parse --short HEAD)" >>"$LOG"
