// Cross-check: does ff6tools' format chain decode monster graphics/palettes
// identically to the standalone reference decoder in tools/ff5e-gfx.js?
const fs=require('fs'); const path=require('path'); const cp=require('child_process');
require('./node-dom-stub.js');
const ROOT='/storage/romhacking/ff6tools';
const html=fs.readFileSync(path.join(ROOT,'ff6tools.html'),'utf8');
const files=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]).filter(u=>!/^https?:/.test(u)&&!u.includes('apultra'));
(0,eval)(files.map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')).join('\n;\n'));
const def=JSON.parse(fs.readFileSync(path.join(ROOT,'ff5/ff5e-gba.json'),'utf8'));
const data=new Uint8Array(fs.readFileSync(process.env.FF5E_ROM||path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba')));
const rom=ROMObject.create(null,def); rom.disassemble(data);

// reference decoder (independent implementation)
const B=0x08000000;
const buf=Buffer.from(data.buffer,data.byteOffset,data.length);
const ptr=i=>buf.readUInt32LE(0x08131C14-B+i*4);
const at=(a,n=0x40000)=>new Uint8Array(data.buffer,data.byteOffset+(a-B),n);
function lzss(src){let s=0,d=0;const out=new Uint8Array(0x40000),win=new Uint8Array(0x1000);let wp=0;const line=new Uint8Array(18);let r,w,c;if(src[s++]!==0x10)throw new Error('lzss');const len=src[s++]|(src[s++]<<8)|(src[s++]<<16);while(d<len){var h=src[s++];for(let p=0;p<8;p++,h<<=1){let l=0;if(h&0x80){w=(src[s++]<<8)|src[s++];r=(w>>12)+3;w=(w&0xFFF)+1;for(let i=0;i<r;i++){c=win[(wp-w)&0xFFF];line[l++]=c;win[wp++]=c;wp&=0xFFF;}}else{c=src[s++];line[l++]=c;win[wp++]=c;wp&=0xFFF;}out.set(line.subarray(0,l),d);d+=l;if(d>=len)break;}}return out.slice(8,d);} // strip tose-graphics header
const refPx=(id,x,y)=>{const g=lzss(at(ptr(id*2)));const w=data[0x08147C30-B+id*4];const v=g[((y>>3)*w+(x>>3))*32+((y&7)<<2)+((x&7)>>1)];return (x&1)?(v>>4):(v&15);};
const refPal=(id)=>{const a=at(ptr(id*2+1));const n=new Uint32Array(a.buffer,a.byteOffset,2)[1];const u16=new Uint16Array(a.buffer,a.byteOffset+8,n);return Array.from(u16);};

// 1) compare the tool's decoded pixel data against the reference for every monster
const mg=rom.parsePath('monsterGraphics'), mp=rom.parsePath('monsterPalettes');
console.log(`tool arrays: monsterGraphics=${mg.arrayLength} items, monsterPalettes=${mp.arrayLength} items (de-duplicated)`);
let compared=0, mismatch=[];
for(let id=0;id<736;id++){
  const props=rom.parsePath(`monsterGraphicsProperties[${id}]`);
  const gfx=props.graphicsPointer.target, pal=props.palettePointer.target;
  if(!gfx||!pal){ mismatch.push({id,why:'no target'}); continue; }
  const w=data[0x08147C30-B+id*4], h=data[0x08147C30-B+id*4+1];
  if(!w||!h) continue;
  compared++;
  // pixels
  for(let y=0;y<h*8;y++) for(let x=0;x<w*8;x++){
    const t=(y>>3)*w+(x>>3);
    const v=gfx.data[t*64+(y&7)*8+(x&7)];
    const r=refPx(id,x,y);
    if(v!==r){ mismatch.push({id,x,y,tool:v,ref:r}); y=h*8; break; }
  }
  // palette (tool decodes bgr555 -> RGBA32; expand the reference value the same way)
  const rp=refPal(id);
  for(let c=0;c<Math.min(rp.length,16);c++){
    const one=new Uint8Array(new Uint16Array([rp[c]]).buffer);
    const exp=GFX.paletteFormat.bgr555.decode(one)[0][0];
    if(pal.data[c]!==exp){ mismatch.push({id,palette:true,c,tool:pal.data[c].toString(16),ref:exp.toString(16)}); break; }
  }
}
console.log('monsters compared:',compared,'mismatches:',mismatch.length,mismatch.slice(0,5));

// 2) round-trip with an actual edit: change one tile of one monster, re-assemble
const target=rom.parsePath('monsterGraphicsProperties[4]');
const gfx=target.graphicsPointer.target;
console.log('monster 4 -> graphics',gfx.path,'range',gfx.range.toString(),'dataLen',gfx.data.length);
const before=Uint8Array.from(gfx.data);
const edited=Uint8Array.from(before); edited[0]=before[0]^0x0F;
gfx.replaceData(edited);
gfx.markAsDirty();   // the GUI import path relies on this; test it explicitly
const ok=rom.assemble();
const asm=Buffer.from(rom.data.buffer,rom.data.byteOffset,rom.data.length);
const orig=Buffer.from(data.buffer,data.byteOffset,data.length);
let changed=[];
for(let i=0;i<orig.length;i++) if(orig[i]!==asm[i]) changed.push(i);
console.log('after edit: assemble ok =',ok,'| bytes changed:',changed.length,
  'range 0x'+Math.min(...changed).toString(16)+'-0x'+Math.max(...changed).toString(16));
// where does the saved ROM now point for monster 4?
const np=asm.readUInt32LE(0x08131C14-B+4*8);
console.log('  pointer after save: 0x'+(np-B).toString(16),'(was 0x'+(ptr(8)-B).toString(16)+')');
const rom2=ROMObject.create(null,def); rom2.disassemble(new Uint8Array(asm));
const g2=rom2.parsePath('monsterGraphicsProperties[4]').graphicsPointer.target;
console.log('  reloaded graphics range',g2.range.toString(),'first byte',g2.data[0],'expected',edited[0],'match:',g2.data[0]===edited[0]);
// and everything else must be untouched
const rom3=ROMObject.create(null,def); rom3.disassemble(new Uint8Array(asm));
const sharedWith4=new Set();
for(let id=0;id<736;id++) if(ptr(id*2)===ptr(8)) sharedWith4.add(id);
console.log('  monster ids sharing the same graphics block as id 4:',[...sharedWith4].join(','));
let regress=0, broken=[];
for(let id=0;id<736;id++){
  if(sharedWith4.has(id)) continue;
  const p3=rom3.parsePath(`monsterGraphicsProperties[${id}]`);
  const g3=p3.graphicsPointer.target; if(!g3){regress++;broken.push(id);continue;}
  const w=buf[0x08147C30-B+id*4], h=buf[0x08147C30-B+id*4+1]; if(!w||!h) continue;
  let bad=false;
  for(let y=0;y<h*8&&!bad;y++)for(let x=0;x<w*8;x++){
    const t=(y>>3)*w+(x>>3);
    if(g3.data[t*64+(y&7)*8+(x&7)]!==refPx(id,x,y)){bad=true;break;}
  }
  if(bad){regress++;broken.push(id);}
}
console.log('  other monsters still decode correctly:',regress===0?'YES':`NO (${regress} broken: ${broken.slice(0,5)})`);
