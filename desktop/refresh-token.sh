#!/bin/bash
# Keep $AWS_WEB_IDENTITY_TOKEN_FILE current: the signed-in user's Cognito ID
# token, fetched from the website with this desktop's own key. The AWS CLI and
# mount-s3 trade it for AWS credentials in the user's name
# (AssumeRoleWithWebIdentity), so the bucket sees the user, not the machine.
# Runs at boot and then every 15 minutes; tokens last an hour.
set -euo pipefail
set -a; . /etc/annotate/session.env; . /etc/annotate/secrets.env; set +a

tmp=$(mktemp "$(dirname "$AWS_WEB_IDENTITY_TOKEN_FILE")/.token.XXXXXX")   # root-only, like the token
trap 'rm -f "$tmp"' EXIT
curl -sfS --retry 5 --retry-all-errors --max-time 30 \
  -H "authorization: Bearer $DESKTOP_KEY" \
  "$SITE_URL/api/desktop/token?session=$SESSION_ID" -o "$tmp"
mv "$tmp" "$AWS_WEB_IDENTITY_TOKEN_FILE"
