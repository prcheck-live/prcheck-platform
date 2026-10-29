#!/usr/bin/env bash
# Step 5. The live demo. Each step pushes one commit of the VP-184 change and
# GitHub, the runner and QIVVRA do the rest. Watch the PR page and the QIVVRA UI.
#
#   demo-push.sh 1      open the PR at commit 1 (two defects)          → expect NOT READY
#   demo-push.sh 2      push commit 2 (self-approval fixed)            → expect NOT READY
#   demo-push.sh 3      push commit 3 (scheduled payments held)        → expect READY, merge unblocked
#   demo-push.sh reset  force the branch back to commit 1 for another run
set -euo pipefail
QH=${QIVVRA_HOME:-$HOME/qivvra}
set -a; . "$QH/qivvra.env"; set +a
APP="$GH_ORG/vendorpay-app"
DIR="$QH/repos/vendorpay-app"
BRANCH=feature/VP-184-bank-change
TITLE="VP-184: Let Procurement change a supplier's bank account"
git -C "$DIR" fetch -q --tags origin

push_commit() { git -C "$DIR" push -q -f origin "demo-commit-$1^{commit}:refs/heads/$BRANCH"; echo "pushed   commit $1 ($(git -C "$DIR" rev-parse --short=7 "demo-commit-$1^{commit}")) to $BRANCH"; }

case "${1:?1, 2, 3 or reset}" in
  1|reset)
    push_commit 1
    pr=$(gh pr list -R "$APP" --head "$BRANCH" --state open --json number --jq '.[0].number')
    if [ -z "$pr" ]; then
      pr=$(gh pr create -R "$APP" --base main --head "$BRANCH" --title "$TITLE" --body "$(cat <<'EOF'
Implements VP-184: Procurement can change a supplier's bank account, approved by Finance.

- New bank change request and approval flow
- Proposed account stays inactive until approved, masked everywhere
- Every step recorded in the audit trail

All acceptance criteria are covered by the team's tests.
EOF
)" | grep -oE '[0-9]+$')
      echo "opened   PR #$pr"
    else echo "updated  PR #$pr"; fi
    ;;
  2|3) push_commit "$1" ;;
  *) echo "Use 1, 2, 3 or reset"; exit 2 ;;
esac
pr=$(gh pr list -R "$APP" --head "$BRANCH" --state open --json number --jq '.[0].number')
echo
echo "PR:      https://github.com/$APP/pull/$pr"
echo "QIVVRA:  ${QIVVRA_PUBLIC_URL:-http://localhost:4000}"
echo "The runner deploys the commit to QE (about 1-2 minutes), then QIVVRA verifies and posts its verdict."
