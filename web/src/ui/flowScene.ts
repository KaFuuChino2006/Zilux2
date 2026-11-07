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
import { createFlowCountdown } from './flowCountdown';

/** Folia v0.7.21 Tempera, with only Zilux's millisecond clock and lyric model adapted. */
export function createFlowScene(onPainted?: () => void, onError?: (error: unknown) => void, recordUsage = true) {
  const root = document.createElement('div');
  root.className = 'zl-flow-scene';
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden';
  // Folia's React shell supplies the opaque theme backdrop outside the Pixi canvas.
  root.style.backgroundColor = DEFAULT_THEME.backgroundColor;
  const countdown=createFlowCountdown(root);
  const clock = new MotionValue(0);
  const abort = new AbortController();
  let runtime: TemperaPixiRuntime | null = null;
  let song: LumiereSongInput | null = null;
  let theme: Theme = DEFAULT_THEME;
  let style=flowSettings();
  let coverColors:string[]=[];
  const tuning=()=>flowTuning(style);
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

  function compile(): TemperaSongContext {
    const lines: Line[] = (song?.lines ?? []).map((line) => ({
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
    if (!lines.length && song) {
      for (let i = 0; i < 60; i++) lines.push({ id: `virtual-block-${i}`, startTime: i * 8, endTime: i * 8 + 6, fullText: '♪', words: [], isChorus: false });
    }
    const program=compileTemperaProgram(lines,song?.trackKey||'tempera',{wholeLineLyrics:style.wholeLineLyrics});
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
    return {seed:song?.trackKey||'tempera',program,theme:{...theme,fontWeight:style.fontWeight,flowStyle:style} as Theme,coverColors};
  }
  function metadata() { return { title: song?.title, artist: song?.artist, album: song?.album }; }
  function fail(error: unknown) {
    if (disposed || abort.signal.aborted) return;
    if (onError) onError(error); else console.error('[tempera]', error);
  }
  async function applySong() {
    if (!runtime || disposed) return;
    runtime.setTuning(tuning());
    runtime.setSongMetadata(metadata());
    const applyingRevision=revision;
    await runtime.swapSong(context, abort.signal);
    if (!disposed&&applyingRevision===revision) {appliedRevision=revision;runtime.renderOnce();}
  }
  function start(): Promise<void> {
    if (starting) return starting;
    if (disposed || !root.isConnected) return Promise.resolve();
    const createdRevision = revision;
    starting = (async () => {
      await document.fonts.ready;
      if (disposed) return;
      const created = await TemperaPixiRuntime.create({
        host: root, songSeed: context.seed, program: context.program, theme:context.theme,
        tuning: tuning(), currentTime: clock,
        lyricsFontScale: 1, staticMode: false, coverColors,
        // The host drives renderOnce from the player's clock; don't run a second Pixi ticker.
        paused: true, songTitle: song?.title, songArtist: song?.artist, songAlbum: song?.album,
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
  const setStyle=(next:FlowSettings)=>{style=normalizeFlowSettings(next);context=compile();revision++;void applySong().catch(fail);};
  const refreshStyle=(event:Event)=>setStyle((event as CustomEvent<FlowSettings>).detail??flowSettings());
  const syncStoredStyle=(event:StorageEvent)=>{if(event.key===FLOW_SETTINGS_KEY||event.key===null)setStyle(flowSettings());};
  window.addEventListener(FLOW_SETTINGS_EVENT,refreshStyle);
  window.addEventListener('storage',syncStoredStyle);
  return {
    setStyle,
    setUsageRecording(enabled:boolean){recordUsage=enabled;},
    setPalette(colors:string[]) {if(JSON.stringify(colors)===JSON.stringify(coverColors))return;coverColors=[...colors];context=compile();revision++;void applySong().catch(fail);},
    root,
    ready: () => start(),
    resize() { void start(); },
    update(positionMs: number) {
      if (disposed) return;
      if(recordUsage&&positionMs<500&&lastTime>2000){
        runSeed=String(crypto.getRandomValues(new Uint32Array(1))[0]);history=readFlowHistory();shownShots.clear();
        context=compile();revision++;void applySong().catch(fail);
      }
      lastTime = Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0;
      clock.set((lastTime + (song?.lyricOffsetMs || 0)) / 1000);
      countdown.update(song,clock.get()*1000,style.text==='custom'?style.ink:'#fff0cd');
      if (runtime) {
        runtime.renderOnce();
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
    setTheme(next: Theme) { theme = next; root.style.backgroundColor = next.backgroundColor; context = compile(); revision++; void applySong().catch(fail); },
    setSong(input: LumiereSongInput | null) {
      if (disposed) return;
      if(flowSongSignature(input)===flowSongSignature(song))return;
      if(input?.trackKey!==song?.trackKey){runSeed=String(crypto.getRandomValues(new Uint32Array(1))[0]);history=readFlowHistory();shownShots.clear();}
      song = input; clock.set((lastTime + (song?.lyricOffsetMs || 0)) / 1000);
      context = compile(); revision++; void applySong().catch(fail);
    },
    dispose() { window.removeEventListener(FLOW_SETTINGS_EVENT,refreshStyle); window.removeEventListener('storage',syncStoredStyle); disposed = true; abort.abort(); runtime?.destroy(); runtime = null; root.remove(); },
  };
}
