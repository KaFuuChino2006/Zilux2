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
 let draft=flowSettings(),disposed=false,raf=0,pending=0,playing=true,last=0;
 const song=lyricPreviewSong()??demo();
 const start=Math.max(0,(song.lines[0]?.timeMs??0)-500),end=Math.max(start+4000,song.durationMs||24000);
 let position=start;
 const rows=h('div',{class:'ts-groups'});
 const preview=h('div',{class:'ts-preview-stage',style:'position:relative'});
 const status=h('div',{class:'ts-preview-hint',text:'独立预览 · 修改参数只作用于这里，保存后应用到播放器'});
 const scene=createFlowScene(undefined,error=>{status.textContent=`预览不可用：${error instanceof Error?error.message:String(error)}`;});
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
 for(const name of ['歌词','运镜','MG 构图','印刷与画质']){
 const section=group(name);
 if(name==='运镜')segments(section,'划入方向',[['mixed','多角度'],['horizontal','左右'],['diagonal','四角'],['original','默认运镜']],draft.motion,id=>{draft.motion=id as FlowSettings['motion'];});
 if(name==='MG 构图'){
 segments(section,'播放方式',[['rotate','轮换播放'],['overlay','叠加播放']],draft.mgPlayback,id=>{draft.mgPlayback=id as FlowSettings['mgPlayback'];render();});
 const allIds=()=>FLOW_COMPOSITION_ORDER;
 const auto=h('button',{class:`ts-btn${!draft.mgSelection.length?' is-primary':''}`,text:'自动搭配'});auto.onclick=()=>{draft.mgSelection=[];draft.mgVariant=-1;render();update();};section.append(auto);
 const all=h('button',{class:'ts-btn',text:draft.mgPlayback==='rotate'?'全部轮换':'全部叠加',style:'margin-left:6px'});all.onclick=()=>{draft.mgSelection=allIds();draft.mgVariant=-1;render();update();};section.append(all);
 const gallery=h('div',{class:'flow-mg-gallery'});
 const appendComposition=(prefix:string,name:string,index:number)=>{const selected=draft.mgSelection.includes(index);const b=h('button',{class:`ts-seg-btn${selected?' is-on':''}`,'aria-pressed':String(selected),text:`${selected?'✓ ':''}${prefix} · ${name}`,title:draft.mgPlayback==='rotate'?'点击加入或移出轮换列表':'原版逐镜轮换，MG 可同时叠加'});b.onclick=()=>{draft.mgSelection=selected?draft.mgSelection.filter(v=>v!==index):[...draft.mgSelection,index];draft.mgVariant=-1;render();update();};gallery.append(b);};
 FLOW_MG_STYLES.forEach(style=>appendComposition(`MG ${String(style.variant+1).padStart(2,'0')}`,style.name,style.id));
 FLOW_ORIGINAL_STYLES.forEach((style,index)=>appendComposition(`原版 ${String(index+1).padStart(3,'0')}`,style.name,style.id));section.append(gallery);
 if(draft.mgSelection.length){
  const playback=draft.mgPlayback==='rotate'?'按选择顺序轮换，每个镜头一种':'原版逐镜轮换，所选 MG 同时叠加';
  section.append(h('div',{class:'ts-hint',text:`已选 ${draft.mgSelection.length} 款，${playback}。原版样式已全部拆分为独立选项。`}));
 }else{
  section.append(h('div',{class:'ts-hint',text:draft.mgPlayback==='rotate'?`自动搭配 ${FLOW_ORIGINAL_STYLES.length} 款原版与 ${FLOW_MG_STYLES.length} 款 MG，共 ${FLOW_COMPOSITION_COUNT} 款连续轮换。`:`自动叠加：${Math.round(draft.mgMix*100)}% 镜头使用 MG，其余保留原版构图。`}));
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
 const save=h('button',{class:'ts-btn is-primary',text:'保存'});save.onclick=()=>{saveFlowSettings(draft);toast('凝彩设置已保存');close();};
 const exit=h('button',{class:'icon-btn',title:'关闭'},icon('close',16));exit.onclick=close;
 root.append(h('div',{class:'ts-panel',role:'dialog','aria-modal':'true','aria-label':'凝彩设置'},
 h('div',{class:'sheet-head lp-head ts-head'},h('div',{class:'lp-head-text'},h('div',{class:'sheet-title',text:'凝彩设置'}),h('div',{class:'lp-head-song',text:`凝彩 · ${song.title}`})),exit),
 h('div',{class:'ts-body'},h('div',{class:'ts-preview-col'},h('div',{class:'ts-preview-label',text:'实时预览'}),preview,seek,h('div',{},pause,restart),status,h('div',{class:'ts-preview-note',text:`${FLOW_ORIGINAL_STYLES.length} 种原版 + ${FLOW_MG_STYLES.length} 种 MG · 自由多选，支持轮换与叠加 · 暂停、拖动进度可检查任意时刻`})),h('div',{class:'ts-left'},rows)),
 h('div',{class:'ts-foot'},h('div',{class:'ts-foot-status',text:'保存后立即应用；取消不会改动原设置'}),h('div',{class:'ts-foot-actions'},reset,cancel,save))));
 root.onpointerdown=e=>{if(e.target===root)close();};render();document.body.append(root);opened=root;document.addEventListener('keydown',key,true);exit.focus();scene.resize();
 const frame=(now:number)=>{if(disposed)return;if(last&&playing)position=start+(position-start+Math.min(100,now-last))%(end-start);last=now;scene.update(position);seek.value=String(position);raf=requestAnimationFrame(frame);};raf=requestAnimationFrame(frame);
}
