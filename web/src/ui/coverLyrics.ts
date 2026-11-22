/**
 * 大封面上的歌词（今日推荐 / 私人雷达等 FX 页左侧那张封面）。
 *
 * 交互：点右侧卡片或封面本身开始播放后，封面里就跟着唱——
 * 只露三句：上一句（已经唱完，缩小退后）、正在唱的（放大 + 白色辉光）、下一句（等着唱，略小略淡）。
 * 换行时三句**真的往上滚一格**：正在唱那句缩到上面位置、下一句长大顶到中间、最下面淡入新的一句，
 * 元素之间是相互挤压着让位的（不是原地换字）。
 *
 * 动效做法（FLIP）：先在旧状态量每句的位置/字号/透明度，改完文本与字号后再量一次，
 * 然后用 WAAPI 把 transform 从「旧位置」放回 none —— 位移与缩放全在合成层上跑，
 * 不逐帧改字号（逐帧改字号会触发布局，实测每帧 10ms+，就是「很卡」的来源）。
 * 落定那一帧 transform 回到 none，文字回到按设备像素排版的自然状态，不糊（见 docs §9.6）。
 */

import type { OnlineTrack } from '../online/types';
import { loadLyricDoc, type LyricLine } from './lyrics';
import { previewPositionMs } from './player';
import { prefersReducedMotion } from './motion';

/** 换句的缓动：比 MOTION.ease 更「软」——起步不急、收尾慢慢贴住，滚轮看起来像被推着走。 */
const ROLL_EASE = 'cubic-bezier(.33, .02, .2, 1)';

/** 换句动画时长（位移 + 缩放一起跑）。 */
const ROLL_MS = 800;

/** 一句歌词在某一刻的几何：位置 + 字号 + 不透明度。 */
interface RowGeom {
  left: number;
  /** 行盒竖直中心：位移必须按「中心」算——按 top 算会差半个高度差，缩小时就会在原来那一句的顶部缩。 */
  centerY: number;
  size: number;
  opacity: number;
}

/** 就三句：上一句 / 正在唱 / 下一句。 */

/** 三格的字号倍率与不透明度：0 = 上一句，1 = 正在唱，2 = 下一句。 */
const SIZES = [0.92, 2.05, 0.98] as const;
const OPACITY = [0.52, 1, 0.48] as const;


/** 当前行的白色辉光：白色为主，外圈再散一层，暗封面上也压得住。 */
export const COVER_LYRIC_GLOW =
  '0 0 12px rgb(255 255 255 / 0.95), 0 0 34px rgb(255 255 255 / 0.5), 0 2px 12px rgb(0 0 0 / 0.55)';

function keyOf(track: OnlineTrack | null | undefined): string {
  return track ? `${track.source}:${track.id}` : '';
}

export class CoverLyrics {
  private readonly host: HTMLElement;
  private readonly root: HTMLElement;
  private readonly backdrops = new Map<number, HTMLElement>();
  private readonly head: HTMLElement;
  private readonly headTitle: HTMLElement;
  private readonly headArtist: HTMLElement;
  /** 三句各自的节点：节点跟着「句子」走（不是跟着格子走），所以换行时同一句能真的移动。 */
  private readonly nodes = new Map<number, HTMLElement>();
  /** 正在唱那一句的节点（扫光要写它）。 */
  private activeSlot: HTMLElement | null = null;
  /** 三句所在的滑动栈：整摞一起上移一格，换句的连续性由它承担。 */
  private readonly stack: HTMLElement;
  /** 每个节点正在跑的动画（同一节点不许两套，重排前先收掉）。 */
  private readonly rollAnims = new Map<HTMLElement, Animation>();

  private lines: LyricLine[] = [];
  private activeIndex = -1;
  private request = 0;
  private frame = 0;
  private trackKey = '';
  /** 取词状态：失败/空结果要允许重试（启动瞬间「在线源尚未就绪」很常见）。 */
  private lyricLoading = false;
  private lyricTriedAt = 0;
  /** 当前行的填充进度（0–100）与它拆出来的词、总字数。 */
  private fillPct = -1;
  private fillLine: { timeMs: number; durationMs: number } | null = null;

  private disposed = false;

  /**
   * 基准字号：和 CSS 的 `clamp(15px, 1.15vw, 28px)` 同一套算法，直接算出来。
   * 不能靠 getComputedStyle 量——动画进行中量到的是插值（会把倍率乘两次，字越放越大）。
   */
  private baseFontSize(): number {
    return Math.min(30, Math.max(16, 0.0125 * window.innerWidth));
  }

  /** 窗口尺寸变了：基准字号跟着变，按新基准重画一遍（不放动画）。 */
  private readonly onResize = (): void => {
    if (!this.disposed) this.paint(false);
  };

  constructor(host: HTMLElement) {
    this.host = host;
    this.root = document.createElement('div');
    this.root.className = 'fx-hero-lyrics';
    // 左上角先摆歌名与歌手（参考 Apple Music 的封面歌词版式），歌词紧跟着往下排。
    this.head = document.createElement('div');
    this.head.className = 'fx-hero-lyric-head';
    this.headTitle = document.createElement('div');
    this.headTitle.className = 'fx-hero-lyric-name';
    this.headArtist = document.createElement('div');
    this.headArtist.className = 'fx-hero-lyric-artist';
    this.head.append(this.headTitle, this.headArtist);
    this.root.append(this.head);
    this.stack = document.createElement('div');
    this.stack.className = 'fx-hero-lyric-stack';
    this.root.append(this.stack);
    host.append(this.root);
    window.addEventListener('resize', this.onResize, { passive: true });
  }

  /** 由调用方在同步当前曲目时驱动（null = 没在播，回到纯封面）。 */
  setTrack(track: OnlineTrack | null): void {
    if (this.disposed) return;
    const key = keyOf(track);
    if (key === this.trackKey) {
      // 同一首歌：上次取词失败（例如刚启动时「在线源尚未就绪」）就隔一会儿再试，
      // 否则这首歌会一直空着——封面里没词，用户只会觉得「歌词没了」。
      if (track && this.lines.length === 0 && !this.lyricLoading && Date.now() - this.lyricTriedAt > 4000) {
        this.loadLyrics(track);
      }
      this.start();
      return;
    }
    this.trackKey = key;
    this.stop();
    this.activeIndex = -1;
    if (!track) {
      this.lines = [];
      this.request += 1;
      this.host.classList.remove('is-lyrics');
      this.paint(false);
      return;
    }
    this.host.classList.add('is-lyrics');
    this.headTitle.textContent = track.title;
    this.headArtist.textContent = track.artist;
    this.loadLyrics(track);
  }

  /** 取这一首的歌词（带代次守卫；失败留给 setTrack 的退避重试）。 */
  private loadLyrics(track: OnlineTrack): void {
    const tag = ++this.request;
    const wanted = this.trackKey;
    this.lyricLoading = true;
    this.lyricTriedAt = Date.now();
    void loadLyricDoc(track)
      .then((doc) => {
        if (this.disposed || tag !== this.request || this.trackKey !== wanted) return;
        this.lyricLoading = false;
        this.lines = doc.lines;
        this.activeIndex = -1;
        this.paint(false);
        this.start();
      })
      .catch((err: unknown) => {
        if (this.disposed || tag !== this.request) return;
        this.lyricLoading = false;
        console.warn('[coverLyrics] lyric failed', wanted, err);
        this.lines = [];
        this.activeIndex = -1;
        this.paint(false);
      });
  }

  /** 逐帧对齐：只在「行变了」的时候重排，稳定时几乎不花时间。 */
  private readonly tick = (): void => {
    this.frame = 0;
    if (this.disposed) return;
    const position = previewPositionMs();
    if (this.lines.length > 0) {
      // 暂停也留住这一句：Apple Music 暂停时歌词不会消失。
      const index = this.lines.length > 0 ? this.lineAt(position) : -1;
      if (index !== this.activeIndex) {
        this.activeIndex = index;
        this.paint(true);
      }
      this.syncFill(position);
    }
    this.frame = window.requestAnimationFrame(this.tick);
  };

  private start(): void {
    if (this.disposed || this.frame !== 0 || this.lines.length === 0) return;
    this.frame = window.requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.frame !== 0) {
      window.cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  private lineAt(positionMs: number): number {
    const lines = this.lines;
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if ((lines[mid]?.timeMs ?? 0) <= positionMs) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found;
  }

  /**
   * 逐句扫光：像 Apple Music 那样从左到右把这一句「染白」。
   *
   * 实现是整个词行铺一层横向渐变（`background-clip: text`），只用 `--fx-lyric-fill`
   * 这个百分比控制分界点；每帧只改这一个自定义属性，而且变化不到 0.4% 就不写，
   * 再交给 CSS 的 `transition: --fx-lyric-fill 120ms linear` 抹平——不碰布局、不动字号。
   * 分界点按整句时间线性推进（Apple Music 那种一条扫光），不按字/词切段——
   * 中文 QRC 里「词」常常就是单字，按词推进看起来会是一格一格点亮。
   */
  private syncFill(positionMs: number): void {
    const slot = this.activeSlot;
    if (!slot || this.activeIndex < 0) return;
    const line = this.fillLine;
    if (!line) return;
    // 按整句时间推进：分界点只跟「这句唱到哪儿」有关，不按字/词切段。
    // 之前按词累加字符宽度，中文 QRC 里词=单字，边界一格格跳，看起来就是「逐字点亮」；
    // 用户要的是 Apple Music 那种从左到右连续扫光，所以这里改成整句线性推进。
    const total = Math.max(1, line.durationMs);
    const pct = Math.max(0, Math.min(100, ((positionMs - line.timeMs) / total) * 100));
    if (pct === this.fillPct) return;
    this.fillPct = pct;
    // 按行分摊：第一段亮完才轮到第二段，读起来是「顺着念下去」，而不是两行一起亮。
    const rows = Array.from(slot.querySelectorAll<HTMLElement>('.fx-hero-lyric-row'));
    if (rows.length === 0) {
      slot.style.setProperty('--fx-lyric-fill', `${pct.toFixed(1)}%`);
    } else {
      const total = rows.reduce((sum, row) => sum + (row.dataset.text ?? '').length, 0) || 1;
      let passed = 0;
      for (const row of rows) {
        const share = Math.max(1e-6, (row.dataset.text ?? '').length / total);
        const local = Math.max(0, Math.min(100, ((pct / 100 - passed) / share) * 100));
        passed += share;
        row.style.setProperty('--fx-lyric-fill', `${local.toFixed(3)}%`);
      }
    }
    // 播放期间白色辉光恒亮（用户要「发光是持续的」）：
    // 只在离场那 320ms 由 .is-past 把覆层 opacity 过渡到 0。
    slot.style.setProperty('--fx-lyric-glow', '1');
  }

  /**
   * 当前行的字号：短句按标准大小，长句收字号——但**只允许一行**。
   *
   * 为什么不让它折行：扫光是「同一个横向分界点从左推到右」，一句一旦折成两三行，
   * 这个分界点会同时落在每一行上，后面的行要么提前亮、要么（覆层不折行时）永远点不亮。
   * 所以这里把长句一路收到能放下为止（最低 base * 0.55），宁可字小一点也不折行。
   */
  private planSize(text: string, wanted: number): number {
    const base = this.baseFontSize();
    const width = this.root.clientWidth || 0;
    if (width <= 0 || text.length === 0) return wanted;
    const avail = width * 0.76; // 左右各留 12% 内边距
    // 全角字（中日文、全角标点）就是 1em 宽，之前按 0.62 估会严重低估 →
    // 字号留得太大，nowrap 之后句子直接冲出封面右缘被裁掉。
    const units = Array.from(text).reduce((sum, ch) => sum + (/[　-鿿＀-￯]/.test(ch) ? 1 : 0.55), 0);
    if (units <= 0) return wanted;
    const oneLine = avail / units;
    if (wanted <= oneLine) return wanted; // 一行放得下：不折、不收
    // 一行放不下就折两行（上限两行）：字号不再一路压到 0.55，长句读得清。
    const twoLine = (avail * 2) / units;
    return Math.max(base * 0.78, Math.min(wanted, twoLine));
  }

  /**
   * 当前行排版：把一句话切成 1–2 段（`.fx-hero-lyric-row`），每段自己接一条横向扫光。
   *
   * 为什么要分段：扫光是「一个横向分界点从左推到右」。如果整句折行后还是一条分界点，
   * 它会同时落在每一行上——后面的行要么提前亮、要么点不亮。切成独立两段后，
   * 第一段亮完再亮第二段，读起来就是一句话顺着念下去。
   * 两段还放不下就把字号按比例收一档，最多三轮。
   */
  private layoutRows(node: HTMLElement, text: string, size: number): void {
    const avail = Math.max(48, this.stack.clientWidth);
    const chars = Array.from(text);
    const canvas = (this.measureCtx ??= document.createElement('canvas').getContext('2d'));
    const widthOf = (fs: number, part: string): number => {
      if (!canvas) return part.length * fs;
      const style = window.getComputedStyle(node);
      canvas.font = `${style.fontWeight} ${fs}px ${style.fontFamily}`;
      return canvas.measureText(part).width;
    };
    /**
     * 挑断点：不按「填满第一行」硬切（会把英文单词劈成 den / y，最后一行只剩一个字母），
     * 而是找「两行宽度最接近」的位置；英文优先断在空格处。
     */
    const splitAt = (fs: number): number => {
      const total = widthOf(fs, text);
      if (total <= avail) return chars.length;
      let best = Math.ceil(chars.length / 2);
      let bestDiff = Number.POSITIVE_INFINITY;
      for (let i = 1; i < chars.length; i += 1) {
        const head = chars.slice(0, i).join('');
        const tail = chars.slice(i).join('');
        const wh = widthOf(fs, head);
        const wt = widthOf(fs, tail);
        if (/^[A-Za-z0-9]$/.test(chars[i - 1]!) && /^[A-Za-z0-9]$/.test(chars[i]!) && /\s/.test(text)) continue;
        const spaceBonus = chars[i - 1] === ' ' || chars[i] === ' ' ? 0 : 6;
        const diff = Math.max(0, wh - avail, wt - avail) * 4 + Math.abs(wh - wt) + spaceBonus;
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      }
      return best;
    };
    const build = (fs: number): HTMLElement[] => {
      node.style.fontSize = `${fs.toFixed(2)}px`;
      node.replaceChildren();
      const cut = splitAt(fs);
      const parts = cut >= chars.length ? [text] : [chars.slice(0, cut).join('').trimEnd(), chars.slice(cut).join('').trimStart()];
      const rows: HTMLElement[] = [];
      for (const part of parts.filter((item) => item.length > 0)) {
        const row = document.createElement('span');
        row.className = 'fx-hero-lyric-row';
        row.textContent = part;
        row.dataset.text = part;
        const glow = document.createElement('span');
        glow.className = 'fx-hero-lyric-glow';
        glow.setAttribute('aria-hidden', 'true');
        glow.dataset.text = part;
        row.append(glow);
        node.append(row);
        rows.push(row);
      }
      return rows;
    };
    let rows = build(size);
    let fs = size;
    const floor = this.baseFontSize() * 0.5;
    for (let round = 0; round < 3; round += 1) {
      const worst = rows.reduce((max, row) => Math.max(max, row.scrollWidth), 0);
      if (worst <= avail + 0.5 || fs <= floor) break;
      fs = Math.max(floor, (fs * avail * 0.985) / Math.max(1, worst));
      rows = build(fs);
    }
    for (const row of rows) row.style.setProperty('--fx-lyric-fill', '0%');
  }

  /** 量文字宽度用的离屏 canvas（只用来挑断点，不进 DOM）。 */
  private measureCtx: CanvasRenderingContext2D | null = null;

  /** 离场那句的「白色收尾」定时器：同一节点只留一个。 */
  private readonly pastTimers = new Map<HTMLElement, number>();

  /** 白色收尾：320ms 后把 .is-active / .is-past 一起摘掉，落成「已播放」的样子。 */
  private schedulePast(node: HTMLElement): void {
    const running = this.pastTimers.get(node);
    if (running !== undefined) window.clearTimeout(running);
    const timer = window.setTimeout(() => {
      this.pastTimers.delete(node);
      node.classList.remove('is-active', 'is-past');
      // 分段留着（长句的断行位置不能变），只把行内发光变量归零。
      node.style.setProperty('--fx-lyric-glow', '0');
    }, 360);
    this.pastTimers.set(node, timer);
  }

  /** 这句又变成正在唱的了：撤掉收尾状态。 */
  private clearPast(node: HTMLElement): void {
    const running = this.pastTimers.get(node);
    if (running !== undefined) {
      window.clearTimeout(running);
      this.pastTimers.delete(node);
    }
    node.classList.remove('is-past');
  }

  private cancelRoll(slot: HTMLElement): void {
    const running = this.rollAnims.get(slot);
    if (!running) return;
    this.rollAnims.delete(slot);
    running.cancel();
  }

  /**
   * 只画三句：上一句 / 正在唱 / 下一句。
   *
   * 关键：节点绑「句子」而不是绑「格子」。换行时——
   *  · 原来在下面那句（下一句）的节点 → 变成当前句，从下往上、由小放大顶到中间；
   *  · 原来在中间那句的节点 → 变成上一句，向上缩走；
   *  · 再补一个新节点到最下面淡入。
   * 所以看到的是同一句在动（下句放大上去），不是三格里原地换字。
   */
  private paint(animate: boolean): void {
    const active = this.activeIndex;
    const before = new Map<HTMLElement, RowGeom>();
    if (animate) for (const node of this.nodes.values()) before.set(node, this.geomOf(node, true));

    const wanted = active < 0 ? [] : [active - 1, active, active + 1].filter((i) => i >= 0 && i < this.lines.length);

    // 窗口外的节点摘掉（它们本来就在三句之外，看不见）。
    for (const [index, node] of [...this.nodes]) {
      if (wanted.includes(index)) continue;
      this.cancelRoll(node);
      this.clearPast(node);
      this.backdrops.get(index)?.remove();
      this.backdrops.delete(index);
      node.remove();
      this.nodes.delete(index);
    }

    let cursor: ChildNode | null = this.stack.firstChild;
    for (const index of wanted) {
      const line = this.lines[index]!;
      const text = line.text.trim() || '·';
      const position = index - active + 1; // 0 = 上一句，1 = 正在唱，2 = 下一句
      let node = this.nodes.get(index);
      if (!node) {
        node = document.createElement('div');
        node.className = 'fx-hero-lyric';
        node.style.opacity = '0';
        this.nodes.set(index, node);
        const backdrop = document.createElement('div');
        backdrop.setAttribute('aria-hidden', 'true');
        this.root.prepend(backdrop);
        this.backdrops.set(index, backdrop);
      }
      if (node !== cursor) this.stack.insertBefore(node, cursor);
      cursor = node.nextSibling;

      const scale = SIZES[position] ?? 1;
      const restOpacity = OPACITY[position] ?? 0.4;
      const isActive = position === 1;
      node.dataset.text = text;
      node.classList.toggle('is-retired', position === 0);
      if (!isActive && node.classList.contains('is-active')) {
        // 刚要变成「上一句」：先把白色收掉（加 .is-past 走 320ms 淡出），
        // 320ms 后才摘 .is-active —— 否则唱完那一帧白字直接被换成灰字，硬跳。
        node.classList.add('is-past');
        this.schedulePast(node);
      }
      if (isActive) {
        this.clearPast(node);
        node.classList.add('is-active');
      } else if (!node.classList.contains('is-past')) {
        node.classList.remove('is-active');
      }
      const base = this.baseFontSize();
      const layoutKey = JSON.stringify([text, line.translation, this.stack.clientWidth, base]);
      if (node.dataset.layoutKey !== layoutKey) {
        node.style.fontWeight = '800';
        this.layoutRows(node, text, this.planSize(text, base * SIZES[1]));
        node.dataset.activeSize = node.style.fontSize;
        node.dataset.layoutKey = layoutKey;
        const translation = line.translation.trim();
        if (translation) {
          const span = document.createElement('span');
          span.className = 'fx-hero-lyric-trans';
          span.textContent = translation;
          node.append(span);
        }
      }
      node.style.fontSize = isActive ? node.dataset.activeSize! : `${Math.min(base * scale, parseFloat(node.dataset.activeSize!))}px`;

      if (isActive) {
        this.activeSlot = node;
        this.fillLine = { timeMs: line.timeMs, durationMs: line.durationMs };
        this.fillPct = -1;
        const prevTransition = node.style.transition;
        node.style.transition = 'none';
        node.style.setProperty('--fx-lyric-fill', '0%');
        for (const row of Array.from(node.querySelectorAll<HTMLElement>('.fx-hero-lyric-row'))) {
          row.style.setProperty('--fx-lyric-fill', '0%');
        }
        node.style.setProperty('--fx-lyric-glow', '1');
        void node.offsetWidth;
        node.style.transition = prevTransition;
      }
      if (!animate) {
        this.cancelRoll(node);
        node.style.opacity = String(restOpacity);
        continue;
      }
    }
    for (const index of wanted) {
      const node = this.nodes.get(index)!;
      const backdrop = this.backdrops.get(index)!;
      const rows = Array.from(node.children) as HTMLElement[];
      while (backdrop.childElementCount > rows.length) backdrop.lastElementChild?.remove();
      rows.forEach((row, i) => {
        let strip = backdrop.children[i] as HTMLElement | undefined;
        if (!strip) {
          strip = document.createElement('div');
          strip.className = 'fx-hero-lyric-backdrop';
          backdrop.append(strip);
        }
        strip.style.left = `${this.stack.offsetLeft + node.offsetLeft + row.offsetLeft - 12}px`;
        strip.style.top = `${this.stack.offsetTop + node.offsetTop + row.offsetTop - 6}px`;
        strip.style.width = `${row.offsetWidth + 24}px`;
        strip.style.height = `${row.offsetHeight + 12}px`;
        strip.classList.toggle('is-current', index === active);
      });
    }
    if (animate) for (const index of wanted) {
      const node = this.nodes.get(index)!;
      const restOpacity = OPACITY[index - active + 1] ?? 0.4;
      const prev = before.get(node);
      if (prev) this.roll(node, prev, restOpacity);
      else this.enter(node, restOpacity);
    }
    if (active < 0) this.activeSlot = null;
  }

  /** 一句歌词在某一刻的几何（FLIP 的「前一帧」）。 */
  private geomOf(node: HTMLElement, visual = false): RowGeom {
    // 必须用布局坐标（offsetTop/offsetHeight），不能用 getBoundingClientRect——
    // 后者会把「上一段还没播完的 WAAPI transform」算进去，量到的不是真实落位，
    // 于是下一段 FLIP 的起点偏小，缩小时看着像在顶部原地缩。
    const style = window.getComputedStyle(node);
    const matrix = visual && style.transform !== 'none' ? new DOMMatrixReadOnly(style.transform) : new DOMMatrixReadOnly();
    return {
      left: node.offsetLeft,
      centerY: node.offsetTop + node.offsetHeight / 2 + matrix.m42,
      size: (Number.parseFloat(style.fontSize) || this.baseFontSize()) * matrix.a,
      opacity: Number.parseFloat(style.opacity),
    };
  }

  /** 同一句从「旧位置 + 旧字号」放回自然状态：下句放大上去、上句缩小让位。 */
  private roll(node: HTMLElement, before: RowGeom, opacityTo: number): void {
    this.cancelRoll(node);
    const after = this.geomOf(node);
    const raw = before.size > 0.01 && after.size > 0.01 ? before.size / after.size : 1;
    // 只在「同一列」内做纵向位移：横向一律不挪（会看着飘）。
    // 缩放要双向都留着——下一句放大上来是 raw<1（0.55→1），
    // 唱完那句缩小退上去是 raw>1（1.5→1）。之前把它夹到 1 以内，
    // 结果是「放大有动画、缩小瞬间跳小」，出入不对称。
    const scale = Math.min(2.4, Math.max(0.55, raw));
    const dx = 0;
    // 只按中心对齐：缩放以 left center 为原点，中心不动，所以中心对上就正好落回原来那一句的位置。
    // 夹取值按整摞高度给（不再按单行高），否则「缩到上面」这段位移会被截短、看着像在原地缩。
    const limit = Math.max(120, this.stack.clientHeight * 1.2);
    const dy = Math.min(limit, Math.max(-limit, before.centerY - after.centerY));
    const moved = Math.abs(dx) > 0.4 || Math.abs(dy) > 0.4 || Math.abs(scale - 1) > 0.004;
    if (prefersReducedMotion() || !moved) {
      node.style.opacity = String(opacityTo);
      return;
    }
    node.style.opacity = String(opacityTo);
    const anim = node.animate(
      [
        { transform: `translate3d(${dx}px, ${dy}px, 0) scale(${scale})`, opacity: before.opacity },
        { transform: 'translate3d(0, 0, 0) scale(1)', opacity: opacityTo },
      ],
      // fill: 'backwards' 很关键：改完文本那一帧元素已经站到新位置了，
      // 若用 'none'，动画要到下一帧才生效，中间会漏出一帧「先跳过去再开始动」。
      // 用 backwards 让首帧（旧位置）立刻生效，视觉上一直是连续的。
      { duration: ROLL_MS, easing: 'cubic-bezier(.23,.52,.22,1)', fill: 'both' },
    );
    this.rollAnims.set(node, anim);
    const done = (): void => {
      if (this.rollAnims.get(node) !== anim) return;
      this.rollAnims.delete(node);
      anim.cancel();
    };
    anim.addEventListener('finish', done);
    anim.addEventListener('cancel', () => {
      if (this.rollAnims.get(node) === anim) this.rollAnims.delete(node);
    });
  }

  /** 新出现的一句：从下方一点滑上来并淡入。 */
  private enter(node: HTMLElement, opacityTo: number): void {
    this.cancelRoll(node);
    if (prefersReducedMotion()) {
      node.style.opacity = String(opacityTo);
      return;
    }
    const rise = Math.max(10, this.baseFontSize() * 0.45);
    node.style.opacity = String(opacityTo);
    const anim = node.animate(
      [
        { transform: `translate3d(0, ${rise.toFixed(1)}px, 0) scale(1)`, opacity: 0 },
        { transform: 'translate3d(0, 0, 0) scale(1)', opacity: opacityTo },
      ],
      // fill: 'backwards' 很关键：改完文本那一帧元素已经站到新位置了，
      // 若用 'none'，动画要到下一帧才生效，中间会漏出一帧「先跳过去再开始动」。
      // 用 backwards 让首帧（旧位置）立刻生效，视觉上一直是连续的。
      { duration: ROLL_MS, easing: ROLL_EASE, fill: 'both' },
    );
    this.rollAnims.set(node, anim);
    const done = (): void => {
      if (this.rollAnims.get(node) !== anim) return;
      this.rollAnims.delete(node);
      anim.cancel();
    };
    anim.addEventListener('finish', done);
    anim.addEventListener('cancel', () => {
      if (this.rollAnims.get(node) === anim) this.rollAnims.delete(node);
    });
  }

  dispose(): void {
    for (const timer of this.pastTimers.values()) window.clearTimeout(timer);
    this.pastTimers.clear();
    for (const anim of this.rollAnims.values()) anim.cancel();
    this.rollAnims.clear();
    this.disposed = true;
    this.request += 1;
    this.stop();
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
  }
}
