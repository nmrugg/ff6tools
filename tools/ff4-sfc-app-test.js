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

  // a boss pool: Odin (record 188) - raw pool object, no fixed size, 3bpp
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

  // the assembled boss window: bossGraphics_42 (Odin) shows the creature
  const win=await ev(c,sessionId,`(()=>{
      const w=rom.parsePath('bossGraphics_42');
      romNavigator.selectObject(w);
      propertyList.select(w);
      const view=propertyList.activeEditor;
      const pool=rom.parsePath(w.window.path);
      return {view:view&&view.constructor.name,shown:!!(view&&view.object===w),
              w:w.width,h:w.height,layout:w.layout?w.layout.length:0,
              data:w.data?w.data.length:0,poolPath:w.window.path,
              poolData:pool.data?pool.data.length:0,
              name:w.name, pal:w.palette[0].path};
  })()`);
  console.log('  boss window:',JSON.stringify(win));
  check(win.view==='ROMGraphicsView'&&win.shown,'assembled boss window opens in the graphics view');
  check(win.w===8&&win.h===10&&win.layout===80,'Odin window is 8x10 tiles with an 80-cell layout');
  check(win.data>0&&win.poolData>0,'the window reads its tiles from the pool item');
  check(/Odin/.test(win.name)&&win.pal==='monsterPalette[188]','named and pinned to the boss palette: '+win.name);

  // paint through the window: the write must land in the pool item
  const winPaint=await ev(c,sessionId,`(()=>{
      const orig=Uint8Array.from(rom.data);
      const w=rom.parsePath('bossGraphics_42');
      const pool=rom.parsePath(w.window.path);
      romNavigator.selectObject(w); propertyList.select(w);
      const view=propertyList.activeEditor;
      view.paintStart=view.graphics.slice();
      view.color=5;
      // first non-empty layout cell
      let cell=w.layout.findIndex(t=>t>=0);
      view.paintPixel((cell%w.width)*8+3, Math.floor(cell/w.width)*8+3);
      view.commitPaint();
      const idx=w.layout[cell];
      const landed=pool.data[idx*64+3*8+3];
      while(rom.undoStack.length) rom.undo();
      rom.assemble();
      let diffs=0;
      for(let i=0;i<orig.length;i++) if(rom.data[i]!==orig[i]) diffs++;
      return {landed, diffs};
  })()`);
  console.log('  window paint:',JSON.stringify(winPaint));
  check(winPaint.landed===5,'painting the boss window writes through to the pool item');
  check(winPaint.diffs===0,'undo of a window paint restores the ROM byte-for-byte');

  // Zeromus: the only 4bpp graphics - palette must compose p + p+1 (16 colors)
  const zeromus=await ev(c,sessionId,`(()=>{
      const obj=rom.monsterGraphicsProperties.item(201).graphicsPointer.target;
      romNavigator.selectObject(obj);
      propertyList.select(obj);
      const view=propertyList.activeEditor;
      return {fmt:obj.format, palCount:view.paletteView.palette.length,
              composed:Array.isArray(obj.palette)&&Array.isArray(obj.palette[0])&&
                       obj.palette[0].every(d=>d.compose),
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

  // character graphics (including portraits) must update the palette panel
  // to the palette of the selected item, not always palette 0
  const charg=await ev(c,sessionId,`(()=>{
      const out={};
      for (const [arr,i] of [['characterGraphics',5],['portraitGraphics',7]]) {
          const obj=rom[arr].item(i);
          romNavigator.selectObject(obj); propertyList.select(obj);
          const view=propertyList.activeEditor;
          out[arr]={def:JSON.stringify(obj.palette).slice(0,60),
                    shown:Array.from(view.paletteView.palette.slice(0,3)).map(x=>x.toString(16)),
                    expected:Array.from(rom[arr==='characterGraphics'?'characterPalette':'portraitPalette'].item(i).data.slice(0,3)).map(x=>x.toString(16))};
      }
      return out;
  })()`);
  console.log('  char/portrait palettes:',JSON.stringify(charg));
  check(charg.characterGraphics.shown.join()===charg.characterGraphics.expected.join(),
        'character graphics #5 shows its own palette (Rosa), not palette 0');
  check(charg.portraitGraphics.shown.join()===charg.portraitGraphics.expected.join(),
        'portrait #7 shows its own palette (Palom)');

  // Pig/Small/Toad reuse the affected character's palette - they must offer
  // the palette array rather than show nothing
  const pig=await ev(c,sessionId,`(()=>{
      const obj=rom.characterGraphics.item(14);
      romNavigator.selectObject(obj); propertyList.select(obj);
      const view=propertyList.activeEditor;
      const p16=rom.portraitGraphics.item(16);
      return {pigPal:view.paletteView.palette.length,
              pigNamed:Array.isArray(obj.palette)&&
                       obj.palette.some(d=>/Kain palette \\(reused\\)/.test((d&&d.name)||''))&&
                       obj.palette.some(d=>/Rosa palette \\(reused\\)/.test((d&&d.name)||'')),
              toadPin:Array.isArray(p16.palette)&&
                       p16.palette.some(d=>/palom palette \\(reused\\)/i.test((d&&d.name)||''))};
  })()`);
  console.log('  pig/toad palettes:',JSON.stringify(pig));
  check(pig.pigPal===16&&pig.pigNamed,'Pig character graphics list every character palette by name ("Kain palette (reused)" etc.)');
  check(pig.toadPin,'Toad portrait offers the portrait palettes');

  // Summons section: Chocobo/Shiva/Ramuh/Ifrit/Sylph must exist and be paintable
  const sum=await ev(c,sessionId,`(()=>{
      const sec=(rom.hierarchy||[]).find(s=>s.name==='Summons');
      if(!sec) return {err:'no Summons section'};
      const names=sec.list.map(i=>i.name);
      const choco=rom.parsePath('summonGraphics_Chocobo');
      romNavigator.selectObject(choco); propertyList.select(choco);
      const view=propertyList.activeEditor;
      const orig=Uint8Array.from(rom.data);
      view.paintStart=view.graphics.slice();
      view.color=2;
      view.paintPixel(1,1);
      view.commitPaint();
      rom.assemble();
      let painted=0;
      for(let i=0;i<orig.length;i++) if(rom.data[i]!==orig[i]) painted++;
      while(rom.undoStack.length) rom.undo();
      rom.assemble();
      let diffs=0;
      for(let i=0;i<orig.length;i++) if(rom.data[i]!==orig[i]) diffs++;
      return {count:names.length,
              has:['Chocobo','Shiva','Ramuh','Ifrit','Sylph'].every(n=>names.some(x=>x.includes(n))),
              painted, diffs, pal:view.paletteView.palette.length,
              canvas:{w:choco.width,h:choco.height,cells:choco.layout.length,
                      filled:choco.layout.filter(t=>t>=0).length,
                      tiles:choco.data.length/64}};
  })()`);
  console.log('  summons:',JSON.stringify(sum));
  check(!sum.err&&sum.count===15&&sum.has,'Summons section lists 15 summons incl Chocobo/Shiva/Ramuh/Ifrit/Sylph');
  check(sum.canvas.w===8&&sum.canvas.h===4&&sum.canvas.cells===32&&sum.canvas.filled===24
        &&sum.canvas.tiles===24,
        'Chocobo shows the SummonTilemap canvas (8x4 = both animation frames, all 24 tiles)');
  check(sum.painted>0,'Chocobo summon graphics paint with the pencil');
  check(sum.diffs===0,'undo of the Chocobo paint is byte-exact');

  // every Summons row is its own object (no two tree rows share a path,
  // which made the navigator highlight the wrong row)
  const indep=await ev(c,sessionId,`(()=>{
      const sec=(rom.hierarchy||[]).find(s=>s.name==='Summons');
      const paths=sec.list.map(i=>i.path);
      const uniq=new Set(paths).size===paths.length;
      const allSummon=paths.every(p=>p.startsWith('summonGraphics_'));
      const titan=rom.parsePath('summonGraphics_Titan');
      const boss=rom.parsePath('bossGraphics_2');
      return {uniq, allSummon,
              titanPool:!!(titan.window&&boss.window)&&titan.window.path===boss.window.path,
              titanCanvas:!!(titan.layout&&titan.width===14&&titan.height===8&&
                             titan.layout.length===112&&titan.window.tiles===62),
              ownLayout:JSON.stringify(titan.layout)!==JSON.stringify(boss.layout),
              distinct:titan!==boss};
  })()`);
  console.log('  summon independence:',JSON.stringify(indep));
  check(indep.uniq&&indep.allSummon,'every Summons row is a distinct summonGraphics_* object (no shared tree rows)');
  check(indep.titanPool&&indep.titanCanvas&&indep.distinct,
        'Titan summon is its own window onto the boss pool, arranged by the SummonTilemap (14x8, 62 tiles)');
  check(indep.ownLayout,'the Titan summon canvas is the Esper cutscene placement, not the battle map');

  // boss pools are hidden from the Monster Graphics tree; the assembled
  // Mom Bomb shows her full 60-tile sheet
  const hid=await ev(c,sessionId,`(()=>{
      const cats=[...document.querySelectorAll('.nav-list > .nav-category > p')];
      const mc=cats.find(p=>p.textContent.trim()==='Monster');
      if(mc) mc.click();
      const ul=romNavigator.node['monsterGraphics'];
      const shown=ul?ul.querySelectorAll('li').length:-1;
      const mom=rom.parsePath('bossGraphics_36');
      return {shown, hidden:(rom.monsterGraphics.hiddenItems||[]).length,
              momTiles:mom.window.tiles, momW:mom.width, momData:mom.data.length,
              momBlanks:mom.layout.map((t,i)=>t<0?i:-1).filter(i=>i>=0)};
  })()`);
  console.log('  hidden/mombomb:',JSON.stringify(hid));
  check(hid.shown===66,'Monster Graphics tree shows only the 66 monster-owned objects (24 boss pools hidden)');
  check(hid.momTiles===60&&hid.momData===3840,'Mom Bomb window shows her full 60-tile art (the US map only places a 4x4 crop)');
  check(hid.momBlanks.join()==='0,59,60,69,77,78,79,85,86,87,88,89',
        'Mom Bomb sheet has exactly the 12 empty cells of the ripped art (blank at row 6 col 0, not col 8)');

  // Attack Graphics must be directly editable
  const atk=await ev(c,sessionId,`(()=>{
      const g=rom.parsePath('attackGraphics');
      romNavigator.selectObject(g); propertyList.select(g);
      const view=propertyList.activeEditor;
      const orig=Uint8Array.from(rom.data);
      view.paintStart=view.graphics.slice();
      view.color=3;
      view.paintPixel(2,2);
      view.commitPaint();
      const landed=g.data[2*8+2];
      while(rom.undoStack.length) rom.undo();
      rom.assemble();
      let diffs=0;
      for(let i=0;i<orig.length;i++) if(rom.data[i]!==orig[i]) diffs++;
      return {view:view&&view.constructor.name, landed, diffs};
  })()`);
  console.log('  attack graphics:',JSON.stringify(atk));
  check(atk.view==='ROMGraphicsView'&&atk.landed===3,'Attack Graphics opens as paintable graphics (pencil)');
  check(atk.diffs===0,'undo of an attack graphics paint is byte-exact');

  console.log(fails?`${fails} FAILURES`:'all FF4 browser checks passed');
  process.exitCode=fails?1:0;
 } finally { ch.kill(); srv.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
