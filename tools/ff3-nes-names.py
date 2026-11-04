#!/usr/bin/env python3
"""Generate the string tables that name FF3 (Japan) NES monster graphics,
monster graphics properties, battle palettes and battle character graphics,
straight from the ROM (the names are the game's own Japanese strings).

    usage: ff3-nes-names.py [--json ff3/ff3j-nes.json] [--write]

--write patches the tables into the definition file; without it the script just
prints a summary so you can see what would be generated.
"""
import json, os, re, sys, argparse
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROMNAME = 'Final Fantasy III (Japan) (fixed).nes'

# everything below is in the tool's mapper-mapped (def) address space
MONSTER_NAMES  = 0x520   # text id of monster 0
JOB_NAMES      = 0x1E2   # text id of job 0
N_MONSTERS     = 256
N_JOBS         = 22

TEXT_POINTER   = (0x188000, 0x188D60)
TEXT_DATA      = (0x188D60, 0x1FA000)
MONSTER_PROPS  = (0x2E8B00, 0x2E8C00)   # 256 * 1 byte: %SSSi iiii
BATTLE_PROPS   = (0x2E8000, 0x2E8400)   # 512 * 2 bytes: monster set, count id
BATTLE_SETS    = (0x2E8400, 0x2E8A00)   # 256 * 6 bytes: pal1, pal2, 4 monster ids
BATTLE_PALETTES= (0x2E8C00, 0x2E8F00)   # 256 * 3 bytes (colour 0 is always black)

# size classes: (key, def begin, def end, width, height, entries)
MONSTER_CLASSES = [
    ('monsterGraphics4x4',   0x208000, 0x209000,  4,  4, 16),
    ('monsterGraphics4x6',   0x209000, 0x219400,  4,  6, 24),
    ('monsterGraphics6x6',   0x228000, 0x239600,  6,  6, 24),
    ('monsterGraphics6x6b',  0x248000, 0x259600,  6,  6, 24),
    ('monsterGraphics6x12',  0x268000, 0x269200,  6, 12,  4),
    ('monsterGraphics12x6',  0x269200, 0x278400, 12,  6,  4),
]

def mmc3_to_file(addr):
    return ((addr & 0xFF0000) >> 3) + (addr & 0x1FFF) + 0x10

def file_to_def(file_addr):
    """Inverse of mmc3_to_file: pick the $8000/$A000 window form for a bank.
    Only $8000-$9FFF address a bank's 8 KiB, so a range that runs past $9FFF
    has to be written as the next bank's $8000."""
    a = file_addr - 0x10
    bank = (a << 3) & 0xFF0000
    off = a & 0x1FFF
    return bank | off | (0xA000 if (bank & 0x10000) else 0x8000)

def load_char_table(defn):
    """code -> character, from the definition's charTable.text.

    The English (translation) table uses multi-character entries for its
    compression codes, so anything that is not an escape sequence (\\item, \\n,
    ...) is accepted as-is.
    """
    table = {}
    for code, ch in defn['charTable']['text']['char'].items():
        if not re.fullmatch(r'0x[0-9A-Fa-f]+', code):
            continue
        code = int(code, 0)
        if ch.startswith('\\'):
            continue                      # escape sequences like \item
        table[code] = ch
    return table

def decode_text(data, charmap, start, end):
    """Decode a ROM text string; stops at 0x00. Mirrors
    ROMTextEncoding.prototype.decode: try the two-byte code first, then the
    one-byte code (the English translation table uses two-byte codes such as
    0xD0D2 = "ill")."""
    out = []
    i = start
    while i < end and data[i]:
        b1 = data[i]
        b2 = data[i + 1] if i + 1 < end else 0
        c = charmap.get((b1 << 8) | b2)
        if c is None:
            c = charmap.get(b1)
            i += 1
        else:
            i += 2
        if c is None:
            continue                  # unknown code: the tool shows \xNN
        if c == '\\0':
            break
        out.append(c)
    return ''.join(out).replace('　', ' ').strip()

# The size-class arrays do not cover the whole 64 KiB monster graphics region:
# the unused stretches between them hold most boss tile pools, so each gap needs
# its own owner assembly (file offsets, header included).
def spare_regions():
    spans = sorted((mmc3_to_file(c[1]), mmc3_to_file(c[2])) for c in MONSTER_CLASSES)
    lo, hi = mmc3_to_file(0x208000), mmc3_to_file(0x288000)
    out, cursor = [], lo
    n = 0
    for start, end in spans:
        if start > cursor:
            n += 1
            out.append(('monsterGraphicsSpare%d' % n, cursor, start))
        cursor = max(cursor, end)
    if cursor < hi:
        n += 1
        out.append(('monsterGraphicsSpare%d' % n, cursor, hi))
    return out

SPARE_REGIONS = None   # filled in by main(), once the ROM is known


def main(rom=None, json_path=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('-r', '--rom', default=os.path.join(ROOT, ROMNAME))
    ap.add_argument('-d', '--def', dest='json', default=os.path.join(ROOT, 'ff3/ff3j-nes.json'))
    ap.add_argument('--write', action='store_true')
    if rom or json_path:
        args = ap.parse_args([])
        args.rom = rom or args.rom
        args.json = json_path or args.json
    else:
        args = ap.parse_args()

    defn = json.load(open(args.json))
    data = open(args.rom, 'rb').read()
    charmap = load_char_table(defn)

    # --- text strings ----------------------------------------------------
    p0, p1 = TEXT_POINTER
    pointers = data[mmc3_to_file(p0):mmc3_to_file(p1)]
    text_base = mmc3_to_file(p0)      # pointers are relative to the pointer table
    text_end = mmc3_to_file(TEXT_DATA[1])
    def text(i):
        v = pointers[2*i] | (pointers[2*i+1] << 8)
        return decode_text(data, charmap, text_base + v, text_end)

    monster_name = [text(MONSTER_NAMES + i) for i in range(N_MONSTERS)]
    job_name = [text(JOB_NAMES + i) for i in range(N_JOBS)]

    # --- monster graphics selection --------------------------------------
    props = data[mmc3_to_file(MONSTER_PROPS[0]):mmc3_to_file(MONSTER_PROPS[1])]
    # class 6 ($C0) is the boss tilemap mechanism, not a flat bitmap
    by_class = {}
    for mid, v in enumerate(props):
        by_class.setdefault(v >> 5, []).append(mid)

    tables = {}

    # one string table per size class: which monsters use each graphic
    for cls, (key, begin, end, w, h, count) in enumerate(MONSTER_CLASSES):
        strings = {}
        for i in range(count):
            users = [mid for mid, v in enumerate(props) if (v >> 5) == cls and (v & 0x1F) == i]
            names = []
            for mid in users:
                n = monster_name[mid] or ('Monster $%02X' % mid)
                # mark boss monsters (ids $80-$FF) so they can be spotted in a
                # long shared-graphics label - most bosses use these size
                # classes, only 32 of them use the boss tilemaps
                if mid >= 0x80:
                    n = '*' + n
                if n not in names:
                    names.append(n)
            if names:
                # list *every* user, bosses first and marked: the tree is the
                # only place a monster name appears next to its graphic, and a
                # name hidden behind "+3" reads as a monster that is missing
                names.sort(key=lambda n: (not n.startswith('*'), n))
                strings[str(i)] = ', '.join(names)
        tables[key] = {'length': count, 'default': 'Monster Graphics %i', 'string': strings}

    # the per-monster table is indexed by monster id, so the game's own
    # monster-name strings can be referenced directly
    tables['monsterGraphicsProperties'] = {
        'length': N_MONSTERS,
        'default': '<stringTable.text[%i+' + str(MONSTER_NAMES) + ']>',
        'string': {}}

    # --- battle palettes: which battle groups use each palette -----------
    battle_props = data[mmc3_to_file(BATTLE_PROPS[0]):mmc3_to_file(BATTLE_PROPS[1])]
    sets = data[mmc3_to_file(BATTLE_SETS[0]):mmc3_to_file(BATTLE_SETS[1])]
    pal_users = {}
    for s in range(256):
        base = s * 6
        if base + 6 > len(sets):
            break
        for slot in (0, 1):
            p = sets[base + slot]
            ids = [sets[base + 2 + k] for k in range(4) if sets[base + 2 + k] != 0xFF]
            names = []
            for mid in ids:
                n = monster_name[mid] or ('Monster $%02X' % mid)
                if n not in names:
                    names.append(n)
            if names:
                pal_users.setdefault(p, []).extend(names)
    fixed = {0xFB: 'Menu Window', 0xFC: 'Character 0', 0xFD: 'Character 1',
             0xFE: 'Character 2', 0xFF: 'Cursor'}
    strings = {}
    for p in range(256):
        names = []
        for n in pal_users.get(p, []):
            if n not in names:
                names.append(n)
        if fixed.get(p):
            names.insert(0, fixed[p])
        if names:
            strings[str(p)] = ', '.join(names[:4]) + ('…' if len(names) > 4 else '')
    tables['battlePalettes'] = {'length': 256, 'default': 'Battle Palette %i', 'string': strings}

    # --- battle character graphics: named by job -------------------------
    strings = {}
    for i in range(24):
        if i < N_JOBS and job_name[i]:
            strings[str(i)] = job_name[i]
        else:
            strings[str(i)] = 'Job %i' % i
    tables['battleCharacterGraphics'] = {'length': 24, 'default': 'Job %i', 'string': strings}

    # --- per-graphic default palettes ------------------------------------
    # A monster's palette comes from the battle group it appears in
    # ($2E:$8400: pal1, pal2, then 4 monster ids), not from the graphic, so
    # pick the palette its battles most commonly use.
    pal1 = defaultdict(Counter)
    pal2 = defaultdict(Counter)
    for s in range(256):
        base = s * 6
        if base + 6 > len(sets):
            break
        a1, a2 = sets[base], sets[base + 1]
        for k in range(4):
            m = sets[base + 2 + k]
            if m == 0xFF:
                continue
            pal1[m][a1] += 1
            pal2[m][a2] += 1

    def dominant(counter, monster):
        return counter[monster].most_common(1)[0][0] if counter[monster] else None

    # palette pairs, per battle group: a group record is (pal1, pal2, ids x4) and
    # a monster's two palettes always come from the *same* group. Pairing the
    # most common pal1 with the most common pal2 across all monsters that share a
    # graphic produces a Frankenstein pair (Firefly rendered half in Icefly's
    # colours), so rank whole pairs instead.
    pairs = defaultdict(Counter)          # monster -> Counter[(pal1, pal2)]
    for s in range(256):
        base = s * 6
        if base + 6 > len(sets):
            break
        a1, a2 = sets[base], sets[base + 1]
        for k in range(4):
            m = sets[base + 2 + k]
            if m == 0xFF:
                continue
            pairs[m][(a1, a2)] += 1

    def palette_pair(users):
        """the (pal1, pal2) used by the most battles of any monster on this graphic"""
        pairs = palette_pairs(users)
        return pairs[0] if pairs else []

    def palette_pairs(users):
        """every (pal1, pal2) the battles of these monsters use, most common first.

        A monster's palette comes from its battle group, so the same graphic can
        appear in several colourings - Dark Cloud's forms, the elemental bosses,
        a monster and its palette-swapped boss. Each pair becomes one entry in
        the palette dropdown, so you can flip between them and paint whichever
        one you mean."""
        ranked = []
        for m in users:
            for (a1, a2), n in pairs[m].most_common():
                key = (a1, a2)
                if key in [k for k, _, _ in ranked]:
                    continue
                ranked.append((key, n, m))
        ranked.sort(key=lambda r: (-r[1], r[2]))
        out = []
        for (a1, a2), n, m in ranked[:8]:
            name = monster_name[m] or ('$%02X' % m)
            # with several pairs the dropdown would otherwise show the same
            # label over and over, so say which palettes each one is
            entry = [{'path': 'battlePalettes[%d]' % a1,
                      'name': '%s (1) #%d' % (name, a1), 'offset': 0, 'compose': True}]
            if a2 != a1:
                entry.append({'path': 'battlePalettes[%d]' % a2,
                              'name': '(2) #%d' % a2, 'offset': 4, 'compose': True})
            out.append(entry)
            # The game's own mapping is palette1 -> BG palette 0 and palette2 ->
            # BG palette 1 (2E/9DA2, 2E/9DAD), and the cell bits are inverted for
            # every id $80-$FF ($2E:$8F00). Reference rips disagree with that for
            # a few bosses, and since "exchange the two palettes" and "flip every
            # cell bit" produce the identical picture, offer the other reading as
            # a dropdown entry: one click, no mystery toggle.
            if a2 != a1:
                alt = [{'path': 'battlePalettes[%d]' % a2,
                        'name': '%s (1) #%d, swapped' % (name, a2),
                        'offset': 0, 'compose': True},
                       {'path': 'battlePalettes[%d]' % a1,
                        'name': '(2) #%d' % a1, 'offset': 4, 'compose': True}]
                out.append(alt)
        return out

    item_palettes = {}
    for cls, (key, begin, end, w, h, count) in enumerate(MONSTER_CLASSES):
        entries = []
        for i in range(count):
            users = [mid for mid, v in enumerate(props) if (v >> 5) == cls and (v & 0x1F) == i]
            entry = palette_pairs(users)
            entry.append({'path': 'battlePalettes'})
            entries.append(entry)
        item_palettes[key] = entries

    # --- battle character palettes: job -> sprite palette id --------------
    # 2E/9E4A: palette id per slot when the job is 0 (onion knight/freelancer)
    # 2E/9E4E: palette id per job id; ids 0-2 map to battle palettes $FC-$FE
    job_pal = data[mmc3_to_file(0x2E9E4A):mmc3_to_file(0x2E9E5A)]
    job_pal_by_id = data[mmc3_to_file(0x2E9E4E):mmc3_to_file(0x2E9E6E)]
    char_palettes = []
    for job in range(24):
        ids = []
        if job == 0:
            # the Onion Knight / Freelancer palette depends on the slot
            ids = sorted(set(job_pal[0:4]))
        elif job < len(job_pal_by_id):
            ids = [job_pal_by_id[job]]
        entry = [{'path': 'battlePalettes[%d]' % (0xFC + p)} for p in ids if p is not None]
        entry.append({'path': 'battlePalettes'})
        char_palettes.append(entry)

    # --- bosses ----------------------------------------------------------
    boss_pointers = data[mmc3_to_file(0x2E9068):mmc3_to_file(0x2E9098)]
    global SPARE_REGIONS
    SPARE_REGIONS = spare_regions()
    CLASSES_BY_KEY = {c[0]: c for c in MONSTER_CLASSES}
    bosses = []
    for i in range(24):
        lo, hi = boss_pointers[2 * i], boss_pointers[2 * i + 1]
        # the disassembly comment spells it out: bbs---tt tttttttt
        #   bits 7-6 = bank id, bit 5 = "this boss is a summon: load from the
        #   summon graphics bank and flip horizontally", bits 1-0 + byte 0 =
        #   a 10-bit tile index inside a 16 KiB window (an MMC3 bank pair)
        bank_id = (hi >> 6) & 3
        summon = (hi >> 5) & 1
        tile = ((hi & 3) << 8) | lo
        bank = 0x0C if summon else 0x20 + 2 * bank_id
        pool_file = bank * 0x2000 + tile * 16 + 0x10
        def_addr = None
        owner = None
        for mid, v in enumerate(props):
            if (v >> 5) == 6 and (v & 0x1F) == i:
                owner = mid
                break
        names_used = []
        owner_ids = [mid for mid, v in enumerate(props)
                     if (v >> 5) == 6 and (v & 0x1F) == i]
        for mid in owner_ids:
            n = monster_name[mid] or ('Monster $%02X' % mid)
            if n not in names_used:
                names_used.append(n)
        # every palette pair its battles use, so the forms can be switched
        entry = palette_pairs(owner_ids)
        entry.append({'path': 'battlePalettes'})
        # which class array physically contains this boss's tile pool, and at
        # what tile index. NOTE: the index must be computed in *file* space -
        # def-space addresses alias (only $8000-$9FFF address a bank's 8 KiB).
        # The tilemap bytes are PPU pattern indices with the pool at 0x70
        # (2F/A400 loads boss graphics at PPU $0700).
        # which assembly physically contains this boss's tile pool, and at what
        # tile index - always computed in *file* space, since def-space
        # addresses alias (only $8000-$9FFF address a bank's 8 KiB). The tilemap
        # bytes are PPU pattern indices with the pool at 0x70 (2F/A400 loads the
        # boss's 144 tiles at PPU $0700).
        # The size-class arrays do not tile the whole 64 KiB region: the unused
        # stretches between them are owned by monsterGraphicsSpareN assemblies,
        # and most boss pools live there.
        regions = [(c[0], mmc3_to_file(c[1]), mmc3_to_file(c[2])) for c in MONSTER_CLASSES]
        regions += SPARE_REGIONS
        # the two summon-backed bosses (bit 5 set) draw from the summon pool
        regions.append(('summonGraphics', 0x19810, 0x1A810))
        container = None
        for k, c0, c1 in regions:
            if c0 <= pool_file < c1:
                container = (k, (pool_file - c0) // 16)
                break
        # the boss's own 144 tiles inside the shared pool, in *decoded* bytes
        # (64 per NES 2bpp tile) - used as the graphics view's range. Clamped to
        # the container: the game always copies 144 tiles but a pool near the
        # end of the region has fewer than that available (and never uses them).
        poolBytes = None
        if container:
            c1 = [r[2] for r in regions if r[0] == container[0]][0]
            maxTiles = (c1 - (pool_file - container[1] * 16)) // 16
            tiles = min(0x90, maxTiles)
            poolBytes = (container[1] * 64, (container[1] + tiles) * 64)
        bosses.append({
            'index': i, 'pointer': (lo, hi), 'tile': tile, 'summon': summon,
            'bank': bank, 'defAddr': def_addr, 'owners': names_used,
            'container': container, 'tileOffset': (container[1] - 0x70) if container else None,
            # the boss's own 144 tiles inside the shared pool, in *decoded*
            # bytes (64 per NES 2bpp tile) - used as the graphics view's range
            'poolBytes': (container[1] * 64, (container[1] + 0x90) * 64) if container else None,
            'palette': entry,
        })

    # --- summons ---------------------------------------------------------
    # $2A:$9440, 8 records of 8 bytes (32/8CEF "summon animation"):
    #   0: graphics index (tile offset into the summon graphics bank $0C)
    #   1: first of three consecutive sprite palette ids
    #   4: size - high nibble = width, low nibble = height (in tiles)
    #   5: initial position - high nibble = x, low nibble = y (in tiles)
    #   6-7: little-endian pointer to the tilemap (bank 2A)
    SUMMON_NAMES = 0x609          # text id of summon 0's plain name
    summon_props = data[mmc3_to_file(0x2A9440):mmc3_to_file(0x2A9480)]
    bank2A_file = mmc3_to_file(0x2A8000)
    summons = []
    for i in range(8):
        p = summon_props[i * 8:i * 8 + 8]
        gfx_index = p[0]
        width, height = p[4] >> 4, p[4] & 0x0F
        cells = width * height
        map_file = bank2A_file + (p[6] | (p[7] << 8)) - 0x8000
        entry = [{'path': 'battlePalettes[%d]' % ((p[1] + k) & 0xFF),
                  'name': 'Sprite palette %d' % (k + 1), 'offset': k * 4}
                 for k in range(3)]
        for e in entry:
            e['compose'] = True
        entry.append({'path': 'battlePalettes'})
        summons.append({
            'index': i,
            'name': text(SUMMON_NAMES + i * 3) or ('Summon %i' % i),
            'gfxIndex': gfx_index, 'width': width, 'height': height,
            'cells': cells, 'mapFile': map_file,
            'mapBeginDef': file_to_def(map_file),
            'mapEndDef': file_to_def(map_file + cells),
            'propBeginDef': 0x2A9440 + i * 8,
            'palette': entry,
        })

    # --- per-graphic palette cells ---------------------------------------
    # $2E:$8F00-$2E:$9027 "monster attribute data": which of the two battle BG
    # palettes each 2x2 tile cell of a monster uses.  The bits are a stream read
    # MSB first (2F/A6FB), one bit per cell, cells walked row-major over the
    # *formation slot* the monster stands in (2F/A78D: X steps 2 across the slot
    # width, y steps 2 down the slot height), and 2F/A7D4 writes the bit into
    # that cell's quadrant of the nametable attribute byte.
    #
    # The record index is NOT `props & $3F`.  2F/A0E7 computes it as
    # (props & $1F) + a per-class offset, which is what makes the tables tile
    # perfectly with no gaps:
    #   class 0 (4x4)   id = gfx + $00  $8F20, 1 byte   -> $8F20-$8F2F
    #   class 1 (4x6)   id = gfx + $10  $8F20, 1 byte   -> $8F30-$8F47
    #   class 2 (6x6)   id = gfx + $00  $8F48, 2 bytes  -> $8F48-$8F77
    #   class 3 (6x6b)  id = gfx + $18  $8F48, 2 bytes  -> $8F78-$8FA7
    #   class 4 (6x12)  id = gfx + $00  $8FA8, 3 bytes  -> $8FA8-$8FB3
    #   class 5 (12x6)  id = gfx + $00  $8FB4, 3 bytes  -> $8FB4-$8FBF
    #   class 6 (boss)  id = tilemap    $8FC0, 7 bytes  -> $8FC0-$9027
    # (2F/A8D8/2F/A8E4 give the base and size per class; the boss path is
    # 2F/A820, taken when the formation type is 9 - 18x12 tiles, 9x6 = 54 cells
    # in 7 bytes - and the record ends exactly at the boss pointer table.)
    #
    # $2E:$8F00 is one bit per *monster id* meaning "invert this monster's cell
    # bits" (2F/A89C AND #$80 -> 2F/A8BF EOR #$FF). The bit is selected by a
    # shift loop (see invert_flag), not by a plain bit index. In this ROM the
    # flag is set for every id $80-$FF whose (id & 7) != 7, and for no id below
    # $80 - so a boss normally shows the two palettes swapped relative to the
    # ordinary monster sharing its graphic, with 16 exceptions.
    #
    # A 4x4 monster stands in a 4x6 formation slot: its tiles load at PPU
    # $0780 while the slot's first tile id is $70 (2F/A2D0, 2F/A4A4), so the
    # first cell row of the record describes the empty row above the sprite and
    # the sprite's cells are bits 2-5.
    ATTR_BASE  = [0x2E8F20, 0x2E8F20, 0x2E8F48, 0x2E8F48, 0x2E8FA8, 0x2E8FB4]
    ATTR_SIZE  = [1, 1, 2, 2, 3, 3]
    ATTR_IDOFF = [0, 0x10, 0, 0x18, 0, 0]
    ATTR_SLOT  = {0: (4, 6)}          # class -> slot size when it is not the graphic size
    ATTR_INVERT = 0x2E8F00           # 32 bytes, one bit per monster id
    ATTR_TABLE  = (0x2E8F00, 0x2E8FC0)
    BOSS_ATTR_TABLE = (0x2E8FC0, 0x2E9028)
    invert_flags = data[mmc3_to_file(ATTR_INVERT):mmc3_to_file(ATTR_INVERT + 0x20)]

    def invert_flag(mid):
        # 2F/A133-2F/A141: the loop reloads $8F00[id>>3] and ASLs it (id&7)+1
        # times, then 2F/A141 tests bit 7 of what is left in A - so the flag is
        # bit (6 - (id&7)) of that byte, and always 0 when id&7 == 7.
        k = (mid & 7) + 1
        return ((invert_flags[mid >> 3] << k) >> 7) & 1

    def attr_addr(cls, props_byte):
        """address (file) of a graphic's cell record"""
        attr_id = (props_byte & 0x1F) + ATTR_IDOFF[cls]
        return mmc3_to_file(ATTR_BASE[cls]) + attr_id * ATTR_SIZE[cls]

    def cell_bits(addr, nbytes, ncells):
        blob = data[addr:addr + nbytes]
        return ''.join(str((blob[k // 8] >> (7 - (k % 8))) & 1) if k // 8 < len(blob) else '0'
                       for k in range(ncells))

    def attr_ref(cls, props_byte, w, h):
        """the cell map of one size-class graphic, as the view wants it"""
        sw, sh = ATTR_SLOT.get(cls, (w, h))
        cells = (sw // 2) * (sh // 2)
        skip = ((sh - h) // 2) * (sw // 2)     # slot rows above the sprite
        addr = attr_addr(cls, props_byte)
        return {'cells': cell_bits(addr, ATTR_SIZE[cls], cells),
                'offset': skip,
                'bytes': ATTR_SIZE[cls],
                'index': addr - mmc3_to_file(ATTR_TABLE[0])}

    item_attrs = {}
    for cls, (key, begin, end, w, h, count) in enumerate(MONSTER_CLASSES):
        entries = []
        for i in range(count):
            users = [mid for mid, v in enumerate(props) if (v >> 5) == cls and (v & 0x1F) == i]
            users.sort(key=lambda m: (-sum(pal1[m].values()), m))
            if not users:
                entries.append('')
                continue
            ref = attr_ref(cls, props[users[0]], w, h)
            ref['invert'] = bool(invert_flag(users[0]))
            ref['path'] = 'monsterAttributeData'
            entries.append(ref)
        item_attrs[key] = entries

    # boss tilemap cell maps: 7 bytes per tilemap index at $2E:$8FC0
    boss_attrs = []
    for i in range(24):
        owner_ids = [mid for mid, v in enumerate(props)
                     if (v >> 5) == 6 and (v & 0x1F) == i]
        owner_ids.sort(key=lambda m: (-sum(pal1[m].values()), m))
        addr = mmc3_to_file(BOSS_ATTR_TABLE[0]) + i * 7
        boss_attrs.append({
            'cells': cell_bits(addr, 7, 9 * 6),
            'offset': 0,
            'bytes': 7,
            'index': i,
            'invert': bool(invert_flag(owner_ids[0])) if owner_ids else False,
            'path': 'bossAttributeData',
        })

    # labels for the two attribute tables, so editing a byte says what it is
    attr_names = {}
    for b in range(32):
        attr_names[b] = 'Invert flag: monsters $%02X-$%02X' % (b * 8, b * 8 + 7)
    cls_of_byte = []
    for cls in range(6):
        n = ATTR_SIZE[cls]
        count = {0: 16, 1: 24, 2: 24, 3: 24, 4: 4, 5: 4}[cls]
        base = mmc3_to_file(ATTR_BASE[cls]) - mmc3_to_file(ATTR_TABLE[0]) + \
               ATTR_IDOFF[cls] * n
        for i in range(count):
            for k in range(n):
                label = '%s #%d cells' % ({0: '4x4', 1: '4x6', 2: '6x6', 3: '6x6b',
                                           4: '6x12', 5: '12x6'}[cls], i)
                if n > 1:
                    label += ' (byte %d)' % (k + 1)
                attr_names[base + i * n + k] = label
    for i in range(24, 192):
        attr_names.setdefault(i, 'Unused %d' % i)

    result = {'tables': tables, 'itemPalettes': item_palettes,
              'itemAttributes': item_attrs, 'bossAttributes': boss_attrs,
              'attributeTable': {'begin': ATTR_TABLE[0], 'end': ATTR_TABLE[1],
                                 'names': attr_names},
              'bossAttributeTable': {'begin': BOSS_ATTR_TABLE[0],
                                     'end': BOSS_ATTR_TABLE[1]},
              'charPalettes': char_palettes, 'bosses': bosses,
              'summons': summons, 'spareRegions': SPARE_REGIONS,
              'monsterName': monster_name, 'jobName': job_name}
    return result


if __name__ == '__main__':
    r = main()
    tables, monster_name, job_name = r['tables'], r['monsterName'], r['jobName']
    for key, table in tables.items():
        print('=== %s (%d strings)' % (key, len(table['string'])))
        for i in sorted(table['string'], key=int)[:6]:
            print('   %3s: %s' % (i, table['string'][i]))
    print()
    print('monster 0-9:', ', '.join(monster_name[:10]))
    print('jobs      :', ', '.join(job_name))
    print()
    for key, entries in r['itemPalettes'].items():
        print('%-20s palettes: %s' % (key, [e[0]['path'] if e and 'path' in e[0] else '-' for e in entries[:8]]))
    print('character palettes:', [e[0]['path'] for e in r['charPalettes'][:8]])
    print()
    for b in r['bosses'][:6]:
        print('boss %2d def=%06X %s tileOffset=%s owners=%s' %
              (b['index'], b['defAddr'], b['container'], b['tileOffset'], b['owners']))
