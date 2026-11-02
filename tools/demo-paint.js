// Drive the new painting tools through the real UI: select a monster, choose
// Pencil / Fill, send mouse events to the canvas, then save and verify.
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const ROM=path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba');
const OUT=process.argv[2]||'/tmp/ff5e-demo/painted.gba';
const GID=Number(process.argv[3]||11);
const PORT=8341, CDP_PORT=9241;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class CDP{constructor(ws){this.ws=ws;this.id=0;this.h=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.h.has(m.id)){const{res,rej}=this.h.get(m.id);this.h.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};}
 send(method,params={},sessionId){return new Promise((res,rej)=>{const id=++this.id;this.h.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params,sessionId}));});}}
const ev=async(c,s,e)=>{const r=await c.send('Runtime.evaluate',{expression:e,returnByValue:true},s);if(r.exceptionDetails)throw new Error(String(r.exceptionDetails.exception?.description||r.exceptionDetails.message));return r.result.value;};

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
    await c.send('Runtime.enable',{},sessionId); await c.send('Page.enable',{},sessionId); await sleep(2500);
    const o=await c.send('Runtime.evaluate',{expression:"document.getElementById('rom-file')",objectGroup:'t'},sessionId);
    await c.send('DOM.setFileInputFiles',{files:[ROM],objectId:o.result.objectId},sessionId);
    await sleep(3000);
    await ev(c,sessionId,`(()=>{[...document.querySelectorAll('.modal-list li')].find(x=>/Final Fantasy V Advance \\(E\\)/.test(x.textContent)).click();return 1;})()`);
    await sleep(4000);

    // select the monster's graphics and zoom in
    console.log('selected:',await ev(c,sessionId,`(()=>{
        const o=rom.monsterGraphicsProperties.item(${GID}).graphicsPointer.target;
        propertyList.select(o);
        const v=propertyList.getEditor('ROMGraphicsView');
        v.zoom=6; v.resize(); v.redraw();
        return {label:String(o.labelString), grid:v.width+'x'+v.height, tool:v.tool};
    })()`));
    await sleep(600);

    // helper: dispatch mouse events with explicit offsetX/offsetY (own props,
    // since offsetX is a read-only accessor on MouseEvent.prototype)
    async function clickPixel(px,py){
      return await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        const mk=(type)=>{
          const e=new MouseEvent(type,{bubbles:true,cancelable:true});
          Object.defineProperty(e,'offsetX',{value:${px}*v.zoom});
          Object.defineProperty(e,'offsetY',{value:${py}*v.zoom});
          return e;
        };
        v.canvas.dispatchEvent(mk('mousedown'));
        v.canvas.dispatchEvent(mk('mouseup'));
        return {tool:v.tool,color:v.color};
      })()`);
    }
    async function setTool(t,color){ await ev(c,sessionId,`(()=>{const v=propertyList.getEditor('ROMGraphicsView');v.tool=${t};v.color=${color};return 1;})()`); }
    const stats=()=>ev(c,sessionId,`(()=>{const o=rom.monsterGraphicsProperties.item(${GID}).graphicsPointer.target;
        const h=Array.from(o.data).reduce((a,x)=>(a[x]=(a[x]||0)+1,a),{});
        return Object.keys(h).map(k=>k+':'+h[k]).join(' ');})()`);

    console.log('before:',await stats());

    // FILL: flood a large flat region (the transparent background) with colour 5
    await setTool(2,5);
    await clickPixel(2,2);
    console.log('after fill:',await stats());

    // PENCIL: draw a stripe of colour 12
    await setTool(1,12);
    for(let i=0;i<10;i++) await clickPixel(10+i,6);
    console.log('after pencil:',await stats());

    // COLOUR PICKER
    await setTool(3,0);
    await clickPixel(16,20);
    console.log('picked colour:',await ev(c,sessionId,`propertyList.getEditor('ROMGraphicsView').color`));

    fs.writeFileSync('/tmp/ff5e-demo/painted-ui.png',
      Buffer.from((await c.send('Page.captureScreenshot',{format:'png'},sessionId)).data,'base64'));

    const hist=(o)=>`(()=>{const h=Array.from(${o}.data).reduce((a,x)=>(a[x]=(a[x]||0)+1,a),{});return Object.keys(h).map(k=>k+':'+h[k]).join(' ');})()`;

    // save
    const saved=await ev(c,sessionId,`(()=>{
        let ok=rom.assemble();
        if(!ok){ rom.expandMode=ROMData.ExpandMode.relocate; ok=rom.assemble(); }
        return {ok,bytes:Array.from(rom.data)};
    })()`);
    fs.writeFileSync(OUT,Buffer.from(saved.bytes));
    console.log('saved',OUT,'assemble ok:',saved.ok);

    // reload the saved bytes and confirm the edits are in the file
    console.log('reloaded:',await ev(c,sessionId,`(()=>{
        const r2=ROMObject.create(null,JSON.parse(JSON.stringify(definition)));
        r2.disassemble(new Uint8Array(rom.data));
        return ${hist('r2.monsterGraphicsProperties.item('+GID+').graphicsPointer.target')};
    })()`));

    // undo everything and re-save: must return to the original bytes
    await ev(c,sessionId,`(()=>{for(let i=0;i<40;i++) rom.undo(); return 1;})()`);
    await ev(c,sessionId,`(()=>{let ok=rom.assemble(); if(!ok){rom.expandMode=ROMData.ExpandMode.relocate; rom.assemble();} return 1;})()`);
    fs.writeFileSync('/tmp/ff5e-demo/undone.gba',Buffer.from(await ev(c,sessionId,'Array.from(rom.data)')));
    console.log('after undo:',await ev(c,sessionId,`(()=>{
        const r3=ROMObject.create(null,JSON.parse(JSON.stringify(definition)));
        r3.disassemble(new Uint8Array(rom.data));
        return ${hist('r3.monsterGraphicsProperties.item('+GID+').graphicsPointer.target')};
    })()`));
    console.log('undo diagnostics:',await ev(c,sessionId,`(()=>{
        const o=rom.monsterGraphicsProperties.item(${GID}).graphicsPointer.target;
        return 'pristineMatch='+compareTypedArrays(o.data,o.pristineCache.decoded)+
               ' range='+o.range.toString()+' pristineRange='+o.pristineCache.range.toString()+
               ' dataLen='+o.data.length+' pristineEnc='+o.pristineCache.encoded.length+
               ' lazyNull='+(o.lazyData===null);
    })()`));
    ws.close();
  } finally { chrome.kill(); server.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
