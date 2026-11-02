// FF3 (NES, Japan) graphics cross-check.
//   node tools/ff3-nes-xcheck.js [definition.json] [rom.nes]
// (defaults: ff3/ff3j-nes.json and the Japanese dump)
// 1. every assembly range must be inside the ROM and must not overlap another
// 2. the tool's nes2bpp decode must match an independent reference decoder
// 3. battle palettes must decode (and re-encode) exactly
// 4. monster graphics properties must split into size class + index
// 5. an edit must land on exactly the expected file bytes, and undo must be byte-exact
const fs=require('fs'), path=require('path');
require('./node-dom-stub.js');
const ROOT='/storage/romhacking/ff6tools';
const html=fs.readFileSync(path.join(ROOT,'ff6tools.html'),'utf8');
const files=[...html.matchAll(/<script src="([^"]+)"/g)].map(m=>m[1]).filter(u=>!/^https?:/.test(u)&&!u.includes('apultra'));
(0,eval)(files.map(f=>fs.readFileSync(path.join(ROOT,f),'utf8')).join('\n;\n'));

const defPath=process.argv[2]||path.join(ROOT,'ff3/ff3j-nes.json');
const romPath=process.argv[3]||path.join(ROOT,'Final Fantasy III (Japan) (fixed).nes');
const def=JSON.parse(fs.readFileSync(defPath,'utf8'));
const data=new Uint8Array(fs.readFileSync(romPath));
console.log('def:',def.key,'rom:',path.basename(romPath));
const rom=ROMObject.create(null,def); rom.disassemble(data);

let fails=0;
const check=(cond,msg)=>{ console.log((cond?'  ok  ':'  FAIL')+' '+msg); if(!cond) fails++; };
const map=a=>rom.mapAddress(a);

const CLASSES=[
  ['monsterGraphics4x4', 0x208000,0x209000,16, 4, 4],
  ['monsterGraphics4x6', 0x209000,0x219400,24, 4, 6],
  ['monsterGraphics6x6', 0x228000,0x239600,24, 6, 6],
  ['monsterGraphics6x6b',0x248000,0x259600,24, 6, 6],
  ['monsterGraphics6x12',0x268000,0x269200, 4, 6,12],
  ['monsterGraphics12x6',0x269200,0x278400, 4,12, 6],
];

// ---- 1. ranges ----------------------------------------------------------
console.log('assembly ranges:');
{
  const seen=[];
  for(const k of Object.keys(rom.assembly)){
    const a=rom.assembly[k];
    if(a && !a.external && a.range && !a.range.isEmpty) seen.push([k,a.range.begin,a.range.end]);
  }
  let overlaps=0, oob=0;
  seen.sort((x,y)=>x[1]-y[1]);
  for(const [p,b,e] of seen){
    if(e>data.length){ oob++; console.log('    out of ROM:',p,b.toString(16),e.toString(16)); }
  }
  for(let i=1;i<seen.length;i++){
    if(seen[i][1]<seen[i-1][2]){
      overlaps++;
      console.log('    overlap:',seen[i-1][0],seen[i-1][1].toString(16),'-',seen[i-1][2].toString(16),
                  'and',seen[i][0],seen[i][1].toString(16));
    }
  }
  check(oob===0,'all assembly ranges are inside the ROM ('+seen.length+' ranges)');
  check(overlaps===0,'no overlapping assembly trees ('+overlaps+' overlaps)');
}

// ---- 2. graphics decode parity -----------------------------------------
console.log('monster graphics decode vs independent nes2bpp reference:');
{
  let tiles=0, bad=0, firstBad=null;
  for(const [key,begin,end,count,w,h] of CLASSES){
    const arr=rom.parsePath(key);
    if(!arr||arr.arrayLength!==count){ check(false,key+' arrayLength'); continue; }
    if(arr.range.begin!==map(begin)||arr.range.end!==map(end)){
      check(false,key+' range '+arr.range+' expected '+map(begin).toString(16)+'-'+map(end).toString(16));
      continue;
    }
    for(let i=0;i<count;i++){
      const g=arr.item(i);
      if(g.width!==w||g.height!==h){ check(false,key+'['+i+'] size '+g.width+'x'+g.height); continue; }
      for(let t=0;t<w*h;t++){
        const f=arr.range.begin+i*w*h*16+t*16;
        for(let y=0;y<8;y++) for(let x=0;x<8;x++){
          const lo=data[f+y], hi=data[f+8+y], bit=7-x;
          const ref=((hi>>bit)&1)*2+((lo>>bit)&1);
          const got=g.data[t*64+y*8+x];
          tiles++;
          if(got!==ref&&!firstBad) firstBad={key,i,t,x,y,got,ref};
          if(got!==ref) bad++;
        }
      }
    }
  }
  check(bad===0,`${tiles} pixels compared, ${bad} mismatches${firstBad?' first='+JSON.stringify(firstBad):''}`);
}

// ---- 3. battle palettes -------------------------------------------------
console.log('battle palettes:');
{
  const p=rom.parsePath('battlePalettes');
  check(p&&p.arrayLength===256,'256 palettes ('+(p?p.arrayLength:0)+')');
  let bad=0, badEnc=0, rawEncDiff=0;
  for(let i=0;i<256;i++){
    const pal=p.item(i);
    if(pal.data.length!==4){ bad++; continue; }
    const base=p.range.begin+i*3;
    // colour 0 is fixed black, colours 1-3 come from the three ROM bytes
    if((pal.data[0]>>>0)!==0xFF000000) bad++;
    for(let c=0;c<3;c++){
      const nes=data[base+c]&0x3F;
      const rgb=GFX.colorsNES[nes];
      const want=(0xFF000000|(rgb[2]<<16)|(rgb[1]<<8)|rgb[0])>>>0;
      if((pal.data[c+1]>>>0)!==want) bad++;
    }
    // re-encoding must round-trip to the same colours (the NES palette has
    // duplicate blacks, so the raw byte index is not always preserved - the
    // pristine byte cache is what keeps the ROM byte-identical)
    const enc=GFX.paletteFormat.nesFixedPalette.encode(pal.data)[0];
    if(enc.length!==3) badEnc++;
    else{
      const back=GFX.paletteFormat.nesFixedPalette.decode(enc)[0];
      for(let c=0;c<4;c++) if((back[c]>>>0)!==(pal.data[c]>>>0)) badEnc++;
      if(enc[0]!==(data[base]&0x3F)) rawEncDiff++;
    }
  }
  check(bad===0,'all 256 palettes decode correctly (colour 0 = black)');
  check(badEnc===0,'all 256 palettes survive a decode/encode round trip');
  console.log(`       (${rawEncDiff} palettes re-encode to a different but visually identical NES colour)`);
  // the fixed palette format must be registered
  check(!!ROM.dataFormat.nesFixedPalette,'nesFixedPalette is registered as a data format');
}

// ---- 4. monster graphics properties -------------------------------------
console.log('monster graphics properties:');
{
  const props=rom.parsePath('monsterGraphicsProperties');
  check(props&&props.arrayLength===256,'256 records ('+(props?props.arrayLength:0)+')');
  let bad=0;
  for(let i=0;i<256;i++){
    const r=props.item(i), raw=data[props.range.begin+i];
    if(r.graphicsSize.value!==(raw>>5)||r.graphicsID.value!==(raw&0x1F)) bad++;
  }
  check(bad===0,'graphicsSize/graphicsID split every byte correctly');
  // names come from the ROM's own monster-name strings (text $520 = monster 0)
  const s=rom.stringTable[props.stringTable];
  const monster0=rom.text.item(0x520).formattedText.trim();
  check(s&&s.string[0].fString()===monster0,'record 0 is named from the ROM: '+(s?JSON.stringify(s.string[0].fString())+' == '+JSON.stringify(monster0):'?'));
  const g4=rom.stringTable[rom.parsePath('monsterGraphics4x4').stringTable];
  // monsters using class 0, index 1 (props byte == 1)
  const users=[];
  for(let i=0;i<256;i++) if(data[props.range.begin+i]===1) users.push(i);
  const userNames=users.map(m=>rom.text.item(0x520+m).formattedText.trim());
  const g4name=g4?g4.string[1].fString():'';
  check(userNames.length>0&&userNames.every(n=>g4name.includes(n)),
    `4x4 graphic 1 is named after its ${userNames.length} monsters: ${JSON.stringify(g4name)} (want ${JSON.stringify(userNames)})`);
}

// ---- 5. per-graphic palettes -------------------------------------------
console.log('per-graphic palettes:');
{
  const CL=[['monsterGraphics4x4',0],['monsterGraphics4x6',1],['monsterGraphics6x6',2],
            ['monsterGraphics6x6b',3],['monsterGraphics6x12',4],['monsterGraphics12x6',5]];
  const props=rom.parsePath('monsterGraphicsProperties');
  let applied=0, wrong=0, distinct=0, firstWrong=null;
  for(const [key,cls] of CL){
    const arr=rom.parsePath(key);
    const seen=new Set();
    for(let i=0;i<arr.arrayLength;i++){
      const g=arr.item(i);
      const pal=g.palette;
      const first=Array.isArray(pal)?pal[0]:pal;
      const path=typeof first==='string'?first:first.path;
      if(!/^battlePalettes\[\d+\]$/.test(path)){ wrong++; if(!firstWrong)firstWrong={key,i,path}; continue; }
      applied++;
      seen.add(path);
      // the palette must be one that a battle group containing this monster uses
      const id=Number(path.match(/\[(\d+)\]/)[1]);
      const users=[];
      for(let m=0;m<256;m++) if((props.item(m).graphicsSize.value===cls)&&(props.item(m).graphicsID.value===i)) users.push(m);
      if(!users.length) continue;
      const setBase=rom.mapAddress(0x2E8400);
      let ok=false;
      for(let s=0;s<256;s++){
        const a1=data[setBase+s*6], a2=data[setBase+s*6+1];
        const ids=[data[setBase+s*6+2],data[setBase+s*6+3],data[setBase+s*6+4],data[setBase+s*6+5]];
        if(ids.some(m=>users.includes(m)) && (a1===id||a2===id)) { ok=true; break; }
      }
      if(!ok){ wrong++; if(!firstWrong) firstWrong={key,i,path,users}; }
    }
    distinct+=seen.size;
  }
  check(wrong===0,`${applied} monster graphics have a palette, ${wrong} not backed by a battle group`
        +(firstWrong?' first='+JSON.stringify(firstWrong):''));
  check(distinct>20,`${distinct} distinct (array, palette) defaults - not one shared palette`);

  const chars=rom.parsePath('battleCharacterGraphics');
  check(chars.item(0).width===2&&chars.item(0).height===21,
    `character graphics are 2 tiles wide (was 14, which scrambled the poses): ${chars.item(0).width}x${chars.item(0).height}`);
  const jobPal=data[rom.mapAddress(0x2E9E4E)+1];       // job 1 (Warrior) sprite palette id
  const want=`battlePalettes[${0xFC+jobPal}]`;
  const got=(Array.isArray(chars.item(1).palette)?chars.item(1).palette[0]:chars.item(1).palette);
  check((typeof got==='string'?got:got.path)===want,`job 1 defaults to its own palette: ${got.path||got} (want ${want})`);
}

// ---- 6. boss graphics ---------------------------------------------------
console.log('boss graphics:');
{
  const ptrs=rom.parsePath('bossGraphicsPointers');
  check(ptrs&&ptrs.arrayLength===24,'24 boss graphics pointers');
  const raw=data.slice(rom.mapAddress(0x2E9068), rom.mapAddress(0x2E9098));
  let bad=0;
  for(let i=0;i<24;i++){
    const p=ptrs.item(i);
    const lo=raw[2*i], hi=raw[2*i+1];
    // the tool combines multi-byte properties big-endian, so a 0x3FF mask
    // yields the game's 10-bit tile index
    if(p.tileIndex.value !== (((hi<<8)|lo)&0x3FF)) bad++;
    if(p.graphicsBank.value!==(hi&3)) bad++;
    if(!!p.useSummonGraphics.value!==!!((hi>>2)&1)) bad++;
  }
  check(bad===0,'pointer properties decode (tileIndex / graphicsBank / useSummonGraphics)');

  let badMaps=0, badOffset=0, resolved=0, detail=null;
  for(let i=0;i<24;i++){
    const tm=rom.parsePath('bossTilemap'+i);
    if(!tm||tm.constructor.name!=='ROMTilemap'){ badMaps++; continue; }
    const begin=rom.mapAddress(0x2A8000)+i*216;
    for(let t=0;t<216;t++) if(tm.data[t]!==data[begin+t]) { badMaps++; break; }
    const lo=raw[2*i], hi=raw[2*i+1];
    const tile=((hi&3)<<8)|lo, bank=((hi>>2)&1)?0x0C:((hi&3)*2+0x20);
    const poolFile=rom.mapAddress(bank*0x10000+0x8000+tile*16);
    const gpath=(typeof tm.graphics==='string')?tm.graphics:tm.graphics.path;
    const g=rom.parsePath(gpath);
    if(!g||!g.range){ badOffset++; continue; }
    resolved++;
    // pattern tile 0x70 in the tilemap is the pool base, so
    // (0x70 + tileOffset) must be the pool base's tile index in `graphics`
    const baseTile=(poolFile-g.range.begin)/16;
    if(tm.tileOffset+0x70!==baseTile){
      badOffset++;
      if(!detail) detail={i, graphics:tm.graphics, tileOffset:tm.tileOffset, want:baseTile-0x70};
    }
  }
  check(badMaps===0,'all 24 boss tilemaps decode their 216 tile ids from the ROM');
  check(resolved===24,'every boss tilemap resolves a graphics array ('+resolved+'/24)');
  check(badOffset===0,'every boss tileOffset matches its pointer ('+badOffset+' wrong)'+(detail?' '+JSON.stringify(detail):''));
}

// ---- 7. edit round trip + byte-exact undo -------------------------------
console.log('edit round trip:');
{
  const arr=rom.parsePath('monsterGraphics6x6');
  const g=arr.item(3);
  const tile=5, row=2, px=0;
  const fileOffset=arr.range.begin+3*6*6*16+tile*16+row;      // low plane of that pixel
  const fileOffset2=fileOffset+8;                              // high plane of that pixel
  const edited=Uint8Array.from(g.data);
  edited[tile*64+row*8+px]=edited[tile*64+row*8+px]^0x03;      // flip both bit planes
  g.replaceData(edited);
  g.markAsDirty();
  const ok=rom.assemble();
  const asm=Buffer.from(rom.data.buffer,rom.data.byteOffset,rom.data.length);
  const orig=Buffer.from(data.buffer,data.byteOffset,data.length);
  const changed=[];
  for(let i=0;i<orig.length;i++) if(orig[i]!==asm[i]) changed.push(i);
  const want=[fileOffset,fileOffset2];
  check(ok&&changed.length===2&&changed.every((c,n)=>c===want[n]),
    `assemble after edit: ok=${ok}, bytes changed=[${changed.map(c=>'0x'+c.toString(16)).join(',')}] `+
    `expected=[${want.map(c=>'0x'+c.toString(16)).join(',')}]`);
  const rom2=ROMObject.create(null,def); rom2.disassemble(new Uint8Array(asm));
  const g2=rom2.parsePath('monsterGraphics6x6').item(3);
  check(g2.data[tile*64+row*8+px]===edited[tile*64+row*8+px],
    `reloaded ROM keeps the edit (${g2.data[tile*64+row*8+px]} = ${edited[tile*64+row*8+px]})`);
  // undo must restore the file byte-for-byte
  rom.undo();
  rom.assemble();
  const asm2=Buffer.from(rom.data.buffer,rom.data.byteOffset,rom.data.length);
  let diffs=0; for(let i=0;i<orig.length;i++) if(orig[i]!==asm2[i]) diffs++;
  check(diffs===0,'undo restores the ROM byte-for-byte ('+diffs+' diffs)');
}

console.log(fails?`\nFAILED: ${fails} check(s)`:'\nall checks passed');
process.exit(fails?1:0);
