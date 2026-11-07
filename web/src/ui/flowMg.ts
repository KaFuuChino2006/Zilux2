import type { TemperaCompositionContext } from './lumiere-folia/components/visualizer/tempera/temperaCompositionContext';
import { TEMPERA_SHOT_KINDS } from './lumiere-folia/components/visualizer/tempera/types';
import { FLOW_CREATIVE_NAMES, FLOW_CREATIVE_START, drawFlowCreative } from './flowMgCreative';
import { FLOW_GEOMETRY_NAMES, FLOW_GEOMETRY_START, drawFlowGeometry } from './flowMgGeometry';
export const FLOW_MG_FAMILIES=['orbit','paper','wave','grid','prism','type','signal','organic'] as const;
export const FLOW_MG_NAMES=[
 '偏心轨道','星环切片','日蚀圆盘','行星刻度','折页海报','撕纸阶梯','悬浮便签','风琴书页','等高波纹','交织丝带','潮汐扇贝','声波峡谷','棋盘透视','窗格拼贴','像素阶梯','点阵星图','棱镜扇面','钻石隧道','折光山脊','万花碎片','字母积木','标点游乐场','书脊排版','巨型括号','雷达扫描','电路节点','条码频谱','瞄准仪表','花瓣旋涡','叶脉剪影','液滴拼贴','珊瑚枝条',
 '双极脉冲','环形回声','切片星云','编年史轴','透镜矩阵','飘带隧道','环形频谱','菱形涟漪','轨道花冠','信号山',
 '纸张隧道','排版风暴','声纹棱镜','时间刻度','霓虹门','分形回廊','数据瀑布','几何潮汐','声音粒子','城市剖面',
 '光盘轨道','玻璃书页','同心阶梯','漂移坐标','光谱折叠','机械花瓣','磁力曲线','像素风暴','窗口漂移','模块星座',
 '字体波纹','弧光列阵','织网脉冲','云层切片','透镜波纹','极光栅栏','印章阵列','黑洞光环','回授波纹','空间折线',
 ...FLOW_CREATIVE_NAMES,
 ...FLOW_GEOMETRY_NAMES,
];
export const FLOW_ORIGINAL_NAMES=[
 '双分屏','四分屏','三栏','三段堆叠','棋盘四格','角楔','对角双分','交叉轴','错位双栏','阶梯块面','立柱留隙','角部四格','细条堆叠',
 '横带','地平线','纵深俯冲','色调渐变','双横带','倾斜横带','边缘轨道','渐变墙','梯田',
 '画框窗','双画框','圆窗','梯框','四角括号','内嵌框','成对括号','拱窗','网格单元','锁孔',
 '海报面板','钻石堆叠','斜切海报','箭头楔','边缘出血','三角体块','交叉丝带','半圆盘','堆叠板面','成对楔形',
 '静默线','星点场','涟漪线','细网格','边距线','漂移圆点','弧形扫掠','空白页',
 '宽银幕','超宽画幅','学院画幅','方形画幅','竖幅画幅','高竖画幅','双画幅',
 '气泡漂移','云朵窗','心跳爆裂','星芒场','花瓣弧','贝壳横带','丝带环','圆盘','光环爆发',
 '虹膜孔','轨道槽','打孔行','胶片门','交叉通风','百叶板','环眼','缺口堆叠','楔形留隙','圆点筛',
 '瞄准标记','表盘刻度','连续箭头','计数柱','网格聚焦','轴线端点','频闪板','错位板','放射梳','靶向括号',
 '流线通道','双线通道','簧片列','收束通道','链式端口','虚线通道','窗列','桥跨','编织通道','端口梯',
 '峰顶体块','金字阶梯','板墙','悬挑','双子塔','地堡狭缝','基座堆叠','扶壁列','虚空核心','剪切块面',
 '山脊线','裂隙','悬岩','阶井','桥墩列','护岸','塔楼裁切','门楣','碎石扇','日晷',
 '物语卡','物语线','物语边缘','物语堆叠','物语闪场',
] as const;
/** IDs 0–31 are the first MG batch and remain frozen for saved-setting compatibility. */
export const FLOW_LEGACY_MG_COUNT=32;
export const FLOW_ORIGINAL_START=FLOW_LEGACY_MG_COUNT;
export const FLOW_ORIGINAL_STYLES=FLOW_ORIGINAL_NAMES.map((name,index)=>({
 id:FLOW_ORIGINAL_START+index,
 kind:TEMPERA_SHOT_KINDS[index],
 name,
}));
export const FLOW_ORIGINAL_END=FLOW_ORIGINAL_START+FLOW_ORIGINAL_STYLES.length;
export const FLOW_MG_STYLES=FLOW_MG_NAMES.map((name,variant)=>({
 id:variant<FLOW_LEGACY_MG_COUNT?variant:FLOW_ORIGINAL_END+variant-FLOW_LEGACY_MG_COUNT,
 variant,
 name,
}));
export const FLOW_COMPOSITION_COUNT=FLOW_ORIGINAL_END+Math.max(0,FLOW_MG_STYLES.length-FLOW_LEGACY_MG_COUNT);
export function flowMgVariantForId(id:number):number|undefined{
 if(id>=0&&id<FLOW_LEGACY_MG_COUNT)return id;
 if(id>=FLOW_ORIGINAL_END&&id<FLOW_COMPOSITION_COUNT)return FLOW_LEGACY_MG_COUNT+id-FLOW_ORIGINAL_END;
 return undefined;
}
function buildRotationOrder(){
 const originals=FLOW_ORIGINAL_STYLES.map(style=>style.id);
 const additions=FLOW_MG_STYLES.map(style=>style.id);
 const result:number[]=[];
 let originalIndex=0,additionIndex=0;
 while(originalIndex<originals.length||additionIndex<additions.length){
  const takeOriginal=(originalIndex+1)*additions.length<=(additionIndex+1)*originals.length;
  if(originalIndex<originals.length&&(takeOriginal||additionIndex>=additions.length))result.push(originals[originalIndex++]);
  else result.push(additions[additionIndex++]);
 }
 return result;
}
/** Interleaves original and added compositions so neither family runs as one long block. */
export const FLOW_COMPOSITION_ORDER=buildRotationOrder();
export interface FlowMgOptions { variant:number; density:number; scale:number; opacity:number; stagger:number }
/** Original Zilux compositions: bounded vector nodes, animated by Tempera's absolute-time block driver. */
export function drawFlowMg(ctx:TemperaCompositionContext, opts:FlowMgOptions) {
 if(opts.variant>=FLOW_GEOMETRY_START){drawFlowGeometry(ctx,opts);return;}
 if(opts.variant>=FLOW_CREATIVE_START){drawFlowCreative(ctx,opts);return;}
 const {width:w,height:h,palette:p,pixi}=ctx, u=Math.min(w,h), v=opts.variant;
 const colors=[p.blockA,p.blockB,p.blockC,p.accent], n=Math.max(4,Math.round(10*opts.density));
 const group=ctx.createGroup(0,w/2,h/2);group.scale.set(opts.scale);
 function add(draw:(g:import('pixi.js').Graphics)=>void,i:number,fill=true){const g=new pixi.Graphics();draw(g);if(fill)g.fill({color:colors[i%4],alpha:opts.opacity});else g.stroke({color:colors[i%4],width:Math.max(1.5,u*.004),alpha:opts.opacity});ctx.add(g,{delay:(i%12)/16*opts.stagger,span:.5,enterDX:Math.cos(ctx.flowAngle+i*.4)*u*.18,enterDY:Math.sin(ctx.flowAngle+i*.4)*u*.18,drift:true,grow:i%3===0},group);}
 const poly=(g:import('pixi.js').Graphics,points:number[])=>g.poly(points,true);
 for(let i=0;i<n;i++){
 const t=i/n,a=t*Math.PI*2,x=(t-.5)*w,r=u*(.16+t*.48);
 switch(v){
 case 0:add(g=>g.ellipse(w*.22,h*.05,r,r*.53),i,false);break;
 case 1:add(g=>g.arc(w*.1,0,r,a,a+Math.PI*1.15),i,false);break;
 case 2:if(i<5)add(g=>g.circle(w*.24-i*u*.035,0,u*(.44-i*.055)),i);break;
 case 3:add(g=>g.roundRect(Math.cos(a)*u*.4,Math.sin(a)*u*.4,u*.13,u*.025,4),i);break;
 case 4:add(g=>poly(g,[x,-h*.65,x+w*.14,-h*.45,x+w*.04,h*.65,x-w*.12,h*.4]),i);break;
 case 5:add(g=>poly(g,[-w*.6,h*(t-.5),w*.6,h*(t-.4),w*.4,h*(t-.36),-w*.6,h*(t-.43)]),i);break;
 case 6:add(g=>g.roundRect(Math.sin(i*2.4)*w*.36,Math.cos(i*1.8)*h*.32,w*.16,h*.2,4),i);break;
 case 7:add(g=>poly(g,[x,-h*.6,x+w/n,h*(i%2?-.3:-.5),x+w/n,h*.6,x,h*.4]),i);break;
 case 8:add(g=>{for(let j=0;j<=60;j++){const px=(j/60-.5)*w*1.3,py=(t-.5)*h+Math.sin(j*.13+i*.3)*h*.09;j?g.lineTo(px,py):g.moveTo(px,py);}},i,false);break;
 case 9:add(g=>{g.moveTo(-w*.6,(t-.5)*h);g.bezierCurveTo(-w*.1,h*.6,w*.1,-h*.6,w*.6,(t-.5)*h);},i,false);break;
 case 10:add(g=>g.arc(x,h*.25,u*.24,Math.PI,Math.PI*2),i,false);break;
 case 11:add(g=>poly(g,[x,-h*.6,x+w*.055,-h*.6,x+w*.055,-h*.1-Math.sin(i)*h*.22,x,-h*.12-Math.sin(i)*h*.22]),i);add(g=>g.rect(x,h*.2+Math.cos(i)*h*.1,w*.055,h*.5),i+1);break;
 case 12:for(let j=0;j<5;j++)if((i+j)%2===0)add(g=>poly(g,[x*(1+j*.15),j*h*.11-h*.2,(x+w/n)*(1+j*.15),j*h*.11-h*.2,(x+w/n)*(1+(j+1)*.15),(j+1)*h*.11-h*.2,x*(1+(j+1)*.15),(j+1)*h*.11-h*.2]),i+j);break;
 case 13:add(g=>g.roundRect((i%4-2)*w*.24,(Math.floor(i/4)-1)*h*.33,w*.2,h*.27,8),i,false);break;
 case 14:add(g=>g.rect(x,h*.2-Math.floor(i/2)*h*.075,w/n,h*.6),i);break;
 case 15:for(let j=0;j<5;j++)add(g=>g.circle(x,(j-2)*h*.19,u*(.006+((i*j)%4)*.005)),i+j);break;
 case 16:add(g=>poly(g,[w*.28,h*.2,Math.cos(a)*w,Math.sin(a)*h,Math.cos(a+.16)*w,Math.sin(a+.16)*h]),i);break;
 case 17:add(g=>poly(g,[-r,0,0,-r*.65,r,0,0,r*.65]),i,false);break;
 case 18:add(g=>poly(g,[x,h*.55,x+w*.14,-h*(.12+(i%3)*.1),x+w*.28,h*.55]),i);break;
 case 19:add(g=>poly(g,[Math.cos(a)*u*.12,Math.sin(a)*u*.12,Math.cos(a+.1)*u*.58,Math.sin(a+.1)*u*.58,Math.cos(a+.38)*u*.4,Math.sin(a+.38)*u*.4]),i);break;
 case 20:add(g=>{g.rect(x,-h*.32,w*.065,h*.64);g.rect(x,-h*.32,w*.14,h*.065);g.rect(x,0,w*.11,h*.04);},i);break;
 case 21:add(g=>{g.circle(x,Math.sin(i)*h*.25,u*.04);g.roundRect(x-u*.012,Math.sin(i)*h*.25-u*.2,u*.024,u*.13,4);},i);break;
 case 22:add(g=>g.roundRect(x,Math.sin(i)*h*.06-h*.4,w*.065,h*.8,3),i);break;
 case 23:if(i<4)add(g=>{const xx=(i%2?1:-1)*w*(.3+Math.floor(i/2)*.13);g.moveTo(xx,-h*.4);g.lineTo(xx+(i%2?-1:1)*w*.06,-h*.4);g.lineTo(xx+(i%2?-1:1)*w*.06,h*.4);g.lineTo(xx,h*.4);},i,false);break;
 case 24:add(g=>g.circle(-w*.25,0,r),i,false);if(i<4)add(g=>{g.moveTo(-w*.25,0);g.lineTo(Math.cos(a)*w,Math.sin(a)*h);},i,false);break;
 case 25:add(g=>{const yy=Math.sin(i*2)*h*.35;g.moveTo(-w*.6,yy);g.lineTo(x,yy);g.lineTo(x+u*.1,yy-u*.1);g.lineTo(w*.6,yy-u*.1);g.circle(x,yy,u*.015);},i,false);break;
 case 26:add(g=>g.rect(x,-h*(.15+Math.abs(Math.sin(i*1.8))*.3),w*(i%3===0?.04:.012),h*(.3+Math.abs(Math.sin(i*1.8))*.6)),i);break;
 case 27:add(g=>{const xx=Math.cos(a)*u*.4,yy=Math.sin(a)*u*.4;g.moveTo(xx-u*.03,yy);g.lineTo(xx+u*.03,yy);g.moveTo(xx,yy-u*.03);g.lineTo(xx,yy+u*.03);},i,false);break;
 case 28:add(g=>g.ellipse(Math.cos(a)*u*.27,Math.sin(a)*u*.27,u*.19,u*.065),i);break;
 case 29:add(g=>{g.moveTo(-w*.4,h*.4);g.quadraticCurveTo(x,-h*.4,w*.4,-h*.2);g.quadraticCurveTo(x,h*.4,-w*.4,h*.4);},i,false);break;
 case 30:add(g=>{const xx=Math.sin(i*2.3)*w*.4,yy=Math.cos(i*1.7)*h*.35;g.moveTo(xx,yy-u*.12);g.bezierCurveTo(xx+u*.2,yy+u*.16,xx-u*.2,yy+u*.16,xx,yy-u*.12);},i);break;
 case 31:add(g=>{const xx=x*.8;g.moveTo(xx,h*.5);g.lineTo(xx,-h*.15);g.lineTo(xx-u*.12,-h*.3);g.moveTo(xx,h*.1);g.lineTo(xx+u*.1,-h*.1);},i,false);break;
 case 32:add(g=>{const yy=Math.sin(a)*h*.3;g.ellipse(-w*.18,yy,u*.18,u*.055);g.ellipse(w*.18,-yy,u*.18,u*.055);},i,false);break;
 case 33:add(g=>{const rr=u*(.18+(i%6)*.075);g.arc(0,0,rr,a,a+Math.PI*(.7+(i%3)*.18));},i,false);break;
 case 34:add(g=>poly(g,[Math.cos(a)*u*.08,Math.sin(a)*u*.08,Math.cos(a-.16)*r,Math.sin(a-.16)*r,Math.cos(a+.12)*r*.82,Math.sin(a+.12)*r*.82]),i);break;
 case 35:add(g=>{const xx=(t-.5)*w*1.1;g.moveTo(xx,-h*.48);g.lineTo(xx,h*.48);g.circle(xx,h*(t-.5)*.8,u*(.018+(i%3)*.01));},i,false);break;
 case 36:add(g=>g.ellipse(Math.cos(a)*u*.34,Math.sin(a)*u*.34,u*.14,u*.042),i);break;
 case 37:add(g=>{g.moveTo(-w*.55,(t-.5)*h);g.bezierCurveTo(-w*.15,-h*.55,w*.15,h*.55,w*.55,(.5-t)*h);},i,false);break;
 case 38:add(g=>g.roundRect(Math.cos(a)*u*.38-u*.025,Math.sin(a)*u*.38-u*(.04+Math.abs(Math.sin(i))* .11),u*.05,u*(.08+Math.abs(Math.sin(i*.7))* .18),3),i);break;
 case 39:add(g=>poly(g,[-r,0,-r*.45,-r*.45,0,-r,r*.45,-r*.45,r,0,r*.45,r*.45,0,r,-r*.45,r*.45]),i,false);break;
 case 40:add(g=>g.ellipse(Math.cos(a)*u*.26,Math.sin(a)*u*.26,u*.16,u*.05),i);add(g=>g.circle(Math.cos(a)*u*.26,Math.sin(a)*u*.26,u*.025),i+1);break;
 case 41:add(g=>{for(let j=0;j<=40;j++){const xx=(j/40-.5)*w*1.15,yy=(t-.5)*h+Math.sin(j*.2+i*.5)*h*.12;j?g.lineTo(xx,yy):g.moveTo(xx,yy);}},i,false);break;
 case 42:add(g=>{const rr=u*(.2+(i%5)*.09);g.roundRect(-rr*.7,-rr*.52,rr*1.4,rr*1.04,6);},i,false);break;
 case 43:add(g=>poly(g,[x,-h*.42,x+w*.12,-h*.42,x+w*.18,h*.35,x-w*.02,h*.5]),i);break;
 case 44:add(g=>poly(g,[-r*.55,0,0,-r*.32,r*.55,0,0,r*.32]),i);break;
 case 45:add(g=>{const rr=u*.42;g.moveTo(Math.cos(a)*rr,Math.sin(a)*rr);g.lineTo(Math.cos(a)*(rr+(i%4)*u*.045),Math.sin(a)*(rr+(i%4)*u*.045));g.circle(0,0,u*.03);},i,false);break;
 case 46:add(g=>{const xx=(i%2?1:-1)*w*.36;g.moveTo(xx,-h*.42);g.lineTo(xx+(i%2?-1:1)*u*.18,-h*.42);g.lineTo(xx+(i%2?-1:1)*u*.18,h*.42);g.lineTo(xx,h*.42);},i,false);break;
 case 47:add(g=>{const rr=u*(.12+(i%7)*.07);g.moveTo(-rr,0);g.lineTo(0,-rr*.62);g.lineTo(rr,0);g.lineTo(0,rr*.62);g.closePath();},i,false);break;
 case 48:add(g=>g.rect(x,-h*.58,w/n*.72,h*(.18+(i%5)*.09)),i);break;
 case 49:add(g=>{g.moveTo(-w*.6,(t-.5)*h);g.bezierCurveTo(-w*.28,h*.48,w*.28,-h*.48,w*.6,(.5-t)*h);},i,false);break;
 case 50:add(g=>{const yy=Math.sin(i*1.15+t*4)*h*.34;g.circle((t-.5)*w,yy,u*(.008+(i%4)*.007));},i);break;
 case 51:add(g=>{const column=Math.floor(i/2),step=i%2,xx=(column-2)*w*.18,yy=h*.34-step*h*.18;g.rect(xx,yy,w*.14,h*.16);},i);break;
 case 52:add(g=>g.arc(0,0,u*(.16+(i%7)*.055),a,a+Math.PI*1.2),i,false);break;
 case 53:add(g=>poly(g,[x,-h*.55,x+w*.2,-h*.38,x+w*.08,h*.55,x-w*.12,h*.38]),i);break;
 case 54:add(g=>{const step=i%6;g.rect(-u*(.45-step*.08),-u*(.36-step*.05),u*2*(.45-step*.08),u*.09);},i,false);break;
 case 55:add(g=>{const xx=Math.cos(a)*u*.36,yy=Math.sin(a)*u*.32;g.moveTo(xx-u*.07,yy);g.lineTo(xx+u*.07,yy);g.moveTo(xx,yy-u*.07);g.lineTo(xx,yy+u*.07);g.circle(xx,yy,u*.012);},i,false);break;
 case 56:add(g=>poly(g,[-u*.5,(t-.5)*h,Math.cos(a)*u*.06,Math.sin(a)*h*.42,u*.5,(.5-t)*h]),i,false);break;
 case 57:add(g=>g.ellipse(Math.cos(a)*u*.24,-Math.sin(a)*u*.24,u*.2,u*.07),i);break;
 case 58:add(g=>{g.moveTo(-w*.55,(t-.5)*h);g.bezierCurveTo(-w*.2,h*(.5-t),w*.2,h*(t-.5),w*.55,(.5-t)*h);},i,false);break;
 case 59:add(g=>g.rect(Math.round(x/u*8)*u*.12,Math.round(Math.sin(a)*6)*u*.12,u*(.018+(i%3)*.012),u*.05),i);break;
 case 60:add(g=>g.roundRect((t-.5)*w*.75,-h*(.12+(i%4)*.09),u*.26,u*(.16+(i%3)*.05),5),i,false);break;
 case 61:add(g=>{const xx=Math.cos(a)*u*.36,yy=Math.sin(a)*u*.34;g.circle(xx,yy,u*.025);g.moveTo(0,0);g.lineTo(xx,yy);},i,false);break;
 case 62:add(g=>{const xx=(t-.5)*w*1.1;g.roundRect(xx,-h*(.2+Math.abs(Math.sin(i))* .25),w/n*.55,h*(.4+Math.abs(Math.sin(i))* .5),3);},i);break;
 case 63:add(g=>g.arc(x,h*.35,u*(.1+(i%4)*.045),Math.PI,Math.PI*2),i,false);break;
 case 64:add(g=>{g.moveTo(-w*.55,(t-.5)*h);g.lineTo(w*.55,(.5-t)*h);g.moveTo((t-.5)*w,-h*.55);g.lineTo((.5-t)*w,h*.55);},i,false);break;
 case 65:add(g=>g.ellipse(Math.sin(i*1.7)*w*.32,Math.cos(i*2.1)*h*.28,u*(.12+(i%3)*.04),u*.06),i);break;
 case 66:add(g=>g.circle((t-.5)*w*.7,Math.sin(a)*h*.18,u*(.06+(i%6)*.035)),i,false);break;
 case 67:add(g=>{const xx=(t-.5)*w*1.05;g.moveTo(xx,-h*.55);g.bezierCurveTo(xx+Math.sin(i)*u*.14,-h*.1,xx-Math.cos(i)*u*.14,h*.1,xx,h*.55);},i,false);break;
 case 68:add(g=>g.roundRect((i%5-2)*w*.18,(Math.floor(i/5)-1)*h*.28,u*.13,u*.07,3),i);break;
 case 69:add(g=>g.circle(0,0,r),i,false);if(i<6)add(g=>{g.moveTo(0,0);g.lineTo(Math.cos(a)*w*.7,Math.sin(a)*h*.7);},i,false);break;
 case 70:add(g=>g.circle((t-.5)*w*.45,Math.cos(a)*h*.18,u*(.06+i*.018)),i,false);break;
 case 71:add(g=>{g.moveTo(-w*.55,(t-.5)*h);g.lineTo(-w*.15,-h*.4+i*h*.08);g.lineTo(w*.08,h*.35-i*h*.06);g.lineTo(w*.55,(.5-t)*h);},i,false);break;
 }
 }
}
