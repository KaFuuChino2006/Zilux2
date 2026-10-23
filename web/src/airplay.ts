/**
 * AirPlay / RAOP 投送：宿主契约 v1 §12 的页面侧封装。
 *
 * 页面只负责「发指令 + 收状态」：设备发现、握手、音频封装与 TEARDOWN 全部在宿主（C#）里。
 * 没有宿主（浏览器直接打开 index.html）时所有指令都是 no-op，hostAvailable() 返回 false，
 * UI 据此显示「仅桌面应用内可用」的降级提示，页面其余部分照常工作。
 *
 * 契约要点（docs/zilux2-host-contract.md §12）：
 * - 页面 → 宿主：{ v:1, type:'airplay', action:'scan'|'stopScan'|'connect'|'disconnect'|'volume'|'pin', ... }
 *   · connect 可对不同设备重复发送，每台各发一条即可同时投送到多台；
 *   · disconnect 带 deviceId 表示只断开该设备，不带表示断开全部（宿主对未知 id 忽略）；
 *   · pin 用于 macOS「隔空播放接收器」的 HAP 配对：宿主以 state:'connecting' +
 *     code:'pinRequired' 等页面回传 Mac 屏幕上的 4 位配对码
 *     （{ v:1, type:'airplay', action:'pin', deviceId, value:'1234' }）。
 * - 宿主 → 页面：{ v:1, type:'host', event:'airplay', payload:{ state, devices?, active?, actives?, code?, error? } }
 * - devices 只在扫描期间/扫描结束时出现（最多 32 台，宿主已按名称排序）；非扫描状态可能省略。
 * - active 只在 streaming 时出现；volume 为 0–100。
 * - actives 为 streaming 时全部正在投送的设备；旧宿主没有该字段时用 active 构造单元素数组。
 * - code 只在 state:'error' 时出现；error 为可直接展示的中文文本。
 *
 * 本模块只做「最小合理实现」，对契约没写死的地方采取宽松解析：
 * - 不校验 v 字段（向前兼容，避免宿主升版后整条消息被丢掉）。
 * - 未知 state 直接忽略整条消息；未知 code 归为 null，错误文案退回宿主给的 error。
 * - 缺失的 devices 沿用上一次列表（宿主在 error/idle 里省略 devices 时列表不会闪空）。
 * - 非 idle 状态缺失 actives/active 时沿用上一次列表：多设备投送途中第二台出错/正在连接时，
 *   已经投送中的设备不会被误判为「已断开」。
 */

import { host, hostAvailable, postMessage, type HostMessage } from './core/bridge';

export type AirplayState = 'idle' | 'scanning' | 'connecting' | 'streaming' | 'error';

/** 宿主契约 §12.2 里定义的 code。`pinRequired` 也会以 state:'connecting' 出现（见下）。 */
export type AirplayErrorCode =
  | 'passwordRequired'
  | 'pinRequired'
  | 'unsupported'
  | 'busy'
  | 'network'
  | 'capture'
  | 'internal';

export interface AirplayDevice {
  id: string;
  name: string;
  /** 设备地址（通常是局域网 IP）。 */
  host: string;
  /** 设备型号，如 AudioAccessory5,1；宿主可能给空串。 */
  model: string;
  requiresPassword: boolean;
  airPlay2: boolean;
}

export interface AirplayActive {
  id: string;
  name: string;
  /** 0–100。 */
  volume: number;
}

export interface AirplaySnapshot {
  state: AirplayState;
  devices: readonly AirplayDevice[];
  /** 第一台正在投送的设备（兼容旧宿主/单设备场景）；多设备以 actives 为准。 */
  active: AirplayActive | null;
  /** 全部正在投送的设备（按宿主推送顺序，active 恒等于 actives[0]）。 */
  actives: readonly AirplayActive[];
  code: AirplayErrorCode | null;
  error: string | null;
  /** 最近一次 connect 的目标设备 id（密码重试/连接中提示用）。 */
  targetDeviceId: string | null;
  /** 需要补密码的设备 id（code === 'passwordRequired' 时非空）。 */
  passwordDeviceId: string | null;
  /** 宿主正在等待 macOS HAP 配对码（state:'connecting' + code:'pinRequired'）。 */
  pinRequired: boolean;
  /** 等待配对码的设备 id（宿主推送里不带 deviceId，用最近一次 connect 的目标定位）。 */
  pinDeviceId: string | null;
  /** 配对提示文案（取宿主 error 字段；缺失时用兜底文案）。 */
  pinMessage: string | null;
  /** 已回传配对码、正在等 Mac 确认（用户不应重复提交；宿主重新要码时会复位）。 */
  pinSubmitted: boolean;
}

const AIRPLAY_STATES: readonly AirplayState[] = [
  'idle',
  'scanning',
  'connecting',
  'streaming',
  'error',
];

const AIRPLAY_ERROR_CODES: readonly AirplayErrorCode[] = [
  'passwordRequired',
  'pinRequired',
  'unsupported',
  'busy',
  'network',
  'capture',
  'internal',
];

/** 宿主没给 error 文案时的配对提示（契约 §12.1：Mac 屏幕显示 4 位数字）。 */
const PIN_MESSAGE_FALLBACK = '请在 Mac 屏幕上查看配对码并输入';

/** 契约上限：devices 最多 32 台；actives 同样按此上限截断。 */
const MAX_DEVICES = 32;
/** 契约上限：error 文本 ≤200 字。 */
const MAX_ERROR_LENGTH = 200;
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 80;

export const AIRPLAY_STATE_LABEL: Record<AirplayState, string> = {
  idle: '未投送',
  scanning: '正在扫描设备',
  connecting: '正在连接',
  streaming: '投送中',
  error: '投送出错',
};

/** code 的兜底中文文案：宿主没给 error 时 UI 直接用它。 */
export const AIRPLAY_ERROR_LABEL: Record<AirplayErrorCode, string> = {
  passwordRequired: '这台设备需要密码',
  pinRequired: '需要在 Mac 屏幕上输入配对码',
  unsupported: '设备不支持 AirPlay 投送',
  busy: '设备正忙，稍后再试',
  network: '网络异常，连不上设备',
  capture: '音频采集失败，正在重试',
  internal: '宿主内部错误',
};

function emptySnapshot(): AirplaySnapshot {
  return {
    state: 'idle',
    devices: [],
    active: null,
    actives: [],
    code: null,
    error: null,
    targetDeviceId: null,
    passwordDeviceId: null,
    pinRequired: false,
    pinDeviceId: null,
    pinMessage: null,
    pinSubmitted: false,
  };
}

let snapshot: AirplaySnapshot = emptySnapshot();
const listeners = new Set<(snapshot: AirplaySnapshot) => void>();
let listening = false;

function emit(): void {
  const current = snapshot;
  listeners.forEach((listener) => {
    try {
      listener(current);
    } catch (error) {
      console.warn('[airplay] 订阅回调抛错', error);
    }
  });
}

function commit(patch: Partial<AirplaySnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  emit();
}

function send(action: string, extra?: Record<string, unknown>): boolean {
  return postMessage({ v: 1, type: 'airplay', action, ...extra });
}

/** 首次需要收状态时才挂监听（bridge.onMessage 只能加不能减，全模块只挂一次）。 */
function ensureListening(): void {
  if (listening || !hostAvailable()) return;
  listening = true;
  host.onMessage(onHostMessage);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readText(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

function readPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function parseDevice(raw: unknown): AirplayDevice | null {
  if (!isRecord(raw)) return null;
  const id = readText(raw.id, MAX_ID_LENGTH);
  if (!id) return null;
  return {
    id,
    name: readText(raw.name, MAX_NAME_LENGTH) || id,
    host: readText(raw.host, 64),
    model: readText(raw.model, 64),
    requiresPassword: raw.requiresPassword === true,
    airPlay2: raw.airPlay2 === true,
  };
}

function parseDevices(raw: unknown): AirplayDevice[] {
  if (!Array.isArray(raw)) return [];
  const devices: AirplayDevice[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (devices.length >= MAX_DEVICES) break;
    const device = parseDevice(item);
    if (!device || seen.has(device.id)) continue;
    seen.add(device.id);
    devices.push(device);
  }
  return devices;
}

function parseActive(raw: unknown, fallbackVolume: number): AirplayActive | null {
  if (!isRecord(raw)) return null;
  const id = readText(raw.id, MAX_ID_LENGTH);
  if (!id) return null;
  return {
    id,
    name: readText(raw.name, MAX_NAME_LENGTH) || id,
    volume: readPercent(raw.volume) ?? fallbackVolume,
  };
}

/**
 * 解析多设备投送列表：同 id 去重、最多 MAX_DEVICES 台。
 * 宿主可能只带 id/name 不带 volume，音量按「同 id 上次值 → 上一列表首台 → 0」回退。
 */
function parseActives(raw: unknown, previous: readonly AirplayActive[]): AirplayActive[] {
  if (!Array.isArray(raw)) return [];
  const actives: AirplayActive[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (actives.length >= MAX_DEVICES) break;
    if (!isRecord(item)) continue;
    const id = readText(item.id, MAX_ID_LENGTH);
    const known = previous.find((entry) => entry.id === id);
    const active = parseActive(item, known?.volume ?? previous[0]?.volume ?? 0);
    if (!active || seen.has(active.id)) continue;
    seen.add(active.id);
    actives.push(active);
  }
  return actives;
}

function parseCode(raw: unknown): AirplayErrorCode | null {
  if (typeof raw !== 'string') return null;
  return AIRPLAY_ERROR_CODES.includes(raw as AirplayErrorCode)
    ? (raw as AirplayErrorCode)
    : null;
}

function onHostMessage(message: HostMessage): void {
  if (message.type !== 'host' || message.event !== 'airplay') return;
  const payload = message.payload;
  if (!isRecord(payload)) return;

  const rawState = payload.state;
  if (typeof rawState !== 'string' || !AIRPLAY_STATES.includes(rawState as AirplayState)) {
    console.warn('[airplay] 忽略未知 state 的推送', rawState);
    return;
  }
  const state = rawState as AirplayState;

  // devices 只在扫描期间/结束时出现：缺失时沿用上一次列表（error/idle 里宿主通常会省略）
  const devices = Array.isArray(payload.devices)
    ? parseDevices(payload.devices)
    : snapshot.devices;

  // actives 优先；旧宿主只给 active 时兼容成单设备；非 idle 且两者都没给则沿用上次。
  let actives: readonly AirplayActive[];
  if (state === 'idle') {
    actives = [];
  } else if (Array.isArray(payload.actives)) {
    actives = parseActives(payload.actives, snapshot.actives);
  } else if (state === 'streaming' && isRecord(payload.active)) {
    const single = parseActive(payload.active, snapshot.actives[0]?.volume ?? 0);
    actives = single ? [single] : snapshot.actives;
  } else {
    actives = snapshot.actives;
  }
  const active = actives[0] ?? null;

  const code = state === 'error' ? parseCode(payload.code) : null;
  let error: string | null = null;
  if (state === 'error') {
    error = readText(payload.error, MAX_ERROR_LENGTH) || (code ? AIRPLAY_ERROR_LABEL[code] : '投送出错');
  }

  // 密码重试：宿主错误里不带 deviceId，用最近一次 connect 的目标来定位输入框
  const passwordDeviceId =
    state === 'error' && code === 'passwordRequired' ? snapshot.targetDeviceId : null;

  // macOS 配对码：契约 §12.1 规定宿主用 state:'connecting' + code:'pinRequired' 索要 Mac 屏幕上的
  // 4 位 PIN（§12.2 又写 code「只在 error 时出现」，两处不一致——这里以 §12.1 为准，两种状态都识别，
  // 但只有 connecting 才进入「等用户输入」形态；error+pinRequired 表示配对已失败）。
  const pinSignal = state === 'connecting' && payload.code === 'pinRequired';
  const pinRequired = pinSignal;
  const pinDeviceId = pinSignal ? snapshot.targetDeviceId : null;
  const pinMessage = pinSignal
    ? readText(payload.error, MAX_ERROR_LENGTH) || PIN_MESSAGE_FALLBACK
    : null;

  // 任何宿主推送都复位「已提交」：宿主重新要码时输入框随之重新可用。
  commit({
    state,
    devices,
    active,
    actives,
    code,
    error,
    passwordDeviceId,
    pinRequired,
    pinDeviceId,
    pinMessage,
    pinSubmitted: false,
  });

  // 宿主推送了新状态：不再处于「连接中」就解锁（同一时刻只允许一台握手，见 connectAirplay）。
  if (state !== 'connecting') clearConnectGuard();
}

/** 当前状态快照（只读；每次变化是整体替换的新对象）。 */
export function getAirplaySnapshot(): AirplaySnapshot {
  return snapshot;
}

/** 订阅状态变化；立即回调一次当前状态。返回取消函数。 */
export function subscribeAirplay(listener: (snapshot: AirplaySnapshot) => void): () => void {
  ensureListening();
  listeners.add(listener);
  listener(snapshot);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 开始扫描（宿主持续扫 8 秒；扫描期间可重复调用刷新）。
 * 返回 false 表示没有宿主，UI 应展示降级提示。
 */
export function scanAirplay(): boolean {
  ensureListening();
  if (!scan()) return false;
  commit({ state: 'scanning', code: null, error: null, passwordDeviceId: null });
  return true;
}

function scan(): boolean {
  return hostAvailable() && send('scan');
}

/** 停止扫描。契约没定义「扫描结束」的推送，本地乐观回到 idle 避免 UI 卡在扫描态。 */
export function stopAirplayScan(): boolean {
  if (!hostAvailable()) return false;
  const sent = send('stopScan');
  if (sent && snapshot.state === 'scanning') commit({ state: 'idle' });
  return sent;
}

/* ------------------------------------------------------------------ */
/* 连接节流                                                            */
/* ------------------------------------------------------------------ */

/**
 * 宿主同一时刻只允许一台设备握手：AirPlayService.Connect() 开头会 CancelConnect() 取消上一台，
 * 所以页面侧必须在上一台「连上（streaming 且出现在 actives）」或失败之前锁住其它设备。
 * 这个计时器只是兜底：宿主长时间不回状态时解锁，避免一直卡在「连接中」。
 */
const CONNECT_GUARD_MS = 25000;
let connectGuardTimer = 0;

function clearConnectGuard(): void {
  if (connectGuardTimer !== 0) {
    window.clearTimeout(connectGuardTimer);
    connectGuardTimer = 0;
  }
}

function armConnectGuard(deviceId: string): void {
  clearConnectGuard();
  connectGuardTimer = window.setTimeout(() => {
    connectGuardTimer = 0;
    if (snapshot.state !== 'connecting' || snapshot.targetDeviceId !== deviceId) return;
    // 等用户输入密码/配对码时不算卡死：继续等，别把「连接中」提前撤掉
    if (snapshot.pinRequired || snapshot.passwordDeviceId !== null) {
      armConnectGuard(deviceId);
      return;
    }
    const stillActive = snapshot.actives.some((entry) => entry.id === deviceId);
    commit({
      state: snapshot.actives.length > 0 || stillActive ? 'streaming' : 'idle',
      code: null,
      error: null,
    });
  }, CONNECT_GUARD_MS);
}

/**
 * 连接设备；可选密码（requiresPassword 的设备首次不带密码会收到 passwordRequired）。
 *
 * 单台握手：已有设备在连接中时直接返回 false（UI 会把其它设备的按钮置灰），
 * 等宿主推送 streaming（设备进入 actives）后再允许连下一台——宿主会取消并发的握手。
 */
export function connectAirplay(deviceId: string, password?: string): boolean {
  ensureListening();
  const id = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!id || !hostAvailable()) return false;
  if (snapshot.actives.some((entry) => entry.id === id)) return true;
  if (snapshot.state === 'connecting') return false;
  const extra: Record<string, unknown> = { deviceId: id };
  if (typeof password === 'string' && password.length > 0) extra.password = password;
  if (!send('connect', extra)) return false;
  commit({
    state: 'connecting',
    code: null,
    error: null,
    passwordDeviceId: null,
    pinRequired: false,
    pinDeviceId: null,
    pinMessage: null,
    pinSubmitted: false,
    targetDeviceId: id,
  });
  armConnectGuard(id);
  return true;
}

/**
 * 回传 macOS「隔空播放接收器」的 4 位 HAP 配对码（契约 §12.1 `action:"pin"`）。
 * 宿主收到后继续连接：成功 → streaming，失败 → error + code（可能 passwordRequired/network/unsupported）。
 * 契约没有「取消配对」指令，取消由 UI 侧用 disconnect(deviceId) 中止该设备的连接。
 */
export function submitAirplayPin(deviceId: string, pin: string): boolean {
  ensureListening();
  if (!hostAvailable()) return false;
  const id = typeof deviceId === 'string' ? deviceId.trim() : '';
  const value = typeof pin === 'string' ? pin.trim() : '';
  // Mac 屏幕上是 4 位数字；格式不对直接拒绝，避免把脏输入发给宿主
  if (!id || !/^\d{4}$/.test(value)) return false;
  if (!send('pin', { deviceId: id, value })) return false;
  // 保持 connecting（宿主继续走 pair-setup/pair-verify），UI 显示「配对中…」等待结果
  commit({ code: null, error: null, pinSubmitted: true });
  return true;
}

/** 断开全部投送；实际状态以宿主推送的 idle 为准。 */
export function disconnectAirplay(): boolean {
  if (!hostAvailable()) return false;
  const sent = send('disconnect');
  if (sent) {
    // 全部停止：同时解除「连接中」锁
    clearConnectGuard();
    // 断开同时收起密码/PIN 输入：取消配对也用这条路径（契约没有 cancel 动作）
    commit({
      code: null,
      error: null,
      passwordDeviceId: null,
      pinRequired: false,
      pinDeviceId: null,
      pinMessage: null,
      pinSubmitted: false,
    });
  }
  return sent;
}

/**
 * 断开投送：传 deviceId 只断开该设备，不传则断开全部（宿主契约 §12 扩展）。
 * 实际状态以宿主推送为准，这里不做乐观删除，避免断开失败时列表闪回。
 */
export function disconnectAirplayDevice(deviceId?: string): boolean {
  if (!hostAvailable()) return false;
  const id = typeof deviceId === 'string' ? deviceId.trim() : '';
  const sent = id ? send('disconnect', { deviceId: id }) : send('disconnect');
  if (sent) {
    // 断开（含取消配对/中途放弃）都解除「连接中」锁，让其它设备可以继续点
    clearConnectGuard();
  }
  if (sent) {
    // 逐台断开/取消配对：同时收起 PIN 表单（密码框由下次 error 事件重新驱动）
    commit({
      code: null,
      error: null,
      passwordDeviceId: null,
      pinRequired: false,
      pinDeviceId: null,
      pinMessage: null,
      pinSubmitted: false,
    });
  }
  return sent;
}

/**
 * 设置投送音量（0–100 整数，超范围钳制）。
 * 契约：未连接时宿主会忽略，这里直接不发送；多设备共用同一音量，乐观更新全部 actives.volume。
 */
export function setAirplayVolume(percent: number): boolean {
  if (!hostAvailable()) return false;
  if (snapshot.actives.length === 0) return false;
  const value = readPercent(percent);
  if (value === null) return false;
  if (!send('volume', { percent: value })) return false;
  if (snapshot.actives.some((entry) => entry.volume !== value)) {
    const actives = snapshot.actives.map((entry) => ({ ...entry, volume: value }));
    commit({ actives, active: actives[0] ?? null });
  }
  return true;
}

/**
 * 设置单台设备的投送音量（0–100 整数，超范围钳制）。
 * 宿主按 deviceId 只改这一台的 RAOP 音量；其它设备保持各自音量。乐观更新该台 actives.volume。
 */
export function setAirplayDeviceVolume(deviceId: string, percent: number): boolean {
  if (!hostAvailable()) return false;
  const id = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!id) return false;
  if (!snapshot.actives.some((entry) => entry.id === id)) return false;
  const value = readPercent(percent);
  if (value === null) return false;
  if (!send('volume', { percent: value, deviceId: id })) return false;
  const target = snapshot.actives.find((entry) => entry.id === id);
  if (target && target.volume !== value) {
    const actives = snapshot.actives.map((entry) =>
      entry.id === id ? { ...entry, volume: value } : entry,
    );
    commit({ actives, active: actives[0] ?? null });
  }
  return true;
}

/**
 * 投送音量记忆：按设备 id + 一份全局音量存 localStorage（宿主 settings schema 固定，不去改
 * 宿主设置文件）。投送开始时面板用它把每台设备恢复到上次的音量。
 */
const VOLUME_MEMORY_KEY = 'zilux2.airplayVolumes';

interface AirplayVolumeMemory {
  global: number | null;
  devices: Record<string, number>;
}

function readVolumeMemory(): AirplayVolumeMemory {
  const empty: AirplayVolumeMemory = { global: null, devices: {} };
  try {
    const raw = localStorage.getItem(VOLUME_MEMORY_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as { global?: unknown; devices?: unknown } | null;
    const devices: Record<string, number> = {};
    if (parsed && typeof parsed.devices === 'object' && parsed.devices !== null) {
      for (const [id, value] of Object.entries(parsed.devices as Record<string, unknown>)) {
        const percent = readPercent(value);
        if (id && percent !== null) devices[id] = percent;
      }
    }
    return { global: readPercent(parsed?.global), devices };
  } catch {
    return empty;
  }
}

function writeVolumeMemory(memory: AirplayVolumeMemory): void {
  try {
    localStorage.setItem(
      VOLUME_MEMORY_KEY,
      JSON.stringify({ global: memory.global, devices: memory.devices }),
    );
  } catch {
    // 隐私模式或配额满时静默失败：音量记忆只是锦上添花。
  }
}

/** 上次记住的全局投送音量（0–100），没有记录时返回 null。 */
export function rememberedAirplayVolume(): number | null {
  return readVolumeMemory().global;
}

/** 上次记住的某台设备音量（0–100），没有记录时返回 null。 */
export function rememberedAirplayDeviceVolume(deviceId: string): number | null {
  const id = typeof deviceId === 'string' ? deviceId.trim() : '';
  if (!id) return null;
  return readVolumeMemory().devices[id] ?? null;
}

/** 记住全局投送音量，供下次投送恢复。 */
export function rememberAirplayVolume(percent: number): void {
  const value = readPercent(percent);
  if (value === null) return;
  const memory = readVolumeMemory();
  memory.global = value;
  writeVolumeMemory(memory);
}

/** 记住某台设备的投送音量，供下次投送恢复。 */
export function rememberAirplayDeviceVolume(deviceId: string, percent: number): void {
  const id = typeof deviceId === 'string' ? deviceId.trim() : '';
  const value = readPercent(percent);
  if (!id || value === null) return;
  const memory = readVolumeMemory();
  memory.devices[id] = value;
  writeVolumeMemory(memory);
}

/**
 * 清空本地状态（不向宿主发任何指令，仅测试/调试或宿主重启时用）。
 */
export function resetAirplayState(): void {
  snapshot = emptySnapshot();
  emit();
}

// ── 延迟调节（接收端缓冲）───────────────────────────────────────────────────────────────
/**
 * AirPlay 2 的接收端缓冲延迟（毫秒）：越小越跟手，但网络抖动大时接收端容易欠载断续。
 * 数值由页面记在 localStorage（宿主 settings.json 的 schema 是固定的，不去动它），
 * 每次启动/改动都下发给宿主；宿主在「下一次建立连接」时使用，正在投送的会话不变。
 */
const LATENCY_KEY = 'zilux2.airplayLatencyMs';
/** 与宿主默认值一致：300ms 能吸收 WiFi 抖动（120ms 会偶发爆音）。 */
const LATENCY_DEFAULT_MS = 300;
/** AP2 SETUP 允许的范围（宿主侧同样钳制 100–600ms）。 */
export const AIRPLAY_LATENCY_MIN = 120;
export const AIRPLAY_LATENCY_MAX = 600;
/** 每次点击 ± 的步进。 */
export const AIRPLAY_LATENCY_STEP = 20;

/** 当前设定的延迟（毫秒，已钳制并按步进取整）。 */
export function airplayLatencyMs(): number {
  try {
    const raw = localStorage.getItem(LATENCY_KEY);
    if (!raw) return LATENCY_DEFAULT_MS;
    const value = Number(raw);
    return clampLatency(value);
  } catch {
    return LATENCY_DEFAULT_MS;
  }
}

function clampLatency(milliseconds: number): number {
  if (!Number.isFinite(milliseconds)) return LATENCY_DEFAULT_MS;
  const clamped = Math.min(AIRPLAY_LATENCY_MAX, Math.max(AIRPLAY_LATENCY_MIN, milliseconds));
  return Math.round(clamped / AIRPLAY_LATENCY_STEP) * AIRPLAY_LATENCY_STEP;
}

/**
 * 设置延迟并下发给宿主（宿主只影响下一次连接）。
 * 返回实际生效的数值（钳制/取整之后），调用方据此刷新界面。
 */
export function setAirplayLatency(milliseconds: number): number {
  const value = clampLatency(milliseconds);
  try {
    localStorage.setItem(LATENCY_KEY, String(value));
  } catch {
    // 隐私模式/配额满：只在本次会话有效
  }
  send('latency', { value });
  return value;
}

/** 把手记住的延迟同步给宿主（宿主重启后内存值回到 300ms，页面负责重新下发）。 */
export function syncAirplayLatency(): void {
  if (!hostAvailable()) return;
  send('latency', { value: airplayLatencyMs() });
}

/** AirPlay/RAOP 投送单例：UI 与宿主之间的唯一入口。 */
export const airplay = {
  hostAvailable,
  subscribe: subscribeAirplay,
  getSnapshot: getAirplaySnapshot,
  scan: scanAirplay,
  stopScan: stopAirplayScan,
  connect: connectAirplay,
  submitPin: submitAirplayPin,
  disconnect: disconnectAirplay,
  disconnectDevice: disconnectAirplayDevice,
  setVolume: setAirplayVolume,
  setDeviceVolume: setAirplayDeviceVolume,
  latencyMs: airplayLatencyMs,
  setLatency: setAirplayLatency,
  syncLatency: syncAirplayLatency,
  reset: resetAirplayState,
};
