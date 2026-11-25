#!/usr/bin/env python3
"""Toolbar icons (0.3.7): the kit mark cropped to its content and fitted almost edge to edge.

The kit's *-badge-safe icons keep the mark small and shifted (a corner left free for the badge); in the Chrome
toolbar that reads as a tiny wallet. Chrome draws the badge over the icon anyway, as with every wallet extension.

  16 px  logo/mark-16.svg   pixel-grid mark, rendered natively at 16 (already 1 px field), no resampling
  32 px  logo/mark-small.svg
  48 px  logo/mark.svg
Each SVG is rasterised at 1024 with a transparent background, cropped to alpha >= 16 (drops the faint drop shadow),
fitted into size - 2*PAD keeping the aspect, centred both ways, downscaled with LANCZOS, then a light unsharp mask
(radius 0.6, 40 %, threshold 2) on 32 only — no halo at these settings.

Usage: scripts/make-action-icons.py <ui-kit-dir> <chrome-headless-shell>   (LD_LIBRARY_PATH as for the shell)
Writes public/icons/action-{16,32,48}.png and replaces public/icons/icon128.png (run after make-icons.mjs): the kit's
128 holds an 85 px wide mark; the store allows 96 + 16 px field, so the mark (with its shadow) is fitted into 96.
"""
import os, subprocess, sys, tempfile
from PIL import Image, ImageFilter

kit, chrome = sys.argv[1].rstrip('/'), sys.argv[2]
PAD = {32: 1, 48: 1}
SRC = {32: 'mark-small', 48: 'mark'}


def raster(svg, size):
    with tempfile.TemporaryDirectory() as d:
        html, png = os.path.join(d, 'r.html'), os.path.join(d, 'r.png')
        with open(html, 'w') as f:
            f.write(f"<html><body style='margin:0;background:transparent'><img src='file://{svg}' "
                    f"style='width:{size}px;height:{size}px;display:block'></body></html>")
        subprocess.run([chrome, '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
                        '--default-background-color=00000000', f'--window-size={size},{size}',
                        '--virtual-time-budget=2000', f'--screenshot={png}', f'file://{html}'],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return Image.open(png).convert('RGBA').copy()


def fit(svg, size, pad, sharpen, alpha_min=16):
    big = raster(svg, 1024)
    box = big.split()[-1].point(lambda v: 255 if v >= alpha_min else 0).getbbox()
    crop = big.crop(box)
    w, h = crop.size
    k = (size - 2 * pad) / max(w, h)
    tw, th = max(1, round(w * k)), max(1, round(h * k))
    small = crop.resize((tw, th), Image.LANCZOS)
    if sharpen:
        small = small.filter(ImageFilter.UnsharpMask(radius=0.6, percent=40, threshold=2))
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(small, ((size - tw) // 2, (size - th) // 2))
    return out


os.makedirs('public/icons', exist_ok=True)
raster(f'{kit}/logo/mark-16.svg', 16).save('public/icons/action-16.png', optimize=True)
for s in (32, 48):
    fit(f'{kit}/logo/{SRC[s]}.svg', s, PAD[s], s == 32).save(f'public/icons/action-{s}.png', optimize=True)
fit(f'{kit}/logo/mark.svg', 128, 16, False, alpha_min=1).save('public/icons/icon128.png', optimize=True)
for s in (16, 32, 48):
    im = Image.open(f'public/icons/action-{s}.png')
    print(f'action-{s}.png', im.size, 'content', im.split()[-1].getbbox())
print('icon128.png content', Image.open('public/icons/icon128.png').split()[-1].getbbox())
