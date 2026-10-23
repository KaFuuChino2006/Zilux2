/**
 * 实验来源开关（前端侧）。
 *
 * 实验来源默认完全不可见：不出现在搜索分段、默认平台、账号、收藏、推荐里。
 * 用户必须在「设置 → 实验功能」里显式开启，并确认风险后，其它页面才会出现它。
 */

export interface ExperimentalSourceInfo {
  id: string;
  label: string;
  summary: string;
  /** 开启前展示的风险条款（每条一行） */
  risks: string[];
  /** 二次确认文案 */
  confirm: string;
}

export const EXPERIMENTAL_SOURCES: Record<string, ExperimentalSourceInfo> = {
  mvmp3: {
    id: 'mvmp3',
    label: '无名音乐',
    summary: '第三方聚合试听站（mvmp3.com），能搜到一些其它平台没有的歌，但稳定性无法保证。',
    risks: [
      '接口来自第三方站点 mvmp3.com，非官方开放接口，随时可能失效、改版或被封禁。',
      '音频直链来自酷我 CDN：部分歌曲没有可用地址或播放失败，音质/速度不稳定。',
      '歌词与封面由该站抓取，可能与歌曲不匹配；不提供逐字歌词。',
      '版权与合规风险由使用者自行承担：仅供个人测试/试听，请勿传播、重新分发或用于商业用途。',
      '该来源的数据不参与最近播放、我喜欢的音乐、每日推荐与听歌排行，与其他平台不互通。',
    ],
    confirm: '确定开启实验来源「无名音乐」吗？\n\n第三方来源随时可能失效，且存在版权风险，请自行判断用途并自行承担后果。',
  },
};

const STORE_PREFIX = 'zilux2.experimental.';

export function experimentalSourceEnabled(id: string): boolean {
  try {
    return window.localStorage.getItem(STORE_PREFIX + id) === '1';
  } catch {
    return false;
  }
}

export function setExperimentalSourceEnabled(id: string, enabled: boolean): void {
  try {
    if (enabled) {
      window.localStorage.setItem(STORE_PREFIX + id, '1');
    } else {
      window.localStorage.removeItem(STORE_PREFIX + id);
    }
  } catch {
    // localStorage 不可用时忽略：本次会话内仍按开关状态生效。
  }
  window.dispatchEvent(new CustomEvent('zilux2:experimental-change', { detail: { id, enabled } }));
}

export function experimentalSourceInfo(id: string): ExperimentalSourceInfo | null {
  return EXPERIMENTAL_SOURCES[id] ?? null;
}

export function experimentalSourceIds(): string[] {
  return Object.keys(EXPERIMENTAL_SOURCES);
}

/** 是否存在需要展示的「实验功能」设置项。 */
export function hasExperimentalSources(): boolean {
  return Object.keys(EXPERIMENTAL_SOURCES).length > 0;
}

/** 处于开启状态的实验来源 id。 */
export function enabledExperimentalSourceIds(): string[] {
  return experimentalSourceIds().filter((id) => experimentalSourceEnabled(id));
}
