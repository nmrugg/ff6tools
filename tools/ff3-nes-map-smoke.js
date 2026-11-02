// FF3 (NES) map/world editor smoke test: opening maps, world maps, tilesets
// and graphics objects must not throw (the definition's worldPalette assembly
// was removed, so this guards the map editor against that change).
//   node tools/ff3-nes-map-smoke.js    (FF3J_ROM=<dump> for the translation)
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';const ROM=path.join(ROOT, process.env.FF3J_ROM||'Final Fantasy III (Japan) (fixed).nes');
const PORT=8474,CDP=9374;const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class C{constructor(w){this.w=w;this.i=0;this.h=new Map();w.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.h.has(m.id)){const{res,rej}=this.h.get(m.id);this.h.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};}
 s(x,p={},sid){return new Promise((res,rej)=>{const id=++this.i;this.h.set(id,{res,rej});this.w.send(JSON.stringify({id,method:x,params:p,sessionId:sid}));});}}
const ev=async(c,sid,e)=>{const r=await c.s('Runtime.evaluate',{expression:e,returnByValue:true},sid);if(r.exceptionDetails)throw new Error(String(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result.value;};
let fails=0;const check=(c,m)=>{console.log((c?'  ok  ':'  FAIL')+' '+m);if(!c)fails++;};
(async()=>{const srv=spawn('python3',['-m','http.server',String(PORT),'--dir',ROOT],{stdio:'ignore'});
 const ch=spawn('google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--window-size=1280,800','--remote-debugging-port='+CDP,'about:blank'],{stdio:'ignore'});
 try{await sleep(2200);const info=await(await fetch('http://127.0.0.1:'+CDP+'/json/version')).json();
  const ws=new WebSocket(info.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r));const c=new C(ws);
  const {targetId}=await c.s('Target.createTarget',{url:'http://127.0.0.1:'+PORT+'/ff6tools.html'});
  const {sessionId}=await c.s('Target.attachToTarget',{targetId,flatten:true});
  await c.s('Runtime.enable',{},sessionId);await c.s('Page.enable',{},sessionId);await sleep(2500);
  await c.s('Log.enable',{},sessionId).catch(()=>{});
  const errs=[];
  c.w.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errs.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')errs.push(m.params.args.map(a=>a.value||a.description).join(' '));});
  const o=await c.s('Runtime.evaluate',{expression:"document.getElementById('rom-file')",objectGroup:'t'},sessionId);
  await c.s('DOM.setFileInputFiles',{files:[ROM],objectId:o.result.objectId},sessionId);await sleep(4000);
  for(const p of ['mapProperties[0]','mapProperties[0x116]','worldMap[3]','worldMap[2]','mapTileset[4]','mapGraphics','worldGraphics[0]']){
    const r=await ev(c,sessionId,`(()=>{try{const obj=rom.parsePath(${JSON.stringify(p)});if(!obj)return 'missing';romNavigator.selectObject(obj);propertyList.select(obj);const v=propertyList.activeEditor;return (v?v.constructor.name:'none')+' '+(v&&v.div?v.div.clientWidth+'x'+v.div.clientHeight:'');}catch(e){return 'EXCEPTION: '+e.message;}})()`);
    console.log(' ',p,'->',r);
    check(!/^EXCEPTION|^missing/.test(r),p+' opens without exception');
    await sleep(300);
  }
  await sleep(600);
  console.log('console errors:',errs.length?errs.slice(0,5):'none');
  check(errs.length===0,'no JS exceptions in the console');
  const s=await c.s('Page.captureScreenshot',{format:'png'},sessionId);
  fs.writeFileSync('/tmp/ff3j-map.png',Buffer.from(s.data,'base64'));
  ws.close();} finally{ch.kill();srv.kill();}
  console.log(fails?'\nFAILED '+fails:'\nmap editor OK');process.exit(fails?1:0);
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
