#!/usr/bin/env python3
# tools/ff4-gba-names.py
#
# Adds (or refreshes) the FF4 Advance (GBA) battle graphics model in a
# definition file, computing everything from the ROM itself.  This is the
# FF5-Advance treatment (HANDOFF.md section 2) adapted to FF4's layout:
#
#   * the 724-entry monsterGraphics pointerTable is really 362 records of
#     {palettePointer, graphicsPointer} - palette first, graphics second
#     (the opposite order from FF5).  monsterGraphicsProperties models it as
#     8-byte records so the pointers stay editable and de-duplicate.
#   * monsterGraphics / monsterPalettes become fragmented arrays pointed at
#     by those records.  The region interleaves palettes and graphics, so a
#     plain pointer-deduped array would let every palette swallow the
#     graphics block after it; static itemRanges (computed from the union of
#     all 724 pointers) give every byte exactly one owner.
#   * per-object display size comes from monsterSize (indexed by monster id,
#     not by array item - de-duplication breaks that correspondence), and
#     each graphic is pinned to the palette its own record points at.
#   * string tables: every graphics object is labelled with the monster
#     names that use it, every palette with its users.  Slots past the
#     monster table (283-361) are labelled by what they share.
#
#   python3 tools/ff4-gba-names.py --def ff4/ff4u-gba.json \
#           --rom "/storage/romhacking/ff-roms/Final Fantasy IV Advance (USA).gba"
#
# Re-running is idempotent: the assemblies are rebuilt from scratch each time.

import argparse, json, struct, sys

GBA = 0x08000000

# ---- ROM addresses (def space) ---------------------------------------------
PTR_TBL   = 0x080F6FC8      # 724 x u32: m*2 palette, m*2+1 graphics
PTR_N     = 724
SLOTS     = PTR_N // 2      # 362 monster/summon graphics slots
SIZE_TBL  = 0x080F8018      # 362 x 12 bytes
SIZE_LEN  = 12
GFX_BEGIN = 0x0818857C      # the region the old array owned
GFX_END   = 0x081DA7F8
NAME_PTRS = 0x082E3680      # text pointer table
NAME_OFF  = 0x082E3670      # ...pointers are relative to this
NAME_BASE = 0x112B          # monsterName stringTable link: text[%i+0x112B]
NAME_N    = 283             # monsterName table length in the definition


def lzss(rom, p):
    """GBA LZSS (0x10 header), exactly as rom/romtools.js 'gba-lzss' decodes
    it: 4 KiB ring window, 12-bit offset, 3-bit length, flags MSB first."""
    src = rom[p:p + 0x40000]
    if src[0] != 0x10:
        raise ValueError('not LZSS at 0x%x: %02x' % (p + GBA, src[0]))
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


def tose(rom, addr, mode):
    """Decode a TOSE block (mode 1 = graphics, 3 = palette), LZSS wrapped or
    not, and return the payload after the 8-byte header."""
    p = addr - GBA
    if rom[p] == 0x10:
        blob = lzss(rom, p)
    else:
        m, cnt = struct.unpack_from('<II', rom, p)
        if m != mode:
            raise ValueError('TOSE mode %d != %d at %x' % (m, mode, addr))
        blob = rom[p:p + 8 + cnt * (2 if mode == 3 else 32)]
    m, cnt = struct.unpack_from('<II', blob, 0)
    if m != mode:
        raise ValueError('TOSE mode %d != %d at %x' % (m, mode, addr))
    per = 2 if mode == 3 else 32
    return blob[8:8 + cnt * per]


def char_table(defj):
    return {int(k, 16): v for k, v in defj['charTable']['text']['char'].items()}


def decode_text(bs, tab):
    # ROMTextEncoding.decode tries the two-byte code before the one-byte code,
    # and 0x0C is the end-of-string marker (it maps to "\\0" in the char table)
    out, i = [], 0
    while i < len(bs):
        two = (bs[i] << 8) | (bs[i + 1] if i + 1 < len(bs) else 0)
        # only try the two-byte code when the first byte is non-zero: 0x00 is a
        # space, and (0x00<<8)|b would alias the one-byte code b
        if bs[i] and two in tab:
            c = tab[two]; i += 2
        else:
            c = tab.get(bs[i], '?'); i += 1
        if c == '\x00' or c == '\\0':
            break
        out.append(c)
    return ''.join(out).replace('\n', ' ').strip()


def monster_names(rom, tab):
    names = []
    for i in range(NAME_N):
        v = struct.unpack_from('<I', rom, NAME_PTRS - GBA + (NAME_BASE + i) * 4)[0]
        j = v + NAME_OFF - GBA
        raw = bytearray()
        # 0x0C is the end-of-string marker and 0xFF is padding; 0x00 is a SPACE
        while j < len(rom) and rom[j] not in (0xFF, 0x0C):
            raw.append(rom[j]); j += 1
        names.append(decode_text(raw, tab))
    return names


def hx(n):
    return '0x' + format(n, 'X')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--def', dest='definition', required=True)
    ap.add_argument('--rom', required=True)
    args = ap.parse_args()

    defj = json.load(open(args.definition))
    rom = open(args.rom, 'rb').read()

    ptrs = [struct.unpack_from('<I', rom, PTR_TBL - GBA + i * 4)[0]
            for i in range(PTR_N)]
    pal_ptrs = ptrs[0::2]
    gfx_ptrs = ptrs[1::2]

    # sanity: even entries are TOSE palettes, odd entries are TOSE graphics
    for i, a in enumerate(pal_ptrs):
        if rom[a - GBA] != 0x03:
            sys.exit('slot %d palette pointer %s is not a TOSE palette' % (i, hx(a)))
    for i, a in enumerate(gfx_ptrs):
        if rom[a - GBA] != 0x10 and rom[a - GBA] != 0x01:
            sys.exit('slot %d graphics pointer %s is not TOSE/LZSS' % (i, hx(a)))

    # ---- item ranges -------------------------------------------------------
    # The region is exactly tiled by the union of all 724 pointers (verified:
    # min == GFX_BEGIN, and the block at the max pointer ends at GFX_END).
    # Each item therefore ends where the NEXT pointer of EITHER kind starts,
    # so the two arrays never overlap and no byte loses its owner.
    allp = sorted(set(ptrs))
    if allp[0] != GFX_BEGIN:
        sys.exit('unexpected first pointer %s (region begins %s)' % (hx(allp[0]), hx(GFX_BEGIN)))
    ends = {}
    for i, a in enumerate(allp):
        ends[a] = allp[i + 1] if i + 1 < len(allp) else GFX_END
    if ends[allp[-1]] != GFX_END:
        sys.exit('last block ends %s, expected %s' % (hx(ends[allp[-1]]), hx(GFX_END)))

    # ROMArray parses itemRanges in *file* space when the pointers are mapped
    # (a GBA pointer already carries the 0x08000000 bank, so isMapped is true
    # and mapRange is skipped) - write them the same way.
    def ranges_for(values):
        uniq = sorted(set(values))
        return ['0x%X-0x%X' % (a - GBA, ends[a] - GBA) for a in uniq], uniq

    gfx_ranges, gfx_uniq = ranges_for(gfx_ptrs)
    pal_ranges, pal_uniq = ranges_for(pal_ptrs)

    # tile counts, so the label can warn when the game reads past a block
    def tile_count(a):
        p = a - GBA
        if rom[p] == 0x10:
            blob = lzss(rom, p)
            m, cnt = struct.unpack_from('<II', blob, 0)
            return max(cnt, (len(blob) - 8) // 32)
        m, cnt = struct.unpack_from('<II', rom, p)
        return cnt

    def size_of(m):
        rec = rom[SIZE_TBL - GBA + m * SIZE_LEN:SIZE_TBL - GBA + m * SIZE_LEN + SIZE_LEN]
        return rec[3], rec[4], struct.unpack_from('<I', rom, SIZE_TBL - GBA + m * SIZE_LEN + 8)[0]

    names = monster_names(rom, char_table(defj))

    # ---- labels ------------------------------------------------------------
    # Slots 0..282 are monsters (monsterName table).  283..361 are extra
    # slots in the same tables: some are unused placeholders that point at
    # another monster's block, some are big summon/attack art.  Name a slot
    # after the monsters that use the block; anything left over is named by
    # what it shares with, so the tree still says something true.
    def label_for(values, kind):
        index = {a: i for i, a in enumerate(sorted(set(values)))}
        users = {}
        for m, a in enumerate(values):
            users.setdefault(a, []).append(m)
        out = {}
        for a, ms in users.items():
            real = [m for m in ms if m < len(names) and names[m]]
            if real:
                label = ', '.join(dict.fromkeys(names[m] for m in real))
                extra = [m for m in ms if m >= len(names) or not names[m]]
                for m in extra:
                    label += ', slot %d' % m
            else:
                # a block used only by unnamed slots: name it by its size
                w, h, _ = size_of(ms[0])
                label = 'Slot %d (%dx%d)' % (ms[0], w, h)
                for m in ms[1:]:
                    label += ', slot %d' % m
            out[index[a]] = label
        return out

    gfx_labels = label_for(gfx_ptrs, 'graphics')
    pal_labels = label_for(pal_ptrs, 'palette')

    def table(labels, count, default, name):
        return {'name': name, 'length': count, 'default': default,
                'string': {str(k): v for k, v in sorted(labels.items())}}

    # ---- the assemblies ----------------------------------------------------
    asm = defj['assembly']

    props = {
        'type': 'array',
        'name': 'Monster Graphics Properties',
        'range': hx(PTR_TBL) + '-' + hx(PTR_TBL + PTR_N * 4),
        'arrayLength': SLOTS,
        'assembly': {
            'type': 'data',
            'length': 8,
            'assembly': {
                'palettePointer': {
                    'type': 'property', 'name': 'Palette Pointer',
                    'begin': 0, 'mask': '0x7FFFFFFF',
                    'pointerTo': 'monsterPalettes',
                },
                'graphicsPointer': {
                    'type': 'property', 'name': 'Graphics Pointer',
                    'begin': 4, 'mask': '0x7FFFFFFF',
                    'pointerTo': 'monsterGraphics',
                },
            },
        },
        'stringTable': {
            'name': 'Monster Graphics Properties',
            'length': SLOTS,
            'default': 'Monster %i',
            'string': {str(i): names[i] for i in range(min(SLOTS, len(names)))
                       if names[i]},
        },
    }

    gfx = {
        'type': 'array',
        'name': 'Monster Graphics',
        'isFragmented': True,
        'canRelocate': True,
        'arrayLength': len(gfx_uniq),
        'assembly': {
            'type': 'graphics',
            'name': 'Monster Graphics',
            'format': ['linear4bpp', 'tose-graphics', 'gba-lzss'],
            'align': 4,
            'palette': 'monsterPalettes',
        },
        'pointerObject': {
            'arrayPath': 'monsterGraphicsProperties',
            'pointerPath': 'graphicsPointer',
        },
        'itemRanges': gfx_ranges,
        'sizeFrom': {
            'arrayPath': 'monsterGraphicsProperties',
            'pointerPath': 'graphicsPointer',
            'sizeArrayPath': 'monsterSize',
            'width': 'width',
            'height': 'height',
            'linkPalette': {
                'pointerPath': 'palettePointer',
                'arrayKey': 'monsterPalettes',
            },
        },
        'stringTable': table(gfx_labels, len(gfx_uniq), 'Monster Graphics %i',
                             'Monster Graphics'),
    }

    pal = {
        'type': 'array',
        'name': 'Monster Palette',
        'isFragmented': True,
        'canRelocate': True,
        'arrayLength': len(pal_uniq),
        'assembly': {
            'type': 'assembly',
            'name': 'Monster Palette',
            'format': ['bgr555', 'tose-palette'],
            'align': 4,
        },
        'pointerObject': {
            'arrayPath': 'monsterGraphicsProperties',
            'pointerPath': 'palettePointer',
        },
        'itemRanges': pal_ranges,
        'stringTable': table(pal_labels, len(pal_uniq), 'Monster Palette %i',
                             'Monster Palette'),
    }

    # the tilemap pointer in monsterSize (bytes 8-11) is only used by the
    # big tilemap-drawn monsters; expose it so it is visible and editable
    size = asm.get('monsterSize')
    if size:
        # bytes 8-11 are a pointer to a TOSE layout (mode 2) tile map, used by
        # the 22 big monsters the game composes from a tile pool (the Lunar
        # espers, Zeromus EG, and the esper slots 339-350); zero elsewhere
        size['assembly']['assembly']['tilemapPointer'] = {
            'type': 'property', 'name': 'Tilemap Pointer',
            'begin': 8, 'mask': '0x7FFFFFFF',
        }

    asm['monsterGraphicsProperties'] = props
    asm['monsterGraphics'] = gfx
    asm['monsterPalettes'] = pal

    # ---- hierarchy ---------------------------------------------------------
    battle = None
    for section in defj['hierarchy']:
        if section.get('name') == 'Battle':
            battle = section
            break
    if battle is not None:
        want = [('Monster Graphics', 'monsterGraphics'),
                ('Monster Palettes', 'monsterPalettes'),
                ('Monster Graphics Properties', 'monsterGraphicsProperties')]
        have = {e.get('path') for e in battle['list']}
        at = next((i for i, e in enumerate(battle['list'])
                   if e.get('path') == 'monsterProperties'), len(battle['list'])) + 1
        for name, path in reversed(want):
            if path in have:
                continue
            battle['list'].insert(at, {'name': name, 'path': path})

    json.dump(defj, open(args.definition, 'w'), indent=4)
    print('%s: %d graphics objects, %d palette objects, %d property records'
          % (args.definition, len(gfx_uniq), len(pal_uniq), SLOTS))
    print('  graphics region %s-%s tiled by %d ranges'
          % (hx(GFX_BEGIN), hx(GFX_END), len(gfx_ranges) + len(pal_ranges)))


if __name__ == '__main__':
    main()
