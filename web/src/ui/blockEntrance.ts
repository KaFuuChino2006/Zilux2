/**
 * 逐块运动引擎：入场 / 出场 / 打断 三件套，给首页、海报墙、发现页、动态壁纸页共用。
 *
 * 核心行为：每一块内容（卡片 / 行 / 封面 / 区块标题）自己挑一款变体、自己的随机时间出发，
 * 不做「整屏一起出现」；出场用同一款的反向关键帧，沿原轨迹倒着退回去；
 * 打新一段之前先把上一段的类摘干净并强制回流，避免「点了没反应 / 只播半截」。
 *
 * 样式在 `styles/app.css` §9：`is-block-in` / `is-block-out` / `is-block-settled` + `block-in-*` / `block-out-*` 关键帧。
 * 入场跑完切到 `is-block-settled`（而不是摘干净）：保住合成层，收尾那一下不会整页重栅格化。
 */

import { MOTION, prefersReducedMotion } from './motion';
import { TitleEntrance } from './titleEntrance';

/**
 * 卡片 / 行的入场变体池（都在 app.css 里成对定义 in + out）：
 * 左右叶片翻转、上浮、下落、左右滑入、放大、倾斜、仰翻、起雾、侧摆。
 * 随机挑，相邻两块不重样 —— 同一款连着出会看成「没变化」。
 */
export const ITEM_VARIANTS = [
  'leaf-left',
  'leaf-right',
  'rise',
  'drop',
  'slide-left',
  'slide-right',
  'zoom',
  'tilt',
  'flip-x',
  'soft',
  'swing',
] as const;
/** 标题只走轻量款：一行字翻 58° 会糊成一团。 */
export const HEAD_VARIANTS = ['rise', 'drop', 'slide-left', 'slide-right', 'haze', 'soft'] as const;

/** 每个目标的随机延迟窗口：真正的随机，不是按序号排队。 */
const ENTER_JITTER = 420;
/** 区块之间只留一点点先后感，剩下的交给随机。 */
const SECTION_BIAS = 55;
/** 区块偏置的上限：后面的区块别被推得太远。 */
const SECTION_BIAS_MAX = 220;
/** 总延迟上限：排在后面的内容不再等，跟上前面的队伍一起落定。 */
const ENTER_MAX_DELAY = 660;
/** 标题的随机窗口更窄：标题先落定，后面的卡片再散开。 */
const HEAD_JITTER = 150;
/** 出场错帧：比入场快，整体像一叠牌从尾部往回收到位。 */
const LEAVE_STEP = 14;
const LEAVE_MAX_DELAY = 180;
/** 一次最多动多少块：海报墙动辄几百张，超出的直接铺好，别拿它拖帧。 */
const MAX_TARGETS = 260;
/** 这些容器只是把区块包了一层，分组时要拆开，否则整页只有一次偏置。 */
const GROUP_WRAPPERS = '.playlists-page';

const IN_CLASS = 'is-block-in';
/**
 * 落定：**换类、但不撤层**（2026-11-24 第三版口径）。
 *
 * 入场跑完那一帧把 `is-block-in` 换成 `is-block-settled`（只挂 `will-change: transform`，
 * 不写 `transform`，免得压掉卡片自己的 hover 变换），元素从「合成的动画态」平滑变成
 * 「静态但仍在合成层」——属性和几何都没变，所以这一下没有任何像素变化。
 *
 * 为什么不撤层：撤层那一帧，整批元素会一起从「合成层栅格」换回「主线程栅格」，
 * 位置从分数吸附到设备像素（实测各块 0.1~0.8px）、文字从灰阶 AA 换成 LCD 次像素，
 * 整页看起来就是「像素抖一下」——维护者 2026-11-24 报的原话：「动画进入完毕后会有位移的感觉，
 * 就是那种像素的变化一样」。实测撤层那一帧整页 diff 88462 px，留层则连续帧 diff = 0。
 *
 * 层什么时候撤：跟着类一起在 `resetMotion()`（换页 / 重播 / 销毁）里撤，那时正在演离场
 * 或页面已经藏起来，没人看得见。历史「留层会糊」的结论属于 3D / filter 时代，见 app.css §9 的注释。
 */
const SETTLE_CLASS = 'is-block-settled';
const OUT_CLASS = 'is-block-out';
const ENTER_DELAY_VAR = '--block-enter-delay';
const LEAVE_DELAY_VAR = '--block-leave-delay';
const IN_ANIM_VAR = '--block-in-anim';
const OUT_ANIM_VAR = '--block-out-anim';

/** 一条入场指令：哪块、是不是标题、挑中哪款、什么时候起步。 */
type EnterTarget = { el: HTMLElement; head: boolean; variant: string; delay: number };
type Target = { el: HTMLElement; head: boolean };

export interface BlockEntranceOptions {
  /** 逐块目标选择器（标题除外），逗号分隔。 */
  items: string;
  /** 区块标题选择器：只走轻量款变体。 */
  heads?: string;
  /**
   * 页面大字标题选择器（`.wall-title` 这类）：命中时不只是容器淡入，
   * 里面的字再走一遍逐字上浮显影（`TitleEntrance`），容器只做一层淡入。
   */
  titles?: string;
  /**
   * 判断这一层此刻是否露着；不传就用 `root.parentElement`。
   * 隐藏态播入场等于没播，所以要能问出「舞台是不是亮着」。
   */
  host?: () => HTMLElement | null;
}

export class BlockEntrance {
  /** 逐块入场的落定定时器（可能同时有整页一批 + 追加的一批）。 */
  private enterTimers = new Set<number>();
  /** 逐块出场的落定定时器、本次的目标、等待方（被打断也要 resolve，调用方不能一直等）。 */
  private leaveTimer = 0;
  private leaveTargets: HTMLElement[] = [];
  private leaveDone: (() => void) | null = null;
  /** 页面大字标题的逐字动画：一个标题一个实例，重复入场复用（不重建 DOM）。 */
  private titleMotions = new WeakMap<HTMLElement, TitleEntrance>();
  private titleInstances = new Set<TitleEntrance>();
  /** 哪些块里有标题：出场/清场只在这些块上查 DOM，几百张海报不受影响。 */
  private titledTargets = new WeakSet<HTMLElement>();

  constructor(
    private readonly root: HTMLElement,
    private readonly options: BlockEntranceOptions,
  ) {}

  /** 这一层现在是不是露着的（隐藏态播入场等于没播）。 */
  isVisible(): boolean {
    const host = this.options.host ? this.options.host() : this.root.parentElement;
    if (!host) return false;
    return !host.classList.contains('is-hidden') && !this.root.classList.contains('is-hidden');
  }

  /** 内容区现在是不是有块可动的目标。 */
  /**
   * 这一层里有没有「内容块」（卡片 / 行 / 封面），只有标题不算。
   * 页面的「加载中」空壳往往只有一个顶栏：给它播入场，数据回来还要再播一次，
   * 看起来就是「进一次页面动两遍」。所以空壳一律安静铺好，等真实内容回来再演。
   */
  hasTargets(): boolean {
    return this.root.querySelector(this.options.items) !== null;
  }

  /**
   * 收集「各自出发」的目标：按区块分组，组内保持上下顺序。
   * 一张卡 / 一行 / 一个封面 / 一条区块标题都算一个独立目标，
   * 标题单独标记 —— 它只走轻量款变体。
   */
  private groups(): Target[][] {
    const groups: Target[][] = [];
    const selector = this.options.heads
      ? `${this.options.heads}, ${this.options.items}`
      : this.options.items;
    for (const section of Array.from(this.root.children)) {
      if (!(section instanceof HTMLElement)) continue;
      // 「我的歌单」这类页面把所有区块装进一层 wrapper（本地 / 智能 / 在线），
      // 只按宿主的直接子节点分组会把整页压成一整团：所以 wrapper 再拆一层，每块各算一组。
      const blocks =
        section.matches(GROUP_WRAPPERS) && section.children.length > 1
          ? Array.from(section.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
          : [section];
      for (const block of blocks) {
        // 自己命中也算：海报墙的 `.wall-head` 就是宿主直接子节点，
        // 只查后代永远够不到它 —— 顶部大字和它的动作按钮会一直不动。
        const found: HTMLElement[] = [];
        if (block.matches(selector)) found.push(block);
        found.push(...Array.from(block.querySelectorAll<HTMLElement>(selector)));
        const items = found.map((el) => ({
          el,
          head: this.options.heads ? el.matches(this.options.heads) : false,
        }));
        if (items.length > 0) groups.push(items);
      }
    }
    return groups;
  }

  /** 随机挑一款：相邻两块撞款就往下一格挪，避免连续两块看起来一模一样。 */
  private pickVariant(pool: readonly string[], last: string): string {
    const index = Math.floor(Math.random() * pool.length);
    const name = pool[index];
    return name === last ? pool[(index + 1) % pool.length] : name;
  }

  /** 随机延迟：区块之间留一点先后感，块内完全随机，谁先谁后不固定。 */
  private randomDelay(groupIndex: number, head: boolean): number {
    const bias = Math.min(SECTION_BIAS_MAX, groupIndex * SECTION_BIAS);
    const jitter = Math.random() * (head ? HEAD_JITTER : ENTER_JITTER);
    return Math.min(ENTER_MAX_DELAY, Math.round(bias + jitter));
  }

  /** 全页入场：每块自己的变体、自己的时间，逐块散开落定。 */
  play(): void {
    // 正在退场时就 return 会让「内容已经到了」的页面彻底没动画：
    // 「推荐歌单」先铺空壳、旧一屏的出场排队还没走完，接口就把真内容送来了——
    // 那一刻直接跳过，整页就一直是静止的。按打断规矩办：先把旧出场收尾，再发新的。
    // 「加载中」空壳不演：数据回来那次才动，避免一页动两遍。
    if (!this.hasTargets()) return;
    // 上一段出场还没走完就回来了：先把它的等待方放行，再发新的（不排队、不叠加）。
    this.finishLeave();
    const scheduled: EnterTarget[] = [];
    let lastItem = '';
    let lastHead = '';
    this.groups().forEach((group, groupIndex) => {
      for (const { el, head } of group) {
        if (scheduled.length >= MAX_TARGETS) return;
        // 带标题的「顶栏」只做纯淡入：标题自己会逐字显影，容器再翻转/雾化就看不出来了。
        // 注意只认顶栏本身——卡片里嵌着大标题（首页今日推荐 / 我的红心收藏）时，
        // 卡片该翻的还是要翻，否则整页只有里面的字在动、卡片一动不动。
        const titled = this.titleBlock(el);
        // 同一款不连着出：随机池里挪一格，视觉上才有「每块都不一样」。
        const variant = titled
          ? 'fade'
          : head
            ? this.pickVariant(HEAD_VARIANTS, lastHead)
            : this.pickVariant(ITEM_VARIANTS, lastItem);
        if (head) lastHead = variant;
        else lastItem = variant;
        scheduled.push({ el, head, variant, delay: this.randomDelay(groupIndex, head) });
      }
    });
    this.restartEnter(scheduled);
  }

  /** 这一层刚亮出来：收掉可能在跑的出场，再重发一遍入场。 */
  reveal(): void {
    // 中途切回来的情况：出场还挂着就会留一屏透明（看起来像白页），先把收尾做完让内容立起来。
    if (this.leaveDone || this.leaveTargets.length > 0) this.finishLeave();
    // 每次这层亮出来都重发一遍：有缓存时内容是现成的，不等网络回来才播，
    // 也就不会「先正常铺在那、等刷新回来再整体重置一次」。
    this.play();
  }

  /**
   * 局部入场：只让点名的这几块自己重开一遍（列表追加、异步数据补进来）。
   * 不清其他人 —— 已经在播的那一屏继续播，别为了几块把整页重翻。
   */
  playOn(items: HTMLElement[]): void {
    if (prefersReducedMotion()) return;
    const scheduled: EnterTarget[] = [];
    let last = '';
    let lastHead = '';
    items.slice(0, MAX_TARGETS).forEach((el) => {
      const head = this.options.heads ? el.matches(this.options.heads) : false;
      // 局部重播也要遵守同一条规矩：带标题的顶栏只淡入（字自己逐字显影），其余按内容块挑款。
      const variant =
        this.titleBlock(el)
          ? 'fade'
          : head
            ? this.pickVariant(HEAD_VARIANTS, lastHead)
            : this.pickVariant(ITEM_VARIANTS, last);
      if (head) lastHead = variant;
      else last = variant;
      scheduled.push({
        el,
        head,
        variant,
        delay: Math.round(Math.random() * ENTER_JITTER * 0.6),
      });
    });
    if (scheduled.length === 0) return;
    // 只把这几个目标先摘干净再回流，别碰别人的进度。
    for (const { el } of scheduled) this.resetMotion(el);
    void this.root.offsetWidth;
    this.applyEnter(scheduled);
  }

  private restartEnter(scheduled: EnterTarget[]): void {
    if (prefersReducedMotion()) return;
    this.stopEnter();
    // 打断：先把上一轮的类全摘掉并强制回流，再统一挂回去。
    // 同一帧里「摘了又挂」浏览器不认成新动画，会表现为「点了没反应」或者只播半截。
    this.clearMotionClasses();
    if (scheduled.length === 0) return;
    void this.root.offsetWidth;
    this.applyEnter(scheduled);
  }

  /** 挂类 + 记一个落定定时器（到点只摘自己这批的类）。 */
  private applyEnter(scheduled: EnterTarget[]): void {
    let total = 0;
    for (const { el, variant, delay } of scheduled) {
      el.style.setProperty(ENTER_DELAY_VAR, `${delay}ms`);
      el.style.setProperty(IN_ANIM_VAR, `block-in-${variant}`);
      // 入场跑完会摘掉行内变量，出场还得知道这块当初挑的是哪款：
      // 记在 data 上，出场才能沿「它自己那条轨迹」倒着退，而不是全按默认款往一边翻。
      el.dataset.blockVariant = variant;
      el.classList.add(IN_CLASS);
      if (delay > total) total = delay;
    }
    // 标题额外走一遍逐字上浮显影，和它所在的那块同时起步。
    for (const { el, delay } of scheduled) this.playTitle(el, delay);
    const timer = window.setTimeout(() => {
      this.enterTimers.delete(timer);
      for (const { el } of scheduled) {
        // 收尾：所有变体的最后一帧都已经是恒等 2D 变换，所以这里不需要抄矩阵 ——
        // 抄 3D 矩阵再撤回去才是「像素级位移」的来源（3D 表面换回 2D，文字重新 hint）。
        // 挂落定类（只留合成层、不写 transform），之后**不撤层**：撤层那一帧，
        // 整批元素会一起从「合成层栅格」换回「主线程栅格」——位置从分数吸附到设备像素、
        // 文字从灰阶 AA 换成 LCD 次像素，看起来就是整页「像素抖一下」
        // （2026-11-24 维护者原话：「动画进入完毕后会有位移的感觉，就是那种像素的变化一样」；
        //  实测撤层那一帧整页 diff 88462 px / 留层则是 0）。
        // 层跟着类一起在 resetMotion()（换页 / 重播 / 销毁）里撤，那时要么正在演离场、
        // 要么页已经藏起来了，没人看得见。
        el.classList.remove(IN_CLASS);
        el.classList.add(SETTLE_CLASS);
        el.style.removeProperty(ENTER_DELAY_VAR);
      }
    }, total + MOTION.base + 90);
    this.enterTimers.add(timer);
  }

  /**
   * 「这一块本身就是标题 / 带标题的顶栏」才降级成纯淡入。
   * 卡片里嵌着标题（首页 `.daily-card` 里的 `.daily-title`）不算：那样整张卡片会一直不动，
   * 只剩里面的字在演，看起来就是「大方块没有动画，里面的内容有」。
   */
  private titleBlock(el: HTMLElement): boolean {
    if (!this.options.titles) return false;
    if (el.matches(this.options.titles)) return true;
    return this.options.heads ? el.matches(this.options.heads) : false;
  }

  /**
   * 标题选择器命中才返回标题元素（没配 `titles` 或这块里没有就是 null）。
   * 标题本身也可能就是这块（`.section-title` 这类自成一行的标题），所以先看它自己。
   */
  private titleOf(el: HTMLElement): HTMLElement | null {
    if (!this.options.titles) return null;
    if (el.matches(this.options.titles)) return el;
    return el.querySelector<HTMLElement>(this.options.titles);
  }

  /** 一个标题一个实例：重复入场复用同一批 DOM，不重拆字。 */
  private titleMotion(el: HTMLElement): TitleEntrance {
    const existing = this.titleMotions.get(el);
    if (existing) return existing;
    // 整页重建后旧标题已经脱离文档：顺手把那些实例丢掉，别让 Set 一直攒着旧 DOM。
    for (const motion of this.titleInstances) {
      if (motion.connected) continue;
      motion.dispose();
      this.titleInstances.delete(motion);
    }
    const motion = new TitleEntrance(el);
    this.titleMotions.set(el, motion);
    this.titleInstances.add(motion);
    return motion;
  }

  /** 让某块里的标题逐字浮上来（`delay` 与它所在那块内容的入场对齐）。 */
  private playTitle(target: HTMLElement, delay: number): void {
    const title = this.titleOf(target);
    if (!title) return;
    this.titledTargets.add(target);
    this.titleMotion(title).play(delay);
  }

  private stopEnter(): void {
    if (this.enterTimers.size === 0) return;
    for (const timer of this.enterTimers) window.clearTimeout(timer);
    this.enterTimers.clear();
  }

  /** 摘掉运动相关的类与自定义属性，让下一轮从干净状态重开。 */
  private clearMotionClasses(): void {
    this.root
      .querySelectorAll<HTMLElement>(`.${IN_CLASS}, .${OUT_CLASS}, .${SETTLE_CLASS}`)
      .forEach((el) => this.resetMotion(el));
    for (const el of this.leaveTargets) this.resetMotion(el);
    this.leaveTargets = [];
  }

  private resetMotion(el: HTMLElement): void {
    el.classList.remove(IN_CLASS, OUT_CLASS, SETTLE_CLASS);
    el.style.removeProperty(ENTER_DELAY_VAR);
    el.style.removeProperty(LEAVE_DELAY_VAR);
    el.style.removeProperty(IN_ANIM_VAR);
    el.style.removeProperty(OUT_ANIM_VAR);
    delete el.dataset.blockVariant;
    // 标题的逐字动画不归关键帧管：这块要重开就得先把它落到最终态。
    // 只查记过「有标题」的块，几百张海报的清场不受影响。
    if (this.titledTargets.has(el)) {
      const title = this.titleOf(el);
      if (title) this.titleMotions.get(title)?.stop();
    }
  }

  /** 这块上一轮挑的是哪款（data 优先，退回行内变量，都没有就是 null）。 */
  private variantOf(el: HTMLElement): string | null {
    const stored = el.dataset.blockVariant;
    if (stored) return stored;
    const inline = el.style.getPropertyValue(IN_ANIM_VAR);
    return inline ? inline.replace('block-in-', '') : null;
  }

  /**
   * 全页出场：每块用自己入场那款的反向关键帧，沿原轨迹倒着退回去，最后一块先走。
   * 返回 Promise，收完或被下一次入场打断时都会 resolve，调用方可以安全 await。
   */
  leave(): Promise<void> {
    this.stopEnter();
    // 打断：上一段还没收完就先收干净，不叠第二段。
    this.finishLeave();
    const ordered = this.groups().flat().slice(0, MAX_TARGETS);
    if (ordered.length === 0 || prefersReducedMotion()) return Promise.resolve();
    // 先把每块当初挑的款记下来，再清类（resetMotion 会把 data 一起清掉）。
    // 反向错帧：最后进来的那块先收，前面的依次跟上。
    const plans = ordered.map(({ el, head }, index) => ({
      el,
      delay: Math.min(LEAVE_MAX_DELAY, (ordered.length - 1 - index) * LEAVE_STEP),
      variant: this.variantOf(el) ?? (head ? 'haze' : 'leaf-left'),
    }));
    this.clearMotionClasses();
    void this.root.offsetWidth;
    let total = 0;
    for (const { el, delay, variant } of plans) {
      if (delay > total) total = delay;
      el.style.setProperty(LEAVE_DELAY_VAR, `${delay}ms`);
      el.style.setProperty(OUT_ANIM_VAR, `block-out-${variant}`);
      el.classList.add(OUT_CLASS);
    }
    // 标题沿同一条轨迹反过来（逐字下沉淡出，越靠后的字先走），和它所在那块一起退。
    for (const { el } of ordered) {
      if (!this.titledTargets.has(el)) continue;
      const title = this.titleOf(el);
      if (title) void this.titleMotion(title).leave();
    }
    this.leaveTargets = plans.map((plan) => plan.el);
    return new Promise<void>((resolve) => {
      this.leaveDone = resolve;
      this.leaveTimer = window.setTimeout(() => this.finishLeave(), total + MOTION.fast + 90);
    });
  }

  /** 收干净这一轮出场并放行等待方（正常收完 / 被打断都走这里）。 */
  private finishLeave(): void {
    if (this.leaveTimer) {
      window.clearTimeout(this.leaveTimer);
      this.leaveTimer = 0;
    }
    const targets = this.leaveTargets;
    this.leaveTargets = [];
    for (const el of targets) {
      el.classList.remove(OUT_CLASS);
      el.style.removeProperty(LEAVE_DELAY_VAR);
      el.style.removeProperty(OUT_ANIM_VAR);
    }
    const done = this.leaveDone;
    this.leaveDone = null;
    done?.();
  }

  /** 页面销毁：停掉两段定时器、收掉等待方（否则 await 它的调用方会永远等下去）。 */
  dispose(): void {
    this.stopEnter();
    this.clearMotionClasses();
    this.finishLeave();
    for (const motion of this.titleInstances) motion.dispose();
    this.titleInstances.clear();
  }
}
