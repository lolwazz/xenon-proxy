#!/usr/bin/env bash
# Runs ON the Lightsail server (Ubuntu 24.04), as root, from aws-deploy.sh.
# Safe to re-run: every step either installs once or replaces in place.
#
#   sudo bash aws-server-setup.sh "<site addresses>"
set -euo pipefail

SITES="$1"
UP=/home/ubuntu/xenon-upload
APP=/opt/xenon-proxy
WEB=/var/www/xenon
SAMPLES=/opt/xenon-samples
export DEBIAN_FRONTEND=noninteractive

say() { printf '\n==> %s\n' "$1"; }

# 1 GB of memory is enough to run the proxy but not always to npm install
# alongside it; a swap file stops the installer being killed.
if [ ! -f /swapfile ]; then
  say "swap"
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap -q /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  say "node 22"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi

if ! command -v caddy >/dev/null; then
  say "caddy (automatic https)"
  install -d -m 0755 /usr/share/keyrings
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

id xenon >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin xenon

say "proxy code"
mkdir -p "$APP"
tar -xf "$UP/proxy.tar" -C "$APP"
if [ -f "$UP/games.tar" ]; then
  say "games (large, this takes a minute)"
  rm -rf "$APP/public/g"
  tar -xf "$UP/games.tar" -C "$APP/public"
fi
if [ -f "$UP/samples.tar" ]; then
  say "studio samples"
  rm -rf "$SAMPLES" && mkdir -p "$SAMPLES"
  tar -xf "$UP/samples.tar" -C "$SAMPLES"
fi

say "dependencies"
cd "$APP"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error

# Secrets come over in their own file so they are never part of the code
# bundle or printed; everything else is fixed for this server.
{
  echo "PORT=8080"
  echo "SAMPLES_DIR=$SAMPLES"
  echo "CHAT_FILE=$APP/backend/data/chat.json"
  [ -f "$UP/secrets.env" ] && cat "$UP/secrets.env"
} > "$APP/.env"
chmod 600 "$APP/.env"
mkdir -p "$APP/backend/data"
chown -R xenon:xenon "$APP"
[ -d "$SAMPLES" ] && chown -R xenon:xenon "$SAMPLES"

cat > /etc/systemd/system/xenon.service <<'EOF'
[Unit]
Description=Xenon proxy
After=network-online.target
Wants=network-online.target

[Service]
User=xenon
WorkingDirectory=/opt/xenon-proxy
EnvironmentFile=/opt/xenon-proxy/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable xenon >/dev/null 2>&1
systemctl restart xenon

say "portal"
rm -rf "$WEB.new" && mkdir -p "$WEB.new"
tar -xf "$UP/site.tar" -C "$WEB.new"
rm -rf "$WEB.old"
[ -d "$WEB" ] && mv "$WEB" "$WEB.old"
mv "$WEB.new" "$WEB"
rm -rf "$WEB.old"

say "web server for: $SITES"
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
sed -e "s|{\$XENON_SITES}|$SITES|" -e "s|{\$XENON_ROOT:/var/www/xenon}|$WEB|" \
    -e "s|{\$XENON_LOG:/var/log/caddy/xenon.log}|/var/log/caddy/xenon.log|" \
    "$APP/deploy/Caddyfile.aws" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl reload caddy || systemctl restart caddy

say "checks"
for i in $(seq 1 20); do
  curl -fsS -o /dev/null http://127.0.0.1:8080/healthz && break
  sleep 1
done
curl -fsS http://127.0.0.1:8080/healthz >/dev/null && echo "  proxy: up" || { echo "  proxy: DOWN"; journalctl -u xenon -n 30 --no-pager; exit 1; }
df -h / | awk 'NR==2{print "  disk: " $3 " used of " $2}'
rm -rf "$UP"
echo "  done"
