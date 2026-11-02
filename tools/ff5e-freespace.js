const fs=require('fs');
const b=fs.readFileSync('/storage/romhacking/ff6tools/Final Fantasy V Advance (Europe) (En,Fr,De,Es,It).gba');
const N=b.length, B=0x08000000;
let runs=[],start=0;
for(let i=1;i<=N;i++){
  if(i===N||b[i]!==0xFF){ if(i-start>=0x2000) runs.push([start,i]); start=i+1; }
  if(b[i]!==0xFF) start=i+1;
}
// recompute cleanly
runs=[]; start=null;
for(let i=0;i<N;i++){
  if(b[i]===0xFF){ if(start===null) start=i; }
  else { if(start!==null && i-start>=0x2000) runs.push([start,i]); start=null; }
}
if(start!==null && N-start>=0x2000) runs.push([start,N]);
console.log('0xFF runs >= 0x2000:');
for(const [s,e] of runs) console.log(`  "0x${(B+s).toString(16)}-0x${(B+e).toString(16)}"   (len 0x${(e-s).toString(16)})`);
console.log('total free bytes:','0x'+runs.reduce((a,[s,e])=>a+e-s,0).toString(16));
