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
      // the palette is a list of composed pairs: [[pal1,pal2], [pal1,pal2], ...,
      // battlePalettes] - one dropdown entry per colouring its battles use
      const firstPair=Array.isArray(pal)?(Array.isArray(pal[0])?pal[0]:[pal[0]]):null;
      if(!firstPair){ wrong++; if(!firstWrong)firstWrong={key,i,path:pal}; continue; }
      applied++;
      for(const d of firstPair){
        const path=typeof d==='string'?d:d.path;
        if(!/^battlePalettes\[\d+\]$/.test(path)){ wrong++; if(!firstWrong)firstWrong={key,i,path}; continue; }
        seen.add(path);
      }
      const users=[];
      for(let m=0;m<256;m++) if((props.item(m).graphicsSize.value===cls)&&(props.item(m).graphicsID.value===i)) users.push(m);
      if(!users.length) continue;
      const ids=firstPair.map(d=>Number((d.path||'').match(/\[(\d+)\]/)[1]));
      const setBase=rom.mapAddress(0x2E8400);
      let ok=false;
      for(let s=0;s<256;s++){
        const a1=data[setBase+s*6], a2=data[setBase+s*6+1];
        const mids=[data[setBase+s*6+2],data[setBase+s*6+3],data[setBase+s*6+4],data[setBase+s*6+5]];
        if(mids.some(m=>users.includes(m)) && ids.every(x=>x===a1||x===a2)) { ok=true; break; }
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
    // bbs---tt tttttttt: bits 1-0 (+ low byte) = tile index, bits 7-6 = bank,
    // bit 5 = summon flag. ROMProperty reads multi-byte values little-endian.
    if(p.tileIndex.value !== (((hi<<8)|lo)&0x3FF)) bad++;
    if(p.graphicsBank.value!==((hi>>6)&3)) bad++;
    if(!!p.useSummonGraphics.value!==!!((hi>>5)&1)) bad++;
  }
  check(bad===0,'pointer properties decode (tileIndex / graphicsBank / useSummonGraphics)');

  let badMaps=0, badOffset=0, resolved=0, detail=null;
  for(let i=0;i<24;i++){
    const tm=rom.parsePath('bossTilemap'+i);
    if(!tm||tm.constructor.name!=='ROMTilemap'){ badMaps++; if(!detail) detail={i, why:'no tilemap'}; continue; }
    const begin=rom.mapAddress(0x2A8000)+i*216;
    const lo=raw[2*i], hi=raw[2*i+1];
    const tile=((hi&3)<<8)|lo, bank=((hi>>5)&1)?0x0C:(0x20+2*((hi>>6)&3));
    const poolFile=bank*0x2000+tile*16+0x10;   // 16 KiB window, file space
    const gpath=(typeof tm.graphics==='string')?tm.graphics:tm.graphics.path;
    const g=rom.parsePath(gpath);
    if(!g||!g.range){ badOffset++; continue; }
    resolved++;
    // ff3BossTilemap maps 0x70-0xff to tiles 0-143, and the graphics
    // definition's range must scope the pool to exactly those 144 tiles
    // (64 decoded bytes per NES 2bpp tile) starting at the pointer's tile.
    const baseTile=(poolFile-g.range.begin)/16;
    const gr=ROMRange.parse(tm.graphics.range);
    if(gr.begin!==baseTile*64 || gr.end!==(baseTile+0x90)*64){
      badOffset++;
      if(!detail) detail={i, graphics:gpath, range:tm.graphics.range,
                          want:[baseTile*64,(baseTile+0x90)*64]};
    }
    for(let t=0;t<216;t++){
      const v=data[begin+t];
      // 0x70-0xff address the pool; below that the game leaves a battle
      // background tile in the nametable, and the format keeps that byte
      // verbatim as 0x100|byte so editing one cell cannot clobber it
      const want=(v>=0x70)?(v-0x70):(0x100|v);
      if(tm.data[t]!==want){ badMaps++; if(!detail) detail={i,cell:t,got:tm.data[t],want,raw:v}; break; }
    }
  }
  check(badMaps===0,'all 24 boss tilemaps decode their 216 tile ids from the ROM'+(detail?' -- '+JSON.stringify(detail):''));
  check(resolved===24,'every boss tilemap resolves a graphics array ('+resolved+'/24)');
  check(badOffset===0,'every boss tileOffset matches its pointer ('+badOffset+' wrong)'+(detail?' '+JSON.stringify(detail):''));
}

// ---- 7. summons ---------------------------------------------------------
console.log('summon graphics:');
{
  const sp=rom.parsePath('summonProperties');
  check(sp&&sp.arrayLength===8,'8 summon graphics properties');
  const raw=data.slice(rom.mapAddress(0x2A9440), rom.mapAddress(0x2A9480));
  let bad=0, maps=0, why=[];
  const fail=(m)=>{bad++; if(why.length<4) why.push(m);};
  for(let i=0;i<8;i++){
    const p=sp.item(i), b=i*8;
    if(p.width.value!==(raw[b+4]>>4)) fail(i+': width '+p.width.value+' != '+(raw[b+4]>>4));
    if(p.height.value!==(raw[b+4]&0x0F)) fail(i+': height');
    if(p.tilemapPointer.value!==((raw[b+6]|(raw[b+7]<<8)))) fail(i+': ptr '+p.tilemapPointer.value.toString(16));
    if(p.graphicsIndex.value!==raw[b]) fail(i+': gfxIndex');
    const tm=rom.parsePath('summonTilemap'+i);
    if(!tm){ fail(i+': no tilemap'); continue; }
    maps++;
    const cells=(raw[b+4]>>4)*(raw[b+4]&0x0F);
    if(tm.width!==(raw[b+4]>>4)||tm.height!==(raw[b+4]&0x0F)) fail(i+': tilemap dims');
    if(tm.data.length!==cells) fail(i+': data len '+tm.data.length+' != '+cells);
    const begin=rom.mapAddress(0x2A8000)+(raw[b+6]|(raw[b+7]<<8))-0x8000;
    for(let t=0;t<cells;t++){
      const v=data[begin+t];
      const want=(v===0xFF)?0xFF00:((v&0x3F) | ((((v>>6)&3)*4)<<16));
      if(tm.data[t]!==want) { fail(i+': cell '+t+' = '+tm.data[t]+' want '+want+' (raw '+v+')'); break; }
    }
    const gpath=(typeof tm.graphics==='string')?tm.graphics:tm.graphics.path;
    if(gpath!=='summonGraphics') fail(i+': graphics '+gpath);
    if(tm.tileOffset!==raw[b]) fail(i+': tileOffset '+tm.tileOffset+' != '+raw[b]);
  }
  check(bad===0,`summon properties + ${maps} tilemaps decode (6-bit tile ids, 0xff blank, tileOffset = graphicsIndex)`+
        (why.length?' -- '+why.join('; '):''));

  // palette pairs per monster graphic: each entry in the dropdown is one
  // composed pair, so a graphic that fights in several colourings offers them
  // all (Dark Cloud's forms, a monster and its boss version, ...)
  const CL=['monsterGraphics4x4','monsterGraphics4x6','monsterGraphics6x6',
            'monsterGraphics6x6b','monsterGraphics6x12','monsterGraphics12x6'];
  let pairs=0, singles=0, named=0, multi=0, maxPairs=0;
  for(const key of CL){
    const arr=rom.parsePath(key);
    for(let i=0;i<arr.arrayLength;i++){
      const pal=arr.item(i).palette;
      if(!Array.isArray(pal)) { singles++; continue; }
      const entries=pal.filter(p=>Array.isArray(p)&&p.length);
      const whole=pal.filter(p=>p&&p.compose);
      if(entries.length&&entries[0].filter(p=>p&&p.compose).length>=2) pairs++; else singles++;
      if(entries.every(p=>p.every(d=>d&&d.name))) named++;
      if(entries.length>1) multi++;
      maxPairs=Math.max(maxPairs,entries.length);
    }
  }
  check(pairs>60,`${pairs} monster graphics carry two composed palettes, ${singles} a single one`);
  check(named>pairs-4,`${named} of those have named palette entries (so the dropdown says whose palettes they are)`);
  check(multi>10,`${multi} graphics offer more than one palette pair (up to ${maxPairs}) - the forms are switchable`);

  // per-cell palette selection: most monster graphics use both palettes, so
  // they carry a cell map ('0'/'1' per 2x2 tile cell, from $2E:$8F20)
  let withCells=0, twoTone=0;
  for(const key of CL){
    const arr=rom.parsePath(key);
    for(let i=0;i<arr.arrayLength;i++){
      const cells=arr.item(i).attributeCells;
      if(cells&&cells.length){ withCells++; if(/[01]/.test(cells)&&/[0]/.test(cells)&&/[1]/.test(cells)) twoTone++; }
    }
  }
  check(withCells===96,`${withCells}/96 monster graphics carry palette cell maps`);
  check(twoTone>0,`${twoTone} of them actually mix both palettes (the rest are single-palette)`);

  // the custom tile formats must survive encode->decode. The boss format is
  // byte-exact for every cell (background cells are kept as 0x100|byte in the
  // tile word); a summon's 0xff cells stay 0xff.
  const checkFmt=(fmt,name,blank)=>{
    let lossy=0, blanks=0;
    for(let i=0;i<(name==='boss'?24:8);i++){
      const tm=rom.parsePath(name+'Tilemap'+i);
      const raw=data.slice(tm.range.begin, tm.range.end);
      const back=fmt.encode(fmt.decode(raw)[0])[0];
      for(let t=0;t<raw.length;t++){
        if(raw[t]===blank||back[t]===blank){ blanks++; continue; }
        if(back[t]!==raw[t]) { lossy++; break; }
      }
    }
    check(lossy===0,`${name} tilemap format round-trips every sprite tile byte-exactly (${blanks} blank cells)`);
  };
  checkFmt(GFX.tileFormat.ff3SummonTilemap,'summon',0xFF);
  checkFmt(GFX.tileFormat.ff3BossTilemap,'boss',0xFF);   // 0xff is never a boss cell byte now

  }

  // the boss format must be *lossless*, background cells included: 3F/F90A
  // copies all 216 bytes into the nametable, so a background tile id written
  // as 0 would change the battle background around the boss
  {
    let diffs=0, cells=0;
    for(let i=0;i<24;i++){
      const tm=rom.parsePath('bossTilemap'+i);
      const raw=data.slice(tm.range.begin, tm.range.end);
      const back=GFX.tileFormat.ff3BossTilemap.encode(GFX.tileFormat.ff3BossTilemap.decode(raw)[0])[0];
      for(let t=0;t<raw.length;t++){ cells++; if(back[t]!==raw[t]) diffs++; }
    }
    check(diffs===0,`boss tilemaps round-trip all ${cells} cells byte-exactly (${diffs} changed)`);
  }

// ---- 7b. palette cell (attribute) tables --------------------------------
console.log('palette cell tables:');
{
  // 2F/A0E7: the record index is (props & $1F) + a per-class offset, NOT
  // props & $3F - that is what makes the tables tile perfectly from $8F20 to
  // $9027. Re-derive every record from the ROM and compare with what the
  // definition says, independently of the generator.
  const BASE=[0x2E8F20,0x2E8F20,0x2E8F48,0x2E8F48,0x2E8FA8,0x2E8FB4];
  const SIZE=[1,1,2,2,3,3];
  const IDOFF=[0,0x10,0,0x18,0,0];
  const SLOT=[[4,6],[4,6],[6,6],[6,6],[6,12],[12,6]];   // formation slot, 2F/A5E6
  const INVERT=rom.mapAddress(0x2E8F00);
  // 2F/A133-2F/A141 shifts $8F00[id>>3] left (id&7)+1 times and then tests bit
  // 7 of A, so the invert flag is bit (6-(id&7)) - and 0 when id&7 == 7
  const invertFlag=(m)=>(((data[INVERT+(m>>3)]<<((m&7)+1))>>7)&1)?true:false;
  const props=data.slice(rom.mapAddress(0x2E8B00), rom.mapAddress(0x2E8C00));
  const CL=['monsterGraphics4x4','monsterGraphics4x6','monsterGraphics6x6',
            'monsterGraphics6x6b','monsterGraphics6x12','monsterGraphics12x6'];
  let bad=0, checked=0, why=[];
  for(let c=0;c<6;c++){
    const arr=rom.parsePath(CL[c]);
    for(let i=0;i<arr.arrayLength;i++){
      const item=arr.item(i), ref=item.attributeRef;
      if(!ref){ bad++; if(why.length<3) why.push(CL[c]+'['+i+'] has no attributeRef'); continue; }
      // find a monster that uses this graphic
      const users=[]; for(let m=0;m<256;m++) if((props[m]>>5)===c && (props[m]&0x1F)===i) users.push(m);
      if(!users.length) continue;
      const m=users[0], p=props[m];
      const id=(p&0x1F)+IDOFF[c];
      const addr=rom.mapAddress(BASE[c])+id*SIZE[c];
      const cols=SLOT[c][0]/2, rows=SLOT[c][1]/2;
      let want='';
      for(let k=0;k<cols*rows;k++){
        const b=data[addr+(k>>3)];
        want+=((b>>(7-(k&7)))&1).toString();
      }
      if(ref.cells!==want){ bad++; if(why.length<3) why.push(CL[c]+'['+i+'] cells '+ref.cells+' want '+want); continue; }
      const flags=users.map(invertFlag);
      if(!flags.includes(!!ref.invert)){ bad++; if(why.length<3) why.push(CL[c]+'['+i+'] invert '+ref.invert+' want one of '+flags); }
      if(new Set(flags).size===1 && !!ref.invert!==flags[0]){ bad++; if(why.length<3) why.push(CL[c]+'['+i+'] invert '+ref.invert+' want '+flags[0]); }
      // a 4x4 monster stands in a 4x6 slot, two tile rows lower (2F/A2D0:
      // first tile id $70, but 4x4 graphics load at PPU $0780)
      const skip=((SLOT[c][1]-[4,6,6,6,12,6][c])/2)*cols;
      if((ref.offset||0)!==skip){ bad++; if(why.length<3) why.push(CL[c]+'['+i+'] offset '+ref.offset+' want '+skip); }
      checked++;
    }
  }
  check(bad===0,`${checked} monster graphics: cell record, invert bit and slot offset match the ROM`+(why.length?' -- '+why.join('; '):''));

  // the tables themselves are in the definition and owned by exactly one
  // assembly each, so they can be edited
  const mad=rom.parsePath('monsterAttributeData'), bad2=rom.parsePath('bossAttributeData');
  check(mad&&mad.arrayLength===192&&mad.range.begin===rom.mapAddress(0x2E8F00),
        `monsterAttributeData covers $2E:$8F00-$8FC0 (${mad&&mad.arrayLength} bytes)`);
  check(bad2&&bad2.arrayLength===24&&bad2.range.begin===rom.mapAddress(0x2E8FC0),
        `bossAttributeData covers $2E:$8FC0-$9028 (${bad2&&bad2.arrayLength} x 7 bytes)`);
  // $8F00 is a bit per monster id, and every boss id has it set
  let inv=0; for(let m=0x80;m<0x100;m++) inv+=invertFlag(m)?1:0;
  check(inv===112,`the invert flag is set for ${inv} of the 128 boss monster ids (not the 16 with id&7==7)`);
  let invLow=0; for(let m=0;m<0x80;m++) invLow+=invertFlag(m)?1:0;
  check(invLow===0,`and for none of the $00-$7F ids (${invLow}); the 16 with id&7==7 are not inverted`);

  // bosses: 18x12 tiles = 9x6 cells in 7 bytes, read the same way (2F/A820)
  let badBoss=0, bossCells=0;
  for(let i=0;i<24;i++){
    const tm=rom.parsePath('bossTilemap'+i);
    const ref=tm.attributeRef;
    if(!ref||ref.cells.length!==54||ref.bytes!==7){ badBoss++; continue; }
    const addr=rom.mapAddress(0x2E8FC0)+i*7;
    let want='';
    for(let k=0;k<54;k++){ const b=data[addr+(k>>3)]; want+=((b>>(7-(k&7)))&1).toString(); }
    if(ref.cells!==want) badBoss++;
    bossCells++;
  }
  check(badBoss===0,`${bossCells}/24 boss tilemaps have their 54 palette cells from $2E:$8FC0`);
}

// ---- 8. edit round trip + byte-exact undo -------------------------------
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
