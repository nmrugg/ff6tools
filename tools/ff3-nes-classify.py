#!/usr/bin/env python3
"""Classify every 8K def bank of FF3 (J) as tile-art vs code/compressed, by
measuring how well the bytes parse as NES 2bpp planar tiles (graphics banks
have many blank/sparse tiles; compressed data does not)."""
ROMNAME = 'Final Fantasy III (Japan) (fixed).nes'
data = open(ROMNAME, 'rb').read()

def mmc3_to_file(addr):
    return ((addr & 0xFF0000) >> 3) + (addr & 0x1FFF) + 0x10

def score(foff):
    blk = data[foff:foff+0x2000]
    if len(blk) < 0x2000: return None
    tiles=[blk[i:i+16] for i in range(0,len(blk),16)]
    blank=sparse=busy=0
    for t in tiles:
        lit=0
        for y in range(8):
            lo,hi=t[y],t[y+8]
            for x in range(8):
                b=7-x
                if ((lo>>b)&1) or ((hi>>b)&1): lit+=1
        if lit==0: blank+=1
        elif lit<=24: sparse+=1
        else: busy+=1
    n=len(tiles)
    # tile-art banks: plenty of blank tiles, and not everything maxed out
    return blank, sparse, busy, n

known = {
    0x03A000: 'mapGraphics (already in the definition)',
    0x0A8C00: 'worldGraphicsCommon (in definition)',
}
print('%-9s %6s %7s %6s   verdict' % ('def addr','blank','sparse','busy'))
for bank in range(0, 0x40):
    daddr = bank*0x10000
    f = mmc3_to_file(daddr)
    r = score(f)
    if not r: continue
    blank,sparse,busy,n = r
    verdict=''
    if blank >= 30: verdict='TILE ART (has blank padding tiles)'
    elif blank >= 10: verdict='likely tile art'
    elif busy >= 500: verdict='dense: code or compressed'
    print('0x%06X  %6d %7d %6d   %s' % (daddr, blank, sparse, busy, verdict))
