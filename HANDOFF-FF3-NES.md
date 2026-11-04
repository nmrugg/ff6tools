# Handoff prompt: FF3 (NES) graphics in ff6tools — pick up here

You are continuing work on a feature branch of
[ff6tools](https://github.com/everything8215/ff6tools) at
`/storage/romhacking/ff6tools`. FF3 (Japan) and FF3 (English translation) on
the NES now have editable monster, battle character, boss and summon graphics.
Read this whole file before touching anything; the "gotchas" section is the
reason this took many rounds.

Also read `HANDOFF.md` (general project log, esp. §1 ground rules and §5 for
FF3 details). This file is the *forward-looking* brief; `HANDOFF.md` is the
history.

---

## 1. What works right now (verified, don't re-derive)

- `ff3/ff3j-nes.json` and `ff3/ff3u-nes.json` contain: 6 monster size-class
  arrays (4x4, 4x6, 6x6, 6x6b, 6x12, 12x6), `monsterGraphicsProperties`,
  `monsterAttributeData` + `bossAttributeData` (the per-cell palette tables),
  `battlePalettes` (256), `battleCharacterGraphics` (24 jobs, 2 tiles wide),
  toad/mini, `bossGraphicsPointers` + `bossTilemap0..23`,
  `summonProperties` + `summonTilemap0..7`, `summonGraphics`,
  `monsterGraphicsSpare1..4` (the gaps between class arrays), and raw 2bpp
  banks (battle bg, battle sprites, map sprites, attack graphics).
- All of it is generated. Regenerate with:
  `python3 tools/ff3-nes-add-graphics.py --force` (and
  `--def ff3/ff3u-nes.json --rom "Final Fantasy III (Japan) (fixed) (English).nes"`).
  `--force` walks git history for the pre-generation baseline, so it is idempotent.
- Names/palettes/cell-maps all come from the ROM: `tools/ff3-nes-names.py`.
- Tests: `node tools/ff3-nes-xcheck.js [def] [rom]` (both dumps pass),
  `node tools/ff3-nes-app-test.js [rom] [defKey]`, `node tools/ff3-nes-map-smoke.js`,
  `node tools/rom-harness.js` (FF5E) and with `FF5E_ROM=<ff3 dump>`,
  plus `tools/ui-edit-test.js`, `tools/ui-features-test.js`, `tools/map-smoke-test.js`.
  All currently pass; three ROMs round-trip with **0 diffs**. Keep it that way.
  `python3 tools/ff3-nes-attrcheck.py` is the palette-split check against
  reference rips (it caches rips in /tmp/ff3-rips and needs the network once).

---

## 2. Open problems, in priority order

### A. Per-cell palettes — SOLVED (the old model was wrong in three ways)

Read `2F/A0E7` ("get monster attribute id") before believing anything else:
the record index is **`(props & $1F) + a per-class offset`**, not `props & $3F`:

| class | base | bytes | id | range used |
|---|---|---|---|---|
| 0 4x4 | `$8F20` | 1 | gfx + $00 | `$8F20-$8F2F` |
| 1 4x6 | `$8F20` | 1 | gfx + **$10** | `$8F30-$8F47` |
| 2 6x6 | `$8F48` | 2 | gfx + $00 | `$8F48-$8F77` |
| 3 6x6b | `$8F48` | 2 | gfx + **$18** | `$8F78-$8FA7` |
| 4 6x12 | `$8FA8` | 3 | gfx + $00 | `$8FA8-$8FB3` |
| 5 12x6 | `$8FB4` | 3 | gfx + $00 | `$8FB4-$8FBF` |
| 6 boss | `$8FC0` | **7** | tilemap index | `$8FC0-$9027` |

Those ranges tile perfectly and the boss table ends *exactly* at the boss
pointer table at `$9068` - that is the proof the offsets are right. The old
`props & $3F` used bit 5 of the graphics byte as part of the index, so 48 of
the 96 graphics (all of 4x6 and 6x6b) read the wrong record.

Three more things were wrong:

1. **The walk is over the formation slot, not the graphic.** `2F/A78D` takes
   width/height from the position data (`$A4CC`), and a 4x4 monster always
   stands in a 4x6 slot: `2F/A2D0` gives the slot's first tile id as `$70`
   while `2F/A4A4` loads 4x4 graphics at PPU `$0780`, i.e. two tile rows
   lower. So a 4x4 record's cells 0-1 describe the empty row above the sprite
   and the sprite's cells are bits 2-5. This is exactly the "you can see the
   half line" the user reported on Firefry and Liliput: their records are
   `$3C`, which is *all one palette* once aligned.
2. **`$2E:$8F00` is one bit per monster id meaning "invert this monster's
   cells"** (`2F/A89C AND #$80` → `2F/A8BF EOR #$FF`). Bytes `$8F10-$8F1F` are
   `$FF`: **every id `$80-$FF` shows the two palettes swapped.** That is why
   Hornet's orange was missing from its antenna/feet and why boss/monster
   pairs sharing a graphic (Kyklops/Cyclops, Behemoth/KBehemoth,
   Needler/DeathNeedle, BossTroll/Ogre) look different in game.
3. **Bosses do have cell maps** - 7 bytes per tilemap index at `$2E:$8FC0`
   (`2F/A820`, taken when the formation type is 9), 9x6 = 54 cells for the
   18x12 tilemap. The earlier note that the class-6 attribute path was
   undefined was wrong: bosses reach it through the formation type, not the
   size class. Medusa (tilemap 0) and Bahamut (18) now render as proper
   two-palette sprites.

How it is wired now:
- `monsterAttributeData` (`$2E8F00-$2E8FC0`, 192 x 1 byte) and
  `bossAttributeData` (`$2E8FC0-$2E9028`, 24 x 7 bytes) are real assemblies,
  named byte by byte ("4x6 #3 cells", "Invert flag: monsters $80-$87"), so
  the tables are editable and owned by exactly one assembly.
- Each graphic carries `attributeRef` =
  `{path, index, bytes, cells, offset, invert}`; `ROMArray.disassemble` expands
  it through `applyAttributeRef()` onto `attributeCells` /
  `attributeCellsOffset` / `attributeCellsInvert`.
- `ROMGraphicsView.attributeCellBits()` **reads the bytes live** from the
  referenced array item, so editing the table repaints the sprite (the view
  also observes those items). `attributeCells` remains as a snapshot.
- `ROMTilemapView.applyPaletteCells()` stamps the same bits onto the boss
  tilemap words' colour-offset field; bosses also get their two battle
  palettes composed (`compose` was missing on the boss palette entries).
- Both views have a **"Swap palette cells"** control for graphics shared by a
  normal monster and its boss.

Verified against reference rips by `tools/ff3-nes-attrcheck.py` (new): 62
monsters have rips on videogamesprites.net, 61 agree with the model's colour
histogram at 100%, and in the 7 cases where a wrong record index or a missing
slot alignment would change the answer, the model is the only variant at 100%.
Per-pixel comparison is *not* reliable there - some rips (Enemies/Hornet) hold
the right tiles in the wrong places.

### B. Boss/summon editing

- **Left-click used to paint at the *previous* selection position, not where you
  clicked** - `mouseDown` never moved `selection.x/y` for the left button (only
  `mouseMove` did), so a stamp landed somewhere else and nothing appeared to
  happen. That is the whole "bosses are not editable" report. `mouseDown` now
  sets the selection to the click point.
- **"Place tile" is on by default** for pool-based tilemaps (a definition with
  `graphics.whole`), left-drag stamps, and a multi-tile selection picked in the
  pool panel still pastes as a block. Picking a single tile in the pool panel
  also sets `pickedTile`, so "click a tile on the right, click where you want
  it" works.
- **Painting the pool panel now works.** `saveGraphics()` used to bail out for a
  `ROMArray` (`// ignore ROMArray objects for now`), so painting a boss's tile
  pool silently did nothing; with `whole: true` it now writes each byte back
  into the item that owns it. The toolbox also shows the Tool menu for pools
  (`ROMGraphicsView.paintablePool()`), and `commitPaint()` saves through the
  definition. Map tilesets stay read-only in the toolbox.
- **Odin and Leviathan (tilemaps 22, 23) were garbled.** Bit 5 of their pointer
  means "this boss is a summon: load from bank `$0C` and flip it" (`2F/A40B`),
  and the ROM stores those two tilemaps **right-to-left** - a row reads
  `73 72 71 70` - while the copy flips each tile's pixels. `"mirrorX": true` on
  the definition mirrors the layout *and* the tile pixels for display, and
  `setTilemap()` un-mirrors before saving, so the ROM keeps its own order (the
  app test asserts it stays byte-exact).
- **Boss tilemaps are lossless.** `ff3BossTilemap` keeps a background cell
  (byte < `$70`) as `0x100 | byte` in the word's tile field instead of
  collapsing it to 0: `3F/F90A` copies all 216 bytes into the nametable, so the
  old format rewrote 3798 background cells as 0 the moment you edited one tile.
  `tools/ff3-nes-xcheck.js` asserts all 5184 boss cells round-trip byte-exactly.
- `format.blank` is honoured by `paintCell()`, so clicking with nothing picked
  clears a cell to a real blank instead of tile 0.
- **Arrow keys**: the layout pane takes keyboard focus, so Up/Down only scrolled
  it. `ROMTilemapView` now forwards them to `romNavigator.moveSelection()` -
  the same trap as §3.8.
- Tests for all of this are in `tools/ff3-nes-app-test.js` (43 checks).

### B2. Painting the palette cells

The convenient way to change which palette a part of a sprite uses:

- **Monster graphics**: Tool → *Palette cells* (key `C`). Select a palette row
  in the palette panel, then click or drag over the 2x2 cells; the bit is
  written straight into `monsterAttributeData` and the picture follows.
- **Boss tilemaps**: the *Paint palette cells* checkbox beside the layout does
  the same into `bossAttributeData`.
- Both go through `setAttributeBit(object, cell, value)` in `rom/romtools.js`,
  which undoes the per-monster inversion before writing (painting "palette 2" on
  a boss writes a 0), plus `attributeCellForTile()` for the cell index.
- `attributeRef` covers both table shapes: one byte per item (monsters) or one
  whole 7-byte record per item (bosses); the first item's `data.length` decides.

### B3. Multiple forms, multiple palettes

A monster's colours come from its **battle group**, so one graphic can appear in
several colourings - Dark Cloud's forms use `#202+#27`, `#78+#250` and
`#222+#223`, and a monster and its boss differ by the invert bit. The generator
now emits **every pair its battles use** (up to 8, most common first) as
separate composed entries in the palette dropdown -
`[[pal1,pal2], [pal1,pal2], …, battlePalettes]` - labelled e.g.
`くらやみのくも (1) #202 + (2) #27`, so the forms are switchable. 88 of the 96
graphics offer more than one pair. The cell split itself does not change between
forms: it is keyed by tilemap index, not by monster.

### C. Transparency

Unchanged: `"Colour 0 transparent"` is a **display toggle**
(`this.transparentBack`, off by default). Index 0 is both the backdrop and the
outline colour in FF3, so the black box is genuinely in the ROM - do not "fix"
this by flipping `backColor` in the definitions; that already swung twice
(see HANDOFF.md §5). If a better answer exists, it needs the sprite silhouette,
not the palette.

### D. Remaining gaps

- The two summon-backed bosses are now *displayed* the way the game draws them
  (mirrorX), but painting their pool edits tiles the summons use too - the pool
  is shared with `summonTilemap`s.
- Summon sprite palettes: summons use 3 sprite palettes
  (`battlePalettes[byte1 .. byte1+2]`); bosses use 2 BG palettes. Verified for
  bosses against rips, not for summons.
- `2F/A820` loads the boss attribute record from monster **slot 0** only
  (`LDA $7D74`, unindexed) - fine, since a type-9 formation has one monster.
- A graphic shared by a monster and a boss shows one invert setting at a time;
  the generator picks the representative battle, and "Swap palette cells" shows
  the other. (Painting a cell already accounts for it.)
- `ff3-map.js changeLayer('showRooms')` is guarded: FF3 has no `mapPalette`
  assembly (the palette comes from `mapPaletteBase`, `3A/9091`).
- The pool panel in a boss view has no "which cells of this pool does this boss
  use" highlighting.

---

## 3. Gotchas that already cost days — do not relearn them

1. **NES definition ranges are mapper-mapped, not file offsets.**
   `file = ((addr & 0xFF0000) >> 3) + (addr & 0x1FFF) + 0x10` (mmc3).
2. **Def addresses alias above `$9FFF`**: only `$8000-$9FFF` address a bank's
   8 KiB, so `$A000-$BFFF` alias the same bytes. Consequences: a range ending at
   `$BFFF` must be written as the *next bank's* `$8000`; and any tile/byte
   arithmetic must be done in **file space**, never by subtracting def
   addresses. (Boss pools: 64 tiles, not 576.)
3. **Boss pointer format is `bbs---tt tttttttt`**: bits 7-6 = bank id, **bit 5**
   = summon flag (load from bank `$0C`, flip), bits 1-0 + low byte = a 10-bit
   tile index inside a **16 KiB window** (an MMC3 bank pair), so
   `file = bank*0x2000 + tile*16 + 0x10`. Reading the bank from bits 1-0 made
   22 of 24 bosses render garbage (Land Turtle came out as a horse).
4. **Every byte must have exactly one owner assembly.** Two assemblies covering
   the same range = last-writer-wins on save and stale-copy corruption. The
   overlap test in `ff3-nes-xcheck.js` exists for this. That is why boss/summon
   pools are *referenced* (`graphics` + `whole: true` + `range`) rather than
   duplicated, and why the gaps between class arrays got `monsterGraphicsSpareN`.
5. **`ROMArray` with a fixed `arrayLength` writes only its items' bytes.** If
   you widen an array's range past its items, the tail is zeroed on save.
6. **`ROMProperty` reads multi-byte values little-endian**, then masks and
   shifts. A 2-byte field with mask `0xFFFF` is `lo | hi<<8`.
7. **`ROMPaletteView.loadPalette` only loads `definition[0]` for an array** of
   palette definitions; composition needs the `compose` flag we added.
8. **Opening an object calls `ROMGraphicsView.selectObject()` → `this.div.focus()`**,
   which steals focus from the left pane; the arrow-key handler lives on
   `leftPane.onkeydown`. Any pane that grabs focus must forward ArrowUp/ArrowDown
   to `romNavigator.moveSelection()`.
9. **`replaceData` bails if handed the same buffer** — always pass a copy.
10. **Test harness traps**: synthetic `MouseEvent`s can't set `offsetX/offsetY`
    (use `Object.defineProperty` or real `clientX/clientY`); driving painting
    requires `view.paintStart = view.graphics.slice()` first; `document`/DOM in
    Node is stubbed by `tools/node-dom-stub.js`, and class declarations are only
    visible inside the single `(0,eval)(src)` blob — put test code in the same
    eval, and set `globalThis.require = require` first.
11. The English translation's text table uses **two-byte character codes**
    (`0xD0D2 = "ill"`); any decoder outside the app must try
    `decodingTable[(b1<<8)|b2]` before `decodingTable[b1]`.
12. **A view that takes focus must forward the arrow keys.** Both `ROMGraphicsView`
    and `ROMTilemapView` call `div.focus()`, and the tree's handler lives on
    `leftPane.onkeydown` - each pane needs its own `onkeydown` that calls
    `romNavigator.moveSelection()`.
13. **`mouseDown` must move the selection to the click point.** The tilemap
    paint path reads `selection.x/y`, which only `mouseMove` kept up to date, so
    a click without a preceding move painted the wrong cell (and in a synthetic
    test, always the wrong cell).
14. **`ROMArray` items are not always one byte.** `monsterAttributeData` is 192
    one-byte items, `bossAttributeData` is 24 seven-byte items. Anything that
    indexes a record by byte offset must read the first item's `data.length`
    (see `setAttributeBit`), or it silently edits the neighbour's record.
15. **A palette definition can be a list of composed pairs**
    (`[[{...compose}, {...compose}], [...], "battlePalettes"]`);
    `ROMPaletteView` renders each inner list as one dropdown entry labelled
    `name1 + name2` and loads it composed. Anything that walks `item.palette`
    (the xcheck) has to handle both shapes.

---

## 4. Where the ROM facts came from

Disassembly and ROM map: `/localhost/game-server/client/roms/nes/FinalFantasyIII/etc/ff3/`
(`rom-map.txt`, `ff3j.asm`, `battle-ram.txt`). Routines that matter for this
work: `2F/A42E` (monster graphics selection), `2F/A4B4`/`2F/A4CC` (size classes),
`2F/A86C` + `2F/A8D8` + `2F/A8E4` (attribute data), `2F/A6FB`/`2F/A78D`/`2F/A7D4`
(per-cell palette), `2F/A3B8` (boss graphics pointer), `3F/F90A` (boss tilemap
copy), `2F/AB3D` (character graphics), `2F/A15F` (character pose sub-blocks),
`32/91CB`/`32/972E` (character sprite frames), `32/8CEF`+ (summon properties),
`2E/9E28` (battle palettes), `2E/9E4A`/`2E/9E4E` (job sprite palettes).

Found while fixing the palettes: **`2F/A0E7`** (monster id → the two property
bytes: the attribute record id and its per-class offsets), **`2F/A820`** (boss
attribute data, 7 bytes at `$2E:$8FC0`), **`2F/A5E6`-`2F/A696`** (formation
position data - where `2F/A78D` gets the cell grid from), **`2F/A2D0` +
`2F/A4A4`** (first tile id per monster group vs the PPU address per size class,
which is why 4x4 art sits two rows low in its slot) and `2F/A15F` sub-block 0
(`7900 20A0 1C 00`: the monster tilemap is copied to PPU `$20A0`, nametable
row 5 - that is the `-5` in `2F/A2D4`).

The disassembly is its own git repo. `ff3j.asm` is 56k lines: grep for the
label (e.g. `grep -n "2F/A0E7" ff3j.asm`) rather than reading it end to end.

ROMs in the repo: `Final Fantasy III (Japan) (fixed).nes` (crc `99F5DB31`,
matches `ff3j-nes.json`) and `Final Fantasy III (Japan) (fixed) (English).nes`
(crc `FA04837F`, matches `ff3u-nes.json`). Their graphics regions are
byte-identical; only text banks differ. Two mislabelled dumps are fixed by
`patches/ff3j-nes-fix-dump.ips` and `patches/ff3u-nes-fix-dump.ips`.

## 5. Definition-level extension points you will want

- `ROMArray.itemPalettes[i]` → per-item `palette` (supports arrays with
  `path`/`offset`/`name`/`compose`).
- `ROMArray.itemAttributes[i]` → per-item `attributeCells` (a string of '0'/'1'
  per 2x2 tile cell), consumed by `ROMGraphicsView.paletteBitsForTile()`.
- `graphics: {path, whole: true, range}` in a tilemap → load the whole array's
  *decoded* items as one contiguous tile pool, sliced by byte range.
- `GFX.tileFormat.*` custom formats can pack per-tile palette bits into the
  tilemap word's `0x00FF0000` field (see `ff3SummonTilemap`).
- `ROMPaletteView.paletteSegments` / `targetForColor(index)` map a palette
  buffer position back to the ROM object that owns it.

Nothing is committed yet. When you finish a change, run the full suite in §1 and
keep all three round-trips at 0 diffs.
