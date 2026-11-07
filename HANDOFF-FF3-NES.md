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
2. **`$2E:$8F00` bit 7 selects the EOR** (`2F/A89C AND #$80` → `2F/A8BF EOR
   #$FF`) and is set for every id `$80-$FF`. Read literally, that inverts every
   boss - **and that is wrong on screen.** All 24 boss tilemaps, and all 8
   boss-ids that have reference rips, render correctly with the cells *not*
   inverted: confirmed in-game for Gomoree, Medusa and Dark Cloud, and by
   `tools/ff3-nes-palcheck.py`, which went from 25/36 exact to **33/36** as soon
   as the flag stopped being applied (the remaining 3 - Rukh, KillerBee, Chimera
   - are bad rips: no variant explains them). The records at `$2E:$8FC0` are
   evidently already authored in the boss's orientation, so `ff3-nes-names.py`
   records `invert: false` behind an `APPLY_INVERT_FLAG = False` constant.
   (A side quest - reading `2F/A133-2F/A141` as a shift loop and deriving
   "bit (6-(id&7)), 0 when id&7==7" - was a dead end; it fixed 2 cases and broke
   none of the evidence. Don't re-derive it.)
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
- **Odin and Leviathan (tilemaps 22, 23) were garbled - twice.** Bit 5 of their
  pointer means "this boss is a summon: load from bank `$0C` and flip it"
  (`2F/A40B`), and their tilemaps do read right-to-left (`73 72 71 70`). The
  first fix reversed the columns *and* flipped the pixels, which mirrors the
  image twice and leaves it scrambled. Read the copy routines: `3F/F90A` copies
  the tilemap **as stored** (no column reversal) while `3F/F94F` builds a
  bit-reversal table that `3F/F970` pushes every graphics byte through
  (`$92` = "use horizontal flip table"). So `mirrorX` now only sets the
  per-tile pixel-flip bit and leaves the ROM's tile order alone - and saving
  stays byte-exact for free, because `ff3BossTilemap.encode` masks to `0xFFFF`
  and the flip bit is display-only.
- **Two tree sections, two jobs.** `Boss Tilemaps` / `Summon Tilemaps` are the
  placement views (Place tile + Paint palette cells, no Tool menu). `Boss
  Graphics` / `Summon Graphics` are 24 + 8 **windows** - one per creature - that
  open in the ordinary `ROMGraphicsView` with Select / Pencil / Fill / Colour
  picker / Palette cells, exactly like a monster graphic.
  - `{"window": {"path": <owner>, "offset": <decoded bytes>, "tiles": n}}` in
    `rom/romtools.js`: `disassemble` reads the owner's decoded slice,
    `replaceData`/`setData` delegate to the owner (so it stays one undoable
    action on the right bytes), and `assemble` returns early - **a window never
    owns bytes**, which is what keeps the "one owner per byte" rule intact
    (windows have no `range`, so the xcheck's overlap test ignores them).
  - `{"layoutFrom": "bossTilemapN"}` makes the window display its tiles **in the
    order the tilemap places them** (`ROMGraphicsView.applyLayoutFrom` sets
    `poolLayout`/`poolFlip`), so you see and paint the creature, not a sheet of
    loose pieces. `tileOffset()` resolves through `poolLayout`, which is what
    keeps the painted pixel landing on the right tile.
  - Traps hit while building this:
    - **A `ROMArray`'s own `.data` is still the encoded planes** (the array has
      no format). A window whose source is a size-class array must read the
      concatenation of its **items'** decoded data - the same thing
      `ROMGraphicsView.loadGraphics` does for `whole: true`. Getting this wrong
      made every boss whose pool sits in a class array (Big Rat, Jin, Ninja,
      Kunoichi, GutzCo, General, Kraken, Land Turtle, Cerberus) come out black
      or garbage, while the spare-region bosses looked fine.
      `ROMGraphics.windowSourceBytes()` handles both.
    - `replaceData` has to do the inverse: split the write across the covered
      **items**, one `item.replaceData` per overlap.
    - **A window is a mirror of bytes it does not own**, so it must re-read when
      they change - including on undo, which notifies the *owner*, not the
      window. `disassemble` registers an observer on the source and on each of
      its items. (`addObserver(object, target, callback, args)` is positional -
      passing one object makes `callback` undefined.)
    - The display mapping must be applied in **both** branches of
      `updateTilemap` (toolbox *and* editor - a tree selection is editor mode),
      and `updateTilemap` must not reset `width`/`height` from `object.width`
      when a `poolLayout` is in force.
    - The flip comes from the tilemap object's **`mirrorX`**, not from the
      stored words: the ROM never carries a flip bit, the game flips at copy
      time. Reading the words gave Odin and Leviathan the "jumbled" look again.
  - `poolBytes` is clamped to the tiles the container can actually supply
    (`poolTiles`); without the clamp a boss's range ran past the end of its
    array and the window read garbage.
  - The app test now compares **all 24 boss and 8 summon windows** byte-for-byte
    against the pool bytes the tilemap path reads, and rejects any that are all
    black - that is the regression guard for this whole class of bug.
  - `poolBytes` is clamped to the tiles the container can actually supply
    (`poolTiles`); without the clamp a boss's range ran past the end of its
    array and the window read garbage.
- **The pool panel follows the layout** (`"followLayout": true`, kept in step by
  `ROMTilemapView.syncPoolLayout()`, which also hands the per-cell palette bits
  over as `graphicsView.cellsObject` so both panels colour identically).
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
- **The rule now: the palette row you paint with is applied to the 2x2 cell you
  touch, live, as part of the same gesture.** Pencil paints a pixel *and* moves
  its cell onto the selected row; Fill does it for every cell the region
  covers; the Color picker selects the row that cell actually uses (so the
  panel follows the part of the sprite you clicked). The *Palette cells* tool
  (key `C`) stays, for re-palettizing a cell without touching any pixel. Boss
  and summon **graphics windows** get all of it, because a window carries the
  same `attributeRef` as its tilemap.
- A stroke is **one** undo step (`beginAction`/`endAction` around pixels and
  cell writes), and undo/redo revert both the bytes and the picture. It must be
  closed even when the button is released **outside** the canvas -
  `finishStroke()` is called from the canvas mouseup *and* a document-level
  mouseup safety net, because an unclosed group leaves nothing on the undo
  stack and a stuck `painting` flag makes the reload guard skip every refresh
  (undo then looks dead).
- The picker keeps the two concepts separate: `this.color` is the raw NES index
  in the buffer (0..colorsPerPalette-1) and `paletteView.p` is the palette row.
  Folding the row into the index puts the color out of range and the eyedropper
  renders as transparent. The cursor tint reads
  `palette[p * colorsPerPalette + index]` so it matches what painting produces.
- **There is deliberately no "Swap palette cells" toggle.** The inversion is a
  ROM fact and is always applied; the equivalent choice (which of the two
  palettes counts as "first") is offered as an extra entry in the *palette*
  dropdown, which users already understand.
- **Clicking a palette row must not recolour the sprite.** `updateTilemap` used
  to add `paletteView.p * colorsPerPalette` as a base offset for every tile, so
  selecting row 2 shifted the whole image - wrong once per-cell bits drive the
  palette. The base is 0 whenever the object has cell bits; the row only says
  what painting will write.
- Mechanics that bit us, all now asserted in `tools/ff3-nes-app-test.js`:
  the palette choice is baked into `this.tilemap` by `updateTilemap()`, so a
  cell write must go through `refreshPaletteCells()` (otherwise the change is
  in the file but invisible until some other reload - it looked like it only
  applied on mouse-up); cells are addressed in **tiles**, so pixel callers use
  `attributeCellForPixel()`; and `paintPixel`/`floodFill` must not early-return
  when the pixel already holds the paint index (the DiveEagle case: paint the
  4th color of row 2 over pixels that already hold index 3).

### B2b. The boss pool panel follows the layout

A boss's tiles come from a shared pool, and shown as a raw sheet the pool panel
reads as noise (the summon blocks do too - their tilemaps reference tiles out of
raster order). With `"followLayout": true` on the graphics definition,
`ROMTilemapView` hands the graphics view a `poolLayout` (display cell → pool
tile), so the panel reads as the creature and Pencil/Fill in it paint the part
you are looking at. `ROMGraphicsView.tileOffset()` resolves the byte offset
through that layout, which is what keeps painting correct.

Two traps:
- `#edit-controls` is **one shared bar** - whoever calls `resetControls()` last
  owns it. The toolbox graphics view never gets its own `resetControls()`, so
  `ROMTilemapView.resetControls()` calls `this.graphicsView.resetControls()`
  first; doing it from `loadTilemap()` instead wipes the layout's own controls.
- The toolbox needs the Tool menu explicitly: `paintablePool()` (a definition
  with `graphics.whole`) is what makes Pencil / Fill / Colour picker appear for
  a boss or summon pool. Map tilesets stay read-only on purpose.

### B3. Multiple forms, multiple palettes

A monster's colours come from its **battle group** (`2E/9DA2`: palette1 -> BG
palette 0, `2E/9DAD`: palette2 -> BG palette 1), so one graphic can appear in
several colourings - Dark Cloud's forms use `#202+#27`, `#78+#250` and
`#222+#223`. The generator emits **every pair its battles use** (up to 8, most
common first) as separate composed entries in the palette dropdown -
`[[pal1,pal2], [pal1,pal2], …, battlePalettes]` - labelled e.g.
`くらやみのくも (1) #202 + (2) #27`. It also emits the **reversed** pair of each
(`#243, swapped + (2) #248`), because exchanging the two palettes is exactly
equivalent to flipping every cell bit, and that is the one degree of freedom the
reference rips disagree about (§C2). The cell split itself does not change
between forms: it is keyed by tilemap index, not by monster.

### C. Transparency

Removed as a control. Index 0 is both the backdrop colour and the outline colour
in FF3, so the black box is genuinely in the ROM and a "Colour 0 transparent"
toggle only ever deleted outlines. Do not reintroduce it, and do not try to fix
it by flipping `backColor` in the definitions - that already swung twice (see
HANDOFF.md §5). A real solution would need the sprite silhouette.

### C2. Palette verification - `tools/ff3-nes-palcheck.py`

The "are the palettes actually right?" check, and how it works, because it is
the only way to answer it at scale:

1. **Calibrate the rip site's NES palette.** videogamesprites.net renders NES
   colours with its own emulation, so comparing RGB against a hand-picked table
   fails (our magenta is `(140,24,184)`, theirs is `(219,0,205)`). The tile data
   is not in doubt, so for a monster we know which NES *palette byte* every rip
   pixel must be. Pairing our colour counts with the rip's (they agree exactly
   when the model is right) yields observations "NES byte X renders as RGB", and
   iterating that to a fixed point recovers the site's table.
2. **Score the model against that table**, and score two alternatives: the two
   palettes exchanged, and the invert bit dropped. Note that **exchanging the
   palettes and flipping every cell bit are the same picture**, so a monster
   that wants "swapped" is a monster where the pair order and the invert flag
   disagree - the image alone cannot say which is wrong.

Result over the 36 monsters that have rips: **33 exact**; the 3 that no variant
explains (Rukh 65%, KillerBee 77%, Chimera 96%) are bad rips - Enemies/Hornet
holds the right tiles in the wrong places, and those three are the same kind of
hand-assembly error. **Zero cases prefer the swapped pair or the inversion**,
which is the evidence for `APPLY_INVERT_FLAG = False` (§2A.2).

The dropdown still offers the reversed pair of every palette pair
(`... #243, swapped + (2) #248`) as a safety valve, since exchanging the two
palettes is exactly equivalent to flipping every cell bit.

Run it with `python3 tools/ff3-nes-palcheck.py [--report]` (needs the network
once; rips are cached in `/tmp/ff3-rips`).

### D. Remaining gaps

- A window's `range` is empty, so anything that assumes `assembly.range.length`
  (relocation, the property pane's address display) needs care.
- The two summon-backed bosses are displayed the way the game draws them
  (`mirrorX` = per-tile pixel flip), but painting their window edits tiles the
  summons use too - the pool is shared, by design.
- Summon sprite palettes are **known-wrong and deliberately parked** (user's
  call). What the ROM does: `32/8D32` takes the starting palette id from
  `summonProperties` byte `1 + summonAttackId` (so each attack has its own
  triple), `32/8D3A/45/50` load three **consecutive** battle palettes into
  sprite palettes 0-2 (`$3F10/$3F14/$3F18`), and `32/8CBA` then *cycles* four
  sprite palettes during the animation (`32/8CDA` shifts each palette's colors,
  16 steps), with `32/8CA7` fading them. So a still image of a summon in game is
  an animated derivative of the stored palettes, not the stored palettes - which
  is most likely why they "don't look close". The generator offers all three
  attack triples in the dropdown; nobody has verified them against rips.
- `2F/A820` loads the boss attribute record from monster **slot 0** only
  (`LDA $7D74`, unindexed) - fine, since a type-9 formation has one monster.
- `ff3-map.js changeLayer('showRooms')` is guarded: FF3 has no `mapPalette`
  assembly (the palette comes from `mapPaletteBase`, `3A/9091`).
- The pool panel inside a tilemap view still exists (`followLayout`) and is
  handy, but it duplicates the new Boss/Summon Graphics entries.

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
16. **`#edit-controls` is a single shared bar.** Every editor's
    `resetControls()` clears it, so the last one to run wins. The tilemap view
    builds the toolbox graphics view's Tool menu from inside its own
    `resetControls()`, before its own controls.
17. **The pool panel is a tile sheet, not a picture.** Boss and summon tilemaps
    reference pool tiles out of raster order, so `followLayout` +
    `poolLayout` exist; `tileOffset()` must resolve through it or painting
    writes to the wrong tile.
18. **The invert bit is not a plain bit index** - see §2A.3. `ASL` runs inside
    the loop, so `AND #$80` tests bit `(6 - (id & 7))`, and 0 for `id & 7 == 7`.
19. **Reference rips are hand-made and sometimes wrong.** Enemies/Hornet holds
    the right tiles in the wrong places; 6 boss ids disagree with the ROM's
    invert flag. Prefer the disassembly, and treat a rip as evidence only when
    the calibrated-palette histogram agrees (§C2).
20. **`mirrorX` is a pixel flip, not a layout flip.** The ROM's tile order is
    already the nametable order (`3F/F90A` copies it verbatim); the mirror comes
    from the bit-reversal table in `3F/F94F`/`3F/F970`. Reversing the columns as
    well mirrors twice and looks scrambled - which is how it looked wrong in the
    layout panel while the pool panel (which never reversed) looked right.
21. **Class bodies allow duplicate method names and the last one wins**, and
    `this.redraw();\n    }` appears in several methods - a `fs_replace` on that
    pattern hits them all. Factor shared logic into a named method
    (`syncPoolLayout`) and call it from one place.
22. **Cell coordinates are in TILES, pixels are not.** `attributeCellForTile()`
    takes tile coordinates (a cell is 2x2 tiles) and is used by the tilemap
    view's selection; the graphics view works in pixels. Passing pixels gave a
    cell index past the end of the record, so `setAttributeBit` silently
    returned false and nothing about the palette tools appeared to work.
    `attributeCellForPixel()` does the conversion.
23. **Writing an attribute byte does not repaint anything.** Which palette each
    tile is drawn with is baked into `this.tilemap` by `updateTilemap()`, so
    after `setAttributeBit` you must call `refreshPaletteCells()`
    (`_cellsFor = null; updateTilemap(); redraw()`, plus the tilemap view's
    `applyPaletteCells()`). Without it the change is in the file but invisible
    until some other reload happens - which is exactly why it looked like it
    only applied on mouse-up.
24. **Do not early-return from `paintPixel`/`floodFill` when the pixel already
    holds the paint index.** For an object with a per-cell palette table the
    cell still has to move onto the selected palette row; `floodFill`'s
    `if (target === this.color) return;` was silently killing whole fills.
25. **A second assignment block in the same constructor can undo the first.**
    `ROMGraphics` had the `attributeCells/attributeRef/...` block twice; the
    later one re-assigned `attributeCells` from `definition` (undefined), which
    made `attributeCellBits()` return null and color-picking a boss window read
    index 0 - it looked like it was "picking transparency".
26. **`paletteView.definition` is part of the contract** (tests read it and call
    `rom.parsePath` on it) - keep it a plain string path, not `{path}`.
27. **A summon tilemap with a graphics `range` needs `"tileOffset": 0`.** The
    range already starts at the summon's block; adding the `summonProperties`
    graphics index on top pushes every cell past the slice and the center panel
    goes black.
28. **Never fold the palette row into the paint color.** The graphics buffer
    holds the raw NES index (0..colorsPerPalette-1); the row is `paletteView.p`.
    `pickColor` used to do `c += row * colorsPerPalette`, which put `color` out
    of range - the eyedropper cursor and the swatch then rendered as
    transparent/black. `setColor()` documents the same rule.
29. **A stroke released outside the canvas stays open** unless something closes
    it: the canvas' `onmouseup` never fires, so the `beginAction()` group is
    never pushed to the undo stack (nothing to undo) and `painting` stays true,
    which makes the reload guard skip every later refresh - undo then *looks*
    dead even when it works. `ROMGraphicsView.finishStroke()` is called from
    both the canvas mouseup and a document-level mouseup safety net; the
    tilemap view has the same net for its palette-cell strokes.

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
