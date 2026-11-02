// Verify each monsterGraphics object's palette path resolves to the palette its
// pointer record actually references.
const fs=require('fs'), path=require('path'); require('./node-dom-stub.js');
const ROOT='/storage/romhacking/ff6tools';
const html=fs.readFileSync(path.join(ROOT,'ff6tools.html'),'utf8');
const files=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]).filter(u=>!/^https?:/.test(u)&&!u.includes('apultra'));
(0,eval)(files.map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')).join('\n;\n'));
const defPath=process.argv[2]||path.join(ROOT,'ff5/ff5e-gba.json');
const romPath=process.argv[3]||path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba');
const def=JSON.parse(fs.readFileSync(defPath,'utf8'));
const data=new Uint8Array(fs.readFileSync(romPath));
const rom=ROMObject.create(null,def); rom.disassemble(data);

const mg=rom.monsterGraphics;
// group palettes by graphics object: an object used with several different
// palettes cannot be pinned to a single one (same limitation as FF6's def)
const palsByGfx=new Map();
for(let id=0;id<rom.monsterGraphicsProperties.arrayLength;id++){
  const rec=rom.monsterGraphicsProperties.item(id);
  const g=rec.graphicsPointer.target, p=rec.palettePointer.target;
  if(!g||!p) continue;
  if(!palsByGfx.has(g)) palsByGfx.set(g,new Set());
  palsByGfx.get(g).add(p);
}
let unambiguous=0, bad=0, ambiguous=0, samples=[];
for(const [g,set] of palsByGfx){
  const linked=rom.parsePath(g.palette);
  if(set.size>1){ ambiguous++; if(!set.has(linked)) { bad++; if(bad<4) samples.push({g:g.path,linked:linked&&linked.path,n:set.size}); } continue; }
  unambiguous++;
  const p=[...set][0];
  if(linked!==p){ bad++; if(samples.length<6) samples.push({g:g.path,linked:linked&&linked.path,want:p.path}); }
}
console.log(`graphics objects: ${unambiguous} with a single palette, ${ambiguous} shared across multiple palettes`);
console.log('wrong links:',bad);
samples.forEach(s=>console.log('  ',JSON.stringify(s)));
// sample the first few for eyeballing
for(const i of [0,1,4,88,300]){
  const o=mg.item(i);
  console.log(`  graphics[${i}] ${o.width}x${o.height} palette="${o.palette}" -> ${rom.parsePath(o.palette).range}`);
}
