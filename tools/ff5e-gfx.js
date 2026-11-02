#!/usr/bin/env node
/*
 ff5e-gfx.js — extract / preview Final Fantasy V Advance (Europe) GBA monster graphics.

 Format chain (exactly as ff6tools describes it in ff5/ff5e-gba.json):
   storage order: gba-lzss  ->  tose-graphics (8-byte header: u32 mode=1, u32 tile count)
                  ->  linear4bpp (GBA tile: 32 bytes, row-major, low nibble = left pixel)
 Palettes:        tose-palette (8-byte header: u32 mode=3, u32 colour count) -> bgr555
 Per-monster size: monsterSize[id] = {u8 width/8, u8 height/8, ...}
 Pointer table:  1472 dwords at 0x08131C14; even = graphics, odd = palette (id*2, id*2+1)

 Usage:
   node tools/ff5e-gfx.js atlas [out.png]        labelled atlas of all 736 graphics sets
   node tools/ff5e-gfx.js show  id [id ...]      zoomed sheet
   node tools/ff5e-gfx.js png   id [outdir]      one indexed PNG per monster (+ palette)
*/
const fs=require('fs'), zlib=require('zlib');
const ROM_PATH=process.env.FF5E_ROM||'/storage/romhacking/ff6tools/Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba';
const rom=fs.readFileSync(ROM_PATH);
const BASE=0x08000000;
const PT=0x08131C14, SIZE=0x08147C30, NMON=736;
const ptr=i=>rom.readUInt32LE(PT-BASE+i*4);
const bytes=(addr,len)=>new Uint8Array(rom.buffer,rom.byteOffset+(addr-BASE),len);

// ---- gba-lzss (port of ff6tools rom/romtools.js "gba-lzss".decode) ----
function lzss(src){
  let s=0,d=0;const out=new Uint8Array(0x40000),win=new Uint8Array(0x1000);let wp=0;
  const line=new Uint8Array(18);
  const type=src[s++];
  if(type===0x30||type===0x31){const big=type===0x31;const len=big?src.readUInt32LE(1):(src[1]|(src[2]<<8)|(src[3]<<16));return src.slice(big?5:4,(big?5:4)+len);}
  if(type!==0x10) throw new Error('not LZSS: 0x'+type.toString(16));
  const length=src[s++]|(src[s++]<<8)|(src[s++]<<16);
  while(d<length){
    let header=src[s++];
    for(let p=0;p<8;p++,header<<=1){
      let l=0;
      if(header&0x80){
        let w=(src[s++]<<8)|src[s++]; const r=(w>>12)+3; w=(w&0xFFF)+1;
        for(let i=0;i<r;i++){const c=win[(wp-w)&0xFFF];line[l++]=c;win[wp++]=c;wp&=0xFFF;}
      }else{const c=src[s++];line[l++]=c;win[wp++]=c;wp&=0xFFF;}
      out.set(line.subarray(0,l),d); d+=l; if(d>=length) break;
    }
  }
  return out.slice(0,d);
}
function toseGraphics(buf){
  const u32=new Uint32Array(buf.buffer,buf.byteOffset,2);
  if(u32[0]!==1) throw new Error('tose mode '+u32[0]);
  return {tiles:u32[1], data:buf.slice(8)};
}
function tosePalette(buf){
  const u32=new Uint32Array(buf.buffer,buf.byteOffset,2);
  if(u32[0]!==3) throw new Error('tose palette mode '+u32[0]);
  const u16=new Uint16Array(buf.buffer,buf.byteOffset+8,u32[1]);
  return Array.from(u16).map(v=>[(v&31)<<3,((v>>5)&31)<<3,((v>>10)&31)<<3]);
}
// GBA 4bpp tile: 32 bytes, 4 bytes per row, low nibble = left pixel
const pixel=(gfx,tile,x,y)=>{const v=gfx[tile*32+y*4+(x>>1)];return (x&1)?(v>>4):(v&15);};

function monster(id){
  const comp=lzss(bytes(ptr(id*2),0x40000));
  const g=toseGraphics(comp);
  const w=rom[SIZE-BASE+id*4], h=rom[SIZE-BASE+id*4+1];
  const pal=tosePalette(bytes(ptr(id*2+1),0x100));
  if(g.tiles!==w*h) console.warn(`  warning: monster ${id} declares ${w}x${h}=${w*h} tiles but block has ${g.tiles}`);
  return {id,w,h,gfx:g.data,tiles:g.tiles,pal};
}

// ---------- PNG writer (indexed, with tRNS so colour 0 is transparent) ----------
function pngIndexed(w,h,idx,palette){
  const n=palette.length;
  const raw=Buffer.alloc((w+1)*h);
  for(let y=0;y<h;y++){raw[y*(w+1)]=0;idx.copy?idx.copy(raw,y*(w+1)+1,y*w,(y+1)*w):raw.set(idx.subarray(y*w,(y+1)*w),y*(w+1)+1);}
  const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const tb=Buffer.from(type);
    const cat=Buffer.concat([tb,data]);let c=~0;for(const x of cat){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}
    const crc=Buffer.alloc(4);crc.writeUInt32BE((~c)>>>0);return Buffer.concat([len,tb,data,crc]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=3;ihdr[12]=0;
  const plte=Buffer.alloc(n*3);palette.forEach((p,i)=>{plte[i*3]=p[0];plte[i*3+1]=p[1];plte[i*3+2]=p[2];});
  const trns=Buffer.alloc(n,255);trns[0]=0; // colour 0 fully transparent, all others opaque
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('PLTE',plte),chunk('tRNS',trns),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
function pngRGB(w,h,rgb){
  const raw=Buffer.alloc((w*3+1)*h);
  for(let y=0;y<h;y++){raw[y*(w*3+1)]=0;rgb.copy(raw,y*(w*3+1)+1,y*w*3,(y+1)*w*3);}
  const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const tb=Buffer.from(t);const cb=Buffer.concat([tb,d]);let c=~0;for(const x of cb){c^=x;for(let k=0;k<8;k++)c=(c>>>1)^(0xEDB88320&-(c&1));}const cr=Buffer.alloc(4);cr.writeUInt32BE((~c)>>>0);return Buffer.concat([l,tb,d,cr]);};
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(w,0);ihdr.writeUInt32BE(H(h),4);
  function H(x){return x;}
  ihdr.writeUInt32BE(h,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}

const FONT={'0':['010','101','101','101','010'],'1':['010','110','010','010','111'],'2':['110','001','010','100','111'],'3':['110','001','010','001','110'],'4':['101','101','111','001','001'],'5':['111','100','110','001','110'],'6':['011','100','110','101','011'],'7':['111','001','010','010','010'],'8':['010','101','010','101','010'],'9':['010','101','011','001','110']};
function drawText(buf,W,x,y,str,rgbv){
  [...String(str)].forEach((ch,i)=>{(FONT[ch]||[]).forEach((row,yy)=>{[...row].forEach((c,xx)=>{if(c==='1'&&y+yy<buf.length/W){const o=(((y+yy)*W)+(x+i*4+xx))*3;buf[o]=rgbv[0];buf[o+1]=rgbv[1];buf[o+2]=rgbv[2];}});});});
}
function blit(m,rgb,W,ox,oy,Z){
  for(let y=0;y<m.h*8;y++)for(let x=0;x<m.w*8;x++){
    const c=pixel(m.gfx,(y>>3)*m.w+(x>>3),x&7,y&7); if(!c) continue;      // colour 0 = transparent
    const p=m.pal[c]||[255,0,255];
    for(let dy=0;dy<Z;dy++)for(let dx=0;dx<Z;dx++){
      const X=ox+x*Z+dx,Y=oy+y*Z+dy; if(X>=W) continue;
      const o=(Y*W+X)*3; rgb[o]=p[0];rgb[o+1]=p[1];rgb[o+2]=p[2];
    }
  }
}

const cmd=process.argv[2]||'atlas';
if(cmd==='atlas'){
  const out=process.argv[3]||'ff5e-monster-atlas.png';
  const Z=2, CELL=44*Z, GAP=10, LBL=8, cols=24, rows=Math.ceil(NMON/cols);
  const W=cols*(CELL+GAP)+GAP, H=rows*(CELL+LBL+GAP)+GAP;
  const rgb=Buffer.alloc(W*H*3).fill(20);
  for(let id=0;id<NMON;id++){
    const m=monster(id);
    const ox=GAP+(id%cols)*(CELL+GAP), oy=GAP+Math.floor(id/cols)*(CELL+LBL+GAP)+LBL;
    for(let y=0;y<CELL;y++)for(let x=0;x<CELL;x++){ if(((x>>3)+(y>>3))&1) continue; const o=((oy+y)*W+ox+x)*3; rgb[o]+=16;rgb[o+1]+=16;rgb[o+2]+=16; }
    const sc=Math.min(CELL/(m.w*8),CELL/(m.h*8));
    const dw=Math.floor(m.w*8*sc), dh=Math.floor(m.h*8*sc), dx0=ox+((CELL-dw)>>1), dy0=oy+((CELL-dh)>>1);
    for(let y=0;y<m.h*8;y++)for(let x=0;x<m.w*8;x++){
      const c=pixel(m.gfx,(y>>3)*m.w+(x>>3),x&7,y&7); if(!c) continue;
      const p=m.pal[c]||[255,0,255];
      for(let yy=0;yy<sc;yy++)for(let xx=0;xx<sc;xx++){const X=dx0+Math.floor(x*sc)+xx,Y=dy0+Math.floor(y*sc)+yy;if(X>=ox+CELL||Y>=oy+CELL)continue;const o=(Y*W+X)*3;rgb[o]=p[0];rgb[o+1]=p[1];rgb[o+2]=p[2];}
    }
    drawText(rgb,W,ox,oy-LBL+1,id,[200,200,200]);
  }
  fs.writeFileSync(out,pngRGB(W,H,rgb));
  console.log('wrote',out,`${W}x${H}`,`(${NMON} graphics sets, 24 per row, colour 0 transparent)`);
}else if(cmd==='show'){
  const args=process.argv.slice(3);
  const ids=args.filter(a=>/^\d+$/.test(a)).map(Number);
  const out=args.find(a=>!/^\d+$/.test(a))||'ff5e-monster-detail.png';
  const ms=ids.map(monster);
  const Z=Number(process.env.ZOOM||5);
  const CELL=Math.max(...ms.map(m=>Math.max(m.w,m.h)*8))*Z+8, GAP=12, cols=Math.min(6,ids.length), rows=Math.ceil(ids.length/cols);
  const W=cols*(CELL+GAP)+GAP,H=rows*(CELL+GAP)+GAP;
  const rgb=Buffer.alloc(W*H*3).fill(20);
  ms.forEach((m,k)=>{const ox=GAP+(k%cols)*(CELL+GAP),oy=GAP+Math.floor(k/cols)*(CELL+GAP);
    for(let y=0;y<CELL;y++)for(let x=0;x<CELL;x++){ if(((x>>(4*Z))+(y>>(4*Z)))&1) continue; const o=((oy+y)*W+ox+x)*3; rgb[o]+=14;rgb[o+1]+=14;rgb[o+2]+=14; }
    blit(m,rgb,W,ox,oy,Z);
    drawText(rgb,W,ox+2,oy-6,`${m.id} ${m.w*8}x${m.h*8}`,[210,210,210]);
  });
  fs.writeFileSync(out,pngRGB(W,H,rgb));
  console.log('wrote',out,'ids:',ids.join(','));
}else if(cmd==='png'){
  const id=Number(process.argv[3]); const dir=process.argv[4]||'.';
  const m=monster(id);
  const idx=Buffer.alloc(m.w*8*m.h*8);
  for(let y=0;y<m.h*8;y++)for(let x=0;x<m.w*8;x++) idx[y*(m.w*8)+x]=pixel(m.gfx,(y>>3)*m.w+(x>>3),x&7,y&7);
  const f=`${dir}/ff5e-monster-${id}.png`;
  fs.writeFileSync(f,pngIndexed(m.w*8,m.h*8,idx,m.pal));
  console.log('wrote',f,`${m.w*8}x${m.h*8}`,`${m.tiles} tiles, ${m.pal.length} colours (indexed PNG, colour 0 transparent)`);
}
