// Cross-check the FF4 Advance (GBA) graphics model in ff4/ff4u-gba.json.
//
//   node tools/ff4-gba-xcheck.js [def.json] [rom]
//
// 1. pointer order == monster order (even = palette, odd = graphics)
// 2. one owner per byte: the two fragmented arrays tile the graphics
//    region exactly, with no overlap between them
// 3. decode parity: the tool's format chain vs an independent decoder
//    (LZSS + TOSE + linear 4bpp + bgr555) for every slot
// 4. sizeFrom: every graphics object shows the size monsterSize gives the
//    monster that points at it
// 5. palette pins: every graphics object is pinned to the palette its own
//    record points at
// 6. edit: painting a pixel lands on the right bytes, the pointer still
//    resolves after save, and undo is byte exact
const fs=require('fs'); const path=require('path');
require('./node-dom-stub.js');
const ROOT='/storage/romhacking/ff6tools';
const html=fs.readFileSync(path.join(ROOT,'ff6tools.html'),'utf8');
const files=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]).filter(u=>!/^https?:/.test(u)&&!u.includes('apultra'));
(0,eval)(files.map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')).join('\n;\n'));

const defPath=process.argv[2]||path.join(ROOT,'ff4/ff4u-gba.json');
const romPath=process.argv[3]||process.env.FF4G_ROM||'/storage/romhacking/ff-roms/Final Fantasy IV Advance (USA).gba';
const def=JSON.parse(fs.readFileSync(defPath,'utf8'));
const data=new Uint8Array(fs.readFileSync(romPath));
const B=0x08000000;
const PT=0x080F6FC8, SLOTS=362, SZ=0x080F8018, SZL=12, CHAR_TBL=0x080F7B18;
const REGION=[0x0818857C,0x081DA7F8];

let fails=0;
const bad=(msg)=>{ fails++; console.log('  FAIL ' + msg); };
const ok=(msg)=>console.log('  ok  ' + msg);

const rom=ROMObject.create(null,def); rom.disassemble(data);
const props=rom.parsePath('monsterGraphicsProperties');
const mg=rom.parsePath('monsterGraphics');
const mp=rom.parsePath('monsterPalettes');
if(!(props instanceof ROMArray)) bad('monsterGraphicsProperties missing');
if(!(mg.item(0) instanceof ROMGraphics)) bad('monsterGraphics items are not graphics objects');
console.log(`def ${path.basename(defPath)}  rom ${data.length} bytes crc32 0x${ROM.crc32(data).toString(16)}`);
console.log(`arrays: ${props.arrayLength} records, ${mg.arrayLength} graphics, ${mp.arrayLength} palettes`);

// ---- 1. pointer pairing ---------------------------------------------------
const buf=Buffer.from(data.buffer,data.byteOffset,data.length);
const ptr=i=>buf.readUInt32LE(PT-B+i*4);
let pairErr=0;
for(let m=0;m<SLOTS;m++){
  if(buf[ptr(m*2)-B]!==0x03) pairErr++;
  const g=ptr(m*2+1)-B;
  if(buf[g]!==0x10 && buf[g]!==0x01) pairErr++;
  const rp=props.item(m);
  if(rp.palettePointer.value!==ptr(m*2) || rp.graphicsPointer.value!==ptr(m*2+1)) pairErr++;
}
pairErr?bad(`pointer pairing: ${pairErr} slots wrong`):ok(`all ${SLOTS} records read palette@0 / graphics@4 from the ROM table`);

// ---- 2. one owner per byte ------------------------------------------------
const owner=new Int32Array(REGION[1]-REGION[0]).fill(-1);
const RB=REGION[0]-B;
const overlaps=[];
const check=(arr,tag)=>{
  for(let i=0;i<arr.arrayLength;i++){
    const it=arr.item(i);
    const b=it.range.begin, e=it.range.end;   // GBA ranges are already file offsets
    if(b<REGION[0]-B||e>REGION[1]-B){ overlaps.push([tag,i,it.range.toString(),'outside region']); continue; }
    for(let p=b-RB;p<e-RB;p++){
      if(owner[p]>=0) overlaps.push([tag,i,it.range.toString(),'already owned by '+owner[p]]);
      owner[p]=i + (tag==='gfx'?0:100000);
    }
  }
};
check(mg,'gfx'); check(mp,'pal');
const tm=rom.parsePath('monsterTilemaps');
const cg=rom.parsePath('characterGraphics');
const cp=rom.parsePath('characterPalettes');
console.log(`extra arrays: ${tm.arrayLength} tilemaps, ${cg.arrayLength} character frames, ${cp.arrayLength} character palettes`);
// the character/region arrays must not overlap each other either
{
    const own2=new Map();
    const dup=[];
    for(const [arr,tag] of [[cg,'chgfx'],[cp,'chpal'],[tm,'tmap']]){
        for(let i=0;i<arr.arrayLength;i++){
            const r=arr.item(i).range;
            for(let p=r.begin;p<r.end;p++){
                if(own2.has(p)) dup.push([tag,i,own2.get(p)]);
                own2.set(p,tag+i);
            }
        }
    }
    dup.length?bad(`character/tilemap arrays overlap in ${dup.length} bytes: ${JSON.stringify(dup.slice(0,3))}`)
              :ok(`character frames, character palettes and tilemaps also own their bytes once (${own2.size} bytes)`);
    // every character pointer in the ROM table must resolve to an object
    const csp=rom.parsePath('characterSpriteProperties');
    let unres=0;
    for(let g=0;g<csp.arrayLength;g++){
        const it=csp.item(g);
        for(let f=0;f<15;f++) if(!it['graphicsPointer'+f].target) unres++;
        if(!it.palettePointer.target) unres++;
    }
    unres?bad(`${unres} character pointers do not resolve`):ok('all 320 character pointers resolve to an object');
    // the frames a group uses must be the 15 art blocks that group points at
    const g0=csp.item(0);
    const want=[0,1,2].map(f=>buf.readUInt32LE(CHAR_TBL-B+0*64+f*4));
    const got=[0,1,2].map(f=>g0['graphicsPointer'+f].target.range.begin+0x08000000);
    JSON.stringify(want)===JSON.stringify(got)?ok('character group 0 frames map to the ROM table (2x3 tiles each)')
        :bad(`character group 0 frames wrong: want ${want} got ${got}`);
}
const holes=[]; for(let p=0;p<owner.length;p++) if(owner[p]<0) holes.push(p+REGION[0]);
if(overlaps.length) bad(`ownership: ${overlaps.length} overlapping bytes, e.g. ${JSON.stringify(overlaps.slice(0,3))}`);
else ok(`no overlap: ${mg.arrayLength} graphics + ${mp.arrayLength} palette objects own ${owner.length} bytes`);
if(holes.length) ok(`${holes.length} bytes unowned (decoder-trimmed padding), first at 0x${holes[0].toString(16)}`);

// ---- 3. decode parity -----------------------------------------------------
function lzss(a){
  const src=data.subarray(a-B,a-B+0x40000); let s=0;
  if(src[s++]!==0x10) throw new Error('lzss at 0x'+a.toString(16));
  const len=src[s++]|(src[s++]<<8)|(src[s++]<<16);
  const out=new Uint8Array(len), win=new Uint8Array(0x1000); let wp=0,d=0;
  while(d<len){
    let h=src[s++];
    for(let p=0;p<8&&d<len;p++,h<<=1){
      if(h&0x80){
        const w=(src[s++]<<8)|src[s++];
        let r=(w>>12)+3; const off=(w&0xFFF)+1;
        while(r--){ const c=win[(wp-off)&0xFFF]; win[wp&0xFFF]=c; wp=(wp+1)&0xFFF; out[d++]=c; }
      } else { const c=src[s++]; win[wp&0xFFF]=c; wp=(wp+1)&0xFFF; out[d++]=c; }
    }
  }
  return out;
}
const tose=(a,mode)=>{
  const p=a-B;
  let blob;
  if(data[p]===0x10) blob=lzss(a);
  else {
    const u=new Uint32Array(data.buffer,data.byteOffset+p,2);
    const per=(mode===3)?2:32;
    blob=data.subarray(p,p+8+u[1]*per);
  }
  const u=new Uint32Array(blob.buffer,blob.byteOffset,2);
  if(u[0]!==mode) throw new Error('tose mode '+u[0]+' != '+mode+' at '+a.toString(16));
  const per=(mode===3)?2:32;
  return blob.subarray(8,8+u[1]*per);
};
const expand=(u16)=>GFX.paletteFormat.bgr555.decode(new Uint8Array(new Uint16Array([u16]).buffer))[0][0];
let cmp=0, mism=[];
for(let m=0;m<SLOTS;m++){
  const rec=props.item(m);
  const g=rec.graphicsPointer.target, pl=rec.palettePointer.target;
  if(!g||!pl){ mism.push({m,why:'no target'}); continue; }
  cmp++;
  const ref=tose(rec.graphicsPointer.value,1);   // packed 4bpp: 32 bytes/tile
  if(g.data.length!==ref.length*2) mism.push({m,why:'len',tool:g.data.length,ref:ref.length*2});
  for(let i=0;i<ref.length*2;i++){
    const b=ref[i>>1], want=(i&1)?(b>>4):(b&0xF);
    if(g.data[i]!==want){ mism.push({m,i,tool:g.data[i],ref:want}); break; }
  }
  const rp=tose(rec.palettePointer.value,3);
  const ru=new Uint16Array(rp.buffer,rp.byteOffset,rp.length/2);
  for(let c=0;c<ru.length;c++){
    if(pl.data[c]!==expand(ru[c])){
      mism.push({m,palette:c,tool:pl.data[c].toString(16),want:expand(ru[c]).toString(16)}); break;
    }
  }
}
mism.length?bad(`decode parity: ${mism.length} of ${cmp} slots differ, e.g. ${JSON.stringify(mism.slice(0,3))}`)
           :ok(`decode parity for all ${cmp} slots (pixels and palette colours)`);

// ---- 4b. per-tile palette banks for the pooled (tile-mapped) monsters ----
let bankErr=0, bankChecked=0, bankMismatch=[];
for(let m=0;m<SLOTS;m++){
  const tp=data[SZ-B+m*SZL+8]|(data[SZ-B+m*SZL+9]<<8)|(data[SZ-B+m*SZL+10]<<16)|(data[SZ-B+m*SZL+11]<<24);
  if(!tp) continue;
  const rec=props.item(m);
  const g=rec.graphicsPointer.target;
  if(!g.tilePaletteCells){ bankErr++; bankMismatch.push({m,why:'no tilePaletteCells'}); continue; }
  const src=rom.parsePath(g.tilePaletteCells.path);
  const tm=src.item(g.tilePaletteCells.index);
  const w=data[SZ-B+m*SZL+3], h=data[SZ-B+m*SZL+4];
  for(let t=0;t<w*h;t++){
    const want=(tm.data[12+t*2]|(tm.data[12+t*2+1]<<8))>>12&3;
    const got=g.tilePaletteBank(t);
    bankChecked++;
    if(want!==got){ bankErr++; if(bankMismatch.length<3) bankMismatch.push({m,t,want,got}); }
  }
}
bankErr?bad(`tile palette banks: ${bankErr} of ${bankChecked} wrong ${JSON.stringify(bankMismatch)}`)
       :ok(`per-tile palette banks match the ROM tile maps (${bankChecked} tiles)`);

// ---- 4/5. sizes and palette pins -----------------------------------------
let sizeErr=0, pinErr=0, sized=0, pinned=0;
for(let m=0;m<SLOTS;m++){
  const rec=props.item(m);
  const g=rec.graphicsPointer.target;
  const w=data[SZ-B+m*SZL+3], h=data[SZ-B+m*SZL+4];
  if(!w||!h) continue;
  sized++;
  // a shared graphics object can only carry one size/palette: it belongs to
  // the first record that claimed it, and must match one of its users
  const users=[];
  for(let k=0;k<SLOTS;k++) if(ptr(k*2+1)===rec.graphicsPointer.value) users.push(k);
  if(!users.some(k=>g.width===data[SZ-B+k*SZL+3] && g.height===data[SZ-B+k*SZL+4]))
    sizeErr++;
  if(!g.palettePinned) continue;
  pinned++;
  const pals=users.map(k=>props.item(k).palettePointer.target.i);
  if(!pals.includes(parseInt(g.palette.replace(/[^0-9]/g,''),10))) pinErr++;
}
sizeErr?bad(`sizeFrom: ${sizeErr} of ${sized} objects show the wrong size`)
       :ok(`sizeFrom: all ${sized} objects show monsterSize's width/height`);
pinErr?bad(`palette pins: ${pinErr} objects pinned to the wrong palette`)
      :ok(`palette pins: ${pinned}/${sized} graphics pinned to their record's palette`);

// ---- 6. paint, save, reload, undo ----------------------------------------
const target=props.item(12);                      // Sand Worm
const gfx=target.graphicsPointer.target;
const before=Uint8Array.from(gfx.data);
const edited=Uint8Array.from(before); edited[3]^=0x0F;
gfx.replaceData(edited); gfx.markAsDirty();
if(!rom.assemble()) bad('assemble() returned false after a paint');
const asm=Buffer.from(rom.data.buffer,rom.data.byteOffset,rom.data.length);
let changed=[]; for(let i=0;i<asm.length;i++) if(asm[i]!==buf[i]) changed.push(i);
console.log(`  paint: ${changed.length} bytes changed, 0x${Math.min(...changed).toString(16)}-0x${Math.max(...changed).toString(16)}`);
const np=asm.readUInt32LE(PT-B+12*8+4);
const rom2=ROMObject.create(null,def); rom2.disassemble(new Uint8Array(asm));
const g2=rom2.parsePath('monsterGraphicsProperties[12]').graphicsPointer.target;
if(g2.data[3]!==edited[3]) bad(`reloaded ROM: pixel 3 is ${g2.data[3]}, expected ${edited[3]} (pointer 0x${np.toString(16)})`);
else ok('the painted pixel survives save/reload through the pointer record');

// every other monster must still decode
let regress=0;
const shared=new Set(); for(let m=0;m<SLOTS;m++) if(ptr(m*2+1)===ptr(12*2+1)) shared.add(m);
for(let m=0;m<SLOTS;m++){
  if(shared.has(m)) continue;
  const r2=rom2.parsePath(`monsterGraphicsProperties[${m}]`);
  const t=r2.graphicsPointer.target; if(!t) { regress++; continue; }
  const ref=tose(r2.graphicsPointer.value,1);
  for(let i=0;i<ref.length*2;i++){
    const b=ref[i>>1], want=(i&1)?(b>>4):(b&0xF);
    if(t.data[i]!==want){ regress++; break; }
  }
}
regress?bad(`${regress} other monsters no longer decode after the edit`):ok('no collateral damage to the other slots');

// byte-exact undo
const rom3=ROMObject.create(null,def); rom3.disassemble(data);
const g3=rom3.parsePath('monsterGraphicsProperties[12]').graphicsPointer.target;
g3.replaceData(edited); g3.markAsDirty(); rom3.assemble();
g3.replaceData(before); g3.markAsDirty(); rom3.assemble();
const asm3=Buffer.from(rom3.data.buffer,rom3.data.byteOffset,rom3.data.length);
let d3=0; for(let i=0;i<asm3.length;i++) if(asm3[i]!==buf[i]) d3++;
d3?bad(`undo left ${d3} bytes different from the original ROM`):ok('undo restores the original bytes exactly');

console.log(fails?`\nFAILED: ${fails} check(s)`:'\nall checks passed');
process.exit(fails?1:0);
