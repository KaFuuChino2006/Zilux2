/**
 * Zilux2 QA 套件 —— 固定夹具与阈值。
 *
 * 这里的值要么来自产品实现（web/src），要么来自 Lead 集成后同步的验收数值表。
 * 所有值都可以用同名环境变量覆盖，方便换机器/换版本时不用改代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './cdp.mjs';

/** 本地曲库测试夹具目录（2 个 mp3：宝船.mp3 / 晴天(深情版).mp3）。 */
export const LOCAL_FIXTURE_DIR =
  process.env.ZILUX2_LOCAL_FIXTURE_DIR || path.join(REPO_ROOT, 'research', 'tmp', 'qa-fixture');

/** 搜索关键词：用夹具里的歌名，尽量保证有结果且可下载。 */
export const SEARCH_KEYWORD = process.env.ZILUX2_SEARCH_KEYWORD || '晴天';

/** local-watch：放/删文件后页面自动更新的最长等待（产品验收要求 ≤8s）。 */
export const LOCAL_WATCH_TIMEOUT_MS = Number(process.env.ZILUX2_LOCAL_WATCH_TIMEOUT_MS || 8000);

/** 下载：等待任务 done 的最长时间。 */
export const DOWNLOAD_TIMEOUT_MS = Number(process.env.ZILUX2_DOWNLOAD_TIMEOUT_MS || 90000);

/** 下载进度采样间隔（HANDOFF §4：80-90ms 采样能抓到过渡）。 */
export const DOWNLOAD_SAMPLE_INTERVAL_MS = Number(process.env.ZILUX2_DOWNLOAD_SAMPLE_MS || 85);

/** localStorage 键（web/src 的真实实现）。 */
export const LOCAL_FOLDER_KEY = 'zilux2.localFolder';
export const ROOM_SETTINGS_KEY = 'zilux2.roomStyle';
export const LUMIERE_KEY = 'zilux2.lumiere';

/**
 * 下载队列面板选择器（本轮新增功能，来自任务约定 + web/src/ui/downloadQueue.ts 实现）。
 *
 * 面板是单例：首次打开时 ensurePanel() 才创建，收起只是 .is-open 移除，DOM 保留。
 * 行按状态排序：running → error → done（同一状态内宿主 startedAt 倒序）。
 */
export const DLQ = {
  entry: '[data-qa="download-entry"]',
  /**
   * rail 上的下载入口已在 task-12 移除（入口迁到快捷设置第 5 页「下载」）。
   * 保留常量用于断言「不存在」；真正入口是播放条 DLQ.entry 与 QUICK.tabDownload。
   */
  railEntry: '.rail .rail-btn[aria-label="下载队列"]',
  panel: '.dlq-panel',
  panelOpen: '.dlq-panel.is-open',
  row: '.dlq-row[data-state]',
  head: '.dlq-panel .dlq-head',
  title: '.dlq-panel .dlq-title',
  refresh: '.dlq-panel .dlq-refresh',
  close: '.dlq-panel .dlq-close',
  summary: '.dlq-summary',
  sumItem: (kind) => `.dlq-summary .dlq-sum-item[data-kind="${kind}"]`,
  tabs: '.dlq-panel .dlq-tab',
  tab: (label) => `.dlq-panel .dlq-tab`,
  tabsSeg: '.dlq-panel .dlq-tabs',
  segBtn: '.dlq-panel .dlq-tabs .seg-btn',
  segThumb: '.dlq-panel .dlq-tabs > .seg-thumb',
  list: '.dlq-panel .dlq-list',
  empty: '.dlq-panel .dlq-empty',
  error: '.dlq-panel .dlq-error',
  hint: '.dlq-panel .dlq-hint',
  dirPath: '.dlq-panel .dlq-dir-path',
  openDir: '.dlq-panel .dlq-open-dir',
  rowName: '.dlq-name',
  rowMeta: '.dlq-meta',
  rowPct: '.dlq-pct',
  rowStatus: '.dlq-status',
  bar: '.dlq-bar',
  fill: '.dlq-bar > .dlq-fill',
  retry: '.dlq-retry',
  reveal: '.dlq-reveal',
  actions: '.dlq-actions',
  badge: '.dlq-badge',
};

/** 下载完成/失败后给 UI 的宽限时间（轮询 1.2s 一次）。 */
export const DOWNLOAD_UI_SETTLE_MS = Number(process.env.ZILUX2_DLQ_SETTLE_MS || 4000);

/** 是否真的点「在文件夹中显示」（会弹出资源管理器，默认不点）。 */
export const DOWNLOAD_CLICK_REVEAL = process.env.ZILUX2_QA_CLICK_REVEAL === '1';

/** 设置存储键（web/src/core/settings.ts:158）；用来验证「本次下载音质选择不回写设置」。 */
export const SETTINGS_KEY = 'zilux2.settings';

/**
 * 快捷设置（底部快捷面板）与第 5 页「下载」的选择器。
 *
 * task-12 把下载入口从 rail 迁到快捷设置第 5 页；同一份下载队列视图同时以
 * 浮层面板（.dlq-panel）和嵌入页（.dlq-embed[data-qa="quick-downloads-page"]）两种形态存在。
 */
export const QUICK = {
  trigger: '.pb-quick',
  root: '.quick',
  open: '.quick.is-open',
  downloadOpen: '.quick.is-download.is-open',
  tabs: '.quick-tabs .quick-tab',
  tabDownload: '.quick-tabs .quick-tab',
  page: '[data-qa="quick-downloads-page"]',
  embed: '.dlq-embed',
  embedTitle: '[data-qa="quick-downloads-page"] .dlq-embed-title',
  embedStatus: '[data-qa="quick-downloads-page"] .dlq-embed-status',
  embedRefresh: '[data-qa="quick-downloads-page"] .dlq-embed-refresh',
  pageTabs: '[data-qa="quick-downloads-page"] .dlq-tab',
  pageTabsSeg: '[data-qa="quick-downloads-page"] .dlq-tabs',
  pageSegThumb: '[data-qa="quick-downloads-page"] .dlq-tabs > .seg-thumb',
  pageList: '[data-qa="quick-downloads-page"] .dlq-list',
  pageEmpty: '[data-qa="quick-downloads-page"] .dlq-empty',
  pageRow: '[data-qa="quick-downloads-page"] .dlq-row[data-state]',
  dirPath: '[data-qa="quick-downloads-page"] .dlq-dir-path',
  openDir: '[data-qa="quick-downloads-page"] .dlq-open-dir',
};

/**
 * 下载音质选择浮层（web/src/ui/downloadPicker.ts）。
 *
 * 所有下载入口都先弹它：默认选中设置里的 downloads.quality（默认 high），
 * 选择只对这次下载生效（不回写设置）；Esc / 点浮层外 / 取消都不入队。
 */
export const PICKER = {
  overlay: '.dlqp-overlay',
  overlayOpen: '.dlqp-overlay.is-open',
  panel: '.dlqp-panel[data-qa="download-picker"]',
  title: '.dlqp-title',
  track: '.dlqp-track',
  hint: '.dlqp-hint',
  options: '.dlqp-option',
  option: (quality) => `.dlqp-option[data-quality="${quality}"]`,
  checkedOption: '.dlqp-option[aria-checked="true"]',
  defaultOption: '.dlqp-option[data-default="true"]',
  defaultNote: '.dlqp-option-default',
  check: '.dlqp-check',
  cancel: '.dlqp-cancel',
  /** 音质 → 中文文案（浮层选项 label）。 */
  labels: { standard: '标准', high: '高品质', lossless: '无损' },
};

/**
 * 全局快捷键设置（task-15；web/src/ui/app.ts buildShortcutsSection + core/settings.ts Shortcuts v1）。
 *
 * 位置：设置弹窗 → 左侧导航「快捷键」。面板只做设置 patch，宿主注册结果通过 bridge
 * 的 shortcuts 事件回推，行内状态文案：已生效 / 已回落到 X / 组合被占用 / 未启用 / 未设置。
 */
export const SHORTCUTS = {
  section: '[data-qa="shortcuts-section"]',
  list: '[data-qa="shortcuts-section"] .shortcut-list',
  row: '[data-qa="shortcut-row"]',
  rowAction: (action) => `[data-qa="shortcut-row"][data-action="${action}"]`,
  label: '.shortcut-label',
  key: '[data-qa="shortcut-key"]',
  status: '[data-qa="shortcut-status"]',
  record: '[data-qa="shortcut-record"]',
  enabled: '[data-qa="shortcuts-enabled"]',
  switchRoot: '[data-qa="shortcuts-enabled"] .pill-switch',
  switchBtn: '[data-qa="shortcuts-enabled"] .pill-switch-btn',
  reset: '[data-qa="shortcut-reset"]',
  tip: '[data-qa="shortcuts-section"] .shortcut-tip',
  /** 设置左侧导航里的按钮文案。 */
  navLabel: '快捷键',
};

/** 四条可配置动作（顺序即设置页展示顺序，settings.ts SHORTCUT_ACTIONS）。 */
export const SHORTCUT_ACTIONS = ['playPause', 'prev', 'next', 'toggleWindow'];

/** 动作 → 设置页行标题（settings.ts SHORTCUT_LABELS.label）。 */
export const SHORTCUT_LABELS = {
  playPause: '播放 / 暂停',
  prev: '上一首',
  next: '下一首',
  toggleWindow: '显示 / 隐藏窗口',
};

/** 默认组合（settings.ts SHORTCUT_DEFAULTS；宿主 Settings/SettingsModel.cs 同值）。 */
export const SHORTCUT_DEFAULTS = {
  enabled: true,
  playPause: 'Ctrl+Alt+Space',
  prev: 'Ctrl+Alt+Left',
  next: 'Ctrl+Alt+Right',
  toggleWindow: 'Ctrl+Alt+Z',
};

/** 宿主设置持久化文件（SettingsService；页面已不再把设置镜像到 localStorage）。 */
export const SETTINGS_JSON =
  process.env.ZILUX2_SETTINGS_PATH ||
  path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'),
    'Zilux2',
    'settings.json',
  );

/** 动作 → 宿主 RegisterHotKey 的 id（MainWindow.OnHotkey switch）。WM_HOTKEY 测试杠杆用。 */
export const HOTKEY_IDS = { playPause: 1, prev: 2, next: 3, toggleWindow: 4 };

/**
 * 房间设置「粒子/流星预设」验收数值表 —— 由 Lead 在集成后同步。
 *
 * 每项：
 *   {
 *     kind: 'particle' | 'streak',        // data-preset-kind（实现里流星组的 kind 是 streak）
 *     id:   '<预设 id>',                  // data-preset-id
 *     label?: '<按钮文本>',
 *     expect: { <RoomStyleSettings 字段>: <期望值>, ... }  // 只写该预设应改变的字段
 *   }
 *
 * 点击 chip 后断言 localStorage 'zilux2.roomStyle' 里对应字段变成 expect。
 * 若 chip 只改 draft、需要点「保存」才落盘，脚本会自动点一次保存再读。
 */
export const ROOM_PRESET_FIXTURES = [
  // 粒子：particleCount, particleSize, particleBrightness, particleSpeed, particleDrift
  { kind: 'particle', id: 'stardust', label: '星尘', expect: { particleCount: 36, particleSize: 1, particleBrightness: 1, particleSpeed: 1, particleDrift: 1 } },
  { kind: 'particle', id: 'firefly', label: '萤火', expect: { particleCount: 64, particleSize: 1.3, particleBrightness: 1.2, particleSpeed: 0.55, particleDrift: 1.6 } },
  { kind: 'particle', id: 'snow', label: '雪点', expect: { particleCount: 72, particleSize: 0.55, particleBrightness: 1.9, particleSpeed: 0.4, particleDrift: 2.2 } },
  { kind: 'particle', id: 'hush', label: '静谧', expect: { particleCount: 12, particleSize: 2.2, particleBrightness: 0.45, particleSpeed: 0.3, particleDrift: 0.6 } },
  // 流星：streakStrength, streakCount, streakSpeed, streakLength, streakWidth
  { kind: 'streak', id: 'default', label: '默认', expect: { streakStrength: 1, streakCount: 7, streakSpeed: 1, streakLength: 0.28, streakWidth: 1 } },
  { kind: 'streak', id: 'rain', label: '流星雨', expect: { streakStrength: 0.85, streakCount: 12, streakSpeed: 2.2, streakLength: 0.2, streakWidth: 0.55 } },
  { kind: 'streak', id: 'comet', label: '长拖尾', expect: { streakStrength: 1, streakCount: 3, streakSpeed: 0.75, streakLength: 0.72, streakWidth: 1.6 } },
  { kind: 'streak', id: 'glow', label: '微光', expect: { streakStrength: 0.4, streakCount: 5, streakSpeed: 0.25, streakLength: 0.5, streakWidth: 1.8 } },
];

export const ROOM_PRESET_FIXTURES_READY = ROOM_PRESET_FIXTURES.length > 0;

/** 预设行容器选择器（行上有 data-preset-kind，按钮上也有 data-preset-kind/data-preset-id）。 */
export function roomPresetChipSel(kind, id) {
  return `.room-preset-row[data-preset-kind="${kind}"] button[data-preset-kind="${kind}"][data-preset-id="${id}"]`;
}

/** 本地曲库夹具：返回目录里的 mp3 文件（绝对路径）。 */
export function fixtureMp3Files() {
  try {
    return fs
      .readdirSync(LOCAL_FIXTURE_DIR)
      .filter((name) => name.toLowerCase().endsWith('.mp3'))
      .map((name) => path.join(LOCAL_FIXTURE_DIR, name));
  } catch {
    return [];
  }
}

/** 目录是否存在且可读。 */
export function dirExists(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
