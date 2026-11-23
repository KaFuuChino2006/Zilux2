/**
 * FX 界面第一个内容视图：`今日推荐`。
 *
 * 三块内容，从下往上叠（DOM 顺序即层级）：
 *   1. `.fx-cover` —— 红线上方那条「整块封面渐变」：顶部白色渐变，往下露出封面。
 *      没在播歌时自动轮换今日推荐的封面；一旦选中/开始播放某首，就固定到那首的封面。
 *   2. `.fx-cards` —— 红线下方的正方形歌曲网格。**每张卡都是独立内容物**：
 *      自带 `data-key` / `data-index` / 自己的封面与文字 DOM，卡与卡之间不共享节点，
 *      后续要做排斥移动、自动排布这类整屏动画时，直接拿 `cards()` 里的元素逐个摆就行。
 *   3. `.fx-daily` —— 右上四个大字（维护者指定的版式与进场动效，见下面常量）。
 *
 * 大字进场（维护者指定，参数写在常量里，改手感只改这几个数）：
 *   1. 60fps；划入很快（20 帧 ≈ 333ms）。
 *   2. 闪烁只发生在划入的最前面：一帧亮一帧灭，共 4 次（8 帧 ≈ 133ms），每闪一次换随机字形 + 随机字体。
 *   3. 每个字从**窗口外**滑进来（今/推从上方、日/荐从右侧）。
 *   4. 落字在滑入一半（第 10 帧）：到这儿已经停止闪烁、字体也定死，剩下的路程静静滑到位。
 *
 * 为什么用 rAF 数帧而不是 CSS animation：闪烁要求按帧对齐，CSS 没法保证逐帧精度。
 *
 * 注意：不要给字加 `will-change`。WebView2 + DWM 下它会成为独立合成层，
 * 整层连桌面抓屏都拍不到（装机版实测过），表现为「字根本不显示」。
 */
import type { OnlineTrack } from '../online/types';
import { onlineArtwork } from '../online/artwork';
import { CoverLyrics } from './coverLyrics';
import { MOTION } from './motion';
import { onPlayer, playerState } from './player';

/** 落字时的四个字，顺序 = 宫格顺序（左上、右上、左下、右下）。 */
export const FX_DAILY_TEXT = '今日推荐' as const;

/** 每个字的进场方向：左上「今」从上、右上「日」从右，下面一行同规律。 */
export const FX_DAILY_DIRS: ReadonlyArray<'top' | 'right'> = ['top', 'right', 'top', 'right'];

/** 闪烁按 60fps 计帧。 */
export const FX_DAILY_FPS = 60;
/** 划入非常快：20 帧 ≈ 333ms（维护者：划入的速度是很快的）。 */
export const FX_DAILY_ENTER_FRAMES = 20;
/**
 * 闪烁只发生在划入的那一点点时间里，一共 4 次（维护者 2026-11-21 指定：闪烁次数为 4 次）。
 * 每个状态 1 帧（比上一版快 0.5x）：亮/灭交替 → 4 次闪 = 8 帧 ≈ 133ms。
 */
export const FX_DAILY_BLINK_FLASHES = 4;
/** 闪烁每个状态占几帧（1 = 一帧亮一帧灭）。 */
export const FX_DAILY_BLINK_STEP = 1;
/** 闪烁窗口 = 4 次 × （亮 1 帧 + 灭 1 帧） = 8 帧。 */
export const FX_DAILY_BLINK_FRAMES = 8;
/** 落字帧：滑入的一半。比闪烁窗口晚、比滑入结束早 —— 到这儿已经不再闪、字体也定死了。 */
export const FX_DAILY_RESOLVE_FRAME = 10;
/**
 * 四个字的入场延迟区间（维护者：单字延迟到 0.3-0.5）。60fps 下 18 帧 = 300ms、30 帧 = 500ms，
 * 每次重播每个字在 0.3s–0.5s 之间随机取一个延迟，谁的先后每回都不一样。
 */
export const FX_DAILY_STAGGER_MIN_FRAMES = 18;
export const FX_DAILY_STAGGER_MAX_FRAMES = 30;
/** 整段动画总帧数 = 滑入帧数 + 最大延迟（最晚起跑的那个字也要有时间滑完）。 */
export const FX_DAILY_TOTAL_FRAMES = FX_DAILY_ENTER_FRAMES + FX_DAILY_STAGGER_MAX_FRAMES;

/** 没有在播歌时，封面自动轮换的间隔；太长会显得静止，太短会闪。 */
export const FX_COVER_ROTATE_MS = 6000;
/** 离开今日推荐时「原路返回」的总时长，和退场动画对齐。 */
const FX_LEAVE_MS = 420;

/** 随机字体池：Windows 上自带的、能出汉字的几套，风格跨度够大才看得出「乱换」。 */
export const FX_DAILY_FONTS: ReadonlyArray<string> = [
  '"Microsoft YaHei UI"',
  '"Microsoft YaHei"',
  '"SimHei"',
  '"SimSun"',
  '"KaiTi"',
  '"FangSong"',
  '"Microsoft JhengHei"',
  '"DengXian"',
  '"YouYuan"',
  '"STZhongsong"',
  '"STKaiti"',
  '"STSong"',
];

/** 落字后用的字体：黑体系的粗笔画，硬朗（随机池里没有它，落字那一下看得出区别）。 */
export const FX_DAILY_FINAL_FONT = '"SimHei", "Microsoft YaHei", "Microsoft YaHei UI", sans-serif';

/** 乱跳字形用的备选字：笔画量与「今日推荐」接近，跳起来不跳戏。 */
const SCRAMBLE_GLYPHS = '今日推荐谱曲乐音律旋律节拍光影像梦境浮沉暖夜星野';

export interface FxDailyDeps {
  registerTrack?: (track: OnlineTrack) => string;
  onTrackChange?: (key: string) => void;
  /** 拉今日推荐的歌曲；失败/空数组都按「没有内容」处理。 */
  load: () => Promise<OnlineTrack[]>;
  /** 点卡片时交给宿主 App 走既有的播放链路。 */
  play: (tracks: OnlineTrack[], index: number) => void;
}

export interface FxDailyStage {
  /** 换标题文字（四个字）并立即重画字形。 */
  setWord(text: string): void;
  /** 换数据来源（今日推荐 / 私人雷达 / 其它整页）。 */
  setLoader(fn: () => Promise<OnlineTrack[]>): void;
  /** 挂在 .fx-stage 里的根节点。 */
  root: HTMLDivElement;
  /** 选择器切项：key === 'daily' 时显示并重播进场，其余隐藏。 */
  show(key: string): void;
  /** 离开今日推荐：所有元素按进来时的路线原样退回去，退完再执行 after。 */
  leave(after?: () => void): void;
  /** 直接收干净（不播退场）：退场已经播过、或从没进过这个视图时用。 */
  hide(): void;
  /** 重播大字进场（切回 FX / 再次点「今日推荐」时用）。 */
  replay(): void;
  /**
   * 让封面跟着当前曲目走：传 null 表示没有在播的内容（回到自动轮换）。
   * App 会在 onPlayer 里调用。
   */
  /** 第二个参数 idleRotate：当前没在播放时继续轮换封面带。 */
  syncCurrent(track: OnlineTrack | null, idleRotate?: boolean): void;
  /** 重新拉一次内容（在线源刚就绪、或上一次空结果时用）。 */
  reload(): void;
  /** 当前网格里的卡片元素（给后续整屏排布动画用，顺序 = 数据顺序）。 */
  cards(): HTMLElement[];
  /** 销毁：停掉 rAF 与轮换定时器。 */
  dispose(): void;
}

function randomOf<T>(list: ReadonlyArray<T>): T {
  return list[Math.floor(Math.random() * list.length)];
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function trackKey(track: OnlineTrack): string {
  return `${track.source}:${track.id}`;
}

export function createFxDailyStage(deps: FxDailyDeps): FxDailyStage {
  const root = document.createElement('div');
  root.className = 'fx-daily-view';

  /* ---------- 1. 顶部封面渐变 ---------- */

  const cover = document.createElement('div');
  cover.className = 'fx-cover';
  cover.setAttribute('aria-hidden', 'true');
  // 两层 img 交替淡入，换封面时才不会闪白一下。
  const coverLayers: HTMLImageElement[] = [];
  for (let index = 0; index < 2; index += 1) {
    const img = document.createElement('img');
    img.className = 'fx-cover-img';
    img.alt = '';
    img.draggable = false;
    cover.append(img);
    coverLayers.push(img);
  }
  const wash = document.createElement('div');
  wash.className = 'fx-cover-wash';
  cover.append(wash);
  let activeLayer = 0;
  /** 下一次换封面从哪边进来；每换一次换一边。 */
  let coverFromTop = false;
  let paintedCover = '';

  /**
   * 换封面：新的一层从下沿（或上沿）滑进来，旧的一层往上收缩渐隐。
   * 维护者 2026-11-21 反馈「点歌时封面会突然覆盖整个屏幕再渐隐」——
   * 所以换封面的动效只发生在这条封面带里，绝不铺到整屏。
   */
  const paintCover = (src: string): void => {
    if (!src || src === paintedCover) return;
    paintedCover = src;
    const next = coverLayers[1 - activeLayer];
    const prev = coverLayers[activeLayer];
    next.src = src;
    next.classList.add('is-on');
    prev.classList.remove('is-on');
    activeLayer = 1 - activeLayer;
    cover.classList.add('has-cover');

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    const fromTop = coverFromTop;
    coverFromTop = !coverFromTop;
    next.animate(
      [
        { transform: `translate3d(0, ${fromTop ? '-26%' : '26%'}, 0) scale(1.04)`, opacity: 0 },
        { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
      ],
      { duration: MOTION.slow, easing: MOTION.ease, fill: 'both' },
    );
    prev.animate(
      [
        { transform: 'translate3d(0, 0, 0) scale(1)', opacity: 1 },
        { transform: 'translate3d(0, -18%, 0) scale(0.97)', opacity: 0 },
      ],
      { duration: MOTION.fast, easing: MOTION.ease, fill: 'both' },
    );
  };

  /* ---------- 1.6 左侧大封面：歌单第一首只在这里露出，不进右侧网格 ---------- */

  const heroCard = document.createElement('button');
  heroCard.type = 'button';
  heroCard.className = 'fx-hero-cover is-hidden';
  heroCard.title = '';
  /* 两层封面图交替显示：换歌时新层用「墨水扩散」蒙版盖上来，才有渐变过渡而不是硬切。 */
  const heroLayers = [0, 1].map(() => {
    const img = document.createElement('img');
    img.className = 'fx-hero-cover-img';
    img.alt = '';
    img.draggable = false;
    return img;
  });
  let heroFront = 0;
  /** 封面入场动画时长（与 CSS 的 fx-hero-zoom 对齐）；两条的文字动画要等它结束。 */
  const HERO_COVER_MS = MOTION.slow;
  /** 竖条换名：先滑出（含两次闪烁）再滑入，时长与 CSS 的 fx-rail-out / fx-rail-in 对齐。 */
  const RAIL_LEAVE_MS = MOTION.fast;
  const RAIL_ARRIVE_MS = MOTION.base;
  let heroTextTimer = 0;
  /** 同一时刻只允许一条收尾定时器；快速切歌时清掉旧的，动画才不会互相打架。 */
  let heroSettleTimer = 0;

  const paintHero = (src: string, instant = false): void => {
    const front = heroLayers[heroFront]!;
    const back = heroLayers[1 - heroFront]!;
    if (!src) return;
    window.clearTimeout(heroSettleTimer);

    if (instant) {
      for (const layer of heroLayers) layer.classList.remove('is-bloom', 'is-out');
      front.classList.add('is-on');
      back.classList.remove('is-on');
      if (front.src !== src) front.src = src;
      return;
    }
    // 同一张图：只保证它在台前，不重放动画（否则连点同一首会闪）。
    if (front.classList.contains('is-on') && front.src === src) {
      back.classList.remove('is-on', 'is-bloom', 'is-out');
      return;
    }
    // 被打断的那一轮可能还挂着临时类：先全部摘干净再上图，避免「封面丢了 / 双动画」。
    for (const layer of heroLayers) layer.classList.remove('is-bloom', 'is-out');
    window.clearTimeout(heroSettleTimer);
    if (back.src !== src) back.src = src;
    void back.offsetWidth;
    back.classList.add('is-on', 'is-bloom');
    heroFront = 1 - heroFront;
    // 旧层正在收进来时被打断：先摘 is-bloom 让它从当前状态平滑退场。
    front.classList.remove('is-bloom');
    front.classList.add('is-out');
    const stale = front;
    heroSettleTimer = window.setTimeout(() => {
      stale.classList.remove('is-on', 'is-bloom', 'is-out');
      back.classList.remove('is-bloom', 'is-out');
      back.classList.add('is-on');
    }, HERO_COVER_MS);
  };

  /* 底部纯色长条：歌名 / 作者 / 时长都写在这条上，文字用和四字同一套「随机字形 + 滑入」。 */
  const heroBar = document.createElement('div');
  heroBar.className = 'fx-hero-bar';
  const barName = document.createElement('span');
  barName.className = 'fx-hero-bar-name';
  const barArtist = document.createElement('span');
  barArtist.className = 'fx-hero-bar-artist';
  const barTime = document.createElement('span');
  barTime.className = 'fx-hero-bar-time';
  heroBar.append(barName, barArtist, barTime);
  heroCard.append(...heroLayers);
  /* 条在封面外面：外壳竖排「封面 → 条」。 */
  const heroShell = document.createElement('div');
  heroShell.className = 'fx-hero-shell';
  heroShell.append(heroCard, heroBar);

  /* 封面内歌词：点播之后封面里跟着唱（白色辉光、上下行被挤小）。 */
  const coverLyrics = new CoverLyrics(heroCard);
  heroCard.classList.toggle('is-lyric-playing', playerState().playing);
  let disposed = false;

  /* 封面右缘到网格左缘之间那条纯色框：里面只有竖排的反向渐变歌名。 */
  const nameRail = document.createElement('div');
  nameRail.className = 'fx-name-rail';
  /* 像 LED 广告牌那样轮播：两份同样的文字首尾相接，整体往上匀速滚动。 */
  const nameRailTrack = document.createElement('div');
  nameRailTrack.className = 'fx-name-rail-track';
  const nameRailText = document.createElement('span');
  nameRailText.className = 'fx-name-rail-text';
  nameRailTrack.append(nameRailText);
  nameRail.append(nameRailTrack);
  heroCard.addEventListener('click', () => {
    const hero = tracks[heroIndex];
    if (!hero) return;
    paintCover(onlineArtwork(hero, 900));
    toGridLayout();
    scheduleListLayout();
    deps.play(tracks, heroIndex);
  });

  /* ---------- 2. 下方歌曲网格 ---------- */

  const grid = document.createElement('div');
  grid.className = 'fx-cards';
  grid.setAttribute('role', 'list');

  const hint = document.createElement('div');
  hint.className = 'fx-cards-hint is-hidden';
  hint.textContent = '今日推荐需要登录在线平台后才有内容';

  let tracks: OnlineTrack[] = [];
  let loading: Promise<void> | null = null;
  /** 标题四个字（今日推荐 / 私人雷达 …）。 */
  let wordText: string = FX_DAILY_TEXT;
  /** 数据来源：今日推荐、私人雷达各一套，由宿主页面切换。 */
  let loadTracks: () => Promise<OnlineTrack[]> = deps.load;
  let currentKey = '';
  let rotateTimer = 0;
  /** 当前没在播放：封面带继续按歌单轮换。 */
  let idleRotating = false;
  let rotateIndex = 0;

  const cardNodes: HTMLElement[] = [];

  const buildCard = (track: OnlineTrack, index: number): HTMLElement => {
    // 每张卡完全独立：自己的封面节点、自己的文字节点、自己的 data，不跟别人共享。
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'fx-card';
    card.dataset.key = trackKey(track);
    if (deps.registerTrack) card.dataset.trackKey = deps.registerTrack(track);
    card.dataset.index = String(index);
    card.dataset.trackNumber = String(index + 1).padStart(3, '0');
    card.style.setProperty('--i', String(index));
    card.setAttribute('role', 'listitem');
    card.title = `${track.title} — ${track.artist}`;

    const img = document.createElement('img');
    img.className = 'fx-card-cover';
    img.alt = '';
    img.draggable = false;
    img.loading = index < 12 ? 'eager' : 'lazy';
    img.decoding = 'async';
    img.src = onlineArtwork(track, 300);
    card.append(img);

    const meta = document.createElement('span');
    meta.className = 'fx-card-meta';
    const name = document.createElement('span');
    name.className = 'fx-card-name';
    name.textContent = track.title;
    const artist = document.createElement('span');
    artist.className = 'fx-card-artist';
    artist.textContent = track.artist || '未知歌手';
    meta.append(name, artist);
    card.append(meta);

    card.addEventListener('click', () => {
      if (!tracks[index]) return;
      // 横条列表里选歌：列表不重排（不把这一行挪走），但左侧大封面与歌曲条要换成这一首。
      if (grid.classList.contains('is-list')) {
        heroIndex = index;
        paintCover(onlineArtwork(track, 900));
        syncHeroCover();
        flashCard(card);
        deps.play(tracks, index);
        return;
      }
      const before = captureRects();
      heroIndex = index;
      paintCover(onlineArtwork(track, 900));
      render({ flipFrom: before });
      deps.play(tracks, index);
      scheduleListLayout();
    });
    return card;
  };

  /** 横条列表里点一下：当前行亮几秒，随后自己淡回去（不再把这首挪到大封面）。 */
  let flashTimer = 0;
  let flashedCard: HTMLElement | null = null;

  const flashCard = (card: HTMLElement): void => {
    window.clearTimeout(flashTimer);
    flashedCard?.classList.remove('is-flash');
    flashedCard = card;
    card.classList.add('is-flash');
    flashTimer = window.setTimeout(() => {
      card.classList.remove('is-flash');
      if (flashedCard === card) flashedCard = null;
    }, 3200);
  };

  /** 长条上的三段文字：逐帧用随机字形代替，收尾落到真实文本（和四字同一套手感）。 */
  const barScrambles = new WeakMap<HTMLElement, number>();

  const scrambleBar = (el: HTMLElement, text: string): void => {
    const running = barScrambles.get(el);
    if (running) window.clearTimeout(running);
    const chars = Array.from(text);
    let frame = 0;
    const steps = FX_DAILY_BLINK_FRAMES;
    const run = (): void => {
      if (frame >= steps) {
        el.textContent = text;
        return;
      }
      el.textContent = chars
        .map((ch) => (ch === ' ' || ch === '.' || ch === '·' ? ch : SCRAMBLE_GLYPHS[Math.floor(Math.random() * SCRAMBLE_GLYPHS.length)]!))
        .join('');
      frame += 1;
      barScrambles.set(el, window.setTimeout(run, 1000 / FX_DAILY_FPS));
    };
    run();
  };

  const formatDuration = (ms: number): string => {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const total = Math.round(ms / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  };

  /** 左侧大封面只放第一首的封面图与底部条上的文字。 */
  /** 当前被选作左侧大封面的那一首（默认第一首），它不占网格。 */
  let heroIndex = 0;
  /** 下一次 render 是否给卡片做入场动画（只在切回今日推荐时做一次）。 */
  let cardsEntering = false;

  const enterHero = (): void => {
    heroShell.classList.remove('is-entering');
    void heroShell.offsetWidth;
    heroShell.classList.add('is-entering');
  };
  /** 竖条从封面里推出来：重播一次蒙版动画。 */
  const playRailEnter = (): void => {
    nameRail.classList.remove('is-enter');
    void nameRail.offsetWidth;
    nameRail.classList.add('is-enter');
  };

  /** 竖条文字：左右顶满；走字一次（一段文字的行程），走完停在居中的常规样子。 */
  const playRailRoll = (): void => {
    const len = nameRailText.offsetHeight;
    const strip = nameRail.clientHeight;
    if (!len || !strip) return;
    // 行程最多一条的高度：长歌名也不会从很远的地方慢慢爬进来（会长时间看不见）。
    const travel = Math.min(len, strip);
    const dur = Math.min(6, Math.max(2.2, travel / 170));
    // 长歌名停住后要能看见「开头」，所以靠上排；短歌名保持居中。
    nameRail.classList.toggle('is-tall', len > strip);
    nameRail.style.setProperty('--rail-start', `${travel}px`);
    nameRail.style.setProperty('--rail-dur', `${dur.toFixed(2)}s`);
    nameRail.classList.remove('is-rolling');
    void nameRail.offsetWidth;
    nameRail.classList.add('is-rolling');
  };

  const fitRailText = (): void => {
    if (!nameRailText.textContent) return;
    const railW = nameRail.clientWidth;
    if (!railW) return;
    nameRail.style.setProperty('--rail-size', `${Math.max(28, railW * 0.98)}px`);
    window.requestAnimationFrame(playRailRoll);
  };

  /** 只写一份文字（不重复），写完滚一次就回到静态居中。 */
  const setRailText = (text: string): void => {
    nameRailText.textContent = text;
    fitRailText();
  };

  /** 换歌：旧名字「滑出去 + 闪两下渐隐」，新名字从下往上滑进来、同样闪两下后停住。
      动画挂在 .fx-name-rail-track 上而不是文字本身：文字是 background-clip:text，
      在它身上做 transform 位移会被吃掉/看不出效果；轨道是普通块，位移一定生效。
      入场本身就是进场动画，落定后不再补一次走字（否则看起来像出现了两遍）。 */
  let railSwapTimer = 0;
  let railArriveTimer = 0;
  const swapRailText = (text: string): void => {
    window.clearTimeout(railSwapTimer);
    window.clearTimeout(railArriveTimer);
    nameRail.classList.remove('is-arriving');
    nameRail.classList.remove('is-leaving');
    // 先把走字动画的 class 摘掉，否则它的规则优先级更高，会把离场/入场动画压住。
    nameRail.classList.remove('is-rolling');
    void nameRailTrack.offsetWidth;
    nameRail.classList.add('is-leaving');
    railSwapTimer = window.setTimeout(() => {
      nameRailText.textContent = text;
      nameRail.style.removeProperty('--rail-start');
      nameRail.classList.remove('is-rolling');
      nameRail.classList.remove('is-leaving');
      // 先把字号量准，再上入场动画：新名字一出现就在最终字号上，不会先小后大。
      const railW = nameRail.clientWidth;
      if (railW) nameRail.style.setProperty('--rail-size', `${Math.max(28, railW * 0.98)}px`);
      nameRail.classList.toggle('is-tall', nameRailText.offsetHeight > nameRail.clientHeight);
      void nameRailTrack.offsetWidth;
      nameRail.classList.add('is-arriving');
      railArriveTimer = window.setTimeout(() => {
        nameRail.classList.remove('is-arriving');
      }, RAIL_ARRIVE_MS);
    }, RAIL_LEAVE_MS);
  };

  /** 上一次给条做动画的那首歌；同一首歌就不再重放动画（否则每帧 render 都会闪一次）。 */
  let heroBarKey = '';

  const syncHeroCover = (instantCover = false): void => {
    const first = tracks[heroIndex];
    if (!first) {
      delete heroCard.dataset.trackKey;
      heroCard.classList.add('is-hidden');
      heroBarKey = '';
      return;
    }
    if (deps.registerTrack) {
      heroCard.dataset.trackKey = deps.registerTrack(first);
      heroCard.title = `${first.title} — ${first.artist}`;
    }
    paintHero(onlineArtwork(first, 900), instantCover);
    heroCard.classList.remove('is-hidden');
    const name = (first.title ?? '').trim();
    const artist = (first.artist ?? '').trim();
    const time = formatDuration(first.durationMs);
    const key = trackKey(first);
    if (key === heroBarKey) {
      // 同一首歌（滚动 / 播放状态变化引起的重渲染）：只补差异，不重放任何动画。
      // 注意别在这里无条件 setRailText —— 它会触发 fitRailText()→playRailRoll()，
      // 每重渲染一次就多滚一遍，看起来像「点了又刷新一次」。
      if (barName.textContent !== (name || '未知曲目')) barName.textContent = name || '未知曲目';
      if (barArtist.textContent !== artist) barArtist.textContent = artist;
      if (barTime.textContent !== time) barTime.textContent = time;
      if (nameRailText.textContent !== (name || '未知曲目')) setRailText(name || '未知曲目');
      return;
    }
    heroBarKey = key;
    // 维护者：下方纯色条与右侧渐变条的动画要等封面入场动画结束再触发。
    const applyHeroText = (): void => {
      // 竖条与下方的条同一时刻入场：先展开这条，再换名字。
      playRailEnter();
      // 竖条：旧名字滑出闪一下，新名字接着滑入（不是直接换字）。
      swapRailText(name || '未知曲目');
      barName.title = name;
      barArtist.title = artist;
      scrambleBar(barName, name || '未知曲目');
      scrambleBar(barArtist, artist);
      barTime.textContent = time;
      heroBar.classList.remove('is-animating');
      void heroBar.offsetWidth;
      heroBar.classList.add('is-animating');
    };
    window.clearTimeout(heroTextTimer);
    if (instantCover) {
      applyHeroText();
    } else {
      heroTextTimer = window.setTimeout(applyHeroText, HERO_COVER_MS + 40);
    }
  };

  /** 记录换网格前的卡片位置，用于「抽掉一张后其余卡片补位」的位移动画（FLIP）。 */
  /* ---------- 3 秒无操作后：卡片翻转渐隐，切成横条列表 ---------- */
  let layoutTimer = 0;

  const clearLayoutTimer = (): void => {
    if (!layoutTimer) return;
    window.clearTimeout(layoutTimer);
    layoutTimer = 0;
  };

  const toListLayout = (): void => {
    if (!cardNodes.length || grid.classList.contains('is-list')) return;
    grid.classList.add('is-flipping');
    cardNodes.forEach((card, i) => card.style.setProperty('--fx-flip-delay', `${Math.min(420, i * 16)}ms`));
    const flipMs = MOTION.base + Math.min(MOTION.base, cardNodes.length * 16);
    // 逐条弹出入场：给每张卡写延时，列表模式的 fx-row-in 会按顺序播。
    cardNodes.forEach((node, i) => {
      node.style.setProperty('--fx-row-delay', `${Math.min(900, i * 34)}ms`);
    });
    window.setTimeout(() => {
      grid.classList.remove('is-flipping');
      grid.classList.add('is-list');
      cardNodes.forEach((card) => card.style.removeProperty('--fx-flip-delay'));
    }, flipMs);
  };

  const toGridLayout = (): void => {
    clearLayoutTimer();
    if (!grid.classList.contains('is-list')) return;
    grid.classList.remove('is-list');
  };

  /** 选过歌之后开始计时：3 秒内没有新的点击就切成列表。 */
  const scheduleListLayout = (): void => {
    clearLayoutTimer();
    layoutTimer = window.setTimeout(toListLayout, 3000);
  };

  // 有人还在网格上动鼠标/触摸，就别急着切成列表。
  grid.addEventListener('pointerdown', clearLayoutTimer, { passive: true });

  const captureRects = (): Map<string, DOMRect> => {
    const map = new Map<string, DOMRect>();
    for (const card of cardNodes) {
      const key = card.dataset.key;
      if (key) map.set(key, card.getBoundingClientRect());
    }
    return map;
  };

  const flipTimers = new WeakMap<HTMLElement, number>();

  /** 切走 / 重新点歌时：把还在跑的 FLIP 全部按当前状态收尾。 */
  const cancelFlip = (): void => {
    for (const card of cardNodes) {
      const timer = flipTimers.get(card);
      if (timer) window.clearTimeout(timer);
      card.style.transition = 'none';
      card.style.transform = '';
      flipTimers.delete(card);
      void card.offsetWidth;
      card.style.transition = '';
    }
  };

  const playFlip = (before: Map<string, DOMRect>): void => {
    for (const card of cardNodes) {
      const prev = before.get(card.dataset.key ?? '');
      if (!prev) continue;
      const now = card.getBoundingClientRect();
      const dx = prev.left - now.left;
      const dy = prev.top - now.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      card.style.transition = 'none';
      card.style.transform = `translate(${dx}px, ${dy}px)`;
      void card.offsetWidth;
      card.style.transition = `transform ${MOTION.base}ms ${MOTION.ease}`;
      card.style.transform = '';
      // 被打断时（切走 / 再点一首）把过渡和残留位移收回来，不留半截状态。
      const timer = window.setTimeout(() => {
        card.style.transition = '';
        card.style.transform = '';
      }, 460);
      flipTimers.set(card, timer);
    }
  };

  const render = (options: { flipFrom?: Map<string, DOMRect> } = {}): void => {
    // 点卡片会让某一首提到左侧大封面，重排后行数变少：不能因此把滚动位置丢掉、跳回顶部。
    const keepScroll = grid.scrollTop;
    grid.textContent = '';
    cardNodes.length = 0;
    grid.classList.toggle('is-empty', tracks.length === 0);
    hint.classList.toggle('is-hidden', tracks.length > 0 || loading !== null);
    // 当前选中的那首固定在左侧大封面，不占网格；其余按原顺序铺成四列。
    syncHeroCover(options.flipFrom === undefined);
    for (let index = 0; index < tracks.length; index += 1) {
      if (index === heroIndex) continue;
      // 单首曲子出问题不能连累整面网格：坏一条就跳过它。
      try {
        const card = buildCard(tracks[index]!, index);
        if (cardsEntering) {
          // 逐个翻：按网格顺序排队，间隔很小，所以整体很快。
          card.classList.add('is-entering');
          card.style.setProperty('--fx-card-delay', `${cardNodes.length * 26}ms`);
        }
        cardNodes.push(card);
        grid.append(card);
      } catch (err) {
        console.warn('[fx-daily] card build failed', index, err);
      }
    }
    // 没在播放时（暂停/未播）也要轮换：syncCurrent 早于数据回来时 tracks 还是空的。
    if (tracks.length > 0 && (!currentKey || idleRotating)) startRotate();
    if (keepScroll > 0) {
      // 等布局落定再恢复，避免内容还没撑开就被 clamp 成 0。
      window.requestAnimationFrame(() => {
        grid.scrollTop = keepScroll;
        applyCollapse();
      });
    }
    if (options.flipFrom) playFlip(options.flipFrom);
    cardsEntering = false;
    // 之前在等数据：内容到手的第一帧才播封面带入场（和封面一起出现，只播一次）。
    if (bandEnterPending) {
      playBandEnter();
      replayCards();
    } else if (!bandEntered && tracks.length > 0 && !root.classList.contains('is-hidden')) {
      playBandEnter();
    }
  };

  const loadOnce = (): Promise<void> => {
    if (loading) return loading;
    grid.classList.add('is-loading');
    loading = loadTracks()
      .then((list) => {
        if (disposed) return;
        const displayed = tracks[heroIndex];
        tracks = list;
        const playing = playerState().track;
        const active = playing ? list.findIndex(item => trackKey(item) === trackKey(playing)) : -1;
        const retained = displayed ? list.findIndex(item => trackKey(item) === trackKey(displayed)) : -1;
        heroIndex = active >= 0 ? active : Math.max(0, retained);
        loading = null;
        // 空结果不当成「已经加载过」：下次切回今日推荐会再试一次。
        if (list.length === 0) loading = null;
        grid.classList.remove('is-loading');
        render();
        syncCurrent(playing, !playerState().playing);
        if (list.length === 0) console.warn('[fx-daily] 今日推荐没有内容（接口空/未登录）');
      })
      .catch((err) => {
        console.warn('[fx-daily] 今日推荐加载失败', err);
        tracks = [];
        loading = null;
        grid.classList.remove('is-loading');
        render();
      });
    return loading;
  };

  /* ---------- 2.5 滚动联动：内容往上翻时封面带收起、四字往右让位 ---------- */

  /** 封面带在未收起时的高度（px），滚动前量一次。 */
  let bandH = 0;
  let collapsed = false;

  const measureBand = (): void => {
    const h = cover.offsetHeight;
    if (h > 0) bandH = h;
  };

  const applyCollapse = (): void => {
    if (!bandH) measureBand();
    const range = bandH * 0.92;
    const raw = range > 0 ? grid.scrollTop / range : 0;
    const progress = Math.max(0, Math.min(1, raw));
    root.style.setProperty('--fx-collapse', progress.toFixed(3));
    if (progress > 0.02) {
      collapsed = true;
    } else if (collapsed) {
      // 划回顶：四字重新按原入场动效进来（时间还是随机的）。
      collapsed = false;
      replay();
    }
  };

  const onScroll = (): void => {
    if (disposed || leaving || root.classList.contains('is-hidden')) return;
    if (!root.closest('.wall-daily-layout')) applyCollapse();
  };
  const onResize = (): void => {
    fitRailText();
    measureBand();
    if (!root.closest('.wall-daily-layout')) applyCollapse();
  };
  grid.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onResize, { passive: true });

  /* ---------- 3. 封面自动轮换（没有在播内容时） ---------- */

  const stopRotate = (): void => {
    if (rotateTimer) window.clearInterval(rotateTimer);
    rotateTimer = 0;
  };

  const rotateStep = (): void => {
    if (tracks.length === 0) return;
    const track = tracks[rotateIndex % tracks.length]!;
    rotateIndex += 1;
    paintCover(onlineArtwork(track, 900));
  };

  const startRotate = (): void => {
    stopRotate();
    if (tracks.length === 0) return;
    // 注意：这里不要立刻 rotateStep()。render()/syncHeroCover() 刚上过第一张封面，
    // 再上一张会变成「同一时刻两次过渡」，看起来就是封面闪两下。
    rotateTimer = window.setInterval(rotateStep, FX_COVER_ROTATE_MS);
  };

  /* ---------- 4. 右上四个大字（原有动效） ---------- */

  const word = document.createElement('div');
  word.className = 'fx-daily is-hidden';
  word.setAttribute('aria-hidden', 'true');

  const cells: HTMLSpanElement[] = [];
  for (let index = 0; index < FX_DAILY_TEXT.length; index += 1) {
    const cell = document.createElement('span');
    cell.className = 'fx-daily-cell';
    cell.dataset.dir = FX_DAILY_DIRS[index] ?? 'top';
    cell.textContent = wordText[index];
    word.append(cell);
    cells.push(cell);
  }

  let raf = 0;
  let startedAt = 0;
  /** 每个字「从窗口外」滑到原位要走的像素距离，重播前量一次。 */
  let travelPx: number[] = cells.map(() => 0);
  /** 每个字各自延迟几帧才起跑（重播时重新随机）。 */
  let delays: number[] = cells.map(() => 0);
  /** 每个字各自已经应用到第几次乱跳；-1 = 还没开始。 */
  let scrambleSteps: number[] = cells.map(() => -1);

  /**
   * 量「从外部划入」的起始距离：
   *   从上方进来 → 起始位置让整块落在窗口顶端之上（-bottom-40）；
   *   从右侧进来 → 起始位置让整块落在窗口右缘之外（vw-left+40）。
   * 量不到尺寸（还藏着）就沿用上一次的值。
   */
  const measureTravel = (): void => {
    const vw = window.innerWidth;
    const next = cells.map((cell, index) => {
      const rect = cell.getBoundingClientRect();
      if (!rect.width || !rect.height) return travelPx[index] ?? 0;
      return FX_DAILY_DIRS[index] === 'right' ? vw - rect.left + 40 : -(rect.bottom + 40);
    });
    travelPx = next;
  };

  const settle = (): void => {
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index];
      cell.textContent = wordText[index];
      cell.style.fontFamily = FX_DAILY_FINAL_FONT;
      cell.style.transform = 'translate3d(0, 0, 0)';
      cell.style.opacity = '1';
    }
  };

  const framePaint = (frame: number): void => {
    for (let index = 0; index < cells.length; index += 1) {
      const cell = cells[index]!;
      // 每个字从自己的延迟帧开始算，四个字的入场时间因此是错开的。
      const local = frame - (delays[index] ?? 0);
      const fromRight = FX_DAILY_DIRS[index] === 'right';

      if (local < 0) {
        // 还没轮到这个字：藏在窗外，别提前露头。
        const offset = travelPx[index] ?? 0;
        cell.style.transform = fromRight
          ? `translate3d(${offset.toFixed(2)}px, 0, 0)`
          : `translate3d(0, ${offset.toFixed(2)}px, 0)`;
        cell.style.opacity = '0';
        continue;
      }

      const moveProgress = Math.min(1, local / FX_DAILY_ENTER_FRAMES);
      const remain = 1 - easeOutCubic(moveProgress);
      const settled = local >= FX_DAILY_RESOLVE_FRAME;
      const blinking = local < FX_DAILY_BLINK_FRAMES;
      const lit = Math.floor(local / FX_DAILY_BLINK_STEP) % 2 === 0;
      const visible = !blinking || lit;

      // 每闪一次换一套随机字形 + 随机字体；闪烁窗口之外不再换。
      if (blinking && !settled) {
        const flash = Math.floor(local / (2 * FX_DAILY_BLINK_STEP));
        if (flash !== (scrambleSteps[index] ?? -1)) {
          scrambleSteps[index] = flash;
          cell.textContent = SCRAMBLE_GLYPHS[Math.floor(Math.random() * SCRAMBLE_GLYPHS.length)]!;
          cell.style.fontFamily = randomOf(FX_DAILY_FONTS);
        }
      }

      const offset = (travelPx[index] ?? 0) * remain;
      cell.style.transform = fromRight
        ? `translate3d(${offset.toFixed(2)}px, 0, 0)`
        : `translate3d(0, ${offset.toFixed(2)}px, 0)`;
      cell.style.opacity = visible ? '1' : '0';
      if (settled) {
        cell.textContent = wordText[index];
        cell.style.fontFamily = FX_DAILY_FINAL_FONT;
      }
    }
  };

  const tick = (now: number): void => {
    if (!startedAt) startedAt = now;
    const elapsed = now - startedAt;
    const frame = Math.min(FX_DAILY_TOTAL_FRAMES, Math.floor((elapsed * FX_DAILY_FPS) / 1000));
    framePaint(frame);
    if (frame >= FX_DAILY_TOTAL_FRAMES) {
      settle();
      raf = 0;
      return;
    }
    raf = window.requestAnimationFrame(tick);
  };

  const stop = (): void => {
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
  };

  /** 卡片逐张转进来：不重建 DOM，只重挂 class，避免「重新渲染 = 动画播两遍」。 */
  const replayCards = (): void => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;
    cardNodes.forEach((node, index) => {
      node.classList.remove('is-entering');
      node.style.setProperty('--fx-card-delay', `${index * 26}ms`);
    });
    void grid.offsetWidth;
    for (const node of cardNodes) node.classList.add('is-entering');
  };

  const replay = (): void => {
    stop();
    startedAt = 0;
    // 每次重播都重新随机：四个字谁先谁后每回都不一样。
    delays = cells.map(() =>
      FX_DAILY_STAGGER_MIN_FRAMES +
      Math.floor(Math.random() * (FX_DAILY_STAGGER_MAX_FRAMES - FX_DAILY_STAGGER_MIN_FRAMES + 1)),
    );
    scrambleSteps = cells.map(() => -1);
    measureTravel();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      settle();
      return;
    }
    raf = window.requestAnimationFrame(tick);
  };

  /* ---------- 组装 ---------- */

  root.append(cover, hint, heroShell, nameRail, grid, word);
  settle();
  measureBand();

  let bandEnterTimer = 0;
  let bandEnterPending = false;
  let bandEntered = false;

  /** 封面带的入场（含白色渐变层）：整个视图进来时只播一次。 */
  const playBandEnter = (): void => {
    bandEnterPending = false;
    bandEntered = true;
    window.clearTimeout(bandEnterTimer);
    root.classList.remove('is-entering');
    void root.offsetWidth;
    root.classList.add('is-entering');
    bandEnterTimer = window.setTimeout(() => root.classList.remove('is-entering'), 760);
  };

  /** 直接收干净（不播退场）：退场已经放过、或压根没进过这个视图时用。 */
  const hide = (): void => {
    window.clearTimeout(leaveTimer);
    leaving = false;
    root.classList.remove('is-leaving');
    root.classList.add('is-hidden');
    cardNodes.forEach((node) => node.classList.remove('is-entering'));
  };

  const show = (key: string): void => {
    const daily = key === 'daily';
    if (daily) {
      // 上一次的退场可能还没走完（中途又点回来）：先把它收干净，再播进场。
      window.clearTimeout(leaveTimer);
      leaving = false;
      root.classList.remove('is-leaving');
      for (const node of cardNodes) {
        node.classList.remove('is-leaving');
        node.style.removeProperty('--fx-card-out-delay');
      }
    }
    if (daily) {
      fitRailText();
      window.requestAnimationFrame(fitRailText);
      playRailEnter();
    }
    if (daily) {
      // 每次进来都是网格态、从顶部开始（横条列表只属于「点过之后」的临时形态）。
      // 渲染是异步的，重置要放到下一帧，否则卡片刚铺好时 --fx-collapse 还停在上一次的滚动位置。
      const resetView = (): void => {
        toGridLayout();
        grid.scrollTop = 0;
        applyCollapse();
      };
      resetView();
      window.requestAnimationFrame(resetView);
    }
    word.classList.toggle('is-hidden', !daily);
    word.setAttribute('aria-hidden', daily ? 'false' : 'true');
    root.classList.toggle('is-hidden', !daily);
    root.setAttribute('aria-hidden', daily ? 'false' : 'true');
    if (!daily) {
      stop();
      stopRotate();
      return;
    }
    // 已经有内容就不再重拉：重拉会重建卡片，等于把卡片的进场动画再播一遍。
    if (tracks.length === 0) void loadOnce();
    measureBand();
    applyCollapse();
    replay();
    // 每次切回今日推荐：大封面从左侧划入、右侧卡片随机错帧做「叶片转入 + 闪三次」。
    enterHero();
    // 进来就播封面带入场（只播这一遍）；卡片若还没数据，交给首次 render 逐张进场。
    playBandEnter();
    bandEnterPending = false;
    if (tracks.length > 0) replayCards();
    else cardsEntering = true;
    if (!currentKey) startRotate();
  };

  /* 原路返回：进来时大封面从左侧划入、卡片逐张叶片转进来、竖条从封面侧展开、
     四字与封面带浮现；离开就把这几样照反着的时序退回去，退完再彻底藏掉。 */
  let leaving = false;
  let leaveTimer = 0;

  const leave = (after?: () => void): void => {
    if (leaving) return;
    leaving = true;
    window.clearTimeout(flashTimer);
    flashedCard?.classList.remove('is-flash');
    flashedCard = null;
    cancelFlip();
    window.clearTimeout(bandEnterTimer);
    root.classList.remove('is-entering');
    bandEntered = false;
    bandEnterPending = false;
    stop();
    stopRotate();
    window.clearTimeout(leaveTimer);
    // 卡片按进来的逆序退（后进来的先退）。
    const total = cardNodes.length;
    cardNodes.forEach((node, index) => {
      const back = Math.min(150, (total - 1 - index) * 6);
      node.style.setProperty('--fx-card-out-delay', `${back}ms`);
      node.classList.add('is-leaving');
    });
    root.classList.add('is-leaving');
    // 退场要把最后一张卡片的错帧也等完，否则会被 is-hidden 硬切。
    const tail = Math.min(150, Math.max(0, (cardNodes.length - 1) * 6));
    leaveTimer = window.setTimeout(() => {
      root.classList.remove('is-leaving');
      for (const node of cardNodes) {
        node.classList.remove('is-leaving');
        node.style.removeProperty('--fx-card-out-delay');
      }
      heroCard.classList.remove('is-on');
      heroShell.classList.remove('is-entering');
      word.classList.add('is-hidden');
      word.setAttribute('aria-hidden', 'true');
      root.classList.add('is-hidden');
      root.setAttribute('aria-hidden', 'true');
      leaving = false;
      after?.();
    }, FX_LEAVE_MS + tail);
  };

  /**
   * idleRotate = 当前没有在播放：封面带继续按歌单轮换，只把「正在播的那首」高亮出来。
   * 传 false（正在播放）时行为和以前一样——钉住这首歌的封面、停掉轮换。
   */
  let syncedList: OnlineTrack[] | undefined;
  let syncedPlayerKey: string | undefined;
  const syncCurrent = (nextTrack: OnlineTrack | null, idleRotate = false): void => {
    const playerKey = nextTrack ? trackKey(nextTrack) : '';
    const paused = Boolean(nextTrack) && idleRotate;
    if (syncedList === tracks && syncedPlayerKey === playerKey && paused === idleRotating) return;
    syncedList = tracks;
    syncedPlayerKey = playerKey;
    idleRotating = paused;
    const index = nextTrack ? tracks.findIndex(item => trackKey(item) === playerKey) : -1;
    const member = tracks[index];
    const key = member ? playerKey : '';
    if (key !== currentKey) deps.onTrackChange?.(key);
    currentKey = key;
    coverLyrics.setTrack(member ?? null);
    heroCard.classList.toggle('is-on', Boolean(member));
    if (member) {
      stopRotate();
      if (heroIndex !== index) {
        const list = grid.classList.contains('is-list');
        const before = list ? undefined : captureRects();
        heroIndex = index;
        if (list) syncHeroCover();
        else render({ flipFrom: before });
      }
      paintCover(onlineArtwork(member, 900));
      rotateIndex = index + 1;
    }
    for (const card of cardNodes) card.classList.toggle('is-on', Boolean(member) && card.dataset.key === key);
    if ((!member || paused) && tracks.length > 1) startRotate();
  };

  const reload = (): void => {
    if (loading) return;
    tracks = [];
    cardNodes.length = 0;
    void loadOnce();
  };

  // 大封面要一直跟着「真正在播的那首」：以前只有进页那一刻同步，
  // 播到下一首时封面歌词还停在上一次进页的歌上（歌名条已经换了、歌词没换）。
  const offPlayer = onPlayer(() => {
    if (disposed) return;
    heroCard.classList.toggle('is-lyric-playing', playerState().playing);
    syncCurrent(playerState().track, !playerState().playing);
  });

  return {
    root,
    setWord: (text: string): void => {
      const next = (text || FX_DAILY_TEXT).slice(0, 4).padEnd(4, "　");
      if (next === wordText) return;
      wordText = next;
      settle();
    },
    setLoader: (fn: () => Promise<OnlineTrack[]>): void => {
      loadTracks = fn;
      tracks = [];
      cardNodes.length = 0;
      if (!root.classList.contains("is-hidden")) void loadOnce();
    },
    show,
    leave,
    hide,
    replay,
    reload,
    syncCurrent,
    cards: () => cardNodes.slice(),
    dispose: () => {
      window.removeEventListener('resize', onResize);
      grid.removeEventListener('scroll', onScroll);
      disposed = true;
      offPlayer();
      stop();
      stopRotate();
      coverLyrics.dispose();
    },
  };
}
