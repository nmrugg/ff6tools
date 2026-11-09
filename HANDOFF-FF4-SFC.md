# HANDOFF — FF4 (U) SNES graphics + continuing sprite-graphic editing in ff6tools

Status prompt for whoever continues. Written so you do not re-derive anything
below. Companion docs: `HANDOFF.md` (§1 ground rules, §2 FF5-GBA, §5 FF3-NES),
`HANDOFF-FF3-NES.md`. This file is the FF4-SFC state + the roadmap for the
remaining games. **Do not commit — the user commits.**

---

## 0. What this project is

Feature branch (`more-graphics`) of ff6tools (browser-based FF ROM editor,
https://everything8215.github.io/ff6tools). Goal: per-game *sprite graphics*
editors — monsters, bosses, summons, characters — viewable AND paintable in
the app (pencil/fill/eyedropper/palette-cell tools), with objects named from
the ROM itself. Done so far: FF5 Advance (U/E) GBA, FF3 (J/U) NES, FF4 (U)
SNES ("Final Fantasy II (USA)"), and FF IV Advance (U) GBA (see §7). Validate with the user's legal ROMs in
`/storage/romhacking/ff-roms/` (CRCs match the built-in defs; `patches/*.ips`
fix mislabelled dumps). Reference art the user provided:
`/storage/romhacking/ff-roms/ff4monsters.zip` (214 PNGs, GBA-era colors,
red `#b02000` = transparency; names are JP-flavored: mag=Ifrit, ashura=Asura,
rudra=Hudluh NOT Ramuh, motherbomb=Mom Bomb...). RE links:
`/storage/romhacking/ff-roms/reverse engineer.txt` — the gold mine is
`notes/ff4j-sfc-rom-map.txt` + the code in `btlgfx/` of
https://github.com/everything8215/ff4 (the ff6tools author's disassembly;
data/gfx .asm includes are NOT in the repo, read the ROM + .lnk/.map).

## 1. Ground rules (unchanged, still true)

- **Round trip is the safety test.** After every def/romtools change:
  `FF5E_ROM=<rom> node tools/rom-harness.js <def.json>` → `diffs vs original: 0`.
- **One owner per byte.** Fragmented arrays / windows never double-own.
  `ff4-sfc-xcheck.js` and `ff3-nes-xcheck.js` enforce overlaps.
- NES defs use *mapped* bus addresses (`file = ((bus&0xFF0000)>>3)+(bus&0x1FFF)+0x10`
  for mmc3); GBA defs real GBA addresses. **FF4 SNES loROM is special: the
  monster-graphics pointers address the region LINEARLY IN FILE SPACE**
  (pointer = `(w2&0x7FFF)*8` added to file base `0x48000`; the game computes
  bank = 09+bits4-6, offset 0x8000+(low12*8) — algebraically identical).
  Hence the def: array `"isMapped": false`, `graphicsPointer.offset` =
  `"0x48000"` (a FILE address), ranges in bus space are mapped at parse.
- Custom-def save/reload must be stable (`rom.definition` → re-disassemble →
  assemble → 0 diffs). `itemPalettes`/`itemRanges`/`hiddenItems`/`sizeFrom`/
  `layout`/`layoutFlip`/`window` all serialize.

## 2. Generic machinery now in rom/romtools.js + gui (use for other games)

ROMArray:
- `sizeFrom`: spec or **list of specs**; fields: `arrayPath`, `pointerPath`,
  `condition` (JS over `record`), `indexProp`+`indexArrayPath` (indirection,
  e.g. bossProperties), `sizeIndexProp` (size table indexed by a property
  VALUE, not record index), `noSize` (pools), `formatProp`+`formats:[f4,f3]`
  (bool property -> per-item format; re-disassembles if already loaded),
  `linkPalette:{pointerPath|indexProp, arrayKey}`.
- `itemPalettes[i]`: static palette pin (sets `palettePinned`; spec
  `linkPalette` then skips). Choices nest: `[choice,...,{path:wholeArray}]`;
  a choice may be a dict or a compose-pair LIST `[{path,offset:0,compose:true},
  {path,offset:8,compose:true}]`.
- `itemAttributes` (FF3 palette cells), `pointerObject` + `isMapped:false`,
  `itemRanges` COMBINABLE with `pointerObject` (branch builds `pointerRanges`
  from sorted unique pointers so targets resolve), `hiddenItems` (navigator
  skips those array rows; objects still own bytes and are reachable by
  direct hierarchy path).
ROMGraphics:
- `window:{path,offset(decoded bytes),tiles}` — reads through another
  assembly's decoded bytes, never owns; `sourceAssembly()` WAKES a lazy
  fragmented array when the path is a fragment (`monsterGraphics_84`) that
  doesn't exist yet — without this, windows disassembled before the array
  came up blank.
- `layout` (static cell→tile map, -1=empty, cells may repeat a tile) — the
  view renders any object with `layout` as the assembled creature
  (poolLayout/poolFlip), paint writes through `tileOffset` (flip-aware).
  (`layoutFlip` was removed again: no ROM map flips a pooled tile, no def
  used it, and no puzzle placement ever set a non-zero flip — verified.
  `poolFlip` stays, because FF3 NES `layoutFrom` windows derive it from the
  tilemap word's flip bit / `mirrorX`.)
GUI gotchas: `ROMRange.parse` only accepts STRINGS ("0-8"), returns 0-0 for
objects; `GFX.graphicsFormat[formatKey] || this.format` guard for format-less
blobs; two tree rows pointing at the SAME object path make the navigator
highlight the wrong row (`this.node[path]` first-wins) — give every tree row
its own assembly (this was the user-visible "clicking Mist Dragon selects
Summons" bug; fixed by making all 15 `summonGraphics_*` their own windows).
- **`view.cellTile` / `view.cellFlip` are the only correct answer to "which
  tile of the data does this display cell show?"** They are rebuilt at the end
  of `updateTilemap()` from `this.tilemap` (tile = `word & 0xFFFF`, empty =
  0xFFFFFFFF, h/v flip = bits 28/29), so they already fold together the pool
  layout, the sprite sheet (`characterGraphics`'s `spriteSheet.tilemap` repeats
  and reorders tiles), and the view's own h/v flip. `tileOffset()` must use
  them: with the old linear/poolLayout-only lookup, painting Cecil's sheet
  cell 4 (which *shows* tile 0) wrote tile 4 — "draws pixels in the wrong
  spots". Same trap for any new display mapping.
- **A window must notify its own observers when it re-reads its source**
  (`ROMGraphics.disassemble`): the graphics view observes the *window*, not
  the pool, so without that notify an undo of a Boss Graphics paint restored
  the ROM bytes but left the painted pixels on the canvas — "undo works
  except on Boss Graphics". `ROMGraphics.replaceData` therefore does not call
  disassemble/notify itself (the owner's notification already does).
- **`rom.endAction()` must not push an empty action group.** A pencil stroke
  that changes nothing (clicking a pixel that already has the chosen color, or
  a blank cell of a laid-out window) opened a group, produced no action, and
  queued the empty array anyway — the user's next Ctrl+Z silently consumed it
  and undo looked dead.
- **Image Bounds shades cells, not a tile count**: it must ask the same
  question painting does (`view.cellTile`), so a layout's holes are dimmed and
  a sprite sheet's repeated/reordered cells are not. The old `t < tileCount`
  test shaded the tail of the grid (a 64-tile character shown in 84 cells
  dimmed cells 64-83) and left real holes bright.
- **Sprite sheets belong to items, and must be clamped to the item**:
  `characterGraphics` carries two sheets (the 14 standard characters, and the
  Golbez/Anna pair). The generator tags each with `itemRange` and
  `selectObject` picks the one covering the selected item — otherwise
  Golbez/Anna are shown through Cecil's arrangement. One sheet shared by
  items of different sizes must also drop ids past the end of the selected
  item's data (Golbez has 27 tiles, Anna 23): the sheet's 4 cells pointing at
  tiles 23-26 were the user's "fourth Anna tile that is redundant";
  `updateTilemap` now leaves them empty (`tile < dataTiles`).
  **Open**: the "Golbez/Anna" sheet still under-repeats compared with the
  in-game sprites. Fixing it needs the character pose loader decoded
  (CharTileTbl / CharSpriteOffsetTbl address OBJ VRAM char slots, not the
  block); flattening it to tile order was tried and reads worse, so the
  original is kept. Reference art: videogamesprites.net FF4 NPCs →
  Individuals → Villains (Golbez) and Other (Anna).

## 3. FF4 SNES data map (bus → file = `(bus>>1)+(bus&0x7FFF)` for 00-3F… loROM)

- monster graphics region: file `0x48000-0x632F7` (banks 09-0C: "...more
  bosses" ends 0C96F7, "final zeromus graphics" 0C96F8-0CB2F7, 0CB2F8-0CB6BF
  UNUSED) + bank 0D `0x68818-0x6E817` (rom map: "summon graphics" — it is
  the monster-gfx5 region; the lnk label "summon_gfx" only covers the
  17-pointer table at 0x0d87f0).
- `monsterGraphicsProperties` 0x0FCA00, 4B/record (rom map says 256 records;
  def models 224 — fine, 224-255 are unused). byte0: size idx 0x3F /
  isChar 0x40 / isBoss 0x80 (then low6 = bossProps index); byte1 palette
  BYTE; word2: 15-bit pointer ×8, bit15=3bpp.
- `monsterBossProperties` 0x0FCE00, 5B: pos, sizeIdx, paletteByte,
  slot/transition, mapIdx. Boss maps: ptr table 0x0ECF00 (rel 0x0E0000),
  57 maps. DrawBoss walk (`LoadBossTilemap` @0x028ce1): stream cursor is X
  and persists across rows; per cell: `0xFF`=1 empty, `0xFE n`=n empty,
  else pool tile index; grid = bossProps size.
- palettes: `monsterPalette` 0x1CEE00 — **def entries are 16 bytes = 8
  colors = the game's unit** (LoadMonsterPal reads 32 bytes at `palbyte*16`:
  3bpp uses sub-pal p; 4bpp composes p + p+1; only Zeromus 201/214 is 4bpp).
  `characterPalette` 0x1CFD00 entries are 32B/16 colors (4bpp chars).
  `portraitPalette` 0x0D86D0, 16 entries × 16B (def was short by 2; fixed).
- chars: `characterGraphics` 0x1A8000, 17 blocks (14 chars, 14=Pig,
  15=Golbez, 16=Anna); pig/mini/toad *sprites* live in monster-gfx1 block 0
  (40 tiles) — TinyMage/Dummy/Egg point at its first tiles.
  Portraits 0x1DD3C0, 17×384B (14=Pig,15=Small,16=Toad — they reuse the
  affected character's palette at runtime; entries 14/15 are empty black).
- attacks: gfx 0x0CB6C0-0x0CF277 (3bpp) + stale 4bpp 0CF278-0CF3BF +
  tilemap 0x0CF3C0 (768×2) + `attackPalette` 0x0ECB00 (64×16B).
- summons: `SummonGfxPtrs` 0x0d87f0 (17 words **rel 0x0d0000**) → blocks
  (index = attack−0x4d; attack names Globe/Fire/Blaze/Thunder/… are the
  *effect* attacks, not Esper identity — match blocks to Espers by monster
  art / pal byte instead). `SummonPalTbl` 0x0dfe4c (17 palette bytes).
  Blocks 0-3,8-16 == monster items (Imp,Bomb,Cockatrice,Mindflayer,Titan,
  MistDragon,Sylph*,Odin,Leviathan,Asura×3,Bahamut); summon-only: Chocobo
  0x0d90b8(24t), Shiva 0x0d92f8(47t), Ramuh 0x0d9760(52t), Ifrit
  0x0d9c40(84t), Sylph 0x0dea0(12t, carved out of the D'Mist item).
  **`SummonTilemapPtrs` 0x0df260 is the OBJ-VRAM placement** (`TfrSummonGfx`
  @0x028409): one byte per 8×8 tile *slot*, in slot order, where slot =
  row*16 + col of the 16-tile-wide OBJ tile grid (slots $00-$7F are used);
  byte<0x80 = the next block tile goes to that slot, $80-$FE = blank slot
  (low 7 bits = slot, no tile consumed), $FF = end. Laying that stream out on
  the grid puts every tile somewhere once — but the animation frames *share*
  cells (Chocobo's two poses use the same head slots, Asura's three the same
  body, Shiva/Ramuh/Titan the same legs), so the grid view shows each pose
  with pieces missing: the user's "missing head / legs / disembodied heads".
  The complete view comes from composing the frames (below).
  `SummonFramePtrs` 0x0df660 + the stage sets at 0x13fa9d (4
  per summon, chosen by (`$f326`>>3)&3 in DrawSummon @0x01fdf9) feed w*h
  16×16 cells from `SummonSpritePosTbl` 0x13fa59 (x,y,w,h in 16px units);
  each stream byte (`_03f7e8` @0x03f7e8) = the OBJ slot of the cell's
  top-left tile, so a cell covers slots n, n+1, n+16, n+17 — **not n..n+3**,
  which is what the first version of the generator assumed and why its
  summon layouts looked like overlapping fragments. **The bytes of a stage
  run right to left** (DrawSummon steps x += 16 per byte, and the ROM's
  stages are filled backwards through the OBJ grid columns): reading them
  forwards mirrors every row and breaks the creature apart ("jumbled or
  shifted"); reading them reversed reproduces the boss-battle arrangement
  exactly for Titan and Asura — that comparison is what settles it.
  $80+/$FE n/$FF = blank
  cells, and the pointer is reloaded from the stage's start on every frame,
  so a stage is one static picture, not a timeline (26 distinct stages over
  the 15 Espers). Cells whose slot the tilemap never wrote stay empty —
  those are the effect sprites the attack animation loads into OBJ VRAM
  separately, not art this block owns. Streams are shared
  between Esper grid sizes, and tilemaps are shared too (Imp/Bomb,
  Cockatrice/Mindflayer, Asura×3) — a shared stream can run past one
  Esper's block (the Cockatrice tilemap consumes 36 tiles but the block is
  24; the extra 12 are Mindflayer art and no Cockatrice cell ever draws
  them), so slots whose tile falls outside the block are dropped.
  TfrSummonGfx converts 3bpp tiles to 32B 4bpp OBJ chunks.

## 4. FF4 def model (generated — never hand-edit ff4/ff2u-sfc.json)

`tools/ff4-sfc-names.py --def ff4/ff2u-sfc.json --rom "/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc"`
is idempotent and emits:
- `monsterGraphics`: fragmented array, `isMapped:false`, `pointerObject`,
  `itemRanges` (boss-only pools span to next pointer — the extra art is the
  same creature; normal items span their load size), `hiddenItems` (24
  boss-only pools hidden from the Monster Graphics tree; 66 visible),
  `sizeFrom` specs, `itemPalettes` (compose pairs for 4bpp; names from ROM),
  stringTable labels (no `*`; summon aliases like "(+Chocobo summon art)"
  where blocks share items).
- `bossGraphics_<bossPropsIdx>[_n]` windows (38): layout = DrawBoss walk;
  `SHEET_BOSSES` overrides (MomBomb bp36: the US map crops a 4x4 corner of
  her LINEAR 60-tile sheet — full 10×9 layout baked in, reconstructed from
  ff4monsters.zip by mask-IoU candidates + iteratively-learned color map,
  **tile reuse allowed** (her solid-red body tile #20 repeats 17×; the
  unique-only pass left the center hollow — that was the user's "middle is
  missing")); `SKIP_BOSSES={214}` (Dummy placeholder gets no window).
  MomBomb's gray patches are REAL: her palette's color 0 is #606060.
  The baked sheet was one cell out from row 6 on (blank at row 6 col 8
  instead of col 0 — the user spotted the shifted bottom rows); the fixed
  layout matches the rip exactly: 12 empty cells in the same places and
  4992/4992 pixels agreeing (the old one scored 4220/4992).
  `tools/ff4-sfc-artcheck.py` re-checks that against ff4monsters.zip.
- `summonGraphics_<Name>` (15, all independent objects → no cross-highlight
  weirdness): 10 are windows over the monster/boss graphics item that holds
  the Esper's art, 5 own their summon-only block (Chocobo, Shiva, Ramuh,
  Ifrit, Sylph). All 15 carry a `layout`, chosen per Esper from its own data
  (`summon_frames_layout`) — each rule exists because of a specific failure
  the user reported:
  1. **stages draw almost none of the block (coverage < 20%) → the layout is
     baked in `SUMMON_FIXES` instead.** Odin's three stages draw 9 of his 100
     tiles and his OBJ grid holds pieces rather than figures, so nothing the
     ROM encodes renders him. `SUMMON_FIXES['summonGraphics_Odin']` (22×13)
     was reconstructed from the ripped sprites the user supplied —
     `ff-roms/Odin1.gif`, `Odin2.gif`, `Odin3.gif`, which are the **SNES art
     at 2× zoom** (halve them: 7×10, 8×10, 7×9 tiles) — by matching every
     non-transparent cell of each frame to a pool tile: all 180 drawn cells
     matched exactly, so the three frames are the game's own art with the
     horse/body tiles repeated; a blank row and the 20 tiles no frame uses
     follow so nothing in the pool becomes unreachable.
     `tools/ff4-sfc-artcheck.py` re-checks it against those gifs (it skips
     with a message if they are absent) and reports 60/60, 65/65, 55/55 cells
     exact and each frame present with the right shape.
     Table for the other stage-poor Espers: `BOSS_BP_FOR` = {8:Titan→2,
     9:Mist Dragon→0, 11:Odin→42, 12:Leviathan→46, 13:Asura→54, 16:Bahamut→47}.
  2. **coverage < 75% → the OBJ grid itself.** Bahamut's stages draw 71 of
     118 tiles; the grid holds both of his poses whole (the reference page
     shows 2 frames), so frames-only Bahamut was "missing its second frame".
  3. **otherwise one rectangle per distinct stage**, cells read **right to
     left** (DrawSummon steps x += 16 per byte while the ROM fills its stages
     backwards through the OBJ grid columns — reading them forwards mirrors
     every row: "jumbled or shifted"), each cell covering slots
     n, n+1, n+16, n+17 (**not n..n+3**), frames directly side by side, no
     gutter column.
  4. **tiles no cell covers attach to the nearest cell, but only when there
     are ≤ 8 of them** — Asura's 4 dress-hem tiles land at the bottom of
     every Asura, Titan's 1 loincloth tile inside the second Titan; the many
     leftovers of a grid-case Esper are whole poses (handled by rule 2).
  5. **if the frames scatter more than they fill** (< 2/3 of their own
     rectangles occupied — Mist Dragon's second stage jumps around the grid),
     use the OBJ grid, which gives one clean dragon.
  No cross-stage "borrowing" of empty cells: it invented tiles the game
  leaves blank (Leviathan's extra corner piece).
  Result: Imp/Bomb 4×4, Cockatrice 6×4, Mindflayer 6×6, Chocobo 8×4 (32 cells
  from 24 tiles), Shiva 11×6, Ramuh 12×6, Ifrit 16×6, Titan 12×8, Dragon Mist
  10×8 (grid), Sylph 6×2, **Odin 22×13 (baked: three ripped frames + the 20
  unused tiles)**, Leviathan 12×10, Asura 24×12, **Bahamut 16×8 (grid, both
  frames)**. The user has since hand-tuned Titan and Mist Dragon with the
  puzzle tool, so their placements override those two.
  Painting a repeated cell writes the one tile every copy shows.
  `ff4-sfc-xcheck.js` re-derives the layouts with an independent
  implementation and compares them, skipping keys that are baked
  (`BAKED` = the SUMMON_FIXES keys, checked by ff4-sfc-artcheck.py) or have a
  saved puzzle placement (checked by the round trip).
- `characterGraphics`/`portraitGraphics` `itemPalettes`: per-item pins
  ("5: Rosa"), Pig/Small/Toad list every palette by name
  ("Kain palette (reused)" etc.).
- hierarchy: Monster (graphics/props/palettes), **Boss Graphics** (38),
  **Summons** (15), Battle (+boss props/maps), Character (+paintable
  **Attack Graphics** → `attackGraphics`; the tilemap row renamed
  "Attack Tilemap").

## 5. Puzzle tool (user arranges tiles by hand)

`tools/ff4-sfc-puzzle/puzzle_server.py` (pattern:
`/storage/romhacking/MysticForge/etc/battle-sprites/puzzle_server.py`):
`python3 tools/ff4-sfc-puzzle/puzzle_server.py [--def D] [--rom R] [8139]`
→ http://localhost:8139 — tray of palette-colored tiles + editable grid,
click-place, shift-click erases, Save POSTs to
`tools/ff4-sfc-puzzle/placements/<key>.json`
(`{key,cols,rows,placement:[{cell,tile}]}`, tile reuse allowed), and "Delete
placement" POSTs /api/delete_placement to remove one so the ROM layout wins
again. The right-click tile flip was removed: no FF4 boss/summon map flips a
pooled tile, no definition ever carried `layoutFlip`, and no placement had a
non-zero flip.
The generator reads placements and overrides computed layouts (verified
round-trip; delete file + regenerate to revert). The grid starts from the
ROM's own arrangement (see §3), so the tool is for tuning rather than
rescuing. `/api/entries` offers the hand-picked keys (the 5 dedicated summons
+ `bossGraphics_36`) and then **every** `summonGraphics_*` / `bossGraphics_*`
in the definition (53 today), so any assembled view can be re-arranged by
hand. Tools: Place, **Erase** (shift-click does the same), Clear grid, Save,
and "Delete placement" (`/api/delete_placement`) to revert a key to the ROM
layout. The tray dims tiles that are not on the grid and labels placed ones
with their repeat count (`12x2`), and the status line shows
placed / distinct / total.
**There are no placements on disk now** — the user's Sylph strip (saved while
the automatic layout was wrong) was deleted at their request once the ROM
layout was right, so every summon shows the composed frames. A placement of
their own still overrides if they save one.
Shell gotcha: each of your commands runs in a NEW shell — `kill %1` won't
work; use `pkill -f puzzle_server.py`, and beware "Address already in use"
races (sleep before rebind).

## 6. Tests (all green at time of writing; run after ANY change)

```bash
FF5E_ROM="/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc" \
  node tools/rom-harness.js ff4/ff2u-sfc.json            # 0 diffs
node tools/ff4-sfc-xcheck.js                             # model/parity/undo
node tools/ff4-sfc-app-test.js                           # browser: paint, windows, pins
  # ... and the regression trio for the shared view machinery: sprite-sheet
  # cell->tile painting, Image Bounds over a layout, undo repainting a window,
  # and a no-op stroke not queueing an empty undo step
python3 tools/ff4-sfc-names.py --def ff4/ff2u-sfc.json --rom "..."   # regen
python3 tools/ff4-sfc-artcheck.py     # baked Mom Bomb sheet vs ff4monsters.zip
SHOT_ROM="/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc" \
  node tools/app-shots.js 'bossGraphics_36' 'summonGraphics_Chocobo'  # eyeball
# regressions:
node tools/ff3-nes-xcheck.js ; node tools/ff3-nes-app-test.js ; node tools/ff3-nes-map-smoke.js
FF5E_ROM=... node tools/ff5e-xcheck.js   # slow (~4 min), background it
mkdir -p /tmp/ff5e-demo    # the UI tests write screenshots there; ENOENT otherwise
node tools/ui-edit-test.js ; node tools/ui-features-test.js ; node tools/map-smoke-test.js
node tools/demo-paint.js
# FF4 Advance (GBA):
python3 tools/ff4-gba-names.py --def ff4/ff4u-gba.json --rom "..."   # regen
FF5E_ROM="/storage/romhacking/ff-roms/Final Fantasy IV Advance (USA).gba" \
  node tools/rom-harness.js ff4/ff4u-gba.json         # 0 diffs
node tools/ff4-gba-xcheck.js                          # ownership/parity/pins/undo
node tools/ff4-gba-app-test.js                        # browser: paint, palettes, battle
python3 tools/ff4-gba-dump.py --ids 280-361 -o /tmp/ff4gba   # render from the ROM
# other defs round-trip with user ROMs (ff6/ff3u-sfc, ff1/ff1u-nes, ff4/ff4u-gba, ff4/ff4j-sfc)
```
Browser-test traps: set `view.paintStart = view.graphics.slice()` before
driving paint tools directly; use `rom.parsePath(key)` not `rom.assembly.key`
(the latter skips the lazy getter); fresh Chrome profile + `--disk-cache-size=1`
already in the harnesses; pixel-offset math: `tileOffset = idx*64 + py*8 + px`.

## 7. FF4 Advance (GBA) — monster graphics — DONE

`ff4/ff4u-gba.json` (crc32 0xFEEEBDE4, "Final Fantasy IV Advance (USA).gba").
Same job as FF5 (§2 of HANDOFF.md), but FF4's tables are laid out differently
and one upstream format bug had to die first.

**The pointer table is 362 records, not 724 items.** `monsterGraphics` used to
be a 724-entry `pointerTable` array of raw bytes at `0x080F6FC8-0x080F7B18`.
Those 724 u32 absolute GBA pointers are really `m*2` = **palette**,
`m*2+1` = **graphics** — the opposite order from FF5 (which is
`m*2` graphics / `m*2+1` palette). Verified from the ROM: all 362 even
entries are TOSE mode 3 (palettes, 16 or 48 colours), all 362 odd entries are
LZSS-wrapped TOSE mode 1 (graphics). So the def now has
`monsterGraphicsProperties` (362 records of 8: `palettePointer`@0,
`graphicsPointer`@4) over exactly the old pointer-table range, and
`monsterGraphics` (275 objects) / `monsterPalettes` (271) are fragmented
`pointerObject` arrays. `ff4-battle.js drawMonsterGBA` resolves through
`.target` and falls back to `item(m*2)`/`item(m*2+1)` for definitions that
still use the flat array (`ff4e-gba.json`).

**Palettes and graphics are interleaved, so `itemRanges` are mandatory.**
A plain pointer-deduped array sizes each item to the next pointer *of the same
array*, so every palette would swallow the graphics block after it (this is
the FF5 wart — 293 phantom overlaps) and the last item would run to the end of
the ROM. The region `0x0818857C-0x081DA7F8` turns out to be *exactly* tiled by
the union of all 724 pointers (min == region begin, and the block at the
largest pointer ends exactly at the region end), so the generator emits static
`itemRanges` computed from that union: 275 + 271 objects own all 336 508
bytes with no overlap and 400 bytes of decoder-trimmed alignment padding
unowned.
**Gotcha: in a GBA definition `itemRanges` are FILE addresses** (`0x18857C-`,
no `0x08` bank). `ROMArray.disassemble` only runs `mapRange` on them when
`isMapped` is false — and GBA pointers *are* mapped, so `isMapped` must stay
true and the ranges must already be mapped. (FF4 SNES writes bus addresses
because it sets `"isMapped": false`.)

**`monsterSize` is indexed by monster id, and hides a tilemap pointer.**
362 records of 12: `? ? ? w h w h ? ptr32`. `sizeFrom` uses the record's own
index (like FF5) and `linkPalette` pins each graphic to the palette its record
points at — all 362 slots decode, size and pin correctly.
**bytes 8-11 are a pointer to a TOSE *layout* (mode 2)** — 12-byte header
(mode, count, w, h) then `w*h` u16 GBA tile entries — present for exactly 22
records: ids 260-269 (Zeromus EG + the nine Lunar espers) and 339-350. In
those maps bits 12-13 are a **palette bank (0/1/2)** — that is why 22 palettes
have **48 colours** — and the tile indices run sequentially (0,1,2,…) so the
block is a raster-ordered pool and the map only chooses the bank. For those 22
the TOSE graphics header's tile count is *not* `w*h` (Zeromus EG says 64 and
the LZSS payload holds 320), so trust the payload length. `tilemapPointer` is
now an editable property on `monsterSize`. **Open:** those 22 still display
with bank 0 for every tile; they want assembled windows (a `layout` plus
per-tile palette offsets, the FF3-NES `itemAttributes` idea) like
`bossGraphics_*`.

**Slots 283-361 are real art with no ROM name.** `monsterProperties` has 282
records and `monsterName` 283 entries, and `battleMonster` only uses ids
0-282, but the size/graphics tables have 362 slots. They are not garbage:
314-320 are seven 18×12 blocks sharing one palette, 327-336 ten 16×14 sharing
another (summon/attack animation frames), and 283-285 etc. are placeholders
pointing at another monster's block. They render and paint fine; the generator
labels them `Slot N (WxH)` or appends `slot N` to the owning monster's label.
`monsterProperties` may also be one record short — battle id 282 ("Specter")
exists but the array ends at 282 records.

**Upstream bug fixed: `tose-palette` decode.** It returned
`[dest, 8 + count << 1]`, which JS parses as `(8+count)<<1` — 48 bytes for a
16-colour palette instead of 40. Every GBA palette assembly therefore claimed
8 bytes of the following graphics block (the source of FF5's overlapping
ranges). Now `8 + (count << 1)`; FF5 round-trips and xchecks exactly as
before, and FF4's ownership test can demand one owner per byte.

Generated by `tools/ff4-gba-names.py` (idempotent), verified by
`tools/ff4-gba-xcheck.js` (pointer pairing, one-owner-per-byte, decode parity
against an independent LZSS/TOSE/4bpp/bgr555 decoder for all 362 slots,
sizes, palette pins, paint-lands-right-bytes, no collateral damage, byte-exact
undo) and `tools/ff4-gba-app-test.js` (real browser: detect, open, pencil,
palette edit, 48-colour panels, shared blocks, battle editor).
`tools/ff4-gba-dump.py` renders any slot straight from the ROM
(`python3 tools/ff4-gba-dump.py --ids 0-63 -o /tmp/ff4gba`).
Screenshot trap: fragmented objects only exist once the array has been
touched, so list `'monsterGraphics'` before `'monsterGraphics_15'` in
`tools/app-shots.js`.

**Animation chains live in `monsterSize` too.** Bytes 0-1 are a sprite id, and
`id - 32` is **the next frame of the same sprite** (325 of 362 records simply
point at themselves). Follow the links and the real animations fall out:
Demon Wall cycles through 11 frames `191 -> 327 -> 328 -> ... -> 336 -> 191`,
Dark Bahamut runs `361 -> 152 -> 286`, and Rubicante / Leviathan / Asura /
Elemental Lord / Lunar Ramuh each have a second frame in the 283-361 range.
That is what most of the "Slot N" objects are: **frames of a named boss**, not
unnamed monsters. The generator walks the chains, roots each one at its first
named member and labels every frame `Demon Wall (frame 4/11)`; `nextFrame` is
an editable property on `monsterSize`. Values below 32 are *character* sprite
groups (see below). 61 slots are still single-frame orphans - they are the
summon/attack animation art (seven 18x12 frames, ten 16x14, the 48-colour
esper set 339-350...); the reference sheets identify them but the names have
not been baked in yet.

**A shared block can only have one size, and the ROM disagrees.** Slots 152
and 361 point at the same 48-tile block but call it 10x8 and 6x8; the 10x8
record reads past the end and renders jumbled (the user's "Dark Bahamut, slot
361 is jumbled"). New generic `ROMArray` key **`itemSizes`**: `[[w,h], ...]`
per array item, applied before `sizeFrom` so it wins; the generator emits it
only where the first-claiming record's size does not fit the data.

**The 22 biggest monsters are tile pools with a per-TILE palette bank.**
`monsterSize` bytes 8-11 point at a TOSE *layout* (mode 2: 12-byte header,
then `w*h` u16 GBA tile entries) for exactly 22 records - Zeromus EG, the nine
Lunar espers (260-269) and the esper slots 339-350. The tile indices in those
maps are sequential, so the block really is a raster-ordered sheet; what the
map adds is the **palette bank in bits 12-13** (0/1/2 - *not* bits 10-11,
which are always clear). That is why 22 palettes hold 48 colours, and why
without the banks Zeromus EG looked off-colour, Lunar Ramuh had yellow
patches and Lunar Dragon's neck/wing were wrong. Those layouts are now
`monsterTilemaps` (fragmented, `pointerObject` on `monsterSize.tilemapPointer`,
itemRanges - they tile `0x081DA7F8-0x081DB654` exactly), and the new generic
`ROMArray` key **`itemTilePalettes`** gives each pooled graphic a
`tilePaletteCells` reference `{path, index, at: 12, stride: 2, shift: 12,
mask: 3}`. `ROMGraphics.tilePaletteBank(t)` reads it live from the ROM, so
editing a layout repaints the sprite, and `ROMGraphicsView.paletteBitsForTile`
applies the bank while `updateTilemap` suppresses the palette panel's own row
shift (same contract as the FF3 NES palette-cell table).

**Character sprites were missing entirely.** `0x080F7B18-0x080F8018` is a
second 320-pointer table: **20 groups of 16 pointers = 15 animation frames +
the group's palette last**. These are the party/enemy-class sprites - the
enemy "monsters" Dragoon, Bard, Monk, Dark Knight, Girl and Dark Kain (slots
202-206, 280) are exactly the records whose `nextFrame` is below 32, i.e.
character groups 1, 6, 7, 0, 3 and 19. Modelled as
`characterSpriteProperties` (20 records of 64 bytes: `graphicsPointer0..14` +
`palettePointer`), `characterGraphics` (226 objects after de-duplication) and
`characterPalettes` (20), all under the Character section.

**Frames are not all the same shape, and there is no size table.** Measured
payload tile counts: 235 frames are 6 tiles and 65 are 9. Frames 11, 14 and
15 (and frames 3-15 of Anna) are 9 tiles = **3x3**; frame 10 is the **death
pose** - the sprite lies down, so its six tiles are **3 wide x 2 tall**, not
2x3 like the standing frames. There is no per-frame dimension table anywhere
in the ROM (I searched for the signature), so the arrangement lives in the
animation code; the generator bakes the sizes through `itemSizes`.

**A frame shared by several classes cannot have one palette pin.** Frames
repeat heavily across groups, so pinning such a block to one class showed the
wrong colours for the others (the user's "the palette does not change when
selecting a sprite"). Shared blocks now get a **named choice list** of every
sharing class's palette plus the whole array - the same pattern as the FF4
SNES Pig/Small/Toad choices - and single-class frames stay pinned.

**Golbez and Anna really do look thin, and it is the ROM.** Anna's frames
3-15 all point at the *same* block, and Golbez's frames 1,2,4,5,6,7,8,11,14,15
all point at one block too. Their distinct art is two frames each; the rest is
the game reusing a stock block. Their class names are not in `characterTitle`
(which stops at 15 entries and calls 14 "None"), so they are baked in
`CLASS_NAMES`: 14 Small, 15 Frog, 16 Pig, 17 Golbez, 18 Anna.

**Portraits.** There is ONE contiguous pointer table at `0x080F2D48` with
**321** entries — what looked like two tables (`0x080F2D48`/225 and
`0x080F3100`/83) is just where a pointer-run scan stopped, and the 13 pointers
in between are part of the same table. Getting that wrong is what caused the
bad palettes: pairing each table on its own left the 10th set (Porom) with no
palette run at all, so it fell back to the array's first palette. Walking the
whole table gives the pattern **12 graphics then 12 palettes**, repeated —
13 complete sets and one trailing 9-graphic set — one set of expressions per
character. Each block is 16 tiles (4x4 = 32x32 px) with a **32-colour**
palette, and **colour 0 is the flat backdrop behind the face, so it is
transparent** (`backColor: false`); it is blue, red or black depending on the
set, which is what made it look like a missing colour.

The sets are in the ROM's own character order — set 10 is Porom, which is
`characterNames[9]` — so they are named from that table (Cecil, Kain, Rosa,
Rydia, Cid, Tellah, Edward, Yang, Palom, Porom, Edge, FuSoYa, Golbez). Each
set has 12 expressions but only 6 distinct blocks (expressions 1,2,3,4,7,10),
which is why the de-duplicated count is 82. The trailing 9-graphic set has no
palette run of its own: it is **adult Rydia** and the game reuses young Rydia's
palettes (`PORT_REUSE`). Modelled as `portraitGraphics` / `portraitPalettes` /
`portraitPointers` under Character.

**Unnamed monster slots are mostly named now.** The 283-361 range is extra
animation frames, and two ROM-internal signals identify 60 of the 79 without
any external data: (a) a named monster of the *same size* sharing the slot's
*palette pointer*, and (b) for the tile-mapped Esper set, pairing orphan
tile-mapped slots with named tile-mapped slots by size in table order. Rule
(b) is independently confirmed by the animation chain, which already links
slot 348 to Lunar Ramuh. So 314-320 are `Octomammoth (extra frame)`, 327-336
`Demon Wall (frame n/11)` from the chain, 339-350 the Lunar espers' extra
frames, 355-360 the monk/drillmaster pair. Ambiguous ones say what they
overlap instead of inventing a name: `slot 325 (same size as Bahamut, Dark
Bahamut, Lunar Bahamut)`. Only 4 remain with no clue at all (299, 313, 337,
338).

**Naming follows the FF4 SNES definition** (`ff4/ff2u-sfc.json`) wherever the
two games describe the same thing, so the tree reads consistently:
`Cecil (Dark Knight)`, `Cecil (Paladin)`, `Rydia (Child)`, `Rydia (Adult)`,
`Kain`, `Rosa`, `Cid`, `Tellah`, `Edward`, `Yang`, `Palom`, `Porom`, `Edge`,
`FuSoYa`, `Golbez`, `Anna`, `Small`, `Toad`, `Pig`. Group 12 is **Cecil
(Paladin)**, not Golbez — Golbez is group 17 (its own class slot), which is
what the user confirmed. The ROM's `characterTitle` gives the job (D. Knight,
Dragoon, W. Mage, Summoner, Engineer, Sage, Prince, Monk, B. Mage, Ninja,
Lunarian, Paladin) and `characterNames` the party in the same order, so the
job is appended in brackets only when the name does not already carry a form
in parentheses. Palette dropdown entries use the SNES `N: Name` convention.

**Slot identifications from the user, baked in `ALIAS`** (the derived rules
could not settle these): 288 Mist Dragon (mist), 299 Demon Wall (another
form), 305/306 Chocobo (summon frames), 313/337/338 Sylph, 321 Pig, 322 Frog,
323 Tiny Mage, 325 Mist Dragon, 326 skeleton monster, and 302 is still a
mystery ("part of a snake"). The ROM calls 193/194 **Elemental Lord**, which
is another form of **Cagnazzo**, so `FORM_OF` labels them
`Elemental Lord (Cagnazzo form)` and their extra frames (289/290) read
`Cagnazzo (extra frame)`.

---

## 8. Remaining work / ideas, in priority order

1. **FF4 follow-ups**: summon layouts now come straight from the
   SummonTilemap (§3) and show every animation frame side by side, so the
   puzzle tool is no longer needed to rescue them — the only placement on
   disk is the user's Sylph strip from before the fix; delete it and
   regenerate for the ROM canvas if they want that. MomBomb's baked sheet is
   confirmed (artcheck: every pixel of the rip agrees). Ideas: use the now
   decoded stage/frame tables to mark or split frames (cells of each stage
   with a gap between them, or stage membership in a toolbox); add more keys
   to `PUZZLE_KEYS` if the user wants to tune bosses (all `bossGraphics_*`
   already work with the placement-override flow). FF4 (J) def
   (`ff4j-sfc.json`) still has the old
   blob model — same generator treatment needs a JP ROM (ask the user).
   Note the JP MomBomb arrangement (bossProps 13, 10×9) is probably the JP
   ROM's real map — verify with a JP ROM instead of the baked layout.
2. **FF4 Advance GBA follow-ups** (`ff4/ff4u-gba.json`) — round 2 done:
   animation chains named by frame, per-tile palette banks for the 22 pooled
   monsters, shared-block sizes, and the character sprite tables. Verified by
   `ff4-gba-xcheck.js` (now also banks vs the ROM layouts, character
   ownership/resolution) and `ff4-gba-app-test.js` (now also character
   paint/undo, banks, chain labels). Still open, in order of value:
   * **only 4 monster slots are still unnamed**: 283/284/285 (they share the
     Goblin/Imp/Melt Bomb block, so they are placeholders) and 302, which the
     user could not place either ("part of a snake").
   * **portrait art the ROM does not reference from these tables**: the user
     expects a single Golbez portrait, Namingway, and fat chocobo. The 321-entry
     table has no such entries, so they live somewhere else (namingway is a
     gag NPC, fat chocobo is an event sprite) — not found yet.
   * **character frames are not composed into poses.** Each group is 15
     separate blocks and the sizes are baked (2x3 / 3x2 death / 3x3 poses);
     the game assembles them with a pose/OBJ descriptor that has not been
     found, so a `spriteSheet` per group is still possible but needs that
     table. Frame 10's 3x2 and frames 11/14/15's 3x3 were confirmed by eye,
     not derived.
   * **the Demon Wall frames look scattered.** Its 224-tile block holds the
     right tiles (wall texture + face) but not in raster order, and only 66 of
     the sheet's 224 tiles match a block tile exactly — the ripped sheet is a
     composite of the 11 frames, so the per-frame arrangement is the game's
     own and still undecoded. No other slot in 283-361 is known to be wrong.
   * `monsterProperties` looks one record short (battle id 282 "Specter"
     exists; the array holds 282 records).
   * `ff4e-gba.json` (FF IV Advance Europe) has the same layout — run
     `tools/ff4-gba-names.py` on it once the user supplies that ROM; the
     battle code still falls back to the flat array until then.
3. **FF5 SNES** (`ff5/ff5j-sfc.json`, `ff5u-sfc.json` — RPGe US def exists;
   user has NO FF5-SFC ROM though — ask, or validate only structure):
   todo says "monster graphics (set format automatically)" — def already has
   pointerObject; add `sizeFrom`/`formatProp` like FF4 (FF5 SFC boss
   mechanism resembles FF4's: `ff5-battle.js` resolves `.target` already).
4. **FF1 NES** (`ff1/ff1u-nes.json`, ROM available): monsterGraphics etc.
   are already fixed-length graphics arrays with nes2bpp — mostly works;
   add names (monster names are at 0x?? — decode), per-fiend palettes, and
   the "fiend/chaos tilemaps" todo. FF1 uses mmc1: `file=((bus&0xFF0000)>>2)
   +(bus&0x3FFF)+0x10`.
5. **FF2 NES** (`ff2/ff2u-nes.json`, no ROM in ff-roms — ask user): only map
   graphics modeled; battle sprites not done.
6. **Attack/boss *placement* editing** (any game): tilemap views still
   read-only for their source graphics by design (map-tileset rule); FF3
   solved boss placement with real ROMTilemaps (`ff3BossTilemap` format) —
   FF4 could get `ff4BossTilemap` tilemaps + `layoutFrom` later; the puzzle
   tool is the pragmatic path today.
7. Long tail from todo.txt: FF6 Steam string tables, FF6 GBA extras, battle
   animation editor, WSC/PSP/PSX versions.

## 9. Files and commits

Committed by the user so far: `e25dc5c` (FF4 graphics round 1),
`70fc075` (ips patches), `9ee10a7` ("fixing some issues with graphics,
better palettes" = round 2: hiddenItems, boss/summon windows, palette
units, `ff4-battle-vram.js` loadMonsterPalette, `gui/navigator.js`,
README/todo).

Uncommitted at time of writing (round 3, plus round 4 = MomBomb row-6 blank,
SummonTilemap summon canvases, `tools/ff4-sfc-artcheck.py` (new), the canvas
re-derivation in the xcheck and the app-test updates):
`HANDOFF-FF4-SFC.md` (this
file), `tools/ff4-sfc-puzzle/{puzzle_server.py,puzzle.html,placements/}`
(new), and modifications to `HANDOFF.md`, `ff4/ff2u-sfc.json` (generated),
`tools/ff4-sfc-names.py`, `tools/ff4-sfc-xcheck.js`,
`tools/ff4-sfc-app-test.js`, `rom/romtools.js` (layoutFlip + getter),
`gui/graphics-view.js` (layout without window + v-flip in tileOffset and
tilemap).

## 9. Tone/working agreement from the user

Small iterative rounds; user tests in the real app and reports concrete
symptoms ("middle is missing", "clicking X selects Y"); expects findings
documented (they read the HANDOFFs); offers tools when automation hits its
limit ("create a server for me to manually arrange the tiles"); appreciates
data-driven verification (zip rips, decode parity, byte-exact undo).
**Never commit; leave the tree for them.**
