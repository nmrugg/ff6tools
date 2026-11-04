// Does ff6tools recognise the FF3 (J) dump and can you actually edit its
// monster graphics in the browser?  Headless Chrome, no interaction needed:
//   node tools/ff3-nes-app-test.js
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const PROFILE = require('fs').mkdtempSync('/tmp/ff6tools-chrome-');
const ROM=path.join(ROOT, process.argv[2]||'Final Fantasy III (Japan) (fixed).nes');
const KEY=process.argv[3]||(process.env.FF3J_KEY||'ff3j-nes');
const PORT=8471, CDP=9371;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class C{constructor(w){this.w=w;this.i=0;this.h=new Map();w.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.h.has(m.id)){const{res,rej}=this.h.get(m.id);this.h.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};}
 s(x,p={},sid){return new Promise((res,rej)=>{const id=++this.i;this.h.set(id,{res,rej});this.w.send(JSON.stringify({id,method:x,params:p,sessionId:sid}));});}}
const ev=async(c,sid,e)=>{const r=await c.s('Runtime.evaluate',{expression:e,returnByValue:true},sid);if(r.exceptionDetails)throw new Error(String(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result.value;};
let fails=0;
const check=(cond,msg)=>{console.log((cond?'  ok  ':'  FAIL')+' '+msg);if(!cond)fails++;};
(async()=>{
 const srv=spawn('python3',['-m','http.server',String(PORT),'--dir',ROOT],{stdio:'ignore'});
 const ch=spawn('google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--user-data-dir=' + PROFILE,'--disk-cache-size=1','--remote-debugging-port='+CDP,'about:blank'],{stdio:'ignore'});
 try{
  await sleep(2200);
  const info=await (await fetch('http://127.0.0.1:'+CDP+'/json/version')).json();
  const ws=new WebSocket(info.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener('open',r));
  const c=new C(ws);
  const {targetId}=await c.s('Target.createTarget',{url:'http://127.0.0.1:'+PORT+'/ff6tools.html'});
  const {sessionId}=await c.s('Target.attachToTarget',{targetId,flatten:true});
  await c.s('Runtime.enable',{},sessionId); await c.s('Page.enable',{},sessionId); await sleep(2500);
  const o=await c.s('Runtime.evaluate',{expression:"document.getElementById('rom-file')",objectGroup:'t'},sessionId);
  await c.s('DOM.setFileInputFiles',{files:[ROM],objectId:o.result.objectId},sessionId);
  await sleep(4000);
  check(await ev(c,sessionId,'!!rom'),'ROM loaded');
  check(await ev(c,sessionId,'rom && rom.key')===KEY,'auto-detected as '+KEY);
  console.log('  hierarchy:',await ev(c,sessionId,`rom && rom.hierarchy.map(c=>c.name+' ('+c.list.length+')').join(', ')`));
  check(await ev(c,sessionId,`!!rom && !!rom.monsterGraphics6x6`),'monsterGraphics6x6 exists');
  check(await ev(c,sessionId,`rom.monsterGraphics6x6.arrayLength`)==24,'6x6 array has 24 entries');
  check(await ev(c,sessionId,`rom.battlePalettes.arrayLength`)==256,'battlePalettes has 256 entries');

  // open a monster graphic in the editor through the navigator
  const opened=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphics6x6.item(3);
      romNavigator.selectObject(obj);
      propertyList.select(obj);
      const view=propertyList.activeEditor;
      return {name:obj.name, w:obj.width, h:obj.height, palette:obj.palette,
              view:view&&view.constructor.name,
              shown:!!(view&&view.object===obj),
              palOptions:view?view.paletteView.paletteArray.length:-1,
              palCount:view?view.paletteView.palette.length:-1,
              label:romNavigator.node['monsterGraphics6x6']?'expanded':'not expanded'};
  })()`);
  console.log('  editor:',JSON.stringify(opened));
  check(opened.view==='ROMGraphicsView','graphics view opened');
  check(opened.shown,'the selected monster graphic is the editing target');
  check(opened.w===6&&opened.h===6,'displayed size is 6x6 tiles');
  check(await ev(c,sessionId,`rom.monsterGraphics6x6.item(0).backColor===true`),
        'color 0 is opaque black - the sprite outline is color 0 in the ROM, so it must not vanish');
  check(opened.palCount===8,'the monster opens with both of its battle palettes (8 colors = 2 rows, color 0 = black)');
  const pair0=Array.isArray(opened.palette[0])?opened.palette[0]:opened.palette;
  check(pair0.length>=2&&pair0.every(p=>p.compose)&&pair0.every(p=>p.name),
        'the monster opens with its battle palettes composed and named: '+
        pair0.map(p=>p.name).join(' + ')+
        ' ('+(Array.isArray(opened.palette)?opened.palette.filter(p=>Array.isArray(p)).length:1)+' pairs to choose from)');

  // paint a pixel and check the ROM actually changed
  const painted=await ev(c,sessionId,`(()=>{
      const before=rom.data.slice();
      const view=propertyList.activeEditor;
      view.tool=1; view.color=3;
      view.paintStart=view.graphics.slice();   // mouseDown normally does this
      view.paintPixel(0,0); view.paintPixel(1,0); view.paintPixel(2,0);
      view.commitPaint();
      rom.assemble();
      let changed=0; for(let i=0;i<rom.data.length;i++) if(rom.data[i]!==before[i]) changed++;
      return {changed, undo:rom.canUndo()};
  })()`);
  console.log('  paint:',JSON.stringify(painted));
  check(painted.changed>0,'painting pencil pixels changes the ROM ('+painted.changed+' bytes)');
  check(painted.undo,'the edit is undoable');
  // editing a palette color must reach the ROM: with two composed palettes the
  // buffer spans two ROM objects, so the edit has to be routed to the right one
  const edited=await ev(c,sessionId,`(()=>{
    const before=rom.data.slice();
    const pv=propertyList.activeEditor.paletteView;
    const t0=pv.targetForColor(1), t1=pv.targetForColor(5);
    if(!t0||!t1) return {routed:false};
    const next=Uint32Array.from(t1.object.data);
    next[t1.index]=0xFF102030;
    t1.object.replaceData(next,0);
    t1.object.markAsDirty();
    rom.assemble();
    let changed=0; for(let i=0;i<rom.data.length;i++) if(rom.data[i]!==before[i]) changed++;
    return {routed:t0.object!==t1.object, differentPalettes:t0.object.path!==t1.object.path,
            paletteBytesChanged:changed, undo:rom.canUndo()};
  })()`);
  console.log('  palette edit:',JSON.stringify(edited));
  check(edited.routed,'color 1 and color 5 belong to different ROM palettes (composition routes edits correctly)');
  check(edited.paletteBytesChanged>0&&edited.paletteBytesChanged<=3,
        'editing a palette color changes the ROM ('+edited.paletteBytesChanged+' bytes)');

  // Up/Down must move the tree selection even though the graphics pane takes
  // keyboard focus when an object is opened (that focus grab is what broke it)
  const arrows=await ev(c,sessionId,`(()=>{
    const cats=[...document.querySelectorAll('#left-pane li.nav-category > p')];
    const battle=cats.find(p=>/Battle/.test(p.textContent));
    if(!battle) return {ok:false, why:'no Battle category'};
    battle.click();                                  // expand the section
    const rows=[...document.querySelectorAll('#left-pane li.nav-object')]
        .filter(li=>li.querySelector(':scope > p')&&li.offsetParent!==null);
    if(rows.length<2) return {ok:false, why:'fewer than 2 visible rows: '+rows.length};
    rows[0].querySelector(':scope > p').click();     // a real click anchors the selection
    const start=romNavigator.selectedNode;
    const pane=document.querySelector('.graphics-edit-pane');
    if(pane) pane.focus();
    const focusedPane=document.activeElement===pane;
    pane.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
    const now=romNavigator.selectedNode;
    pane.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
    return {ok:true, focusedPane, start:start?start.textContent.slice(0,24):null,
            moved:now&&now!==start, movedTo:now?now.textContent.slice(0,24):null,
            cameBack:now===start||romNavigator.selectedNode===start,
            editorNow:propertyList.selection.current?propertyList.selection.current.name+'/'+propertyList.selection.current.i:null};
  })()`);
  console.log('  arrows:',JSON.stringify(arrows));
  check(arrows.ok&&arrows.focusedPane,'the graphics pane holds keyboard focus after selecting (the case that regressed)');
  check(arrows.moved,'ArrowDown moves the tree selection: '+arrows.start+' -> '+arrows.movedTo);
  check(arrows.cameBack,'ArrowUp returns to the original selection');

  const undone2=await ev(c,sessionId,`(()=>{ rom.undo(); rom.assemble();
      let d=0; const orig=new Uint8Array(rom.__origLen||0); return rom.undoStack.length; })()`);
  check(undone2>=0,'undo stack after palette undo: '+undone2);

  // ---- per-cell palettes (the monster attribute table) -------------------
  // A 4x4 monster stands in a 4x6 formation slot (2F/A2D0 gives the slot's
  // first tile id as $70 while 4x4 graphics load at PPU $0780), so the first
  // cell row of the record is the empty row above the sprite: the cells shown
  // must be read with a 2-cell offset, or the split lands half a row too high.
  const cells=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphics4x4.item(2);          // ファイアフライ / アイスフライ
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      view.updateTilemap();
      const per=view.paletteView.colorsPerPalette||4;
      const bits=[];
      for (let t=0;t<view.width*view.height;t++) bits.push(view.paletteBitsForTile(t)/per);
      const ref=obj.attributeRef;
      // the same record read straight out of the ROM
      const b=rom.monsterAttributeData.item(ref.index).data[0];
      const want=[];
      for (let row=0;row<view.height;row++) for (let col=0;col<view.width;col++) {
          const k=Math.floor(row/2)*Math.ceil(view.width/2)+Math.floor(col/2)+ref.offset;
          want.push((((b>>(7-k))&1)^(ref.invert?1:0))?4:0);
      }
      return {offset:ref.offset, invert:!!ref.invert, byte:b, bits:bits.map(x=>x*4), want};
  })()`);
  console.log('  cells:',JSON.stringify(cells));
  check(cells.offset===2,'4x4 graphics skip the empty slot row above the sprite (offset '+cells.offset+')');
  check(JSON.stringify(cells.bits)===JSON.stringify(cells.want),
        'every displayed tile uses the palette the ROM attribute byte selects');

  // editing the attribute byte changes the picture without reloading
  const live=await ev(c,sessionId,`(()=>{
      const view=propertyList.activeEditor;
      const obj=rom.monsterGraphics4x4.item(2);
      const arr=rom.monsterAttributeData;
      const before=[]; view.updateTilemap();
      for (let t=0;t<16;t++) before.push(view.paletteBitsForTile(t));
      const item=arr.item(obj.attributeRef.index);
      const was=item.data[0];
      item.replaceData(Uint8Array.from([was^0xFF]),0);
      const after=[]; view.updateTilemap();
      for (let t=0;t<16;t++) after.push(view.paletteBitsForTile(t));
      rom.undo();
      return {changed:after.filter((v,i)=>v!==before[i]).length,
              restored:arr.item(obj.attributeRef.index).data[0]===was};
  })()`);
  console.log('  live attribute edit:',JSON.stringify(live));
  check(live.changed===16,'editing the attribute byte repaints every cell (the view reads the table live)');
  check(live.restored,'and undo puts the byte back');

  // ---- boss tilemaps -----------------------------------------------------
  const boss=await ev(c,sessionId,`(()=>{
      const obj=rom.bossTilemap0;
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      const fmt=GFX.tileFormat.ff3BossTilemap;
      // the palette bits the view stamped onto the working tilemap
      const bits=view.tilemap.map(w=>(w & 0x00FF0000)>>16);
      const rawBefore=fmt.encode(obj.data.slice())[0];
      let src=-1,dst=-1;
      for(let t=0;t<view.tilemap.length;t++){
          const w=view.tilemap[t]&0xFFFF;
          if(src<0 && w<0x100) src=t;
          if(dst<0 && w>=0x100) dst=t;
      }
      view.pickedTile=view.tilemap[src];
      view.selection={x:dst%view.width,y:Math.floor(dst/view.width),w:1,h:1,
                      tilemap:new Uint32Array([view.tilemap[src]])};
      const ok=view.stampTile();
      view.setTilemap();
      const rawAfter=fmt.encode(obj.data.slice())[0];
      const changed=[]; for(let t=0;t<rawBefore.length;t++) if(rawBefore[t]!==rawAfter[t]) changed.push(t);
      rom.undo();
      const rawUndo=fmt.encode(rom.bossTilemap0.data.slice())[0];
      let undone=true; for(let t=0;t<rawBefore.length;t++) if(rawBefore[t]!==rawUndo[t]) undone=false;
      return {placeTile:view.placeTile, cells:obj.attributeCells?obj.attributeCells.length:0,
              twoPalettes:view.paletteView.palette.length,
              mixed:bits.includes(0)&&bits.includes(4),
              ok,changed,srcCell:view.tilemap[src]&0xFFFF,dstRaw:rawBefore[dst],
              afterRaw:rawAfter[dst],undone};
  })()`);
  console.log('  boss:',JSON.stringify(boss));
  check(boss.placeTile===true,'a boss tilemap starts in "Place tile" mode');
  check(boss.cells===54,'the boss tilemap carries its 54 palette cells');
  check(boss.twoPalettes===8,'and both battle palettes of the boss battle');
  check(boss.mixed,'the cells are drawn with both palettes (color offsets 0 and 4 both appear)');
  check(boss.ok&&boss.changed.length===1,
        'stamping one cell writes exactly one tilemap byte ('+JSON.stringify(boss.changed)+')');
  check(boss.dstRaw<0x70&&boss.afterRaw>=0x70,
        'a background cell becomes a sprite tile ('+boss.dstRaw+' -> '+boss.afterRaw+')');
  check(boss.undone,'and undo puts the whole tilemap back');

  // ---- painting the palette cells themselves -----------------------------
  // The convenient way to change which palette a part of a sprite uses: select
  // a palette row in the panel, then click the cells. It writes the attribute
  // byte back (un-inverted, 2F/A8BF), and the picture follows.
  const cellPaint=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphics6x6.item(2);      // マンドレイク / Mandrake
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      const arr=rom.monsterAttributeData;
      const item=arr.item(obj.attributeRef.index);
      const was=item.data[0];
      view.tool=4; view.paletteView.p=1;
      // drive it the way a user does: press, drag, release on the canvas
      const r=view.canvas.getBoundingClientRect();
      const at=(x,y)=>({bubbles:true,cancelable:true,clientX:r.left+x*view.zoom+1,
                        clientY:r.top+y*view.zoom+1,button:0,buttons:1});
      view.canvas.dispatchEvent(new MouseEvent('mousedown',at(2,2)));
      view.canvas.dispatchEvent(new MouseEvent('mousemove',at(4,2)));
      view.canvas.dispatchEvent(new MouseEvent('mouseup',at(4,2)));
      const now=item.data[0];
      // and the view must show the change
      const bits0=view.paletteBitsForTile(0);
      rom.undo();
      return {ok:true, changed:now!==was, bits:[...((was^now)&0xFF).toString(2).padStart(8,'0')],
              restored:arr.item(obj.attributeRef.index).data[0]===was,
              toolButton:(document.getElementById('changeTool')||{}).value||null,
              tools:(view.list&&view.list.changeTool)?view.list.changeTool.names:[]};
  })()`);
  console.log('  cell paint:',JSON.stringify(cellPaint));
  check(cellPaint.changed,
        'the Palette cells tool writes the dragged cells back to monsterAttributeData (bits '+cellPaint.bits.join('')+')');
  check(cellPaint.restored,'and undo puts the byte back');
  check(cellPaint.tools&&cellPaint.tools.indexOf('Palette cells')>=0,
        'the tool is in the Tool menu: '+JSON.stringify(cellPaint.tools));

  // boss layout: paint a cell's palette from the tilemap view
  const bossCells=await ev(c,sessionId,`(()=>{
      const obj=rom.bossTilemap8;
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      const arr=rom.bossAttributeData;
      const item=arr.item(obj.attributeRef.index);
      const was=Uint8Array.from(item.data);
      view.paintCells=true; view.paletteView.p=0;
      view.selection={x:4,y:2,w:1,h:1,tilemap:new Uint32Array([0])};
      view.paintCell();
      const now=Uint8Array.from(item.data);
      let diff=-1; for(let i=0;i<was.length;i++) if(was[i]!==now[i]) diff=i;
      rom.undo();
      const back=Uint8Array.from(arr.item(obj.attributeRef.index).data);
      return {diff, changed:diff>=0, undone:back.every((v,i)=>v===was[i]),
              layoutControls:[...view.editControls.querySelectorAll('.two-state p')].map(p=>p.textContent),
              poolTools:(()=>{ const v=propertyList.activeEditor.graphicsView;
                               return (v.list&&v.list.changeTool)?v.list.changeTool.names:[]; })()};
  })()`);
  console.log('  boss cell paint:',JSON.stringify(bossCells));
  check(bossCells.changed,'Paint palette cells edits the boss record in bossAttributeData (byte '+bossCells.diff+')');
  check(bossCells.undone,'and undo restores it');
  check(bossCells.layoutControls.indexOf('Paint palette cells')>=0&&
        bossCells.layoutControls.indexOf('Place tile')>=0,
        'the boss layout offers Place tile + Paint palette cells: '+JSON.stringify(bossCells.layoutControls));
  check(bossCells.poolTools.length===0,
        'the pool panel shares the layout Tool menu instead of adding a second one');
  check(bossCells.layoutControls.indexOf('Swap palette cells')<0,
        'no "Swap palette cells" toggle - the pair order is a palette dropdown choice');

  // mirrored bosses (Odin, Leviathan): the ROM stores them right-to-left and
  // the game flips them (2F/A40B), so the view mirrors and the save un-mirrors
  const mirror=await ev(c,sessionId,`(()=>{
      const obj=rom.bossTilemap22;
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      const fmt=GFX.tileFormat.ff3BossTilemap;
      const raw=fmt.encode(obj.data.slice())[0];
      const shown=view.tilemap;
      // the game copies the tilemap as stored (3F/F90A) and flips each tile's
      // pixels (2F/A40B + 3F/F970's bit-reversal table), so the view must keep
      // the stored tile ids and set the pixel-flip bit - not reverse columns
      const row2=[]; for(let c=0;c<18;c++) row2.push(shown[2*18+c]);
      const ids=row2.filter(w=>(w&0xFFFF)<0x100).map(w=>w&0xFFFF);
      let descOrder=true, flipped=ids.length>0;
      for(let i=1;i<ids.length;i++) if(ids[i]>ids[i-1]) descOrder=false;
      for(const w of row2) if((w&0xFFFF)<0x100 && !(w&0x10000000)) flipped=false;
      // saving must put it back exactly
      view.setTilemap();
      const back=fmt.encode(rom.bossTilemap22.data.slice())[0];
      let diffs=0; for(let t=0;t<raw.length;t++) if(raw[t]!==back[t]) diffs++;
      rom.undo();
      return {mirrorX:!!obj.mirrorX, descOrder, tiles:ids.length, flipped, diffs};
  })()`);
  console.log('  mirror:',JSON.stringify(mirror));
  check(mirror.mirrorX,'the summon-backed bosses are marked mirrorX');
  check(mirror.descOrder&&mirror.tiles>3,'their tile ids keep the ROM order on screen');
  check(mirror.flipped,'and the flip is done per tile pixel, as 3F/F970 does');
  check(mirror.diffs===0,'saving a mirrored boss leaves the ROM byte-exact ('+mirror.diffs+' changed)');

  // the layout pane must forward Up/Down to the tree (it takes focus)
  const nav2=await ev(c,sessionId,`(()=>{
      const view=propertyList.activeEditor;
      const pane=view.div;
      // select the boss again so the tree selection is on it
      romNavigator.selectObject(rom.bossTilemap22);
      const start=romNavigator.selectedNode;
      pane.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      const now=romNavigator.selectedNode;
      pane.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));
      const backTo=romNavigator.selectedNode;
      return {ok:true, hasHandler:!!pane.onkeydown, start:start?start.textContent.slice(0,18):null,
              moved:!!now&&now!==start, back:backTo===start,
              name:now?now.textContent.slice(0,18):null,
              backName:backTo?backTo.textContent.slice(0,18):null};
  })()`);
  console.log('  tilemap arrows:',JSON.stringify(nav2));
  check(nav2.hasHandler&&nav2.moved,'ArrowDown moves the tree from the boss layout pane: '+nav2.start+' -> '+nav2.name);
  check(nav2.backName&&nav2.backName!==nav2.name,
        'ArrowUp moves it again from the same pane: '+nav2.name+' -> '+nav2.backName);


  // the pool panel of a boss is shown in the order the tilemap uses the tiles,
  // so it reads as the creature and Pencil/Fill paint the part you see
  const poolGeom=await ev(c,sessionId,`(()=>{
      const out={};
      for(const key of ['bossTilemap22','bossTilemap23','bossTilemap8']){
          romNavigator.selectObject(rom[key]); propertyList.select(rom[key]);
          const v=propertyList.activeEditor, gv=v.graphicsView;
          out[key]={w:gv.width, h:gv.height, layout:!!gv.poolLayout,
                    firstRow:[...gv.tilemap.slice(0,18)].map(t=>(t===0xFFFFFFFF)?-1:(t&0xFFFF))};
      }
      return out;
  })()`);
  console.log('  pool geometry:',JSON.stringify(poolGeom));
  check(poolGeom.bossTilemap22.layout&&poolGeom.bossTilemap22.w===18,
        'a boss pool panel follows the tilemap layout (18 wide, not a scattered sheet)');
  const lay=poolGeom.bossTilemap22.firstRow, rom22=poolGeom.bossTilemap22;
  check(lay[0]===-1||lay[0]>=0,'layout row: '+JSON.stringify(lay.slice(0,10)));

  // ---- Boss Graphics: paintable windows onto the shared pools ------------
  // A boss is assembled from a tile pool another assembly owns, so the tree
  // gets a separate "Boss Graphics" entry per boss: a real bitmap with
  // Pencil/Fill that writes through to the owner. The tilemap entry stays the
  // placement view.
  const windows=await ev(c,sessionId,`(()=>{
      const names=rom.hierarchy.map(s=>s.name);
      const bg=rom.parsePath('bossGraphics8');
      const out={sections:names, bg:!!bg, bgType:bg&&bg.constructor.name,
                 bgW:bg&&bg.width, bgH:bg&&bg.height, bgTiles:bg&&bg.data.length/64};
      if(bg){
          romNavigator.selectObject(bg); propertyList.select(bg);
          const v=propertyList.activeEditor;
          out.view=v.constructor.name;
          out.tools=(v.list&&v.list.changeTool)?v.list.changeTool.names:[];
          out.layoutW=v.width; out.layoutH=v.height;
          out.hasLayout=!!v.poolLayout;
          rom.assemble();
          const before=Uint8Array.from(rom.data);
          // drive it the way the user does: pick the tool, press, drag, release
          v.tool=1; v.color=2;
          const cell=v.poolLayout.findIndex(t=>t>=0);
          const cx=(cell%v.width)*8+1, cy=Math.floor(cell/v.width)*8+1;
          const r=v.canvas.getBoundingClientRect();
          const mk=(t,x,y)=>new MouseEvent(t,{bubbles:true,cancelable:true,
                            clientX:r.left+x*v.zoom, clientY:r.top+y*v.zoom,
                            button:0, buttons:1});
          v.canvas.dispatchEvent(mk('mousedown',cx,cy));
          v.canvas.dispatchEvent(mk('mousemove',cx+1,cy));
          v.canvas.dispatchEvent(mk('mouseup',cx+1,cy));
          rom.assemble();
          let changed=0; for(let i=0;i<before.length;i++) if(before[i]!==rom.data[i]) changed++;
          out.changed=changed;
          out.undoSteps=1;
          rom.undo(); rom.assemble();
          let back=0; for(let i=0;i<before.length;i++) if(before[i]!==rom.data[i]) back++;
          out.restored=back===0;
      }
      romNavigator.selectObject(rom.bossTilemap8); propertyList.select(rom.bossTilemap8);
      const tv=propertyList.activeEditor;
      tv.resetControls();
      out.layoutTools=(tv.list&&tv.list.changeTool)?tv.list.changeTool.names:null;
      out.layoutChecks=[...tv.editControls.querySelectorAll('.two-state p')].map(p=>p.textContent);
      out.sg=!!rom.parsePath('summonGraphics5');
      return out;
  })()`);
  console.log('  boss graphics windows:',JSON.stringify(windows));
  check(windows.sections.indexOf('Boss Tilemaps')>=0&&windows.sections.indexOf('Boss Graphics')>=0&&
        windows.sections.indexOf('Summon Tilemaps')>=0&&windows.sections.indexOf('Summon Graphics')>=0,
        'the tree separates tilemaps from graphics: '+windows.sections.join(', '));
  check(windows.bgType==='ROMGraphics'&&windows.bgTiles===144,
        'Boss Graphics 8 is a 144-tile bitmap ('+windows.bgW+'x'+windows.bgH+')');
  check(windows.view==='ROMGraphicsView','it opens in the ordinary graphics editor: '+windows.view);
  check(windows.tools.indexOf('Pencil')>=0&&windows.tools.indexOf('Fill')>=0,
        'with the normal tools: '+JSON.stringify(windows.tools));
  check(windows.hasLayout&&windows.layoutW===18&&windows.layoutH===12,
        'the Boss Graphics window shows the tiles in the tilemap order ('+
        windows.layoutW+'x'+windows.layoutH+'), so you paint the creature');
  check(windows.changed>0,'Pencil on Boss Graphics writes '+windows.changed+' byte(s) into the pool');
  check(windows.restored,'and undo restores the ROM exactly');
  check(windows.sg,'summon graphics windows exist too');
  check(!windows.layoutTools,'the tilemap pane has no Tool menu (placement only)');
  check(windows.layoutChecks.indexOf('Place tile')>=0,
        'the tilemap pane keeps Place tile + palette cells: '+JSON.stringify(windows.layoutChecks));

  // every boss/summon window must agree with the pool bytes the tilemap view
  // reads (that path already worked) and must not come out black
  const allWindows=await ev(c,sessionId,`(()=>{
      const bad=[];
      const stats=[];
      for(let i=0;i<24;i++){
          const w=rom.parsePath('bossGraphics'+i), tm=rom.parsePath('bossTilemap'+i);
          if(!w||!tm){ bad.push('boss'+i+': missing'); continue; }
          // the toolbox path: concatenate the container's decoded items
          const container=rom.parsePath(tm.graphics.path);
          let pool=null;
          if(container.array){
              const parts=[]; let total=0;
              for(let j=0;j<container.arrayLength;j++){
                  const it=container.item(j); if(!it||!it.data) continue;
                  parts.push(it.data); total+=it.data.length;
              }
              pool=new Uint8Array(total); let at=0;
              for(const p of parts){ pool.set(p,at); at+=p.length; }
          } else pool=container.data;
          const r=ROMRange.parse(tm.graphics.range);
          const expect=pool.subarray(r.begin, r.end);
          if(w.data.length!==expect.length){
              bad.push('boss'+i+': len '+w.data.length+' != '+expect.length); continue;
          }
          let diff=0; for(let k=0;k<expect.length;k++) if(w.data[k]!==expect[k]) diff++;
          if(diff) bad.push('boss'+i+': '+diff+' bytes differ from the pool');
          let nonzero=0; for(let k=0;k<w.data.length;k++) if(w.data[k]) nonzero++;
          if(nonzero===0) bad.push('boss'+i+': all black');
          stats.push({i, tiles:w.window.tiles, nonzero, mirror:!!tm.mirrorX});
      }
      for(let i=0;i<8;i++){
          const w=rom.parsePath('summonGraphics'+i);
          if(!w){ bad.push('summon'+i+': missing'); continue; }
          let nonzero=0; for(let k=0;k<w.data.length;k++) if(w.data[k]) nonzero++;
          if(nonzero===0) bad.push('summon'+i+': all black');
      }
      // the mirrored bosses' windows must carry the flip on every used cell
      romNavigator.selectObject(rom.bossGraphics22); propertyList.select(rom.bossGraphics22);
      const v=propertyList.activeEditor;
      const used=[...v.tilemap].filter(t=>t!==0xFFFFFFFF);
      const allFlipped=used.length>0 && used.every(t=>!!(t&0x10000000));
      return {bad, checked:stats.length, allFlipped, used:used.length,
              dims:v.width+'x'+v.height};
  })()`);
  console.log('  windows checked:', allWindows.checked, 'bad:', JSON.stringify(allWindows.bad));
  check(allWindows.bad.length===0,
        'all 24 boss + 8 summon graphics windows match the pool bytes and are not black');
  check(allWindows.allFlipped,
        'the mirrored bosses flip every tile in the window, as the game does ('+allWindows.used+' cells)');

  // ---- the Palette cells tool and "paint forces the palette" -------------
  const cellTool=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphics6x6.item(2);
      romNavigator.selectObject(obj); propertyList.select(obj);
      const v=propertyList.activeEditor;
      const arr=rom.monsterAttributeData;
      const item=arr.item(obj.attributeRef.index);
      const out={before:item.data[0]};
      const r=v.canvas.getBoundingClientRect();
      const click=(x,y,tool)=>{
          v.tool=tool;
          const mk=t=>new MouseEvent(t,{bubbles:true,cancelable:true,
              clientX:r.left+x*v.zoom, clientY:r.top+y*v.zoom, button:0, buttons:1});
          v.canvas.dispatchEvent(mk('mousedown'));
          v.canvas.dispatchEvent(mk('mouseup'));
      };
      // Palette cells tool with palette row 2 selected
      v.paletteView.p=1; v.color=1;
      click(2,2,4);
      const afterTool=arr.item(obj.attributeRef.index).data[0];
      out.toolChanged=afterTool!==out.before;
      out.toolMask=(out.before^afterTool).toString(2);
      // undo, then paint a pixel that ALREADY has the paint color: the cell
      // must still move onto the selected palette row
      rom.undo();
      const base=arr.item(obj.attributeRef.index).data[0];
      const idxAt=(x,y)=>(Math.floor(Math.floor(y/8)/2)*Math.ceil(obj.width/2)+Math.floor(Math.floor(x/8)/2)+obj.attributeCellsOffset);
      out.cellBitBefore=(base>>(7-idxAt(2,2)))&1;
      v.paletteView.p=1;
      // pick a pixel whose current index equals the paint color
      let px=-1,py=-1;
      for(let y=0;y<obj.height*8&&px<0;y++)
        for(let x=0;x<obj.width*8;x++)
          if(v.graphics[v.tileOffset(x,y)]===1){px=x;py=y;break;}
      out.pixel=px+','+py;
      click(px,py,1);   // pencil
      const afterPaint=arr.item(obj.attributeRef.index).data[0];
      out.paintChanged=afterPaint!==base;
      out.cellBitAfter=(afterPaint>>(7-idxAt(px,py)))&1;
      rom.undo();
      // color picking must select the palette that cell actually uses
      const base2=arr.item(obj.attributeRef.index).data[0];
      let pickX=-1,pickY=-1,wantBit=-1;
      for(let y=0;y<obj.height*8&&pickX<0;y++)
        for(let x=0;x<obj.width*8;x++){
          const k=(Math.floor(Math.floor(y/8)/2)*Math.ceil(obj.width/2)+Math.floor(Math.floor(x/8)/2)+obj.attributeCellsOffset);
          const bit=(base2>>(7-k))&1;
          if(bit===1&&v.graphics[v.tileOffset(x,y)]>0){pickX=x;pickY=y;wantBit=bit;break;}
        }
      v.paletteView.p=0; v.color=0;
      v.tool=3;
      const mk=t=>new MouseEvent(t,{bubbles:true,cancelable:true,
          clientX:r.left+pickX*v.zoom, clientY:r.top+pickY*v.zoom, button:0, buttons:1});
      v.canvas.dispatchEvent(mk('mousedown'));
      v.canvas.dispatchEvent(mk('mouseup'));
      out.pick={x:pickX,y:pickY,wantBit};
      out.pickRow=v.paletteView.p;
      out.pickColor=v.color;
      out.pickOk=v.paletteView.p===1&&v.color>0;
      return out;
  })()`);
  console.log('  palette cell tool:',JSON.stringify(cellTool));
  check(cellTool.toolChanged,'the Palette cells tool writes the clicked cell to the attribute byte');
  check(cellTool.paintChanged&&cellTool.cellBitAfter===1,
        'painting moves the cell onto the selected palette row even when the pixel already matches ('+
        JSON.stringify(cellTool.pixel)+')');
  check(cellTool.pickOk,
        'the color picker selects the palette that cell uses (row '+cellTool.pickRow+
        ', color '+cellTool.pickColor+', at '+JSON.stringify(cellTool.pick)+')');

  // ---- DiveEagle: click the 4th color of the 2nd palette, then draw ------
  const dive=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphics4x4.item(11);      // DiveEagle / ボーイイーグル
      romNavigator.selectObject(obj); propertyList.select(obj);
      const v=propertyList.activeEditor, pv=v.paletteView;
      const arr=rom.monsterAttributeData;
      const rec=()=>arr.item(obj.attributeRef.index).data[0];
      const out={colorsPerPalette:pv.colorsPerPalette, rowsPerPalette:pv.rowsPerPalette,
                 rows:pv.rows, palLen:pv.palette.length, ref:JSON.stringify(obj.attributeRef),
                 objW:obj.width, paintable:v.paintableCells()};
      // click the last color of the second row in the palette panel
      const pr=pv.canvas.getBoundingClientRect();
      const x=pr.left+(pv.colorWidth*3.5), y=pr.top+(pv.colorHeight*1.5);
      pv.canvas.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,
                                clientX:x, clientY:y, button:0, buttons:1}));
      out.afterPalClick={p:pv.p, color:v.color, row:v.currentPaletteRow()};
      // pencil on the bottom half of the sprite
      const cr=v.canvas.getBoundingClientRect();
      const px=10, py=26;
      const cell=(Math.floor(py/16)*Math.ceil(obj.width/2)+Math.floor(px/16)+obj.attributeCellsOffset);
      out.cellIndex=cell; out.bitBefore=(rec()>>(7-cell))&1;
      v.tool=1;
      const mk=t=>new MouseEvent(t,{bubbles:true,cancelable:true,
                    clientX:cr.left+px*v.zoom, clientY:cr.top+py*v.zoom, button:0, buttons:1});
      v.canvas.dispatchEvent(mk('mousedown'));
      v.canvas.dispatchEvent(mk('mousemove'));
      v.canvas.dispatchEvent(mk('mouseup'));
      out.bitAfter=(rec()>>(7-cell))&1;
      out.undoStack=rom.undoStack.length;
      rom.undo();
      out.bitAfterUndo=(rec()>>(7-cell))&1;
      return out;
  })()`);
  console.log('  diveeagle:',JSON.stringify(dive));
  check(dive.bitAfter===1&&dive.bitAfterUndo===dive.bitBefore,
        'clicking palette row 2 then drawing flips DiveEagle cell '+dive.cellIndex+
        ' ('+dive.bitBefore+' -> '+dive.bitAfter+', undo -> '+dive.bitAfterUndo+')');

  // undo/redo through the UI must revert both the bytes and the picture
  const undoRedo=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphics4x4.item(11);
      romNavigator.selectObject(obj); propertyList.select(obj);
      const v=propertyList.activeEditor, pv=v.paletteView;
      const arr=rom.monsterAttributeData;
      const rec=()=>arr.item(obj.attributeRef.index).data[0];
      rom.assemble();
      const before=Uint8Array.from(rom.data);
      const cell=(Math.floor(Math.floor(26/8)/2)*Math.ceil(obj.width/2)+Math.floor(Math.floor(10/8)/2)+obj.attributeCellsOffset);
      const bitOf=()=>(rec()>>(7-cell))&1;
      const bitsShown=()=>{v.updateTilemap(); return [...v.tilemap].map(t=>(t&0x00FF0000)>>16);};
      const shown0=bitsShown();
      pv.p=1; pv.setColor(3); v.color=3;
      const cr=v.canvas.getBoundingClientRect();
      const mk=t=>new MouseEvent(t,{bubbles:true,cancelable:true,
                    clientX:cr.left+10*v.zoom, clientY:cr.top+26*v.zoom, button:0, buttons:1});
      v.tool=1;
      v.canvas.dispatchEvent(mk('mousedown'));
      v.canvas.dispatchEvent(mk('mousemove'));
      v.canvas.dispatchEvent(mk('mouseup'));
      const bitPainted=bitOf();
      rom.assemble();
      let painted=0; for(let i=0;i<before.length;i++) if(before[i]!==rom.data[i]) painted++;
      const shown1=bitsShown();
      rom.undo(); rom.assemble();
      const bitUndo=bitOf();
      const shown2=bitsShown();
      let afterUndo=0; for(let i=0;i<before.length;i++) if(before[i]!==rom.data[i]) afterUndo++;
      rom.redo(); rom.assemble();
      const bitRedo=bitOf();
      const shown3=bitsShown();
      rom.undo(); rom.assemble();
      return {cell, bitPainted, bitUndo, bitRedo, painted, afterUndo,
              viewFollows:JSON.stringify(shown2)===JSON.stringify(shown0)&&
                          JSON.stringify(shown3)===JSON.stringify(shown1),
              changedOnPaint:JSON.stringify(shown1)!==JSON.stringify(shown0)};
  })()`);
  console.log('  undo/redo:',JSON.stringify(undoRedo));
  check(undoRedo.bitPainted===1&&undoRedo.bitUndo===0&&undoRedo.bitRedo===1,
        'undo and redo revert the palette cell ('+undoRedo.bitPainted+' -> '+undoRedo.bitUndo+
        ' -> '+undoRedo.bitRedo+')');
  check(undoRedo.painted>0&&undoRedo.afterUndo===0,
        'undo restores the ROM bytes ('+undoRedo.painted+' changed, '+undoRedo.afterUndo+' after undo)');
  check(undoRedo.changedOnPaint&&undoRedo.viewFollows,
        'the picture follows undo/redo (repaint on paint, back on undo, again on redo)');

  // the cell must flip live (during the drag, not only on mouse-up), and it
  // must flip even when the pixel already holds the paint color
  const liveCell=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphics4x4.item(11);
      romNavigator.selectObject(obj); propertyList.select(obj);
      const v=propertyList.activeEditor, pv=v.paletteView;
      const arr=rom.monsterAttributeData;
      const rec=()=>arr.item(obj.attributeRef.index).data[0];
      const cell=(Math.floor(Math.floor(26/8)/2)*Math.ceil(obj.width/2)+Math.floor(Math.floor(10/8)/2)+obj.attributeCellsOffset);
      const bit=()=>(rec()>>(7-cell))&1;
      const shown=()=>{v.updateTilemap(); return (v.tilemap[Math.floor(26/8)*obj.width+Math.floor(10/8)]&0x00FF0000)>>16;};
      const cr=v.canvas.getBoundingClientRect();
      const mk=(t,x,y)=>new MouseEvent(t,{bubbles:true,cancelable:true,
                    clientX:cr.left+x*v.zoom, clientY:cr.top+y*v.zoom, button:0, buttons:1});
      const off=v.tileOffset(10,26);
      const startBit=bit(), startShown=shown();
      // paint with the SAME index the pixel already has, on the other palette row
      v.color=v.graphics[off];
      pv.p=startBit?0:1;
      v.tool=1;
      v.canvas.dispatchEvent(mk('mousedown',10,26));
      const midBit=bit(), midShown=shown();
      v.canvas.dispatchEvent(mk('mousemove',12,26));
      v.canvas.dispatchEvent(mk('mouseup',12,26));
      const endBit=bit(), endShown=shown();
      rom.undo();
      return {color:v.color, startBit, midBit, midShown, startShown, endBit, endShown,
              wantShown:(pv.p?4:0)};
  })()`);
  console.log('  live cell flip:',JSON.stringify(liveCell));
  check(liveCell.midBit!==liveCell.startBit,
        'painting the same pixel index on another palette row still flips the cell ('+
        liveCell.startBit+' -> '+liveCell.midBit+')');
  check(liveCell.midShown!==liveCell.startShown,
        'the picture updates during the drag, not only on mouse-up ('+
        liveCell.startShown+' -> '+liveCell.midShown+', want '+liveCell.wantShown+')');

  // flood fill must re-palette the region even when the pixels already hold
  // the paint color (the same trap the pencil had)
  const fillCells=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphics4x4.item(11);
      romNavigator.selectObject(obj); propertyList.select(obj);
      const v=propertyList.activeEditor, pv=v.paletteView;
      const arr=rom.monsterAttributeData;
      const rec=()=>arr.item(obj.attributeRef.index).data[0];
      const cellOf=(px,py)=>(Math.floor(Math.floor(py/8)/2)*Math.ceil(obj.width/2)+
                             Math.floor(Math.floor(px/8)/2)+obj.attributeCellsOffset);
      const cr=v.canvas.getBoundingClientRect();
      const mk=(t,x,y)=>new MouseEvent(t,{bubbles:true,cancelable:true,
                    clientX:cr.left+x*v.zoom, clientY:cr.top+y*v.zoom, button:0, buttons:1});
      const px=10, py=26, cell=cellOf(px,py);
      const startBit=(rec()>>(7-cell))&1;
      v.color=v.graphics[v.tileOffset(px,py)];   // the index it already has
      pv.p=startBit?0:1;                        // the other palette row
      v.tool=2;
      v.canvas.dispatchEvent(mk('mousedown',px,py));
      v.canvas.dispatchEvent(mk('mouseup',px,py));
      const endBit=(rec()>>(7-cell))&1;
      v.updateTilemap();
      const shown=(v.tilemap[Math.floor(py/8)*obj.width+Math.floor(px/8)]&0x00FF0000)>>16;
      rom.undo();
      const undoneBit=(rec()>>(7-cell))&1;
      return {startBit,endBit,undoneBit,shown,want:(pv.p?4:0)};
  })()`);
  console.log('  flood fill cells:',JSON.stringify(fillCells));
  check(fillCells.endBit!==fillCells.startBit&&fillCells.undoneBit===fillCells.startBit,
        'filling the same pixel index re-palettizes the cell ('+fillCells.startBit+' -> '+
        fillCells.endBit+', undo -> '+fillCells.undoneBit+')');
  check(fillCells.shown===fillCells.want,
        'and the picture shows the new palette immediately ('+fillCells.shown+' = '+fillCells.want+')');

  await c.s('Page.captureScreenshot',{format:'png',quality:90},sessionId).then(r=>fs.writeFileSync('/tmp/ff3j-app.png',Buffer.from(r.data,'base64')));
  console.log('  wrote /tmp/ff3j-app.png');
  if(fails) console.log(`\nFAILED: ${fails} check(s)`);
  ws.close();
  process.exitCode=fails?1:0;
 } finally { ch.kill(); srv.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
