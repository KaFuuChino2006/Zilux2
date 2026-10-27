# Zilux2 3D 歌曲页（Song Grid）契约 v1

> 状态：v1（2026-10-18）· 需求：点击任意歌单卡片 → 二维卡片流畅过渡到整页 3D 歌曲立方体；悬停凸显、点击放大、歌词在封面右侧展开
> 关联：`docs/zilux2-design-system.md`（白色磨砂）、`docs/zilux2-library.md`（歌单数据）

## 1. 交互流程

1. 首页任意歌单卡片（我喜欢 / 自建 / 他人歌单）点击 → 卡片封面原地成为 3D 场景的「起始平面」，随 3D 相机运动落到网格中的位置（约 620ms，`cubic-bezier(.22,.61,.36,1)`），首页背景淡出、歌单页入场。
2. 歌单页 = 全屏 3D 场景：每首歌是一个**玻璃立方体**，正面贴「封面 + 歌名/歌手」纹理，按**网格墙**排列（多行多列，近大远小，轻微深度错落）；底部或右侧保留播放器控制条（复用现有 player，保持显示）。
3. 悬停：目标立方体抬升/放大/提亮（高光描边 + 轻微前移），其余立方体降低亮度/透明度（约 55%），形成聚焦。
4. 点击立方体：该立方体动画移动到画面左侧偏中（放大到约 2.2 倍视角占比），其余立方体退到背景并变暗；**歌词面板从封面右侧展开**（DOM 面板，现有 lyricsPanel 复用/改造），演唱自动开始（`player.playOnline(track, songs)`）。
5. 再次点击其他立方体 → 播放切换；点击空白或返回按钮 → 退出聚焦/返回网格。
6. 布局模式：默认「网格」（自动列数），可切换「竖排」（单列，居中滚动）；切换有 300ms 过渡。
7. 返回：按 Esc / 顶栏返回按钮 → 3D 场景收回卡片，切回首页（反向过渡约 420ms）。

## 2. 3D 视觉规格（白色磨砂）

- 背景：透明 canvas，由页面 CSS 提供 `#f6f7fb` 浅色底 + 低饱和极光（与首页一致）；不加暗色。
- 立方体：主体尺寸 `1.0 × 1.0 × 0.22`（宽/高/厚），正面（+Z）为封面纹理；侧面/背面为**玻璃材质**——半透明白 `rgba(255,255,255,0.20)` + Fresnel 白边（约 0.35），不使用高消耗的 transmission；底部加浅色倒影（`rgba(23,26,33,0.10)` 渐变）。
- 纹理：每首歌一张 tile（512×512 或 640×640）：上部 78% 为封面图（由调用方提供 `CanvasImageSource`），下部 22% 为白色磨砂信息条（歌名 600 字重、歌手 + 时长小字，深色文字），文字由 Canvas2D 烘焙。
- 阴影：立方体底部柔和投影（Canvas 纹理或 shader 渐变），浅色系，不刺眼。
- 选中：立方体正面保持彩色，侧面高光加强（白边 0.6），并轻微向前浮起。
- 网格参数：列数按画面宽度自适应（约 `ceil(width / 220)`，5–9 列），行距 = 立方体高 × 1.28，整体相机 FOV 38°、视点略高于中心（俯视 3–5°）、轻微左右错落（±0.04 深度）；网格可上下滚动/拖拽浏览（窗口化渲染）。
- 竖排模式：单列（宽 1.1），每行居中，间距 ×1.35，支持上下滚动。

## 3. 过渡规格（2D → 3D）

- 模块提供 `enterFrom({ rect, cover })`：`rect` 为被点击卡片封面在浏览器视口内的 `DOMRect`（CSS px）；`cover` 为同一封面的 `CanvasImageSource`。
- 场景初始：只显示一个与 `rect` 屏幕位置/尺寸完全重合的平面（用相机投影反算世界坐标），随后 620ms 内插值到该歌曲在网格中的落点，同时网格其余立方体淡入（前 40% 时间淡入）。
- 首页 DOM 侧：点击时把该卡片封面克隆到 fixed overlay 并隐藏原元素；3D 开始接管后移除克隆（避免双影）。若无法提供 rect/cover，退化为普通淡入（不阻塞）。
- 退出 `leaveTo(rect?)`：反向 420ms；`rect` 缺省时整体淡出。

## 4. 性能护栏

- 单 canvas、单 WebGL2 上下文、单 rAF（`start/stop`）。
- **InstancedMesh + 图集**：固定实例槽位（建议 36 = 6×6 可见窗口），歌曲数超过槽位时按滚动窗口复用；封面/文字合成进图集（≤2048²，LRU，只上传变化格）。
- 像素预算：`pickPixelRatio(cssW, cssH, { maxDpr: 2, minScale: 0.7, budget: 4_500_000 })`；DPR 上限 2。
- 静止时（无过渡/无 hover/无滚动）可停 rAF 或降至 30fps（帧闸门）。
- `dispose()`：图集纹理、InstancedMesh、几何、材质、renderer、事件监听、rAF 全部释放。

## 5. 模块 API（`web/src/three/songGrid.ts`，由 visual-dev 实现）

```ts
export interface SongItem {
  key: string;
  cover: CanvasImageSource;   // 调用方提供封面（程序化或真实封面）
  title: string;
  artist: string;
  duration?: string;          // "3:19"，可选，烘焙进 tile 信息条
}

export interface SongGridOptions {
  layout?: 'grid' | 'column';
  maxSlots?: number;          // 默认 36
  pixelBudget?: number;       // 默认 4_500_000
  accent?: string;            // 默认 '#6a5cff'
}

export interface EnterFromOptions { rect: { left: number; top: number; width: number; height: number }; cover?: CanvasImageSource; }

export interface SongGrid {
  setSongs(items: SongItem[]): void;
  layout(value: 'grid' | 'column'): void;
  enterFrom(options?: EnterFromOptions): void;
  leaveTo(rect?: { left: number; top: number; width: number; height: number }): void;
  select(index: number): void;
  getSelected(): number;
  onSelect(cb: (index: number, item: SongItem) => void): void;
  onHover(cb: (index: number | null) => void): void;
  resize(): void;
  start(): void;
  stop(): void;
  dispose(): void;
}

export function createSongGrid(canvas: HTMLCanvasElement, options?: SongGridOptions): SongGrid;
```

## 6. 页面集成（`web/src/ui/songGridPage.ts`，由 web-dev 实现）

- 全屏层：顶部返回 + 歌单标题/曲目数 + 布局切换（网格/竖排）+ 播放全部；中间 3D canvas；底部保留播放器（现有 player 元素复用，z-index 高于 canvas）。
- 歌词面板：聚焦播放时从封面右侧展开（复用 `createLyricsPanel` 的渲染逻辑，可新增 `mode: 'side'` 位置参数），与 `onTime` 同步；关闭聚焦时收起。
- 数据：`fetchPlaylist(source, id, offset, limit)`；先加载首屏 60 首，滚动到底部时加载更多（offset/limit），追加到 `setSongs`。
- 曲目点击播放：`player.playOnline(track, songs)`；VIP 不可播灰显提示。
- QA：`?mock=1&panel=grid&source=netease&id=mock-1` 直接打开 3D 歌曲页（便于用户验收）。

## 7. 验收（用户手工）

1. 首页点任意歌单卡片：二维封面流畅过渡成整页 3D 立方体墙，无白屏/跳变。
2. 悬停立方体凸显、其余变淡；点击后放大并开始播放，歌词在封面右侧展开且逐行滚动。
3. 网格/竖排布局切换自然；Esc/返回回到首页并保持卡片位置。
4. 60 首以上歌单滚动不卡顿、内存稳定；切歌/返回后无残留 rAF（任务管理器 CPU 回落）。
5. 浅色磨砂观感：无黑底、无霓虹描边、文字清晰。
