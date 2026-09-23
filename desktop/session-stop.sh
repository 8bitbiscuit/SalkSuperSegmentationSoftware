#!/bin/bash
# At shutdown, before DCV goes: napari saves and quits (it does both on
# SIGTERM), then the masks go to S3 one last time. However the session ends
# (End session, idle, napari closed, an EC2 terminate), it ends through here.
set -uo pipefail
run=/run/annotate
napari=/opt/annotate/open_project.py

touch "$run/stopping"
if pkill -TERM -u annotate -f "$napari"; then
  for _ in $(seq 180); do   # a full-size save takes minutes; allow 15
    pgrep -u annotate -f "$napari" >/dev/null || break
    sleep 5
  done
  pgrep -u annotate -f "$napari" >/dev/null && echo "napari did not finish saving; syncing the last autosave"
fi
/opt/annotate/sync-masks.sh
