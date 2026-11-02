// Verify the new UI affordances: default tool, cursors, wheel zoom, right-click pick.
const fs=require('fs'), path=require('path'), {spawn}=require('child_process');
const ROOT='/storage/romhacking/ff6tools';
const ROM=path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba');
const PORT=8361, CDP_PORT=9261;
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
    await ev(c,sessionId,`(()=>{const o=rom.monsterGraphicsProperties.item(11).graphicsPointer.target;propertyList.select(o);return 1;})()`);
    await sleep(600);

    console.log('default tool:',await ev(c,sessionId,'propertyList.getEditor("ROMGraphicsView").tool'));

    console.log('cursors:',await ev(c,sessionId,`(()=>{const v=propertyList.getEditor('ROMGraphicsView');
        const out=[];
        for(let t=0;t<4;t++){v.tool=t;v.updateCursor();out.push(t+':'+(v.canvas.style.cursor.startsWith('url(')?'image':'css:'+v.canvas.style.cursor));}
        return out.join(' ');})()`));

    console.log('wheel zoom:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        const before=v.zoom;
        const mk=(dy)=>{const e=new WheelEvent('wheel',{deltaY:dy,bubbles:true,cancelable:true});
            Object.defineProperty(e,'offsetX',{value:40});Object.defineProperty(e,'offsetY',{value:40});return e;};
        v.canvasDiv.dispatchEvent(mk(-100)); const up=v.zoom;
        v.canvasDiv.dispatchEvent(mk(100));  const back=v.zoom;
        v.canvasDiv.dispatchEvent(mk(-100)); v.canvasDiv.dispatchEvent(mk(-100)); v.canvasDiv.dispatchEvent(mk(-100));
        const max=v.zoom;
        return 'start '+before+' -> zoomIn '+up+' -> zoomOut '+back+' -> clamped max '+max;})()`));

    console.log('right-click pick:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        const o=rom.monsterGraphicsProperties.item(11).graphicsPointer.target;
        // find a non-transparent pixel to pick
        let idx=o.data.findIndex(x=>x!==0), want=o.data[idx];
        const px=idx%8, py=Math.floor(idx/8)%8, tile=Math.floor(idx/64);
        const tx=(tile%v.width)*8+px, ty=Math.floor(tile/v.width)*8+py;
        v.color=-1;
        const cr=v.canvas.getBoundingClientRect();
        const e=new MouseEvent('contextmenu',{bubbles:true,cancelable:true,
            clientX:cr.left+(tx+0.5)*v.zoom, clientY:cr.top+(ty+0.5)*v.zoom});
        v.div.dispatchEvent(e);
        return 'pixel ('+tx+','+ty+') colour '+want+' -> picked '+v.color+', swatch '+v.paletteView.c+
               (v.color===want?' MATCH':' MISMATCH');})()`));

    console.log('right-button cursor:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.rightHeld=true; v.updateCursor();
        const held=v.canvas.style.cursor.startsWith('url(');
        v.rightHeld=false; v.updateCursor();
        return 'while held: '+(held?'eyedropper image':'NOT changed')+' | released: '+(v.canvas.style.cursor.startsWith('url(')?'back to pencil':'wrong');})()`));

    console.log('wheel over pane:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.zoom=2; v.resize(); v.redraw();
        const before=v.zoom;
        const mk=(dy,x,y)=>new WheelEvent('wheel',{deltaY:dy,bubbles:true,cancelable:true,clientX:x,clientY:y});
        const r=v.canvas.getBoundingClientRect();
        const d=v.div.getBoundingClientRect();
        const e=document.getElementById('edit-div').getBoundingClientRect();
        const x=r.right+120, y=r.top+5;   // well outside the canvas
        v.div.dispatchEvent(mk(-100,x,y)); const up=v.zoom;
        v.div.dispatchEvent(mk(-100,x,y)); const up2=v.zoom;
        v.div.dispatchEvent(mk(100,x,y));  const down=v.zoom;
        return 'from '+before+': wheel-up '+up+' -> '+up2+', wheel-down '+down+
               ' | view div covers pane: '+Math.round(d.width)+'x'+Math.round(d.height)+
               ' vs edit-div '+Math.round(e.width)+'x'+Math.round(e.height)+
               ' | canvas only '+Math.round(r.width)+'x'+Math.round(r.height);})()`));

    console.log('centering:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.zoom=1; v.resetPan(); v.resize(); v.redraw();
        const d=v.div.getBoundingClientRect(), r=v.canvas.getBoundingClientRect();
        const leftGap=r.left-d.left, rightGap=d.right-r.right;
        const topGap=r.top-d.top, botGap=d.bottom-r.bottom;
        return 'canvas '+Math.round(r.width)+'x'+Math.round(r.height)+' in pane '+Math.round(d.width)+'x'+Math.round(d.height)+
               ' | h gaps '+Math.round(leftGap)+'/'+Math.round(rightGap)+' v gaps '+Math.round(topGap)+'/'+Math.round(botGap)+
               (Math.abs(leftGap-rightGap)<3 && Math.abs(topGap-botGap)<3 ? ' CENTERED':' NOT centred');})()`));

    console.log('overlays:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        return 'showBounds='+v.showBounds+' showGrid='+v.showGrid+
               ' | bounds checkbox='+!!document.getElementById('graphics-show-bounds')+
               ' grid checkbox='+!!document.getElementById('graphics-show-grid');})()`));

    console.log('zoom anchor:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.zoom=2; v.resize(); v.redraw();
        const r=v.canvas.getBoundingClientRect();
        const cx=r.left+20, cy=r.top+14;              // image point (10,7) at zoom 2
        const mk=(dy)=>new WheelEvent('wheel',{deltaY:dy,bubbles:true,cancelable:true,clientX:cx,clientY:cy});
        v.div.dispatchEvent(mk(-100));
        const r2=v.canvas.getBoundingClientRect();
        const imgX=(cx-r2.left)/v.zoom, imgY=(cy-r2.top)/v.zoom;
        return 'zoom '+v.zoom+' -> image point under cursor is ('+imgX.toFixed(1)+','+imgY.toFixed(1)+') expected (10,7)';})()`));

    console.log('middle pan:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.zoom=16; v.resize(); v.redraw(); v.resetPan();
        const before={x:v.panX,y:v.panY};
        const d=v.div.getBoundingClientRect();
        const x=d.left+50,y=d.top+50;
        v.div.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:1,buttons:4,clientX:x,clientY:y}));
        const cur=v.canvas.style.cursor;
        v.div.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:4,clientX:x-40,clientY:y-25}));
        const moved=v.canvasWrap.style.transform;
        v.div.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:1,clientX:x-40,clientY:y-25}));
        return 'cursor: '+cur+' | pan moved '+(v.panX-before.x)+','+(v.panY-before.y)+' | transform: '+moved;})()`));

    console.log('picker drag:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.zoom=8; v.resize(); v.redraw();
        const o=rom.monsterGraphicsProperties.item(11).graphicsPointer.target;
        v.tool=3; v.color=-1; v.picking=true;
        const r=v.canvas.getBoundingClientRect();
        const seen=[];
        for(let i=0;i<24;i++){
            v.div.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,buttons:1,clientX:r.left+i,clientY:r.top+3}));
            seen.push(v.color);
        }
        v.picking=false;
        return 'colours seen during drag: '+[...new Set(seen)].join(',');})()`));

    console.log('overlay pixels:',await ev(c,sessionId,`(()=>{
        const v=propertyList.getEditor('ROMGraphicsView');
        v.zoom=8; v.showBounds=true; v.showGrid=false; v.resize(); v.redraw();
        const px=v.cursorCanvas.getContext('2d').getImageData(0,0,v.cursorCanvas.width,v.cursorCanvas.height).data;
        let opaque=0; for(let i=3;i<px.length;i+=4) if(px[i]) opaque++;
        const outline=(()=>{ // sample the top edge of the image outline
            const y=Math.round(v.height*v.tileHeight*v.zoom)-1, x=Math.round(v.width*v.tileWidth*v.zoom/2);
            return px[(y*v.cursorCanvas.width+x)*4+3];})();
        v.showGrid=true; v.redraw();
        const px2=v.cursorCanvas.getContext('2d').getImageData(0,0,v.cursorCanvas.width,v.cursorCanvas.height).data;
        let grid=0; for(let i=3;i<px2.length;i+=4) if(px2[i]) grid++;
        return 'bounds on: marked px='+opaque+' outline alpha='+outline+' | grid on: marked px='+grid;})()`));

    console.log('palette node:',await ev(c,sessionId,`(()=>{
        const cat=[...document.querySelectorAll('.nav-category > p')].find(p=>p.textContent.trim()==='Battle');
        if(!cat.parentElement.classList.contains('shown')) cat.click();
        const p=[...document.querySelectorAll('.nav-array > p')].find(x=>x.textContent.trim()==='Monster Palettes');
        if(!p) return 'Monster Palettes row not found';
        if(!p.parentElement.classList.contains('shown')) p.click();
        const li=[...p.parentElement.querySelectorAll('li')].find(l=>l.querySelector(':scope > p'));
        if(!li) return 'no palette entries';
        li.querySelector('p').click();
        const v=propertyList.getEditor('ROMGraphicsView');
        const sel=v.paletteView.definition && rom.parsePath(v.paletteView.definition);
        return 'selected row: '+li.textContent.trim()+' | palette panel shows: '+(sel?sel.path+' at '+sel.range:'nothing')+
               ' | first colour 0x'+(v.paletteView.palette[0]>>>0).toString(16);})()`));

    console.log('navigator arrows:',await ev(c,sessionId,`(()=>{
        const cat=[...document.querySelectorAll('.nav-category > p')].find(p=>p.textContent.trim()==='Battle');
        if(!cat.parentElement.classList.contains('shown')) cat.click();
        const mg=[...document.querySelectorAll('.nav-array > p')].find(x=>x.textContent.trim()==='Monster Graphics');
        if(!mg.parentElement.classList.contains('shown')) mg.click();
        const list=mg.parentElement;
        const rows=[...list.querySelectorAll(':scope > ul > li')];
        rows[3].querySelector(':scope > p').click();
        const pane=document.getElementById('left-pane');
        pane.focus();
        const name=()=>{const s=list.querySelector('li.selected > p');return s?s.textContent.trim():'(none)';};
        const k=(key)=>pane.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
        const before=name();
        k('ArrowDown'); const one=name();
        k('ArrowDown'); const two=name();
        k('ArrowUp');   const back=name();
        return before+' -> '+one+' -> '+two+' -> up: '+back+
               ' | editor shows: '+(propertyList.getEditor('ROMGraphicsView').object||{}).path;})()`));

    console.log('graphics view in map mode:',await ev(c,sessionId,`(()=>{
        propertyList.select(rom.mapProperties.item(0));
        const gv=propertyList.editors['ROMGraphicsView'];
        const d=gv.div.getBoundingClientRect(), c2=gv.canvas.getBoundingClientRect();
        return 'mode: toolbox='+gv.toolboxMode+' editor='+gv.editorMode+' zoom '+gv.zoom.toFixed(2)+
               ' | canvas '+Math.round(c2.width)+'x'+Math.round(c2.height)+' in '+Math.round(d.width)+'x'+Math.round(d.height)+
               ' | cursor='+gv.canvas.style.cursor;})()`));

    fs.writeFileSync('/tmp/ff5e-demo/paint-ui.png',
      Buffer.from((await c.send('Page.captureScreenshot',{format:'png'},sessionId)).data,'base64'));
    console.log('wrote /tmp/ff5e-demo/paint-ui.png');
    ws.close();
  } finally { chrome.kill(); server.kill(); }
})().catch(e=>{console.error('FAIL',e.message);process.exit(1);});
