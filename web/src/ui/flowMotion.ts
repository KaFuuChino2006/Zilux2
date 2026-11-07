import type { FlowSettings } from './flowSettings';
import type { TemperaShot } from './lumiere-folia/components/visualizer/tempera/types';

export function flowHash(text:string):number {
 let value=2166136261;
 for(let i=0;i<text.length;i++)value=Math.imul(value^text.charCodeAt(i),16777619);
 value^=value>>>16;value=Math.imul(value,0x85ebca6b);value^=value>>>13;
 return value>>>0;
}

/** Names describe the edge the artwork enters from, in screen coordinates. */
export function applyFlowMotion(shot:TemperaShot,settings:FlowSettings,seed:string):void {
 const sample=flowHash(`${seed}:${shot.id}:motion`);
 const choose=<T>(items:readonly T[])=>items[sample%items.length]!;
 let direction:string;
 if(settings.motion==='horizontal')direction=settings.horizontalDirection==='random'?choose(['left','right']):settings.horizontalDirection;
 else if(settings.motion==='vertical')direction=settings.verticalDirection==='random'?choose(['up','down']):settings.verticalDirection;
 else if(settings.motion==='diagonal')direction=settings.diagonalDirection==='random'?choose(['top-left','top-right','bottom-left','bottom-right']):settings.diagonalDirection;
 else if(settings.motion==='rotation')direction=settings.rotationDirection==='random'?choose(['clockwise','counterclockwise']):settings.rotationDirection;
 else direction=choose(['left','right','up','down','top-left','top-right','bottom-left','bottom-right','clockwise','counterclockwise']);
 shot.cameraMotion=direction==='clockwise'||direction==='counterclockwise'?'rotation':'slide';
 if(shot.cameraMotion==='rotation'){
  const sign=direction==='clockwise'?1:-1;
  const zoom=settings.rotationZoom==='random'||!settings.rotationZoom
    ? (flowHash(`${seed}:${shot.id}:rotation-zoom`)%2===0?'in':'out') : settings.rotationZoom;
  shot.flowAngle=0;
  shot.rotationSign=sign;
  shot.camera={x:0,y:0,zoom:zoom==='in'?1.02:zoom==='out'?1.22:1.10,rotation:-sign*0.24};
  shot.cameraEnd={x:0,y:0,zoom:zoom==='in'?1.22:zoom==='out'?1.02:1.10,rotation:sign*0.22};
  return;
 }
 const angles:Record<string,number>={left:0,right:Math.PI,up:Math.PI/2,down:-Math.PI/2,'top-left':Math.PI/4,'top-right':Math.PI*3/4,'bottom-left':-Math.PI/4,'bottom-right':-Math.PI*3/4};
 shot.flowAngle=angles[direction]!;
 shot.camera.x=-Math.cos(shot.flowAngle)*0.06;shot.camera.y=-Math.sin(shot.flowAngle)*0.06;
 shot.cameraEnd.x=Math.cos(shot.flowAngle)*0.03;shot.cameraEnd.y=Math.sin(shot.flowAngle)*0.03;
 shot.camera.rotation=shot.cameraEnd.rotation=0;
 shot.rotationSign=undefined;
}
