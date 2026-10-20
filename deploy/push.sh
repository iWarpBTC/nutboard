#!/bin/sh
# Copy the code to the server and restart the service. Passkeys/sessions stay on the server (/var/lib/nutboard).
#   deploy/push.sh root@nutboard.lnpay.cz
set -eu
TARGET="${1:-root@nutboard.lnpay.cz}"
cd "$(dirname "$0")/.."
# Record what is being deployed; the server has no .git, so the footer reads this file.
commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
dirty=false; [ -z "$(git status --porcelain 2>/dev/null)" ] || dirty=true
printf '{"commit":"%s","dirty":%s,"builtAt":"%s"}\n' "$commit" "$dirty" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > build.json
rsync -az --delete --no-owner --no-group \
  --exclude .git --exclude node_modules --exclude data --exclude .claude --exclude .env --exclude '*.db' \
  ./ "$TARGET:/opt/nutboard/"
ssh -t "$TARGET" '
  set -e
  S=; [ "$(id -u)" -eq 0 ] || S=sudo
  cd /opt/nutboard && npm ci --omit=dev --no-audit --no-fund
  if [ -f /etc/systemd/system/nutboard.service ]; then
    $S systemctl restart nutboard && systemctl --no-pager --lines=5 status nutboard
  else
    echo "Code is in /opt/nutboard. Install the service next (deploy/README.md, step 5)."
  fi'
