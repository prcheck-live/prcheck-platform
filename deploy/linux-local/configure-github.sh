#!/usr/bin/env bash
# Points GitHub at the engine and makes PRCheck.live's verdict a merge gate.
# start.sh calls it with the current tunnel URL; safe to run again any time.
#   configure-github.sh https://<something>.trycloudflare.com
set -euo pipefail
QH=${PRCHECK_HOME:-$HOME/prcheck}
set -a; . "$QH/prcheck.env"; set +a
URL=${1:?public engine URL}
APP="$GH_ORG/vendorpay-app"
HOOK_URL="$URL/webhooks/github"

# Webhook: pull_request events, signed with WEBHOOK_SECRET
id=$(gh api "repos/$APP/hooks" --jq '.[] | select(.config.url | test("/webhooks/github$")) | .id' | head -1)
body=$(printf '{"active":true,"events":["pull_request"],"config":{"url":"%s","content_type":"json","secret":"%s","insecure_ssl":"0"}}' "$HOOK_URL" "$WEBHOOK_SECRET")
if [ -n "$id" ]; then echo "$body" | gh api -X PATCH "repos/$APP/hooks/$id" --input - >/dev/null
else echo "$body" | gh api -X POST "repos/$APP/hooks" --input - >/dev/null; fi
echo "ok       webhook $HOOK_URL on $APP"

# vendorpay-app main: PRCheck.live's status is required to merge
cat <<'JSON' | gh api -X PUT "repos/$APP/branches/main/protection" --input - >/dev/null
{ "required_status_checks": { "strict": false, "contexts": ["prcheck/assurance"] },
  "enforce_admins": false, "required_pull_request_reviews": null, "restrictions": null }
JSON
echo "ok       $APP main requires prcheck/assurance"

# vendorpay-policies main: valid, and approved by the owning authority (CODEOWNERS)
cat <<'JSON' | gh api -X PUT "repos/$GH_ORG/vendorpay-policies/branches/main/protection" --input - >/dev/null
{ "required_status_checks": { "strict": true, "contexts": ["validate"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "require_code_owner_reviews": true, "required_approving_review_count": 1 },
  "restrictions": null }
JSON
echo "ok       vendorpay-policies main requires validation and code-owner approval"
