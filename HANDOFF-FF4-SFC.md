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
SNES ("Final Fantasy II (USA)"). Validate with the user's legal ROMs in
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
- `layout` (static cell→tile map, -1=empty) + `layoutFlip` (bit1 h, bit2 v)
  — the view renders any object with `layout` as the assembled creature
  (poolLayout/poolFlip), paint writes through `tileOffset` (flip-aware).
GUI gotchas: `ROMRange.parse` only accepts STRINGS ("0-8"), returns 0-0 for
objects; `GFX.graphicsFormat[formatKey] || this.format` guard for format-less
blobs; two tree rows pointing at the SAME object path make the navigator
highlight the wrong row (`this.node[path]` first-wins) — give every tree row
its own assembly (this was the user-visible "clicking Mist Dragon selects
Summons" bug; fixed by making all 15 `summonGraphics_*` their own windows).

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
  **`SummonTilemapPtrs` 0x0df260 is the OBJ-VRAM placement, and the only
  complete picture of an Esper** (`TfrSummonGfx` @0x028409): one byte per 8×8
  tile *slot*, in slot order, where slot = row*16 + col of the 16-tile-wide
  OBJ tile grid (slots $00-$7F are used); byte<0x80 = the next block tile
  goes to that slot, $80-$FE = blank slot (low 7 bits = slot, no tile
  consumed), $FF = end. Every animation frame of the summon sits in that
  grid at the same time, so laying the stream out on the grid is the sheet
  that holds them all (rendering each one gives a complete Esper — verified
  for all 17). `SummonFramePtrs` 0x0df660 + the stage sets at 0x13fa9d (4
  per summon, chosen by (`$f326`>>3)&3 in DrawSummon @0x01fdf9) feed w*h
  16×16 cells from `SummonSpritePosTbl` 0x13fa59 (x,y,w,h in 16px units);
  each stream byte (`_03f7e8` @0x03f7e8) = the OBJ slot of the cell's
  top-left tile, so a cell covers slots n, n+1, n+16, n+17 — **not n..n+3**,
  which is what the first version of the generator assumed and why its
  summon layouts looked like overlapping fragments. $80+/$FE n/$FF = blank
  cells, and the pointer is reloaded from the stage's start on every frame,
  so a stage is one static picture, not a timeline. Streams are shared
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
  Ifrit, Sylph). All 15 carry a `layout` = the SummonTilemap stream laid out
  on the 16-wide OBJ grid and cropped, so every animation frame of the Esper
  appears side by side: Imp/Bomb 4×4, Cockatrice 6×4, Mindflayer 6×6,
  Chocobo 8×4, Shiva/Ramuh 12×6, Ifrit 16×6, Titan 14×8, Dragon Mist 10×8,
  Sylph 6×2, Odin/Leviathan/Asura 16×8, Bahamut 16×8. `ff4-sfc-xcheck.js`
  re-derives every canvas from the ROM and compares (it skips keys that have
  a puzzle placement).
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
click-place, right-click cycles flip (0/1/2/3), shift-click erases, Save
POSTs to `tools/ff4-sfc-puzzle/placements/<key>.json`
(`{key,cols,rows,placement:[{cell,tile,flip}]}`, tile reuse allowed).
The generator reads those and overrides computed layouts (verified
round-trip; delete file + regenerate to revert). The grid now starts from
the ROM's own arrangement (the SummonTilemap canvases are correct, see §3),
so the tool is for tuning rather than rescuing; offered keys are the 5
dedicated summons + `bossGraphics_36` (MomBomb), and any other
`summonGraphics_*`/`bossGraphics_*` key can be added to `PUZZLE_KEYS`.
**The only placement on disk is the user's Sylph (12 tiles in a 2x10 strip),
saved while the automatic arrangement was still wrong - placements win, so
that is still what the def shows; delete
`placements/summonGraphics_Sylph.json` and regenerate for the ROM's 6x2
three-frame canvas.**
Shell gotcha: each of your commands runs in a NEW shell — `kill %1` won't
work; use `pkill -f puzzle_server.py`, and beware "Address already in use"
races (sleep before rebind).

## 6. Tests (all green at time of writing; run after ANY change)

```bash
FF5E_ROM="/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc" \
  node tools/rom-harness.js ff4/ff2u-sfc.json            # 0 diffs
node tools/ff4-sfc-xcheck.js                             # model/parity/undo
node tools/ff4-sfc-app-test.js                           # browser: paint, windows, pins
python3 tools/ff4-sfc-names.py --def ff4/ff2u-sfc.json --rom "..."   # regen
python3 tools/ff4-sfc-artcheck.py     # baked Mom Bomb sheet vs ff4monsters.zip
SHOT_ROM="/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc" \
  node tools/app-shots.js 'bossGraphics_36' 'summonGraphics_Chocobo'  # eyeball
# regressions:
node tools/ff3-nes-xcheck.js ; node tools/ff3-nes-app-test.js ; node tools/ff3-nes-map-smoke.js
FF5E_ROM=... node tools/ff5e-xcheck.js   # slow (~4 min), background it
node tools/ui-edit-test.js ; node tools/ui-features-test.js ; node tools/map-smoke-test.js
node tools/demo-paint.js
# other defs round-trip with user ROMs (ff6/ff3u-sfc, ff1/ff1u-nes, ff4/ff4u-gba, ff4/ff4j-sfc)
```
Browser-test traps: set `view.paintStart = view.graphics.slice()` before
driving paint tools directly; use `rom.parsePath(key)` not `rom.assembly.key`
(the latter skips the lazy getter); fresh Chrome profile + `--disk-cache-size=1`
already in the harnesses; pixel-offset math: `tileOffset = idx*64 + py*8 + px`.

## 7. Remaining work / ideas, in priority order

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
2. **FF4 Advance GBA** (`ff4/ff4u-gba.json`, ROM available): `monsterGraphics`
   is a 724-item pointerTable array of RAW items (battle code decodes
   per-item tose/lzss formats at draw time). Apply the FF5-GBA treatment:
   `pointerObject` + `sizeFrom` (its `monsterSize` is indexed per monster:
   width/height at begin 3/4 ×8) + graphics type + palette pins; the
   interleaved item layout (m*2 palette / m*2+1 graphics) must survive
   (see HANDOFF §2 for the FF5 pattern; battle code `drawMonsterGBA` uses
   `item(m*2+1)` — verify pointer order == monster order before changing).
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

## 8. Files and commits

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
