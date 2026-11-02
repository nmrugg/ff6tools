#!/usr/bin/env python3
"""Render several def-address regions of FF3 (J) into one montage so likely
battle/monster graphics banks can be spotted visually."""
import sys
from PIL import Image

ROMNAME = 'Final Fantasy III (Japan) (fixed).nes'
data = open(ROMNAME, 'rb').read()

def mmc3_to_file(addr):
    return ((addr & 0xFF0000) >> 3) + (addr & 0x1FFF) + 0x10

def sheet(buf, cols=32, scale=2):
    n = len(buf) // 16
    out=[]
    for t in range(n):
        base=t*16
        rows=[]
        for y in range(8):
            lo, hi = buf[base+y], buf[base+8+y]
            rows.append([(((hi>>(7-x))&1)*2 + ((lo>>(7-x))&1)) for x in range(8)])
        out.append(rows)
    r=(n+cols-1)//cols
    im=Image.new('L',(cols*8*scale, r*8*scale),255)
    px=im.load()
    PAL=(0,110,190,255)
    for i,tile in enumerate(out):
        ox,oy=(i%cols)*8,(i//cols)*8
        for y in range(8):
            for x in range(8):
                v=PAL[tile[y][x]]
                for dy in range(scale):
                    for dx in range(scale):
                        px[(ox+x)*scale+dx,(oy+y)*scale+dy]=v
    return im

regions=[int(a,16) for a in sys.argv[1:]] or [0x0C0000,0x0E0000,0x100000,0x140000,0x200000,0x280000]
imgs=[]
for r in regions:
    f=mmc3_to_file(r)
    imgs.append((r, sheet(data[f:f+0x2000])))

W=max(i.width for _,i in imgs)
H=sum(i.height for _,i in imgs)+12*len(imgs)
mont=Image.new('RGB',(W,H),(40,40,40))
y=0
for r,i in imgs:
    mont.paste(i.convert('RGB'),(0,y)); y+=i.height+12
mont.save('ff3-nes-montage.png')
print('wrote ff3-nes-montage.png for', ['0x%06X'%r for r in regions])
