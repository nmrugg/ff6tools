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
                if n not in names:
                    names.append(n)
            if names:
                shown = names[:3]
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
            # prefer a user that actually appears in a battle group
            users.sort(key=lambda m: (not pal1[m], m))
            picks = []
            for m in users:
                for p in (dominant(pal1, m), dominant(pal2, m)):
                    if p is not None and p not in picks:
                        picks.append(p)
                if picks:
                    break
            entry = [{'path': 'battlePalettes[%d]' % p} for p in picks]
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
    CLASSES_BY_KEY = {c[0]: c for c in MONSTER_CLASSES}
    bosses = []
    for i in range(24):
        lo, hi = boss_pointers[2 * i], boss_pointers[2 * i + 1]
        tile = ((hi & 3) << 8) | lo
        summon = (hi >> 2) & 1
        bank = 0x0C if summon else (hi & 3) * 2 + 0x20
        def_addr = bank * 0x10000 + 0x8000 + tile * 16
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
        entry = [{'path': 'battlePalettes[%d]' % p} for p in
                 (dominant(pal1, owner), dominant(pal2, owner))
                 if owner is not None and p is not None]
        entry.append({'path': 'battlePalettes'})
        # which class array physically contains this boss's tile pool, and at
        # what tile index. NOTE: the index must be computed in *file* space -
        # def-space addresses alias (only $8000-$9FFF address a bank's 8 KiB).
        # The tilemap bytes are PPU pattern indices with the pool at 0x70
        # (2F/A400 loads boss graphics at PPU $0700).
        pool_file = mmc3_to_file(def_addr)
        container = None
        for c in MONSTER_CLASSES:
            c0, c1 = mmc3_to_file(c[1]), mmc3_to_file(c[2])
            if c0 <= pool_file < c1:
                container = (c[0], (pool_file - c0) // 16)
                break
        bosses.append({
            'index': i, 'pointer': (lo, hi), 'tile': tile, 'summon': summon,
            'bank': bank, 'defAddr': def_addr, 'owners': names_used,
            'container': container, 'tileOffset': (container[1] - 0x70) if container else None,
            'palette': entry,
        })

    result = {'tables': tables, 'itemPalettes': item_palettes,
              'charPalettes': char_palettes, 'bosses': bosses,
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
