// Capture the FF3 (J) battle graphics editors for eyeballing.
//   node tools/ff3-nes-shots.js [path ...]
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const ROM=path.join(ROOT, process.env.FF3J_ROM||'Final Fantasy III (Japan) (fixed).nes');
const PORT=8472, CDP=9372;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class C{constructor(w){this.w=w;this.i=0;this.h=new Map();w.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.h.has(m.id)){const{res,rej}=this.h.get(m.id);this.h.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};}
 s(x,p={},sid){return new Promise((res,rej)=>{const id=++this.i;this.h.set(id,{res,rej});this.w.send(JSON.stringify({id,method:x,params:p,sessionId:sid}));});}}
const ev=async(c,sid,e)=>{const r=await c.s('Runtime.evaluate',{expression:e,returnByValue:true},sid);if(r.exceptionDetails)throw new Error(String(r.exceptionDetails.exception?.description||r.exceptionDetails.text));return r.result.value;};
(async()=>{
 const args=process.argv.slice(2);
 const targets=args.length?args:['monsterGraphics6x6[3]','battleCharacterGraphics[0]','monsterGraphicsProperties[0x7A]','battlePalettes[1]','monsterGraphics12x6[0]'];
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
  for(const p of targets){
   const info=await ev(c,sessionId,`(()=>{
      const obj=rom.parsePath(${JSON.stringify(p)});
      if(!obj) return 'missing';
      romNavigator.selectObject(obj);
      propertyList.select(obj);
      const v=propertyList.activeEditor;
      return obj.constructor.name+' '+(obj.width?obj.width+'x'+obj.height+' tiles':'')+' range='+obj.range+
             ' data='+(obj.data?obj.data.length:'-')+' view='+(v?v.constructor.name:'-')+
             ' pal='+(v&&v.paletteView?v.paletteView.palette.length:'-');
   })()`);
   console.log(p,'->',info);
   await sleep(350);
   const shot=await c.s('Page.captureScreenshot',{format:'png'},sessionId);
   const out='/tmp/ff3j-'+p.replace(/[^a-z0-9]/gi,'_')+'.png';
   fs.writeFileSync(out,Buffer.from(shot.data,'base64'));
   console.log('   ',out);
  }
  ws.close();
 } finally { ch.kill(); srv.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
