#!/bin/bash
# Every minute: is this desktop finished? If so, power off. Powering off runs
# annotate-session's stop (napari saves, masks go to S3), and the launch
# template's shutdown behaviour turns the power-off into a termination.
set -uo pipefail
# shellcheck source=/dev/null
. "${SESSION_ENV:-/etc/annotate/session.env}"   # overridable for desktop/tests
run=${RUN_DIR:-/run/annotate}
idle=${IDLE_MINUTES:-30}

# The idle clock starts at the first check even if the boot never got as far
# as DCV, so a desktop that failed to start still powers itself off.
mkdir -p "$run"
[ -e "$run/last-connected" ] || touch "$run/last-connected"

stop() { echo "ending session: $1"; systemctl poweroff; exit 0; }

[ -e "$run/session-done" ] && stop "napari has exited"

# The website's End session sets the instance tag Stop, readable here
# through instance metadata; an absent tag is a 404.
token=$(curl -sf -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token || true)
if [ -n "$token" ] && curl -sf -o /dev/null -H "X-aws-ec2-metadata-token: $token" \
    http://169.254.169.254/latest/meta-data/tags/instance/Stop; then
  stop "the website asked it to end"
fi

# Idle means no browser connected. DCV itself drops a browser after 60
# minutes without input (dcv.conf), so an open but forgotten tab counts too.
# No DCV session at all means nobody can be connected. If the count can't be
# read, assume someone is: guessing wrong that way costs instance time, the
# other way costs someone's work.
if ! dcv describe-session annotate >/dev/null 2>&1; then
  connections=0
else
  connections=$(dcv list-connections --json annotate 2>/dev/null | jq -e 'if type == "array" then length else error end' 2>/dev/null)
fi
if [ -z "$connections" ]; then
  echo "could not read DCV connections; treating the session as in use"
  touch "$run/last-connected"
elif [ "$connections" -gt 0 ]; then
  touch "$run/last-connected"
fi
[ -n "$(find "$run/last-connected" -mmin "+$idle")" ] && stop "no one connected for $idle minutes"
exit 0
