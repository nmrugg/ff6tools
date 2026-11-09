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
# dialogue portraits: one contiguous table of 4-byte pointers, 12 graphics
# then 12 palettes per character; each block 16 tiles (4x4, 32x32 px) with a
# 32-colour palette
PORT_TBL, PORT_N = 0x080F2D48, 321
PORT_SET = 12
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

    # ---- naming the unnamed slots ------------------------------------------
    # The 283-361 range is extra animation frames of the big bosses and the
    # Espers.  Nothing in the tables names them, but two ROM-internal signals
    # identify almost all of them:
    #   * a named monster of the same size sharing this slot's palette
    #     pointer - same creature, another frame;
    #   * the tile-mapped Esper set: pairing the orphan tile-mapped slots with
    #     the named tile-mapped slots by size in table order.  That rule is
    #     independently confirmed by the animation chain, which already links
    #     slot 348 to Lunar Ramuh.
    def name_at(m):
        return names[m] if m < len(names) and names[m] else None

    def pal_of(m):
        return struct.unpack_from('<I', rom, PTR_TBL - GBA + m * 8)[0]

    by_pal, by_size = {}, {}
    for m in range(SLOTS):
        if name_at(m):
            by_pal.setdefault(pal_of(m), []).append(m)
            by_size.setdefault(size_of(m), []).append(m)

    named_tiled = [m for m in range(SLOTS) if tmap_of(m) and name_at(m)
                   and size_of(m) != (20, 16)]
    orphan_tiled = [m for m in range(SLOTS) if tmap_of(m) and not name_at(m)]
    tile_pair = {}
    for m in sorted(orphan_tiled):
        same = [x for x in named_tiled if size_of(x) == size_of(m)]
        if same:
            # several orphan frames can share one Esper's size (Asura and Odin
            # each have two); pair them in table order so they line up with
            # the game's own frame sequence
            k = sum(1 for x in orphan_tiled if x < m and size_of(x) == size_of(m))
            tile_pair[m] = same[k % len(same)]

    EXTRA = {}
    for m in range(SLOTS):
        if name_at(m):
            continue
        sz = size_of(m)
        cands = sorted({name_at(x) for x in by_pal.get(pal_of(m), [])
                        if size_of(x) == sz and name_at(x)})
        bysz = sorted({name_at(x) for x in by_size.get(sz, []) if name_at(x)})
        if len(cands) == 1:
            EXTRA[m] = '%s (extra frame)' % cands[0]
        elif m in tile_pair:
            EXTRA[m] = '%s (extra frame)' % name_at(tile_pair[m])
        elif len(bysz) == 1:
            EXTRA[m] = '%s (extra frame?)' % bysz[0]
        elif cands:
            EXTRA[m] = 'slot %d (same size and palette as %s)' % (m, ', '.join(cands[:4]))
        elif bysz:
            EXTRA[m] = 'slot %d (same size as %s)' % (m, ', '.join(bysz[:4]))

    def slot_label(m):
        o = owner.get(m, m)
        base = name_at(o) or ALIAS.get(m) or EXTRA.get(m) or EXTRA.get(o) or 'slot %d' % o
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
        # only a real reference counts: an identity record (next == itself) is
        # just a monster whose animation has one frame, not a character lookup
        if n != m and 0 <= n < CHAR_GROUPS:
            users.setdefault(n, []).append(names[m] if m < len(names) and names[m]
                                          else 'slot %d' % m)
    # the party/enemy classes, from the ROM's own characterTitle strings where
    # they exist and from the game otherwise (14-18 are the transformed forms
    # and the two non-party sprites that appear in battle)
    # The sprite groups are indexed by class, but a job name is much less
    # useful in the tree than the character who uses it: characterTitle gives
    # the job (D. Knight, Dragoon, W. Mage ...) and characterNames the party
    # in the same order, so show "Cecil (D. Knight)". 13-19 are the forms and
    # non-party sprites that characterTitle does not name.
    CLASS_NAMES = {13: 'Rydia (older)', 14: 'Small', 15: 'Frog', 16: 'Pig',
                   17: 'Golbez', 18: 'Anna', 19: 'Dark Kain'}
    charnames = [decode_text(text_at(rom, 0x00F4 + i), tab) for i in range(13)]
    class_label = {}
    for g in range(CHAR_GROUPS):
        job = titles[g] if g < len(titles) and titles[g] and titles[g] != 'None' else None
        who = CLASS_NAMES.get(g) or (charnames[g] if g < len(charnames) else None)
        if who and job and job.split()[0].rstrip('.') not in who:
            label = 'Character %d: %s (%s)' % (g, who, job)
        else:
            label = 'Character %d: %s' % (g, who or job or 'class %d' % g)
        extra = ', '.join(dict.fromkeys(users.get(g, [])))
        if extra:
            label += ' - also used by %s' % extra
        class_label[g] = label

    # A block can be used by several frames of the same group, or by the same
    # frame number of several groups (poses are shared), so collect every
    # (group, frame) that uses it and say so once, rather than letting the
    # last writer name it "frame 15/15" when the user opened frame 11.
    frames_of = {}
    for g in range(CHAR_GROUPS):
        for f in range(CHAR_FRAMES):
            frames_of.setdefault(cg_index[cgfx[g * CHAR_FRAMES + f]], []).append((g, f + 1))
    char_labels = {}
    for i, uses in frames_of.items():
        parts = {}
        for g, f in uses:
            parts.setdefault(class_label[g], []).append(f)
        def fmt(lab, fs):
            return '%s, frame%s %s/%d' % (lab, 's' if len(fs) > 1 else '',
                                          ','.join(str(x) for x in sorted(fs)), CHAR_FRAMES)
        if len(parts) > 4:
            # a piece shared by nearly every class is a blank or a stock pose;
            # naming all of them buries the useful part of the label
            first = list(parts.items())[:2]
            char_labels[i] = '%s (and %d other character groups)' % (
                '; '.join(fmt(l, fs) for l, fs in first), len(parts) - 2)
        else:
            char_labels[i] = '; '.join(fmt(l, fs) for l, fs in parts.items())
        cpal_labels[i] = ('; '.join(sorted({class_label[g] for g, _ in uses}))
                          if len(uses) <= 4 else
                          '%d character groups (blank/stock frame)' % len({g for g, _ in uses}))
    for g in range(CHAR_GROUPS):
        cpal_labels.setdefault(cp_index[cpal[g]], class_label[g])

    # per-frame size: most frames are 2x3 tiles, the pose frames (11, 14, 15
    # and almost all of Anna's) are 3x3, and frame 10 is the death pose - the
    # sprite lies down, so its six tiles go 3 wide by 2 tall.  Forcing one
    # size on all of them jumbled them.
    def tiles_at(a):
        p = a - GBA
        if rom[p] == 0x10:
            blob = lzss(rom, p)
            return (len(blob) - 8) // 32
        m, cnt = struct.unpack_from('<II', rom, p)
        return cnt

    DEATH_FRAME = 9
    char_sizes, char_pins = [None] * len(cg_uniq), [None] * len(cg_uniq)
    for g in range(CHAR_GROUPS):
        for f in range(CHAR_FRAMES):
            i = cg_index[cgfx[g * CHAR_FRAMES + f]]
            n = tiles_at(cgfx[g * CHAR_FRAMES + f])
            if n == 9:
                w, h = 3, 3
            elif f == DEATH_FRAME:
                w, h = 3, 2
            else:
                w, h = 2, 3
            char_sizes[i] = [w, h]
    # A frame shared by several classes is drawn with whichever class is on
    # screen, so it cannot be pinned to one palette: offer the sharing groups
    # as a named dropdown (the same pattern as the FF4 SNES Pig/Small/Toad
    # choices) and default to the first.
    for i, uses in frames_of.items():
        groups = sorted({g for g, _ in uses})
        pin = lambda g: {'path': 'characterPalettes[%d]' % cp_index[cpal[g]],
                         'name': class_label[g]}
        char_pins[i] = pin(groups[0]) if len(groups) == 1 else \
            [pin(g) for g in groups] + [{'path': 'characterPalettes'}]

    # ---- portraits ---------------------------------------------------------
    # Two tables of 4-byte pointers.  Walking each table shows the pattern
    # 12 graphics then 12 palettes: one set of expressions per character.
    # Each block is 16 tiles (4x4 = 32x32 px) with a 32-colour palette, and
    # colour 0 is a real colour (the backdrop of the face), so these are
    # backColor: true.
    def is_pal(a):
        return rom[a - GBA] != 0x10 and struct.unpack_from('<I', rom, a - GBA)[0] == 3

    # One contiguous table of 4-byte pointers (what looks like two tables is
    # just where a pointer-run scan happened to stop).  Walking it gives the
    # pattern 12 graphics then 12 palettes, repeated: one set of expressions
    # per character, 13 complete sets and a trailing 9-graphic set.
    # Each block is 16 tiles (4x4 = 32x32 px) with a 32-colour palette.
    entries = [struct.unpack_from('<I', rom, PORT_TBL - GBA + i * 4)[0]
               for i in range(PORT_N)]
    runs = []
    for a in entries:
        k = 'pal' if is_pal(a) else 'gfx'
        if runs and runs[-1][0] == k:
            runs[-1][1].append(a)
        else:
            runs.append([k, [a]])
    set_of_run, seen = {}, 0
    for x, (k, run) in enumerate(runs):
        if k == 'gfx':
            seen += 1
            set_of_run[x] = seen
    # the last set has no palette run of its own: it is adult Rydia, and the
    # game reuses young Rydia's palettes
    PORT_REUSE = {14: 4}
    port_gfx, port_pal, port_label = [], [], []
    i = 0
    while i < len(runs):
        k, run = runs[i]
        if k != 'gfx':
            i += 1; continue
        pals = runs[i + 1][1] if i + 1 < len(runs) and runs[i + 1][0] == 'pal' else []
        if not pals and set_of_run[i] in PORT_REUSE:
            j = next((x for x in runs and range(len(runs))
                      if runs[x][0] == 'gfx' and set_of_run.get(x) == PORT_REUSE[set_of_run[i]]), None)
            if j is not None and j + 1 < len(runs) and runs[j + 1][0] == 'pal':
                pals = runs[j + 1][1]
        total = max(len(run), len(pals) or 1)
        for j, a in enumerate(run):
            port_gfx.append(a)
            port_pal.append(pals[j] if j < len(pals) else
                            (pals[-1] if pals else None))
            port_label.append((set_of_run[i], j + 1, total))
        i += 2
    pall = sorted(set(a for a in port_pal if a))
    allp2 = sorted(set(port_gfx) | set(pall))
    pends = {}
    for i, a in enumerate(allp2):
        pends[a] = allp2[i + 1] if i + 1 < len(allp2) else a + 8 + 16 * 32
    pg_index = {a: i for i, a in enumerate(sorted(set(port_gfx)))}
    pp_index = {a: i for i, a in enumerate(pall)}
    port_g_ranges = ['0x%X-0x%X' % (a - GBA, pends[a] - GBA)
                     for a in sorted(set(port_gfx))]
    port_p_ranges = ['0x%X-0x%X' % (a - GBA, pends[a] - GBA) for a in pall]
    port_pins = [None] * len(pg_index)
    # The sets follow the ROM's own character order (set 10 is Porom, which is
    # characterNames[9]); the trailing 9-graphic set is adult Rydia.
    PORT_SET_NAMES = {(k + 1): charnames[k]
                      for k in range(min(13, len(charnames))) if charnames[k]}
    PORT_SET_NAMES[14] = 'Rydia (older)'
    port_labels, port_plabels = {}, {}
    for n, (a, pa) in enumerate(zip(port_gfx, port_pal)):
        if pa is not None:
            port_pins[pg_index[a]] = 'portraitPalettes[%d]' % pp_index[pa]
        setno_, expr, total = port_label[n]
        who = PORT_SET_NAMES.get(setno_)
        lab = ('%s portrait, expression %d/%d' % (who, expr, total)) if who else \
              ('Portrait set %d, expression %d/%d' % (setno_, expr, total))
        if pg_index[a] not in port_labels:
            port_labels[pg_index[a]] = lab
    for i, a in enumerate(pall):
        port_plabels[pp_index[a]] = 'Portrait palette %d' % (i + 1)

    # ---- the assemblies ----------------------------------------------------
    asm = defj['assembly']
    for stale in ('dialoguePortraitPointers', 'battlePortraitPointers'):
        asm.pop(stale, None)
        for sec in defj['hierarchy']:
            sec['list'] = [e for e in sec['list'] if e.get('path') != stale]

    # ---- world graphics palettes ------------------------------------------
    # worldProperties gives two graphics pointers and one palette per world
    # map, but worldGraphics only carried the whole array as its palette, so
    # selecting a world graphic always opened palette 0. Pin each object to
    # the palette of the record that points at it (same linkPalette idea as
    # the monster graphics).
    WP_TBL, WP_LEN, WP_N = 0x080F2560, 84, 5
    wg_pins, wg_labels = {}, {}
    wp_ptr = lambda rec, off: struct.unpack_from('<I', rom, WP_TBL - GBA + rec * WP_LEN + off)[0] & 0x7FFFFFFF
    wgfx_seen, wpal_seen = [], []
    for r in range(WP_N):
        for off in (0, 4):
            a = wp_ptr(r, off)
            if a:
                wgfx_seen.append(a)
                wpal_seen.append(wp_ptr(r, 8))
    wpal_uniq = sorted(set(p for p in wpal_seen if p))
    widx = {a: i for i, a in enumerate(sorted(set(wgfx_seen)))}
    wlmap = {a: i for i, a in enumerate(wpal_uniq)}
    world = asm.get('worldGraphics')
    if world and widx:
        for a, p in zip(wgfx_seen, wpal_seen):
            if p:
                wg_pins[widx[a]] = 'worldPalette[%d]' % wlmap[p]
        wst = world.get('stringTable', {}).get('string', {})
        for r in range(WP_N):
            for k, off in (('layer 1', 0), ('layer 2', 4)):
                a = wp_ptr(r, off)
                if a and a in widx and str(widx[a]) not in wst:
                    wst[str(widx[a])] = 'World %s %d' % (k, r + 1)
        world['itemPalettes'] = [wg_pins.get(i) for i in range(len(widx))]


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
                                 'Character %i', class_label),
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
        # per-frame size (2x3 or 3x3) and the group's palette, so selecting a
        # frame opens with the colours that frame actually uses
        'itemSizes': char_sizes,
        'itemPalettes': char_pins,
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

    # portraits: the pointer table is modelled as a plain pointer array (the
    # graphics/palette pairing is positional - 12 expressions then 12
    # palettes - so the objects are placed by static ranges and pinned)
    asm['portraitPointers'] = {
        'type': 'array',
        'name': 'Portrait Pointers',
        'range': hx(PORT_TBL) + '-' + hx(PORT_TBL + PORT_N * 4),
        'arrayLength': PORT_N,
        'assembly': {
            'type': 'data',
            'length': 4,
            'assembly': {
                'pointer': {'type': 'property', 'name': 'Pointer',
                            'begin': 0, 'mask': '0x7FFFFFFF'},
            },
        },
    }
    asm['portraitGraphics'] = {
        'type': 'array',
        'name': 'Portraits',
        'isFragmented': True,
        'canRelocate': True,
        'arrayLength': len(pg_index),
        'assembly': {
            'type': 'graphics',
            'name': 'Portrait',
            'format': ['linear4bpp', 'tose-graphics', 'gba-lzss'],
            'align': 4,
            'width': 4,
            'height': 4,
            # colour 0 is the flat backdrop behind the face (blue, red or
            # black depending on the set) - transparent, not a real colour
            'backColor': False,
            'palette': 'portraitPalettes',
        },
        'itemRanges': port_g_ranges,
        'itemPalettes': port_pins,
        'stringTable': str_table('Portraits', len(pg_index), 'Portrait %i', port_labels),
    }
    asm['portraitPalettes'] = {
        'type': 'array',
        'name': 'Portrait Palette',
        'isFragmented': True,
        'canRelocate': True,
        'arrayLength': len(pall),
        'assembly': {
            'type': 'assembly',
            'name': 'Portrait Palette',
            'format': ['bgr555', 'tose-palette'],
            'align': 4,
        },
        'itemRanges': port_p_ranges,
        'stringTable': str_table('Portrait Palette', len(pall),
                                 'Portrait Palette %i', port_plabels),
    }

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
                                    ('Character Sprites', 'characterSpriteProperties'),
                                    ('Portraits', 'portraitGraphics'),
                                    ('Portrait Palettes', 'portraitPalettes'),
                                    ('Portrait Pointers', 'portraitPointers')]):
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
