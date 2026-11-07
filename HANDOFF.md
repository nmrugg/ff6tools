# FF6Tools work log / LLM handoff

Status of a feature branch of [ff6tools](https://github.com/everything8215/ff6tools)
(browser-based Final Fantasy ROM editor). Written so another LLM can continue
without re-deriving anything below.

---

## 1. Ground rules you must know before touching definitions

These cost days to learn; do not relearn them.

**NES definitions do not use file offsets.** A `range` in an NES `.json`
definition is in the tool's *mapper-mapped* address space. Convert with the
same formula `rom/romtools.js` uses (`ROM.MapMode`):

```js
// mmc3 (also used for FF3J, which is mapper 4 / MMC3)
fileOffset = ((addr & 0xFF0000) >> 3) + (addr & 0x1FFF) + 0x10;
```

Example: FF3J def range `0x03A000` → file `0x006010`. Getting this wrong makes
every graphics dump look like random noise. The 16-byte iNES header is included
in the mapped space (the `+ 0x10`).

**GBA definitions DO use real GBA addresses** (`0x08000000`-based); the ROM
object subtracts the base via `mapAddress`.

**ROM round-trip is the safety test.** Load a ROM, change nothing, `assemble()`.
The output must be byte-identical. If it isn't, your definition change is
corrupting data. Run this after *every* definition change:

```
node tools/rom-harness.js        # must print "diffs vs original: 0"
```

**`ROMAssembly.replaceData()` bails if handed the same buffer it already
holds** (`compareTypedArrays` returns equal). Always pass a copy, e.g.
`Uint32Array.from(obj.data)` or `arr.slice()`. The same aliasing bug existed
upstream in the graphics view (see §3).

**`ROMArray` with `pointerObject` de-duplicates.** Items are ordered by sorted
pointer value, so the array index is *not* the monster id. The stable handle is
`propsArray.item(id).thePointer.target`. Never assume `array.item(id)`.

**Fragmented arrays have overlapping ranges**, which used to make
`ROMData.assemble()` relocate blocks whose size had not changed. Fixed: an
assembly whose `assembledLength === range.length` is now left in place. This is
what makes byte-exact undo possible.

**Undo is driven by the action stack.** `ROM.prototype.assemble()` calls
`markAsDirty()` on every action object in `undoStack`/`redoStack`, which clears
`lazyData` and forces a re-encode. Byte-exact undo works because
`disassemble()` caches the *original* encoded bytes in `pristineCache`; if the
decoded data ever returns to that exact snapshot, the original bytes are written
back instead of re-encoding.

---

## 2. FF V Advance (GBA): monster graphics editor — DONE

The FF5 definitions had `monsterGraphics` as one opaque 1472-entry array with
graphics and palettes **interleaved in a single pointer table**, so nothing was
editable. Restructured it the way FF6 and the FF5 portrait code already work:

- `monsterGraphicsProperties` — the pointer table read as 736 records of
  `{graphicsPointer, palettePointer}` (mask `0x7FFFFFFF`, `pointerTo` each other array)
- `monsterGraphics` / `monsterPalettes` — fragmented arrays pointed at by those records
- `ff5/ff5-battle.js` resolves through `.target` instead of `item(id*2)`

Two new generic definition keys in `rom/romtools.js` (`ROMArray`):

- `sizeFrom` — copies width/height (in tiles) from a record that points at the
  array, and can pin each graphics object to its exact palette via
  `linkPalette: {pointerPath, arrayKey}`. FF5 uses `monsterSize` for dimensions.
  Needed because de-duplication breaks the index↔id correspondence.

Result: `Battle → Monster Graphics` (308 unique sets) and `Battle → Monster
Palettes` (310), labelled with monster names (e.g. `Magic Pot`, `Wyvern`).
Names were generated from the ROM by `tools/ff5e-gen-names.js` +
`tools/insert-names.js`.

Bugs found and fixed along the way (all upstream, all real):

1. `tose-graphics` / `tose-palette` `decode()` ignored the count in their own
   header (`data.slice(8)` instead of `slice(8, 8 + count*size)`). For FF5's
   interleaved layout every palette swallowed the following block: 248 colours
   instead of 16, and editing one would have written 504 bytes over 48.
2. `ff5e-gba.json` `freeSpace` was written backwards
   (`0x088588D8-0x08800000`, end < begin ⇒ empty), so there was nowhere to
   relocate grown blocks. Corrected to the real free regions.
3. Graphics import silently did nothing: `this.graphics` aliased `object.data`
   (so `replaceData` saw no change) and `saveGraphics(null)` returned early in
   editor mode.

---

## 3. In-app graphics painting — DONE

`ROMGraphicsView` now has real editing tools (previously it was export/edit-
externally/import only, and the palette panel was read-only):

- **Tool** menu: Select / Pencil / Fill / Colour picker. Keys `V` `B` `G` `I`.
  Default is **Pencil** in editor mode; toolbox views keep Select.
- **Right-click is always the eyedropper**, and works anywhere in the pane;
  it also tracks while the button is held and dragged. The cursor becomes an
  eyedropper while held, and the dropper cursor's bulb is tinted with the
  currently selected colour (cursor art is generated at runtime as PNG via
  canvas — SVG cursors are unreliable).
- **Palette swatches**: click selects the paint colour (highlighted);
  **double-click or right-click opens a native colour picker** and writes the
  new RGB back through the palette object.
- **Copy / paste**: `Clipboard` menu or `Ctrl+C` / `Ctrl+V`. Pasted data becomes
  a floating layer (semi-transparent, blue border) that you drag; **Enter** or
  clicking outside commits, `Esc` cancels. The layer is clamped inside the
  image and colour 0 never overwrites.
- **Delete / Backspace** clears the selected area to transparent.
- **Middle-click pans.** Implemented as a CSS `transform` on a wrapper, *not*
  scroll offsets, because with centring there is often nothing to scroll. The
  pane is `overflow: hidden` (class `.graphics-edit-pane`, scoped so the map
  editor keeps its scrolling). Middle-click is intercepted at the **capture
  phase** with `preventDefault` + `stopImmediatePropagation` plus an `auxclick`
  guard, otherwise Chrome starts autoscroll.
- **Wheel zoom** anywhere in the pane (not just over a small image), anchored
  at the cursor. `Shift`/`Alt`+wheel still scrolls.
- **Centring**: the image is centred in the pane; the pan resets only when a
  *different* object is selected (re-selecting the same object happens after
  every edit and must not reset the pan).
- **Overlay toggles**: `Image bounds` (off by default) dims the pane outside the
  image and shades grid cells with no data; `Tile grid` (off by default) draws
  light 8×8 lines. The wrapper only gets its own opaque backdrop when bounds is
  on, otherwise its checkerboard would not line up with the pane's.

Navigator: **Up/Down arrows move the selection** between rows instead of
scrolling, and when you run off the end of a section they expand the *immediately
next* section and step into it (movement is scoped to the current section
first). Also fixed an upstream bug where `ROMNavigator.selectObject()` did
`li.childNodes[object.i]` even for leaf rows, putting the `selected` class on
the index `<span>` so tree rows never highlighted.

**Regression worth remembering:** opening an object calls
`ROMGraphicsView.selectObject()`, which does `this.div.focus()` so the paint
shortcuts work. That steals focus from the left pane, and the arrow handler
lives on `leftPane.onkeydown` - so Up/Down stopped moving the tree selection
entirely. `ROMGraphicsView`'s own key handler now forwards ArrowUp/ArrowDown to
`romNavigator.moveSelection()` (unless a pasted layer is floating). Any future
pane that grabs focus must forward the arrows too.

**Deliberately NOT done:** map tileset painting. `Map Tilesets` / `World Map
Tilesets` go through `ROMTilemapView` (a different toolbox graphics view) and
the map editor itself uses per-game `*MapTileset` classes (e.g.
`FF5MapTileset`), not `ROMGraphicsView`. A tileset is also shared by many maps,
so painting one silently alters every map using it. Reverted; treat as a
separate feature needing an explicit shared-tileset warning.

---

## 4. ROM dumps: every "bad" dump was a header-only difference

- **FF V Advance (Europe)**: the user's copy was `crc32 d0191ad8` vs the
  reference `7197117e`. It was **not** a bad dump — it had been *patched*:
  reset vector redirected `b 0x08001024` → `b 0x08FB0000`, ~3.2 KiB of injected
  code at `0xFB0000`, two game routines at `0x76D60`/`0x76DBC` replaced with
  `mov r0,r0; bx pc; b 0x08FB0055 / 0x08FB005D` trampolines, and the header
  ROM-complement check zeroed. 3108 bytes across 90 runs.
  → `patches/ff5e-europe-strip-boot-patch.ips` (5 records). Verified: applying
  it yields a file byte-identical to the reference; the app then auto-detects.
- **FF III (Japan) Famicom**: user's copy `crc32 4ea1e076` vs reference
  `99f5db31`. **The 512 KiB of PRG data is byte-for-byte identical** — only 5
  iNES header bytes differ (mapper 132 vs mapper 4, plus stray iNES 2.0 bytes
  at offsets 10, 11, 15).
  → `patches/ff3j-nes-fix-dump.ips` (23 bytes, 1 record). Verified identical.
- **FF III (English translation), same user**: `crc32 2d50b838` vs the
  `fa04837f` dump that `ff3/ff3u-nes.json` expects. Again **header-only**: the
  same 5 bytes (flags6 `42`→`43`, flags7 `08`→`00`, `70`/`07` at 10/11, and
  `01` at 15 — mapper 132 vs mapper 4 plus stray iNES 2.0 bytes). All 512 KiB
  of PRG data identical.
  → `patches/ff3u-nes-fix-dump.ips` (23 bytes, 1 record). Verified identical.

The two FF3 (NES) dumps are otherwise the same ROM: the English translation
(`fa04837f`) differs from the Japanese one (`99f5db31`) **only in the text
banks** — monster graphics, character graphics, boss tilemaps, monster
properties, battle sets and battle palettes are byte-identical, which is why
the same ranges work for both definitions.

Tools: `tools/ff3-nes-diff.py mine.nes reference.nes out.ips` (diff + IPS +
verify), and the FF5 equivalent diff/IPS work is described in §2/§4 history.

---

## 5. FF III (J and U) NES — monster / battle character graphics — DONE

`ff3/ff3j-nes.json` used to model only maps, the world map and text. Monster
and battle character graphics are now in the definition and editable with the
painting tools from §3. The same is true of `ff3/ff3u-nes.json` (the English
translation), see "Final Fantasy III (English translation)" below.

**Address-space gotcha that cost an hour:** in the mapped space only `$8000`-
`$9FFF` address a bank's 8 KiB; `$A000`-`$BFFF` alias the *same* bytes
(`addr & 0x1FFF`). A range that should end at `$BFFF` must therefore be written
as the **next bank's `$8000`**. Example: the toad/mini graphics end at file
`0x54000`, which is the last byte of bank 29, so the range end is `0x2A8000`,
not `0x29C000`. `tools/ff3-nes-xcheck.js` has a range test that catches this.

### Monster graphics (uncompressed NES 2bpp planar)

Per-monster selection is one byte at `$2E:$8B00` (file `0x5CB10`): bits 5-7 =
size class, bits 0-4 = index within the class. Class table `$2F:$A4B4`, sizes
`$2F:$A4CC`. Each class is a contiguous array whose stride is
`width*height*16`, so it is a plain fixed-length `ROMArray` of `type: graphics`
— no pointers, unlike FF5 (see §2).

| class | def range | file range | tiles | stride | entries |
|---|---|---|---|---|---|
| 0 | `208000-209000` | `040010-041010` | 4x4 | 256 | 16 |
| 1 | `209000-219400` | `041010-043410` | 4x6 | 384 | 24 |
| 2 | `228000-239600` | `044010-047610` | 6x6 | 576 | 24 |
| 3 | `248000-0x259600` | `048010-04B610` | 6x6 | 576 | 24 |
| 4 | `268000-269200` | `04C010-04D210` | 6x12 | 1152 | 4 |
| 5 | `269200-278400` | `04D210-04E410` | 12x6 | 1152 | 4 |

(The disassembly's own comments say "24 * 512 bytes" for the 6x6 classes; that
is wrong — 6*6*16 = 576. Trust the code, not the comments.)

Class 6 (`AND #$E0` = `$C0`, 38 monsters, mostly bosses) has **no flat
bitmaps**: the class table only has 6 entries, so the game reads the sizes
table as a class entry and takes a completely different path (see "bosses"
below). Six non-boss monsters (`$35 $46 $56 $68 $75 $7C`) also use class 6.

### Battle character graphics

`28/8000 + jobId*672` — 24 blocks of 42 tiles, **displayed two tiles wide**
(`width: 2, height: 21`). The characters are six 8x8 sprites in a 2x3 grid
(16x24 px), so a 14-tile-wide display scrambled every pose; two wide keeps the
rows aligned with the game's own sub-blocks:

| tiles | what |
|---|---|
| 0-5 | standing (2x3) |
| 6-7 | walking (replaces the bottom row) |
| 8-13 | kneeling / stone (2x3) |
| 14-29 | attack/cast animation frames (`2F/A17D`, 16 tiles at PPU `$1390`) |
| 30-35 | being hit (`2F/A177`) |
| 36-41 | dead |

Position/flip data pointers are at `32/91CB`, per-frame tile ids at `32/972E`
(`02: normal = 00 01 02 03 04 05`), per-slot tile offset `32/9295 = 01 0F 1D 2B`,
and the sub-block table at `2F/A15F` (source offset / PPU address / tile count /
bank per graphics id). The toad/mini pseudo-jobs (ids `$18`/`$19`) are 8 tiles
each at `29/BF00` (mini, file `0x53F10`) and `29/BF80` (toad, file `0x53F90`),
also two tiles wide.

Each job defaults to its own palette: `2E/9E4A` (job 0, per party slot — the
Onion Knight uses 0/1/2 by slot) and `2E/9E4E` (job id → sprite palette id 0-2)
map to `battlePalettes[$FC + id]`.

### Battle palettes

`$2E:$8C00` (file `0x5CC10`), 256 entries of **3 bytes**; colour 0 is always
`$0F` (black) — see `2E/9E37`. New palette format `nesFixedPalette`
(`rom/gfx.js`, registered in `ROM.dataFormat`) decodes 3 bytes to 4 colours
with black first and re-encodes by dropping colour 0. `nesPalette` alone was
not enough: it would render colour index 0 as the first stored colour.

**A monster's palette comes from its battle group, not from the monster:**
`$2E:$8400` (file `0x5C410`) is 256 records of 6 bytes = `palette1, palette2,
monsterId x4`, and `$2E:$8000` (512 x 2) maps a battle to one of those records.
Ids `$FB`-`$FF` are the menu window, character 0/1/2 and cursor palettes.

So the definition uses a new generic `ROMArray` key, **`itemPalettes`**
(`rom/romtools.js`: constructor, `definition` getter, applied at the end of
`disassemble`): an array indexed by item whose entries override the prototype's
`palette`. Each monster graphic is pinned to the palette its own battles use
(most common `palette1` among the groups containing it, then `palette2`, then
the whole array so the panel still offers all 256):

```json
"itemPalettes": [
    [{"path": "battlePalettes[137]"}, {"path": "battlePalettes[160]"}, {"path": "battlePalettes"}],
    ...
]
```

96 monster graphics get 86 distinct default palettes this way. Caveat worth
knowing: a monster's tiles can use **both** BG palettes 0 and 1 — the per-2x2
cell choice lives in the "monster attribute data" table at `$2E:$8F20`
(`2F/A8D8`/`2F/A8E4`: 1/2/3 bytes per monster by size class; classes 2 and 3
share the same 24 entries). The editor shows one palette at a time; switch with
the palette dropdown. `tools/ff3-nes-xcheck.js` asserts every pinned palette is
actually used by a battle group containing one of that graphic's monsters.

### Names are generated from the ROM

`tools/ff3-nes-names.py` decodes the game's own strings (monster names are text
ids `$520`-`$5FF` = monster ids `$00`-`$FF`; job names are `$1E2`-`$1F7`) and
produces the string tables, the `itemPalettes` lists and the boss metadata.
Every monster graphic is labelled with the monsters that use it (e.g.
`4x6 #3 = スケルトン, シャドウ`), every battle palette with the monsters whose
battle groups use it, and the 24 character blocks with their job.
`tools/ff3-nes-add-graphics.py` writes all of it into a definition; `--force`
resets the file from `git HEAD` first so re-running is idempotent.

### Final Fantasy III (English translation) — same work, English names

`ff3/ff3u-nes.json` (crc32 `0xFA04837F`) is the SoM2Freak/A.W. Jackson/N.C.
Corlett English translation of the same ROM. Its graphics data is
**byte-identical** to the Japanese dump in every region above (verified: only
the text banks differ), so the same assemblies were added there:

```bash
python3 tools/ff3-nes-add-graphics.py --def ff3/ff3u-nes.json \
        --rom "Final Fantasy III (Japan) (fixed) (English).nes"
node tools/rom-harness.js ff3/ff3u-nes.json     # with FF5E_ROM=<english dump>
node tools/ff3-nes-xcheck.js ff3/ff3u-nes.json "Final Fantasy III (Japan) (fixed) (English).nes"
node tools/ff3-nes-app-test.js "Final Fantasy III (Japan) (fixed) (English).nes" ff3u-nes
```

Because the text ids did not move (`$520` = monster 0 = "Goblin", `$1E2` = job
0 = "OnionKid"), the generated labels are the ROM's own **English** names:
`4x4 #1 = "KillerBee, Hornet"`, palette `0 = "Abai, Sleipnir"`.

**Text decoder gotcha:** the English table uses *two-byte* character codes
(`0xD0D1 = "ili"`, `0xD0D2 = "ill"`). `ROMTextEncoding.decode` tries
`decodingTable[(b1<<8)|b2]` before `decodingTable[b1]`; any external decoder
(like the Python name generator) must do the same or names come out mangled
("KerBee" instead of "KillerBee"). The Japanese table has no such codes.

### Fixed while doing this: `worldPalette` was bogus

`worldPalette` was at `0x008380-0x0083A0`, copied from the FF1 definition. In
FF3J that range is inside the world map tileset data (`0x008100-0x0083FF`), so
selecting "World Palette" edited tile ids and the tileset array wrote them back
again. World maps and normal maps share `3A/9091`, which loads the base palette
from **`0x009640`** (`mapPaletteBase`, 3 x 16 bytes) — `worldPalette` is gone
and the world graphics/tilesets now point at `mapPaletteBase`. Fixed in both
`ff3j-nes.json` and `ff3u-nes.json` (the world tileset data is identical in
both dumps). The world map graphics render correctly in the app afterwards
(green land / blue water instead of noise).

Still latent (not fixed): `ff3/ff3-map.js:558` dereferences `this.rom.mapPalette`,
which does not exist in the FF3J definition. It is only reachable from the
never-wired `showRooms` control, so it does not crash today.

### Transparency

Monster, character, boss and summon graphics all use `"backColor": false`, so
colour 0 is transparent and the sprite has no black box around it. (The
graphics objects own those bytes; only the *tilemap* views that reference them
are read-only.)

### Transparency: no, black is part of the art

A first attempt set `"backColor": false` on all FF3 battle graphics. That was
wrong: **colour 0 is the sprite outline** as well as the filler inside the tile
rectangle, so making it transparent deleted the outlines. All FF3 battle
graphics use `backColor: true` again. The black box around a monster is real -
the game draws monsters as a rectangle of BG tiles and index 0 is black in both
battle palettes - it is not an editor artefact.

### Both palettes at once (per-cell palette selection)

`$2E:$8F00-$2E:$9027` ("monster attribute data") says which of the two battle
palettes each **2x2 tile cell** uses. `2F/A8D8` gives the table base per size
class (`8F20, 8F20, 8F48, 8F48, 8FA8, 8FB4`) and `2F/A8E4` the bytes per monster
(`1,1,2,2,3,3`), but the **record index comes from `2F/A0E7`**: `(props & $1F)`
plus a per-class offset (`$10` for the 4x6 class, `$18` for the 6x6b class).
With that offset the tables tile perfectly - `$8F20-$8F2F`, `$8F30-$8F47`,
`$8F48-$8F77`, `$8F78-$8FA7`, `$8FA8-$8FB3`, `$8FB4-$8FBF`, then 24 x 7 bytes of
boss records at `$8FC0-$9027` ending exactly at the boss pointer table.
`2F/A6FB` reads the bits **MSB-first** and `2F/A78D` walks the cells
**row-major** over the *formation slot* (`2F/A5E6`), not over the graphic: a 4x4
monster stands in a 4x6 slot with its art two rows low, so its cells are bits
2-5. Finally `$2E:$8F00` is one bit per **monster id** meaning "invert the
cells" (`2F/A8BF EOR #$FF`), and it is set for every id `$80-$FF`.

(The first attempt used `props & $3F` as the index, ignored the slot alignment
and the invert bit, and assumed bosses had no cell map - see
`HANDOFF-FF3-NES.md` §2A. All three were visible bugs.)

The generator emits this per array item as `itemAttributes` (a generic
`ROMArray` key alongside `itemPalettes`) - now a reference to the live ROM
table, `{"path": "monsterAttributeData", "index": 51, "bytes": 1, "cells": 6,
"offset": 2, "invert": true}`; `ROMArray.disassemble` expands it through
`applyAttributeRef()` and `ROMGraphicsView.attributeCellBits()` reads the bytes
from the ROM (so editing the table repaints the sprite), and
`ROMGraphicsView.paletteBitsForTile()` turns it into a palette offset per tile
(0 or 4) - applied only when the loaded palette actually holds both palettes.
`tools/ff3-nes-attrcheck.py` checks the whole model against reference rips.
96/96 graphics carry cell maps; 89 of them genuinely mix both palettes.

Bosses get their cells from `$2E:$8FC0` (7 bytes per tilemap index, 9x6 cells
for the 18x12 map, `2F/A820`), applied by `ROMTilemapView.applyPaletteCells()`.

### Palette editing with composed palettes

A composed palette buffer spans several ROM palette objects, so `editColor`
can't just index `paletteObject.data`. `ROMPaletteView` now records
`paletteSegments` (`{object, begin, end, rangeBegin}`) as palettes are loaded
and `targetForColor(index)` maps a buffer position to the right object and
index. Without this, editing a colour silently wrote to whichever palette was
loaded last (usually `battlePalettes[0]`, off screen) and appeared to do
nothing.

### Boss pools: 12 of them are not in the size-class arrays

A boss pointer addresses a **16 KiB window** (MMC3 banks `2V` at `$8000` and
`2V+1` at `$A000`), so the tile index is 10 bits and the pool can sit in the
unused stretch after the class arrays - file `0x4E410-0x50010`, which no class
array covers. Pointing those bosses at a class array produced nonsense. Added
`monsterGraphicsSpare` (`0x278400-0x288000`, 448 spare tiles) as the container
for them, and each boss's `graphics` definition now scopes the pool with
`"range": "<decoded byte range>"` (64 bytes per 2bpp tile), clamped to the
container end because the game always copies 144 tiles even when fewer exist.
The format `ff3BossTilemap` maps `0x70`-`0xff` to tiles 0-143 and everything
below to a blank sentinel.

### Boss coverage: most bosses are ordinary monsters

Of the 127 named boss monsters (ids `$80`-`$FF`), only **32** use the boss
tilemap mechanism; the other **95** use the normal size-class arrays. So the
bosses on the sprite sites' Surface/Floating pages are mostly already present
under `Monster Graphics (6x6)` etc. - the class-array labels now list boss
users first and prefix them with `*` so they can be spotted.


### Summon graphics

`summonGraphics` (`0C:9800-0DA7FF`, file `0x19810`, 4 KiB) is a **tile pool**,
not a picture: the eight summons occupy consecutive blocks of 3x3, 4x5, 4x5,
6x7, 5x7, 8x9, 8x9 and 7x10 tiles, so no single display width makes it read as
art. The real views are the eight tilemaps:

`$2A:$9440` ("summon graphics properties", 8 records of 8 bytes, `32/8CEF`):
byte 0 = graphics index (tile offset into the pool), byte 1 = first of three
consecutive sprite palette ids, byte 4 = size (high nibble width, low nibble
height), byte 5 = start position (high nibble x, low nibble y), bytes 6-7 =
little-endian pointer to the tilemap in bank 2A. Modelled as
`summonProperties` plus `summonTilemap0`..`7`, each with
`format: "ff3SummonTilemap"` and `graphics: {"path": "summonGraphics",
"whole": true}` with `tileOffset = graphicsIndex`.

**The tilemap byte carries the palette too**: `32/8DDA` masks the tile with
`$3F` and adds the PPU base `$39`, while `32/8DE7` feeds bits 6-7 (`lsr6`) to
the sprite attribute - i.e. which of the summon's three sprite palettes that
tile uses. `ff3SummonTilemap` decodes those bits into the tilemap word's
palette bits (colour offset 0/4/8), so a summon renders with all three palettes
at once; Bahamut (summon 7) is a proper multi-coloured dragon. The three
palettes come from `battlePalettes[byte1 .. byte1+2]` and are composed into a
12-colour (3 row) palette panel.

Blank cells (`0xff`) decode to a sentinel that stays out of range after the
tile offset is added, so the PPU skips them and they draw transparent.

### Boss graphics

Bosses are not flat bitmaps. A boss is a **tilemap of 216 tile ids (18 wide x
12 tall)** at `$2A:$8000` (file `0x54010`), indexed by `props & 0x1F`, plus a
2-byte pointer per boss at `$2E:$9068` (file `0x5D078`):

- **The pointer format is `bbs---tt tttttttt`, exactly as the disassembly
  comment says**: bits 7-6 = bank id, **bit 5** = "this boss is a summon: load
  from bank `$0C` and flip", bits 1-0 + byte 0 = a 10-bit tile index. I first
  read the bank from bits 1-0 and the summon flag from bit 2, which put 22 of
  the 24 pools in the wrong place (Land Turtle rendered as a horse). Slots 22
  and 23 are the summon-backed ones.
- The pool is addressed inside a **16 KiB window** (an MMC3 pair of 8 KiB
  banks), so the file offset is `bank*0x2000 + tile*16 + 0x10` - not something
  `mapAddress` on a def address gives you, since def addresses alias above
  `$9FFF`.
- The size-class arrays do **not** cover the whole 64 KiB region. The unused
  stretches between them (`0x43410-0x44010`, `0x47610-0x48010`,
  `0x4B610-0x4C010`, `0x4E410-0x50010` in file space) hold most boss pools, so
  each gap gets its own `monsterGraphicsSpareN` owner assembly. Every byte must
  have exactly one owner; the xcheck's overlap test enforces it. Verified: no
  boss's *used* tiles exceed its container, so the clamped `range` never
  truncates a sprite.
- the tilemap bytes are **PPU pattern indices**, and the boss's pool is copied
  to PPU `$0700` (`2F/A400`), so tile id `0x70` = pool tile 0. Ids below `0x70`
  are the battle-background tiles the game leaves in the nametable; in the
  editor they fall outside the pool and draw black, which is what you want.
- the tilemap is written into the nametable buffer at `$7922` with a 32-column
  stride (`3F/F90A`: 12 rows x 18 bytes), which is why the display is 18x12.

The definition models this as `bossGraphicsPointers` (editable properties) +
`bossTilemap0`..`bossTilemap23` (editable tilemaps, `width: 18, height: 12`),
each with `graphics: {"path": "<the assembly that contains its pool - a
size-class array, a spare region, or summonGraphics>", "whole": true,
"range": "<decoded byte range of its 144 tiles>"}` and
`format: "ff3BossTilemap"` (new in `rom/gfx.js`: `0x70`-`0xff` = tiles 0-143 of
the block, below that = empty). The generator computes the range in **file**
space — def-space arithmetic lies here (`0x24A400-0x248000` is 576 tiles in def
space, 64 in file space) — and the xcheck re-derives every range from the
pointer table and asserts it matches.

Bosses also get the two composed palettes, named after the bosses that use
that tilemap.

**Most bosses are not tilemaps at all.** Of the 127 named boss monsters (ids
`$80`-`$FF`), only **32** use this mechanism; the other **95** are ordinary
size-class graphics. So the bosses on the sprite sites' Surface/Floating pages
are mostly under `Monster Graphics (6x6)` and friends - the class labels now
list boss users first, prefixed with `*`.

Two things that look wrong but are not:
- **The geometry is 18x12, not 12x18.** `3F/F90A` copies 12 rows of 18 bytes
  into the nametable buffer at `$7922` with a 32-byte stride; dumping the map
  as 18x12 shows the tile ids running sequentially with staggered leading
  blanks, which is the sprite's silhouette.
- **Interior gaps in the centre panel are real.** Cells below `0x70` are
  background cells; the game composites the boss over the battle background
  tilemap, so those cells show bg tiles in play and transparent here. The
  right-hand pool panel shows the same 144 tiles in raster order, which is why
  it can look "more complete" than the tilemap.

The one non-obvious piece: a tilemap's `graphics` normally resolves to a
`ROMArray` and the view loads `item(0)` only. Boss and summon pools span many
items, so `ROMGraphicsView.loadGraphics` now honours **`"whole": true`** on the
graphics definition, which concatenates every item's *decoded* graphics into
one contiguous tile pool. (Concatenating decoded items, not the array's raw
bytes — the array itself has no format, so `array.data` is still encoded 2bpp
planes.)

Bosses are composites of shared tiles: painting a boss means editing the tiles
in the pool panel (or the size-class arrays). There is deliberately **no**
graphics assembly covering a boss's pool, because two assemblies owning the same
bytes means last-writer-wins on save (see §1). The overlap test in the xcheck keeps
that true.

### Graphics blobs added for reference

`battleBackgroundGraphics` `0x0C8000-0x0C9800`, `summonGraphics`
`0x0C9800-0x0DA800`, `battleSpriteGraphics` `0x0DA800-0x0E8000`,
`mapSpriteGraphics` `0x0E8000-0x108000`, `attackGraphics` `0x2A9600-0x2C8000`.
All plain `nes2bpp` blobs, no width/height (the view defaults to 16 tiles wide).
Do **not** add another blob that covers the monster or character arrays — two
assemblies covering the same bytes means last-writer-wins on save; the overlap
test in `tools/ff3-nes-xcheck.js` exists to keep that from happening.

### Reference images

`https://www.videogamesprites.net/FinalFantasy3/` has per-sprite rips of this
exact game (Party / NPCs / Bosses and Enemies / Objects / Backgrounds) with
English names — useful for checking a decode is right, and as import material
(the graphics view already imports indexed PNGs). `tools/ff3-nes-dump.py`
renders the same regions straight from the ROM for comparison:
`python3 tools/ff3-nes-dump.py monsters chars -o /tmp/ff3.png`.

---


---

## 6. FF IV (U) SNES ("Final Fantasy II (USA)") — monster / boss / summon graphics — DONE

`ff4/ff2u-sfc.json` (crc32 0x65D0A825). The definition used to model monster
graphics as one opaque 111 KiB blob (`monsterGraphics 0x098000-0x0CB2F8`), not
even in the navigator tree. It is now 90 individually editable graphics
objects named after their monsters, with per-object size/format/palette, plus
named monster palettes. Character graphics (`characterGraphics`, sprite sheets)
and portraits were already editable and stayed untouched.

**The pointer model — the trap of this game.** `monsterGraphicsProperties` is
224 records of 4 bytes: byte0 = size class (0x3F) / isCharacter (0x40) /
isBoss (0x80); byte1 = palette index; bytes2-3 = 15-bit graphics pointer, bit
15 = 3bpp. The game (LoadMonsterGfx, @8eca in everything8215/ff4) computes
`bank = $09 + bits4-6` and `offset = $8000 + (low 12 bits)*8` — which is
algebraically `FILE(0x48000) + (p & 0x7FFF)*8`: **the pointer space is linear
in FILE space, not in bus space**. FF6's hiROM definitions hide this because
there bus == file. So:

- the array is `"isMapped": false` (new: ROMArray now honours it for
  `pointerObject` in readPointerObjects, pointer-target init and
  updatePointerOffset — readPointerTable already did), and
- `graphicsPointer` gets `"offset": "0x48000"` — a *file* address — plus
  `"pointerTo": "monsterGraphics"`.

**The region is interleaved with other data.** Pointers ≥ 0x20000 land in
bank 0d, where the ROM also holds mapSpritePalettes, npcPalettes,
portraitPalette, windowPalette (and attackGraphics/attackTilemap sit in the
hole after the last bank-0C pointer). A gap-tiled array would swallow them,
so the array is **fragmented** (`isFragmented: true`, it owns no range) with
static **`itemRanges`** the generator computes per unique pointer:

    end = min(next pointer, ptr + max load)
    max load = w*h*tileBytes                     (normal monsters)
             = max(battleVRAMMap bossTileCount over all battles, w*h) * tileBytes  (bosses)

tileBytes = 24 (3bpp) / 32 (4bpp). Verified: no normal monster's load ever
crosses its gap; bosses DO over-read their pools in the game (garbage tiles
the boss map never places) — the cap keeps ownership clean. Every byte still
has exactly one owner; `tools/ff4-sfc-xcheck.js` asserts it.

Two romtools fixes made this work:
- `itemRanges` + `pointerObject` combine: the itemRanges branch now builds
  `pointerRanges` from the sorted unique pointers so pointer targets,
  `sizeFrom` and the property list still resolve.
- fragmented items are registered as direct children of the ROM, whose
  constructor maps the definition range — the creation loop now hands them
  the **unmapped** range (FF5 GBA only worked because GBA `mapAddress` is the
  identity below 0x08000000).

**sizeFrom is now a list of specs** with new fields (FF5's single-spec form is
unchanged): `condition` (JS over `record`), `indexProp`+`indexArrayPath`
(boss records route through `monsterBossProperties[b]`), `sizeIndexProp` (the
size table is indexed by a property value, not the record index), `noSize`
(boss pools: display as a 16-wide sheet, the game places tiles with the boss
map), `formatProp`+`formats` (is3bpp -> snes3bpp/snes4bpp; the item is
re-disassembled if the pointer-target pass already decoded it raw), and
`linkPalette.indexProp`. `itemPalettes` entries set `palettePinned` so the
generated static entries win over spec linking.

**Palettes.** 3bpp sprites use the first 8 colours of `monsterPalette[p]`
(pinned as `{"path": "monsterPalette[p]", "range": "0-8"}` — note `range`
must be a *string*: `ROMRange.parse` returns 0-0 for objects, which silently
blanked the palette panel). 4bpp composes colours 0-7 of p with 8-15 of p+1,
exactly as `LoadMonsterPal` loads them — two `compose: true` entries with
offsets 0 and 8. Only Zeromus (records 201/214) is 4bpp.

**Bosses and summons.** 44 records set isBoss; the size class field is then a
`monsterBossProperties` index (position, size, palette, tilemap). Pools are
shared: Milon + Milon Z + Rubicant + Elements are one 254-tile pool; the boss
map (monsterBossMap, 0xFF = skip, 0xFE n = run) places a subset per battle,
with the loaded tile count coming from battleVRAMMap. One pool = one graphics
object labelled with all its bosses (`*Odin`, `*Bahamut, *Wyvern`, ...). The
summons everyone remembers (Titan, Odin, Leviathan, Bahamut, Asura) are boss
records, so they are covered too. Boss *placement* (the tilemaps) is still
raw data, not a tilemap view — that's the natural next step.

**Names come from the ROM.** `tools/ff4-sfc-names.py` decodes monster names
(A-Z = 0x42-0x5B, a-z = 0x5C-0x75, 0xC1 = apostrophe, 0xC2 = space, 0xFF =
pad — "Jhk" is Imp, "P^ojh5C8" is Octomamm), computes the item order (sorted
unique pointers), the capped itemRanges, per-item palette pins and the
monsterPalette names, and rewrites the definition (idempotent).

**Battle code.** `ff4-battle.js` / `ff4-battle-vram.js` resolve
`graphicsPointer.target` when the definition has the array model, and fall
back to the old `range.begin + value` arithmetic when it doesn't — so
`ff4j-sfc.json`, which still has the blob (and which I cannot validate, no
J ROM), keeps working unchanged. `updateBattleStrings` keys the graphics
string table by `target.i` and no longer appends duplicate names to
pre-generated labels.

Fixed on the way: `ROMGraphicsView.selectObject` crashed on objects with no
format (`formatKey.includes` on undefined) — a raw blob is now viewable.

Same tests as FF3, same guarantees: `node tools/ff4-sfc-xcheck.js` (pointer
resolution, one-owner rule, decode parity vs an independent from-spec
decoder for 6536 tiles, palette pins, paint lands on the right bytes, undo
byte-exact) and `node tools/ff4-sfc-app-test.js` (real browser: auto-detect,
open/paint/undo, boss pool, 4bpp compose, FF4Battle + VRAM still draw).
`tools/app-shots.js` is the generalized screenshot tool (`SHOT_ROM=... node
tools/app-shots.js 'monsterGraphics_80' ...`).

---

## 7. How to test anything you change

```bash
# serve the app (XHR of definition JSON is blocked under file://)
cd /storage/romhacking/ff6tools && python3 -m http.server 8000
# open http://localhost:8000/  -> Ctrl+O -> pick ROM

# headless, no browser interaction needed
node tools/rom-harness.js       # load + assemble; must report 0 diffs
node tools/ff5e-xcheck.js       # 736/736 decode parity + edit round trip
node tools/ff5e-pallink.js      # every graphics set points at the right palette
node tools/ff5e-compare.js      # collateral damage check
node tools/demo-paint.js        # drives painting in headless Chrome
node tools/ui-edit-test.js      # 14 assertions: painting, paste, delete, pan, zoom, arrows
node tools/ui-features-test.js  # 15 assertions: cursors, centring, overlays, navigator
node tools/map-smoke-test.js    # map editor not regressed
node tools/ff3-nes-app-test.js  # FF3J loads, auto-detects, and paints in the browser
node tools/ff3-nes-xcheck.js    # FF3J: range overlaps, decode parity, palettes,
                                # boss tilemaps, edit lands on the right bytes, undo
node tools/ff3-nes-map-smoke.js # FF3J map/world editors still open without throwing
FF5E_ROM="Final Fantasy III (Japan) (fixed).nes" \
  node tools/rom-harness.js ff3/ff3j-nes.json   # FF3J round trip must be 0 diffs
node tools/ff3-nes-shots.js 'monsterGraphics6x6[3]' 'bossTilemap8'  # screenshots
FF3J_ROM="Final Fantasy III (Japan) (fixed) (English).nes" \
  node tools/rom-harness.js ff3/ff3u-nes.json   # FF3U round trip too

# FF4 (U) SNES - "Final Fantasy II (USA).sfc"
python3 tools/ff4-sfc-names.py --def ff4/ff2u-sfc.json \
        --rom "/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc"
FF5E_ROM="/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc" \
  node tools/rom-harness.js ff4/ff2u-sfc.json   # must be 0 diffs
node tools/ff4-sfc-xcheck.js                    # model + decode parity + edit/undo
node tools/ff4-sfc-app-test.js                  # real browser: paint, boss, battle VRAM
SHOT_ROM="/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc" \
  node tools/app-shots.js 'monsterGraphics_80' 'monsterGraphics_88' 'battleProperties[223]'

# the English translation dump (crc32 fa04837f) gets the same treatment
FF5E_ROM="Final Fantasy III (Japan) (fixed) (English).nes" \
  node tools/rom-harness.js ff3/ff3u-nes.json
node tools/ff3-nes-xcheck.js ff3/ff3u-nes.json "Final Fantasy III (Japan) (fixed) (English).nes"
node tools/ff3-nes-app-test.js "Final Fantasy III (Japan) (fixed) (English).nes" ff3u-nes
FF3J_ROM="Final Fantasy III (Japan) (fixed) (English).nes" node tools/ff3-nes-map-smoke.js
```

`tools/ff3-nes-shots.js` opens any object path in the real app and writes a
PNG - the fastest way to see what a definition change actually looks like.

`tools/node-dom-stub.js` is a minimal DOM shim that lets ff6tools' browser code
run under Node — that is how the non-browser tests work. The CDP tests use
Node's built-in `WebSocket` against `google-chrome --headless=new
--remote-debugging-port=...`.

**Known test-harness trap:** synthetic `MouseEvent`s do not let you set
`offsetX`/`offsetY` (read-only accessors) — use `Object.defineProperty` or pass
real `clientX/clientY` and rely on `getBoundingClientRect`. Several apparent
bugs during this work were harness artefacts, not product bugs.

**Second harness trap (found on FF3J):** driving the painting tools directly
(`view.paintPixel(x, y); view.commitPaint()`) silently does nothing unless
`view.paintStart` is set first — `mouseDown` normally sets it. Do
`view.paintStart = view.graphics.slice()` before painting in a test.

---

## 8. Files added on this branch

```
patches/ff5e-europe-strip-boot-patch.ips   # user's FF5E -> reference dump
patches/ff3j-nes-fix-dump.ips              # user's FF3J  -> reference dump
patches/ff3u-nes-fix-dump.ips              # user's FF3U  -> reference dump
tools/  node-dom-stub.js rom-harness.js ff5e-xcheck.js ff5e-pallink.js
        ff5e-compare.js ff5e-gfx.js ff5e-gen-names.js insert-names.js
        ff5e-freespace.js ui-test.js ui-features-test.js ui-edit-test.js
        demo-paint.js demo-import.js demo-recolour.py map-smoke-test.js
        import-bug-test.js ff3-nes-app-test.js ff3-nes-xcheck.js
        ff3-nes-shots.js ff3-nes-map-smoke.js
        ff3-nes-probe.py ff3-nes-classify.py ff3-nes-tilesheet.py
        ff3-nes-montage.py ff3-nes-diff.py ff3-nes-dump.py
        ff3-nes-names.py ff3-nes-add-graphics.py ff3-nes-attrcheck.py
        ff3-nes-palcheck.py
        app-shots.js            # generic: SHOT_ROM=rom node tools/app-shots.js <path...>
        ff4-sfc-names.py        # generates the FF4 SNES graphics model from the ROM
        ff4-sfc-xcheck.js       # FF4 SNES: pointers, ownership, parity, edit/undo
        ff4-sfc-app-test.js     # FF4 SNES: browser paint + boss + battle VRAM
```

`ff3-nes-dump.py` renders any monster size class / character block straight from
the ROM (the fastest way to check a range before touching the definition);
`ff3-nes-names.py` decodes the game's own names and builds the string tables
(`-r <rom> -d <definition.json>`, works for either FF3 dump);
`ff3-nes-add-graphics.py` writes the FF3 battle graphics assemblies into a
definition (`--def`, `--rom`); `ff3-nes-diff.py` diffs two dumps and emits a
verified IPS patch; `ff3-nes-attrcheck.py` re-derives the per-cell palette
model from the ROM and checks it against the videogamesprites.net rips
(cached in `/tmp/ff3-rips`), scoring the wrong variants alongside it.

Modified: `ff5/ff5e-gba.json`, `ff3/ff3j-nes.json`, `ff3/ff3u-nes.json`,
`ff4/ff2u-sfc.json`, `ff4/ff4-battle.js`, `ff4/ff4-battle-vram.js`,
`ff5/ff5-battle.js`, `rom/romtools.js` (new generic `ROMArray` keys
`itemPalettes` and `itemAttributes`; `isMapped: false` for `pointerObject`
arrays; `itemRanges` + `pointerObject` combined; `sizeFrom` spec list with
`condition`/`indexProp`/`sizeIndexProp`/`noSize`/`formatProp`/`linkPalette.indexProp`;
`ff3BossTilemap`/`ff3SummonTilemap` registered), `rom/gfx.js` (`nesFixedPalette` palette format,
`GFX.closestNESColor`, and the two FF3 tile formats - the summon one carries
per-tile palette bits), `gui/graphics-view.js` (painting tools, `"whole": true`
tile pools, per-tile palette cells, forwarding arrow keys to the navigator),
`gui/palette-view.js` (palette composition, `"name"`/`"offset"` entries,
`paletteSegments`/`targetForColor` so edits land on the right palette,
resetting the palette selection when a different object is opened),
`gui/property-list.js`, `gui/navigator.js`, `css/ff6tools.css`.
