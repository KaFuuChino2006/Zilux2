/**
 * 壁纸设置页（规格书 §5.1–§5.12 / 第 47–50 轮）：
 * 入口在壁纸页右上角齿轮，打开后是模块内的全屏设置（左分组列表 + 右内容），
 * 全局设置页不动。字段定义走表驱动，改一个立刻 PUT /options 只发这一键。
 */
import {
  applySequence,
  cleanStorage,
  deletePreset,
  fetchPresets,
  savePreset,
  deleteSequence,
  exportDiagnostics,
  fetchDiagnostics,
  fetchLibrary,
  fetchMonitors,
  fetchOptions,
  fetchSequences,
  fetchStorage,
  runSelfCheck,
  saveCanvasSettings,
  saveSequence,
  patchOptions,
  type WallpaperDiagnostics,
  type WallpaperOptions,
  type WallpaperStorage,
} from '../wallpaper/client';
import { h, icon, toast } from './dom';
import { createSelectControl } from './selectControl';

type OptionKey = keyof WallpaperOptions;

interface SwitchField {
  kind: 'switch';
  key: OptionKey;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface SelectField {
  kind: 'select';
  key: OptionKey;
  label: string;
  options: Array<{ value: string; label: string }>;
  hint?: string;
}

interface NumberSelectField {
  kind: 'numbers';
  key: OptionKey;
  label: string;
  options: Array<{ value: number; label: string }>;
  hint?: string;
}

interface RangeField {
  kind: 'range';
  key: OptionKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  hint?: string;
}

interface TextField {
  kind: 'text';
  key: OptionKey;
  label: string;
  hint?: string;
  placeholder?: string;
}

interface CustomField {
  kind: 'custom';
  label: string;
  hint?: string;
  build: (options: WallpaperOptions, commit: (patch: Partial<WallpaperOptions>) => void) => HTMLElement;
}

type Field =
  | SwitchField
  | SelectField
  | NumberSelectField
  | RangeField
  | TextField
  | CustomField
  /** 组内小标题，只做视觉分组，不参与落盘。 */
  | { kind: 'section'; label: string };

interface Group {
  id: string;
  label: string;
  note?: string;
  fields: Field[];
}

const TRANSITION_LABELS: Array<{ value: string; label: string }> = [
  { value: 'fade', label: '交叉淡化' },
  { value: 'fade-black', label: '黑场' },
  { value: 'fade-white', label: '白闪' },
  { value: 'slide-left', label: '左推' },
  { value: 'slide-right', label: '右推' },
  { value: 'slide-up', label: '上滑' },
  { value: 'zoom-in', label: '缩放推近' },
  { value: 'blur-dissolve', label: '模糊叠化' },
  { value: 'radial-blur', label: '径向模糊' },
  { value: 'exposure', label: '曝光' },
  { value: 'glitch', label: '故障风' },
  { value: 'film-grain', label: '胶片颗粒' },
  { value: 'dissolve-noise', label: '斑点溶解' },
  { value: 'ripple', label: '水波纹' },
];

const GROUPS: Group[] = [
  {
    id: 'basic',
    label: '基础',
    fields: [
      { kind: 'section', label: '开关' },
      { kind: 'switch', key: 'enabled', label: '启用动态壁纸', hint: '总开关；关掉后两块画布都停。' },
      { kind: 'switch', key: 'inAppEnabled', label: '软件内背景层', hint: '铺在 Zilux2 主窗口最底层，界面浮在上面。' },
      {
        kind: 'switch',
        key: 'desktopEnabled',
        label: '桌面层（桌面图标下面）',
        hint: '把壁纸铺到桌面图标下面；也可以在壁纸页点「接管桌面」。',
      },
      { kind: 'section', label: '在哪显示' },
      { kind: 'switch', key: 'pageNormal', label: '常规页面显示壁纸' },
      { kind: 'switch', key: 'pageImmersive', label: '沉浸播放页显示壁纸', hint: '歌词页本身就是整屏画面，默认关。' },
      { kind: 'switch', key: 'pageRoom', label: '房间页显示壁纸' },
      { kind: 'switch', key: 'pageLogin', label: '登录页显示壁纸' },
      { kind: 'section', label: '启动与退出' },
      { kind: 'switch', key: 'closeToTray', label: '关闭窗口时缩到托盘', hint: '关掉表示关窗即退出（壁纸也会停）。' },
      {
        kind: 'select',
        key: 'autoLaunch',
        label: '开机自启',
        options: [
          { value: 'off', label: '关闭' },
          { value: 'wallpaper-only', label: '仅壁纸（轻量）' },
          { value: 'full', label: '完整程序' },
        ],
        hint: '轻量档用 --wallpaper-host 启动，不加载音乐模块。',
      },
      { kind: 'section', label: '配置预设' },
      {
        kind: 'custom',
        label: '把整套参数存下来',
        hint: '滤镜、转场、轮换间隔、可视化开关打包成一套，换场景时一键切回去。',
        build: buildPresets,
      },
    ],
  },
  {
    id: 'library',
    label: '素材库',
    fields: [
      {
        kind: 'select',
        key: 'gridDensity',
        label: '网格密度',
        options: [
          { value: 'compact', label: '紧凑' },
          { value: 'standard', label: '标准' },
          { value: 'large', label: '大图' },
        ],
      },
      {
        kind: 'numbers',
        key: 'thumbConcurrency',
        label: '封面抽帧并发',
        options: [
          { value: 1, label: '1' },
          { value: 2, label: '2' },
          { value: 3, label: '3' },
          { value: 4, label: '4' },
        ],
      },
      { kind: 'custom', label: '监视目录', hint: '这些目录里的视频/图片会自动入库（Wi-Fi 断了也不会丢，下次启动重扫）。', build: buildWatchFolders },
      {
        kind: 'numbers',
        key: 'cacheKeepDays',
        label: '缓存保留',
        options: [
          { value: 7, label: '7 天' },
          { value: 30, label: '30 天' },
          { value: 90, label: '90 天' },
          { value: 0, label: '永久' },
        ],
        hint: '缩略图与抽帧封面的保留时长，超期在扫描时清掉。',
      },
    ],
  },
  {
    id: 'transition',
    label: '转场',
    fields: [
      {
        kind: 'select',
        key: 'transitionMode',
        label: '模式',
        options: [
          { value: 'random', label: '随机预设' },
          { value: 'fixed', label: '固定一种' },
        ],
      },
      { kind: 'select', key: 'transitionId', label: '固定转场', options: TRANSITION_LABELS, hint: '仅「固定一种」时生效。' },
      {
        kind: 'switch',
        key: 'beatLock',
        label: '卡在节拍上切',
        hint: '有音乐在放时，把切换推迟到下一个鼓点（最多等 1.5 秒）。',
      },
      {
        kind: 'numbers',
        key: 'transitionMs',
        label: '时长',
        options: [
          { value: 0, label: '关闭' },
          { value: 200, label: '200 ms' },
          { value: 300, label: '300 ms' },
          { value: 500, label: '500 ms' },
          { value: 800, label: '800 ms' },
          { value: 1200, label: '1.2 s' },
          { value: 1500, label: '1.5 s' },
          { value: 2000, label: '2 s' },
        ],
      },
      { kind: 'custom', label: '随机时排除', hint: '勾掉不想看到的转场，随机池里就不会出现。', build: buildTransitionExclude },
    ],
  },
  {
    id: 'audio',
    label: '声音',
    note: '壁纸音轨默认静音。这里的优先级永远是「音乐 > 壁纸」：音乐一响，壁纸自动退场。',
    fields: [
      { kind: 'section', label: '壁纸自己的声音' },
      { kind: 'switch', key: 'audioEnabled', label: '播放壁纸音轨', hint: '壁纸视频自带的声音，默认关。' },
      { kind: 'range', key: 'audioVolume', label: '壁纸音量', min: 0, max: 100, step: 1, format: (v) => `${v}%` },
      {
        kind: 'custom',
        label: '每块屏的音量',
        hint: '同一张壁纸铺在多块屏上时只会有一块屏出声（省解码、也不会有回声）；不同壁纸可以各自调音量。',
        build: buildMonitorVolumes,
      },
      { kind: 'switch', key: 'audioFollowSystem', label: '跟随系统音量', hint: '关掉表示用上面的固定音量。' },
      { kind: 'section', label: '和音乐抢声音时' },
      { kind: 'range', key: 'musicDuckMs', label: '音乐起播时壁纸淡出', min: 0, max: 2000, step: 50, format: (v) => `${v} ms` },
      { kind: 'range', key: 'musicRestoreMs', label: '音乐停后壁纸淡入', min: 0, max: 3000, step: 50, format: (v) => `${v} ms` },
      {
        kind: 'range',
        key: 'occludeThreshold',
        label: '被窗口盖住多少就静音',
        min: 0.5,
        max: 1,
        step: 0.05,
        format: (v) => `${Math.round(v * 100)}% 屏幕`,
        hint: '有别的窗口最大化/全屏覆盖到这个比例，就把壁纸音轨静音。',
      },
      { kind: 'section', label: '节拍' },
      { kind: 'range', key: 'beatStrength', label: '节拍驱动强度', min: 0, max: 100, step: 1, format: (v) => `${v}%`, hint: '让转场卡鼓点、画面轻微脉冲、界面跟着跳。0 表示完全不要。' },
    ],
  },
  {
    id: 'rotation',
    label: '轮换',
    fields: [
      { kind: 'section', label: '定时轮换' },
      { kind: 'switch', key: 'rotationEnabled', label: '定时轮换' },
      {
        kind: 'numbers',
        key: 'rotationMinutes',
        label: '间隔',
        options: [
          { value: 15, label: '15 分钟' },
          { value: 30, label: '30 分钟' },
          { value: 60, label: '1 小时' },
          { value: 120, label: '2 小时' },
        ],
      },
      {
        kind: 'select',
        key: 'rotationOrder',
        label: '顺序',
        options: [
          { value: 'random', label: '随机' },
          { value: 'sequential', label: '按顺序' },
        ],
      },
      { kind: 'switch', key: 'rotationFavoriteFirst', label: '优先切收藏' },
      { kind: 'switch', key: 'prewarm', label: '切换前预热下一张', hint: '提前解好首帧，切的时候不闪黑。' },
      {
        kind: 'custom',
        label: '序列播放',
        hint: '序列按自己的节奏走（每条可设时长），开着序列时定时轮换会暂停。',
        build: buildSequences,
      },
    ],
  },
  {
    id: 'desktop',
    label: '桌面层',
    note:
      '桌面层是挂在桌面图标下面的第二个页面，和软件内共用一套解码与转场，'
      + '但两边各选各的壁纸、各轮各的。这里只管「桌面这一块」的行为。',
    fields: [
      { kind: 'section', label: '接管' },
      { kind: 'switch', key: 'desktopAttached', label: '记住接管状态', hint: '下次启动自动接管桌面，不用每次手动点。' },
      { kind: 'switch', key: 'desktopSound', label: '桌面层出声音', hint: '默认关。开了之后即使 Zilux2 窗口没在前台，桌面也在放壁纸的声音。' },
      { kind: 'section', label: '桌面交互' },
      { kind: 'switch', key: 'edgeBarEnabled', label: '桌面边缘控制条', hint: '鼠标贴屏幕边缘停一下，弹出一条控制条（下一张 / 暂停 / 设置）。' },
      {
        kind: 'numbers',
        key: 'edgeBarDelayMs',
        label: '边缘条唤起延迟',
        options: [
          { value: 200, label: '200 ms' },
          { value: 400, label: '400 ms' },
          { value: 800, label: '800 ms' },
        ],
        hint: '鼠标贴边停留多久才出现，防误触。',
      },
    ],
  },
  {
    id: 'performance',
    label: '性能',
    note:
      '两条画布现在都交给页面里的 <video> 播（Chromium 硬解），所以帧率/分辨率/硬解这些参数不再需要'
      + '——实测常驻 CPU 在 3~8%。这一页只剩下「什么时候该停下来省电」。',
    fields: [
      { kind: 'section', label: '自动暂停' },
      { kind: 'switch', key: 'pauseOnMinimize', label: '窗口最小化时暂停', hint: '缩到托盘也算最小化。' },
      { kind: 'switch', key: 'pauseOnBattery', label: '用电池时暂停' },
      { kind: 'switch', key: 'pauseOnFullscreen', label: '有全屏应用时暂停', hint: '打游戏、看全屏视频时自动停，退出后接着播。' },
      { kind: 'section', label: '省电与无障碍' },
      { kind: 'switch', key: 'adaptiveQuality', label: '空闲时降低刷新', hint: '长时间没人操作就降低画面更新频率。' },
      {
        kind: 'select',
        key: 'reduceMotion',
        label: '减少动画',
        options: [
          { value: 'system', label: '跟随系统' },
          { value: 'always', label: '总是减少' },
          { value: 'never', label: '从不减少' },
        ],
        hint: '开启后转场变短、节拍脉冲与界面微动效关闭，避免晕动。',
      },
    ],
  },
  {
    id: 'visual',
    label: '视觉效果',
    fields: [
      { kind: 'section', label: '压暗（保证文字看得清）' },
      {
        kind: 'select',
        key: 'dimMode',
        label: '压暗模式',
        options: [
          { value: 'auto', label: '按画面亮度自适应' },
          { value: 'fixed', label: '固定值' },
          { value: 'off', label: '不压暗' },
        ],
        hint: '自适应会按帧亮度在基准与上限之间取值，保证文字可读。',
      },
      { kind: 'range', key: 'dimBase', label: '基准压暗', min: 0, max: 0.8, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
      { kind: 'range', key: 'dimMax', label: '压暗上限', min: 0, max: 0.9, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
      { kind: 'range', key: 'dimEmaMs', label: '压暗平滑', min: 0, max: 3000, step: 100, format: (v) => `${v} ms` },
      { kind: 'section', label: '调色' },
      { kind: 'range', key: 'brightness', label: '亮度', min: -100, max: 100, step: 1 },
      { kind: 'range', key: 'contrast', label: '对比度', min: -100, max: 100, step: 1 },
      { kind: 'range', key: 'saturation', label: '饱和度', min: -100, max: 100, step: 1 },
      { kind: 'range', key: 'blur', label: '模糊', min: 0, max: 50, step: 1, format: (v) => `${v} px` },
      { kind: 'section', label: '摆放' },
      {
        kind: 'select',
        key: 'fitMode',
        label: '适配方式',
        options: [
          { value: 'smart', label: '智能自动' },
          { value: 'cover', label: '铺满（裁切）' },
          { value: 'contain', label: '完整（留边）' },
          { value: 'fill', label: '拉伸' },
          { value: 'stretch', label: '铺满（不裁切）' },
        ],
      },
      { kind: 'section', label: '联动与叠层' },
      { kind: 'range', key: 'parallax', label: '鼠标视差', min: 0, max: 1, step: 0.05, format: (v) => (v === 0 ? '关闭' : `${Math.round(v * 100)}%`) },
      { kind: 'switch', key: 'accentFromFrame', label: '从画面取强调色', hint: '没有壁纸时回退到专辑封面主色。' },
      { kind: 'switch', key: 'appearanceLink', label: '跟随明暗主题切预设', hint: '主题切到暗色就应用名字里带「暗」的预设，切到亮色应用带「亮」的。' },
      { kind: 'switch', key: 'overlayEnabled', label: '时钟/文字叠层', hint: '在壁纸右下角叠一层时钟或文字。' },
      { kind: 'text', key: 'overlayTemplate', label: '叠层模板', placeholder: '{time}', hint: '可用占位：{time} {date} {weekday} {year} {month} {day}。' },
    ],
  },
  {
    id: 'diagnostics',
    label: '诊断',
    fields: [{ kind: 'custom', label: '运行时状态', build: buildDiagnostics }],
  },
];

/**
 * 壁纸设置面板：结构与全局设置完全一致（settings-layout / settings-nav / settings-pane /
 * set-row / pill-switch），改一个立刻落盘。
 *
 * 造型同全局设置：左侧主选项列带滑动 thumb，右侧每个分类一个 pane，用 hidden 切换，
 * 开关用「关 / 开」胶囊，下拉用 set-select，滑块放在 set-row-control 里。
 */
/** 供全局设置把 9 组成「设置内的子分类」用。 */
export const WALLPAPER_SETTING_GROUPS: ReadonlyArray<{ id: string; label: string }> = GROUPS.map((g) => ({
  id: g.id,
  label: g.label,
}));

export class WallpaperSettingsPanel {
  readonly root: HTMLDivElement;
  private readonly nav: HTMLDivElement;
  private readonly navThumb: HTMLDivElement;
  private readonly content: HTMLDivElement;
  private options: WallpaperOptions | null = null;
  /** field.key → 就地回填控件值的函数（宿主会归一化/改写某些值，提交后要按返回结果回显）。 */
  private readonly updaters = new Map<string, (value: unknown) => void>();
  /** 全局设置把每一组挂到自己那个 pane 里时用：groupId → 容器。 */
  private readonly groupSlots = new Map<string, HTMLElement>();
  private activeGroup = GROUPS[0].id;

  /**
   * @param embedded 嵌进全局设置时为 true：不再自带 .wp-settings 外壳与标题栏，
   *                 只留 settings-layout（左分类 + 右表单），由外层负责遮罩与关闭。
   */
  constructor(
    private readonly onClose: () => void,
    private readonly embedded = false,
  ) {
    this.nav = h('div', {
      class: 'settings-nav',
      role: 'tablist',
      'aria-label': '壁纸设置分类',
      'aria-orientation': 'vertical',
    });
    this.navThumb = h('div', { class: 'settings-nav-thumb' });
    this.nav.append(this.navThumb);
    this.content = h('div', { class: 'settings-content' });

    const back = h('button', { class: 'wp-icon-btn', type: 'button', title: '返回壁纸库' }, icon('chevron', 16));
    back.addEventListener('click', () => this.onClose());

    // 嵌入时不要 nav 容器（它自带背景，留着就是一条空框）。
    // 嵌入时直接把 content 当根：字段必须是 root 的直接子节点，
    // 全局设置的子选项条靠遍历直接子节点来分组（多包一层会把整块吞进第一个组）。
    this.root = this.embedded
      ? this.content
      : h(
          'div',
          { class: 'wp-settings' },
          h('div', { class: 'wp-set-head' }, back, h('span', { class: 'wp-set-title', text: '动态壁纸设置' })),
          h('div', { class: 'settings-layout' }, this.nav, this.content),
        );

    // 快捷设置（背景 / 背景歌词样式）改的是同一份 options：那边一动手，这里就地回填，
    // 两个入口永远显示同一状态。防抖是为了避开自己提交后那次广播。
    window.addEventListener('zilux:wallpaper-options', () => {
      if (!this.root.isConnected) return;
      window.clearTimeout(this.optionsReloadTimer);
      this.optionsReloadTimer = window.setTimeout(() => {
        if (!this.root.isConnected) return;
        void fetchOptions()
          .then((response) => {
            this.options = response.options ?? null;
            const options = (response.options ?? {}) as unknown as Record<string, unknown>;
            for (const [key, apply] of this.updaters) {
              if (key in options) apply(options[key]);
            }
          })
          .catch(() => {});
      }, 260);
    });
  }

  /** 外部入口改设置后，回填控件的防抖计时器。 */
  private optionsReloadTimer = 0;

  /**
   * 把某一组挂进外部容器（全局设置里一个子分类 = 一个容器）。
   * 选项还没读到时先留空，reload 之后统一回填。
   */
  attachGroup(container: HTMLElement, groupId: string): void {
    this.groupSlots.set(groupId, container);
    this.fillGroupSlot(groupId);
  }

  private fillGroupSlot(groupId: string): void {
    const slot = this.groupSlots.get(groupId);
    if (!slot) return;
    const group = GROUPS.find((item) => item.id === groupId);
    if (!group) return;
    slot.textContent = '';
    if (!this.options) {
      slot.append(h('p', { class: 'wp-muted', text: '设置还没读到，稍后重试。' }));
      return;
    }
    if (group.note) slot.append(h('p', { class: 'set-note', text: group.note }));
    for (const field of group.fields) slot.append(this.buildField(field));
  }

  async mount(): Promise<void> {
    if (this.embedded) {
      // 同步先铺字段：外层紧接着就会调 decorateSettingsSubnav 按 data-group 分组，
      // 这里如果先 await 网络，分组时 content 还是空的，标签条就建不出来。
      this.fillFlat();
      void this.reload();
      return;
    }

    for (const group of GROUPS) {
      const btn = h('button', {
        class: `settings-nav-btn${group.id === this.activeGroup ? ' is-on' : ''}`,
        type: 'button',
        role: 'tab',
        'aria-selected': group.id === this.activeGroup ? 'true' : 'false',
        text: group.label,
      }) as HTMLButtonElement;
      btn.dataset.group = group.id;
      btn.addEventListener('click', () => {
        this.activeGroup = group.id;
        this.render();
      });
      this.nav.append(btn);
    }

    await this.reload();
  }

  /** 平铺 9 组的所有字段（嵌入模式）。 */
  private fillFlat(): void {
    this.content.textContent = '';
    // options 还没读到时也先把字段铺出来（buildField 用默认值占位），
    // 否则外层那次 decorateSettingsSubnav 会因为一个子节点都不匹配而直接放弃建标签条。
    for (const group of GROUPS) {
      for (const field of group.fields) {
        const node = this.buildField(field);
        node.dataset.group = group.id;
        this.content.append(node);
      }
    }
  }

  private async reload(): Promise<void> {
    try {
      const response = await fetchOptions();
      this.applyOptions(response.options ?? null);
    } catch (error) {
      toast(`设置读取失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      this.options = null;
    }
    // 嵌入模式下字段已经被子选项条搬进各自的 subpane 了：
    // 再 render 一次会把 bar 和 subpane 一起 textContent 清掉，所以只更新数据。
    if (!this.embedded) this.render();
  }

  /**
   * 把一份 options 回填到已经建好的控件上（嵌入模式不能重建 DOM，只能就地改）。
   * 首次 reload 前控件是按默认值建的，这里补上真实状态。
   */
  private applyOptions(options: WallpaperOptions | null): void {
    this.options = options;
    const bag = (options ?? {}) as unknown as Record<string, unknown>;
    for (const [key, apply] of this.updaters) {
      if (key in bag) apply(bag[key]);
    }
  }

  private render(): void {
    if (this.embedded) {
      this.fillFlat();
      return;
    }

    this.nav.querySelectorAll<HTMLButtonElement>('.settings-nav-btn').forEach((btn) => {
      const on = btn.dataset.group === this.activeGroup;
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      btn.tabIndex = on ? 0 : -1;
    });

    this.content.textContent = '';
    const pane = h('div', { class: 'settings-pane', role: 'tabpanel' });
    this.content.append(pane);

    const group = GROUPS.find((item) => item.id === this.activeGroup) ?? GROUPS[0];
    if (group.note) pane.append(h('p', { class: 'set-note', text: group.note }));
    if (!this.options) {
      pane.append(h('p', { class: 'wp-muted', text: '设置还没读到，稍后重试。' }));
      return;
    }
    for (const field of group.fields) pane.append(this.buildField(field));
  }

  /** 全局设置那种「关 / 开」胶囊开关。 */
  private buildSwitch(
    value: boolean,
    disabled: boolean,
    onChange: (next: boolean) => void,
  ): { root: HTMLDivElement; setValue: (next: boolean) => void } {
    const root = h('div', { class: `pill-switch set-switch${value ? ' is-on' : ''}` }) as HTMLDivElement;
    const thumb = h('div', { class: 'pill-switch-thumb' });
    const off = h('button', {
      class: `pill-switch-btn${value ? '' : ' is-on'}`,
      type: 'button',
      text: '关',
    }) as HTMLButtonElement;
    const on = h('button', {
      class: `pill-switch-btn${value ? ' is-on' : ''}`,
      type: 'button',
      text: '开',
    }) as HTMLButtonElement;
    off.disabled = disabled;
    on.disabled = disabled;
    const paint = (next: boolean): void => {
      root.classList.toggle('is-on', next);
      off.classList.toggle('is-on', !next);
      on.classList.toggle('is-on', next);
    };
    off.addEventListener('click', () => {
      paint(false);
      onChange(false);
    });
    on.addEventListener('click', () => {
      paint(true);
      onChange(true);
    });
    root.append(thumb, off, on);
    return { root, setValue: paint };
  }

  private buildField(field: Field): HTMLElement {
    if (field.kind === 'section') {
      return h('div', { class: 'set-section', text: field.label });
    }

    const options = this.options ?? ({} as WallpaperOptions);

    if (field.kind === 'custom') {
      const wrap = h('div', { class: 'field set-row is-block' });
      const main = h('div', { class: 'set-row-main' }, h('div', { class: 'field-label set-row-label', text: field.label }));
      if (field.hint) main.append(h('div', { class: 'field-hint set-row-hint', text: field.hint }));
      wrap.append(main, field.build(options, (patch) => void this.commit(patch)));
      return wrap;
    }

    const main = h('div', { class: 'set-row-main' }, h('div', { class: 'field-label set-row-label', text: field.label }));
    if (field.hint) main.append(h('div', { class: 'field-hint set-row-hint', text: field.hint }));
    const control = h('div', { class: 'set-row-control' });
    const row = h('div', { class: 'field set-row' }, main, control);

    if (field.kind === 'switch') {
      const sw = this.buildSwitch(Boolean(options[field.key]), field.disabled === true, (next) =>
        void this.commit({ [field.key]: next } as Partial<WallpaperOptions>),
      );
      this.updaters.set(field.key, (value) => sw.setValue(Boolean(value)));
      control.append(sw.root);
      return row;
    }

    if (field.kind === 'select' || field.kind === 'numbers') {
      const current = options[field.key];
      const select = createSelectControl({
        className: 'set-select',
        ariaLabel: field.label,
        value: String(current),
        options: field.options.map((option) => ({ value: String(option.value), label: option.label })),
        onChange: (value) => {
          const raw = field.kind === 'numbers' ? Number(value) : value;
          void this.commit({ [field.key]: raw } as Partial<WallpaperOptions>);
        },
      });
      this.updaters.set(field.key, (value) => select.setValue(String(value ?? '')));
      control.append(select.root);
      return row;
    }

    if (field.kind === 'range') {
      const current = Number(options[field.key] ?? 0);
      const output = h('span', { class: 'set-value', text: field.format ? field.format(current) : String(current) });
      const input = h('input', {
        class: 'wp-range',
        type: 'range',
        min: String(field.min),
        max: String(field.max),
        step: String(field.step),
      }) as HTMLInputElement;
      input.value = String(current);
      input.addEventListener('input', () => {
        output.textContent = field.format ? field.format(Number(input.value)) : input.value;
      });
      input.addEventListener('change', () => {
        void this.commit({ [field.key]: Number(input.value) } as Partial<WallpaperOptions>);
      });
      this.updaters.set(field.key, (value) => {
        const next = Number(value ?? 0);
        input.value = String(next);
        output.textContent = field.format ? field.format(next) : String(next);
      });
      control.append(input, output);
      return row;
    }

    // text
    const input = h('input', { class: 'wp-text', type: 'text', placeholder: field.placeholder ?? '' }) as HTMLInputElement;
    input.value = String(options[field.key] ?? '');
    input.addEventListener('change', () => void this.commit({ [field.key]: input.value } as Partial<WallpaperOptions>));
    this.updaters.set(field.key, (value) => {
      input.value = String(value ?? '');
    });
    control.append(input);
    return row;
  }

  private async commit(patch: Partial<WallpaperOptions>): Promise<void> {
    try {
      const response = await patchOptions(patch);
      if (response.options) {
        // 提交后按宿主返回的真实值回填：页面壁纸开关在壁纸未启用时会被归一化，
        // 或者同一份设置被快捷设置同时改过，界面不能停在旧状态。
        this.applyOptions(response.options);
      }
    } catch (error) {
      toast(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }
}

/* ------------------------------------------------------------------ 自定义字段 */

/** 每块屏的音量：滑块默认停在全局音量上（显示「跟随全局」），拖动后才写这块屏自己的覆盖值。 */
function buildMonitorVolumes(options: WallpaperOptions): HTMLElement {
  const wrap = h('div', { class: 'wp-monitor-volumes' });
  const status = h('div', { class: 'wp-muted', text: '读取屏幕音量…' });
  const fallback = Math.round(options.audioVolume ?? 100);
  wrap.append(status);

  void fetchMonitors()
    .then(({ items }) => {
      status.remove();
      if (items.length === 0) {
        wrap.append(h('div', { class: 'wp-muted', text: '没有检测到屏幕。' }));
        return;
      }
      for (const monitor of items) {
        const own = monitor.volume;
        const following = own === null || own === undefined;
        const value = h('span', {
          class: 'wp-range-value',
          text: following ? '跟随全局' : `${own}%`,
        });
        const input = h('input', {
          class: 'wp-range',
          type: 'range',
          min: '0',
          max: '100',
          step: '5',
          value: String(following ? fallback : own),
        });
        input.addEventListener('input', () => {
          value.textContent = `${input.value}%`;
        });
        input.addEventListener('change', () => {
          const volume = Number(input.value);
          // 拖回全局音量就等于「跟随全局」，清掉覆盖值，省得以后全局改了这块屏不动。
          const next = volume === fallback ? null : volume;
          value.textContent = next === null ? '跟随全局' : `${volume}%`;
          void saveCanvasSettings('desktop', monitor.key, { volume: next })
            .then(() => {
              toast(next === null ? `${monitor.index} 号屏恢复跟随全局` : `${monitor.index} 号屏音量已设为 ${volume}%`);
            })
            .catch((error: unknown) => {
              value.textContent = following ? '跟随全局' : `${own}%`;
              input.value = String(following ? fallback : own);
              toast(`音量保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
            });
        });
        const name = h('span', {
          class: 'wp-monitor-vol-name',
          text: `${monitor.index}${monitor.primary ? ' · 主屏' : ''}  ${monitor.w}×${monitor.h}`,
        });
        wrap.append(
          h('div', { class: 'wp-monitor-vol-row' }, name, h('div', { class: 'wp-range-box' }, input, value)),
        );
      }
    })
    .catch((error: unknown) => {
      status.textContent = `读取失败：${error instanceof Error ? error.message : String(error)}`;
    });

  return wrap;
}

function buildWatchFolders(options: WallpaperOptions, commit: (patch: Partial<WallpaperOptions>) => void): HTMLElement {  // options 只用于首次渲染。
  const list = h('div', { class: 'wp-folder-list' });

  const paint = (folders: string[]): void => {
    list.textContent = '';
    if (folders.length === 0) {
      list.append(h('div', { class: 'wp-muted', text: '还没加目录。点下面「添加目录」选一个放视频的文件夹。' }));
      return;
    }

    folders.forEach((folder, index) => {
      const remove = h('button', { class: 'wp-icon-btn', type: 'button', title: '移出监视' }, icon('close', 14));
      remove.addEventListener('click', () => {
        const next = folders.filter((_, i) => i !== index);
        commit({ watchFolders: next });
        paint(next);
      });
      list.append(h('div', { class: 'wp-folder-row' }, h('span', { class: 'wp-folder-path', text: folder }), remove));
    });
  };

  paint(options.watchFolders ?? []);
  return list;
}

function buildTransitionExclude(_options: WallpaperOptions, commit: (patch: Partial<WallpaperOptions>) => void): HTMLElement {
  // 后端 options 里没暴露 exclude 列表时按「全部参与」显示。
  const current = new Set<string>();
  const wrap = h('div', { class: 'wp-chips' });
  for (const transition of TRANSITION_LABELS) {
    const chip = h('button', { class: 'wp-chip', type: 'button', text: transition.label });
    if (current.has(transition.value)) chip.classList.add('is-on');
    chip.addEventListener('click', () => {
      if (current.has(transition.value)) current.delete(transition.value);
      else current.add(transition.value);
      chip.classList.toggle('is-on', current.has(transition.value));
      commit({} as Partial<WallpaperOptions>);
    });
    wrap.append(chip);
  }

  return wrap;
}

/** 一套预设存哪些键（第 83 轮 A：滤镜 + 转场 + 轮换间隔 + 可视化开关）。 */
const PRESET_KEYS = [
  'dimMode',
  'dimBase',
  'dimMax',
  'brightness',
  'contrast',
  'saturation',
  'blur',
  'transitionMode',
  'transitionId',
  'transitionMs',
  'rotationMinutes',
  'visualizerEnabled',
  'visualizerStyle',
  'beatStrength',
  'parallax',
  'overlayEnabled',
] as const;

/**
 * 配置预设（第 83/84 轮）：保存当前一整套观感，随时切回来。
 * 「外观联动」用它 —— kind 为 appearance 的预设会在明暗主题切换时自动应用。
 */
function buildPresets(options: WallpaperOptions): HTMLElement {
  const box = div('wp-diag');
  const list = div('wp-seq-list');
  const actions = div('wp-diag-actions');
  box.append(list, actions);

  const refresh = async (): Promise<void> => {
    list.replaceChildren();
    try {
      const result = await fetchPresets();
      if (!result.ok || result.items.length === 0) {
        list.append(h('div', { class: 'wp-muted', text: '还没有预设。' }));
        return;
      }

      for (const preset of result.items) {
        const row = div('wp-seq-row');
        const title = h('span', { class: 'wp-seq-name', text: preset.name });
        const applyBtn = h('button', { class: 'wp-btn wp-btn-sm', type: 'button', text: '应用' });
        applyBtn.addEventListener('click', () => {
          const payload = preset.payload as Record<string, unknown>;
          const patch: Record<string, unknown> = {};
          for (const key of PRESET_KEYS) {
            if (payload[key] !== undefined) patch[key] = payload[key];
          }
          void patchOptions(patch).then(() => {
            toast(`已应用预设「${preset.name}」`);
            void refresh();
          });
        });
        const delBtn = h('button', { class: 'wp-btn wp-btn-sm wp-btn-danger', type: 'button', text: '删除' });
        delBtn.addEventListener('click', () => {
          void deletePreset(preset.id).then(() => {
            toast('预设已删除');
            void refresh();
          });
        });
        row.append(title, applyBtn, delBtn);
        list.append(row);
      }
    } catch (error) {
      list.append(h('div', { class: 'wp-muted', text: `读取预设失败：${String(error)}` }));
    }
  };

  const saveBtn = h('button', { class: 'wp-btn wp-btn-sm wp-btn-primary', type: 'button', text: '保存当前为预设' });
  saveBtn.addEventListener('click', () => {
    const payload: Record<string, unknown> = {};
    for (const key of PRESET_KEYS) payload[key] = options[key];
    const stamp = new Date();
    const name = `预设 ${stamp.getHours().toString().padStart(2, '0')}${stamp.getMinutes().toString().padStart(2, '0')}`;
    saveBtn.disabled = true;
    void savePreset({ name, kind: 'manual', payload })
      .then((result) => {
        toast(result.ok ? `已保存「${name}」` : '保存预设失败');
        void refresh();
      })
      .finally(() => {
        saveBtn.disabled = false;
      });
  });

  actions.append(saveBtn);
  void refresh();
  return box;
}

/** 本文件没有全局 div 助手，就地补一个（与 h('div') 等价）。 */
function div(className = ''): HTMLDivElement {
  const element = document.createElement('div');
  if (className) element.className = className;
  return element;
}

/**
 * 序列播放（第 85 轮）：列出现有序列，可以「从收藏/全部素材快速生成一条」，
 * 也可以逐条应用或删除。序列的编辑（排序/单条时长）留到二期完整的序列编辑器。
 */
function buildSequences(): HTMLElement {
  const box = div('wp-diag');
  const list = div('wp-seq-list');
  const actions = div('wp-diag-actions');
  box.append(list, actions);

  const refresh = async (): Promise<void> => {
    list.replaceChildren();
    try {
      const result = await fetchSequences();
      if (!result.ok || result.items.length === 0) {
        list.append(h('div', { class: 'wp-muted', text: '还没有序列。' }));
        return;
      }

      for (const sequence of result.items) {
        const row = div('wp-seq-row');
        const title = h('span', {
          class: 'wp-seq-name',
          text: `${sequence.name} · ${sequence.items.length} 条${sequence.loop ? ' · 循环' : ''}`,
        });
        const applyBtn = h('button', { class: 'wp-btn wp-btn-sm', type: 'button', text: '播放' });
        applyBtn.addEventListener('click', () => {
          void applySequence('inapp', sequence.id).then((r) => {
            toast(r.ok ? `已开始播放「${sequence.name}」` : '启动序列失败');
            void refresh();
          });
        });
        const stopBtn = h('button', { class: 'wp-btn wp-btn-sm', type: 'button', text: '停止' });
        stopBtn.addEventListener('click', () => {
          void applySequence('inapp', 0).then(() => {
            toast('已退出序列');
            void refresh();
          });
        });
        const delBtn = h('button', { class: 'wp-btn wp-btn-sm wp-btn-danger', type: 'button', text: '删除' });
        delBtn.addEventListener('click', () => {
          void deleteSequence(sequence.id).then(() => {
            toast('序列已删除');
            void refresh();
          });
        });
        row.append(title, applyBtn, stopBtn, delBtn);
        list.append(row);
      }
    } catch (error) {
      list.append(h('div', { class: 'wp-muted', text: `读取序列失败：${String(error)}` }));
    }
  };

  const makeBtn = (label: string, seconds: number, favoritesOnly: boolean): HTMLButtonElement => {
    const btn = h('button', { class: 'wp-btn wp-btn-sm', type: 'button', text: label });
    btn.addEventListener('click', () => {
      btn.disabled = true;
      void (async () => {
        try {
          const page = await fetchLibrary({ favorites: favoritesOnly, limit: 24, sort: 'added' });
          const picked = page.items.filter((item) => !item.missing).slice(0, 12);
          if (picked.length === 0) {
            toast('没有可用素材');
            return;
          }

          const result = await saveSequence({
            name: `${favoritesOnly ? '收藏轮播' : '全部轮播'} ${picked.length} 条`,
            loop: true,
            items: picked.map((item) => ({ assetId: item.id, durationMs: seconds * 1000 })),
          });
          if (result.ok) {
            toast(`已生成序列（${picked.length} 条 × ${seconds}s）`);
            void refresh();
          } else {
            toast('生成序列失败');
          }
        } catch (error) {
          toast(`生成序列失败：${String(error)}`);
        } finally {
          btn.disabled = false;
        }
      })();
    });
    return btn;
  };

  actions.append(
    makeBtn('生成 10 秒轮播', 10, false),
    makeBtn('生成 30 秒轮播', 30, false),
    makeBtn('收藏 15 秒轮播', 15, true),
  );

  void refresh();
  return box;
}

function buildDiagnostics(
  _options: WallpaperOptions,
  _commit: (patch: Partial<WallpaperOptions>) => void,
): HTMLElement {
  const box = h('div', { class: 'wp-diag' });
  const info = h('dl', { class: 'wp-info' });
  const actions = h('div', { class: 'wp-diag-actions' });

  const clean = h('button', { class: 'wp-btn wp-btn-sm', type: 'button' }, icon('trash', 14), h('span', { text: '清理缓存' }));
  clean.addEventListener('click', async () => {
    try {
      const result = await cleanStorage();
      toast(`已清理 ${result.removed} 项，释放 ${formatBytes(result.freedBytes)}`);
      void refresh();
    } catch (error) {
      toast(`清理失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });

  const reload = h('button', { class: 'wp-btn wp-btn-sm', type: 'button' }, icon('refresh', 14), h('span', { text: '刷新' }));
  reload.addEventListener('click', () => void refresh());

  // 第 60 轮 D：自检 + 导出诊断包。
  const selfCheck = h('button', { class: 'wp-btn wp-btn-sm', type: 'button' }, icon('info', 14), h('span', { text: '自检' }));
  selfCheck.addEventListener('click', async () => {
    try {
      const result = await runSelfCheck();
      const lines = result.checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}：${c.detail}`).join('\n');
      if (result.ok) toast('自检通过');
      else toast(`自检发现 ${result.failures} 项异常`, 'error');
      window.setTimeout(() => window.alert(lines), 60);
    } catch (error) {
      toast(`自检失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });

  const exportBtn = h('button', { class: 'wp-btn wp-btn-sm', type: 'button' }, icon('download', 14), h('span', { text: '导出诊断包' }));
  exportBtn.addEventListener('click', async () => {
    try {
      const result = await exportDiagnostics();
      toast('诊断包已导出');
      window.alert(`已导出到：\n${result.path}`);
    } catch (error) {
      toast(`导出失败：${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });

  actions.append(clean, selfCheck, exportBtn, reload);
  box.append(info, actions);

  const refresh = async (): Promise<void> => {
    info.textContent = '';
    try {
      const diagnostics: WallpaperDiagnostics = await fetchDiagnostics();
      const storage: WallpaperStorage = await fetchStorage();
      const rows: Array<[string, string]> = [
        ['素材总数', String(storage.libraryCount ?? 0)],
        ['收藏', String(storage.favorites ?? 0)],
        ['媒体占用', formatBytes(storage.mediaBytes ?? 0)],
        ['封面', `${storage.coverCount ?? 0} 张 / ${formatBytes(storage.coverBytes ?? 0)}`],
        ['库目录', storage.root ?? '—'],
        ['FFmpeg', diagnostics.ffmpegAvailable ? diagnostics.ffmpegPath ?? '已就绪' : '未找到（视频解不了，只能用图片）'],
        ['软件内画布', describeCanvas(diagnostics.inApp)],
        ['桌面层', describeCanvas(diagnostics.desktop)],
      ];
      for (const [label, value] of rows) {
        info.append(h('dt', { class: 'wp-label', text: label }), h('dd', { text: value }));
      }
    } catch (error) {
      info.append(h('dt', { class: 'wp-label', text: '读取失败' }), h('dd', { text: error instanceof Error ? error.message : String(error) }));
    }
  };

  void refresh();
  return box;
}

function describeCanvas(snapshot: { title?: string | null; running?: boolean; paused?: boolean; lastError?: string | null } | undefined): string {
  if (!snapshot) return '无';
  const name = snapshot.title || '未选择';
  const state = snapshot.lastError ? `异常：${snapshot.lastError}` : snapshot.paused ? '已暂停' : snapshot.running ? '播放中' : '未运行';
  return `${name} · ${state}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
