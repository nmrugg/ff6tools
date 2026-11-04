#!/usr/bin/env python3
"""Verify every FF3 (NES) monster and boss rendering against reference rips.

This is the "are the palettes actually right?" check. It works in two passes:

1. **Calibrate the NES palette the rip site uses.** videogamesprites.net renders
   NES colours with its own emulation, so an RGB comparison against a hand-picked
   table fails (our magenta is (140,24,184), theirs is (219,0,205)). But the tile
   data is beyond doubt, so for a monster we know exactly which NES palette *byte*
   each rip pixel must be: the tile gives the 2-bit index, the attribute table
   gives the palette (0 or 1), and the battle group gives the palette ids. Match
   our colour counts to the rip's colour counts (they agree exactly when the
   model is right) and each match is one observation "NES byte X renders as
   RGB(a,b,c)". Across dozens of monsters those observations agree with each
   other, which gives the site's NES table.

2. **Check everything with that table.** With the table, our render of a monster
   or boss becomes a multiset of the rip's exact RGB values, and the score is the
   intersection - no guessing. Then the same render is tried with the two palettes
   swapped and with the cell bits inverted, and the model must be the best of the
   three. A monster where "swapped" wins is a monster whose palette pair is in the
   wrong order, and that is reported.

    usage: ff3-nes-palcheck.py [--rom FILE] [--def FILE] [--cache DIR] [--report]

Bosses are checked through the boss tilemap + pool + $2E:$8FC0 cell records, and
the two summon-backed bosses (Odin, Leviathan) through their summon blocks.
"""
import argparse, importlib.util, os, re, sys, urllib.request
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
spec = importlib.util.spec_from_file_location('ff3nesattr', os.path.join(HERE, 'ff3-nes-attrcheck.py'))
attr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(attr)

PAGES = ['Enemies/Humanoid', 'Enemies/Animal', 'Enemies/Mythical',
         'Bosses/Surface', 'Bosses/Floating']
BASE = 'https://www.videogamesprites.net/FinalFantasy3/'

def norm(s):
    return re.sub(r'[^a-z]', '', s.lower())

# the site's spellings vs the English translation's own names
ALIASES = {'dthneedle': 'deathneedle', 'catoblpas': 'catoblepas', 'unnecln': 'onne',
           'kbehemoth': 'behemoth', 'bosstroll': 'troll', 'goldwarr': 'goldwarrior',
           'goldkngt': 'goldknight', 'mchimera': 'masterchimera', 'klizard': 'kolizard',
           '2headd': 'twoheadeddragon', 'hecan': 'helcan'}

def lookup(index, name):
    n = norm(name)
    return index.get(ALIASES.get(n, n))


def rom_tables(path):
    rom = attr.load_rom(path)
    f = attr.names_mod.mmc3_to_file
    rom['bossPointers'] = None
    return rom


def nes_bytes_for(rom, pid):
    """the four NES palette bytes of a battle palette (colour 0 is always $0F)"""
    b = rom['pals'][pid * 3:pid * 3 + 3]
    return [0x0F, b[0], b[1], b[2]]


def monster_nes(mid, rom, variant='model'):
    """the NES palette bytes a monster's pixels use, as a multiset"""
    p = rom['props'][mid]
    if (p >> 5) == 6:
        return None
    pair = attr.dominant_pair(rom, mid)
    if not pair:
        return None
    p1, p2 = pair if variant != 'swap' else (pair[1], pair[0])
    # cell_bit applies the per-monster inversion (2F/A8BF) unless told not to
    bit, w, h, cols, skip = attr.cell_bit(
        rom, mid, 'noinvert' if variant == 'noinvert' else 'model')
    px, w, h = attr.tiles(rom, mid)
    P = [nes_bytes_for(rom, p1), nes_bytes_for(rom, p2)]
    out = Counter()
    for y in range(h * 8):
        for x in range(w * 8):
            k = (y // 16) * cols + (x // 16) + skip
            out[P[bit(k)][px[y][x]]] += 1
    return out


def boss_nes(i, rom, variant='model'):
    """the NES palette bytes a boss tilemap's pixels use"""
    f = attr.names_mod.mmc3_to_file
    bp = rom['gfx'][f(0x2E9068):f(0x2E9068) + 48]
    lo, hi = bp[2 * i], bp[2 * i + 1]
    summon = (hi >> 5) & 1
    bank = 0x0C if summon else 0x20 + 2 * ((hi >> 6) & 3)
    tile = ((hi & 3) << 8) | lo
    pool = bank * 0x2000 + tile * 16 + 0x10
    px, w, h = attr.boss_tiles(rom, i, pool)
    props = rom['props']
    owners = [m for m in range(256) if (props[m] >> 5) == 6 and (props[m] & 0x1F) == i]
    pair = None
    for m in owners:
        pair = attr.dominant_pair(rom, m)
        if pair:
            break
    if not pair:
        return None
    p1, p2 = pair if variant != 'swap' else (pair[1], pair[0])
    inv = 0
    if owners:
        m = owners[0]
        k = (m & 7) + 1
        inv = ((rom['invert'][m >> 3] << k) >> 7) & 1
        if variant == 'noinvert':
            inv = 0
    addr = f(0x2E8FC0) + i * 7
    P = [nes_bytes_for(rom, p1), nes_bytes_for(rom, p2)]
    out = Counter()
    for y in range(h * 8):
        for x in range(w * 8):
            k = (y // 16) * 9 + (x // 16)
            b = ((rom['gfx'][addr + (k >> 3)] >> (7 - (k & 7))) & 1) ^ inv
            out[P[b][px[y][x]]] += 1
    return out


def rip_colours(path):
    """the rip's colour histogram, in 1x pixels

    The site draws a 1 pixel frame and uses the GIF's transparent colour for the
    area outside the sprite's silhouette - both of those are NES colour 0 in the
    ROM, so transparent pixels fold onto black and the frame is dropped."""
    from PIL import Image
    im = Image.open(path)
    trans = im.info.get('transparency')
    pal = im.getpalette()
    idx = list(im.getdata())
    W, H = im.size
    c = Counter()
    for i, v in enumerate(idx):
        x, y = i % W, i // W
        if x == 0 or y == 0 or x == W - 1 or y == H - 1:
            continue                      # the site's 1 pixel frame
        if trans is not None and v == trans:
            rgb = (0, 0, 0)               # NES colour 0
        else:
            rgb = tuple(pal[v * 3:v * 3 + 3])
        c[rgb] += 1
    scale = 2 if all(v % 4 == 0 for v in c.values()) else 1
    if scale == 2:
        c = Counter({k: v // 4 for k, v in c.items()})
    return c


def pair_by_count(mine, theirs):
    """match our NES bytes to the rip's colours by pixel count (exact when the
    model is right); returns [(nesByte, ripRGB)] or None if it cannot be done"""
    tleft = dict(theirs)
    out = []
    for nb, n in sorted(mine.items(), key=lambda kv: -kv[1]):
        cands = [c for c, v in tleft.items() if v >= n and v > 0]
        if not cands:
            return None
        near = rgb_of(nb)
        best = min(cands, key=lambda c: sum((a - b) ** 2 for a, b in zip(c, near)))
        out.append((nb, best))
        tleft[best] -= n
    if sum(tleft.values()) > 0:
        return None
    return out


def calibrate(rom, names, index, cache, seed=None):
    """NES byte -> rip RGB, learned from the rips themselves.

    A pairing is only trusted when it is unambiguous: the pixel count of our
    colour is unique among ours and the rip colour with that count is unique
    among theirs. Ambiguous cases are left to the seed table (or to the answer
    learned from other monsters), which keeps the noise down."""
    obs = defaultdict(Counter)
    checked = []
    table = dict(seed) if seed else {i: attr.NES[i] for i in range(0x40)}
    for mid, name in enumerate(names):
        if not name or (rom['props'][mid] >> 5) == 6:
            continue
        url = lookup(index, name)
        if not url:
            continue
        path = os.path.join(cache, os.path.basename(url))
        if not os.path.exists(path):
            continue
        mine = monster_nes(mid, rom)
        if mine is None:
            continue
        theirs = rip_colours(path)
        if sum(mine.values()) != sum(theirs.values()):
            continue
        tleft = dict(theirs)
        ours = Counter(mine)
        ok = True
        pairs = []
        for nb, n in sorted(mine.items(), key=lambda kv: -kv[1]):
            sameOurs = sum(1 for v in ours.values() if v == n)
            sameTheirs = Counter(Counter(tleft.values()))
            cands = [c for c, v in tleft.items() if v == n and sameTheirs[v] == 1]
            if len(cands) != 1 or sameOurs != 1:
                # ambiguous: keep the seed table's answer, do not learn from it
                near = table.get(nb, rgb_of(nb))
                guess = min(tleft, key=lambda c: sum((a - b) ** 2 for a, b in zip(c, near)))
                if tleft[guess] < n:
                    ok = False
                    break
                pairs.append((nb, guess))
                tleft[guess] -= n
            else:
                pairs.append((nb, cands[0]))
                tleft[cands[0]] -= n
        if not ok or sum(tleft.values()) > 0:
            continue
        for nb, rgb in pairs:
            obs[nb][rgb] += 1
        checked.append(mid)
    out = dict(table)
    for nb, c in obs.items():
        rgb, n = c.most_common(1)[0]
        out[nb] = rgb
    return out, checked


RGB = {}
def rgb_of(nb):
    """our own NES->RGB, the one the app renders with"""
    if not RGB:
        for i, v in enumerate(attr.NES):
            RGB[i] = v
    return RGB[nb & 0x3F]


def score(mine, theirs, table):
    want = Counter()
    for nb, n in mine.items():
        want[table.get(nb, rgb_of(nb))] += n
    total = sum(theirs.values())
    agree = sum(min(n, theirs.get(c, 0)) for c, n in want.items())
    return 100.0 * agree / max(total, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rom', default=os.path.join(ROOT, 'Final Fantasy III (Japan) (fixed) (English).nes'))
    ap.add_argument('--def', dest='json', default=os.path.join(ROOT, 'ff3/ff3u-nes.json'))
    ap.add_argument('--cache', default='/tmp/ff3-rips')
    ap.add_argument('--report', action='store_true')
    a = ap.parse_args()

    names = attr.names_mod.main(a.rom, a.json)['monsterName']
    rom = rom_tables(a.rom)
    index = attr.fetch_index(a.cache)
    index = {norm(k): v for k, v in index.items()}

    # the rip site renders NES colours with its own emulation, so learn its
    # table from the rips: seed with our own, then iterate to a fixed point
    table = {i: attr.NES[i] for i in range(0x40)}
    used = []
    for it in range(4):
        table, used = calibrate(rom, names, index, a.cache, table)
    print('NES palette calibrated from %d rips (4 passes)' % len(used))

    rows = []
    for mid, name in enumerate(names):
        if not name or rom['props'][mid] >> 5 == 6:
            continue
        url = index.get(norm(name))
        if not url:
            continue
        path = os.path.join(a.cache, os.path.basename(url))
        if not os.path.exists(path):
            continue
        theirs = rip_colours(path)
        m = monster_nes(mid, rom)
        if m is None or sum(m.values()) != sum(theirs.values()):
            continue
        s_model = score(m, theirs, table)
        s_swap = score(monster_nes(mid, rom, 'swap'), theirs, table)
        s_noinv = score(monster_nes(mid, rom, 'noinvert'), theirs, table)
        rows.append((name, mid, s_model, s_swap, s_noinv, 'monster'))

    for i in range(24):
        owners = [m for m in range(256)
                  if (rom['props'][m] >> 5) == 6 and (rom['props'][m] & 0x1F) == i]
        for mid in owners:
            name = names[mid]
            url = lookup(index, name)
            if not name or not url:
                continue
            path = os.path.join(a.cache, os.path.basename(url))
            if not os.path.exists(path):
                continue
            theirs = rip_colours(path)
            m = boss_nes(i, rom)
            if m is None or sum(m.values()) != sum(theirs.values()):
                continue
            rows.append((name, mid, score(m, theirs, table),
                         score(boss_nes(i, rom, 'swap'), theirs, table),
                         score(boss_nes(i, rom, 'noinvert'), theirs, table), 'boss'))

    perfect = [r for r in rows if r[2] > 99.5]
    wrong = [r for r in rows if r[2] <= 99.5]
    swapwins = [r for r in rows if r[3] > r[2] + 0.5]
    invwins = [r for r in rows if r[4] > r[2] + 0.5]
    for name, mid, s1, s2, s3, kind in sorted(rows, key=lambda r: r[2]):
        flag = 'ok' if s1 > 99.5 else ('SWAP' if s2 > s1 + .5 else ('INVERT' if s3 > s1 + .5 else 'CHECK'))
        if a.report or flag != 'ok':
            print('%-14s %-6s id %02X  model %6.1f%%  swapped %6.1f%%  un-inverted %6.1f%%  %s'
                  % (name, kind, mid, s1, s2, s3, flag))
    print('\n%d checked, %d exact, %d better with the palettes swapped, '
          '%d better un-inverted' % (len(rows), len(perfect), len(swapwins), len(invwins)))
    return 0 if not wrong else 1


if __name__ == '__main__':
    sys.exit(main())
