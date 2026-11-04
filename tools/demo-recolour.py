#!/usr/bin/env python3
"""Simulates what you'd do in GIMP/Aseprite: take the exported monster PNG,
change its colors, save it back out as an indexed PNG."""
from PIL import Image
import sys

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('P')
pal = im.getpalette()

# recolor: make the pot red/gold instead of blue/brown, keep color 0 transparent
new = list(pal)
for i in range(1, 16):
    r, g, b = pal[i*3:i*3+3]
    # push blues toward reds, brighten mid tones
    nr = min(255, int(r*0.6 + g*0.2 + 90))
    ng = min(255, int(g*0.5 + 40))
    nb = max(0,   int(b*0.35))
    new[i*3:i*3+3] = [nr, ng, nb]
im.putpalette(new)

# and repaint one pixel block so the change is obvious even with few colors
px = im.load()
w, h = im.size
main = max(range(1, 16), key=lambda c: sum(1 for y in range(h) for x in range(w) if px[x, y] == c))
for y in range(h//3, h//3 + 8):
    for x in range(w//2 - 4, w//2 + 4):
        if px[x, y] == main:
            px[x, y] = 1

im.save(dst, optimize=True)
print(f'wrote {dst}  ({w}x{h}, {len(set(im.getdata()))} indices used)')
