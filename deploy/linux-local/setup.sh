#!/usr/bin/env bash
# Step 2. Prepares one Linux machine (Ubuntu 22.04/24.04 or Debian 12) to run
# QE, the QIVVRA engine and a GitHub Actions runner.
#
#   setup.sh                 check prerequisites and set everything up
#   setup.sh --install       also install missing packages with apt (asks for sudo)
#
# Before running: cp qivvra.env.example ~/qivvra/qivvra.env and fill it in.
set -euo pipefail
QH=${QIVVRA_HOME:-$HOME/qivvra}
KIT=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$QH"/{repos,qe,team-results,data,logs}
[ -f "$QH/qivvra.env" ] || { cp "$KIT/qivvra.env.example" "$QH/qivvra.env"; echo "Created $QH/qivvra.env. Fill it in, then run setup.sh again."; exit 1; }
set -a; . "$QH/qivvra.env"; set +a
: "${GH_ORG:?GH_ORG missing in qivvra.env}"

# 1. Prerequisites
need=()
command -v git >/dev/null || need+=(git)
command -v curl >/dev/null || need+=(curl)
command -v psql >/dev/null || need+=(postgresql)
command -v setsid >/dev/null || need+=(util-linux)
node_major=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
[ "${node_major:-0}" -ge 22 ] || need+=(nodejs22)
command -v cloudflared >/dev/null || need+=(cloudflared)
command -v gh >/dev/null || need+=(gh)
if [ ${#need[@]} -gt 0 ]; then
  echo "Missing: ${need[*]}"
  if [ "${1:-}" != --install ]; then echo "Run: setup.sh --install   (or install them yourself)"; exit 1; fi
  sudo apt-get update -qq
  for p in "${need[@]}"; do case $p in
    nodejs22) curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y -qq nodejs ;;
    cloudflared) arch=$(dpkg --print-architecture); curl -fsSLo /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch.deb" && sudo dpkg -i /tmp/cloudflared.deb ;;
    gh) sudo apt-get install -y -qq gh ;;
    postgresql) sudo apt-get install -y -qq postgresql && sudo systemctl enable --now postgresql ;;
    *) sudo apt-get install -y -qq "$p" ;;
  esac; done
fi
echo "ok       prerequisites (node $(node -v), $(psql --version | head -1))"

# 2. Databases
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname='vendorpay'" | grep -q 1 || sudo -u postgres psql -qc "CREATE ROLE vendorpay LOGIN PASSWORD 'vendorpay'"
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_database WHERE datname='vendorpay'" | grep -q 1 || sudo -u postgres psql -qc "CREATE DATABASE vendorpay OWNER vendorpay"
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_roles WHERE rolname='qivvra'" | grep -q 1 || sudo -u postgres psql -qc "CREATE ROLE qivvra LOGIN PASSWORD 'qivvra'"
sudo -u postgres psql -qtAc "SELECT 1 FROM pg_database WHERE datname='qivvra'" | grep -q 1 || sudo -u postgres psql -qc "CREATE DATABASE qivvra OWNER qivvra"
echo "ok       databases vendorpay and qivvra"

# 3. Repositories (QIVVRA's side only; VendorPay is checked out by the runner per commit)
for r in vendorpay-policies qivvra-verifiers qivvra-platform vendorpay-app; do
  if [ -d "$QH/repos/$r/.git" ]; then git -C "$QH/repos/$r" pull -q --ff-only
  else git clone -q "https://github.com/$GH_ORG/$r.git" "$QH/repos/$r"; fi
done
(cd "$QH/repos/vendorpay-policies" && npm ci --no-audit --no-fund --loglevel=error && npm run -s validate)
(cd "$QH/repos/qivvra-verifiers" && npm ci --no-audit --no-fund --loglevel=error && npx playwright install chromium)
(cd "$QH/repos/qivvra-platform" && npm ci --no-audit --no-fund --loglevel=error && npx tsc -p .)
echo "ok       repositories in $QH/repos"
if [ "${1:-}" = --install ]; then (cd "$QH/repos/qivvra-verifiers" && sudo npx playwright install-deps chromium >/dev/null); echo "ok       Chromium system libraries"
else echo "note     if Chromium fails to start, run once: (cd $QH/repos/qivvra-verifiers && sudo npx playwright install-deps chromium)"; fi

# 4. Engine configuration and database
sed "s#__ORG__#$GH_ORG#g" "$KIT/qivvra.config.yaml" > "$QH/qivvra.config.yaml"
(cd "$QH/repos/qivvra-platform" && QIVVRA_CONFIG="$QH/qivvra.config.yaml" node dist/migrate.js)
echo "ok       engine config $QH/qivvra.config.yaml"

# 5. First QE deploy: VendorPay main
"$KIT/qe-deploy.sh" "$QH/repos/vendorpay-app" || true
echo
echo "Setup complete. Next: register-runner.sh, then start.sh."
