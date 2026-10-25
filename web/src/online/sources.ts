/**
 * 多平台登记表（前端侧）。
 *
 * 新增一个音乐 App（例如酷狗）时页面不需要改：宿主 `GET /api/sources` 会返回平台描述，
 * 这里把它们转成统一的 `SourceDescriptor`，登录卡、搜索分段、默认音源下拉都据此动态渲染。
 * 宿主不可用（本地预览 / mock）时用下方 DEFAULT_SOURCES 兜底。
 */

import { experimentalSourceEnabled } from './experimental';

export interface SourceQuality {
  /** 与 /api/stream?quality= 的取值一致 */
  id: string;
  label: string;
  detail: string;
}

export interface SourceDescriptor {
  id: string;
  label: string;
  /** 单字标识（角标、头像占位） */
  short: string;
  /** 平台主色，用于登录卡渐变与角标 */
  accent: string;  /** code = 平台内扫码后轮询；image = 直接给一张二维码图片；cookie = 粘贴浏览器 Cookie 导入 */
  loginMode: 'code' | 'image' | 'cookie' | '';
  loginHint: string;
  feedKinds: string[];
  supportsWordLyrics: boolean;
  supportsLikedWrite: boolean;
  hasDaily30: boolean;
  /** 平台可选音质（宿主下发）；缺省时用通用三档 */
  qualities: SourceQuality[];
  /** 隐藏平台：只用于歌词搜索/匹配，不出现在搜索、登录、收藏、推荐里 */
  hidden?: boolean;
  /** 实验平台：用户没在设置里显式开启前，任何页面都不显示 */
  experimental?: boolean;
}

const DEFAULT_QUALITIES: SourceQuality[] = [
  { id: 'standard', label: '标准', detail: '128 kbps · MP3' },
  { id: 'high', label: '高', detail: '320 kbps · MP3' },
  { id: 'lossless', label: '无损', detail: 'FLAC · 需会员' },
];

const DEFAULT_SOURCES: SourceDescriptor[] = [
  {
    id: 'netease',
    label: '网易云音乐',
    short: '网',
    accent: '#ff5a5f',
    loginMode: 'code',
    loginHint: '在网易云 App 扫码后确认登录',
    feedKinds: ['recent', 'daily', 'radar'],
    supportsWordLyrics: true,
    supportsLikedWrite: true,
    hasDaily30: false,
    qualities: [
      { id: 'standard', label: '标准', detail: '128 kbps · MP3' },
      { id: 'high', label: '极高', detail: '320 kbps · MP3' },
      { id: 'lossless', label: '无损', detail: 'FLAC · 需会员' },
    ],
  },
  {
    id: 'qq',
    label: 'QQ 音乐',
    short: 'Q',
    accent: '#31c27c',
    loginMode: 'image',
    loginHint: '打开手机 QQ 扫一扫，用 QQ 账号登录',
    feedKinds: ['recent', 'daily'],
    supportsWordLyrics: true,
    supportsLikedWrite: true,
    hasDaily30: true,
    qualities: [
      { id: 'standard', label: '标准', detail: '128 kbps · MP3' },
      { id: 'high', label: '高', detail: '320 kbps · MP3' },
      { id: 'lossless', label: '无损', detail: 'FLAC · 需会员' },
    ],
  },
  {
    id: 'kugou',
    label: '酷狗音乐',
    short: '酷',
    accent: '#2fb0ff',
    loginMode: 'image',
    loginHint: '仅用于歌词搜索',
    feedKinds: [],
    supportsWordLyrics: true,
    supportsLikedWrite: false,
    hasDaily30: false,
    qualities: [],
    hidden: true,
  },
];

/** 显示名映射：`SOURCE_LABEL[source]` 兼容旧写法，宿主返回后会被重填。 */
export const SOURCE_LABEL: Record<string, string> = {
  netease: '网易云',
  qq: 'QQ 音乐',
  local: '本地',
};

let current: SourceDescriptor[] = DEFAULT_SOURCES.map((item) => ({ ...item }));

function applyLabels(list: SourceDescriptor[]): void {
  for (const item of list) {
    SOURCE_LABEL[item.id] = item.id === 'qq' ? item.label : item.label.replace(/音乐$/, '');
  }
}

applyLabels(current);

/** 用宿主返回的平台描述覆盖本地兜底（字段缺失会被补齐）。 */
export function initSourceDescriptors(list: SourceDescriptor[] | null | undefined): void {
  if (!Array.isArray(list) || list.length === 0) return;
  current = list.map((input) => {
    const fallback = DEFAULT_SOURCES.find((item) => item.id === input.id) ?? {
      id: input.id,
      label: input.id,
      short: input.id.slice(0, 1).toUpperCase(),
      accent: '#d9c08d',
      loginMode: 'image' as const,
      loginHint: '登录后同步收藏与推荐',
      feedKinds: [],
      supportsWordLyrics: false,
      supportsLikedWrite: false,
      hasDaily30: false,
      qualities: DEFAULT_QUALITIES,
      hidden: false,
    };
    return {
      ...fallback,
      ...input,
      id: input.id,
      loginMode: input.loginMode === 'code' ? 'code' : input.loginMode === 'cookie' ? 'cookie' : input.loginMode === '' ? '' : 'image',
      feedKinds: Array.isArray(input.feedKinds) && input.feedKinds.length > 0 ? input.feedKinds : fallback.feedKinds,
      qualities: Array.isArray(input.qualities) && input.qualities.length > 0 ? input.qualities : fallback.qualities,
      hidden: input.hidden === true || fallback.hidden === true,
      experimental: input.experimental === true || fallback.experimental === true,
    };
  });
  applyLabels(current);
}

/** 平台是否应该出现在页面上：隐藏平台永远不出现，实验平台要用户显式开启。 */
export function sourceVisible(id: string): boolean {
  const item = current.find((entry) => entry.id === id);
  if (!item) return false;
  if (item.hidden === true) return false;
  if (item.experimental === true && !experimentalSourceEnabled(item.id)) return false;
  return true;
}

export function sourceDescriptors(): SourceDescriptor[] {
  return current.slice();
}

/** 可见平台 id 列表（按宿主登记顺序）。 */
export function sourceIds(): string[] {
  return current.filter((item) => item.hidden !== true && (item.experimental !== true || experimentalSourceEnabled(item.id))).map((item) => item.id);
}

/** 可用于歌词搜索/匹配的平台 id（包含隐藏平台，例如酷狗；实验平台仅在开启后参与）。 */
export function lyricSourceIds(): string[] {
  return current.filter((item) => item.experimental !== true || experimentalSourceEnabled(item.id)).map((item) => item.id);
}

/** 可登录的平台 id。 */
export function accountSourceIds(): string[] {
  return current
    .filter((item) => item.hidden !== true && item.loginMode !== '')
    .filter((item) => item.experimental !== true || experimentalSourceEnabled(item.id))
    .map((item) => item.id);
}

export function sourceMeta(id: string): SourceDescriptor {
  return (
    current.find((item) => item.id === id) ?? {
      id,
      label: id,
      short: id.slice(0, 1).toUpperCase(),
      accent: '#d9c08d',
      loginMode: 'image',
      loginHint: '登录后同步收藏与推荐',
      feedKinds: [],
      supportsWordLyrics: false,
      supportsLikedWrite: false,
      hasDaily30: false,
      qualities: DEFAULT_QUALITIES,
      hidden: false,
    }
  );
}

export function sourceLoginMode(id: string): 'code' | 'image' | 'cookie' | '' {
  return sourceMeta(id).loginMode;
}

export function sourceHasDaily30(id: string): boolean {
  return sourceMeta(id).hasDaily30;
}

export function sourceSupportsLikedWrite(id: string): boolean {
  return sourceMeta(id).supportsLikedWrite;
}

/** 平台可选音质；宿主没下发时回退通用三档。 */
export function sourceQualities(id: string): SourceQuality[] {
  const list = sourceMeta(id).qualities;
  return list && list.length > 0 ? list.slice() : DEFAULT_QUALITIES.map((item) => ({ ...item }));
}

/** 该平台是否支持切换音质（只有一档 = 跟随平台默认，不显示切换）。 */
export function sourceSupportsQualitySwitch(id: string): boolean {
  return sourceQualities(id).length > 1;
}
