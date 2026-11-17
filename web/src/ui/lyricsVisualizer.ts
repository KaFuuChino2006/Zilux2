/**
 * 歌词页的音频可视化（第 77 轮 C 的可视化从壁纸挪到歌词效果里）。
 *
 * 为什么挪：壁纸层现在是「整块铺满的 <video> + 一层压暗」，可视化叠在上面既抢画面，
 * 又只能在壁纸页看到；而歌词页本来就是「音乐 + 画面」的场景，把它挂在那里才对。
 *
 * 与「歌词样式」（classic / rise / wave / swing / typewriter / spin）正交 ——
 * 六种字幕动效都能各自配任意一种可视化，因此这里是独立的一份偏好，
 * 存在 localStorage 里，不进宿主设置。
 */

import { WallpaperVisualizer } from './wallpaperVisualizer';

export type LyricVisualStyle = 'off' | 'spectrum' | 'wave' | 'ring' | 'particles';

const STORE_KEY = 'zilux2.lyricVisualizer';
const PREFS_KEY = 'zilux2.lyricVisualizerPrefs';

/**
 * 可视化细节（第 xx 轮）：条带高度 / 柱数 / 不透明度 / 与播放条的间距。
 * 与样式分开存，切样式不会把这些调参重置。
 */
export interface LyricVisualPrefs {
  /** 条带高度，占可用高度的百分比（8–45） */
  height: number;
  /** 频谱柱数（16–128） */
  bars: number;
  /** 不透明度百分比（20–100） */
  opacity: number;
  /** 与播放条上沿的额外间距（0–80px） */
  gap: number;
}

export const LYRIC_VIS_DEFAULT_PREFS: LyricVisualPrefs = { height: 32, bars: 64, opacity: 100, gap: 10 };
export const LYRIC_VIS_LIMITS = {
  height: { min: 8, max: 45 },
  bars: { min: 16, max: 128 },
  opacity: { min: 20, max: 100 },
  gap: { min: 0, max: 80 },
} as const;

function clampPref(key: keyof LyricVisualPrefs, value: number): number {
  const limit = LYRIC_VIS_LIMITS[key];
  return Math.min(limit.max, Math.max(limit.min, Math.round(value)));
}

export function lyricVisualPrefs(): LyricVisualPrefs {
  const fallback = { ...LYRIC_VIS_DEFAULT_PREFS };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<LyricVisualPrefs>;
    for (const key of Object.keys(fallback) as Array<keyof LyricVisualPrefs>) {
      const value = Number(parsed[key]);
      if (Number.isFinite(value)) fallback[key] = clampPref(key, value);
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function setLyricVisualPrefs(patch: Partial<LyricVisualPrefs>): LyricVisualPrefs {
  const next = { ...lyricVisualPrefs() };
  for (const key of Object.keys(next) as Array<keyof LyricVisualPrefs>) {
    const value = Number(patch[key]);
    if (Number.isFinite(value)) next[key] = clampPref(key, value);
  }
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    /* 存储不可用就只在本次会话生效 */
  }
  shared?.apply();
  for (const listener of listeners) listener();
  return next;
}

export const LYRIC_VIS_STYLES: Array<{ id: LyricVisualStyle; label: string; hint: string }> = [
  { id: 'off', label: '关闭', hint: '歌词页不叠加音频可视化。' },
  { id: 'spectrum', label: '频谱', hint: '底部排一排随音乐跳动的竖条。' },
  { id: 'wave', label: '波形', hint: '底部一条跟随声音起伏的波形线。' },
  { id: 'ring', label: '圆环', hint: '以画面中心向外发散的圆环。' },
  { id: 'particles', label: '粒子', hint: '低频推动的上升粒子，鼓点上爆开。' },
];

const listeners = new Set<() => void>();

function isStyle(value: string | null): value is LyricVisualStyle {
  return value === 'off' || value === 'spectrum' || value === 'wave' || value === 'ring' || value === 'particles';
}

export function lyricVisualStyle(): LyricVisualStyle {
  try {
    const value = window.localStorage.getItem(STORE_KEY);
    return isStyle(value) ? value : 'off';
  } catch {
    return 'off';
  }
}

export function setLyricVisualStyle(style: LyricVisualStyle): void {
  try {
    window.localStorage.setItem(STORE_KEY, style);
  } catch {
    /* 存储不可用就只在本次会话生效 */
  }
  shared?.apply();
  for (const listener of listeners) listener();
}

export function onLyricVisualStyle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 单例：可视化只该有一份，切页不重建。 */
class LyricVisualizer {
  private readonly root: HTMLDivElement;
  private readonly visualizer: WallpaperVisualizer;
  private started = false;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'lyric-vis';
    this.visualizer = new WallpaperVisualizer();
    this.root.append(this.visualizer.element);
    document.body.append(this.root);

    window.addEventListener('resize', () => this.resize());
    // 只在歌词页可见时跑动画：.app 的 class 由页面自己切，观察 body 子树最稳（.app 可能晚于这里挂载）。
    new MutationObserver(() => this.syncRunning()).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    this.resize();
    this.apply();
  }

  apply(): void {
    const style = lyricVisualStyle();
    const prefs = lyricVisualPrefs();
    this.visualizer.configure(style !== 'off', style === 'off' ? 'spectrum' : style);
    this.visualizer.setTuning({
      bars: prefs.bars,
      heightRatio: prefs.height / 100,
      opacity: prefs.opacity / 100,
      bottomInset: this.bottomInset(prefs.gap),
    });
    this.root.dataset.style = style;
    this.syncRunning();
  }

  /**
   * 播放条占掉的高度 + 用户间距：条带贴在这之上，不再和播放条重叠。
   * 播放条是 fixed 的，用它的 top 到视口底部算出「让位区」。
   */
  private bottomInset(gap: number): number {
    const bar = document.querySelector<HTMLElement>('.playerbar');
    if (!bar) return gap;
    const rect = bar.getBoundingClientRect();
    const occupied = Math.max(0, window.innerHeight - rect.top);
    return Math.round(occupied + gap);
  }

  private resize(): void {
    const prefs = lyricVisualPrefs();
    this.visualizer.setTuning({ bottomInset: this.bottomInset(prefs.gap) });
    this.visualizer.resize(window.innerWidth, window.innerHeight);
  }

  private syncRunning(): void {
    const open = document.querySelector('.app.is-lyrics-open') !== null;
    const want = open && lyricVisualStyle() !== 'off';
    if (want === this.started) return;
    this.started = want;
    this.root.classList.toggle('is-active', want);
    if (want) {
      this.resize();
      this.visualizer.start();
    } else {
      this.visualizer.stop();
    }
  }
}

let shared: LyricVisualizer | null = null;

/** 幂等：main.ts 里调一次即可。 */
export function startLyricVisualizer(): void {
  shared ??= new LyricVisualizer();
}
