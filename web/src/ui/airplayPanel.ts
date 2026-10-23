/**
 * AirPlay / RAOP 投送面板（宿主契约 v1 §12 的 UI 层）。
 *
 * 同一套 DOM 同时供两处使用：
 * - 设置面板里的「投送」区块（variant: 'settings'，插到 .settings-body 末尾）；
 * - 左侧功能栏「投送」按钮弹出的浮层（variant: 'popover'，由 spaceShell 定位/显隐）。
 *
 * 面板自己不做发现/连接，只驱动 ../airplay 单例并渲染它的状态快照：
 * 扫描 → 列表 → 连接（支持多台设备同时投送）→ 密码 / macOS 配对码（PIN）→ 全局音量 →
 * 单台停止/全部断开/错误。
 * 没有宿主（浏览器直开）时显示降级提示，所有按钮隐藏或禁用，页面照常工作。
 */

import {
  AIRPLAY_ERROR_LABEL,
  AIRPLAY_LATENCY_MAX,
  AIRPLAY_LATENCY_MIN,
  AIRPLAY_LATENCY_STEP,
  airplay,
  rememberedAirplayDeviceVolume,
  rememberedAirplayVolume,
  rememberAirplayDeviceVolume,
  rememberAirplayVolume,
  type AirplayActive,
  type AirplayDevice,
  type AirplaySnapshot,
} from '../airplay';
import { iconHtml } from './dom';

export type AirplayPanelVariant = 'settings' | 'popover';

export interface AirplayPanelOptions {
  variant?: AirplayPanelVariant;
  /** 浮层右上角「关闭」按钮的回调（settings 变体不显示该按钮）。 */
  onRequestClose?: () => void;
}

export interface AirplayPanelHandle {
  element: HTMLElement;
  /** 面板可见时调用：开始扫描（并记住这是「需要扫描」的引用计数）。 */
  activate(): void;
  /** 面板隐藏时调用：只有当所有面板都收起时才 stopScan。 */
  deactivate(): void;
  destroy(): void;
}

/** 契约 §12：宿主扫描持续 8 秒，UI 用它决定「扫描中」与「没发现设备」的文案切换。 */
const SCAN_WINDOW_MS = 8500;
/** 音量滑杆防抖（契约要求拖动即发，但不必每像素一条消息）。 */
const VOLUME_DEBOUNCE_MS = 150;

/** 多面板引用计数：设置区块 / 投送浮层可能同时打开，谁都不能单独把别人的扫描停掉。 */
let visiblePanels = 0;

function beginScan(): void {
  visiblePanels += 1;
  airplay.scan();
}

function endScan(): void {
  visiblePanels = Math.max(0, visiblePanels - 1);
  if (visiblePanels === 0) airplay.stopScan();
}

function escapeHtml(text: string): string {
  const table: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return text.replace(/[&<>"']/g, (char) => table[char] ?? char);
}

function query<E extends Element>(parent: ParentNode, selector: string): E {
  const found = parent.querySelector<E>(selector);
  if (!found) throw new Error(`[airplay] 缺少 UI 元素：${selector}`);
  return found;
}

const ERROR_DOT_STATES: readonly AirplaySnapshot['state'][] = ['error'];

function deviceMetaLine(device: AirplayDevice): string {
  const parts = [device.host, device.model].filter((part) => part.length > 0);
  return parts.join(' · ') || 'AirPlay 设备';
}

export function createAirplayPanel(options: AirplayPanelOptions = {}): AirplayPanelHandle {
  const variant = options.variant ?? 'settings';
  const isPopover = variant === 'popover';

  let current = airplay.getSnapshot();
  let active = false;
  let scanExpired = false;
  let scanTimer: number | null = null;
  let volumeTimer: number | null = null;
  const deviceVolumeTimers = new Map<string, number>();
  /** 已经恢复过记忆音量的设备 id：宿主回传音量会触发重绘，避免反复下发。 */
  const appliedVolumeIds = new Set<string>();
  let devicesSignature = '';
  let passwordDismissed = false;
  let lastPasswordDeviceId: string | null = null;
  let pinDismissed = false;
  let lastPinDeviceId: string | null = null;

  const root = document.createElement('section');
  root.className = isPopover ? 'airplay-view is-popover' : 'airplay-view settings-section';
  root.dataset.airplayView = '';
  if (isPopover) {
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '投送');
  }
  root.innerHTML = `
    <header class="airplay-head">
      <span class="${isPopover ? 'airplay-kicker' : 'settings-kicker'}">投送</span>
      ${
        isPopover
          ? `<button class="airplay-pop-close" data-airplay-close type="button" aria-label="关闭投送">${iconHtml('close', 16)}</button>`
          : ''
      }
    </header>
    <div class="airplay-status">
      <span class="airplay-dot" data-airplay-dot aria-hidden="true"></span>
      <span class="airplay-status-text" data-airplay-status-text aria-live="polite">未投送</span>
      <button class="airplay-btn is-ghost" data-airplay-refresh type="button">扫描设备</button>
    </div>
    <p class="airplay-notice" data-airplay-notice hidden></p>
    <div class="airplay-latency">
      <span class="airplay-latency-label">接收端延迟</span>
      <button class="airplay-latency-step" data-airplay-latency-down type="button" aria-label="减少延迟">−</button>
      <span class="airplay-latency-value" data-airplay-latency-value>300 ms</span>
      <button class="airplay-latency-step" data-airplay-latency-up type="button" aria-label="增加延迟">+</button>
      <span class="airplay-latency-hint" data-airplay-latency-hint>越小越跟手</span>
    </div>
    <div class="airplay-now" data-airplay-now hidden>
      <div class="airplay-now-main">
        <span class="airplay-now-icon" aria-hidden="true">${iconHtml('airplay', 18)}</span>
        <span class="airplay-now-text"><span data-airplay-now-prefix>正在投送到</span> <strong data-airplay-now-name>—</strong></span>
        <button class="airplay-btn is-danger" data-airplay-disconnect type="button">全部停止</button>
      </div>
      <ul class="airplay-now-list" data-airplay-now-list hidden></ul>
      <div class="airplay-volume">
        <span class="airplay-volume-label">音量</span>
        <input class="airplay-range" data-airplay-volume type="range" min="0" max="100" step="1" value="70" aria-label="投送音量" />
        <span class="airplay-volume-value" data-airplay-volume-value>70%</span>
      </div>
    </div>
    <form class="airplay-password" data-airplay-password hidden>
      <p class="airplay-password-text" data-airplay-password-text>这台设备需要密码</p>
      <div class="airplay-password-row">
        <input class="airplay-input" data-airplay-password-input type="password" autocomplete="off" placeholder="输入设备密码" aria-label="设备密码" />
        <button class="airplay-btn is-primary" data-airplay-password-ok type="submit">连接</button>
        <button class="airplay-btn is-ghost" data-airplay-password-cancel type="button">取消</button>
      </div>
    </form>
    <form class="airplay-password airplay-pin" data-airplay-pin hidden>
      <p class="airplay-password-text" data-airplay-pin-text>请在 Mac 屏幕上查看配对码并输入</p>
      <div class="airplay-password-row">
        <input class="airplay-input is-pin" data-airplay-pin-input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="one-time-code" placeholder="4 位配对码" aria-label="Mac 配对码" />
        <button class="airplay-btn is-primary" data-airplay-pin-ok type="submit">配对</button>
        <button class="airplay-btn is-ghost" data-airplay-pin-cancel type="button">取消</button>
      </div>
    </form>
    <ul class="airplay-devices" data-airplay-devices></ul>
    <p class="airplay-empty" data-airplay-empty hidden></p>
    <p class="airplay-note">投送后本软件的声音改由 AirPlay 播放，本机静音；其他应用照常从扬声器播放。</p>
  `;

  const dotEl = query<HTMLElement>(root, '[data-airplay-dot]');
  const statusTextEl = query<HTMLElement>(root, '[data-airplay-status-text]');
  const refreshBtn = query<HTMLButtonElement>(root, '[data-airplay-refresh]');
  const noticeEl = query<HTMLElement>(root, '[data-airplay-notice]');
  const nowEl = query<HTMLElement>(root, '[data-airplay-now]');
  const nowNameEl = query<HTMLElement>(root, '[data-airplay-now-name]');
  const nowPrefixEl = query<HTMLElement>(root, '[data-airplay-now-prefix]');
  const nowListEl = query<HTMLElement>(root, '[data-airplay-now-list]');
  const disconnectBtn = query<HTMLButtonElement>(root, '[data-airplay-disconnect]');
  const volumeInput = query<HTMLInputElement>(root, '[data-airplay-volume]');
  const volumeValueEl = query<HTMLElement>(root, '[data-airplay-volume-value]');
  const passwordForm = query<HTMLFormElement>(root, '[data-airplay-password]');
  const passwordTextEl = query<HTMLElement>(root, '[data-airplay-password-text]');
  const passwordInput = query<HTMLInputElement>(root, '[data-airplay-password-input]');
  const passwordCancelBtn = query<HTMLButtonElement>(root, '[data-airplay-password-cancel]');
  const pinForm = query<HTMLFormElement>(root, '[data-airplay-pin]');
  const pinTextEl = query<HTMLElement>(root, '[data-airplay-pin-text]');
  const pinInput = query<HTMLInputElement>(root, '[data-airplay-pin-input]');
  const pinOkBtn = query<HTMLButtonElement>(root, '[data-airplay-pin-ok]');
  const pinCancelBtn = query<HTMLButtonElement>(root, '[data-airplay-pin-cancel]');
  const devicesEl = query<HTMLElement>(root, '[data-airplay-devices]');
  const emptyEl = query<HTMLElement>(root, '[data-airplay-empty]');
  const latencyDownBtn = query<HTMLButtonElement>(root, '[data-airplay-latency-down]');
  const latencyUpBtn = query<HTMLButtonElement>(root, '[data-airplay-latency-up]');
  const latencyValueEl = query<HTMLElement>(root, '[data-airplay-latency-value]');
  const latencyHintEl = query<HTMLElement>(root, '[data-airplay-latency-hint]');
  const noteEl = query<HTMLElement>(root, '.airplay-note');

  const targetDevice = (): AirplayDevice | null =>
    current.devices.find((device) => device.id === current.targetDeviceId) ?? null;

  const statusText = (): string => {
    if (!airplay.hostAvailable()) return '仅桌面应用可用';
    const count = current.devices.length;
    switch (current.state) {
      case 'scanning':
        if (scanExpired) return count > 0 ? `已发现 ${count} 台设备` : '没有发现可投送的设备';
        return count > 0 ? `已发现 ${count} 台，继续扫描中…` : '正在扫描局域网里的设备…';
      case 'connecting': {
        if (current.pinRequired) {
          if (current.pinSubmitted) return '正在配对，请在 Mac 上确认…';
          const pinDevice = current.devices.find((entry) => entry.id === current.pinDeviceId) ?? null;
          return pinDevice ? `「${pinDevice.name}」等待 Mac 配对码` : '等待 Mac 配对码';
        }
        const device = targetDevice();
        return device ? `正在连接 ${device.name}…` : '正在连接设备…';
      }
      case 'streaming': {
        const count = current.actives.length;
        if (count > 1) return `已连接 ${count} 台设备`;
        return current.actives[0] ? `正在投送到 ${current.actives[0].name}` : '投送中';
      }
      case 'error':
        return current.code ? AIRPLAY_ERROR_LABEL[current.code] : '投送出错';
      case 'idle':
      default:
        return count > 0 ? `已发现 ${count} 台可投送设备` : '未投送';
    }
  };

  const noticeText = (): { text: string; tone: 'is-warn' | 'is-error' } | null => {
    if (!airplay.hostAvailable()) {
      return {
        text: '投送需要 Zilux2 桌面应用（WebView2 宿主）。当前是浏览器预览，投送功能已自动关闭。',
        tone: 'is-warn',
      };
    }
    if (current.state === 'error') {
      const label = current.code ? AIRPLAY_ERROR_LABEL[current.code] : '投送出错';
      const detail = current.error && current.error !== label ? `：${current.error}` : '';
      return { text: `${label}${detail}`, tone: 'is-error' };
    }
    return null;
  };

  /** 设备行里已经有每台的停止按钮，这里不再重复一遍列表（避免信息重复、面板变长）。 */
  const renderNowList = (_actives: readonly AirplayActive[]): void => {
    nowListEl.hidden = true;
    if (nowListEl.innerHTML !== '') nowListEl.innerHTML = '';
  };

  const renderDevices = (hostReady: boolean): void => {
    const activeIds = new Set(current.actives.map((entry) => entry.id));
    const volumeById = new Map(current.actives.map((entry) => [entry.id, entry.volume] as const));
    const connectingId = current.state === 'connecting' ? current.targetDeviceId ?? '' : '';
    const signature = [
      current.devices.map((device) => `${device.id}:${device.name}:${device.host}:${device.model}:${device.requiresPassword ? 1 : 0}:${device.airPlay2 ? 1 : 0}`).join('|'),
      // 单台音量变化不重建列表（否则拖动滑块会被 innerHTML 打断），只同步数值
      current.actives.map((entry) => entry.id).join('|'),
      connectingId,
      hostReady ? '1' : '0',
    ].join('#');
    if (signature !== devicesSignature) {
      devicesSignature = signature;
      if (!hostReady) {
        devicesEl.hidden = true;
        devicesEl.innerHTML = '';
      } else {
        devicesEl.hidden = current.devices.length === 0;
        devicesEl.innerHTML = current.devices
          .map((device) => {
            const isActive = activeIds.has(device.id);
            const isConnecting = device.id === connectingId;
            const badges = [
              device.requiresPassword ? '<span class="airplay-badge">需要密码</span>' : '',
              device.airPlay2 ? '<span class="airplay-badge">AirPlay 2</span>' : '',
            ].join('');
            let action: string;
            if (isActive) {
              action = `<span class="airplay-connected">正在投送</span><button class="airplay-btn is-ghost is-mini" data-airplay-stop="${escapeHtml(device.id)}" type="button">停止</button>`;
            } else if (isConnecting) {
              action = `<button class="airplay-btn is-ghost" data-airplay-connect="${escapeHtml(device.id)}" type="button" disabled>连接中…</button>`;
            } else if (connectingId !== '') {
              // 宿主一次只能跟一台设备握手：前一台连上之前，其它设备先置灰
              action = `<button class="airplay-btn is-ghost" data-airplay-connect="${escapeHtml(device.id)}" type="button" disabled title="等前一台设备连上后再点">投送</button>`;
            } else {
              action = `<button class="airplay-btn is-primary" data-airplay-connect="${escapeHtml(device.id)}" type="button">投送</button>`;
            }
            const volume = volumeById.get(device.id) ?? 0;
            const volumeControl = isActive
              ? `<span class="airplay-device-volume"><input class="airplay-volume-range" type="range" min="0" max="100" step="1" value="${volume}" data-airplay-device-volume="${escapeHtml(device.id)}" aria-label="单独音量"><span class="airplay-volume-num">${volume}%</span></span>`
              : '';
            return `<li class="airplay-device${isActive ? ' is-active' : ''}${isConnecting ? ' is-connecting' : ''}" data-airplay-device-id="${escapeHtml(device.id)}">
              <span class="airplay-device-icon" aria-hidden="true">${iconHtml('airplay', 16)}</span>
              <span class="airplay-device-main"><strong>${escapeHtml(device.name)}</strong><span>${escapeHtml(deviceMetaLine(device))}</span></span>
              <span class="airplay-badges">${badges}</span>
              <span class="airplay-action">${action}</span>
              ${volumeControl}
            </li>`;
          })
          .join('');
      }
    }

    // 数值同步（拖动中的滑块不打断；每台独立音量）
    devicesEl.querySelectorAll<HTMLInputElement>('[data-airplay-device-volume]').forEach((input) => {
      const deviceId = input.dataset.airplayDeviceVolume ?? '';
      const value = volumeById.get(deviceId);
      if (value === undefined) return;
      if (document.activeElement !== input) input.value = String(value);
      const num = input.parentElement?.querySelector<HTMLElement>('.airplay-volume-num');
      if (num) {
        const shown = Number.parseInt(input.value, 10);
        num.textContent = `${Number.isFinite(shown) ? Math.min(100, Math.max(0, shown)) : value}%`;
      }
    });

    const shouldShowEmpty =
      hostReady &&
      current.devices.length === 0 &&
      current.actives.length === 0 &&
      current.state !== 'connecting';
    emptyEl.hidden = !shouldShowEmpty;
    if (shouldShowEmpty) {
      if (current.state === 'scanning' && !scanExpired) {
        emptyEl.textContent = '正在扫描局域网里的 AirPlay 设备…';
      } else if (current.state === 'error') {
        emptyEl.textContent = '没有扫描到设备。可以点「扫描设备」重试，或检查设备是否已开机。';
      } else {
        emptyEl.textContent =
          '没有发现可投送的设备。请确认设备与电脑连接同一 Wi-Fi，并允许 Zilux2 通过防火墙访问局域网。';
      }
    }
  };

  /**
   * 新连上的设备恢复到上次记住的音量（没有单独记录时退回记住的全局音量）。
   * 只在每台设备第一次出现在 actives 里时下发一次，避免和宿主的音量回传互相覆盖。
   */
  const restoreVolumes = (): void => {
    if (!airplay.hostAvailable()) return;
    const activeIds = new Set(current.actives.map((entry) => entry.id));
    for (const id of appliedVolumeIds) {
      if (!activeIds.has(id)) appliedVolumeIds.delete(id);
    }

    const globalVolume = rememberedAirplayVolume();
    for (const entry of current.actives) {
      if (appliedVolumeIds.has(entry.id)) continue;
      appliedVolumeIds.add(entry.id);
      const remembered = rememberedAirplayDeviceVolume(entry.id) ?? globalVolume;
      if (remembered === null || remembered === entry.volume) continue;
      airplay.setDeviceVolume(entry.id, remembered);
    }
  };

  /** 延迟调节：显示页面记住的数值，并提示改动只在下次投送时生效。 */
  const paintLatency = (): void => {
    const hostReady = airplay.hostAvailable();
    const value = airplay.latencyMs();
    latencyValueEl.textContent = `${value} ms`;
    latencyDownBtn.disabled = !hostReady || value <= AIRPLAY_LATENCY_MIN;
    latencyUpBtn.disabled = !hostReady || value >= AIRPLAY_LATENCY_MAX;
    latencyHintEl.textContent =
      hostReady && current.actives.length > 0 ? '重新投送后生效' : '越小越跟手';
    latencyHintEl.classList.toggle('is-pending', hostReady && current.actives.length > 0);
  };

  const stepLatency = (delta: number): void => {
    if (!airplay.hostAvailable()) return;
    airplay.setLatency(airplay.latencyMs() + delta);
    paintLatency();
  };

  const render = (): void => {
    const hostReady = airplay.hostAvailable();
    const notice = noticeText();

    dotEl.className = `airplay-dot is-${current.state}${ERROR_DOT_STATES.includes(current.state) ? ' is-error' : ''}`;
    statusTextEl.textContent = statusText();

    refreshBtn.hidden = !hostReady;
    refreshBtn.disabled = current.state === 'scanning' || current.state === 'connecting';
    refreshBtn.textContent = current.state === 'scanning' ? '扫描中…' : current.devices.length > 0 ? '重新扫描' : '扫描设备';

    noticeEl.hidden = notice === null;
    if (notice) {
      noticeEl.className = `airplay-notice ${notice.tone}`;
      noticeEl.textContent = notice.text;
    }

    const actives = current.actives;
    const nowVisible = hostReady && actives.length > 0;
    nowEl.hidden = !nowVisible;
    if (nowVisible) {
      const first = actives[0];
      const count = actives.length;
      nowPrefixEl.textContent = count > 1 ? '已连接' : '正在投送到';
      nowNameEl.textContent = count > 1 ? `${count} 台设备` : first.name;
      if (document.activeElement !== volumeInput) {
        volumeInput.value = String(first.volume);
      }
      volumeValueEl.textContent = `${first.volume}%`;
      renderNowList(actives);
    } else {
      renderNowList([]);
    }
    disconnectBtn.disabled = !hostReady;

    // 密码框：只有「连接失败且原因是需要密码」且用户没主动取消时出现
    const device = targetDevice();
    const needPassword =
      hostReady &&
      current.state === 'error' &&
      current.code === 'passwordRequired' &&
      current.passwordDeviceId !== null &&
      device !== null;
    if (current.passwordDeviceId !== lastPasswordDeviceId) {
      lastPasswordDeviceId = current.passwordDeviceId;
      passwordDismissed = false;
    }
    const passwordVisible = needPassword && !passwordDismissed;
    const wasHidden = passwordForm.hidden;
    passwordForm.hidden = !passwordVisible;
    if (passwordVisible && device) {
      passwordTextEl.textContent = `「${device.name}」需要密码才能连接`;
      if (wasHidden && root.isConnected) {
        window.setTimeout(() => passwordInput.focus(), 0);
      }
    }

    // 配对码框：macOS「隔空播放接收器」在 connecting 阶段索要 Mac 屏幕上的 4 位 HAP PIN。
    // 与密码框互斥（密码框只在 error + passwordRequired 出现），但可能先后出现：
    // 先 PIN 配对，宿主再报 passwordRequired 时密码框会重新出现。
    if (current.pinDeviceId !== lastPinDeviceId) {
      lastPinDeviceId = current.pinDeviceId;
      pinDismissed = false;
      pinInput.value = '';
      // 进入/离开配对流程时，让后续密码提示还有机会显示
      passwordDismissed = false;
    }
    const pinVisible =
      hostReady && current.pinRequired && current.pinDeviceId !== null && !pinDismissed;
    const pinWasHidden = pinForm.hidden;
    pinForm.hidden = !pinVisible;
    if (pinVisible) {
      const pinDevice = current.devices.find((entry) => entry.id === current.pinDeviceId) ?? null;
      const targetName = pinDevice?.name ?? '这台设备';
      pinTextEl.textContent = current.pinSubmitted
        ? '正在配对，请在 Mac 上确认…'
        : `「${targetName}」需要配对码。${current.pinMessage ?? '请在 Mac 屏幕上查看配对码并输入'}（4 位数字，2 分钟内有效）`;
      pinInput.disabled = current.pinSubmitted;
      pinOkBtn.disabled = current.pinSubmitted || pinInput.value.length !== 4;
      pinOkBtn.textContent = current.pinSubmitted ? '配对中…' : '配对';
      if (pinWasHidden && root.isConnected) {
        window.setTimeout(() => pinInput.focus(), 0);
      }
    }

    renderDevices(hostReady);
    restoreVolumes();
    paintLatency();

    // 底部说明跟着投送状态走：投送中提示本机会自动静音并恢复，否则说明默认行为
    noteEl.textContent =
      hostReady && actives.length > 0
        ? '投送期间只有本软件的声音送去 AirPlay，本机静音；其他应用照常从扬声器播放。音量会记住每台设备上次的设置。'
        : '投送后声音会从这台设备上暂停，改由 AirPlay 音箱播放。';
  };

  /* ---- 扫描 / 状态订阅 ---- */

  const armScanWindow = (): void => {
    scanExpired = false;
    if (scanTimer !== null) window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      scanTimer = null;
      scanExpired = true;
      render();
    }, SCAN_WINDOW_MS);
  };

  /** 手动「扫描设备」/ 重新扫描：重置本地时间窗并让宿主重新发现。 */
  const startScan = (): void => {
    armScanWindow();
    airplay.scan();
    render();
  };

  const flushVolume = (): void => {
    volumeTimer = null;
    const value = Number.parseInt(volumeInput.value, 10);
    if (!Number.isFinite(value)) return;
    const clamped = Math.min(100, Math.max(0, value));
    volumeValueEl.textContent = `${clamped}%`;
    airplay.setVolume(clamped);
    rememberAirplayVolume(clamped);
  };

  /* ---- 交互 ---- */

  refreshBtn.addEventListener('click', () => {
    if (!airplay.hostAvailable()) return;
    startScan();
  });

  disconnectBtn.addEventListener('click', () => {
    if (!airplay.hostAvailable()) return;
    airplay.disconnect();
  });

  latencyDownBtn.addEventListener('click', () => stepLatency(-AIRPLAY_LATENCY_STEP));
  latencyUpBtn.addEventListener('click', () => stepLatency(AIRPLAY_LATENCY_STEP));

  // 事件委托挂到 root：设备行的「投送」与「正在投送」卡片里的「停止」共用一套逻辑
  root.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    const stopButton = target?.closest<HTMLButtonElement>('[data-airplay-stop]');
    if (stopButton) {
      if (stopButton.disabled || !airplay.hostAvailable()) return;
      const deviceId = stopButton.dataset.airplayStop ?? '';
      if (deviceId) airplay.disconnectDevice(deviceId);
      return;
    }
    const button = target?.closest<HTMLButtonElement>('[data-airplay-connect]');
    if (!button || button.disabled) return;
    const deviceId = button.dataset.airplayConnect ?? '';
    if (!deviceId) return;
    passwordDismissed = false;
    airplay.connect(deviceId);
  });

  // 设备行里的小音量滑块：先即时更新数字，再按设备防抖提交给宿主（每台互不影响）
  root.addEventListener('input', (event) => {
    const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('[data-airplay-device-volume]');
    if (!input) return;
    const deviceId = input.dataset.airplayDeviceVolume ?? '';
    if (!deviceId) return;
    const value = Math.min(100, Math.max(0, Number.parseInt(input.value, 10) || 0));
    const num = input.parentElement?.querySelector<HTMLElement>('.airplay-volume-num');
    if (num) num.textContent = `${value}%`;
    const pending = deviceVolumeTimers.get(deviceId);
    if (pending !== undefined) window.clearTimeout(pending);
    deviceVolumeTimers.set(
      deviceId,
      window.setTimeout(() => {
        deviceVolumeTimers.delete(deviceId);
        if (!airplay.hostAvailable()) return;
        airplay.setDeviceVolume(deviceId, value);
        // 记住这台设备自己的音量，下次投送直接恢复
        rememberAirplayDeviceVolume(deviceId, value);
      }, VOLUME_DEBOUNCE_MS),
    );
  });

  passwordForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const deviceId = current.passwordDeviceId ?? current.targetDeviceId;
    if (!deviceId) return;
    const password = passwordInput.value;
    if (password.length === 0) {
      passwordInput.focus();
      return;
    }
    passwordDismissed = false;
    airplay.connect(deviceId, password);
    passwordInput.value = '';
  });

  passwordCancelBtn.addEventListener('click', () => {
    passwordDismissed = true;
    passwordInput.value = '';
    render();
  });

  // 配对码输入：只留数字、最多 4 位；凑满 4 位才允许提交
  pinInput.addEventListener('input', () => {
    const digits = pinInput.value.replace(/\D+/g, '').slice(0, 4);
    if (pinInput.value !== digits) pinInput.value = digits;
    pinOkBtn.disabled = current.pinSubmitted || digits.length !== 4;
  });

  pinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const deviceId = current.pinDeviceId ?? current.targetDeviceId;
    const value = pinInput.value.trim();
    if (!deviceId || !/^\d{4}$/.test(value)) {
      pinInput.focus();
      return;
    }
    pinDismissed = false;
    airplay.submitPin(deviceId, value);
    pinInput.value = '';
  });

  pinCancelBtn.addEventListener('click', () => {
    const deviceId = current.pinDeviceId ?? current.targetDeviceId;
    pinDismissed = true;
    pinInput.value = '';
    pinForm.hidden = true;
    // 契约没有「取消配对」动作：用 disconnect(deviceId) 让宿主中止这台设备的连接，
    // 已投送的其它设备不受影响；宿主若忽略，它会在 120 s 后自行超时失败。
    if (deviceId) airplay.disconnectDevice(deviceId);
    render();
  });

  volumeInput.addEventListener('input', () => {
    volumeValueEl.textContent = `${volumeInput.value}%`;
    if (volumeTimer !== null) window.clearTimeout(volumeTimer);
    volumeTimer = window.setTimeout(flushVolume, VOLUME_DEBOUNCE_MS);
  });
  volumeInput.addEventListener('change', () => {
    if (volumeTimer !== null) {
      window.clearTimeout(volumeTimer);
      volumeTimer = null;
    }
    flushVolume();
  });

  if (isPopover) {
    root.querySelector<HTMLElement>('[data-airplay-close]')?.addEventListener('click', () => {
      options.onRequestClose?.();
    });
  }

  const unsubscribe = airplay.subscribe((next) => {
    current = next;
    render();
  });
  render();

  return {
    element: root,
    activate(): void {
      if (active) return;
      active = true;
      // 宿主重启后内存里的延迟回到 300ms，面板打开时把页面记住的数值重新下发一次
      airplay.syncLatency();
      beginScan();
      armScanWindow();
      render();
    },
    deactivate(): void {
      if (!active) return;
      active = false;
      if (scanTimer !== null) {
        window.clearTimeout(scanTimer);
        scanTimer = null;
      }
      if (volumeTimer !== null) {
        window.clearTimeout(volumeTimer);
        volumeTimer = null;
      }
      for (const timer of deviceVolumeTimers.values()) window.clearTimeout(timer);
      deviceVolumeTimers.clear();
      endScan();
    },
    destroy(): void {
      if (active) {
        active = false;
        endScan();
      }
      if (scanTimer !== null) window.clearTimeout(scanTimer);
      if (volumeTimer !== null) window.clearTimeout(volumeTimer);
      for (const timer of deviceVolumeTimers.values()) window.clearTimeout(timer);
      deviceVolumeTimers.clear();
      scanTimer = null;
      volumeTimer = null;
      unsubscribe();
      root.remove();
    },
  };
}
