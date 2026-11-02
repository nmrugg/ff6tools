// Tests for the new editing behaviour.
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const ROM=path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba');
const PORT=8401, CDP_PORT=9301;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
class CDP{constructor(ws){this.ws=ws;this.id=0;this.h=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&this.h.has(m.id)){const{res,rej}=this.h.get(m.id);this.h.delete(m.id);m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};}
 send(method,params={},sessionId){return new Promise((res,rej)=>{const id=++this.id;this.h.set(id,{res,rej});this.ws.send(JSON.stringify({id,method,params,sessionId}));});}}
const ev=async(c,s,e)=>{const r=await c.send('Runtime.evaluate',{expression:e,returnByValue:true},s);if(r.exceptionDetails)throw new Error(String(r.exceptionDetails.exception?.description||r.exceptionDetails.message));return r.result.value;};

(async()=>{
  const server=spawn('python3',['-m','http.server',String(PORT),'--dir',ROOT],{stdio:'ignore'});
  const chrome=spawn('google-chrome',['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=${CDP_PORT}`,'about:blank'],{stdio:'ignore'});
  try{
    await sleep(2200);
    const info=await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
    const ws=new WebSocket(info.webSocketDebuggerUrl); await new Promise(r=>ws.addEventListener('open',r));
    const c=new CDP(ws);
    const {targetId}=await c.send('Target.createTarget',{url:`http://127.0.0.1:${PORT}/ff6tools.html`});
    const {sessionId}=await c.send('Target.attachToTarget',{targetId,flatten:true});
    await c.send('Runtime.enable',{},sessionId); await c.send('Page.enable',{},sessionId); await sleep(2500);
    const o=await c.send('Runtime.evaluate',{expression:"document.getElementById('rom-file')",objectGroup:'t'},sessionId);
    await c.send('DOM.setFileInputFiles',{files:[ROM],objectId:o.result.objectId},sessionId);
    await sleep(3000);
    await ev(c,sessionId,`(()=>{[...document.querySelectorAll('.modal-list li')].find(x=>/Final Fantasy V Advance \\(E\\)/.test(x.textContent)).click();return 1;})()`);
    await sleep(4000);
    await ev(c,sessionId,`(()=>{propertyList.select(rom.monsterGraphics.item(11));return 1;})()`);
    await sleep(400);

    // helpers used by several checks
    await ev(c,sessionId,`window.M=(type,x,y,opts={})=>{const v=propertyList.getEditor('ROMGraphicsView');
        const e=new MouseEvent(type,Object.assign({bubbles:true,cancelable:true},opts));
        Object.defineProperty(e,'offsetX',{value:x});Object.defineProperty(e,'offsetY',{value:y});return e;};
        window.PT=(px,py)=>{const v=propertyList.getEditor('ROMGraphicsView');const r=v.canvas.getBoundingClientRect();
            return {clientX:r.left+px*v.zoom, clientY:r.top+py*v.zoom};};1`);

    console.log('1. bounds default off:',await ev(c,sessionId,'propertyList.getEditor("ROMGraphicsView").showBounds===false'));

    console.log('2. pencil resumes after leaving the canvas:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.tool=1; v.color=6; v.zoom=4; v.resize(); v.redraw();
        const o=rom.monsterGraphics.item(11);
        const before=o.data[0];
        v.canvas.dispatchEvent(M('mousedown',0,0,{button:0,buttons:1}));
        v.canvas.dispatchEvent(M('mousemove',4,0,{buttons:1}));
        // leave the image entirely, then come back
        v.canvas.dispatchEvent(M('mouseout',4,0,{buttons:1}));
        const stillPainting=v.painting;
        v.canvas.dispatchEvent(M('mousemove',0,0,{buttons:1}));
        v.canvas.dispatchEvent(M('mousemove',2,0,{buttons:1}));
        v.canvas.dispatchEvent(M('mouseup',2,0,{button:0}));
        const n=rom.monsterGraphics.item(11);
        const sixes=Array.from(n.data).slice(0,8).filter(x=>x===6).length;
        return 'stroke kept alive='+stillPainting+', pixels painted='+sixes+' (expect >=3)';})()`));

    console.log('3. middle-click pan over the image:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.zoom=8; v.resize(); v.redraw(); v.resetPan();
        const p=PT(20,20);
        v.div.dispatchEvent(new MouseEvent('mousedown',Object.assign({bubbles:true,button:1,buttons:4},p)));
        v.div.dispatchEvent(new MouseEvent('mousemove',Object.assign({bubbles:true,buttons:4},{clientX:p.clientX-30,clientY:p.clientY-20})));
        const during={x:v.panX,y:v.panY};
        v.div.dispatchEvent(new MouseEvent('mouseup',Object.assign({bubbles:true,button:1},{clientX:p.clientX-30,clientY:p.clientY-20})));
        return 'pan during='+during.x+','+during.y+' after release='+v.panX+','+v.panY+
               (v.panX===during.x&&v.panY===during.y?' STAYS':' JUMPED BACK');})()`));

    console.log('4. eyedropper cursor reflects colour:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.tool=3; v.color=1; v.updateCursor(); const a=v.canvas.style.cursor;
        v.color=9; v.updateCursor(); const b=v.canvas.style.cursor;
        return 'changes='+(a!==b && a.startsWith('url(') && b.startsWith('url('))+' tool='+v.tool;})()`));

    console.log('5. arrows cross into the next section:',await ev(c,sessionId,`(()=>{
        const cat=[...document.querySelectorAll('.nav-category > p')].find(p=>p.textContent.trim()==='Battle');
        if(!cat.parentElement.classList.contains('shown')) cat.click();
        const mg=[...document.querySelectorAll('.nav-array > p')].find(x=>x.textContent.trim()==='Monster Graphics');
        if(!mg.parentElement.classList.contains('shown')) mg.click();
        const rows=[...mg.parentElement.querySelectorAll('li.nav-object')].filter(l=>l.offsetParent!==null);
        const last=rows[rows.length-1];
        last.querySelector(':scope > p').click();
        const pane=document.getElementById('left-pane'); pane.focus();
        const k=(key)=>pane.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
        const label=()=>{const s=document.querySelector('#left-pane li.selected');return s?s.querySelector(':scope > p').textContent.trim():'(none)';};
        const from=label();
        const moved=romNavigator.moveSelection(1);
        const to=label();
        const sel=document.querySelector('#left-pane li.selected');
        const section=sel?sel.closest('.nav-array').querySelector(':scope > p').textContent.trim():'(none)';
        return from+' -> '+to+' (returned '+moved+', selectedNodes='+document.querySelectorAll('#left-pane .selected').length+
               ', node='+(romNavigator.selectedNode?romNavigator.selectedNode.textContent.trim().slice(0,24):'null')+', section='+section+')';})()`));

    console.log('6. copy / paste / move / commit:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.tool=0; v.zoom=6; v.resize(); v.redraw();
        // select tiles (0,0)-(1,1)
        v.canvas.dispatchEvent(M('mousedown',0,0,{button:0,buttons:1}));
        v.canvas.dispatchEvent(M('mousemove',15,15,{buttons:1}));
        v.canvas.dispatchEvent(M('mouseup',15,15,{button:0}));
        const sel={w:v.selection.w,h:v.selection.h};
        if(!v.copySelection()) return 'copy failed';
        const obj=rom.monsterGraphics.item(11);
        const source=Array.from(obj.data.slice(0,8));                 // first row of the copied block
        if(!v.pasteClipboard(16,0)) return 'paste failed';
        const floating=!!v.float;
        // drag the floating layer 16px to the right
        const p=PT(20,4), q=PT(36,4);
        v.canvas.dispatchEvent(new MouseEvent('mousedown',Object.assign({bubbles:true,button:0,buttons:1},p)));
        v.canvas.dispatchEvent(new MouseEvent('mousemove',Object.assign({bubbles:true,buttons:1},q)));
        v.canvas.dispatchEvent(new MouseEvent('mouseup',Object.assign({bubbles:true,button:0},q)));
        const movedFloat={x:v.float.x,y:v.float.y};
        const objB=rom.monsterGraphics.item(11);
        const clampedX=Math.max(0,Math.min(movedFloat.x, objB.width*8-v.clipboardSize.w));
        const clipRow0=Array.from(v.clipboard.slice(0,8));
        v.commitFloat();
        const obj2=rom.monsterGraphics.item(11);
        const tile=Math.floor(clampedX/8);
        const pasted=Array.from(obj2.data.slice(tile*64, tile*64+8));
        const match = JSON.stringify(pasted) === JSON.stringify(clipRow0);
        return 'clipboard='+v.clipboardSize.w+'x'+v.clipboardSize.h+'px floating='+floating+
               ' image='+objB.width+'x'+objB.height+' tiles dragTo='+movedFloat.x+
               ' clampedTo='+clampedX+' (tile '+tile+') pastedMatchesClipboard='+match;})()`));

    console.log('7. pan survives a fill / pencil commit:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        propertyList.select(rom.monsterGraphics.item(11));
        v.zoom=8; v.resize(); v.redraw(); v.resetPan();
        v.panX=17; v.panY=-9; v.applyPan();
        v.tool=2; v.color=4;
        const p=PT(4,4);
        v.canvas.dispatchEvent(new MouseEvent('mousedown',Object.assign({bubbles:true,button:0,buttons:1},p)));
        v.canvas.dispatchEvent(new MouseEvent('mouseup',Object.assign({bubbles:true,button:0},p)));
        const afterFill={x:v.panX,y:v.panY};
        v.tool=1;
        const q=PT(6,6);
        v.canvas.dispatchEvent(new MouseEvent('mousedown',Object.assign({bubbles:true,button:0,buttons:1},q)));
        v.canvas.dispatchEvent(new MouseEvent('mouseup',Object.assign({bubbles:true,button:0},q)));
        return 'after fill '+afterFill.x+','+afterFill.y+' after pencil '+v.panX+','+v.panY+
               (afterFill.x===17&&v.panX===17?' STAYS':' JUMPED');})()`));

    console.log('8. Delete clears the selection:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.tool=0; v.zoom=6; v.resize(); v.redraw();
        const before=Array.from(v.graphics.slice(0,16));
        v.selection={x:0,y:0,w:2,h:1,tilemap:new Uint32Array(2)};
        const ok=v.deleteSelection();
        const after=Array.from(rom.monsterGraphics.item(11).data.slice(0,16));
        return 'deleteSelection='+ok+' nonZeroBefore='+before.filter(x=>x).length+
               ' nonZeroAfter='+after.filter(x=>x).length;})()`));

    console.log('9. bounds dims outside the image:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.showBounds=true; v.redraw();
        const on=v.canvasDiv.classList.contains('show-bounds');
        const bgOn=getComputedStyle(v.canvasDiv).backgroundImage;
        v.showBounds=false; v.redraw();
        const off=v.canvasDiv.classList.contains('show-bounds');
        const bgOff=getComputedStyle(v.canvasDiv).backgroundImage;
        return 'on='+on+' off='+off+' | bg on: '+bgOn.slice(0,34)+' | bg off: '+bgOff.slice(0,20);})()`));

    console.log('10. map tileset toolbox left untouched (deliberate):',await ev(c,sessionId,`(()=>{
        propertyList.select(rom.mapTilesets.item(0));
        const tm=propertyList.getEditor('ROMTilemapView');
        const gv=tm.graphicsView;
        const d=gv.div.getBoundingClientRect();
        const before={zoom:gv.zoom,x:gv.panX,y:gv.panY};
        gv.div.dispatchEvent(new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true,clientX:d.left+30,clientY:d.top+30}));
        return 'toolMenu='+!!document.getElementById('changeTool')+
               ' autoFitZoom='+before.zoom.toFixed(2)+' afterWheel='+gv.zoom.toFixed(2)+
               ' (unchanged: '+(before.zoom===gv.zoom)+')';})()`));

    console.log('11. palette colour edit via double click:',await ev(c,sessionId,`(()=>{
        const pal=rom.monsterPalettes.item(0);
        propertyList.select(pal);
        const pv=propertyList.getEditor('ROMGraphicsView').paletteView;
        const obj=pv.paletteObject;
        const before=obj.data[3]>>>0;
        // point at colour index 3 (first row, 4th swatch)
        const e=new MouseEvent('dblclick',{bubbles:true,cancelable:true});
        Object.defineProperty(e,'offsetX',{value:3.5*pv.colorWidth});
        Object.defineProperty(e,'offsetY',{value:0.5*pv.colorHeight});
        pv.editColor(e);
        const input=[...document.querySelectorAll('input[type=color]')].pop();
        if(!input) return 'no colour input created';
        input.value='#302010';
        input.dispatchEvent(new Event('input'));
        const after=rom.monsterPalettes.item(0).data[3]>>>0;
        return 'before 0x'+before.toString(16)+' -> after 0x'+after.toString(16)+
               ' (want ff102030) changed='+(before!==after);})()`));

    console.log('12. arrows enter the NEXT section, not a later open one:',await ev(c,sessionId,`(()=>{
        const cat=[...document.querySelectorAll('.nav-category > p')].find(p=>p.textContent.trim()==='Battle');
        if(!cat.parentElement.classList.contains('shown')) cat.click();
        const rowsOf=(name)=>[...document.querySelectorAll('.nav-array > p')].find(x=>x.textContent.trim()===name);
        const mg=rowsOf('Monster Graphics'), mp=rowsOf('Monster Palettes'), cg=rowsOf('Battle Backgrounds');
        if(!mg||!mp||!cg) return 'sections not found: '+[!!mg,!!mp,!!cg];
        if(!mg.parentElement.classList.contains('shown')) mg.click();
        if(mp.parentElement.classList.contains('shown')) mp.click();     // close Monster Palettes
        if(!cg.parentElement.classList.contains('shown')) cg.click();    // leave a later one OPEN
        const mrows=[...mg.parentElement.querySelectorAll('li.nav-object')].filter(l=>l.offsetParent!==null);
        mrows[mrows.length-1].querySelector(':scope > p').click();
        const pane=document.getElementById('left-pane'); pane.focus();
        pane.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
        const sel=document.querySelector('#left-pane li.selected');
        const section=sel?sel.closest('.nav-array').querySelector(':scope > p').textContent.trim():'(none)';
        return 'closed Monster Palettes, left Character Graphics open -> landed in: '+section+
               ' (expect Monster Palettes); palettesNowOpen='+mp.parentElement.classList.contains('shown');})()`));

    console.log('9b. dimming is outside the image only:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        propertyList.select(rom.monsterGraphics.item(11));
        v.zoom=4; v.showBounds=true; v.resize(); v.redraw();
        const wrapBg=getComputedStyle(v.canvasWrap).backgroundColor;
        const r=v.canvas.getBoundingClientRect(), d=v.canvasDiv.getBoundingClientRect();
        const inside=getComputedStyle(v.canvasWrap).backgroundImage.includes('45deg');
        const dimOnDiv=getComputedStyle(v.canvasDiv).backgroundImage;
        return 'wrapper has gradient='+inside+' wrapperBg='+wrapBg+
               ' | pane dim layer='+dimOnDiv.slice(0,30)+' | image size '+Math.round(r.width)+'x'+Math.round(r.height)+
               ' pane '+Math.round(d.width)+'x'+Math.round(d.height);})()`));

    console.log('13. zoomed image: no scrollbars, panning works, dim stays:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        propertyList.select(rom.monsterGraphics.item(11));
        v.showBounds=true; v.zoom=16; v.resetPan(); v.resize(); v.redraw();
        const pane=v.div, cd=v.canvasDiv;
        const scrollable = pane.scrollWidth > pane.clientWidth || pane.scrollHeight > pane.clientHeight;
        const d=pane.getBoundingClientRect();
        pane.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:1,buttons:4,clientX:d.left+50,clientY:d.top+50}));
        document.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:4,clientX:d.left-40,clientY:d.top-60}));
        document.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:1,clientX:d.left-40,clientY:d.top-60}));
        const r=v.canvas.getBoundingClientRect();
        const moved=(v.panX!==0||v.panY!==0);
        // checker alignment when bounds are OFF
        v.showBounds=false; v.redraw();
        const wrapBgOff=getComputedStyle(v.canvasWrap).backgroundImage;
        return 'canvas '+(v.canvas.width)+'x'+v.canvas.height+' pane '+pane.clientWidth+'x'+pane.clientHeight+
               ' scrollbars='+scrollable+' panMoved='+moved+' ('+v.panX+','+v.panY+')'+
               ' canvasStillVisible='+(r.width>0)+' wrapBgWhenOff='+wrapBgOff.slice(0,12);})()`));

    fs.writeFileSync('/tmp/ff5e-demo/edit-ui.png',Buffer.from((await c.send('Page.captureScreenshot',{format:'png'},sessionId)).data,'base64'));
    console.log('wrote /tmp/ff5e-demo/edit-ui.png');
    ws.close();
  } finally { chrome.kill(); server.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
