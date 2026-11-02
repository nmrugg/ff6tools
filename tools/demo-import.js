// Drives the real app UI: load ROM -> select a monster's graphics -> click the
// Import icon -> choose our edited PNG -> click Import -> save the ROM to disk.
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const ROM=path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba');
const PNG=process.argv[2]||'/tmp/ff5e-demo/edited.gba.png';
const OUT=process.argv[3]||'/tmp/ff5e-demo/edited.gba';
const GID=Number(process.argv[4]||11);          // graphics id (Magic Pot)
const PORT=8331, CDP_PORT=9231;
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

    // load the ROM and pick the FF5E definition
    const o=await c.send('Runtime.evaluate',{expression:"document.getElementById('rom-file')",objectGroup:'t'},sessionId);
    await c.send('DOM.setFileInputFiles',{files:[ROM],objectId:o.result.objectId},sessionId);
    await sleep(3000);
    console.log('modal:',await ev(c,sessionId,`(()=>({
        display:getComputedStyle(document.getElementById('modal')).display,
        title:document.getElementById('modal-title').textContent,
        items:[...document.querySelectorAll('.modal-list li')].map(x=>x.textContent).slice(0,30)
    }))()`));
    await ev(c,sessionId,`(()=>{const li=[...document.querySelectorAll('.modal-list li')].find(x=>/Final Fantasy V Advance \\(E\\)/.test(x.textContent));li.click();return 1;})()`);
    await sleep(4000);

    // select the monster's graphics object, exactly as clicking it in the tree does
    console.log('selected:',await ev(c,sessionId,`(()=>{
        const o=rom.monsterGraphicsProperties.item(${GID}).graphicsPointer.target;
        propertyList.select(o);
        const v=propertyList.getEditor('ROMGraphicsView');
        return {label:o.labelString, w:o.width, h:o.height, palette:o.palette};
    })()`));
    await sleep(1000);

    // click the Import icon on the "Monster Graphics" heading
    console.log('import dialog:',await ev(c,sessionId,`(()=>{
        const btns=[...document.querySelectorAll('.property-heading-button')];
        const up=btns.find(b=>b.classList.contains('fa-upload'));
        if(!up) return 'no import button; icons='+btns.map(b=>b.className).join(',');
        up.click();
        return {modalTitle:document.getElementById('modal-title').textContent,
                fileInput:!!document.querySelector('#modal-content input[type=file]'),
                okay:!!document.getElementById('import-okay'),
                formats:[...document.querySelectorAll('#import-format-list option')].map(o=>o.textContent)};
    })()`));
    await sleep(800);

    // feed our edited PNG into the dialog's file input
    const fi=await c.send('Runtime.evaluate',{expression:"document.querySelector('#modal-content input[type=file]')",objectGroup:'t'},sessionId);
    await c.send('DOM.setFileInputFiles',{files:[PNG],objectId:fi.result.objectId},sessionId);
    await sleep(2000);
    fs.writeFileSync('/tmp/ff5e-demo/import-dialog.png',
      Buffer.from((await c.send('Page.captureScreenshot',{format:'png'},sessionId)).data,'base64'));

    // press "Import"
    console.log('after Import click:',await ev(c,sessionId,`(()=>{
        const b=document.getElementById('import-okay');
        if(!b) return 'no import button';
        if(b.disabled) return 'button still disabled';
        b.click();
        const o=rom.monsterGraphicsProperties.item(${GID}).graphicsPointer.target;
        return {dirty:o.isDirty, firstPixels:Array.from(o.data.slice(0,8))};
    })()`));
    await sleep(1200);

    // save: assemble and write the patched ROM
    const saved=await ev(c,sessionId,`(()=>{
        let ok=rom.assemble();
        if(!ok){ rom.expandMode=ROMData.ExpandMode.relocate; ok=rom.assemble(); }
        return {ok, bytes:Array.from(rom.data)};
    })()`);
    fs.writeFileSync(OUT,Buffer.from(saved.bytes));
    console.log('saved:',OUT,'assemble ok:',saved.ok,'size:',saved.bytes.length);
    ws.close();
  } finally { chrome.kill(); server.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
