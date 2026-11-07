#!/usr/bin/env python3
# tools/ff4-sfc-names.py
#
# Adds (or refreshes) the FF4 SNES battle graphics model in a definition
# file, computing everything from the ROM itself:
#
#   * monsterGraphics becomes a pointer-deduplicated array of graphics
#     objects (one per unique graphics pointer in monsterGraphicsProperties),
#     exactly like the FF6 definitions already do
#   * graphicsPointer gains "offset" + "pointerTo" so the tool resolves
#     pointers to array items
#   * sizeFrom specs give each object its display width/height (from the
#     monster size table, or the boss properties record for bosses) and its
#     per-object graphics format (snes3bpp / snes4bpp from the is3bpp flag)
#   * itemPalettes pins each object to the palette its own monsters use
#     (4bpp objects compose palette[p] colors 0-7 with palette[p+1] colors
#     8-15, the way the game loads them); every other palette a user monster
#     has is offered in the dropdown, plus the whole monsterPalette array
#   * string tables: every graphics object is labelled with the monster
#     names that use it (bosses first, marked with *), and every monster
#     palette with the monsters that use it
#
#   python3 tools/ff4-sfc-names.py --def ff4/ff2u-sfc.json --rom "Final Fantasy II (USA).sfc"
#
# Re-running is idempotent: the assembly is rebuilt from scratch each time.

import argparse, json, sys

def loROM_map(a):
    return ((a & 0xFF0000) >> 1) + (a & 0x7FFF)

# FF4 name encoding: A-Z = 0x42-0x5B, a-z = 0x5C-0x75, 0xC1 = "'", 0xC2 = ' ',
# 0xFF = pad (derived from the ROM's own strings: Imp, Basilisk, Kainazzo...)
def decode_name(raw):
    s = ''
    for b in raw:
        if b == 0xFF:
            break
        if 0x42 <= b <= 0x5B: s += chr(ord('A') + b - 0x42)
        elif 0x5C <= b <= 0x75: s += chr(ord('a') + b - 0x5C)
        elif b == 0xC1: s += "'"
        elif b == 0xC2: s += ' '
        else: s += '?'
    return s.rstrip()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--def', dest='definition', required=True)
    ap.add_argument('--rom', required=True)
    args = ap.parse_args()

    rom = open(args.rom, 'rb').read()
    defj = json.load(open(args.definition))
    asm = defj['assembly']

    # ---- required existing assemblies -------------------------------------
    props_def = asm['monsterGraphicsProperties']
    blob_def  = asm['monsterGraphics']
    sizes_def = asm['monsterSize']
    boss_def  = asm['monsterBossProperties']
    pal_def   = asm['monsterPalette']
    name_def  = asm['monsterName']

    blob_begin = int(blob_def['range'].split('-')[0], 16) if 'range' in blob_def \
        else int(blob_def['itemRanges'][0].split('-')[0], 16)
    blob_end = int(blob_def['range'].split('-')[1], 16) if 'range' in blob_def \
        else int(blob_def['itemRanges'][-1].split('-')[1], 16)
    props_f  = loROM_map(int(props_def['range'].split('-')[0], 16))
    sizes_f  = loROM_map(int(sizes_def['range'].split('-')[0], 16))
    boss_f   = loROM_map(int(boss_def['range'].split('-')[0], 16))
    names_f  = loROM_map(int(name_def['range'].split('-')[0], 16))
    nprops   = props_def['array']['length']
    nboss    = boss_def['array']['length']
    npal     = pal_def['array']['length']

    blob_begin_f = loROM_map(blob_begin)
    blob_end_f   = loROM_map(blob_end)

    # ---- read the tables ---------------------------------------------------
    names = [decode_name(rom[names_f+i*8:names_f+i*8+8]) for i in range(nprops)]

    recs = []
    for i in range(nprops):
        b0, b1, lo, hi = rom[props_f+i*4:props_f+i*4+4]
        w2 = lo | (hi << 8)
        recs.append(dict(i=i, size=b0 & 0x3F, isChar=bool(b0 & 0x40),
                         isBoss=bool(b0 & 0x80), pal=b1,
                         ptr=(w2 & 0x7FFF) * 8, bpp3=bool(w2 & 0x8000)))

    # ---- unique pointers, ascending -> array item order --------------------
    offsets = sorted(set(r['ptr'] for r in recs))
    item_of = {off: k for k, off in enumerate(offsets)}
    users = {off: [] for off in offsets}
    for r in recs:
        users[r['ptr']].append(r)

    def size_tiles(si):
        w, h = rom[sizes_f + si*2], rom[sizes_f + si*2 + 1]
        return w, h

    # ---- battle VRAM map: largest tile count loaded per monster ----------
    # (boss graphics load a per-battle tile count, not width*height)
    battle_def = asm['battleProperties']
    vram_def = asm['battleVRAMMap']
    bp_f = loROM_map(int(battle_def['range'].split('-')[0], 16))
    bp_e = loROM_map(int(battle_def['range'].split('-')[1], 16))
    nbat = battle_def['array']['length']
    rec_len = (bp_e - bp_f) // nbat
    vmp_f = loROM_map(int(vram_def['range'].split('-')[0], 16))
    nmaps = vram_def['assembly']['bossTileCount']['array']['length']
    max_tc = {}
    for b in range(nbat):
        rec = rom[bp_f + b*rec_len: bp_f + b*rec_len + rec_len]
        v = rec[0] & 0x07
        if v >= nmaps:
            continue
        for s in range(3):
            mo = rec[1 + s]
            if mo == 0xFF:
                continue
            tc = rom[vmp_f + v*8 + s*2] | (rom[vmp_f + v*8 + s*2 + 1] << 8)
            if tc > max_tc.get(mo, 0):
                max_tc[mo] = tc

    # ---- sanity ------------------------------------------------------------
    blob_len = blob_end_f - blob_begin_f
    for k, off in enumerate(offsets):
        end = offsets[k+1] if k+1 < len(offsets) else blob_len
        for r in users[off]:
            if r['isChar'] or r['isBoss']:
                # bosses load a per-battle tile count that may run past the
                # pool; the game reads whatever is there, the editor owns the
                # gap and the battle VRAM viewer reads raw ROM bytes
                continue
            if r['isBoss']:
                bi = r['size']
                tw, th = size_tiles(rom[boss_f + bi*5 + 1] & 0x3F)
            else:
                tw, th = size_tiles(r['size'])
            need = tw * th * (24 if r['bpp3'] else 32)
            if need > (end - off):
                sys.exit(f'monster {r["i"]}: graphics needs {need} bytes but only {end-off} available')
    for off in offsets:
        fmts = set(r['bpp3'] for r in users[off] if not r['isChar'])
        if len(fmts) > 1:
            sys.exit(f'pointer {off:#x}: users disagree on 3bpp flag')

    # ---- palette pinning ----------------------------------------------------
    def pal_index(r):
        if r['isBoss']:
            return rom[boss_f + r['size']*5 + 2]
        return r['pal']

    itemPalettes = []
    for off in offsets:
        us = [r for r in users[off] if not r['isChar']]
        if not us:
            us = users[off]
        bpp3 = us[0]['bpp3']
        # order palette choices: bosses first, then by monster id; dedupe
        order = sorted(us, key=lambda r: (0 if r['isBoss'] else 1, r['i']))
        defs, seen = [], set()
        for r in order:
            p = pal_index(r)
            if p in seen or p >= npal:
                continue
            seen.add(p)
            label = names[r['i']] + (' (boss)' if r['isBoss'] else '')
            if bpp3:
                defs.append({'path': f'monsterPalette[{p}]',
                             'range': '0-8',
                             'name': f'{p}: {label}'})
            else:
                # 4bpp: colors 0-7 from palette p, 8-15 from palette p+1
                q = min(p + 1, npal - 1)
                defs.append({'path': f'monsterPalette[{p}]',
                             'range': '0-8', 'offset': 0,
                             'compose': True, 'name': f'{p}+{q}: {label}'})
                defs.append({'path': f'monsterPalette[{q}]',
                             'range': '0-8', 'offset': 8,
                             'compose': True, 'name': f'{p}+{q}: {label}'})
        defs.append({'path': 'monsterPalette'})
        itemPalettes.append(defs)

    # ---- labels -------------------------------------------------------------
    strings = {}
    for k, off in enumerate(offsets):
        us = [r for r in users[off] if not r['isChar']]
        bosses = sorted(set(names[r['i']] for r in us if r['isBoss']))
        others = sorted(set(names[r['i']] for r in us if not r['isBoss']))
        label = ', '.join(['*' + b for b in bosses] + others)
        strings[k] = label or f'Monster Graphics {k}'

    # monster palette names: which monsters use each palette
    pal_users = [[] for _ in range(npal)]
    for r in recs:
        if r['isChar']:
            continue
        p = pal_index(r)
        if p < npal:
            tag = '*' + names[r['i']] if r['isBoss'] else names[r['i']]
            if tag not in pal_users[p]:
                pal_users[p].append(tag)
    pal_strings = {str(p): ', '.join(pal_users[p]) for p in range(npal) if pal_users[p]}

    # ---- write the definition ----------------------------------------------
    #
    # The graphics are a fragmented array: each object owns exactly its own
    # bytes (capped at the next pointer, and at the largest tile count any
    # battle loads for it), so unrelated data that lives *between* graphics
    # blocks in bank 0d (map sprite palettes etc.) keeps its own owner and
    # nothing is ever double-owned or destroyed on repack.
    #
    # Pointers address the region linearly in FILE space from the array base,
    # so the array is "isMapped": false and graphicsPointer.offset is the file
    # address of the region start.
    def unmap(file_addr):
        bank = (file_addr << 1) & 0xFF0000
        return bank | (file_addr & 0x7FFF) | 0x8000

    base_f = loROM_map(blob_begin)

    # largest load any user performs at this pointer, in bytes
    max_load = {}
    for r in recs:
        if r['isChar']:
            continue
        by = 24 if r['bpp3'] else 32
        if r['isBoss']:
            si = rom[boss_f + r['size']*5 + 1] & 0x3F
            tw, th = size_tiles(si)
            tiles = max(max_tc.get(r['i'], 0), tw * th)
        else:
            tw, th = size_tiles(r['size'])
            tiles = tw * th
        max_load[r['ptr']] = max(max_load.get(r['ptr'], 0), tiles * by)

    # other assemblies' file ranges: an item may never swallow them
    others = []
    for key, v in asm.items():
        if key == 'monsterGraphics' or not isinstance(v, dict):
            continue
        r = v.get('range')
        if not r:
            continue
        b, e = [int(x, 16) for x in r.split('-')]
        others.append((key, loROM_map(b), loROM_map(e)))
    # sub-ranges of the properties tables etc. too: everything except our own
    others.sort(key=lambda t: t[1])

    item_ranges = []
    for k, off in enumerate(offsets):
        nxt = offsets[k+1] if k+1 < len(offsets) else None
        lo = base_f + off
        end = off + max_load[off]
        if nxt is not None:
            end = min(end, nxt)
        # cap at the start of the next foreign assembly after this item
        for key, ob, oe in others:
            if ob >= lo and ob < base_f + end:
                end = ob - base_f
        hi = base_f + end
        # verify disjoint ownership
        for key, ob, oe in others:
            if lo < oe and ob < hi:
                sys.exit(f'item {k} [{lo:#x},{hi:#x}) overlaps {key} [{ob:#x},{oe:#x})')
        # every non-boss user must fit entirely
        for r in recs:
            if r['isChar'] or r['isBoss'] or r['ptr'] != off:
                continue
            tw, th = size_tiles(r['size'])
            need = tw * th * (24 if r['bpp3'] else 32)
            if need > hi - lo:
                sys.exit(f'item {k}: monster {r["i"]} needs {need} bytes, only {hi-lo}')
        item_ranges.append('0x%06X-0x%06X' % (unmap(lo), unmap(hi)))

    asm['monsterGraphics'] = {
        'type': 'array',
        'name': 'Monster Graphics',
        'isFragmented': True,
        'canRelocate': False,
        'isMapped': False,
        'array': {'length': len(offsets)},
        'itemRanges': item_ranges,
        'assembly': {
            'type': 'graphics',
            'name': 'Monster Graphics',
            'align': 8,
            'canRelocate': False,
            'palette': 'monsterPalette'
        },
        'pointerObject': {
            'arrayPath': 'monsterGraphicsProperties',
            'pointerPath': 'graphicsPointer'
        },
        'sizeFrom': [
            {
                'arrayPath': 'monsterGraphicsProperties',
                'pointerPath': 'graphicsPointer',
                'condition': '!record.isCharacter.value && !record.isBoss.value',
                'sizeIndexProp': 'size',
                'sizeArrayPath': 'monsterSize',
                'width': 'width',
                'height': 'height',
                'formatProp': 'is3bpp',
                'formats': ['snes4bpp', 'snes3bpp']
            },
            {
                'arrayPath': 'monsterGraphicsProperties',
                'pointerPath': 'graphicsPointer',
                'condition': 'record.isBoss.value',
                'indexProp': 'bossProperties',
                'indexArrayPath': 'monsterBossProperties',
                'noSize': True,
                'formatProp': 'is3bpp',
                'formats': ['snes4bpp', 'snes3bpp']
            }
        ],
        'itemPalettes': itemPalettes,
        'stringTable': {
            'length': len(offsets),
            'default': 'Monster Graphics %i',
            'string': strings
        }
    }

    # graphicsPointer: a real pointer into monsterGraphics. The offset is the
    # file address of the graphics region because FF4 loROM graphics pointers
    # address the region linearly in file space ("isMapped": false above).
    gp = props_def['assembly']['assembly']['graphicsPointer']
    gp['offset'] = hex(base_f)
    gp['pointerTo'] = 'monsterGraphics'

    # monster palette names
    pal_def['stringTable'] = {
        'length': npal,
        'default': 'Monster Palette %i',
        'string': pal_strings
    }

    # hierarchy: expose everything in the tree
    def ensure(section, name, path):
        for sec in defj['hierarchy']:
            if sec.get('name') == section:
                for item in sec['list']:
                    if item.get('path') == path:
                        return
                sec['list'].append({'name': name, 'path': path})
                return
        sys.exit(f'hierarchy section {section} not found')
    ensure('Monster', 'Monster Graphics', 'monsterGraphics')
    ensure('Monster', 'Monster Graphics Properties', 'monsterGraphicsProperties')
    ensure('Monster', 'Monster Palettes', 'monsterPalette')
    ensure('Battle', 'Boss Graphics Properties', 'monsterBossProperties')
    ensure('Battle', 'Boss Graphics Maps', 'monsterBossMap')

    json.dump(defj, open(args.definition, 'w'), indent=4)
    print(f'{args.definition}: {len(offsets)} graphics objects, '
          f'{sum(1 for r in recs if r["isBoss"])} boss records, '
          f'{len(pal_strings)} named palettes')

if __name__ == '__main__':
    main()
