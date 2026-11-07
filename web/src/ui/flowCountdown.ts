import type { LumiereSongInput } from './lumiere';
import { flowHash } from './flowMotion';

export const FLOW_COUNTDOWN_STYLES=['dots','tiles','orbit','diamonds','capsules','rings','digits','triangles','hexagons','meter','petals','cubes'] as const;
export function flowCueFrame(song:LumiereSongInput|null,timeMs:number){
 if(!song||!Number.isFinite(timeMs))return null;
 let previousEnd=0;
 for(let i=0;i<song.lines.length;i++){
  const line=song.lines[i]!;
  const starts=line.words.map(word=>word.startMs).filter(value=>Number.isFinite(value)&&value>=0);
  const onset=starts.length?Math.min(...starts):line.timeMs;
  const gap=onset-previousEnd;
  if(gap>=1500&&timeMs>=Math.max(previousEnd,onset-3000)&&timeMs<onset+220){
   const remain=Math.max(0,onset-timeMs),span=Math.min(3000,gap);
   return {style:FLOW_COUNTDOWN_STYLES[flowHash(`${song.trackKey}:${i}:cue`)%FLOW_COUNTDOWN_STYLES.length]!,count:Math.max(1,Math.ceil(remain/1000)),progress:Math.max(0,Math.min(1,(timeMs-(onset-span))/span)),alpha:timeMs<onset?Math.min(1,(timeMs-(onset-span))/160):Math.max(0,1-(timeMs-onset)/220)};
  }
  previousEnd=Math.max(previousEnd,line.words.length?Math.max(...line.words.map(word=>word.endMs)):line.timeMs+line.durationMs);
 }
 return null;
}

export function createFlowCountdown(host:HTMLElement){
 const root=document.createElement('div');root.className='flow-countdown';root.setAttribute('aria-hidden','true');root.hidden=true;
 const points=Array.from({length:3},()=>{const point=document.createElement('span');point.className='flow-countdown-point';root.append(point);return point;});
 const number=document.createElement('span');number.className='flow-countdown-number';root.append(number);host.append(root);
 return {update(song:LumiereSongInput|null,time:number,color:string){
  const frame=flowCueFrame(song,time);root.hidden=!frame;if(!frame)return;
  root.dataset.style=frame.style;root.style.color=color;root.style.opacity=String(frame.alpha);root.style.transform=`translateX(-50%) translateY(${(1-frame.alpha)*7}px)`;
  number.textContent=String(frame.count);
  points.forEach((point,i)=>{
   const live=i<frame.count;
   point.style.opacity=String(live?1:.16);
   const pop=live&&i===frame.count-1?1+Math.sin(frame.progress*Math.PI*6)*.12:1;
   if(frame.style==='orbit'||frame.style==='petals'){
    const angle=i/3*Math.PI*2+frame.progress*Math.PI;
    point.style.transform=`translate(${Math.cos(angle)*22}px,${Math.sin(angle)*16}px) scale(${live?pop:.6})`;
   }else point.style.transform=`translateY(${live&&frame.style==='tiles'?-i*4:0}px) rotate(${frame.style==='diamonds'?45:0}deg) scale(${live?pop:.65})`;
  });
 }};
}
