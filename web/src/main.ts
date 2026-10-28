/** 新前端入口：启动序列 + 全局快捷键 + 宿主就绪握手。 */

import { host, hostAvailable, type UpdateSnapshot } from './core/bridge';
import { initAccount } from './core/account';
import { loadSettings } from './core/settings';
import { initOnline, onlineReady, setStreamQuality } from './online/client';
import { App, readInterfaceMode } from './ui/app';
import { restoreLastPlayback, setVolume } from './ui/player';
import { startAutoPlayOnBoot } from './ui/autoPlay';
import { h, toast } from './ui/dom';
import { initTheme } from './ui/theme';
import { installCoverFallback } from './ui/coverFallback';
import { refreshArtworkCovers } from './online/artwork';
import { confirmDialog } from './ui/confirmDialog';
import { initUpdates, installUpdate, onUpdateChange, updateSnapshot } from './ui/updates';

// 更新提示去重：同一个版本只提示一次，宿主重复推送也不会反复弹窗。
let promptedVersion: string | null = null;
let notifiedVersion: string | null = null;

/** 处理更新推送提示：auto 模式下载完成时问一次是否安装；notify 模式发现新版时轻提示一次。 */
function handleUpdatePrompt(update: UpdateSnapshot): void {
  if (update.state === 'downloaded' && update.mode === 'auto') {
    const version = update.latestVersion || update.currentVersion;
    if (promptedVersion === version) return;
    promptedVersion = version;
    const label = version ? `v${version}` : '新版本';
    void confirmDialog({
      title: '安装更新',
      message: `${label} 已下载完成，立即安装并重启？`,
      detail: '安装期间播放会中断，已打开的窗口会被关闭。',
      confirmText: '立即安装并重启',
      cancelText: '稍后',
      iconName: 'download',
    }).then((ok) => {
      if (ok) installUpdate();
    });
    return;
  }
  if (update.state === 'available' && update.mode === 'notify') {
    const version = update.latestVersion;
    if (!version || notifiedVersion === version) return;
    notifiedVersion = version;
    toast(`发现新版本 v${version}，可在「设置 → 更新」中下载`);
  }
}


function createSplash(): HTMLDivElement {
  const el = h(
    'div',
    { class: 'splash' },
    h(
      'div',
      { style: 'display:flex;flex-direction:column;align-items:center;gap:4px' },
      h('div', { class: 'splash-mark', text: 'ZILUX2' }),
      h('div', { class: 'splash-sub', text: 'IMMERSIVE MUSIC SPACE' }),
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
  installCoverFallback();
  // 宿主消息监听要先装好，再告诉宿主页面已就绪（宿主收到 ready 才会推送在线端口/账号）。
  initOnline();
  initAccount();
  initUpdates();
  const settings = await loadSettings();
  initTheme();
  setVolume(settings.playback.volume);
  setStreamQuality(settings.playback.quality);

  const root = document.getElementById('app');
  if (!root) throw new Error('#app not found');

  const app = new App();
  app.mount(root);
  restoreLastPlayback();
  host.ready();
  host.setChromeColor('#f3f1ea');

  const splash = settings.general.splash ? createSplash() : null;
  if (splash) document.body.append(splash);
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

  // 启动界面选择「地铁图」时：应用启动后直接进入音乐地铁图（覆盖层内自带加载态）。
  if (readInterfaceMode() === 'metro') {
    void import('./ui/metro/metroOverlay').then((mod) => mod.openMetroOverlay());
  }

  // 更新提示等界面就绪后再处理，避免被启动画面盖住；先补一次已到达的快照再订阅后续推送。
  onUpdateChange(handleUpdatePrompt);
  handleUpdatePrompt(updateSnapshot());

  const elapsed = performance.now() - startedAt;
  if (splash) {
    await sleep(Math.max(0, 800 - elapsed));
    splash.classList.add('is-done');
    window.setTimeout(() => splash.remove(), 520);
  }

  // 全局快捷键
  window.addEventListener('keydown', (event) => {
    const target = event.target;
    const inField =
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      app.focusSearch();
      return;
    }
    if (event.key === 'Escape') {
      app.escapeTopLayer();
      return;
    }
    if (inField) return;
    if (event.code === 'Space') {
      event.preventDefault();
      app.playCurrent();
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
