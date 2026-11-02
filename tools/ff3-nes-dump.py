#!/usr/bin/env python3
"""Dump FF3 (Japan) NES graphics from the PRG-ROM as 2bpp sprite sheets, using
the same addressing the game (and ff6tools) uses.

    usage: ff3-nes-dump.py [what ...] [-o out.png] [-z zoom] [-d definition.json]

    what: monsters chars toad mini all

Monster graphics are split into fixed-size "size classes" ($2F:$A4B4); a
monster's class is bits 5-7 of $2E:$8B00[monster] and its index inside the
class is bits 0-4.  Battle character graphics are one 42-tile block per job id
at 28/8000 + job * 672, with toad/mini as pseudo-jobs at 29/BF80 and 29/BF00.

With -d (a definition json) each sprite is drawn with the palette the
definition pins for it (itemPalettes), i.e. exactly what the app shows.
"""
import json, os, re, sys, argparse
from PIL import Image

ROMNAME = 'Final Fantasy III (Japan) (fixed).nes'

def mmc3_to_file(addr):
    """romtools.js ROM.MapMode.mmc3 mapAddress: def address -> file offset."""
    return ((addr & 0xFF0000) >> 3) + (addr & 0x1FFF) + 0x10

# size classes, from the table at $2F:$A4B4 (file 0x5E4C4) and sizes $2F:$A4CC.
# (class, definition key, def begin, def end, width in tiles, height in tiles)
MONSTER_CLASSES = [
    (0, 'monsterGraphics4x4',  0x208000, 0x209000,  4,  4),
    (1, 'monsterGraphics4x6',  0x209000, 0x219400,  4,  6),
    (2, 'monsterGraphics6x6',  0x228000, 0x239600,  6,  6),
    (3, 'monsterGraphics6x6b', 0x248000, 0x259600,  6,  6),
    (4, 'monsterGraphics6x12', 0x268000, 0x269200,  6, 12),
    (5, 'monsterGraphics12x6', 0x269200, 0x278400, 12,  6),
]

# battle characters: 42 tiles (672 bytes) per job id at 28/8000, two wide
CHARS = (0x288000, 0x299F00, 2, 21, 24)
# mini (job $19) and toad (job $18) pseudo-jobs, 8 tiles each.
# NOTE: in the tool's mapped address space only $8000-$9FFF address a bank's
# 8 KiB, so file 0x54000 (end of bank 29) can only be written as 0x2A8000.
TOAD = (0x299F80, 0x2A8000, 2, 4, 1)
MINI = (0x299F00, 0x299F80, 2, 4, 1)

GREY = [(255, 255, 255), (150, 150, 150), (80, 80, 80), (0, 0, 0)]


def colors_nes():
    """The 64-entry NES palette from rom/gfx.js, so this sheet matches the app."""
    path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'rom', 'gfx.js')
    src = open(path, encoding='utf-8').read()
    m = re.search(r'colorsNES: \[(.*?)\n    \],', src, re.S)
    nums = [int(x) for x in re.findall(r'-?\d+', m.group(1))]
    return [tuple(nums[i:i + 3]) for i in range(0, len(nums), 3)]


def resolve_palette(data, entry):
    """battlePalettes[N] -> 4 RGB colours, colour 0 fixed black (nesFixedPalette).
    An itemPalettes entry is a list of palette definitions; the first one that
    names a specific palette is the default the app opens with."""
    for e in (entry if isinstance(entry, list) else [entry]):
        path = e if isinstance(e, str) else (e or {}).get('path', '')
        m = re.match(r'battlePalettes\[(\d+)\]$', path or '')
        if not m:
            continue
        off = mmc3_to_file(0x2E8C00) + int(m.group(1)) * 3
        cols = colors_nes()
        return [(0, 0, 0)] + [cols[data[off + i] & 0x3F] for i in range(3)]
    return None


def decode_tile(buf, base):
    """NES 2bpp planar tile -> 8 rows of 8 colour indices."""
    rows = []
    for y in range(8):
        lo, hi = buf[base + y], buf[base + 8 + y]
        rows.append([(((hi >> (7 - x)) & 1) * 2) + ((lo >> (7 - x)) & 1)
                     for x in range(8)])
    return rows

def sprite(buf, item, w, h, pal=None):
    """One item's worth of w*h tiles, laid out w columns x h rows -> PIL image."""
    pal = pal or GREY
    im = Image.new('RGB', (w * 8, h * 8), pal[0])
    px = im.load()
    base = item * w * h * 16
    for t in range(w * h):
        b = base + t * 16
        if b + 16 > len(buf):
            break
        x, y = t % w, t // w
        tile = decode_tile(buf, b)
        for r in range(8):
            for c in range(8):
                px[x * 8 + c, y * 8 + r] = pal[tile[r][c]]
    return im

def sheet(items, cols, gap, label):
    if not items:
        return None
    cw = max(i.width for i in items) + gap
    ch = max(i.height for i in items) + gap
    rows = (len(items) + cols - 1) // cols
    out = Image.new('RGB', (cols * cw, rows * ch), (70, 70, 70))
    for n, im in enumerate(items):
        out.paste(im, ((n % cols) * cw + gap // 2, (n // cols) * ch + gap // 2))
    return out

def grab(data, begin, end):
    f0, f1 = mmc3_to_file(begin), mmc3_to_file(end)
    return data[f0:f1], f0, f1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('-o', '--out', default='ff3-nes-gfx.png')
    ap.add_argument('-r', '--rom', default=ROMNAME)
    ap.add_argument('-d', '--def', dest='json', default=None,
                    help='definition json: use its itemPalettes so every sprite '
                         'is drawn with the palette the game actually uses')
    ap.add_argument('-g', '--gap', type=int, default=6)
    ap.add_argument('-z', '--zoom', type=int, default=2)
    ap.add_argument('what', nargs='*', default=['monsters'])
    args = ap.parse_args()

    data = open(args.rom, 'rb').read()
    what = set(args.what)
    if 'all' in what:
        what = {'monsters', 'chars', 'toad', 'mini'}
    if not what:
        what = {'monsters'}

    # palettes straight from the definition, so the sheet matches the app
    item_palettes = {}
    if args.json:
        defn = json.load(open(args.json, encoding='utf-8'))
        for cls, key, begin, end, w, h in MONSTER_CLASSES:
            ips = defn['assembly'].get(key, {}).get('itemPalettes') or []
            item_palettes[key] = [resolve_palette(data, e) for e in ips]
        for key in ('battleCharacterGraphics', 'battleCharacterGraphicsStatus'):
            ips = defn['assembly'].get(key, {}).get('itemPalettes') or []
            item_palettes[key] = [resolve_palette(data, e) for e in ips]

    def pal_for(key, i, default=GREY):
        p = item_palettes.get(key)
        if p and i < len(p) and p[i]:
            return p[i]
        return default

    sheets = []
    if 'monsters' in what:
        for cls, key, begin, end, w, h in MONSTER_CLASSES:
            buf, f0, f1 = grab(data, begin, end)
            count = (f1 - f0) // (w * h * 16)
            print('monster class %d: def %06X-%06X file %06X-%06X  '
                  '%dx%d tiles, stride %d, %d items' %
                  (cls, begin, end, f0, f1, w, h, w * h * 16, count))
            items = [sprite(buf, i, w, h, pal_for(key, i)) for i in range(count)]
            s = sheet(items, 8, args.gap, 'class %d' % cls)
            if s:
                sheets.append(('monster class %d (%dx%d)' % (cls, w, h), s))

    for name, key, spec in (('chars', 'battleCharacterGraphics', CHARS),
                            ('toad', 'battleCharacterGraphicsStatus', TOAD),
                            ('mini', 'battleCharacterGraphicsStatus', MINI)):
        if name not in what:
            continue
        begin, end, w, h, count = spec
        buf, f0, f1 = grab(data, begin, end)
        print('%s: def %06X-%06X file %06X-%06X  %dx%d tiles, %d items' %
              (name, begin, end, f0, f1, w, h, count))
        offset = 1 if name == 'toad' else 0      # mini is item 0, toad item 1
        items = [sprite(buf, i + offset, w, h, pal_for(key, i + offset)) for i in range(count)]
        s = sheet(items, 8, args.gap, name)
        if s:
            sheets.append((name, s))

    if not sheets:
        print('nothing to do')
        return
    W = max(s.width for _, s in sheets)
    H = sum(s.height for _, s in sheets) + 12 * len(sheets)
    out = Image.new('RGB', (W, H), (30, 30, 30))
    y = 0
    for _, s in sheets:
        out.paste(s, (0, y))
        y += s.height + 12
    if args.zoom != 1:
        out = out.resize((out.width * args.zoom, out.height * args.zoom), Image.NEAREST)
    out.save(args.out)
    print('wrote', args.out)

if __name__ == '__main__':
    main()
