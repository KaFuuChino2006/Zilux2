import { DEFAULT_TEMPERA_TUNING } from './lumiere-folia/types';
import {
  ensureInkContrast,
  repaintTemperaTones,
  type TemperaPalette,
} from './lumiere-folia/components/visualizer/tempera/temperaPalette';
import { FLOW_COMPOSITION_COUNT } from './flowMg';
export type FlowColorMode = 'original' | 'cover' | 'lyrics' | 'custom';
export interface FlowSettings {
 background:FlowColorMode; text:FlowColorMode; paper:string; ink:string; accent:string;
 motion:'vertical'|'mixed'|'horizontal'|'diagonal'|'rotation'; intensity:number; inversion:boolean;
 horizontalDirection:'random'|'left'|'right'; verticalDirection:'random'|'up'|'down';
 rotationDirection:'random'|'clockwise'|'counterclockwise'; diagonalDirection:'random'|'top-left'|'top-right'|'bottom-left'|'bottom-right';
 rotationZoom:'none'|'in'|'out'|'random';
 sizeScale:number; fontWeight:number; glyphMotion:number; glyphSettleStretch:number;
 wholeLineLyrics:boolean; showBlocks:boolean; showDecor:boolean; showCornerMarks:boolean; enableTransitions:boolean;
 textureResolution:number; postProcessTextureCompression:boolean; postProcessGrain:number; postProcessContrast:number;
 postProcessRgbShift:number; postProcessVignette:number; postProcessLensDistortion:number;
 mgPlayback:'rotate'|'overlay'; mgSelection:number[]; mgLayers:number; mgMix:number; mgDensity:number; mgScale:number; mgOpacity:number; mgStagger:number;
 mgFamily:'all'|'orbit'|'paper'|'wave'|'grid'|'prism'|'type'|'signal'|'organic'; mgVariant:number;
}
export const FLOW_DEFAULTS:FlowSettings={
 background:'cover',text:'cover',paper:'#15263f',ink:'#fff0cd',accent:'#ee729d',motion:'mixed',intensity:1,inversion:false,
 horizontalDirection:'random',verticalDirection:'random',rotationDirection:'random',diagonalDirection:'random',
 rotationZoom:'random',
 sizeScale:1,fontWeight:800,glyphMotion:1,glyphSettleStretch:.5,wholeLineLyrics:false,showBlocks:true,showDecor:true,showCornerMarks:true,enableTransitions:true,
 textureResolution:1.5,postProcessTextureCompression:false,postProcessGrain:.2,postProcessContrast:0,postProcessRgbShift:0,postProcessVignette:.85,postProcessLensDistortion:.3,
 mgPlayback:'rotate',mgSelection:[],mgLayers:3,mgMix:.65,mgDensity:1,mgScale:1,mgOpacity:.8,mgStagger:.65,mgFamily:'all',mgVariant:-1,
};
export const FLOW_RANGES = [
 ['sizeScale','字号倍率',.6,1.6,.05,'歌词'],['fontWeight','字重',300,900,50,'歌词'],['glyphMotion','逐字运动幅度',0,2,.05,'歌词'],['glyphSettleStretch','逐字落位时长',0,1,.05,'歌词'],
 ['intensity','镜头移动强度',0,2,.05,'运镜'],['mgLayers','自动叠加层数',1,6,1,'MG 构图'],['mgMix','自动叠加出现率',0,1,.05,'MG 构图'],['mgDensity','图形密度',.4,1.6,.1,'MG 构图'],['mgScale','图形尺度',.6,1.5,.05,'MG 构图'],['mgOpacity','图形不透明度',.2,1,.05,'MG 构图'],['mgStagger','图形入场错拍',0,1,.05,'MG 构图'],
 ['postProcessGrain','纸面颗粒',0,1,.05,'印刷与画质'],['postProcessContrast','对比度',0,1,.05,'印刷与画质'],['postProcessRgbShift','色版偏移',0,1,.05,'印刷与画质'],['postProcessVignette','暗角',0,2,.05,'印刷与画质'],['postProcessLensDistortion','镜头畸变',0,2,.05,'印刷与画质'],['textureResolution','渲染清晰度',.75,2,.25,'印刷与画质'],
] as const;
export const FLOW_SWITCHES=[['inversion','文字动态反色','歌词'],['wholeLineLyrics','整句显示','歌词'],['enableTransitions','段落转场','运镜'],['showBlocks','几何背景','MG 构图'],['showDecor','装饰线稿','MG 构图'],['showCornerMarks','四角定位标记','MG 构图'],['postProcessTextureCompression','节省显存','印刷与画质']] as const;
export const FLOW_SETTINGS_KEY='zilux2.flowSettings';
export const FLOW_SETTINGS_EVENT='zilux2:flow-settings';
export function normalizeFlowSettings(input:unknown):FlowSettings {
 const raw=input&&typeof input==='object'?input as Record<string,unknown>:{};
 const out={...FLOW_DEFAULTS};
 for(const [key,,min,max]of FLOW_RANGES){const v=raw[key];if(typeof v==='number'&&Number.isFinite(v))out[key]=Math.max(min,Math.min(max,v));}
 for(const [key]of FLOW_SWITCHES)if(typeof raw[key]==='boolean')out[key]=raw[key];
 for(const key of ['paper','ink','accent'] as const)if(typeof raw[key]==='string'&&/^#[0-9a-f]{6}$/i.test(raw[key]))out[key]=raw[key];
 const enums={mgPlayback:['rotate','overlay'],background:['original','cover','lyrics','custom'],text:['original','cover','lyrics','custom'],motion:['vertical','mixed','horizontal','diagonal','rotation'],horizontalDirection:['random','left','right'],verticalDirection:['random','up','down'],rotationDirection:['random','clockwise','counterclockwise'],rotationZoom:['none','in','out','random'],diagonalDirection:['random','top-left','top-right','bottom-left','bottom-right'],mgFamily:['all','orbit','paper','wave','grid','prism','type','signal','organic']};
 for(const key of Object.keys(enums) as (keyof typeof enums)[])if(enums[key].includes(String(raw[key])))Object.assign(out,{[key]:raw[key]});
 if(raw.motion==='original')out.motion='vertical';
 if(typeof raw.mgVariant==='number'&&Number.isInteger(raw.mgVariant)&&raw.mgVariant>=-1&&raw.mgVariant<32)out.mgVariant=raw.mgVariant;
 out.mgLayers=Math.round(out.mgLayers);
 out.mgSelection=Array.isArray(raw.mgSelection)?[...new Set(raw.mgSelection.filter((v):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=0&&v<FLOW_COMPOSITION_COUNT))]:out.mgVariant>=0?[out.mgVariant]:[];
 return out;
}
export function flowSettings():FlowSettings {try{return normalizeFlowSettings(JSON.parse(localStorage.getItem(FLOW_SETTINGS_KEY)||'{}'));}catch{return {...FLOW_DEFAULTS};}}
export function flowTuning(s:FlowSettings){return {...DEFAULT_TEMPERA_TUNING,...s,textInversion:s.inversion,cameraIntensity:s.intensity};}
export function saveFlowSettings(s:FlowSettings){const value=normalizeFlowSettings(s);localStorage.setItem(FLOW_SETTINGS_KEY,JSON.stringify(value));window.dispatchEvent(new CustomEvent(FLOW_SETTINGS_EVENT,{detail:value}));return value;}
export function applyFlowPalette(palette: TemperaPalette, settings: FlowSettings, cover: string[], seed: number) {
 const fallback=['#7c8fff','#ee729d','#65d7bf','#ffc577'];
 const base=cover.length>=2?cover:fallback;
 const rotated=Array.from({length:4},(_,i)=>base[(i+(seed>>>0)%base.length)%base.length]);
 const tint=(hex:string,amount:number)=>/^#[0-9a-f]{6}$/i.test(hex)?'#'+[1,3,5].map(i=>Math.max(0,Math.min(255,Math.round(amount<0?parseInt(hex.slice(i,i+2),16)*(1+amount):parseInt(hex.slice(i,i+2),16)*(1-amount)+255*amount))).toString(16).padStart(2,'0')).join(''):hex;
 let backgroundColors:string[]|null=null;
 if(settings.background!=='original'){
 backgroundColors=settings.background==='custom'?[settings.paper,settings.accent,settings.paper,settings.accent]:settings.background==='lyrics'?rotated:base;
 const colors=backgroundColors;
 palette.paper=settings.background==='custom'?settings.paper:tint(colors[0],-0.78);
 palette.blockA=colors[0];palette.blockB=colors[1%colors.length];palette.blockC=colors[2%colors.length];palette.accent=colors[1%colors.length];
 // 原版 121 款构图全部用 tone1-4 画结构、从不用 block/accent，所以背景颜色必须落到下面
 // 重算的灰阶阶梯上。这里不再把四条颜色塞进 gradient：那会让每个色块再被 50% 灰阶混
 // 一次，正是「原版看起来没应用背景颜色」的根源。
 palette.gradient=null;
 }
 if(settings.text!=='original'){
 const colors=settings.text==='custom'?[settings.ink,settings.ink]:settings.text==='lyrics'?rotated:base;
 palette.ink=settings.text==='custom'?settings.ink:tint(colors[0],0.6);palette.textGradient=colors.map(c=>settings.text==='custom'?c:tint(c,0.6));
 }
 if(backgroundColors){
 // 纸换了之后，跟随类的歌词色要重新保证和纸有对比（浅底色 + 近白字会读不清）；自定义字色尊重用户选择。
 if(settings.text!=='custom')palette.ink=ensureInkContrast(palette.paper,palette.ink);
 // 自定义档的四色里 [paper, accent, paper, accent]：accent 是「几何强调色」，专门给 MG 图形用。
 // 拿它当灰阶中段的染色会把底色和强调色互相抵消（橙纸 + 青强调 = 灰），所以自定义档只走
 // paper→ink 的纯阶梯，封面/随段落才用封面里的第二、三色做双色套印。
 const tintA=settings.background==='custom'?undefined:backgroundColors[1];
 const tintB=settings.background==='custom'?undefined:backgroundColors[2%backgroundColors.length];
 repaintTemperaTones(palette,tintA,tintB);
 }
}
