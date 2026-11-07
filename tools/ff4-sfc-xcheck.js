// Cross-check the FF4 SNES (U) monster/boss graphics model against the ROM.
//   node tools/ff4-sfc-xcheck.js [definition.json] [rom]
// Checks:
//   1. every monster graphics properties record resolves to a graphics object
//      whose range starts exactly where the game's pointer points
//      (loROM graphics pointers are linear in FILE space from 0x48000)
//   2. item ranges are pairwise disjoint and own no byte twice with any other
//      assembly (the one-owner rule)
//   3. per-object format matches the is3bpp flag; per-object width/height
//      match the size table for non-boss monsters
//   4. decoded pixels match an independent from-spec decoder for every
//      non-boss monster (3bpp and 4bpp), and palette pinning matches the
//      ROM's palette indices (4bpp composes p + p+1 like the game loads)
//   5. painting an edit lands on exactly the right ROM bytes, and undoing it
//      restores the ROM byte-for-byte
const fs=require('fs'); const path=require('path');
require('./node-dom-stub.js');
const ROOT='/storage/romhacking/ff6tools';
const html=fs.readFileSync(path.join(ROOT,'ff6tools.html'),'utf8');
const files=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]).filter(u=>!/^https?:/.test(u)&&!u.includes('apultra'));
(0,eval)(files.map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')).join('\n;\n'));

const defPath=process.argv[2]||path.join(ROOT,'ff4/ff2u-sfc.json');
const romPath=process.argv[3]||'/storage/romhacking/ff-roms/Final Fantasy II (USA).sfc';
const def=JSON.parse(fs.readFileSync(defPath,'utf8'));
const data=new Uint8Array(fs.readFileSync(romPath));
const rom=ROMObject.create(null,def); rom.disassemble(data);

let fails=0;
const check=(cond,msg)=>{ if(!cond){ fails++; console.log('FAIL:',msg); } };

// ---- ROM-side tables, read directly (independent of the definition) ------
const m=a=>((a&0xFF0000)>>1)+(a&0x7FFF);
const PROPS=m(0x0FCA00), SIZES=m(0x0DFF5E), BOSST=m(0x0FCE00), BASE=0x48000;
const recs=[];
for(let i=0;i<224;i++){
  const b0=data[PROPS+i*4], b1=data[PROPS+i*4+1];
  const w2=data[PROPS+i*4+2]|(data[PROPS+i*4+3]<<8);
  recs.push({i,size:b0&0x3F,isChar:!!(b0&0x40),isBoss:!!(b0&0x80),pal:b1,
             ptr:(w2&0x7FFF)*8,bpp3:!!(w2&0x8000)});
}
const sizeTiles=si=>[data[SIZES+si*2],data[SIZES+si*2+1]];

// ---- 1. pointer targets resolve to the right objects --------------------
for(const r of recs){
  const p=rom.monsterGraphicsProperties.item(r.i);
  const t=p.graphicsPointer.target;
  check(!!t, `monster ${r.i}: graphicsPointer has no target`);
  if(!t) continue;
  check(t.range.begin===BASE+r.ptr,
    `monster ${r.i}: target range ${t.range.begin.toString(16)} != pointer ${(BASE+r.ptr).toString(16)}`);
}

// ---- 2. one owner per byte ----------------------------------------------
const items=rom.monsterGraphics;
console.log('monsterGraphics:',items.arrayLength,'objects');
check(items.arrayLength===new Set(recs.map(r=>r.ptr)).size,'item count != unique pointer count');
const owned=[];
for(let k=0;k<items.arrayLength;k++){
  const it=items.item(k);
  owned.push([it.range.begin,it.range.end,`monsterGraphics[${k}]`]);
}
owned.sort((a,b)=>a[0]-b[0]);
for(let k=0;k<owned.length-1;k++)
  check(owned[k][1]<=owned[k+1][0],`items overlap: ${owned[k][2]} ${owned[k][1].toString(16)} > ${owned[k+1][2]} ${owned[k+1][0].toString(16)}`);
const foreign=[];
for(const key in rom.assembly){
  const a=rom.assembly[key];
  if(key==='monsterGraphics'||a===items) continue;
  if(a.fragment) continue;            // the fragments ARE the items above
  if(a.range&&!a.range.isEmpty&&a.parent===rom) foreign.push([a.range.begin,a.range.end,key]);
  if(a instanceof ROMArray&&a!==items&&a.range&&!a.range.isEmpty) foreign.push([a.range.begin,a.range.end,key]);
}
for(const [lo,hi,name] of owned)
  for(const [flo,fhi,fname] of foreign)
    check(hi<=flo||fhi<=lo,`double ownership: ${name} [${lo.toString(16)},${hi.toString(16)}) vs ${fname} [${flo.toString(16)},${fhi.toString(16)})`);

// ---- 3. format and size --------------------------------------------------
for(let k=0;k<items.arrayLength;k++){
  const it=items.item(k);
  const users=recs.filter(r=>!r.isChar&&r.ptr===owned.find(o=>o[0]===it.range.begin)[0]-BASE);
  const bpp3=users[0].bpp3;
  check(it.format===(bpp3?'snes3bpp':'snes4bpp'),`item ${k}: format ${it.format} != ${bpp3?'snes3bpp':'snes4bpp'}`);
  for(const r of users){
    if(r.isBoss) continue;
    const [tw,th]=sizeTiles(r.size);
    check(it.width===tw&&it.height===th,`item ${k} (monster ${r.i}): size ${it.width}x${it.height} != ${tw}x${th}`);
  }
}

// ---- 4. decode parity against an independent decoder ---------------------
// SNES planar tile decode straight from the hardware spec
function decodeTile(raw,off,bpp){
  const px=new Uint8Array(64);
  for(let y=0;y<8;y++){
    const p0=raw[off+y*2], p1=raw[off+y*2+1];
    const p2=raw[off+16+y], p3=bpp===4?raw[off+17+y]:0;
    for(let x=0;x<8;x++){
      const b=7-x;
      px[y*8+x]=(p0>>b&1)|((p1>>b&1)<<1)|((p2>>b&1)<<2)|((p3>>b&1)<<3);
    }
  }
  return px;
}
let parity=0;
for(const r of recs){
  if(r.isChar||r.isBoss) continue;
  const [tw,th]=sizeTiles(r.size);
  const bytes=r.bpp3?24:32;
  const it=rom.monsterGraphicsProperties.item(r.i).graphicsPointer.target;
  const raw=data.subarray(it.range.begin,it.range.begin+tw*th*bytes);
  for(let t=0;t<tw*th;t++){
    const ref=decodeTile(raw,t*bytes,r.bpp3?3:4);
    const got=it.data.subarray(t*64,t*64+64);
    for(let p=0;p<64;p++) if(ref[p]!==got[p]){
      check(false,`item ${it.i} tile ${t} pixel ${p}: tool ${got[p]} != ref ${ref[p]}`);
      break;
    }
    parity++;
  }
}
console.log('tiles decode-parity checked:',parity);

// palette pinning: first user's palette index must match the pinned path
for(let k=0;k<items.arrayLength;k++){
  const it=items.item(k);
  const off=it.range.begin-BASE;
  const users=recs.filter(r=>!r.isChar&&r.ptr===off);
  if(!users.length) continue;
  const r=users[0];
  const p=r.isBoss?data[BOSST+r.size*5+2]:r.pal;
  const defs=Array.isArray(it.palette)?it.palette:[it.palette];
  const first=defs[0];
  const mm=typeof first==='string'?first:first.path;
  check(mm===`monsterPalette[${p}]`,`item ${k}: palette ${mm} != monsterPalette[${p}]`);
  if(!r.bpp3){
    check(defs.length>=2&&defs[1].offset===8,`item ${k}: 4bpp palette not composed with p+1`);
  }
}

// ---- 5. edit lands on the right bytes; undo is byte-exact ----------------
const victim=rom.monsterGraphicsProperties.item(0).graphicsPointer.target; // Imp
const before=Uint8Array.from(victim.data);
const edited=Uint8Array.from(before); edited[10]^=0x07;
victim.replaceData(edited);
rom.assemble();
const asm=Buffer.from(rom.data.buffer,rom.data.byteOffset,rom.data.length);
const orig=Buffer.from(data.buffer,data.byteOffset,data.length);
let changed=[];
for(let i=0;i<orig.length;i++) if(orig[i]!==asm[i]) changed.push(i);
// FF6Tools legitimately fixes the SNES header checksum when the ROM changes
const hdr=rom.snesHeader&&rom.snesHeader.range;
const dataChanged=changed.filter(c=>!(hdr&&c>=hdr.begin&&c<hdr.end));
console.log('edit: bytes changed =',changed.length,'(excluding header:',dataChanged.length,') at 0x'+(dataChanged[0]||0).toString(16));
check(dataChanged.length>0,'edit produced no change');
check(dataChanged.every(c=>c>=victim.range.begin&&c<victim.range.end),'edit changed bytes outside the item range');
// reload and confirm the pixel actually changed
const rom2=ROMObject.create(null,def); rom2.disassemble(new Uint8Array(asm));
const v2=rom2.monsterGraphicsProperties.item(0).graphicsPointer.target;
check(v2.data[10]===edited[10],'edited pixel did not survive reload');
// undo the edit through the same object and require a byte-exact restore
victim.replaceData(before);
rom.assemble();
const asm2=Buffer.from(rom.data.buffer,rom.data.byteOffset,rom.data.length);
let diff2=0;
for(let i=0;i<orig.length;i++) if(orig[i]!==asm2[i]) diff2++;
console.log('undo: diffs vs original =',diff2);
check(diff2===0,'undo did not restore the ROM byte-for-byte');

// ---- also: the untouched round-trip must be exact ------------------------
const rom3=ROMObject.create(null,def); rom3.disassemble(data);
rom3.assemble();
let diff3=0;
for(let i=0;i<orig.length;i++) if(orig[i]!==rom3.data[i]) diff3++;
check(diff3===0,`round trip not byte-exact (${diff3} diffs)`);

console.log(fails?`${fails} FAILURES`:'all FF4 SNES graphics checks passed');
process.exit(fails?1:0);
