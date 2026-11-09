#!/usr/bin/env python3
"""Render FF4 Advance (GBA) battle sprites straight from the ROM.

Every monster/summon slot in the size table is one animation frame; the
record's first two bytes give the *next* frame in that sprite's animation
(slot = value - 32; values 0-31 are character sprites, which live in their
own table).  This tool walks those chains so a frame can be labelled with the
monster it belongs to and its position in the animation.

  python3 tools/ff4-gba-dump.py -o /tmp/ff4gba [--ids 0-63] [--chain 164]
"""
import argparse, json, os, struct
from PIL import Image, ImageDraw

ROM = "/storage/romhacking/ff-roms/Final Fantasy IV Advance (USA).gba"
DEFP = "/storage/romhacking/ff6tools/ff4/ff4u-gba.json"
B = 0x08000000
PTR_TBL, PTR_N = 0x080F6FC8, 724
SLOTS = PTR_N // 2
SIZE_TBL, SIZE_LEN = 0x080F8018, 12
CHAR_TBL = 0x080F7B18
CHAR_N = 320
NAME_PTRS, NAME_OFF, NAME_BASE, NAME_N = 0x082E3680, 0x082E3670, 0x112B, 283


def lzss(rom, p):
    src = rom[p:p + 0x40000]
    if src[0] != 0x10:
        raise ValueError('not lzss at 0x%x' % (p + B))
    ln = src[1] | (src[2] << 8) | (src[3] << 16)
    s, out = 4, bytearray()
    win, wp = bytearray(0x1000), 0
    while len(out) < ln:
        h = src[s]; s += 1
        for _ in range(8):
            if h & 0x80:
                w = src[s] | (src[s + 1] << 8); s += 2
                r, off = (w >> 12) + 3, (w & 0xFFF) + 1
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


def tose(rom, addr, mode):
    p = addr - B
    if rom[p] == 0x10:
        blob = lzss(rom, p)
    else:
        m, cnt = struct.unpack_from('<II', rom, p)
        blob = rom[p:p + 8 + cnt * (2 if mode == 3 else 32)]
    m, cnt = struct.unpack_from('<II', blob, 0)
    if m != mode:
        raise ValueError('tose mode %d != %d at %x' % (m, mode, addr))
    per = 2 if mode == 3 else 32
    return blob[8:8 + cnt * per]


def bgr555(v):
    r, g, b = (v & 0x1F) << 3, ((v >> 5) & 0x1F) << 3, ((v >> 10) & 0x1F) << 3
    return (min(r | (r >> 5), 255), min(g | (g >> 5), 255), min(b | (b >> 5), 255))


class Table:
    def __init__(self, rom, defp=DEFP):
        self.rom = rom
        d = json.load(open(defp))
        self.tab = {int(k, 16): c for k, c in d['charTable']['text']['char'].items()}
        self.names = self._names()

    def ptr(self, m, which=1):
        return struct.unpack_from('<I', self.rom, PTR_TBL - B + m * 8 + which * 4)[0]

    def rec(self, m):
        return self.rom[SIZE_TBL - B + m * SIZE_LEN:SIZE_TBL - B + m * SIZE_LEN + SIZE_LEN]

    def size(self, m):
        r = self.rec(m)
        return r[3], r[4]

    def nxt(self, m):
        r = self.rec(m)
        return (r[0] | (r[1] << 8)) - 32

    def tilemap(self, m):
        return struct.unpack_from('<I', self.rec(m), 8)[0]

    def _names(self):
        out = []
        for i in range(NAME_N):
            v = struct.unpack_from('<I', self.rom, NAME_PTRS - B + (NAME_BASE + i) * 4)[0]
            j = v + NAME_OFF - B
            raw = bytearray()
            while j < len(self.rom) and self.rom[j] not in (0xFF, 0x0C):
                raw.append(self.rom[j]); j += 1
            s, p = '', 0
            while p < len(raw):
                two = (raw[p] << 8) | (raw[p + 1] if p + 1 < len(raw) else 0)
                if raw[p] and two in self.tab:
                    s += self.tab[two]; p += 2
                else:
                    s += self.tab.get(raw[p], '?'); p += 1
            out.append(s.strip())
        return out

    def name(self, m):
        return self.names[m] if m < NAME_N and self.names[m] else None

    def chains(self):
        """slot -> (owner slot, frame number).  Follow the next-frame links;
        a cycle means the animation loops back to its first frame."""
        owner, frame = {}, {}
        for start in range(SLOTS):
            if start in owner:
                continue
            chain, seen = [], set()
            m = start
            while 0 <= m < SLOTS and m not in seen:
                seen.add(m); chain.append(m)
                m = self.nxt(m)
            for i, m in enumerate(chain):
                owner[m], frame[m] = chain[0], i + 1
        return owner, frame

    def render(self, m, scale=1):
        w, h = self.size(m)
        try:
            pv = tose(self.rom, self.ptr(m, 0), 3)
            tiles = tose(self.rom, self.ptr(m, 1), 1)
        except Exception:
            return None, w, h, 0
        pal = [bgr555(v) for v in struct.unpack('<%dH' % (len(pv) // 2), pv)]
        img = Image.new('RGB', (w * 8, h * 8), (40, 40, 40))
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
        if scale != 1:
            img = img.resize((w * 8 * scale, h * 8 * scale), Image.NEAREST)
        return img, w, h, len(pal) // 16


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rom', default=ROM)
    ap.add_argument('--def', dest='defp', default=DEFP)
    ap.add_argument('-o', '--out', default='/tmp/ff4gba')
    ap.add_argument('--ids', default='0-361')
    ap.add_argument('--chain', type=int, default=None,
                    help='dump one animation chain, e.g. 164 (Mom Bomb)')
    args = ap.parse_args()
    rom = open(args.rom, 'rb').read()
    T = Table(rom, args.defp)
    os.makedirs(args.out, exist_ok=True)
    owner, frame = T.chains()

    if args.chain is not None:
        ids, m, n = [], args.chain, 0
        while 0 <= m < SLOTS and n < 40:
            ids.append(m); n += 1
            m = T.nxt(m)
            if m == ids[0]: break
    else:
        lo, hi = (int(x, 0) for x in args.ids.split('-'))
        ids = list(range(lo, hi + 1))

    cells = []
    for m in ids:
        img, w, h, banks = T.render(m, 4)
        if img is None:
            print('%3d  ERROR' % m); continue
        o = owner.get(m, m)
        label = '%d %s%s%s %dx%d p%d' % (
            m, T.name(o) or 'slot %d' % o,
            '' if m == o else ' f%d' % frame[m],
            '' if T.nxt(m) == m else '>', w, h, banks)
        print('%3d owner=%-3d frame=%-2d next=%-4d %2dx%-2d banks=%d %s'
              % (m, o, frame[m], T.nxt(m), w, h, banks, T.name(o) or ''))
        cells.append((label, img))

    cols = 6
    cw = max(i.width for _, i in cells) + 8
    rh = max(i.height for _, i in cells) + 22
    rows = (len(cells) + cols - 1) // cols
    sheet = Image.new('RGB', (cols * cw, rows * rh), (30, 30, 30))
    dr = ImageDraw.Draw(sheet)
    for k, (label, img) in enumerate(cells):
        x, y = (k % cols) * cw, (k // cols) * rh
        sheet.paste(img, (x + 4, y + 18))
        dr.text((x + 2, y + 4), label, fill=(255, 255, 255))
    out = os.path.join(args.out, 'montage.png')
    sheet.save(out)
    print('wrote', out, sheet.size)


if __name__ == '__main__':
    main()
