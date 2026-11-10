/**
 * 可复用的「快捷键录制行」：设置页「快捷键」之外的页面（音频输出那两页）直接嵌一块，
 * 不用来回切页签。
 *
 * 与「快捷键」页完全共用同一份设置：两边都订阅 settings / 宿主注册回执，任一处改完另一处
 * 立即同步；录制逻辑与「快捷键」页保持一致（Esc 取消、Backspace 清除；支持单键和组合键）。
 */
import { h, toast } from './dom';
import {
  formatShortcutForDisplay,
  getSettings,
  normalizeShortcutBinding,
  onSettingsChange,
  patchSettings,
  SHORTCUT_LABELS,
  shortcutBindingFromEvent,
  type ShortcutAction,
} from '../core/settings';
import { getShortcutsState, onShortcutsState } from '../core/bridge';

export interface ShortcutRowHandle {
  root: HTMLElement;
  destroy: () => void;
}

const sameAction = (left: string, right: ShortcutAction): boolean => (
  left.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === right.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
);

const isModifierKey = (key: string): boolean => (
  key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta' || key === 'AltGraph'
);

export function createShortcutRow(action: ShortcutAction): ShortcutRowHandle {
  const meta = SHORTCUT_LABELS[action];
  const key = h('span', { class: 'shortcut-key is-empty', 'data-qa': 'shortcut-key', text: '未设置' });
  const record = h('button', {
    class: 'btn shortcut-record',
    type: 'button',
    'data-qa': 'shortcut-record',
    text: '录制',
  });
  const status = h('div', { class: 'shortcut-status', 'data-qa': 'shortcut-status' });
  const root = h(
    'div',
    { class: 'shortcut-row', 'data-qa': 'shortcut-row', 'data-action': action },
    h(
      'div',
      { class: 'shortcut-main' },
      h('div', { class: 'shortcut-label', text: meta.label }),
      h('div', { class: 'shortcut-hint', text: meta.hint }),
      status,
    ),
    h('div', { class: 'shortcut-side' }, key, record),
  );

  let recording = false;
  let hint = '';
  let disposed = false;

  const statusOf = (): { text: string; kind: string; title: string } => {
    const current = getSettings();
    if (!current.shortcuts.enabled) return { text: '未启用', kind: 'muted', title: '' };
    if (!current.shortcuts[action]) return { text: '未设置', kind: 'muted', title: '' };
    const hostState = getShortcutsState();
    if (!hostState) return { text: '已生效', kind: 'ok', title: '' };
    if (!hostState.enabled) return { text: '未启用', kind: 'muted', title: '' };
    const item = hostState.items.find((entry) => sameAction(entry.action, action));
    if (!item) return { text: '已生效', kind: 'ok', title: '' };
    const title = item.error ?? (item.fallback && item.applied ? '组合被其他程序占用，已自动改用替代组合' : '');
    if (item.fallback && item.applied) {
      return { text: `已回落到 ${formatShortcutForDisplay(item.applied)}`, kind: 'warn', title };
    }
    if (item.ok) return { text: '已生效', kind: 'ok', title };
    return { text: '组合被占用，可换一个', kind: 'warn', title };
  };

  const paint = (): void => {
    if (disposed) return;
    const current = getSettings();
    const display = formatShortcutForDisplay(current.shortcuts[action]);
    key.textContent = display || '未设置';
    key.classList.toggle('is-empty', !display);
    root.classList.toggle('is-recording', recording);
    root.classList.toggle('is-disabled', !current.shortcuts.enabled);
    record.disabled = !current.shortcuts.enabled;
    record.textContent = recording ? '按下单个按键或组合…' : display ? '重录' : '录制';
    if (recording) {
      status.textContent = hint || '按下单个按键或组合；Backspace / Delete 清除，Esc 取消';
      status.dataset.kind = 'recording';
      status.title = '';
      return;
    }
    const info = statusOf();
    status.textContent = info.text;
    status.dataset.kind = info.kind;
    status.title = info.title;
  };

  function stopRecording(): void {
    if (!recording) return;
    recording = false;
    hint = '';
    window.removeEventListener('keydown', onRecordKey, true);
    paint();
  }

  function startRecording(): void {
    stopRecording();
    recording = true;
    hint = '';
    window.addEventListener('keydown', onRecordKey, true);
    paint();
  }

  function onRecordKey(event: KeyboardEvent): void {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (isModifierKey(event.key)) return;
    if (event.key === 'Escape') {
      stopRecording();
      return;
    }
    const noModifier = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
    if (noModifier && (event.key === 'Backspace' || event.key === 'Delete')) {
      patchSettings({ shortcuts: { [action]: '' } as Partial<Record<ShortcutAction, string>> });
      stopRecording();
      toast(`已清除「${meta.label}」快捷键`);
      return;
    }
    const combo = shortcutBindingFromEvent(event);
    const normalized = combo ? normalizeShortcutBinding(combo, '') : '';
    if (!combo || !normalized) {
      hint = '这个按键不支持，请换一个';
      paint();
      return;
    }
    patchSettings({ shortcuts: { [action]: normalized } as Partial<Record<ShortcutAction, string>> });
    stopRecording();
    const single = !normalized.includes('+');
    toast(
      single
        ? `快捷键已更新：${meta.label} → ${formatShortcutForDisplay(normalized)}（单键全局生效，输入文字时也会触发）`
        : `快捷键已更新：${meta.label} → ${formatShortcutForDisplay(normalized)}`,
    );
  }

  record.addEventListener('click', () => {
    if (recording) stopRecording();
    else startRecording();
  });
  const stopSettings = onSettingsChange(paint);
  const stopHost = onShortcutsState(paint);
  paint();

  return {
    root,
    destroy: () => {
      if (disposed) return;
      stopRecording();
      disposed = true;
      stopSettings();
      stopHost();
      root.remove();
    },
  };
}

/** 一小组快捷键行（音频输出页用）：传入要展示的动作，按顺序渲染。 */
export function createShortcutRows(actions: ShortcutAction[]): { root: HTMLElement; destroy: () => void } {
  const list = h('div', { class: 'shortcut-list' });
  const rows = actions.map((action) => createShortcutRow(action));
  rows.forEach((row) => list.append(row.root));
  return {
    root: list,
    destroy: () => {
      rows.forEach((row) => row.destroy());
      list.remove();
    },
  };
}
