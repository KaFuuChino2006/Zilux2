import { flowSettings, flowTuning, normalizeFlowSettings, type FlowSettings } from './flowSettings';
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

/** Folia v0.7.21 Tempera, with only Zilux's millisecond clock and lyric model adapted. */
export function createFlowScene(onPainted?: () => void, onError?: (error: unknown) => void) {
  const root = document.createElement('div');
  root.className = 'zl-flow-scene';
  root.style.cssText = 'position:absolute;inset:0;overflow:hidden';
  // Folia's React shell supplies the opaque theme backdrop outside the Pixi canvas.
  root.style.backgroundColor = DEFAULT_THEME.backgroundColor;
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
    let index=0;
    let shotNumber=0;
    let mgNumber=0;
    for(const paragraph of program.paragraphs) for(const shot of paragraph.shots){
      const number=shotNumber++;
      const rotationPool=style.mgSelection.length
        ? style.mgSelection
        : FLOW_COMPOSITION_ORDER;
      if(style.mgPlayback==='rotate'){
        const id=rotationPool[mgNumber++%rotationPool.length];
        shot.drawOriginalComposition=id>=FLOW_ORIGINAL_START&&id<FLOW_ORIGINAL_END;
        shot.originalCompositionKind=shot.drawOriginalComposition
          ? FLOW_ORIGINAL_STYLES[id-FLOW_ORIGINAL_START]?.kind
          : undefined;
        const variant=flowMgVariantForId(id);
        shot.mgVariants=variant===undefined?undefined:[variant];
      }else if(style.mgSelection.length){
        const originalStyles=style.mgSelection.filter(id=>id>=FLOW_ORIGINAL_START&&id<FLOW_ORIGINAL_END);
        const original=originalStyles[mgNumber%Math.max(1,originalStyles.length)];
        shot.drawOriginalComposition=originalStyles.length>0;
        shot.originalCompositionKind=original===undefined
          ? undefined
          : FLOW_ORIGINAL_STYLES[original-FLOW_ORIGINAL_START]?.kind;
        shot.mgVariants=style.mgSelection
          .map(flowMgVariantForId)
          .filter((variant):variant is number=>variant!==undefined);
        mgNumber++;
      }else if(((number*37)%100)/100<style.mgMix){
        const pool=rotationPool
          .map(flowMgVariantForId)
          .filter((variant):variant is number=>variant!==undefined);
        shot.mgVariants=Array.from({length:style.mgLayers},(_,layer)=>pool[(mgNumber*7+layer*11)%pool.length]);
        mgNumber++;
      }
      if(style.motion!=='original'){
        const angles=style.motion==='horizontal'?[0,Math.PI]:style.motion==='diagonal'?[Math.PI/4,-Math.PI/4,Math.PI*3/4,-Math.PI*3/4]:[0,Math.PI/4,-Math.PI/2,Math.PI,-Math.PI/4,Math.PI/2,Math.PI*3/4,-Math.PI*3/4];
        shot.flowAngle=angles[index++%angles.length];
        shot.camera.x=-Math.cos(shot.flowAngle)*0.06;shot.camera.y=-Math.sin(shot.flowAngle)*0.06;
        shot.cameraEnd.x=Math.cos(shot.flowAngle)*0.03;shot.cameraEnd.y=Math.sin(shot.flowAngle)*0.03;
      }
    }
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
    await runtime.swapSong(context, abort.signal);
    if (!disposed) runtime.renderOnce();
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
      if (createdRevision !== revision) await applySong();
      runtime.renderOnce(); onPainted?.();
    })();
    void starting.catch(fail);
    return starting;
  }
  const setStyle=(next:FlowSettings)=>{style=normalizeFlowSettings(next);context=compile();revision++;void applySong().catch(fail);};
  const refreshStyle=()=>setStyle(flowSettings());
  window.addEventListener('zilux2:flow-settings',refreshStyle);
  return {
    setStyle,
    setPalette(colors:string[]) {coverColors=colors;context=compile();revision++;void applySong().catch(fail);},
    root,
    ready: () => start(),
    resize() { void start(); },
    update(positionMs: number) {
      if (disposed) return;
      lastTime = Number.isFinite(positionMs) ? Math.max(0, positionMs) : 0;
      clock.set((lastTime + (song?.lyricOffsetMs || 0)) / 1000);
      if (runtime) runtime.renderOnce(); else void start();
    },
    setTheme(next: Theme) { theme = next; root.style.backgroundColor = next.backgroundColor; context = compile(); revision++; void applySong().catch(fail); },
    setSong(input: LumiereSongInput | null) {
      if (disposed) return;
      song = input; clock.set((lastTime + (song?.lyricOffsetMs || 0)) / 1000);
      context = compile(); revision++; void applySong().catch(fail);
    },
    dispose() { window.removeEventListener('zilux2:flow-settings',refreshStyle); disposed = true; abort.abort(); runtime?.destroy(); runtime = null; root.remove(); },
  };
}
