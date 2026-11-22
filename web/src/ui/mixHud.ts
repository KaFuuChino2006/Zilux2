/**
 * 「混音实时浮层」——开发者选项里的透明面板，把一次过渡里所有会动的量摊开给你看。
 *
 * 显示层只读：每帧只调 `crossfadeLiveSnapshot()` 拿一份纯数据快照，再改 DOM 文本与宽度，
 * 不碰混音计划的任何 AudioParam —— 否则用户看到的曲线就不是他听到的那条。
 *
 * 唯一会改声音的是底部「分轨试听」那一块：它把宿主真分离的四轨（残差已归位，
 * 四轨相加 == 原音）单独放出来、各自可调、可独听，用来确认「这一层到底是什么乐器」。
 * 它走独立监听路（`stemMonitorBus`），不参与混音过渡的任何曲线。
 *
 * 刷新率 20 Hz：再快人眼在数字上也读不出来，反而把主线程让给 rAF 动画；
 * 再慢（500 ms 那种）就看不出低频换手那 0.3 秒的交叉。
 */

import { h } from './dom';
import { clampHudPosition } from './hudGeometry';
import { crossfadeLiveSnapshot, type MixDeckSnapshot, type MixLiveSnapshot } from './crossfadeDeck';
import { setStemMonitor, stemMonitorState } from '../core/audioTap';
import { liveAutomixV2Count } from '../audio/automixV2Graph';
import { playerState } from './player';
import { startStemLive, type StemLiveHandle } from '../audio/stemLive';
import { STEM_LABELS, STEM_NAMES, type StemName } from '../audio/stemSolo';
import {
  clearStemLog,
  formatStemLog,
  formatStemLogLine,
  pushStemLog,
  readStemGains,
  readStemLog,
  writeStemGains,
  type StemGains,
} from '../core/automix/stemLog';

const HUD_POS_KEY = 'zilux2.dev.mixhud.pos';
// 每帧刷新（≈60fps）：50ms 会让人误以为「数据更新慢」，实际是刷新率不够看
const REFRESH_MS = 16;

export interface MixHudHandle {
  root: HTMLElement;
  start: () => void;
  stop: () => void;
  dispose: () => void;
}

interface BarRef {
  fill: HTMLElement;
  value: HTMLElement;
}

function makeBar(label: string): { row: HTMLElement; ref: BarRef } {
  const fill = h('i', { class: 'mixhud-bar-fill' });
  const value = h('span', { class: 'mixhud-bar-value', text: '–' });
  const row = h(
    'div',
    { class: 'mixhud-bar' },
    h('span', { class: 'mixhud-bar-label', text: label }),
    h('span', { class: 'mixhud-bar-track' }, fill),
    value,
  );
  return { row, ref: { fill, value } };
}

function setBar(ref: BarRef, ratio: number | null, text?: string): void {
  if (ratio === null || !Number.isFinite(ratio)) {
    ref.fill.style.width = '0%';
    ref.value.textContent = text ?? '–';
    return;
  }
  const clamped = Math.max(0, Math.min(1, ratio));
  ref.fill.style.width = `${(clamped * 100).toFixed(1)}%`;
  ref.value.textContent = text ?? clamped.toFixed(2);
}

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function kb(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
}

/** 一行「标签 值」，值可被跨帧更新。 */
function makeKv(label: string): { row: HTMLElement; value: HTMLElement } {
  const value = h('span', { class: 'mixhud-kv-value', text: '–' });
  const row = h(
    'div',
    { class: 'mixhud-kv' },
    h('span', { class: 'mixhud-kv-key', text: label }),
    value,
  );
  return { row, value };
}

interface DeckView {
  title: HTMLElement;
  meta: HTMLElement;
  pos: HTMLElement;
  vocal: BarRef;
  drum: BarRef;
  bass: BarRef;
  chainLow: BarRef;
  chainHigh: BarRef;
  chain: HTMLElement;
  rate: HTMLElement;
  beat: BarRef;
}

function makeDeckView(side: string): { root: HTMLElement; view: DeckView } {
  const title = h('div', { class: 'mixhud-deck-title', text: `${side} · —` });
  const meta = h('div', { class: 'mixhud-deck-meta', text: '—' });
  const pos = h('div', { class: 'mixhud-deck-pos', text: '0:00 / 0:00' });
  const vocal = makeBar('人声');
  const drum = makeBar('鼓');
  const bass = makeBar('低音');
  const beat = makeBar('拍相');
  const chainLow = makeBar('低频增益');
  const chainHigh = makeBar('高频增益');
  const chain = h('div', { class: 'mixhud-deck-chain', text: '链路 —' });
  const rate = h('div', { class: 'mixhud-deck-rate', text: '速率 ×1.000' });
  const root = h(
    'div',
    { class: 'mixhud-deck' },
    title,
    meta,
    pos,
    vocal.row,
    drum.row,
    bass.row,
    beat.row,
    chainLow.row,
    chainHigh.row,
    chain,
    rate,
  );
  return { root, view: { title, meta, pos, vocal: vocal.ref, drum: drum.ref, bass: bass.ref, beat: beat.ref, chainLow: chainLow.ref, chainHigh: chainHigh.ref, chain, rate } };
}

function paintDeck(view: DeckView, deck: MixDeckSnapshot | null, side: string): void {
  if (!deck) {
    view.title.textContent = `${side} · —`;
    view.meta.textContent = '—';
    view.pos.textContent = '0:00 / 0:00';
    setBar(view.vocal, null);
    setBar(view.drum, null);
    setBar(view.bass, null);
    setBar(view.beat, null);
    setBar(view.chainLow, null);
    setBar(view.chainHigh, null);
    view.chain.textContent = '链路 —';
    view.rate.textContent = '速率 ×1.000';
    return;
  }
  view.title.textContent = `${side} · ${deck.title || '—'}`;
  const key = deck.camelot ? `${deck.camelot}${deck.key ? ` (${deck.key})` : ''}` : (deck.key || '—');
  view.meta.textContent = `${deck.bpm || '—'} BPM · ${key} · 第 ${deck.bar || '—'} 小节`;
  view.pos.textContent = `${fmtMs(deck.songMs)} / ${fmtMs(deck.durationMs)}`;
  setBar(view.vocal, deck.layers.vocal);
  setBar(view.drum, deck.layers.drum);
  setBar(view.bass, deck.layers.bass);
  // 拍相画「离下一拍还有多远」：满格 = 刚过拍，空格 = 马上到拍
  setBar(view.beat, deck.bpm > 0 ? 1 - deck.beatPhase : null);
  if (deck.chain) {
    // 增益必须读 dB：之前画的是「(dB+60)/60」的归一值，0 dB（= 原样）会显示成 1.00，
    // 看着像「把增益拉满了」。现在 0 dB 落在 50% 刻度、文字直接写 dB。
    const fmtGain = (db: number): string =>
      Math.abs(db) < 0.05 ? '0.0 dB（原样）' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
    setBar(view.chainLow, 0.5 + deck.chain.lowDb / 48, fmtGain(deck.chain.lowDb));
    setBar(view.chainHigh, 0.5 + deck.chain.highDb / 48, fmtGain(deck.chain.highDb));
    const unfade = deck.chain.unfadeDb >= 0.1 ? ` · 补回 +${deck.chain.unfadeDb.toFixed(1)}dB` : '';
    const flat =
      Math.abs(deck.chain.lowDb) < 0.05 &&
      Math.abs(deck.chain.highDb) < 0.05 &&
      Math.abs(deck.chain.duckDb) < 0.05 &&
      deck.chain.unfadeDb < 0.1 &&
      deck.chain.sweepLpHz >= 19_900 &&
      deck.chain.sweepHpHz <= 25
        ? ' · 直通（未改动）'
        : '';
    view.chain.textContent = `分频 ${deck.chain.splitHz}Hz · LP ${kb(deck.chain.sweepLpHz)} ↔ HP ${kb(deck.chain.sweepHpHz)} · duck ${deck.chain.duckDb}dB${unfade} · gate ${deck.chain.gate}${flat}`;
  } else {
    setBar(view.chainLow, null);
    setBar(view.chainHigh, null);
    view.chain.textContent = '链路 未接管（等功率 / 元素音量）';
  }
  view.rate.textContent = `速率 ×${deck.playbackRate.toFixed(3)}`;
}

export function createMixHud(): MixHudHandle {
  const phase = h('span', { class: 'mixhud-phase', text: 'idle' });
  const progressFill = h('i', { class: 'mixhud-progress-fill' });
  const progressText = h('span', { class: 'mixhud-progress-text', text: '0%' });
  const progress = h(
    'div',
    { class: 'mixhud-progress' },
    h('span', { class: 'mixhud-progress-track' }, progressFill),
    progressText,
  );

  const styleKv = makeKv('风格');
  const formKv = makeKv('形态');
  const lengthKv = makeKv('时长');
  const rateKv = makeKv('B 速率');
  const pllKv = makeKv('PLL');
  const phaseErrKv = makeKv('拍相差');
  const windowKv = makeKv('低频换手');
  const holdKv = makeKv('A 保持');
  const bridgeKv = makeKv('结构桥接');
  const duckKv = makeKv('人声让位');
  const reverbKv = makeKv('尾段混响');
  const reverbLiveKv = makeKv('混响实时');
  const echoKv = makeKv('尾段回声');
  const techniqueKv = makeKv('过渡手法');
  const bpmPlanKv = makeKv('变速计划');
  const swapKv = makeKv('换手窗口');
  const unfadeKv = makeKv('渐隐补回');
  const handoffKv = makeKv('衔接');
  const bpmKv = makeKv('BPM');
  const bpmDeltaKv = makeKv('BPM 偏差');
  const phaseMsKv = makeKv('拍相差');
  const anchorKv = makeKv('唱词锚点');
  const melodyKv = makeKv('旋律相似');
  const lowLevelKv = makeKv('低频电平');
  const lowTrimKv = makeKv('低频校准');
  const toneKv = makeKv('A 音色');

  const qualityKv = makeKv('质量门');
  const bassBumpKv = makeKv('低频叠加');
  const vocalOverlapKv = makeKv('人声重叠');
  const loudnessKv = makeKv('响度漂移');
  const rateJumpKv = makeKv('速率跳变');
  const reasonsBox = h('div', { class: 'mixhud-reasons', text: '—' });
  const noteBox = h('div', { class: 'mixhud-note', text: '' });

  const deckA = makeDeckView('A 当前');
  const deckB = makeDeckView('B 下一首');

  const body = h(
    'div',
    { class: 'mixhud-body' },
    progress,
    h(
      'div',
      { class: 'mixhud-grid' },
      styleKv.row,
      formKv.row,
      lengthKv.row,
      handoffKv.row,
      rateKv.row,
      bpmKv.row,
      bpmDeltaKv.row,
      pllKv.row,
      phaseErrKv.row,
      phaseMsKv.row,
      anchorKv.row,
      melodyKv.row,
      windowKv.row,
      holdKv.row,
      bridgeKv.row,
      duckKv.row,
      reverbKv.row,
      reverbLiveKv.row,
      echoKv.row,
      techniqueKv.row,
      bpmPlanKv.row,
      swapKv.row,
      unfadeKv.row,
      lowLevelKv.row,
      lowTrimKv.row,
    ),
    h('div', { class: 'mixhud-sep' }),
    deckA.root,
    deckB.root,
    h('div', { class: 'mixhud-sep' }),
    voiceQuality(),
    reasonsBox,
    noteBox,
  );

  function voiceQuality(): HTMLElement {
    return h(
      'div',
      { class: 'mixhud-quality' },
      qualityKv.row,
      bassBumpKv.row,
      vocalOverlapKv.row,
      loudnessKv.row,
      rateJumpKv.row,
    );
  }

  // ---- 分轨试听（真实分离，取代原来的「区间 EQ」）----
  // 为什么换掉：EQ 只能按频率近似，贝斯和底鼓都挤在 60–120 Hz、纯人声的 300–3500 Hz
  // 里还混着吉他/钢琴/弦乐，靠频率永远拆不干净。宿主那边的 htdemucs 四轨已经把
  // 「原音 − 四轨之和」的残差归位进 other，所以四轨相加 == 原音，可以 A/B 对照。
  const stemGains: StemGains = readStemGains();
  let lastSnap: MixLiveSnapshot | null = null;
  let stemHandle: StemLiveHandle | null = null;
  let stemBusy = false;
  /** 元素是否已被静音（分轨接管中）。只有真开始出声才静音，避免「一按就静 7 秒」。 */
  let stemMonitorOn = false;
  /** 上一次「分轨真的在出声」的时刻（performance.now，毫秒）——静音要带迟滞，否则窗口切换时会闪。 */
  let stemAudibleAt = 0;
  let diagTick = 0;
  /** 静音迟滞：分轨短暂 preparing/stalled 时继续静音原音，超时才放开。 */
  const STEM_MUTE_HOLD_MS = 900;

  const noteInput = h('input', {
    class: 'mixhud-eq-note',
    type: 'text',
    placeholder: '备注（可选，如「贝斯糊」）',
  }) as HTMLInputElement;
  const logCount = h('span', { class: 'mixhud-eq-count', text: '0 条' });
  const lastLogLine = h('div', { class: 'mixhud-eq-last', text: '—' });
  const stemStatus = h('div', { class: 'mixhud-stem-status', text: '关闭（听原音）' });
  // 开发者诊断：v2 链是否只有一条（>2 说明有并联残留，会听成「低音变重 + 梳状混响」）。
  const v2Kv = makeKv('v2 链');
  const v2Bypass = h('input', { type: 'checkbox', class: 'mixhud-stem-check' }) as HTMLInputElement;
  try {
    v2Bypass.checked = window.localStorage.getItem('zilux2.dev.v2bypass') === '1';
  } catch {
    /* 忽略 */
  }
  v2Bypass.addEventListener('change', () => {
    try {
      if (v2Bypass.checked) window.localStorage.setItem('zilux2.dev.v2bypass', '1');
      else window.localStorage.removeItem('zilux2.dev.v2bypass');
    } catch {
      /* 忽略 */
    }
  });
  const v2BypassRow = h('label', { class: 'mixhud-stem-bypass' });
  v2BypassRow.append(v2Bypass, h('span', { text: '直通对比（下一次过渡不进 v2 链）' }));

  // 短首句（600–1200 ms）是否算「第一句」：Attention 这类歌第一句只有 750 ms，
  // 关掉时按 1.2 s 门槛走，避免春めく 前奏第 2 秒的呼吸峰被当成第一句。（m04294）
  const shortLine = h('input', { type: 'checkbox', class: 'mixhud-stem-check' }) as HTMLInputElement;
  try {
    shortLine.checked = window.localStorage.getItem('zilux2.dev.shortline') === '1';
  } catch {
    /* 忽略 */
  }
  shortLine.addEventListener('change', () => {
    try {
      if (shortLine.checked) window.localStorage.setItem('zilux2.dev.shortline', '1');
      else window.localStorage.removeItem('zilux2.dev.shortline');
    } catch {
      /* 忽略 */
    }
  });
  const shortLineRow = h('label', { class: 'mixhud-stem-bypass' });
  shortLineRow.append(shortLine, h('span', { text: '短句也算第一句（<1.2 s）' }));

  const refreshLogCount = (): void => {
    const log = readStemLog();
    logCount.textContent = `${log.length} 条`;
    lastLogLine.textContent = log.length > 0 ? formatStemLogLine(log[log.length - 1]) : '—';
    (window as unknown as { __ziluxStemLog?: () => unknown }).__ziluxStemLog = () => readStemLog();
  };

  const recordStem = (): void => {
    const snap = lastSnap;
    pushStemLog({
      at: new Date().toISOString(),
      track: snap?.a?.title ?? '',
      posMs: Math.round(snap?.a?.songMs ?? snap?.a?.posMs ?? 0),
      phase: snap?.phase ?? 'idle',
      gains: { ...stemGains },
      solo: stemSolo,
      reconDbfs: stemHandle ? stemHandle.status().reconDbfs : Number.NaN,
      note: noteInput.value.trim() || undefined,
    });
    refreshLogCount();
  (window as unknown as { __ziluxStemState?: () => unknown }).__ziluxStemState = () => stemMonitorState();
  };

  let stemSolo: StemName | null = null;
  const rows: { stem: StemName; range: HTMLInputElement; value: HTMLElement; soloBtn: HTMLButtonElement }[] = [];

  const syncRows = (): void => {
    for (const row of rows) {
      const db = stemGains[row.stem];
      row.range.value = String(db);
      row.value.textContent = db <= -47.5 ? '静音' : `${db >= 0 ? '+' : ''}${db.toFixed(1)}dB`;
      row.value.classList.toggle('is-bad', stemSolo !== null && stemSolo !== row.stem);
      row.soloBtn.classList.toggle('is-on', stemSolo === row.stem);
      row.range.disabled = !stemHandle && !stemBusy;
      row.soloBtn.disabled = !stemHandle && !stemBusy;
    }
  };

  const applyStemGains = (): void => {
    writeStemGains(stemGains);
    if (!stemHandle) return;
    for (const stem of STEM_NAMES) stemHandle.setGain(stem, stemGains[stem]);
    stemHandle.setSolo(stemSolo);
  };

  const stopStems = (message: string): void => {
    stemHandle?.dispose();
    stemHandle = null;
    stemSolo = null;
    stemMonitorOn = false;
    stemAudibleAt = 0;
    setStemMonitor(false);
    stemToggle.classList.remove('is-on');
    stemToggle.textContent = '实时分轨';
    stemStatus.textContent = message;
    syncRows();
  };

  const describeLive = (): void => {
    const handle = stemHandle;
    if (!handle) return;
    const st = handle.status();
    const recon = Number.isFinite(st.reconDbfs) ? `残差 ${Math.round(st.reconDbfs)} dBFS` : '残差未知';
    const ahead = st.aheadMs > 0 ? `领先 ${(st.aheadMs / 1000).toFixed(0)}s` : '已排到此刻';
    const windowSec = (st.window * 30 + st.windowOffsetMs / 1000).toFixed(0);
    const tag =
      st.state === 'playing' ? '实时' : st.state === 'preparing' ? '准备中' : st.state === 'stalled' ? '卡住' : st.state === 'paused' ? '暂停' : '已停';
    // 过渡里同时有两首歌在响，而分轨只跟「当前曲目」——这时候硬静音原音会把 B 丢掉。
    // 所以过渡期间临时回原音，过渡结束（phase 回到 idle）自动接回分轨。
    const inTransition = Boolean(lastSnap && lastSnap.phase !== 'idle');
    const gate = stemMonitorState();
    const gateText = gate.active
      ? `整机静音（总输出 ${gate.master <= 0.01 ? '0' : gate.master} · 元素 ${gate.mutedElements} · 分轨 ${gate.stemOut}）`
      : '未静音（原音还在）';
    stemStatus.textContent = `${tag} · 窗口 ${st.window}（${windowSec}s）· ${ahead} · ${recon} · ${gateText}${
      inTransition ? ' · 过渡中暂回原音' : ''
    }${st.state === 'stalled' ? ` · ${st.note}` : ''}`;
    stemStatus.classList.toggle('is-bad', st.state === 'stalled');
    // 静音判定要带迟滞：
    // - `playing` → 立刻静音原音（这是「分轨试听」的语义，用户听的是四轨合成）
    // - 短暂 `preparing`（预取下一窗口、resync）→ **继续保持静音**，否则会听到
    //   「原音突然回来又消失」的抖动
    // - `stalled`/`paused` 超过 STEM_MUTE_HOLD_MS → 放开原音，避免一直静场
    // - 过渡中（两首歌同时在响）→ 立即放开，否则会把 B 丢掉
    const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (st.state === 'playing') stemAudibleAt = nowMs;
    const recentlyAudible = stemAudibleAt > 0 && nowMs - stemAudibleAt < STEM_MUTE_HOLD_MS;
    // 用户要求：**一打开分轨试听，原音就必须彻底静音**，否则听不清分离到底有没有。
    // 所以 `preparing` 也算「要静音」——按下去就静，准备那几秒显示「准备中（原音已静音）」。
    const shouldMute = !inTransition && (st.state === 'playing' || st.state === 'preparing' || recentlyAudible);
    if (shouldMute !== stemMonitorOn) {
      stemMonitorOn = shouldMute;
      setStemMonitor(shouldMute);
    }
  };

  const startStems = (): void => {
    if (stemHandle || stemBusy) return;
    // 关键：四轨在 0 dB 相加 == 原音（分离残差已归位到 other），
    // 所以「全轨 0 dB」听起来就是原唱没被静音。默认独听人声，一按就有区别。
    if (stemSolo === null && STEM_NAMES.every((name) => Math.abs(stemGains[name]) < 0.05)) {
      stemSolo = 'vocals';
    }
    const state = playerState();
    if (!state.track) {
      stemStatus.textContent = '没有正在播放的曲目';
      return;
    }
    stemBusy = true;
    const handle = startStemLive({
      getTrack: () => playerState().track,
      getPositionMs: () => {
        const live = playerState();
        return Math.round(live.positionMs || 0);
      },
      isPlaying: () => playerState().playing,
      getRate: () => playerState().rate,
      gainsDb: { ...stemGains },
      solo: stemSolo,
      onStatus: () => describeLive(),
    });
    stemBusy = false;
    if (!handle) {
      stemStatus.textContent = '音频图还没建好，稍后再试';
      syncRows();
      return;
    }
    stemHandle = handle;
    stemToggle.classList.add('is-on');
    stemToggle.textContent = '回到原音';
    applyStemGains();
    syncRows();
    describeLive();
  };

  const stemToggle = h('button', {
    class: 'mixhud-btn mixhud-stem-toggle',
    type: 'button',
    text: '实时分轨',
    title: '跟着播放实时分离（人声/鼓/贝斯/其他），可各自调增益、可独听；再按一次回到原音',
  });
  stemToggle.addEventListener('click', () => {
    if (stemHandle || stemBusy) {
      stopStems('关闭（听原音）');
      return;
    }
    void startStems();
  });

  const buildStemRow = (stem: StemName): HTMLElement => {
    const range = h('input', {
      class: 'mixhud-eq-range',
      type: 'range',
      min: '-48',
      max: '6',
      step: '0.5',
    }) as HTMLInputElement;
    const value = h('span', { class: 'mixhud-eq-val', text: '0.0dB' });
    const soloBtn = h('button', {
      class: 'mixhud-btn is-small',
      type: 'button',
      text: '独听',
      title: `只听${STEM_LABELS[stem]}`,
    });
    const row = { stem, range, value, soloBtn };
    rows.push(row);

    range.addEventListener('input', () => {
      stemGains[stem] = Math.max(-48, Math.min(6, Number(range.value)));
      writeStemGains(stemGains);
      if (stemHandle) stemHandle.setGain(stem, stemGains[stem]);
      syncRows();
    });
    range.addEventListener('change', () => recordStem());
    soloBtn.addEventListener('click', () => {
      stemSolo = stemSolo === stem ? null : stem;
      if (stemHandle) stemHandle.setSolo(stemSolo);
      syncRows();
      recordStem();
    });

    return h(
      'div',
      { class: 'mixhud-stem-line' },
      h('span', { class: 'mixhud-stem-tag', text: STEM_LABELS[stem] }),
      range,
      value,
      soloBtn,
    );
  };

  const stemBody = h('div', { class: 'mixhud-stem' }, ...STEM_NAMES.map((stem) => buildStemRow(stem)));

  const stemCapture = h('button', { class: 'mixhud-btn is-small', type: 'button', text: '记录' });
  stemCapture.addEventListener('click', () => recordStem());
  const stemCopy = h('button', { class: 'mixhud-btn is-small', type: 'button', text: '复制' });
  stemCopy.addEventListener('click', () => {
    const text = formatStemLog(readStemLog());
    void navigator.clipboard?.writeText(text).then(
      () => {
        stemCopy.textContent = '已复制';
        window.setTimeout(() => (stemCopy.textContent = '复制'), 1200);
      },
      () => {
        lastLogLine.textContent = text;
      },
    );
  });
  const stemReset = h('button', { class: 'mixhud-btn is-small', type: 'button', text: '归零' });
  stemReset.addEventListener('click', () => {
    stemGains.vocals = 0;
    stemGains.drums = 0;
    stemGains.bass = 0;
    stemGains.other = 0;
    stemSolo = null;
    applyStemGains();
    syncRows();
  });
  const stemClear = h('button', { class: 'mixhud-btn is-small', type: 'button', text: '清空' });
  stemClear.addEventListener('click', () => {
    clearStemLog();
    refreshLogCount();
  });
  syncRows();
  refreshLogCount();

  const stemSection = h(
    'div',
    { class: 'mixhud-eqbox' },
    h('div', { class: 'mixhud-sep' }),
    h('div', { class: 'mixhud-eq-title', text: '分轨试听（真实分离）' }),
    h('div', { class: 'mixhud-stem-head' }, stemToggle, stemStatus),
    stemBody,
    h('div', { class: 'mixhud-stem-actions' }, noteInput, stemCapture, stemCopy, stemReset, stemClear, logCount),
    lastLogLine,
    v2BypassRow,
    shortLineRow,
    h('div', { class: 'mixhud-eq-line' }, v2Kv.row),
  );
  // body 在 stemSection 之前就建好了，这里按 DOM 顺序插到「质量门」那一分隔线之前。
  const separators = body.querySelectorAll('.mixhud-sep');
  body.insertBefore(stemSection, separators.length > 1 ? separators[1] : null);

  const closeBtn = h('button', { class: 'mixhud-btn', type: 'button', text: '×', title: '收起' });
  const header = h(
    'div',
    { class: 'mixhud-header' },
    h('span', { class: 'mixhud-dot' }),
    h('span', { class: 'mixhud-title', text: '混音实时' }),
    phase,
    closeBtn,
  );
  const root = h('div', { class: 'mixhud', 'data-mixhud': '1' }, header, body);
  // 可拖动改变大小：CSS resize 只改内联宽高，这里负责记住（拖动结束/松手时落盘）。
  const HUD_SIZE_KEY = 'zilux2.dev.mixhud.size';
  try {
    const saved = JSON.parse(window.localStorage.getItem(HUD_SIZE_KEY) || 'null') as { w?: number; h?: number } | null;
    if (saved && Number(saved.w) >= 300) root.style.width = `${Math.round(Number(saved.w))}px`;
    if (saved && Number(saved.h) >= 240) root.style.height = `${Math.round(Number(saved.h))}px`;
  } catch { /* 坏数据就当没存过 */ }
  const saveHudSize = (): void => {
    const w = Math.round(root.getBoundingClientRect().width);
    const h = Math.round(root.getBoundingClientRect().height);
    if (w < 300 || h < 240) return;
    try { window.localStorage.setItem(HUD_SIZE_KEY, JSON.stringify({ w, h })); } catch { /* 忽略 */ }
  };
  root.addEventListener('pointerup', saveHudSize);

  // 位置必须夹进当前视口：双屏拖到 x=2400 再拔掉副屏，restore 会把浮层整个放到屏幕外，
  //   标题栏都点不到 → 用户只能清 localStorage 才能找回来。
  const clampHudPos = (x: number, y: number): { x: number; y: number } =>
    clampHudPosition(x, y, window.innerWidth, window.innerHeight);

  // ---- 拖动：位置存 localStorage，下次开还是原位。只绑 header，避免挡住选中文本。
  const restorePos = (): void => {
    try {
      const raw = localStorage.getItem(HUD_POS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as { x?: number; y?: number };
      if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return;
      const pos = clampHudPos(parsed.x, parsed.y);
      root.style.left = `${pos.x}px`;
      root.style.top = `${pos.y}px`;
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    } catch {
      /* 隐私模式 / 脏数据：用默认位置 */
    }
  };
  restorePos();

  // 一个 resize 监听同时管两件事：记住尺寸、把位置夹回视口（窗口被缩小/换屏时不至于跑丢）。
  //   以前 saveHudSize 是匿名注册的、dispose 时没摘，浮层关掉后 resize 还在跑（还拽着 root）。
  const onViewportResize = (): void => {
    if (root.style.left) {
      const rect = root.getBoundingClientRect();
      const pos = clampHudPos(rect.left, rect.top);
      root.style.left = `${pos.x}px`;
      root.style.top = `${pos.y}px`;
    }
    saveHudSize();
  };
  window.addEventListener('resize', onViewportResize);
  root.hidden = true;

  let drag: { pointerId: number; offsetX: number; offsetY: number } | null = null;
  header.addEventListener('pointerdown', (event) => {
    if (event.target === closeBtn) return;
    const rect = root.getBoundingClientRect();
    drag = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    header.setPointerCapture(event.pointerId);
    root.classList.add('is-dragging');
  });
  header.addEventListener('pointermove', (event) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = Math.max(0, Math.min(window.innerWidth - 120, event.clientX - drag.offsetX));
    const y = Math.max(0, Math.min(window.innerHeight - 60, event.clientY - drag.offsetY));
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  });
  const endDrag = (event: PointerEvent): void => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag = null;
    root.classList.remove('is-dragging');
    try {
      const rect = root.getBoundingClientRect();
      localStorage.setItem(HUD_POS_KEY, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }));
    } catch {
      /* 存不了就算了，位置只在本次会话有效 */
    }
  };
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);

  let collapsed = false;
  closeBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    body.hidden = collapsed;
    closeBtn.textContent = collapsed ? '＋' : '×';
    closeBtn.title = collapsed ? '展开' : '收起';
  });

  let raf = 0;
  let lastPaint = 0;

  let paintTick = 0;
  const paint = (snap: MixLiveSnapshot): void => {
    lastSnap = snap;
    // 实时分轨的状态行节流刷新（每 12 帧 ≈ 200 ms），避免每帧重排字符串。
    if (stemHandle && (paintTick += 1) % 12 === 0) describeLive();
    if ((diagTick += 1) % 12 === 0) {
      const live = liveAutomixV2Count();
      v2Kv.value.textContent = live === 0 ? '空闲' : live <= 2 ? `${live} 条（正常）` : `${live} 条 ⚠ 并联`;
      v2Kv.value.classList.toggle('is-bad', live > 2);
    }
    // 兜底：分轨已停（dispose/失败）但静音还挂着 —— 任何路径漏掉都要能自己恢复，
    // 否则表现就是「分轨关了，歌也不出声了」。
    if (!stemHandle && stemMonitorOn) {
      stemMonitorOn = false;
      stemAudibleAt = 0;
      setStemMonitor(false);
    }
    phase.textContent = snap.phase === 'fading' ? `淡化 ${(snap.progress * 100).toFixed(0)}%` : snap.phase;
    phase.className = `mixhud-phase is-${snap.phase}`;
    progressFill.style.width = `${(Math.max(0, Math.min(1, snap.progress)) * 100).toFixed(1)}%`;
    progressText.textContent = `${(snap.progress * 100).toFixed(0)}% · ${fmtMs(snap.elapsedMs)} / ${fmtMs(snap.fadeMs)}`;

    styleKv.value.textContent = `${snap.style}${snap.kind ? ` · ${snap.kind}` : ''}`;
    formKv.value.textContent = snap.form ?? '—';
    const bars = snap.totalBars > 0 ? `${snap.totalBars} 小节 × ${Math.round(snap.barMs)}ms` : '—';
    lengthKv.value.textContent = `${snap.fadeMs}ms · ${bars}`;
    handoffKv.value.textContent = snap.handoff
      ? `歌词衔接${snap.vocalAligned ? ' · 唱词对齐' : ''}`
      : snap.vocalAligned
        ? '唱词对齐'
        : '否';
    rateKv.value.textContent = `×${snap.tempoRate.toFixed(3)} → ×${snap.tempoRateLive.toFixed(3)}`;
    pllKv.value.textContent = snap.pllActive ? `锁定 · ${snap.pllErrBeats.toFixed(2)} 拍` : '空闲';
    phaseErrKv.value.textContent = snap.phaseErrorBeats === null ? '—' : `${snap.phaseErrorBeats.toFixed(3)} 拍`;
    phaseMsKv.value.textContent = snap.phaseErrorMs === null ? '—' : `${snap.phaseErrorMs} ms`;
    phaseMsKv.value.classList.toggle(
      'is-bad',
      snap.phaseErrorMs !== null && Math.abs(snap.phaseErrorMs) > 15,
    );
    const aBpm = snap.a?.bpmLive ?? 0;
    const bBpm = snap.b?.bpmLive ?? 0;
    bpmKv.value.textContent =
      aBpm > 0 || bBpm > 0 ? `${aBpm.toFixed(1)} → ${bBpm.toFixed(1)}` : '—';
    bpmDeltaKv.value.textContent =
      snap.bpmDeltaPct === null
        ? '—'
        : `${snap.bpmDeltaPct > 0 ? '+' : ''}${snap.bpmDeltaPct.toFixed(2)} %`;
    bpmDeltaKv.value.classList.toggle('is-bad', snap.bpmDeltaPct !== null && Math.abs(snap.bpmDeltaPct) > 20);
    // 锚点要写清"这是靠什么锚的"：vocal=唱句，instrumental=器乐尾段结构点。
    const anchorKind = snap.vocalAnchor?.kind ?? 'vocal';
    const anchorLabel = anchorKind === 'instrumental' ? 'A 让位' : 'A 末句';
    anchorKv.value.textContent = snap.vocalAnchor
      ? `${anchorLabel} ${fmtMs(snap.vocalAnchor.aLastEndMs) || '—'} · B 入口 ${fmtMs(snap.vocalAnchor.bEntryMs) || '—'}${
          anchorKind === 'instrumental'
            ? `（器乐 · 尾段 ${snap.vocalAnchor.instrumentalBars ?? 0} 小节）`
            : ''
        }`
      : '—';
    anchorKv.value.classList.toggle('is-bad', anchorKind === 'instrumental' && !snap.vocalAnchor?.aLastEndMs);
    const melody = snap.vocalAnchor?.melodySim ?? 0;
    melodyKv.value.textContent = melody > 0 ? `${(melody * 100).toFixed(0)} %` : '—';
    melodyKv.value.classList.toggle('is-bad', melody > 0 && melody < 0.62);
    const lowA = snap.a?.chain?.lowLevelDb ?? null;
    const lowB = snap.b?.chain?.lowLevelDb ?? null;
    lowLevelKv.value.textContent =
      lowA === null && lowB === null
        ? '—'
        : `${lowA === null ? '—' : `${lowA.toFixed(1)}`} / ${lowB === null ? '—' : `${lowB.toFixed(1)}`} dB`;
    const trim = snap.b?.chain?.lowTrimDb ?? null;
    lowTrimKv.value.textContent = trim === null ? '—' : `${trim > 0 ? '+' : ''}${trim.toFixed(1)} dB`;
    lowTrimKv.value.classList.toggle('is-bad', trim !== null && Math.abs(trim) > 3);
    // 「原曲到底有没有被动过」——tone 全 0 / 20k / 20Hz 才算干净；任何非 0 都标红。
    const toneA = snap.a?.tone ?? null;
    if (!toneA) {
      toneKv.value.textContent = '—';
      toneKv.value.classList.remove('is-bad');
    } else {
      const dirty =
        Math.abs(toneA.bassDb) > 0.05 ||
        Math.abs(toneA.lowDb) > 0.05 ||
        Math.abs(toneA.highDb) > 0.05 ||
        Math.abs(toneA.presenceDb) > 0.05 ||
        toneA.lowpassHz < 19_900 ||
        toneA.highpassHz > 25;
      toneKv.value.textContent = `低${toneA.bassDb} 架${toneA.lowDb} 高${toneA.highDb} 亮${toneA.presenceDb} · LP${toneA.lowpassHz} HP${toneA.highpassHz}`;
      toneKv.value.classList.toggle('is-bad', dirty);
    }
    windowKv.value.textContent = snap.handoffWindow
      ? `${(snap.handoffWindow[0] * 100).toFixed(0)}% → ${(snap.handoffWindow[1] * 100).toFixed(0)}%`
      : '—';
    holdKv.value.textContent = snap.aHoldP === null ? '—' : `${(snap.aHoldP * 100).toFixed(0)}%`;
    bridgeKv.value.textContent = snap.bridge
      ? `${snap.bridge.unitBars} 小节 × ${snap.bridge.passes} 遍${snap.bridgeActive ? ' · 播放中' : ''}`
      : '—';
    duckKv.value.textContent = snap.duckEvents > 0 ? `${snap.duckEvents} 个事件${snap.duckActive ? ' · 正在压' : ''}` : '—';
    if (reverbLiveKv) {
      const live = snap.reverbLive;
      reverbLiveKv.value.textContent = live
        ? `A ${live.aSendDb <= -119 ? '关' : `${live.aSendDb.toFixed(0)} dB`} · B ${
            live.bSendDb <= -119 ? '关' : `${live.bSendDb.toFixed(0)} dB`
          } · return ${live.returnDb} dB`
        : '—';
    }
    if (echoKv) {
      const ec = snap.echoLive;
      echoKv.value.textContent = ec
        ? `${ec.divBeats === 1 ? '1' : `1/${Math.round(1 / ec.divBeats)}`} 拍（${ec.delayMs}ms）· 反馈 ${ec.feedback.toFixed(2)} · ${ec.outDb} dB · 尾 ${(ec.tailMs / 1000).toFixed(1)}s · ${Math.round(ec.gain * 100)}%`
        : '—（只在 ≤4.2 s 的短过渡）';
    }
    if (techniqueKv) {
      const tech = snap.technique;
      techniqueKv.value.textContent = tech
        ? `${tech.label}（${tech.id}）${tech.reasons[0] ? ` · ${tech.reasons[0]}` : ''}`
        : '—';
    }
    if (bpmPlanKv) {
      const tp = snap.tempo;
      bpmPlanKv.value.textContent = tp
        ? tp.sameTempo
          ? `同速 ${tp.bpmA ?? tp.bpmB ?? '—'} BPM · 不变速（不需要拉拍）`
          : tp.inverted
          ? `A ${tp.bpmA ?? '—'} → ${tp.bpmATarget ?? '—'} BPM（×${tp.startRate.toFixed(3)}，现在 ×${tp.liveRate.toFixed(3)}）· B 原速 ${tp.bpmB ?? '—'} BPM · 目标＝下一首`
          : `B ${tp.bpmB ?? '—'} → ${tp.bpmBTarget ?? '—'} BPM（×${tp.startRate.toFixed(3)}，现在 ×${tp.liveRate.toFixed(3)}）· A 原速 · ${Math.round(tp.restoreAt * 100)}% 回正`
        : '—';
    }
    if (swapKv) {
      const sw = snap.swap;
      swapKv.value.textContent = sw
        ? `${(sw.startP * 100).toFixed(0)}% → ${(sw.endP * 100).toFixed(0)}% · B 前奏 ${(sw.introMs / 1000).toFixed(1)}s`
        : '—';
    }
    if (reverbKv) {
      const rv = snap.reverb;
      reverbKv.value.textContent = rv
        ? `A ${rv.sendDb} / B ${rv.sendDb - 9} dB · return ${rv.returnDb} dB · ${Math.round(rv.fromP * 100)}% 起 · 尾 ${Math.round(
            rv.tailMs,
          )} ms`
        : '本次无（非 v2 或未排程）';
      reverbKv.value.classList.toggle('is-bad', Boolean(rv && rv.sendDb <= -24));
    }
    unfadeKv.value.textContent = snap.tailFade
      ? `${snap.aUnfadeDb >= 0.1 ? `+${snap.aUnfadeDb.toFixed(1)} dB` : '待抬'} · 掉 ${snap.tailFade.dropDb} dB`
      : '—';

    const q = snap.quality;
    qualityKv.value.textContent = q ? (q.pass ? '通过' : `未通过（${q.failures.length}）`) : '—';
    qualityKv.value.classList.toggle('is-bad', Boolean(q && !q.pass));
    bassBumpKv.value.textContent = q ? `${q.bassBumpDb.toFixed(1)} dB` : '—';
    vocalOverlapKv.value.textContent = q ? `${q.vocalOverlapBeats.toFixed(2)} 拍` : '—';
    loudnessKv.value.textContent = q ? `${q.loudnessDriftLu.toFixed(1)} LU` : '—';
    rateJumpKv.value.textContent = q ? `${q.rateJumpPctPerBeat.toFixed(2)} %/拍` : '—';
    const lines = [...snap.reasons, ...(q ? q.suggestion : [])];
    reasonsBox.textContent = lines.length ? lines.join(' · ') : '—';
    noteBox.textContent = snap.note || '';

    paintDeck(deckA.view, snap.a, 'A 当前');
    paintDeck(deckB.view, snap.b, 'B 下一首');
  };

  let failed = false;
  const reportError = (error: unknown): void => {
    noteBox.textContent = `浮层读取失败：${String(error)}`;
    noteBox.classList.add('is-bad');
  };
  const tick = (now: number): void => {
    raf = 0;
    if (now - lastPaint >= REFRESH_MS) {
      lastPaint = now;
      try {
        paint(crossfadeLiveSnapshot());
      } catch (error) {
        // 浮层出错绝不能把整个设置页/播放页带下去：报一次，然后停在这里，
        // 用户看到的是错误文本而不是一个每 50ms 抛一次的死循环。
        failed = true;
        reportError(error);
        return;
      }
    }
    if (failed) return;
    raf = window.requestAnimationFrame(tick);
  };

  const halt = () => {
    if (raf) {
      window.cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  return {
    root,
    start: () => {
      if (raf) return;
      root.hidden = false;
      // 上一次异常不该让浮层永久冻结：每次打开重置失败标志，首帧也包在 try 里。
      failed = false;
      lastPaint = 0;
      try {
        paint(crossfadeLiveSnapshot());
      } catch (error) {
        failed = true;
        reportError(error);
      }
      raf = window.requestAnimationFrame(tick);
    },
    stop: () => {
      halt();
      root.hidden = true;
      // 浮层是唯一能按下「实时分轨」的地方：关掉浮层必须把静音与 stemLive 一起收回，
      // 否则整个应用永久静音（masterGate 0）、分轨还在后台播，页面上再没有按钮能停。
      stopStems('浮层关闭（听原音）');
      failed = false;
      lastPaint = 0;
    },
    dispose: () => {
      halt();
      stopStems('浮层关闭（听原音）');
      window.removeEventListener('resize', onViewportResize);
      root.remove();
    },
  };
}
