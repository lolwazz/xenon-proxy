#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu 22.04/24.04 VPS.
# Run as root:  bash setup.sh your-domain.com
set -euo pipefail

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then echo "usage: bash setup.sh your-domain.com"; exit 1; fi

echo "==> installing node, git, caddy"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -y -qq nodejs

# Caddy gives us automatic HTTPS with no certificate faff. The portal is https,
# so the proxy MUST be https too or browsers block it as mixed content.
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy

echo "==> fetching xenon-proxy"
mkdir -p /opt
if [ -d /opt/xenon-proxy/.git ]; then
  git -C /opt/xenon-proxy pull --ff-only
else
  git clone --depth 1 https://github.com/lolwazz/xenon-proxy.git /opt/xenon-proxy
fi
cd /opt/xenon-proxy
npm install --omit=dev --ignore-scripts

echo "==> config"
[ -f .env ] || printf 'PORT=8080\n' > .env

echo "==> caddy"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	# Everything goes to the proxy, WebSockets included - Caddy forwards
	# upgrades by default, which wisp needs.
	reverse_proxy 127.0.0.1:8080
	encode zstd gzip
}
EOF
systemctl reload caddy || systemctl restart caddy

echo "==> service"
cat > /etc/systemd/system/xenon.service <<'EOF'
[Unit]
Description=Xenon proxy
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/xenon-proxy
EnvironmentFile=/opt/xenon-proxy/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now xenon

echo
echo "done. checking..."
sleep 3
curl -fsS "http://127.0.0.1:8080/healthz" && echo
echo "Your proxy: https://$DOMAIN"
echo "Games go in /opt/xenon-proxy/public/g/ - upload them with scp."
