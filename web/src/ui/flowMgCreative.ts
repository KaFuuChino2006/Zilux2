import type { TemperaCompositionContext } from './lumiere-folia/components/visualizer/tempera/temperaCompositionContext';
import type { FlowMgOptions } from './flowMg';

/** Append-only variants: existing saved composition IDs retain their meaning. */
export const FLOW_CREATIVE_START=72;
export const FLOW_CREATIVE_NAMES=[
 '光栅折扇','星盘经纬','莫比乌斯带','玻璃棱柱','邮票拼贴','月相序列','波形唱针','折线山海',
 '螺旋阶井','编织信封','百叶星门','透视棋廊','回形迷宫','极坐标花','晶体雪片','断层纸页',
 '斜切胶片','日冕刻度','漂浮书签','磁带双轴','点线城市','平行宇宙','沙漏流沙','鱼骨光谱',
 '环带行星','扇叶快门','星轨雨幕','电波花窗','云朵等压线','折角风筝','三棱隧道','缝线拼布',
 '虚线航图','波纹方舟','像素日落','光束竖琴','碎片罗盘','纸片陀螺','经纬网球','机械虹膜',
] as const;

/** Forty distinct vector constructions; timing, zoom and camera rotation remain shared. */
export function drawFlowCreative(ctx:TemperaCompositionContext,opts:FlowMgOptions):void {
 const {width:w,height:h,pixi,palette:p}=ctx,u=Math.min(w,h);
 const group=ctx.createGroup(0,w/2,h/2);group.scale.set(opts.scale);
 const colors=[p.blockA,p.blockB,p.blockC,p.accent];
 const n=Math.max(6,Math.min(18,Math.round(12*opts.density)));
 const add=(draw:(g:import('pixi.js').Graphics)=>void,i:number,filled=false)=>{
  const g=new pixi.Graphics();draw(g);
  if(filled)g.fill({color:colors[i%4],alpha:opts.opacity});
  else g.stroke({color:colors[i%4],width:Math.max(1.4,u*.0035),alpha:opts.opacity});
  ctx.add(g,{delay:(i%12)/18*opts.stagger,span:.5,enterDX:Math.cos(ctx.flowAngle)*u*.08,enterDY:Math.sin(ctx.flowAngle)*u*.08,drift:i%4===0,grow:i%3===0},group);
 };
 const polygon=(g:import('pixi.js').Graphics,points:number[])=>g.poly(points,true);
 for(let i=0;i<n;i++){
  const t=i/(n-1),a=i/n*Math.PI*2,r=u*(.1+t*.42),x=(t-.5)*w, y=(t-.5)*h;
  switch(opts.variant-FLOW_CREATIVE_START){
   case 0:add(g=>polygon(g,[-w*.35,h*.34,Math.cos(a*.45-2.1)*u*.8,Math.sin(a*.45-2.1)*u*.8,Math.cos(a*.45-2)*u*.8,Math.sin(a*.45-2)*u*.8]),i,true);break;
   case 1:add(g=>{g.ellipse(0,0,r,r*.32);g.moveTo(-r,0);g.lineTo(r,0);if(i%3===0){g.moveTo(0,-r);g.lineTo(0,r);}},i);break;
   case 2:add(g=>{const yy=(t-.5)*u*.2;g.moveTo(-w*.48,yy);g.bezierCurveTo(-w*.18,-h*.55,w*.18,h*.55,w*.48,-yy);g.bezierCurveTo(w*.18,-h*.55,-w*.18,h*.55,-w*.48,yy);},i);break;
   case 3:add(g=>polygon(g,[x,-h*.42,x+w*.1,-h*.32,x+w*.17,h*.38,x+w*.05,h*.48]),i,i%2===0);break;
   case 4:{const xx=(i%4-1.5)*w*.24,yy=(Math.floor(i/4)-1)*h*.29;add(g=>{g.rect(xx-u*.08,yy-u*.09,u*.16,u*.18);for(let k=0;k<5;k++)g.circle(xx-u*.08+k*u*.04,yy-u*.09,u*.006);},i);add(g=>g.circle(xx,yy,u*.038),i+1,true);break;}
   case 5:{const xx=(t-.5)*w*.95,rr=u*.09;add(g=>g.arc(xx,Math.sin(a)*h*.12,rr,-Math.PI/2,Math.PI/2),i,true);add(g=>g.ellipse(xx,Math.sin(a)*h*.12,rr*(.08+Math.abs(2*t-1)*.85),rr),i+1);break;}
   case 6:add(g=>{g.moveTo(-w*.5,y*.7);for(let k=0;k<40;k++)g.lineTo((k/39-.5)*w, y*.7+Math.sin(k*.4+i*.7)*u*.04);g.lineTo(w*.42,h*.35);g.circle(w*.42,h*.35,u*.014);},i);break;
   case 7:add(g=>polygon(g,[-w*.6,y+w*.04,-w*.3,y-u*.1,0,y+u*.08,w*.28,y-u*.18,w*.6,y-u*.02,w*.6,y+u*.025,0,y+u*.125,-w*.6,y+w*.085]),i,true);break;
   case 8:{const q=i*.24,xx=Math.cos(q)*r*.4,yy=Math.sin(q)*r*.4;add(g=>g.rect(xx-r*.55,yy-r*.4,r*1.1,r*.8),i);break;}
   case 9:add(g=>{g.moveTo(-w*.5,y);g.lineTo(0,y*.2);g.lineTo(w*.5,-y);g.moveTo(x,-h*.48);g.lineTo(x*.2,0);g.lineTo(-x,h*.48);},i);break;
   case 10:add(g=>{const q=a*.5;polygon(g,[Math.cos(q)*r,-r*.7,Math.cos(q)*r+u*.035,-r*.7,Math.cos(q)*r+u*.035,r*.7,Math.cos(q)*r,r*.7]);},i,true);break;
   case 11:add(g=>{const z=.12+t*.88;g.moveTo(-w*.52*z,-h*.52*z);g.lineTo(w*.52*z,-h*.52*z);g.lineTo(w*.52*z,h*.52*z);g.lineTo(-w*.52*z,h*.52*z);g.closePath();if(i%2===0){g.moveTo(-w*.52,-h*.52);g.lineTo(0,0);g.lineTo(w*.52,h*.52);}},i);break;
   case 12:add(g=>{const rr=u*(.08+t*.42);g.moveTo(-rr*.8,-rr);g.lineTo(rr,-rr);g.lineTo(rr,rr);g.lineTo(-rr,rr);g.lineTo(-rr,-rr*.5);g.lineTo(rr*.45,-rr*.5);},i);break;
   case 13:add(g=>{for(let k=0;k<=64;k++){const q=k/64*Math.PI*2,rr=r*(.7+.25*Math.cos(5*q));const xx=Math.cos(q)*rr,yy=Math.sin(q)*rr;k?g.lineTo(xx,yy):g.moveTo(xx,yy);}g.closePath();},i);break;
   case 14:add(g=>{const xx=Math.cos(a)*u*.12,yy=Math.sin(a)*u*.12;g.moveTo(xx,yy);g.lineTo(Math.cos(a)*u*.49,Math.sin(a)*u*.49);for(const d of [.25,.35]){const bx=Math.cos(a)*u*d,by=Math.sin(a)*u*d;g.moveTo(bx+Math.cos(a+.7)*u*.08,by+Math.sin(a+.7)*u*.08);g.lineTo(bx,by);g.lineTo(bx+Math.cos(a-.7)*u*.08,by+Math.sin(a-.7)*u*.08);}},i);break;
   case 15:add(g=>polygon(g,[-w*.55,y,w*.55,y+Math.sin(i*1.2)*u*.12,w*.55,y+u*.065,-w*.55,y+u*.12]),i,true);break;
   case 16:add(g=>{const xx=x*.9,yy=x*.22;polygon(g,[xx-u*.07,yy-h*.4,xx+u*.07,yy-h*.35,xx+u*.07,yy+h*.4,xx-u*.07,yy+h*.35]);for(let k=0;k<5;k++)g.rect(xx-u*.045,yy+(k-2)*h*.13,u*.09,h*.07);},i);break;
   case 17:add(g=>{const inner=u*(i%3===0?.28:.34),outer=u*.48;g.moveTo(Math.cos(a)*inner,Math.sin(a)*inner);g.lineTo(Math.cos(a)*outer,Math.sin(a)*outer);g.arc(0,0,u*.24,a,a+.18);},i);break;
   case 18:add(g=>{const xx=Math.sin(i*2.1)*w*.37,yy=Math.cos(i*1.4)*h*.3;polygon(g,[xx-u*.035,yy-u*.16,xx+u*.035,yy-u*.16,xx+u*.035,yy+u*.16,xx,yy+u*.12,xx-u*.035,yy+u*.16]);},i,true);break;
   case 19:{const side=i%2?1:-1,rr=u*(.06+Math.floor(i/2)/n*.5);add(g=>g.circle(side*w*.24,0,rr),i);if(i<2)add(g=>{g.moveTo(-w*.24,-u*.16);g.lineTo(w*.24,-u*.16);g.moveTo(-w*.24,u*.16);g.lineTo(w*.24,u*.16);},i);break;}
   case 20:add(g=>{const xx=x*.9,hh=u*(.1+Math.abs(Math.sin(i*1.9))*.42);g.rect(xx,h*.4-hh,w/n*.65,hh);g.circle(xx+w/n*.32,h*.4-hh-u*.045,u*.012);g.moveTo(xx+w/n*.32,h*.4-hh);g.lineTo(xx+w/n*.32,h*.4-hh-u*.03);},i);break;
   case 21:add(g=>{g.ellipse(-w*.23,0,r*.55,r*.32);g.ellipse(w*.23,0,r*.55,r*.32);if(i%3===0){g.moveTo(-w*.23,-r*.32);g.bezierCurveTo(-w*.08,-h*.5,w*.08,h*.5,w*.23,r*.32);}},i);break;
   case 22:add(g=>{const yy=y*.9,half=u*(.06+Math.abs(2*t-1)*.34);g.moveTo(-half,yy);g.lineTo(half,yy);if(i%2===0)g.circle(Math.sin(i*2.4)*half*.6,yy,u*.009);},i);break;
   case 23:add(g=>{const yy=y*.95,span=u*(.12+Math.abs(Math.sin(i*.8))*.35);g.moveTo(-span,yy-u*.04);g.lineTo(0,yy);g.lineTo(span,yy-u*.04);if(i===0){g.moveTo(0,-h*.5);g.lineTo(0,h*.5);}},i);break;
   case 24:add(g=>{g.ellipse(0,0,r,r*.26);if(i%3===0)g.circle(Math.cos(a)*r,Math.sin(a)*r*.26,u*.026);},i);break;
   case 25:add(g=>polygon(g,[Math.cos(a)*u*.12,Math.sin(a)*u*.12,Math.cos(a+.12)*u*.58,Math.sin(a+.12)*u*.58,Math.cos(a+.5)*u*.42,Math.sin(a+.5)*u*.42,Math.cos(a+.32)*u*.16,Math.sin(a+.32)*u*.16]),i,true);break;
   case 26:add(g=>{const xx=x*.95,yy=Math.sin(i)*h*.2;g.arc(xx,yy,u*.15,a,a+.9);g.moveTo(xx,yy+u*.14);g.lineTo(xx-u*.045,yy+u*.34);},i);break;
   case 27:add(g=>{const rr=r*.85;g.arc(0,0,rr,a,a+Math.PI*.75);polygon(g,[Math.cos(a)*rr,Math.sin(a)*rr,Math.cos(a+.3)*rr*.5,Math.sin(a+.3)*rr*.5,Math.cos(a+.6)*rr,Math.sin(a+.6)*rr]);},i);break;
   case 28:add(g=>{for(let k=0;k<=64;k++){const q=k/64*Math.PI*2,rr=r*(.8+.08*Math.sin(3*q)+.12*Math.cos(5*q));const xx=Math.cos(q)*rr*1.5,yy=Math.sin(q)*rr*.7;k?g.lineTo(xx,yy):g.moveTo(xx,yy);}g.closePath();},i);break;
   case 29:add(g=>{const xx=Math.cos(a)*u*.28,yy=Math.sin(a)*u*.26;polygon(g,[xx,yy-u*.12,xx+u*.075,yy,xx,yy+u*.18,xx-u*.075,yy]);g.moveTo(xx,yy-u*.12);g.lineTo(xx,yy+u*.18);},i,i%2===0);break;
   case 30:add(g=>{const rr=u*(.08+t*.5);polygon(g,[0,-rr,rr*.87,rr*.5,-rr*.87,rr*.5]);},i);break;
   case 31:{const col=i%4,row=Math.floor(i/4),xx=(col-1.5)*w*.25,yy=(row-1)*h*.3;add(g=>g.rect(xx-u*.08,yy-u*.08,u*.16,u*.16),i,i%2===0);add(g=>{for(let k=0;k<4;k++){g.moveTo(xx-u*.07+k*u*.045,yy-u*.1);g.lineTo(xx-u*.05+k*u*.045,yy-u*.08);}},i+1);break;}
   case 32:add(g=>{const xx=x*.9,yy=Math.sin(a)*h*.24;g.circle(xx,yy,u*.015);for(let k=0;k<6;k++){const px=xx+k*w/n/6,py=yy+(Math.cos(a)*u*.1)*k/6;g.moveTo(px,py);g.lineTo(px+w/n/12,py+Math.cos(a)*u*.1/12);}},i);break;
   case 33:add(g=>{const yy=y*.7;g.moveTo(-w*.48,yy);g.quadraticCurveTo(0,yy+h*.45,w*.48,yy);g.moveTo(-w*.48,yy);g.lineTo(w*.48,yy);},i);break;
   case 34:add(g=>{const yy=(t-.5)*u*.82,grid=u*.025;const half=yy<0?Math.sqrt(Math.max(0,1-(yy/(u*.42))**2))*u*.4:u*(.34-(t-.5)*.35);const edge=Math.round(half/grid)*grid;g.rect(-edge,yy,Math.max(grid,edge*2),u*.023);},i,true);break;
   case 35:add(g=>{const xx=x*.9;g.moveTo(-w*.42,-h*.4);g.lineTo(xx,h*.4);g.moveTo(xx,h*.4);g.lineTo(w*.42,-h*.4);},i);break;
   case 36:add(g=>{const inner=u*(.08+(i%3)*.04),outer=u*(i%2?.35:.52);polygon(g,[Math.cos(a-.045)*inner,Math.sin(a-.045)*inner,Math.cos(a)*outer,Math.sin(a)*outer,Math.cos(a+.08)*inner,Math.sin(a+.08)*inner]);},i,true);break;
   case 37:add(g=>{const xx=Math.cos(a)*r*.3,yy=Math.sin(a)*r*.3;polygon(g,[xx-r*.55,yy-r*.2,xx+r*.1,yy-r*.36,xx+r*.55,yy+r*.2,xx-r*.1,yy+r*.36]);},i,i%3===0);break;
   case 38:add(g=>{g.ellipse(0,0,r*.6,u*.45);g.ellipse(0,0,u*.45,r*.25);},i);break;
   case 39:add(g=>{const q=a+.18,inner=u*.14,outer=u*.51;polygon(g,[Math.cos(a)*inner,Math.sin(a)*inner,Math.cos(q)*outer,Math.sin(q)*outer,Math.cos(q+.35)*outer,Math.sin(q+.35)*outer,Math.cos(a+.4)*inner,Math.sin(a+.4)*inner]);},i,i%2===0);break;
  }
 }
}
