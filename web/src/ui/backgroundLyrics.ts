/**
 * 桌面背景歌词（backgroundLyrics）。
 *
 * 主窗口：开关打开后把当前曲目的歌词文档写进共享 localStorage，背景窗口按同一份站点存储演出。
 * 背景窗口（`index.html?scene=backgroundLyrics`，由宿主挂在 WorkerW 下）：不启动整套 App，
 * 只创建一个 LyricsView，用宿主转发的媒体快照驱动播放头；歌词文档来自上面的 localStorage 快照。
 */
import { host } from '../core/bridge';
import { getSettings, loadSettings, onSettingsChange } from '../core/settings';
import type { OnlineTrack } from '../online/types';
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

async function publishDoc(track: OnlineTrack): Promise<void> {
  if (publishing) return;
  publishing = true;
  try {
    const doc = await loadLyricDoc(track);
    writeSnapshot(track, doc);
  } catch (err) {
    console.warn('[bgLyrics] publish failed', err);
  } finally {
    publishing = false;
  }
}

/**
 * 主窗口启动时调用：开关打开期间，跟随播放曲目把歌词文档写进共享快照。
 * 关掉开关时不必清理快照，下次打开会按当前曲目重写。
 */
export function installBackgroundLyricsPublisher(): void {
  const publishCurrent = (): void => {
    if (!getSettings().general.backgroundLyrics) {
      publishedKey = '';
      return;
    }

    const track = playerState().track;
    if (!track) return;

    const key = trackKey(track);
    if (key === publishedKey) return;
    publishedKey = key;
    void publishDoc(track);
  };

  onPlayer(() => publishCurrent());
  onSettingsChange(() => publishCurrent());
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

function applySnapshot(view: LyricsView): void {
  const snapshot = readSnapshot();
  if (!snapshot) return;
  // 主窗口每写一次 localStorage（播放进度、统计等）都会让 storage 事件冒到这里；
  // 只有歌词快照真的换了才重建 DOM，否则整块歌词会被反复清空重画（看起来就是上下乱跳）。
  if (snapshot.savedAt === appliedSavedAt) return;
  appliedSavedAt = snapshot.savedAt;
  const key = trackKey(snapshot.track);
  if (key !== appliedTrackKey) {
    appliedTrackKey = key;
    applyExternalPlayback({ track: snapshot.track });
  }
  view.applyExternalDoc(snapshot.doc);
}

/**
 * 背景场景的入口。必须在正常 App 启动之前分叉调用：
 * 这里不创建 App、不启动在线服务，只把一块 LyricsView 铺满窗口。
 */
export async function bootBackgroundLyricsScene(): Promise<void> {
  document.documentElement.classList.add('is-bg-lyrics-scene');
  setExternalLyricMode(true);
  await loadSettings();

  const view = new LyricsView(() => undefined);
  view.root.classList.add('is-background-lyrics');
  document.body.append(view.root);

  applySnapshot(view);

  window.addEventListener('storage', (event) => {
    if (event.key === DOC_KEY) {
      applySnapshot(view);
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
