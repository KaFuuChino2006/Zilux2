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

/** 「播放效果」为纯字/房间/唱片/拼合时，「封面在左」属于「关闭」档的样式，不应生效。 */
export const LUMIERE_KEY = 'zilux2.lumiere';

export function lumiereEffectOn(): boolean {
  try {
    const raw = window.localStorage.getItem(LUMIERE_KEY);
    // 与 lumiereMode() 同一套归一化：'off'、旧版 'lightfield' 以及已删除的 'geo'/'pv'/'collage'
    // 都算关闭，其它非空值（text/room/vinyl/flow/poem/pressure）都算开启。两处判定必须一致，
    // 否则旧存档升级后会出现「封面在左被禁用、却没有任何播放效果」。
    return raw !== null && raw !== ''
      && raw !== 'off' && raw !== 'lightfield'
      && raw !== 'geo' && raw !== 'pv' && raw !== 'collage';
  } catch {
    return false;
  }
}

/** 实际生效的封面样式：播放效果开启时一律回落纯壁纸（UI 里的选择保留，关掉效果后恢复）。 */
export function effectiveBgLyricsCoverStyle(): BgLyricsCoverStyle {
  return lumiereEffectOn() ? 'wallpaper' : bgLyricsCoverStyle();
}

export function setBgLyricsCoverStyle(style: BgLyricsCoverStyle): void {
  try {
    window.localStorage.setItem(BG_COVER_KEY, style);
  } catch {
    /* 存储不可用时保持默认样式 */
  }
  window.dispatchEvent(new CustomEvent<BgLyricsCoverStyle>(BG_COVER_EVENT, { detail: style }));
}

/** 封面右侧的模糊强度；背景歌词场景按这个值给 CSS 变量。 */
export type BgLyricsBlurLevel = 'off' | 'soft' | 'medium' | 'strong';
/** 封面右侧之后的背景：渐隐露出壁纸，或直接用模糊封面铺满。 */
export type BgLyricsFillMode = 'edge' | 'fill';

export const BG_BLUR_KEY = 'zilux2.bgLyricsBlur';
export const BG_FILL_KEY = 'zilux2.bgLyricsFill';

/** 关闭效果下歌词页背景图案的亮度（百分数，30–140）。 */
export const BG_BRIGHTNESS_KEY = 'zilux2.bgLyricsBrightness';
export const BG_BRIGHTNESS_MIN = 30;
export const BG_BRIGHTNESS_MAX = 140;
const BG_BRIGHTNESS_DEFAULT = 92;

export function bgLyricsBrightness(): number {
  try {
    const raw = Number(window.localStorage.getItem(BG_BRIGHTNESS_KEY));
    if (Number.isFinite(raw) && raw >= BG_BRIGHTNESS_MIN && raw <= BG_BRIGHTNESS_MAX) return raw;
  } catch {
    /* 存储不可用时用默认值 */
  }
  return BG_BRIGHTNESS_DEFAULT;
}

export function setBgLyricsBrightness(percent: number): void {
  const next = Math.min(BG_BRIGHTNESS_MAX, Math.max(BG_BRIGHTNESS_MIN, Math.round(percent)));
  try {
    window.localStorage.setItem(BG_BRIGHTNESS_KEY, String(next));
  } catch {
    /* 存储不可用时仍让当前页面即时生效 */
  }
  window.dispatchEvent(new CustomEvent<BgLyricsCoverStyle>(BG_COVER_EVENT, { detail: bgLyricsCoverStyle() }));
}

export const BG_BLUR_PX: Record<BgLyricsBlurLevel, number> = {
  off: 0,
  soft: 20,
  medium: 44,
  strong: 64,
};

export function bgLyricsBlurLevel(): BgLyricsBlurLevel {
  try {
    const raw = window.localStorage.getItem(BG_BLUR_KEY);
    return raw === 'off' || raw === 'soft' || raw === 'strong' ? raw : 'medium';
  } catch {
    return 'medium';
  }
}

export function setBgLyricsBlurLevel(level: BgLyricsBlurLevel): void {
  try {
    window.localStorage.setItem(BG_BLUR_KEY, level);
  } catch {
    /* 存储不可用时保持默认 */
  }
  window.dispatchEvent(new CustomEvent<BgLyricsCoverStyle>(BG_COVER_EVENT, { detail: bgLyricsCoverStyle() }));
}

export function bgLyricsFillMode(): BgLyricsFillMode {
  try {
    return window.localStorage.getItem(BG_FILL_KEY) === 'fill' ? 'fill' : 'edge';
  } catch {
    return 'edge';
  }
}

export function setBgLyricsFillMode(mode: BgLyricsFillMode): void {
  try {
    window.localStorage.setItem(BG_FILL_KEY, mode);
  } catch {
    /* 存储不可用时保持默认 */
  }
  window.dispatchEvent(new CustomEvent<BgLyricsCoverStyle>(BG_COVER_EVENT, { detail: bgLyricsCoverStyle() }));
}
