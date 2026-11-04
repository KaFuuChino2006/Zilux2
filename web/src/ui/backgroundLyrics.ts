/**
 * 桌面背景歌词（backgroundLyrics）。
 *
 * 主窗口：开关打开后把当前曲目的歌词文档写进共享 localStorage，背景窗口按同一份站点存储演出。
 * 背景窗口（`index.html?scene=backgroundLyrics`，由宿主挂在 WorkerW 下）：不启动整套 App，
 * 只创建一个 LyricsView，用宿主转发的媒体快照驱动播放头；歌词文档来自上面的 localStorage 快照。
 */
import { host } from '../core/bridge';
import { getSettings, loadSettings, onSettingsChange } from '../core/settings';
import { initOnline, onlineEndpoint, onOnlineChange } from '../online/client';
import type { OnlineTrack } from '../online/types';
import {
  BG_BLUR_KEY,
  BG_BLUR_PX,
  BG_COVER_KEY,
  BG_FILL_KEY,
  bgLyricsBlurLevel,
  bgLyricsCoverStyle,
  bgLyricsFillMode,
} from './bgLyricsCover';
import { LyricsView, loadLyricDoc, setExternalLyricMode, type LyricDoc } from './lyrics';
import { applyExternalPlayback, onPlayer, playerState } from './player';

/** 主窗口解析好的歌词文档快照键（含曲目与逐字时间轴）。 */
const DOC_KEY = 'zilux2.bgLyricsDoc';
/** 背景场景外推播放头的节奏：宿主只有 1 次/秒的媒体快照。 */
const CLOCK_INTERVAL_MS = 100;

interface BackgroundDocSnapshot {
  track: OnlineTrack;
  doc: LyricDoc;
  savedAt: number;
}

interface MediaPayload {
  durationMs?: number;
  positionMs?: number;
  playing?: boolean;
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
}

export function isBackgroundLyricsScene(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('scene') === 'backgroundLyrics';
  } catch {
    return false;
  }
}

function trackKey(track: OnlineTrack): string {
  return `${track.source}:${track.id}`;
}

/**
 * 封面地址在「上次播放」里是绝对回环 URL（含宿主端口），重启后端口会变、旧地址直接连不上。
 * 这里把回环地址按当前在线源端点重新拼一遍；外链封面原样返回。
 */
function freshCoverUrl(track: OnlineTrack): string {
  const raw = track.cover;
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return raw;
    const source = url.searchParams.get('source') ?? track.source;
    const key = url.searchParams.get('key') ?? '';
    if (!key) return raw;
    return onlineEndpoint('/api/cover', { source, key, width: '2048' }) || raw;
  } catch {
    return raw;
  }
}

function readSnapshot(): BackgroundDocSnapshot | null {
  try {
    const raw = window.localStorage.getItem(DOC_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BackgroundDocSnapshot;
    if (!parsed || typeof parsed !== 'object' || !parsed.track || !parsed.doc) return null;
    return parsed;
  } catch (err) {
    console.warn('[bgLyrics] snapshot read failed', err);
    return null;
  }
}

function writeSnapshot(track: OnlineTrack, doc: LyricDoc): void {
  try {
    const snapshot: BackgroundDocSnapshot = { track, doc, savedAt: Date.now() };
    window.localStorage.setItem(DOC_KEY, JSON.stringify(snapshot));
  } catch (err) {
    console.warn('[bgLyrics] snapshot write failed', err);
  }
}

/* ------------------------------ 主窗口侧 ------------------------------ */

let publishedKey = '';
let publishing = false;
/** 上一次发布是不是空歌词（启动早期在线服务没好，歌词接口会返回空）。 */
let publishedEmpty = true;
/** 发布过程中又收到强制发布请求（例如在线端点刚就绪），结束后补一次。 */
let retryAfterPublish = false;
/** 空歌词自动补发的次数（避免无歌词的纯音乐无限重试）。 */
let emptyRetries = 0;

/**
 * 主窗口启动时调用：开关打开期间，跟随播放曲目把歌词文档写进共享快照。
 * 关掉开关时不必清理快照，下次打开会按当前曲目重写。
 */
export function installBackgroundLyricsPublisher(): void {
  onPlayer(() => publishCurrent());
  onSettingsChange(() => publishCurrent(true));
  // 宿主端口/token 比页面 ready 晚到；到了以后把当前曲目重发一次（封面地址也会换成新端口）。
  onOnlineChange(() => publishCurrent(true));
}

function publishCurrent(force = false): void {
  if (!getSettings().general.backgroundLyrics) {
    publishedKey = '';
    return;
  }

  const track = playerState().track;
  if (!track) return;

  const key = trackKey(track);
  if (key !== publishedKey) emptyRetries = 0;
  // 空歌词要允许重发：启动早期歌词接口还没就绪，之后在线端点到达要补一次。
  if (!force && key === publishedKey && !publishedEmpty) return;
  publishedKey = key;
  void publishDoc(track);
}

async function publishDoc(track: OnlineTrack): Promise<void> {
  if (publishing) {
    retryAfterPublish = true;
    return;
  }
  publishing = true;
  try {
    const doc = await loadLyricDoc(track);
    // 快照里的封面必须是当前宿主的回环地址：上次播放持久化的是旧端口，背景窗口拿不到在线端点，
    // 只能由主窗口在发布时用当前端点重拼，否则重启后封面一直是裂图。
    writeSnapshot({ ...track, cover: freshCoverUrl(track) || track.cover }, doc);
    publishedEmpty = doc.lines.length === 0;
    if (!publishedEmpty) emptyRetries = 0;
  } catch (err) {
    publishedEmpty = true;
    console.warn('[bgLyrics] publish failed', err);
  } finally {
    publishing = false;
    if (retryAfterPublish) {
      retryAfterPublish = false;
      publishCurrent(true);
    } else if (publishedEmpty && emptyRetries < 3) {
      // 启动早期歌词接口可能还没就绪：隔一会儿补发，直到拿到非空歌词或重试次数用完。
      emptyRetries += 1;
      window.setTimeout(() => publishCurrent(true), 1500 * emptyRetries);
    }
  }
}

/* ------------------------------ 背景场景侧 ------------------------------ */

/** 只影响演出外观、需要背景窗口跟着重绘的共享设置键（其它 localStorage 写入一律忽略）。 */
const STYLE_KEYS = new Set([
  'zilux2.lumiere',
  'zilux2.lyricsBg',
  'zilux2.lyricStyle',
  'zilux2.lyricGrow',
  'zilux2.lyricUnsung',
  'zilux2.lyricText',
  'zilux2.lyricOffsets',
  'zilux2.lyricManual',
]);

let appliedSavedAt = -1;
let appliedTrackKey = '';

/**
 * 背景场景的入口。必须在正常 App 启动之前分叉调用：
 * 这里不创建 App、不启动在线服务，只把一块 LyricsView 铺满窗口。
 */
export async function bootBackgroundLyricsScene(): Promise<void> {
  document.documentElement.classList.add('is-bg-lyrics-scene');
  setExternalLyricMode(true);
  // 背景页也要拿到宿主的在线源端点：封面是回环绝对地址，重启后端口会变，需要按当前端点重拼。
  initOnline();
  await loadSettings();

  const view = new LyricsView(() => undefined);
  view.root.classList.add('is-background-lyrics');
  document.body.append(view.root);

  // 「封面在左」样式：两层封面图交叉淡入淡出（换歌时旧封面压着新封面淡出，避免硬切），
  // 铺满整宽并用 CSS mask 向右渐隐；歌词列由 CSS 挪到右半边。
  // 每层再分「清晰」「模糊」两个 pane：右侧用同一张图的模糊副本渐入，过渡区才真的会糊。
  const createCoverPane = (extra: string): HTMLDivElement => {
    const pane = document.createElement('div');
    pane.className = `bg-cover-pane ${extra}`;
    return pane;
  };
  const coverLayers: HTMLDivElement[] = [0, 1].map(() => {
    const layer = document.createElement('div');
    layer.className = 'bg-cover-left';
    layer.append(createCoverPane('bg-cover-sharp'), createCoverPane('bg-cover-blur'));
    view.root.append(layer);
    return layer;
  });
  let activeCoverLayer = 0;
  let currentCoverUrl = '';
  let coverPreload: HTMLImageElement | null = null;
  let coverPreloadTimer = 0;
  let coverInitialized = false;
  let coverSwitchTimer = 0;

  const coverMode = (): boolean => view.root.classList.contains('is-bg-cover-left');

  /** 模糊强度 / 「封面之后」的填充方式：写到 root 的 CSS 变量与类上，由样式表消费。 */
  const applyCoverBlur = (): void => {
    const level = bgLyricsBlurLevel();
    view.root.style.setProperty('--bg-cover-blur', `${BG_BLUR_PX[level]}px`);
    view.root.classList.toggle('is-bg-cover-noblur', level === 'off');
    view.root.classList.toggle('is-bg-cover-fill', bgLyricsFillMode() === 'fill' && level !== 'off');
  };

  /** 只改两层封面的可见性；切换本身交给 CSS 的 opacity 过渡。 */
  const syncCoverOpacity = (): void => {
    const on = coverMode();
    coverLayers.forEach((layer, index) => {
      layer.style.opacity = on && index === activeCoverLayer ? '1' : '0';
    });
  };

  const currentTrackCover = (): string => {
    const track = bgLyricsCoverStyle() === 'cover' ? readSnapshot()?.track : null;
    return track ? freshCoverUrl(track) : '';
  };

  const revealCover = (url: string): void => {
    const nextIndex = activeCoverLayer === 0 ? 1 : 0;
    const next = coverLayers[nextIndex];
    const image = url ? `url("${url}")` : 'none';
    next.querySelectorAll<HTMLDivElement>('.bg-cover-pane').forEach((pane) => {
      pane.style.backgroundImage = image;
    });
    // 两层封面都留在歌词框架之下（CSS z-index:1 / 框架 z-index:2），靠 DOM 顺序决定谁在上：
    // 把新层移到末尾，换歌时旧层压着新层淡出，不会挡住歌词。
    if (next.nextSibling !== null) view.root.append(next);
    activeCoverLayer = nextIndex;
    currentCoverUrl = url;
    syncCoverOpacity();
  };

  const applyCoverImage = (animate: boolean): void => {
    const url = currentTrackCover();
    if (url === currentCoverUrl) {
      syncCoverOpacity();
      return;
    }
    if (!animate || !url) {
      revealCover(url);
      return;
    }
    // 先预载新封面，加载完成后再交叉淡入；否则新图层会在解码前空一帧，看起来还是硬切。
    window.clearTimeout(coverPreloadTimer);
    const preload = new Image();
    coverPreload = preload;
    let done = false;
    const reveal = (): void => {
      if (done || preload !== coverPreload) return;
      done = true;
      window.clearTimeout(coverPreloadTimer);
      coverPreload = null;
      revealCover(url);
    };
    preload.onload = reveal;
    preload.onerror = reveal;
    preload.src = url;
    coverPreloadTimer = window.setTimeout(reveal, 900);
  };

  /** 纯壁纸 ⇄ 封面在左：歌词先压暗，再换布局，最后淡回；封面层由 opacity 过渡。 */
  const applyCoverStyle = (animate: boolean): void => {
    const wantCover = bgLyricsCoverStyle() === 'cover';
    const changed = view.root.classList.contains('is-bg-cover-left') !== wantCover;
    const commitStyle = (): void => {
      view.root.classList.toggle('is-bg-cover-left', wantCover);
      syncCoverOpacity();
    };
    if (!coverInitialized || !animate || !changed) {
      commitStyle();
      coverInitialized = true;
      return;
    }
    view.root.classList.add('is-bg-cover-switching');
    window.clearTimeout(coverSwitchTimer);
    window.setTimeout(() => {
      commitStyle();
      applyCoverImage(false);
      coverSwitchTimer = window.setTimeout(() => view.root.classList.remove('is-bg-cover-switching'), 340);
    }, 160);
  };

  // 换歌时先让上一首的歌词/封面淡出 200ms，再换文档淡入；同一首（例如歌词来源刷新）直接替换。
  let switchTimer = 0;
  let pending: BackgroundDocSnapshot | null = null;
  const commit = (snapshot: BackgroundDocSnapshot): void => {
    if (snapshot.savedAt === appliedSavedAt) return;
    appliedSavedAt = snapshot.savedAt;
    const key = trackKey(snapshot.track);
    const trackChanged = key !== appliedTrackKey;
    if (trackChanged) {
      appliedTrackKey = key;
      applyExternalPlayback({ track: snapshot.track });
    }
    view.applyExternalDoc(snapshot.doc);
    applyCoverStyle(false);
    // 换歌时封面走预载 + 交叉淡化；同一首只是歌词来源刷新，不动封面。
    applyCoverImage(trackChanged);
  };
  const receiveSnapshot = (animate: boolean): void => {
    const snapshot = readSnapshot();
    if (!snapshot || snapshot.savedAt === appliedSavedAt) return;
    const nextKey = trackKey(snapshot.track);
    const switchesTrack = Boolean(appliedTrackKey) && nextKey !== appliedTrackKey;
    if (!animate || !switchesTrack) {
      commit(snapshot);
      return;
    }
    pending = snapshot;
    view.root.classList.add('is-bg-doc-switching');
    if (switchTimer) window.clearTimeout(switchTimer);
    switchTimer = window.setTimeout(() => {
      switchTimer = 0;
      const next = pending ?? readSnapshot();
      pending = null;
      if (next) commit(next);
      view.root.classList.remove('is-bg-doc-switching');
    }, 200);
  };

  receiveSnapshot(false);
  applyCoverStyle(false);
  applyCoverImage(false);
  applyCoverBlur();
  // 在线源端点比页面 ready 晚到；端点一到就把旧端口拼的封面地址换成当前端口。
  onOnlineChange(() => {
    applyCoverStyle(false);
    applyCoverImage(false);
  });

  window.addEventListener('storage', (event) => {
    if (event.key === DOC_KEY) {
      receiveSnapshot(true);
      return;
    }
    if (event.key === BG_COVER_KEY) {
      applyCoverStyle(true);
      applyCoverImage(false);
      return;
    }
    if (event.key === BG_BLUR_KEY || event.key === BG_FILL_KEY) {
      applyCoverBlur();
      return;
    }
    // 样式/偏移类设置改了才重绘；其它键（播放进度、统计、封面缓存…）不碰歌词树。
    if (event.key && STYLE_KEYS.has(event.key)) view.refreshSharedStyle();
  });

  const clock = { positionMs: 0, durationMs: 0, playing: false, syncedAt: performance.now() };
  let pushedPositionMs = 0;
  let lastTrackKeyPushed = '';

  const pushClock = (): void => {
    const elapsed = clock.playing ? performance.now() - clock.syncedAt : 0;
    let position = clock.positionMs + elapsed;
    if (clock.durationMs > 0) position = Math.min(position, clock.durationMs);
    // 宿主快照 1 秒才来一次，采样点比本地外推略旧；四舍五入回跳会让行索引来回抖，
    // 所以播放中只允许向前（真的 seek 由下面的跳变判断放行）。
    if (clock.playing) position = Math.max(position, pushedPositionMs);
    pushedPositionMs = position;
    applyExternalPlayback({ positionMs: position, durationMs: clock.durationMs, playing: clock.playing });
  };

  host.onMessage((message) => {
    if (message.type !== 'media') return;
    const payload = message.payload as MediaPayload | undefined;
    if (!payload || typeof payload !== 'object') return;
    const previous = clock.positionMs;
    const next = typeof payload.positionMs === 'number' ? Math.max(0, payload.positionMs) : previous;
    // 明显的前后跳（>2 秒）视为用户 seek，重置单调基线；正常刷新允许小幅回正。
    if (Math.abs(next - previous) > 2000) pushedPositionMs = next;
    clock.positionMs = next;
    if (typeof payload.durationMs === 'number') clock.durationMs = Math.max(0, payload.durationMs);
    clock.playing = payload.playing === true;
    clock.syncedAt = performance.now();
    const track = playerState().track;
    if (track) {
      const key = trackKey(track);
      if (key !== lastTrackKeyPushed) {
        lastTrackKeyPushed = key;
        pushedPositionMs = next;
      }
    }
    pushClock();
  });

  window.setInterval(pushClock, CLOCK_INTERVAL_MS);
  pushClock();
  host.ready();
}
