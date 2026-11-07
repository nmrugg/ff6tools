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

// palette pinning: the ROM table is 8-color sub-palettes (16 bytes, exactly
// the game's LoadMonsterPal unit); each object must be pinned to
// monsterPalette[p], composing p + p+1 when the graphics are 4bpp
for(let k=0;k<items.arrayLength;k++){
  const it=items.item(k);
  const off=it.range.begin-BASE;
  const users=recs.filter(r=>!r.isChar&&r.ptr===off);
  if(!users.length) continue;
  const r=users[0];
  const p=r.isBoss?data[BOSST+r.size*5+2]:r.pal;
  const defs=Array.isArray(it.palette)?it.palette:[it.palette];
  const first=Array.isArray(defs[0])?defs[0][0]:defs[0];
  const mm=typeof first==='string'?first:first.path;
  check(mm===`monsterPalette[${p}]`,`item ${k}: palette ${mm} != monsterPalette[${p}]`);
  if(!r.bpp3){
    const pair=Array.isArray(defs[0])?defs[0]:[];
    check(pair.length===2&&pair[1].offset===8&&pair[1].path===`monsterPalette[${p+1}]`,
      `item ${k}: 4bpp palette not composed from p + p+1`);
  }
}

// ---- 4b. assembled boss windows ------------------------------------------
// every (boss properties record, graphics pool) pair used by a non-character,
// non-placeholder monster needs a bossGraphics_* window; windows with a
// layout must place tiles that exist in the pool
const SKIP=new Set([214]);            // placeholder "Dummy" over the Zeromus pool
const bossRecs=recs.filter(r=>r.isBoss&&!r.isChar&&!SKIP.has(r.i));
const winKeys=Object.keys(rom.assembly).filter(k=>k.startsWith('bossGraphics_'));
const pairs=new Map();
for(const r of bossRecs) pairs.set(`${r.size}:${BASE+r.ptr}`, r);
let windows=0;
for(const key of winKeys){
  const win=rom.assembly[key];
  if(!win.window){ check(false,`${key}: no window`); continue; }
  windows++;
  const pool=win.window.path&&rom.parsePath(win.window.path);
  check(!!pool,`${key}: window path ${win.window.path} unresolvable`);
  if(!pool) continue;
  const bi=Number(key.replace('bossGraphics_','').split('_')[0]);
  const pair=pairs.get(`${bi}:${pool.range.begin}`);
  check(!!pair,`${key}: window for bossProps ${bi} at ${pool.range.begin.toString(16)} matches no boss record`);
  if(!pair) continue;
  const poolTiles=Math.floor(pool.data.length/64);
  check(win.window.tiles<=poolTiles,`${key}: tiles ${win.window.tiles} > pool ${poolTiles}`);
  if(Array.isArray(win.layout)){
    const bpx=BOSST+bi*5;
    const si=data[bpx+1]&0x3F;
    const tw=data[SIZES+si*2], th=data[SIZES+si*2+1];
    // a generator override (Mom Bomb) replaces the US crop with the full
    // JP arrangement - only cross-check grids that match the ROM map size
    if(win.layout.length===tw*th){
      check(win.width===tw&&win.height===th,`${key}: size ${win.width}x${win.height} != ${tw}x${th}`);
    }
    for(const t of win.layout)
      if(t>=poolTiles){ check(false,`${key}: layout tile ${t} outside pool (${poolTiles})`); break; }
  }
}
for(const [pairKey,r] of pairs){
  const found=winKeys.some(k=>{
    const w=rom.assembly[k];
    return k.startsWith(`bossGraphics_${r.size}`)&&w.window&&
      rom.parsePath(w.window.path)&&rom.parsePath(w.window.path).range.begin===BASE+r.ptr;
  });
  check(found,`boss record ${r.i} (bossProps ${r.size}) has no window for its pool`);
}
console.log('boss windows checked:',windows,'for',pairs.size,'boss record/pool pairs');

// ---- 4c. hidden boss pools ----------------------------------------------
// items used only by boss records are hidden from the Monster Graphics tree
// (the assembled Boss Graphics windows present them instead)
const hidden=rom.monsterGraphics.hiddenItems||[];
for(let k=0;k<items.arrayLength;k++){
  const it=items.item(k);
  const off=it.range.begin-BASE;
  const us=recs.filter(r=>!r.isChar&&r.ptr===off);
  const bossOnly=us.length&&us.every(r=>r.isBoss);
  check(hidden.includes(k)===!!bossOnly,
    `item ${k}: hidden=${hidden.includes(k)} but bossOnly=${bossOnly}`);
}
console.log('hidden boss-pool items:',hidden.length);

// ---- 4d. summons ----------------------------------------------------------
// the Summons section lists 15 unique summons; each path must resolve to a
// 3bpp graphics object, either a monster item or a dedicated assembly, and
// dedicated ones must not overlap the monster items
const sec=(rom.hierarchy||[]).find(s=>s.name==='Summons');
check(!!sec,'no Summons section in the hierarchy');
if(sec){
  check(sec.list.length===15,`Summons section has ${sec.list.length} entries, expected 15`);
  const names=new Set(sec.list.map(i=>i.name));
  for(const need of ['Summon: Chocobo','Summon: Shiva','Summon: Ramuh','Summon: Ifrit','Summon: Sylph'])
    check(names.has(need),`Summons section missing ${need}`);
  for(const item of sec.list){
    const o=rom.parsePath(item.path);
    check(!!o&&o.format==='snes3bpp',`${item.name}: path ${item.path} not a 3bpp graphics object`);
    check(!!o&&!!o.palette,`${item.name}: no palette`);
  }
  // dedicated assemblies must not overlap monster items
  const dedicated=sec.list.map(i=>i.path).filter(p=>p.startsWith('summonGraphics_'));
  for(const p of dedicated){
    const o=rom.assembly[p];
    for(let k=0;k<items.arrayLength;k++){
      const it=items.item(k);
      check(o.range.end<=it.range.begin||o.range.begin>=it.range.end,
        `${p} [${o.range}] overlaps item ${k} [${it.range}]`);
    }
  }
  // a summon window must stay inside the graphics item it reads
  for(const item of sec.list){
    const o=rom.assembly[item.path];
    if(!o||!o.window) continue;
    const pool=rom.parsePath(o.window.path);
    check(!!pool,`${item.path}: window path ${o.window.path} unresolvable`);
    if(!pool) continue;
    const poolTiles=Math.floor(pool.data.length/64);
    check(o.window.tiles<=poolTiles,
      `${item.path}: window tiles ${o.window.tiles} > pool ${poolTiles}`);
    if(Array.isArray(o.layout)){
      const hi=Math.max(...o.layout);
      check(hi<o.window.tiles,`${item.path}: layout tile ${hi} >= window tiles ${o.window.tiles}`);
      check(o.layout.length===o.width*o.height,
        `${item.path}: layout ${o.layout.length} != ${o.width}x${o.height}`);
    }
  }
  // re-derive every summon layout from the ROM and require the definition to
  // match. Independent implementation of the same walk: SummonTilemap places
  // block tiles into the 16-wide OBJ tile grid ($80-$FE = blank slot, $FF =
  // end, slots outside the Esper's own block dropped), each of the four
  // animation stages (0x13fa9d -> SummonFramePtrs) draws w*h 16x16 cells from
  // SummonSpritePosTbl where a cell byte names its top-left slot (so the cell
  // covers n, n+1, n+16, n+17), identical stages collapse to one frame, each
  // frame is trimmed to the cells it fills, and frames sit side by side with
  // a blank column between them.
  const SGFX=m(0x0D87F0), STMP=m(0x0DF260), SFRM=m(0x0DF660),
        SPOS=m(0x13FA59), SSETS=m(0x13FA9D), SEND=m(0x0DE818);
  const SNAM=['Imp','Bomb','Cockatrice','Mindflayer','Chocobo','Shiva','Ramuh',
              'Ifrit','Titan','DragonMist','Sylph','Odin','Leviathan','Asura',
              'Asura','Asura','Bahamut'];
  const sblk=[];
  for(let i=0;i<17;i++)
    sblk.push(m(0x0D0000+(data[SGFX+i*2]|(data[SGFX+i*2+1]<<8))));
  const BOSS_BP={8:2,9:0,11:42,12:46,13:54,16:47};
  // layouts the generator bakes from the ripped art instead of deriving from
  // the ROM (Odin's stages draw 9 of 100 tiles); ff4-sfc-artcheck.py checks
  // these against the gifs, and a saved puzzle placement overrides any key
  const BAKED=new Set(['summonGraphics_Odin']);
  const bossByBp={};
  for(const k of Object.keys(rom.assembly)) if(k.startsWith('bossGraphics_')) {
    const bp=Number(k.replace('bossGraphics_','').split('_')[0]);
    if(bossByBp[bp]===undefined) bossByBp[bp]=rom.assembly[k];
  }
  const seenBlk=new Set();
  let composed=0, manual=0, frameCount=0, repeated=0;
  // a saved puzzle placement deliberately overrides the ROM layout
  const PLDIR=path.join(ROOT,'tools/ff4-sfc-puzzle/placements');
  const placed=new Set(fs.existsSync(PLDIR)
    ? fs.readdirSync(PLDIR).filter(f=>f.endsWith('.json')).map(f=>f.slice(0,-5)) : []);
  for(let i=0;i<17;i++){
    if(seenBlk.has(sblk[i])) continue;
    seenBlk.add(sblk[i]);
    const nxt=sblk.filter(b=>b>sblk[i]);
    const end=nxt.length?Math.min(...nxt):SEND;
    const avail=Math.floor((end-sblk[i])/24);
    let p=m(0x0D0000+(data[STMP+i*2]|(data[STMP+i*2+1]<<8))), k=0;
    const slot2tile={};
    for(;;){
      const b=data[p]; p++;
      if(b===0xff) break;
      if(b<0x80){ if(k<avail) slot2tile[b]=k; k++; }
    }
    const gw=data[SPOS+i*4+2], gh=data[SPOS+i*4+3];
    const stageCells=(stage)=>{
      const fset=data[SSETS+i*4+stage];
      let q=m(0x0D0000+(data[SFRM+fset*2]|(data[SFRM+fset*2+1]<<8)));
      const cells=[];
      while(cells.length<gw*gh){
        const b=data[q]; q++;
        if(b===0xff) break;
        if(b===0xfe){ const n=data[q]; q++; for(let j=0;j<n;j++) cells.push(null); }
        else if(b<0x80) cells.push(b);
        else cells.push(null);
      }
      while(cells.length<gw*gh) cells.push(null);
      return cells;
    };
    const stages=[];
    for(let st=0;st<4;st++){
      const c=stageCells(st);
      if(c.some(x=>x!==null) && !stages.some(s=>JSON.stringify(s)===JSON.stringify(c)))
        stages.push(c);
    }
    const drawn=new Set();
    for(const c of stages) for(const x of c) if(x!==null)
      [x,x+1,x+16,x+17].forEach(s=>drawn.add(s));
    const key=`summonGraphics_${SNAM[i]}`;
    const o=rom.assembly[key];
    if(!o){ check(false,`${key}: missing assembly`); continue; }
    if(placed.has(key) || BAKED.has(key)){ manual++; continue; }
    const slots=Object.keys(slot2tile).map(Number);
    const gridLayout=()=>{                       // the OBJ grid placement
      const rows=Math.max(...slots.map(s=>Math.floor(s/16)))+1;
      const g=new Array(16*rows).fill(-1);
      for(const s of slots) g[s]=slot2tile[s];
      const gc=[];
      for(let c=0;c<16;c++) if(g.some((v,j)=>j%16===c&&v>=0)) gc.push(c);
      const c0=Math.min(...gc), c1=Math.max(...gc), lay=[];
      for(let r=0;r<rows;r++) lay.push(...g.slice(r*16+c0,r*16+c1+1));
      return {cols:c1-c0+1, layout:lay};
    };
    // stages that draw almost none of the block (Odin: 9 of 100 tiles): the
    // boss battle map has one whole figure, the OBJ grid has the other poses,
    // so the definition stacks them
    const cover=slots.filter(s=>drawn.has(s)).length/slots.length;
    if(cover*5<1){
      const bp=BOSS_BP[i];
      const bw=bossByBp[bp];
      check(!!bw, `${key}: stages draw nothing and have no boss map`);
      const gl=gridLayout();
      const cols=Math.max(bw.width, gl.cols), rows=[];
      for(let r=0;r<bw.layout.length/bw.width;r++)
        rows.push([...bw.layout.slice(r*bw.width,(r+1)*bw.width), ...new Array(cols-bw.width).fill(-1)]);
      rows.push(new Array(cols).fill(-1));
      for(let r=0;r<gl.layout.length/gl.cols;r++)
        rows.push([...gl.layout.slice(r*gl.cols,(r+1)*gl.cols), ...new Array(cols-gl.cols).fill(-1)]);
      const layout=rows.flat();
      check(o.width===cols&&o.height===rows.length&&
            JSON.stringify(o.layout)===JSON.stringify(layout),
        `${key}: should stack the boss battle map (bossProps ${bp}) over the OBJ grid`);
      composed++; continue;
    }
    // stages that cover under three quarters of the block (Bahamut 71/118):
    // the OBJ grid holds all of his poses whole
    if(cover*4<3){
      const gl=gridLayout();
      check(o.width===gl.cols&&o.height===gl.layout.length/gl.cols&&
            JSON.stringify(o.layout)===JSON.stringify(gl.layout),
        `${key}: stages cover ${(cover*100).toFixed(0)}% of the block, should use the OBJ grid`);
      composed++; continue;
    }
    const orph=slots.filter(s=>!drawn.has(s)).map(s=>[s,slot2tile[s]])
                    .sort((a,b)=>a[1]-b[1]);
    const rects=stages.map(cells=>{
      const rect={};
      cells.forEach((anchor,idx)=>{
        if(anchor===null) return;
        const cr=Math.floor(idx/gw), cc=gw-1-(idx%gw);
        for(let dr=0;dr<2;dr++)for(let dc=0;dc<2;dc++){
          const t=slot2tile[anchor+16*dr+dc];
          if(t!==undefined) rect[(cr*2+dr)+','+(cc*2+dc)]=t;
        }
      });
      // tiles no cell covers attach at their offset from the nearest cell -
      // but only when there are few (Asura's dress hem, Titan's loincloth);
      // many of them are whole extra poses and attaching them shreds the
      // picture (Bahamut)
      if(orph.length<=8) for(const [s,t] of orph){
        const sr=Math.floor(s/16), sc=s%16;
        let near=null;
        cells.forEach((anchor,idx)=>{
          if(anchor===null) return;
          const d=Math.abs(sr-Math.floor(anchor/16))+Math.abs(sc-anchor%16);
          if(!near||d<near[0]) near=[d,idx,anchor];
        });
        if(!near) continue;
        const cr=Math.floor(near[1]/gw), cc=gw-1-(near[1]%gw);
        let r=Math.max(0,Math.min(cr*2+(sr-Math.floor(near[2]/16)), 2*gh+1));
        let c=Math.max(0,Math.min(cc*2+(sc-near[2]%16), 2*gw-1));
        while(rect[r+','+c]!==undefined && rect[r+','+c]!==t){
          c++; if(c>2*gw-1){ c=0; r++; }
          if(r>2*gh+1) break;
        }
        rect[r+','+c]=t;
      }
      return rect;
    }).filter(r=>Object.keys(r).length);
    if(!rects.length){ check(false,`${key}: no frames composed`); continue; }
    const grids=rects.map(r=>{
      const ks=Object.keys(r).map(k=>k.split(',').map(Number));
      return {W:Math.max(...ks.map(k=>k[1]))+1, H:Math.max(...ks.map(k=>k[0]))+1, r};
    });
    let colsN, layout;
    // frames that scatter more than they fill (Dragon Mist's second stage
    // jumps around the grid) read worse than the OBJ grid itself
    if(grids.reduce((a,g)=>a+Object.keys(g.r).length,0)*3 <
       grids.reduce((a,g)=>a+g.W*g.H,0)*2){
      const gl=gridLayout(); colsN=gl.cols; layout=gl.layout;
    } else {
      colsN=grids.reduce((a,g)=>a+g.W,0);
      const rowsN=Math.max(...grids.map(g=>g.H));
      layout=new Array(colsN*rowsN).fill(-1);
      let ox=0;
      for(const g of grids){
        for(const [k,t] of Object.entries(g.r)){
          const [rr,cc]=k.split(',').map(Number);
          layout[rr*colsN+ox+cc]=t;
        }
        ox+=g.W;
      }
    }
    composed++; frameCount+=grids.length;
    const filled=layout.filter(t=>t>=0).length;
    if(filled>new Set(layout.filter(t=>t>=0)).size) repeated++;
    check(o.width===colsN&&o.height===layout.length/colsN,
      `${key}: ${o.width}x${o.height} != ROM layout ${colsN}x${layout.length/colsN}`);
    check(JSON.stringify(o.layout)===JSON.stringify(layout),
      `${key}: layout does not match the composed ROM animation frames`);
  }
  console.log('summon entries checked:',sec.list.length,'| dedicated:',dedicated.length,
              '| frame layouts re-derived:',composed,
              `(${frameCount} frames, ${repeated} of them sharing tiles)`,
              '| overridden by puzzle placements:',manual);
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
