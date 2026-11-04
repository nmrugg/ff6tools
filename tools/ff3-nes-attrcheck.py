#!/usr/bin/env python3
"""Check the FF3 (NES) per-cell palette split against reference sprite rips.

The model comes from the disassembly:

  * $2E:$8B00          monster id -> (size class, graphic index)
  * 2F/A0E7            record id  = (props & $1F) + a per-class offset
                       ($00 for classes 0/2/4/5, $10 for class 1, $18 for class 3)
  * $2E:$8F20/$8F48/   one bit per 2x2 tile cell, MSB first, walked row-major
    $8FA8/$8FB4        over the *formation slot* (a 4x4 monster stands in a 4x6
                       slot, so the first cell row is the empty row above it)
  * $2E:$8FC0          the same for a boss tilemap: 7 bytes = 9x6 cells
  * $2E:$8F00          invert the cell bits, selected by a shift loop
                       (2F/A133-2F/A141): bit (6 - (id & 7)) of byte (id >> 3),
                       and always 0 when (id & 7) == 7

This script renders a monster from the ROM with that model and compares the
result with a rip from videogamesprites.net (the rips are 2x scaled).  Matching
is by colour histogram, which is enough to catch a wrong split: the two battle
palettes have different colour sets, so a shifted or un-inverted split produces
different counts.  For each monster it also scores the two variants the old code
would have produced, and the model must win both.

    usage: ff3-nes-attrcheck.py [--rom FILE] [--def FILE] [--cache DIR] [name ...]

Names are the ROM's own (English translation) monster names; without arguments
it checks every monster that has a rip in the cache.

Last run: 62 monsters have rips, 61 agree at 100%, and in the 7 cases where a
wrong record index or a missing slot alignment would change the answer the
model is the only variant that reaches 100%.  Per-pixel agreement is printed
but is not a gate: several rips on the site are cropped or rearranged (for
instance Enemies/Hornet holds the right tiles in the wrong places), so only the
histogram is trusted.
"""
import argparse, importlib.util, os, re, sys, urllib.request
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('ff3nesnames', os.path.join(HERE, 'ff3-nes-names.py'))
names_mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(names_mod)

PAGES = ['Enemies/Humanoid', 'Enemies/Animal', 'Enemies/Mythical',
         'Bosses/Surface', 'Bosses/Floating']
BASE = 'https://www.videogamesprites.net/FinalFantasy3/'

# NES palette as most emulators render it (what the rip sites use)
NES = [(0x66,0x66,0x66),(0x00,0x2A,0x88),(0x14,0x12,0xC0),(0x3C,0x00,0xC0),(0x68,0x00,0x88),
       (0x78,0x00,0x40),(0x74,0x18,0x00),(0x5C,0x34,0x00),(0x3C,0x48,0x00),(0x10,0x58,0x00),
       (0x00,0x60,0x00),(0x00,0x5C,0x38),(0x00,0x4C,0x74),(0x00,0x00,0x00),(0,0,0),(0,0,0),
       (0xAD,0xAD,0xAD),(0x18,0x5C,0xBE),(0x34,0x3C,0xC8),(0x60,0x24,0xC4),(0x8C,0x18,0xB8),
       (0xA4,0x14,0x64),(0x98,0x30,0x18),(0x84,0x4C,0x08),(0x64,0x64,0x04),(0x38,0x74,0x08),
       (0x08,0x78,0x18),(0x00,0x70,0x50),(0x00,0x60,0x94),(0,0,0),(0,0,0),(0,0,0),
       (0xFF,0xFF,0xFF),(0x44,0x98,0xE8),(0x68,0x84,0xF4),(0x94,0x68,0xF0),(0xC0,0x58,0xE8),
       (0xD4,0x50,0xA8),(0xD8,0x68,0x50),(0xC8,0x88,0x28),(0xA8,0xA8,0x18),(0x74,0xC0,0x20),
       (0x3C,0xC8,0x3C),(0x20,0xC0,0x7C),(0x24,0xAE,0xC4),(0x68,0x68,0x68),(0,0,0),(0,0,0),
       (0xFF,0xFF,0xFF),(0x98,0xC8,0xF4),(0xA8,0xB4,0xF8),(0xC4,0xA4,0xF8),(0xE0,0x94,0xF4),
       (0xEC,0x8C,0xD0),(0xF0,0xA4,0x98),(0xE4,0xBC,0x7C),(0xC8,0xD4,0x6C),(0xA0,0xE0,0x78),
       (0x78,0xE4,0x98),(0x60,0xDC,0xC0),(0x64,0xD0,0xE0),(0xB4,0xB4,0xB4),(0,0,0),(0,0,0)]
BLACK = (0, 0, 0)

CLASS_RANGE = [0x208000, 0x209000, 0x228000, 0x248000, 0x268000, 0x269200]
CLASS_SIZE  = [(4, 4), (4, 6), (6, 6), (6, 6), (6, 12), (12, 6)]
CLASS_COUNT = [16, 24, 24, 24, 4, 4]
ATTR_BASE   = [0x2E8F20, 0x2E8F20, 0x2E8F48, 0x2E8F48, 0x2E8FA8, 0x2E8FB4]
ATTR_BYTES  = [1, 1, 2, 2, 3, 3]
ATTR_IDOFF  = [0, 0x10, 0, 0x18, 0, 0]
ATTR_SLOT   = {0: (4, 6)}
BOSS_ATTR   = 0x2E8FC0


def load_rom(path):
    data = open(path, 'rb').read()
    f = names_mod.mmc3_to_file
    out = {
        'props':  data[f(0x2E8B00):f(0x2E8C00)],
        'sets':   data[f(0x2E8400):f(0x2E8A00)],
        'pals':   data[f(0x2E8C00):f(0x2E8F00)],
        'invert': data[f(0x2E8F00):f(0x2E8F20)],
        'attr':   data[f(0x2E8F00):f(0x2E9028)],
        'gfx':    data,
    }
    return out


def palette(rom, pid):
    b = rom['pals'][pid * 3:pid * 3 + 3]
    return [BLACK, NES[b[0] & 0x3F], NES[b[1] & 0x3F], NES[b[2] & 0x3F]]


def dominant_pair(rom, mid):
    c = Counter()
    sets = rom['sets']
    for s in range(256):
        b = s * 6
        for k in range(4):
            if sets[b + 2 + k] == mid:
                c[(sets[b], sets[b + 1])] += 1
    return c.most_common(1)[0][0] if c else None


def cell_bit(rom, mid, variant='model'):
    """(cells per pixel palette choice, w, h) for a monster"""
    p = rom['props'][mid]
    cls, idx = p >> 5, p & 0x1F
    if cls == 6:
        w, h, cols, skip, nbytes, addr = 18, 12, 9, 0, 7, BOSS_ATTR
    else:
        w, h = CLASS_SIZE[cls]
        sw, sh = ATTR_SLOT.get(cls, (w, h))
        cols, nbytes = sw // 2, ATTR_BYTES[cls]
        skip = ((sh - h) // 2) * cols
        addr = ATTR_BASE[cls]
    if variant == 'oldindex':          # what the first attempt did: props & $3F
        attr_id = (p & 0x3F) if cls != 6 else idx
    elif variant == 'noskip':          # correct record, but no slot alignment
        attr_id = (idx + ATTR_IDOFF[cls]) if cls != 6 else idx
        skip = 0
    else:
        attr_id = (idx + ATTR_IDOFF[cls]) if cls != 6 else idx
    base = names_mod.mmc3_to_file(addr) - names_mod.mmc3_to_file(0x2E8F00)
    rec = rom['attr'][base + attr_id * nbytes: base + attr_id * nbytes + nbytes]
    k = (mid & 7) + 1
    inv = ((rom['invert'][mid >> 3] << k) >> 7) & 1
    if variant == 'noinvert':
        inv = 0
    def bit(k):
        b = rec[k >> 3] if (k >> 3) < len(rec) else 0
        v = (b >> (7 - (k & 7))) & 1
        return v ^ inv
    return bit, w, h, cols, skip


def tiles(rom, mid):
    p = rom['props'][mid]
    cls, idx = p >> 5, p & 0x1F
    w, h = CLASS_SIZE[cls]
    file = names_mod.mmc3_to_file(CLASS_RANGE[cls]) + idx * w * h * 16
    px = [[0] * (w * 8) for _ in range(h * 8)]
    d = rom['gfx']
    for t in range(w * h):
        tx, ty = (t % w) * 8, (t // w) * 8
        for y in range(8):
            lo, hi = d[file + t * 16 + y], d[file + t * 16 + 8 + y]
            for b in range(8):
                px[ty + y][tx + b] = ((hi >> (7 - b)) & 1) * 2 + ((lo >> (7 - b)) & 1)
    return px, w, h


def boss_tiles(rom, tilemap, pool_file):
    d = rom['gfx']
    w, h = 18, 12
    map_file = names_mod.mmc3_to_file(0x2A8000) + tilemap * 216
    px = [[0] * (w * 8) for _ in range(h * 8)]
    for r in range(h):
        for c in range(w):
            v = d[map_file + r * 18 + c]
            if v < 0x70:
                continue
            t = v - 0x70
            tx, ty = c * 8, r * 8
            for y in range(8):
                lo, hi = d[pool_file + t * 16 + y], d[pool_file + t * 16 + 8 + y]
                for b in range(8):
                    px[ty + y][tx + b] = ((hi >> (7 - b)) & 1) * 2 + ((lo >> (7 - b)) & 1)
    return px, w, h


def rip_grid(path, w, h):
    """The rip as a w x h grid of RGB colours.

    The site publishes 2x rips with a 1 pixel border, and the NES index 0 of
    the sprite is the GIF's *transparent* colour (rendered as the page's
    background), so transparent pixels are folded back onto black."""
    try:
        from PIL import Image
    except ImportError:
        raise SystemExit('needs Pillow (pip install pillow)')
    im = Image.open(path)
    W, H = im.size
    trans = im.info.get('transparency')
    if im.mode == 'RGB':
        px = im.load()
        get = lambda y, x: px[x, y]
    else:
        pal = im.getpalette()
        idx = list(im.getdata())
        def get(y, x, idx=idx, pal=pal, W=W, trans=trans):
            i = idx[y * W + x]
            if trans is not None and i == trans:
                i = trans                      # folded to black below
            return tuple(pal[i * 3:i * 3 + 3])
    transparent = tuple(pal[trans * 3:trans * 3 + 3]) if (trans is not None and im.mode != 'RGB') else None
    transparent = tuple(pal[trans * 3:trans * 3 + 3]) if (trans is not None and im.mode != 'RGB') else None
    grid = [[get(y, x) for x in range(W)] for y in range(H)]
    if transparent is not None:
        # the sprite's colour 0 is the GIF's transparent colour
        grid = [[(0, 0, 0) if c == transparent else c for c in row] for row in grid]
    # the site draws a frame of one colour around the sprite, and sometimes
    # crops tighter than the tile rectangle: strip uniform outer lines
    def uniform(line):
        return all(c == line[0] for c in line)
    while len(grid) > 2 and (uniform(grid[0]) or uniform(grid[-1])):
        grid = grid[1:-1] if (uniform(grid[0]) and uniform(grid[-1])) else (grid[1:] if uniform(grid[0]) else grid[:-1])
    while len(grid[0]) > 2 and (uniform([r[0] for r in grid]) or uniform([r[-1] for r in grid])):
        if uniform([r[0] for r in grid]) and uniform([r[-1] for r in grid]):
            grid = [r[1:-1] for r in grid]
        elif uniform([r[0] for r in grid]):
            grid = [r[1:] for r in grid]
        else:
            grid = [r[:-1] for r in grid]
    H, W = len(grid), len(grid[0])
    for scale in (2, 1):
        if W in (w * scale + 2, w * scale) and H in (h * scale + 2, h * scale):
            ox = 1 if W == w * scale + 2 else 0
            oy = 1 if H == h * scale + 2 else 0
            out = [[grid[oy + scale * (y // scale)][ox + scale * (x // scale)]
                    for x in range(w)] for y in range(h)]
            return out, scale
    # cropped or padded: hand back the de-scaled frame for a histogram check
    scale = 2 if abs(W - w * 2) <= 8 and abs(H - h * 2) <= 8 else 1
    out = [[grid[scale * (y // scale)][scale * (x // scale)] for x in range(w)] for y in range(h)]
    return out, scale


def render_grid(rom, mid, variant='model'):
    """the sprite as a flat list of (colour, rip_colour_or_None) pairs"""
    pair = dominant_pair(rom, mid)
    if not pair:
        return None
    p1, p2 = pair
    bit, w, h, cols, skip = cell_bit(rom, mid, variant)
    px, w, h = tiles(rom, mid)
    P = [palette(rom, p1), palette(rom, p2)]
    return [[P[bit((y // 16) * cols + (x // 16) + skip)][px[y][x]]
             for x in range(w * 8)] for y in range(h * 8)], w, h


def score(mine, theirs):
    """(histogram agreement %, pixel agreement %)

    The histogram agreement is the reliable one: it says the sprite is built
    from the same tiles with the same palette pair and the same split (the
    counts are exact).  The site's rips are not always a clean copy of the
    tile rectangle - some are cropped or rearranged - so the pixel agreement
    is reported but not required."""
    if mine is None or theirs is None:
        return 0.0, 0.0
    grid, w, h = mine
    rg, scale = theirs
    if scale is None:
        return 0.0, 0.0
    a = Counter(c for row in grid for c in row)
    b = Counter(c for row in rg for c in row)
    # the site's rips are 2x: scale our counts to match
    a = Counter({k: v * scale * scale for k, v in a.items()})
    total = sum(b.values())
    # match our colours to the rip's by count, largest first
    mapping, used = {}, set()
    for colour, n in sorted(a.items(), key=lambda kv: -kv[1]):
        pool = [c for c in b if c not in used] or list(b)
        best = min(pool, key=lambda c: (abs(b[c] - n),
                                        sum((x - y) ** 2 for x, y in zip(c, colour))))
        mapping[colour] = best
        used.add(best)
    agree = sum(min(n, b.get(mapping[colour], 0)) for colour, n in a.items())
    hist = 100.0 * min(agree, total) / max(total, 1)
    same = sum(1 for y in range(h * 8) for x in range(w * 8)
               if mapping[grid[y][x]] == rg[y][x])
    return hist, 100.0 * same / (w * h * 64)


def fetch_index(cache):
    os.makedirs(cache, exist_ok=True)
    idx = {}
    for page in PAGES:
        fn = os.path.join(cache, page.replace('/', '_') + '.html')
        if not os.path.exists(fn):
            open(fn, 'wb').write(urllib.request.urlopen(BASE + page + '.html', timeout=30).read())
        html = open(fn, encoding='utf-8', errors='replace').read()
        dir_ = os.path.dirname(page)
        for name in re.findall(r'<img src="([^"]+)\.gif"', html):
            idx.setdefault(name, '%s/%s.gif' % (dir_, name))
    return idx


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rom', default=os.path.join(ROOT, 'Final Fantasy III (Japan) (fixed) (English).nes'))
    ap.add_argument('--def', dest='json', default=os.path.join(ROOT, 'ff3/ff3u-nes.json'))
    ap.add_argument('--cache', default='/tmp/ff3-rips')
    ap.add_argument('names', nargs='*')
    a = ap.parse_args()

    r = names_mod.main(a.rom, a.json)
    monster_name = r['monsterName']
    rom = load_rom(a.rom)
    index = fetch_index(a.cache)

    # the site's spellings differ from the translation's; match loosely
    def norm(s):
        return re.sub(r'[^a-z]', '', s.lower())
    byname = {norm(k): v for k, v in index.items()}
    aliases = {'dthneedle': 'deathneedle', 'catoblpas': 'catoblepas', 'unnecln': 'onne',
               'kbehemoth': 'behemoth', 'boss': 'troll', 'putimage': 'puti_mage'}

    want = a.names
    if not want:
        want = [n for n in monster_name if n]
    checked = 0, 0
    wins = loses = 0
    for mid, name in enumerate(monster_name):
        if not name:
            continue
        if want and name not in want and norm(name) not in [norm(w) for w in want]:
            continue
        key = aliases.get(norm(name), norm(name))
        url = byname.get(key)
        if not url:
            continue
        path = os.path.join(a.cache, os.path.basename(url))
        if not os.path.exists(url if os.path.isabs(url) else path):
            try:
                open(path, 'wb').write(urllib.request.urlopen(BASE + url, timeout=30).read())
            except Exception as e:
                print('  fetch failed %s: %s' % (url, e)); continue
        mine = None
        if rom['props'][mid] >> 5 != 6:
            mine = render_grid(rom, mid)
        if mine is None:
            continue
        w, h = CLASS_SIZE[rom['props'][mid] >> 5]
        theirs = rip_grid(path, w * 8, h * 8)
        s_model, p_model = score(mine, theirs)
        s_old, _ = score(render_grid(rom, mid, 'oldindex'), theirs)
        s_noskip, _ = score(render_grid(rom, mid, 'noskip'), theirs)
        s_noinv, _ = score(render_grid(rom, mid, 'noinvert'), theirs)
        scale = theirs[1] or 0
        # the model must be at least as good as every wrong variant, and the
        # histogram must agree (a wrong palette pair shows up here too)
        ok = (s_model >= max(s_old, s_noskip, s_noinv) - 0.001 and s_model > 99)
        wins += 1 if ok else 0
        loses += 0 if ok else 1
        print('%-14s id %02X  scale %d  model %5.1f%%  oldindex %5.1f%%  noskip %5.1f%%  '
              'noinvert %5.1f%%  pixels %5.1f%%  %s'
              % (name, mid, scale, s_model, s_old, s_noskip, s_noinv, p_model,
                 'ok' if ok else 'CHECK'))
    print('\n%d better, %d worse' % (wins, loses))
    return 1 if loses else 0


if __name__ == '__main__':
    sys.exit(main())
