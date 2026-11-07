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

    print('MOM BOMB ARRANGEMENT OK' if not fails else f'{fails} FAILURES')
    return 1 if fails else 0

if __name__ == '__main__':
    sys.exit(main())
