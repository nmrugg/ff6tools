#!/usr/bin/env python3
"""Render FF4 Advance (GBA) monster/summon graphics straight from the ROM.

Quick look at what each graphics id actually is, before the definition models
it.  Writes one PNG per id plus a labelled montage.

  python3 tools/ff4-gba-dump.py -o /tmp/ff4gba [--ids 282-361]
"""
import argparse, os, struct, sys
from PIL import Image

ROM = "/storage/romhacking/ff-roms/Final Fantasy IV Advance (USA).gba"
B = 0x08000000
PTR_TBL = 0x080F6FC8
N_PTR = 724
SIZE_TBL = 0x080F8018
SIZE_LEN = 12
NAME_TBL = 0x082E3680          # text pointer table
NAME_BASE = 0x112B             # monsterName stringTable link offset


def lzss(rom, a):
    src = rom[a:a + 0x40000]
    if src[0] != 0x10:
        raise ValueError("not lzss at %x: %02x" % (a, src[0]))
    ln = src[1] | (src[2] << 8) | (src[3] << 16)
    s = 4
    out = bytearray()
    win = bytearray(0x1000)
    wp = 0
    while len(out) < ln:
        h = src[s]; s += 1
        for _ in range(8):
            if h & 0x80:
                w = src[s] | (src[s + 1] << 8); s += 2
                r = (w >> 12) + 3
                off = (w & 0xFFF) + 1
                for _ in range(r):
                    c = win[(wp - off) & 0xFFF]
                    win[wp] = c; wp = (wp + 1) & 0xFFF
                    out.append(c)
                    if len(out) >= ln: break
            else:
                c = src[s]; s += 1
                win[wp] = c; wp = (wp + 1) & 0xFFF
                out.append(c)
            h <<= 1
            if len(out) >= ln: break
    return bytes(out)


def tose(rom, a, mode):
    """decode a tose block (possibly lzss wrapped)"""
    p = a - B
    if rom[p] == 0x10:
        blob = lzss(rom, p)
    else:
        blob = bytes(rom[p:p + 8])
        m, cnt = struct.unpack_from("<II", blob, 0)
        blob = bytes(rom[p:p + 8 + cnt * (2 if mode == 3 else 32)])
    m, cnt = struct.unpack_from("<II", blob, 0)
    if m != mode:
        raise ValueError("tose mode %d != %d at %x" % (m, mode, a))
    per = 2 if mode == 3 else 32
    return blob[8:8 + cnt * per]


def bgr555(u16):
    r = (u16 & 0x1F) << 3
    g = ((u16 >> 5) & 0x1F) << 3
    b = ((u16 >> 10) & 0x1F) << 3
    return (min(r | (r >> 5), 255), min(g | (g >> 5), 255), min(b | (b >> 5), 255))


def render(rom, mid):
    pal_ptr = struct.unpack_from("<I", rom, PTR_TBL - B + mid * 8)[0]
    gfx_ptr = struct.unpack_from("<I", rom, PTR_TBL - B + mid * 8 + 4)[0]
    w = rom[SIZE_TBL - B + mid * SIZE_LEN + 3]
    h = rom[SIZE_TBL - B + mid * SIZE_LEN + 4]
    p16 = struct.unpack("<%dH" % (len(tose(rom, pal_ptr, 3)) // 2), tose(rom, pal_ptr, 3))
    pal = [bgr555(v) for v in p16]
    tiles = tose(rom, gfx_ptr, 1)
    img = Image.new("RGB", (w * 8, h * 8), (0, 0, 0))
    px = img.load()
    for t in range(w * h):
        if t * 32 + 32 > len(tiles): break
        tx, ty = t % w, t // w
        for y in range(8):
            for x in range(8):
                c = tiles[t * 32 + y * 4 + (x >> 1)]
                c = (c >> 4) if (x & 1) else (c & 0xF)
                if c == 0: continue
                px[tx * 8 + x, ty * 8 + y] = pal[c % len(pal)]
    return img, w, h, len(pal), len(tiles) // 32


def char_table(def_path="/storage/romhacking/ff6tools/ff4/ff4u-gba.json"):
    import json
    d = json.load(open(def_path))
    return {int(k, 16): v for k, v in d["charTable"]["text"]["char"].items()}


def decode(bs, tab):
    out = []
    i = 0
    while i < len(bs):
        two = (bs[i] << 8) | (bs[i + 1] if i + 1 < len(bs) else 0)
        if two in tab:
            out.append(tab[two]); i += 2; continue
        out.append(tab.get(bs[i], "?")); i += 1
    return "".join(out).replace("\n", " ").strip()


def names(rom, tab):
    """monster names from the ROM's own text table.  The text pointer table
    holds offsets relative to 0x082E3670 (the definition's pointerTable
    offset), not absolute addresses."""
    out = []
    for i in range(283):
        v = struct.unpack_from("<I", rom, NAME_TBL - B + (NAME_BASE + i) * 4)[0]
        j = v + 0x082E3670 - B
        s = bytearray()
        while j < len(rom) and rom[j] not in (0xFF, 0x00):
            s.append(rom[j]); j += 1
        out.append(decode(s, tab))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rom", default=ROM)
    ap.add_argument("-o", "--out", default="/tmp/ff4gba")
    ap.add_argument("--ids", default="0-361")
    args = ap.parse_args()
    rom = open(args.rom, "rb").read()
    os.makedirs(args.out, exist_ok=True)
    nm = names(rom, char_table())
    lo, hi = (int(x, 0) for x in args.ids.split("-"))
    cells = []
    for m in range(lo, hi + 1):
        try:
            img, w, h, ncol, ntile = render(rom, m)
        except Exception as e:
            print("%3d  ERROR %s" % (m, e)); continue
        name = nm[m] if m < len(nm) else "(id %d)" % m
        print("%3d  %2dx%-2d tiles=%-4d pal=%-3d %s" % (m, w, h, ntile, ncol // 16, name))
        img.save(os.path.join(args.out, "%03d.png" % m))
        cells.append((m, name, img))
    # montage
    cols = 8
    cw = max(i.width for _, _, i in cells) + 8
    rh = max(i.height for _, _, i in cells) + 22
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cw, rows * rh), (32, 32, 32))
    d = ImageDraw() if False else None
    from PIL import ImageDraw
    dr = ImageDraw.Draw(sheet)
    for k, (m, name, img) in enumerate(cells):
        x, y = (k % cols) * cw, (k // cols) * rh
        sheet.paste(img, (x + 4, y + 18), None)
        dr.text((x + 2, y + 4), "%d %s" % (m, name[:24]), fill=(255, 255, 255))
    sheet.save(os.path.join(args.out, "montage.png"))
    print("wrote", os.path.join(args.out, "montage.png"), sheet.size)


if __name__ == "__main__":
    main()
