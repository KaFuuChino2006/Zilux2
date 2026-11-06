import type { LumiereMode, LumiereSongInput, LumiereStage } from './lumiere';
import { onPlayer, playerState } from './player';
import { createFlowScene } from './flowScene';

let previewPalette:string[]=[];
export function flowCoverPalette():string[]{return [...previewPalette];}

/** Own the playback subscription and canvas only while this effect is visible. */
export type FlowStage = Pick<LumiereStage, 'root' | 'setMode' | 'setSong' | 'activate' | 'deactivate' | 'dispose'> & {setPalette(colors:string[]):void};
export function createFlowStage(): FlowStage {
  const root = document.createElement('div');
  root.className = 'lyrics-stage is-flow';
  let scene: ReturnType<typeof createFlowScene> | null = null;
  let song: LumiereSongInput | null = null;
  let palette:string[]=[];
  let active = false, disposed = false, raf = 0;
  let unsubscribe: (() => void) | null = null;
  let anchor = 0, stamp = 0, playing = false;
  const sync = () => {
    const state = playerState();
    anchor = Number.isFinite(state.positionMs) ? state.positionMs : 0;
    stamp = performance.now(); playing = state.playing;
  };
  const frame = () => {
    raf = 0;
    if (!active || disposed || !scene) return;
    try {
      if (!document.hidden) scene.update(anchor + (playing ? performance.now() - stamp : 0));
      raf = requestAnimationFrame(frame);
    } catch (error) {
      root.classList.add('is-failed');
      root.classList.remove('is-painted', 'is-ready');
      console.error('[flow] 场景更新失败', error);
    }
  };
  const deactivate = () => {
    active = false; cancelAnimationFrame(raf); raf = 0;
    unsubscribe?.(); unsubscribe = null;
    scene?.dispose(); scene = null;
    root.classList.remove('is-on', 'is-ready', 'is-painted');
  };
  return {
    root,
    setPalette(colors) {previewPalette=[...colors];palette=colors;scene?.setPalette(colors);},
    setMode(_mode: LumiereMode) {},
    setSong(input) {
      // Includes word timestamps: replacing a lyric source must refresh the timing map.
      song = input; scene?.setSong(input);
      root.classList.toggle('is-content', !!input);
    },
    activate() {
      if (active || disposed) return;
      active = true; sync(); unsubscribe = onPlayer(sync);
      root.classList.remove('is-failed'); root.classList.add('is-on');
      try {
        scene = createFlowScene(() => root.classList.add('is-ready', 'is-painted'), (error) => {
          root.classList.add('is-failed'); root.classList.remove('is-painted', 'is-ready');
          cancelAnimationFrame(raf); raf = 0;
          console.error('[tempera] 场景初始化失败', error);
        });
        root.append(scene.root); scene.setPalette(palette); scene.setSong(song); scene.resize();
        frame();
      } catch (error) {
        root.classList.add('is-failed'); root.classList.remove('is-painted', 'is-ready');
        console.error('[flow] 场景创建失败', error);
      }
    },
    deactivate,
    dispose() { disposed = true; deactivate(); root.remove(); },
  };
}
