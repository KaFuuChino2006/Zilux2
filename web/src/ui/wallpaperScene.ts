/**
 * 桌面壁纸场景：宿主在 Progman 下开的第二个 WebView2 用这个入口（`?scene=wallpaper`）。
 *
 * 它只做一件事 —— 把 `#wallpaper-root` 铺满并跟随宿主推送的 `wallpaperState` 播放。
 * 不加载主 App（不进 rail/首页/播放条），也不读本地设置：所有参数都在推送里。
 */
import { onMonitorSweep, onWallpaperState } from '../core/bridge';
import { initOnline } from '../online/client';
import { initMonitorSweep, playMonitorSweep } from './monitorSweep';
import { startWallpaperLayer } from './wallpaperLayer';

export function isWallpaperScene(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('scene') === 'wallpaper';
  } catch {
    return false;
  }
}

export async function bootWallpaperScene(): Promise<void> {
  document.documentElement.classList.add('is-wallpaper-scene');

  // mediaUrl 是回环相对路径，<video src> 需要绝对地址 + token，所以先拿在线端点。
  initOnline();

  // 订阅即绑定：bridge 收到 wallpaperState 后会回调并驱动 wallpaperLayer。
  onWallpaperState(() => {});
  startWallpaperLayer();

  // 点选屏幕时的「就是这一块」提示：宿主只发给被选中的那块屏。
  initMonitorSweep();
  onMonitorSweep(() => playMonitorSweep());
  // 也留一个手动入口（宿主 ExecuteScript 兜底 / 排查时直接调）。
  (window as unknown as { __ziluxSweep?: () => void }).__ziluxSweep = playMonitorSweep;

  // 告诉宿主「这一层页面活了」，请它补推一次状态：宿主的第一次推送几乎必然
  // 早于 CoreWebView2 就绪而被丢掉，没有这一步桌面层会一直空着。
  const host = (window as unknown as {
    chrome?: { webview?: { postMessage: (message: unknown) => void } };
  }).chrome?.webview;
  host?.postMessage({ v: 1, type: 'wallpaperReady' });

  // 桌面页面永远是「壁纸可见」的，不跟页面类型开关走（没有 rail/歌词页）。
  document.documentElement.classList.add('is-wallpaper-layer');
}
