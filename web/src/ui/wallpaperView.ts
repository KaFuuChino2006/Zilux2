/**
 * 动态壁纸库页面（docs/wallpaper-v2-spec.md §5.10）
 * 结构：顶栏（搜索 + 标签 chips + 排序/密度）→ 两张「当前壁纸」卡（软件内 / 桌面层）
 *       下面是卡片网格，右侧是详情抽屉。
 */

import { host } from '../core/bridge';
import { BlockEntrance } from './blockEntrance';
import { h, icon, toast } from './dom';
import { broadcastAppBgMode } from './appBackground';
import { createSelectControl } from './selectControl';
import { applyAsset, attachDesktop, cleanStorage, coverUrl, deleteAsset, detachDesktop, fetchAsset, fetchCanvasSettings, fetchLibrary, fetchMonitors, fetchOptions, fetchState, fetchStorage, fetchTags, fmtDuration, fmtResolution, fmtSize, isWallpaperReady, KIND_LABELS, localizeAsset, mediaUrl, nextWallpaper, patchAsset, pageImmersiveEnabled, pageWallpaperSwitch, patchOptions, pauseCanvas, saveCanvasSettings, saveMonitor, scanLibrary, SOURCE_LABELS, sweepMonitor, type CanvasKind, type CanvasPicture, type LibraryQuery, type LibrarySort, type WallpaperAsset, type WallpaperMonitor, type WallpaperOptions, type WallpaperState, type WallpaperTag } from '../wallpaper/client';

const PAGE_SIZE = 120;

const SORTS: Array<{ id: LibrarySort; label: string }> = [
  { id: 'added', label: '最近导入' },
  { id: 'title', label: '名称' },
  { id: 'size', label: '大小' },
  { id: 'duration', label: '时长' },
  { id: 'resolution', label: '分辨率' },
];

/**
 * 帧率档位。上限由每块屏自己的刷新率决定（宿主 MonitorCatalog 读 Windows 显示模式），
 * 所以 60Hz 屏只给 30/60，144Hz 屏给到 144，不让人选一个屏跑不动的值。
 */
const FPS_STEPS = [30, 60, 90, 120, 144, 165, 240, 360];
function fpsChoices(maxFps: number): number[] {
  const top = Number.isFinite(maxFps) && maxFps >= 30 ? Math.round(maxFps) : 60;
  const list = FPS_STEPS.filter((value) => value <= top);
  if (!list.includes(30)) list.unshift(30);
  if (list[list.length - 1] !== top) list.push(top);
  return list;
}

/**
 * 按 Screen.AllScreens 的真实坐标画等比示意图：外框 = 虚拟桌面包围盒，
 * 每块屏按 x/y/w/h 落到百分比位置，点一下切换选中的屏。
 * 抽屉的「屏幕」卡和画布设置弹层共用同一套（见 buildScreenMap 的 options）。
 */
function buildScreenMap(
  monitors: WallpaperMonitor[],
  selectedKey: string | null,
  onSelect: (monitor: WallpaperMonitor) => void,
  options: { globalAssetId?: number | null; scaleText?: string | null; className?: string } = {},
): HTMLElement {
  const minX = Math.min(...monitors.map((monitor) => monitor.x));
  const minY = Math.min(...monitors.map((monitor) => monitor.y));
  const maxX = Math.max(...monitors.map((monitor) => monitor.x + monitor.w));
  const maxY = Math.max(...monitors.map((monitor) => monitor.y + monitor.h));
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);

  const map = h('div', {
    class: `wp-monitor-map${options.className ? ` ${options.className}` : ''}`,
    style: `aspect-ratio:${spanX} / ${spanY};`,
  });
  for (const monitor of monitors) {
    const cover = monitor.assetId ?? (monitor.follow ? options.globalAssetId ?? null : null);
    const node = h('button', {
      class: `wp-monitor-node${monitor.key === selectedKey ? ' is-on' : ''}`,
      type: 'button',
      title: `${monitor.key} · ${monitor.w}×${monitor.h}${monitor.follow ? ' · 跟随全局' : ''}`,
      style: `left:${(((monitor.x - minX) / spanX) * 100).toFixed(3)}%;top:${(((monitor.y - minY) / spanY) * 100).toFixed(3)}%;width:${((monitor.w / spanX) * 100).toFixed(3)}%;height:${((monitor.h / spanY) * 100).toFixed(3)}%;`,
    });
    if (cover) {
      const img = h('img', { alt: '' }) as HTMLImageElement;
      img.src = coverUrl(cover);
      node.append(img);
    } else {
      node.append(h('span', { class: 'wp-monitor-empty', text: '空' }));
    }
    node.append(h('span', { class: 'wp-monitor-num', text: String(monitor.index) }));
    if (monitor.primary) node.append(h('span', { class: 'wp-monitor-star', text: '主' }));
    if (monitor.follow) node.append(h('span', { class: 'wp-monitor-flag', text: '跟随' }));
    // 选中的那块屏：画面自上而下扫过一道炫彩光，扫完就散（重绘即重放，所以换屏会再提示一次）
    if (monitor.key === selectedKey) node.append(h('span', { class: 'wp-monitor-sweep' }));
    node.addEventListener('click', () => onSelect(monitor));
    map.append(node);
  }

  const children: HTMLElement[] = [map];
  if (options.scaleText !== null) {
    children.push(
      h('div', {
        class: 'wp-muted wp-monitor-scale',
        text: options.scaleText ?? `虚拟桌面 ${spanX}×${spanY} · 点一块屏来设置`,
      }),
    );
  }

  return h('div', { class: 'wp-monitor-stage-wrap' }, ...children);
}

const RESOLUTION_FILTERS = [  { id: '', label: '全部清晰度' },
  { id: '4k', label: '4K' },
  { id: '1080', label: '1080p' },
  { id: '720', label: '720p' },
];

const DURATION_FILTERS = [
  { id: '', label: '全部时长' },
  { id: 'short', label: '10 秒内' },
  { id: 'medium', label: '10–30 秒' },
  { id: 'long', label: '30 秒以上' },
];
const SIZE_FILTERS = [
  { id: '', label: '全部大小' },
  { id: 'small', label: '20MB 以下' },
  { id: 'medium', label: '20–200MB' },
  { id: 'large', label: '200MB 以上' },
];


/**
 * 抽屉预览的即时变换：和 wallpaperLayer 的 applyPictureTransform 同一套算法
 * （画面位置 object-position + 旋转宽高比补偿 + 缩放 + 模糊），
 * 这样拖滑杆看到的效果和真正铺上去的一致。
 */
function applyPreviewTransform(
  element: HTMLElement | null,
  t: { mirrorH: boolean; mirrorV: boolean; rotation: number; cropLeft: number; cropTop: number; cropRight: number; cropBottom: number; zoom: number; blur: number },
): void {
  if (!element) {
    return;
  }
  const clampPan = (v: number): number => Math.min(45, Math.max(0, Number.isFinite(v) ? v : 0));
  const panLeft = clampPan(t.cropLeft);
  const panTop = clampPan(t.cropTop);
  const panRight = clampPan(t.cropRight);
  const panBottom = clampPan(t.cropBottom);
  const parts: string[] = [];
  if (t.mirrorH) parts.push('scaleX(-1)');
  if (t.mirrorV) parts.push('scaleY(-1)');
  // 四个滑杆改的是「画面在画框里的位置」（object-position 0–100%），不是挪画布。
  const posX = 50 - (panLeft - panRight) * (50 / 45);
  const posY = 50 - (panTop - panBottom) * (50 / 45);
  element.style.objectPosition =
    Math.abs(posX - 50) < 0.05 && Math.abs(posY - 50) < 0.05
      ? ''
      : `${posX.toFixed(2)}% ${posY.toFixed(2)}%`;
  element.style.clipPath = '';
  const rotate = (((t.rotation ?? 0) % 360) + 360) % 360;
  if (rotate) parts.push(`rotate(${rotate}deg)`);
  if (rotate === 90 || rotate === 270) {
    const w = element.clientWidth || 16;
    const hgt = element.clientHeight || 9;
    const ratio = Math.max(w / hgt, hgt / w);
    if (Number.isFinite(ratio) && ratio > 1) parts.push(`scale(${ratio.toFixed(3)})`);
  }
  const zoom = Math.min(3, Math.max(0.5, t.zoom ?? 1));
  if (Math.abs(zoom - 1) > 0.001) parts.push(`scale(${zoom.toFixed(3)})`);
  element.style.transform = parts.join(' ');
  const blur = Math.min(24, Math.max(0, t.blur ?? 0));
  element.style.filter = blur > 0.05 ? `blur(${blur.toFixed(1)}px)` : '';
}

export class WallpaperView {
  readonly root: HTMLDivElement;
  /** 逐块入场：工具条 / 当前壁纸 / 每张素材卡各自出发。 */
  private readonly entrance: BlockEntrance;

  private readonly toolbar: HTMLDivElement;
  private readonly currentRow: HTMLDivElement;
  private readonly grid: HTMLDivElement;
  private readonly footer: HTMLDivElement;
  private drawer: HTMLElement | null = null;
  private drawerBackdrop: HTMLElement | null = null;
  /** 批量操作（第 41 轮 A）：Ctrl/Shift 点卡片切换选中，底部浮动条给批量动作。 */
  private readonly selection = new Set<number>();
  private selectionBar: HTMLDivElement | null = null;

  private state: WallpaperState | null = null;
  private options: WallpaperOptions | null = null;
  private items: WallpaperAsset[] = [];
  private total = 0;
  private tags: WallpaperTag[] = [];

  /** 「屏幕」示意图：缓存的屏幕列表、当前选中的屏、以及示意图挂载点。 */
  private monitors: WallpaperMonitor[] = [];
  private monitorSelected: string | null = null;
  /** 抽屉底部那颗「应用到屏幕 N」按钮，屏选中变化时改文案。 */
  private applyTargetBtn: HTMLButtonElement | null = null;
  private monitorHost: HTMLElement | null = null;
  private monitorAsset: WallpaperAsset | null = null;

  private query: LibraryQuery = { sort: 'added', limit: PAGE_SIZE, offset: 0 };
  private searchText = '';
  private searchTimer = 0;
  private density: 'compact' | 'standard' | 'large' = 'standard';
  private loading = false;
  private mounted = false;

  constructor(private readonly onOpenSettings: () => void) {
    this.toolbar = h('div', { class: 'wp-toolbar' });
    this.currentRow = h('div', { class: 'wp-current' });
    this.grid = h('div', { class: 'wp-grid' });
    this.footer = h('div', { class: 'wp-footer' });
    this.root = h(
      'div',
      { class: 'wallpaper-page' },
      this.toolbar,
      this.currentRow,
      this.grid,
      this.footer,
    );
    this.root.classList.add(`is-${this.density}`);
    this.entrance = new BlockEntrance(this.root, {
      items: '.wp-card, .wp-current, .wp-toolbar-row, .wp-drawer-section',
      heads: '.wp-toolbar-row',
    });
  }

  /** 页面刚亮出来：收掉可能在跑的出场，再重发一遍逐块入场。 */
  reveal(): void {
    this.entrance.reveal();
  }

  /** 离开页面：各块沿自己入场那款的反向轨迹收回去。 */
  leave(): Promise<void> {
    return this.entrance.leave();
  }

  dispose(): void {
    this.entrance.dispose();
  }

  /** 每次进入页面调用：只在第一次真正拉数据，之后靠 refresh 增量刷新。 */
  async mount(): Promise<void> {
    if (!this.mounted) {
      this.mounted = true;
      this.renderToolbar();
      this.renderFooter();
      // 宿主弹窗导入完成后回推条数，这里刷新库。
      host.onMessage((message) => {
        const data = message as unknown as { type?: string; event?: string; added?: number };
        if (data.type !== 'host' || data.event !== 'wallpaperImported') return;
        const added = typeof data.added === 'number' ? data.added : 0;
        if (added > 0) toast(`已添加 ${added} 个素材`);
        void this.reload();
      });
    }

    await this.reload();
  }

  /** 宿主要求换壁纸/状态变化时，由 app.ts 调用。 */
  async refresh(): Promise<void> {
    if (!this.mounted) return;
    await this.loadState();
    this.renderCurrent();
    this.renderGrid();
    if (this.entrance.isVisible()) this.entrance.play();
  }

  /* ------------------------------------------------------------------ 数据 */

  private async reload(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      await Promise.all([this.loadState(), this.loadFacets()]);
      await this.loadItems();
    } catch (err) {
      this.renderError(err);
    } finally {
      this.loading = false;
      // 数据落定 = 逐块入场；页面没露着就不播（切回来时 reveal() 会补）。
      if (this.entrance.isVisible()) this.entrance.play();
    }
  }

  private async loadState(): Promise<void> {
    try {
      this.state = await fetchState();
    } catch {
      this.state = null;
    }

    try {
      this.options = (await fetchOptions()).options;
    } catch {
      this.options = null;
    }

    this.renderCurrent();
  }

  private async loadFacets(): Promise<void> {
    try {
      this.tags = (await fetchTags()).tags;
    } catch {
      this.tags = [];
    }

    this.renderToolbar();
  }

  private async loadItems(): Promise<void> {
    try {
      const page = await fetchLibrary({ ...this.query, query: this.searchText });
      this.items = page.items;
      this.total = page.total;
      this.renderGrid();
    } catch (err) {
      this.renderError(err);
    }

    this.renderFooter();
  }

  /* ------------------------------------------------------------------ 顶栏 */

  /** 打开模块内全屏设置页（第 48 轮 C：左侧分类 + 右侧内容）。 */
  /**
   * 设置不再单独开一个面板——直接打开全局设置并把左侧激活到「动态壁纸」。
   * 全软件只有一个设置按钮、一套弹窗，壁纸只是其中一个分类。
   */
  private openSettings(): void {
    this.onOpenSettings();
  }

  private renderToolbar(): void {
    this.toolbar.replaceChildren();

    const search = h('input', {
      class: 'wp-search',
      type: 'search',
      placeholder: '搜索壁纸名称或文件名',
      value: this.searchText,
    }) as HTMLInputElement;
    search.addEventListener('input', () => {
      this.searchText = search.value;
      window.clearTimeout(this.searchTimer);
      this.searchTimer = window.setTimeout(() => {
        void this.loadItems();
      }, 220);
    });

    const sort = createSelectControl({
      className: 'wp-select',
      title: '排序方式',
      value: this.query.sort ?? 'added',
      options: SORTS.map((option) => ({ value: option.id, label: option.label })),
      onChange: (value) => {
        this.query = { ...this.query, sort: value as LibrarySort, offset: 0 };
        void this.loadItems();
      },
    });

    const densityBtn = h(
      'button',
      { class: 'wp-icon-btn', type: 'button', title: '切换网格密度' },
      icon('list', 17),
    );
    densityBtn.addEventListener('click', () => {
      this.density = this.density === 'compact' ? 'standard' : this.density === 'standard' ? 'large' : 'compact';
      this.root.classList.remove('is-compact', 'is-standard', 'is-large');
      this.root.classList.add(`is-${this.density}`);
    });

    const addBtn = h(
      'button',
      { class: 'wp-btn wp-btn-primary', type: 'button', title: '添加本地视频/图片到壁纸库' },
      icon('plus', 15),
      h('span', { text: '添加' }),
    );
    addBtn.addEventListener('click', () => host.pickWallpaperFiles());

    const scanBtn = h(
      'button',
      { class: 'wp-btn', type: 'button', title: '重新扫描工坊与监视目录' },
      icon('refresh', 15),
      h('span', { text: '扫描' }),
    );
    scanBtn.addEventListener('click', () => void this.runScan(scanBtn));

    const moreBtn = h('button', { class: 'wp-icon-btn', type: 'button', title: '清理缓存' }, icon('trash', 17));
    moreBtn.addEventListener('click', () => void this.runClean(moreBtn));

    const settingsBtn = h('button', { class: 'wp-icon-btn', type: 'button', title: '壁纸设置' }, icon('settings', 17));
    settingsBtn.addEventListener('click', () => this.openSettings());

    const filters = h('div', { class: 'wp-filters' });
    filters.append(
      this.buildFilterGroup('resolution', RESOLUTION_FILTERS),
      this.buildFilterGroup('duration', DURATION_FILTERS),
      this.buildFilterGroup('size', SIZE_FILTERS),
    );

    const chips = h('div', { class: 'wp-chips' });
    const allChip = h('button', {
      class: `wp-chip${this.query.tag ? '' : ' is-on'}`,
      type: 'button',
      text: '全部标签',
    });
    allChip.addEventListener('click', () => {
      this.query = { ...this.query, tag: undefined, offset: 0 };
      this.renderToolbar();
      void this.loadItems();
    });
    chips.append(allChip);
    for (const tag of this.tags) {
      const chip = h('button', {
        class: `wp-chip${this.query.tag === tag.id ? ' is-on' : ''}`,
        type: 'button',
        title: `${tag.count} 张`,
      });
      chip.append(h('span', { text: tag.name }), h('span', { class: 'wp-chip-count', text: String(tag.count) }));
      chip.addEventListener('click', () => {
        this.query = { ...this.query, tag: this.query.tag === tag.id ? undefined : tag.id, offset: 0 };
        this.renderToolbar();
        void this.loadItems();
      });
      chips.append(chip);
    }

    const actions = h('div', { class: 'wp-actions' }, sort.root, densityBtn, addBtn, scanBtn, moreBtn, settingsBtn);
    this.toolbar.append(h('div', { class: 'wp-toolbar-row' }, search, actions), filters, chips);
  }

  private buildFilterGroup(
    key: 'resolution' | 'duration' | 'size',
    options: Array<{ id: string; label: string }>,
  ): HTMLElement {
    const control = createSelectControl({
      className: 'wp-select wp-select-sm',
      value: this.query[key] ?? '',
      options: options.map((option) => ({ value: option.id, label: option.label })),
      onChange: (value) => {
        this.query = { ...this.query, [key]: value || undefined, offset: 0 };
        void this.loadItems();
      },
    });
    return control.root;
  }

  /* ------------------------------------------------------------------ 当前壁纸 */

  private renderCurrent(): void {
    this.currentRow.replaceChildren();
    if (!this.state) {
      this.currentRow.append(
        h('div', { class: 'wp-current-card is-empty' }, h('span', { class: 'wp-muted', text: '壁纸模块尚未就绪' })),
      );
      return;
    }

    this.currentRow.append(
      this.buildCurrentCard('inapp', '软件内', this.state.inApp),
      this.buildCurrentCard('desktop', '桌面层', this.state.desktop),
    );
  }

  private buildCurrentCard(kind: CanvasKind, label: string, canvas: WallpaperState['inApp']): HTMLDivElement {
    const isDesktop = kind === 'desktop';
    const disabled = false;

    const body = h('div', { class: 'wp-current-body' });
    if (canvas.assetId) {
      const img = h('img', { class: 'wp-current-cover', alt: '' }) as HTMLImageElement;
      img.src = coverUrl(canvas.assetId, canvas.assetId);
      body.append(img, h('div', { class: 'wp-current-meta' },
        h('div', { class: 'wp-current-title', text: canvas.title ?? '未命名' }),
        h('div', { class: 'wp-muted', text: canvas.lastError ?? (canvas.paused ? '已暂停' : canvas.running ? '播放中' : '未播放') }),
      ));
    } else {
      body.append(
        h('div', { class: 'wp-current-empty' },
          h('div', { class: 'wp-current-title', text: '还没有选壁纸' }),
          h('div', { class: 'wp-muted', text: isDesktop ? '点「接管桌面」铺到桌面图标下面' : '在下方网格里点一张试试' }),
        ),
      );
    }

    const nextBtn = h('button', { class: 'wp-btn wp-btn-sm', type: 'button', title: '换一张' }, icon('next', 14));
    nextBtn.disabled = disabled;
    nextBtn.addEventListener('click', () => void this.shuffle(kind));

    const pauseBtn = h(
      'button',
      { class: 'wp-btn wp-btn-sm', type: 'button', title: canvas.paused ? '继续' : '暂停' },
      icon(canvas.paused ? 'play' : 'pause', 14),
    );
    pauseBtn.disabled = disabled;
    pauseBtn.addEventListener('click', () => void this.togglePause(kind, !canvas.paused));

    const tools = h('span', { class: 'wp-current-tools' }, pauseBtn, nextBtn);

    // 画布自己的设置（模糊 / 位置大小 / 帧率），只作用于这张卡代表的画布。
    const settingsBtn = h(
      'button',
      { class: 'wp-btn wp-btn-sm', type: 'button', title: '画布设置：画面变换与帧率' },
      icon('sliders', 14),
      h('span', { text: '画布设置' }),
    );
    settingsBtn.addEventListener('click', () => void this.openCanvasSettings(kind, label, canvas));
    tools.append(settingsBtn);

    if (isDesktop) {
      const attachBtn = h(
        'button',
        { class: 'wp-btn wp-btn-sm', type: 'button', title: canvas.running ? '释放桌面' : '接管桌面' },
        h('span', { text: canvas.running ? '释放' : '接管' }),
      );
      attachBtn.addEventListener('click', () => void this.toggleDesktop(attachBtn, canvas.running === true));
      tools.append(attachBtn);
    }

    const head = h(
      'div',
      { class: 'wp-current-head' },
      h('span', { class: 'wp-current-label', text: label }),
      tools,
    );

    const card = h('div', { class: `wp-current-card${disabled ? ' is-disabled' : ''}` }, head, body);
    return card;
  }

  /* ------------------------------------------------------ 画布设置（每张卡自己） */

  private canvasSettingsLayer: HTMLElement | null = null;

  private closeCanvasSettings(): void {
    this.canvasSettingsLayer?.remove();
    this.canvasSettingsLayer = null;
  }

  /**
   * 画布自己的设置：模糊 / 画面位置与大小 / 镜像旋转 / 帧率。
   *
   * 这些值存在画布行（canvases.filter_json）里，桌面层按屏各存一份，
   * 所以调这块屏不会带动别的屏；素材本身不再带画面参数，右栏只负责选图。
   */
  private async openCanvasSettings(
    kind: CanvasKind,
    label: string,
    canvas: WallpaperState['inApp'],
  ): Promise<void> {
    void canvas;
    this.closeCanvasSettings();
    const isDesktop = kind === 'desktop';

    let monitors: WallpaperMonitor[] = [];
    if (isDesktop) {
      try {
        monitors = (await fetchMonitors()).items;
      } catch {
        monitors = [];
      }
    }

    const preferred = isDesktop
      ? monitors.find((item) => item.key === this.monitorSelected) ??
        monitors.find((item) => item.primary) ??
        monitors[0] ??
        null
      : null;
    let activeKey: string | null = preferred?.key ?? null;

    let picture: CanvasPicture = {
      mirrorH: false,
      mirrorV: false,
      rotation: 0,
      cropLeft: 0,
      cropTop: 0,
      cropRight: 0,
      cropBottom: 0,
      zoom: 1,
      blur: 0,
    };
    let fps = 0;
    let maxFps = 60;

    const previewImg = h('img', { class: 'wp-canvas-preview-img', alt: '' }) as HTMLImageElement;
    const preview = h('div', { class: 'wp-canvas-preview' }, previewImg);
    const screensBox = h('div', { class: 'wp-canvas-screens' });
    const controls = h('div', { class: 'wp-canvas-controls' });
    const note = h('div', { class: 'wp-muted wp-canvas-note' });

    let timer = 0;
    const flush = (): void => {
      window.clearTimeout(timer);
      timer = 0;
      // `fps` 初值是 0（要等 load() 回填）。首帧交互早于 load 时若把 0 发上去，
      // 服务端 `Normalize` 会把 0 一律夹成 30 并落库 —— 144Hz 屏在「什么都没改」的情况下被降帧。
      void saveCanvasSettings(kind, activeKey, fps > 0 ? { ...picture, fps } : { ...picture })
        .then((snapshot) => {
          picture = { ...snapshot.picture };
          fps = snapshot.fps;
          maxFps = Math.max(30, Math.round(snapshot.maxFps || maxFps));
        })
        .catch((err) => {
          toast(err instanceof Error && err.message ? err.message : '保存失败', 'error');
        });
    };
    const queue = (): void => {
      applyPreviewTransform(previewImg, picture);
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, 160);
    };

    const seg = (text: string, on: boolean, apply: () => void): HTMLElement => {
      const btn = h('button', { class: `wp-btn wp-btn-sm${on ? ' wp-btn-primary' : ''}`, type: 'button', text });
      btn.addEventListener('click', () => {
        apply();
        paint();
        flush();
      });
      return btn;
    };

    const slider = (
      text: string,
      min: number,
      max: number,
      step: number,
      value: number,
      format: (value: number) => string,
      onInput: (value: number) => void,
    ): HTMLElement => {
      const row = h('div', { class: 'wp-adj' });
      const input = h('input', {
        class: 'wp-adj-range',
        type: 'range',
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(value),
      }) as HTMLInputElement;
      const readout = h('span', { class: 'wp-adj-value', text: format(value) });
      const paintFill = (): void => {
        const pct = ((Number(input.value) - min) / Math.max(0.0001, max - min)) * 100;
        input.style.setProperty('--fill', `${pct.toFixed(1)}%`);
        readout.textContent = format(Number(input.value));
      };
      paintFill();
      input.addEventListener('input', () => {
        paintFill();
        onInput(Number(input.value));
        queue();
      });
      input.addEventListener('change', flush);
      row.append(h('span', { class: 'wp-adj-label', text }), input, readout);
      return row;
    };

    const paint = (): void => {
      controls.replaceChildren();

      const flipRow = h('div', { class: 'wp-seg-row' });
      flipRow.append(
        seg('水平镜像', picture.mirrorH, () => {
          picture.mirrorH = !picture.mirrorH;
        }),
        seg('垂直镜像', picture.mirrorV, () => {
          picture.mirrorV = !picture.mirrorV;
        }),
      );

      const rotateRow = h('div', { class: 'wp-seg-row' });
      for (const degrees of [0, 90, 180, 270]) {
        rotateRow.append(
          seg(`${degrees}°`, picture.rotation === degrees, () => {
            picture.rotation = degrees;
          }),
        );
      }

      const cropGroup = h('div', { class: 'wp-adj-group' });
      cropGroup.append(h('div', { class: 'wp-adj-title', text: '画面位置' }));
      const crops: Array<[string, 'cropLeft' | 'cropTop' | 'cropRight' | 'cropBottom']> = [
        ['左', 'cropLeft'],
        ['上', 'cropTop'],
        ['右', 'cropRight'],
        ['下', 'cropBottom'],
      ];
      for (const [text, field] of crops) {
        cropGroup.append(
          slider(text, 0, 45, 1, Number(picture[field] ?? 0), (value) => `${value}%`, (value) => {
            picture[field] = value;
          }),
        );
      }

      const pictureGroup = h('div', { class: 'wp-adj-group' });
      pictureGroup.append(h('div', { class: 'wp-adj-title', text: '画面大小' }));
      pictureGroup.append(
        slider('缩放', 0.5, 3, 0.01, Number(picture.zoom ?? 1), (value) => `${value.toFixed(2)}×`, (value) => {
          picture.zoom = value;
        }),
        slider('模糊', 0, 24, 0.5, Number(picture.blur ?? 0), (value) => `${value.toFixed(1)}px`, (value) => {
          picture.blur = value;
        }),
      );

      const fpsRow = h('div', { class: 'wp-adj-group' });
      if (isDesktop) {
        fpsRow.append(h('div', { class: 'wp-adj-title', text: '帧率' }));
        const fpsSelect = createSelectControl({
          className: 'wp-select',
          title: `这块屏的播放帧率（上限 ${maxFps} fps）`,
          menuWidth: 120,
          value: String(fps || 60),
          options: fpsChoices(maxFps).map((value) => ({ value: String(value), label: `${value} fps` })),
          onChange: (value) => {
            fps = Number(value);
            flush();
          },
        });
        fpsRow.append(fpsSelect.root);
      }

      // 帧率放前面：窗口高度有限时它不会被挤出可视区（画面位置那四条滑杆可以滚）。
      controls.append(flipRow, rotateRow, ...(isDesktop ? [fpsRow] : []), cropGroup, pictureGroup);

      applyPreviewTransform(previewImg, picture);
    };

    const paintScreens = (): void => {
      screensBox.replaceChildren();
      if (!isDesktop || monitors.length === 0) return;
      const selected = monitors.find((monitor) => monitor.key === activeKey) ?? null;
      screensBox.append(
        buildScreenMap(
          monitors,
          activeKey,
          (monitor) => {
            // 先扫光：即使点的是当前这块屏，也要给「就是这一块」的反馈。
            this.flashScreen(monitor.key);
            if (monitor.key === activeKey) return;
            flush();
            activeKey = monitor.key;
            this.monitorSelected = monitor.key;
            this.refreshApplyTarget();
            paintScreens();
            void load();
          },
          {
            globalAssetId: this.state?.desktop?.assetId ?? null,
            scaleText: selected
              ? `屏幕 ${selected.index}${selected.primary ? ' · 主' : ''} · ${selected.w}×${selected.h}`
              : null,
            className: 'wp-monitor-map-sm',
          },
        ),
      );
    };

    const load = async (): Promise<void> => {
      try {
        const snapshot = await fetchCanvasSettings(kind, activeKey);
        picture = { ...snapshot.picture };
        fps = snapshot.fps;
        maxFps = Math.max(30, Math.round(snapshot.maxFps || 60));
        if (snapshot.assetId) {
          previewImg.src = coverUrl(snapshot.assetId, snapshot.assetId);
        } else {
          previewImg.removeAttribute('src');
        }
        paint();
      } catch (err) {
        toast(err instanceof Error && err.message ? err.message : '读取画布设置失败', 'error');
      }
    };

    const closeBtn = h('button', { class: 'wp-btn wp-btn-sm', type: 'button', title: '关闭' }, icon('close', 14));
    const panel = h(
      'div',
      { class: 'wp-canvas-panel' },
      h(
        'div',
        { class: 'wp-canvas-head' },
        h('span', { class: 'wp-canvas-title', text: `画布设置 · ${label}` }),
        closeBtn,
      ),
      h(
        'div',
        { class: 'wp-canvas-body' },
        isDesktop ? screensBox : null,
        preview,
        controls,
        note,
      ),
    );

    const layer = h('div', { class: 'wp-canvas-layer' }, panel);
    closeBtn.addEventListener('click', () => this.closeCanvasSettings());
    layer.addEventListener('pointerdown', (event) => {
      if (event.target === layer) this.closeCanvasSettings();
    });
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      document.removeEventListener('keydown', onKey, true);
      this.closeCanvasSettings();
    };
    document.addEventListener('keydown', onKey, true);

    note.textContent = isDesktop
      ? '这些参数只作用于当前选中的那块屏；「跟随全局」的屏会跟着全局画布一起变。'
      : '这些参数只作用于软件内画布，不影响桌面层。';

    this.canvasSettingsLayer = layer;
    document.body.append(layer);
    paintScreens();
    paint();
    await load();
  }

  /* ------------------------------------------------------------------ 网格 */

  private renderGrid(): void {
    this.grid.replaceChildren();
    if (this.items.length === 0) {
      this.grid.append(this.buildEmptyState());
      return;
    }

    for (const asset of this.items) {
      this.grid.append(this.buildCard(asset));
    }
    this.renderSelectionBar();
  }

  private buildEmptyState(): HTMLDivElement {
    const steps = [
      { n: '1', title: '添加素材', text: '点右上角「添加」选本地视频或图片' },
      { n: '2', title: '选一张壁纸', text: '点卡片应用，双击全屏预览' },
      { n: '3', title: '开启桌面层', text: '二期开放；现在先用软件内画布' },
    ];
    const list = h('div', { class: 'wp-empty-steps' });
    for (const step of steps) {
      list.append(
        h('div', { class: 'wp-empty-step' },
          h('span', { class: 'wp-step-n', text: step.n }),
          h('div', {},
            h('div', { class: 'wp-step-title', text: step.title }),
            h('div', { class: 'wp-muted', text: step.text }),
          ),
        ),
      );
    }

    return h(
      'div',
      { class: 'wp-empty' },
      h('div', { class: 'wp-empty-title', text: '还没有壁纸素材' }),
      list,
    );
  }

  private buildCard(asset: WallpaperAsset): HTMLDivElement {
    const cover = h('div', { class: 'wp-card-cover' });
    if (asset.coverPath && !asset.missing) {
      const img = h('img', { class: 'wp-card-img', alt: '', loading: 'lazy' }) as HTMLImageElement;
      img.src = coverUrl(asset.id, asset.addedAt);
      cover.append(img);
    } else {
      cover.append(h('div', { class: 'wp-card-fallback' }, icon('sparkle', 22)));
    }

    if (asset.missing) cover.append(h('span', { class: 'wp-badge is-warn', text: '文件缺失' }));
    else if (asset.kind !== 'video') cover.append(h('span', { class: 'wp-badge', text: KIND_LABELS[asset.kind] }));
    if (asset.favorite) cover.append(h('span', { class: 'wp-badge is-fav' }, icon('heart', 12)));

    const bar = h(
      'div',
      { class: 'wp-card-bar' },
      h('span', { class: 'wp-card-title', text: asset.title || '未命名' }),
      h('span', { class: 'wp-card-sub' },
        h('span', { text: fmtDuration(asset.effectiveDurationMs) }),
        h('span', { class: 'wp-dot', text: '·' }),
        h('span', { text: SOURCE_LABELS[asset.source] }),
      ),
    );

    const card = h('div', { class: `wp-card${asset.missing ? ' is-missing' : ''}` }, cover, bar);
    if (this.selection.has(asset.id)) card.classList.add('is-selected');

    // 星标：挂到封面左下角（以前是卡片流里的一颗 12px 爱心，小到几乎点不到，
    // 还会把卡片撑高一截）。空心/实心两颗星靠 .is-selected 切换。
    const check = h('button', { class: 'wp-card-check', type: 'button', title: '选中（也可以 Ctrl+点击）' });
    check.append(
      h('span', { class: 'wp-star wp-star-out' }, icon('star', 16)),
      h('span', { class: 'wp-star wp-star-fill' }, icon('starFill', 16)),
    );
    check.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleSelection(asset.id);
    });
    cover.append(check);

    // 双击 = 直接把这张素材铺到软件内（等同抽屉里的「应用到软件内」）。
    // 不能直接依赖 dblclick：第一下 click 会把详情抽屉打开，抽屉是 fixed 384px、
    // 一开就把列表右侧顶开/盖住，第二下常常落在别的元素上，只有手速特别快才凑得成双击。
    // 所以改成自己数两次点击：首击延迟 260ms 再开抽屉，第二击在窗口内就取消并应用。
    let pendingOpen = 0;
    let lastClick = 0;
    card.title = asset.missing ? '文件缺失' : '双击应用到软件内';
    card.addEventListener('click', (event) => {
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        this.toggleSelection(asset.id);
        return;
      }
      if (asset.missing) {
        this.openDrawer(asset);
        return;
      }
      const now = performance.now();
      const doubleClick = now - lastClick < 320;
      lastClick = now;
      window.clearTimeout(pendingOpen);
      if (doubleClick) {
        lastClick = 0;
        this.closeDrawer();
        void this.apply(asset, 'inapp');
        return;
      }
      pendingOpen = window.setTimeout(() => this.openDrawer(asset), 260);
    });
    card.addEventListener('dblclick', () => void this.apply(asset));
    card.addEventListener('pointerenter', () => this.startHoverPreview(cover, asset));
    card.addEventListener('pointerleave', () => this.stopHoverPreview(cover));
    return card;
  }

  private startHoverPreview(host: HTMLDivElement, asset: WallpaperAsset): void {
    if (asset.kind !== 'video' || asset.missing) return;
    const existing = host.querySelector('video');
    if (existing) return;
    const video = document.createElement('video');
    video.className = 'wp-card-video';
    video.src = mediaUrl(asset.id, asset.addedAt);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    host.append(video);
    video.play().catch(() => {
      // 自动播放被拦或解码不支持：静默退回封面。
      video.remove();
    });
    window.setTimeout(() => {
      if (!video.isConnected) return;
      video.pause();
      video.remove();
    }, 2000);
  }

  private stopHoverPreview(host: HTMLDivElement): void {
    const video = host.querySelector('video');
    if (video) {
      video.pause();
      video.remove();
    }
  }

  /* ------------------------------------------------------------------ 抽屉 */

  private openDrawer(asset: WallpaperAsset): void {
    this.closeDrawer();

    const cover = h('div', { class: 'wp-drawer-cover' });
    if (asset.kind === 'video' && !asset.missing) {
      const video = document.createElement('video');
      video.className = 'wp-drawer-video';
      video.src = mediaUrl(asset.id, asset.addedAt);
      // 不要原生控件：鼠标划过时那排播放/音量/全屏按钮会盖住画面
      // （用户 2026-11-17 要求）。预览是自动循环静音播放，用不到控件。
      video.controls = false;
      video.muted = true;
      video.playsInline = true;
      video.autoplay = true;
      cover.append(video);
      // 静音自动播放是允许的；失败就停在首帧，不弹任何控件。
      void video.play().catch(() => undefined);
    } else if (asset.coverPath && !asset.missing) {
      const img = document.createElement('img');
      img.className = 'wp-drawer-image';
      img.alt = asset.title || '';
      img.src = coverUrl(asset.id, asset.addedAt);
      cover.append(img);
    } else {
      cover.append(h('div', { class: 'wp-card-fallback' }, icon('sparkle', 28)));
    }

    const info = h('dl', { class: 'wp-info' });
    const rows: Array<[string, string]> = [
      ['来源', SOURCE_LABELS[asset.source]],
      ['类型', KIND_LABELS[asset.kind]],
      ['分辨率', fmtResolution(asset)],
      ['时长', fmtDuration(asset.effectiveDurationMs)],
      ['大小', fmtSize(asset.sizeBytes)],
      ['路径', asset.path],
    ];
    for (const [key, value] of rows) {
      info.append(h('dt', { text: key }), h('dd', { text: value, title: value }));
    }

    // 两条画布的应用方式必须完全对称：都是「把这张素材设成那块画布的壁纸」。
    // 桌面层没接管时，apply 会自动接管（后端 /canvas/desktop/apply 内部调 AttachDesktop）。
    const applyInAppBtn = h(
      'button',
      { class: 'wp-btn wp-btn-primary', type: 'button', title: '铺在 Zilux2 主窗口最底层' },
      icon('play', 15),
      h('span', { text: '应用到软件内' }),
    );
    applyInAppBtn.disabled = asset.missing;
    applyInAppBtn.addEventListener('click', () => void this.apply(asset, 'inapp'));

    const applyDesktopBtn = h(
      'button',
      { class: 'wp-btn wp-btn-primary', type: 'button', title: '铺到当前选中的那块屏（未接管会自动接管）' },
      icon('airplay', 15),
      h('span', { text: '应用到桌面层' }),
    );
    applyDesktopBtn.disabled = asset.missing;
    applyDesktopBtn.addEventListener('click', () => void this.applyToScreen(asset));
    this.applyTargetBtn = applyDesktopBtn;
    this.refreshApplyTarget();


    const applyAllBtn = h(
      'button',
      { class: 'wp-btn', type: 'button', title: '铺到所有已接管的屏幕' },
      icon('airplay', 15),
      h('span', { text: '应用到所有屏幕' }),
    );
    applyAllBtn.disabled = asset.missing;
    applyAllBtn.addEventListener('click', () => void this.applyToAllScreens(asset));

    const favBtn = h(
      'button',
      { class: 'wp-btn', type: 'button' },
      icon('heart', 15),
      h('span', { text: asset.favorite ? '取消收藏' : '收藏' }),
    );
    favBtn.addEventListener('click', () => void this.toggleFavorite(asset));

    const deleteBtn = h('button', { class: 'wp-btn wp-btn-danger', type: 'button' }, icon('trash', 15), h('span', { text: '移出库' }));
    deleteBtn.addEventListener('click', () => void this.remove(asset));
    const titleInput = h('input', { class: 'wp-title-input', type: 'text', value: asset.title }) as HTMLInputElement;
    titleInput.addEventListener('change', () => void this.rename(asset, titleInput.value));

    const tagBox = h('div', { class: 'wp-tag-box' });
    this.renderTagBox(tagBox, asset);

    const close = h('button', { class: 'wp-icon-btn', type: 'button', title: '关闭' }, icon('close', 16));
    close.addEventListener('click', () => this.closeDrawer());

    const drawer = h(
      'aside',
      { class: 'wp-drawer' },
      h('div', { class: 'wp-drawer-head' }, h('span', { class: 'wp-drawer-title', text: '素材详情' }), close),
      cover,
      h('div', { class: 'wp-drawer-section' }, h('div', { class: 'wp-label', text: '名称' }), titleInput),
      h('div', { class: 'wp-drawer-section' }, h('div', { class: 'wp-label', text: '标签' }), tagBox),
      h('div', { class: 'wp-drawer-section' }, info),
      this.buildMonitorsSection(asset),
      h(
        'div',
        { class: 'wp-drawer-actions' },
        applyInAppBtn,
        applyDesktopBtn,
        applyAllBtn,
        favBtn,

        asset.source === 'workshop' ? (() => {
          const localize = h('button', { class: 'wp-btn', type: 'button' }, '转本地副本');
          localize.addEventListener('click', () => {
            void (async () => {
              localize.disabled = true;
              try {
                const result = await localizeAsset(asset.id);
                toast(result.alreadyLocal ? '这张已经在库里了' : '已复制进库目录');
                drawer.remove();
                await this.reload();
              } catch (err) {
                toast(err instanceof Error && err.message ? err.message : '转本地副本失败', 'error');
                localize.disabled = false;
              }
            })();
          });
          return localize;
        })() : null,
        deleteBtn,
      ),
    );
    // 点抽屉外面任意位置就收起（用户 2026-11-17 要求）。
    // 用一块透明遮罩盖住抽屉以外的区域，比在 document 上挂 pointerdown 稳：
    // 原生 range 拖动、卡片自身的点击都不会抢走或误触发。
    const backdrop = h('div', { class: 'wp-drawer-backdrop' });
    backdrop.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.closeDrawer();
    });

    this.drawerBackdrop = backdrop;
    this.drawer = drawer;
    this.root.append(backdrop, drawer);
  }


  /**
   * 「屏幕」卡片（第 88 轮多屏画面管理）：每块屏各用一张壁纸。
   *
   * 抽屉是「这张素材」的视角，所以每块屏只给两个选择：
   * 跟随全局（跟桌面画布那张走）⇄ 用这张（把这块屏钉在当前素材上）。
   * 帧率存在该屏自己的 canvases 行里，跟全局互不影响。
   */
  private buildMonitorsSection(asset: WallpaperAsset): HTMLElement {
    const stage = h('div', { class: 'wp-monitor-stage' });
    const section = h(
      'div',
      { class: 'wp-drawer-section wp-monitor-section' },
      h('div', { class: 'wp-label', text: '屏幕' }),
      h('div', { class: 'wp-muted wp-monitor-hint', text: '按 Windows 的实际排布点一块屏，再决定它用哪张；跟随全局 = 跟「应用到桌面层」那张走。画面变换跟着壁纸走：换到别的屏、下次再用这张会自动带回来。' }),
      stage,
    );
    this.monitorHost = stage;
    this.monitorAsset = asset;
    void this.loadMonitors();
    return section;
  }

  /** 拉一次屏幕列表（含坐标），并按需要重画示意图和选中屏的详情。 */
  private async loadMonitors(): Promise<void> {
    const stage = this.monitorHost;
    if (!stage) return;
    try {
      this.monitors = (await fetchMonitors()).items ?? [];
    } catch (err) {
      stage.replaceChildren(h('div', { class: 'wp-muted', text: err instanceof Error && err.message ? err.message : '读取屏幕失败' }));
      return;
    }
    if (this.monitors.length === 0) {
      stage.replaceChildren(h('div', { class: 'wp-muted', text: '没有检测到屏幕' }));
      return;
    }
    const keys = this.monitors.map((monitor) => monitor.key);
    if (!this.monitorSelected || !keys.includes(this.monitorSelected)) {
      this.monitorSelected = (this.monitors.find((monitor) => monitor.primary) ?? this.monitors[0]).key;
    }
    this.renderMonitors();
    this.refreshApplyTarget();
  }

  private renderMonitors(): void {
    const stage = this.monitorHost;
    const asset = this.monitorAsset;
    if (!stage || !asset || this.monitors.length === 0) return;
    const selected = this.monitors.find((monitor) => monitor.key === this.monitorSelected) ?? this.monitors[0];
    stage.replaceChildren(this.buildMonitorMap(), this.buildMonitorDetail(selected, asset));
  }

  /**
   * 抽屉里的屏幕示意图：真实坐标排布 + 每块屏当前壁纸的封面。
   */
  private buildMonitorMap(): HTMLElement {
    return buildScreenMap(this.monitors, this.monitorSelected, (monitor) => {
      this.monitorSelected = monitor.key;
      this.renderMonitors();
      this.refreshApplyTarget();
      this.flashScreen(monitor.key);
    }, { globalAssetId: this.state?.desktop?.assetId ?? null });
  }

  /** 让选中的那块真屏扫一道光；只是提示，失败静默。 */
  private flashScreen(key: string): void {
    void sweepMonitor(key).catch(() => undefined);
  }

  private buildMonitorDetail(monitor: WallpaperMonitor, asset: WallpaperAsset): HTMLElement {
    const usingThis = !monitor.follow && monitor.assetId === asset.id;
    const followBtn = h('button', {
      class: `wp-btn wp-btn-sm${monitor.follow ? ' wp-btn-primary' : ''}`,
      type: 'button',
      text: '跟随全局',
    });
    const thisBtn = h('button', {
      class: `wp-btn wp-btn-sm${usingThis ? ' wp-btn-primary' : ''}`,
      type: 'button',
      text: '用这张',
    });
    thisBtn.disabled = asset.missing;

    const save = async (patch: { follow?: boolean; assetId?: number; fps?: number }): Promise<void> => {
      followBtn.disabled = true;
      thisBtn.disabled = true;
      try {
        await saveMonitor({ key: monitor.key, ...patch });
        await this.loadMonitors();
        toast(patch.follow ? '这块屏跟随全局了' : '这块屏已换壁纸');
        // 上方的「当前壁纸」卡可能变了，顺手刷一次状态。
        await this.loadState();
      } catch (err) {
        toast(err instanceof Error && err.message ? err.message : '保存失败', 'error');
        followBtn.disabled = false;
        thisBtn.disabled = asset.missing;
      }
    };

    followBtn.addEventListener('click', () => {
      if (monitor.follow) return;
      void save({ follow: true });
    });
    thisBtn.addEventListener('click', () => {
      if (usingThis) return;
      void save({ follow: false, assetId: asset.id });
    });

    // 帧率不在这里选：每块屏的帧率跟画面参数一起放在「画布设置」里（顶部当前卡入口）。

    const globalTitle = this.state?.desktop?.title;
    const stateText = monitor.follow
      ? `跟随全局${globalTitle ? ` · ${globalTitle}` : ''}`
      : monitor.title
        ? `正在用「${monitor.title}」`
        : '这块屏还没有壁纸';

    return h(
      'div',
      { class: 'wp-monitor-detail', title: monitor.key },
      h(
        'div',
        { class: 'wp-monitor-detail-head' },
        h('span', { class: 'wp-monitor-name', text: `屏幕 ${monitor.index}` }),
        monitor.primary ? h('span', { class: 'wp-monitor-badge', text: '主屏' }) : null,
        h('span', { class: 'wp-monitor-sub', text: `${monitor.w}×${monitor.h}` }),
      ),
      h('div', { class: 'wp-monitor-state', text: stateText }),
      h('div', { class: 'wp-monitor-actions' }, followBtn, thisBtn),
    );
  }


  /** 读一张素材的标签（抽屉标签框用）。 */
  private async assetTags(id: number): Promise<string[]> {
    try {
      const detail = await fetchAsset(id);
      return Array.isArray(detail.tags) ? detail.tags : [];
    } catch {
      return [];
    }
  }

  /**
   * 抽屉里的标签框：点 chip 移除、回车添加。标签存在素材的 tags 字段里，
   * 走 patchAsset 整组写回（后端按名字去重），保存后顺手刷一次顶栏的标签 chips。
   */
  private renderTagBox(box: HTMLElement, asset: WallpaperAsset): void {
    const paint = (list: string[]): void => {
      const input = h('input', {
        class: 'wp-tag-input',
        type: 'text',
        placeholder: '加标签…',
      }) as HTMLInputElement;
      const save = (next: string[]): void => {
        void patchAsset(asset.id, { tags: next }).then((result) => {
          if (Array.isArray(result.tags)) paint(result.tags);
          void fetchTags().then((payload) => {
            this.tags = payload.tags;
            this.renderToolbar();
          }).catch(() => undefined);
        }).catch((err) => {
          toast(err instanceof Error && err.message ? err.message : '标签保存失败', 'error');
        });
      };
      const chips = list.map((tag) => {
        const chip = h('button', { class: 'wp-chip', type: 'button', title: '点一下移除这个标签', text: tag });
        chip.addEventListener('click', () => save(list.filter((item) => item !== tag)));
        return chip;
      });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        const value = input.value.trim();
        if (!value || list.includes(value)) {
          input.value = '';
          return;
        }
        save([...list, value]);
      });
      box.replaceChildren(...chips, input);
    };
    void this.assetTags(asset.id).then(paint);
  }


  private closeDrawer(): void {
    this.drawerBackdrop?.remove();
    this.drawerBackdrop = null;

    if (!this.drawer) return;
    this.drawer.remove();
    this.drawer = null;
    this.applyTargetBtn = null;
  }

  /* ------------------------------------------------------------------ 操作 */

  private async apply(asset: WallpaperAsset, kind: CanvasKind = 'inapp'): Promise<void> {
    try {
      await applyAsset(asset.id, kind);
      if (kind === 'inapp') {
        // 应用到软件内 = 用户现在就要看到这张壁纸。以前只落素材，主界面还停在封面/自定义背景上，
        // 看上去像「应用了没反应」。这里把壁纸开关补齐并把背景模式切到 none（纯壁纸）。
        const current = await fetchOptions().catch(() => null);
        const patch: Record<string, boolean> = {};
        if (current && !current.options.enabled) patch.enabled = true;
        if (current && !current.options.inAppEnabled) patch.inAppEnabled = true;
        if (!pageWallpaperSwitch('normal')) patch.pageNormal = true;
        if (!pageImmersiveEnabled()) patch.pageImmersive = true;
        if (Object.keys(patch).length) await patchOptions(patch).catch(() => null);
        broadcastAppBgMode('none');
      }
      const target = kind === 'desktop' ? '桌面层' : '软件内';
      toast(`已应用「${asset.title || '未命名'}」到${target}`);
      await this.refresh();
    } catch (err) {
      toast(this.describe(err), 'error');
    }
  }

  /** 当前选中的屏（没选就退到主屏，再退到第一块）。 */
  private activeMonitor(): WallpaperMonitor | null {
    if (!this.monitors.length) return null;
    return this.monitors.find((item) => item.key === this.monitorSelected) ??
      this.monitors.find((item) => item.primary) ??
      this.monitors[0];
  }

  /** 按钮文案跟着当前选中的屏走。 */
  private refreshApplyTarget(): void {
    const button = this.applyTargetBtn;
    if (!button) return;
    const label = button.querySelector('span');
    if (!label) return;
    const monitor = this.activeMonitor();
    label.textContent = monitor ? `应用到屏幕 ${monitor.index}` : '应用到桌面层';
  }

  /** 只铺当前选中的那块屏。 */
  private async applyToScreen(asset: WallpaperAsset): Promise<void> {
    const monitor = this.activeMonitor();
    if (!monitor) {
      await this.apply(asset, 'desktop');
      return;
    }
    try {
      if (!monitor.attached) await attachDesktop().catch(() => {});
      await saveMonitor({ key: monitor.key, assetId: asset.id, follow: false });
      toast(`已应用「${asset.title || '未命名'}」到屏幕 ${monitor.index}`);
      await this.loadMonitors();
      await this.loadState();
    } catch (err) {
      toast(this.describe(err), 'error');
    }
  }

  /** 一次铺满所有屏。 */
  private async applyToAllScreens(asset: WallpaperAsset): Promise<void> {
    if (!this.monitors.length) {
      await this.apply(asset, 'desktop');
      return;
    }
    try {
      if (this.monitors.some((item) => !item.attached)) await attachDesktop().catch(() => {});
      for (const monitor of this.monitors) {
        await saveMonitor({ key: monitor.key, assetId: asset.id, follow: false });
      }
      toast(`已应用「${asset.title || '未命名'}」到 ${this.monitors.length} 块屏幕`);
      await this.loadMonitors();
      await this.loadState();
    } catch (err) {
      toast(this.describe(err), 'error');
    }
  }

  private async toggleFavorite(asset: WallpaperAsset): Promise<void> {
    try {
      await patchAsset(asset.id, { favorite: !asset.favorite });
      asset.favorite = !asset.favorite;
      this.renderGrid();
      this.closeDrawer();
    } catch (err) {
      toast(this.describe(err), 'error');
    }
  }

  private async rename(asset: WallpaperAsset, title: string): Promise<void> {
    const next = title.trim();
    if (!next || next === asset.title) return;
    try {
      const result = await patchAsset(asset.id, { title: next });
      asset.title = result.item.title;
      this.renderGrid();
    } catch (err) {
      toast(this.describe(err), 'error');
    }
  }

  private async remove(asset: WallpaperAsset): Promise<void> {
    try {
      await deleteAsset(asset.id);
      toast('已移出库');
      this.closeDrawer();
      await this.reload();
    } catch (err) {
      toast(this.describe(err), 'error');
    }
  }

  private async shuffle(kind: CanvasKind): Promise<void> {
    try {
      await nextWallpaper(kind);
      await this.refresh();
    } catch (err) {
      toast(this.describe(err), 'error');
    }
  }

  private async toggleDesktop(button: HTMLButtonElement, attached: boolean): Promise<void> {
    button.disabled = true;
    try {
      if (attached) {
        await detachDesktop();
        toast('已释放桌面层');
      } else {
        const result = await attachDesktop();
        if (result.ok) toast('桌面层已接管');
        else toast(result.reason || '桌面层挂不上（找不到 WorkerW）', 'error');
      }

      await this.refresh();
    } catch (error) {
      toast(`操作失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      button.disabled = false;
    }
  }

  private async togglePause(kind: CanvasKind, paused: boolean): Promise<void> {
    try {
      await pauseCanvas(paused, kind);
      await this.refresh();
    } catch (err) {
      toast(this.describe(err), 'error');
    }
  }

  private async runScan(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    toast('正在扫描…', 'info');
    try {
      const result = await scanLibrary(false);
      toast(`扫描完成：新增 ${result.added}，更新 ${result.updated}，失效 ${result.missing}`);
      await this.reload();
    } catch (err) {
      toast(this.describe(err), 'error');
    } finally {
      button.disabled = false;
    }
  }

  private async runClean(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const storage = await fetchStorage();
      if (storage.coverCount === 0) {
        toast('没有可清理的缓存', 'info');
        return;
      }

      const result = await cleanStorage();
      toast(`已清理 ${result.removed} 张封面，释放 ${fmtSize(result.freedBytes)}`);
    } catch (err) {
      toast(this.describe(err), 'error');
    } finally {
      button.disabled = false;
    }
  }

  private renderError(err: unknown): void {
    this.grid.replaceChildren();
    this.grid.append(
      h(
        'div',
        { class: 'wp-empty' },
        h('div', { class: 'wp-empty-title', text: '壁纸库读取失败' }),
        h('div', { class: 'wp-muted', text: this.describe(err) }),
      ),
    );
  }

  /* -------------------------------------------------------------- 批量操作 */

  private toggleSelection(id: number): void {
    if (this.selection.has(id)) this.selection.delete(id);
    else this.selection.add(id);
    this.renderGrid();
  }

  private clearSelection(): void {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.renderGrid();
  }

  private renderSelectionBar(): void {
    this.selectionBar?.remove();
    this.selectionBar = null;
    if (this.selection.size === 0) return;

    const bar = h('div', { class: 'wp-selbar' });
    bar.append(h('span', { class: 'wp-selbar-count', text: `已选 ${this.selection.size} 项` }));

    const fav = h('button', { class: 'wp-btn wp-btn-sm', type: 'button', text: '收藏' });
    fav.addEventListener('click', () => void this.batchFavorite(true));
    const unfav = h('button', { class: 'wp-btn wp-btn-sm', type: 'button', text: '取消收藏' });
    unfav.addEventListener('click', () => void this.batchFavorite(false));
    const remove = h('button', { class: 'wp-btn wp-btn-sm wp-btn-danger', type: 'button', text: '移出库' });
    remove.addEventListener('click', () => void this.batchRemove());
    const clear = h('button', { class: 'wp-btn wp-btn-sm', type: 'button', text: '清空' });
    clear.addEventListener('click', () => this.clearSelection());

    bar.append(fav, unfav, remove, clear);
    this.grid.after(bar);
    this.selectionBar = bar;
  }

  private async batchFavorite(favorite: boolean): Promise<void> {
    const ids = Array.from(this.selection);
    if (ids.length === 0) return;
    try {
      for (const id of ids) await patchAsset(id, { favorite });
      toast(favorite ? `已收藏 ${ids.length} 项` : `已取消收藏 ${ids.length} 项`);
      this.selection.clear();
      await this.reload();
    } catch (err) {
      toast(this.describe(err), 'error');
    }
  }

  private async batchRemove(): Promise<void> {
    const ids = Array.from(this.selection);
    if (ids.length === 0) return;
    try {
      for (const id of ids) await deleteAsset(id);
      toast(`已移出库 ${ids.length} 项`);
      this.selection.clear();
      this.closeDrawer();
      await this.reload();
    } catch (err) {
      toast(this.describe(err), 'error');
    }
  }

  private describe(err: unknown): string {
    if (err instanceof Error && err.message) return err.message;
    return isWallpaperReady(err) ? '操作失败' : '壁纸模块尚未就绪';
  }

  /* ------------------------------------------------------------------ 底部 */

  private renderFooter(): void {
    this.footer.replaceChildren();
    const count = h('span', { class: 'wp-muted', text: `共 ${this.total} 张` });
    if (this.options) {
      const info = h('span', { class: 'wp-muted' });
      const text = this.options.enabled ? '壁纸总开关：开' : '壁纸总开关：关';
      info.textContent = text;
      this.footer.append(count, info);
    } else {
      this.footer.append(count);
    }
  }
}


