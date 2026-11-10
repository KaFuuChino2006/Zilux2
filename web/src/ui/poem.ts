import type { LumiereSongInput } from './lumiere';
import { onPlayer, playerState } from './player';
import { createPoemScene } from './poemScene';

export type PoemStage = ReturnType<typeof createPoemStage>;

export function createPoemStage() {
  const root = document.createElement('div');
  root.className = 'lyrics-stage is-poem';
  let scene: ReturnType<typeof createPoemScene> | null = null;
  let song: LumiereSongInput | null = null, palette: string[] = [];
  let active = false, disposed = false, raf = 0, anchor = 0, stamp = 0, playing = false;
  let ambience = 0, previous = 0, unsubscribe: (() => void) | null = null;
  const sync = () => {
    const state = playerState();
    anchor = state.positionMs; stamp = performance.now(); playing = state.playing;
  };
  const frame = (now: number) => {
    raf = 0;
    if (!active || disposed) return;
    if (playing) ambience += Math.min(100, Math.max(0, now - previous));
    previous = now;
    if (!document.hidden && scene) {
      try {
        const duration = playerState().durationMs;
        const position = anchor + (playing ? now - stamp : 0);
        scene.update(duration > 0 ? Math.min(duration, position) : position, ambience);
        root.classList.add('is-ready', 'is-painted');
      } catch (error) {
        console.error('[poem] render failed', error); root.classList.add('is-failed'); return;
      }
    }
    raf = requestAnimationFrame(frame);
  };
  function deactivate() {
    active = false; cancelAnimationFrame(raf); raf = 0; unsubscribe?.(); unsubscribe = null;
    scene?.dispose(); scene = null;
    root.classList.remove('is-on', 'is-ready', 'is-painted');
  }
  return {
    root,
    setSong(input: LumiereSongInput | null) { song = input; scene?.setSong(input); root.classList.toggle('is-content', !!input); },
    setPalette(colors: string[]) { palette = [...colors]; scene?.setPalette(palette); },
    activate() {
      if (active || disposed) return;
      active = true; root.classList.remove('is-failed'); root.classList.add('is-on');
      try {
        scene = createPoemScene(); root.append(scene.root); scene.setSong(song); scene.setPalette(palette);
        sync(); previous = performance.now(); unsubscribe = onPlayer(sync); frame(previous);
      } catch (error) { console.error('[poem] initialization failed', error); root.classList.add('is-failed'); }
    },
    deactivate,
    dispose() { disposed = true; deactivate(); root.remove(); },
  };
}
