import type { LumiereMode, LumiereSongInput, LumiereStage } from './lumiere';
import { onPlayer, playerState, peekUpcoming, getTransitionTarget } from './player';
import { createFlowScene } from './flowScene';
import { coverColorsOf, fallbackColors } from './coverColors';
import { flowHandoffFrame, flowSongSignature } from './flowHandoff';
import { preloadLyricSong } from './lyrics';
import { readCrossfadeDebug } from './crossfadeDeck';

let previewPalette:string[]=[];
export function flowCoverPalette():string[]{return [...previewPalette];}
export type FlowStage = Pick<LumiereStage,'root'|'setMode'|'setSong'|'activate'|'deactivate'|'dispose'> & {setPalette(colors:string[]):void};
type Slot={scene:ReturnType<typeof createFlowScene>;song:LumiereSongInput;signature:string;colors:string[];ready:boolean;position:number;expectedPosition:number;stamp:number};

/** At most two surfaces: the playing scene and one prepared/retiring neighbour. */
export function createFlowStage():FlowStage {
 const root=document.createElement('div');root.className='lyrics-stage is-flow';
 let current:Slot|null=null,standby:Slot|null=null,outgoing:Slot|null=null;
 let song:LumiereSongInput|null=null,palette:string[]=[];
 let active=false,disposed=false,raf=0,token=0,pendingKey='',retryAt=0;
 let anchor=0,stamp=0,playing=false,transitionAt=0;
 let cueCheckedAt=-Infinity,cue= {phase:'idle',nextTitle:'',bStartFileMs:0};
 let unsubscribe:(()=>void)|null=null;
 const currentKey=()=>{const track=playerState().track;return track?`${track.source}:${track.id}`:'';};
 const background=new URLSearchParams(window.location.search).get('scene')==='backgroundLyrics';
 const release=(slot:Slot|null)=>slot?.scene.dispose();

 function promote(slot:Slot){
  if(!active||!slot.ready||slot.song.trackKey!==currentKey()||slot===current)return;
  release(outgoing);outgoing=current;current=slot;if(standby===slot)standby=null;
  current.scene.setUsageRecording(true);
  if(outgoing){outgoing.scene.setUsageRecording(false);outgoing.stamp=performance.now();}
  transitionAt=performance.now();
  root.classList.remove('is-failed');root.classList.add('is-ready','is-painted','is-content');
 }
 function createSlot(input:LumiereSongInput,colors:string[]):Slot{
  let slot:Slot;
  const scene=createFlowScene(()=>{
   slot.ready=true;
   if(slot===current){root.classList.add('is-ready','is-painted');}
   else if(slot===standby&&slot.song.trackKey===currentKey())promote(slot);
  },error=>{
   console.warn('[flow] scene preparation failed',error);
   if(slot===standby){standby=null;release(slot);pendingKey='';retryAt=performance.now()+3000;}
   else if(slot===current){root.classList.add('is-failed');root.classList.remove('is-ready','is-painted');}
  },false);
  slot={scene,song:input,signature:flowSongSignature(input),colors:[...colors],ready:false,position:0,expectedPosition:0,stamp:performance.now()};
  scene.root.style.opacity='0';root.append(scene.root);scene.setPalette(colors);scene.setSong(input);scene.resize();
  return slot;
 }
 function accept(input:LumiereSongInput){
  if(!active||input.trackKey!==currentKey())return;
  const signature=flowSongSignature(input);
  if(current?.song.trackKey===input.trackKey){
   if(current.signature!==signature){current.song=input;current.signature=signature;current.scene.setSong(input);}
   return;
  }
  if(standby?.song.trackKey===input.trackKey){
   if(standby.signature!==signature){standby.song=input;standby.signature=signature;standby.scene.setSong(input);}
   if(standby.ready)promote(standby);
   return;
  }
  if(!current){current=createSlot(input,palette);current.scene.root.style.opacity='1';current.scene.setUsageRecording(true);return;}
  ++token;pendingKey='';release(outgoing);outgoing=null;release(standby);standby=createSlot(input,palette);
 }
 function prepareUpcoming(){
  if(!active||disposed||outgoing||performance.now()<retryAt)return;
  const key=currentKey();
  if(current&&current.song.trackKey!==key)return;
  let target=getTransitionTarget()??peekUpcoming()?.track??null;
  let expectedPosition=0;
  if(background){
   try{const snapshot=JSON.parse(localStorage.getItem('zilux2.flowUpcoming')||'null');if(!snapshot||snapshot.forTrack!==key)return;target=snapshot.track??null;expectedPosition=Math.max(0,Number(snapshot.positionMs)||0);}catch{return;}
  }else{
   if(performance.now()-cueCheckedAt>=500){cue=readCrossfadeDebug();cueCheckedAt=performance.now();}
   if(target&&(cue.phase==='prepared'||cue.phase==='fading')&&cue.nextTitle===target.title)expectedPosition=Math.max(0,cue.bStartFileMs-(target.startAt??0)*1000);
  }
  const nextKey=target?`${target.source}:${target.id}`:'';
  if(!target||nextKey===key){if(pendingKey||standby){++token;release(standby);standby=null;pendingKey='';}return;}
  if(standby?.song.trackKey===nextKey){standby.expectedPosition=expectedPosition;return;}
  if(nextKey===pendingKey)return;
  const request=++token;pendingKey=nextKey;release(standby);standby=null;
  void Promise.all([
   preloadLyricSong(target),
   coverColorsOf(target).catch(()=>null),
  ]).then(([input,colors])=>{
   if(!active||disposed||request!==token)return;
   standby=createSlot(input,(colors??fallbackColors(`${target.title}|${target.artist}`)).palette);
   standby.expectedPosition=expectedPosition;standby.scene.update(expectedPosition);
  }).catch(error=>{
   if(request!==token)return;pendingKey='';retryAt=performance.now()+3000;
   console.warn('[flow] upcoming song preparation failed',error);
  });
 }
 const sync=()=>{
  const state=playerState();anchor=Number.isFinite(state.positionMs)?state.positionMs:0;stamp=performance.now();playing=state.playing;
  if(standby?.ready&&standby.song.trackKey===currentKey())promote(standby);
  prepareUpcoming();
 };
 const frame=()=>{
  raf=0;if(!active||disposed)return;
  try{
   if(!document.hidden){
    const now=performance.now(),key=currentKey();
    if(current?.song.trackKey!==key&&!standby&&song?.trackKey===key&&now>=retryAt)accept(song);
    if(current){
     const position=current.song.trackKey===key?anchor+(playing?now-stamp:0):current.position+(playing?now-current.stamp:0);
     current.position=position;current.stamp=now;current.scene.update(position);
     if(outgoing){
      const mix=flowHandoffFrame(now-transitionAt);
      outgoing.scene.update(outgoing.position+(playing?now-outgoing.stamp:0));
      outgoing.scene.root.style.opacity=String(mix.outgoingAlpha);outgoing.scene.root.style.transform=`translateX(${mix.outgoingX}px)`;
      current.scene.root.style.opacity=String(mix.incomingAlpha);current.scene.root.style.transform=`translateX(${mix.incomingX}px)`;
      if(mix.done){release(outgoing);outgoing=null;current.scene.root.style.transform='';pendingKey='';prepareUpcoming();}
     }else{current.scene.root.style.opacity='1';current.scene.root.style.transform='';}
    }
    if(standby&&(!standby.ready||standby.position!==standby.expectedPosition)){standby.position=standby.expectedPosition;standby.scene.update(standby.expectedPosition);}
   }
   raf=requestAnimationFrame(frame);
  }catch(error){console.error('[flow] scene frame failed',error);root.classList.add('is-failed');}
 };
 const deactivate=()=>{
  active=false;++token;pendingKey='';cancelAnimationFrame(raf);raf=0;unsubscribe?.();unsubscribe=null;
  release(current);release(standby);release(outgoing);current=standby=outgoing=null;
  root.classList.remove('is-on','is-ready','is-painted');
 };
 return {
  root,
  setPalette(colors){previewPalette=[...colors];palette=[...colors];const key=currentKey();for(const slot of [current,standby])if(slot?.song.trackKey===key&&JSON.stringify(slot.colors)!==JSON.stringify(colors)){slot.colors=[...colors];slot.scene.setPalette(colors);}},
  setMode(_mode:LumiereMode){},
  setSong(input){song=input;if(input)accept(input);root.classList.toggle('is-content',!!input);},
  activate(){
   if(active||disposed)return;active=true;root.classList.remove('is-failed');root.classList.add('is-on');
   sync();if(song)accept(song);unsubscribe=onPlayer(sync);frame();
  },
  deactivate,
  dispose(){disposed=true;deactivate();root.remove();},
 };
}
