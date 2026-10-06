#!/bin/bash
# The whole desktop: a window manager and napari on the session's region.
# DCV runs this as the session's init, as the annotate user. When napari
# exits, the watchdog sees session-done and powers the instance off.
set -a; . /etc/annotate/session.env; set +a
export USER=$ANNOTATOR   # open_project.py names the masks after $USER
# A glob per image stack picked on the website, which open_project.py opens
# as a layer each: mosaic_DAPI.decon -> images/mosaic_DAPI_z*.decon.tif.
# CHANNEL alone: the website from before stacks could be picked.
IFS=: read -ra stacks <<<"${CHANNELS:-$CHANNEL}"
globs=()
for s in "${stacks[@]}"; do base=${s%%.*}; globs+=("images/${base}_z*${s#"$base"}.tif"); done
IMAGES=$(IFS=:; echo "${globs[*]}")
export IMAGES
run=/run/annotate
log=$run/napari.log
touch "$run/desktop-started"   # the X server is up: session-boot.sh waits for this

openbox &

resume=()
[ -n "$RESUME_KEY" ] && resume=(--resume "/session/resume/${RESUME_KEY##*/}")
/opt/annotate/venv/bin/python /opt/annotate/open_project.py "/session/$REGION" "${resume[@]}" >"$log" 2>&1
status=$?

# A remote user never sees a terminal, so show why napari died, unless it
# was told to stop.
if [ "$status" -ne 0 ] && [ ! -e "$run/stopping" ]; then
  { echo "napari stopped with an error (exit status $status):"; echo; tail -n 30 "$log"; } |
    xmessage -center -buttons "End session:0" -file -
fi
touch "$run/session-done"
