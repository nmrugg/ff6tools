#!/usr/bin/env python3
"""Render candidate PRG regions of FF3 (J) as NES 2bpp planar tile sheets, to
locate the battle/monster graphics. Usage: ff3-nes-tilesheet.py OFFSET [LEN]"""
import sys
from PIL import Image
ROMNAME = 'Final Fantasy III (Japan) (fixed).nes'
data = open(ROMNAME, 'rb').read()

def mmc3_to_file(addr):
    """romtools.js ROM.MapMode.mmc3 mapAddress: def address -> index into the
       iNES file buffer (which includes the 16-byte header)."""
    return ((addr & 0xFF0000) >> 3) + (addr & 0x1FFF) + 0x10

HDR = 16
off = int(sys.argv[1], 16) if len(sys.argv) > 1 else 0x3A000
length = int(sys.argv[2], 16) if len(sys.argv) > 2 else 0x2000
foff = mmc3_to_file(off)
print('def address 0x%06x -> file offset 0x%06x' % (off, foff))
buf = data[foff: foff + length]

def tiles_2bpp(buf, n):
    """NES 2bpp planar: 16 bytes per 8x8 tile (8 bytes plane0, 8 bytes plane1)."""
    out = []
    for t in range(n):
        base = t * 16
        if base + 16 > len(buf):
            break
        rows = []
        for y in range(8):
            lo = buf[base + y]
            hi = buf[base + 8 + y]
            row = []
            for x in range(8):
                bit = 7 - x
                row.append(((hi >> bit) & 1) * 2 + ((lo >> bit) & 1))
            rows.append(row)
        out.append(rows)
    return out

n = length // 16
tiles = tiles_2bpp(buf, n)
cols = 16
rows = (len(tiles) + cols - 1) // cols
scale = 3
im = Image.new('L', (cols * 8 * scale, rows * 8 * scale), 255)
px = im.load()
PAL = (0, 100, 180, 255)
for i, tile in enumerate(tiles):
    ox, oy = (i % cols) * 8, (i // cols) * 8
    for y in range(8):
        for x in range(8):
            v = PAL[tile[y][x]]
            for dy in range(scale):
                for dx in range(scale):
                    px[(ox + x) * scale + dx, (oy + y) * scale + dy] = v
out = 'ff3-nes-sheet-%05x.png' % off
im.save(out)
print('wrote %s  (offset 0x%05x, %d tiles, 2bpp planar)' % (out, off, len(tiles)))
