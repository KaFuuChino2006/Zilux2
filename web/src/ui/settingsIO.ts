/**
 * 设置导入 / 导出 + 本地缓存清理（桌面端小工具）。
 *
 * - 导出：把 `Settings` 包成信封 `{ app, kind, version, exportedAt, settings }` 下载为 JSON。
 * - 导入：文件选择 → JSON 解析 → `normalizeSettings` 白名单校验兜底；缺失段 / 未知字段 / 版本差异写进 warnings。
 * - 清缓存：只清「可重新生成的纯缓存键」（见 LOCAL_CACHE_KEYS / LOCAL_CACHE_PREFIXES），
 *   不碰设置镜像、主题、歌词偏移、搜索历史、自定义预设等用户数据。
 * - 应用导入结果的动作交给 Lead（通常 `patchSettings(result.settings)` 后重建设置页）。
 */
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from '../core/settings';
import { h, icon, toast } from './dom';

export const SETTINGS_EXPORT_APP = 'Zilux2';
export const SETTINGS_EXPORT_KIND = 'zilux2-settings';
export const SETTINGS_EXPORT_VERSION = 1;

export interface SettingsExportEnvelope {
  app: typeof SETTINGS_EXPORT_APP;
  kind: typeof SETTINGS_EXPORT_KIND;
  version: number;
  /** ISO 时间字符串。 */
  exportedAt: string;
  settings: Settings;
}

export type SettingsSection = Exclude<keyof Settings, 'version'>;

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  'general',
  'appearance',
  'playback',
  'shortcuts',
  'downloads',
  'updates',
];

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */

/** 构建设置导出信封。 */
export function buildSettingsExport(settings: Settings, exportedAt: Date = new Date()): SettingsExportEnvelope {
  return {
    app: SETTINGS_EXPORT_APP,
    kind: SETTINGS_EXPORT_KIND,
    version: SETTINGS_EXPORT_VERSION,
    exportedAt: exportedAt.toISOString(),
    settings,
  };
}

/** 序列化为带 2 空格缩进的 JSON 文本。 */
export function settingsToJson(settings: Settings): string {
  return JSON.stringify(buildSettingsExport(settings), null, 2);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** 导出文件名：`zilux2-settings-20261025-1307.json`（本地时间）。 */
export function settingsExportFilename(date: Date = new Date()): string {
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(
    date.getHours(),
  )}${pad2(date.getMinutes())}`;
  return `zilux2-settings-${stamp}.json`;
}

/** 触发浏览器下载，返回实际使用的文件名。 */
export function exportSettingsToFile(settings: Settings, filename?: string): string {
  const name = filename ?? settingsExportFilename();
  const blob = new Blob([settingsToJson(settings)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  return name;
}

/* ------------------------------------------------------------------ */
/* 导入                                                                */
/* ------------------------------------------------------------------ */

export interface ImportSettingsResult {
  ok: boolean;
  /** 用户取消了文件选择。 */
  canceled?: boolean;
  /** 解析成功后的规范化设置。 */
  settings?: Settings;
  /** 失败原因。 */
  error?: string;
  /** 文件中缺失的设置段（已用默认值补齐）。 */
  missingSections: SettingsSection[];
  /** 文件中被忽略的未知字段（`section.key` 形式）。 */
  ignoredFields: string[];
  /** 面向用户的提示（版本差异 / 缺段 / 未知字段）。 */
  warnings: string[];
}

function emptyImportResult(): ImportSettingsResult {
  return { ok: false, missingSections: [], ignoredFields: [], warnings: [] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 解析设置 JSON 文本（兼容导出信封和裸设置对象），失败返回 `{ ok: false, error }`。
 * 成功后 `settings` 一定经过 `normalizeSettings`，非法字段回落默认值。
 */
export function parseSettingsJson(text: string): ImportSettingsResult {
  const result = emptyImportResult();
  const trimmed = text.trim();
  if (!trimmed) {
    result.error = '文件内容为空';
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    result.error = `不是有效的 JSON：${errorText(err)}`;
    return result;
  }

  const root = asRecord(parsed);
  if (!root) {
    result.error = '设置文件的顶层不是 JSON 对象';
    return result;
  }

  const nested = asRecord(root.settings);
  const raw: Record<string, unknown> = nested ?? root;
  const envelopeVersion: unknown = nested ? root.version : null;

  const sectionCount = SETTINGS_SECTIONS.filter((section) => asRecord(raw[section]) !== null).length;
  if (sectionCount === 0) {
    result.error = `文件里没有可识别的设置段（${SETTINGS_SECTIONS.join(' / ')}）`;
    return result;
  }

  if (envelopeVersion !== null && envelopeVersion !== SETTINGS_EXPORT_VERSION) {
    result.warnings.push(
      `导出文件版本为 ${String(envelopeVersion)}，已按当前 v${SETTINGS_EXPORT_VERSION} 兼容导入`,
    );
  }

  for (const section of SETTINGS_SECTIONS) {
    if (asRecord(raw[section]) === null) result.missingSections.push(section);
  }
  if (result.missingSections.length > 0) {
    result.warnings.push(`缺少 ${result.missingSections.join('、')} 段，已用默认值补齐`);
  }

  for (const section of SETTINGS_SECTIONS) {
    const data = asRecord(raw[section]);
    if (!data) continue;
    const defaults = DEFAULT_SETTINGS[section] as unknown as Record<string, unknown>;
    for (const key of Object.keys(data)) {
      if (!(key in defaults)) result.ignoredFields.push(`${section}.${key}`);
    }
  }
  if (result.ignoredFields.length > 0) {
    result.warnings.push(`已忽略 ${result.ignoredFields.length} 个未知字段`);
  }

  result.ok = true;
  result.settings = normalizeSettings(raw);
  return result;
}

/** 打开文件选择框并读取 / 解析设置文件；用户取消时返回 `{ ok: false, canceled: true }`。 */
export function importSettingsFromFile(): Promise<ImportSettingsResult> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';

    let settled = false;
    const finish = (result: ImportSettingsResult): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onWindowFocus, true);
      input.remove();
      resolve(result);
    };
    const canceledResult = (): ImportSettingsResult => {
      const canceled = emptyImportResult();
      canceled.canceled = true;
      return canceled;
    };
    // 部分环境下没有 input 的 cancel 事件：窗口重新获得焦点后延迟检查是否真的没选文件。
    const onWindowFocus = (): void => {
      window.setTimeout(() => {
        if (settled) return;
        if (!input.files || input.files.length === 0) finish(canceledResult());
      }, 800);
    };

    input.addEventListener('cancel', () => finish(canceledResult()));
    input.addEventListener('change', () => {
      const file = input.files && input.files.length > 0 ? input.files[0] : null;
      if (!file) {
        finish(canceledResult());
        return;
      }
      file
        .text()
        .then((text) => finish(parseSettingsJson(text)))
        .catch((err) => {
          const failed = emptyImportResult();
          failed.error = `读取文件失败：${errorText(err)}`;
          finish(failed);
        });
    });

    window.addEventListener('focus', onWindowFocus, true);
    document.body.append(input);
    input.click();
  });
}

/* ------------------------------------------------------------------ */
/* 本地缓存清理                                                        */
/* ------------------------------------------------------------------ */

export interface LocalCacheKey {
  key: string;
  label: string;
}

/**
 * 默认可清空的纯缓存键（重新生成即可，丢了不心疼）。
 * 注意：不包含 zilux2.settings / theme / accentColor / lyricOffsets / 搜索历史 / 自定义 EQ 预设等用户数据。
 */
export const LOCAL_CACHE_KEYS: readonly LocalCacheKey[] = [
  { key: 'zilux2.appBgImage', label: '自定义背景图片' },
  { key: 'zilux2.analysisDemo', label: '音频分析演示缓存' },
  { key: 'zilux2.qualityBySource', label: '按平台记住的音质缓存' },
  { key: 'zilux2.airplayVolumes', label: 'AirPlay 设备音量缓存' },
  { key: 'zilux2.airplayLatencyMs', label: 'AirPlay 延迟校准缓存' },
  { key: 'zilux2.localFolder', label: '本地音乐文件夹缓存' },
];

/** 默认可清空的前缀（实验性功能缓存）。 */
export const LOCAL_CACHE_PREFIXES: readonly string[] = ['zilux2.experimental.'];

/** 额外可清空的键（设置镜像 / 播放进度等），调用方按需显式传入。 */
export const EXTRA_CACHE_KEYS: readonly LocalCacheKey[] = [
  { key: 'zilux2.lastPlay', label: '上次播放记录' },
  { key: 'zilux2.playMode', label: '播放模式缓存' },
];

export interface ClearLocalCachesOptions {
  /** 显式指定要清的键（默认 LOCAL_CACHE_KEYS）。 */
  keys?: readonly string[];
  /** 显式指定前缀（默认 LOCAL_CACHE_PREFIXES；传 [] 关闭前缀扫描）。 */
  prefixes?: readonly string[];
}

export interface ClearLocalCachesResult {
  /** 实际删掉的键。 */
  cleared: string[];
  /** 本来就不存在的键。 */
  absent: string[];
}

/** 清理指定 localStorage 键 + 前缀匹配键，返回清了哪些。 */
export function clearLocalCaches(options: ClearLocalCachesOptions = {}): ClearLocalCachesResult {
  const keys = options.keys ?? LOCAL_CACHE_KEYS.map((item) => item.key);
  const prefixes = options.prefixes ?? LOCAL_CACHE_PREFIXES;
  const targets = new Set<string>(keys);

  if (prefixes.length > 0) {
    try {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (!key) continue;
        if (prefixes.some((prefix) => key.startsWith(prefix))) targets.add(key);
      }
    } catch (err) {
      console.warn('[settingsIO] 枚举 localStorage 失败', err);
    }
  }

  const cleared: string[] = [];
  const absent: string[] = [];
  for (const key of targets) {
    try {
      if (window.localStorage.getItem(key) === null) {
        absent.push(key);
        continue;
      }
      window.localStorage.removeItem(key);
      cleared.push(key);
    } catch (err) {
      console.warn(`[settingsIO] 清理 ${key} 失败`, err);
      absent.push(key);
    }
  }
  cleared.sort();
  absent.sort();
  return { cleared, absent };
}

/* ------------------------------------------------------------------ */
/* 可挂载按钮组 UI                                                     */
/* ------------------------------------------------------------------ */

export interface SettingsIOActionsOptions {
  /** 读取当前设置（导出用），通常传 `getSettings`。 */
  getSettings: () => Settings;
  /** 导入解析成功回调：Lead 通常在此 patchSettings(result.settings) 并 toast 提示;失败时也会带 result 调用。 */
  onImported?: (result: ImportSettingsResult) => void;
  /** 清理缓存后的回调。 */
  onCacheCleared?: (result: ClearLocalCachesResult) => void;
  /** 清缓存前确认（可接 confirmDialog），返回 false 取消。 */
  confirmClear?: (keyCount: number) => boolean | Promise<boolean>;
  /** 轻提示，默认 toast。 */
  notify?: (message: string, kind?: 'info' | 'error') => void;
  /** 追加在根节点上的 class。 */
  className?: string;
}

export interface SettingsIOActionsHandle {
  element: HTMLElement;
  dispose: () => void;
}

/**
 * 构建设置导入 / 导出 / 清缓存按钮组。
 * 建议挂载：设置 → 通用 页面底部，或设置页「关于」区域。
 */
export function buildSettingsIOActions(options: SettingsIOActionsOptions): SettingsIOActionsHandle {
  const notify =
    options.notify ?? ((message: string, kind: 'info' | 'error' = 'info') => toast(message, kind));
  const cleanups: Array<() => void> = [];
  let disposed = false;

  const exportBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm sio-btn', 'data-qa': 'settings-export' },
    icon('download', 14),
    h('span', { text: '导出设置' }),
  );
  const importBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm sio-btn', 'data-qa': 'settings-import' },
    icon('folder', 14),
    h('span', { text: '导入设置' }),
  );
  const clearBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm sio-btn is-danger', 'data-qa': 'settings-clear-cache' },
    icon('trash', 14),
    h('span', { text: '清空本地缓存' }),
  );

  const onExport = (): void => {
    if (disposed) return;
    try {
      const name = exportSettingsToFile(options.getSettings());
      notify(`已导出设置文件：${name}`);
    } catch (err) {
      notify(`导出失败：${errorText(err)}`, 'error');
    }
  };
  exportBtn.addEventListener('click', onExport);

  const onImport = async (): Promise<void> => {
    if (disposed) return;
    let result: ImportSettingsResult;
    try {
      result = await importSettingsFromFile();
    } catch (err) {
      notify(`导入失败：${errorText(err)}`, 'error');
      return;
    }
    if (disposed || result.canceled) return;
    options.onImported?.(result);
    if (!result.ok) {
      notify(result.error ?? '设置文件无法识别', 'error');
      return;
    }
    if (result.warnings.length > 0) {
      notify(`设置已导入（${result.warnings.length} 条提示）`);
    } else {
      notify('设置已导入');
    }
  };
  const onImportClick = (): void => {
    void onImport();
  };
  importBtn.addEventListener('click', onImportClick);
  cleanups.push(() => importBtn.removeEventListener('click', onImportClick));

  const onClear = async (): Promise<void> => {
    if (disposed) return;
    const keyCount = LOCAL_CACHE_KEYS.length;
    if (options.confirmClear) {
      let confirmed = false;
      try {
        confirmed = await options.confirmClear(keyCount);
      } catch {
        confirmed = false;
      }
      if (!confirmed || disposed) return;
    }
    const result = clearLocalCaches();
    options.onCacheCleared?.(result);
    notify(
      result.cleared.length > 0
        ? `已清理 ${result.cleared.length} 项本地缓存`
        : '没有可清理的本地缓存',
    );
  };
  const onClearClick = (): void => {
    void onClear();
  };
  clearBtn.addEventListener('click', onClearClick);
  cleanups.push(() => exportBtn.removeEventListener('click', onExport));
  cleanups.push(() => clearBtn.removeEventListener('click', onClearClick));

  const hint = h('div', {
    class: 'sio-hint',
    text: '导出为 JSON 文件；导入会自动校验并补齐缺失字段。清空本地缓存不会删除你的设置与搜索历史。',
  });
  const rootClass = options.className ? `sio ${options.className}` : 'sio';
  const element = h('div', { class: rootClass, 'data-qa': 'settings-io' }, exportBtn, importBtn, clearBtn, hint);

  return {
    element,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const fn of cleanups.splice(0)) fn();
      element.remove();
    },
  };
}
