#!/usr/bin/env python3
# tools/ff4-gba-names.py
#
# Adds (or refreshes) the FF4 Advance (GBA) battle graphics model in a
# definition file, computing everything from the ROM itself.  This is the
# FF5-Advance treatment (HANDOFF.md section 2) adapted to FF4's layout, plus
# the two things FF4 has that FF5 does not: animation chains and character
# sprites.
#
#   * the 724-entry monsterGraphics pointerTable is really 362 records of
#     {palettePointer, graphicsPointer} - palette first, graphics second
#     (the opposite order from FF5).  monsterGraphicsProperties models it as
#     8-byte records so the pointers stay editable and de-duplicate.
#   * monsterGraphics / monsterPalettes become fragmented arrays pointed at by
#     those records.  The region interleaves palettes and graphics, so a plain
#     pointer-deduped array would let every palette swallow the graphics block
#     after it; static itemRanges (computed from the union of all 724 pointers)
#     give every byte exactly one owner.
#   * per-object display size comes from monsterSize (indexed by monster id,
#     not by array item), and each graphic is pinned to the palette its own
#     record points at.
#   * monsterSize bytes 0-1 are the NEXT frame of the same sprite (slot =
#     value - 32; values below 32 are character sprites).  Demon Wall's chain
#     is a cycle: 191 -> 327 -> ... -> 336 -> 191.  Labels therefore read
#     "Demon Wall (frame 4/11)" instead of "Slot 329", and a chain is listed
#     in the properties string table too.
#   * the 22 biggest monsters (Zeromus EG, the Lunar espers, the esper slots
#     339-350) are composed from a tile pool by a TOSE layout whose entries
#     carry a palette BANK in bits 10-11 - that is why 22 palettes hold 48
#     colours.  The layouts become monsterTilemaps, and each pooled graphic
#     gets tilePaletteCells so the view reads the bank straight out of the ROM.
#   * 0x080F7B18 holds a second pointer table: 20 groups of (15 frames + 1
#     palette) = the character battle sprites (Dark Knight, Dragoon, ... the
#     enemy classes Dragoon/Bard/Monk/Dark Knight/Girl/Dark Kain use them).
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
TMAP_END  = 0x081DCE30      # the tile-map region ends where the char art begins
CHAR_TBL  = 0x080F7B18      # 320 x u32: 20 groups of (15 frames + 1 palette)
CHAR_N    = 320
CHAR_GROUPS = 20
CHAR_FRAMES = 15
CHAR_END  = 0x080F8018
NAME_PTRS = 0x082E3680      # text pointer table
NAME_OFF  = 0x082E3670      # ...pointers are relative to this
NAME_BASE = 0x112B          # monsterName stringTable link: text[%i+0x112B]
NAME_N    = 283             # monsterName table length in the definition
TITLE_BASE = 0x0C9B         # characterTitle: text[%i+0x0C9B]
TITLE_N   = 15

# Slots the ROM tables leave unnamed but that can be identified.  324 is the
# big Mom Bomb flower from the boss sheet (the game reaches it as a separate
# animation slot; monster 164's own block is the smaller bomb frame), which
# the user confirmed against ff4-gba-bosses.png.
ALIAS = {
    324: 'Mom Bomb (boss form)',
}


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
    """Decode a TOSE block (mode 1 = graphics, 2 = layout, 3 = palette),
    LZSS wrapped or not, and return the payload after its header."""
    p = addr - GBA
    if rom[p] == 0x10:
        blob = lzss(rom, p)
    else:
        heads = {1: 32, 2: 2, 3: 2}
        m, cnt = struct.unpack_from('<II', rom, p)
        blob = rom[p:p + 8 + cnt * heads[mode]]
    m, cnt = struct.unpack_from('<II', blob, 0)
    if m != mode:
        raise ValueError('TOSE mode %d != %d at %s' % (m, mode, hex(addr)))
    if mode == 2:                       # layout: 12-byte header, then u16 entries
        return blob[12:12 + cnt * 2]
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


def text_at(rom, index):
    v = struct.unpack_from('<I', rom, NAME_PTRS - GBA + index * 4)[0]
    j = v + NAME_OFF - GBA
    raw = bytearray()
    while j < len(rom) and rom[j] not in (0xFF, 0x0C):
        raw.append(rom[j]); j += 1
    return raw


def str_table(name, length, default, labels):
    return {'name': name, 'length': length, 'default': default,
            'string': {str(k): v for k, v in sorted(labels.items()) if v}}


def hx(n):
    return '0x' + format(n, 'X')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--def', dest='definition', required=True)
    ap.add_argument('--rom', required=True)
    args = ap.parse_args()

    defj = json.load(open(args.definition))
    rom = open(args.rom, 'rb').read()
    tab = char_table(defj)

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

    # ---- monsterSize: size, next animation frame, tile-map pointer ---------
    def rec(m):
        o = SIZE_TBL - GBA + m * SIZE_LEN
        return rom[o:o + SIZE_LEN]

    def size_of(m):
        r = rec(m)
        return r[3], r[4]

    def next_of(m):
        r = rec(m)
        return (r[0] | (r[1] << 8)) - 32

    def tmap_of(m):
        return struct.unpack_from('<I', rec(m), 8)[0]

    names = [decode_text(text_at(rom, NAME_BASE + i), tab) for i in range(NAME_N)]
    titles = [decode_text(text_at(rom, TITLE_BASE + i), tab) for i in range(TITLE_N)]

    # animation chains: follow next-frame links.  A chain can loop (Demon Wall
    # cycles through 11 frames), so walk it once and stop on the repeat.
    owner, frame, chain_len, chains = {}, {}, {}, {}
    for start in range(SLOTS):
        if start in owner:
            continue
        chain, seen = [], set()
        m = start
        while 0 <= m < SLOTS and m not in seen:
            seen.add(m); chain.append(m)
            m = next_of(m)
        # label the chain after the first member that has a ROM name: a chain
        # can start on an unnamed slot (Dark Bahamut's runs 361 -> 152 -> 286
        # and 361 has no name, but 152 does)
        key_slot = next((x for x in chain if x < len(names) and names[x]), chain[0])
        for i, m in enumerate(chain):
            owner[m], frame[m], chain_len[m] = key_slot, i + 1, len(chain)
        chains[id(chain)] = chain

    def slot_label(m):
        o = owner.get(m, m)
        base = names[o] if o < len(names) and names[o] else ALIAS.get(m, 'slot %d' % o)
        if chain_len.get(m, 1) > 1:
            return '%s (frame %d/%d)' % (base, frame[m], chain_len[m])
        return base

    # ---- item ranges -------------------------------------------------------
    # The region is exactly tiled by the union of all 724 pointers (verified:
    # min == GFX_BEGIN, and the block at the max pointer ends at GFX_END).
    # Each item therefore ends where the NEXT pointer of EITHER kind starts,
    # so the two arrays never overlap and no byte loses its owner.
    allp = sorted(set(ptrs))
    if allp[0] != GFX_BEGIN:
        sys.exit('unexpected first pointer %s (region begins %s)'
                 % (hx(allp[0]), hx(GFX_BEGIN)))
    ends = {}
    for i, a in enumerate(allp):
        ends[a] = allp[i + 1] if i + 1 < len(allp) else GFX_END
    if ends[allp[-1]] != GFX_END:
        sys.exit('last block ends %s, expected %s' % (hx(ends[allp[-1]]), hx(GFX_END)))

    # ROMArray parses itemRanges in *file* space when the pointers are mapped
    # (a GBA pointer already carries the 0x08000000 bank, so isMapped is true
    # and mapRange is skipped) - write them the same way.
    def ranges_for(values, ends_map):
        uniq = sorted(set(values))
        return ['0x%X-0x%X' % (a - GBA, ends_map[a] - GBA) for a in uniq], uniq

    gfx_ranges, gfx_uniq = ranges_for(gfx_ptrs, ends)
    pal_ranges, pal_uniq = ranges_for(pal_ptrs, ends)

    def index_map(values):
        return {a: i for i, a in enumerate(sorted(set(values)))}

    gfx_index, pal_index = index_map(gfx_ptrs), index_map(pal_ptrs)

    # ---- labels ------------------------------------------------------------
    def label_for(values, idx):
        users = {}
        for m, a in enumerate(values):
            users.setdefault(a, []).append(m)
        out = {}
        for a, ms in users.items():
            parts = []
            for m in ms:
                lab = slot_label(m)
                if lab not in parts:
                    parts.append(lab)
            out[idx[a]] = ', '.join(parts)
        return out

    gfx_labels = label_for(gfx_ptrs, gfx_index)
    pal_labels = label_for(pal_ptrs, pal_index)

    # ---- the 22 tile-mapped monsters ---------------------------------------
    # Their blocks are tile POOLS: the game places the tiles with a TOSE layout
    # whose entries carry a palette bank in bits 10-11 (hence the 48-colour
    # palettes).  Model the layouts so those bytes have an owner and the view
    # can read the banks straight out of the ROM.
    tmaps = [(m, tmap_of(m)) for m in range(SLOTS) if tmap_of(m)]
    tmap_ptrs = sorted(set(a for _, a in tmaps))
    tmap_ends = {}
    for i, a in enumerate(tmap_ptrs):
        n, cnt = struct.unpack_from('<II', rom, a - GBA)
        tmap_ends[a] = (tmap_ptrs[i + 1] if i + 1 < len(tmap_ptrs) else TMAP_END)
        if a + 12 + cnt * 2 > tmap_ends[a]:
            sys.exit('tile map at %s overruns its range' % hx(a))
    tmap_ranges, _ = ranges_for([a for _, a in tmaps], tmap_ends)
    tmap_index = {a: i for i, a in enumerate(tmap_ptrs)}
    # which graphics objects need per-tile banks
    banks = {}
    for m, a in tmaps:
        banks[gfx_index[gfx_ptrs[m]]] = tmap_index[a]

    # ---- display size per shared block -------------------------------------
    # A block can be pointed at by several records that disagree about its
    # size (slot 152 calls a 48-tile block 10x8, slot 361 calls the same block
    # 6x8).  Only one size can be shown, so pick the one that actually fits
    # the data - anything else reads past the end and looks jumbled.
    def gfx_tiles(a):
        p = a - GBA
        if rom[p] == 0x10:
            blob = lzss(rom, p)
            return (len(blob) - 8) // 32
        m, cnt = struct.unpack_from('<II', rom, p)
        return cnt

    users_of = {}
    for m in range(SLOTS):
        users_of.setdefault(gfx_ptrs[m], []).append(m)

    item_sizes = [None] * len(gfx_uniq)
    for a, ms in users_of.items():
        tiles = gfx_tiles(a)
        cand = [size_of(m) for m in ms]
        pick = next((s for s in cand if s[0] * s[1] == tiles), None)
        if pick is None:
            fits = [s for s in cand if s[0] * s[1] <= tiles]
            pick = max(fits, key=lambda s: s[0] * s[1]) if fits else cand[0]
        first = size_of(ms[0])          # what sizeFrom would pick
        if pick != first:
            item_sizes[gfx_index[a]] = [pick[0], pick[1]]

    # per-tile palette banks on the pooled graphics (a list indexed by array
    # item, like itemPalettes)
    item_attrs = [None] * len(gfx_uniq)
    for m, a in tmaps:
        item_attrs[gfx_index[gfx_ptrs[m]]] = {
            'path': 'monsterTilemaps', 'index': tmap_index[a],
            'at': 12, 'stride': 2, 'shift': 12, 'mask': 3,
        }

    # ---- character sprites -------------------------------------------------
    # 20 groups of 16 pointers: 15 animation frames (2x3 tiles each) and the
    # group's palette last.  These are the sprites the enemy classes
    # (Dragoon, Bard, Monk, Dark Knight, Girl, Dark Kain) and the party use.
    cptr = [struct.unpack_from('<I', rom, CHAR_TBL - GBA + i * 4)[0]
            for i in range(CHAR_N)]
    cgfx, cpal = [], []
    for g in range(CHAR_GROUPS):
        grp = cptr[g * 16:g * 16 + 16]
        cgfx += grp[:CHAR_FRAMES]
        cpal.append(grp[CHAR_FRAMES])
    cends = {}
    for i, a in enumerate(sorted(set(cptr))):
        pass
    c_all = sorted(set(cptr))
    for i, a in enumerate(c_all):
        cends[a] = c_all[i + 1] if i + 1 < len(c_all) else c_all[-1] + 200
    # the last group's palette ends the region; measure it exactly
    last = c_all[-1]
    m3, cnt3 = struct.unpack_from('<II', rom, last - GBA)
    cends[last] = last + 8 + cnt3 * 2
    cg_ranges, cg_uniq = ranges_for(cgfx, cends)
    cp_ranges, cp_uniq = ranges_for(cpal, cends)
    cg_index, cp_index = index_map(cgfx), index_map(cpal)

    char_labels, cpal_labels = {}, {}
    users = {}
    for m in range(SLOTS):
        n = next_of(m)
        if 0 <= n < CHAR_GROUPS:
            users.setdefault(n, []).append(names[m] if m < len(names) and names[m]
                                          else 'slot %d' % m)
    for g in range(CHAR_GROUPS):
        title = titles[g] if g < len(titles) else None
        who = ', '.join(dict.fromkeys(users.get(g, [])))
        label = 'Character %d' % g
        if title:
            label += ' (%s)' % title
        if who:
            label += ' - used by ' + who
        for f in range(CHAR_FRAMES):
            char_labels[cg_index[cgfx[g * CHAR_FRAMES + f]]] = \
                '%s, frame %d/%d' % (label, f + 1, CHAR_FRAMES)
        cpal_labels[cp_index[cpal[g]]] = label
    # frames repeat (a pose reuses tiles), so several groups can share art;
    # merge those labels instead of letting one overwrite another
    merged = {}
    for g in range(CHAR_GROUPS):
        for f in range(CHAR_FRAMES):
            i = cg_index[cgfx[g * CHAR_FRAMES + f]]
            lab = char_labels[i]
            if i in merged and lab not in merged[i]:
                merged[i] = merged[i] + ' / ' + lab.split(', frame')[0] + \
                    ', frame %d/%d' % (f + 1, CHAR_FRAMES)
            else:
                merged[i] = lab
    char_labels = merged

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
        'stringTable': str_table('Monster Graphics Properties', SLOTS,
                                 'Monster %i',
                                 {m: slot_label(m) for m in range(SLOTS)}),
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
        'itemTilePalettes': item_attrs,
        'itemSizes': item_sizes,
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
        'stringTable': str_table('Monster Graphics', len(gfx_uniq),
                                 'Monster Graphics %i', gfx_labels),
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
        'stringTable': str_table('Monster Palette', len(pal_uniq),
                                 'Monster Palette %i', pal_labels),
    }

    tmap = {
        'type': 'array',
        'name': 'Monster Tilemaps',
        'isFragmented': True,
        'canRelocate': True,
        'arrayLength': len(tmap_ptrs),
        'assembly': {
            'type': 'assembly',
            'name': 'Monster Tilemap',
            'align': 4,
        },
        'pointerObject': {
            'arrayPath': 'monsterSize',
            'pointerPath': 'tilemapPointer',
        },
        'itemRanges': tmap_ranges,
        'stringTable': str_table('Monster Tilemap', len(tmap_ptrs),
                                 'Monster Tilemap %i',
                                 {tmap_index[a]: 'frames of ' + slot_label(m)
                                  for m, a in tmaps}),
    }

    size = asm.get('monsterSize')
    if size:
        # bytes 0-1: the next frame of the same sprite (slot = value - 32;
        # below 32 it is a character sprite group).  bytes 8-11: a TOSE layout
        # pointer, used by the 22 monsters drawn from a tile pool.
        size['assembly']['assembly']['nextFrame'] = {
            'type': 'property', 'name': 'Next Frame', 'begin': 0, 'mask': '0xFFFF',
        }
        size['assembly']['assembly']['tilemapPointer'] = {
            'type': 'property', 'name': 'Tilemap Pointer',
            'begin': 8, 'mask': '0x7FFFFFFF', 'pointerTo': 'monsterTilemaps',
        }


    charprops = {
        'type': 'array',
        'name': 'Character Sprite Properties',
        'range': hx(CHAR_TBL) + '-' + hx(CHAR_END),
        'arrayLength': CHAR_GROUPS,
        'assembly': {
            'type': 'data',
            'length': 64,
            'assembly': {},
        },
        'stringTable': str_table('Character Sprite Properties', CHAR_GROUPS,
                                 'Character %i',
                                 {g: (titles[g] if g < len(titles) else 'Character %d' % g)
                                  for g in range(CHAR_GROUPS)}),
    }
    for f in range(CHAR_FRAMES):
        charprops['assembly']['assembly']['graphicsPointer%d' % f] = {
            'type': 'property', 'name': 'Frame %d' % (f + 1),
            'begin': f * 4, 'mask': '0x7FFFFFFF',
            'pointerTo': 'characterGraphics',
        }
    charprops['assembly']['assembly']['palettePointer'] = {
        'type': 'property', 'name': 'Palette Pointer',
        'begin': CHAR_FRAMES * 4, 'mask': '0x7FFFFFFF',
        'pointerTo': 'characterPalettes',
    }

    chgfx = {
        'type': 'array',
        'name': 'Character Graphics',
        'isFragmented': True,
        'canRelocate': True,
        'arrayLength': len(cg_uniq),
        'assembly': {
            'type': 'graphics',
            'name': 'Character Graphics',
            'format': ['linear4bpp', 'tose-graphics', 'gba-lzss'],
            'align': 4,
            'width': 2,
            'height': 3,
            'palette': 'characterPalettes',
        },
        'pointerObject': [{'arrayPath': 'characterSpriteProperties',
                           'pointerPath': 'graphicsPointer%d' % f}
                          for f in range(CHAR_FRAMES)],
        'itemRanges': cg_ranges,
        'stringTable': str_table('Character Graphics', len(cg_uniq),
                                 'Character Graphics %i', char_labels),
    }

    chpal = {
        'type': 'array',
        'name': 'Character Palette',
        'isFragmented': True,
        'canRelocate': True,
        'arrayLength': len(cp_uniq),
        'assembly': {
            'type': 'assembly',
            'name': 'Character Palette',
            'format': ['bgr555', 'tose-palette'],
            'align': 4,
        },
        'pointerObject': {'arrayPath': 'characterSpriteProperties',
                          'pointerPath': 'palettePointer'},
        'itemRanges': cp_ranges,
        'stringTable': str_table('Character Palette', len(cp_uniq),
                                 'Character Palette %i', cpal_labels),
    }

    asm['monsterGraphicsProperties'] = props
    asm['monsterGraphics'] = gfx
    asm['monsterPalettes'] = pal
    asm['monsterTilemaps'] = tmap
    asm['characterSpriteProperties'] = charprops
    asm['characterGraphics'] = chgfx
    asm['characterPalettes'] = chpal

    # ---- hierarchy ---------------------------------------------------------
    battle = next((s for s in defj['hierarchy'] if s.get('name') == 'Battle'), None)
    if battle is not None:
        want = [('Monster Graphics', 'monsterGraphics'),
                ('Monster Palettes', 'monsterPalettes'),
                ('Monster Graphics Properties', 'monsterGraphicsProperties'),
                ('Monster Tilemaps', 'monsterTilemaps')]
        have = {e.get('path') for e in battle['list']}
        at = next((i for i, e in enumerate(battle['list'])
                   if e.get('path') == 'monsterProperties'), len(battle['list'])) + 1
        for name, path in reversed(want):
            if path not in have:
                battle['list'].insert(at, {'name': name, 'path': path})
    character = next((s for s in defj['hierarchy'] if s.get('name') == 'Character'),
                     None)
    if character is not None:
        have = {e.get('path') for e in character['list']}
        at = next((i for i, e in enumerate(character['list'])
                   if e.get('path') == 'characterProperties'),
                  len(character['list'])) + 1
        for name, path in reversed([('Character Graphics', 'characterGraphics'),
                                    ('Character Palettes', 'characterPalettes'),
                                    ('Character Sprites', 'characterSpriteProperties')]):
            if path not in have:
                character['list'].insert(at, {'name': name, 'path': path})

    json.dump(defj, open(args.definition, 'w'), indent=4)
    print('%s:' % args.definition)
    print('  %d graphics, %d palettes, %d tilemaps, %d property records'
          % (len(gfx_uniq), len(pal_uniq), len(tmap_ptrs), SLOTS))
    print('  %d character frames, %d character palettes'
          % (len(cg_uniq), len(cp_uniq)))
    chained = sum(1 for m in range(SLOTS) if chain_len.get(m, 1) > 1)
    print('  %d slots in animation chains, %d pooled (tile-mapped) graphics, %d resized'
          % (chained, len([x for x in item_attrs if x]), len([x for x in item_sizes if x])))


if __name__ == '__main__':
    main()
