import { onlineArtwork } from '../online/artwork';
import type { OnlineTrack } from '../online/types';
import { h } from './dom';
import type { PlayerState } from './player';

/**
 * 顶部「正在播放 / 即将播放」预告条（单框形态）。
 *
 *   - 一个玻璃胶囊里始终只有一份内容：预告阶段显示「即将播放」的下一首 + 倒计时；
 *   - 切歌后同一个框内切换为「正在播放」并展示新歌曲，约 2.6 秒后收起；
 *   - 内容切换使用淡入淡出，倒计时数字用透明度渐变（不做弹跳）；
 *   - 点击框（预告阶段）立即切到下一首。
 */

export interface UpNextToastHandle {
  readonly element: HTMLDivElement;
  update(state: PlayerState): void;
  dispose(): void;
}

const LEAD_MS = 8_000;
const MIN_REMAIN_MS = 250;
const LINGER_MS = 2_600;
/** 框内内容切换的淡出/写入时序。 */
const SWAP_OUT_MS = 130;

export function createUpNextToast(onSkip: () => void): UpNextToastHandle {
  const cover = h('img', { class: 'unt-cover', alt: '' }) as HTMLImageElement;
  const coverWrap = h('div', { class: 'unt-cover-wrap' }, cover);
  const kicker = h('div', { class: 'unt-kicker', text: '即将播放' });
  const title = h('div', { class: 'unt-title' });
  const meta = h('div', { class: 'unt-meta' });
  const text = h('div', { class: 'unt-text' }, kicker, title, meta);
  const main = h('div', { class: 'unt-main' }, coverWrap, text);
  const seconds = h('div', { class: 'unt-seconds', text: '' });
  const unit = h('span', { class: 'unt-unit', text: '秒后切换' });
  const count = h('div', { class: 'unt-count' }, seconds, unit);
  const fill = h('i', { class: 'unt-progress-fill' });
  const progress = h('div', { class: 'unt-progress' }, fill);
  const element = h('div', { class: 'upnext-toast' }, main, count, progress);
  element.setAttribute('role', 'status');
  element.setAttribute('aria-live', 'polite');
  element.setAttribute('aria-hidden', 'true');

  let visible = false;
  let lastState: PlayerState | null = null;
  let lastTrackKey = '';
  let lastPreviewKey = '';
  let lingerUntil = 0;
  let phase: 'hidden' | 'preview' | 'current' = 'hidden';
  let secondsTarget = '';
  let secondsTimer = 0;
  let swapTimer = 0;
  let kickerTimer = 0;
  let currentSrc = '';
  let contentKey = '';

  const trackKeyOf = (state: PlayerState): string =>
    state.track ? `${state.track.source}:${state.track.id}` : '';

  const setPhase = (nextPhase: 'hidden' | 'preview' | 'current'): void => {
    if (phase === nextPhase) return;
    phase = nextPhase;
    element.classList.toggle('is-current', nextPhase === 'current');
    element.setAttribute(
      'aria-label',
      nextPhase === 'current' ? '正在播放' : nextPhase === 'preview' ? '即将播放下一首' : '',
    );
    if (nextPhase !== 'preview') {
      fill.style.width = '0%';
      window.clearTimeout(secondsTimer);
      seconds.classList.remove('is-fading');
      seconds.textContent = '';
      secondsTarget = '';
    }
  };

  const setSeconds = (value: string): void => {
    if (value === secondsTarget) return;
    secondsTarget = value;
    window.clearTimeout(secondsTimer);
    seconds.classList.add('is-fading');
    secondsTimer = window.setTimeout(() => {
      seconds.textContent = value;
      seconds.classList.remove('is-fading');
    }, 150);
  };

  const setVisible = (nextVisible: boolean): void => {
    if (visible === nextVisible) return;
    visible = nextVisible;
    element.classList.toggle('is-visible', nextVisible);
    element.setAttribute('aria-hidden', nextVisible ? 'false' : 'true');
  };

  /** 在同一个框内淡出→换内容→淡入，避免两个独立框并列。 */
  const swapContent = (track: OnlineTrack | null, label: '即将播放' | '正在播放'): void => {
    if (!track) return;
    const key = `${label}:${track.source}:${track.id}`;
    if (key === contentKey) return;
    contentKey = key;
    window.clearTimeout(swapTimer);
    main.classList.add('is-swapping');
    swapTimer = window.setTimeout(() => {
      kicker.textContent = label;
      const artwork = onlineArtwork(track);
      if (artwork !== currentSrc) {
        currentSrc = artwork;
        if (artwork.length > 0) cover.src = artwork;
        else cover.removeAttribute('src');
      }
      title.textContent = track.title || '未知歌曲';
      const album = (track.album ?? '').trim();
      meta.textContent = album.length > 0 ? `${track.artist || '未知歌手'} · ${album}` : track.artist || '未知歌手';
      main.classList.remove('is-swapping');
    }, SWAP_OUT_MS);
  };

  const upcoming = (state: PlayerState): OnlineTrack | null =>
    state.mode === 'list' ? state.queue[state.index + 1] ?? null : null;

  /** 只把 kicker 文案渐变过去（预告 → 正在播放时，标题/封面是同一个人，不需要整体重播动画）。 */
  const swapKicker = (label: '即将播放' | '正在播放'): void => {
    if (kicker.textContent === label) return;
    window.clearTimeout(kickerTimer);
    kicker.classList.add('is-swapping');
    kickerTimer = window.setTimeout(() => {
      kicker.textContent = label;
      kicker.classList.remove('is-swapping');
    }, 140);
  };

  const enterCurrent = (track: OnlineTrack | null, cameFromPreview: boolean): void => {
    setPhase('current');
    lingerUntil = Date.now() + LINGER_MS;
    if (!track) return;
    const key = `${track.source}:${track.id}`;
    if (cameFromPreview && key === lastPreviewKey) {
      // 预告的那首已经变成当前曲目：原地把「即将播放 + 倒计时」过渡成「正在播放」，不重放整体动画。
      swapKicker('正在播放');
      return;
    }
    swapContent(track, '正在播放');
  };

  const render = (state: PlayerState): void => {
    // 任意方式切歌（自动/手动）都展示一段「正在播放」；首次开始播放不弹出。
    const key = trackKeyOf(state);
    if (key !== lastTrackKey) {
      const hadTrack = lastTrackKey.length > 0;
      const fromPreview = phase === 'preview';
      lastTrackKey = key;
      if (hadTrack && state.track) enterCurrent(state.track, fromPreview);
    }

    if (phase === 'current') {
      if (Date.now() >= lingerUntil) {
        setPhase('hidden');
        setVisible(false);
        return;
      }
      setVisible(true);
      return;
    }

    const previewable =
      state.track && state.playing && !state.loading && state.mode === 'list' ? upcoming(state) : null;
    const remaining = state.durationMs - state.positionMs;
    if (!previewable || remaining > LEAD_MS) {
      setPhase('hidden');
      setVisible(false);
      return;
    }
    // 临近切歌（倒计时读秒结束）时保持同一框可见，等下一帧自然过渡到「正在播放」，
    // 不要先收起再弹出——那样会看起来像两次独立动画。
    if (remaining <= MIN_REMAIN_MS && visible) {
      setSeconds('');
      return;
    }
    if (remaining <= MIN_REMAIN_MS) {
      setPhase('hidden');
      setVisible(false);
      return;
    }

    const previewKey = `${previewable.source}:${previewable.id}`;
    lastPreviewKey = previewKey;
    swapContent(previewable, '即将播放');
    setPhase('preview');
    setSeconds(String(Math.max(1, Math.ceil(remaining / 1000))));
    fill.style.width = `${(Math.min(1, Math.max(0, remaining / LEAD_MS)) * 100).toFixed(1)}%`;
    setVisible(true);
  };

  const timer = window.setInterval(() => {
    if (lastState) render(lastState);
  }, 200);

  const click = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    if (phase === 'preview') onSkip();
  };
  element.addEventListener('click', click);
  element.addEventListener('pointerdown', (event) => event.stopPropagation());

  return {
    element,
    update(state: PlayerState): void {
      lastState = state;
      render(state);
    },
    dispose(): void {
      window.clearInterval(timer);
      window.clearTimeout(secondsTimer);
      window.clearTimeout(swapTimer);
      window.clearTimeout(kickerTimer);
      element.remove();
    },
  };
}
