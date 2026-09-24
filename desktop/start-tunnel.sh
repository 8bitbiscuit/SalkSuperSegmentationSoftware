#!/bin/bash
# The tunnel from Cloudflare to this desktop's DCV web client. With a domain,
# the website made a named tunnel and TUNNEL_TOKEN runs it. Without one, a
# quick tunnel gets a random trycloudflare.com address, which is sent to the
# website so it can link to the desktop. A restart gets a new address, sent again.
set -euo pipefail
if [ -n "${TUNNEL_TOKEN:-}" ]; then exec cloudflared --no-autoupdate tunnel run; fi

log=${QUICK_TUNNEL_LOG:-/run/quick-tunnel.log}   # overridable for desktop/tests
cloudflared --no-autoupdate tunnel --url https://localhost:8443 --no-tls-verify 2>"$log" &
tunnel=$!

address=
for _ in $(seq 120); do
  address=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$log" | grep -v -m1 '//api\.' || true)
  [ -n "$address" ] && break
  kill -0 "$tunnel" 2>/dev/null || break
  sleep 1
done
if [ -z "$address" ]; then
  cat "$log" >&2
  echo "cloudflared gave no quick tunnel address" >&2
  exit 1
fi

curl -sfS --retry 5 --retry-all-errors --max-time 30 \
  -H "authorization: Bearer $DESKTOP_KEY" --data "$address" \
  "$SITE_URL/api/desktop/address?session=$SESSION_ID"
wait "$tunnel"
