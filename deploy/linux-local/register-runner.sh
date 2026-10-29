#!/usr/bin/env bash
# Step 3. Registers this machine as a self-hosted GitHub Actions runner for
# <ORG>/vendorpay-app with the label "qivvra-qe". qe-local.yml runs on it.
# Needs: gh auth login (as a repo admin).
set -euo pipefail
QH=${QIVVRA_HOME:-$HOME/qivvra}
set -a; . "$QH/qivvra.env"; set +a
RUNNER="$QH/actions-runner"
REPO="$GH_ORG/vendorpay-app"

if [ ! -x "$RUNNER/config.sh" ]; then
  mkdir -p "$RUNNER"
  version=$(gh api repos/actions/runner/releases/latest --jq .tag_name | sed 's/^v//')
  arch=$(uname -m); case $arch in x86_64) arch=x64;; aarch64|arm64) arch=arm64;; esac
  curl -fsSL "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-$arch-$version.tar.gz" | tar -xz -C "$RUNNER"
  echo "ok       downloaded runner $version"
fi
if [ ! -f "$RUNNER/.runner" ]; then
  token=$(gh api -X POST "repos/$REPO/actions/runners/registration-token" --jq .token)
  (cd "$RUNNER" && ./config.sh --unattended --url "https://github.com/$REPO" --token "$token" \
     --name "qivvra-qe-$(hostname)" --labels qivvra-qe --work _work --replace)
fi
# Only run workflows from branches in this repository, never from forks (also enforced in qe-local.yml).
gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors >/dev/null 2>&1 \
  || echo "note     set Settings → Actions → General → 'Require approval for all external contributors' by hand"
echo "ok       runner registered for $REPO (label qivvra-qe). start.sh runs it."
