import type { LumiereMode, LumiereSongInput, LumiereStage } from './lumiere';
import { lumiereThemeForCover } from './lumiere';
import { onPlayer, playerState, peekUpcoming, getTransitionTarget } from './player';
import { createFlowScene } from './flowScene';
import { coverColorsOf, fallbackColors } from './coverColors';
import { flowHandoffFrame, flowSongSignature } from './flowHandoff';
import { lyricsBackgroundMode, preloadLyricSong } from './lyrics';
import { readCrossfadeDebug } from './crossfadeDeck';
import type { Theme } from './lumiere-folia/types';

import { createOverlapScene, createWenflashScene } from './overlapScene';
import { perfEvent, perfMark, perfOn } from './perfProbe';

let previewPalette:string[]=[];
export function flowCoverPalette():string[]{return [...previewPalette];}
export type FlowStage = Pick<LumiereStage,'root'|'setMode'|'setSong'|'activate'|'deactivate'|'dispose'> & {setPalette(colors:string[]):void;setTheme(theme:Theme):void};
type Slot={scene:Pick<ReturnType<typeof createFlowScene>,'update'|'dispose'|'setSong'|'setTheme'|'setPalette'|'resize'|'setUsageRecording'> & {root:HTMLElement};song:LumiereSongInput;signature:string;colors:string[];ready:boolean;position:number;expectedPosition:number;stamp:number};

/** At most two surfaces: the playing scene and one prepared/retiring neighbour. */
export function createFlowStage():FlowStage {
 const root=document.createElement('div');root.className='lyrics-stage is-flow';
 let overlap: 'overlap' | 'wenflash' | false = false;
 let current:Slot|null=null,standby:Slot|null=null,outgoing:Slot|null=null;
 // 切歌最贵的一步不是换歌本身，是「为下一首新建一整只 Pixi 运行时」：新 WebGL 上下文 +
 // 云母/字形图集冷启动，实测一个 102 镜头的段落首帧要 430ms，而同一只运行时里重建同一段
 // 只要 17ms。所以退场的舞台不销毁，留一只当备胎，下一首直接在这只热运行时里换歌。
 let spare:Slot|null=null;
 let song:LumiereSongInput|null=null,palette:string[]=[],theme:Theme|null=null;
 let active=false,disposed=false,raf=0,token=0,pendingKey='',retryAt=0;
 let anchor=0,stamp=0,playing=false,transitionAt=0;
 let cueCheckedAt=-Infinity,cue= {phase:'idle',nextTitle:'',bStartFileMs:0};
 let unsubscribe:(()=>void)|null=null;
 const currentKey=()=>{const track=playerState().track;return track?`${track.source}:${track.id}`:'';};
 const background=new URLSearchParams(window.location.search).get('scene')==='backgroundLyrics';
 const release=(slot:Slot|null)=>{if(!slot)return;perfEvent('flow.release');const startedAt=perfOn()?performance.now():0;slot.scene.dispose();if(startedAt)perfMark('flow.release.dispose',startedAt);};
 const takeSpare=():Slot|null=>{const slot=spare;spare=null;return slot;};
 /** 退场舞台不销毁：藏起来留作备胎，下一首直接在这只热运行时里换歌，省掉整只运行时的冷启动。 */
 const retire=(slot:Slot|null)=>{if(!slot)return;if(spare&&spare!==slot){release(slot);return;}perfEvent('flow.retire');slot.ready=false;slot.position=0;slot.expectedPosition=0;slot.scene.setUsageRecording(false);slot.scene.root.style.opacity='0';slot.scene.root.style.transform='';spare=slot;};

 function promote(slot:Slot){
  if(!active||!slot.ready||slot.song.trackKey!==currentKey()||slot===current)return;
  perfEvent('flow.promote');
  release(outgoing);outgoing=current;current=slot;if(standby===slot)standby=null;
  current.scene.setUsageRecording(true);
  if(outgoing){outgoing.scene.setUsageRecording(false);outgoing.stamp=performance.now();}
  transitionAt=performance.now();
  root.classList.remove('is-failed');root.classList.add('is-ready','is-painted','is-content');
 }
 function createSlot(input:LumiereSongInput,colors:string[],forcedTheme?:Theme):Slot{
  const pooled=takeSpare();
  if(pooled){
   const startedAt=perfOn()?performance.now():0;
   pooled.song=input;pooled.signature=flowSongSignature(input);pooled.colors=[...colors];
   pooled.ready=false;pooled.position=0;pooled.expectedPosition=0;pooled.stamp=performance.now();
   pooled.scene.setPalette(colors);
   const pooledTheme=forcedTheme??theme;if(pooledTheme)pooled.scene.setTheme(pooledTheme);
   pooled.scene.setSong(input);
   // 复用的运行时不会再触发 onPainted：等这一帧（flush 里换歌 + 重画）落完再标就绪。
   requestAnimationFrame(()=>{
    if(disposed||(pooled!==current&&pooled!==standby))return;
    pooled.ready=true;
    if(pooled===current){root.classList.remove('is-failed');root.classList.add('is-ready','is-painted');}
    else if(pooled.song.trackKey===currentKey())promote(pooled);
   });
   if(startedAt)perfMark('flow.reuseSlot',startedAt);
   return pooled;
  }
  let slot:Slot;
  const makeScene=overlap==='wenflash'?createWenflashScene:overlap?createOverlapScene:createFlowScene;
  const scene=makeScene(()=>{
   slot.ready=true;
   if(slot===current){root.classList.remove('is-failed');root.classList.add('is-ready','is-painted');}
   else if(slot===standby&&slot.song.trackKey===currentKey())promote(slot);
  },(error:unknown)=>{
   console.warn('[flow] scene preparation failed',error);
   if(slot===standby){standby=null;release(slot);pendingKey='';retryAt=performance.now()+3000;}
   else if(slot===current){current=null;release(slot);retryAt=performance.now()+3000;root.classList.add('is-failed');root.classList.remove('is-ready','is-painted');}
  },false);
  slot={scene,song:input,signature:flowSongSignature(input),colors:[...colors],ready:false,position:0,expectedPosition:0,stamp:performance.now()};
  {const startedAt=perfOn()?performance.now():0;scene.root.style.opacity='0';root.append(scene.root);scene.setPalette(colors);const slotTheme=forcedTheme??theme;if(slotTheme)scene.setTheme(slotTheme);scene.setSong(input);scene.resize();if(startedAt)perfMark('flow.createSlot',startedAt);}
  return slot;
 }
 /** 预建备场时就把「这首歌自己的主题」算出来：切歌瞬间歌词页再推一次主题时签名相同，
  *  scene.setTheme 直接短路，省掉一次整场清空重建（大段落重建能到 200ms 以上）。 */
 const themeForSong=(input:LumiereSongInput,colors:string[]):Theme=>lumiereThemeForCover(lyricsBackgroundMode(),colors,input.lines.map(line=>line.text).join(' '));
 function accept(input:LumiereSongInput){perfEvent('flow.accept');
  if(!active||input.trackKey!==currentKey()||(overlap&&!input.lines.length))return;
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
  if(!current){current=createSlot(input,palette,themeForSong(input,palette));current.scene.root.style.opacity='1';current.scene.setUsageRecording(true);return;}
  ++token;pendingKey='';retire(outgoing);outgoing=null;retire(standby);standby=createSlot(input,palette,themeForSong(input,palette));
 }
 function prepareUpcoming(){
  if(!active||disposed||outgoing||(overlap&&!current?.ready)||performance.now()<retryAt)return;
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
  if(!target||nextKey===key){if(pendingKey||standby){++token;retire(standby);standby=null;pendingKey='';}return;}
  if(standby?.song.trackKey===nextKey){standby.expectedPosition=expectedPosition;return;}
  if(nextKey===pendingKey)return;
  const request=++token;pendingKey=nextKey;retire(standby);standby=null;
  void Promise.all([
   preloadLyricSong(target),
   coverColorsOf(target).catch(()=>null),
  ]).then(([input,colors])=>{
   if(!active||disposed||request!==token)return;
   const palette=(colors??fallbackColors(`${target.title}|${target.artist}`)).palette;
   standby=createSlot(input,palette,themeForSong(input,palette));
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
    if(current?.song.trackKey!==key&&(!standby||standby.song.trackKey!==key)&&song?.trackKey===key&&now>=retryAt)accept(song);
    if(current){
     const position=current.song.trackKey===key?anchor+(playing?now-stamp:0):current.position+(playing?now-current.stamp:0);
     current.position=position;current.stamp=now;current.scene.update(position);
     if(outgoing){
      const mix=flowHandoffFrame(now-transitionAt);
      outgoing.scene.update(outgoing.position+(playing?now-outgoing.stamp:0));
      outgoing.scene.root.style.opacity=String(mix.outgoingAlpha);outgoing.scene.root.style.transform=`translateX(${mix.outgoingX}px)`;
      current.scene.root.style.opacity=String(mix.incomingAlpha);current.scene.root.style.transform=`translateX(${mix.incomingX}px)`;
      if(mix.done){perfEvent('flow.handoff.done');retire(outgoing);outgoing=null;current.scene.root.style.transform='';pendingKey='';prepareUpcoming();}
     }else{current.scene.root.style.opacity='1';current.scene.root.style.transform='';}
    }
    if(standby&&(!standby.ready||standby.position!==standby.expectedPosition)){standby.position=standby.expectedPosition;standby.scene.update(standby.expectedPosition);}
   }
   raf=requestAnimationFrame(frame);
  }catch(error){console.error('[flow] scene frame failed',error);root.classList.add('is-failed');}
 };
 const deactivate=()=>{
  active=false;++token;pendingKey='';cancelAnimationFrame(raf);raf=0;unsubscribe?.();unsubscribe=null;
  release(current);release(standby);release(outgoing);release(spare);current=standby=outgoing=null;spare=null;
  root.classList.remove('is-on','is-ready','is-painted');
 };
 return {
  root,
  setPalette(colors){previewPalette=[...colors];palette=[...colors];const key=currentKey();for(const slot of [current,standby])if(slot?.song.trackKey===key&&JSON.stringify(slot.colors)!==JSON.stringify(colors)){slot.colors=[...colors];slot.scene.setPalette(colors);}},
  setMode(mode:LumiereMode){const next=mode==='overlap'||mode==='wenflash'?mode:false;if(next!==overlap){deactivate();overlap=next;}},
  // 换歌滑出的旧画面不该被重新上色：它只剩 450ms，重建一次整场却正好落在切歌帧上。
  setTheme(next:Theme){perfEvent('flow.stage.setTheme');theme=next;for(const slot of [current,standby])slot?.scene.setTheme(next);},
  setSong(input){song=input;if(input)accept(input);root.classList.toggle('is-content',!!input&&(!overlap||input.lines.length>0));},
  activate(){
   if(active||disposed)return;active=true;root.classList.remove('is-failed');root.classList.add('is-on');
   sync();if(song)accept(song);unsubscribe=onPlayer(sync);frame();
  },
  deactivate,
  dispose(){disposed=true;deactivate();root.remove();},
 };
}
