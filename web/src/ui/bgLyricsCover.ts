/**
 * 「封面在左」布局样式（软件内歌词页 + 桌面背景歌词共用）。
 *
 * 不落宿主设置：样式属于观感偏好，两个页面同源共享 localStorage 即可，
 * 主窗口改完立刻派发事件，软件内歌词页当场生效；背景窗口靠 storage 事件同步。
 */
export type BgLyricsCoverStyle = 'wallpaper' | 'cover';

export const BG_COVER_KEY = 'zilux2.bgLyricsCover';
/** 同窗口内的样式变更事件（storage 事件不会在写入方自己身上触发）。 */
export const BG_COVER_EVENT = 'zilux2:bg-cover-style';

export function bgLyricsCoverStyle(): BgLyricsCoverStyle {
  try {
    return window.localStorage.getItem(BG_COVER_KEY) === 'cover' ? 'cover' : 'wallpaper';
  } catch {
    return 'wallpaper';
  }
}

export function setBgLyricsCoverStyle(style: BgLyricsCoverStyle): void {
  try {
    window.localStorage.setItem(BG_COVER_KEY, style);
  } catch {
    /* 存储不可用时保持默认样式 */
  }
  window.dispatchEvent(new CustomEvent<BgLyricsCoverStyle>(BG_COVER_EVENT, { detail: style }));
}
