#!/usr/bin/env python3
# tools/ff4-sfc-artcheck.py
#
# Verify the hand-authored graphics arrangements in an FF4 SNES definition
# against the ripped battle art (ff4monsters.zip, 214 PNGs; the rip marks
# transparency with #b02000).
#
# One arrangement is not in the ROM: Mom Bomb's. The US boss properties entry
# (bossProps 36) places a 4x4 crop of a 60-tile sheet, so tools/ff4-sfc-names.py
# bakes her full 10x9 arrangement (the JP one). motherbomb.png is exactly
# 80x72 pixels = 10x9 of the game's 8x8 tiles, so the rip *is* the arrangement:
#
#   1. a cell of the layout is empty (-1) exactly when the matching cell of the
#      rip is fully transparent;
#   2. learning the rip-colour -> palette-index map from the layout's own
#      placements, almost every pixel of the rip must agree with the pool tile
#      placed under it (the arrangement tools/ff4-sfc-names.py baked before the
#      row-6 blank was found scored 4220/4992 = 84.5%; the correct one
#      4992/4992 = 100%).
#
#   python3 tools/ff4-sfc-artcheck.py [--def ff4/ff2u-sfc.json]
#                                     [--rom ".../Final Fantasy II (USA).sfc"]
#                                     [--zip ".../ff4monsters.zip"]
import argparse, collections, io, json, os, sys
import zipfile
from PIL import Image

def loROM_map(a):
    return ((a & 0xFF0000) >> 1) + (a & 0x7FFF)

def decode_tiles(raw, n):
    """n SNES 3bpp tiles (24 bytes each) -> [[8x8 colour indices]]"""
    out = []
    for t in range(n):
        p = raw[t*24:t*24+24]
        mat = []
        for y in range(8):
            row = []
            for x in range(8):
                b = 7 - x
                row.append(((p[y*2] >> b) & 1) | (((p[y*2+1] >> b) & 1) << 1) |
                           (((p[16+y] >> b) & 1) << 2))
            mat.append(row)
        out.append(mat)
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--def', dest='definition', default='ff4/ff2u-sfc.json')
    ap.add_argument('--rom', default='/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc')
    ap.add_argument('--zip', default='/storage/romhacking/ff-roms/ff4monsters.zip')
    args = ap.parse_args()

    defj = json.load(open(args.definition))
    asm = defj['assembly']
    rom = open(args.rom, 'rb').read()
    zf = zipfile.ZipFile(args.zip)

    fails = 0

    # ---- Mom Bomb: bossGraphics_36 against motherbomb.png ------------------
    win = asm.get('bossGraphics_36')
    if not win:
        print('FAIL: no bossGraphics_36 in the definition'); fails += 1
    else:
        cols, rows, layout = win['width'], win['height'], win['layout']
        art = Image.open(io.BytesIO(zf.read('motherbomb.png'))).convert('RGB')
        if art.size != (cols*8, rows*8):
            print(f'FAIL: motherbomb.png {art.size} != {cols*8}x{rows*8} '
                  f'({cols}x{rows} tiles)'); fails += 1
        else:
            apx = art.load()
            trans = apx[0, 0]                     # the rip's transparency marker
            # the pool the window reads
            item = win['window']['path']          # monsterGraphics_64
            arr, idx = item.rsplit('_', 1)
            lo, hi = [loROM_map(int(x, 16)) for x in
                      asm[arr]['itemRanges'][int(idx)].split('-')]
            tiles = decode_tiles(rom[lo:hi], win['window']['tiles'])
            # 1. empty cells must match empty art cells
            blank_layout = {i for i, t in enumerate(layout) if t < 0}
            blank_art = set()
            for gy in range(rows):
                for gx in range(cols):
                    if all(apx[gx*8+x, gy*8+y] == trans
                           for y in range(8) for x in range(8)):
                        blank_art.add(gy*cols+gx)
            if blank_layout != blank_art:
                print('FAIL: empty cells differ from the rip')
                print('  layout only:', sorted(blank_layout - blank_art))
                print('  rip only:   ', sorted(blank_art - blank_layout))
                fails += 1
            else:
                print(f'Mom Bomb: {len(blank_layout)} empty cells match the rip exactly')
            # 2. learn rip colour -> tile colour index from the placements
            #    (the rip's transparency marker is mapped like any other
            #    colour: inside the creature it marks the tile's own
            #    background index)
            votes = collections.defaultdict(collections.Counter)
            for i, t in enumerate(layout):
                if t < 0:
                    continue
                gy, gx = divmod(i, cols)
                for y in range(8):
                    for x in range(8):
                        votes[apx[gx*8+x, gy*8+y]][tiles[t][y][x]] += 1
            cmap = {c: v.most_common(1)[0][0] for c, v in votes.items()}
            agree = total = 0
            for i, t in enumerate(layout):
                if t < 0:
                    continue
                gy, gx = divmod(i, cols)
                for y in range(8):
                    for x in range(8):
                        total += 1
                        if cmap[apx[gx*8+x, gy*8+y]] == tiles[t][y][x]:
                            agree += 1
            pct = 100.0*agree/total
            print(f'Mom Bomb: {agree}/{total} pixels agree through the learned '
                  f'colour map ({pct:.2f}%)')
            if pct < 99.0:
                print('FAIL: the baked arrangement does not match the ripped art')
                fails += 1
            print('  colour map (rip -> palette index):')
            pal = asm['monsterPalette']
            pb = loROM_map(int(pal['range'].split('-')[0], 16))
            p = int(win['palette'][0]['path'].split('[')[1].rstrip(']'))
            for c, ti in sorted(cmap.items(), key=lambda kv: kv[1]):
                v = rom[pb + p*16 + ti*2] | (rom[pb + p*16 + ti*2 + 1] << 8)
                snes = (v & 0x1f, (v >> 5) & 0x1f, (v >> 10) & 0x1f)
                print(f'    {c} -> {ti}  (ROM rgb555 {snes})')

    # ---- Odin: the three ripped frames against the baked summon layout ----
    # (the ROM's animation stages draw 9 of his 100 tiles, so his layout in
    # tools/ff4-sfc-names.py is reconstructed from these rips - they are the
    # SNES art at 2x zoom)
    gifs = [os.path.join(os.path.dirname(args.zip), f'Odin{n}.gif') for n in (1, 2, 3)]
    entry = asm.get('summonGraphics_Odin')
    if not all(os.path.exists(g) for g in gifs) or not entry:
        print('Odin: rips not found, skipping (place Odin1/2/3.gif next to '
              f'{os.path.basename(args.zip)} to check it)')
    else:
        CMAP = {(0,0,0):'K', (88,88,136):7, (120,120,48):6, (184,184,112):5,
                (120,120,248):4, (248,248,248):2, (176,176,248):3,
                (192,192,252):None}
        INV = {0:'K', 1:'K', 2:2, 3:3, 4:4, 5:5, 6:6, 7:7}
        pool = asm['monsterGraphics']['itemRanges'][
            int(entry['window']['path'].rsplit('_', 1)[1])]
        pa, pb = [loROM_map(int(x, 16)) for x in pool.split('-')]
        ptiles = decode_tiles(rom[pa:pb], (pb - pa) // 24)

        def sc(c, t):
            ok = known = 0
            for y in range(8):
                for x in range(8):
                    v = c[y][x]
                    if v is None:
                        continue
                    known += 1
                    if INV[t[y][x]] == v:
                        ok += 1
            return ok, known

        W = entry['width']; lay = entry['layout']; H = len(lay)//W
        for g in gifs:
            im = Image.open(g).convert('RGB')
            if im.width > 100:
                im = im.resize((im.width//2, im.height//2), Image.NEAREST)
            px = im.load()
            best = None
            for ox in range(8):
                for oy in range(8):
                    gw = (im.width-ox)//8; gh = (im.height-oy)//8
                    if gw < 4 or gh < 4:
                        continue
                    perf = tot = 0
                    grid = []
                    for gy in range(gh):
                        row = []
                        for gx in range(gw):
                            c = [[CMAP.get(px[ox+gx*8+x, oy+gy*8+y], '?')
                                  for x in range(8)] for y in range(8)]
                            known = sum(1 for r in c for v in r if v is not None)
                            if not known:
                                row.append(-1); continue
                            tot += 1
                            m = [i for i, t in enumerate(ptiles) if sc(c, t) == (known, known)]
                            if m:
                                perf += 1; row.append(m[0])
                            else:
                                row.append(-2)
                        grid.append(row)
                    if perf and (best is None or (perf, perf/tot) > best[:2]):
                        best = (perf, perf/tot, grid)
            perf, frac, grid = best
            grid = [r for r in grid if any(v >= 0 for v in r)]
            while grid and all(v < 0 for v in grid[0]):
                grid.pop(0)
            drawn = sum(1 for r in grid for v in r if v != -1)
            matched = sum(1 for r in grid for v in r if v >= 0)
            # the frame must appear as a block of the definition's layout
            gh, gw = len(grid), len(grid[0])
            found = None
            for r0 in range(H-gh+1):
                for c0 in range(W-gw+1):
                    if all((lay[(r0+r)*W + c0+c] == grid[r][c] or grid[r][c] < 0)
                           for r in range(gh) for c in range(gw)
                           if grid[r][c] >= 0):
                        found = (r0, c0); break
                if found: break
            shape_ok = found and all(
                (lay[(found[0]+r)*W + found[1]+c] >= 0) == (grid[r][c] >= 0)
                for r in range(gh) for c in range(gw) if grid[r][c] != -2)
            print(f'{os.path.basename(g)}: {gw}x{gh} frame, {matched}/{drawn} drawn '
                  f'cells matched a pool tile exactly, present in the layout '
                  f'at {found}, shape {"ok" if shape_ok else "MISMATCH"}')
            if not found or not shape_ok:
                print(f'FAIL: {os.path.basename(g)} is not in summonGraphics_Odin')
                fails += 1

    print('MOM BOMB ARRANGEMENT OK' if not fails else f'{fails} FAILURES')
    return 1 if fails else 0

if __name__ == '__main__':
    sys.exit(main())
