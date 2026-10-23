"""Draws the app icon (build/icon.png, 1024x1024) from scratch: a four-point star on an orbit, on a night-teal tile.

Run: python3 scripts/make-icon.py  (needs Pillow). electron-builder turns build/icon.png into the macOS .icns.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SCALE = 4  # supersampling for smooth edges
S = SIZE * SCALE

# macOS app icon grid: an 824 px rounded tile centred on the 1024 canvas.
TILE = 824 * SCALE
MARGIN = (S - TILE) // 2
RADIUS = int(TILE * 0.2237)

TOP = (16, 58, 74)
BOTTOM = (8, 22, 32)
ACCENT = (36, 151, 173)  # the app's brand teal
STAR = (246, 250, 252)


def gradient_tile() -> Image.Image:
    tile = Image.new('RGB', (TILE, TILE))
    px = tile.load()
    for y in range(TILE):
        t = y / (TILE - 1)
        row = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * t) for i in range(3))
        for x in range(TILE):
            px[x, y] = row
    return tile


def star_points(cx: float, cy: float, outer: float, inner: float) -> list[tuple[float, float]]:
    points = []
    for i in range(8):
        r = outer if i % 2 == 0 else inner
        a = -math.pi / 2 + i * math.pi / 4
        points.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return points


def main() -> None:
    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    mask = Image.new('L', (TILE, TILE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, TILE - 1, TILE - 1), RADIUS, fill=255)
    canvas.paste(gradient_tile(), (MARGIN, MARGIN), mask)

    cx = cy = S / 2
    art = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(art)

    # A tilted orbit: an ellipse drawn on its own layer, then rotated.
    orbit = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    od = ImageDraw.Draw(orbit)
    rx, ry = TILE * 0.40, TILE * 0.15
    od.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), outline=ACCENT + (255,), width=int(18 * SCALE))
    orbit = orbit.rotate(-24, resample=Image.BICUBIC, center=(cx, cy))
    art.alpha_composite(orbit)

    # A soft glow behind the star.
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (cx - TILE * 0.2, cy - TILE * 0.2, cx + TILE * 0.2, cy + TILE * 0.2), fill=ACCENT + (150,)
    )
    art.alpha_composite(glow.filter(ImageFilter.GaussianBlur(TILE * 0.08)))

    draw = ImageDraw.Draw(art)
    draw.polygon(star_points(cx, cy, TILE * 0.30, TILE * 0.075), fill=STAR + (255,))

    # A small companion star on the orbit.
    a = math.radians(24)  # PIL rotates counter-clockwise on screen; in y-down coordinates that is +24°
    ox, oy = cx + rx * math.cos(math.radians(200)), cy + ry * math.sin(math.radians(200))
    sx = cx + (ox - cx) * math.cos(a) - (oy - cy) * math.sin(a)
    sy = cy + (ox - cx) * math.sin(a) + (oy - cy) * math.cos(a)
    draw.polygon(star_points(sx, sy, TILE * 0.07, TILE * 0.02), fill=STAR + (255,))

    clipped = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    tile_mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(tile_mask).rounded_rectangle(
        (MARGIN, MARGIN, MARGIN + TILE - 1, MARGIN + TILE - 1), RADIUS, fill=255
    )
    clipped.paste(art, (0, 0), Image.composite(art, Image.new('RGBA', (S, S)), tile_mask).getchannel('A'))
    canvas.alpha_composite(clipped)

    out = Path(__file__).resolve().parent.parent / 'build' / 'icon.png'
    out.parent.mkdir(exist_ok=True)
    canvas.resize((SIZE, SIZE), Image.LANCZOS).save(out)
    print(out)


if __name__ == '__main__':
    main()
