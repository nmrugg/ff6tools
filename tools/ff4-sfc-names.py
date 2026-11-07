#!/usr/bin/env python3
# tools/ff4-sfc-names.py
#
# Adds (or refreshes) the FF4 SNES battle graphics model in a definition
# file, computing everything from the ROM itself:
#
#   * monsterGraphics becomes a fragmented array of 90ish graphics objects
#     (one per unique pointer in monsterGraphicsProperties), each owning
#     exactly its own bytes (capped so unrelated data in bank 0d keeps its
#     own owner)
#   * per-object display size from the monster size table (or the boss
#     properties record for bosses), per-object format from the is3bpp flag
#   * palettes: the game indexes the ROM palette table in 16-byte
#     sub-palette units (LoadMonsterPal reads 32 bytes from MonsterPal+p*16),
#     while the definition models 32-byte entries; each object is pinned to
#     the right entry and half-offset, composing a pair when p is odd
#   * boss graphics are assembled views: for every boss properties record
#     in use, a window object (bossGraphics_<n>) shows the boss's tile pool
#     laid out by its tile map (0xFF = empty, 0xFE n = n empty cells), which
#     is what the game places into VRAM - the creature, not loose tiles
#   * string tables: every graphics object is labelled with the monster
#     names that use it (bosses first, marked *), every palette with its
#     users, and known summon/Esper aliases are appended (Ifrit, Mindflayer,
#     Dragon Mist...) so summons are findable by name
#
#   python3 tools/ff4-sfc-names.py --def ff4/ff2u-sfc.json \
#           --rom "/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc"
#
# Re-running is idempotent: the assemblies are rebuilt from scratch each time.

import argparse, json, os, sys

def loROM_map(a):
    return ((a & 0xFF0000) >> 1) + (a & 0x7FFF)

def unmap(file_addr):
    bank = (file_addr << 1) & 0xFF0000
    return bank | (file_addr & 0x7FFF) | 0x8000

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

# Esper/summon aliases by monster id, so summoning Espers that reuse boss or
# monster art are findable by their summon name (ff4monsters.zip confirms
# which art belongs to which Esper)
ESPER_ALIAS = {
    0:   'Imp',
    27:  'Imp',
    36:  'Cockatrice',
    63:  'Mindflayer',
    85:  'Bomb',
    152: 'Wyvern',
    161: 'Dragon Mist',
    174: 'Ifrit',
    188: 'Odin',
    189: 'Leviathan',
    190: 'Bahamut',
    192: 'Asura',
    207: 'Titan',
}

# Summon tables, read straight from the ROM (btlgfx_data.asm: SummonGfxPtrs
# at 0x0d87f0, SummonPalTbl at 0x0dfe4c; LoadSummonGfx indexes them by
# attack-$4d). Names per the MagicAnim_* comments in btlgfx/magic.asm.
SUMMON_PTRS_F  = 0x687f0
SUMMON_PAL_F   = 0x6fe4c
SUMMON_NAMES   = ['Imp', 'Bomb', 'Cockatrice', 'Mindflayer', 'Chocobo',
                  'Shiva', 'Ramuh', 'Ifrit', 'Titan', 'Dragon Mist',
                  'Sylph', 'Odin', 'Leviathan', 'Asura', 'Asura', 'Asura',
                  'Bahamut']
# summon graphics (bank 0d) ends here (rom map: 0d8818-0de817)
SUMMON_GFX_END = 0x6e818
# monster graphics banks 1-4 end here (rom map: "final zeromus graphics"
# ends 0cb2f7; 0cb2f8-0cb6bf is unused)
MONSTER_GFX_END = 0x632f8

# Boss window fixes:
#  - Mom Bomb (record 164): the US properties entry (bossProps 36) places a
#    4x4 grid over the top-left of a 60-tile LINEAR sheet, so the assembled
#    view crops her head off. The full arrangement below was reconstructed
#    from ff4monsters.zip by exact tile-mask matching (every cell matched at
#    IoU 1.00, all 60 pool tiles used exactly once); no ROM map contains it
#    (it is the JP version's arrangement).
#  - Dummy (record 214): a placeholder that reuses Wyvern's properties over
#    the Zeromus pool; the game never draws it. Skip the window.
SHEET_BOSSES = {164: dict(width=10, tiles=60, pal=164, layout=[
    -1,  0,  1,  2,  3,  4,  5,  6,  7,  8,
     9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
    19, 20, 21, 22, 23, 24, 25, 26, 20, 27,
    28, 20, 29, 30, 31, 32, 33, 34, 20, 35,
    36, 46, 20, 20, 37, 38, 20, 39, 40, 41,
    42, 43, 20, 20, 20, 20, 20, 20, 44, -1,
    45, 46, 20, 20, 20, 47, 48, 49, -1, 50,
    51, 20, 38, 52, 53, 54, -1, -1, -1, 55,
    56, 57, 58, 59, -1, -1, -1, -1, -1, -1])}
SKIP_BOSSES  = {214}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--def', dest='definition', required=True)
    ap.add_argument('--rom', required=True)
    args = ap.parse_args()

    rom = open(args.rom, 'rb').read()
    defj = json.load(open(args.definition))
    asm = defj['assembly']

    props_def = asm['monsterGraphicsProperties']
    blob_def  = asm['monsterGraphics']
    sizes_def = asm['monsterSize']
    boss_def  = asm['monsterBossProperties']
    pal_def   = asm['monsterPalette']
    name_def  = asm['monsterName']
    bmap_def  = asm['monsterBossMap']
    battle_def = asm['battleProperties']
    vram_def  = asm['battleVRAMMap']

    blob_begin = int(blob_def['range'].split('-')[0], 16) if 'range' in blob_def \
        else int(blob_def['itemRanges'][0].split('-')[0], 16)
    props_f  = loROM_map(int(props_def['range'].split('-')[0], 16))
    sizes_f  = loROM_map(int(sizes_def['range'].split('-')[0], 16))
    boss_f   = loROM_map(int(boss_def['range'].split('-')[0], 16))
    names_f  = loROM_map(int(name_def['range'].split('-')[0], 16))
    nprops   = props_def['array']['length']
    npal     = pal_def['array']['length']

    base_f = loROM_map(blob_begin)

    # ---- read the tables ---------------------------------------------------
    names = [decode_name(rom[names_f+i*8:names_f+i*8+8]) for i in range(nprops)]

    recs = []
    for i in range(nprops):
        b0, b1, lo, hi = rom[props_f+i*4: props_f+i*4+4]
        w2 = lo | (hi << 8)
        recs.append(dict(i=i, size=b0 & 0x3F, isChar=bool(b0 & 0x40),
                         isBoss=bool(b0 & 0x80), pal=b1,
                         ptr=(w2 & 0x7FFF) * 8, bpp3=bool(w2 & 0x8000)))

    offsets = sorted(set(r['ptr'] for r in recs))
    item_of = {off: k for k, off in enumerate(offsets)}
    users = {off: [] for off in offsets}
    for r in recs:
        users[r['ptr']].append(r)

    def size_tiles(si):
        return rom[sizes_f + si*2], rom[sizes_f + si*2 + 1]

    # ---- battle VRAM map: largest tile count loaded per monster ------------
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

    # ---- boss tile maps -----------------------------------------------------
    bmap_ptr_f = loROM_map(int(bmap_def['pointerTable']['range'].split('-')[0], 16))
    bmap_base  = int(bmap_def['pointerTable']['offset'], 16)
    nbmaps = bmap_def['array']['length']
    bmap_offs = []
    for i in range(nbmaps):
        p = rom[bmap_ptr_f + i*2] | (rom[bmap_ptr_f + i*2 + 1] << 8)
        bmap_offs.append(loROM_map(bmap_base + p))
    bmap_end = loROM_map(int(bmap_def['range'].split('-')[1], 16))

    # ---- sanity -------------------------------------------------------------
    blob_len = None
    for k, off in enumerate(offsets):
        end = offsets[k+1] if k+1 < len(offsets) else None
        for r in users[off]:
            if r['isChar'] or r['isBoss']:
                continue
            tw, th = size_tiles(r['size'])
            need = tw * th * (24 if r['bpp3'] else 32)
            avail = (end - off) if end is not None else None
            if avail is not None and need > avail:
                sys.exit(f'monster {r["i"]}: graphics needs {need} bytes but only {avail} available')
    for off in offsets:
        fmts = set(r['bpp3'] for r in users[off] if not r['isChar'])
        if len(fmts) > 1:
            sys.exit(f'pointer {off:#x}: users disagree on 3bpp flag')

    # ---- palette pinning ----------------------------------------------------
    # The definition's monsterPalette entries are 8-color (16-byte)
    # sub-palettes, exactly the game's units: LoadMonsterPal reads 32 bytes
    # from MonsterPal + p*16, i.e. sub-palette p for a 3bpp sprite, or the
    # pair p + p+1 for a 4bpp sprite (colors 0-7 and 8-15).
    def pal_index(r):
        if r['isBoss']:
            return rom[boss_f + r['size']*5 + 2]
        return r['pal']

    def pal_choice(p, bpp3, label):
        if bpp3:
            return {'path': f'monsterPalette[{p}]', 'name': f'{p}: {label}'}
        return [
            {'path': f'monsterPalette[{p}]', 'offset': 0,
             'compose': True, 'name': f'{p}+{p+1}: {label}'},
            {'path': f'monsterPalette[{p+1}]', 'offset': 8,
             'compose': True, 'name': f'{p}+{p+1}: {label}'},
        ]

    itemPalettes = []
    for off in offsets:
        us = [r for r in users[off] if not r['isChar']] or users[off]
        bpp3 = us[0]['bpp3']
        order = sorted(us, key=lambda r: (0 if r['isBoss'] else 1, r['i']))
        defs, seen = [], set()
        for r in order:
            p = pal_index(r)
            if p in seen or p >= npal or (not r['bpp3'] and p + 1 >= npal):
                continue
            seen.add(p)
            label = names[r['i']] + (' (boss)' if r['isBoss'] else '')
            defs.append(pal_choice(p, bpp3, label))
        defs.append({'path': 'monsterPalette'})
        itemPalettes.append(defs)

    # ---- labels -------------------------------------------------------------
    def label_for(rs):
        bosses = sorted(set(names[r['i']] for r in rs if r['isBoss']))
        others = sorted(set(names[r['i']] for r in rs if not r['isBoss']))
        alias = set(ESPER_ALIAS[r['i']] for r in rs if r['i'] in ESPER_ALIAS)
        known = set(bosses) | set(others)
        extra = sorted(alias - known)
        parts = bosses + others + extra
        return ', '.join(parts)

    strings = {}
    for k, off in enumerate(offsets):
        us = [r for r in users[off] if not r['isChar']]
        lab = label_for(us)
        if us and all(r['isBoss'] for r in us):
            lab += ' (tile pool)'
        strings[k] = lab or f'Monster Graphics {k}'

    # monster palette names: which monsters use each sub-palette
    pal_users = [[] for _ in range(npal)]
    for r in recs:
        if r['isChar']:
            continue
        p = pal_index(r)
        if p < npal:
            tag = names[r['i']]
            if tag not in pal_users[p]:
                pal_users[p].append(tag)
    pal_strings = {str(k): ', '.join(pal_users[k]) for k in range(npal) if pal_users[k]}

    # ---- item ranges --------------------------------------------------------
    others = []
    for key, v in asm.items():
        if key == 'monsterGraphics' or not isinstance(v, dict):
            continue
        r = v.get('range')
        if not r:
            continue
        b, e = [int(x, 16) for x in r.split('-')]
        others.append((key, loROM_map(b), loROM_map(e)))
    others.sort(key=lambda t: t[1])

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

    # ---- summon blocks (read from the ROM) ----------------------------------
    # LoadSummonGfx reads 128 3bpp tiles from SummonGfxPtrs[attack-$4d] with
    # SummonPalTbl colors (btlgfx_data.asm); the blocks live in the bank-0d
    # ("summon graphics") region of the monster pointer space
    summon_starts = []
    for i in range(17):
        word = rom[SUMMON_PTRS_F + i*2] | (rom[SUMMON_PTRS_F + i*2 + 1] << 8)
        summon_starts.append(word + 0x18000)   # in-bank 0d -> region offset
    summon_pals = [rom[SUMMON_PAL_F + i] for i in range(17)]
    summon_block_starts = set(summon_starts)

    # ---- item ranges ---------------------------------------------------------
    item_ranges = []
    item_ends = []
    hidden_items = []
    for k, off in enumerate(offsets):
        nxt = offsets[k+1] if k+1 < len(offsets) else None
        lo = base_f + off
        # region end: monster graphics banks end at the Zeromus boundary;
        # the bank-0d ("summon graphics") region runs to its own end, and the
        # last block (Asura) extends to it - the summon animation frames use
        # tiles beyond what the monster battle draw loads
        if lo < MONSTER_GFX_END:
            cap = MONSTER_GFX_END - base_f
        else:
            cap = SUMMON_GFX_END - base_f
        if nxt is None:
            end = cap if lo >= MONSTER_GFX_END else min(off + max_load[off], cap)
        else:
            end = min(off + max_load[off], nxt, cap)
        # a boss-only pool holds the boss's complete art; the battle only
        # loads part of it (tile count from battleVRAMMap), but the rest is
        # the same creature (Mom Bomb's full 60-tile sheet proves this), so
        # boss pools own everything up to the next pointer
        us0 = [r for r in users[off] if not r['isChar']]
        if us0 and all(r['isBoss'] for r in us0):
            end = min(nxt, cap) if nxt is not None else cap
        # a summon block that starts inside this item's range is owned by the
        # summon instead (Chocobo/Shiva/Ramuh/Ifrit/Sylph are not monsters)
        for s2 in summon_block_starts:
            if s2 > off and s2 < end:
                end = s2
        for key, ob, oe in others:
            if ob >= lo and ob < base_f + end:
                end = ob - base_f
        hi = base_f + end
        for key, ob, oe in others:
            if lo < oe and ob < hi:
                sys.exit(f'item {k} [{lo:#x},{hi:#x}) overlaps {key} [{ob:#x},{oe:#x})')
        for r in recs:
            if r['isChar'] or r['isBoss'] or r['ptr'] != off:
                continue
            tw, th = size_tiles(r['size'])
            need = tw * th * (24 if r['bpp3'] else 32)
            if need > hi - lo:
                sys.exit(f'item {k}: monster {r["i"]} needs {need} bytes, only {hi-lo}')
        item_ranges.append('0x%06X-0x%06X' % (unmap(lo), unmap(hi)))
        item_ends.append(end)
        us = [r for r in users[off] if not r['isChar']]
        if us and all(r['isBoss'] for r in us):
            hidden_items.append(k)

    # ---- assembled boss views -----------------------------------------------
    # one window per (boss properties record, graphics pool) pair; the layout
    # walks the boss tile map exactly like the game's DrawBoss
    # (LoadBossTilemap): sequential cells, 0xFF = empty, 0xFE n = n empty,
    # anything else = pool tile index
    boss_windows = {}
    for r in recs:
        if r['isChar'] or not r['isBoss'] or r['i'] in SKIP_BOSSES:
            continue
        bi = r['size']
        bx = boss_f + bi*5
        si = rom[bx+1] & 0x3F
        tw, th = size_tiles(si)
        mp = rom[bx+4]
        wkey = (bi, r['ptr'])
        if wkey in boss_windows:
            boss_windows[wkey]['recs'].append(r)
            continue
        if r['i'] in SHEET_BOSSES:
            sh = SHEET_BOSSES[r['i']]
            boss_windows[wkey] = dict(tw=sh['width'],
                                      th=len(sh['layout'])//sh['width'],
                                      cells=sh['layout'],
                                      maxtile=sh['tiles']-1, ptr=r['ptr'],
                                      recs=[r], pal=sh['pal'])
            continue
        if mp >= nbmaps:
            continue
        cells = []
        k = bmap_offs[mp]
        limit = bmap_offs[mp+1] if mp+1 < nbmaps else bmap_end
        while len(cells) < tw*th and k < limit:
            b = rom[k]; k += 1
            if b == 0xFE:
                n = rom[k]; k += 1
                cells += [-1]*n
            elif b == 0xFF:
                cells.append(-1)
            else:
                cells.append(b)
        while len(cells) < tw*th:
            cells.append(-1)
        maxtile = max((c for c in cells if c >= 0), default=0)
        boss_windows[wkey] = dict(tw=tw, th=th, cells=cells, maxtile=maxtile,
                                  ptr=r['ptr'], recs=[r], pal=None)

    def window_defs_for(rs, pal_override=None):
        defs, seen = [], set()
        for r in sorted(rs, key=lambda r: r['i']):
            p = pal_override if pal_override is not None else pal_index(r)
            if p in seen:
                continue
            seen.add(p)
            defs.append(pal_choice(p, r['bpp3'], label_for(rs)))
        defs.append({'path': 'monsterPalette'})
        return defs

    boss_keys = []
    seen_bi = {}
    for (bi, ptr) in sorted(boss_windows):
        w = boss_windows[(bi, ptr)]
        k = item_of[ptr]
        bpp3 = w['recs'][0]['bpp3']
        us = sorted(w['recs'], key=lambda r: r['i'])
        label = label_for(us) or f'Boss {bi}'
        n = seen_bi.get(bi, 0)
        seen_bi[bi] = n + 1
        key = f'bossGraphics_{bi}' + (f'_{n}' if n else '')
        boss_keys.append(key)
        entry = {
            'type': 'graphics',
            'name': f'Boss Graphics ({label})',
            'format': 'snes3bpp' if bpp3 else 'snes4bpp',
            'width': w['tw'],
            'window': {
                'path': f'monsterGraphics_{k}',
                'offset': 0,
                'tiles': w['maxtile'] + 1
            },
            'palette': window_defs_for(us, w['pal'])
        }
        if w['th'] is not None:
            entry['height'] = w['th']
            entry['layout'] = w['cells']
        asm[key] = entry

    # ---- summon entries -------------------------------------------------------
    # Every Esper gets its own summonGraphics_<Name> assembly so the Summons
    # tree rows are independent objects (two tree rows pointing at one object
    # make the navigator highlight the wrong row).
    #   * the six that are bosses reuse their assembled boss window's layout,
    #     as windows onto the same pool
    #   * the four normal-monster ones are windows onto their monster item
    #   * Chocobo, Shiva, Ramuh, Ifrit and Sylph have summon-only blocks:
    #     owning assemblies arranged by the game's animation data
    #     (SummonTilemapPtrs map block tile k -> OBJ VRAM slot;
    #     SummonFramePtrs stages list the slot at each grid cell, 16x16
    #     sprites = VRAM slots e..e+3; grid from SummonSpritePosTbl)
    # Placements saved by tools/ff4-sfc-puzzle (manual tile arranging)
    # override the computed layout for any key.
    SUMMON_TMP_F   = 0x6f260    # SummonTilemapPtrs (words + 0x0d0000)
    SUMMON_SFP_F   = 0x6f660    # SummonFramePtrs   (words + 0x0d0000)
    SUMMON_FSETS_F = loROM_map(0x13fa9d)  # stage set per summon (4 each)
    SUMMON_POS_F   = loROM_map(0x13fa59)  # x, y, w, h in 16px units
    BOSS_BP_FOR    = {8: 2, 9: 0, 11: 42, 12: 46, 13: 54, 16: 47}

    PLACEMENT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 'ff4-sfc-puzzle', 'placements')

    def load_placement(key):
        fp = os.path.join(PLACEMENT_DIR, key + '.json')
        if not os.path.exists(fp):
            return None
        try:
            o = json.load(open(fp))
            cols, rows = int(o['cols']), int(o['rows'])
            layout = [-1]*(cols*rows)
            flips = [0]*(cols*rows)
            for pl in o.get('placement', []):
                c, t = int(pl['cell']), int(pl['tile'])
                if 0 <= c < len(layout) and t >= 0:
                    layout[c] = t
                    flips[c] = int(pl.get('flip', 0))
            return cols, rows, layout, flips
        except (ValueError, KeyError, OSError):
            print(f'  warning: bad placement file {fp}, ignoring')
            return None

    def block_end(start):
        end = SUMMON_GFX_END - base_f
        for s2 in summon_block_starts:
            if s2 > start and s2 < end:
                end = s2
        return end

    def summon_stage_layout(i):
        w1 = rom[SUMMON_TMP_F + i*2] | (rom[SUMMON_TMP_F + i*2 + 1] << 8)
        tmp = loROM_map(0x0d0000 + w1)
        slot2tile = {}
        k = 0
        p2 = tmp
        while True:
            b = rom[p2]; p2 += 1
            if b == 0xff:
                break
            if b < 0x80:
                slot2tile[b] = k
                k += 1
        w, h = rom[SUMMON_POS_F + i*4 + 2], rom[SUMMON_POS_F + i*4 + 3]
        best = None
        for stageno in range(4):
            fset = rom[SUMMON_FSETS_F + i*4 + stageno]
            w2 = rom[SUMMON_SFP_F + fset*2] | (rom[SUMMON_SFP_F + fset*2 + 1] << 8)
            fp = loROM_map(0x0d0000 + w2)
            entries = []
            q = fp
            while len(entries) < w*h:
                b = rom[q]; q += 1
                if b == 0xff:
                    break
                if b == 0xfe:
                    n = rom[q]; q += 1
                    entries += [None]*n
                elif b < 0x80:
                    entries.append(b)
                else:
                    entries.append(None)
            GW, GH = w*2, h*2
            layout = [-1]*(GW*GH)
            for e_i, e in enumerate(entries[:w*h]):
                if e is None:
                    continue
                r, c = divmod(e_i, w)
                for sub in range(4):
                    sr, sc = divmod(sub, 2)
                    t = slot2tile.get(e + sub)
                    layout[(r*2+sr)*GW + (c*2+sc)] = -1 if t is None else t
            n = sum(1 for t in layout if t >= 0)
            if best is None or n > best[0]:
                best = (n, GW, GH, layout)
        return best

    # index the boss windows by bossProps so summons can reuse their layout
    boss_window_by_bp = {}
    for (bi, ptr), w in boss_windows.items():
        boss_window_by_bp.setdefault(bi, (w, item_of[ptr]))

    summon_entries = []
    seen_block = set()
    for i in range(17):
        start = summon_starts[i]
        if start in seen_block:
            continue
        seen_block.add(start)
        end = block_end(start)
        name = SUMMON_NAMES[i]
        key = f'summonGraphics_{name.replace(" ", "")}'
        summon_entries.append((name, key))
        p = summon_pals[i]
        defs = [pal_choice(p, True, name)]
        for j in range(17):
            if j != i and summon_starts[j] == start:
                defs.append(pal_choice(summon_pals[j], True, SUMMON_NAMES[j]))
        defs.append({'path': 'monsterPalette'})

        entry = {
            'type': 'graphics',
            'name': f'Summon Graphics ({name})',
            'format': 'snes3bpp',
            'palette': defs
        }
        if i in BOSS_BP_FOR:
            bw, bk = boss_window_by_bp[BOSS_BP_FOR[i]]
            entry['window'] = {
                'path': f'monsterGraphics_{bk}',
                'offset': 0,
                'tiles': bw['maxtile'] + 1
            }
            entry['width'] = bw['tw']
            if bw['th'] is not None:
                entry['height'] = bw['th']
                entry['layout'] = list(bw['cells'])
        else:
            k = item_of.get(start)
            if k is not None and item_ends[k] == end:
                # normal-monster Esper: a window over its own item
                entry['window'] = {
                    'path': f'monsterGraphics_{k}',
                    'offset': 0,
                    'tiles': (end - start) // 24
                }
                entry['width'] = size_tiles(users[start][0]['size'])[0] if users[start] else 8
            else:
                # summon-only block: owning assembly, arranged by frame data
                entry['range'] = ('0x%06X-0x%06X'
                                  % (unmap(base_f + start), unmap(base_f + end)))
                res = summon_stage_layout(i)
                if res:
                    n, GW, GH, layout = res
                    entry['width'] = GW
                    entry['height'] = GH
                    entry['layout'] = layout
        # manual placements win
        pl = load_placement(key)
        if pl:
            cols, rows, layout, flips = pl
            entry['width'] = cols
            entry['height'] = rows
            entry['layout'] = layout
            if any(flips):
                entry['layoutFlip'] = flips
            if 'window' in entry:
                entry['window']['tiles'] = max(entry['window']['tiles'],
                                               max(layout) + 1, 0)
        asm[key] = entry

    # a manual placement can also fix a boss window (e.g. Mom Bomb)
    seq_by_bp = {}
    for (bi, ptr) in sorted(boss_windows):
        seq_by_bp.setdefault(bi, []).append((bi, ptr))
    for bi, seq in seq_by_bp.items():
        for idx, (bi2, ptr) in enumerate(seq):
            key = f'bossGraphics_{bi}' + (f'_{idx}' if idx else '')
            pl = load_placement(key)
            if pl and key in asm:
                cols, rows, layout, flips = pl
                asm[key]['width'] = cols
                asm[key]['height'] = rows
                asm[key]['layout'] = layout
                if any(flips):
                    asm[key]['layoutFlip'] = flips
                if max(layout, default=-1) >= asm[key]['window']['tiles']:
                    asm[key]['window']['tiles'] = max(layout) + 1

    # ---- character / portrait palette pins ----------------------------------
    # characterPalette has 16 entries (0-13 characters, 14 Golbez, 15 Anna);
    # the Pig battle sprite reuses whichever character's palette is active,
    # so it gets the whole array as a dropdown instead of a wrong pin.
    cg = asm.get('characterGraphics')
    if cg:
        n = cg.get('arrayLength') or (cg.get('array') or {}).get('length') or 0
        palNames = ((asm.get('characterPalette') or {}).get('stringTable') or {}) \
            .get('string') or {}
        char_pin = {14: None, 15: 14, 16: 15}   # graphics item -> palette entry
        pins = []
        for i in range(n):
            pi = char_pin.get(i, i)
            if pi is None:
                # the pig reuses whichever character's palette is active:
                # offer every character palette by name
                choices = []
                for j in range(len(palNames) or 16):
                    nm = palNames.get(str(j)) or palNames.get(j)
                    if nm:
                        choices.append({'path': f'characterPalette[{j}]',
                                        'name': f'{nm} palette (reused)'})
                choices.append({'path': 'characterPalette'})
                pins.append(choices)
            else:
                nm = palNames.get(str(pi)) or palNames.get(pi) or ''
                pins.append([{'path': f'characterPalette[{pi}]',
                              'name': (f'{pi}: {nm}') if nm else f'characterPalette[{pi}]'},
                             {'path': 'characterPalette'}])
        cg['itemPalettes'] = pins

    # portraitPalette: the rom map says 16 sub-palettes (0x0d86d0-0x0d87d0);
    # the two extra ones are empty - Pig/Small/Toad portraits reuse the
    # affected character's own palette at runtime, so offer the array
    pp = asm.get('portraitPalette')
    if pp:
        pp['range'] = '0x0D86D0-0x0D87D0'
        pp['array'] = {'length': 16}
    pgr = asm.get('portraitGraphics')
    if pgr:
        n = (pgr.get('array') or {}).get('length') or 0
        st = pgr.get('stringTable')
        if isinstance(st, str):
            st = (asm.get(st) or {}).get('stringTable')
        palNames = (st or {}).get('string') or {}
        pins = []
        for i in range(n):
            if i >= 14:
                # small/toad portraits reuse the affected character's palette
                choices = []
                for j in range(14):
                    nm = palNames.get(str(j)) or palNames.get(j)
                    if nm:
                        choices.append({'path': f'portraitPalette[{j}]',
                                        'name': f'{nm} palette (reused)'})
                choices.append({'path': 'portraitPalette'})
                pins.append(choices)
            else:
                nm = palNames.get(str(i)) or palNames.get(i) or ''
                pins.append([{'path': f'portraitPalette[{i}]',
                              'name': (f'{i}: {nm}') if nm else f'portraitPalette[{i}]'},
                             {'path': 'portraitPalette'}])
        pgr['itemPalettes'] = pins

    # ---- write the definition -------------------------------------------------
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
        'hiddenItems': hidden_items,
        'stringTable': {
            'length': len(offsets),
            'default': 'Monster Graphics %i',
            'string': strings
        }
    }

    gp = props_def['assembly']['assembly']['graphicsPointer']
    gp['offset'] = hex(base_f)
    gp['pointerTo'] = 'monsterGraphics'

    pal_def['stringTable'] = {
        'length': npal,
        'default': 'Monster Palette %i',
        'string': pal_strings
    }

    # hierarchy
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
    # replace the Boss Graphics section wholesale (keys change between runs)
    def replace_section(title, keys):
        sec = None
        for s in defj['hierarchy']:
            if s.get('name') == title:
                sec = s
                break
        if sec is None:
            sec = {'name': title, 'list': []}
            for idx, s in enumerate(defj['hierarchy']):
                if s.get('name') == 'Monster':
                    defj['hierarchy'].insert(idx+1, sec)
                    break
            else:
                defj['hierarchy'].append(sec)
        sec['list'] = [{'name': asm[k]['name'], 'path': k} for k in keys]
    replace_section('Boss Graphics', boss_keys)
    # Summons: entries point either at a monster item or at a dedicated
    # summonGraphics_* assembly
    sec = None
    for s in defj['hierarchy']:
        if s.get('name') == 'Summons':
            sec = s
            break
    if sec is None:
        sec = {'name': 'Summons', 'list': []}
        for idx, s in enumerate(defj['hierarchy']):
            if s.get('name') == 'Boss Graphics':
                defj['hierarchy'].insert(idx+1, sec)
                break
        else:
            defj['hierarchy'].append(sec)
    sec['list'] = [{'name': f'Summon: {name}', 'path': path}
                   for name, path in summon_entries]

    # Attack Graphics: expose the raw (paintable) graphics object as well as
    # the animation tilemap that already lived in the tree
    for sec in defj['hierarchy']:
        for item in sec.get('list', []):
            if item.get('path') == 'attackTilemap' and item.get('name') == 'Attack Graphics':
                item['name'] = 'Attack Tilemap'
    ensure('Character', 'Attack Graphics', 'attackGraphics')

    # drop stale bossGraphics_*/summonGraphics_* assemblies from previous runs
    live_keys = set(boss_keys) | {p for _, p in summon_entries}
    for key in list(asm.keys()):
        if (key.startswith('bossGraphics_') or key.startswith('summonGraphics_')) \
                and key not in live_keys:
            del asm[key]

    json.dump(defj, open(args.definition, 'w'), indent=4)
    print(f'{args.definition}: {len(offsets)} graphics objects '
          f'({len(hidden_items)} boss pools hidden from the tree), '
          f'{len(boss_keys)} assembled boss views, '
          f'{len(summon_entries)} summon entries '
          f'({sum(1 for _, p in summon_entries if p.startswith("summonGraphics_"))} '
          f'dedicated), '
          f'{sum(1 for r in recs if r["isBoss"])} boss records, '
          f'{len(pal_strings)} named palettes')

if __name__ == '__main__':
    main()
