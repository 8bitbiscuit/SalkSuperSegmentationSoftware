"""start-tunnel.sh without a domain: it must find the quick tunnel's address
in cloudflared's output and send exactly that to the website.

    python -m pytest desktop/tests/test_start_tunnel.py   (needs bash)
"""
import os
import subprocess
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "start-tunnel.sh"

# What cloudflared prints for a quick tunnel (to stderr), then it keeps running a moment.
CLOUDFLARED = r'''
echo "INF Requesting new quick Tunnel on trycloudflare.com..." >&2
echo "INF Registered at https://api.trycloudflare.com/tunnel" >&2
echo "INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |" >&2
echo "INF |  https://calm-river-4f2a.trycloudflare.com                                                 |" >&2
sleep 1
'''


def run(tmp_path, cloudflared=CLOUDFLARED, **env):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    for name, body in {"cloudflared": cloudflared, "curl": 'echo "$*" >> "$CALLS"'}.items():
        (bin_dir / name).write_text(f"#!/bin/bash\n{body}\n")
        (bin_dir / name).chmod(0o755)
    result = subprocess.run(
        ["bash", str(SCRIPT)], capture_output=True, text=True, timeout=30,
        env={**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "CALLS": str(tmp_path / "calls"),
             "QUICK_TUNNEL_LOG": str(tmp_path / "tunnel.log"), "TUNNEL_TOKEN": "",
             "DESKTOP_KEY": "key", "SITE_URL": "https://site.example", "SESSION_ID": "abc", **env})
    calls = (tmp_path / "calls").read_text() if (tmp_path / "calls").exists() else ""
    return result, calls


def test_reports_the_quick_tunnel_address(tmp_path):
    result, calls = run(tmp_path)
    assert result.returncode == 0, result.stderr
    assert "--data https://calm-river-4f2a.trycloudflare.com " in calls
    assert "https://site.example/api/desktop/address?session=abc" in calls
    assert "authorization: Bearer key" in calls


def test_fails_without_reporting_when_cloudflared_gives_no_address(tmp_path):
    result, calls = run(tmp_path, cloudflared='echo "ERR failed to request quick Tunnel" >&2; exit 1')
    assert result.returncode != 0
    assert "failed to request quick Tunnel" in result.stderr
    assert calls == ""


def test_a_named_tunnel_runs_with_its_token(tmp_path):
    result, calls = run(tmp_path, cloudflared='echo "ran: $*"', TUNNEL_TOKEN="tok")
    assert result.stdout == "ran: --no-autoupdate tunnel run\n"
    assert calls == ""
