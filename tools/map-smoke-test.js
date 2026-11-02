// Map editor smoke test: the tilemap editor still works after adding the
// graphics-tool controls to its control bar.
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const ROM=path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It) (patched).gba');
const PORT=8451, CDP=9351;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class C{constructor(w){this.w=w;this.i=0;this.h=new Map();w.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.h.has(m.id)){const{res,rej}=this.h.get(m.id);this.h.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};}
 s(x,p={},sid){return new Promise((res,rej)=>{const id=++this.i;this.h.set(id,{res,rej});this.w.send(JSON.stringify({id,method:x,params:p,sessionId:sid}));});}}
const ev=async(c,sid,e)=>{const r=await c.s('Runtime.evaluate',{expression:e,returnByValue:true},sid);if(r.exceptionDetails)throw new Error(String(r.exceptionDetails.exception?.description));return r.result.value;};
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
  await c.s('DOM.setFileInputFiles',{files:[ROM],objectId:o.result.objectId},sessionId); await sleep(4000);
  console.log('auto-detected (no dialog needed):', await ev(c,sessionId,'!!rom'));

  console.log('map editor:',await ev(c,sessionId,`(()=>{
      propertyList.select(rom.mapProperties.item(32));
      const m=propertyList.getEditor('FF5Map');
      const tm=propertyList.getEditor('ROMTilemapView');
      const cv=m.canvas||null;
      return JSON.stringify({mapActive:propertyList.activeEditor&&propertyList.activeEditor.name,
        mapCanvas:cv?cv.width+'x'+cv.height:'none',
        tilemapCanvas:tm.canvas.width+'x'+tm.canvas.height,
        toolMenu:!!document.getElementById('changeTool'),
        boundsToggle:!!document.getElementById('graphics-show-bounds'),
        layoutTiles:tm.tilemap?tm.tilemap.length:0});})()`));

  console.log('tileset toolbox still auto-fits:',await ev(c,sessionId,`(()=>{
      propertyList.select(rom.mapTilesets.item(0));
      const gv=propertyList.getEditor('ROMTilemapView').graphicsView;
      return 'zoom='+gv.zoom.toFixed(2)+' userZoom='+gv.userZoom+' canvas='+gv.canvas.width+'x'+gv.canvas.height;})()`));

  // map editing itself is untouched by these changes: FF5's map editor uses its
  // own FF5MapTileset toolbox class, not a ROMGraphicsView
  console.log('map editor toolbox class:',await ev(c,sessionId,`(()=>{
      propertyList.select(rom.mapProperties.item(32));
      const m=propertyList.getEditor('FF5Map');
      const ts=m.tileset||m.mapTileset||null;
      return ts?ts.constructor.name:'(not exposed)';})()`));
  ws.close();
 } finally { ch.kill(); srv.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
