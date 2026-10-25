/**
 * 自定义 EQ 预设（桌面端小工具）：localStorage 持久化 + 可挂载管理 UI。
 *
 * - 存储键：`zilux2.eqCustomPresets`；最多 24 套。
 * - gains 结构与 `web/src/core/settings.ts` 的 `playback.eqGains` 严格一致：
 *   长度 = EQ_BAND_FREQS.length（10 段），单位 dB，范围 EQ_GAIN_MIN..EQ_GAIN_MAX（-12..12）。
 * - 本模块不写设置：应用预设时通过 `onApply` 回调交给 Lead（通常 patchSettings 后刷新滑块）。
 */
import { EQ_BAND_FREQS, EQ_GAIN_MAX, EQ_GAIN_MIN } from '../core/settings';
import { h, icon, toast } from './dom';

export const EQ_CUSTOM_PRESETS_STORAGE_KEY = 'zilux2.eqCustomPresets';
export const EQ_CUSTOM_PRESET_LIMIT = 24;
export const EQ_CUSTOM_PRESET_NAME_MAX = 24;
/** 频段数量（10），与 settings.ts 的 eqGains 长度一致。 */
export const EQ_BAND_COUNT = EQ_BAND_FREQS.length;

export interface CustomEqPreset {
  /** 稳定 id（存 localStorage 用，不参与展示）。 */
  id: string;
  /** 展示名称（去重按大小写不敏感）。 */
  name: string;
  /** 10 段增益（dB，-12..12），顺序同 EQ_BAND_FREQS。 */
  gains: number[];
  createdAt: number;
  updatedAt: number;
}

type Listener = (presets: readonly CustomEqPreset[]) => void;

const listeners = new Set<Listener>();

/* ------------------------------------------------------------------ */
/* 规范化与存储                                                        */
/* ------------------------------------------------------------------ */

/** 把任意值规范成与 settings.ts 完全一致的 10 段 eqGains（非法值 0，越界钳制，取整）。 */
export function normalizeEqGains(value: unknown): number[] {
  const source: unknown[] = Array.isArray(value) ? (value as unknown[]) : [];
  return EQ_BAND_FREQS.map((_, index) => {
    const raw = source[index];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
    return Math.round(Math.max(EQ_GAIN_MIN, Math.min(EQ_GAIN_MAX, raw)));
  });
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= EQ_CUSTOM_PRESET_NAME_MAX) return collapsed;
  return collapsed.slice(0, EQ_CUSTOM_PRESET_NAME_MAX).trimEnd();
}

function nameKey(name: string): string {
  return name.toLocaleLowerCase();
}

function clonePreset(preset: CustomEqPreset): CustomEqPreset {
  return { ...preset, gains: [...preset.gains] };
}

function snapshot(presets: readonly CustomEqPreset[]): CustomEqPreset[] {
  return presets.map(clonePreset);
}

function readPresets(): CustomEqPreset[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(EQ_CUSTOM_PRESETS_STORAGE_KEY);
  } catch (err) {
    console.warn('[eqPresets] 读取失败', err);
    return [];
  }
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[eqPresets] 数据损坏，已忽略', err);
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const now = Date.now();
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const presets: CustomEqPreset[] = [];
  for (const item of parsed) {
    if (presets.length >= EQ_CUSTOM_PRESET_LIMIT) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as {
      id?: unknown;
      name?: unknown;
      gains?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
    };
    const name = normalizeName(record.name);
    if (!name) continue;
    const key = nameKey(name);
    if (seenNames.has(key)) continue;
    const id =
      typeof record.id === 'string' && record.id.trim()
        ? record.id.trim()
        : `eq-${now.toString(36)}-${presets.length}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    seenNames.add(key);
    const createdAt =
      typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
        ? record.createdAt
        : now;
    const updatedAt =
      typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
        ? record.updatedAt
        : createdAt;
    presets.push({
      id,
      name,
      gains: normalizeEqGains(record.gains),
      createdAt,
      updatedAt,
    });
  }
  return presets;
}

function emit(presets: readonly CustomEqPreset[]): void {
  const payload = snapshot(presets);
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch (err) {
      console.warn('[eqPresets] 订阅回调异常', err);
    }
  }
}

function writePresets(presets: readonly CustomEqPreset[]): void {
  const next = snapshot(presets).slice(0, EQ_CUSTOM_PRESET_LIMIT);
  try {
    window.localStorage.setItem(EQ_CUSTOM_PRESETS_STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.warn('[eqPresets] 写入失败', err);
  }
  emit(next);
}

/* ------------------------------------------------------------------ */
/* 公开 API                                                            */
/* ------------------------------------------------------------------ */

/** 全部自定义预设（副本，保持存储顺序）。 */
export function listPresets(): CustomEqPreset[] {
  return snapshot(readPresets());
}

/** 按 id 取单套预设（副本）。 */
export function getPreset(id: string): CustomEqPreset | null {
  const found = readPresets().find((preset) => preset.id === id);
  return found ? clonePreset(found) : null;
}

/**
 * 保存一套预设：同名（大小写不敏感）则更新增益，否则新建并置顶。
 * @throws 名称为空 / 超过数量上限
 */
export function savePreset(name: string, gains: unknown): CustomEqPreset {
  const normalizedName = normalizeName(name);
  if (!normalizedName) throw new Error('预设名称不能为空');
  const normalizedGains = normalizeEqGains(gains);
  const current = readPresets();
  const now = Date.now();
  const existing = current.find((preset) => nameKey(preset.name) === nameKey(normalizedName));
  if (existing) {
    const updated: CustomEqPreset = {
      ...existing,
      gains: normalizedGains,
      updatedAt: now,
    };
    writePresets(current.map((preset) => (preset.id === existing.id ? updated : preset)));
    return clonePreset(updated);
  }
  if (current.length >= EQ_CUSTOM_PRESET_LIMIT) {
    throw new Error(`最多保存 ${EQ_CUSTOM_PRESET_LIMIT} 个自定义预设，请先删除不用的预设`);
  }
  const created: CustomEqPreset = {
    id: `eq-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: normalizedName,
    gains: normalizedGains,
    createdAt: now,
    updatedAt: now,
  };
  writePresets([created, ...current]);
  return clonePreset(created);
}

/**
 * 重命名：找不到 id 返回 null；名称与其它预设重复时抛错。
 * @throws 名称为空 / 与其它预设重名
 */
export function renamePreset(id: string, name: string): CustomEqPreset | null {
  const normalizedName = normalizeName(name);
  if (!normalizedName) throw new Error('预设名称不能为空');
  const current = readPresets();
  const target = current.find((preset) => preset.id === id);
  if (!target) return null;
  const clash = current.find(
    (preset) => preset.id !== id && nameKey(preset.name) === nameKey(normalizedName),
  );
  if (clash) throw new Error(`已存在同名预设「${clash.name}」`);
  const updated: CustomEqPreset = {
    ...target,
    name: normalizedName,
    updatedAt: Date.now(),
  };
  writePresets(current.map((preset) => (preset.id === id ? updated : preset)));
  return clonePreset(updated);
}

/** 删除一套预设；成功返回 true。 */
export function deletePreset(id: string): boolean {
  const current = readPresets();
  const next = current.filter((preset) => preset.id !== id);
  if (next.length === current.length) return false;
  writePresets(next);
  return true;
}

/** 取一套预设的增益（副本，10 段）；不存在返回 null。 */
export function applyPreset(id: string): number[] | null {
  const found = readPresets().find((preset) => preset.id === id);
  return found ? [...found.gains] : null;
}

/** 订阅预设变化。返回取消订阅函数。 */
export function subscribePresets(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 订阅变化的简写别名（任务约定的 API 名）。 */
export function subscribe(listener: Listener): () => void {
  return subscribePresets(listener);
}

/* ------------------------------------------------------------------ */
/* 可挂载管理 UI                                                       */
/* ------------------------------------------------------------------ */

export interface EqPresetManagerOptions {
  /** 读取当前均衡器增益（通常来自 settings.playback.eqGains）。 */
  getGains: () => readonly number[];
  /** 应用预设：Lead 通常在此 patchSettings({ playback: { eqEnabled: true, eqGains } }) 并刷新滑块。 */
  onApply: (gains: number[], preset: CustomEqPreset) => void;
  /** 轻提示，默认 toast。 */
  notify?: (message: string, kind?: 'info' | 'error') => void;
  /** 删除确认，默认直接删除；可接 confirmDialog。 */
  confirmDelete?: (preset: CustomEqPreset) => boolean | Promise<boolean>;
  /** 追加在根节点上的 class。 */
  className?: string;
}

export interface EqPresetManagerHandle {
  element: HTMLElement;
  /** 依据最新存储重绘。 */
  refresh: () => void;
  /** 解绑订阅并移除节点。 */
  dispose: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 构建自定义 EQ 预设管理区（保存 / 应用 / 重命名 / 删除）。
 * 建议挂载：设置 → 播放 → 均衡器预设分段下方。
 */
export function buildEqPresetManager(options: EqPresetManagerOptions): EqPresetManagerHandle {
  const notify = options.notify ?? ((message: string, kind: 'info' | 'error' = 'info') => toast(message, kind));
  let disposed = false;
  let activeId: string | null = null;
  let editingId: string | null = null;

  const nameInput = h('input', {
    type: 'text',
    class: 'eqp-input',
    'data-qa': 'eq-preset-name',
    placeholder: '给这套音效起个名字',
    maxlength: String(EQ_CUSTOM_PRESET_NAME_MAX),
    'aria-label': '自定义预设名称',
  });

  const saveBtn = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-sm is-primary eqp-save-btn',
      'data-qa': 'eq-preset-save',
      title: '把当前 10 段增益保存为自定义预设',
    },
    icon('sparkle', 14),
    h('span', { text: '保存当前' }),
  );

  const chips = h('div', {
    class: 'seg eqp-chips',
    'data-qa': 'eq-preset-list',
    role: 'group',
    'aria-label': '自定义 EQ 预设',
  });
  const empty = h('div', {
    class: 'eqp-empty',
    text: '还没有自定义预设：调好均衡器后点「保存当前」。',
  });

  const rootClass = options.className ? `eqp ${options.className}` : 'eqp';
  const head = h(
    'div',
    { class: 'eqp-head' },
    h('div', { class: 'eqp-title' }, icon('equalizer', 14), h('span', { text: '自定义预设' })),
    h('div', { class: 'eqp-head-actions' }, saveBtn),
  );
  const saveRow = h('div', { class: 'eqp-save-row' }, nameInput);
  const element = h('div', { class: rootClass, 'data-qa': 'eq-custom-presets' }, head, saveRow, chips, empty);

  const applyCustomPreset = (id: string): void => {
    const gains = applyPreset(id);
    const preset = getPreset(id);
    if (!gains || !preset) {
      notify('预设不存在，可能已被删除', 'error');
      render();
      return;
    }
    activeId = id;
    options.onApply(gains, preset);
    notify(`已应用预设「${preset.name}」`);
    render();
  };

  const removeCustomPreset = async (preset: CustomEqPreset): Promise<void> => {
    if (disposed) return;
    if (options.confirmDelete) {
      let confirmed = false;
      try {
        confirmed = await options.confirmDelete(preset);
      } catch {
        confirmed = false;
      }
      if (!confirmed || disposed) return;
    }
    deletePreset(preset.id);
    if (activeId === preset.id) activeId = null;
    notify(`已删除预设「${preset.name}」`);
  };

  const render = (): void => {
    if (disposed) return;
    const presets = listPresets();
    chips.replaceChildren();
    for (const preset of presets) {
      if (editingId === preset.id) {
        const renameInput = h('input', {
          type: 'text',
          class: 'eqp-chip-input',
          'data-qa': 'eq-preset-rename-input',
          maxlength: String(EQ_CUSTOM_PRESET_NAME_MAX),
          'aria-label': `重命名预设 ${preset.name}`,
        });
        renameInput.value = preset.name;
        let settled = false;
        const finish = (commit: boolean): void => {
          if (settled) return;
          settled = true;
          if (!commit) {
            editingId = null;
            render();
            return;
          }
          if (disposed || editingId !== preset.id) return;
          editingId = null;
          try {
            const renamed = renamePreset(preset.id, renameInput.value);
            if (!renamed) {
              render();
              return;
            }
            notify(`预设已重命名为「${renamed.name}」`);
          } catch (err) {
            notify(errorMessage(err), 'error');
          }
          render();
        };
        renameInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            finish(true);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            finish(false);
          }
        });
        renameInput.addEventListener('blur', () => finish(true));
        chips.append(h('div', { class: 'eqp-chip-wrap is-editing' }, renameInput));
        queueMicrotask(() => {
          if (disposed || editingId !== preset.id) return;
          renameInput.focus();
          renameInput.select();
        });
        continue;
      }

      const applyBtn = h(
        'button',
        {
          type: 'button',
          class: activeId === preset.id ? 'seg-btn eqp-chip is-on' : 'seg-btn eqp-chip',
          'data-qa': 'eq-preset-apply',
          'data-preset-id': preset.id,
          title: `应用预设「${preset.name}」`,
        },
        h('span', { class: 'eqp-chip-name', text: preset.name }),
      );
      applyBtn.addEventListener('click', () => {
        applyCustomPreset(preset.id);
      });

      const renameBtn = h(
        'button',
        {
          type: 'button',
          class: 'eqp-icon-btn',
          'data-qa': 'eq-preset-rename',
          'data-preset-id': preset.id,
          title: '重命名预设',
          'aria-label': `重命名预设 ${preset.name}`,
        },
        h('span', { class: 'eqp-icon-text', text: '改名' }),
      );
      renameBtn.addEventListener('click', () => {
        editingId = preset.id;
        render();
      });

      const deleteBtn = h(
        'button',
        {
          type: 'button',
          class: 'eqp-icon-btn is-danger',
          'data-qa': 'eq-preset-delete',
          'data-preset-id': preset.id,
          title: '删除预设',
          'aria-label': `删除预设 ${preset.name}`,
        },
        icon('trash', 13),
      );
      deleteBtn.addEventListener('click', () => {
        void removeCustomPreset(preset);
      });

      chips.append(h('div', { class: 'eqp-chip-wrap' }, applyBtn, renameBtn, deleteBtn));
    }
    chips.hidden = presets.length === 0;
    empty.hidden = presets.length > 0;
  };

  saveBtn.addEventListener('click', () => {
    try {
      const preset = savePreset(nameInput.value, options.getGains());
      activeId = preset.id;
      nameInput.value = '';
      notify(`已保存自定义预设「${preset.name}」`);
    } catch (err) {
      notify(errorMessage(err), 'error');
    }
    render();
  });

  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveBtn.click();
    }
  });

  const unsubscribe = subscribePresets(render);
  render();

  return {
    element,
    refresh: render,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      element.remove();
    },
  };
}
