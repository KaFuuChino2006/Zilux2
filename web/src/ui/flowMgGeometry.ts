import type { TemperaCompositionContext } from './lumiere-folia/components/visualizer/tempera/temperaCompositionContext';
import type { FlowMgOptions } from './flowMg';

export const FLOW_GEOMETRY_START=112;
export const FLOW_GEOMETRY_NAMES=[
 '等轴方舟','蜂巢城堡','三角群岛','悬浮棱柱','双色球阵','折叠金字塔','环形积木','错层石阶','几何拱廊','胶囊方阵',
 '钻石晶簇','半圆拼盘','立体棋台','斜面山体','多面星核','旋叠方砖','梯形瀑布','扇形拼花','立柱矩阵','彩色嵌窗',
 '切片圆柱','双锥晶体','积木天际线','圆角拼图','三棱阶梯','几何花冠','嵌套六边体','方圆交响','立体沙漏','棋格山丘',
 '多面冰山','旋转方环','偏心圆饼','拱顶阶城','折面飞翼','平铺菱砖','立方拼屏','阶梯圆台','多边岛屿','柱锥组合',
 '拼色风车','浮雕窗墙','陀螺晶塔','错位半球','空心三角体','弧面积木','立体十字','棱面日轮','阶梯蜂房','几何巨石',
] as const;

/** Solid, bounded polygon assemblies. Every face inherits the shared camera and timeline. */
export function drawFlowGeometry(ctx:TemperaCompositionContext,opts:FlowMgOptions):void {
 const {width:w,height:h,pixi,palette:p}=ctx,u=Math.min(w,h);
 const group=ctx.createGroup(0,w/2,h/2);group.scale.set(opts.scale);
 const colors=[p.blockA,p.blockB,p.blockC,p.accent];
 const n=Math.max(4,Math.min(12,Math.round(8*opts.density)));
 const add=(draw:(g:import('pixi.js').Graphics)=>void,i:number)=>{
  const g=new pixi.Graphics();draw(g);g.fill({color:colors[((i%4)+4)%4],alpha:opts.opacity});
  ctx.add(g,{delay:(i%12)/20*opts.stagger,span:.5,enterDX:Math.cos(ctx.flowAngle)*u*.07,enterDY:Math.sin(ctx.flowAngle)*u*.07,drift:i%5===0,grow:i%4===0},group);
 };
 const face=(points:number[],i:number)=>add(g=>g.poly(points,true),i);
 const polygon=(x:number,y:number,r:number,sides:number,angle:number,i:number)=>face(Array.from({length:sides},(_,k)=>[x+Math.cos(angle+k/sides*Math.PI*2)*r,y+Math.sin(angle+k/sides*Math.PI*2)*r]).flat(),i);
 const cube=(x:number,y:number,s:number,i:number)=>{
  face([x,y-s,x+s,y-s*.5,x,y,x-s,y-s*.5],i);
  face([x-s,y-s*.5,x,y,x,y+s,x-s,y+s*.5],i+1);
  face([x,y,x+s,y-s*.5,x+s,y+s*.5,x,y+s],i+2);
 };
 const pyramid=(x:number,y:number,s:number,i:number)=>{
  face([x,y-s,x+s,y+s*.55,x,y+s*.2],i);
  face([x,y-s,x,y+s*.2,x-s,y+s*.55],i+1);
  face([x-s,y+s*.55,x,y+s*.2,x+s,y+s*.55,x,y+s*.9],i+2);
 };
 const arch=(x:number,y:number,s:number,i:number)=>{
  add(g=>g.arc(x,y,s,Math.PI,Math.PI*2).lineTo(x+s,y+s*.7).lineTo(x-s,y+s*.7).closePath(),i);
  add(g=>g.arc(x,y,s*.55,Math.PI,Math.PI*2).lineTo(x+s*.55,y+s*.7).lineTo(x-s*.55,y+s*.7).closePath(),i+1);
 };
 for(let i=0;i<n;i++){
  const t=i/(n-1),a=i/n*Math.PI*2,x=(t-.5)*w*.95,y=(t-.5)*h*.9,s=u*(.07+(i%3)*.018);
  const col=(i%4-1.5)*w*.23,row=(Math.floor(i/4)-.8)*h*.3;
  switch(opts.variant-FLOW_GEOMETRY_START){
   case 0:cube(x,Math.sin(a)*h*.18,s,i);break;
   case 1:polygon(col,row,s,6,Math.PI/6,i);polygon(col-s*.15,row-s*.15,s*.55,6,Math.PI/6,i+1);break;
   case 2:face([x,y-s,x+s*1.4,y+s,x-s*1.3,y+s],i);face([x,y-s,x+s*1.4,y+s,x,y+s*.35],i+1);break;
   case 3:face([col-s,row-s*1.8,col+s,row-s*1.8,col+s,row+s*1.8,col-s,row+s*1.8],i);face([col+s,row-s*1.8,col+s*1.5,row-s*2.2,col+s*1.5,row+s*1.4,col+s,row+s*1.8],i+1);break;
   case 4:add(g=>g.circle(col,row,s),i);add(g=>g.arc(col,row,s,-Math.PI/2,Math.PI/2).closePath(),i+1);break;
   case 5:pyramid(col,row,s*1.2,i);break;
   case 6:cube(Math.cos(a)*u*.36,Math.sin(a)*u*.3,s*.8,i);break;
   case 7:cube(x,(.4-t)*h*.55,s*.9,i);add(g=>g.rect(x-s,y*.3+s,s*2,s*.45),i+3);break;
   case 8:arch(x,h*.12+Math.sin(a)*h*.1,s*1.3,i);break;
   case 9:add(g=>g.roundRect(col-s*.6,row-s*1.35,s*1.2,s*2.7,s*.6),i);add(g=>g.circle(col,row-s*.65,s*.36),i+1);break;
   case 10:face([col,row-s*1.7,col+s,row,col,row+s*1.3,col-s,row],i);face([col,row-s*1.7,col,row+s*1.3,col-s,row],i+1);break;
   case 11:add(g=>g.arc(col,row,s*1.15,a,a+Math.PI).closePath(),i);add(g=>g.arc(col,row,s*.65,a+Math.PI,a+Math.PI*2).closePath(),i+1);break;
   case 12:cube(col,row,s,i);add(g=>g.rect(col-s*.45,row-s*.65,s*.9,s*.35),i+3);break;
   case 13:face([x,h*.4,x+s*1.8,-h*(.12+(i%3)*.1),x+s*3,h*.4],i);face([x+s*1.8,-h*(.12+(i%3)*.1),x+s*1.8,h*.4,x+s*3,h*.4],i+1);break;
   case 14:{const rr=u*(.1+t*.28);face([0,0,Math.cos(a-.15)*rr,Math.sin(a-.15)*rr,Math.cos(a)*rr*1.6,Math.sin(a)*rr*1.6,Math.cos(a+.15)*rr,Math.sin(a+.15)*rr],i);break;}
   case 15:{const q=a*.28;face([x-s*Math.cos(q),y-s*Math.sin(q),x+s*Math.sin(q),y-s*Math.cos(q),x+s*Math.cos(q),y+s*Math.sin(q),x-s*Math.sin(q),y+s*Math.cos(q)],i);break;}
   case 16:face([-w*.55,y,w*.35,y-s*.8,w*.55,y+s*.5,-w*.35,y+s*1.3],i);break;
   case 17:add(g=>g.moveTo(0,0).arc(0,0,u*.4,a,a+Math.PI*2/n*.8).closePath(),i);add(g=>g.circle(Math.cos(a)*u*.24,Math.sin(a)*u*.24,s*.3),i+1);break;
   case 18:cube(col,row,s*.7,i);add(g=>g.rect(col-s*.7,row-s*(1.2+(i%3)),s*1.4,s*(1+(i%3))),i+1);face([col-s*.7,row-s*(1.2+(i%3)),col,row-s*(1.55+(i%3)),col+s*.7,row-s*(1.2+(i%3)),col,row-s*(.85+(i%3))],i+2);break;
   case 19:add(g=>g.roundRect(col-s,row-s,s*2,s*2,s*.15),i);polygon(col,row,s*.65,4,Math.PI/4,i+1);break;
   case 20:add(g=>g.rect(x-s*.6,-h*.25,s*1.2,h*.5),i);add(g=>g.ellipse(x,-h*.25,s*.6,s*.25),i+1);add(g=>g.ellipse(x,h*.25,s*.6,s*.25),i+2);break;
   case 21:face([col,row-s*1.5,col+s,row,col,row+s*1.5,col-s,row],i);face([col,row-s*1.5,col+s,row,col-s,row],i+1);break;
   case 22:{const hh=s*(1+(i%4)*.65);cube(x,h*.25,s*.7,i);face([x-s*.7,h*.25,x-s*.7,h*.25-hh,x,h*.25-hh+s*.35,x,h*.25+s*.7],i+1);face([x,h*.25-hh+s*.35,x+s*.7,h*.25-hh,x+s*.7,h*.25,x,h*.25+s*.7],i+2);break;}
   case 23:add(g=>{g.roundRect(col-s,row-s,s*2,s*2,s*.3);g.circle(col+s,row,s*.35);},i);add(g=>g.circle(col,row+s,s*.28),i+1);break;
   case 24:face([x,h*.4,x+s,-h*.25+t*h*.35,x+s*2,h*.4],i);face([x+s,-h*.25+t*h*.35,x+s*1.5,-h*.32+t*h*.35,x+s*2.5,h*.35,x+s*2,h*.4],i+1);break;
   case 25:polygon(Math.cos(a)*u*.28,Math.sin(a)*u*.28,s,5,a,i);face([0,0,Math.cos(a-.12)*u*.24,Math.sin(a-.12)*u*.24,Math.cos(a+.12)*u*.24,Math.sin(a+.12)*u*.24],i+1);break;
   case 26:{const rr=u*(.47-t*.39);polygon(0,0,rr,6,Math.PI/6,i);if(i===n-1)cube(0,0,u*.06,i+1);break;}
   case 27:add(g=>g.rect(col-s,row-s,s*2,s*2),i);add(g=>g.circle(col+s*.25,row-s*.15,s*.7),i+1);break;
   case 28:pyramid(col,row-s*.15,s*.8,i);face([col,row+s*1.5,col-s*.8,row-s*.15,col+s*.8,row-s*.15],i+2);break;
   case 29:{const xx=(i%4-1.5)*w*.22,yy=(Math.floor(i/4)-.5)*h*.25;cube(xx,yy-Math.abs(Math.sin(i))*s*.7,s*.9,i);break;}
   case 30:face([col-s,row+s,col-s*.2,row-s*1.7,col+s*.8,row-s*.2,col+s*1.3,row+s],i);face([col-s*.2,row-s*1.7,col+s*.1,row+s,col+s*1.3,row+s,col+s*.8,row-s*.2],i+1);break;
   case 31:{const rr=u*(.12+t*.35),th=u*.035;face([-rr,-rr,rr,-rr,rr,-rr+th,-rr,-rr+th],i);face([rr-th,-rr,rr,-rr,rr,rr,rr-th,rr],i+1);face([-rr,rr-th,rr,rr-th,rr,rr,-rr,rr],i+2);face([-rr,-rr,-rr+th,-rr,-rr+th,rr,-rr,rr],i+3);break;}
   case 32:add(g=>g.circle(x,Math.sin(a)*h*.14,s*1.15),i);add(g=>g.arc(x+s*.3,Math.sin(a)*h*.14,s*.7,a,a+Math.PI).closePath(),i+1);break;
   case 33:arch(col,row,s,i);add(g=>g.rect(col-s,row+s*.75,s*2,s*.25),i+2);break;
   case 34:face([0,y,x-s,y-s*1.6,x+s,y-s*.9,x*1.3,y+s*.7],i);face([0,y,x*1.3,y+s*.7,x+s,y-s*.9],i+1);break;
   case 35:face([col,row-s*.65,col+s*1.3,row,col,row+s*.65,col-s*1.3,row],i);face([col,row,col+s*1.3,row,col,row+s*.65],i+1);break;
   case 36:cube(col,row,s*1.2,i);add(g=>g.rect(col-s*.15,row-s*.8,s*.3,s*1.3),i+3);break;
   case 37:{const yy=(t-.5)*h*.7,rr=u*(.42-t*.23);add(g=>g.rect(-rr,yy,rr*2,u*.035),i);add(g=>g.ellipse(0,yy,rr,u*.075),i+1);break;}
   case 38:polygon(Math.sin(i*2.1)*w*.32,Math.cos(i*1.3)*h*.3,s*(1+t*.5),5+(i%3),a,i);break;
   case 39:add(g=>g.rect(col-s*.55,row-s*.7,s*1.1,s*1.8),i);add(g=>g.ellipse(col,row-s*.7,s*.55,s*.2),i+1);face([col-s*.65,row-s*.7,col,row-s*1.8,col+s*.65,row-s*.7],i+2);break;
   case 40:face([0,0,Math.cos(a)*u*.45,Math.sin(a)*u*.45,Math.cos(a+.35)*u*.45,Math.sin(a+.35)*u*.45,Math.cos(a+.2)*u*.15,Math.sin(a+.2)*u*.15],i);break;
   case 41:add(g=>g.rect(col-s,row-s,s*2,s*2),i);add(g=>g.rect(col-s*.62,row-s*.62,s*1.24,s*1.24),i+1);face([col-s,row-s,col-s*.62,row-s*.62,col+s*.62,row-s*.62,col+s,row-s],i+2);break;
   case 42:{const rr=u*(.08+(1-Math.abs(2*t-1))*.3);face([-rr,y,0,y-s*.5,rr,y,0,y+s*.5],i);face([-rr,y,0,y+s*.5,0,y+s, -rr,y+s*.5],i+1);face([0,y+s*.5,rr,y,rr,y+s*.5,0,y+s],i+2);break;}
   case 43:add(g=>g.arc(x,y*.5,s*1.1,0,Math.PI).closePath(),i);add(g=>g.arc(x+s*.45,y*.5-s*.3,s*.75,Math.PI,Math.PI*2).closePath(),i+1);break;
   case 44:{const rr=u*(.14+t*.34),th=u*.03;face([0,-rr,th,-rr+th,rr*.87,rr*.5,rr*.87-th,rr*.5+th],i);face([rr*.87,rr*.5,-rr*.87,rr*.5,-rr*.87+th,rr*.5-th,rr*.87-th,rr*.5-th],i+1);face([-rr*.87,rr*.5,0,-rr,th,-rr+th,-rr*.87+th,rr*.5],i+2);break;}
   case 45:add(g=>g.arc(col,row,s*1.3,Math.PI,Math.PI*2).lineTo(col+s*1.3,row+s*.4).lineTo(col-s*1.3,row+s*.4).closePath(),i);add(g=>g.ellipse(col,row+s*.4,s*1.3,s*.3),i+1);break;
   case 46:add(g=>{g.rect(col-s*.35,row-s*1.1,s*.7,s*2.2);g.rect(col-s*1.1,row-s*.35,s*2.2,s*.7);},i);face([col+s*.35,row-s*1.1,col+s*.65,row-s*1.35,col+s*.65,row-s*.6,col+s*.35,row-s*.35],i+1);break;
   case 47:face([Math.cos(a)*u*.15,Math.sin(a)*u*.15,Math.cos(a-.12)*u*.45,Math.sin(a-.12)*u*.45,Math.cos(a+.16)*u*.5,Math.sin(a+.16)*u*.5],i);polygon(0,0,u*.11,8,0,i+1);break;
   case 48:{const rr=u*(.08+t*.38);polygon(0,0,rr,6,Math.PI/6,i);face([-rr*.86,rr*.5,-rr*.86,rr*.7,0,rr*1.2,rr*.86,rr*.7,rr*.86,rr*.5,0,rr],i+1);break;}
   case 49:face([x-s,y+s,x-s*.75,y-s*1.5,x+s*.25,y-s*1.8,x+s,y-s*.8,x+s*.8,y+s],i);face([x+s*.25,y-s*1.8,x+s,y-s*.8,x+s*.8,y+s,x+s*.3,y+s*.4],i+1);break;
  }
 }
}
