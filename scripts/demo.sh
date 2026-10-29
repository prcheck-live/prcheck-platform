#!/usr/bin/env bash
# End-to-end demo of QIVVRA on VendorPay PR #482, all on one machine.
#
# For each commit of the PR it plays every actor:
#   QE deploy   builds that commit and runs it on :3000 with GIT_SHA set   (stand-in for deploy-qe.yml)
#   Team CI     runs the team's own Playwright suite, JUnit for Xray        (stand-in for ci.yml)
#   GitHub      sends a signed pull_request webhook to the engine
#   QIVVRA      gathers, freezes, verifies, decides and reports              (the real engine)
#
#   scripts/demo.sh            # default: PR #482 commits 8cafa75 88b666a aaf2a60
#
# Needs PostgreSQL on localhost:5432 with the vendorpay and qivvra databases, and ports 3000 and 4000 free.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
APP=$(cd "$HERE/../vendorpay-app" && pwd)
COMMITS=("${@:-8cafa75 88b666a aaf2a60}")
COMMITS=(${COMMITS[@]})
export WEBHOOK_SECRET=${WEBHOOK_SECRET:-qivvra-demo-secret}
unset QIVVRA_GITHUB_TOKEN   # demo reports go to the outbox, never to a real repository
TITLE="VP-184: Let Procurement change a supplier's bank account"
mkdir -p "$HERE/data/qe" "$HERE/data/team-results" "$HERE/data/worktrees"

pids=()
cleanup() { for p in "${pids[@]:-}"; do kill "$p" 2>/dev/null || true; done; wait 2>/dev/null || true; }
trap cleanup EXIT

wait_http() { for _ in $(seq 1 100); do curl -fs "$1" >/dev/null && return 0; sleep 0.2; done; echo "timeout waiting for $1"; return 1; }

# QIVVRA engine
(cd "$HERE" && npx tsc -p . && exec node dist/server.js > "$HERE/data/engine.log" 2>&1) & ENGINE=$!; pids+=($ENGINE)
wait_http http://localhost:4000/health
echo "QIVVRA engine running on http://localhost:4000"

action=opened
for C in "${COMMITS[@]}"; do
  SHA=$(git -C "$APP" rev-parse --short "$C"); FULL=$(git -C "$APP" rev-parse "$C")
  echo; echo "=== PR #482 @ $SHA  $(git -C "$APP" log -1 --format=%s "$SHA")"

  # QE deploy of exactly this commit
  WT="$HERE/data/worktrees/$SHA"; rm -rf "$WT"; git -C "$APP" worktree prune
  git -C "$APP" worktree add --detach -q "$WT" "$SHA"; ln -s "$APP/node_modules" "$WT/node_modules"
  (cd "$WT" && npx tsc -p . && node dist/db/reset.js >/dev/null)
  : > "$HERE/data/qe/app.log"
  (cd "$WT" && GIT_SHA=$SHA APP_ENV=qe LOG_FILE="$HERE/data/qe/app.log" exec node dist/server.js >/dev/null 2>&1) & QE=$!
  wait_http http://localhost:3000/health
  echo "QE      running $(curl -s localhost:3000/version | sed -E 's/.*"gitSha":"([^"]*)".*/\1/')"

  # Team CI: their own tests, as imported to Xray
  (cd "$WT" && BASE_URL=http://localhost:3000 npx playwright test >/dev/null 2>&1) || true
  mkdir -p "$HERE/data/team-results/$SHA"; cp "$WT/test-results/junit.xml" "$HERE/data/team-results/$SHA/junit.xml"
  echo "Team CI $(grep -o 'tests="[0-9]*"' "$WT/test-results/junit.xml" | head -1) failures: $(grep -o 'failures="[0-9]*"' "$WT/test-results/junit.xml" | head -1)"

  # GitHub: pull_request webhook
  RESP=$(node "$HERE/scripts/send-webhook.mjs" http://localhost:4000/webhooks/github "$action" vendorpay/vendorpay-app 482 "$FULL" feature/VP-184-bank-change main "$TITLE")
  ID=$(echo "$RESP" | sed -E 's/.*"assessmentId":"([^"]*)".*/\1/')
  case "$ID" in ASM-*) ;; *) echo "Webhook failed: $RESP"; tail -20 "$HERE/data/engine.log"; exit 1;; esac
  echo "GitHub  webhook → $ID"
  action=synchronize

  # Wait for QIVVRA's decision
  for _ in $(seq 1 300); do
    ST=$(curl -s "http://localhost:4000/api/assessments/$ID" | sed -E 's/.*"status":"([a-z_]*)".*/\1/' | head -1)
    [ "$ST" = done ] || [ "$ST" = failed ] && break
    kill -0 $ENGINE 2>/dev/null || { echo "Engine stopped:"; tail -20 "$HERE/data/engine.log"; exit 1; }
    sleep 1
  done
  curl -s "http://localhost:4000/api/assessments/$ID" | node -e '
    const { assessment: a, obligations: o } = JSON.parse(require("fs").readFileSync(0, "utf8"));
    console.log(`QIVVRA  ${a.disposition.replace(/_/g, " ")} — ${a.summary.because ?? a.error}`);
    for (const x of o.filter((x) => x.state !== "SUPPORTED")) console.log(`        ${x.state.padEnd(13)} ${x.obligation_id} ${x.statement}`);'

  kill $QE 2>/dev/null || true; wait $QE 2>/dev/null || true
  git -C "$APP" worktree remove --force "$WT"
done

echo; echo "Reports: $HERE/data/outbox/<assessment>/pr-comment.md   UI: http://localhost:4000 (while the engine runs)"
