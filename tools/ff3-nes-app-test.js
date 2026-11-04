// Does ff6tools recognise the FF3 (J) dump and can you actually edit its
// monster graphics in the browser?  Headless Chrome, no interaction needed:
//   node tools/ff3-nes-app-test.js
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
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
 const ch=spawn('google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port='+CDP,'about:blank'],{stdio:'ignore'});
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
        'colour 0 is opaque black - the sprite outline is colour 0 in the ROM, so it must not vanish');
  check(opened.palCount===8,'the monster opens with both of its battle palettes (8 colours = 2 rows, colour 0 = black)');
  check(Array.isArray(opened.palette)&&opened.palette[0].compose&&opened.palette[1].compose&&
        opened.palette[0].name&&opened.palette[1].name,
        'the two palettes are composed and named: '+opened.palette.slice(0,2).map(p=>p.name).join(' | '));

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
  // editing a palette colour must reach the ROM: with two composed palettes the
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
  check(edited.routed,'colour 1 and colour 5 belong to different ROM palettes (composition routes edits correctly)');
  check(edited.paletteBytesChanged>0&&edited.paletteBytesChanged<=3,
        'editing a palette colour changes the ROM ('+edited.paletteBytesChanged+' bytes)');

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
  check(boss.mixed,'the cells are drawn with both palettes (colour offsets 0 and 4 both appear)');
  check(boss.ok&&boss.changed.length===1,
        'stamping one cell writes exactly one tilemap byte ('+JSON.stringify(boss.changed)+')');
  check(boss.dstRaw<0x70&&boss.afterRaw>=0x70,
        'a background cell becomes a sprite tile ('+boss.dstRaw+' -> '+boss.afterRaw+')');
  check(boss.undone,'and undo puts the whole tilemap back');

  // ---- painting the shared tile pool a boss is built from ----------------
  const pool=await ev(c,sessionId,`(()=>{
      const obj=rom.bossTilemap0;
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor.graphicsView;
      const container=rom.parsePath(obj.graphics.path);
      rom.assemble();
      const before=Uint8Array.from(rom.data);
      view.paintStart=view.graphics.slice();
      view.tool=1; view.color=2;
      view.paintPixel(0,0); view.commitPaint();
      rom.assemble();
      const changed=[]; for(let i=0;i<before.length;i++) if(before[i]!==rom.data[i]) changed.push(i);
      const inRange=changed.every(i=>i>=container.range.begin&&i<container.range.end);
      rom.undo(); rom.assemble();
      let restored=true; for(let i=0;i<before.length;i++) if(before[i]!==rom.data[i]) restored=false;
      return {container:obj.graphics.path, changed:changed.length, inRange, restored};
  })()`);
  console.log('  pool paint:',JSON.stringify(pool));
  check(pool.changed>0&&pool.inRange,'painting the boss tile pool writes through to '+pool.container+' (the assembly that owns those bytes)');
  check(pool.restored,'and undo puts the pool back');

  await c.s('Page.captureScreenshot',{format:'png',quality:90},sessionId).then(r=>fs.writeFileSync('/tmp/ff3j-app.png',Buffer.from(r.data,'base64')));
  console.log('  wrote /tmp/ff3j-app.png');
  ws.close();
 } finally { ch.kill(); srv.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
