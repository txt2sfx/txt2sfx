#!/usr/bin/env python3
"""Draw the social preview card: `apps/web/public/og.png`, 1200x630.

    python assets/og-card.py            # needs Pillow, and nothing else

## Why this exists rather than a checked-in image alone

The PNG *is* checked in — Twitter, Slack, Telegram and iMessage all want a raster at an
absolute URL, and the playground's build has no image toolchain to make one at deploy
time. But a binary nobody can regenerate is a binary that rots: the tagline changes, the
byte count in the example moves, and the card keeps advertising last year's numbers with
no way to tell. So the card is described here, in text that diffs, and the PNG is its
output. Change a string, re-run, commit both.

## Why not the screenshot

`assets/playground.png` is 2252x1727 — an aspect ratio of 1.30 against the 1.91 every
timeline crops to. Fitted whole it becomes a small grey rectangle with unreadable UI
text; cropped to 1.91 it loses the prompt row at the top and the export card at the
bottom, which are the two things worth showing. A card that states the claim in type
large enough to read on a phone says more than a thumbnail of an interface.

## Fonts

Whatever this machine has, named in preference order and reported on stdout, because the
card is regenerated on someone else's box eventually and a silent fallback to a default
bitmap font would be a card nobody notices is broken. The project's own faces (Archivo,
JetBrains Mono) are webfonts and are not assumed to be installed.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "apps" / "web" / "public" / "og.png"

# The size every scraper is happiest with: 1200x630 is 1.905:1, inside Twitter's
# `summary_large_image` band and above the 300x157 floor, and it is what Open Graph's own
# documentation uses in its examples.
SIZE = (1200, 630)

# Straight from `styles.css`, converted once: --bg, --panel, --line, --ink, --ink-2 and
# the cyan and amber accents. Hard-coded rather than parsed out of the CSS — one card is
# not worth an oklch converter, and a colour that drifts from the site by a hair is
# invisible in a timeline.
BG = (7, 8, 16)
PANEL = (18, 20, 32)
LINE = (44, 48, 66)
INK = (232, 236, 245)
INK_2 = (150, 158, 178)
CYAN = (34, 211, 238)
AMBER = (232, 179, 92)

TITLE = "txt2sfx"
TAGLINE = "Text-to-SFX as code."
CLAIM = "Sounds that weigh bytes, not megabytes."

# The killer example, trimmed to what fits at a readable size. It is the real recipe from
# `examples/bubble-pop.soundline`, so the card cannot promise syntax the parser rejects.
RECIPE = [
    ('sound "bubble pop" 55ms pop', INK),
    ("  body: tone tri ~700Hz[500..1400] -> 1120Hz in 14ms", INK_2),
    ("  edge: click 1ms >> bp ~2800Hz[1200..6000] Q1", INK_2),
]

FOOTER_LEFT = "876 B of Web Audio JavaScript"
FOOTER_RIGHT = "zero dependencies"

# Bottom band. Not decoration: a preview card is often the only thing someone sees before
# deciding whether to tap, and the three bands answer "what is it", "what does it look
# like" and "where is it" in that order. It also balances a composition that was
# noticeably top-heavy with the claim and the recipe alone.
SITE = "txt2sfx.github.io"

SANS = ["segoeuib.ttf", "arialbd.ttf", "DejaVuSans-Bold.ttf", "Helvetica.ttc"]
SANS_REGULAR = ["segoeui.ttf", "arial.ttf", "DejaVuSans.ttf", "Helvetica.ttc"]
MONO = ["consola.ttf", "DejaVuSansMono.ttf", "Menlo.ttc", "cour.ttf"]


def font(candidates: list[str], size: int) -> ImageFont.FreeTypeFont:
    """The first of `candidates` this machine can open, at `size`."""
    for name in candidates:
        try:
            found = ImageFont.truetype(name, size)
        except OSError:
            continue
        print(f"  {size:>3}px  {name}")
        return found
    sys.exit(
        f"none of {', '.join(candidates)} could be opened on this machine.\n"
        "Add one your system has to the list at the top of this script — the card needs a\n"
        "real TrueType face, and Pillow's built-in bitmap font would be unreadable at this size."
    )


def main() -> int:
    print("fonts:")
    f_brand = font(SANS, 46)
    f_tagline = font(SANS, 54)
    f_claim = font(SANS_REGULAR, 34)
    f_code = font(MONO, 23)
    f_footer = font(MONO, 22)

    card = Image.new("RGB", SIZE, BG)
    d = ImageDraw.Draw(card)

    # A cyan hairline along the top edge, the same accent the brand uses. Enough to make
    # the card recognisably ours in a feed of grey rectangles, and cheaper than a logo
    # nobody can read at thumbnail size.
    d.rectangle([0, 0, SIZE[0], 4], fill=CYAN)

    x = 72
    d.text((x, 74), TITLE, font=f_brand, fill=CYAN)
    d.text((x, 148), TAGLINE, font=f_tagline, fill=INK)
    d.text((x, 216), CLAIM, font=f_claim, fill=INK_2)

    # The recipe sits in a panel because that is how it appears in the playground, and
    # the border is what tells a reader at a glance that this is code and not prose.
    top, bottom = 298, 298 + 34 + len(RECIPE) * 34
    d.rounded_rectangle([x, top, SIZE[0] - x, bottom], radius=12, fill=PANEL, outline=LINE, width=1)
    y = top + 22
    for line, colour in RECIPE:
        d.text((x + 26, y), line, font=f_code, fill=colour)
        y += 34

    # The payoff, on the baseline: the number is the whole argument of the project.
    foot = bottom + 46
    d.text((x, foot), "→ ", font=f_footer, fill=INK_2)
    left = x + int(d.textlength("→ ", font=f_footer))
    d.text((left, foot), FOOTER_LEFT, font=f_footer, fill=AMBER)
    left += int(d.textlength(FOOTER_LEFT, font=f_footer))
    d.text((left, foot), f"  ·  {FOOTER_RIGHT}", font=f_footer, fill=INK_2)

    # Where it is, on its own baseline, over a hairline that closes the card.
    rule = SIZE[1] - 82
    d.rectangle([x, rule, SIZE[0] - x, rule + 1], fill=LINE)
    d.text((x, rule + 24), SITE, font=f_footer, fill=INK_2)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    # `optimize` because this file is fetched by every scraper that sees a link to the
    # site, and it is one of exactly two images the playground ships.
    card.save(OUT, "PNG", optimize=True)
    print(f"\n{OUT.relative_to(HERE.parent)}  {SIZE[0]}x{SIZE[1]}  {OUT.stat().st_size / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
