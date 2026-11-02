// Minimal DOM stub so ff6tools' browser code can run under Node for testing.
function makeEl(tag) {
  const el = {
    tagName: (tag||'div').toUpperCase(), children: [], style: {}, dataset: {}, attributes: {},
    classList: { _s:new Set(), add(...c){c.forEach(x=>this._s.add(x));}, remove(...c){c.forEach(x=>this._s.delete(x));},
      toggle(c){this._s.has(c)?this._s.delete(c):this._s.add(c);}, contains(c){return this._s.has(c);} },
    appendChild(c){ this.children.push(c); return c; }, removeChild(c){ const i=this.children.indexOf(c); if(i>=0) this.children.splice(i,1); return c; },
    insertBefore(c,r){ this.children.unshift(c); return c; },
    setAttribute(k,v){ this.attributes[k]=v; }, getAttribute(k){ return this.attributes[k]; },
    addEventListener(){}, removeEventListener(){}, querySelector(){return null;}, querySelectorAll(){return [];},
    getContext(){ return fakeCtx(); }, toDataURL(){ return ''; },
    get innerHTML(){ return this._html||''; }, set innerHTML(v){ this._html=v; this.children=[]; },
    innerText:'', textContent:'', value:'',
    clientWidth: 800, clientHeight: 600, scrollHeight: 600, offsetWidth: 800, offsetHeight: 600,
    parentNode: null, tabIndex: 0,
  };
  return el;
}
function fakeCtx(){
  const noop=()=>{};
  return { canvas:null, fillStyle:'', strokeStyle:'', globalCompositeOperation:'source-over', imageSmoothingEnabled:true,
    drawImage:noop, fillRect:noop, clearRect:noop, strokeRect:noop, beginPath:noop, moveTo:noop, lineTo:noop,
    stroke:noop, fill:noop, save:noop, restore:noop, translate:noop, scale:noop, putImageData:noop,
    createImageData:(w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),
    getImageData:(x,y,w,h)=>({width:w,height:h,data:new Uint8ClampedArray(w*h*4)}),
    measureText:()=>({width:0}), fillText:noop, setTransform:noop };
}
globalThis.document = {
  createElement: makeEl, createElementNS:(ns,t)=>makeEl(t), createTextNode:(t)=>({nodeValue:t}),
  createDocumentFragment:()=>makeEl('fragment'),
  getElementById:()=>null, getElementsByClassName:()=>[], getElementsByTagName:()=>[], querySelector:()=>null, querySelectorAll:()=>[],
  body: makeEl('body'), documentElement: makeEl('html'), addEventListener(){},
};
globalThis.window = globalThis;
globalThis.navigator = globalThis.navigator || { userAgent:'node' };
globalThis.localStorage = { getItem:()=>null, setItem(){}, removeItem(){} };
globalThis.alert = ()=>{};
globalThis.self = globalThis;
globalThis.requestAnimationFrame = (f)=>{};
globalThis.getComputedStyle = ()=>({});
