/**
 * 桌面背景歌词（backgroundLyrics）。
 *
 * 主窗口：开关打开后把当前曲目的歌词文档写进共享 localStorage，背景窗口按同一份站点存储演出。
 * 背景窗口（`index.html?scene=backgroundLyrics`，由宿主挂在 WorkerW 下）：不启动整套 App，
 * 只创建一个 LyricsView，用宿主转发的媒体快照驱动播放头；歌词文档来自上面的 localStorage 快照。
 */
import { host } from '../core/bridge';
import { refreshPageWallpaperSwitches } from '../wallpaper/client';
import { getSettings, loadSettings, onSettingsChange } from '../core/settings';
import { initOnline, onlineEndpoint, onOnlineChange } from '../online/client';
import type { OnlineTrack } from '../online/types';
import {
  BG_BLUR_KEY,
  BG_BLUR_PX,
  BG_COVER_KEY,
  BG_FILL_KEY,
  bgLyricsBlurLevel,
  bgLyricsFillMode,
  effectiveBgLyricsCoverStyle,
  lumiereEffectOn,
} from './bgLyricsCover';
import { currentLyricDoc, LyricsView, loadLyricDoc, reloadSharedLyricSettings, setExternalLyricMode, type LyricDoc } from './lyrics';
import { lumiereMode } from './lumiere';
import { applyExternalPlayback, getTransitionTarget, onPlayer, peekUpcoming, playerState } from './player';
import { readCrossfadeDebug } from './crossfadeDeck';

/** 主窗口解析好的歌词文档快照键（含曲目与逐字时间轴）。 */
const DOC_KEY = 'zilux2.bgLyricsDoc';
/** 背景场景外推播放头的节奏：宿主快照约 5 次/秒，本地按 30fps 外推；太稀会让行切换看着比主窗慢。 */
const CLOCK_INTERVAL_MS = 33;

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
/** 补发次数用完、已确认没有歌词的曲目：播放器每帧回调不再重复拉取/写快照。 */
let settledEmptyKey = '';
/** 上一次写入快照的内容签名（不含 savedAt）：内容没变就不重复写 localStorage。 */
let publishedSignature = '';

/**
 * 主窗口启动时调用：开关打开期间，跟随播放曲目把歌词文档写进共享快照。
 * 关掉开关时不必清理快照，下次打开会按当前曲目重写。
 */
export function installBackgroundLyricsPublisher(): void {
  let upcomingSignature='';
  let cueCheckedAt=-Infinity,cue={phase:'idle',nextTitle:'',bStartFileMs:0};
  const publishUpcoming=()=>{
    if(!getSettings().general.backgroundLyrics)return;
    const state=playerState();if(!state.track)return;
    const target=getTransitionTarget()??peekUpcoming()?.track??null;
    if(performance.now()-cueCheckedAt>=500){cue=readCrossfadeDebug();cueCheckedAt=performance.now();}
    const positionMs=target&&(cue.phase==='prepared'||cue.phase==='fading')&&cue.nextTitle===target.title?Math.max(0,cue.bStartFileMs-(target.startAt??0)*1000):0;
    const value=JSON.stringify({forTrack:trackKey(state.track),track:target,positionMs});
    if(value===upcomingSignature)return;
    upcomingSignature=value;try{localStorage.setItem('zilux2.flowUpcoming',value);}catch{/* Storage unavailable. */}
  };
  onPlayer(() => {publishUpcoming();publishCurrent();});
  onSettingsChange(() => {publishUpcoming();publishCurrent(true);});
  // 宿主端口/token 比页面 ready 晚到；到了以后把当前曲目重发一次（封面地址也会换成新端口）。
  onOnlineChange(() => publishCurrent(true));
}

function publishCurrent(force = false): void {
  if (!getSettings().general.backgroundLyrics) {
    publishedKey = '';
    settledEmptyKey = '';
    publishedSignature = '';
    return;
  }

  const track = playerState().track;
  if (!track) return;

  const key = trackKey(track);
  if (key !== publishedKey) {
    emptyRetries = 0;
    settledEmptyKey = '';
  }
  // 非空歌词：同一首只发一次，播放器的每帧回调直接跳过。
  // 空歌词：补发次数还没用完时继续尝试；确认没有歌词后也不再每帧重拉。
  if (!force && key === publishedKey) {
    if (!publishedEmpty) return;
    if (settledEmptyKey === key) {
      // 确认无歌词后主窗口又匹配到了歌词（手动选源/逐字翻译匹配）：直接补发同一份文档，不再发请求。
      const doc = currentLyricDoc();
      if (!doc || doc.trackKey !== key || doc.lines.length === 0) return;
      writeSnapshotIfChanged(track, key, doc);
      publishedEmpty = false;
      emptyRetries = 0;
      settledEmptyKey = '';
      return;
    }
    // 还没确认的空歌词（首拉进行中或等待定时补发）：交给 1.5s/3s/4.5s 的定时器，
    // 不能在播放器每帧回调里重发，否则会和发布互斥锁叠加成连续请求。
    return;
  }
  publishedKey = key;
  void publishDoc(track, key);
}

/** 快照内容签名（不含 savedAt）：歌词/封面没变时跳过写入，避免背景窗口反复重绘。 */
function docSignature(key: string, doc: LyricDoc, cover: string): string {
  let hash = 2166136261;
  for (const line of doc.lines) {
    const text = `${line.timeMs}|${line.durationMs}|${line.text}|${line.translation}|${line.words.length}\n`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
  }
  return `${key}|${doc.kind}|${doc.lines.length}|${hash}|${cover}`;
}

/** 内容没变就不写 localStorage；只有真正写入才让背景窗口收到 storage 事件。 */
function writeSnapshotIfChanged(track: OnlineTrack, key: string, doc: LyricDoc): void {
  const cover = freshCoverUrl(track) || track.cover;
  const signature = docSignature(key, doc, cover);
  if (signature === publishedSignature) return;
  writeSnapshot({ ...track, cover }, doc);
  publishedSignature = signature;
}

async function publishDoc(track: OnlineTrack, key: string): Promise<void> {
  if (publishing) {
    retryAfterPublish = true;
    return;
  }
  publishing = true;
  try {
    const doc = await loadLyricDoc(track);
    // 拉取期间切了歌：这份结果已经过期，丢弃并在结束后补发当前曲目，避免旧歌词盖住新快照。
    if (key !== publishedKey) {
      retryAfterPublish = true;
      return;
    }
    // 快照里的封面必须是当前宿主的回环地址：上次播放持久化的是旧端口，背景窗口拿不到在线端点，
    // 只能由主窗口在发布时用当前端点重拼，否则重启后封面一直是裂图。
    writeSnapshotIfChanged(track, key, doc);
    publishedEmpty = doc.lines.length === 0;
    if (!publishedEmpty) {
      emptyRetries = 0;
      settledEmptyKey = '';
    } else if (emptyRetries >= 3) {
      settledEmptyKey = key;
    }
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
    } else if (publishedEmpty) {
      // 确认这首没有歌词：记下来，之后的每帧回调不再重拉。
      settledEmptyKey = publishedKey;
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
  'zilux2.lyricSolid',
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
  // 这一页本身就透明（body 背景 transparent），默认播放效果下桌面壁纸本来就能透出来，
  // 所以只有画布类效果（纯字 / 拼合 / 房间 / 唱片）才需要把壁纸铺进这一页做 screen 混合。
  // 「背景歌词样式 = 动态壁纸」在默认效果下不再额外叠一层壁纸（那是同一张视频解第二遍）。
  if (lumiereMode() !== 'off') document.documentElement.classList.add('is-bg-motion');
  // 模块级样式/偏移变量在导入时只读过一次；启动时重读一遍，保证背景窗口和主窗口一致。
  reloadSharedLyricSettings();

  const view = new LyricsView(() => undefined);
  view.root.classList.add('is-background-lyrics');
  document.body.append(view.root);

  // 壁纸由 main.ts 的 startWallpaperLayer() 铺好（#wallpaper-root 挂在 body 上）。
  // 这一页**不再**自己新建一层：那会把同一段视频解第二遍，用户看到的就是「两个壁纸」。
  // 需要做的只是把它挪进歌词页的 stacking context（画布效果的 screen 混合才混得到），
  // 默认效果时再挪回 body —— 两种情况下都只有一份解码。
  const applyMotion = (): void => {
    const on = lumiereMode() !== 'off';
    document.documentElement.classList.toggle('is-bg-motion', on);
    const root = document.getElementById('wallpaper-root');
    if (!root) return;
    // 桌面歌词窗必须一直有底：就算「常规页面显示壁纸」被关掉，这一页也要显示，
    // 否则窗口会变成一块不透明的黑。
    root.classList.remove('is-hidden', 'is-fading');
    if (on) {
      if (root.parentElement !== view.root) view.root.insertBefore(root, view.root.firstChild);
    } else if (root.parentElement !== document.body) {
      document.body.insertBefore(root, document.body.firstChild);
    }
  };

  applyMotion();

  // 主窗口改「背景歌词样式」时，这一页要立刻跟着变。
  // 跨窗口用同源 localStorage 的 storage 事件通知（页面间不共享模块状态）。
    // 别人改了设置（快捷设置/设置页/API）时这一页也要跟上：
  // 宿主只在推壁纸状态时才知道，选项本身不会广播，所以这里低频拉一次。
  window.setInterval(() => {
    void (async () => {
      await refreshPageWallpaperSwitches();
      applyMotion();
    })();
  }, 3000);
window.addEventListener('storage', (event) => {
    if (event.key !== 'zilux2.wallpaperOptionsStamp') return;
    void (async () => {
      await refreshPageWallpaperSwitches();
      applyMotion();
    })();
  });

  // 「封面在左」样式：两层封面图交叉淡入淡出（换歌时旧封面压着新封面淡出，避免硬切），
  // 铺满整宽；右侧的模糊由上层 pane 对同一张图做 backdrop-filter 得到，不再复制第二份封面，
  // 因此清晰区和模糊区天然对齐，也不会把 Windows 桌面壁纸透进来。
  const createCoverPane = (extra: string): HTMLDivElement => {
    const pane = document.createElement('div');
    pane.className = `bg-cover-pane ${extra}`;
    return pane;
  };
  const coverLayers: HTMLDivElement[] = [0, 1].map(() => {
    const layer = document.createElement('div');
    layer.className = 'bg-cover-left';
    layer.append(
      createCoverPane('bg-cover-sharp'),
      createCoverPane('bg-cover-blur'),
      // 「模糊铺满」用的第二块模糊带：遮罩一直铺到右缘，靠整层 opacity 淡入淡出。
      // 单选一块 pane 改 mask 在本项目的合成路径里不会逐帧重绘，改成两层交叉淡入才稳。
      createCoverPane('bg-cover-blur bg-cover-blur-fill'),
    );
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

  /**
   * 「桌面壁纸本身也一起模糊」只在「封面在左 + 模糊未关 + 不是模糊铺满」时成立。
   * 这三件事任何一个变了都要重新同步，否则会出现「模糊关了还在」「切纯壁纸还糊」。
   */
  const syncWallpaperBlurClass = (wallBlur: boolean, fill: boolean): void => {
    document.documentElement.classList.toggle('is-bg-cover-left', wallBlur);
    document.documentElement.classList.toggle('is-bg-cover-fill', fill);
  };

  /**
   * 模糊强度 / 「封面之后」的填充方式：写到 root 的 CSS 变量与类上，由样式表消费。
   * 「渐隐到壁纸 ⇄ 模糊铺满」用 WAAPI 显式补一段 --bg-cover-fade 动画：色标终点的 CSS 过渡
   * 在某些时机（切样式、首次合成）会被跳过，用动画就不会。
   */
  const applyCoverBlur = (animate = true): void => {
    if (lumiereEffectOn()) {
      view.root.classList.remove('is-bg-cover-noblur', 'is-bg-cover-fill');
      syncWallpaperBlurClass(false, false);
      return;
    }
    const level = bgLyricsBlurLevel();
    const fillNext = bgLyricsFillMode() === 'fill' && level !== 'off';
    const fillPrev = view.root.classList.contains('is-bg-cover-fill');
    view.root.style.setProperty('--bg-cover-blur', `${BG_BLUR_PX[level]}px`);
    // 默认效果下 #wallpaper-root 挂在 body 上（不在 .lyrics-view 里），变量必须挂到 <html>
    // 才能被壁纸那条 filter 规则读到，否则永远落到 44px 的兜底值（表现为档位切了没变化）。
    document.documentElement.style.setProperty('--bg-cover-blur', `${BG_BLUR_PX[level]}px`);
    view.root.classList.toggle('is-bg-cover-noblur', level === 'off');
    view.root.classList.toggle('is-bg-cover-fill', fillNext);
    // 两种「封面之后」壁纸都要跟着糊：铺满时右缘仍是同一块背景，不糊会看到一条清晰壁纸。
    syncWallpaperBlurClass(coverMode() && level !== 'off', fillNext);
    // 两种「封面之后」都要保留封面自己的模糊：
    // 渐隐到壁纸 = 清晰封面 → 封面模糊带 → 右缘露出（已一起模糊的）壁纸；
    // 模糊铺满   = 清晰封面 → 封面模糊带一直铺到右缘。
    // 因此这里只清掉历史遗留的内联 opacity，可见性完全交给类与样式表。
    coverLayers.forEach((layer) => {
      layer.querySelectorAll<HTMLElement>('.bg-cover-blur').forEach((pane) => {
        if (pane.style.opacity) pane.style.removeProperty('opacity');
      });
    });
    // 换模糊档位靠 CSS 的 filter 过渡（.bg-cover-blur / #wallpaper-root 各有一条），
    // 这里不再用 WAAPI 动 --bg-cover-blur：自定义属性变化不会让 Chromium 逐帧重绘 filter。
    void BG_BLUR_PX[level];
    // 「渐隐到壁纸 ⇄ 模糊铺满」用「多一层模糊带的 opacity 交叉淡入」来表达：
    // mask 的色标终点是变量，改它不会逐帧重绘（WAAPI 动 maskImage 实测也没有中间值），
    // 而 opacity 是合成属性，任何窗口都能稳定出帧。
    void animate;
    void fillPrev;
  };

  /**
   * 只改两层封面的可见性。
   * 这里不用 CSS transition：首次进「封面在左」时整层是 opacity:0，Chromium 对这种
   * 「首帧就没有合成层」的元素会跳过过渡（实测 0 → 1 直接到位），看起来就是整片糊上去。
   * 用 WAAPI 显式补一段淡入，任何时刻切都成立。
   */
  const fadeCoverLayer = (layer: HTMLDivElement, on: boolean): void => {
    const target = on ? '1' : '0';
    const from = getComputedStyle(layer).opacity;
    layer.style.opacity = target;
    if (from === target) return;
    layer.animate([{ opacity: from }, { opacity: target }], { duration: 700, easing: 'cubic-bezier(.22,.61,.24,1)' });
  };

  /** 封面先整幅立起来，再把右侧慢慢化开成设定的模糊（模糊 0 → 设定值）。 */
  // 同一次进场里会被 syncCoverOpacity / applyCoverImage / visibility 多次触发；
  // 重复起动画会让 WAAPI 先回落到 CSS 终值（64px）再从头开始 —— 看上去就是「闪一下糊满」。
  let introUntil = 0;
  const introCover = (layer: HTMLDivElement): void => {
    const diag = window as unknown as { __bgIntro?: number[]; __bgIntroSkip?: string };
    if (performance.now() < introUntil) {
      diag.__bgIntroSkip = 'busy';
      return;
    }
    diag.__bgIntro = [...(diag.__bgIntro ?? []), Date.now()];
    introUntil = performance.now() + 900;
    if (lumiereEffectOn()) {
      diag.__bgIntroSkip = 'effect';
      return;
    }
    const sharpTo = bgLyricsFillMode() === 'fill' && bgLyricsBlurLevel() !== 'off' ? '100%' : '54%';
    layer.querySelectorAll<HTMLElement>('.bg-cover-sharp').forEach((pane) => {
      const frames = [
        { '--bg-cover-fade': '100%' },
        { '--bg-cover-fade': sharpTo },
      ] as unknown as Keyframe[];
      pane.animate(frames, { duration: 1100, delay: 260, easing: 'cubic-bezier(.22,.61,.24,1)', fill: 'both' });
    });
    const level = bgLyricsBlurLevel();
    if (level === 'off') return;
    const to = `${BG_BLUR_PX[level]}px`;
    // 这里只同步变量（档位/缩放/壁纸那条 filter 都读它）并让 CSS 的 filter 过渡生效。
    // 不要再对模糊层做 opacity 动画、更不要写内联 opacity：
    // 内联值会压过类规则，切回「渐隐到壁纸」时那层收不回去（右缘看起来和没渐隐一样）。
    layer.querySelectorAll<HTMLElement>('.bg-cover-blur').forEach((pane) => {
      pane.style.removeProperty('opacity');
    });
    // 变量也同步到终值，供缩放/换档等其它路径读取。
    window.setTimeout(() => view.root.style.setProperty('--bg-cover-blur', to), 1420);
  };

  const syncCoverOpacity = (): void => {
    const on = coverMode();
    coverLayers.forEach((layer, index) => {
      const want = on && index === activeCoverLayer;
      const wasOn = layer.style.opacity === '1';
      fadeCoverLayer(layer, want);
      // 首次亮起来（或换封面后）才让模糊从 0 长上来；重复调用不重放，避免闪。
      if (want && !wasOn) introCover(layer);
    });
  };

  const currentTrackCover = (): string => {
    const track = effectiveBgLyricsCoverStyle() === 'cover' ? readSnapshot()?.track : null;
    return track ? freshCoverUrl(track) : '';
  };

  const revealCover = (url: string): void => {
    const nextIndex = activeCoverLayer === 0 ? 1 : 0;
    const next = coverLayers[nextIndex];
    const image = url ? `url("${url}")` : 'none';
    // 两层都写同一张图；模糊层用自身 filter: blur() 糊自己（不用 backdrop-filter，
    // 那个在桌面歌词窗口里不逐帧重绘，只有整页重画时才更新）。
    next.querySelectorAll<HTMLDivElement>('.bg-cover-sharp').forEach((pane) => {
      pane.style.backgroundImage = image;
    });
    next.querySelectorAll<HTMLDivElement>('.bg-cover-blur').forEach((pane) => {
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
    const wantCover = effectiveBgLyricsCoverStyle() === 'cover';
    const changed = view.root.classList.contains('is-bg-cover-left') !== wantCover;
    const commitStyle = (): void => {
      view.root.classList.toggle('is-bg-cover-left', wantCover);
      syncCoverOpacity();
      // 切样式（含切回「纯壁纸」）后必须重算壁纸模糊，否则 html 上的类会留在旧状态。
      applyCoverBlur(false);
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

  // 窗口被宿主收起再显示（开始/暂停播放、切歌）时，页面其实刚被合成；
  // 这时候补一次「封面淡入 + 模糊从 0 长到设定值」，否则看上去就是一下子糊满。
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !coverMode()) return;
    const layer = coverLayers[activeCoverLayer];
    fadeCoverLayer(layer, true);
    introCover(layer);
  });

  // WebView2 在窗口被收起时会把 rAF 停掉，恢复后第一帧的时间差会很大。
  // 用它当「刚被显示出来」的信号重放一次进场，避免动画在看不见的时候播完、一露脸就是糊的终态。
  {
    let lastFrame = performance.now();
    const watchFrames = (now: number): void => {
      if (now - lastFrame > 1200 && coverMode()) {
        const layer = coverLayers[activeCoverLayer];
        fadeCoverLayer(layer, true);
        introCover(layer);
      }
      lastFrame = now;
      window.requestAnimationFrame(watchFrames);
    };
    window.requestAnimationFrame(watchFrames);
  }

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
    if (event.key === 'zilux2.lumiere') {
      applyCoverStyle(false);
      applyCoverImage(false);
      applyCoverBlur();
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
  let lastPushedSignature = '';

  const pushClock = (): void => {
    // 窗口被遮住/最小化时不需要每 100ms 让歌词页全量重算一遍。
    if (document.hidden) return;
    const elapsed = clock.playing ? performance.now() - clock.syncedAt : 0;
    let position = clock.positionMs + elapsed;
    if (clock.durationMs > 0) position = Math.min(position, clock.durationMs);
    // 宿主快照 1 秒才来一次，采样点比本地外推略旧；四舍五入回跳会让行索引来回抖，
    // 所以播放中只允许向前（真的 seek 由下面的跳变判断放行）。
    if (clock.playing) position = Math.max(position, pushedPositionMs);
    pushedPositionMs = position;
    // 暂停且位置/时长都没变时跳过：重复推同一帧只会触发一次没有任何变化的整页同步。
    const signature = `${clock.playing ? 1 : 0}|${Math.round(position)}|${Math.round(clock.durationMs)}`;
    if (signature === lastPushedSignature) return;
    lastPushedSignature = signature;
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
