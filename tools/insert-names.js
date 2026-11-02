// Insert the generated string tables into a definition file without reformatting it.
// usage: node tools/insert-names.js <def.json>
const fs=require('fs');
const file=process.argv[2];
const gfx=JSON.parse(fs.readFileSync('/tmp/gfx-names.json','utf8'));
const pal=JSON.parse(fs.readFileSync('/tmp/pal-names.json','utf8'));
let src=fs.readFileSync(file,'utf8');

function makeBlock(title,names){
  const len=Math.max(...Object.keys(names).map(Number))+1;
  const entries=Object.keys(names).sort((a,b)=>a-b)
    .map(k=>`                    ${JSON.stringify(k)}: ${JSON.stringify(names[k])}`).join(',\n');  return `            "stringTable": {
                "length": ${len},
                "default": "${title} %i",
                "string": {
${entries}
                }
            }`;
}
function replaceBlock(src,anchor,title,names){
  const start=src.indexOf(`"${anchor}": {`);
  if(start<0) throw new Error('anchor not found: '+anchor);
  const st=src.indexOf('"stringTable": {',start);
  if(st<0) throw new Error('no stringTable after '+anchor);
  let i=src.indexOf('{',st), depth=0, end=-1;
  for(;i<src.length;i++){ if(src[i]==='{')depth++; else if(src[i]==='}'){depth--; if(!depth){end=i+1;break;}} }
  return src.slice(0,st)+makeBlock(title,names)+src.slice(end);
}
let out=replaceBlock(src,'monsterPalettes','Monster Palette',pal);
out=replaceBlock(out,'monsterGraphics','Monster Graphics',gfx);
JSON.parse(out);                       // validate before writing
fs.writeFileSync(file+'.tmp',out);
fs.renameSync(file+'.tmp',file);
const d=JSON.parse(fs.readFileSync(file,'utf8'));
console.log('patched',file);
console.log('  monsterGraphics names:',Object.keys(d.assembly.monsterGraphics.stringTable.string).length);
console.log('  monsterPalettes names:',Object.keys(d.assembly.monsterPalettes.stringTable.string).length);
