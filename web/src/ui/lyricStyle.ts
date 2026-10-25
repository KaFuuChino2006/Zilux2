/**
 * 歌词播放样式：只作用于「播放效果 = 关闭」时默认 DOM 歌词页（纯字 / 房间由 canvas 画字，不受影响）。
 *
 * 经典 = 现状；发光 = 当前行与已唱歌词带主题色辉光；渐变 = 当前行字面走主题色渐变；
 * 频谱律动 = 页面底部随节拍跳动的频谱条（用播放器频谱分析器驱动，见 lyrics.ts 的 spectrum 循环）。
 */

export type LyricStyle = 'classic' | 'glow' | 'gradient' | 'spectrum';

const STORE_KEY = 'zilux2.lyricStyle';

export const LYRIC_STYLES: Array<{ id: LyricStyle; label: string; hint: string }> = [
  { id: 'classic', label: '经典', hint: '默认样式：当前行放大，远处歌词逐行淡出' },
  { id: 'glow', label: '发光', hint: '当前行与已唱的字带主题色辉光，像灯牌在暗处发亮' },
  { id: 'gradient', label: '渐变', hint: '当前行字面沿主题色渐变，随换行流动' },
  { id: 'spectrum', label: '频谱律动', hint: '页面底部随歌节拍跳动的频谱条，背景随低频起伏' },
];

function readLyricStyle(): LyricStyle {
  try {
    const value = window.localStorage.getItem(STORE_KEY);
    if (value === 'classic' || value === 'glow' || value === 'gradient' || value === 'spectrum') {
      return value;
    }
  } catch {
    // ignore
  }
  return 'classic';
}

let current: LyricStyle = readLyricStyle();

const listeners = new Set<() => void>();

/** 当前歌词播放样式（快捷设置里展示用）。 */
export function lyricStyle(): LyricStyle {
  return current;
}

/** 修改歌词播放样式；歌词页开着时立即生效（不重载歌词）。 */
export function setLyricStyle(style: LyricStyle): void {
  if (style === current) return;
  current = style;
  try {
    window.localStorage.setItem(STORE_KEY, style);
  } catch {
    // ignore
  }
  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      console.warn('[lyrics] lyric style listener failed', error);
    }
  }
}

/** 订阅样式变化（lyrics.ts 用它给打开的歌词页换样式）。 */
export function onLyricStyle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
