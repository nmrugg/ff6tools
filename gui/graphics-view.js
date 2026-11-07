//
// graphics-view.js
// created 9/4/2020
//

class ROMGraphicsView extends ROMEditor {
    constructor(rom, tilemapView) {
        super(rom);

        this.name = 'ROMGraphicsView';
        this.tilemapView = tilemapView;
        this.paletteView = new ROMPaletteView(rom, this);
        this.toolbox = this.paletteView.toolbox;
        this.editorMode = false;
        this.toolboxMode = false;
        this.previewMode = false;

        this.zoom = 2.0;
        this.width = 16; // width in tiles
        this.height = 16; // height in tiles
        this.tileWidth = 8; // tile width in pixels
        this.tileHeight = 8; // tile height in pixels
        this.maxHeight = 256; // max visible height in toolbox mode
        this.bytesPerTile = this.tileWidth * this.tileHeight;
        this.backColor = false;
        this.graphics = new Uint8Array(this.bytesPerTile);
        this.tilemap = new Uint32Array();
        this.spriteSheet = null;
        this.ss = 0; // sprite sheet index
        this.float = null;      // pasted but not yet committed layer
        this.floatDrag = null;  // drag offset while moving that layer
        this.object = null;
        this.definition = null;
        this.format = GFX.graphicsFormat.linear8bpp;
        this.page = 0;
        this.hFlip = false;
        this.vFlip = false;
        this.z = 0;

        this.clickPoint = null;
        this.selection = {
            x: 0, y: 0, w: 0, h: 0,
            tilemap: new Uint32Array()
        };
        this.float = null;
        this.floatDrag = null;
        this.painting = false;
        this.picking = false;
        this.panning = null;
        this.rightHeld = false;

        // painting (0 = Select, 1 = Pencil, 2 = Fill, 3 = Color picker)
        this.tool = 1;       // pencil by default; V switches back to Select
        this.color = 1;      // palette index used by pencil/fill
        this.painting = false;
        this.paintStart = null;
        this.rightHeld = false; // right button down -> show eyedropper
        this.picking = false;   // eyedropper drag in progress
        this.panning = null;    // middle-button pan state
        this.panX = 0;          // image offset from centre (transform based, so
        this.panY = 0;          // it works whether or not the pane can scroll)
        this.panObject = null;  // object the current pan belongs to
        this.showBounds = false; // shade the area outside the image data
        this.showGrid = false;  // light tile grid lines
        this.cursors = null; // generated lazily

        // off-screen canvas for graphics at 1x zoom
        this.graphicsCanvas = document.createElement('canvas');
        this.ppu = new GFX.PPU();

        // on-screen canvas for graphics and cursor
        this.canvas = document.createElement('canvas');
        this.canvas.classList.add('tileset-canvas');
        this.cursorCanvas = document.createElement('canvas');
        this.cursorCanvas.classList.add('cursor-canvas');

        this.canvasDiv = document.createElement('div');
        this.canvasDiv.classList.add('graphics-canvas-div');
        this.canvasDiv.classList.add('background-gradient');

        // wrapper sized exactly to the canvas, centred in the pane; the cursor
        // overlay is positioned relative to this so the two always line up
        this.canvasWrap = document.createElement('div');
        this.canvasWrap.classList.add('graphics-canvas-wrap');
        this.canvasWrap.appendChild(this.canvas);
        this.canvasWrap.appendChild(this.cursorCanvas);
        this.canvasDiv.appendChild(this.canvasWrap);

        // this.div = document.createElement('div');
        this.div.classList.add('graphics-div');
        this.div.classList.add('graphics-edit-pane');

        // add message handlers
const self = this;
        this.canvas.onmousedown = function(e) { self.mouseDown(e); };
        this.canvas.onmouseup = function(e) { self.mouseUp(e); };
        this.canvas.onmousemove = function(e) { self.mouseMove(e); };
        this.canvas.onmouseout = function(e) { self.mouseOut(e); };
        this.canvas.oncontextmenu = function(e) {
            // right click always picks up the color under the cursor
            self.rightClick(e);
            return false;
        };

        // right-click picking and wheel zoom work anywhere in the editor pane,
        // not just over the (possibly small) canvas
        this.div.oncontextmenu = function(e) {
            if (!self.editorMode || !self.object) return;
            if (self.rightClick(e)) { e.preventDefault(); return false; }
        };
        this.div.addEventListener('wheel', function(e) { self.mouseWheel(e); }, {passive: false});
        // capture phase, so Chrome's middle-click autoscroll never starts
        this.div.addEventListener('mousedown', function(e) {
            if (e.button === 2) {
                self.rightHeld = true;
                self.picking = true;
                self.updateCursor();
                return;
            }
            if (e.button === 1) {
                e.preventDefault();
                e.stopImmediatePropagation();
                self.panning = {x: e.clientX, y: e.clientY, panX: self.panX, panY: self.panY};
                self.updateCursor();
            }
        }, true);
        this.div.addEventListener('auxclick', function(e) { if (e.button === 1) e.preventDefault(); }, true);
        this.div.addEventListener('mousemove', function(e) {
            if (self.panning) return;   // handled by the document listener
            if (self.picking && (self.rightHeld || self.tool === 3)) {
                const p = self.pixelAt(e);
                if (p) self.pickColor(p.x, p.y);
            }
        });
        // panning continues even when the pointer leaves the pane
        document.addEventListener('mousemove', function(e) {
            if (!self.panning) return;
            self.panX = self.panning.panX + (e.clientX - self.panning.x);
            self.panY = self.panning.panY + (e.clientY - self.panning.y);
            self.applyPan();
            if (!self.panning.moved && (Math.abs(e.clientX-self.panning.x) > 2 || Math.abs(e.clientY-self.panning.y) > 2)) {
                self.panning.moved = true;
                self.updateCursor();
            }
        });
        document.addEventListener('mouseup', function(e) {
            if (e.button === 1 && self.panning) { self.panning = null; self.updateCursor(); }
            // A stroke must not stay open when the button is released outside
            // the canvas: an unclosed action group means there is nothing to
            // undo, and a stuck `painting` flag blocks every later reload, so
            // undo appears to do nothing.
            if (e.button === 0 && (self.painting || self.cellPainting ||
                                   self.paintStroke || self.paintStart)) {
                self.finishStroke();
            }
        });

        const endDrag = function(e) {
            if (e.button === 2) { self.rightHeld = false; self.picking = false; }
            if (e.button === 1 && self.panning) self.panning = null;
            self.updateCursor();
        };
        this.div.addEventListener('mouseup', endDrag);
        this.div.addEventListener('mouseleave', function(e) {
            endDrag(e);
            self.panning = null;
        });
    }

    show() {

        this.showControls();
        this.closeList();

        // update the toolbox div
        this.toolbox.div.innerHTML = '';
        this.toolbox.div.appendChild(this.paletteView.div);
        this.toolbox.show(false);

        // notify on resize
const self = this;
        this.resizeSensor = new ResizeSensor(this.toolbox.paneTop, function() {
            self.toolbox.setHeight(self.paletteView.div.scrollHeight);
            self.paletteView.resize();
            self.paletteView.redraw();
        });

        this.div.focus();
    }

    hide() {
        this.observer.stopObservingAll();
        if (this.resizeSensor) {
            this.resizeSensor.detach(document.getElementById('toolbox'));
            this.resizeSensor = null;
        }

        this.toolbox.hide();
    }

    // shade the parts of the displayed grid that have no data behind them, and
    // optionally draw light tile grid lines
    drawOverlays() {

        const ctx = this.cursorCanvas.getContext('2d');
        const tw = this.tileWidth, th = this.tileHeight;
        const bytesPerTile = this.bytesPerTile || (tw * th);
        const tileCount = Math.floor(this.graphics.length / bytesPerTile);

        // dim the pane outside the image itself
        if (this.canvasDiv) {
            this.canvasDiv.classList.toggle('show-bounds', !!this.showBounds);
            // the image needs an opaque backdrop so the dim does not show
            // through transparent pixels - but only when dimming is active,
            // otherwise its checkerboard would not line up with the pane's
            this.canvasWrap.classList.toggle('background-gradient', !!this.showBounds);
        }

        const imgW = this.width * tw * this.zoom;
        const imgH = this.height * th * this.zoom;

        if (this.showBounds) {
            ctx.fillStyle = 'rgba(20, 20, 25, 0.55)';
            for (let row = 0; row < this.height; row++) {
                for (let col = 0; col < this.width; col++) {
                    if (row * this.width + col < tileCount) continue;
                    ctx.fillRect(col * tw * this.zoom, row * th * this.zoom,
                                 tw * this.zoom, th * this.zoom);
                }
            }
            // also shade any partial tile at the end of the data
            const extra = this.graphics.length % bytesPerTile;
            if (extra && tileCount < this.width * this.height) {
                const col = tileCount % this.width, row = Math.floor(tileCount / this.width);
                ctx.fillRect(col * tw * this.zoom, row * th * this.zoom,
                             tw * this.zoom, th * this.zoom);
            }

            // outline the editable image so its limits are visible
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
            ctx.strokeRect(0.5, 0.5, Math.round(imgW) - 1, Math.round(imgH) - 1);
        }

        if (this.showGrid && tileCount) {            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
            ctx.beginPath();
            for (let col = 1; col < this.width; col++) {
                const x = Math.round(col * tw * this.zoom) + 0.5;
                ctx.moveTo(x, 0); ctx.lineTo(x, Math.round(imgH));
            }
            for (let row = 1; row < this.height; row++) {
                const y = Math.round(row * th * this.zoom) + 0.5;
                ctx.moveTo(0, y); ctx.lineTo(Math.round(imgW), y);
            }
            ctx.stroke();
        }

        // the floating pasted layer, drawn semi-transparent over the image
        if (this.float) {
            const f = this.float;
            const z = this.zoom;
            ctx.globalAlpha = 0.75;
            for (let y = 0; y < f.h; y++) {
                for (let x = 0; x < f.w; x++) {
                    const c = f.pixels[y * f.w + x];
                    if (!c) continue;                    // transparent
                    const col = this.paletteView.palette[c] >>> 0;
                    ctx.fillStyle = `rgb(${col & 0xFF},${(col >> 8) & 0xFF},${(col >> 16) & 0xFF})`;
                    ctx.fillRect((f.x + x) * z, (f.y + y) * z, z, z);
                }
            }
            ctx.globalAlpha = 1;
            ctx.strokeStyle = 'rgba(80, 170, 255, 0.95)';
            ctx.lineWidth = 2;
            ctx.strokeRect(f.x * z + 1, f.y * z + 1, f.w * z - 2, f.h * z - 2);
        }
    }

    resetControls() {
        super.resetControls();

const self = this;

        // painting tools (only for a directly selected graphics object; the
        // tileset toolbox is deliberately left alone - see notes)
        if (((this.editorMode && this.object) || this.paintablePool()) && !this.noToolMenu) {
            // "Palette cells" only makes sense for an object that has a
            // per-cell palette table in the ROM (FF3 NES monsters and bosses)
            const tools = ['Select','Pencil','Fill','Color picker'];
            if (this.object && (this.object.attributeRef || this.object.attributeCells))
                tools.push('Palette cells');
            this.addList('changeTool','Tool',tools,
                function(t){ self.tool=t; self.updateCursor(); self.redraw(); },
                function(t){ return t===self.tool; });
        }

        // add a control to select the sprite sheet
        if (this.object && this.object.spriteSheet) {
            function onChangeSpriteSheet(ss) {
                self.ss = ss;
                self.updateTilemap();
                self.resize();
                self.drawGraphics();
            }
            function spriteSheetSelected(ss) {
                return (ss === self.ss);
            }

            // create a list of tilemap options
            const spriteSheetList = [];
            if (isArray(this.object.spriteSheet)) {
                for (const [i, ss] of this.object.spriteSheet.entries()) {
                    spriteSheetList.push(ss.name || `Sprite Sheet ${i}`);
                }
            } else {
                spriteSheetList.push(this.object.spriteSheet.name || 'Default');
            }

            // select the first available tilemap if the current selection is unavailable
            if (this.ss >= spriteSheetList.length) this.ss = 0;

            // no tilemap is always the last option
            spriteSheetList.push('None');
            this.addList('changeSpriteSheet', 'Sprite Sheet',
                spriteSheetList, onChangeSpriteSheet, spriteSheetSelected);

        } else {
            this.ss = 0;
        }

        this.addZoom(this.zoom, function() {
            self.changeZoom();
        }, 0, 4);

        // overlay toggles
        if (this.editorMode && this.object) {
            this.addTwoState('graphics-show-bounds', function(checked) {
                self.showBounds = checked; self.redraw();
            }, 'Image bounds', this.showBounds);

            this.addTwoState('graphics-show-grid', function(checked) {
                self.showGrid = checked; self.redraw();
            }, 'Tile grid', this.showGrid);

            // clipboard: opens a small menu with Copy / Paste / Set / Cancel
            this.addList('changeClipboard','Clipboard',['Copy','Paste','Set layer','Cancel layer'],
                function(i){
                    if (i === 0) self.copySelection();
                    else if (i === 1) self.pasteClipboard();
                    else if (i === 2) self.commitFloat();
                    else self.cancelFloat();
                },
                function(){ return false; });
        }
    }

    changeZoom() {
        // this only applies in editor mode
        if (!this.editorMode) return;

        // update zoom
        const zoomControl = document.getElementById('zoom');
        const z = Number(zoomControl.value);
        this.zoom = Math.pow(2, z);
        const zoomValue = document.getElementById('zoom-value');
        zoomValue.innerHTML = `${this.zoom * 100}%`;

        this.resize();
        this.redraw();
    }

    // Does this object have a per-cell palette table in the ROM, with both
    // palettes loaded so a row can be chosen?
    paintableCells() {
        const obj = this.object || this.cellsObject;
        if (!obj || !obj.attributeRef) return false;
        const perPalette = this.paletteView.colorsPerPalette || 4;
        return this.paletteView.palette.length >= perPalette * 2;
    }

    // The palette row the current paint color belongs to: 0 or 1 when the
    // object has two composed battle palettes (FF3 NES), -1 otherwise.
    currentPaletteRow() {
        const perPalette = this.paletteView.colorsPerPalette || 4;
        if (this.paletteView.palette.length < perPalette * 2) return -1;
        return Math.min(Math.floor((this.paletteView.p || 0) *
                      this.paletteView.colorsPerPalette / perPalette), 1);
    }

    // Paint one 2x2 tile cell's palette choice, writing it back to the ROM's
    // attribute table (2F/A6FB).
    // A cell's palette bit lives in the ROM, but which palette each tile is
    // drawn with is baked into this.tilemap by updateTilemap. So after writing
    // a cell, the tilemap words have to be re-stamped - otherwise the change is
    // in the file but invisible until something else reloads (which is why it
    // only appeared when the mouse came up).
    refreshPaletteCells() {
        this._cellsFor = null;
        this.updateTilemap();
        this.redraw();
        const tv = this.tilemapView;
        if (tv && tv.graphicsView !== this) {
            tv.graphicsView._cellsFor = null;
            tv.applyPaletteCells();
            tv.redraw();
        }
    }

    paintCellPalette(x, y, row) {
        if (!this.paintableCells()) return false;
        const obj = this.object || this.cellsObject;
        // the graphics view works in pixels; a cell is 2x2 tiles
        const cell = attributeCellForPixel(obj, x, y, this.tileWidth, this.tileHeight);
        if (cell < 0) return false;
        if (row === undefined) row = this.currentPaletteRow();
        if (row < 0) return false;
        // the definition records the bits before the per-monster inversion, so
        // setAttributeBit needs the un-displayed value
        if (!!obj.attributeCellsInvert) row ^= 1;
        if (!setAttributeBit(obj, cell, row)) return false;
        this.refreshPaletteCells();
        return true;
    }

    mouseDown(e) {
        this.closeList();

        if (e.button === 2) return;   // handled by the picker path
        if (e.button === 1) {
            // stop Chrome's middle-click autoscroll so we can pan instead
            e.preventDefault();
            return;
        }

        // so the keyboard shortcuts below reach this view
        if (this.editorMode && this.div.focus) this.div.focus();

        // painting tools take priority over tile selection
        if (this.tool === 4 && this.paintableCells()) {
            // click a 2x2 cell to make it use the palette row you have selected
            const p = this.pixelAt(e);
            if (!p) return;
            this.cellPainting = true;
            this.rom.beginAction();       // a whole drag is one undo step
            this.paintCellPalette(p.x, p.y);
            return;
        }

        if (this.paintTarget() && this.tool !== 0) {
            const p = this.pixelAt(e);
            if (!p) return;
            switch (this.tool) {
                case 1: // pencil
                    this.painting = true;
                    this.paintStroke = true;
                    this.rom.beginAction();   // pixels + palette cells, one undo
                    this.paintStart = this.graphics.slice();
                    this.paintPixel(p.x, p.y);
                    break;
                case 2: // fill
                    this.paintStroke = true;
                    this.rom.beginAction();
                    this.paintStart = this.graphics.slice();
                    this.floodFill(p.x, p.y);
                    this.commitPaint();
                    break;
                case 3: // color picker
                    this.picking = true;
                    this.pickColor(p.x, p.y);
                    break;
            }
            return;
        }

        // a floating pasted layer is moved by dragging, and set by clicking
        // outside it (or pressing Enter)
        if (this.tool === 0 && this.float && this.paintTarget()) {
            if (this.floatContains(e)) {
                const p = this.pixelAt(e);
                this.floatDrag = {dx: p.x - this.float.x, dy: p.y - this.float.y};
            } else {
                this.commitFloat();
            }
            return;
        }

        let x = Math.floor(e.offsetX / this.zoom / this.tileWidth);
        let y = Math.floor(e.offsetY / this.zoom / this.tileHeight);
        x = Math.min(Math.max(x, 0), this.width - 1);
        y = Math.min(Math.max(y, 0), this.height - 1);
        this.clickPoint = {x: x, y: y};
        this.mouseMove(e);

        // select the graphics object in editor mode
        if (this.editorMode && this.object && propertyList.selection.current !== this.object) {
            propertyList.select(this.object);
        }
    }

    mouseOut(e) {
        // keep an in-progress stroke alive when the pointer leaves the canvas,
        // as long as the button is still held down
        if (this.painting && (e.buttons & 1)) return;
        if (this.clickPoint && (e.buttons & 1)) return;
        this.mouseUp(e);
    }

    // End a pencil/fill/palette-cell stroke exactly once, whichever handler
    // notices first (the canvas' own mouseup, or the document-level safety net
    // for a release outside the canvas).
    finishStroke() {
        let active = this.painting || this.cellPainting || this.paintStroke || this.paintStart;
        if (this.cellPainting) { this.cellPainting = false; this.rom.endAction(); }
        if (this.painting) { this.painting = false; this.commitPaint(); }
        else if (this.paintStart || this.paintStroke) { this.commitPaint(); }
        this.painting = false;
        this.cellPainting = false;
        this.paintStroke = false;
        this.paintStart = null;
        return active;
    }

    mouseUp(e) {
        if (e.button !== undefined && e.button !== 0) return;
        this.floatDrag = null;
        this.finishStroke();
        this.clickPoint = null;
    }

    mouseMove(e) {

        // dragging a floating pasted layer
        if (this.floatDrag && this.float) {
            const p = this.pixelAt(e);
            if (p) {
                this.float.x = p.x - this.floatDrag.dx;
                this.float.y = p.y - this.floatDrag.dy;
                this.clampFloat();
                this.redraw();
            }
            return;
        }

        // palette-cell drag
        if (this.cellPainting && (e.buttons & 1) && this.tool === 4) {
            const p = this.pixelAt(e);
            if (p) this.paintCellPalette(p.x, p.y);
            return;
        }

        // pencil drag
        if (this.tool === 1 && (e.buttons & 1) && this.paintTarget() && !this.panning) {
            const p = this.pixelAt(e);
            if (p) {
                if (!this.painting) {           // resumed after leaving the canvas
                    this.painting = true;
                    this.paintStart = this.graphics.slice();
                }
                this.paintPixel(p.x, p.y);
                return;
            }
        }
        if (this.painting && this.tool === 1) return;   // pointer is outside the image

        let x = Math.floor(e.offsetX / this.zoom / this.tileWidth);
        let y = Math.floor(e.offsetY / this.zoom / this.tileHeight);
        x = Math.min(Math.max(x, 0), this.width - 1);
        y = Math.min(Math.max(y, 0), this.height - 1);

        // update the displayed coordinates (editor mode only)
        if (this.editorMode) {
            const coordinates = document.getElementById('coordinates');
            coordinates.innerHTML = `(${x}, ${y})`;
        }

        // return unless dragging
        if (!this.clickPoint) return;

        const w = Math.abs(x - this.clickPoint.x) + 1;
        const h = Math.abs(y - this.clickPoint.y) + 1;
        x = Math.min(x, this.clickPoint.x);
        y = Math.min(y, this.clickPoint.y);

        // create the tile selection
        this.selection.x = x;
        this.selection.y = y;
        this.selection.w = w;
        this.selection.h = h;
        this.selection.tilemap = new Uint32Array(w * h);
        for (let r = 0; r < h; r++) {
            const begin = x + (y + r) * this.width;
            const end = begin + w;
            const line = this.tilemap.subarray(begin, end);
            this.selection.tilemap.set(line, r * w);
        }

        // redraw the cursor and notify the tilemap view
        this.drawCursor();
        if (this.tilemapView) {
            this.tilemapView.selection = {
                x: 0, y: 0, w: w, h: h,
                tilemap: new Uint32Array(this.selection.tilemap)
            };
            // a single tile picked out of the pool is also the tile to stamp
            if (w * h === 1) this.tilemapView.pickedTile = this.selection.tilemap[0];
        }
    }

    // ---- copy / paste (floating layer) ---------------------------------

    // pixel rectangle of the current tile selection, or null
    selectionPixelRect() {
        if (!this.selection || !this.selection.w || !this.selection.h) return null;
        const x = this.selection.x * this.tileWidth;
        const y = this.selection.y * this.tileHeight;
        return {x, y, w: this.selection.w * this.tileWidth, h: this.selection.h * this.tileHeight};
    }

    copySelection() {
        const r = this.selectionPixelRect();
        if (!r || !this.paintTarget()) return false;
        const pixels = new Uint8Array(r.w * r.h);
        for (let y = 0; y < r.h; y++) {
            for (let x = 0; x < r.w; x++) {
                const off = this.tileOffset(r.x + x, r.y + y);
                pixels[y * r.w + x] = off < 0 ? 0 : this.graphics[off];
            }
        }
        this.clipboard = pixels;
        this.clipboardSize = {w: r.w, h: r.h};
        return true;
    }

    pasteClipboard(x, y) {
        if (!this.clipboard || !this.paintTarget()) return false;
        if (!isNumber(x)) x = this.selection ? this.selection.x * this.tileWidth : 0;
        if (!isNumber(y)) y = this.selection ? this.selection.y * this.tileHeight : 0;
        this.float = {
            x, y,
            w: this.clipboardSize.w, h: this.clipboardSize.h,
            pixels: Uint8Array.from(this.clipboard),
        };
        this.redraw();
        return true;
    }

    // keep the floating layer inside the editable image
    clampFloat() {
        if (!this.float) return;
        const maxX = this.width * this.tileWidth - this.float.w;
        const maxY = this.height * this.tileHeight - this.float.h;
        this.float.x = Math.max(0, Math.min(this.float.x, Math.max(0, maxX)));
        this.float.y = Math.max(0, Math.min(this.float.y, Math.max(0, maxY)));
    }

    commitFloat() {
        if (!this.float) return false;
        this.clampFloat();
        const f = this.float;
        this.float = null;
        const before = this.graphics.slice();
        for (let y = 0; y < f.h; y++) {
            for (let x = 0; x < f.w; x++) {
                const c = f.pixels[y * f.w + x];
                if (!c) continue;                    // color 0 is transparent
                const off = this.tileOffset(f.x + x, f.y + y);
                if (off >= 0 && off < this.graphics.length) this.graphics[off] = c;
            }
        }
        if (compareTypedArrays(before, this.graphics)) { this.redraw(); return false; }
        const target = this.paintTarget();
        target.replaceData(this.graphics.subarray(0, target.data.length), 0);
        this.redraw();
        return true;
    }

    cancelFloat() {
        if (!this.float) return false;
        this.float = null;
        this.redraw();
        return true;
    }

    floatContains(e) {
        if (!this.float) return false;
        const p = this.pixelAt(e);
        if (!p) return false;
        const f = this.float;
        return p.x >= f.x && p.x < f.x + f.w && p.y >= f.y && p.y < f.y + f.h;
    }

    // the object the paint tools write to (editor mode only)
    paintTarget() {
        return (this.editorMode && this.object) ? this.object : null;
    }

    // ---- painting -------------------------------------------------------

    rightClick(e) {
        if (!this.editorMode || !this.object) return false;
        const p = this.pixelAt(e);
        if (!p) return false;
        this.pickColor(p.x, p.y);
        return true;
    }

    applyPan() {
        if (this.canvasWrap) {
            this.canvasWrap.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
        }
    }

    resetPan() {
        this.panX = 0; this.panY = 0;
        this.applyPan();
    }

    mouseWheel(e) {
        // toolbox views (map tilesets) auto-fit their own zoom; leave them alone
        if (!this.editorMode) return;

        if (e.shiftKey || e.altKey) return; // let the pane scroll normally

        e.preventDefault();

        // image point currently under the cursor, which we keep under it
        const before = this.canvas.getBoundingClientRect();
        const ax = (e.clientX - before.left) / this.zoom;
        const ay = (e.clientY - before.top) / this.zoom;

        const dir = e.deltaY < 0 ? 1 : -1;
        let z = Math.round(Math.log2(this.zoom)) + dir;
        z = Math.max(-2, Math.min(4, z));
        this.zoom = Math.pow(2, z);

        const zoomControl = document.getElementById('zoom');
        if (zoomControl) {
            zoomControl.value = z;
            const zoomValue = document.getElementById('zoom-value');
            if (zoomValue) zoomValue.innerHTML = `${this.zoom * 100}%`;
        }

        this.resize();
        this.redraw();

        // after re-layout, nudge the pan so that point is back under the cursor
        const after = this.canvas.getBoundingClientRect();
        this.panX += e.clientX - (after.left + ax * this.zoom);
        this.panY += e.clientY - (after.top  + ay * this.zoom);
        this.applyPan();
        this.drawCursor();
    }

    // build cursor images (PNG via canvas, so it works everywhere)
    makeCursors() {

        if (this.cursors) return this.cursors;
        const draw=(fn)=>{
            const cv=document.createElement('canvas');
            cv.width=cv.height=24;
            const ctx=cv.getContext('2d');
            ctx.lineWidth=1.5; ctx.lineJoin='round'; ctx.strokeStyle='black'; ctx.fillStyle='white';
            fn(ctx);
            return cv.toDataURL('image/png');
        };
        const outline=(ctx)=>{ ctx.stroke(); };

        const pencil=draw(ctx=>{
            ctx.fillStyle='#ffd83d';
            ctx.beginPath(); ctx.moveTo(4,20); ctx.lineTo(6,15); ctx.lineTo(16,5); ctx.lineTo(20,9); ctx.lineTo(10,19); ctx.closePath();
            ctx.fill(); outline(ctx);
            ctx.fillStyle='#fff';
            ctx.beginPath(); ctx.moveTo(4,20); ctx.lineTo(6,15); ctx.lineTo(10,19); ctx.closePath(); ctx.fill(); outline(ctx);
        });
        const bucket=draw(ctx=>{
            ctx.fillStyle='#8fc7ff';
            ctx.beginPath(); ctx.moveTo(5,10); ctx.lineTo(13,3); ctx.lineTo(20,11); ctx.lineTo(12,18); ctx.closePath();
            ctx.fill(); outline(ctx);
            ctx.fillStyle='#2f7de0';
            ctx.beginPath(); ctx.moveTo(18,13); ctx.quadraticCurveTo(22,17,21,19); ctx.quadraticCurveTo(20,22,18,20); ctx.quadraticCurveTo(17,18,18,13); ctx.closePath();
            ctx.fill(); outline(ctx);
        });
        const dropper=draw(ctx=>{
            const rgb=this.colorRGB(this.color);
            ctx.fillStyle='#fff';
            ctx.beginPath(); ctx.moveTo(4,20); ctx.lineTo(7,13); ctx.lineTo(14,6); ctx.lineTo(17,9); ctx.lineTo(10,16); ctx.closePath();
            ctx.fill(); outline(ctx);
            ctx.beginPath(); ctx.moveTo(14,6); ctx.lineTo(17,3); ctx.lineTo(21,7); ctx.lineTo(18,10); ctx.closePath(); ctx.fill(); outline(ctx);
            // bulb shows the color currently selected
            ctx.fillStyle=rgb;
            ctx.beginPath(); ctx.arc(18.5,5.5,2.6,0,Math.PI*2); ctx.closePath(); ctx.fill(); outline(ctx);
        });

        this.cursors = {
            0: 'default',
            1: `url("${pencil}") 3 20, crosshair`,
            // the bucket pours from its lower-right, so that is the hotspot
            2: `url("${bucket}") 20 20, copy`,
            3: `url("${dropper}") 4 20, crosshair`,
        };
        this.cursorColor = this.color;
        return this.cursors;
    }

    // css color string for a palette index of the object being edited
    colorRGB(index) {
        const pal = this.paletteView && this.paletteView.palette;
        if (!pal || !pal.length || !isNumber(index)) return '#ffffff';
        // the buffer holds the raw index; show it from the palette row that is
        // currently selected, so the cursor matches what painting will produce
        const perPalette = this.paletteView.colorsPerPalette || 4;
        const at = Math.min(index + (this.paletteView.p || 0) * perPalette,
                            pal.length - 1);
        const c = pal[at] >>> 0;
        const r = c & 0xFF, g = (c >> 8) & 0xFF, b = (c >> 16) & 0xFF;
        return `rgb(${r},${g},${b})`;
    }

    updateCursor() {
        // rebuild the cursor art when the selected color changes
        if (this.cursors && this.cursorColor !== this.color) this.cursors = null;
        const cursors = this.makeCursors();
        if (this.panning) {
            this.canvas.style.cursor = this.panning.moved ? 'grabbing' : 'grab';
            return;
        }
        if (this.rightHeld) {
            this.canvas.style.cursor = cursors[3]; // eyedropper while RMB is held
            return;
        }
        this.canvas.style.cursor = (this.editorMode && this.object) ? (cursors[this.tool] || 'default') : 'default';
    }

    // pixel coordinates under the mouse, in the graphics image
    pixelAt(e) {
        if (!this.graphics || !this.width) return null;

        // Use the canvas' own offsets when the event came to the canvas; when it
        // came from the surrounding pane, derive them from the canvas rect.
        let x, y;
        if (e.target === this.canvas && isNumber(e.offsetX)) {
            x = Math.floor(e.offsetX / this.zoom);
            y = Math.floor(e.offsetY / this.zoom);
        } else {
            const rect = this.canvas.getBoundingClientRect();
            x = Math.floor((e.clientX - rect.left) / this.zoom);
            y = Math.floor((e.clientY - rect.top) / this.zoom);
        }

        const w = this.width * this.tileWidth;
        const h = this.height * this.tileHeight;
        if (x < 0 || y < 0 || x >= w || y >= h) return null;
        const off = this.tileOffset(x, y);
        if (off < 0 || off >= this.graphics.length) return null;
        return {x, y};
    }

    // byte offset of a pixel in the decoded graphics buffer, or -1 if the
    // pixel falls in a tile that does not exist in the data
    tileOffset(x, y) {
        const tw = this.tileWidth, th = this.tileHeight;
        const col = Math.floor(x / tw), row = Math.floor(y / th);
        const t = row * this.width + col;
        if (col < 0 || row < 0 || col >= this.width || row >= this.height) return -1;
        // a window onto a shared pool (FF3 boss/summon graphics) maps its
        // display cells onto arbitrary tiles of the pool
        const idx = (this.poolLayout && t < this.poolLayout.length) ? this.poolLayout[t] : t;
        if (idx < 0) return -1;
        // and a tile shown flipped (the game's horizontal flip table, 3F/F94F)
        // has to be painted mirrored, or the pencil draws the wrong side of it
        let px = x % tw;
        if (this.poolFlip && this.poolFlip[t]) px = tw - 1 - px;
        const off = idx * this.bytesPerTile + (y % th) * tw + px;
        if (off >= this.graphics.length) return -1;
        return off;
    }

    paintPixel(x, y) {
        const off = this.tileOffset(x, y);
        if (off < 0) return;
        let touched = false;
        if (this.graphics[off] !== this.color) {
            this.graphics[off] = this.color;
            touched = true;
        }
        // an object with a per-cell palette table (FF3 NES) also moves the
        // whole 2x2 cell onto the palette row you are painting with: pick a
        // color from row 2 and the cell you draw in becomes palette 2, which
        // is what makes repainting a sprite's parts in another palette a
        // single gesture. The dedicated "Palette cells" tool does the same
        // thing without touching any pixels. This has to run even when the
        // pixel already holds this index, or drawing over art that already
        // uses the color would never re-palette it.
        if (this.paintableCells() && this.paintCellPalette(x, y)) touched = true;
        if (touched) this.redraw();
    }

    floodFill(x, y) {
        const start = this.tileOffset(x, y);
        if (start < 0) return;
        const target = this.graphics[start];

        // Note: this does NOT bail out when target === this.color. For an
        // object with a per-cell palette table the fill still has work to do -
        // moving every cell of that region onto the palette row being painted
        // with - even though no pixel index changes.
        const tw = this.tileWidth, th = this.tileHeight;
        const W = this.width * tw, H = this.height * th;
        const stack = [[x, y]];
        const seen = new Set();
        const cells = new Set();
        while (stack.length) {
            const [cx, cy] = stack.pop();
            const off = this.tileOffset(cx, cy);
            if (off < 0 || this.graphics[off] !== target) continue;
            const key = off;
            if (seen.has(key)) continue;
            seen.add(key);
            this.graphics[off] = this.color;
            // the fill also moves every cell it covers onto the palette row
            // being painted with (see paintPixel)
            if (this.paintableCells()) {
                const obj = this.object || this.cellsObject;
                const cell = attributeCellForPixel(obj, cx, cy, this.tileWidth, this.tileHeight);
                if (cell >= 0) cells.add(cell);
            }
            if (cx > 0)      stack.push([cx-1, cy]);
            if (cx < W-1)    stack.push([cx+1, cy]);
            if (cy > 0)      stack.push([cx, cy-1]);
            if (cy < H-1)    stack.push([cx, cy+1]);
        }
        let row = this.currentPaletteRow();
        if (row >= 0) {
            const obj = this.object || this.cellsObject;
            if (!!obj.attributeCellsInvert) row ^= 1;
            let wrote = false;
            for (const cell of cells)
                if (setAttributeBit(obj, cell, row)) wrote = true;
            if (wrote) this.refreshPaletteCells();
        }
        this.redraw();
    }

    pickColor(x, y) {
        const off = this.tileOffset(x, y);
        if (off < 0) return;
        // the graphics buffer holds the raw NES index (0..colorsPerPalette-1);
        // which palette row that index is drawn from is a separate selection.
        // Do NOT fold the row into the index - it puts the paint color out of
        // range and the eyedropper/cursor render as transparent.
        let c = this.graphics[off];
        if (this.paintableCells()) {
            const bits = this.attributeCellBits();
            const obj = this.object || this.cellsObject;
            const cell = attributeCellForPixel(obj, x, y, this.tileWidth, this.tileHeight);
            if (bits && cell >= 0 && bits[cell] !== undefined) {
                // follow the palette row this cell actually uses
                this.paletteView.p = Number(bits[cell]);
            }
        }
        if (this.color === c) return;
        this.color = c;
        this.paletteView.setColor(c);
        this.paletteView.redraw();
        this.updateCursor();
        this.redraw();
    }

    // A toolbox graphics pane is paintable when the definition asks for the
    // whole array as one tile pool ("whole": true): that is the art a FF3 NES
    // boss or summon is assembled from, and the tilemap itself has no pixels.
    // Map tilesets stay read-only in the toolbox on purpose - one tileset is
    // shared by many maps, so painting it would change them all silently.
    paintablePool() {
        if (!this.toolboxMode || !this.definition) return false;
        const defs = isArray(this.definition) ? this.definition : [this.definition];
        return defs.some(d => d && typeof d === 'object' && d.whole);
    }

    // write the edited pixels back to the ROM object (creates an undo action)
    commitPaint() {
        const target = this.paintTarget();
        if (!this.paintStart) return;
        if (compareTypedArrays(this.paintStart, this.graphics)) {
            this.paintStart = null;
            if (this.paintStroke) { this.paintStroke = false; this.rom.endAction(); }
            return;
        }
        if (target) {
            target.replaceData(this.graphics.subarray(0, target.data.length), 0);
        } else if (this.paintablePool()) {
            // write back through the definition: the pool is not one object,
            // and saveGraphics() knows which item owns which bytes
            this.saveGraphics(this.definition);
        }
        this.paintStart = null;
        // one undo step for the whole stroke, pixels and palette cells alike
        if (this.paintStroke) { this.paintStroke = false; this.rom.endAction(); }
    }

    // clear the selected area to transparent (color 0)
    deleteSelection() {
        const r = this.selectionPixelRect();
        const target = this.paintTarget();
        if (!r || !target) return false;
        this.paintStart = this.graphics.slice();
        for (let y = 0; y < r.h; y++) {
            for (let x = 0; x < r.w; x++) {
                const off = this.tileOffset(r.x + x, r.y + y);
                if (off >= 0 && off < this.graphics.length) this.graphics[off] = 0;
            }
        }
        this.commitPaint();
        this.redraw();
        return true;
    }

    selectTile(tile) {

        // select a single tile from the tilemap view
        const t = tile & 0xFFFF;
        const v = tile & 0x20000000;
        const h = tile & 0x10000000;
        const z = tile & 0x0F000000;

        let x = t % this.width;
        let y = Math.floor(t / this.width);

        this.hFlip = h ? true : false;
        this.vFlip = v ? true : false;

        if (this.hFlip) x = this.width - x - 1;
        if (this.vFlip) y = this.height - y - 1;

        this.selection = {
            x: x, y: y, w: 1, h: 1,
            tilemap: new Uint32Array(1)
        };
        this.updateTilemap();
        this.scrollToSelection();
        this.redraw();

        const vButton = document.getElementById('graphics-v-flip');
        if (vButton) {
            vButton.checked = this.vFlip;
            twoState(vButton);
        }

        const hButton = document.getElementById('graphics-h-flip');
        if (hButton) {
            hButton.checked = this.hFlip;
            twoState(hButton);
        }

        const zControl = document.getElementById('graphics-z-level');
        if (zControl) {
            zControl.value = z >> 24;
        }
    }

    // palette bits for one tile: FF3 NES monsters pick one of two battle
    // palettes per 2x2 tile cell (attributeCells, expanded from the ROM's
    // $2E:$8F20). Only applies when the loaded palette actually holds both.
    //
    // The cell bits live in the ROM, so when the object has an `attributeRef`
    // we read them from there instead of the snapshot in the definition -
    // editing the attribute table then changes the picture. `attributeCells-
    // Offset` skips cells that belong to the formation slot rather than to the
    // graphic (a 4x4 monster stands in a 4x6 slot, 2F/A2D0), and `attribute-
    // CellsInvert` flips the bits, which the game does for every monster id
    // $80-$FF (2F/A86C +$8D AND #$80, then EOR #$FF at 2F/A8BF).
    attributeCellBits(obj) {
        obj = obj || this.object || this.cellsObject;
        if (!obj) return null;
        if (this._cellsFor === obj && this._cells !== undefined)
            return this._cells;

        let cells = obj.attributeCells || null;
        const ref = obj.attributeRef;
        if (ref && ref.path && this.rom) {
            const array = this.rom.parsePath(ref.path, this.rom);
            if (array && array.item) {
                const first = array.item(ref.index || 0);
                const itemBytes = (first && first.data && first.data.length) || 1;
                let bits = '';
                const bytes = ref.bytes || 1;
                for (let b = 0; b < bytes; b++) {
                    // the table may be one byte per item (monsters) or one whole
                    // record per item (bosses)
                    const item = array.item((ref.index || 0) + Math.floor(b / itemBytes));
                    if (!item || !item.data || !item.data.length) continue;
                    const byte = item.data[b % item.data.length];
                    for (let k = 0; k < 8; k++)
                        bits += ((byte >> (7 - k)) & 1).toString();
                }
                if (bits.length) cells = bits;
            }
        }
        // bosses (monster ids $80-$FF) always show the two palettes swapped:
        // 2F/A89C AND #$80 then EOR #$FF at 2F/A8BF. The definition records
        // that per object, so it is applied here rather than offered as a
        // control the user would have to guess at.
        if (cells && obj.attributeCellsInvert)
            cells = cells.replace(/[01]/g, c => c === '1' ? '0' : '1');

        this._cellsFor = obj;
        this._cells = cells;
        return cells;
    }

    paletteBitsForTile(t) {
        const cells = this.attributeCellBits();
        if (!cells || !cells.length) return 0;
        const perPalette = this.paletteView.colorsPerPalette || 4;
        if (this.paletteView.palette.length < perPalette * 2) return 0;
        const obj = this.object || this.cellsObject;
        const col = t % this.width, row = Math.floor(t / this.width);
        const cols = Math.ceil(this.width * this.tileWidth / (2 * this.tileWidth));
        const cell = Math.floor(row / 2) * cols + Math.floor(col / 2) +
                     (Number(obj.attributeCellsOffset) || 0);
        const bit = cells[cell];
        return (bit === undefined ? 0 : Number(bit)) * perPalette;
    }

    updateTilemap() {
        this._cellsFor = null;   // re-read the attribute table (it may have changed)

        if (this.object && this.object.spriteSheet) {
            let spriteSheetArray = this.object.spriteSheet;
            if (!isArray(spriteSheetArray)) spriteSheetArray = [spriteSheetArray];
            this.spriteSheet = spriteSheetArray[this.ss];
        }

        // With per-cell palette bits the cell table decides which palette each
        // tile uses, so the palette panel's selected row must not also shift
        // every tile - otherwise clicking row 2 recolors the whole sprite and
        // looks like a bug. The row only says what painting will write.
        let p = (this.paletteView.p * this.paletteView.colorsPerPalette) << 16;
        if (this.attributeCellBits()) p = 0;
        let tileCount;
        if (this.toolboxMode) {

            // never use a sprite sheet in toolbox mode
            this.spriteSheet = null;
            tileCount = Math.floor(this.graphics.length / this.bytesPerTile);

            this.tilemap = new Uint32Array(this.height * this.width);
            this.tilemap.fill(0xFFFFFFFF);

            if (this.poolLayout && this.poolLayout.length === this.tilemap.length) {
                // show the pool in the order the tilemap uses it, so the panel
                // reads as the creature and Pencil/Fill paint the part you see
                for (let t = 0; t < this.tilemap.length; t++) {
                    const idx = this.poolLayout[t];
                    if (idx < 0) continue;
                    const flip = (this.poolFlip && this.poolFlip[t]) ? 0x10000000 : 0;
                    this.tilemap[t] = idx | flip |
                                      ((p >> 16 | this.paletteBitsForTile(t)) << 16);
                }
            } else {
                for (let t = 0; t < tileCount; t++)
                    this.tilemap[t] = t | ((p >> 16 | this.paletteBitsForTile(t)) << 16);
            }

        } else if (this.spriteSheet) {
            // use a sprite sheet
            this.width = this.spriteSheet.width || this.width;
            this.height = this.spriteSheet.height || Math.ceil(this.graphics.length / this.bytesPerTile / this.width);
            tileCount = this.width * this.height;
            this.tilemap = new Uint32Array(tileCount);
            this.tilemap.fill(0xFFFFFFFF);
            if (this.spriteSheet.fixedPalette) p = 0;
            for (let t = 0; t < this.tilemap.length; t++) {
                var tile = Number(this.spriteSheet.tilemap[t]);
                if (isNumber(tile) && tile !== -1) this.tilemap[t] = tile | p;
            }

        } else {
            // no sprite sheet
            if (this.object && !this.poolLayout) this.width = this.object.width || 16;
            if (!this.poolLayout)
                this.height = Math.ceil(this.graphics.length / this.bytesPerTile / this.width) || 1;
            tileCount = this.height * this.width;
            this.tilemap = new Uint32Array(tileCount);
            this.tilemap.fill(0xFFFFFFFF);
            for (let t = 0; t < this.tilemap.length; t++) {
                // a window onto a shared pool shows (and edits) the tiles in
                // the order the matching tilemap places them, so the bitmap is
                // the creature rather than a sheet of loose pieces
                if (this.poolLayout && t < this.poolLayout.length) {
                    const idx = this.poolLayout[t];
                    if (idx < 0) continue;
                    const flip = (this.poolFlip && this.poolFlip[t]) ? 0x10000000 : 0;
                    this.tilemap[t] = idx | flip |
                                      ((p >> 16 | this.paletteBitsForTile(t)) << 16);
                    continue;
                }
                this.tilemap[t] = t | ((p >> 16 | this.paletteBitsForTile(t)) << 16);
            }
        }

        // apply v-flip
        if (this.vFlip) {
            const vTilemap = new Uint32Array(this.tilemap.length);
            let t = 0;
            while (t < tileCount) {
                for (let y = 0; y < this.height; y++) {
                    for (let x = 0; x < this.width; x++) {
                        const t1 = x + (this.height - y - 1) * this.width;
                        vTilemap[t1] = this.tilemap[t++] ^ 0x20000000;
                    }
                }
            }
            this.tilemap = vTilemap;
        }

        // apply h-flip
        if (this.hFlip) {
            const hTilemap = new Uint32Array(this.tilemap.length);
            let t = 0;
            while (t < tileCount) {
                for (let y = 0; y < this.height; y++) {
                    for (let x = 0; x < this.width; x++) {
                        const t1 = (this.width - x - 1) + y * this.width;
                        hTilemap[t1] = this.tilemap[t++] ^ 0x10000000;
                    }
                }
            }
            this.tilemap = hTilemap;
        }

        // update ppu and off-screen canvas size
        this.ppu.width = this.width * this.tileWidth;
        this.ppu.height = this.height * this.tileHeight;
        this.graphicsCanvas.width = this.ppu.width;
        this.graphicsCanvas.height = this.ppu.height;

        // set up ppu layer
        this.ppu.layers[0].format = null;
        this.ppu.layers[0].cols = this.width;
        this.ppu.layers[0].rows = this.height;
        this.ppu.layers[0].z[0] = GFX.Z.top;
        this.ppu.layers[0].z[1] = GFX.Z.top;
        this.ppu.layers[0].z[2] = GFX.Z.top;
        this.ppu.layers[0].z[3] = GFX.Z.top;
        this.ppu.layers[0].gfx = this.graphics;
        this.ppu.layers[0].tiles = this.tilemap;
        this.ppu.layers[0].tileWidth = this.tileWidth;
        this.ppu.layers[0].tileHeight = this.tileHeight;
        this.ppu.layers[0].main = true;
    }

    scrollToSelection() {
        var selectionHeight = this.selection.h * this.tileHeight * this.zoom;
        var clientHeight = this.canvasDiv.clientHeight;

        var selectionTop = this.selection.y * this.tileWidth * this.zoom;
        var selectionBottom = selectionTop + selectionHeight;
        var visibleTop = this.canvasDiv.scrollTop;
        var visibleBottom = visibleTop + clientHeight;

        // return if the selection is visible
        if (selectionTop >= visibleTop && selectionBottom <= visibleBottom) return;

        // scroll so that the selection is centered vertically in the div
        var scrollCenter = selectionTop + selectionHeight * 0.5;
        var scrollBottom = Math.min(scrollCenter + clientHeight * 0.5, this.canvas.height);
        var scrollTop = Math.max(0, scrollBottom - clientHeight);
        this.canvasDiv.scrollTop = scrollTop;
    }

    resize(clientWidth, clientHeight) {

        if (this.toolboxMode) {

            if (!isNumber(clientWidth)) {
                clientWidth = this.div.scrollWidth;
            }

            // calculate zoom assuming no scroll bar
            this.canvasDiv.style.overflowY = 'hidden';
            this.canvasDiv.style.width = `${clientWidth}px`;
            this.zoom = this.canvasDiv.clientWidth / this.ppu.width;
            if (this.zoom > 4.0) this.zoom = 4.0;
            this.canvasDiv.style.height = `${this.ppu.height * this.zoom}px`;

            if (!isNumber(clientHeight)) {
                clientHeight = this.div.scrollHeight;
            }

            const divHeight = this.div.scrollHeight;
            let canvasHeight = this.canvasDiv.scrollHeight;
            const otherHeight = divHeight - canvasHeight;
            if (divHeight > clientHeight) {

                // add a scroll bar if graphics is too tall
                canvasHeight = clientHeight - otherHeight;
                this.canvasDiv.style.height = `${canvasHeight}px`;
                this.canvasDiv.style.overflowY = 'scroll';

                // recalculate zoom based on client width (max 4)
                this.zoom = this.canvasDiv.clientWidth / this.ppu.width;
                if (this.zoom > 4.0) this.zoom = 4.0;
            }

        } else {

            // editor mode: let the CSS centre the canvas in the pane (the pane
            // itself scrolls when the canvas is larger), so clear any inline
            // sizing from previous toolbox use
            this.canvasDiv.style.overflowY = '';
            this.canvasDiv.style.width = '';
            this.canvasDiv.style.height = '';
        }
    }

    redraw() {
        this.drawGraphics();
        this.drawCursor();
    }

    drawGraphics() {

        if (this.ppu.height === 0) return;

        // create the color palette
        const palette = new Uint32Array(this.paletteView.palette);
        this.ppu.pal = this.rom.gammaCorrectedPalette(palette);
        // index 0 is both the backdrop color and the sprite outline in FF3 NES,
        // so the black box around a monster is genuinely in the ROM: there is
        // nothing to toggle here without the sprite silhouette.
        this.ppu.back = this.backColor;

        // draw layout image
        let context = this.graphicsCanvas.getContext('2d');
        const imageData = context.createImageData(this.ppu.width, this.ppu.height);
        this.ppu.renderPPU(imageData.data, 0, 0, this.ppu.width, this.ppu.height);
        context.putImageData(imageData, 0, 0);

        // update canvas size
        const w = this.ppu.width * this.zoom;
        const h = this.ppu.height * this.zoom;
        this.canvas.width = w;
        this.canvas.height = h;

        // the wrapper is what gets centred/panned, so size it to the canvas
        if (this.canvasWrap) {
            this.canvasWrap.style.width = `${w}px`;
            this.canvasWrap.style.height = `${h}px`;
            this.applyPan();
        }

        // scale image to zoom setting
        context = this.canvas.getContext('2d');
        context.imageSmoothingEnabled = false;
        context.drawImage(this.graphicsCanvas,
            0, 0, this.graphicsCanvas.width, this.graphicsCanvas.height,
            0, 0, w, h);
    }

    drawCursor() {

        // update canvas size
        this.cursorCanvas.width = this.ppu.width * this.zoom;
        this.cursorCanvas.height = this.ppu.height * this.zoom;

        // clear the cursor canvas
        var ctx = this.cursorCanvas.getContext('2d');

        // image bounds shading and tile grid (drawn even with no selection)
        this.drawOverlays();

        // return if trigger layer is selected
        if (!this.selection.tilemap.length) return;

        // get the cursor geometry
        const l = Math.floor(this.selection.x * this.tileWidth * this.zoom);
        const t = Math.floor(this.selection.y * this.tileHeight * this.zoom);
        const r = Math.ceil((this.selection.x + this.selection.w) * this.tileWidth * this.zoom);
        const b = Math.ceil((this.selection.y + this.selection.h) * this.tileHeight * this.zoom);
        let x = l;
        let y = t
        let w = r - l;
        let h = b - t;

        // draw the cursor
        if (x > this.width * this.tileWidth * this.zoom ||
            y > this.height * this.tileHeight * this.zoom) return;
        if (w <= 0 || h <= 0) return;

        // convert the selection to screen coordinates
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'black';
        x += 0.5; y += 0.5; w--; h--;
        ctx.strokeRect(x, y, w, h);
        x++; y++; w -= 2; h -= 2;
        ctx.strokeStyle = 'hsl(210, 100%, 50%)';
        ctx.strokeRect(x, y, w, h);
        x++; y++; w -= 2; h -= 2;
        ctx.strokeStyle = 'white';
        ctx.strokeRect(x, y, w, h);
        x++; y++; w -= 2; h -= 2;
        ctx.strokeStyle = 'black';
        ctx.strokeRect(x, y, w, h);
    }

    // Show this object's tiles in the order another tilemap places them, so the
    // bitmap you see and paint is the creature rather than a sheet of loose
    // pieces (FF3 NES bosses and summons are assembled from a shared pool).
    applyLayoutFrom(path) {
        if (!path || !this.rom) return false;
        const tm = this.rom.parsePath(path, this.rom);
        if (!tm || !tm.data) return false;
        if (!tm.isLoaded && tm.disassemble) tm.disassemble(this.rom.data);
        const w = tm.width || this.width;
        const layout = new Int32Array(tm.data.length);
        const flip = new Int32Array(tm.data.length);
        // the flip is the view's, not the ROM's: mirrorX means the game pushes
        // these tiles through its horizontal flip table (3F/F94F/3F/F970), and
        // the stored tilemap words never carry that bit
        const mirrorX = !!tm.mirrorX;
        for (let t = 0; t < tm.data.length; t++) {
            const word = tm.data[t];
            const idx = word & 0xFFFF;
            layout[t] = (word === 0xFFFFFFFF || idx >= 0x100) ? -1 : idx;
            flip[t] = (mirrorX || (word & 0x10000000)) ? 1 : 0;
        }
        this.poolLayout = layout;
        this.poolFlip = flip;
        this.width = w;
        this.height = tm.height || Math.ceil(layout.length / w);
        if (tm.addObserver) {
            const self = this;
            this.observer.startObserving(tm, function() {
                self.applyLayoutFrom(path);
                self.updateTilemap();
                self.redraw();
            });
        }
        return true;
    }

    selectObject(object) {

        // this is only valid in editor mode
        this.editorMode = true;
        this.toolboxMode = false;

        this.div.innerHTML = '';
        this.div.classList.add('map-edit');
        // this.div.id = 'map-edit';
        this.div.tabIndex = 0;
        this.div.style.outline = 'none';
        this.div.onkeydown = (e) => {
            // Up/Down move the navigator selection. The graphics pane takes
            // keyboard focus when an object is opened, so without this the
            // arrows would only scroll the pane and the tree selection would
            // never move.
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                if (this.float) return;         // arrow keys are free while a pasted layer floats
                const nav = (typeof romNavigator !== 'undefined') ? romNavigator : null;
                if (nav && nav.moveSelection(e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
                return;
            }
            const ctrl = e.ctrlKey || e.metaKey;
            if (ctrl && e.key.toLowerCase() === 'c') { if (this.copySelection()) e.preventDefault(); return; }
            if (ctrl && e.key.toLowerCase() === 'v') { if (this.pasteClipboard()) e.preventDefault(); return; }
            if (e.key === 'Enter') { if (this.commitFloat()) e.preventDefault(); return; }
            if (e.key === 'Escape') { if (this.cancelFloat()) e.preventDefault(); return; }
            if (e.key === 'Delete' || e.key === 'Backspace') {
                if (this.deleteSelection()) e.preventDefault();
                return;
            }

            // V select, B pencil, G fill, I picker, C palette cells;
            // 1-9 and 0 pick a palette color
            switch (e.key.toLowerCase()) {
                case 'v': this.tool = 0; break;
                case 'b': this.tool = 1; break;
                case 'g': this.tool = 2; break;
                case 'i': this.tool = 3; break;
                case 'c': if (!this.paintableCells()) return; this.tool = 4; break;
                default:
                    if (e.key >= '0' && e.key <= '9') {
                        const idx = e.key === '0' ? 10 : Number(e.key);
                        this.color = idx;
                        this.paletteView.setColor(idx);
                    } else return;
            }
            e.preventDefault();
            this.resetControls();
            this.updateCursor();
            this.redraw();
        };
        this.div.appendChild(this.canvasDiv);

        // select an object with this view as the editor
        if (!(object instanceof ROMGraphics)) {

            // a standalone palette object: show it in the palette panel and keep
            // the last graphics displayed for reference. Deliberately does NOT
            // change this.object, so painting still targets the graphics.
            if (ROMPaletteView.isPaletteFormat(object.format)) {
                this.paletteObject = object;
                // an array item's `path` is the array itself, so the index has
                // to be part of it or every entry shows the same palette.
                // Keep it a plain string: callers read paletteView.definition.
                const path = (object.i !== undefined) ?
                             object.path + '[' + object.i + ']' : object.path;
                this.paletteView.loadDefinition(path);
                this.paletteView.updateToolbox();
                this.paletteView.resize();
                this.paletteView.redraw();
                this.resetControls();
                this.updateCursor();
                return;
            }
            return;
        }

        // start observing the graphics object
        this.observer.stopObservingAll();

        this.object = object;
        // Work on a copy: if this aliased object.data, importGraphics() would
        // mutate the decoded data in place and replaceData() would then compare
        // equal and silently drop the edit (nothing would ever be saved).
        this.graphics = object.data.slice();
        this.definition = null;
        this.width = object.width || 16;
        this.height = object.height || 16;
        this.tileWidth = object.tileWidth || 8;
        this.tileHeight = object.tileHeight || 8;
        this.bytesPerTile = this.tileWidth * this.tileHeight;
        this.backColor = object.backColor;
        this.selection = {
            x: 0, y: 0, w: 0, h: 0,
            tilemap: new Uint32Array()
        };
        this.float = null;
        this.floatDrag = null;
        this.painting = false;
        this.picking = false;
        this.panning = null;
        this.rightHeld = false;
        this.spriteSheet = null;

        // get the graphics format
        let formatKey = this.object.format;

        // for assemblies with multiple formats, the graphics format is the first one
        if (isArray(formatKey)) formatKey = formatKey[0];

        // ignore format parameters (an object may have no format at all,
        // e.g. a raw graphics blob - then the view falls back to its default)
        if (formatKey && formatKey.includes('(')) {
            formatKey = formatKey.substring(0, formatKey.indexOf('('));
        }
        this.format = GFX.graphicsFormat[formatKey] || this.format;

        // a window onto a shared pool: show the creature, not the sheet
        this.poolLayout = null;
        this.poolFlip = null;
        if (object.window && object.layout) {
            // static cell -> pool tile layout (FF4 SNES bosses): the generator
            // walked the boss tile map, so the window reads as the creature
            this.poolLayout = Int32Array.from(object.layout);
            this.poolFlip = new Int32Array(object.layout.length);
            if (object.width) this.width = object.width;
            if (object.height) this.height = object.height;
        }
        else if (object.window && object.layoutFrom) this.applyLayoutFrom(object.layoutFrom);

const self = this;
        this.observer.startObserving(object, function() {
            self.selectObject(object);
            self.redraw();
        });

        // load the palette
        this.paletteView.loadDefinition(object.palette);
        this.paletteView.updateToolbox();
        this.toolbox.setHeight(this.paletteView.div.scrollHeight);
        this.paletteView.resize();
        this.paletteView.redraw();

        this.resetControls();
        this.updateCursor();
        // only re-centre when a different object is opened; re-selecting the same
        // object happens after every edit (the observer fires) and must not
        // throw away where the user had panned to
        if (this.panObject !== object) {
            this.panObject = object;
            this.resetPan();
        }
        this.updateTilemap();
        this.resize();
        this.redraw();
    }    loadDefinition(definition) {

        // this is only valid in toolbox mode
        this.toolboxMode = true;
        this.editorMode = false;
        this.tool = 0;          // tile picking stays the default in a toolbox
        this.graphicsObject = null;
        this.userZoom = null;   // auto-fit the new definition again

        // load graphics from a definition (via ROMTilemapView)
        this.definition = definition;
        this.format = this.tilemapView.format;
        this.backColor = this.tilemapView.backColor;
        this.graphicsArray = [];
        // this.canvasDiv.classList.add("background-gradient");

        this.observer.stopObservingAll();

        // clear the graphics
        this.graphics = new Uint8Array();
        this.width = null;
        this.height = null;

        // load graphics from the definition
        this.loadGraphics(definition);
        if (!this.tileWidth) this.tileWidth = 8;
        if (!this.tileHeight) this.tileHeight = 8;
        this.bytesPerTile = this.tileWidth * this.tileHeight;
        if (!this.width) this.width = 16;
        if (!this.height) {
            this.height = Math.ceil(this.graphics.length / this.bytesPerTile / this.width);
        }
    }

    loadGraphics(definition) {
        if (!definition) return;

        // multiple choice of graphics (outer array)
        if (isArray(definition)) {
            if (definition.length === 0) return;
            if (definition.length > 1) {
                for (const def of definition) this.graphicsArray.push(def);
            }
            // load the first array element as a placeholder
            definition = definition[0];
        }

        // recursively load multiple graphics (inner array)
        if (isArray(definition)) {
            for (const def of definition) this.loadGraphics(def);
            return;
        }

        // get path
        var path = isString(definition) ? definition : definition.path;
        if (!path) return;

        // parse object
        var index = 0;
        if (this.tilemapView) {
            index = this.tilemapView.object.i;
        }
        var object = this.rom.parsePath(path, this.rom, index);

        // load ROMArray objects as multiple choice
        if (object instanceof ROMArray && !definition.whole) {
            this.graphicsArray.push(definition);

            // load the first array item as a placeholder
            object = object.item(0);

        } else if (object instanceof ROMArray) {
            // "whole": use every item's decoded graphics as one contiguous
            // tile pool. Needed by tilemaps whose tiles index across several
            // array items (FF3 NES boss tilemaps index the shared monster
            // tile pool, which is stored as size-class arrays).
            this.graphicsArray.push(definition);
            const parts = [];
            let total = 0;
            for (let i = 0; i < object.arrayLength; i++) {
                const item = object.item(i);
                if (!item || !item.data) continue;
                parts.push(item.data);
                total += item.data.length;
            }
            const pool = new Uint8Array(total);
            let at = 0;
            for (const part of parts) { pool.set(part, at); at += part.length; }
            object = { data: pool,
                       tileWidth: object.assembly ? object.assembly.tileWidth : undefined,
                       tileHeight: object.assembly ? object.assembly.tileHeight : undefined };
        }

        // get object data
        if (!object || !object.data) return;

        // remember which object the toolbox is showing, so the paint tools can
        // edit map tileset graphics too
        this.graphicsObject = object;
        let data = object.data;

        if (object.width) this.width = object.width;
        if (object.height) this.height = object.height;
        // a tile *pool* has no size of its own: the definition says how to lay
        // it out (an FF3 boss pool is 18 tiles wide to match its tilemap, the
        // two summon-backed bosses reuse a summon's block, so 8)
        if (definition.width) this.width = definition.width;
        if (definition.height) this.height = definition.height;
        else if (definition.width)
            this.height = Math.ceil(data.length / (this.tileWidth * this.tileHeight * 2) / definition.width);
        if (definition.tileWidth) this.tileWidth = definition.tileWidth;
        if (definition.tileHeight) this.tileHeight = definition.tileHeight;
        if (object.tileWidth) this.tileWidth = object.tileWidth;
        if (object.tileHeight) this.tileHeight = object.tileHeight;

        // A pool-based window (FF3 boss/summon graphics) can show its tiles in
        // the order the matching tilemap uses them.
        if (definition.layoutFrom) this.applyLayoutFrom(definition.layoutFrom);

        const self = this;
        const reload = function() {
            // Painting a pixel can also write an attribute byte, and that byte
            // is observed too. Reloading mid-stroke would throw away the
            // uncommitted pixels, so only refresh the colors while a stroke is
            // actually in progress.
            if (self.painting || self.cellPainting) {
                self.updateTilemap();
                self.redraw();
                if (self.tilemapView) self.tilemapView.redraw();
                return;
            }

            // reload the graphics
            self.loadDefinition(self.definition);

            // reload the multiple choice selection
            const graphicsSelectControl = document.getElementById('graphics-select-control');
            if (graphicsSelectControl) {
                self.loadGraphics(JSON.parse(graphicsSelectControl.value));
            }

            // redraw everything
            self.updateTilemap();
            self.redraw();
            if (self.tilemapView) self.tilemapView.redraw();
        };
        this.observer.startObserving(object, reload);

        // ... and the ROM bytes holding this object's per-cell palette bits, so
        // editing the attribute table repaints the sprite
        const ref = object.attributeRef;
        if (ref && ref.path) {
            const array = this.rom.parsePath(ref.path, this.rom);
            if (array && array.item) {
                const bytes = ref.bytes || 1;
                for (let b = 0; b < bytes; b++) {
                    const item = array.item((ref.index || 0) + b);
                    if (item) this.observer.startObserving(item, reload);
                }
            }
        }

        // parse data range
        let range;
        if (definition.range) {
            range = ROMRange.parse(definition.range);
            data = data.subarray(range.begin, range.end);
        } else {
            range = new ROMRange(0, data.length);
        }

        // parse offset
        const offset = Number(definition.offset) || 0;

        if (this.graphics.length < (offset + data.length)) {
            // increase the size of the graphics buffer
            const newGraphics = new Uint8Array(offset + data.length);
            newGraphics.set(this.graphics);
            this.graphics = newGraphics;
        }
        this.graphics.set(data, offset);
    }

    importGraphics(graphics, offset = 0) {
        if ((graphics.length + offset) > this.graphics.length) {
            // trim the graphics to fit
            graphics = graphics.subarray(0, this.graphics.length - offset);
        }

        // copy imported data to the current graphics
        if (this.poolLayout) {
            // A window onto a shared pool (FF3 boss/summon graphics) is shown
            // in the order its tilemap places the tiles, so an imported bitmap
            // - which the user drew in that same arrangement - has to be
            // scattered through the same mapping. A linear copy here writes the
            // image into pool order and comes out garbled.
            const W = this.width * this.tileWidth;
            for (let i = 0; i < graphics.length; i++) {
                const p = offset + i;
                const off = this.tileOffset(p % W, Math.floor(p / W));
                if (off >= 0 && off < this.graphics.length) this.graphics[off] = graphics[i];
            }
        } else {
            this.graphics.set(graphics, offset);
        }

        // set graphics data
        this.observer.sleep();
        if (isArray(this.definition)) {
            if (this.definition.length === 1) this.saveGraphics(this.definition[0]);
        } else if (this.definition) {
            this.saveGraphics(this.definition);
        } else if (this.object) {
            // editor mode: there is no definition, so write back to the object
            // that is currently selected (otherwise the import is discarded)
            this.object.replaceData(this.graphics, 0);
        }

        const graphicsSelectControl = document.getElementById('graphics-select-control');
        if (graphicsSelectControl) {
            this.saveGraphics(JSON.parse(graphicsSelectControl.value));
        }
        this.observer.wake();

        // redraw the view
        this.redraw();
        if (this.tilemapView) this.tilemapView.redraw();
    }

    saveGraphics(definition) {
        if (!definition) return;

        // recursively save graphics
        if (isArray(definition)) {
            for (const def of definition) this.saveGraphics(def);
            return;
        }

        // get path
        const path = isString(definition) ? definition : definition.path;
        if (!path) return;

        // parse object
        let index = 0;
        if (this.tilemapView) {
            index = this.tilemapView.object.i;
        }
        const object = this.rom.parsePath(path, this.rom, index);

        // ignore ROMArray objects for now
        if (object instanceof ROMArray) {
            // ... unless the definition asked for the whole array as one tile
            // pool (FF3 NES boss tilemaps paint into the shared monster tile
            // pool, which is stored as size-class arrays). Then each painted
            // byte has to land in the item that owns it.
            if (!definition.whole) return;
            const offset = Number(definition.offset) || 0;
            const parts = [];
            let total = 0;
            for (let i = 0; i < object.arrayLength; i++) {
                const item = object.item(i);
                if (!item || !item.data) continue;
                parts.push({item: item, begin: total, end: total + item.data.length});
                total += item.data.length;
            }
            let prange;
            if (definition.range) prange = ROMRange.parse(definition.range);
            else prange = new ROMRange(0, total);
            for (const part of parts) {
                const from = Math.max(part.begin, prange.begin);
                const to = Math.min(part.end, prange.end);
                if (to <= from) continue;
                const chunk = this.graphics.slice(offset + from - prange.begin,
                                                  offset + to - prange.begin);
                part.item.replaceData(chunk, from - part.begin);
            }
            return;
        }

        // // get object data
        // if (!object || !object.data) return;
        // let data = object.data;

        // parse data range
        let range;
        if (definition.range) {
            range = ROMRange.parse(definition.range);
        } else {
            range = new ROMRange(0, data.length);
        }

        // parse offset
        const offset = Number(definition.offset) || 0;

        let graphics = this.graphics.subarray(offset, offset + range.length);

        // convert to and from the native format to validate the data
        if (object.format) {
            // get the graphics format
            let formatKey = object.format;

            // for assemblies with multiple formats, the graphics format is the first one
            if (isArray(formatKey)) formatKey = formatKey[0];

            // ignore format parameters
            if (formatKey.includes('(')) {
                formatKey = formatKey.substring(0, formatKey.indexOf('('));
            }
            const format = GFX.graphicsFormat[formatKey];

            if (format) graphics = format.decode(format.encode(graphics)[0])[0];
        }

        if (range.begin + graphics.length > object.data.length) {
            graphics = graphics.subarray(0, object.data.length - range.begin);
        }
        object.replaceData(graphics, range.begin);
    }

    updateToolbox() {
        var self = this;
        this.div.innerHTML = '';

        function valueForDefinition(definition, index) {

            if (!definition) return null;
            var path = definition.path || definition;
            if (!isString(path)) return null;

            if (isNumber(index)) path += `[${index}]`;

            if (isString(definition)) return JSON.stringify({path: path});

            var value = {};
            Object.assign(value, definition);
            value.path = path;
            return JSON.stringify(value);
        }

        if (this.graphicsArray.length) {
            // create a dropdown for array graphics
            var graphicsSelectDiv = document.createElement('div');
            graphicsSelectDiv.classList.add('property-div');
            this.div.appendChild(graphicsSelectDiv);

            var graphicsSelectControl = document.createElement('select');
            graphicsSelectControl.classList.add('property-control');
            graphicsSelectControl.id = 'graphics-select-control';
            graphicsSelectDiv.appendChild(graphicsSelectControl);

            var option;
            var index = 0;
            if (this.tilemapView) {
                index = this.tilemapView.object.i;
            }
            var selectedValue = null;
            for (var i = 0; i < this.graphicsArray.length; i++) {
                var graphicsDefinition = this.graphicsArray[i];
                if (!graphicsDefinition) continue;
                var graphicsPath = graphicsDefinition.path || graphicsDefinition;
                if (!isString(graphicsPath)) continue;
                graphicsPath = this.rom.parseIndex(graphicsPath, index);
                var graphicsObject = this.rom.parsePath(graphicsPath);
                if (!graphicsObject) continue;

                if (graphicsObject instanceof ROMArray) {
                    for (var j = 0; j < graphicsObject.arrayLength; j++) {
                        var value = valueForDefinition(graphicsDefinition, j);
                        if (!value) continue;
                        option = document.createElement('option');
                        option.value = value;
                        if (graphicsDefinition.name) {
                            option.innerHTML = graphicsDefinition.name;
                        } else if (graphicsObject.stringTable) {
                            var stringTable = this.rom.stringTable[graphicsObject.stringTable];
                            var string = stringTable.string[j];
                            if (string) {
                                option.innerHTML = `${j}: ${string.fString(40)}`;
                            } else {
                                option.innerHTML = `${j}: ${graphicsObject.name} ${j}`;
                            }
                        } else {
                            option.innerHTML = `${j}: ${graphicsObject.name} ${j}`;
                        }
                        if (!selectedValue) selectedValue = option.value;
                        if (option.value === this.selectedValue) selectedValue = option.value;
                        graphicsSelectControl.appendChild(option);
                    }
                } else if (graphicsObject instanceof ROMAssembly) {
                    var value = valueForDefinition(graphicsDefinition);
                    if (!value) continue;
                    option = document.createElement('option');
                    option.value = value;
                    if (graphicsDefinition.name) {
                        option.innerHTML = graphicsDefinition.name;
                    } else if (isNumber(graphicsObject.i)) {
                        if (graphicsObject.parent.stringTable) {
                            var stringTable = this.rom.stringTable[graphicsObject.parent.stringTable];
                            var string = stringTable.string[graphicsObject.i];
                            if (string) {
                                option.innerHTML = string.fString(40);
                            } else {
                                option.innerHTML = `${graphicsObject.name} ${graphicsObject.i}`;
                            }
                        } else {
                            option.innerHTML = `${graphicsObject.name} ${graphicsObject.i}`;
                        }
                    } else {
                        option.innerHTML = graphicsObject.name;
                    }
                    if (!selectedValue) selectedValue = option.value;
                    if (option.value === this.selectedValue) selectedValue = option.value;
                    graphicsSelectControl.appendChild(option);
                }
            }
            graphicsSelectControl.value = selectedValue;
            this.loadGraphics(JSON.parse(selectedValue));
            this.selectedValue = selectedValue;

            var self = this;
            graphicsSelectControl.onchange = function() {

                self.loadGraphics(JSON.parse(this.value));
                self.selectedValue = this.value;
                self.redraw();
                if (self.tilemapView) self.tilemapView.redraw();
            }
        }

        // heading div
        const graphicsHeadingDiv = document.createElement('div');
        graphicsHeadingDiv.classList.add('property-heading');
        this.div.appendChild(graphicsHeadingDiv);

        const graphicsHeading = document.createElement('p');
        graphicsHeadingDiv.appendChild(graphicsHeading);

        // add heading buttons
        const buttonDiv = document.createElement('div');
        buttonDiv.classList.add('property-heading-button-div');
        graphicsHeading.appendChild(buttonDiv);
        graphicsHeading.appendChild(document.createTextNode('Graphics'));

        // const copyButton = document.createElement('i');
        // copyButton.classList.add('fas', 'fa-copy', 'property-heading-button');
        // copyButton.onclick = function() { self.copy(); };
        // buttonDiv.appendChild(copyButton);
        // const pasteButton = document.createElement('i');
        // pasteButton.classList.add('fas', 'fa-paste', 'property-heading-button');
        // pasteButton.onclick = function() { self.paste(); };
        // buttonDiv.appendChild(pasteButton);
        const exportButton = document.createElement('i');
        exportButton.classList.add('fas', 'fa-download', 'property-heading-button');
        exportButton.onclick = function() {
            const exporter = new ROMGraphicsExporter();
            exporter.export({
                tilemap: self.tilemap,
                graphics: self.graphics,
                palette: self.paletteView.palette,
                width: self.width,
                tileWidth: self.tileWidth,
                tileHeight: self.tileHeight,
                backColor: self.backColor
            });
        };
        buttonDiv.appendChild(exportButton);
        const importButton = document.createElement('i');
        importButton.classList.add('fas', 'fa-upload', 'property-heading-button');
        importButton.onclick = function() {
            function callback(graphics, palette) {
                // set the new graphics/palette data
                self.rom.beginAction();
                if (graphics) self.importGraphics(graphics);
                if (palette) self.paletteView.importPalette(palette);
                self.rom.endAction();
            }
            const importer = new ROMGraphicsImporter(rom, self, callback);
        };
        buttonDiv.appendChild(importButton);

        // show the graphics canvas
        this.div.appendChild(this.canvasDiv);

        var showZLevelControl = this.format.maxZ && !this.tilemapView.object.disableZLevel;
        var showVFlipControl = this.format.vFlip && !this.tilemapView.object.disableVFlip;
        var showHFlipControl = this.format.hFlip && !this.tilemapView.object.disableHFlip;

        // add controls for v/h flip, z-level
        if (showZLevelControl || showVFlipControl || showHFlipControl) {

            var graphicsControlsDiv = document.createElement('div');
            graphicsControlsDiv.classList.add('graphics-controls');
            this.div.appendChild(graphicsControlsDiv);
        }

        if (showVFlipControl) {
            var vLabel = document.createElement('label');
            vLabel.classList.add('two-state');
            vLabel.style.display = 'inline-block';
            if (this.vFlip) vLabel.classList.add('checked');
            graphicsControlsDiv.appendChild(vLabel);

            var vInput = document.createElement('input');
            vInput.type = 'checkbox';
            vInput.checked = this.vFlip;
            vInput.id = 'graphics-v-flip';
            vInput.onclick = function() {
                twoState(this);
                self.vFlip = this.checked;
                self.tilemapView.toggleSelectionVFlip();
                self.selection.y = self.height - self.selection.y - self.selection.h;
                self.updateTilemap();
                self.scrollToSelection();
                self.redraw();
            };
            vLabel.appendChild(vInput);

            var vText = document.createElement('p');
            vText.innerHTML = 'V-Flip';
            vLabel.appendChild(vText);
        }

        if (showHFlipControl) {
            var hLabel = document.createElement('label');
            hLabel.classList.add('two-state');
            hLabel.style.display = 'inline-block';
            if (this.hFlip) hLabel.classList.add('checked');
            graphicsControlsDiv.appendChild(hLabel);

            var hInput = document.createElement('input');
            hInput.type = 'checkbox';
            hInput.checked = this.hFlip;
            hInput.id = 'graphics-h-flip';
            hInput.onclick = function() {
                twoState(this);
                self.hFlip = this.checked;
                self.tilemapView.toggleSelectionHFlip();
                self.selection.x = self.width - self.selection.x - self.selection.w;
                self.updateTilemap();
                self.scrollToSelection();
                self.redraw();
            };
            hLabel.appendChild(hInput);

            var hText = document.createElement('p');
            hText.innerHTML = 'H-Flip';
            hLabel.appendChild(hText);
        }

        if (showZLevelControl) {
            var zLabel = document.createElement('label');
            zLabel.innerHTML = 'Priority:';
            zLabel.style.display = 'inline-block';
            zLabel.style.padding = '2px 10px';
            zLabel.style.margin = '4px 3px';
            zLabel.htmlFor = 'graphics-z-level';
            graphicsControlsDiv.appendChild(zLabel);

            var zInput = document.createElement('input');
            zInput.id = 'graphics-z-level';
            zInput.type = 'number';
            zInput.classList.add('property-control');
            zInput.style.width = '3em';
            zInput.value = 0;
            zInput.min = 0;
            zInput.max = this.format.maxZ - 1;
            zInput.onchange = function() {
                self.z = Number(this.value);
                self.tilemapView.setSelectionZ(self.z);
                self.updateTilemap();
                self.scrollToSelection();
                self.redraw();
            };
            graphicsControlsDiv.appendChild(zInput);
        }

        // // add graphics import/export buttons
        // var importExportDiv = document.createElement('div');
        // importExportDiv.classList.add('property-div');
        // this.div.appendChild(importExportDiv);
        //
        // var exportButton = document.createElement('button');
        // exportButton.innerHTML = 'Export Graphics';
        // exportButton.onclick = function() {
        //     var exporter = new ROMGraphicsExporter();
        //     exporter.export({
        //         tilemap: self.tilemap,
        //         graphics: self.graphics,
        //         palette: self.paletteView.palette,
        //         width: self.width,
        //         tileWidth: self.tileWidth,
        //         tileHeight: self.tileHeight,
        //         backColor: self.backColor
        //     });
        // };
        // importExportDiv.appendChild(exportButton);
        //
        // var importButton = document.createElement('button');
        // importButton.innerHTML = 'Import Graphics';
        // importButton.onclick = function() {
        //     function callback(graphics, palette) {
        //         // set the new graphics/palette data
        //         self.rom.beginAction();
        //         if (graphics) self.importGraphics(graphics);
        //         if (palette) self.paletteView.importPalette(palette);
        //         self.rom.endAction();
        //     }
        //     var importer = new ROMGraphicsImporter(rom, self, callback);
        // };
        // importExportDiv.appendChild(importButton);
    }
}
