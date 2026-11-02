// Generate the stringTable entries for monsterGraphics / monsterPalettes:
// for each de-duplicated graphics (or palette) set, list the monster names
// that reference it, the way ff6e-gba.json does.
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

// monster display name + graphics id for a monsterProperties index
function textOf(o){
  if(!o) return null;
  let t='';
  try{ t=o.fString? o.fString() : (o.htmlText||o.value||''); }catch(e){ t=''; }
  t=String(t).replace(/<[^>]*>/g,'').replace(/&[a-z]+;/g,'').replace(/\s+/g,' ').trim();
  return t||null;
}
function entryInfo(idx){
  const it=rom.monsterProperties.item(idx);
  const n=it.monsterName;             // resolves only for normal monsters
  if(n){ const t=textOf(n); return t? {name:t, gid:it.monsterID.value} : null; }
  const b=it.bossName||it.bossNameGBA;
  if(b){ const t=textOf(b); return t? {name:t, gid:it.monsterIDBoss.value-256} : null; }
  return null;
}
function namesFor(pointerPath){
  const usersByGid=new Map();
  for(let m=0;m<rom.monsterProperties.arrayLength;m++){
    const info=entryInfo(m);
    if(!info||info.gid<0||info.gid>=rom.monsterGraphicsProperties.arrayLength) continue;
    if(!usersByGid.has(info.gid)) usersByGid.set(info.gid,[]);
    usersByGid.get(info.gid).push(info.name);
  }
  const byTarget=new Map();
  for(let id=0;id<rom.monsterGraphicsProperties.arrayLength;id++){
    const t=rom.monsterGraphicsProperties.item(id)[pointerPath].target;
    if(!t) continue;
    if(!byTarget.has(t.i)) byTarget.set(t.i,new Set());
    for(const n of (usersByGid.get(id)||[])) if(n) byTarget.get(t.i).add(n);
  }
  const out={};
  for(const [i,set] of byTarget){
    const names=[...set];
    if(!names.length) continue;
    out[i]=names.length>8? `${names.length} monsters (shared graphics)` : names.slice(0,8).join(', ');
  }
  return out;
}
const gfx=namesFor('graphicsPointer');
const pal=namesFor('palettePointer');
console.log('graphics named:',Object.keys(gfx).length,'palettes named:',Object.keys(pal).length);
console.log(JSON.stringify(Object.fromEntries(Object.entries(gfx).slice(0,12)),null,1));
fs.writeFileSync('/tmp/gfx-names.json',JSON.stringify(gfx));
fs.writeFileSync('/tmp/pal-names.json',JSON.stringify(pal));
console.log('wrote /tmp/gfx-names.json /tmp/pal-names.json');
