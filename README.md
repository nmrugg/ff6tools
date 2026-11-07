# FF6Tools

FF6Tools is a browser-based app for editing Final Fantasy ROM files for the
NES, SNES, and GBA. The latest version is always available here:
https://everything8215.github.io/ff6tools/

Please post questions and comments in the FF6Tools thread at ff6hacking.com:
https://www.ff6hacking.com/forums/thread-3321.html. You can also find me on
the FF6Hacking Discord server.

FF6Tools started as an app for OS X which is no longer being developed.
Old builds are available here:
https://www.ff6hacking.com/wiki/doku.php?id=ff3:ff3us:util:ff6tools

A few folks have asked if I accept donations, so I set up a Patreon. If you'd
like to help me out, I'd appreciate it!
https://www.patreon.com/everything8215

## Currently supported ROMs

### NES/Famicom

- Final Fantasy (U)
- Final Fantasy (J)
- Final Fantasy I+II (J) (FF1 only)
- Final Fantasy II (Chaos Rush and NeoDemiforce Translations)
- Final Fantasy II (J)
- Final Fantasy III (Translation by Alex W. Jackson, Neill Corlett, SoM2Freak)
- Final Fantasy III (J)

### SNES/Super Famicom

- Final Fantasy II (U)
- Final Fantasy IV (J)
- Final Fantasy V (RPGe translation)
- Final Fantasy V (J)
- Final Fantasy III (U)
- Final Fantasy VI (J)

### Gameboy Advance

- Final Fantasy IV Advance (U)
- Final Fantasy IV Advance (E)
- Final Fantasy V Advance (U)
- Final Fantasy V Advance (E)
- Final Fantasy VI Advance (U)
- Final Fantasy VI Advance (J)
- Final Fantasy VI Advance (E)

### Modified and Mislabelled ROMs

If a ROM's CRC32 does not match a built-in definition, FF6Tools asks you to
choose one. Sometimes the difference is only in the header or in a patch that
has been applied to the ROM, and the data itself is fine. The `patches/`
directory contains IPS patches that restore two such dumps to the reference
versions FF6Tools expects:

- `ff5e-europe-strip-boot-patch.ips` — removes a boot-hook patch from a
  *Final Fantasy V Advance (Europe)* ROM (reset vector redirected to injected
  code at `0x08FB0000`, plus two trampolined game routines).
- `ff3j-nes-fix-dump.ips` — fixes the iNES header of a *Final Fantasy III
  (Japan)* ROM that declares mapper 132 instead of mapper 4. The 512 KiB of
  program data in that dump is already byte-identical to the reference; only
  five header bytes differ.
- `ff3u-nes-fix-dump.ips` — the same five header bytes for a
  *Final Fantasy III (English translation)* dump.

All three patches were verified by applying them and confirming the result is
byte-identical to the reference dump.

### NES definition addresses

Ranges in NES definition files are **not** file offsets. They are in the tool's
mapper-mapped address space, converted by `ROM.MapMode` in `rom/romtools.js`
(for example, for `mmc3`: `file = ((addr & 0xFF0000) >> 3) + (addr & 0x1FFF) + 0x10`,
which includes the 16-byte iNES header). GBA definitions use real GBA addresses
(`0x08000000`-based). If a graphics dump renders as noise, check this first.

## How to Use FF6Tools

Although FF6Tools is a browser-based application, it runs entirely on your
computer. There is no server-side code. When you open and save files, it's just
loading things into your browser. It doesn't actually upload or download
anything to the internet. You must supply your own ROM files.

### Loading a ROM

Click the folder button or press Ctrl+O (Cmd+O on Mac) to select a ROM file.
FF6Tools calculates the CRC32 checksum of the file to determine which ROM you
are attempting to open. FF6Tools uses definition files in either JSON or YAML
format to store all of the information needed to open a ROM file. Definition
files for all of the supported ROMs listed above are included with FF6Tools.

If the CRC32 of your file does not match any of the ROMs currently supported
by FF6Tools, you will be prompted with a list of built-in definitions that you
can select to open your ROM. If you are attempting to open a modified ROM, you
can select the built-in definition that most closely matches it. You can also
choose a custom definition file which you will get when you save your ROM.
When opening a modified ROM that was created by FF6Tools, it is recommended
to choose the definition file that came with it. However, keep in mind though
that as more features are added to FF6Tools, they may not be available with
an older definition file.

If you open a ROM with a 512-byte SNES/SFC copier header, FF6Tools
will remove the header. These headers are obsolete and are neither required
nor recognized by any modern emulators, though some older IPS patches require
a headered ROM.

NES ROMs require a 16-byte iNES header. GBA ROMs never have a header.

### Modifying a ROM

FF6Tools has various editors for modifying the data in a ROM, including maps,
battles, monsters, characters, items, and attacks. The left pane shows a
hierachical view of the data in the ROM that can be modified. Selecting an
item in the hierarchy allows you to edit the data in the center pane (editor)
and the right pane (toolbox and properties). In general, the toolbox and editor
are used to show a visual preview of maps, battles, etc. The properties pane
is used to directly modify properties and attributes of whatever is currently
selected. There is also a script pane that will appear below the editor when
you select a script (for events, monster A.I., etc.).

#### Map Editor

Use the layer buttons above the toolbox to select which
layer to edit. The buttons above the editor can be used to turn layers on and
off, and to show various screen masks like tile passability and the screen
size that will be visible in-game. Left click on the map to draw tiles. Select
tiles in the toolbox by clicking. You can click and drag to select multiple
tiles at once. You can also right click and drag on the map to select tiles
on the currently selected layer.

When the trigger layer is selected, left click on the map to select a trigger.
If there is more than one trigger at the same point, you can click multiple
times to cycle through all of the triggers. Click and drag to move a trigger.
Right click to bring up a menu with options to insert and delete triggers.

#### Battle Editor

Click on a monster to select it. In most games, monsters can be dragged
around to change their position. Click on an empty area of the battle to
select the battle properties, where you can usually add and remove monsters
from the battle. Some games have a VRAM view that allows you to see how the
monster graphics will be stored in the system's video memory.

#### Graphics and Tilemap Editor

FF6Tools can view graphics and, for graphics objects, edit them directly.
FF6Tools can import and export graphics in several different formats, which
are compatible with widely available graphics editing programs. In order
to preserve color palette data, it is recommended to use indexed png files
whenever possible. When importing graphics, it is possible to import an entire
image, or just a rectangular section of an image. It is also possible to
enable/disable import of the graphics or palette. When importing an RGB image
(non-indexed) FF6Tools will quantize the image and generate an optimized
palette based on the color depth of the target system's graphics. Note,
however, that the colors produced by the quantization may not be in the
correct order for use with the ROM.

The tilemap editor allows you to edit tile data which is used to assemble
tile-based graphics into larger images. The graphics tiles which are available
are displayed in the toolbox in the right pane and can be imported and exported
just as described above. Some tilemaps allow you to flip tiles and change a
tile's layering priority and palette index. Controls for these will be shown
above the tilemap editor when they are available. Helpful masks can be enabled
using the menu above the tilemap editor.

Note that map tilesets are shared by many maps, so painting a tileset changes
every map that uses it. Map tileset graphics are therefore not editable with
the painting tools; use import/export for those.

#### Painting Graphics

When a graphics object is selected you can edit it directly, without leaving
the app. A **Tool** menu appears above the editor:

| tool | key | what it does |
|---|---|---|
| Select | `V` | drag a rectangle (used for partial imports) |
| Pencil | `B` | paint single pixels; a stroke continues if the pointer leaves the image and returns |
| Fill | `G` | flood-fill the contiguous region under the click |
| Colour picker | `I` | pick up the palette index under the cursor |

Other controls:

- **Right-click is always the eyedropper**, anywhere in the editor pane, and it
  tracks while the button is held. The cursor shows an eyedropper while held,
  and the picker's bulb is tinted with the currently selected colour.
- Click a colour in the **Palette** panel to choose the paint colour.
  **Double-click or right-click a palette colour** to change that colour's RGB
  value with the system colour picker.
- The **Clipboard** menu (or `Ctrl+C` / `Ctrl+V`) copies and pastes a pixel
  rectangle. A pasted layer "floats": drag it to position it, then press
  `Enter` or click outside it to place it, or `Esc` to cancel. Transparent
  pixels never overwrite, and the layer is kept inside the image.
- `Delete` or `Backspace` clears the selected area to transparent.
- **Middle-click (drag) pans** the image; the mouse wheel **zooms at the
  cursor**, anywhere in the pane. `Shift`+wheel or `Alt`+wheel scrolls instead.
- **Image bounds** dims the area outside the editable image and shades grid
  cells that have no data behind them. **Tile grid** draws light tile
  boundaries. Both are off by default.

Painting, paste and delete are ordinary ROM actions, so `Ctrl+Z` undoes them.
Undo restores the original compressed bytes exactly when the decoded data
returns to the state that was loaded, so undoing all the way back leaves the ROM
byte-identical.

Each graphics object is linked to the palettes it actually uses. In Final
Fantasy III (J) and (U) on the NES, monster graphics are grouped by sprite
size (4x4, 4x6, 6x6, 6x6, 6x12 and 12x6 tiles) and every entry is labelled with
the monsters that use it - boss monsters first, marked with `*`. Most monsters
are drawn with **two** palettes of three colours plus black, and the game picks
one per 2x2 tile block; FF6Tools reads that choice from the ROM, so a monster
appears with both palettes at once (Mandrake's brown body and green leaves, for
example) rather than one or the other. The Palette panel's dropdown leads with
the palettes belonging to the selected graphic, named after its monsters.

Note that colour 0 is opaque black: it is the sprite outline as well as the
filler inside the tile rectangle, so the black around a monster is in the ROM,
not an artefact.

In Final Fantasy IV (U) on the SNES (labelled *Final Fantasy II (USA)*),
monster graphics are grouped into 90 shared objects selected by a pointer
table, and every entry is labelled with the monsters that use it. Ordinary
monsters display at their size-class dimensions. Bosses are built from
shared tile pools that the game arranges with a per-boss tile map: under
**Boss Graphics** each boss opens as the assembled creature, and painting
it writes through to the pool tiles it is built from (the raw pools are
hidden from the Monster Graphics tree to avoid duplicates). Under
**Summons** all fifteen Espers are listed: those whose animation reuses
their monster art point at it directly, and Chocobo, Shiva, Ramuh, Ifrit
and Sylph - whose summon-only art lives elsewhere in the ROM - get their
own editable graphics. Most monsters are 3bpp and use one 8-colour
palette; the few 4bpp ones (Zeromus) get two consecutive ROM palettes
composed into one 16-colour palette automatically. Attack graphics are
editable directly under Character (**Attack Graphics**); the animation
layout itself is under **Attack Tilemap**.

Summon and boss graphics are tilemaps over shared tile pools, so they appear
under **Summon Graphics** and **Boss Graphics** as editable tile layouts - the
summons' tilemaps also carry a per-tile palette selection, so they render with
all three of their sprite palettes. The tiles themselves are repainted through
the graphics each tilemap points at. Most bosses are ordinary-sized monsters and
are found under Monster Graphics; only 32 of the 127 boss monsters use the
tilemap mechanism.

In the navigator, `Up`/`Down` move the selection between entries instead of
scrolling; running off the end of a section expands the next one and steps into
it. The graphics tiles which are availableare displayed in the toolbox in the right pane and can be imported and exported
just as described above. Some tilemaps allow you to flip tiles and change a
tile's layering priority and palette index. Controls for these will be shown
above the toolbox when they are available. Helpful masks can be enabled using
the menu above the tilemap editor.

### Saving a ROM

After you have made changes to a ROM, click the disk button or press
Ctrl+S (Cmd+S on Mac) to save your ROM. FF6Tools will attempt to reassemble
all of the ROM data to make a new ROM file. If this process succeeds, your
browser will "download" a zip file containing the modified ROM, a custom
definition file, and a ROM map. The modified ROM will have the standard ROM
file extension for the applicable system (.nes, .sfc, or .gba). The
definition file is in either JSON (default) or YAML format, and is needed in
order to re-open a modified ROM with FF6Tools. The ROM map is a text file and
is for information only.

In some cases, modified ROM data will increase in size such that it no longer
fits in the region of the ROM where it was originally stored. When this
happends, FF6Tools will prompt you with a list of options for how to deal
with the new data. Note that the "Relocate", "Optimize", and "Expand" options
can cause a ROM to no longer be compatible with patches and other utilities.

### Compatibility with FF3usME

FF3usME is another commonly used ROM editor written by Lord J. Because FF3usME
is closed-source, it is not known exactly what changes it makes when saving a
ROM. Because of this, compatibility issues can arise when trying to
open a ROM previously edited in FF3usME. Fixes for some of these issues are
described here. These fixes can be implemented by editing the definition file
that you use to open a ROM in FF6Tools.

#### World of Ruin Graphics and Tilemap Swapped

If the World of Ruin is blank in the map editor (black/blue vertical stripes)
edit your definition file as follows:

- Search for `"worldGraphics2"` and change its `"range"` to `"0xEF7D07-0xEF9D17"`
- Search for `"worldLayout2"` and change its `"range"` to `"0xEF4A46-0xEF7D07"`

#### World of Balance Graphics Data Moved

This problem seems to be much less common. If the World of Balance looks
corrupted in the map editor (wrong tiles with blue/white palette) edit your
definition file as follows:

- Search for `"worldGraphics1"` change its `"range"` to `"0xEF111C-0xEF3250"`
- Search for `"worldLayout1"` change its `"range"` to `"0xEED434-0xEF111C"`

### Fixes for Other Known Issues

#### Treasure data in FF5 (SNES/SFC versions)

There can be up to 256 unique treasures in FF5, and they are stored sequentially in the ROM by map index. There is a table at 0x113000 that determines the index of the first treasure on each map. The problem is that there are two maps which share the same treasure data with a previous map, so their values in the table are out of sequence. FF6Tools doesn't know how to deal with this so it just duplicates the treasure data for those two maps when you save. But then there are more than 256 treasures in the game, so the table overflows and the last few treasures (on map 507) become inaccessible. Maps 216 and 218 are both level 5 of the Ronka Ruins, and maps 227 and 235 are both level 2 of Castle Exdeath.

Here is a way to prevent this issue. Any time you edit any treasures with FF6Tools, before saving the ROM, delete the treasures from maps 218 and and 235 (right click and select "Delete Trigger" from the menu). If you want to edit those treasures, do so from maps 216 and 227. After saving, open the ROM with a hex editor and go to offset 0x1130DA and change one byte to match the byte at 0x1130D8, then go to offset 0x1130EB and change it to match the byte at 0x1130E3 (the values should be 0x64 and 0x66 unless you added or removed treasures in previous maps). You only need to do this after modifying treasures with FF6Tools, so if you open the ROM again later to make other changes you won't need to do this again.

Thanks to Tzepish for pointing this out.

## Acknowledgments

The following people contributed to FF6Tools, either indirectly by creating
documents and tools that were used for reference or directly via chatting on
various hacking forums and Discord (in no particular order): madsiur,
Geiger/Evil Peer, Cless, Master ZED, Imzogelmo, Terrii Senshi, Mnrogar,
Yousei, Lord J, Novalia Spirit, Corundum, giangurgolo, Disch, Ben Siron,
PKT Paladin, Kea, JCE3000GT, samurai goroh, Lenophis, m06, Squall_FF8,
Warrax, Tenkarider, Grimoire LD, Odym82, Jorgur, instructrtrepe,
Light Phoenix, kwhazit, killXtech, snaphat, Maeson, OS, Dreami

FF6Tools uses the following libraries:

- split.js (https://github.com/nathancahill/split/)
- jszip (https://github.com/Stuk/jszip)
- FileSaver.js (https://github.com/eligrey/FileSaver.js/)
- pako (https://github.com/nodeca/pako)
- ResizeSensor (css-element-queries) (https://github.com/marcj/css-element-queries)
- pzntg (https://github.com/hectorm/pzntg)
- RgbQuant.js (https://github.com/leeoniya/RgbQuant.js/)
- balloon.css (https://github.com/kazzkiq/balloon.css)
- js-yaml (https://github.com/nodeca/js-yaml)
- base64-js (https://github.com/beatgammit/base64-js)
- fontawesome (https://fontawesome.com)
