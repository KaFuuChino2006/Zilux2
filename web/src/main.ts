/** 新前端入口：启动序列 + 全局快捷键 + 宿主就绪握手。 */

import { host, hostAvailable, onWallpaperState, postMessage, type UpdateSnapshot } from './core/bridge';
import { initAccount } from './core/account';
import { loadSettings } from './core/settings';
import { initAppAudioOutput, initSystemAudioOutput } from './core/audioOutput';
import { initOnline, onlineReady, setStreamQuality } from './online/client';
import { App } from './ui/app';
import { restoreLastPlayback, setVolume } from './ui/player';
import { startAutoPlayOnBoot } from './ui/autoPlay';
import { h, toast } from './ui/dom';
import { initTheme } from './ui/theme';
import { installCoverFallback } from './ui/coverFallback';
import { installAppTooltips } from './ui/tooltip';
import { installChorusPreview } from './ui/chorusPreview';
import { refreshArtworkCovers } from './online/artwork';
import { initUpdates, downloadUpdate, installUpdate, openReleasePage, onUpdateChange, updateSnapshot } from './ui/updates';
import { showUpdateNotes } from './ui/updateNotes';
import { ignoreUpdateVersion, shouldPromptUpdate } from './ui/updateReminders';
import { startWallpaperLayer } from './ui/wallpaperLayer';
import { refreshPageWallpaperSwitches } from './wallpaper/client';
import { startLyricVisualizer } from './ui/lyricsVisualizer';
import { startAppearanceLink } from './ui/wallpaperAutoPreset';
import { bootWallpaperScene, isWallpaperScene } from './ui/wallpaperScene';
import { initAudio } from './core/audio';
import { bootBackgroundLyricsScene, installBackgroundLyricsPublisher, isBackgroundLyricsScene } from './ui/backgroundLyrics';
import { installGpuStarvationGuard } from './core/gpuGuard';
import { seedMixTransitionModeDefault } from './core/mixTransitionMode';

// 更新提示去重：同一个版本只提示一次，宿主重复推送也不会反复弹窗。
let availablePromptedVersion: string | null = null;
let readyPromptedVersion: string | null = null;
let installedPromptedVersion: string | null = null;

/** 记录「上一次已经看过的版本」，用来判断刚更新完该不该弹当前版本的更新内容。 */
const WHATS_NEW_SEEN_KEY = 'zilux2.whatsNewSeen';

const normalizeVersion = (value: string): string => value.trim().replace(/^v/i, '');

function readSeenVersion(): string {
  try {
    return localStorage.getItem(WHATS_NEW_SEEN_KEY) || '';
  } catch {
    return '';
  }
}

function markSeenVersion(version: string): void {
  try {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, version);
  } catch {
    // 存不了就只在本次会话里去重，不影响主流程。
  }
}

/**
 * 更新提示：三个时机都复用同一块「版本 + 更新内容」面板。
 *  1) 发现新版本：显示下一个版本的更新内容（点空白 / Esc / × 关闭即稍后）；
 *  2) 新版本已下载：提示是否立即安装（点空白 = 稍后）；
 *  3) 更新完成后的第一次启动：显示当前版本的更新内容，并记住已看过。
 */
function handleUpdatePrompt(update: UpdateSnapshot): void {
  if (update.state === 'available' && update.latestVersion) {
    const version = normalizeVersion(update.latestVersion);
    if (!version || availablePromptedVersion === version) return;
    // 用户选过「不再提示这个版本 / N 天内不再提示」就不再打扰（新版本仍会提示）。
    if (!shouldPromptUpdate(version)) return;
    availablePromptedVersion = version;
    const auto = update.mode === 'auto';
    showUpdateNotes({
      kind: 'available',
      version,
      releaseName: update.releaseName,
      notes: update.notes ?? '',
      downloading: auto,
      allowSnooze: true,
      onDismiss: (choice) => {
        if (choice.ignore) ignoreUpdateVersion(version);
      },
      onDownload: auto ? undefined : downloadUpdate,
      onOpenRelease: openReleasePage,
    });
    return;
  }

  if (update.state === 'downloaded' && update.latestVersion) {
    const version = normalizeVersion(update.latestVersion);
    if (!version || readyPromptedVersion === version) return;
    if (!shouldPromptUpdate(version)) return;
    readyPromptedVersion = version;
    showUpdateNotes({
      kind: 'downloaded',
      version,
      releaseName: update.releaseName,
      notes: update.notes ?? '',
      allowSnooze: true,
      onDismiss: (choice) => {
        if (choice.ignore) ignoreUpdateVersion(version);
      },
      onInstall: installUpdate,
      onOpenRelease: openReleasePage,
    });
    return;
  }

  if (update.state !== 'up-to-date' || !update.currentVersion) return;
  const version = normalizeVersion(update.currentVersion);
  if (!version) return;
  const seen = readSeenVersion();
  if (seen === version || installedPromptedVersion === version) return;
  installedPromptedVersion = version;
  markSeenVersion(version);
  const notes = (update.notes ?? '').trim();
  if (!notes) return;
  showUpdateNotes({
    kind: 'installed',
    version,
    releaseName: update.releaseName,
    notes,
    onOpenRelease: openReleasePage,
  });
}


function createSplash(title: string, subtitle: string): HTMLDivElement {
  const el = h(
    'div',
    { class: 'splash' },
    h(
      'div',
      { style: 'display:flex;flex-direction:column;align-items:center;gap:4px' },
      h('div', { class: 'splash-mark', text: title }),
      subtitle ? h('div', { class: 'splash-sub', text: subtitle }) : null,
    ),
  );
  return el;
}

/** 等待在线服务就绪（宿主推送端口/token），超时返回 false。 */
function waitOnline(timeoutMs: number): Promise<boolean> {
  if (onlineReady()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    const poll = window.setInterval(() => {
      if (settled) return;
      if (onlineReady()) {
        settled = true;
        window.clearTimeout(timer);
        window.clearInterval(poll);
        resolve(true);
      }
    }, 120);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // 掉帧兜底：主屏全屏游戏抢 GPU 时，副屏页面的 rAF 间隔会被拉长。
  // 采到持续掉帧就摘掉全站 backdrop-filter（core/gpuGuard.ts + styles/gpu-guard.css），
  // 恢复后自动加回来。必须最早安装，否则启动阶段的卡顿会被算进首屏。
  installGpuStarvationGuard();
  // 音频特征：宿主 30Hz 推送 bins/bands/level/peak/beat/strength/bpm。
  // 这个订阅必须早于任何消费端（壁纸节拍脉冲、可视化、歌词动效），否则它们永远拿到空帧。
  initAudio();
  onWallpaperState(() => {});
  // 软件内壁纸层：订阅宿主推送、按页面开关决定显隐。
  // TEMP-HOLD（2026-11-18）：软件内壁纸层与壁纸页/歌词页的组合仍会把主线程卡死（video 反复重建、
  // media 请求被 abort），先不启动它；桌面层每块屏的页面独立渲染，不受影响。
  startWallpaperLayer();
  // 设置里的「页面显示壁纸」四个开关决定哪些页面把底让给壁纸：开机先读一次，
  // 否则用户上次开着的开关要等他进过壁纸页（那次才拉 options）才生效。
  refreshPageWallpaperSwitches();
  startLyricVisualizer();
  startAppearanceLink();
  // 混音过渡：新装/重置后默认走「自动（按两首判断）」；用户手动切过档就不再覆盖。
  seedMixTransitionModeDefault();

  // 桌面背景歌词：宿主把这块页面挂在桌面壁纸层下，只需要演出，不启动整套 App。
  // 桌面壁纸层：挂在 Progman 下的第二个页面，只演壁纸，不启动整套 App。
  if (isWallpaperScene()) {
    await bootWallpaperScene();
    return;
  }

  if (isBackgroundLyricsScene()) {
    await bootBackgroundLyricsScene();
    return;
  }

  installCoverFallback();
  installAppTooltips();
  installChorusPreview(document.body);
  // 宿主消息监听要先装好，再告诉宿主页面已就绪（宿主收到 ready 才会推送在线端口/账号）。
  initOnline();
  initAccount();
  initUpdates();
  const settings = await loadSettings();
  initTheme();
  // 音频输出：本软件通道（setSinkId）与系统默认设备（宿主 WASAPI）各一条，互不影响。
  initAppAudioOutput();
  initSystemAudioOutput();
  setVolume(settings.playback.volume);
  setStreamQuality(settings.playback.quality);

  const root = document.getElementById('app');
  if (!root) throw new Error('#app not found');

  root.style.opacity = '0';
  root.style.transition = 'opacity 420ms cubic-bezier(.22,.8,.25,1)';
  const revealFallback = window.setTimeout(() => {
    root.style.opacity = '1';
    document.querySelector('.splash')?.remove();
  }, 11000);
  const app = new App();
  app.mount(root);
  installBackgroundLyricsPublisher();
  restoreLastPlayback();
  host.ready();
  host.setChromeColor('#ffffff');

  const splashTitle = settings.general.splashTitle.trim() || 'ZILUX2';
  const splashSubtitle = settings.general.splashSubtitle.trim();
  const splash = settings.general.splash ? createSplash(splashTitle, splashSubtitle) : null;
  if (splash) document.body.append(splash);
  await Promise.race([document.fonts.ready, sleep(1500)]);
  postMessage({ v: 1, type: 'startupPreview' });
  const startedAt = performance.now();

  const ready = await waitOnline(7000);
  // 启动早期（恢复上次播放队列等）渲染的封面可能绑着上次启动的回环端口，
  // 在线服务就绪后重新绑定一遍，不用用户切歌。
  refreshArtworkCovers();
  if (ready) {
    await app.afterOnlineReady();
    refreshArtworkCovers();
    window.setTimeout(refreshArtworkCovers, 1400);
    // 「打开软件直接播放」：在线与账号就绪后再触发，避免启动早期拿不到歌单。
    void startAutoPlayOnBoot();
  } else {
    await app.enter();
    if (hostAvailable()) toast('在线服务未就绪，只能使用本地曲库', 'error');
  }

  // 更新提示等界面就绪后再处理，避免被启动画面盖住；先补一次已到达的快照再订阅后续推送。
  onUpdateChange(handleUpdatePrompt);
  handleUpdatePrompt(updateSnapshot());

  // Font substitution changes title metrics; finish it before revealing the UI.
  await Promise.race([document.fonts.ready, sleep(1500)]);
  const elapsed = performance.now() - startedAt;
  if (splash) {
    await sleep(Math.max(0, 800 - elapsed));

  }

  // The handshake above starts services; this separate signal reveals stable content.
  await Promise.race([
    new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    sleep(200),
  ]);
  window.clearTimeout(revealFallback);
  postMessage({ v: 1, type: 'contentReady' });
  root.style.opacity = '1';
  if (splash) {
    splash.classList.add('is-done');
    window.setTimeout(() => splash.remove(), 520);
  }

  // 全局快捷键
  window.addEventListener('keydown', (event) => {
    const target = event.target;
    // 只有「会吞字符的输入控件」才拦截快捷键。之前把所有 INPUT 都算输入框，
    // 结果焦点落在音量/进度条这类 range 滑块上时，空格、M、Shift+←/→ 全都失效。
    const textEntry = (element: Element | null): boolean => {
      if (!(element instanceof HTMLElement)) return false;
      if (element.isContentEditable || element.tagName === 'TEXTAREA') return true;
      if (element.tagName === 'SELECT') return true;
      if (element.tagName !== 'INPUT') return false;
      const type = (element as HTMLInputElement).type;
      return type !== 'range' && type !== 'checkbox' && type !== 'radio' && type !== 'color';
    };
    const inField = textEntry(target as Element | null);

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      app.focusSearch();
      return;
    }
    if (event.key === 'Escape') {
      app.escapeTopLayer();
      return;
    }
    // 输入法组词中不抢按键（尤其空格），否则中文输入会被打断。
    if (event.isComposing) return;
    if (inField) return;
    if (event.code === 'Space') {
      event.preventDefault();
      app.playCurrent();
      return;
    }
    // M：静音 / 恢复
    if (event.key.toLowerCase() === 'm' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      app.toggleMute();
      return;
    }
    // Shift + ←/→：快退 / 快进 5 秒
    if (
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    ) {
      event.preventDefault();
      app.seekBy(event.key === 'ArrowRight' ? 5000 : -5000);
      return;
    }
    // 数字 1–4：热 cue（空位记录 / 已记录则跳转）；Shift + 数字：清除
    // 注意：按住 Shift 时 event.key 会变成 "!" "@" "#" "$"，所以要用 event.code 判定。
    const cueDigit = /^(?:Digit|Numpad)([1-4])$/.exec(event.code);
    if (cueDigit && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      const slot = Number(cueDigit[1]);
      if (event.shiftKey) app.clearHotCue(slot);
      else app.hotCue(slot);
      return;
    }
    // Shift + X：本次切歌不使用无缝过渡（一次性）
    if (event.key.toLowerCase() === 'x' && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      app.suppressCrossfadeOnce();
      return;
    }
    // L：按当前小节循环（4 小节）
    if (event.key.toLowerCase() === 'l' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      app.toggleLoop();
      return;
    }
    // T：跟拍校速（至少 4 下）；Shift + T：清除本曲跟拍速度
    if (event.key.toLowerCase() === 't' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (event.shiftKey) app.clearTempoOverride();
      else app.tapTempo();
      return;
    }
    if (event.key === 'ArrowRight' && event.altKey) {
      event.preventDefault();
      app.nextTrack();
      return;
    }
    if (event.key === 'ArrowLeft' && event.altKey) {
      event.preventDefault();
      app.prevTrack();
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      app.focusSearch();
    }
  });

  // 页面异常写入宿主日志（排查用）
  window.addEventListener('error', (event) => {
    host.log('error', `[web] ${event.message} @ ${event.filename}:${event.lineno}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? event.reason.message : String(event.reason);
    host.log('warn', `[web] unhandled rejection: ${reason}`);
  });
}

main().catch((err: unknown) => {
  console.error('[main] boot failed', err);
  const root = document.getElementById('app');
  if (root) {
    root.textContent = '';
    root.append(
      h(
        'div',
        {
          class: 'wall-empty',
          style: 'position:fixed;inset:0;display:grid;place-items:center;color:#858a95;font-size:14px',
          text: `启动失败：${err instanceof Error ? err.message : String(err)}`,
        },
      ),
    );
  }
});


