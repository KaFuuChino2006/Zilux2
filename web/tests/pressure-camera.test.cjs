const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const cache=new Map();
function load(name){if(cache.has(name))return cache.get(name);const exports={};cache.set(name,exports);vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/ui',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:s=>load(s.slice(2))});return exports;}
const {pressureCamera}=load('pressureCamera');
const {pressureCue,pressureEntrance,pressurePhraseMotion,pressureAnchor}=load('pressureChoreography');
const phrase=(text,start,end)=>({text,start,end,glyphs:[{text,start,end}]});
const shot=(kind='split')=>({kind,number:0,section:0,seed:0,start:1000,end:9000,hero:1,phrases:[phrase('让心跳',1000,3000),phrase('响彻夜空',4000,8000)]});

test('camera settles during sustained singing and moves toward the next phrase on its cue',()=>{
 const s=shot();const a=pressureCamera(s,2000),b=pressureCamera(s,3000);
 for(const k of ['x','y','zoom','rotation'])assert.ok(Math.abs(a[k]-b[k])<.004,'camera breathing should stay subtle');
 assert.equal(pressureCue(s,3700).active,0);assert.equal(pressureCue(s,4200).active,1);
 const before=pressureCamera(s,3800),after=pressureCamera(s,4700);
 assert.ok(Math.abs(after.y-before.y)>.001,'camera must follow the active phrase cue');
 const delayed=shot();delayed.phrases[1]={...delayed.phrases[1],start:6000,glyphs:[{text:'响彻夜空',start:6000,end:8000}]};
 const delayedCamera=pressureCamera(delayed,4500),held=pressureCamera(s,4500);
 assert.ok(Math.abs(delayedCamera.y-held.y)>.002,'delaying singing must delay the camera too');
});
test('cue boundaries preserve camera position and seeking reproduces choreography',()=>{
 const s=shot();
 for(const boundary of [840,1360,3840,4360]){
  const a=pressureCamera(s,boundary-.01),b=pressureCamera(s,boundary+.01);
  for(const k of ['x','y','zoom','rotation'])assert.ok(Math.abs(a[k]-b[k])<.0001);
 }
 const expected=pressureCamera(s,4200);pressureCamera(s,99999);assert.deepEqual(pressureCamera(s,4200),expected);
});
test('glyph onsets drive visual accents and upcoming phrases remain unfilled until entrance',()=>{
 const s=shot();assert.equal(pressureCue(s,3990).impact,0);assert.ok(pressureCue(s,4050).impact>0);
 assert.equal(pressurePhraseMotion(s.phrases[1],3800,false).hidden,true);
 assert.equal(pressurePhraseMotion(s.phrases[1],4100,false).hidden,false);
 assert.equal(pressurePhraseMotion(s.phrases[1],5000,false).entry,1);
});
test('eighteen entrance families are assigned deterministically',()=>{
 const all=new Set();for(let i=0;i<18;i++){const s=shot();s.number=i;all.add(pressureEntrance(s,0));assert.equal(pressureEntrance(s,0),pressureEntrance(s,0));}
 assert.ok(all.size>=8,'the edit should reach a wide vocabulary of entrances');
});
test('camera respects viewport bounds and reduced motion across poster layouts',()=>{
 for(const ratio of [320/844,390/844,1,16/9,21/9])for(const kind of ['split','banner','tunnel','echo','stack','orbit']){
  const s=shot(kind);
  for(let t=800;t<9000;t+=47){
   const c=pressureCamera(s,t,ratio);assert.ok(Object.values(c).every(Number.isFinite));
   const cos=Math.abs(Math.cos(c.rotation)),sin=Math.abs(Math.sin(c.rotation)),z=c.zoom*1.08;
   assert.ok(z*(cos*.44*ratio+sin*.325)+Math.abs(c.x)*1.18*ratio<=.465*ratio+1e-6);
   assert.ok(z*(sin*.44*ratio+cos*.325)+Math.abs(c.y)*1.18<=.345+1e-6);
  }
  assert.deepEqual(pressureCamera(s,2000,ratio,true),pressureCamera(s,5000,ratio,true));
  const anchor=pressureAnchor(s,s.hero,ratio<1);
  assert.ok(Number.isFinite(anchor.x)&&Number.isFinite(anchor.y));
  assert.ok(anchor.x>=0&&anchor.x<=1&&anchor.y>=0&&anchor.y<=1);
 }
});
