// Does ff6tools recognise the FF4 (U) dump (= "Final Fantasy II (USA)") and
// can you actually edit its monster/boss graphics in the browser?
//   node tools/ff4-sfc-app-test.js [rom]
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const PROFILE = fs.mkdtempSync('/tmp/ff6tools-chrome-');
const ROM=process.argv[2]||'/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc';
const PORT=8473, CDP=9373;
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
  await sleep(4000);
  check(await ev(c,sessionId,'!!rom'),'ROM loaded');
  check(await ev(c,sessionId,'rom && rom.key')==='ff2u-sfc','auto-detected as ff2u-sfc');

  check(await ev(c,sessionId,`rom.monsterGraphics.arrayLength`)==90,'monsterGraphics de-duplicated to 90 objects');
  check(await ev(c,sessionId,`rom.monsterGraphicsProperties.item(0).graphicsPointer.target.path`)==='monsterGraphics_80',
        'monster 0 (Imp) resolves to its graphics object');

  // open the Imp graphic in the editor
  const opened=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphicsProperties.item(0).graphicsPointer.target;
      romNavigator.selectObject(obj);
      propertyList.select(obj);
      const view=propertyList.activeEditor;
      return {w:obj.width,h:obj.height,fmt:obj.format,view:view&&view.constructor.name,
              shown:!!(view&&view.object===obj),
              pal:obj.palette, palCount:view?view.paletteView.palette.length:-1,
              label:rom.stringTable['monsterGraphics'].string[obj.i].value};
  })()`);
  console.log('  editor:',JSON.stringify(opened));
  check(opened.view==='ROMGraphicsView'&&opened.shown,'graphics view opens on the Imp object');
  check(opened.w===4&&opened.h===4,'Imp displays 4x4 tiles (from the size table)');
  check(opened.fmt==='snes3bpp','Imp decoded as snes3bpp (is3bpp flag)');
  check(opened.palCount===8,'palette panel shows the 8 colors a 3bpp sprite can use');
  check(/Imp/.test(opened.label),'labelled with the monsters that use it: '+opened.label);

  // a boss pool: Odin (record 188) - pool object, no fixed size, 3bpp
  const boss=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphicsProperties.item(188).graphicsPointer.target;
      romNavigator.selectObject(obj);
      propertyList.select(obj);
      const view=propertyList.activeEditor;
      return {i:obj.i,fmt:obj.format,w:obj.width||0,len:obj.data.length,
              view:view&&view.constructor.name,shown:!!(view&&view.object===obj),
              label:rom.stringTable['monsterGraphics'].string[obj.i].value};
  })()`);
  console.log('  boss pool:',JSON.stringify(boss));
  check(boss.view==='ROMGraphicsView'&&boss.shown,'boss pool opens in the graphics view');
  check(boss.fmt==='snes3bpp','Odin pool decoded as snes3bpp');
  check(/Odin/.test(boss.label),'pool labelled with its bosses: '+boss.label);

  // Zeromus: the only 4bpp graphics - palette must compose p + p+1 (16 colors)
  const zeromus=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphicsProperties.item(201).graphicsPointer.target;
      romNavigator.selectObject(obj);
      propertyList.select(obj);
      const view=propertyList.activeEditor;
      return {fmt:obj.format, palCount:view.paletteView.palette.length,
              composed:Array.isArray(obj.palette)&&obj.palette[0].compose===true,
              label:rom.stringTable['monsterGraphics'].string[obj.i].value};
  })()`);
  console.log('  zeromus:',JSON.stringify(zeromus));
  check(zeromus.fmt==='snes4bpp','Zeromus decoded as snes4bpp (bit 15 clear)');
  check(zeromus.palCount===16&&zeromus.composed,'4bpp palette composed from p + p+1 (16 colors)');

  // paint a pixel through the view, verify it lands in the object and undo
  // restores the exact ROM bytes
  const paint=await ev(c,sessionId,`(()=>{
      const orig=Uint8Array.from(rom.data);
      const obj=rom.monsterGraphicsProperties.item(0).graphicsPointer.target;
      romNavigator.selectObject(obj);
      propertyList.select(obj);
      const view=propertyList.activeEditor;
      rom.beginAction();
      view.paintStart = view.graphics.slice();
      view.color = 3;
      view.paintPixel(4, 4);
      view.commitPaint();
      rom.endAction();
      const painted = obj.data[4*8+4];
      while(rom.undoStack.length){ rom.undo(); }
      rom.assemble();
      let diffs=0;
      for(let i=0;i<orig.length;i++) if(rom.data[i]!==orig[i]) diffs++;
      return {painted, diffs};
  })()`);
  console.log('  paint:',JSON.stringify(paint));
  check(paint.painted===3,'pencil paints palette index 3 into the Imp tile');
  check(paint.diffs===0,'undo restores the ROM byte-for-byte after painting');

  // battle editor: open a boss battle, then the VRAM loader path
  const battle=await ev(c,sessionId,`(()=>{
      const bps=rom.battleProperties; let b=-1;
      for(let i=0;i<bps.arrayLength;i++){ const r=bps.item(i);
          if(r.monster1.value===162||r.monster1.value===188){ b=i; break; } }
      if(b<0) return {err:'no boss battle found'};
      propertyList.select(bps.item(b));
      const view=propertyList.activeEditor;
      return {b, view:view&&view.constructor.name};
  })()`);
  console.log('  battle:',JSON.stringify(battle));
  check(!battle.err&&battle.view==='FF4Battle','battle editor opens a boss battle (battle '+battle.b+')');
  const vram=await ev(c,sessionId,`(()=>{
      const view=propertyList.activeEditor;
      if(!view||!view.vram) return {err:'no vram toolbox'};
      view.showVRAM=true; view.vram.loadVRAM();
      const slot=view.vram.vramSlots[0];
      return {graphics:slot.graphics?slot.graphics.length:0, palette:slot.palette?slot.palette.length:0};
  })()`);
  console.log('  vram:',JSON.stringify(vram));
  check(!vram.err&&vram.graphics>0&&vram.palette===16,'battle VRAM loads boss graphics through the pointer target');

  // character graphics (already editable before) must still open fine
  const charg=await ev(c,sessionId,`(()=>{
      const obj=rom.characterGraphics.item(0);
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      return {view:view&&view.constructor.name, w:obj.width, h:obj.height};
  })()`);
  check(charg.view==='ROMGraphicsView'&&charg.w===14,'character graphics still editable (14x6 sprite sheet)');

  console.log(fails?`${fails} FAILURES`:'all FF4 browser checks passed');
  process.exitCode=fails?1:0;
 } finally { ch.kill(); srv.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
