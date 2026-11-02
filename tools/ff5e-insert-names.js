// Insert the generated string tables into ff5/ff5e-gba.json without reformatting the file.
const fs=require('fs');
const ROOT='/storage/romhacking/ff6tools';
const file=path.join=  pathJoin();
function pathJoin(){return ROOT+'/ff5/ff5e-gba.json';}
const gfx=JSON.parse(fs.readFileSync('/tmp/gfx-names.json','utf8'));
const pal=JSON.parse(fs.readFileSync('/tmp/pal-names.json','utf8'));
let src=fs.readFileSync(pathJoin(),'utf8');

function block(name,names,key){
  const entries=Object.keys(names).sort((a,b)=>a-b).map(k=>`                    ${JSON.stringify(k)}: ${JSON.stringify(names[k])}`).join(',\n');
  return `            "stringTable": {
                "length": ${key},
                "default": "${name} %i",
                "string": {
${entries}
                }
            }`;
}
function replaceBlock(src, anchorKey, newBlock){
  // find the definition for anchorKey, then its "stringTable" member
  const start=src.indexOf(`"${anchorKey}": {`);
  if(start<0) throw new Error('anchor not found: '+anchorKey);
  const st=src.indexOf('"stringTable": {',start);
  if(st<0) throw new Error('no stringTable after '+anchorKey);
  // find matching close brace of that object
  let i=src.indexOf('{',st), depth=0, end=-1;
  for(;i<src.length;i++){ if(src[i]==='{')depth++; else if(src[i]==='}'){depth--; if(!depth){end=i+1;break;}} }
  const indent='            ';
  return src.slice(0,st)+newBlock.split('\n').map((l,idx)=>idx===0?l:indent+l.slice(12)).join('\n')+src.slice(end);
}
let out=src;
out=replaceBlock(out,'monsterPalettes',block('Monster Palette',pal,Math.max(...Object.keys(pal).map(Number))+1));
out=replaceBlock(out,'monsterGraphics',block('Monster Graphics',gfx,Math.max(...Object.keys(gfx).map(Number))+1));
fs.writeFileSync(out+'.tmp',out);
// validate JSON
JSON.parse(out);
fs.renameSync(out+'.tmp',out);
console.log('patched',out);
const d=JSON.parse(fs.readFileSync(out,'utf8'));
console.log('monsterGraphics stringTable entries:',Object.keys(d.assembly.monsterGraphics.stringTable.string).length);
console.log('monsterPalettes stringTable entries:',Object.keys(d.assembly.monsterPalettes.stringTable.string).length);
