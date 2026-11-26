import {dot,girder,lamp,shape,stroke,type Brush,type Random} from './paint';

// All elevations are in a 1024 × 576 world. Land is drawn to the waterline;
// reflections are sampled from the actual illuminated shoreline below it.
export const WIDTH=1024;
export const HEIGHT=576;
export const TIDE=407;
const steel='#22313a', shadow='#111e28', warm='#ffc681', cool='#a7e3db';

function warehouse(g: Brush,x: number,y: number,w: number,h: number,rand: Random) {
  const teeth=Math.max(2,Math.round(w/24));
  g.fillStyle=steel;
  g.fillRect(x,y-h,w,h);
  for(let i=0;i<teeth;i++){
    const left=x+w*i/teeth;
    shape(g,[[left,y-h],[left+w/teeth-4,y-h-9],[left+w/teeth,y-h]],steel);
    stroke(g,[[left+2,y-h],[left+w/teeth-5,y-h-8]],'#52616a',1);
  }
  for(let i=4;i<w-5;i+=8){
    const lit=rand()>.50;
    g.fillStyle=lit?'#c19765':'#34444b';
    g.fillRect(x+i,y-h+7,5,3);
  }
  for(let i=15;i<w-12;i+=32){
    g.fillStyle=shadow;
    g.fillRect(x+i,y-19,19,19);
    lamp(g,x+i+9,y-21,8,warm);
  }
}

function containerYard(g: Brush,rand: Random){
  const paints=['#4a4142','#354f56','#594840','#45575b'];
  for(let i=0;i<22;i++){
    const count=1+Math.floor(rand()*4);
    for(let j=0;j<count;j++){
      const x=i*46+4,y=TIDE-11-j*13;
      g.fillStyle=paints[Math.floor(rand()*paints.length)];
      g.fillRect(x,y-12,44,11);
      for(let k=3;k<42;k+=4){
        g.fillStyle='rgba(4,15,24,.26)';
        g.fillRect(x+k,y-11,1,9);
      }
    }
  }
}

function portCrane(g: Brush,x: number,scale: number,raised: boolean){
  g.save();g.translate(x,TIDE-12);g.scale(scale,scale);
  const boomY=raised?-173:-108;
  girder(g,[-36,0],[-16,-108],6,9,steel);
  girder(g,[36,0],[13,-108],6,9,steel);
  girder(g,[-42,-39],[37,-39],6,8,steel);
  girder(g,[-75,-109],[26,-109],8,9,steel);
  girder(g,[26,-109],[133,boomY],6,10,steel);
  girder(g,[-13,-111],[-8,-165],6,4,steel);
  stroke(g,[[-73,-108],[-6,-165],[131,boomY]],steel,2.7);
  stroke(g,[[-6,-165],[61,-111+(boomY+108)*.32]],steel,1.8);
  g.fillStyle='#526069';g.fillRect(-34,-120,35,10);
  g.fillStyle=shadow;g.fillRect(23,-103,17,12);
  g.fillStyle='#b6c5a6';g.fillRect(26,-101,5,3);
  const lift=raised?66:44;
  stroke(g,[[81,boomY+5],[81,boomY+lift],[89,boomY+lift],[89,boomY+6]],steel,1);
  g.fillStyle=steel;g.fillRect(74,boomY+lift,22,3);
  lamp(g,-5,-166,7,'#ff775d');
  lamp(g,30,-92,11,warm);
  g.restore();
}

function tanks(g: Brush,x: number,y: number,r: number,h: number){
  const shell=g.createLinearGradient(x-r,0,x+r,0);
  shell.addColorStop(0,'#273841');shell.addColorStop(.29,'#536068');shell.addColorStop(.62,'#34464e');shell.addColorStop(1,'#1c2f38');
  g.fillStyle=shell;g.fillRect(x-r,y-h,r*2,h);
  g.beginPath();g.ellipse(x,y-h,r,5,0,0,Math.PI*2);g.fill();
  for(let row=1;row<4;row++){
    stroke(g,[[x-r,y-h*row/4],[x+r,y-h*row/4]],'#42535a',1);
  }
  const ladder=x+r*.59;
  stroke(g,[[ladder,y],[ladder,y-h-6]],steel,1.3);
  stroke(g,[[ladder+4,y],[ladder+4,y-h-6]],steel,1.3);
  for(let t=y-2;t>y-h-3;t-=5)stroke(g,[[ladder,t],[ladder+4,t]],steel,1);
}

function tower(g: Brush,x: number,y: number,h: number) {
  shape(g,[[x-6,y],[x-3,y-h],[x+3,y-h],[x+7,y]],'#31434c');
  for(let k=0;k<3;k++) {
    g.fillStyle='#6f5753';
    g.fillRect(x-3.2,y-h+4+k*8,6.5,4);
  }
  lamp(g,x,y-h,7,'#ff8164');
}

function refinery(g: Brush,rand: Random){
  for(let i=0;i<9;i++)tower(g,48+i*115+rand()*30,TIDE-8,48+rand()*90);
  for(let i=0;i<8;i++)tanks(g,48+i*132,TIDE-8,30+rand()*22,25+rand()*33);
  for(let i=0;i<13;i++){
    const x=i*81;
    stroke(g,[[x,TIDE-8],[x,TIDE-35],[x+88,TIDE-35]],'#52616a',3);
    lamp(g,x+15,TIDE-38,9,warm);
  }
}

function ferry(g: Brush,x: number,y: number,scale: number){
  g.save();g.translate(x,y);g.scale(scale,scale);
  shape(g,[[-106,-11],[113,-14],[83,4],[-88,4]],shadow);
  shape(g,[[-82,-24],[65,-24],[87,-12],[-93,-12]],'#657179');
  shape(g,[[-58,-37],[36,-37],[58,-25],[-65,-25]],'#536569');
  g.fillStyle='#39464b';g.fillRect(-34,-52,13,14);
  g.fillStyle='#ac725a';g.fillRect(-34,-53,13,4);
  stroke(g,[[24,-38],[24,-61],[38,-45]],steel,2);
  for(let i=-75;i<=61;i+=9){
    g.fillStyle=i%3===0?'#fae2a3':'#b2c8b7';g.fillRect(i,-21,5,3);
  }
  for(let i=-52;i<=28;i+=9){g.fillStyle='#acc7be';g.fillRect(i,-34,6,4);}
  lamp(g,90,-14,13,cool);lamp(g,24,-60,6,warm);
  g.restore();
}

function lighthouse(g: Brush,x: number,y: number){
  shape(g,[[x-10,y],[x-6,y-54],[x+6,y-54],[x+11,y]],'#a6917c');
  shape(g,[[x-8,y-21],[x-7,y-35],[x+7,y-35],[x+8,y-21]],'#754d47');
  g.fillStyle=steel;g.fillRect(x-9,y-55,18,3);
  g.fillStyle=warm;g.fillRect(x-5,y-63,10,8);
  shape(g,[[x-9,y-64],[x,y-72],[x+9,y-64]],steel);
  lamp(g,x,y-59,22,warm);
}

function passengerPier(g: Brush,rand: Random){
  warehouse(g,20,TIDE-6,184,28,rand);
  warehouse(g,245,TIDE-8,133,20,rand);
  ferry(g,480,TIDE-3,.86);
  ferry(g,740,TIDE-2,.62);
  lighthouse(g,939,TIDE-5);
  for(let x=8;x<WIDTH;x+=61){
    g.fillStyle=shadow;g.fillRect(x,TIDE-4,3,10);
    stroke(g,[[x,TIDE-6],[x+5,TIDE-30]],steel,1.2);
    lamp(g,x+5,TIDE-30,8,warm);
  }
}

function oldTown(g: Brush,rand: Random){
  let x=-3;
  while(x<WIDTH){
    const w=25+rand()*39,h=16+rand()*39,y=TIDE-5;
    g.fillStyle=rand()>.5?'#38474d':'#2d3b44';g.fillRect(x,y-h,w,h);
    shape(g,[[x-2,y-h],[x+w*.42,y-h-9-rand()*12],[x+w+2,y-h]],'#24333d');
    for(let j=6;j<w-4;j+=10)for(let k=7;k<h-3;k+=10){
      g.fillStyle=rand()>.52?'#d5b98a':'#263741';g.fillRect(x+j,y-h+k,4,5);
    }
    x+=w+2;
  }
}

function viaduct(g: Brush){
  const base=TIDE-54;
  for(let x=-30;x<WIDTH+80;x+=132){
    g.fillStyle='#283b46';g.fillRect(x,base,11,58);
    girder(g,[x,base-15],[x+132,base-15],13,10,'#344954');
    stroke(g,[[x+6,base+22],[x+30,base],[x+105,base],[x+137,base+22]],'#344954',5);
    lamp(g,x+60,base-17,7,cool);
  }
}

export function makeQuay(index: number,rand: Random): HTMLCanvasElement {
  const image=document.createElement('canvas');
  image.width=WIDTH;image.height=HEIGHT;
  const g=image.getContext('2d')!;
  switch(index){
    case 0: case 3:
      containerYard(g,rand);
      portCrane(g,130,.82,false);portCrane(g,413,1.04,true);portCrane(g,767,.9,false);
      break;
    case 1: refinery(g,rand);break;
    case 2: passengerPier(g,rand);break;
    case 4: oldTown(g,rand);break;
    case 5: viaduct(g);ferry(g,420,TIDE-2,.6);break;
    default:
      for(let i=0;i<5;i++)warehouse(g,10+i*205,TIDE-5,160+rand()*35,20+rand()*23,rand);
      portCrane(g,785,.62,true);
  }
  g.fillStyle='#192933';g.fillRect(0,TIDE-4,WIDTH,6);
  for(let i=0;i<17;i++)lamp(g,i*63+rand()*16,TIDE-3,4+rand()*6,i%5===0?cool:warm);
  // Sample narrow strips of the quay into a broken reflection, using a separate source
  // for horizontal displacement so no strip feeds its neighbour on the next iteration.
  const land=document.createElement('canvas');
  land.width=WIDTH;land.height=TIDE+2;
  land.getContext('2d')!.drawImage(image,0,0);
  for(let depth=3;depth<HEIGHT-TIDE;depth+=2){
    const sourceY=TIDE-2-depth*.94;
    g.globalAlpha=.43*Math.exp(-depth/64)*(.4+rand()*.6);
    const dx=(rand()-.5)*(1+depth*.19);
    g.drawImage(land,0,sourceY,WIDTH,1,dx,TIDE+depth,WIDTH,1+rand()*1.5);
  }
  return image;
}

export function makeCity(rand: Random){
  const image=document.createElement('canvas');
  image.width=WIDTH;image.height=HEIGHT;
  const g=image.getContext('2d')!;
  for(let depth=0;depth<2;depth++){
    let x=-8;
    while(x<WIDTH){
      const w=8+rand()*32;
      const h=12+rand()*(depth?50:82);
      const y=TIDE-13-h;
      g.fillStyle=depth?'#354851':'#465660';g.fillRect(x,y,w,h);
      if(rand()>.78){
        stroke(g,[[x+w*.6,y],[x+w*.6,y-rand()*16]],'#51606a',1);
        dot(g,x+w*.6,y-3,.8,'#c4937c');
      }
      for(let a=3;a<w-1;a+=4)for(let b=4;b<h-3;b+=6){
        if(rand()>.65){g.fillStyle=rand()>.5?'#81938f':'#aa9986';g.fillRect(x+a,y+b,1.5,1.2);}
      }
      x+=w+rand()*4;
    }
  }
  return image;
}
