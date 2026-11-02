// Is graphics import broken upstream too? Test on battleCharacterGraphics,
// a node that the stock definition already exposes.
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const ROM=path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba');
const PORT=8322, CDP_PORT=9224;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class CDP{constructor(ws){this.ws=ws;this.id=0;this.h=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.h.has(m.id)){const{res,rej}=this.h.get(m.id);this.h.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};}
 send(method,params={},sessionId){return new Promise((res,rej)=>{const id=++this.id;this.h.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params,sessionId}));});}}
const ev=async(c,s,e)=>{const r=await c.send('Runtime.evaluate',{expression:e,returnByValue:true},s);if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails.exception?.description||r.exceptionDetails));return r.result.value;};

(async()=>{
  const server=spawn('python3',['-m','http.server',String(PORT),'--dir',ROOT],{stdio:'ignore'});
  const chrome=spawn('google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=${CDP_PORT}`,'about:blank'],{stdio:'ignore'});
  try{
    await sleep(2500);
    const v=await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const ws=new WebSocket(v.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener('open',r));
    const c=new CDP(ws);
    const {targetId}=await c.send('Target.createTarget',{url:`http://127.0.0.1:${PORT}/ff6tools.html`});
    const {sessionId}=await c.send('Target.attachToTarget',{targetId,flatten:true});
    await c.send('Runtime.enable',{},sessionId); await sleep(2500);
    const o=await c.send('Runtime.evaluate',{expression:"document.getElementById('rom-file')",objectGroup:'t'},sessionId);
    await c.send('DOM.setFileInputFiles',{files:[ROM],objectId:o.result.objectId},sessionId);
    await sleep(3000);
    await ev(c,sessionId,`(()=>{const li=[...document.querySelectorAll('.modal-list li')].find(x=>/FF V Advance \\(E\\)|Final Fantasy V Advance \\(E\\)/.test(x.textContent));li&&li.click();return !!li;})()`);
    await sleep(4000);

    for(const node of ['battleCharacterGraphics','monsterGraphics']){
      const r=await ev(c,sessionId,`(() => {
        const NODE=${JSON.stringify(node)};
        const arr=rom[NODE];
        // edit through the pointer record (the stable handle; array indices are
        // de-duplicated and re-sorted when blocks relocate)
        const obj=rom.monsterGraphicsProperties.item(4).graphicsPointer.target;
        propertyList.select(obj);
        const v=propertyList.getEditor('ROMGraphicsView');
        const before=Uint8Array.from(v.graphics);
        const mod=Uint8Array.from(before); for(let i=0;i<mod.length;i++) mod[i]=(mod[i]+1)%16;
        v.importGraphics(mod);
        const aliased = v.graphics===obj.data;
        const origBytes=Array.from(rom.data);
        let ok=rom.assemble();
        let changed=0;
        for(let i=0;i<origBytes.length;i++) if(origBytes[i]!==rom.data[i]) changed++;
        // if the re-encoded block no longer fits, use the app's expand flow
        if(!ok){ rom.expandMode=ROMData.ExpandMode.relocate; ok=rom.assemble(); }
        const saved=Uint8Array.from(rom.data);
        changed=0; for(let i=0;i<origBytes.length;i++) if(origBytes[i]!==saved[i]) changed++;
        // reload and confirm the edit is really there
        const r2=ROMObject.create(null,JSON.parse(JSON.stringify(definition)));
        r2.disassemble(new Uint8Array(saved));
        const o2=r2.monsterGraphicsProperties.item(4).graphicsPointer.target;
        return {aliased, ok, bytesChanged: changed,
                reloadedFirst:Array.from(o2.data.slice(0,8)), expected:Array.from(mod.slice(0,8))};
      })()`);
      console.log(node, JSON.stringify(r));
    }
    ws.close();
  } finally { chrome.kill(); server.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
