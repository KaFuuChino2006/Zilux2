import { compileRailJourney } from './journey';
import type { LumiereSongInput } from '../lumiere';
import { flowHash } from '../flowMotion';
import { resolveTemperaCameraBreath } from '../lumiere-folia/components/visualizer/tempera/temperaCamera';
import { makeCity,makeQuay,WIDTH,HEIGHT,TIDE } from './quay';
import { dot,girder,lamp,seeded,stroke,type Brush } from './paint';

const modulo = (x: number,period: number) => ((x%period)+period)%period;

function surface(){
  const c=document.createElement('canvas');
  c.style.cssText='position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  return c;
}

function makeSky(seed: number,accent: string){
  const sky=document.createElement('canvas');
  sky.width=WIDTH;sky.height=HEIGHT;
  const g=sky.getContext('2d')!,rand=seeded(seed);
  const dusk=g.createLinearGradient(0,0,0,HEIGHT);
  dusk.addColorStop(0,'#091621');
  dusk.addColorStop(.4,'#233848');
  dusk.addColorStop(.67,'#827275');
  dusk.addColorStop(.72,'#4b5960');
  dusk.addColorStop(.78,'#293e49');
  dusk.addColorStop(1,'#0c1b29');
  g.fillStyle=dusk;g.fillRect(0,0,WIDTH,HEIGHT);
  const aurora=g.createRadialGradient(WIDTH*.69,TIDE,10,WIDTH*.69,TIDE,440);
  aurora.addColorStop(0,accent+'59');aurora.addColorStop(1,accent+'00');
  g.fillStyle=aurora;g.fillRect(0,0,WIDTH,HEIGHT);
  for(let i=0;i<138;i++){
    const x=rand()*WIDTH,y=rand()*HEIGHT*.49;
    g.globalAlpha=(1-y/HEIGHT)*(.1+rand()*.5);
    dot(g,x,y,.25+rand()*.65,'#d1d8df');
  }
  g.globalAlpha=1;
  // A low moon behind a veil of salt haze. This is painted once per palette.
  const x=WIDTH*.74,y=HEIGHT*.28,r=19;
  const halo=g.createRadialGradient(x,y,1,x,y,140);
  halo.addColorStop(0,'#f8ce9f4f');halo.addColorStop(.36,'#f9cbb31b');halo.addColorStop(1,'#d7c8ac00');
  g.fillStyle=halo;g.fillRect(x-140,y-140,280,280);
  dot(g,x,y,r,'#dfcbb4');
  for(let i=0;i<65;i++){
    const cy=y-26+rand()*78;
    const opacity=rand()*.06;
    g.fillStyle='rgba(136,137,152,'+opacity+')';
    g.fillRect(x-160+rand()*110,cy,100+rand()*200,1+rand()*3);
  }
  for(let i=0;i<780;i++){
    const ry=TIDE+rand()*(HEIGHT-TIDE);
    g.globalAlpha=.06+rand()*.16;
    g.fillStyle='#98b0b2';
    g.fillRect(rand()*WIDTH,ry,2+rand()*13,.6);
  }
  g.globalAlpha=1;
  return sky;
}

function makeGlass(seed: number){
  const panel=document.createElement('canvas');
  panel.width=WIDTH;panel.height=HEIGHT;
  const g=panel.getContext('2d')!,rand=seeded(seed);
  const shade=g.createRadialGradient(WIDTH*.48,HEIGHT*.46,HEIGHT*.29,WIDTH*.48,HEIGHT*.46,WIDTH*.65);
  shade.addColorStop(0,'#050a1000');shade.addColorStop(.71,'#07101a24');shade.addColorStop(1,'#03070c87');
  g.fillStyle=shade;g.fillRect(0,0,WIDTH,HEIGHT);
  for(let i=0;i<132;i++){
    const x=rand()*WIDTH,y=rand()*HEIGHT,r=.4+rand()*1.55;
    g.globalAlpha=.18+rand()*.29;
    g.fillStyle='#0a1520';g.beginPath();g.ellipse(x,y,r,r*1.45,.2,0,Math.PI*2);g.fill();
    dot(g,x-r*.22,y-r*.61,r*.45,'#c9dcde');
    if(i%11===0)stroke(g,[[x,y],[x+1,y-8],[x+1.6,y-16]],'#a4afae35',.75);
  }
  g.globalAlpha=1;
  const inside=g.createLinearGradient(0,0,0,85);
  inside.addColorStop(0,'#ffd6a900');inside.addColorStop(.42,'#f5dfbe0a');inside.addColorStop(.54,'#ffe8b81a');inside.addColorStop(.62,'#e7dfc805');inside.addColorStop(1,'#e7dfc800');
  g.save();g.rotate(-.085);g.fillStyle=inside;g.fillRect(WIDTH*.05,0,WIDTH*.42,85);g.restore();
  return panel;
}

function drawBridge(g: Brush,start: number,viewWidth: number) {
  const span=810,first=Math.floor(start/span);
  for(let i=first;i<=Math.floor((start+viewWidth)/span);i++){
    const x=i*span-start;
    // Only some portions of the route cross the steel bridge. Open water
    // between spans gives longer lines of type an unobstructed reading interval.
    if(modulo(i,10)>2)continue;
    g.fillStyle='#0c1922';
    g.fillRect(x,0,7,HEIGHT);
    stroke(g,[[x+4,HEIGHT],[x+175,0]],'#13202bee',12);
    girder(g,[x,14],[x+span,14],16,20,'#17232d');
    lamp(g,x+12,33,8,'#f3bb88');
  }
}

function tile(g: Brush,origin: number,viewWidth: number,draw: (i: number)=>HTMLCanvasElement){
  const first=Math.floor(origin/WIDTH),last=Math.floor((origin+viewWidth)/WIDTH);
  for(let i=first;i<=last;i++)g.drawImage(draw(i),i*WIDTH-origin,0);
}

export function createHarborWindow(){
  const coast=surface(),glass=surface();
  const ctx=coast.getContext('2d',{alpha:false})!,top=glass.getContext('2d')!;
  let positionAt = compileRailJourney(null);
  let seed=8,accent='#eba870',sky: HTMLCanvasElement|null=null,windowPane: HTMLCanvasElement|null=null;
  const city=new Map<number,HTMLCanvasElement>(),quays=new Map<number,HTMLCanvasElement>();
  let lastTime=NaN,lastW=0,lastH=0;
  const cached=(index: number,distant: boolean)=>{
    const key=modulo(index,distant?3:7);
    const bank=distant?city:quays;
    let item=bank.get(key);
    if(!item){
      const random=seeded(seed+key*73693);
      item=distant?makeCity(random):makeQuay(key,random);
      bank.set(key,item);
    }
    return item;
  };
  return {
    coast,glass,
    setTrack(song: LumiereSongInput | null){
      positionAt = compileRailJourney(song);
      lastTime = NaN;
      const next=flowHash(song?.trackKey ?? '');
      if(next===seed)return;
      seed=next;sky=null;windowPane=null;city.clear();quays.clear();lastTime=NaN;
    },
    setAccent(color?: string){
      const next=color && /^#[0-9a-f]{6}$/i.test(color)?color:'#eba870';
      if(next!==accent){accent=next;sky=null;lastTime=NaN;}
    },
    draw(time: number){
      const w=coast.clientWidth,h=coast.clientHeight;
      if(!w || !h)return;
      if(time===lastTime && w===lastW && h===lastH)return;
      lastTime=time;lastW=w;lastH=h;
      // The photographic layers are deliberately softer than the GPU lettering.
      const pixelScale=Math.min(1.25,1920/w,1152/h);
      const pw=Math.max(1,Math.round(w*pixelScale)),ph=Math.max(1,Math.round(h*pixelScale));
      if(coast.width!==pw || coast.height!==ph){
        coast.width=glass.width=pw;coast.height=glass.height=ph;
      }
      const scale=ph/HEIGHT,viewWidth=pw/scale;
      ctx.setTransform(scale,0,0,scale,0,0);
      top.setTransform(scale,0,0,scale,0,0);
      sky??=makeSky(seed,accent);
      windowPane??=makeGlass(seed);
      ctx.drawImage(sky,0,0,viewWidth,HEIGHT);
      const breath=resolveTemperaCameraBreath(time,seed%19);
      const journey=(seed%701)*9+positionAt(time);
      ctx.save();
      ctx.translate(0,breath.y*91);
      tile(ctx,journey*.19,viewWidth,i=>cached(i,true));
      tile(ctx,journey*.89,viewWidth,i=>cached(i,false));
      // Floating glints run in water coordinates. Changing their phase with
      // playback time makes a paused reflection completely still.
      ctx.fillStyle='#ffcda0';
      for(let i=0;i<67;i++){
        const depth=i%19/19;
        const x=modulo(i*83.17-journey*(.26+depth*.15),viewWidth+34)-17;
        const y=TIDE+8+depth*117+Math.sin(time*.8+i)*1.3;
        ctx.globalAlpha=.08+.12*(.5+.5*Math.sin(time*1.25+i*7.1));
        ctx.fillRect(x,y,3+depth*15,.7+depth*.55);
      }
      ctx.restore();
      top.clearRect(0,0,viewWidth,HEIGHT);
      drawBridge(top,journey*4.7,viewWidth);
      top.drawImage(windowPane,0,0,viewWidth,HEIGHT);
    },
    dispose(){city.clear();quays.clear();sky=null;windowPane=null;coast.remove();glass.remove();},
  };
}
