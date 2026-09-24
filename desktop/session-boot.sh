#!/bin/bash
# Turn /etc/annotate/session.env, written by cloud-init from the website's
# user data, into a desktop: the region at /session/$REGION, napari running
# in a DCV session, and the tunnel up. Runs once at boot, as root.
set -euo pipefail

run=/run/annotate
region_dir=/session/$REGION
install -d -o annotate -g annotate "$run" /session "$region_dir" "$region_dir/images" "$region_dir/masks" /session/resume

# napari has a Python console, so the annotator effectively has a shell. Keep
# them off instance metadata: no role credentials, no user data (tunnel token).
iptables -I OUTPUT -m owner --uid-owner annotate -d 169.254.169.254 -j REJECT

# Everything below that touches the bucket does so as the signed-in user:
# session.env sets AWS_ROLE_ARN, AWS_ROLE_SESSION_NAME and
# AWS_WEB_IDENTITY_TOKEN_FILE, and this keeps that token fresh.
install -d -m 0700 "$(dirname "$AWS_WEB_IDENTITY_TOKEN_FILE")"
/opt/annotate/refresh-token.sh
systemctl start token-refresh.timer

# The layout open_project.py expects: images/ is the field-of-view folder
# itself, read-only from S3; masks/ is on local disk, copied up to the
# folder's masks/ every minute by masks-sync.timer.
mount-s3 --read-only --allow-other --region "$AWS_REGION" \
  --prefix "${DATA_PREFIX}${REGION}/" "$BUCKET" "$region_dir/images"

if [ -n "${RESUME_KEY:-}" ]; then
  aws s3 cp --only-show-errors "s3://$BUCKET/$RESUME_KEY" /session/resume/
  chown annotate:annotate /session/resume/*
fi

systemctl start dcv-token-verifier.service

# DCV gives the session's X server (Xdcv) 15 seconds to start. On a new
# instance every file's first read comes from the disk's snapshot and is slow,
# and loading software OpenGL alone took 13 seconds: read those files now.
{ find /usr/bin/Xdcv /usr/lib/x86_64-linux-gnu/dri /usr/lib/x86_64-linux-gnu/dcv /usr/libexec/dcv -type f
  find /usr/lib/x86_64-linux-gnu -maxdepth 1 \( -name 'libLLVM*' -o -name 'libgallium*' -o -name 'libGL*' \) -type f
} 2>/dev/null | xargs -r cat > /dev/null || true

# If DCV still gives up, it closes the session within about 20 seconds; the
# next try finds the files already read. start-napari.sh marks a desktop that
# came up.
for attempt in 1 2 3; do
  dcv create-session --type virtual --owner annotate --user annotate \
    --init /opt/annotate/start-napari.sh annotate
  for _ in $(seq 60); do
    [ -e "$run/desktop-started" ] && break 2
    dcv describe-session annotate >/dev/null 2>&1 || { echo "DCV closed the session (try $attempt)"; continue 2; }
    sleep 1
  done
  break   # still starting after a minute: leave it be
done
dcv describe-session annotate >/dev/null 2>&1 || { echo "the DCV session would not start" >&2; exit 1; }

touch "$run/last-connected"   # the idle clock starts now; the watchdog has run since boot
systemctl start masks-sync.timer

# Last: the website treats a healthy tunnel as "desktop ready".
systemctl start annotate-tunnel.service
