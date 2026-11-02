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
  check(opened.palCount===4,'battle palette loaded as 4 colours (colour 0 = black)');

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
  const undone=await ev(c,sessionId,`(()=>{ rom.undo(); rom.assemble();
      const ref=new Uint8Array(window.__orig||[]); return rom.undoStack.length; })()`);
  check(undone===0,'undo stack empty after undo');

  await c.s('Page.captureScreenshot',{format:'png',quality:90},sessionId).then(r=>fs.writeFileSync('/tmp/ff3j-app.png',Buffer.from(r.data,'base64')));
  console.log('  wrote /tmp/ff3j-app.png');
  ws.close();
 } finally { ch.kill(); srv.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
