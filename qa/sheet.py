"""Contact sheets: original | alpha matte | cutout over a checkerboard.

Checkerboard rather than a flat colour, because a flat backdrop hides exactly the
failures that matter — halos, leftover background fringe, and semi-transparent
holes all read as "fine" against white.
"""
import pathlib
from PIL import Image, ImageDraw, ImageFont

IN = pathlib.Path('/tmp/qa/in')
OUT = pathlib.Path('/tmp/qa/out')
SHEETS = pathlib.Path('/tmp/qa/sheets')
SHEETS.mkdir(exist_ok=True)
H = 420
PAD = 8


def checker(size, sq=12):
    w, h = size
    img = Image.new('RGB', size, (255, 255, 255))
    d = ImageDraw.Draw(img)
    for y in range(0, h, sq):
        for x in range(0, w, sq):
            if (x // sq + y // sq) % 2:
                d.rectangle([x, y, x + sq, y + sq], fill=(200, 200, 200))
    return img


def fit(img, h=H):
    return img.resize((max(1, round(img.width * h / img.height)), h), Image.LANCZOS)


def label(img, text):
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, len(text) * 7 + 8, 16], fill=(0, 0, 0))
    d.text((4, 3), text, fill=(255, 255, 255))
    return img


for src in sorted(IN.glob('*.jpg')):
    orig = fit(Image.open(src).convert('RGB'))
    alpha = fit(Image.open(OUT / f'{src.stem}_alpha.png').convert('RGB'))
    cut = fit(Image.open(OUT / f'{src.stem}_cutout.png'))
    bg = checker(cut.size)
    bg.paste(cut, (0, 0), cut)

    panels = [label(orig, 'original'), label(alpha, 'alpha'), label(bg, 'cutout')]
    w = sum(p.width for p in panels) + PAD * (len(panels) + 1)
    sheet = Image.new('RGB', (w, H + PAD * 2), (30, 30, 30))
    x = PAD
    for p in panels:
        sheet.paste(p, (x, PAD))
        x += p.width + PAD
    sheet.save(SHEETS / f'{src.stem}.png')
    print(src.stem, sheet.size)
