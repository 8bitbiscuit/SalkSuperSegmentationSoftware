---
layout: default
title: Guide
permalink: /guide/
---
# How to annotate

** USE THE SPREADSHEET FOR STATUS OF WHICH STAINS NEED SEGMENTATION:

https://docs.google.com/spreadsheets/d/1p1N_n56zOxvhvM8zzC7xwjlks4zPnVI99ENNYrLK0Zg/edit?gid=0#gid=0

## Start

The whole idea is that you’re going to be spinning up a desktop with a custom ami.
The ami or amazon machine image has everything you need already installed,
each new session starts a desktop in the cloud with napari already open
on one field of view or region. It is yours alone, it will save your masks as you go, 
and it shuts itself down when you're done. It reads the images and saves 
the masks under your own sign-in so that you can continue where you left off!

1. On the [session page]({{ '/' | relative_url }}), pick the **data**:
   - **spida_dev**: then a **brain region**, a **region** and a **field of
     view**. It opens the field of view's raw DAPI images.
   - **spatial_data**: then an **experiment** and a **region**, and tick the
     **images to open**: DAPI, GFAP, PolyT and so on. A name ending in
     `.decon` is the deconvolved version. Each one ticked opens as its own
     layer, and each z-plane of these is many gigabytes, so tick only the
     ones you need.

   The page remembers your last choice.
2. Pick the **masks to start from**: empty, or any saved masks file for that
   field of view or region, yours or anyone else's. Your newest is picked for you by default.
3. Click **Start session**. The desktop will take around 2–4 minutes to come up. The page
   updates by itself so you don't need to constantly refresh.
4. Click **Open desktop** once it pops up. It opens in a new tab with napari showing a
   layer for each image, named after it (for example **DAPI_raw** or
   **mosaic_GFAP**), and **masks** (what you paint). The first image is grey,
   any others are coloured on top of it; hide one with its eye icon.

## Actually doing segmentations

Select the **masks** layer using the bar on the bottom left, then:

| Key | Does |
|---|---|
| <kbd>2</kbd> or <kbd>P</kbd> | Paint brush |
| <kbd>1</kbd> or <kbd>E</kbd> | Eraser |
| <kbd>4</kbd> or <kbd>F</kbd> | Fill |
| <kbd>3</kbd> | Polygon |
| <kbd>5</kbd> or <kbd>L</kbd> | Pick a label from the image |
| <kbd>6</kbd> or <kbd>Z</kbd> | Pan and zoom |
| <kbd>M</kbd> | New label (one above the highest used) |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo |

Move through z-slices with the slider under the image. Each slice loads when
you reach it, so the first view of a slice can take a moment.

**MAKE SURE YOU SELECT A NEW LABEL FOR EACH CELL**

## Saving

- **Every 5 minutes** your masks save automatically, and are copied to
  cloud storage within a minute.
- **Save masks** (left of the napari window) saves right away.
- **When the session ends** (you close napari, click **End session**, or
  walk away), napari saves one last time before the desktop shuts down.

Your masks are named `<you>_<time you started>_masks.tif.gz` and kept in the
`masks/` folder beside the images: `{{ site.masks_location.spida_dev }}` or
`{{ site.masks_location.spatial_data }}`. Every session writes a new file. Cloud storage
also keeps earlier versions of each file for 30 days, so a bad save can be
undone.

## Finish

Either close napari in the desktop, or click **End session** on the session
page. Both save first. A large field of view can take a few minutes to save, and
the session page shows **Saving your masks and shutting down…** until it's done.