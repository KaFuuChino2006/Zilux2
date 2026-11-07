import { h, icon, toast } from './dom';
import { lyricPreviewSong } from './lyrics';
import { flowCoverPalette } from './flow';
import type { LumiereSongInput } from './lumiere';
import { createFlowScene } from './flowScene';
import { FLOW_DEFAULTS, FLOW_RANGES, FLOW_SWITCHES, flowSettings, normalizeFlowSettings, saveFlowSettings, type FlowSettings } from './flowSettings';
import {
 FLOW_COMPOSITION_COUNT,
 FLOW_COMPOSITION_ORDER,
 FLOW_MG_STYLES,
 FLOW_ORIGINAL_STYLES,
} from './flowMg';

function demo():LumiereSongInput {
 const texts=['让色彩随歌声流动','穿过每一束光','把未说完的话折成纸页','We move into another morning','直到整个世界慢慢安静'];
 return {trackKey:'flow-settings-demo',title:'色彩与构成',artist:'Zilux2',album:'',durationMs:24000,lyricOffsetMs:0,lines:texts.map((text,i)=>({text,translation:'',timeMs:1000+i*4400,durationMs:4000,words:Array.from(text).map((text,j,chars)=>({text,startMs:1000+i*4400+j*3600/chars.length,endMs:1000+i*4400+(j+1)*3600/chars.length}))}))};
}
let opened:HTMLElement|null=null;
export function openFlowSettingsSheet():void {
 if(opened)return;
 const previousFocus=document.activeElement as HTMLElement|null;
 let draft=flowSettings(),disposed=false,raf=0,pending=0,playing=true,last=0,galleryScroll=0;
 const song=lyricPreviewSong()??demo();
 const start=Math.max(0,(song.lines[0]?.timeMs??0)-500),end=Math.max(start+4000,song.durationMs||24000);
 let position=start;
 const rows=h('div',{class:'ts-groups'});
 const preview=h('div',{class:'ts-preview-stage',style:'position:relative'});
 const status=h('div',{class:'ts-preview-hint',text:'独立预览 · 修改参数只作用于这里，保存后应用到播放器'});
 const scene=createFlowScene(undefined,error=>{status.textContent=`预览不可用：${error instanceof Error?error.message:String(error)}`;},false);
 preview.append(scene.root);scene.setStyle(draft);scene.setSong(song);scene.setPalette(flowCoverPalette());
 const seek=h('input',{class:'ts-range',type:'range',min:String(start),max:String(end),step:'10',value:String(start),'aria-label':'预览进度'}) as HTMLInputElement;
 seek.oninput=()=>{position=Number(seek.value);scene.update(position);};
 const pause=h('button',{class:'ts-btn',text:'暂停预览'});pause.onclick=()=>{playing=!playing;pause.textContent=playing?'暂停预览':'继续预览';};
 const restart=h('button',{class:'ts-btn is-quiet',text:'从头预览'});restart.onclick=()=>{position=start;scene.update(position);};
 const update=()=>{draft=normalizeFlowSettings(draft);clearTimeout(pending);pending=window.setTimeout(()=>{if(!disposed)scene.setStyle(draft);},120);};
 function group(title:string){const content=h('div',{class:'ts-group'},h('div',{class:'ts-group-title',text:title}));rows.append(content);return content;}
 function segments(parent:HTMLElement,label:string,choices:readonly (readonly [string,string])[],current:string,pick:(id:string)=>void){
 const host=h('div',{class:'ts-seg',style:'flex-wrap:wrap'});
 for(const [id,text]of choices){const b=h('button',{class:`ts-seg-btn${id===current?' is-on':''}`,type:'button',text});b.onclick=()=>{host.querySelectorAll('button').forEach(item=>item.classList.toggle('is-on',item===b));pick(id);update();};host.append(b);}
 parent.append(h('div',{class:'ts-row'},h('div',{class:'ts-row-head'},h('span',{class:'ts-label',text:label})),host));
 }
 function render(){
 const oldGallery=rows.querySelector('.flow-mg-gallery');
 if(oldGallery)galleryScroll=oldGallery.scrollTop;
 rows.replaceChildren();
 const presets=group('风格预设');
 const presetNames=['封面彩绘','黑白印刷','霓虹信号','柔和纸艺'];
 presetNames.forEach((name,i)=>{const b=h('button',{class:'ts-btn',text:name,style:'margin:4px'});b.onclick=()=>{draft=normalizeFlowSettings(i===0?FLOW_DEFAULTS:i===1?{...FLOW_DEFAULTS,background:'original',text:'original',inversion:true,mgMix:.4,postProcessGrain:.4}:i===2?{...FLOW_DEFAULTS,background:'custom',text:'custom',paper:'#10142f',ink:'#9bffe7',accent:'#fa4eb8',mgSelection:[24,25,27],mgMix:1,postProcessRgbShift:.2,intensity:1.3}:{...FLOW_DEFAULTS,background:'custom',text:'custom',paper:'#eee0ca',ink:'#3d3646',accent:'#bc806e',mgSelection:[4,6],mgMix:1,glyphMotion:.5,intensity:.5,postProcessGrain:.1});render();update();};presets.append(b);});
 const color=group('配色');
 const modes=[['cover','封面'],['lyrics','随段落'],['custom','自定义'],['original','黑白']] as const;
 segments(color,'背景颜色',modes,draft.background,id=>{draft.background=id as FlowSettings['background'];});
 segments(color,'歌词颜色',modes,draft.text,id=>{draft.text=id as FlowSettings['text'];});
 for(const [key,label]of [['paper','背景底色'],['ink','歌词颜色'],['accent','几何强调色']] as const){const input=h('input',{type:'color',value:draft[key],'aria-label':label}) as HTMLInputElement;input.oninput=()=>{draft[key]=input.value;update();};color.append(h('div',{class:'ts-row'},h('div',{class:'ts-row-head'},h('span',{class:'ts-label',text:label}),input)));}
 color.append(h('div',{class:'ts-hint',text:'自定义颜色在对应的「自定义」档生效；随段落按歌词分镜换色，不分析情绪。'}));
 for(const name of ['歌词','运镜','构图','印刷与画质']){
 const section=group(name);
 if(name==='运镜'){
  segments(section,'运镜方式',[['mixed','多角度随机'],['horizontal','左右划入'],['vertical','上下划入'],['diagonal','四角划入'],['rotation','旋转']],draft.motion,id=>{draft.motion=id as FlowSettings['motion'];render();});
  if(draft.motion==='horizontal')segments(section,'划入方向',[['random','随机'],['left','从左划入'],['right','从右划入']],draft.horizontalDirection,id=>{draft.horizontalDirection=id as FlowSettings['horizontalDirection'];});
  if(draft.motion==='vertical')segments(section,'划入方向',[['random','随机'],['up','从上划入'],['down','从下划入']],draft.verticalDirection,id=>{draft.verticalDirection=id as FlowSettings['verticalDirection'];});
  if(draft.motion==='diagonal')segments(section,'划入方向',[['random','随机'],['top-left','左上'],['top-right','右上'],['bottom-left','左下'],['bottom-right','右下']],draft.diagonalDirection,id=>{draft.diagonalDirection=id as FlowSettings['diagonalDirection'];});
  if(draft.motion==='rotation')segments(section,'旋转方向',[['random','随机'],['clockwise','顺时针'],['counterclockwise','逆时针']],draft.rotationDirection,id=>{draft.rotationDirection=id as FlowSettings['rotationDirection'];});
  if(draft.motion==='rotation'||draft.motion==='mixed')segments(section,'旋转时缩放',[['random','随机'],['in','逐渐放大'],['out','逐渐缩小'],['none','保持大小']],draft.rotationZoom,id=>{draft.rotationZoom=id as FlowSettings['rotationZoom'];});
  section.append(h('div',{class:'ts-hint',text:'划入方向按画面进入的边缘命名；随机按镜头抽取，固定方向会持续保持。原「默认运镜」现为「上下划入」。'}));
 }
 if(name==='构图'){
 segments(section,'播放方式',[['rotate','随机轮换'],['overlay','叠加播放']],draft.mgPlayback,id=>{draft.mgPlayback=id as FlowSettings['mgPlayback'];render();});
 const allIds=()=>FLOW_COMPOSITION_ORDER;
 const auto=h('button',{class:`ts-btn${!draft.mgSelection.length?' is-primary':''}`,text:'自动搭配'});auto.onclick=()=>{draft.mgSelection=[];draft.mgVariant=-1;render();update();};section.append(auto);
 const all=h('button',{class:'ts-btn',text:draft.mgPlayback==='rotate'?'全部轮换':'全部叠加',style:'margin-left:6px'});all.onclick=()=>{draft.mgSelection=allIds();draft.mgVariant=-1;render();update();};section.append(all);
 section.append(h('div',{class:'ts-hint',text:`共 ${FLOW_COMPOSITION_COUNT} 款构图 · 在下方滚动浏览，点击可多选`}));
 const gallery=h('div',{class:'flow-mg-gallery',tabindex:'0',role:'group','aria-label':'构图选择，可滚动浏览'});
 const names=new Map<number,string>();
 FLOW_ORIGINAL_STYLES.forEach(style=>names.set(style.id,style.name));
 FLOW_MG_STYLES.forEach(style=>names.set(style.id,style.name));
 const appendComposition=(index:number)=>{const id=FLOW_COMPOSITION_ORDER[index];const selected=draft.mgSelection.includes(id);const label=`${String(index+1).padStart(2,'0')} · ${names.get(id)??'?'}`;const b=h('button',{class:`ts-seg-btn${selected?' is-on':''}`,'data-composition-id':String(id),'aria-pressed':String(selected),text:`${selected?'✓ ':''}${label}`,title:draft.mgPlayback==='rotate'?'点击加入或移出轮换列表':'点击加入或移出叠加列表'});b.onclick=()=>{draft.mgSelection=selected?draft.mgSelection.filter(v=>v!==id):[...draft.mgSelection,id];draft.mgVariant=-1;render();rows.querySelector<HTMLButtonElement>(`[data-composition-id="${id}"]`)?.focus({preventScroll:true});update();};gallery.append(b);};
 FLOW_COMPOSITION_ORDER.forEach((_,index)=>appendComposition(index));section.append(gallery);gallery.scrollTop=galleryScroll;
 if(draft.mgSelection.length){
  const playback=draft.mgPlayback==='rotate'?'从选择范围内加权随机，每个镜头一种，避免连续重复':'所选构图同时叠加';
  section.append(h('div',{class:'ts-hint',text:`已选 ${draft.mgSelection.length} 款，${playback}。`}));
 }else{
  section.append(h('div',{class:'ts-hint',text:draft.mgPlayback==='rotate'?`在 ${FLOW_COMPOSITION_COUNT} 款构图中加权随机：越久没出现，概率越高；显示后降低权重。预览不计入播放记录。`:`自动叠加：${Math.round(draft.mgMix*100)}% 镜头叠加构图，其余保留镜头自带构图。`}));
 }
 }
 for(const [key,label,min,max,step,category]of FLOW_RANGES){if(category!==name||(key==='mgLayers'&&draft.mgPlayback!=='overlay')||(key==='mgMix'&&draft.mgPlayback==='rotate'))continue;const value=h('span',{class:'ts-value',text:draft[key].toFixed(2)});const input=h('input',{class:'ts-range',type:'range',min:String(min),max:String(max),step:String(step),value:String(draft[key]),'aria-label':label}) as HTMLInputElement;input.oninput=()=>{draft[key]=Number(input.value);value.textContent=draft[key].toFixed(2);update();};section.append(h('div',{class:'ts-row'},h('div',{class:'ts-row-head'},h('span',{class:'ts-label',text:label}),value),input));}
 for(const [key,label,category]of FLOW_SWITCHES){if(category!==name)continue;segments(section,label,[['on','开'],['off','关']],draft[key]?'on':'off',id=>{draft[key]=id==='on';});}
 }
 }
 const root=h('div',{class:'sheet text-sheet vinyl-sheet flow-sheet',id:'flow-settings'});
 const close=()=>{if(disposed)return;disposed=true;cancelAnimationFrame(raf);clearTimeout(pending);scene.dispose();document.removeEventListener('keydown',key,true);root.remove();opened=null;previousFocus?.focus();};
 const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}};
 const reset=h('button',{class:'ts-btn is-quiet',text:'恢复默认'});reset.onclick=()=>{draft={...FLOW_DEFAULTS};render();update();};
 const cancel=h('button',{class:'ts-btn',text:'取消'});cancel.onclick=close;
 const save=h('button',{class:'ts-btn is-primary',text:'保存'});save.onclick=()=>{saveFlowSettings(draft);toast('拼合设置已保存');close();};
 const exit=h('button',{class:'icon-btn',title:'关闭'},icon('close',16));exit.onclick=close;
 root.append(h('div',{class:'ts-panel',role:'dialog','aria-modal':'true','aria-label':'拼合设置'},
 h('div',{class:'sheet-head lp-head ts-head'},h('div',{class:'lp-head-text'},h('div',{class:'sheet-title',text:'拼合设置'}),h('div',{class:'lp-head-song',text:`拼合 · ${song.title}`})),exit),
 h('div',{class:'ts-body'},h('div',{class:'ts-preview-col'},h('div',{class:'ts-preview-label',text:'实时预览'}),preview,seek,h('div',{},pause,restart),status,h('div',{class:'ts-preview-note',text:`${FLOW_COMPOSITION_COUNT} 种构图 · 自由多选，支持轮换与叠加 · 暂停、拖动进度可检查任意时刻`})),h('div',{class:'ts-left'},rows)),
 h('div',{class:'ts-foot'},h('div',{class:'ts-foot-status',text:'保存后立即应用；取消不会改动原设置'}),h('div',{class:'ts-foot-actions'},reset,cancel,save))));
 root.onpointerdown=e=>{if(e.target===root)close();};render();document.body.append(root);opened=root;document.addEventListener('keydown',key,true);exit.focus();scene.resize();
 const frame=(now:number)=>{if(disposed)return;if(last&&playing)position=start+(position-start+Math.min(100,now-last))%(end-start);last=now;scene.update(position);seek.value=String(position);raf=requestAnimationFrame(frame);};raf=requestAnimationFrame(frame);
}
