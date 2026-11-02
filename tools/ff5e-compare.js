// Compare decoded monster graphics/palettes across ROMs: original vs painted vs undone.
const fs=require('fs'), path=require('path'); require('./node-dom-stub.js');
const ROOT='/storage/romhacking/ff6tools';
const html=fs.readFileSync(path.join(ROOT,'ff6tools.html'),'utf8');
const files=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]).filter(u=>!/^https?:/.test(u)&&!u.includes('apultra'));
(0,eval)(files.map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')).join('\n;\n'));
const def=JSON.parse(fs.readFileSync(path.join(ROOT,'ff5/ff5e-gba.json'),'utf8'));

function load(p){ const b=new Uint8Array(fs.readFileSync(p)); const r=ROMObject.create(null,JSON.parse(JSON.stringify(def))); r.disassemble(b); return r; }
function snapshot(r){
  const out=[];
  for(let id=0;id<r.monsterGraphicsProperties.arrayLength;id++){
    const rec=r.monsterGraphicsProperties.item(id);
    const g=rec.graphicsPointer.target, p=rec.palettePointer.target;
    out.push([id, g?Array.from(g.data):null, p?Array.from(p.data):null, g?g.width+'x'+g.height:'-', g?g.tiles:'-']);
  }
  return out;
}
const A=load(path.join(ROOT,'Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba'));
const P=load('/tmp/ff5e-demo/painted.gba');
const U=load('/tmp/ff5e-demo/undone.gba');
const sa=snapshot(A), sp=snapshot(P), su=snapshot(U);

function diff(x,y,label){
  const changed=[];
  for(let i=0;i<sa.length;i++){
    const a=JSON.stringify(sa[i]), b=JSON.stringify(y===sp?sp[i]:su[i]);
    if(a!==b) changed.push(i);
  }
  console.log(`${label}: monsters differing = ${changed.length}`, changed.slice(0,10));
  return changed;
}
diff(sa,sp);
const back=diff(sa,su,'original vs UNDONE');
if(back.length) {
  // are the decoded pixels still identical even though stored differently?
  let same=true;
  for(const id of back){
    const a=sa[id], b=su[id];
    if(JSON.stringify(a[1])!==JSON.stringify(b[1])||JSON.stringify(a[2])!==JSON.stringify(b[2])) {same=false; console.log('   monster',id,'content differs');}
  }
  console.log('   undone decoded content identical to original:',same);
}
