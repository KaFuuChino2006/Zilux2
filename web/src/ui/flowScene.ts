import { FLOW_SETTINGS_EVENT, FLOW_SETTINGS_KEY, flowSettings, flowTuning, normalizeFlowSettings, type FlowSettings } from './flowSettings';
import type { LumiereSongInput } from './lumiere';
import { type Line, type Theme } from './lumiere-folia/types';
import { DEFAULT_THEME } from './lumiere-folia/services/baseThemes';
import { MotionValue } from './lumiere-folia/shims/framer-motion';
import { compileTemperaProgram } from './lumiere-folia/components/visualizer/tempera/temperaProgram';
import { TemperaPixiRuntime, type TemperaSongContext } from './lumiere-folia/components/visualizer/tempera/createTemperaPixiRuntime';
import {
  FLOW_COMPOSITION_ORDER,
  FLOW_ORIGINAL_END,
  FLOW_ORIGINAL_START,
  FLOW_ORIGINAL_STYLES,
  flowMgVariantForId,
} from './flowMg';
import { applyFlowMotion, flowHash } from './flowMotion';
import { createFlowPicker, readFlowHistory, recordFlowCompositions } from './flowRotation';
import type { TemperaShot } from './lumiere-folia/components/visualizer/tempera/types';
import { flowSongSignature } from './flowHandoff';
import { extractLyricKeywords } from './keywords';
import { createFlowCountdown } from './flowCountdown';
import { perfEvent, perfMark, perfMarkSlow, perfOn } from './perfProbe';

/** Folia v0.7.21 Tempera, with only Zilux's millisecond clock and lyric model adapted. */
export function createFlowScene(onPainted?: () => void, onError?: (error: unknown) => void, recordUsage = true, fixedStyle?: FlowSettings) {
  const root = document.createElement('div');
  root.className = 'zl-flow-scene';
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden';
  // Folia's React shell supplies the opaque theme backdrop outside the Pixi canvas.
  root.style.backgroundColor = DEFAULT_THEME.backgroundColor;
  const countdown=fixedStyle ? null : createFlowCountdown(root);
  const clock = new MotionValue(0);
  const abort = new AbortController();
  let runtime: TemperaPixiRuntime | null = null;
  let song: LumiereSongInput | null = null;
  let theme: Theme = DEFAULT_THEME;
  // 主题去重用的「有效签名」：只有这些字段会进入 compile()/着色，字体语言分析结果变了才需要重建。
  // 切歌时同步链会连着推好几次同一个主题（匹配结果分批到达），没有这个短路就是反复整场重建。
  const themeSignature=(value:Theme):string=>[value.backgroundColor,value.primaryColor,value.accentColor,value.secondaryColor,value.fontStyle,value.fontFamily??'',value.fontFamilyStack?.join(',')??'',value.fontWeight??'',value.animationIntensity,(value.wordColors??[]).map(word=>`${word.word}:${word.color}`).join(',')].join('|');
  let themeKey=themeSignature(theme);
  let style=fixedStyle ?? flowSettings();
  let coverColors:string[]=[];
  // flowTuning() 每次都返回新对象，直接传给 setTuning 等于每次 applySong 都强制重跑整套
  // 调音（重建印刷滤镜链、遍历所有场景换图池、暂停态还要多画一帧）。设置没换就复用同一份。
  let tuningStyle:FlowSettings|null=null,tuningCache:ReturnType<typeof flowTuning>|null=null;
  const tuning=()=>{
    if(tuningStyle!==style||!tuningCache){tuningStyle=style;tuningCache=flowTuning(style);}
    return tuningCache;
  };
  // 切歌那一瞬间同步链会把主题/调色板/歌推好几次（歌词匹配分批到达、封面取色异步回来），
  // 过去每一次都立刻 compile + swapSong + 清场重建，全部落在同一帧里就是几百毫秒的卡顿。
  // 这里改成「标记脏 + 帧内合并」：同一帧里的多次改动只编译一次、只换一次场。
  let dirty=false, scheduled=0;
  let disposed = false, revision = 0;
  let lastTime = 0;
  let starting: Promise<void> | null = null;
  let appliedRevision=-1;
  let compiledShots:TemperaShot[]=[];
  let runSeed=String(crypto.getRandomValues(new Uint32Array(1))[0]);
  let history=readFlowHistory();
  const shownShots=new Set<string>();
  const shotCompositions=new Map<string,number[]>();
  let context: TemperaSongContext = compile();

  // 歌词文件开头的「词：…」「曲：…」「编曲：…」这一类署名行不是歌词：
  // 重合档会把它们当成句子排进画面，既不唱也占一屏。这里整行剔掉（只对重合档生效）。
  const CREDIT_LINE = /^\s*(作词|作曲|编曲|词|曲|制作人|出品|监制|录音|混音|母带|吉他|贝斯|鼓|和声|弦乐|统筹|企划|发行|OP|SP|Lyrics?|Music|Arrang\w*|Producer|Mixed|Mastered)\s*[:：]/i;

  function compile(): TemperaSongContext {
    const profileStart = perfOn() ? performance.now() : 0;
    const source = fixedStyle
      ? (song?.lines ?? []).filter(line => !CREDIT_LINE.test(line.text))
      : (song?.lines ?? []);
    const lines: Line[] = source.map((line) => ({
      startTime: line.timeMs / 1000,
      endTime: (line.timeMs + Math.max(20, line.durationMs)) / 1000,
      fullText: line.text,
      translation: line.translation || undefined,
      words: line.words.map(word => ({
        text: `${word.spaceBefore ? ' ' : ''}${word.text}`,
        startTime: word.startMs / 1000,
        endTime: Math.max(word.startMs + 1, word.endMs) / 1000,
      })),
    }));
    // Same instrumental sequence as VisualizerTempera's React shell.
    if (!fixedStyle && !lines.length && song) {
      for (let i = 0; i < 60; i++) lines.push({ id: `virtual-block-${i}`, startTime: i * 8, endTime: i * 8 + 6, fullText: '♪', words: [], isChorus: false });
    }
    const compileStart = performance.now();
    const program=compileTemperaProgram(lines,song?.trackKey||'tempera',{wholeLineLyrics:style.wholeLineLyrics});
    if (localStorage.getItem('zilux2.perf') === '1') console.debug('[perf] compile', Math.round(performance.now() - compileStart), 'ms, shots', program.paragraphs.reduce((n, p) => n + p.shots.length, 0));
    if (fixedStyle) {
      // Overlap keeps a line on screen until the line two further down starts. With split
      // lyrics there are several shots per line, so the hold is keyed by the shot's own line.
      // Each lyric shot is its own line: with split lyrics on, every chunk holds and leaves on
      // its own schedule (the shot two further down), instead of being grouped with its siblings.
      const lyrics = program.paragraphs.flatMap(p => p.shots).filter(shot => !shot.isBridge && shot.slices.length);
      lyrics.forEach((shot, index) => {
        const next = lyrics[index + 2];
        shot.holdUntil = next?.startTime ?? lyrics[lyrics.length - 1].lyricEndTime;
        // 退场分两段：下一句进来时先「散开」（停在散开的位置不动），下下句进来时才真正消散。
        shot.scatterAt = lyrics[index + 1]?.startTime ?? shot.endTime;
      });
    }
    const seed=`${runSeed}:${song?.trackKey||'tempera'}`;
    shotCompositions.clear();
    const rotationPool=style.mgSelection.length?style.mgSelection:FLOW_COMPOSITION_ORDER;
    const pick=createFlowPicker(rotationPool,seed,history);
    const originalPool=style.mgSelection.filter(id=>id>=FLOW_ORIGINAL_START&&id<FLOW_ORIGINAL_END);
    const pickOriginal=originalPool.length?createFlowPicker(originalPool,`${seed}:original`,history):null;
    const overlayPool=rotationPool.filter(id=>flowMgVariantForId(id)!==undefined);
    const pickOverlay=overlayPool.length?createFlowPicker(overlayPool,`${seed}:overlay`,history):null;
    let shotNumber=0;
    for(const paragraph of program.paragraphs) for(const shot of paragraph.shots){
      const number=shotNumber++;
      const displayedIds:number[]=[];
      if(style.mgPlayback==='rotate'){
        const id=pick();displayedIds.push(id);
        shot.drawOriginalComposition=id>=FLOW_ORIGINAL_START&&id<FLOW_ORIGINAL_END;
        shot.originalCompositionKind=shot.drawOriginalComposition
          ? FLOW_ORIGINAL_STYLES[id-FLOW_ORIGINAL_START]?.kind
          : undefined;
        const variant=flowMgVariantForId(id);
        shot.mgVariants=variant===undefined?undefined:[variant];
      }else if(style.mgSelection.length){
        const original=pickOriginal?.();
        shot.drawOriginalComposition=original!==undefined;
        if(original!==undefined)displayedIds.push(original);
        shot.originalCompositionKind=original===undefined
          ? undefined
          : FLOW_ORIGINAL_STYLES[original-FLOW_ORIGINAL_START]?.kind;
        shot.mgVariants=style.mgSelection
          .map(flowMgVariantForId)
          .filter((variant):variant is number=>variant!==undefined);
        displayedIds.push(...overlayPool);
      }else if(flowHash(`${seed}:${number}:overlay-chance`)/4294967296<style.mgMix&&pickOverlay){
        const chosen:number[]=[];
        for(let layer=0;layer<Math.min(style.mgLayers,overlayPool.length);layer++)chosen.push(pickOverlay(chosen));
        shot.mgVariants=chosen.map(id=>flowMgVariantForId(id)!);
        displayedIds.push(...chosen);
      }
      if(style.mgPlayback==='overlay'&&!style.mgSelection.length){
        const original=FLOW_ORIGINAL_STYLES.find(item=>item.kind===shot.kind);
        if(original)displayedIds.push(original.id);
      }
      shotCompositions.set(shot.id,displayedIds);
      applyFlowMotion(shot,style,seed);
    }
    compiledShots=program.paragraphs.flatMap(paragraph=>paragraph.shots).sort((a,b)=>a.startTime-b.startTime);
    // 关键字着色要跟着歌走：重合/拼合没有绘光那条按歌重建主题的管线，主题里的 wordColors
    // 一直是空的，于是「重点词换色」从来没生效过。这里按歌词里反复出现的词重新提取，
    // 颜色只取当前主题的强调/主/次三色，暗底上也保证看得见。
    // 重合档的纸色/字色是现算的（跟随封面），主题里的三色可能还是上一次/纯色档的，
    // 所以关键词直接用封面三色（强调取第二色，和 applyFlowPalette 的 accent 一致）。
    const keywordColors = fixedStyle && coverColors.length >= 2
      ? [coverColors[1] ?? coverColors[0]!, coverColors[0]!, coverColors[2] ?? coverColors[0]!]
      : [theme.accentColor, theme.primaryColor, theme.secondaryColor];
    const keywords = theme.wordColors?.length
      ? theme.wordColors
      : extractLyricKeywords(song?.lines ?? [], null, keywordColors)
          .map((keyword: {text: string; color: string}) => ({word: keyword.text, color: keyword.color}));
    const built: TemperaSongContext = {seed:song?.trackKey||'tempera',program,theme:{...theme,wordColors:keywords,fontWeight:style.fontWeight,flowStyle:style} as Theme,coverColors};
    if (profileStart) perfMark('flow.compile', profileStart, { shots: compiledShots.length, lines: lines.length });
    return built;
  }  function metadata() { return { title: song?.title, artist: song?.artist, album: song?.album }; }
  function fail(error: unknown) {
    if (disposed || abort.signal.aborted) return;
    if (onError) onError(error); else console.error('[tempera]', error);
  }
  /** 帧内合并的落点：把这一帧攒下来的改动编译一次、换场一次。 */
  function flush() {
    if (scheduled) { window.cancelAnimationFrame(scheduled); scheduled = 0; }
    if (disposed || !dirty) return;
    dirty = false;
    context = compile();
    if (runtime) void applySong().catch(fail);
  }
  function invalidate() {
    if (disposed) return;
    revision++;
    dirty = true;
    if (!scheduled) scheduled = window.requestAnimationFrame(flush);
  }
  async function applySong() {
    if (!runtime || disposed) return;
    runtime.setTuning(tuning());
    runtime.setSongMetadata(metadata());
    const applyingRevision=revision;
    const swapStart=perfOn()?performance.now():0;
    await runtime.swapSong(context, abort.signal);
    if(swapStart)perfMark('flow.swapSong',swapStart,{revision});
    if (!disposed&&applyingRevision===revision) {
      const paintStart=perfOn()?performance.now():0;
      runtime.renderOnce();
      if(paintStart)perfMark('flow.renderOnce',paintStart);
      appliedRevision=revision;
    }
  }
  function start(): Promise<void> {
    if (starting) return starting;
    if (disposed || !root.isConnected) return Promise.resolve();
    if (dirty) { dirty = false; context = compile(); }
    const createdRevision = revision;
    starting = (async () => {
      await document.fonts.ready;
      if (disposed) return;
      const created = await TemperaPixiRuntime.create({
        host: root, songSeed: context.seed, program: context.program, theme:context.theme,
        tuning: tuning(), currentTime: clock,
        lyricsFontScale: 1, staticMode: false, coverColors,
        // The host drives renderOnce from the player's clock; don't run a second Pixi ticker.
        lyricsOnly: !!fixedStyle, paused: true, songTitle: song?.title, songArtist: song?.artist, songAlbum: song?.album,
        signal: abort.signal,
      });
      if (disposed) { created.destroy(); return; }
      runtime = created;
      appliedRevision=createdRevision;
      if (createdRevision !== revision) await applySong();
      runtime.renderOnce(); onPainted?.();
    })();
    void starting.catch(fail);
    return starting;
  }
  const setStyle=(next:FlowSettings)=>{style=normalizeFlowSettings(next);invalidate();};
  const refreshStyle=(event:Event)=>setStyle((event as CustomEvent<FlowSettings>).detail??flowSettings());
  const syncStoredStyle=(event:StorageEvent)=>{if(event.key===FLOW_SETTINGS_KEY||event.key===null)setStyle(flowSettings());};
  if (!fixedStyle) {
    window.addEventListener(FLOW_SETTINGS_EVENT,refreshStyle);
    window.addEventListener('storage',syncStoredStyle);
  }
  return {
    setStyle,
    /** 落位方式这类不在 FlowSettings 里的开关改完后，让下一帧重新编译换场一次。 */
    refresh() { invalidate(); },
    setUsageRecording(enabled:boolean){recordUsage=enabled;},
    setPalette(colors:string[]) {if(JSON.stringify(colors)===JSON.stringify(coverColors))return;perfEvent('flow.setPalette.change');coverColors=[...colors];invalidate();},
    root,
    ready: () => start(),
    resize() { void start(); },
    update(positionMs: number) {
      if (disposed) return;
      if(recordUsage&&positionMs<500&&lastTime>2000){
        runSeed=String(crypto.getRandomValues(new Uint32Array(1))[0]);history=readFlowHistory();shownShots.clear();
        invalidate();
      }
      // 同一帧里攒下的改动先落地，再画这一帧，否则这一帧画的还是旧歌/旧主题。
      if (dirty) flush();
      lastTime = Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0;
      clock.set((lastTime + (song?.lyricOffsetMs || 0)) / 1000);
      countdown?.update(song,clock.get()*1000,style.text==='custom'?style.ink:'#fff0cd');
      if (runtime) {
        const paintStart=perfOn()?performance.now():0;
        runtime.renderOnce();
        perfMarkSlow('flow.update.render',paintStart,4);
        if(recordUsage&&appliedRevision===revision&&!document.hidden&&root.isConnected){
          const time=clock.get();
          let current:TemperaShot|undefined;
          for(const shot of compiledShots){if(shot.startTime>time)break;if(shot.endTime>time)current=shot;}
          if(current&&!shownShots.has(current.id)){
            shownShots.add(current.id);recordFlowCompositions(shotCompositions.get(current.id)??[]);
          }
        }
      } else void start();
    },
    setTheme(next: Theme) {
      const nextKey=themeSignature(next);
      if(nextKey===themeKey)return;
      perfEvent('flow.setTheme');
      themeKey=nextKey;theme = next; root.style.backgroundColor = next.backgroundColor; invalidate();
    },
    setSong(input: LumiereSongInput | null) {
      if (disposed) return;
      if(flowSongSignature(input)===flowSongSignature(song))return;
      perfEvent('flow.setSong');
      if(input?.trackKey&&input.trackKey===song?.trackKey){
        // 同一首歌的歌词被「精匹配」升级时会重推一次：分辨只是时间轴变了，还是文字本身变了。
        const before=(song?.lines??[]).map(line=>line.text).join('');
        const after=(input.lines??[]).map(line=>line.text).join('');
        const stampAt=performance.now();
        perfMark('flow.song.upgrade',stampAt,{textChanged:before===after?0:1,from:(song?.lines??[]).length,to:input.lines.length});
      }
      if(input?.trackKey!==song?.trackKey){runSeed=String(crypto.getRandomValues(new Uint32Array(1))[0]);history=readFlowHistory();shownShots.clear();}
      song = input; clock.set((lastTime + (song?.lyricOffsetMs || 0)) / 1000);
      invalidate();
    },
    dispose() { perfEvent('flow.dispose'); const start=perfOn()?performance.now():0; if(scheduled){window.cancelAnimationFrame(scheduled);scheduled=0;} window.removeEventListener(FLOW_SETTINGS_EVENT,refreshStyle); window.removeEventListener('storage',syncStoredStyle); disposed = true; abort.abort(); runtime?.destroy(); runtime = null; root.remove(); if(start)perfMark('flow.dispose.total',start); },
  };
}
