#!/usr/bin/env bash
# Puts the portal and the proxy on the Lightsail server. Run from Git Bash:
#
#   bash deploy/aws-deploy.sh <static-ip>             first time: everything
#   bash deploy/aws-deploy.sh <static-ip> --no-games  later: skip the 4 GB games folder
#
# The SSH key defaults to the newest LightsailDefaultKey-*.pem in Downloads.
# Override with KEY=/path/to/key.pem.
set -euo pipefail

IP="${1:?usage: aws-deploy.sh <static-ip> [--no-games] [--no-samples]}"
shift
GAMES=1; SAMPLES=1
for a in "$@"; do
  case "$a" in
    --no-games) GAMES=0 ;;
    --no-samples) SAMPLES=0 ;;
    *) echo "unknown option: $a"; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "$0")/.." && pwd)"
SITE="$(cd "$HERE/../xenon-site" && pwd)"
DOMAIN=xenonsschoollearning.online

KEY="${KEY:-$(ls -t "$HOME"/Downloads/LightsailDefaultKey*.pem 2>/dev/null | head -1)}"
[ -f "$KEY" ] || { echo "no SSH key found - download it from Lightsail > Account > SSH keys"; exit 1; }
chmod 600 "$KEY" 2>/dev/null || true
SSH=(ssh -i "$KEY" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 "ubuntu@$IP")

# The domain only goes into the certificate request once DNS points here,
# otherwise Let's Encrypt fails validation and starts rate-limiting it.
SITES="${IP//./-}.sslip.io"
resolved="$(nslookup "$DOMAIN" 1.1.1.1 2>/dev/null | awk '/^Address/ && !/#53/ {print $2}' | tr '\n' ' ')"
if [[ " $resolved " == *" $IP "* ]]; then
  SITES="$DOMAIN, www.$DOMAIN, $SITES"
  echo "==> $DOMAIN points here - including it"
else
  echo "==> $DOMAIN does not point at $IP yet ($resolved) - using https://$SITES for now"
fi

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

echo "==> packing"
tar -cf "$OUT/proxy.tar" -C "$HERE" \
  --exclude=./node_modules --exclude=./.git --exclude=./vendor --exclude=./public/g \
  --exclude='./.env' --exclude='*.log' --exclude='*.bak' --exclude=./s3site --exclude=./p.html \
  --exclude=./Caddyfile --exclude=./Caddyfile.bak .
tar -cf "$OUT/site.tar" -C "$SITE" .
[ "$GAMES" = 1 ] && tar -cf "$OUT/games.tar" -C "$HERE/public" g
if [ "$SAMPLES" = 1 ]; then
  sd="$(grep -E '^SAMPLES_DIR=' "$HERE/.env" | head -1 | cut -d= -f2- | tr -d '"')"
  if [ -n "$sd" ] && [ -d "$(cygpath -u "$sd" 2>/dev/null || echo "$sd")" ]; then
    tar -cf "$OUT/samples.tar" -C "$(cygpath -u "$sd" 2>/dev/null || echo "$sd")" .
  fi
fi
# Only the proxy password carries over; the WordPress and DuckDNS settings
# belong to the old setup.
grep -E '^(XENON_PASSWORD|XENON_SECRET)=' "$HERE/.env" > "$OUT/secrets.env" || true
cp "$HERE/deploy/aws-server-setup.sh" "$OUT/"
du -sh "$OUT"/* | sed 's|'"$OUT"'/|    |'

echo "==> uploading to $IP (the games folder takes a while the first time)"
"${SSH[@]}" 'mkdir -p ~/xenon-upload'
scp -i "$KEY" -o StrictHostKeyChecking=accept-new "$OUT"/* "ubuntu@$IP:xenon-upload/"

echo "==> setting up the server"
"${SSH[@]}" "sudo bash ~/xenon-upload/aws-server-setup.sh '$SITES'"

echo
echo "==> live at:"
IFS=',' read -ra hosts <<< "$SITES"
for h in "${hosts[@]}"; do echo "    https://$(echo "$h" | xargs)/"; done
