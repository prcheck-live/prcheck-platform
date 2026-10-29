#!/usr/bin/env bash
# Step 4. Starts everything on this machine and points GitHub at it:
#   cloudflared tunnel → public URL for the engine (it changes on every start)
#   QIVVRA engine on :4000
#   GitHub Actions runner (QE deploys)
#   QE (VendorPay) is already running from the last deploy
# then updates the GitHub webhook and branch protection (configure-github.sh).
set -euo pipefail
QH=${QIVVRA_HOME:-$HOME/qivvra}
KIT=$(cd "$(dirname "$0")" && pwd)
set -a; . "$QH/qivvra.env"; set +a
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# Tunnel
if ! alive "$QH/logs/tunnel.pid"; then
  : > "$QH/logs/tunnel.log"
  setsid nohup cloudflared tunnel --no-autoupdate --url http://localhost:4000 >> "$QH/logs/tunnel.log" 2>&1 < /dev/null &
  echo $! > "$QH/logs/tunnel.pid"
fi
URL=""
for _ in $(seq 1 60); do URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$QH/logs/tunnel.log" | head -1 || true); [ -n "$URL" ] && break; sleep 1; done
[ -n "$URL" ] || { echo "Tunnel did not start; see $QH/logs/tunnel.log"; exit 1; }
sed -i "s#^QIVVRA_PUBLIC_URL=.*#QIVVRA_PUBLIC_URL=$URL#" "$QH/qivvra.env"
echo "ok       tunnel $URL"

# Engine (restarted so it picks up the new public URL)
alive "$QH/logs/engine.pid" && kill "$(cat "$QH/logs/engine.pid")" && sleep 1
(cd "$QH/repos/qivvra-platform" && git pull -q --ff-only && npx tsc -p .)
( cd "$QH/repos/qivvra-platform"
  QIVVRA_CONFIG="$QH/qivvra.config.yaml" QIVVRA_PUBLIC_URL=$URL setsid nohup node dist/server.js >> "$QH/logs/engine.log" 2>&1 < /dev/null &
  echo $! > "$QH/logs/engine.pid" )
for _ in $(seq 1 50); do curl -fs http://localhost:4000/health >/dev/null && break; sleep 0.2; done
curl -fs http://localhost:4000/health >/dev/null || { echo "Engine did not start; see $QH/logs/engine.log"; exit 1; }
curl -fs "$URL/health" >/dev/null && echo "ok       engine reachable at $URL" || echo "warn     engine not yet reachable through the tunnel (DNS can take a minute)"

# Runner
if [ -f "$QH/actions-runner/.runner" ] && ! alive "$QH/logs/runner.pid"; then
  ( cd "$QH/actions-runner"
    setsid nohup ./run.sh >> "$QH/logs/runner.log" 2>&1 < /dev/null &
    echo $! > "$QH/logs/runner.pid" )
  echo "ok       Actions runner started"
elif [ ! -f "$QH/actions-runner/.runner" ]; then echo "warn     no runner registered yet: run register-runner.sh"; fi

# QE
curl -fs http://localhost:3000/version >/dev/null && echo "ok       QE runs $(curl -s http://localhost:3000/version | sed -E 's/.*"gitSha":"([^"]*)".*/\1/')" \
  || echo "warn     QE is not running; it starts on the next deploy (or run qe-deploy.sh $QH/repos/vendorpay-app)"

"$KIT/configure-github.sh" "$URL"
echo
echo "QIVVRA UI:  $URL   (also http://localhost:4000)"
echo "Logs:       $QH/logs/"
