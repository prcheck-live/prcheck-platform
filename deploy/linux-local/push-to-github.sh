#!/usr/bin/env bash
# Step 1. Creates the four repositories in your GitHub org and pushes them.
# Run it from the folder where you unzipped qivvra-all-repos.zip.
#
#   GH_ORG=ascendqe-demo deploy/linux-local/push-to-github.sh      (or: qivvra-platform/deploy/linux-local/push-to-github.sh)
#
# Needs the GitHub CLI signed in as an org owner: gh auth login
# PR #482's branch is pushed at commit 1 only, so you can push commits 2 and 3 live (demo-push.sh).
set -euo pipefail
: "${GH_ORG:?Set GH_ORG to your GitHub organisation}"
ROOT=$(pwd)
for r in vendorpay-app vendorpay-policies qivvra-verifiers qivvra-platform; do
  [ -d "$ROOT/$r/.git" ] || { echo "Run this from the folder that contains $r/"; exit 1; }
done
VISIBILITY=${VISIBILITY:-public}   # branch protection on private repos needs a paid GitHub plan

create() {
  if gh repo view "$GH_ORG/$1" >/dev/null 2>&1; then echo "exists   $GH_ORG/$1"
  else gh repo create "$GH_ORG/$1" --"$VISIBILITY" --description "$2" >/dev/null && echo "created  $GH_ORG/$1"; fi
}

create vendorpay-app      "VendorPay: reference supplier-payments app assured by QIVVRA"
create vendorpay-policies "VendorPay policy-as-code: the rules QIVVRA assures against"
create qivvra-verifiers   "QIVVRA independent verifiers V1-V5 for VendorPay"
create qivvra-platform    "QIVVRA engine: independent change assurance"

push() { git -C "$ROOT/$1" remote remove origin 2>/dev/null || true; git -C "$ROOT/$1" remote add origin "https://github.com/$GH_ORG/$1.git"; }

push vendorpay-policies; git -C "$ROOT/vendorpay-policies" push -q -u origin main
push qivvra-verifiers;   git -C "$ROOT/qivvra-verifiers"   push -q -u origin main
push qivvra-platform;    git -C "$ROOT/qivvra-platform"    push -q -u origin main
push vendorpay-app
git -C "$ROOT/vendorpay-app" push -q -u origin main
git -C "$ROOT/vendorpay-app" push -q -f origin demo-commit-1 demo-commit-2 demo-commit-3   # the three PR commits, for demo-push.sh
# The first commit of PR #482 only; demo-push.sh 2 and 3 bring the rest.
git -C "$ROOT/vendorpay-app" push -q -f origin 8cafa75:refs/heads/feature/VP-184-bank-change
echo "pushed   all repositories"

# Teams referenced by CODEOWNERS in vendorpay-policies
for t in finance-controls security compliance platform-eng qivvra-assurance-leads; do
  gh api "orgs/$GH_ORG/teams/$t" >/dev/null 2>&1 || gh api -X POST "orgs/$GH_ORG/teams" -f name="$t" -f privacy=closed >/dev/null
  gh api -X PUT "orgs/$GH_ORG/teams/$t/repos/$GH_ORG/vendorpay-policies" -f permission=push >/dev/null
done
echo "teams    finance-controls, security, compliance, platform-eng, qivvra-assurance-leads"

# CODEOWNERS names the "vendorpay" org; point it at yours.
if grep -q "@vendorpay/" "$ROOT/vendorpay-policies/CODEOWNERS" && [ "$GH_ORG" != vendorpay ]; then
  ( cd "$ROOT/vendorpay-policies"
    sed -i "s#@vendorpay/#@$GH_ORG/#g" CODEOWNERS policies/*/*.yaml profiles/*.yaml
    npm ci --silent >/dev/null 2>&1 || true
    git commit -qam "Point CODEOWNERS and policy owners at @$GH_ORG teams" && git push -q )
  echo "updated  policy owners to @$GH_ORG/*"
fi

echo
echo "Next: on the Linux machine, run setup.sh (it clones these repos)."
echo "PR #482 is opened later by demo-push.sh 1, once the engine and runner are up."
