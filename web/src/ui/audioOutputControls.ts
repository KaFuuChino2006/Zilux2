/**
 * 音频输出控件：
 *   - createAppOutputControl：本软件的播放设备（跟随系统 / 指定设备），设置页与快捷设置共用；
 *   - createSystemAudioPanel：系统默认播放设备轮换（只放在设置页「系统音频」）。
 */
import { h, toast } from './dom';
import { getSettings, onSettingsChange, patchSettings } from '../core/settings';
import {
  cycleSystemAudioOutput,
  listAppAudioOutputs,
  onAppAudioOutputsChanged,
  onSystemAudioOutputState,
  requestSystemAudioOutputs,
  setSystemAudioOutputDefault,
  type AppAudioOutput,
  type SystemAudioOutputState,
} from '../core/audioOutput';

export interface AppOutputControl {
  root: HTMLElement;
  refresh: () => void;
}

/** 本软件输出：下拉里第一项是「跟随系统」，其余是全部播放设备。 */
export function createAppOutputControl(): AppOutputControl {
  const select = h('select', {
    class: 'set-select',
    'aria-label': '扬声器输出',
  }) as HTMLSelectElement;
  const note = h('div', { class: 'field-hint', text: '' });
  const root = h('div', { class: 'app-output-control' }, select, note);

  let outputs: AppAudioOutput[] = [];
  let loading = true;

  const paint = (): void => {
    const { playback } = getSettings();
    const saved = playback.appOutputDeviceId;
    const pinned = playback.appOutputMode === 'device' && saved;
    select.replaceChildren();
    select.append(h('option', { value: '', text: '跟随系统（Windows 默认设备）' }));
    for (const device of outputs) {
      select.append(h('option', { value: device.id, text: device.label }));
    }

    const found = pinned && outputs.some((device) => device.id === saved);
    select.value = found ? saved : '';
    select.classList.toggle('is-missing', Boolean(pinned) && !found && outputs.length > 0);

    if (loading) {
      note.textContent = '正在读取播放设备…';
    } else if (outputs.length === 0) {
      note.textContent = '没有检测到可选播放设备：浏览器预览下需要宿主授权，或这台电脑没有插播放设备。';
    } else if (pinned && !found) {
      note.textContent = '原来选择的设备已断开，当前临时跟随系统；重新选择一台即可固定。';
    } else if (found) {
      note.textContent = '只改 Zilux2 自己的音频输出，系统默认设备不变；设备断开时自动回落到系统默认。';
    } else {
      note.textContent = '只改 Zilux2 自己的音频输出，系统默认设备不变；系统默认设备变化时会自动跟随。';
    }
  };

  const refresh = (): void => {
    loading = true;
    paint();
    void listAppAudioOutputs()
      .then((list) => {
        outputs = list;
      })
      .finally(() => {
        loading = false;
        if (root.isConnected) paint();
      });
  };

  select.addEventListener('change', () => {
    const value = select.value;
    if (!value) {
      patchSettings({ playback: { appOutputMode: 'system' } });
      return;
    }

    const device = outputs.find((item) => item.id === value);
    patchSettings({ playback: { appOutputMode: 'device', appOutputDeviceId: value } });
    toast(`Zilux2 输出已切到「${device?.label ?? '所选设备'}」`);
  });

  // 插拔设备 / 系统默认设备变化时刷新列表；控件被销毁后自动退订。
  const unsubscribe = onAppAudioOutputsChanged(() => {
    if (!root.isConnected) {
      unsubscribe();
      return;
    }
    refresh();
  });
  // 快捷键切换输出模式时，下拉要立刻反映新状态。
  const stopSettings = onSettingsChange(() => {
    if (!root.isConnected) {
      stopSettings();
      return;
    }
    paint();
  });

  refresh();
  return { root, refresh };
}

/** 系统默认输出轮换面板：勾选参与轮换的设备（全选 = 全部轮换）。 */
export function createSystemAudioPanel(): { root: HTMLElement; dispose: () => void } {
  const status = h('div', { class: 'field-hint', text: '读取中…' });
  const current = h('div', { class: 'system-output-current', text: '' });
  const list = h('div', { class: 'system-output-list' });
  const refresh = h('button', { class: 'btn is-quiet', type: 'button', text: '刷新设备' });
  const cycle = h('button', { class: 'btn', type: 'button', text: '立即切换一次' });
  const actions = h('div', { class: 'system-output-actions' }, cycle, refresh);
  const root = h(
    'div',
    { class: 'field is-stacked system-audio-panel' },
    h('div', { class: 'field-label', text: '系统默认输出轮换' }),
    h('div', {
      class: 'field-hint',
      text: '切换的是 Windows 默认播放设备（所有程序都跟着变），不影响 Zilux2 自己的输出通道。默认所有活动设备参与轮换；只勾选一部分时按勾选顺序轮换。快捷键在「快捷键」页录制。',
    }),
    current,
    list,
    actions,
    status,
  );

  let disposed = false;

  const selection = (snapshot: SystemAudioOutputState): string[] => {
    const all = snapshot.devices.map((device) => device.id);
    const rotation = getSettings().general.systemOutputRotation;
    if (rotation.length === 0) return all;
    const kept = rotation.filter((id) => all.includes(id));
    return kept.length > 0 ? kept : all;
  };

  const saveSelection = (snapshot: SystemAudioOutputState, next: string[]): void => {
    const all = snapshot.devices.map((device) => device.id);
    const isAll = next.length === all.length && all.every((id) => next.includes(id));
    patchSettings({ general: { systemOutputRotation: isAll ? [] : next } });
  };

  const render = (snapshot: SystemAudioOutputState): void => {
    if (disposed) return;
    const selected = selection(snapshot);
    const all = snapshot.devices.map((device) => device.id);
    const defaultDevice = snapshot.devices.find((device) => device.id === snapshot.defaultId)
      ?? snapshot.devices.find((device) => device.default);

    current.textContent = defaultDevice
      ? `当前系统默认：${defaultDevice.name}`
      : '当前系统默认：未检测到（可能全部断开）';
    current.dataset.empty = defaultDevice ? 'false' : 'true';

    list.replaceChildren();
    for (const device of snapshot.devices) {
      const isDefault = device.id === (defaultDevice?.id ?? '');
      const box = h('input', { type: 'checkbox', 'aria-label': `让「${device.name}」参与轮换` }) as HTMLInputElement;
      box.checked = selected.includes(device.id);
      box.addEventListener('change', () => {
        const currentSelection = selection(snapshot);
        const next = box.checked
          ? [...currentSelection, device.id]
          : currentSelection.filter((id) => id !== device.id);
        if (next.length === 0) {
          box.checked = true;
          toast('至少要保留一台设备参与轮换');
          return;
        }

        saveSelection(snapshot, next);
        render(snapshot);
      });
      list.append(
        h(
          'label',
          { class: `system-output-row${isDefault ? ' is-default' : ''}` },
          box,
          h('span', { class: 'system-output-name', text: device.name }),
          isDefault ? h('span', { class: 'system-output-badge', text: '默认' }) : null,
        ),
      );
    }

    if (snapshot.devices.length === 0) {
      list.append(h('div', { class: 'field-hint', text: '没有检测到活动播放设备。' }));
    } else if (selected.length === all.length) {
      status.textContent = `全部 ${all.length} 台设备参与轮换（默认）。`;
    } else {
      status.textContent = `已选 ${selected.length} / ${all.length} 台参与轮换。`;
    }
  };

  const unsubscribe = onSystemAudioOutputState((snapshot) => render(snapshot));
  refresh.addEventListener('click', () => {
    status.textContent = '刷新中…';
    requestSystemAudioOutputs();
  });
  cycle.addEventListener('click', () => {
    cycleSystemAudioOutput();
    window.setTimeout(requestSystemAudioOutputs, 320);
  });
  requestSystemAudioOutputs();

  return {
    root,
    dispose: () => {
      disposed = true;
      unsubscribe();
    },
  };
}

/** 设置页里「系统音频」也提供一个直接设默认设备的小列表（点击即切）。 */
export function selectSystemAudioOutput(id: string): void {
  setSystemAudioOutputDefault(id);
}

