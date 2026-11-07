import type { LumiereSongInput } from './lumiere';

export function flowSongSignature(song:LumiereSongInput|null):string {
 return song?JSON.stringify([song.trackKey,song.lyricOffsetMs,song.lines]):'';
}
export function flowHandoffFrame(elapsedMs:number){
 const t=Math.max(0,Math.min(1,elapsedMs/450));
 const mix=t*t*(3-2*t);
 return {mix,outgoingAlpha:1,incomingAlpha:mix,outgoingX:-24*mix,incomingX:24*(1-mix),done:t===1};
}
