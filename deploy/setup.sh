#!/usr/bin/env bash
# Sets up the Xenon proxy on a fresh Ubuntu 22.04/24.04 VPS.
#
#   bash setup.sh                      -> HTTPS on <your-ip>.sslip.io
#   bash setup.sh proxy.example.com    -> HTTPS on your own domain
#
# sslip.io resolves any dashed IP to that IP, so Let's Encrypt will issue a
# real certificate without you owning or configuring any DNS. That matters
# because the portal is https and browsers block an http proxy as mixed
# content - self-signed would mean a click-through warning every visit.
set -euo pipefail

command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl; }

DOMAIN="${1:-}"
if [ -z "$DOMAIN" ]; then
  IP="$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me)"
  [ -n "$IP" ] || { echo "could not detect public IP; pass a domain instead"; exit 1; }
  DOMAIN="${IP//./-}.sslip.io"
  echo "==> no domain given, using $DOMAIN"
fi

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git ca-certificates gnupg ufw fail2ban
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
apt-get install -y -qq nodejs

echo "==> caddy (automatic https)"
install -d -m 0755 /usr/share/keyrings
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy

echo "==> firewall + brute-force protection"
# This box gets automated root login attempts within minutes of booting.
ufw allow 22/tcp  >/dev/null
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban >/dev/null 2>&1 || true

echo "==> xenon-proxy"
mkdir -p /opt
if [ -d /opt/xenon-proxy/.git ]; then
  git -C /opt/xenon-proxy pull --ff-only
else
  git clone --depth 1 https://github.com/lolwazz/xenon-proxy.git /opt/xenon-proxy
fi
cd /opt/xenon-proxy
npm install --omit=dev --ignore-scripts
[ -f .env ] || printf 'PORT=8080\n' > .env
mkdir -p public/g

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	# Caddy forwards WebSocket upgrades by default, which wisp needs.
	reverse_proxy 127.0.0.1:8080
	encode zstd gzip
}
EOF
systemctl restart caddy

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

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now xenon

echo "==> checking"
sleep 4
curl -fsS http://127.0.0.1:8080/healthz && echo
echo
echo "=============================================="
echo "  https://$DOMAIN"
echo "=============================================="
echo "Games are not in git. Upload them from your PC:"
echo "  scp -r public/g root@$(curl -fsS --max-time 5 https://api.ipify.org || echo YOUR_IP):/opt/xenon-proxy/public/"
