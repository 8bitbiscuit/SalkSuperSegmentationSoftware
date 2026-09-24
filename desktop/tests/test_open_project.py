"""open_project.py end to end: real napari, real files, real signals.

napari needs an X display with OpenGL; without one, use a virtual one:

    xvfb-run -a python -m pytest desktop/tests

Needs the desktop's Python environment (desktop/requirements.txt).
"""
import gzip
import io
import os
import signal
import subprocess
import sys
import textwrap
from pathlib import Path

import numpy as np
import pytest
import tifffile

SCRIPT_DIR = Path(__file__).resolve().parent.parent

# Runs open_project.main() with napari.run() wrapped: once the viewer is up,
# paint a square into the masks layer in place, as the brush does, then
# either close the window or wait to be signalled.
DRIVER = textwrap.dedent("""
    import sys
    import napari
    from qtpy.QtCore import QTimer

    sys.path.insert(0, sys.argv[1])
    import open_project

    how, real_run = sys.argv[2], napari.run

    def run():
        viewer = napari.current_viewer()

        def act():
            if how != "untouched":
                viewer.layers["masks"].data[1, 10:20, 10:20] = 7
            print("ready", flush=True)
            if how in ("close", "untouched"):
                viewer.close()

        QTimer.singleShot(200, act)
        real_run()

    napari.run = run
    open_project.main(sys.argv[3:])
""")


@pytest.fixture
def region(tmp_path):
    (tmp_path / "images").mkdir()
    for z in range(3):
        tifffile.imwrite(tmp_path / f"images/mosaic_PVARB_z{z}.tif",
                         np.full((64, 64), 50 + 100 * z, np.uint16))
    return tmp_path


def start(region, how, *args, images=None):
    env = {**os.environ, "USER": "tester"}
    if images:
        env["IMAGES"] = images
    return subprocess.Popen(
        [sys.executable, "-c", DRIVER, str(SCRIPT_DIR), how, str(region), *args],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)


def wait_ready(proc):
    lines = []
    for line in proc.stdout:
        lines.append(line)
        if line.startswith("ready"):
            return
    pytest.fail("viewer never came up:\n" + "".join(lines))


def finish(proc):
    out, _ = proc.communicate(timeout=120)
    assert proc.returncode == 0, out
    return out


def saved_masks(region):
    files = sorted((region / "masks").glob("tester_*_masks.tif.gz"))
    assert len(files) == 1, files
    with gzip.open(files[0]) as f:
        return tifffile.imread(io.BytesIO(f.read()))


def assert_painted(masks):
    assert masks.shape == (3, 64, 64)
    assert (masks[1, 10:20, 10:20] == 7).all()
    assert int(masks.sum()) == 7 * 100


def test_closing_the_window_saves_what_was_painted(region):
    proc = start(region, "close")
    out = finish(proc)
    assert "final save" in out
    assert_painted(saved_masks(region))


def test_sigterm_saves_what_was_painted(region):
    proc = start(region, "wait")
    wait_ready(proc)
    proc.send_signal(signal.SIGTERM)
    out = finish(proc)
    assert "final save" in out
    assert_painted(saved_masks(region))


def test_resumed_masks_carry_over_to_a_new_file(region):
    first = start(region, "close")
    finish(first)
    (resume,) = (region / "masks").glob("*.tif.gz")
    resume = resume.rename(region / "old_masks.tif.gz")

    second = start(region, "untouched", "--resume", str(resume))
    finish(second)
    assert_painted(saved_masks(region))


def test_nothing_painted_writes_nothing(region):
    finish(start(region, "untouched"))
    assert not list((region / "masks").glob("*.tif.gz"))


def test_images_can_come_from_the_environment(tmp_path):
    # How the cloud desktops run it: the field-of-view folder is images/, and
    # IMAGES picks the channel. LZW-compressed, like the lab's DAPI_decon files.
    (tmp_path / "images").mkdir()
    for z in range(3):
        tifffile.imwrite(tmp_path / f"images/DAPI_decon_z{z}.tif", np.full((64, 64), 7, np.uint16),
                         compression="lzw")
    tifffile.imwrite(tmp_path / "images/PVALB_decon_z0.tif", np.zeros((32, 32), np.uint16))  # other channel: ignored
    out = finish(start(tmp_path, "close", images="images/DAPI_decon_z*.tif"))
    assert "annotating (3, 64, 64)" in out
    assert_painted(saved_masks(tmp_path))
