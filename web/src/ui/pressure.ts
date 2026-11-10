import type { LumiereSongInput } from './lumiere';
import { playbackAnalyser } from '../core/audioTap';
import { getSettings } from '../core/settings';
import { onPlayer, playerState } from './player';
import { createPressureScene } from './pressureScene';

export type PressureStage = ReturnType<typeof createPressureStage>;

export function createPressureStage() {
  const root = document.createElement('div'); root.className = 'lyrics-stage is-pressure';
  let scene: ReturnType<typeof createPressureScene> | null = null;
  let song: LumiereSongInput | null = null;
  let active = false, disposed = false, raf = 0, anchor = 0, stamp = 0, playing = false, lastFrame = 0;
  let unsubscribe: (() => void) | null = null;
  let analyser: AnalyserNode | null = null, bins: Uint8Array<ArrayBuffer> | null = null, power = 0;
  const sync = () => {
    const state = playerState(); anchor = state.positionMs; stamp = performance.now(); playing = state.playing;
  };
  function deactivate() {
    active = false; cancelAnimationFrame(raf); raf = 0; unsubscribe?.(); unsubscribe = null;
    scene?.dispose(); scene = null; analyser = null; bins = null; power = 0;
    root.classList.remove('is-on', 'is-ready', 'is-painted');
  }
  const frame = (now: number) => {
    raf = 0; if (!active || disposed) return;
    const dt = Math.min(100, Math.max(0, now - lastFrame)); lastFrame = now;
    try {
      if (!document.hidden && scene) {
        if (playing) {
          const node = getSettings().playback.audioReactive ? playbackAnalyser() : null;
          if (node !== analyser) { analyser = node; bins = node ? new Uint8Array(new ArrayBuffer(node.frequencyBinCount)) : null; }
          let target = 0;
          if (analyser && bins) {
            analyser.getByteFrequencyData(bins);
            const hz = analyser.context.sampleRate / analyser.fftSize;
            const lo = Math.max(1, Math.floor(40 / hz)), hi = Math.min(bins.length - 1, Math.ceil(200 / hz));
            for (let i = lo; i <= hi; i++) target += bins[i] / 255;
            target /= Math.max(1, hi - lo + 1);
          }
          power += (target - power) * (1 - Math.exp(-dt / (target > power ? 45 : 160)));
        }
        const duration = playerState().durationMs, position = anchor + (playing ? now - stamp : 0);
        scene.update(duration > 0 ? Math.min(duration, position) : position, power);
        root.classList.add('is-ready', 'is-painted');
      }
      raf = requestAnimationFrame(frame);
    } catch (error) {
      console.error('[pressure] render failed', error); root.classList.add('is-failed');
      unsubscribe?.(); unsubscribe = null;
    }
  };
  return {
    root,
    setSong(input: LumiereSongInput | null) { song = input; scene?.setSong(input); root.classList.toggle('is-content', !!input); },
    activate() {
      if (active || disposed) return;
      active = true; root.classList.remove('is-failed'); root.classList.add('is-on');
      try {
        scene = createPressureScene(); root.append(scene.root); scene.setSong(song);
        sync(); lastFrame = performance.now(); unsubscribe = onPlayer(sync); frame(lastFrame);
      } catch (error) { console.error('[pressure] initialization failed', error); root.classList.add('is-failed'); }
    },
    deactivate,
    dispose() { disposed = true; deactivate(); root.remove(); },
  };
}
