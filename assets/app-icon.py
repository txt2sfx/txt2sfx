#!/usr/bin/env python3
"""Draw the installed app's icons into `apps/web/public/icons/`.

    python assets/app-icon.py           # needs Pillow, and nothing else

## Why this exists rather than four checked-in images alone

Same argument as `assets/og-card.py`: the PNGs *are* checked in, because a manifest
names raster files at fixed sizes and the playground's build has no image toolchain to
make one at deploy time — but a binary nobody can regenerate is a binary that rots. So
the mark is described here, in text that diffs, and the PNGs are its output.

## Why not `assets/logo.svg`

That file is the wordmark: 440x120, the name in type with a waveform beside it. An app
icon is a square shown at 48 px on a home screen, where five characters of monospace are
an illegible smear. The mark drawn here is instead the *favicon* — the one in
`apps/web/index.html`, inlined there as a data URI — at the sizes a manifest wants, so
the tab, the installed icon and the splash screen are one drawing rather than three.

There is no SVG-to-PNG step for the same reason: rasterizing that data URI would put
`cairosvg` (and a system Cairo) between this repository and its own icons. The path is
seven line segments; re-stating them in Python costs less than the dependency.

## The two purposes, and why the mark is drawn twice

`any` is the icon as-is, with the rounded corners the favicon has — this is what a
desktop shows, uncropped.

`maskable` is handed to Android, which crops it to whatever shape the launcher uses:
a circle, a squircle, a teardrop. Only the central 80% *diameter* is guaranteed to
survive, so this one is full-bleed (the platform draws the corners) and the mark is
scaled down to sit inside that circle. Getting this wrong is invisible on a desktop and
clips the waveform on every phone.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "apps" / "web" / "public" / "icons"

# Straight from the favicon in `apps/web/index.html`, which took them from `styles.css`:
# `--bg` as the plate, the cyan accent as the trace. Hard-coded rather than parsed out of
# the CSS for the reason `og-card.py` gives — one mark is not worth an oklch converter.
BG = (7, 8, 16)
CYAN = (34, 211, 238)

# The favicon's own coordinates, on its 32-unit viewBox: a flat lead-in, a transient that
# overshoots in both directions, a decay, and a flat tail. `M4 16h4l3-9 4 18 4-13 3 8h6`.
GRID = 32.0
TRACE = [(4, 16), (8, 16), (11, 7), (15, 25), (19, 12), (22, 20), (28, 20)]
STROKE = 2.2  # the SVG's `stroke-width`, in the same units
RADIUS = 7.0  # the SVG's `rx`

# Pillow draws lines with no antialiasing at all, so every icon is drawn at this multiple
# of its final size and resampled down. 4x is where the diagonals stop showing steps at
# 48 px, which is the smallest size a launcher uses.
SUPERSAMPLE = 4

# The share of the canvas the mark occupies on a maskable icon. Android guarantees only
# the central 80% diameter; 76% leaves the trace inside that circle with a hair to spare,
# including the parts of it that reach the corners of its own bounding box.
MASKABLE_SCALE = 0.76


def draw(size: int, maskable: bool) -> Image.Image:
    """One icon, drawn oversized and resampled down.

    :param size: Final edge length in pixels.
    :param maskable: Full-bleed plate and an inset mark, for a launcher that crops.
    """
    edge = size * SUPERSAMPLE
    image = Image.new("RGB", (edge, edge), BG)
    pen = ImageDraw.Draw(image)

    if not maskable:
        # The plate is the whole canvas, so the rounded corners have to be *cut* rather
        # than drawn: fill everything with the trace-free background, then round it by
        # pasting onto transparency. Simpler in the direction that matters — the icon is
        # opaque inside its corners, which is what `any` means.
        plate = Image.new("RGBA", (edge, edge), (0, 0, 0, 0))
        ImageDraw.Draw(plate).rounded_rectangle(
            (0, 0, edge - 1, edge - 1), radius=RADIUS / GRID * edge, fill=(*BG, 255)
        )
        image = plate.convert("RGBA")
        pen = ImageDraw.Draw(image)

    scale = (MASKABLE_SCALE if maskable else 1.0) * edge / GRID
    offset = (edge - GRID * scale) / 2
    points = [(x * scale + offset, y * scale + offset) for x, y in TRACE]

    # `joint="curve"` is Pillow's equivalent of `stroke-linejoin="round"`: without it the
    # transient's two reversals grow spikes where the segments meet at an acute angle.
    pen.line(points, fill=CYAN, width=max(1, round(STROKE * scale)), joint="curve")
    # Pillow has no `stroke-linecap`, so the two ends are squared off. At the tail that is
    # invisible; at the lead-in it is a 2-pixel difference nobody has ever noticed.

    return image.resize((size, size), Image.LANCZOS)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)

    # 192 and 512 are the two sizes the manifest spec's own examples use and the two
    # Chrome checks for before it will offer to install anything. 180 is what iOS asks
    # for by name via `apple-touch-icon`, and it is the one icon that is *not* referenced
    # from the manifest — Safari reads the `<link>` and ignores the rest.
    written = [
        ("icon-192.png", draw(192, maskable=False)),
        ("icon-512.png", draw(512, maskable=False)),
        ("icon-maskable-512.png", draw(512, maskable=True)),
        ("apple-touch-icon-180.png", draw(180, maskable=False)),
    ]

    for name, image in written:
        path = OUT / name
        # iOS composites `apple-touch-icon` onto white when it is transparent, which would
        # put a white ring inside the rounded corners it draws itself. RGB, no alpha.
        image.convert("RGB").save(path, "PNG", optimize=True)
        print(f"{path.relative_to(HERE.parent)}  {path.stat().st_size} bytes")

    return 0


if __name__ == "__main__":
    sys.exit(main())
