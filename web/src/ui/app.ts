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

/**
 * 海报封面兜底：只有「缺封面」的海报才去联网补图，而且等它真正滚进视口附近再查。
 * 喜欢墙一次能挂几百张海报，逐张触发 searchOnline 会瞬间打出几百个搜索请求。
 */
const posterCoverTargets = new WeakMap<Element, { img: HTMLImageElement; track: OnlineTrack }>();
let posterCoverObserver: IntersectionObserver | null = null;

async function resolvePosterCover(img: HTMLImageElement, track: OnlineTrack): Promise<void> {
  if (track.cover) return;
  const found = await lookupCover(track);
  if (!found || !img.isConnected) return;
  track.cover = found;
  img.src = onlineArtwork(track, 300);
}

function observePosterCover(img: HTMLImageElement, track: OnlineTrack): void {
  if (typeof IntersectionObserver === 'undefined') {
    void resolvePosterCover(img, track);
    return;
  }
  if (!posterCoverObserver) {
    posterCoverObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const target = posterCoverTargets.get(entry.target);
          posterCoverObserver?.unobserve(entry.target);
          posterCoverTargets.delete(entry.target);
          if (target) void resolvePosterCover(target.img, target.track);
        }
      },
      { rootMargin: '600px 0px' },
    );
  }
  posterCoverTargets.set(img, { img, track });
  posterCoverObserver.observe(img);
}
import {
  accountOf,
  getAccounts,
  importCookie,
  logout,
  onAccountChange,
  onAccountIssue,
  pollLogin,
  recentAccountIssues,
  refreshAccounts,
  requestQr,
  verifyAccounts,
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
  MINI_SIZE_DIMS,
  MINI_SIZE_LABELS,
  normalizeShortcutBinding,
  onSettingsChange,
  patchSettings,
  SHORTCUT_ACTIONS,
  SHORTCUT_DEFAULTS,
  SHORTCUT_LABELS,
  SLEEP_FADE_SECONDS_CHOICES,
  SLEEP_TIMER_ACTIONS,
  shortcutBindingFromEvent,
  type DesktopLyricsWeight,
  type EqPreset,
  type FadeCurve,
  type ShortcutAction,
  type SleepTimerAction,
} from '../core/settings';
import { addLikedTrack, checkLikedMany, clearMvmp3Cache, fetchFeed, fetchHotPlaylists, fetchMvmp3Cache, fetchRecentMerged, onlineEndpoint, onlineReady, qualityForSource, removeLikedTrack, searchOnline, setQualityForSource, setStreamQuality } from '../online/client';
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
import { autoPlaySettings, listAutoPlayPlaylists, onAutoPlayChange, saveAutoPlaySettings, type AutoPlayPlaylistGroup, type AutoPlaySource } from './autoPlay';
import {
  buildCrossfadeSection,
  bpmOverrideOf,
  CROSSFADE_BAR_CHOICES,
  CROSSFADE_BEAT_CHOICES,
  CROSSFADE_LENGTH_CHOICES,
  captureCrossfadeOverride,
  effectiveCrossfadeSettings,
  overrideKeyOfTrack,
  playlistOverrideOf,
  readCrossfadeDebug,
  setPlaylistOverride,
  setTrackOverride,
  trackOverrideOf,
  readCrossfadeSettings,
  setBpmOverride,
  writeCrossfadeSettings,
  subscribeCrossfadeDebug,
  suppressNextCrossfade,
} from './crossfadeDeck';
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
  addLocalFolder,
  deleteLocalTracks,
  initLocalLibrary,
  localFolders,
  localLibrary,
  onLocalLibraryChange,
  onLocalResult,
  openLocalFolder,
  pickAdditionalLocalFolder,
  pickLocalFolder,
  rememberedFolder,
  relOf,
  removeLocalFolder,
  revealLocalTrack,
  trackOf,
  writeLocalTags,
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
import {
  createSmartPlaylist,
  deleteSmartPlaylist,
  listSmartPlaylists,
  subscribeSmartPlaylists,
} from './smartPlaylists';
import {
  dailyListening,
  formatListening,
  readListeningStats,
  recordListenStart,
  recordListenTime,
  resetListeningStats,
  topListenedArtists,
  topListenedTracks,
} from './listeningStats';
import { openTagEditor } from './tagEditor';
import { buildEqPresetManager } from './eqPresets';
import { buildSearchHistoryPanel, recordSearch, type SearchHistoryPanelHandle } from './searchHistory';
import { openTrackMenu, type TrackMenuItem } from './trackMenu';
import { buildSettingsIOActions } from './settingsIO';
import { buildSleepTimerPanel, completeSleepTimer, getSleepTimerState, subscribeSleepTimer } from './sleepTimer';
import { bgLyricsCoverStyle, setBgLyricsCoverStyle, type BgLyricsCoverStyle } from './bgLyricsCover';
import {
  bgLyricsBlurLevel,
  bgLyricsFillMode,
  setBgLyricsBlurLevel,
  setBgLyricsFillMode,
  type BgLyricsBlurLevel,
  type BgLyricsFillMode,
} from './bgLyricsCover';
import { currentLyricDisplay, currentLyricSource, lyricGrowMode, lyricMatchMinScore, lyricOffsetOf, LYRIC_UNSUNG_PRESETS, lyricsBackgroundMode, lyricSolidColor, setLyricSolidColor, lyricsLumiereMode, lyricUnsungColor, LyricsView, primeLyrics, setLyricGrowMode, setLyricsBackgroundMode, setLyricsLumiereMode, setLyricMatchMinScore, setLyricOffset, setLyricUnsungColor, updateCurrentLyricLine, lyricMatchText } from './lyrics';
import { LUMIERE_MODES } from './lumiere';
import {
  CHORUS_PREVIEW_MAX_CHOICES,
  CHORUS_PREVIEW_START_CHOICES,
  chorusPreviewDelayChoices,
  readChorusPreviewSettings,
  registerPreviewTrack,
  stopChorusPreview,
  takePreviewElement,
  writeChorusPreviewSettings,
} from './chorusPreview';
import { loudnessEnabled, nightModeEnabled, setLoudnessEnabled, setNightModeEnabled } from './loudness';
import { MOOD_DEFS, matchMood, type MoodDef } from './moods';
import { orderUpcomingByMix } from './automix';
import { installStagePulse } from './stagePulse';
import { LYRIC_STYLES, lyricStyle, setLyricStyle } from './lyricStyle';
import {
  analysisForTrack,
  clearHotCue,
  cycleMode,
  getBarLoop,
  getHotCues,
  getPlaybackSpeed,
  moveQueueItem,
  next,
  onPlayer,
  playAt,
  playQueue,
  playerState,
  peekUpcoming,
  prev,
  queueAppend,
  queueNext,
  removeQueueItem,
  refreshCurrentLiked,
  refreshLoudness,
  adoptPlayingElement,
  replaceQueue,
  seek,
  setPlaybackSpeed,
  setQueueRefill,
  setVolume,
  subscribeQueueSwitch,
  toggle,
  toggleBarLoop,
  toggleHotCue,
  toggleLiked,
  type PlayerState,
} from './player';
import { host, hostAvailable, getShortcutsState, onMiniMode, onShortcutsState, updateDesktopLyrics, type UpdateSnapshot } from '../core/bridge';
import { HomeView } from './home';
import { DiscoverView } from './discover';
import { fetchRadio, fetchRecommendedPlaylists } from '../online/discover';
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
import { openVinylSettingsSheet } from './vinylSettingsPanel';
import { readPosterLayout, writePosterLayout, type PosterLayout } from './posterLayout';
import { ACCENT_PRESETS, applyAccentColor, readAccentColor, ui, writeAccentColor } from './theme';
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

type WallKind = 'liked' | 'local' | 'search' | 'feed' | 'playlist' | 'recent' | 'playlists' | 'recommend' | 'moods' | 'mood' | 'smart' | 'stats';

interface WallData {
  kind: WallKind;
  title: string;
  subtitle: string;
  tracks: OnlineTrack[];
  /** 本地歌单墙关联的歌单 id（用于「添加歌曲」）。 */
  playlistId?: string;
  /** 歌单级过渡记忆的键（`local:<id>` / `online:<source>:<id>`）。 */
  playlistKey?: string;
  /** 智能歌单墙关联的歌单 id（动态保存的场景/推荐快照）。 */
  smartPlaylistId?: string;
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
/** 无缝过渡倒计时：准备就绪后常驻显示到开始淡化，不再几秒后自动消失。 */

/** 过渡时长文案：整秒省略小数，否则保留一位小数（如 6.9 秒 / 2 分 12 秒以上只会出现在倒计时里）。 */
function formatFadeSeconds(ms: number): string {
  const seconds = Math.max(0, ms / 1000);
  if (Math.abs(seconds - Math.round(seconds)) < 0.05) return `${Math.round(seconds)} 秒`;
  return `${seconds.toFixed(1)} 秒`;
}

/** 倒计时文案：秒 / 分+秒（用于「将在 X 分 Y 秒后过渡至…」）。 */
function crossfadeSummary(settings: ReturnType<typeof readCrossfadeSettings>): string {
  const style =
    settings.style === 'auto'
      ? '自动风格'
      : settings.style === 'am'
        ? '交融'
        : settings.style === 'equal'
          ? '等功率'
          : '快速切入';
  const length =
    settings.lengthMode === 'auto'
      ? '自适应长度'
      : settings.lengthMode === 'seconds'
        ? `${settings.lengthValue} 秒`
        : settings.lengthMode === 'beats'
          ? `${settings.lengthValue} 拍`
          : settings.lengthMode === 'bars'
            ? `${settings.lengthValue} 小节`
            : '1 乐句';
  const cue =
    settings.cueMode === 'auto'
      ? '自动入场'
      : settings.cueMode === 'drop'
        ? '进 drop'
        : settings.cueMode === 'chorus'
          ? '进副歌'
          : 'intro 后';
  return `${style} · ${length} · ${cue}`;
}

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
  /** 经典首页（默认模式）。 */
  private classicHome: HomeView | null = null;
  /** 档案终端（3D 玻璃场景，首次切换时才创建）。 */
  /** 当前首页模式：经典 / 档案终端。 */
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
  /** 快捷键静音前的音量（M 键切换用）。 */
  private muteRestore = 0.4;

  /** 当前墙面 */
  private wall: WallData = { kind: 'liked', title: '我喜欢的音乐', subtitle: '', tracks: [] };
  private likedCache = new Map<OnlineSource, OnlineTrack[]>();
  /** 我喜欢的音乐显示模式：融合（多平台）或单个平台 */
  private likedMode: 'all' | OnlineSource = 'all';
  /** 封面显示方式：网格卡片 / 横条列表（与首页热门歌单共用偏好） */
  private wallLayout: PosterLayout = readPosterLayout();
  private localQuery = '';
  /** 本地曲库视图：歌曲列表 / 歌手（艺术家）网格。 */
  private localMode: 'songs' | 'artists' = 'songs';
  /** 当前打开的本地艺术家名；null 表示本地曲库总览。 */
  private localArtistFilter: string | null = null;
  private lyrics: LyricsView | null = null;
  private sheet: SheetHandle | null = null;
  /** 设置弹窗内的订阅集合（换面板 / 关闭弹窗时统一清理）。 */
  private sheetScope: Disposers | null = null;
  /** 「推荐」整页的热门歌单缓存（重渲染时同步使用）。 */
  private recommendItems: LibraryPlaylist[] = [];
  /** 「我的歌单」整页里本地歌单的订阅（离开页面时清理）。 */
  private playlistsScope: Disposers | null = null;
  private loginOverlay: HTMLDivElement | null = null;
  private playerDispose: (() => void) | null = null;
  private localDispose: (() => void) | null = null;
  private accountDispose: (() => void) | null = null;
  private accountIssueDispose: (() => void) | null = null;
  private settingsDispose: (() => void) | null = null;
  /** 睡眠定时渐弱：当前渐弱到的音量（null 表示没有进行中的渐弱）。 */
  private sleepFadeVolume: number | null = null;
  /** 渐弱令牌：取消/重新触发时自增，用于中止上一次循环。 */
  private sleepFadeToken = 0;
  /** 设置页「更新」分区的快照订阅（同一时间只保留一份）。 */
  private updatesDispose: (() => void) | null = null;

  private pbCover!: HTMLImageElement;
  private pbCoverWrap!: HTMLDivElement;
  private pbMeta!: HTMLDivElement;
  private pbSource!: HTMLSpanElement;
  private pbTrackKey = '';
  /** 收听统计的跨状态游标：曲目键 + 上次同步的墙上时间。 */
  private listenKey = '';
  private listenAt = 0;
  private pbTitle!: HTMLDivElement;
  private pbArtist!: HTMLDivElement;
  private pbPlayBtn!: HTMLButtonElement;
  private pbLikeBtn!: HTMLButtonElement;
  private pbModeBtn!: HTMLButtonElement;
  private smartMixActive = false;
  private smartMixPrevMode: PlayerState['mode'] = 'list';
  private pbQueueBtn!: HTMLButtonElement;
  private pbFill!: HTMLDivElement;
  private pbMarks!: HTMLDivElement;
  private pbMergeMark!: HTMLDivElement;
  private pbClimaxBand!: HTMLDivElement;
  private pbClimaxMark!: HTMLDivElement;
  private pbLoopBand!: HTMLDivElement;
  private pbCueMarks!: HTMLDivElement[];
  /** 进度条高潮标记对应的曲目（换歌后旧分析结果不再画到新曲上）。 */
  private pbClimaxKey = '';
  private pbClimaxRange: { from: number; to: number } | null = null;
  private pbCur!: HTMLSpanElement;
  private pbDur!: HTMLSpanElement;
  /** 迷你态第三行：进度时间 + 下一首（普通窗口隐藏）。 */
  private pbMiniTime!: HTMLSpanElement;
  private pbMiniNext!: HTMLSpanElement;
  private pbMiniLine!: HTMLDivElement;
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
  private quickTab: 'cover' | 'lyrics' | 'bgLyrics' | 'play' | 'sound' | 'preview' | 'transition' | 'airplay' | 'download' = 'cover';
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
  /** 退出迷你后 200ms 的界面淡入定时器（抹平「纯色幕布 → 整页」的硬切）。 */
  private miniRestoreTimer = 0;
  /** 无缝衔接准备就绪后，播放条上方短暂弹出的「将在 X 分 Y 秒后过渡至 xxx」提示。 */
  private seamlessHint!: HTMLDivElement;
  /** 过渡提示：本次计划第一次出现的时刻与计划指纹（用于「先弹几秒、到跟前再常驻」）。 */
  private hintShownAt = 0;
  private hintShownKey = '';
  /** 过渡试放台：覆盖层 / 关闭回调 / 模拟播放的停止函数。 */
  private crossfadeLab: HTMLDivElement | null = null;
  private crossfadeLabDispose: (() => void) | null = null;
  private crossfadeLabStop: (() => void) | null = null;
  /** 待播队列小卡里的「过渡」行：说明这次怎么过渡，准备后显示实际秒数与起点。 */
  private upnextTransition!: HTMLDivElement;
  private upnextMixBtn!: HTMLButtonElement;
  /** 上一次渲染的过渡说明，避免每次状态同步都重写 DOM。 */
  private pbTransitionKey = '';
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
    installStagePulse(this.root);
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
    // 墙面歌曲行（.track-row）统一走右键菜单：行上带 data-track-key，曲目从当前 wall 里回查。
    this.root.addEventListener('contextmenu', (event) => this.onWallTrackContextMenu(event));
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
    // 过渡计划变化（准备完成/取消）不一定伴随播放器状态变化（分析慢、暂停时），
    // 这里主动重绘进度条上的渐变与高潮标记，避免显示上一份计划的旧位置。
    this.disposers.add(
      subscribeCrossfadeDebug(() => {
        this.paintProgressMarks(playerState());
        this.syncUpNextTransition(playerState());
      }),
    );
    // 过渡设置变更（开启预告/改风格等）不一定伴随播放器状态变化，立即同步一次预告卡。
    const onCrossfadeSettings = (): void => this.syncUpNextTransition(playerState());
    window.addEventListener('zilux:crossfade', onCrossfadeSettings);
    this.disposers.add(() => window.removeEventListener('zilux:crossfade', onCrossfadeSettings));
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
    onLocalResult((result) => {
      if (result.action === 'pickAdded') {
        if (result.ok && result.message) {
          addLocalFolder(result.message);
          toast('已添加文件夹，正在扫描曲库…');
        } else {
          toast('已取消添加文件夹');
        }

        return;
      }

      toast(result.message, result.ok ? 'info' : 'error');
    });
    this.accountDispose = onAccountChange(() => this.syncAccount());
    // 登录状态检测（第四十六轮）：宿主后台发现掉登录时推 account 事件，这里弹提醒并刷新账号 UI。
    this.accountIssueDispose = onAccountIssue((issue) => {
      const label = SOURCE_LABEL[issue.source] ?? issue.source;
      toast(`${label} 登录已失效，请重新登录`, 'error');
      this.syncAccount();
    });
    this.settingsDispose = onSettingsChange(() => this.syncSettingsUi());
    // 睡眠定时：模块触发时先渐弱、再暂停，最后按设置收尾（不依赖设置弹窗是否还开着）。
    const onSleepFired = () => {
      void this.handleSleepTimerFired();
    };
    window.addEventListener('zilux:sleep-timer-fired', onSleepFired);
    this.disposers.add(() => window.removeEventListener('zilux:sleep-timer-fired', onSleepFired));
    // 用户在渐弱过程中取消了定时：立刻恢复音量并停下渐弱。
    this.disposers.add(
      subscribeSleepTimer((timer) => {
        if (timer.active || this.sleepFadeVolume === null) return;
        this.sleepFadeToken += 1;
        setVolume(this.sleepFadeVolume);
        this.sleepFadeVolume = null;
      }),
    );
    // AutoMix是临时模式：换了整套队列或手动点歌后，恢复点击前的模式图标。
    this.disposers.add(subscribeQueueSwitch(() => this.exitSmartMix('queue')));
    // 「播完当前曲」：曲末前 300ms 触发；其余模式由睡眠定时模块自己计时。
    window.setInterval(() => {
      const timer = getSleepTimerState();
      if (!timer.active || timer.mode !== 'track-end') return;
      const state = playerState();
      if (!state.playing || state.durationMs <= 0) return;
      if (state.positionMs >= state.durationMs - 300) completeSleepTimer();
    }, 500);
    // 收听统计：按秒采样累计（onPlayer 只在播放状态变化时触发，不能靠它计时）。
    window.setInterval(() => this.accumulateListening(playerState()), 1000);
    // 桌面歌词：每秒读一次当前句；只有句/翻译变了才发给宿主，避免桥消息刷屏。
    window.setInterval(() => this.pushDesktopLyrics(), 1000);
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
      else if (action === 'volumeUp' || action === 'volumeDown') {
        const delta = action === 'volumeUp' ? 0.05 : -0.05;
        const next = Math.max(0, Math.min(1, playerState().volume + delta));
        setVolume(next);
        patchSettings({ playback: { volume: next } });
        toast(`音量 ${Math.round(next * 100)}%`);
      } else if (action === 'mute') this.toggleMute();
      else if (action === 'like') {
        void toggleLiked().then((result) => {
          if (result === 'error') {
            toast('收藏失败：请检查登录状态或平台限制', 'error');
            return;
          }
          toast(result === 'liked' ? '已加入「我喜欢的音乐」' : '已取消收藏');
          this.afterLikedChange(result === 'liked');
          this.paintQuickLike(result === 'liked');
        });
      } else if (action === 'mode') {
        if (this.smartMixActive) this.exitSmartMix('mode');
        const mode = cycleMode();
        this.paintModeBtn(mode);
        this.paintQuickMode(mode);
        toast(this.modeLabel(mode));
      } else if (action === 'mini') this.toggleMiniMode();
      else if (action === 'desktopLyrics') {
        const next = !getSettings().general.desktopLyrics;
        patchSettings({ general: { desktopLyrics: next } });
        toast(next ? '桌面歌词已开启' : '桌面歌词已关闭');
      } else if (action === 'crossfade') {
        const next = !readCrossfadeSettings().enabled;
        writeCrossfadeSettings({ enabled: next });
        toast(next ? '已开启无缝衔接' : '已关闭无缝衔接');
      } else return;
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
          'button, input, textarea, select, .win-btns, .pill, .rail, .sheet, .lyrics-view, .playerbar, .upnext, .quick, .account-wrap, .search-wrap, .search-dock, .search-pop',
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
      { key: 'recommend', label: '推荐', iconName: 'sparkle', onClick: () => void this.openRecommendPage() },
      { key: 'moods', label: '场景', iconName: 'mood', onClick: () => void this.openMoodsPage() },
      { key: 'discover', label: '发现', iconName: 'compass', onClick: () => void this.showDiscover() },
      { key: 'playlists', label: '我的歌单', iconName: 'list', onClick: () => this.openPlaylistsPage() },
      { key: 'local', label: '本地曲库', iconName: 'folder', onClick: () => this.showLocal() },
      { key: 'stats', label: '收听统计', iconName: 'chart', onClick: () => this.openStatsPage() },
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
    // 经典首页始终创建：它是默认模式，也是切回时的兜底。
    this.classicHome = new HomeView({
      onLogin: () => this.openLogin(),
      onLiked: (source) => void this.showLiked(source),
      onPlayLiked: (source) => void this.playLikedAll(source),
      onRecent: () => void this.showRecentWall(),
      onRecommend: () => void this.openRecommendPage(),
      onDaily: () => void this.showDailyWall(),
      onDaily30: () => void this.showDailyWall(true),
      onRadar: () => void this.showRadarWall(),
      onSearch: () => this.focusSearch(),
      onPlay: (tracks, index, scope) => this.playFromHome(tracks, index, scope),
      onPlaylist: (item) => void this.showPlaylist(item),
    });
    this.homeHost.append(this.classicHome.root);
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
        playRadio: (tracks) => this.playRadio(tracks),
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
    // 每日推荐歌单：双平台各取一页，按顺序交错合并，一排里两个平台都有。
    const recommendPlaylists: LibraryPlaylist[] = [];
    try {
      const [neteaseRecommend, qqRecommend] = await Promise.all([
        fetchRecommendedPlaylists('netease', 0, 10).catch(() => null),
        fetchRecommendedPlaylists('qq', 0, 10).catch(() => null),
      ]);
      const max = Math.max(neteaseRecommend?.playlists.length ?? 0, qqRecommend?.playlists.length ?? 0);
      for (let index = 0; index < max; index += 1) {
        for (const list of [neteaseRecommend, qqRecommend]) {
          const item = list?.playlists[index];
          if (!item) continue;
          recommendPlaylists.push({
            source: item.source as OnlineSource,
            id: item.id,
            title: item.title,
            cover: item.cover,
            count: item.count,
            creator: item.creator,
          });
        }
      }
    } catch (err) {
      console.warn('[app] recommend playlists failed', err);
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
      const merged = await this.fetchDailyMerged(60);
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
        radar = (await fetchFeed('netease', 'radar', 120)).tracks;
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
      recommendPlaylists: recommendPlaylists.slice(0, 14),
    };
    this.homeData = data;
    this.classicHome?.update(data);
  }

  /** 首页「最近播放」即时更新：刚播的歌放到最前（回到首页时再以宿主记录为准）。 */
  private noteRecentPlay(track: OnlineTrack): void {
    const data = this.homeData;
    if (!data) return;
    const key = `${track.source}:${track.id}`;
    const recent = [track, ...data.recent.filter((item) => `${item.source}:${item.id}` !== key)].slice(0, 160);
    const next: HomeData = { ...data, recent };
    this.homeData = next;
    // 不在这里整页重建首页：HomeView.update() 会重建所有卡片并重新拉封面，
    // 切歌时看起来像「推荐/雷达/收藏都在刷新」。最近播放回到首页时再以宿主记录为准。
  }

  /** 播放「我喜欢的音乐」整列（经典首页收藏卡片的播放按钮）。 */
  private async playLikedAll(preferred?: OnlineSource): Promise<void> {
    const modes = preferred
      ? sourceSupportsLikedWrite(preferred)
        ? [preferred]
        : []
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

  /** 「推荐」整页：QQ 音乐音乐馆热门歌单，卡片网格，点开进歌单详情。 */
  private async openRecommendPage(): Promise<void> {
    this.wallPager = null;
    this.setRailActive('recommend');
    this.recommendItems = [];
    this.wall = { kind: 'recommend', title: '推荐歌单', subtitle: 'QQ 音乐 · 音乐馆热门歌单 · 加载中…', tracks: [] };
    this.renderWall();
    try {
      this.recommendItems = await fetchHotPlaylists('qq', 40);
    } catch (err) {
      console.warn('[app] recommend failed', err);
      toast('热门歌单读取失败，稍后重试', 'error');
    }
    this.wall = {
      kind: 'recommend',
      title: '推荐歌单',
      subtitle:
        this.recommendItems.length > 0
          ? `QQ 音乐 · 音乐馆热门歌单 · ${this.recommendItems.length} 个`
          : 'QQ 音乐 · 音乐馆热门歌单',
      tracks: [],
    };
    this.renderWall(true);
  }

  private buildRecommendGrid(): HTMLElement {
    if (this.recommendItems.length === 0) {
      return h('div', { class: 'wall-empty', text: '暂时拿不到热门歌单，稍后重试' });
    }
    const grid = h('div', { class: 'disc-grid' });
    this.recommendItems.forEach((item) => {
      const cover =
        item.cover ??
        onlineArtwork({ id: item.id, title: item.title, artist: item.creator ?? '', album: '', cover: '' });
      const tile = h(
        'button',
        { class: ui.tile(), title: item.title },
        h('span', { class: ui.tileCover() }, h('img', { src: cover, loading: 'lazy', alt: '' })),
        h('span', { class: ui.tileName(), text: item.title }),
        h('span', { class: ui.tileMeta(), text: `${SOURCE_LABEL[item.source] ?? ''} · ${formatPlays(item.count)}` }),
      );
      tile.addEventListener('click', () => void this.showPlaylist(item));
      grid.append(tile);
    });
    return grid;
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
    if (!skipEnter) {
      // 换页时回到顶部，否则从别的长列表切过来会停在中间。
      this.wallHost.scrollTop = 0;
      window.setTimeout(() => this.wallHost.classList.remove('is-fresh'), 620);
    }
    this.wallHost.textContent = '';
    if (this.wall.kind !== 'playlists') {
      this.playlistsScope?.dispose();
      this.playlistsScope = null;
    }
    const { title, subtitle } = this.wall;
    let tracks = this.wall.tracks;
    if (this.wall.kind === 'local' && this.localMode === 'songs' && this.localQuery.trim().length > 0) {
      const needle = this.localQuery.trim().toLowerCase();
      tracks = tracks.filter((track) => track.title.toLowerCase().includes(needle) || (track.artist ?? '').toLowerCase().includes(needle));
    }
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
      const foldersBtn = h('button', { class: 'pill', title: '管理本地曲库的多个文件夹' }, icon('list', 16), h('span', { text: '文件夹' }));
      foldersBtn.addEventListener('click', () => this.openLocalFolderSheet());
      actions.push(foldersBtn);
    }
    if (this.wall.kind === 'playlist' && this.wall.playlistId) {
      const addBtn = h('button', { class: 'pill', title: '从本地曲库挑选歌曲加入这个歌单' }, icon('plus', 16), h('span', { text: '添加歌曲' }));
      addBtn.addEventListener('click', () => this.openPlaylistAddSheet(this.wall.playlistId as string));
      actions.push(addBtn);
    }
    if (this.wall.kind === 'playlist' && this.wall.playlistKey) {
      const key = this.wall.playlistKey;
      const saved = playlistOverrideOf(key) !== null;
      const memoryBtn = h(
        'button',
        { class: 'pill', title: saved ? '这个歌单已记住一套过渡设置；点开可更新或清除' : '把这个歌单的过渡设置记下来，播到这些歌时自动套用' },
        icon('clock', 16),
        h('span', { text: saved ? '过渡已记忆' : '记住过渡' }),
      );
      memoryBtn.addEventListener('click', (event) => {
        const items: TrackMenuItem[] = [
          {
            label: saved ? '更新这个歌单的过渡记忆' : '记住这个歌单的过渡',
            hint: '使用当前设置',
            run: () => {
              setPlaylistOverride(key, captureCrossfadeOverride(), this.wall.tracks.map(overrideKeyOfTrack));
              toast(`已记住这个歌单的过渡：${crossfadeSummary(readCrossfadeSettings())}`);
              this.renderWall(true);
            },
          },
          {
            label: '清除这个歌单的过渡记忆',
            disabled: !saved,
            run: () => {
              setPlaylistOverride(key, null);
              toast('已清除这个歌单的过渡记忆');
              this.renderWall(true);
            },
          },
        ];
        openTrackMenu({ x: event.clientX, y: event.clientY, items });
      });
      actions.push(memoryBtn);
    }
    if (tracks.length > 0 && this.wall.kind !== 'playlist') {
      const saveBtn = h(
        'button',
        { class: 'pill', title: '把当前列表里的歌曲存成一个本地歌单' },
        icon('plus', 16),
        h('span', { text: '存为歌单' }),
      );
      saveBtn.addEventListener('click', () => this.saveWallAsPlaylist());
      actions.push(saveBtn);
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

    if (this.wall.kind === 'local' && this.localMode === 'songs' && !this.isLocalArtistGrid()) {
      const input = h('input', {
        class: 'wall-search-input',
        type: 'search',
        placeholder: '在本地曲库里搜索歌曲或歌手',
        value: this.localQuery,
      }) as HTMLInputElement;
      let timer = 0;
      input.addEventListener('input', () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          this.localQuery = input.value;
          this.renderWall(true);
          const next = this.wallHost.querySelector<HTMLInputElement>('.wall-search-input');
          if (next) {
            next.focus();
            const end = next.value.length;
            next.setSelectionRange(end, end);
          }
        }, 140);
      });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          this.localQuery = '';
          this.renderWall(true);
        }
      });
      const count = this.localQuery.trim() ? '匹配 ' + tracks.length + ' 首' : '';
      this.wallHost.append(h('div', { class: 'wall-search' }, h('span', { class: 'wall-search-icon' }, icon('search', 15)), input, h('span', { class: 'wall-search-count', text: count })));
    }

    // 「推荐」整页：热门歌单卡片网格。
    if (this.wall.kind === 'recommend') {
      this.wallHost.append(this.buildRecommendGrid());
      return;
    }

    // 「场景」整页：按节拍/能量/调性分桶的智能歌单。
    if (this.wall.kind === 'moods') {
      this.wallHost.append(this.buildMoodGrid());
      return;
    }

    // 「收听统计」整页：不渲染歌曲网格。
    if (this.wall.kind === 'stats') {
      this.wallHost.append(this.buildStatsPage());
      return;
    }

    // 「我的歌单」整页：本地歌单 + 各平台在线歌单。
    if (this.wall.kind === 'playlists') {
      const wrap = h('div', { class: 'playlists-page' });
      const localHost = h('div', { class: 'local-playlist-host' });
      const smartHost = h('div', { class: 'smart-playlist-host' });
      const onlineHost = h('div', { class: 'online-playlist-host' });
      wrap.append(localHost, smartHost, onlineHost);
      this.wallHost.append(wrap);
      this.playlistsScope?.dispose();
      const scope = new Disposers();
      this.playlistsScope = scope;
      scope.add(
        subscribeLocalPlaylists(() => {
          this.renderLocalPlaylists(localHost);
        }),
      );
      this.renderLocalPlaylists(localHost);
      this.renderSmartPlaylists(smartHost);
      scope.add(subscribeSmartPlaylists(() => this.renderSmartPlaylists(smartHost)));
      void this.renderOnlinePlaylists(onlineHost);
      return;
    }

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
    this.wallHost.append(grid);
    this.appendPosters(grid, tracks, 0, tracks);
  }

  /** 生成一张封面海报（首次渲染与分页追加共用）。 */
  private posterNode(track: OnlineTrack, index: number, queue: OnlineTrack[]): HTMLElement {
    registerPreviewTrack(track);
    // 首屏封面立刻加载，其余交给浏览器懒加载：喜欢墙/本地库动辄几百张封面，
    // 全部 eager 会在滚到底时一次性解码几百张图，主线程直接被拖死。
    const eagerCover = index < 18;
    const coverImg = h('img', {
      src: onlineArtwork(track, 300),
      loading: eagerCover ? 'eager' : 'lazy',
      decoding: 'async',
      draggable: 'false',
    });
    if (!track.cover) observePosterCover(coverImg, track);
    const current = playerState().track;
    const poster = h(
      'div',
      {
        class: `poster${current && current.id === track.id ? ' is-playing' : ''}`,
        title: `${track.title} — ${track.artist}`,
        'data-track-key': `${track.source}:${track.id}`,
      },
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
      this.playWithPreviewHandoff(queue, index);
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
    poster.addEventListener('click', () => this.playWithPreviewHandoff(queue, index));
    poster.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openTrackContextMenu(event.clientX, event.clientY, track, queue, index);
    });
    return poster;
  }

  private appendPosters(grid: HTMLElement, tracks: OnlineTrack[], startIndex: number, queue: OnlineTrack[]): void {
    // 分帧追加：一次 loadMore 会带回来 200 首，整批同步建节点会卡出一个长任务；
    // 按帧切成小批，滚动时分摊到多帧里完成。
    let cursor = 0;
    const step = (): void => {
      if (!grid.isConnected) return;
      const end = Math.min(tracks.length, cursor + 24);
      for (; cursor < end; cursor += 1) {
        grid.append(this.posterNode(tracks[cursor]!, startIndex + cursor, queue));
      }
      if (cursor < tracks.length) requestAnimationFrame(step);
    };
    step();
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

  /** 本地曲库：管理多个曲库根目录（添加 / 移除，第一个为主目录）。 */
  private openLocalFolderSheet(): void {
    this.openSheet('本地音乐文件夹', (body) => {
      const hint = h('div', {
        class: 'field-hint',
        text: '曲库会合并这里列出的所有目录。第一个是主目录；其余目录在后台用 @libN 前缀区分，播放、封面、歌词和标签编辑都照常工作。',
      });
      const list = h('div', { class: 'list' });
      const add = h('button', { class: 'pill', type: 'button', title: '再选一个目录加入曲库' }, icon('plus', 16), h('span', { text: '添加文件夹' }));
      const render = (): void => {
        list.textContent = '';
        const folders = localFolders();
        if (folders.length === 0) {
          list.append(h('div', { class: 'empty', text: '还没有添加任何文件夹' }));
          return;
        }

        folders.forEach((folder, index) => {
          const row = h(
            'div',
            { class: 'row', title: folder },
            h('div', { class: 'row-cover' }, icon('folder', 20)),
            h(
              'div',
              { class: 'row-meta' },
              h('div', { class: 'row-name', text: folder }),
              h('div', { class: 'row-artist', text: index === 0 ? '主目录' : '附加目录' }),
            ),
          );
          const remove = h(
            'button',
            { class: 'icon-btn', type: 'button', title: '从这个曲库移除' },
            icon('close', 15),
          );
          remove.addEventListener('click', (event) => {
            event.stopPropagation();
            removeLocalFolder(folder);
            toast('已移除这个文件夹，正在重新扫描…');
            render();
          });
          row.append(remove);
          list.append(row);
        });
      };

      add.addEventListener('click', () => pickAdditionalLocalFolder());
      render();
      body.append(hint, list, h('div', { class: 'field' }, add));
    });
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

  /** 「我的歌单」整页：本地歌单（新建 / 重命名 / 删除）+ 各平台在线歌单。 */
  private openPlaylistsPage(): void {
    this.wallPager = null;
    this.setRailActive('playlists');
    this.wall = {
      kind: 'playlists',
      title: '我的歌单',
      subtitle: '本地歌单与各平台收藏 · 点开即可查看',
      tracks: [],
    };
    this.renderWall();
  }

  /** 我的歌单页里的「智能歌单」区块（保存下来的场景 / 推荐快照）。 */
  private renderSmartPlaylists(host: HTMLElement): void {
    host.textContent = '';
    const playlists = listSmartPlaylists();
    host.append(h('h3', { class: 'section-title', text: `智能歌单 · ${playlists.length} 个` }));
    if (playlists.length === 0) {
      host.append(
        h('div', {
          class: 'empty',
          text: '在场景 / 每日推荐 / 喜欢 / 最近播放页点「存为歌单」，就会把当次列表完整存到这里。',
        }),
      );
      return;
    }
    const list = h('div', { class: 'list' });
    playlists.forEach((playlist) => {
      const first = playlist.tracks[0];
      const row = h(
        'div',
        { class: 'row', title: playlist.name },
        h(
          'div',
          { class: 'row-cover local-playlist-cover' },
          first ? h('img', { src: onlineArtwork(first), loading: 'lazy' }) : icon('list', 20),
        ),
        h(
          'div',
          { class: 'row-meta' },
          h('div', { class: 'row-name', text: playlist.name }),
          h('div', { class: 'row-artist', text: `${playlist.tracks.length} 首 · 智能歌单` }),
        ),
      );
      row.addEventListener('click', () => {
        this.sheet?.close();
        this.openSmartPlaylistWall(playlist.id);
      });
      const actions = h('div', { class: 'local-playlist-actions' });
      const playBtn = h('button', { class: 'icon-btn', type: 'button', title: '播放这个歌单' }, icon('play', 16));
      playBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (playlist.tracks.length === 0) {
          toast('歌单还是空的');
          return;
        }
        playQueue(playlist.tracks, 0, true);
      });
      const delBtn = h('button', { class: 'icon-btn', type: 'button', title: '删除这个智能歌单' }, icon('trash', 16));
      delBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!deleteSmartPlaylist(playlist.id)) {
          toast('删除失败', 'error');
          return;
        }
        toast(`已删除「${playlist.name}」`);
      });
      actions.append(playBtn, delBtn);
      row.append(actions);
      list.append(row);
    });
    host.append(list);
  }

  /** 打开智能歌单墙。 */
  private openSmartPlaylistWall(id: string): void {
    const playlist = listSmartPlaylists().find((item) => item.id === id);
    if (!playlist) {
      toast('这个智能歌单已不存在');
      return;
    }
    this.wallPager = null;
    this.wall = {
      kind: 'smart',
      smartPlaylistId: playlist.id,
      title: playlist.name,
      subtitle: `${playlist.tracks.length} 首 · 智能歌单 · 存于 ${new Date(playlist.createdAt).toLocaleDateString('zh-CN')}`,
      tracks: playlist.tracks,
    };
    this.renderWall(true);
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
        const grid = h('div', { class: 'disc-grid' });
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
          const meta =
            item.special === 'liked'
              ? `喜欢 · ${item.count} 首`
              : `${item.creator ? item.creator + ' · ' : ''}${item.count} 首`;
          const tile = h(
            'button',
            { class: ui.tile(), title: item.title },
            h('span', { class: ui.tileCover() }, h('img', { src: cover, loading: 'lazy', alt: '' })),
            h('span', { class: ui.tileName(), text: item.title }),
            h('span', { class: ui.tileMeta(), text: meta }),
          );
          tile.addEventListener('click', () => void this.showPlaylist(item));
          grid.append(tile);
        });
        host.append(grid);
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
      playlistKey: `online:${item.source}:${item.id}`,
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
    registerPreviewTrack(track);
    const coverImg = h('img', { src: onlineArtwork(track, 120), loading: 'lazy' });
    if (!track.cover) {
      void lookupCover(track).then((found) => {
        if (!found) return;
        track.cover = found;
        coverImg.src = onlineArtwork(track, 120);
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
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openTrackContextMenu(event.clientX, event.clientY, track, queue, index);
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
  /* 歌曲右键菜单                                                        */
  /* ------------------------------------------------------------------ */

  /** 墙面 .track-row 的右键入口：从 data-track-key 回查当前 wall 的曲目对象。 */
  private onWallTrackContextMenu(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const row = target?.closest('.track-row');
    if (!(row instanceof HTMLElement)) return;
    const key = row.dataset.trackKey ?? '';
    if (!key) return;
    const tracks = this.wall.tracks;
    const index = tracks.findIndex((item) => `${item.source}:${item.id}` === key);
    if (index < 0) return;
    event.preventDefault();
    this.openTrackContextMenu(event.clientX, event.clientY, tracks[index]!, tracks, index);
  }

  /** 歌曲通用操作菜单：播放、下一首播放、加入队列、收藏、复制信息。 */
  private openTrackContextMenu(
    x: number,
    y: number,
    track: OnlineTrack,
    queue: OnlineTrack[],
    index: number,
  ): void {
    const current = playerState().track;
    const isCurrent = !!current && current.source === track.source && current.id === track.id;
    const isLocal = track.source === 'local';
    const liked = isLocal ? isLocalLiked(track) : this.searchLiked.get(`${track.source}:${track.id}`) === true;
    const items: TrackMenuItem[] = [
      {
        label: '立即播放',
        hint: 'Enter',
        run: () => {
          const list = queue.length > 0 ? queue : [track];
          playQueue(list, queue.length > 0 ? Math.max(0, Math.min(index, list.length - 1)) : 0, true);
        },
      },
      {
        label: '下一首播放',
        disabled: isCurrent,
        run: () => {
          queueNext(track);
          toast(`已设为下一首播放：${track.title}`);
        },
      },
      {
        label: '加入播放队列',
        run: () => {
          toast(queueAppend(track) ? '已加入播放队列' : '已在播放队列中');
        },
      },
      {
        label: trackOverrideOf(track) ? '更新这首歌的过渡记忆' : '记住这首歌的过渡',
        hint: '过渡',
        run: () => {
          setTrackOverride(track, captureCrossfadeOverride());
          toast(`已记住这首歌的过渡：${crossfadeSummary(effectiveCrossfadeSettings(track))}`);
        },
      },
      {
        label: '清除这首歌的过渡记忆',
        disabled: !trackOverrideOf(track),
        run: () => {
          setTrackOverride(track, null);
          toast('已清除这首歌的过渡记忆');
        },
      },
      ...(isLocal && relOf(track)
        ? [
            {
              label: '编辑标签…',
              run: () => this.openTagEditor(track),
            },
          ]
        : []),
      {
        label: isLocal
          ? liked
            ? '取消本地收藏'
            : '收藏到本地「我喜欢的音乐」'
          : liked
            ? '取消收藏'
            : '收藏到「我喜欢的音乐」',
        run: () => {
          void this.applyTrackLiked(track, !liked);
        },
      },
      {
        label: '复制歌曲信息',
        run: () => this.copyTrackInfo(track),
      },
    ];
    openTrackMenu({ x, y, items });
  }

  /** 本地曲目：编辑标签（只把用户填写的字段交给宿主，留空表示不改）。 */
  private openTagEditor(track: OnlineTrack): void {
    const fields: Array<{ key: string; label: string; value: string; placeholder: string; numeric?: boolean }> = [
      { key: 'title', label: '标题', value: track.title, placeholder: '歌曲标题' },
      { key: 'artist', label: '歌手', value: track.artist, placeholder: '歌手' },
      { key: 'album', label: '专辑', value: '', placeholder: '留空不改' },
      { key: 'albumArtist', label: '专辑歌手', value: '', placeholder: '留空不改' },
      { key: 'track', label: '音轨号', value: '', placeholder: '留空不改', numeric: true },
      { key: 'year', label: '年份', value: '', placeholder: '留空不改', numeric: true },
    ];
    const backdrop = h('div', { class: 'ui-confirm-backdrop tag-editor-backdrop' });
    const card = h('div', { class: 'tag-editor' });
    const head = h('div', { class: 'tag-editor-head' });
    head.append(h('div', { class: 'tag-editor-title', text: '编辑标签' }));
    head.append(h('div', { class: 'tag-editor-sub', text: track.title }));
    const close = h('button', { class: 'tag-editor-close', type: 'button', 'aria-label': '关闭' });
    close.append(icon('close', 16));
    head.append(close);
    card.append(head);

    const inputs = new Map<string, HTMLInputElement>();
    const body = h('div', { class: 'tag-editor-body' });
    for (const field of fields) {
      const input = h('input', {
        class: 'tag-editor-input',
        type: field.numeric ? 'number' : 'text',
        placeholder: field.placeholder,
        ...(field.numeric ? { min: '1', max: '9999' } : {}),
      });
      input.value = field.value;
      inputs.set(field.key, input);
      const row = h('label', { class: 'tag-editor-row' });
      row.append(h('span', { class: 'tag-editor-label', text: field.label }));
      row.append(input);
      body.append(row);
    }
    card.append(body);

    const hint = h('div', {
      class: 'tag-editor-hint',
      text: '留空的字段不会写入；写标签受文件格式支持情况影响（MP3/FLAC/M4A 通常可写）。',
    });
    card.append(hint);

    const footer = h('div', { class: 'tag-editor-actions' });
    const cancelBtn = h('button', { class: 'ui-confirm-btn', type: 'button', text: '取消' });
    const saveBtn = h('button', { class: 'ui-confirm-btn is-primary', type: 'button', text: '保存标签' });
    footer.append(cancelBtn, saveBtn);
    card.append(footer);
    backdrop.append(card);
    document.body.append(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('is-in'));

    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.classList.add('is-closing');
      window.setTimeout(() => backdrop.remove(), 170);
    };
    const save = (): void => {
      const payload: Record<string, string | number | null> = {};
      for (const [key, input] of inputs) {
        const raw = input.value.trim();
        if (key === 'track' || key === 'year') {
          if (!raw) {
            continue;
          }
          const number = Number.parseInt(raw, 10);
          if (Number.isFinite(number) && number > 0) {
            payload[key] = number;
          }
          continue;
        }
        const original = fields.find((field) => field.key === key)?.value ?? '';
        if (!raw && !original) {
          continue;
        }
        if (key === 'title' || key === 'artist') {
          if (!raw) {
            continue;
          }
          if (raw !== original) {
            payload[key] = raw;
          }
          continue;
        }
        payload[key] = raw;
      }
      if (Object.keys(payload).length === 0) {
        toast('没有要写入的标签');
        return;
      }
      if (!writeLocalTags(track, payload)) {
        toast('找不到这首歌的本地文件', 'error');
        return;
      }
      toast('正在写入标签…');
      finish();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish();
      }
    };
    close.addEventListener('click', finish);
    cancelBtn.addEventListener('click', finish);
    saveBtn.addEventListener('click', save);
    backdrop.addEventListener('pointerdown', (event) => {
      if (event.target === backdrop) {
        finish();
      }
    });
    document.addEventListener('keydown', onKey, true);
    inputs.get('title')?.focus({ preventScroll: true });
  }

  /** 右键菜单里的收藏动作：本地走 localStorage，在线走平台接口（乐观提示，失败回滚提示）。 */
  private async applyTrackLiked(track: OnlineTrack, liked: boolean): Promise<void> {
    if (track.source === 'local') {
      const now = toggleLocalLike(track);
      toast(now ? '已收藏到本地「我喜欢的音乐」' : '已取消本地收藏');
      return;
    }
    try {
      if (liked) await addLikedTrack(track.source, track.id);
      else await removeLikedTrack(track.source, track.id);
      this.searchLiked.set(`${track.source}:${track.id}`, liked);
      this.likedCache.clear();
      toast(liked ? '已收藏到「我喜欢的音乐」' : '已取消收藏');
      // 正停在喜欢墙且取消收藏：就地移除这一行，避免还留在列表里。
      if (!liked && this.wall.kind === 'liked' && !this.wallHost.classList.contains('is-hidden')) {
        const tracks = this.wall.tracks.filter((item) => !(item.source === track.source && item.id === track.id));
        this.wall = {
          ...this.wall,
          tracks,
          subtitle: this.wall.subtitle.replace(/\d[\d,]* 首/, `${tracks.length} 首`),
        };
        this.renderWall(true);
      }
    } catch (err) {
      console.warn('[app] track menu like failed', err);
      toast(err instanceof Error ? err.message : '收藏状态更新失败', 'error');
    }
  }

  /** 复制「歌名 - 歌手」，方便贴到别处。 */
  private copyTrackInfo(track: OnlineTrack): void {
    const text = track.artist ? `${track.title} - ${track.artist}` : track.title;
    if (!navigator.clipboard?.writeText) {
      toast('当前环境不支持剪贴板', 'error');
      return;
    }
    void navigator.clipboard
      .writeText(text)
      .then(() => toast('已复制歌曲信息'))
      .catch(() => toast('复制失败', 'error'));
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
    // 弹层打开时先收起搜索：搜索框只属于顶栏，不该盖在弹层/歌词层上
    this.closeSearchDock();
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
      this.root.classList.add('is-search-open');
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
    this.root.classList.remove('is-search-open');
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
      const coverImg = h('img', { src: onlineArtwork(track, 120), loading: 'lazy' });
      if (!track.cover) {
        void lookupCover(track).then((found) => {
          if (!found) return;
          track.cover = found;
          coverImg.src = onlineArtwork(track, 120);
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
      row.addEventListener('click', () => this.playWithPreviewHandoff(tracks, index));
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
      playlistKey: `local:${id}`,
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
            h('div', { class: 'row-cover' }, h('img', { src: onlineArtwork(track, 120), loading: 'lazy' })),
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
    // 只有「此刻正停在喜欢墙」时才刷新它；否则像首页/歌单里点红心会自动跳页（反馈的 bug）。
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

  private openSettingsSheet(paneKey = 'general'): void {
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
          '自启动时不显示窗口',
          '开机自启后只驻留托盘，不弹出主界面；手动打开仍正常显示',
          settings.general.autoStartHidden,
          (value) => {
            patchSettings({ general: { autoStartHidden: value } });
            toast(value ? '自启动后将静默驻留托盘' : '自启动后将显示主界面');
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
        toggleField(
          '系统媒体控制',
          '在任务栏媒体弹窗、音量键旁显示当前歌曲与播放按钮，并支持系统媒体键；关闭后这些入口不再出现（应用内播放不受影响）',
          settings.general.mediaSession,
          (value) => {
            patchSettings({ general: { mediaSession: value } });
            toast(value ? '已开启系统媒体控制' : '已关闭系统媒体控制');
          },
        ),
        toggleField(
          '桌面歌词',
          '在桌面上放一个无边框歌词窗口，逐句显示正在唱的歌词和翻译；窗口上右键可以调字号、锁定（鼠标穿透）、置顶或关闭',
          settings.general.desktopLyrics,
          (value) => {
            patchSettings({ general: { desktopLyrics: value } });
            toast(value ? '已打开桌面歌词' : '已关闭桌面歌词');
          },
        ),
        segField(
          '桌面歌词字号',
          [
            { value: '28', label: '小' },
            { value: '40', label: '中' },
            { value: '52', label: '大' },
          ],
          String(settings.general.desktopLyricsFontSize),
          (value) => patchSettings({ general: { desktopLyricsFontSize: Number(value) } }),
        ),
        segField(
          '桌面歌词粗细',
          [
            { value: 'normal', label: '常规' },
            { value: 'semibold', label: '中粗' },
            { value: 'bold', label: '加粗' },
          ],
          settings.general.desktopLyricsWeight,
          (value) => patchSettings({ general: { desktopLyricsWeight: value as DesktopLyricsWeight } }),
        ),
        segField(
          '桌面歌词底色',
          [
            { value: '30', label: '浅' },
            { value: '40', label: '标准' },
            { value: '55', label: '深' },
            { value: '70', label: '更实' },
          ],
          String(settings.general.desktopLyricsBackdropOpacity),
          (value) => patchSettings({ general: { desktopLyricsBackdropOpacity: Number(value) } }),
        ),
        toggleField(
          '桌面歌词锁定',
          '锁定后歌词窗口不再响应鼠标（点击穿透到下面的窗口），避免挡住桌面操作；右键歌词窗口或用设置页关掉这一项都能解锁',
          settings.general.desktopLyricsLocked,
          (value) => {
            patchSettings({ general: { desktopLyricsLocked: value } });
            toast(value ? '桌面歌词已锁定（鼠标穿透）' : '桌面歌词已解锁');
          },
        ),
        toggleField(
          '桌面歌词置顶',
          '让歌词窗口始终显示在其他窗口之上',
          settings.general.desktopLyricsTopmost,
          (value) => patchSettings({ general: { desktopLyricsTopmost: value } }),
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
        segField(
          '迷你播放器尺寸',
          MINI_SIZE_LABELS.map(([value, label]) => ({ value, label })),
          settings.appearance.miniSize,
          (value) => patchSettings({ appearance: { miniSize: value } }),
          '小 360×100、标准 420×120、宽 520×150；下次进迷你时生效，过渡动画会直接补间到对应大小。',
        ),
        toggleField(
          '迷你播放器置顶',
          '打开后迷你小窗始终浮在其它窗口上面；关闭则和普通窗口一样会被盖住（下次进迷你时生效）。',
          settings.appearance.miniAlwaysOnTop,
          (value) => patchSettings({ appearance: { miniAlwaysOnTop: value } }),
        ),
        this.buildAccentField(),
        this.buildPageBackgroundField(),
      );

      // 启动自动播放（第六十四轮）：「打开软件直接播放」+ 来源 + 指定歌单
      const autoPlayFields = (): HTMLElement[] => {
        const auto = autoPlaySettings();
        const enabledField = toggleField(
          '打开软件直接播放',
          '启动完成后自动开始播放下面选择的来源；未登录或来源为空时跳过，不影响正常进入软件。',
          auto.enabled,
          (value) => {
            saveAutoPlaySettings({ enabled: value });
            toast(value ? '已开启：启动后自动播放' : '已关闭：启动后不自动播放');
          },
        );
        const playlistValue = h('div', { class: 'field-hint' });
        const paintPlaylist = (): void => {
          const cfg = autoPlaySettings();
          playlistValue.textContent = cfg.playlistTitle
            ? `${SOURCE_LABEL[cfg.playlistSource] ?? cfg.playlistSource} · ${cfg.playlistTitle}`
            : '尚未选择歌单';
        };
        paintPlaylist();
        const pickBtn = h('button', { class: 'btn', title: '选择自动播放的歌单' }, icon('list', 16), h('span', { text: '选择歌单' }));
        pickBtn.addEventListener('click', () => this.openAutoPlayPlaylistPicker());
        const playlistField = h(
          'div',
          { class: 'field' },
          h('div', {}, h('div', { class: 'field-label', text: '自动播放歌单' }), playlistValue),
          pickBtn,
        );
        const sourceField = segField<AutoPlaySource>(
          '自动播放来源',
          [
            { value: 'daily', label: '今日推荐' },
            { value: 'liked', label: '我喜欢的音乐' },
            { value: 'playlist', label: '指定歌单' },
          ],
          auto.source,
          (value) => {
            const saved = saveAutoPlaySettings({ source: value });
            playlistField.hidden = saved.source !== 'playlist';
            if (saved.source === 'playlist' && !saved.playlistId) toast('请选择要自动播放的歌单');
          },
          '今日推荐与我喜欢的音乐都会合并所有已登录平台；指定歌单在下方选择。',
        );
        playlistField.hidden = auto.source !== 'playlist';
        this.sheetScope?.add(
          onAutoPlayChange((cfg) => {
            paintPlaylist();
            playlistField.hidden = cfg.source !== 'playlist';
          }),
        );
        return [enabledField, sourceField, playlistField];
      };

      // 播放（基础）
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
        segField<StreamQuality>(
          '在线音质偏好',
          [
            { value: 'standard', label: '标准' },
            { value: 'high', label: '高品质' },
            { value: 'lossless', label: '无损' },
          ],
          settings.playback.quality,
          (value) => {
            setStreamQuality(value);
            patchSettings({ playback: { quality: value } });
          },
          '没有单独在快捷设置里选过音质的平台都用这个；平台/账号不支持时宿主自动降级。',
        ),
        ...autoPlayFields(),
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
        segField<string>(
          '到时渐弱',
          SLEEP_FADE_SECONDS_CHOICES.map((seconds) => ({
            value: String(seconds),
            label: seconds === 0 ? '不渐弱' : `${seconds} 秒`,
          })),
          String(settings.playback.sleepFadeSeconds ?? 15),
          (value) => {
            patchSettings({ playback: { sleepFadeSeconds: Number(value) } });
          },
          '到点前把音量慢慢降下来，不会突然安静。',
        ),
        segField<SleepTimerAction>(
          '到点后',
          SLEEP_TIMER_ACTIONS.map((item) => ({ value: item.value, label: item.label })),
          settings.playback.sleepAction ?? 'pause',
          (value) => {
            patchSettings({ playback: { sleepAction: value } });
          },
        ),
      );

      // 音效（渐变 / 响度）
      const sound = section(
        '音效',
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
        toggleField(
          '响度均衡',
          '按每首歌的整体响度自动补偿音量（目标约 -14 LUFS），QQ / 网易云 / 本地混播不再忽大忽小；需要该曲已分析。',
          loudnessEnabled(),
          (value) => {
            setLoudnessEnabled(value);
            this.applyLoudnessNow();
          },
        ),
        toggleField(
          '夜间模式',
          '压低峰值、抬高低处，小音量下更耐听；依赖响度均衡的分析数据。',
          nightModeEnabled(),
          (value) => {
            setNightModeEnabled(value);
            this.applyLoudnessNow();
          },
        ),
      );

      // 试听（悬停试听 / 预听）
      const preview = section(
        '试听',
        segField(
          '悬停试听延迟',
          chorusPreviewDelayChoices(),
          String(readChorusPreviewSettings().delayMs),
          (value) => {
            writeChorusPreviewSettings({ delayMs: Number(value) });
          },
          '鼠标在封面或歌曲行上停留多久开始试听；关闭后不再自动试听。试听中点击这首歌会从试听位置接着播。',
        ),
        segField<'intro' | 'chorus'>(
          '预听起点',
          CHORUS_PREVIEW_START_CHOICES,
          readChorusPreviewSettings().startAt,
          (value) => {
            writeChorusPreviewSettings({ startAt: value });
          },
          '从曲首开始更接近「先听个开头」；从高潮开始会直接进副歌。点击播放都会从预听听到的位置继续。',
        ),
        sliderField(
          '试听音量',
          10,
          100,
          5,
          Math.round(readChorusPreviewSettings().volume * 100),
          (value) => {
            writeChorusPreviewSettings({ volume: value / 100 });
          },
          (value) => `${value}%（相对正常播放）`,
        ),
        segField(
          '最长试听时长',
          CHORUS_PREVIEW_MAX_CHOICES,
          String(readChorusPreviewSettings().maxMs),
          (value) => {
            writeChorusPreviewSettings({ maxMs: Number(value) });
          },
          '到点自动停止；移开鼠标或点别处会更早停。',
        ),
        toggleField(
          '点击接管续播',
          '开启时，点击正在试听的歌会从试听位置无缝接着播；关闭时点击只当普通播放，试听先停、从曲首开始。',
          readChorusPreviewSettings().takeover,
          (value) => {
            writeChorusPreviewSettings({ takeover: value });
          },
        ),
      );

      const transitionSection = buildCrossfadeSection(this.sheetScope);
      const labButton = h('button', { class: 'btn', text: '打开试放台' });
      labButton.addEventListener('click', () => this.openCrossfadeLab());
      const labRow = h(
        'div',
        { class: 'field is-stacked' },
        h(
          'div',
          {},
          h('div', { class: 'field-label', text: '过渡试放台' }),
          h('div', {
            class: 'field-hint',
            text: '把当前曲与下一首这次的过渡画成时间轴和两条增益曲线，并按真实时长模拟播放一遍（不出声），用来检查接点、时长与低频交接。',
          }),
        ),
        labButton,
      );
      const transitionPage = h('div', { class: 'crossfade-page' }, transitionSection, labRow);
      const analysisSection = buildAnalysisSection(this.sheetScope);


      // 账号
      const accountSection = h('div', { class: 'section' }, h('h3', { class: 'section-title', text: '账号' }));
      for (const source of accountSourceIds() as AccountSource[]) {
        const info = accountOf(source);
        const issue = recentAccountIssues().find((item) => item.source === source);
        const expired = info.expired === true || (!info.loggedIn && issue !== undefined);
        const cookieLogin = sourceLoginMode(source) === 'cookie';
        const action = h('button', {
          class: 'btn',
          text: info.loggedIn ? '退出' : expired ? '重新登录' : cookieLogin ? '导入 Cookie' : '登录',
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
            h('div', {
              class: 'field-label',
              text: `${SOURCE_LABEL[source]}${
                info.loggedIn
                  ? ` · ${info.nickname ?? ''}`
                  : expired
                    ? ' · 登录已失效'
                    : ' · 未登录'
              }`,
            }),
            action,
          ),
        );
      }
      const verifyBtn = h(
        'button',
        { class: 'btn', title: '立即检查两个平台的登录状态' },
        icon('refresh', 16),
        h('span', { text: '检查登录状态' }),
      );
      verifyBtn.addEventListener('click', () => {
        verifyBtn.disabled = true;
        void verifyAccounts()
          .then((found) => {
            toast(
              found.length > 0 ? `发现 ${found.length} 个平台登录已失效` : '登录状态正常',
              found.length > 0 ? 'error' : 'info',
            );
          })
          .finally(() => {
            verifyBtn.disabled = false;
          });
      });
      accountSection.append(
        h(
          'div',
          { class: 'field' },
          h('div', { class: 'field-label', text: '登录检测' }),
          verifyBtn,
        ),
        h('div', {
          class: 'field-hint',
          text: '启动后与每 5 分钟自动检查一次；掉登录会在界面右下角提醒，窗口在托盘时会弹系统气泡。',
        }),
      );

      // 刷新与本地库
      const tools = section(
        '存储',
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

      // 「数据」和「实验功能」合并成一页「存储」：实验来源的开关/风险说明并进同一页，
      // 少一个左侧导航项，也避免用户在两处找缓存与导入导出。
      if (hasExperimentalSources()) {
        tools.append(h('h3', { class: 'section-title', text: '实验功能' }));
        for (const child of Array.from(experimental.children)) {
          if (!child.classList.contains('section-title')) tools.append(child);
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

      const downloadsSection = this.buildDownloadsSection(section, segField, toggleField);
      const shortcutsSection = this.buildShortcutsSection(section);
      const updatesSection = this.buildUpdatesSection(section, toggleField, segField);

      // 两栏设置：左侧导航 + 右侧内容（与快捷设置的 tab 选中样式一致）
      type SettingsEntry = { key: string; label: string; node: HTMLElement };
      const entries: SettingsEntry[] = [
        { key: 'general', label: '通用', node: general },
        { key: 'appearance', label: '外观', node: appearance },
        { key: 'playback', label: '播放', node: playback },
        { key: 'sound', label: '音效', node: sound },
        { key: 'preview', label: '试听', node: preview },
        { key: 'transition', label: '过渡', node: transitionPage },
        { key: 'analysis', label: '分析', node: analysisSection },
        { key: 'shortcuts', label: '快捷键', node: shortcutsSection },
        { key: 'eq', label: '均衡器', node: eqSection },
        { key: 'downloads', label: '下载', node: downloadsSection },
        { key: 'updates', label: '更新', node: updatesSection },
        { key: 'account', label: '账号', node: accountSection },
        { key: 'data', label: '存储', node: tools },
      ];
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
      const initialKey = entries.some((entry) => entry.key === paneKey) ? paneKey : entries[0]?.key ?? 'general';
      entries.forEach((entry) => {
        const pane = h('div', { class: 'settings-pane' }, entry.node);
        pane.hidden = entry.key !== initialKey;
        panes.set(entry.key, pane);
        content.append(pane);
        const btn = h('button', { class: `settings-nav-btn${entry.key === initialKey ? ' is-on' : ''}`, type: 'button', text: entry.label });
        btn.addEventListener('click', () => activate(entry.key));
        navBtns.set(entry.key, btn);
        nav.append(btn);
      });
      body.append(h('div', { class: 'settings-layout' }, nav, content));
      window.requestAnimationFrame(() => {
        const first = navBtns.get(initialKey);
        if (first) moveNavThumb(first, false);
      });
    });
  }

  /**
   * 「打开软件直接播放 → 指定歌单」选择器：列出两平台个人歌单，选中后写回设置并回到「播放」页。
   */
  private openAutoPlayPlaylistPicker(): void {
    this.openSheet('选择自动播放歌单', (body) => {
      const status = h('div', { class: 'field-hint', text: '正在读取个人歌单…' });
      const list = h('div', { class: 'autoplay-playlists' });
      body.append(status, list);
      void listAutoPlayPlaylists()
        .then((groups: AutoPlayPlaylistGroup[]) => {
          status.remove();
          const usable = groups.filter((group) => group.loggedIn && group.playlists.length > 0);
          if (usable.length === 0) {
            list.append(h('div', { class: 'field-hint', text: '没有可选的个人歌单：先登录网易云 / QQ 音乐，让个人库同步后再来。' }));
            return;
          }
          usable.forEach((group) => {
            list.append(h('div', { class: 'autoplay-group-title', text: `${group.label} · ${group.playlists.length} 个歌单` }));
            group.playlists.forEach((playlist) => {
              const cover = playlist.cover
                ? h('span', { class: 'autoplay-playlist-cover', style: `background-image:url("${playlist.cover}")` })
                : h('span', { class: 'autoplay-playlist-cover' });
              const row = h(
                'button',
                { class: 'autoplay-playlist', type: 'button', title: playlist.title },
                cover,
                h(
                  'span',
                  { class: 'autoplay-playlist-main' },
                  h('span', { class: 'autoplay-playlist-title', text: playlist.title }),
                  h('span', { class: 'autoplay-playlist-meta', text: `${SOURCE_LABEL[group.source] ?? group.source} · ${playlist.count} 首` }),
                ),
                icon('chevron', 15),
              );
              row.addEventListener('click', () => {
                saveAutoPlaySettings({
                  source: 'playlist',
                  playlistSource: group.source,
                  playlistId: playlist.id,
                  playlistTitle: playlist.title,
                  playlistCover: playlist.cover ?? '',
                });
                toast(`启动自动播放歌单：${playlist.title}`);
                this.openSettingsSheet('playback');
              });
              list.append(row);
            });
          });
        })
        .catch((err: unknown) => {
          status.textContent = '歌单读取失败，请稍后再试';
          console.warn('[app] autoplay playlist picker failed', err);
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
    toggleField: (label: string, hint: string, value: boolean, onChange: (next: boolean) => void) => HTMLDivElement,
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
    const concurrency = Math.round(settings.downloads?.maxConcurrent ?? 2);
    const concurrencyField = segField<string>(
      '下载并发',
      [
        { value: '1', label: '1 个' },
        { value: '2', label: '2 个' },
        { value: '3', label: '3 个' },
        { value: '4', label: '4 个' },
      ],
      String(Math.min(4, Math.max(1, concurrency))),
      (next) => {
        patchSettings({ downloads: { maxConcurrent: Number(next) } });
        toast(`同时下载：${next} 个`);
      },
      '同时进行的下载任务数，多出来的会排队。网络不稳时建议 1–2 个，避免几个任务互相抢带宽。',
    );

    // 文件名模板：失焦或回车保存；不合法（空/超长/不含占位符）时回退并提示。
    const templateInput = h('input', {
      class: 'updates-input',
      type: 'text',
      spellcheck: 'false',
      placeholder: '{artist} - {title}',
    });
    templateInput.value = settings.downloads?.fileNameTemplate ?? '{artist} - {title}';
    const saveTemplate = (): void => {
      const next = templateInput.value.trim();
      const saved = getSettings().downloads.fileNameTemplate;
      if (next === saved) return;
      if (next.length === 0 || next.length > 120 || !/\{(artist|title|id|quality)\}/.test(next)) {
        templateInput.value = saved;
        toast('模板不能为空，且要包含 {artist}、{title}、{id}、{quality} 中的至少一个', 'error');
        return;
      }
      patchSettings({ downloads: { fileNameTemplate: next } });
      toast('文件名模板已更新');
    };
    templateInput.addEventListener('change', saveTemplate);
    templateInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        saveTemplate();
        templateInput.blur();
      }
    });
    const templateField = h(
      'div',
      { class: 'field is-stacked' },
      h('div', {}, h('div', { class: 'field-label', text: '文件名模板' }), templateInput),
      h('div', {
        class: 'field-hint',
        text: '支持 {artist}、{title}、{id}、{quality}；保存时会把非法字符替换成空格。留空不允许。',
      }),
    );
    const openFolderField = toggleField(
      '下载完成后打开文件夹',
      '每首下完都在资源管理器里选中文件。批量下载时可能连续弹窗，建议只在偶尔下载时打开。',
      settings.downloads?.openFolderWhenDone ?? false,
      (value) => patchSettings({ downloads: { openFolderWhenDone: value } }),
    );
    return section(
      '下载',
      h('div', { class: 'field' }, h('div', {}, h('div', { class: 'field-label', text: '下载目录' }), value), changeBtn, openBtn),
      qualityField,
      concurrencyField,
      templateField,
      openFolderField,
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

    function applyMediaKeys(value: boolean): void {
      patchSettings({ shortcuts: { alwaysHandleMediaKeys: value } });
      toast(value ? '媒体键将始终控制 Zilux2' : '媒体键已改回跟随系统当前播放器');
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

    const mediaKeyToggles = this.pillSwitch(getSettings().shortcuts.alwaysHandleMediaKeys, applyMediaKeys);
    const mediaKeysField = h(
      'div',
      { class: 'field', 'data-qa': 'shortcuts-media-keys' },
      h(
        'div',
        {},
        h('div', { class: 'field-label', text: '媒体键始终控制 Zilux2' }),
        h('div', {
          class: 'field-hint',
          text: '键盘上的播放/暂停、上一首、下一首（以及键盘驱动映射成这些媒体键的自定义键）始终切 Zilux2 的歌，即使正在用别的窗口或别的播放器；关闭后跟随系统当前播放器。',
        }),
      ),
      mediaKeyToggles.root,
    );
    mediaKeysField.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.pill-switch')) return;
      applyMediaKeys(!getSettings().shortcuts.alwaysHandleMediaKeys);
    });

    function patchShortcut(action: ShortcutAction, binding: string): void {
      // 每个动作写自己那一格；以前只处理前三个，后加的动作会错误地写进 toggleWindow。
      patchSettings({ shortcuts: { [action]: binding } as Partial<Record<ShortcutAction, string>> });
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
      const title = item.error ?? (item.fallback && item.applied ? '原组合被其他程序占用，已自动改用替代组合' : '');
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
      mediaKeyToggles.setValue(current.shortcuts.alwaysHandleMediaKeys);
      mediaKeysField.dataset.enabled = String(current.shortcuts.alwaysHandleMediaKeys);
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
      mediaKeysField,
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
          text: '系统媒体键（键盘上的播放 / 暂停、上一首、下一首）：默认始终由 Zilux2 接管——键盘驱动把自定义键映射成这些媒体键时，切到别的窗口也照样切歌；关闭上面的开关后，媒体键交还给系统当前播放器，保持原生「媒体键跟着当前播放器走」的习惯。',
        }),
      ),
      h(
        'div',
        { class: 'field' },
        h('div', {
          class: 'shortcut-tip',
          text: '窗口内快捷操作：空格播放 / 暂停，M 静音，Shift + ← / → 后退 / 前进 5 秒，Alt + ← / → 上一首 / 下一首，数字 1–4 记 / 跳热 cue（Shift + 数字清除），L 循环当前 4 小节，/ 或 Ctrl + F 打开搜索，Esc 关闭当前面板。',
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
      toggleField(
        '直连 GitHub',
        '不经过系统代理检查更新/下载安装包。系统代理的出口 IP 被 GitHub 限流（403 rate limit）时打开；国内网络直连失败时再关掉。',
        settings.updates.directConnection,
        (value) => {
          patchSettings({ updates: { directConnection: value } });
        },
      ),
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
    // 打开面板顺带做一次登录检测（in-flight 复用；发现失效会走 onAccountIssue 弹提醒）。
    void verifyAccounts().then((found) => {
      if (found.length > 0) this.syncAccount();
    });
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
      const issue = recentAccountIssues().find((item) => item.source === source);
      const expired = info.expired === true || (!info.loggedIn && issue !== undefined);
      const action = h('button', {
        class: `btn${info.loggedIn || expired ? '' : ' is-primary'}`,
        type: 'button',
        text: info.loggedIn ? '退出' : expired ? '重新登录' : '登录',
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
          { class: `account-row${expired ? ' is-expired' : ''}` },
          info.avatarDataUrl
            ? h('img', { class: 'account-row-avatar', src: info.avatarDataUrl, alt: '' })
            : h('span', { class: 'account-row-avatar account-dot', text: sourceMeta(source).short }),
          h(
            'div',
            { class: 'account-row-main' },
            h('div', {
              class: 'account-row-name',
              text: expired
                ? `${SOURCE_LABEL[source]} 登录已失效`
                : info.loggedIn
                  ? info.nickname ?? '已登录'
                  : `${SOURCE_LABEL[source]} 未登录`,
            }),
            h('div', {
              class: 'account-row-sub',
              text: expired
                ? issue?.reason ?? '登录已失效，请重新登录'
                : info.loggedIn
                  ? `${SOURCE_LABEL[source]}${info.vip === true ? ' · 会员' : ''}`
                  : '点击登录同步歌单',
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
    this.pbMiniTime = h('span', { class: 'pb-mini-time', text: '0:00 / 0:00' });
    this.pbMiniNext = h('span', { class: 'pb-mini-next is-empty', text: '' });
    this.pbMiniLine = h('div', { class: 'pb-mini-line' }, this.pbMiniTime, this.pbMiniNext);

    this.pbCoverWrap = h(
      'div',
      { class: 'pb-cover is-clickable', role: 'button', tabindex: '0', title: '查看歌词' },
      this.pbCover,
    );
    // 播放条封面：没进歌词就进，已经在歌词页就退出（同一个按钮来回切）。
    const openLyricsFromCover = () => {
      // 迷你窗只有 420×120，歌词页是整窗覆盖层，先退出迷你再进歌词。
      if (this.miniMode) {
        this.toggleMiniMode();
        return;
      }
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
      this.pbMiniLine,
    );
    // 歌名/歌手这一块也能进出歌词；用 pointerdown 避免播放条展开位移吞掉 click
    this.pbMeta.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.miniMode) {
        this.toggleMiniMode();
        return;
      }
      if (this.lyrics) this.closeLyrics();
      else this.openLyrics();
    });
    this.pbMeta.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (this.miniMode) {
        this.toggleMiniMode();
        return;
      }
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
    // 进度条上的标记：暖色带 = 无缝过渡区间，淡带 + 短竖线 = 能量最高的高潮段；
    // 虚线带 = 小节循环区间，数字刻度 = 热 cue（1–4）。
    this.pbMergeMark = h('div', { class: 'track-mark track-mark-merge is-off' });
    this.pbClimaxBand = h('div', { class: 'track-mark track-mark-climax-band is-off' });
    this.pbClimaxMark = h('div', { class: 'track-mark track-mark-climax is-off' });
    this.pbLoopBand = h('div', { class: 'track-mark track-mark-loop is-off' });
    this.pbCueMarks = [0, 1, 2, 3].map((slot) =>
      h('div', { class: `track-mark track-mark-cue is-off track-mark-cue-${slot + 1}` }),
    );
    this.pbMarks = h(
      'div',
      { class: 'track-marks' },
      this.pbLoopBand,
      this.pbClimaxBand,
      this.pbMergeMark,
      this.pbClimaxMark,
      ...this.pbCueMarks,
    );
    const track = h('div', { class: 'track', title: '点击或拖动跳转' }, rail, this.pbMarks);
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
      if (this.smartMixActive) this.exitSmartMix('manual');
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
    // 待播队列入口：迷你小窗放不下队列面板，先退出迷你、等窗口长回去再展开。
    this.pbQueueBtn = h(
      'button',
      { class: 'pb-btn pb-queue', title: '待播队列', 'data-qa': 'queue-toggle' },
      icon('list', 15),
    );
    this.pbQueueBtn.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openQueueFromPlaybar();
    });
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
      // 播放模式 / 收藏 / 下载 / 待播队列常驻显示，不随播放条收起而隐藏
      h('div', { class: 'pb-actions' }, this.pbModeBtn, this.pbLikeBtn, downloadBtn, this.pbQueueBtn),
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
    const dims = MINI_SIZE_DIMS[getSettings().appearance.miniSize] ?? MINI_SIZE_DIMS.standard;
    this.beginMiniTransition(enabled);
    host.setMiniMode(enabled, enabled ? dims.width : undefined, enabled ? dims.height : undefined);
  }

  /**
   * 过渡试放台：把「当前曲 → 下一首」的过渡计划画成时间轴和两条增益曲线，并可按真实时长
   * 模拟播放一遍（只跑视觉，不出声），用来检查接点、时长与低频交接是否合理。
   */
  private openCrossfadeLab(): void {
    this.closeCrossfadeLab();
    const state = playerState();
    const debug = readCrossfadeDebug();
    const next = state.queue[state.index + 1] ?? null;
    const current = state.track;

    const overlay = h('div', { class: 'lab-overlay', role: 'dialog', 'aria-label': '过渡试放台' });
    const closeBtn = h('button', { class: 'lab-close', title: '关闭', text: '×' });
    const close = (): void => this.closeCrossfadeLab();
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('pointerdown', (event) => {
      if (event.target === overlay) close();
    });

    const titleRow = h(
      'div',
      { class: 'lab-head' },
      h('div', { class: 'lab-kicker', text: '过渡试放台' }),
      closeBtn,
    );
    const titles = h(
      'div',
      { class: 'lab-titles' },
      h('div', { class: 'lab-title', text: current ? current.title : '未在播放' }),
      h('div', { class: 'lab-arrow', text: '→' }),
      h('div', { class: 'lab-title', text: next ? next.title : '没有下一首' }),
    );

    const body: HTMLElement[] = [titleRow, titles];

    if (!current || !next) {
      body.push(
        h('div', {
          class: 'lab-empty',
          text: current ? '队列里没有下一首，先有下一首才能试放过渡。' : '还没有在播放的歌曲。',
        }),
      );
    } else if (debug.fadeMs <= 0 || debug.phase !== 'prepared') {
      body.push(
        h('div', {
          class: 'lab-empty',
          text: '过渡计划还没准备好：先让这首歌播一会儿（或等下一首分析完成），再打开试放台。',
        }),
      );
    } else {
      const fadeMs = debug.fadeMs;
      const startMs = debug.fadeStartPosMs;
      const width = 640;
      const height = 150;
      const padX = 8;
      const topY = 34;
      const bottomY = height - 26;
      const spanX = width - padX * 2;
      const x = (ratio: number): number => padX + spanX * Math.max(0, Math.min(1, ratio));
      const style =
        debug.styleResolved === 'cut' ? 'cut' : debug.styleResolved === 'equal' ? 'equal' : 'am';
      const gainA = (t: number): number => (style === 'cut' ? (t < 0.02 ? 1 : 0) : style === 'equal' ? 1 - t : Math.cos((t * Math.PI) / 2));
      const gainB = (t: number): number => (style === 'cut' ? (t < 0.02 ? 0 : 1) : style === 'equal' ? t : Math.sin((t * Math.PI) / 2));
      const pathFor = (gain: (t: number) => number): string => {
        const points: string[] = [];
        for (let i = 0; i <= 40; i += 1) {
          const t = i / 40;
          points.push(`${i === 0 ? 'M' : 'L'}${x(t).toFixed(1)},${(bottomY - gain(t) * (bottomY - topY)).toFixed(1)}`);
        }
        return points.join(' ');
      };
      const svgNs = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNs, 'svg');
      svg.setAttribute('class', 'lab-curve');
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      const add = (tag: string, attrs: Record<string, string>, textNode?: string): SVGElement => {
        const node = document.createElementNS(svgNs, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
        if (textNode !== undefined) node.textContent = textNode;
        svg.appendChild(node);
        return node;
      };
      add('line', { x1: `${padX}`, y1: `${bottomY}`, x2: `${width - padX}`, y2: `${bottomY}`, class: 'lab-axis' });
      add('line', { x1: `${padX}`, y1: `${topY}`, x2: `${padX}`, y2: `${bottomY}`, class: 'lab-axis' });
      add('rect', {
        x: `${x(0)}`,
        y: `${topY}`,
        width: `${x(1) - x(0)}`,
        height: `${bottomY - topY}`,
        class: 'lab-overlap',
      });
      add('path', { d: pathFor(gainA), class: 'lab-gain lab-gain-a' });
      add('path', { d: pathFor(gainB), class: 'lab-gain lab-gain-b' });
      const bassT = Math.max(0, Math.min(1, debug.bassHandoffP));
      if (bassT > 0) {
        let bassX = x(bassT);
        let bassLabelX = bassX;
        add('line', { x1: `${bassX}`, y1: `${topY}`, x2: `${bassX}`, y2: `${bottomY}`, class: 'lab-bass' });
        const bassText = add('text', { x: `${bassLabelX}`, y: '18', class: 'lab-note' }, '低频交接');
        const bbox = (bassText as unknown as { getBBox?: () => { width: number } }).getBBox?.();
        const bassW = bbox?.width ?? 52;
        bassLabelX = Math.min(width - padX - bassW, Math.max(padX, bassX - bassW / 2));
        bassText.setAttribute('x', `${bassLabelX}`);
      }
      const playhead = add('line', {
        x1: `${padX}`,
        y1: `${topY - 8}`,
        x2: `${padX}`,
        y2: `${bottomY + 8}`,
        class: 'lab-playhead',
      });
      add('text', { x: `${padX}`, y: `${height - 6}`, class: 'lab-note' }, `${fmtTime(startMs)}`);
      add('text', { x: `${width - padX}`, y: `${height - 6}`, 'text-anchor': 'end', class: 'lab-note' }, `${fmtTime(startMs + fadeMs)}`);

      const stats = h(
        'div',
        { class: 'lab-stats' },
        h('div', { class: 'lab-stat' }, h('span', { class: 'lab-stat-label', text: '风格' }), h('span', { class: 'lab-stat-value', text: debug.styleResolved === 'am' ? '交融' : debug.styleResolved === 'equal' ? '等功率' : '快速切入' })),
        h('div', { class: 'lab-stat' }, h('span', { class: 'lab-stat-label', text: '淡化时长' }), h('span', { class: 'lab-stat-value', text: formatFadeSeconds(fadeMs) })),
        h('div', { class: 'lab-stat' }, h('span', { class: 'lab-stat-label', text: 'A 起点' }), h('span', { class: 'lab-stat-value', text: fmtTime(startMs) })),
        h('div', { class: 'lab-stat' }, h('span', { class: 'lab-stat-label', text: 'B 起播' }), h('span', { class: 'lab-stat-value', text: fmtTime(debug.bStartFileMs) })),
        h('div', { class: 'lab-stat' }, h('span', { class: 'lab-stat-label', text: '变速比' }), h('span', { class: 'lab-stat-value', text: debug.tempoMatched ? `×${debug.tempoRate.toFixed(3)}` : '不变速' })),
        h('div', { class: 'lab-stat' }, h('span', { class: 'lab-stat-label', text: '低频交接' }), h('span', { class: 'lab-stat-value', text: debug.bassHandoffP > 0 ? `第 ${Math.max(1, Math.round(debug.bassHandoffP * (debug.phraseBars || 2)))} 小节附近` : '不交接' })),
        h('div', { class: 'lab-stat' }, h('span', { class: 'lab-stat-label', text: '响度补偿' }), h('span', { class: 'lab-stat-value', text: `${debug.gainTrimDb >= 0 ? '+' : ''}${debug.gainTrimDb.toFixed(1)} dB` })),
        h('div', { class: 'lab-stat' }, h('span', { class: 'lab-stat-label', text: '混音方式' }), h('span', { class: 'lab-stat-value', text: debug.structureActive ? `结构混音 · ${debug.phraseBars} 小节` : debug.handoffActive ? '歌词衔接' : '普通淡化' })),
      );

      const playBtn = h('button', { class: 'btn', text: '模拟播放' });
      const progressText = h('span', { class: 'lab-progress', text: `0.0 / ${formatFadeSeconds(fadeMs)}` });
      let raf = 0;
      let startAt = 0;
      const stop = (): void => {
        window.cancelAnimationFrame(raf);
        raf = 0;
        playBtn.textContent = '模拟播放';
        playhead.setAttribute('x1', `${x(0)}`);
        playhead.setAttribute('x2', `${x(0)}`);
        progressText.textContent = `0.0 / ${formatFadeSeconds(fadeMs)}`;
      };
      const tick = (now: number): void => {
        if (!startAt) startAt = now;
        const elapsed = now - startAt;
        const ratio = Math.min(1, elapsed / fadeMs);
        const px = x(ratio);
        playhead.setAttribute('x1', `${px}`);
        playhead.setAttribute('x2', `${px}`);
        progressText.textContent = `${(ratio * fadeMs / 1000).toFixed(1)} / ${formatFadeSeconds(fadeMs)}  ${ratio >= 1 ? '· 完成' : ''}`;
        if (ratio < 1) raf = window.requestAnimationFrame(tick);
        else {
          raf = 0;
          playBtn.textContent = '再看一遍';
        }
      };
      playBtn.addEventListener('click', () => {
        if (raf) {
          stop();
          return;
        }
        startAt = 0;
        playBtn.textContent = '停止';
        raf = window.requestAnimationFrame(tick);
      });
      this.crossfadeLabStop = stop;
      body.push(h('div', { class: 'lab-stage' }, svg), stats, h('div', { class: 'lab-actions' }, playBtn, progressText));
    }

    const hint = h('div', {
      class: 'lab-hint',
      text: '这里只画计划与曲线、按真实时长走一遍播放头，不出声；实际听感以播放时的过渡为准。',
    });
    const card = h('div', { class: 'lab-card' }, ...body, hint);
    overlay.append(card);
    this.crossfadeLab = overlay;
    // 挂到 body 上，避免被设置面板的层叠上下文压住。
    document.body.append(overlay);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    this.crossfadeLabDispose = () => window.removeEventListener('keydown', onKey);
  }

  private closeCrossfadeLab(): void {
    this.crossfadeLabStop?.();
    this.crossfadeLabStop = null;
    this.crossfadeLabDispose?.();
    this.crossfadeLabDispose = null;
    this.crossfadeLab?.remove();
    this.crossfadeLab = null;
  }

  /** 播放条「待播队列」：迷你态先退出迷你，等窗口长回去再展开队列。 */
  private openQueueFromPlaybar(): void {
    if (this.miniMode && this.miniTransition === 'idle') {
      this.toggleMiniMode();
      window.setTimeout(() => {
        if (!this.miniMode && !this.upnextOpen) this.openUpNext();
      }, 480);
      return;
    }
    if (this.upnextOpen) this.closeUpNext();
    else this.openUpNext();
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
    const wasMini = this.miniMode;
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
    } else if (wasMini) {
      this.beginMiniRestore();
    }
    this.paintMiniBtn();
  }

  /**
   * 退出迷你的收尾：窗口已经长回原尺寸，过渡期被隐藏的界面此时一次性出现，
   * 给顶层节点补一段很短的淡入，避免「纯色幕布 → 整页」的硬切。
   */
  private beginMiniRestore(): void {
    if (this.miniRestoreTimer) window.clearTimeout(this.miniRestoreTimer);
    this.root.classList.remove('is-mini-restored');
    void this.root.offsetWidth;
    this.root.classList.add('is-mini-restored');
    this.miniRestoreTimer = window.setTimeout(() => {
      this.miniRestoreTimer = 0;
      this.root.classList.remove('is-mini-restored');
    }, 280);
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
    this.upnextTransition = h('div', { class: 'upnext-transition', 'data-qa': 'upnext-transition', text: '' });
    this.upnextSummary = h(
      'button',
      { class: 'upnext-summary', title: '待播队列（点击展开）' },
      kicker,
      this.upnextCover,
      h('div', { class: 'upnext-meta' }, this.upnextTitle, this.upnextArtist, this.upnextTransition),
      icon('chevron', 16),
    );
    this.upnextSummary.addEventListener('click', () => {
      if (this.upnextOpen) this.closeUpNext();
      else this.openUpNext();
    });

    const skip = h('button', { class: 'upnext-pill upnext-skip', title: '切换到下一首（当前这首不再播放）', text: '跳过这首' });
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
    const mixBtn = h('button', {
      class: 'upnext-pill upnext-mix',
      'data-qa': 'upnext-mix',
      title: 'AutoMix：按调性（Camelot）与 BPM 重排待播队列',
      text: 'AutoMix',
    });
    this.upnextMixBtn = mixBtn as HTMLButtonElement;
    mixBtn.addEventListener('click', () => {
      void this.runAutoMix();
    });
    this.upnextPanel = h(
      'div',
      { class: 'upnext-panel' },
      h(
        'div',
        { class: 'upnext-head' },
        h('div', { class: 'upnext-head-title', text: '待播队列' }),
        h('div', { class: 'upnext-head-actions' }, mixBtn, skip),
      ),
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
      key: 'cover' | 'lyrics' | 'bgLyrics' | 'play' | 'sound' | 'preview' | 'transition' | 'airplay' | 'download',
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
      tab('bgLyrics', '背景'),
      tab('play', '播放'),
      tab('sound', '音效'),
      tab('preview', '试听'),
      tab('transition', '过渡'),
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
    /** 拖动时的步长（默认同 step）：按钮粗调、拖动细调。 */
    dragStep?: number;
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
    const dragStep = options.dragStep ?? options.step;
    const quantize = (value: number): number => {
      const stepped = Math.round((value - options.min) / dragStep) * dragStep + options.min;
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
      if (track) cover.src = onlineArtwork(track, 300);
      if (track && !track.cover) {
        void lookupCover(track).then((found) => {
          if (!found) return;
          track.cover = found;
          cover.src = onlineArtwork(track, 300);
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
      const bgHint = h('div', { class: 'quick-cell-hint', text: '' });
      const paintBg = (): void => {
        // 三段：关闭 / 随歌曲封面 / 自定义图片（与设置 → 外观的「页面背景」共用同一套偏好）。
        const index = this.appBgMode === 'image' ? 2 : this.appBgMode === 'cover' ? 1 : 0;
        const button = bgBtns[index];
        if (!button) return;
        bgThumb.style.width = `${button.offsetWidth}px`;
        bgThumb.style.transform = `translateX(${button.offsetLeft}px)`;
        bgBtns.forEach((item, i) => item.classList.toggle('is-on', i === index));
        bgHint.textContent =
          this.appBgMode === 'image'
            ? '已选择自定义图片；再点一次「自定义」可以更换。'
            : this.appBgImage
              ? '已保存自定义图片，点「自定义」即可切到它。'
              : '自定义图片会压缩到 1600px 内保存到本机。';
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
      const bgCustomBtn = h('button', { class: 'quick-seg-btn', type: 'button', text: '自定义' });
      bgCustomBtn.addEventListener('click', () => {
        // 没图或已经在用自定义图：打开文件选择器（选完自动切到自定义图片并重新上色）；
        // 已有图但当前没在用：直接切过去，不再弹选择器。
        if (!this.appBgImage || this.appBgMode === 'image') {
          void this.pickBackgroundImage().then(() => paintBg());
          return;
        }
        this.setBackgroundMode('image');
        paintBg();
      });
      const bgSeg = h(
        'div',
        { class: 'quick-seg-slider quick-bg-seg' },
        bgThumb,
        bgBtn('关闭', false),
        bgBtn('随歌曲封面', true),
        bgCustomBtn,
      );
      bgBtns.push(bgCustomBtn);
      body.append(
        h(
          'div',
          { class: 'quick-cell is-wide' },
          h('div', { class: 'quick-cell-title', text: '背景' }),
          bgSeg,
          bgHint,
        ),
      );
      window.requestAnimationFrame(paintBg);
      return;
    }
    if (this.quickTab === 'bgLyrics') {
      const cell = (title: string, wide: boolean, ...children: HTMLElement[]): HTMLElement =>
        h(
          'div',
          { class: `quick-cell${wide ? ' is-wide' : ''}` },
          h('div', { class: 'quick-cell-title', text: title }),
          ...children,
        );
      // 「封面在左」：播放效果=关闭 时背景歌词的布局样式（纯壁纸 / 封面在左半边渐隐）。
      const bgCoverOptions: { id: BgLyricsCoverStyle; label: string }[] = [
        { id: 'wallpaper', label: '纯壁纸' },
        { id: 'cover', label: '封面在左' },
      ];
      const bgCoverThumb = h('div', { class: 'quick-seg-thumb' });
      const bgCoverBtns: HTMLButtonElement[] = bgCoverOptions.map((option) => {
        const btn = h('button', {
          class: `quick-seg-btn${option.id === bgLyricsCoverStyle() ? ' is-on' : ''}`,
          type: 'button',
          text: option.label,
        }) as HTMLButtonElement;
        btn.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        btn.addEventListener('click', () => {
          setBgLyricsCoverStyle(option.id);
          paintBgCover();
        });
        return btn;
      });
      const paintBgCover = (): void => {
        const current = bgLyricsCoverStyle();
        const index = Math.max(0, bgCoverOptions.findIndex((item) => item.id === current));
        bgCoverBtns.forEach((btn, i) => btn.classList.toggle('is-on', i === index));
        const active = bgCoverBtns[index];
        if (!active) return;
        bgCoverThumb.style.width = `${active.offsetWidth}px`;
        bgCoverThumb.style.transform = `translateX(${active.offsetLeft}px)`;
      };
      const bgCoverControl = h('div', { class: 'quick-seg-slider' }, bgCoverThumb, ...bgCoverBtns);
      paintBgCover();
      window.requestAnimationFrame(() => paintBgCover());
      // 封面右侧模糊强度 / 背景是否一起模糊（播放效果=关闭 + 封面在左时生效）。
      const makeChoiceSeg = <T extends string>(
        options: { id: T; label: string }[],
        current: () => T,
        pick: (id: T) => void,
      ): HTMLElement => {
        const thumb = h('div', { class: 'quick-seg-thumb' });
        const btns: HTMLButtonElement[] = options.map((option) => {
          const btn = h('button', { class: 'quick-seg-btn', type: 'button', text: option.label }) as HTMLButtonElement;
          btn.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            event.stopPropagation();
          });
          btn.addEventListener('click', () => {
            pick(option.id);
            paint();
          });
          return btn;
        });
        const paint = (): void => {
          const index = Math.max(0, options.findIndex((item) => item.id === current()));
          btns.forEach((btn, i) => btn.classList.toggle('is-on', i === index));
          const active = btns[index];
          if (!active) return;
          thumb.style.width = `${active.offsetWidth}px`;
          thumb.style.transform = `translateX(${active.offsetLeft}px)`;
        };
        const root = h('div', { class: 'quick-seg-slider' }, thumb, ...btns);
        paint();
        window.requestAnimationFrame(paint);
        return root;
      };
      const bgBlurControl = makeChoiceSeg<BgLyricsBlurLevel>(
        [
          { id: 'off', label: '不模糊' },
          { id: 'soft', label: '轻' },
          { id: 'medium', label: '中' },
          { id: 'strong', label: '重' },
        ],
        bgLyricsBlurLevel,
        setBgLyricsBlurLevel,
      );
      const bgFillControl = makeChoiceSeg<BgLyricsFillMode>(
        [
          { id: 'edge', label: '渐隐到壁纸' },
          { id: 'fill', label: '模糊铺满' },
        ],
        bgLyricsFillMode,
        setBgLyricsFillMode,
      );
      const backgroundLyricsSwitch = this.pillSwitch(
        getSettings().general.backgroundLyrics,
        (next) => {
          patchSettings({ general: { backgroundLyrics: next } });
          toast(next ? '桌面背景歌词已开启：歌词效果显示在桌面壁纸层' : '桌面背景歌词已关闭：软件内歌词恢复显示');
        },
      );
      body.append(
        h(
          'div',
          { class: 'quick-grid' },
          cell(
            '桌面背景歌词',
            true,
            backgroundLyricsSwitch.root,
            h('div', { class: 'quick-hint', text: '开启后歌词效果显示在桌面壁纸层，软件内歌词页暂时关闭' }),
          ),
          cell(
            '背景歌词样式',
            true,
            bgCoverControl,
            h('div', { class: 'quick-hint', text: '播放效果为「关闭」时生效；封面在左：封面铺满并向右侧渐隐/模糊，歌词移到右半边' }),
          ),
          cell('封面模糊', false, bgBlurControl),
          cell('封面之后', false, bgFillControl, h('div', { class: 'quick-hint', text: '模糊铺满：右侧不再露出壁纸，整屏都是封面的模糊延伸' })),
        ),
      );
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
          paintSolidVisibility();
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
      // 「纯色」档下的自定义颜色：预设色块 + 取色器；其他档位置灰隐藏。
      const solidPresets = [
        { label: '暖金', color: '#c9a068' },
        { label: '雾蓝', color: '#5d6f83' },
        { label: '青瓷', color: '#4f7d70' },
        { label: '绛紫', color: '#7a6484' },
        { label: '玫瑰', color: '#b3576b' },
        { label: '月白', color: '#e8e2d6' },
      ];
      const solidSwatches = h('div', { class: 'theme-swatches quick-unsung' });
      const solidCustom = h('input', {
        class: 'theme-color-input',
        type: 'color',
        value: lyricSolidColor() || '#c9a068',
        title: '自定义纯色',
      });
      const solidCustomLabel = h(
        'label',
        { class: 'theme-swatch is-custom', title: '自定义纯色' },
        solidCustom,
        h('span', { class: 'theme-swatch-plus', text: '+' }),
      );
      const paintSolid = (): void => {
        const saved = lyricSolidColor();
        solidSwatches.querySelectorAll<HTMLButtonElement>('.theme-swatch').forEach((button) => {
          button.classList.toggle('is-on', (button.dataset.color ?? '') === saved);
        });
        solidCustom.value = saved || '#c9a068';
        solidCustomLabel.classList.toggle('is-on', saved !== '');
      };
      for (const preset of solidPresets) {
        const button = h('button', { class: 'theme-swatch', type: 'button', title: preset.label });
        button.dataset.color = preset.color;
        button.style.setProperty('--swatch', preset.color);
        button.addEventListener('click', () => {
          setLyricSolidColor(preset.color);
          paintSolid();
        });
        solidSwatches.append(button);
      }
      solidCustom.addEventListener('input', () => {
        setLyricSolidColor(solidCustom.value);
        paintSolid();
      });
      solidSwatches.append(solidCustomLabel);
      paintSolid();
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
      const solidCell = cell(
        '纯色颜色',
        true,
        solidSwatches,
        h('div', { class: 'quick-hint', text: '只在「纯色」档生效；不选时跟随主题色' }),
      );
      const paintSolidVisibility = (): void => {
        solidCell.hidden = lyricsBackgroundMode() !== 'solid';
      };
      paintSolidVisibility();

      /** 分组标题：把歌词页签里的设置分块，避免一屏堆太多参数。 */
      const section = (title: string): HTMLElement =>
        h('div', { class: 'quick-section' }, h('span', { class: 'quick-section-title', text: title }));
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

      // 效果设置：文字/房间/唱片共用同一行、同一套按钮，点开的是当前效果对应的调节面板。
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
        vinyl: {
          action: '唱片设置…',
          hint: '唱片：歌词字体/颜色/排布、盘面配色、转速、唱臂与尘埃',
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
        const open =
          mode === 'text'
            ? openTextSettingsSheet
            : mode === 'room'
              ? openRoomSettingsSheet
              : openVinylSettingsSheet;
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
      // 「关闭」效果下未播放歌词的颜色：跟随主题 / 预设 / 自定义取色器。
      const unsungSwatches = h('div', { class: 'theme-swatches quick-unsung' });
      const unsungCustom = h('input', {
        class: 'theme-color-input',
        type: 'color',
        value: lyricUnsungColor() || '#5d6f83',
        title: '自定义未播放歌词颜色',
      });
      const unsungCustomLabel = h(
        'label',
        { class: 'theme-swatch is-custom', title: '自定义未播放歌词颜色' },
        unsungCustom,
        h('span', { class: 'theme-swatch-plus', text: '+' }),
      );
      const paintUnsung = (): void => {
        const saved = lyricUnsungColor();
        unsungSwatches.querySelectorAll<HTMLButtonElement>('.theme-swatch').forEach((button) => {
          button.classList.toggle('is-on', (button.dataset.color ?? '') === saved);
        });
        unsungCustom.value = saved || '#5d6f83';
        unsungCustomLabel.classList.toggle('is-on', saved !== '');
      };
      for (const preset of LYRIC_UNSUNG_PRESETS) {
        const button = h('button', { class: 'theme-swatch', type: 'button', title: preset.label });
        button.dataset.color = preset.color;
        button.style.setProperty('--swatch', preset.color || '#24262b');
        button.addEventListener('click', () => {
          setLyricUnsungColor(preset.color);
          paintUnsung();
        });
        unsungSwatches.append(button);
      }
      unsungCustom.addEventListener('input', () => {
        setLyricUnsungColor(unsungCustom.value);
        paintUnsung();
      });
      unsungSwatches.append(unsungCustomLabel);
      paintUnsung();
      body.append(
        h(
          'div',
          { class: 'quick-grid' },
          section('歌词内容'),
          cell('歌词来源', true, sourceValue),
          cell('跨平台匹配', true, matchValue),
          cell('匹配度阈值', false, thresholdStepper.root),
          cell('时间轴偏移', false, offsetStepper.root, reset),
          section('歌词外观'),
          cell('歌词颜色', true, bgControl),
          solidCell,
          cell('未播放颜色', true, unsungSwatches),
          styleCell,
          growCell,
          cell('播放效果', true, effectControl),
          effectSettingsCell,
          section('桌面背景歌词'),
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

    // 主设置里常用、但没必要为此开整页的开关：直接放进快捷设置。
    // 播放速度复用音量的调节器（按钮粗调 0.05×、拖动细调 0.01×），不再用五档分段。
    const speedStepper = this.quickStepper({
      value: Math.round(getPlaybackSpeed() * 100),
      min: 50,
      max: 200,
      step: 5,
      dragStep: 1,
      format: (percent) => `${(percent / 100).toFixed(2).replace(/0+$/, '').replace(/.$/, '')}×`,
      onInput: (percent) => {
        setPlaybackSpeed(percent / 100);
      },
    });

    const quickLoudnessSwitch = this.pillSwitch(loudnessEnabled(), (next) => {
      setLoudnessEnabled(next);
      this.applyLoudnessNow();
    });
    const quickNightSwitch = this.pillSwitch(nightModeEnabled(), (next) => {
      setNightModeEnabled(next);
    });
    const quickDesktopLyricsSwitch = this.pillSwitch(getSettings().general.desktopLyrics, (next) => {
      patchSettings({ general: { desktopLyrics: next } });
    });
    const quickMediaSessionSwitch = this.pillSwitch(getSettings().general.mediaSession, (next) => {
      patchSettings({ general: { mediaSession: next } });
    });

    // 主设置里常用的分段控件：统一用快捷设置的白色滑块分段。
    const quickSeg = <T extends string>(
      choices: { value: T; label: string }[],
      current: T,
      onPick: (value: T) => void,
    ): HTMLElement => {
      const thumb = h('div', { class: 'quick-seg-thumb' });
      const buttons: HTMLButtonElement[] = [];
      const paint = (): void => {
        const active = buttons.find((item) => item.classList.contains('is-on')) ?? buttons[0];
        if (!active) return;
        thumb.style.width = `${active.offsetWidth}px`;
        thumb.style.transform = `translateX(${active.offsetLeft}px)`;
      };
      choices.forEach((choice) => {
        const btn = h('button', {
          class: `quick-seg-btn${choice.value === current ? ' is-on' : ''}`,
          type: 'button',
          text: choice.label,
        });
        btn.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        btn.addEventListener('click', () => {
          buttons.forEach((node) => node.classList.toggle('is-on', node === btn));
          paint();
          onPick(choice.value);
        });
        buttons.push(btn);
      });
      const root = h('div', { class: 'quick-seg-slider' }, thumb, ...buttons);
      window.requestAnimationFrame(paint);
      return root;
    };

    // 试听
    const chorus = readChorusPreviewSettings();
    const previewDelaySeg = quickSeg(chorusPreviewDelayChoices(), String(chorus.delayMs), (value) => {
      writeChorusPreviewSettings({ delayMs: Number(value) });
    });
    const previewStartSeg = quickSeg(CHORUS_PREVIEW_START_CHOICES, chorus.startAt, (value) => {
      writeChorusPreviewSettings({ startAt: value });
    });
    const previewVolumeStepper = this.quickStepper({
      value: Math.round(chorus.volume * 100),
      min: 10,
      max: 100,
      step: 5,
      format: (value) => `${value}%`,
      onInput: (value) => {
        writeChorusPreviewSettings({ volume: value / 100 });
      },
    });
    const previewMaxSeg = quickSeg(CHORUS_PREVIEW_MAX_CHOICES, String(chorus.maxMs), (value) => {
      writeChorusPreviewSettings({ maxMs: Number(value) });
    });
    const previewTakeoverSwitch = this.pillSwitch(chorus.takeover, (next) => {
      writeChorusPreviewSettings({ takeover: next });
    });

    // 过渡
    const cross = readCrossfadeSettings();
    const crossEnabledSwitch = this.pillSwitch(cross.enabled, (next) => {
      writeCrossfadeSettings({ enabled: next });
      toast(next ? '已开启无缝衔接' : '已关闭无缝衔接');
    });
    const crossLengthModeSeg = quickSeg(
      [
        { value: 'auto', label: '自动' },
        { value: 'seconds', label: '秒' },
        { value: 'beats', label: '拍' },
        { value: 'bars', label: '小节' },
        { value: 'phrase', label: '乐句' },
      ],
      cross.lengthMode,
      (value) => {
        writeCrossfadeSettings({ lengthMode: value });
        window.requestAnimationFrame(() => this.renderQuickBody());
      },
    );
    const crossLengthValueHost = h('div', {});
    {
      const mode = cross.lengthMode;
      if (mode === 'auto' || mode === 'phrase') {
        crossLengthValueHost.append(
          h('div', {
            class: 'quick-cell-hint',
            text: mode === 'auto' ? '自动：按拍点 / 小节 / 前奏尾奏空间自适应' : '1 乐句 = 4 小节（小节太短时按 8 小节）',
          }),
        );
      } else {
        const choices =
          mode === 'seconds'
            ? CROSSFADE_LENGTH_CHOICES.map((value) => ({ value: String(value), label: `${value} 秒` }))
            : mode === 'beats'
              ? CROSSFADE_BEAT_CHOICES.map((value) => ({ value: String(value), label: `${value} 拍` }))
              : CROSSFADE_BAR_CHOICES.map((value) => ({ value: String(value), label: `${value} 小节` }));
        crossLengthValueHost.append(
          quickSeg(choices, String(cross.lengthValue), (value) => {
            writeCrossfadeSettings({ lengthValue: Number(value) });
          }),
        );
      }
    }
    const crossStyleSeg = quickSeg(
      [
        { value: 'auto', label: '自动' },
        { value: 'am', label: '交融' },
        { value: 'equal', label: '等功率' },
        { value: 'cut', label: '快速切入' },
      ],
      cross.style,
      (value) => {
        writeCrossfadeSettings({ style: value });
      },
    );
    const crossCueSeg = quickSeg(
      [
        { value: 'auto', label: '自动' },
        { value: 'drop', label: '进 drop' },
        { value: 'chorus', label: '进副歌' },
        { value: 'intro', label: '进 intro' },
      ],
      cross.cueMode,
      (value) => {
        writeCrossfadeSettings({ cueMode: value });
      },
    );
    const crossHandoffSwitch = this.pillSwitch(cross.handoff, (next) => {
      writeCrossfadeSettings({ handoff: next });
    });

    // 播放页新增：自动播放与媒体键
    const quickAutoPlaySwitch = this.pillSwitch(autoPlaySettings().enabled, (next) => {
      saveAutoPlaySettings({ enabled: next });
      toast(next ? '已开启：启动后自动播放' : '已关闭：启动后不自动播放');
    });
    const quickMediaKeysSwitch = this.pillSwitch(getSettings().shortcuts.alwaysHandleMediaKeys, (next) => {
      patchSettings({ shortcuts: { alwaysHandleMediaKeys: next } });
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
        cell('播放速度', false, speedStepper.root),
        cell('自动播放', false, quickAutoPlaySwitch.root),
        cell('媒体键始终控制', false, quickMediaKeysSwitch.root),
        cell('响度均衡', false, quickLoudnessSwitch.root),
        cell('夜间模式', false, quickNightSwitch.root),
        cell('桌面歌词', false, quickDesktopLyricsSwitch.root),
        cell('系统媒体控制', false, quickMediaSessionSwitch.root),

        cell('悬停试听延迟', true, previewDelaySeg),
        cell('预听起点', true, previewStartSeg),
        cell('最长试听时长', true, previewMaxSeg),
        cell('试听音量', false, previewVolumeStepper.root),
        cell('点击接管续播', false, previewTakeoverSwitch.root),

        cell('过渡时长模式', true, crossLengthModeSeg),
        cell('过渡时长数值', true, crossLengthValueHost),
        cell('过渡风格', true, crossStyleSeg),
        cell('B 入场时机', true, crossCueSeg),
        cell('无缝衔接', false, crossEnabledSwitch.root),
        cell('歌词衔接', false, crossHandoffSwitch.root),
      ),
      h('div', {
        class: 'quick-hint',
        text: `${sourceMeta(qualitySource).label} · ${
          qualityOptions.length > 1 ? '音质以账号权限为准，不可用时自动降级' : '该平台暂不支持切换音质，跟随账号权限'
        }`,
      }),
    );

    // 设置类控件分成「播放 / 音效 / 试听 / 过渡」四页（在底部标签栏直接切换）：每页只放同类控件。
    const group: 'play' | 'sound' | 'preview' | 'transition' =
      this.quickTab === 'sound'
        ? 'sound'
        : this.quickTab === 'preview'
          ? 'preview'
          : this.quickTab === 'transition'
            ? 'transition'
            : 'play';
    const groupOfTitle = new Map<string, 'play' | 'sound' | 'preview' | 'transition'>([
      ['音量', 'play'],
      ['播放模式', 'play'],
      ['播放速度', 'play'],
      ['自动播放', 'play'],
      ['媒体键始终控制', 'play'],
      ['桌面歌词', 'play'],
      ['系统媒体控制', 'play'],
      ['音质', 'sound'],
      ['均衡器', 'sound'],
      ['播放/暂停渐变', 'sound'],
      ['人声保留淡出', 'sound'],
      ['响度均衡', 'sound'],
      ['夜间模式', 'sound'],
      ['悬停试听延迟', 'preview'],
      ['预听起点', 'preview'],
      ['试听音量', 'preview'],
      ['最长试听时长', 'preview'],
      ['点击接管续播', 'preview'],
      ['无缝衔接', 'transition'],
      ['过渡时长模式', 'transition'],
      ['过渡时长数值', 'transition'],
      ['过渡风格', 'transition'],
      ['B 入场时机', 'transition'],
      ['歌词衔接', 'transition'],
    ]);
    for (const node of Array.from(body.querySelectorAll<HTMLElement>('.quick-cell'))) {
      const title = node.querySelector('.quick-cell-title')?.textContent ?? '';
      const cellGroup = groupOfTitle.get(title);
      if (cellGroup) node.dataset.group = cellGroup;
      node.classList.toggle('is-group-hidden', !!cellGroup && cellGroup !== group);
    }
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
    // 小窗口里内容比可用高度还高时，别让面板顶出屏幕：直接交给正文滚动，不再播高度动画，
    // 否则滚动条出现/消失会反过来改变内容宽度、触发 ResizeObserver，滚动条就一直在闪。
    const max = this.quickBodyMaxHeight();
    const fromH = Math.min(from, max);
    const toH = Math.min(to, max);
    if (to >= max - 0.5) {
      body.style.height = '';
      body.style.overflow = '';
      return;
    }
    body.style.overflow = 'clip';
    body.style.height = `${fromH}px`;
    void body.offsetHeight;
    body.style.height = `${toH}px`;
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

  /** 快捷设置正文在小窗口里可用的最大高度（给标题、页签栏与内边距留出空间）。 */
  private quickBodyMaxHeight(): number {
    return Math.max(160, window.innerHeight - 300);
  }

  private syncQuickBodyHeight(): void {
    if (!this.quickPanelOpen || this.quickHeightTimer) return;
    const inner = this.quickBodyInner ?? this.quickBody;
    const body = this.quickBody;
    if (!inner || !body) return;
    const natural = inner.offsetHeight;
    const current = body.getBoundingClientRect().height;
    const max = this.quickBodyMaxHeight();
    if (natural > max) {
      // 内容超过可用高度：正文进入滚动模式，内联高度会让滚动条与观察器互相触发，清掉即可。
      if (body.style.height || body.style.overflow) {
        body.style.height = '';
        body.style.overflow = '';
      }
      return;
    }
    const target = Math.min(natural, max);
    if (natural <= 0 || Math.abs(target - current) < 1.5) return;
    this.animateQuickBodyHeight(current, target);
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

  private setQuickTab(key: 'cover' | 'lyrics' | 'bgLyrics' | 'play' | 'sound' | 'preview' | 'transition' | 'airplay' | 'download'): void {
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
    const source = mode === 'image' ? this.appBgImage : track ? onlineArtwork(track, 300) : '';
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
    // 随机播放没有固定顺序：从「真正会播的下一首」开始轮转展示，列表第一行永远等于小卡上的下一首。
    const planned = state.mode === 'single' ? null : peekUpcoming();
    const entries: Array<{ index: number; track: OnlineTrack }> = [];
    if (state.mode === 'shuffle' && planned && state.queue.length > 1) {
      const total = state.queue.length;
      for (let step = 0; step < total; step += 1) {
        const index = (planned.index + step) % total;
        if (index === state.index) continue;
        const track = state.queue[index];
        if (track) entries.push({ index, track });
      }
    } else {
      state.queue.slice(state.index + 1).forEach((track, offset) => entries.push({ index: state.index + 1 + offset, track }));
    }
    const listKey = `${state.index}|${state.mode}|${planned?.index ?? -1}|${entries.map((item) => `${item.track.source}:${item.track.id}`).join(',')}`;
    if (!force && listKey === this.upnextListKey) return;
    this.upnextListKey = listKey;
    this.upnextList.textContent = '';
    if (entries.length === 0) {
      this.upnextList.append(h('li', { class: 'upnext-empty', text: '队列里没有下一首了' }));
      return;
    }
    entries.forEach(({ index, track }, offset) => {
      // 待播行的操作：上移 / 下移 / 移出队列（跳过）。点击不会触发行的选中与双击播放。
      const upBtn = h('button', { class: 'upnext-act', title: '上移', 'aria-label': '上移' }, icon('chevronUp', 14));
      const downBtn = h('button', { class: 'upnext-act', title: '下移', 'aria-label': '下移' }, icon('chevronDown', 14));
      const removeBtn = h('button', { class: 'upnext-act is-remove', title: '跳过这首（移出队列）', 'aria-label': '跳过这首' }, icon('trash', 14));
      (upBtn as HTMLButtonElement).disabled = offset === 0;
      (downBtn as HTMLButtonElement).disabled = offset === entries.length - 1;
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
        h('img', { class: 'upnext-cover', src: onlineArtwork(track, 120), alt: '' }),
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
    // 下一首以「真正会播放的那一首」为准：shuffle 的随机结果在准备阶段固定，
    // 不能再用 queue[index + 1]（那只是队列里的下一行，随机播放时和实际下一首不一致）。
    const planned = state.mode === 'single' ? null : peekUpcoming();
    const upcoming = planned?.track ?? null;
    const visible = state.track !== null && upcoming !== null;
    this.upnextRoot.classList.toggle('is-hidden', !visible);
    if (!visible || upcoming === null) {
      this.closeUpNext();
      this.syncUpNextTransition(state);
      return;
    }
    this.upnextCover.src = onlineArtwork(upcoming, 120);
    this.upnextTitle.textContent = upcoming.title;
    this.upnextArtist.textContent = upcoming.artist || '未知歌手';
    this.syncUpNextTransition(state);
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

  /**
   * 睡眠定时到点：先按设置做音量渐弱（不写入设置，结束恢复原音量），
   * 再暂停，最后执行「暂停 / 最小化 / 退出」。
   */
  private async handleSleepTimerFired(): Promise<void> {
    const settings = getSettings().playback;
    const fadeSeconds = Math.max(0, Math.min(60, Math.round(settings.sleepFadeSeconds ?? 15)));
    const action = settings.sleepAction ?? 'pause';
    const wasPlaying = playerState().playing;
    if (wasPlaying && fadeSeconds > 0) {
      const from = playerState().volume;
      this.sleepFadeVolume = from;
      const token = ++this.sleepFadeToken;
      const steps = Math.max(1, Math.round(fadeSeconds * 10));
      for (let step = 1; step <= steps; step += 1) {
        if (token !== this.sleepFadeToken) return;
        setVolume(from * (1 - step / steps));
        await new Promise((resolve) => window.setTimeout(resolve, (fadeSeconds * 1000) / steps));
      }
      if (token !== this.sleepFadeToken) return;
      this.sleepFadeVolume = null;
      setVolume(from);
    }
    if (playerState().playing) toggle();
    if (action === 'minimize') {
      host.minimize();
      toast('睡眠定时已到，已暂停并最小化');
    } else if (action === 'exit') {
      toast('睡眠定时已到，正在退出');
      window.setTimeout(() => host.close(), 400);
    } else {
      toast('睡眠定时已到，已暂停播放');
    }
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

  private modeLabel(mode: PlayerState['mode']): string {
    return mode === 'list' ? '列表循环' : mode === 'single' ? '单曲循环' : '随机播放';
  }

  private paintModeBtn(mode: PlayerState['mode']): void {
    this.pbModeBtn.textContent = '';
    if (this.smartMixActive) {
      this.pbModeBtn.append(icon('smartmix', 17));
      this.pbModeBtn.title = `AutoMix（临时）· 播放其他歌单或手动选歌后恢复${this.modeLabel(this.smartMixPrevMode)}`;
      this.pbModeBtn.classList.add('is-active', 'is-smart');
      this.pbModeBtn.dataset.mode = 'smartmix';
      return;
    }
    this.pbModeBtn.classList.remove('is-smart');
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
      this.pbMiniTime.textContent = '0:00 / 0:00';
      this.pbMiniNext.textContent = '';
      this.pbMiniNext.classList.add('is-empty');
      this.pbClimaxKey = '';
      this.pbClimaxRange = null;
      this.paintProgressMarks(null);
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
      this.pbCover.src = onlineArtwork(track, 300);
      this.paintAppBg(track);
      if (!track.cover) {
        // 本地曲目常没有内嵌封面：去线上按歌名/歌手找一张
        void lookupCover(track).then((found) => {
          if (!found) return;
          track.cover = found;
          const now = playerState().track;
          if (!now || `${now.source}:${now.id}` !== trackKey) return;
          this.pbCover.src = onlineArtwork(track, 300);
          if (this.appBgMode !== 'none') this.paintAppBg(track);
          if (this.upnextCover && this.upnextTitle && this.upnextTitle.textContent) {
            const next = playerState().queue[playerState().index + 1];
            if (next && `${next.source}:${next.id}` === trackKey) this.upnextCover.src = onlineArtwork(next, 120);
          }
          if (this.quickTab === 'cover') this.renderQuickBody();
        });
      }
      // 换歌即预载当前平台歌词，并在后台匹配其它平台的逐字歌词。
      void primeLyrics(track);
      this.loadClimax(track);
      refreshLoudness(track);
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
    this.paintProgressMarks(state);
    this.pbCur.textContent = fmtTime(state.positionMs);
    this.pbDur.textContent = fmtTime(state.durationMs);
    this.paintMiniMeta(state);
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
    this.syncUpNextTransition(state);
  }

  /**
   * 迷你态第三行（时间 / 下一首）：只在文本真的变化时写 DOM，避免播放器每秒同步时反复触发布局。
   * 普通窗口里这一行由 `.pb-mini-line{display:none}` 隐藏。
   */
  private paintMiniMeta(state: PlayerState): void {
    if (!this.pbMiniTime || !this.pbMiniNext) return;
    const time = `${fmtTime(state.positionMs)} / ${fmtTime(state.durationMs)}`;
    if (this.pbMiniTime.textContent !== time) this.pbMiniTime.textContent = time;
    const upcoming = state.queue[state.index + 1];
    const label = upcoming
      ? `下一首 · ${upcoming.title}`
      : state.queue.length > 1
        ? '已是队列最后一首'
        : '';
    if (this.pbMiniNext.textContent !== label) this.pbMiniNext.textContent = label;
    this.pbMiniNext.classList.toggle('is-empty', label === '');
    this.pbMiniNext.title = upcoming
      ? `${upcoming.title}${upcoming.artist ? ` · ${upcoming.artist}` : ''}`
      : '';
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
      return;
    }
    // 计划第一次出现时先弹 6 秒让人看到，然后就收起；等真正进入最后 10 秒再常驻倒数。
    const planKey = `${debug.currentTitle}->${debug.nextTitle}:${debug.fadeStartPosMs}`;
    if (planKey !== this.hintShownKey) {
      this.hintShownKey = planKey;
      this.hintShownAt = Date.now();
    }
    const HINT_FRESH_MS = 6000;
    const HINT_NEAR_MS = 10000;
    const fresh = Date.now() - this.hintShownAt <= HINT_FRESH_MS;
    if (remainingMs > HINT_NEAR_MS && !fresh) {
      this.hideSeamlessHint();
      return;
    }
    const next = debug.nextTitle || '下一首';
    const fadeText = debug.fadeMs > 0 ? `（过渡约 ${formatFadeSeconds(debug.fadeMs)}）` : '';
    const text = `将在 ${formatCountdownSpan(remainingMs)}后过渡至「${next}」${fadeText}`;
    if (hint.textContent !== text) hint.textContent = text;
    hint.classList.add('is-visible');
  }

  private hideSeamlessHint(): void {
    if (this.seamlessHint) this.seamlessHint.classList.remove('is-visible');
  }

  /**
   * 播放条上方的「下一首过渡预告」：说明下一首是谁、这次怎么过渡；进入准备阶段后
   * 改成实际淡化时长与起点（来自 crossfadeDeck 的调试快照）。可在过渡设置里关闭。
   */
  /**
   * 待播队列小卡里的「过渡」行：说明下一次过渡会怎么接；进入准备阶段后改成
   * 实际淡化时长与起点（来自 crossfadeDeck 的调试快照）。可在过渡设置里关闭。
   */
  private syncUpNextTransition(state: PlayerState): void {
    const el = this.upnextTransition;
    if (!el) return;
    // 这里反映「这首歌记忆的过渡」，而不是全局设置。
    const settings = effectiveCrossfadeSettings(state.track);
    const next = state.queue[state.index + 1] ?? null;
    if (!next || !settings.enabled || !settings.showPreview) {
      if (!el.classList.contains('is-hidden')) {
        el.classList.add('is-hidden');
        this.pbTransitionKey = '';
      }
      return;
    }
    const debug = readCrossfadeDebug();
    const prepared = debug.phase === 'prepared' && debug.fadeMs > 0 && debug.nextTitle !== '';
    const text = prepared
      ? `过渡 ${formatFadeSeconds(debug.fadeMs)} · 从 ${fmtTime(debug.fadeStartPosMs)} 起`
      : crossfadeSummary(settings);
    if (text === this.pbTransitionKey) {
      el.classList.remove('is-hidden');
      return;
    }
    this.pbTransitionKey = text;
    el.textContent = text;
    el.classList.remove('is-hidden');
  }


  /**
   * 取当前曲目的高潮段，只用于进度条标记：优先用宿主 p0-7 给出的 8 小节窗口
   * （climaxStartMs/climaxEndMs），旧宿主/旧缓存回退到 label === 'climax' 的 section。
   * 分析失败/没有高潮段时静默不画；换歌后旧结果按 pbClimaxKey 丢弃。
   */
  /** 「场景」页：4 张按分析结果分桶的智能歌单。 */
  private openMoodsPage(): void {
    this.wallPager = null;
    this.setRailActive('moods');
    this.wall = {
      kind: 'moods',
      title: '场景歌单',
      subtitle: '用节拍、能量与调性自动分桶 · 点开生成并可直接播放',
      tracks: [],
    };
    this.renderWall();
  }

  private buildMoodGrid(): HTMLElement {
    const grid = h('div', { class: 'disc-grid' });
    for (const def of MOOD_DEFS) {
      const cover = h(
        'div',
        { class: 'ui-tile-cover mood-cover', 'data-mood': def.id },
        h('div', { class: 'mood-glow' }),
        icon('mood', 34),
        h('span', { class: 'mood-cover-tag', text: '生成歌单' }),
      );
      const tile = h(
        'button',
        { class: 'ui-tile mood-tile', title: def.hint },
        cover,
        h('span', { class: 'ui-tile-name', text: def.label }),
        h('span', { class: 'ui-tile-meta', text: def.hint }),
      );
      tile.addEventListener('click', () => void this.openMood(def));
      grid.append(tile);
    }
    return grid;
  }

  private async openMood(def: MoodDef): Promise<void> {
    this.setRailActive('moods');
    this.wall = { kind: 'mood', title: `场景 · ${def.label}`, subtitle: `${def.hint} · 正在分析…`, tracks: [] };
    this.renderWall();
    const pool = await this.collectMoodPool();
    const match = await matchMood(def, pool);
    if (this.wall.kind !== 'mood' || this.wall.title !== `场景 · ${def.label}`) return;
    this.wall = {
      kind: 'mood',
      title: `场景 · ${def.label}`,
      subtitle:
        match.tracks.length > 0
          ? `${def.hint} · ${match.tracks.length} 首（已分析 ${match.analyzed} 首）`
          : match.analyzed > 0
            ? `${def.hint} · 暂时没有匹配的歌曲（已分析 ${match.analyzed} 首，多播放几首后结果会更全）`
            : `${def.hint} · 还没有可用的分析结果，先播放几首歌再试`,
      tracks: match.tracks,
    };
    this.renderWall(true);
  }

  /** 把当前墙里的歌曲存成一个本地歌单（场景 / 每日推荐 / 喜欢 / 最近播放都能用）。 */
  private saveWallAsPlaylist(): void {
    const tracks = this.wall.tracks;
    if (tracks.length === 0) {
      toast('这个列表里还没有歌曲');
      return;
    }
    const base = this.wall.title.replace(/^场景 · /, '').replace(/^[「」]/g, '').trim() || '智能歌单';
    const stamp = new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
    const playlist = createSmartPlaylist(`${base} · ${stamp}`, tracks);
    toast(`已存为智能歌单「${playlist.name}」· ${playlist.tracks.length} 首`);
  }

  /** 按「实际经过的墙上时间」累计收听时长；换歌时记一次开播。 */
  private accumulateListening(state: PlayerState): void {
    const track = state.track;
    if (!track) {
      this.listenKey = '';
      this.listenAt = 0;
      return;
    }
    const key = `${track.source}:${track.id}`;
    const now = Date.now();
    if (key !== this.listenKey) {
      this.listenKey = key;
      this.listenAt = now;
      recordListenStart(track);
      return;
    }
    if (!state.playing || !this.listenAt) {
      this.listenAt = now;
      return;
    }
    const delta = now - this.listenAt;
    // 大于 5s 视作暂停/休眠期间，不计入；避免开着页面不播还算时长。
    if (delta > 0 && delta < 5000) recordListenTime(track, delta);
    this.listenAt = now;
  }

  private desktopLyricNow: string | null = null;
  private desktopLyricTranslation: string | null = null;
  private desktopLyricKey = '';

  /** 桌面歌词：把当前句推给宿主窗口（换歌或句/翻译变化时才发送）。 */
  private pushDesktopLyrics(): void {
    const settings = getSettings();
    if (!settings.general.desktopLyrics) {
      this.desktopLyricNow = null;
      this.desktopLyricTranslation = null;
      this.desktopLyricKey = '';
      return;
    }
    const state = playerState();
    const track = state.track;
    if (!track) return;
    const key = `${track.source}:${track.id}`;
    if (key !== this.desktopLyricKey) {
      this.desktopLyricKey = key;
      this.desktopLyricNow = null;
      this.desktopLyricTranslation = null;
    }
    // 桌面歌词要在没打开歌词页时也能用：先把歌词拉下来（内部去重）。
    primeLyrics(track);
    const { now, translation } = currentLyricDisplay();
    if (now === this.desktopLyricNow && translation === this.desktopLyricTranslation) return;
    this.desktopLyricNow = now;
    this.desktopLyricTranslation = translation;
    // 没有歌词的曲目也给一个占位，别让窗口一直停在初始文案。
    updateDesktopLyrics(now || '♪', translation);
  }

  /** 收听统计整页：总览卡片、近 14 天时长柱、最爱歌曲与歌手。 */
  private buildStatsPage(): HTMLElement {
    const stats = readListeningStats();
    const page = h('div', { class: 'stats-page' });
    const days = dailyListening(14);
    const activeDays = days.filter((day) => day.ms > 0).length;
    const recentMs = days.reduce((sum, day) => sum + day.ms, 0);
    const card = (label: string, value: string, hint: string): HTMLElement =>
      h(
        'div',
        { class: 'stats-card' },
        h('div', { class: 'stats-card-label', text: label }),
        h('div', { class: 'stats-card-value', text: value }),
        h('div', { class: 'stats-card-hint', text: hint }),
      );

    const year = new Date().getFullYear();
    const topTracks = topListenedTracks(10);
    const topArtists = topListenedArtists(8);
    if (stats.totalMs === 0) {
      page.append(
        h(
          'div',
          { class: 'stats-empty' },
          h('div', { class: 'stats-empty-icon' }, icon('chart', 26)),
          h('div', { class: 'stats-empty-title', text: '还没有收听记录' }),
          h('div', { class: 'stats-empty-hint', text: '播放任意一首歌超过 10 秒，这里就会开始累计。' }),
          h('div', { class: 'stats-empty-hint', text: '统计只保存在这台设备上，不会上传。' }),
        ),
      );
      return page;
    }
    if (stats.totalMs > 0) {
      page.append(
        h(
          'div',
          { class: 'stats-year-banner' },
          h('div', { class: 'stats-year-title', text: `${year} 听歌小结` }),
          h(
            'div',
            { class: 'stats-year-line' },
            h('span', { text: `这 ${Math.max(1, activeDays)} 天里，最多的是 ` }),
            h('strong', { text: topArtists[0]?.name ?? '未知歌手' }),
            h('span', { text: topArtists[0] ? `（${formatListening(topArtists[0].ms)}）` : '' }),
          ),
          h(
            'div',
            { class: 'stats-year-line' },
            h('span', { text: '循环最多的一首是 ' }),
            h('strong', { text: topTracks[0]?.title ?? '还没开始' }),
            h('span', { text: topTracks[0] ? `，共 ${formatListening(topTracks[0].ms)}` : '' }),
          ),
        ),
      );
    }

    page.append(h('div', { class: 'section-title', text: '总览' }), h('div', { class: 'stats-cards' },
      card('总收听时长', formatListening(stats.totalMs), `${stats.plays} 次开播`),
      card('最近 14 天', formatListening(recentMs), activeDays > 0 ? `${activeDays} 天有播放` : '还没有播放记录'),
      card('单曲最多', topTracks[0] ? formatListening(topTracks[0].ms) : '—', topTracks[0]?.title ?? '还没有数据'),
    ));

    const max = Math.max(1, ...days.map((day) => day.ms));
    const chart = h('div', { class: 'stats-chart' });
    for (const day of days) {
      const bar = h(
        'div',
        { class: 'stats-bar', title: `${day.day} · ${formatListening(day.ms)}` },
        h('div', { class: 'stats-bar-fill', style: `height:${day.ms > 0 ? Math.max(4, Math.round((day.ms / max) * 100)) : 0}%` }),
      );
      chart.append(
        h(
          'div',
          { class: 'stats-bar-col' },
          h('div', { class: 'stats-bar-slot' }, bar),
          h('span', { class: 'stats-bar-label', text: day.day.slice(5) }),
        ),
      );
    }
    page.append(h('div', { class: 'section-title', text: '最近 14 天' }), chart);

    if (topTracks.length > 0) {
      page.append(h('div', { class: 'section-title', text: '播放最多的歌曲' }));
      const list = h('div', { class: 'stats-list' });
      topTracks.forEach((row, index) => {
        const bar = h('div', { class: 'stats-share' }, h('div', { class: 'stats-share-fill', style: `width:${Math.max(2, Math.round(row.share * 100))}%` }));
        list.append(
          h(
            'div',
            { class: index < 3 ? 'stats-row is-top' : 'stats-row' },
            h('span', { class: 'stats-rank', text: String(index + 1) }),
            h('div', { class: 'stats-meta' }, h('div', { class: 'stats-name', text: row.title }), h('div', { class: 'stats-artist', text: row.artist || '未知歌手' }), bar),
            h('div', { class: 'stats-value' }, h('div', { text: formatListening(row.ms) }), h('div', { class: 'stats-sub', text: `${row.plays} 次 · ${Math.round(row.share * 100)}%` })),
          ),
        );
      });
      page.append(list);
    }

    if (topArtists.length > 0) {
      page.append(h('div', { class: 'section-title', text: '播放最多的歌手' }));
      const chips = h('div', { class: 'stats-artists' });
      for (const artist of topArtists) {
        chips.append(
          h(
            'div',
            { class: 'stats-artist-chip', title: `${artist.name} · ${formatListening(artist.ms)}` },
            h('span', { class: 'stats-artist-name', text: artist.name }),
            h('span', { class: 'stats-artist-time', text: formatListening(artist.ms) }),
          ),
        );
      }
      page.append(chips);
    }

    const resetBtn = h('button', { class: 'pill', title: '清空本机收听统计' }, icon('trash', 16), h('span', { text: '清除统计' }));
    resetBtn.addEventListener('click', () => {
      void confirmDialog({
        title: '清除收听统计',
        message: '清空这台设备上的收听统计？',
        detail: '只会删除本地统计，不会影响歌单、收藏或云上数据。',
        confirmText: '清除',
        tone: 'danger',
        iconName: 'trash',
      }).then((ok) => {
        if (!ok) return;
        resetListeningStats();
        toast('已清除收听统计');
        this.renderWall(true);
      });
    });
    page.append(h('div', { class: 'stats-actions' }, resetBtn));
    return page;
  }

  /** 收听统计页（总览 / 最近 14 天 / 最爱歌曲与歌手）。 */
  private openStatsPage(): void {
    this.wallPager = null;
    this.setRailActive('stats');
    this.wall = { kind: 'stats', title: '收听统计', subtitle: '只统计这台设备上的实际播放时长', tracks: [] };
    this.renderWall();
  }

  private async collectMoodPool(): Promise<OnlineTrack[]> {
    const sources: OnlineSource[] = [];
    for (const account of getAccounts()) {
      if (account.loggedIn) sources.push(account.source as OnlineSource);
    }
    const lists = await Promise.all([
      Promise.resolve(localTracks()),
      ...sources.map((source) => this.fetchLikedTracks(source)),
      fetchRecentMerged(200).catch(() => [] as OnlineTrack[]),
    ]);
    const seen = new Set<string>();
    const pool: OnlineTrack[] = [];
    for (const list of lists) {
      for (const track of list ?? []) {
        const key = `${track.source}:${track.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push(track);
        if (pool.length >= 160) return pool;
      }
    }
    return pool;
  }

  /** AutoMix：按调性与 BPM 重排待播队列（AutoMix），并进入临时图标模式。 */
  private async runAutoMix(): Promise<void> {
    const before = playerState();
    const beforeNext = before.queue[before.index + 1];
    const result = await orderUpcomingByMix();
    if (!result) {
      toast('待播队列不足，先加几首歌再试');
      return;
    }
    this.enterSmartMix();
    this.renderUpNextList(true);
    const after = playerState();
    const afterNext = after.queue[after.index + 1];
    const sameNext =
      !!beforeNext &&
      !!afterNext &&
      beforeNext.source === afterNext.source &&
      beforeNext.id === afterNext.id;
    const coverage = result.analyzed >= 8 ? '' : '；多播放几首、分析变多后排序会更准';
    const nextNote = afterNext
      ? sameNext
        ? `；下一首仍是「${afterNext.title}」${result.analyzed < 8 ? '（分析数据不足时排序可能不变）' : ''}`
        : `；下一首换成「${afterNext.title}」`
      : '';
    toast(`AutoMix：已按调性 / BPM 重排 ${result.total} 首${coverage}${nextNote}`);
    // 重排后计划会重建；这里补一次重绘，暂停状态下也能立刻看到新的渐变位置。
    this.paintProgressMarks(playerState());
  }

  /** 进入AutoMix的临时图标状态（不改播放模式本身，只换按钮图标）。 */
  private paintMixBtn(): void {
    const btn = this.upnextMixBtn;
    if (!btn) return;
    btn.classList.toggle('is-active', this.smartMixActive);
    btn.setAttribute('aria-pressed', this.smartMixActive ? 'true' : 'false');
    btn.title = this.smartMixActive
      ? 'AutoMix 已启用（点击重新按调性 / BPM 排序）'
      : 'AutoMix：按调性（Camelot）与 BPM 重排待播队列';
  }

  private enterSmartMix(): void {
    if (!this.smartMixActive) this.smartMixPrevMode = playerState().mode;
    this.smartMixActive = true;
    this.paintModeBtn(playerState().mode);
    this.paintMixBtn();
  }

  /** 退出临时图标状态，恢复点击前的播放模式图标。 */
  private exitSmartMix(_reason: 'queue' | 'manual' | 'mode'): void {
    if (!this.smartMixActive) return;
    this.smartMixActive = false;
    this.paintModeBtn(playerState().mode);
    this.paintMixBtn();
  }

  /** 设置页改了响度均衡 / 夜间模式后立即对当前曲目重算补偿。 */
  private applyLoudnessNow(): void {
    refreshLoudness(playerState().track);
  }

  private loadClimax(track: OnlineTrack): void {
    const key = `${track.source}:${track.id}`;
    this.pbClimaxKey = key;
    this.pbClimaxRange = null;
    void analysisForTrack(track).then(
      (result) => {
        if (this.pbClimaxKey !== key) return;
        const analysis = result.analysis;
        const windowStart = analysis?.climaxStartMs ?? 0;
        const windowEnd = analysis?.climaxEndMs ?? 0;
        if (windowStart > 0 && windowEnd > windowStart) {
          this.pbClimaxRange = { from: windowStart, to: windowEnd };
        } else {
          const section = analysis?.sections?.find((item) => item.label === 'climax');
          if (!section || section.endMs <= section.startMs) return;
          this.pbClimaxRange = { from: section.startMs, to: section.endMs };
        }
        this.paintProgressMarks(playerState());
      },
      () => {
        /* 分析失败只是少一个标记，不影响播放 */
      },
    );
  }

  /** 进度条标记：暖色带 = 无缝过渡区间，淡带 + 短竖线 = 能量最高的高潮段。 */
  private paintProgressMarks(state: PlayerState | null): void {
    if (!this.pbMarks) return;
    const duration = state?.durationMs ?? 0;
    const ready = Boolean(state?.track) && duration > 0;
    const debug = readCrossfadeDebug();
    const mergeable =
      ready &&
      debug.enabled &&
      debug.phase === 'prepared' &&
      debug.fadeStartPosMs > 0 &&
      debug.fadeMs > 0 &&
      debug.fadeStartPosMs < duration;
    this.pbMergeMark.classList.toggle('is-off', !mergeable);
    if (mergeable) {
      const from = debug.fadeStartPosMs / duration;
      const to = Math.min(1, (debug.fadeStartPosMs + debug.fadeMs) / duration);
      this.pbMergeMark.style.left = `${(from * 100).toFixed(2)}%`;
      this.pbMergeMark.style.width = `${Math.max(0.5, (to - from) * 100).toFixed(2)}%`;
    }
    const climax = ready ? this.pbClimaxRange : null;
    const showClimax = Boolean(climax) && climax!.from >= 0 && climax!.from < duration;
    this.pbClimaxBand.classList.toggle('is-off', !showClimax);
    this.pbClimaxMark.classList.toggle('is-off', !showClimax);
    if (showClimax && climax) {
      const from = climax.from / duration;
      const to = Math.min(1, climax.to / duration);
      this.pbClimaxBand.style.left = `${(from * 100).toFixed(2)}%`;
      this.pbClimaxBand.style.width = `${Math.max(0.6, (to - from) * 100).toFixed(2)}%`;
      this.pbClimaxMark.style.left = `${(from * 100).toFixed(2)}%`;
    }
    const loop = ready ? getBarLoop() : null;
    const showLoop = Boolean(loop) && loop!.endMs > loop!.startMs;
    this.pbLoopBand.classList.toggle('is-off', !showLoop);
    if (showLoop && loop) {
      const from = loop.startMs / duration;
      const to = Math.min(1, loop.endMs / duration);
      this.pbLoopBand.style.left = `${(from * 100).toFixed(2)}%`;
      this.pbLoopBand.style.width = `${Math.max(0.6, (to - from) * 100).toFixed(2)}%`;
    }
    const cues = ready ? getHotCues() : [];
    this.pbCueMarks.forEach((mark, slot) => {
      const ms = cues[slot] ?? -1;
      const show = ready && ms >= 0 && ms < duration;
      mark.classList.toggle('is-off', !show);
      if (show) mark.style.left = `${Math.max(0, Math.min(99.8, (ms / duration) * 100)).toFixed(2)}%`;
    });
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
    // 桌面背景歌词开启后，软件内歌词页让位（关闭开关后恢复）。
    if (settings.general.backgroundLyrics && this.lyrics) this.closeLyrics();
  }

  /* ------------------------------------------------------------------ */
  /* 歌词                                                                */
  /* ------------------------------------------------------------------ */

  private openLyrics(): void {
    if (this.lyrics) return;
    if (getSettings().general.backgroundLyrics) {
      toast('歌词正在桌面背景显示，关闭「桌面背景歌词」后恢复软件内歌词');
      return;
    }
    // 歌词页是整窗覆盖层：先收起搜索，避免搜索层与歌词页互相抢层级
    this.closeSearchDock();
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
    this.accountIssueDispose?.();
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
    this.classicHome?.dispose();
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
   * 私人漫游：先播当前这一批（网易云一次只回 3 首左右），再注册续接器；
   * 播到最后一首时由播放器自动拉下一批追加进队列，不再循环回这一批的第一首。
   */
  private playRadio(tracks: OnlineTrack[]): void {
    if (tracks.length === 0) return;
    playQueue(tracks, 0, true);
    setQueueRefill(async () => fetchRadio(12));
  }

  /**
   * 首页点播放：先用卡片里的预览列表立即开播，再异步补全整张列表，
   * 避免列表循环很快绕回第一首。
   */
  /**
   * 列表/海报点击播放：如果这首歌正在悬停试听，就把试听元素直接交给播放器继续放，
   * 不重载、不 seek、不打断声音；否则按正常流程播放。
   */
  private playWithPreviewHandoff(queue: OnlineTrack[], index: number): void {
    const track = queue[index];
    // 「接管续播」关掉时，试听只作为试听：点击后停掉试听、从头正常播放。
    const takeover = readChorusPreviewSettings().takeover;
    if (!takeover) stopChorusPreview();
    const element = takeover && track ? takePreviewElement(track) : null;
    if (element && track) {
      if (adoptPlayingElement(element, track, queue, index)) return;
      try {
        element.pause();
        element.removeAttribute('src');
        element.load();
      } catch {
        /* 元素已失效 */
      }
    }
    playQueue(queue, index);
  }

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

  /** M：静音 / 恢复音量。只改本次会话音量，不回写设置，重启后仍是设置里的音量。 */
  toggleMute(): void {
    const state = playerState();
    if (state.volume > 0) {
      this.muteRestore = state.volume;
      setVolume(0);
      this.volumeInput.value = '0';
      this.paintVolumeIcon(0);
      toast('已静音 · 再按 M 恢复');
      return;
    }
    const restore = this.muteRestore > 0 ? this.muteRestore : 0.4;
    setVolume(restore);
    const percent = Math.round(restore * 100);
    this.volumeInput.value = String(percent);
    this.paintVolumeIcon(percent);
    toast('已恢复音量');
  }

  /** Shift + ←/→：快退 / 快进 5 秒。 */
  seekBy(deltaMs: number): void {
    const state = playerState();
    if (!state.track || state.durationMs <= 0) return;
    seek(Math.max(0, Math.min(state.durationMs, state.positionMs + deltaMs)));
  }

  /** 数字键 1–4：空位记热 cue，已记过就跳过去。 */
  hotCue(slot: number): void {
    // 对外用 1–4 编号，内部存储与进度条刻度用 0–3 下标。
    const result = toggleHotCue(slot - 1);
    if (result.action === 'none') {
      toast('先播放一首歌，再按数字键记热 cue');
      return;
    }
    const label = this.cueLabel(result.ms);
    toast(result.action === 'set' ? `已记下热 cue ${slot} · ${label}` : `跳到热 cue ${slot} · ${label}`);
  }

  /** Shift + 数字键：清除热 cue。 */
  clearHotCue(slot: number): void {
    toast(clearHotCue(slot - 1) ? `已清除热 cue ${slot}` : `热 cue ${slot} 本来就是空的`);
  }

  /** T：跟拍校速（至少 4 下），覆盖当前曲目用于过渡的小节对齐。 */
  private tempoTaps: number[] = [];

  tapTempo(): void {
    const state = playerState();
    const track = state.track;
    if (!track) {
      toast('先播放一首歌，再按 T 跟拍');
      return;
    }

    const now = performance.now();
    this.tempoTaps = this.tempoTaps.filter((value) => now - value <= 2_500);
    this.tempoTaps.push(now);
    if (this.tempoTaps.length < 4) {
      toast(`跟拍：再按 ${4 - this.tempoTaps.length} 下`, 'info');
      return;
    }

    const intervals: number[] = [];
    for (let index = 1; index < this.tempoTaps.length; index += 1) {
      intervals.push(this.tempoTaps[index] - this.tempoTaps[index - 1]);
    }
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    this.tempoTaps = [];
    if (!(median > 0)) {
      toast('跟拍节奏太乱，再试一次', 'error');
      return;
    }

    let bpm = 60_000 / median;
    while (bpm < 60) bpm *= 2;
    while (bpm > 200) bpm /= 2;
    bpm = Math.round(bpm * 10) / 10;
    setBpmOverride(track, bpm);
    toast(`已跟拍 ${bpm} BPM，本曲过渡按这个速度对齐小节`);
  }

  /** Shift + T：清除当前曲目的跟拍速度。 */
  clearTempoOverride(): void {
    const track = playerState().track;
    if (!track) {
      toast('先播放一首歌', 'error');
      return;
    }
    const current = bpmOverrideOf(track);
    if (current === null) {
      toast('当前曲目没有跟拍速度');
      return;
    }
    setBpmOverride(track, null);
    toast(`已清除跟拍速度（${current} BPM）`);
  }

  /** Shift + X：本次切歌跳过无缝过渡（只影响下一次，不改设置）。 */
  suppressCrossfadeOnce(): void {
    suppressNextCrossfade();
    toast('本次切歌不使用无缝过渡');
  }

  /** L：按当前小节循环（4 小节），再按取消。 */
  toggleLoop(): void {
    const result = toggleBarLoop(4);
    if (!result.ok) {
      toast('还没分析出小节，先播放一下再试');
      return;
    }
    if (!result.loop) {
      toast('小节循环已关闭');
      return;
    }
    toast(`4 小节循环 · ${this.cueLabel(result.loop.startMs)} – ${this.cueLabel(result.loop.endMs)}`);
  }

  private cueLabel(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  prevTrack(): void {
    prev();
  }
}

export type { App as ZiluxApp };
