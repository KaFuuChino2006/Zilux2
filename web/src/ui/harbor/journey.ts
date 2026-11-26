import type { LumiereSongInput } from '../lumiere';

interface SpeedMark {
  time: number;
  speed: number;
  distance: number;
}

const CRUISE = 32;
const COAST = 23;

// Distances are the analytic integral of a smoothstep velocity curve. Travel
// stays continuous through a lyric onset, a rapid cluster and a long rest.
// Evaluating from song time also makes a seek land at the same quay as playback.
function displacement(a: SpeedMark,b: SpeedMark,elapsed: number) {
  const span = b.time-a.time;
  const u = Math.min(1,Math.max(0,elapsed/span));
  return a.speed*elapsed + (b.speed-a.speed)*span*u*u*u*(1-u*.5);
}

export function compileRailJourney(song: LumiereSongInput | null) {
  const marks: SpeedMark[] = [{time:0,speed:COAST,distance:0}];
  function mark(time: number,speed: number) {
    const last=marks[marks.length-1];
    if(time <= last.time) return;
    const next={time,speed,distance:0};
    next.distance=last.distance+displacement(last,next,time-last.time);
    marks.push(next);
  }
  const lines = song?.lines ?? [];
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(!line.text.trim())continue;
    const start=Math.max(0,line.timeMs/1000);
    const end=Math.min(start+Math.max(.12,line.durationMs/1000),
      i+1<lines.length?lines[i+1].timeMs/1000:Infinity);
    if(end<=start)continue;
    const density=Array.from(line.text.trim()).length/Math.max(.8,end-start);
    const last=marks[marks.length-1];
    if(start-last.time>3.2){
      mark(last.time+1.45,COAST);
      mark(Math.max(last.time+1.46,start-1.3),COAST);
    }
    mark(start+(end-start)*.42,CRUISE+Math.min(17,density*2.3));
    mark(end,CRUISE+Math.min(7,density));
  }
  const last=marks[marks.length-1];
  mark(last.time+2.7,COAST);
  return (time: number) => {
    let low=0,high=marks.length;
    while(low+1<high){
      const mid=(low+high)>>>1;
      if(marks[mid].time<=time)low=mid;
      else high=mid;
    }
    const a=marks[low],b=marks[low+1],elapsed=Math.max(0,time-a.time);
    return a.distance+(b?displacement(a,b,elapsed):elapsed*a.speed);
  };
}
