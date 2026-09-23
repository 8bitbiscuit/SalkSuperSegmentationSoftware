---
layout: default
title: Guide
permalink: /guide/
---
# How to annotate

Each session is a desktop in the cloud with napari already open on one region.
It is yours alone, it saves your masks as you go, and it shuts itself down
when you're done.

## Start

1. On the [session page]({{ '/' | relative_url }}), pick a **region**.
2. Pick the **masks to start from**: empty, or any saved masks file for that
   region, yours or anyone else's. Your newest is picked for you.
3. Click **Start session**. The desktop takes 2–4 minutes to come up. The page
   updates by itself.
4. Click **Open desktop**. It opens in a new tab with napari showing two
   layers: **PVALB** (the image) and **masks** (what you paint).

Resuming never changes the file you pick. Its labels are copied into a new
masks file with your name on it.

## Paint

Select the **masks** layer, then:

| Key | Does |
|---|---|
| <kbd>2</kbd> or <kbd>P</kbd> | Paint brush |
| <kbd>1</kbd> or <kbd>E</kbd> | Eraser |
| <kbd>4</kbd> or <kbd>F</kbd> | Fill |
| <kbd>3</kbd> | Polygon |
| <kbd>5</kbd> or <kbd>L</kbd> | Pick a label from the image |
| <kbd>6</kbd> or <kbd>Z</kbd> | Pan and zoom |
| <kbd>M</kbd> | New label (one above the highest used) |
| <kbd>-</kbd> / <kbd>=</kbd> | Previous / next label |
| <kbd>[</kbd> / <kbd>]</kbd> | Smaller / bigger brush |
| <kbd>B</kbd> | Don't paint over existing labels (toggle) |
| <kbd>V</kbd> | Show only the selected label (toggle) |
| <kbd>Ctrl</kbd>+<kbd>Z</kbd> | Undo |

Move through z-slices with the slider under the image. Each slice loads when
you reach it, so the first view of a slice can take a moment. These are
napari's defaults; napari lists them all under **Preferences → Shortcuts**.

## Saving

- **Every 5 minutes** your masks save automatically, and are copied to
  cloud storage within a minute.
- **Save masks** (left of the napari window) saves right away.
- **When the session ends** (you close napari, click **End session**, or
  walk away), napari saves one last time before the desktop shuts down.

Your masks are named `<you>_<time you started>_masks.tif.gz` and kept in
`{{ site.masks_location }}`. Every session writes a new file. Cloud storage
also keeps earlier versions of each file for 30 days, so a bad save can be
undone.

## Finish

Either close napari in the desktop, or click **End session** on the session
page. Both save first. A large region can take a few minutes to save, and
the session page shows **Saving your masks and shutting down…** until it's done.

If you walk away, the desktop disconnects you after 60 minutes without input.
30 minutes after that, it saves and shuts down on its own. To carry on
later, start a new session and resume from your newest masks.

## Browser tips

- Use **Chrome** or **Edge**.
- Use the desktop's **fullscreen** button (in its toolbar), so shortcuts
  like <kbd>Ctrl</kbd>+<kbd>W</kbd> go to napari instead of closing the tab.
- Keep the desktop open in only one tab.

## When something goes wrong

- **napari can't open the region:** a message box in the desktop shows the
  error. The session ends when you click OK.
- **The session page says the session failed:** the reason is shown there.
  Start again, and if it keeps failing, send the message to whoever runs
  this site.
- **The desktop tab went blank or disconnected:** your session is still
  running. Go back to the session page and click **Open desktop** again.
