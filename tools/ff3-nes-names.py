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
                # bosses first: they are what someone hunting a boss is looking for
                names.sort(key=lambda n: (not n.startswith('*'), n))
                shown = names[:4]
                extra = ' +%d' % (len(names) - len(shown)) if len(names) > len(shown) else ''
                strings[str(i)] = ', '.join(shown) + extra
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

    item_palettes = {}
    for cls, (key, begin, end, w, h, count) in enumerate(MONSTER_CLASSES):
        entries = []
        for i in range(count):
            users = [mid for mid, v in enumerate(props) if (v >> 5) == cls and (v & 0x1F) == i]
            # A monster is drawn with TWO palettes (bg palette 0 = palette1 and
            # bg palette 1 = palette2 of its battle group; $2E:$8F20 picks one
            # per 2x2 cell). Rank the palettes used by every monster that shares
            # this graphic so the relevant ones come first.
            rank = Counter()
            who = defaultdict(set)
            for m in users:
                for slot, counter in ((0, pal1), (1, pal2)):
                    for pid, n in counter[m].items():
                        rank[pid] += n
                        who[pid].add(m)
            ordered = sorted(rank, key=lambda pid: (-rank[pid], pid))[:2]
            entry = []
            for n, pid in enumerate(ordered):
                label = ', '.join(sorted((monster_name[m] or ('$%02X' % m)) for m in who[pid]))
                entry.append({'path': 'battlePalettes[%d]' % pid,
                              'name': '%s (%d)' % (label[:46], n + 1),
                              'offset': n * 4})
            if len(entry) == 2:
                # compose both palettes into one 8-colour palette: the panel
                # shows two rows and clicking a row switches the sprite over
                entry[0]['compose'] = True
                entry[1]['compose'] = True
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
        for mid, v in enumerate(props):
            if (v >> 5) == 6 and (v & 0x1F) == i:
                n = monster_name[mid] or ('Monster $%02X' % mid)
                if n not in names_used:
                    names_used.append(n)
        # same two-palette model as ordinary monsters: rank the palettes used by
        # every boss that shares this tilemap
        rank = Counter()
        who = defaultdict(set)
        owner_ids = [mid for mid, v in enumerate(props)
                     if (v >> 5) == 6 and (v & 0x1F) == i]
        for m in owner_ids:
            for counter in (pal1, pal2):
                for pid, n in counter[m].items():
                    rank[pid] += n
                    who[pid].add(m)
        ordered = sorted(rank, key=lambda pid: (-rank[pid], pid))[:2]
        entry = []
        for k, pid in enumerate(ordered):
            label = ', '.join(sorted((monster_name[m] or ('$%02X' % m)) for m in who[pid]))
            entry.append({'path': 'battlePalettes[%d]' % pid,
                          'name': '%s (%d)' % (label[:46], k + 1),
                          'offset': k * 4, 'compose': True})
        if len(entry) < 2:
            for e in entry:
                e.pop('compose', None)
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
    # $2E:$8F20 "monster attribute data": which of the two battle palettes each
    # 2x2 tile cell uses. 2F/A8D8 gives the table base per class, 2F/A8E4 the
    # bytes per monster, and the id is (props & $3F) - note bit 5 belongs to the
    # id, so classes 0/1 and 2/3 share bases with different id ranges.
    # 2F/A6FB reads the bits MSB-first, 2F/A78D walks cells row-major
    # (ceil(w/2) columns, ceil(h/2) rows).
    ATTR_BASE = [0x2E8F20, 0x2E8F20, 0x2E8F48, 0x2E8F48, 0x2E8FA8, 0x2E8FB4]
    ATTR_SIZE = [1, 1, 2, 2, 3, 3]

    def attr_cells(props_byte, cls, w, h):
        addr = mmc3_to_file(ATTR_BASE[cls]) + (props_byte & 0x3F) * ATTR_SIZE[cls]
        blob = data[addr:addr + ATTR_SIZE[cls]]
        cols, rows = (w + 1) // 2, (h + 1) // 2
        cells = []
        for k in range(cols * rows):
            byte = blob[k // 8] if k // 8 < len(blob) else 0
            cells.append((byte >> (7 - (k % 8))) & 1)
        return ''.join(str(c) for c in cells)

    item_attrs = {}
    for cls, (key, begin, end, w, h, count) in enumerate(MONSTER_CLASSES):
        entries = []
        for i in range(count):
            users = [mid for mid, v in enumerate(props) if (v >> 5) == cls and (v & 0x1F) == i]
            users.sort(key=lambda m: (-sum(pal1[m].values()), m))
            entries.append(attr_cells(props[users[0]], cls, w, h) if users else '')
        item_attrs[key] = entries

    result = {'tables': tables, 'itemPalettes': item_palettes,
              'itemAttributes': item_attrs,
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
