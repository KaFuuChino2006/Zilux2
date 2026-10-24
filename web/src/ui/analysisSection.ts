/// <reference types="vite/client" />
/**
 * 设置 → 播放页「节拍分析（实验）」区块。
 *
 * 分析接口与契约见 docs/zilux2-beat-analysis-contract.md；本区块只做 P0：
 * 分析当前/下一首 + 用节拍器边播边核对拍点，不改播放与切歌逻辑。
 * 宿主返回是同步等待（可能 1–5 s，在线曲目更久），所以按钮有 loading 与防重复点击。
 */

import '../styles/analysis-section.css';
import {
  initMetronome,
  metronomeSettings,
  onMetronomeChange,
  updateMetronomeSettings,
  type MetronomeSettings,
} from '../core/metronome';
import { analyzeTrack, cachedAnalysis, type AnalysisResult } from '../online/analysis';
import { h, icon, toast, type Disposers } from './dom';
import { onPlayer, playerState } from './player';

type StatusKind = 'idle' | 'loading' | 'ok' | 'warn' | 'error';

/** 构造「节拍分析（实验）」区块；scope 用于在设置弹窗关闭时退订。 */
export function buildAnalysisSection(scope: Disposers | null): HTMLElement {
  initMetronome();

  const runBtn = h(
    'button',
    { class: 'btn analysis-btn', type: 'button', 'data-qa': 'analysis-run', title: '分析当前正在播放的歌曲' },
    icon('sparkle', 15),
    h('span', { text: '分析当前歌曲' }),
  );
  const nextBtn = h(
    'button',
    { class: 'btn analysis-btn', type: 'button', 'data-qa': 'analysis-next', title: '分析队列里的下一首并缓存' },
    icon('next', 15),
    h('span', { text: '分析下一首' }),
  );

  const trackLine = h('div', { class: 'analysis-track', text: '当前没有正在播放的歌曲。' });
  const status = h('div', { class: 'analysis-status', 'data-qa': 'analysis-status' });
  const resultBox = h('div', { class: 'analysis-result', 'data-qa': 'analysis-result' });
  const metrics = h('div', { class: 'analysis-metrics' });
  const chips = h('div', { class: 'analysis-chips' });
  resultBox.append(metrics, chips);
  resultBox.hidden = true;

  const metronomeBtn = h('button', {
    class: 'analysis-toggle',
    type: 'button',
    'data-qa': 'analysis-metronome',
    'aria-pressed': 'false',
  });
  const volumeInput = h('input', { class: 'slider', type: 'range', min: '0', max: '100', step: '1' });
  const volumeValue = h('span', { class: 'analysis-volume-value', text: '50%' });
  const accentBtn = h('button', {
    class: 'analysis-toggle',
    type: 'button',
    'data-qa': 'analysis-accent',
    'aria-pressed': 'true',
  });
  const metronomeHint = h('div', { class: 'analysis-metronome-hint' });

  let busy = false;
  let playerPaintKey = '';

  /* ---------------------------- 状态区 ---------------------------- */

  function setStatus(message: string, kind: StatusKind, detail = ''): void {
    status.textContent = '';
    status.dataset.kind = kind;
    if (kind === 'loading') status.append(h('span', { class: 'analysis-spinner', 'aria-hidden': 'true' }));
    status.append(h('span', { class: 'analysis-status-text', text: message }));
    if (detail) status.append(h('span', { class: 'analysis-status-detail', text: detail }));
  }

  function setBusy(value: boolean): void {
    busy = value;
    runBtn.disabled = value;
    nextBtn.disabled = value;
    runBtn.classList.toggle('is-busy', value);
    nextBtn.classList.toggle('is-busy', value);
  }

  function formatElapsed(result: AnalysisResult): string {
    if (result.cached) return `缓存命中 · ${Math.max(1, Math.round(result.elapsedMs))} ms`;
    const ms = Math.max(0, Math.round(result.elapsedMs));
    return ms < 1000 ? `耗时 ${ms} ms` : `耗时 ${(ms / 1000).toFixed(1)} s`;
  }

  function showResult(result: AnalysisResult): void {
    const analysis = result.analysis;
    const rows: Array<[string, string]> = [
      ['BPM', analysis.bpm > 0 ? analysis.bpm.toFixed(1) : '—'],
      ['置信度', `${Math.round(analysis.bpmConfidence * 100)}%`],
      ['拍号', `${analysis.meter}/4`],
      ['拍号置信度', `${Math.round(analysis.meterConfidence * 100)}%`],
      ['拍间隔', `${analysis.beatIntervalMs.toFixed(1)} ms`],
      ['拍点偏移', `${Math.round(analysis.firstBeatMs)} ms`],
      ['小节数', String(Math.round(analysis.barCount))],
      ['乐句数', String(analysis.phraseStartsMs.length)],
    ];
    metrics.textContent = '';
    rows.forEach(([label, value]) => {
      metrics.append(
        h(
          'div',
          { class: 'analysis-metric' },
          h('span', { class: 'analysis-metric-label', text: label }),
          h('span', { class: 'analysis-metric-value', text: value }),
        ),
      );
    });
    chips.textContent = '';
    analysis.warnings.forEach((warning) => {
      chips.append(h('span', { class: 'analysis-chip', text: warningLabel(warning) }));
    });
    if (analysis.sections.length > 0) {
      chips.append(h('span', { class: 'analysis-chip', text: `段落 ${analysis.sections.length}` }));
    }
    chips.hidden = chips.childElementCount === 0;
    resultBox.hidden = false;
    setStatus(`已分析：${result.title || '当前歌曲'}`, 'ok', formatElapsed(result));
  }

  function clearResult(): void {
    resultBox.hidden = true;
    metrics.textContent = '';
    chips.textContent = '';
  }

  /* ---------------------------- 分析动作 ---------------------------- */

  async function runCurrent(): Promise<void> {
    if (busy) return;
    const track = playerState().track;
    if (!track) {
      clearResult();
      setStatus('当前没有正在播放的歌曲，请先播放一首。', 'warn');
      return;
    }
    clearResult();
    setBusy(true);
    setStatus(`正在分析「${track.title}」…`, 'loading', '本地约 1–5 秒；在线曲目需要先下载，可能更久。');
    try {
      const result = await analyzeTrack(track);
      showResult(result);
    } catch (err) {
      setStatus(`分析失败：${messageOf(err)}`, 'error');
    } finally {
      setBusy(false);
      paintMetronome();
    }
  }

  async function runNext(): Promise<void> {
    if (busy) return;
    const state = playerState();
    const nextTrack = state.queue[state.index + 1];
    if (!nextTrack) {
      setStatus('队列里没有下一首了。', 'warn');
      return;
    }
    setBusy(true);
    setStatus(`正在分析下一首「${nextTrack.title}」…`, 'loading', '结果会缓存在本次页面会话里，供后续自动衔接使用。');
    try {
      const result = await analyzeTrack(nextTrack);
      setStatus(
        `下一首「${result.title || nextTrack.title}」已分析并缓存`,
        'ok',
        `${result.analysis.bpm.toFixed(1)} BPM · ${result.analysis.meter}/4 · ${formatElapsed(result)}`,
      );
      toast(`已分析下一首：${nextTrack.title}`);
    } catch (err) {
      setStatus(`分析下一首失败：${messageOf(err)}`, 'error');
    } finally {
      setBusy(false);
      paintMetronome();
    }
  }

  /* ---------------------------- 节拍器 ---------------------------- */

  function paintMetronome(): void {
    const settings = metronomeSettings();
    metronomeBtn.textContent = settings.enabled ? '已开启' : '已关闭';
    metronomeBtn.classList.toggle('is-on', settings.enabled);
    metronomeBtn.setAttribute('aria-pressed', settings.enabled ? 'true' : 'false');
    const volume = Math.round(settings.volume * 100);
    volumeInput.value = String(volume);
    volumeValue.textContent = `${volume}%`;
    accentBtn.textContent = settings.accent ? '开' : '关';
    accentBtn.classList.toggle('is-on', settings.accent);
    accentBtn.setAttribute('aria-pressed', settings.accent ? 'true' : 'false');
    metronomeHint.textContent = metronomeHintText(settings);
  }

  function metronomeHintText(settings: MetronomeSettings): string {
    const state = playerState();
    const track = state.track;
    if (!settings.enabled) return '节拍器已关闭。';
    if (!track) return '当前没有播放歌曲；开始播放后才会按拍点发声。';
    if (!state.playing) return '当前已暂停；节拍器只在播放中发声。';
    const result = cachedAnalysis(track);
    if (!result) return '当前歌曲还没有分析结果，先点上方「分析当前歌曲」。';
    return `正在跟随「${track.title}」的拍点发声（${result.analysis.bpm.toFixed(1)} BPM · ${result.analysis.meter}/4）。`;
  }

  function paintPlayer(): void {
    const state = playerState();
    const track = state.track;
    trackLine.textContent = !track
      ? '当前没有正在播放的歌曲。'
      : `当前歌曲：${track.title}${track.artist ? ` — ${track.artist}` : ''}${state.playing ? '' : '（已暂停）'}`;
    const key = `${track?.source ?? ''}:${track?.id ?? ''}:${state.playing ? 1 : 0}:${track && cachedAnalysis(track) ? 1 : 0}`;
    if (key === playerPaintKey) return;
    playerPaintKey = key;
    paintMetronome();
  }

  runBtn.addEventListener('click', () => {
    void runCurrent();
  });
  nextBtn.addEventListener('click', () => {
    void runNext();
  });
  metronomeBtn.addEventListener('click', () => {
    const next = !metronomeSettings().enabled;
    updateMetronomeSettings({ enabled: next });
    if (next) toast('节拍器已开启：播放中会按拍点发声');
  });
  volumeInput.addEventListener('input', () => {
    updateMetronomeSettings({ volume: Number(volumeInput.value) / 100 });
  });
  accentBtn.addEventListener('click', () => {
    updateMetronomeSettings({ accent: !metronomeSettings().accent });
  });

  /* ---------------------------- 组装 ---------------------------- */

  const root = h('div', { class: 'analysis-section', 'data-qa': 'analysis-section' });
  root.append(
    h('h3', { class: 'section-title', text: '节拍分析（实验）' }),
    h('p', {
      class: 'analysis-desc',
      text: '分析当前歌曲的 BPM、拍号与拍点网格；开启节拍器可边播边核对 click 是否落在拍点上（强拍更高音）。',
    }),
    h('div', { class: 'analysis-actions' }, runBtn, nextBtn),
    trackLine,
    status,
    resultBox,
    h(
      'div',
      { class: 'analysis-metronome' },
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '节拍器' }),
          h('div', { class: 'field-hint', text: '按分析出的拍点发声；仅播放中生效' }),
        ),
        metronomeBtn,
      ),
      h(
        'div',
        { class: 'field' },
        h('div', { class: 'field-label', text: '节拍器音量' }),
        h('div', { class: 'analysis-volume-control' }, volumeValue, volumeInput),
      ),
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '强拍加重' }),
          h('div', { class: 'field-hint', text: '每小节第一拍用更高音（1760 Hz / 1046 Hz）' }),
        ),
        accentBtn,
      ),
      metronomeHint,
    ),
    h('p', {
      class: 'analysis-footnote',
      text: '节拍器只在播放中生效；暂停、拖动进度或切歌会自动清空待发 click。分析结果只缓存在本次页面会话中，重复分析同一首会直接命中缓存。',
    }),
  );

  scope?.add(onPlayer(() => paintPlayer()));
  scope?.add(onMetronomeChange(() => paintMetronome()));
  paintPlayer();
  paintMetronome();
  setStatus('选择「分析当前歌曲」或「分析下一首」开始。', 'idle');
  return root;
}

function warningLabel(warning: string): string {
  if (warning === 'tempo-drift') return '速度有起伏';
  if (warning === 'low-confidence') return '低置信度';
  if (warning === 'mono-mix') return '单声道混音';
  return warning;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
