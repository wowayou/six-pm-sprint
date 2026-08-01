#!/usr/bin/env python3
"""Rasterise assets/icon.svg into the PNG sizes iOS and Android require.

Dev-only tool: the shipped site stays dependency-free. Run it after editing
assets/icon.svg, then commit the generated PNGs.

    python3 scripts/build-icons.py

Needs Pillow and numpy (`pip install pillow numpy`).
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
FONT_PATH = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"

# The SVG's viewBox. Every coordinate below is expressed in this space.
VIEW = 512
SS = 4  # supersample factor; the canvas is rendered at VIEW * SS then reduced

INK = (246, 242, 232)
ACID = (234, 255, 79)
RED = (255, 91, 91)
BG_FROM = (48, 32, 74)
BG_TO = (17, 12, 29)
DIAL = (32, 22, 48)

STAR = [
    (365, 371), (382, 359), (380, 380), (398, 391), (377, 396),
    (371, 417), (359, 399), (338, 401), (352, 385), (345, 365),
]


def diagonal_gradient(size: int) -> Image.Image:
    """Reproduce the SVG's x1=0 y1=0 -> x2=1 y2=1 linear gradient."""
    axis = np.linspace(0.0, 1.0, size, dtype=np.float32)
    t = (axis[None, :] + axis[:, None]) / 2.0
    channels = [
        (start + (end - start) * t).astype(np.uint8)
        for start, end in zip(BG_FROM, BG_TO)
    ]
    return Image.fromarray(np.dstack(channels), "RGB").convert("RGBA")


def arc_with_round_caps(draw, box, start, end, colour, width, scale):
    draw.arc(box, start, end, fill=colour, width=width)
    cx = (box[0] + box[2]) / 2
    cy = (box[1] + box[3]) / 2
    radius = (box[2] - box[0]) / 2
    cap = width / 2
    for degrees in (start, end):
        radians = math.radians(degrees)
        x = cx + math.cos(radians) * radius
        y = cy + math.sin(radians) * radius
        draw.ellipse((x - cap, y - cap, x + cap, y + cap), fill=colour)


def render(maskable: bool) -> Image.Image:
    size = VIEW * SS
    canvas = diagonal_gradient(size)

    if not maskable:
        # rx=112 rounded corners; maskable icons stay full-bleed so the
        # launcher can crop them to any shape.
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, size - 1, size - 1), radius=112 * SS, fill=255
        )
        canvas.putalpha(mask)

    # Maskable icons must keep their content inside the inner 80% safe zone.
    inset = 0.78 if maskable else 1.0
    scale = SS * inset
    offset = size * (1 - inset) / 2

    def p(x, y):
        return (x * scale + offset, y * scale + offset)

    def box(cx, cy, r):
        x0, y0 = p(cx - r, cy - r)
        x1, y1 = p(cx + r, cy + r)
        return (x0, y0, x1, y1)

    art = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(art)
    glow_draw = ImageDraw.Draw(glow)

    draw.ellipse(box(256, 256, 171), outline=INK + (41,), width=round(10 * scale))

    arc_with_round_caps(draw, box(256, 256, 171), -90, -10.45, RED + (255,), round(28 * scale), scale)
    for target in (glow_draw, draw):
        arc_with_round_caps(target, box(256, 256, 171), 10.45, 90, ACID + (255,), round(13 * scale), scale)

    draw.ellipse(box(256, 256, 102), fill=DIAL + (255,), outline=INK + (61,), width=round(5 * scale))
    draw.line([p(256, 256), p(247, 157)], fill=INK + (255,), width=round(16 * scale))
    draw.line([p(256, 256), p(328, 303)], fill=RED + (255,), width=round(9 * scale))
    # round caps for the hands
    for (x, y), colour, w in (((247, 157), INK, 16), ((328, 303), RED, 9)):
        draw.ellipse(box(x, y, w / 2), fill=colour + (255,))
    draw.ellipse(box(256, 256, 14), fill=ACID + (255,))

    star = [p(x, y) for x, y in STAR]
    draw.polygon(star, fill=ACID + (255,))
    glow_draw.polygon(star, fill=ACID + (255,))

    font = ImageFont.truetype(FONT_PATH, round(86 * scale))
    draw.text(p(256, 292), "6", font=font, fill=INK + (255,), anchor="ms")

    glow = glow.filter(ImageFilter.GaussianBlur(12 * scale / 2))
    canvas.alpha_composite(glow)
    canvas.alpha_composite(art)
    return canvas


def main() -> None:
    standard = render(maskable=False)
    maskable = render(maskable=True)

    targets = [
        (standard, 512, "icon-512.png"),
        (standard, 192, "icon-192.png"),
        (standard, 180, "apple-touch-icon.png"),
        (maskable, 512, "icon-maskable-512.png"),
    ]
    for source, size, name in targets:
        image = source.resize((size, size), Image.LANCZOS)
        if name == "apple-touch-icon.png":
            # iOS composites home-screen icons onto an opaque tile and applies
            # its own mask, so flatten the rounded corners away.
            flat = Image.new("RGB", (size, size), BG_TO)
            flat.paste(image, (0, 0), image)
            image = flat
        path = ASSETS / name
        image.save(path, "PNG", optimize=True)
        print(f"{path.relative_to(ROOT)}  {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
