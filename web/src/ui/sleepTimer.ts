/**
 * 睡眠定时（桌面端小工具）：15/30/60/90 分钟、自定义分钟、或「播完当前曲」。
 *
 * - 存储键：`zilux2.sleepTimer`，`{ mode, endsAt, minutes, startedAt }`；刷新/重启后继续倒计时。
 * - 到时行为：dispatch `zilux:sleep-timer-fired` CustomEvent，并调用 startSleepTimer 传入的 onFire 回调
 *   （由 Lead 接「暂停播放」）。「播完当前曲」模式由 Lead 在曲目结束时调用 completeSleepTimer()。
 * - 剩余时间始终基于 Date.now() 计算，页面隐藏（rAF 节流）也不会漂移。
 */
import { h, icon, toast } from './dom';

export const SLEEP_TIMER_STORAGE_KEY = 'zilux2.sleepTimer';
export const SLEEP_TIMER_PRESET_MINUTES = [15, 30, 60, 90] as const;
export const SLEEP_TIMER_MIN_MINUTES = 1;
export const SLEEP_TIMER_MAX_MINUTES = 600;
/** 到时广播的事件名（detail: { mode, reason }）。 */
export const SLEEP_TIMER_FIRED_EVENT = 'zilux:sleep-timer-fired';
const TICK_MS = 500;

export type SleepTimerMode = 'minutes' | 'track-end';
export type SleepTimerInput = number | 'track-end';

export interface SleepTimerState {
  active: boolean;
  mode: SleepTimerMode | null;
  /** minutes 模式剩余毫秒；track-end / 未开启为 null。 */
  remainingMs: number | null;
  /** minutes 模式结束时间戳；track-end / 未开启为 null。 */
  endsAt: number | null;
  /** minutes 模式总时长（分钟）；track-end / 未开启为 null。 */
  minutes: number | null;
}

interface PersistedSleepTimer {
  mode: SleepTimerMode;
  endsAt: number | null;
  minutes: number | null;
  startedAt: number;
}

type Listener = (state: SleepTimerState) => void;

const listeners = new Set<Listener>();
let state: SleepTimerState = idleState();
let onFireCallback: (() => void) | null = null;
let tickTimer: number | null = null;
let currentStartedAt = 0;
let visibilityBound = false;

function idleState(): SleepTimerState {
  return { active: false, mode: null, remainingMs: null, endsAt: null, minutes: null };
}

/** 实时状态（minutes 模式的 remainingMs 按 Date.now() 重新计算）。 */
function currentState(): SleepTimerState {
  if (!state.active) return idleState();
  if (state.mode === 'minutes' && state.endsAt !== null) {
    return { ...state, remainingMs: Math.max(0, state.endsAt - Date.now()) };
  }
  return { ...state, remainingMs: null };
}

function emitState(): void {
  const payload = currentState();
  for (const listener of [...listeners]) {
    try {
      listener(payload);
    } catch (err) {
      console.warn('[sleepTimer] 订阅回调异常', err);
    }
  }
}

function persist(): void {
  try {
    if (!state.active || state.mode === null) {
      window.localStorage.removeItem(SLEEP_TIMER_STORAGE_KEY);
      return;
    }
    const payload: PersistedSleepTimer = {
      mode: state.mode,
      endsAt: state.endsAt,
      minutes: state.minutes,
      startedAt: currentStartedAt || Date.now(),
    };
    window.localStorage.setItem(SLEEP_TIMER_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[sleepTimer] 写入失败', err);
  }
}

function stopTicker(): void {
  if (tickTimer !== null) {
    window.clearInterval(tickTimer);
    tickTimer = null;
  }
}

function startTicker(): void {
  stopTicker();
  tickTimer = window.setInterval(tick, TICK_MS);
}

function tick(): void {
  if (!state.active || state.mode !== 'minutes' || state.endsAt === null) return;
  if (state.endsAt - Date.now() <= 0) {
    fireTimer('countdown');
    return;
  }
  emitState();
}

function fireTimer(reason: 'countdown' | 'track-end'): void {
  const firedMode = state.mode;
  const callback = onFireCallback;
  onFireCallback = null;
  stopTicker();
  state = idleState();
  currentStartedAt = 0;
  persist();
  emitState();
  window.dispatchEvent(new CustomEvent(SLEEP_TIMER_FIRED_EVENT, { detail: { mode: firedMode, reason } }));
  if (callback) {
    try {
      callback();
    } catch (err) {
      console.warn('[sleepTimer] onFire 回调异常', err);
    }
  }
}

function bindVisibility(): void {
  if (visibilityBound) return;
  visibilityBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.active) return;
    if (state.mode === 'minutes') tick();
    else emitState();
  });
}

function restore(): void {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(SLEEP_TIMER_STORAGE_KEY);
  } catch (err) {
    console.warn('[sleepTimer] 读取失败', err);
    return;
  }
  if (!raw) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn('[sleepTimer] 数据损坏，已清除', err);
    persist();
    return;
  }
  if (!parsed || typeof parsed !== 'object') {
    persist();
    return;
  }
  const record = parsed as { mode?: unknown; endsAt?: unknown; minutes?: unknown; startedAt?: unknown };
  const startedAt =
    typeof record.startedAt === 'number' && Number.isFinite(record.startedAt) ? record.startedAt : Date.now();

  if (record.mode === 'track-end') {
    state = { active: true, mode: 'track-end', remainingMs: null, endsAt: null, minutes: null };
    currentStartedAt = startedAt;
    return;
  }

  if (
    record.mode === 'minutes' &&
    typeof record.endsAt === 'number' &&
    Number.isFinite(record.endsAt)
  ) {
    if (record.endsAt <= Date.now()) {
      // 已过期：静默清除，不触发回调
      state = idleState();
      currentStartedAt = 0;
      persist();
      return;
    }
    const fallbackMinutes = Math.max(
      SLEEP_TIMER_MIN_MINUTES,
      Math.round((record.endsAt - Date.now()) / 60_000),
    );
    const minutes =
      typeof record.minutes === 'number' && Number.isFinite(record.minutes)
        ? record.minutes
        : fallbackMinutes;
    state = {
      active: true,
      mode: 'minutes',
      remainingMs: record.endsAt - Date.now(),
      endsAt: record.endsAt,
      minutes,
    };
    currentStartedAt = startedAt;
    startTicker();
    return;
  }

  state = idleState();
  persist();
}

/* ------------------------------------------------------------------ */
/* 公开 API                                                            */
/* ------------------------------------------------------------------ */

/**
 * 开始（或覆盖）睡眠定时。
 * @param input 分钟数（1..600）或 'track-end'（播完当前曲停止）
 * @param onFire 到时回调；Lead 通常接「暂停播放」。「播完当前曲」模式请同时接 completeSleepTimer()。
 * @throws 分钟数非法
 */
export function startSleepTimer(input: SleepTimerInput, onFire?: () => void): SleepTimerState {
  stopTicker();
  onFireCallback = onFire ?? null;

  if (input === 'track-end') {
    state = { active: true, mode: 'track-end', remainingMs: null, endsAt: null, minutes: null };
    currentStartedAt = Date.now();
  } else {
    const minutes = Math.round(input);
    if (
      !Number.isFinite(minutes) ||
      minutes < SLEEP_TIMER_MIN_MINUTES ||
      minutes > SLEEP_TIMER_MAX_MINUTES
    ) {
      throw new Error(
        `睡眠定时需在 ${SLEEP_TIMER_MIN_MINUTES}–${SLEEP_TIMER_MAX_MINUTES} 分钟之间`,
      );
    }
    const now = Date.now();
    state = {
      active: true,
      mode: 'minutes',
      remainingMs: minutes * 60_000,
      endsAt: now + minutes * 60_000,
      minutes,
    };
    currentStartedAt = now;
    startTicker();
  }

  persist();
  emitState();
  return currentState();
}

/** 取消定时（不触发回调）。返回取消后的状态。 */
export function cancelSleepTimer(): SleepTimerState {
  const wasActive = state.active;
  stopTicker();
  onFireCallback = null;
  state = idleState();
  currentStartedAt = 0;
  persist();
  if (wasActive) emitState();
  return currentState();
}

/** 当前定时状态（remainingMs 实时计算）。 */
export function getSleepTimerState(): SleepTimerState {
  return currentState();
}

/**
 * 「播完当前曲」模式完成：Lead 在曲目自然结束时调用。
 * 只有当前处于 track-end 模式才触发；返回是否触发。
 */
export function completeSleepTimer(): boolean {
  if (!state.active || state.mode !== 'track-end') return false;
  fireTimer('track-end');
  return true;
}

/** 订阅状态变化（500ms tick + 开启/取消/到时）。返回取消订阅函数。 */
export function subscribeSleepTimer(listener: Listener): () => void {
  bindVisibility();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 把剩余时间格式化为 mm:ss（超过 1 小时为 h:mm:ss）。 */
export function formatSleepRemaining(value: SleepTimerState): string {
  if (!value.active) return '未开启';
  if (value.mode === 'track-end') return '播完当前曲后停止';
  const totalSeconds = Math.max(0, Math.ceil((value.remainingMs ?? 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** 定时模式的中文文案。 */
export function sleepTimerModeLabel(mode: SleepTimerMode | null): string {
  if (mode === 'track-end') return '播完当前曲';
  if (mode === 'minutes') return '倒计时';
  return '未开启';
}

/* ------------------------------------------------------------------ */
/* 可挂载面板 UI                                                       */
/* ------------------------------------------------------------------ */

export interface SleepTimerPanelOptions {
  /** 到时回调（Lead 接暂停播放 / 最小化等）。 */
  onFire?: () => void;
  /** 自定义时长的初始值（分钟），默认 45。 */
  initialCustomMinutes?: number;
  /** 追加在根节点上的 class。 */
  className?: string;
}

export interface SleepTimerPanelHandle {
  element: HTMLElement;
  /** 依据最新状态重绘。 */
  refresh: () => void;
  /** 解绑订阅并移除节点。 */
  dispose: () => void;
}

const CUSTOM_MIN = 1;
const CUSTOM_MAX = 240;

function clampCustomMinutes(value: number): number {
  if (!Number.isFinite(value)) return 45;
  return Math.max(CUSTOM_MIN, Math.min(CUSTOM_MAX, Math.round(value)));
}

/**
 * 构建睡眠定时面板（预设段 + 自定义滑块 + 播完当前曲 + 取消）。
 * 建议挂载：设置 → 播放 的「播放行为」区域，或快捷设置面板。
 */
export function buildSleepTimerPanel(options: SleepTimerPanelOptions = {}): SleepTimerPanelHandle {
  let disposed = false;
  let customMinutes = clampCustomMinutes(options.initialCustomMinutes ?? 45);

  const status = h('span', {
    class: 'st-status',
    'data-qa': 'sleep-timer-status',
    'data-state': 'off',
    text: '未开启',
  });

  const head = h(
    'div',
    { class: 'st-head' },
    h('div', { class: 'st-title' }, icon('clock', 14), h('span', { text: '睡眠定时' })),
    status,
  );

  const presetButtons = new Map<number, HTMLButtonElement>();
  const presetsRow = h('div', {
    class: 'seg st-presets',
    'data-qa': 'sleep-timer-presets',
    role: 'group',
    'aria-label': '睡眠定时预设',
  });
  for (const minutes of SLEEP_TIMER_PRESET_MINUTES) {
    const btn = h(
      'button',
      {
        type: 'button',
        class: 'seg-btn st-preset',
        'data-qa': `sleep-timer-preset-${minutes}`,
        'data-minutes': String(minutes),
      },
      h('span', { text: `${minutes} 分钟` }),
    );
    btn.addEventListener('click', () => {
      try {
        startSleepTimer(minutes, fireHandler);
        toast(`睡眠定时已开启：${minutes} 分钟后停止播放`);
        refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    });
    presetButtons.set(minutes, btn);
    presetsRow.append(btn);
  }

  const customValue = h('span', {
    class: 'st-custom-value',
    'data-qa': 'sleep-timer-custom-value',
    text: `${customMinutes} 分钟`,
  });
  const customRange = h('input', {
    type: 'range',
    class: 'slider st-range',
    'data-qa': 'sleep-timer-custom-range',
    min: String(CUSTOM_MIN),
    max: String(CUSTOM_MAX),
    step: '1',
    value: String(customMinutes),
    'aria-label': '自定义睡眠定时分钟数',
  });
  customRange.value = String(customMinutes);
  customRange.addEventListener('input', () => {
    customMinutes = clampCustomMinutes(Number(customRange.value));
    customValue.textContent = `${customMinutes} 分钟`;
  });

  const startBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm st-start-btn', 'data-qa': 'sleep-timer-start' },
    icon('clock', 14),
    h('span', { text: '开始计时' }),
  );
  startBtn.addEventListener('click', () => {
    try {
      startSleepTimer(customMinutes, fireHandler);
      toast(`睡眠定时已开启：${customMinutes} 分钟后停止播放`);
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  });

  const customRow = h(
    'div',
    { class: 'st-custom' },
    h(
      'div',
      { class: 'st-custom-head' },
      h('span', { class: 'st-custom-label', text: '自定义时长' }),
      customValue,
    ),
    h('div', { class: 'st-custom-control' }, customRange, startBtn),
  );

  const trackBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm st-track-btn', 'data-qa': 'sleep-timer-track-end' },
    icon('music', 14),
    h('span', { text: '播完当前曲停止' }),
  );
  trackBtn.addEventListener('click', () => {
    try {
      startSleepTimer('track-end', fireHandler);
      toast('将在当前歌曲播完后停止播放');
      refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  });

  const cancelBtn = h(
    'button',
    { type: 'button', class: 'btn btn-sm st-cancel-btn', 'data-qa': 'sleep-timer-cancel', hidden: true },
    icon('close', 14),
    h('span', { text: '取消定时' }),
  );
  cancelBtn.addEventListener('click', () => {
    cancelSleepTimer();
    toast('已取消睡眠定时');
    refresh();
  });

  const actions = h('div', { class: 'st-actions' }, trackBtn, cancelBtn);
  const hint = h('div', {
    class: 'st-hint',
    text: '到时会暂停播放；窗口最小化或页面在后台时仍然计时。',
  });

  const rootClass = options.className ? `st ${options.className}` : 'st';
  const element = h('div', { class: rootClass, 'data-qa': 'sleep-timer' }, head, presetsRow, customRow, actions, hint);

  function fireHandler(): void {
    try {
      options.onFire?.();
    } catch (err) {
      console.warn('[sleepTimer] onFire 异常', err);
    }
    toast('睡眠定时已到时');
    if (!disposed) refresh();
  }

  function refresh(): void {
    if (disposed) return;
    const current = getSleepTimerState();
    const activeMinutes = current.active && current.mode === 'minutes' ? current.minutes : null;
    status.textContent = current.active
      ? current.mode === 'track-end'
        ? '播完当前曲后停止'
        : `剩余 ${formatSleepRemaining(current)}`
      : '未开启';
    status.dataset.state = current.active ? 'on' : 'off';
    for (const [minutes, btn] of presetButtons) {
      const isOn = activeMinutes === minutes;
      btn.classList.toggle('is-on', isOn);
      btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
    }
    trackBtn.classList.toggle('is-on', current.active && current.mode === 'track-end');
    trackBtn.setAttribute(
      'aria-pressed',
      current.active && current.mode === 'track-end' ? 'true' : 'false',
    );
    cancelBtn.hidden = !current.active;
  }

  const unsubscribe = subscribeSleepTimer(refresh);
  refresh();

  return {
    element,
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      element.remove();
    },
  };
}

if (typeof window !== 'undefined') {
  restore();
}
