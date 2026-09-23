"""watchdog.sh decides when a desktop is finished. A wrong call either
powers off someone's live session or leaves an instance running forever, so
each rule is checked here against stand-ins for dcv, curl and systemctl.

    python -m pytest desktop/tests/test_watchdog.py   (needs bash, jq, find)
"""
import os
import subprocess
import time
from pathlib import Path

import pytest

WATCHDOG = Path(__file__).resolve().parent.parent / "watchdog.sh"

FAKES = {
    # DCV_OUT is what `dcv list-connections --json` prints; unset, dcv fails.
    "dcv": '[ -n "${DCV_OUT+x}" ] || exit 1; printf "%s" "$DCV_OUT"',
    # Instance metadata: a token, and the Stop tag only when STOP_TAG=1.
    "curl": 'case "$*" in *api/token*) echo tok ;; *tags/instance/Stop*) [ "${STOP_TAG:-0}" = 1 ] || exit 22 ;; esac',
    "systemctl": 'echo "$*" >> "$CALLS"',
}


@pytest.fixture
def box(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in FAKES.items():
        (bin_dir / name).write_text(f"#!/bin/bash\n{body}\n")
        (bin_dir / name).chmod(0o755)
    run = tmp_path / "run"
    run.mkdir()
    (tmp_path / "session.env").write_text("REGION=r1\nIDLE_MINUTES=30\n")
    return tmp_path


def watchdog(box, *, connected_minutes_ago=0, **env):
    last = box / "run/last-connected"
    last.touch()
    past = time.time() - connected_minutes_ago * 60
    os.utime(last, (past, past))
    result = subprocess.run(
        ["bash", str(WATCHDOG)], capture_output=True, text=True, timeout=30,
        env={**os.environ, "PATH": f"{box / 'bin'}:{os.environ['PATH']}",
             "SESSION_ENV": str(box / "session.env"), "RUN_DIR": str(box / "run"),
             "CALLS": str(box / "calls"), **env})
    assert result.returncode == 0, result.stderr
    calls = (box / "calls").read_text() if (box / "calls").exists() else ""
    return "poweroff" in calls, result.stdout


def test_powers_off_once_napari_has_exited(box):
    (box / "run/session-done").touch()
    assert watchdog(box, DCV_OUT='[{"id": 1}]') == (True, "ending session: napari has exited\n")


def test_powers_off_when_the_website_asks(box):
    off, out = watchdog(box, STOP_TAG="1", DCV_OUT='[{"id": 1}]')
    assert off and "website" in out


def test_keeps_running_while_someone_is_connected(box):
    off, _ = watchdog(box, connected_minutes_ago=300, DCV_OUT='[{"id": 1}]')
    assert not off
    assert time.time() - (box / "run/last-connected").stat().st_mtime < 60


def test_keeps_running_shortly_after_everyone_disconnects(box):
    assert watchdog(box, connected_minutes_ago=10, DCV_OUT="[]") == (False, "")


def test_powers_off_after_idle_minutes_with_no_one_connected(box):
    off, out = watchdog(box, connected_minutes_ago=45, DCV_OUT="[]")
    assert off and "no one connected for 30 minutes" in out


def test_unreadable_connections_count_as_connected(box):
    for dcv_out in ({}, {"DCV_OUT": "not json"}, {"DCV_OUT": '{"connections": []}'}):
        off, out = watchdog(box, connected_minutes_ago=45, **dcv_out)
        assert not off, dcv_out
        assert "treating the session as in use" in out
