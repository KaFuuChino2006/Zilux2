/**
 * Zilux2 · 「唱片店」独立预览页（R1 原型）
 *
 * 只用于验证 3D 场景与相机手感，不接入主界面：
 * - ?quality=high|medium|low  画质档（默认 high）
 * - ?debug=1                  左上角调试角标（fps / draw call / dpr）
 * - ?focus=索引               打开后直接聚焦某张唱片（调试用）
 *
 * window.__storePreview 暴露 DOM 无关的调试接口，方便 CDP 脚本操作。
 */

import { createStoreScene, type StoreScene, type StoreSceneCollection } from '../ui/space/storeScene';

const TEMP_TITLES: ReadonlyArray<readonly [string, string, string]> = [
  ['夜色落在唱片上', 'Zilux2 试听', '午夜唱片'],
  ['old songs keep turning', 'muque', 'bestie'],
  ['暖光沿着纹路慢慢走', '演示歌手', '黑胶练习曲'],
  ['夜航星', '不才', '夜航星'],
  ['霓虹甜心', '夏日入侵企画', '我想了太多'],
  ['如果你也听说', '张惠妹', 'Star'],
  ['南方的秋天', '宿羽阳', '十一种孤独'],
  ['慢慢喜欢你', '莫文蔚', '我们在中场相遇'],
  ['まちがいさがし', '菅田将暉', 'まちがいさがし'],
  ['打上花火', 'DAOKO × 米津玄師', '打上花火'],
  ['雨のち晴れ', 'Vaundy', 'strobo'],
  ['Midnight Pretenders', 'Tomoko Aran', 'Fuyu-Kukan'],
];

function mockCollections(): StoreSceneCollection[] {
  return [
    {
      id: 'recent',
      title: '最近播放',
      subtitle: 'R1 占位数据',
      songs: TEMP_TITLES.map(([title, artist, album], index) => ({
        trackKey: `mock-${index}`,
        title,
        artist,
        album,
      })),
    },
  ];
}

const params = new URLSearchParams(location.search);
const stage = document.getElementById('stage');
const debugBadge = document.getElementById('debug-badge');
const showDebug = params.get('debug') === '1';
const quality = params.get('quality');
const focusParam = params.get('focus');

if (debugBadge) debugBadge.style.display = showDebug ? 'block' : 'none';

const toast = (() => {
  const node = document.createElement('div');
  node.style.cssText =
    'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);padding:8px 18px;border-radius:999px;' +
    'background:rgba(20,15,10,.72);border:1px solid rgba(255,226,180,.18);color:#ffe9c8;font:12.5px/1.6 "Zilux2 Sans SC","Microsoft YaHei",sans-serif;' +
    'letter-spacing:.06em;opacity:0;transition:opacity .3s ease;pointer-events:none;z-index:10';
  document.body.append(node);
  let timer = 0;
  return (text: string): void => {
    node.textContent = text;
    node.style.opacity = '1';
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      node.style.opacity = '0';
    }, 2200);
  };
})();

if (!stage) {
  throw new Error('preview-store: missing #stage');
}

const scene: StoreScene = createStoreScene(stage, {
  quality: quality === 'low' || quality === 'medium' ? quality : 'high',
  onFocus: (song) => {
    if (showDebug && debugBadge) debugBadge.dataset.focus = song ? song.title : '';
  },
  onPlay: (song) => {
    toast(`原型：将播放《${song.title}》· R3 接入真实播放器`);
  },
  onFallback: () => {
    toast('当前环境不支持 WebGL2，已回退为扁平货架');
  },
});

scene.setCollections(mockCollections());
scene.setActiveTrack('mock-1');

const initialFocus = focusParam === null ? Number.NaN : Number(focusParam);
if (Number.isFinite(initialFocus)) {
  requestAnimationFrame(() => scene.focusIndex(Math.max(0, Math.min(11, Math.trunc(initialFocus)))));
}

if (showDebug && debugBadge) {
  const tick = (): void => {
    const stats = scene.stats();
    debugBadge.textContent =
      `R1 Store Preview  ${stats.fps} fps  draws=${stats.drawCalls}  tris=${stats.triangles}\n` +
      `dpr=${stats.dpr}  canvas=${stats.width}x${stats.height}`;
    requestAnimationFrame(tick);
  };
  tick();
}

declare global {
  interface Window {
    __storePreview?: {
      scene: StoreScene;
      setCollections: (collections: StoreSceneCollection[]) => void;
      focus: (index: number) => void;
      reset: () => void;
      stats: () => ReturnType<StoreScene['stats']>;
    };
  }
}

window.__storePreview = {
  scene,
  setCollections: (collections) => scene.setCollections(collections),
  focus: (index) => scene.focusIndex(index),
  reset: () => scene.resetView(),
  stats: () => scene.stats(),
};
