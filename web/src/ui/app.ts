/// <reference types="vite/client" />
/**
 * 应用外壳：顶栏 / 左 rail / 墙面 / 播放条 / 弹层（搜索、设置、账号、登录）。
 * 新前端只有这一个"页面"，各视图在 stage 内切换。
 */

import '../styles/shortcut-settings.css';
import '../styles/local-library.css';
import '../styles/polish-tools.css';
import QRCode from 'qrcode';

/** 迷你播放器状态记忆键：刷新/崩溃恢复后用来向宿主复核窗口态。 */
const MINI_MODE_KEY = 'zilux2.miniMode';
import {
  accountOf,
  getAccounts,
  importCookie,
  logout,
  onAccountChange,
  pollLogin,
  refreshAccounts,
  requestQr,
  type AccountSource,
  type LoginSession,
} from '../core/account';
import { fetchLibraryOverview, fetchPlaylist, refreshLibrary } from '../core/library';
import type { LibraryPlaylist } from '../core/library';
import {
  EQ_BAND_FREQS,
  EQ_GAIN_MAX,
  EQ_GAIN_MIN,
  EQ_PRESET_IDS,
  EQ_PRESET_LABELS,
  EQ_PRESETS,
  FADE_CURVES,
  FADE_IN_MS,
  FADE_OUT_MS,
  FADE_VOCAL_TAIL_MS,
  formatShortcutForDisplay,
  getSettings,
  normalizeShortcutBinding,
  onSettingsChange,
  patchSettings,
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFAULTS,
  SHORTCUT_LABELS,
  shortcutBindingFromEvent,
  type EqPreset,
  type FadeCurve,
  type ShortcutAction,
} from '../core/settings';
import { addLikedTrack, checkLikedMany, clearMvmp3Cache, fetchFeed, fetchHotPlaylists, fetchMvmp3Cache, fetchRecentMerged, onlineEndpoint, onlineReady, qualityForSource, removeLikedTrack, searchOnline, setQualityForSource } from '../online/client';
import type { OnlineSource, OnlineTrack, StreamQuality } from '../online/types';
import { SOURCE_LABEL } from '../online/types';
import {
  accountSourceIds,
  sourceDescriptors,
  sourceHasDaily30,
  sourceIds,
  sourceLoginMode,
  sourceMeta,
  sourceQualities,
  sourceSupportsLikedWrite,
} from '../online/sources';
import { onlineArtwork } from '../online/artwork';
import { buildAnalysisSection } from './analysisSection';
import { buildCrossfadeSection, readCrossfadeDebug } from './crossfadeDeck';
import { confirmDialog } from './confirmDialog';
import { createEqCurve } from './eqCurve';
import { localArtists, localTracks, type LocalArtist } from './localArtists';
import {
  EXPERIMENTAL_SOURCES,
  experimentalSourceEnabled,
  hasExperimentalSources,
  setExperimentalSourceEnabled,
} from '../online/experimental';
import { lookupCover } from '../online/coverLookup';
import { h, icon, toast, fmtTime, Disposers } from './dom';
import { airplay } from '../airplay';
import { startAudioTap, stopAudioTap } from '../core/audioTap';
import { disposeMetronome } from '../core/metronome';
import { createAirplayPanel, type AirplayPanelHandle } from './airplayPanel';
import {
  deleteLocalTracks,
  initLocalLibrary,
  localLibrary,
  onLocalLibraryChange,
  onLocalResult,
  openLocalFolder,
  pickLocalFolder,
  rememberedFolder,
  relOf,
  revealLocalTrack,
  trackOf,
} from './local';
import { isLocalLiked, likedLocalKeys, subscribe as subscribeLocalLikes, toggleLocalLike } from './localLikes';
import {
  addTracks as addTracksToPlaylist,
  createPlaylist,
  deletePlaylist,
  getPlaylist,
  listPlaylists,
  renamePlaylist,
  subscribe as subscribeLocalPlaylists,
  trackKeyOfTrack,
  tracksOfKeys,
} from './localPlaylists';
import { openTagEditor } from './tagEditor';
import { buildEqPresetManager } from './eqPresets';
import { buildSearchHistoryPanel, recordSearch, type SearchHistoryPanelHandle } from './searchHistory';
import { buildSettingsIOActions } from './settingsIO';
import { buildSleepTimerPanel, completeSleepTimer, getSleepTimerState } from './sleepTimer';
import { currentLyricSource, lyricGrowMode, lyricMatchMinScore, lyricOffsetOf, lyricsBackgroundMode, lyricsLumiereMode, LyricsView, primeLyrics, setLyricGrowMode, setLyricsBackgroundMode, setLyricsLumiereMode, setLyricMatchMinScore, setLyricOffset, updateCurrentLyricLine, lyricMatchText } from './lyrics';
import { LUMIERE_MODES } from './lumiere';
import { LYRIC_STYLES, lyricStyle, setLyricStyle } from './lyricStyle';
import {
  cycleMode,
  getPlaybackSpeed,
  moveQueueItem,
  next,
  onPlayer,
  playAt,
  playQueue,
  playerState,
  prev,
  removeQueueItem,
  refreshCurrentLiked,
  replaceQueue,
  seek,
  setPlaybackSpeed,
  setVolume,
  toggle,
  toggleLiked,
  type PlayerState,
} from './player';
import { host, hostAvailable, getShortcutsState, onMiniMode, onShortcutsState, type UpdateSnapshot } from '../core/bridge';
import { HomeView } from './home';
import { DiscoverView } from './discover';
import { openSongInfo, setSongInfoView, songInfoView } from './songInfo';
import { createUpNextToast, type UpNextToastHandle } from './upNextToast';
import {
  beginQueueDownload,
  closeDownloadPanel,
  createDownloadEntryButton,
  createDownloadQueueView,
  disposeDownloadQueue,
  initDownloadQueue,
  isDownloadPanelOpen,
  openDownloadPanel,
  type DownloadQueueView,
} from './downloadQueue';
import { closeQualityPicker, openDownloadMenu, openQualityPicker } from './downloadPicker';
import type { PlayScope } from './home';
import type { HomeCollection, HomeData } from './home';
import { openLyricPicker } from './lyricPicker';
import { openTextSettingsSheet } from './textSettingsPanel';
import { openRoomSettingsSheet } from './roomSettingsPanel';
import { readPosterLayout, writePosterLayout, type PosterLayout } from './posterLayout';
import { ACCENT_PRESETS, applyAccentColor, readAccentColor, writeAccentColor } from './theme';
import { APP_BG_BLUR, APP_BG_POSITIONS, applyAppBgStyle, pickBackgroundImageFile, readAppBgBlur, readAppBgImage, readAppBgMode, readAppBgPosition, writeAppBgBlur, writeAppBgImage, writeAppBgMode, writeAppBgPosition, type AppBgMode } from './appBackground';
import {
  UPDATE_STATE_TEXT,
  cancelUpdate,
  checkForUpdate,
  downloadUpdate,
  formatBytes,
  installUpdate,
  onUpdateChange,
  openReleasePage,
  updateProgress,
  updateSnapshot,
} from './updates';

type WallKind = 'liked' | 'local' | 'search' | 'feed' | 'playlist' | 'recent';

interface WallData {
  kind: WallKind;
  title: string;
  subtitle: string;
  tracks: OnlineTrack[];
  /** 本地歌单墙关联的歌单 id（用于「添加歌曲」）。 */
  playlistId?: string;
}

interface WallPagerEntry {
  source: OnlineSource;
  id: string;
  special: 'liked' | null;
}

interface WallPager {
  entries: WallPagerEntry[];
  offset: number;
  pageSize: number;
  hasMore: boolean;
}

interface SheetHandle {
  root: HTMLDivElement;
  body: HTMLDivElement;
  close(): void;
}


/** 无缝过渡倒计时弹窗停留时长（毫秒）：弹出后几秒自动消失，同一轮准备只弹一次。 */
const SEAMLESS_HINT_VISIBLE_MS = 4200;

/** 过渡时长文案：整秒省略小数，否则保留一位小数（如 6.9 秒 / 2 分 12 秒以上只会出现在倒计时里）。 */
function formatFadeSeconds(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (Math.abs(seconds - Math.round(seconds)) < 0.05) return `${Math.round(seconds)} 秒`;
  return `${seconds.toFixed(1)} 秒`;
}

/** 倒计时文案：秒 / 分+秒（用于「将在 X 分 Y 秒后过渡至…」）。 */
function formatCountdownSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

/** 热门歌单播放次数展示。 */
function formatPlays(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)} 亿次播放`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万次播放`;
  return `${Math.round(value)} 次播放`;
}

const WINDOW_ICON = { minimize: 'minimize', maximize: 'maximize', close: 'close' } as const;

export class App {
  readonly root: HTMLDivElement;

  private stage: HTMLDivElement;
  private homeHost!: HTMLDivElement;
  private home!: HomeView;
  private homeData: HomeData | null = null;
  private feedRailKey: string | null = null;
  private wallHost: HTMLDivElement;
  /** 「发现」页（懒创建，渲染在 wallHost 里）。 */
  private discover: DiscoverView | null = null;
  private wallPager: WallPager | null = null;
  private wallLoadingMore = false;
  private railButtons = new Map<string, HTMLButtonElement>();
  /** AirPlay 投送浮层：rail「投送」按钮弹出，DOM 挂 body 上做固定定位。 */
  private airplayPopEl: HTMLDivElement | null = null;
  private airplayPanel: AirplayPanelHandle | null = null;
  private airplayPopOpen = false;
  private airplayStreaming = false;
  /** 快捷设置「投送」页里的内嵌面板（懒创建，切页时挂载/停扫）。 */
  private airplayQuickPanel: AirplayPanelHandle | null = null;
  private airplayQuickActive = false;
  /** 分段控件（.seg）滑动胶囊的增强观察器。 */
  private segObserver?: MutationObserver;
  private playerbar!: HTMLDivElement;
  /** 顶部「即将播放下一首」预告条。 */
  private upNextToast: UpNextToastHandle | null = null;
  private accountBtn!: HTMLButtonElement;
  private accountWrap!: HTMLDivElement;
  private accountPanel!: HTMLDivElement;
  private accountPanelOpen = false;
  private searchInput!: HTMLInputElement;
  private searchDock!: HTMLDivElement;
  private searchPop!: HTMLDivElement;
  private searchTabs!: HTMLDivElement;
  private searchList!: HTMLDivElement;
  private searchNote!: HTMLDivElement;
  private searchDockOpen = false;
  /** 搜索结果收藏状态：key = source:id */
  private searchLiked = new Map<string, boolean>();
  private searchLikeBusy = new Set<string>();
  private searchSource: OnlineSource | 'all' = 'all';
  private searchSeq = 0;
  private searchTimer = 0;
  /** 搜索历史面板（顶部搜索弹层里）。 */
  private searchHistory: SearchHistoryPanelHandle | null = null;

  /** 当前墙面 */
  private wall: WallData = { kind: 'liked', title: '我喜欢的音乐', subtitle: '', tracks: [] };
  private likedCache = new Map<OnlineSource, OnlineTrack[]>();
  /** 我喜欢的音乐显示模式：融合（多平台）或单个平台 */
  private likedMode: 'all' | OnlineSource = 'all';
  /** 封面显示方式：网格卡片 / 横条列表（与首页热门歌单共用偏好） */
  private wallLayout: PosterLayout = readPosterLayout();
  /** 本地曲库视图：歌曲列表 / 歌手（艺术家）网格。 */
  private localMode: 'songs' | 'artists' = 'songs';
  /** 当前打开的本地艺术家名；null 表示本地曲库总览。 */
  private localArtistFilter: string | null = null;
  private lyrics: LyricsView | null = null;
  private sheet: SheetHandle | null = null;
  /** 设置弹窗内的订阅集合（换面板 / 关闭弹窗时统一清理）。 */
  private sheetScope: Disposers | null = null;
  private loginOverlay: HTMLDivElement | null = null;
  private playerDispose: (() => void) | null = null;
  private localDispose: (() => void) | null = null;
  private accountDispose: (() => void) | null = null;
  private settingsDispose: (() => void) | null = null;
  /** 设置页「更新」分区的快照订阅（同一时间只保留一份）。 */
  private updatesDispose: (() => void) | null = null;

  private pbCover!: HTMLImageElement;
  private pbCoverWrap!: HTMLDivElement;
  private pbMeta!: HTMLDivElement;
  private pbSource!: HTMLSpanElement;
  private pbTrackKey = '';
  private pbTitle!: HTMLDivElement;
  private pbArtist!: HTMLDivElement;
  private pbPlayBtn!: HTMLButtonElement;
  private pbLikeBtn!: HTMLButtonElement;
  private pbModeBtn!: HTMLButtonElement;
  private pbFill!: HTMLDivElement;
  private pbCur!: HTMLSpanElement;
  private pbDur!: HTMLSpanElement;
  private volumeInput!: HTMLInputElement;
  private volumeIcon!: HTMLSpanElement;

  private playerbarWrap!: HTMLDivElement;
  private upnextRoot!: HTMLDivElement;
  private upnextSummary!: HTMLButtonElement;
  private upnextCover!: HTMLImageElement;
  private upnextTitle!: HTMLDivElement;
  private upnextArtist!: HTMLDivElement;
  private upnextPanel!: HTMLDivElement;
  private upnextList!: HTMLUListElement;
  private upnextOpen = false;
  private upnextListKey = '';
  /** 待播队列拖拽排序：正在拖动的队列下标（-1 = 未拖动）。 */
  private upnextDragFrom = -1;
  private quickRoot!: HTMLDivElement;
  private quickPanelEl!: HTMLDivElement;
  private quickTabsObserver: ResizeObserver | null = null;
  private quickCloseCleanup: (() => void) | null = null;
  private quickHeightTimer = 0;
  private quickWidthBusyTimer = 0;
  private quickBodySyncRaf = 0;
  private quickBodySyncPending = false;
  private quickResizeObserver: ResizeObserver | null = null;
  private quickPanelOpen = false;
  private quickModeBtn!: HTMLButtonElement;
  private quickVolume!: HTMLInputElement;
  private quickThumb!: HTMLDivElement;
  private quickTabBtns: Record<string, HTMLButtonElement> = {};
  private quickTab: 'cover' | 'lyrics' | 'settings' | 'airplay' | 'download' = 'cover';
  private quickBody!: HTMLDivElement;
  private quickBodyInner!: HTMLDivElement;
  private quickRenderKey = '';
  private quickLikeBtn: HTMLButtonElement | null = null;
  private lastQualityKey = '';
  private downloadQuickView: DownloadQueueView | null = null;
  private hostCommandBound = false;
  /** 迷你播放器（紧凑置顶小窗）：状态以宿主回推的 window/miniMode 事件为准。 */
  private miniMode = false;
  private miniBtn!: HTMLButtonElement;
  /** 迷你态切换过渡：宿主补间窗口期间页面先切「悬浮小卡」，等 window/miniMode 回推再落最终布局。 */
  private miniTransition: 'idle' | 'entering' | 'exiting' = 'idle';
  private miniFallbackTimer = 0;
  /** 无缝衔接准备就绪后，播放条上方短暂弹出的「将在 X 分 Y 秒后过渡至 xxx」提示。 */
  private seamlessHint!: HTMLDivElement;
  /** 倒计时弹窗的自动消失定时器。 */
  private seamlessHintTimer = 0;
  /** 本轮提示的标识（曲目 + 淡化起点 + 下一首），同一轮准备只弹一次。 */
  private seamlessHintKey = '';
  private appBgMode: AppBgMode = readAppBgMode();
  private appBgImage = readAppBgImage();
  private appBgEl!: HTMLDivElement;
  private appBgLayers: HTMLDivElement[] = [];
  private appBgLayer = 0;
  private appBgKey = '';
  private appBgHideTimer = 0;

  private readonly disposers = new Disposers();

  constructor() {
    // 控制色是整站主题的一部分：先按本机保存的颜色覆盖语义令牌，再建界面。
    applyAccentColor(readAccentColor());
    // 背景模糊度/取景位置也走 CSS 变量，先写入再挂载，避免首帧跳变。
    applyAppBgStyle();
    this.root = h('div', { class: 'app' });
    this.appBgEl = h('div', { class: 'app-bg' });
    // 每层写成「淡入淡出壳 + 固定模糊图片」：透明度动画在外层、模糊在内层，
    // 这样过渡期间模糊层不做重采样，结束时不会突然变糊。
    this.appBgLayers = [0, 1].map(() => {
      const fade = h('div', { class: 'app-bg-fade' });
      fade.append(h('div', { class: 'app-bg-layer' }));
      return fade;
    });
    this.appBgEl.append(...this.appBgLayers);
    this.root.append(this.appBgEl);
    this.stage = h('div', { class: 'stage' });
    this.wallHost = h('div', { class: 'wall' });
    this.wallHost.addEventListener('scroll', () => this.maybeLoadMoreWall(), { passive: true });
    this.buildTopbar();
    this.buildMain();
    this.buildPlayerBar();
    this.buildUpNext();
    this.upNextToast = createUpNextToast(() => next());
    this.root.append(this.upNextToast.element);
    // 自定义图片背景不依赖正在播放的歌曲，构造完成即可铺上。
    if (this.appBgMode === 'image') this.paintAppBg(null);
  }

  /* ------------------------------------------------------------------ */
  /* 挂载与启动                                                          */
  /* ------------------------------------------------------------------ */

  mount(container: HTMLElement): void {
    container.append(this.root);
    this.watchSegments();
    // 调试/自动化用：暴露只读播放状态，便于真机验证。
    (window as unknown as { __ziluxPlayer?: typeof playerState }).__ziluxPlayer = playerState;
    initDownloadQueue();
    this.bindHostCommands();
    // 提前绑定快捷键回执：宿主可能在用户打开设置页之前就推送注册结果。
    this.disposers.add(onShortcutsState(() => {}));
    // 迷你播放器：宿主回推窗口状态（含用户在系统层还原窗口的情况）。页面刷新后宿主会把当前
    // 迷你态重新推一次，所以这里不需要再用 localStorage 抢先请求（会和宿主的回推抢时序）。
    this.disposers.add(onMiniMode((enabled) => this.applyMiniMode(enabled)));
    const onMiniKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !this.miniMode || this.miniTransition !== 'idle') return;
      event.preventDefault();
      this.toggleMiniMode();
    };
    window.addEventListener('keydown', onMiniKey);
    this.disposers.add(() => window.removeEventListener('keydown', onMiniKey));
    this.disposers.add(() => this.clearMiniFallback());
    this.playerDispose = onPlayer((state) => this.syncPlayer(state));
    this.localDispose = onLocalLibraryChange(() => {
      if (this.wall.kind === 'local') {
        if (localLibrary()) this.showLocal();
        else this.renderWall();
      }
      this.updateRailBadges();
    });
    // 本地收藏变化：如果正停在「我喜欢的音乐」墙，就地刷新（融合墙要重新拼本地收藏）。
    this.disposers.add(
      subscribeLocalLikes(() => {
        if (this.wall.kind === 'liked' && !this.wallHost.classList.contains('is-hidden')) void this.showLiked();
      }),
    );
    onLocalResult((result) => toast(result.message, result.ok ? 'info' : 'error'));
    this.accountDispose = onAccountChange(() => this.syncAccount());
    this.settingsDispose = onSettingsChange(() => this.syncSettingsUi());
    // 睡眠定时：模块触发时统一在这里暂停（不依赖设置弹窗是否还开着）。
    const onSleepFired = () => {
      if (playerState().playing) toggle();
      toast('睡眠定时已到，已暂停播放');
    };
    window.addEventListener('zilux:sleep-timer-fired', onSleepFired);
    this.disposers.add(() => window.removeEventListener('zilux:sleep-timer-fired', onSleepFired));
    // 「播完当前曲」：曲末前 300ms 触发；其余模式由睡眠定时模块自己计时。
    window.setInterval(() => {
      const timer = getSleepTimerState();
      if (!timer.active || timer.mode !== 'track-end') return;
      const state = playerState();
      if (!state.playing || state.durationMs <= 0) return;
      if (state.positionMs >= state.durationMs - 300) completeSleepTimer();
    }, 500);
    initLocalLibrary();
    void this.bootData();
  }

  private async bootData(): Promise<void> {
    this.syncAccount();
    await this.showHome();
  }

  /**
   * 宿主托盘菜单 / 全局热键会通过页面消息下发播放指令：
   * {v:1,type:'command',action:'togglePlay'|'prev'|'next'}。
   * 这里只监听这一种消息，其它消息（host/mediaControl 等）仍由各自模块处理。
   */
  private bindHostCommands(): void {
    if (this.hostCommandBound) return;
    this.hostCommandBound = true;
    host.onMessage((message) => {
      if (message.type !== 'command') return;
      const action = typeof message.action === 'string' ? message.action : '';
      if (action === 'togglePlay') toggle();
      else if (action === 'prev') prev();
      else if (action === 'next') next();
      else return;
      host.log('info', `command ${action}`);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 顶栏                                                                */
  /* ------------------------------------------------------------------ */

  private buildTopbar(): void {
    const brand = h('div', { class: 'brand' }, h('div', { class: 'brand-name', text: 'ZILUX' }));
    brand.title = '回到首页';
    brand.style.cursor = 'pointer';
    brand.addEventListener('click', () => void this.showHome());

    this.searchInput = h('input', {
      class: 'search-dock-input',
      type: 'text',
      placeholder: '搜索歌曲、歌手（边打边搜）',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    this.searchInput.addEventListener('input', () => this.scheduleSearchPreview());
    this.searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.commitSearch();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.closeSearchDock();
      }
    });

    this.searchDock = h('div', { class: 'search-dock', 'data-open': 'false' });
    const dockIcon = h('span', { class: 'search-dock-icon' }, icon('search', 17));
    const dockHint = h('span', { class: 'search-dock-hint', text: '搜索' });
    const dockClear = h('button', { class: 'search-dock-close', title: '收起搜索' }, icon('close', 14));
    this.searchDock.append(dockIcon, dockHint, this.searchInput, dockClear);

    this.searchTabs = h('div', { class: 'search-tabs' });
    this.searchList = h('div', { class: 'search-list' });
    this.searchNote = h('div', { class: 'search-note', text: '输入关键词，边打边搜' });
    const searchAllBtn = h('button', { class: 'pill search-all', title: '查看全部结果（Enter）' }, icon('search', 15), h('span', { text: '查看全部' }));
    this.searchHistory = buildSearchHistoryPanel({
      onPick: (query: string) => {
        this.searchInput.value = query;
        this.openSearchDock();
        void this.commitSearch();
      },
    });
    this.searchPop = h(
      'div',
      { class: 'search-pop' },
      this.searchHistory.element,
      this.searchTabs,
      this.searchList,
      h('div', { class: 'search-foot' }, this.searchNote, searchAllBtn),
    );
    searchAllBtn.addEventListener('click', () => void this.commitSearch());
    const searchWrap = h('div', { class: 'search-wrap' }, this.searchDock, this.searchPop);
    this.searchDock.addEventListener('click', () => this.openSearchDock());
    dockClear.addEventListener('click', (event) => {
      event.stopPropagation();
      this.searchInput.value = '';
      this.closeSearchDock();
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.searchDockOpen) return;
      const target = event.target;
      if (target instanceof Node && searchWrap.contains(target)) return;
      this.closeSearchDock();
    });

    this.accountBtn = h('button', { class: 'account-btn account-stack', title: '账号', type: 'button' });
    this.accountBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.accountPanelOpen) this.closeAccountPanel();
      else this.openAccountPanel();
    });
    this.accountPanel = h('div', { class: 'account-panel' });
    this.accountWrap = h('div', { class: 'account-wrap' }, this.accountBtn, this.accountPanel);
    document.addEventListener('pointerdown', (event) => {
      if (!this.accountPanelOpen) return;
      const target = event.target;
      if (target instanceof Node && this.accountWrap.contains(target)) return;
      this.closeAccountPanel();
    });

    const winBtns = h(
      'div',
      { class: 'win-btns' },
      ...(['minimize', 'maximize', 'close'] as const).map((kind) => {
        const btn = h('button', {
          class: `win-btn${kind === 'close' ? ' is-close' : ''}`,
          title: kind === 'minimize' ? '最小化' : kind === 'maximize' ? '最大化' : '关闭',
        });
        btn.append(icon(WINDOW_ICON[kind], 14));
        btn.addEventListener('click', () => {
          if (kind === 'minimize') host.minimize();
          else if (kind === 'maximize') host.toggleMaximize();
          else host.close();
        });
        return btn;
      }),
    );

    const topbar = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'topbar-left' }, brand),
      h('div', { class: 'topbar-center' }, searchWrap),
      h('div', { class: 'topbar-right' }),
    );

    // 账号 + 窗口按钮：平时收在屏幕上方，鼠标靠近顶部时从顶部滑下一整条通栏（账号/窗口在右）。
    const peekBar = h(
      'div',
      { class: 'topbar-peekbar' },
      h('span', { class: 'peek-brand', text: 'ZILUX' }),
      h('div', { class: 'peek-right' }, this.accountWrap, winBtns),
    );
    const peek = h('div', { class: 'top-peek' });
    let peekTimer = 0;
    const showPeek = (): void => {
      window.clearTimeout(peekTimer);
      topbar.classList.add('is-peek');
      this.root.classList.add('is-topbar-peek');
    };
    const hidePeek = (): void => {
      window.clearTimeout(peekTimer);
      peekTimer = window.setTimeout(() => {
        if (peekBar.matches(':hover') || peekBar.contains(document.activeElement)) return;
        if (this.accountPanelOpen) return;
        topbar.classList.remove('is-peek');
        this.root.classList.remove('is-topbar-peek');
      }, 420);
    };
    peek.addEventListener('pointerenter', showPeek);
    peek.addEventListener('pointerleave', hidePeek);
    peekBar.addEventListener('pointerenter', showPeek);
    peekBar.addEventListener('pointerleave', hidePeek);
    this.root.append(peek);
    this.root.append(peekBar);

    // 拖动窗口：透明顶栏后改由根节点统一接管顶部这条空白带，
    // 从窗口最上沿到搜索框之间任意空白处都能拖，不影响下方内容与控件。
    this.root.addEventListener('pointerdown', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (event.button !== 0) return;
      if (event.clientY > 84) return;
      if (
        target.closest(
          'button, input, textarea, select, .win-btns, .pill, .rail, .sheet, .lyrics-view, .playerbar, .upnext, .quick, .account-wrap',
        )
      ) {
        return;
      }
      host.drag();
    });

    this.root.append(topbar);

    // 无边框窗口的边缘缩放：WebView2 铺满后系统收不到 WM_NCHITTEST，
    // 所以由页面在 6px 边缘热区拦下 pointerdown，让宿主把指针交回系统缩放循环。
    const edges: Array<['left' | 'right' | 'top' | 'bottom', string]> = [
      ['top', 'nwse-resize'],
      ['bottom', 'nwse-resize'],
      ['left', 'ew-resize'],
      ['right', 'ew-resize'],
    ];
    for (const [edge, cursor] of edges) {
      const zone = h('div', { class: `edge-resize is-${edge}` });
      zone.style.cursor = cursor;
      zone.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        host.resize(edge);
      });
      this.root.append(zone);
    }

    // 投送：只把本软件音频送去 AirPlay（页面侧取流 + 本地静音），系统其他应用不受影响。
    airplay.subscribe((snapshot) => {
      if (snapshot.state === 'connecting' || snapshot.state === 'streaming') {
        void startAudioTap();
      } else {
        stopAudioTap();
      }
    });
    // 页面记住的接收端延迟（可自定义，见投送面板）启动时同步给宿主，宿主默认 300ms。
    airplay.syncLatency();
  }

  /* ------------------------------------------------------------------ */
  /* 主体：rail + stage                                                  */
  /* ------------------------------------------------------------------ */

  private buildMain(): void {
    const rail = h('nav', { class: 'rail' });
    let railCloseTimer = 0;
    const openRail = (): void => {
      window.clearTimeout(railCloseTimer);
      rail.classList.add('is-open');
    };
    const closeRail = (): void => {
      window.clearTimeout(railCloseTimer);
      railCloseTimer = window.setTimeout(() => {
        if (!rail.matches(':focus-within')) rail.classList.remove('is-open');
      }, 90);
    };
    rail.addEventListener('pointerenter', openRail);
    rail.addEventListener('pointerleave', closeRail);
    rail.addEventListener('focusin', openRail);
    rail.addEventListener('focusout', closeRail);
    const items: Array<{ key: string; label: string; iconName: string; onClick: () => void }> = [
      { key: 'home', label: '首页', iconName: 'home', onClick: () => void this.showHome() },
      { key: 'liked', label: '我喜欢的音乐', iconName: 'heart', onClick: () => void this.showLiked() },
      { key: 'recent', label: '最近播放', iconName: 'clock', onClick: () => void this.showRecentWall() },
      { key: 'recommend', label: '推荐', iconName: 'sparkle', onClick: () => void this.openRecommendSheet() },
      { key: 'discover', label: '发现', iconName: 'compass', onClick: () => void this.showDiscover() },
      { key: 'playlists', label: '我的歌单', iconName: 'list', onClick: () => void this.openPlaylistSheet() },
      { key: 'local', label: '本地曲库', iconName: 'folder', onClick: () => this.showLocal() },
      { key: 'airplay', label: '投送', iconName: 'airplay', onClick: () => this.toggleAirplayPop() },
    ];
    for (const item of items) {
      const btn = h(
        'button',
        { class: 'rail-btn', title: item.label, 'aria-label': item.label },
        h('span', { class: 'rail-icon' }, icon(item.iconName, 20)),
        h('span', { class: 'rail-label', text: item.label }),
      );
      btn.addEventListener('click', () => item.onClick());
      // 「我喜欢的音乐」与「最近播放」支持双击直接开播：单击仍然只是进入页面。
      if (item.key === 'liked' || item.key === 'recent') {
        btn.title = `${item.label}（双击直接播放）`;
        btn.addEventListener('dblclick', () => void this.playRailList(item.key as 'liked' | 'recent'));
      }
      this.railButtons.set(item.key, btn);
      rail.append(btn);
    }
    rail.append(h('div', { class: 'rail-spacer' }));
    const settingsBtn = h(
      'button',
      { class: 'rail-btn', title: '设置', 'aria-label': '设置' },
      h('span', { class: 'rail-icon' }, icon('sliders', 20)),
      h('span', { class: 'rail-label', text: '设置' }),
    );
    settingsBtn.addEventListener('click', () => this.openSettingsSheet());
    this.railButtons.set('settings', settingsBtn);
    rail.append(settingsBtn);

    this.homeHost = h('div', { class: 'home-host' });
    this.home = new HomeView({
      onLogin: () => this.openLogin(),
      onLiked: (source) => void this.showLiked(source),
      onPlayLiked: (source) => void this.playLikedAll(source),
      onRecent: () => void this.showRecentWall(),
      onRecommend: () => void this.openRecommendSheet(),
      onDaily: () => void this.showDailyWall(),
      onDaily30: () => void this.showDailyWall(true),
      onRadar: () => void this.showRadarWall(),
      onSearch: () => this.focusSearch(),
      onPlay: (tracks, index, scope) => this.playFromHome(tracks, index, scope),
      onPlaylist: (item) => void this.showPlaylist(item),
    });
    this.homeHost.append(this.home.root);
    const main = h('div', { class: 'main' }, rail, this.stage);
    this.stage.append(this.homeHost, this.wallHost);
    this.root.append(main);
  }

  private setRailActive(
    kind: WallKind | 'settings' | 'home' | 'discover' | 'daily' | 'daily30' | null,
  ): void {
    const activeKey: string | null =
      kind === 'playlist'
        ? 'playlists'
        : kind === 'feed'
          ? this.feedRailKey
          : kind === 'daily'
            ? null
            : kind;
    this.railButtons.forEach((btn, key) => {
      btn.classList.toggle('is-active', key === activeKey);
    });
  }

  private updateRailBadges(): void {
    const localBtn = this.railButtons.get('local');
    if (!localBtn) return;
    const lib = localLibrary();
    localBtn.title = lib ? `本地曲库 · ${lib.entries.length} 首` : '本地曲库';
  }

  /* ------------------------------------------------------------------ */
  /* 首页                                                                */
  /* ------------------------------------------------------------------ */

  private preferredSource(): OnlineSource | null {
    const logged = getAccounts().filter((item) => item.loggedIn);
    const chosen = logged.find((item) => item.source === 'netease') ?? logged[0];
    return (chosen?.source as OnlineSource | undefined) ?? null;
  }

  private async showHome(): Promise<void> {
    this.wallPager = null;
    this.closeLyrics();
    this.homeHost.classList.remove('is-hidden');
    this.wallHost.classList.add('is-hidden');
    this.setRailActive('home');
    await this.loadHomeData();
  }

  /* ------------------------------------------------------------------ */
  /* 发现                                                                */
  /* ------------------------------------------------------------------ */

  /** rail「发现」：在 wallHost 里渲染发现页（排行榜 / 歌单广场 / 漫游 / 播客 / 收藏）。 */
  private async showDiscover(): Promise<void> {
    this.wallPager = null;
    this.closeLyrics();
    this.homeHost.classList.add('is-hidden');
    this.wallHost.classList.remove('is-hidden');
    this.setRailActive('discover');
    if (!this.discover) {
      this.discover = new DiscoverView(this.wallHost, {
        play: (tracks, index) => playQueue(tracks, index, true),
        openPlaylist: (item) => void this.showPlaylist(item),
        openSheet: (title, build) => this.openSheet(title, build),
        search: (query) => void this.runDiscoverSearch(query),
      });
    }
    await this.discover.show();
  }

  /** 发现页里点播客：把节目名填进搜索框，展开成搜索墙。 */
  private async runDiscoverSearch(query: string): Promise<void> {
    const keyword = query.trim();
    if (!keyword) return;
    this.searchInput.value = keyword;
    await this.commitSearch();
  }

  private async loadHomeData(): Promise<void> {
    const loggedIn = getAccounts().some((item) => item.loggedIn);
    const preferred = this.preferredSource();
    const collections: HomeCollection[] = [];
    const playlists: LibraryPlaylist[] = [];
    const neteasePlaylists: LibraryPlaylist[] = [];
    if (loggedIn) {
      try {
        const overview = await fetchLibraryOverview();
        const states = new Map(overview.sources.map((state) => [state.source, state] as const));
        const likedSources: OnlineSource[] = ['netease', 'qq'];
        const loaded = await Promise.all(
          likedSources.map(async (source) => {
            const state = states.get(source);
            if (!state?.loggedIn) return null;
            const liked = state.liked;
            const base: HomeCollection = {
              source,
              label: source === 'netease' ? '网易云收藏' : 'QQ 音乐收藏',
              kicker: `${source === 'netease' ? '网易云音乐' : 'QQ 音乐'} · 我喜欢的音乐`,
              loggedIn: true,
              count: liked?.count ?? 0,
              tracks: [],
            };
            if (liked) {
              try {
                const detail = await fetchPlaylist(source, liked.id, 0, 5, 'liked');
                base.tracks = detail.tracks.slice(0, 5);
              } catch (err) {
                console.warn('[app] home collection tracks failed', source, err);
              }
            }
            return base;
          }),
        );
        for (const item of loaded) if (item) collections.push(item);
      } catch (err) {
        console.warn('[app] home overview failed', err);
      }
    }
    try {
      const hot = await fetchHotPlaylists('qq', 14);
      playlists.push(
        ...hot.map((item) => ({
          source: item.source,
          id: item.id,
          title: item.title,
          cover: item.cover,
          count: item.count,
          creator: item.creator,
        })),
      );
    } catch (err) {
      console.warn('[app] hot playlists failed', err);
    }
    try {
      const hotNetease = await fetchHotPlaylists('netease', 14);
      neteasePlaylists.push(
        ...hotNetease.map((item) => ({
          source: item.source,
          id: item.id,
          title: item.title,
          cover: item.cover,
          count: item.count,
          creator: item.creator,
        })),
      );
    } catch (err) {
      console.warn('[app] netease hot playlists failed', err);
    }
    let recent: OnlineTrack[] = [];
    try {
      recent = (await fetchRecentMerged(160)).slice(0, 160);
    } catch (err) {
      console.warn('[app] home recent failed', err);
    }
    if (recent.length === 0 && preferred) {
      try {
        recent = (await fetchFeed(preferred, 'recent', 14)).tracks;
      } catch (err) {
        console.warn('[app] home recent fallback failed', err);
      }
    }
    let daily: OnlineTrack[] = [];
    let dailyLabel = preferred ? SOURCE_LABEL[preferred] : '';
    try {
      const merged = await this.fetchDailyMerged(12);
      if (merged.tracks.length > 0) {
        daily = merged.tracks;
        dailyLabel = merged.label;
      }
    } catch (err) {
      console.warn('[app] home daily failed', err);
    }
    let radar: OnlineTrack[] = [];
    let radarAvailable = false;
    try {
      radarAvailable =
        getAccounts().some((item) => item.loggedIn && item.source === 'netease') &&
        (sourceMeta('netease')?.feedKinds ?? []).includes('radar');
    } catch {
      radarAvailable = false;
    }
    if (radarAvailable) {
      try {
        radar = (await fetchFeed('netease', 'radar', 12)).tracks;
      } catch (err) {
        console.warn('[app] private radar failed', err);
      }
    }
    const local = localLibrary();
    const now = new Date();
    const dailyDate = `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 每天 6:00 更新`;
    const data: HomeData = {
      loggedIn,
      collections,
      localCount: local?.entries.length ?? 0,
      dailySource: dailyLabel,
      dailyDate,
      dailyLoading: false,
      daily,
      radarAvailable,
      radarLoading: false,
      radar,
      recent,
      playlists: playlists.slice(0, 14),
      neteasePlaylists: neteasePlaylists.slice(0, 14),
    };
    this.homeData = data;
    this.home.update(data);
  }

  /** 首页「最近播放」即时更新：刚播的歌放到最前（回到首页时再以宿主记录为准）。 */
  private noteRecentPlay(track: OnlineTrack): void {
    const data = this.homeData;
    if (!data) return;
    const key = `${track.source}:${track.id}`;
    const recent = [track, ...data.recent.filter((item) => `${item.source}:${item.id}` !== key)].slice(0, 160);
    const next: HomeData = { ...data, recent };
    this.homeData = next;
    if (!this.homeHost.classList.contains('is-hidden')) this.home.update(next);
  }

  /** 把多个平台的今日推荐按轮次交错合并（同一平台不会连续刷屏）。 */
  private interleaveDaily(lists: OnlineTrack[][]): OnlineTrack[] {
    const merged: OnlineTrack[] = [];
    const seen = new Set<string>();
    const longest = Math.max(0, ...lists.map((list) => list.length));
    for (let index = 0; index < longest; index += 1) {
      for (const list of lists) {
        const item = list[index];
        if (!item) continue;
        const key = `${item.source}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(item);
      }
    }
    return merged;
  }

  /** 取所有已登录平台的今日推荐并合并；返回轨道 + 展示用的平台名。 */
  private async fetchDailyMerged(limitPerSource: number): Promise<{ tracks: OnlineTrack[]; label: string; sources: string[] }> {
    const known = sourceIds();
    const sources = getAccounts()
      .filter((item) => item.loggedIn && known.includes(item.source))
      // 只合并真正提供「每日推荐」流的平台（酷狗等无推荐流的平台跳过，避免空请求）。
      .filter((item) => (sourceMeta(item.source)?.feedKinds ?? []).includes('daily'))
      .map((item) => item.source);
    if (sources.length === 0) return { tracks: [], label: '', sources: [] };
    const lists = await Promise.all(
      sources.map(async (source) => {
        try {
          return (await fetchFeed(source, 'daily', limitPerSource)).tracks;
        } catch (err) {
          console.warn('[app] daily source failed', source, err);
          return [] as OnlineTrack[];
        }
      }),
    );
    const labels = sources
      .filter((_source, index) => lists[index].length > 0)
      .map((source) => sourceMeta(source)?.label ?? SOURCE_LABEL[source] ?? source);
    return {
      tracks: this.interleaveDaily(lists),
      label: labels.length > 0 ? labels.join(' + ') : '',
      sources: sources.filter((_source, index) => lists[index].length > 0),
    };
  }

  private async showRecentWall(): Promise<void> {
    this.wallPager = null;
    this.setRailActive('recent');
    this.wall = { kind: 'recent', title: '最近播放', subtitle: '多平台融合 · 同步中…', tracks: [] };
    this.renderWall();
    try {
      const merged = await fetchRecentMerged(300);
      if (merged.length > 0) {
        this.wall = {
          kind: 'recent',
          title: '最近播放',
          subtitle: `多平台融合 · ${merged.length} 首`,
          tracks: merged,
        };
        this.renderWall();
        return;
      }
      const source = this.preferredSource();
      if (!source) {
        toast('登录后才有最近播放');
        this.openLogin();
        return;
      }
      const feed = await fetchFeed(source, 'recent', 100);
      this.wall = {
        kind: 'recent',
        title: '最近播放',
        subtitle: `${SOURCE_LABEL[source]} · ${feed.tracks.length} 首`,
        tracks: feed.tracks,
      };
      this.renderWall();
    } catch (err) {
      console.warn('[app] recent wall failed', err);
      toast('最近播放读取失败', 'error');
    }
  }

  private async showDailyWall(qqDaily = false): Promise<void> {
    this.wallPager = null;
    const title = qqDaily ? '每日 30 首' : '今日推荐';
    this.feedRailKey = qqDaily ? 'daily30' : '';
    this.setRailActive(qqDaily ? 'daily30' : 'daily');

    if (qqDaily) {
      const source: OnlineSource = ((sourceIds() as OnlineSource[]).find((item) => sourceHasDaily30(item)) ??
        this.preferredSource() ??
        'qq') as OnlineSource;
      if (!getAccounts().some((item) => item.loggedIn && item.source === source)) {
        toast(`登录${SOURCE_LABEL[source]}后才能看`);
        this.openLogin(source as AccountSource);
        return;
      }
      this.wall = { kind: 'feed', title, subtitle: `${SOURCE_LABEL[source]} · 同步中…`, tracks: [] };
      this.renderWall();
      try {
        const feed = await fetchFeed(source, 'daily', 30);
        this.wall = { kind: 'feed', title, subtitle: `${SOURCE_LABEL[source]} · ${feed.tracks.length} 首`, tracks: feed.tracks };
        this.renderWall();
      } catch (err) {
        console.warn('[app] daily failed', err);
        toast('每日推荐读取失败', 'error');
      }
      return;
    }

    // 多平台合并的今日推荐
    const merged = await this.fetchDailyMerged(60);
    if (merged.tracks.length === 0) {
      toast('登录后才有今日推荐');
      this.openLogin();
      return;
    }
    this.wall = {
      kind: 'feed',
      title,
      subtitle: `${merged.label || '多平台'} · ${merged.tracks.length} 首`,
      tracks: merged.tracks,
    };
    this.renderWall();
  }

  private async showRadarWall(): Promise<void> {
    this.wallPager = null;
    this.feedRailKey = '';
    this.setRailActive('daily');
    this.wall = { kind: 'feed', title: '私人雷达', subtitle: '网易云 · 同步中…', tracks: [] };
    this.renderWall();
    try {
      const feed = await fetchFeed('netease', 'radar', 120);
      this.wall = {
        kind: 'feed',
        title: '私人雷达',
        subtitle: `网易云 · ${feed.tracks.length} 首 · 每天 6:00 更新`,
        tracks: feed.tracks,
      };
      this.renderWall();
    } catch (err) {
      console.warn('[app] radar wall failed', err);
      toast('私人雷达读取失败', 'error');
    }
  }

  private async openRecommendSheet(): Promise<void> {
    const ref: { body: HTMLDivElement | null } = { body: null };
    this.openSheet('热门歌单', (body) => {
      ref.body = body;
      body.append(h('div', { class: 'empty', text: '加载 QQ 音乐热门歌单…' }));
    });
    try {
      const hot = await fetchHotPlaylists('qq', 40);
      const body = ref.body;
      if (!body) return;
      body.textContent = '';
      if (hot.length === 0) {
        body.append(h('div', { class: 'empty', text: '暂时拿不到热门歌单，稍后重试' }));
        return;
      }
      body.append(h('h3', { class: 'section-title', text: `QQ 音乐 · 音乐馆热门歌单 · ${hot.length} 个` }));
      const list = h('div', { class: 'list' });
      hot.forEach((item) => {
        const cover =
          item.cover ||
          onlineArtwork({ id: item.id, title: item.title, artist: item.creator ?? '', album: '', cover: '' });
        const row = h(
          'div',
          { class: 'row', title: item.title },
          h('div', { class: 'row-cover' }, h('img', { src: cover, loading: 'lazy', alt: '' })),
          h(
            'div',
            { class: 'row-meta' },
            h('div', { class: 'row-name', text: item.title }),
            h('div', { class: 'row-artist', text: `${item.creator ? item.creator + ' · ' : ''}${formatPlays(item.count)}` }),
          ),
        );
        row.addEventListener('click', () => {
          this.sheet?.close();
          void this.showPlaylist({
            source: item.source,
            id: item.id,
            title: item.title,
            cover: item.cover,
            count: item.count,
            creator: item.creator,
          });
        });
        list.append(row);
      });
      body.append(list);
    } catch (err) {
      console.warn('[app] recommend failed', err);
      const body = ref.body;
      if (body) {
        body.textContent = '';
        body.append(h('div', { class: 'empty', text: '热门歌单读取失败，稍后重试' }));
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 墙面                                                                */
  /* ------------------------------------------------------------------ */

  private renderWall(skipEnter = false): void {
    this.closeLyrics();
    this.homeHost.classList.add('is-hidden');
    this.wallHost.classList.remove('is-hidden');
    // 只有整页进入 / 换页时才播挂载动画；流式搜索每批 renderWall(true) 不再重放。
    this.wallHost.classList.toggle('is-fresh', !skipEnter);
    if (!skipEnter) window.setTimeout(() => this.wallHost.classList.remove('is-fresh'), 620);
    this.wallHost.textContent = '';
    const { title, subtitle, tracks } = this.wall;
    const actions: HTMLElement[] = [];
    if (this.wall.kind !== 'search' && tracks.length > 0 && !this.isLocalArtistGrid()) {
      const seg = h('div', { class: 'seg seg-sm layout-modes' });
      ([['grid', '网格'], ['list', '横条']] as Array<[PosterLayout, string]>).forEach(([id, label]) => {
        const btn = h('button', {
          class: `seg-btn${this.wallLayout === id ? ' is-on' : ''}`,
          text: label,
          title: id === 'grid' ? '封面网格' : '横条列表（同搜索结果）',
        });
        btn.addEventListener('click', () => {
          if (this.wallLayout === id) return;
          this.wallLayout = id;
          writePosterLayout(id);
          // skipEnter：网格不再自己播入场动画，只靠下面的 is-swap 过渡，否则会看起来刷新两次。
          this.renderWall(true);
          // 视图切换的过渡：重新挂动画类，触发淡入/上浮
          this.wallHost.classList.remove('is-swap');
          void this.wallHost.offsetWidth;
          this.wallHost.classList.add('is-swap');
          window.setTimeout(() => this.wallHost.classList.remove('is-swap'), 520);
        });
        seg.append(btn);
      });
      actions.push(seg);
    }
    if (this.wall.kind === 'liked') {
      const modes: Array<{ id: 'all' | OnlineSource; label: string }> = [{ id: 'all', label: '融合' }];
      for (const account of getAccounts()) {
        if (!account.loggedIn) continue;
        // 酷狗等没有「我喜欢的音乐」曲库的平台不参与喜欢墙的平台切换。
        if (!sourceSupportsLikedWrite(account.source)) continue;
        modes.push({ id: account.source as OnlineSource, label: sourceMeta(account.source).short });
      }
      if (modes.length > 1) {
        const seg = h('div', { class: 'seg seg-sm liked-modes' });
        modes.forEach((mode) => {
          const btn = h('button', {
            class: `seg-btn${this.likedMode === mode.id ? ' is-on' : ''}`,
            text: mode.label,
            title: mode.id === 'all' ? '多平台融合显示' : `${sourceMeta(mode.id).label} 的喜欢`,
          });
          btn.addEventListener('click', () => {
            if (this.likedMode === mode.id) return;
            void this.showLiked(mode.id);
          });
          seg.append(btn);
        });
        actions.push(seg);
      }
    }
    if (this.wall.kind === 'local') {
      if (this.localArtistFilter !== null) {
        const back = h('button', { class: 'pill', title: '返回本地曲库' }, icon('prev', 15), h('span', { text: '返回' }));
        back.addEventListener('click', () => {
          this.localArtistFilter = null;
          this.showLocal();
        });
        actions.push(back);
      } else {
        const modes = h('div', { class: 'seg seg-sm local-modes' });
        ([['songs', '歌曲'], ['artists', '歌手']] as Array<['songs' | 'artists', string]>).forEach(([id, label]) => {
          const btn = h('button', {
            class: `seg-btn${this.localMode === id ? ' is-on' : ''}`,
            text: label,
            title: id === 'songs' ? '按歌曲浏览本地曲库' : '按歌手浏览本地曲库',
          });
          btn.addEventListener('click', () => {
            if (this.localMode === id) return;
            this.localMode = id;
            this.renderWall(true);
          });
          modes.append(btn);
        });
        actions.push(modes);
      }
      const folder = h('button', { class: 'pill', title: '在资源管理器中打开当前本地歌曲文件夹' }, icon('folder', 16), h('span', { text: '打开文件夹' }));
      folder.addEventListener('click', () => openLocalFolder());
      actions.push(folder);
      const refresh = h('button', { class: 'pill', title: '重新扫描本地/下载目录' }, icon('refresh', 16), h('span', { text: '刷新' }));
      refresh.addEventListener('click', () => {
        host.rescanLocalMusic();
        toast('正在重新扫描本地曲库…');
      });
      actions.push(refresh);
    }
    if (this.wall.kind === 'playlist' && this.wall.playlistId) {
      const addBtn = h('button', { class: 'pill', title: '从本地曲库挑选歌曲加入这个歌单' }, icon('plus', 16), h('span', { text: '添加歌曲' }));
      addBtn.addEventListener('click', () => this.openPlaylistAddSheet(this.wall.playlistId as string));
      actions.push(addBtn);
    }
    if (tracks.length > 0) {
      const btn = h('button', { class: 'pill', title: '播放全部' }, icon('play', 16), h('span', { text: '播放全部' }));
      btn.addEventListener('click', () => playQueue(tracks, 0, true));
      actions.push(btn);
    }
    const head = h(
      'div',
      { class: 'wall-head' },
      h(
        'div',
        {},
        h('h1', { class: 'wall-title', text: title }),
        subtitle ? h('div', { class: 'wall-sub', text: subtitle }) : null,
      ),
      actions.length > 0 ? h('div', { class: 'wall-head-actions' }, ...actions) : null,
    );
    this.wallHost.append(head);

    // 本地曲库「歌手」视图：圆形头像网格，点进去看该歌手的本地歌曲。
    if (this.wall.kind === 'local' && this.isLocalArtistGrid()) {
      this.wallHost.append(this.buildLocalArtistGrid(skipEnter));
      return;
    }
    // 本地艺术家详情页：顶部头像 + 简介式信息，下面照常渲染歌曲。
    if (this.wall.kind === 'local' && this.localArtistFilter !== null) {
      const artist = localArtists().find((item) => item.name === this.localArtistFilter);
      if (artist) this.wallHost.append(this.buildLocalArtistHero(artist));
    }

    // 搜索结果：一行一首（封面/歌名/作者/VIP/平台/收藏），不再用大海报网格。
    if (this.wall.kind === 'search') {
      this.wallHost.append(
        tracks.length === 0
          ? h('div', { class: 'search-empty', text: skipEnter ? '正在搜索…' : '没有找到相关歌曲' })
          : this.buildSearchList(tracks),
      );
      if (tracks.length > 0) void this.prefetchSearchLiked(tracks);
      return;
    }

    if (tracks.length === 0) {
      const hint =
        this.wall.kind === 'local'
          ? '选择本地歌曲文件夹后，会在这里生成海报墙'
          : this.wall.kind === 'liked'
            ? '还没有同步到「我喜欢的音乐」\n登录网易云 / QQ 音乐后会自动填充'
            : '没有结果';
      this.wallHost.append(h('div', { class: 'wall-empty', text: hint }));
      return;
    }

    if (this.wallLayout === 'list') {
      this.wallHost.append(this.buildSearchList(tracks));
      if (this.wall.kind !== 'liked') void this.prefetchSearchLiked(tracks);
      return;
    }

    const grid = h('div', { class: `wall-grid${skipEnter ? '' : ' is-reveal'}` });
    this.appendPosters(grid, tracks, 0, tracks);
    this.wallHost.append(grid);
  }

  /** 生成一张封面海报（首次渲染与分页追加共用）。 */
  private posterNode(track: OnlineTrack, index: number, queue: OnlineTrack[]): HTMLElement {
    const coverImg = h('img', { src: onlineArtwork(track), loading: 'eager' });
    if (!track.cover) {
      void lookupCover(track).then((found) => {
        if (!found) return;
        track.cover = found;
        coverImg.src = onlineArtwork(track);
      });
    }
    const current = playerState().track;
    const poster = h(
      'div',
      { class: `poster${current && current.id === track.id ? ' is-playing' : ''}`, title: `${track.title} — ${track.artist}` },
      coverImg,
      h('div', { class: 'poster-badge', text: String(index + 1).padStart(2, '0') }),
      this.wall.kind === 'search' || (this.wall.kind === 'liked' && this.likedMode === 'all')
        ? h('div', {
            class: 'poster-src',
            style: `--src-accent:${sourceMeta(track.source).accent}`,
            text: sourceMeta(track.source).short,
          })
        : null,
      h('div', { class: 'poster-foot' }, h('div', { class: 'poster-name', text: track.title }), h('div', { class: 'poster-artist', text: track.artist || '未知歌手' })),
    );
    const playBtn = h('button', { class: 'poster-play', title: '播放' }, icon('play', 18));
    playBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      playQueue(queue, index, true);
    });
    poster.append(playBtn);
    if (this.wall.kind === 'local' || track.source === 'local') {
      const actions = h('div', { class: 'poster-actions' });
      const reveal = h('button', { class: 'poster-action', type: 'button', title: '在文件夹中显示' });
      reveal.append(icon('folder', 15));
      reveal.addEventListener('click', (event) => {
        event.stopPropagation();
        revealLocalTrack(track);
      });
      const more = h('button', { class: 'poster-action', type: 'button', title: '更多操作' });
      more.append(icon('more', 15));
      more.addEventListener('click', (event) => {
        event.stopPropagation();
        this.openLocalTrackActions(track);
      });
      const del = h('button', { class: 'poster-action is-danger', type: 'button', title: '删除到回收站' });
      del.append(icon('trash', 15));
      del.addEventListener('click', (event) => {
        event.stopPropagation();
        this.confirmDeleteLocal([track]);
      });
      actions.append(reveal, more, del);
      poster.append(actions);
    }
    poster.addEventListener('click', () => playQueue(queue, index, true));
    return poster;
  }

  private appendPosters(grid: HTMLElement, tracks: OnlineTrack[], startIndex: number, queue: OnlineTrack[]): void {
    tracks.forEach((track, offset) => {
      grid.append(this.posterNode(track, startIndex + offset, queue));
    });
  }

  /** 墙面滚动接近底部时自动拉下一页。 */
  private maybeLoadMoreWall(): void {
    const pager = this.wallPager;
    if (!pager || !pager.hasMore || this.wallLoadingMore) return;
    const host = this.wallHost;
    if (host.scrollTop + host.clientHeight < host.scrollHeight - 700) return;
    void this.loadMoreWall();
  }

  /** 用首页概览里各平台的「我喜欢的音乐」歌单 id 建分页器。 */
  private async primeLikedPager(sources: OnlineSource[], offset: number): Promise<void> {
    try {
      const overview = await fetchLibraryOverview();
      const entries: WallPagerEntry[] = [];
      for (const source of sources) {
        const state = overview.sources.find((item) => item.source === source);
        if (state?.liked) entries.push({ source, id: state.liked.id, special: 'liked' });
      }
      this.wallPager = entries.length > 0 ? { entries, offset, pageSize: 200, hasMore: offset >= 200 } : null;
    } catch (err) {
      console.warn('[app] prime liked pager failed', err);
      this.wallPager = null;
    }
  }

  private async loadMoreWall(): Promise<void> {
    const pager = this.wallPager;
    if (!pager || !pager.hasMore || this.wallLoadingMore) return;
    const entries = pager.entries.filter((entry) => entry.id.length > 0);
    if (entries.length === 0) return;
    this.wallLoadingMore = true;
    try {
      const offset = pager.offset;
      const pages = await Promise.all(
        entries.map(async (entry) => {
          try {
            return await fetchPlaylist(entry.source, entry.id, offset, pager.pageSize, entry.special === 'liked' ? 'liked' : undefined);
          } catch (err) {
            console.warn('[app] load more failed', entry.source, err);
            return null;
          }
        }),
      );
      const known = new Set(this.wall.tracks.map((item) => `${item.source}:${item.id}`));
      const fresh: OnlineTrack[] = [];
      const push = (track: OnlineTrack | undefined): void => {
        if (!track) return;
        const key = `${track.source}:${track.id}`;
        if (known.has(key)) return;
        known.add(key);
        fresh.push(track);
      };
      if (pages.length === 1) {
        for (const track of pages[0]?.tracks ?? []) push(track);
      } else {
        const longest = Math.max(0, ...pages.map((page) => page?.tracks.length ?? 0));
        for (let index = 0; index < longest; index += 1) {
          for (const page of pages) push(page?.tracks[index]);
        }
      }
      pager.offset = offset + pager.pageSize;
      pager.hasMore = pages.some((page) => (page?.hasMore ?? false) || (page?.tracks.length ?? 0) >= pager.pageSize);
      if (fresh.length === 0) return;
      this.wall.tracks.push(...fresh);
      if (this.wallLayout === 'list') {
        this.wallHost.querySelector('.track-list')?.remove();
        this.wallHost.append(this.buildSearchList(this.wall.tracks));
      } else {
        const grid = this.wallHost.querySelector('.wall-grid');
        if (grid) this.appendPosters(grid as HTMLElement, fresh, this.wall.tracks.length - fresh.length, this.wall.tracks);
      }
      const sub = this.wallHost.querySelector('.wall-sub');
      if (sub) {
        const text = sub.textContent ?? '';
        const count = this.wall.tracks.length;
        sub.textContent = /\d+\s*首/.test(text) ? text.replace(/\d+\s*首/, `${count} 首`) : `${text} · ${count} 首`;
      }
    } finally {
      this.wallLoadingMore = false;
    }
  }

  private async showLiked(mode?: 'all' | OnlineSource): Promise<void> {
    this.wallPager = null;
    if (mode) this.likedMode = mode;
    this.setRailActive('liked');
    const label = this.likedMode === 'all' ? '多平台融合' : SOURCE_LABEL[this.likedMode];
    // 没登录任何平台时也把本地收藏显示出来（本地收藏独立存在 localStorage）。
    const anyOnline = getAccounts().some((account) => account.loggedIn);
    const localKeys = likedLocalKeys();
    if (!anyOnline) {
      this.wall = {
        kind: 'liked',
        title: '我喜欢的音乐',
        subtitle: localKeys.length > 0 ? `本地收藏 · ${localKeys.length} 首 · 登录后可同步在线平台` : '尚未登录在线平台',
        tracks: tracksOfKeys(localKeys),
      };
      this.renderWall();
      return;
    }
    // 不先渲染「同步中」占位：否则进入/切平台时会先闪一次空网格再闪一次结果。
    this.wall = { kind: 'liked', title: '我喜欢的音乐', subtitle: `${label} · 同步中…`, tracks: [] };
    if (this.likedMode === 'all') await this.loadLikedMerged();
    else await this.loadLiked(this.likedMode);
    this.mergeLocalLikesIntoWall();
  }

  /** 把本地收藏的歌合并进「我喜欢的音乐」融合墙（本地收藏与在线收藏互不影响）。 */
  private mergeLocalLikesIntoWall(): void {
    if (this.wall.kind !== 'liked') return;
    const localTracks = tracksOfKeys(likedLocalKeys());
    if (localTracks.length === 0) return;
    const seen = new Set(this.wall.tracks.map((track) => `${track.source}:${track.id}`));
    const added: OnlineTrack[] = [];
    for (const track of localTracks) {
      const key = `${track.source}:${track.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      added.push(track);
    }
    if (added.length === 0) return;
    const tracks = this.wall.tracks.concat(added);
    this.wall = {
      ...this.wall,
      subtitle: `${this.wall.subtitle} · 含本地收藏 ${added.length} 首`,
      tracks,
    };
    this.renderWall(true);
  }

  /** 用一个平台拉「我喜欢的音乐」（带缓存）。返回 null 表示该平台不可用。 */
  private async playLikedAll(preferred?: OnlineSource): Promise<void> {
    const modes = preferred
      ? (sourceSupportsLikedWrite(preferred) ? [preferred] : [])
      : this.likedMode === 'all'
        ? sourceIds().filter((id) => sourceSupportsLikedWrite(id))
        : [this.likedMode];
    let tracks: OnlineTrack[] = [];
    for (const source of modes) {
      const list = await this.fetchLikedTracks(source);
      if (list && list.length > 0) tracks = tracks.concat(list);
    }
    if (tracks.length === 0) tracks = this.homeData?.collections.flatMap((item) => item.tracks).slice(0, 30) ?? [];
    if (tracks.length === 0) {
      toast('收藏列表还没有歌曲', 'error');
      return;
    }
    playQueue(tracks, 0);
  }

  /** rail 双击快捷播放：先进入对应列表页，再从第一首开始整列表播放（单击仍然只进页面）。 */
  private async playRailList(kind: 'liked' | 'recent'): Promise<void> {
    if (kind === 'liked') {
      await this.showLiked();
      if (this.wall.kind === 'liked' && this.wall.tracks.length > 0) playQueue(this.wall.tracks, 0, true);
      else toast('收藏列表还没有可播放的歌曲', 'error');
      return;
    }
    await this.showRecentWall();
    if (this.wall.kind === 'recent' && this.wall.tracks.length > 0) playQueue(this.wall.tracks, 0, true);
    else toast('最近播放还没有可播放的歌曲', 'error');
  }

  private async fetchLikedTracks(source: OnlineSource): Promise<OnlineTrack[] | null> {
    const cached = this.likedCache.get(source);
    if (cached && cached.length > 0) return cached;
    try {
      const overview = await fetchLibraryOverview();
      const state = overview.sources.find((item) => item.source === source);
      if (!state?.loggedIn || !state.liked) return null;
      const detail = await fetchPlaylist(source, state.liked.id, 0, 200, 'liked');
      this.likedCache.set(source, detail.tracks);
      return detail.tracks;
    } catch (err) {
      console.warn('[app] fetch liked failed', source, err);
      return null;
    }
  }

  /** 融合显示：各登录平台轮流取一首，按平台交错排列。 */
  private async loadLikedMerged(): Promise<void> {
    const sources = getAccounts()
      .filter((item) => item.loggedIn && sourceSupportsLikedWrite(item.source))
      .map((item) => item.source as OnlineSource);
    if (sources.length === 0) {
      this.wall = { kind: 'liked', title: '我喜欢的音乐', subtitle: '登录网易云 / QQ 音乐后自动同步', tracks: [] };
      this.renderWall();
      return;
    }
    const lists = await Promise.all(sources.map((source) => this.fetchLikedTracks(source)));
    const available = sources
      .map((source, index) => ({ source, tracks: lists[index] ?? [] }))
      .filter((item) => item.tracks.length > 0);
    if (available.length === 0) {
      this.wall = { kind: 'liked', title: '我喜欢的音乐', subtitle: '还没有同步到喜欢的歌曲', tracks: [] };
      this.renderWall();
      return;
    }
    const merged: OnlineTrack[] = [];
    const longest = Math.max(...available.map((item) => item.tracks.length));
    for (let index = 0; index < longest; index += 1) {
      for (const item of available) {
        const track = item.tracks[index];
        if (track) merged.push(track);
      }
    }
    const label = available.map((item) => SOURCE_LABEL[item.source]).join(' + ');
    this.wall = {
      kind: 'liked',
      title: '我喜欢的音乐',
      subtitle: `${label} · 融合 · ${merged.length} 首`,
      tracks: merged,
    };
    await this.primeLikedPager(available.map((item) => item.source), merged.length);
    this.renderWall();
  }

  private async loadLiked(source: OnlineSource): Promise<void> {
    const cached = this.likedCache.get(source);
    if (cached && cached.length > 0) {
      void this.primeLikedPager([source], cached.length);
      this.wall = {
        kind: 'liked',
        title: '我喜欢的音乐',
        subtitle: `${SOURCE_LABEL[source]} · ${cached.length} 首`,
        tracks: cached,
      };
      this.renderWall();
      return;
    }
    try {
      const overview = await fetchLibraryOverview();
      const state = overview.sources.find((item) => item.source === source);
      if (!state?.loggedIn || !state.liked) {
        this.wall = {
          kind: 'liked',
          title: '我喜欢的音乐',
          subtitle: state?.loggedIn ? '这个平台还没有喜欢的歌曲' : `${SOURCE_LABEL[source]} 未登录`,
          tracks: [],
        };
        this.renderWall();
        return;
      }
      const detail = await fetchPlaylist(source, state.liked.id, 0, 200, 'liked');
      this.likedCache.set(source, detail.tracks);
      this.wallPager = { entries: [{ source, id: state.liked.id, special: 'liked' }], offset: detail.tracks.length, pageSize: 200, hasMore: detail.hasMore };
      this.wall = {
        kind: 'liked',
        title: '我喜欢的音乐',
        subtitle: `${SOURCE_LABEL[source]} · ${detail.tracks.length} 首`,
        tracks: detail.tracks,
      };
      this.renderWall();
    } catch (err) {
      console.warn('[app] load liked failed', err);
      this.wall = {
        kind: 'liked',
        title: '我喜欢的音乐',
        subtitle: '同步失败，稍后可在设置里刷新',
        tracks: [],
      };
      this.renderWall();
    }
  }

  private showLocal(): void {
    this.wallPager = null;
    this.localArtistFilter = null;
    this.setRailActive('local');
    const lib = localLibrary();
    if (!lib) {
      if (rememberedFolder()) {
        this.wall = {
          kind: 'local',
          title: '本地曲库',
          subtitle: '正在载入上次的文件夹…',
          tracks: [],
        };
        this.renderWall();
        window.setTimeout(() => {
          if (!localLibrary() && this.wall.kind === 'local') pickLocalFolder();
        }, 2500);
        return;
      }
      pickLocalFolder();
      this.wall = {
        kind: 'local',
        title: '本地曲库',
        subtitle: '已打开文件夹选择器…',
        tracks: [],
      };
      this.renderWall();
      return;
    }
    const tracks = lib.entries.map((entry) => trackOf(entry));
    this.wall = {
      kind: 'local',
      title: lib.name || '本地曲库',
      subtitle: `本地 · ${tracks.length} 首`,
      tracks,
    };
    this.renderWall();
  }

  /** 本地曲库当前是否展示「歌手」网格（总览态）。 */
  private isLocalArtistGrid(): boolean {
    return this.wall.kind === 'local' && this.localMode === 'artists' && this.localArtistFilter === null;
  }

  /** 打开某位本地艺术家的页面（该歌手的本地歌曲列表）。 */
  private openLocalArtist(name: string): void {
    const normalized = (name || '').trim() || '未知歌手';
    const artist = localArtists().find((item) => item.name === normalized);
    if (!artist) {
      toast('本地曲库中找不到这位歌手');
      return;
    }
    this.localArtistFilter = normalized;
    this.wall = {
      kind: 'local',
      title: artist.name,
      subtitle: `本地 · ${artist.tracks.length} 首`,
      tracks: artist.tracks,
    };
    this.renderWall(true);
  }

  /** 本地艺术家圆形头像：有内嵌封面用封面，否则用首字母渐变占位。 */
  private localArtistAvatar(artist: LocalArtist, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
    const placeholder = (): HTMLElement => {
      const initial = (artist.name.trim()[0] ?? '♪').toUpperCase();
      return h('div', { class: `local-avatar is-${size}`, 'data-initial': initial }, h('span', { text: initial }));
    };
    // 头像来源：歌曲内嵌封面优先；没有时用在线歌手图（按名字搜网易云歌手）兜底。
    const onlineAllowed = artist.name.trim().length > 0 && artist.name !== '未知歌手';
    const sources = [artist.cover, onlineAllowed ? onlineEndpoint('/api/artist/image', { name: artist.name }) : ''].filter(
      (src): src is string => Boolean(src),
    );
    if (sources.length === 0) return placeholder();

    const holder = h('div', { class: `local-avatar is-photo is-${size}` });
    let attempt = 0;
    const image = h('img', { src: sources[0], alt: '', loading: 'lazy', decoding: 'async' });
    image.addEventListener('error', () => {
      attempt += 1;
      if (attempt < sources.length) {
        image.src = sources[attempt]!;
        return;
      }
      holder.replaceWith(placeholder());
    });
    holder.append(image);
    return holder;
  }

  /** 本地曲库「歌手」网格。 */
  private buildLocalArtistGrid(skipEnter: boolean): HTMLElement {
    const artists = localArtists();
    const grid = h('div', { class: `artist-grid${skipEnter ? '' : ' is-reveal'}` });
    if (artists.length === 0) {
      grid.append(h('div', { class: 'wall-empty', text: '本地曲库还没有歌曲，先选择文件夹或下载歌曲' }));
      return grid;
    }
    artists.forEach((artist) => {
      const card = h(
        'button',
        { class: 'artist-card', type: 'button', title: `查看 ${artist.name} 的本地歌曲` },
        this.localArtistAvatar(artist, 'lg'),
        h('div', { class: 'artist-card-name', text: artist.name }),
        h('div', { class: 'artist-card-meta', text: `${artist.tracks.length} 首歌曲` }),
      );
      card.addEventListener('click', () => this.openLocalArtist(artist.name));
      grid.append(card);
    });
    return grid;
  }

  /** 本地艺术家详情页顶部：大头像 + 名字 + 歌曲数 + 播放全部。 */
  private buildLocalArtistHero(artist: LocalArtist): HTMLElement {
    const playAll = h('button', { class: 'pill pill-primary', title: `播放 ${artist.name} 的全部本地歌曲` }, icon('play', 16), h('span', { text: '播放全部' }));
    playAll.addEventListener('click', () => playQueue(artist.tracks, 0, true));
    return h(
      'div',
      { class: 'artist-hero' },
      this.localArtistAvatar(artist, 'lg'),
      h(
        'div',
        { class: 'artist-hero-info' },
        h('div', { class: 'artist-hero-kicker', text: '本地歌手' }),
        h('h2', { class: 'artist-hero-name', text: artist.name }),
        h('div', { class: 'artist-hero-meta', text: `${artist.tracks.length} 首歌曲 · 来自本地曲库` }),
      ),
      playAll,
    );
  }

  /* ------------------------------------------------------------------ */
  /* 歌单                                                                */
  /* ------------------------------------------------------------------ */

  private async openPlaylistSheet(): Promise<void> {
    this.openSheet('我的歌单', (body) => {
      const localHost = h('div', { class: 'local-playlist-host' });
      const onlineHost = h('div', { class: 'online-playlist-host' });
      body.append(localHost, onlineHost);
      this.renderLocalPlaylists(localHost);
      this.sheetScope?.add(
        subscribeLocalPlaylists(() => {
          this.renderLocalPlaylists(localHost);
        }),
      );
      void this.renderOnlinePlaylists(onlineHost);
    });
  }

  /** 我的歌单弹层里的「本地歌单」区块（新建 / 播放 / 重命名 / 删除）。 */
  private renderLocalPlaylists(host: HTMLElement): void {
    host.textContent = '';
    const playlists = listPlaylists();
    host.append(h('h3', { class: 'section-title', text: `本地歌单 · ${playlists.length} 个` }));
    const input = h('input', {
      class: 'search-input local-playlist-name',
      type: 'text',
      placeholder: '新歌单名称',
      maxlength: '60',
    });
    const createBtn = h('button', { class: 'btn is-primary', type: 'button', text: '新建歌单' });
    createBtn.addEventListener('click', () => {
      const name = input.value.trim();
      if (!name) {
        toast('先输入歌单名称');
        return;
      }
      try {
        const playlist = createPlaylist(name);
        toast(`已创建「${playlist.name}」`);
        this.renderLocalPlaylists(host);
      } catch (err) {
        toast(err instanceof Error ? err.message : '创建歌单失败', 'error');
      }
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        createBtn.click();
      }
    });
    host.append(h('div', { class: 'local-playlist-create' }, input, createBtn));
    if (playlists.length === 0) {
      host.append(h('div', { class: 'empty', text: '还没有本地歌单。新建后可在本地曲目「更多操作」里把歌加进来。' }));
      return;
    }
    const list = h('div', { class: 'list' });
    playlists.forEach((playlist) => {
      const tracks = tracksOfKeys(playlist.trackKeys);
      const nameEl = h('div', { class: 'row-name', text: playlist.name });
      const row = h(
        'div',
        { class: 'row', title: playlist.name },
        h(
          'div',
          { class: 'row-cover local-playlist-cover' },
          tracks[0] ? h('img', { src: onlineArtwork(tracks[0]), loading: 'lazy' }) : icon('list', 20),
        ),
        h('div', { class: 'row-meta' }, nameEl, h('div', { class: 'row-artist', text: `${tracks.length} 首 · 本地` })),
      );
      row.addEventListener('click', () => {
        this.sheet?.close();
        this.openLocalPlaylistWall(playlist.id);
      });
      const actions = h('div', { class: 'local-playlist-actions' });
      const playBtn = h('button', { class: 'icon-btn', type: 'button', title: '播放歌单' }, icon('play', 16));
      playBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (tracks.length === 0) {
          toast('歌单还是空的');
          return;
        }
        this.sheet?.close();
        playQueue(tracks, 0, true);
      });
      const renameBtn = h('button', { class: 'icon-btn', type: 'button', title: '重命名' }, icon('music', 16));
      renameBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const edit = h('input', {
          class: 'search-input local-playlist-rename',
          type: 'text',
          value: playlist.name,
          maxlength: '60',
        });
        const commit = (): void => {
          const next = edit.value.trim();
          if (!next || next === playlist.name) {
            if (edit.isConnected) edit.replaceWith(nameEl);
            return;
          }
          try {
            renamePlaylist(playlist.id, next);
            toast('歌单已重命名');
            this.renderLocalPlaylists(host);
          } catch (err) {
            toast(err instanceof Error ? err.message : '重命名失败', 'error');
            if (edit.isConnected) edit.replaceWith(nameEl);
          }
        };
        edit.addEventListener('keydown', (inner) => {
          if (inner.key === 'Enter') {
            inner.preventDefault();
            commit();
          }
          if (inner.key === 'Escape') {
            inner.stopPropagation();
            if (edit.isConnected) edit.replaceWith(nameEl);
          }
        });
        edit.addEventListener('blur', commit);
        nameEl.replaceWith(edit);
        edit.focus();
        edit.select();
      });
      const deleteBtn = h('button', { class: 'icon-btn', type: 'button', title: '删除歌单' }, icon('trash', 16));
      deleteBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void confirmDialog({
          title: '删除本地歌单',
          message: `删除本地歌单「${playlist.name}」？`,
          detail: '只删除歌单本身，不会删除任何本地歌曲文件。',
          confirmText: '删除歌单',
          tone: 'danger',
        }).then((ok) => {
          if (!ok) return;
          deletePlaylist(playlist.id);
          toast('歌单已删除');
          this.renderLocalPlaylists(host);
        });
      });
      const addBtn = h('button', { class: 'icon-btn', type: 'button', title: '添加歌曲' }, icon('plus', 16));
      addBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.sheet?.close();
        this.openPlaylistAddSheet(playlist.id);
      });
      actions.append(addBtn, playBtn, renameBtn, deleteBtn);
      row.append(actions);
      list.append(row);
    });
    host.append(list);
  }

  /** 我的歌单弹层里的「在线歌单」区块（未登录时给出登录入口）。 */
  private async renderOnlinePlaylists(host: HTMLElement): Promise<void> {
    host.textContent = '';
    if (!getAccounts().some((account) => account.loggedIn)) {
      const loginBtn = h('button', { class: 'btn', type: 'button', text: '去登录' });
      loginBtn.addEventListener('click', () => {
        this.sheet?.close();
        this.openLogin();
      });
      host.append(
        h('h3', { class: 'section-title', text: '在线歌单' }),
        h('div', { class: 'empty', text: '登录网易云 / QQ 音乐后，这里会显示在线歌单' }),
        h('div', { class: 'local-playlist-login' }, loginBtn),
      );
      return;
    }
    host.append(h('h3', { class: 'section-title', text: '在线歌单' }), h('div', { class: 'empty', text: '加载歌单…' }));
    try {
      const overview = await fetchLibraryOverview();
      if (!host.isConnected) return;
      host.textContent = '';
      let any = false;
      for (const state of overview.sources) {
        if (!state.loggedIn) continue;
        const items: LibraryPlaylist[] = [];
        if (state.liked) items.push(state.liked);
        items.push(...state.playlists);
        if (items.length === 0) continue;
        any = true;
        host.append(h('h3', { class: 'section-title', text: `${SOURCE_LABEL[state.source]} · ${items.length} 个歌单` }));
        const list = h('div', { class: 'list' });
        items.forEach((item) => {
          const cover =
            item.cover ??
            onlineArtwork({
              id: item.id,
              title: item.title,
              artist: item.creator ?? '',
              album: '',
              cover: '',
            });
          const row = h(
            'div',
            { class: 'row', title: item.title },
            h('div', { class: 'row-cover' }, h('img', { src: cover, loading: 'lazy' })),
            h(
              'div',
              { class: 'row-meta' },
              h('div', { class: 'row-name', text: item.title }),
              h('div', {
                class: 'row-artist',
                text: `${item.creator ? item.creator + ' · ' : ''}${item.count} 首`,
              }),
            ),
            h('div', { class: 'row-dur', text: item.special === 'liked' ? '喜欢' : '' }),
          );
          row.addEventListener('click', () => {
            this.sheet?.close();
            void this.showPlaylist(item);
          });
          list.append(row);
        });
        host.append(list);
      }
      if (!any) host.append(h('div', { class: 'empty', text: '这两个平台暂时没有歌单' }));
    } catch (err) {
      console.warn('[app] playlists failed', err);
      if (!host.isConnected) return;
      host.textContent = '';
      host.append(h('h3', { class: 'section-title', text: '在线歌单' }), h('div', { class: 'empty', text: '歌单读取失败，检查登录状态或稍后重试' }));
    }
  }

  private async showPlaylist(item: LibraryPlaylist): Promise<void> {
    this.setRailActive('playlist');
    this.wall = {
      kind: 'playlist',
      title: item.title,
      subtitle: `${SOURCE_LABEL[item.source]} · ${item.count} 首`,
      tracks: [],
    };
    this.renderWall();
    const special = item.special === 'liked' ? 'liked' : undefined;
    try {
      const detail = await fetchPlaylist(item.source, item.id, 0, 200, special);
      this.wallPager = { entries: [{ source: item.source as OnlineSource, id: item.id, special: special ?? null }], offset: detail.tracks.length, pageSize: 200, hasMore: detail.hasMore };
      this.wall = {
        ...this.wall,
        title: detail.title || item.title,
        subtitle: `${SOURCE_LABEL[item.source]} · ${detail.tracks.length} 首`,
        tracks: detail.tracks,
      };
      this.renderWall();
    } catch (err) {
      console.warn('[app] playlist failed', err);
      toast('歌单加载失败', 'error');
    }
  }

  private trackRow(
    track: OnlineTrack,
    queue: OnlineTrack[],
    index: number,
    options?: { badge?: boolean; onPlay?: () => void },
  ): HTMLDivElement {
    const coverImg = h('img', { src: onlineArtwork(track), loading: 'lazy' });
    if (!track.cover) {
      void lookupCover(track).then((found) => {
        if (!found) return;
        track.cover = found;
        coverImg.src = onlineArtwork(track);
      });
    }
    const row = h(
      'div',
      { class: 'row', title: `${track.title} — ${track.artist}` },
      h('div', { class: 'row-cover' }, coverImg),
      h(
        'div',
        { class: 'row-meta' },
        h('div', { class: 'row-name', text: track.title }),
        h('div', { class: 'row-artist', text: track.artist || '未知歌手' }),
      ),
      options?.badge ? this.sourceTag(track.source) : null,
      h('div', { class: 'row-dur', text: fmtTime(track.durationMs) }),
    );
    row.addEventListener('click', () => {
      playQueue(queue, index, true);
      if (options?.onPlay) options.onPlay();
      else this.sheet?.close();
    });
    return row;
  }

  /** 平台角标（搜索/混合列表里标出来源）。 */
  private sourceTag(source: string): HTMLSpanElement {
    const meta = sourceMeta(source);
    return h('span', {
      class: 'source-tag',
      style: `--src-accent:${meta.accent}`,
      text: meta.short || meta.label,
    });
  }

  /* ------------------------------------------------------------------ */
  /* 弹层                                                                */
  /* ------------------------------------------------------------------ */

  /** 任意曲目行的「歌曲信息」：按设置走整页详情 / 列表内展开（数据走 /api/discover/song）。 */
  private openTrackInfo(track: OnlineTrack, row: HTMLElement): void {
    openSongInfo(
      {
        source: track.source,
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        cover: track.cover,
      },
      { row, host: this.wallHost },
    );
  }

  /** 下一次 openSheet 是否走「居中弹窗」形态（由设置页使用；一次生效后自动复位）。 */
  private centerNextSheet = false;

  private openSheet(title: string, build: (body: HTMLDivElement) => void): void {
    // 换面板时上一个直接移除，避免两层遮罩叠着淡出
    this.sheet?.root.remove();
    this.sheet = null;
    this.sheetScope?.dispose();
    this.sheetScope = new Disposers();
    const centered = this.centerNextSheet;
    this.centerNextSheet = false;
    const body = h('div', { class: 'sheet-body' });
    const closeBtn = h('button', { class: 'icon-btn', title: '关闭' }, icon('close', 16));
    const panel = h(
      'div',
      { class: 'sheet-panel' },
      h('div', { class: 'sheet-head' }, h('div', { class: 'sheet-title', text: title }), closeBtn),
      body,
    );
    const root = h('div', { class: `sheet${centered ? ' is-center' : ''}` }, panel);
    const close = (): void => {
      if (this.sheet?.root === root) {
        this.sheet = null;
        this.sheetScope?.dispose();
        this.sheetScope = null;
      }
      if (root.classList.contains('is-leaving')) return;
      root.classList.add('is-leaving');
      window.setTimeout(() => root.remove(), 220);
    };
    closeBtn.addEventListener('click', close);
    root.addEventListener('pointerdown', (event) => {
      if (event.target === root) close();
    });
    document.body.append(root);
    this.sheet = { root, body, close };
    build(body);
  }

  /* ------------------------ 搜索：药丸展开 + 边打边搜 + 展开成墙 ------------------------ */

  private openSearchDock(): void {
    if (!this.searchDockOpen) {
      this.searchDockOpen = true;
      this.searchDock.dataset.open = 'true';
      this.searchPop.classList.add('is-open');
      this.renderSearchTabs();
      if (!this.searchInput.value.trim()) {
        this.searchList.textContent = '';
        this.searchNote.textContent = '输入关键词，边打边搜（前 10 首）';
      }
    }
    window.setTimeout(() => this.searchInput.focus(), 60);
  }

  private closeSearchDock(): void {
    this.searchDockOpen = false;
    this.searchDock.dataset.open = 'false';
    this.searchPop.classList.remove('is-open');
    this.searchInput.blur();
  }

  /** 平台分段：融合搜索 + 各平台单选。 */
  private renderSearchTabs(): void {
    this.searchTabs.textContent = '';
    const all = h('button', {
      class: `search-tab${this.searchSource === 'all' ? ' is-on' : ''}`,
      text: '融合搜索',
    });
    all.addEventListener('click', () => {
      this.searchSource = 'all';
      this.renderSearchTabs();
      void this.runSearchPreview();
    });
    this.searchTabs.append(all);
    sourceDescriptors()
      .filter((item) => item.hidden !== true && (item.experimental !== true || experimentalSourceEnabled(item.id)))
      .forEach((item) => {
      const tab = h('button', {
        class: `search-tab${this.searchSource === item.id ? ' is-on' : ''}`,
        style: `--src-accent:${item.accent}`,
        text: item.label,
      });
      tab.addEventListener('click', () => {
        this.searchSource = item.id as OnlineSource;
        this.renderSearchTabs();
        void this.runSearchPreview();
      });
      this.searchTabs.append(tab);
    });
  }

  private scheduleSearchPreview(): void {
    window.clearTimeout(this.searchTimer);
    const keyword = this.searchInput.value.trim();
    if (!keyword) {
      this.searchList.textContent = '';
      this.searchNote.textContent = '输入关键词，边打边搜（前 10 首）';
      return;
    }
    this.searchNote.textContent = '搜索中…';
    this.searchTimer = window.setTimeout(() => void this.runSearchPreview(), 220);
  }

  private searchTargets(): OnlineSource[] {
    return this.searchSource === 'all'
      ? (sourceIds() as OnlineSource[])
      : [this.searchSource as OnlineSource];
  }

  /** 融合搜索：各平台结果按轮次交错，保证优先级均衡。 */
  private mergeByPriority(lists: OnlineTrack[][]): OnlineTrack[] {
    const merged: OnlineTrack[] = [];
    let index = 0;
    while (lists.some((list) => index < list.length)) {
      lists.forEach((list) => {
        if (index < list.length) merged.push(list[index]);
      });
      index += 1;
    }
    return merged;
  }

  /**
   * 分平台并发搜索，谁先回来就先渲染谁；onUpdate 带上已合并结果与仍在等待的平台数。
   * 单平台模式直接返回该平台结果。
   */
  private searchStream(
    keyword: string,
    perSource: number,
    onUpdate: (merged: OnlineTrack[], pending: number) => void,
  ): Promise<OnlineTrack[]> {
    const targets = this.searchTargets();
    const lists: OnlineTrack[][] = targets.map(() => []);
    if (targets.length === 0) return Promise.resolve([]);
    const mergedNow = (): OnlineTrack[] =>
      this.searchSource === 'all' ? this.mergeByPriority(lists) : (lists[0] ?? []);
    return new Promise<OnlineTrack[]>((resolve) => {
      let done = 0;
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve(mergedNow());
      };
      // 某个平台卡住时最多等 4.5 秒，先把已回来的结果给出去
      const timer = window.setTimeout(() => {
        if (settled) return;
        onUpdate(mergedNow(), targets.length - done);
        finish();
      }, 4500);
      targets.forEach((source, index) => {
        void searchOnline(source, keyword, perSource)
          .then((result) => {
            lists[index] = result.tracks;
          })
          .catch((err) => {
            console.warn('[app] search failed', source, err);
          })
          .finally(() => {
            done += 1;
            if (settled) return;
            onUpdate(mergedNow(), targets.length - done);
            if (done === targets.length) {
              window.clearTimeout(timer);
              finish();
            }
          });
      });
    });
  }

  /** 边打边搜：无需确认，按优先级展示前 10 首。 */
  private async runSearchPreview(): Promise<void> {
    const keyword = this.searchInput.value.trim();
    if (!keyword) return;
    const seq = ++this.searchSeq;
    this.searchNote.textContent = '搜索中…';
    this.searchList.textContent = '';
    const merged = await this.searchStream(keyword, 10, (partial, pending) => {
      if (seq !== this.searchSeq) return;
      this.renderSearchPreview(partial.slice(0, 10), pending);
    });
    if (seq !== this.searchSeq) return;
    this.renderSearchPreview(merged.slice(0, 10), 0);
  }

  /** 渐进渲染搜索预览：哪个平台先回来就先显示哪一批，不再等全部平台。 */
  private renderSearchPreview(preview: OnlineTrack[], pending: number): void {
    this.searchList.textContent = '';
    if (preview.length === 0) {
      this.searchNote.textContent = pending > 0 ? '搜索中…' : '没有找到相关歌曲';
      if (pending === 0) this.searchList.append(h('div', { class: 'search-empty', text: '换关键词试试，或切换平台' }));
      return;
    }
    this.searchNote.textContent =
      pending > 0
        ? `已显示 ${preview.length} 首 · 其余平台加载中…`
        : `按优先级展示前 ${preview.length} 首 · Enter 展开全部`;
    preview.forEach((track, index) => {
      this.searchList.append(
        this.trackRow(track, preview, index, {
          badge: true,
          onPlay: () => this.closeSearchDock(),
        }),
      );
    });
  }

  /** 确认（Enter / 查看全部）：渐变过渡成普通墙面列表。 */
  private async commitSearch(): Promise<void> {
    this.wallPager = null;
    // 取消尚未触发的「边打边搜」预览：否则它会在本方法 ++searchSeq 之后才执行并再 ++searchSeq，
    // 把本次提交的流式 onUpdate / 最终结果全部判为过期丢弃，墙面会永久停在「加载中…」。
    window.clearTimeout(this.searchTimer);
    this.searchTimer = 0;
    const keyword = this.searchInput.value.trim();
    if (!keyword) {
      toast('先输入要搜索的歌曲或歌手');
      return;
    }
    recordSearch(keyword);
    const seq = ++this.searchSeq;
    const label =
      this.searchSource === 'all' ? '融合搜索' : sourceMeta(this.searchSource as string).label;
    this.searchLiked.clear();
    this.closeSearchDock();
    this.setRailActive('search');
    // 先进入结果页并显示「正在搜索」，第一批结果回来就立刻铺上去
    this.wall = {
      kind: 'search',
      title: `搜索「${keyword}」`,
      subtitle: `${label} · 搜索中…`,
      tracks: [],
    };
    this.renderWall(true);
    const merged = await this.searchStream(keyword, 30, (partial, pending) => {
      if (seq !== this.searchSeq) return;
      this.wall = {
        kind: 'search',
        title: `搜索「${keyword}」`,
        subtitle: pending > 0 ? `${label} · 已找到 ${partial.length} 首 · 加载中…` : `${label} · ${partial.length} 首`,
        tracks: partial,
      };
      this.renderWall(true);
    });
    if (seq !== this.searchSeq) return;
    this.wall = {
      kind: 'search',
      title: `搜索「${keyword}」`,
      subtitle: `${label} · ${merged.length} 首`,
      tracks: merged,
    };
    this.renderWall(true);
    void this.prefetchSearchLiked(merged);
    if (merged.length === 0) toast('没有找到相关歌曲');
  }

  /** 搜索结果收藏状态预取（各平台合并成一次批量请求）。 */
  private async prefetchSearchLiked(tracks: OnlineTrack[]): Promise<void> {
    const groups = new Map<string, string[]>();
    tracks.forEach((track) => {
      if (track.source === 'local') return;
      const list = groups.get(track.source) ?? [];
      list.push(track.id);
      groups.set(track.source, list);
    });
    if (groups.size === 0) return;
    let changed = false;
    await Promise.all(
      Array.from(groups.entries()).map(async ([source, ids]) => {
        try {
          const result = await checkLikedMany(source as OnlineSource, ids.slice(0, 60));
          Object.entries(result).forEach(([id, liked]) => {
            this.searchLiked.set(`${source}:${id}`, liked);
            changed = true;
          });
        } catch (err) {
          console.warn('[app] checkLikedMany failed', source, err);
        }
      }),
    );
    if (changed && !this.wallHost.classList.contains('is-hidden')) this.syncSearchLiked();
  }

  /**
   * 下载一首在线歌曲：先弹音质选择浮层（标准 / 高品质 / 无损），选完再统一走下载队列。
   * anchor 是触发按钮，用它的位置摆放浮层；本轮选择只对这一次生效，不改设置。
   */
  private beginDownload(track: OnlineTrack, anchor?: HTMLElement): void {
    if (track.source === 'local') {
      toast('本地歌曲不需要下载');
      return;
    }
    const defaultQuality = getSettings().downloads?.quality ?? 'high';
    openQualityPicker({
      anchor: anchor ?? null,
      title: track.title,
      artist: track.artist,
      defaultQuality,
      onPick: (quality) => {
        if (anchor && anchor.isConnected) {
          anchor.classList.add('is-busy');
          window.setTimeout(() => anchor.classList.remove('is-busy'), 1600);
        }
        void beginQueueDownload(track, quality);
      },
    });
  }

  /**
   * 播放条下载按钮：先弹小菜单，提供「下载当前歌曲」（继续走音质选择）与「打开下载队列」。
   * 没有正在播放的歌曲时，菜单里下载项置灰，仍可打开队列。
   */
  private openPlaybarDownloadMenu(anchor: HTMLElement): void {
    const track = playerState().track;
    openDownloadMenu({
      anchor,
      track: track ? { title: track.title, artist: track.artist, local: track.source === 'local' } : null,
      onDownloadTrack: () => {
        const current = playerState().track;
        if (!current || current.source === 'local') return;
        this.beginDownload(current, anchor);
      },
      onOpenQueue: () => openDownloadPanel(),
    });
  }

  /** 搜索结果行：封面 + 歌名/作者 + VIP + 平台角标 + 下载 + 收藏。 */
  private buildSearchList(tracks: OnlineTrack[]): HTMLDivElement {
    const list = h('div', { class: 'track-list' });
    if (tracks.length === 0) {
      list.append(h('div', { class: 'wall-empty', text: '没有找到相关歌曲' }));
      return list;
    }
    const current = playerState().track;
    tracks.forEach((track, index) => {
      const key = `${track.source}:${track.id}`;
      const isLocalTrack = track.source === 'local';
      // 本地收藏独立存在 localStorage；在线收藏看 searchLiked 缓存。
      const liked = isLocalTrack
        ? isLocalLiked(track)
        : this.wall.kind === 'liked'
          ? this.searchLiked.get(key) !== false
          : this.searchLiked.get(key) === true;
      const isCurrent = !!current && current.id === track.id && current.source === track.source;
      const likeBtn = h('button', {
        class: `track-like${liked ? ' is-liked' : ''}`,
        title: liked ? '取消收藏' : '收藏到「我喜欢的音乐」',
        'data-track-key': key,
      });
      likeBtn.append(icon(liked ? 'heartFill' : 'heart', 17));
      if (isLocalTrack) {
        likeBtn.title = liked ? '取消本地收藏' : '收藏到本地「我喜欢的音乐」';
        likeBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          const now = toggleLocalLike(track);
          likeBtn.classList.toggle('is-liked', now);
          likeBtn.title = now ? '取消本地收藏' : '收藏到本地「我喜欢的音乐」';
          likeBtn.replaceChildren(icon(now ? 'heartFill' : 'heart', 17));
          toast(now ? '已收藏到本地「我喜欢的音乐」' : '已取消本地收藏');
        });
      } else {
        likeBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          void this.toggleSearchLiked(track, likeBtn);
        });
      }
      const downloadBtn = h('button', {
        class: `track-download${track.source === 'local' ? ' is-disabled' : ''}`,
        type: 'button',
        title: track.source === 'local' ? '本地歌曲无需下载' : '下载到本地',
        'data-track-key': key,
      });
      downloadBtn.append(icon('download', 17));
      if (track.source === 'local') {
        downloadBtn.disabled = true;
      } else {
        downloadBtn.addEventListener('click', (event) => {
          event.stopPropagation();
          // 音质选择在 beginDownload 里弹；选完才入队、才开始转圈。
          this.beginDownload(track, downloadBtn);
        });
      }
      const infoBtn = h('button', {
        class: 'track-info',
        type: 'button',
        title: '歌曲信息',
        'data-track-key': key,
      });
      infoBtn.append(icon('info', 17));
      infoBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.openTrackInfo(track, row);
      });

      // 本地曲库行：把「下载 / 收藏」两个无意义按钮换成「收藏 / 更多（标签·歌单·定位·删除）」。
      const localRow = this.wall.kind === 'local' || isLocalTrack;
      const moreBtn = h('button', {
        class: 'track-more',
        type: 'button',
        title: '更多操作',
        'data-track-key': key,
      });
      moreBtn.append(icon('more', 17));
      moreBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        this.openLocalTrackActions(track);
      });
      // 封面：与海报网格同一套补图逻辑——没有内嵌封面时先去线上找一张，
      // 找到后再回填，避免横条视图停在程序化渐变占位图上（网格会补、横条不补的 bug）。
      const coverImg = h('img', { src: onlineArtwork(track), loading: 'lazy' });
      if (!track.cover) {
        void lookupCover(track).then((found) => {
          if (!found) return;
          track.cover = found;
          coverImg.src = onlineArtwork(track);
        });
      }

      const row = h(
        'div',
        {
          class: `track-row${isCurrent ? ' is-current' : ''}`,
          title: `${track.title} — ${track.artist}`,
          'data-track-key': key,
        },
        h('div', { class: 'track-index', text: String(index + 1).padStart(2, '0') }),
        h('div', { class: 'track-cover' }, coverImg),
        h(
          'div',
          { class: 'track-body' },
          h(
            'div',
            { class: 'track-title-line' },
            h('span', { class: 'track-title', text: track.title }),
            track.vip === true ? h('span', { class: 'track-vip', text: 'VIP' }) : null,
            track.vip !== true && track.playable === false
              ? h('span', { class: 'track-vip is-muted', text: '暂不可播' })
              : null,
          ),
          h('div', { class: 'track-artist', text: track.artist || '未知歌手' }),
        ),
        this.sourceTag(track.source),
        h('div', { class: 'track-dur', text: fmtTime(track.durationMs) }),
        infoBtn,
        localRow ? likeBtn : downloadBtn,
        localRow ? moreBtn : likeBtn,
      );
      row.addEventListener('click', () => playQueue(tracks, index, true));
      if (localRow) {
        const artistEl = row.querySelector<HTMLElement>('.track-artist');
        if (artistEl) {
          artistEl.classList.add('is-linkable');
          artistEl.title = `查看 ${track.artist || '未知歌手'} 的本地歌曲`;
          artistEl.addEventListener('click', (event) => {
            event.stopPropagation();
            this.openLocalArtist(track.artist || '未知歌手');
          });
        }
      }
      list.append(row);
    });
    return list;
  }

  /** 把一首/多首本地曲目移到回收站（带二次确认）。 */
  private confirmDeleteLocal(tracks: OnlineTrack[]): void {
    const rels = tracks.map((track) => relOf(track)).filter((rel): rel is string => Boolean(rel));
    if (rels.length === 0) {
      toast('找不到要删除的文件', 'error');
      return;
    }
    const label = tracks.length === 1 ? `「${tracks[0].title}」` : `${tracks.length} 首歌曲`;
    void confirmDialog({
      title: '移到回收站',
      message: `把${label}移到回收站？`,
      detail: '文件会连同同名歌词与封面信息一起移入 Windows 回收站，可以随时还原。',
      confirmText: '移到回收站',
      tone: 'danger',
    }).then((ok) => {
      if (ok) deleteLocalTracks(rels);
    });
  }

  /** 本地曲目「更多操作」面板：标签 / 歌单 / 文件夹 / 回收站。 */
  private openLocalTrackActions(track: OnlineTrack): void {
    const key = trackKeyOfTrack(track);
    this.openSheet('歌曲操作', (body) => {
      body.append(
        h(
          'div',
          { class: 'local-sheet-meta' },
          h('div', { class: 'row-name', text: track.title }),
          h('div', { class: 'row-artist', text: track.artist || '未知歌手' }),
        ),
      );
      const list = h('div', { class: 'list local-sheet-actions' });
      const action = (label: string, iconName: string, hint: string, onClick: () => void): HTMLElement => {
        const row = h(
          'button',
          { class: 'row local-sheet-action', type: 'button' },
          h('div', { class: 'row-cover local-sheet-icon' }, icon(iconName, 18)),
          h(
            'div',
            { class: 'row-meta' },
            h('div', { class: 'row-name', text: label }),
            h('div', { class: 'row-artist', text: hint }),
          ),
        );
        row.addEventListener('click', () => {
          this.sheet?.close();
          onClick();
        });
        return row;
      };
      const liked = isLocalLiked(track);
      list.append(
        action(liked ? '取消本地收藏' : '收藏到本地「我喜欢的音乐」', liked ? 'heartFill' : 'heart', '只保存在本机，不写入账号', () => {
          const now = toggleLocalLike(track);
          this.syncLocalLikeButtons(track, now);
          toast(now ? '已收藏到本地「我喜欢的音乐」' : '已取消本地收藏');
        }),
        action('编辑歌曲标签', 'music', '标题 / 歌手 / 专辑 / 年份，写入文件', () => {
          openTagEditor(track, () => {
            void initLocalLibrary();
          });
        }),
        action('添加到歌单', 'list', '加入本地歌单，可拖动排序', () => {
          if (!key) {
            toast('找不到本地文件', 'error');
            return;
          }
          this.openLocalPlaylistPicker(track);
        }),
        action('在文件夹中显示', 'folder', '打开文件所在目录', () => revealLocalTrack(track)),
        action('移到回收站', 'trash', '可随时从回收站还原', () => this.confirmDeleteLocal([track])),
      );
      body.append(list);
    });
  }

  /** 本地收藏状态变化后，同步当前页面上这首歌的所有红心按钮。 */
  private syncLocalLikeButtons(track: OnlineTrack, liked: boolean): void {
    const key = trackKeyOfTrack(track);
    if (!key) return;
    this.root.querySelectorAll<HTMLButtonElement>('.track-like[data-track-key]').forEach((button) => {
      if (button.dataset.trackKey !== key) return;
      button.classList.toggle('is-liked', liked);
      button.title = liked ? '取消本地收藏' : '收藏到本地「我喜欢的音乐」';
      button.replaceChildren(icon(liked ? 'heartFill' : 'heart', 17));
    });
  }

  /** 把本地曲目加入某个本地歌单（或现场新建一个）。 */
  private openLocalPlaylistPicker(track: OnlineTrack): void {
    const key = trackKeyOfTrack(track);
    if (!key) {
      toast('找不到本地文件', 'error');
      return;
    }
    this.openSheet('添加到歌单', (body) => {
      const render = (): void => {
        body.textContent = '';
        const playlists = listPlaylists();
        const list = h('div', { class: 'list' });
        playlists.forEach((playlist) => {
          const has = playlist.trackKeys.includes(key);
          const row = h(
            'button',
            { class: 'row', type: 'button', title: playlist.name },
            h('div', { class: 'row-cover local-sheet-icon' }, icon('list', 18)),
            h(
              'div',
              { class: 'row-meta' },
              h('div', { class: 'row-name', text: playlist.name }),
              h('div', { class: 'row-artist', text: `${playlist.trackKeys.length} 首 · 本地` }),
            ),
            h('div', { class: 'row-dur', text: has ? '已在' : '' }),
          );
          row.addEventListener('click', () => {
            if (has) {
              toast('这首歌已经在歌单里');
              return;
            }
            addTracksToPlaylist(playlist.id, [key]);
            toast(`已添加到「${playlist.name}」`);
            render();
          });
          list.append(row);
        });
        if (playlists.length === 0) {
          body.append(h('div', { class: 'empty', text: '还没有本地歌单，在下面新建一个' }));
        }
        body.append(list);
        const input = h('input', {
          class: 'search-input local-playlist-name',
          type: 'text',
          placeholder: '新歌单名称',
          maxlength: '60',
        });
        const createBtn = h('button', { class: 'btn is-primary', type: 'button', text: '新建并添加' });
        const create = (): void => {
          const name = input.value.trim();
          if (!name) {
            toast('先输入歌单名称');
            return;
          }
          try {
            const playlist = createPlaylist(name, [key]);
            toast(`已创建「${playlist.name}」并加入 1 首`);
            render();
          } catch (err) {
            toast(err instanceof Error ? err.message : '创建歌单失败', 'error');
          }
        };
        createBtn.addEventListener('click', create);
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            create();
          }
        });
        body.append(h('div', { class: 'local-playlist-create' }, input, createBtn));
      };
      render();
    });
  }

  /** 打开本地歌单墙（曲库页的播放列表视图，复用本地行样式与更多操作）。 */
  private openLocalPlaylistWall(id: string): void {
    const playlist = listPlaylists().find((item) => item.id === id);
    if (!playlist) {
      toast('歌单不存在', 'error');
      return;
    }
    const tracks = tracksOfKeys(playlist.trackKeys);
    this.setRailActive('playlist');
    this.localArtistFilter = null;
    this.wallPager = null;
    this.wall = {
      kind: 'playlist',
      title: playlist.name,
      subtitle: `本地歌单 · ${tracks.length} 首 · 拖动可排序`,
      tracks,
      playlistId: id,
    };
    this.renderWall();
    if (tracks.length === 0) {
      // 空歌单直接打开「添加歌曲」，避免新歌单页面一片空白、不知道怎么加歌。
      this.openPlaylistAddSheet(id);
    }
  }

  /** 从本地曲库挑选歌曲加入指定本地歌单（歌单墙「添加歌曲」入口）。 */
  private openPlaylistAddSheet(playlistId: string): void {
    const initial = getPlaylist(playlistId);
    if (!initial) {
      toast('歌单不存在', 'error');
      return;
    }
    this.openSheet(`添加歌曲到「${initial.name}」`, (body) => {
      const search = h('input', { class: 'search-input', type: 'text', placeholder: '搜索本地歌曲（歌名 / 歌手）' });
      const hint = h('div', { class: 'field-hint', text: '点击歌曲即可加入，可连续添加；已在歌单里的歌曲不会重复出现。' });
      const list = h('div', { class: 'list' });
      const render = (): void => {
        const playlist = getPlaylist(playlistId);
        if (!playlist) return;
        const query = search.value.trim().toLowerCase();
        const inPlaylist = new Set(playlist.trackKeys);
        const all = localTracks();
        const matches = all.filter((track) => {
          const key = trackKeyOfTrack(track);
          if (!key || inPlaylist.has(key)) return false;
          if (!query) return true;
          return `${track.title} ${track.artist}`.toLowerCase().includes(query);
        });
        list.textContent = '';
        if (matches.length === 0) {
          list.append(
            h('div', {
              class: 'empty',
              text:
                all.length === 0
                  ? '本地曲库还没有歌曲，先去「本地曲库」选择音乐文件夹'
                  : '没有可添加的歌曲（都已在歌单里，或与搜索词不匹配）',
            }),
          );
        }
        matches.forEach((track) => {
          const key = trackKeyOfTrack(track);
          const row = h(
            'button',
            { class: 'row', type: 'button', title: `把「${track.title}」加入歌单` },
            h('div', { class: 'row-cover' }, h('img', { src: onlineArtwork(track), loading: 'lazy' })),
            h(
              'div',
              { class: 'row-meta' },
              h('div', { class: 'row-name', text: track.title }),
              h('div', { class: 'row-artist', text: track.artist }),
            ),
            h('div', { class: 'row-dur' }, icon('plus', 16)),
          );
          row.addEventListener('click', () => {
            if (!key) return;
            try {
              const added = addTracksToPlaylist(playlistId, [key]);
              toast(added > 0 ? `已加入「${playlist.name}」` : '这首歌已经在歌单里');
            } catch (err) {
              toast(err instanceof Error ? err.message : '添加失败', 'error');
            }
            this.refreshLocalPlaylistWall(playlistId);
            render();
          });
          list.append(row);
        });
      };
      search.addEventListener('input', render);
      body.append(search, hint, list);
      render();
    });
  }

  /** 歌单内容变化后刷新歌单墙（仅当当前页面就是这个歌单）。 */
  private refreshLocalPlaylistWall(playlistId: string): void {
    if (this.wall.kind !== 'playlist' || this.wall.playlistId !== playlistId) return;
    const playlist = getPlaylist(playlistId);
    if (!playlist) return;
    const tracks = tracksOfKeys(playlist.trackKeys);
    this.wall = { ...this.wall, title: playlist.name, subtitle: `本地歌单 · ${tracks.length} 首 · 拖动可排序`, tracks };
    this.renderWall(true);
  }

  /** 收藏 / 取消收藏（乐观更新，失败回滚）。 */
  private async toggleSearchLiked(track: OnlineTrack, button: HTMLButtonElement): Promise<void> {
    const key = `${track.source}:${track.id}`;
    if (this.searchLikeBusy.has(key)) return;
    const wasLiked = this.searchLiked.get(key) === true;
    const next = !wasLiked;
    this.searchLikeBusy.add(key);
    this.applyLikeVisual(track, next, button);
    try {
      if (next) await addLikedTrack(track.source, track.id);
      else await removeLikedTrack(track.source, track.id);
      this.searchLiked.set(key, next);
      this.likedCache.clear();
      toast(next ? '已收藏到「我喜欢的音乐」' : '已取消收藏');
    } catch (err) {
      console.warn('[app] toggle like failed', err);
      this.applyLikeVisual(track, wasLiked, button);
      toast(err instanceof Error ? err.message : '收藏状态更新失败', 'error');
    } finally {
      this.searchLikeBusy.delete(key);
    }
  }

  /** 收藏状态变化后：同步搜索列表红心、清喜欢缓存、刷新喜欢墙面。 */
  private afterLikedChange(liked: boolean): void {
    const track = playerState().track;
    if (!track) return;
    const key = `${track.source}:${track.id}`;
    if (this.searchLiked.has(key)) this.searchLiked.set(key, liked);
    this.likedCache.clear();
    if (this.wall.kind === 'search') this.syncSearchLiked();
    // 只有「此刻正停在喜欢墙」时才刷新它；否则像首页/歌单里点红心会自动跳页（用户反馈的 bug）。
    const wallVisible = !this.wallHost.classList.contains('is-hidden');
    if (this.wall.kind === 'liked' && wallVisible) {
      // 就地增删这一首即可——重新 showLiked() 会先渲染「同步中」再渲染结果，看起来像刷新两次。
      const tracks = this.wall.tracks.slice();
      const index = tracks.findIndex((item) => item.source === track.source && item.id === track.id);
      if (liked && index < 0) tracks.unshift(track);
      if (!liked && index >= 0) tracks.splice(index, 1);
      const label = this.likedMode === 'all' ? '多平台融合' : SOURCE_LABEL[this.likedMode];
      const countText = this.likedMode === 'all' ? `${label} · 融合 · ${tracks.length} 首` : `${label} · ${tracks.length} 首`;
      this.wall = { kind: 'liked', title: '我喜欢的音乐', subtitle: countText, tracks };
      this.renderWall(true);
    }
  }

  private applyLikeVisual(track: OnlineTrack, liked: boolean, button: HTMLButtonElement): void {
    const key = `${track.source}:${track.id}`;
    this.searchLiked.set(key, liked);
    button.classList.toggle('is-liked', liked);
    button.title = liked ? '取消收藏' : '收藏到「我喜欢的音乐」';
    button.textContent = '';
    button.append(icon(liked ? 'heartFill' : 'heart', 17));
  }

  /** 收藏状态到位后刷新已渲染的收藏按钮。 */
  private syncSearchLiked(): void {
    this.wallHost.querySelectorAll<HTMLButtonElement>('.track-like').forEach((button) => {
      const key = button.dataset.trackKey ?? '';
      const liked =
        this.wall.kind === 'liked'
          ? this.searchLiked.get(key) !== false
          : this.searchLiked.get(key) === true;
      button.classList.toggle('is-liked', liked);
      button.title = liked ? '取消收藏' : '收藏到「我喜欢的音乐」';
      button.textContent = '';
      button.append(icon(liked ? 'heartFill' : 'heart', 17));
    });
  }

  /** 统一开关控件：白底金色双段胶囊（关 / 开），与快捷设置 tab 的选中样式一致。 */
  private pillSwitch(
    value: boolean,
    onChange: (next: boolean) => void,
  ): { root: HTMLDivElement; setValue: (next: boolean) => void } {
    const root = h('div', { class: `pill-switch${value ? ' is-on' : ''}` });
    const offBtn = h('button', { class: `pill-switch-btn${value ? '' : ' is-on'}`, type: 'button', text: '关' });
    const onBtn = h('button', { class: `pill-switch-btn${value ? ' is-on' : ''}`, type: 'button', text: '开' });
    const setValue = (next: boolean): void => {
      root.classList.toggle('is-on', next);
      offBtn.classList.toggle('is-on', !next);
      onBtn.classList.toggle('is-on', next);
    };
    offBtn.addEventListener('click', () => {
      if (!root.classList.contains('is-on')) return;
      setValue(false);
      onChange(false);
    });
    onBtn.addEventListener('click', () => {
      if (root.classList.contains('is-on')) return;
      setValue(true);
      onChange(true);
    });
    root.append(h('div', { class: 'pill-switch-thumb' }), offBtn, onBtn);
    return { root, setValue };
  }

  private openSettingsSheet(): void {
    this.setRailActive('settings');
    // 设置改用居中大弹窗（和效果设置一致的观感），其他 sheet 仍是右侧滑出。
    this.centerNextSheet = true;
    this.openSheet('设置', (body) => {
      const settings = getSettings();
      const section = (title: string, ...children: HTMLElement[]): HTMLDivElement => {
        const wrap = h('div', { class: 'section' }, h('h3', { class: 'section-title', text: title }));
        children.forEach((child) => wrap.append(child));
        return wrap;
      };
      const toggleField = (label: string, hint: string, value: boolean, onChange: (next: boolean) => void): HTMLDivElement => {
        const sw = this.pillSwitch(value, onChange);
        return h('div', { class: 'field' }, h('div', {}, h('div', { class: 'field-label', text: label }), h('div', { class: 'field-hint', text: hint })), sw.root);
      };
      const segField = <T extends string>(label: string, options: Array<{ value: T; label: string }>, value: T, onChange: (next: T) => void, hint?: string): HTMLDivElement => {
        const seg = h('div', { class: 'seg' });
        options.forEach((option) => {
          const btn = h('button', { class: `seg-btn${option.value === value ? ' is-on' : ''}`, text: option.label });
          btn.addEventListener('click', () => {
            seg.querySelectorAll('.seg-btn').forEach((node) => node.classList.toggle('is-on', node === btn));
            onChange(option.value);
          });
          seg.append(btn);
        });
        const field = h('div', { class: hint ? 'field is-stacked' : 'field' }, h('div', { class: 'field-label', text: label }), seg);
        if (hint) field.append(h('div', { class: 'field-hint', text: hint }));
        return field;
      };
      const sliderField = (
        label: string,
        min: number,
        max: number,
        step: number,
        value: number,
        onChange: (next: number) => void,
        format: (next: number) => string = (next) => String(next),
      ): HTMLDivElement => {
        const valueLabel = h('span', { class: 'field-slider-value', text: format(value) });
        const input = h('input', { class: 'slider', type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
        input.addEventListener('input', () => {
          const next = Number(input.value);
          valueLabel.textContent = format(next);
          onChange(next);
        });
        return h(
          'div',
          { class: 'field field-slider' },
          h('div', { class: 'field-label', text: label }),
          h('div', { class: 'field-slider-control' }, valueLabel, input),
        );
      };

      // 通用
      const general = section(
        '通用',
        toggleField('启动动画', '打开软件时播放启动画面', settings.general.splash, (value) => {
          patchSettings({ general: { splash: value } });
        }),
        toggleField('启动时最大化', '下次启动直接铺满屏幕', settings.general.startMaximized, (value) => {
          patchSettings({ general: { startMaximized: value } });
        }),
        toggleField(
          '开机自启',
          '登录 Windows 后自动启动 Zilux2（也会出现在任务管理器的「启动」页，可在那里关闭）',
          settings.general.autoLaunch,
          (value) => {
            patchSettings({ general: { autoLaunch: value } });
            toast(value ? '已开启开机自启' : '已关闭开机自启');
          },
        ),
        toggleField(
          '监控本地文件夹',
          '本地曲库文件夹里的新增/删除歌曲会实时同步；关闭后需要手动重新扫描',
          settings.general.watchLocalFolder,
          (value) => {
            patchSettings({ general: { watchLocalFolder: value } });
            toast(value ? '已开启本地文件夹监控' : '已暂停本地文件夹监控');
          },
        ),
      );

      // 外观
      const appearance = section(
        '外观',
        segField(
          '歌曲信息样式',
          [
            { value: 'page', label: '整页详情' },
            { value: 'inline', label: '列表内展开' },
          ],
          songInfoView(),
          (value) => setSongInfoView(value),
        ),
        segField(
          '歌词字号',
          [
            { value: 'small', label: '小' },
            { value: 'medium', label: '中' },
            { value: 'large', label: '大' },
          ],
          settings.appearance.lyricsSize,
          (value) => patchSettings({ appearance: { lyricsSize: value } }),
        ),
        segField(
          '窗口动画',
          [
            { value: 'custom', label: '应用内' },
            { value: 'native', label: '系统原生' },
          ],
          settings.appearance.windowAnimation,
          (value) => patchSettings({ appearance: { windowAnimation: value } }),
          '应用内：最大化/最小化/关闭都用自绘过渡（关闭快照淡出），不依赖系统设置；系统原生：最大化/最小化交给 Windows，关闭没有系统动画会直接消失。',
        ),
        toggleField(
          '播放条常驻展开',
          '打开后底部播放条不再依赖鼠标悬停，始终保持展开形态（显示进度、音量与完整控制）。',
          settings.appearance.playerBarExpanded,
          (value) => patchSettings({ appearance: { playerBarExpanded: value } }),
        ),
        this.buildAccentField(),
        this.buildPageBackgroundField(),
      );

      // 播放
      const playback = section(
        '播放',
        segField(
          '默认平台',
          [
            ...sourceIds().map((id) => ({ value: id, label: sourceMeta(id).label })),
          ],
          settings.playback.defaultSource,
          (value) => patchSettings({ playback: { defaultSource: value } }),
        ),
        sliderField('音量', 0, 100, 1, Math.round(settings.playback.volume * 100), (value) => {
          setVolume(value / 100);
          patchSettings({ playback: { volume: value / 100 } });
        }, (value) => `${value}%`),
        segField(
          '播放速度',
          [
            { value: '0.75', label: '0.75×' },
            { value: '1', label: '1.0×' },
            { value: '1.25', label: '1.25×' },
            { value: '1.5', label: '1.5×' },
            { value: '2', label: '2.0×' },
          ],
          getPlaybackSpeed() === 1 ? '1' : String(getPlaybackSpeed()),
          (value) => {
            setPlaybackSpeed(Number(value));
          },
          '变速不变调（Web Audio preservesPitch）；无缝过渡的变速会与此倍速相乘。',
        ),
        toggleField('播放/暂停渐变', '开启后暂停淡出、播放淡入；关闭则瞬时切换', settings.playback.fadeEnabled, (value) => {
          patchSettings({ playback: { fadeEnabled: value } });
        }),
        sliderField('暂停淡出时长', FADE_OUT_MS.min, FADE_OUT_MS.max, FADE_OUT_MS.step, settings.playback.fadeOutMs, (value) => {
          patchSettings({ playback: { fadeOutMs: value } });
        }, (value) => `${value} ms`),
        sliderField('开始播放淡入时长', FADE_IN_MS.min, FADE_IN_MS.max, FADE_IN_MS.step, settings.playback.fadeInMs, (value) => {
          patchSettings({ playback: { fadeInMs: value } });
        }, (value) => `${value} ms`),
        segField(
          '渐变曲线',
          FADE_CURVES.map((item) => ({ value: item.value, label: item.label })),
          settings.playback.fadeCurve,
          (value) => patchSettings({ playback: { fadeCurve: value as FadeCurve } }),
          '平滑：两端缓；线性：匀速；指数：越到后面下降越快（更晚才没声）。',
        ),
        toggleField(
          '人声保留淡出',
          '暂停时先压低低频与高频（鼓/贝斯/镲片），让人声所在的频段多留一会儿',
          settings.playback.fadeVocal,
          (value) => patchSettings({ playback: { fadeVocal: value } }),
        ),
        sliderField(
          '人声尾音',
          FADE_VOCAL_TAIL_MS.min,
          FADE_VOCAL_TAIL_MS.max,
          FADE_VOCAL_TAIL_MS.step,
          settings.playback.fadeVocalTailMs,
          (value) => patchSettings({ playback: { fadeVocalTailMs: value } }),
          (value) => (value === 0 ? '关闭' : `${value} ms`),
        ),
        sliderField('搜索结果条数', 10, 50, 5, settings.playback.searchLimit, (value) => {
          patchSettings({ playback: { searchLimit: value } });
        }, (value) => `${value} 条`),
        (() => {
          const panel = buildSleepTimerPanel();
          this.sheetScope?.add(() => panel.dispose());
          return h(
            'div',
            { class: 'field is-stacked' },
            h('div', { class: 'field-label', text: '睡眠定时' }),
            h('div', { class: 'field-hint', text: '到点自动暂停；「播完当前曲」会在当前歌曲结束后停止。' }),
            panel.element,
          );
        })(),
        buildAnalysisSection(this.sheetScope),
        buildCrossfadeSection(this.sheetScope),
      );

      // 账号
      const accountSection = h('div', { class: 'section' }, h('h3', { class: 'section-title', text: '账号' }));
      for (const source of accountSourceIds() as AccountSource[]) {
        const info = accountOf(source);
        const cookieLogin = sourceLoginMode(source) === 'cookie';
        const action = h('button', {
          class: 'btn',
          text: info.loggedIn ? '退出' : cookieLogin ? '导入 Cookie' : '登录',
        });
        action.addEventListener('click', () => {
          if (info.loggedIn) {
            void logout(source).then(() => {
              toast('已退出登录');
              this.sheet?.close();
            });
            return;
          }
          if (!cookieLogin) {
            this.sheet?.close();
            this.openLogin(source);
            return;
          }
          const label = SOURCE_LABEL[source] ?? source;
          const cookie = window.prompt(`粘贴浏览器里的${label} Cookie（需要 token、userid、dfid、mid）`, '');
          if (!cookie || !cookie.trim()) return;
          void this.importCookieFor(source, cookie.trim())
            .then(() => {
              toast(`${label} Cookie 已导入`);
              this.sheet?.close();
            })
            .catch((error: unknown) => {
              toast(`导入失败：${error instanceof Error ? error.message : String(error)}`, 'error');
            });
        });
        accountSection.append(
          h(
            'div',
            { class: 'field' },
            h(
              'div',
              { class: 'field-label', text: `${SOURCE_LABEL[source]}${info.loggedIn ? ` · ${info.nickname ?? ''}` : ' · 未登录'}` },
            ),
            action,
          ),
        );
      }

      // 刷新与本地库
      const tools = section(
        '数据',
        (() => {
          const btn = h('button', { class: 'btn', title: '刷新个人库' }, icon('refresh', 16), h('span', { text: '刷新个人库' }));
          btn.addEventListener('click', () => {
            void refreshLibrary().then(() => {
              this.likedCache.clear();
              toast('个人库已刷新');
              this.sheet?.close();
              void this.showLiked();
            });
          });
          return h('div', { class: 'field' }, h('div', { class: 'field-label', text: '重新同步收藏与歌单' }), btn);
        })(),
        (() => {
          const btn = h('button', { class: 'btn' }, icon('folder', 16), h('span', { text: '选择文件夹' }));
          btn.addEventListener('click', () => {
            this.sheet?.close();
            pickLocalFolder();
          });
          return h('div', { class: 'field' }, h('div', { class: 'field-label', text: '本地歌曲文件夹' }), btn);
        })(),
        (() => {
          const io = buildSettingsIOActions({
            getSettings,
            onImported: (result) => {
              if (result.ok && result.settings) {
                patchSettings(result.settings);
                toast('设置已导入');
              } else if (result.error) {
                toast(`导入失败：${result.error}`, 'error');
              }
            },
            onCacheCleared: (result) => toast(`已清理 ${result.cleared.length} 项本地缓存`),
            confirmClear: (keyCount) =>
              confirmDialog({
                title: '清空本地缓存',
                message: `清空 ${keyCount} 项本地缓存？`,
                detail: '只会清理缓存类数据，收藏、歌单、歌词偏移等个人数据不受影响。',
                confirmText: '清空',
                tone: 'danger',
                iconName: 'trash',
              }),
          });
          this.sheetScope?.add(() => io.dispose());
          return h(
            'div',
            { class: 'field is-stacked' },
            h('div', { class: 'field-label', text: '设置导入导出' }),
            h('div', { class: 'field-hint', text: '导出为 JSON 备份；导入会覆盖本地设置。' }),
            io.element,
          );
        })(),
      );

      // 实验功能：实验来源默认关闭，只有在这里显式开启后，搜索等页面才会出现。
      const experimental = section('实验功能');
      for (const info of Object.values(EXPERIMENTAL_SOURCES)) {
        const on = experimentalSourceEnabled(info.id);
        const sw = this.pillSwitch(on, () => {});
        const apply = (next: boolean): void => {
          sw.setValue(next);
          setExperimentalSourceEnabled(info.id, next);
          if (!next && this.searchSource === (info.id as OnlineSource)) this.searchSource = 'all';
          this.renderSearchTabs();
          toast(next ? `已开启实验来源「${info.label}」，搜索页可见` : `已关闭实验来源「${info.label}」`);
        };
        const root = sw.root;
        root.querySelectorAll('.pill-switch-btn').forEach((node, index) => {
          node.addEventListener('click', () => {
            const wantsOn = index === 1;
            if (!wantsOn) {
              if (experimentalSourceEnabled(info.id)) apply(false);
              return;
            }
            if (experimentalSourceEnabled(info.id)) return;
            void confirmDialog({
              title: `启用「${info.label}」`,
              message: '这是一个来自第三方站点的实验来源，接口可能随时失效、改动或被封禁。',
              detail: info.confirm,
              confirmText: '我已了解，开启',
              tone: 'default',
            }).then((ok) => {
              if (!ok) sw.setValue(false);
              else apply(true);
            });
          });
        });
        const head = h(
          'div',
          { class: 'field' },
          h(
            'div',
            {},
            h('div', { class: 'field-label', text: `${info.label}（实验来源）` }),
            h('div', { class: 'field-hint', text: info.summary }),
          ),
          sw.root,
        );
        const risk = h(
          'div',
          { class: 'experimental-risk' },
          h('div', { class: 'experimental-risk-title', text: '风险说明：开启即视为你已知悉，并自行承担相应后果' }),
          ...info.risks.map((line) => h('div', { class: 'experimental-risk-line', text: '· ' + line })),
        );
        experimental.append(head, risk);
        if (info.id === 'mvmp3') {
          // 本地缓存：播放过的实验来源歌曲会自动落盘，二次播放/断网直接读本地文件。
          const cacheHint = h('div', { class: 'field-hint', text: on ? '正在读取本地缓存…' : '开启后播放过的歌会自动存到本机。' });
          const fmtBytes = (bytes: number): string => {
            if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
            if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
            return `${Math.max(0, Math.round(bytes / 1024))} KB`;
          };
          const applyStat = (stat: { count: number; bytes: number }): void => {
            cacheHint.textContent =
              stat.count > 0
                ? `已缓存 ${stat.count} 首（${fmtBytes(stat.bytes)}），再次播放会直接读本地文件。`
                : '还没有缓存。搜索并播放过的歌会自动存到本机。';
          };
          const clearBtn = h('button', { class: 'btn', title: '清空本地缓存' }, icon('refresh', 16), h('span', { text: '清空' }));
          clearBtn.addEventListener('click', () => {
            void confirmDialog({
              title: '清空本地缓存',
              message: '清空实验来源的本地缓存？',
              detail: '已经下载到下载目录的实验来源歌曲也会被删除，且无法还原。',
              confirmText: '清空缓存',
              tone: 'danger',
              iconName: 'refresh',
            }).then((ok) => {
              if (!ok) return;
              void clearMvmp3Cache()
                .then((stat) => {
                  applyStat(stat);
                  toast('实验来源缓存已清空');
                })
                .catch((error: unknown) => {
                  toast(`清空失败：${error instanceof Error ? error.message : String(error)}`, 'error');
                });
            });
          });
          if (on) {
            void fetchMvmp3Cache().then(applyStat).catch(() => {
              cacheHint.textContent = '缓存统计暂时不可用。';
            });
          }
          experimental.append(
            h('div', { class: 'field' }, h('div', {}, h('div', { class: 'field-label', text: '本地缓存' }), cacheHint), clearBtn),
          );
        }
      }

      // 均衡器：10 段增益（-12..12dB），预设按钮与滑块双向同步。
      const eqGains = [...settings.playback.eqGains];
      let eqEnabled = settings.playback.eqEnabled;
      const eqValueLabels: HTMLDivElement[] = [];
      const eqSliders: HTMLInputElement[] = [];
      const eqBands = h('div', { class: 'eq-bands' });
      const presetSeg = h('div', { class: 'seg eq-presets' });
      const eqCurve = createEqCurve({
        height: 150,
        interactive: true,
        onChange: (nextGains) => {
          nextGains.forEach((gain, index) => {
            eqGains[index] = gain;
            paintEqGain(index);
          });
          presetSeg.querySelectorAll('.seg-btn').forEach((node) => node.classList.remove('is-on'));
          if (!eqEnabled) {
            eqEnabled = true;
            paintEqEnabled();
          }
        },
        onCommit: (nextGains) => {
          patchSettings({ playback: { eqEnabled: true, eqGains: [...nextGains] } });
        },
      });
      eqCurve.setGains(eqGains);
      const eqSwitch = this.pillSwitch(eqEnabled, (next) => {
        eqEnabled = next;
        paintEqEnabled();
        patchSettings({ playback: { eqEnabled } });
      });
      const paintEqEnabled = (): void => {
        eqSwitch.setValue(eqEnabled);
        eqBands.classList.toggle('is-disabled', !eqEnabled);
        eqCurve.setEnabled(eqEnabled);
      };
      const paintEqGain = (index: number): void => {
        const gain = eqGains[index] ?? 0;
        eqValueLabels[index].textContent = gain > 0 ? `+${gain}` : String(gain);
        if (eqSliders[index].value !== String(gain)) eqSliders[index].value = String(gain);
      };
      EQ_BAND_FREQS.forEach((freq, index) => {
        const initialGain = eqGains[index] ?? 0;
        const valueLabel = h('div', { class: 'eq-band-value', text: initialGain > 0 ? `+${initialGain}` : String(initialGain) });
        const slider = h('input', {
          class: 'slider eq-slider',
          type: 'range',
          min: String(EQ_GAIN_MIN),
          max: String(EQ_GAIN_MAX),
          step: '1',
          value: String(eqGains[index] ?? 0),
        }) as HTMLInputElement;
        slider.addEventListener('input', () => {
          eqGains[index] = Number(slider.value);
          paintEqGain(index);
          eqCurve.setGains(eqGains);
          presetSeg.querySelectorAll('.seg-btn').forEach((node) => node.classList.remove('is-on'));
          if (!eqEnabled) {
            eqEnabled = true;
            paintEqEnabled();
          }
          patchSettings({ playback: { eqEnabled: true, eqGains: [...eqGains] } });
        });
        eqValueLabels.push(valueLabel);
        eqSliders.push(slider);
        eqBands.append(
          h(
            'div',
            { class: 'eq-band' },
            valueLabel,
            slider,
            h('div', { class: 'eq-band-freq', text: freq >= 1000 ? `${freq / 1000}k` : String(freq) }),
          ),
        );
      });
      const applyEqPreset = (preset: EqPreset): void => {
        const gains = EQ_PRESETS[preset];
        gains.forEach((gain, index) => {
          eqGains[index] = gain;
        });
        eqSliders.forEach((_slider, index) => paintEqGain(index));
        eqCurve.setGains(eqGains);
        presetSeg.querySelectorAll('.seg-btn').forEach((node) => {
          node.classList.toggle('is-on', node.getAttribute('data-preset') === preset);
        });
        eqEnabled = true;
        paintEqEnabled();
        patchSettings({ playback: { eqEnabled: true, eqPreset: preset, eqGains: [...eqGains] } });
      };
      EQ_PRESET_IDS.forEach((preset) => {
        const btn = h('button', { class: `seg-btn${settings.playback.eqPreset === preset ? ' is-on' : ''}`, text: EQ_PRESET_LABELS[preset] });
        btn.setAttribute('data-preset', preset);
        btn.addEventListener('click', () => applyEqPreset(preset));
        presetSeg.append(btn);
      });
      const eqReset = h('button', { class: 'btn', text: '恢复默认' });
      eqReset.addEventListener('click', () => {
        EQ_PRESETS.flat.forEach((gain, index) => {
          eqGains[index] = gain;
        });
        eqSliders.forEach((_slider, index) => paintEqGain(index));
        eqCurve.setGains(eqGains);
        presetSeg.querySelectorAll('.seg-btn').forEach((node) => {
          node.classList.toggle('is-on', node.getAttribute('data-preset') === 'flat');
        });
        patchSettings({ playback: { eqPreset: 'flat', eqGains: [...eqGains] } });
      });
      paintEqEnabled();
      const eqSection = section(
        '均衡器',
        h(
          'div',
          { class: 'field' },
          h(
            'div',
            {},
            h('div', { class: 'field-label', text: '启用均衡器' }),
            h('div', { class: 'field-hint', text: '10 段音频增益；关闭时声音直通。手动调节会自动开启。' }),
          ),
          eqSwitch.root,
        ),
        h('div', { class: 'field is-stacked' }, h('div', { class: 'field-label', text: '预设' }), presetSeg),
        (() => {
          const manager = buildEqPresetManager({
            getGains: () => [...eqGains],
            onApply: (gains) => {
              gains.forEach((gain, index) => {
                eqGains[index] = gain;
              });
              eqSliders.forEach((_slider, index) => paintEqGain(index));
              eqCurve.setGains(eqGains);
              presetSeg.querySelectorAll('.seg-btn').forEach((node) => node.classList.remove('is-on'));
              if (!eqEnabled) {
                eqEnabled = true;
                paintEqEnabled();
              }
              patchSettings({ playback: { eqEnabled: true, eqGains: [...eqGains] } });
              toast('已应用自定义 EQ 预设');
            },
            confirmDelete: (preset) =>
              confirmDialog({
                title: '删除自定义预设',
                message: `删除「${preset.name}」？`,
                detail: '只删除预设记录，不影响当前正在使用的增益。',
                confirmText: '删除',
                tone: 'danger',
                iconName: 'trash',
              }),
          });
          this.sheetScope?.add(() => manager.dispose());
          return h(
            'div',
            { class: 'field is-stacked' },
            h('div', { class: 'field-label', text: '自定义预设' }),
            h('div', { class: 'field-hint', text: '保存当前 10 段增益为预设，下次一键还原。' }),
            manager.element,
          );
        })(),
        h(
          'div',
          { class: 'eq-curve-card' },
          eqCurve.canvas,
          h('div', { class: 'eq-curve-hint', text: '拖动曲线上的节点即可调节对应频段，滑块与曲线双向同步。' }),
        ),
        eqBands,
        h(
          'div',
          { class: 'field' },
          h('div', {}, h('div', { class: 'field-hint', text: '低频（左）→ 高频（右），单位 dB。' })),
          eqReset,
        ),
      );

      const downloadsSection = this.buildDownloadsSection(section, segField);
      const shortcutsSection = this.buildShortcutsSection(section);
      const updatesSection = this.buildUpdatesSection(section, toggleField, segField);

      // 两栏设置：左侧导航 + 右侧内容（与快捷设置的 tab 选中样式一致）
      type SettingsEntry = { key: string; label: string; node: HTMLElement };
      const entries: SettingsEntry[] = [
        { key: 'general', label: '通用', node: general },
        { key: 'appearance', label: '外观', node: appearance },
        { key: 'playback', label: '播放', node: playback },
        { key: 'shortcuts', label: '快捷键', node: shortcutsSection },
        { key: 'eq', label: '均衡器', node: eqSection },
        { key: 'downloads', label: '下载', node: downloadsSection },
        { key: 'updates', label: '更新', node: updatesSection },
        { key: 'account', label: '账号', node: accountSection },
        { key: 'data', label: '数据', node: tools },
      ];
      if (hasExperimentalSources()) entries.push({ key: 'experimental', label: '实验功能', node: experimental });
      const nav = h('div', { class: 'settings-nav' });
      const navThumb = h('div', { class: 'settings-nav-thumb' });
      nav.append(navThumb);
      const content = h('div', { class: 'settings-content' });
      const panes = new Map<string, HTMLElement>();
      const navBtns = new Map<string, HTMLButtonElement>();
      const moveNavThumb = (btn: HTMLButtonElement, animate: boolean): void => {
        navThumb.style.transition = animate ? '' : 'none';
        navThumb.style.height = `${btn.offsetHeight}px`;
        navThumb.style.transform = `translateY(${btn.offsetTop}px)`;
        if (!animate) {
          window.requestAnimationFrame(() => {
            navThumb.style.transition = '';
          });
        }
      };
      const activate = (key: string, animate = true): void => {
        navBtns.forEach((btn, name) => btn.classList.toggle('is-on', name === key));
        panes.forEach((pane, name) => {
          pane.hidden = name !== key;
        });
        const target = navBtns.get(key);
        if (target) moveNavThumb(target, animate);
      };
      entries.forEach((entry, index) => {
        const pane = h('div', { class: 'settings-pane' }, entry.node);
        pane.hidden = index !== 0;
        panes.set(entry.key, pane);
        content.append(pane);
        const btn = h('button', { class: `settings-nav-btn${index === 0 ? ' is-on' : ''}`, type: 'button', text: entry.label });
        btn.addEventListener('click', () => activate(entry.key));
        navBtns.set(entry.key, btn);
        nav.append(btn);
      });
      body.append(h('div', { class: 'settings-layout' }, nav, content));
      window.requestAnimationFrame(() => {
        const first = navBtns.get(entries[0]?.key ?? 'general');
        if (first) moveNavThumb(first, false);
      });
    });
  }

  /** 设置页「下载」：目录展示 + 更改 + 打开文件夹 + 音质选择。 */
  private buildDownloadsSection(
    section: (title: string, ...children: HTMLElement[]) => HTMLElement,
    segField: <T extends string>(
      label: string,
      options: Array<{ value: T; label: string }>,
      value: T,
      onChange: (next: T) => void,
      hint?: string,
    ) => HTMLDivElement,
  ): HTMLElement {
    const settings = getSettings();
    const directory = settings.downloads?.directory ?? '';
    const quality = settings.downloads?.quality ?? 'high';
    const qualityLabels: Record<string, string> = { lossless: '无损', high: '高品质', standard: '标准' };
    const qualityField = segField<'standard' | 'high' | 'lossless'>(
      '下载音质',
      [
        { value: 'lossless', label: '无损' },
        { value: 'high', label: '高品质' },
        { value: 'standard', label: '标准' },
      ],
      quality,
      (next) => {
        patchSettings({ downloads: { quality: next } });
        toast(`下载音质：${qualityLabels[next]}`);
      },
      '无损优先用 FLAC；平台/会员不支持时会自动降级到 320k，再不行降到 128k。只影响下载，不影响在线试听。',
    );
    const shown = directory || '系统音乐目录（默认）';
    const value = h('div', { class: 'field-hint', text: shown });
    const changeBtn = h('button', { class: 'btn', title: '选择下载目录' }, icon('folder', 16), h('span', { text: '更改' }));
    changeBtn.addEventListener('click', () => {
      const next = window.prompt('下载目录（留空表示使用 Windows 音乐目录）', directory);
      if (next === null) return;
      const trimmed = next.trim();
      try {
        const patch = { downloads: { directory: trimmed } };
        patchSettings(patch);
        value.textContent = trimmed || '系统音乐目录（默认）';
        toast(trimmed ? '下载目录已更新' : '已改回系统音乐目录');
      } catch (error) {
        toast(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    });
    const openBtn = h('button', { class: 'btn', title: '打开下载目录' }, icon('folder', 16), h('span', { text: '打开' }));
    openBtn.addEventListener('click', () => host.openDownloadFolder(directory));
    const hint = h(
      'div',
      { class: 'field-hint', text: '在线播放源会整首保存成音频文件；下载完成后会出现在「本地曲库」里。' },
    );
    return section(
      '下载',
      h('div', { class: 'field' }, h('div', {}, h('div', { class: 'field-label', text: '下载目录' }), value), changeBtn, openBtn),
      qualityField,
      hint,
    );
  }

  /**
   * 设置页「快捷键」：全局开关 + 四条录制行 + 恢复默认。
   *
   * 录制只改本地设置（立即 patchSettings），宿主注册结果由 shortcuts 事件回执，
   * 状态文案据此显示「已生效 / 已回落到 X / 组合被占用」。
   */
  private buildShortcutsSection(
    section: (title: string, ...children: HTMLElement[]) => HTMLElement,
  ): HTMLElement {
    type ShortcutRow = {
      row: HTMLDivElement;
      key: HTMLSpanElement;
      record: HTMLButtonElement;
      status: HTMLDivElement;
    };
    const rows = new Map<ShortcutAction, ShortcutRow>();
    const list = h('div', { class: 'shortcut-list' });
    let recording: ShortcutAction | null = null;
    let recordHint = '';

    function applyEnabled(value: boolean): void {
      patchSettings({ shortcuts: { enabled: value } });
      toast(value ? '已启用全局快捷键' : '已关闭全局快捷键');
      paint();
    }

    const toggles = this.pillSwitch(getSettings().shortcuts.enabled, applyEnabled);
    const enabledField = h(
      'div',
      { class: 'field', 'data-qa': 'shortcuts-enabled' },
      h(
        'div',
        {},
        h('div', { class: 'field-label', text: '启用全局快捷键' }),
        h('div', { class: 'field-hint', text: '关闭后宿主会注销全部组合、交还系统媒体键；应用在后台或最小化到托盘时同样生效。' }),
      ),
      toggles.root,
    );
    // 整行也可点：点开关自身时交给 pill-switch 的按钮处理，避免重复切换。
    enabledField.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.pill-switch')) return;
      applyEnabled(!getSettings().shortcuts.enabled);
    });

    function patchShortcut(action: ShortcutAction, binding: string): void {
      if (action === 'playPause') patchSettings({ shortcuts: { playPause: binding } });
      else if (action === 'prev') patchSettings({ shortcuts: { prev: binding } });
      else if (action === 'next') patchSettings({ shortcuts: { next: binding } });
      else patchSettings({ shortcuts: { toggleWindow: binding } });
    }

    /** 宿主回执里的 action 可能是 play_pause 之类写法，统一成小写字母再比较。 */
    function sameAction(left: string, right: ShortcutAction): boolean {
      const normalize = (value: string): string => value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      return normalize(left) === normalize(right);
    }

    function statusOf(action: ShortcutAction): { text: string; kind: string; title: string } {
      const current = getSettings();
      if (!current.shortcuts.enabled) return { text: '未启用', kind: 'muted', title: '' };
      if (!current.shortcuts[action]) return { text: '未设置', kind: 'muted', title: '' };
      const hostState = getShortcutsState();
      // 还没收到宿主回执时先按「已生效」显示（宿主会在注册完成后推送真实结果）。
      if (!hostState) return { text: '已生效', kind: 'ok', title: '' };
      if (!hostState.enabled) return { text: '未启用', kind: 'muted', title: '' };
      const item = hostState.items.find((entry) => sameAction(entry.action, action));
      if (!item) return { text: '已生效', kind: 'ok', title: '' };
      const title = item.error ?? '';
      if (item.fallback && item.applied) {
        return { text: `已回落到 ${formatShortcutForDisplay(item.applied)}`, kind: 'warn', title };
      }
      if (item.ok) return { text: '已生效', kind: 'ok', title };
      return { text: '组合被占用，可换一个', kind: 'warn', title };
    }

    function paint(): void {
      const current = getSettings();
      toggles.setValue(current.shortcuts.enabled);
      enabledField.dataset.enabled = String(current.shortcuts.enabled);
      for (const [action, refs] of rows) {
        const display = formatShortcutForDisplay(current.shortcuts[action]);
        refs.key.textContent = display || '未设置';
        refs.key.classList.toggle('is-empty', !display);
        refs.row.classList.toggle('is-recording', recording === action);
        refs.record.textContent = recording === action ? '按下新组合…（Esc 取消）' : '重新录制';
        if (recording === action) {
          refs.status.textContent = recordHint || '按下组合；Backspace / Delete 清除，Esc 取消';
          refs.status.dataset.kind = 'recording';
          refs.status.title = '';
          continue;
        }
        const info = statusOf(action);
        refs.status.textContent = info.text;
        refs.status.dataset.kind = info.kind;
        refs.status.title = info.title;
      }
    }

    function isModifierKey(key: string): boolean {
      return key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta' || key === 'AltGraph';
    }

    function onRecordKey(event: KeyboardEvent): void {
      const action = recording;
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      if (isModifierKey(event.key)) return;
      if (event.key === 'Escape') {
        stopRecording();
        return;
      }
      const noModifier = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
      if (noModifier && (event.key === 'Backspace' || event.key === 'Delete')) {
        patchShortcut(action, '');
        stopRecording();
        toast(`已清除「${SHORTCUT_LABELS[action].label}」快捷键`);
        return;
      }
      if (noModifier) {
        recordHint = '请搭配 Ctrl / Alt / Shift / Win 使用';
        paint();
        return;
      }
      const combo = shortcutBindingFromEvent(event);
      const normalized = combo ? normalizeShortcutBinding(combo, '') : '';
      if (!combo || !normalized) {
        recordHint = '这个按键不支持，请换一个';
        paint();
        return;
      }
      const label = SHORTCUT_LABELS[action].label;
      patchShortcut(action, normalized);
      stopRecording();
      toast(`快捷键已更新：${label} → ${formatShortcutForDisplay(normalized)}`);
    }

    function startRecording(action: ShortcutAction): void {
      stopRecording();
      recording = action;
      recordHint = '';
      window.addEventListener('keydown', onRecordKey, true);
      paint();
    }

    function stopRecording(): void {
      if (!recording) return;
      const previous = rows.get(recording);
      previous?.row.classList.remove('is-recording');
      recording = null;
      recordHint = '';
      window.removeEventListener('keydown', onRecordKey, true);
      paint();
    }

    for (const action of SHORTCUT_ACTIONS) {
      const meta = SHORTCUT_LABELS[action];
      const key = h('span', { class: 'shortcut-key is-empty', 'data-qa': 'shortcut-key', text: '未设置' });
      const record = h('button', {
        class: 'btn shortcut-record',
        type: 'button',
        'data-qa': 'shortcut-record',
        text: '重新录制',
      });
      const status = h('div', { class: 'shortcut-status', 'data-qa': 'shortcut-status' });
      const row = h(
        'div',
        { class: 'shortcut-row', 'data-qa': 'shortcut-row', 'data-action': action },
        h(
          'div',
          { class: 'shortcut-main' },
          h('div', { class: 'shortcut-label', text: meta.label }),
          h('div', { class: 'shortcut-hint', text: meta.hint }),
          status,
        ),
        h('div', { class: 'shortcut-side' }, key, record),
      );
      record.addEventListener('click', () => {
        if (recording === action) stopRecording();
        else startRecording(action);
      });
      rows.set(action, { row, key, record, status });
      list.append(row);
    }

    const reset = h('button', {
      class: 'btn',
      type: 'button',
      'data-qa': 'shortcut-reset',
      text: '恢复默认',
    });
    reset.addEventListener('click', () => {
      stopRecording();
      patchSettings({
        shortcuts: {
          enabled: true,
          playPause: SHORTCUT_DEFAULTS.playPause,
          prev: SHORTCUT_DEFAULTS.prev,
          next: SHORTCUT_DEFAULTS.next,
          toggleWindow: SHORTCUT_DEFAULTS.toggleWindow,
        },
      });
      toast('已恢复默认快捷键');
    });

    const unsubscribeSettings = onSettingsChange(() => paint());
    const unsubscribeShortcuts = onShortcutsState(() => paint());
    this.sheetScope?.add(unsubscribeSettings);
    this.sheetScope?.add(unsubscribeShortcuts);
    this.sheetScope?.add(() => stopRecording());
    paint();

    const wrapper = section(
      '快捷键',
      enabledField,
      list,
      h(
        'div',
        { class: 'field' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '恢复默认组合' }),
          h('div', { class: 'field-hint', text: '四条都改回 Ctrl + Alt + … 的组合，并重新启用全局快捷键。' }),
        ),
        reset,
      ),
      h(
        'div',
        { class: 'field' },
        h('div', {
          class: 'shortcut-tip',
          text: '全局快捷键在应用后台 / 最小化到托盘时也会生效；组合被系统或其它程序占用时，宿主会回落到默认组合或在行内提示占用；修改后立即生效，仅保存在本机设置里。',
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('div', {
          class: 'shortcut-tip',
          text: '系统媒体键（键盘上的播放 / 暂停、上一首、下一首）：Zilux2 是当前播放器时由 Zilux2 接管，即使系统媒体键已被 QQ 音乐等程序抢占也能用；其它程序在放歌时仍交给它们，保持系统原生「媒体键跟着当前播放器走」的习惯。',
        }),
      ),
    );
    wrapper.setAttribute('data-qa', 'shortcuts-section');
    return wrapper;
  }

  /**
   * 设置页「更新」：版本 / 状态 / 更新日志 / 下载进度 / 操作按钮 / 自动检查 / 更新方式 / 更新源。
   * 状态与进度都来自宿主推送，页面只做订阅，不轮询。
   */
  private buildUpdatesSection(
    section: (title: string, ...children: HTMLElement[]) => HTMLElement,
    toggleField: (label: string, hint: string, value: boolean, onChange: (next: boolean) => void) => HTMLDivElement,
    segField: <T extends string>(
      label: string,
      options: Array<{ value: T; label: string }>,
      value: T,
      onChange: (next: T) => void,
      hint?: string,
    ) => HTMLDivElement,
  ): HTMLElement {
    const settings = getSettings();
    const hasHost = hostAvailable();

    // 版本 / 状态 / 更新日志 / 进度：随宿主推送局部刷新。
    const versionValue = h('div', { class: 'updates-version', text: '—' });
    const statusValue = h('div', { class: 'updates-status', text: UPDATE_STATE_TEXT.idle });
    const statusDetail = h('div', { class: 'field-hint' });
    const notesValue = h('div', { class: 'updates-notes' });
    const notesField = h(
      'div',
      { class: 'field is-stacked' },
      h('div', { class: 'field-label', text: '更新日志' }),
      notesValue,
    );
    notesField.hidden = true;
    const progressFill = h('div', { class: 'updates-progress-fill' });
    const progressText = h('div', { class: 'field-hint' });
    const progressField = h(
      'div',
      { class: 'field is-stacked' },
      h('div', { class: 'field-label', text: '下载进度' }),
      h('div', { class: 'updates-progress-track' }, progressFill),
      progressText,
    );
    progressField.hidden = true;

    // 操作按钮：检查 / 下载 / 取消 / 安装 / 打开 Release 页。
    const checkBtn = h('button', { class: 'btn', title: '立即检查更新' }, icon('refresh', 16), h('span', { text: '检查更新' }));
    const downloadBtn = h('button', { class: 'btn', title: '下载新版本' }, icon('download', 16), h('span', { text: '下载更新' }));
    const cancelBtn = h('button', { class: 'btn', title: '取消下载' }, h('span', { text: '取消下载' }));
    const installBtn = h(
      'button',
      { class: 'btn is-primary', title: '安装并重启' },
      icon('download', 16),
      h('span', { text: '立即安装并重启' }),
    );
    const releaseBtn = h(
      'button',
      { class: 'btn', title: '在浏览器中打开 Release 页面' },
      icon('info', 16),
      h('span', { text: '打开 Release 页' }),
    );
    checkBtn.addEventListener('click', () => checkForUpdate());
    downloadBtn.addEventListener('click', () => downloadUpdate());
    cancelBtn.addEventListener('click', () => cancelUpdate());
    installBtn.addEventListener('click', () => {
      const current = updateSnapshot();
      const label = current.latestVersion ? `v${current.latestVersion}` : '新版本';
      void confirmDialog({
        title: '安装更新',
        message: `立即安装 ${label} 并重启 Zilux2？`,
        detail: '安装期间播放会中断，已打开的窗口会被关闭。',
        confirmText: '立即安装并重启',
        cancelText: '稍后',
      }).then((ok) => {
        if (ok) installUpdate();
      });
    });
    releaseBtn.addEventListener('click', () => openReleasePage());
    const actions = h('div', { class: 'updates-actions' }, checkBtn, downloadBtn, cancelBtn, installBtn, releaseBtn);

    // 更新源：空字符串表示使用内置默认源，失焦或回车时保存并触发一次检查。
    const repoInput = h('input', {
      class: 'updates-input',
      type: 'text',
      placeholder: 'owner/repo',
      spellcheck: 'false',
      value: settings.updates.repo,
    });
    repoInput.value = settings.updates.repo;
    const saveRepo = (): void => {
      const next = repoInput.value.trim();
      const saved = getSettings().updates.repo;
      if (next === saved) return;
      if (next !== '' && !/^[\w.-]+\/[\w.-]+$/.test(next)) {
        repoInput.value = saved;
        toast('更新源格式应为 owner/repo', 'error');
        return;
      }
      try {
        patchSettings({ updates: { repo: next } });
        if (hasHost) {
          toast(next ? `更新源已切换到 ${next}` : '已改回内置默认更新源');
          checkForUpdate();
        }
      } catch (error) {
        toast(`保存失败：${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    };
    repoInput.addEventListener('blur', saveRepo);
    repoInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      saveRepo();
      repoInput.blur();
    });
    const repoField = h(
      'div',
      { class: 'field is-stacked' },
      h('div', { class: 'field-label', text: '更新源' }),
      repoInput,
      h('div', { class: 'field-hint', text: '留空使用内置默认更新源；修改后会立即检查一次。' }),
    );

    const browserNote = h('div', { class: 'field-hint', text: '当前在浏览器中预览，更新操作不可用。' });
    browserNote.hidden = hasHost;

    const render = (current: UpdateSnapshot): void => {
      const stateText = UPDATE_STATE_TEXT[current.state];
      versionValue.textContent = current.currentVersion ? `v${current.currentVersion}` : '未知';
      const latest = current.latestVersion ? `v${current.latestVersion}` : '';
      const showLatest = latest !== '' && (current.state === 'available' || current.state === 'downloading' || current.state === 'downloaded' || current.state === 'installing');
      statusValue.textContent = showLatest ? `${stateText} · ${latest}` : stateText;
      const detail = current.error || current.notice || (current.state === 'unavailable' ? '宿主未启用更新通道。' : '');
      statusDetail.textContent = detail;
      statusDetail.hidden = detail === '';

      const notes = current.notes.trim();
      notesValue.textContent = notes;
      notesField.hidden = notes === '';

      const showProgress =
        (current.state === 'downloading' || current.state === 'downloaded') && (current.total > 0 || current.downloaded > 0);
      progressField.hidden = !showProgress;
      if (showProgress) {
        const percent = updateProgress(current);
        progressFill.style.width = `${percent}%`;
        progressText.textContent =
          current.total > 0
            ? `${formatBytes(current.downloaded)} / ${formatBytes(current.total)}（${percent}%）`
            : `已下载 ${formatBytes(current.downloaded)}`;
      }

      const busy = current.state === 'downloading' || current.state === 'installing';
      checkBtn.disabled = !hasHost || busy || current.state === 'checking';
      downloadBtn.disabled = !hasHost || busy;
      downloadBtn.hidden = !(current.state === 'available' || (current.state === 'error' && current.latestVersion !== ''));
      cancelBtn.disabled = !hasHost;
      cancelBtn.hidden = current.state !== 'downloading';
      installBtn.disabled = !hasHost;
      installBtn.hidden = current.state !== 'downloaded';
      releaseBtn.disabled = !hasHost || current.pageUrl === '';
      releaseBtn.hidden = current.pageUrl === '';
    };

    const root = section(
      '更新',
      h('div', { class: 'field' }, h('div', { class: 'field-label', text: '当前版本' }), versionValue),
      h('div', { class: 'field' }, h('div', {}, h('div', { class: 'field-label', text: '更新状态' }), statusDetail), statusValue),
      notesField,
      progressField,
      actions,
      toggleField('自动检查更新', '启动后自动检查一次，之后每 4 小时检查一次；关闭后只能手动检查。', settings.updates.autoCheck, (value) => {
        patchSettings({ updates: { autoCheck: value } });
      }),
      segField(
        '更新方式',
        [
          { value: 'auto', label: '自动安装' },
          { value: 'notify', label: '仅提示' },
        ],
        settings.updates.mode,
        (value) => {
          patchSettings({ updates: { mode: value } });
        },
        '自动安装：发现新版本后后台下载，重启时提示安装；仅提示：只提醒新版本，由你决定何时下载。',
      ),
      repoField,
      browserNote,
    );

    render(updateSnapshot());
    // 同一时间只保留一份订阅：重新打开设置页时替换旧订阅；面板被移除时自清理。
    this.updatesDispose?.();
    this.updatesDispose = onUpdateChange((next) => {
      if (!root.isConnected) {
        this.updatesDispose?.();
        return;
      }
      render(next);
    });
    return root;
  }

  /* ------------------------------------------------------------------ */
  /* 账号 / 登录                                                         */
  /* ------------------------------------------------------------------ */

  private syncAccount(): void {
    const accounts = getAccounts().filter((item) => item.loggedIn);
    this.accountBtn.textContent = '';
    if (accounts.length === 0) {
      this.accountBtn.append(icon('user', 18));
      this.accountBtn.title = '账号';
    } else {
      for (const account of accounts.slice(0, 3)) {
        this.accountBtn.append(
          account.avatarDataUrl
            ? h('img', { src: account.avatarDataUrl, alt: SOURCE_LABEL[account.source] ?? account.source })
            : h('span', { class: `account-dot source-${account.source}`, text: sourceMeta(account.source).short }),
        );
      }
      this.accountBtn.title = accounts.map((item) => `${SOURCE_LABEL[item.source]} · ${item.nickname ?? '已登录'}`).join('\n');
    }
    if (this.accountPanelOpen) this.renderAccountPanel();
  }

  private openAccountPanel(): void {
    this.renderAccountPanel();
    this.accountPanel.classList.add('is-open');
    this.accountPanelOpen = true;
  }

  private closeAccountPanel(): void {
    this.accountPanel.classList.remove('is-open');
    this.accountPanelOpen = false;
  }

  /** 账号小窗内容：一个平台一行，头像/昵称/会员 + 登录或退出。 */
  private renderAccountPanel(): void {
    const panel = this.accountPanel;
    panel.textContent = '';
    const accounts = getAccounts().filter((item) => item.loggedIn);
    if (accounts.length === 0) {
      panel.append(h('div', { class: 'account-empty', text: '还没有登录任何平台\n登录后可同步我喜欢的音乐与歌单' }));
    }
    for (const source of accountSourceIds() as AccountSource[]) {
      const info = accountOf(source);
      const action = h('button', {
        class: `btn${info.loggedIn ? '' : ' is-primary'}`,
        type: 'button',
        text: info.loggedIn ? '退出' : '登录',
      });
      action.addEventListener('click', (event) => {
        event.stopPropagation();
        if (info.loggedIn) {
          void logout(source).then(() => {
            toast('已退出');
            this.syncAccount();
          });
        } else {
          this.closeAccountPanel();
          this.openLogin(source);
        }
      });
      panel.append(
        h(
          'div',
          { class: 'account-row' },
          info.avatarDataUrl
            ? h('img', { class: 'account-row-avatar', src: info.avatarDataUrl, alt: '' })
            : h('span', { class: 'account-row-avatar account-dot', text: sourceMeta(source).short }),
          h(
            'div',
            { class: 'account-row-main' },
            h('div', { class: 'account-row-name', text: info.loggedIn ? info.nickname ?? '已登录' : `${SOURCE_LABEL[source]} 未登录` }),
            h('div', {
              class: 'account-row-sub',
              text: info.loggedIn ? `${SOURCE_LABEL[source]}${info.vip === true ? ' · 会员' : ''}` : '点击登录同步歌单',
            }),
          ),
          action,
        ),
      );
    }
  }

  /** 登录浮层：两个平台卡片 + 二维码。 */
  private openLogin(only?: AccountSource): void {
    this.closeLogin();
    if (only && sourceLoginMode(only) === 'cookie') {
      toast('这个平台需要导入 Cookie，请在设置 → 账号里操作');
      return;
    }
    const sources: AccountSource[] = only
      ? [only]
      : (accountSourceIds() as AccountSource[]).filter((id) => sourceLoginMode(id) !== 'cookie');
    const cards = sources.map((source) => this.buildLoginCard(source));
    const cardWrap = h('div', { class: 'login-grid', style: only ? 'grid-template-columns:1fr;max-width:360px' : '' }, ...cards);
    const closeBtn = h('button', { class: 'icon-btn', title: '关闭' }, icon('close', 18));
    const skipBtn = h('button', { class: 'btn', text: '不登录，直接进入' });
    const overlay = h(
      'div',
      { class: 'login' },
      h(
        'div',
        { class: 'login-card' },
        h(
          'div',
          { style: 'display:flex;align-items:flex-start;justify-content:space-between' },
          h(
            'div',
            {},
            h('h1', { class: 'login-title', text: '先登录，让 Zilux2 认识你' }),
            h('p', { class: 'login-sub', text: '用手机扫码授权，同步「我喜欢的音乐」与歌单' }),
          ),
          closeBtn,
        ),
        cardWrap,
        h('div', { class: 'login-actions' }, h('span', { class: 'login-sub', style: 'margin:0', text: '登录信息只保存在本机' }), skipBtn),
      ),
    );
    const close = (): void => this.closeLogin();
    closeBtn.addEventListener('click', close);
    skipBtn.addEventListener('click', close);
    this.loginOverlay = overlay;
    document.body.append(overlay);
  }

  private buildLoginCard(source: AccountSource): HTMLDivElement {
    const qrHost = h('div', { class: 'qr-shell' });
    const note = h('div', { class: 'qr-note', text: '点击下方按钮生成二维码' });
    const action = h('button', { class: 'btn is-primary', text: '生成二维码' });
    let session: LoginSession | null = null;
    let timer = 0;
    let cancelled = false;

    const stopPoll = (): void => {
      if (timer) window.clearInterval(timer);
      timer = 0;
    };

    const renderQr = (): void => {
      qrHost.textContent = '';
      if (!session) return;
      if (session.mode === 'image' && session.imageDataUrl) {
        qrHost.append(h('img', { src: session.imageDataUrl, alt: '二维码' }));
        return;
      }
      const canvas = h('canvas', {});
      qrHost.append(canvas);
      void QRCode.toCanvas(canvas, session.content ?? '', {
        width: 152,
        margin: 1,
        color: { dark: '#101114', light: '#ffffff' },
      });
    };

    const poll = async (): Promise<void> => {
      if (!session || cancelled) return;
      try {
        const status = await pollLogin(source, session.key);
        if (status.state === 'waiting') {
          note.textContent = '等待扫码…';
        } else if (status.state === 'scanned') {
          note.textContent = '已扫码，请在手机上确认';
        } else if (status.state === 'authorized') {
          stopPoll();
          note.textContent = '登录成功';
          toast(`${SOURCE_LABEL[source]} 已登录`);
          this.closeLogin();
          this.syncAccount();
          this.likedCache.clear();
          void refreshAccounts().then(() => {
            void this.showLiked(source as OnlineSource);
          });
        } else if (status.state === 'expired' || status.state === 'refused' || status.state === 'error') {
          stopPoll();
          note.textContent = status.message ?? (status.state === 'expired' ? '二维码已过期，请重新生成' : '登录失败');
          action.textContent = '重新生成';
        }
      } catch (err) {
        console.warn('[app] poll login failed', err);
      }
    };

    action.addEventListener('click', () => {
      action.textContent = '生成中…';
      note.textContent = '正在获取二维码…';
      void requestQr(source)
        .then((next) => {
          session = next;
          renderQr();
          note.textContent = '等待扫码…';
          action.textContent = '刷新二维码';
          stopPoll();
          timer = window.setInterval(() => void poll(), 2000);
        })
        .catch((err: unknown) => {
          console.warn('[app] request qr failed', err);
          note.textContent = '获取二维码失败，请稍后重试';
          action.textContent = '重试';
        });
    });

    const card = h(
      'div',
      { class: 'login-source' },
      h(
        'div',
        { class: 'login-source-head' },
        h('div', { class: `source-dot ${source}`, text: sourceMeta(source).short }),
        h('span', { text: SOURCE_LABEL[source] }),
      ),
      qrHost,
      note,
      action,
    );

    // 取消/切走时停轮询
    this.disposers.add(() => {
      cancelled = true;
      stopPoll();
    });
    return card;
  }

  private closeLogin(): void {
    if (!this.loginOverlay) return;
    this.loginOverlay.remove();
    this.loginOverlay = null;
  }

  /* ------------------------------------------------------------------ */
  /* 播放条                                                              */
  /* ------------------------------------------------------------------ */

  private buildPlayerBar(): void {
    this.pbCover = h('img', { class: 'pb-cover-img' });
    this.pbTitle = h('div', { class: 'pb-title', text: '未在播放' });
    this.pbArtist = h('div', { class: 'pb-artist', text: '' });
    this.pbArtist.addEventListener('click', () => {
      const current = playerState().track;
      if (!current || current.source !== 'local') return;
      this.openLocalArtist(current.artist || '未知歌手');
    });
    this.pbSource = h('span', { class: 'pb-source', text: '' });

    this.pbCoverWrap = h(
      'div',
      { class: 'pb-cover is-clickable', role: 'button', tabindex: '0', title: '查看歌词' },
      this.pbCover,
    );
    // 播放条封面：没进歌词就进，已经在歌词页就退出（同一个按钮来回切）。
    const openLyricsFromCover = () => {
      if (this.lyrics) this.closeLyrics();
      else this.openLyrics();
    };
    this.pbCoverWrap.addEventListener('click', openLyricsFromCover);
    this.pbCoverWrap.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openLyricsFromCover();
      }
    });
    this.pbMeta = h(
      'div',
      { class: 'pb-meta is-clickable', role: 'button', tabindex: '0', title: '查看歌词' },
      h('div', { class: 'pb-title-line' }, this.pbTitle, this.pbSource),
      this.pbArtist,
    );
    // 歌名/歌手这一块也能进出歌词；用 pointerdown 避免播放条展开位移吞掉 click
    this.pbMeta.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.lyrics) this.closeLyrics();
      else this.openLyrics();
    });
    this.pbMeta.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (this.lyrics) this.closeLyrics();
      else this.openLyrics();
    });

    const prevBtn = h('button', { class: 'pb-btn', title: '上一首' }, icon('prev'));
    // 悬停展开的 0.98s 里按钮仍在位移，用 pointerdown 保证按下即生效
    prevBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      prev();
    });
    this.pbPlayBtn = h('button', { class: 'pb-btn is-main', title: '播放/暂停' }, icon('play', 20));
    this.pbPlayBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });
    const nextBtn = h('button', { class: 'pb-btn', title: '下一首' }, icon('next'));
    nextBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      next();
    });

    this.pbCur = h('span', { class: 'pb-time', text: '0:00' });
    this.pbDur = h('span', { class: 'pb-time', text: '0:00' });
    this.pbFill = h('div', { class: 'track-fill' });
    const rail = h('div', { class: 'track-rail' }, this.pbFill);
    const track = h('div', { class: 'track', title: '点击或拖动跳转' }, rail);
    const seekTo = (clientX: number): void => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const state = playerState();
      seek(ratio * state.durationMs);
    };
    track.addEventListener('pointerdown', (event) => {
      track.setPointerCapture(event.pointerId);
      seekTo(event.clientX);
    });
    track.addEventListener('pointermove', (event) => {
      if (!track.hasPointerCapture(event.pointerId)) return;
      seekTo(event.clientX);
    });

    this.pbModeBtn = h('button', { class: 'pb-btn pb-mode', title: '播放模式' }, icon('repeat'));
    // 用 pointerdown：播放条悬停展开的 0.66s 里按钮还在位移，click 的 mouseup 容易落到别的元素上
    this.pbModeBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const mode = cycleMode();
      this.paintModeBtn(mode);
      toast(mode === 'list' ? '列表循环' : mode === 'single' ? '单曲循环' : '随机播放');
    });

    this.pbLikeBtn = h('button', { class: 'pb-btn pb-like', title: '收藏' }, icon('heart'));
    this.pbLikeBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = playerState().track;
      void toggleLiked().then((result) => {
        if (result === 'error') {
          toast(current?.source === 'local' ? '本地歌曲不支持收藏' : '收藏失败：请检查登录状态或平台限制', 'error');
          return;
        }
        toast(result === 'liked' ? '已加入「我喜欢的音乐」' : '已取消收藏');
        this.afterLikedChange(result === 'liked');
      });
    });

    const lyricsBtn = h(
      'button',
      { class: 'pb-btn pb-btn-lyrics', title: '歌词' },
      h('span', { class: 'pb-glyph', text: '词' }),
    );
    lyricsBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // 「词」按钮和封面一样：已经打开歌词就退出
      if (this.lyrics) this.closeLyrics();
      else this.openLyrics();
    });

    this.volumeInput = h('input', { class: 'slider', type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(getSettings().playback.volume * 100)) });
    this.volumeInput.style.width = '78px';
    this.volumeInput.addEventListener('input', () => {
      this.applyVolumeValue(Number(this.volumeInput.value));
    });
    this.volumeIcon = h('span', { class: 'volume-icon' }, icon('volume', 16));
    const volumeWrap = h('div', { class: 'volume-wrap', title: '滚轮调节音量' }, this.volumeIcon, this.volumeInput);
    // 在音量条区域直接滚滚轮调音量（上下 4%）
    volumeWrap.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const step = event.deltaY < 0 ? 4 : -4;
        this.applyVolumeValue(Number(this.volumeInput.value) + step);
      },
      { passive: false },
    );

    const downloadBtn = createDownloadEntryButton((anchor) => this.openPlaybarDownloadMenu(anchor));
    // 迷你播放器入口：只发指令，窗口切换由宿主完成并回推事件。
    this.miniBtn = h(
      'button',
      { class: 'pb-btn pb-mini', title: '迷你播放器（置顶小窗）', 'data-qa': 'mini-toggle' },
      icon('minimize', 15),
    );
    this.miniBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.toggleMiniMode();
    });
    const bar = h(
      'div',
      { class: 'playerbar' },
      this.pbCoverWrap,
      this.pbMeta,
      h('div', { class: 'pb-controls' }, prevBtn, this.pbPlayBtn, nextBtn),
      // 播放模式 / 收藏 / 下载队列常驻显示，不随播放条收起而隐藏
      h('div', { class: 'pb-actions' }, this.pbModeBtn, this.pbLikeBtn, downloadBtn),
      h('div', { class: 'pb-progress' }, this.pbCur, track, this.pbDur),
      h('div', { class: 'pb-extra' }, lyricsBtn, volumeWrap, this.miniBtn),
    );

    this.seamlessHint = h('div', { class: 'pb-seamless-hint', 'aria-live': 'polite' });
    const wrap = h('div', { class: 'playerbar-wrap' }, bar, this.seamlessHint);
    this.root.append(wrap);
    this.playerbar = bar;
    this.playerbarWrap = wrap;
    // 迷你态整条播放条即拖动区（控件/进度条除外）；双击空白处退出迷你。
    bar.addEventListener('pointerdown', (event) => {
      if (!this.miniMode || this.miniTransition !== 'idle' || event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target && target.closest('button, input, a, .slider, .pb-progress')) return;
      host.drag();
    });
    bar.addEventListener('dblclick', (event) => {
      if (!this.miniMode || this.miniTransition !== 'idle') return;
      const target = event.target as HTMLElement | null;
      if (target && target.closest('button, input, a, .slider, .pb-progress')) return;
      this.toggleMiniMode();
    });
  }

  /** 迷你播放器按钮：只向宿主发请求，实际状态以 window/miniMode 回推为准。 */
  private toggleMiniMode(): void {
    if (this.miniTransition !== 'idle') return;
    const enabled = !this.miniMode;
    this.beginMiniTransition(enabled);
    host.setMiniMode(enabled);
  }

  /**
   * 进入过渡态：宿主会把窗口从当前大小平滑补间到迷你尺寸（320/380ms），
   * 页面先切到「只有一张悬浮小卡」的过渡布局，窗口边缘围着卡片运动；
   * 宿主动画结束回推 window/miniMode 后再落到最终布局（事件丢失时 900ms 兜底）。
   */
  private beginMiniTransition(enabled: boolean): void {
    this.clearMiniFallback();
    this.miniTransition = enabled ? 'entering' : 'exiting';
    const cls = enabled ? 'is-mini-entering' : 'is-mini-exiting';
    this.root.classList.add(cls);
    document.body.classList.add(cls);
    this.miniFallbackTimer = window.setTimeout(() => {
      this.miniFallbackTimer = 0;
      this.applyMiniMode(enabled);
    }, 900);
  }

  private clearMiniFallback(): void {
    if (!this.miniFallbackTimer) return;
    window.clearTimeout(this.miniFallbackTimer);
    this.miniFallbackTimer = 0;
  }

  private endMiniTransition(): void {
    this.clearMiniFallback();
    this.miniTransition = 'idle';
    this.root.classList.remove('is-mini-entering', 'is-mini-exiting');
    document.body.classList.remove('is-mini-entering', 'is-mini-exiting');
  }

  /** 应用迷你态：只改页面布局；窗口尺寸/置顶由宿主负责。 */
  private applyMiniMode(enabled: boolean): void {
    this.endMiniTransition();
    this.miniMode = enabled;
    this.root.classList.toggle('is-mini', enabled);
    document.body.classList.toggle('is-mini', enabled);
    try {
      window.localStorage.setItem(MINI_MODE_KEY, enabled ? '1' : '0');
    } catch {
      /* 忽略：localStorage 不可用不影响布局。 */
    }
    if (enabled) {
      this.closeUpNext();
      this.closeSearchDock();
      if (this.lyrics) this.closeLyrics();
      closeDownloadPanel();
    }
    this.paintMiniBtn();
  }

  private paintMiniBtn(): void {
    if (!this.miniBtn) return;
    this.miniBtn.title = this.miniMode ? '退出迷你播放器（恢复完整窗口）' : '迷你播放器（置顶小窗）';
    this.miniBtn.replaceChildren(icon(this.miniMode ? 'maximize' : 'minimize', 15));
  }

  /* ------------------------------------------------------------------ */
  /* 待播队列                                                            */
  /* ------------------------------------------------------------------ */

  private buildUpNext(): void {
    const kicker = h('div', { class: 'upnext-kicker', text: '下一首' });
    this.upnextCover = h('img', { class: 'upnext-cover', alt: '' });
    this.upnextTitle = h('div', { class: 'upnext-title', text: '' });
    this.upnextArtist = h('div', { class: 'upnext-artist', text: '' });
    this.upnextSummary = h(
      'button',
      { class: 'upnext-summary', title: '待播队列（点击展开）' },
      kicker,
      this.upnextCover,
      h('div', { class: 'upnext-meta' }, this.upnextTitle, this.upnextArtist),
      icon('chevron', 16),
    );
    this.upnextSummary.addEventListener('click', () => {
      if (this.upnextOpen) this.closeUpNext();
      else this.openUpNext();
    });

    const skip = h('button', { class: 'btn upnext-skip', title: '切换到下一首（当前这首不再播放）', text: '跳过这首' });
    skip.addEventListener('click', () => {
      next();
      this.closeUpNext();
    });
    this.upnextList = h('ul', { class: 'upnext-list' });
    // 拖拽排序：行内 handler 见 renderUpNextList；列表空白区域接住拖拽 → 插到队尾。
    this.upnextList.addEventListener('dragover', (event) => {
      if (this.upnextDragFrom < 0) return;
      event.preventDefault();
      this.clearUpnextDropMarks();
      this.upnextList.classList.add('is-drop-tail');
    });
    this.upnextList.addEventListener('dragleave', () => {
      this.upnextList.classList.remove('is-drop-tail');
    });
    this.upnextList.addEventListener('drop', (event) => {
      if (this.upnextDragFrom < 0) return;
      event.preventDefault();
      this.commitUpnextDrop(playerState().queue.length);
    });
    this.upnextPanel = h(
      'div',
      { class: 'upnext-panel' },
      h('div', { class: 'upnext-head' }, h('div', { class: 'upnext-head-title', text: '待播队列' }), skip),
      this.upnextList,
      h('div', { class: 'upnext-hint', text: '拖动或 ↑↓ 调整顺序 · 双击播放 · 垃圾桶移出队列' }),
    );
    this.upnextRoot = h('div', { class: 'upnext is-hidden' }, this.upnextPanel, this.upnextSummary);
    // 待播与快捷设置都是挂在播放条右侧的独立胶囊
    this.playerbarWrap.append(this.upnextRoot);
    this.buildQuickSettings();
    document.addEventListener('pointerdown', (event) => {
      if (!this.upnextOpen) return;
      const target = event.target as Node | null;
      if (target && this.upnextRoot.contains(target)) return;
      this.closeUpNext();
    });
  }

  /* ------------------------------------------------------------------ */
  /* AirPlay 投送                                                        */
  /* ------------------------------------------------------------------ */

  /** 首次打开时才创建浮层并订阅宿主状态，避免无宿主浏览器预览里白跑。 */
  private ensureAirplayPop(): HTMLDivElement {
    if (this.airplayPopEl) return this.airplayPopEl;
    const pop = h('div', { class: 'airplay-pop' }) as HTMLDivElement;
    pop.hidden = true;
    const panel = createAirplayPanel({
      variant: 'popover',
      onRequestClose: () => this.closeAirplayPop(),
    });
    pop.append(panel.element);
    document.body.append(pop);
    this.airplayPopEl = pop;
    this.airplayPanel = panel;
    airplay.subscribe((snapshot) => {
      const streaming = snapshot.actives.length > 0;
      if (streaming !== this.airplayStreaming) {
        this.airplayStreaming = streaming;
        this.railButtons.get('airplay')?.classList.toggle('is-streaming', streaming);
      }
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.airplayPopOpen) return;
      const target = event.target as Node | null;
      if (!target) return;
      if (pop.contains(target)) return;
      if (this.railButtons.get('airplay')?.contains(target)) return;
      this.closeAirplayPop();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !this.airplayPopOpen) return;
      this.closeAirplayPop();
    });
    window.addEventListener('resize', () => {
      if (this.airplayPopOpen) this.positionAirplayPop();
    });
    return pop;
  }

  /** 浮层贴着 rail「投送」按钮右侧弹出，并夹在窗口内。 */
  private positionAirplayPop(): void {
    const pop = this.airplayPopEl;
    const button = this.railButtons.get('airplay');
    if (!pop || !button) return;
    const rect = button.getBoundingClientRect();
    const height = pop.offsetHeight || 420;
    const top = Math.min(Math.max(12, rect.top - 6), Math.max(12, window.innerHeight - height - 12));
    pop.style.top = `${Math.round(top)}px`;
    pop.style.left = `${Math.round(rect.right + 14)}px`;
  }

  private openAirplayPop(): void {
    if (this.airplayPopOpen) return;
    const pop = this.ensureAirplayPop();
    this.airplayPopOpen = true;
    pop.hidden = false;
    this.positionAirplayPop();
    this.airplayPanel?.activate();
    this.railButtons.get('airplay')?.classList.add('is-on');
  }

  private closeAirplayPop(): void {
    if (!this.airplayPopOpen) return;
    this.airplayPopOpen = false;
    this.airplayPanel?.deactivate();
    if (this.airplayPopEl) this.airplayPopEl.hidden = true;
    this.railButtons.get('airplay')?.classList.remove('is-on');
  }

  private toggleAirplayPop(): void {
    if (this.airplayPopOpen) this.closeAirplayPop();
    else this.openAirplayPop();
  }

  /** 快捷设置「投送」页的内嵌面板：懒创建，DOM 复用到每次切换。 */
  private ensureAirplayQuickPanel(): AirplayPanelHandle {
    if (this.airplayQuickPanel) return this.airplayQuickPanel;
    const panel = createAirplayPanel({ variant: 'settings' });
    panel.element.classList.add('is-quick');
    this.airplayQuickPanel = panel;
    airplay.subscribe((snapshot) => {
      const streaming = snapshot.actives.length > 0;
      if (streaming === this.airplayStreaming) return;
      this.airplayStreaming = streaming;
      this.railButtons.get('airplay')?.classList.toggle('is-streaming', streaming);
    });
    return panel;
  }

  /** 离开「投送」页时停掉扫描；面板 DOM 留着，切回来直接复用。 */
  private deactivateAirplayQuick(): void {
    if (!this.airplayQuickActive) return;
    this.airplayQuickActive = false;
    this.airplayQuickPanel?.deactivate();
  }

  private buildQuickSettings(): void {
    this.quickVolume = h('input', {
      class: 'slider',
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      value: String(Math.round(playerState().volume * 100)),
    });
    this.quickVolume.addEventListener('input', () => {
      const value = Number(this.quickVolume.value) / 100;
      setVolume(value);
      patchSettings({ playback: { volume: value } });
    });

    this.quickModeBtn = h('button', { class: 'quick-mode', title: '播放模式' }, icon('repeat', 15), h('span', { text: '列表循环' }));
    this.quickModeBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const mode = cycleMode();
      this.paintQuickMode(mode);
    });

    this.quickThumb = h('div', { class: 'quick-thumb' });
    // 底部五个选项只在快捷设置这个小窗口内切换内容，不再从侧边打开整页
    const tab = (
      key: 'cover' | 'lyrics' | 'settings' | 'airplay' | 'download',
      label: string,
    ): HTMLButtonElement => {
      const button = h('button', { class: 'quick-tab', type: 'button', text: label });
      this.quickTabBtns[key] = button;
      button.addEventListener('click', () => {
        this.setQuickTab(key);
      });
      return button;
    };
    const tabs = h(
      'div',
      { class: 'quick-tabs' },
      this.quickThumb,
      tab('cover', '封面'),
      tab('lyrics', '歌词'),
      tab('settings', '设置'),
      tab('airplay', '投送'),
      tab('download', '下载'),
    );
    // 面板宽度过渡/窗口缩放时，分页栏每帧都会变宽变窄；跟着重排滑块，
    // 否则选中项的白色胶囊会错位或跟着旧宽度被拉变形。
    if (typeof ResizeObserver !== 'undefined') {
      this.quickTabsObserver = new ResizeObserver(() => this.paintQuickTabThumb(false));
      this.quickTabsObserver.observe(tabs);
    }

    this.quickBodyInner = h('div', { class: 'quick-body-inner' });
    this.quickBody = h('div', { class: 'quick-body' }, this.quickBodyInner);
    const panel = h(
      'div',
      { class: 'quick-panel' },
      h('div', { class: 'quick-head', text: '快捷设置' }),
      this.quickBody,
      tabs,
    );
    const trigger = h('button', { class: 'pb-quick', title: '快捷设置', 'aria-label': '快捷设置' }, icon('equalizer', 17));
    trigger.addEventListener('click', () => {
      if (this.quickPanelOpen) this.closeQuick();
      else this.openQuick();
    });

    this.quickRoot = h('div', { class: 'quick' }, panel, trigger);
    this.quickPanelEl = panel;
    this.playerbarWrap.append(this.quickRoot);
    // 下载列表/投送设备等异步内容会在面板打开后撑高内容区，这里观察一下，
    // 有变化就用高度动画平滑接住，避免内容加载完的瞬间面板跳一截。
    if (typeof ResizeObserver !== 'undefined') {
      this.quickResizeObserver = new ResizeObserver(() => {
        // 内容区宽度会随面板宽度过渡变化：分段滑块要跟着重排，否则会停在旧位置。
        this.repaintQuickSegThumbs();
        this.scheduleQuickBodySync();
      });
      this.quickResizeObserver.observe(this.quickBodyInner);
    }
    this.paintQuickMode(playerState().mode);

    document.addEventListener('pointerdown', (event) => {
      if (!this.quickPanelOpen) return;
      const target = event.target as Node | null;
      if (target && this.quickRoot.contains(target)) return;
      this.closeQuick();
    });
  }

  /** 音质档位的显示文案（快捷面板/封面注释共用）。 */
  private qualityText(value: 'standard' | 'high' | 'lossless'): string {
    return value === 'lossless' ? '无损' : value === 'standard' ? '标准 128k' : '高 320k';
  }

  /** −/+ 双按键调节器：代替拖动滑条；返回 setValue 供复位用。 */
  private quickStepper(options: {
    value: number;
    min: number;
    max: number;
    step: number;
    format: (value: number) => string;
    onInput: (value: number) => void;
  }): { root: HTMLElement; setValue: (value: number) => void } {
    let current = options.value;
    const label = h('span', { class: 'quick-stepper-value', text: options.format(current) });
    const apply = (next: number): void => {
      const clamped = Math.max(options.min, Math.min(options.max, next));
      if (clamped === current) return;
      current = clamped;
      label.textContent = options.format(current);
      options.onInput(current);
    };
    const button = (text: string, delta: number, title: string): HTMLButtonElement => {
      const node = h('button', { class: 'quick-stepper-btn', title, 'aria-label': title, text });
      node.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      node.addEventListener('click', () => apply(current + delta));
      return node;
    };
    const root = h(
      'div',
      { class: 'quick-stepper' },
      button('−', -options.step, '减小'),
      label,
      button('＋', options.step, '增大'),
    );    // 数值框本身也能左右拖动调整（不用点 +/- 按钮）
    let dragging = false;
    let dragPointer = -1;
    let dragStartX = 0;
    let dragStartValue = 0;
    const span = Math.max(1, options.max - options.min);
    const quantize = (value: number): number => {
      const stepped = Math.round((value - options.min) / options.step) * options.step + options.min;
      return Math.max(options.min, Math.min(options.max, stepped));
    };
    root.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('.quick-stepper-btn')) return;
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      dragPointer = event.pointerId;
      dragStartX = event.clientX;
      dragStartValue = current;
      root.classList.add('is-dragging');
      try {
        root.setPointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
    });
    root.addEventListener('pointermove', (event) => {
      if (!dragging || event.pointerId !== dragPointer) return;
      event.preventDefault();
      const dx = event.clientX - dragStartX;
      apply(quantize(dragStartValue + (dx / 180) * span));
    });
    const endDrag = (event: PointerEvent): void => {
      if (!dragging || event.pointerId !== dragPointer) return;
      dragging = false;
      dragPointer = -1;
      root.classList.remove('is-dragging');
      try {
        root.releasePointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
    };
    root.addEventListener('pointerup', endDrag);
    root.addEventListener('pointercancel', endDrag);

    return {
      root,
      setValue: (value: number) => {
        current = Math.max(options.min, Math.min(options.max, value));
        label.textContent = options.format(current);
      },
    };
  }

  /** 面板内容按底部选项切换：封面放大预览 / 当前歌词 / 音量与模式 / 投送 / 下载。 */
  private renderQuickBody(): void {
    if (!this.quickBody) return;
    const current = playerState().track;
    this.quickRenderKey = `${this.quickTab}:${current ? `${current.source}:${current.id}` : ''}`;
    // 「下载」页需要把快捷面板加宽（见 download-queue-embed.css）。
    this.quickRoot.classList.toggle('is-download', this.quickTab === 'download');
    if (this.quickTab !== 'download') this.downloadQuickView?.deactivate();
    const body = this.quickBodyInner ?? this.quickBody;
    body.textContent = '';
    if (this.quickTab === 'download') {
      // 第 5 页：复用下载队列的可嵌入视图（同一份状态与轮询，不另起一套逻辑）。
      const view = this.quickDownloadView();
      body.append(view.element);
      view.activate();
      return;
    }
    if (this.quickTab === 'airplay') {
      const panel = this.ensureAirplayQuickPanel();
      body.append(panel.element);
      this.airplayQuickActive = true;
      panel.activate();
      return;
    }
    if (this.quickTab === 'cover') {
      const track = playerState().track;
      const cover = h('img', { class: 'quick-cover', alt: '' });
      if (track) cover.src = onlineArtwork(track);
      if (track && !track.cover) {
        void lookupCover(track).then((found) => {
          if (!found) return;
          track.cover = found;
          cover.src = onlineArtwork(track);
        });
      }
      const like = h('button', { class: 'quick-like', title: '收藏', 'aria-label': '收藏' }, icon('heart', 16));
      like.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const current = playerState().track;
        void toggleLiked().then((result) => {
          if (result === 'error') {
            toast(current?.source === 'local' ? '本地歌曲不支持收藏' : '收藏失败：请检查登录状态或平台限制', 'error');
            return;
          }
          toast(result === 'liked' ? '已加入「我喜欢的音乐」' : '已取消收藏');
          this.afterLikedChange(result === 'liked');
          this.paintQuickLike(result === 'liked');
        });
      });
      this.quickLikeBtn = like;
      this.paintQuickLike(playerState().liked);
      body.append(
        cover,
        h(
          'div',
          { class: 'quick-cover-foot' },
          h(
            'div',
            { class: 'quick-track' },
            h('div', { class: 'quick-track-title', text: track?.title ?? '未在播放' }),
            h('div', { class: 'quick-track-artist', text: track?.artist ?? '' }),
            h('div', {
              class: 'quick-track-note',
              text: this.qualityNoteOf(),
            }),
          ),
          like,
        ),
      );
      const bgThumb = h('div', { class: 'quick-seg-thumb' });
      const bgBtns: HTMLButtonElement[] = [];
      const paintBg = (): void => {
        const index = this.appBgMode === 'none' ? 0 : 1;
        const button = bgBtns[index];
        if (!button) return;
        bgThumb.style.width = `${button.offsetWidth}px`;
        bgThumb.style.transform = `translateX(${button.offsetLeft}px)`;
        bgBtns.forEach((item, i) => item.classList.toggle('is-on', i === index));
      };
      const bgBtn = (label: string, on: boolean): HTMLButtonElement => {
        const button = h('button', { class: 'quick-seg-btn', type: 'button', text: label });
        button.addEventListener('click', () => {
          this.setAppBg(on);
          paintBg();
        });
        bgBtns.push(button);
        return button;
      };
      const bgSeg = h(
        'div',
        { class: 'quick-seg-slider' },
        bgThumb,
        bgBtn('关闭', false),
        bgBtn('随歌曲封面', true),
      );
      body.append(
        h(
          'div',
          { class: 'quick-cell is-wide' },
          h('div', { class: 'quick-cell-title', text: '背景' }),
          bgSeg,
        ),
      );
      window.requestAnimationFrame(paintBg);
      return;
    }
    if (this.quickTab === 'lyrics') {
      const track = playerState().track;
      const trackKey = track ? `${track.source}:${track.id}` : '';
      primeLyrics(track);
      const sourceValue = h('button', {
        class: 'quick-value quick-source-btn',
        type: 'button',
        text: currentLyricSource() || '读取中…',
        title: '点击选择歌词来源',
      });
      sourceValue.dataset.role = 'lyric-source';
      sourceValue.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      sourceValue.addEventListener('click', () => openLyricPicker(playerState().track));
      const matchValue = h('span', { class: 'quick-value', text: lyricMatchText() });
      matchValue.dataset.role = 'lyric-match';
      const offsetStepper = this.quickStepper({
        value: lyricOffsetOf(trackKey),
        min: -6000,
        max: 6000,
        step: 100,
        format: (value) => this.formatOffset(value),
        onInput: (value) => {
          setLyricOffset(value, trackKey);
          updateCurrentLyricLine();
        },
      });
      const thresholdStepper = this.quickStepper({
        value: Math.round(lyricMatchMinScore() * 100),
        min: 30,
        max: 95,
        step: 5,
        format: (value) => `${value}%`,
        onInput: (value) => {
          setLyricMatchMinScore(value / 100);
          window.setTimeout(() => {
            const node = this.quickBody.querySelector<HTMLElement>('[data-role="lyric-match"]');
            if (node) node.textContent = lyricMatchText();
          }, 450);
        },
      });
      const reset = h('button', { class: 'quick-reset', text: '复位' });
      reset.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      reset.addEventListener('click', () => {
        setLyricOffset(0, trackKey);
        offsetStepper.setValue(0);
        updateCurrentLyricLine();
      });
      const bgModes: Array<{ id: 'solid' | 'cover' | 'gradient'; label: string }> = [
        { id: 'solid', label: '纯色' },
        { id: 'cover', label: '封面色' },
        { id: 'gradient', label: '自动渐变' },
      ];
      const bgThumb = h('div', { class: 'quick-seg-thumb' });
      const bgBtns: HTMLButtonElement[] = bgModes.map((mode) => {
        const btn = h('button', {
          class: `quick-seg-btn${mode.id === lyricsBackgroundMode() ? ' is-on' : ''}`,
          type: 'button',
          text: mode.label,
        }) as HTMLButtonElement;
        btn.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        btn.addEventListener('click', () => {
          setLyricsBackgroundMode(mode.id);
          paintBgMode();
        });
        return btn;
      });
      const paintBgMode = (): void => {
        const current = lyricsBackgroundMode();
        const index = Math.max(0, bgModes.findIndex((item) => item.id === current));
        bgBtns.forEach((btn, i) => btn.classList.toggle('is-on', i === index));
        const active = bgBtns[index];
        if (!active) return;
        bgThumb.style.width = `${active.offsetWidth}px`;
        bgThumb.style.transform = `translateX(${active.offsetLeft}px)`;
      };
      const bgControl = h('div', { class: 'quick-seg-slider' }, bgThumb, ...bgBtns);
      paintBgMode();
      window.requestAnimationFrame(() => paintBgMode());
      // 歌词动效：和「歌词颜色」同一套白色滑块分段样式
      const growModes: Array<{ id: 'off' | 'soft' | 'bounce' | 'wild'; label: string }> = [
        { id: 'off', label: '关闭' },
        { id: 'soft', label: '柔和' },
        { id: 'bounce', label: '弹跳' },
        { id: 'wild', label: '强烈' },
      ];
      const growThumb = h('div', { class: 'quick-seg-thumb' });
      const growBtns: HTMLButtonElement[] = growModes.map((mode) => {
        const btn = h('button', {
          class: `quick-seg-btn${mode.id === lyricGrowMode() ? ' is-on' : ''}`,
          type: 'button',
          text: mode.label,
        }) as HTMLButtonElement;
        btn.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        btn.addEventListener('click', () => {
          setLyricGrowMode(mode.id);
          paintGrowMode();
        });
        return btn;
      });
      const paintGrowMode = (): void => {
        const current = lyricGrowMode();
        const index = Math.max(0, growModes.findIndex((item) => item.id === current));
        growBtns.forEach((btn, i) => btn.classList.toggle('is-on', i === index));
        const active = growBtns[index];
        if (!active) return;
        growThumb.style.width = `${active.offsetWidth}px`;
        growThumb.style.transform = `translateX(${active.offsetLeft}px)`;
      };
      const growControl = h('div', { class: 'quick-seg-slider' }, growThumb, ...growBtns);
      paintGrowMode();
      window.requestAnimationFrame(() => paintGrowMode());
      const cell = (title: string, wide: boolean, ...children: HTMLElement[]): HTMLElement =>
        h(
          'div',
          { class: `quick-cell${wide ? ' is-wide' : ''}` },
          h('div', { class: 'quick-cell-title', text: title }),
          ...children,
        );
      // 歌词样式：经典 / 上浮 / 波浪 / 摇曳 / 打字机 / 旋入（只对「关闭」档的 DOM 歌词生效，画布效果下没有意义）。
      // 这些样式只改「播放动画」（字的进出场与律动），颜色仍归上面的「歌词颜色」管；新增样式的制作模板见 lyricStyle.ts 顶部注释。
      const styleThumb = h('div', { class: 'quick-seg-thumb' });
      const styleBtns: HTMLButtonElement[] = LYRIC_STYLES.map((item) => {
        const btn = h('button', {
          class: `quick-seg-btn${item.id === lyricStyle() ? ' is-on' : ''}`,
          type: 'button',
          text: item.label,
          title: item.hint,
        }) as HTMLButtonElement;
        btn.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        btn.addEventListener('click', () => {
          setLyricStyle(item.id);
          paintLyricStyle();
        });
        return btn;
      });
      const paintLyricStyle = (): void => {
        const index = Math.max(0, LYRIC_STYLES.findIndex((item) => item.id === lyricStyle()));
        styleBtns.forEach((btn, i) => btn.classList.toggle('is-on', i === index));
        const active = styleBtns[index];
        if (!active) return;
        styleThumb.style.width = `${active.offsetWidth}px`;
        styleThumb.style.transform = `translateX(${active.offsetLeft}px)`;
      };
      const styleControl = h('div', { class: 'quick-seg-slider quick-lyric-style-seg' }, styleThumb, ...styleBtns);
      paintLyricStyle();
      window.requestAnimationFrame(() => paintLyricStyle());
      // 动效（逐字生长）+ 歌词样式：只对「关闭」档的 DOM 歌词生效，画布效果（纯字/房间）下没有意义，因此仅关闭档显示。
      const growCell = cell('动效', true, growControl);
      const styleCell = cell('歌词样式', true, styleControl);
      const lyricDomCells = [styleCell, growCell];
      const syncGrowCell = (): void => {
        const hidden = lyricsLumiereMode() !== 'off';
        if (lyricDomCells.every((el) => el.classList.contains('is-hidden') === hidden)) return;
        const inner = this.quickBodyInner;
        const before = this.quickPanelOpen && inner ? inner.offsetHeight : 0;
        for (const el of lyricDomCells) {
          el.classList.toggle('is-hidden', hidden);
          el.classList.remove('is-reveal');
          if (!hidden) {
            void el.offsetWidth;
            el.classList.add('is-reveal');
          }
        }
        if (before && inner) this.animateQuickBodyHeight(before, inner.offsetHeight);
      };
      syncGrowCell();

      // 效果设置：文字/房间共用同一行、同一套按钮，点开的是当前效果对应的调节面板。
      //   「关闭」档没有可调项，整行收起（用高度动画平滑过渡，见 syncEffectSettingsCell）。
      const EFFECT_SETTINGS_META: Record<string, { action: string; hint: string }> = {
        text: {
          action: '文字设置…',
          hint: '纯字：字号观感、亮度、辉光、崩解、残影、光感与画质',
        },
        room: {
          action: '房间设置…',
          hint: '房间：歌词字体/颜色/离散度、背景渐变、地毯、镜头与动效',
        },
      };
      const effectSettingsBtn = h('button', {
        class: 'quick-value quick-text-settings-btn',
        type: 'button',
        text: '打开调节…',
      }) as HTMLButtonElement;
      effectSettingsBtn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      effectSettingsBtn.addEventListener('click', () => {
        const mode = lyricsLumiereMode();
        if (mode === 'off') return;
        this.closeQuick();
        const open = mode === 'text' ? openTextSettingsSheet : openRoomSettingsSheet;
        window.setTimeout(() => open(), 140);
      });
      const effectSettingsHint = h('span', { class: 'quick-cell-hint', text: '' });
      const effectSettingsCell = h(
        'div',
        { class: 'quick-cell is-wide' },
        h(
          'div',
          { class: 'quick-cell-head' },
          h('div', { class: 'quick-cell-title', text: '效果设置' }),
          effectSettingsBtn,
        ),
        effectSettingsHint,
      );
      const paintEffectSettingsCell = (): void => {
        const mode = lyricsLumiereMode();
        const meta = EFFECT_SETTINGS_META[mode];
        effectSettingsBtn.textContent = meta ? meta.action : '打开调节…';
        effectSettingsBtn.title = meta ? meta.hint : '当前播放效果没有可调项';
        effectSettingsHint.textContent = meta ? meta.hint : '';
      };
      let effectCellHideTimer = 0;
      const syncEffectSettingsCell = (): void => {
        if (effectCellHideTimer) {
          window.clearTimeout(effectCellHideTimer);
          effectCellHideTimer = 0;
          effectSettingsCell.classList.remove('is-collapsing');
        }
        const hidden = !EFFECT_SETTINGS_META[lyricsLumiereMode()];
        const wasHidden = effectSettingsCell.classList.contains('is-hidden');
        paintEffectSettingsCell();
        if (wasHidden === hidden) return;
        const inner = this.quickBodyInner;
        const canAnimate = this.quickPanelOpen && !!inner && inner.offsetHeight > 0;
        if (!canAnimate) {
          effectSettingsCell.classList.toggle('is-hidden', hidden);
          return;
        }
        const before = inner.offsetHeight;
        if (hidden) {
          // 隐藏方向：先让整行淡出上浮，再把高度收掉——和展开时的动画对称
          effectSettingsCell.classList.remove('is-reveal');
          effectSettingsCell.classList.add('is-collapsing');
          effectCellHideTimer = window.setTimeout(() => {
            effectCellHideTimer = 0;
            effectSettingsCell.classList.remove('is-collapsing');
            effectSettingsCell.classList.add('is-hidden');
            this.animateQuickBodyHeight(before, inner.offsetHeight);
          }, 130);
          return;
        }
        effectSettingsCell.classList.toggle('is-hidden', false);
        effectSettingsCell.classList.remove('is-reveal');
        // 重新触发一次入场动画（显示时轻微上浮淡入）
        void effectSettingsCell.offsetWidth;
        effectSettingsCell.classList.add('is-reveal');
        this.animateQuickBodyHeight(before, inner.offsetHeight);
      };
      // 播放效果（纯字）：folia 绘光的文字特效，和上面两个控件同一套白色滑块样式
      const effectThumb = h('div', { class: 'quick-seg-thumb' });
      const effectBtns: HTMLButtonElement[] = LUMIERE_MODES.map((mode) => {
        const btn = h('button', {
          class: `quick-seg-btn${mode.id === lyricsLumiereMode() ? ' is-on' : ''}`,
          type: 'button',
          text: mode.label,
          title: mode.hint,
        }) as HTMLButtonElement;
        btn.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        btn.addEventListener('click', () => {
          setLyricsLumiereMode(mode.id);
          paintEffectMode();
          syncGrowCell();
          syncEffectSettingsCell();
        });
        return btn;
      });
      const paintEffectMode = (): void => {
        const current = lyricsLumiereMode();
        const index = Math.max(0, LUMIERE_MODES.findIndex((item) => item.id === current));
        effectBtns.forEach((btn, i) => btn.classList.toggle('is-on', i === index));
        const active = effectBtns[index];
        if (!active) return;
        effectThumb.style.width = `${active.offsetWidth}px`;
        effectThumb.style.transform = `translateX(${active.offsetLeft}px)`;
      };
      const effectControl = h('div', { class: 'quick-seg-slider quick-effect-seg' }, effectThumb, ...effectBtns);
      paintEffectMode();
      syncEffectSettingsCell();
      window.requestAnimationFrame(() => paintEffectMode());
      body.append(
        h(
          'div',
          { class: 'quick-grid' },
          cell('歌词来源', true, sourceValue),
          cell('跨平台匹配', true, matchValue),
          cell('匹配度阈值', false, thresholdStepper.root),
          cell('时间轴偏移', false, offsetStepper.root, reset),
          cell('歌词颜色', true, bgControl),
          styleCell,
          growCell,
          cell('播放效果', true, effectControl),
          effectSettingsCell,
        ),
      );
      return;
    }
    // 音质按当前播放平台动态渲染：网易云/QQ 各自的档位名称不同，酷狗只有平台默认
    const qualityTrack = playerState().track;
    const qualitySource = qualityTrack?.source ?? sourceIds()[0] ?? 'netease';
    const qualityOptions = sourceQualities(qualitySource);
    const qualitySelected = qualityForSource(qualitySource);
    const qualityText = (value: string): string => {
      const option = qualityOptions.find((item) => item.id === value);
      return option ? `${option.label} · ${option.detail}` : value;
    };
    const qualityValue = h('span', { class: 'quick-value', text: qualityText(qualitySelected) });
    // 和歌词颜色/背景保持同一套白色滑块分段样式
    const qualityThumb = h('div', { class: 'quick-seg-thumb' });
    const qualityBtns: HTMLButtonElement[] = [];
    const paintQualityThumb = (): void => {
      const active = qualityBtns.find((item) => item.classList.contains('is-on')) ?? qualityBtns[0];
      if (!active) return;
      qualityThumb.style.width = `${active.offsetWidth}px`;
      qualityThumb.style.transform = `translateX(${active.offsetLeft}px)`;
    };
    qualityOptions.forEach((option) => {
      const btn = h('button', {
        class: `quick-seg-btn${qualitySelected === option.id ? ' is-on' : ''}`,
        type: 'button',
        text: option.label,
        title: option.detail,
      });
      btn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      btn.addEventListener('click', () => {
        qualityBtns.forEach((node) => node.classList.toggle('is-on', node === btn));
        paintQualityThumb();
        qualityValue.textContent = qualityText(option.id);
        setQualityForSource(qualitySource, option.id as StreamQuality);
        patchSettings({ playback: { quality: option.id as StreamQuality } });
      });
      qualityBtns.push(btn);
    });
    const qualitySeg = h('div', { class: 'quick-seg-slider' }, qualityThumb, ...qualityBtns);
    window.requestAnimationFrame(paintQualityThumb);
    const volumeStepper = this.quickStepper({
      value: Math.round(playerState().volume * 100),
      min: 0,
      max: 100,
      step: 5,
      format: (value) => `${value}%`,
      onInput: (value) => {
        setVolume(value / 100);
        patchSettings({ playback: { volume: value / 100 } });
      },
    });
    const cell = (title: string, wide: boolean, ...children: HTMLElement[]): HTMLElement =>
      h(
        'div',
        { class: `quick-cell${wide ? ' is-wide' : ''}` },
        h('div', { class: 'quick-cell-title', text: title }),
        ...children,
      );
    // 音频效果：可视化 EQ 曲线（可拖拽节点）+ 预设 + 播放渐变开关。
    const quickEqSwitch = this.pillSwitch(getSettings().playback.eqEnabled, (next) => {
      patchSettings({ playback: { eqEnabled: next } });
      quickEqCurve.setEnabled(next);
    });
    const quickPresetSeg = h('div', { class: 'quick-seg-slider quick-eq-presets' });
    const quickPresetBtns: HTMLButtonElement[] = [];
    const quickEqCurve = createEqCurve({
      height: 104,
      interactive: true,
      onChange: () => {
        quickPresetBtns.forEach((node) => node.classList.remove('is-on'));
        quickEqSwitch.setValue(true);
      },
      onCommit: (nextGains) => {
        patchSettings({ playback: { eqEnabled: true, eqGains: [...nextGains] } });
      },
    });
    quickEqCurve.setGains(getSettings().playback.eqGains);
    quickEqCurve.setEnabled(getSettings().playback.eqEnabled);
    EQ_PRESET_IDS.forEach((preset) => {
      const btn = h('button', {
        class: `quick-seg-btn${getSettings().playback.eqPreset === preset ? ' is-on' : ''}`,
        type: 'button',
        text: EQ_PRESET_LABELS[preset],
      });
      btn.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      btn.addEventListener('click', () => {
        quickPresetBtns.forEach((node) => node.classList.toggle('is-on', node === btn));
        quickEqSwitch.setValue(true);
        quickEqCurve.setGains(EQ_PRESETS[preset]);
        patchSettings({ playback: { eqEnabled: true, eqPreset: preset, eqGains: [...EQ_PRESETS[preset]] } });
      });
      quickPresetBtns.push(btn);
      quickPresetSeg.append(btn);
    });
    const quickFadeSwitch = this.pillSwitch(getSettings().playback.fadeEnabled, (next) => {
      patchSettings({ playback: { fadeEnabled: next } });
    });
    const quickVocalSwitch = this.pillSwitch(getSettings().playback.fadeVocal, (next) => {
      patchSettings({ playback: { fadeVocal: next } });
    });
    body.append(
      h(
        'div',
        { class: 'quick-grid' },
        cell('音量', false, volumeStepper.root),
        cell('播放模式', false, this.quickModeBtn),
        cell('音质', true, qualitySeg),
        cell(
          '均衡器',
          true,
          h('div', { class: 'quick-cell-head' }, h('span', { class: 'quick-cell-hint', text: '拖动曲线节点 · 10 段实时调节' }), quickEqSwitch.root),
          h('div', { class: 'quick-eq-curve' }, quickEqCurve.canvas),
          quickPresetSeg,
        ),
        cell('播放/暂停渐变', false, quickFadeSwitch.root),
        cell('人声保留淡出', false, quickVocalSwitch.root),
      ),
      h('div', {
        class: 'quick-hint',
        text: `${sourceMeta(qualitySource).label} · ${
          qualityOptions.length > 1 ? '音质以账号权限为准，不可用时自动降级' : '该平台暂不支持切换音质，跟随账号权限'
        }`,
      }),
    );
  }

  /** 快捷设置「下载」页的视图单例：首次进页面时创建，切走只 deactivate（不重建 DOM）。 */
  private quickDownloadView(): DownloadQueueView {
    if (!this.downloadQuickView) this.downloadQuickView = createDownloadQueueView();
    return this.downloadQuickView;
  }

  /** 快捷设置内容区高度变化时做一次平滑过渡（内容显隐/切 tab 都用它，避免面板跳一下）。 */
  private animateQuickBodyHeight(from: number, to: number): void {
    const body = this.quickBody;
    if (!body || from <= 0) return;
    if (this.quickHeightTimer) window.clearTimeout(this.quickHeightTimer);
    body.style.height = `${from}px`;
    void body.offsetHeight;
    body.style.height = `${to}px`;
    this.quickHeightTimer = window.setTimeout(() => {
      this.quickHeightTimer = 0;
      if (!this.quickBody) return;
      this.quickBody.style.height = '';
      this.quickBody.style.overflow = '';
    }, 340);
  }

  /**
   * 切 tab 时先按「目标宽度」量一次内容自然高度。
   * 面板宽度在不同 tab 间不同（封面/歌词/设置 348px、投送 384px、下载 508px），
   * 若按旧宽度测量，宽度过渡结束时内容会重排、高度再跳一截；这里临时关掉宽度过渡，
   * 让布局按 tab 类名对应的目标宽度落下来拿到真实高度，再把宽度退回旧值交给 CSS 过渡。
   */
  private measureQuickBodyHeightAtTargetWidth(fromWidth: number): number {
    const inner = this.quickBodyInner ?? this.quickBody;
    const panel = this.quickPanelEl;
    if (!inner || !panel) return 0;
    if (!this.quickPanelOpen || fromWidth <= 0) return inner.offsetHeight;
    panel.classList.add('is-resizing');
    panel.style.width = '';
    const width = panel.getBoundingClientRect().width;
    const height = inner.offsetHeight;
    try {
      panel.style.width = `${fromWidth}px`;
      void panel.offsetWidth;
    } finally {
      panel.classList.remove('is-resizing');
      panel.style.width = '';
    }
    // 宽度确实在变：记一个「宽度过渡中」的窗口，这期间内容重排导致的高度变化先攒着，
    // 等宽度落定后再用一段短动画补上（下载列表/投送设备这类异步内容也能平滑到位）。
    if (Math.abs(width - fromWidth) > 0.5) {
      // 过渡期间禁止内容滑块做补间，改由 ResizeObserver 每帧即时贴合，避免视觉滞后。
      panel.classList.add('is-width-animating');
      if (this.quickWidthBusyTimer) window.clearTimeout(this.quickWidthBusyTimer);
      this.quickWidthBusyTimer = window.setTimeout(() => {
        this.quickWidthBusyTimer = 0;
        panel.classList.remove('is-width-animating');
        this.repaintQuickSegThumbs();
        if (this.quickBodySyncPending) {
          this.quickBodySyncPending = false;
          this.syncQuickBodyHeight();
        }
      }, 380);
    }
    return height;
  }

  /** 内容因异步加载/宽度过渡重排而变高变矮时，补一段高度动画，避免到位瞬间跳一下。 */
  private scheduleQuickBodySync(): void {
    if (!this.quickPanelOpen) return;
    if (this.quickWidthBusyTimer) {
      this.quickBodySyncPending = true;
      return;
    }
    if (this.quickBodySyncRaf) return;
    this.quickBodySyncRaf = window.requestAnimationFrame(() => {
      this.quickBodySyncRaf = 0;
      this.syncQuickBodyHeight();
    });
  }

  private syncQuickBodyHeight(): void {
    if (!this.quickPanelOpen || this.quickHeightTimer) return;
    const inner = this.quickBodyInner ?? this.quickBody;
    const body = this.quickBody;
    if (!inner || !body) return;
    const natural = inner.offsetHeight;
    const current = body.getBoundingClientRect().height;
    if (natural <= 0 || Math.abs(natural - current) < 1.5) return;
    this.animateQuickBodyHeight(current, natural);
  }

  /**
   * 快捷设置内容里的分段滑块（背景/歌词模式/音质…）在面板宽度变化时按当前布局重新贴合。
   * 这些控件由各自页面在渲染时定位滑块，宽度过渡期间若不再重排，就会停在旧位置/旧宽度，
   * 表现为「开关的白色背景错位或变形」；统一在这里按选中项重排可覆盖所有分段控件。
   */
  private repaintQuickSegThumbs(): void {
    const body = this.quickBody;
    if (!body) return;
    body.querySelectorAll<HTMLElement>('.quick-seg-slider').forEach((seg) => {
      const thumb = seg.querySelector<HTMLElement>('.quick-seg-thumb');
      const active = seg.querySelector<HTMLElement>('.quick-seg-btn.is-on');
      if (!thumb || !active) return;
      thumb.style.width = `${active.offsetWidth}px`;
      thumb.style.transform = `translateX(${active.offsetLeft}px)`;
    });
  }

  private setQuickTab(key: 'cover' | 'lyrics' | 'settings' | 'airplay' | 'download'): void {
    const body = this.quickBody;
    const before = body ? body.offsetHeight : 0;
    const beforeWidth = this.quickPanelEl ? this.quickPanelEl.getBoundingClientRect().width : 0;
    if (key !== 'airplay') this.deactivateAirplayQuick();
    this.quickTab = key;
    this.quickRoot.classList.toggle('is-airplay', key === 'airplay');
    if (key === 'lyrics') primeLyrics(playerState().track);
    this.renderQuickBody();
    // 内容高度变化用动画过渡，避免面板一下子跳大/跳小；
    // 目标高度按切完之后的「目标宽度」量，否则宽度过渡结束时内容重排、高度会再跳一下。
    if (body && before > 0) {
      this.animateQuickBodyHeight(before, this.measureQuickBodyHeightAtTargetWidth(beforeWidth));
    }
    const button = this.quickTabBtns[key];
    if (!button) return;
    Object.entries(this.quickTabBtns).forEach(([name, element]) => {
      element.classList.toggle('is-on', name === key);
    });
    this.paintQuickTabThumb(true);
  }

  /**
   * 把分页栏的白色滑块对齐到当前选中项。
   * animate=false 用于面板宽度过渡中的跟手重排：此时每帧都要即时贴住按钮，
   * 不能走 CSS 过渡，否则滑块会跟不上分页栏宽度、看起来错位甚至被拉变形。
   */
  private paintQuickTabThumb(animate: boolean): void {
    const button = this.quickTabBtns[this.quickTab];
    if (!button || !this.quickThumb) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.quickThumb.style.transition = animate && !reduce ? '' : 'none';
    this.quickThumb.style.width = `${button.offsetWidth}px`;
    this.quickThumb.style.transform = `translateX(${button.offsetLeft}px)`;
  }

  /** 面板打开时跟随播放状态刷新：封面/歌词只在切歌或切 tab 时重建，避免图片反复重载闪烁。 */
  private paintAppBg(track: OnlineTrack | null): void {
    const mode = this.appBgMode;
    if (mode === 'none') {
      // 先只摘类名让 opacity 过渡跑完，真正隐藏交给 setBackgroundMode 里的延时
      this.root.classList.remove('is-app-bg');
      return;
    }
    // 跟随封面时必须先有正在播放的歌；自定义图片则随时可以铺。
    const source = mode === 'image' ? this.appBgImage : track ? onlineArtwork(track) : '';
    if (!source) {
      this.root.classList.remove('is-app-bg');
      return;
    }
    this.appBgEl.style.display = '';
    const bgKey =
      mode === 'image'
        ? `image:${source.length}:${source.slice(-28)}`
        : `${track?.source ?? ''}:${track?.id ?? ''}:${track?.cover ?? ''}`;
    if (bgKey !== this.appBgKey) {
      // 双层交替：新图先铺到隐藏层，再交叉淡入淡出，避免切歌时背景硬切
      const next = this.appBgLayers[1 - this.appBgLayer];
      const prev = this.appBgLayers[this.appBgLayer];
      const image = next.firstElementChild;
      if (image instanceof HTMLElement) {
        image.style.backgroundImage = `url("${source}")`;
      }
      next.classList.add('is-on');
      prev.classList.remove('is-on');
      this.appBgLayer = 1 - this.appBgLayer;
      this.appBgKey = bgKey;
    }
    this.root.classList.add('is-app-bg');
  }

  /**
   * 设置整站背景模式（关闭 / 跟随封面 / 自定义图片）。
   * 图片模式没有图片时会自动回落到跟随封面，避免设置里写着"自定义图片"却什么都没有。
   */
  private setBackgroundMode(mode: AppBgMode): void {
    this.appBgMode = mode;
    writeAppBgMode(mode);
    if (mode !== 'none') {
      window.clearTimeout(this.appBgHideTimer);
      this.appBgEl.style.display = '';
    }
    this.paintAppBg(playerState().track);
    if (mode === 'none') {
      // 等淡出动画走完（0.7s）再真正摘掉背景层，保证关闭时也有过渡
      window.clearTimeout(this.appBgHideTimer);
      this.appBgHideTimer = window.setTimeout(() => {
        if (this.appBgMode === 'none') this.appBgEl.style.display = 'none';
      }, 760);
    }
  }

  /** 打开文件选择器更换自定义背景图片；成功后切到图片模式。 */
  private async pickBackgroundImage(): Promise<void> {
    try {
      const dataUrl = await pickBackgroundImageFile();
      if (!dataUrl) return;
      this.appBgImage = dataUrl;
      writeAppBgImage(dataUrl);
      this.setBackgroundMode('image');
      this.appBgKey = '';
      this.paintAppBg(playerState().track);
      toast('背景图片已更新', 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : '背景图片读取失败', 'error');
    }
  }

  /** 移除自定义背景图片；图片模式会回落到跟随封面。 */
  private async clearBackgroundImage(): Promise<void> {
    this.appBgImage = '';
    writeAppBgImage('');
    if (this.appBgMode === 'image') this.setBackgroundMode('cover');
    this.paintAppBg(playerState().track);
    toast('已移除自定义背景图片', 'info');
  }

  /** 快捷设置里的「背景」两段开关：关闭 / 跟随当前歌曲封面。 */
  private setAppBg(on: boolean): void {
    this.setBackgroundMode(on ? 'cover' : 'none');
  }

  /** 设置 → 外观：整站控制色（一个颜色统一驱动按钮/高亮/底色）。 */
  private buildAccentField(): HTMLDivElement {
    const swatches = h('div', { class: 'theme-swatches' });
    const custom = h('input', { class: 'theme-color-input', type: 'color', value: readAccentColor() || '#a9803f' });
    const customLabel = h('label', { class: 'theme-swatch is-custom', title: '自定义控制色' }, custom, h('span', { class: 'theme-swatch-plus', text: '+' }));
    const paint = (): void => {
      const saved = readAccentColor();
      swatches.querySelectorAll<HTMLButtonElement>('.theme-swatch').forEach((button) => {
        button.classList.toggle('is-on', (button.dataset.color ?? '') === saved);
      });
      custom.value = saved || '#a9803f';
      customLabel.classList.toggle('is-on', saved !== '');
    };
    for (const preset of ACCENT_PRESETS) {
      const button = h('button', { class: 'theme-swatch', type: 'button', title: preset.label });
      button.dataset.color = preset.color;
      button.style.setProperty('--swatch', preset.color || '#a9803f');
      button.addEventListener('click', () => {
        writeAccentColor(preset.color);
        applyAccentColor(preset.color);
        paint();
      });
      swatches.append(button);
    }
    custom.addEventListener('input', () => {
      writeAccentColor(custom.value);
      applyAccentColor(custom.value);
      paint();
    });
    swatches.append(customLabel);
    paint();
    return h(
      'div',
      { class: 'field is-stacked' },
      h('div', { class: 'field-label', text: '主题配色' }),
      swatches,
      h('div', { class: 'field-hint', text: '一个控制色统一驱动按钮、高亮、进度条与页面底色；默认金 = 跟随主题内置配色。' }),
    );
  }

  /** 设置 → 外观：整站背景（关闭 / 跟随封面 / 自定义图片）。 */
  private buildPageBackgroundField(): HTMLDivElement {
    const seg = h('div', { class: 'seg' });
    const status = h('span', { class: 'bg-image-status', text: '' });
    const buttons: HTMLButtonElement[] = [];
    const options: ReadonlyArray<{ value: AppBgMode; label: string }> = [
      { value: 'none', label: '关闭' },
      { value: 'cover', label: '跟随封面' },
      { value: 'image', label: '自定义图片' },
    ];
    const refresh = (): void => {
      const active = readAppBgMode();
      buttons.forEach((button, index) => button.classList.toggle('is-on', options[index].value === active));
      status.textContent = readAppBgImage() ? '已选择自定义图片' : '未选择图片';
    };
    for (const option of options) {
      const button = h('button', { class: 'seg-btn', type: 'button', text: option.label });
      button.addEventListener('click', () => {
        if (option.value === 'image') {
          if (readAppBgImage()) this.setBackgroundMode('image');
          else void this.pickBackgroundImage().then(refresh);
        } else {
          this.setBackgroundMode(option.value);
        }
        refresh();
      });
      buttons.push(button);
      seg.append(button);
    }
    const pick = h('button', { class: 'btn btn-sm', type: 'button', text: '选择图片…' });
    pick.addEventListener('click', () => {
      void this.pickBackgroundImage().then(refresh);
    });
    const clear = h('button', { class: 'btn btn-sm', type: 'button', text: '移除' });
    clear.addEventListener('click', () => {
      void this.clearBackgroundImage().then(refresh);
    });
    // 模糊度：0–140px，默认 64px；改完立即写回 :root 的 CSS 变量。
    const blurValue = readAppBgBlur();
    const blurLabel = h('span', { class: 'field-slider-value', text: `${blurValue}px` });
    const blurInput = h('input', {
      class: 'slider',
      type: 'range',
      min: String(APP_BG_BLUR.min),
      max: String(APP_BG_BLUR.max),
      step: String(APP_BG_BLUR.step),
      value: String(blurValue),
    });
    blurInput.addEventListener('input', () => {
      const value = Number(blurInput.value);
      blurLabel.textContent = `${value}px`;
      writeAppBgBlur(value);
      applyAppBgStyle();
    });
    const blurField = h(
      'div',
      { class: 'field field-slider' },
      h('div', { class: 'field-label', text: '背景模糊度' }),
      h('div', { class: 'field-slider-control' }, blurLabel, blurInput),
    );
    // 壁纸取景位置：居中/顶部/底部/左侧/右侧。
    const posSeg = h('div', { class: 'seg' });
    const posButtons: HTMLButtonElement[] = [];
    const paintPos = (): void => {
      const active = readAppBgPosition();
      posButtons.forEach((button, index) => button.classList.toggle('is-on', APP_BG_POSITIONS[index].value === active));
    };
    for (const item of APP_BG_POSITIONS) {
      const button = h('button', { class: 'seg-btn', type: 'button', text: item.label });
      button.addEventListener('click', () => {
        writeAppBgPosition(item.value);
        applyAppBgStyle();
        paintPos();
      });
      posButtons.push(button);
      posSeg.append(button);
    }
    paintPos();
    refresh();
    return h(
      'div',
      { class: 'field is-stacked' },
      h('div', { class: 'field-label', text: '页面背景' }),
      seg,
      h('div', { class: 'bg-image-row' }, pick, clear, status),
      blurField,
      h('div', { class: 'field-label', text: '壁纸位置' }),
      posSeg,
      h('div', { class: 'field-hint', text: '关闭 = 纯页面底色；跟随封面 = 随当前歌曲封面模糊变化；自定义图片会压缩到 1600px 内保存到本机。模糊度与取景位置对封面/自定义图都生效。' }),
    );
  }

  private syncQuickBody(): void {
    if (!this.quickPanelOpen) return;
    const track = playerState().track;
    const key = `${this.quickTab}:${track ? `${track.source}:${track.id}` : ''}`;
    if (key !== this.quickRenderKey) {
      this.renderQuickBody();
      return;
    }
    if (this.quickTab === 'lyrics') {
      const source = this.quickBody.querySelector<HTMLElement>('[data-role="lyric-source"]');
      if (source) source.textContent = currentLyricSource() || '读取中…';
      const match = this.quickBody.querySelector<HTMLElement>('[data-role="lyric-match"]');
      if (match) match.textContent = lyricMatchText();
    }
    if (this.quickTab === 'cover') {
      this.paintQuickLike(playerState().liked);
      const note = this.quickBody.querySelector<HTMLElement>('.quick-track-note');
      if (note) note.textContent = this.qualityNoteOf();
    }
  }

  /** 把毫秒偏移显示成「+1.2 秒 / -0.4 秒」。 */
  private formatOffset(ms: number): string {
    if (ms === 0) return '0.0 秒';
    return `${ms > 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(1)} 秒`;
  }

  /** 当前实际音质的展示文案：优先用宿主回传的真实值，拿不到再退回设置里的档位。 */
  private qualityNoteOf(): string {
    const track = playerState().track;
    if (!track) return '';
    const actual = playerState().streamQuality;
    const label = actual || this.qualityText(getSettings().playback.quality);
    return [SOURCE_LABEL[track.source] ?? track.source, label].filter(Boolean).join(' · ');
  }

  /** 切歌/拿到实际音质后刷新注释与播放条提示；选了无损但被降级时提示一次。 */
  private paintStreamQuality(): void {
    const track = playerState().track;
    if (!track) return;
    const actual = playerState().streamQuality;
    const note = this.qualityNoteOf();
    const el = this.quickBody?.querySelector<HTMLElement>('.quick-track-note');
    if (el) el.textContent = note;
    if (this.pbCoverWrap) this.pbCoverWrap.title = actual ? `${track.title} · ${actual}` : track.title;
    if (!actual) return;
    const key = `${track.source}:${track.id}:${actual}`;
    if (key === this.lastQualityKey) return;
    this.lastQualityKey = key;
    if (qualityForSource(track.source) === 'lossless' && !actual.includes('无损')) {
      toast(`无损不可用，已自动降级为${actual.split(' · ')[0]}`, 'info');
    }
  }

  /** 快捷面板封面页的收藏按钮状态。 */
  private paintQuickLike(liked: boolean): void {
    const button = this.quickLikeBtn;
    if (!button) return;
    button.classList.toggle('is-liked', liked);
    button.title = liked ? '取消收藏' : '收藏';
    button.textContent = '';
    button.append(icon(liked ? 'heartFill' : 'heart', 16));
  }

  private openQuick(): void {
    if (this.quickPanelOpen) return;
    this.quickPanelOpen = true;
    this.quickVolume.value = String(Math.round(playerState().volume * 100));
    primeLyrics(playerState().track);
    this.paintQuickMode(playerState().mode);
    this.renderQuickBody();
    // 收起动画还没播完就又被点开：先取消收尾逻辑，再重新播展开动画
    this.quickCloseCleanup?.();
    this.quickRoot.classList.remove('is-closing');
    this.quickRoot.classList.add('is-open');
    window.requestAnimationFrame(() => {
      if (this.quickPanelOpen) this.setQuickTab(this.quickTab);
    });
  }

  private closeQuick(): void {
    if (!this.quickPanelOpen) return;
    this.quickPanelOpen = false;
    // 收起时立刻停止「下载」页的刷新（不依赖内容是否已被清空）。
    this.downloadQuickView?.deactivate();
    const panel = this.quickPanelEl;
    const root = this.quickRoot;
    let timer = 0;
    const onEnd = (event: AnimationEvent): void => {
      if (event.target !== panel) return;
      finish();
    };
    const finish = (): void => {
      window.clearTimeout(timer);
      panel.removeEventListener('animationend', onEnd);
      if (this.quickCloseCleanup === finish) this.quickCloseCleanup = null;
      root.classList.remove('is-open', 'is-closing');
    };
    // 播放「收起」动画（比展开快一截），播完再把面板收进 display:none
    this.quickCloseCleanup = finish;
    panel.addEventListener('animationend', onEnd);
    timer = window.setTimeout(finish, 240);
    root.classList.add('is-closing');
    this.deactivateAirplayQuick();
  }

  private paintQuickMode(mode: PlayerState['mode']): void {
    this.quickModeBtn.textContent = '';
    this.quickModeBtn.append(
      icon(mode === 'single' ? 'repeatOne' : mode === 'shuffle' ? 'shuffle' : 'repeat', 15),
      h('span', { text: mode === 'single' ? '单曲循环' : mode === 'shuffle' ? '随机播放' : '列表循环' }),
    );
  }

  private openUpNext(): void {
    if (this.upnextOpen) return;
    this.upnextOpen = true;
    this.upnextRoot.classList.add('is-open');
    this.renderUpNextList(true);
  }

  private closeUpNext(): void {
    if (!this.upnextOpen) return;
    this.upnextOpen = false;
    this.upnextRoot.classList.remove('is-open');
  }

  private renderUpNextList(force = false): void {
    const state = playerState();
    const upcoming = state.queue.slice(state.index + 1);
    const listKey = `${state.index}|${upcoming.map((item) => `${item.source}:${item.id}`).join(',')}`;
    if (!force && listKey === this.upnextListKey) return;
    this.upnextListKey = listKey;
    this.upnextList.textContent = '';
    if (upcoming.length === 0) {
      this.upnextList.append(h('li', { class: 'upnext-empty', text: '队列里没有下一首了' }));
      return;
    }
    upcoming.forEach((track, offset) => {
      const index = state.index + 1 + offset;
      // 待播行的操作：上移 / 下移 / 移出队列（跳过）。点击不会触发行的选中与双击播放。
      const upBtn = h('button', { class: 'upnext-act', title: '上移', 'aria-label': '上移' }, icon('chevronUp', 14));
      const downBtn = h('button', { class: 'upnext-act', title: '下移', 'aria-label': '下移' }, icon('chevronDown', 14));
      const removeBtn = h('button', { class: 'upnext-act is-remove', title: '跳过这首（移出队列）', 'aria-label': '跳过这首' }, icon('trash', 14));
      (upBtn as HTMLButtonElement).disabled = offset === 0;
      (downBtn as HTMLButtonElement).disabled = offset === upcoming.length - 1;
      for (const btn of [upBtn, downBtn, removeBtn]) {
        btn.addEventListener('pointerdown', (event) => event.stopPropagation());
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
        });
      }
      upBtn.addEventListener('click', () => moveQueueItem(index, index - 1));
      downBtn.addEventListener('click', () => moveQueueItem(index, index + 1));
      removeBtn.addEventListener('click', () => removeQueueItem(index));
      const row = h(
        'li',
        { class: 'upnext-row' },
        h('img', { class: 'upnext-cover', src: onlineArtwork(track), alt: '' }),
        h(
          'div',
          { class: 'upnext-row-meta' },
          h('div', { class: 'upnext-title', text: track.title }),
          h('div', { class: 'upnext-artist', text: track.artist || '未知歌手' }),
        ),
        h('div', { class: 'upnext-actions' }, upBtn, downBtn, removeBtn),
        h('span', { class: 'upnext-index', text: String(offset + 1) }),
      );
      // 拖拽排序：整行可拖，按指针落在目标行上半/下半决定插到其前/后。
      row.draggable = true;
      row.dataset.queueIndex = String(index);
      row.addEventListener('dragstart', (event) => {
        this.upnextDragFrom = index;
        row.classList.add('is-dragging');
        if (event.dataTransfer) {
          event.dataTransfer.setData('text/plain', String(index));
          event.dataTransfer.effectAllowed = 'move';
        }
      });
      row.addEventListener('dragend', () => {
        this.upnextDragFrom = -1;
        row.classList.remove('is-dragging');
        this.clearUpnextDropMarks();
      });
      row.addEventListener('dragover', (event) => {
        if (this.upnextDragFrom < 0) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        const rect = row.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        this.clearUpnextDropMarks();
        row.classList.add(after ? 'is-drop-after' : 'is-drop-before');
      });
      row.addEventListener('drop', (event) => {
        if (this.upnextDragFrom < 0) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = row.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        this.commitUpnextDrop(after ? index + 1 : index);
      });
      row.addEventListener('click', () => {
        for (const item of Array.from(this.upnextList.children)) item.classList.remove('is-selected');
        row.classList.add('is-selected');
      });      row.addEventListener('dblclick', () => {
        playAt(index);
        this.closeUpNext();
      });
      this.upnextList.append(row);
    });
  }

  /** 清掉待播队列的拖拽落点提示（行上的前/后标记 + 列表尾标记）。 */
  private clearUpnextDropMarks(): void {
    this.upnextList.classList.remove('is-drop-tail');
    for (const row of Array.from(this.upnextList.children)) {
      row.classList.remove('is-drop-before', 'is-drop-after');
    }
  }

  /**
   * 结束一次待播队列拖拽。insertion 是「移除前坐标」中的插入点（0..queue.length），
   * 换算成 moveQueueItem(from, to) 的 to（移除后坐标）后交给播放器执行。
   */
  private commitUpnextDrop(insertion: number): void {
    const from = this.upnextDragFrom;
    this.upnextDragFrom = -1;
    this.clearUpnextDropMarks();
    if (from < 0) return;
    const queue = playerState().queue;
    let to = Math.max(0, Math.min(insertion, queue.length));
    if (from < to) to -= 1;
    to = Math.max(0, Math.min(to, queue.length - 1));
    if (to === from) return;
    moveQueueItem(from, to);
  }

  private syncUpNext(state: PlayerState): void {
    const upcoming = state.queue[state.index + 1] ?? null;
    const visible = state.track !== null && upcoming !== null;
    this.upnextRoot.classList.toggle('is-hidden', !visible);
    if (!visible || upcoming === null) {
      this.closeUpNext();
      return;
    }
    this.upnextCover.src = onlineArtwork(upcoming);
    this.upnextTitle.textContent = upcoming.title;
    this.upnextArtist.textContent = upcoming.artist || '未知歌手';
    if (this.upnextOpen) this.renderUpNextList();
  }

  /** 按播放模式刷新循环按钮的图标、标题与激活态。 */
  /** 统一设置音量：滑条 / 滚轮 / 快捷面板都走这里。 */
  private applyVolumeValue(raw: number): void {
    const percent = Math.min(100, Math.max(0, Math.round(raw)));
    this.volumeInput.value = String(percent);
    const value = percent / 100;
    setVolume(value);
    patchSettings({ playback: { volume: value } });
    this.paintVolumeIcon(percent);
  }

  private paintVolumeIcon(percent: number): void {
    if (!this.volumeIcon) return;
    const muted = percent <= 0;
    this.volumeIcon.textContent = '';
    this.volumeIcon.append(icon(muted ? 'volumeMuted' : 'volume', 16));
    this.volumeIcon.classList.toggle('is-muted', muted);
    const wrap = this.volumeIcon.parentElement;
    if (wrap) wrap.title = muted ? '已静音 · 滚轮调节音量' : `音量 ${percent}% · 滚轮调节`;
  }

  private paintModeBtn(mode: PlayerState['mode']): void {
    this.pbModeBtn.textContent = '';
    this.pbModeBtn.append(icon(mode === 'single' ? 'repeatOne' : mode === 'shuffle' ? 'shuffle' : 'repeat', 17));
    this.pbModeBtn.title =
      mode === 'list' ? '列表循环（点击切换）' : mode === 'single' ? '单曲循环（点击切换）' : '随机播放（点击切换）';
    this.pbModeBtn.classList.toggle('is-active', mode !== 'list');
    this.pbModeBtn.dataset.mode = mode;
  }

  private syncPlayer(state: PlayerState): void {
    const track = state.track;
    if (!track) {
      this.root.classList.remove('is-app-bg');
      this.playerbar.classList.remove('is-hidden');
      this.playerbar.classList.add('is-idle');
      this.pbTrackKey = '';
      this.pbTitle.textContent = '未在播放';
      this.pbArtist.textContent = '点一首歌开始播放';
      this.pbSource.textContent = '';
      this.pbPlayBtn.textContent = '';
      this.pbPlayBtn.append(icon('play', 20));
      this.pbFill.style.width = '0%';
      this.pbCur.textContent = '00:00';
      this.pbDur.textContent = '00:00';
      this.pbLikeBtn.textContent = '';
      this.pbLikeBtn.append(icon('heart'));
      this.pbLikeBtn.classList.remove('is-liked');
      this.paintModeBtn(state.mode);
    this.syncQuickBody();
      this.upnextRoot.classList.add('is-hidden');
      this.syncSeamlessHint(state);
      return;
    }
    this.playerbar.classList.remove('is-idle');
    this.pbSource.textContent = sourceMeta(track.source)?.short ?? track.source;
    this.pbSource.dataset.source = track.source;
    this.paintStreamQuality();
    const trackKey = `${track.source}:${track.id}`;
    const trackChanged = trackKey !== this.pbTrackKey;
    if (trackChanged) {
      if (this.pbTrackKey !== '') this.captureTrackGhosts();
      this.pbTrackKey = trackKey;
      // 换歌立刻把这首歌置顶到首页的「最近播放」，不等重新加载首页
      if (state.playing) this.noteRecentPlay(track);
      // 只在换歌时改封面，并清掉上一首的兜底/重试标记。
      // 若每次状态同步都重设 src，失败的封面会不断重试、表现为疯狂闪烁。
      delete this.pbCover.dataset.coverFallback;
      this.pbCover.src = onlineArtwork(track);
      this.paintAppBg(track);
      if (!track.cover) {
        // 本地曲目常没有内嵌封面：去线上按歌名/歌手找一张
        void lookupCover(track).then((found) => {
          if (!found) return;
          track.cover = found;
          const now = playerState().track;
          if (!now || `${now.source}:${now.id}` !== trackKey) return;
          this.pbCover.src = onlineArtwork(track);
          if (this.appBgMode !== 'none') this.paintAppBg(track);
          if (this.upnextCover && this.upnextTitle && this.upnextTitle.textContent) {
            const next = playerState().queue[playerState().index + 1];
            if (next && `${next.source}:${next.id}` === trackKey) this.upnextCover.src = onlineArtwork(next);
          }
          if (this.quickTab === 'cover') this.renderQuickBody();
        });
      }
      // 换歌即预载当前平台歌词，并在后台匹配其它平台的逐字歌词。
      void primeLyrics(track);
    }
    this.pbTitle.textContent = track.title;
    this.pbArtist.textContent = track.artist || '未知歌手';
    const artistLinkable = track.source === 'local' && Boolean(track.artist);
    this.pbArtist.classList.toggle('is-linkable', artistLinkable);
    this.pbArtist.title = artistLinkable ? `查看 ${track.artist} 的本地歌曲` : '';
    if (trackChanged) this.playTrackEnter();
    this.pbPlayBtn.textContent = '';
    this.pbPlayBtn.append(icon(state.playing ? 'pause' : 'play', 20));
    const ratio = state.durationMs > 0 ? Math.min(1, state.positionMs / state.durationMs) : 0;
    this.pbFill.style.width = `${(ratio * 100).toFixed(2)}%`;
    this.pbCur.textContent = fmtTime(state.positionMs);
    this.pbDur.textContent = fmtTime(state.durationMs);
    this.pbLikeBtn.textContent = '';
    this.pbLikeBtn.append(icon(state.liked ? 'heartFill' : 'heart'));
    this.pbLikeBtn.classList.toggle('is-liked', state.liked);
    this.paintModeBtn(state.mode);
    this.syncQuickBody();
    // 墙面高亮当前曲
    const posters = this.wallHost.querySelectorAll('.poster');
    posters.forEach((poster, index) => {
      const item = this.wall.tracks[index];
      poster.classList.toggle('is-playing', !!item && item.id === track.id);
    });
    // 搜索结果行：高亮当前曲 + 同步收藏状态（切歌/收藏后即时刷新）
    const rows = this.wallHost.querySelectorAll('.track-row');
    rows.forEach((row, index) => {
      const item = this.wall.tracks[index];
      const same = !!item && item.id === track.id && item.source === track.source;
      row.classList.toggle('is-current', same);
      if (!same || !item) return;
      this.searchLiked.set(`${item.source}:${item.id}`, state.liked);
      const button = row.querySelector<HTMLButtonElement>('.track-like');
      if (button) this.applyLikeVisual(item, state.liked, button);
    });
    this.syncUpNext(state);
    this.upNextToast?.update(state);
    this.syncSeamlessHint(state);
  }

  /**
   * 无缝衔接准备完成后，在播放条下方提示距离曲内淡化起点还剩多久。
   * 依赖 crossfadeDeck 的调试快照：phase = prepared、fadeStartPosMs = A 曲内的淡化起点。
   */
  private syncSeamlessHint(state: PlayerState): void {
    const hint = this.seamlessHint;
    if (!hint) return;
    const debug = readCrossfadeDebug();
    const remainingMs = debug.fadeStartPosMs - state.positionMs;
    const ready = Boolean(
      state.track &&
        state.playing &&
        debug.enabled &&
        debug.phase === 'prepared' &&
        debug.nextPrepared &&
        remainingMs > 1000 &&
        !this.miniMode &&
        this.miniTransition === 'idle',
    );
    if (!ready) {
      this.hideSeamlessHint();
      this.seamlessHintKey = '';
      return;
    }
    const next = debug.nextTitle || '下一首';
    const fadeText = debug.fadeMs > 0 ? `（过渡约 ${formatFadeSeconds(debug.fadeMs)}）` : '';
    const text = `将在 ${formatCountdownSpan(remainingMs)} 后过渡至「${next}」${fadeText}`;
    const key = `${state.track?.id ?? ''}|${Math.round(debug.fadeStartPosMs)}|${next}`;
    if (key !== this.seamlessHintKey) {
      // 新一轮准备就绪：弹出提示并在几秒后自动消失（同一轮只弹一次）。
      this.seamlessHintKey = key;
      hint.textContent = text;
      hint.classList.add('is-visible');
      this.seamlessHintTimer = window.setTimeout(() => this.hideSeamlessHint(), SEAMLESS_HINT_VISIBLE_MS);
      return;
    }
    // 弹窗仍在显示时继续刷新秒数；自动消失后本轮不再重复弹出。
    if (hint.classList.contains('is-visible') && hint.textContent !== text) hint.textContent = text;
  }

  private hideSeamlessHint(): void {
    window.clearTimeout(this.seamlessHintTimer);
    this.seamlessHintTimer = 0;
    if (this.seamlessHint) this.seamlessHint.classList.remove('is-visible');
  }

  /** 切歌前把当前封面/文字复制一份留着做「滑出」动画。 */
  private captureTrackGhosts(): void {
    const ghost = this.pbCover.cloneNode() as HTMLImageElement;
    ghost.className = 'pb-cover-img is-ghost';
    ghost.src = this.pbCover.getAttribute('src') ?? '';
    this.pbCoverWrap.append(ghost);
    window.setTimeout(() => ghost.remove(), 620);

    const ghostMeta = this.pbMeta.cloneNode(true) as HTMLDivElement;
    ghostMeta.classList.add('pb-meta-ghost');
    ghostMeta.classList.remove('is-incoming');
    this.pbMeta.append(ghostMeta);
    window.setTimeout(() => ghostMeta.remove(), 620);
  }

  /** 新封面从右侧推入、新歌名从下方淡入。 */
  private playTrackEnter(): void {
    for (const element of [this.pbCover, this.pbMeta]) {
      element.classList.remove('is-incoming');
      void (element as HTMLElement).offsetWidth;
      element.classList.add('is-incoming');
      window.setTimeout(() => element.classList.remove('is-incoming'), 620);
    }
  }

  private syncSettingsUi(): void {
    const settings = getSettings();
    this.volumeInput.value = String(Math.round(settings.playback.volume * 100));
    this.paintVolumeIcon(Math.round(settings.playback.volume * 100));
  }

  /* ------------------------------------------------------------------ */
  /* 歌词                                                                */
  /* ------------------------------------------------------------------ */

  private openLyrics(): void {
    if (this.lyrics) return;
    const view = new LyricsView(() => this.closeLyrics());
    this.lyrics = view;
    // 挂到根节点：歌词页要整窗覆盖（含左侧栏区域），背景是整屏模糊封面
    this.root.append(view.root);
    this.root.classList.add('is-lyrics-open');
    view.bindSeek();
  }

  private closeLyrics(): void {
    const view = this.lyrics;
    if (!view) return;
    this.lyrics = null;
    this.root.classList.remove('is-lyrics-open');
    // 先播退场动画，再真正卸载
    view.root.classList.add('is-leaving');
    window.setTimeout(() => view.dispose(), 300);
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * 给所有分段控件（.seg）装上可滑动的白色胶囊滑块。
   * 观察 DOM 增删，覆盖设置页、曲库筛选、快捷设置等所有动态创建的分段控件；
   * 选中项变化时滑块带弹簧缓动滑过去，并做一次 Q 弹缩放。
   */
  private watchSegments(): void {
    // 设置/歌词等弹层挂在 body 上（不在 this.root 内），所以观察整个 body。
    this.enhanceSegs(document.body);
    this.segObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof HTMLElement) this.enhanceSegs(node);
        }
      }
    });
    this.segObserver.observe(document.body, { childList: true, subtree: true });
  }

  private enhanceSegs(root: ParentNode): void {
    if (root instanceof HTMLElement && root.classList.contains('seg')) this.enhanceSeg(root);
    root.querySelectorAll<HTMLElement>('.seg').forEach((seg) => this.enhanceSeg(seg));
  }

  private enhanceSeg(seg: HTMLElement): void {
    if (seg.dataset.segThumb === 'ready') return;
    seg.dataset.segThumb = 'ready';
    const thumb = h('div', { class: 'seg-thumb' });
    seg.prepend(thumb);
    const buttons = Array.from(seg.querySelectorAll<HTMLElement>('.seg-btn'));
    let lastActive: HTMLElement | null = null;
    let animating = false;
    let animTimer = 0;
    const place = (animate: boolean): void => {
      const active = seg.querySelector<HTMLElement>('.seg-btn.is-on');
      if (!active) {
        thumb.style.opacity = '0';
        lastActive = null;
        return;
      }
      // 动画进行中不要被尺寸观察者二次定位打断（否则会瞬间吸附到终点）。
      if (!animate && animating) return;
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const moving = animate && !reduce && lastActive !== null && lastActive !== active;
      // 一次点击会触发多条 class 变更回调：进入动画后，后续同目标回调直接忽略。
      if (animating && !moving) return;
      thumb.style.transition = moving
        ? 'left .38s cubic-bezier(.34,1.56,.64,1), width .38s cubic-bezier(.34,1.56,.64,1), opacity .18s ease'
        : 'none';
      thumb.style.left = `${active.offsetLeft}px`;
      thumb.style.width = `${active.offsetWidth}px`;
      thumb.style.opacity = '1';
      if (moving) {
        animating = true;
        window.clearTimeout(animTimer);
        animTimer = window.setTimeout(() => {
          animating = false;
        }, 420);
        thumb.classList.remove('is-pop');
        void thumb.offsetWidth;
        thumb.classList.add('is-pop');
      }
      lastActive = active;
    };
    // 首次挂载时等一帧拿到布局尺寸再定位（不播动画）。
    requestAnimationFrame(() => requestAnimationFrame(() => place(false)));
    // 点击兜底：即使外部只改 class 不触发观察回调，也确保有滑动动画。
    seg.addEventListener(
      'click',
      () => {
        window.setTimeout(() => place(true), 0);
      },
      true,
    );
    const resize = new ResizeObserver(() => {
      // 选中项变了（可能先于观察回调发生）→ 触发滑动；否则只做无动画校正。
      const active = seg.querySelector<HTMLElement>('.seg-btn.is-on');
      if (active && active !== lastActive) place(true);
      else if (!animating) place(false);
    });
    resize.observe(seg);
    const watcher = new MutationObserver(() => place(true));
    buttons.forEach((btn) => watcher.observe(btn, { attributes: true, attributeFilter: ['class'] }));
  }

  destroy(): void {
    this.segObserver?.disconnect();
    this.segObserver = undefined;
    this.quickResizeObserver?.disconnect();
    this.quickResizeObserver = null;
    this.quickTabsObserver?.disconnect();
    this.quickTabsObserver = null;
    if (this.quickWidthBusyTimer) window.clearTimeout(this.quickWidthBusyTimer);
    this.quickWidthBusyTimer = 0;
    if (this.quickBodySyncRaf) window.cancelAnimationFrame(this.quickBodySyncRaf);
    this.quickBodySyncRaf = 0;
    this.upNextToast?.dispose();
    this.upNextToast = null;
    this.playerDispose?.();
    this.localDispose?.();
    this.accountDispose?.();
    this.settingsDispose?.();
    this.updatesDispose?.();
    this.updatesDispose = null;
    this.downloadQuickView?.dispose();
    this.downloadQuickView = null;
    closeQualityPicker();
    disposeDownloadQueue();
    disposeMetronome();
    this.disposers.dispose();
    this.sheetScope?.dispose();
    this.sheetScope = null;
    this.closeLyrics();
    this.sheet?.close();
    this.closeLogin();
    this.root.remove();
  }

  /* ------------------------------------------------------------------ */
  /* 供 main.ts 使用                                                     */
  /* ------------------------------------------------------------------ */

  /** 启动后首次进入：展示首页（未登录时首页自带登录入口）。 */
  async enter(): Promise<void> {
    await this.showHome();
  }

  /** 在线就绪后刷新账号并决定是否弹登录。 */
  async afterOnlineReady(): Promise<void> {
    if (!onlineReady()) return;
    await refreshAccounts();
    this.syncAccount();
    refreshCurrentLiked();
    await this.showHome();
  }

  /** 手动导入 cookie（保留能力，暂不暴露 UI）。 */
  async importCookieFor(source: AccountSource, cookie: string): Promise<void> {
    await importCookie(source, cookie);
    await refreshAccounts();
    this.syncAccount();
    await this.showLiked(source as OnlineSource);
  }

  /** 顶栏输入框聚焦（Ctrl+F）。 */
  focusSearch(): void {
    this.openSearchDock();
    window.setTimeout(() => {
      this.searchInput.focus();
      this.searchInput.select();
    }, 90);
  }

  /** 当前是否已登录（供 main 决定首屏）。 */
  hasAccount(): boolean {
    return getAccounts().some((item) => item.loggedIn);
  }

  /**
   * 首页点播放：先用卡片里的预览列表立即开播，再异步补全整张列表，
   * 避免列表循环很快绕回第一首。
   */
  private playFromHome(tracks: OnlineTrack[], index: number, scope: PlayScope): void {
    const safeIndex = Math.max(0, Math.min(index, Math.max(0, tracks.length - 1)));
    const start = tracks[safeIndex];
    playQueue(tracks, safeIndex);
    if (!start) return;
    void (async () => {
      let full: OnlineTrack[] | null = null;
      try {
        if (scope === 'liked') {
          full = await this.fetchLikedTracks(this.preferredSource() ?? start.source);
        } else if (scope === 'recent') {
          full = await fetchRecentMerged(300);
        } else if (scope === 'radar') {
          full = (await fetchFeed('netease', 'radar', 120)).tracks;
        } else {
          full = (await this.fetchDailyMerged(80)).tracks;
        }
      } catch (err) {
        console.warn('[app] expand queue failed', err);
      }
      if (full && full.length > tracks.length) replaceQueue(full);
    })();
  }

  /** 立即播放指定曲目（供快捷键）。 */
  playCurrent(): void {
    const state = playerState();
    if (state.track) toggle();
    else playAt(0);
  }

  /** Esc：按从上层到下层顺序关掉当前浮层。 */
  escapeTopLayer(): void {
    if (this.searchDockOpen) {
      this.closeSearchDock();
      return;
    }
    if (this.accountPanelOpen) {
      this.closeAccountPanel();
      return;
    }
    if (this.quickPanelOpen) {
      this.closeQuick();
      return;
    }
    if (this.upnextOpen) {
      this.closeUpNext();
      return;
    }
    if (isDownloadPanelOpen()) {
      closeDownloadPanel();
      return;
    }
    if (this.loginOverlay) {
      this.closeLogin();
      return;
    }
    if (this.sheet) {
      this.sheet.close();
      return;
    }
    if (this.lyrics) this.closeLyrics();
  }

  nextTrack(): void {
    next();
  }

  prevTrack(): void {
    prev();
  }
}

export type { App as ZiluxApp };
