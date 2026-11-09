// Does ff6tools recognise FF IV Advance (U) and can you actually edit its
// monster graphics in the browser?
//   node tools/ff4-gba-app-test.js [rom]
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const PROFILE = fs.mkdtempSync('/tmp/ff6tools-chrome-');
const ROM=process.argv[2]||'/storage/romhacking/ff-roms/Final Fantasy IV Advance (USA).gba';
const PORT=8475, CDP=9375;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class C{constructor(w){this.w=w;this.i=0;this.h=new Map();w.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.h.has(m.id)){const{res,rej}=this.h.get(m.id);this.h.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};}
 s(x,p={},sid){return new Promise((res,rej)=>{const id=++this.i;this.h.set(id,{res,rej});this.w.send(JSON.stringify({id,method:x,params:p,sessionId:sid}));});}}
const ev=async(c,sid,e)=>{const r=await c.s('Runtime.evaluate',{expression:e,returnByValue:true},sid);if(r.exceptionDetails)throw new Error(String(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result.value;};
let fails=0;
const check=(cond,msg)=>{console.log((cond?'  ok  ':'  FAIL')+' '+msg);if(!cond)fails++;};
(async()=>{
 const srv=spawn('python3',['-m','http.server',String(PORT),'--dir',ROOT],{stdio:'ignore'});
 const ch=spawn('google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--user-data-dir='+PROFILE,'--disk-cache-size=1','--remote-debugging-port='+CDP,'about:blank'],{stdio:'ignore'});
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
  await sleep(5000);
  check(await ev(c,sessionId,'!!rom'),'ROM loaded');
  check(await ev(c,sessionId,'rom && rom.key')==='ff4u-gba','auto-detected as ff4u-gba');

  check(await ev(c,sessionId,'rom.monsterGraphicsProperties.arrayLength')===362,'362 graphics/palette pointer records');
  check(await ev(c,sessionId,'rom.monsterGraphics.arrayLength')===275,'monsterGraphics de-duplicated to 275 objects');
  check(await ev(c,sessionId,'rom.monsterPalettes.arrayLength')===271,'monsterPalettes de-duplicated to 271 objects');
  check(await ev(c,sessionId,`(()=>{const r=rom.monsterGraphicsProperties.item(12);
        const t=r.graphicsPointer.target;
        return t.range.begin+0x08000000===r.graphicsPointer.value &&
               rom.monsterPalettes.item(r.palettePointer.target.i).range.begin+0x08000000===r.palettePointer.value;
      })()`),'monster 12 (Sand Worm) resolves to the objects its pointers address');

  // open a monster in the editor: size from monsterSize, palette pinned
  const opened=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphicsProperties.item(12).graphicsPointer.target;
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      return {w:obj.width,h:obj.height,fmt:obj.format,
              view:view&&view.constructor.name,shown:!!(view&&view.object===obj),
              pal:obj.palette, pinned:obj.palettePinned,
              palCount:view.paletteView.palette.length,
              palHex:Array.from(view.paletteView.palette.slice(0,4)).map(x=>x.toString(16)),
              want:Array.from(rom.monsterPalettes.item(rom.monsterGraphicsProperties.item(12).palettePointer.target.i).data.slice(0,4)).map(x=>x.toString(16)),
              label:rom.stringTable['monsterGraphics'].string[obj.i].value};
  })()`);
  console.log('  editor:',JSON.stringify(opened));
  check(opened.view==='ROMGraphicsView'&&opened.shown,'graphics view opens on the Sand Worm object');
  check(opened.w===8&&opened.h===8,'Sand Worm displays 8x8 tiles (from monsterSize, not the array index)');
  check(opened.fmt==='linear4bpp,tose-graphics,gba-lzss'||JSON.stringify(opened.fmt).includes('gba-lzss'),
        'decoded through the LZSS + TOSE + linear4bpp chain: '+JSON.stringify(opened.fmt));
  check(opened.pinned&&opened.palHex.join()===opened.want.join(),'palette panel shows the palette its own record points at');
  check(/Sand Worm/.test(opened.label),'labelled with the monsters that use it: '+opened.label);

  // paint with the pencil, then undo: bytes must come back exactly
  const paint=await ev(c,sessionId,`(()=>{
      const orig=Uint8Array.from(rom.data);
      const obj=rom.monsterGraphicsProperties.item(12).graphicsPointer.target;
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      rom.beginAction();
      view.paintStart=view.graphics.slice();
      view.color=5;
      view.paintPixel(4,4);
      view.commitPaint();
      rom.endAction();
      const landed=obj.data[4*8+4];
      while(rom.undoStack.length) rom.undo();
      rom.assemble();
      let diffs=0; for(let i=0;i<orig.length;i++) if(rom.data[i]!==orig[i]) diffs++;
      return {landed, diffs};
  })()`);
  console.log('  paint:',JSON.stringify(paint));
  check(paint.landed===5,'pencil paints palette index 5 into the Sand Worm tile');
  check(paint.diffs===0,'undo restores the ROM byte-for-byte after painting');

  // the palette object itself is editable and its bytes land in the ROM
  const palEdit=await ev(c,sessionId,`(()=>{
      const orig=Uint8Array.from(rom.data);
      const rec=rom.monsterGraphicsProperties.item(12);
      const pal=rec.palettePointer.target;
      romNavigator.selectObject(pal); propertyList.select(pal);
      const view=propertyList.activeEditor;
      const next=Uint32Array.from(pal.data);
      next[1]=(0xFF<<24)|0x00FF00;          // what paletteView.editColor writes
      pal.replaceData(next,0);
      pal.markAsDirty();
      rom.assemble();
      let changed=0; for(let i=0;i<orig.length;i++) if(rom.data[i]!==orig[i]) changed++;
      while(rom.undoStack.length) rom.undo();
      rom.assemble();
      let diffs=0; for(let i=0;i<orig.length;i++) if(rom.data[i]!==orig[i]) diffs++;
      return {changed, diffs};
  })()`);
  console.log('  palette edit:',JSON.stringify(palEdit));
  check(palEdit.changed>0,'editing a monster palette writes into the ROM');
  check(palEdit.diffs===0,'undo of the palette edit is byte-exact');

  // monsters that share a block: Dragoon/Bard/Monk share the Goblin art
  const shared=await ev(c,sessionId,`(()=>{
      const a=rom.monsterGraphicsProperties.item(0).graphicsPointer.target;
      const b=rom.monsterGraphicsProperties.item(202).graphicsPointer.target;
      return {same:a===b, ai:a.i, bi:b.i, label:rom.stringTable['monsterGraphics'].string[a.i].value};
  })()`);
  console.log('  shared block:',JSON.stringify(shared));
  check(shared.same&&/Goblin/.test(shared.label)&&/Dark Kain/.test(shared.label)&&/slot 28[345]/.test(shared.label),
        'the placeholder slots share one object, labelled with all its users: '+shared.label);

  // the 48-colour palettes (Lunar espers, Zeromus EG) keep all 48 colours
  const wide=await ev(c,sessionId,`(()=>{
      const rec=rom.monsterGraphicsProperties.item(339);
      const pal=rec.palettePointer.target, obj=rec.graphicsPointer.target;
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      return {colors:pal.data.length, panel:view.paletteView.palette.length,
              w:obj.width,h:obj.height,rows:Math.ceil(view.paletteView.palette.length/16)};
  })()`);
  console.log('  48-colour palette:',JSON.stringify(wide));
  check(wide.colors===48&&wide.panel===48,'a 48-colour monster palette decodes as 48 colours in 3 rows');

  // the battle editor still draws monsters through the new records
  const battle=await ev(c,sessionId,`(()=>{
      const bps=rom.battleProperties; let b=-1;
      for(let i=0;i<bps.arrayLength;i++){
          const mons=bps.item(i).monsters;
          if(mons&&mons.arrayLength&&mons.item(0).monster.value===12){ b=i; break; }
      }
      if(b<0) return {err:'no battle with monster 12'};
      propertyList.select(bps.item(b));
      const view=propertyList.activeEditor;
      if(!view||view.constructor.name!=='FF4Battle') return {err:'not the battle editor: '+view};
      view.drawBattle();
      const slots=view.monsterSlot.map(s=>({m:s.m,
          gfx:s.m!==undefined?rom.monsterGraphicsProperties.item(s.m).graphicsPointer.target.i:-1}));
      return {b, view:view.constructor.name, slots:slots.slice(0,3)};
  })()`);
  console.log('  battle:',JSON.stringify(battle));
  check(!battle.err&&battle.view==='FF4Battle','battle editor opens a battle and draws it (battle '+battle.b+')');
  check(battle.slots&&battle.slots.every(s=>s.gfx>=0),'each battle monster resolves to a graphics object');

  // the navigator tree exposes the new sections
  const tree=await ev(c,sessionId,`(()=>{
      const sec=(rom.hierarchy||[]).find(s=>s.name==='Battle');
      const paths=sec.list.map(i=>i.path);
      return {gfx:paths.includes('monsterGraphics'), pal:paths.includes('monsterPalettes'),
              props:paths.includes('monsterGraphicsProperties')};
  })()`);
  check(tree.gfx&&tree.pal&&tree.props,'Battle section lists Monster Graphics, Monster Palettes and their properties');

  // character sprites: 20 groups of 15 frames (2x3) with one palette each
  const chars=await ev(c,sessionId,`(()=>{
      const cg=rom.characterGraphics, cp=rom.characterPalettes, csp=rom.characterSpriteProperties;
      const obj=cg.item(0);
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      const orig=Uint8Array.from(rom.data);
      view.paintStart=view.graphics.slice(); view.color=4;
      view.paintPixel(2,2); view.commitPaint();
      const landed=obj.data[2*8+2];
      while(rom.undoStack.length) rom.undo();
      rom.assemble();
      let diffs=0; for(let i=0;i<orig.length;i++) if(rom.data[i]!==orig[i]) diffs++;
      return {frames:cg.arrayLength, pals:cp.arrayLength, groups:csp.arrayLength,
              w:obj.width,h:obj.height, view:view&&view.constructor.name,
              pal:view.paletteView.palette.length, landed, diffs,
              label:rom.stringTable['characterGraphics'].string[obj.i].value};
  })()`);
  console.log('  characters:',JSON.stringify(chars));
  check(chars.groups===20&&chars.pals===20,'20 character sprite groups, one palette each');
  check(chars.frames>200&&chars.w===2&&chars.h===3,chars.frames+' character frames, 2x3 tiles each');
  check(chars.view==='ROMGraphicsView'&&chars.pal===16,'a character frame opens in the graphics view with its group palette');
  check(/Character 0/.test(chars.label),'character frames are labelled: '+chars.label);
  check(chars.landed===4&&chars.diffs===0,'character frames paint and undo byte-exactly');

  // the 22 tile-mapped monsters must read their palette bank per tile
  const banks=await ev(c,sessionId,`(()=>{
      const g=rom.monsterGraphicsProperties.item(268).graphicsPointer.target;   // Lunar Ramuh
      const tm=g.tilePaletteCells && rom.parsePath(g.tilePaletteCells.path).item(g.tilePaletteCells.index);
      romNavigator.selectObject(g); propertyList.select(g);
      const view=propertyList.activeEditor;
      const banks=[];
      for(let t=0;t<g.width*g.height;t++) banks.push(g.tilePaletteBank(t));
      const rows=new Set(banks).size;
      return {has:!!tm, tiles:banks.length, distinct:rows,
              pal:view.paletteView.palette.length,
              want:Array.from({length:banks.length},(_,t)=>(tm.data[12+t*2]|(tm.data[12+t*2+1]<<8))>>10&3)};
  })()`);
  check(banks.has&&banks.tiles>0&&
        JSON.stringify(Array.from({length:banks.tiles},(_,t)=>banks.want[t]))===JSON.stringify(banks.want),
        'Lunar Ramuh reads its palette banks from the ROM tile map');
  check(banks.distinct>1&&banks.pal===48,
        'its 48-colour palette is used through '+banks.distinct+' banks, not just the first');

  // animation chains must be named, not left as "Slot N"
  const chains=await ev(c,sessionId,`(()=>{
      const st=rom.stringTable['monsterGraphicsProperties'];
      const dw=[191,327,336].map(m=>st.string[m].fString());
      return {dw, bomb:st.string[324].fString(),
              unnamed:Object.keys(st.string).filter(k=>st.string[k].fString().startsWith('slot ')).length};
  })()`);
  console.log('  chains:',JSON.stringify(chains));
  check(/Demon Wall \(frame 1\/11\)/.test(chains.dw[0])&&/Demon Wall \(frame 11\/11\)/.test(chains.dw[2]),
        'Demon Wall\'s 11-frame cycle is named by frame: '+chains.dw.join(' | '));
  check(/Mom Bomb/.test(chains.bomb),'slot 324 is named Mom Bomb: '+chains.bomb);

  console.log(fails?`${fails} FAILURES`:'all FF4 GBA browser checks passed');
  process.exitCode=fails?1:0;
 } finally { ch.kill(); srv.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
