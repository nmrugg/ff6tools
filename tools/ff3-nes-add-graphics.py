#!/usr/bin/env python3
"""Add the FF3 (NES) battle graphics assemblies to a definition file
(ff3/ff3j-nes.json by default; --def ff3/ff3u-nes.json for the translation).

Writes, from data read out of the ROM:
  * the six monster graphics size-class arrays, each entry labelled with the
    monsters that use it and defaulted to the palette those monsters actually
    fight with (itemPalettes)
  * the monster graphics properties table
  * the 256 battle palettes
  * battle character graphics (one 42-tile block per job, laid out two tiles
    wide so the poses are not scrambled) and the toad/mini graphics
  * boss graphics: the pointer table, the 24 tilemaps, and a tilemap assembly
    per boss that renders it from the shared monster tile pool
  * raw 2bpp banks: battle background, summon, battle sprite, map sprite, attack

It also removes the bogus `worldPalette` assembly (it pointed into the world
tileset data; FF3 loads the world/map palette from mapPaletteBase, 3A/9091).

    usage: ff3-nes-add-graphics.py [--def FILE] [--rom FILE] [--dry-run] [--force]
"""
import json, os, re, sys, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEF = os.path.join(ROOT, 'ff3', 'ff3j-nes.json')

spec = importlib.util.spec_from_file_location('ff3nesnames', os.path.join(HERE, 'ff3-nes-names.py'))
names = importlib.util.module_from_spec(spec)
spec.loader.exec_module(names)

def js(value):
    return json.dumps(value, ensure_ascii=False)

def indent(text, n):
    pad = ' ' * n
    return '\n'.join((pad + line) if line.strip() else line for line in text.split('\n'))

def string_table(table):
    out = ['{', '    "length": %d,' % table['length']]
    if table.get('default'):
        out.append('    "default": %s,' % js(table['default']))
    keys = sorted((int(k) for k in table['string']))
    if keys:
        out.append('    "string": {')
        out.append('        ' + ', '.join('"%d": %s' % (k, js(table['string'][str(k)])) for k in keys))
        out.append('    }')
    else:
        out.append('    "string": {}')
    out.append('}')
    return '\n'.join(out)

def palette_list(entries, pad):
    """Render a palette definition (string, or a list of definitions with the
    default first and the whole palette array last)."""
    if len(entries) == 1 and isinstance(entries[0], str):
        return '"%s"' % entries[0]
    inner = ' ' * (pad + 4)
    items = ['{"path": "%s"}' % e if isinstance(e, str) else js(e) for e in entries]
    return '[\n' + ',\n'.join(inner + i for i in items) + '\n' + ' ' * pad + ']'

MONSTER_CLASSES = [
    # key, name, range, entries, w, h, item length
    ('monsterGraphics4x4',  'Monster Graphics (4x4)',  '0x208000-0x209000', 16,  4,  4, '0x100'),
    ('monsterGraphics4x6',  'Monster Graphics (4x6)',  '0x209000-0x219400', 24,  4,  6, '0x180'),
    ('monsterGraphics6x6',  'Monster Graphics (6x6)',  '0x228000-0x239600', 24,  6,  6, '0x240'),
    ('monsterGraphics6x6b', 'Monster Graphics (6x6b)', '0x248000-0x259600', 24,  6,  6, '0x240'),
    ('monsterGraphics6x12', 'Monster Graphics (6x12)', '0x268000-0x269200',  4,  6, 12, '0x480'),
    ('monsterGraphics12x6', 'Monster Graphics (12x6)', '0x269200-0x278400',  4, 12,  6, '0x480'),
]

def graphics_array(key, name, rng, count, w, h, length, palette, table,
                   item_name=None, item_palettes=None):
    pal = palette_list(palette, 16)
    lines = ['"%s": {' % key,
             '    "type": "array",',
             '    "name": "%s",' % name,
             '    "range": "%s",' % rng,
             '    "arrayLength": %d,' % count,
             '    "assembly": {',
             '        "type": "graphics",',
             '        "name": "%s",' % (item_name or name),
             '        "length": "%s",' % length,
             '        "format": "nes2bpp",',
             '        "width": %d,' % w,
             '        "height": %d,' % h,
             '        "backColor": true,',
             '        "palette": %s' % pal,
             '    },']
    if item_palettes:
        lines.append('    "itemPalettes": [')
        for i, e in enumerate(item_palettes):
            sep = ',' if i + 1 < len(item_palettes) else ''
            lines.append('        ' + palette_list(e, 8).replace('\n', '\n        ') + sep)
        lines.append('    ],')
    lines.append('    "stringTable": ' + indent(string_table(table), 4).lstrip())
    lines.append('}')
    return '\n'.join(lines)

def file_to_def(file_addr):
    """Inverse of mmc3 mapAddress; the result re-maps to the same file offset."""
    a = file_addr - 0x10
    bank = (a << 3) & 0xFF0000
    off = a & 0x1FFF
    return bank | off | (0xA000 if (bank & 0x10000) else 0x8000)

def main():
    dry = '--dry-run' in sys.argv
    target, rom = DEF, os.path.join(ROOT, names.ROMNAME)
    for i, a in enumerate(sys.argv):
        if a == '--def' and i + 1 < len(sys.argv):
            target = sys.argv[i + 1]
        if a == '--rom' and i + 1 < len(sys.argv):
            rom = sys.argv[i + 1]
    DEFN = target if os.path.isabs(target) else os.path.join(ROOT, target)
    ROMN = rom if os.path.isabs(rom) else os.path.join(ROOT, rom)

    r = names.main(ROMN, DEFN)
    tables, item_pal, char_pal, bosses = r['tables'], r['itemPalettes'], r['charPalettes'], r['bosses']

    original = open(DEFN, encoding='utf-8').read()
    text = original
    defn = json.loads(text)

    if 'monsterGraphics4x4' in defn['assembly'] and '--force' not in sys.argv:
        print('%s already has the battle graphics; nothing to do '
              '(use --force to rewrite from scratch)' % DEFN)
        return
    if '--force' in sys.argv:
        # rebuild from the pristine definition so re-running is idempotent
        import subprocess
        rel = os.path.relpath(DEFN, ROOT)
        base = subprocess.run(['git', 'show', 'HEAD:%s' % rel], cwd=ROOT,
                              capture_output=True, check=True).stdout.decode('utf-8')
        text = base
        defn = json.loads(text)
        original = base
        print('reset from git HEAD for a clean rebuild')

    # ---- fix the bogus worldPalette -------------------------------------
    if 'worldPalette' in defn.get('assembly', {}):
        text = text.replace('"palette": "worldPalette",', '"palette": "mapPaletteBase",')
        text = text.replace('"path": "worldPalette"', '"path": "mapPaletteBase"')
        text = re.sub(r'\n        "worldPalette": \{\n'
                      r'            "type": "assembly",\n'
                      r'            "name": "World Palette",\n'
                      r'            "range": "0x008380-0x0083A0",\n'
                      r'            "format": "nesPalette"\n'
                      r'        \},(?=\n        "worldPaletteAssignment")',
                      ' ', text, count=1)

    # ---- assemblies ------------------------------------------------------
    blocks = []
    for key, name, rng, count, w, h, length in MONSTER_CLASSES:
        blocks.append(graphics_array(key, name, rng, count, w, h, length,
                                     ['battlePalettes'], tables[key],
                                     'Monster Graphics', item_pal[key]))

    blocks.append('''"monsterGraphicsProperties": {
    "type": "array",
    "name": "Monster Graphics Properties",
    "range": "0x2E8B00-0x2E8C00",
    "arrayLength": 256,
    "assembly": {
        "type": "data",
        "length": 1,
        "assembly": {
            "graphicsSize": {
                "type": "property",
                "name": "Graphics Size",
                "begin": 0,
                "mask": "0xE0",
                "stringTable": {
                    "length": 8,
                    "default": "Size %i",
                    "string": {"0": "4x4", "1": "4x6", "2": "6x6", "3": "6x6 (bank 24/25)",
                               "4": "6x12", "5": "12x6", "6": "12x12 (boss tilemap)",
                               "7": "12x12 (boss tilemap)"}
                }
            },
            "graphicsID": {
                "type": "property",
                "name": "Graphics ID",
                "begin": 0,
                "mask": "0x1F"
            }
        }
    },
    "stringTable": @TABLE@
}'''.replace('@TABLE@', indent(string_table(tables['monsterGraphicsProperties']), 4).lstrip()))

    # 42 tiles per job, two tiles wide: rows 0-2 standing, 3 walking,
    # 4-6 kneeling, 7-14 attack/cast animation, 15-17 hit, 18-20 dead
    blocks.append(graphics_array(
        'battleCharacterGraphics', 'Battle Character Graphics', '0x288000-0x299F00',
        24, 2, 21, '0x2A0', char_pal[0], tables['battleCharacterGraphics'],
        'Battle Character Graphics', char_pal))

    blocks.append(graphics_array(
        'battleCharacterGraphicsStatus', 'Battle Character Graphics (Toad/Mini)',
        '0x299F00-0x2A8000', 2, 2, 4, '0x80', char_pal[0],
        {'length': 2, 'default': 'Status Graphics %i', 'string': {"0": "Mini", "1": "Toad"}},
        'Toad/Mini Graphics'))

    blocks.append('''"battlePalettes": {
    "type": "array",
    "name": "Battle Palettes",
    "range": "0x2E8C00-0x2E8F00",
    "arrayLength": 256,
    "assembly": {
        "type": "assembly",
        "name": "Battle Palette",
        "length": 3,
        "format": "nesFixedPalette"
    },
    "stringTable": @TABLE@
}'''.replace('@TABLE@', indent(string_table(tables['battlePalettes']), 4).lstrip()))

    # ---- bosses ----------------------------------------------------------
    boss_names = {'length': 24, 'default': 'Boss %i',
                  'string': {str(b['index']): ', '.join(b['owners'])
                             for b in bosses if b['owners']}}
    blocks.append('''"bossGraphicsPointers": {
    "type": "array",
    "name": "Boss Graphics Pointers",
    "range": "0x2E9068-0x2E9098",
    "arrayLength": 24,
    "assembly": {
        "type": "data",
        "length": 2,
        "assembly": {
            "tileIndex": {
                "type": "property",
                "name": "Tile Index",
                "begin": 0,
                "mask": "0x3FF"
            },
            "graphicsBank": {
                "type": "property",
                "name": "Graphics Bank",
                "begin": 1,
                "mask": "0x03",
                "stringTable": {
                    "length": 4,
                    "default": "Bank %i",
                    "string": {"0": "$20/$21 (monster tile pool)", "1": "$22/$23 (monster tile pool)",
                               "2": "$24/$25 (monster tile pool)", "3": "$26/$27 (monster tile pool)"}
                }
            },
            "useSummonGraphics": {
                "type": "property",
                "name": "Use Summon Graphics",
                "begin": 1,
                "mask": "0x04",
                "bool": true
            }
        }
    },
    "stringTable": @TABLE@
}'''.replace('@TABLE@', indent(string_table(boss_names), 4).lstrip()))

    for b in bosses:
        i = b['index']
        begin = file_to_def(names.mmc3_to_file(0x2A8000) + i * 216)
        end = file_to_def(names.mmc3_to_file(0x2A8000) + (i + 1) * 216)
        rng = '0x%06X-0x%06X' % (begin, end)
        name = ', '.join(b['owners']) or ('Boss %d' % i)
        container = b['container'][0] if b['container'] else 'monsterGraphics6x6'
        blocks.append('''"bossTilemap%d": {
    "type": "tilemap",
    "name": "Boss Tilemap %d (%s)",
    "range": "%s",
    "format": "generic2bppTile",
    "width": 18,
    "height": 12,
    "backColor": true,
    "graphics": {
        "path": "%s",
        "whole": true
    },
    "tileOffset": %d,
    "palette": %s
}''' % (i, i, name.replace('"', "'"), rng, container, b['tileOffset'],
        indent(palette_list(b['palette'], 4), 4).lstrip()))

    for key, name, rng in [
        ('battleBackgroundGraphics', 'Battle Background Graphics', '0x0C8000-0x0C9800'),
        ('summonGraphics',           'Summon Graphics',            '0x0C9800-0x0DA800'),
        ('battleSpriteGraphics',     'Battle Sprite Graphics',     '0x0DA800-0x0E8000'),
        ('mapSpriteGraphics',        'Map Sprite Graphics',        '0x0E8000-0x108000'),
        ('attackGraphics',           'Attack Graphics',            '0x2A9600-0x2C8000'),
    ]:
        blocks.append('''"%s": {
    "type": "graphics",
    "name": "%s",
    "range": "%s",
    "format": "nes2bpp",
    "backColor": true
}''' % (key, name, rng))

    anchor = '    "assembly": {\n'
    assert anchor in text, 'assembly anchor not found'
    text = text.replace(anchor, anchor + indent(',\n'.join(blocks), 8) + ',\n', 1)

    # ---- hierarchy -------------------------------------------------------
    items = ['{"path": "%s"}' % key for key, *_ in MONSTER_CLASSES]
    items += ['{"path": "monsterGraphicsProperties"}',
              '{"path": "battlePalettes"}',
              '{"path": "battleCharacterGraphics"}',
              '{"path": "battleCharacterGraphicsStatus"}',
              '{"path": "battleBackgroundGraphics"}',
              '{"path": "summonGraphics"}',
              '{"path": "battleSpriteGraphics"}',
              '{"path": "attackGraphics"}',
              '{"path": "mapSpriteGraphics"}']
    battle = '''        }, {
            "name": "Battle",
            "list": [
                %s''' % (', '.join(items))

    boss_items = ', '.join('{"path": "bossTilemap%d"}' % b['index'] for b in bosses)
    boss_sec = '''        }, {
            "name": "Boss Graphics",
            "list": [
                {"path": "bossGraphicsPointers"},
                %s''' % boss_items

    anchor = '        }, {\n            "name": "Text",'
    assert anchor in text, 'hierarchy anchor not found'
    text = text.replace(anchor,
                        battle + '\n            ]\n' + boss_sec + '\n            ]\n        }, {\n            "name": "Text",', 1)

    # ---- validate --------------------------------------------------------
    try:
        updated = json.loads(text)
    except Exception as e:
        dump = '/tmp/ff3-definition-candidate.json'
        open(dump, 'w', encoding='utf-8').write(text)
        raise SystemExit('generated definition does not parse (%s); wrote %s' % (e, dump))
    need = ['monsterGraphics4x4', 'monsterGraphics12x6', 'monsterGraphicsProperties',
            'battlePalettes', 'battleCharacterGraphics', 'bossGraphicsPointers',
            'bossTilemap0', 'bossTilemap23', 'summonGraphics']
    missing = [k for k in need if k not in updated['assembly']]
    if missing:
        raise SystemExit('definition is missing %s after the edit' % missing)
    if 'worldPalette' in updated['assembly']:
        raise SystemExit('worldPalette was not removed')
    for s in updated['hierarchy']:
        if s.get('name') in ('Battle', 'Boss Graphics'):
            break
    else:
        raise SystemExit('hierarchy sections missing')

    if dry:
        print('dry run: %d bytes -> %d bytes' % (len(original), len(text)))
    else:
        open(DEFN, 'w', encoding='utf-8').write(text)
        print('wrote %s (%d -> %d bytes)' % (DEFN, len(original), len(text)))

if __name__ == '__main__':
    main()
