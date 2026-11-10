/**
 * 设置页「麦克风混音」面板：把 Zilux2 的音乐混进虚拟音频线，语音软件选 CABLE Output
 * 就能同时听到音乐和本机麦克风；本机扬声器照常播放。
 */
import { h, toast } from './dom';
import { currentAppSinkId, listAppAudioOutputs, type AppAudioOutput } from '../core/audioOutput';
import {
  listMicrophones,
  loadMicMixConfig,
  micMixRunning,
  openCableDownload,
  playMicMixTestTone,
  saveMicMixConfig,
  startMicMix,
  stopMicMix,
  updateMicMixGains,
  type MicrophoneDevice,
  type MicMixConfig,
} from './micMix';

const isVirtualCable = (label: string): boolean =>
  /cable input|voicemeeter.*input|virtual audio cable|vb-audio/i.test(label);

export interface MicMixPanelHandle {
  root: HTMLElement;
  dispose: () => void;
}

function sliderRow(
  label: string,
  hint: string,
  value: number,
  onInput: (next: number) => void,
  maxPercent = 600,
): { root: HTMLElement; input: HTMLInputElement; valueLabel: HTMLElement } {
  const valueLabel = h('span', { class: 'field-slider-value', text: `${Math.round(value * 100)}%` });
  const input = h('input', {
    class: 'slider',
    type: 'range',
    min: '0',
    max: String(maxPercent),
    step: '1',
    value: String(Math.round(value * 100)),
    'aria-label': label,
  }) as HTMLInputElement;
  input.addEventListener('input', () => {
    const next = Number(input.value) / 100;
    valueLabel.textContent = `${Math.round(next * 100)}%`;
    onInput(next);
  });
  return {
    root: h(
      'div',
      { class: 'field field-slider set-row' },
      h(
        'div',
        { class: 'set-row-main' },
        h('div', { class: 'field-label set-row-label', text: label }),
        h('div', { class: 'field-hint', text: hint }),
      ),
      h('div', { class: 'set-row-control field-slider-control' }, valueLabel, input),
    ),
    input,
    valueLabel,
  };
}

export function createMicMixPanel(): MicMixPanelHandle {
  let config: MicMixConfig = loadMicMixConfig();
  let microphones: MicrophoneDevice[] = [];
  let outputs: AppAudioOutput[] = [];
  let loading = true;
  let busy = false;
  let loadError = '';
  let cableOutputAvailable = false;

  const status = h('div', { class: 'field-hint mic-mix-status', text: '正在读取麦克风和虚拟音频线…' });
  const toggle = h('button', { class: 'btn', type: 'button', text: '开启混音' });
  const testTone = h('button', { class: 'btn is-quiet', type: 'button', text: '测试 CABLE 输出' });
  const installCable = h('button', { class: 'btn is-quiet', type: 'button', text: '获取 VB-CABLE' });
  const micSelect = h('select', { class: 'set-select', 'aria-label': '物理麦克风' }) as HTMLSelectElement;
  const outputSelect = h('select', { class: 'set-select', 'aria-label': '虚拟音频线输出' }) as HTMLSelectElement;
  const musicSlider = sliderRow('音乐音量', '送进麦克风的音乐电平，不影响本机扬声器音量。', config.musicGain, (next) => {
    config = { ...config, musicGain: next };
    saveMicMixConfig(config);
    updateMicMixGains(config.musicGain, config.micGain, config.outputGain);
  });
  const micSlider = sliderRow('麦克风音量', '说话声在混音里的电平；不影响系统里原麦克风的收音。', config.micGain, (next) => {
    config = { ...config, micGain: next };
    saveMicMixConfig(config);
    updateMicMixGains(config.musicGain, config.micGain, config.outputGain);
  });
  const outputSlider = sliderRow(
    '总输出增益',
    '混音后的总音量。系统里 CABLE Output 电平偏低时拉高这一项；内置限幅会防止爆音。',
    config.outputGain,
    (next) => {
      config = { ...config, outputGain: next };
      saveMicMixConfig(config);
      updateMicMixGains(config.musicGain, config.micGain, config.outputGain);
    },
    600,
  );

  const note = h(
    'div',
    { class: 'mic-mix-note' },
    h('div', {
      text: '原理：Zilux2 把「音乐 + 本机麦克风」混成一路，送到虚拟音频线的播放端（CABLE Input）。',
    }),
    h('div', {
      text: '然后在 Discord / 游戏语音里把「麦克风」选为 CABLE Output (VB-Audio Virtual Cable)。这样对方同时听到你说话和音乐，本机扬声器照常播放。',
    }),
    h('div', {
      text: '需要先安装 VB-Audio Virtual Cable 或 VoiceMeeter；本机已安装时会在输出列表里自动识别。',
    }),
    h('div', {
      text: 'VB-CABLE 由 VB-Audio 提供，是 donationware；本软件不修改其驱动，欢迎在 vb-cable.com 支持作者。',
    }),
    h('div', {
      text: '如果 CABLE Output 电平仍然很小：先把 Windows 里 CABLE Input 的播放音量拉满，再提高这里的「总输出增益」（最高 600%）；内置限幅会防止削波。',
    }),
  );

  const root = h(
    'div',
    { class: 'mic-mix-panel' },
    h('div', { class: 'field is-stacked' }, status, h('div', { class: 'mic-mix-actions' }, toggle, testTone, installCable)),
    h(
      'div',
      { class: 'field is-stacked' },
      h('div', { class: 'field-label', text: '物理麦克风' }),
      micSelect,
      h('div', { class: 'field-hint', text: '这里选你平时说话的麦克风；混音不会改变它在系统里的正常收音。' }),
    ),
    h(
      'div',
      { class: 'field is-stacked' },
      h('div', { class: 'field-label', text: '虚拟音频线输出' }),
      outputSelect,
      h('div', { class: 'field-hint mic-mix-output-hint', text: '' }),
    ),
    h('div', { class: 'mic-mix-sliders' }, musicSlider.root, micSlider.root, outputSlider.root),
    note,
  );

  const selectedOutput = (): AppAudioOutput | null =>
    outputs.find((item) => item.id === outputSelect.value) ?? null;

  const paint = (): void => {
    const running = micMixRunning();
    const output = selectedOutput();
    const cable = output ? isVirtualCable(output.label) : false;

    toggle.disabled = loading || busy || (!running && (microphones.length === 0 || !cable));
    testTone.disabled = !running || loading || busy;
    toggle.textContent = running ? '停止混音' : busy ? '正在启动…' : '开启混音';
    toggle.classList.toggle('is-danger', running);
    micSelect.disabled = running || loading;
    outputSelect.disabled = running || loading;
    musicSlider.input.disabled = false;
    micSlider.input.disabled = false;

    if (loadError) {
      status.textContent = loadError;
      status.dataset.kind = 'warn';
    } else if (loading) {
      status.textContent = '正在读取麦克风和虚拟音频线…';
      status.dataset.kind = 'muted';
    } else if (running) {
      status.textContent = `运行中：音乐 + ${microphones.find((item) => item.id === micSelect.value)?.label ?? '麦克风'} → ${output?.label ?? '虚拟音频线'}`;
      status.dataset.kind = 'ok';
    } else if (!output) {
      status.textContent = '没有找到虚拟音频线输出（CABLE Input）。安装 VB-Audio Virtual Cable 后刷新设备。';
      status.dataset.kind = 'warn';
    } else if (!cableOutputAvailable) {
      status.textContent = 'CABLE Output 录音端未启用：请到 Windows 声音设置把它改成「允许」，否则麦克风测试和语音软件都会是 0%。';
      status.dataset.kind = 'warn';
    } else {
      status.textContent = '未开启。开启后语音软件把麦克风选为 CABLE Output 即可。';
      status.dataset.kind = 'muted';
    }

    const hint = root.querySelector('.mic-mix-output-hint');
    if (hint instanceof HTMLElement) {
      if (loading) hint.textContent = '正在读取播放设备…';
      else if (!output) hint.textContent = '未检测到 CABLE Input / VoiceMeeter Input。';
      else if (!cable) {
        hint.textContent = '⚠ 这不是虚拟音频线。选扬声器会让音乐从扬声器外放，可能产生啸叫；请改选 CABLE Input。';
      } else if (!cableOutputAvailable) {
        hint.textContent = '⚠ 找到了 CABLE Input，但系统里没有可用的 CABLE Output 录音端。请到「Windows 设置 → 系统 → 声音 → CABLE Output → 属性」，把「允许应用和 Windows 将此设备用于音频」改成「允许」，并确认 CABLE Input 的音量不是 0 / 未静音。';
      } else if (currentAppSinkId() === output.id) {
        hint.textContent = '⚠ Zilux2 的「扬声器输出」也指向这条虚拟线：本机将听不到声音，而且音乐会被重复送入。请到「播放 → 扬声器输出」改回耳机/扬声器。';
      } else {
        hint.textContent = '已识别虚拟音频线。语音软件里请选择对应的录音端（通常是 CABLE Output）。';
      }
    }
  };

  const fillSelect = (select: HTMLSelectElement, items: Array<{ id: string; label: string }>, value: string, empty: string): string => {
    select.replaceChildren();
    if (items.length === 0) {
      select.append(h('option', { value: '', text: empty }));
      select.value = '';
      return '';
    }
    for (const item of items) {
      select.append(h('option', { value: item.id, text: item.label }));
    }
    const next = items.some((item) => item.id === value) ? value : items[0].id;
    select.value = next;
    return next;
  };

  const refreshDevices = async (): Promise<void> => {
    loading = true;
    loadError = '';
    paint();
    try {
      const [micList, outputList] = await Promise.all([listMicrophones(), listAppAudioOutputs()]);
      microphones = micList;
      outputs = outputList;
      cableOutputAvailable = micList.some((item) =>
        /cable output|voicemeeter out|virtual audio cable output/i.test(item.label),
      );

      const savedMic = microphones.some((item) => item.id === config.micDeviceId)
        ? config.micDeviceId
        : microphones[0]?.id ?? '';
      const cable =
        outputs.find((item) => item.id === config.outputDeviceId) ??
        outputs.find((item) => /cable input/i.test(item.label)) ??
        outputs.find((item) => isVirtualCable(item.label)) ??
        null;
      const nextOutput = cable?.id ?? '';
      config = {
        ...config,
        micDeviceId: savedMic,
        outputDeviceId: nextOutput,
        outputLabel: cable?.label ?? '',
      };
      saveMicMixConfig(config);

      fillSelect(micSelect, microphones, savedMic, '没有检测到麦克风');
      if (nextOutput) {
        fillSelect(outputSelect, outputs, nextOutput, '没有检测到播放设备');
        outputSelect.value = nextOutput;
      } else {
        outputSelect.replaceChildren(h('option', { value: '', text: '未检测到 CABLE Input / 虚拟音频线' }));
        outputSelect.value = '';
      }
      paint();
    } catch (error) {
      loadError = error instanceof Error ? error.message : '读取麦克风失败';
      microphones = [];
      outputs = [];
      fillSelect(micSelect, [], '', '没有检测到麦克风');
      fillSelect(outputSelect, [], '', '没有检测到播放设备');
      paint();
    } finally {
      loading = false;
      paint();
    }
  };

  const start = async (): Promise<void> => {
    if (busy || micMixRunning()) return;
    const mic = microphones.find((item) => item.id === micSelect.value);
    const output = selectedOutput();
    if (!mic) {
      toast('请选择物理麦克风', 'error');
      return;
    }
    if (!output) {
      toast('没有虚拟音频线输出：请安装 VB-Audio Virtual Cable', 'error');
      return;
    }
    if (!isVirtualCable(output.label)) {
      toast('请选择 CABLE Input 这类虚拟音频线，不要选扬声器', 'error');
      return;
    }
    config = {
      ...config,
      micDeviceId: mic.id,
      outputDeviceId: output.id,
      outputLabel: output.label,
    };
    saveMicMixConfig(config);
    busy = true;
    paint();
    try {
      await startMicMix(config);
      toast(`已开启麦克风混音：音乐 + ${mic.label} → ${output.label}`);
    } catch (error) {
      toast(error instanceof Error ? error.message : '开启麦克风混音失败', 'error');
    } finally {
      busy = false;
      paint();
    }
  };

  const stop = (): void => {
    if (!micMixRunning()) return;
    stopMicMix();
    toast('已停止麦克风混音');
    paint();
  };

  toggle.addEventListener('click', () => {
    if (micMixRunning()) stop();
    else void start();
  });
  testTone.addEventListener('click', () => {
    if (!playMicMixTestTone()) {
      toast('请先开启混音，再测试 CABLE 输出', 'error');
      return;
    }
    toast('已发送 1 秒提示音；请在 Windows 声音设置的 CABLE Output 麦克风测试里看波形和音量');
  });
  installCable.addEventListener('click', () => {
    openCableDownload();
    toast('已打开 VB-CABLE 官方下载页；安装后点「重新打开设置」或重启 Zilux2');
  });
  micSelect.addEventListener('change', () => {
    config = { ...config, micDeviceId: micSelect.value };
    saveMicMixConfig(config);
    paint();
  });
  outputSelect.addEventListener('change', () => {
    const output = outputs.find((item) => item.id === outputSelect.value);
    config = {
      ...config,
      outputDeviceId: outputSelect.value,
      outputLabel: output?.label ?? '',
    };
    saveMicMixConfig(config);
    paint();
  });

  // 面板销毁不停止混音：设置页关掉后音乐仍应继续送进麦克风；页面卸载由 micMix 自己收尾。
  void refreshDevices();
  paint();

  return {
    root,
    dispose: () => {
      root.remove();
    },
  };
}
