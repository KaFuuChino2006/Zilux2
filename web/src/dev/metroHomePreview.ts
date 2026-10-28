/**
 * 「音乐地铁图 · 分类首页 + 单线页」独立预览页（2026-10-28 晚，M3 第一步）。
 *
 * 直接复用应用内入口 `openMetroOverlay()`，只把数据换成 M1 假数据（`?metroMock=1`），
 * 因此看到的就是真实的应用内表现（app.css 一并加载）：
 *   - 打开先看到分类大图标（收藏 / 推荐 / 历史播放 / 热门歌单 / 私人雷达）；
 *   - 点任意大图标 → 该线路画成一条水平直线，可点站开卡片、播放/加入队列；
 *   - 「‹ 返回分类」或 Esc 回首页；首页 Esc 关闭。
 *
 * 调试钩子：window.__metroHomePreview = { close }。
 */

import '../styles/app.css';
import { openMetroOverlay } from '../ui/metro/metroOverlay';

// 预览页固定走假数据：overlay 内部按 location.search 判定，必须在 open 前写进去。
const url = new URL(location.href);
if (url.searchParams.get('metroMock') !== '1') {
  url.searchParams.set('metroMock', '1');
  history.replaceState(null, '', url);
}

openMetroOverlay();

interface MetroHomePreviewDebug {
  close: () => void;
}

const debug: MetroHomePreviewDebug = {
  close: () => {
    const closeBtn = document.querySelector<HTMLButtonElement>('.metro-overlay-close');
    closeBtn?.click();
  },
};

declare global {
  interface Window {
    __metroHomePreview?: MetroHomePreviewDebug;
  }
}

window.__metroHomePreview = debug;
