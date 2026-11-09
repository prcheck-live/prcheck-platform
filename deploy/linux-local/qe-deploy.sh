#!/usr/bin/env bash
# Deploys one VendorPay commit to the local QE environment (port 3000) and runs the
# team's own Playwright suite against it. Called by the self-hosted runner from
# vendorpay-app/.github/workflows/qe-local.yml; you can also run it by hand.
#
#   qe-deploy.sh <checkout-dir>
#
# Writes:  ~/prcheck/qe/releases/<sha>/        the build
#          ~/prcheck/qe/app.log                the app log (PRCheck.live's V4 reads it)
#          ~/prcheck/team-results/<sha>/junit.xml   the team's results (PRCheck.live's Xray input)
set -euo pipefail
SRC=$(cd "${1:?checkout dir}" && pwd)
QH=${PRCHECK_HOME:-$HOME/prcheck}
[ -f "$QH/prcheck.env" ] && set -a && . "$QH/prcheck.env" && set +a
DB=${VENDORPAY_DATABASE_URL:-postgres://vendorpay:vendorpay@localhost:5432/vendorpay}
SHA=$(git -C "$SRC" rev-parse --short=7 HEAD)
REL="$QH/qe/releases/$SHA"
mkdir -p "$QH/qe/releases" "$QH/team-results"
echo "QE deploy $SHA from $SRC"

# 1. Build this exact commit
rm -rf "$REL"; mkdir -p "$REL"
(cd "$SRC" && git archive HEAD) | tar -x -C "$REL"
cd "$REL"
npm ci --no-audit --no-fund --loglevel=error
npx tsc -p .

# 2. Replace the running QE app
if [ -f "$QH/qe/qe.pid" ] && kill -0 "$(cat "$QH/qe/qe.pid")" 2>/dev/null; then
  kill "$(cat "$QH/qe/qe.pid")"; for _ in $(seq 1 50); do kill -0 "$(cat "$QH/qe/qe.pid")" 2>/dev/null || break; sleep 0.2; done
fi
DATABASE_URL=$DB node dist/db/reset.js            # fresh demo data for every deploy
: > "$QH/qe/app.log"
# RUNNER_TRACKING_ID="" stops the Actions runner from killing the app when the job ends.
RUNNER_TRACKING_ID="" DATABASE_URL=$DB GIT_SHA=$SHA APP_ENV=qe PORT=3000 LOG_FILE="$QH/qe/app.log" \
  setsid nohup node dist/server.js >> "$QH/qe/server.out" 2>&1 < /dev/null &
echo $! > "$QH/qe/qe.pid"
ln -sfn "$REL" "$QH/qe/current"
for _ in $(seq 1 100); do curl -fs http://localhost:3000/health >/dev/null && break; sleep 0.2; done
RUNNING=$(curl -fs http://localhost:3000/version | sed -E 's/.*"gitSha":"([^"]*)".*/\1/')
[ "$RUNNING" = "$SHA" ] || { echo "QE reports $RUNNING, expected $SHA"; exit 1; }
echo "QE now runs $SHA"

# 3. The team's own tests against QE, saved for PRCheck.live as the Xray input
rc=0
BASE_URL=http://localhost:3000 npx playwright test || rc=$?
mkdir -p "$QH/team-results/$SHA"
cp test-results/junit.xml "$QH/team-results/$SHA/junit.xml"
echo "Team results saved to $QH/team-results/$SHA/junit.xml"

# Keep the last five builds
ls -1dt "$QH"/qe/releases/*/ 2>/dev/null | tail -n +6 | while read -r old; do [ "$(readlink -f "$QH/qe/current")/" = "$old" ] || rm -rf "$old"; done
exit $rc
