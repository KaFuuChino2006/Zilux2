import { flowHash } from './flowMotion';

export interface FlowHistory {step:number;shown:Record<string,{count:number;last:number}>}
const KEY='zilux2.flowRotation.v1';
export function readFlowHistory():FlowHistory {
 try {
  const raw=JSON.parse(localStorage.getItem(KEY)||'{}');
  const result:FlowHistory={step:Number.isSafeInteger(raw.step)&&raw.step>=0?raw.step:0,shown:{}};
  for(const [id,value]of Object.entries(raw.shown??{})){
   const item=value as {count:number;last:number};
   if(/^\d+$/.test(id)&&Number.isSafeInteger(item?.count)&&item.count>0&&Number.isSafeInteger(item.last)&&item.last>=0&&item.last<=result.step)result.shown[id]=item;
  }
  return result;
 }catch{return {step:0,shown:{}};}
}
export function flowWeight(history:FlowHistory,id:number):number {
 const item=history.shown[id];
 const age=Math.min(2000,history.step-(item?.last??-1));
 return Math.pow(1+age,1.15)/Math.sqrt(1+(item?.count??0)*0.15);
}
function mark(history:FlowHistory,ids:number[]):void {
 history.step++;
 for(const id of new Set(ids))history.shown[id]={count:(history.shown[id]?.count??0)+1,last:history.step};
}
export function recordFlowCompositions(ids:number[]):void {
 if(!ids.length)return;
 const history=readFlowHistory();mark(history,ids);
 try{localStorage.setItem(KEY,JSON.stringify(history));}catch{/* Keep playback working without persistent storage. */}
}
/** Plan locally; only frames actually rendered commit exposure to persistent history. */
export function createFlowPicker(pool:readonly number[],seed:string,history:FlowHistory){
 const ids=[...new Set(pool)];
 const simulated:FlowHistory={step:history.step,shown:Object.fromEntries(Object.entries(history.shown).map(([id,item])=>[id,{...item}]))};
 let draw=0,last=-1;
 return (exclude:readonly number[]=[]):number=>{
  const candidates=ids.filter(id=>!exclude.includes(id));
  const nonrepeat=candidates.filter(id=>id!==last);
  const choices=nonrepeat.length?nonrepeat:candidates.length?candidates:ids;
  if(!choices.length)throw new Error('Empty composition pool');
  const weights=choices.map(id=>flowWeight(simulated,id));
  let ticket=flowHash(`${seed}:${draw++}:composition`)/4294967296*weights.reduce((a,b)=>a+b,0);
  let selected=choices.at(-1)!;
  for(let i=0;i<choices.length;i++){ticket-=weights[i]!;if(ticket<0){selected=choices[i]!;break;}}
  last=selected;mark(simulated,[selected]);return selected;
 };
}
