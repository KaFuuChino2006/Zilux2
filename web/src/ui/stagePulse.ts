import { cachedAnalysis } from '../online/analysis';
import { playerState } from './player';

const SECTION_GLOW: Record<string, number> = {
  intro: 0.1,
  outro: 0.08,
  climax: 0.48,
};

/**
 * 结构驱动的舞台光效：用宿主分析出的段落（intro/climax/outro）和强拍位置，
 * 让背景光晕随「歌曲结构」变化，而不是只跟着音量抖。
 */
export function installStagePulse(target: HTMLElement): void {
  const el = document.createElement('div');
  el.className = 'stage-pulse';
  target.append(el);

  let frame = 0;
  let lastPaint = 0;
  let currentKey = '';
  let barMs = 2400;

  const paint = (time: number): void => {
    frame = requestAnimationFrame(paint);
    if (time - lastPaint < 33) return; // ~30fps
    lastPaint = time;

    const state = playerState();
    const analysis = state.track ? cachedAnalysis(state.track)?.analysis : null;
    const key = state.track ? `${state.track.source}:${state.track.id}` : '';
    if (key !== currentKey) {
      currentKey = key;
      const bpm = analysis?.bpm ?? 100;
      barMs = (60000 / Math.max(50, Math.min(220, bpm))) * 4;
    }
    if (!state.playing || !analysis) {
      el.style.opacity = '0';
      document.documentElement.dataset.stage = 'idle';
      return;
    }
    document.documentElement.dataset.stage = 'live';

    let base = 0.18;
    const section = (analysis.sections ?? []).find(
      (item) => state.positionMs >= item.startMs && state.positionMs < item.endMs,
    );
    if (section?.label) base = SECTION_GLOW[section.label] ?? 0.22;

    // 强拍脉冲：距最近强拍越近越亮，随小节内位置衰减。
    let pulse = 0;
    const downbeats = analysis.downbeats ?? [];
    if (downbeats.length > 0) {
      let lo = 0;
      let hi = downbeats.length - 1;
      let at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (downbeats[mid] <= state.positionMs) {
          at = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (at >= 0) {
        const since = state.positionMs - downbeats[at];
        if (since >= 0 && since < barMs) pulse = Math.max(0, 1 - since / barMs);
      }
    }

    const glow = Math.min(0.86, base + pulse * 0.34);
    el.style.opacity = glow.toFixed(3);
  };

  frame = requestAnimationFrame(paint);
  window.addEventListener('beforeunload', () => cancelAnimationFrame(frame));
}
