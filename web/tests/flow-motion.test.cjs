const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

function harness(){
 const store=new Map(),cache=new Map(),events=[];
 function load(name){
  if(cache.has(name))return cache.get(name);
  const exports={};cache.set(name,exports);
  const source=fs.readFileSync(path.join(__dirname,'../src/ui',name+'.ts'),'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
   exports,console,localStorage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value)},
   window:{dispatchEvent:event=>events.push(event)},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},
   require:specifier=>specifier==='./flowMotion'?load('flowMotion'):specifier==='./flowMg'?{FLOW_COMPOSITION_COUNT:160}:{DEFAULT_TEMPERA_TUNING:{}},
  });
  return exports;
 }
 return {load,store,events};
}
const shot=()=>({id:'shot-a',camera:{x:0,y:0,zoom:1,rotation:0},cameraEnd:{x:0,y:0,zoom:1,rotation:0}});
test('legacy name migrates to vertical; direction choices survive normalization',()=>{
 const {load}=harness();const {normalizeFlowSettings}=load('flowSettings');
 assert.equal(normalizeFlowSettings({motion:'original'}).motion,'vertical');
 const settings=normalizeFlowSettings({motion:'rotation',rotationDirection:'counterclockwise',rotationZoom:'out',horizontalDirection:'right',verticalDirection:'down'});
 assert.equal(settings.rotationDirection,'counterclockwise');assert.equal(settings.horizontalDirection,'right');assert.equal(settings.verticalDirection,'down');
 assert.equal(settings.rotationZoom,'out');assert.equal(normalizeFlowSettings({rotationZoom:'bad'}).rotationZoom,'random');
 assert.equal(normalizeFlowSettings({horizontalDirection:'broken'}).horizontalDirection,'random');
});
test('fixed slide labels match the actual incoming viewport edge',()=>{
 const {load}=harness();const {applyFlowMotion}=load('flowMotion');
 for(const [motion,key,direction,axis,sign]of [
  ['horizontal','horizontalDirection','left','x',-1],['horizontal','horizontalDirection','right','x',1],
  ['vertical','verticalDirection','up','y',-1],['vertical','verticalDirection','down','y',1],
 ])for(let seed=0;seed<30;seed++){
  const value=shot();applyFlowMotion(value,{motion,[key]:direction},String(seed));
  const entrance={x:-Math.cos(value.flowAngle),y:-Math.sin(value.flowAngle)};
  assert.ok(entrance[axis]*sign>0.99);assert.equal(value.cameraMotion,'slide');
 }
});
test('clockwise and counterclockwise remain fixed across shots and random uses both',()=>{
 const {load}=harness();const {applyFlowMotion}=load('flowMotion');const signs=new Set();
 for(let seed=0;seed<100;seed++){
  for(const [direction,sign]of [['clockwise',1],['counterclockwise',-1]]){
   const value=shot();applyFlowMotion(value,{motion:'rotation',rotationDirection:direction},String(seed));
   assert.equal(value.cameraMotion,'rotation');assert.ok((value.cameraEnd.rotation-value.camera.rotation)*sign>0);
   assert.equal(value.camera.x,0);assert.equal(value.cameraEnd.y,0);
  }
  const value=shot();applyFlowMotion(value,{motion:'rotation',rotationDirection:'random'},String(seed));
  signs.add(Math.sign(value.cameraEnd.rotation-value.camera.rotation));
 }
 assert.equal(signs.size,2);
});
test('weighted shuffle varies its first item, avoids adjacent repeats and is seek stable',()=>{
 const {load,store}=harness();const {createFlowPicker}=load('flowRotation');const history={step:0,shown:{}};const starts=new Set();
 for(let seed=0;seed<100;seed++){
  const a=createFlowPicker([0,1,2,3,4],String(seed),history),b=createFlowPicker([0,1,2,3,4],String(seed),history);
  let last=-1;
  for(let i=0;i<100;i++){const next=a();assert.equal(next,b());if(!i)starts.add(next);assert.notEqual(next,last);last=next;}
 }
 assert.equal(starts.size,5);assert.equal(store.size,0);assert.equal(history.step,0);
});
test('unshown probabilities rise, showing lowers weight; persisted history survives reload',()=>{
 const {load,store}=harness();const {readFlowHistory,flowWeight,recordFlowCompositions,createFlowPicker}=load('flowRotation');
 recordFlowCompositions([0]);const first=readFlowHistory();const before=flowWeight(first,1);
 for(let i=0;i<20;i++)recordFlowCompositions([0]);
 const later=readFlowHistory();assert.ok(flowWeight(later,1)>before);
 const staleWeight=flowWeight(later,1);recordFlowCompositions([1]);
 assert.ok(flowWeight(readFlowHistory(),1)<staleWeight);
 assert.ok(store.size>0);
 let rare=0;
 const history={step:100,shown:{0:{count:10,last:100},1:{count:10,last:0}}};
 for(let seed=0;seed<2000;seed++)if(createFlowPicker([0,1],String(seed),history)()===1)rare++;
 assert.ok(rare>1900,`stale composition chosen only ${rare}/2000 times`);
});

test('renderer rotates in place in the selected direction and seeks reproduce the same frame',()=>{
 const cache=new Map();
 function pure(file){
  if(cache.has(file))return cache.get(file);
  const exports={};cache.set(file,exports);
  const source=fs.readFileSync(file,'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
   exports,require:specifier=>pure(path.resolve(path.dirname(file),specifier+'.ts')),
  });return exports;
 }
 const file=path.join(__dirname,'../src/ui/lumiere-folia/components/visualizer/tempera/temperaShotFrame.ts');
 const {updateTemperaShot}=pure(file);const {applyFlowMotion}=harness().load('flowMotion');
 const frame=(value,time)=>{
  const result={};const view={shot:value,baseX:640,baseY:360,revealDoneTime:1,glyphs:[],
   container:{position:{set:(x,y)=>Object.assign(result,{x,y})},scale:{set:scale=>result.scale=scale}},
   blocks:{updateTime(){}},images:{updateTime(){}}};
  updateTemperaShot(view,time,1280,720,{cameraIntensity:1,glyphMotion:1},{animationIntensity:'normal'});
  result.rotation=view.container.rotation;return result;
 };
 for(const [direction,sign]of [['clockwise',1],['counterclockwise',-1]]){
  const value={...shot(),startTime:0,endTime:4};applyFlowMotion(value,{motion:'rotation',rotationDirection:direction},'renderer');
  let last=-Infinity;
  for(let i=0;i<=40;i++){
   const result=frame(value,i/10);assert.equal(result.x,640);assert.equal(result.y,360);
   assert.ok(result.rotation*sign>=last);last=result.rotation*sign;
  }
  assert.deepEqual(frame(value,2),frame(value,2));
 }
 const slide={...shot(),startTime:0,endTime:4};applyFlowMotion(slide,{motion:'horizontal',horizontalDirection:'left'},'renderer');
 assert.ok(frame(slide,0).x<640);assert.ok(frame(slide,0.5).x>frame(slide,0).x);
 const catalogue=pure(path.join(__dirname,'../src/ui/flowMg.ts'));
 for(const id of catalogue.FLOW_COMPOSITION_ORDER){
  for(const [direction,sign]of [['clockwise',1],['counterclockwise',-1]])for(const zoom of ['in','out','none']){
   const value={...shot(),id:`composition-${id}`,startTime:0,endTime:4};
   applyFlowMotion(value,{motion:'rotation',rotationDirection:direction,rotationZoom:zoom},'all-compositions');
   const frames=[0,0.15,0.5,1,2,3,4].map(time=>frame(value,time));
   for(let i=1;i<frames.length;i++){
    assert.ok((frames[i].rotation-frames[i-1].rotation)*sign>0,`rotation stalled/reversed for ${id}`);
    assert.equal(frames[i].x,640);assert.equal(frames[i].y,360);
    if(zoom==='in')assert.ok(frames[i].scale>frames[i-1].scale);
    else if(zoom==='out')assert.ok(frames[i].scale<frames[i-1].scale);
    else assert.equal(frames[i].scale,frames[i-1].scale);
   }
   assert.ok((frames.at(-1).rotation-frames[0].rotation)*sign>0.9,`rotation too weak for ${id}`);
  }
 }
});

test('scene records only rendered shots and applies same-window/cross-window settings even when paused',async()=>{
 const base=harness();const rotation=base.load('flowRotation');const motion=base.load('flowMotion');
 const settings={motion:'horizontal',horizontalDirection:'random',wholeLineLyrics:false,mgSelection:[0,1,2],mgPlayback:'rotate',fontWeight:800};
 let savedSettings={...settings};const handlers=new Map(),swaps=[];
 let nonce=0;
 const exports={};
 const source=fs.readFileSync(path.join(__dirname,'../src/ui/flowScene.ts'),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports,console,AbortController,crypto:{getRandomValues:array=>{array[0]=++nonce;return array;}},
  document:{hidden:false,fonts:{ready:Promise.resolve()},createElement:()=>({style:{},isConnected:true,remove(){}})},
  window:{addEventListener:(name,fn)=>{if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);},removeEventListener:(name,fn)=>handlers.get(name)?.delete(fn)},
  require:specifier=>{
   if(specifier==='./flowMotion')return motion;if(specifier==='./flowRotation')return rotation;
   if(specifier==='./flowHandoff')return base.load('flowHandoff');
   if(specifier==='./flowCountdown')return {createFlowCountdown:()=>({update(){}})};
   if(specifier==='./flowSettings')return {FLOW_SETTINGS_EVENT:'zilux2:flow-settings',FLOW_SETTINGS_KEY:'zilux2.flowSettings',flowSettings:()=>({...savedSettings}),flowTuning:()=>({}),normalizeFlowSettings:value=>value};
   if(specifier==='./flowMg')return {FLOW_COMPOSITION_ORDER:[0,1,2],FLOW_ORIGINAL_START:10,FLOW_ORIGINAL_END:13,FLOW_ORIGINAL_STYLES:[],flowMgVariantForId:id=>id};
   if(specifier.includes('baseThemes'))return {DEFAULT_THEME:{}};
   if(specifier.includes('framer-motion'))return {MotionValue:class{constructor(value){this.value=value;}get(){return this.value;}set(value){this.value=value;}}};
   if(specifier.includes('temperaProgram'))return {compileTemperaProgram:()=>({paragraphs:[{shots:Array.from({length:3},(_,index)=>({...shot(),id:`shot-${index}`,startTime:index,endTime:index+1}))}]})};
   if(specifier.includes('createTemperaPixiRuntime'))return {TemperaPixiRuntime:{create:async()=>({setTuning(){},setSongMetadata(){},swapSong:async context=>{swaps.push(context);},renderOnce(){},destroy(){}})}};
   throw new Error(specifier);
  },
 });
 const song={trackKey:'test',lines:[],lyricOffsetMs:0};
 const preview=exports.createFlowScene(undefined,undefined,false);preview.setSong(song);await preview.ready();preview.update(500);
 assert.equal(rotation.readFlowHistory().step,0);preview.dispose();
 const scene=exports.createFlowScene();scene.setSong(song);await scene.ready();
 assert.equal(rotation.readFlowHistory().step,0);
 scene.update(500);assert.equal(rotation.readFlowHistory().step,1);
 for(let i=0;i<100;i++)scene.update(500);
 assert.equal(rotation.readFlowHistory().step,1);
 scene.update(1500);assert.equal(rotation.readFlowHistory().step,2);
 scene.setPalette(['#ffffff']);await Promise.resolve();await Promise.resolve();scene.update(1500);
 assert.equal(rotation.readFlowHistory().step,2);
 const send=(name,event)=>handlers.get(name)?.forEach(fn=>fn(event));
 send('zilux2:flow-settings',{detail:{...settings,motion:'rotation',rotationDirection:'clockwise',rotationZoom:'out'}});
 await Promise.resolve();await Promise.resolve();
 assert.equal(swaps.at(-1).program.paragraphs[0].shots[0].cameraMotion,'rotation');
 assert.ok(swaps.at(-1).program.paragraphs[0].shots[0].camera.zoom>swaps.at(-1).program.paragraphs[0].shots[0].cameraEnd.zoom);
 savedSettings={...settings,motion:'vertical',verticalDirection:'down'};
 const count=swaps.length;send('storage',{key:'unrelated'});assert.equal(swaps.length,count);
 send('storage',{key:'zilux2.flowSettings'});await Promise.resolve();await Promise.resolve();
 assert.equal(swaps.at(-1).program.paragraphs[0].shots[0].cameraMotion,'slide');
 assert.ok(swaps.at(-1).program.paragraphs[0].shots[0].camera.y>0);
 scene.dispose();assert.equal(handlers.get('storage').size,0);assert.equal(handlers.get('zilux2:flow-settings').size,0);
});

test('save persists the normalized draft and broadcasts that exact snapshot',()=>{
 const {load,store,events}=harness();const settings=load('flowSettings');
 const result=settings.saveFlowSettings(settings.normalizeFlowSettings({motion:'rotation',rotationDirection:'counterclockwise',rotationZoom:'out',mgSelection:[1,2,3]}));
 const saved=JSON.parse(store.get('zilux2.flowSettings'));
 assert.equal(saved.motion,'rotation');assert.equal(saved.rotationZoom,'out');assert.deepEqual(saved.mgSelection,[1,2,3]);
 assert.equal(events.at(-1).type,'zilux2:flow-settings');assert.equal(events.at(-1).detail,result);
});
