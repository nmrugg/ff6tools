// Harness: run ff6tools' ROM engine under Node to test definition changes.
//   node tools/rom-harness.js [definition.json]
const fs=require('fs'); const path=require('path');
require('./node-dom-stub.js');
const ROOT='/storage/romhacking/ff6tools';
// one shared script scope so `class` declarations are visible across files
const html=fs.readFileSync(path.join(ROOT,'ff6tools.html'),'utf8');
const files=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]).filter(u=>!/^https?:/.test(u)&&!u.includes('apultra'));
globalThis.__dirname=ROOT; globalThis.require=require;
const src=files.map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')).join('\n;\n');
(0,eval)(src);
const defPath=process.argv[2]||path.join(ROOT,'ff5/ff5e-gba.json');
const romPath=process.env.FF5E_ROM||path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba');
const def=JSON.parse(fs.readFileSync(defPath,'utf8'));
const data=new Uint8Array(fs.readFileSync(romPath));
console.log('def:',defPath,'rom:',data.length,'bytes, crc32 0x'+ROM.crc32(data).toString(16));

const rom=ROMObject.create(null,def);
rom.disassemble(data);
console.log('disassembled OK');

function describe(p){
  const o=rom.parsePath(p);
  if(!o){ console.log(`  ${p}: NOT FOUND`); return null; }
  console.log(`  ${p}: ${o.constructor.name} name=${o.name} range=${o.range} len=${o.data?o.data.length:'-'}`);
  if(o instanceof ROMArray){
    console.log(`     arrayLength=${o.arrayLength}`);
    for(const i of [0,1,2,3,88,300,735]) if(i<o.arrayLength){
      const it=o.item(i);
      if(!it){ console.log(`     [${i}] null`); continue; }
      console.log(`     [${i}] ${it.constructor.name} range=${it.range} dataLen=${it.data?it.data.length:'-'} format=${JSON.stringify(it.format)}`);
    }
  }
  return o;
}
for(const p of ['monsterGraphics','monsterSize','monsterGraphicsPointers','monsterPalettes','portraitGraphics1','battleCharacterGraphics']) describe(p);

// round-trip: assembling with no edits should reproduce the original bytes
const ok=rom.assemble();
const asm=Buffer.from(rom.data.buffer,rom.data.byteOffset,rom.data.length);
const orig=Buffer.from(data.buffer,data.byteOffset,data.length);
let diffs=[];
for(let i=0;i<Math.max(orig.length,asm.length);i++) if(orig[i]!==asm[i]) { if(diffs.length<10) diffs.push(['0x'+i.toString(16),'rom 0x'+(orig[i]||0).toString(16),'asm 0x'+(asm[i]||0).toString(16)]); }
console.log('assemble() returned:',ok,'| output bytes:',asm.length,'| diffs vs original:',diffs.length);
diffs.forEach(d=>console.log('   ',d.join(' ')));
