/**
 * 左下角常驻进度卡（模型下载 / 人声分离 / 切歌过渡共用一张）。
 *
 * 为什么不用 toast：这些任务短的几秒、长的几分钟，toast 会一条条堆上去，
 * 也放不下网速、剩余量、第几窗这类信息。这里是一张常驻小卡片：
 * 标题 + 当前阶段 + 右侧补充（网速 / 剩余秒数）+ 进度条 + 脚注（百分比 / 已处理量），
 * 右上角可以收起；收起后缩成屏幕左侧边缘的小箭头（带一圈进度），点箭头再展开。
 *
 * 多个任务并存时按 `TASK_ORDER` 取最靠前的那个显示，完成停 `FINISH_HOLD_MS` 自动消失。
 *
 * 动画三件套：入场（从左侧滑入 + 淡入）、出场（反向滑出 + 淡出）、打断（收起/展开都走
 * CSS transition，从当前计算值接着走，不会跳帧；连续点击只是把目标值改回去）。
 */
import { h } from './dom';

export interface DockTask {
  /** 同一个 id 反复 setTask 就是原地更新；不同 id 之间按优先级抢显示位。 */
  id: string;
  /** 卡片标题，例如「人声分离模型」。 */
  title: string;
  /** 当前阶段，例如「下载中 · 124 MB」「正在分离第 3 窗」。 */
  stage: string;
  /** 右侧补充信息，例如「8.10 MB/s」「还剩 4 秒」。 */
  meta?: string;
  /** 脚注，例如「39.8 MB / 124 MB」「第 3 窗 · 已就绪 2」。 */
  detail?: string;
  /** 0..1；null 表示不确定进度（进度条走流动条纹）。 */
  ratio: number | null;
  /** 是否显示「重试」按钮。 */
  retry?: boolean;
  /** 失败态：红色进度条 + 失败文案。 */
  failed?: boolean;
  /** 纯信息卡（例如「这次用了什么混音手法」）：不画进度条、不画脚注。 */
  plain?: boolean;
}

export interface ProgressDockOptions {
  /** 失败后点「重试」时调用。 */
  onRetry?: (id: string) => void;
}

/** 显示优先级：越靠前越优先。 */
const TASK_ORDER = ['model', 'stem', 'transition'];
const FINISH_HOLD_MS = 1400;

export class ProgressDock {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly tab: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly stageEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly barEl: HTMLElement;
  private readonly pctEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly retryEl: HTMLButtonElement;
  private readonly tabRing: HTMLElement;
  private readonly tabPct: HTMLElement;

  private readonly tasks = new Map<string, DockTask>();
  private collapsed = false;
  private hideTimer = 0;
  private leavingTimer = 0;
  private renderedId = '';

  constructor(private readonly options: ProgressDockOptions = {}) {
    this.titleEl = h('span', { class: 'stem-dl-title' }, '任务');
    this.stageEl = h('span', { class: 'stem-dl-stage', 'aria-live': 'polite' }, '准备中');
    this.metaEl = h('span', { class: 'stem-dl-speed' }, '');
    this.barEl = h('i', { class: 'stem-dl-bar-fill' });
    this.pctEl = h('span', { class: 'stem-dl-pct' }, '0%');
    this.detailEl = h('span', { class: 'stem-dl-bytes' }, '');
    this.retryEl = h('button', {
      class: 'stem-dl-retry',
      type: 'button',
      title: '重试',
    }, '重试') as HTMLButtonElement;
    this.retryEl.hidden = true;
    this.retryEl.addEventListener('click', () => {
      const id = this.renderedId;
      if (id) this.options.onRetry?.(id);
    });
    const hideBtn = h('button', {
      class: 'stem-dl-hide',
      type: 'button',
      title: '收起',
      'aria-label': '收起进度',
    }, '‹');
    hideBtn.addEventListener('click', () => this.collapse());
    this.tabRing = h('span', { class: 'stem-dl-tab-ring' });
    this.tabPct = h('span', { class: 'stem-dl-tab-pct' }, '');
    this.tab = h('button', {
      class: 'stem-dl-tab',
      type: 'button',
      title: '展开进度',
      'aria-label': '展开进度',
    }, this.tabRing, this.tabPct, h('span', { class: 'stem-dl-tab-arrow' }, '›'));
    this.tab.addEventListener('click', () => this.expand());

    this.card = h('div', { class: 'stem-dl-card' },
      h('div', { class: 'stem-dl-head' }, this.titleEl, hideBtn),
      h('div', { class: 'stem-dl-meta' }, this.stageEl, this.metaEl),
      h('div', { class: 'stem-dl-bar' }, this.barEl),
      h('div', { class: 'stem-dl-foot' }, this.pctEl, this.detailEl, this.retryEl),
    );
    this.root = h('div', { class: 'stem-dl' }, this.card, this.tab);
    this.root.hidden = true;
    document.body.append(this.root);
  }

  /** 新建或原地更新一个任务。 */
  setTask(task: DockTask): void {
    this.tasks.set(task.id, task);
    this.render();
  }

  /** 任务结束：先播完「完成」再自动消失。 */
  finish(id: string, stage = '已完成'): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.tasks.set(id, { ...task, stage, ratio: 1, meta: '', failed: false, retry: false });
    this.render();
    if (this.renderedId !== id) {
      this.tasks.delete(id);
      return;
    }
    this.root.classList.add('is-done');
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.tasks.delete(id);
      this.render();
    }, FINISH_HOLD_MS);
  }

  /** 任务失败：停在展开态给「重试」，不自动消失。 */
  fail(id: string, stage = '失败'): void {
    const task = this.tasks.get(id);
    if (!task) return;
    this.tasks.set(id, { ...task, stage, failed: true, retry: true, meta: '', ratio: null });
    this.render();
    this.expand();
  }

  clearTask(id: string): void {
    if (!this.tasks.delete(id)) return;
    this.render();
  }

  dispose(): void {
    window.clearTimeout(this.hideTimer);
    window.clearTimeout(this.leavingTimer);
    this.root.remove();
  }

  private activeTask(): DockTask | null {
    for (const id of TASK_ORDER) {
      const task = this.tasks.get(id);
      if (task) return task;
    }
    for (const task of this.tasks.values()) return task;
    return null;
  }

  private render(): void {
    const task = this.activeTask();
    if (!task) {
      if (!this.root.hidden) this.dismiss();
      return;
    }
    window.clearTimeout(this.leavingTimer);
    const wasHidden = this.root.hidden;
    // 换任务时把「收起」状态复位：新任务要出现在卡片里，不能只剩左侧小箭头。
    if (!wasHidden && task.id !== this.renderedId && this.collapsed) this.expand();
    this.root.hidden = false;
    this.root.classList.remove('is-leaving');
    if (wasHidden || !this.root.classList.contains('is-shown')) {
      // 先以「收起位」出现，下一帧再加 is-shown，才看得到从左滑入的入场。
      this.root.classList.remove('is-shown');
      // 强制一次样式计算：不读这个值的话，display:none → flex 与 is-shown 可能落在同一帧，
      // 浏览器没有「起始帧」，滑入会变成原地淡入（用户反馈「有时候没动画」）。
      void this.card.offsetWidth;
      requestAnimationFrame(() => {
        if (this.root.hidden || !this.activeTask()) return;
        this.root.classList.add('is-shown');
      });
    }
    this.root.classList.remove('is-done');
    this.renderedId = task.id;
    this.titleEl.textContent = task.title;
    this.stageEl.textContent = task.stage;
    this.metaEl.textContent = task.meta ?? '';
    this.detailEl.textContent = task.detail ?? '';
    this.retryEl.hidden = !task.retry;
    this.root.classList.toggle('is-failed', Boolean(task.failed));
    this.root.classList.toggle('is-plain', Boolean(task.plain));
    const indeterminate = task.ratio == null;
    this.root.classList.toggle('is-indeterminate', indeterminate);
    const ratio = indeterminate ? 0 : Math.max(0, Math.min(1, task.ratio ?? 0));
    this.barEl.style.width = indeterminate ? '' : `${(ratio * 100).toFixed(2)}%`;
    const pct = indeterminate ? '' : `${Math.round(ratio * 100)}%`;
    this.pctEl.textContent = pct;
    // 收起后的窄条按任务类型变：只有真带字节进度的下载才画「环 + 百分比」，
    // 分离/切歌这类没有确定总量的，收起时只留一个箭头（以前一律写 100%，是错的）。
    const tabHasGauge = task.id === 'model' && !task.plain && !indeterminate;
    this.tabPct.textContent = tabHasGauge ? pct : '';
    this.root.classList.toggle('is-tab-simple', !tabHasGauge);
    this.tabRing.style.setProperty('--p', ratio.toFixed(3));
    this.root.classList.toggle('is-spinning', indeterminate);
  }

  private collapse(): void {
    if (this.collapsed) return;
    this.collapsed = true;
    this.root.classList.add('is-collapsed');
  }

  private expand(): void {
    if (!this.collapsed) return;
    this.collapsed = false;
    this.root.classList.remove('is-collapsed');
  }

  private dismiss(): void {
    // 出场：卡片往左滑回去 + 淡出（和入场的轨迹相反）。
    this.root.classList.remove('is-shown');
    this.root.classList.add('is-leaving');
    this.leavingTimer = window.setTimeout(() => {
      if (this.activeTask()) {
        // 收起途中又来了新任务：把淡出撤掉，别让卡片停在「已淡出但仍占位」的状态。
        this.root.classList.remove('is-leaving');
        return;
      }
      this.root.hidden = true;
      this.collapsed = false;
      this.root.classList.remove('is-collapsed');
      this.root.classList.remove('is-shown');
      this.root.classList.remove('is-leaving');
    }, 560);
  }
}

export function formatMib(bytes: number | undefined): string {
  if (!Number.isFinite(bytes ?? NaN) || (bytes ?? 0) <= 0) return '0 MB';
  const mb = (bytes ?? 0) / (1024 * 1024);
  if (mb >= 100) return `${mb.toFixed(0)} MB`;
  if (mb >= 10) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(2)} MB`;
}
