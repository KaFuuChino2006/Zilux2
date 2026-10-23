/** 在线音乐（网易云 / QQ 音乐）前端类型，与 docs/zilux2-online-music.md 保持一致。 */

// 音质：标准 128k / 高 320k / 无损；平台不支持时宿主会自动降级。
export type StreamQuality = 'standard' | 'high' | 'lossless';

// 来源 id 开放为 string（新增平台只登记，不改类型）：常见平台仍有字面量提示。
export type OnlineSource = 'netease' | 'qq' | 'local' | (string & {});

// 显示名由 online/sources.ts 在宿主返回平台清单后动态填充（含本地音乐）。
export { SOURCE_LABEL } from './sources';

export interface OnlineTrack {
  source: OnlineSource;
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  /** 宿主代理后的绝对 URL（可能为空串） */
  cover: string;
  playable: boolean;
  /** 需要 VIP / 购买才能播放；null/undefined 表示上游未给出 */
  vip?: boolean | null;
  /** 本地 CUE 分轨：在整轨镜像文件里的起始秒（0 表示整个文件） */
  startAt?: number;
}

export interface OnlineSearchResult {
  source: OnlineSource;
  query: string;
  tracks: OnlineTrack[];
  tookMs?: number;
}

export interface OnlineLyric {
  source: OnlineSource;
  id: string;
  lrc: string;
  translation: string | null;
  hasTranslation: boolean;
  /** 逐字歌词原文（QRC 解密后同构：`[start,dur](start,dur)字…`），可空 */
  yrc?: string | null;
  hasYrc?: boolean;
  /** QQ QRC 加密十六进制（需要 qrc-decoder 解密），可空 */
  qrc?: string | null;
  hasQrc?: boolean;
}

export interface OnlineInfo {
  port: number;
  token: string;
  sources: OnlineSource[];
}
