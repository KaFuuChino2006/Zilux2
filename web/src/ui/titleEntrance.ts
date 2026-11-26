/**
 * 页面标题的逐字入场。
 *
 * 第一版是「从窗口外划进来 + 乱跳字形」，维护者 2026-11-22 看过之后否了：
 * 「这个飞进来太丑了」—— 位移横跨整屏、还带随机字体，读起来像故障。
 * 现在改成「字一个个浮上来」：**每个字自己往上飘 12px + 从 4px 模糊里显影**，
 * 逐字错帧（34ms + 最多 18ms 抖动），整块标题读起来是一行字依次落定，不是一整块淡入。
 *
 * 三条规矩和别处一致（`docs/zilux2-ui-templates.md` 铁律 6）：
 *   - 入场：逐字上浮显影；
 *   - 出场：同一条轨迹反过来（逐字下沉 + 模糊淡出），**越靠后的字先走**；
 *   - 打断：新一段开始前先把上一段收到最终态，同一块标题上永远只有一段在跑。
 *
 * 关键帧与时长在 `styles/app.css` §9（`title-char-in` / `title-char-out`），
 * 这里只负责拆字、错帧、清场，不碰关键帧本身。
 */

import { MOTION, prefersReducedMotion } from './motion';

/** 每个字拆出来的行内块。 */
const CELL_CLASS = 'title-char';
const IN_CLASS = 'is-char-in';
const OUT_CLASS = 'is-char-out';
/** 入场动画结束后的静态类：撤掉动画与 will-change，字不再常驻合成层（200Hz 屏上 79 个字是实打实的开销）。 */
const SETTLED_CLASS = 'is-char-settled';
const ENTER_DELAY_VAR = '--char-delay';
const LEAVE_DELAY_VAR = '--char-out-delay';

/** 逐字步长：比整块淡入慢一点，才看得出「一个一个来」；再大就拖沓了。 */
const ENTER_STEP = 34;
/** 每个字额外的随机抖动：固定步长会读成打字机，抖一下才自然。 */
const ENTER_JITTER = 18;
/** 错帧上限：长标题不能让最后一个字等太久。 */
const ENTER_MAX_DELAY = 260;
/** 出场比入场快，且越靠后的字先走。 */
const LEAVE_STEP = 14;
const LEAVE_MAX_DELAY = 160;

/**
 * 太长的标题不拆：逐字 `inline-block` 会改变换行点，长歌单名会被拆得满屏都是。
 * 超过这个长度就只保留容器那一层淡入。
 */
const MAX_CHARS = 16;

/**
 * 一块标题的逐字动画。只负责这一块元素内部，容器的入场/出场仍由 `BlockEntrance` 管
 * （带标题的容器降级成纯淡入 `fade`，不跟字的轨迹抢）。
 */
export class TitleEntrance {
  /** 拆开后的原始字（空格原样），落定与收尾都以它为准。 */
  private chars: string[] = [];
  /** 拆开前那一整句：文案没变就不重复拆 DOM。 */
  private text = '';
  private cells: HTMLSpanElement[] = [];
  private enterTimer = 0;
  private leaveTimer = 0;
  private leaveDone: (() => void) | null = null;

  constructor(private readonly el: HTMLElement) {}

  /** 这块标题还在文档里吗（整页重建后旧实例是脱离的孤魂，可以就地丢掉）。 */
  get connected(): boolean {
    return this.el.isConnected;
  }

  /** 拆字（文案没变就复用）。返回 false = 这个标题不适合拆（空文本 / 太长）。 */
  private build(): boolean {
    const raw = (this.el.textContent ?? '').trim();
    if (!raw || Array.from(raw).length > MAX_CHARS) return false;
    if (raw === this.text && this.cells.length > 0) return true;
    this.text = raw;
    this.chars = Array.from(raw);
    this.el.textContent = '';
    this.cells = this.chars.map((ch) => {
      const cell = document.createElement('span');
      cell.className = CELL_CLASS;
      // 空格要留成不换行空格，否则 inline-block 拆开后这个词会被折断。
      cell.textContent = ch === ' ' ? '\u00a0' : ch;
      this.el.append(cell);
      return cell;
    });
    return true;
  }

  /** 立刻落到最终态：整句复原、无类无变量。被打断、跑完、页面要藏起来都走这里。 */
  settle(): void {
    if (this.enterTimer) {
      window.clearTimeout(this.enterTimer);
      this.enterTimer = 0;
    }
    for (let index = 0; index < this.cells.length; index += 1) {
      const cell = this.cells[index]!;
      const ch = (this.chars[index] ?? '') === ' ' ? '\u00a0' : (this.chars[index] ?? '');
      // 只在真的不一样时写：换文本节点会重新排版，收尾那一下就会被看成「字动了一下」。
      if (cell.textContent !== ch) cell.textContent = ch;
      cell.classList.remove(IN_CLASS, OUT_CLASS, SETTLED_CLASS);
      cell.style.removeProperty(ENTER_DELAY_VAR);
      cell.style.removeProperty(LEAVE_DELAY_VAR);
    }
    this.resolveLeave();
  }

  /**
   * 入场：每个字重新摇一个错帧，然后一起出发（逐字浮上来）。
   * `delayMs` 是容器给这块的起始时间，让标题跟着它所在那块内容一起开始。
   */
  play(delayMs = 0): void {
    // 打断：上一段（入场或返程）先收到最终态，同一块上不叠两段。
    this.stop();
    if (!this.build()) return;
    if (prefersReducedMotion()) {
      this.settle();
      return;
    }
    let maxDelay = 0;
    this.cells.forEach((cell, index) => {
      // 错帧只决定「第几个字」；容器给的起始时间整段加上去，跟着那块内容一起开始。
      const stagger = Math.min(ENTER_MAX_DELAY, index * ENTER_STEP + Math.random() * ENTER_JITTER);
      const delay = Math.round(delayMs + stagger);
      if (delay > maxDelay) maxDelay = delay;
      cell.style.setProperty(ENTER_DELAY_VAR, `${delay}ms`);
      cell.classList.remove(OUT_CLASS, SETTLED_CLASS);
      cell.classList.add(IN_CLASS);
    });
    this.enterTimer = window.setTimeout(
      () => {
        this.enterTimer = 0;
        for (const cell of this.cells) {
          cell.style.removeProperty(ENTER_DELAY_VAR);
          // 动画已经演完：撤掉 is-char-in（连带 will-change 与 animation）换成静态类。
          // 每个字常驻合成层时，200Hz 屏幕上光这 79 个字就能吃掉可观的一帧时间。
          if (cell.classList.contains(IN_CLASS)) {
            cell.classList.remove(IN_CLASS);
            cell.classList.add(SETTLED_CLASS);
          }
        }
        // 演完就换成立定类：撤掉 animation 与 will-change，字回到普通排版层。
        // 早先为了避开「撤层那一帧像素抖一下」故意不撤，代价是 79 个字常驻合成层，
        // 200Hz 屏幕上每帧都要合成一遍（见 docs/Zilux2-性能基线.md）。
        // 现在末尾一帧是关键帧终态（translate3d 归零 + opacity 1），与立定类一致，
        // 没有可见跳变。
      },
      maxDelay + MOTION.base + 90,
    );
  }


  /**
   * 出场：同一条轨迹反过来——逐字下沉淡出，越靠后的字先走。
   * 返回的 Promise 在收完后 resolve（被打断也 resolve，调用方可以安全 await）。
   */
  leave(): Promise<void> {
    this.stop();
    if (this.cells.length === 0 || prefersReducedMotion()) {
      this.settle();
      return Promise.resolve();
    }
    this.finishLeave();
    let maxDelay = 0;
    const count = this.cells.length;
    this.cells.forEach((cell, index) => {
      const delay = Math.min(LEAVE_MAX_DELAY, (count - 1 - index) * LEAVE_STEP);
      if (delay > maxDelay) maxDelay = delay;
      cell.style.setProperty(LEAVE_DELAY_VAR, `${delay}ms`);
      cell.classList.remove(IN_CLASS);
      cell.classList.add(OUT_CLASS);
    });
    return new Promise<void>((resolve) => {
      this.leaveDone = resolve;
      this.leaveTimer = window.setTimeout(
        () => this.settle(),
        maxDelay + MOTION.fast + 90,
      );
    });
  }

  /** 停掉当前这段并落到最终态（打断 / 重播 / 页面要藏起来之前都调它）。 */
  stop(): void {
    if (this.cells.length > 0) this.settle();
    else this.resolveLeave();
  }

  dispose(): void {
    this.stop();
    this.finishLeave();
  }

  private finishLeave(): void {
    if (this.leaveTimer) {
      window.clearTimeout(this.leaveTimer);
      this.leaveTimer = 0;
    }
    const done = this.leaveDone;
    this.leaveDone = null;
    done?.();
  }

  private resolveLeave(): void {
    this.finishLeave();
  }
}
