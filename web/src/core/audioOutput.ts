/**
 * 音频输出两条链路（互不影响）：
 *
 * 1. 本软件输出（页面侧）：Chromium 的 setSinkId。所有 AudioContext 与 <audio> 元素登记到这里，
 *    切换时统一改 sink——「跟随系统」用空 sinkId（Windows 默认设备），系统默认设备变了会自动跟上。
 * 2. 系统默认输出（宿主侧）：WASAPI 枚举 + IPolicyConfig 切换 Windows 默认播放设备，走
 *    type:'audioOutput' 的宿主消息；它改的是整台机器的默认输出，不碰本软件的第 1 条链路。
 *
 * 设备列表：Chromium 只有在宿主授予麦克风权限后才会列出全部播放设备与名称（WebView2 启动时
 * 已授权；平时不开麦，只有用户主动开启「麦克风混音」时才会 getUserMedia）。
 * 因此这里直接读 enumerateDevices()。
 */
import { host, postMessage } from './bridge';
import { getSettings, onSettingsChange } from './settings';

/* ------------------------------------------------------------------ */
/* 本软件输出（setSinkId）                                             */
/* ------------------------------------------------------------------ */

export interface AppAudioOutput {
  id: string;
  label: string;
}

type SinkCapable = { setSinkId?: (sinkId: string) => Promise<void> };

const sinkContexts = new Set<AudioContext>();
const sinkElements = new Set<HTMLMediaElement>();
const outputListeners = new Set<() => void>();
let appOutputStarted = false;
let appliedSink = '';

/** 订阅设备列表变化（拔出/插入设备、切换默认输出）。 */
export function onAppAudioOutputsChanged(handler: () => void): () => void {
  outputListeners.add(handler);
  return () => outputListeners.delete(handler);
}

function notifyOutputs(): void {
  outputListeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.warn('[audioOutput] listener failed', error);
    }
  });
}

function setSink(target: SinkCapable, sinkId: string): Promise<void> {
  if (typeof target.setSinkId !== 'function') return Promise.resolve();
  return target.setSinkId(sinkId).catch((error: unknown) => {
    console.warn('[audioOutput] setSinkId failed', error);
  });
}

/** 播放链路的 AudioContext 创建后登记（audioTap 的 EQ/频谱图就是这一条）。 */
export function registerAppAudioContext(context: AudioContext): void {
  sinkContexts.add(context);
  void setSink(context as unknown as SinkCapable, appliedSink);
}

/** 每个 <audio> 元素创建后登记（播放器的双 deck、试听都走这里）。 */
export function registerAppAudioElement(element: HTMLMediaElement): void {
  sinkElements.add(element);
  void setSink(element as unknown as SinkCapable, appliedSink);
}

/** 枚举全部播放设备（去掉「默认值 / 通信」两个伪设备）。 */
export async function listAppAudioOutputs(): Promise<AppAudioOutput[]> {
  const media = navigator.mediaDevices;
  if (!media?.enumerateDevices) return [];
  try {
    const devices = await media.enumerateDevices();
    const seen = new Set<string>();
    const result: AppAudioOutput[] = [];
    for (const device of devices) {
      if (device.kind !== 'audiooutput') continue;
      const id = device.deviceId;
      if (!id || id === 'default' || id === 'communications' || seen.has(id)) continue;
      seen.add(id);
      result.push({ id, label: device.label || '未命名播放设备' });
    }
    return result;
  } catch (error) {
    console.warn('[audioOutput] enumerateDevices failed', error);
    return [];
  }
}

/** 当前设置对应的 sinkId：跟随系统 = 空串。 */
export function currentAppSinkId(): string {
  const { playback } = getSettings();
  return playback.appOutputMode === 'device' ? playback.appOutputDeviceId : '';
}

/** 把当前设置的输出通道应用到所有已登记的 Context / 元素。 */
export async function applyAppAudioOutput(): Promise<void> {
  const sink = currentAppSinkId();
  appliedSink = sink;
  const tasks: Array<Promise<void>> = [];
  sinkContexts.forEach((context) => tasks.push(setSink(context as unknown as SinkCapable, sink)));
  sinkElements.forEach((element) => tasks.push(setSink(element as unknown as SinkCapable, sink)));
  await Promise.all(tasks);
}

/** 启动：订阅设置变化与设备变化，并立刻应用一次。 */
export function initAppAudioOutput(): void {
  if (appOutputStarted) return;
  appOutputStarted = true;
  onSettingsChange(() => {
    void applyAppAudioOutput();
  });
  const media = navigator.mediaDevices;
  if (media && typeof media.addEventListener === 'function') {
    media.addEventListener('devicechange', () => {
      void applyAppAudioOutput();
      notifyOutputs();
    });
  }
  void applyAppAudioOutput();
}

/* ------------------------------------------------------------------ */
/* 系统默认输出（宿主 WASAPI）                                         */
/* ------------------------------------------------------------------ */

export interface SystemAudioOutput {
  id: string;
  name: string;
  default: boolean;
}

export interface SystemAudioOutputState {
  devices: SystemAudioOutput[];
  defaultId: string;
}

let systemState: SystemAudioOutputState | null = null;
let systemStarted = false;
const systemListeners = new Set<(state: SystemAudioOutputState) => void>();

export function systemAudioOutputState(): SystemAudioOutputState | null {
  return systemState;
}

export function onSystemAudioOutputState(
  handler: (state: SystemAudioOutputState) => void,
): () => void {
  systemListeners.add(handler);
  if (systemState) handler(systemState);
  return () => systemListeners.delete(handler);
}

function normalizeSystemState(payload: unknown): SystemAudioOutputState | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as { devices?: unknown; defaultId?: unknown };
  const devices: SystemAudioOutput[] = [];
  if (Array.isArray(raw.devices)) {
    for (const item of raw.devices) {
      if (!item || typeof item !== 'object') continue;
      const device = item as { id?: unknown; name?: unknown; default?: unknown };
      if (typeof device.id !== 'string' || !device.id) continue;
      devices.push({
        id: device.id,
        name: typeof device.name === 'string' && device.name ? device.name : device.id,
        default: device.default === true,
      });
    }
  }
  return {
    devices,
    defaultId: typeof raw.defaultId === 'string' ? raw.defaultId : '',
  };
}

/** 启动：监听宿主推送的系统输出状态。 */
export function initSystemAudioOutput(): void {
  if (systemStarted) return;
  systemStarted = true;
  host.onMessage((message) => {
    if (message.type !== 'host' || message.event !== 'audioOutput') return;
    const next = normalizeSystemState(message.payload);
    if (!next) return;
    systemState = next;
    systemListeners.forEach((listener) => {
      try {
        listener(next);
      } catch (error) {
        console.warn('[audioOutput] system listener failed', error);
      }
    });
  });
}

export function requestSystemAudioOutputs(): void {
  postMessage({ v: 1, type: 'audioOutput', action: 'list' });
}

export function setSystemAudioOutputDefault(id: string): void {
  postMessage({ v: 1, type: 'audioOutput', action: 'setDefault', id });
}

export function cycleSystemAudioOutput(): void {
  postMessage({ v: 1, type: 'audioOutput', action: 'cycle' });
}
