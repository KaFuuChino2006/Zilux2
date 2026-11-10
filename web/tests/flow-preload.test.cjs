const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
function moduleCode(name){return ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/ui',name+'.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;}
function pure(name){const exports={};vm.runInNewContext(moduleCode(name),{exports,require:specifier=>pure(specifier.slice(2))});return exports;}
const song=id=>({trackKey:'qq:'+id,title:id,artist:'Artist',album:'',durationMs:20000,lyricOffsetMs:0,lines:[{text:id,timeMs:5000,durationMs:3000,words:[{text:id,startMs:5000,endMs:8000}]}]});
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
test('countdown has 12 deterministic styles, follows the lyric clock and fades on singing',()=>{
 const {FLOW_COUNTDOWN_STYLES,flowCueFrame}=pure('flowCountdown');assert.equal(FLOW_COUNTDOWN_STYLES.length,12);
 const input=song('A');assert.equal(flowCueFrame(input,1000),null);
 assert.equal(flowCueFrame(input,2100).count,3);assert.equal(flowCueFrame(input,3100).count,2);assert.equal(flowCueFrame(input,4100).count,1);
 assert.ok(flowCueFrame(input,5100).alpha<1);assert.equal(flowCueFrame(input,5220),null);
 assert.deepEqual(flowCueFrame(input,3500),flowCueFrame(input,3500));
 const delayed=song('late');delayed.lines[0].words[0].startMs=6000;
 assert.ok(flowCueFrame(delayed,5500));assert.equal(flowCueFrame(delayed,6220),null);
 const styles=new Set();for(let i=0;i<200;i++)styles.add(flowCueFrame(song(String(i)),3000).style);assert.equal(styles.size,12);
});
test('handoff keeps an opaque moving predecessor and reuses the preloaded next surface',async()=>{
 let now=0,nextTrack={source:'qq',id:'B',title:'B',artist:'Artist'},state={track:{source:'qq',id:'A'},positionMs:6000,playing:true};
 const listeners=new Set(),raf=new Map(),scenes=[];let nextRaf=0,loads=0;
 const node=()=>({style:{},classList:{add(){},remove(){},toggle(){}},append(){},remove(){}});
 const exports={};
 vm.runInNewContext(moduleCode('flow'),{
  exports,console,URLSearchParams,window:{location:{search:''}},document:{hidden:false,createElement:node},performance:{now:()=>now},
  requestAnimationFrame:fn=>{const id=++nextRaf;raf.set(id,fn);return id;},cancelAnimationFrame:id=>raf.delete(id),
  require:specifier=>{
   if(specifier==='./flowHandoff')return pure('flowHandoff');
   if(specifier==='./player')return {playerState:()=>state,onPlayer:fn=>{listeners.add(fn);fn();return()=>listeners.delete(fn);},peekUpcoming:()=>nextTrack?{track:nextTrack}:null,getTransitionTarget:()=>null};
   if(specifier==='./lyrics')return {preloadLyricSong:async track=>{loads++;return song(track.id);}};
   if(specifier==='./crossfadeDeck')return {readCrossfadeDebug:()=>({phase:'prepared',nextTitle:'B',bStartFileMs:2500})};
   if(specifier==='./coverColors')return {coverColorsOf:async()=>({palette:['#123456']}),fallbackColors:()=>({palette:['#123456']})};
   if(specifier==='./flowScene')return {createFlowScene:(onPainted,_onError,recordUsage)=>{
    const value={root:node(),disposed:false,usage:recordUsage,positions:[],setSong:input=>value.song=input,setPalette(){},setUsageRecording:enabled=>value.usage=enabled,resize:()=>Promise.resolve().then(onPainted),update:position=>value.positions.push(position),dispose:()=>{value.disposed=true;}};scenes.push(value);return value;
   }};
   throw new Error(specifier);
  },
 });
 const stage=exports.createFlowStage();stage.setSong(song('A'));stage.activate();await flush();
 assert.equal(loads,1);assert.equal(scenes.length,2);assert.equal(scenes[1].song.trackKey,'qq:B');
 assert.ok(scenes[1].positions.includes(2500),'planned crossfade entry was not pre-rendered');assert.equal(scenes[1].usage,false);
 const step=time=>{now=time;const pending=[...raf.values()];raf.clear();pending.forEach(fn=>fn());};
 step(100);const oldPosition=scenes[0].positions.at(-1);
 state={...state,track:{source:'qq',id:'B'},positionMs:0};nextTrack=null;listeners.forEach(fn=>fn());
 stage.setSong({...song('B'),durationMs:20001});
 assert.equal(scenes[1].usage,true);assert.equal(scenes[0].usage,false);
 assert.equal(scenes.length,2,'duration refinement rebuilt the warmed scene');
 step(325);assert.ok(Number(scenes[1].root.style.opacity)>0&&Number(scenes[1].root.style.opacity)<1);
 assert.ok(scenes[0].positions.at(-1)>oldPosition,'outgoing animation stopped during handoff');
 assert.equal(Number(scenes[0].root.style.opacity),1);
 step(600);assert.equal(scenes[0].disposed,true);assert.equal(scenes[1].disposed,false);assert.equal(scenes[1].root.style.opacity,'1');
 nextTrack={source:'qq',id:'C',title:'C',artist:'Artist'};listeners.forEach(fn=>fn());await flush();
 assert.equal(scenes.length,3);assert.equal(scenes.filter(scene=>!scene.disposed).length,2);
 state={...state,track:{source:'qq',id:'D'},positionMs:0};nextTrack=null;listeners.forEach(fn=>fn());stage.setSong(song('D'));await flush();
 assert.equal(scenes[2].disposed,true,'wrong queued scene survived manual skip');
 assert.equal(scenes.filter(scene=>!scene.disposed).length,2,'manual skip created a third live surface');
 step(1200);assert.equal(scenes.filter(scene=>!scene.disposed).length,1);
 stage.dispose();assert.ok(scenes.every(scene=>scene.disposed));assert.equal(listeners.size,0);
});
