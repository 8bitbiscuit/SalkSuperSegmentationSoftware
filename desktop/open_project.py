"""Annotate a MERSCOPE region in napari from a remote desktop.

For desktops where you launch napari yourself -- Anvil's ThinLinc, AWS DCV --
rather than the lab server's xpra. Same behaviour as open_project.py (lazy
per-slice loading, background saves), but the region comes in as an argument
instead of an apptainer --bind:

    python3 open_project.py /data/region_UCI-5224
    python3 open_project.py /data/region_UCI-5224 --resume old_masks.tif.gz

It also saves once more on the way out, when the window is closed or the
process gets SIGTERM, since on the cloud desktops something other than the
user often ends the session.
"""
import argparse
import gzip
import os
import re
import shutil
import signal
import sys
import tempfile
import threading
from datetime import datetime
from glob import glob
from pathlib import Path

import dask.array as da
import napari
import numpy as np
import tifffile
from dask import delayed
from magicgui import magicgui
from qtpy.QtCore import QTimer
from qtpy.QtWidgets import QApplication

# CONFIG
# ----------------------------------------------------------------------------
IMAGES = "images/mosaic_PVARB_z*.tif"  # relative to the region directory

AUTOSAVE_MINUTES = 5
LABEL_DTYPE = np.uint16  # up to 65,535 labels a region; np.uint32 beyond
GZIP_LEVEL = 1

USER = os.environ.get("USER", "unknown")

os.umask(0o002)  # or the next person cannot overwrite our masks
# ----------------------------------------------------------------------------

PROJECT = PVALB_GLOB = OUT_DIR = MASKS_PATH = None


def configure(project):
    """Point the script at a region. Called once from main."""
    global PROJECT, PVALB_GLOB, OUT_DIR, MASKS_PATH
    PROJECT = Path(project)
    PVALB_GLOB = str(PROJECT / IMAGES)
    OUT_DIR = PROJECT / "masks"
    MASKS_PATH = OUT_DIR / f"{USER}_{datetime.now():%Y%m%dT%H%M%S}_masks.tif.gz"


def z_index(path):
    match = re.search(r"z(\d+)", Path(path).stem)
    return int(match.group(1)) if match else 0


def load_PVALB(pattern):
    """Lazy (z, y, x) stack: one napari layer, one plane read at a time.

    One chunk per plane. Chunking finer with tifffile's aszarr buys nothing --
    napari computes the whole displayed plane anyway -- and that path retains
    every plane it decodes.
    """
    files = sorted(glob(pattern), key=z_index)
    if not files:
        raise FileNotFoundError(f"no PVALB files matched {pattern}")

    with tifffile.TiffFile(files[0]) as tif:
        series = tif.series[0]
        shape, dtype = series.shape, series.dtype

    return da.stack([da.from_delayed(delayed(tifffile.imread)(path),
                                     shape=shape, dtype=dtype)
                     for path in files])


def contrast_from(plane):
    """Contrast limits off a decimated read, never a full plane."""
    sample = np.asarray(plane[::32, ::32])
    lo, hi = float(sample.min()), float(sample.max())
    return (lo, hi) if hi > lo else (lo, lo + 1.0)  # napari rejects a flat range


def load_masks(path, shape):
    """Labels from a previous session, .tif or .tif.gz, else an empty volume."""
    masks = np.zeros(shape, dtype=LABEL_DTYPE)
    if path is None:
        return masks

    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(f"no such masks file: {path}")
    if path.name.endswith(".gz"):
        # Decompressed to disk, not memory: the .gz may hold an uncompressed
        # tif, and tifffile seeking about inside a gzip handle restarts the
        # stream on every backwards jump -- measured at ~10x a plain read.
        with gzip.open(path, "rb") as src, \
                tempfile.NamedTemporaryFile(suffix=".tif") as tmp:
            shutil.copyfileobj(src, tmp)
            tmp.flush()
            _copy_labels(tmp.name, masks)
    else:
        _copy_labels(path, masks)
    return masks


def _copy_labels(path, masks):
    """Copy only the labelled pixels of a saved tif into masks, a plane at a time.

    Decoding writes every pixel, zeros included, so reading the file whole
    commits the entire volume (~140 GB at full size) however little was
    painted. Writing only the non-zero pixels into untouched zeros commits
    about what was painted, plus one decoded plane while it is read.
    """
    top = np.iinfo(masks.dtype).max
    with tifffile.TiffFile(path) as tif:
        saved = tif.series[0].shape
        if saved != masks.shape:
            raise ValueError(f"masks are {saved}, images are {masks.shape}")
        for z in range(masks.shape[0]):
            plane = tif.asarray(key=z).ravel()
            where = np.flatnonzero(plane)
            labels = plane[where]
            if labels.size and labels.max() > top:
                # never cast: a label that does not fit would wrap into another's
                raise ValueError(f"label {labels.max()} in plane {z} exceeds "
                                 f"{masks.dtype}; set LABEL_DTYPE = np.uint32")
            masks[z].ravel()[where] = labels


def add_layers(viewer, resume=None):
    image = load_PVALB(PVALB_GLOB)
    # before any image plane is on screen, so the two memory peaks don't stack
    masks = load_masks(resume, image.shape)

    # cache=False holds the one-slice-at-a-time line: napari otherwise keeps
    # dask slices in a global cache sized at a quarter of total memory.
    viewer.add_image(image, name="PVALB", colormap="gray", multiscale=False,
                     cache=False,
                     contrast_limits=contrast_from(image[len(image) // 2]))

    # numpy, not zarr: napari's paint path and M shortcut need a real ndarray,
    # and zeros cost nothing until painted on.
    viewer.add_labels(masks, name="masks")

    print(f"annotating {image.shape} {image.dtype}, chunks {image.chunksize} "
          f"from {Path(PVALB_GLOB).name}")


_save_lock = threading.Lock()


def _write_masks(masks, reason):
    try:
        if not masks.any() and not MASKS_PATH.exists():
            return  # nothing drawn yet

        OUT_DIR.mkdir(parents=True, exist_ok=True)
        staged = MASKS_PATH.with_name(MASKS_PATH.name + ".staging")
        tmp = MASKS_PATH.with_name(MASKS_PATH.name + ".tmp")

        # gzip handles cannot seek backwards for tifffile's offset patching, so
        # stage on disk. Compressed, or staging costs a full copy of the volume.
        tifffile.imwrite(staged, masks, bigtiff=True, photometric="minisblack",
                         compression="zlib", compressionargs={"level": GZIP_LEVEL})
        with open(staged, "rb") as src, gzip.open(tmp, "wb", GZIP_LEVEL) as dst:
            shutil.copyfileobj(src, dst)
        staged.unlink()

        os.replace(tmp, MASKS_PATH)  # atomic, so a kill leaves no half file
        os.chmod(MASKS_PATH, 0o664)
        print(f"[{datetime.now():%H:%M:%S}] {reason} save -> {MASKS_PATH.name}")
    except Exception as exc:
        print(f"{reason} save failed: {exc}", file=sys.stderr)


def save_masks(viewer, reason="manual"):
    """Start a save on a worker and return at once.

    A full-size save runs minutes; on the Qt thread that is minutes of frozen
    viewer, and autosave would refire into it.
    """
    if "masks" not in viewer.layers:
        return None

    if not _save_lock.acquire(blocking=False):
        print(f"[{datetime.now():%H:%M:%S}] {reason} save skipped, "
              f"previous save still running")
        return None

    # Read the layer here, on the Qt thread. Nothing below touches napari:
    # layer attributes are wired to widget handlers, and driving those from a
    # worker is undefined behaviour ("cannot create children for a parent in a
    # different thread"). Strokes made mid-write land in the next save.
    masks = np.asarray(viewer.layers["masks"].data)

    def run():
        try:
            _write_masks(masks, reason)
        finally:
            _save_lock.release()

    worker = threading.Thread(target=run, name=f"save-{reason}")  # not a daemon
    worker.start()
    return worker


def add_save_widget(viewer):

    @magicgui(call_button="Save masks")
    def save_button():
        if save_masks(viewer) is not None:
            viewer.status = f"saving {MASKS_PATH.name} in the background"

    viewer.window.add_dock_widget(save_button, area="left", name="Save")


def save_on_exit(viewer):
    """Save once more when napari quits, however it was asked to.

    Autosave alone drops up to AUTOSAVE_MINUTES of strokes when napari closes,
    and on the cloud desktops it is often closed for the user: End session,
    the idle timeout, a shutdown. So quitting saves, and SIGTERM quits.
    """
    masks = viewer.layers["masks"].data  # painted in place; outlives the window

    def final_save():
        with _save_lock:  # waits out an autosave that is mid-write
            _write_masks(masks, "final")

    app = QApplication.instance()
    app.aboutToQuit.connect(final_save)

    # SIGTERM closes the window as the close button would. Python only runs a
    # signal handler when Qt hands the thread back, so a timer ticks to let it;
    # the close itself waits for the next turn of the event loop, since closing
    # from inside whatever callback the signal interrupted crashes Qt.
    signal.signal(signal.SIGTERM, lambda *_: QTimer.singleShot(0, viewer.close))
    tick = QTimer(app)
    tick.timeout.connect(lambda: None)
    tick.start(500)


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "project", nargs="?", default=os.environ.get("PROJECT"),
        help="region directory holding images/ and masks/ "
             "(default: $PROJECT)")
    parser.add_argument(
        "--resume", metavar="MASKS.tif[.gz]",
        help="_masks.tif or _masks.tif.gz to carry on from")
    args = parser.parse_args(argv)
    if not args.project:
        parser.error("give a region directory, or set $PROJECT")
    return args


def check_paths():
    """Fail before the viewer opens: the path is typed by hand now.

    --resume is not checked here; load_masks guards it, and that guard has to
    exist anyway for open_project.py, which has no pre-flight.
    """
    if not PROJECT.is_dir():
        sys.exit(f"no such region directory: {PROJECT}")
    if not glob(PVALB_GLOB):
        sys.exit(f"no images matched {PVALB_GLOB}")


def main(argv=None):
    args = parse_args(argv)
    configure(args.project)
    check_paths()

    print(f"project: {PROJECT}\nsaving to: {MASKS_PATH}")
    # Pre-flight, though _write_masks creates it too: surface a permissions
    # problem now, not at the first autosave with an hour of work riding on it.
    try:
        OUT_DIR.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        print(f"cannot create {OUT_DIR}: {exc}", file=sys.stderr)

    viewer = napari.Viewer(title=PROJECT.name)
    add_layers(viewer, args.resume)
    add_save_widget(viewer)
    save_on_exit(viewer)

    timer = QTimer()
    timer.timeout.connect(lambda: save_masks(viewer, "autosave"))
    timer.start(AUTOSAVE_MINUTES * 60 * 1000)

    napari.run()


if __name__ == "__main__":
    main()
