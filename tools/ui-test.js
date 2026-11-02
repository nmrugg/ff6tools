// End-to-end test: load the real ff6tools app in headless Chrome, open the
// user's ROM (CRC mismatch -> pick the FF5E definition), then select monster
// graphics and screenshot the result.
//   node tools/ui-test.js
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const ROM=path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba');
const PORT=8321, CDP_PORT=9223;

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// ---- tiny CDP client over the global WebSocket ----
class CDP{
  constructor(ws){this.ws=ws;this.id=0;this.handlers=new Map();
    ws.onmessage=e=>{const m=JSON.parse(e.data);
      if(m.id&&this.handlers.has(m.id)){const {res,rej}=this.handlers.get(m.id);this.handlers.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}
      else if(m.method&&this.onEvent)this.onEvent(m);};}
  send(method,params={},sessionId){return new Promise((res,rej)=>{const id=++this.id;this.handlers.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params,sessionId}));});}
}
async function evalJS(cdp,sessionId,expr,awaitPromise=false){
  const r=await cdp.send('Runtime.evaluate',{expression:expr,returnByValue:true,awaitPromise},sessionId);
  if(r.exceptionDetails) throw new Error('page JS error: '+JSON.stringify(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||r.exceptionDetails));
  return r.result.value;
}

async function main(){
  const server=spawn('python3',['-m','http.server',String(PORT),'--dir',ROOT],{stdio:'ignore'});
  const chrome=spawn('google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`,'about:blank'],{stdio:'ignore'});
  try{
    await sleep(2500);
    const list=await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const ws=new WebSocket(list.webSocketDebuggerUrl);
    await new Promise(r=>ws.addEventListener('open',r));
    const cdp=new CDP(ws);
    const {targetId}=await cdp.send('Target.createTarget',{url:`http://127.0.0.1:${PORT}/ff6tools.html`});
    const {sessionId}=await cdp.send('Target.attachToTarget',{targetId,flatten:true});
    await cdp.send('Runtime.enable',{},sessionId);
    await cdp.send('Page.enable',{},sessionId);
    await sleep(2500);

    // 1) feed the ROM into the app's own file input
    const obj=await cdp.send('Runtime.evaluate',{expression:"document.getElementById('rom-file')",objectGroup:'t'},sessionId);
    await cdp.send('DOM.setFileInputFiles',{files:[ROM],objectId:obj.result.objectId},sessionId);
    await sleep(3000);

    // 2) CRC mismatch -> the app asks which definition; pick FF5E
    const picked=await evalJS(cdp,sessionId,`(() => {
        const items=[...document.querySelectorAll('#modal-list li, .modal-list li')];
        const li=items.find(x=>/Final Fantasy V Advance \\(E\\)/.test(x.textContent));
        if(!li) return 'no list item; items='+items.map(i=>i.textContent).join('|');
        li.click(); return 'clicked: '+li.textContent.trim();
    })()`);
    console.log('definition:',picked);
    await sleep(4000);

    console.log('rom loaded:',await evalJS(cdp,sessionId,'!!rom && !!rom.data'));
    console.log('monsterGraphics array length:',await evalJS(cdp,sessionId,'rom.monsterGraphics.arrayLength'));
    console.log('monsterPalettes array length:',await evalJS(cdp,sessionId,'rom.monsterPalettes.arrayLength'));
    console.log('monsterGraphicsProperties:',await evalJS(cdp,sessionId,'rom.monsterGraphicsProperties.arrayLength'));
    console.log('item 4 target:',await evalJS(cdp,sessionId,`(()=>{const p=rom.monsterGraphicsProperties.item(4);return p.graphicsPointer.target+' / '+p.palettePointer.target;})()`));

    // 3) exercise the navigator: expand Battle, click Monster Graphics
    const nav=await evalJS(cdp,sessionId,`(() => {
        const cats=[...document.querySelectorAll('.nav-category > p')];
        const battle=cats.find(p=>p.textContent.trim()==='Battle');
        if(!battle) return 'categories: '+cats.map(c=>c.textContent).join(',');
        battle.click();
        const items=[...document.querySelectorAll('.nav-array > p, .nav-object > p')];
        const mg=items.find(p=>p.textContent.trim()==='Monster Graphics');
        if(!mg) return 'opened Battle; nodes: '+items.map(i=>i.textContent).slice(0,40).join(' | ');
        mg.click();
        return 'Monster Graphics node: '+mg.closest('.nav-array').querySelectorAll('li').length+' children';
    })()`);
    console.log('navigator:',nav);
    await sleep(1500);

    // 4) select a specific monster's graphics through the property list (same as clicking it)
    const sel=await evalJS(cdp,sessionId,`(() => {
        const o=rom.monsterGraphics.item(4);
        propertyList.select(o);
        const v=propertyList.getEditor('ROMGraphicsView');
        return {object:o.path+'[4]', w:v.width, h:v.height, tiles:v.graphics?v.graphics.length:0,
                paletteColors:v.paletteView.palette?v.paletteView.palette.length:0};
    })()`);
    console.log('graphics view:',JSON.stringify(sel));
    await sleep(1200);

    // 5) the battle editor must still draw monsters
    const battleOK=await evalJS(cdp,sessionId,`(() => {
        const b=rom.battleProperties.item(0);
        propertyList.select(b);
        const e=propertyList.editors['FF5Battle'];
        return e? {slots:e.monsterSlots?e.monsterSlots.length:'n/a'} : 'no FF5Battle editor';
    })()`);
    console.log('battle editor:',JSON.stringify(battleOK));
    await sleep(1200);

    // 6) import through the view's own import path, then save + reload
    const imp=await evalJS(cdp,sessionId,`(() => {
        const v=propertyList.getEditor('ROMGraphicsView');
        const before=Uint8Array.from(v.graphics);
        const modified=Uint8Array.from(before);
        for(let i=0;i<modified.length;i++) modified[i]=(modified[i]+1)%16;   // shift every pixel's palette index
        v.importGraphics(modified);
        const ok=rom.assemble();
        const saved=Array.from(rom.data.slice(0,0x300000));
        return {ok, changedPixels: modified.filter((v2,i)=>v2!==before[i]).length, savedLen: saved.length};
    })()`);
    console.log('import+assemble:',JSON.stringify(imp));

    // reload the saved bytes and confirm the edit is really in the file
    const reload=await evalJS(cdp,sessionId,`(() => {
        const def2=JSON.parse(JSON.stringify(definition));
        const r2=ROMObject.create(null,def2);
        r2.disassemble(new Uint8Array(rom.data));
        const o=r2.monsterGraphics.item(4);
        const v=propertyList.getEditor('ROMGraphicsView');
        propertyList.select(o);
        return {w:o.width,h:o.height,firstPixels:Array.from(o.data.slice(0,8)),
                palette0:r2.monsterPalettes.item(0).data[0]>>>0};
    })()`);
    console.log('after reload:',JSON.stringify(reload));

    // 7) the Monster Palettes node should also open
    const palNode=await evalJS(cdp,sessionId,`(() => {
        const items=[...document.querySelectorAll('.nav-array > p')];
        const p=items.find(x=>x.textContent.trim()==='Monster Palettes');
        if(!p) return 'Monster Palettes node missing';
        p.click();
        return 'Monster Palettes children: '+p.closest('.nav-array').querySelectorAll('li').length;
    })()`);
    console.log('palettes node:',palNode);

    fs.writeFileSync(path.join(ROOT,'ui-test-screenshot.png'),
      Buffer.from((await cdp.send('Page.captureScreenshot',{format:'png'},sessionId)).data,'base64'));
    console.log('wrote ui-test-screenshot.png');
    ws.close();
  } finally { chrome.kill(); server.kill(); }
}
main().catch(e=>{console.error('FAIL:',e.message);process.exit(1);});
