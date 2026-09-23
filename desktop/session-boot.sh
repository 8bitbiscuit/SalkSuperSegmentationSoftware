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

# The layout open_project.py expects: images/ read-only straight from S3,
# masks/ on local disk, copied up to S3 every minute by masks-sync.timer.
mount-s3 --read-only --allow-other --region "$AWS_REGION" \
  --prefix "regions/$REGION/images/" "$BUCKET" "$region_dir/images"

if [ -n "${RESUME_KEY:-}" ]; then
  aws s3 cp --only-show-errors "s3://$BUCKET/$RESUME_KEY" /session/resume/
  chown annotate:annotate /session/resume/*
fi

systemctl start dcv-token-verifier.service
dcv create-session --type virtual --owner annotate --user annotate \
  --init /opt/annotate/start-napari.sh annotate

sudo -u annotate touch "$run/last-connected"   # the idle clock starts now
systemctl start masks-sync.timer annotate-watchdog.timer

# Last: the website treats a healthy tunnel as "desktop ready".
systemctl start annotate-tunnel.service
